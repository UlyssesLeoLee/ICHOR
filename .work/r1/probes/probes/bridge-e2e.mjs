// ATS-208 review probe: the Bridge end to end with REAL Playwright 1.64.1, plus a crash while cancelling.
// usage: node bridge-e2e.mjs <tree> <pwproj2> <scratch>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const [tree, pwproj, scratch] = process.argv.slice(2).map((p) => path.resolve(p));
const PORT = 8931;
let fails = 0;
const check = (label, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  -- ' + detail : ''}`); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function startBridge(data) {
  return spawn(process.execPath, ['server/index.mjs'], { cwd: tree, env: { ...process.env, ATS_PORT: String(PORT), ATS_DATA_DIR: data }, stdio: ['ignore', 'ignore', 'pipe'] });
}
async function ready() { for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return; } catch {} await sleep(50); } throw new Error('bridge not up'); }
async function req(ep, method = 'GET', body, tok) {
  const r = await fetch(`http://127.0.0.1:${PORT}${ep}`, { method, headers: tok ? { 'X-ATS-Token': tok, 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {} return [r.status, j];
}
async function waitTerminal(id, tok, ms = 120000) {
  const end = Date.now() + ms; let run;
  while (Date.now() < end) { run = (await req(`/api/runs/${id}`, 'GET', null, tok))[1].run; if (['passed', 'failed', 'error', 'cancelled', 'interrupted'].includes(run.status)) return run; await sleep(200); }
  return run;
}
async function killHard(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.on('exit', r));
  if (process.platform === 'win32') { await new Promise((r) => spawn('taskkill', ['/PID', String(child.pid), '/F'], { windowsHide: true }).on('close', r)); }
  else child.kill('SIGKILL');
  await exited;
}

// ---------------- Part 1: real Playwright through the Bridge ----------------
const ONLY_E3 = process.env.ONLY_E3 === '1';
const data1 = path.join(scratch, 'data-e2e'); fs.rmSync(data1, { recursive: true, force: true });
let bridge = ONLY_E3 ? null : startBridge(data1); let stderr = ''; bridge?.stderr.on('data', (b) => { stderr += b; });
if (!ONLY_E3) try {
  await ready();
  const tok = (await req('/api/session'))[1].token;
  const [ps, pj] = await req('/api/projects', 'POST', { path: pwproj }, tok);
  if (ps >= 300) throw new Error('register failed ' + JSON.stringify(pj));
  const pid = pj.project.id;
  // Discover first, so the registry holds the TestDefinition UIDs the attempts bind to.
  const [ts, tj] = await req(`/api/projects/${pid}/tests`, 'GET', null, tok);
  console.log('   discovery', ts, (tj?.tests || []).map((t) => `${t.file}:${t.title}:${t.uid}`).join(' | '));

  console.log('== E1: a case that fails on the first try and passes on the retry (real PW) ==');
  const [, s1] = await req(`/api/projects/${pid}/run`, 'POST', { file: 'tests/retry.spec.ts' }, tok);
  const run = await waitTerminal(s1.run.id, tok);
  console.log('   run.status', run.status, 'summary', JSON.stringify({ ...run.summary, cases: undefined }));
  console.log('   attempts', JSON.stringify((run.attempts || []).map((a) => ({ retry: a.retry, status: a.status, caseStatus: a.caseStatus, testUid: a.testUid, error: (a.error || '').slice(0, 40) }))));
  check('E1 case counted once (total=1, flaky=1, executions=2)', run.summary?.total === 1 && run.summary?.flaky === 1 && run.summary?.executions === 2);
  check('E1 first attempt kept as failed with its error', run.attempts?.[0]?.retry === 0 && run.attempts?.[0]?.status === 'failed' && /first attempt failed/.test(run.attempts?.[0]?.error || ''));
  check('E1 both attempts carry the same NON-NULL testUid', run.attempts?.length === 2 && !!run.attempts[0].testUid && run.attempts[0].testUid === run.attempts[1].testUid, `testUid=${run.attempts?.[0]?.testUid} basis=${run.attempts?.[0]?.uidBasis}`);
  const [, rp] = await req(`/api/runs/${run.id}/replay`, 'GET', null, tok);
  console.log('   replay', JSON.stringify({ status: rp.status, replayedStatus: rp.replayedStatus, agrees: rp.agrees, sequence: rp.sequence, gaps: rp.gaps, types: rp.events.map((e) => e.type) }));
  check('E1 replay agrees and sequence is 1..N', rp.agrees === true && rp.gaps.length === 0 && rp.sequence.every((s, i) => s === i + 1));

  console.log('== E2: a file whose only case is an expected failure (test.fail) ==');
  const [, s2] = await req(`/api/projects/${pid}/run`, 'POST', { file: 'tests/xfail.spec.ts' }, tok);
  const run2 = await waitTerminal(s2.run.id, tok);
  console.log('   run.status', run2.status, 'exitCode', run2.exitCode, 'summary', JSON.stringify({ ...run2.summary, cases: undefined }));
  console.log('   attempts', JSON.stringify((run2.attempts || []).map((a) => ({ retry: a.retry, status: a.status, caseStatus: a.caseStatus }))));
  check('E2 summary agrees with the run outcome (passed run -> 0 failed cases)', !(run2.status === 'passed' && run2.summary?.failed > 0), `run=${run2.status} but summary.failed=${run2.summary?.failed}, case=${run2.summary?.cases?.[0]?.status}`);

  // SQLite mirror: the events table vs events.jsonl
  await sleep(300);
  const db = new DatabaseSync(path.join(data1, 'metadata.db'), { readOnly: true });
  for (const r of [run, run2]) {
    const rows = db.prepare('SELECT seq,type FROM events WHERE run_uid=? ORDER BY seq').all(r.uid);
    const logged = fs.readFileSync(path.join(data1, 'runs', r.id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check(`SQLite events rows == events.jsonl for ${r.file}`, JSON.stringify(rows.map((x) => [x.seq, x.type])) === JSON.stringify(logged.map((x) => [x.seq, x.type])), `${rows.length} rows / ${logged.length} logged`);
  }
  db.close();
} finally { await killHard(bridge); }

// ---------------- Part 2: the Bridge dies while a run is `cancelling` ----------------
console.log('== E3: the Bridge dies after POST /stop, before the engine exit is processed ==');
const fake = path.join(scratch, 'fake-hang'); fs.rmSync(fake, { recursive: true, force: true });
fs.mkdirSync(path.join(fake, 'node_modules', '@playwright', 'test'), { recursive: true }); fs.mkdirSync(path.join(fake, 'tests'));
fs.writeFileSync(path.join(fake, 'package.json'), '{}'); fs.writeFileSync(path.join(fake, 'playwright.config.ts'), 'export default {}');
fs.writeFileSync(path.join(fake, 'tests', 'slow.spec.ts'), "test('slow case', ()=>{});\n");
fs.writeFileSync(path.join(fake, 'node_modules', '@playwright', 'test', 'cli.js'), "const fs=require('fs');const o=process.argv[process.argv.indexOf('--output')+1];fs.mkdirSync(o,{recursive:true});setInterval(()=>{},1000);");
const data2 = path.join(scratch, ONLY_E3 ? 'data-cancel-' + path.basename(tree) : 'data-cancel'); fs.rmSync(data2, { recursive: true, force: true });
bridge = startBridge(data2);
let runId, tok;
try {
  await ready();
  tok = (await req('/api/session'))[1].token;
  const pid = (await req('/api/projects', 'POST', { path: fake }, tok))[1].project.id;
  runId = (await req(`/api/projects/${pid}/run`, 'POST', { file: 'tests/slow.spec.ts' }, tok))[1].run.id;
  for (let i = 0; i < 100; i++) { if ((await req(`/api/runs/${runId}`, 'GET', null, tok))[1].run.status === 'running') break; await sleep(50); }
  // The stop and the crash are issued together: the Bridge saves `cancelling`
  // synchronously inside the stop handler, then dies before the engine's exit
  // event is processed.
  const stopP = req(`/api/runs/${runId}/stop`, 'POST', {}, tok);
  const [, stop] = await stopP;
  console.log('   stop ->', JSON.stringify(stop));
} finally { await killHard(bridge); }
const st = JSON.parse(fs.readFileSync(path.join(data2, 'state.json'), 'utf8')).runs.find((r) => r.id === runId);
console.log('   state.json after the crash: status', st.status, 'events', JSON.stringify((st.events || []).map((e) => `${e.seq}:${e.type}`)));
bridge = startBridge(data2);
try {
  await ready(); tok = (await req('/api/session'))[1].token;
  await sleep(500);
  const run = (await req(`/api/runs/${runId}`, 'GET', null, tok))[1].run;
  const [, rp] = await req(`/api/runs/${runId}/replay`, 'GET', null, tok);
  console.log('   after restart: run.status', run.status, 'replay', JSON.stringify({ replayedStatus: rp?.replayedStatus, terminal: rp?.terminal, types: rp?.events?.map((e) => e.type) ?? '(no /replay endpoint)' }));
  check('E3 a run that was cancelling when the Bridge died is recovered as interrupted', run.status === 'interrupted' && rp?.replayedStatus === 'interrupted', `status=${run.status}, replayed=${rp?.replayedStatus}, terminal=${rp?.terminal}`);
  const [cs, cj] = await req(`/api/runs/${runId}/stop`, 'POST', {}, tok);
  console.log('   POST /stop on the recovered run ->', cs, JSON.stringify(cj));
} finally { await killHard(bridge); }
if (stderr.trim()) console.log('bridge stderr (part 1):\n' + stderr.trim().split('\n').slice(0, 10).join('\n'));
console.log(`\nRESULT: ${fails} failed check(s)`);
process.exit(fails ? 1 : 0);
