/**
 * AGY Lens Sidecar backend.
 * Strictly read-only access to source conversation DBs; persistent state stored under DATA_DIR.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
} from './lib/quota.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, 'web');
const LOGO_PATH = join(__dirname, '..', '..', 'assets', 'logo.svg');

const DEFAULT_CONFIG = {
  lang: 'zh-CN',
  modules: {
    'live-context': true,
    'cache-diagnostics': true,
    'io-flow': true,
    'model-cost': true,
    'calendar-trends': false,
    'cache-observatory': false,
    'quota-budget': false,
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
    'cache-observatory': true,
    'quota-budget': true,
  },
  sources: { desktop: true, cli: true },
  refreshSec: 30,
  pricingAutoSync: false,
  quotaDisplayMode: 'remaining',
  defaultRange: '7d',
};

const DATA_DIR = resolveDataDir();
mkdirSync(DATA_DIR, { recursive: true });
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const { db: cacheDb, dbPath: cacheDbPath } = openTelemetryCacheDb(DATA_DIR);

function deepMergeConfig(base, patch) {
  if (!patch || typeof patch !== 'object') return structuredClone(base);
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
    });
  }
  return new Response(readFileSync(fullPath, 'utf-8'), { contentType });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    contentType: 'application/json',
  });
}

const app = new SidecarApp();

app.page('/', () => {
  const htmlPath = join(WEB_DIR, 'index.html');
  if (existsSync(htmlPath)) {
    return readFileSync(htmlPath, 'utf-8');
  }
  return '<!doctype html><html><body><p>AGY Lens UI assets not found.</p></body></html>';
});

app.api('/styles.css', () => serveStaticFile('styles.css', 'text/css', '/* styles pending */'), 'GET');
app.api('/app.js', () => serveStaticFile('app.js', 'application/javascript', '// app pending'), 'GET');
app.api(
  '/logo.svg',
  () => {
    if (!existsSync(LOGO_PATH)) {
      return new Response('', { status: 404, contentType: 'image/svg+xml' });
    }
    return new Response(readFileSync(LOGO_PATH, 'utf-8'), { contentType: 'image/svg+xml' });
  },
  'GET'
);

app.api('/api/config', () => {
  const config = loadConfig();
  maybeAutoSync(DATA_DIR, config.pricingAutoSync);
  return buildConfigPayload(config);
}, 'GET');

app.api('/api/config', (data) => {
  const next = saveConfig(data);
  maybeAutoSync(DATA_DIR, next.pricingAutoSync);
  return buildConfigPayload(next);
}, 'POST');

app.api('/api/session', (data) => {
  const config = loadConfig();
  maybeAutoSync(DATA_DIR, config.pricingAutoSync);
  const pricingState = loadPricingState(DATA_DIR);
  const convId =
    typeof data.conversationId === 'string' && data.conversationId.trim()
      ? data.conversationId.trim()
      : app.config.conversationId || '';
  const modules = parseModulesSet(data.modules);
  return getSessionSnapshot(cacheDb, pricingState, { conversationId: convId, modules });
}, 'GET');

app.api('/api/analytics', (data) => {
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
  });
}, 'GET');

app.api('/api/day', (data) => {
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
  const config = loadConfig();
  const sources = enabledSourcesList(config, null);
  runIncrementalIndex(cacheDb, { sources });
  const pricingState = loadPricingState(DATA_DIR);
  return getQuotaStatus(cacheDb, pricingState, {
    pool: data.pool || null,
    windowType: data.window || data.windowType || null,
  });
}, 'GET');

app.api('/api/quota/anchors', (data) => {
  try {
    addQuotaAnchor(cacheDb, data);
    const pricingState = loadPricingState(DATA_DIR);
    return getQuotaStatus(cacheDb, pricingState, {
      pool: null,
      windowType: null,
    });
  } catch (err) {
    return jsonError(400, err.message);
  }
}, 'POST');

app.api('/api/quota/anchors/delete', (data) => {
  try {
    deleteQuotaAnchor(cacheDb, data?.id);
    const pricingState = loadPricingState(DATA_DIR);
    return getQuotaStatus(cacheDb, pricingState, {
      pool: null,
      windowType: null,
    });
  } catch (err) {
    return jsonError(400, err.message);
  }
}, 'POST');

app.api('/api/index/rebuild', () => {
  const config = loadConfig();
  const sources = enabledSourcesList(config, null);
  const stats = rebuildIndex(cacheDb, { sources });
  return {
    ok: true,
    ...stats,
    indexStatus: getIndexStatus(cacheDb),
  };
}, 'POST');

app.run();
