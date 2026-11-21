/**
 * Minimal, self-contained bootstrap entrypoint for AGY Lens sidecar.
 * Designed to stay stable across releases: handles pending staged updates,
 * crash-loop auto-rollback, interrupted-journal recovery, and user rollbacks
 * BEFORE importing `./main.mjs`.
 *
 * Uses ONLY Node.js built-in modules so a broken `lib/` or `main.mjs` release
 * can never prevent automatic rollback.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');

const LOCK_STALE_MS = 3 * 60 * 1000;
const ALLOWED_ROOT_FILES = new Set(['plugin.json', 'README.md', 'README.zh-CN.md', 'LICENSE']);
const ALLOWED_ROOT_DIRS = ['sidecars/', 'assets/', 'skills/', 'rules/', 'agents/'];

function resolveDataDir() {
  const dir =
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-lens', 'lens_panel', 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
  renameWithRetry(tmp, filePath);
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // fallback busy wait
    }
  }
}

function renameWithRetry(src, dest, maxAttempts = 6) {
  let delay = 40;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      renameSync(src, dest);
      return;
    } catch (err) {
      const code = err?.code;
      if ((code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') && i < maxAttempts - 1) {
        sleepSync(delay);
        delay = Math.min(400, delay * 2);
        continue;
      }
      throw err;
    }
  }
}

function copyFileAtomic(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.agy_tmp.${process.pid}`;
  copyFileSync(src, tmp);
  renameWithRetry(tmp, dest);
}

function unlinkWithRetry(filePath, maxAttempts = 5) {
  if (!existsSync(filePath)) return;
  let delay = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      unlinkSync(filePath);
      return;
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      if ((err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES') && i < maxAttempts - 1) {
        sleepSync(delay);
        delay = Math.min(300, delay * 2);
        continue;
      }
      throw err;
    }
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
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

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
  };
}

function runGitSync(args, cwd = PLUGIN_ROOT, timeoutMs = 20000) {
  return execFileSync('git', args, {
    cwd,
    env: gitEnv(),
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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

function recordUpdateFailure(dataDir, failedVersion, errorMsg) {
  const statePath = join(dataDir, 'update_state.json');
  const st = readJsonSafe(statePath, {}) || {};
  if (failedVersion) st.failedVersion = failedVersion;
  st.lastError = String(errorMsg || 'Update failed').slice(0, 400);
  st.stagedVersion = null;
  st.stagedDir = null;
  writeJsonAtomic(statePath, st);
}

function restoreFromBackup(dataDir, backupInfo) {
  if (!backupInfo) return false;
  if (backupInfo.installKind === 'git' && backupInfo.prevHead) {
    if (!/^[0-9a-f]{7,40}$/i.test(backupInfo.prevHead)) return false;
    runGitSync(['reset', '--hard', backupInfo.prevHead]);
    return true;
  }
  if (backupInfo.installKind === 'tarball' && backupInfo.backupDir && existsSync(backupInfo.backupDir)) {
    const backupManifest = readJsonSafe(join(backupInfo.backupDir, 'backup_manifest.json'), null);
    const prevFiles = Array.isArray(backupManifest?.files) ? backupManifest.files : [];
    const curInstalled = readJsonSafe(join(dataDir, 'installed_manifest.json'), null);
    const curFiles = Array.isArray(curInstalled?.files) ? curInstalled.files : [];

    // Restore every backed-up file.
    const restoredSet = new Set();
    for (const relPath of prevFiles) {
      if (!isAllowedManagedPath(relPath)) continue;
      const src = join(backupInfo.backupDir, 'files', ...relPath.split('/'));
      const dst = join(PLUGIN_ROOT, ...relPath.split('/'));
      if (existsSync(src)) {
        copyFileAtomic(src, dst);
        restoredSet.add(relPath);
      }
    }
    // Remove files that were added only by the newer version.
    for (const relPath of curFiles) {
      if (!isAllowedManagedPath(relPath) || restoredSet.has(relPath)) continue;
      unlinkWithRetry(join(PLUGIN_ROOT, ...relPath.split('/')));
    }
    writeJsonAtomic(join(dataDir, 'installed_manifest.json'), {
      version: backupInfo.prevVersion || '',
      files: [...restoredSet],
      updatedAt: Date.now(),
    });
    return true;
  }
  return false;
}

function applyGitUpdate(dataDir, pending) {
  const indexLock = join(PLUGIN_ROOT, '.git', 'index.lock');
  if (existsSync(indexLock)) {
    throw new Error('Git repository has an active index.lock');
  }
  const dirty = runGitSync(['status', '--porcelain', '-uno']);
  if (dirty) {
    throw new Error('Git working tree has uncommitted changes');
  }
  const commit = String(pending.targetCommit || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new Error(`Invalid target commit hash: "${commit}"`);
  }
  const prevHead = runGitSync(['rev-parse', 'HEAD']);
  const journalPath = join(dataDir, 'apply_journal.json');
  writeJsonAtomic(journalPath, {
    installKind: 'git',
    prevHead,
    prevVersion: pending.prevVersion || '',
    targetVersion: pending.targetVersion || '',
    startedAt: Date.now(),
  });

  try {
    runGitSync(['merge', '--ff-only', commit]);
    const pkg = readJsonSafe(join(PLUGIN_ROOT, 'plugin.json'), null);
    if (!pkg || pkg.name !== 'agy-lens' || pkg.version !== pending.targetVersion) {
      throw new Error(`Post-merge plugin.json version mismatch (got ${pkg?.version || 'none'})`);
    }
    writeJsonAtomic(join(dataDir, 'last_backup.json'), {
      installKind: 'git',
      prevVersion: pending.prevVersion || '',
      targetVersion: pending.targetVersion || '',
      prevHead,
      appliedAt: Date.now(),
    });
    unlinkWithRetry(journalPath);
  } catch (err) {
    try {
      runGitSync(['reset', '--hard', prevHead]);
    } catch {
      // ignore rollback failure
    }
    unlinkWithRetry(journalPath);
    throw err;
  }
}

function applyTarballUpdate(dataDir, pending) {
  const stagedDir = pending.stagedDir;
  const manifest = Array.isArray(pending.manifest) ? pending.manifest : [];
  if (!stagedDir || !existsSync(stagedDir) || manifest.length === 0) {
    throw new Error('Staged update directory or manifest is missing');
  }

  // Verify every staged file's SHA-256 before modifying PLUGIN_ROOT.
  const newPaths = new Set();
  for (const item of manifest) {
    if (!isAllowedManagedPath(item.relPath)) continue;
    const stagedFile = join(stagedDir, ...item.relPath.split('/'));
    if (!existsSync(stagedFile)) {
      throw new Error(`Missing staged file: ${item.relPath}`);
    }
    if (item.sha256 && sha256File(stagedFile) !== item.sha256) {
      throw new Error(`Staged checksum mismatch: ${item.relPath}`);
    }
    newPaths.add(item.relPath);
  }
  if (!newPaths.has('plugin.json') || !newPaths.has('sidecars/lens_panel/main.mjs')) {
    throw new Error('Staged update missing required core files');
  }

  const prevInstalled = readJsonSafe(join(dataDir, 'installed_manifest.json'), null);
  const prevFilesList = Array.isArray(prevInstalled?.files) ? prevInstalled.files : [];
  const backupRoot = join(dataDir, '.update_backup', `from_${pending.prevVersion || 'unknown'}_${Date.now()}`);
  const backupFilesDir = join(backupRoot, 'files');
  mkdirSync(backupFilesDir, { recursive: true });

  // Backup union of previously tracked files and incoming managed paths that exist on disk.
  const toBackup = new Set([...prevFilesList, ...newPaths]);
  const backedUpFiles = [];
  for (const relPath of toBackup) {
    if (!isAllowedManagedPath(relPath)) continue;
    const livePath = join(PLUGIN_ROOT, ...relPath.split('/'));
    if (existsSync(livePath)) {
      copyFileAtomic(livePath, join(backupFilesDir, ...relPath.split('/')));
      backedUpFiles.push(relPath);
    }
  }
  writeJsonAtomic(join(backupRoot, 'backup_manifest.json'), {
    prevVersion: pending.prevVersion || '',
    files: backedUpFiles,
    createdAt: Date.now(),
  });

  const journalPath = join(dataDir, 'apply_journal.json');
  writeJsonAtomic(journalPath, {
    installKind: 'tarball',
    backupDir: backupRoot,
    prevVersion: pending.prevVersion || '',
    targetVersion: pending.targetVersion || '',
    startedAt: Date.now(),
  });

  try {
    // Copy incoming managed files atomically.
    for (const item of manifest) {
      if (!newPaths.has(item.relPath)) continue;
      const src = join(stagedDir, ...item.relPath.split('/'));
      const dst = join(PLUGIN_ROOT, ...item.relPath.split('/'));
      copyFileAtomic(src, dst);
      if (item.sha256 && sha256File(dst) !== item.sha256) {
        throw new Error(`Post-install checksum mismatch: ${item.relPath}`);
      }
    }

    // Delete stale files that existed in previous manifest but not in the new release.
    for (const oldRel of prevFilesList) {
      if (!isAllowedManagedPath(oldRel) || newPaths.has(oldRel)) continue;
      unlinkWithRetry(join(PLUGIN_ROOT, ...oldRel.split('/')));
    }

    writeJsonAtomic(join(dataDir, 'installed_manifest.json'), {
      version: pending.targetVersion || '',
      files: [...newPaths],
      updatedAt: Date.now(),
    });
    writeJsonAtomic(join(dataDir, 'last_backup.json'), {
      installKind: 'tarball',
      prevVersion: pending.prevVersion || '',
      targetVersion: pending.targetVersion || '',
      backupDir: backupRoot,
      appliedAt: Date.now(),
    });

    unlinkWithRetry(journalPath);
    try {
      rmSync(stagedDir, { recursive: true, force: true });
    } catch {
      // ignore staging cleanup failure
    }
    pruneOldBackups(join(dataDir, '.update_backup'), basename(backupRoot));
  } catch (err) {
    try {
      restoreFromBackup(dataDir, {
        installKind: 'tarball',
        backupDir: backupRoot,
        prevVersion: pending.prevVersion || '',
      });
    } catch {
      // ignore
    }
    unlinkWithRetry(journalPath);
    throw err;
  }
}

function pruneOldBackups(backupsParentDir, keepName) {
  try {
    if (!existsSync(backupsParentDir)) return;
    for (const name of readdirSync(backupsParentDir)) {
      if (name !== keepName) {
        rmSync(join(backupsParentDir, name), { recursive: true, force: true });
      }
    }
  } catch {
    // ignore
  }
}

function runBootstrapUpdatePhase(dataDir) {
  const releaseLock = acquireLock(dataDir);
  if (!releaseLock) return;

  try {
    const journalPath = join(dataDir, 'apply_journal.json');
    const pendingPath = join(dataDir, 'pending_update.json');
    const rollbackPath = join(dataDir, 'pending_rollback.json');
    const lastBackupPath = join(dataDir, 'last_backup.json');

    // 1. Recover from any interrupted previous apply.
    const journal = readJsonSafe(journalPath, null);
    if (journal) {
      console.error(`[agy-lens/boot] Recovering interrupted update to ${journal.targetVersion || 'unknown'}`);
      try {
        restoreFromBackup(dataDir, journal);
      } catch (err) {
        console.error(`[agy-lens/boot] Journal recovery failed: ${err.message}`);
      }
      unlinkWithRetry(journalPath);
      unlinkWithRetry(pendingPath);
      recordUpdateFailure(dataDir, journal.targetVersion, 'Previous update was interrupted and rolled back');
      return;
    }

    // 2. Explicit user-requested rollback.
    const rollbackReq = readJsonSafe(rollbackPath, null);
    if (rollbackReq) {
      const backup = readJsonSafe(lastBackupPath, null);
      if (backup) {
        console.error(`[agy-lens/boot] Rolling back to v${backup.prevVersion || 'previous'}`);
        try {
          restoreFromBackup(dataDir, backup);
          const stPath = join(dataDir, 'update_state.json');
          const st = readJsonSafe(stPath, {}) || {};
          st.lastError = null;
          st.rolledBackTo = backup.prevVersion || '';
          writeJsonAtomic(stPath, st);
        } catch (err) {
          console.error(`[agy-lens/boot] Manual rollback failed: ${err.message}`);
        }
      }
      unlinkWithRetry(rollbackPath);
      unlinkWithRetry(pendingPath);
      return;
    }

    // 3. Process pending staged / applied updates.
    const pending = readJsonSafe(pendingPath, null);
    if (!pending) return;

    if (pending.status === 'staged') {
      const shouldApply = Boolean(pending.applyNow) || (pending.autoApply && !pending.requiresHostRestart);
      if (!shouldApply) return;

      try {
        if (pending.installKind === 'git') {
          applyGitUpdate(dataDir, pending);
        } else if (pending.installKind === 'tarball') {
          applyTarballUpdate(dataDir, pending);
        } else {
          throw new Error(`Unsupported installKind: ${pending.installKind}`);
        }

        writeJsonAtomic(pendingPath, {
          ...pending,
          status: 'applied',
          attempts: 1,
          healthy: false,
          appliedAt: Date.now(),
        });
        console.error(`[agy-lens/boot] Applied update v${pending.prevVersion} -> v${pending.targetVersion}`);
      } catch (err) {
        console.error(`[agy-lens/boot] Failed applying update v${pending.targetVersion}: ${err.message}`);
        recordUpdateFailure(dataDir, pending.targetVersion, err.message);
        unlinkWithRetry(pendingPath);
      }
      return;
    }

    if (pending.status === 'applied' && !pending.healthy) {
      const attempts = Number(pending.attempts || 0);
      if (attempts >= 2) {
        console.error(
          `[agy-lens/boot] v${pending.targetVersion} failed health check after ${attempts} attempts; auto-rolling back`
        );
        const backup = readJsonSafe(lastBackupPath, null);
        try {
          restoreFromBackup(dataDir, backup);
        } catch (err) {
          console.error(`[agy-lens/boot] Auto-rollback failed: ${err.message}`);
        }
        recordUpdateFailure(
          dataDir,
          pending.targetVersion,
          `v${pending.targetVersion} failed startup health check and was automatically rolled back`
        );
        unlinkWithRetry(pendingPath);
      } else {
        writeJsonAtomic(pendingPath, { ...pending, attempts: attempts + 1 });
      }
    }
  } finally {
    releaseLock();
  }
}

if (process.env.AGY_LENS_SMOKE !== '1') {
  try {
    const dataDir = resolveDataDir();
    runBootstrapUpdatePhase(dataDir);
  } catch (err) {
    console.error(`[agy-lens/boot] Unexpected bootstrap error: ${err?.message || err}`);
  }
}

await import('./main.mjs');
