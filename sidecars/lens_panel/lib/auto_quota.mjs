/**
 * Cross-platform opt-in automatic quota alignment via official Antigravity CLI (`agy`).
 *
 * Design principles:
 * - Opt-in only (disabled by default); strictly zero background calls unless enabled.
 * - Never touches OAuth credentials, never probes undocumented local RPC services.
 * - Uses official `agy -p "/usage" --output-format json` (0 model tokens, 0 conversation DBs).
 * - Cross-platform binary resolution & safe `execFile` invocation (`windowsHide: true`,
 *   `cwd: os.tmpdir()`, no shell interpolation).
 * - Multi-layer resilient parser (JSON primary + tabular/TUI text fallback + strict num_turns===0 guard).
 * - Activity-gated (cooldown AND minTurns AND minSpendUsd) + high-precision cycle protection.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DEFAULT_ACCOUNT_ID,
  buildTurnAccountSql,
  hasAccountSchema,
  listAccountsState,
  resolveActiveAccountAt,
} from './accounts.mjs';
import { calculateTurnCost, writeJsonAtomic } from './pricing.mjs';
import { addQuotaAnchor, getQuotaStatus } from './quota.mjs';

const execFileAsync = promisify(execFile);

const STATE_FILENAME = 'auto_quota_state.json';
const VALID_PROVIDERS = new Set(['agy_cli']);
const VALID_ACCOUNT_MODES = new Set(['timeline', 'fixed']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERSION_RE = /\b(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/;

export const DEFAULT_AUTO_QUOTA_CONFIG = {
  enabled: false,
  provider: 'agy_cli',
  cliPath: '',
  intervalMinutes: 120,
  minTurns: 20,
  minSpendUsd: 3,
  include5h: false,
  accountMode: 'timeline', // 'timeline' | 'fixed'
  accountId: '',
};

export function sanitizeAutoQuotaConfig(baseCfg, patchCfg) {
  const b =
    baseCfg && typeof baseCfg === 'object'
      ? { ...DEFAULT_AUTO_QUOTA_CONFIG, ...baseCfg }
      : { ...DEFAULT_AUTO_QUOTA_CONFIG };
  const p = patchCfg && typeof patchCfg === 'object' ? patchCfg : {};

  const clampNum = (raw, fallback, min, max, integer = false) => {
    const n = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : fallback;
    if (!Number.isFinite(n)) return fallback;
    const clamped = Math.max(min, Math.min(max, n));
    return integer ? Math.round(clamped) : Math.round(clamped * 100) / 100;
  };

  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : Boolean(b.enabled),
    provider:
      typeof p.provider === 'string' && VALID_PROVIDERS.has(p.provider)
        ? p.provider
        : VALID_PROVIDERS.has(b.provider)
          ? b.provider
          : 'agy_cli',
    cliPath:
      typeof p.cliPath === 'string'
        ? p.cliPath.trim().slice(0, 320)
        : typeof b.cliPath === 'string'
          ? b.cliPath.trim().slice(0, 320)
          : '',
    intervalMinutes: clampNum(p.intervalMinutes, b.intervalMinutes, 15, 1440, true),
    minTurns: clampNum(p.minTurns, b.minTurns, 0, 10000, true),
    minSpendUsd: clampNum(p.minSpendUsd, b.minSpendUsd, 0, 10000, false),
    include5h: typeof p.include5h === 'boolean' ? p.include5h : Boolean(b.include5h),
    accountMode:
      typeof p.accountMode === 'string' && VALID_ACCOUNT_MODES.has(p.accountMode)
        ? p.accountMode
        : VALID_ACCOUNT_MODES.has(b.accountMode)
          ? b.accountMode
          : 'timeline',
    accountId:
      typeof p.accountId === 'string'
        ? p.accountId.trim().slice(0, 48)
        : typeof b.accountId === 'string'
          ? b.accountId.trim().slice(0, 48)
          : '',
  };
}

function isExecutableFile(filePath, platform = process.platform) {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    if (platform !== 'win32') {
      accessSync(filePath, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function expandHome(rawPath, homeDir = os.homedir(), platform = process.platform) {
  if (!rawPath) return '';
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  if (rawPath === '~') return homeDir;
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return pathMod.join(homeDir, rawPath.slice(2));
  }
  return rawPath;
}

/**
 * Cross-platform resolution for the official Antigravity CLI executable (`agy`).
 */
export function resolveAgyCliPath({
  cliPath = '',
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  fileExistsFn = isExecutableFile,
} = {}) {
  const isWin = platform === 'win32';
  const pathMod = isWin ? path.win32 : path.posix;
  const custom = expandHome(String(cliPath || '').trim(), homeDir, platform);
  if (custom) {
    return fileExistsFn(custom, platform) ? custom : '';
  }

  const names = isWin ? ['agy.exe', 'agy.cmd', 'agy.bat'] : ['agy'];
  const pathEnv = env?.PATH || env?.Path || '';
  const sep = isWin ? ';' : ':';
  const seen = new Set();

  for (const dir of pathEnv.split(sep)) {
    const cleanDir = dir.trim().replace(/^"|"$/g, '');
    if (!cleanDir) continue;
    for (const name of names) {
      const candidate = pathMod.join(cleanDir, name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (fileExistsFn(candidate, platform)) return candidate;
    }
  }

  // Standard fallback install directories (important when GUI Desktop sidecars inherit a minimal PATH).
  const fallbacks = isWin
    ? [
        pathMod.join(homeDir, '.local', 'bin', 'agy.exe'),
        env?.LOCALAPPDATA ? pathMod.join(env.LOCALAPPDATA, 'Antigravity', 'agy.exe') : '',
        env?.LOCALAPPDATA ? pathMod.join(env.LOCALAPPDATA, 'Programs', 'Antigravity', 'agy.exe') : '',
        env?.LOCALAPPDATA ? pathMod.join(env.LOCALAPPDATA, 'Programs', 'antigravity', 'agy.exe') : '',
        pathMod.join(homeDir, '.antigravity', 'bin', 'agy.exe'),
      ]
    : [
        pathMod.join(homeDir, '.local', 'bin', 'agy'),
        '/opt/homebrew/bin/agy',
        '/usr/local/bin/agy',
        pathMod.join(homeDir, '.antigravity', 'bin', 'agy'),
      ];

  for (const candidate of fallbacks) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (fileExistsFn(candidate, platform)) return candidate;
  }

  return '';
}

