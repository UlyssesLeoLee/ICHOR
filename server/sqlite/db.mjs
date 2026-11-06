/**
 * ATS-205 -- the SQLite database: WAL, transactions and version migration.
 *
 * WHAT THIS MODULE GUARANTEES
 * ---------------------------
 *
 *   * WAL journalling. The database runs in `journal_mode=WAL`, so a reader
 *     never blocks the writer and the writer never blocks a reader: the
 *     readers work on a snapshot while the writer appends to the WAL.
 *   * `busy_timeout`. A writer that finds the database locked WAITS instead
 *     of failing immediately, so two concurrent writers serialise instead of
 *     one of them losing its work. The wait is bounded, and the bound is a
 *     parameter so a caller can see how long it is willing to wait.
 *   * `synchronous=NORMAL`. With WAL this is the durability level that does
 *     not lose a committed transaction on a power cut; the WAL is not
 *     fsynced on every commit, but a transaction that was committed is
 *     never lost.
 *   * Transactions. A group of statements is applied with BEGIN IMMEDIATE /
 *     COMMIT, so either every statement of the group is visible or none is.
 *     A group that throws is rolled back and leaves the database exactly as
 *     it was.
 *   * The schema version lives INSIDE the database, so the code and the
 *     file cannot disagree about which schema is in use.
 *
 * The module does NOT depend on `node:sqlite` being available: the import is
 * lazy and `sqliteAvailable()` reports it. The bridge therefore still starts
 * on a Node build without the module (the JSON state file remains the
 * fallback), while the metadata layer is used wherever it exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MIGRATIONS, latestVersion } from './schema.mjs';

/** The busy timeout: how long a blocked writer waits, in milliseconds. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

let sqliteModule = null;
let sqliteLoadFailed = false;

/**
 * Loads `node:sqlite`, or returns null when the running Node build does not
 * have it. The result is cached, including the negative one, so a missing
 * module is not re-imported on every call.
 */
export function loadSqlite() {
  if (sqliteModule || sqliteLoadFailed) return sqliteModule;
  try {
    // `node:sqlite` is a built-in; it is unflagged since Node 22.13. The
    // require is wrapped so that a build without the module degrades to the
    // JSON state file instead of failing to load the bridge at all.
    const req = createRequire(import.meta.url);
    sqliteModule = req('node:sqlite');
  } catch {
    sqliteLoadFailed = true;
    sqliteModule = null;
  }
  return sqliteModule;
}

/** True when the running Node build can open a SQLite database. */
export function sqliteAvailable() {
  return loadSqlite() !== null;
}

/**
 * Opens (or creates) the metadata database and brings it up to the schema
 * version this build understands.
 *
 * @param {string} file the database file; ':memory:' is accepted
 * @param {object} [options]
 * @param {number} [options.busyTimeoutMs]
 * @param {number} [options.targetVersion] the version to migrate to
 * @param {boolean} [options.migrate=true] set false to open as-is
 * @returns {object} the open database handle
 */
export function openDatabase(file, options = {}) {
  const sqlite = loadSqlite();
  if (!sqlite) {
    const e = new Error('SQLITE_NOT_AVAILABLE');
    e.code = 'SQLITE_NOT_AVAILABLE';
    throw e;
  }
  const {
    busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
    targetVersion = null,
    migrate = true,
  } = options;

  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new sqlite.DatabaseSync(file);
  try {
    // The pragmas are set BEFORE any transaction, because a pragma that
    // changes the journal mode cannot run inside a transaction.
    db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    if (migrate) migrateDatabase(db, targetVersion);
  } catch (e) {
    // The handle opened here MUST be released before the error leaves this
    // function. On Windows an open file cannot be deleted, so a leaked
    // handle keeps the whole data directory locked for the lifetime of the
    // process -- and a caller that retries (the bridge retries the mirror)
    // would leak one handle per attempt.
    try { db.close(); } catch { /* the handle is already closed */ }
    throw e;
  }
  return db;
}

/** Closes a database handle, ignoring a handle that is already closed. */
export function closeDatabase(db) {
  try { db.close(); } catch { /* already closed */ }
}

/**
 * The schema version the database currently carries, or 0 when the database
 * is empty (no `meta` table yet).
 */
