/**
 * ATS-207 -- the data directory lock and the durable state persistence.
 *
 * UT-LOCK-*  the lock: atomic acquisition, stale takeover, waiting, holder
 *            check, release, the contention budget and the fallbacks.
 * UT-DATA-*  the state file: damaged files are refused, the write is synced
 *            before the rename, a failed write leaves the old file intact,
 *            leftover temp files are removed.
 * UT-WAL-*   the SQLite mirror at start-up: a damaged mirror is moved aside
 *            together with its WAL and rebuilt from the state file.
 *
 * Other holders of the lock are CHILD PROCESSES, so the race tests exercise
 * real concurrent processes. Failures a real disk does not produce on demand
 * are injected by replacing a property of the `node:fs` default export (the
 * module under test reads it at call time); every injection is undone in a
 * `finally`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  acquireBridgeLock, releaseBridgeLock, readBridgeLock, verifyBridgeLock, takeOverStaleLock,
  lockWaitFromEnv, lockVerifyIntervalFromEnv, ownProcessStartTime, processStartTime,
  LOCK_MAX_ATTEMPTS, LOCK_VERIFY_DEFAULT_MS, LOCK_VERIFY_MIN_MS,
  loadState, saveState, writeFileDurably, removeStateTempFiles, syncDirectory,
  recoverMetadataMirror, metadataPath, STATE_RENAME_ATTEMPTS,
} from '../server/core.mjs';
import { openDatabase } from '../server/sqlite/db.mjs';
import { verifyMirror } from '../server/sqlite/import.mjs';

const CORE_URL = pathToFileURL(path.resolve('server/core.mjs')).href;
const DEAD_PID = 2147483647;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats207-ut-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
const freshDir = (name) => {
  const d = path.join(root, `${name}-${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => /\.tmp$|\.stale-/.test(n));

/** Replaces fs[name] for the duration of `fn`, always restoring it. */
async function withFs(name, replacement, fn) {
  const original = fs[name];
  fs[name] = replacement(original);
  try { return await fn(); } finally { fs[name] = original; }
}

