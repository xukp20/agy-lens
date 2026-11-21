/**
 * Shared AGY Lens backend runtime & route registry (zero sidecar_sdk dependency).
 * Powers both the Antigravity Desktop Sidecar (`main.mjs`) and the Headless
 * Standalone Web Server (`standalone.mjs`).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAnalytics,
  getDayDetail,
  getIndexStatus,
  getSessionSnapshot,
  isValidConversationId,
  listRecentConversations,
  openTelemetryCacheDb,
  rebuildIndex,
  resolveDataDir,
  runIncrementalIndex,
} from './indexer.mjs';
import {
  DEFAULTS_FILE,
  getOverridesPath,
  listPricingModels,
  loadPricingState,
  maybeAutoSync,
  saveOverride,
  syncRemotePricing,
  writeJsonAtomic,
} from './pricing.mjs';
import {
  addQuotaAnchor,
  deleteQuotaAnchor,
  getQuotaStatus,
  updateQuotaAnchor,
} from './quota.mjs';
import {
  DEFAULT_GAP_BREAKPOINTS_SEC,
  sanitizeGapBreakpointsSec,
} from './cache_observatory.mjs';
import {
  ackJustUpdated,
  checkForUpdate,
  getRunningVersion,
  getUpdateStatus,
  maybeAutoCheckUpdate,
  prepareApplyNow,
  prepareRollback,
} from './updater.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = resolve(__dirname, '..', '..', '..');
const DEFAULT_WEB_DIR = resolve(__dirname, '..', 'web');
const UPDATE_MODES = new Set(['auto', 'notify', 'off']);

const OBS_MATRIX_METRIC_ORDER = [
  'weightedHit',
  'keepRate',
  'avgCost',
  'totalCost',
  'missPenalty',
  'turns',
];
const OBS_MATRIX_METRICS = new Set(OBS_MATRIX_METRIC_ORDER);

export const DEFAULT_CONFIG = {
  lang: 'zh-CN',
  modules: {
    'live-context': true,
    'cache-diagnostics': true,
    'io-flow': true,
    'model-cost': true,
    'calendar-trends': true,
    'cache-observatory': true,
    'quota-budget': true,
  },
  moduleOrder: [
    'live-context',
    'cache-diagnostics',
    'io-flow',
    'model-cost',
    'calendar-trends',
    'cache-observatory',
    'quota-budget',
  ],
  expanded: {
    'live-context': true,
    'cache-diagnostics': false,
    'io-flow': false,
    'model-cost': false,
    'calendar-trends': false,
    'cache-observatory': false,
    'quota-budget': false,
  },
  sources: { desktop: true, cli: true },
  refreshSec: 30,
  pricingAutoSync: false,
  quotaDisplayMode: 'remaining',
  quotaAnchorsByPool: {},
  quotaCalibMode: 'auto',
  quotaManualFactors: { M: false, C: false, O: false },
  obsMatrixPrimary: 'weightedHit',
  obsMatrixSubMetrics: ['keepRate', 'avgCost'],
  obsGapBreakpointsSec: [...DEFAULT_GAP_BREAKPOINTS_SEC],
  updateMode: 'auto',
  dismissedUpdateVersion: '',
  defaultRange: '7d',
};

function sanitizeQuotaAnchorsByPool(baseMap, patchMap) {
  const out = {};
  if (baseMap && typeof baseMap === 'object') {
    for (const [k, v] of Object.entries(baseMap)) {
      if ((k === 'gemini' || k === 'argon' || k === '3p') && typeof v === 'string' && v.trim()) {
        out[k] = v.trim();
      }
    }
  }
  if (patchMap && typeof patchMap === 'object') {
    for (const [k, v] of Object.entries(patchMap)) {
      if (k !== 'gemini' && k !== 'argon' && k !== '3p') continue;
      if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) {
        delete out[k];
      } else if (typeof v === 'string' && v.trim()) {
        out[k] = v.trim();
      }
    }
  }
  return out;
}

function sanitizeQuotaManualFactors(baseFactors, patchFactors) {
  const b = baseFactors && typeof baseFactors === 'object' ? baseFactors : {};
  const p = patchFactors && typeof patchFactors === 'object' ? patchFactors : {};
  return {
    M: typeof p.M === 'boolean' ? p.M : Boolean(b.M),
    C: typeof p.C === 'boolean' ? p.C : Boolean(b.C),
    O: typeof p.O === 'boolean' ? p.O : Boolean(b.O),
  };
}

function resolveQuotaCalibPatch(baseMode, baseFactors, patchMode, patchFactors) {
  const factors = sanitizeQuotaManualFactors(baseFactors, patchFactors);
  if (typeof patchMode !== 'string') {
    return {
      quotaCalibMode: baseMode === 'manual' ? 'manual' : 'auto',
      quotaManualFactors: factors,
    };
  }
  const s = patchMode.trim().toLowerCase();
  if (s === 'auto') return { quotaCalibMode: 'auto', quotaManualFactors: factors };
  if (s === 'manual') return { quotaCalibMode: 'manual', quotaManualFactors: factors };
  const hasExplicitFactors = patchFactors && typeof patchFactors === 'object';
  if (s === 'l0') {
    return {
      quotaCalibMode: 'manual',
      quotaManualFactors: hasExplicitFactors ? factors : { M: false, C: false, O: false },
    };
  }
  if (s === 'l1') {
    return {
      quotaCalibMode: 'manual',
      quotaManualFactors: hasExplicitFactors ? factors : { M: true, C: false, O: false },
    };
  }
  if (s === 'l2') {
    return {
      quotaCalibMode: 'manual',
      quotaManualFactors: hasExplicitFactors ? factors : { M: true, C: true, O: false },
    };
  }
  if (s === 'l3') {
    return {
      quotaCalibMode: 'manual',
      quotaManualFactors: hasExplicitFactors ? factors : { M: true, C: true, O: true },
    };
  }
  return {
    quotaCalibMode: baseMode === 'manual' ? 'manual' : 'auto',
    quotaManualFactors: factors,
  };
}

function sanitizeObsMatrixConfig(basePrimary, baseSubs, patchPrimary, patchSubs) {
  const primary =
    typeof patchPrimary === 'string' && OBS_MATRIX_METRICS.has(patchPrimary)
      ? patchPrimary
      : OBS_MATRIX_METRICS.has(basePrimary)
        ? basePrimary
        : 'weightedHit';
  const rawSubs = Array.isArray(patchSubs)
    ? patchSubs
    : Array.isArray(baseSubs)
      ? baseSubs
      : ['keepRate', 'avgCost'];
  const subSet = new Set();
  for (const id of rawSubs) {
    if (typeof id === 'string' && OBS_MATRIX_METRICS.has(id) && id !== primary) {
      subSet.add(id);
    }
  }
  const subs = OBS_MATRIX_METRIC_ORDER.filter((id) => subSet.has(id));
  return { obsMatrixPrimary: primary, obsMatrixSubMetrics: subs };
}

export function deepMergeConfig(base, patch) {
  if (!patch || typeof patch !== 'object') return structuredClone(base);
  const calib = resolveQuotaCalibPatch(
    base.quotaCalibMode,
    base.quotaManualFactors,
    patch.quotaCalibMode,
    patch.quotaManualFactors
  );
  const obsMatrix = sanitizeObsMatrixConfig(
    base.obsMatrixPrimary,
    base.obsMatrixSubMetrics,
    patch.obsMatrixPrimary,
    patch.obsMatrixSubMetrics
  );
  const out = {
    lang: patch.lang === 'en' || patch.lang === 'zh-CN' ? patch.lang : base.lang,
    modules: { ...base.modules, ...(patch.modules && typeof patch.modules === 'object' ? patch.modules : {}) },
    moduleOrder: Array.isArray(patch.moduleOrder)
      ? patch.moduleOrder.filter((k) => k in base.modules)
      : [...base.moduleOrder],
    expanded: { ...base.expanded, ...(patch.expanded && typeof patch.expanded === 'object' ? patch.expanded : {}) },
    sources: { ...base.sources, ...(patch.sources && typeof patch.sources === 'object' ? patch.sources : {}) },
    refreshSec:
      patch.refreshSec !== undefined && Number.isFinite(Number(patch.refreshSec))
        ? Math.max(0, Number(patch.refreshSec))
        : base.refreshSec,
    pricingAutoSync:
      typeof patch.pricingAutoSync === 'boolean' ? patch.pricingAutoSync : base.pricingAutoSync,
    quotaDisplayMode:
      patch.quotaDisplayMode === 'used' || patch.quotaDisplayMode === 'remaining'
        ? patch.quotaDisplayMode
        : base.quotaDisplayMode,
    quotaAnchorsByPool: sanitizeQuotaAnchorsByPool(base.quotaAnchorsByPool, patch.quotaAnchorsByPool),
    quotaCalibMode: calib.quotaCalibMode,
    quotaManualFactors: calib.quotaManualFactors,
    obsMatrixPrimary: obsMatrix.obsMatrixPrimary,
    obsMatrixSubMetrics: obsMatrix.obsMatrixSubMetrics,
    obsGapBreakpointsSec: Array.isArray(patch.obsGapBreakpointsSec)
      ? sanitizeGapBreakpointsSec(patch.obsGapBreakpointsSec)
      : sanitizeGapBreakpointsSec(base.obsGapBreakpointsSec),
    updateMode:
      typeof patch.updateMode === 'string' && UPDATE_MODES.has(patch.updateMode)
        ? patch.updateMode
        : UPDATE_MODES.has(base.updateMode)
          ? base.updateMode
          : 'auto',
    dismissedUpdateVersion:
      typeof patch.dismissedUpdateVersion === 'string'
        ? patch.dismissedUpdateVersion.trim().slice(0, 32)
        : typeof base.dismissedUpdateVersion === 'string'
          ? base.dismissedUpdateVersion
          : '',
    defaultRange:
      typeof patch.defaultRange === 'string' && patch.defaultRange
        ? patch.defaultRange
        : base.defaultRange,
  };
  for (const key of base.moduleOrder) {
    if (!out.moduleOrder.includes(key)) out.moduleOrder.push(key);
  }
  return out;
}

export function httpResponse(body, { status = 200, contentType = 'text/plain; charset=utf-8', headers = {} } = {}) {
  return {
    status,
    contentType,
    headers,
    body: body === undefined || body === null ? '' : body,
  };
}

export function jsonError(status, message) {
  return httpResponse(JSON.stringify({ error: message }), {
    status,
    contentType: 'application/json; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
  });
}

function parseModulesSet(queryModules) {
  if (typeof queryModules !== 'string' || !queryModules.trim()) return null;
  const set = new Set(
    queryModules
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return set.size > 0 ? set : null;
}

export function collectObservedModelIds(db) {
  if (!db) return [];
  const ids = new Set();
  try {
    for (const r of db.prepare("SELECT DISTINCT canonical_model_id FROM turns WHERE canonical_model_id != ''").all()) {
      ids.add(r.canonical_model_id);
    }
    for (const r of db.prepare("SELECT DISTINCT raw_model_id FROM turns WHERE raw_model_id != ''").all()) {
      ids.add(r.raw_model_id);
    }
    for (const r of db.prepare("SELECT DISTINCT raw_model_id FROM model_enums WHERE raw_model_id != ''").all()) {
      ids.add(r.raw_model_id);
    }
  } catch {
    // ignore partial DB errors
  }
  return [...ids];
}

export function createLensRuntime({
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  webDir = DEFAULT_WEB_DIR,
  dataDir = null,
  mode = 'sidecar',
  readOnly = false,
  basePath = '/',
  sourcesOverride = null,
  getDefaultConversationId = () => '',
  onActivity = null,
  onRestartRequested = null,
} = {}) {
  const isStandalone = mode === 'standalone';
  const resolvedDataDir = dataDir ? resolve(dataDir) : resolveDataDir();
  mkdirSync(resolvedDataDir, { recursive: true });
  const settingsFile = join(resolvedDataDir, 'settings.json');
  const logoPath = join(pluginRoot, 'assets', 'logo.svg');
  const runningVersion = getRunningVersion(pluginRoot);
  const { db: cacheDb, dbPath: cacheDbPath } = openTelemetryCacheDb(resolvedDataDir);

  const normalizedSourcesOverride =
    Array.isArray(sourcesOverride) && sourcesOverride.length > 0
      ? sourcesOverride.filter((s) => s === 'desktop' || s === 'cli')
      : null;

  function touchActivity() {
    if (typeof onActivity === 'function') onActivity();
  }

  function loadConfig() {
    let baseCfg;
    try {
      if (!existsSync(settingsFile)) {
        baseCfg = structuredClone(DEFAULT_CONFIG);
      } else {
        const raw = JSON.parse(readFileSync(settingsFile, 'utf-8'));
        baseCfg = deepMergeConfig(DEFAULT_CONFIG, raw);
      }
    } catch {
      baseCfg = structuredClone(DEFAULT_CONFIG);
    }
    if (normalizedSourcesOverride && normalizedSourcesOverride.length > 0) {
      // Process-local CLI override: never written back to shared settings.json.
      baseCfg.sources = {
        desktop: normalizedSourcesOverride.includes('desktop'),
        cli: normalizedSourcesOverride.includes('cli'),
      };
    }
    return baseCfg;
  }

  function saveConfig(patch) {
    let diskBase;
    try {
      diskBase = existsSync(settingsFile)
        ? deepMergeConfig(DEFAULT_CONFIG, JSON.parse(readFileSync(settingsFile, 'utf-8')))
        : structuredClone(DEFAULT_CONFIG);
    } catch {
      diskBase = structuredClone(DEFAULT_CONFIG);
    }
    const next = deepMergeConfig(diskBase, patch);
    writeJsonAtomic(settingsFile, next, true);
    return loadConfig();
  }

  function enabledSourcesList(config, querySources) {
    if (typeof querySources === 'string' && querySources.trim()) {
      return querySources
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s === 'desktop' || s === 'cli');
    }
    const out = [];
    if (config.sources?.desktop) out.push('desktop');
    if (config.sources?.cli) out.push('cli');
    return out;
  }

  function buildConfigPayload(config) {
    const pricingState = loadPricingState(resolvedDataDir);
    return {
      version: runningVersion,
      runtime: {
        mode: isStandalone ? 'standalone' : 'sidecar',
        readOnly: Boolean(readOnly),
        basePath,
      },
      config,
      paths: {
        dataDir: resolvedDataDir,
        defaultsFile: DEFAULTS_FILE,
        overridesFile: getOverridesPath(resolvedDataDir),
        cacheDb: cacheDbPath,
      },
      pricingStatus: {
        lastSyncedAt: pricingState.remote.fetchedAt || null,
        remoteCount: Object.keys(pricingState.remote.models || {}).length,
        overrideCount: Object.keys(pricingState.overrides || {}).length,
      },
      indexStatus: getIndexStatus(cacheDb),
    };
  }

  function buildPricingPayload(config) {
    const state = loadPricingState(resolvedDataDir);
    const observedModelIds = collectObservedModelIds(cacheDb);
    const listed = listPricingModels(state, Date.now(), { observedModelIds });
    return {
      ...listed,
      overridesFile: getOverridesPath(resolvedDataDir),
      autoSync: Boolean(config.pricingAutoSync),
    };
  }

  function serveStaticFile(filename, contentType, fallbackBody = '') {
    const fullPath = join(webDir, filename);
    if (!existsSync(fullPath)) {
      return httpResponse(fallbackBody, {
        status: fallbackBody ? 200 : 404,
        contentType,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    return httpResponse(readFileSync(fullPath, 'utf-8'), {
      status: 200,
      contentType,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  function maybeBackgroundSideEffects(config) {
    if (readOnly) return;
    maybeAutoSync(resolvedDataDir, config.pricingAutoSync, () => collectObservedModelIds(cacheDb));
    if (!isStandalone) {
      maybeAutoCheckUpdate(resolvedDataDir, pluginRoot, config);
    }
  }

  function adaptUpdateStatusForRuntime(st) {
    if (!isStandalone || !st || typeof st !== 'object') return st;
    return {
      ...st,
      canAutoApply: false,
      blockedReason: 'standalone_cli',
      stagedVersion: null,
      canRollback: false,
    };
  }

  function registerRoutes(register) {
    const guardWrite = (handler) => (data, ctx) => {
      if (readOnly) {
        return jsonError(403, 'Read-only mode: write operations are disabled');
      }
      return handler(data, ctx);
    };

    register('GET', '/', () => serveStaticFile('index.html', 'text/html; charset=utf-8'));
    register('GET', '/styles.css', () => serveStaticFile('styles.css', 'text/css; charset=utf-8'));
    register('GET', '/app.js', () => {
      const filePath = join(webDir, 'app.js');
      if (!existsSync(filePath)) {
        return httpResponse('Not found: app.js', { status: 404, contentType: 'text/plain; charset=utf-8' });
      }
      const diskVer = getRunningVersion(pluginRoot);
      const body = `window.__AGY_LENS_DISK_VERSION__=${JSON.stringify(diskVer)};\n${readFileSync(filePath, 'utf-8')}`;
      return httpResponse(body, {
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
      });
    });
    register('GET', '/logo.svg', () => {
      if (!existsSync(logoPath)) {
        return httpResponse('', { status: 404, contentType: 'image/svg+xml' });
      }
      return httpResponse(readFileSync(logoPath, 'utf-8'), {
        status: 200,
        contentType: 'image/svg+xml',
        headers: { 'Cache-Control': 'no-store' },
      });
    });

    register('GET', '/api/health', () => ({
      ok: true,
      version: runningVersion,
      diskVersion: getRunningVersion(pluginRoot),
      mode: isStandalone ? 'standalone' : 'sidecar',
      readOnly: Boolean(readOnly),
      pid: process.pid,
    }));

    register('GET', '/api/config', () => {
      touchActivity();
      const config = loadConfig();
      maybeBackgroundSideEffects(config);
      return buildConfigPayload(config);
    });

    register(
      'POST',
      '/api/config',
      guardWrite((data) => {
        touchActivity();
        const next = saveConfig(data);
        maybeBackgroundSideEffects(next);
        return buildConfigPayload(next);
      })
    );

    register('GET', '/api/session', (data) => {
      touchActivity();
      const config = loadConfig();
      maybeBackgroundSideEffects(config);
      const pricingState = loadPricingState(resolvedDataDir);
      const rawConvId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
      if (rawConvId && !isValidConversationId(rawConvId)) {
        return jsonError(400, 'Invalid conversationId format');
      }
      const fallbackConvId = String(getDefaultConversationId() || '').trim();
      const convId = rawConvId || (isValidConversationId(fallbackConvId) ? fallbackConvId : '');
      const modules = parseModulesSet(data?.modules);
      const sources = enabledSourcesList(config, data?.sources);
      return getSessionSnapshot(cacheDb, pricingState, { conversationId: convId, modules, sources });
    });

    register('GET', '/api/sessions/recent', (data) => {
      touchActivity();
      const config = loadConfig();
      const sources = enabledSourcesList(config, data?.sources);
      const limit = data?.limit != null ? Number(data.limit) : 15;
      return {
        sessions: listRecentConversations(cacheDb, { limit, sources }),
      };
    });

    register('GET', '/api/analytics', (data) => {
      touchActivity();
      const config = loadConfig();
      if (!readOnly) {
        maybeAutoSync(resolvedDataDir, config.pricingAutoSync, () => collectObservedModelIds(cacheDb));
      }
      const pricingState = loadPricingState(resolvedDataDir);
      const sources = enabledSourcesList(config, data?.sources);
      const modules = parseModulesSet(data?.modules);
      return getAnalytics(cacheDb, pricingState, {
        range: data?.range || config.defaultRange || '7d',
        from: data?.from || null,
        to: data?.to || null,
        sources,
        modules,
        workspace: typeof data?.workspace === 'string' ? data.workspace : '',
        gapBreakpointsSec: config.obsGapBreakpointsSec,
      });
    });

    register('GET', '/api/day', (data) => {
      touchActivity();
      const config = loadConfig();
      const pricingState = loadPricingState(resolvedDataDir);
      const sources = enabledSourcesList(config, data?.sources);
      return getDayDetail(cacheDb, pricingState, {
        date: data?.date || '',
        sources,
      });
    });

    register('GET', '/api/pricing', () => {
      const config = loadConfig();
      return buildPricingPayload(config);
    });

    register(
      'POST',
      '/api/pricing/overrides',
      guardWrite((data) => {
        const canonicalId = typeof data?.canonicalId === 'string' ? data.canonicalId.trim() : '';
        if (!canonicalId) {
          return jsonError(400, 'canonicalId is required');
        }
        const ov = data.override;
        if (ov !== null && ov !== undefined && (typeof ov !== 'object' || Array.isArray(ov))) {
          return jsonError(400, 'override must be an object or null');
        }
        saveOverride(resolvedDataDir, canonicalId, ov ?? null);
        const config = loadConfig();
        return buildPricingPayload(config);
      })
    );

    register(
      'POST',
      '/api/pricing/sync',
      guardWrite(async () => {
        const config = loadConfig();
        const res = await syncRemotePricing(resolvedDataDir, {
          observedModelIds: collectObservedModelIds(cacheDb),
        });
        return {
          ...res,
          pricing: buildPricingPayload(config),
        };
      })
    );

    register('GET', '/api/quota/anchors', (data) => {
      touchActivity();
      const config = loadConfig();
      const sources = enabledSourcesList(config, null);
      runIncrementalIndex(cacheDb, { sources });
      const pricingState = loadPricingState(resolvedDataDir);
      return getQuotaStatus(cacheDb, pricingState, {
        pool: data?.pool || null,
        windowType: data?.window || data?.windowType || null,
        anchorModel:
          typeof data?.anchorModel === 'string' && data.anchorModel.trim()
            ? data.anchorModel.trim()
            : null,
        quotaAnchorsByPool: config.quotaAnchorsByPool || {},
        quotaCalibMode: data?.quotaCalibMode || config.quotaCalibMode || 'auto',
        quotaManualFactors: config.quotaManualFactors || { M: false, C: false, O: false },
        forceSubset: data?.forceSubset || null,
        forceLevel: data?.forceLevel || null,
      });
    });

    register(
      'POST',
      '/api/quota/anchors',
      guardWrite((data) => {
        try {
          addQuotaAnchor(cacheDb, data);
          const config = loadConfig();
          const pricingState = loadPricingState(resolvedDataDir);
          return getQuotaStatus(cacheDb, pricingState, {
            pool: null,
            windowType: null,
            quotaAnchorsByPool: config.quotaAnchorsByPool || {},
            quotaCalibMode: config.quotaCalibMode || 'auto',
            quotaManualFactors: config.quotaManualFactors || { M: false, C: false, O: false },
          });
        } catch (err) {
          return jsonError(400, err.message);
        }
      })
    );

    register(
      'POST',
      '/api/quota/anchors/update',
      guardWrite((data) => {
        try {
          updateQuotaAnchor(cacheDb, data);
          const config = loadConfig();
          const pricingState = loadPricingState(resolvedDataDir);
          return getQuotaStatus(cacheDb, pricingState, {
            pool: null,
            windowType: null,
            quotaAnchorsByPool: config.quotaAnchorsByPool || {},
            quotaCalibMode: config.quotaCalibMode || 'auto',
            quotaManualFactors: config.quotaManualFactors || { M: false, C: false, O: false },
          });
        } catch (err) {
          return jsonError(400, err.message);
        }
      })
    );

    register(
      'POST',
      '/api/quota/anchors/delete',
      guardWrite((data) => {
        try {
          deleteQuotaAnchor(cacheDb, data?.id);
          const config = loadConfig();
          const pricingState = loadPricingState(resolvedDataDir);
          return getQuotaStatus(cacheDb, pricingState, {
            pool: null,
            windowType: null,
            quotaAnchorsByPool: config.quotaAnchorsByPool || {},
            quotaCalibMode: config.quotaCalibMode || 'auto',
            quotaManualFactors: config.quotaManualFactors || { M: false, C: false, O: false },
          });
        } catch (err) {
          return jsonError(400, err.message);
        }
      })
    );

    register(
      'POST',
      '/api/index/rebuild',
      guardWrite(() => {
        touchActivity();
        const config = loadConfig();
        const sources = enabledSourcesList(config, null);
        const stats = rebuildIndex(cacheDb, { sources, dataDir: resolvedDataDir });
        return {
          ok: true,
          ...stats,
          indexStatus: getIndexStatus(cacheDb),
        };
      })
    );

    register('GET', '/api/update/status', async () => {
      touchActivity();
      const config = loadConfig();
      const st = await getUpdateStatus(resolvedDataDir, pluginRoot, config);
      return adaptUpdateStatusForRuntime(st);
    });

    register(
      'POST',
      '/api/update/check',
      guardWrite(async () => {
        touchActivity();
        const config = loadConfig();
        // In standalone mode, check metadata only — never trigger auto-staging into shared Sidecar dataDir.
        const checkCfg = isStandalone ? { ...config, updateMode: 'notify' } : config;
        const st = await checkForUpdate(resolvedDataDir, pluginRoot, checkCfg, { force: true });
        return adaptUpdateStatusForRuntime(st);
      })
    );

    register(
      'POST',
      '/api/update/apply',
      guardWrite(async () => {
        if (isStandalone) {
          return jsonError(403, 'In-panel restart & apply is only supported in Antigravity Sidecar mode');
        }
        touchActivity();
        const config = loadConfig();
        try {
          const res = await prepareApplyNow(resolvedDataDir, pluginRoot, config);
          if (typeof onRestartRequested === 'function') onRestartRequested(1);
          return res;
        } catch (err) {
          return jsonError(400, err.message);
        }
      })
    );

    register(
      'POST',
      '/api/update/rollback',
      guardWrite(() => {
        if (isStandalone) {
          return jsonError(403, 'In-panel rollback is only supported in Antigravity Sidecar mode');
        }
        touchActivity();
        try {
          const res = prepareRollback(resolvedDataDir, pluginRoot);
          if (typeof onRestartRequested === 'function') onRestartRequested(1);
          return res;
        } catch (err) {
          return jsonError(400, err.message);
        }
      })
    );

    register(
      'POST',
      '/api/update/ack-updated',
      guardWrite(() => {
        touchActivity();
        ackJustUpdated(resolvedDataDir);
        return { ok: true };
      })
    );
  }

  function close() {
    try {
      cacheDb.close();
    } catch {
      // ignore
    }
  }

  return {
    dataDir: resolvedDataDir,
    pluginRoot,
    runningVersion,
    cacheDb,
    cacheDbPath,
    loadConfig,
    saveConfig,
    enabledSourcesList,
    buildConfigPayload,
    buildPricingPayload,
    registerRoutes,
    close,
  };
}
