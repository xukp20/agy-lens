/**
 * Pricing engine for Antigravity telemetry (AGY Lens).
 * Precedence: user overrides > bundled date-versioned defaults > remote catalog cache > unpriced.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULTS_FILE = join(__dirname, 'pricing_defaults.json');

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const REMOTE_TIMEOUT_MS = 8000;
const REMOTE_TTL_MS = 24 * 3600 * 1000;

export const MODEL_ENUM_FALLBACK = {
  1198: 'gemini-3.5-flash-lite',
  1320: 'gemini-3.8-flash',
  1322: 'gemini-3.8-flash',
  1401: 'claude-opus-5-5',
  1402: 'claude-opus-5-5',
  1418: 'gemini-4-argon',
  1427: 'gemini-4-carbon',
  1437: 'gemini-4-carbon',
  1525: 'gemini-4-hydrogen',
  1526: 'gemini-4-hydrogen',
  1530: 'gemini-4-hydrogen',
  1532: 'gemini-4-neon',
  1667: 'gemini-4-carbon',
};

const ORCHESTRATOR_ALIASES = {
  'gemini-pro-orchestrator-neon': 'gemini-4-neon',
  'gemini-pro-orchestrator-argon': 'gemini-4-argon',
  'gemini-pro-orchestrator': 'gemini-4-carbon',
  'gemini-3-8-flash': 'gemini-3.8-flash',
};

let cachedDefaults = null;
let inflightSync = null;

export function loadDefaults() {
  if (!cachedDefaults) {
    cachedDefaults = JSON.parse(readFileSync(DEFAULTS_FILE, 'utf-8'));
  }
  return cachedDefaults;
}

export function normalizeModelId(rawModelId, modelEnum = null, learnedEnums = null) {
  let raw = typeof rawModelId === 'string' ? rawModelId.trim().toLowerCase() : '';
  if (!raw && modelEnum !== null && modelEnum !== undefined) {
    const learned = learnedEnums?.get?.(Number(modelEnum));
    if (learned) raw = learned.trim().toLowerCase();
  }
  if (!raw && modelEnum !== null && modelEnum !== undefined) {
    return MODEL_ENUM_FALLBACK[Number(modelEnum)] || `model-${modelEnum}`;
  }
  if (!raw) return 'unknown';

  // Strip provider prefixes from remote keys or Antigravity effort/tier suffixes.
  let clean = raw.replace(/^(?:anthropic|google|openai|vertex_ai|openrouter)\//, '');
  clean = clean.replace(/(?:-(?:xhigh|high|medium|low|tiered(?:-[a-z0-9-]+)?))+$/i, '');

  if (ORCHESTRATOR_ALIASES[clean]) {
    return ORCHESTRATOR_ALIASES[clean];
  }

  // Also check explicit aliases in defaults.
  const defaults = loadDefaults();
  for (const [canonical, entry] of Object.entries(defaults.models || {})) {
    if (canonical === clean) return canonical;
    if (Array.isArray(entry.aliases) && entry.aliases.includes(clean)) {
      return canonical;
    }
  }
  return clean;
}

export function inferPool(canonicalId, rawModelId = '') {
  const defaults = loadDefaults();
  const def = defaults.models?.[canonicalId];
  if (def?.pool) return def.pool;

  const s = `${canonicalId} ${rawModelId}`.toLowerCase();
  if (s.includes('argon')) return 'argon';
  if (
    s.startsWith('claude') ||
    s.startsWith('gpt') ||
    s.startsWith('o1') ||
    s.startsWith('o3') ||
    s.startsWith('o4') ||
    s.includes('deepseek') ||
    s.includes('qwen') ||
    s.includes('llama') ||
    s.includes('anthropic') ||
    s.includes('openai')
  ) {
    return '3p';
  }
  return 'gemini';
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function getOverridesPath(dataDir) {
  return join(dataDir, 'pricing_overrides.json');
}

export function getRemoteCachePath(dataDir) {
  return join(dataDir, 'remote_pricing_cache.json');
}

export function loadPricingState(dataDir) {
  const defaults = loadDefaults();
  const overridesRaw = readJsonSafe(getOverridesPath(dataDir), { models: {} });
  const remoteRaw = readJsonSafe(getRemoteCachePath(dataDir), { fetchedAt: null, models: {} });
  const defaultAnchors =
    defaults?.defaultAnchors && typeof defaults.defaultAnchors === 'object'
      ? { ...defaults.defaultAnchors }
      : { gemini: 'gemini-4-neon', argon: 'gemini-4-argon', '3p': 'claude-opus-5-5' };
  return {
    defaults,
    defaultAnchors,
    overrides: overridesRaw?.models && typeof overridesRaw.models === 'object' ? overridesRaw.models : {},
    remote: {
      fetchedAt: remoteRaw?.fetchedAt || null,
      models: remoteRaw?.models && typeof remoteRaw.models === 'object' ? remoteRaw.models : {},
    },
  };
}

export function saveOverride(dataDir, canonicalId, override) {
  mkdirSync(dataDir, { recursive: true });
  const overridesPath = getOverridesPath(dataDir);
  const current = readJsonSafe(overridesPath, { schemaVersion: 1, models: {} });
  const models = current?.models && typeof current.models === 'object' ? { ...current.models } : {};

  if (override === null || override === undefined) {
    delete models[canonicalId];
  } else {
    models[canonicalId] = sanitizeRateFields(override, canonicalId);
  }

  writeFileSync(overridesPath, JSON.stringify({ schemaVersion: 1, models }, null, 2) + '\n', 'utf-8');
  return loadPricingState(dataDir);
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function sanitizeRateFields(r, canonicalId) {
  const input = numOrNull(r.inputPer1m ?? r.input_per_1m) ?? 0;
  const output = numOrNull(r.outputPer1m ?? r.output_per_1m) ?? 0;
  const thinking = numOrNull(r.thinkingPer1m ?? r.thinking_per_1m) ?? output;
  const cacheRead = numOrNull(r.cacheReadPer1m ?? r.cache_read_per_1m) ?? 0;
  const cacheWrite = numOrNull(r.cacheWritePer1m ?? r.cache_write_per_1m) ?? 0;
  const threshold = numOrNull(r.longContextThreshold ?? r.long_context_threshold);
  const inputAbove = numOrNull(r.inputAbovePer1m ?? r.input_above_per_1m);
  const outputAbove = numOrNull(r.outputAbovePer1m ?? r.output_above_per_1m);
  const thinkingAbove = numOrNull(r.thinkingAbovePer1m ?? r.thinking_above_per_1m) ?? outputAbove;
  const cacheReadAbove = numOrNull(r.cacheReadAbovePer1m ?? r.cache_read_above_per_1m);
  const cacheWriteAbove = numOrNull(r.cacheWriteAbovePer1m ?? r.cache_write_above_per_1m);
  return {
    pool: r.pool || inferPool(canonicalId),
    effective_from: r.effectiveFrom || r.effective_from || new Date().toISOString().slice(0, 10),
    input_per_1m: input,
    output_per_1m: output,
    thinking_per_1m: thinking,
    cache_read_per_1m: cacheRead,
    cache_write_per_1m: cacheWrite,
    long_context_threshold: threshold && threshold > 0 ? threshold : null,
    input_above_per_1m: inputAbove,
    output_above_per_1m: outputAbove,
    thinking_above_per_1m: thinkingAbove,
    cache_read_above_per_1m: cacheReadAbove,
    cache_write_above_per_1m: cacheWriteAbove,
    notes: typeof r.notes === 'string' ? r.notes : 'User override',
  };
}

function selectEffectiveDefaultRate(entry, dateStr) {
  const rates = Array.isArray(entry?.rates) ? entry.rates : [];
  if (rates.length === 0) return null;
  const sorted = [...rates].sort((a, b) =>
    String(a.effective_from || '').localeCompare(String(b.effective_from || ''))
  );
  let chosen = sorted[0];
  for (const r of sorted) {
    if (!r.effective_from || r.effective_from <= dateStr) {
      chosen = r;
    }
  }
  return chosen;
}

function pricesMatchPromo(remoteRate, defSlice) {
  if (!remoteRate || !defSlice) return false;
  const dm = Number(defSlice.discount_multiplier);
  if (!Number.isFinite(dm) || dm <= 0 || dm >= 1) return false;
  const inMatch =
    remoteRate.input_per_1m != null &&
    defSlice.input_per_1m != null &&
    Math.abs(Number(remoteRate.input_per_1m) - Number(defSlice.input_per_1m)) < 1e-6;
  const outMatch =
    remoteRate.output_per_1m == null ||
    defSlice.output_per_1m == null ||
    Math.abs(Number(remoteRate.output_per_1m) - Number(defSlice.output_per_1m)) < 1e-6;
  return inMatch && outMatch;
}

/**
 * Merge a remote catalog entry over a bundled default entry for `syncDateStr`,
 * preserving non-null long-context fields and matching promo metadata.
 */
