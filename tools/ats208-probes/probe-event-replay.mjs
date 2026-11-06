/**
 * ATS-208 probe: does the event stream of a run describe its terminal state?
 *
 * The acceptance criterion is 「事件可按 run+sequence 复演」 -- the events of
 * a run must be replayable into the run's state. This probe measures the
 * cases where the event stream and the run record DISAGREE, so the report
 * says what is broken rather than what should be.
 *
 * Case A: a run that is killed together with the Bridge (a crash / a
 *         restart). The Bridge marks the run `interrupted` on the next start.
 * Case B: a run that finishes normally.
 *
 * For each case the probe prints:
 *   - the run's recorded status;
 *   - the event types and their sequence numbers;
 *   - whether the events alone determine the terminal status;
 *   - whether the sequence numbers are gap-free and strictly increasing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats208-replay-'));
const project = path.join(dir, 'fake-pw');
const data = path.join(dir, 'data');
fs.mkdirSync(path.join(project, 'node_modules', '@playwright', 'test'), { recursive: true });
fs.mkdirSync(path.join(project, 'tests'));
fs.writeFileSync(path.join(project, 'package.json'), '{}');
fs.writeFileSync(path.join(project, 'playwright.config.ts'), 'export default {}');
fs.writeFileSync(path.join(project, 'tests', 'slow.spec.ts'), "test('slow case', ()=>{});\n");

// A CLI double that never returns on its own: the run stays in flight until
// the process is killed.
fs.writeFileSync(
  path.join(project, 'node_modules', '@playwright', 'test', 'cli.js'),
  `
const fs=require('fs'),path=require('path');
const out=process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
const output=process.argv[process.argv.indexOf('--output')+1];
fs.mkdirSync(output,{recursive:true});
if (process.env.ATS208_HANG) { setInterval(()=>{}, 1000); }
else {
  fs.writeFileSync(out, JSON.stringify({suites:[{file:'tests/slow.spec.ts',specs:[{title:'slow case',line:1,tests:[{status:'expected',results:[{duration:5}]}]}]}]}));
}
`
);

const PORT = 4601;
const root = path.resolve(import.meta.dirname, '..', '..');

function startBridge() {
  return spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(PORT), ATS_DATA_DIR: data },
    stdio: 'ignore',
  });
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}
async function req(endpoint, method = 'GET', body, tok) {
  const r = await fetch(`http://127.0.0.1:${PORT}${endpoint}`, {
    method,
    headers: tok ? { 'X-ATS-Token': tok, 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return [r.status, await r.json()];
}

/**
 * The replay: fold the events of a run into the status the events imply.
 *
 * This is the smallest honest definition of 「事件可按 run+sequence 复演」:
 * the events, taken in their sequence order, must determine the terminal
 * status of the run. An event that names a status decides it; a stream
 * that ends without a status decides nothing.
 */
function replayStatus(events) {
  let status = null;
  for (const e of events) {
    if (e.type === 'run.finished' || e.type === 'run.error') status = e.data?.status ?? status ?? 'error';
    else if (e.type === 'run.interrupted') status = 'interrupted';
  }
  return status;
}

function report(label, run, events) {
  console.log(`--- ${label} ---`);
  console.log('  run.status       :', run.status);
  console.log('  event types      :', JSON.stringify(events.map((e) => e.type)));
  console.log('  event seqs       :', JSON.stringify(events.map((e) => e.seq)));
  const seqs = events.map((e) => e.seq);
  const increasing = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  const gapFree = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
  console.log('  strictly incr.   :', increasing);
  console.log('  gap-free         :', gapFree);
  const replayed = replayStatus(events);
  console.log('  replayed status  :', replayed ?? '(the events determine no status)');
  console.log('  replay agrees    :', replayed === run.status,
    replayed === run.status ? '' : `  <-- MISMATCH (run says ${run.status})`);
  console.log('');
  return { agrees: replayed === run.status };
}

let bridge = startBridge();
try {
  if (!await ready()) throw new Error('the bridge did not come up');

  // --- Case A: a run that is killed together with the Bridge --------------
  const token = (await req('/api/session'))[1].token;
  const projectId = (await req('/api/projects', 'POST', { path: project }, token))[1].project.id;
  const [, started] = await req(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, token);
  const crashedRunId = started.run.id;
  // Wait until the run is really in flight.
  for (let i = 0; i < 100; i++) {
    const r = (await req(`/api/runs/${crashedRunId}`, 'GET', null, token))[1].run;
    if (r.status === 'running') break;
    await new Promise((r) => setTimeout(r, 40));
  }
  // Kill the Bridge WITHOUT stopping the run: the crash case.
  bridge.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));

  // Restart: the Bridge recovers the state and marks the run.
  bridge = startBridge();
  if (!await ready()) throw new Error('the bridge did not come back up');
  const token2 = (await req('/api/session'))[1].token;
  const crashedRun = (await req(`/api/runs/${crashedRunId}`, 'GET', null, token2))[1].run;
  const crashedEvents = (await req(`/api/runs/${crashedRunId}/events`, 'GET', null, token2))[1].events;
  report('Case A: the Bridge was killed while the run was in flight', crashedRun, crashedEvents);

  // --- Case B: a run that finishes normally ------------------------------
  const [, started2] = await req(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, token2);
  const okRunId = started2.run.id;
  let okRun = null;
  for (let i = 0; i < 150; i++) {
    okRun = (await req(`/api/runs/${okRunId}`, 'GET', null, token2))[1].run;
    if (['passed', 'failed', 'error', 'cancelled'].includes(okRun.status)) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  const okEvents = (await req(`/api/runs/${okRunId}/events`, 'GET', null, token2))[1].events;
  report('Case B: the run finished normally', okRun, okEvents);

  // --- The durable log vs. the state file --------------------------------
  const eventsFile = path.join(data, 'runs', crashedRunId, 'events.jsonl');
  const onDisk = fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const state = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  const inState = state.runs.find((r) => r.id === crashedRunId);
  console.log('--- the durable log vs. the state file ---');
  console.log('  events.jsonl     :', JSON.stringify(onDisk.map((e) => `${e.seq}:${e.type}`)));
  console.log('  run.eventSeq     :', inState?.eventSeq);
  console.log('  the state file carries the events:', Array.isArray(inState?.events) ? JSON.stringify(inState.events.length) : 'no `events` field at all');
  console.log('');
} finally {
  bridge.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
