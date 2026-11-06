/**
 * ATS-208 -- the unified execution model: the integration tests.
 *
 * These are the IT-level cases: the bridge runs as a REAL process against a
 * REAL data directory, and the model is exercised through the HTTP API and
 * through the metadata database that appears there.
 *
 * What they assert:
 *
 *   1. a retried case is counted ONCE and keeps EVERY attempt -- the
 *      acceptance criterion 「重试不覆盖初次尝试」;
 *   2. the events of a run replay into the run's status, and the sequence is
 *      gap-free -- the acceptance criterion 「事件可按 run+sequence 复演」;
 *   3. the events are in the state file AND in the metadata database, and
 *      the two agree.
 *
 * The CLI is a TEST DOUBLE: it models the SHAPE of a Playwright report (the
 * `results[]` array of a retried case), and it never runs a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';
import { openDatabase, closeDatabase } from '../server/sqlite/db.mjs';
import { counts, eventsOfRun } from '../server/sqlite/store.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-exe-it-'));
const project = path.join(dir, 'fake-pw');
const data = path.join(dir, 'data');

fs.mkdirSync(path.join(project, 'node_modules', '@playwright', 'test'), { recursive: true });
fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
fs.writeFileSync(path.join(project, 'package.json'), '{}');
fs.writeFileSync(path.join(project, 'playwright.config.ts'), 'export default {}');
fs.writeFileSync(path.join(project, 'tests', 'flaky.spec.ts'), "test('flaky case', ()=>{});\n");

// A CLI double that models a RETRIED case: one spec whose `results[]` holds
// two results -- the first one failed, the second one passed. That is the
// exact shape of a Playwright report for a case that passed on retry.
fs.writeFileSync(
  path.join(project, 'node_modules', '@playwright', 'test', 'cli.js'),
  `
const fs=require('fs'),path=require('path');
const out=process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
const output=process.argv[process.argv.indexOf('--output')+1];
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(out, JSON.stringify({
  config:{rootDir:process.cwd().split(path.sep).join('/')},
  suites:[{file:'tests/flaky.spec.ts',specs:[{title:'flaky case',file:'tests/flaky.spec.ts',line:1,tests:[{
    status:'flaky',
    results:[
      {status:'failed',duration:11,retry:0,error:{message:'first attempt failed'}},
      {status:'passed',duration:9,retry:1}
    ]
  }]}]}]
}));
console.log('fake-cli: one flaky case with two attempts');
`
);

const port = await freePort();
let cp = null;
let token = null;
/** The identifier of the run the tests below inspect. */
let runId = null;

async function ready() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 35));
  }
  throw new Error('the bridge is unreachable');
}
async function req(endpoint, method = 'GET', body) {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: token ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return [r.status, await r.json()];
}
async function waitRun(id, statuses) {
  for (let i = 0; i < 150; i++) {
    const run = (await req(`/api/runs/${id}`))[1].run;
    if (statuses.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 35));
  }
  throw new Error('the run did not reach a terminal status in time');
}

test('IT-EXE-001: the bridge starts', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data },
    stdio: 'ignore',
  });
  await ready();
  token = (await req('/api/session'))[1].token;
  assert.ok(token, 'the bridge did not hand out a session token');
});

