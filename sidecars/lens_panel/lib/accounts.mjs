/**
 * Manual Multi-Account Profile, Switch Timeline & Interval Attribution Engine.
 *
 * Strictly local & zero host-credential access:
 * - Never reads OAuth tokens or host logs.
 * - All user-defined accounts, manual switches, and per-conversation overrides live
 *   inside AGY Lens's own telemetry_cache.db and survive `rebuildIndex()`.
 * - Materializes disjoint half-open intervals per source (`cli`, `desktop`) into
 *   `account_intervals` so every telemetry & quota query shares one single SQL truth.
 */
import { randomBytes } from 'node:crypto';

export const DEFAULT_ACCOUNT_ID = 'default';
export const UNATTRIBUTED_ACCOUNT_ID = 'unattributed';
export const VALID_SWITCH_SOURCES = ['all', 'cli', 'desktop'];
export const ACCOUNT_COLORS = [
  '#5b9cf6',
  '#4eb88e',
  '#e8a84a',
  '#a78bfa',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#e06363',
];
export const MAX_INTERVAL_TS = Number.MAX_SAFE_INTEGER;
export const NEAR_SWITCH_THRESHOLD_MS = 5 * 60 * 1000;

const CONVERSATION_ID_RE = /^[0-9a-f-]{8,64}$/i;

export function normalizeSwitchSource(raw) {
  const s = String(raw || 'all').trim().toLowerCase();
  if (s === 'cli' || s === 'desktop' || s === 'all') return s;
  return 'all';
}

