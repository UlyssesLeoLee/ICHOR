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
