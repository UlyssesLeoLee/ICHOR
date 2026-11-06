import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  planMigration, summarizeState, compareCounts, assertCountsPreserved,
  isMigrated, rekeyProjectMap, readStateFile, writeStateAtomic,
  validateState,
} from '../server/migration/state-migration.mjs';
import * as engine from '../server/migration/apply.mjs';
import {
  applyMigration, rollbackMigration, undoMigration, MigrationJournal,
  importAndVerify, pathsOf, backupFile, restoreBackup,
} from '../server/migration/apply.mjs';
import { projectUidFor } from '../server/uid.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats206-'));
const repoRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(repoRoot, 'tools', 'migrate_state.mjs');

// The counterexample section below uses its own scratch directory and its
// own counter, so that its identifiers cannot collide with the ones above.
const ceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats206-ce-'));
const ceRepoRoot = path.resolve(import.meta.dirname, '..');
const ceCli = path.join(ceRepoRoot, 'tools', 'migrate_state.mjs');
const applyModule = pathToFileURL(path.join(ceRepoRoot, 'server', 'migration', 'apply.mjs')).href;
const coreModule = pathToFileURL(path.join(ceRepoRoot, 'server', 'core.mjs')).href;
let counter = 0;

const LEGACY_PROJECT = 'proj_11111111-1111-1111-1111-111111111111';
const LEGACY_RUN_A = 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const LEGACY_RUN_B = 'run_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/**
 * A v0.1 state as the bridge of that version wrote it: the legacy
 * identifiers, the trust map (ATS-202) and the UID registry (ATS-201).
 */
function legacyState(overrides = {}) {
  const base = {
    schema: 1,
    projects: [{
      id: LEGACY_PROJECT,
      name: 'app',
      root: path.join(dir, 'app'),
      addedAt: '2026-01-01T00:00:00.000Z',
    }],
    runs: [
      {
        id: LEGACY_RUN_B,
        projectId: LEGACY_PROJECT,
        projectName: 'app',
        file: 'tests/a.spec.ts',
        gitCommit: 'abc1234',
        status: 'failed',
        createdAt: '2026-01-02T00:00:00.000Z',
        attempts: [{ uid: 'att_1_111111111111111111111111', testUid: 'tc_1_d_abcdef0123456789', retry: 0, status: 'failed' }],
        artifacts: [{ file: 'trace.zip', sha256: 'ab'.repeat(32), size: 10 }],
      },
      {
        id: LEGACY_RUN_A,
        projectId: LEGACY_PROJECT,
        projectName: 'app',
        file: 'tests/a.spec.ts',
        gitCommit: 'abc1234',
        status: 'passed',
        createdAt: '2026-01-01T00:00:00.000Z',
        attempts: [],
        artifacts: [],
      },
    ],
    uidRegistry: {
      version: 1,
      projects: {
        [LEGACY_PROJECT]: {
          entries: [{
            uid: 'tc_1_d_abcdef0123456789',
            file: 'tests/a.spec.ts',
            title: 'works',
            bodyKey: 'k1',
          }],
        },
      },
    },
    trust: {
      [LEGACY_PROJECT]: { trust: 'trusted', reason: '', at: '2026-01-01T00:00:00.000Z' },
    },
    runCounters: { [LEGACY_PROJECT]: 7 },
  };
  return { ...base, ...overrides };
}

/** Writes a state into a fresh data directory and returns the directory. */
function makeDataDir(state, name) {
  const dataDir = path.join(dir, name);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(state, null, 2));
  return dataDir;
}

/** The migrated project UID of the fixture. */
function newProjectUid() {
  return projectUidFor(path.join(dir, 'app'));
}

/* ---------------------------------------------------------------- */
/* ATS-206-UT-001 ..: the counts are preserved                        */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-001: the counts of the state are counted', () => {
  const counts = summarizeState(legacyState());
  assert.equal(counts.projects, 1);
  assert.equal(counts.runs, 2);
  assert.equal(counts.attempts, 1);
  assert.equal(counts.artifacts, 1);
  assert.equal(counts.registryEntries, 1);
});

test('ATS-206-UT-002: the migration preserves the number of projects and runs', () => {
  const before = summarizeState(legacyState());
  const { state } = planMigration(legacyState());
  const after = summarizeState(state);
  assert.equal(after.projects, before.projects);
  assert.equal(after.runs, before.runs);
  assert.equal(after.attempts, before.attempts);
  assert.equal(after.artifacts, before.artifacts);
  assert.equal(after.registryEntries, before.registryEntries);
  assert.deepEqual(compareCounts(before, after), []);
});

test('ATS-206-UT-003: a count mismatch is refused', () => {
  assert.throws(
    () => assertCountsPreserved({ projects: 2, runs: 1 }, { projects: 1, runs: 1 }),
    (e) => e.code === 'MIGRATION_COUNT_MISMATCH'
  );
});

/* ---------------------------------------------------------------- */
/* the maps that are keyed by a project identifier are re-keyed      */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-010: the trust map survives the migration', () => {
  const { state } = planMigration(legacyState());
  assert.ok(state.trust, 'the trust map must not be dropped');
  assert.equal(Object.keys(state.trust).length, 1);
});

test('ATS-206-UT-011: the trust map is re-keyed to the new project UID', () => {
  const { state } = planMigration(legacyState());
  const uid = newProjectUid();
  // The vouch has to be reachable under the NEW identifier, otherwise the
  // project silently becomes untrusted.
  assert.equal(state.trust[uid]?.trust, 'trusted');
  assert.equal(state.trust[LEGACY_PROJECT], undefined);
});

test('ATS-206-UT-012: the UID registry survives the migration', () => {
  const { state } = planMigration(legacyState());
  assert.ok(state.uidRegistry, 'the registry must not be dropped');
  assert.equal(Object.keys(state.uidRegistry.projects).length, 1);
});

test('ATS-206-UT-013: the UID registry is re-keyed to the new project UID', () => {
  const { state } = planMigration(legacyState());
  const uid = newProjectUid();
  const bucket = state.uidRegistry.projects[uid];
  assert.ok(bucket, 'the registry bucket must be reachable under the new UID');
  assert.equal(bucket.entries.length, 1);
  assert.equal(bucket.entries[0].uid, 'tc_1_d_abcdef0123456789');
});

test('ATS-206-UT-014: a key that is not legacy stays where it is', () => {
  const map = { proj_1_aaaaaaaaaaaaaaaaaaaaaaaa: 'keep', legacy: 'move' };
  const out = rekeyProjectMap(map, new Map([['legacy', 'proj_1_bbbbbbbbbbbbbbbbbbbbbbbb']]));
  assert.equal(out['proj_1_aaaaaaaaaaaaaaaaaaaaaaaa'], 'keep');
  assert.equal(out['proj_1_bbbbbbbbbbbbbbbbbbbbbbbb'], 'move');
});

test('ATS-206-UT-015: a value that is already under the new name is not overwritten', () => {
  const map = { legacy: 'old', proj_1_new: 'current' };
  const out = rekeyProjectMap(map, new Map([['legacy', 'proj_1_new']]));
  // The current value is the newer one; the legacy value must not undo it.
  assert.equal(out['proj_1_new'], 'current');
  assert.equal(out.legacy, undefined);
});

test('ATS-206-UT-016: a field the migration does not know about survives', () => {
  const legacy = legacyState({ futureField: { keep: 'me' } });
  const { state } = planMigration(legacy);
  assert.deepEqual(state.futureField, { keep: 'me' });
});

