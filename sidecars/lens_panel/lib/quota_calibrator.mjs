/**
 * Single-cycle orthogonal 3-factor quota weight calibrator (M, C, O)
 * with conservative segment coalescing and Huber robust IRLS smoothing for AGY Lens.
 * Pure Node.js ESM with zero external dependencies.
 */
import { calculateTurnCostBreakdown } from './pricing.mjs';

const MODEL_WEIGHT_MIN = 0.15;
const MODEL_WEIGHT_MAX = 5.0;
const ALPHA_CACHE_MIN = 0.05;
const ALPHA_CACHE_MAX = 20.0;
const ALPHA_OUT_MIN = 0.2;
const ALPHA_OUT_MAX = 5.0;
const LAMBDA_MODEL = 0.25;
const LAMBDA_ALPHA = 0.25;
const NU0_PRIOR = 4.0;
const MAX_VIF_EXPLORE = 20.0;
const MAX_VIF_AUTO = 10.0;
const MIN_EFF_DF_AUTO = 0.35;
const MAX_M_MODELS = 3;
const HUBER_ITERS = 3;
const HUBER_DOWNWEIGHT_THRESHOLD = 0.85;

// Two-tailed 95% Student-t critical values t_{0.975, df} for df = 1..30
const T_CRIT_95_TABLE = [
  null,
  12.7062, 4.3027, 3.1824, 2.7764, 2.5706,
  2.4469, 2.3646, 2.3060, 2.2622, 2.2281,
  2.2010, 2.1788, 2.1604, 2.1448, 2.1314,
  2.1199, 2.1098, 2.1009, 2.0930, 2.0860,
  2.0796, 2.0739, 2.0687, 2.0639, 2.0595,
  2.0555, 2.0518, 2.0484, 2.0452, 2.0423,
];

export function studentTCrit95(df) {
  const v = Number(df);
  if (!Number.isFinite(v) || v <= 1) return T_CRIT_95_TABLE[1];
  if (v >= 30) {
    return 1.959964 + 2.37227 / v + 2.8225 / (v * v);
  }
  const lo = Math.floor(v);
  const hi = Math.ceil(v);
  if (lo === hi) return T_CRIT_95_TABLE[lo];
  const frac = v - lo;
  return T_CRIT_95_TABLE[lo] + frac * (T_CRIT_95_TABLE[hi] - T_CRIT_95_TABLE[lo]);
}

function countSegmentClusters(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return 1;
  let clusters = 1;
  for (let i = 1; i < segments.length; i++) {
    const prevEnd = Number(segments[i - 1]?.endAt);
    const curStart = Number(segments[i]?.startAt);
    if (!Number.isFinite(prevEnd) || !Number.isFinite(curStart) || Math.abs(curStart - prevEnd) > 1000) {
      clusters++;
    }
  }
  return clusters;
}

export const SUBSET_DEFS = [
  { key: 'base', factors: { M: false, C: false, O: false } },
  { key: 'M', factors: { M: true, C: false, O: false } },
  { key: 'C', factors: { M: false, C: true, O: false } },
  { key: 'O', factors: { M: false, C: false, O: true } },
  { key: 'M+C', factors: { M: true, C: true, O: false } },
  { key: 'M+O', factors: { M: true, C: false, O: true } },
  { key: 'C+O', factors: { M: false, C: true, O: true } },
  { key: 'M+C+O', factors: { M: true, C: true, O: true } },
];

export const SUBSET_KEYS = SUBSET_DEFS.map((d) => d.key);

export function factorsToSubsetKey(factors) {
  if (!factors || typeof factors !== 'object') return 'base';
  const parts = [];
  if (factors.M) parts.push('M');
  if (factors.C) parts.push('C');
  if (factors.O) parts.push('O');
  return parts.length > 0 ? parts.join('+') : 'base';
}

export function normalizeSubsetKey(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === 'base') return 'base';
  const up = trimmed.toUpperCase();
  if (up === 'L0') return 'base';
  if (up === 'L1') return 'M';
  if (up === 'L2') return 'M+C';
  if (up === 'L3') return 'M+C+O';
  const tokens = new Set(
    up
      .split('+')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const key = factorsToSubsetKey({
    M: tokens.has('M'),
    C: tokens.has('C'),
    O: tokens.has('O'),
  });
  return SUBSET_KEYS.includes(key) ? key : null;
}

function factorCount(factors) {
  return (factors.M ? 1 : 0) + (factors.C ? 1 : 0) + (factors.O ? 1 : 0);
}

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function sampleStd(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let ss = 0;
  for (const v of arr) {
    const d = v - m;
    ss += d * d;
  }
  return Math.sqrt(ss / (arr.length - 1));
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function makeLogGrid(minVal, maxVal, count, includeVals = []) {
  const pts = [];
  const lo = Math.log(minVal);
  const hi = Math.log(maxVal);
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    pts.push(Math.exp(lo + t * (hi - lo)));
  }
  for (const v of includeVals) pts.push(v);
  pts.sort((a, b) => a - b);
  const out = [];
  for (const p of pts) {
    if (out.length === 0 || Math.abs(p - out[out.length - 1]) > 1e-9) {
      out.push(p);
    }
  }
  return out;
}

function makeLinearGrid(minVal, maxVal, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    out.push(minVal + t * (maxVal - minVal));
  }
  return out;
}

function solveLinearSystem(A, b) {
  const n = A.length;
  if (n === 0) return [];
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivotRow = r;
      }
    }
    if (pivotAbs <= 1e-14) return null;
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }
    const piv = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) {
        M[r][j] -= factor * M[col][j];
      }
    }
  }
  return M.map((row) => row[n]);
}

function invertMatrix(A) {
  const n = A.length;
  if (n === 0) return [];
  const M = A.map((row, i) => {
    const aug = new Array(n).fill(0);
    aug[i] = 1;
    return [...row, ...aug];
  });
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivotRow = r;
      }
    }
    if (pivotAbs <= 1e-12) return null;
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }
    const piv = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) {
        M[r][j] -= factor * M[col][j];
      }
    }
  }
  return M.map((row) => row.slice(n));
}

function matMul(A, B) {
  const r = A.length;
  const k = A[0]?.length || 0;
  const c = B[0]?.length || 0;
  const out = Array.from({ length: r }, () => new Array(c).fill(0));
  for (let i = 0; i < r; i++) {
    for (let m = 0; m < k; m++) {
      const a = A[i][m];
      if (a === 0) continue;
      for (let j = 0; j < c; j++) {
        out[i][j] += a * B[m][j];
      }
    }
  }
  return out;
}

function computeMaxVif(rows, weights) {
  const p = rows[0]?.length || 0;
  if (p <= 1) return 1;
  const G = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let k = 0; k < rows.length; k++) {
    const w = weights[k];
    const row = rows[k];
    for (let i = 0; i < p; i++) {
      const wi = w * row[i];
      for (let j = i; j < p; j++) {
        G[i][j] += wi * row[j];
      }
    }
  }
  for (let i = 0; i < p; i++) {
    if (G[i][i] <= 1e-18) return Infinity;
    for (let j = 0; j < i; j++) G[i][j] = G[j][i];
  }
  const R = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      R[i][j] = G[i][j] / Math.sqrt(G[i][i] * G[j][j]);
    }
  }
  const invR = invertMatrix(R);
  if (!invR) return Infinity;
  let maxVif = 1;
  for (let i = 0; i < p; i++) {
    if (!Number.isFinite(invR[i][i])) return Infinity;
    maxVif = Math.max(maxVif, invR[i][i]);
  }
  return maxVif;
}

/**
 * Conservatively coalesce noisy settlement-lag intervals, short-gap bursts,
 * and micro-rebounds across raw consecutive anchor intervals without dropping turns or spend.
 */
