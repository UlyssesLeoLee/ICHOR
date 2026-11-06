/**
 * ATS-208 probe: measure the CURRENT behaviour of the run/attempt/event
 * model against the acceptance criteria of the task.
 *
 *   1. "重试不覆盖初次尝试" -- a retried case must keep EVERY attempt, and
 *      the first attempt must survive the retry.
 *   2. "事件可按 run+sequence 复演" -- the event stream of a run must be
 *      replayable into the run's terminal state, and the sequence must be
 *      gap-free and strictly increasing.
 *
 * The probe only OBSERVES. It never asserts the desired behaviour -- it
 * prints what the code does, so the report says what is broken rather than
 * what should be.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseReport, attemptsForRun } from '../../server/core.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats208-probe-'));
const project = path.join(dir, 'fake-pw');
const data = path.join(dir, 'data');
fs.mkdirSync(path.join(project, 'node_modules', '@playwright', 'test'), { recursive: true });
fs.mkdirSync(path.join(project, 'tests'));
fs.writeFileSync(path.join(project, 'package.json'), '{}');
fs.writeFileSync(path.join(project, 'playwright.config.ts'), 'export default {}');
fs.writeFileSync(
  path.join(project, 'tests', 'flaky.spec.ts'),
  "test('flaky case', ()=>{});\n"
);

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

const PORT = 4599;
const root = path.resolve(import.meta.dirname, '..', '..');
const cp = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: { ...process.env, ATS_PORT: String(PORT), ATS_DATA_DIR: data },
  stdio: 'ignore',
});

async function ready() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('bridge unreachable');
}
async function req(endpoint, method = 'GET', body, tok) {
  const r = await fetch(`http://127.0.0.1:${PORT}${endpoint}`, {
    method,
    headers: tok ? { 'X-ATS-Token': tok, 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return [r.status, await r.json()];
}

try {
  await ready();
  const token = (await req('/api/session'))[1].token;
  const projectId = (await req('/api/projects', 'POST', { path: project }, token))[1].project.id;
  const [, started] = await req(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/flaky.spec.ts' }, token);
  const runId = started.run.id;

  let run = null;
  for (let i = 0; i < 100; i++) {
    run = (await req(`/api/runs/${runId}`, 'GET', null, token))[1].run;
    if (['passed', 'failed', 'error', 'cancelled'].includes(run.status)) break;
    await new Promise((r) => setTimeout(r, 40));
  }

  console.log('=== 1. the retried case ===');
  console.log('run.status        :', run.status);
  console.log('summary           :', JSON.stringify({
    total: run.summary?.total, passed: run.summary?.passed,
    failed: run.summary?.failed, flaky: run.summary?.flaky,
    executions: run.summary?.executions,
  }));
  console.log('summary.cases     :', JSON.stringify(run.summary?.cases));
  console.log('attempts          :', JSON.stringify((run.attempts ?? []).map((a) => ({
    uid: a.uid, retry: a.retry, status: a.status,
    caseStatus: a.caseStatus, duration: a.duration, error: a.error,
  })), null, 2));

  console.log('');
  console.log('=== 2. the raw report parsed by core.parseReport ===');
  const raw = parseReport(JSON.parse(fs.readFileSync(path.join(data, 'runs', runId, 'report.json'), 'utf8')));
  console.log('raw summary       :', JSON.stringify({
    total: raw.total, passed: raw.passed, failed: raw.failed,
    flaky: raw.flaky, executions: raw.executions,
  }));
  console.log('raw cases         :', JSON.stringify(raw.cases));

  console.log('');
  console.log('=== 3. the event stream ===');
  const events = (await req(`/api/runs/${runId}/events`, 'GET', null, token))[1].events;
  console.log('events            :', JSON.stringify(events, null, 2));
  const seqs = events.map((e) => e.seq);
  const gaps = seqs.filter((s, i) => i > 0 && s !== seqs[i - 1] + 1);
  console.log('seq values        :', JSON.stringify(seqs));
  console.log('gap-free          :', gaps.length === 0, gaps.length ? `gaps at ${JSON.stringify(gaps)}` : '');

  console.log('');
  console.log('=== 4. can the event stream be replayed into the terminal state? ===');
  // The last event that carries a status is the one a replay would trust.
  const lastWithStatus = [...events].reverse().find((e) => e.data && e.data.status);
  console.log('last event with a status :', lastWithStatus ? `${lastWithStatus.type} -> ${lastWithStatus.data.status}` : '(none)');
  console.log('the run record says      :', run.status);
  console.log('replay agrees            :', lastWithStatus ? lastWithStatus.data.status === run.status : false);

  console.log('');
  console.log('=== 5. the events table in the SQLite mirror ===');
  try {
    const { openDatabase } = await import('../../server/sqlite/db.mjs');
    const db = openDatabase(path.join(data, 'metadata.db'), { migrate: false });
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((t) => t.name);
    console.log('tables            :', JSON.stringify(tables));
    console.log('has an events table:', tables.includes('events'));
    db.close();
  } catch (e) {
    console.log('the SQLite mirror could not be inspected:', e.message);
  }
} finally {
  cp.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
