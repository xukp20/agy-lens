/**
 * AGY Lens Sidecar backend.
 * Strictly read-only access to source conversation DBs; persistent state stored under DATA_DIR.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  getAnalytics,
  getDayDetail,
  getIndexStatus,
  getSessionSnapshot,
  openTelemetryCacheDb,
  rebuildIndex,
  resolveDataDir,
  runIncrementalIndex,
} from './lib/indexer.mjs';
import {
  DEFAULTS_FILE,
  getOverridesPath,
  listPricingModels,
  loadPricingState,
  maybeAutoSync,
  saveOverride,
  syncRemotePricing,
} from './lib/pricing.mjs';
import {
  addQuotaAnchor,
  deleteQuotaAnchor,
  getQuotaStatus,
  updateQuotaAnchor,
} from './lib/quota.mjs';
import {
  DEFAULT_GAP_BREAKPOINTS_SEC,
  sanitizeGapBreakpointsSec,
} from './lib/cache_observatory.mjs';
import {
  ackJustUpdated,
  checkForUpdate,
  getRunningVersion,
  getUpdateStatus,
  hasPendingAutoApplyOnIdle,
  markHealthy,
  maybeAutoCheckUpdate,
  prepareApplyNow,
  prepareRollback,
} from './lib/updater.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const WEB_DIR = join(__dirname, 'web');
const LOGO_PATH = join(PLUGIN_ROOT, 'assets', 'logo.svg');
const RUNNING_VERSION = getRunningVersion(PLUGIN_ROOT);
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

const DEFAULT_CONFIG = {
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

const DATA_DIR = resolveDataDir();
mkdirSync(DATA_DIR, { recursive: true });
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const { db: cacheDb, dbPath: cacheDbPath } = openTelemetryCacheDb(DATA_DIR);

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
  if (s === 'auto') {
    return { quotaCalibMode: 'auto', quotaManualFactors: factors };
  }
  if (s === 'manual') {
    return { quotaCalibMode: 'manual', quotaManualFactors: factors };
  }
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

function deepMergeConfig(base, patch) {
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

function loadConfig() {
  try {
    if (!existsSync(SETTINGS_FILE)) return structuredClone(DEFAULT_CONFIG);
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    return deepMergeConfig(DEFAULT_CONFIG, raw);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function saveConfig(patch) {
  const current = loadConfig();
  const next = deepMergeConfig(current, patch);
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return next;
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

function buildConfigPayload(config) {
  const pricingState = loadPricingState(DATA_DIR);
  return {
    version: RUNNING_VERSION,
    config,
    paths: {
      dataDir: DATA_DIR,
      defaultsFile: DEFAULTS_FILE,
      overridesFile: getOverridesPath(DATA_DIR),
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
  const state = loadPricingState(DATA_DIR);
  const listed = listPricingModels(state);
  return {
    ...listed,
    overridesFile: getOverridesPath(DATA_DIR),
    autoSync: Boolean(config.pricingAutoSync),
  };
}

function serveStaticFile(filename, contentType, fallbackBody = '') {
  const fullPath = join(WEB_DIR, filename);
  if (!existsSync(fullPath)) {
    return new Response(fallbackBody, {
      status: fallbackBody ? 200 : 404,
      contentType,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  return new Response(readFileSync(fullPath, 'utf-8'), {
    contentType,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    contentType: 'application/json',
  });
}

const app = new SidecarApp();

// Isolated smoke-test mode used by the self-updater before staging an update.
if (process.env.AGY_LENS_SMOKE === '1') {
  const cfg = loadConfig();
  loadPricingState(DATA_DIR);
  buildConfigPayload(cfg);
  try {
    cacheDb.close();
  } catch {
    // ignore
  }
  process.stdout.write('AGY_LENS_SMOKE_OK\n');
  process.exit(0);
}

let serverHandle = null;
let lastActivityMs = Date.now();
let restartScheduled = false;

function touchActivity() {
  lastActivityMs = Date.now();
}

function scheduleGracefulRestart(exitCode = 1) {
  if (restartScheduled) return;
  restartScheduled = true;
  const finish = () => {
    try {
      cacheDb.close();
    } catch {
      // ignore
    }
    process.exit(exitCode);
  };
  const hardTimer = setTimeout(finish, 1200);
  hardTimer.unref?.();
  setTimeout(() => {
    try {
      if (serverHandle) {
        serverHandle.close(() => {
          clearTimeout(hardTimer);
          finish();
        });
        serverHandle.closeIdleConnections?.();
      } else {
        clearTimeout(hardTimer);
        finish();
      }
    } catch {
      clearTimeout(hardTimer);
      finish();
    }
  }, 180);
}

app.page('/', () => {
  touchActivity();
  const htmlPath = join(WEB_DIR, 'index.html');
  const html = existsSync(htmlPath)
    ? readFileSync(htmlPath, 'utf-8')
    : '<!doctype html><html><body><p>AGY Lens UI assets not found.</p></body></html>';
  return new Response(html, {
    contentType: 'text/html; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
  });
});

app.api('/styles.css', () => {
  touchActivity();
  return serveStaticFile('styles.css', 'text/css', '/* styles pending */');
}, 'GET');
app.api('/app.js', () => {
  touchActivity();
  const fullPath = join(WEB_DIR, 'app.js');
  if (!existsSync(fullPath)) {
    return new Response('// app pending', {
      status: 200,
      contentType: 'application/javascript',
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const diskVer = getRunningVersion(PLUGIN_ROOT);
  const body = `window.__AGY_LENS_DISK_VERSION__=${JSON.stringify(diskVer)};\n${readFileSync(fullPath, 'utf-8')}`;
  return new Response(body, {
    contentType: 'application/javascript',
    headers: { 'Cache-Control': 'no-store' },
  });
}, 'GET');
app.api(
  '/logo.svg',
  () => {
    touchActivity();
    if (!existsSync(LOGO_PATH)) {
      return new Response('', { status: 404, contentType: 'image/svg+xml' });
    }
    return new Response(readFileSync(LOGO_PATH, 'utf-8'), { contentType: 'image/svg+xml' });
  },
  'GET'
);

app.api('/api/health', () => ({
  ok: true,
  version: RUNNING_VERSION,
  diskVersion: getRunningVersion(PLUGIN_ROOT),
  pid: process.pid,
}), 'GET');

app.api('/api/config', () => {
  touchActivity();
  const config = loadConfig();
  maybeAutoSync(DATA_DIR, config.pricingAutoSync);
  maybeAutoCheckUpdate(DATA_DIR, PLUGIN_ROOT, config);
  return buildConfigPayload(config);
}, 'GET');

app.api('/api/config', (data) => {
  touchActivity();
  const next = saveConfig(data);
  maybeAutoSync(DATA_DIR, next.pricingAutoSync);
  maybeAutoCheckUpdate(DATA_DIR, PLUGIN_ROOT, next);
  return buildConfigPayload(next);
}, 'POST');

app.api('/api/session', (data) => {
  touchActivity();
  const config = loadConfig();
  maybeAutoSync(DATA_DIR, config.pricingAutoSync);
  maybeAutoCheckUpdate(DATA_DIR, PLUGIN_ROOT, config);
  const pricingState = loadPricingState(DATA_DIR);
  const convId =
    typeof data.conversationId === 'string' && data.conversationId.trim()
      ? data.conversationId.trim()
      : app.config.conversationId || '';
  const modules = parseModulesSet(data.modules);
  return getSessionSnapshot(cacheDb, pricingState, { conversationId: convId, modules });
}, 'GET');

app.api('/api/analytics', (data) => {
  touchActivity();
  const config = loadConfig();
  maybeAutoSync(DATA_DIR, config.pricingAutoSync);
  const pricingState = loadPricingState(DATA_DIR);
  const sources = enabledSourcesList(config, data.sources);
  const modules = parseModulesSet(data.modules);
  return getAnalytics(cacheDb, pricingState, {
    range: data.range || config.defaultRange || '7d',
    from: data.from || null,
    to: data.to || null,
    sources,
    modules,
    workspace: typeof data.workspace === 'string' ? data.workspace : '',
    gapBreakpointsSec: config.obsGapBreakpointsSec,
  });
}, 'GET');

app.api('/api/day', (data) => {
  touchActivity();
  const config = loadConfig();
  const pricingState = loadPricingState(DATA_DIR);
  const sources = enabledSourcesList(config, data.sources);
  return getDayDetail(cacheDb, pricingState, {
    date: data.date || '',
    sources,
  });
}, 'GET');

app.api('/api/pricing', () => {
  const config = loadConfig();
  return buildPricingPayload(config);
}, 'GET');

app.api('/api/pricing/overrides', (data) => {
  if (!data?.canonicalId || typeof data.canonicalId !== 'string') {
    return jsonError(400, 'canonicalId is required');
  }
  saveOverride(DATA_DIR, data.canonicalId.trim(), data.override ?? null);
  const config = loadConfig();
  return buildPricingPayload(config);
}, 'POST');

app.api('/api/pricing/sync', async () => {
  const config = loadConfig();
  const res = await syncRemotePricing(DATA_DIR);
  return {
    ...res,
    pricing: buildPricingPayload(config),
  };
}, 'POST');

app.api('/api/quota/anchors', (data) => {
  touchActivity();
  const config = loadConfig();
  const sources = enabledSourcesList(config, null);
  runIncrementalIndex(cacheDb, { sources });
  const pricingState = loadPricingState(DATA_DIR);
  return getQuotaStatus(cacheDb, pricingState, {
    pool: data.pool || null,
    windowType: data.window || data.windowType || null,
    anchorModel: typeof data.anchorModel === 'string' && data.anchorModel.trim() ? data.anchorModel.trim() : null,
    quotaAnchorsByPool: config.quotaAnchorsByPool || {},
    quotaCalibMode: data.quotaCalibMode || config.quotaCalibMode || 'auto',
    quotaManualFactors: config.quotaManualFactors || { M: false, C: false, O: false },
    forceSubset: data.forceSubset || null,
    forceLevel: data.forceLevel || null,
  });
}, 'GET');

app.api('/api/quota/anchors', (data) => {
  try {
    addQuotaAnchor(cacheDb, data);
    const config = loadConfig();
    const pricingState = loadPricingState(DATA_DIR);
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
}, 'POST');

app.api('/api/quota/anchors/update', (data) => {
  try {
    updateQuotaAnchor(cacheDb, data);
    const config = loadConfig();
    const pricingState = loadPricingState(DATA_DIR);
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
}, 'POST');

app.api('/api/quota/anchors/delete', (data) => {
  try {
    deleteQuotaAnchor(cacheDb, data?.id);
    const config = loadConfig();
    const pricingState = loadPricingState(DATA_DIR);
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
}, 'POST');

app.api('/api/index/rebuild', () => {
  touchActivity();
  const config = loadConfig();
  const sources = enabledSourcesList(config, null);
  const stats = rebuildIndex(cacheDb, { sources });
  return {
    ok: true,
    ...stats,
    indexStatus: getIndexStatus(cacheDb),
  };
}, 'POST');

app.api('/api/update/status', async () => {
  touchActivity();
  const config = loadConfig();
  return getUpdateStatus(DATA_DIR, PLUGIN_ROOT, config);
}, 'GET');

app.api('/api/update/check', async () => {
  touchActivity();
  const config = loadConfig();
  return checkForUpdate(DATA_DIR, PLUGIN_ROOT, config, { force: true });
}, 'POST');

app.api('/api/update/apply', async () => {
  touchActivity();
  const config = loadConfig();
  try {
    const res = await prepareApplyNow(DATA_DIR, PLUGIN_ROOT, config);
    scheduleGracefulRestart(1);
    return res;
  } catch (err) {
    return jsonError(400, err.message);
  }
}, 'POST');

app.api('/api/update/rollback', () => {
  touchActivity();
  try {
    const res = prepareRollback(DATA_DIR, PLUGIN_ROOT);
    scheduleGracefulRestart(1);
    return res;
  } catch (err) {
    return jsonError(400, err.message);
  }
}, 'POST');

app.api('/api/update/ack-updated', () => {
  touchActivity();
  ackJustUpdated(DATA_DIR);
  return { ok: true };
}, 'POST');

serverHandle = await app.run();

// Mark any recently applied update as healthy after 10 seconds of stable operation.
const healthTimer = setTimeout(() => {
  try {
    markHealthy(DATA_DIR, RUNNING_VERSION);
  } catch {
    // ignore
  }
}, 10000);
healthTimer.unref?.();

// Backend-driven idle auto-apply: if auto mode has a staged update ready and
// zero requests have arrived for 10 minutes across all clients, exit cleanly
// so `boot.mjs` applies it automatically on next launch.
const IDLE_AUTO_APPLY_MS = 10 * 60 * 1000;
const idleCheckTimer = setInterval(() => {
  if (restartScheduled) return;
  if (Date.now() - lastActivityMs < IDLE_AUTO_APPLY_MS) return;
  try {
    const cfg = loadConfig();
    if (hasPendingAutoApplyOnIdle(DATA_DIR, RUNNING_VERSION, cfg)) {
      scheduleGracefulRestart(1);
    }
  } catch {
    // ignore
  }
}, 60000);
idleCheckTimer.unref?.();
