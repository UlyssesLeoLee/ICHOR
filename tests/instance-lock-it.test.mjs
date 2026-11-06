/**
 * ATS-207 -- single instance, lock contention and crash recovery, with REAL
 * Bridge processes.
 *
 * Every Bridge gets its own port (freePort), so a busy port can never be the
 * reason a Bridge is refused: a refusal is the process exiting by itself with
 * code 1 AND the lock message on stderr. A hard kill (`taskkill /T /F` on
 * Windows, SIGKILL elsewhere) leaves the lock file behind exactly as a crash
 * or a power cut does.
 *
 * IT-LOCK-*  single instance, simultaneous start, takeover after a crash,
 *            waiting for the lock, the holder check.
 * IT-DATA-*  a damaged state file is refused; kills during saves never leave
 *            a torn state file.
 * IT-WAL-*   SQLite replays committed WAL frames after a kill in the middle of
 *            a transaction; a damaged mirror is rebuilt by the Bridge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { freePort } from './helpers/free-port.mjs';
import { processStartTime, saveState, lockPath, metadataPath } from '../server/core.mjs';
import { openDatabase } from '../server/sqlite/db.mjs';
import { verifyMirror } from '../server/sqlite/import.mjs';

const repo = path.resolve('.');
const CORE_URL = pathToFileURL(path.join(repo, 'server', 'core.mjs')).href;
const DB_URL = pathToFileURL(path.join(repo, 'server', 'sqlite', 'db.mjs')).href;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats207-it-'));
const live = new Set();
test.after(async () => {
  for (const cp of live) await hardKill(cp);
  fs.rmSync(root, { recursive: true, force: true });
});

let seq = 0;
const freshDir = (name) => {
  const d = path.join(root, `${name}-${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kills a process (and its children) without giving it a chance to clean up. */
async function hardKill(cp) {
  if (cp.exitCode !== null || cp.signalCode !== null) return;
  const closed = new Promise((r) => cp.once('close', r));
  if (process.platform === 'win32') {
    await new Promise((r) => spawn('taskkill', ['/PID', String(cp.pid), '/T', '/F'], { windowsHide: true }).on('close', r));
  } else {
    cp.kill('SIGKILL');
  }
  await Promise.race([closed, sleep(10000)]);
  live.delete(cp);
}

/** Starts a Bridge on its own port; collects stderr; `exited` resolves with the exit code. */
async function startBridge(dataDir, env = {}) {
  const port = await freePort();
  const cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: repo,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  live.add(cp);
  let stderr = '';
  cp.stderr.on('data', (b) => { stderr += b; });
  const exited = new Promise((resolve) => cp.on('close', (code) => { live.delete(cp); resolve(code); }));
  return { cp, port, exited, stderr: () => stderr };
}

async function healthy(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; }
}

/** Waits until the Bridge answers; false when it exits or the time is up. */
async function up(b, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (b.cp.exitCode !== null) return false;
    if (await healthy(b.port)) return true;
    await sleep(50);
  }
  return false;
}

/** The exit code, or 'running' when the process is still alive after `ms`. */
const exitWithin = (b, ms) => Promise.race([b.exited, sleep(ms).then(() => 'running')]);
const lockOf = (dataDir) => JSON.parse(fs.readFileSync(lockPath(dataDir), 'utf8'));

/* ------------------------------------------------------------------ */
/* Single instance                                                    */
/* ------------------------------------------------------------------ */

test('IT-LOCK-001: a second Bridge on the same data directory is refused while the first serves', async () => {
  const data = freshDir('single');
  const a = await startBridge(data);
  try {
    assert.ok(await up(a), `A did not come up: ${a.stderr()}`);
    const lockBefore = fs.readFileSync(lockPath(data));
    const b = await startBridge(data);
    assert.equal(await exitWithin(b, 30000), 1, 'B exits by itself with code 1');
    const err = b.stderr();
    assert.match(err, /holds the data directory lock/);
    assert.ok(err.includes(lockPath(data)), 'the refusal names the lock file');
    assert.match(err, new RegExp(`pid ${a.cp.pid}\\b`), 'the refusal names the holder');
    assert.ok(err.indexOf('no Bridge is running') < err.indexOf('delete the lock file'), 'the check comes before the step');
    assert.equal(await healthy(a.port), true, 'A still serves');
    assert.deepEqual(fs.readFileSync(lockPath(data)), lockBefore, 'the refused Bridge did not touch the lock');
  } finally { await hardKill(a.cp); }
});