test('IT-EXE-002: a retried case is counted ONCE and keeps EVERY attempt', async () => {
  const [, registered] = await req('/api/projects', 'POST', { path: project });
  const projectId = registered.project.id;
  const [, started] = await req(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/flaky.spec.ts' });
  // The run is accepted as `queued`; the answer may already say `running`
  // when the engine started before the response was written, so the
  // assertion is on the STATUS VOCABULARY and not on one exact value.
  assert.ok(['queued', 'running'].includes(started.run.status), started.run.status);
  const run = await waitRun(started.run.id, ['passed', 'failed', 'error']);
  // The identifier of the run is remembered for the tests that follow.
  runId = started.run.id;

  // The case is counted ONCE.
  assert.equal(run.summary.total, 1, JSON.stringify(run.summary));
  // Its case level status is flaky: it failed once and then passed.
  assert.equal(run.summary.flaky, 1, JSON.stringify(run.summary));
  assert.equal(run.summary.passed, 0);
  assert.equal(run.summary.failed, 0);
  // Both executions are counted.
  assert.equal(run.summary.executions, 2, JSON.stringify(run.summary));

  // The FIRST attempt is not overwritten: it keeps its own status and its
  // own error.
  assert.equal(run.attempts.length, 2, JSON.stringify(run.attempts));
  const [first, second] = run.attempts;
  assert.equal(first.retry, 0);
  assert.equal(first.status, 'failed');
  assert.equal(first.error, 'first attempt failed');
  assert.equal(first.caseStatus, 'flaky');
  assert.equal(second.retry, 1);
  assert.equal(second.status, 'passed');
  assert.equal(second.caseStatus, 'flaky');
  // The two attempts are two DIFFERENT records.
  assert.notEqual(first.uid, second.uid);

  // The case carries its attempts too, so a reader of the summary sees the
  // first failure without reading the attempts.
  const c = run.summary.cases[0];
  assert.equal(c.attemptsCount, 2);
  assert.equal(c.attempts.length, 2);
  assert.equal(c.attempts[0].status, 'failed');
  assert.equal(c.attempts[0].error, 'first attempt failed');
  assert.equal(c.attempts[1].status, 'passed');
  // The error of the case is the error of its FIRST failing attempt.
  assert.equal(c.error, 'first attempt failed');
});

test('IT-EXE-003: the events of a run replay into its status, gap-free', async () => {
  assert.ok(runId, 'no run was started');
  const [, replay] = await req(`/api/runs/${runId}/replay`);
  // The replay agrees with the run record.
  assert.equal(replay.agrees, true, JSON.stringify(replay));
  assert.equal(replay.replayedStatus, replay.status);
  assert.equal(replay.terminal, true);
  // The sequence is gap-free and strictly increasing.
  assert.deepEqual(replay.gaps, [], JSON.stringify(replay));
  assert.deepEqual(replay.sequence, replay.sequence.map((_, i) => i + 1));
  // The stream ends with the event that names the terminal status.
  const last = replay.events[replay.events.length - 1];
  assert.equal(last.type, 'run.finished');
  assert.equal(last.data.status, replay.status);
});

test('IT-EXE-004: the events are in the state file AND in the metadata database', async () => {
  assert.ok(runId, 'no run was started');

  // The state file carries the events.
  const state = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  const run = state.runs.find((r) => r.id === runId);
  assert.ok(Array.isArray(run.events), 'the run record carries no events');
  assert.ok(run.events.length >= 3, `the run carries ${run.events.length} events`);

  // The metadata database carries them too.
  const db = openDatabase(path.join(data, 'metadata.db'), { migrate: false });
  try {
    assert.ok(counts(db).events > 0, 'the events table is empty');
    const rows = eventsOfRun(db, runId);
    assert.equal(rows.length, run.events.length);
    // The rows carry the same sequence as the state.
    assert.deepEqual(rows.map((r) => r.seq), run.events.map((e) => e.seq));
    // And the same payload.
    const last = rows[rows.length - 1];
    const lastState = run.events[run.events.length - 1];
    assert.equal(last.type, lastState.type);
    assert.deepEqual(last.data, lastState.data);
  } finally { closeDatabase(db); }
});

test('IT-EXE-005: the durable log and the state file carry the same events', async () => {
  assert.ok(runId, 'no run was started');
  const file = path.join(data, 'runs', runId, 'events.jsonl');
  const onDisk = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const state = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  const run = state.runs.find((r) => r.id === runId);
  // The two are written from the SAME event objects, so they cannot differ.
  assert.deepEqual(
    onDisk.map((e) => [e.seq, e.type]),
    run.events.map((e) => [e.seq, e.type])
  );
  // The counter of the run agrees with the events.
  assert.equal(run.eventSeq, run.events.length);
});

/**
 * The crash case: the bridge is KILLED while the run is in flight.
 *
 * This is the case the acceptance criterion is really about: the events of
 * the run have to describe the state the run ended in, and a run whose
 * bridge died is a state the OLD model could not express at all -- there
 * was no `run.interrupted` event, so the events determined no status and
 * could not be replayed.
 *
 * It runs in its own fixture, because it kills the bridge and starts it
 * again.
 */
test('IT-EXE-006: a run whose bridge died replays into `interrupted`', async () => {
  const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-exe-crash-'));
  const crashProject = path.join(crashDir, 'fake-pw');
  const crashData = path.join(crashDir, 'data');
  fs.mkdirSync(path.join(crashProject, 'node_modules', '@playwright', 'test'), { recursive: true });
  fs.mkdirSync(path.join(crashProject, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(crashProject, 'package.json'), '{}');
  fs.writeFileSync(path.join(crashProject, 'playwright.config.ts'), 'export default {}');
  fs.writeFileSync(path.join(crashProject, 'tests', 'slow.spec.ts'), "test('slow case', ()=>{});\n");
  // A CLI that never returns on its own: the run stays in flight until the
  // bridge is killed.
  fs.writeFileSync(
    path.join(crashProject, 'node_modules', '@playwright', 'test', 'cli.js'),
    `
const fs=require('fs'),path=require('path');
const out=process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
const output=process.argv[process.argv.indexOf('--output')+1];
fs.mkdirSync(output,{recursive:true});
setInterval(()=>{}, 1000);
`
  );

  const crashPort = await freePort();
  const env = { ...process.env, ATS_PORT: String(crashPort), ATS_DATA_DIR: crashData };
  const start = () => spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: 'ignore' });
  const up = async () => {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${crashPort}/api/health`)).ok) return true; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 35));
    }
    return false;
  };
  const call = async (endpoint, method = 'GET', body, tok) => {
    const r = await fetch(`http://127.0.0.1:${crashPort}${endpoint}`, {
      method,
      headers: tok ? { 'X-ATS-Token': tok, 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return [r.status, await r.json()];
  };

  let bridge = start();
  try {
    assert.ok(await up(), 'the bridge did not come up');
    const crashToken = (await call('/api/session'))[1].token;
    const projectId = (await call('/api/projects', 'POST', { path: crashProject }, crashToken))[1].project.id;
    const [, started] = await call(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, crashToken);
    const crashRunId = started.run.id;

    // Wait until the run is really in flight.
    for (let i = 0; i < 100; i++) {
      const r = (await call(`/api/runs/${crashRunId}`, 'GET', null, crashToken))[1].run;
      if (r.status === 'running') break;
      await new Promise((r) => setTimeout(r, 35));
    }

    // Kill the bridge WITHOUT stopping the run: the crash case.
    bridge.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));

    // Restart: the bridge recovers the state and marks the run.
    bridge = start();
    assert.ok(await up(), 'the bridge did not come back up');
    const token2 = (await call('/api/session'))[1].token;
    const recovered = (await call(`/api/runs/${crashRunId}`, 'GET', null, token2))[1].run;
    assert.equal(recovered.status, 'interrupted');

    // The events of the run now describe the state it ended in.
    const [, replay] = await call(`/api/runs/${crashRunId}/replay`, 'GET', null, token2);
    assert.equal(replay.replayedStatus, 'interrupted', JSON.stringify(replay));
    assert.equal(replay.agrees, true, JSON.stringify(replay));
    assert.equal(replay.terminal, true);
    // The sequence is gap-free: the interrupted event took the next number.
    assert.deepEqual(replay.gaps, [], JSON.stringify(replay));
    assert.deepEqual(replay.sequence, replay.sequence.map((_, i) => i + 1));
    // And the stream ends with the event that names the status.
    const last = replay.events[replay.events.length - 1];
    assert.equal(last.type, 'run.interrupted');
  } finally {
    bridge.kill();
    fs.rmSync(crashDir, { recursive: true, force: true });
  }
});