export function getInstallGuidance(platform = process.platform) {
  if (platform === 'win32') {
    return {
      platform,
      shellLabel: 'PowerShell',
      command: 'irm https://antigravity.google/cli/install.ps1 | iex',
      altCommand: 'curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd',
      loginCommand: 'agy',
      docsUrl: 'https://antigravity.google/docs/getting-started?tab=cli',
    };
  }
  return {
    platform,
    shellLabel: 'Terminal',
    command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    altCommand: '',
    loginCommand: 'agy',
    docsUrl: 'https://antigravity.google/docs/getting-started?tab=cli',
  };
}

async function execCliBinary(binaryPath, args, { timeoutMs = 15000, env = process.env, platform = process.platform, execFileFn = execFileAsync } = {}) {
  const isWinCmd = platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath);
  if (isWinCmd && /[&|<>^()%!"]/.test(binaryPath)) {
    throw new Error('Unsafe characters in Windows .cmd/.bat CLI path');
  }
  const cmd = isWinCmd ? env.ComSpec || env.COMSPEC || 'cmd.exe' : binaryPath;
  const cmdArgs = isWinCmd ? ['/d', '/s', '/c', binaryPath, ...args] : args;
  return execFileFn(cmd, cmdArgs, {
    cwd: os.tmpdir(),
    env,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
  });
}

export async function probeAgyCli({
  cliPath = '',
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  fileExistsFn = isExecutableFile,
  execFileFn = execFileAsync,
} = {}) {
  const resolved = resolveAgyCliPath({ cliPath, env, platform, homeDir, fileExistsFn });
  if (!resolved) {
    return {
      ok: false,
      installed: false,
      status: 'not_installed',
      cliPath: '',
      version: '',
      platform,
      error: cliPath ? `Specified agy CLI path not found or not executable: ${cliPath}` : 'agy CLI not found',
    };
  }

  try {
    const res = await execCliBinary(resolved, ['--version'], {
      timeoutMs: 8000,
      env,
      platform,
      execFileFn,
    });
    const text = `${res?.stdout || ''}\n${res?.stderr || ''}`.trim();
    const m = text.match(VERSION_RE);
    return {
      ok: true,
      installed: true,
      status: 'ready',
      cliPath: resolved,
      version: m ? m[1] : text.slice(0, 32),
      platform,
      error: '',
    };
  } catch (err) {
    return {
      ok: false,
      installed: true,
      status: 'cli_error',
      cliPath: resolved,
      version: '',
      platform,
      error: (err?.stderr || err?.message || 'Failed to run agy --version').toString().trim().slice(0, 240),
    };
  }
}

export function classifyCliError(err, stdout = '', stderr = '') {
  const combined = `${stderr || ''}\n${stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`.trim();
  const low = combined.toLowerCase();
  if (err?.code === 'ENOENT') {
    return { code: 'not_installed', message: 'agy CLI executable not found' };
  }
  if (err?.killed || err?.code === 'ETIMEDOUT' || low.includes('timed out') || low.includes('interrupted')) {
    return { code: 'timeout', message: 'agy /usage timed out' };
  }
  if (
    /unauthenticated|not logged in|please log ?in|sign in|login required|no credentials|invalid_grant|token expired|oauth.*401|status 401/i.test(
      combined
    )
  ) {
    return { code: 'not_authenticated', message: 'agy CLI is not logged in; run `agy` in a terminal to sign in' };
  }
  if (/eof|econnrefused|enotfound|ehostunreach|dial tcp|proxy|tls|certificate|network|connection reset/i.test(combined)) {
    return { code: 'network_error', message: combined.split('\n').filter(Boolean)[0]?.slice(0, 200) || 'Network error' };
  }
  return {
    code: 'cli_error',
    message: combined.split('\n').filter(Boolean)[0]?.slice(0, 200) || 'agy /usage failed',
  };
}

function shouldRetryWithoutAllProxy(env, err, stdout, stderr) {
  const hasAllProxy = Boolean(env?.ALL_PROXY || env?.all_proxy);
  const hasHttpProxy = Boolean(env?.HTTPS_PROXY || env?.https_proxy || env?.HTTP_PROXY || env?.http_proxy);
  if (!hasAllProxy || !hasHttpProxy) return false;
  const combined = `${stderr || ''}\n${stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`;
  return /eof|socks|proxy/i.test(combined);
}

/**
 * Execute `agy -p "/usage" --output-format json --print-timeout 12s` safely.
 */
