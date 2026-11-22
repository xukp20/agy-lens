import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_IDLE_THRESHOLD_MS,
  OBS_TIME_GRANULARITIES,
  analyzeTurnsForObservatory,
  buildCompareMarkdown,
} from '../sidecars/lens_panel/lib/cache_observatory.mjs';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function makeTurn({
  conv = 'conv-1',
  step = 1,
  model = 'gemini-4-neon',
  display = 'Gemini 4 Neon (High)',
  createdMs,
  completedMs,
  uncached = 2000,
  cacheRead = 98000,
  reqId = '',
}) {
  return {
    conversation_id: conv,
    step_idx: step,
    source: 'cli',
    created_at_ms: createdMs,
    completed_at_ms: completedMs,
    canonical_model_id: model,
    display_name: display,
    pool: 'gemini',
    uncached_in: uncached,
    cache_read: cacheRead,
    cache_create: 0,
    thinking_out: 100,
    visible_out: 200,
    total_out: 300,
    provider_request_id: reqId,
  };
}

test('empty input returns valid timeSeries structure for all granularities', () => {
  const toMs = Date.parse('2026-11-22T12:00:00Z');
  const res = analyzeTurnsForObservatory([], null, { fromMs: toMs - 7 * DAY, toMs });
  assert.equal(res.summary.followUpTurns, 0);
  assert.equal(res.timeSeries.activeThresholdSec, Math.round(ACTIVE_IDLE_THRESHOLD_MS / 1000));
  assert.equal(res.timeSeries.anchorToMs, toMs);
  for (const g of OBS_TIME_GRANULARITIES) {
    assert.deepEqual(res.timeSeries.granularities[g], []);
  }
});