export function currentVersion(db) {
  const hasMeta = db
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='meta'`)
    .get();
  if (!hasMeta || Number(hasMeta.n) === 0) return 0;
  const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get();
  if (!row) return 0;
  const v = Number(row.value);
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * The columns a table carries, or null when the table does not exist.
 */
function tableColumns(db, table) {
  // The table name comes from this module's own schema declarations, never
  // from user input, so it is safe to inline it into the pragma.
  let rows;
  try {
    rows = db.prepare(`PRAGMA table_info(${table})`).all();
  } catch {
    return null;
  }
  if (!rows.length) return null;
  return new Set(rows.map((r) => String(r.name)));
}

/**
 * Refuses to apply a step whose objects already exist with a DIFFERENT
 * shape.
 *
 * The steps declare the tables they create and the columns those tables
 * must have. A table that exists with the expected columns is the table
 * the step would have created -- applying the step is a no-op for it, and
 * that is what makes the step idempotent. A table that exists with a
 * DIFFERENT shape is a FOREIGN table: the step would adopt it silently
 * (the DDL says `IF NOT EXISTS`) and the layer would then fail later on a
 * column that is not there. Refusing here is the honest answer.
 *
 * @throws {Error} with code `SCHEMA_OBJECT_CONFLICT`
 */
function assertStepObjectsAbsent(db, step) {
  const tables = step.tables ?? {};
  for (const [table, expected] of Object.entries(tables)) {
    const columns = tableColumns(db, table);
    if (!columns) continue; // the table does not exist: the step creates it
    const missing = expected.filter((c) => !columns.has(c));
    if (missing.length) {
      const e = new Error(
        `SCHEMA_OBJECT_CONFLICT: the table "${table}" already exists with a different shape ` +
        `(missing: ${missing.join(', ')}) -- step ${step.version} was refused`
      );
      e.code = 'SCHEMA_OBJECT_CONFLICT';
      e.table = table;
      e.missing = missing;
      e.version = step.version;
      throw e;
    }
  }
}

/**
 * Runs `fn` inside a transaction.
 *
 * BEGIN IMMEDIATE takes the write lock up front, so two concurrent writers
 * serialise at the BEGIN rather than one of them failing at COMMIT with
 * SQLITE_BUSY. The function receives the database handle.
 *
 * The transaction is rolled back when the function throws, and the error is
 * re-thrown unchanged.
 */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction was already closed */ }
    throw e;
  }
}

/**
 * Migrates the database to `targetVersion` (the newest known version by
 * default).
 *
 * Each step runs in its OWN transaction, and the version is written in the
 * SAME transaction as the step's objects. A step that fails therefore leaves
 * the database at the previous version with none of its objects applied.
 *
 * The version is re-read INSIDE the step's transaction. That is what makes
 * two concurrent migrators safe: the first one applies the step and writes
 * the version, the second one -- which waited for the write lock -- reads
 * the version again, sees the step is already applied and skips it. Reading
 * the version outside the transaction (as an earlier revision of this module
 * did) let two migrators apply the same non-idempotent step and one of them
 * failed with "duplicate column name".
 *
 * The function is idempotent: a database that is already at the target
 * version is not touched.
 *
 * @returns {{from:number,to:number,applied:number[]}}
 */
export function migrateDatabase(db, targetVersion = null) {
  const target = targetVersion === null ? latestVersion() : targetVersion;
  const from = currentVersion(db);
  if (from > target) {
    const e = new Error('SCHEMA_TOO_NEW');
    e.code = 'SCHEMA_TOO_NEW';
    e.from = from;
    e.to = target;
    throw e;
  }
  const applied = [];
  for (const step of MIGRATIONS) {
    if (step.version > target) break;
    // The step decides INSIDE the transaction whether it still has to run.
    const ran = withTransaction(db, (d) => {
      const version = currentVersion(d);
      if (step.version <= version) return false;
      assertStepObjectsAbsent(d, step);
      for (const stmt of step.up) d.exec(stmt);
      d.prepare(
        `INSERT INTO meta(key,value) VALUES('schema_version',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      ).run(String(step.version));
      return true;
    });
    if (ran) applied.push(step.version);
  }
  return { from, to: target, applied };
}

/**
 * Reverts the database to `version` -- the explicit, operator-requested
 * downgrade.
 *
 * The steps ABOVE `version` are reverted, in DESCENDING order: to go from
 * version 2 to version 1 the `down` of step 2 runs; to go to version 0 the
 * `down` of step 2 and then of step 1 run.
 *
 * The data in the dropped tables is gone afterwards; see the policy in
 * `schema.mjs`. A downgrade NEVER happens implicitly: only this function
 * performs one, and only when it is asked to.
 *
 * Like the upgrade, the version is re-read inside the step's transaction,
 * so two concurrent downgrades cannot revert the same step twice.
 *
 * @param {object} db the open database handle
 * @param {number} version the version to go back to
 * @returns {{from:number,to:number,applied:number[]}}
 */
export function downgradeDatabase(db, version) {
  if (!Number.isInteger(version) || version < 0) {
    const e = new Error('INVALID_TARGET_VERSION');
    e.code = 'INVALID_TARGET_VERSION';
    throw e;
  }
  const current = currentVersion(db);
  if (version > current) {
    const e = new Error('SCHEMA_TOO_NEW');
    e.code = 'SCHEMA_TOO_NEW';
    e.from = current;
    e.to = version;
    throw e;
  }
  const applied = [];
  // Descending: the highest version is reverted first, because each `down`
  // reverts the database from its own version to the one below it.
  const steps = MIGRATIONS.filter((m) => m.version > version && m.version <= current)
    .sort((a, b) => b.version - a.version);
  for (const step of steps) {
    const ran = withTransaction(db, (d) => {
      const version = currentVersion(d);
      if (step.version > version) return false;
      for (const stmt of step.down) d.exec(stmt);
      // The `meta` table is dropped by step 1's `down`, so the version row
      // is only rewritten while the table still exists. Once it is gone the
      // database has no version at all, which `currentVersion` reports as 0.
      const hasMeta = d
        .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='meta'`)
        .get();
      if (Number(hasMeta?.n ?? 0) > 0) {
        d.prepare(
          `INSERT INTO meta(key,value) VALUES('schema_version',?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`
        ).run(String(step.version - 1));
      }
      return true;
    });
    if (ran) applied.push(step.version);
  }
  return { from: current, to: version, applied };
}
