/**
 * ATS-205 -- the SQLite metadata layer: WAL, transactions and migration.
 *
 * The cases are numbered so that a failure names the rule it broke:
 *
 *   UT-SQL-001 …  the WAL / pragma contract
 *   UT-SQL-010 …  the transaction contract
 *   UT-SQL-020 …  the schema version and the migration contract
 *   UT-SQL-030 …  the mirror (the database holds exactly the state)
 *   UT-SQL-040 …  the concurrency contract (no lost records)
 *   UT-SQL-050 …  the command line tool
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  openDatabase, closeDatabase, currentVersion, withTransaction,
  migrateDatabase, downgradeDatabase, sqliteAvailable, DEFAULT_BUSY_TIMEOUT_MS,
} from '../server/sqlite/db.mjs';
import { storeState, loadStateFrom, counts, runsOfProject, attemptsOfRun } from '../server/sqlite/store.mjs';
import { importState, verifyMirror } from '../server/sqlite/import.mjs';
import { SCHEMA_VERSION, MIGRATIONS, latestVersion, stepFor } from '../server/sqlite/schema.mjs';
import { main as cliMain } from '../tools/sqlite_meta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'sqlite_meta.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ats-sqlite-'));

/**
 * The URL of a module of THIS repository, as an ESM specifier.
 *
 * A Windows absolute path (`C:\\...\\db.mjs`) is NOT a valid ESM
 * specifier: importing it fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME` and
 * the child process dies before it ever touches the database. Every
 * child process in this file therefore imports the module by its `file://`
 * URL.
 */
const moduleUrl = (...parts) =>
  pathToFileURL(path.join(ROOT, ...parts)).href;

/**
 * Spawns a child process that takes the WRITE LOCK of the database and
 * holds it until it is told to let go.
 *
 * The child writes `LOCKED` on stdout as soon as its transaction is open,
 * so the parent can wait for the lock to be REALLY held before it tries to
 * write -- a sleep would be a guess, a message is a fact.
 *
 * @param {string} file the database file
 * @param {number} holdMs how long the child holds the lock
 * @returns {{child:object, locked:Promise<void>, released:Promise<void>, stderr:string}}
 */
