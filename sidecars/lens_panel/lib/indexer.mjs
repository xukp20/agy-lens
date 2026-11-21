/**
 * WAL-aware incremental SQLite indexer & telemetry query engine for AGY Lens.
 * Source conversation DBs are ALWAYS opened strictly read-only.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeWorkspaceUri,
  parseGenMetadata,
  parseStep15Metadata,
  parseTrajectoryMetaBlob,
} from './protobuf.mjs';
import { calculateTurnCost, inferPool, normalizeModelId } from './pricing.mjs';
import { computeCacheObservatory } from './cache_observatory.mjs';

const MAX_GEN_METADATA_BYTES = 2097152; // 2 MB cap
const UUID_DB_RE = /^([0-9a-f-]{8,})\.db$/i;

export function resolveDataDir() {
  const dir =
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-lens', 'lens_panel', 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveSourceDirs() {
  let desktopDir = join(homedir(), '.gemini', 'antigravity');
  const envDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (envDataDir) {
    for (let d = envDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        desktopDir = dirname(d);
        break;
      }
    }
  }
  const cliDir = join(homedir(), '.gemini', 'antigravity-cli');
  return { desktop: desktopDir, cli: cliDir };
}

export function openTelemetryCacheDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'telemetry_cache.db');
  const db = new DatabaseSync(dbPath, { timeout: 2000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 2000;

    CREATE TABLE IF NOT EXISTS indexed_files (
      db_path TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      source TEXT NOT NULL,
      db_mtime_ms REAL NOT NULL,
      db_size INTEGER NOT NULL,
      wal_mtime_ms REAL NOT NULL,
      wal_size INTEGER NOT NULL,
      max_step15_idx INTEGER NOT NULL DEFAULT -1,
      max_gen_idx INTEGER NOT NULL DEFAULT -1,
      title TEXT NOT NULL DEFAULT '',
      workspace TEXT NOT NULL DEFAULT '',
      last_activity_ms INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turns (
      conversation_id TEXT NOT NULL,
      step_idx INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at_ms INTEGER,
      first_token_at_ms INTEGER,
      completed_at_ms INTEGER,
      ttft_ms INTEGER,
      gen_ms INTEGER,
      model_enum INTEGER,
      raw_model_id TEXT,
      canonical_model_id TEXT,
      display_name TEXT,
      pool TEXT,
      provider_enum INTEGER,
      provider_request_id TEXT NOT NULL DEFAULT '',
      uncached_in INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_create INTEGER NOT NULL DEFAULT 0,
      thinking_out INTEGER NOT NULL DEFAULT 0,
      visible_out INTEGER NOT NULL DEFAULT 0,
      total_out INTEGER NOT NULL DEFAULT 0,
      context_est INTEGER,
      compact_limit INTEGER,
      PRIMARY KEY (conversation_id, step_idx)
    );
    CREATE INDEX IF NOT EXISTS idx_turns_completed ON turns(completed_at_ms);
    CREATE INDEX IF NOT EXISTS idx_turns_source_completed ON turns(source, completed_at_ms);

    CREATE TABLE IF NOT EXISTS model_enums (
      model_enum INTEGER PRIMARY KEY,
      raw_model_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quota_anchors (
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
    CREATE INDEX IF NOT EXISTS idx_quota_pool_win ON quota_anchors(pool, window_type, captured_at);
  `);

  // Safe migration for pre-existing cache DBs missing provider_request_id.
  const cols = db.prepare('PRAGMA table_info(turns)').all();
  if (!cols.some((c) => c.name === 'provider_request_id')) {
    db.exec("ALTER TABLE turns ADD COLUMN provider_request_id TEXT NOT NULL DEFAULT ''");
  }

  // Self-heal legacy 0-token turns captured mid-stream (status=2) before v1.2.1.
  // Rewinds only affected conversations' high-water marks while preserving quota_anchors.
  const zeroConvs = db
    .prepare(
      `SELECT conversation_id, source, MIN(step_idx) AS min_zero_idx
       FROM turns
       WHERE (uncached_in + cache_read + cache_create + total_out) = 0
       GROUP BY conversation_id, source`
    )
    .all();
  if (zeroConvs.length > 0) {
    const rewindFile = db.prepare(
      `UPDATE indexed_files
       SET max_step15_idx = MIN(max_step15_idx, ?),
           max_gen_idx = -1,
           db_mtime_ms = 0,
           wal_mtime_ms = 0,
           wal_size = -1
       WHERE conversation_id = ? AND source = ?`
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of zeroConvs) {
        rewindFile.run(Math.max(-1, Number(row.min_zero_idx) - 1), row.conversation_id, row.source);
      }
      db.exec('DELETE FROM turns WHERE (uncached_in + cache_read + cache_create + total_out) = 0');
      db.exec('COMMIT');
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
    }
  }

  return { db, dbPath };
}

function statDbAndWal(dbPath) {
  const dbStat = statSync(dbPath);
  let walMtimeMs = 0;
  let walSize = 0;
  try {
    const w = statSync(dbPath + '-wal');
    if (w.size > 0) {
      walMtimeMs = w.mtimeMs;
      walSize = w.size;
    }
  } catch {
    // No active -wal file.
  }
  return {
    dbMtimeMs: dbStat.mtimeMs,
    dbSize: dbStat.size,
    walMtimeMs,
    walSize,
    newestMtimeMs: Math.max(dbStat.mtimeMs, walMtimeMs),
  };
}

function listConversationDbs(sourceDirs, enabledSources) {
  const results = [];
  for (const source of enabledSources) {
    const baseDir = sourceDirs[source];
    if (!baseDir) continue;
    const convDir = join(baseDir, 'conversations');
    if (!existsSync(convDir)) continue;
    let entries;
    try {
      entries = readdirSync(convDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const m = UUID_DB_RE.exec(name);
      if (!m) continue;
      results.push({
        source,
        conversationId: m[1],
        dbPath: join(convDir, name),
      });
    }
  }
  return results;
}

function loadSummariesMap(sourceDirs, enabledSources) {
  const map = new Map();
  for (const source of enabledSources) {
    const baseDir = sourceDirs[source];
    if (!baseDir) continue;
    const sumPath = join(baseDir, 'conversation_summaries.db');
    if (!existsSync(sumPath)) continue;
    let sdb;
    try {
      sdb = new DatabaseSync(sumPath, { readOnly: true, timeout: 50 });
      const rows = sdb
        .prepare('SELECT conversation_id, title, workspace_uris FROM conversation_summaries')
        .all();
      for (const r of rows) {
        if (!r.conversation_id) continue;
        let ws = '';
        if (r.workspace_uris) {
          try {
            const arr = JSON.parse(r.workspace_uris);
            if (Array.isArray(arr) && arr[0]) ws = normalizeWorkspaceUri(arr[0]);
          } catch {
            // ignore malformed JSON
          }
        }
        const existing = map.get(r.conversation_id);
        map.set(r.conversation_id, {
          title: r.title || existing?.title || '',
          workspace: ws || existing?.workspace || '',
        });
      }
    } catch {
      // Ignore busy/missing summaries DB.
    } finally {
      try {
        sdb?.close();
      } catch {
        // ignore
      }
    }
  }
  return map;
}

function loadLearnedEnums(cacheDb) {
  const map = new Map();
  const rows = cacheDb.prepare('SELECT model_enum, raw_model_id, display_name FROM model_enums').all();
  for (const r of rows) {
    map.set(Number(r.model_enum), { rawModelId: r.raw_model_id, displayName: r.display_name });
  }
  return map;
}

function indexSingleDb(cacheDb, entry, summariesMap, learnedEnums) {
  let stats;
  try {
    stats = statDbAndWal(entry.dbPath);
  } catch {
    return { changed: false, error: 'stat_failed' };
  }

  const prev = cacheDb
    .prepare(
      'SELECT db_mtime_ms, db_size, wal_mtime_ms, wal_size, max_step15_idx, max_gen_idx, title, workspace, last_activity_ms FROM indexed_files WHERE db_path = ?'
    )
    .get(entry.dbPath);

  if (
    prev &&
    prev.db_mtime_ms === stats.dbMtimeMs &&
    prev.db_size === stats.dbSize &&
    prev.wal_mtime_ms === stats.walMtimeMs &&
    prev.wal_size === stats.walSize
  ) {
    return { changed: false };
  }

  const lastStepIdx = prev ? prev.max_step15_idx : -1;
  const lastGenIdx = prev ? prev.max_gen_idx : -1;

  let srcDb;
  let stepRows = [];
  let genRows = [];
  let workspace = prev?.workspace || '';
  try {
    srcDb = new DatabaseSync(entry.dbPath, { readOnly: true, timeout: 50 });
    stepRows = srcDb
      .prepare(
        'SELECT idx, status, metadata FROM steps WHERE step_type = 15 AND idx > ? ORDER BY idx ASC'
      )
      .all(lastStepIdx);
    genRows = srcDb
      .prepare(
        `SELECT idx, data FROM gen_metadata WHERE idx > ? AND length(data) <= ${MAX_GEN_METADATA_BYTES} ORDER BY idx ASC`
      )
      .all(lastGenIdx);

    if (!workspace) {
      const tm = srcDb
        .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
        .get();
      if (tm?.data) {
        workspace = parseTrajectoryMetaBlob(tm.data).workspace || '';
      }
    }
  } catch (err) {
    return { changed: false, error: err.message };
  } finally {
    try {
      srcDb?.close();
    } catch {
      // ignore
    }
  }

  const sumInfo = summariesMap.get(entry.conversationId);
  if (!workspace && sumInfo?.workspace) workspace = sumInfo.workspace;
  const title = sumInfo?.title || prev?.title || '';

  const genByStepIdx = new Map();
  let maxGenIdx = lastGenIdx;
  const newEnumEntries = [];

  for (const row of genRows) {
    if (row.idx > maxGenIdx) maxGenIdx = row.idx;
    if (!row.data) continue;
    const parsed = parseGenMetadata(row.data, { includeBreakdown: false });
    if (parsed.modelEnum && parsed.modelId) {
      learnedEnums.set(Number(parsed.modelEnum), {
        rawModelId: parsed.modelId,
        displayName: parsed.displayName || '',
      });
      newEnumEntries.push([Number(parsed.modelEnum), parsed.modelId, parsed.displayName || '']);
    }
    if (parsed.stepIdxs.length > 0) {
      genByStepIdx.set(parsed.stepIdxs[0], parsed);
    }
  }

  const enumIdMap = new Map();
  for (const [k, v] of learnedEnums.entries()) {
    enumIdMap.set(k, v.rawModelId);
  }

  let maxStepIdx = lastStepIdx;
  let hitInFlight = false;
  let lastActivityMs = prev?.last_activity_ms || 0;
  const now = Date.now();
  const insertedStepIdxs = new Set();

  const insertTurn = cacheDb.prepare(`
    INSERT OR REPLACE INTO turns (
      conversation_id, step_idx, source,
      created_at_ms, first_token_at_ms, completed_at_ms, ttft_ms, gen_ms,
      model_enum, raw_model_id, canonical_model_id, display_name, pool, provider_enum, provider_request_id,
      uncached_in, cache_read, cache_create, thinking_out, visible_out, total_out,
      context_est, compact_limit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertEnum = cacheDb.prepare(`
    INSERT OR REPLACE INTO model_enums (model_enum, raw_model_id, display_name, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  const upsertFile = cacheDb.prepare(`
    INSERT OR REPLACE INTO indexed_files (
      db_path, conversation_id, source,
      db_mtime_ms, db_size, wal_mtime_ms, wal_size,
      max_step15_idx, max_gen_idx, title, workspace, last_activity_ms, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  cacheDb.exec('BEGIN IMMEDIATE');
  try {
    for (const [mEnum, rawId, disp] of newEnumEntries) {
      upsertEnum.run(mEnum, rawId, disp, now);
    }

    for (const sRow of stepRows) {
      const meta = parseStep15Metadata(sRow.metadata);
      const totalTokens =
        (meta.uncachedIn || 0) +
        (meta.cacheRead || 0) +
        (meta.cacheCreate || 0) +
        (meta.totalOut || 0);
      const isInFlight =
        sRow.status === 1 ||
        sRow.status === 2 ||
        (meta.completedAtMs == null && totalTokens === 0);

      if (isInFlight) {
        // Hold high-water mark before any still-streaming step so its final usage is indexed on completion.
        hitInFlight = true;
        if (meta.createdAtMs && meta.createdAtMs > lastActivityMs) {
          lastActivityMs = meta.createdAtMs;
        }
        continue;
      }

      if (totalTokens === 0) {
        // Terminated step (e.g. cancelled/errored) with zero usage: skip turn row but advance watermark.
        if (!hitInFlight && sRow.idx > maxStepIdx) maxStepIdx = sRow.idx;
        continue;
      }

      if (!hitInFlight && sRow.idx > maxStepIdx) maxStepIdx = sRow.idx;
      const gen = genByStepIdx.get(sRow.idx);

      const modelEnum = gen?.modelEnum ?? meta.modelEnum ?? null;
      const learned = modelEnum !== null ? learnedEnums.get(Number(modelEnum)) : null;
      const rawModelId = gen?.modelId || learned?.rawModelId || '';
      const canonicalModelId = normalizeModelId(rawModelId, modelEnum, enumIdMap);
      const displayName =
        gen?.displayName || learned?.displayName || rawModelId || canonicalModelId;
      const pool = inferPool(canonicalModelId, rawModelId);
      const completedAtMs = meta.completedAtMs ?? meta.firstTokenAtMs ?? meta.createdAtMs ?? 0;
      if (completedAtMs > lastActivityMs) lastActivityMs = completedAtMs;

      insertTurn.run(
        entry.conversationId,
        sRow.idx,
        entry.source,
        meta.createdAtMs,
        meta.firstTokenAtMs,
        completedAtMs,
        gen?.ttftMs ?? meta.ttftMs,
        gen?.genMs ?? meta.genMs,
        modelEnum,
        rawModelId,
        canonicalModelId,
        displayName,
        pool,
        meta.providerEnum,
        meta.providerRequestId || '',
        meta.uncachedIn,
        meta.cacheRead,
        meta.cacheCreate,
        meta.thinkingOut,
        meta.visibleOut,
        meta.totalOut,
        gen?.contextEst ?? null,
        gen?.compactLimit ?? null
      );
      insertedStepIdxs.add(sRow.idx);
    }

    // Backfill gen_metadata fields onto already-indexed turns if gen_metadata landed after step_type=15.
    if (genByStepIdx.size > 0) {
      const updateTurnGen = cacheDb.prepare(`
        UPDATE turns
        SET raw_model_id = COALESCE(NULLIF(?, ''), raw_model_id),
            canonical_model_id = ?,
            display_name = COALESCE(NULLIF(?, ''), display_name),
            pool = ?,
            ttft_ms = COALESCE(?, ttft_ms),
            gen_ms = COALESCE(?, gen_ms),
            context_est = COALESCE(?, context_est),
            compact_limit = COALESCE(?, compact_limit)
        WHERE conversation_id = ? AND step_idx = ?
      `);
      for (const [stepIdx, gen] of genByStepIdx.entries()) {
        if (insertedStepIdxs.has(stepIdx)) continue;
        const canonical = normalizeModelId(gen.modelId, gen.modelEnum, enumIdMap);
        updateTurnGen.run(
          gen.modelId,
          canonical,
          gen.displayName,
          inferPool(canonical, gen.modelId),
          gen.ttftMs,
          gen.genMs,
          gen.contextEst,
          gen.compactLimit,
          entry.conversationId,
          stepIdx
        );
      }
    }

    upsertFile.run(
      entry.dbPath,
      entry.conversationId,
      entry.source,
      stats.dbMtimeMs,
      stats.dbSize,
      hitInFlight ? 0 : stats.walMtimeMs,
      hitInFlight ? -1 : stats.walSize,
      maxStepIdx,
      hitInFlight ? lastGenIdx : maxGenIdx,
      title,
      workspace,
      lastActivityMs,
      now
    );
    cacheDb.exec('COMMIT');
  } catch (err) {
    try {
      cacheDb.exec('ROLLBACK');
    } catch {
      // ignore
    }
    return { changed: false, error: err.message };
  }

  return { changed: true };
}

export function runIncrementalIndex(cacheDb, { sources = ['desktop', 'cli'] } = {}) {
  const t0 = Date.now();
  const sourceDirs = resolveSourceDirs();
  const dbList = listConversationDbs(sourceDirs, sources);
  const summariesMap = loadSummariesMap(sourceDirs, sources);
  const learnedEnums = loadLearnedEnums(cacheDb);

  let changedDbs = 0;
  for (const entry of dbList) {
    const res = indexSingleDb(cacheDb, entry, summariesMap, learnedEnums);
    if (res.changed) changedDbs++;
  }

  return {
    scannedDbs: dbList.length,
    changedDbs,
    elapsedMs: Date.now() - t0,
  };
}

export function rebuildIndex(cacheDb, { sources = ['desktop', 'cli'] } = {}) {
  cacheDb.exec('BEGIN IMMEDIATE');
  try {
    // Never touch quota_anchors!
    cacheDb.exec('DELETE FROM turns; DELETE FROM indexed_files;');
    cacheDb.exec('COMMIT');
  } catch (err) {
    try {
      cacheDb.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }
  return runIncrementalIndex(cacheDb, { sources });
}

export function getIndexStatus(cacheDb) {
  const rows = cacheDb
    .prepare(
      'SELECT source, COUNT(*) as cnt, MAX(indexed_at) as last_at FROM indexed_files GROUP BY source'
    )
    .all();
  let desktopDbs = 0;
  let cliDbs = 0;
  let lastIndexedAt = null;
  for (const r of rows) {
    if (r.source === 'desktop') desktopDbs = r.cnt;
    if (r.source === 'cli') cliDbs = r.cnt;
    if (r.last_at && (!lastIndexedAt || r.last_at > lastIndexedAt)) {
      lastIndexedAt = r.last_at;
    }
  }
  const turnRow = cacheDb.prepare('SELECT COUNT(*) as cnt FROM turns').get();
  return {
    desktopDbs,
    cliDbs,
    indexedTurns: turnRow?.cnt || 0,
    lastIndexedAt,
  };
}

function findConversationEntry(sourceDirs, conversationId) {
  for (const source of ['desktop', 'cli']) {
    const p = join(sourceDirs[source], 'conversations', `${conversationId}.db`);
    if (existsSync(p)) {
      return { source, conversationId, dbPath: p };
    }
  }
  return null;
}

function discoverActiveConversationEntry(sourceDirs) {
  // 1. Prefer active Desktop presence/*.lock with newest DB/WAL mtime.
  const presenceDir = join(sourceDirs.desktop, 'presence');
  if (existsSync(presenceDir)) {
    let best = null;
    try {
      for (const name of readdirSync(presenceDir)) {
        if (!name.endsWith('.lock')) continue;
        const cid = name.slice(0, -5);
        const dbPath = join(sourceDirs.desktop, 'conversations', `${cid}.db`);
        if (!existsSync(dbPath)) continue;
        const m = statDbAndWal(dbPath).newestMtimeMs;
        if (!best || m > best.mtimeMs) {
          best = { source: 'desktop', conversationId: cid, dbPath, mtimeMs: m };
        }
      }
    } catch {
      // ignore
    }
    if (best) return best;
  }

  // 2. Fallback: newest DB/WAL across desktop, then cli.
  for (const source of ['desktop', 'cli']) {
    const list = listConversationDbs(sourceDirs, [source]);
    let best = null;
    for (const entry of list) {
      try {
        const m = statDbAndWal(entry.dbPath).newestMtimeMs;
        if (!best || m > best.mtimeMs) {
          best = { ...entry, mtimeMs: m };
        }
      } catch {
        // ignore
      }
    }
    if (best) return best;
  }
  return null;
}

function readLatestBreakdown(dbPath) {
  let srcDb;
  try {
    srcDb = new DatabaseSync(dbPath, { readOnly: true, timeout: 50 });
    const row = srcDb
      .prepare(
        `SELECT data FROM gen_metadata WHERE length(data) <= ${MAX_GEN_METADATA_BYTES} ORDER BY idx DESC LIMIT 1`
      )
      .get();
    if (!row?.data) return null;
    return parseGenMetadata(row.data, { includeBreakdown: true });
  } catch {
    return null;
  } finally {
    try {
      srcDb?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Module-gated single-conversation telemetry for `GET /api/session`.
 * Never scans all conversation DBs.
 */
