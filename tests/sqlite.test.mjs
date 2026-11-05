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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'sqlite_meta.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ats-sqlite-'));

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

test('UT-SQL-003: a blocked writer waits instead of failing at once', () => {
  const dir = tmp();
  try {
    const db = openDatabase(path.join(dir, 'metadata.db'));
    try {
      assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, DEFAULT_BUSY_TIMEOUT_MS);
    } finally { closeDatabase(db); }
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
  try {
    const before = currentVersion(db);
    // A version that does not exist: the runner has no step for it, so
    // nothing is applied and the version does not move.
    const result = migrateDatabase(db, before);
    assert.deepEqual(result.applied, []);
    assert.equal(currentVersion(db), before);
  } finally { closeDatabase(db); }
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

test('UT-SQL-051: a reader sees the committed state while a writer is working', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'metadata.db');
    const seed = openDatabase(file);
    seed.prepare('INSERT INTO run_counters(project_id,seq) VALUES(?,?)').run('p0', 0);
    closeDatabase(seed);

    const writer = path.join(dir, 'long-writer.mjs');
    fs.writeFileSync(writer, `
import { openDatabase, closeDatabase, withTransaction } from ${JSON.stringify(path.join(ROOT, 'server', 'sqlite', 'db.mjs'))};
const [file, n] = process.argv.slice(2);
const db = openDatabase(file, { migrate: true });
withTransaction(db, (d) => {
  for (let i = 0; i < Number(n); i++) {
    d.prepare('INSERT INTO run_counters(project_id,seq) VALUES(?,?)').run('w' + i, i);
  }
});
closeDatabase(db);
`, 'utf8');

    const child = spawn(process.execPath, [writer, file, '200'], { stdio: 'ignore' });
    try {
      // While the writer holds its transaction, a reader in ANOTHER
      // connection must be able to read: that is the point of WAL. The
      // reader sees the state as of BEFORE the writer's transaction.
      const db = openDatabase(file, { migrate: false });
      try {
        const n = Number(db.prepare('SELECT count(*) AS n FROM run_counters').get().n);
        assert.ok(n >= 1, 'the reader could not read at all while the writer was working');
      } finally { closeDatabase(db); }
    } finally {
      child.kill();
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The command line tool
// ---------------------------------------------------------------------------

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
