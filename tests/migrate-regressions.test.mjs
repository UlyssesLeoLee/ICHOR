/**
 * ATS-201: regression tests for the migration safety defects (H2 / H2').
 *
 * H2  -- a migration while the Bridge is running made the Bridge overwrite the
 *        migrated state with its own in-memory copy, so the state fell back to
 *        the old identifiers while the run folders were already renamed.
 * H2' -- "rollbackable" was not true: the `.bak` file restored the state but
 *        not the folder renames, so the restored state pointed at folders that
 *        did not exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { planMigration, isMigrated } from '../tools/migrate_uids.mjs';
import {
  acquireBridgeLock, releaseBridgeLock, readBridgeLock, lockPath, isProcessAlive
} from '../server/core.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-mig-reg-'));
const repoRoot = path.resolve(import.meta.dirname, '..');
const script = path.join(repoRoot, 'tools', 'migrate_uids.mjs');

function legacyState(root) {
  return {
    schema: 1,
    projects: [{
      id: 'proj_11111111-1111-1111-1111-111111111111',
      name: 'app',
      root,
      addedAt: '2026-01-01T00:00:00.000Z'
    }],
    runs: [{
      id: 'run_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      projectId: 'proj_11111111-1111-1111-1111-111111111111',
      projectName: 'app',
      file: 'tests/a.spec.ts',
      gitCommit: 'abc1234',
      status: 'passed',
      createdAt: '2026-01-02T00:00:00.000Z',
      startedAt: '2026-01-02T00:00:01.000Z',
      finishedAt: '2026-01-02T00:00:09.000Z',
      eventSeq: 3,
      log: '',
      summary: null,
      artifacts: []
    }]
  };
}

/* ------------------------------------------------------------------ */
/* The lock                                                           */
/* ------------------------------------------------------------------ */

test('UT-MIG-REG-001: the lock is held by the process that took it', () => {
  const file = path.join(dir, 'lock-a.json');
  acquireBridgeLock(file);
  const holder = readBridgeLock(file);
  assert.ok(holder);
  assert.equal(holder.pid, process.pid);
  releaseBridgeLock(file);
  assert.equal(readBridgeLock(file), null);
});

test('UT-MIG-REG-002: a lock of a dead process does not block', () => {
  const file = path.join(dir, 'lock-stale.json');
  // pid 0x7FFFFFFF does not exist; the lock is stale.
  fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, startedAt: '2026-01-01T00:00:00Z' }));
  assert.equal(readBridgeLock(file), null);
  // A stale lock does not prevent a new owner from taking it.
  acquireBridgeLock(file);
  assert.equal(readBridgeLock(file).pid, process.pid);
  releaseBridgeLock(file);
});

test('UT-MIG-REG-003: a second owner is refused while the lock is held', () => {
  const file = path.join(dir, 'lock-b.json');
  acquireBridgeLock(file);
  assert.throws(() => acquireBridgeLock(file), /BRIDGE_ALREADY_RUNNING/);
  releaseBridgeLock(file);
});

/* ------------------------------------------------------------------ */
/* H2 -- the migration refuses to run while the Bridge is running      */
/* ------------------------------------------------------------------ */

test('UT-MIG-REG-004: the migration is refused while a Bridge holds the lock', () => {
  const dataDir = path.join(dir, 'h2');
  fs.mkdirSync(dataDir, { recursive: true });
  const statePath = path.join(dataDir, 'state.json');
  const original = JSON.stringify(legacyState(path.join(dir, 'app')), null, 2);
  fs.writeFileSync(statePath, original);

  // A live process holds the lock -- this is the Bridge.
  const lockFile = lockPath(dataDir);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00Z' }));
  assert.ok(isProcessAlive(process.pid));

  const res = spawnSync(process.execPath, [script, '--state', statePath], { encoding: 'utf8' });
  // The migration is REFUSED, not silently executed.
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /Bridge is running/);
  // Nothing was written: the state file is untouched.
  assert.equal(fs.readFileSync(statePath, 'utf8'), original);
  // And the run folders were not renamed either.
  assert.equal(fs.existsSync(path.join(dataDir, 'runs')), false);
});