export async function fetchAgyUsageRaw({
  cliPath = '',
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  fileExistsFn = isExecutableFile,
  execFileFn = execFileAsync,
} = {}) {
  const resolved = resolveAgyCliPath({ cliPath, env, platform, homeDir, fileExistsFn });
  if (!resolved) {
    return {
      ok: false,
      code: 'not_installed',
      cliPath: '',
      stdout: '',
      stderr: '',
      error: 'agy CLI not found',
    };
  }

  const args = ['-p', '/usage', '--output-format', 'json', '--print-timeout', '12s'];
  try {
    const res = await execCliBinary(resolved, args, {
      timeoutMs: 18000,
      env,
      platform,
      execFileFn,
    });
    return {
      ok: true,
      code: 'ok',
      cliPath: resolved,
      stdout: String(res?.stdout || ''),
      stderr: String(res?.stderr || ''),
      error: '',
    };
  } catch (err) {
    const out1 = String(err?.stdout || '');
    const err1 = String(err?.stderr || '');
    if (shouldRetryWithoutAllProxy(env, err, out1, err1)) {
      const retryEnv = { ...env };
      delete retryEnv.ALL_PROXY;
      delete retryEnv.all_proxy;
      try {
        const res2 = await execCliBinary(resolved, args, {
          timeoutMs: 18000,
          env: retryEnv,
          platform,
          execFileFn,
        });
        return {
          ok: true,
          code: 'ok',
          cliPath: resolved,
          stdout: String(res2?.stdout || ''),
          stderr: String(res2?.stderr || ''),
          error: '',
        };
      } catch (err2) {
        const classified = classifyCliError(err2, err2?.stdout, err2?.stderr);
        return {
          ok: false,
          code: classified.code,
          cliPath: resolved,
          stdout: String(err2?.stdout || ''),
          stderr: String(err2?.stderr || ''),
          error: classified.message,
        };
      }
    }
    const classified = classifyCliError(err, out1, err1);
    return {
      ok: false,
      code: classified.code,
      cliPath: resolved,
      stdout: out1,
      stderr: err1,
      error: classified.message,
    };
  }
}

// =========================================================================
// Resilient 3-Layer `/usage` Parser
// =========================================================================

function normalizePoolHint(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return null;
  if (/\b3p\b|third[-_\s]?party|claude|anthropic|gpt|openai|oss/.test(s)) return '3p';
  if (/gemini|google|argon|neon|carbon|hydrogen|flash/.test(s)) return 'gemini';
  return null;
}

function normalizeWindowHint(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return null;
  if (/\bweekly\b|\b7d\b|7[-_\s]?day|week/.test(s)) return '7d';
  if (/\b5h\b|five[-_\s]?hour|5[-_\s]?hour|5hr/.test(s)) return '5h';
  return null;
}

function parseDurationToResetMs(text, nowMs) {
  const s = String(text || '');
  const dMatch = s.match(/(\d+)\s*(?:days?|d\b|天)/i);
  const hMatch = s.match(/(\d+)\s*(?:hours?|hrs?|h\b|小时|时)/i);
  const mMatch = s.match(/(\d+)\s*(?:minutes?|mins?|m\b|分钟|分)/i);
  if (!dMatch && !hMatch && !mMatch) return null;
  const days = dMatch ? Number(dMatch[1]) : 0;
  const hours = hMatch ? Number(hMatch[1]) : 0;
  const mins = mMatch ? Number(mMatch[1]) : 0;
  const deltaMs = ((days * 24 + hours) * 60 + mins) * 60_000;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return null;
  let resetPrecisionMs = 5 * 60_000;
  if (!mMatch && hMatch) resetPrecisionMs = 60 * 60_000;
  else if (!mMatch && !hMatch && dMatch) resetPrecisionMs = 24 * 60 * 60_000;
  return {
    resetAt: Math.round(nowMs + deltaMs),
    resetPrecisionMs,
  };
}

function parseResetField(bucket, nowMs) {
  const isoCandidate =
    bucket?.reset_time ?? bucket?.resetTime ?? bucket?.refreshes_at ?? bucket?.refreshesAt ?? null;
  if (typeof isoCandidate === 'string' && isoCandidate.trim()) {
    const parsed = Date.parse(isoCandidate.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return { resetAt: Math.round(parsed), resetPrecisionMs: 1000 };
    }
  } else if (typeof isoCandidate === 'number' && Number.isFinite(isoCandidate) && isoCandidate > 1e12) {
    return { resetAt: Math.round(isoCandidate), resetPrecisionMs: 1000 };
  }

  const secCandidate = bucket?.reset_in_seconds ?? bucket?.resetInSeconds;
  if (secCandidate !== undefined && secCandidate !== null && Number.isFinite(Number(secCandidate))) {
    const sec = Number(secCandidate);
    if (sec > 0) {
      return { resetAt: Math.round(nowMs + sec * 1000), resetPrecisionMs: 60_000 };
    }
  }

  if (typeof bucket?.description === 'string' && bucket.description) {
    return parseDurationToResetMs(bucket.description, nowMs);
  }
  return null;
}

function detectDecimalPrecisionStep(rawVal) {
  const s = String(rawVal ?? '').trim().replace(/%$/, '');
  const m = s.match(/\.(\d+)/);
  if (!m) return 1;
  return m[1].length >= 2 ? 0.01 : 0.1;
}

function parseRemainingField(bucket) {
  const fracRaw =
    bucket?.remaining_fraction ??
    bucket?.remainingFraction ??
    bucket?.remaining_ratio ??
    bucket?.remainingRatio;
  if (fracRaw !== undefined && fracRaw !== null && fracRaw !== '') {
    const f = Number(fracRaw);
    if (Number.isFinite(f) && f >= 0 && f <= 1.0001) {
      const clamped = Math.max(0, Math.min(1, f));
      return {
        remainingPct: Math.round(clamped * 10000) / 100,
        precisionStep: 0.01,
      };
    }
  }

  const pctRaw =
    bucket?.remaining_pct ??
    bucket?.remainingPct ??
    bucket?.remaining_percent ??
    bucket?.remainingPercent;
  if (pctRaw !== undefined && pctRaw !== null && pctRaw !== '') {
    const n = Number(pctRaw);
    if (Number.isFinite(n) && n >= 0 && n <= 100) {
      return {
        remainingPct: Math.round(n * 100) / 100,
        precisionStep: detectDecimalPrecisionStep(pctRaw),
      };
    }
  }
  return null;
}

function extractEmailFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const candidates = [
    obj?.command?.data?.account,
    obj?.command?.data?.email,
    obj?.command?.data?.user?.email,
    obj?.data?.account,
    obj?.data?.email,
    obj?.account,
    obj?.email,
    obj?.user_email,
    obj?.user?.email,
  ];
  for (const c of candidates) {
    if (typeof c === 'string') {
      const cleaned = c.trim().toLowerCase();
      if (EMAIL_RE.test(cleaned)) return cleaned;
    }
  }
  return '';
}

