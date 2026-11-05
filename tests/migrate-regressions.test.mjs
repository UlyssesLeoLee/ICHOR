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
  acquireBridgeLock, releaseBridgeLock, readBridgeLock, lockPath, isProcessAlive, processStartTime
} from '../server/core.mjs';
import { freePort } from './helpers/free-port.mjs';

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

/* ------------------------------------------------------------------ */
/* L1 -- the holder of the lock is VERIFIABLE                            */
/* ------------------------------------------------------------------ */

test('UT-MIG-REG-011: the lock records the start time of its holder', () => {
  const file = path.join(dir, 'lock-identity.json');
  acquireBridgeLock(file);
  const holder = readBridgeLock(file);
  assert.ok(holder);
  assert.equal(holder.pid, process.pid);
  // The start time is what makes the pid verifiable: a pid alone is reused by
  // the operating system, the pair (pid, start time) is not.
  assert.ok(holder.processStartedAt, 'the lock records the start time of the holder');
  releaseBridgeLock(file);
});

test('UT-MIG-REG-012: a lock whose pid was reused by another process is stale', () => {
  const file = path.join(dir, 'lock-reused.json');
  // The pid is alive -- it is this very process -- but it is NOT the process
  // that took the lock: the recorded start time belongs to somebody else.
  // The operating system reuses pids, so this is what a leftover lock file
  // looks like once its original owner is gone.
  const foreign = processStartTime(process.pid);
  fs.writeFileSync(file, JSON.stringify({
    pid: process.pid,
    startedAt: '2026-01-01T00:00:00Z',
    processStartedAt: foreign === null ? 'not-a-real-start-time' : '2001-01-01T00:00:00.0000000Z'
  }));
  // The lock does not block: the holder cannot be the recorded one.
  assert.equal(readBridgeLock(file), null);
  // And the next owner can take it.
  acquireBridgeLock(file);
  assert.equal(readBridgeLock(file).pid, process.pid);
  releaseBridgeLock(file);
});

test('UT-MIG-REG-013: a lock of a live holder is not stale', () => {
  const file = path.join(dir, 'lock-live.json');
  acquireBridgeLock(file);
  const holder = readBridgeLock(file);
  assert.ok(holder, 'the holder is live');
  assert.equal(holder.pid, process.pid);
  assert.throws(() => acquireBridgeLock(file), /BRIDGE_ALREADY_RUNNING/);
  releaseBridgeLock(file);
});

test('UT-MIG-REG-014: the Bridge states the recovery steps when the lock is held', async () => {
  const dataDir = path.join(dir, 'recovery');
  fs.mkdirSync(dataDir, { recursive: true });
  // A lock that carries no verifiable identity: the pid is alive, but nothing
  // says WHICH process it is. The Bridge cannot tell a running Bridge from a
  // reused pid, so it refuses to start and answers with the steps that
  // resolve the question.
  fs.writeFileSync(lockPath(dataDir), JSON.stringify({
    pid: process.pid,
    startedAt: '2026-01-01T00:00:00Z'
  }));

  const port = await freePort();
  const cp = spawn(process.execPath, [path.join(repoRoot, 'server', 'index.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  cp.stderr.on('data', (b) => { stderr += b.toString(); });
  const code = await new Promise((resolve) => cp.on('close', resolve));
  assert.notEqual(code, 0, 'the Bridge exits when the lock is held');
  // The message says HOW to recover, not only that something holds the lock.
  assert.match(stderr, /holds the data directory lock/);
  assert.match(stderr, /delete the lock file/i, 'the recovery step is stated');
  assert.match(stderr, /no Bridge is running/i, 'the check comes before the step');
});

test('UT-MIG-REG-015: the Bridge starts when the lock belongs to a reused pid', async () => {
  const dataDir = path.join(dir, 'reused');
  fs.mkdirSync(dataDir, { recursive: true });
  // The pid is alive -- it is this very process -- but the recorded start time
  // belongs to another process: the operating system reused the pid. The lock
  // is stale, so it does not block the Bridge.
  const foreign = processStartTime(process.pid);
  fs.writeFileSync(lockPath(dataDir), JSON.stringify({
    pid: process.pid,
    startedAt: '2026-01-01T00:00:00Z',
    processStartedAt: foreign === null ? 'not-a-real-start-time' : '2001-01-01T00:00:00.0000000Z'
  }));

  const port = await freePort();
  const cp = spawn(process.execPath, [path.join(repoRoot, 'server', 'index.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  cp.stderr.on('data', (b) => { stderr += b.toString(); });
  // The Bridge has to come UP: it listens on its port.
  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { up = true; break; } } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  cp.kill();
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(up, `the Bridge starts despite the stale lock: ${stderr}`);
});

test('UT-MIG-REG-016: cleanup removes the temporary fixture', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});
