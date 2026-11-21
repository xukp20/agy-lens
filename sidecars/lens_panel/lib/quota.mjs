/**
 * Subscription quota alignment anchors & hierarchical single-cycle calibrator.
 * Completely independent of CLI; stores user-recorded anchors in telemetry_cache.db.
 *
 * Key design invariants:
 * - Only explicit user-provided reset_at values are persisted; cycle reset inheritance
 *   is computed dynamically at read time so editing/deleting anchors never leaves stale copies.
 * - Reset timestamps carry precision intervals [resetLo, resetHi] so coarse countdowns
 *   (e.g. "6d 23h") converge via interval intersection instead of falsely splitting cycles.
 * - Two-pass cycle segmentation clusters explicit resets first, then assigns anchors with
 *   conservative ambiguity-band handling (defaulting boundary anchors to the older cycle).
 */
import { calculateTurnCost } from './pricing.mjs';
import { calibrateQuotaCycle } from './quota_calibrator.mjs';

export const VALID_POOLS = ['gemini', 'argon', '3p'];
export const VALID_WINDOWS = ['5h', '7d'];
export const WINDOW_DURATION_MS = {
  '5h': 5 * 3600 * 1000,
  '7d': 7 * 86400 * 1000,
};

const DAY_MS = 86400 * 1000;
const HOUR_MS = 3600 * 1000;
const REL_MIN_MS = 5 * 60 * 1000;
const MIN_MS = 60 * 1000;
const SEC_MS = 1000;
const DEFAULT_LEGACY_PRECISION_MS = HOUR_MS;
const DEFAULT_EXPLICIT_PRECISION_MS = MIN_MS;
const FUTURE_CAPTURE_TOL_MS = MIN_MS;
const FALLBACK_SPAN_TOL_MS = 5 * MIN_MS;

export function getWindowDurationMs(windowType) {
  const wt = normalizeWindowType(windowType);
  return wt ? WINDOW_DURATION_MS[wt] : 0;
}

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

export function normalizeResetPrecisionMs(rawPrecisionMs, source = 'explicit') {
  if (rawPrecisionMs !== null && rawPrecisionMs !== undefined && rawPrecisionMs !== '') {
    const n = Number(rawPrecisionMs);
    if (Number.isFinite(n) && n > 0) {
      if (n >= DAY_MS) return DAY_MS;
      if (n >= HOUR_MS) return HOUR_MS;
      if (n >= REL_MIN_MS) return REL_MIN_MS;
      if (n >= MIN_MS) return MIN_MS;
      return SEC_MS;
    }
  }
  return source === 'explicit' ? DEFAULT_EXPLICIT_PRECISION_MS : DEFAULT_LEGACY_PRECISION_MS;
}

/**
 * Convert a point resetAt + input granularity into an uncertainty envelope [lo, hi].
 * - Day-only countdowns (e.g. "5d"): [-12h, +24h] (covers floor & round)
 * - Hour-level countdowns (e.g. "6d 23h"): [-30m, +60m] (covers floor & round)
 * - Relative minute countdowns (e.g. "3h20m" with capture-time jitter): [-5m, +5m]
 * - Absolute minute timestamps (e.g. "11-28 10:30", "18:30"): [-90s, +90s]
 * - Exact second / ISO timestamps: [-5s, +5s]
 */
export function buildResetInterval(resetAt, precisionMs = DEFAULT_EXPLICIT_PRECISION_MS) {
  const ts = Math.round(Number(resetAt));
  const p = normalizeResetPrecisionMs(precisionMs, 'explicit');
  if (p >= DAY_MS) {
    return { lo: ts - 12 * HOUR_MS, hi: ts + 24 * HOUR_MS, precisionMs: DAY_MS };
  }
  if (p >= HOUR_MS) {
    return { lo: ts - 30 * MIN_MS, hi: ts + 60 * MIN_MS, precisionMs: HOUR_MS };
  }
  if (p >= REL_MIN_MS) {
    return { lo: ts - 5 * MIN_MS, hi: ts + 5 * MIN_MS, precisionMs: REL_MIN_MS };
  }
  if (p >= MIN_MS) {
    return { lo: ts - 90 * SEC_MS, hi: ts + 90 * SEC_MS, precisionMs: MIN_MS };
  }
  return { lo: ts - 5 * SEC_MS, hi: ts + 5 * SEC_MS, precisionMs: SEC_MS };
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

/**
 * Retained for compatibility with demo/external callers: resolves an inheritable resetAt in memory.
 * Note: addQuotaAnchor no longer persists inherited reset_at values into SQLite.
 */
export function resolveInheritedResetAt(prevAnchor, capturedAt, remainingPct, explicitResetAt = null) {
  if (explicitResetAt !== null && explicitResetAt !== undefined) {
    return explicitResetAt;
  }
  if (
    prevAnchor &&
    prevAnchor.reset_at != null &&
    prevAnchor.reset_at > capturedAt &&
    remainingPct <= prevAnchor.remaining_pct + 2.0
  ) {
    return prevAnchor.reset_at;
  }
  return null;
}

function getResetValidationToleranceMs(windowType) {
  return windowType === '5h' ? 30 * MIN_MS : 90 * MIN_MS;
}

export function validateResetAtForWindow(capturedAt, resetAt, windowType) {
  const windowMs = getWindowDurationMs(windowType);
  if (!windowMs) throw new Error('Invalid windowType (expected 5h or 7d)');
  const tol = getResetValidationToleranceMs(windowType);
  if (resetAt < capturedAt - tol) {
    throw new Error(`resetAt cannot be earlier than capturedAt for ${windowType} window`);
  }
  if (resetAt > capturedAt + windowMs + tol) {
    throw new Error(
      `resetAt exceeds ${windowType} window duration from capturedAt (check if 7d countdown was entered into 5h)`
    );
  }
}

export function addQuotaAnchor(cacheDb, payload, nowMs = Date.now()) {
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

  const rawCapturedAt =
    payload?.capturedAt !== undefined && payload?.capturedAt !== null && payload?.capturedAt !== ''
      ? Number(payload.capturedAt)
      : nowMs;
  if (!Number.isFinite(rawCapturedAt) || rawCapturedAt <= 0) {
    throw new Error('Invalid capturedAt timestamp');
  }
  const capturedAt = Math.round(rawCapturedAt);
  if (capturedAt > nowMs + FUTURE_CAPTURE_TOL_MS) {
    throw new Error('capturedAt cannot be in the future');
  }

  // Persist ONLY explicit user-provided resetAt; inheritance is derived dynamically at read time.
  let resetAt = null;
  let resetSource = '';
  let resetPrecisionMs = null;
  if (payload?.resetAt !== undefined && payload?.resetAt !== null && payload?.resetAt !== '') {
    const r = Number(payload.resetAt);
    if (!Number.isFinite(r) || r <= 0) throw new Error('Invalid resetAt timestamp');
    resetAt = Math.round(r);
    validateResetAtForWindow(capturedAt, resetAt, windowType);
    resetSource = 'explicit';
    resetPrecisionMs = normalizeResetPrecisionMs(payload?.resetPrecisionMs, 'explicit');
  }

  const note = typeof payload?.note === 'string' ? payload.note.trim().slice(0, 240) : '';

  const info = cacheDb
    .prepare(
      `INSERT INTO quota_anchors (
         pool, window_type, remaining_pct, precision_step, captured_at,
         reset_at, reset_source, reset_precision_ms, note, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      pool,
      windowType,
      remainingPct,
      precisionStep,
      capturedAt,
      resetAt,
      resetSource,
      resetPrecisionMs,
      note,
      nowMs
    );

  return Number(info.lastInsertRowid);
}

export function updateQuotaAnchor(cacheDb, payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid update payload');
  }
  const numId = Number(payload.id);
  if (!Number.isInteger(numId) || numId <= 0) {
    throw new Error('Invalid anchor id');
  }
  const existing = cacheDb.prepare('SELECT * FROM quota_anchors WHERE id = ?').get(numId);
  if (!existing) {
    throw new Error(`Anchor #${numId} not found`);
  }

  let nextResetAt = existing.reset_at ?? null;
  let nextResetSource = existing.reset_source || '';
  let nextResetPrecisionMs = existing.reset_precision_ms ?? null;

  if (Object.prototype.hasOwnProperty.call(payload, 'resetAt')) {
    if (payload.resetAt === null || payload.resetAt === '' || payload.resetAt === undefined) {
      nextResetAt = null;
      nextResetSource = '';
      nextResetPrecisionMs = null;
    } else {
      const r = Number(payload.resetAt);
      if (!Number.isFinite(r) || r <= 0) throw new Error('Invalid resetAt timestamp');
      nextResetAt = Math.round(r);
      validateResetAtForWindow(Number(existing.captured_at), nextResetAt, existing.window_type);
      nextResetSource = 'explicit';
      nextResetPrecisionMs = normalizeResetPrecisionMs(payload?.resetPrecisionMs, 'explicit');
    }
  } else if (
    Object.prototype.hasOwnProperty.call(payload, 'resetPrecisionMs') &&
    nextResetAt != null
  ) {
    nextResetPrecisionMs = normalizeResetPrecisionMs(
      payload.resetPrecisionMs,
      nextResetSource || 'explicit'
    );
  }

  const nextNote =
    Object.prototype.hasOwnProperty.call(payload, 'note') && typeof payload.note === 'string'
      ? payload.note.trim().slice(0, 240)
      : existing.note || '';

  const info = cacheDb
    .prepare(
      `UPDATE quota_anchors
       SET reset_at = ?, reset_source = ?, reset_precision_ms = ?, note = ?
       WHERE id = ?`
    )
    .run(nextResetAt, nextResetSource, nextResetPrecisionMs, nextNote, numId);

  return info.changes > 0;
}

export function deleteQuotaAnchor(cacheDb, id) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    throw new Error('Invalid anchor id');
  }
  const info = cacheDb.prepare('DELETE FROM quota_anchors WHERE id = ?').run(numId);
  return info.changes > 0;
}