export function getSessionSnapshot(cacheDb, pricingState, { conversationId = '', modules = null } = {}) {
  const sourceDirs = resolveSourceDirs();
  const entry = conversationId
    ? findConversationEntry(sourceDirs, conversationId)
    : discoverActiveConversationEntry(sourceDirs);

  if (!entry) {
    return {
      conversationId: conversationId || null,
      source: null,
      title: '',
      workspace: '',
      found: false,
      indexedAt: Date.now(),
      liveContext: null,
      cacheDiagnostics: null,
      ioFlow: null,
    };
  }

  const summariesMap = loadSummariesMap(sourceDirs, [entry.source]);
  const learnedEnums = loadLearnedEnums(cacheDb);
  indexSingleDb(cacheDb, entry, summariesMap, learnedEnums);

  const fileRow = cacheDb
    .prepare('SELECT title, workspace, indexed_at FROM indexed_files WHERE db_path = ?')
    .get(entry.dbPath);
  const turns = cacheDb
    .prepare('SELECT * FROM turns WHERE conversation_id = ? ORDER BY step_idx ASC')
    .all(entry.conversationId);

  const wantAll = !modules || modules.size === 0;
  const wantLive = wantAll || modules.has('live-context');
  const wantCache = wantAll || modules.has('cache-diagnostics');
  const wantIo = wantAll || modules.has('io-flow');

  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  let liveContext = null;
  if (wantLive) {
    const latestGen = readLatestBreakdown(entry.dbPath);
    const modelId =
      latestTurn?.canonical_model_id ||
      normalizeModelId(latestGen?.modelId || '', latestGen?.modelEnum ?? null);
    const displayName = latestTurn?.display_name || latestGen?.displayName || modelId;
    const contextUsed = latestGen?.contextEst ?? latestTurn?.context_est ?? 0;
    const compactLimit = latestGen?.compactLimit ?? latestTurn?.compact_limit ?? 512000;
    const ratio = compactLimit > 0 ? contextUsed / compactLimit : 0;

    let minStart = Infinity;
    let maxEnd = 0;
    for (const t of turns) {
      const s = t.created_at_ms || t.completed_at_ms;
      const e = t.completed_at_ms || t.created_at_ms;
      if (s && s < minStart) minStart = s;
      if (e && e > maxEnd) maxEnd = e;
    }
    const sessionDurationMs = Number.isFinite(minStart) && maxEnd >= minStart ? maxEnd - minStart : 0;

    liveContext = {
      modelId,
      displayName,
      pool: latestTurn?.pool || inferPool(modelId),
      contextUsed,
      compactLimit,
      ratio,
      turnCount: turns.length,
      sessionDurationMs,
      breakdown: latestGen?.breakdown || [],
    };
  }

  let cacheDiagnostics = null;
  let ioFlow = null;

  if (wantCache || wantIo) {
    let totalUncachedIn = 0;
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    let totalThinkingOut = 0;
    let totalVisibleOut = 0;
    let totalOut = 0;
    let totalCostUsd = 0;
    let totalSavedUsd = 0;
    let longContextTurns = 0;
    let unpricedTurns = 0;
    let ttftSum = 0;
    let ttftCnt = 0;
    let genSum = 0;
    let genCnt = 0;

    const turnCacheRows = [];
    let prevHitRatio = null;

    for (const t of turns) {
      const cost = calculateTurnCost(t, pricingState);
      totalUncachedIn += t.uncached_in;
      totalCacheRead += t.cache_read;
      totalCacheCreate += t.cache_create;
      totalThinkingOut += t.thinking_out;
      totalVisibleOut += t.visible_out;
      totalOut += t.total_out;
      totalCostUsd += cost.costUsd;
      totalSavedUsd += cost.cacheSavedUsd;
      if (cost.longContext) longContextTurns++;
      if (cost.unpriced) unpricedTurns++;
      if (t.ttft_ms != null && t.ttft_ms >= 0) {
        ttftSum += t.ttft_ms;
        ttftCnt++;
      }
      if (t.gen_ms != null && t.gen_ms >= 0) {
        genSum += t.gen_ms;
        genCnt++;
      }

      const denom = t.cache_read + t.uncached_in + t.cache_create;
      const hitRatio = denom > 0 ? t.cache_read / denom : 0;
      const cold = t.cache_read === 0;
      const drop = Boolean(
        !cold && prevHitRatio !== null && prevHitRatio >= 0.4 && hitRatio < prevHitRatio - 0.25
      );
      prevHitRatio = hitRatio;

      turnCacheRows.push({
        stepIdx: t.step_idx,
        completedAt: t.completed_at_ms || t.created_at_ms || 0,
        cacheRead: t.cache_read,
        uncachedIn: t.uncached_in,
        hitRatio,
        cold,
        drop,
      });
    }

    if (wantCache) {
      const last = turnCacheRows.length > 0 ? turnCacheRows[turnCacheRows.length - 1] : null;
      const sessDenom = totalCacheRead + totalUncachedIn + totalCacheCreate;
      cacheDiagnostics = {
        lastTurn: last
          ? {
              hitRatio: last.hitRatio,
              cacheRead: last.cacheRead,
              uncachedIn: last.uncachedIn,
              cold: last.cold,
            }
          : { hitRatio: 0, cacheRead: 0, uncachedIn: 0, cold: true },
        session: {
          hitRatio: sessDenom > 0 ? totalCacheRead / sessDenom : 0,
          totalCacheRead,
          totalUncachedIn,
          cacheSavedUsd: totalSavedUsd,
        },
        turns: turnCacheRows,
      };
    }

    if (wantIo) {
      ioFlow = {
        uncachedIn: totalUncachedIn,
        cacheRead: totalCacheRead,
        cacheCreate: totalCacheCreate,
        thinkingOut: totalThinkingOut,
        visibleOut: totalVisibleOut,
        totalOut,
        totalTokens: totalUncachedIn + totalCacheRead + totalCacheCreate + totalOut,
        avgTtftMs: ttftCnt > 0 ? Math.round(ttftSum / ttftCnt) : 0,
        avgGenMs: genCnt > 0 ? Math.round(genSum / genCnt) : 0,
        costUsd: totalCostUsd,
        longContextTurns,
        unpricedTurns,
      };
    }
  }

  return {
    conversationId: entry.conversationId,
    source: entry.source,
    title: fileRow?.title || '',
    workspace: fileRow?.workspace || '',
    found: true,
    indexedAt: fileRow?.indexed_at || Date.now(),
    liveContext,
    cacheDiagnostics,
    ioFlow,
  };
}