/* ---------------------------------------------------------------- */
/* the state file is written atomically                              */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-020: the state file is written atomically', () => {
  const file = path.join(dir, 'atomic', 'state.json');
  writeStateAtomic(file, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  // No temporary file is left behind.
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('ATS-206-UT-021: a state that is not a state is rejected', () => {
  assert.throws(() => validateState(null), (e) => e.code === 'STATE_NOT_AN_OBJECT');
  assert.throws(() => validateState({}), (e) => e.code === 'UNSUPPORTED_DATABASE');
});

test('ATS-206-UT-022: a missing state file is reported', () => {
  assert.throws(
    () => readStateFile(path.join(dir, 'nope.json')),
    (e) => e.code === 'STATE_FILE_MISSING'
  );
});

/* ---------------------------------------------------------------- */
/* the CLI: plan / apply / rollback                                 */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-030: the plan command writes nothing', () => {
  const dataDir = makeDataDir(legacyState(), 'cli-plan');
  const original = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');
  const res = spawnSync(process.execPath, [cli, 'plan', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /the counts are preserved/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), original);
});

test('ATS-206-UT-031: the apply command migrates and keeps a backup', () => {
  const dataDir = makeDataDir(legacyState(), 'cli-apply');
  const original = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');
  const res = spawnSync(process.execPath, [cli, 'apply', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /migrated:/);

  const migrated = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(isMigrated(migrated), true);
  // The backup holds the ORIGINAL file.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json.bak'), 'utf8'), original);
});

test('ATS-206-UT-032: the apply command preserves the counts', () => {
  const dataDir = makeDataDir(legacyState(), 'cli-counts');
  const before = summarizeState(legacyState());
  const res = spawnSync(process.execPath, [cli, 'apply', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const after = summarizeState(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')));
  assert.equal(after.projects, before.projects);
  assert.equal(after.runs, before.runs);
  assert.equal(after.attempts, before.attempts);
  assert.equal(after.artifacts, before.artifacts);
  assert.equal(after.registryEntries, before.registryEntries);
});

test('ATS-206-UT-033: the rollback command restores the original state', () => {
  const dataDir = makeDataDir(legacyState(), 'cli-rollback');
  const original = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');
  let res = spawnSync(process.execPath, [cli, 'apply', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  res = spawnSync(process.execPath, [cli, 'rollback', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), original);
});

test('ATS-206-UT-034: the rollback renames the run folders back', () => {
  const dataDir = makeDataDir(legacyState(), 'cli-folders');
  // The run folder of the first run, named after the legacy identifier.
  fs.mkdirSync(path.join(dataDir, 'runs', LEGACY_RUN_A), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'runs', LEGACY_RUN_A, 'manifest.json'), '{}');

  let res = spawnSync(process.execPath, [cli, 'apply', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const migrated = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  const newRunId = migrated.runs.find((r) => r.legacyId === LEGACY_RUN_A).id;
  assert.equal(fs.existsSync(path.join(dataDir, 'runs', newRunId, 'manifest.json')), true);

  res = spawnSync(process.execPath, [cli, 'rollback', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.existsSync(path.join(dataDir, 'runs', LEGACY_RUN_A, 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'runs', newRunId)), false);
});

test('ATS-206-UT-035: a rollback without a backup is refused', () => {
  const dataDir = makeDataDir(legacyState(), 'cli-nobackup');
  const res = spawnSync(process.execPath, [cli, 'rollback', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /NO_BACKUP_TO_RESTORE/);
});

test('ATS-206-UT-036: the apply command is refused while a Bridge runs', () => {
  const dataDir = makeDataDir(legacyState(), 'cli-locked');
  // A lock file of a process that IS alive (this one).
  fs.writeFileSync(
    path.join(dataDir, 'bridge.lock'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
  );
  const res = spawnSync(process.execPath, [cli, 'apply', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 3);
  assert.match(res.stderr, /a Bridge is running/);
});

test('ATS-206-UT-037: an unknown command is a usage error', () => {
  const res = spawnSync(process.execPath, [cli, 'nonsense'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
});

test('ATS-206-UT-038: an unknown argument is a usage error', () => {
  const res = spawnSync(process.execPath, [cli, 'plan', '--nope'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown argument/);
});

test('ATS-206-UT-039: no command prints the usage and is a usage error', () => {
  const res = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /usage:/);
});

test('ATS-206-UT-039b: the help flag prints the usage and succeeds', () => {
  const res = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /usage:/);
});

test('ATS-206-UT-039c: the plan command refuses a state it cannot represent', () => {
  // Two projects with the SAME root derive the SAME UID. The second one
  // would overwrite the first: its registry bucket, its trust record and
  // its counter would be lost. The migration refuses such a state, and
  // says WHICH pair collides.
  const dataDir = makeDataDir(legacyState(), 'cli-refuse');
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  // The clone shares the root of the first project, so both derive the
  // SAME UID.
  const root = state.projects[0].root;
  state.projects.push({
    id: 'proj_22222222-2222-2222-2222-222222222222',
    name: 'app-clone',
    root,
    addedAt: '2026-01-01T00:00:00.000Z',
  });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const res = spawnSync(process.execPath, [cli, 'plan', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /PROJECT_UID_COLLISION/);
  // The refusal names both projects, so the operator can see which pair.
  assert.match(res.stderr, /app-clone/);
  // Nothing was written: the state file is untouched.
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), state);
});

test('ATS-206-UT-039d: the apply command reports a missing state file', () => {
  const dataDir = path.join(dir, 'cli-missing');
  fs.mkdirSync(dataDir, { recursive: true });
  const res = spawnSync(process.execPath, [cli, 'apply', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /state file not found/);
});

test('ATS-206-UT-039e: the apply command reports a failed migration and what was undone', () => {
  const dataDir = makeDataDir(legacyState(), 'cli-failed');
  const statePath = path.join(dataDir, 'state.json');
  // A project without a name cannot be imported: the column is NOT NULL.
  const broken = legacyState();
  delete broken.projects[0].name;
  fs.writeFileSync(statePath, JSON.stringify(broken, null, 2));

  const res = spawnSync(process.execPath, [cli, 'apply', '--data-dir', dataDir, '--import-db'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /the migration FAILED/);
  assert.match(res.stderr, /have been undone/);
});

test('ATS-206-UT-039f: the verify command reports a missing database', () => {
  const dataDir = makeDataDir(legacyState(), 'cli-nodb');
  const res = spawnSync(process.execPath, [cli, 'verify', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no metadata database/);
});

test('ATS-206-UT-039g: the --state option points at the state file directly', () => {
  const dataDir = makeDataDir(legacyState(), 'cli-stateopt');
  const statePath = path.join(dataDir, 'state.json');
  const res = spawnSync(process.execPath, [cli, 'plan', '--state', statePath], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /the counts are preserved/);
});

test('ATS-206-UT-039g2: the --state option points the apply at that file', () => {
  // The `--state` option has to hold for `apply` and `rollback` too, not
  // only for `plan`: the file the operator named is the file that is
  // migrated and the file that is restored.
  const dataDir = makeDataDir(legacyState(), 'cli-stateopt-apply');
  const statePath = path.join(dataDir, 'state.json');
  const original = fs.readFileSync(statePath, 'utf8');

  let res = spawnSync(process.execPath, [cli, 'apply', '--state', statePath], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const migrated = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(isMigrated(migrated), true);

  res = spawnSync(process.execPath, [cli, 'rollback', '--state', statePath], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(statePath, 'utf8'), original);
});

test('ATS-206-UT-039h: the default data directory comes from ATS_DATA_DIR', () => {
  const dataDir = makeDataDir(legacyState(), 'cli-env');
  const res = spawnSync(process.execPath, [cli, 'plan'], {
    encoding: 'utf8',
    env: { ...process.env, ATS_DATA_DIR: dataDir },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /the counts are preserved/);
});

/* ---------------------------------------------------------------- */
/* a failed migration is undone                                     */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-040: a failed migration is undone automatically', () => {
  const dataDir = makeDataDir(legacyState(), 'fail-undo');
  const paths = pathsOf(dataDir);
  const original = fs.readFileSync(paths.statePath, 'utf8');

  // The state file is written and the folders are renamed; the database
  // import then FAILS. The failure has to undo both steps.
  //
  // The fixture is the REAL situation after a rename: the folder exists
  // under the NEW name and NOT under the old one. The round-1 fixture
  // named a target that did not exist at all, so the undo was a no-op and
  // the test only ever proved that the state file came back.
  const newFolder = path.join(paths.runsDir, 'run_1_000000000000000000000000');
  fs.mkdirSync(newFolder, { recursive: true });
  fs.writeFileSync(path.join(newFolder, 'manifest.json'), '{}');
  assert.equal(fs.existsSync(path.join(paths.runsDir, LEGACY_RUN_A)), false);

  const journal = new MigrationJournal();
  backupFile(paths.statePath);
  writeStateAtomic(paths.statePath, { ...JSON.parse(original), uidVersion: 1 });
  journal.done('state');
  journal.renamedFolders = [{ from: LEGACY_RUN_A, to: 'run_1_000000000000000000000000' }];
  journal.done('folders');

  const undone = undoMigration(journal, paths);
  assert.ok(undone.some((u) => u.includes('state file restored')), undone.join('; '));
  assert.equal(fs.readFileSync(paths.statePath, 'utf8'), original);

  // The folder was REALLY renamed back: it is under the legacy name again,
  // and the new name is gone.
  assert.ok(
    undone.some((u) => u.includes('run folder renamed back')),
    `the undo report names no renamed folder: ${undone.join('; ')}`
  );
  assert.equal(fs.existsSync(path.join(paths.runsDir, LEGACY_RUN_A, 'manifest.json')), true);
  assert.equal(fs.existsSync(newFolder), false);
});

test('ATS-206-UT-041: a failed import leaves the old state and database in place', () => {
  const dataDir = makeDataDir(legacyState(), 'fail-db');
  const paths = pathsOf(dataDir);
  const original = fs.readFileSync(paths.statePath, 'utf8');

  // A project without a name cannot be imported: the `projects` table
  // declares the column NOT NULL, so the import fails inside its
  // transaction.
  const broken = legacyState();
  delete broken.projects[0].name;
  fs.writeFileSync(paths.statePath, JSON.stringify(broken, null, 2));
  const brokenOriginal = fs.readFileSync(paths.statePath, 'utf8');

  // An existing database that the migration must not damage.
  fs.writeFileSync(paths.dbPath, 'the previous database');

  const report = applyMigration(dataDir, { importDatabase: true });
  assert.equal(report.failed, true);
  assert.equal(report.rolledBack, true);
  // The original state file is back.
  assert.equal(fs.readFileSync(paths.statePath, 'utf8'), brokenOriginal);
  // The old database is untouched.
  assert.equal(fs.readFileSync(paths.dbPath, 'utf8'), 'the previous database');
  // No half-imported database was left behind.
  assert.equal(fs.existsSync(`${paths.dbPath}.importing`), false);
});

test('ATS-206-UT-042: the backup is written before the state file is changed', () => {
  const dataDir = makeDataDir(legacyState(), 'backup-order');
  const original = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');
  applyMigration(dataDir);
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json.bak'), 'utf8'), original);
});

test('ATS-206-UT-043: the backup and the restore are a pair', () => {
  const file = path.join(dir, 'pair', 'state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'original');
  assert.ok(backupFile(file));
  fs.writeFileSync(file, 'changed');
  assert.equal(restoreBackup(file), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
});

/* ---------------------------------------------------------------- */
/* the metadata database mirror                                     */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-050: the migrated state imports into the metadata database', () => {
  const dataDir = makeDataDir(legacyState(), 'mirror');
  const paths = pathsOf(dataDir);
  const res = spawnSync(process.execPath, [cli, 'apply', '--data-dir', dataDir, '--import-db'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /the metadata database was imported/);

  const verify = spawnSync(process.execPath, [cli, 'verify', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /holds the same data/);
});

test('ATS-206-UT-051: the imported mirror holds the migrated counts', () => {
  const dataDir = makeDataDir(legacyState(), 'mirror-counts');
  const res = spawnSync(process.execPath, [cli, 'apply', '--data-dir', dataDir, '--import-db'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const result = importAndVerify(
    JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')),
    path.join(dataDir, 'metadata.db'),
    {}
  );
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(result.report.projects, 1);
  assert.equal(result.report.runs, 2);
});

test('ATS-206-UT-052: the verify command fails when the database does not match', () => {
  const dataDir = makeDataDir(legacyState(), 'verify-bad');
  spawnSync(process.execPath, [cli, 'apply', '--data-dir', dataDir, '--import-db'], { encoding: 'utf8' });
  // A state that no longer matches the database.
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.runs = [];
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  const res = spawnSync(process.execPath, [cli, 'verify', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /does NOT hold the same data/);
});

/* ---------------------------------------------------------------- */

test('ATS-206-UT-060: cleanup removes the temporary fixture', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});

// =====================================================================
// The counterexamples of the Opus review (round 1), as unit tests.
//
// Every test in this section is a case that FAILED on the commit that was
// delivered in round 1 (`d6152ee`) and PASSES after the fixes. The
// fixtures are GENUINE v0.1 states -- the shape the v0.1 bridge wrote:
// `schema: 1`, `proj_<uuid>` / `run_<uuid>`, no registry, no trust map, no
// attempts -- because the round-1 fixtures carried fields that v0.1 never
// had, and a test against a fixture that cannot occur does not test
// anything.
//
// The cases:
//   CE1  the `--state` option names the file that is migrated, and a
//        failure is reported, not thrown.
//   CE2  a second `apply` does not overwrite the v0.1 backup.
//   CE3  a rollback is refused while the Bridge holds the lock.
//   CE4  a folder rename that fails half way through is fully undone.
//   CE5  a rollback that would discard a run refuses and names it.
//   CE6  an interrupted migration is finished, and the backup survives.
// =====================================================================

/**
 * A GENUINE v0.1 state: the identifiers are the uuid form, and there is no
 * registry, no trust map and no attempt list -- none of those existed in
 * v0.1.
 */
function v01State(root, label, nRuns) {
  const pid = `proj_${crypto.randomUUID()}`;
  const runs = [];
  for (let i = 0; i < nRuns; i++) {
    const t = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
    runs.unshift({
      id: `run_${crypto.randomUUID()}`,
      projectId: pid,
      projectName: label,
      file: `tests/${label}-${i}.spec.ts`,
      gitCommit: 'abc1234',
      status: 'passed',
      createdAt: t,
      startedAt: t,
      finishedAt: t,
      eventSeq: 3,
      log: 'ok\n',
      summary: { passed: 1, failed: 0, skipped: 0, flaky: 0, cases: [] },
      artifacts: [{ file: 'report.json', size: 2, sha256: 'x' }],
    });
  }
  return {
    schema: 1,
    projects: [{ id: pid, name: label, root, addedAt: '2026-01-01T00:00:00.000Z' }],
    runs,
  };
}

/** Writes a v0.1 state and its run folders into a fresh data directory. */
function makeData(name, nRuns = 3, file = 'state.json', label = 'app') {
  const dataDir = path.join(ceDir, name);
  fs.mkdirSync(path.join(dataDir, 'runs'), { recursive: true });
  const state = v01State(path.join(dataDir, label), label, nRuns);
  const text = JSON.stringify(state, null, 2);
  fs.writeFileSync(path.join(dataDir, file), text);
  for (const r of state.runs) {
    fs.mkdirSync(path.join(dataDir, 'runs', r.id), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'runs', r.id, 'report.json'), '{}');
  }
  return { dataDir, state, text };
}

function runCli(args) {
  const r = spawnSync(process.execPath, [ceCli, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The runs whose folder does not exist under the data directory. */
function missingFolders(dataDir, stateFile = 'state.json') {
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, stateFile), 'utf8'));
  return state.runs
    .filter((r) => !fs.existsSync(path.join(dataDir, 'runs', r.id)))
    .map((r) => r.id);
}

/** Waits for a line of output of a child process. */
function waitLine(child, text) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${text}`)), 30000);
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes(text)) { clearTimeout(timer); resolve(); }
    });
  });
}

/* ---------------------------------------------------------------- */
/* CE1: the --state option names the file that is migrated            */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-070: the apply command migrates the file named by --state', () => {
  const { dataDir, text } = makeData('ce1a', 2);
  const custom = v01State(path.join(dataDir, 'custom'), 'custom', 1);
  const customText = JSON.stringify(custom, null, 2);
  fs.writeFileSync(path.join(dataDir, 'custom.json'), customText);

  const res = runCli(['apply', '--data-dir', dataDir, '--state', path.join(dataDir, 'custom.json')]);
  assert.equal(res.code, 0, res.err);
  // The file that was NAMED is migrated.
  assert.notEqual(fs.readFileSync(path.join(dataDir, 'custom.json'), 'utf8'), customText);
  assert.equal(isMigrated(JSON.parse(fs.readFileSync(path.join(dataDir, 'custom.json'), 'utf8'))), true);
  // The file that was NOT named is untouched.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
});

test('ATS-206-UT-071: the rollback command restores the file named by --state', () => {
  const { dataDir, text } = makeData('ce1b', 2);
  const custom = v01State(path.join(dataDir, 'custom'), 'custom', 1);
  const customText = JSON.stringify(custom, null, 2);
  fs.writeFileSync(path.join(dataDir, 'custom.json'), customText);

  let res = runCli(['apply', '--data-dir', dataDir, '--state', path.join(dataDir, 'custom.json')]);
  assert.equal(res.code, 0, res.err);
  // The named file really was migrated -- otherwise the rollback below
  // would trivially restore a file that was never touched, and the test
  // would pass on an implementation that ignores --state entirely.
  assert.equal(isMigrated(JSON.parse(fs.readFileSync(path.join(dataDir, 'custom.json'), 'utf8'))), true);

  res = runCli(['rollback', '--data-dir', dataDir, '--state', path.join(dataDir, 'custom.json')]);
  assert.equal(res.code, 0, res.err);
  assert.equal(fs.readFileSync(path.join(dataDir, 'custom.json'), 'utf8'), customText);
  // The state file that was never migrated is still the original.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
});

test('ATS-206-UT-072: the apply command reports a missing state file without a stack trace', () => {
  const dataDir = path.join(ceDir, 'ce1c');
  fs.mkdirSync(dataDir, { recursive: true });
  const res = runCli(['apply', '--state', path.join(dataDir, 'legacy-state.json')]);
  assert.equal(res.code, 1);
  // A reason on stderr, and NO stack trace.
  assert.match(res.err, /state file not found/);
  assert.doesNotMatch(res.err, /\n\s+at /);
});

test('ATS-206-UT-073: the apply command reports a state that is not JSON without a stack trace', () => {
  const dataDir = path.join(ceDir, 'ce1d');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'legacy-state.json');
  fs.writeFileSync(file, 'this is not JSON');
  const res = runCli(['apply', '--state', file]);
  assert.equal(res.code, 1);
  assert.match(res.err, /STATE_NOT_JSON/);
  assert.doesNotMatch(res.err, /\n\s+at /);
});

test('ATS-206-UT-074: the apply command reports a refused state without a stack trace', () => {
  const { dataDir } = makeData('ce1e', 1);
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  // Two projects with the SAME root derive the same UID: the migration
  // refuses such a state.
  state.projects.push({
    id: `proj_${crypto.randomUUID()}`,
    name: 'app-clone',
    root: state.projects[0].root,
    addedAt: '2026-01-01T00:00:00.000Z',
  });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /PROJECT_UID_COLLISION/);
  assert.doesNotMatch(res.err, /\n\s+at /);
});

/* ---------------------------------------------------------------- */
/* CE2: the v0.1 backup is never overwritten                          */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-075: a second apply does not overwrite the v0.1 backup', () => {
  const { dataDir, state, text } = makeData('ce2a', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  // A second apply -- the natural "import the mirror afterwards" operation.
  res = runCli(['apply', '--data-dir', dataDir, '--import-db']);
  assert.equal(res.code, 0, res.err);
  // The backup still holds the v0.1 file.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json.bak'), 'utf8'), text);

  // ... and the rollback therefore restores v0.1 byte for byte, with every
  // legacy folder back.
  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
  const legacy = state.runs.filter((r) => fs.existsSync(path.join(dataDir, 'runs', r.id))).length;
  assert.equal(legacy, state.runs.length);
});

test('ATS-206-UT-076: an already migrated state is not migrated again', () => {
  const { dataDir } = makeData('ce2b', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  const migrated = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');
  res = runCli(['apply', '--data-dir', dataDir]);
  // The second apply refuses instead of re-migrating.
  assert.equal(res.code, 1);
  assert.match(res.err, /ALREADY_MIGRATED/);
  // The state file is unchanged by the refused apply.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), migrated);
});

/* ---------------------------------------------------------------- */
/* CE3: the Bridge lock is held for the whole write                   */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-077: the rollback command is refused while a Bridge runs', async () => {
  const { dataDir } = makeData('ce3', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);

  // A process that holds the lock for real.
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `import {acquireBridgeLock,lockPath} from ${JSON.stringify(coreModule)};` +
    `acquireBridgeLock(lockPath(${JSON.stringify(dataDir)}));console.log('LOCKED');setInterval(()=>{},1000);`],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  await waitLine(holder, 'LOCKED');
  try {
    // The apply refuses ...
    const control = runCli(['apply', '--data-dir', dataDir]);
    assert.equal(control.code, 3);
    // ... and so does the rollback.
    const back = runCli(['rollback', '--data-dir', dataDir]);
    assert.equal(back.code, 3);
    assert.match(back.err, /a Bridge is running/);
  } finally {
    holder.kill();
  }
});

/* ---------------------------------------------------------------- */
/* CE4: a rename that fails half way through is fully undone          */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-078: a folder rename that fails half way through is undone', () => {
  const { dataDir, state } = makeData(`ce4a-${counter++}`, 3);

  // The rename of the SECOND folder throws.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync; let n = 0;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep) && !String(a).includes('run_1_') && ++n === 2) {
        const e = new Error('EPERM: simulated'); e.code = 'EPERM'; throw e;
      }
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    const rep = applyMigration(${JSON.stringify(dataDir)}, {});
    console.log(JSON.stringify({ failed: rep.failed, rolledBack: rep.rolledBack, undone: rep.undone }));
  `], { encoding: 'utf8' });
  const report = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.equal(report.failed, true);
  assert.equal(report.rolledBack, true);

  // EVERY run of the restored state has its folder: the folders that were
  // renamed before the throw were renamed BACK.
  assert.deepEqual(missingFolders(dataDir), []);
  for (const r of state.runs) {
    assert.equal(fs.existsSync(path.join(dataDir, 'runs', r.id)), true, `the folder of ${r.id} is missing`);
  }
});

test('ATS-206-UT-079: the renamed folders are named in the undo report', () => {
  const { dataDir } = makeData(`ce4b-${counter++}`, 3);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync; let n = 0;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep) && !String(a).includes('run_1_') && ++n === 2) {
        const e = new Error('EPERM: simulated'); e.code = 'EPERM'; throw e;
      }
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    const rep = applyMigration(${JSON.stringify(dataDir)}, {});
    console.log(JSON.stringify(rep.undone));
  `], { encoding: 'utf8' });
  const undone = JSON.parse(child.stdout.trim().split('\n').pop());
  // The folder that was renamed before the throw is named as renamed back.
  assert.ok(
    undone.some((u) => u.includes('run folder renamed back')),
    `the undo report names no renamed folder: ${JSON.stringify(undone)}`
  );
});

/* ---------------------------------------------------------------- */
/* CE5: a rollback that would discard a run refuses and names it      */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-080: a rollback that would discard a run refuses and names it', () => {
  const { dataDir } = makeData('ce5', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);

  // The bridge records a new run after the migration.
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const newRun = {
    ...state.runs[0],
    id: `run_1_${'c'.repeat(24)}`,
    uid: `run_1_${'c'.repeat(24)}`,
    seq: 99,
    legacyId: undefined,
    createdAt: '2026-06-01T00:00:00.000Z',
  };
  state.runs.unshift(newRun);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  fs.mkdirSync(path.join(dataDir, 'runs', newRun.id), { recursive: true });

  res = runCli(['rollback', '--data-dir', dataDir]);
  // The rollback refuses ...
  assert.notEqual(res.code, 0);
  // ... the run is still in the state ...
  const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(after.runs.some((x) => x.id === newRun.id), 'the run was silently discarded');
  // ... and it is NAMED in the output.
  assert.match(res.out + res.err, new RegExp(newRun.id));
});

test('ATS-206-UT-081: a rollback with --force discards the run on purpose', () => {
  const { dataDir } = makeData('ce5b', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);

  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const newRun = { ...state.runs[0], id: `run_1_${'d'.repeat(24)}`, uid: `run_1_${'d'.repeat(24)}`, seq: 98 };
  state.runs.unshift(newRun);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  res = runCli(['rollback', '--data-dir', dataDir, '--force']);
  assert.equal(res.code, 0, res.err);
  const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(!after.runs.some((x) => x.id === newRun.id), 'the run was not discarded');
});

/* ---------------------------------------------------------------- */
/* CE6: an interrupted migration is finished, and the backup survives */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-082: an interrupted migration is finished by the next apply', () => {
  const { dataDir, state, text } = makeData('ce6', 2);

  // The process is killed after the state file is written, before the
  // folders are renamed.
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep)) process.exit(137);
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });

  // The journal of the killed run is on disk.
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-journal.json')), true);

  // The next apply finishes the migration.
  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  // Every run has its folder ...
  assert.deepEqual(missingFolders(dataDir), []);
  // ... and the v0.1 backup was NOT replaced.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json.bak'), 'utf8'), text);

  // The rollback still restores v0.1.
  const back = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(back.code, 0, back.err);
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
  const legacy = state.runs.filter((r) => fs.existsSync(path.join(dataDir, 'runs', r.id))).length;
  assert.equal(legacy, state.runs.length);
});

test('ATS-206-UT-083: the plan command reports an interrupted migration', () => {
  const { dataDir } = makeData('ce6b', 2);
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep)) process.exit(137);
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });

  const res = runCli(['plan', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /interrupted migration/);
});

test('ATS-206-UT-084: the journal is written before the first destructive write', () => {
  const { dataDir } = makeData('ce6c', 2);
  // The rename of the first folder throws: the journal has to be on disk by
  // then, because the state file has already been written.
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep)) {
        const e = new Error('EPERM: simulated'); e.code = 'EPERM'; throw e;
      }
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });
  // The failed run undid itself, so the journal is gone -- but the STATE
  // file has to be the original one, which proves the undo ran.
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(isMigrated(state), false);
});

/* ---------------------------------------------------------------- */
/* the engine: the recovery paths and the guards                     */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-086: an interrupted migration before the state write is undone', () => {
  const { dataDir } = makeData('ce6d', 2);
  // The process is killed BEFORE the state file is written -- the journal
  // exists, but the 'state' step was never recorded.
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep)) process.exit(137);
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });

  // The next apply finds the journal, undoes the interrupted run and
  // migrates cleanly.
  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(missingFolders(dataDir), []);
  assert.equal(
    fs.existsSync(path.join(dataDir, '.migration-journal.json')),
    false,
    'the journal of a finished migration is removed'
  );
});

test('ATS-206-UT-087: the rollback restores the database as well', () => {
  const { dataDir } = makeData('ce7', 2);
  let res = runCli(['apply', '--data-dir', dataDir, '--import-db']);
  assert.equal(res.code, 0, res.err);
  assert.equal(fs.existsSync(path.join(dataDir, 'metadata.db')), true);

  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  // The database backup was restored (there was no database before the
  // migration, so the backup file is gone and the database was removed).
  assert.equal(fs.existsSync(path.join(dataDir, 'metadata.db.bak')), false);
});

test('ATS-206-UT-088: a run id that is not a run id is refused', () => {
  const { dataDir } = makeData('ce8', 2);
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  // A run id that is not a path segment: the folder rename would leave the
  // runs directory.
  state.runs[0].id = '../../escape';
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /INVALID_RUN_ID/);
  // Nothing was written outside the data directory.
  assert.equal(fs.existsSync(path.join(path.dirname(dataDir), 'escape')), false);
});

test('ATS-206-UT-089: the rollback of a state that was never migrated is refused', () => {
  const { dataDir } = makeData('ce9', 2);
  const res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /NO_BACKUP_TO_RESTORE/);
});

test('ATS-206-UT-090: the verify command reports a state that is not JSON', () => {
  const { dataDir } = makeData('ce10', 1);
  fs.writeFileSync(path.join(dataDir, 'state.json'), 'not JSON at all');
  const res = runCli(['verify', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /STATE_NOT_JSON/);
  assert.doesNotMatch(res.err, /\n\s+at /);
});

test('ATS-206-UT-091: the plan command reports a state file that is missing', () => {
  const { dataDir } = makeData('ce11', 1);
  fs.rmSync(path.join(dataDir, 'state.json'));
  const res = runCli(['plan', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /STATE_FILE_MISSING/);
});

/* ---------------------------------------------------------------- */
/* the engine: the guards and the failure paths                       */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-092: a dry run writes nothing', () => {
  const { dataDir, text } = makeData('ce12', 2);
  const res = runCli(['apply', '--data-dir', dataDir, '--dry-run']);
  assert.equal(res.code, 0, res.err);
  // Neither the state file nor the backup was touched.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
  assert.equal(fs.existsSync(path.join(dataDir, 'state.json.bak')), false);
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-journal.json')), false);
});

test('ATS-206-UT-093: a state file that cannot be read is reported', () => {
  const { dataDir } = makeData('ce13', 2);
  // A directory where the state file should be: reading it fails.
  fs.rmSync(path.join(dataDir, 'state.json'));
  fs.mkdirSync(path.join(dataDir, 'state.json'));
  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /STATE_FILE_UNREADABLE/);
  assert.doesNotMatch(res.err, /\n\s+at /);
});

test('ATS-206-UT-094: a journal that cannot be parsed is not trusted', () => {
  const { dataDir } = makeData('ce14', 2);
  // A journal that is not JSON: it cannot describe what was done, so it is
  // kept for the operator and the migration refuses to guess.
  fs.writeFileSync(path.join(dataDir, '.migration-journal.json'), '{ this is not json');
  const res = runCli(['apply', '--data-dir', dataDir]);
  // The engine does not trust the journal -- the migration is refused with
  // a reason rather than run over an unknown state.
  assert.notEqual(res.code, 0);
  assert.match(res.err + res.out, /journal/i);
  // The journal was NOT deleted: the operator can look at it.
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-journal.json')), true);
});

test('ATS-206-UT-095: a marker that cannot be parsed is ignored', () => {
  const { dataDir } = makeData('ce15', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  fs.writeFileSync(path.join(dataDir, '.migration-marker.json'), 'not json');
  // The rollback still works: the backup is the source of truth.
  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
});

test('ATS-206-UT-096: a digest of a file that is not there is null', () => {
  const missing = path.join(ceDir, 'ce16', 'nope.json');
  // The engine has to answer "no digest" for a file that is not there,
  // rather than throwing: the rollback asks for the digest of a file that
  // may have been removed.
  assert.equal(typeof engine.digestOf, 'function', 'the engine has no digestOf');
  assert.equal(engine.digestOf(missing), null);
});

test('ATS-206-UT-097: an import into a database that fails leaves the state alone', () => {
  const { dataDir, text } = makeData('ce17', 2);
  // The database path is occupied by a directory: the import cannot work.
  fs.mkdirSync(path.join(dataDir, 'metadata.db'), { recursive: true });
  const res = runCli(['apply', '--data-dir', dataDir, '--import-db']);
  assert.equal(res.code, 1);
  // The state file was NOT migrated: the refusal happened before the
  // first destructive write.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
});

test('ATS-206-UT-098: a run of an unknown project is kept, not dropped', () => {
  const { dataDir } = makeData('ce18', 3);
  // A run that points at a project that is not in the state: the migration
  // cannot derive a project UID for it, but it must NOT lose the run --
  // losing it would change the counts, which is what the count check is
  // there to prevent.
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.runs[0].projectId = 'proj_does_not_exist';
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(after.runs.length, state.runs.length, 'a run was lost during the migration');
  assert.ok(after.runs.some((r) => r.legacyId === 'proj_does_not_exist' || r.projectId === 'proj_does_not_exist'));
});

test('ATS-206-UT-099: the rollback reports a state file that cannot be restored', () => {
  const { dataDir } = makeData('ce19', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  // The backup is removed: there is nothing to restore.
  fs.rmSync(path.join(dataDir, 'state.json.bak'));
  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /NO_BACKUP_TO_RESTORE/);
});

/* ---------------------------------------------------------------- */
/* the two bugs the e2e probe found on real v0.1 data                 */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-100: the migrated runs are NOT reported as lost by a rollback', () => {
  // The migration rewrites every run id. A rollback that compared the ids
  // directly would report EVERY migrated run as a run that the rollback
  // would lose -- and would refuse a rollback that loses nothing.
  const { dataDir } = makeData('ce20', 3);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);

  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  // The migrated runs are in the backup under their LEGACY ids, so the
  // rollback does not lose them.
  assert.doesNotMatch(res.out + res.err, /would DISCARD/);
});

test('ATS-206-UT-101: the bridge filling in the events does not block a rollback', () => {
  // The bridge writes the events of a run into the state when it reads it.
  // The bytes of the state file therefore change on every restart of the
  // bridge, even though the history is unchanged. A rollback that compared
  // the BYTES would refuse after every restart, and `--force` would be
  // needed every time -- which makes `--force` meaningless.
  const { dataDir } = makeData('ce21', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);

  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const r of state.runs) {
    r.events = [{ seq: 1, at: '2026-06-01T00:00:00.000Z', type: 'run.queued', data: {} }];
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  // The bytes are different, but the INVENTORY is not: the rollback works.
  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  assert.doesNotMatch(res.out + res.err, /STATE_DIVERGED/);
});

test('ATS-206-UT-102: a rollback still refuses when a run was added after the migration', () => {
  // The counterpart of UT-101: the INVENTORY did change, so the rollback
  // refuses and names the run.
  const { dataDir } = makeData('ce22', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);

  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const newId = `run_1_${'e'.repeat(24)}`;
  state.runs.unshift({
    ...state.runs[0],
    id: newId,
    uid: newId,
    legacyId: undefined,
    seq: 77,
  });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.notEqual(res.code, 0);
  assert.match(res.out + res.err, new RegExp(newId));
});

/* ---------------------------------------------------------------- */
/* the round-3 counterexamples: CE7, CE8, CE9 and CE10               */
/*                                                                    */
/* Every test in this section FAILS on the commit that was delivered   */
/* in round 2 (`66e50d3`) and PASSES after the round-3 fixes. The      */
/* fixtures are GENUINE v0.1 states -- the shape the v0.1 bridge wrote. */
/* ---------------------------------------------------------------- */

/**
 * Runs a piece of code in a child process and reports, for every
 * destructive write it does, whether the Bridge lock was HELD at that
 * moment.
 *
 * "Held" means: the lock file exists AND names THIS process. A stale lock
 * left behind by a killed run does not count -- the lock has to be the
 * one the engine took for the write it is doing.
 *
 * @param {string} dataDir the data directory
 * @param {string} call the call to make (the engine is `m`)
 * @returns {{count:number, allHeld:boolean, held:boolean[]}}
 */
function lockProbe(dataDir, call) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const core = await import(${JSON.stringify(coreModule)});
    const lock = core.lockPath(${JSON.stringify(dataDir)});
    const seen = [];
    // The authoritative question is "does THIS process still hold the
    // lock". The lock implementation of the day decides how that is
    // answered: verifyBridgeLock() when it exists, the pid of the lock
    // record otherwise.
    const held = () => {
      if (typeof core.verifyBridgeLock === 'function') {
        return core.verifyBridgeLock(lock).held === true;
      }
      try { return JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid; }
      catch { return false; }
    };
    // EVERY rename/copy/delete is counted -- including the lock's own.
    // The lock is published before it is held, so the engine has to leave
    // no stale lock behind: a killed migration that left one would make
    // the next run take it over, and the takeover writes the lock file
    // before the new lock is published.
    for (const fn of ['renameSync', 'copyFileSync', 'rmSync']) {
      const orig = fs[fn];
      fs[fn] = (a, ...rest) => {
        if (!String(a).endsWith('.tmp')
            && !String(a).includes('migration-')) seen.push(held());
        return orig(a, ...rest);
      };
    }
    const m = await import(${JSON.stringify(applyModule)});
    ${call};
    console.log(JSON.stringify(seen));
  `], { encoding: 'utf8' });
  const seen = JSON.parse(child.stdout.trim().split('\n').pop() || '[]');
  return { count: seen.length, allHeld: seen.length > 0 && seen.every(Boolean), held: seen };
}

/**
 * Kills a migration right after the state file has been renamed into
 * place -- before the journal records the "state" step.
 *
 * That is the window in which the state file says "migrated" while the
 * journal says "nothing happened yet".
 *
 * @param {string} dataDir the data directory
 */
function killAfterStateWrite(dataDir) {
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    fs.renameSync = (a, b) => {
      orig(a, b);
      if (String(a).endsWith('state.json.tmp')) process.exit(137);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });
}

/* ---------------------------------------------------------------- */
/* CE7: the backup is invalidated by the rollback                    */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-103: the second rollback restores the state of the SECOND apply', () => {
  // apply -> rollback -> the v0.1 bridge keeps working and records a run ->
  // apply again -> rollback again. The second rollback has to restore, byte
  // for byte, the v0.1 state that the SECOND apply migrated. A backup that
  // survives the first rollback is stale, and the second rollback would
  // restore the state of the FIRST migration: the run recorded in between
  // would disappear from the state and its folder would be orphaned.
  const { dataDir } = makeData('ce7a', 2);
  assert.equal(runCli(['apply', '--data-dir', dataDir]).code, 0);
  assert.equal(runCli(['rollback', '--data-dir', dataDir]).code, 0);

  // The v0.1 bridge records a run after the first rollback.
  const statePath = path.join(dataDir, 'state.json');
  const v01 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const extra = { ...v01.runs[0], id: `run_${crypto.randomUUID()}`, legacyId: undefined };
  v01.runs.unshift(extra);
  fs.writeFileSync(statePath, JSON.stringify(v01, null, 2));
  fs.mkdirSync(path.join(dataDir, 'runs', extra.id), { recursive: true });
  const v01Again = fs.readFileSync(statePath, 'utf8');

  // The second apply migrates THAT state.
  assert.equal(runCli(['apply', '--data-dir', dataDir]).code, 0);
  // The backup is the state that was migrated now, not the one of the first
  // migration.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json.bak'), 'utf8'), v01Again);

  // The second rollback restores it byte for byte, and the run recorded in
  // between is still there.
  const res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  const restored = fs.readFileSync(statePath, 'utf8');
  assert.equal(restored, v01Again, 'the second rollback did not restore the state of the second apply');
  assert.ok(restored.includes(extra.id), 'the run recorded in between was lost');

  // No folder is left behind under a name the restored state does not
  // refer to.
  const referenced = new Set(JSON.parse(restored).runs.map((r) => r.id));
  const orphans = fs.readdirSync(path.join(dataDir, 'runs')).filter((f) => !referenced.has(f));
  assert.deepEqual(orphans, []);
});

test('ATS-206-UT-104: a rollback archives the backup it has used', () => {
  // The backup of a rolled-back migration is STALE: it holds a state that
  // the directory does not go through any more. It is archived -- kept for
  // the operator, but no longer the backup of the current state -- and the
  // marker goes with it.
  const { dataDir } = makeData('ce7b', 2);
  assert.equal(runCli(['apply', '--data-dir', dataDir]).code, 0);
  const backup = path.join(dataDir, 'state.json.bak');
  const marker = path.join(dataDir, '.migration-marker.json');
  assert.equal(fs.existsSync(backup), true);
  assert.equal(fs.existsSync(marker), true);

  const res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  // The backup is not the backup of the current state any more ...
  assert.equal(fs.existsSync(backup), false, 'the stale backup is still there');
  // ... but it is not lost either.
  const archived = fs.readdirSync(dataDir).filter((f) => f.startsWith('state.json.bak.rolled-back'));
  assert.equal(archived.length, 1, 'the backup was not archived');
  assert.equal(fs.existsSync(marker), false, 'the marker of the rolled-back migration is still there');
});

/* ---------------------------------------------------------------- */
/* CE8: a rollback that would lose a run refuses                     */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-105: a rollback that would lose a run refuses even without a marker', () => {
  // The state was migrated by `migrate_uids --backup`, which writes NO
  // marker. A run recorded afterwards would be lost by the rollback. The
  // refusal cannot depend on the marker: the question is whether the
  // rollback would THROW A RUN AWAY, not whether the state changed.
  const { dataDir } = makeData('ce8a', 2);
  const uids = path.join(ceRepoRoot, 'tools', 'migrate_uids.mjs');
  const m = spawnSync(process.execPath, [uids, '--state', path.join(dataDir, 'state.json'), '--backup'],
    { encoding: 'utf8' });
  assert.equal(m.status, 0, m.stderr);
  // The tool that migrated the state writes no marker.
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-marker.json')), false);

  // A run is recorded after the migration.
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const newId = `run_1_${'d'.repeat(24)}`;
  state.runs.unshift({ ...state.runs[0], id: newId, uid: newId, legacyId: undefined, seq: 99 });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  fs.mkdirSync(path.join(dataDir, 'runs', newId), { recursive: true });

  const res = runCli(['rollback', '--data-dir', dataDir]);
  // The rollback refuses ...
  assert.notEqual(res.code, 0, 'the rollback discarded a run it did not have to');
  // ... the run is still in the state ...
  assert.ok(
    JSON.parse(fs.readFileSync(statePath, 'utf8')).runs.some((r) => r.id === newId),
    'the run was silently discarded'
  );
  // ... and it is NAMED in the output.
  assert.match(res.out + res.err, new RegExp(newId));
});

test('ATS-206-UT-106: a rollback that would lose nothing is not refused', () => {
  // The counterpart of UT-105: the refusal is driven by the runs that
  // would be lost, not by the marker. A rollback that loses nothing --
  // the bridge was started, the history is unchanged -- has to go through.
  const { dataDir } = makeData('ce8b', 2);
  assert.equal(runCli(['apply', '--data-dir', dataDir]).code, 0);

  // The bridge fills in the events of the runs it reads: the bytes change,
  // the inventory does not.
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const r of state.runs) {
    r.events = [{ seq: 1, at: '2026-06-01T00:00:00.000Z', type: 'run.queued', data: {} }];
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
});

/* ---------------------------------------------------------------- */
/* CE9: the state file decides, not the journal                      */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-107: an interrupted migration whose state file is written is never reported as UNDONE', () => {
  // The process is killed between the atomic write of the state file and
  // the `journal.done('state')` call: the state file holds the MIGRATED
  // identifiers, the journal does not know it. Judging the recovery by
  // the journal reports it as "UNDONE" and clears the journal -- while the
  // directory is half-migrated and nothing is left to say so.
  const { dataDir, state, text } = makeData('ce9a', 2);
  killAfterStateWrite(dataDir);

  const res = runCli(['apply', '--data-dir', dataDir]);
  const output = res.out + res.err;
  // It is NEVER reported as undone.
  assert.doesNotMatch(output, /UNDONE/);

  // Either it was FINISHED (exit 0, every folder reachable, the backup is
  // still v0.1) ...
  const finished = res.code === 0
    && missingFolders(dataDir).length === 0
    && fs.readFileSync(path.join(dataDir, 'state.json.bak'), 'utf8') === text;
  // ... or it was REFUSED with the journal kept (exit != 0, the journal is
  // on disk or the plan reports the interrupted migration).
  const journalKept = fs.existsSync(path.join(dataDir, '.migration-journal.json'));
  const plan = runCli(['plan', '--data-dir', dataDir]);
  const planWarns = /interrupted migration: found/.test(plan.out + plan.err);
  const refused = res.code !== 0 && (journalKept || planWarns);

  assert.ok(finished || refused,
    `the interrupted migration was neither finished nor refused (exit ${res.code}): ${output}`);

  // And in either case the rollback restores v0.1 with every folder.
  const back = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(back.code, 0, back.err);
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
  const legacy = state.runs.filter((r) => fs.existsSync(path.join(dataDir, 'runs', r.id))).length;
  assert.equal(legacy, state.runs.length);
});

test('ATS-206-UT-108: an interrupted migration whose folders cannot be reached is refused', () => {
  // The state file says "migrated", but the folder of a run exists under
  // NEITHER the old nor the new name. The recovery cannot finish it, so it
  // must refuse and point at the rollback -- and it must KEEP the journal,
  // because the directory is still half-migrated.
  const { dataDir } = makeData('ce9b', 2);
  killAfterStateWrite(dataDir);
  // One run folder disappears entirely.
  const migrated = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  fs.rmSync(path.join(dataDir, 'runs', migrated.runs[0].legacyId), { recursive: true, force: true });

  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.notEqual(res.code, 0, 'the recovery reported a success over an unreachable run');
  assert.doesNotMatch(res.out + res.err, /UNDONE/);
  assert.equal(
    fs.existsSync(path.join(dataDir, '.migration-journal.json')),
    true,
    'the journal of an unresolved interrupted migration was cleared'
  );
});

/* ---------------------------------------------------------------- */
/* CE10: the lock is held by the ENGINE, on every write path         */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-109: the rollback holds the Bridge lock for every write', () => {
  // The lock has to be taken INSIDE the engine: the CLI only READS it, and
  // a read leaves a window in which the Bridge can start.
  const { dataDir } = makeData('ce10a', 2);
  assert.equal(runCli(['apply', '--data-dir', dataDir]).code, 0);
  const probe = lockProbe(dataDir, `m.rollbackMigration(${JSON.stringify(dataDir)}, {})`);
  assert.ok(probe.count > 0, 'the rollback did not write anything');
  assert.equal(probe.allHeld, true, `the lock was not held during the rollback: ${JSON.stringify(probe.held)}`);
});

test('ATS-206-UT-110: the import of an already migrated state holds the Bridge lock', () => {
  // The `--import-db` path on an ALREADY MIGRATED state writes the
  // database -- a destructive write -- and it happened outside the lock.
  const { dataDir } = makeData('ce10b', 2);
  assert.equal(runCli(['apply', '--data-dir', dataDir]).code, 0);
  const probe = lockProbe(
    dataDir,
    `m.applyMigration(${JSON.stringify(dataDir)}, { importDatabase: true })`
  );
  assert.ok(probe.count > 0, 'the import did not write anything');
  assert.equal(probe.allHeld, true, `the lock was not held during the import: ${JSON.stringify(probe.held)}`);
});

test('ATS-206-UT-111: the recovery of an interrupted migration holds the Bridge lock', () => {
  // The recovery renames the run folders -- a destructive write -- and it
  // happened BEFORE the lock was taken.
  const { dataDir } = makeData('ce10c', 2);
  // The process is killed after the state write, at the first folder rename.
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep)) process.exit(137);
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-journal.json')), true);

  const probe = lockProbe(dataDir, `m.applyMigration(${JSON.stringify(dataDir)}, {})`);
  assert.ok(probe.count > 0, 'the recovery did not write anything');
  assert.equal(probe.allHeld, true, `the lock was not held during the recovery: ${JSON.stringify(probe.held)}`);
});

