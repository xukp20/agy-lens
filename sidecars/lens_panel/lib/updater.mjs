/**
 * Self-update engine for AGY Lens sidecar (zero external dependencies).
 * Supports both Git-clone installs (strict Release Tag fast-forward) and
 * Standalone/Tarball installs (pure-JS streaming .tar.gz staging + SHA-256 verification),
 * isolated subprocess smoke testing, and crash-safe cold-start apply via `boot.mjs`.
 */
import { execFile } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { extractTarGz } from './tar_extract.mjs';

const execFileAsync = promisify(execFile);

export const GITHUB_OWNER = 'xukp20';
export const GITHUB_REPO = 'agy-lens';

const RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const RELEASE_WEB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

const CHECK_TTL_MS = 6 * 3600 * 1000;
const CHECK_JITTER_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const LOCK_STALE_MS = 3 * 60 * 1000;
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const MANUAL_ONLY_RE = /<!--\s*agy-lens:\s*(?:manual-only|no-auto-update)\s*-->/i;

const ALLOWED_ROOT_FILES = new Set(['plugin.json', 'README.md', 'README.zh-CN.md', 'LICENSE']);
const ALLOWED_ROOT_DIRS = ['sidecars/', 'assets/', 'skills/', 'rules/', 'agents/'];

let inflightCheck = null;
let inflightStage = null;
let cachedInstallInfo = null;
let cachedInstallInfoAt = 0;
let sessionJitterMs = Math.floor(Math.random() * CHECK_JITTER_MS);

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  renameSync(tmp, filePath);
}

function isAllowedManagedPath(relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.startsWith('/') || relPath.includes('\\')) {
    return false;
  }
  const segs = relPath.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) return false;
  if (ALLOWED_ROOT_FILES.has(relPath)) return true;
  return ALLOWED_ROOT_DIRS.some((prefix) => relPath.startsWith(prefix));
}

export function getRunningVersion(pluginRoot) {
  const pkg = readJsonSafe(join(pluginRoot, 'plugin.json'), null);
  return typeof pkg?.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.0.0';
}