export function mergeRemoteEntryWithDefault(remoteRate, defEntry, syncDateStr) {
  if (!remoteRate) return null;
  const effDate = remoteRate.effective_from || syncDateStr || new Date().toISOString().slice(0, 10);
  const defSlice = defEntry ? selectEffectiveDefaultRate(defEntry, effDate) : null;
  const keepPromo = pricesMatchPromo(remoteRate, defSlice);
  return {
    ...remoteRate,
    pool: remoteRate.pool || defEntry?.pool || 'gemini',
    effective_from: effDate,
    long_context_threshold:
      remoteRate.long_context_threshold ?? defSlice?.long_context_threshold ?? null,
    input_above_per_1m:
      remoteRate.input_above_per_1m ?? defSlice?.input_above_per_1m ?? null,
    output_above_per_1m:
      remoteRate.output_above_per_1m ?? defSlice?.output_above_per_1m ?? null,
    thinking_above_per_1m:
      remoteRate.thinking_above_per_1m ?? defSlice?.thinking_above_per_1m ?? null,
    cache_read_above_per_1m:
      remoteRate.cache_read_above_per_1m ?? defSlice?.cache_read_above_per_1m ?? null,
    cache_write_above_per_1m:
      remoteRate.cache_write_above_per_1m ?? defSlice?.cache_write_above_per_1m ?? null,
    discount_multiplier: keepPromo
      ? defSlice.discount_multiplier
      : (remoteRate.discount_multiplier ?? 1.0),
    promo_label: keepPromo
      ? (defSlice.promo_label ?? null)
      : (remoteRate.promo_label ?? null),
  };
}