export function coalesceRawSegments(rawSegments, { minDurationMs = 0 } = {}) {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return {
      segments: [],
      rawSegmentsCount: 0,
      coalescedCount: 0,
      reboundMergedCount: 0,
      shortGapMergedCount: 0,
    };
  }

  const m = rawSegments.length;
  const coalesced = [];
  let startIdx = 0;
  let cumSpendUsd = 0;
  let cumDeltaU = 0;
  let cumTurns = [];
  let reboundMergedCount = 0;
  let shortGapMergedCount = 0;

  const pairDelta = (sIdx, eIdx) => {
    const first = rawSegments[sIdx];
    const last = rawSegments[eIdx];
    if (first.startPct != null && last.endPct != null) {
      return (first.startPct - last.endPct) / 100;
    }
    let sum = 0;
    for (let k = sIdx; k <= eIdx; k++) sum += rawSegments[k].deltaU || 0;
    return sum;
  };

  const pairQK = (sIdx, eIdx) => {
    const first = rawSegments[sIdx];
    const last = rawSegments[eIdx];
    if (first.startPrecisionStep != null && last.endPrecisionStep != null) {
      return Math.max(first.startPrecisionStep, last.endPrecisionStep) / 100;
    }
    let maxQ = 0;
    for (let k = sIdx; k <= eIdx; k++) {
      maxQ = Math.max(maxQ, rawSegments[k].qK || 0.0001);
    }
    return maxQ || 0.0001;
  };

  const countReboundsInRange = (sIdx, eIdx) => {
    let cnt = 0;
    for (let k = sIdx; k <= eIdx; k++) {
      if ((rawSegments[k].deltaU || 0) <= 0) cnt++;
    }
    return cnt;
  };

  for (let i = 0; i < m; i++) {
    const cur = rawSegments[i];
    const first = rawSegments[startIdx];
    cumSpendUsd += cur.spendUsd || 0;
    if (Array.isArray(cur.turns) && cur.turns.length > 0) {
      cumTurns.push(...cur.turns);
    }
    cumDeltaU = pairDelta(startIdx, i);
    const qPair = pairQK(startIdx, i);
    const minSegDelta = Math.max(5 * qPair, 0.0015);
    const durationMs =
      first.startAt != null && cur.endAt != null
        ? Math.max(0, cur.endAt - first.startAt)
        : Infinity;
    const meetsDuration = minDurationMs <= 0 || durationMs >= minDurationMs;
    const isLast = i === m - 1;

    const canEmitRegular = cumDeltaU >= minSegDelta && meetsDuration;
    const canEmitFinalStandalone =
      isLast &&
      cumDeltaU >= 5 * qPair &&
      (meetsDuration || coalesced.length === 0);

    if (canEmitRegular || canEmitFinalStandalone) {
      const rawCount = i - startIdx + 1;
      reboundMergedCount += countReboundsInRange(startIdx, i);
      coalesced.push({
        _startRawIdx: startIdx,
        startAt: first.startAt,
        endAt: cur.endAt,
        startPct: first.startPct ?? null,
        endPct: cur.endPct ?? null,
        startPrecisionStep: first.startPrecisionStep ?? null,
        endPrecisionStep: cur.endPrecisionStep ?? null,
        deltaU: cumDeltaU,
        qK: qPair,
        spendUsd: cumSpendUsd,
        turns: cumTurns,
        anchorCount: rawCount,
        mergedFromRawCount: rawCount,
      });
      startIdx = i + 1;
      cumSpendUsd = 0;
      cumDeltaU = 0;
      cumTurns = [];
    } else if (!isLast) {
      if (cumDeltaU >= minSegDelta && !meetsDuration) {
        shortGapMergedCount++;
      }
    } else if (isLast && coalesced.length >= 1) {
      // Conserve tiny tail, short trailing burst, or minor trailing rebound into the previous coalesced segment
      if (cumDeltaU >= 5 * qPair && !meetsDuration) {
        shortGapMergedCount++;
      }
      const prev = coalesced[coalesced.length - 1];
      const prevStart = rawSegments[prev._startRawIdx];
      const lowerThanPrevStart =
        prevStart.startPct != null && cur.endPct != null
          ? cur.endPct < prevStart.startPct
          : prev.deltaU + cumDeltaU > 0;
      if (lowerThanPrevStart) {
        const combinedDeltaU = pairDelta(prev._startRawIdx, i);
        const combinedQK = pairQK(prev._startRawIdx, i);
        if (combinedDeltaU >= 5 * combinedQK) {
          const addedRaw = i - startIdx + 1;
          reboundMergedCount += countReboundsInRange(startIdx, i);
          prev.endAt = cur.endAt;
          prev.endPct = cur.endPct ?? prev.endPct;
          prev.endPrecisionStep = cur.endPrecisionStep ?? prev.endPrecisionStep;
          prev.deltaU = combinedDeltaU;
          prev.qK = combinedQK;
          prev.spendUsd += cumSpendUsd;
          if (cumTurns.length > 0) prev.turns.push(...cumTurns);
          prev.anchorCount += addedRaw;
          prev.mergedFromRawCount += addedRaw;
        }
      }
    }
  }

  for (const seg of coalesced) {
    delete seg._startRawIdx;
  }

  const coalescedCount = coalesced.reduce(
    (acc, seg) => acc + Math.max(0, (seg.mergedFromRawCount || 1) - 1),
    0
  );

  return {
    segments: coalesced,
    rawSegmentsCount: m,
    coalescedCount,
    reboundMergedCount,
    shortGapMergedCount,
  };
}

function aggregateTurnsByModel(turns, pricingState, useListPrice) {
  const byModel = new Map();
  const turnCosts = [];
  let rawSpendUsd = 0;
  let hasPromoTurns = false;
  let hasNonPromoTurns = false;

  for (const t of turns) {
    const b = calculateTurnCostBreakdown(t, pricingState, { useListPrice });
    if (b.unpriced) continue;
    rawSpendUsd += b.totalUsd;
    if (b.totalUsd > 0) turnCosts.push(b.totalUsd);
    if (b.isPromo) hasPromoTurns = true;
    else hasNonPromoTurns = true;

    let m = byModel.get(b.canonicalId);
    if (!m) {
      m = {
        canonicalId: b.canonicalId,
        inUsd: 0,
        cacheReadUsd: 0,
        cacheWriteUsd: 0,
        outUsd: 0,
        totalUsd: 0,
        hasPromo: false,
        hasNonPromo: false,
      };
      byModel.set(b.canonicalId, m);
    }
    m.inUsd += b.inUsd;
    m.cacheReadUsd += b.cacheReadUsd;
    m.cacheWriteUsd += b.cacheWriteUsd;
    m.outUsd += b.outUsd;
    m.totalUsd += b.totalUsd;
    if (b.isPromo) m.hasPromo = true;
    else m.hasNonPromo = true;
  }

  return { byModel, rawSpendUsd, turnCosts, hasPromoTurns, hasNonPromoTurns };
}

function modelSpendAt(bucket, alphaCache, alphaOut) {
  if (!bucket) return 0;
  return (
    bucket.inUsd +
    alphaCache * bucket.cacheReadUsd +
    bucket.cacheWriteUsd +
    alphaOut * bucket.outUsd
  );
}

function segmentTotalWeightedSpend(seg, alphaCache, alphaOut, weightsMap) {
  let sum = 0;
  for (const [mId, bucket] of seg.byModel.entries()) {
    const w = weightsMap.get(mId) ?? 1.0;
    sum += w * modelSpendAt(bucket, alphaCache, alphaOut);
  }
  return sum;
}

/**
 * Solve convex WLS for gamma_m = beta * w_m with symmetric log-penalty around w_m = 1.
 * Base column (index 0) aggregates anchorModel + minor models + any clamped models.
 */
function solveModelMultipliers(segments, weights, anchorModel, candidateModels, alphaCache, alphaOut) {
  const N = segments.length;
  const allCandidates = [...candidateModels];
  const fixedWeights = new Map();
  const clampedSet = new Set();

  let num0 = 0;
  let den0 = 0;
  for (let k = 0; k < N; k++) {
    let totalS = 0;
    for (const bucket of segments[k].byModel.values()) {
      totalS += modelSpendAt(bucket, alphaCache, alphaOut);
    }
    num0 += weights[k] * segments[k].y_k * totalS;
    den0 += weights[k] * totalS * totalS;
  }
  const beta0 = den0 > 0 ? Math.max(1e-9, num0 / den0) : 1e-3;

  let active = [...allCandidates];
  let beta = beta0;

  for (let clampRound = 0; clampRound <= allCandidates.length; clampRound++) {
    const p = 1 + active.length;
    const X = Array.from({ length: N }, (_, k) => {
      const row = new Array(p).fill(0);
      const activeIdx = new Map();
      active.forEach((m, idx) => activeIdx.set(m, idx + 1));

      for (const [mId, bucket] of segments[k].byModel.entries()) {
        const s = modelSpendAt(bucket, alphaCache, alphaOut);
        if (activeIdx.has(mId)) {
          row[activeIdx.get(mId)] += s;
        } else {
          const fw = fixedWeights.has(mId) ? fixedWeights.get(mId) : 1.0;
          row[0] += fw * s;
        }
      }
      return row;
    });

    if (active.length === 0) {
      let num = 0;
      let den = 0;
      for (let k = 0; k < N; k++) {
        num += weights[k] * segments[k].y_k * X[k][0];
        den += weights[k] * X[k][0] * X[k][0];
      }
      beta = den > 0 ? Math.max(1e-9, num / den) : beta0;
      break;
    }

    const XtWX = Array.from({ length: p }, () => new Array(p).fill(0));
    const XtWy = new Array(p).fill(0);
    for (let k = 0; k < N; k++) {
      const wk = weights[k];
      const yk = segments[k].y_k;
      const row = X[k];
      for (let i = 0; i < p; i++) {
        const wi = wk * row[i];
        XtWy[i] += wi * yk;
        for (let j = i; j < p; j++) {
          XtWX[i][j] += wi * row[j];
        }
      }
    }
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < i; j++) XtWX[i][j] = XtWX[j][i];
    }

    let gamma = new Array(p).fill(beta0);
    for (let iter = 0; iter < 6; iter++) {
      const H = XtWX.map((r) => [...r]);
      const rhs = [...XtWy];
      for (let c = 1; c < p; c++) {
        const g0 = Math.max(1e-12, gamma[0]);
        const gc = Math.max(1e-12, gamma[c]);
        const z = Math.log(gc / g0);
        const j0 = -1 / g0;
        const jc = 1 / gc;
        H[0][0] += LAMBDA_MODEL * j0 * j0;
        H[0][c] += LAMBDA_MODEL * j0 * jc;
        H[c][0] += LAMBDA_MODEL * jc * j0;
        H[c][c] += LAMBDA_MODEL * jc * jc;
        rhs[0] -= LAMBDA_MODEL * j0 * z;
        rhs[c] -= LAMBDA_MODEL * jc * z;
      }
      const next = solveLinearSystem(H, rhs);
      if (!next) break;
      for (let i = 0; i < p; i++) {
        gamma[i] = Math.max(1e-10, next[i]);
      }
    }

    beta = Math.max(1e-10, gamma[0]);
    let worstIdx = -1;
    let worstExcess = 0;
    let worstVal = 1;
    for (let c = 1; c < p; c++) {
      const w = gamma[c] / beta;
      if (w < MODEL_WEIGHT_MIN && MODEL_WEIGHT_MIN - w > worstExcess) {
        worstExcess = MODEL_WEIGHT_MIN - w;
        worstIdx = c - 1;
        worstVal = MODEL_WEIGHT_MIN;
      } else if (w > MODEL_WEIGHT_MAX && w - MODEL_WEIGHT_MAX > worstExcess) {
        worstExcess = w - MODEL_WEIGHT_MAX;
        worstIdx = c - 1;
        worstVal = MODEL_WEIGHT_MAX;
      }
    }

    if (worstIdx >= 0) {
      const clampedModel = active[worstIdx];
      fixedWeights.set(clampedModel, worstVal);
      clampedSet.add(clampedModel);
      active.splice(worstIdx, 1);
      continue;
    }

    for (let c = 1; c < p; c++) {
      fixedWeights.set(active[c - 1], gamma[c] / beta);
    }
    break;
  }

  const modelWeights = new Map();
  modelWeights.set(anchorModel, 1.0);
  for (const m of candidateModels) {
    modelWeights.set(m, fixedWeights.get(m) ?? 1.0);
  }

  let chi2Data = 0;
  const yHat = new Array(N);
  for (let k = 0; k < N; k++) {
    const s = segmentTotalWeightedSpend(segments[k], alphaCache, alphaOut, modelWeights);
    const pred = beta * s;
    yHat[k] = pred;
    const diff = segments[k].y_k - pred;
    chi2Data += weights[k] * diff * diff;
  }

  let penaltyModel = 0;
  for (const m of candidateModels) {
    const w = modelWeights.get(m) ?? 1.0;
    const lw = Math.log(Math.max(1e-6, w));
    penaltyModel += LAMBDA_MODEL * lw * lw;
  }

  return {
    beta,
    modelWeights,
    freeCandidates: active,
    clampedSet,
    yHat,
    chi2Data,
    obj: chi2Data + penaltyModel,
  };
}

