/**
 * Global Prompt Cache Observatory (`cache-observatory` module).
 * Analyzes consecutive turn transitions per conversation to detect unexpected 0% misses,
 * boundary cuts, bounce-backs, idle-gap decay curves, and excess API cost penalties.
 */
import { calcMissPenaltyUsd, calculateTurnCost } from './pricing.mjs';
import { buildTurnAccountSql, hasAccountSchema, normalizeAccountIdFilter } from './accounts.mjs';

export const DEFAULT_GAP_BREAKPOINTS_SEC = [10, 60, 300, 600, 3600];
export const ACTIVE_IDLE_THRESHOLD_MS = 300_000; // <= 5m active coding zone
export const OBS_TIME_GRANULARITIES = ['1h', '5h', '1d', '7d'];
const MAX_GAP_BREAKPOINTS = 12;
const MAX_BREAKPOINT_SEC = 24 * 3600;
const MAX_SCATTER_POINTS = 450;
const MAX_TOP_ANOMALIES = 20;
const MAX_TIME_SLICES = {
  '1h': 24,
  '5h': 36,
  '1d': 90,
  '7d': 26,
};
const HOUR_MS = 3600 * 1000;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * 24 * HOUR_MS;

export function sanitizeGapBreakpointsSec(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_GAP_BREAKPOINTS_SEC];
  const uniq = new Set();
  for (const item of raw) {
    const n = Math.round(Number(item));
    if (Number.isFinite(n) && n >= 1 && n <= MAX_BREAKPOINT_SEC) {
      uniq.add(n);
    }
  }
  const sorted = [...uniq].sort((a, b) => a - b).slice(0, MAX_GAP_BREAKPOINTS);
  return sorted.length > 0 ? sorted : [...DEFAULT_GAP_BREAKPOINTS_SEC];
}

export function formatBreakpointSec(sec) {
  const s = Math.max(1, Math.round(Number(sec || 0)));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem === 0 ? `${m}m` : `${m}m${rem}s`;
  }
  const h = Math.floor(s / 3600);
  const remM = Math.round((s % 3600) / 60);
  return remM === 0 ? `${h}h` : `${h}h${remM}m`;
}

function formatGapRangeLabel(aSec, bSec) {
  if (aSec < 60 && bSec < 60) return `${aSec}-${bSec}s`;
  if (aSec < 60 && bSec === 60) return `${aSec}-60s`;
  if (aSec >= 60 && aSec < 3600 && aSec % 60 === 0 && bSec < 3600 && bSec % 60 === 0) {
    return `${aSec / 60}-${bSec / 60}m`;
  }
  if (aSec >= 60 && aSec < 3600 && aSec % 60 === 0 && bSec === 3600) {
    return `${aSec / 60}-60m`;
  }
  if (aSec >= 3600 && aSec % 3600 === 0 && bSec >= 3600 && bSec % 3600 === 0) {
    return `${aSec / 3600}-${bSec / 3600}h`;
  }
  return `${formatBreakpointSec(aSec)}-${formatBreakpointSec(bSec)}`;
}

export function buildGapBucketSpec(rawBreakpointsSec) {
  const breakpointsSec = sanitizeGapBreakpointsSec(rawBreakpointsSec);
  const keys = [];
  const thresholdsMs = breakpointsSec.map((s) => s * 1000);
  keys.push(`<=${formatBreakpointSec(breakpointsSec[0])}`);
  for (let i = 1; i < breakpointsSec.length; i++) {
    keys.push(formatGapRangeLabel(breakpointsSec[i - 1], breakpointsSec[i]));
  }
  keys.push(`>${formatBreakpointSec(breakpointsSec[breakpointsSec.length - 1])}`);
  return { breakpointsSec, keys, thresholdsMs };
}

const DEFAULT_SPEC = buildGapBucketSpec(DEFAULT_GAP_BREAKPOINTS_SEC);
export const GAP_BUCKETS = DEFAULT_SPEC.keys;

export function classifyGapBucket(idleGapMs, spec = DEFAULT_SPEC) {
  if (idleGapMs === null || idleGapMs === undefined || !Number.isFinite(idleGapMs)) return null;
  const thresholds = spec?.thresholdsMs || DEFAULT_SPEC.thresholdsMs;
  const keys = spec?.keys || DEFAULT_SPEC.keys;
  for (let i = 0; i < thresholds.length; i++) {
    if (idleGapMs <= thresholds[i]) return keys[i];
  }
  return keys[keys.length - 1];
}