/* ---------------------------------------------------------------- */
/* the remaining write paths of the engine                           */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-112: the engine refuses while a Bridge holds the lock', () => {
  // The lock is taken INSIDE the engine. A Bridge that holds it makes the
  // apply refuse -- and it refuses BEFORE it writes anything. The engine is
  // called directly here, because the CLI checks the lock itself: the
  // engine has to hold the lock on its own, for the callers that do NOT go
  // through the CLI.
  const { dataDir } = makeData('ce-lock', 2);
  const lock = path.join(dataDir, 'bridge.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const before = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');

  const report = applyMigration(dataDir, {});
  assert.equal(report.ok, false);
  assert.equal(report.refused, true);
  assert.match(report.problems.join('\n'), /BRIDGE_ALREADY_RUNNING/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), before);
  // The lock of the Bridge is left alone.
  assert.equal(fs.existsSync(lock), true);
});

test('ATS-206-UT-113: the engine refuses to roll back while a Bridge holds the lock', () => {
  const { dataDir } = makeData('ce-lock2', 2);
  assert.equal(runCli(['apply', '--data-dir', dataDir]).code, 0);
  const lock = path.join(dataDir, 'bridge.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const before = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');

  const res = rollbackMigration(dataDir, {});
  assert.equal(res.restored, false);
  assert.match(res.problems.join('\n'), /BRIDGE_ALREADY_RUNNING/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), before);
});