function fitSubsetCore(
  subsetKey,
  segments,
  weights,
  anchorModel,
  candidateModels,
  { fitModels = false, fitCache = false, fitOut = false } = {}
) {
  const activeModels = fitModels ? candidateModels : [];
  let alphaCache = 1.0;
  let alphaOut = 1.0;
  let cacheClamped = false;
  let outClamped = false;
  let bestFit = null;

  const evalPoint = (ac, ao) => {
    const fit = solveModelMultipliers(segments, weights, anchorModel, activeModels, ac, ao);
    const penAc = fitCache ? LAMBDA_ALPHA * Math.log(Math.max(0.05, ac)) ** 2 : 0;
    const penAo = fitOut ? LAMBDA_ALPHA * Math.log(ao) ** 2 : 0;
    return {
      ac,
      ao,
      fit,
      totalObj: fit.obj + penAc + penAo,
    };
  };

  if (!fitCache && !fitOut) {
    bestFit = evalPoint(1.0, 1.0);
  } else if (fitCache && !fitOut) {
    // 1D 36-point log profile grid + 9-point refinement on alpha_cache in [ALPHA_CACHE_MIN, ALPHA_CACHE_MAX]
    const coarseGrid = makeLogGrid(ALPHA_CACHE_MIN, ALPHA_CACHE_MAX, 35, [1.0]);
    let bestIdx = 0;
    let bestRes = Infinity;
    for (let i = 0; i < coarseGrid.length; i++) {
      const res = evalPoint(coarseGrid[i], 1.0);
      if (res.totalObj < bestRes) {
        bestRes = res.totalObj;
        bestIdx = i;
        bestFit = res;
      }
    }
    const lo = coarseGrid[Math.max(0, bestIdx - 1)];
    const hi = coarseGrid[Math.min(coarseGrid.length - 1, bestIdx + 1)];
    const fineGrid = makeLogGrid(lo, hi, 9, [coarseGrid[bestIdx]]);
    for (const ac of fineGrid) {
      const res = evalPoint(ac, 1.0);
      if (res.totalObj < bestFit.totalObj) {
        bestFit = res;
      }
    }
    alphaCache = bestFit.ac;
    if (alphaCache <= ALPHA_CACHE_MIN + 1e-4) {
      alphaCache = ALPHA_CACHE_MIN;
      cacheClamped = true;
    } else if (alphaCache >= ALPHA_CACHE_MAX - 1e-4) {
      alphaCache = ALPHA_CACHE_MAX;
      cacheClamped = true;
    }
  } else if (!fitCache && fitOut) {
    // 1D 32-point log profile grid + 9-point refinement on alpha_out
    const coarseGrid = makeLogGrid(ALPHA_OUT_MIN, ALPHA_OUT_MAX, 31, [1.0]);
    let bestIdx = 0;
    let bestRes = Infinity;
    for (let i = 0; i < coarseGrid.length; i++) {
      const res = evalPoint(1.0, coarseGrid[i]);
      if (res.totalObj < bestRes) {
        bestRes = res.totalObj;
        bestIdx = i;
        bestFit = res;
      }
    }
    const lo = coarseGrid[Math.max(0, bestIdx - 1)];
    const hi = coarseGrid[Math.min(coarseGrid.length - 1, bestIdx + 1)];
    const fineGrid = makeLogGrid(lo, hi, 9, [coarseGrid[bestIdx]]);
    for (const ao of fineGrid) {
      const res = evalPoint(1.0, ao);
      if (res.totalObj < bestFit.totalObj) {
        bestFit = res;
      }
    }
    alphaOut = bestFit.ao;
    if (alphaOut <= ALPHA_OUT_MIN + 1e-4) {
      alphaOut = ALPHA_OUT_MIN;
      outClamped = true;
    } else if (alphaOut >= ALPHA_OUT_MAX - 1e-4) {
      alphaOut = ALPHA_OUT_MAX;
      outClamped = true;
    }
  } else {
    // 2D 18x18 coarse log grid + 5x5 local refinement on (alpha_cache, alpha_out)
    const acCoarse = makeLogGrid(ALPHA_CACHE_MIN, ALPHA_CACHE_MAX, 17, [1.0]);
    const aoCoarse = makeLogGrid(ALPHA_OUT_MIN, ALPHA_OUT_MAX, 17, [1.0]);
    let bestIc = 0;
    let bestIo = 0;
    let bestRes = Infinity;
    for (let ic = 0; ic < acCoarse.length; ic++) {
      for (let io = 0; io < aoCoarse.length; io++) {
        const res = evalPoint(acCoarse[ic], aoCoarse[io]);
        if (res.totalObj < bestRes) {
          bestRes = res.totalObj;
          bestIc = ic;
          bestIo = io;
          bestFit = res;
        }
      }
    }
    const acLo = acCoarse[Math.max(0, bestIc - 1)];
    const acHi = acCoarse[Math.min(acCoarse.length - 1, bestIc + 1)];
    const aoLo = aoCoarse[Math.max(0, bestIo - 1)];
    const aoHi = aoCoarse[Math.min(aoCoarse.length - 1, bestIo + 1)];
    const acFine = makeLogGrid(acLo, acHi, 5, [acCoarse[bestIc]]);
    const aoFine = makeLogGrid(aoLo, aoHi, 5, [aoCoarse[bestIo]]);
    for (const ac of acFine) {
      for (const ao of aoFine) {
        const res = evalPoint(ac, ao);
        if (res.totalObj < bestFit.totalObj) {
          bestFit = res;
        }
      }
    }
    alphaCache = bestFit.ac;
    alphaOut = bestFit.ao;
    if (alphaCache <= ALPHA_CACHE_MIN + 1e-4) {
      alphaCache = ALPHA_CACHE_MIN;
      cacheClamped = true;
    } else if (alphaCache >= ALPHA_CACHE_MAX - 1e-4) {
      alphaCache = ALPHA_CACHE_MAX;
      cacheClamped = true;
    }
    if (alphaOut <= ALPHA_OUT_MIN + 1e-4) {
      alphaOut = ALPHA_OUT_MIN;
      outClamped = true;
    } else if (alphaOut >= ALPHA_OUT_MAX - 1e-4) {
      alphaOut = ALPHA_OUT_MAX;
      outClamped = true;
    }
  }

  return {
    subsetKey,
    beta: bestFit.fit.beta,
    modelWeights: bestFit.fit.modelWeights,
    fittedCandidates: activeModels,
    freeCandidates: bestFit.fit.freeCandidates,
    clampedSet: bestFit.fit.clampedSet,
    alphaCache,
    alphaOut,
    cacheClamped,
    outClamped,
    yHat: bestFit.fit.yHat,
    chi2Data: bestFit.fit.chi2Data,
  };
}

function computeHuberFactors(residuals, sigmaVec) {
  const absZ = residuals.map((rk, k) => Math.abs(rk) / sigmaVec[k]);
  const madZ = median(absZ);
  return residuals.map((rk, k) => {
    const delta = Math.max(2.0 * sigmaVec[k], 0.0025, 1.5 * madZ * sigmaVec[k]);
    const ar = Math.abs(rk);
    return ar <= delta ? 1.0 : delta / ar;
  });
}

function computeHuberLoss(residuals, sigmaVec, baseWeights) {
  const absZ = residuals.map((rk, k) => Math.abs(rk) / sigmaVec[k]);
  const madZ = median(absZ);
  let loss = 0;
  for (let k = 0; k < residuals.length; k++) {
    const delta = Math.max(2.0 * sigmaVec[k], 0.0025, 1.5 * madZ * sigmaVec[k]);
    const ar = Math.abs(residuals[k]);
    const rho = ar <= delta ? 0.5 * ar * ar : delta * (ar - 0.5 * delta);
    loss += baseWeights[k] * rho;
  }
  return loss;
}

/**
 * Wrap WLS fitting with 3 iterations of Huber robust reweighting when N >= 4.
 */
function fitSubsetWithHuber(
  subsetKey,
  segments,
  baseWeights,
  sigmaVec,
  anchorModel,
  candidateModels,
  factorFlags,
  fallbackHuberFactors = null
) {
  const N = segments.length;
  if (N < 4) {
    const coreFit = fitSubsetCore(
      subsetKey,
      segments,
      baseWeights,
      anchorModel,
      candidateModels,
      factorFlags
    );
    return {
      coreFit,
      effectiveWeights: baseWeights,
      huberFactors: new Array(N).fill(1.0),
    };
  }

  let huberFactors;
  if (!factorFlags.fitModels && !factorFlags.fitCache && !factorFlags.fitOut) {
    // Protect 1-param base fit against high-leverage lag spikes via median slope initialization
    const ratios = segments
      .filter((s) => s.rawSpendUsd > 0)
      .map((s) => s.y_k / s.rawSpendUsd);
    const betaMed = ratios.length > 0 ? Math.max(1e-9, median(ratios)) : 1e-3;
    const medRes = segments.map((s) => s.y_k - betaMed * s.rawSpendUsd);
    huberFactors = computeHuberFactors(medRes, sigmaVec);
  } else {
    const rawInit = fitSubsetCore(
      subsetKey,
      segments,
      baseWeights,
      anchorModel,
      candidateModels,
      factorFlags
    );
    const rawRes = segments.map((s, k) => s.y_k - rawInit.yHat[k]);
    huberFactors = computeHuberFactors(rawRes, sigmaVec);

    if (fallbackHuberFactors) {
      const altWeights = baseWeights.map((bw, k) => bw * fallbackHuberFactors[k]);
      const altInit = fitSubsetCore(
        subsetKey,
        segments,
        altWeights,
        anchorModel,
        candidateModels,
        factorFlags
      );
      const altRes = segments.map((s, k) => s.y_k - altInit.yHat[k]);
      if (
        computeHuberLoss(altRes, sigmaVec, baseWeights) <
        computeHuberLoss(rawRes, sigmaVec, baseWeights)
      ) {
        huberFactors = computeHuberFactors(altRes, sigmaVec);
      }
    }
  }

  let effWeights = baseWeights;
  let coreFit = null;
  for (let iter = 0; iter < HUBER_ITERS; iter++) {
    effWeights = baseWeights.map((bw, k) => bw * huberFactors[k]);
    coreFit = fitSubsetCore(
      subsetKey,
      segments,
      effWeights,
      anchorModel,
      candidateModels,
      factorFlags
    );
    const residuals = segments.map((s, k) => s.y_k - coreFit.yHat[k]);
    huberFactors = computeHuberFactors(residuals, sigmaVec);
  }

  return {
    coreFit,
    effectiveWeights: effWeights,
    huberFactors,
  };
}

