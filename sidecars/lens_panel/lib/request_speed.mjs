/**
 * Session Cache Freshness Inference + Request Log & Speed Analytics (`request-speed` module).
 *
 * Design guarantees:
 * - Strictly local & read-only against AGY Lens's own telemetry_cache.db.
 * - Pure API-equivalent cost via `calculateTurnCost()` (NEVER multiplied by quota calibration factors).
 * - Progressive 5h-step lookback (`5h -> 10h -> 15h -> ... -> 168h`) for session cache freshness until >= 50 follow-up turns.
 * - Orthogonal TPS metrics:
 *     - Timing dimension: Decode TPS (`total_out / gen_s`) AND End-to-End TPS (`total_out / total_s`), both reported.
 *     - Aggregation dimension: Token-weighted (`sum(out) / sum(s)`) AND Per-request Median (P50), both computed cleanly.
 */
import { calculateTurnCost } from './pricing.mjs';
import { buildTurnAccountSql, hasAccountSchema, normalizeAccountIdFilter } from './accounts.mjs';
import {
  DEFAULT_GAP_BREAKPOINTS_SEC,
  buildGapBucketSpec,
  classifyGapBucket,
} from './cache_observatory.mjs';

export const MIN_TPS_DURATION_MS = 50; // Guard against 1-chunk <50ms gen_ms outliers blowing up per-turn TPS
export const SLOW_TTFT_THRESHOLD_MS = 15_000;
export const FRESHNESS_DEFAULT_MIN_SAMPLES = 50;
export const FRESHNESS_STEP_HOURS = 5;
export const FRESHNESS_MAX_HOURS = 168; // 7d cap

const HOUR_MS = 3600 * 1000;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;

const MAX_PERIOD_SLICES = {
  '1h': 24,
  '5h': 36,
  '1d': 90,
  '7d': 26,
};