/**
 * Resolve effective rate for `(canonicalId, timestampMs)`.
 */
export function resolveRate(canonicalId, timestampMs, state) {
  const dateStr = timestampMs
    ? new Date(timestampMs).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  if (state.overrides?.[canonicalId]) {
    const ov = state.overrides[canonicalId];
    return {
      ...ov,
      discount_multiplier: ov.discount_multiplier ?? 1.0,
      promo_label: ov.promo_label ?? null,
      pool: ov.pool || inferPool(canonicalId),
      source: 'override',
    };
  }

  const defEntry = state.defaults?.models?.[canonicalId];
  const remoteRateRaw = state.remote?.models?.[canonicalId];

  const slices = [];
  if (defEntry && Array.isArray(defEntry.rates)) {
    for (const r of defEntry.rates) {
      slices.push({
        ...r,
        discount_multiplier: r.discount_multiplier ?? 1.0,
        promo_label: r.promo_label ?? null,
        pool: defEntry.pool || inferPool(canonicalId),
        source: 'default',
      });
    }
  }

  if (remoteRateRaw) {
    const fallbackSyncDate = state.remote?.fetchedAt
      ? new Date(state.remote.fetchedAt).toISOString().slice(0, 10)
      : dateStr;
    const mergedRemote = mergeRemoteEntryWithDefault(remoteRateRaw, defEntry, fallbackSyncDate);
    slices.push({
      ...mergedRemote,
      pool: mergedRemote.pool || defEntry?.pool || inferPool(canonicalId),
      source: 'remote',
    });
  }

  if (slices.length === 0) return null;

  // Sort ascending by effective_from; for identical dates, default precedes remote so remote takes >= syncDateStr.
  slices.sort((a, b) => {
    const cmp = String(a.effective_from || '').localeCompare(String(b.effective_from || ''));
    if (cmp !== 0) return cmp;
    if (a.source === b.source) return 0;
    return a.source === 'default' ? -1 : 1;
  });

  let chosen = null;
  for (const s of slices) {
    if (!s.effective_from || s.effective_from <= dateStr) {
      chosen = s;
    }
  }
  return chosen || slices[0];
}