function spawnLockHolder(file, holdMs) {
  const dir = path.dirname(file);
  const script = path.join(dir, `holder-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(script, `
import { openDatabase, closeDatabase } from ${JSON.stringify(moduleUrl('server', 'sqlite', 'db.mjs'))};
const [file, holdMs] = process.argv.slice(2);
const db = openDatabase(file, { migrate: false });
db.exec('BEGIN IMMEDIATE');
console.log('LOCKED');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
db.exec('COMMIT');
closeDatabase(db);
console.log('RELEASED');
`, 'utf8');
  const child = spawn(process.execPath, [script, file, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let stderr = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const locked = new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (out.includes('LOCKED')) { clearInterval(timer); resolve(); }
    }, 10);
    child.on('close', () => { clearInterval(timer); reject(new Error(`the lock holder exited: ${stderr}`)); });
  });
  const released = new Promise((resolve) => child.on('close', resolve));
  return { child, locked, released, stderr: () => stderr };
}

function sampleState() {
  return {
    schema: 1,
    projects: [
      { id: 'proj_1_aaaa', uid: 'proj_1_aaaa', name: 'alpha', root: '/tmp/alpha', addedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'proj_1_bbbb', uid: 'proj_1_bbbb', name: 'beta', root: '/tmp/beta', addedAt: '2026-01-02T00:00:00.000Z' },
    ],
    runs: [
      {
        id: 'run_1_0001', uid: 'run_1_0001', seq: 1, projectId: 'proj_1_aaaa',
        projectUid: 'proj_1_aaaa', status: 'passed', createdAt: '2026-01-01T00:00:01.000Z',
        finishedAt: '2026-01-01T00:00:09.000Z', gitCommit: 'abc1234',
        attempts: [{ uid: 'att_1_1', testUid: 'tc-1', retry: 0, status: 'passed', caseStatus: 'expected', duration: 12 }],
        artifacts: [{ file: 'trace.zip', sha256: 'ff'.repeat(32), size: 1024 }],
      },
      {
        id: 'run_1_0002', uid: 'run_1_0002', seq: 2, projectId: 'proj_1_aaaa',
        projectUid: 'proj_1_aaaa', status: 'failed', createdAt: '2026-01-02T00:00:01.000Z',
        gitCommit: 'def5678', attempts: [], artifacts: [],
      },
    ],
    uidRegistry: {
      version: 1,
      projects: {
        proj_1_aaaa: { entries: [{ uid: 'tc-1', file: 'tests/a.spec.ts', title: 'works', bodyKey: 'k1' }] },
      },
    },
    runCounters: { proj_1_aaaa: 2 },
  };
}

// ---------------------------------------------------------------------------
// The WAL / pragma contract
// ---------------------------------------------------------------------------

test('UT-SQL-001: the metadata layer is available on this Node build', () => {
  // `node:sqlite` is unflagged since Node 22.13; the project requires
  // Node >= 22, so the layer has to work without a flag.
  assert.equal(sqliteAvailable(), true);
});

test('UT-SQL-002: the database runs in WAL mode', () => {
  const dir = tmp();
  try {
    const db = openDatabase(path.join(dir, 'metadata.db'));
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    } finally { closeDatabase(db); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-003: a blocked writer waits instead of failing at once', async () => {
  const dir = tmp();
  const file = path.join(dir, 'metadata.db');
  try {
    // The database exists before the lock holder opens it.
    closeDatabase(openDatabase(file));

    // A second process holds the write lock. It announces that it is in
    // the transaction, so the writer below really contends for the lock.
    const holder = spawnLockHolder(file, 1500);
    await holder.locked;

    // The blocked writer opens its own connection and writes. With the
    // busy timeout it WAITS for the lock and succeeds once it is released.
    const started = Date.now();
    const db = openDatabase(file, { migrate: false });
    try {
      withTransaction(db, (d) => {
        d.prepare('INSERT INTO run_counters(project_id,seq) VALUES(?,?)').run('p1', 7);
      });
      const waited = Date.now() - started;
      assert.ok(
        waited >= 200,
        `the writer did not wait for the lock (${waited} ms) -- it cannot have been blocked`
      );
      assert.equal(
        Number(db.prepare('SELECT seq FROM run_counters WHERE project_id=?').get('p1').seq),
        7,
        'the blocked writer did not commit its row'
      );
    } finally { closeDatabase(db); }
    await holder.released;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-003b: with the busy timeout at 0 the blocked writer fails instead of waiting', async () => {
  const dir = tmp();
  const file = path.join(dir, 'metadata.db');
  try {
    closeDatabase(openDatabase(file));
    const holder = spawnLockHolder(file, 1500);
    await holder.locked;

    // The SAME contention, but the writer is told not to wait at all.
    // It has to fail -- which is what proves that the wait in UT-SQL-003
    // was the busy timeout doing its job and not luck.
    const db = openDatabase(file, { migrate: false, busyTimeoutMs: 0 });
    try {
      assert.throws(
        () => withTransaction(db, (d) => {
          d.prepare('INSERT INTO run_counters(project_id,seq) VALUES(?,?)').run('p1', 7);
        }),
        /lock|busy/i,
        'the writer did not fail even though it was told not to wait'
      );
    } finally { closeDatabase(db); }
    await holder.released;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-004: the busy timeout is configurable', () => {
  const dir = tmp();
  try {
    const db = openDatabase(path.join(dir, 'metadata.db'), { busyTimeoutMs: 1234 });
    try {
      assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 1234);
    } finally { closeDatabase(db); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-005: a WAL database leaves the -wal sidecar behind', () => {
  const dir = tmp();
  try {
    const db = openDatabase(path.join(dir, 'metadata.db'));
    storeState(db, sampleState());
    // In WAL mode the write-ahead log is a file of its own while the
    // database is open: that is the evidence that the mode is really WAL
    // and not merely reported as such.
    assert.ok(fs.existsSync(path.join(dir, 'metadata.db-wal')), 'the -wal sidecar is missing');
    closeDatabase(db);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The transaction contract
// ---------------------------------------------------------------------------

test('UT-SQL-010: a committed transaction is visible to a reader', () => {
  const db = openDatabase(':memory:');
  try {
    withTransaction(db, (d) => {
      d.prepare('INSERT INTO run_counters(project_id,seq) VALUES(?,?)').run('p1', 5);
    });
    assert.equal(Number(db.prepare('SELECT seq FROM run_counters WHERE project_id=?').get('p1').seq), 5);
  } finally { closeDatabase(db); }
});

test('UT-SQL-011: a transaction that throws is rolled back whole', () => {
  const db = openDatabase(':memory:');
  try {
    withTransaction(db, (d) => {
      d.prepare('INSERT INTO run_counters(project_id,seq) VALUES(?,?)').run('p1', 5);
    });
    assert.throws(() => {
      withTransaction(db, (d) => {
        d.prepare('INSERT INTO run_counters(project_id,seq) VALUES(?,?)').run('p2', 9);
        throw new Error('boom');
      });
    }, /boom/);
    // The row written by the failed transaction is GONE, and the row written
    // by the earlier committed transaction is still there.
    assert.equal(db.prepare('SELECT count(*) AS n FROM run_counters').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM run_counters WHERE project_id=?').get('p2').n, 0);
  } finally { closeDatabase(db); }
});

test('UT-SQL-012: the state is written in ONE transaction, so a reader never sees half of it', () => {
  const db = openDatabase(':memory:');
  try {
    const state = sampleState();
    storeState(db, state);
    // The state is replaced, not merged: the rows of the previous state
    // are gone in the same transaction that writes the new ones.
    storeState(db, { schema: 1, projects: [], runs: [], uidRegistry: { version: 1, projects: {} }, runCounters: {} });
    const c = counts(db);
    assert.equal(c.projects, 0);
    assert.equal(c.runs, 0);
    assert.equal(c.runCounters, 0);
    assert.equal(c.uidRegistry, 0);
  } finally { closeDatabase(db); }
});

// ---------------------------------------------------------------------------
// The schema version and the migration contract
// ---------------------------------------------------------------------------

test('UT-SQL-020: a fresh database is at the newest known version', () => {
  const db = openDatabase(':memory:');
  try {
    assert.equal(currentVersion(db), latestVersion());
    assert.equal(latestVersion(), SCHEMA_VERSION);
  } finally { closeDatabase(db); }
});

test('UT-SQL-021: the schema version lives INSIDE the database', () => {
  const db = openDatabase(':memory:');
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get();
    assert.ok(row, 'the meta table carries no schema_version row');
    assert.equal(Number(row.value), latestVersion());
  } finally { closeDatabase(db); }
});

test('UT-SQL-022: the migration is idempotent', () => {
  const db = openDatabase(':memory:');
  try {
    const second = migrateDatabase(db, null);
    assert.deepEqual(second.applied, [], 'a second migration applied something');
    assert.equal(currentVersion(db), latestVersion());
  } finally { closeDatabase(db); }
});

test('UT-SQL-023: a migration to an older version applies only the missing steps', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'metadata.db');
    // A database at version 1: migrate only to version 1, so the step 2
    // objects must NOT exist.
    const db = openDatabase(file, { targetVersion: 1 });
    assert.equal(currentVersion(db), 1);
    const hasArtifacts = db
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='artifacts'`)
      .get().n;
    assert.equal(Number(hasArtifacts), 0, 'the step 2 table exists in a version 1 database');
    closeDatabase(db);

    // Upgrading to the newest version applies step 2.
    const db2 = openDatabase(file);
    try {
      assert.equal(currentVersion(db2), latestVersion());
      const hasArtifacts2 = db2
        .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='artifacts'`)
        .get().n;
      assert.equal(Number(hasArtifacts2), 1, 'the step 2 table is missing after the upgrade');
    } finally { closeDatabase(db2); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-024: a failed migration step leaves the version and the objects untouched', () => {
  const db = openDatabase(':memory:');
  // A step that fails: its first statement is valid, its second is not.
  // The step is injected into the real migration list, so the failure
  // happens inside the REAL runner and not in a hand-written transaction.
  const broken = {
    version: latestVersion() + 1,
    name: 'broken-step',
    tables: { broken_probe: ['a'] },
    up: ['CREATE TABLE broken_probe(a TEXT)', 'THIS IS NOT SQL'],
    down: ['DROP TABLE IF EXISTS broken_probe'],
  };
  MIGRATIONS.push(broken);
  try {
    const before = currentVersion(db);
    assert.throws(
      () => migrateDatabase(db, null),
      (e) => /not a valid|not sql|syntax/i.test(e.message),
      'the broken step did not fail'
    );
    // The version did not move...
    assert.equal(currentVersion(db), before, 'the version moved although the step failed');
    // ...and the first statement of the step was rolled back with it.
    const tables = db
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='broken_probe'`)
      .get().n;
    assert.equal(Number(tables), 0, 'the failed step left its first statement applied');
  } finally {
    MIGRATIONS.pop();
    closeDatabase(db);
  }
});

