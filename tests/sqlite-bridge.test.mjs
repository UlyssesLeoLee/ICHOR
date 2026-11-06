/**
 * ATS-205 -- the bridge writes the metadata mirror at runtime.
 *
 * These are the IT-level cases: the bridge is started as a real process
 * against a real data directory, and the metadata database that appears
 * there has to hold what the bridge wrote.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePort } from './helpers/free-port.mjs';
import { openDatabase, closeDatabase, currentVersion } from '../server/sqlite/db.mjs';
import { counts } from '../server/sqlite/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-sqlite-bridge-'));
const project = path.join(dir, 'app');
const data = path.join(dir, 'data');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'package.json'), '{}');
fs.writeFileSync(path.join(project, 'index.js'), 'module.exports = {};\n');
// The bridge refuses a project without a Playwright configuration, so the
// fixture carries one -- exactly like the fixture of the other IT tests.
fs.writeFileSync(path.join(project, 'playwright.config.ts'), 'export default {}');
fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
fs.writeFileSync(path.join(project, 'tests', 'pass.spec.ts'), "test('simulated success', ()=>{});\n");

// A SECOND project, so the bridge can register a NEW one while the
// metadata database is locked (registering the same path twice is refused
// with PROJECT_ALREADY_REGISTERED).
const project2 = path.join(dir, 'app2');
fs.mkdirSync(project2, { recursive: true });
fs.writeFileSync(path.join(project2, 'package.json'), '{}');
fs.writeFileSync(path.join(project2, 'index.js'), 'module.exports = {};\n');
fs.writeFileSync(path.join(project2, 'playwright.config.ts'), 'export default {}');
fs.mkdirSync(path.join(project2, 'tests'), { recursive: true });
fs.writeFileSync(path.join(project2, 'tests', 'pass.spec.ts'), "test('simulated success', ()=>{});\n");

// A THIRD project, for the write that happens AFTER the lock is released.
const project3 = path.join(dir, 'app3');
fs.mkdirSync(project3, { recursive: true });
fs.writeFileSync(path.join(project3, 'package.json'), '{}');
fs.writeFileSync(path.join(project3, 'index.js'), 'module.exports = {};\n');
fs.writeFileSync(path.join(project3, 'playwright.config.ts'), 'export default {}');
fs.mkdirSync(path.join(project3, 'tests'), { recursive: true });
fs.writeFileSync(path.join(project3, 'tests', 'pass.spec.ts'), "test('simulated success', ()=>{});\n");

const port = await freePort();
let cp = null;
let token = null;
/** The child processes that hold the metadata database open. */
const holders = [];

// The ready() window below is 400 attempts: under parallel load the Bridge needs
// more than 100 attempts to come up, and a short window turns into a flaky failure.
// `npm test` runs the test files in PARALLEL, and 14 of them each boot a
// Bridge. Booting 14 servers at once is slow: measured on this machine the
// boot takes 1289 / 5637 / 8582 ms (min / median / max), while the old
// windows only allowed 4000 ms (80 x 50ms) or 2450 ms (70 x 35ms). So the
// slow ones gave up with "server did not boot" -- non-deterministically, on a
// DIFFERENT subset each run.
//
// It was never a port collision: 14 concurrent servers were measured and
// their ports were all distinct. 400 attempts x 50ms = 20s and x 35ms = 14s,
// which covers the measured worst case with room to spare, and a test that
// genuinely cannot start still fails instead of hanging forever.
async function ready() {
  // The health probe is BOUNDED. An unbounded fetch turns ONE request that
  // never comes back into a stall of the whole boot window, and the boot wait
  // then reports "the bridge did not come up" for a bridge that IS listening
  // and merely busy. Measured: a hung probe made the wait 31 s long (the 20 s
  // window plus an ~11 s request that never came back). The timeout is far
  // below the window, so a slow-but-alive bridge is still found, and a hung
  // request is retried instead of consuming the wait.
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 35));
  }
  throw new Error('bridge unreachable');
}

async function req(endpoint, method = 'GET', body) {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: token ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return [r.status, await r.json()];
}

test('IT-SQL-001: the bridge starts and creates the metadata database', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data },
    stdio: 'ignore',
  });
  await ready();
  token = (await req('/api/session'))[1].token;
  assert.ok(token, 'the bridge did not hand out a session token');
  assert.ok(fs.existsSync(path.join(data, 'metadata.db')), 'the metadata database was not created');
});

test('IT-SQL-002: the metadata database carries the schema version', () => {
  const db = openDatabase(path.join(data, 'metadata.db'), { migrate: false });
  try {
    assert.ok(currentVersion(db) > 0, 'the metadata database carries no schema version');
  } finally { closeDatabase(db); }
});

