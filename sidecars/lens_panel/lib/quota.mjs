/**
 * Subscription quota alignment anchors & pooled-ratio cycle estimator.
 * Completely independent of CLI; stores user-recorded anchors in telemetry_cache.db.
 */
import { calculateTurnCost } from './pricing.mjs';

export const VALID_POOLS = ['gemini', 'argon', '3p'];
export const VALID_WINDOWS = ['5h', '7d'];

export function normalizePool(pool) {
  const s = String(pool || '').trim().toLowerCase();
  if (s === 'third-party' || s === 'third_party' || s === '3p') return '3p';
  if (s === 'argon') return 'argon';
  if (s === 'gemini') return 'gemini';
  return null;
}

export function normalizeWindowType(win) {
  const s = String(win || '').trim().toLowerCase();
  if (s === '5h' || s === '5hr') return '5h';
  if (s === '7d' || s === 'weekly') return '7d';
  return null;
}

export function detectPrecisionStep(remainingPct, rawInput = null) {
  if (rawInput !== null && rawInput !== undefined && String(rawInput).trim() !== '') {
    const cleaned = String(rawInput).trim().replace(/%$/, '').trim();
    const dotIdx = cleaned.indexOf('.');
    if (dotIdx === -1) return 1.0;
    const decDigits = cleaned.slice(dotIdx + 1).replace(/[^0-9]/g, '').length;
    if (decDigits >= 2) return 0.01;
    if (decDigits === 1) return 0.1;
    return 1.0;
  }
  const rounded = Math.round(Number(remainingPct) * 100) / 100;
  if (Math.round(rounded * 100) % 10 !== 0) return 0.01;
  if (Math.round(rounded * 10) % 10 !== 0) return 0.1;
  return 1.0;
}

export function resolveInheritedResetAt(prevAnchor, capturedAt, remainingPct, explicitResetAt = null) {
  if (explicitResetAt !== null && explicitResetAt !== undefined) {
    return explicitResetAt;
  }
  if (
    prevAnchor &&
    prevAnchor.reset_at != null &&
    prevAnchor.reset_at > capturedAt &&
    remainingPct <= prevAnchor.remaining_pct + 0.5
  ) {
    return prevAnchor.reset_at;
  }
  return null;
}