function percentileSorted(sorted, p) {
  if (!sorted || sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeTurnTotalMs(t) {
  if (
    t.completed_at_ms != null &&
    t.created_at_ms != null &&
    t.completed_at_ms > 0 &&
    t.created_at_ms > 0 &&
    t.completed_at_ms >= t.created_at_ms
  ) {
    return t.completed_at_ms - t.created_at_ms;
  }
  const ttft = t.ttft_ms != null && t.ttft_ms >= 0 ? Number(t.ttft_ms) : 0;
  const gen = t.gen_ms != null && t.gen_ms >= 0 ? Number(t.gen_ms) : 0;
  return ttft + gen > 0 ? ttft + gen : null;
}

export function formatRequestRow(t, pricingState) {
  const cost = calculateTurnCost(t, pricingState);
  const uncachedIn = Number(t.uncached_in || 0);
  const cacheRead = Number(t.cache_read || 0);
  const cacheCreate = Number(t.cache_create || 0);
  const inputTotal = uncachedIn + cacheRead + cacheCreate;
  const thinkingOut = Number(t.thinking_out || 0);
  const visibleOut = Number(t.visible_out || 0);
  const totalOut = Number(t.total_out || 0);
  const totalTokens = inputTotal + totalOut;
  const hitRatio = inputTotal > 0 ? cacheRead / inputTotal : 0;
  const cold = cacheRead === 0 && inputTotal > 0;

  const ttftMs = t.ttft_ms != null && Number.isFinite(Number(t.ttft_ms)) && Number(t.ttft_ms) >= 0
    ? Math.round(Number(t.ttft_ms))
    : null;
  const genMs = t.gen_ms != null && Number.isFinite(Number(t.gen_ms)) && Number(t.gen_ms) >= 0
    ? Math.round(Number(t.gen_ms))
    : null;
  const totalMs = computeTurnTotalMs(t);

  const lowConfGen = Boolean(genMs !== null && genMs < MIN_TPS_DURATION_MS && totalOut > 0);
  const decodeTps =
    genMs !== null && genMs >= MIN_TPS_DURATION_MS && totalOut > 0
      ? (totalOut * 1000) / genMs
      : null;
  const e2eTps =
    totalMs !== null && totalMs >= MIN_TPS_DURATION_MS && totalOut > 0
      ? (totalOut * 1000) / totalMs
      : null;

  const tsMs = Number(t.completed_at_ms || t.created_at_ms || 0);

  return {
    conversationId: t.conversation_id,
    stepIdx: Number(t.step_idx || 0),
    source: t.source || 'cli',
    accountId: t.resolved_acc || t.account_id || 'default',
    timestampMs: tsMs,
    createdAtMs: Number(t.created_at_ms || 0),
    completedAtMs: Number(t.completed_at_ms || 0),
    canonicalModelId: t.canonical_model_id || t.raw_model_id || 'unknown',
    displayName: t.display_name || t.canonical_model_id || t.raw_model_id || 'unknown',
    pool: t.pool || '',
    title: t.title || '',
    workspace: t.workspace || '',
    providerRequestId: t.provider_request_id || '',
    uncachedIn,
    cacheRead,
    cacheCreate,
    inputTotal,
    thinkingOut,
    visibleOut,
    totalOut,
    totalTokens,
    hitRatio,
    cold,
    slow: Boolean(ttftMs !== null && ttftMs >= SLOW_TTFT_THRESHOLD_MS),
    ttftMs,
    genMs,
    totalMs,
    decodeTps,
    e2eTps,
    lowConfGen,
    costUsd: cost.costUsd,
    cacheSavedUsd: cost.cacheSavedUsd,
    longContext: Boolean(cost.longContext),
    unpriced: Boolean(cost.unpriced),
  };
}

function createStatsAcc() {
  return {
    requests: 0,
    uncachedIn: 0,
    cacheRead: 0,
    cacheCreate: 0,
    thinkingOut: 0,
    visibleOut: 0,
    totalOut: 0,
    costUsd: 0,
    cacheSavedUsd: 0,
    coldCount: 0,
    slowCount: 0,
    longContextTurns: 0,
    unpricedTurns: 0,
    ttftSum: 0,
    ttftCnt: 0,
    ttftList: [],
    genSum: 0,
    genCnt: 0,
    totalDurSum: 0,
    totalDurCnt: 0,
    genOutSum: 0,
    genMsForOutSum: 0,
    e2eOutSum: 0,
    e2eMsForOutSum: 0,
    decodeTpsList: [],
    e2eTpsList: [],
  };
}

function pushStatsAcc(acc, row) {
  acc.requests++;
  acc.uncachedIn += row.uncachedIn;
  acc.cacheRead += row.cacheRead;
  acc.cacheCreate += row.cacheCreate;
  acc.thinkingOut += row.thinkingOut;
  acc.visibleOut += row.visibleOut;
  acc.totalOut += row.totalOut;
  acc.costUsd += row.costUsd;
  acc.cacheSavedUsd += row.cacheSavedUsd;
  if (row.cold) acc.coldCount++;
  if (row.slow) acc.slowCount++;
  if (row.longContext) acc.longContextTurns++;
  if (row.unpriced) acc.unpricedTurns++;

  if (row.ttftMs !== null) {
    acc.ttftSum += row.ttftMs;
    acc.ttftCnt++;
    acc.ttftList.push(row.ttftMs);
  }
  if (row.genMs !== null) {
    acc.genSum += row.genMs;
    acc.genCnt++;
    if (row.genMs > 0 && row.totalOut > 0) {
      acc.genOutSum += row.totalOut;
      acc.genMsForOutSum += row.genMs;
    }
  }
  if (row.totalMs !== null) {
    acc.totalDurSum += row.totalMs;
    acc.totalDurCnt++;
    if (row.totalMs > 0 && row.totalOut > 0) {
      acc.e2eOutSum += row.totalOut;
      acc.e2eMsForOutSum += row.totalMs;
    }
  }
  if (row.decodeTps !== null) acc.decodeTpsList.push(row.decodeTps);
  if (row.e2eTps !== null) acc.e2eTpsList.push(row.e2eTps);
}

function finalizeStatsAcc(acc) {
  const inputTotal = acc.uncachedIn + acc.cacheRead + acc.cacheCreate;
  const totalTokens = inputTotal + acc.totalOut;
  const hitRatio = inputTotal > 0 ? acc.cacheRead / inputTotal : 0;

  const ttftSorted = [...acc.ttftList].sort((a, b) => a - b);
  const decodeSorted = [...acc.decodeTpsList].sort((a, b) => a - b);
  const e2eSorted = [...acc.e2eTpsList].sort((a, b) => a - b);

  return {
    requests: acc.requests,
    uncachedIn: acc.uncachedIn,
    cacheRead: acc.cacheRead,
    cacheCreate: acc.cacheCreate,
    inputTotal,
    thinkingOut: acc.thinkingOut,
    visibleOut: acc.visibleOut,
    totalOut: acc.totalOut,
    totalTokens,
    costUsd: acc.costUsd,
    cacheSavedUsd: acc.cacheSavedUsd,
    hitRatio,
    coldCount: acc.coldCount,
    slowCount: acc.slowCount,
    longContextTurns: acc.longContextTurns,
    unpricedTurns: acc.unpricedTurns,
    totalTtftMs: acc.ttftSum,
    totalGenMs: acc.genSum,
    totalDurationMs: acc.totalDurSum,
    avgCostUsd: acc.requests > 0 ? acc.costUsd / acc.requests : 0,
    avgInputTokens: acc.requests > 0 ? inputTotal / acc.requests : 0,
    avgOutputTokens: acc.requests > 0 ? acc.totalOut / acc.requests : 0,
    avgTtftMs: acc.ttftCnt > 0 ? Math.round(acc.ttftSum / acc.ttftCnt) : null,
    p50TtftMs: ttftSorted.length ? Math.round(percentileSorted(ttftSorted, 0.5)) : null,
    p95TtftMs: ttftSorted.length ? Math.round(percentileSorted(ttftSorted, 0.95)) : null,
    avgGenMs: acc.genCnt > 0 ? Math.round(acc.genSum / acc.genCnt) : null,
    avgTotalMs: acc.totalDurCnt > 0 ? Math.round(acc.totalDurSum / acc.totalDurCnt) : null,
    weightedDecodeTps:
      acc.genMsForOutSum > 0 ? (acc.genOutSum * 1000) / acc.genMsForOutSum : null,
    weightedE2eTps:
      acc.e2eMsForOutSum > 0 ? (acc.e2eOutSum * 1000) / acc.e2eMsForOutSum : null,
    p50DecodeTps: decodeSorted.length ? percentileSorted(decodeSorted, 0.5) : null,
    p50E2eTps: e2eSorted.length ? percentileSorted(e2eSorted, 0.5) : null,
  };
}

function getPeriodBucketMeta(tsMs, gran) {
  const d = new Date(tsMs);
  const pad = (x) => String(x).padStart(2, '0');
  if (gran === '1h') {
    const startMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), 0, 0, 0).getTime();
    const endMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime();
    return { key: String(startMs), startMs, endMs };
  }
  if (gran === '5h') {
    const startMs = Math.floor(tsMs / FIVE_HOURS_MS) * FIVE_HOURS_MS;
    return { key: String(startMs), startMs, endMs: startMs + FIVE_HOURS_MS };
  }
  if (gran === '1d') {
    const startMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
    const endMs = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return { key, startMs, endMs };
  }
  // 7d (Monday-based local week)
  const day = d.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diffToMon, 0, 0, 0, 0);
  const nextMon = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7, 0, 0, 0, 0);
  const startMs = mon.getTime();
  const key = `${mon.getFullYear()}-${pad(mon.getMonth() + 1)}-${pad(mon.getDate())}`;
  return { key, startMs, endMs: nextMon.getTime() };
}