/**
 * Resolve effective per-1M rates (including long-context tiering) for a turn.
 */
function resolveTurnEffectiveRates(turn, state) {
  const canonicalId = turn.canonical_model_id || turn.canonicalModelId || 'unknown';
  const tsMs = turn.completed_at_ms ?? turn.completedAtMs ?? turn.created_at_ms ?? turn.createdAtMs ?? Date.now();
  const rate = resolveRate(canonicalId, tsMs, state);
  if (!rate) {
    return { canonicalId, rate: null, longContext: false };
  }

  const uncachedIn = Math.max(0, Number(turn.uncached_in ?? turn.uncachedIn ?? 0));
  const cacheRead = Math.max(0, Number(turn.cache_read ?? turn.cacheRead ?? 0));
  const cacheCreate = Math.max(0, Number(turn.cache_create ?? turn.cacheCreate ?? 0));
  const promptTotal = uncachedIn + cacheRead + cacheCreate;
  const threshold = rate.long_context_threshold;
  const longContext = Boolean(threshold && threshold > 0 && promptTotal > threshold);

  const inRate = longContext && rate.input_above_per_1m != null ? rate.input_above_per_1m : rate.input_per_1m;
  const outRate = longContext && rate.output_above_per_1m != null ? rate.output_above_per_1m : rate.output_per_1m;
  const thinkRate =
    longContext && rate.thinking_above_per_1m != null
      ? rate.thinking_above_per_1m
      : rate.thinking_per_1m ?? outRate;
  const cacheReadRate =
    longContext && rate.cache_read_above_per_1m != null
      ? rate.cache_read_above_per_1m
      : rate.cache_read_per_1m ?? inRate;
  const cacheWriteRate =
    longContext && rate.cache_write_above_per_1m != null
      ? rate.cache_write_above_per_1m
      : rate.cache_write_per_1m ?? inRate;

  return {
    canonicalId,
    rate,
    longContext,
    uncachedIn,
    cacheRead,
    cacheCreate,
    promptTotal,
    inRate,
    outRate,
    thinkRate,
    cacheReadRate,
    cacheWriteRate,
  };
}

/**
 * Calculate API-equivalent cost and cache savings for one turn.
 */
export function calculateTurnCost(turn, state) {
  const eff = resolveTurnEffectiveRates(turn, state);
  if (!eff.rate) {
    return {
      unpriced: true,
      longContext: false,
      costUsd: 0,
      noCacheBaselineUsd: 0,
      cacheSavedUsd: 0,
      pricingSource: 'unpriced',
      pool: turn.pool || inferPool(eff.canonicalId),
    };
  }

  const thinkingOut = Math.max(0, Number(turn.thinking_out ?? turn.thinkingOut ?? 0));
  const totalOut = Math.max(0, Number(turn.total_out ?? turn.totalOut ?? 0));
  const visibleOutRaw = turn.visible_out ?? turn.visibleOut;
  const visibleOut = Math.max(
    0,
    visibleOutRaw !== undefined && visibleOutRaw !== null
      ? Number(visibleOutRaw)
      : totalOut - thinkingOut
  );
  const extraOut = Math.max(0, totalOut - (visibleOut + thinkingOut));

  const outCost = ((visibleOut + extraOut) * eff.outRate + thinkingOut * eff.thinkRate) / 1e6;
  const costUsd =
    (eff.uncachedIn * eff.inRate + eff.cacheRead * eff.cacheReadRate + eff.cacheCreate * eff.cacheWriteRate) / 1e6 +
    outCost;
  const noCacheBaselineUsd = (eff.promptTotal * eff.inRate) / 1e6 + outCost;
  const cacheSavedUsd = Math.max(0, noCacheBaselineUsd - costUsd);

  return {
    unpriced: false,
    longContext: eff.longContext,
    costUsd,
    noCacheBaselineUsd,
    cacheSavedUsd,
    pricingSource: eff.rate.source,
    pool: eff.rate.pool || turn.pool || inferPool(eff.canonicalId),
  };
}

