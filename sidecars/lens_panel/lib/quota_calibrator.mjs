/**
 * Single-cycle hierarchical quota weight calibrator (L0 -> L1 -> L2 -> L3) for AGY Lens.
 * Pure Node.js ESM with zero external dependencies.
 */
import { calculateTurnCostBreakdown } from './pricing.mjs';

const MODEL_WEIGHT_MIN = 0.15;
const MODEL_WEIGHT_MAX = 5.0;
const ALPHA_CACHE_MIN = 0.0;
const ALPHA_CACHE_MAX = 20.0;
const ALPHA_OUT_MIN = 0.2;
const ALPHA_OUT_MAX = 5.0;
const LAMBDA_MODEL = 0.25;
const LAMBDA_ALPHA = 0.25;
const MAX_L1_MODELS = 3;

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

  // Base fallback L0 beta
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

    // Build X^T W X and X^T W y
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

    // 6 Gauss-Newton IRLS iterations on lambda * sum (ln(gamma_c / gamma_0))^2
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

  // Final weights map across all candidate models
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

function fitLevelCore(
  levelName,
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
    const coarseGrid = [0, ...makeLogGrid(0.05, ALPHA_CACHE_MAX, 34, [1.0])];
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
    const fineGrid =
      lo <= 0
        ? makeLinearGrid(0, hi, 9)
        : makeLogGrid(lo, hi, 9, [coarseGrid[bestIdx]]);
    for (const ac of fineGrid) {
      const res = evalPoint(ac, 1.0);
      if (res.totalObj < bestFit.totalObj) {
        bestFit = res;
      }
    }
    alphaCache = bestFit.ac;
    if (alphaCache <= 1e-4) {
      alphaCache = 0;
      cacheClamped = true;
    } else if (alphaCache >= ALPHA_CACHE_MAX - 1e-4) {
      alphaCache = ALPHA_CACHE_MAX;
      cacheClamped = true;
    }
  } else {
    // 2D Profile Grid (18x18 coarse + 5x5 local refinement)
    const acCoarse = [0, ...makeLogGrid(0.05, ALPHA_CACHE_MAX, 16, [1.0])];
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
    const acFine = acLo <= 0 ? makeLinearGrid(0, acHi, 5) : makeLogGrid(acLo, acHi, 5, [acCoarse[bestIc]]);
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
    if (alphaCache <= 1e-4) {
      alphaCache = 0;
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
    levelName,
    beta: bestFit.fit.beta,
    modelWeights: bestFit.fit.modelWeights,
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

function computeJacobianAndStats(
  coreFit,
  segments,
  weights,
  anchorModel,
  { fitCache = false, fitOut = false } = {}
) {
  const N = segments.length;
  const freeModels = coreFit.freeCandidates;
  const freeCache = fitCache && !coreFit.cacheClamped;
  const freeOut = fitOut && !coreFit.outClamped;

  const colCount = 1 + freeModels.length + (freeCache ? 1 : 0) + (freeOut ? 1 : 0);
  const J = Array.from({ length: N }, (_, k) => {
    const row = new Array(colCount).fill(0);
    const activeIdx = new Map();
    freeModels.forEach((m, idx) => activeIdx.set(m, idx + 1));

    let crSum = 0;
    let outSum = 0;
    for (const [mId, bucket] of segments[k].byModel.entries()) {
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

    let cIdx = 1 + freeModels.length;
    if (freeCache) row[cIdx++] = crSum;
    if (freeOut) row[cIdx++] = outSum;
    return row;
  });

  const maxVif = computeMaxVif(J, weights);

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
  for (let c = 1; c <= freeModels.length; c++) {
    const mId = freeModels[c - 1];
    const g0 = Math.max(1e-12, coreFit.beta);
    const gc = Math.max(1e-12, coreFit.beta * (coreFit.modelWeights.get(mId) ?? 1.0));
    const j0 = -1 / g0;
    const jc = 1 / gc;
    P[0][0] += LAMBDA_MODEL * j0 * j0;
    P[0][c] += LAMBDA_MODEL * j0 * jc;
    P[c][0] += LAMBDA_MODEL * jc * j0;
    P[c][c] += LAMBDA_MODEL * jc * jc;
  }
  let cIdx = 1 + freeModels.length;
  if (freeCache) {
    const ac = Math.max(0.05, coreFit.alphaCache);
    P[cIdx][cIdx] += LAMBDA_ALPHA / (ac * ac);
    cIdx++;
  }
  if (freeOut) {
    const ao = Math.max(0.05, coreFit.alphaOut);
    P[cIdx][cIdx] += LAMBDA_ALPHA / (ao * ao);
    cIdx++;
  }

  const GP = G.map((row, i) => row.map((val, j) => val + P[i][j]));
  const invGP = invertMatrix(GP);

  let effDf = colCount;
  let seBeta = null;
  const seModels = new Map();
  let seCache = null;
  let seOut = null;

  if (invGP) {
    const hatMat = matMul(invGP, G);
    let tr = 0;
    for (let i = 0; i < colCount; i++) tr += hatMat[i][i];
    effDf = Math.max(1, Math.min(colCount, tr));

    const dof = Math.max(1, N - effDf);
    const s2 = Math.max(1, coreFit.chi2Data / dof);
    const cov = invGP.map((row) => row.map((v) => v * s2));

    seBeta = cov[0][0] >= 0 ? Math.sqrt(cov[0][0]) : null;
    for (let c = 1; c <= freeModels.length; c++) {
      const mId = freeModels[c - 1];
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

    let pIdx = 1 + freeModels.length;
    if (freeCache) {
      seCache = cov[pIdx][pIdx] >= 0 ? Math.sqrt(cov[pIdx][pIdx]) : null;
      pIdx++;
    }
    if (freeOut) {
      seOut = cov[pIdx][pIdx] >= 0 ? Math.sqrt(cov[pIdx][pIdx]) : null;
      pIdx++;
    }
  }

  const chi2Score = coreFit.chi2Data + 2 * effDf;

  return {
    maxVif,
    effDf,
    chi2Score,
    seBeta,
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
  levelName,
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

    // Hold unsupported parameters fixed at 1.0 in this fold.
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

    const foldFit = fitLevelCore(
      levelName,
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

function buildEmptyLevelResult(eligible, reason, allModels, anchorModel) {
  return {
    eligible,
    reason,
    anchorPoolUsd: null,
    equivalentMixPoolUsd: null,
    seBeta: null,
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

function runLadderForRegime({
  pool,
  pricingState,
  rawSegments,
  tailTurns,
  preferredAnchor,
  useListPrice,
  qEff,
  fallbackPooled,
}) {
  const preparedAll = rawSegments.map((seg, i) => {
    const agg = aggregateTurnsByModel(seg.turns || [], pricingState, useListPrice);
    return {
      idx: i + 1,
      startAt: seg.startAt,
      endAt: seg.endAt,
      y_k: seg.deltaU,
      q_k: seg.qK,
      ...agg,
    };
  });

  const usableSegments = preparedAll.filter(
    (s) => s.y_k >= Math.max(5 * s.q_k, 0.0005) && s.rawSpendUsd > 0
  );
  const tailAgg = aggregateTurnsByModel(tailTurns || [], pricingState, useListPrice);

  // Spend map for anchor resolution & equivalent capacity
  const anchorSourceSegs = usableSegments.length > 0 ? usableSegments : preparedAll;
  const spendMap = new Map();
  let totalSpendForAnchor = 0;
  for (const s of anchorSourceSegs) {
    for (const [mId, b] of s.byModel.entries()) {
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
  for (const s of [...preparedAll, tailAgg]) {
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
  if (N === 0) {
    const levels = {
      L0: buildEmptyLevelResult(
        Boolean(fallbackPooled && fallbackPooled.sumDeltaU > 0 && fallbackPooled.sumC > 0),
        fallbackPooled && fallbackPooled.sumDeltaU > 0 ? '' : 'Need at least 2 anchors with positive quota delta',
        availableAnchorModels,
        anchorModel
      ),
      L1: buildEmptyLevelResult(false, 'Need at least 4 valid segments (current: 0/4)', availableAnchorModels, anchorModel),
      L2: buildEmptyLevelResult(false, 'Need at least 5 valid segments (current: 0/5)', availableAnchorModels, anchorModel),
      L3: buildEmptyLevelResult(false, 'Need at least 6 valid segments (current: 0/6)', availableAnchorModels, anchorModel),
    };
    if (levels.L0.eligible) {
      const qPool = fallbackPooled.sumC / fallbackPooled.sumDeltaU;
      levels.L0.anchorPoolUsd = qPool;
      levels.L0.equivalentMixPoolUsd = qPool;
    }
    return {
      recommendedLevel: 'L0',
      anchorModel,
      anchorSource,
      availableAnchorModels,
      anyPromo,
      promoIdentifiable: !anyPromo || anyNonPromoSameModel,
      segmentsCount: 0,
      levels,
      bestChi2: 0,
    };
  }

  // Compute noise variance & WLS weights
  const sumYUsable = usableSegments.reduce((a, s) => a + s.y_k, 0);
  const sumCUsable = usableSegments.reduce((a, s) => a + s.rawSpendUsd, 0);
  const qHatL0 = sumYUsable > 0 ? sumCUsable / sumYUsable : 100;
  const allTurnCosts = [];
  for (const s of usableSegments) {
    for (const c of s.turnCosts) allTurnCosts.push(c);
  }
  const medianTurnCostUsd = median(allTurnCosts);
  const sigmaLag = Math.min(0.005, medianTurnCostUsd / Math.max(20, qHatL0));

  const weights = usableSegments.map((s) => {
    const sigma2 = (s.q_k * s.q_k) / 6 + (0.015 * s.y_k) ** 2 + sigmaLag * sigmaLag;
    return 1 / Math.max(1e-12, sigma2);
  });

  // Cycle turns/buckets for non-jumping equivalent mix capacity (all positive segments + tail)
  const cycleBuckets = [...anchorSourceSegs];
  if (tailAgg.rawSpendUsd > 0) cycleBuckets.push(tailAgg);
  const sumCycleRaw = cycleBuckets.reduce((acc, b) => acc + b.rawSpendUsd, 0);

  // Identify candidate L1 models
  const nonAnchorStats = [];
  for (const m of availableAnchorModels) {
    if (m.canonicalId === anchorModel) continue;
    const perSegShares = usableSegments.map((s) => {
      const mSpend = s.byModel.get(m.canonicalId)?.totalUsd || 0;
      return s.rawSpendUsd > 0 ? mSpend / s.rawSpendUsd : 0;
    });
    const std = sampleStd(perSegShares);
    nonAnchorStats.push({
      canonicalId: m.canonicalId,
      share: m.share,
      std,
    });
  }
  const l1Candidates = nonAnchorStats
    .filter((m) => m.share >= 0.10 && m.std >= 0.08)
    .sort((a, b) => b.share - a.share)
    .slice(0, MAX_L1_MODELS)
    .map((m) => m.canonicalId);

  const l0Core = fitLevelCore('L0', usableSegments, weights, anchorModel, [], {
    fitModels: false,
    fitCache: false,
    fitOut: false,
  });

  function finalizeLevel(levelName, coreFit, { fitModels = false, fitCache = false, fitOut = false } = {}, reason = '') {
    const stats = computeJacobianAndStats(coreFit, usableSegments, weights, anchorModel, {
      fitCache,
      fitOut,
    });
    const maePp = computeWeightedMaePp(usableSegments, weights, coreFit.yHat);
    const loocvMaePp = computeLoocvMaePp(
      levelName,
      usableSegments,
      weights,
      anchorModel,
      fitModels ? l1Candidates : [],
      { fitModels, fitCache, fitOut }
    );
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
      const isCandidate = fitModels && l1Candidates.includes(m.canonicalId);
      const isClamped = isCandidate && coreFit.clampedSet.has(m.canonicalId);
      const val = isAnchor ? 1.0 : (coreFit.modelWeights.get(m.canonicalId) ?? 1.0);
      const se = isCandidate && !isClamped ? (stats.seModels.get(m.canonicalId) ?? null) : null;
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
      const predL0Pp = Number((l0Core.yHat[k] * 100).toFixed(4));
      const predPp = Number((coreFit.yHat[k] * 100).toFixed(4));
      return {
        idx: s.idx,
        segIdx: s.idx,
        observedPp,
        predL0Pp,
        predPp,
        predCurPp: predPp,
        startAt: s.startAt,
        endAt: s.endAt,
        spendUsd: Number(s.rawSpendUsd.toFixed(4)),
      };
    });

    return {
      eligible: true,
      reason,
      anchorPoolUsd,
      equivalentMixPoolUsd,
      seBeta: stats.seBeta,
      maePp: Number(maePp.toFixed(4)),
      loocvMaePp: loocvMaePp != null ? Number(loocvMaePp.toFixed(4)) : null,
      chi2Score: Number(stats.chi2Score.toFixed(4)),
      maxVif: Number(
        Number.isFinite(stats.maxVif) ? stats.maxVif.toFixed(3) : 9999
      ),
      _rawMaxVif: stats.maxVif,
      _chi2Data: coreFit.chi2Data,
      _modelWeights: coreFit.modelWeights,
      _alphaCache: coreFit.alphaCache,
      _alphaOut: coreFit.alphaOut,
      params: {
        models: modelParams,
        cache: {
          value: Number(coreFit.alphaCache.toFixed(4)),
          se: fitCache && !coreFit.cacheClamped && stats.seCache != null ? Number(stats.seCache.toFixed(4)) : null,
          fitted: fitCache,
          clamped: fitCache && coreFit.cacheClamped,
        },
        output: {
          value: Number(coreFit.alphaOut.toFixed(4)),
          se: fitOut && !coreFit.outClamped && stats.seOut != null ? Number(stats.seOut.toFixed(4)) : null,
          fitted: fitOut,
          clamped: fitOut && coreFit.outClamped,
        },
      },
      segmentFits,
    };
  }

  const L0 = finalizeLevel('L0', l0Core, { fitModels: false, fitCache: false, fitOut: false });

  // Evaluate L1
  let L1;
  const minNL1 = 1 + l1Candidates.length + 2;
  if (l1Candidates.length === 0) {
    const hasSecondModel = nonAnchorStats.some((m) => m.share >= 0.10);
    const reason = !hasSecondModel
      ? 'Need >=2 models with >=10% cycle spend share to unlock L1'
      : 'Model mix variation across segments too low (std < 0.08)';
    L1 = buildEmptyLevelResult(false, reason, availableAnchorModels, anchorModel);
  } else if (N < minNL1) {
    L1 = buildEmptyLevelResult(
      false,
      `Need ${minNL1 - N} more segments with varied model mix (current: ${N}/${minNL1})`,
      availableAnchorModels,
      anchorModel
    );
  } else {
    const l1Core = fitLevelCore('L1', usableSegments, weights, anchorModel, l1Candidates, {
      fitModels: true,
      fitCache: false,
      fitOut: false,
    });
    const l1Cand = finalizeLevel('L1', l1Core, { fitModels: true, fitCache: false, fitOut: false });
    if (l1Cand._rawMaxVif >= 10) {
      L1 = {
        ...l1Cand,
        eligible: false,
        reason: `Collinear model mix rejected (VIF ${l1Cand.maxVif} >= 10)`,
      };
    } else {
      L1 = l1Cand;
    }
  }

  // Evaluate L2
  let L2;
  const activeModelExtras = L1.eligible ? l1Candidates.length : 0;
  const pL2 = 1 + activeModelExtras + 1;
  const minNL2 = pL2 + 3;
  const cacheShares = usableSegments.map((s) => {
    let cr = 0;
    for (const b of s.byModel.values()) cr += b.cacheReadUsd;
    return s.rawSpendUsd > 0 ? cr / s.rawSpendUsd : 0;
  });
  const cacheStd = sampleStd(cacheShares);

  if (cacheStd < 0.05) {
    L2 = buildEmptyLevelResult(
      false,
      `Cache-read share variation too low (std ${cacheStd.toFixed(2)} < 0.05)`,
      availableAnchorModels,
      anchorModel
    );
  } else if (N < minNL2) {
    L2 = buildEmptyLevelResult(
      false,
      `Need ${minNL2 - N} more segments with varied cache hit rate (current: ${N}/${minNL2})`,
      availableAnchorModels,
      anchorModel
    );
  } else {
    const l2Core = fitLevelCore(
      'L2',
      usableSegments,
      weights,
      anchorModel,
      activeModelExtras > 0 ? l1Candidates : [],
      {
        fitModels: activeModelExtras > 0,
        fitCache: true,
        fitOut: false,
      }
    );
    const l2Cand = finalizeLevel('L2', l2Core, {
      fitModels: activeModelExtras > 0,
      fitCache: true,
      fitOut: false,
    });
    if (l2Cand._rawMaxVif >= 10) {
      L2 = {
        ...l2Cand,
        eligible: false,
        reason: `Collinear cache-read dimension rejected (VIF ${l2Cand.maxVif} >= 10)`,
      };
    } else {
      L2 = l2Cand;
    }
  }

  // Evaluate L3
  let L3;
  const pL3 = 1 + activeModelExtras + 2;
  const minNL3 = pL3 + 4;
  const outShares = usableSegments.map((s) => {
    let o = 0;
    for (const b of s.byModel.values()) o += b.outUsd;
    return s.rawSpendUsd > 0 ? o / s.rawSpendUsd : 0;
  });
  const outStd = sampleStd(outShares);

  if (!L2.eligible) {
    L3 = buildEmptyLevelResult(
      false,
      'Unlock L2 before evaluating L3 output weights',
      availableAnchorModels,
      anchorModel
    );
  } else if (outStd < 0.06) {
    L3 = buildEmptyLevelResult(
      false,
      `Output share variation too low (std ${outStd.toFixed(2)} < 0.06)`,
      availableAnchorModels,
      anchorModel
    );
  } else if (N < minNL3) {
    L3 = buildEmptyLevelResult(
      false,
      `Need ${minNL3 - N} more segments with varied output share (current: ${N}/${minNL3})`,
      availableAnchorModels,
      anchorModel
    );
  } else {
    const l3Core = fitLevelCore(
      'L3',
      usableSegments,
      weights,
      anchorModel,
      activeModelExtras > 0 ? l1Candidates : [],
      {
        fitModels: activeModelExtras > 0,
        fitCache: true,
        fitOut: true,
      }
    );
    const l3Cand = finalizeLevel('L3', l3Core, {
      fitModels: activeModelExtras > 0,
      fitCache: true,
      fitOut: true,
    });
    if (l3Cand._rawMaxVif >= 10) {
      L3 = {
        ...l3Cand,
        eligible: false,
        reason: `Collinear output dimension rejected (VIF ${l3Cand.maxVif} >= 10)`,
      };
    } else {
      L3 = l3Cand;
    }
  }

  // Anti-overfitting progressive selection: L0 -> L1 -> L2 -> L3
  const levels = { L0, L1, L2, L3 };
  let recommendedLevel = 'L0';
  const order = ['L1', 'L2', 'L3'];
  for (const lvlName of order) {
    const prev = levels[recommendedLevel];
    const cur = levels[lvlName];
    if (!cur.eligible) continue;
    if (cur.loocvMaePp == null || prev.loocvMaePp == null) continue;
    const loocvImproved =
      cur.loocvMaePp <= prev.loocvMaePp * 0.85 &&
      prev.loocvMaePp - cur.loocvMaePp > qEff * 50;
    const chi2Improved = cur.chi2Score <= prev.chi2Score - 2.0;
    const vifOk = cur._rawMaxVif < 10;
    if (loocvImproved && chi2Improved && vifOk) {
      recommendedLevel = lvlName;
    }
  }

  return {
    recommendedLevel,
    anchorModel,
    anchorSource,
    availableAnchorModels,
    anyPromo,
    promoIdentifiable: !anyPromo || anyNonPromoSameModel,
    segmentsCount: N,
    levels,
    bestChi2: levels[recommendedLevel]._chi2Data ?? 0,
  };
}

function stripInternalLevelFields(lvl) {
  const copy = { ...lvl };
  delete copy._rawMaxVif;
  delete copy._chi2Data;
  delete copy._modelWeights;
  delete copy._alphaCache;
  delete copy._alphaOut;
  return copy;
}

/**
 * Calibrate hierarchical quota weights strictly within the current cycle.
 */
export function calibrateQuotaCycle({
  pool,
  pricingState,
  rawSegments,
  tailTurns = [],
  preferredAnchor = null,
  forceLevel = 'auto',
  qEff = 0.0001,
  fallbackPooled = null,
}) {
  const effRun = runLadderForRegime({
    pool,
    pricingState,
    rawSegments,
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
      const listRun = runLadderForRegime({
        pool,
        pricingState,
        rawSegments,
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

  const normalizedForce =
    typeof forceLevel === 'string' && ['L0', 'L1', 'L2', 'L3'].includes(forceLevel.toUpperCase())
      ? forceLevel.toUpperCase()
      : 'auto';

  const activeLevel =
    normalizedForce !== 'auto' && chosen.levels[normalizedForce]?.eligible
      ? normalizedForce
      : chosen.recommendedLevel;

  const activeLvlObj = chosen.levels[activeLevel];
  const useList = promoAssumption === 'list_price';
  const tailAgg = aggregateTurnsByModel(tailTurns || [], pricingState, useList);
  const tailWeightedUsd =
    activeLvlObj._modelWeights
      ? segmentTotalWeightedSpend(
          tailAgg,
          activeLvlObj._alphaCache ?? 1.0,
          activeLvlObj._alphaOut ?? 1.0,
          activeLvlObj._modelWeights
        )
      : tailAgg.rawSpendUsd;

  const cleanLevels = {
    L0: stripInternalLevelFields(chosen.levels.L0),
    L1: stripInternalLevelFields(chosen.levels.L1),
    L2: stripInternalLevelFields(chosen.levels.L2),
    L3: stripInternalLevelFields(chosen.levels.L3),
  };

  return {
    recommendedLevel: chosen.recommendedLevel,
    activeLevel,
    anchorModel: chosen.anchorModel,
    anchorSource: chosen.anchorSource,
    availableAnchorModels: chosen.availableAnchorModels,
    promoIdentifiable: chosen.promoIdentifiable,
    promoAssumption,
    segmentsCount: chosen.segmentsCount,
    levels: cleanLevels,
    activeMeta: {
      anchorPoolUsd: activeLvlObj.anchorPoolUsd,
      equivalentMixPoolUsd: activeLvlObj.equivalentMixPoolUsd,
      seBeta: activeLvlObj.seBeta,
      tailWeightedUsd,
      tailRawUsd: tailAgg.rawSpendUsd,
    },
  };
}