/**
 * The crash window: the bridge dies BETWEEN the event write and the state
 * write.
 *
 * The event is appended to `events.jsonl` first and the state is saved
 * afterwards, so a bridge that dies in between leaves the durable log one
 * event AHEAD of the state file. The counter of the run would then hand out
 * a sequence number the log already holds -- two events with the same
 * number, and the metadata layer's primary key (run_uid, seq) would refuse
 * the duplicate.
 *
 * The startup reconciliation reads the log back on EVERY start, so the
 * counter is corrected before any new event is written.
 */
test('IT-EXE-007: the counter is reconciled with the durable log after a crash', async () => {
  const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-exe-window-'));
  const crashProject = path.join(crashDir, 'fake-pw');
  const crashData = path.join(crashDir, 'data');
  fs.mkdirSync(path.join(crashProject, 'node_modules', '@playwright', 'test'), { recursive: true });
  fs.mkdirSync(path.join(crashProject, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(crashProject, 'package.json'), '{}');
  fs.writeFileSync(path.join(crashProject, 'playwright.config.ts'), 'export default {}');
  fs.writeFileSync(path.join(crashProject, 'tests', 'slow.spec.ts'), "test('slow case', ()=>{});\n");
  fs.writeFileSync(
    path.join(crashProject, 'node_modules', '@playwright', 'test', 'cli.js'),
    `
const fs=require('fs'),path=require('path');
const output=process.argv[process.argv.indexOf('--output')+1];
fs.mkdirSync(output,{recursive:true});
setInterval(()=>{}, 1000);
`
  );

  const crashPort = await freePort();
  const env = { ...process.env, ATS_PORT: String(crashPort), ATS_DATA_DIR: crashData };
  const start = () => spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: 'ignore' });
  const up = async () => {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${crashPort}/api/health`)).ok) return true; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 35));
    }
    return false;
  };
  const call = async (endpoint, method = 'GET', body, tok) => {
    const r = await fetch(`http://127.0.0.1:${crashPort}${endpoint}`, {
      method,
      headers: tok ? { 'X-ATS-Token': tok, 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return [r.status, await r.json()];
  };

  let bridge = start();
  try {
    assert.ok(await up(), 'the bridge did not come up');
    const crashToken = (await call('/api/session'))[1].token;
    const projectId = (await call('/api/projects', 'POST', { path: crashProject }, crashToken))[1].project.id;
    const [, started] = await call(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, crashToken);
    const crashRunId = started.run.id;
    for (let i = 0; i < 100; i++) {
      const r = (await call(`/api/runs/${crashRunId}`, 'GET', null, crashToken))[1].run;
      if (r.status === 'running') break;
      await new Promise((r) => setTimeout(r, 35));
    }
    bridge.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));

    // The crash window, simulated: the durable log holds one event MORE
    // than the state file. The bridge wrote the event and died before it
    // saved the state.
    const logFile = path.join(crashData, 'runs', crashRunId, 'events.jsonl');
    const logged = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(logged.length >= 2, `the log holds ${logged.length} events`);
    const stateFile = path.join(crashData, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const stateRun = state.runs.find((r) => r.id === crashRunId);
    // The state is rewound to one event less than the log -- exactly the
    // window between the two writes.
    const rewound = logged.slice(0, logged.length - 1);
    stateRun.events = rewound;
    stateRun.eventSeq = rewound.length ? rewound[rewound.length - 1].seq : 0;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    // Restart: the bridge reconciles the counter with the durable log.
    bridge = start();
    assert.ok(await up(), 'the bridge did not come back up');
    const token2 = (await call('/api/session'))[1].token;
    const [, replay] = await call(`/api/runs/${crashRunId}/replay`, 'GET', null, token2);

    // The sequence has no hole and no duplicate: the counter was corrected
    // to the log's highest number before the interrupted event was written.
    assert.deepEqual(replay.gaps, [], JSON.stringify(replay));
    const seqs = replay.sequence;
    assert.equal(new Set(seqs).size, seqs.length, `the sequence has a duplicate: ${JSON.stringify(seqs)}`);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
    // And the stream still replays into the status of the run.
    assert.equal(replay.replayedStatus, 'interrupted', JSON.stringify(replay));
    assert.equal(replay.agrees, true, JSON.stringify(replay));

    // The metadata layer accepts the events: the primary key (run_uid, seq)
    // would have refused a duplicate.
    const db = openDatabase(path.join(crashData, 'metadata.db'), { migrate: false });
    try {
      const rows = eventsOfRun(db, crashRunId);
      assert.equal(rows.length, seqs.length, 'the metadata layer holds a different number of events');
      assert.deepEqual(rows.map((r) => r.seq), seqs);
    } finally { closeDatabase(db); }
  } finally {
    bridge.kill();
    fs.rmSync(crashDir, { recursive: true, force: true });
  }
});