function computeJacobianAndStats(
  coreFit,
  segments,
  weights,
  anchorModel,
  { fitCache = false, fitOut = false, cycleBuckets = null, sumCycleRaw = 0 } = {}
) {
  const N = segments.length;
  // Retain boundary-clamped columns in J and Cov so SE is conservative rather than treating clamped params as known.
  const fittedModels = Array.isArray(coreFit.fittedCandidates)
    ? coreFit.fittedCandidates
    : coreFit.freeCandidates || [];

  const colCount = 1 + fittedModels.length + (fitCache ? 1 : 0) + (fitOut ? 1 : 0);
  const activeIdx = new Map();
  fittedModels.forEach((m, idx) => activeIdx.set(m, idx + 1));

  function buildJacobianRow(byModelEntries) {
    const row = new Array(colCount).fill(0);
    let crSum = 0;
    let outSum = 0;
    for (const [mId, bucket] of byModelEntries) {
      const s = modelSpendAt(bucket, coreFit.alphaCache, coreFit.alphaOut);
      if (activeIdx.has(mId)) {
        row[activeIdx.get(mId)] += s;
      } else {
        const fw = coreFit.modelWeights.get(mId) ?? 1.0;
        row[0] += fw * s;
      }
      const w = coreFit.modelWeights.get(mId) ?? 1.0;
      crSum += coreFit.beta * w * bucket.cacheReadUsd;
      outSum += coreFit.beta * w * bucket.outUsd;
    }
    let cIdx = 1 + fittedModels.length;
    if (fitCache) row[cIdx++] = crSum;
    if (fitOut) row[cIdx++] = outSum;
    return row;
  }

  const J = Array.from({ length: N }, (_, k) => buildJacobianRow(segments[k].byModel.entries()));

  // Compute VIF on non-overlapping linear basis D so large alpha_cache / alpha_out
  // values do not artificially inflate collinearity between column 0 and alpha columns.
  const D = Array.from({ length: N }, (_, k) => {
    const row = new Array(colCount).fill(0);
    let crSum = 0;
    let outSum = 0;
    for (const [mId, bucket] of segments[k].byModel.entries()) {
      const sBase =
        bucket.inUsd +
        bucket.cacheWriteUsd +
        (fitCache ? 0 : coreFit.alphaCache * bucket.cacheReadUsd) +
        (fitOut ? 0 : coreFit.alphaOut * bucket.outUsd);
      if (activeIdx.has(mId)) {
        row[activeIdx.get(mId)] += sBase;
      } else {
        const fw = coreFit.modelWeights.get(mId) ?? 1.0;
        row[0] += fw * sBase;
      }
      const w = coreFit.modelWeights.get(mId) ?? 1.0;
      crSum += w * bucket.cacheReadUsd;
      outSum += w * bucket.outUsd;
    }

    let cIdx = 1 + fittedModels.length;
    if (fitCache) row[cIdx++] = crSum;
    if (fitOut) row[cIdx++] = outSum;
    return row;
  });

  const maxVif = computeMaxVif(D, weights);

  const G = Array.from({ length: colCount }, () => new Array(colCount).fill(0));
  for (let k = 0; k < N; k++) {
    const wk = weights[k];
    const row = J[k];
    for (let i = 0; i < colCount; i++) {
      const wi = wk * row[i];
      for (let j = i; j < colCount; j++) {
        G[i][j] += wi * row[j];
      }
    }
  }
  for (let i = 0; i < colCount; i++) {
    for (let j = 0; j < i; j++) G[i][j] = G[j][i];
  }

  const P = Array.from({ length: colCount }, () => new Array(colCount).fill(0));
  for (let c = 1; c <= fittedModels.length; c++) {
    const mId = fittedModels[c - 1];
    const g0 = Math.max(1e-12, coreFit.beta);
    const gc = Math.max(1e-12, coreFit.beta * (coreFit.modelWeights.get(mId) ?? 1.0));
    const j0 = -1 / g0;
    const jc = 1 / gc;
    P[0][0] += LAMBDA_MODEL * j0 * j0;
    P[0][c] += LAMBDA_MODEL * j0 * jc;
    P[c][0] += LAMBDA_MODEL * jc * j0;
    P[c][c] += LAMBDA_MODEL * jc * jc;
  }
  let cIdx = 1 + fittedModels.length;
  if (fitCache) {
    const ac = Math.max(ALPHA_CACHE_MIN, coreFit.alphaCache);
    P[cIdx][cIdx] += LAMBDA_ALPHA / (ac * ac);
    cIdx++;
  }
  if (fitOut) {
    const ao = Math.max(ALPHA_OUT_MIN, coreFit.alphaOut);
    P[cIdx][cIdx] += LAMBDA_ALPHA / (ao * ao);
    cIdx++;
  }

  const GP = G.map((row, i) => row.map((val, j) => val + P[i][j]));
  const invGP = invertMatrix(GP);

  let effDf = colCount;
  let minParamEffDf = 1;
  let dof = Math.max(0, N - effDf);
  let totalDof = NU0_PRIOR + dof;
  let s2Post = (NU0_PRIOR * 1 + coreFit.chi2Data) / totalDof;
  let tCrit = studentTCrit95(totalDof);
  let seBeta = null;
  let seBetaMix = null;
  const seModels = new Map();
  let seCache = null;
  let seOut = null;

  if (invGP) {
    const hatMat = matMul(invGP, G);
    let tr = 0;
    for (let i = 0; i < colCount; i++) tr += hatMat[i][i];
    effDf = Math.max(1, Math.min(colCount, tr));
    if (colCount > 1) {
      minParamEffDf = 1;
      for (let i = 1; i < colCount; i++) {
        minParamEffDf = Math.min(minParamEffDf, Math.max(0, hatMat[i][i]));
      }
    }

    // Empirical Bayes scaled inverse-chi2 posterior dispersion with pseudo-df NU0_PRIOR = 4
    dof = Math.max(0, N - effDf);
    totalDof = NU0_PRIOR + dof;
    s2Post = (NU0_PRIOR * 1 + coreFit.chi2Data) / totalDof;
    tCrit = studentTCrit95(totalDof);
    const cov = invGP.map((row) => row.map((v) => v * s2Post));

    seBeta = cov[0][0] >= 0 ? Math.sqrt(cov[0][0]) : null;

    // Exact Delta Method for effective mixed-workload burn rate beta_mix = (beta * S_cycle_weighted) / sumCycleRaw
    if (Array.isArray(cycleBuckets) && cycleBuckets.length > 0 && sumCycleRaw > 0) {
      const mergedCycle = new Map();
      for (const b of cycleBuckets) {
        for (const [mId, mb] of b.byModel.entries()) {
          let agg = mergedCycle.get(mId);
          if (!agg) {
            agg = { inUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, outUsd: 0, totalUsd: 0 };
            mergedCycle.set(mId, agg);
          }
          agg.inUsd += mb.inUsd;
          agg.cacheReadUsd += mb.cacheReadUsd;
          agg.cacheWriteUsd += mb.cacheWriteUsd;
          agg.outUsd += mb.outUsd;
          agg.totalUsd += mb.totalUsd;
        }
      }
      const gMix = buildJacobianRow(mergedCycle.entries()).map((v) => v / sumCycleRaw);
      let varMix = 0;
      for (let i = 0; i < colCount; i++) {
        for (let j = 0; j < colCount; j++) {
          varMix += gMix[i] * cov[i][j] * gMix[j];
        }
      }
      seBetaMix = varMix >= 0 ? Math.sqrt(varMix) : seBeta;
    } else {
      seBetaMix = seBeta;
    }

    for (let c = 1; c <= fittedModels.length; c++) {
      const mId = fittedModels[c - 1];
      const w = coreFit.modelWeights.get(mId) ?? 1.0;
      const g0 = Math.max(1e-12, coreFit.beta);
      const d0 = -w / g0;
      const dc = 1 / g0;
      const varW =
        d0 * d0 * cov[0][0] +
        2 * d0 * dc * cov[0][c] +
        dc * dc * cov[c][c];
      seModels.set(mId, varW >= 0 ? Math.sqrt(varW) : null);
    }

    let pIdx = 1 + fittedModels.length;
    if (fitCache) {
      seCache = cov[pIdx][pIdx] >= 0 ? Math.sqrt(cov[pIdx][pIdx]) : null;
      pIdx++;
    }
    if (fitOut) {
      seOut = cov[pIdx][pIdx] >= 0 ? Math.sqrt(cov[pIdx][pIdx]) : null;
      pIdx++;
    }
  }

  const chi2Score = coreFit.chi2Data + 2 * effDf;

  return {
    maxVif,
    effDf,
    minParamEffDf,
    dof,
    totalDof,
    s2Post,
    tCrit,
    chi2Score,
    seBeta,
    seBetaMix,
    seModels,
    seCache,
    seOut,
  };
}

function computeWeightedMaePp(segments, weights, yHat) {
  let sumW = 0;
  let sumErr = 0;
  for (let k = 0; k < segments.length; k++) {
    sumW += weights[k];
    sumErr += weights[k] * Math.abs(segments[k].y_k - yHat[k]);
  }
  return sumW > 0 ? (100 * sumErr) / sumW : 0;
}

