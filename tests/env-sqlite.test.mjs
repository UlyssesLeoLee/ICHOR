/**
 * ATS-212 -- the environment profiles: the SQLite mirror test.
 *
 * WHAT IS ASSERTED HERE
 * ---------------------
 * The environment profiles are a PART of the bridge state, so the SQLite
 * mirror has to carry them -- and carry them COMPLETELY. The state file
 * is the truth; the database is a mirror of it. A mirror that carries the
 * profiles but drops the whitelist would quietly change what a profile
 * means after a restart, which is the kind of difference that only shows
 * up in production.
 *
 *   1. The profiles and the whitelists survive a round trip.
 *   2. The mirror holds the NAMES of the variables in the indexed column,
 *      so a query can read them out of a shared database without carrying
 *      a value.
 *   3. A run carries the profile it ran under, and a run that ran without
 *      one still reads back exactly as it was.
 *   4. The mirror REPORTS a difference instead of hiding it: a profile
 *      that is missing, a tampered row, a whitelist that disagrees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, closeDatabase } from '../server/sqlite/db.mjs';
import { storeState, loadStateFrom, counts } from '../server/sqlite/store.mjs';
import { importState, verifyMirror } from '../server/sqlite/import.mjs';
import { SCHEMA_VERSION, latestVersion } from '../server/sqlite/schema.mjs';

function stateWithEnv() {
  return {
    schema: 1,
    projects: [
      { id: 'proj_1_aaaa', uid: 'proj_1_aaaa', name: 'alpha', root: '/tmp/alpha', addedAt: '2026-01-01T00:00:00.000Z' },
    ],
    runs: [
      {
        id: 'run_1_0001', uid: 'run_1_0001', seq: 1,
        projectId: 'proj_1_aaaa', projectUid: 'proj_1_aaaa',
        status: 'passed', createdAt: '2026-01-01T00:00:01.000Z',
        gitCommit: 'abc1234', envUid: 'env_1_aaaaaaaaaaaa',
        attempts: [], artifacts: [],
      },
      {
        id: 'run_1_0002', uid: 'run_1_0002', seq: 2,
        projectId: 'proj_1_aaaa', projectUid: 'proj_1_aaaa',
        status: 'passed', createdAt: '2026-01-01T00:00:02.000Z',
        gitCommit: 'abc1234',
        attempts: [], artifacts: [],
      },
    ],
    uidRegistry: { version: 1, projects: {} },
    runCounters: { proj_1_aaaa: 2 },
    envProfiles: {
      version: 1,
      profiles: [
        {
          uid: 'env_1_aaaaaaaaaaaa', id: 'env_1_aaaaaaaaaaaa',
          projectUid: 'proj_1_aaaa', name: 'staging', environment: 'staging',
          variables: { BASE_URL: 'https://staging.example', TENANT: 'acme' },
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      whitelists: {
        proj_1_aaaa: ['BASE_URL', 'TENANT'],
      },
    },
  };
}

test('UT-SQL-ENV-001: the schema knows the environment tables', () => {
  assert.equal(latestVersion(), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 4);
  const step = { version: 4, name: 'environment-profiles' };
  const db = openDatabase(':memory:');
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.ok(tables.includes('env_profiles'), tables.join(','));
    assert.ok(tables.includes('env_whitelists'), tables.join(','));
    // The run carries the profile it ran under.
    const columns = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
    assert.ok(columns.includes('env_uid'), columns.join(','));
    assert.ok(step.version <= SCHEMA_VERSION);
  } finally { closeDatabase(db); }
});

test('UT-SQL-ENV-002: the profiles and the whitelists survive a round trip', () => {
  const db = openDatabase(':memory:');
  try {
    const state = stateWithEnv();
    importState(db, state);
    const read = loadStateFrom(db);
    // The profile is there, with its variables.
    assert.equal(read.envProfiles.profiles.length, 1);
    const profile = read.envProfiles.profiles[0];
    assert.equal(profile.uid, 'env_1_aaaaaaaaaaaa');
    assert.equal(profile.name, 'staging');
    assert.equal(profile.environment, 'staging');
    assert.equal(profile.variables.BASE_URL, 'https://staging.example');
    assert.equal(profile.variables.TENANT, 'acme');
    // The whitelist is there too -- a mirror that dropped it would change
    // what the profile means after a restart.
    assert.deepEqual(read.envProfiles.whitelists.proj_1_aaaa, ['BASE_URL', 'TENANT']);
    // The run carries the profile it ran under.
    const withEnv = read.runs.find((r) => r.id === 'run_1_0001');
    assert.equal(withEnv.envUid, 'env_1_aaaaaaaaaaaa');
    // And the run that ran WITHOUT one still reads back exactly as it was.
    const withoutEnv = read.runs.find((r) => r.id === 'run_1_0002');
    assert.equal(withoutEnv.envUid, undefined);
    assert.equal(withoutEnv.gitCommit, 'abc1234');
    assert.equal(verifyMirror(db, state).ok, true);
  } finally { closeDatabase(db); }
});

test('UT-SQL-ENV-003: the indexed column holds the NAMES of the variables, not their values', () => {
  const db = openDatabase(':memory:');
  try {
    importState(db, stateWithEnv());
    const row = db
      .prepare('SELECT variables,doc FROM env_profiles WHERE uid=?')
      .get('env_1_aaaaaaaaaaaa');
    // The indexed column a query reads holds names.
    assert.deepEqual(JSON.parse(row.variables), ['BASE_URL', 'TENANT']);
    assert.equal(row.variables.includes('staging.example'), false);
    // The values are in the profile's own record, which is the part that
    // is read as a whole and never queried by value.
    assert.ok(row.doc.includes('staging.example'));
  } finally { closeDatabase(db); }
});

test('UT-SQL-ENV-004: the counts include the environment tables', () => {
  const db = openDatabase(':memory:');
  try {
    importState(db, stateWithEnv());
    const c = counts(db);
    assert.equal(c.envProfiles, 1);
    assert.equal(c.envWhitelists, 1);
  } finally { closeDatabase(db); }
});

test('UT-SQL-ENV-005: the mirror REPORTS a profile that is missing from the database', () => {
  const db = openDatabase(':memory:');
  try {
    const state = stateWithEnv();
    importState(db, state);
    db.prepare('DELETE FROM env_profiles').run();
    const check = verifyMirror(db, state);
    assert.equal(check.ok, false);
    assert.ok(
      check.problems.some((p) => p.includes('env_1_aaaaaaaaaaaa') && p.includes('missing')),
      check.problems.join('; ')
    );
  } finally { closeDatabase(db); }
});

test('UT-SQL-ENV-006: the mirror REPORTS a tampered profile', () => {
  const db = openDatabase(':memory:');
  try {
    const state = stateWithEnv();
    importState(db, state);
    const doc = JSON.parse(
      db.prepare('SELECT doc FROM env_profiles WHERE uid=?').get('env_1_aaaaaaaaaaaa').doc
    );
    doc.variables.BASE_URL = 'https://somewhere-else.example';
    db.prepare('UPDATE env_profiles SET doc=? WHERE uid=?')
      .run(JSON.stringify(doc), 'env_1_aaaaaaaaaaaa');
    const check = verifyMirror(db, state);
    assert.equal(check.ok, false);
    assert.ok(check.problems.some((p) => p.includes('BASE_URL')), check.problems.join('; '));
  } finally { closeDatabase(db); }
});

test('UT-SQL-ENV-007: the mirror REPORTS an indexed column that contradicts its own record', () => {
  const db = openDatabase(':memory:');
  try {
    const state = stateWithEnv();
    importState(db, state);
    // The row now lists a different set of names than its own document:
    // a query would answer with something the state does not say.
    db.prepare('UPDATE env_profiles SET variables=? WHERE uid=?')
      .run(JSON.stringify(['SOMETHING_ELSE']), 'env_1_aaaaaaaaaaaa');
    const check = verifyMirror(db, state);
    assert.equal(check.ok, false);
    assert.ok(
      check.problems.some((p) => p.includes('variables') && p.includes('SOMETHING_ELSE')),
      check.problems.join('; ')
    );
  } finally { closeDatabase(db); }
});

test('UT-SQL-ENV-008: the mirror REPORTS a whitelist that disagrees with the state', () => {
  const db = openDatabase(':memory:');
  try {
    const state = stateWithEnv();
    importState(db, state);
    db.prepare('UPDATE env_whitelists SET names=? WHERE project_uid=?')
      .run(JSON.stringify(['BASE_URL']), 'proj_1_aaaa');
    const check = verifyMirror(db, state);
    assert.equal(check.ok, false);
    assert.ok(
      check.problems.some((p) => p.includes('whitelist') && p.includes('proj_1_aaaa')),
      check.problems.join('; ')
    );
  } finally { closeDatabase(db); }
});

test('UT-SQL-ENV-009: a state without the environment field still mirrors cleanly', () => {
  const db = openDatabase(':memory:');
  try {
    // A state written before ATS-212 has no `envProfiles` at all.
    const state = {
      schema: 1, projects: [], runs: [],
      uidRegistry: { version: 1, projects: {} }, runCounters: {},
    };
    importState(db, state);
    assert.equal(verifyMirror(db, state).ok, true);
    const read = loadStateFrom(db);
    assert.deepEqual(read.envProfiles.profiles, []);
    assert.deepEqual(read.envProfiles.whitelists, {});
  } finally { closeDatabase(db); }
});

test('UT-SQL-ENV-010: the import is idempotent with the environment profiles', () => {
  const db = openDatabase(':memory:');
  try {
    const state = stateWithEnv();
    importState(db, state);
    const first = JSON.stringify(loadStateFrom(db));
    importState(db, state);
    const second = JSON.stringify(loadStateFrom(db));
    assert.equal(first, second, 'a second import changed the database');
    assert.equal(verifyMirror(db, state).ok, true);
  } finally { closeDatabase(db); }
});

test('UT-SQL-ENV-011: the migration down removes the environment tables and the column', async () => {
  const db = openDatabase(':memory:');
  try {
    importState(db, stateWithEnv());
    // The down script of step 4 is run by hand: the downgrade path is the
    // runner's, and this asserts the script itself leaves nothing behind.
    const { MIGRATIONS } = await import('../server/sqlite/schema.mjs');
    const down = MIGRATIONS.find((m) => m.version === 4).down;
    for (const stmt of down) db.exec(stmt);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    assert.equal(tables.includes('env_profiles'), false);
    assert.equal(tables.includes('env_whitelists'), false);
    const columns = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
    assert.equal(columns.includes('env_uid'), false);
  } finally { closeDatabase(db); }
});