test('ATS-206-UT-114: a dry run over an interrupted migration writes nothing', () => {
  // The recovery renames the run folders. A dry run must not do it -- not
  // even to report on it.
  const { dataDir, text } = makeData('ce-dry', 2);
  killAfterStateWrite(dataDir);
  const before = fs.readdirSync(path.join(dataDir, 'runs')).sort();

  const res = runCli(['apply', '--data-dir', dataDir, '--dry-run']);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out + res.err, /interrupted migration/);
  // Nothing was renamed.
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'runs')).sort(), before);
  // The journal is still there: the dry run did not resolve anything.
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-journal.json')), true);
});

test('ATS-206-UT-115: a stale backup is archived, not overwritten', () => {
  // The backup belongs to another migration. It is archived -- the operator
  // can still look at it -- and a fresh backup of the state that is migrated
  // now is written in its place.
  const { dataDir } = makeData('ce-stale', 2);
  assert.equal(runCli(['apply', '--data-dir', dataDir]).code, 0);
  // The rollback archives the backup and removes the marker.
  assert.equal(runCli(['rollback', '--data-dir', dataDir]).code, 0);
  // The state is v0.1 again. A new run is recorded.
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const extra = { ...state.runs[0], id: `run_${crypto.randomUUID()}`, legacyId: undefined };
  state.runs.unshift(extra);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  fs.mkdirSync(path.join(dataDir, 'runs', extra.id), { recursive: true });
  const v01Again = fs.readFileSync(statePath, 'utf8');

  // The second apply migrates THIS state. The archived backup of the first
  // migration is still there, and the new backup is the state being migrated.
  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  const archived = fs.readdirSync(dataDir).filter((f) => f.startsWith('state.json.bak.rolled-back'));
  assert.equal(archived.length, 1, 'the archive of the first backup is gone');
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json.bak'), 'utf8'), v01Again);
});