function computeLoocvMaePp(
  subsetKey,
  segments,
  weights,
  anchorModel,
  candidateModels,
  { fitModels = false, fitCache = false, fitOut = false } = {}
) {
  const N = segments.length;
  if (N < 2) return null;

  let sumW = 0;
  let sumErr = 0;

  for (let drop = 0; drop < N; drop++) {
    const trainSegs = [];
    const trainWeights = [];
    for (let k = 0; k < N; k++) {
      if (k !== drop) {
        trainSegs.push(segments[k]);
        trainWeights.push(weights[k]);
      }
    }

    const foldCandidates = [];
    if (fitModels) {
      for (const m of candidateModels) {
        let sumM = 0;
        for (const s of trainSegs) sumM += s.byModel.get(m)?.totalUsd || 0;
        if (sumM > 0) foldCandidates.push(m);
      }
    }

    let foldFitCache = fitCache;
    if (foldFitCache) {
      const crShares = trainSegs.map((s) => {
        let cr = 0;
        for (const b of s.byModel.values()) cr += b.cacheReadUsd;
        return s.rawSpendUsd > 0 ? cr / s.rawSpendUsd : 0;
      });
      if (sampleStd(crShares) < 1e-6) foldFitCache = false;
    }

    let foldFitOut = fitOut;
    if (foldFitOut) {
      const outShares = trainSegs.map((s) => {
        let o = 0;
        for (const b of s.byModel.values()) o += b.outUsd;
        return s.rawSpendUsd > 0 ? o / s.rawSpendUsd : 0;
      });
      if (sampleStd(outShares) < 1e-6) foldFitOut = false;
    }

    const foldFit = fitSubsetCore(
      subsetKey,
      trainSegs,
      trainWeights,
      anchorModel,
      foldCandidates,
      {
        fitModels: foldCandidates.length > 0,
        fitCache: foldFitCache,
        fitOut: foldFitOut,
      }
    );

    const heldSeg = segments[drop];
    const predDrop =
      foldFit.beta *
      segmentTotalWeightedSpend(heldSeg, foldFit.alphaCache, foldFit.alphaOut, foldFit.modelWeights);
    sumW += weights[drop];
    sumErr += weights[drop] * Math.abs(heldSeg.y_k - predDrop);
  }

  return sumW > 0 ? (100 * sumErr) / sumW : null;
}

function buildEmptySubsetResult(
  def,
  eligible,
  reasonObj,
  paramCount,
  allModels,
  anchorModel
) {
  const r =
    reasonObj && typeof reasonObj === 'object'
      ? reasonObj
      : { reason: String(reasonObj || ''), reasonCode: '', reasonParams: null };
  return {
    key: def.key,
    eligible,
    autoEligible: eligible && def.key === 'base',
    exploratory: false,
    reason: r.reason || '',
    reasonCode: r.reasonCode || '',
    reasonParams: r.reasonParams || null,
    autoReason: r.reason || '',
    autoReasonCode: r.reasonCode || '',
    autoReasonParams: r.reasonParams || null,
    factors: { ...def.factors },
    paramCount,
    anchorPoolUsd: null,
    equivalentMixPoolUsd: null,
    seBeta: null,
    seBetaMix: null,
    tCrit: null,
    s2Post: null,
    minParamEffDf: null,
    maePp: null,
    loocvMaePp: null,
    chi2Score: null,
    maxVif: 1,
    params: {
      models: allModels.map((m) => ({
        canonicalId: m.canonicalId,
        value: 1,
        se: null,
        isAnchor: m.canonicalId === anchorModel,
        fitted: false,
        clamped: false,
        share: m.share,
      })),
      cache: { value: 1, se: null, fitted: false, clamped: false },
      output: { value: 1, se: null, fitted: false, clamped: false },
    },
    segmentFits: [],
  };
}