test('UT-SQL-025: a database that is NEWER than the code is refused, not downgraded silently', () => {
  const db = openDatabase(':memory:');
  try {
    // Pretend the file carries a version from the future.
    db.prepare(`UPDATE meta SET value=? WHERE key='schema_version'`).run(String(latestVersion() + 5));
    assert.throws(() => migrateDatabase(db, null), (e) => e.code === 'SCHEMA_TOO_NEW');
    assert.equal(currentVersion(db), latestVersion() + 5, 'the version was changed by the refused migration');
  } finally { closeDatabase(db); }
});

test('UT-SQL-026: a downgrade drops the higher version and its data', () => {
  const db = openDatabase(':memory:');
  try {
    storeState(db, sampleState());
    assert.ok(counts(db).testAttempts > 0, 'the fixture wrote no attempts');
    // Going back to version 1 reverts step 2: the attempts and the
    // artifacts are dropped, and their data is gone with them.
    const result = downgradeDatabase(db, 1);
    assert.deepEqual(result.applied, [2]);
    assert.equal(currentVersion(db), 1);
    const hasArtifacts = db
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='artifacts'`)
      .get().n;
    assert.equal(Number(hasArtifacts), 0, 'the downgraded table still exists');
    assert.equal(counts(db).testAttempts, 0, 'the dropped table still holds rows');
    // The tables of version 1 are still there.
    assert.equal(counts(db).projects, 2);
  } finally { closeDatabase(db); }
});

test('UT-SQL-027: a downgrade to version 0 removes every table', () => {
  const db = openDatabase(':memory:');
  try {
    downgradeDatabase(db, 0);
    assert.equal(currentVersion(db), 0);
    const tables = db
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .get().n;
    assert.equal(Number(tables), 0, 'tables survived the downgrade to version 0');
  } finally { closeDatabase(db); }
});

test('UT-SQL-028: a downgrade to a version the database does not have is refused', () => {
  const db = openDatabase(':memory:');
  try {
    assert.throws(() => downgradeDatabase(db, 99), (e) => e.code === 'SCHEMA_TOO_NEW');
    // The refused downgrade changed nothing.
    assert.equal(currentVersion(db), latestVersion());
  } finally { closeDatabase(db); }
});

test('UT-SQL-029: every migration step declares an up AND a down script', () => {
  assert.ok(MIGRATIONS.length >= 2, 'the schema needs at least two versions to be versioned');
  for (const step of MIGRATIONS) {
    assert.ok(Array.isArray(step.up) && step.up.length, `step ${step.version} has no up script`);
    assert.ok(Array.isArray(step.down) && step.down.length, `step ${step.version} has no down script`);
    assert.equal(stepFor(step.version), step);
    // The version of a step is the version the database has AFTER the step.
    assert.ok(step.version >= 1);
  }
  // The versions are contiguous and start at 1: a gap would leave a
  // database that cannot be migrated at all.
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, versions.map((_, i) => i + 1));
});

test('UT-SQL-030: a step that fails leaves no half-applied objects behind', () => {
  const db = openDatabase(':memory:');
  try {
    const before = currentVersion(db);
    // A step whose second statement is invalid: the first statement must
    // be rolled back with it, because the step runs in ONE transaction.
    assert.throws(() => {
      withTransaction(db, (d) => {
        d.exec('CREATE TABLE half_applied(x TEXT)');
        d.exec('CREATE TABLE half_applied TOO (x TEXT)');
      });
    });
    const tables = db
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='half_applied'`)
      .get().n;
    assert.equal(Number(tables), 0, 'the failed step left its first statement applied');
    assert.equal(currentVersion(db), before);
  } finally { closeDatabase(db); }
});

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