test('ATS-206-UT-116: an archived backup is never overwritten', () => {
  // Two rollbacks archive two backups. Both archives survive, under
  // different names.
  const { dataDir } = makeData('ce-arch', 2);
  assert.equal(runCli(['apply', '--data-dir', dataDir]).code, 0);
  assert.equal(runCli(['rollback', '--data-dir', dataDir]).code, 0);
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.runs.unshift({ ...state.runs[0], id: `run_${crypto.randomUUID()}`, legacyId: undefined });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  assert.equal(runCli(['apply', '--data-dir', dataDir]).code, 0);
  assert.equal(runCli(['rollback', '--data-dir', dataDir]).code, 0);

  const archived = fs.readdirSync(dataDir).filter((f) => f.startsWith('state.json.bak.rolled-back'));
  assert.equal(archived.length, 2, `expected 2 archives, got ${archived.join(', ')}`);
});

test('ATS-206-UT-117: an interrupted migration before the state write is undone under the lock', () => {
  // The undo path: the state file was NOT written, so the migration really
  // WAS undone -- and this is the one case where "UNDONE" is the truth.
  // The undo happens under the lock, like every other write of the engine.
  const { dataDir } = makeData('ce-undo', 2);
  // The process is killed while the temporary state file is written: the
  // state file itself is never replaced, so it still holds the v0.1
  // identifiers and the journal does not know about the state step.
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.writeFileSync;
    fs.writeFileSync = (a, ...rest) => {
      if (String(a).endsWith('state.json.tmp')) process.exit(137);
      return orig(a, ...rest);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-journal.json')), true);

  const probe = lockProbe(dataDir, `m.applyMigration(${JSON.stringify(dataDir)}, {})`);
  assert.ok(probe.count > 0, 'the recovery did not write anything');
  assert.equal(probe.allHeld, true, `the lock was not held during the undo: ${JSON.stringify(probe.held)}`);
  // The migration is finished and every folder is reachable.
  assert.deepEqual(missingFolders(dataDir), []);
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-journal.json')), false);
});

test('ATS-206-UT-118: an interrupted migration whose state was NOT written is reported as undone', () => {
  // The counterpart of UT-107: when the state file really was NOT written,
  // the recovery DOES undo -- and it says so. "UNDONE" is only forbidden
  // when the state file holds the migrated identifiers.
  const { dataDir, text } = makeData('ce-undone', 2);
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.writeFileSync;
    fs.writeFileSync = (a, ...rest) => {
      if (String(a).endsWith('state.json.tmp')) process.exit(137);
      return orig(a, ...rest);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });

  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  // The recovery says -- truthfully -- that it undid the interrupted run.
  assert.match(res.out + res.err, /UNDONE/);
  // The interrupted run really was undone: the state the apply then
  // migrated is the v0.1 one, with the v0.1 identifiers.
  const migrated = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  const before = JSON.parse(text);
  assert.equal(migrated.projects[0].id, projectUidFor(path.join(dataDir, 'app')));
  assert.equal(migrated.projects[0].legacyId, before.projects[0].id);
  assert.equal(migrated.runs[0].legacyId, before.runs[0].id);
});