/**
 * Pure analytics computation over pre-fetched `turns` for Module #8 (`request-speed`).
 */
export function computeRequestSpeedSummary(turns, pricingState) {
  const overall = createStatsAcc();
  const modelMap = new Map();
  const periodMaps = {
    '1h': new Map(),
    '5h': new Map(),
    '1d': new Map(),
    '7d': new Map(),
  };

  let latestRequest = null;

  for (const t of turns || []) {
    const row = formatRequestRow(t, pricingState);
    pushStatsAcc(overall, row);

    if (!latestRequest || row.timestampMs >= latestRequest.timestampMs) {
      latestRequest = row;
    }

    let mEntry = modelMap.get(row.canonicalModelId);
    if (!mEntry) {
      mEntry = {
        canonicalId: row.canonicalModelId,
        displayName: row.displayName,
        pool: row.pool,
        acc: createStatsAcc(),
      };
      modelMap.set(row.canonicalModelId, mEntry);
    }
    if (!mEntry.displayName && row.displayName) mEntry.displayName = row.displayName;
    pushStatsAcc(mEntry.acc, row);

    if (row.timestampMs > 0) {
      for (const gran of ['1h', '5h', '1d', '7d']) {
        const meta = getPeriodBucketMeta(row.timestampMs, gran);
        let pEntry = periodMaps[gran].get(meta.key);
        if (!pEntry) {
          pEntry = { ...meta, acc: createStatsAcc() };
          periodMaps[gran].set(meta.key, pEntry);
        }
        pushStatsAcc(pEntry.acc, row);
      }
    }
  }

  const fin = finalizeStatsAcc(overall);

  const byModel = [...modelMap.values()]
    .map((m) => {
      const f = finalizeStatsAcc(m.acc);
      return {
        canonicalId: m.canonicalId,
        displayName: m.displayName || m.canonicalId,
        pool: m.pool,
        ...f,
      };
    })
    .sort((a, b) => b.requests - a.requests || b.costUsd - a.costUsd);

  const periods = {};
  for (const gran of ['1h', '5h', '1d', '7d']) {
    const list = [...periodMaps[gran].values()]
      .sort((a, b) => a.startMs - b.startMs)
      .slice(-MAX_PERIOD_SLICES[gran])
      .map((p) => {
        const f = finalizeStatsAcc(p.acc);
        return {
          key: p.key,
          startMs: p.startMs,
          endMs: p.endMs,
          requests: f.requests,
          totalTokens: f.totalTokens,
          inputTotal: f.inputTotal,
          cacheRead: f.cacheRead,
          totalOut: f.totalOut,
          hitRatio: f.hitRatio,
          costUsd: f.costUsd,
          avgCostUsd: f.avgCostUsd,
          avgTtftMs: f.avgTtftMs,
          p50TtftMs: f.p50TtftMs,
          weightedDecodeTps: f.weightedDecodeTps,
          weightedE2eTps: f.weightedE2eTps,
          p50DecodeTps: f.p50DecodeTps,
          p50E2eTps: f.p50E2eTps,
        };
      });
    periods[gran] = list;
  }

  return {
    totals: {
      requests: fin.requests,
      uncachedIn: fin.uncachedIn,
      cacheRead: fin.cacheRead,
      cacheCreate: fin.cacheCreate,
      inputTotal: fin.inputTotal,
      thinkingOut: fin.thinkingOut,
      visibleOut: fin.visibleOut,
      totalOut: fin.totalOut,
      totalTokens: fin.totalTokens,
      costUsd: fin.costUsd,
      cacheSavedUsd: fin.cacheSavedUsd,
      hitRatio: fin.hitRatio,
      coldCount: fin.coldCount,
      slowCount: fin.slowCount,
      longContextTurns: fin.longContextTurns,
      unpricedTurns: fin.unpricedTurns,
      totalTtftMs: fin.totalTtftMs,
      totalGenMs: fin.totalGenMs,
      totalDurationMs: fin.totalDurationMs,
    },
    averages: {
      avgCostUsd: fin.avgCostUsd,
      avgInputTokens: fin.avgInputTokens,
      avgOutputTokens: fin.avgOutputTokens,
      avgTtftMs: fin.avgTtftMs,
      p50TtftMs: fin.p50TtftMs,
      p95TtftMs: fin.p95TtftMs,
      avgGenMs: fin.avgGenMs,
      avgTotalMs: fin.avgTotalMs,
      weightedDecodeTps: fin.weightedDecodeTps,
      weightedE2eTps: fin.weightedE2eTps,
      p50DecodeTps: fin.p50DecodeTps,
      p50E2eTps: fin.p50E2eTps,
    },
    latestRequest,
    byModel,
    periods,
  };
}