test('UT-SQL-040: the database holds exactly the state that was imported', () => {
  const db = openDatabase(':memory:');
  try {
    const state = sampleState();
    const report = importState(db, state);
    assert.equal(report.projects, 2);
    assert.equal(report.runs, 2);
    assert.equal(report.uidRegistry, 1);
    assert.equal(report.runCounters, 1);
    const check = verifyMirror(db, state);
    assert.equal(check.ok, true, check.problems.join('; '));
  } finally { closeDatabase(db); }
});

test('UT-SQL-041: the import is idempotent', () => {
  const db = openDatabase(':memory:');
  try {
    const state = sampleState();
    importState(db, state);
    const first = JSON.stringify(loadStateFrom(db));
    importState(db, state);
    const second = JSON.stringify(loadStateFrom(db));
    assert.equal(first, second, 'a second import changed the database');
    assert.equal(verifyMirror(db, state).ok, true);
  } finally { closeDatabase(db); }
});

test('UT-SQL-042: a record keeps every field, including one the layer does not model', () => {
  const db = openDatabase(':memory:');
  try {
    const state = sampleState();
    state.projects[0].someFutureField = { nested: [1, 2, 3] };
    importState(db, state);
    const read = loadStateFrom(db);
    assert.deepEqual(read.projects[0].someFutureField, { nested: [1, 2, 3] });
  } finally { closeDatabase(db); }
});

test('UT-SQL-043: the mirror reports a difference instead of hiding it', () => {
  const db = openDatabase(':memory:');
  try {
    const state = sampleState();
    importState(db, state);
    const changed = { ...state, projects: state.projects.slice(0, 1) };
    const check = verifyMirror(db, changed);
    assert.equal(check.ok, false);
    assert.ok(check.problems.length > 0);
  } finally { closeDatabase(db); }
});

test('UT-SQL-044: the layer answers the queries it exists for', () => {
  const db = openDatabase(':memory:');
  try {
    importState(db, sampleState());
    const runs = runsOfProject(db, 'proj_1_aaaa');
    assert.equal(runs.length, 2);
    // Newest first.
    assert.equal(runs[0].id, 'run_1_0002');
    assert.equal(runs[0].status, 'failed');
    const attempts = attemptsOfRun(db, 'run_1_0001');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'passed');
    assert.equal(attempts[0].case_status, 'expected');
  } finally { closeDatabase(db); }
});

// ---------------------------------------------------------------------------
// The concurrency contract
// ---------------------------------------------------------------------------