function getReboundThreshold(a0, a1) {
  const s0 = Number(a0?.precision_step ?? a0?.precisionStep ?? 1) || 1;
  const s1 = Number(a1?.precision_step ?? a1?.precisionStep ?? 1) || 1;
  return Math.max(2.0, 2 * Math.max(s0, s1));
}

function extractAuthoritativeReset(row) {
  if (row?.reset_at == null) return null;
  const rawSource = String(row.reset_source || '').trim().toLowerCase();
  if (rawSource === 'inherited') return null;
  const ts = Number(row.reset_at);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const source = rawSource === 'explicit' ? 'explicit' : 'legacy';
  const rawPrec = row.reset_precision_ms ?? row.resetPrecisionMs ?? null;
  const precisionMs =
    rawPrec != null && Number(rawPrec) > 0
      ? normalizeResetPrecisionMs(rawPrec, source)
      : source === 'explicit'
        ? DEFAULT_EXPLICIT_PRECISION_MS
        : DEFAULT_LEGACY_PRECISION_MS;
  const interval = buildResetInterval(ts, precisionMs);
  return {
    resetAt: Math.round(ts),
    source,
    precisionMs: interval.precisionMs,
    lo: interval.lo,
    hi: interval.hi,
    createdAt: Number(row.created_at ?? row.createdAt ?? row.captured_at ?? 0),
    id: Number(row.id ?? 0),
    capturedAt: Number(row.captured_at ?? 0),
    row,
  };
}

function isNewerOrHigherPriorityReset(candidate, current) {
  if (candidate.source === 'explicit' && current.source !== 'explicit') return true;
  if (candidate.source !== 'explicit' && current.source === 'explicit') return false;
  if (candidate.precisionMs !== current.precisionMs) {
    return candidate.precisionMs < current.precisionMs;
  }
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt;
  return candidate.id >= current.id;
}

function splitGapRun(run, windowMs) {
  if (!run || run.length === 0) return [];
  const groups = [[run[0]]];
  for (let i = 1; i < run.length; i++) {
    const prev = run[i - 1];
    const cur = run[i];
    const active = groups[groups.length - 1];
    const spanExceeded =
      windowMs > 0 && cur.captured_at - active[0].captured_at > windowMs + FALLBACK_SPAN_TOL_MS;
    const pctJumpedUp = cur.remaining_pct > prev.remaining_pct + getReboundThreshold(prev, cur);
    if (spanExceeded || pctJumpedUp) {
      groups.push([cur]);
    } else {
      active.push(cur);
    }
  }
  return groups;
}

function splitInternalRebounds(anchors, explicitRowSet) {
  if (!anchors || anchors.length <= 1) return [anchors];
  const groups = [[anchors[0]]];
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    const pctJumpedUp = cur.remaining_pct > prev.remaining_pct + getReboundThreshold(prev, cur);
    // Only split inside an explicit-reset cycle when a later non-explicit anchor clearly rebounded
    // (e.g. an early reset occurred and user forgot to enter the new reset time).
    if (pctJumpedUp && !explicitRowSet.has(cur)) {
      groups.push([cur]);
    } else {
      groups[groups.length - 1].push(cur);
    }
  }
  return groups;
}

/**
 * Two-pass cycle segmentation for ordered anchors of a single (pool, window_type).
 * Pass 1: Cluster explicit/legacy reset_at readings into cycle windows using interval overlap
 *         and 3-tier classification (shift > W/2 -> new cycle; overlap -> intersect;
 *         disjoint within W/2 -> correction conflict resolved by explicit & latest created_at).
 * Pass 2: Assign all anchors by captured_at into cycle windows. Anchors in the boundary
 *         ambiguity band [startLo, startHi) default to the older cycle unless they clearly
 *         show post-reset rebound or near-100% remaining. Unassigned gaps fall back to
 *         max-span and adaptive-rebound segmentation.
 */