/**
 * Calculate detailed per-bucket API-equivalent and list-price cost breakdown for one turn.
 */
export function calculateTurnCostBreakdown(turn, pricingState, { useListPrice = false } = {}) {
  const eff = resolveTurnEffectiveRates(turn, pricingState);
  if (!eff.rate) {
    return {
      canonicalId: eff.canonicalId,
      unpriced: true,
      longContext: false,
      isPromo: false,
      discountMultiplier: 1.0,
      inUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      outUsd: 0,
      totalUsd: 0,
      listInUsd: 0,
      listCacheReadUsd: 0,
      listCacheWriteUsd: 0,
      listOutUsd: 0,
      listTotalUsd: 0,
    };
  }

  const thinkingOut = Math.max(0, Number(turn.thinking_out ?? turn.thinkingOut ?? 0));
  const totalOut = Math.max(0, Number(turn.total_out ?? turn.totalOut ?? 0));
  const visibleOutRaw = turn.visible_out ?? turn.visibleOut;
  const visibleOut = Math.max(
    0,
    visibleOutRaw !== undefined && visibleOutRaw !== null
      ? Number(visibleOutRaw)
      : totalOut - thinkingOut
  );
  const extraOut = Math.max(0, totalOut - (visibleOut + thinkingOut));

  const effInUsd = (eff.uncachedIn * (eff.inRate ?? 0)) / 1e6;
  const effCacheReadUsd = (eff.cacheRead * (eff.cacheReadRate ?? 0)) / 1e6;
  const effCacheWriteUsd = (eff.cacheCreate * (eff.cacheWriteRate ?? 0)) / 1e6;
  const effOutUsd = ((visibleOut + extraOut) * (eff.outRate ?? 0) + thinkingOut * (eff.thinkRate ?? 0)) / 1e6;
  const effTotalUsd = effInUsd + effCacheReadUsd + effCacheWriteUsd + effOutUsd;

  const rawDm = Number(eff.rate.discount_multiplier);
  const discountMultiplier = Number.isFinite(rawDm) && rawDm > 0 && rawDm <= 1 ? rawDm : 1.0;
  const isPromo = discountMultiplier > 0 && discountMultiplier < 1;
  const listScale = isPromo ? 1 / discountMultiplier : 1.0;

  const listInUsd = effInUsd * listScale;
  const listCacheReadUsd = effCacheReadUsd * listScale;
  const listCacheWriteUsd = effCacheWriteUsd * listScale;
  const listOutUsd = effOutUsd * listScale;
  const listTotalUsd = effTotalUsd * listScale;

  return {
    canonicalId: eff.canonicalId,
    unpriced: false,
    longContext: eff.longContext,
    isPromo,
    discountMultiplier,
    inUsd: useListPrice ? listInUsd : effInUsd,
    cacheReadUsd: useListPrice ? listCacheReadUsd : effCacheReadUsd,
    cacheWriteUsd: useListPrice ? listCacheWriteUsd : effCacheWriteUsd,
    outUsd: useListPrice ? listOutUsd : effOutUsd,
    totalUsd: useListPrice ? listTotalUsd : effTotalUsd,
    listInUsd,
    listCacheReadUsd,
    listCacheWriteUsd,
    listOutUsd,
    listTotalUsd,
  };
}

/**
 * Calculate excess API-equivalent cost caused by `wastedTokens` missing prompt cache,
 * respecting the turn's effective long-context tier.
 */