test('UT-SQL-050: two concurrent writers lose no record', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'metadata.db');
    // The database is created first, so the two writers open the SAME file
    // with the same schema.
    const seed = openDatabase(file);
    closeDatabase(seed);

    // Each writer is a SEPARATE PROCESS, so the test exercises the real
    // cross-process case and not two handles of one process. The module is
    // imported by its `file://` URL, because a Windows absolute path is not
    // a valid ESM specifier.
    const writer = path.join(dir, 'writer.mjs');
    const dbModuleUrl = pathToFileURL(path.join(ROOT, 'server', 'sqlite', 'db.mjs')).href;
    fs.writeFileSync(writer, `
import { openDatabase, closeDatabase, withTransaction } from ${JSON.stringify(dbModuleUrl)};
const [file, tag, n] = process.argv.slice(2);
const db = openDatabase(file, { migrate: true });
for (let i = 0; i < Number(n); i++) {
  withTransaction(db, (d) => {
    d.prepare('INSERT INTO run_counters(project_id,seq) VALUES(?,?)').run(tag + '-' + i, i);
  });
}
closeDatabase(db);
`, 'utf8');

    // The two writers run AT THE SAME TIME, so they really contend for the
    // write lock: one of them has to wait for the other, and the busy
    // timeout is what makes the wait succeed instead of failing.
    const run = (tag, n) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [writer, file, tag, String(n)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${tag} exited ${code}: ${err}`))));
    });

    await Promise.all([run('a', 40), run('b', 40)]);

    const db = openDatabase(file, { migrate: false });
    try {
      const n = Number(db.prepare('SELECT count(*) AS n FROM run_counters').get().n);
      assert.equal(n, 80, `expected 80 rows, found ${n} -- a record was lost`);
    } finally { closeDatabase(db); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-051: a reader sees the committed state while a writer is working', async () => {
  const dir = tmp();
  const file = path.join(dir, 'metadata.db');
  try {
    const seed = openDatabase(file);
    seed.prepare('INSERT INTO run_counters(project_id,seq) VALUES(?,?)').run('p0', 0);
    closeDatabase(seed);

    // The writer is a SEPARATE PROCESS that imports the module by its
    // `file://` URL: a Windows absolute path is not a valid ESM specifier
    // and the child would die with ERR_UNSUPPORTED_ESM_URL_SCHEME before
    // it ever opened the database.
    //
    // The child announces on stdout that its write transaction is OPEN
    // and only then does the work, so the parent really reads WHILE an
    // uncommitted write transaction is held -- and not by accident.
    const writer = path.join(dir, 'long-writer.mjs');
    fs.writeFileSync(writer, `
import { openDatabase, closeDatabase, withTransaction } from ${JSON.stringify(moduleUrl('server', 'sqlite', 'db.mjs'))};
const [file, n] = process.argv.slice(2);
const db = openDatabase(file, { migrate: true });
withTransaction(db, (d) => {
  for (let i = 0; i < Number(n); i++) {
    d.prepare('INSERT INTO run_counters(project_id,seq) VALUES(?,?)').run('w' + i, i);
  }
  console.log('IN-TX');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
});
closeDatabase(db);
`, 'utf8');

    const child = spawn(process.execPath, [writer, file, '200'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stderr = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    try {
      // Wait for the writer to be INSIDE its transaction.
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (out.includes('IN-TX')) { clearInterval(timer); resolve(); }
        }, 10);
        child.on('close', () => {
          clearInterval(timer);
          reject(new Error(`the writer exited before its transaction was open: ${stderr}`));
        });
      });
      assert.ok(
        !/ERR_UNSUPPORTED_ESM_URL_SCHEME/.test(stderr),
        `the writer died on import: ${stderr}`
      );

      // While the writer holds its uncommitted transaction, a reader in
      // ANOTHER connection must be able to read: that is the point of WAL.
      // The reader sees the state as of BEFORE the writer's transaction.
      const db = openDatabase(file, { migrate: false });
      try {
        const n = Number(db.prepare('SELECT count(*) AS n FROM run_counters').get().n);
        assert.equal(n, 1, `the reader saw ${n} rows -- it did not read the pre-transaction snapshot`);
      } finally { closeDatabase(db); }
    } finally {
      child.kill();
      await new Promise((r) => child.on('close', r));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The migration is safe against a concurrent migrator and against a
// foreign object
// ---------------------------------------------------------------------------

test('UT-SQL-031: two concurrent migrators do not apply the same step twice', async () => {
  const dir = tmp();
  const file = path.join(dir, 'metadata.db');
  try {
    // A database at version 2. The step that is about to be applied ADDS
    // A COLUMN -- a step that is NOT idempotent, because SQLite has no
    // `ADD COLUMN IF NOT EXISTS`.
    closeDatabase(openDatabase(file));

    // The migrator child imports the module by its `file://` URL and waits
    // for a common start time, so all the processes really do contend for
    // the write lock at the same moment.
    const migrator = path.join(dir, 'migrator.mjs');
    fs.writeFileSync(migrator, `
import { MIGRATIONS } from ${JSON.stringify(moduleUrl('server', 'sqlite', 'schema.mjs'))};
import { openDatabase, closeDatabase } from ${JSON.stringify(moduleUrl('server', 'sqlite', 'db.mjs'))};
MIGRATIONS.push({
  version: 3, name: 'add-col',
  tables: {},
  up: ['ALTER TABLE runs ADD COLUMN probe_col TEXT'],
  down: ['ALTER TABLE runs DROP COLUMN probe_col'],
});
const go = Number(process.argv[3]);
while (Date.now() < go) { /* spin until the common start time */ }
try {
  closeDatabase(openDatabase(process.argv[2]));
  console.log('OK');
} catch (e) {
  console.log('FAIL ' + e.message);
}
`, 'utf8');

    const go = Date.now() + 800;
    const runs = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve) => {
      const c = spawn(process.execPath, [migrator, file, String(go)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let o = '';
      let e = '';
      c.stdout.on('data', (d) => { o += d.toString(); });
      c.stderr.on('data', (d) => { e += d.toString(); });
      c.on('close', () => resolve(o.trim() || `NO-OUTPUT ${e}`));
    })));

    const failures = runs.filter((o) => !o.startsWith('OK'));
    assert.equal(
      failures.length, 0,
      `a concurrent migrator failed: ${failures.join(' | ')} -- the version was read OUTSIDE the step transaction`
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-032: a foreign table with the same name is refused, not adopted', async () => {
  const dir = tmp();
  const file = path.join(dir, 'metadata.db');
  try {
    // A FOREIGN table that happens to have the name of one of our tables,
    // but not its shape. It is created with the raw SQLite API, so it
    // carries no `meta` table and no schema version.
    const sqlite = await import('node:sqlite');
    const raw = new sqlite.DatabaseSync(file);
    raw.exec('CREATE TABLE projects(id TEXT, root TEXT)');
    raw.close();

    assert.throws(
      () => openDatabase(file),
      (e) => e.code === 'SCHEMA_OBJECT_CONFLICT',
      'the foreign table was adopted silently'
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-033: a table with the EXPECTED shape is still idempotent', () => {
  const dir = tmp();
  const file = path.join(dir, 'metadata.db');
  try {
    // A database that was created by an earlier run of this code: the
    // tables are already there, with the right shape. Re-opening it must
    // not fail -- the step stays a no-op for it.
    closeDatabase(openDatabase(file));
    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), latestVersion());
    } finally { closeDatabase(db); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-034: a database that is NEWER than the code does not leak its handle', () => {
  const dir = tmp();
  const file = path.join(dir, 'metadata.db');
  try {
    const db = openDatabase(file);
    db.prepare(`UPDATE meta SET value=? WHERE key='schema_version'`).run(String(latestVersion() + 5));
    closeDatabase(db);
    // The refused migration must release the handle it opened: on Windows
    // an open file cannot be deleted.
    assert.throws(() => openDatabase(file), (e) => e.code === 'SCHEMA_TOO_NEW');
    // If the handle had been leaked, this delete would fail with EPERM.
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(!fs.existsSync(dir), 'the data directory could not be deleted -- a handle was leaked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The mirror covers everything a query reads
// ---------------------------------------------------------------------------

test('UT-SQL-045: the verification catches a tampered registry entry', () => {
  const db = openDatabase(':memory:');
  try {
    const state = sampleState();
    importState(db, state);
    assert.equal(verifyMirror(db, state).ok, true);
    // The registry CONTENT is changed, but the count stays the same: the
    // old verification only compared the counts.
    db.exec(
      `UPDATE uid_registry SET file='WRONG.spec.ts', title='WRONG',
       entry='{"uid":"tc-1","file":"WRONG.spec.ts","title":"WRONG","bodyKey":"k1"}'`
    );
    const check = verifyMirror(db, state);
    assert.equal(check.ok, false, 'the tampered registry was not reported');
    assert.ok(check.problems.length > 0);
  } finally { closeDatabase(db); }
});

test('UT-SQL-046: the verification catches an indexed column that contradicts its record', () => {
  const db = openDatabase(':memory:');
  try {
    const state = sampleState();
    importState(db, state);
    // The indexed column now says "passed" while the record says "failed".
    // A query that reads the column answers with something the state does
    // not say -- that has to be a difference.
    db.exec(`UPDATE runs SET status='passed' WHERE id='run_1_0002'`);
    const check = verifyMirror(db, state);
    assert.equal(check.ok, false, 'the contradicting indexed column was not reported');
    assert.ok(
      check.problems.some((p) => p.includes('run_1_0002') && p.includes('status')),
      `the problem does not name the field: ${check.problems.join('; ')}`
    );
  } finally { closeDatabase(db); }
});

test('UT-SQL-047: the verification catches missing attempts and artifacts', () => {
  const db = openDatabase(':memory:');
  try {
    const state = sampleState();
    importState(db, state);
    db.exec('DELETE FROM artifacts');
    db.exec('DELETE FROM test_attempts');
    const check = verifyMirror(db, state);
    assert.equal(check.ok, false, 'the deleted rows were not reported');
    assert.ok(check.problems.some((p) => p.includes('attempt')));
    assert.ok(check.problems.some((p) => p.includes('artifact')));
  } finally { closeDatabase(db); }
});

test('UT-SQL-048: the verification catches a tampered attempt', () => {
  const db = openDatabase(':memory:');
  try {
    const state = sampleState();
    importState(db, state);
    db.exec(`UPDATE test_attempts SET status='passed', test_uid='zzz'`);
    const check = verifyMirror(db, state);
    assert.equal(check.ok, false, 'the tampered attempt was not reported');
  } finally { closeDatabase(db); }
});

// ---------------------------------------------------------------------------
// The mirror of the bridge: recoverable, and it never takes the bridge down
// ---------------------------------------------------------------------------

test('UT-SQL-049: the mirror recovers after a transient failure', async () => {
  const dir = tmp();
  const file = path.join(dir, 'metadata.db');
  try {
    // The mirror writes to the database in the data directory. The bridge
    // resolves that directory from the environment, so the case points the
    // bridge at its own temporary directory for the duration of the test.
    const previous = process.env.ATS_DATA_DIR;
    process.env.ATS_DATA_DIR = dir;
    try {
      const core = await import('../server/core.mjs');
      const state = sampleState();

      // 1. The mirror succeeds.
      assert.equal(core.mirrorToSqlite(state), true, 'the first mirror did not succeed');
      const db = openDatabase(file, { migrate: false });
      let n = Number(db.prepare('SELECT count(*) AS n FROM projects').get().n);
      assert.equal(n, state.projects.length, 'the first mirror did not write the projects');
      closeDatabase(db);

      // 2. The mirror fails -- the database is blocked by another process.
      // The lock is held for LONGER than the mirror's own busy timeout, so
      // the mirror really gives up instead of waiting the obstruction out.
      const holder = spawnLockHolder(file, 3000);
      await holder.locked;
      const failed = core.mirrorToSqlite(state);
      await holder.released;
      assert.equal(failed, false, 'the blocked mirror reported success');

      // 3. The mirror succeeds AGAIN without anything else being done: the
      // failure is transient, and the whole-state write heals the mirror.
      assert.equal(
        core.mirrorToSqlite(state),
        true,
        'the mirror did not recover after the obstruction was gone'
      );
      const db2 = openDatabase(file, { migrate: false });
      try {
        n = Number(db2.prepare('SELECT count(*) AS n FROM projects').get().n);
        assert.equal(n, state.projects.length, 'the recovered mirror did not write the projects');
        assert.equal(
          Number(db2.prepare('SELECT count(*) AS n FROM runs').get().n),
          state.runs.length,
          'the recovered mirror did not write the runs'
        );
      } finally { closeDatabase(db2); }
    } finally {
      if (previous === undefined) delete process.env.ATS_DATA_DIR;
      else process.env.ATS_DATA_DIR = previous;
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-049b: a mirror failure does not stop the state file from being written', async () => {
  const dir = tmp();
  try {
    const previous = process.env.ATS_DATA_DIR;
    process.env.ATS_DATA_DIR = dir;
    try {
      const core = await import('../server/core.mjs');
      // A state that cannot be mirrored: `runs` is not an array, so the
      // mirror throws while it writes.
      const broken = { schema: 1, projects: [], runs: 'not-an-array' };
      const ok = core.saveState(broken);
      assert.equal(ok, undefined, 'saveState started returning a value');
      // The JSON state file IS the truth: it was written even though the
      // mirror failed.
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      assert.equal(written.schema, 1);
      assert.equal(written.runs, 'not-an-array');
    } finally {
      if (previous === undefined) delete process.env.ATS_DATA_DIR;
      else process.env.ATS_DATA_DIR = previous;
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-049c: a mirror failure does not take the bridge down', async () => {
  const dir = tmp();
  const file = path.join(dir, 'metadata.db');
  try {
    const previous = process.env.ATS_DATA_DIR;
    process.env.ATS_DATA_DIR = dir;
    try {
      const core = await import('../server/core.mjs');
      const state = sampleState();
      assert.equal(core.mirrorToSqlite(state), true);

      // The database is blocked by another process for LONGER than the
      // mirror's busy timeout, so the mirror gives up.
      const holder = spawnLockHolder(file, 3000);
      await holder.locked;
      const failed = core.mirrorToSqlite(state);
      await holder.released;
      assert.equal(failed, false, 'the blocked mirror reported success');
      // The bridge is still alive: a later call works.
      assert.equal(core.mirrorToSqlite(state), true, 'the bridge stopped mirroring after a failure');
    } finally {
      if (previous === undefined) delete process.env.ATS_DATA_DIR;
      else process.env.ATS_DATA_DIR = previous;
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The command line tool
// ---------------------------------------------------------------------------

/**
 * Runs the command line tool IN-PROCESS and captures what it printed.
 *
 * The tool is spawned as a child process in the cases above, because the
 * exit code of a child process is the contract of the tool. For the
 * branches that are about the ARGVUMENTS, an in-process call is the only
 * way to reach them: the coverage of the tool is measured in this process,
 * and a child process is not counted by the coverage report at all.
 *
 * @returns {{code:number,out:string,err:string}}
 */
function runCli(argv) {
  const out = [];
  const err = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  let code;
  try {
    code = cliMain(argv);
  } catch (e) {
    code = 1;
    err.push(String(e?.message ?? e));
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  return { code, out: out.join(''), err: err.join('') };
}

test('UT-SQL-064: the tool refuses an invalid --to with the usage exit code', () => {
  const dir = tmp();
  try {
    const db = path.join(dir, 'metadata.db');
    const state = path.join(dir, 'state.json');
    fs.writeFileSync(state, JSON.stringify(sampleState()));

    // A word, a version the code does not know and a negative number are
    // all usage errors: exit code 2, and NO database is touched.
    for (const bad of ['abc', String(latestVersion() + 10), '-1', '1.5', '']) {
      const r = runCli(['migrate', '--to', bad, '--db', db, '--state', state]);
      assert.equal(r.code, 2, `"--to ${bad}" was not refused with the usage exit code`);
      const d = runCli(['downgrade', '--to', bad, '--db', db, '--state', state]);
      assert.equal(d.code, 2, `"downgrade --to ${bad}" was not refused with the usage exit code`);
    }
    // The refused commands did not create the database.
    assert.ok(!fs.existsSync(db), 'a refused command created the database');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-065: the tool refuses an unknown argument and an unknown command', () => {
  const r = runCli(['status', '--nonsense']);
  assert.equal(r.code, 1, 'an unknown argument did not fail');
  assert.ok(/unknown argument/.test(r.err), `the reason was not reported: ${r.err}`);

  const u = runCli(['nonsense']);
  assert.equal(u.code, 2, 'an unknown command did not use the usage exit code');
  assert.ok(/usage/.test(u.out + u.err), 'the usage was not printed');

  const h = runCli(['status', '--help']);
  assert.equal(h.code, 0, '--help did not succeed');
  assert.ok(/usage/.test(h.out), 'the usage was not printed for --help');

  const n = runCli([]);
  assert.equal(n.code, 2, 'no command did not use the usage exit code');
});

test('UT-SQL-066: the read-only commands do not create the database', () => {
  const dir = tmp();
  try {
    const db = path.join(dir, 'metadata.db');
    const state = path.join(dir, 'state.json');
    fs.writeFileSync(state, JSON.stringify(sampleState()));

    // `status` on a database that does not exist: it reports and creates
    // nothing.
    const s = runCli(['status', '--db', db, '--state', state]);
    assert.equal(s.code, 0, 'the status command failed');
    assert.ok(/does not exist yet/.test(s.out), `the status was not reported: ${s.out}`);
    assert.ok(!fs.existsSync(db), 'the status command created the database');

    // `verify` on a database that does not exist: it FAILS and creates
    // nothing.
    const v = runCli(['verify', '--db', db, '--state', state]);
    assert.equal(v.code, 1, 'the verify command did not fail on a missing database');
    assert.ok(/does not exist/.test(v.err), `the reason was not reported: ${v.err}`);
    assert.ok(!fs.existsSync(db), 'the verify command created the database');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-067: the tool reports the errors it cannot recover from', () => {
  const dir = tmp();
  try {
    const db = path.join(dir, 'metadata.db');
    // A state file that does not exist.
    const missing = runCli(['import', '--db', db, '--state', path.join(dir, 'nope.json')]);
    assert.equal(missing.code, 1, 'the import of a missing state file did not fail');
    assert.ok(/state file does not exist/.test(missing.err));

    // A state file that is not a state.
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ projects: 'not-an-array', runs: [] }));
    const broken = runCli(['import', '--db', db, '--state', bad]);
    assert.equal(broken.code, 1, 'the import of an invalid state file did not fail');
    assert.ok(/UNSUPPORTED_DATABASE/.test(broken.err + broken.out));

    // A downgrade of a database that does not exist.
    const d = runCli(['downgrade', '--to', '1', '--db', path.join(dir, 'nope.db')]);
    assert.equal(d.code, 1, 'the downgrade of a missing database did not fail');
    assert.ok(/does not exist/.test(d.err));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-068: the tool reports a mismatch and fails', () => {
  const dir = tmp();
  try {
    const db = path.join(dir, 'metadata.db');
    const state = path.join(dir, 'state.json');
    fs.writeFileSync(state, JSON.stringify(sampleState()));
    const i = runCli(['import', '--db', db, '--state', state]);
    assert.equal(i.code, 0, 'the import failed');
    assert.ok(/mirror      : OK/.test(i.out), `the import did not report a good mirror: ${i.out}`);

    // The state changes, the database does not: the mirror no longer
    // matches and the tool has to say so.
    const changed = sampleState();
    changed.runs.push({
      id: 'run_1_0003', uid: 'run_1_0003', seq: 3, projectId: 'proj_1_aaaa',
      projectUid: 'proj_1_aaaa', status: 'passed', createdAt: '2026-01-03T00:00:00.000Z',
      attempts: [], artifacts: [],
    });
    fs.writeFileSync(state, JSON.stringify(changed));
    const v = runCli(['verify', '--db', db, '--state', state]);
    assert.equal(v.code, 1, 'the verify command did not fail on a mismatch');
    assert.ok(/MISMATCH/.test(v.out), `the mismatch was not reported: ${v.out}`);
    assert.ok(/problem/.test(v.out), 'the problems were not listed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('UT-SQL-060: the tool reports the status of a database', () => {
  const dir = tmp();
  try {
    const stateFile = path.join(dir, 'state.json');
    const dbFile = path.join(dir, 'metadata.db');
    fs.writeFileSync(stateFile, JSON.stringify(sampleState()), 'utf8');
    const r = spawnSync(process.execPath, [TOOL, 'status', '--db', dbFile], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /schema\s+:\s+0/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-061: the tool imports the state and verifies the mirror', () => {
  const dir = tmp();
  try {
    const stateFile = path.join(dir, 'state.json');
    const dbFile = path.join(dir, 'metadata.db');
    fs.writeFileSync(stateFile, JSON.stringify(sampleState()), 'utf8');
    const imp = spawnSync(process.execPath, [TOOL, 'import', '--state', stateFile, '--db', dbFile], { encoding: 'utf8' });
    assert.equal(imp.status, 0, imp.stderr);
    assert.match(imp.stdout, /mirror\s+:\s+OK/);
    const ver = spawnSync(process.execPath, [TOOL, 'verify', '--state', stateFile, '--db', dbFile], { encoding: 'utf8' });
    assert.equal(ver.status, 0, ver.stderr);
    assert.match(ver.stdout, /mirror\s+:\s+OK/);
    // The import does NOT touch the JSON state file.
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), sampleState());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-062: the tool migrates and downgrades on demand', () => {
  const dir = tmp();
  try {
    const dbFile = path.join(dir, 'metadata.db');
    const mk = spawnSync(process.execPath, [TOOL, 'migrate', '--db', dbFile, '--to', '1'], { encoding: 'utf8' });
    assert.equal(mk.status, 0, mk.stderr);
    assert.match(mk.stdout, /"to":1/);
    const down = spawnSync(process.execPath, [TOOL, 'downgrade', '--db', dbFile, '--to', '0'], { encoding: 'utf8' });
    assert.equal(down.status, 0, down.stderr);
    const st = spawnSync(process.execPath, [TOOL, 'status', '--db', dbFile], { encoding: 'utf8' });
    assert.match(st.stdout, /schema\s+:\s+0/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UT-SQL-063: the tool refuses an unknown command', () => {
  const r = spawnSync(process.execPath, [TOOL, 'nonsense'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
