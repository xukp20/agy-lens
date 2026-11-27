import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTelemetryCacheDb } from '../sidecars/lens_panel/lib/indexer.mjs';
import { loadPricingState } from '../sidecars/lens_panel/lib/pricing.mjs';
import { addQuotaAnchor, getQuotaStatus } from '../sidecars/lens_panel/lib/quota.mjs';
import { createAccount, addAccountSwitch } from '../sidecars/lens_panel/lib/accounts.mjs';
import { createLensRuntime } from '../sidecars/lens_panel/lib/server_core.mjs';
import {
  DEFAULT_AUTO_QUOTA_CONFIG,
  sanitizeAutoQuotaConfig,
  resolveAgyCliPath,
  getInstallGuidance,
  fetchAgyUsageRaw,
  parseAgyUsageOutput,
  evaluateAutoQuotaGate,
  applyParsedQuotaBuckets,
  createAutoQuotaManager,
} from '../sidecars/lens_panel/lib/auto_quota.mjs';

function makeTempDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'agy-lens-aq-test-'));
}

let nextStepIdx = 1;
function insertSyntheticTurn(db, { convId = 'conv-1', completedAtMs, inputTokens = 100000, outputTokens = 20000, cacheReadTokens = 0, pool = 'gemini', model = 'gemini-4-neon', source = 'cli' }) {
  const stepIdx = nextStepIdx++;
  db.prepare(
    `INSERT INTO turns (
       conversation_id, step_idx, source, created_at_ms, completed_at_ms, ttft_ms, gen_ms,
       raw_model_id, canonical_model_id, display_name, pool,
       uncached_in, cache_read, cache_create, thinking_out, visible_out, total_out
     ) VALUES (?, ?, ?, ?, ?, 300, 900, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  ).run(
    convId,
    stepIdx,
    source,
    completedAtMs - 1200,
    completedAtMs,
    model,
    model,
    model,
    pool,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    outputTokens
  );
}

test('sanitizeAutoQuotaConfig clamps ranges and defaults to disabled', () => {
  const def = sanitizeAutoQuotaConfig();
  assert.equal(def.enabled, false);
  assert.equal(def.provider, 'agy_cli');
  assert.equal(def.intervalMinutes, 120);
  assert.equal(def.minTurns, 20);
  assert.equal(def.minSpendUsd, 3.0);
  assert.equal(def.include5h, false);

  const clamped = sanitizeAutoQuotaConfig(def, {
    enabled: true,
    intervalMinutes: 5,
    minTurns: -10,
    minSpendUsd: 25000,
    include5h: true,
    accountMode: 'fixed',
    accountId: 'acc_123',
  });
  assert.equal(clamped.enabled, true);
  assert.equal(clamped.intervalMinutes, 15);
  assert.equal(clamped.minTurns, 0);
  assert.equal(clamped.minSpendUsd, 10000);
  assert.equal(clamped.include5h, true);
  assert.equal(clamped.accountMode, 'fixed');
  assert.equal(clamped.accountId, 'acc_123');
});

test('resolveAgyCliPath supports Linux/macOS/Windows PATH, fallback dirs, and custom path', () => {
  // 1. POSIX PATH lookup
  const linuxFiles = new Set(['/home/user/.local/bin/agy']);
  const r1 = resolveAgyCliPath({
    platform: 'linux',
    env: { PATH: '/usr/bin:/home/user/.local/bin' },
    homeDir: '/home/user',
    fileExistsFn: (p) => linuxFiles.has(p),
  });
  assert.equal(r1, '/home/user/.local/bin/agy');

  // 2. macOS fallback when GUI launches with minimal PATH
  const macFiles = new Set(['/opt/homebrew/bin/agy']);
  const r2 = resolveAgyCliPath({
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    homeDir: '/Users/alice',
    fileExistsFn: (p) => macFiles.has(p),
  });
  assert.equal(r2, '/opt/homebrew/bin/agy');

  // 3. Windows .exe/.cmd lookup with semicolon PATH and fallback
  const winFiles = new Set(['C:\\Users\\bob\\AppData\\Local\\Programs\\Antigravity\\agy.exe']);
  const r3 = resolveAgyCliPath({
    platform: 'win32',
    env: {
      PATH: 'C:\\Windows\\System32',
      LOCALAPPDATA: 'C:\\Users\\bob\\AppData\\Local',
      PATHEXT: '.EXE;.CMD;.BAT',
    },
    homeDir: 'C:\\Users\\bob',
    fileExistsFn: (p) => winFiles.has(p),
  });
  assert.equal(r3, 'C:\\Users\\bob\\AppData\\Local\\Programs\\Antigravity\\agy.exe');

  // 4. Custom path takes top priority
  const r4 = resolveAgyCliPath({
    cliPath: '/custom/bin/agy',
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    fileExistsFn: (p) => p === '/custom/bin/agy',
  });
  assert.equal(r4, '/custom/bin/agy');

  // 5. OS-aware install guidance
  assert.match(getInstallGuidance('win32').command, /install\.ps1/);
  assert.equal(getInstallGuidance('win32').shellLabel, 'PowerShell');
  assert.match(getInstallGuidance('linux').command, /install\.sh/);
  assert.equal(getInstallGuidance('darwin').shellLabel, 'Terminal');
});

test('parseAgyUsageOutput parses official JSON, keyed map, tabular text, TUI text, and rejects LLM turns', () => {
  const nowMs = Date.parse('2026-11-27T08:00:00Z');

  // Layer 1: official JSON schema (observed on agy 1.5.18)
  const officialJson = JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    num_turns: 0,
    usage: { total_tokens: 0 },
    command: {
      name: 'usage',
      data: {
        email: 'alice@example.com',
        groups: [
          {
            id: 'gemini',
            name: 'Gemini',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.6823567, reset_time: '2026-12-03T07:39:04Z' },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.85, reset_time: '2026-11-27T12:30:00Z' },
            ],
          },
          {
            id: '3p',
            name: 'Claude & GPT',
            buckets: [
              { id: '3p-weekly', window: 'weekly', remaining_fraction: 0.92814, reset_time: '2026-12-03T08:00:00Z' },
              { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: null },
            ],
          },
        ],
      },
    },
  });
  const p1 = parseAgyUsageOutput(officialJson, '', nowMs);
  assert.equal(p1.ok, true);
  assert.equal(p1.layer, 'json');
  assert.equal(p1.email, 'alice@example.com');
  assert.equal(p1.buckets.length, 4);
  const g7 = p1.buckets.find((b) => b.pool === 'gemini' && b.windowType === '7d');
  assert.equal(g7.remainingPct, 68.24);
  assert.equal(g7.precisionStep, 0.01);
  assert.equal(g7.resetAt, Date.parse('2026-12-03T07:39:04Z'));
  assert.equal(g7.resetPrecisionMs, 1000);
  const g5 = p1.buckets.find((b) => b.pool === 'gemini' && b.windowType === '5h');
  assert.equal(g5.remainingPct, 85);
  assert.equal(g5.precisionStep, 0.01);

  // Layer 1 variant: keyed quota map
  const mapJson = JSON.stringify({
    status: 'SUCCESS',
    num_turns: 0,
    quota: {
      'gemini-weekly': { remaining_fraction: 0.5, reset_time: '2026-12-02T08:00:00Z' },
      'claude-weekly': { remaining_pct: 91.5, reset_time: '2026-12-02T09:00:00Z' },
    },
  });
  const p2 = parseAgyUsageOutput(mapJson, '', nowMs);
  assert.equal(p2.ok, true);
  assert.equal(p2.buckets.length, 2);
  assert.equal(p2.buckets.find((b) => b.pool === '3p').remainingPct, 91.5);

  // Layer 2: response tabular fallback
  const tabularJson = JSON.stringify({
    status: 'SUCCESS',
    num_turns: 0,
    response: [
      'Model Group   Window   Remaining   Resets',
      'Gemini        weekly   76.7%       in 5d 23h 14m',
      'Claude/GPT    weekly   98.1%       in 5d 21h 8m',
    ].join('\n'),
  });
  const p3 = parseAgyUsageOutput(tabularJson, '', nowMs);
  assert.equal(p3.ok, true);
  assert.equal(p3.layer, 'json_response_text');
  assert.equal(p3.buckets.length, 2);
  assert.equal(p3.buckets.find((b) => b.pool === 'gemini').remainingPct, 76.7);
  assert.equal(p3.buckets.find((b) => b.pool === 'gemini').precisionStep, 0.1);

  // Layer 2: TUI block text fallback (e.g. user-copied `/usage` text)
  const tuiText = `
Models & Quota
  Account: jerry@example.com

GEMINI MODELS
  Weekly Limit Remaining
    [████████████░░░░] 76.7%
    Refreshes in 5d 23h 14m

CLAUDE AND GPT MODELS
  Weekly Limit Remaining
    [███████████████░] 98.1%
    Refreshes in 5d 21h 8m
`;
  const p4 = parseAgyUsageOutput(tuiText, '', nowMs);
  assert.equal(p4.ok, true);
  assert.equal(p4.email, 'jerry@example.com');
  assert.equal(p4.buckets.length, 2);
  assert.equal(p4.buckets.find((b) => b.pool === 'gemini').remainingPct, 76.7);
  assert.equal(p4.buckets.find((b) => b.pool === '3p').remainingPct, 98.1);

  // Safety guard: reject LLM turn if num_turns > 0
  const llmTurn = JSON.stringify({
    status: 'SUCCESS',
    num_turns: 1,
    response: 'Gemini weekly 80%',
  });
  const p5 = parseAgyUsageOutput(llmTurn, '', nowMs);
  assert.equal(p5.ok, false);
  assert.equal(p5.layer, 'rejected_turn');
});

test('fetchAgyUsageRaw retries once without ALL_PROXY on proxy EOF error', async () => {
  let calls = 0;
  const seenEnvs = [];
  const res = await fetchAgyUsageRaw({
    cliPath: '/usr/local/bin/agy',
    platform: 'linux',
    env: {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'socks5h://127.0.0.1:7891',
    },
    fileExistsFn: () => true,
    execFileFn: async (_cmd, _args, opts) => {
      calls += 1;
      seenEnvs.push({ all: opts.env.ALL_PROXY, https: opts.env.HTTPS_PROXY });
      if (calls === 1) {
        const err = new Error('EOF');
        err.stderr = 'Get "https://www.googleapis.com/oauth2/v2/userinfo": EOF';
        throw err;
      }
      return { stdout: '{"status":"SUCCESS","num_turns":0}', stderr: '' };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
  assert.equal(seenEnvs[0].all, 'socks5h://127.0.0.1:7891');
  assert.equal(seenEnvs[1].all, undefined);
  assert.equal(seenEnvs[1].https, 'http://127.0.0.1:7890');
});

test('evaluateAutoQuotaGate enforces strict AND (cooldown + minTurns + minSpendUsd) and near-switch skip', () => {
  const dir = makeTempDataDir();
  try {
    const { db } = openTelemetryCacheDb(dir);
    const pricing = loadPricingState(dir);
    const nowMs = Date.parse('2026-11-27T12:00:00Z');
    const lastSyncAt = nowMs - 3 * 3600_000; // 3h ago (> 2h cooldown)
    const cfg = sanitizeAutoQuotaConfig(DEFAULT_AUTO_QUOTA_CONFIG, {
      enabled: true,
      intervalMinutes: 120,
      minTurns: 20,
      minSpendUsd: 3.0,
    });

    // 1. 0 turns -> below_min_turns
    const g0 = evaluateAutoQuotaGate(db, pricing, cfg, { lastSyncAt }, nowMs);
    assert.equal(g0.eligible, false);
    assert.equal(g0.reason, 'below_min_turns');

    // 2. 20 tiny turns (< $3) -> below_min_spend
    for (let i = 0; i < 20; i++) {
      insertSyntheticTurn(db, {
        completedAtMs: lastSyncAt + (i + 1) * 60_000,
        inputTokens: 1000,
        outputTokens: 200,
      });
    }
    const g1 = evaluateAutoQuotaGate(db, pricing, cfg, { lastSyncAt }, nowMs);
    assert.equal(g1.eligible, false);
    assert.equal(g1.newTurns, 20);
    assert.equal(g1.reason, 'below_min_spend');

    // 3. Add spend pushing total >= $3 -> eligible!
    insertSyntheticTurn(db, {
      completedAtMs: nowMs - 10_000,
      inputTokens: 800000,
      outputTokens: 300000,
    });
    const g2 = evaluateAutoQuotaGate(db, pricing, cfg, { lastSyncAt }, nowMs);
    assert.equal(g2.eligible, true);
    assert.equal(g2.reason, 'eligible');
    assert.ok(g2.newSpendUsd >= 3.0);

    // 4. Inside cooldown -> blocked even with high spend
    const g3 = evaluateAutoQuotaGate(db, pricing, cfg, { lastSyncAt: nowMs - 30 * 60_000 }, nowMs);
    assert.equal(g3.eligible, false);
    assert.equal(g3.reason, 'cooldown');

    // 5. Multi-account near-switch (+/-5m) -> near_switch skip
    const acc2 = createAccount(db, { name: 'Alt' }, nowMs - 600_000);
    const acc2Id = acc2.account?.id || acc2.id;
    addAccountSwitch(db, { source: 'cli', accountId: acc2Id, effectiveFromMs: nowMs - 2 * 60_000 }, nowMs);
    const g4 = evaluateAutoQuotaGate(db, pricing, cfg, { lastSyncAt }, nowMs);
    assert.equal(g4.eligible, false);
    assert.equal(g4.reason, 'near_switch');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyParsedQuotaBuckets records 7d only by default, protects precision, deduplicates zero-delta, and preserves manual reset priority', () => {
  const dir = makeTempDataDir();
  try {
    const { db } = openTelemetryCacheDb(dir);
    const pricing = loadPricingState(dir);
    const t0 = Date.parse('2026-11-27T08:00:00Z');
    const resetIso = Date.parse('2026-12-03T07:39:04Z');

    // Seed manual anchor with explicit 1s precision reset
    const manualReset = Date.parse('2026-12-03T07:40:00Z');
    addQuotaAnchor(
      db,
      {
        pool: 'gemini',
        windowType: '7d',
        remainingPct: 75.0,
        rawInput: '75.00',
        capturedAt: t0 - 3600_000,
        resetAt: manualReset,
        resetPrecisionMs: 1000,
        note: 'manual seed',
      },
      t0 - 3600_000
    );

    const parsed = {
      ok: true,
      email: '',
      buckets: [
        { pool: 'gemini', windowType: '7d', remainingPct: 68.24, precisionStep: 0.01, resetAt: resetIso, resetPrecisionMs: 1000 },
        { pool: 'gemini', windowType: '5h', remainingPct: 81.5, precisionStep: 0.01, resetAt: t0 + 3 * 3600_000, resetPrecisionMs: 1000 },
        { pool: '3p', windowType: '7d', remainingPct: 92.81, precisionStep: 0.01, resetAt: resetIso, resetPrecisionMs: 1000 },
      ],
    };

    // Default include5h=false inserts only 7d buckets
    const res1 = applyParsedQuotaBuckets(db, pricing, { enabled: true, include5h: false }, parsed, { nowMs: t0 });
    assert.equal(res1.inserted.length, 2);
    assert.ok(res1.inserted.every((x) => x.windowType === '7d'));

    // Check anchorSource and manual reset priority at equal precision (1000ms)
    const status = getQuotaStatus(db, pricing, {}, t0 + 1000);
    const gSum = status.summaries.find((s) => s.pool === 'gemini' && s.windowType === '7d');
    assert.equal(gSum.cycleResetAt, manualReset);
    assert.equal(gSum.latestAnchor.anchorSource, 'auto_agy_cli');
    assert.equal(gSum.latestAnchor.precisionStep, 0.01);

    // Zero-delta repeat skips both buckets
    const res2 = applyParsedQuotaBuckets(db, pricing, { enabled: true, include5h: false }, parsed, { nowMs: t0 + 60_000 });
    assert.equal(res2.inserted.length, 0);
    assert.equal(res2.skipped.filter((s) => s.reason === 'unchanged').length, 2);

    // Coarse integer (1.0%) auto bucket must NOT pollute 0.01% cycle
    const coarseParsed = {
      ok: true,
      email: '',
      buckets: [{ pool: 'gemini', windowType: '7d', remainingPct: 64, precisionStep: 1, resetAt: resetIso, resetPrecisionMs: 60_000 }],
    };
    const res3 = applyParsedQuotaBuckets(db, pricing, { enabled: true }, coarseParsed, { nowMs: t0 + 120_000 });
    assert.equal(res3.inserted.length, 0);
    assert.equal(res3.skipped[0].reason, 'coarse_precision_guard');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP routes serve auto-quota status, probe, sync and enforce read-only guard', async () => {
  const dir = makeTempDataDir();
  const mockExec = async (_cmd, args) => {
    if (args.includes('--version')) {
      return { stdout: '1.5.18\n', stderr: '' };
    }
    return {
      stdout: JSON.stringify({
        status: 'SUCCESS',
        num_turns: 0,
        command: {
          name: 'usage',
          data: {
            groups: [
              {
                id: 'gemini',
                buckets: [
                  { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.7123, reset_time: new Date(Date.now() + 4 * 86400_000).toISOString() },
                ],
              },
            ],
          },
        },
      }),
      stderr: '',
    };
  };

  try {
    // 1. Writable runtime
    const rt = createLensRuntime({
      dataDir: dir,
      readOnly: false,
      autoQuotaOptions: {
        platform: 'linux',
        env: { PATH: '/usr/local/bin' },
        fileExistsFn: (p) => p === '/usr/local/bin/agy',
        execFileFn: mockExec,
      },
    });
    const routes = new Map();
    rt.registerRoutes((method, p, handler) => routes.set(`${method} ${p}`, handler));

    // Status when disabled must NOT spawn CLI probe
    const stDisabled = await routes.get('GET /api/auto-quota/status')({});
    assert.equal(stDisabled.config.enabled, false);
    assert.equal(stDisabled.cli, null);

    // Explicit probe returns CLI version
    const st = await routes.get('POST /api/auto-quota/probe')({});
    assert.equal(st.cli.installed, true);
    assert.equal(st.cli.version, '1.5.18');

    const syncRes = await routes.get('POST /api/auto-quota/sync')({});
    assert.equal(syncRes.syncResult.ok, true);
    assert.equal(syncRes.syncResult.inserted.length, 1);
    assert.equal(syncRes.syncResult.inserted[0].remainingPct, 71.23);
    assert.equal(syncRes.autoQuota.lastStatus, 'synced');
    rt.close();

    // 2. Read-only runtime blocks POST /api/auto-quota/sync and /probe with 403
    const roRt = createLensRuntime({
      dataDir: dir,
      readOnly: true,
      autoQuotaOptions: {
        platform: 'linux',
        env: { PATH: '/usr/local/bin' },
        fileExistsFn: (p) => p === '/usr/local/bin/agy',
        execFileFn: mockExec,
      },
    });
    const roRoutes = new Map();
    roRt.registerRoutes((method, p, handler) => roRoutes.set(`${method} ${p}`, handler));
    const blockedSync = await roRoutes.get('POST /api/auto-quota/sync')({});
    assert.equal(blockedSync.status, 403);
    const blockedProbe = await roRoutes.get('POST /api/auto-quota/probe')({});
    assert.equal(blockedProbe.status, 403);
    roRt.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