export function parseSemver(v) {
  const m = String(v || '')
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

export function parseGitHubOwnerRepo(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return null;
  // HTTPS / HTTP: https://github.com/owner/repo(.git)
  try {
    if (/^https?:\/\//i.test(raw) || /^ssh:\/\//i.test(raw)) {
      const u = new URL(raw);
      if (u.hostname.toLowerCase() !== 'github.com') return null;
      const parts = u.pathname
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\.git$/i, '')
        .split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
      return `${parts[0]}/${parts[1]}`.toLowerCase();
    }
  } catch {
    // fall through to SCP-like SSH format
  }
  // SCP-like SSH: git@github.com:owner/repo(.git)
  const sshMatch = raw.match(/^[^@]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`.toLowerCase();
  }
  return null;
}

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
  };
}

async function runGit(args, cwd, { timeoutMs = 15000, encoding = 'utf-8', maxBuffer = 20 * 1024 * 1024 } = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: gitEnv(),
    encoding,
    timeout: timeoutMs,
    maxBuffer,
    windowsHide: true,
  });
  return typeof stdout === 'string' ? stdout.trim() : stdout;
}

function acquireLock(dataDir) {
  const lockDir = join(dataDir, '.update.lock');
  const ownerFile = join(lockDir, 'owner.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir);
      writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf-8');
      return () => {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') return null;
      const owner = readJsonSafe(ownerFile, null);
      let mtime = owner?.ts || 0;
      if (!mtime) {
        try {
          mtime = statSync(lockDir).mtimeMs;
        } catch {
          mtime = 0;
        }
      }
      if (Date.now() - mtime > LOCK_STALE_MS) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          return null;
        }
        continue;
      }
      return null;
    }
  }
  return null;
}

function checkWritablePaths(pluginRoot) {
  const probePaths = [
    pluginRoot,
    join(pluginRoot, 'plugin.json'),
    join(pluginRoot, 'sidecars', 'lens_panel', 'main.mjs'),
    join(pluginRoot, 'sidecars', 'lens_panel', 'web', 'app.js'),
  ];
  for (const p of probePaths) {
    if (!existsSync(p)) continue;
    try {
      accessSync(p, fsConstants.W_OK);
    } catch {
      return false;
    }
  }
  return true;
}

export async function detectInstallInfo(pluginRoot, { force = false } = {}) {
  if (!force && cachedInstallInfo && Date.now() - cachedInstallInfoAt < 30000) {
    return cachedInstallInfo;
  }
  const normalizedRoot = pluginRoot.replace(/\\/g, '/').toLowerCase();
  if (normalizedRoot.includes('/builtin/plugins/')) {
    cachedInstallInfo = {
      installKind: 'builtin',
      canAutoApply: false,
      blockedReason: 'builtin_plugin',
    };
    cachedInstallInfoAt = Date.now();
    return cachedInstallInfo;
  }

  const hasGitDir = existsSync(join(pluginRoot, '.git'));
  if (hasGitDir) {
    let info = { installKind: 'git', canAutoApply: true, blockedReason: '' };
    try {
      await runGit(['--version'], pluginRoot, { timeoutMs: 5000 });
    } catch {
      info = { installKind: 'git', canAutoApply: false, blockedReason: 'git_unavailable' };
      cachedInstallInfo = info;
      cachedInstallInfoAt = Date.now();
      return info;
    }

    if (existsSync(join(pluginRoot, '.git', 'index.lock'))) {
      info = { installKind: 'git', canAutoApply: false, blockedReason: 'git_locked' };
    } else {
      try {
        const remoteUrl = await runGit(['remote', 'get-url', 'origin'], pluginRoot, { timeoutMs: 5000 });
        const ownerRepo = parseGitHubOwnerRepo(remoteUrl);
        if (ownerRepo !== `${GITHUB_OWNER}/${GITHUB_REPO}`.toLowerCase()) {
          info = { installKind: 'git', canAutoApply: false, blockedReason: 'custom_remote' };
        } else {
          const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], pluginRoot, { timeoutMs: 5000 });
          if (branch !== 'main' && branch !== 'master') {
            info = { installKind: 'git', canAutoApply: false, blockedReason: 'non_main_branch' };
          } else {
            const dirty = await runGit(['status', '--porcelain', '-uno'], pluginRoot, { timeoutMs: 5000 });
            if (dirty) {
              info = { installKind: 'git', canAutoApply: false, blockedReason: 'dirty_git' };
            }
          }
        }
      } catch {
        info = { installKind: 'git', canAutoApply: false, blockedReason: 'git_error' };
      }
    }
    cachedInstallInfo = info;
    cachedInstallInfoAt = Date.now();
    return info;
  }

  const writable = checkWritablePaths(pluginRoot);
  cachedInstallInfo = {
    installKind: 'tarball',
    canAutoApply: writable,
    blockedReason: writable ? '' : 'not_writable',
  };
  cachedInstallInfoAt = Date.now();
  return cachedInstallInfo;
}

function assertAllowedUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  if (u.protocol !== 'https:') {
    throw new Error(`Blocked non-HTTPS URL: ${u.protocol}`);
  }
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    throw new Error(`Blocked untrusted host: ${u.hostname}`);
  }
  return u;
}

async function fetchWithStrictRedirects(
  urlStr,
  { headers = {}, timeoutMs = FETCH_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS, method = 'GET' } = {}
) {
  let currentUrl = urlStr;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertAllowedUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(currentUrl, {
        method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      const nextUrl = new URL(loc, currentUrl).toString();
      assertAllowedUrl(nextUrl);
      currentUrl = nextUrl;
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

async function downloadBoundedBytes(urlStr, userAgent) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithStrictRedirects(urlStr, {
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/octet-stream, application/gzip, */*',
        },
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
      if (!res.ok) {
        throw new Error(`Download failed with HTTP ${res.status}`);
      }
      const reader = res.body?.getReader?.();
      if (!reader) {
        const arr = new Uint8Array(await res.arrayBuffer());
        if (arr.byteLength > MAX_DOWNLOAD_BYTES) {
          throw new Error(`Archive exceeds ${MAX_DOWNLOAD_BYTES} byte limit`);
        }
        return Buffer.from(arr);
      }
      const chunks = [];
      let total = 0;
      const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
      while (true) {
        if (Date.now() > deadline) {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          throw new Error(`Download timed out after ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s`);
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_DOWNLOAD_BYTES) {
            try {
              await reader.cancel();
            } catch {
              // ignore
            }
            throw new Error(`Archive exceeds ${MAX_DOWNLOAD_BYTES} byte limit`);
          }
          chunks.push(Buffer.from(value));
        }
      }
      return Buffer.concat(chunks, total);
    } catch (err) {
      const isAbort = err?.name === 'AbortError' || /aborted/i.test(String(err?.message || ''));
      lastErr = isAbort
        ? new Error(`Download timed out after ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s — please retry`)
        : err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }
  }
  throw lastErr;
}

async function fetchLatestReleaseMeta(runningVersion, prevEtag = '') {
  const ua = `agy-lens/${runningVersion}`;
  const headers = {
    'User-Agent': ua,
    Accept: 'application/vnd.github+json',
  };
  if (prevEtag) headers['If-None-Match'] = prevEtag;

  const res = await fetchWithStrictRedirects(RELEASE_API_URL, { headers, timeoutMs: FETCH_TIMEOUT_MS });
  if (res.status === 304) {
    return { notModified: true, etag: res.headers.get('etag') || prevEtag };
  }
  if (res.ok) {
    const json = await res.json();
    if (json.draft || json.prerelease) {
      return { skippedPreRelease: true, etag: res.headers.get('etag') || '' };
    }
    const tagName = String(json.tag_name || '').trim();
    const m = tagName.match(TAG_RE);
    if (!m) {
      throw new Error(`Invalid release tag format: "${tagName}"`);
    }
    const latestVersion = `${m[1]}.${m[2]}.${m[3]}`;
    const tarballUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/archive/refs/tags/${tagName}.tar.gz`;
    const releaseUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tagName}`;
    const rawBody = typeof json.body === 'string' ? json.body : '';
    const manualOnly = MANUAL_ONLY_RE.test(rawBody);
    const cleanNotes = rawBody.replace(MANUAL_ONLY_RE, '').trim().slice(0, 4000);
    return {
      notModified: false,
      etag: res.headers.get('etag') || '',
      tagName,
      latestVersion,
      tarballUrl,
      releaseUrl,
      releaseNotes: cleanNotes,
      manualOnly,
      publishedAt: typeof json.published_at === 'string' ? json.published_at : null,
    };
  }

  // Fallback on GitHub API rate limit (403/429): inspect web /releases/latest 302 Location header.
  if (res.status === 403 || res.status === 429) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let webRes;
    try {
      webRes = await fetch(RELEASE_WEB_URL, {
        method: 'GET',
        headers: { 'User-Agent': ua },
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const loc = webRes.headers.get('location') || '';
    const locMatch = loc.match(/\/releases\/tag\/(v\d+\.\d+\.\d+)(?:[/?#]|$)/);
    if (!locMatch) {
      throw new Error(`GitHub API rate-limited (${res.status}) and fallback redirect unavailable`);
    }
    const tagName = locMatch[1];
    const m = tagName.match(TAG_RE);
    const latestVersion = `${m[1]}.${m[2]}.${m[3]}`;
    return {
      notModified: false,
      etag: '',
      tagName,
      latestVersion,
      tarballUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/archive/refs/tags/${tagName}.tar.gz`,
      releaseUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tagName}`,
      releaseNotes: '',
      manualOnly: false,
      publishedAt: null,
    };
  }

  throw new Error(`GitHub release check failed (HTTP ${res.status})`);
}

async function runSmokeTest(stagedRoot) {
  const bootEntry = join(stagedRoot, 'sidecars', 'lens_panel', 'boot.mjs');
  const mainEntry = join(stagedRoot, 'sidecars', 'lens_panel', 'main.mjs');
  const entry = existsSync(bootEntry) ? bootEntry : mainEntry;
  if (!existsSync(entry)) {
    throw new Error('Staged update is missing sidecar entrypoint');
  }
  const smokeDataDir = join(tmpdir(), `agy_lens_smoke_${process.pid}_${Date.now()}`);
  mkdirSync(smokeDataDir, { recursive: true });
  const env = {
    ...process.env,
    AGY_LENS_SMOKE: '1',
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: smokeDataDir,
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS || '127.0.0.1:1',
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN || 'smoke-token',
    ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
  };
  const safeExecArgv = process.execArgv.filter(
    (a) => !a.startsWith('--inspect') && !a.startsWith('--debug')
  );
  try {
    const { stdout } = await execFileAsync(process.execPath, [...safeExecArgv, entry], {
      cwd: join(stagedRoot, 'sidecars', 'lens_panel'),
      env,
      encoding: 'utf-8',
      timeout: 12000,
      windowsHide: true,
    });
    if (!String(stdout || '').includes('AGY_LENS_SMOKE_OK')) {
      throw new Error('Smoke test did not emit AGY_LENS_SMOKE_OK');
    }
  } finally {
    try {
      rmSync(smokeDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function sidecarJsonChanged(pluginRoot, stagedSidecarJsonText) {
  try {
    const curPath = join(pluginRoot, 'sidecars', 'lens_panel', 'sidecar.json');
    if (!existsSync(curPath)) return true;
    const curNorm = JSON.stringify(JSON.parse(readFileSync(curPath, 'utf-8')));
    const nextNorm = JSON.stringify(JSON.parse(stagedSidecarJsonText));
    return curNorm !== nextNorm;
  } catch {
    return true;
  }
}

export async function stageUpdate(dataDir, pluginRoot, config) {
  if (inflightStage) return inflightStage;
  inflightStage = (async () => {
    const releaseLock = acquireLock(dataDir);
    if (!releaseLock) {
      throw new Error('Another update operation is already in progress');
    }
    try {
      const runningVersion = getRunningVersion(pluginRoot);
      const statePath = join(dataDir, 'update_state.json');
      const st = readJsonSafe(statePath, {}) || {};
      const pendingPath = join(dataDir, 'pending_update.json');

      const tagName = String(st.tagName || '').trim();
      const targetVersion = String(st.latestVersion || '').trim();
      if (!TAG_RE.test(tagName) || compareSemver(targetVersion, runningVersion) <= 0) {
        throw new Error('No newer version available to stage');
      }

      const install = await detectInstallInfo(pluginRoot, { force: true });
      if (!install.canAutoApply) {
        throw new Error(`Cannot auto-update (${install.blockedReason || 'blocked'})`);
      }

      // Already staged for this exact version?
      const existingPending = readJsonSafe(pendingPath, null);
      if (
        existingPending &&
        existingPending.status === 'staged' &&
        existingPending.targetVersion === targetVersion &&
        existingPending.installKind === install.installKind &&
        (install.installKind === 'git' || (existingPending.stagedDir && existsSync(existingPending.stagedDir)))
      ) {
        return existingPending;
      }

      if (install.installKind === 'git') {
        await runGit(['fetch', 'origin', 'tag', tagName, '--no-tags'], pluginRoot, { timeoutMs: 25000 });
        const targetCommit = await runGit(['rev-parse', `${tagName}^{commit}`], pluginRoot, { timeoutMs: 5000 });
        if (!/^[0-9a-f]{7,40}$/i.test(targetCommit)) {
          throw new Error('Invalid commit hash for release tag');
        }
        // Ensure strict fast-forward ancestry from HEAD -> tag commit.
        try {
          await runGit(['merge-base', '--is-ancestor', 'HEAD', targetCommit], pluginRoot, { timeoutMs: 5000 });
        } catch {
          throw new Error(`Local branch cannot fast-forward cleanly to ${tagName}`);
        }
        const pkgText = await runGit(['show', `${tagName}:plugin.json`], pluginRoot, { timeoutMs: 5000 });
        const pkg = JSON.parse(pkgText);
        if (!pkg || pkg.name !== 'agy-lens' || pkg.version !== targetVersion) {
          throw new Error(`Tag ${tagName} plugin.json mismatch (${pkg?.version || 'none'})`);
        }
        const stagedSidecarText = await runGit(['show', `${tagName}:sidecars/lens_panel/sidecar.json`], pluginRoot, {
          timeoutMs: 5000,
        });
        const requiresHostRestart = sidecarJsonChanged(pluginRoot, stagedSidecarText);

        // Extract tag via git archive into a temporary directory and run isolated smoke test.
        const smokeArchive = await runGit(['archive', '--format=tar.gz', '--prefix=agy-lens/', tagName], pluginRoot, {
          timeoutMs: 20000,
          encoding: 'buffer',
          maxBuffer: MAX_DOWNLOAD_BYTES,
        });
        const smokeRoot = join(tmpdir(), `agy_lens_git_smoke_${process.pid}_${Date.now()}`);
        try {
          await extractTarGz(smokeArchive, smokeRoot);
          await runSmokeTest(smokeRoot);
        } finally {
          try {
            rmSync(smokeRoot, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }

        const pendingObj = {
          status: 'staged',
          installKind: 'git',
          prevVersion: runningVersion,
          targetVersion,
          tagName,
          targetCommit,
          requiresHostRestart,
          autoApply: Boolean(config?.updateMode === 'auto' && !st.manualOnly),
          applyNow: false,
          stagedAt: Date.now(),
        };
        writeJsonAtomic(pendingPath, pendingObj);
        st.stagedVersion = targetVersion;
        st.lastError = null;
        writeJsonAtomic(statePath, st);
        return pendingObj;
      }

      // Standalone / Tarball install path
      const tarballUrl =
        st.tarballUrl || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/archive/refs/tags/${tagName}.tar.gz`;
      const bytes = await downloadBoundedBytes(tarballUrl, `agy-lens/${runningVersion}`);
      const stagedDir = join(dataDir, '.update_staging', `${tagName}_${Date.now()}`);
      try {
        rmSync(join(dataDir, '.update_staging'), { recursive: true, force: true });
      } catch {
        // ignore
      }
      const extracted = await extractTarGz(bytes, stagedDir);
      const pkg = readJsonSafe(join(stagedDir, 'plugin.json'), null);
      if (!pkg || pkg.name !== 'agy-lens' || pkg.version !== targetVersion) {
        rmSync(stagedDir, { recursive: true, force: true });
        throw new Error(`Archive plugin.json mismatch (${pkg?.version || 'none'})`);
      }

      const requiredFiles = [
        'plugin.json',
        'sidecars/lens_panel/sidecar.json',
        'sidecars/lens_panel/main.mjs',
        'sidecars/lens_panel/web/index.html',
        'sidecars/lens_panel/web/app.js',
        'sidecars/lens_panel/web/styles.css',
      ];
      const extractedSet = new Set(extracted.files.map((f) => f.relPath));
      for (const req of requiredFiles) {
        if (!extractedSet.has(req)) {
          rmSync(stagedDir, { recursive: true, force: true });
          throw new Error(`Archive missing required file: ${req}`);
        }
      }

      const stagedSidecarText = readFileSync(join(stagedDir, 'sidecars', 'lens_panel', 'sidecar.json'), 'utf-8');
      const requiresHostRestart = sidecarJsonChanged(pluginRoot, stagedSidecarText);

      // Isolated subprocess smoke test before marking staged.
      try {
        await runSmokeTest(stagedDir);
      } catch (err) {
        rmSync(stagedDir, { recursive: true, force: true });
        throw new Error(`Smoke test failed: ${err.message}`);
      }

      const manifest = extracted.files
        .filter((f) => isAllowedManagedPath(f.relPath))
        .map((f) => ({ relPath: f.relPath, sha256: f.sha256, size: f.size }));

      const pendingObj = {
        status: 'staged',
        installKind: 'tarball',
        prevVersion: runningVersion,
        targetVersion,
        tagName,
        stagedDir,
        manifest,
        requiresHostRestart,
        autoApply: Boolean(config?.updateMode === 'auto' && !st.manualOnly),
        applyNow: false,
        stagedAt: Date.now(),
      };
      writeJsonAtomic(pendingPath, pendingObj);
      st.stagedVersion = targetVersion;
      st.stagedDir = stagedDir;
      st.lastError = null;
      writeJsonAtomic(statePath, st);
      return pendingObj;
    } catch (err) {
      const statePath = join(dataDir, 'update_state.json');
      const st = readJsonSafe(statePath, {}) || {};
      st.lastError = String(err?.message || err).slice(0, 400);
      writeJsonAtomic(statePath, st);
      throw err;
    } finally {
      releaseLock();
      inflightStage = null;
    }
  })();
  return inflightStage;
}

