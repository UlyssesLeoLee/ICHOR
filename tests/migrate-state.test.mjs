import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  planMigration, summarizeState, compareCounts, assertCountsPreserved,
  isMigrated, rekeyProjectMap, readStateFile, writeStateAtomic,
  validateState,
} from '../server/migration/state-migration.mjs';
import {
  applyMigration, rollbackMigration, undoMigration, MigrationJournal,
  importAndVerify, pathsOf, backupFile, restoreBackup,
} from '../server/migration/apply.mjs';
import { projectUidFor } from '../server/uid.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats206-'));
const repoRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(repoRoot, 'tools', 'migrate_state.mjs');

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

/* ---------------------------------------------------------------- */
/* a failed migration is undone                                     */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-040: a failed migration is undone automatically', () => {
  const dataDir = makeDataDir(legacyState(), 'fail-undo');
  const paths = pathsOf(dataDir);
  const original = fs.readFileSync(paths.statePath, 'utf8');

  // A run folder named after the legacy identifier.
  fs.mkdirSync(path.join(paths.runsDir, LEGACY_RUN_A), { recursive: true });
  fs.writeFileSync(path.join(paths.runsDir, LEGACY_RUN_A, 'manifest.json'), '{}');

  // The state file is written and the folders are renamed; the database
  // import then FAILS. The failure has to undo both steps.
  const journal = new MigrationJournal();
  backupFile(paths.statePath);
  writeStateAtomic(paths.statePath, { ...JSON.parse(original), uidVersion: 1 });
  journal.done('state');
  journal.renamedFolders = [{ from: LEGACY_RUN_A, to: 'run_1_000000000000000000000000' }];
  journal.done('folders');

  const undone = undoMigration(journal, paths);
  assert.ok(undone.some((u) => u.includes('state file restored')), undone.join('; '));
  assert.equal(fs.readFileSync(paths.statePath, 'utf8'), original);
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