export function localDateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseLocalDateRange(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const da = Number(m[3]);
  const start = new Date(y, mo, da, 0, 0, 0, 0).getTime();
  const end = new Date(y, mo, da, 23, 59, 59, 999).getTime();
  return { start, end };
}

export function resolveTimeRange(rangeKey = '7d', fromParam = null, toParam = null, nowMs = Date.now()) {
  const key = ['today', '5h', '7d', '30d', '90d', 'all', 'custom'].includes(rangeKey)
    ? rangeKey
    : '7d';

  if (key === 'today') {
    const d = new Date(nowMs);
    const fromMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
    return { key, fromMs, toMs: nowMs };
  }
  if (key === '5h') return { key, fromMs: nowMs - 5 * 3600 * 1000, toMs: nowMs };
  if (key === '7d') return { key, fromMs: nowMs - 7 * 86400 * 1000, toMs: nowMs };
  if (key === '30d') return { key, fromMs: nowMs - 30 * 86400 * 1000, toMs: nowMs };
  if (key === '90d') return { key, fromMs: nowMs - 90 * 86400 * 1000, toMs: nowMs };
  if (key === 'all') return { key, fromMs: 0, toMs: nowMs };

  let fromMs = 0;
  let toMs = nowMs;
  if (fromParam) {
    const parsed = parseLocalDateRange(fromParam);
    fromMs = parsed ? parsed.start : Number(fromParam) || 0;
  }
  if (toParam) {
    const parsed = parseLocalDateRange(toParam);
    toMs = parsed ? parsed.end : Number(toParam) || nowMs;
  }
  return { key: 'custom', fromMs, toMs };
}