export function calcMissPenaltyUsd(turn, wastedTokens, state) {
  const wasted = Math.max(0, Number(wastedTokens || 0));
  if (wasted <= 0 || !state) return 0;
  const eff = resolveTurnEffectiveRates(turn, state);
  if (!eff.rate) return 0;
  const deltaPer1m = Math.max(0, (eff.inRate ?? 0) - (eff.cacheReadRate ?? 0));
  return (wasted * deltaPer1m) / 1e6;
}

export function listPricingModels(state, nowMs = Date.now()) {
  const dateStr = new Date(nowMs).toISOString().slice(0, 10);
  const allIds = new Set([
    ...Object.keys(state.defaults?.models || {}),
    ...Object.keys(state.overrides || {}),
    ...Object.keys(state.remote?.models || {}),
  ]);

  const models = [];
  for (const canonicalId of [...allIds].sort()) {
    const rate = resolveRate(canonicalId, nowMs, state);
    if (!rate) continue;
    models.push({
      canonicalId,
      pool: rate.pool || inferPool(canonicalId),
      source: rate.source,
      effectiveFrom: rate.effective_from || dateStr,
      inputPer1m: rate.input_per_1m ?? 0,
      outputPer1m: rate.output_per_1m ?? 0,
      thinkingPer1m: rate.thinking_per_1m ?? rate.output_per_1m ?? 0,
      cacheReadPer1m: rate.cache_read_per_1m ?? 0,
      cacheWritePer1m: rate.cache_write_per_1m ?? 0,
      longContextThreshold: rate.long_context_threshold ?? null,
      inputAbovePer1m: rate.input_above_per_1m ?? null,
      outputAbovePer1m: rate.output_above_per_1m ?? null,
      cacheReadAbovePer1m: rate.cache_read_above_per_1m ?? null,
      discountMultiplier: rate.discount_multiplier ?? 1.0,
      promoLabel: rate.promo_label ?? null,
      notes: rate.notes || '',
    });
  }

  return {
    defaultsFile: DEFAULTS_FILE,
    overridesFile: '', // filled by caller with dataDir
    lastSyncedAt: state.remote?.fetchedAt || null,
    defaultAnchors:
      state.defaultAnchors ||
      state.defaults?.defaultAnchors || {
        gemini: 'gemini-4-neon',
        argon: 'gemini-4-argon',
        '3p': 'claude-opus-5-5',
      },
    models,
  };
}

function parsePositivePerToken(val) {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number((n * 1e6).toFixed(6));
}