test('IT-LOCK-002: of two Bridges started at the same instant exactly one serves', async () => {
  for (let round = 1; round <= 3; round++) {
    const data = freshDir(`simul-${round}`);
    const [a, b] = await Promise.all([startBridge(data), startBridge(data)]);
    try {
      const first = await Promise.race([a.exited.then(() => a), b.exited.then(() => b), sleep(40000).then(() => null)]);
      assert.ok(first, `round ${round}: neither Bridge was refused -- both run on one data directory`);
      const winner = first === a ? b : a;
      assert.equal(first.cp.exitCode, 1, `round ${round}: the loser exits 1: ${first.stderr()}`);
      assert.match(first.stderr(), /holds the data directory lock/);
      assert.ok(await up(winner), `round ${round}: the winner serves: ${winner.stderr()}`);
      assert.equal(lockOf(data).pid, winner.cp.pid, `round ${round}: the lock names the serving Bridge`);
    } finally { await hardKill(a.cp); await hardKill(b.cp); }
  }
});

/** A project whose Playwright CLI never returns: its run stays in flight. */
function slowProject(dir) {
  const p = path.join(dir, 'fake-pw');
  fs.mkdirSync(path.join(p, 'node_modules', '@playwright', 'test'), { recursive: true });
  fs.mkdirSync(path.join(p, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(p, 'package.json'), '{}');
  fs.writeFileSync(path.join(p, 'playwright.config.ts'), 'export default {}');
  fs.writeFileSync(path.join(p, 'tests', 'slow.spec.ts'), "test('slow case', ()=>{});\n");
  fs.writeFileSync(path.join(p, 'node_modules', '@playwright', 'test', 'cli.js'),
    "const fs=require('fs');const o=process.argv[process.argv.indexOf('--output')+1];fs.mkdirSync(o,{recursive:true});setInterval(()=>{},1000);\n");
  return p;
}

async function api(port, endpoint, method = 'GET', body, token) {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: token ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return [r.status, await r.json()];
}

test('IT-LOCK-003: after a hard kill the next Bridge takes over the lock and the run is interrupted', async () => {
  const dir = freshDir('takeover');
  const data = path.join(dir, 'data');
  const project = slowProject(dir);
  const a = await startBridge(data);
  let c = null;
  try {
    assert.ok(await up(a), a.stderr());
    const token = (await api(a.port, '/api/session'))[1].token;
    const projectId = (await api(a.port, '/api/projects', 'POST', { path: project }, token))[1].project.id;
    const runId = (await api(a.port, `/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, token))[1].run.id;
    let status = '';
    for (let i = 0; i < 200 && status !== 'running'; i++) {
      status = (await api(a.port, `/api/runs/${runId}`, 'GET', null, token))[1].run.status;
      if (status !== 'running') await sleep(50);
    }
    assert.equal(status, 'running');
    await hardKill(a.cp);
    assert.equal(lockOf(data).pid, a.cp.pid, 'the crash left the lock file behind');

    c = await startBridge(data);
    assert.ok(await up(c), `the next Bridge did not take over: ${c.stderr()}`);
    assert.equal(lockOf(data).pid, c.cp.pid, 'the stale lock was taken over');
    const token2 = (await api(c.port, '/api/session'))[1].token;
    const run = (await api(c.port, `/api/runs/${runId}`, 'GET', null, token2))[1].run;
    assert.equal(run.status, 'interrupted', 'a run in flight is never reported as finished');
    const replay = (await api(c.port, `/api/runs/${runId}/replay`, 'GET', null, token2))[1];
    assert.equal(replay.replayedStatus, 'interrupted');
    assert.equal(replay.agrees, true);
  } finally {
    await hardKill(a.cp);
    if (c) await hardKill(c.cp);
  }
});

test('IT-LOCK-004: with ATS_LOCK_WAIT_MS a starting Bridge waits for the lock instead of failing', async () => {
  const data = freshDir('wait');
  const a = await startBridge(data);
  let b = null;
  try {
    assert.ok(await up(a), a.stderr());
    b = await startBridge(data, { ATS_LOCK_WAIT_MS: '20000' });
    assert.equal(await exitWithin(b, 1500), 'running', `B gave up instead of waiting: ${b.stderr()}`);
    assert.equal(await healthy(b.port), false, 'B does not serve while A holds the lock');
    await hardKill(a.cp);
    assert.ok(await up(b, 25000), `B did not start once the lock was free: ${b.stderr()}`);
    assert.equal(lockOf(data).pid, b.cp.pid);
  } finally {
    await hardKill(a.cp);
    if (b) await hardKill(b.cp);
  }
});

test('IT-LOCK-005: a Bridge whose lock was taken over stops and leaves the new lock alone', async () => {
  const data = freshDir('lost');
  const a = await startBridge(data, { ATS_LOCK_VERIFY_MS: '100' });
  try {
    assert.ok(await up(a), a.stderr());
    const foreign = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), processStartedAt: processStartTime(process.pid), token: 'foreign-holder' });
    fs.writeFileSync(lockPath(data), foreign);
    assert.equal(await exitWithin(a, 15000), 1, 'A stops by itself');
    assert.match(a.stderr(), /lost the data directory lock/);
    assert.match(a.stderr(), new RegExp(`belongs to pid ${process.pid}\\b`));
    assert.equal(fs.readFileSync(lockPath(data), 'utf8'), foreign, "A's exit did not remove the new holder's lock");
  } finally { await hardKill(a.cp); }
});

test('IT-LOCK-006: a lock file deleted under a running Bridge is taken again', async () => {
  const data = freshDir('deleted');
  const a = await startBridge(data, { ATS_LOCK_VERIFY_MS: '100' });
  try {
    assert.ok(await up(a), a.stderr());
    fs.rmSync(lockPath(data));
    let back = false;
    for (let i = 0; i < 150 && !back; i++) {
      back = fs.existsSync(lockPath(data));
      if (!back) await sleep(50);
    }
    assert.ok(back, `the lock was not taken again: ${a.stderr()}`);
    assert.equal(lockOf(data).pid, a.cp.pid);
    assert.match(a.stderr(), /re-acquired/);
    assert.equal(await healthy(a.port), true);
  } finally { await hardKill(a.cp); }
});

/* ------------------------------------------------------------------ */
/* The state file                                                     */
/* ------------------------------------------------------------------ */

test('IT-DATA-001: a Bridge refuses a damaged state file and leaves it untouched', async () => {
  for (const content of ['{"schema":1,"projects":[{"id":"p', '']) {
    const data = freshDir('damaged');
    const file = path.join(data, 'state.json');
    fs.writeFileSync(file, content);
    const b = await startBridge(data);
    assert.equal(await exitWithin(b, 30000), 1, 'the Bridge refuses to start');
    const err = b.stderr();
    assert.match(err, /STATE_CORRUPT/);
    assert.ok(err.includes(file), 'the message names the file');
    assert.match(err, /restore the last good copy/);
    assert.equal(fs.readFileSync(file, 'utf8'), content, 'the history was not replaced by an empty state');
    assert.equal(fs.existsSync(lockPath(data)), false, 'the refused Bridge released the lock');
  }
});

test('IT-DATA-002: kills during saves never leave a torn state file', async () => {
  const data = freshDir('kills');
  const writer = `import {saveState} from ${JSON.stringify(CORE_URL)};` +
    `let g=Number(process.argv[1]);let first=true;` +
    `for(;;){const runs=Array.from({length:g*10},(_,i)=>({id:'run_1_'+i.toString(16).padStart(24,'0'),projectId:'prj_1',status:'passed',createdAt:'2026-01-01T00:00:00Z',note:'x'.repeat(40)}));` +
    `saveState({schema:1,projects:[{id:'prj_1',root:'C:/nowhere',name:'p'}],runs,uidRegistry:{version:1,projects:{}},gen:g});` +
    `if(first){console.log('SAVING');first=false;}g++;if(g>300)g=1;}`;
  let generation = 1;
  let leftTemp = false;
  for (let i = 0; i < 12; i++) {
    const cp = spawn(process.execPath, ['--input-type=module', '-e', writer, String(generation)], {
      env: { ...process.env, ATS_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    live.add(cp);
    await new Promise((resolve, reject) => {
      let out = '';
      cp.stdout.on('data', (b) => { out += b; if (out.includes('SAVING')) resolve(); });
      cp.on('close', () => reject(new Error('the writer exited before saving')));
    });
    await sleep(60 + i * 37);
    await hardKill(cp);
    const state = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
    assert.equal(state.runs.length, state.gen * 10, `kill ${i + 1}: the file holds one complete generation`);
    leftTemp = leftTemp || fs.readdirSync(data).some((n) => /^state\.json\.\d+\.tmp$/.test(n));
    generation = state.gen + 1;
  }
  const b = await startBridge(data);
  try {
    assert.ok(await up(b), b.stderr());
    assert.deepEqual(fs.readdirSync(data).filter((n) => /^state\.json(\.\d+)?\.tmp$/.test(n)), [], 'leftover temp files were removed');
    if (leftTemp) assert.match(b.stderr(), /removed the temp files of an interrupted save/);
    const state = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
    assert.equal(state.projects.length, 1, 'the projects survived');
    assert.doesNotMatch(b.stderr(), /quarantined/, 'the mirror survived the kills');
    const h = openDatabase(metadataPath(data));
    try { assert.equal(verifyMirror(h, state).ok, true); } finally { h.close(); }
  } finally { await hardKill(b.cp); }
});

/* ------------------------------------------------------------------ */
/* WAL recovery                                                       */
/* ------------------------------------------------------------------ */

test('IT-WAL-001: after a kill inside a transaction the WAL yields exactly the committed rows', async () => {
  const dir = freshDir('wal');
  const file = path.join(dir, 'metadata.db');
  const writer = `import {openDatabase} from ${JSON.stringify(DB_URL)};` +
    `const db=openDatabase(${JSON.stringify(file)});db.exec('PRAGMA wal_autocheckpoint=0');` +
    `db.exec('CREATE TABLE wal_probe(n INTEGER)');const ins=db.prepare('INSERT INTO wal_probe VALUES (?)');` +
    `db.exec('BEGIN IMMEDIATE');for(let i=0;i<50;i++)ins.run(i);db.exec('COMMIT');` +
    `db.exec('BEGIN IMMEDIATE');for(let i=50;i<100;i++)ins.run(i);console.log('IN-TX');setInterval(()=>{},1000);`;
  const cp = spawn(process.execPath, ['--input-type=module', '-e', writer], { stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(cp);
  await new Promise((resolve, reject) => {
    let out = '';
    cp.stdout.on('data', (b) => { out += b; if (out.includes('IN-TX')) resolve(); });
    cp.on('close', () => reject(new Error('the writer exited early')));
  });
  await hardKill(cp);
  assert.ok(fs.statSync(`${file}-wal`).size > 0, 'the committed rows live only in the WAL');
  const db = openDatabase(file);
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM wal_probe').get().n), 50, 'committed rows recovered');
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM wal_probe WHERE n >= 50').get().n), 0, 'the open transaction is discarded');
  } finally { db.close(); }
});

test('IT-WAL-002: a Bridge moves a damaged mirror aside and rebuilds it from the state file', async () => {
  const data = freshDir('mirror');
  const previous = process.env.ATS_DATA_DIR;
  process.env.ATS_DATA_DIR = data;
  try {
    saveState({ schema: 1, projects: [{ id: 'prj_1', root: 'C:/nowhere', name: 'p' }], runs: [], uidRegistry: { version: 1, projects: {} } });
  } finally {
    if (previous === undefined) delete process.env.ATS_DATA_DIR; else process.env.ATS_DATA_DIR = previous;
  }
  fs.writeFileSync(metadataPath(data), 'this is not a database '.repeat(300));
  const b = await startBridge(data);
  try {
    assert.ok(await up(b), b.stderr());
    assert.match(b.stderr(), /quarantined/);
    assert.ok(fs.readdirSync(data).some((n) => n.startsWith('metadata.db.corrupt-')), 'the damaged copy is kept');
    const state = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
    const h = openDatabase(metadataPath(data));
    try { assert.equal(verifyMirror(h, state).ok, true, 'the mirror was rebuilt from state.json'); } finally { h.close(); }
  } finally { await hardKill(b.cp); }
});