export function addQuotaAnchor(cacheDb, payload) {
  const pool = normalizePool(payload?.pool);
  if (!pool) throw new Error('Invalid pool (expected gemini, argon, or 3p)');

  const windowType = normalizeWindowType(payload?.windowType ?? payload?.window);
  if (!windowType) throw new Error('Invalid windowType (expected 5h or 7d)');

  const num = Number(payload?.remainingPct);
  if (!Number.isFinite(num) || num < 0 || num > 100) {
    throw new Error('remainingPct must be a number in [0, 100]');
  }
  const remainingPct = Math.round(num * 100) / 100;
  const precisionStep = detectPrecisionStep(remainingPct, payload?.rawInput);

  const nowMs = Date.now();
  const rawCapturedAt =
    payload?.capturedAt !== undefined && payload?.capturedAt !== null && payload?.capturedAt !== ''
      ? Number(payload.capturedAt)
      : nowMs;
  if (!Number.isFinite(rawCapturedAt) || rawCapturedAt <= 0) {
    throw new Error('Invalid capturedAt timestamp');
  }
  const capturedAt = Math.round(rawCapturedAt);

  let resetAt = null;
  if (payload?.resetAt !== undefined && payload?.resetAt !== null && payload?.resetAt !== '') {
    const r = Number(payload.resetAt);
    if (!Number.isFinite(r) || r <= 0) throw new Error('Invalid resetAt timestamp');
    resetAt = Math.round(r);
  } else {
    const priorRows = cacheDb
      .prepare(
        `SELECT remaining_pct, reset_at, captured_at
         FROM quota_anchors
         WHERE pool = ? AND window_type = ? AND captured_at <= ?
         ORDER BY captured_at ASC, id ASC`
      )
      .all(pool, windowType, capturedAt);
    if (priorRows.length > 0) {
      const priorCycles = segmentCycles(priorRows);
      const activeCycle = priorCycles[priorCycles.length - 1];
      const latestInCycle = activeCycle[activeCycle.length - 1];
      let cycleResetAt = null;
      for (let i = activeCycle.length - 1; i >= 0; i--) {
        if (activeCycle[i].reset_at != null) {
          cycleResetAt = activeCycle[i].reset_at;
          break;
        }
      }
      resetAt = resolveInheritedResetAt(
        { remaining_pct: latestInCycle.remaining_pct, reset_at: cycleResetAt },
        capturedAt,
        remainingPct,
        null
      );
    }
  }

  const note = typeof payload?.note === 'string' ? payload.note.trim().slice(0, 240) : '';

  const info = cacheDb
    .prepare(
      `INSERT INTO quota_anchors (pool, window_type, remaining_pct, precision_step, captured_at, reset_at, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(pool, windowType, remainingPct, precisionStep, capturedAt, resetAt, note, nowMs);

  return Number(info.lastInsertRowid);
}

export function deleteQuotaAnchor(cacheDb, id) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    throw new Error('Invalid anchor id');
  }
  const info = cacheDb.prepare('DELETE FROM quota_anchors WHERE id = ?').run(numId);
  return info.changes > 0;
}

/**
 * Split ordered anchors (same pool & window_type) into distinct quota cycles.
 * Splits when reset_at shifts forward >120s, capture crosses past reset_at + 120s,
 * or remaining_pct jumps up by >0.5 percentage points.
 */
export function segmentCycles(orderedAnchors) {
  if (!orderedAnchors || orderedAnchors.length === 0) return [];
  const cycles = [[orderedAnchors[0]]];

  for (let i = 1; i < orderedAnchors.length; i++) {
    const prev = orderedAnchors[i - 1];
    const cur = orderedAnchors[i];

    const resetShifted =
      prev.reset_at != null &&
      cur.reset_at != null &&
      cur.reset_at - prev.reset_at > 120_000;
    const crossedReset =
      prev.reset_at != null && cur.captured_at > prev.reset_at + 120_000;
    const pctJumpedUp = cur.remaining_pct > prev.remaining_pct + 0.5;

    if (resetShifted || crossedReset || pctJumpedUp) {
      cycles.push([cur]);
    } else {
      cycles[cycles.length - 1].push(cur);
    }
  }
  return cycles;
}

function sumPoolSpendInInterval(cacheDb, pricingState, pool, startExclusiveMs, endInclusiveMs, modelSpendMap) {
  if (endInclusiveMs <= startExclusiveMs) return 0;
  const rows = cacheDb
    .prepare(
      `SELECT * FROM turns
       WHERE pool = ? AND completed_at_ms > ? AND completed_at_ms <= ?
       ORDER BY completed_at_ms ASC`
    )
    .all(pool, startExclusiveMs, endInclusiveMs);

  let sum = 0;
  for (const t of rows) {
    const cost = calculateTurnCost(t, pricingState);
    if (cost.unpriced) continue;
    sum += cost.costUsd;
    if (modelSpendMap) {
      const k = t.canonical_model_id || 'unknown';
      modelSpendMap.set(k, (modelSpendMap.get(k) || 0) + cost.costUsd);
    }
  }
  return sum;
}

function formatAnchor(row) {
  return {
    id: row.id,
    pool: row.pool,
    windowType: row.window_type,
    remainingPct: row.remaining_pct,
    precisionStep: row.precision_step,
    capturedAt: row.captured_at,
    resetAt: row.reset_at,
    note: row.note || '',
    createdAt: row.created_at,
  };
}

export function computeSummaryForPair(
  cacheDb,
  pricingState,
  pool,
  windowType,
  orderedAnchors,
  nowMs = Date.now(),
  spendFn = null
) {
  const sumSpend = spendFn || ((p, s, e, m) => sumPoolSpendInInterval(cacheDb, pricingState, p, s, e, m));
  const cycles = segmentCycles(orderedAnchors);
  if (cycles.length === 0) {
    return {
      pool,
      windowType,
      latestAnchor: null,
      inheritableResetAt: null,
      spendSinceLastUsd: 0,
      projectedRemainingPct: null,
      evenUsePaceRatio: null,
      cycleCount: 0,
      estimation: {
        status: 'no_data',
        totalDeltaPct: 0,
        segmentsUsed: 0,
        windowSpendUsd: 0,
        estimatedPoolUsd: null,
        ciLowUsd: null,
        ciHighUsd: null,
        impliedRemainingUsd: null,
        precisionStepPct: null,
        modelMix: [],
        mixedModelWarning: false,
      },
    };
  }

  const latestCycle = cycles[cycles.length - 1];
  const latestRow = latestCycle[latestCycle.length - 1];
  const latestAnchor = formatAnchor(latestRow);

  const modelSpendMap = new Map();
  const segments = [];

  for (let i = 1; i < latestCycle.length; i++) {
    const a0 = latestCycle[i - 1];
    const a1 = latestCycle[i];
    const deltaU = (a0.remaining_pct - a1.remaining_pct) / 100;
    if (deltaU <= 0 || a1.captured_at <= a0.captured_at) continue;

    const spendUsd = sumSpend(pool, a0.captured_at, a1.captured_at, modelSpendMap);
    const qK = Math.max(a0.precision_step, a1.precision_step) / 100;
    segments.push({ spendUsd, deltaU, qK });
  }

  let cycleResetAt = null;
  for (let i = latestCycle.length - 1; i >= 0; i--) {
    if (latestCycle[i].reset_at != null) {
      cycleResetAt = latestCycle[i].reset_at;
      break;
    }
  }

  const endMs =
    cycleResetAt != null && nowMs > cycleResetAt ? cycleResetAt : nowMs;
  const tailModelMap = new Map();
  const spendSinceLastUsd = sumSpend(pool, latestRow.captured_at, endMs, tailModelMap);

  // Merge tail model mix when segments are empty so calibrating card still shows active mix.
  const mixSourceMap = modelSpendMap.size > 0 ? modelSpendMap : tailModelMap;
  const totalMixUsd = [...mixSourceMap.values()].reduce((a, b) => a + b, 0);
  const modelMix = [...mixSourceMap.entries()]
    .map(([canonicalId, usd]) => ({
      canonicalId,
      share: totalMixUsd > 0 ? usd / totalMixUsd : 0,
    }))
    .sort((a, b) => b.share - a.share);

  const sumC = segments.reduce((acc, s) => acc + s.spendUsd, 0);
  const sumDeltaU = segments.reduce((acc, s) => acc + s.deltaU, 0);
  const totalDeltaPct = Number((sumDeltaU * 100).toFixed(4));
  const windowSpendUsd = sumC + spendSinceLastUsd;

  const qEff =
    segments.length > 0
      ? Math.max(...segments.map((s) => s.qK))
      : latestRow.precision_step / 100;
  const precisionStepPct = Number((qEff * 100).toFixed(4));

  // Precision-adaptive thresholds:
  // - 2-decimal (0.01% step): >=0.20% usable (low_confidence), >=1.00% high confidence (ok)
  // - 1-decimal (0.1% step):  >=0.50% usable (low_confidence), >=2.00% high confidence (ok)
  // - Integer   (1% step):    >=2.00% usable (low_confidence), >=5.00% high confidence (ok)
  const minThreshold = qEff <= 0.00015 ? 0.002 : qEff <= 0.0015 ? 0.005 : 0.02;
  const highThreshold = qEff <= 0.00015 ? 0.01 : qEff <= 0.0015 ? 0.02 : 0.05;

  let estimatedPoolUsd = null;
  let ciLowUsd = null;
  let ciHighUsd = null;
  let impliedRemainingUsd = null;
  let projectedRemainingPct = null;
  let status = 'calibrating';

  if (segments.length > 0 && sumDeltaU > 0 && sumC > 0) {
    const qHat = sumC / sumDeltaU;
    const err95 = 0.776 * Math.sqrt(segments.reduce((acc, s) => acc + s.qK * s.qK, 0));
    estimatedPoolUsd = qHat;
    ciLowUsd = sumC / (sumDeltaU + err95);
    ciHighUsd = sumDeltaU - err95 > 0.0001 ? sumC / (sumDeltaU - err95) : null;

    if (sumDeltaU >= highThreshold) {
      status = 'ok';
    } else if (sumDeltaU >= minThreshold) {
      status = 'low_confidence';
    } else {
      status = 'calibrating';
    }

    projectedRemainingPct = Math.max(
      0,
      Math.min(100, latestRow.remaining_pct - (spendSinceLastUsd / qHat) * 100)
    );
    projectedRemainingPct = Math.round(projectedRemainingPct * 100) / 100;
    impliedRemainingUsd = qHat * (projectedRemainingPct / 100);
  }

  // Only flag mixed-model variance when >=2 models share >=10% AND segment rates actually diverge >35%.
  let mixedModelWarning = false;
  const hasMultipleModels = modelMix.filter((m) => m.share >= 0.1).length >= 2;
  if (hasMultipleModels && estimatedPoolUsd != null) {
    const meaningfulSegRates = segments
      .filter((s) => s.deltaU >= Math.max(0.002, s.qK * 2) && s.spendUsd > 0)
      .map((s) => s.spendUsd / s.deltaU);
    if (meaningfulSegRates.length >= 2) {
      const minR = Math.min(...meaningfulSegRates);
      const maxR = Math.max(...meaningfulSegRates);
      if ((maxR - minR) / estimatedPoolUsd > 0.35) {
        mixedModelWarning = true;
      }
    }
  }

  let evenUsePaceRatio = null;
  if (cycleResetAt != null && cycleResetAt > nowMs) {
    const windowMs = windowType === '7d' ? 7 * 86400 * 1000 : 5 * 3600 * 1000;
    const remainingMs = cycleResetAt - nowMs;
    if (remainingMs <= windowMs) {
      const windowStart = cycleResetAt - windowMs;
      const elapsedFrac = Math.max(0.01, Math.min(1, (nowMs - windowStart) / windowMs));
      const currentRem = projectedRemainingPct !== null ? projectedRemainingPct : latestRow.remaining_pct;
      const usedFrac = Math.max(0, Math.min(1, (100 - currentRem) / 100));
      evenUsePaceRatio = usedFrac / elapsedFrac;
    }
  }

  const inheritableResetAt =
    cycleResetAt != null && cycleResetAt > nowMs ? cycleResetAt : null;

  return {
    pool,
    windowType,
    latestAnchor,
    inheritableResetAt,
    spendSinceLastUsd,
    projectedRemainingPct,
    evenUsePaceRatio,
    cycleCount: cycles.length,
    estimation: {
      status,
      totalDeltaPct,
      segmentsUsed: segments.length,
      windowSpendUsd,
      estimatedPoolUsd,
      ciLowUsd,
      ciHighUsd,
      impliedRemainingUsd,
      precisionStepPct,
      modelMix,
      mixedModelWarning,
    },
  };
}

export function getQuotaStatus(cacheDb, pricingState, { pool = null, windowType = null } = {}, nowMs = Date.now()) {
  const filterPool = pool ? normalizePool(pool) : null;
  const filterWin = windowType ? normalizeWindowType(windowType) : null;

  let sql = 'SELECT * FROM quota_anchors';
  const clauses = [];
  const params = [];
  if (filterPool) {
    clauses.push('pool = ?');
    params.push(filterPool);
  }
  if (filterWin) {
    clauses.push('window_type = ?');
    params.push(filterWin);
  }
  if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY captured_at ASC, id ASC';

  const rows = cacheDb.prepare(sql).all(...params);
  const grouped = new Map();
  for (const r of rows) {
    const key = `${r.pool}|${r.window_type}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }

  const pools = filterPool ? [filterPool] : VALID_POOLS;
  const windows = filterWin ? [filterWin] : VALID_WINDOWS;
  const summaries = [];
  for (const p of pools) {
    for (const w of windows) {
      const list = grouped.get(`${p}|${w}`) || [];
      summaries.push(computeSummaryForPair(cacheDb, pricingState, p, w, list, nowMs));
    }
  }

  return {
    anchors: [...rows].reverse().map(formatAnchor),
    summaries,
  };
}