test('IT-EXE-CLEANUP: stop and cleanup', () => {
  if (cp) cp.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* The damaged log (B2, B5)                                            */
/* ------------------------------------------------------------------ */

/**
 * The helpers of the crash cases below.
 *
 * Each case runs the bridge as a REAL process against a REAL data
 * directory, kills it, damages the data and starts it again. The point is
 * that the bridge must COME BACK UP: a single damaged run used to keep the
 * whole installation from starting.
 */
async function withBridge(dataDir, body) {
  const port = await freePort();
  const env = { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: dataDir };
  const start = () => spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: 'ignore' });
  const up = async () => {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 35));
    }
    return false;
  };
  const call = async (endpoint, method = 'GET', payload, tok) => {
    // A bridge that is being killed answers with a RESET connection, not
    // with an HTTP status. The caller may be racing the crash on purpose
    // (the `cancelling` case), so a dead bridge is a normal answer here:
    // it is reported as `[0, null]` instead of throwing.
    try {
      const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        method,
        headers: tok ? { 'X-ATS-Token': tok, 'Content-Type': 'application/json' } : {},
        body: payload ? JSON.stringify(payload) : undefined,
      });
      return [r.status, await r.json()];
    } catch (e) {
      return [0, { error: String(e?.message ?? e) }];
    }
  };
  let bridge = start();
  /**
   * Kills the bridge (and, on Windows, its whole process tree).
   *
   * `taskkill /T /F` is used because a plain `kill('SIGKILL')` on Windows
   * terminates only the bridge process and leaves the orphaned engine
   * behind -- and the orphaned engine would keep the port and the run
   * folder busy.
   */
  const kill = async () => {
    if (bridge.exitCode !== null) return;
    if (process.platform === 'win32') {
      await new Promise((r) => spawn('taskkill', ['/PID', String(bridge.pid), '/T', '/F'], { windowsHide: true }).on('close', r));
    } else {
      bridge.kill('SIGKILL');
    }
    await new Promise((r) => setTimeout(r, 300));
  };
  try {
    assert.ok(await up(), 'the bridge did not come up');
    const token = (await call('/api/session'))[1].token;
    await body({ call, token, up, kill, restart: async () => {
      await kill();
      bridge = start();
      assert.ok(await up(), 'the bridge did not come back up');
      return (await call('/api/session'))[1].token;
    } });
  } finally {
    bridge.kill();
  }
}
/**
 * Removes a temporary directory, tolerating a file handle that is still
 * open.
 *
 * On Windows a directory that a process still holds open cannot be
 * removed, and the removal fails with EPERM. The bridge is killed by the
 * test, but its handle may not be released the instant the process is
 * gone. The directory is a TEMPORARY fixture: failing the test because it
 * could not be deleted would report a defect that is not one.
 */