/**
 * Paginated request log query for `GET /api/requests`.
 */
export function queryRequestsPage(
  cacheDb,
  pricingState,
  {
    fromMs = 0,
    toMs = Date.now(),
    sources = ['desktop', 'cli'],
    accountId = 'all',
    model = 'all',
    sourceFilter = 'all',
    flag = 'all',
    sort = 'time',
    dir = 'desc',
    page = 1,
    pageSize = 20,
  } = {}
) {
  const activeSources = (Array.isArray(sources) ? sources : ['desktop', 'cli']).filter(
    (s) => s === 'desktop' || s === 'cli'
  );
  const effectiveSources =
    sourceFilter === 'cli' || sourceFilter === 'desktop'
      ? activeSources.filter((s) => s === sourceFilter)
      : activeSources;

  const safePageSize = Math.max(10, Math.min(100, Math.round(Number(pageSize) || 20)));
  const safePage = Math.max(1, Math.round(Number(page) || 1));

  if (effectiveSources.length === 0) {
    return {
      total: 0,
      page: 1,
      pageSize: safePageSize,
      totalPages: 1,
      availableModels: [],
      items: [],
    };
  }

  const placeholders = effectiveSources.map(() => '?').join(',');
  const accFilter = normalizeAccountIdFilter(accountId);
  const hasAcc = hasAccountSchema(cacheDb);
  const accSql = hasAcc ? buildTurnAccountSql('t') : null;
  const tsExpr = hasAcc ? accSql.tsExprSql : 'COALESCE(t.completed_at_ms, t.created_at_ms, 0)';

  const baseWhere = `
    WHERE t.source IN (${placeholders})
      AND ${tsExpr} > 0
      AND ${tsExpr} >= ?
      AND ${tsExpr} <= ?
      ${hasAcc && accFilter !== 'all' ? `AND (${accSql.exprSql}) = ?` : ''}
  `;
  const baseParams = [...effectiveSources, fromMs, toMs];
  if (hasAcc && accFilter !== 'all') baseParams.push(accFilter);

  const modelFilter = typeof model === 'string' && model.trim() && model !== 'all' ? model.trim() : null;
  const flagFilter = flag === 'cold' || flag === 'slow' ? flag : 'all';
  const sortKey = ['time', 'cost', 'ttft', 'tps', 'e2eTps', 'tokens'].includes(sort) ? sort : 'time';
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';

  // Fast SQL-paginated path for SQL-sortable keys (`time`, `ttft`, `tokens`):
  // avoids formatting/costing all N rows on every page navigation!
  if (sortKey === 'time' || sortKey === 'ttft' || sortKey === 'tokens') {
    const modelRows = cacheDb
      .prepare(
        `SELECT COALESCE(NULLIF(t.canonical_model_id, ''), NULLIF(t.raw_model_id, ''), 'unknown') AS cid,
                MAX(COALESCE(NULLIF(t.display_name, ''), NULLIF(t.canonical_model_id, ''), 'unknown')) AS dname,
                COUNT(*) AS cnt
         FROM turns t
         ${hasAcc ? accSql.joinSql : ''}
         ${baseWhere}
         GROUP BY cid
         ORDER BY cnt DESC, cid ASC`
      )
      .all(...baseParams);
    const availableModels = modelRows.map((r) => ({
      canonicalId: r.cid,
      displayName: r.dname || r.cid,
      count: Number(r.cnt || 0),
    }));

    const extraConds = [];
    const extraParams = [];
    if (modelFilter) {
      extraConds.push("COALESCE(NULLIF(t.canonical_model_id, ''), NULLIF(t.raw_model_id, ''), 'unknown') = ?");
      extraParams.push(modelFilter);
    }
    if (flagFilter === 'cold') {
      extraConds.push('t.cache_read = 0 AND (t.uncached_in + t.cache_read + t.cache_create) > 0');
    } else if (flagFilter === 'slow') {
      extraConds.push(`t.ttft_ms IS NOT NULL AND t.ttft_ms >= ${SLOW_TTFT_THRESHOLD_MS}`);
    }
    const fullWhere = extraConds.length ? `${baseWhere} AND ${extraConds.join(' AND ')}` : baseWhere;
    const fullParams = [...baseParams, ...extraParams];

    const total = Number(
      cacheDb
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM turns t
           ${hasAcc ? accSql.joinSql : ''}
           ${fullWhere}`
        )
        .get(...fullParams)?.cnt || 0
    );
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const clampedPage = Math.min(safePage, totalPages);
    const offset = (clampedPage - 1) * safePageSize;

    const orderExpr =
      sortKey === 'ttft'
        ? `COALESCE(t.ttft_ms, -1) ${sortDir}, ${tsExpr} DESC, t.step_idx DESC`
        : sortKey === 'tokens'
          ? `(t.uncached_in + t.cache_read + t.cache_create + t.total_out) ${sortDir}, ${tsExpr} DESC, t.step_idx DESC`
          : `${tsExpr} ${sortDir}, t.step_idx ${sortDir}`;

    const pageRows = cacheDb
      .prepare(
        `SELECT t.*,
                COALESCE(f.workspace, '') AS workspace,
                COALESCE(f.title, '') AS title,
                ${hasAcc ? `(${accSql.exprSql})` : "'default'"} AS resolved_acc
         FROM turns t
         LEFT JOIN indexed_files f ON f.conversation_id = t.conversation_id AND f.source = t.source
         ${hasAcc ? accSql.joinSql : ''}
         ${fullWhere}
         ORDER BY ${orderExpr}
         LIMIT ? OFFSET ?`
      )
      .all(...fullParams, safePageSize, offset);

    return {
      total,
      page: clampedPage,
      pageSize: safePageSize,
      totalPages,
      availableModels,
      items: pageRows.map((r) => formatRequestRow(r, pricingState)),
    };
  }

  // Computed-metric sort path (`cost`, `tps`, `e2eTps`)
  const sql = `
    SELECT t.*,
           COALESCE(f.workspace, '') AS workspace,
           COALESCE(f.title, '') AS title,
           ${hasAcc ? `(${accSql.exprSql})` : "'default'"} AS resolved_acc
    FROM turns t
    LEFT JOIN indexed_files f ON f.conversation_id = t.conversation_id AND f.source = t.source
    ${hasAcc ? accSql.joinSql : ''}
    ${baseWhere}
    ORDER BY ${tsExpr} DESC, t.step_idx DESC
  `;
  const rawRows = cacheDb.prepare(sql).all(...baseParams);

  const modelCounts = new Map();
  for (const r of rawRows) {
    const cid = r.canonical_model_id || r.raw_model_id || 'unknown';
    let entry = modelCounts.get(cid);
    if (!entry) {
      entry = { canonicalId: cid, displayName: r.display_name || cid, count: 0 };
      modelCounts.set(cid, entry);
    }
    entry.count++;
  }
  const availableModels = [...modelCounts.values()].sort(
    (a, b) => b.count - a.count || a.canonicalId.localeCompare(b.canonicalId)
  );

  let rows = rawRows.map((r) => formatRequestRow(r, pricingState));
  if (modelFilter) {
    rows = rows.filter((r) => r.canonicalModelId === modelFilter);
  }
  if (flagFilter === 'cold') {
    rows = rows.filter((r) => r.cold);
  } else if (flagFilter === 'slow') {
    rows = rows.filter((r) => r.slow);
  }

  const mult = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    let va = 0;
    let vb = 0;
    if (sortKey === 'cost') {
      va = a.costUsd;
      vb = b.costUsd;
    } else if (sortKey === 'tps') {
      va = a.decodeTps ?? -1;
      vb = b.decodeTps ?? -1;
    } else if (sortKey === 'e2eTps') {
      va = a.e2eTps ?? -1;
      vb = b.e2eTps ?? -1;
    }
    if (va !== vb) return (va - vb) * mult;
    return (b.timestampMs - a.timestampMs) || (b.stepIdx - a.stepIdx);
  });

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const clampedPage = Math.min(safePage, totalPages);
  const offset = (clampedPage - 1) * safePageSize;
  const items = rows.slice(offset, offset + safePageSize);

  return {
    total,
    page: clampedPage,
    pageSize: safePageSize,
    totalPages,
    availableModels,
    items,
  };
}

/**
 * Computes progressive 5h-step empirical cache survival curves (`5h -> 10h -> 15h -> ... -> 168h`)
 * until `>= minSamples` (default 50) follow-up turns are gathered.
 * Used by Live Context to render real-time cache freshness inference without extra backend polling.
 */
export function computeSessionCacheFreshness(
  cacheDb,
  {
    modelId = '',
    sources = ['desktop', 'cli'],
    accountId = 'all',
    nowMs = Date.now(),
    minSamples = FRESHNESS_DEFAULT_MIN_SAMPLES,
    stepHours = FRESHNESS_STEP_HOURS,
    maxHours = FRESHNESS_MAX_HOURS,
    gapBreakpointsSec = DEFAULT_GAP_BREAKPOINTS_SEC,
  } = {}
) {
  const activeSources = (Array.isArray(sources) ? sources : ['desktop', 'cli']).filter(
    (s) => s === 'desktop' || s === 'cli'
  );
  const spec = buildGapBucketSpec(gapBreakpointsSec);
  const thresholdsSec = spec.breakpointsSec;

  const buildEmptyBuckets = () =>
    spec.keys.map((key, idx) => ({
      key,
      minSec: idx === 0 ? 0 : thresholdsSec[idx - 1],
      maxSec: idx < thresholdsSec.length ? thresholdsSec[idx] : null,
      turns: 0,
      hits: 0,
      keepRate: null,
      weightedHitRatio: null,
    }));

  if (!cacheDb || activeSources.length === 0) {
    return {
      modelId: modelId || '',
      scope: 'prior',
      windowHours: maxHours,
      totalSamples: 0,
      minSamples,
      breakpointsSec: thresholdsSec,
      buckets: buildEmptyBuckets(),
      allModels: { windowHours: maxHours, totalSamples: 0, buckets: buildEmptyBuckets() },
    };
  }

  const minWindowFromMs = Math.max(0, nowMs - maxHours * HOUR_MS);
  const placeholders = activeSources.map(() => '?').join(',');
  const accFilter = normalizeAccountIdFilter(accountId);
  const hasAcc = hasAccountSchema(cacheDb);
  const accSql = hasAcc ? buildTurnAccountSql('t') : null;
  const tsExpr = hasAcc ? accSql.tsExprSql : 'COALESCE(t.completed_at_ms, t.created_at_ms, 0)';

  // Query recent conversations' turns (include 1 extra hour before maxHours for prev turn context)
  const rows = cacheDb
    .prepare(
      `SELECT t.conversation_id, t.step_idx, t.source,
              t.created_at_ms, t.completed_at_ms, t.canonical_model_id,
              t.uncached_in, t.cache_read, t.cache_create,
              ${hasAcc ? `(${accSql.exprSql})` : "'default'"} AS account_id
       FROM turns t
       ${hasAcc ? accSql.joinSql : ''}
       WHERE t.source IN (${placeholders})
         AND ${tsExpr} >= ?
         AND ${tsExpr} <= ?
       ORDER BY t.conversation_id ASC, t.step_idx ASC`
    )
    .all(...activeSources, Math.max(0, minWindowFromMs - HOUR_MS), nowMs);

  const byConv = new Map();
  for (const r of rows) {
    let list = byConv.get(r.conversation_id);
    if (!list) {
      list = [];
      byConv.set(r.conversation_id, list);
    }
    list.push(r);
  }

  const modelEvents = [];
  const allEvents = [];

  for (const convTurns of byConv.values()) {
    for (let i = 1; i < convTurns.length; i++) {
      const prev = convTurns[i - 1];
      const cur = convTurns[i];
      const curTs = Number(cur.completed_at_ms || cur.created_at_ms || 0);
      if (curTs < minWindowFromMs || curTs > nowMs) continue;
      if (accFilter !== 'all' && cur.account_id !== accFilter) continue;
      if (prev.account_id && cur.account_id && prev.account_id !== cur.account_id) continue;
      if (
        prev.canonical_model_id &&
        cur.canonical_model_id &&
        prev.canonical_model_id !== cur.canonical_model_id
      ) {
        continue;
      }
      if (!cur.created_at_ms || !prev.completed_at_ms) continue;
      const idleGapMs = Math.max(0, Number(cur.created_at_ms) - Number(prev.completed_at_ms));

      const prevIn = Number(prev.uncached_in || 0) + Number(prev.cache_read || 0) + Number(prev.cache_create || 0);
      const curIn = Number(cur.uncached_in || 0) + Number(cur.cache_read || 0) + Number(cur.cache_create || 0);
      if (curIn <= 0) continue;
      // Exclude context compactions identically to cache_observatory.mjs
      if (prevIn > 20000 && curIn < prevIn * 0.65) continue;

      const curCacheRead = Number(cur.cache_read || 0);
      const curHit = curCacheRead / curIn;
      const bucketKey = classifyGapBucket(idleGapMs, spec);
      if (!bucketKey) continue;

      const ev = {
        tsMs: curTs,
        bucketKey,
        hit: curHit >= 0.5,
        cacheRead: curCacheRead,
        totalIn: curIn,
      };
      allEvents.push(ev);
      if (modelId && cur.canonical_model_id === modelId) {
        modelEvents.push(ev);
      }
    }
  }

  function buildProgressiveCurve(events) {
    if (!events.length) {
      return { windowHours: maxHours, totalSamples: 0, buckets: buildEmptyBuckets() };
    }
    let chosenHours = maxHours;
    let selected = events;
    for (let h = stepHours; h <= maxHours; h += stepHours) {
      const clampedH = Math.min(h, maxHours);
      const cutoff = nowMs - clampedH * HOUR_MS;
      const subset = events.filter((e) => e.tsMs >= cutoff);
      if (subset.length >= minSamples || clampedH >= maxHours) {
        chosenHours = clampedH;
        selected = subset;
        break;
      }
    }
    if (chosenHours < maxHours && selected.length < minSamples) {
      chosenHours = maxHours;
      selected = events;
    }

    const bucketMap = new Map();
    for (let i = 0; i < spec.keys.length; i++) {
      bucketMap.set(spec.keys[i], {
        key: spec.keys[i],
        minSec: i === 0 ? 0 : thresholdsSec[i - 1],
        maxSec: i < thresholdsSec.length ? thresholdsSec[i] : null,
        turns: 0,
        hits: 0,
        cacheReadSum: 0,
        totalInSum: 0,
      });
    }
    for (const ev of selected) {
      const b = bucketMap.get(ev.bucketKey);
      if (!b) continue;
      b.turns++;
      if (ev.hit) b.hits++;
      b.cacheReadSum += ev.cacheRead;
      b.totalInSum += ev.totalIn;
    }

    const buckets = spec.keys.map((key) => {
      const b = bucketMap.get(key);
      return {
        key: b.key,
        minSec: b.minSec,
        maxSec: b.maxSec,
        turns: b.turns,
        hits: b.hits,
        keepRate: b.turns > 0 ? b.hits / b.turns : null,
        weightedHitRatio: b.totalInSum > 0 ? b.cacheReadSum / b.totalInSum : null,
      };
    });

    return {
      windowHours: chosenHours,
      totalSamples: selected.length,
      buckets,
    };
  }

  const modelCurve = buildProgressiveCurve(modelEvents);
  const allCurve = buildProgressiveCurve(allEvents);

  const scope =
    modelCurve.totalSamples > 0
      ? 'model'
      : allCurve.totalSamples > 0
        ? 'all'
        : 'prior';

  return {
    modelId: modelId || '',
    scope,
    windowHours: scope === 'model' ? modelCurve.windowHours : allCurve.windowHours,
    totalSamples: scope === 'model' ? modelCurve.totalSamples : allCurve.totalSamples,
    minSamples,
    breakpointsSec: thresholdsSec,
    buckets: scope === 'model' ? modelCurve.buckets : allCurve.buckets,
    allModels: allCurve,
  };
}
