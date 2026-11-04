import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planMigration, isMigrated, renameRunFolders } from '../tools/migrate_uids.mjs';
import { projectUidFor, runUidFor, isProjectUid, isRunUid } from '../server/uid.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-migrate-'));
const repoRoot = path.resolve(import.meta.dirname, '..');
const script = path.join(repoRoot, 'tools', 'migrate_uids.mjs');

function legacyState() {
  return {
    schema: 1,
    projects: [{
      id: 'proj_11111111-1111-1111-1111-111111111111',
      name: 'app',
      root: path.join(dir, 'app'),
      addedAt: '2026-01-01T00:00:00.000Z'
    }],
    runs: [
      // The bridge stores the history newest first.
      {
        id: 'run_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        projectId: 'proj_11111111-1111-1111-1111-111111111111',
        projectName: 'app',
        file: 'tests/a.spec.ts',
        gitCommit: 'abc1234',
        status: 'failed',
        createdAt: '2026-01-02T00:00:00.000Z',
        startedAt: '2026-01-02T00:00:01.000Z',
        finishedAt: '2026-01-02T00:00:09.000Z',
        eventSeq: 3,
        log: '',
        summary: null,
        artifacts: []
      },
      {
        id: 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        projectId: 'proj_11111111-1111-1111-1111-111111111111',
        projectName: 'app',
        file: 'tests/a.spec.ts',
        gitCommit: 'abc1234',
        status: 'passed',
        createdAt: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:01.000Z',
        finishedAt: '2026-01-01T00:00:09.000Z',
        eventSeq: 3,
        log: '',
        summary: null,
        artifacts: []
      }
    ]
  };
}

/* ---------------------------------------------------------------- */

test('UT-MIG-001: a legacy state is detected as not migrated', () => {
  assert.equal(isMigrated(legacyState()), false);
});

test('UT-MIG-002: the project UID is recomputed from the root path', () => {
  const { state } = planMigration(legacyState());
  assert.equal(state.projects[0].uid, projectUidFor(path.join(dir, 'app')));
  assert.equal(state.projects[0].id, state.projects[0].uid);
  assert.equal(state.projects[0].legacyId, 'proj_11111111-1111-1111-1111-111111111111');
});

test('UT-MIG-003: the run UIDs are recomputed and stay distinct', () => {
  const { state } = planMigration(legacyState());
  const ids = state.runs.map((r) => r.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(state.runs.every((r) => isRunUid(r.id) && r.id === r.uid));
  assert.ok(state.runs.every((r) => r.legacyId));
});

test('UT-MIG-004: the migrated state passes the migrated check', () => {
  const { state } = planMigration(legacyState());
  assert.equal(isMigrated(state), true);
});

test('UT-MIG-005: migrating twice produces the same result', () => {
  const first = planMigration(legacyState());
  const second = planMigration(first.state);
  assert.deepEqual(second.state.projects, first.state.projects);
  assert.deepEqual(second.state.runs, first.state.runs);
  assert.equal(second.changes.length, 0);
});

test('UT-MIG-006: the run order of the history is preserved', () => {
  const { state } = planMigration(legacyState());
  // The history list keeps its original order (newest first).
  assert.equal(state.runs[0].legacyId, 'run_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.equal(state.runs[1].legacyId, 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
});

test('UT-MIG-007: the run UID matches the one the bridge computes', () => {
  const legacy = legacyState();
  const { state } = planMigration(legacy);
  const projectUid = state.projects[0].uid;
  // The sequence is the chronological position inside the project: the run
  // created on 2026-01-01 is seq 1, the one of 2026-01-02 is seq 2.
  const oldest = state.runs.find((r) => r.legacyId === 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.equal(oldest.seq, 1);
  const expected = runUidFor({ projectUid, gitCommit: 'abc1234', file: 'tests/a.spec.ts', seq: 1 });
  assert.equal(oldest.id, expected);
});

test('UT-MIG-008: the run folders are renamed on disk', () => {
  const runsDir = path.join(dir, 'runs');
  fs.mkdirSync(path.join(runsDir, 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), { recursive: true });
  fs.writeFileSync(path.join(runsDir, 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'manifest.json'), '{}');
  const { renamedFolders } = planMigration(legacyState());
  const renamed = renameRunFolders(runsDir, renamedFolders);
  assert.equal(renamed.length, 1);
  assert.ok(fs.existsSync(path.join(runsDir, renamed[0].to, 'manifest.json')));
  assert.equal(fs.existsSync(path.join(runsDir, 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')), false);
});

test('UT-MIG-009: the CLI migrates a state file and is idempotent', () => {
  const dataDir = path.join(dir, 'cli');
  fs.mkdirSync(dataDir, { recursive: true });
  const statePath = path.join(dataDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(legacyState(), null, 2));

  const first = spawnSync(process.execPath, [script, '--state', statePath], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /migrated:/);

  const migrated = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(isMigrated(migrated), true);

  const second = spawnSync(process.execPath, [script, '--state', statePath], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already migrated/);
});

test('UT-MIG-010: the dry run writes nothing', () => {
  const dataDir = path.join(dir, 'dry');
  fs.mkdirSync(dataDir, { recursive: true });
  const statePath = path.join(dataDir, 'state.json');
  const original = JSON.stringify(legacyState(), null, 2);
  fs.writeFileSync(statePath, original);

  const res = spawnSync(process.execPath, [script, '--state', statePath, '--dry-run'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /dry run: nothing written/);
  assert.equal(fs.readFileSync(statePath, 'utf8'), original);
});

test('UT-MIG-011: a broken state file is reported, not silently overwritten', () => {
  const dataDir = path.join(dir, 'broken');
  fs.mkdirSync(dataDir, { recursive: true });
  const statePath = path.join(dataDir, 'state.json');
  fs.writeFileSync(statePath, '{ not json');
  const res = spawnSync(process.execPath, [script, '--state', statePath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cannot parse/);
  assert.equal(fs.readFileSync(statePath, 'utf8'), '{ not json');
});

test('UT-MIG-012: the backup keeps the original file', () => {
  const dataDir = path.join(dir, 'backup');
  fs.mkdirSync(dataDir, { recursive: true });
  const statePath = path.join(dataDir, 'state.json');
  const original = JSON.stringify(legacyState(), null, 2);
  fs.writeFileSync(statePath, original);
  const res = spawnSync(process.execPath, [script, '--state', statePath, '--backup'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(`${statePath}.bak`, 'utf8'), original);
});

test('UT-MIG-013: cleanup removes the temporary fixture', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});