export function normalizeAccountColor(raw, fallbackIdx = 0) {
  const s = String(raw || '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  return ACCOUNT_COLORS[Math.abs(Number(fallbackIdx) || 0) % ACCOUNT_COLORS.length];
}

export function normalizeAccountIdFilter(raw) {
  const s = String(raw || 'all').trim();
  if (!s || s.toLowerCase() === 'all') return 'all';
  return s;
}

export function hasAccountSchema(db) {
  if (!db) return false;
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account_intervals'")
      .get();
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * Idempotently create account tables, seed `'default'`, migrate `quota_anchors.account_id`,
 * and ensure `account_intervals` is materialized.
 */
export function ensureAccountSchema(db, nowMs = Date.now()) {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#5b9cf6',
      note TEXT NOT NULL DEFAULT '',
      external_email TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS account_switches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      account_id TEXT NOT NULL,
      effective_from_ms INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_acc_switches_time
      ON account_switches(effective_from_ms ASC, id ASC);

    CREATE TABLE IF NOT EXISTS account_intervals (
      source TEXT NOT NULL,
      from_ms INTEGER NOT NULL,
      to_ms INTEGER NOT NULL,
      account_id TEXT NOT NULL,
      PRIMARY KEY (source, from_ms)
    );
    CREATE INDEX IF NOT EXISTS idx_acc_intervals_range
      ON account_intervals(source, from_ms, to_ms);

    CREATE TABLE IF NOT EXISTS conversation_account_overrides (
      conversation_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Safe migration for pre-v1.12.0 accounts missing external_email
  const accCols = db.prepare('PRAGMA table_info(accounts)').all();
  if (accCols.length > 0 && !accCols.some((c) => c.name === 'external_email')) {
    db.exec("ALTER TABLE accounts ADD COLUMN external_email TEXT NOT NULL DEFAULT ''");
  }

  // Safe migration for pre-v1.10.0 quota_anchors missing account_id
  const qaCols = db.prepare('PRAGMA table_info(quota_anchors)').all();
  if (qaCols.length > 0 && !qaCols.some((c) => c.name === 'account_id')) {
    db.exec("ALTER TABLE quota_anchors ADD COLUMN account_id TEXT NOT NULL DEFAULT 'default'");
  }
  if (qaCols.length > 0) {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_quota_acc_pool_win ON quota_anchors(account_id, pool, window_type, captured_at)'
    );
  }

  // Seed built-in default account
  db.prepare(
    `INSERT OR IGNORE INTO accounts (id, name, color, note, sort_order, created_at, archived_at)
     VALUES (?, ?, ?, '', 0, ?, NULL)`
  ).run(DEFAULT_ACCOUNT_ID, 'Default', ACCOUNT_COLORS[0], nowMs);

  const cntRow = db.prepare('SELECT COUNT(*) as cnt FROM account_intervals').get();
  if (!cntRow || cntRow.cnt === 0) {
    rebuildAccountIntervals(db);
  }
}

/**
 * Pure interval materializer for a single source (`cli` or `desktop`).
 * Resolves `all` vs exact-source precedence and collapses adjacent equal-account spans.
 */
export function computeIntervalsForSource(switches, source, validIds = null) {
  const relevant = [];
  for (const sw of switches || []) {
    if (!sw) continue;
    if (sw.source !== 'all' && sw.source !== source) continue;
    if (validIds && !validIds.has(sw.account_id)) continue;
    const eff = Math.round(Number(sw.effective_from_ms));
    if (!Number.isFinite(eff) || eff < 0) continue;
    relevant.push({
      id: Number(sw.id) || 0,
      source: sw.source,
      account_id: sw.account_id,
      effective_from_ms: eff,
    });
  }

  // Sort ascending by time; for identical timestamps, exact source beats 'all', then higher id wins.
  relevant.sort((a, b) => {
    if (a.effective_from_ms !== b.effective_from_ms) return a.effective_from_ms - b.effective_from_ms;
    const aSpec = a.source === source ? 1 : 0;
    const bSpec = b.source === source ? 1 : 0;
    if (aSpec !== bSpec) return aSpec - bSpec;
    return a.id - b.id;
  });

  // Deduplicate identical timestamps (last item wins)
  const dedup = [];
  for (const sw of relevant) {
    if (dedup.length > 0 && dedup[dedup.length - 1].effective_from_ms === sw.effective_from_ms) {
      dedup[dedup.length - 1] = sw;
    } else {
      dedup.push(sw);
    }
  }

  const raw = [];
  if (dedup.length === 0) {
    raw.push({ source, from_ms: 0, to_ms: MAX_INTERVAL_TS, account_id: DEFAULT_ACCOUNT_ID });
  } else {
    if (dedup[0].effective_from_ms > 0) {
      raw.push({
        source,
        from_ms: 0,
        to_ms: dedup[0].effective_from_ms,
        account_id: DEFAULT_ACCOUNT_ID,
      });
    }
    for (let i = 0; i < dedup.length; i++) {
      const fromMs = dedup[i].effective_from_ms;
      const toMs = i + 1 < dedup.length ? dedup[i + 1].effective_from_ms : MAX_INTERVAL_TS;
      if (toMs <= fromMs) continue;
      raw.push({
        source,
        from_ms: fromMs,
        to_ms: toMs,
        account_id: dedup[i].account_id,
      });
    }
  }

  // Collapse adjacent intervals with the same account_id
  const collapsed = [];
  for (const iv of raw) {
    if (collapsed.length > 0 && collapsed[collapsed.length - 1].account_id === iv.account_id) {
      collapsed[collapsed.length - 1].to_ms = iv.to_ms;
    } else {
      collapsed.push({ ...iv });
    }
  }
  return collapsed;
}

/**
 * Recompute and persist `account_intervals` from `account_switches`.
 * Caller may already be inside a transaction (`inTx = true`).
 */
export function rebuildAccountIntervals(db, { inTx = false } = {}) {
  const validIds = new Set(db.prepare('SELECT id FROM accounts').all().map((r) => r.id));
  const switches = db
    .prepare(
      'SELECT id, source, account_id, effective_from_ms FROM account_switches ORDER BY effective_from_ms ASC, id ASC'
    )
    .all();

  const cliIntervals = computeIntervalsForSource(switches, 'cli', validIds);
  const desktopIntervals = computeIntervalsForSource(switches, 'desktop', validIds);
  const all = [...cliIntervals, ...desktopIntervals];

  const write = () => {
    db.exec('DELETE FROM account_intervals');
    const stmt = db.prepare(
      'INSERT INTO account_intervals (source, from_ms, to_ms, account_id) VALUES (?, ?, ?, ?)'
    );
    for (const iv of all) {
      stmt.run(iv.source, iv.from_ms, iv.to_ms, iv.account_id);
    }
  };

  if (inTx) {
    write();
  } else {
    db.exec('BEGIN IMMEDIATE');
    try {
      write();
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }
  }
  return all;
}

/**
 * Single SQL attribution clause shared by indexer, cache_observatory, and quota queries.
 * Uses unified turn timestamp `COALESCE(completed_at_ms, created_at_ms, 0)` and marks
 * invalid/missing timestamps (<= 0) as `'unattributed'` so corrupt data never leaks into `'default'`.
 */
export function buildTurnAccountSql(turnAlias = 't') {
  const tsExprSql = `COALESCE(${turnAlias}.completed_at_ms, ${turnAlias}.created_at_ms, 0)`;
  const joinSql = `
    LEFT JOIN conversation_account_overrides _cao
      ON _cao.conversation_id = ${turnAlias}.conversation_id
    LEFT JOIN account_intervals _ai
      ON _ai.source = ${turnAlias}.source
     AND ${tsExprSql} > 0
     AND ${tsExprSql} >= _ai.from_ms
     AND ${tsExprSql} < _ai.to_ms
  `;
  const exprSql = `
    CASE
      WHEN _cao.account_id IS NOT NULL THEN _cao.account_id
      WHEN ${tsExprSql} <= 0 THEN '${UNATTRIBUTED_ACCOUNT_ID}'
      ELSE COALESCE(_ai.account_id, '${DEFAULT_ACCOUNT_ID}')
    END
  `;
  return { tsExprSql, joinSql, exprSql };
}

export function resolveActiveAccountAt(db, { source = 'cli', atMs = Date.now() } = {}) {
  if (!hasAccountSchema(db)) {
    return { accountId: DEFAULT_ACCOUNT_ID, nearSwitch: null };
  }
  const src = source === 'desktop' ? 'desktop' : 'cli';
  const ts = Number.isFinite(Number(atMs)) ? Math.round(Number(atMs)) : Date.now();
  const row = db
    .prepare(
      `SELECT account_id FROM account_intervals
       WHERE source = ? AND from_ms <= ? AND to_ms > ?
       LIMIT 1`
    )
    .get(src, ts, ts);
  const accountId = row?.account_id || DEFAULT_ACCOUNT_ID;

  const nearRow = db
    .prepare(
      `SELECT id, source, account_id, effective_from_ms, note
       FROM account_switches
       WHERE (source = 'all' OR source = ?)
         AND ABS(effective_from_ms - ?) <= ?
       ORDER BY ABS(effective_from_ms - ?) ASC
       LIMIT 1`
    )
    .get(src, ts, NEAR_SWITCH_THRESHOLD_MS, ts);

  const nearSwitch = nearRow
    ? {
        id: nearRow.id,
        source: nearRow.source,
        accountId: nearRow.account_id,
        effectiveFromMs: nearRow.effective_from_ms,
        deltaMs: ts - nearRow.effective_from_ms,
        note: nearRow.note || '',
      }
    : null;

  return { accountId, nearSwitch };
}

export function resolveConversationAccount(db, conversationId, { source = 'cli', atMs = 0 } = {}) {
  if (!hasAccountSchema(db)) {
    return { accountId: DEFAULT_ACCOUNT_ID, hasOverride: false };
  }
  const ov = db
    .prepare('SELECT account_id FROM conversation_account_overrides WHERE conversation_id = ?')
    .get(conversationId);
  if (ov?.account_id) {
    return { accountId: ov.account_id, hasOverride: true };
  }
  if (!atMs || atMs <= 0) {
    return { accountId: UNATTRIBUTED_ACCOUNT_ID, hasOverride: false };
  }
  const { accountId } = resolveActiveAccountAt(db, { source, atMs });
  return { accountId, hasOverride: false };
}

function formatAccountRow(r) {
  return {
    id: r.id,
    name: r.name,
    color: r.color || ACCOUNT_COLORS[0],
    note: r.note || '',
    sortOrder: Number(r.sort_order || 0),
    createdAt: Number(r.created_at || 0),
    archivedAt: r.archived_at != null ? Number(r.archived_at) : null,
    isDefault: r.id === DEFAULT_ACCOUNT_ID,
  };
}

function formatSwitchRow(r) {
  return {
    id: r.id,
    source: r.source,
    accountId: r.account_id,
    effectiveFromMs: Number(r.effective_from_ms),
    note: r.note || '',
    createdAt: Number(r.created_at || 0),
  };
}

export function listAccountsState(db, nowMs = Date.now()) {
  if (!hasAccountSchema(db)) {
    const def = {
      id: DEFAULT_ACCOUNT_ID,
      name: 'Default',
      color: ACCOUNT_COLORS[0],
      note: '',
      sortOrder: 0,
      createdAt: 0,
      archivedAt: null,
      isDefault: true,
    };
    return {
      accounts: [def],
      activeAccounts: [def],
      switches: [],
      activeBySource: { cli: DEFAULT_ACCOUNT_ID, desktop: DEFAULT_ACCOUNT_ID },
      activeSwitchBySource: { cli: null, desktop: null },
      multiAccountActive: false,
      unattributedTurns: 0,
    };
  }

  const accounts = db
    .prepare(
      'SELECT * FROM accounts ORDER BY (archived_at IS NOT NULL) ASC, sort_order ASC, created_at ASC, id ASC'
    )
    .all()
    .map(formatAccountRow);
  const activeAccounts = accounts.filter((a) => a.archivedAt === null);

  const switches = db
    .prepare(
      'SELECT * FROM account_switches ORDER BY effective_from_ms DESC, id DESC LIMIT 200'
    )
    .all()
    .map(formatSwitchRow);

  const cliAct = resolveActiveAccountAt(db, { source: 'cli', atMs: nowMs });
  const deskAct = resolveActiveAccountAt(db, { source: 'desktop', atMs: nowMs });

  const findLatestSwitch = (src) => {
    const r = db
      .prepare(
        `SELECT * FROM account_switches
         WHERE (source = 'all' OR source = ?) AND effective_from_ms <= ?
         ORDER BY effective_from_ms DESC, (CASE WHEN source = ? THEN 1 ELSE 0 END) DESC, id DESC
         LIMIT 1`
      )
      .get(src, nowMs, src);
    return r ? formatSwitchRow(r) : null;
  };

  let unattributedTurns = 0;
  try {
    const uRow = db
      .prepare('SELECT COUNT(*) as cnt FROM turns WHERE COALESCE(completed_at_ms, created_at_ms, 0) <= 0')
      .get();
    unattributedTurns = Number(uRow?.cnt || 0);
  } catch {
    unattributedTurns = 0;
  }

  return {
    accounts,
    activeAccounts,
    switches,
    activeBySource: {
      cli: cliAct.accountId,
      desktop: deskAct.accountId,
    },
    activeSwitchBySource: {
      cli: findLatestSwitch('cli'),
      desktop: findLatestSwitch('desktop'),
    },
    multiAccountActive: accounts.length >= 2,
    unattributedTurns,
  };
}

export function findAccountByIdOrName(db, rawQuery) {
  if (!hasAccountSchema(db)) return null;
  const q = String(rawQuery || '').trim();
  if (!q) return null;
  const exact = db.prepare('SELECT * FROM accounts WHERE id = ?').get(q);
  if (exact) return formatAccountRow(exact);
  const byName = db
    .prepare('SELECT * FROM accounts WHERE LOWER(name) = LOWER(?) ORDER BY (archived_at IS NOT NULL) ASC LIMIT 1')
    .get(q);
  return byName ? formatAccountRow(byName) : null;
}

export function createAccount(db, payload = {}, nowMs = Date.now()) {
  ensureAccountSchema(db, nowMs);
  const name = String(payload.name || '').trim().slice(0, 48);
  if (!name) throw new Error('Account name is required');

  const existingCount = Number(db.prepare('SELECT COUNT(*) as cnt FROM accounts').get()?.cnt || 0);
  const id = `acc_${randomBytes(4).toString('hex')}`;
  const color = normalizeAccountColor(payload.color, existingCount);
  const note = String(payload.note || '').trim().slice(0, 160);
  const renameDefaultTo = String(payload.renameDefaultTo || '').trim().slice(0, 48);

  db.exec('BEGIN IMMEDIATE');
  try {
    if (renameDefaultTo) {
      db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(renameDefaultTo, DEFAULT_ACCOUNT_ID);
    }
    db.prepare(
      `INSERT INTO accounts (id, name, color, note, sort_order, created_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    ).run(id, name, color, note, existingCount, nowMs);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }

  const created = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  return {
    account: formatAccountRow(created),
    state: listAccountsState(db, nowMs),
  };
}

export function updateAccount(db, payload = {}, nowMs = Date.now()) {
  ensureAccountSchema(db, nowMs);
  const id = String(payload.id || '').trim();
  if (!id) throw new Error('Account id is required');
  const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!existing) throw new Error(`Account "${id}" not found`);

  const nextName =
    payload.name !== undefined ? String(payload.name || '').trim().slice(0, 48) : existing.name;
  if (!nextName) throw new Error('Account name cannot be empty');

  const nextColor =
    payload.color !== undefined ? normalizeAccountColor(payload.color, 0) : existing.color;
  const nextNote =
    payload.note !== undefined ? String(payload.note || '').trim().slice(0, 160) : existing.note;

  let nextArchivedAt = existing.archived_at;
  if (payload.archived === true) {
    if (id === DEFAULT_ACCOUNT_ID) {
      throw new Error('Default account cannot be archived');
    }
    nextArchivedAt = existing.archived_at ?? nowMs;
  } else if (payload.archived === false) {
    nextArchivedAt = null;
  }

  db.prepare(
    `UPDATE accounts
     SET name = ?, color = ?, note = ?, archived_at = ?
     WHERE id = ?`
  ).run(nextName, nextColor, nextNote, nextArchivedAt, id);

  const updated = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  return {
    account: formatAccountRow(updated),
    state: listAccountsState(db, nowMs),
  };
}

/**
 * Explicitly merge non-default account `fromId` into `toId` without losing any
 * timeline intervals or allowing turns to silently slide back to an earlier account.
 */
export function mergeAccount(db, { fromId, toId, anchorAction = 'reassign' } = {}, nowMs = Date.now()) {
  ensureAccountSchema(db, nowMs);
  const srcId = String(fromId || '').trim();
  const dstId = String(toId || '').trim();
  if (!srcId || !dstId) throw new Error('fromId and toId are required');
  if (srcId === DEFAULT_ACCOUNT_ID) throw new Error('Default account cannot be merged away');
  if (srcId === dstId) throw new Error('Source and target accounts must differ');

  const src = db.prepare('SELECT id FROM accounts WHERE id = ?').get(srcId);
  const dst = db.prepare('SELECT id FROM accounts WHERE id = ?').get(dstId);
  if (!src) throw new Error(`Account "${srcId}" not found`);
  if (!dst) throw new Error(`Target account "${dstId}" not found`);

  const action = anchorAction === 'delete' ? 'delete' : 'reassign';

  db.exec('BEGIN IMMEDIATE');
  try {
    if (action === 'delete') {
      db.prepare('DELETE FROM quota_anchors WHERE account_id = ?').run(srcId);
    } else {
      db.prepare('UPDATE quota_anchors SET account_id = ? WHERE account_id = ?').run(dstId, srcId);
    }
    // Rewrite switches & overrides to target account so [T_k, T_{k+1}) intervals never slip to prior account.
    db.prepare('UPDATE account_switches SET account_id = ? WHERE account_id = ?').run(dstId, srcId);
    db.prepare('UPDATE conversation_account_overrides SET account_id = ?, updated_at = ? WHERE account_id = ?').run(
      dstId,
      nowMs,
      srcId
    );
    db.prepare('DELETE FROM accounts WHERE id = ?').run(srcId);
    rebuildAccountIntervals(db, { inTx: true });
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }

  return {
    merged: { fromId: srcId, toId: dstId, anchorAction: action },
    state: listAccountsState(db, nowMs),
  };
}

function parseOptionalEffectiveMs(raw, nowMs) {
  if (raw === null || raw === undefined || raw === '') return nowMs;
  if (typeof raw === 'boolean' || Array.isArray(raw)) {
    throw new Error('Invalid effectiveFromMs');
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('Invalid effectiveFromMs');
  }
  const effMs = Math.round(n);
  if (effMs > nowMs + 5 * 60 * 1000) {
    throw new Error('Switch timestamp cannot be more than 5 minutes in the future');
  }
  return effMs;
}

/**
 * Preview how many existing turns & conversations would change attribution
 * if a switch `(accountId, source, effectiveFromMs)` were added.
 */
export function previewSwitchImpact(
  db,
  { accountId, source = 'all', effectiveFromMs = null } = {},
  nowMs = Date.now()
) {
  ensureAccountSchema(db, nowMs);
  const accId = String(accountId || '').trim();
  if (!accId) throw new Error('accountId is required');
  const acc = db.prepare('SELECT id, archived_at FROM accounts WHERE id = ?').get(accId);
  if (!acc) throw new Error(`Account "${accId}" not found`);
  if (acc.archived_at != null) throw new Error('Cannot switch to an archived account');

  const src = normalizeSwitchSource(source);
  const effMs = parseOptionalEffectiveMs(effectiveFromMs, nowMs);

  const validIds = new Set(db.prepare('SELECT id FROM accounts').all().map((r) => r.id));
  const curSwitches = db
    .prepare(
      'SELECT id, source, account_id, effective_from_ms FROM account_switches ORDER BY effective_from_ms ASC, id ASC'
    )
    .all();
  const simSwitches = [
    ...curSwitches,
    { id: Number.MAX_SAFE_INTEGER, source: src, account_id: accId, effective_from_ms: effMs },
  ];

  const simBySource = {
    cli: computeIntervalsForSource(simSwitches, 'cli', validIds),
    desktop: computeIntervalsForSource(simSwitches, 'desktop', validIds),
  };

  const resolveFromIntervals = (ivs, ts) => {
    for (const iv of ivs) {
      if (ts >= iv.from_ms && ts < iv.to_ms) return iv.account_id;
    }
    return DEFAULT_ACCOUNT_ID;
  };

  const { tsExprSql, joinSql, exprSql } = buildTurnAccountSql('t');
  const srcFilter = src === 'all' ? "('cli', 'desktop')" : `('${src}')`;
  const rows = db
    .prepare(
      `SELECT t.conversation_id, t.source, ${tsExprSql} AS turn_ts, ${exprSql} AS cur_acc,
              _cao.account_id AS ov_acc
       FROM turns t
       ${joinSql}
       WHERE t.source IN ${srcFilter}
         AND ${tsExprSql} > 0
         AND ${tsExprSql} >= ?`
    )
    .all(effMs);

  let affectedTurns = 0;
  const affectedConvs = new Set();
  const fromAccounts = {};

  for (const r of rows) {
    if (r.ov_acc) continue; // explicit per-conversation override stays pinned
    const nextAcc = resolveFromIntervals(simBySource[r.source] || [], r.turn_ts);
    if (nextAcc !== r.cur_acc) {
      affectedTurns++;
      affectedConvs.add(r.conversation_id);
      fromAccounts[r.cur_acc] = (fromAccounts[r.cur_acc] || 0) + 1;
    }
  }

  return {
    accountId: accId,
    source: src,
    effectiveFromMs: effMs,
    affectedTurns,
    affectedConversations: affectedConvs.size,
    fromAccounts,
  };
}

export function addAccountSwitch(
  db,
  { accountId, source = 'all', effectiveFromMs = null, note = '' } = {},
  nowMs = Date.now()
) {
  ensureAccountSchema(db, nowMs);
  const accId = String(accountId || '').trim();
  if (!accId) throw new Error('accountId is required');
  const acc = db.prepare('SELECT id, archived_at FROM accounts WHERE id = ?').get(accId);
  if (!acc) throw new Error(`Account "${accId}" not found`);
  if (acc.archived_at != null) throw new Error('Cannot switch to an archived account');

  const src = normalizeSwitchSource(source);
  // Server-side Date.now() when effectiveFromMs is omitted (avoids browser clock skew).
  const effMs = parseOptionalEffectiveMs(effectiveFromMs, nowMs);
  const cleanNote = String(note || '').trim().slice(0, 160);

  let insertedId = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const info = db
      .prepare(
        `INSERT INTO account_switches (source, account_id, effective_from_ms, note, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(src, accId, effMs, cleanNote, nowMs);
    insertedId = Number(info.lastInsertRowid);
    rebuildAccountIntervals(db, { inTx: true });
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }

  const row = db.prepare('SELECT * FROM account_switches WHERE id = ?').get(insertedId);
  return {
    switchEntry: formatSwitchRow(row),
    state: listAccountsState(db, nowMs),
  };
}

export function deleteAccountSwitch(db, switchId, nowMs = Date.now()) {
  ensureAccountSchema(db, nowMs);
  const numId = Number(switchId);
  if (!Number.isInteger(numId) || numId <= 0) {
    throw new Error('Invalid switch id');
  }
  let deleted = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const info = db.prepare('DELETE FROM account_switches WHERE id = ?').run(numId);
    deleted = info.changes > 0;
    if (deleted) {
      rebuildAccountIntervals(db, { inTx: true });
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }
  return {
    deleted,
    state: listAccountsState(db, nowMs),
  };
}

export function setConversationAccountOverride(
  db,
  { conversationId, accountId } = {},
  nowMs = Date.now()
) {
  ensureAccountSchema(db, nowMs);
  const cid = String(conversationId || '').trim();
  if (!CONVERSATION_ID_RE.test(cid)) {
    throw new Error('Invalid conversationId format');
  }
  if (accountId === null || accountId === undefined || String(accountId).trim() === '') {
    db.prepare('DELETE FROM conversation_account_overrides WHERE conversation_id = ?').run(cid);
    return { conversationId: cid, accountId: null, cleared: true };
  }
  const accId = String(accountId).trim();
  const acc = db.prepare('SELECT id FROM accounts WHERE id = ?').get(accId);
  if (!acc) throw new Error(`Account "${accId}" not found`);

  db.prepare(
    `INSERT INTO conversation_account_overrides (conversation_id, account_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       account_id = excluded.account_id,
       updated_at = excluded.updated_at`
  ).run(cid, accId, nowMs);
  return { conversationId: cid, accountId: accId, cleared: false };
}

/**
 * Helper for CLI `--at` parsing: supports relative offsets (`-30m`, `-2h`, `-1d`, `now`)
 * as well as ISO timestamps / `YYYY-MM-DD HH:mm`.
 */
export function parseSwitchAtArg(raw, nowMs = Date.now()) {
  if (raw === null || raw === undefined || raw === '' || String(raw).trim().toLowerCase() === 'now') {
    return nowMs;
  }
  const s = String(raw).trim();
  const rel = s.match(/^-(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (rel) {
    const val = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
    return Math.round(nowMs - val * mult);
  }
  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s) ? s.replace(/\s+/, 'T') : s;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --at timestamp: "${s}" (use e.g. -30m, -2h, or YYYY-MM-DD HH:mm)`);
  }
  return parsed;
}