test('IT-SQL-003: a registered project appears in the metadata database', async () => {
  const [code, body] = await req('/api/projects', 'POST', { path: project });
  assert.equal(code, 201, JSON.stringify(body));
  const db = openDatabase(path.join(data, 'metadata.db'), { migrate: false });
  try {
    const rows = db.prepare('SELECT id,uid,name FROM projects').all();
    assert.equal(rows.length, 1, `expected one project row, found ${rows.length}`);
    assert.equal(rows[0].id, body.project.id);
    // The UID of the project (ATS-201) is indexed too, so the history can
    // be queried by the stable identifier.
    assert.ok(rows[0].uid, 'the project row carries no UID');
  } finally { closeDatabase(db); }
});

test('IT-SQL-004: the mirror holds exactly what the JSON state holds', async () => {
  const state = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  const db = openDatabase(path.join(data, 'metadata.db'), { migrate: false });
  try {
    const c = counts(db);
    assert.equal(c.projects, state.projects.length);
    assert.equal(c.runs, state.runs.length);
    const stateCounterKeys = Object.keys(state.runCounters ?? {}).length;
    assert.equal(c.runCounters, stateCounterKeys);
  } finally { closeDatabase(db); }
});

test('IT-SQL-005: the bridge still serves the API after the mirror is in place', async () => {
  const [code, body] = await req('/api/projects');
  assert.equal(code, 200);
  assert.ok(Array.isArray(body.projects));
  assert.equal(body.projects.length, 1);
});

test('IT-SQL-006: the mirror recovers after the database was locked for too long', async () => {
  const dbFile = path.join(data, 'metadata.db');

  // Another process holds the write lock of the metadata database for
  // LONGER than the mirror's own busy timeout (1 second), so the mirror
  // really gives up instead of waiting the obstruction out.
  const holderScript = path.join(dir, 'lock-holder.mjs');
  fs.writeFileSync(holderScript, `
import { openDatabase, closeDatabase } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'server', 'sqlite', 'db.mjs')).href)};
const [file, holdMs] = process.argv.slice(2);
const db = openDatabase(file, { migrate: false });
db.exec('BEGIN IMMEDIATE');
console.log('LOCKED');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
db.exec('COMMIT');
closeDatabase(db);
console.log('RELEASED');
`, 'utf8');
  const holder = spawn(process.execPath, [holderScript, dbFile, '4000'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  holders.push(holder);
  let out = '';
  holder.stdout.on('data', (d) => { out += d.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (out.includes('LOCKED')) { clearInterval(timer); resolve(); }
    }, 10);
    holder.on('close', () => { clearInterval(timer); reject(new Error('the lock holder exited early')); });
  });

  // While the lock is held, the bridge writes a new project. The mirror
  // cannot write it -- but the bridge keeps serving, and the JSON state
  // file (the truth) still gets the project.
  const [code, body] = await req('/api/projects', 'POST', { path: project2 });
  assert.equal(code, 201, JSON.stringify(body));
  const duringLock = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  assert.ok(
    duringLock.projects.some((p) => p.id === body.project.id),
    'the JSON state file did not get the project while the mirror was blocked'
  );

  // The bridge is still alive: it answers while the lock is held.
  const [health] = await req('/api/health');
  assert.equal(health, 200, 'the bridge stopped answering while the mirror was blocked');

  // The lock is released.
  // The holder announces that it released the lock and then exits. Waiting
  // for the announcement AND for the exit has to be race-free: the process
  // may already be gone when the listener is attached.
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (out.includes('RELEASED')) { clearInterval(timer); resolve(); }
    }, 10);
  });
  if (holder.exitCode === null && holder.signalCode === null) {
    await new Promise((r) => holder.on('close', r));
  }

  // The NEXT write of the bridge mirrors again: the mirror was not
  // disabled by the failure.
  const [code2, body2] = await req('/api/projects', 'POST', { path: project3 });
  assert.equal(code2, 201, JSON.stringify(body2));

  // And now the mirror holds everything the JSON state holds -- the
  // project that was written while the lock was held is in there too.
  const db = openDatabase(dbFile, { migrate: false });
  try {
    const c = counts(db);
    const state = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
    assert.equal(c.projects, state.projects.length, 'the recovered mirror is missing projects');
    assert.ok(
      db.prepare('SELECT count(*) AS n FROM projects WHERE id=?').get(body.project.id),
      'the project written while the lock was held never reached the mirror'
    );
  } finally { closeDatabase(db); }

  // The tool agrees: the mirror verifies against the JSON state.
  const verify = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'sqlite_meta.mjs'), 'verify',
    '--state', path.join(data, 'state.json'),
    '--db', dbFile,
  ], { encoding: 'utf8' });
  assert.equal(verify.status, 0, `the mirror did not verify: ${verify.stdout}\n${verify.stderr}`);
  assert.ok(/mirror      : OK/.test(verify.stdout), verify.stdout);
});

test('IT-SQL-CLEANUP: stop and cleanup', () => {
  if (cp) cp.kill();
  // The lock holder is killed too: it holds the metadata database open, and
  // on Windows an open file cannot be deleted.
  for (const child of holders) {
    try { child.kill(); } catch { /* already gone */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