function extractJsonObject(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to tolerant extraction
  }

  // Try lines from the end (handles leading warning/status lines before JSON payload).
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // continue
    }
  }

  // Last resort: outermost braces slice.
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(raw.slice(first, last + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
  }
  return null;
}

function parseTextFallbackBuckets(text, nowMs) {
  const buckets = [];
  const raw = String(text || '');
  if (!raw.trim()) return { buckets, email: '' };

  let email = '';
  const emailMatch = raw.match(/Account:\s*([^\s@]+@[^\s@]+\.[^\s@]+)/i);
  if (emailMatch && EMAIL_RE.test(emailMatch[1].trim().toLowerCase())) {
    email = emailMatch[1].trim().toLowerCase();
  }

  // Format A: Tabular / single-line format (`Gemini Models   Weekly Limit Remaining   68%   2026-12-03T07:39:04Z`)
  const lines = raw.split(/\r?\n/);
  let currentPool = null;
  let currentWin = null;
  let pendingPct = null;

  const flushPending = (resetInfo) => {
    if (currentPool && currentWin && pendingPct) {
      buckets.push({
        pool: currentPool,
        windowType: currentWin,
        remainingPct: pendingPct.remainingPct,
        precisionStep: pendingPct.precisionStep,
        resetAt: resetInfo?.resetAt ?? null,
        resetPrecisionMs: resetInfo?.resetPrecisionMs ?? null,
        sourceLayer: 'text',
      });
    }
    pendingPct = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Single-line tabular match: pool + window + pct + optional timestamp
    const pctInline = line.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%/);
    const poolInline = normalizePoolHint(line);
    const winInline = normalizeWindowHint(line);

    if (poolInline && winInline && pctInline) {
      flushPending(null);
      const val = Number(pctInline[1]);
      if (Number.isFinite(val) && val >= 0 && val <= 100) {
        let resetInfo = null;
        const isoM = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/);
        const localM = line.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s*(?:[+-]\d{2}(?::?\d{2})?|Z)?/);
        if (isoM) {
          const ts = Date.parse(isoM[0]);
          if (Number.isFinite(ts) && ts > 0) resetInfo = { resetAt: Math.round(ts), resetPrecisionMs: 1000 };
        } else if (localM) {
          const normalized = localM[0]
            .trim()
            .replace(/\s+/, 'T')
            .replace(/\s+([+-]\d{2})(?::?(\d{2}))?$/, (_, h, m) => `${h}:${m || '00'}`)
            .replace(/\s+Z$/, 'Z');
          const ts = Date.parse(normalized);
          if (Number.isFinite(ts) && ts > 0) resetInfo = { resetAt: Math.round(ts), resetPrecisionMs: 60_000 };
        }
        buckets.push({
          pool: poolInline,
          windowType: winInline,
          remainingPct: Math.round(val * 100) / 100,
          precisionStep: detectDecimalPrecisionStep(pctInline[1]),
          resetAt: resetInfo?.resetAt ?? null,
          resetPrecisionMs: resetInfo?.resetPrecisionMs ?? null,
          sourceLayer: 'text',
        });
      }
      continue;
    }

    // Multi-line TUI block match
    if (poolInline && !winInline && !pctInline && /models?|group/i.test(line)) {
      flushPending(null);
      currentPool = poolInline;
      currentWin = null;
      continue;
    }
    if (winInline && !pctInline) {
      flushPending(null);
      currentWin = winInline;
      continue;
    }
    if (currentPool && currentWin && pctInline && !pendingPct) {
      const val = Number(pctInline[1]);
      if (Number.isFinite(val) && val >= 0 && val <= 100) {
        pendingPct = {
          remainingPct: Math.round(val * 100) / 100,
          precisionStep: detectDecimalPrecisionStep(pctInline[1]),
        };
      }
      continue;
    }
    if (pendingPct && /refresh|reset|available/i.test(line)) {
      const resetInfo = parseDurationToResetMs(line, nowMs);
      flushPending(resetInfo);
      continue;
    }
  }
  flushPending(null);

  return { buckets, email };
}