test('timeSeries aggregates 1h/5h/1d/7d accurately and separates <=5m active zone from >5m idle misses', () => {
  const base = Date.parse('2026-11-20T04:00:00Z');
  const toMs = base + 2 * DAY; // 2026-11-22T04:00:00Z

  const rows = [
    // Day 1 (Nov 20): conv-1 cold start + 1 short-gap unexpected 0% miss + 1 bounce-back hit
    makeTurn({ conv: 'conv-1', step: 1, createdMs: base, completedMs: base + 1000, uncached: 10000, cacheRead: 90000 }),
    // 20s idle -> unexpected 0% miss (<=5m active zone!)
    makeTurn({ conv: 'conv-1', step: 2, createdMs: base + 21_000, completedMs: base + 25_000, uncached: 100000, cacheRead: 0 }),
    // 5s idle -> bounce-back hit (<=5m active zone!)
    makeTurn({ conv: 'conv-1', step: 3, createdMs: base + 30_000, completedMs: base + 35_000, uncached: 2000, cacheRead: 98000 }),

    // Day 2 (Nov 21): conv-2 (Neon) with 1 long-idle (>10m) miss + 1 short-gap hit, plus conv-3 (Hydrogen)
    makeTurn({ conv: 'conv-2', step: 1, createdMs: base + DAY, completedMs: base + DAY + 1000, uncached: 5000, cacheRead: 95000 }),
    // 15m idle -> unexpected 0% miss (OUTSIDE <=5m active zone!)
    makeTurn({ conv: 'conv-2', step: 2, createdMs: base + DAY + 901_000, completedMs: base + DAY + 905_000, uncached: 100000, cacheRead: 0 }),
    // 10s idle -> hit (<=5m active zone!)
    makeTurn({ conv: 'conv-2', step: 3, createdMs: base + DAY + 915_000, completedMs: base + DAY + 920_000, uncached: 1000, cacheRead: 99000 }),

    // Model switch & compaction must be excluded from both matrix and timeSeries
    makeTurn({
      conv: 'conv-2',
      step: 4,
      model: 'gemini-4-hydrogen',
      display: 'Gemini 4 Hydrogen (High)',
      createdMs: base + DAY + 925_000,
      completedMs: base + DAY + 930_000,
      uncached: 50000,
      cacheRead: 0,
    }),
    // Follow-up on Hydrogen (valid follow-up after model switch)
    makeTurn({
      conv: 'conv-2',
      step: 5,
      model: 'gemini-4-hydrogen',
      display: 'Gemini 4 Hydrogen (High)',
      createdMs: base + DAY + 935_000,
      completedMs: base + DAY + 940_000,
      uncached: 2000,
      cacheRead: 48000,
    }),
  ];

  // Custom breakpoints WITHOUT 300s to verify activeThreshold (<=5m) is independent of gapBreakpointsSec
  const res = analyzeTurnsForObservatory(rows, null, {
    fromMs: base - HOUR,
    toMs,
    gapBreakpointsSec: [10, 60, 600],
  });

  // Total valid follow-ups: 2 (Day 1) + 2 (Day 2 Neon) + 1 (Day 2 Hydrogen) = 5
  assert.equal(res.summary.followUpTurns, 5);
  assert.equal(res.summary.modelSwitchTurns, 1);

  const daySlices = res.timeSeries.granularities['1d'];
  assert.equal(daySlices.length, 2);

  // Day 1: 2 turns, both <=5m, 1 unexpected 0% miss
  const d1 = daySlices[0];
  assert.equal(d1.all.turns, 2);
  assert.equal(d1.all.activeTurns, 2);
  assert.equal(d1.all.activeUnexpMisses, 1);
  assert.equal(d1.all.unexpMisses, 1);
  assert.equal(d1.all.hits, 1);
  assert.ok(d1.byModel['gemini-4-neon']);
  assert.equal(d1.byModel['gemini-4-hydrogen'], undefined);

  // Day 2: Neon has 2 turns, 1 overall unexpMiss (at 15m), 0 active (<=5m) unexpMisses!
  const d2 = daySlices[1];
  assert.equal(d2.all.turns, 3);
  assert.equal(d2.byModel['gemini-4-neon'].turns, 2);
  assert.equal(d2.byModel['gemini-4-neon'].unexpMisses, 1);
  assert.equal(d2.byModel['gemini-4-neon'].activeTurns, 1);
  assert.equal(d2.byModel['gemini-4-neon'].activeUnexpMisses, 0);
  assert.equal(d2.byModel['gemini-4-neon'].activeWeightedHitRatio, 0.99);
  assert.equal(d2.byModel['gemini-4-hydrogen'].turns, 1);
  assert.equal(d2.byModel['gemini-4-hydrogen'].activeWeightedHitRatio, 0.96);

  // Verify rolling 5h granularity places Day 1 and Day 2 into distinct 5h slices aligned to toMs
  const fiveHSlices = res.timeSeries.granularities['5h'];
  assert.equal(fiveHSlices.length, 2);
  assert.equal((toMs - fiveHSlices[0].endMs) % (5 * HOUR), 0);
  assert.equal(fiveHSlices[0].endMs - fiveHSlices[0].startMs, 5 * HOUR);

  // Verify modelNames map
  assert.equal(res.timeSeries.modelNames['gemini-4-neon'], 'Gemini 4 Neon (High)');
  assert.equal(res.timeSeries.modelNames['gemini-4-hydrogen'], 'Gemini 4 Hydrogen (High)');

  // Verify Compare Markdown formatter
  const md = buildCompareMarkdown({
    periods: [
      { label: 'Day 1', stats: d1.byModel['gemini-4-neon'] },
      { label: 'Day 2', stats: d2.byModel['gemini-4-neon'] },
    ],
    gapBuckets: res.gapBuckets,
    modelLabel: 'Gemini 4 Neon (High)',
    metric: 'hitRate',
  });
  assert.match(md, /Prompt Cache Period Comparison/);
  assert.match(md, /\| Day 1 \| 2 \| 49\.0% \| 50\.00% \(1\/2\) \|/);
  assert.match(md, /\| Day 2 \| 2 \| 99\.0% \| 0\.00% \(0\/1\) \|/);
});

test('timeSeries caps 1h slices to 24 most recent non-empty slices', () => {
  const base = Date.parse('2026-11-20T00:00:00Z');
  const rows = [
    makeTurn({ conv: 'conv-cap', step: 0, createdMs: base, completedMs: base + 1000, uncached: 5000, cacheRead: 95000 }),
  ];
  for (let h = 1; h <= 30; h++) {
    const ts = base + h * HOUR;
    rows.push(
      makeTurn({
        conv: 'conv-cap',
        step: h,
        createdMs: ts,
        completedMs: ts + 1000,
        uncached: 2000,
        cacheRead: 98000,
      })
    );
  }
  const toMs = base + 31 * HOUR;
  const res = analyzeTurnsForObservatory(rows, null, { fromMs: base, toMs });
  assert.equal(res.timeSeries.granularities['1h'].length, 24);
  // Oldest kept slice should be hour 7 (30 - 24 + 1 = 7)
  assert.equal(res.timeSeries.granularities['1h'][0].startMs, base + 7 * HOUR);
  assert.equal(res.timeSeries.granularities['1h'][23].startMs, base + 30 * HOUR);
});