export async function checkForUpdate(dataDir, pluginRoot, config, { force = false } = {}) {
  if (inflightCheck) return inflightCheck;
  inflightCheck = (async () => {
    try {
      const runningVersion = getRunningVersion(pluginRoot);
      const statePath = join(dataDir, 'update_state.json');
      const st = readJsonSafe(statePath, {}) || {};
      const now = Date.now();

      if (!force && st.lastCheckedAt && now - st.lastCheckedAt < CHECK_TTL_MS + sessionJitterMs) {
        return getUpdateStatus(dataDir, pluginRoot, config);
      }

      const meta = await fetchLatestReleaseMeta(runningVersion, force ? '' : st.etag || '');
      st.lastCheckedAt = now;
      if (meta.etag !== undefined) st.etag = meta.etag;
      if (!meta.notModified && !meta.skippedPreRelease) {
        st.latestVersion = meta.latestVersion;
        st.tagName = meta.tagName;
        st.tarballUrl = meta.tarballUrl;
        st.releaseUrl = meta.releaseUrl;
        st.releaseNotes = meta.releaseNotes;
        st.manualOnly = Boolean(meta.manualOnly);
        st.publishedAt = meta.publishedAt;
      }
      st.lastError = null;
      writeJsonAtomic(statePath, st);

      const hasUpdate = Boolean(st.latestVersion && compareSemver(st.latestVersion, runningVersion) > 0);
      if (
        hasUpdate &&
        !st.manualOnly &&
        config?.updateMode === 'auto' &&
        st.latestVersion !== st.failedVersion &&
        st.latestVersion !== st.rolledBackFrom &&
        st.latestVersion !== config?.dismissedUpdateVersion
      ) {
        const install = await detectInstallInfo(pluginRoot);
        if (install.canAutoApply) {
          // Stage asynchronously so check response stays fast.
          stageUpdate(dataDir, pluginRoot, config).catch(() => {
            // error already recorded into update_state.json
          });
        }
      }

      return getUpdateStatus(dataDir, pluginRoot, config);
    } catch (err) {
      const statePath = join(dataDir, 'update_state.json');
      const st = readJsonSafe(statePath, {}) || {};
      st.lastCheckedAt = Date.now();
      st.lastError = String(err?.message || err).slice(0, 400);
      writeJsonAtomic(statePath, st);
      return getUpdateStatus(dataDir, pluginRoot, config);
    } finally {
      inflightCheck = null;
    }
  })();
  return inflightCheck;
}