function dedupeParsedBuckets(buckets) {
  const byKey = new Map();
  for (const b of buckets) {
    if (!b || (b.pool !== 'gemini' && b.pool !== '3p')) continue;
    if (b.windowType !== '7d' && b.windowType !== '5h') continue;
    if (!Number.isFinite(b.remainingPct) || b.remainingPct < 0 || b.remainingPct > 100) continue;
    const key = `${b.pool}|${b.windowType}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, b);
      continue;
    }
    // Prefer finer precision, then presence of resetAt.
    if (
      b.precisionStep < prev.precisionStep ||
      (b.precisionStep === prev.precisionStep && b.resetAt != null && prev.resetAt == null)
    ) {
      byKey.set(key, b);
    }
  }
  return [...byKey.values()];
}

/**
 * Parse output from `agy -p "/usage" --output-format json` (or text fallback).
 */
export function parseAgyUsageOutput(stdout, stderr = '', nowMs = Date.now()) {
  const json = extractJsonObject(stdout);

  if (json) {
    // Safety gate: never accept an LLM-generated turn if `/usage` stopped being a built-in command.
    if (json.num_turns != null && Number(json.num_turns) > 0) {
      return {
        ok: false,
        code: 'parse_error',
        error: 'agy /usage executed a model turn instead of the built-in quota command; aborted for safety',
        buckets: [],
        email: '',
        layer: 'rejected_turn',
      };
    }
    if (typeof json.status === 'string' && json.status.toUpperCase() !== 'SUCCESS') {
      const classified = classifyCliError(null, json.error || json.response || '', stderr);
      return {
        ok: false,
        code: classified.code,
        error: String(json.error || classified.message).slice(0, 200),
        buckets: [],
        email: '',
        layer: 'json_error',
      };
    }

    const email = extractEmailFromObject(json);
    const extracted = [];

    // Path 1: groups[].buckets[] (current official schema: command.data.groups)
    const groups =
      json?.command?.data?.groups ??
      json?.data?.groups ??
      json?.groups ??
      null;
    if (Array.isArray(groups)) {
      for (const grp of groups) {
        const grpPool = normalizePoolHint(`${grp?.id || ''} ${grp?.name || ''} ${grp?.description || ''}`);
        const grpBuckets = Array.isArray(grp?.buckets) ? grp.buckets : [];
        for (const b of grpBuckets) {
          const pool = normalizePoolHint(`${b?.id || ''} ${b?.pool || ''}`) || grpPool;
          const windowType = normalizeWindowHint(`${b?.window || ''} ${b?.id || ''} ${b?.name || ''}`);
          const rem = parseRemainingField(b);
          if (!pool || !windowType || !rem) continue;
          const resetInfo = parseResetField(b, nowMs);
          extracted.push({
            pool,
            windowType,
            remainingPct: rem.remainingPct,
            precisionStep: rem.precisionStep,
            resetAt: resetInfo?.resetAt ?? null,
            resetPrecisionMs: resetInfo?.resetPrecisionMs ?? null,
            sourceLayer: 'json',
          });
        }
      }
    }

    // Path 2: flat buckets array
    const flatBuckets = json?.command?.data?.buckets ?? json?.data?.buckets ?? json?.buckets ?? null;
    if (extracted.length === 0 && Array.isArray(flatBuckets)) {
      for (const b of flatBuckets) {
        const pool = normalizePoolHint(`${b?.id || ''} ${b?.pool || ''} ${b?.group || ''} ${b?.name || ''}`);
        const windowType = normalizeWindowHint(`${b?.window || ''} ${b?.id || ''} ${b?.name || ''}`);
        const rem = parseRemainingField(b);
        if (!pool || !windowType || !rem) continue;
        const resetInfo = parseResetField(b, nowMs);
        extracted.push({
          pool,
          windowType,
          remainingPct: rem.remainingPct,
          precisionStep: rem.precisionStep,
          resetAt: resetInfo?.resetAt ?? null,
          resetPrecisionMs: resetInfo?.resetPrecisionMs ?? null,
          sourceLayer: 'json',
        });
      }
    }

    // Path 3: keyed quota map (e.g. `{ "gemini-weekly": { remaining_fraction, reset_time } }`)
    const quotaMap = json?.command?.data?.quota ?? json?.quota ?? null;
    if (extracted.length === 0 && quotaMap && typeof quotaMap === 'object' && !Array.isArray(quotaMap)) {
      for (const [k, b] of Object.entries(quotaMap)) {
        if (!b || typeof b !== 'object') continue;
        const pool = normalizePoolHint(`${k} ${b?.pool || ''}`);
        const windowType = normalizeWindowHint(`${k} ${b?.window || ''}`);
        const rem = parseRemainingField(b);
        if (!pool || !windowType || !rem) continue;
        const resetInfo = parseResetField(b, nowMs);
        extracted.push({
          pool,
          windowType,
          remainingPct: rem.remainingPct,
          precisionStep: rem.precisionStep,
          resetAt: resetInfo?.resetAt ?? null,
          resetPrecisionMs: resetInfo?.resetPrecisionMs ?? null,
          sourceLayer: 'json',
        });
      }
    }

    const dedupedJson = dedupeParsedBuckets(extracted);
    if (dedupedJson.length > 0) {
      return {
        ok: true,
        code: 'ok',
        error: '',
        buckets: dedupedJson,
        email,
        layer: 'json',
      };
    }

    // Layer 2 fallback: parse `json.response` tabular text if schema moved
    if (typeof json.response === 'string' && json.response.trim()) {
      const fb = parseTextFallbackBuckets(json.response, nowMs);
      const dedupedFb = dedupeParsedBuckets(fb.buckets);
      if (dedupedFb.length > 0) {
        return {
          ok: true,
          code: 'ok',
          error: '',
          buckets: dedupedFb,
          email: email || fb.email,
          layer: 'json_response_text',
        };
      }
    }
  }

  // Layer 2 fallback on raw stdout text
  const rawFb = parseTextFallbackBuckets(stdout, nowMs);
  const dedupedRaw = dedupeParsedBuckets(rawFb.buckets);
  if (dedupedRaw.length > 0) {
    return {
      ok: true,
      code: 'ok',
      error: '',
      buckets: dedupedRaw,
      email: rawFb.email,
      layer: 'raw_text',
    };
  }

  return {
    ok: false,
    code: 'parse_error',
    error: 'Could not parse quota buckets from agy /usage output',
    buckets: [],
    email: '',
    layer: 'none',
  };
}

// =========================================================================
// Account Resolution, Activity Gate & Safe Anchor Persistence
// =========================================================================

function resolveTargetAccount(cacheDb, autoCfg, { email = '', atMs = Date.now() } = {}) {
  if (!hasAccountSchema(cacheDb)) {
    return { accountId: DEFAULT_ACCOUNT_ID, matchedBy: 'single', blockedByNearSwitch: false, nearSwitch: null };
  }
  const accState = listAccountsState(cacheDb, atMs);
  const allAccounts = accState.accounts || [];
  if (!accState.multiAccountActive) {
    return { accountId: DEFAULT_ACCOUNT_ID, matchedBy: 'single', blockedByNearSwitch: false, nearSwitch: null };
  }

  // 1. Forward-compatible exact email match (if future /usage JSON exposes email & account has external_email)
  if (email) {
    const cols = cacheDb.prepare('PRAGMA table_info(accounts)').all();
    if (cols.some((c) => c.name === 'external_email')) {
      const match = cacheDb
        .prepare(
          `SELECT id FROM accounts
           WHERE lower(trim(external_email)) = ?
           ORDER BY CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END, sort_order ASC
           LIMIT 1`
        )
        .get(email.toLowerCase());
      if (match?.id) {
        return { accountId: match.id, matchedBy: 'email', blockedByNearSwitch: false, nearSwitch: null };
      }
    }
  }

  // 2. Explicit user-fixed account binding for agy CLI
  if (autoCfg.accountMode === 'fixed' && autoCfg.accountId) {
    const exists = allAccounts.some((a) => a.id === autoCfg.accountId);
    if (exists) {
      return { accountId: autoCfg.accountId, matchedBy: 'fixed', blockedByNearSwitch: false, nearSwitch: null };
    }
  }

  // 3. Follow CLI switch timeline (skip if inside +/-5m near-switch ambiguity band)
  const resolved = resolveActiveAccountAt(cacheDb, { source: 'cli', atMs });
  if (resolved.nearSwitch) {
    return {
      accountId: resolved.accountId || DEFAULT_ACCOUNT_ID,
      matchedBy: 'timeline',
      blockedByNearSwitch: true,
      nearSwitch: resolved.nearSwitch,
    };
  }
  return {
    accountId: resolved.accountId || DEFAULT_ACCOUNT_ID,
    matchedBy: 'timeline',
    blockedByNearSwitch: false,
    nearSwitch: null,
  };
}

function measureActivitySince(cacheDb, pricingState, { sinceMs, nowMs, accountId }) {
  const fromMs = Math.max(0, Number(sinceMs) || 0);
  let rows = [];
  if (accountId && accountId !== 'all' && hasAccountSchema(cacheDb)) {
    const accState = listAccountsState(cacheDb, nowMs);
    if (accState.multiAccountActive) {
      const { tsExprSql, joinSql, exprSql } = buildTurnAccountSql('t');
      rows = cacheDb
        .prepare(
          `SELECT t.* FROM turns t
           ${joinSql}
           WHERE ${tsExprSql} > ? AND ${tsExprSql} <= ? AND (${exprSql}) = ?`
        )
        .all(fromMs, nowMs, accountId);
    } else {
      rows = cacheDb
        .prepare('SELECT * FROM turns WHERE completed_at_ms > ? AND completed_at_ms <= ?')
        .all(fromMs, nowMs);
    }
  } else {
    rows = cacheDb
      .prepare('SELECT * FROM turns WHERE completed_at_ms > ? AND completed_at_ms <= ?')
      .all(fromMs, nowMs);
  }

  let newSpendUsd = 0;
  for (const r of rows) {
    const c = calculateTurnCost(r, pricingState);
    if (!c.unpriced && Number.isFinite(c.costUsd)) {
      newSpendUsd += c.costUsd;
    }
  }
  return {
    newTurns: rows.length,
    newSpendUsd: Math.round(newSpendUsd * 10000) / 10000,
  };
}

function getLatestAnchorTimeForAccount(cacheDb, accountId) {
  const qaCols = cacheDb.prepare('PRAGMA table_info(quota_anchors)').all();
  const hasAccCol = qaCols.some((c) => c.name === 'account_id');
  const row =
    hasAccCol && accountId && accountId !== 'all'
      ? cacheDb
          .prepare("SELECT MAX(captured_at) AS max_cap FROM quota_anchors WHERE account_id = ? AND window_type = '7d'")
          .get(accountId)
      : cacheDb.prepare("SELECT MAX(captured_at) AS max_cap FROM quota_anchors WHERE window_type = '7d'").get();
  return Number(row?.max_cap || 0);
}

/**
 * Evaluate whether automatic background quota alignment is eligible right now.
 * Strictly requires ALL 3: cooldown elapsed AND newTurns >= minTurns AND newSpendUsd >= minSpendUsd.
 */
export function evaluateAutoQuotaGate(cacheDb, pricingState, autoCfg, state, nowMs = Date.now()) {
  const cfg = sanitizeAutoQuotaConfig(autoCfg);
  const target = resolveTargetAccount(cacheDb, cfg, { atMs: nowMs });
  const latestAnchorMs = getLatestAnchorTimeForAccount(cacheDb, target.accountId);
  const lastSyncAt = Number(state?.lastSyncAt || 0);
  const lastAttemptAt = Number(state?.lastAttemptAt || 0);
  const sinceMs = Math.max(latestAnchorMs, lastSyncAt) || Math.max(0, nowMs - 7 * 24 * 3600_000);

  const activity = measureActivitySince(cacheDb, pricingState, {
    sinceMs,
    nowMs,
    accountId: target.accountId,
  });

  const baseIntervalMs = cfg.intervalMinutes * 60_000;
  const failures = Math.max(0, Number(state?.consecutiveFailures || 0));
  const backoffIntervalMs =
    failures > 0 ? Math.min(24 * 3600_000, baseIntervalMs * Math.pow(2, Math.min(4, failures))) : baseIntervalMs;

  const refCooldownAt = failures > 0 ? lastAttemptAt : Math.max(lastSyncAt, latestAnchorMs);
  const nextAllowedAt = refCooldownAt > 0 ? refCooldownAt + backoffIntervalMs : 0;
  const cooldownRemainingMs = Math.max(0, nextAllowedAt - nowMs);

  let reason = 'eligible';
  if (!cfg.enabled) reason = 'disabled';
  else if (target.blockedByNearSwitch) reason = 'near_switch';
  else if (cooldownRemainingMs > 0) reason = failures > 0 ? 'backoff' : 'cooldown';
  else if (activity.newTurns < cfg.minTurns) reason = 'below_min_turns';
  else if (activity.newSpendUsd < cfg.minSpendUsd) reason = 'below_min_spend';

  return {
    eligible: reason === 'eligible',
    reason,
    sinceMs,
    cooldownRemainingMs,
    nextAllowedAt: cooldownRemainingMs > 0 ? nextAllowedAt : null,
    newTurns: activity.newTurns,
    minTurns: cfg.minTurns,
    newSpendUsd: activity.newSpendUsd,
    minSpendUsd: cfg.minSpendUsd,
    targetAccountId: target.accountId,
    targetMatchedBy: target.matchedBy,
    blockedByNearSwitch: target.blockedByNearSwitch,
  };
}

/**
 * Persist parsed quota buckets into `quota_anchors` with high-precision protection and zero-delta dedup.
 */
export function applyParsedQuotaBuckets(
  cacheDb,
  pricingState,
  autoCfg,
  parsed,
  { nowMs = Date.now(), trigger = 'auto', forceAccountId = '' } = {}
) {
  const cfg = sanitizeAutoQuotaConfig(autoCfg);
  const target = forceAccountId
    ? { accountId: forceAccountId, matchedBy: 'explicit', blockedByNearSwitch: false }
    : resolveTargetAccount(cacheDb, cfg, { email: parsed.email || '', atMs: nowMs });

  if (trigger === 'auto' && target.blockedByNearSwitch) {
    return {
      ok: true,
      accountId: target.accountId,
      inserted: [],
      skipped: [{ reason: 'near_switch' }],
    };
  }

  const allowedWindows = cfg.include5h ? new Set(['7d', '5h']) : new Set(['7d']);
  const currentStatus = getQuotaStatus(cacheDb, pricingState, { accountId: target.accountId }, nowMs);
  const summaryMap = new Map();
  for (const s of currentStatus.summaries || []) {
    summaryMap.set(`${s.pool}|${s.windowType}`, s);
  }

  const inserted = [];
  const skipped = [];

  for (const bucket of parsed.buckets || []) {
    if (!allowedWindows.has(bucket.windowType)) continue;

    const sum = summaryMap.get(`${bucket.pool}|${bucket.windowType}`) || null;
    const activeAnchors = Array.isArray(sum?.currentCycleAnchors) ? sum.currentCycleAnchors : [];
    const latest = !sum?.cycleExpired ? (sum?.latestAnchor || null) : null;

    // Guard 1: Never inject coarse integer (1.0%) auto anchors into a high-precision (0.01%) cycle.
    const hasHighPrecInCycle = activeAnchors.some((a) => Number(a.precisionStep ?? a.precision_step ?? 1) <= 0.01);
    if (bucket.precisionStep > 0.01 && hasHighPrecInCycle) {
      skipped.push({
        pool: bucket.pool,
        windowType: bucket.windowType,
        remainingPct: bucket.remainingPct,
        reason: 'coarse_precision_guard',
      });
      continue;
    }

    // Guard 2: Zero-delta dedup when remainingPct did not move and resetAt did not shift/learn.
    if (latest) {
      const pctDelta = Math.abs(bucket.remainingPct - Number(latest.remainingPct));
      const existingReset = sum?.cycleResetAt ?? latest.effectiveResetAt ?? latest.resetAt ?? null;
      const resetShifted =
        bucket.resetAt != null &&
        existingReset != null &&
        Math.abs(bucket.resetAt - existingReset) > 15 * 60_000;
      const resetLearned = bucket.resetAt != null && existingReset == null;
      const tol = Math.max(0.005, bucket.precisionStep * 0.5);
      if (pctDelta < tol && !resetShifted && !resetLearned) {
        skipped.push({
          pool: bucket.pool,
          windowType: bucket.windowType,
          remainingPct: bucket.remainingPct,
          reason: 'unchanged',
        });
        continue;
      }
    }

    let anchorId;
    const rawInputStr =
      bucket.precisionStep <= 0.01
        ? bucket.remainingPct.toFixed(2)
        : bucket.precisionStep <= 0.1
          ? bucket.remainingPct.toFixed(1)
          : String(Math.round(bucket.remainingPct));
    const basePayload = {
      accountId: target.accountId,
      pool: bucket.pool,
      windowType: bucket.windowType,
      remainingPct: bucket.remainingPct,
      rawInput: rawInputStr,
      precisionStep: bucket.precisionStep,
      capturedAt: nowMs,
      resetAt: bucket.resetAt,
      resetPrecisionMs: bucket.resetPrecisionMs,
      anchorSource: 'auto_agy_cli',
      note: '',
    };
    try {
      anchorId = addQuotaAnchor(cacheDb, basePayload, nowMs);
    } catch {
      // Fallback: if clock skew puts resetAt slightly outside window bounds, still persist remainingPct.
      if (basePayload.resetAt != null) {
        try {
          anchorId = addQuotaAnchor(cacheDb, { ...basePayload, resetAt: null, resetPrecisionMs: null }, nowMs);
        } catch (err2) {
          skipped.push({
            pool: bucket.pool,
            windowType: bucket.windowType,
            remainingPct: bucket.remainingPct,
            reason: 'insert_failed',
            error: String(err2?.message || err2 || '').slice(0, 120),
          });
          continue;
        }
      } else {
        skipped.push({
          pool: bucket.pool,
          windowType: bucket.windowType,
          remainingPct: bucket.remainingPct,
          reason: 'insert_failed',
        });
        continue;
      }
    }

    inserted.push({
      id: anchorId,
      pool: bucket.pool,
      windowType: bucket.windowType,
      remainingPct: bucket.remainingPct,
      precisionStep: bucket.precisionStep,
      resetAt: bucket.resetAt,
    });
  }

  return {
    ok: true,
    accountId: target.accountId,
    matchedBy: target.matchedBy,
    inserted,
    skipped,
  };
}

// =========================================================================
// Persistent State & Single-Flight Manager
// =========================================================================

function readStateFile(statePath) {
  try {
    if (!existsSync(statePath)) return {};
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function createAutoQuotaManager({
  dataDir,
  readOnly = false,
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  execFileFn = execFileAsync,
  fileExistsFn = isExecutableFile,
} = {}) {
  const statePath = path.join(dataDir, STATE_FILENAME);
  let state = readStateFile(statePath);
  let inFlight = null;
  let lastProbeCache = null;
  let lastProbeAt = 0;

  function persistState(patch) {
    state = { ...state, ...patch };
    if (!readOnly) {
      try {
        writeJsonAtomic(statePath, state, true);
      } catch {
        // Ignore persistence errors if dataDir is unavailable
      }
    }
    return state;
  }

  async function probe(autoCfg, { force = false } = {}) {
    const cfg = sanitizeAutoQuotaConfig(autoCfg);
    const nowMs = Date.now();
    if (!force && lastProbeCache && lastProbeCache.cliPathInput === cfg.cliPath && nowMs - lastProbeAt < 60_000) {
      return lastProbeCache.result;
    }
    const res = await probeAgyCli({
      cliPath: cfg.cliPath,
      env,
      platform,
      homeDir,
      fileExistsFn,
      execFileFn,
    });
    lastProbeCache = { cliPathInput: cfg.cliPath, result: res };
    lastProbeAt = nowMs;
    if (res.installed && res.version) {
      persistState({
        detectedCliPath: res.cliPath,
        detectedCliVersion: res.version,
        lastProbeAt: nowMs,
      });
    }
    return res;
  }

  async function getStatus(cacheDb, pricingState, autoCfg, { forceProbe = false } = {}) {
    const cfg = sanitizeAutoQuotaConfig(autoCfg);
    const nowMs = Date.now();
    const cli = cfg.enabled || forceProbe ? await probe(cfg, { force: forceProbe }) : null;
    const gate = evaluateAutoQuotaGate(cacheDb, pricingState, cfg, state, nowMs);
    return {
      config: cfg,
      platform,
      installGuidance: getInstallGuidance(platform),
      cli,
      gate,
      syncing: Boolean(inFlight),
      lastAttemptAt: state.lastAttemptAt || null,
      lastSyncAt: state.lastSyncAt || null,
      lastStatus: state.lastStatus || 'idle', // 'idle' | 'synced' | 'unchanged' | 'error'
      lastErrorCode: state.lastErrorCode || '',
      lastError: state.lastError || '',
      consecutiveFailures: Number(state.consecutiveFailures || 0),
      lastSummary: Array.isArray(state.lastSummary) ? state.lastSummary : [],
      lastAccountId: state.lastAccountId || null,
      lastTrigger: state.lastTrigger || '',
    };
  }

  async function syncNow(cacheDb, pricingState, autoCfg, { trigger = 'manual', accountId = '' } = {}) {
    if (readOnly) {
      return { ok: false, code: 'read_only', error: 'Auto quota sync is disabled in read-only mode' };
    }
    if (inFlight) {
      return inFlight;
    }

    const cfg = sanitizeAutoQuotaConfig(autoCfg);
    const runPromise = (async () => {
      const nowMs = Date.now();
      persistState({ lastAttemptAt: nowMs, lastTrigger: trigger });

      const raw = await fetchAgyUsageRaw({
        cliPath: cfg.cliPath,
        env,
        platform,
        homeDir,
        fileExistsFn,
        execFileFn,
      });
      if (!raw.ok) {
        persistState({
          lastStatus: 'error',
          lastErrorCode: raw.code,
          lastError: raw.error,
          consecutiveFailures: Number(state.consecutiveFailures || 0) + 1,
        });
        return { ok: false, code: raw.code, error: raw.error };
      }

      const parsed = parseAgyUsageOutput(raw.stdout, raw.stderr, nowMs);
      if (!parsed.ok) {
        persistState({
          lastStatus: 'error',
          lastErrorCode: parsed.code,
          lastError: parsed.error,
          consecutiveFailures: Number(state.consecutiveFailures || 0) + 1,
        });
        return { ok: false, code: parsed.code, error: parsed.error };
      }

      const applied = applyParsedQuotaBuckets(cacheDb, pricingState, cfg, parsed, {
        nowMs,
        trigger,
        forceAccountId: trigger === 'manual' ? accountId : '',
      });

      const summary = parsed.buckets
        .filter((b) => (cfg.include5h ? true : b.windowType === '7d'))
        .map((b) => ({
          pool: b.pool,
          windowType: b.windowType,
          remainingPct: b.remainingPct,
          precisionStep: b.precisionStep,
          resetAt: b.resetAt,
        }));

      const status = applied.inserted.length > 0 ? 'synced' : 'unchanged';
      persistState({
        lastSyncAt: nowMs,
        lastStatus: status,
        lastErrorCode: '',
        lastError: '',
        consecutiveFailures: 0,
        lastSummary: summary,
        lastAccountId: applied.accountId,
        detectedCliPath: raw.cliPath || state.detectedCliPath || '',
      });

      return {
        ok: true,
        code: status,
        status,
        layer: parsed.layer,
        accountId: applied.accountId,
        inserted: applied.inserted,
        skipped: applied.skipped,
        summary,
        syncedAt: nowMs,
      };
    })();

    inFlight = runPromise;
    try {
      return await runPromise;
    } finally {
      inFlight = null;
    }
  }

  function maybeTriggerBackgroundSync(cacheDb, pricingState, autoCfg) {
    if (readOnly || inFlight) return false;
    const cfg = sanitizeAutoQuotaConfig(autoCfg);
    if (!cfg.enabled) return false;
    const gate = evaluateAutoQuotaGate(cacheDb, pricingState, cfg, state, Date.now());
    if (!gate.eligible) return false;
    // Fire-and-forget inside single-flight guard; never blocks request latency.
    syncNow(cacheDb, pricingState, cfg, { trigger: 'auto' }).catch(() => {});
    return true;
  }

  return {
    probe,
    getStatus,
    syncNow,
    maybeTriggerBackgroundSync,
  };
}