function queryTurnsWithWorkspace(cacheDb, { sources, fromMs, toMs, workspace = '' }) {
  if (!sources || sources.length === 0) return [];
  const placeholders = sources.map(() => '?').join(',');
  let sql = `
    SELECT t.*, COALESCE(f.workspace, '') AS workspace, COALESCE(f.title, '') AS title
    FROM turns t
    LEFT JOIN indexed_files f ON f.conversation_id = t.conversation_id AND f.source = t.source
    WHERE t.source IN (${placeholders})
      AND t.completed_at_ms >= ?
      AND t.completed_at_ms <= ?
  `;
  const params = [...sources, fromMs, toMs];
  if (workspace) {
    sql += ' AND f.workspace = ?';
    params.push(workspace);
  }
  sql += ' ORDER BY t.completed_at_ms ASC';
  return cacheDb.prepare(sql).all(...params);
}

/**
 * Multi-DB analytics for `GET /api/analytics`.
 */
export function getAnalytics(
  cacheDb,
  pricingState,
  {
    range = '7d',
    from = null,
    to = null,
    sources = ['desktop', 'cli'],
    modules = null,
    workspace = '',
    gapBreakpointsSec = null,
  } = {}
) {
  const nowMs = Date.now();
  const activeSources = sources.filter((s) => s === 'desktop' || s === 'cli');
  const indexStats = runIncrementalIndex(cacheDb, { sources: activeSources });
  const rangeObj = resolveTimeRange(range, from, to, nowMs);

  const wantAll = !modules || modules.size === 0;
  const wantIo = wantAll || modules.has('io-flow');
  const wantModel = wantAll || modules.has('model-cost');
  const wantCal = wantAll || modules.has('calendar-trends');
  const wantObs = wantAll || modules.has('cache-observatory');

  const turns =
    wantIo || wantModel
      ? queryTurnsWithWorkspace(cacheDb, {
          sources: activeSources,
          fromMs: rangeObj.fromMs,
          toMs: rangeObj.toMs,
          workspace,
        })
      : [];

  let uncachedIn = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let thinkingOut = 0;
  let visibleOut = 0;
  let totalOut = 0;
  let totalCostUsd = 0;
  let cacheSavedUsd = 0;
  let unpricedTurns = 0;
  let longContextTurns = 0;
  let ttftSum = 0;
  let ttftCnt = 0;
  let genSum = 0;
  let genCnt = 0;
  let minTs = Infinity;
  let maxTs = 0;

  const modelMap = new Map();
  const wsMap = new Map();

  for (const t of turns) {
    const cost = calculateTurnCost(t, pricingState);
    const tTokens = t.uncached_in + t.cache_read + t.cache_create + t.total_out;

    uncachedIn += t.uncached_in;
    cacheRead += t.cache_read;
    cacheCreate += t.cache_create;
    thinkingOut += t.thinking_out;
    visibleOut += t.visible_out;
    totalOut += t.total_out;
    totalCostUsd += cost.costUsd;
    cacheSavedUsd += cost.cacheSavedUsd;
    if (cost.unpriced) unpricedTurns++;
    if (cost.longContext) longContextTurns++;
    if (t.ttft_ms != null && t.ttft_ms >= 0) {
      ttftSum += t.ttft_ms;
      ttftCnt++;
    }
    if (t.gen_ms != null && t.gen_ms >= 0) {
      genSum += t.gen_ms;
      genCnt++;
    }
    if (t.completed_at_ms > 0) {
      if (t.completed_at_ms < minTs) minTs = t.completed_at_ms;
      if (t.completed_at_ms > maxTs) maxTs = t.completed_at_ms;
    }

    if (wantModel) {
      const mKey = t.canonical_model_id || 'unknown';
      let m = modelMap.get(mKey);
      if (!m) {
        m = {
          canonicalId: mKey,
          displayName: t.display_name || mKey,
          pool: cost.pool || t.pool || 'gemini',
          turns: 0,
          uncachedIn: 0,
          cacheRead: 0,
          cacheCreate: 0,
          totalOut: 0,
          thinkingOut: 0,
          longContextTurns: 0,
          costUsd: 0,
          cacheSavedUsd: 0,
          pricingSource: cost.pricingSource,
        };
        modelMap.set(mKey, m);
      }
      m.turns++;
      m.uncachedIn += t.uncached_in;
      m.cacheRead += t.cache_read;
      m.cacheCreate += t.cache_create;
      m.totalOut += t.total_out;
      m.thinkingOut += t.thinking_out;
      if (cost.longContext) m.longContextTurns++;
      m.costUsd += cost.costUsd;
      m.cacheSavedUsd += cost.cacheSavedUsd;
      if (cost.pricingSource === 'override') m.pricingSource = 'override';

      const wsKey = t.workspace || '(unknown)';
      let w = wsMap.get(wsKey);
      if (!w) {
        w = { workspace: wsKey, turns: 0, totalTokens: 0, costUsd: 0 };
        wsMap.set(wsKey, w);
      }
      w.turns++;
      w.totalTokens += tTokens;
      w.costUsd += cost.costUsd;
    }
  }

  const totalTokens = uncachedIn + cacheRead + cacheCreate + totalOut;
  let spanHours;
  if (rangeObj.key === 'all') {
    spanHours = Number.isFinite(minTs) && maxTs > minTs ? Math.max(0.25, (maxTs - minTs) / 3600000) : 1;
  } else {
    spanHours = Math.max(0.25, (Math.min(nowMs, rangeObj.toMs) - rangeObj.fromMs) / 3600000);
  }

  const ioFlow = wantIo
    ? {
        uncachedIn,
        cacheRead,
        cacheCreate,
        thinkingOut,
        visibleOut,
        totalOut,
        totalTokens,
        turns: turns.length,
        burnTokensPerHr: totalTokens / spanHours,
        burnUsdPerHr: totalCostUsd / spanHours,
        avgTtftMs: ttftCnt > 0 ? Math.round(ttftSum / ttftCnt) : 0,
        avgGenMs: genCnt > 0 ? Math.round(genSum / genCnt) : 0,
        costUsd: totalCostUsd,
        longContextTurns,
        unpricedTurns,
      }
    : null;

  let modelCost = null;
  if (wantModel) {
    const models = [...modelMap.values()]
      .map((m) => {
        const denom = m.cacheRead + m.uncachedIn + m.cacheCreate;
        return {
          canonicalId: m.canonicalId,
          displayName: m.displayName,
          pool: m.pool,
          turns: m.turns,
          uncachedIn: m.uncachedIn,
          cacheRead: m.cacheRead,
          totalOut: m.totalOut,
          thinkingOut: m.thinkingOut,
          cacheHitRatio: denom > 0 ? m.cacheRead / denom : 0,
          longContextTurns: m.longContextTurns,
          costUsd: m.costUsd,
          cacheSavedUsd: m.cacheSavedUsd,
          share: totalCostUsd > 0 ? m.costUsd / totalCostUsd : turns.length > 0 ? m.turns / turns.length : 0,
          pricingSource: m.pricingSource,
        };
      })
      .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns);

    const workspaces = [...wsMap.values()].sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns);

    modelCost = {
      totalCostUsd,
      cacheSavedUsd,
      unpricedTurns,
      longContextTurns,
      models,
      workspaces,
    };
  }

  let calendarTrends = null;
  if (wantCal) {
    const calFromMs = Math.min(rangeObj.fromMs || nowMs - 90 * 86400 * 1000, nowMs - 90 * 86400 * 1000);
    const calTurns = queryTurnsWithWorkspace(cacheDb, {
      sources: activeSources,
      fromMs: Math.max(0, calFromMs),
      toMs: nowMs,
      workspace,
    });
    const dayMap = new Map();
    const hourDayMatrix = Array.from({ length: 7 }, () => Array(24).fill(0));

    for (const t of calTurns) {
      if (!t.completed_at_ms) continue;
      const cost = calculateTurnCost(t, pricingState);
      const dk = localDateKey(t.completed_at_ms);
      let d = dayMap.get(dk);
      if (!d) {
        d = { date: dk, turns: 0, totalTokens: 0, costUsd: 0, cacheRead: 0, uncachedIn: 0, cacheCreate: 0 };
        dayMap.set(dk, d);
      }
      d.turns++;
      d.totalTokens += t.uncached_in + t.cache_read + t.cache_create + t.total_out;
      d.costUsd += cost.costUsd;
      d.cacheRead += t.cache_read;
      d.uncachedIn += t.uncached_in;
      d.cacheCreate += t.cache_create;

      const dt = new Date(t.completed_at_ms);
      hourDayMatrix[dt.getDay()][dt.getHours()] += cost.costUsd;
    }

    const days = [...dayMap.values()]
      .map((d) => {
        const denom = d.cacheRead + d.uncachedIn + d.cacheCreate;
        return {
          date: d.date,
          turns: d.turns,
          totalTokens: d.totalTokens,
          costUsd: d.costUsd,
          cacheHitRatio: denom > 0 ? d.cacheRead / denom : 0,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    const todayKey = localDateKey(nowMs);
    const todayEntry = dayMap.get(todayKey);
    const todayCostUsd = todayEntry ? todayEntry.costUsd : 0;

    let prev7Sum = 0;
    for (let i = 1; i <= 7; i++) {
      const k = localDateKey(nowMs - i * 86400 * 1000);
      prev7Sum += dayMap.get(k)?.costUsd || 0;
    }
    const avg7dCostUsd = prev7Sum / 7;
    const deltaVs7dPct = avg7dCostUsd > 0 ? ((todayCostUsd - avg7dCostUsd) / avg7dCostUsd) * 100 : null;

    let streakDays = 0;
    const startOffset = dayMap.has(todayKey) ? 0 : 1;
    for (let i = startOffset; i < 365; i++) {
      const k = localDateKey(nowMs - i * 86400 * 1000);
      if (dayMap.has(k) && dayMap.get(k).turns > 0) {
        streakDays++;
      } else {
        break;
      }
    }

    calendarTrends = {
      days,
      streakDays,
      todayCostUsd,
      avg7dCostUsd,
      deltaVs7dPct,
      hourDayMatrix,
    };
  }

  const cacheObservatory = wantObs
    ? computeCacheObservatory(cacheDb, pricingState, {
        sources: activeSources,
        fromMs: rangeObj.fromMs,
        toMs: rangeObj.toMs,
        workspace,
        gapBreakpointsSec,
      })
    : null;

  return {
    range: rangeObj,
    sources: activeSources,
    indexStats,
    ioFlow,
    modelCost,
    calendarTrends,
    cacheObservatory,
  };
}

export function getDayDetail(cacheDb, pricingState, { date, sources = ['desktop', 'cli'] } = {}) {
  const bounds = parseLocalDateRange(date);
  if (!bounds) {
    return { date: date || '', totals: { turns: 0, totalTokens: 0, costUsd: 0 }, conversations: [], models: [] };
  }
  const activeSources = sources.filter((s) => s === 'desktop' || s === 'cli');
  runIncrementalIndex(cacheDb, { sources: activeSources });

  const turns = queryTurnsWithWorkspace(cacheDb, {
    sources: activeSources,
    fromMs: bounds.start,
    toMs: bounds.end,
  });

  const convMap = new Map();
  const modelMap = new Map();
  let totalTurns = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;

  for (const t of turns) {
    const cost = calculateTurnCost(t, pricingState);
    const tTokens = t.uncached_in + t.cache_read + t.cache_create + t.total_out;
    totalTurns++;
    totalTokens += tTokens;
    totalCostUsd += cost.costUsd;

    const cKey = `${t.source}:${t.conversation_id}`;
    let c = convMap.get(cKey);
    if (!c) {
      c = {
        conversationId: t.conversation_id,
        source: t.source,
        title: t.title || t.conversation_id.slice(0, 8),
        workspace: t.workspace || '',
        turns: 0,
        totalTokens: 0,
        costUsd: 0,
        modelSet: new Set(),
      };
      convMap.set(cKey, c);
    }
    c.turns++;
    c.totalTokens += tTokens;
    c.costUsd += cost.costUsd;
    c.modelSet.add(t.canonical_model_id || 'unknown');

    const mKey = t.canonical_model_id || 'unknown';
    let m = modelMap.get(mKey);
    if (!m) {
      m = {
        canonicalId: mKey,
        displayName: t.display_name || mKey,
        pool: cost.pool || t.pool || 'gemini',
        turns: 0,
        totalTokens: 0,
        costUsd: 0,
      };
      modelMap.set(mKey, m);
    }
    m.turns++;
    m.totalTokens += tTokens;
    m.costUsd += cost.costUsd;
  }

  const conversations = [...convMap.values()]
    .map((c) => ({
      conversationId: c.conversationId,
      source: c.source,
      title: c.title,
      workspace: c.workspace,
      turns: c.turns,
      totalTokens: c.totalTokens,
      costUsd: c.costUsd,
      models: [...c.modelSet],
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns);

  const models = [...modelMap.values()].sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns);

  return {
    date,
    totals: { turns: totalTurns, totalTokens, costUsd: totalCostUsd },
    conversations,
    models,
  };
}