export function maybeAutoCheckUpdate(dataDir, pluginRoot, config) {
  if (!config || config.updateMode === 'off') return;
  const st = readJsonSafe(join(dataDir, 'update_state.json'), null);
  if (st?.lastCheckedAt && Date.now() - st.lastCheckedAt < CHECK_TTL_MS + sessionJitterMs) {
    return;
  }
  checkForUpdate(dataDir, pluginRoot, config, { force: false }).catch(() => {
    // silent background check
  });
}

export async function getUpdateStatus(dataDir, pluginRoot, config) {
  const runningVersion = getRunningVersion(pluginRoot);
  const st = readJsonSafe(join(dataDir, 'update_state.json'), {}) || {};
  const pending = readJsonSafe(join(dataDir, 'pending_update.json'), null);
  const backup = readJsonSafe(join(dataDir, 'last_backup.json'), null);
  const install = await detectInstallInfo(pluginRoot);

  const latestVersion = typeof st.latestVersion === 'string' ? st.latestVersion : null;
  const hasUpdate = Boolean(latestVersion && compareSemver(latestVersion, runningVersion) > 0);
  const stagedReady = Boolean(
    pending &&
      pending.status === 'staged' &&
      pending.targetVersion &&
      compareSemver(pending.targetVersion, runningVersion) > 0
  );

  const canRollback = Boolean(
    backup &&
      backup.prevVersion &&
      backup.prevVersion !== runningVersion &&
      ((backup.installKind === 'git' && backup.prevHead) ||
        (backup.installKind === 'tarball' && backup.backupDir && existsSync(backup.backupDir)))
  );

  return {
    currentVersion: runningVersion,
    installKind: install.installKind,
    canAutoApply: install.canAutoApply,
    blockedReason: install.blockedReason || '',
    updateMode: config?.updateMode || 'auto',
    dismissedVersion: config?.dismissedUpdateVersion || '',
    latestVersion: hasUpdate ? latestVersion : runningVersion,
    tagName: hasUpdate ? st.tagName || `v${latestVersion}` : `v${runningVersion}`,
    releaseUrl:
      (hasUpdate && st.releaseUrl) || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
    releaseNotes: hasUpdate ? st.releaseNotes || '' : '',
    manualOnly: hasUpdate ? Boolean(st.manualOnly) : false,
    publishedAt: hasUpdate ? st.publishedAt || null : null,
    hasUpdate,
    stagedVersion: stagedReady ? pending.targetVersion : null,
    requiresHostRestart: stagedReady ? Boolean(pending.requiresHostRestart) : false,
    failedVersion: st.failedVersion || null,
    justUpdated: st.justUpdated || null,
    canRollback,
    rollbackVersion: canRollback ? backup.prevVersion : null,
    checking: Boolean(inflightCheck),
    staging: Boolean(inflightStage),
    lastCheckedAt: st.lastCheckedAt || null,
    lastError: st.lastError || null,
  };
}

