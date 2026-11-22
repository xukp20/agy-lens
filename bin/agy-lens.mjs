#!/usr/bin/env node
/**
 * AGY Lens CLI entrypoint (zero external dependencies).
 * Subcommands:
 *   agy-lens serve [options]   Start standalone web dashboard (default)
 *   agy-lens status [options]  Print compact terminal telemetry & 7d quota summary
 *   agy-lens --version         Print version
 *   agy-lens --help            Print help
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isLoopbackHost,
  parseStandaloneArgs,
  parseStrictSources,
  printStandaloneHelp,
  startStandaloneServer,
} from '../sidecars/lens_panel/standalone.mjs';
import { createLensRuntime } from '../sidecars/lens_panel/lib/server_core.mjs';
import { getAnalytics, runIncrementalIndex } from '../sidecars/lens_panel/lib/indexer.mjs';
import { loadPricingState } from '../sidecars/lens_panel/lib/pricing.mjs';
import { getQuotaStatus } from '../sidecars/lens_panel/lib/quota.mjs';
import {
  addAccountSwitch,
  findAccountByIdOrName,
  listAccountsState,
  normalizeSwitchSource,
  parseSwitchAtArg,
  previewSwitchImpact,
} from '../sidecars/lens_panel/lib/accounts.mjs';
import { getRunningVersion } from '../sidecars/lens_panel/lib/updater.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');

function printTopHelp() {
  process.stdout.write(`AGY Lens CLI v${getRunningVersion(PLUGIN_ROOT)} — Local-first Antigravity Telemetry

Usage:
  agy-lens [serve] [options]          Start standalone local web UI (SSH / reverse-proxy ready)
  agy-lens status [options]           Print Today/7d API-eq. cost & 7d quota summary in terminal
  agy-lens switch <account> [options] Log a manual account switch (e.g. --scope cli --at -30m)
  agy-lens --version                  Print version
  agy-lens --help                     Show this help

Run \`agy-lens serve --help\` for server flags (--port, --host, --base-path, --token, --trust-proxy, --read-only).
Run \`agy-lens status [--json] [--account <id|name|all>] [--sources cli,desktop] [--data-dir <path>]\` for CLI summary.
Run \`agy-lens switch --help\` for manual switch logging options.
`);
}

function parseStatusArgs(argv) {
  const opts = { json: false, sources: null, dataDir: null, account: 'all', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--account') opts.account = next();
    else if (a.startsWith('--account=')) opts.account = a.slice(10);
    else if (a === '--sources') {
      opts.sources = parseStrictSources(next());
    } else if (a.startsWith('--sources=')) {
      opts.sources = parseStrictSources(a.slice(10));
    } else if (a === '--data-dir') opts.dataDir = next();
    else if (a.startsWith('--data-dir=')) opts.dataDir = a.slice(11);
    else throw new Error(`Unknown option for status: ${a}`);
  }
  return opts;
}

function parseSwitchArgs(argv) {
  const opts = {
    target: '',
    scope: 'all',
    at: 'now',
    note: '',
    dryRun: false,
    json: false,
    dataDir: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--scope' || a === '--source') opts.scope = normalizeSwitchSource(next());
    else if (a.startsWith('--scope=')) opts.scope = normalizeSwitchSource(a.slice(8));
    else if (a.startsWith('--source=')) opts.scope = normalizeSwitchSource(a.slice(9));
    else if (a === '--at') opts.at = next();
    else if (a.startsWith('--at=')) opts.at = a.slice(5);
    else if (a === '--note') opts.note = next();
    else if (a.startsWith('--note=')) opts.note = a.slice(7);
    else if (a === '--data-dir') opts.dataDir = next();
    else if (a.startsWith('--data-dir=')) opts.dataDir = a.slice(11);
    else if (!a.startsWith('-') && !opts.target) opts.target = a;
    else throw new Error(`Unknown option for switch: ${a}`);
  }
  return opts;
}

async function runSwitch(argv) {
  const opts = parseSwitchArgs(argv);
  if (opts.help || !opts.target) {
    process.stdout.write(`Usage: agy-lens switch <account-id-or-name> [options]

Options:
  --scope all|cli|desktop   Scope of switch (default: all)
  --at <time>               Effective time: now, -30m, -2h, or YYYY-MM-DD HH:mm (default: now)
  --note <text>             Optional note
  --dry-run                 Preview affected turns/conversations without writing
  --json                    Output JSON
  --data-dir <path>         Custom data directory
`);
    if (!opts.help && !opts.target) process.exitCode = 1;
    return;
  }

  const runtime = createLensRuntime({
    pluginRoot: PLUGIN_ROOT,
    dataDir: opts.dataDir,
    mode: 'standalone',
    readOnly: opts.dryRun,
  });
  try {
    const acc = findAccountByIdOrName(runtime.cacheDb, opts.target);
    if (!acc) {
      const avail = listAccountsState(runtime.cacheDb).activeAccounts.map((a) => `${a.name} (${a.id})`);
      throw new Error(`Account "${opts.target}" not found. Available: ${avail.join(', ')}`);
    }
    const nowMs = Date.now();
    const effectiveFromMs = parseSwitchAtArg(opts.at, nowMs);
    const preview = previewSwitchImpact(
      runtime.cacheDb,
      { accountId: acc.id, source: opts.scope, effectiveFromMs },
      nowMs
    );
    if (opts.dryRun) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ dryRun: true, account: acc, preview }, null, 2) + '\n');
      } else {
        process.stdout.write(
          `[dry-run] Would switch ${opts.scope} -> ${acc.name} (${acc.id}) from ${new Date(effectiveFromMs).toLocaleString()}\n`
        );
        process.stdout.write(
          `  Impact: ${preview.affectedTurns} turns across ${preview.affectedConversations} conversations\n`
        );
      }
      return;
    }

    const res = addAccountSwitch(
      runtime.cacheDb,
      { accountId: acc.id, source: opts.scope, effectiveFromMs, note: opts.note },
      nowMs
    );
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, account: acc, switchEntry: res.switchEntry, preview }, null, 2) + '\n');
    } else {
      process.stdout.write(
        `Logged switch #${res.switchEntry.id}: ${opts.scope} -> ${acc.name} (${acc.id}) effective ${new Date(effectiveFromMs).toLocaleString()}\n`
      );
      if (preview.affectedTurns > 0) {
        process.stdout.write(
          `  Re-attributed: ${preview.affectedTurns} turns across ${preview.affectedConversations} conversations\n`
        );
      }
    }
  } finally {
    runtime.close();
  }
}

function fmtUsd(v) {
  const n = Number(v || 0);
  return `$${n.toFixed(2)}`;
}

async function runStatus(argv) {
  const opts = parseStatusArgs(argv);
  if (opts.help) {
    process.stdout.write('Usage: agy-lens status [--json] [--sources cli,desktop] [--data-dir <path>]\n');
    return;
  }
  const runtime = createLensRuntime({
    pluginRoot: PLUGIN_ROOT,
    dataDir: opts.dataDir,
    mode: 'standalone',
    readOnly: true,
    sourcesOverride: opts.sources,
  });
  try {
    const cfg = runtime.loadConfig();
    const sources = runtime.enabledSourcesList(cfg, null);
    runIncrementalIndex(runtime.cacheDb, { sources });
    const pricingState = loadPricingState(runtime.dataDir);
    let accountId = 'all';
    let accountLabel = 'all';
    if (opts.account && opts.account.toLowerCase() !== 'all') {
      const found = findAccountByIdOrName(runtime.cacheDb, opts.account);
      if (!found) {
        throw new Error(`Account "${opts.account}" not found`);
      }
      accountId = found.id;
      accountLabel = found.name;
    }
    const today = getAnalytics(runtime.cacheDb, pricingState, {
      range: 'today',
      sources,
      modules: new Set(['model-cost']),
      accountId,
    });
    const week = getAnalytics(runtime.cacheDb, pricingState, {
      range: '7d',
      sources,
      modules: new Set(['model-cost']),
      accountId,
    });
    const quota = getQuotaStatus(runtime.cacheDb, pricingState, {
      windowType: '7d',
      quotaAnchorsByPool: cfg.quotaAnchorsByPool || {},
      quotaCalibMode: cfg.quotaCalibMode || 'auto',
      quotaManualFactors: cfg.quotaManualFactors || { M: false, C: false, O: false },
      accountId,
    });

    const sumTurns = (mc) => (mc?.models || []).reduce((acc, m) => acc + Number(m.turns || 0), 0);
    const mapQuotaSummaries = (sums) =>
      sums.map((s) => ({
        pool: s.pool,
        cycleState: s.cycleState,
        cycleExpired: s.cycleExpired,
        cycleSpendUsd: s.cycleSpendUsd,
        remainingPct: s.cycleExpired ? null : (s.projectedRemainingPct ?? s.latestAnchor?.remainingPct ?? null),
        estimatedPoolUsd: s.cycleExpired
          ? s.previousCycleEstimation?.estimatedPoolUsd ?? null
          : s.estimation?.estimatedPoolUsd ?? null,
      }));

    const payload = {
      version: runtime.runningVersion,
      sources,
      accountId,
      today: {
        costUsd: today.modelCost?.totalCostUsd || 0,
        cacheSavedUsd: today.modelCost?.cacheSavedUsd || 0,
        turns: sumTurns(today.modelCost),
      },
      last7d: {
        costUsd: week.modelCost?.totalCostUsd || 0,
        cacheSavedUsd: week.modelCost?.cacheSavedUsd || 0,
        turns: sumTurns(week.modelCost),
      },
      quota7d: mapQuotaSummaries(quota.summaries),
      quota7dByAccount: Array.isArray(quota.byAccount)
        ? quota.byAccount.map((entry) => ({
            accountId: entry.account.id,
            accountName: entry.account.name,
            quota7d: mapQuotaSummaries(entry.summaries),
          }))
        : undefined,
    };

    if (opts.json) {
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      return;
    }

    const accSuffix = accountId !== 'all' ? ` · account=${accountLabel}` : '';
    process.stdout.write(`AGY Lens v${payload.version} (${sources.join('+') || 'none'}${accSuffix})\n`);
    process.stdout.write(
      `  Today : ${fmtUsd(payload.today.costUsd)} API-eq. (${payload.today.turns} turns, saved ${fmtUsd(payload.today.cacheSavedUsd)})\n`
    );
    process.stdout.write(
      `  7d    : ${fmtUsd(payload.last7d.costUsd)} API-eq. (${payload.last7d.turns} turns, saved ${fmtUsd(payload.last7d.cacheSavedUsd)})\n`
    );
    if (Array.isArray(payload.quota7dByAccount)) {
      for (const accEntry of payload.quota7dByAccount) {
        const activePools = accEntry.quota7d.filter((q) => q.cycleState !== 'no_data');
        if (activePools.length === 0) continue;
        process.stdout.write(`  [Account: ${accEntry.accountName}]\n`);
        for (const q of activePools) {
          const pctStr = q.remainingPct != null ? `${q.remainingPct.toFixed(1)}% left` : q.cycleExpired ? 'new cycle (no snapshot)' : '—';
          const estStr = q.estimatedPoolUsd != null ? ` · est ~${fmtUsd(q.estimatedPoolUsd)}` : '';
          process.stdout.write(`    7d ${q.pool.padEnd(6)}: ${pctStr} · cycle spent ${fmtUsd(q.cycleSpendUsd)}${estStr}\n`);
        }
      }
    } else {
      for (const q of payload.quota7d) {
        if (q.cycleState === 'no_data') continue;
        const pctStr = q.remainingPct != null ? `${q.remainingPct.toFixed(1)}% left` : q.cycleExpired ? 'new cycle (no snapshot)' : '—';
        const estStr = q.estimatedPoolUsd != null ? ` · est ~${fmtUsd(q.estimatedPoolUsd)}` : '';
        process.stdout.write(`  7d ${q.pool.padEnd(6)}: ${pctStr} · cycle spent ${fmtUsd(q.cycleSpendUsd)}${estStr}\n`);
      }
    }
  } finally {
    runtime.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const first = args[0] || '';
  if (first === '-v' || first === '--version') {
    process.stdout.write(`${getRunningVersion(PLUGIN_ROOT)}\n`);
    return;
  }
  if (first === '-h' || first === '--help' || first === 'help') {
    printTopHelp();
    return;
  }
  if (first === 'status') {
    await runStatus(args.slice(1));
    return;
  }
  if (first === 'switch') {
    await runSwitch(args.slice(1));
    return;
  }
  const serveArgs = first === 'serve' ? args.slice(1) : args;
  const opts = parseStandaloneArgs(serveArgs);
  if (opts.help) {
    printStandaloneHelp();
    return;
  }
  const handle = await startStandaloneServer(opts);
  process.stdout.write(`[agy-lens] v${handle.runtime.runningVersion} standalone server listening on ${handle.url}\n`);
  process.stdout.write(`[agy-lens] dataDir=${handle.runtime.dataDir} readOnly=${handle.readOnly}\n`);
  if (handle.authRequired) {
    if (handle.autoGeneratedToken) {
      process.stdout.write(`[agy-lens] auth enabled (auto-generated token)\n`);
      process.stdout.write(`[agy-lens] login URL: ${handle.url}?token=${encodeURIComponent(handle.token)}\n`);
    } else {
      process.stdout.write(`[agy-lens] auth enabled (using configured token)\n`);
    }
  } else if (isLoopbackHost(handle.host)) {
    process.stdout.write(`[agy-lens] SSH tunnel hint: ssh -L ${handle.port}:127.0.0.1:${handle.port} <user>@<host>\n`);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[agy-lens] error: ${err?.message || err}\n`);
  process.exit(1);
});