function removeTemp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // The fixture is left behind; the OS reclaims it with the temp dir.
  }
}

/**
 * A project whose engine never returns: the run stays in flight. */
function makeHangingProject(dir) {
  const project = path.join(dir, 'proj');
  fs.mkdirSync(path.join(project, 'node_modules', '@playwright', 'test'), { recursive: true });
  fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  fs.writeFileSync(path.join(project, 'playwright.config.ts'), 'export default {}');
  fs.writeFileSync(path.join(project, 'tests', 'slow.spec.ts'), "test('slow case', ()=>{});\n");
  fs.writeFileSync(
    path.join(project, 'node_modules', '@playwright', 'test', 'cli.js'),
    `
const fs=require('fs'),path=require('path');
const output=process.argv[process.argv.indexOf('--output')+1];
fs.mkdirSync(output,{recursive:true});
setInterval(()=>{}, 1000);
`
  );
  return project;
}

/**
 * Rewinds the persisted state so that it holds EXACTLY what a crash in the
 * middle of a cancellation leaves behind.
 *
 * The `close` event of the engine completes a cancelled run as `cancelled`.
 * A crash that lands before that event is processed leaves the run in
 * `cancelling` -- with the `run.cancelling` event in its durable log and
 * without a terminal event.
 *
 * The state is rewound to that shape, so the case tests the RECOVERY of
 * that state and not a race with the operating system.
 */
function rewindToCancelling(data, runId) {
  const stateFile = path.join(data, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const run = state.runs.find((r) => r.id === runId);
  assert.ok(run, 'the run is not in the state');
  run.status = 'cancelling';
  run.finishedAt = null;
  run.exitCode = null;
  // The terminal event (if the engine's close was processed before the
  // rewind) is removed: the crash happened BEFORE it.
  run.events = (run.events ?? []).filter((e) => e.type !== 'run.finished');
  run.eventSeq = run.events.length ? run.events[run.events.length - 1].seq : 0;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  // The durable log is rewound the same way: it is the record, and the
  // recovery reads it.
  const logFile = path.join(data, 'runs', runId, 'events.jsonl');
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type !== 'run.finished');
    fs.writeFileSync(logFile, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
}

/**
 * A run whose folder is gone must not keep the Bridge from starting.
 *
 * The run folder is deleted (by the user, by a cleaner, or by a failed
 * migration), so the durable log of that run is unreachable. The recovery
 * path treats that as DAMAGE, not as a fatal error: the problem is
 * recorded, the run still recovers into a terminal status, and the Bridge
 * starts.
 *
 * THE ORDER OF THE TWO STEPS MATTERS.
 *
 * The folder is deleted AFTER the bridge has stopped. If the folder were
 * deleted while the bridge were still alive, the bridge would write the
 * next event into the missing folder, RECREATE it (the writer creates the
 * parent directory), and the recovery would find a healthy log -- the
 * defect would never be exercised. That is why this case stops the
 * bridge first: it has to reproduce the state a crash leaves behind, and
 * the crash means nobody is left to recreate the folder.
 */
test('IT-EXE-008: the bridge starts even when the run folder is gone', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-exe-missing-'));
  const data = path.join(work, 'data');
  try {
    const project = makeHangingProject(work);
    await withBridge(data, async ({ call, token, kill, restart }) => {
      const projectId = (await call('/api/projects', 'POST', { path: project }, token))[1].project.id;
      const [, started] = await call(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, token);
      const runId = started.run.id;
      for (let i = 0; i < 100; i++) {
        if ((await call(`/api/runs/${runId}`, 'GET', null, token))[1].run.status === 'running') break;
        await new Promise((r) => setTimeout(r, 35));
      }
      // The bridge stops FIRST: the folder is gone and nobody is left to
      // recreate it.
      await kill();
      fs.rmSync(path.join(data, 'runs', runId), { recursive: true, force: true });

      const token2 = await restart();
      // The bridge came back up (the restart asserts it) and the run is
      // recovered into a terminal state -- it does not hold the project
      // lock for ever.
      const run = (await call(`/api/runs/${runId}`, 'GET', null, token2))[1].run;
      assert.equal(run.status, 'interrupted', JSON.stringify(run.status));
      // And the API answers: the run is readable even without its log.
      const [status] = await call(`/api/runs/${runId}/replay`, 'GET', null, token2);
      assert.equal(status, 200);
    });
  } finally {
    removeTemp(work);
  }
});