export async function prepareApplyNow(dataDir, pluginRoot, config) {
  const pending = await stageUpdate(dataDir, pluginRoot, config);
  const pendingPath = join(dataDir, 'pending_update.json');
  writeJsonAtomic(pendingPath, { ...pending, applyNow: true });
  return {
    ok: true,
    updatedTo: pending.targetVersion,
    prevVersion: pending.prevVersion,
    requiresHostRestart: Boolean(pending.requiresHostRestart),
    restarting: true,
  };
}

export function prepareRollback(dataDir, pluginRoot) {
  const runningVersion = getRunningVersion(pluginRoot);
  const backup = readJsonSafe(join(dataDir, 'last_backup.json'), null);
  if (
    !backup ||
    !backup.prevVersion ||
    backup.prevVersion === runningVersion ||
    (backup.installKind === 'tarball' && (!backup.backupDir || !existsSync(backup.backupDir)))
  ) {
    throw new Error('No previous version backup available to roll back');
  }
  writeJsonAtomic(join(dataDir, 'pending_rollback.json'), {
    requestedAt: Date.now(),
    targetVersion: backup.prevVersion,
  });
  return {
    ok: true,
    rollbackTo: backup.prevVersion,
    restarting: true,
  };
}

export function markHealthy(dataDir, runningVersion) {
  const pendingPath = join(dataDir, 'pending_update.json');
  const pending = readJsonSafe(pendingPath, null);
  if (pending && pending.status === 'applied' && pending.targetVersion === runningVersion) {
    const statePath = join(dataDir, 'update_state.json');
    const st = readJsonSafe(statePath, {}) || {};
    st.justUpdated = {
      from: pending.prevVersion || '',
      to: runningVersion,
      at: Date.now(),
    };
    st.failedVersion = null;
    st.rolledBackFrom = null;
    st.lastError = null;
    st.stagedVersion = null;
    st.stagedDir = null;
    writeJsonAtomic(statePath, st);
    try {
      unlinkSync(pendingPath);
    } catch {
      // ignore
    }
  }
}

export function ackJustUpdated(dataDir) {
  const statePath = join(dataDir, 'update_state.json');
  const st = readJsonSafe(statePath, null);
  if (!st || !st.justUpdated) return;
  delete st.justUpdated;
  writeJsonAtomic(statePath, st);
}

export function hasPendingAutoApplyOnIdle(dataDir, runningVersion, config) {
  if (!config || config.updateMode !== 'auto') return false;
  const pending = readJsonSafe(join(dataDir, 'pending_update.json'), null);
  if (!pending || pending.status !== 'staged') return false;
  if (!pending.autoApply || pending.requiresHostRestart) return false;
  return compareSemver(pending.targetVersion, runningVersion) > 0;
}