/** A child process running ESM code that imports the module under test as `core`. */
function child(body) {
  const code = `import * as core from ${JSON.stringify(CORE_URL)};import fs from 'node:fs';${body}`;
  return spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Resolves with the child's stdout once `re` matches it. */
function waitFor(cp, re, ms = 30000) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${re}: ${out} ${err}`)), ms);
    cp.stdout.on('data', (b) => { out += b; if (re.test(out)) { clearTimeout(timer); resolve(out); } });
    cp.stderr.on('data', (b) => { err += b; });
    cp.on('close', () => { if (!re.test(out)) { clearTimeout(timer); reject(new Error(`child exited: ${out} ${err}`)); } });
  });
}

const kill = (cp) => { try { cp.kill('SIGKILL'); } catch { /* gone */ } };

/* ------------------------------------------------------------------ */
/* The lock                                                           */
/* ------------------------------------------------------------------ */

test('UT-LOCK-001: acquire publishes a complete record that this process can verify and release', () => {
  const dir = freshDir('lock');
  const file = path.join(dir, 'bridge.lock');
  assert.equal(acquireBridgeLock(file), file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.pid, process.pid);
  assert.ok(raw.startedAt);
  assert.equal(raw.processStartedAt, ownProcessStartTime());
  assert.match(raw.token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(verifyBridgeLock(file), { held: true, reason: 'held', holder: raw });
  assert.deepEqual(leftovers(dir), [], 'the publication leaves no temp file');
  assert.equal(releaseBridgeLock(file), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(verifyBridgeLock(file).reason, 'not-acquired', 'a released lock is no longer claimed');
});

test('UT-LOCK-002: a live holder is never overwritten', () => {
  const file = path.join(freshDir('lock'), 'bridge.lock');
  acquireBridgeLock(file);
  const before = fs.readFileSync(file);
  assert.throws(() => acquireBridgeLock(file), (e) => {
    assert.equal(e.code, 'BRIDGE_ALREADY_RUNNING');
    assert.equal(e.reason, 'held');
    assert.equal(e.holder.pid, process.pid);
    return true;
  });
  assert.deepEqual(fs.readFileSync(file), before, 'the refused acquirer did not touch the lock');
  releaseBridgeLock(file);
});

test('UT-LOCK-003: a waiting acquirer gives up after waitMs', async () => {
  const file = path.join(freshDir('lock'), 'bridge.lock');
  const holder = child(`core.acquireBridgeLock(${JSON.stringify(file)});console.log('LOCKED');setInterval(()=>{},1000);`);
  try {
    await waitFor(holder, /LOCKED/);
    const t0 = Date.now();
    assert.throws(() => acquireBridgeLock(file, { waitMs: 400 }), (e) => {
      assert.equal(e.code, 'BRIDGE_ALREADY_RUNNING');
      assert.equal(e.holder.pid, holder.pid);
      assert.ok(e.waitedMs >= 400, `waited ${e.waitedMs} ms`);
      return true;
    });
    assert.ok(Date.now() - t0 >= 400);
  } finally { kill(holder); }
});

test('UT-LOCK-004: a waiting acquirer gets the lock once the holder releases it', async () => {
  const file = path.join(freshDir('lock'), 'bridge.lock');
  const holder = child(`core.acquireBridgeLock(${JSON.stringify(file)});console.log('LOCKED');` +
    `setTimeout(()=>{core.releaseBridgeLock(${JSON.stringify(file)});process.exit(0);},500);`);
  try {
    await waitFor(holder, /LOCKED/);
    acquireBridgeLock(file, { waitMs: 15000, pollMs: 50 });
    assert.equal(readBridgeLock(file).pid, process.pid);
    releaseBridgeLock(file);
  } finally { kill(holder); }
});

test('UT-LOCK-005: stale locks (dead pid, reused pid) are taken over without leftovers', () => {
  const dir = freshDir('lock');
  const file = path.join(dir, 'bridge.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, startedAt: '2026-01-01T00:00:00Z' }));
  acquireBridgeLock(file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  releaseBridgeLock(file);
  const foreign = processStartTime(process.pid) === null ? 'not-a-real-start-time' : '2001-01-01T00:00:00.0000000Z';
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: 'x', processStartedAt: foreign, token: 'old' }));
  acquireBridgeLock(file);
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'old');
  assert.equal(verifyBridgeLock(file).held, true);
  releaseBridgeLock(file);
  assert.deepEqual(leftovers(dir), []);
});

test('UT-LOCK-006: a live pid without a start time is HELD; a garbage lock is taken over', () => {
  const file = path.join(freshDir('lock'), 'bridge.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00Z' }));
  assert.throws(() => acquireBridgeLock(file), /BRIDGE_ALREADY_RUNNING/);
  fs.writeFileSync(file, '{"pid": 12, half a record');
  acquireBridgeLock(file);
  assert.equal(verifyBridgeLock(file).held, true);
  releaseBridgeLock(file);
});

/** Runs N children that all acquire `file` at the same instant. */
async function race(dir, file, n) {
  const go = path.join(dir, 'GO');
  const done = path.join(dir, 'DONE');
  const kids = [];
  for (let i = 0; i < n; i++) {
    kids.push(child(
      `core.ownProcessStartTime();console.log('READY');` +
      `const w=new Int32Array(new SharedArrayBuffer(4));` +
      `while(!fs.existsSync(${JSON.stringify(go)}))Atomics.wait(w,0,0,1);` +
      `try{core.acquireBridgeLock(${JSON.stringify(file)});console.log('WON');}` +
      `catch(e){console.log(e.code==='BRIDGE_ALREADY_RUNNING'?'HELD':'ERR '+e.message);}` +
      `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(done)})){clearInterval(t);process.exit(0);}},20);`
    ));
  }
  try {
    await Promise.all(kids.map((k) => waitFor(k, /READY/, 60000)));
    const verdicts = kids.map((k) => waitFor(k, /WON|HELD|ERR/, 60000));
    fs.writeFileSync(go, '');
    const outs = await Promise.all(verdicts);
    const winners = kids.filter((k, i) => /WON/.test(outs[i]));
    const held = outs.filter((o) => /HELD/.test(o)).length;
    return { winners, held, outs, lockPid: JSON.parse(fs.readFileSync(file, 'utf8')).pid };
  } finally {
    fs.writeFileSync(done, '');
    kids.forEach(kill);
  }
}

test('UT-LOCK-007: of 6 processes acquiring at the same instant exactly one wins', async () => {
  const dir = freshDir('race');
  const file = path.join(dir, 'bridge.lock');
  const r = await race(dir, file, 6);
  assert.equal(r.winners.length, 1, `winners: ${r.outs.join(' | ')}`);
  assert.equal(r.held, 5);
  assert.equal(r.lockPid, r.winners[0].pid, 'the lock names the winner');
});

test('UT-LOCK-008: of 6 processes taking over one stale lock exactly one wins', async () => {
  const dir = freshDir('race-stale');
  const file = path.join(dir, 'bridge.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, startedAt: '2026-01-01T00:00:00Z' }));
  const r = await race(dir, file, 6);
  assert.equal(r.winners.length, 1, `winners: ${r.outs.join(' | ')}`);
  assert.equal(r.held, 5);
  assert.equal(r.lockPid, r.winners[0].pid);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.stale-')), []);
});

test('UT-LOCK-009: a takeover that moved a FRESH lock puts it back', async () => {
  const dir = freshDir('takeover');
  const file = path.join(dir, 'bridge.lock');
  const fresh = JSON.stringify({ pid: process.pid, startedAt: 'now', processStartedAt: ownProcessStartTime(), token: 'fresh' });
  fs.writeFileSync(file, fresh);
  assert.equal(takeOverStaleLock(file, 'the bytes that were judged stale'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), fresh, 'the fresh lock is restored byte-identical');
  assert.deepEqual(leftovers(dir), []);
  // Nothing to move: somebody else moved it first.
  assert.equal(takeOverStaleLock(path.join(dir, 'missing.lock'), 'x'), false);
  // A filesystem without hard links restores with an exclusive create.
  await withFs('linkSync', () => () => { const e = new Error('no links'); e.code = 'EPERM'; throw e; }, () => {
    assert.equal(takeOverStaleLock(file, 'stale'), false);
  });
  assert.equal(fs.readFileSync(file, 'utf8'), fresh);
  assert.deepEqual(leftovers(dir), []);
  // A rename error that is not "already gone" is reported.
  await withFs('renameSync', () => () => { const e = new Error('io'); e.code = 'EIO'; throw e; }, () => {
    assert.throws(() => takeOverStaleLock(file, 'stale'), /io/);
  });
});

test('UT-LOCK-010: a restore never overwrites a lock published in the meantime', async () => {
  const dir = freshDir('takeover');
  const file = path.join(dir, 'bridge.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'displaced' }));
  const newer = JSON.stringify({ pid: process.pid, token: 'newer' });
  await withFs('linkSync', (orig) => (from, to) => { fs.writeFileSync(to, newer); return orig(from, to); }, () => {
    assert.equal(takeOverStaleLock(file, 'stale'), false);
  });
  assert.equal(fs.readFileSync(file, 'utf8'), newer, 'the newer lock is kept');
  assert.deepEqual(leftovers(dir), []);
  // Without hard links, the exclusive create refuses the existing newer lock too.
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'displaced' }));
  await withFs('linkSync', () => (from, to) => { fs.writeFileSync(to, newer); const e = new Error('no'); e.code = 'ENOTSUP'; throw e; }, () => {
    assert.equal(takeOverStaleLock(file, 'stale'), false);
  });
  assert.equal(fs.readFileSync(file, 'utf8'), newer);
});

test('UT-LOCK-011: a filesystem without hard links falls back to an exclusive create', async () => {
  for (const code of ['EPERM', 'ENOTSUP']) {
    const file = path.join(freshDir('nolink'), 'bridge.lock');
    await withFs('linkSync', () => () => { const e = new Error(code); e.code = code; throw e; }, () => {
      acquireBridgeLock(file);
      assert.equal(verifyBridgeLock(file).held, true);
      assert.throws(() => acquireBridgeLock(file), /BRIDGE_ALREADY_RUNNING/);
    });
    assert.equal(releaseBridgeLock(file), true);
  }
});

test('UT-LOCK-012: a lock that keeps changing ends in reason "contended"; hard errors surface', async () => {
  const file = path.join(freshDir('churn'), 'bridge.lock');
  await withFs('linkSync', () => () => { const e = new Error('exists'); e.code = 'EEXIST'; throw e; }, () => {
    assert.throws(() => acquireBridgeLock(file), (e) => e.code === 'BRIDGE_ALREADY_RUNNING' && e.reason === 'contended');
  });
  let calls = 0;
  await withFs('linkSync', () => () => { calls++; const e = new Error('busy'); e.code = 'EBUSY'; throw e; }, () => {
    assert.throws(() => acquireBridgeLock(file), (e) => e.code === 'EBUSY');
  });
  assert.equal(calls, LOCK_MAX_ATTEMPTS, 'transient errors are retried within the budget');
  await withFs('linkSync', () => () => { const e = new Error('io'); e.code = 'EIO'; throw e; }, () => {
    assert.throws(() => acquireBridgeLock(file), (e) => e.code === 'EIO');
  });
  // A stale lock whose takeover keeps hitting a sharing violation also ends contended.
  fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID }));
  await withFs('renameSync', () => () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }, () => {
    assert.throws(() => acquireBridgeLock(file), (e) => e.reason === 'contended');
  });
  await withFs('renameSync', () => () => { const e = new Error('io'); e.code = 'EIO'; throw e; }, () => {
    assert.throws(() => acquireBridgeLock(file), (e) => e.code === 'EIO');
  });
  fs.rmSync(file, { force: true });
});

test('UT-LOCK-013: release and verify never claim a lock this process does not hold', () => {
  const dir = freshDir('foreign');
  const file = path.join(dir, 'bridge.lock');
  assert.equal(verifyBridgeLock(file).reason, 'not-acquired');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'someone-else' }));
  assert.equal(releaseBridgeLock(file), false);
  fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, token: 'x' }));
  assert.equal(releaseBridgeLock(file), false);
  assert.ok(fs.existsSync(file), 'a foreign lock is never removed');
  assert.equal(releaseBridgeLock(path.join(dir, 'missing.lock')), false);
  // A legacy record (no token) of this pid is ours.
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: 'x' }));
  assert.equal(releaseBridgeLock(file), true);

  acquireBridgeLock(file);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'replaced' }));
  const taken = verifyBridgeLock(file);
  assert.deepEqual([taken.held, taken.reason, taken.holder.token], [false, 'taken-over', 'replaced']);
  fs.writeFileSync(file, 'garbage');
  assert.equal(verifyBridgeLock(file).reason, 'unreadable');
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(verifyBridgeLock(file).reason, 'unreadable', 'a read error that is not ENOENT');
  fs.rmSync(file, { recursive: true });
  assert.equal(verifyBridgeLock(file).reason, 'absent');
});

test('UT-LOCK-014: the environment and the options are validated', () => {
  assert.equal(lockWaitFromEnv(undefined), 0);
  assert.equal(lockWaitFromEnv(''), 0);
  assert.equal(lockWaitFromEnv('-1'), 0);
  assert.equal(lockWaitFromEnv('abc'), 0);
  assert.equal(lockWaitFromEnv('1.5'), 0);
  assert.equal(lockWaitFromEnv('250'), 250);
  assert.equal(lockVerifyIntervalFromEnv(undefined), LOCK_VERIFY_DEFAULT_MS);
  assert.equal(lockVerifyIntervalFromEnv('x'), LOCK_VERIFY_DEFAULT_MS);
  assert.equal(lockVerifyIntervalFromEnv('10'), LOCK_VERIFY_MIN_MS);
  assert.equal(lockVerifyIntervalFromEnv('250'), 250);
  const file = path.join(freshDir('opts'), 'bridge.lock');
  acquireBridgeLock(file);
  for (const options of [{ waitMs: -5, pollMs: 'x' }, { waitMs: 'abc' }, { waitMs: true }, { waitMs: null }, { waitMs: ' ' }]) {
    const t0 = Date.now();
    assert.throws(() => acquireBridgeLock(file, options), /BRIDGE_ALREADY_RUNNING/);
    assert.ok(Date.now() - t0 < 2000, `${JSON.stringify(options)} must not wait`);
  }
  assert.throws(() => acquireBridgeLock(file, { waitMs: '120', pollMs: 0 }), (e) => e.waitedMs >= 120);
  releaseBridgeLock(file);
});

test('UT-LOCK-015: createDir:false does not recreate a missing data directory', () => {
  const missing = path.join(freshDir('gone'), 'no-such-dir');
  assert.throws(() => acquireBridgeLock(path.join(missing, 'bridge.lock'), { createDir: false }), (e) => e.code === 'ENOENT');
  assert.equal(fs.existsSync(missing), false);
});

/* ------------------------------------------------------------------ */
/* The state file                                                     */
/* ------------------------------------------------------------------ */

function useDataDir(name) {
  const dir = freshDir(name);
  process.env.ATS_DATA_DIR = dir;
  return dir;
}
const sampleState = (n = 1) => ({
  schema: 1,
  projects: [{ id: 'prj_1', root: 'C:/p', name: 'p' }],
  runs: Array.from({ length: n }, (_, i) => ({ id: `run_${i}`, projectId: 'prj_1', status: 'passed', createdAt: '2026-01-01T00:00:00Z' })),
  uidRegistry: { version: 1, projects: {} },
});

test('UT-DATA-001: a damaged state file is refused, never replaced', () => {
  const dir = useDataDir('state-bad');
  const file = path.join(dir, 'state.json');
  for (const [content, code] of [['{"schema":1,"projects":[', 'STATE_CORRUPT'], ['', 'STATE_CORRUPT'], ['null', 'UNSUPPORTED_DATABASE'], ['{"schema":2}', 'UNSUPPORTED_DATABASE']]) {
    fs.writeFileSync(file, content);
    assert.throws(() => loadState(), (e) => {
      assert.equal(e.code, code);
      assert.equal(e.message, code);
      assert.equal(e.file, file);
      assert.ok(e.detail.length > 0);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), content, 'the damaged file is left as it is');
  }
  fs.writeFileSync(file, '');
  assert.throws(() => loadState(), (e) => e.detail === 'the file is empty');
});

test('UT-DATA-002: saveState syncs the temp file before the rename', async () => {
  const dir = useDataDir('state-sync');
  const events = [];
  await withFs('fsyncSync', (orig) => (fd) => { events.push('fsync'); return orig(fd); }, () =>
    withFs('renameSync', (orig) => (from, to) => { events.push(`rename ${path.basename(from)}`); return orig(from, to); }, () => {
      saveState(sampleState(3));
    }));
  const first = events.findIndex((e) => e.startsWith('rename'));
  assert.ok(first > 0, `events: ${events}`);
  assert.equal(events[first - 1], 'fsync', 'the data is synced before the commit point');
  assert.equal(events[first], `rename state.json.${process.pid}.tmp`);
  assert.deepEqual(leftovers(dir), []);
  assert.equal(loadState().runs.length, 3);
});

test('UT-DATA-003: a failed write leaves the previous state intact', async () => {
  const dir = useDataDir('state-fail');
  const file = path.join(dir, 'state.json');
  saveState(sampleState(1));
  const before = fs.readFileSync(file);
  let failures = 0;
  await withFs('renameSync', (orig) => (from, to) => {
    if (failures < 2) { failures++; const e = new Error('locked'); e.code = 'EPERM'; throw e; }
    return orig(from, to);
  }, () => saveState(sampleState(2)));
  assert.equal(failures, 2);
  assert.equal(loadState().runs.length, 2, 'a transient sharing violation is retried');
  const committed = fs.readFileSync(file);
  let attempts = 0;
  await withFs('renameSync', () => () => { attempts++; const e = new Error('busy'); e.code = 'EBUSY'; throw e; }, () => {
    assert.throws(() => saveState(sampleState(5)), (e) => e.code === 'EBUSY');
  });
  assert.equal(attempts, STATE_RENAME_ATTEMPTS);
  await withFs('renameSync', () => () => { const e = new Error('full'); e.code = 'ENOSPC'; throw e; }, () => {
    assert.throws(() => saveState(sampleState(6)), (e) => e.code === 'ENOSPC');
  });
  await withFs('fsyncSync', () => () => { const e = new Error('io'); e.code = 'EIO'; throw e; }, () => {
    assert.throws(() => writeFileDurably(file, 'never'), (e) => e.code === 'EIO');
  });
  assert.deepEqual(fs.readFileSync(file), committed, 'the committed state survives every failure');
  assert.deepEqual(leftovers(dir), [], 'no temp file is left behind');
  assert.notDeepEqual(before, committed);
});

test('UT-DATA-004: leftover temp files of an interrupted save are removed, nothing else', () => {
  const dir = useDataDir('state-temps');
  saveState(sampleState(2));
  const state = fs.readFileSync(path.join(dir, 'state.json'));
  fs.writeFileSync(path.join(dir, 'state.json.tmp'), '{"schema":1,"proj');
  fs.writeFileSync(path.join(dir, 'state.json.4242.tmp'), '');
  fs.writeFileSync(path.join(dir, 'state.json.bak'), 'backup');
  fs.writeFileSync(path.join(dir, 'other.tmp'), 'x');
  assert.deepEqual(removeStateTempFiles(dir).sort(), ['state.json.4242.tmp', 'state.json.tmp']);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), state);
  assert.equal(fs.readFileSync(path.join(dir, 'state.json.bak'), 'utf8'), 'backup');
  assert.ok(fs.existsSync(path.join(dir, 'other.tmp')));
  assert.equal(loadState().runs.length, 2);
  assert.deepEqual(removeStateTempFiles(path.join(dir, 'missing')), []);
});

test('UT-DATA-005: the directory sync is a no-op where it cannot work and never throws', () => {
  const dir = freshDir('sync');
  assert.equal(syncDirectory(dir, 'win32'), false);
  assert.equal(typeof syncDirectory(dir), 'boolean');
  assert.equal(syncDirectory(path.join(dir, 'missing'), 'linux'), false);
});

/* ------------------------------------------------------------------ */
/* The SQLite mirror                                                  */
/* ------------------------------------------------------------------ */

test('UT-WAL-001: a missing mirror is absent, a sound mirror is ok and untouched', () => {
  const dir = useDataDir('mirror-ok');
  assert.equal(recoverMetadataMirror(metadataPath(dir)).status, 'absent');
  saveState(sampleState(2));
  const before = fs.statSync(metadataPath(dir)).size;
  assert.equal(recoverMetadataMirror(metadataPath(dir)).status, 'ok');
  assert.equal(fs.statSync(metadataPath(dir)).size, before);
});

test('UT-WAL-002: a mirror that is not a database is moved aside with its WAL and rebuilt', () => {
  const dir = useDataDir('mirror-garbage');
  saveState(sampleState(2));
  const db = metadataPath(dir);
  fs.writeFileSync(db, 'not a database '.repeat(400));
  fs.writeFileSync(`${db}-wal`, 'stale wal');
  fs.writeFileSync(`${db}-shm`, 'stale shm');
  const r = recoverMetadataMirror(db);
  assert.equal(r.status, 'quarantined');
  assert.match(r.reason, /not a database/);
  // The damaged file is kept for inspection. Its -wal/-shm are moved with it
  // when they still exist (SQLite may already have discarded them when the
  // damaged file was opened); either way none is left next to the new mirror.
  assert.ok(r.moved.length >= 1 && r.moved[0] === `${db}.corrupt-${r.moved[0].split('.corrupt-')[1]}`);
  for (const moved of r.moved) assert.ok(fs.existsSync(moved));
  for (const suffix of ['', '-wal', '-shm']) assert.equal(fs.existsSync(db + suffix), false, `no stale ${suffix || 'db'} is left behind`);
  const state = sampleState(4);
  saveState(state);
  const h = openDatabase(db);
  try { assert.equal(verifyMirror(h, loadState()).ok, true); } finally { h.close(); }
});

test('UT-WAL-003: a mirror with a damaged page fails quick_check and is quarantined', () => {
  const dir = useDataDir('mirror-page');
  const state = sampleState(1);
  state.runs = Array.from({ length: 1500 }, (_, i) => ({ id: `run_${i}`, projectId: 'prj_1', status: 'passed', createdAt: '2026-01-01T00:00:00Z', note: 'x'.repeat(60) }));
  saveState(state);
  const db = metadataPath(dir);
  const h = openDatabase(db);
  h.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  h.close();
  const buf = fs.readFileSync(db);
  assert.ok(buf.length > 4096 * 6);
  buf.fill(0x5a, 4096 * 3, 4096 * 3 + 3000);
  fs.writeFileSync(db, buf);
  const r = recoverMetadataMirror(db);
  assert.equal(r.status, 'quarantined', JSON.stringify(r));
  assert.ok(r.reason.length > 0);
});

test('UT-WAL-004: only damage leads to the move', async () => {
  const dir = useDataDir('mirror-other');
  saveState(sampleState(1));
  const db = metadataPath(dir);
  const h = openDatabase(db);
  h.prepare(`UPDATE meta SET value='99' WHERE key='schema_version'`).run();
  h.close();
  assert.equal(recoverMetadataMirror(db).status, 'ok', 'a newer schema is not damage');
  assert.ok(fs.existsSync(db));
  const notAFile = path.join(freshDir('mirror-dir'), 'metadata.db');
  fs.mkdirSync(notAFile);
  const r = recoverMetadataMirror(notAFile);
  assert.equal(r.status, 'unchecked');
  assert.ok(fs.statSync(notAFile).isDirectory(), 'left alone');
  fs.writeFileSync(db, 'garbage '.repeat(500));
  await withFs('renameSync', () => () => { const e = new Error('in use'); e.code = 'EBUSY'; throw e; }, () => {
    const failed = recoverMetadataMirror(db);
    assert.equal(failed.status, 'quarantine-failed');
    assert.match(failed.reason, /could not be moved aside/);
  });
  assert.ok(fs.existsSync(db));
});