/**
 * A log whose tail line is torn.
 *
 * A crash in the middle of an append leaves the last line of
 * `events.jsonl` torn. The old reader let the JSON error escape, so
 * `/events` and `/replay` answered 500 for the rest of the run's life.
 */
test('IT-EXE-009: a torn event log stays readable', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-exe-torn-'));
  const data = path.join(work, 'data');
  try {
    const project = makeHangingProject(work);
    await withBridge(data, async ({ call, token, restart }) => {
      const projectId = (await call('/api/projects', 'POST', { path: project }, token))[1].project.id;
      const [, started] = await call(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, token);
      const runId = started.run.id;
      for (let i = 0; i < 100; i++) {
        if ((await call(`/api/runs/${runId}`, 'GET', null, token))[1].run.status === 'running') break;
        await new Promise((r) => setTimeout(r, 35));
      }
      // The log is torn: a fragment of JSON without a newline.
      const log = path.join(data, 'runs', runId, 'events.jsonl');
      fs.appendFileSync(log, '{"seq":3,"at":"2026-11-06T00:00:00.000Z","ty');

      const token2 = await restart();
      // Both endpoints answer 200 -- a torn byte must not make the run
      // unreadable.
      const [eventsStatus, events] = await call(`/api/runs/${runId}/events`, 'GET', null, token2);
      assert.equal(eventsStatus, 200, JSON.stringify(events));
      // The readable events are still there.
      assert.ok(events.events.length >= 2, JSON.stringify(events.events));
      // And the damage is REPORTED.
      assert.ok(events.unreadable.length >= 1, JSON.stringify(events));
      const [replayStatus, replay] = await call(`/api/runs/${runId}/replay`, 'GET', null, token2);
      assert.equal(replayStatus, 200, JSON.stringify(replay));
      assert.ok(replay.unreadable.length >= 1, JSON.stringify(replay));
      // The run is still recovered into a terminal state.
      assert.equal((await call(`/api/runs/${runId}`, 'GET', null, token2))[1].run.status, 'interrupted');
    });
  } finally {
    removeTemp(work);
  }
});

/**
 * A stream that violates the state machine.
 *
 * The bridge died between the `run.finished` event and the state write --
 * the `finishRun` collect window. The log already said the run FINISHED;
 * the state file still said `running`. The old recovery appended
 * `run.interrupted` anyway, so the stream became
 * `[queued, started, finished(passed), interrupted]` -- a run that never
 * existed -- and `/replay` reported it as `agrees: true`.
 */
test('IT-EXE-010: no event is appended after a terminal event', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-exe-window2-'));
  const data = path.join(work, 'data');
  try {
    const project = makeHangingProject(work);
    await withBridge(data, async ({ call, token, restart }) => {
      const projectId = (await call('/api/projects', 'POST', { path: project }, token))[1].project.id;
      const [, started] = await call(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, token);
      const runId = started.run.id;
      for (let i = 0; i < 100; i++) {
        if ((await call(`/api/runs/${runId}`, 'GET', null, token))[1].run.status === 'running') break;
        await new Promise((r) => setTimeout(r, 35));
      }
      // The crash window: the log holds a terminal event, the state does
      // not know about it yet.
      const log = path.join(data, 'runs', runId, 'events.jsonl');
      fs.appendFileSync(log, JSON.stringify({
        seq: 3, at: new Date().toISOString(), type: 'run.finished', data: { status: 'passed', code: 0 },
      }) + '\n');
      const stateFile = path.join(data, 'state.json');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const run = state.runs.find((r) => r.id === runId);
      run.status = 'running';
      run.finishedAt = null;
      run.events = run.events.filter((e) => e.type !== 'run.finished');
      run.eventSeq = run.events.length;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

      const token2 = await restart();
      const recovered = (await call(`/api/runs/${runId}`, 'GET', null, token2))[1].run;
      // The log wins: the run is `passed`, not `interrupted`.
      assert.equal(recovered.status, 'passed', JSON.stringify(recovered.status));
      const [, replay] = await call(`/api/runs/${runId}/replay`, 'GET', null, token2);
      // The stream is VALID: no event was appended after the terminal one.
      assert.equal(replay.valid, true, JSON.stringify(replay.violations));
      assert.deepEqual(replay.violations, []);
      assert.equal(replay.agrees, true, JSON.stringify(replay));
      // And the terminal event is still the LAST one.
      const types = replay.events.map((e) => e.type);
      assert.deepEqual(types, ['run.queued', 'run.started', 'run.finished'], JSON.stringify(types));
    });
  } finally {
    removeTemp(work);
  }
});