function runSubsetsForRegime({
  pool,
  pricingState,
  coalescedResult,
  rawSegments,
  tailTurns,
  preferredAnchor,
  useListPrice,
  qEff,
  fallbackPooled,
}) {
  const preparedAll = coalescedResult.segments.map((seg, i) => {
    const agg = aggregateTurnsByModel(seg.turns || [], pricingState, useListPrice);
    return {
      idx: i + 1,
      startAt: seg.startAt,
      endAt: seg.endAt,
      y_k: seg.deltaU,
      q_k: seg.qK,
      mergedCount: seg.mergedFromRawCount || seg.anchorCount || 1,
      ...agg,
    };
  });

  const usableSegments = preparedAll.filter((s) => s.y_k > 0 && s.rawSpendUsd > 0);
  const tailAgg = aggregateTurnsByModel(tailTurns || [], pricingState, useListPrice);

  // Spend map for anchor resolution & equivalent capacity
  const rawTurnsAll = rawSegments.flatMap((s) => s.turns || []);
  const rawAggAll = aggregateTurnsByModel(rawTurnsAll, pricingState, useListPrice);
  const anchorSourceSegs = usableSegments.length > 0 ? usableSegments : preparedAll;
  const spendMap = new Map();
  let totalSpendForAnchor = 0;
  for (const s of anchorSourceSegs) {
    for (const [mId, b] of s.byModel.entries()) {
      spendMap.set(mId, (spendMap.get(mId) || 0) + b.totalUsd);
      totalSpendForAnchor += b.totalUsd;
    }
  }
  if (totalSpendForAnchor <= 0 && rawAggAll.rawSpendUsd > 0) {
    for (const [mId, b] of rawAggAll.byModel.entries()) {
      spendMap.set(mId, (spendMap.get(mId) || 0) + b.totalUsd);
      totalSpendForAnchor += b.totalUsd;
    }
  }
  if (totalSpendForAnchor <= 0) {
    for (const [mId, b] of tailAgg.byModel.entries()) {
      spendMap.set(mId, (spendMap.get(mId) || 0) + b.totalUsd);
      totalSpendForAnchor += b.totalUsd;
    }
  }

  const availableAnchorModels = [...spendMap.entries()]
    .filter(([, usd]) => usd > 0)
    .map(([canonicalId, usd]) => ({
      canonicalId,
      share: totalSpendForAnchor > 0 ? usd / totalSpendForAnchor : 0,
    }))
    .sort((a, b) => b.share - a.share);

  const availableSet = new Set(availableAnchorModels.map((m) => m.canonicalId));
  const defaultAnchor = pricingState?.defaultAnchors?.[pool] || null;
  let anchorModel = null;
  let anchorSource = 'fallback';
  if (preferredAnchor && availableSet.has(preferredAnchor)) {
    anchorModel = preferredAnchor;
    anchorSource = 'user';
  } else if (defaultAnchor && availableSet.has(defaultAnchor)) {
    anchorModel = defaultAnchor;
    anchorSource = 'default';
  } else if (availableAnchorModels.length > 0) {
    anchorModel = availableAnchorModels[0].canonicalId;
    anchorSource = 'fallback';
  } else {
    anchorModel = defaultAnchor;
    anchorSource = 'default';
  }

  // Promo regime check across all turns in segments + tail
  let anyPromo = false;
  let anyNonPromoSameModel = false;
  const promoFlagsByModel = new Map();
  for (const s of [...preparedAll, rawAggAll, tailAgg]) {
    for (const [mId, b] of s.byModel.entries()) {
      let f = promoFlagsByModel.get(mId);
      if (!f) {
        f = { hasPromo: false, hasNonPromo: false };
        promoFlagsByModel.set(mId, f);
      }
      if (b.hasPromo) f.hasPromo = true;
      if (b.hasNonPromo) f.hasNonPromo = true;
    }
  }
  for (const f of promoFlagsByModel.values()) {
    if (f.hasPromo) anyPromo = true;
    if (f.hasPromo && f.hasNonPromo) anyNonPromoSameModel = true;
  }

  const N = usableSegments.length;
  const segmentClusterCount = countSegmentClusters(usableSegments);

  const mkReason = (reasonCode, reasonParams, reason) => ({
    reason: reason || '',
    reasonCode: reasonCode || '',
    reasonParams: reasonParams || null,
  });

  // Two-tier individual factor diagnostics (M, C, O):
  // - eligible: relaxed exploratory threshold (manual toggle allowed with honest ±SE & exploratory badge)
  // - autoEligible: strict statistical threshold (required for Auto mode adoption)
  const nonAnchorStats = [];
  for (const m of availableAnchorModels) {
    if (m.canonicalId === anchorModel) continue;
    const perSegShares = usableSegments.map((s) => {
      const mSpend = s.byModel.get(m.canonicalId)?.totalUsd || 0;
      return s.rawSpendUsd > 0 ? mSpend / s.rawSpendUsd : 0;
    });
    nonAnchorStats.push({
      canonicalId: m.canonicalId,
      share: m.share,
      std: sampleStd(perSegShares),
    });
  }

  const candidateModels = nonAnchorStats
    .filter((m) => m.share >= 0.05 && m.std >= 0.04)
    .sort((a, b) => b.share - a.share)
    .slice(0, MAX_M_MODELS)
    .map((m) => m.canonicalId);

  const autoCandidateModels = nonAnchorStats
    .filter((m) => (N >= 6 ? m.share >= 0.05 && m.std >= 0.05 : m.share >= 0.10 && m.std >= 0.08))
    .sort((a, b) => b.share - a.share)
    .slice(0, MAX_M_MODELS)
    .map((m) => m.canonicalId);

  const maxModelStd = nonAnchorStats.reduce((mx, m) => Math.max(mx, m.std), 0);
  const maxNonAnchorShare = nonAnchorStats.reduce((mx, m) => Math.max(mx, m.share), 0);
  // Isolate Auto from weak exploratory-only models: when >=1 model passes Auto gate, fit only
  // autoCandidateModels so a weak 5-9% model neither leaks into Auto nor inflates pCount.
  const activeMModels = autoCandidateModels.length > 0 ? autoCandidateModels : candidateModels;
  const kExtraModels = activeMModels.length;

  let mEligible = false;
  let mAutoEligible = false;
  let mReasonObj = mkReason('', null, '');
  let mAutoReasonObj = mkReason('', null, '');

  if (availableAnchorModels.length <= 1) {
    mReasonObj = mkReason('m_single_model', null, 'Only 1 active model in cycle');
    mAutoReasonObj = mReasonObj;
  } else if (activeMModels.length === 0) {
    const hasSecondModel = nonAnchorStats.some((m) => m.share >= 0.05);
    mReasonObj = !hasSecondModel
      ? mkReason('m_low_share', { minPct: 5 }, 'Need >=2 models with >=5% cycle spend share')
      : mkReason(
          'm_low_std',
          { std: Number(maxModelStd.toFixed(2)), minStd: 0.04 },
          `Model mix variation across segments too low (std ${maxModelStd.toFixed(2)} < 0.04)`
        );
    mAutoReasonObj = mReasonObj;
  } else {
    const minNExplore = 1 + kExtraModels + 1;
    const minNAuto = 1 + kExtraModels + 2;
    if (N < minNExplore) {
      mReasonObj = mkReason(
        'm_need_segs',
        { need: minNExplore - N, cur: N, req: minNExplore },
        `Need ${minNExplore - N} more smoothed segments with varied model mix (${N}/${minNExplore})`
      );
      mAutoReasonObj = mkReason(
        'm_need_segs',
        { need: minNAuto - N, cur: N, req: minNAuto },
        `Need ${minNAuto - N} more smoothed segments with varied model mix (${N}/${minNAuto})`
      );
    } else {
      mEligible = true;
      if (autoCandidateModels.length === 0) {
        if (maxNonAnchorShare < 0.10) {
          mAutoReasonObj = mkReason(
            'm_auto_share_or_segs',
            { sharePct: Number((maxNonAnchorShare * 100).toFixed(1)), n: N },
            `Secondary model share ${(maxNonAnchorShare * 100).toFixed(1)}% < 10% (auto needs >=10% or >=6 segments)`
          );
        } else {
          mAutoReasonObj = mkReason(
            'm_low_std',
            { std: Number(maxModelStd.toFixed(2)), minStd: N >= 6 ? 0.05 : 0.08 },
            `Model mix variation across segments too low for auto (std ${maxModelStd.toFixed(2)} < ${N >= 6 ? '0.05' : '0.08'})`
          );
        }
      } else if (N < minNAuto) {
        mAutoReasonObj = mkReason(
          'm_need_segs',
          { need: minNAuto - N, cur: N, req: minNAuto },
          `Need ${minNAuto - N} more smoothed segments for auto (${N}/${minNAuto})`
        );
      } else {
        mAutoEligible = true;
      }
    }
  }

  const cacheShares = usableSegments.map((s) => {
    let cr = 0;
    for (const b of s.byModel.values()) cr += b.cacheReadUsd;
    return s.rawSpendUsd > 0 ? cr / s.rawSpendUsd : 0;
  });
  const cacheStd = sampleStd(cacheShares);

  let cEligible = false;
  let cAutoEligible = false;
  let cReasonObj = mkReason('', null, '');
  let cAutoReasonObj = mkReason('', null, '');
  if (N < 2) {
    cReasonObj = mkReason(
      'c_need_segs',
      { need: 3 - N, cur: N, req: 3 },
      `Need ${3 - N} more smoothed segments with varied cache-read share (${N}/3)`
    );
    cAutoReasonObj = mkReason(
      'c_need_segs',
      { need: 4 - N, cur: N, req: 4 },
      `Need ${4 - N} more smoothed segments with varied cache-read share (${N}/4)`
    );
  } else if (cacheStd < 0.03) {
    cReasonObj = mkReason(
      'c_low_std',
      { std: Number(cacheStd.toFixed(2)), minStd: 0.03 },
      `Cache-read share variation too low (std ${cacheStd.toFixed(2)} < 0.03)`
    );
    cAutoReasonObj = cReasonObj;
  } else if (N < 3) {
    cReasonObj = mkReason(
      'c_need_segs',
      { need: 3 - N, cur: N, req: 3 },
      `Need ${3 - N} more smoothed segments with varied cache-read share (${N}/3)`
    );
    cAutoReasonObj = mkReason(
      'c_need_segs',
      { need: 4 - N, cur: N, req: 4 },
      `Need ${4 - N} more smoothed segments with varied cache-read share (${N}/4)`
    );
  } else {
    cEligible = true;
    if (cacheStd < 0.05) {
      cAutoReasonObj = mkReason(
        'c_low_std',
        { std: Number(cacheStd.toFixed(2)), minStd: 0.05 },
        `Cache-read share variation too low for auto (std ${cacheStd.toFixed(2)} < 0.05)`
      );
    } else if (N < 4) {
      cAutoReasonObj = mkReason(
        'c_need_segs',
        { need: 4 - N, cur: N, req: 4 },
        `Need ${4 - N} more smoothed segments for auto (${N}/4)`
      );
    } else {
      cAutoEligible = true;
    }
  }

  const outShares = usableSegments.map((s) => {
    let o = 0;
    for (const b of s.byModel.values()) o += b.outUsd;
    return s.rawSpendUsd > 0 ? o / s.rawSpendUsd : 0;
  });
  const outStd = sampleStd(outShares);

  let oEligible = false;
  let oAutoEligible = false;
  let oReasonObj = mkReason('', null, '');
  let oAutoReasonObj = mkReason('', null, '');
  if (N < 2) {
    oReasonObj = mkReason(
      'o_need_segs',
      { need: 3 - N, cur: N, req: 3 },
      `Need ${3 - N} more smoothed segments with varied output share (${N}/3)`
    );
    oAutoReasonObj = mkReason(
      'o_need_segs',
      { need: 4 - N, cur: N, req: 4 },
      `Need ${4 - N} more smoothed segments with varied output share (${N}/4)`
    );
  } else if (outStd < 0.03) {
    oReasonObj = mkReason(
      'o_low_std',
      { std: Number(outStd.toFixed(2)), minStd: 0.03 },
      `Output share variation too low (std ${outStd.toFixed(2)} < 0.03)`
    );
    oAutoReasonObj = oReasonObj;
  } else if (N < 3) {
    oReasonObj = mkReason(
      'o_need_segs',
      { need: 3 - N, cur: N, req: 3 },
      `Need ${3 - N} more smoothed segments with varied output share (${N}/3)`
    );
    oAutoReasonObj = mkReason(
      'o_need_segs',
      { need: 4 - N, cur: N, req: 4 },
      `Need ${4 - N} more smoothed segments with varied output share (${N}/4)`
    );
  } else {
    oEligible = true;
    if (outStd < 0.06) {
      oAutoReasonObj = mkReason(
        'o_low_std',
        { std: Number(outStd.toFixed(2)), minStd: 0.06 },
        `Output share variation too low for auto (std ${outStd.toFixed(2)} < 0.06)`
      );
    } else if (N < 4) {
      oAutoReasonObj = mkReason(
        'o_need_segs',
        { need: 4 - N, cur: N, req: 4 },
        `Need ${4 - N} more smoothed segments for auto (${N}/4)`
      );
    } else {
      oAutoEligible = true;
    }
  }

  const factorsMeta = {
    M: {
      eligible: mEligible,
      autoEligible: mAutoEligible,
      exploratory: mEligible && !mAutoEligible,
      ...mReasonObj,
      autoReason: mAutoReasonObj.reason,
      autoReasonCode: mAutoReasonObj.reasonCode,
      autoReasonParams: mAutoReasonObj.reasonParams,
      candidateModels: activeMModels,
      std: Number(maxModelStd.toFixed(4)),
    },
    C: {
      eligible: cEligible,
      autoEligible: cAutoEligible,
      exploratory: cEligible && !cAutoEligible,
      ...cReasonObj,
      autoReason: cAutoReasonObj.reason,
      autoReasonCode: cAutoReasonObj.reasonCode,
      autoReasonParams: cAutoReasonObj.reasonParams,
      std: Number(cacheStd.toFixed(4)),
    },
    O: {
      eligible: oEligible,
      autoEligible: oAutoEligible,
      exploratory: oEligible && !oAutoEligible,
      ...oReasonObj,
      autoReason: oAutoReasonObj.reason,
      autoReasonCode: oAutoReasonObj.reasonCode,
      autoReasonParams: oAutoReasonObj.reasonParams,
      std: Number(outStd.toFixed(4)),
    },
  };

  if (N === 0) {
    const subsets = {};
    for (const def of SUBSET_DEFS) {
      const pCount =
        1 +
        (def.factors.M ? kExtraModels : 0) +
        (def.factors.C ? 1 : 0) +
        (def.factors.O ? 1 : 0);
      if (def.key === 'base') {
        const baseOk = Boolean(fallbackPooled && fallbackPooled.sumDeltaU > 0 && fallbackPooled.sumC > 0);
        const res = buildEmptySubsetResult(
          def,
          baseOk,
          baseOk
            ? mkReason('', null, '')
            : mkReason('need_anchors', null, 'Need at least 2 anchors with positive quota delta'),
          1,
          availableAnchorModels,
          anchorModel
        );
        if (baseOk) {
          const qPool = fallbackPooled.sumC / fallbackPooled.sumDeltaU;
          res.anchorPoolUsd = qPool;
          res.equivalentMixPoolUsd = qPool;
          res.tCrit = Number(studentTCrit95(NU0_PRIOR).toFixed(4));
        }
        subsets[def.key] = res;
      } else {
        const firstIneligible = def.factors.M ? mReasonObj : def.factors.C ? cReasonObj : oReasonObj;
        subsets[def.key] = buildEmptySubsetResult(
          def,
          false,
          firstIneligible,
          pCount,
          availableAnchorModels,
          anchorModel
        );
      }
    }

    return {
      recommendedSubset: 'base',
      anchorModel,
      anchorSource,
      availableAnchorModels,
      anyPromo,
      promoIdentifiable: !anyPromo || anyNonPromoSameModel,
      rawSegmentsCount: coalescedResult.rawSegmentsCount,
      segmentsCount: 0,
      segmentClusterCount: 1,
      sumCycleRaw: fallbackPooled?.sumC || 0,
      coalescedCount: coalescedResult.coalescedCount,
      reboundMergedCount: coalescedResult.reboundMergedCount,
      factors: factorsMeta,
      subsets,
      bestChi2: 0,
    };
  }

  // Compute noise variance & base WLS weights
  const sumYUsable = usableSegments.reduce((a, s) => a + s.y_k, 0);
  const sumCUsable = usableSegments.reduce((a, s) => a + s.rawSpendUsd, 0);
  const qHatBase = sumYUsable > 0 ? sumCUsable / sumYUsable : 100;
  const allTurnCosts = [];
  for (const s of usableSegments) {
    for (const c of s.turnCosts) allTurnCosts.push(c);
  }
  const medianTurnCostUsd = median(allTurnCosts);
  const sigmaLag = Math.min(0.005, medianTurnCostUsd / Math.max(20, qHatBase));

  const sigmaVec = usableSegments.map((s) => {
    const sigma2 = (s.q_k * s.q_k) / 6 + (0.015 * s.y_k) ** 2 + sigmaLag * sigmaLag;
    return Math.sqrt(Math.max(1e-12, sigma2));
  });
  const baseWeights = sigmaVec.map((sig) => 1 / (sig * sig));

  // Cycle turns/buckets for non-jumping equivalent mix capacity (all positive segments + tail)
  const cycleBuckets = [...anchorSourceSegs];
  if (tailAgg.rawSpendUsd > 0) cycleBuckets.push(tailAgg);
  const sumCycleRaw = cycleBuckets.reduce((acc, b) => acc + b.rawSpendUsd, 0);

  // Fit base first (with Huber IRLS when N >= 4)
  const baseFitBundle = fitSubsetWithHuber(
    'base',
    usableSegments,
    baseWeights,
    sigmaVec,
    anchorModel,
    [],
    { fitModels: false, fitCache: false, fitOut: false }
  );
  const baseCore = baseFitBundle.coreFit;

  function finalizeSubset(def, fitBundle, paramCount, { computeLoocv = true } = {}) {
    const { coreFit, effectiveWeights, huberFactors } = fitBundle;
    const fitModels = def.factors.M;
    const fitCache = def.factors.C;
    const fitOut = def.factors.O;

    const stats = computeJacobianAndStats(coreFit, usableSegments, effectiveWeights, anchorModel, {
      fitCache,
      fitOut,
      cycleBuckets,
      sumCycleRaw,
    });
    const maePp = computeWeightedMaePp(usableSegments, effectiveWeights, coreFit.yHat);
    // Skip LOOCV when N < paramCount + 2 (dof <= 1 -> each leave-one-out fold has dof = 0)
    const loocvMaePp =
      computeLoocv && N >= paramCount + 2
        ? computeLoocvMaePp(
            def.key,
            usableSegments,
            effectiveWeights,
            anchorModel,
            fitModels ? activeMModels : [],
            { fitModels, fitCache, fitOut }
          )
        : null;
    const anchorPoolUsd = coreFit.beta > 0 ? 1 / coreFit.beta : null;
    let sumCycleWeighted = 0;
    for (const b of cycleBuckets) {
      sumCycleWeighted += segmentTotalWeightedSpend(b, coreFit.alphaCache, coreFit.alphaOut, coreFit.modelWeights);
    }
    const equivalentMixPoolUsd =
      anchorPoolUsd != null && sumCycleWeighted > 0
        ? anchorPoolUsd * (sumCycleRaw / sumCycleWeighted)
        : anchorPoolUsd;

    const modelParams = availableAnchorModels.map((m) => {
      const isAnchor = m.canonicalId === anchorModel;
      const isCandidate = fitModels && activeMModels.includes(m.canonicalId);
      const isClamped = isCandidate && coreFit.clampedSet.has(m.canonicalId);
      const val = isAnchor ? 1.0 : (coreFit.modelWeights.get(m.canonicalId) ?? 1.0);
      const se = isCandidate ? (stats.seModels.get(m.canonicalId) ?? null) : null;
      return {
        canonicalId: m.canonicalId,
        value: Number(val.toFixed(4)),
        se: se != null ? Number(se.toFixed(4)) : null,
        isAnchor,
        fitted: isCandidate,
        clamped: isClamped,
        share: Number(m.share.toFixed(4)),
      };
    });

    const segmentFits = usableSegments.map((s, k) => {
      const observedPp = Number((s.y_k * 100).toFixed(4));
      const predBasePp = Number((baseCore.yHat[k] * 100).toFixed(4));
      const predPp = Number((coreFit.yHat[k] * 100).toFixed(4));
      const downweighted = N >= 4 && huberFactors[k] < HUBER_DOWNWEIGHT_THRESHOLD;
      return {
        idx: s.idx,
        observedPp,
        predBasePp,
        predPp,
        spendUsd: Number(s.rawSpendUsd.toFixed(4)),
        mergedCount: s.mergedCount,
        downweighted,
        startAt: s.startAt,
        endAt: s.endAt,
      };
    });

    return {
      key: def.key,
      eligible: true,
      autoEligible: def.key === 'base',
      exploratory: false,
      reason: '',
      reasonCode: '',
      reasonParams: null,
      autoReason: '',
      autoReasonCode: '',
      autoReasonParams: null,
      factors: { ...def.factors },
      paramCount,
      anchorPoolUsd,
      equivalentMixPoolUsd,
      seBeta: stats.seBeta,
      seBetaMix: stats.seBetaMix,
      tCrit: Number(stats.tCrit.toFixed(4)),
      s2Post: Number(stats.s2Post.toFixed(4)),
      minParamEffDf: Number(stats.minParamEffDf.toFixed(3)),
      maePp: Number(maePp.toFixed(4)),
      loocvMaePp: loocvMaePp != null ? Number(loocvMaePp.toFixed(4)) : null,
      chi2Score: Number(stats.chi2Score.toFixed(4)),
      maxVif: Number(Number.isFinite(stats.maxVif) ? stats.maxVif.toFixed(3) : 9999),
      _rawMaxVif: stats.maxVif,
      _chi2Data: coreFit.chi2Data,
      _effDf: stats.effDf,
      _s2Post: stats.s2Post,
      _minParamEffDf: stats.minParamEffDf,
      _modelWeights: coreFit.modelWeights,
      _alphaCache: coreFit.alphaCache,
      _alphaOut: coreFit.alphaOut,
      params: {
        models: modelParams,
        cache: {
          value: Number(coreFit.alphaCache.toFixed(4)),
          se: fitCache && stats.seCache != null ? Number(stats.seCache.toFixed(4)) : null,
          fitted: fitCache,
          clamped: fitCache && coreFit.cacheClamped,
        },
        output: {
          value: Number(coreFit.alphaOut.toFixed(4)),
          se: fitOut && stats.seOut != null ? Number(stats.seOut.toFixed(4)) : null,
          fitted: fitOut,
          clamped: fitOut && coreFit.outClamped,
        },
      },
      segmentFits,
    };
  }

  const subsets = {};
  subsets.base = finalizeSubset(SUBSET_DEFS[0], baseFitBundle, 1, { computeLoocv: N >= 2 });

  for (const def of SUBSET_DEFS) {
    if (def.key === 'base') continue;
    const pCount =
      1 +
      (def.factors.M ? kExtraModels : 0) +
      (def.factors.C ? 1 : 0) +
      (def.factors.O ? 1 : 0);

    // Tier 1: Manual explore eligibility
    const failedExploreReasons = [];
    if (def.factors.M && !mEligible) failedExploreReasons.push(mReasonObj);
    if (def.factors.C && !cEligible) failedExploreReasons.push(cReasonObj);
    if (def.factors.O && !oEligible) failedExploreReasons.push(oReasonObj);

    if (failedExploreReasons.length > 0) {
      subsets[def.key] = buildEmptySubsetResult(
        def,
        false,
        failedExploreReasons[0],
        pCount,
        availableAnchorModels,
        anchorModel
      );
      continue;
    }

    const minNExplore = pCount + 1;
    if (N < minNExplore) {
      subsets[def.key] = buildEmptySubsetResult(
        def,
        false,
        mkReason(
          'subset_need_segs',
          { subset: def.key, need: minNExplore - N, cur: N, req: minNExplore },
          `Need ${minNExplore - N} more smoothed segments for ${def.key} (${N}/${minNExplore})`
        ),
        pCount,
        availableAnchorModels,
        anchorModel
      );
      continue;
    }

    const fitBundle = fitSubsetWithHuber(
      def.key,
      usableSegments,
      baseWeights,
      sigmaVec,
      anchorModel,
      def.factors.M ? activeMModels : [],
      {
        fitModels: def.factors.M,
        fitCache: def.factors.C,
        fitOut: def.factors.O,
      },
      baseFitBundle.huberFactors
    );

    const cand = finalizeSubset(def, fitBundle, pCount, { computeLoocv: N >= pCount + 2 });
    if (cand._rawMaxVif >= MAX_VIF_EXPLORE) {
      const vifReason = mkReason(
        'subset_collinear',
        { subset: def.key, vif: cand.maxVif, maxVif: MAX_VIF_EXPLORE },
        `Collinear ${def.key} dimensions rejected (VIF ${cand.maxVif} >= ${MAX_VIF_EXPLORE})`
      );
      subsets[def.key] = {
        ...cand,
        eligible: false,
        autoEligible: false,
        exploratory: false,
        ...vifReason,
        autoReason: vifReason.reason,
        autoReasonCode: vifReason.reasonCode,
        autoReasonParams: vifReason.reasonParams,
      };
      if (factorCount(def.factors) === 1) {
        const fKey = def.factors.M ? 'M' : def.factors.C ? 'C' : 'O';
        factorsMeta[fKey].eligible = false;
        factorsMeta[fKey].autoEligible = false;
        factorsMeta[fKey].exploratory = false;
        factorsMeta[fKey].reason = vifReason.reason;
        factorsMeta[fKey].reasonCode = vifReason.reasonCode;
        factorsMeta[fKey].reasonParams = vifReason.reasonParams;
        factorsMeta[fKey].autoReason = vifReason.reason;
        factorsMeta[fKey].autoReasonCode = vifReason.reasonCode;
        factorsMeta[fKey].autoReasonParams = vifReason.reasonParams;
      }
      continue;
    }

    // Tier 2: Strict Auto adoption gate
    const failedAutoReasons = [];
    if (def.factors.M && !mAutoEligible) failedAutoReasons.push(mAutoReasonObj);
    if (def.factors.C && !cAutoEligible) failedAutoReasons.push(cAutoReasonObj);
    if (def.factors.O && !oAutoEligible) failedAutoReasons.push(oAutoReasonObj);

    const minNAuto = pCount + 2;
    if (failedAutoReasons.length === 0 && N < minNAuto) {
      failedAutoReasons.push(
        mkReason(
          'subset_need_segs',
          { subset: def.key, need: minNAuto - N, cur: N, req: minNAuto },
          `Need ${minNAuto - N} more smoothed segments for auto ${def.key} (${N}/${minNAuto})`
        )
      );
    }
    if (failedAutoReasons.length === 0 && cand._rawMaxVif >= MAX_VIF_AUTO) {
      failedAutoReasons.push(
        mkReason(
          'subset_collinear',
          { subset: def.key, vif: cand.maxVif, maxVif: MAX_VIF_AUTO },
          `Collinear ${def.key} dimensions rejected for auto (VIF ${cand.maxVif} >= ${MAX_VIF_AUTO})`
        )
      );
    }
    if (failedAutoReasons.length === 0 && cand._minParamEffDf < MIN_EFF_DF_AUTO) {
      failedAutoReasons.push(
        mkReason(
          'subset_low_effdf',
          { subset: def.key, effDf: cand.minParamEffDf, minEffDf: MIN_EFF_DF_AUTO },
          `Prior-dominated ${def.key} fit (data dominance ${cand.minParamEffDf} < ${MIN_EFF_DF_AUTO})`
        )
      );
    }

    const isAutoOk = failedAutoReasons.length === 0 && cand.loocvMaePp != null;
    const autoFail = failedAutoReasons[0] || mkReason('', null, '');
    subsets[def.key] = {
      ...cand,
      eligible: true,
      autoEligible: isAutoOk,
      exploratory: !isAutoOk,
      autoReason: isAutoOk ? '' : autoFail.reason,
      autoReasonCode: isAutoOk ? '' : autoFail.reasonCode,
      autoReasonParams: isAutoOk ? null : autoFail.reasonParams,
    };

    if (factorCount(def.factors) === 1 && !isAutoOk) {
      const fKey = def.factors.M ? 'M' : def.factors.C ? 'C' : 'O';
      factorsMeta[fKey].autoEligible = false;
      factorsMeta[fKey].exploratory = factorsMeta[fKey].eligible;
      factorsMeta[fKey].autoReason = autoFail.reason;
      factorsMeta[fKey].autoReasonCode = autoFail.reasonCode;
      factorsMeta[fKey].autoReasonParams = autoFail.reasonParams;
    }
  }

  // Auto subset selection across strictly autoEligible subsets sorted by paramCount ascending (Occam's razor)
  // Uses overdispersion-scaled Quasi-AIC (QAIC) with empirical Bayes s2Post so high s2 does not trigger false selection.
  let recommendedSubset = 'base';
  const eligibleCandidates = Object.values(subsets)
    .filter((s) => s.key !== 'base' && s.autoEligible && s.loocvMaePp != null)
    .sort(
      (a, b) =>
        a.paramCount - b.paramCount ||
        (a.loocvMaePp ?? Infinity) - (b.loocvMaePp ?? Infinity)
    );

  for (const cand of eligibleCandidates) {
    const best = subsets[recommendedSubset];
    if (best.loocvMaePp == null) continue;
    const reqFactor =
      factorCount(best.factors) >= 1 && factorCount(cand.factors) > factorCount(best.factors)
        ? 0.90
        : 0.85;
    const loocvImproved =
      cand.loocvMaePp <= best.loocvMaePp * reqFactor &&
      best.loocvMaePp - cand.loocvMaePp > qEff * 50;
    const s2Scale = Math.max(1, cand._s2Post || 1);
    const qAicBest = best._chi2Data / s2Scale + 2 * (best._effDf ?? best.paramCount);
    const qAicCand = cand._chi2Data / s2Scale + 2 * (cand._effDf ?? cand.paramCount);
    const chi2Improved = qAicCand <= qAicBest - 2.0;
    const vifOk = cand._rawMaxVif < MAX_VIF_AUTO;
    if (loocvImproved && chi2Improved && vifOk) {
      recommendedSubset = cand.key;
    }
  }

  return {
    recommendedSubset,
    anchorModel,
    anchorSource,
    availableAnchorModels,
    anyPromo,
    promoIdentifiable: !anyPromo || anyNonPromoSameModel,
    rawSegmentsCount: coalescedResult.rawSegmentsCount,
    segmentsCount: N,
    segmentClusterCount,
    sumCycleRaw,
    coalescedCount: coalescedResult.coalescedCount,
    reboundMergedCount: coalescedResult.reboundMergedCount,
    factors: factorsMeta,
    subsets,
    bestChi2: subsets[recommendedSubset]._chi2Data ?? 0,
  };
}

