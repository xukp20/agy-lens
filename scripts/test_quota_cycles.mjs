/**
 * Unit tests for two-pass quota cycle segmentation, precision interval convergence,
 * expired-cycle chaining, origin bootstrap, validation, and three-pool 7d isolation.
 * Run: node --test scripts/test_quota_cycles.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  addQuotaAnchor,
  buildCycleDescriptors,
  computeSummaryForPair,
  deleteQuotaAnchor,
  getQuotaStatus,
  segmentCycles,
  updateQuotaAnchor,
  WINDOW_DURATION_MS,
} from '../sidecars/lens_panel/lib/quota.mjs';
import { loadPricingState } from '../sidecars/lens_panel/lib/pricing.mjs';
import { calibrateQuotaCycle, studentTCrit95 } from '../sidecars/lens_panel/lib/quota_calibrator.mjs';
import { openTelemetryCacheDb } from '../sidecars/lens_panel/lib/indexer.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOUR = 3600 * 1000;
const DAY = 86400 * 1000;
const MIN = 60 * 1000;
const W7D = WINDOW_DURATION_MS['7d'];
const W5H = WINDOW_DURATION_MS['5h'];

const pricingState = loadPricingState('/tmp/agy-lens-test-nonexistent-dir');

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE turns (
      conversation_id TEXT NOT NULL,
      step_idx INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'desktop',
      workspace TEXT NOT NULL DEFAULT '',
      completed_at_ms INTEGER NOT NULL,
      model_enum INTEGER,
      raw_model_id TEXT NOT NULL DEFAULT '',
      canonical_model_id TEXT NOT NULL DEFAULT 'gemini-4-neon',
      pool TEXT NOT NULL DEFAULT 'gemini',
      uncached_in INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_create INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      thinking_tokens INTEGER NOT NULL DEFAULT 0,
      total_out INTEGER NOT NULL DEFAULT 0,
      context_est INTEGER,
      compact_limit INTEGER,
      provider_request_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (conversation_id, step_idx)
    );
    CREATE TABLE quota_anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool TEXT NOT NULL,
      window_type TEXT NOT NULL,
      remaining_pct REAL NOT NULL,
      precision_step REAL NOT NULL,
      captured_at INTEGER NOT NULL,
      reset_at INTEGER,
      reset_source TEXT NOT NULL DEFAULT '',
      reset_precision_ms INTEGER,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function makeTurn(pool, completedAtMs, canonicalModelId = 'gemini-4-neon', uncachedIn = 1_000_000) {
  return {
    pool,
    completed_at_ms: completedAtMs,
    canonical_model_id: canonicalModelId,
    uncached_in: uncachedIn,
    cache_read: 0,
    cache_create: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    total_out: 0,
  };
}

function makeTurnsFn(allTurns) {
  return (pool, startExcl, endIncl) =>
    allTurns
      .filter((t) => t.pool === pool && t.completed_at_ms > startExcl && t.completed_at_ms <= endIncl)
      .sort((a, b) => a.completed_at_ms - b.completed_at_ms);
}

test('B1: addQuotaAnchor persists only explicit reset_at; update & delete dynamically recompute cycle', () => {
  const db = createTestDb();
  const base = Date.parse('2026-11-15T10:00:00Z');
  const reset1 = base + 5 * DAY;

  const id1 = addQuotaAnchor(
    db,
    { pool: 'gemini', windowType: '7d', remainingPct: 90, capturedAt: base, resetAt: reset1, resetPrecisionMs: MIN },
    base + 1000
  );
  const id2 = addQuotaAnchor(
    db,
    { pool: 'gemini', windowType: '7d', remainingPct: 80, capturedAt: base + DAY },
    base + DAY + 1000
  );

  const row1 = db.prepare('SELECT * FROM quota_anchors WHERE id = ?').get(id1);
  const row2 = db.prepare('SELECT * FROM quota_anchors WHERE id = ?').get(id2);
  assert.equal(row1.reset_at, reset1);
  assert.equal(row1.reset_source, 'explicit');
  assert.equal(row2.reset_at, null, 'inherited reset_at must NOT be persisted');
  assert.equal(row2.reset_source, '');

  const status1 = getQuotaStatus(db, pricingState, { pool: 'gemini', windowType: '7d' }, base + 2 * DAY);
  const s1 = status1.summaries[0];
  assert.equal(s1.cycleResetAt, reset1);
  assert.equal(s1.currentCycleAnchors.length, 2);
  const fmt2 = s1.currentCycleAnchors.find((a) => a.id === id2);
  assert.equal(fmt2.resetAt, null);
  assert.equal(fmt2.effectiveResetAt, reset1);
  assert.equal(fmt2.resetSource, 'inherited');

  // Updating id1 resetAt immediately updates cycle without cascade DB writes.
  const resetEdited = reset1 + 30 * MIN;
  updateQuotaAnchor(db, { id: id1, resetAt: resetEdited, resetPrecisionMs: MIN });
  const status2 = getQuotaStatus(db, pricingState, { pool: 'gemini', windowType: '7d' }, base + 2 * DAY);
  assert.equal(status2.summaries[0].cycleResetAt, resetEdited);

  // Deleting id1 leaves id2 cleanly without stale reset_at.
  deleteQuotaAnchor(db, id1);
  const status3 = getQuotaStatus(db, pricingState, { pool: 'gemini', windowType: '7d' }, base + 2 * DAY);
  assert.equal(status3.summaries[0].cycleResetAt, null);
  assert.equal(status3.summaries[0].currentCycleAnchors.length, 1);
});

test('B2 & I1: hour-level 7d countdown jitter (+45m) merges via interval intersection; >W/2 splits; conflict picks latest explicit', () => {
  const base = Date.parse('2026-11-15T10:00:00Z');
  const r1 = base + 6 * DAY + 23 * HOUR; // hour-granular
  const r2 = r1 + 45 * MIN; // 45m truncation jitter next day

  const anchorsJitter = [
    { id: 1, pool: 'gemini', window_type: '7d', remaining_pct: 95, precision_step: 0.01, captured_at: base, reset_at: r1, reset_source: 'explicit', reset_precision_ms: HOUR, created_at: base },
    { id: 2, pool: 'gemini', window_type: '7d', remaining_pct: 80, precision_step: 0.01, captured_at: base + DAY, reset_at: r2, reset_source: 'explicit', reset_precision_ms: HOUR, created_at: base + DAY },
  ];
  const descs = buildCycleDescriptors(anchorsJitter, '7d');
  assert.equal(descs.length, 1, '45m hour-level jitter must NOT split 7d cycle');
  assert.equal(descs[0].resetConflict, false);
  // Interval intersection: [r1-30m, r1+60m] ∩ [r1+15m, r1+105m] = [r1+15m, r1+60m]
  assert.equal(descs[0].resetLo, r1 + 15 * MIN);
  assert.equal(descs[0].resetHi, r1 + 60 * MIN);

  // Disjoint correction within W/2 (+3h) inside the same cycle -> 1 cycle, conflict=true, latest created_at wins.
  const midStart = Date.parse('2026-11-15T10:00:00Z');
  const rMid1 = midStart + W7D;
  const rConflict = rMid1 + 3 * HOUR;
  const anchorsConflict = [
    { id: 10, pool: 'gemini', window_type: '7d', remaining_pct: 90, precision_step: 0.01, captured_at: midStart + DAY, reset_at: rMid1, reset_source: 'explicit', reset_precision_ms: HOUR, created_at: midStart + DAY },
    { id: 11, pool: 'gemini', window_type: '7d', remaining_pct: 80, precision_step: 0.01, captured_at: midStart + 2 * DAY, reset_at: rConflict, reset_source: 'explicit', reset_precision_ms: MIN, created_at: midStart + 2 * DAY + 5000 },
  ];
  const descsC = buildCycleDescriptors(anchorsConflict, '7d');
  assert.equal(descsC.length, 1);
  assert.equal(descsC[0].resetConflict, true);
  assert.equal(descsC[0].endMs, rConflict);

  // Shift > W/2 -> new cycle.
  const anchorsNext = [
    anchorsJitter[0],
    { id: 4, pool: 'gemini', window_type: '7d', remaining_pct: 90, precision_step: 0.01, captured_at: base + 7 * DAY + 2 * HOUR, reset_at: r1 + W7D, reset_source: 'explicit', reset_precision_ms: HOUR, created_at: base + 7 * DAY + 2 * HOUR },
  ];
  assert.equal(segmentCycles(anchorsNext, '7d').length, 2);
});

test('B3: ambiguity band [startLo, startHi) defaults trailing old-cycle anchor to old cycle, preventing fake ΔU', () => {
  const cycleStart = Date.parse('2026-11-15T10:00:00Z');
  const cycleReset = cycleStart + W7D; // hour-granular -> startLo = 09:30, startHi = 11:00

  const anchors = [
    // Old cycle earlier anchor
    { id: 1, pool: 'gemini', window_type: '7d', remaining_pct: 60, precision_step: 0.01, captured_at: cycleStart - DAY, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 1 },
    // Old cycle trailing anchor inside [startLo=09:30, startHi=11:00) at 09:50 with 50%
    { id: 2, pool: 'gemini', window_type: '7d', remaining_pct: 50, precision_step: 0.01, captured_at: cycleStart - 10 * MIN, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 2 },
    // New cycle first explicit anchor at 10:30 with 40% (real ΔU from 100% is 60pp, NOT 50->40=10pp!)
    { id: 3, pool: 'gemini', window_type: '7d', remaining_pct: 40, precision_step: 0.01, captured_at: cycleStart + 30 * MIN, reset_at: cycleReset, reset_source: 'explicit', reset_precision_ms: HOUR, created_at: 3 },
    // Follow-up non-explicit anchor inside ambiguity band at 10:45 with 35% (MUST stay in new cycle!)
    { id: 4, pool: 'gemini', window_type: '7d', remaining_pct: 35, precision_step: 0.01, captured_at: cycleStart + 45 * MIN, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 4 },
  ];

  const cycles = segmentCycles(anchors, '7d');
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[0].map((a) => a.id), [1, 2], 'trailing 50% anchor stays in old cycle');
  assert.deepEqual(cycles[1].map((a) => a.id), [3, 4], 'new cycle contains only post-reset anchors');

  // Verify genuine post-reset 99.5% anchor inside [startLo, startHi) DOES join new cycle.
  const anchorsPostReset = [
    anchors[0],
    { id: 5, pool: 'gemini', window_type: '7d', remaining_pct: 99.5, precision_step: 0.01, captured_at: cycleStart + 5 * MIN, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 5 },
    { id: 6, pool: 'gemini', window_type: '7d', remaining_pct: 80, precision_step: 0.01, captured_at: cycleStart + 2 * DAY, reset_at: cycleReset, reset_source: 'explicit', reset_precision_ms: HOUR, created_at: 6 },
  ];
  const cycles2 = segmentCycles(anchorsPostReset, '7d');
  assert.equal(cycles2.length, 2);
  assert.deepEqual(cycles2[1].map((a) => a.id), [5, 6]);
});

test('B4: two-pass splits beforeStart spanning 2+ cycles and handles out-of-order retroactive inserts', () => {
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const c3Start = t0 + 16 * DAY;
  const c3Reset = c3Start + W7D;

  // Deliberately unsorted / retroactive order spanning 3 distinct 7d cycles
  const anchors = [
    { id: 1, pool: 'argon', window_type: '7d', remaining_pct: 70, precision_step: 0.01, captured_at: t0, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 1 },
    { id: 3, pool: 'argon', window_type: '7d', remaining_pct: 85, precision_step: 0.01, captured_at: c3Start + DAY, reset_at: c3Reset, reset_source: 'explicit', reset_precision_ms: MIN, created_at: 3 },
    // Retroactive insert from cycle 2 (10 days after t0, 6 days before c3Start)
    { id: 2, pool: 'argon', window_type: '7d', remaining_pct: 60, precision_step: 0.01, captured_at: t0 + 10 * DAY, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 4 },
  ];

  const cycles = segmentCycles(anchors, '7d');
  assert.equal(cycles.length, 3, 'two-pass + max-span fallback splits into 3 cycles');
  assert.deepEqual(cycles.map((c) => c.map((a) => a.id)), [[1], [2], [3]]);
});

test('B5: expired cycle archives old anchors, chains first-turn-triggered inference, and preserves prev cycle ref', () => {
  const c1Start = Date.parse('2026-11-01T10:00:00Z');
  const c1Reset = c1Start + W7D;
  const anchors = [
    { id: 1, pool: 'gemini', window_type: '7d', remaining_pct: 90, precision_step: 0.01, captured_at: c1Start + DAY, reset_at: c1Reset, reset_source: 'explicit', reset_precision_ms: MIN, created_at: 1 },
    { id: 2, pool: 'gemini', window_type: '7d', remaining_pct: 80, precision_step: 0.01, captured_at: c1Start + 2 * DAY, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 2 },
  ];

  const c1Turn = makeTurn('gemini', c1Start + 1.5 * DAY, 'gemini-4-neon', 2_000_000);

  // Case 1: expired, NO turns after reset -> awaiting_activity
  const nowIdle = c1Reset + 2 * HOUR;
  const sumIdle = computeSummaryForPair(null, pricingState, 'gemini', '7d', anchors, nowIdle, {
    turnsFn: makeTurnsFn([c1Turn]),
  });
  assert.equal(sumIdle.cycleExpired, true);
  assert.equal(sumIdle.cycleState, 'awaiting_activity');
  assert.equal(sumIdle.currentCycleAnchors.length, 0);
  assert.equal(sumIdle.olderCycleAnchors.length, 2);
  assert.equal(sumIdle.cycleSpendUsd, 0);
  assert.ok(sumIdle.previousCycleEstimation?.estimatedPoolUsd > 0, 'preserves previous cycle reference');

  // Case 2: expired across TWO windows -> chained first-turn inference lands in window #3
  const tWin2 = c1Reset + DAY; // triggers window #2: [tWin2, tWin2 + 7d]
  const tWin3 = tWin2 + W7D + 3 * HOUR; // triggers window #3: [tWin3, tWin3 + 7d]
  const nowActive = tWin3 + 2 * HOUR;
  const turns = [
    c1Turn,
    makeTurn('gemini', tWin2, 'gemini-4-neon', 1_000_000),
    makeTurn('gemini', tWin3, 'gemini-4-neon', 3_000_000),
  ];
  const sumChained = computeSummaryForPair(null, pricingState, 'gemini', '7d', anchors, nowActive, {
    turnsFn: makeTurnsFn(turns),
  });
  assert.equal(sumChained.cycleExpired, true);
  assert.equal(sumChained.cycleState, 'expired_inferred');
  assert.equal(sumChained.cycleInferred, true);
  assert.equal(sumChained.cycleWindowStart, tWin3);
  assert.equal(sumChained.cycleResetAt, tWin3 + W7D);
  assert.ok(sumChained.cycleSpendUsd > 0, 'only counts spend in the newest inferred window');
  assert.equal(sumChained.cycles.length, 2);
  assert.equal(sumChained.cycles[0].isCurrent, true);
  assert.equal(sumChained.cycles[0].inferred, true);
});

test('I3 & I4: single-anchor 100% bootstrap has open ciHigh, holds through low-ΔU 2nd anchor, switches cleanly at 3rd', () => {
  const start = Date.parse('2026-11-15T10:00:00Z');
  const reset = start + W7D;
  const a1Time = start + DAY;
  const a2Time = a1Time + 10 * MIN;
  const a3Time = start + 2 * DAY;

  const spendFn = (_pool, s, e) => {
    // $20 spent in [start+1m, a1], $0.10 in [a1, a2], $10 in [a2, a3]
    let total = 0;
    if (s < a1Time && e >= a1Time) total += 20;
    if (s < a2Time && e >= a2Time) total += 0.1;
    if (s < a3Time && e >= a3Time) total += 10;
    return total;
  };

  // Step 1: single anchor at 80% -> bootstrap $20 / 0.20 = $100, ciHighUsd = null
  const a1 = { id: 1, pool: '3p', window_type: '7d', remaining_pct: 80, precision_step: 0.01, captured_at: a1Time, reset_at: reset, reset_source: 'explicit', reset_precision_ms: MIN, created_at: 1 };
  const s1 = computeSummaryForPair(null, pricingState, '3p', '7d', [a1], a1Time + MIN, { spendFn });
  assert.equal(s1.estimation.originBootstrap, true);
  assert.equal(s1.estimation.status, 'low_confidence');
  assert.ok(Math.abs(s1.estimation.estimatedPoolUsd - 100) < 0.01);
  assert.ok(s1.estimation.ciLowUsd > 0);
  assert.equal(s1.estimation.ciHighUsd, null, 'bootstrap upper CI must remain open');

  // Step 2: 2nd anchor with tiny ΔU = 0.05% (< 0.20% minThreshold) -> stays on bootstrap (doesn't vanish!)
  const a2 = { id: 2, pool: '3p', window_type: '7d', remaining_pct: 79.95, precision_step: 0.01, captured_at: a2Time, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 2 };
  const s2 = computeSummaryForPair(null, pricingState, '3p', '7d', [a1, a2], a2Time + MIN, { spendFn });
  assert.equal(s2.estimation.originBootstrap, true, 'must keep origin bootstrap when real ΔU < minThreshold');
  assert.ok(s2.estimation.estimatedPoolUsd > 95);

  // Step 3: 3rd anchor at 70% -> real ΔU = 10% >= 1% -> switches to pure differential ($10.10 / 0.10 = $101)
  const a3 = { id: 3, pool: '3p', window_type: '7d', remaining_pct: 70, precision_step: 0.01, captured_at: a3Time, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 3 };
  const s3 = computeSummaryForPair(null, pricingState, '3p', '7d', [a1, a2, a3], a3Time + MIN, { spendFn });
  assert.equal(s3.estimation.originBootstrap, false);
  assert.equal(s3.estimation.status, 'ok');
  assert.ok(Math.abs(s3.estimation.estimatedPoolUsd - 101) < 0.01);
  assert.ok(s3.estimation.ciHighUsd != null);
  assert.ok(s3.estimation.cycleOriginRefPoolUsd != null, 'exposes full-cycle reference alongside differential');
});

test('I2: validation rejects 7d countdown entered into 5h window and future capturedAt', () => {
  const db = createTestDb();
  const now = Date.parse('2026-11-21T12:00:00Z');

  assert.throws(
    () =>
      addQuotaAnchor(
        db,
        { pool: 'gemini', windowType: '5h', remainingPct: 90, capturedAt: now, resetAt: now + 6 * DAY },
        now
      ),
    /exceeds 5h window/i
  );

  assert.throws(
    () =>
      addQuotaAnchor(
        db,
        { pool: 'gemini', windowType: '7d', remainingPct: 90, capturedAt: now + 5 * MIN },
        now
      ),
    /future/i
  );
});

test('Three pools (gemini, argon, 3p) maintain completely independent 7d reset cycles', () => {
  const db = createTestDb();
  const now = Date.parse('2026-11-21T12:00:00Z');

  const gReset = now + 2 * DAY; // Gemini cycle: Nov 16 -> Nov 23
  const aReset = now + 4 * DAY; // Argon cycle:  Nov 18 -> Nov 25
  const pReset = now + 6 * DAY; // 3P cycle:     Nov 20 -> Nov 27

  // Insert an old anchor and a current anchor for each pool
  addQuotaAnchor(db, { pool: 'gemini', windowType: '7d', remainingPct: 40, capturedAt: gReset - W7D - DAY }, now);
  addQuotaAnchor(db, { pool: 'gemini', windowType: '7d', remainingPct: 85, capturedAt: now - HOUR, resetAt: gReset, resetPrecisionMs: MIN }, now);

  addQuotaAnchor(db, { pool: 'argon', windowType: '7d', remainingPct: 50, capturedAt: aReset - W7D - DAY }, now);
  addQuotaAnchor(db, { pool: 'argon', windowType: '7d', remainingPct: 75, capturedAt: now - HOUR, resetAt: aReset, resetPrecisionMs: MIN }, now);

  addQuotaAnchor(db, { pool: '3p', windowType: '7d', remainingPct: 30, capturedAt: pReset - W7D - DAY }, now);
  addQuotaAnchor(db, { pool: '3p', windowType: '7d', remainingPct: 95, capturedAt: now - HOUR, resetAt: pReset, resetPrecisionMs: MIN }, now);

  const status = getQuotaStatus(db, pricingState, {}, now);
  const g7 = status.summaries.find((s) => s.pool === 'gemini' && s.windowType === '7d');
  const a7 = status.summaries.find((s) => s.pool === 'argon' && s.windowType === '7d');
  const p7 = status.summaries.find((s) => s.pool === '3p' && s.windowType === '7d');

  assert.equal(g7.cycleResetAt, gReset);
  assert.equal(g7.cycleWindowStart, gReset - W7D);
  assert.equal(g7.currentCycleAnchors.length, 1);
  assert.equal(g7.olderCycleAnchors.length, 1);

  assert.equal(a7.cycleResetAt, aReset);
  assert.equal(a7.cycleWindowStart, aReset - W7D);
  assert.equal(a7.currentCycleAnchors.length, 1);
  assert.equal(a7.olderCycleAnchors.length, 1);

  assert.equal(p7.cycleResetAt, pReset);
  assert.equal(p7.cycleWindowStart, pReset - W7D);
  assert.equal(p7.currentCycleAnchors.length, 1);
  assert.equal(p7.olderCycleAnchors.length, 1);
});

test('I5: frontend parseResetInput anchors to capturedAt, handles Chinese durations, MM-DD year rollover, and rejects 7d in 5h', () => {
  const appJs = readFileSync(join(__dirname, '..', 'sidecars', 'lens_panel', 'web', 'app.js'), 'utf-8');
  const fnStart = appJs.indexOf('function parseResetInput(');
  assert.ok(fnStart > 0, 'parseResetInput found in app.js');
  // Extract parseResetInput body up to next section banner
  const fnEnd = appJs.indexOf('// =========================================================================', fnStart);
  const fnSrc = appJs.slice(fnStart, fnEnd);

  const sandbox = {
    num: (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d),
    fmtTimeShort: (ts) => new Date(ts).toISOString().slice(5, 16),
    t: (key, vars = {}) => `${key}:${JSON.stringify(vars)}`,
    Date,
    Math,
    Number,
    String,
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);

  // 1. Relative duration anchored to capturedAt (not Date.now())
  const baseCap = new Date(2026, 11, 29, 10, 0, 0).getTime(); // Dec 29, 2026 10:00 local
  const rDur = sandbox.parseResetInput('5天3小时', baseCap, '7d');
  assert.equal(rDur.ok, true);
  assert.equal(rDur.ts, baseCap + 5 * DAY + 3 * HOUR);
  assert.equal(rDur.precisionMs, HOUR);

  // 2. MM-DD HH:MM across year rollover (Dec 29, 2026 -> Jan 03, 2027)
  const rRoll = sandbox.parseResetInput('01-03 10:30', baseCap, '7d');
  assert.equal(rRoll.ok, true);
  const rollDate = new Date(rRoll.ts);
  assert.equal(rollDate.getFullYear(), 2027);
  assert.equal(rollDate.getMonth(), 0);
  assert.equal(rollDate.getDate(), 3);
  assert.equal(rollDate.getHours(), 10);
  assert.equal(rollDate.getMinutes(), 30);

  // 3. 7d countdown entered into 5h window -> rejected!
  const rBad5h = sandbox.parseResetInput('6d 23h', baseCap, '5h');
  assert.equal(rBad5h.ok, false);
  assert.match(rBad5h.preview, /resetOutOfWindow/);

  // 4. HH:MM anchored to baseCap (same day AND true midnight cross-day)
  const rHm = sandbox.parseResetInput('13:30', baseCap, '5h');
  assert.equal(rHm.ok, true);
  assert.equal(rHm.ts, new Date(2026, 11, 29, 13, 30, 0).getTime());
  assert.equal(rHm.precisionMs, MIN);

  const lateCap = new Date(2026, 11, 29, 23, 30, 0).getTime();
  const rCrossDay = sandbox.parseResetInput('01:30', lateCap, '5h');
  assert.equal(rCrossDay.ok, true);
  const crossDate = new Date(rCrossDay.ts);
  assert.equal(crossDate.getDate(), 30, 'HH:MM earlier than baseCap must roll to next day');
  assert.equal(crossDate.getHours(), 1);
  assert.equal(crossDate.getMinutes(), 30);

  // 5. Day-only "5d" -> DAY precision; relative "3h20m" -> 5m jitter band; bare "12" -> resetBad (not resetOutOfWindow)
  const rDay = sandbox.parseResetInput('5d', baseCap, '7d');
  assert.equal(rDay.ok, true);
  assert.equal(rDay.precisionMs, DAY);
  assert.ok(rDay.resetLo < rDay.ts && rDay.resetHi > rDay.ts);

  const rRelMin = sandbox.parseResetInput('3h20m', baseCap, '5h');
  assert.equal(rRelMin.ok, true);
  assert.equal(rRelMin.precisionMs, 5 * MIN);

  const rBareNum = sandbox.parseResetInput('12', baseCap, '7d');
  assert.equal(rBareNum.ok, false);
  assert.match(rBareNum.preview, /resetBad/);
});

test('B1 (R2): logging new snapshot after expiry WITHOUT resetAt preserves inferred start, pre-anchor spend, and bootstrap', () => {
  const c1Start = Date.parse('2026-11-01T10:00:00Z');
  const c1Reset = c1Start + W7D;
  const firstNewTurn = c1Reset + 2 * HOUR;
  const newAnchorTime = c1Reset + 2 * DAY;
  const tailTurnTime = newAnchorTime + HOUR;
  const now = tailTurnTime + 10 * MIN;

  const anchors = [
    { id: 1, pool: 'gemini', window_type: '7d', remaining_pct: 80, precision_step: 0.01, captured_at: c1Start + DAY, reset_at: c1Reset, reset_source: 'explicit', reset_precision_ms: MIN, created_at: 1 },
    // User records new snapshot in new cycle, leaving resetAt blank
    { id: 2, pool: 'gemini', window_type: '7d', remaining_pct: 70, precision_step: 0.01, captured_at: newAnchorTime, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 2 },
  ];
  const turns = [
    makeTurn('gemini', firstNewTurn, 'gemini-4-neon', 10_000_000), // must be included in preFirstAnchorSpendUsd!
    makeTurn('gemini', tailTurnTime, 'gemini-4-neon', 2_000_000),
  ];

  const sum = computeSummaryForPair(null, pricingState, 'gemini', '7d', anchors, now, {
    turnsFn: makeTurnsFn(turns),
  });
  assert.equal(sum.cycleExpired, false);
  assert.equal(sum.cycleInferred, true);
  assert.equal(sum.cycleWindowStart, firstNewTurn);
  assert.ok(sum.preFirstAnchorSpendUsd > 0, 'triggering first turn must be included in preFirstAnchorSpendUsd');
  assert.ok(sum.cycleSpendUsd > sum.spendSinceLastUsd, 'cycleSpendUsd preserves pre-anchor spend');
  assert.equal(sum.estimation.originBootstrap, true, 'origin bootstrap works seamlessly after expiry');
  assert.equal(sum.inheritableResetAt, null, 'inferred resetAt must not masquerade as inheritable explicit reset');
});

test('I1 & M1 (R1/R3/R7): historical gap/rebound cycles never double-count spend to now and produce unique keys', () => {
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const c2Start = t0 + 10 * DAY;
  const c2Reset = c2Start + W7D;
  const now = c2Start + 3 * DAY;

  // Older gap anchor at t0, then an explicit cycle with an internal early-rebound subgroup
  const anchors = [
    { id: 1, pool: 'gemini', window_type: '7d', remaining_pct: 70, precision_step: 0.01, captured_at: t0, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 1 },
    { id: 2, pool: 'gemini', window_type: '7d', remaining_pct: 50, precision_step: 0.01, captured_at: c2Start + DAY, reset_at: c2Reset, reset_source: 'explicit', reset_precision_ms: MIN, created_at: 2 },
    { id: 3, pool: 'gemini', window_type: '7d', remaining_pct: 95, precision_step: 0.01, captured_at: c2Start + 2 * DAY, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 3 },
  ];
  const turns = [
    makeTurn('gemini', t0 + HOUR, 'gemini-4-neon', 1_000_000),
    makeTurn('gemini', c2Start + 2.5 * DAY, 'gemini-4-neon', 20_000_000), // belongs ONLY to current cycle
  ];

  const sum = computeSummaryForPair(null, pricingState, 'gemini', '7d', anchors, now, {
    turnsFn: makeTurnsFn(turns),
  });
  const keys = sum.cycles.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, 'every cycle must have a unique key (M1)');
  const olderCycles = sum.cycles.filter((c) => !c.isCurrent);
  for (const oc of olderCycles) {
    assert.ok(oc.spendUsd < sum.cycleSpendUsd, 'historical cycles must NOT include current-cycle spend (I1)');
  }
});

test('I2 & I3 (R4/R5): coarse DAY reading never overwrites MIN reading; relative 3m jitter does not conflict', () => {
  const start = Date.parse('2026-11-15T10:00:00Z');
  const exactReset = start + W7D; // Nov 22 10:00
  // R4: User entered exact MIN reset, then later typed coarse "5d" (14h early) -> MIN must win!
  const anchorsR4 = [
    { id: 1, pool: 'gemini', window_type: '7d', remaining_pct: 90, precision_step: 0.01, captured_at: start + DAY, reset_at: exactReset, reset_source: 'explicit', reset_precision_ms: MIN, created_at: 100 },
    { id: 2, pool: 'gemini', window_type: '7d', remaining_pct: 70, precision_step: 0.01, captured_at: start + 2 * DAY, reset_at: start + 2 * DAY + 5 * DAY - 20 * HOUR, reset_source: 'explicit', reset_precision_ms: DAY, created_at: 200 },
  ];
  const descsR4 = buildCycleDescriptors(anchorsR4, '7d');
  assert.equal(descsR4.length, 1);
  assert.equal(descsR4[0].endMs, exactReset, 'coarser DAY reading must NOT overwrite finer MIN reading');

  // R5: Two relative minute-level countdowns (5m jitter band) differing by 3m -> no conflict!
  const anchorsR5 = [
    { id: 3, pool: 'gemini', window_type: '5h', remaining_pct: 90, precision_step: 0.01, captured_at: start, reset_at: start + W5H, reset_source: 'explicit', reset_precision_ms: 5 * MIN, created_at: 100 },
    { id: 4, pool: 'gemini', window_type: '5h', remaining_pct: 80, precision_step: 0.01, captured_at: start + HOUR, reset_at: start + W5H + 3 * MIN, reset_source: 'explicit', reset_precision_ms: 5 * MIN, created_at: 200 },
  ];
  const descsR5 = buildCycleDescriptors(anchorsR5, '5h');
  assert.equal(descsR5.length, 1);
  assert.equal(descsR5[0].resetConflict, false, '3m drift in relative minute countdown must not trigger conflict');
});

test('Coverage: real SQLite turns, spendFn override with cacheDb, updateQuotaAnchor validation, explicit->legacy fallback, end-band rebound', () => {
  const db = createTestDb();
  const start = Date.parse('2026-11-15T10:00:00Z');
  const reset = start + W7D;
  const now = start + 3 * DAY;

  // Insert real turns into SQLite turns table
  db.prepare(
    `INSERT INTO turns (conversation_id, step_idx, completed_at_ms, canonical_model_id, pool, uncached_in)
     VALUES ('c1', 1, ?, 'gemini-4-neon', 'gemini', 2000000),
            ('c1', 2, ?, 'gemini-4-neon', 'gemini', 4000000)`
  ).run(start + 12 * HOUR, start + 2 * DAY);

  // Legacy anchor + explicit anchor in same cycle
  db.prepare(
    `INSERT INTO quota_anchors (pool, window_type, remaining_pct, precision_step, captured_at, reset_at, reset_source, reset_precision_ms, created_at)
     VALUES ('gemini', '7d', 90, 0.01, ?, ?, 'legacy', NULL, 100)`
  ).run(start + DAY, reset + 10 * MIN);
  const expId = addQuotaAnchor(
    db,
    { pool: 'gemini', windowType: '7d', remainingPct: 75, capturedAt: start + 2.5 * DAY, resetAt: reset, resetPrecisionMs: MIN },
    now
  );

  // Real DB turns path works end-to-end
  const st1 = getQuotaStatus(db, pricingState, { pool: 'gemini', windowType: '7d' }, now);
  const g7 = st1.summaries[0];
  assert.equal(g7.cycleResetAt, reset);
  assert.ok(g7.cycleSpendUsd > 0, 'real SQLite turns queried cleanly');
  assert.ok(g7.estimation.estimatedPoolUsd > 0);

  // updateQuotaAnchor rejects null payload and out-of-window resetAt
  assert.throws(() => updateQuotaAnchor(db, null), /Invalid update payload/);
  assert.throws(
    () => updateQuotaAnchor(db, { id: expId, resetAt: start + 2.5 * DAY + 10 * DAY }),
    /exceeds 7d window/i
  );

  // Deleting explicit anchor falls back cleanly to legacy anchor's reset_at
  deleteQuotaAnchor(db, expId);
  const st2 = getQuotaStatus(db, pricingState, { pool: 'gemini', windowType: '7d' }, now);
  assert.equal(st2.summaries[0].cycleResetAt, reset + 10 * MIN);

  // M7: spendFn is honored even when cacheDb is non-null
  const rows = db.prepare('SELECT * FROM quota_anchors').all();
  const sOverride = computeSummaryForPair(db, pricingState, 'gemini', '7d', rows, now, {
    spendFn: () => 123.45,
  });
  assert.ok(Math.abs(sOverride.spendSinceLastUsd - 123.45) < 0.001, 'injected spendFn must override cacheDb');

  // End ambiguity band (resetLo, resetHi] rebound splits into a new cycle
  const endReboundAnchors = [
    { id: 1, pool: 'gemini', window_type: '7d', remaining_pct: 20, precision_step: 0.01, captured_at: start + DAY, reset_at: reset, reset_source: 'explicit', reset_precision_ms: HOUR, created_at: 1 },
    { id: 2, pool: 'gemini', window_type: '7d', remaining_pct: 98, precision_step: 0.01, captured_at: reset + 20 * MIN, reset_at: null, reset_source: '', reset_precision_ms: null, created_at: 2 },
  ];
  assert.equal(segmentCycles(endReboundAnchors, '7d').length, 2, 'rebound in (resetLo, resetHi] must start new cycle');
});

test('I6: legacy DB migration adds reset_source/reset_precision_ms, deduplicates inherited copies, preserves all rows', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agy-lens-mig-'));
  try {
    const dbPath = join(tmpDir, 'telemetry_cache.db');
    const preDb = new DatabaseSync(dbPath);
    preDb.exec(`
      CREATE TABLE indexed_files (
        conversation_id TEXT NOT NULL,
        source TEXT NOT NULL,
        db_path TEXT NOT NULL,
        db_mtime_ms REAL NOT NULL DEFAULT 0,
        db_size INTEGER NOT NULL DEFAULT 0,
        wal_mtime_ms REAL NOT NULL DEFAULT 0,
        wal_size INTEGER NOT NULL DEFAULT 0,
        max_step15_idx INTEGER NOT NULL DEFAULT -1,
        max_gen_idx INTEGER NOT NULL DEFAULT -1,
        workspace TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (conversation_id, source)
      );
      CREATE TABLE turns (
        conversation_id TEXT NOT NULL,
        step_idx INTEGER NOT NULL,
        source TEXT NOT NULL,
        workspace TEXT NOT NULL DEFAULT '',
        completed_at_ms INTEGER NOT NULL,
        model_enum INTEGER,
        raw_model_id TEXT NOT NULL DEFAULT '',
        canonical_model_id TEXT NOT NULL DEFAULT '',
        pool TEXT NOT NULL DEFAULT 'gemini',
        uncached_in INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_create INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        thinking_tokens INTEGER NOT NULL DEFAULT 0,
        total_out INTEGER NOT NULL DEFAULT 0,
        context_est INTEGER,
        compact_limit INTEGER,
        PRIMARY KEY (conversation_id, step_idx)
      );
      CREATE TABLE quota_anchors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool TEXT NOT NULL,
        window_type TEXT NOT NULL,
        remaining_pct REAL NOT NULL,
        precision_step REAL NOT NULL,
        captured_at INTEGER NOT NULL,
        reset_at INTEGER,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
    `);
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    const r0 = t0 + W7D;
    preDb
      .prepare(
        'INSERT INTO quota_anchors (pool, window_type, remaining_pct, precision_step, captured_at, reset_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run('gemini', '7d', 90, 0.01, t0 + DAY, r0, 'first', t0 + DAY);
    preDb
      .prepare(
        'INSERT INTO quota_anchors (pool, window_type, remaining_pct, precision_step, captured_at, reset_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run('gemini', '7d', 80, 0.01, t0 + 2 * DAY, r0, 'inherited-copy', t0 + 2 * DAY);
    preDb.close();

    const { db } = openTelemetryCacheDb(tmpDir);
    const rows = db.prepare('SELECT * FROM quota_anchors ORDER BY id ASC').all();
    assert.equal(rows.length, 2, 'migration must preserve all rows');
    assert.equal(rows[0].reset_at, r0);
    assert.equal(rows[0].reset_source, 'legacy');
    assert.equal(rows[0].reset_precision_ms, null);
    assert.equal(rows[1].reset_at, null, 'duplicate inherited reset_at cleared');
    assert.equal(rows[1].reset_source, '');
    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('v1.8.0: unified Delta Method CI aligns base & C, covariance cancels collinearity, and log-scale CI stays positive', () => {
  // Synthetic pricing state: $10/1M input, $10/1M output, $1/1M cacheRead (exact easy USD math)
  const mkModel = () => ({
    pool: 'gemini',
    rates: [
      {
        effective_from: '2026-01-01',
        input_per_1m: 10,
        output_per_1m: 10,
        thinking_per_1m: 10,
        cache_read_per_1m: 1,
        cache_write_per_1m: 10,
        discount_multiplier: 1.0,
      },
    ],
  });
  const syntheticPricing = {
    defaults: {
      defaultAnchors: { gemini: 'gemini-test-a' },
      models: {
        'gemini-test-a': mkModel(),
        'gemini-test-b': mkModel(),
      },
    },
    remote: { models: {} },
    overrides: {},
  };

  // True quota pool: anchor non-cache Q = $100, true alpha_cache = 0.08 (cache reads drain 8% of API cache price)
  // 4 contiguous segments with varied cacheRead share (20%, 50%, 30%, 55%) and slight realistic noise
  const t0 = Date.parse('2026-11-10T00:00:00Z');
  const mkTurn = (ts, model, inUsd, crUsd) => ({
    completed_at_ms: ts,
    canonical_model_id: model,
    raw_model_id: model,
    pool: 'gemini',
    uncached_in: Math.round((inUsd / 10) * 1e6),
    cache_read: Math.round((crUsd / 1) * 1e6),
    cache_create: 0,
    total_out: 0,
    thinking_out: 0,
    visible_out: 0,
  });

  const segDefs = [
    { nc: 1.6, cr: 0.4, noise: 0.0005 },
    { nc: 2.0, cr: 3.5, noise: -0.0004 },
    { nc: 7.5, cr: 1.5, noise: 0.0003 },
    { nc: 10.0, cr: 14.0, noise: -0.0002 },
  ];

  let rem = 100.0;
  const anchors = [
    {
      id: 1,
      pool: 'gemini',
      window_type: '7d',
      remaining_pct: rem,
      precision_step: 0.01,
      captured_at: t0,
      reset_at: t0 + W7D,
      reset_source: 'explicit',
      reset_precision_ms: HOUR,
      created_at: t0,
    },
  ];
  const allTurns = [];
  for (let i = 0; i < segDefs.length; i++) {
    const s = segDefs[i];
    const segStart = t0 + i * 2 * HOUR;
    const segEnd = t0 + (i + 1) * 2 * HOUR;
    const trueDelta = (s.nc + 0.08 * s.cr) / 100 + s.noise;
    rem = Number((rem - trueDelta * 100).toFixed(2));
    allTurns.push(mkTurn(segStart + HOUR, 'gemini-test-a', s.nc, s.cr));
    anchors.push({
      id: i + 2,
      pool: 'gemini',
      window_type: '7d',
      remaining_pct: rem,
      precision_step: 0.01,
      captured_at: segEnd,
      reset_at: null,
      reset_source: '',
      reset_precision_ms: null,
      created_at: segEnd,
    });
  }

  const db = createTestDb();
  const insTurn = db.prepare(`
    INSERT INTO turns (conversation_id, step_idx, source, completed_at_ms, raw_model_id, canonical_model_id, pool, uncached_in, cache_read, cache_create, total_out)
    VALUES ('conv1', ?, 'cli', ?, ?, ?, 'gemini', ?, ?, 0, 0)
  `);
  allTurns.forEach((tr, idx) =>
    insTurn.run(idx + 1, tr.completed_at_ms, tr.raw_model_id, tr.canonical_model_id, tr.uncached_in, tr.cache_read)
  );

  const sumAuto = computeSummaryForPair(db, syntheticPricing, 'gemini', '7d', anchors, t0 + 9 * HOUR, {
    quotaCalibMode: 'auto',
  });
  const sumBase = computeSummaryForPair(db, syntheticPricing, 'gemini', '7d', anchors, t0 + 9 * HOUR, {
    quotaCalibMode: 'manual',
    forceSubset: 'base',
  });

  // Auto should pick C and produce a tighter 95% CI than base (no more base ±$0.10 vs C ±$150 inversion!)
  assert.equal(sumAuto.estimation.calibration.recommendedSubset, 'C');
  assert.equal(sumAuto.estimation.calibration.activeSubset, 'C');
  const baseWidth = sumBase.estimation.ciHighUsd - sumBase.estimation.ciLowUsd;
  const cWidth = sumAuto.estimation.ciHighUsd - sumAuto.estimation.ciLowUsd;
  assert.ok(baseWidth > 5, `base CI must reflect residual dispersion, not quantization-only (width=${baseWidth})`);
  assert.ok(cWidth < baseWidth, `better-fitting C CI (${cWidth.toFixed(2)}) must be narrower than base (${baseWidth.toFixed(2)})`);
  assert.ok(sumAuto.estimation.ciLowUsd > 0 && sumAuto.estimation.ciHighUsd > sumAuto.estimation.estimatedPoolUsd);

  // Delta Method covariance cancellation: seBetaMix must be smaller than marginal seBeta rescaled
  const subC = sumAuto.estimation.calibration.subsets.C;
  const marginalRescaled = subC.seBeta * (subC.anchorPoolUsd / subC.equivalentMixPoolUsd);
  assert.ok(
    subC.seBetaMix < marginalRescaled * 0.7,
    `Delta Method seBetaMix (${subC.seBetaMix}) must cancel beta/alpha_cache collinearity vs marginal (${marginalRescaled})`
  );

  // Student-t critical value smooth check
  assert.ok(Math.abs(studentTCrit95(5) - 2.5706) < 0.01);
  assert.ok(Math.abs(studentTCrit95(6) - 2.4469) < 0.01);
  assert.ok(Math.abs(studentTCrit95(1000) - 1.96) < 0.01);

  db.close();
});

test('v1.8.0: two-tier Manual Explore vs Auto Adopt gates, clamped boundary SE, N=p+1 LOOCV skip, and full i18n reasonCode coverage', () => {
  const mkModel = () => ({
    pool: 'gemini',
    rates: [
      {
        effective_from: '2026-01-01',
        input_per_1m: 10,
        output_per_1m: 10,
        thinking_per_1m: 10,
        cache_read_per_1m: 1,
        cache_write_per_1m: 10,
        discount_multiplier: 1.0,
      },
    ],
  });
  const syntheticPricing = {
    defaults: {
      defaultAnchors: { gemini: 'gemini-main' },
      models: {
        'gemini-main': mkModel(),
        'gemini-sub': mkModel(),
      },
    },
    remote: { models: {} },
    overrides: {},
  };

  const t0 = Date.parse('2026-11-12T00:00:00Z');
  const mkTurn = (ts, model, inUsd, crUsd) => ({
    completed_at_ms: ts,
    canonical_model_id: model,
    raw_model_id: model,
    pool: 'gemini',
    uncached_in: Math.round((inUsd / 10) * 1e6),
    cache_read: Math.round((crUsd / 1) * 1e6),
    cache_create: 0,
    total_out: 0,
  });

  // Case 1: N = 3 segments with C variation std >= 0.03 -> C is eligible (exploratory), autoEligible = false, LOOCV = null
  const segs3 = [
    { startAt: t0, endAt: t0 + HOUR, deltaU: 0.05, qK: 0.0001, turns: [mkTurn(t0 + 1000, 'gemini-main', 4.5, 0.5)] },
    { startAt: t0 + HOUR, endAt: t0 + 2 * HOUR, deltaU: 0.04, qK: 0.0001, turns: [mkTurn(t0 + HOUR + 1000, 'gemini-main', 2.0, 3.0)] },
    { startAt: t0 + 2 * HOUR, endAt: t0 + 3 * HOUR, deltaU: 0.07, qK: 0.0001, turns: [mkTurn(t0 + 2 * HOUR + 1000, 'gemini-main', 6.0, 1.5)] },
  ];
  const cal3 = calibrateQuotaCycle({
    pool: 'gemini',
    windowType: '7d',
    pricingState: syntheticPricing,
    rawSegments: segs3,
    quotaCalibMode: 'manual',
    forceSubset: 'C',
    minDurationMs: 0,
  });
  assert.equal(cal3.subsets.C.eligible, true, 'N=3 should unlock C for manual exploration');
  assert.equal(cal3.subsets.C.autoEligible, false, 'N=3 must NOT pass Auto gate');
  assert.equal(cal3.subsets.C.exploratory, true);
  assert.equal(cal3.subsets.C.loocvMaePp, null, 'N=p+1 must skip degenerate dof=0 LOOCV');
  assert.equal(cal3.recommendedSubset, 'base', 'Auto must stay on base at N=3');
  assert.equal(cal3.activeSubset, 'C', 'Manual forceSubset=C should activate exploratory C');

  // Case 2: N = 4 segments with 8% secondary model (std ~0.055) -> M is exploratory (manual OK, Auto skips)
  const segs4M = [
    { startAt: t0, endAt: t0 + HOUR, deltaU: 0.02, qK: 0.0001, turns: [mkTurn(t0 + 1000, 'gemini-main', 2.0, 0)] },
    { startAt: t0 + HOUR, endAt: t0 + 2 * HOUR, deltaU: 0.04, qK: 0.0001, turns: [mkTurn(t0 + HOUR + 1000, 'gemini-main', 4.0, 0)] },
    {
      startAt: t0 + 2 * HOUR,
      endAt: t0 + 3 * HOUR,
      deltaU: 0.085,
      qK: 0.0001,
      turns: [mkTurn(t0 + 2 * HOUR + 1000, 'gemini-main', 7.4, 0), mkTurn(t0 + 2 * HOUR + 2000, 'gemini-sub', 0.6, 0)],
    },
    {
      startAt: t0 + 3 * HOUR,
      endAt: t0 + 4 * HOUR,
      deltaU: 0.27,
      qK: 0.0001,
      turns: [mkTurn(t0 + 3 * HOUR + 1000, 'gemini-main', 21.6, 0), mkTurn(t0 + 3 * HOUR + 2000, 'gemini-sub', 2.6, 0)],
    },
  ];
  const cal4M = calibrateQuotaCycle({
    pool: 'gemini',
    windowType: '7d',
    pricingState: syntheticPricing,
    rawSegments: segs4M,
    quotaCalibMode: 'auto',
    minDurationMs: 0,
  });
  assert.equal(cal4M.factors.M.eligible, true, '8% secondary model should unlock M for manual explore');
  assert.equal(cal4M.factors.M.autoEligible, false, '8% secondary model at N=4 must not pass Auto gate');
  assert.equal(cal4M.factors.M.autoReasonCode, 'm_auto_share_or_segs');
  assert.equal(cal4M.subsets.M.exploratory, true);
  assert.equal(cal4M.recommendedSubset, 'base', 'Auto must not adopt exploratory M at N=4');

  // Case 3: Clamped alpha_cache at lower bound 0.05 still retains conservative SE (column not dropped)
  const segsClamp = [
    { startAt: t0, endAt: t0 + HOUR, deltaU: 0.02, qK: 0.0001, turns: [mkTurn(t0 + 1000, 'gemini-main', 2.0, 0.2)] },
    { startAt: t0 + HOUR, endAt: t0 + 2 * HOUR, deltaU: 0.03, qK: 0.0001, turns: [mkTurn(t0 + HOUR + 1000, 'gemini-main', 3.0, 18.0)] },
    { startAt: t0 + 2 * HOUR, endAt: t0 + 3 * HOUR, deltaU: 0.05, qK: 0.0001, turns: [mkTurn(t0 + 2 * HOUR + 1000, 'gemini-main', 5.0, 1.0)] },
    { startAt: t0 + 3 * HOUR, endAt: t0 + 4 * HOUR, deltaU: 0.08, qK: 0.0001, turns: [mkTurn(t0 + 3 * HOUR + 1000, 'gemini-main', 8.0, 35.0)] },
  ];
  const calClamp = calibrateQuotaCycle({
    pool: 'gemini',
    windowType: '7d',
    pricingState: syntheticPricing,
    rawSegments: segsClamp,
    quotaCalibMode: 'auto',
    minDurationMs: 0,
  });
  assert.equal(calClamp.subsets.C.params.cache.value, 0.05, 'lower bound must clamp at ALPHA_CACHE_MIN=0.05');
  assert.equal(calClamp.subsets.C.params.cache.clamped, true);
  assert.ok(calClamp.subsets.C.params.cache.se != null && calClamp.subsets.C.params.cache.se > 0, 'clamped cache param must retain conservative SE');
  assert.ok(calClamp.subsets.C.seBetaMix > 0);

  // Case 4: Every reasonCode emitted in quota_calibrator.mjs is handled in app.js formatCalibReason
  const calSrc = readFileSync(join(__dirname, '..', 'sidecars', 'lens_panel', 'lib', 'quota_calibrator.mjs'), 'utf-8');
  const appSrc = readFileSync(join(__dirname, '..', 'sidecars', 'lens_panel', 'web', 'app.js'), 'utf-8');
  const codes = new Set([...calSrc.matchAll(/mkReason\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
  assert.ok(codes.size >= 10, 'expected structured reason codes in quota_calibrator.mjs');
  for (const code of codes) {
    assert.ok(appSrc.includes(`case '${code}':`), `app.js formatCalibReason missing case '${code}'`);
  }

  // Case 5: Strong Auto model + weak exploratory model must isolate Auto (weak model never leaks into Auto M fit)
  const pricing3 = {
    defaults: {
      defaultAnchors: { gemini: 'gemini-main' },
      models: {
        'gemini-main': mkModel(),
        'gemini-strong': mkModel(),
        'gemini-weak': mkModel(),
      },
    },
    remote: { models: {} },
    overrides: {},
  };
  const segsStrongWeak = [
    { startAt: t0, endAt: t0 + HOUR, deltaU: 0.04, qK: 0.0001, turns: [mkTurn(t0 + 1000, 'gemini-main', 4.0, 0)] },
    { startAt: t0 + HOUR, endAt: t0 + 2 * HOUR, deltaU: 0.08, qK: 0.0001, turns: [mkTurn(t0 + HOUR + 1000, 'gemini-main', 2.0, 0), mkTurn(t0 + HOUR + 2000, 'gemini-strong', 3.0, 0)] },
    { startAt: t0 + 2 * HOUR, endAt: t0 + 3 * HOUR, deltaU: 0.075, qK: 0.0001, turns: [mkTurn(t0 + 2 * HOUR + 1000, 'gemini-main', 5.0, 0), mkTurn(t0 + 2 * HOUR + 2000, 'gemini-strong', 1.0, 0), mkTurn(t0 + 2 * HOUR + 3000, 'gemini-weak', 0.5, 0)] },
    { startAt: t0 + 3 * HOUR, endAt: t0 + 4 * HOUR, deltaU: 0.135, qK: 0.0001, turns: [mkTurn(t0 + 3 * HOUR + 1000, 'gemini-main', 4.5, 0), mkTurn(t0 + 3 * HOUR + 2000, 'gemini-strong', 4.0, 0), mkTurn(t0 + 3 * HOUR + 3000, 'gemini-weak', 1.0, 0)] },
  ];
  const calSW = calibrateQuotaCycle({
    pool: 'gemini',
    windowType: '7d',
    pricingState: pricing3,
    rawSegments: segsStrongWeak,
    quotaCalibMode: 'auto',
    minDurationMs: 0,
  });
  assert.deepEqual(calSW.factors.M.candidateModels, ['gemini-strong'], 'weak exploratory model must not leak into Auto M candidate set');
  assert.equal(calSW.factors.M.autoEligible, true);

  // Case 6: N=0 fallbackPooled uses prior tCrit = studentTCrit95(4) (2.7764), not 1.96
  const calN0 = calibrateQuotaCycle({
    pool: 'gemini',
    windowType: '7d',
    pricingState: syntheticPricing,
    rawSegments: [],
    fallbackPooled: { sumDeltaU: 0.03, sumC: 3.0 },
    minDurationMs: 0,
  });
  assert.ok(Math.abs(calN0.subsets.base.tCrit - 2.7764) < 0.001, 'N=0 fallbackPooled must use t_{0.975, 4}');
});

