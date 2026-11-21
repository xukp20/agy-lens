/**
 * Global Prompt Cache Observatory (`cache-observatory` module).
 * Analyzes consecutive turn transitions per conversation to detect unexpected 0% misses,
 * boundary cuts, bounce-backs, idle-gap decay curves, and excess API cost penalties.
 */
import { calcMissPenaltyUsd, calculateTurnCost } from './pricing.mjs';

export const GAP_BUCKETS = ['<=2s', '2-5s', '5-10s', '10-20s', '20-60s', '1-5m', '>5m'];
const GAP_THRESHOLDS_MS = [2000, 5000, 10000, 20000, 60000, 300000];
const MAX_SCATTER_POINTS = 450;
const MAX_TOP_ANOMALIES = 20;

export function classifyGapBucket(idleGapMs) {
  if (idleGapMs === null || idleGapMs === undefined || !Number.isFinite(idleGapMs)) return null;
  for (let i = 0; i < GAP_THRESHOLDS_MS.length; i++) {
    if (idleGapMs <= GAP_THRESHOLDS_MS[i]) return GAP_BUCKETS[i];
  }
  return '>5m';
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

export function buildIssueMarkdown({ summary, matrix, topAnomalies }) {
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
    lines.push(`| Model | Follow-ups | Hit % | Misses | ${GAP_BUCKETS.join(' | ')} |`);
    lines.push(`| --- | ---: | ---: | ---: | ${GAP_BUCKETS.map(() => '---:').join(' | ')} |`);
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

function emptyObservatory() {
  const summary = {
    followUpTurns: 0,
    weightedFollowUpHitRatio: 0,
    unexpectedFullMisses: 0,
    bounceBackCount: 0,
    boundaryCuts: 0,
    modelSwitchTurns: 0,
    compactedTurns: 0,
    wastedTokens: 0,
    missPenaltyUsd: 0,
  };
  return {
    summary,
    gapBuckets: [...GAP_BUCKETS],
    matrix: [],
    scatterPoints: [],
    topAnomalies: [],
    issueMarkdown: buildIssueMarkdown({ summary, matrix: [], topAnomalies: [] }),
  };
}

function queryConversationTurns(cacheDb, { sources, fromMs, toMs, workspace = '' }) {
  if (!sources || sources.length === 0) return [];
  const placeholders = sources.map(() => '?').join(',');

  let activeConvSql = `
    SELECT DISTINCT t.conversation_id
    FROM turns t
    LEFT JOIN indexed_files f ON f.conversation_id = t.conversation_id AND f.source = t.source
    WHERE t.source IN (${placeholders})
      AND t.completed_at_ms >= ?
      AND t.completed_at_ms <= ?
  `;
  const activeParams = [...sources, fromMs, toMs];
  if (workspace) {
    activeConvSql += ' AND f.workspace = ?';
    activeParams.push(workspace);
  }

  const sql = `
    SELECT
      t.conversation_id, t.step_idx, t.source,
      t.created_at_ms, t.completed_at_ms,
      t.canonical_model_id, t.display_name, t.pool,
      t.uncached_in, t.cache_read, t.cache_create,
      t.thinking_out, t.visible_out, t.total_out,
      t.provider_request_id
    FROM turns t
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
export function analyzeTurnsForObservatory(rows, pricingState, { fromMs = 0, toMs = Date.now() } = {}) {
  if (!rows || rows.length === 0) {
    return emptyObservatory();
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
  let compactedTurns = 0;
  let totalWastedTokens = 0;
  let totalMissPenaltyUsd = 0;

  const modelStats = new Map();
  const anomalyScatter = [];
  const normalScatter = [];
  const allAnomalies = [];

  for (const convTurns of convMap.values()) {
    convTurns.sort((a, b) => a.step_idx - b.step_idx);

    // Index 0 is always 'cold_start' and excluded from follow-up stats.
    for (let i = 1; i < convTurns.length; i++) {
      const prev = convTurns[i - 1];
      const cur = convTurns[i];
      const next = i + 1 < convTurns.length ? convTurns[i + 1] : null;

      const curCompleted = cur.completed_at_ms || cur.created_at_ms || 0;
      if (curCompleted < fromMs || curCompleted > toMs) continue;

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
      const nextCompacted = Boolean(next && curTotalIn > 20000 && nextTotalIn < curTotalIn * 0.65);
      const bounceBack = Boolean(
        (kind === 'unexpected_full_miss' || kind === 'boundary_cut') &&
          next &&
          nextSameModel &&
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
        for (const key of GAP_BUCKETS) {
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

      const bucketKey = classifyGapBucket(idleGapMs);
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
      buckets: GAP_BUCKETS.map((key) => {
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
    compactedTurns,
    wastedTokens: totalWastedTokens,
    missPenaltyUsd: totalMissPenaltyUsd,
  };

  return {
    summary,
    gapBuckets: [...GAP_BUCKETS],
    matrix,
    scatterPoints,
    topAnomalies,
    issueMarkdown: buildIssueMarkdown({ summary, matrix, topAnomalies }),
  };
}

export function computeCacheObservatory(
  cacheDb,
  pricingState,
  { sources = ['desktop', 'cli'], fromMs = 0, toMs = Date.now(), workspace = '' } = {}
) {
  const rows = queryConversationTurns(cacheDb, { sources, fromMs, toMs, workspace });
  return analyzeTurnsForObservatory(rows, pricingState, { fromMs, toMs });
}