function stripInternalSubsetFields(sub) {
  const copy = { ...sub };
  delete copy._rawMaxVif;
  delete copy._chi2Data;
  delete copy._effDf;
  delete copy._s2Post;
  delete copy._minParamEffDf;
  delete copy._modelWeights;
  delete copy._alphaCache;
  delete copy._alphaOut;
  return copy;
}

/**
 * Calibrate orthogonal 3-factor quota weights strictly within the current cycle.
 */
export function calibrateQuotaCycle({
  pool,
  windowType = null,
  pricingState,
  rawSegments,
  tailTurns = [],
  preferredAnchor = null,
  quotaCalibMode = 'auto',
  quotaManualFactors = null,
  forceSubset = null,
  forceLevel = null,
  qEff = 0.0001,
  fallbackPooled = null,
  minDurationMs = null,
}) {
  const effectiveMinDurationMs =
    typeof minDurationMs === 'number' && Number.isFinite(minDurationMs) && minDurationMs >= 0
      ? minDurationMs
      : windowType === '7d'
        ? 10 * 60_000
        : windowType === '5h'
          ? 5 * 60_000
          : 0;
  const coalescedResult = coalesceRawSegments(rawSegments || [], {
    minDurationMs: effectiveMinDurationMs,
  });

  const effRun = runSubsetsForRegime({
    pool,
    pricingState,
    coalescedResult,
    rawSegments: rawSegments || [],
    tailTurns,
    preferredAnchor,
    useListPrice: false,
    qEff,
    fallbackPooled,
  });

  let chosen = effRun;
  let promoAssumption = 'none';
  if (effRun.anyPromo) {
    if (effRun.promoIdentifiable) {
      const listRun = runSubsetsForRegime({
        pool,
        pricingState,
        coalescedResult,
        rawSegments: rawSegments || [],
        tailTurns,
        preferredAnchor,
        useListPrice: true,
        qEff,
        fallbackPooled,
      });
      if (listRun.bestChi2 < effRun.bestChi2) {
        chosen = listRun;
        promoAssumption = 'list_price';
      } else {
        promoAssumption = 'follows_api_price';
      }
    } else {
      promoAssumption = 'follows_api_price';
    }
  }

  // Resolve requested mode & subset
  let mode = quotaCalibMode === 'manual' ? 'manual' : 'auto';
  let requestedKey = null;

  if (typeof forceSubset === 'string' && forceSubset.trim()) {
    const norm = normalizeSubsetKey(forceSubset);
    if (norm) {
      mode = 'manual';
      requestedKey = norm;
    }
  } else if (typeof forceLevel === 'string' && forceLevel.trim() && forceLevel !== 'auto') {
    const norm = normalizeSubsetKey(forceLevel);
    if (norm) {
      mode = 'manual';
      requestedKey = norm;
    }
  } else if (typeof quotaCalibMode === 'string' && quotaCalibMode !== 'auto' && quotaCalibMode !== 'manual') {
    const norm = normalizeSubsetKey(quotaCalibMode);
    if (norm) {
      mode = 'manual';
      requestedKey = norm;
    }
  }

  if (mode === 'manual' && !requestedKey) {
    requestedKey = factorsToSubsetKey(quotaManualFactors);
  }

  const activeSubset =
    mode === 'manual' && requestedKey && chosen.subsets[requestedKey]?.eligible
      ? requestedKey
      : chosen.recommendedSubset;

  const activeSubObj = chosen.subsets[activeSubset];
  const activeFactors = { ...activeSubObj.factors };
  const huberDownweightedCount = (activeSubObj.segmentFits || []).filter((f) => f.downweighted).length;

  const useList = promoAssumption === 'list_price';
  const tailAgg = aggregateTurnsByModel(tailTurns || [], pricingState, useList);
  const tailWeightedUsd = activeSubObj._modelWeights
    ? segmentTotalWeightedSpend(
        tailAgg,
        activeSubObj._alphaCache ?? 1.0,
        activeSubObj._alphaOut ?? 1.0,
        activeSubObj._modelWeights
      )
    : tailAgg.rawSpendUsd;

  const cleanSubsets = {};
  for (const key of SUBSET_KEYS) {
    cleanSubsets[key] = stripInternalSubsetFields(chosen.subsets[key]);
  }

  return {
    mode,
    recommendedSubset: chosen.recommendedSubset,
    activeSubset,
    activeFactors,
    anchorModel: chosen.anchorModel,
    anchorSource: chosen.anchorSource,
    availableAnchorModels: chosen.availableAnchorModels,
    promoIdentifiable: chosen.promoIdentifiable,
    promoAssumption,
    rawSegmentsCount: chosen.rawSegmentsCount,
    segmentsCount: chosen.segmentsCount,
    coalescedCount: chosen.coalescedCount,
    reboundMergedCount: chosen.reboundMergedCount,
    shortGapMergedCount: coalescedResult.shortGapMergedCount || 0,
    huberDownweightedCount,
    factors: chosen.factors,
    subsets: cleanSubsets,
    activeMeta: {
      anchorPoolUsd: activeSubObj.anchorPoolUsd,
      equivalentMixPoolUsd: activeSubObj.equivalentMixPoolUsd,
      seBeta: activeSubObj.seBeta,
      seBetaMix: activeSubObj.seBetaMix,
      tCrit: activeSubObj.tCrit,
      s2Post: activeSubObj.s2Post,
      segmentClusterCount: chosen.segmentClusterCount || 1,
      sumCycleRaw: chosen.sumCycleRaw || 0,
      exploratory: Boolean(activeSubObj.exploratory),
      autoEligible: Boolean(activeSubObj.autoEligible),
      autoReason: activeSubObj.autoReason || '',
      autoReasonCode: activeSubObj.autoReasonCode || '',
      autoReasonParams: activeSubObj.autoReasonParams || null,
      tailWeightedUsd,
      tailRawUsd: tailAgg.rawSpendUsd,
      segmentFits: activeSubObj.segmentFits,
    },
  };
}
