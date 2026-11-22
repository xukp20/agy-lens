import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { startStandaloneServer } from '../sidecars/lens_panel/standalone.mjs';

import {
  DEFAULT_ACCOUNT_ID,
  UNATTRIBUTED_ACCOUNT_ID,
  addAccountSwitch,
  buildTurnAccountSql,
  computeIntervalsForSource,
  createAccount,
  deleteAccountSwitch,
  listAccountsState,
  mergeAccount,
  parseSwitchAtArg,
  previewSwitchImpact,
  setConversationAccountOverride,
  updateAccount,
} from '../sidecars/lens_panel/lib/accounts.mjs';
import {
  getAnalytics,
  getDayDetail,
  openTelemetryCacheDb,
} from '../sidecars/lens_panel/lib/indexer.mjs';
import { loadPricingState } from '../sidecars/lens_panel/lib/pricing.mjs';
import { addQuotaAnchor, getQuotaStatus } from '../sidecars/lens_panel/lib/quota.mjs';
import { computeCacheObservatory } from '../sidecars/lens_panel/lib/cache_observatory.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function seedTurn(db, {
  conv = 'aaaaaaaa-1111-2222-3333-444444444444',
  step = 1,
  source = 'cli',
  createdMs,
  completedMs,
  model = 'gemini-4-neon',
  pool = 'gemini',
  uncached = 100_000,
  cacheRead = 0,
  out = 5_000,
}) {
  db.prepare(
    `INSERT OR REPLACE INTO turns (
       conversation_id, step_idx, source, created_at_ms, completed_at_ms,
       canonical_model_id, display_name, pool, uncached_in, cache_read, cache_create,
       thinking_out, visible_out, total_out
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  ).run(conv, step, source, createdMs, completedMs, model, model, pool, uncached, cacheRead, out, out);
}

test('computeIntervalsForSource resolves all vs cli/desktop precedence, tie-breaking, and adjacent collapse', () => {
  const switches = [
    { id: 1, source: 'all', account_id: 'acc_a', effective_from_ms: 1000 },
    { id: 2, source: 'cli', account_id: 'acc_b', effective_from_ms: 2000 },
    // Same timestamp as id:3: exact-source cli must beat all
    { id: 3, source: 'cli', account_id: 'acc_c', effective_from_ms: 3000 },
    { id: 4, source: 'all', account_id: 'acc_a', effective_from_ms: 3000 },
    // Redundant adjacent switch to same account -> collapses
    { id: 5, source: 'cli', account_id: 'acc_c', effective_from_ms: 4000 },
  ];
  const valid = new Set(['default', 'acc_a', 'acc_b', 'acc_c']);
  const cli = computeIntervalsForSource(switches, 'cli', valid);
  const desk = computeIntervalsForSource(switches, 'desktop', valid);

  assert.equal(cli.length, 4);
  assert.deepEqual(
    cli.map((x) => [x.from_ms, x.to_ms, x.account_id]),
    [
      [0, 1000, 'default'],
      [1000, 2000, 'acc_a'],
      [2000, 3000, 'acc_b'],
      [3000, Number.MAX_SAFE_INTEGER, 'acc_c'],
    ]
  );

  // Desktop ignores cli-only switches (id:2, id:3, id:5) and collapses [1000, 3000) + [3000, MAX) -> acc_a!
  assert.deepEqual(
    desk.map((x) => [x.from_ms, x.to_ms, x.account_id]),
    [
      [0, 1000, 'default'],
      [1000, Number.MAX_SAFE_INTEGER, 'acc_a'],
    ]
  );
});

test('multi-account SQL attribution isolates turns, unattributed ts<=0, overrides, preview, archive & merge (M1-M4)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lens-acc-'));
  const { db } = openTelemetryCacheDb(dir);
  try {
    const base = Date.parse('2026-11-22T01:00:00Z');
    const c1 = '11111111-1111-1111-1111-111111111111';
    const c2 = '22222222-2222-2222-2222-222222222222';
    const c3 = '33333333-3333-3333-3333-333333333333';

    const { account: accB } = createAccount(db, { name: 'Backup Pro', renameDefaultTo: 'Primary Ultra' }, base);
    const { account: accC } = createAccount(db, { name: 'Work Team' }, base + 10);
    const st0 = listAccountsState(db, base + 20);
    assert.equal(st0.accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID).name, 'Primary Ultra');
    assert.equal(st0.multiAccountActive, true);

    // T1: CLI -> B, Desktop stays default
    addAccountSwitch(db, { accountId: accB.id, source: 'cli', effectiveFromMs: base + 10 * MIN }, base + 10 * MIN);
    // T2: ALL -> C
    addAccountSwitch(db, { accountId: accC.id, source: 'all', effectiveFromMs: base + 30 * MIN }, base + 30 * MIN);

    // Turns across intervals + corrupt ts=0 turn
    seedTurn(db, { conv: c1, step: 1, source: 'cli', createdMs: base + 5 * MIN, completedMs: base + 5 * MIN }); // default
    seedTurn(db, { conv: c1, step: 2, source: 'cli', createdMs: base + 15 * MIN, completedMs: base + 15 * MIN }); // accB
    seedTurn(db, { conv: c2, step: 1, source: 'desktop', createdMs: base + 15 * MIN, completedMs: base + 15 * MIN }); // default (desktop unaffected by cli switch)
    seedTurn(db, { conv: c2, step: 2, source: 'desktop', createdMs: base + 35 * MIN, completedMs: base + 35 * MIN }); // accC
    seedTurn(db, { conv: c3, step: 1, source: 'cli', createdMs: 0, completedMs: 0 }); // unattributed!

    const { joinSql, exprSql } = buildTurnAccountSql('t');
    const resolved = db
      .prepare(`SELECT t.conversation_id, t.step_idx, (${exprSql}) AS acc FROM turns t ${joinSql} ORDER BY t.conversation_id, t.step_idx`)
      .all()
      .map((r) => ({ conversation_id: r.conversation_id, step_idx: r.step_idx, acc: r.acc }));

    assert.deepEqual(resolved, [
      { conversation_id: c1, step_idx: 1, acc: DEFAULT_ACCOUNT_ID },
      { conversation_id: c1, step_idx: 2, acc: accB.id },
      { conversation_id: c2, step_idx: 1, acc: DEFAULT_ACCOUNT_ID },
      { conversation_id: c2, step_idx: 2, acc: accC.id },
      { conversation_id: c3, step_idx: 1, acc: UNATTRIBUTED_ACCOUNT_ID },
    ]);

    // Override pins c2 to accB regardless of switches; preview must skip pinned conversations
    // Adding `all -> C` at `base` only changes [base, base+10m) (c1 step 1: default->C);
    // c1 step 2 at base+15m remains under the existing T1 switch (cli->B), and c2 is pinned!
    setConversationAccountOverride(db, { conversationId: c2, accountId: accB.id }, base + 40 * MIN);
    const prev = previewSwitchImpact(db, { accountId: accC.id, source: 'all', effectiveFromMs: base }, base + 40 * MIN);
    assert.equal(prev.affectedTurns, 1);
    assert.equal(prev.affectedConversations, 1);
    assert.equal(prev.fromAccounts[DEFAULT_ACCOUNT_ID], 1);
    // Adding `cli -> C` at base+12m affects c1 step 2 (B -> C)
    const prev2 = previewSwitchImpact(db, { accountId: accC.id, source: 'cli', effectiveFromMs: base + 12 * MIN }, base + 40 * MIN);
    assert.equal(prev2.affectedTurns, 1);
    assert.equal(prev2.fromAccounts[accB.id], 1);

    // Review hardening (I1/I2/M2): empty string defaults to nowMs, boolean throws,
    // ts<=0 unattributed turns never count when effMs===0, future >5m throws in preview too.
    const prevEmpty = previewSwitchImpact(db, { accountId: accC.id, source: 'cli', effectiveFromMs: '' }, base + 40 * MIN);
    assert.equal(prevEmpty.effectiveFromMs, base + 40 * MIN);
    assert.throws(() => previewSwitchImpact(db, { accountId: accC.id, source: 'cli', effectiveFromMs: false }, base + 40 * MIN));
    assert.throws(() => previewSwitchImpact(db, { accountId: accC.id, source: 'cli', effectiveFromMs: base + 50 * MIN }, base + 40 * MIN));
    const prevEpoch = previewSwitchImpact(db, { accountId: accC.id, source: 'cli', effectiveFromMs: 0 }, base + 40 * MIN);
    assert.equal(prevEpoch.fromAccounts[UNATTRIBUTED_ACCOUNT_ID], undefined);

    // Soft-archive B preserves its attribution (turns in [T1, T2) do NOT slip back to default!)
    // and rejects switching or previewing to archived target.
    updateAccount(db, { id: accB.id, archived: true }, base + 45 * MIN);
    assert.throws(() => addAccountSwitch(db, { accountId: accB.id, source: 'cli' }, base + 45 * MIN), /archived/i);
    assert.throws(() => previewSwitchImpact(db, { accountId: accB.id, source: 'cli' }, base + 45 * MIN), /archived/i);
    const afterArchive = db
      .prepare(`SELECT t.conversation_id, t.step_idx, (${exprSql}) AS acc FROM turns t ${joinSql} WHERE t.conversation_id = ? AND t.step_idx = 2`)
      .get(c1);
    assert.equal(afterArchive.acc, accB.id);

    // Unarchive & explicit merge B -> C rewrites T1 switch to C (so [T1, T2) goes to C, never slipping to default!)
    updateAccount(db, { id: accB.id, archived: false }, base + 46 * MIN);
    mergeAccount(db, { fromId: accB.id, toId: accC.id, anchorAction: 'reassign' }, base + 47 * MIN);
    const afterMerge = db
      .prepare(`SELECT t.conversation_id, t.step_idx, (${exprSql}) AS acc FROM turns t ${joinSql} WHERE t.conversation_id = ? ORDER BY t.step_idx`)
      .all(c1);
    assert.deepEqual(
      afterMerge.map((r) => r.acc),
      [DEFAULT_ACCOUNT_ID, accC.id]
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-account quota isolation, explicit accountId enforcement (M5), M8 backward compat, and Observatory account_switch guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lens-acc-q-'));
  const { db } = openTelemetryCacheDb(dir);
  try {
    const pricing = loadPricingState(dir);
    // Use an isolated date in 2025 so host conversation DBs never overlap with test range
    const base = Date.parse('2025-05-10T02:00:00Z');
    const { account: accB } = createAccount(db, { name: 'Account B', renameDefaultTo: 'Account A' }, base);

    // M5: omitting accountId when >= 2 accounts exist must throw
    assert.throws(
      () => addQuotaAnchor(db, { pool: 'gemini', windowType: '7d', remainingPct: 90, capturedAt: base + 10 * MIN }, base + 10 * MIN),
      /accountId is required/
    );

    // Switch CLI to Account B at base + 30m
    addAccountSwitch(db, { accountId: accB.id, source: 'cli', effectiveFromMs: base + 30 * MIN }, base + 30 * MIN);

    const conv = '44444444-4444-4444-4444-444444444444';
    // Account A turns (2 turns: cold start + hit)
    seedTurn(db, { conv, step: 1, source: 'cli', createdMs: base + 5 * MIN, completedMs: base + 6 * MIN, uncached: 100_000, cacheRead: 900_000, out: 10_000 });
    seedTurn(db, { conv, step: 2, source: 'cli', createdMs: base + 7 * MIN, completedMs: base + 8 * MIN, uncached: 100_000, cacheRead: 900_000, out: 10_000 });
    // Cross-account turn (Account B resumes same conv with 0 cache read -> MUST be excluded as account_switch, NOT unexpected_full_miss!)
    seedTurn(db, { conv, step: 3, source: 'cli', createdMs: base + 31 * MIN, completedMs: base + 32 * MIN, uncached: 1_000_000, cacheRead: 0, out: 20_000 });
    // Account B follow-up hit
    seedTurn(db, { conv, step: 4, source: 'cli', createdMs: base + 33 * MIN, completedMs: base + 34 * MIN, uncached: 50_000, cacheRead: 950_000, out: 10_000 });

    // Log independent 7d anchors for A and B
    const nowMs = base + 40 * MIN;
    addQuotaAnchor(db, { accountId: DEFAULT_ACCOUNT_ID, pool: 'gemini', windowType: '7d', remainingPct: 100, capturedAt: base + 1 * MIN, resetAt: base + 7 * 24 * HOUR }, nowMs);
    addQuotaAnchor(db, { accountId: DEFAULT_ACCOUNT_ID, pool: 'gemini', windowType: '7d', remainingPct: 95, capturedAt: base + 10 * MIN }, nowMs);

    addQuotaAnchor(db, { accountId: accB.id, pool: 'gemini', windowType: '7d', remainingPct: 100, capturedAt: base + 30 * MIN, resetAt: base + 7 * 24 * HOUR }, nowMs);
    addQuotaAnchor(db, { accountId: accB.id, pool: 'gemini', windowType: '7d', remainingPct: 90, capturedAt: base + 36 * MIN }, nowMs);

    // Isolated per-account quota status
    const qA = getQuotaStatus(db, pricing, { pool: 'gemini', windowType: '7d', accountId: DEFAULT_ACCOUNT_ID }, nowMs);
    const qB = getQuotaStatus(db, pricing, { pool: 'gemini', windowType: '7d', accountId: accB.id }, nowMs);
    assert.equal(qA.anchors.length, 2);
    assert.equal(qB.anchors.length, 2);
    // Account A has 2 turns (~$1.17), Account B has 2 turns including 1M uncached (~$3.74) -> completely distinct spends!
    assert.ok(qA.summaries[0].cycleSpendUsd > 0 && qA.summaries[0].cycleSpendUsd < 2);
    assert.ok(qB.summaries[0].cycleSpendUsd > 3);

    // M8: accountId='all' returns byAccount AND backward-compatible top-level summaries/anchors from primary active account (accB)
    const qAll = getQuotaStatus(db, pricing, { pool: 'gemini', windowType: '7d', accountId: 'all' }, nowMs);
    assert.equal(qAll.multiAccountActive, true);
    assert.equal(qAll.byAccount.length, 2);
    assert.equal(qAll.primaryAccountId, accB.id);
    assert.equal(qAll.summaries[0].cycleSpendUsd, qB.summaries[0].cycleSpendUsd);

    // Cache Observatory cross-account guard: step 3 (A->B) excluded as account_switch, 0 unexpected misses!
    const obsAll = computeCacheObservatory(db, pricing, { fromMs: base, toMs: nowMs, sources: ['cli'], accountId: 'all' });
    assert.equal(obsAll.summary.accountSwitchTurns, 1);
    assert.equal(obsAll.summary.unexpectedFullMisses, 0);
    assert.equal(obsAll.summary.followUpTurns, 2); // step 2 (A) + step 4 (B)

    const obsB = computeCacheObservatory(db, pricing, { fromMs: base, toMs: nowMs, sources: ['cli'], accountId: accB.id });
    assert.equal(obsB.summary.followUpTurns, 1); // only step 4 (B)
    assert.equal(obsB.summary.unexpectedFullMisses, 0);

    // Analytics & Day detail filtering
    const anA = getAnalytics(db, pricing, { range: 'custom', from: String(base), to: String(nowMs), sources: ['cli'], accountId: DEFAULT_ACCOUNT_ID, modules: new Set(['model-cost']) });
    const anB = getAnalytics(db, pricing, { range: 'custom', from: String(base), to: String(nowMs), sources: ['cli'], accountId: accB.id, modules: new Set(['model-cost']) });
    assert.equal(anA.modelCost.models[0].turns, 2);
    assert.equal(anB.modelCost.models[0].turns, 2);
    assert.ok(anB.modelCost.totalCostUsd > anA.modelCost.totalCostUsd * 2);

    const dayA = getDayDetail(db, pricing, { date: '2025-05-10', sources: ['cli'], accountId: DEFAULT_ACCOUNT_ID });
    assert.equal(dayA.totals.turns, 2);

    // CLI --at parsing
    assert.equal(parseSwitchAtArg('now', 100000), 100000);
    assert.equal(parseSwitchAtArg('-30m', 100000 + 30 * MIN), 100000);
    assert.equal(parseSwitchAtArg('-2h', 100000 + 2 * HOUR), 100000);
    assert.throws(() => parseSwitchAtArg('not-a-date', 100000));

    // Delete switch cleans interval cleanly
    const swId = listAccountsState(db, nowMs).switches[0].id;
    deleteAccountSwitch(db, swId, nowMs);
    assert.equal(listAccountsState(db, nowMs).activeBySource.cli, DEFAULT_ACCOUNT_ID);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function httpCall({ port, method = 'GET', path = '/', body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body !== null ? JSON.stringify(body) : null;
    const headers = payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {};
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

test('HTTP /api/accounts* CRUD, --read-only 403 guards, and CLI switch/status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lens-acc-http-'));
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const cliBin = join(rootDir, 'bin', 'agy-lens.mjs');

  const srv = await startStandaloneServer({ host: '127.0.0.1', port: 0, dataDir: dir });
  try {
    // 1. Initial GET /api/accounts -> single-account stealth
    const init = await httpCall({ port: srv.port, path: '/api/accounts' });
    assert.equal(init.status, 200);
    assert.equal(init.json.multiAccountActive, false);
    assert.equal(init.json.accounts.length, 1);

    // 2. Create 2nd account + guided Default rename
    const created = await httpCall({
      port: srv.port,
      method: 'POST',
      path: '/api/accounts',
      body: { name: 'Alt Ultra', color: '#34a853', renameDefaultTo: 'Main Ultra' },
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.state.multiAccountActive, true);
    assert.equal(created.json.state.accounts.find((a) => a.id === 'default').name, 'Main Ultra');
    const altId = created.json.account.id;

    // 3. Preview + log switch + verify activeBySource
    const prev = await httpCall({
      port: srv.port,
      method: 'POST',
      path: '/api/accounts/switch/preview',
      body: { accountId: altId, source: 'cli' },
    });
    assert.equal(prev.status, 200);
    assert.equal(typeof prev.json.affectedTurns, 'number');

    const sw = await httpCall({
      port: srv.port,
      method: 'POST',
      path: '/api/accounts/switch',
      body: { accountId: altId, source: 'cli', note: 'switched via http' },
    });
    assert.equal(sw.status, 200);
    assert.equal(sw.json.state.activeBySource.cli, altId);
    assert.equal(sw.json.state.activeBySource.desktop, 'default');

    // 4. Quota anchor returns nearSwitch hint when logged immediately after switch
    const qa = await httpCall({
      port: srv.port,
      method: 'POST',
      path: '/api/quota/anchors',
      body: { accountId: altId, viewAccountId: 'all', pool: 'gemini', windowType: '7d', remainingPct: 100 },
    });
    assert.equal(qa.status, 200);
    assert.ok(qa.json.nearSwitch, 'expected nearSwitch warning right after switch');
    assert.ok(Array.isArray(qa.json.byAccount), 'expected byAccount in all view');

    // 5. CLI switch --dry-run and status --account --json
    const dryOut = execFileSync(
      process.execPath,
      [cliBin, 'switch', 'Main Ultra', '--scope', 'cli', '--dry-run', '--json', '--data-dir', dir],
      { encoding: 'utf-8' }
    );
    const dryJson = JSON.parse(dryOut);
    assert.equal(dryJson.dryRun, true);
    assert.equal(dryJson.account.id, 'default');

    const statusOut = execFileSync(
      process.execPath,
      [cliBin, 'status', '--account', 'Alt Ultra', '--json', '--data-dir', dir],
      { encoding: 'utf-8' }
    );
    const statusJson = JSON.parse(statusOut);
    assert.equal(statusJson.accountId, altId);
  } finally {
    await srv.close();
  }

  // 6. --read-only mode blocks every account write endpoint with 403 while allowing GET /api/accounts
  const roSrv = await startStandaloneServer({ host: '127.0.0.1', port: 0, dataDir: dir, readOnly: true });
  try {
    const getAcc = await httpCall({ port: roSrv.port, path: '/api/accounts' });
    assert.equal(getAcc.status, 200);
    assert.equal(getAcc.json.multiAccountActive, true);

    for (const p of [
      '/api/accounts',
      '/api/accounts/update',
      '/api/accounts/merge',
      '/api/accounts/switch',
      '/api/accounts/switch/delete',
      '/api/accounts/conversation-override',
    ]) {
      const r = await httpCall({ port: roSrv.port, method: 'POST', path: p, body: {} });
      assert.equal(r.status, 403, `Expected 403 in --read-only for POST ${p}, got ${r.status}`);
    }
  } finally {
    await roSrv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