test('timeSeries handles boundary_cut, compaction exclusion, activeTurns===0, totalIn===0, and pipe escaping', () => {
  const base = Date.parse('2026-11-21T08:00:00Z');
  const toMs = base + 2 * HOUR;
  const rows = [
    // Cold start with 100k context (95% cached)
    makeTurn({ conv: 'c-edge', step: 1, createdMs: base, completedMs: base + 1000, uncached: 5000, cacheRead: 95000 }),
    // Boundary cut: prevHit=95%, curCacheRead=15000 (in [5000, 28000]), curHit=15% (<40%), 30s idle (<=5m)
    makeTurn({ conv: 'c-edge', step: 2, createdMs: base + 31_000, completedMs: base + 35_000, uncached: 85000, cacheRead: 15000 }),
    // Compacted turn: prevTotal=100k > 20k, curTotal=20k < 65k -> must be excluded from both matrix & timeSeries
    makeTurn({ conv: 'c-edge', step: 3, createdMs: base + 40_000, completedMs: base + 45_000, uncached: 20000, cacheRead: 0 }),
    // Long-idle (>5m) turn in second hour with 0 input tokens (edge guard: weightedHitRatio -> null)
    makeTurn({ conv: 'c-edge', step: 4, createdMs: base + HOUR + 600_000, completedMs: base + HOUR + 605_000, uncached: 0, cacheRead: 0 }),
  ];

  const res = analyzeTurnsForObservatory(rows, null, { fromMs: base - HOUR, toMs });
  assert.equal(res.summary.boundaryCuts, 1);
  assert.equal(res.summary.compactedTurns, 1);
  assert.equal(res.summary.followUpTurns, 2);

  const hourSlices = res.timeSeries.granularities['1h'];
  assert.equal(hourSlices.length, 2);
  // Hour 1: boundary_cut recorded in both overall and active
  assert.equal(hourSlices[0].all.boundaryCuts, 1);
  assert.equal(hourSlices[0].all.activeBoundaryCuts, 1);
  assert.equal(hourSlices[0].all.activeTurns, 1);
  // Hour 2: only long-idle zero-input turn -> activeTurns===0 & weightedHitRatio===null (never 0)
  assert.equal(hourSlices[1].all.turns, 1);
  assert.equal(hourSlices[1].all.activeTurns, 0);
  assert.equal(hourSlices[1].all.activeWeightedHitRatio, null);
  assert.equal(hourSlices[1].all.weightedHitRatio, null);

  // Markdown formatter edge cases: empty list & pipe/newline escaping
  const emptyMd = buildCompareMarkdown({ periods: [], gapBuckets: res.gapBuckets, modelLabel: 'A|B\nC' });
  assert.match(emptyMd, /A\\\|B C/);
  assert.doesNotMatch(emptyMd, /\| Period \|/);

  const md = buildCompareMarkdown({
    periods: [{ label: 'Nov 21 | A\nB', stats: hourSlices[1].all }],
    gapBuckets: res.gapBuckets,
    modelLabel: 'Gemini|4',
    metric: 'weightedHitRatio',
  });
  assert.match(md, /Gemini\\\|4/);
  assert.match(md, /\| Nov 21 \\\| A B \| 1 \| — \| — \|/);
});

test('1h slice keys use unique UTC hour startMs so repeated local hours never collide', () => {
  const h1 = Date.parse('2026-11-01T05:15:00Z');
  const h2 = Date.parse('2026-11-01T06:15:00Z'); // 1 hour later (repeated 01:xx in America/New_York DST fall-back)
  const rows = [
    makeTurn({ conv: 'c-dst', step: 0, createdMs: h1 - 10_000, completedMs: h1 - 5_000, uncached: 5000, cacheRead: 95000 }),
    makeTurn({ conv: 'c-dst', step: 1, createdMs: h1, completedMs: h1 + 1000, uncached: 2000, cacheRead: 98000 }),
    makeTurn({ conv: 'c-dst', step: 2, createdMs: h2, completedMs: h2 + 1000, uncached: 2000, cacheRead: 98000 }),
  ];
  const res = analyzeTurnsForObservatory(rows, null, { fromMs: h1 - HOUR, toMs: h2 + HOUR });
  const hSlices = res.timeSeries.granularities['1h'];
  assert.equal(hSlices.length, 2);
  assert.notEqual(hSlices[0].key, hSlices[1].key);
  assert.equal(hSlices[1].startMs - hSlices[0].startMs, HOUR);
  assert.ok(h1 + 1000 >= hSlices[0].startMs && h1 + 1000 < hSlices[0].endMs);
  assert.ok(h2 + 1000 >= hSlices[1].startMs && h2 + 1000 < hSlices[1].endMs);
});