function formatDurationShort(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  if (min < 60) return remSec > 0 ? `${min}m${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
}

function formatPct(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatCompactTokens(n) {
  const v = Number(n || 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function downsampleEvenly(items, limit) {
  if (limit <= 0) return [];
  if (items.length <= limit) return items;
  if (limit === 1) return [items[items.length - 1]];
  const out = [];
  const step = (items.length - 1) / (limit - 1);
  for (let i = 0; i < limit; i++) {
    out.push(items[Math.round(i * step)]);
  }
  return out;
}

export function buildIssueMarkdown({ summary, matrix, topAnomalies, gapBuckets = GAP_BUCKETS }) {
  const lines = [];
  lines.push('### Prompt Cache Diagnostics (AGY Lens)');
  lines.push('');
  lines.push(
    `- **Follow-up turns**: ${summary.followUpTurns} (weighted hit ratio: **${formatPct(summary.weightedFollowUpHitRatio)}**)`
  );
  lines.push(
    `- **Unexpected 0% misses**: ${summary.unexpectedFullMisses} (${summary.bounceBackCount} bounce-backs) | **Boundary cuts**: ${summary.boundaryCuts}`
  );
  lines.push(
    `- **Excluded transitions**: ${summary.modelSwitchTurns} model switches, ${summary.compactedTurns} compactions`
  );
  lines.push(
    `- **Estimated miss penalty**: $${summary.missPenaltyUsd.toFixed(2)} (${formatCompactTokens(summary.wastedTokens)} uncached prompt tokens)`
  );
  lines.push('');

  if (matrix.length > 0) {
    lines.push('#### Model × Idle-Gap Hit Rate Matrix');
    lines.push('');
    lines.push(`| Model | Follow-ups | Hit % | Misses | ${gapBuckets.join(' | ')} |`);
    lines.push(`| --- | ---: | ---: | ---: | ${gapBuckets.map(() => '---:').join(' | ')} |`);
    for (const row of matrix) {
      const cells = row.buckets.map((b) =>
        b.total > 0 && b.hitRate !== null ? `${Math.round(b.hitRate * 100)}% (${b.hits}/${b.total})` : '—'
      );
      lines.push(
        `| ${row.displayName || row.canonicalId} | ${row.followUpTurns} | ${formatPct(row.weightedHitRatio)} | ${row.unexpectedFullMisses + row.boundaryCuts} | ${cells.join(' | ')} |`
      );
    }
    lines.push('');
  }

  const top5 = topAnomalies.slice(0, 5);
  if (top5.length > 0) {
    lines.push('#### Top 5 Cache Anomalies');
    lines.push('');
    lines.push('| Model | Kind | Before | Miss | After | Idle Gap | Start Gap | Bounce-Back | Request ID |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | :---: | --- |');
    for (const a of top5) {
      const kindLabel = a.kind === 'boundary_cut' ? 'boundary_cut' : '0% miss';
      const beforeStr = `${formatPct(a.before?.hitRatio)} (${formatCompactTokens(a.before?.cacheRead)})`;
      const missStr = `${formatPct(a.miss?.hitRatio)} (${formatCompactTokens(a.miss?.totalIn)})`;
      const afterStr = a.after
        ? `${formatPct(a.after.hitRatio)} (${formatCompactTokens(a.after.cacheRead)})`
        : '—';
      const reqId = a.providerRequestId ? `\`${a.providerRequestId}\`` : '—';
      lines.push(
        `| ${a.displayName || a.modelId} | ${kindLabel} | ${beforeStr} | ${missStr} | ${afterStr} | ${formatDurationShort(a.idleGapMs)} | ${formatDurationShort(a.startGapMs)} | ${a.bounceBack ? 'Yes' : 'No'} | ${reqId} |`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function getSliceBounds(ts, granularity, anchorToMs) {
  if (granularity === '1h') {
    const d = new Date(ts);
    // Align strictly to the UTC instant of the start of ts's local hour so DST
    // fall-back repeated local hours never collide into the same bucket.
    const offsetInHourMs = d.getMinutes() * 60000 + d.getSeconds() * 1000 + d.getMilliseconds();
    const startMs = ts - offsetInHourMs;
    const endMs = startMs + HOUR_MS;
    return { key: `1h:${startMs}`, startMs, endMs };
  }
  if (granularity === '1d') {
    const d = new Date(ts);
    const startMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
    const nextDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return { key, startMs, endMs: nextDay };
  }
  const spanMs = granularity === '7d' ? SEVEN_DAYS_MS : FIVE_HOURS_MS;
  const diff = anchorToMs - ts;
  const slot = diff >= 0 ? Math.floor(diff / spanMs) : -Math.ceil(-diff / spanMs);
  const endMs = anchorToMs - slot * spanMs;
  const startMs = endMs - spanMs;
  return { key: `${granularity}:${startMs}`, startMs, endMs };
}

function createSliceStatsAcc() {
  return {
    turns: 0,
    hits: 0,
    cacheReadSum: 0,
    totalInSum: 0,
    unexpMisses: 0,
    boundaryCuts: 0,
    bounceBacks: 0,
    wastedTokens: 0,
    missPenaltyUsd: 0,
    activeTurns: 0,
    activeHits: 0,
    activeCacheReadSum: 0,
    activeTotalInSum: 0,
    activeUnexpMisses: 0,
    activeBoundaryCuts: 0,
    buckets: new Map(),
  };
}

function recordEventIntoSliceAcc(acc, ev) {
  acc.turns++;
  if (ev.kind === 'hit') acc.hits++;
  acc.cacheReadSum += ev.cacheRead;
  acc.totalInSum += ev.totalIn;
  if (ev.kind === 'unexpected_full_miss') acc.unexpMisses++;
  if (ev.kind === 'boundary_cut') acc.boundaryCuts++;
  if (ev.bounceBack) acc.bounceBacks++;
  acc.wastedTokens += ev.wastedTokens;
  acc.missPenaltyUsd += ev.penaltyUsd;

  if (ev.idleGapMs !== null && ev.idleGapMs <= ACTIVE_IDLE_THRESHOLD_MS) {
    acc.activeTurns++;
    if (ev.kind === 'hit') acc.activeHits++;
    acc.activeCacheReadSum += ev.cacheRead;
    acc.activeTotalInSum += ev.totalIn;
    if (ev.kind === 'unexpected_full_miss') acc.activeUnexpMisses++;
    if (ev.kind === 'boundary_cut') acc.activeBoundaryCuts++;
  }

  if (ev.bucketKey) {
    let b = acc.buckets.get(ev.bucketKey);
    if (!b) {
      b = {
        total: 0,
        hits: 0,
        cacheReadSum: 0,
        totalInSum: 0,
        unexpMisses: 0,
        boundaryCuts: 0,
        missPenaltyUsd: 0,
      };
      acc.buckets.set(ev.bucketKey, b);
    }
    b.total++;
    if (ev.kind === 'hit') b.hits++;
    b.cacheReadSum += ev.cacheRead;
    b.totalInSum += ev.totalIn;
    if (ev.kind === 'unexpected_full_miss') b.unexpMisses++;
    if (ev.kind === 'boundary_cut') b.boundaryCuts++;
    b.missPenaltyUsd += ev.penaltyUsd;
  }
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function finalizeSliceStats(acc, bucketKeys) {
  const buckets = {};
  for (const k of bucketKeys) {
    const b = acc.buckets.get(k);
    if (!b || b.total === 0) continue;
    buckets[k] = {
      total: b.total,
      hits: b.hits,
      hitRate: round4(b.hits / b.total),
      weightedHitRatio: b.totalInSum > 0 ? round4(b.cacheReadSum / b.totalInSum) : null,
      cacheReadSum: b.cacheReadSum,
      totalInSum: b.totalInSum,
      unexpMisses: b.unexpMisses,
      boundaryCuts: b.boundaryCuts,
      missPenaltyUsd: round4(b.missPenaltyUsd),
    };
  }
  return {
    turns: acc.turns,
    hits: acc.hits,
    hitRate: acc.turns > 0 ? round4(acc.hits / acc.turns) : null,
    weightedHitRatio: acc.totalInSum > 0 ? round4(acc.cacheReadSum / acc.totalInSum) : null,
    cacheReadSum: acc.cacheReadSum,
    totalInSum: acc.totalInSum,
    unexpMisses: acc.unexpMisses,
    boundaryCuts: acc.boundaryCuts,
    bounceBacks: acc.bounceBacks,
    wastedTokens: acc.wastedTokens,
    missPenaltyUsd: round4(acc.missPenaltyUsd),
    activeTurns: acc.activeTurns,
    activeHits: acc.activeHits,
    activeHitRate: acc.activeTurns > 0 ? round4(acc.activeHits / acc.activeTurns) : null,
    activeWeightedHitRatio:
      acc.activeTotalInSum > 0 ? round4(acc.activeCacheReadSum / acc.activeTotalInSum) : null,
    activeCacheReadSum: acc.activeCacheReadSum,
    activeTotalInSum: acc.activeTotalInSum,
    activeUnexpMisses: acc.activeUnexpMisses,
    activeBoundaryCuts: acc.activeBoundaryCuts,
    buckets,
  };
}

export function buildObservatoryTimeSeries(events, { toMs = Date.now(), bucketKeys = GAP_BUCKETS } = {}) {
  const anchorToMs = Number.isFinite(Number(toMs)) && Number(toMs) > 0 ? Number(toMs) : Date.now();
  const granularities = {};
  const modelNames = {};

  for (const ev of events || []) {
    if (ev.modelId && !modelNames[ev.modelId]) {
      modelNames[ev.modelId] = ev.displayName || ev.modelId;
    }
  }

  for (const gran of OBS_TIME_GRANULARITIES) {
    const sliceMap = new Map();
    for (const ev of events || []) {
      if (!Number.isFinite(ev.ts) || ev.ts <= 0) continue;
      const bounds = getSliceBounds(ev.ts, gran, anchorToMs);
      let slice = sliceMap.get(bounds.key);
      if (!slice) {
        slice = {
          key: bounds.key,
          startMs: bounds.startMs,
          endMs: bounds.endMs,
          allAcc: createSliceStatsAcc(),
          modelAccs: new Map(),
        };
        sliceMap.set(bounds.key, slice);
      }
      recordEventIntoSliceAcc(slice.allAcc, ev);
      let mAcc = slice.modelAccs.get(ev.modelId);
      if (!mAcc) {
        mAcc = createSliceStatsAcc();
        slice.modelAccs.set(ev.modelId, mAcc);
      }
      recordEventIntoSliceAcc(mAcc, ev);
    }

    const cap = MAX_TIME_SLICES[gran] || 36;
    const sorted = [...sliceMap.values()].sort((a, b) => a.startMs - b.startMs);
    const trimmed = sorted.length > cap ? sorted.slice(sorted.length - cap) : sorted;

    granularities[gran] = trimmed.map((sl) => {
      const byModel = {};
      for (const [mId, mAcc] of sl.modelAccs.entries()) {
        byModel[mId] = finalizeSliceStats(mAcc, bucketKeys);
      }
      return {
        key: sl.key,
        startMs: sl.startMs,
        endMs: sl.endMs,
        all: finalizeSliceStats(sl.allAcc, bucketKeys),
        byModel,
      };
    });
  }

  return {
    activeThresholdSec: Math.round(ACTIVE_IDLE_THRESHOLD_MS / 1000),
    anchorToMs,
    modelNames,
    granularities,
  };
}

function escMdCell(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
}

export function buildCompareMarkdown({ periods = [], gapBuckets = GAP_BUCKETS, modelLabel = 'All Models', metric = 'hitRate' } = {}) {
  const metricTitle = metric === 'weightedHitRatio' ? 'Token Hit %' : 'Keep Rate %';
  const lines = [];
  lines.push(`### Prompt Cache Period Comparison (AGY Lens · ${escMdCell(modelLabel)})`);
  lines.push('');
  lines.push(`- **Bucket metric**: ${metricTitle} (excluding Turn-0 cold starts, model switches & compactions)`);
  lines.push('');
  if (periods.length === 0) return lines.join('\n');

  lines.push(`| Period | Turns | <=5m Hit % | <=5m 0%-Miss | ${gapBuckets.map(escMdCell).join(' | ')} |`);
  lines.push(`| --- | ---: | ---: | ---: | ${gapBuckets.map(() => '---:').join(' | ')} |`);

  for (const p of periods) {
    const st = p.stats || {};
    const turns = st.turns || 0;
    const actTurns = st.activeTurns || 0;
    const actHit = actTurns > 0 && st.activeWeightedHitRatio !== null ? formatPct(st.activeWeightedHitRatio) : '—';
    const actMiss = actTurns > 0
      ? `${((100 * (st.activeUnexpMisses || 0)) / actTurns).toFixed(2)}% (${st.activeUnexpMisses || 0}/${actTurns})`
      : '—';
    const cells = gapBuckets.map((bk) => {
      const b = st.buckets?.[bk];
      if (!b || !b.total) return '—';
      const ratio = metric === 'weightedHitRatio' ? b.weightedHitRatio : b.hitRate;
      if (ratio === null || ratio === undefined) return '—';
      return `${Math.round(ratio * 100)}% (${b.hits}/${b.total})`;
    });
    lines.push(`| ${escMdCell(p.label)} | ${turns} | ${actHit} | ${actMiss} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function emptyObservatory(spec = DEFAULT_SPEC, toMs = Date.now()) {
  const summary = {
    followUpTurns: 0,
    weightedFollowUpHitRatio: 0,
    unexpectedFullMisses: 0,
    bounceBackCount: 0,
    boundaryCuts: 0,
    modelSwitchTurns: 0,
    accountSwitchTurns: 0,
    compactedTurns: 0,
    wastedTokens: 0,
    missPenaltyUsd: 0,
  };
  return {
    summary,
    gapBreakpointsSec: [...spec.breakpointsSec],
    gapBuckets: [...spec.keys],
    matrix: [],
    scatterPoints: [],
    topAnomalies: [],
    timeSeries: buildObservatoryTimeSeries([], { toMs, bucketKeys: spec.keys }),
    issueMarkdown: buildIssueMarkdown({ summary, matrix: [], topAnomalies: [], gapBuckets: spec.keys }),
  };
}

function queryConversationTurns(
  cacheDb,
  { sources, fromMs, toMs, workspace = '', accountId = 'all' }
) {
  if (!sources || sources.length === 0) return [];
  const placeholders = sources.map(() => '?').join(',');
  const accFilter = normalizeAccountIdFilter(accountId);
  const withAcc = hasAccountSchema(cacheDb);
  const accSql = withAcc ? buildTurnAccountSql('t') : null;

  let activeConvSql = `
    SELECT DISTINCT t.conversation_id
    FROM turns t
    LEFT JOIN indexed_files f ON f.conversation_id = t.conversation_id AND f.source = t.source
    ${withAcc && accFilter !== 'all' ? accSql.joinSql : ''}
    WHERE t.source IN (${placeholders})
      AND t.completed_at_ms >= ?
      AND t.completed_at_ms <= ?
  `;
  const activeParams = [...sources, fromMs, toMs];
  if (workspace) {
    activeConvSql += ' AND f.workspace = ?';
    activeParams.push(workspace);
  }
  if (withAcc && accFilter !== 'all') {
    activeConvSql += ` AND (${accSql.exprSql}) = ?`;
    activeParams.push(accFilter);
  }

  const sql = `
    SELECT
      t.conversation_id, t.step_idx, t.source,
      t.created_at_ms, t.completed_at_ms,
      t.canonical_model_id, t.display_name, t.pool,
      t.uncached_in, t.cache_read, t.cache_create,
      t.thinking_out, t.visible_out, t.total_out,
      t.provider_request_id
      ${withAcc ? `, (${accSql.exprSql}) AS account_id` : ''}
    FROM turns t
    ${withAcc ? accSql.joinSql : ''}
    WHERE t.source IN (${placeholders})
      AND t.completed_at_ms <= ?
      AND t.conversation_id IN (${activeConvSql})
    ORDER BY t.conversation_id ASC, t.step_idx ASC
  `;
  return cacheDb.prepare(sql).all(...sources, toMs, ...activeParams);
}

/**
 * Analyze turns grouped by conversation and produce the Cache Observatory payload.
 * Pure aggregation helper `analyzeTurnsForObservatory` is exported for reuse by demo_server.
 */
export function analyzeTurnsForObservatory(
  rows,
  pricingState,
  { fromMs = 0, toMs = Date.now(), gapBreakpointsSec = null, accountId = 'all' } = {}
) {
  const gapSpec = buildGapBucketSpec(gapBreakpointsSec);
  const bucketKeys = gapSpec.keys;
  const accFilter = normalizeAccountIdFilter(accountId);
  if (!rows || rows.length === 0) {
    return emptyObservatory(gapSpec, toMs);
  }

  // Group turns by conversation_id (preserving step_idx ASC order).
  const convMap = new Map();
  for (const r of rows) {
    let list = convMap.get(r.conversation_id);
    if (!list) {
      list = [];
      convMap.set(r.conversation_id, list);
    }
    list.push(r);
  }

  let followUpTurns = 0;
  let totalFollowUpCacheRead = 0;
  let totalFollowUpPromptIn = 0;
  let unexpectedFullMisses = 0;
  let bounceBackCount = 0;
  let boundaryCuts = 0;
  let modelSwitchTurns = 0;
  let accountSwitchTurns = 0;
  let compactedTurns = 0;
  let totalWastedTokens = 0;
  let totalMissPenaltyUsd = 0;

  const modelStats = new Map();
  const anomalyScatter = [];
  const normalScatter = [];
  const allAnomalies = [];
  const timeEvents = [];

  for (const convTurns of convMap.values()) {
    convTurns.sort((a, b) => a.step_idx - b.step_idx);

    // Index 0 is always 'cold_start' and excluded from follow-up stats.
    for (let i = 1; i < convTurns.length; i++) {
      const prev = convTurns[i - 1];
      const cur = convTurns[i];
      const next = i + 1 < convTurns.length ? convTurns[i + 1] : null;

      const curCompleted = cur.completed_at_ms || cur.created_at_ms || 0;
      if (curCompleted < fromMs || curCompleted > toMs) continue;
      if (accFilter !== 'all' && cur.account_id && cur.account_id !== accFilter) continue;

      const accountSwitched = Boolean(
        prev.account_id && cur.account_id && prev.account_id !== cur.account_id
      );
      if (accountSwitched) {
        accountSwitchTurns++;
        continue;
      }

      const idleGapMs =
        cur.created_at_ms && prev.completed_at_ms
          ? Math.max(0, cur.created_at_ms - prev.completed_at_ms)
          : null;
      const startGapMs =
        cur.created_at_ms && prev.created_at_ms
          ? Math.max(0, cur.created_at_ms - prev.created_at_ms)
          : null;

      const prevUncached = prev.uncached_in || 0;
      const prevCacheRead = prev.cache_read || 0;
      const prevCacheCreate = prev.cache_create || 0;
      const curUncached = cur.uncached_in || 0;
      const curCacheRead = cur.cache_read || 0;
      const curCacheCreate = cur.cache_create || 0;

      const prevTotalIn = prevUncached + prevCacheRead + prevCacheCreate;
      const curTotalIn = curUncached + curCacheRead + curCacheCreate;
      const prevHit = prevTotalIn > 0 ? prevCacheRead / prevTotalIn : 0;
      const curHit = curTotalIn > 0 ? curCacheRead / curTotalIn : 0;

      const modelSwitched = Boolean(
        prev.canonical_model_id &&
          cur.canonical_model_id &&
          prev.canonical_model_id !== cur.canonical_model_id
      );
      const compacted = prevTotalIn > 20000 && curTotalIn < prevTotalIn * 0.65;

      let kind;
      if (modelSwitched) {
        kind = 'model_switch';
      } else if (compacted) {
        kind = 'compacted';
      } else if (!modelSwitched && !compacted && prevHit >= 0.7 && curCacheRead === 0 && curTotalIn > 0) {
        kind = 'unexpected_full_miss';
      } else if (
        !modelSwitched &&
        !compacted &&
        prevHit >= 0.7 &&
        curHit < 0.4 &&
        curCacheRead >= 5000 &&
        curCacheRead <= 28000
      ) {
        kind = 'boundary_cut';
      } else if (curHit >= 0.5) {
        kind = 'hit';
      } else {
        kind = 'low_hit';
      }

      if (kind === 'model_switch') {
        modelSwitchTurns++;
        continue;
      }
      if (kind === 'compacted') {
        compactedTurns++;
        continue;
      }

      const nextTotalIn = next
        ? (next.uncached_in || 0) + (next.cache_read || 0) + (next.cache_create || 0)
        : 0;
      const nextHit = next && nextTotalIn > 0 ? (next.cache_read || 0) / nextTotalIn : null;
      const nextSameModel = Boolean(
        next &&
          cur.canonical_model_id &&
          next.canonical_model_id &&
          cur.canonical_model_id === next.canonical_model_id
      );
      const nextSameAccount = !(
        next &&
        cur.account_id &&
        next.account_id &&
        cur.account_id !== next.account_id
      );
      const nextCompacted = Boolean(next && curTotalIn > 20000 && nextTotalIn < curTotalIn * 0.65);
      const bounceBack = Boolean(
        (kind === 'unexpected_full_miss' || kind === 'boundary_cut') &&
          next &&
          nextSameModel &&
          nextSameAccount &&
          !nextCompacted &&
          nextHit !== null &&
          nextHit >= 0.7
      );

      let wastedTokens = 0;
      let penaltyUsd = 0;
      if (kind === 'unexpected_full_miss') {
        wastedTokens = Math.min(curUncached, prevTotalIn);
        penaltyUsd = calcMissPenaltyUsd(cur, wastedTokens, pricingState);
        unexpectedFullMisses++;
      } else if (kind === 'boundary_cut') {
        wastedTokens = Math.max(0, Math.min(curUncached, prevCacheRead - curCacheRead));
        penaltyUsd = calcMissPenaltyUsd(cur, wastedTokens, pricingState);
        boundaryCuts++;
      }

      const turnCost = pricingState ? calculateTurnCost(cur, pricingState) : null;
      const costUsd = turnCost && !turnCost.unpriced ? turnCost.costUsd : 0;
      const cacheSavedUsd = turnCost && !turnCost.unpriced ? turnCost.cacheSavedUsd : 0;

      if (bounceBack) bounceBackCount++;
      totalWastedTokens += wastedTokens;
      totalMissPenaltyUsd += penaltyUsd;

      followUpTurns++;
      totalFollowUpCacheRead += curCacheRead;
      totalFollowUpPromptIn += curTotalIn;

      const modelId = cur.canonical_model_id || 'unknown';
      const displayName = cur.display_name || modelId;
      let m = modelStats.get(modelId);
      if (!m) {
        const bucketMap = new Map();
        for (const key of bucketKeys) {
          bucketMap.set(key, {
            key,
            total: 0,
            hits: 0,
            misses: 0,
            sumHitRatio: 0,
            cacheReadSum: 0,
            totalInSum: 0,
            costUsd: 0,
            cacheSavedUsd: 0,
            unexpectedFullMisses: 0,
            boundaryCuts: 0,
            bounceBacks: 0,
            wastedTokens: 0,
            missPenaltyUsd: 0,
          });
        }
        m = {
          canonicalId: modelId,
          displayName,
          followUpTurns: 0,
          hits: 0,
          misses: 0,
          sumHitRatio: 0,
          cacheReadSum: 0,
          totalInSum: 0,
          costUsd: 0,
          cacheSavedUsd: 0,
          unexpectedFullMisses: 0,
          boundaryCuts: 0,
          bounceBacks: 0,
          wastedTokens: 0,
          missPenaltyUsd: 0,
          unbucketedTurns: 0,
          bucketMap,
        };
        modelStats.set(modelId, m);
      }

      m.followUpTurns++;
      if (kind === 'hit') m.hits++;
      else m.misses++;
      m.sumHitRatio += curHit;
      m.cacheReadSum += curCacheRead;
      m.totalInSum += curTotalIn;
      m.costUsd += costUsd;
      m.cacheSavedUsd += cacheSavedUsd;
      if (kind === 'unexpected_full_miss') m.unexpectedFullMisses++;
      if (kind === 'boundary_cut') m.boundaryCuts++;
      if (bounceBack) m.bounceBacks++;
      m.wastedTokens += wastedTokens;
      m.missPenaltyUsd += penaltyUsd;

      const bucketKey = classifyGapBucket(idleGapMs, gapSpec);
      if (bucketKey) {
        const b = m.bucketMap.get(bucketKey);
        b.total++;
        if (kind === 'hit') b.hits++;
        else b.misses++;
        b.sumHitRatio += curHit;
        b.cacheReadSum += curCacheRead;
        b.totalInSum += curTotalIn;
        b.costUsd += costUsd;
        b.cacheSavedUsd += cacheSavedUsd;
        if (kind === 'unexpected_full_miss') b.unexpectedFullMisses++;
        if (kind === 'boundary_cut') b.boundaryCuts++;
        if (bounceBack) b.bounceBacks++;
        b.wastedTokens += wastedTokens;
        b.missPenaltyUsd += penaltyUsd;
      } else {
        m.unbucketedTurns++;
      }

      timeEvents.push({
        ts: curCompleted,
        modelId,
        displayName,
        idleGapMs,
        bucketKey,
        kind,
        bounceBack,
        cacheRead: curCacheRead,
        totalIn: curTotalIn,
        costUsd,
        wastedTokens,
        penaltyUsd,
      });

      if (idleGapMs !== null) {
        const pt = {
          modelId,
          displayName,
          idleGapMs,
          startGapMs,
          hitRatio: curHit,
          kind,
          bounceBack,
          totalIn: curTotalIn,
          cacheRead: curCacheRead,
          prevHitRatio: prevHit,
          nextHitRatio: nextHit,
          wastedTokens,
          penaltyUsd,
          completedAt: curCompleted,
        };
        if (kind === 'unexpected_full_miss' || kind === 'boundary_cut') {
          anomalyScatter.push(pt);
        } else {
          normalScatter.push(pt);
        }
      }

      if (kind === 'unexpected_full_miss' || kind === 'boundary_cut') {
        allAnomalies.push({
          modelId,
          displayName,
          kind,
          bounceBack,
          idleGapMs,
          startGapMs,
          before: { cacheRead: prevCacheRead, totalIn: prevTotalIn, hitRatio: prevHit },
          miss: { cacheRead: curCacheRead, totalIn: curTotalIn, hitRatio: curHit },
          after: next
            ? {
                cacheRead: next.cache_read || 0,
                totalIn: nextTotalIn,
                hitRatio: nextHit ?? 0,
              }
            : null,
          wastedTokens,
          penaltyUsd,
          providerRequestId: cur.provider_request_id || '',
          completedAt: curCompleted,
          stepIdx: cur.step_idx,
        });
      }
    }
  }

  const matrix = [...modelStats.values()]
    .map((m) => ({
      canonicalId: m.canonicalId,
      displayName: m.displayName,
      followUpTurns: m.followUpTurns,
      hits: m.hits,
      misses: m.misses,
      hitRate: m.followUpTurns > 0 ? m.hits / m.followUpTurns : null,
      weightedHitRatio: m.totalInSum > 0 ? m.cacheReadSum / m.totalInSum : 0,
      avgHitRatio: m.followUpTurns > 0 ? m.sumHitRatio / m.followUpTurns : null,
      cacheReadSum: m.cacheReadSum,
      totalInSum: m.totalInSum,
      avgContextTokens: m.followUpTurns > 0 ? m.totalInSum / m.followUpTurns : 0,
      costUsd: m.costUsd,
      avgCostUsd: m.followUpTurns > 0 ? m.costUsd / m.followUpTurns : 0,
      cacheSavedUsd: m.cacheSavedUsd,
      unexpectedFullMisses: m.unexpectedFullMisses,
      boundaryCuts: m.boundaryCuts,
      bounceBacks: m.bounceBacks,
      wastedTokens: m.wastedTokens,
      missPenaltyUsd: m.missPenaltyUsd,
      avgMissPenaltyUsd: m.followUpTurns > 0 ? m.missPenaltyUsd / m.followUpTurns : 0,
      unbucketedTurns: m.unbucketedTurns,
      buckets: bucketKeys.map((key) => {
        const b = m.bucketMap.get(key);
        return {
          key,
          total: b.total,
          hits: b.hits,
          misses: b.misses,
          hitRate: b.total > 0 ? b.hits / b.total : null,
          weightedHitRatio: b.totalInSum > 0 ? b.cacheReadSum / b.totalInSum : null,
          avgHitRatio: b.total > 0 ? b.sumHitRatio / b.total : null,
          cacheReadSum: b.cacheReadSum,
          totalInSum: b.totalInSum,
          avgContextTokens: b.total > 0 ? b.totalInSum / b.total : 0,
          costUsd: b.costUsd,
          avgCostUsd: b.total > 0 ? b.costUsd / b.total : 0,
          cacheSavedUsd: b.cacheSavedUsd,
          unexpectedFullMisses: b.unexpectedFullMisses,
          boundaryCuts: b.boundaryCuts,
          bounceBacks: b.bounceBacks,
          wastedTokens: b.wastedTokens,
          missPenaltyUsd: b.missPenaltyUsd,
          avgMissPenaltyUsd: b.total > 0 ? b.missPenaltyUsd / b.total : 0,
        };
      }),
    }))
    .sort((a, b) => b.followUpTurns - a.followUpTurns || b.missPenaltyUsd - a.missPenaltyUsd);

  const keptAnomalies =
    anomalyScatter.length <= MAX_SCATTER_POINTS
      ? anomalyScatter
      : [...anomalyScatter]
          .sort((a, b) => b.penaltyUsd - a.penaltyUsd || b.completedAt - a.completedAt)
          .slice(0, MAX_SCATTER_POINTS);
  const normalBudget = Math.max(0, MAX_SCATTER_POINTS - keptAnomalies.length);
  const scatterPoints = [...keptAnomalies, ...downsampleEvenly(normalScatter, normalBudget)].sort(
    (a, b) => a.idleGapMs - b.idleGapMs
  );

  const topAnomalies = allAnomalies
    .sort(
      (a, b) =>
        b.penaltyUsd - a.penaltyUsd ||
        b.wastedTokens - a.wastedTokens ||
        b.completedAt - a.completedAt
    )
    .slice(0, MAX_TOP_ANOMALIES);

  const summary = {
    followUpTurns,
    weightedFollowUpHitRatio:
      totalFollowUpPromptIn > 0 ? totalFollowUpCacheRead / totalFollowUpPromptIn : 0,
    unexpectedFullMisses,
    bounceBackCount,
    boundaryCuts,
    modelSwitchTurns,
    accountSwitchTurns,
    compactedTurns,
    wastedTokens: totalWastedTokens,
    missPenaltyUsd: totalMissPenaltyUsd,
  };

  const timeSeries = buildObservatoryTimeSeries(timeEvents, { toMs, bucketKeys });

  return {
    summary,
    gapBreakpointsSec: [...gapSpec.breakpointsSec],
    gapBuckets: [...bucketKeys],
    matrix,
    scatterPoints,
    topAnomalies,
    timeSeries,
    issueMarkdown: buildIssueMarkdown({ summary, matrix, topAnomalies, gapBuckets: bucketKeys }),
  };
}

export function computeCacheObservatory(
  cacheDb,
  pricingState,
  {
    sources = ['desktop', 'cli'],
    fromMs = 0,
    toMs = Date.now(),
    workspace = '',
    gapBreakpointsSec = null,
    accountId = 'all',
  } = {}
) {
  const rows = queryConversationTurns(cacheDb, { sources, fromMs, toMs, workspace, accountId });
  return analyzeTurnsForObservatory(rows, pricingState, {
    fromMs,
    toMs,
    gapBreakpointsSec,
    accountId,
  });
}