function normalizeRemoteKey(key) {
  return String(key || '')
    .trim()
    .toLowerCase()
    .replace(/^(?:anthropic|google|openai|vertex_ai|bedrock|azure|openrouter)\//, '')
    .replace(/:(?:free|beta|extended)$/, '')
    .replace(/\./g, '-');
}

export async function syncRemotePricing(dataDir) {
  if (inflightSync) return inflightSync;
  inflightSync = (async () => {
    mkdirSync(dataDir, { recursive: true });
    const defaults = loadDefaults();
    const syncDateStr = new Date().toISOString().slice(0, 10);
    const merged = {};
    const errors = [];
    let litellmCount = 0;
    let openrouterCount = 0;

    try {
      const resp = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`LiteLLM HTTP ${resp.status}`);
      const json = await resp.json();
      for (const [key, info] of Object.entries(json || {})) {
        if (!info || typeof info !== 'object') continue;
        const in1m = parsePositivePerToken(info.input_cost_per_token);
        const out1m = parsePositivePerToken(info.output_cost_per_token);
        if (in1m === null && out1m === null) continue;
        const canonical = normalizeRemoteKey(key);
        if (!canonical || canonical === 'sample_spec') continue;
        const cacheRead = parsePositivePerToken(info.cache_read_input_token_cost);
        const cacheWrite = parsePositivePerToken(info.cache_creation_input_token_cost);
        const inAbove = parsePositivePerToken(info.input_cost_per_token_above_200k_tokens);
        const outAbove = parsePositivePerToken(info.output_cost_per_token_above_200k_tokens);
        const crAbove = parsePositivePerToken(info.cache_read_input_token_cost_above_200k_tokens);

        merged[canonical] = mergeRemoteEntryWithDefault(
          {
            pool: inferPool(canonical, key),
            effective_from: syncDateStr,
            input_per_1m: in1m ?? 0,
            output_per_1m: out1m ?? 0,
            thinking_per_1m: out1m ?? 0,
            cache_read_per_1m: cacheRead ?? 0,
            cache_write_per_1m: cacheWrite ?? 0,
            long_context_threshold: inAbove || outAbove ? 200000 : null,
            input_above_per_1m: inAbove,
            output_above_per_1m: outAbove,
            thinking_above_per_1m: outAbove,
            cache_read_above_per_1m: crAbove,
            cache_write_above_per_1m: null,
            notes: 'Synced from LiteLLM',
          },
          defaults?.models?.[canonical],
          syncDateStr
        );
        litellmCount++;
      }
    } catch (err) {
      errors.push(`LiteLLM: ${err.message}`);
    }

    try {
      const resp = await fetch(OPENROUTER_URL, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}`);
      const json = await resp.json();
      for (const item of json?.data || []) {
        if (!item?.id || !item?.pricing) continue;
        const p = item.pricing;
        const in1m = parsePositivePerToken(p.prompt);
        const out1m = parsePositivePerToken(p.completion);
        if (in1m === null && out1m === null) continue;
        const canonical = normalizeRemoteKey(item.id);
        if (!canonical) continue;
        const cacheRead = parsePositivePerToken(p.input_cache_read);
        const cacheWrite = parsePositivePerToken(p.input_cache_write);
        const reasoning = parsePositivePerToken(p.internal_reasoning);

        // Prefer OpenRouter when LiteLLM didn't already supply an entry, or fill missing fields.
        if (!merged[canonical]) {
          merged[canonical] = mergeRemoteEntryWithDefault(
            {
              pool: inferPool(canonical, item.id),
              effective_from: syncDateStr,
              input_per_1m: in1m ?? 0,
              output_per_1m: out1m ?? 0,
              thinking_per_1m: reasoning ?? out1m ?? 0,
              cache_read_per_1m: cacheRead ?? 0,
              cache_write_per_1m: cacheWrite ?? 0,
              long_context_threshold: null,
              input_above_per_1m: null,
              output_above_per_1m: null,
              thinking_above_per_1m: null,
              cache_read_above_per_1m: null,
              cache_write_above_per_1m: null,
              notes: 'Synced from OpenRouter',
            },
            defaults?.models?.[canonical],
            syncDateStr
          );
        }
        openrouterCount++;
      }
    } catch (err) {
      errors.push(`OpenRouter: ${err.message}`);
    }

    const fetchedAt = Date.now();
    const matchedCount = Object.keys(merged).length;

    if (matchedCount > 0) {
      writeFileSync(
        getRemoteCachePath(dataDir),
        JSON.stringify(
          {
            fetchedAt,
            sources: { litellmCount, openrouterCount },
            models: merged,
          },
          null,
          2
        ) + '\n',
        'utf-8'
      );
      return {
        ok: true,
        syncedAt: fetchedAt,
        matchedCount,
        error: errors.length > 0 ? errors.join('; ') : undefined,
      };
    }

    return {
      ok: false,
      syncedAt: null,
      matchedCount: 0,
      error: errors.join('; ') || 'No remote pricing models fetched',
    };
  })().finally(() => {
    inflightSync = null;
  });

  return inflightSync;
}

export function maybeAutoSync(dataDir, autoSyncEnabled) {
  if (!autoSyncEnabled || inflightSync) return;
  const cache = readJsonSafe(getRemoteCachePath(dataDir), null);
  const age = cache?.fetchedAt ? Date.now() - cache.fetchedAt : Infinity;
  if (age > REMOTE_TTL_MS) {
    // Fire and forget in background without blocking API latency.
    syncRemotePricing(dataDir).catch(() => {});
  }
}