test('UT-MIG-REG-005: the migration runs when the lock is free', () => {
  const dataDir = path.join(dir, 'free');
  fs.mkdirSync(dataDir, { recursive: true });
  const statePath = path.join(dataDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(legacyState(path.join(dir, 'app')), null, 2));
  const res = spawnSync(process.execPath, [script, '--state', statePath], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /migrated:/);
  assert.equal(isMigrated(JSON.parse(fs.readFileSync(statePath, 'utf8'))), true);
  // The lock is released again, so the Bridge can start afterwards.
  assert.equal(readBridgeLock(lockPath(dataDir)), null);
});

/* ------------------------------------------------------------------ */
/* H2' -- the rollback restores the folders as well                    */
/* ------------------------------------------------------------------ */

test('UT-MIG-REG-006: the rollback restores the state AND the run folders', () => {
  const dataDir = path.join(dir, 'rollback');
  fs.mkdirSync(path.join(dataDir, 'runs'), { recursive: true });
  const statePath = path.join(dataDir, 'state.json');
  const legacyRun = 'run_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  fs.mkdirSync(path.join(dataDir, 'runs', legacyRun), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'runs', legacyRun, 'stdout.log'), 'evidence\n');
  const original = JSON.stringify(legacyState(path.join(dir, 'app')), null, 2);
  fs.writeFileSync(statePath, original);

  // Migrate with a backup.
  const mig = spawnSync(process.execPath, [script, '--state', statePath, '--backup'], { encoding: 'utf8' });
  assert.equal(mig.status, 0, mig.stderr);
  const migrated = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const newRun = migrated.runs[0].id;
  assert.notEqual(newRun, legacyRun);
  assert.ok(fs.existsSync(path.join(dataDir, 'runs', newRun)), 'the folder was renamed');

  // Roll back.
  const back = spawnSync(process.execPath, [script, '--state', statePath, '--rollback'], { encoding: 'utf8' });
  assert.equal(back.status, 0, back.stderr);
  // The state file is the original again ...
  assert.equal(fs.readFileSync(statePath, 'utf8'), original);
  // ... and the run folder is back under its LEGACY name, so the restored
  // state and the folders on disk are connected again.
  assert.ok(fs.existsSync(path.join(dataDir, 'runs', legacyRun, 'stdout.log')));
  assert.equal(fs.existsSync(path.join(dataDir, 'runs', newRun)), false);
});

test('UT-MIG-REG-007: a rollback without a backup is refused', () => {
  const dataDir = path.join(dir, 'nobackup');
  fs.mkdirSync(dataDir, { recursive: true });
  const statePath = path.join(dataDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(legacyState(path.join(dir, 'app')), null, 2));
  const res = spawnSync(process.execPath, [script, '--state', statePath, '--rollback'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /NO_BACKUP_TO_RESTORE/);
});

/* ------------------------------------------------------------------ */
/* The Bridge takes the same lock                                      */
/* ------------------------------------------------------------------ */

test('UT-MIG-REG-008: the Bridge refuses to start while a migration holds the lock', async () => {
  const dataDir = path.join(dir, 'bridge');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(legacyState(path.join(dir, 'app')), null, 2));

  // This process plays the role of the migration: it holds the lock.
  acquireBridgeLock(lockPath(dataDir));

  const cp = spawn(process.execPath, [path.join(repoRoot, 'server', 'index.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, ATS_PORT: '45999', ATS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  cp.stderr.on('data', (b) => { stderr += b.toString(); });
  const code = await new Promise((resolve) => cp.on('close', resolve));
  assert.notEqual(code, 0, 'the Bridge exits when the lock is held');
  assert.match(stderr, /holds the data directory lock/);
  releaseBridgeLock(lockPath(dataDir));
});

test('UT-MIG-REG-009: the Bridge releases the lock when it stops', async () => {
  const dataDir = path.join(dir, 'bridge2');
  fs.mkdirSync(dataDir, { recursive: true });
  const cp = spawn(process.execPath, [path.join(repoRoot, 'server', 'index.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, ATS_PORT: '45998', ATS_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  // Wait until the Bridge is up and holds the lock.
  const deadline = Date.now() + 20000;
  let held = false;
  while (Date.now() < deadline) {
    if (readBridgeLock(lockPath(dataDir))) { held = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(held, 'the Bridge holds the lock while it runs');
  cp.kill();
  await new Promise((r) => setTimeout(r, 1000));
  // A lock whose holder is gone is stale and does not block the next owner.
  assert.equal(readBridgeLock(lockPath(dataDir)), null);
});

test('UT-MIG-REG-010: cleanup removes the temporary fixture', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});
