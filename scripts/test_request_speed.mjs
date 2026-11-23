import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MIN_TPS_DURATION_MS,
  computeRequestSpeedSummary,
  computeSessionCacheFreshness,
  formatRequestRow,
  queryRequestsPage,
} from '../sidecars/lens_panel/lib/request_speed.mjs';
import { openTelemetryCacheDb } from '../sidecars/lens_panel/lib/indexer.mjs';
import { loadPricingState, calculateTurnCost } from '../sidecars/lens_panel/lib/pricing.mjs';
import { addAccountSwitch, createAccount } from '../sidecars/lens_panel/lib/accounts.mjs';
import { startStandaloneServer } from '../sidecars/lens_panel/standalone.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function insertTurn(
  db,
  {
    conv = 'aaaaaaaa-1111-2222-3333-444444444444',
    step = 1,
    source = 'cli',
    createdMs,
    completedMs,
    ttftMs = 4000,
    genMs = 2000,
    model = 'gemini-4-neon',
    pool = 'gemini',
    uncached = 10_000,
    cacheRead = 90_000,
    think = 100,
    vis = 300,
    reqId = 'req-1',
  }
) {
  const firstMs = createdMs + ttftMs;
  db.prepare(
    `INSERT OR REPLACE INTO turns (
       conversation_id, step_idx, source, created_at_ms, first_token_at_ms, completed_at_ms,
       ttft_ms, gen_ms, raw_model_id, canonical_model_id, display_name, pool,
       provider_request_id, uncached_in, cache_read, cache_create, thinking_out, visible_out, total_out
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(
    conv,
    step,
    source,
    createdMs,
    firstMs,
    completedMs,
    ttftMs,
    genMs,
    model,
    model,
    model,
    pool,
    reqId,
    uncached,
    cacheRead,
    think,
    vis,
    think + vis
  );
}

test('computeSessionCacheFreshness steps backward in 5h increments until >= 50 samples and caps at 168h', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lens-fresh-'));
  const { db } = openTelemetryCacheDb(dir);
  try {
    const now = Date.UTC(2025, 5, 10, 12, 0, 0);
    const convA = '11111111-1111-1111-1111-111111111111';
    const convB = '22222222-2222-2222-2222-222222222222';

    // Seed 31 turns inside last 5h -> 30 follow-up transitions (<50)
    for (let i = 0; i < 31; i++) {
      const start = now - 4 * HOUR + i * 3 * MIN;
      insertTurn(db, {
        conv: convA,
        step: i + 1,
        createdMs: start,
        completedMs: start + 10_000,
        cacheRead: i === 0 ? 0 : 90_000,
        uncached: i === 0 ? 100_000 : 10_000,
      });
    }
    // Seed 31 more turns inside 5h..10h ago -> total 60 follow-ups (>=50 at 10h!)
    for (let i = 0; i < 31; i++) {
      const start = now - 9 * HOUR + i * 3 * MIN;
      insertTurn(db, {
        conv: convB,
        step: i + 1,
        createdMs: start,
        completedMs: start + 10_000,
        cacheRead: i === 0 ? 0 : (i % 2 === 0 ? 90_000 : 0),
        uncached: i === 0 ? 100_000 : (i % 2 === 0 ? 10_000 : 100_000),
      });
    }

    const res = computeSessionCacheFreshness(db, {
      modelId: 'gemini-4-neon',
      sources: ['cli'],
      nowMs: now,
      minSamples: 50,
      stepHours: 5,
      maxHours: 168,
    });
    assert.equal(res.scope, 'model');
    assert.equal(res.windowHours, 10);
    assert.equal(res.totalSamples, 60);

    // Every gap is ~2m50s -> falls in 1-5m bucket; 30/30 hits in 0..5h + 15/30 hits in 5..10h = 45/60 = 75%
    const b15 = res.buckets.find((b) => b.key === '1-5m');
    assert.ok(b15);
    assert.equal(b15.turns, 60);
    assert.equal(b15.hits, 45);
    assert.equal(b15.keepRate, 0.75);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeRequestSpeedSummary separates weighted vs P50 for both Decode and E2E TPS, guards <50ms outliers, and uses pure API pricing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lens-speed-'));
  const pricing = loadPricingState(dir);
  try {
    const base = Date.UTC(2025, 5, 10, 10, 0, 0);
    const turns = [
      // Turn 1: 1000 out, gen=10s (100 decode t/s), total=20s (50 e2e t/s), ttft=10s
      {
        conversation_id: 'c1',
        step_idx: 1,
        source: 'cli',
        created_at_ms: base,
        completed_at_ms: base + 20_000,
        ttft_ms: 10_000,
        gen_ms: 10_000,
        canonical_model_id: 'gemini-4-neon',
        display_name: 'Gemini 4 Neon',
        pool: 'gemini',
        uncached_in: 100_000,
        cache_read: 0,
        cache_create: 0,
        thinking_out: 400,
        visible_out: 600,
        total_out: 1000,
      },
      // Turn 2: 200 out, gen=1s (200 decode t/s), total=2s (100 e2e t/s), ttft=1s
      {
        conversation_id: 'c1',
        step_idx: 2,
        source: 'cli',
        created_at_ms: base + 30_000,
        completed_at_ms: base + 32_000,
        ttft_ms: 1_000,
        gen_ms: 1_000,
        canonical_model_id: 'gemini-4-neon',
        display_name: 'Gemini 4 Neon',
        pool: 'gemini',
        uncached_in: 5_000,
        cache_read: 95_000,
        cache_create: 0,
        thinking_out: 50,
        visible_out: 150,
        total_out: 200,
      },
      // Turn 3: tiny gen_ms=10ms (<MIN_TPS_DURATION_MS) outlier -> decodeTps must be null (lowConfGen=true)
      {
        conversation_id: 'c1',
        step_idx: 3,
        source: 'cli',
        created_at_ms: base + 60_000,
        completed_at_ms: base + 62_010,
        ttft_ms: 2_000,
        gen_ms: 10,
        canonical_model_id: 'gemini-4-neon',
        display_name: 'Gemini 4 Neon',
        pool: 'gemini',
        uncached_in: 1_000,
        cache_read: 99_000,
        cache_create: 0,
        thinking_out: 0,
        visible_out: 50,
        total_out: 50,
      },
    ];

    const r3 = formatRequestRow(turns[2], pricing);
    assert.equal(r3.lowConfGen, true);
    assert.equal(r3.decodeTps, null);
    assert.ok(r3.e2eTps > 0);
    assert.ok(MIN_TPS_DURATION_MS === 50);

    const summary = computeRequestSpeedSummary(turns, pricing);
    assert.equal(summary.totals.requests, 3);
    assert.equal(summary.totals.totalOut, 1250);
    assert.equal(summary.totals.thinkingOut, 450);

    // Pure API cost check: must equal exact sum of calculateTurnCost()
    const expectedCost = turns.reduce((acc, t) => acc + calculateTurnCost(t, pricing).costUsd, 0);
    assert.ok(Math.abs(summary.totals.costUsd - expectedCost) < 1e-9);

    // Token-weighted Decode TPS = 1250 / (10 + 1 + 0.01) = 113.53 t/s
    assert.ok(Math.abs(summary.averages.weightedDecodeTps - 1250 / 11.01) < 0.05);
    // P50 Decode TPS (over valid gen_ms>=50ms: [100, 200]) = 150 t/s
    assert.equal(summary.averages.p50DecodeTps, 150);
    // Token-weighted E2E TPS = 1250 / (20 + 2 + 2.01) = 52.06 t/s
    assert.ok(Math.abs(summary.averages.weightedE2eTps - 1250 / 24.01) < 0.05);
    // TTFT P50 over [1000, 2000, 10000] = 2000ms
    assert.equal(summary.averages.p50TtftMs, 2000);
    assert.equal(summary.byModel.length, 1);
    assert.ok(summary.periods['1h'].length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryRequestsPage supports pagination, filtering, sorting, account isolation, and HTTP --read-only GET /api/requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lens-reqpage-'));
  const { db } = openTelemetryCacheDb(dir);
  const pricing = loadPricingState(dir);
  try {
    const base = Date.UTC(2025, 5, 10, 10, 0, 0);
    const { account: accB } = createAccount(db, { name: 'Alt' }, base);
    addAccountSwitch(db, { accountId: accB.id, source: 'all', effectiveFromMs: base + 10 * MIN }, base + 20 * MIN);

    for (let i = 0; i < 25; i++) {
      const ts = base + i * MIN;
      insertTurn(db, {
        conv: '33333333-3333-3333-3333-333333333333',
        step: i + 1,
        source: i % 2 === 0 ? 'cli' : 'desktop',
        createdMs: ts - 5000,
        completedMs: ts,
        ttftMs: i === 5 ? 20_000 : 3000,
        genMs: 2000,
        model: i % 3 === 0 ? 'claude-opus-5-5' : 'gemini-4-neon',
        cacheRead: i === 2 ? 0 : 80_000,
        uncached: i === 2 ? 80_000 : 5_000,
        vis: 200 + i * 10,
      });
    }

    const p1 = queryRequestsPage(db, pricing, { fromMs: base - HOUR, toMs: base + HOUR, page: 1, pageSize: 10 });
    assert.equal(p1.total, 25);
    assert.equal(p1.totalPages, 3);
    assert.equal(p1.items.length, 10);
    assert.ok(p1.items[0].timestampMs > p1.items[1].timestampMs);

    const pCold = queryRequestsPage(db, pricing, { fromMs: base - HOUR, toMs: base + HOUR, flag: 'cold' });
    assert.equal(pCold.total, 1);
    assert.equal(pCold.items[0].stepIdx, 3);

    const pSlow = queryRequestsPage(db, pricing, { fromMs: base - HOUR, toMs: base + HOUR, flag: 'slow' });
    assert.equal(pSlow.total, 1);
    assert.equal(pSlow.items[0].stepIdx, 6);

    const pAccB = queryRequestsPage(db, pricing, {
      fromMs: base - HOUR,
      toMs: base + HOUR,
      accountId: accB.id,
      pageSize: 50,
    });
    assert.equal(pAccB.total, 15); // steps 11..25 (i=10..24)
    assert.ok(pAccB.items.every((it) => it.accountId === accB.id));
  } finally {
    db.close();
  }

  // Verify HTTP GET /api/requests works cleanly in --read-only mode
  const srv = await startStandaloneServer({ host: '127.0.0.1', port: 0, dataDir: dir, readOnly: true });
  try {
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest(
        { hostname: '127.0.0.1', port: srv.port, method: 'GET', path: '/api/requests?range=all&page=1&pageSize=10' },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf-8')) }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.items));
    assert.ok(res.json.total >= 25);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
