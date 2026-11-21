/**
 * Pricing engine for Antigravity telemetry (AGY Lens).
 * Precedence: user overrides > bundled date-versioned defaults > remote catalog cache > unpriced.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULTS_FILE = join(__dirname, 'pricing_defaults.json');

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const REMOTE_TIMEOUT_MS = 8000;
const REMOTE_TTL_MS = 24 * 3600 * 1000;

const LITELLM_DIRECT_PREFIXES = new Set(['gemini', 'google', 'anthropic', 'openai']);
const LITELLM_BLOCKED_PROVIDERS = new Set([
  'bedrock',
  'bedrock_converse',
  'vertex_ai',
  'vertex_ai_beta',
  'vertex_ai-language-models',
  'vertex_ai-vision-models',
  'azure',
  'azure_ai',
  'sagemaker',
  'sagemaker_chat',
  'openrouter',
  'together_ai',
  'fireworks_ai',
  'groq',
  'replicate',
  'perplexity',
  'cloudflare',
  'databricks',
  'snowflake',
  'nebius',
  'novita',
  'deepinfra',
  'hosted_vllm',
  'sambanova',
  'cerebras',
  'baseten',
  'featherless_ai',
]);
const RELEVANT_CHAT_FAMILY_RE = /^(?:gemini-|claude-|gpt-oss)/i;
const EXCLUDED_NON_CHAT_RE =
  /(?:embedding|imagen|veo|tts|audio|whisper|realtime|moderation|dall-e|bison|gecko|aqa|lyria|chirp|transcribe|robotics|computer-use|image-generation|live-)/i;
const OPENROUTER_VARIANT_SUFFIX_RE = /:(?:free|beta|extended|nitro|floor|exacto|thinking)$/i;

let tmpWriteSeq = 0;
const jsonStatCache = new Map(); // filePath -> { sig, value }

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
  let clean = raw.replace(/^(?:anthropic|google|gemini|openai|vertex_ai|openrouter)\//, '');
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

export function writeJsonAtomic(filePath, obj, pretty = true) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${++tmpWriteSeq}`;
  const content = (pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)) + '\n';
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, filePath);
    jsonStatCache.delete(filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export function clearPricingJsonCache(filePath = null) {
  if (filePath) jsonStatCache.delete(filePath);
  else jsonStatCache.clear();
}

function readJsonCached(filePath, fallback) {
  try {
    let st;
    try {
      st = statSync(filePath, { bigint: true });
    } catch (err) {
      if (err?.code === 'ENOENT') jsonStatCache.delete(filePath);
      return fallback;
    }
    const sig = `${st.mtimeNs}:${st.size}:${st.ino}`;
    const hit = jsonStatCache.get(filePath);
    if (hit && hit.sig === sig) {
      return hit.value;
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    jsonStatCache.set(filePath, { sig, value: parsed });
    return parsed;
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
  const overridesRaw = readJsonCached(getOverridesPath(dataDir), null);
  const remoteRaw = readJsonCached(getRemoteCachePath(dataDir), null);
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
      remoteTotalCount:
        remoteRaw?.remoteTotalCount != null && Number.isFinite(Number(remoteRaw.remoteTotalCount))
          ? Number(remoteRaw.remoteTotalCount)
          : null,
      models: remoteRaw?.models && typeof remoteRaw.models === 'object' ? remoteRaw.models : {},
    },
  };
}

export function saveOverride(dataDir, canonicalId, override) {
  mkdirSync(dataDir, { recursive: true });
  const overridesPath = getOverridesPath(dataDir);
  const current = readJsonCached(overridesPath, null);
  const models = current?.models && typeof current.models === 'object' ? { ...current.models } : {};

  if (override === null || override === undefined) {
    delete models[canonicalId];
  } else {
    models[canonicalId] = sanitizeRateFields(override, canonicalId);
  }

  writeJsonAtomic(overridesPath, { schemaVersion: 1, models }, true);
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

function normalizeObservedSet(observedModelIds) {
  const out = new Set();
  if (!observedModelIds) return out;
  for (const id of observedModelIds) {
    const raw = String(id || '').trim();
    if (!raw) continue;
    const norm = normalizeModelId(raw);
    if (norm && norm !== 'unknown' && !norm.startsWith('model-')) {
      out.add(norm);
    }
    const slashIdx = raw.indexOf('/');
    if (slashIdx !== -1) {
      const stripped = normalizeModelId(raw.slice(slashIdx + 1));
      if (stripped && stripped !== 'unknown' && !stripped.startsWith('model-')) {
        out.add(stripped);
      }
    }
  }
  return out;
}

function buildCanonicalAliasLookup(defaults, overrides, observedSet) {
  const map = new Map();
  const register = (canonical) => {
    if (!canonical) return;
    const low = String(canonical).trim().toLowerCase();
    if (!low) return;
    map.set(low, low);
    const dashed = low.replace(/\./g, '-');
    if (dashed !== low && !map.has(dashed)) map.set(dashed, low);
  };
  for (const [canonical, entry] of Object.entries(defaults?.models || {})) {
    register(canonical);
    for (const a of entry?.aliases || []) {
      const al = String(a || '').trim().toLowerCase();
      if (al) map.set(al, canonical);
    }
  }
  for (const canonical of Object.keys(overrides || {})) register(canonical);
  for (const canonical of observedSet || []) register(canonical);
  for (const [alias, canonical] of Object.entries(ORCHESTRATOR_ALIASES)) {
    map.set(alias, canonical);
  }
  return map;
}

export function isRelevantPricingModel(canonicalId, defaults, overrides, observedSet = null) {
  if (!canonicalId || canonicalId === 'sample_spec' || canonicalId === 'unknown') return false;
  if (defaults?.models?.[canonicalId]) return true;
  if (overrides?.[canonicalId]) return true;
  if (observedSet?.has?.(canonicalId)) return true;
  if (EXCLUDED_NON_CHAT_RE.test(canonicalId)) return false;
  return RELEVANT_CHAT_FAMILY_RE.test(canonicalId);
}

export function listPricingModels(state, nowMs = Date.now(), { observedModelIds = null } = {}) {
  const dateStr = new Date(nowMs).toISOString().slice(0, 10);
  const observedSet = normalizeObservedSet(observedModelIds);
  const allIds = new Set([
    ...Object.keys(state.defaults?.models || {}),
    ...Object.keys(state.overrides || {}),
  ]);
  for (const remoteId of Object.keys(state.remote?.models || {})) {
    if (isRelevantPricingModel(remoteId, state.defaults, state.overrides, observedSet)) {
      allIds.add(remoteId);
    }
  }

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
    remoteTotalCount: state.remote?.remoteTotalCount ?? null,
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

function resolveCanonicalRemoteKey(rawModelPart, aliasLookup) {
  const clean = String(rawModelPart || '').trim().toLowerCase();
  if (!clean || clean === 'sample_spec') return '';
  if (aliasLookup?.has(clean)) return aliasLookup.get(clean);
  const dashed = clean.replace(/\./g, '-');
  if (aliasLookup?.has(dashed)) return aliasLookup.get(dashed);
  // Preserve dots for Gemini & other models (e.g. gemini-2.5-pro); convert dots to hyphens for Claude.
  if (clean.startsWith('claude-')) return dashed;
  return clean;
}

function parseLiteLlmKey(rawKey, info, aliasLookup) {
  const key = String(rawKey || '').trim().toLowerCase();
  if (!key || key === 'sample_spec') return null;

  const provider = String(info?.litellm_provider || '').trim().toLowerCase();
  if (provider && LITELLM_BLOCKED_PROVIDERS.has(provider)) return null;
  if (provider.startsWith('vertex_ai') || provider.startsWith('bedrock') || provider.startsWith('azure')) {
    return null;
  }

  const slashIdx = key.indexOf('/');
  let rank = 3; // Bare direct key has highest priority
  let modelPart = key;
  if (slashIdx !== -1) {
    const prefix = key.slice(0, slashIdx);
    const rest = key.slice(slashIdx + 1);
    if (!LITELLM_DIRECT_PREFIXES.has(prefix) || rest.includes('/')) {
      return null;
    }
    rank = 2;
    modelPart = rest;
  }

  if (OPENROUTER_VARIANT_SUFFIX_RE.test(modelPart)) return null;
  const canonical = resolveCanonicalRemoteKey(modelPart, aliasLookup);
  if (!canonical) return null;
  return { canonical, rank };
}

function parseOpenRouterKey(rawId, aliasLookup) {
  const key = String(rawId || '').trim().toLowerCase();
  if (!key) return null;
  if (OPENROUTER_VARIANT_SUFFIX_RE.test(key)) return null;
  const slashIdx = key.indexOf('/');
  const modelPart = slashIdx !== -1 ? key.slice(slashIdx + 1) : key;
  if (!modelPart || modelPart.includes('/')) return null;
  const canonical = resolveCanonicalRemoteKey(modelPart, aliasLookup);
  if (!canonical) return null;
  return { canonical, rank: 1 };
}

export async function syncRemotePricing(dataDir, { observedModelIds = null, fetchImpl = fetch } = {}) {
  if (inflightSync) return inflightSync;
  inflightSync = (async () => {
    mkdirSync(dataDir, { recursive: true });
    const defaults = loadDefaults();
    const overridesRaw = readJsonCached(getOverridesPath(dataDir), null);
    const overrides = overridesRaw?.models && typeof overridesRaw.models === 'object' ? overridesRaw.models : {};
    const observedSet = normalizeObservedSet(observedModelIds);
    const aliasLookup = buildCanonicalAliasLookup(defaults, overrides, observedSet);

    const syncDateStr = new Date().toISOString().slice(0, 10);
    const merged = {};
    const mergedRanks = {};
    const errors = [];
    let litellmScanned = 0;
    let openrouterScanned = 0;
    let litellmKept = 0;
    let openrouterKept = 0;

    try {
      const resp = await fetchImpl(LITELLM_URL, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`LiteLLM HTTP ${resp.status}`);
      const json = await resp.json();
      for (const [key, info] of Object.entries(json || {})) {
        if (!info || typeof info !== 'object') continue;
        const in1m = parsePositivePerToken(info.input_cost_per_token);
        const out1m = parsePositivePerToken(info.output_cost_per_token);
        if (in1m === null && out1m === null) continue;
        litellmScanned++;

        const parsed = parseLiteLlmKey(key, info, aliasLookup);
        if (!parsed) continue;
        const { canonical, rank } = parsed;
        if (!isRelevantPricingModel(canonical, defaults, overrides, observedSet)) continue;
        if ((mergedRanks[canonical] || 0) > rank) continue;

        const cacheRead = parsePositivePerToken(info.cache_read_input_token_cost);
        const cacheWrite = parsePositivePerToken(info.cache_creation_input_token_cost);
        const inAbove = parsePositivePerToken(info.input_cost_per_token_above_200k_tokens);
        const outAbove = parsePositivePerToken(info.output_cost_per_token_above_200k_tokens);
        const crAbove = parsePositivePerToken(info.cache_read_input_token_cost_above_200k_tokens);

        const isNew = !merged[canonical];
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
        mergedRanks[canonical] = rank;
        if (isNew) litellmKept++;
      }
    } catch (err) {
      errors.push(`LiteLLM: ${err.message}`);
    }

    try {
      const resp = await fetchImpl(OPENROUTER_URL, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}`);
      const json = await resp.json();
      for (const item of json?.data || []) {
        if (!item?.id || !item?.pricing) continue;
        const p = item.pricing;
        const in1m = parsePositivePerToken(p.prompt);
        const out1m = parsePositivePerToken(p.completion);
        if (in1m === null && out1m === null) continue;
        openrouterScanned++;

        const parsed = parseOpenRouterKey(item.id, aliasLookup);
        if (!parsed) continue;
        const { canonical, rank } = parsed;
        if (!isRelevantPricingModel(canonical, defaults, overrides, observedSet)) continue;

        // Prefer LiteLLM direct entry when already present; OpenRouter fills remaining models.
        if (!merged[canonical]) {
          const cacheRead = parsePositivePerToken(p.input_cache_read);
          const cacheWrite = parsePositivePerToken(p.input_cache_write);
          const reasoning = parsePositivePerToken(p.internal_reasoning);
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
          mergedRanks[canonical] = rank;
          openrouterKept++;
        }
      }
    } catch (err) {
      errors.push(`OpenRouter: ${err.message}`);
    }

    const fetchedAt = Date.now();
    const matchedCount = Object.keys(merged).length;
    const remoteTotalCount = litellmScanned + openrouterScanned;

    if (matchedCount > 0) {
      writeJsonAtomic(
        getRemoteCachePath(dataDir),
        {
          fetchedAt,
          remoteTotalCount,
          matchedCount,
          sources: {
            litellmScanned,
            openrouterScanned,
            litellmCount: litellmKept,
            openrouterCount: openrouterKept,
          },
          models: merged,
        },
        false
      );
      return {
        ok: true,
        syncedAt: fetchedAt,
        matchedCount,
        remoteTotalCount,
        error: errors.length > 0 ? errors.join('; ') : undefined,
      };
    }

    return {
      ok: false,
      syncedAt: null,
      matchedCount: 0,
      remoteTotalCount,
      error: errors.join('; ') || 'No remote pricing models fetched',
    };
  })().finally(() => {
    inflightSync = null;
  });

  return inflightSync;
}

export function maybeAutoSync(dataDir, autoSyncEnabled, getObservedModelIds = null) {
  if (!autoSyncEnabled || inflightSync) return;
  const cache = readJsonCached(getRemoteCachePath(dataDir), null);
  const age = cache?.fetchedAt ? Date.now() - cache.fetchedAt : Infinity;
  if (age > REMOTE_TTL_MS) {
    // Lazily query observed models only when a 24h sync is actually due.
    let observedModelIds = null;
    try {
      observedModelIds = typeof getObservedModelIds === 'function' ? getObservedModelIds() : getObservedModelIds;
    } catch {
      observedModelIds = null;
    }
    syncRemotePricing(dataDir, { observedModelIds }).catch(() => {});
  }
}