export function buildCycleDescriptors(orderedAnchors, windowType = null) {
  if (!orderedAnchors || orderedAnchors.length === 0) return [];
  const sorted = [...orderedAnchors].sort(
    (a, b) => (a.captured_at - b.captured_at) || ((a.id || 0) - (b.id || 0))
  );
  const inferredWt =
    windowType || sorted[0]?.window_type || sorted[0]?.windowType || null;
  const windowMs = getWindowDurationMs(inferredWt);

  // Pass 1: Cluster explicit/legacy resets.
  const resetEntries = [];
  for (const row of sorted) {
    const info = extractAuthoritativeReset(row);
    if (info) resetEntries.push(info);
  }

  const clusters = [];
  for (const entry of resetEntries) {
    let matched = null;
    for (let i = clusters.length - 1; i >= 0; i--) {
      const cl = clusters[i];
      const delta = entry.resetAt - cl.resetAt;
      const absDelta = Math.abs(delta);
      const intervalsOverlap = Math.max(cl.resetLo, entry.lo) <= Math.min(cl.resetHi, entry.hi);

      // Clearly a later cycle if reset shifted forward > W/2 or capture crossed resetHi.
      if (windowMs > 0 && (delta > windowMs / 2 || entry.capturedAt > cl.resetHi)) {
        break;
      }
      if (intervalsOverlap || (windowMs > 0 && absDelta <= windowMs / 2)) {
        matched = cl;
        break;
      }
      if (windowMs === 0 && absDelta <= FALLBACK_SPAN_TOL_MS) {
        matched = cl;
        break;
      }
    }

    if (!matched) {
      clusters.push({
        resetAt: entry.resetAt,
        resetLo: entry.lo,
        resetHi: entry.hi,
        source: entry.source,
        precisionMs: entry.precisionMs,
        winner: entry,
        resetConflict: false,
        members: new Set([entry.row]),
        entries: [entry],
      });
      continue;
    }

    matched.members.add(entry.row);
    matched.entries.push(entry);

    const overlapLo = Math.max(matched.resetLo, entry.lo);
    const overlapHi = Math.min(matched.resetHi, entry.hi);

    if (overlapLo <= overlapHi) {
      // Same cycle: intersect intervals to sharpen precision.
      matched.resetLo = overlapLo;
      matched.resetHi = overlapHi;
      if (entry.source === 'explicit' && matched.source !== 'explicit') {
        matched.source = 'explicit';
      }
      const prevWinner = matched.winner;
      const preferCandidate =
        (entry.source === 'explicit' && prevWinner.source !== 'explicit') ||
        (entry.source === prevWinner.source && entry.precisionMs < prevWinner.precisionMs) ||
        (entry.source === prevWinner.source &&
          entry.precisionMs === prevWinner.precisionMs &&
          isNewerOrHigherPriorityReset(entry, prevWinner));
      if (preferCandidate) {
        matched.winner = entry;
        matched.precisionMs = Math.min(matched.precisionMs, entry.precisionMs);
      }
      // Keep representative resetAt centered inside the converged interval when winner lies outside,
      // or use converged midpoint for equal-coarse readings.
      if (matched.winner.resetAt >= overlapLo && matched.winner.resetAt <= overlapHi) {
        matched.resetAt =
          matched.precisionMs >= HOUR_MS
            ? Math.round((overlapLo + overlapHi) / 2)
            : matched.winner.resetAt;
      } else {
        matched.resetAt = Math.round((overlapLo + overlapHi) / 2);
      }
    } else {
      // Disjoint within W/2 -> correction conflict; explicit & latest created_at wins.
      matched.resetConflict = true;
      if (isNewerOrHigherPriorityReset(entry, matched.winner)) {
        matched.winner = entry;
        matched.resetAt = entry.resetAt;
        matched.resetLo = entry.lo;
        matched.resetHi = entry.hi;
        matched.source = entry.source;
        matched.precisionMs = entry.precisionMs;
      }
    }
  }

  clusters.sort((a, b) => a.resetAt - b.resetAt);

  // Build explicit cycle slots.
  const explicitSlots = clusters.map((cl) => ({
    hasReset: true,
    startLo: windowMs > 0 ? cl.resetLo - windowMs : null,
    startHi: windowMs > 0 ? cl.resetHi - windowMs : null,
    startMs: windowMs > 0 ? cl.resetAt - windowMs : null,
    resetLo: cl.resetLo,
    resetHi: cl.resetHi,
    endMs: cl.resetAt,
    resetSource: cl.source,
    resetPrecisionMs: cl.precisionMs,
    resetConflict: cl.resetConflict,
    members: cl.members,
    anchors: [],
  }));

  if (explicitSlots.length === 0) {
    return splitGapRun(sorted, windowMs).map((anchors) => ({
      hasReset: false,
      startLo: null,
      startHi: null,
      startMs: null,
      resetLo: null,
      resetHi: null,
      endMs: null,
      resetSource: '',
      resetPrecisionMs: null,
      resetConflict: false,
      anchors,
    }));
  }

  // Precompute earliest strictly-inside anchor per slot to help resolve start ambiguity bands (B3).
  const firstStrictInsideBySlot = explicitSlots.map((slot) => {
    for (const a of sorted) {
      if (slot.startHi != null && a.captured_at >= slot.startHi && a.captured_at <= slot.resetHi) {
        return a;
      }
      if (slot.members.has(a)) return a;
    }
    return null;
  });

  // Pass 2: Assign each anchor to either an explicit slot or a gap bucket [0..explicitSlots.length].
  const gapBuckets = Array.from({ length: explicitSlots.length + 1 }, () => []);

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const prevAnchor = i > 0 ? sorted[i - 1] : null;
    let assigned = false;

    for (let k = 0; k < explicitSlots.length; k++) {
      const slot = explicitSlots[k];
      const prevSlot = k > 0 ? explicitSlots[k - 1] : null;

      // Direct member of this slot's explicit reset cluster (unless clearly captured before its own window).
      if (slot.members.has(a) && (slot.startLo == null || a.captured_at >= slot.startLo)) {
        slot.anchors.push(a);
        assigned = true;
        break;
      }

      if (slot.startLo == null) continue;

      // Strictly before this slot -> belongs in gap bucket k (before slot k).
      if (a.captured_at < slot.startLo) {
        gapBuckets[k].push(a);
        assigned = true;
        break;
      }

      // Start ambiguity band [startLo, startHi): default to OLDER cycle (prevSlot or gap k)
      // unless slot already started earlier or anchor clearly shows post-reset rebound / near 100%.
      if (a.captured_at < slot.startHi) {
        if (slot.anchors.length > 0) {
          slot.anchors.push(a);
          assigned = true;
          break;
        }
        const nextInSlot = firstStrictInsideBySlot[k];
        const reboundThresh = prevAnchor ? getReboundThreshold(prevAnchor, a) : 2.0;
        const consistentWithNew =
          nextInSlot == null || a.remaining_pct >= nextInSlot.remaining_pct - 0.5;
        const clearlyPostReset =
          (prevAnchor != null && a.remaining_pct > prevAnchor.remaining_pct + reboundThresh) ||
          a.remaining_pct >= 98.0;

        if (consistentWithNew && clearlyPostReset) {
          slot.anchors.push(a);
        } else if (prevSlot && a.captured_at <= prevSlot.resetHi) {
          prevSlot.anchors.push(a);
        } else {
          gapBuckets[k].push(a);
        }
        assigned = true;
        break;
      }

      // Strictly inside [startHi, resetLo].
      if (a.captured_at <= slot.resetLo) {
        slot.anchors.push(a);
        assigned = true;
        break;
      }

      // End ambiguity band (resetLo, resetHi]: keep in slot unless clear rebound occurred.
      if (a.captured_at <= slot.resetHi) {
        const prevInSlot = slot.anchors.length > 0 ? slot.anchors[slot.anchors.length - 1] : null;
        const reboundInEndBand =
          prevInSlot != null &&
          a.remaining_pct > prevInSlot.remaining_pct + getReboundThreshold(prevInSlot, a);
        if (reboundInEndBand) {
          // Leave for next slot or post-slot gap.
          continue;
        }
        slot.anchors.push(a);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      gapBuckets[explicitSlots.length].push(a);
    }
  }

  // Assemble chronological cycle list from interleaved gap buckets and explicit slots.
  const descriptors = [];
  for (let k = 0; k <= explicitSlots.length; k++) {
    const gapGroups = splitGapRun(gapBuckets[k], windowMs);
    for (const grp of gapGroups) {
      descriptors.push({
        hasReset: false,
        startLo: null,
        startHi: null,
        startMs: null,
        resetLo: null,
        resetHi: null,
        endMs: null,
        resetSource: '',
        resetPrecisionMs: null,
        resetConflict: false,
        anchors: grp,
      });
    }
    if (k < explicitSlots.length && explicitSlots[k].anchors.length > 0) {
      const slot = explicitSlots[k];
      const subGroups = splitInternalRebounds(slot.anchors, slot.members);
      // Only a single subgroup (the one owning slot's reset members, defaulting to index 0)
      // inherits the slot's explicit reset bounds, preventing duplicate cycle keys/ranges (M1).
      let ownerIdx = subGroups.findIndex((grp) => grp.some((a) => slot.members.has(a)));
      if (ownerIdx === -1) ownerIdx = 0;
      for (let sgIdx = 0; sgIdx < subGroups.length; sgIdx++) {
        const grp = subGroups[sgIdx];
        const isOwner = sgIdx === ownerIdx;
        descriptors.push({
          hasReset: isOwner,
          startLo: isOwner ? slot.startLo : null,
          startHi: isOwner ? slot.startHi : null,
          startMs: isOwner ? slot.startMs : null,
          resetLo: isOwner ? slot.resetLo : null,
          resetHi: isOwner ? slot.resetHi : null,
          endMs: isOwner ? slot.endMs : null,
          resetSource: isOwner ? slot.resetSource : '',
          resetPrecisionMs: isOwner ? slot.resetPrecisionMs : null,
          resetConflict: isOwner ? slot.resetConflict : false,
          anchors: grp,
        });
      }
    }
  }

  return descriptors;
}