/**
 * A run that was `cancelling` when the Bridge died.
 *
 * The bridge died while the run was `cancelling` -- after `POST /stop` and
 * before the engine's exit was processed. The old recovery only handled
 * `queued` and `running`, so the run stayed in `cancelling` for ever: it
 * never reached a terminal state, it held the project's run lock, and
 * `POST /stop` could not release it (there was no job any more, so the
 * answer was `RUN_NOT_ACTIVE`).
 *
 * THE STATE IS CRAFTED, NOT RACED FOR.
 *
 * Doing this "for real" -- POST /stop and then kill the bridge -- is a RACE:
 * `cancelRun()` kills the engine, and the engine's `close` event completes
 * the run as `cancelled` before the crash lands. The window between the
 * stop's answer and the kill is milliseconds wide, and the test would fail
 * or pass by luck (measured: it passed on 3 of 8 runs).
 *
 * The state is therefore written directly: a run in `cancelling`, with the
 * `run.cancelling` event in its log, and no live engine. That is EXACTLY
 * the state the crash leaves behind, and it is the state the recovery has
 * to handle. The same approach is used by the review's own probe C3.
 */
test('IT-EXE-011: a run that was cancelling when the bridge died is recovered', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-exe-cancel-'));
  const data = path.join(work, 'data');
  try {
    const project = makeHangingProject(work);
    await withBridge(data, async ({ call, token, kill, restart }) => {
      const projectId = (await call('/api/projects', 'POST', { path: project }, token))[1].project.id;
      const [, started] = await call(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, token);
      const runId = started.run.id;
      for (let i = 0; i < 100; i++) {
        if ((await call(`/api/runs/${runId}`, 'GET', null, token))[1].run.status === 'running') break;
        await new Promise((r) => setTimeout(r, 35));
      }
      // The run is stopped: the state says `cancelling`.
      const [stopStatus, stopAnswer] = await call(`/api/runs/${runId}/stop`, 'POST', {}, token);
      assert.equal(stopStatus, 200, JSON.stringify(stopAnswer));
      assert.equal(stopAnswer.status, 'cancelling', JSON.stringify(stopAnswer));

      // The crash: the engine's `close` event is never processed, so the
      // state keeps the `cancelling` status and the log keeps the
      // `run.cancelling` event.
      await kill();
      rewindToCancelling(data, runId);

      // The recovery: the bridge comes back up and the run must reach a
      // TERMINAL state.
      const token2 = await restart();
      const recovered = (await call(`/api/runs/${runId}`, 'GET', null, token2))[1].run;
      assert.equal(recovered.status, 'interrupted', JSON.stringify(recovered.status));
      const [, replay] = await call(`/api/runs/${runId}/replay`, 'GET', null, token2);
      assert.equal(replay.replayedStatus, 'interrupted', JSON.stringify(replay));
      assert.equal(replay.terminal, true, JSON.stringify(replay));
      assert.equal(replay.valid, true, JSON.stringify(replay.violations));
      // And the project is free again: a new run can be started. Before
      // the fix the run stayed in `cancelling`, held the lock for ever and
      // the answer was 409 PROJECT_ALREADY_RUNNING.
      const [runStatus, runAnswer] = await call(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, token2);
      assert.ok(runStatus < 300, JSON.stringify(runAnswer));
    });
  } finally {
    removeTemp(work);
  }
});

/**
 * The expected failure of a `test.fail()` case, at the bridge level.
 *
 * A case that declares `test.fail()` and fails is what Playwright calls an
 * `expected` outcome: the engine exits 0 and its `stats` count the case as
 * expected. The old summary called it a `failed` case, so the summary
 * contradicted the exit code of the very same run.
 */