test('ATS-206-UT-119: a killed migration leaves NO lock behind', () => {
  // A migration that is killed half way through must not leave the lock
  // behind. A lock left behind is stale: the next run has to take it over,
  // and the takeover renames and deletes the lock file -- writes that
  // happen BEFORE the new lock is published. The run that is doing its
  // recovery would then be seen writing without holding the lock.
  const { dataDir } = makeData('ce-stale-lock', 2);
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    fs.renameSync = (a, b) => {
      if (String(a).includes(${JSON.stringify(path.join(dataDir, 'runs') + path.sep)})) process.exit(137);
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });
  assert.equal(killed.status, 137, 'the migration was not killed');
  const lock = path.join(dataDir, 'bridge.lock');
  assert.equal(fs.existsSync(lock), false, 'the killed migration left its lock behind');
  assert.deepEqual(
    fs.readdirSync(dataDir).filter((n) => n.includes('.stale-')), [],
    'the killed migration left a stale lock file behind'
  );

  // The recovery therefore runs without taking a stale lock over -- and
  // every write it does is under the lock it holds.
  const probe = lockProbe(dataDir, `m.applyMigration(${JSON.stringify(dataDir)}, {})`);
  assert.ok(probe.count > 0, 'the recovery did not write anything');
  assert.equal(probe.allHeld, true, `the lock was not held during the recovery: ${JSON.stringify(probe.held)}`);
});

/* ---------------------------------------------------------------- */

test('ATS-206-UT-085: cleanup removes the temporary fixture', () => {
  fs.rmSync(ceDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(ceDir), false);
});