/**
 * Compatibility wrapper returning Array<Array<anchor>> from the two-pass cycle engine.
 */
export function segmentCycles(orderedAnchors, windowType = null) {
  return buildCycleDescriptors(orderedAnchors, windowType).map((c) => c.anchors);
}

function getPoolTurnsInInterval(cacheDb, pool, startExclusiveMs, endInclusiveMs) {
  if (!cacheDb || endInclusiveMs <= startExclusiveMs) return [];
  return cacheDb
    .prepare(
      `SELECT * FROM turns
       WHERE pool = ? AND completed_at_ms > ? AND completed_at_ms <= ?
       ORDER BY completed_at_ms ASC`
    )
    .all(pool, startExclusiveMs, endInclusiveMs);
}

function sumTurnsSpend(turns, pricingState, modelSpendMap) {
  let sum = 0;
  for (const t of turns) {
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

function sumPoolSpendInInterval(cacheDb, pricingState, pool, startExclusiveMs, endInclusiveMs, modelSpendMap) {
  if (endInclusiveMs <= startExclusiveMs) return 0;
  const rows = getPoolTurnsInInterval(cacheDb, pool, startExclusiveMs, endInclusiveMs);
  return sumTurnsSpend(rows, pricingState, modelSpendMap);
}

function formatAnchor(row, effectiveResetAt = null) {
  const explicitReset = row.reset_at != null ? Number(row.reset_at) : null;
  const resetSource =
    explicitReset != null
      ? row.reset_source === 'explicit'
        ? 'explicit'
        : 'legacy'
      : effectiveResetAt != null
        ? 'inherited'
        : '';
  return {
    id: row.id,
    pool: row.pool,
    windowType: row.window_type,
    remainingPct: row.remaining_pct,
    precisionStep: row.precision_step,
    capturedAt: row.captured_at,
    resetAt: explicitReset,
    effectiveResetAt: explicitReset ?? effectiveResetAt ?? null,
    resetSource,
    resetPrecisionMs: row.reset_precision_ms != null ? Number(row.reset_precision_ms) : null,
    note: row.note || '',
    createdAt: row.created_at,
  };
}

function computeCycleBriefAndSpend(
  cycleDesc,
  pool,
  pricingState,
  turnsFn,
  sumSpend,
  nowMs,
  nextCycleBoundaryMs = null
) {
  const anchors = cycleDesc.anchors;
  const firstRow = anchors[0];
  const lastRow = anchors[anchors.length - 1];

  // Bound historical tail end strictly so past gap/rebound cycles never bleed into later cycles (I1).
  let upperEndMs = nowMs;
  if (cycleDesc.resetHi != null) upperEndMs = Math.min(upperEndMs, cycleDesc.resetHi);
  if (nextCycleBoundaryMs != null) upperEndMs = Math.min(upperEndMs, nextCycleBoundaryMs);
  if (cycleDesc.resetHi == null && nextCycleBoundaryMs == null) {
    upperEndMs = lastRow.captured_at;
  }

  let segSpend = 0;
  let segCount = 0;
  for (let i = 1; i < anchors.length; i++) {
    const a0 = anchors[i - 1];
    const a1 = anchors[i];
    if (a1.captured_at <= a0.captured_at) continue;
    const spend = turnsFn
      ? sumTurnsSpend(turnsFn(pool, a0.captured_at, a1.captured_at) || [], pricingState)
      : sumSpend(pool, a0.captured_at, a1.captured_at);
    segSpend += spend;
    if (a0.remaining_pct > a1.remaining_pct) segCount++;
  }

  let preSpend = 0;
  if (cycleDesc.startHi != null) {
    const preStart = Math.min(cycleDesc.startHi, firstRow.captured_at);
    if (firstRow.captured_at > preStart) {
      preSpend = turnsFn
        ? sumTurnsSpend(turnsFn(pool, preStart, firstRow.captured_at) || [], pricingState)
        : sumSpend(pool, preStart, firstRow.captured_at);
    }
  }

  const tailEnd = Math.max(lastRow.captured_at, upperEndMs);
  const tailSpend =
    tailEnd > lastRow.captured_at
      ? turnsFn
        ? sumTurnsSpend(turnsFn(pool, lastRow.captured_at, tailEnd) || [], pricingState)
        : sumSpend(pool, lastRow.captured_at, tailEnd)
      : 0;

  const totalSpend = preSpend + segSpend + tailSpend;
  const realDeltaU =
    anchors.length >= 2 ? (firstRow.remaining_pct - lastRow.remaining_pct) / 100 : 0;
  const bootDeltaU =
    cycleDesc.startHi != null && lastRow.remaining_pct < 100
      ? (100 - lastRow.remaining_pct) / 100
      : 0;

  let estimatedPoolUsd = null;
  let totalDeltaPct = 0;
  let status = 'calibrating';
  if (realDeltaU > 0 && segSpend > 0) {
    estimatedPoolUsd = segSpend / realDeltaU;
    totalDeltaPct = Number((realDeltaU * 100).toFixed(4));
    status = realDeltaU >= 0.01 ? 'ok' : 'low_confidence';
  } else if (bootDeltaU > 0 && preSpend + segSpend > 0) {
    estimatedPoolUsd = (preSpend + segSpend) / bootDeltaU;
    totalDeltaPct = Number((bootDeltaU * 100).toFixed(4));
    status = 'low_confidence';
  }

  return {
    spendUsd: totalSpend,
    estimationBrief: {
      status,
      estimatedPoolUsd,
      totalDeltaPct,
      segmentsUsed: segCount > 0 ? segCount : estimatedPoolUsd != null ? 1 : 0,
      cycleWindowStart: cycleDesc.startMs,
      cycleResetAt: cycleDesc.endMs,
    },
  };
}

/**
 * Shared first-turn-triggered rollover inference after an expired cycle's resetHi.
 * Used both when no new anchor exists yet (Path A) and when a new anchor was logged
 * after expiry without an explicit resetAt (Path B / B1).
 * Also computes earliest (fixed-cadence) vs latest (first-turn) reset bounds (I5).
 */
function inferRolloverWindow(expiryBoundaryMs, windowMs, pool, pricingState, turnsFn, sumSpend, upperMs) {
  const mixMap = new Map();
  let inferredStart = null;
  let inferredEnd = null;
  let inferredEndEarliest = null;
  let inferredEndLatest = null;
  let cycleSpendUsd = 0;
  let cycleState = 'awaiting_activity';
  const multiWindowInferred = windowMs > 0 && upperMs > expiryBoundaryMs + windowMs;

  if (turnsFn) {
    const postTurns = turnsFn(pool, expiryBoundaryMs, upperMs) || [];
    if (postTurns.length > 0 && windowMs > 0) {
      let s = Number(postTurns[0].completed_at_ms);
      let r = s + windowMs;
      let idx = 0;
      while (upperMs > r) {
        let nextIdx = -1;
        for (let j = idx + 1; j < postTurns.length; j++) {
          if (Number(postTurns[j].completed_at_ms) > r) {
            nextIdx = j;
            break;
          }
        }
        if (nextIdx === -1) {
          s = null;
          r = null;
          break;
        }
        idx = nextIdx;
        s = Number(postTurns[idx].completed_at_ms);
        r = s + windowMs;
      }
      if (s != null) {
        inferredStart = s;
        inferredEnd = r;
        const fixedK = Math.max(1, Math.floor((upperMs - expiryBoundaryMs) / windowMs) + 1);
        const fixedEnd = expiryBoundaryMs + fixedK * windowMs;
        inferredEndEarliest = Math.min(fixedEnd, r);
        inferredEndLatest = Math.max(fixedEnd, r);
        cycleState = 'expired_inferred';
        const activeTurns = postTurns.slice(idx);
        cycleSpendUsd = sumTurnsSpend(activeTurns, pricingState, mixMap);
      }
    } else if (postTurns.length > 0) {
      inferredStart = Number(postTurns[0].completed_at_ms);
      cycleState = 'expired_inferred';
      cycleSpendUsd = sumTurnsSpend(postTurns, pricingState, mixMap);
    }
  } else {
    cycleSpendUsd = sumSpend(pool, expiryBoundaryMs, upperMs, mixMap);
    if (cycleSpendUsd > 0) {
      const fixedK = windowMs > 0 ? Math.max(0, Math.floor((upperMs - expiryBoundaryMs) / windowMs)) : 0;
      inferredStart = windowMs > 0 ? expiryBoundaryMs + fixedK * windowMs : expiryBoundaryMs;
      inferredEnd = windowMs > 0 ? inferredStart + windowMs : null;
      inferredEndEarliest = inferredEnd;
      inferredEndLatest = inferredEnd;
      cycleState = 'expired_inferred';
    }
  }

  return {
    inferredStart,
    inferredEnd,
    inferredEndEarliest,
    inferredEndLatest,
    multiWindowInferred,
    cycleSpendUsd,
    cycleState,
    mixMap,
  };
}

function getNextCycleBoundaryMs(allDescriptors, index) {
  const nextDesc = allDescriptors[index + 1];
  if (!nextDesc) return null;
  if (nextDesc.startLo != null) return nextDesc.startLo;
  return nextDesc.anchors?.[0]?.captured_at ?? null;
}

function makeCycleKey(pool, windowType, startMs, endMs, anchors) {
  const s = startMs ?? anchors?.[0]?.captured_at ?? 0;
  const e = endMs ?? anchors?.[anchors.length - 1]?.captured_at ?? 0;
  return `${pool}:${windowType}:${s}:${e}`;
}

function emptyEstimation() {
  return {
    status: 'no_data',
    originBootstrap: false,
    cycleOriginRefPoolUsd: null,
    totalDeltaPct: 0,
    segmentsUsed: 0,
    windowSpendUsd: 0,
    cycleSpendUsd: 0,
    estimatedPoolUsd: null,
    ciLowUsd: null,
    ciHighUsd: null,
    impliedRemainingUsd: null,
    precisionStepPct: null,
    modelMix: [],
    mixedModelWarning: false,
    calibration: null,
  };
}

export function computeSummaryForPair(
  cacheDb,
  pricingState,
  pool,
  windowType,
  orderedAnchors,
  nowMs = Date.now(),
  optionsOrSpendFn = null
) {
  const opts =
    typeof optionsOrSpendFn === 'function'
      ? { spendFn: optionsOrSpendFn }
      : optionsOrSpendFn || {};
  const spendFn = opts.spendFn || null;
  const turnsFn =
    opts.turnsFn ||
    (!spendFn && cacheDb ? (p, s, e) => getPoolTurnsInInterval(cacheDb, p, s, e) : null);
  const preferredAnchor = opts.preferredAnchor || null;
  const quotaCalibMode = opts.quotaCalibMode || 'auto';
  const quotaManualFactors = opts.quotaManualFactors || null;
  const forceSubset = opts.forceSubset || null;
  const forceLevel = opts.forceLevel || null;

  const sumSpend =
    spendFn || ((p, s, e, m) => sumPoolSpendInInterval(cacheDb, pricingState, p, s, e, m));
  const windowMs = getWindowDurationMs(windowType);
  const descriptors = buildCycleDescriptors(orderedAnchors, windowType);

  if (descriptors.length === 0) {
    return {
      pool,
      windowType,
      latestAnchor: null,
      inheritableResetAt: null,
      cycleWindowStart: null,
      cycleWindowStartLo: null,
      cycleWindowStartHi: null,
      cycleResetAt: null,
      cycleResetLo: null,
      cycleResetHi: null,
      prevCycleWindowStart: null,
      prevCycleWindowEnd: null,
      resetSource: '',
      resetConflict: false,
      cycleInferred: false,
      cycleExpired: false,
      cycleState: 'no_data',
      cycleSpendUsd: 0,
      preFirstAnchorSpendUsd: 0,
      spendSinceLastUsd: 0,
      projectedRemainingPct: null,
      evenUsePaceRatio: null,
      cycleCount: 0,
      cycles: [],
      currentCycleAnchors: [],
      olderCycleAnchors: [],
      previousCycleEstimation: null,
      estimation: emptyEstimation(),
    };
  }

  // Determine whether the latest recorded cycle has expired at nowMs.
  const latestDesc = descriptors[descriptors.length - 1];
  const latestRowInLatest = latestDesc.anchors[latestDesc.anchors.length - 1];
  const isLatestExpired =
    (latestDesc.resetHi != null && nowMs > latestDesc.resetHi) ||
    (latestDesc.resetHi == null &&
      windowMs > 0 &&
      nowMs - latestDesc.anchors[0].captured_at > windowMs + FALLBACK_SPAN_TOL_MS);

  // =========================================================================
  // Path A: Latest recorded cycle has expired -> archive it & infer new cycle
  // =========================================================================
  if (isLatestExpired) {
    const olderCycleAnchors = descriptors
      .flatMap((d) => d.anchors.map((a) => formatAnchor(a, d.endMs)))
      .sort((a, b) => b.capturedAt - a.capturedAt || b.id - a.id);

    const historyCycles = descriptors
      .map((d, idx) => {
        const nextBoundary = getNextCycleBoundaryMs(descriptors, idx);
        const brief = computeCycleBriefAndSpend(
          d,
          pool,
          pricingState,
          turnsFn,
          sumSpend,
          nowMs,
          nextBoundary
        );
        return {
          key: makeCycleKey(pool, windowType, d.startMs, d.endMs, d.anchors),
          pool,
          windowType,
          startMs: d.startMs ?? d.anchors[0].captured_at,
          startLo: d.startLo,
          startHi: d.startHi,
          endMs: d.endMs ?? d.anchors[d.anchors.length - 1].captured_at,
          resetLo: d.resetLo,
          resetHi: d.resetHi,
          prevCycleStartMs: d.startMs != null && windowMs > 0 ? d.startMs - windowMs : null,
          prevCycleEndMs: d.startMs,
          resetSource: d.resetSource,
          resetConflict: d.resetConflict,
          inferred: false,
          expired: true,
          isCurrent: false,
          anchorIds: [...d.anchors].reverse().map((a) => a.id),
          spendUsd: brief.spendUsd,
          estimationBrief: brief.estimationBrief,
        };
      })
      .reverse();

    const prevBrief = historyCycles[0]?.estimationBrief || null;
    const previousCycleEstimation =
      prevBrief && prevBrief.estimatedPoolUsd != null
        ? {
            estimatedPoolUsd: prevBrief.estimatedPoolUsd,
            status: prevBrief.status,
            totalDeltaPct: prevBrief.totalDeltaPct,
            segmentsUsed: prevBrief.segmentsUsed,
            cycleWindowStart: prevBrief.cycleWindowStart,
            cycleResetAt: prevBrief.cycleResetAt,
            spendUsd: historyCycles[0].spendUsd,
          }
        : null;

    // First-turn-triggered chained inference after resetHi (works for both fixed & first-turn windows).
    const expiryBoundaryMs =
      latestDesc.resetHi ?? latestDesc.anchors[0].captured_at + windowMs;
    const rollover = inferRolloverWindow(
      expiryBoundaryMs,
      windowMs,
      pool,
      pricingState,
      turnsFn,
      sumSpend,
      nowMs
    );
    const {
      inferredStart,
      inferredEnd,
      inferredEndEarliest,
      inferredEndLatest,
      multiWindowInferred,
      cycleSpendUsd,
      cycleState,
      mixMap: postMixMap,
    } = rollover;

    const totalMixUsd = [...postMixMap.values()].reduce((a, b) => a + b, 0);
    const modelMix = [...postMixMap.entries()]
      .map(([canonicalId, usd]) => ({
        canonicalId,
        share: totalMixUsd > 0 ? usd / totalMixUsd : 0,
      }))
      .sort((a, b) => b.share - a.share);

    const activeVirtualCycle = {
      key: makeCycleKey(pool, windowType, inferredStart ?? expiryBoundaryMs, inferredEnd ?? nowMs, []),
      pool,
      windowType,
      startMs: inferredStart,
      startLo: inferredStart,
      startHi: inferredStart,
      endMs: inferredEnd,
      resetLo: inferredEndEarliest ?? inferredEnd,
      resetHi: inferredEndLatest ?? inferredEnd,
      prevCycleStartMs: latestDesc.startMs,
      prevCycleEndMs: latestDesc.endMs,
      resetSource: '',
      resetConflict: false,
      inferred: true,
      multiWindowInferred,
      expired: false,
      isCurrent: true,
      anchorIds: [],
      spendUsd: cycleSpendUsd,
      estimationBrief: null,
    };

    const est = emptyEstimation();
    est.windowSpendUsd = cycleSpendUsd;
    est.cycleSpendUsd = cycleSpendUsd;
    est.modelMix = modelMix;

    return {
      pool,
      windowType,
      latestAnchor: formatAnchor(latestRowInLatest, latestDesc.endMs),
      inheritableResetAt: null,
      cycleWindowStart: inferredStart,
      cycleWindowStartLo: inferredStart,
      cycleWindowStartHi: inferredStart,
      cycleResetAt: inferredEnd,
      cycleResetLo: inferredEndEarliest ?? inferredEnd,
      cycleResetHi: inferredEndLatest ?? inferredEnd,
      cycleResetEarliest: inferredEndEarliest,
      cycleResetLatest: inferredEndLatest,
      multiWindowInferred,
      prevCycleWindowStart: latestDesc.startMs,
      prevCycleWindowEnd: latestDesc.endMs,
      resetSource: '',
      resetConflict: false,
      cycleInferred: true,
      cycleExpired: true,
      cycleState,
      cycleSpendUsd,
      preFirstAnchorSpendUsd: 0,
      spendSinceLastUsd: cycleSpendUsd,
      projectedRemainingPct: null,
      evenUsePaceRatio: null,
      cycleCount: descriptors.length,
      cycles: [activeVirtualCycle, ...historyCycles],
      currentCycleAnchors: [],
      olderCycleAnchors,
      previousCycleEstimation,
      estimation: est,
    };
  }

  // =========================================================================
  // Path B: Active current cycle
  // =========================================================================
  const currentDesc = latestDesc;
  const olderDescs = descriptors.slice(0, -1);
  const latestCycle = currentDesc.anchors;
  const latestRow = latestCycle[latestCycle.length - 1];

  let cycleResetAt = currentDesc.endMs;
  let cycleResetLo = currentDesc.resetLo;
  let cycleResetHi = currentDesc.resetHi;
  let cycleWindowStart = currentDesc.startMs;
  let cycleWindowStartLo = currentDesc.startLo;
  let cycleWindowStartHi = currentDesc.startHi;
  let cycleInferred = false;
  let cycleResetEarliest = currentDesc.resetLo;
  let cycleResetLatest = currentDesc.resetHi;
  let multiWindowInferred = false;

  // B1 fix: if user logged a new anchor after the previous cycle expired WITHOUT entering a resetAt,
  // synthesize an inferred cycle boundary from the previous cycle's resetHi so pre-anchor spend &
  // 100% origin bootstrap are preserved rather than silently lost.
  const prevDesc = olderDescs.length > 0 ? olderDescs[olderDescs.length - 1] : null;
  if (cycleWindowStartHi == null && prevDesc?.resetHi != null && latestCycle[0].captured_at > prevDesc.resetHi) {
    const inferred = inferRolloverWindow(
      prevDesc.resetHi,
      windowMs,
      pool,
      pricingState,
      turnsFn,
      sumSpend,
      latestCycle[0].captured_at
    );
    const inferredStart = inferred.inferredStart ?? prevDesc.resetHi;
    const inferredEnd = inferred.inferredEnd ?? (windowMs > 0 ? inferredStart + windowMs : null);
    cycleWindowStart = inferredStart;
    cycleWindowStartLo = prevDesc.resetHi;
    cycleWindowStartHi = inferredStart;
    cycleResetAt = inferredEnd;
    cycleResetLo = inferred.inferredEndEarliest ?? inferredEnd;
    cycleResetHi = inferred.inferredEndLatest ?? inferredEnd;
    cycleResetEarliest = inferred.inferredEndEarliest ?? inferredEnd;
    cycleResetLatest = inferred.inferredEndLatest ?? inferredEnd;
    multiWindowInferred = inferred.multiWindowInferred;
    cycleInferred = true;
  }

  const prevCycleWindowStart =
    cycleWindowStart != null && windowMs > 0 ? cycleWindowStart - windowMs : null;
  const prevCycleWindowEnd = cycleWindowStart;

  const latestAnchor = formatAnchor(latestRow, cycleResetAt);
  const currentCycleAnchors = [...latestCycle].reverse().map((a) => formatAnchor(a, cycleResetAt));
  const olderCycleAnchors = olderDescs
    .flatMap((d) => d.anchors.map((a) => formatAnchor(a, d.endMs)))
    .sort((a, b) => b.capturedAt - a.capturedAt || b.id - a.id);

  const modelSpendMap = new Map();
  const rawSegments = [];

  for (let i = 1; i < latestCycle.length; i++) {
    const a0 = latestCycle[i - 1];
    const a1 = latestCycle[i];
    if (a1.captured_at < a0.captured_at) continue;
    const deltaU = (a0.remaining_pct - a1.remaining_pct) / 100;

    let turns = [];
    let spendUsd = 0;
    if (a1.captured_at > a0.captured_at) {
      if (turnsFn) {
        turns = turnsFn(pool, a0.captured_at, a1.captured_at) || [];
        spendUsd = sumTurnsSpend(turns, pricingState, modelSpendMap);
      } else {
        spendUsd = sumSpend(pool, a0.captured_at, a1.captured_at, modelSpendMap);
      }
    }
    const qK = Math.max(a0.precision_step, a1.precision_step) / 100;
    rawSegments.push({
      startAt: a0.captured_at,
      endAt: a1.captured_at,
      startPct: a0.remaining_pct,
      endPct: a1.remaining_pct,
      startPrecisionStep: a0.precision_step,
      endPrecisionStep: a1.precision_step,
      spendUsd,
      deltaU,
      qK,
      turns,
    });
  }

  // Conservative pre-first-anchor spend [preStart, a0.captured_at] when cycle start is known.
  // When cycleInferred is true, cycleWindowStart is the first turn's exact timestamp, so subtract 1ms
  // so strict-exclusive start (> preStart) still includes that triggering first turn.
  const preModelMap = new Map();
  let preFirstAnchorSpendUsd = 0;
  if (cycleWindowStartHi != null) {
    const rawPreStart = cycleInferred ? cycleWindowStartHi - 1 : cycleWindowStartHi;
    const preStart = Math.min(rawPreStart, latestCycle[0].captured_at);
    if (latestCycle[0].captured_at > preStart) {
      if (turnsFn) {
        const preTurns = turnsFn(pool, preStart, latestCycle[0].captured_at) || [];
        preFirstAnchorSpendUsd = sumTurnsSpend(preTurns, pricingState, preModelMap);
      } else {
        preFirstAnchorSpendUsd = sumSpend(pool, preStart, latestCycle[0].captured_at, preModelMap);
      }
    }
  }

  const endMs = cycleResetHi != null && nowMs > cycleResetHi ? cycleResetHi : nowMs;
  const tailModelMap = new Map();
  let tailTurns = [];
  let spendSinceLastUsd = 0;
  if (endMs > latestRow.captured_at) {
    if (turnsFn) {
      tailTurns = turnsFn(pool, latestRow.captured_at, endMs) || [];
      spendSinceLastUsd = sumTurnsSpend(tailTurns, pricingState, tailModelMap);
    } else {
      spendSinceLastUsd = sumSpend(pool, latestRow.captured_at, endMs, tailModelMap);
    }
  }

  const sumC = rawSegments.reduce((acc, s) => acc + s.spendUsd, 0);
  const sumDeltaU =
    latestCycle.length >= 2
      ? (latestCycle[0].remaining_pct - latestRow.remaining_pct) / 100
      : 0;
  const windowSpendUsd = sumC + spendSinceLastUsd;
  const cycleSpendUsd = preFirstAnchorSpendUsd + sumC + spendSinceLastUsd;

  const qEff =
    rawSegments.length > 0
      ? Math.max(...rawSegments.map((s) => s.qK))
      : latestRow.precision_step / 100;
  const precisionStepPct = Number((qEff * 100).toFixed(4));

  const minThreshold = qEff <= 0.00015 ? 0.002 : qEff <= 0.0015 ? 0.005 : 0.02;
  const highThreshold = qEff <= 0.00015 ? 0.01 : qEff <= 0.0015 ? 0.02 : 0.05;

  const calRaw = calibrateQuotaCycle({
    pool,
    windowType,
    pricingState,
    rawSegments,
    tailTurns,
    preferredAnchor,
    quotaCalibMode,
    quotaManualFactors,
    forceSubset,
    forceLevel,
    qEff,
    fallbackPooled: { sumC, sumDeltaU },
  });
  const activeMeta = calRaw.activeMeta;
  const calibration = {
    mode: calRaw.mode,
    recommendedSubset: calRaw.recommendedSubset,
    activeSubset: calRaw.activeSubset,
    activeFactors: calRaw.activeFactors,
    anchorModel: calRaw.anchorModel,
    anchorSource: calRaw.anchorSource,
    availableAnchorModels: calRaw.availableAnchorModels,
    promoIdentifiable: calRaw.promoIdentifiable,
    promoAssumption: calRaw.promoAssumption,
    rawSegmentsCount: calRaw.rawSegmentsCount,
    segmentsCount: calRaw.segmentsCount,
    coalescedCount: calRaw.coalescedCount,
    reboundMergedCount: calRaw.reboundMergedCount,
    huberDownweightedCount: calRaw.huberDownweightedCount,
    factors: calRaw.factors,
    subsets: calRaw.subsets,
  };

  let estimatedPoolUsd = null;
  let ciLowUsd = null;
  let ciHighUsd = null;
  let impliedRemainingUsd = null;
  let projectedRemainingPct = null;
  let status = 'calibrating';
  let originBootstrap = false;
  let totalDeltaPct = Math.max(0, Number((sumDeltaU * 100).toFixed(4)));
  let segmentsUsed =
    calRaw.segmentsCount > 0 ? calRaw.segmentsCount : rawSegments.filter((s) => s.deltaU > 0).length;

  const hasValidDifferential =
    (calRaw.segmentsCount > 0 || (sumDeltaU > 0 && sumC > 0)) &&
    sumDeltaU >= minThreshold &&
    sumC > 0 &&
    activeMeta.equivalentMixPoolUsd != null &&
    activeMeta.anchorPoolUsd != null &&
    activeMeta.anchorPoolUsd > 0;

  const bootDeltaU =
    cycleWindowStartHi != null && latestRow.remaining_pct < 100
      ? (100 - latestRow.remaining_pct) / 100
      : 0;
  const bootSpendUsd = preFirstAnchorSpendUsd + sumC;
  const cycleOriginRefPoolUsd =
    bootDeltaU >= minThreshold && bootSpendUsd > 0 ? bootSpendUsd / bootDeltaU : null;

  if (hasValidDifferential) {
    const activeEquiv = activeMeta.equivalentMixPoolUsd;
    const activeAnchor = activeMeta.anchorPoolUsd;
    const tailWeighted = activeMeta.tailWeightedUsd ?? spendSinceLastUsd;
    estimatedPoolUsd = activeEquiv;

    if (calibration.activeSubset === 'base' || activeMeta.seBeta == null || activeMeta.seBeta <= 0) {
      const segCountForErr = Math.max(1, calRaw.segmentsCount || 1);
      const err95 = 0.776 * Math.sqrt(segCountForErr * qEff * qEff);
      ciLowUsd = activeEquiv * (sumDeltaU / (sumDeltaU + err95));
      ciHighUsd = sumDeltaU - err95 > 0.0001 ? activeEquiv * (sumDeltaU / (sumDeltaU - err95)) : null;
    } else {
      const beta = 1 / activeAnchor;
      const margin = 1.96 * activeMeta.seBeta;
      const betaHigh = beta + margin;
      const betaLow = beta - margin;
      ciLowUsd = activeEquiv * (beta / betaHigh);
      ciHighUsd = betaLow > 1e-9 ? activeEquiv * (beta / betaLow) : null;
    }

    status = sumDeltaU >= highThreshold ? 'ok' : 'low_confidence';

    projectedRemainingPct = Math.max(
      0,
      Math.min(100, latestRow.remaining_pct - (tailWeighted / activeAnchor) * 100)
    );
    projectedRemainingPct = Math.round(projectedRemainingPct * 100) / 100;
    impliedRemainingUsd = activeEquiv * (projectedRemainingPct / 100);
  } else if (cycleOriginRefPoolUsd != null) {
    // Origin bootstrap fallback (single anchor OR multi-anchor before real Δu reaches minThreshold).
    // Cross-device spend before a0 creates one-sided downward bias, so ciHighUsd stays open (null).
    originBootstrap = true;
    estimatedPoolUsd = cycleOriginRefPoolUsd;
    const err95 = 0.776 * (latestRow.precision_step / 100);
    ciLowUsd = estimatedPoolUsd * (bootDeltaU / (bootDeltaU + err95));
    ciHighUsd = null;
    status = 'low_confidence';
    totalDeltaPct = Number((bootDeltaU * 100).toFixed(4));
    segmentsUsed = 1;
    projectedRemainingPct = Math.max(
      0,
      Math.min(100, latestRow.remaining_pct - (spendSinceLastUsd / estimatedPoolUsd) * 100)
    );
    projectedRemainingPct = Math.round(projectedRemainingPct * 100) / 100;
    impliedRemainingUsd = estimatedPoolUsd * (projectedRemainingPct / 100);
  } else if (
    sumDeltaU > 0 &&
    sumC > 0 &&
    activeMeta.equivalentMixPoolUsd != null &&
    activeMeta.anchorPoolUsd != null &&
    activeMeta.anchorPoolUsd > 0
  ) {
    // Below minThreshold calibrating preview (matches pre-v1.6 behavior when no cycleStart known).
    estimatedPoolUsd = activeMeta.equivalentMixPoolUsd;
    status = 'calibrating';
    const tailWeighted = activeMeta.tailWeightedUsd ?? spendSinceLastUsd;
    projectedRemainingPct = Math.max(
      0,
      Math.min(100, latestRow.remaining_pct - (tailWeighted / activeMeta.anchorPoolUsd) * 100)
    );
    projectedRemainingPct = Math.round(projectedRemainingPct * 100) / 100;
    impliedRemainingUsd = estimatedPoolUsd * (projectedRemainingPct / 100);
  }

  // Merge model mix: prefer differential segments, else combine pre-first-anchor + tail turns.
  const mixSourceMap = new Map();
  if (modelSpendMap.size > 0 && !originBootstrap) {
    for (const [k, v] of modelSpendMap) mixSourceMap.set(k, v);
  } else {
    for (const [k, v] of preModelMap) mixSourceMap.set(k, (mixSourceMap.get(k) || 0) + v);
    for (const [k, v] of modelSpendMap) mixSourceMap.set(k, (mixSourceMap.get(k) || 0) + v);
    for (const [k, v] of tailModelMap) mixSourceMap.set(k, (mixSourceMap.get(k) || 0) + v);
  }
  const totalMixUsd = [...mixSourceMap.values()].reduce((a, b) => a + b, 0);
  const modelMix = [...mixSourceMap.entries()]
    .map(([canonicalId, usd]) => ({
      canonicalId,
      share: totalMixUsd > 0 ? usd / totalMixUsd : 0,
    }))
    .sort((a, b) => b.share - a.share);

  // Flag mixed-model variance only when staying at uncalibrated base and segment rates diverge >35%.
  let mixedModelWarning = false;
  const hasMultipleModels = modelMix.filter((m) => m.share >= 0.1).length >= 2;
  if (!originBootstrap && calibration.activeSubset === 'base' && hasMultipleModels && estimatedPoolUsd != null) {
    const meaningfulSegRates = (activeMeta.segmentFits || [])
      .filter((s) => s.observedPp >= Math.max(0.2, precisionStepPct * 2) && s.spendUsd > 0)
      .map((s) => s.spendUsd / (s.observedPp / 100));
    if (meaningfulSegRates.length >= 2) {
      const minR = Math.min(...meaningfulSegRates);
      const maxR = Math.max(...meaningfulSegRates);
      if ((maxR - minR) / estimatedPoolUsd > 0.35) {
        mixedModelWarning = true;
      }
    }
  }

  let evenUsePaceRatio = null;
  if (cycleResetAt != null && cycleResetAt > nowMs && windowMs > 0 && cycleWindowStart != null) {
    const remainingMs = cycleResetAt - nowMs;
    if (remainingMs <= windowMs + HOUR_MS) {
      const elapsedFrac = Math.max(0.01, Math.min(1, (nowMs - cycleWindowStart) / windowMs));
      const currentRem = projectedRemainingPct !== null ? projectedRemainingPct : latestRow.remaining_pct;
      const usedFrac = Math.max(0, Math.min(1, (100 - currentRem) / 100));
      evenUsePaceRatio = usedFrac / elapsedFrac;
    }
  }

  const inheritableResetAt =
    cycleResetAt != null && (cycleResetHi ?? cycleResetAt) > nowMs ? cycleResetAt : null;

  // Build structured cycles array (current first, then historical newest first).
  const currentCycleEntry = {
    key: makeCycleKey(pool, windowType, cycleWindowStart, cycleResetAt, latestCycle),
    pool,
    windowType,
    startMs: cycleWindowStart ?? latestCycle[0].captured_at,
    startLo: cycleWindowStartLo,
    startHi: cycleWindowStartHi,
    endMs: cycleResetAt ?? latestRow.captured_at,
    resetLo: cycleResetLo,
    resetHi: cycleResetHi,
    prevCycleStartMs: prevCycleWindowStart,
    prevCycleEndMs: prevCycleWindowEnd,
    resetSource: currentDesc.resetSource,
    resetConflict: currentDesc.resetConflict,
    inferred: cycleInferred,
    multiWindowInferred,
    expired: false,
    isCurrent: true,
    anchorIds: [...latestCycle].reverse().map((a) => a.id),
    spendUsd: cycleSpendUsd,
    estimationBrief: {
      status,
      estimatedPoolUsd,
      totalDeltaPct,
      segmentsUsed,
      originBootstrap,
    },
  };

  const olderCycleEntries = olderDescs
    .map((d, idx) => {
      const nextBoundary = getNextCycleBoundaryMs(descriptors, idx);
      const brief = computeCycleBriefAndSpend(
        d,
        pool,
        pricingState,
        turnsFn,
        sumSpend,
        nowMs,
        nextBoundary
      );
      return {
        key: makeCycleKey(pool, windowType, d.startMs, d.endMs, d.anchors),
        pool,
        windowType,
        startMs: d.startMs ?? d.anchors[0].captured_at,
        startLo: d.startLo,
        startHi: d.startHi,
        endMs: d.endMs ?? d.anchors[d.anchors.length - 1].captured_at,
        resetLo: d.resetLo,
        resetHi: d.resetHi,
        prevCycleStartMs: d.startMs != null && windowMs > 0 ? d.startMs - windowMs : null,
        prevCycleEndMs: d.startMs,
        resetSource: d.resetSource,
        resetConflict: d.resetConflict,
        inferred: false,
        expired: true,
        isCurrent: false,
        anchorIds: [...d.anchors].reverse().map((a) => a.id),
        spendUsd: brief.spendUsd,
        estimationBrief: brief.estimationBrief,
      };
    })
    .reverse();

  const prevEstBrief = olderCycleEntries[0]?.estimationBrief || null;
  const previousCycleEstimation =
    prevEstBrief && prevEstBrief.estimatedPoolUsd != null
      ? {
          estimatedPoolUsd: prevEstBrief.estimatedPoolUsd,
          status: prevEstBrief.status,
          totalDeltaPct: prevEstBrief.totalDeltaPct,
          segmentsUsed: prevEstBrief.segmentsUsed,
          cycleWindowStart: prevEstBrief.cycleWindowStart,
          cycleResetAt: prevEstBrief.cycleResetAt,
          spendUsd: olderCycleEntries[0].spendUsd,
        }
      : null;

  return {
    pool,
    windowType,
    latestAnchor,
    inheritableResetAt: cycleInferred ? null : inheritableResetAt,
    cycleWindowStart,
    cycleWindowStartLo,
    cycleWindowStartHi,
    cycleResetAt,
    cycleResetLo,
    cycleResetHi,
    cycleResetEarliest,
    cycleResetLatest,
    multiWindowInferred,
    prevCycleWindowStart,
    prevCycleWindowEnd,
    resetSource: currentDesc.resetSource,
    resetConflict: currentDesc.resetConflict,
    cycleInferred,
    cycleExpired: false,
    cycleState: 'active',
    cycleSpendUsd,
    preFirstAnchorSpendUsd,
    spendSinceLastUsd,
    projectedRemainingPct,
    evenUsePaceRatio,
    cycleCount: descriptors.length,
    cycles: [currentCycleEntry, ...olderCycleEntries],
    currentCycleAnchors,
    olderCycleAnchors,
    previousCycleEstimation,
    estimation: {
      status,
      originBootstrap,
      cycleOriginRefPoolUsd: originBootstrap ? null : cycleOriginRefPoolUsd,
      totalDeltaPct,
      segmentsUsed,
      windowSpendUsd,
      cycleSpendUsd,
      estimatedPoolUsd,
      ciLowUsd,
      ciHighUsd,
      impliedRemainingUsd,
      precisionStepPct,
      modelMix,
      mixedModelWarning,
      calibration,
    },
  };
}

export function getQuotaStatus(
  cacheDb,
  pricingState,
  {
    pool = null,
    windowType = null,
    anchorModel = null,
    quotaAnchorsByPool = null,
    quotaCalibMode = 'auto',
    quotaManualFactors = null,
    forceSubset = null,
    forceLevel = null,
  } = {},
  nowMs = Date.now()
) {
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
  const formattedAnchorById = new Map();

  for (const p of pools) {
    const preferredAnchor =
      (filterPool === p && anchorModel) ||
      quotaAnchorsByPool?.[p] ||
      null;
    for (const w of windows) {
      const list = grouped.get(`${p}|${w}`) || [];
      const summary = computeSummaryForPair(cacheDb, pricingState, p, w, list, nowMs, {
        preferredAnchor,
        quotaCalibMode,
        quotaManualFactors,
        forceSubset,
        forceLevel,
      });
      summaries.push(summary);
      for (const a of summary.currentCycleAnchors || []) {
        if (a.id != null) formattedAnchorById.set(a.id, a);
      }
      for (const a of summary.olderCycleAnchors || []) {
        if (a.id != null && !formattedAnchorById.has(a.id)) formattedAnchorById.set(a.id, a);
      }
    }
  }

  const anchors = [...rows]
    .reverse()
    .map((r) => formattedAnchorById.get(r.id) || formatAnchor(r));

  return {
    anchors,
    summaries,
  };
}