test('IT-EXE-012: the summary of a run agrees with the exit code of the engine', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-exe-xfail-'));
  const data = path.join(work, 'data');
  const project = path.join(work, 'proj');
  try {
    fs.mkdirSync(path.join(project, 'node_modules', '@playwright', 'test'), { recursive: true });
    fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), '{}');
    fs.writeFileSync(path.join(project, 'playwright.config.ts'), 'export default {}');
    fs.writeFileSync(path.join(project, 'tests', 'xfail.spec.ts'), "test('expected failure', ()=>{});\n");
    // The CLI double models the report of a case that declares
    // `test.fail()`: the engine says `expected`, the expected status is
    // `failed`, and the result failed.
    fs.writeFileSync(
      path.join(project, 'node_modules', '@playwright', 'test', 'cli.js'),
      `
const fs=require('fs'),path=require('path');
const out=process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
const output=process.argv[process.argv.indexOf('--output')+1];
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(out, JSON.stringify({
  config:{rootDir:process.cwd().split(path.sep).join('/')},
  suites:[{file:'tests/xfail.spec.ts',specs:[{title:'expected failure',file:'tests/xfail.spec.ts',line:1,tests:[{
    status:'expected',
    expectedStatus:'failed',
    results:[{status:'failed',duration:5,retry:0,error:{message:'the expected failure'}}]
  }]}]}]
}));
`
    );
    await withBridge(data, async ({ call, token }) => {
      const projectId = (await call('/api/projects', 'POST', { path: project }, token))[1].project.id;
      const [, started] = await call(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/xfail.spec.ts' }, token);
      let run = null;
      for (let i = 0; i < 150; i++) {
        run = (await call(`/api/runs/${started.run.id}`, 'GET', null, token))[1].run;
        if (['passed', 'failed', 'error'].includes(run.status)) break;
        await new Promise((r) => setTimeout(r, 35));
      }
      // The case is PASSED: the failure was the declared outcome.
      assert.equal(run.summary.total, 1, JSON.stringify(run.summary));
      assert.equal(run.summary.passed, 1, JSON.stringify(run.summary));
      assert.equal(run.summary.failed, 0, JSON.stringify(run.summary));
      assert.equal(run.summary.cases[0].status, 'passed', JSON.stringify(run.summary.cases[0]));
      assert.equal(run.summary.cases[0].outcome, 'expected');
      // The attempt itself still records that it failed: the fact is not
      // lost, it is only not counted as a failure of the run.
      assert.equal(run.attempts[0].status, 'failed');
      assert.equal(run.attempts[0].expectedStatus, 'failed');
      assert.equal(run.attempts[0].outcome, 'expected');
    });
  } finally {
    removeTemp(work);
  }
});

/**
 * The lost and the reused sequence numbers, at the API level.
 *
 * The replay endpoint reports the holes of the sequence and the numbers
 * that are used more than once. A log whose FIRST events were lost is not
 * an intact log, and a stream that holds two events with the same number
 * does not describe a run -- the metadata layer's primary key
 * `(run_uid, seq)` refuses such a pair.
 */
test('IT-EXE-013: the replay reports the lost and the reused sequence numbers', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-exe-seq-'));
  const data = path.join(work, 'data');
  try {
    const project = makeHangingProject(work);
    await withBridge(data, async ({ call, token, kill, restart }) => {
      const projectId = (await call('/api/projects', 'POST', { path: project }, token))[1].project.id;
      const [, started] = await call(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, token);
      const runId = started.run.id;
      for (let i = 0; i < 100; i++) {
        if ((await call(`/api/runs/${runId}`, 'GET', null, token))[1].run.status === 'running') break;
        await new Promise((r) => setTimeout(r, 35));
      }
      await kill();

      // The durable log is damaged in two ways at once: the first event is
      // LOST, and one number is used TWICE.
      const log = path.join(data, 'runs', runId, 'events.jsonl');
      const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(lines.length >= 2, `the log holds ${lines.length} events`);
      // Drop the first event: the hole is at the BEGINNING of the stream.
      const kept = lines.slice(1);
      // Reuse the number of the first kept event for a second one.
      const duplicated = { ...kept[0], type: 'run.cancelling', data: {} };
      fs.writeFileSync(log, [...kept, duplicated].map((e) => JSON.stringify(e)).join('\n') + '\n');

      const token2 = await restart();
      const [status, replay] = await call(`/api/runs/${runId}/replay`, 'GET', null, token2);
      assert.equal(status, 200, JSON.stringify(replay));
      // The hole at the beginning is reported: the sequence starts at 1.
      assert.ok(replay.gaps.includes(1), JSON.stringify(replay.gaps));
      // The reused number is reported.
      assert.ok(replay.duplicates.length >= 1, JSON.stringify(replay.duplicates));
      // A stream that reuses a number does not describe a run.
      assert.equal(replay.valid, false, JSON.stringify(replay.violations));
      assert.equal(replay.agrees, false, JSON.stringify(replay));
    });
  } finally {
    removeTemp(work);
  }
});
