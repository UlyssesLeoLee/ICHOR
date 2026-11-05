// ATS-208 review probe: does the Bridge still start when the durable log of an in-flight run is damaged?
// usage: node startup-robustness.mjs <tree> <scratch> [baseTree]
// S1: the state says `running`, the run folder is gone (deleted by the user / never created).
// S2: the last line of events.jsonl is torn (a crash in the middle of an append).
// The same crafted data dir is started with the tip Bridge and, if given, with the base (ea72af0) Bridge.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [tree, scratch, baseTree] = process.argv.slice(2).map((p) => p && path.resolve(p));
const PORT = 8932;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (label, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  -- ' + detail : ''}`); if (!cond) fails++; };
function startBridge(root, data) {
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, ATS_PORT: String(PORT), ATS_DATA_DIR: data }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.err = ''; child.stderr.on('data', (b) => { child.err += b; });
  return child;
}
async function ready(child, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) return false;
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return true; } catch {}
    await sleep(50);
  }
  return false;
}
async function req(ep, method = 'GET', body, tok) {
  const r = await fetch(`http://127.0.0.1:${PORT}${ep}`, { method, headers: tok ? { 'X-ATS-Token': tok, 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {} return [r.status, j];
}
async function killHard(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.on('exit', r));
  await new Promise((r) => spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('close', r));
  await exited;
}

// Build a data dir with one run that is `running` when the Bridge dies.
async function makeCrashedRun(name) {
  const fake = path.join(scratch, `${name}-proj`); fs.rmSync(fake, { recursive: true, force: true });
  fs.mkdirSync(path.join(fake, 'node_modules', '@playwright', 'test'), { recursive: true }); fs.mkdirSync(path.join(fake, 'tests'));
  fs.writeFileSync(path.join(fake, 'package.json'), '{}'); fs.writeFileSync(path.join(fake, 'playwright.config.ts'), 'export default {}');
  fs.writeFileSync(path.join(fake, 'tests', 'slow.spec.ts'), "test('slow case', ()=>{});\n");
  fs.writeFileSync(path.join(fake, 'node_modules', '@playwright', 'test', 'cli.js'), "const fs=require('fs');const o=process.argv[process.argv.indexOf('--output')+1];fs.mkdirSync(o,{recursive:true});setTimeout(()=>{},4000);");
  const data = path.join(scratch, `${name}-data`); fs.rmSync(data, { recursive: true, force: true });
  const b = startBridge(tree, data);
  if (!await ready(b)) throw new Error('bridge did not start');
  const tok = (await req('/api/session'))[1].token;
  const pid = (await req('/api/projects', 'POST', { path: fake }, tok))[1].project.id;
  const runId = (await req(`/api/projects/${pid}/run`, 'POST', { file: 'tests/slow.spec.ts' }, tok))[1].run.id;
  for (let i = 0; i < 100; i++) { if ((await req(`/api/runs/${runId}`, 'GET', null, tok))[1].run.status === 'running') break; await sleep(50); }
  await killHard(b);
  await sleep(4500); // let the orphaned engine double exit
  return { data, runId };
}
function copyDir(src, dst) { fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(src, dst, { recursive: true }); }

async function boot(label, root, data, runId) {
  const b = startBridge(root, data);
  const up = await ready(b);
  let detail = up ? 'up' : `exited with code ${b.exitCode}; stderr: ${b.err.trim().split('\n').filter((l) => /Error|ENOENT|at /.test(l)).slice(0, 2).join(' | ')}`;
  let replay = null;
  if (up) {
    const tok = (await req('/api/session'))[1].token;
    const [s, j] = await req(`/api/runs/${runId}/replay`, 'GET', null, tok);
    const [es] = await req(`/api/runs/${runId}/events`, 'GET', null, tok);
    const [rs, rj] = await req(`/api/runs/${runId}`, 'GET', null, tok);
    replay = { replayHttp: s, eventsHttp: es, runStatus: rj?.run?.status, replayedStatus: j?.replayedStatus, error: j?.error };
    detail += ' ' + JSON.stringify(replay);
  }
  await killHard(b);
  console.log(`   ${label}: ${detail}`);
  return { up, replay };
}

const { data, runId } = await makeCrashedRun('s');
console.log('crafted run', runId);

console.log('== S1: state says running, run folder missing ==');
const s1 = path.join(scratch, 's1-data'); copyDir(data, s1); fs.rmSync(path.join(s1, 'runs', runId), { recursive: true, force: true });
const s1base = path.join(scratch, 's1-data-base'); copyDir(s1, s1base);
const r1 = await boot('tip ', tree, s1, runId);
if (baseTree) await boot('base', baseTree, s1base, runId);
check('S1 the tip Bridge starts and recovers the run', r1.up && r1.replay?.runStatus === 'interrupted');

console.log('== S2: the last line of events.jsonl is torn ==');
const s2 = path.join(scratch, 's2-data'); copyDir(data, s2);
const log = path.join(s2, 'runs', runId, 'events.jsonl');
fs.appendFileSync(log, '{"seq":3,"at":"2026-11-06T00:00:00.000Z","ty');
const s2base = path.join(scratch, 's2-data-base'); copyDir(s2, s2base);
const r2 = await boot('tip ', tree, s2, runId);
console.log('   events.jsonl after the tip boot:\n     ' + fs.readFileSync(log, 'utf8').split('\n').join('\n     '));
if (baseTree) await boot('base', baseTree, s2base, runId);
check('S2 the run stays readable after a torn tail (replay 200)', r2.up && r2.replay?.replayHttp === 200, JSON.stringify(r2.replay));

console.log('== S3: the Bridge died after appending run.finished, before saveState (the finishRun collect window) ==');
{
  const fake = path.join(scratch, 's3-proj'); fs.rmSync(fake, { recursive: true, force: true });
  fs.mkdirSync(path.join(fake, 'node_modules', '@playwright', 'test'), { recursive: true }); fs.mkdirSync(path.join(fake, 'tests'));
  fs.writeFileSync(path.join(fake, 'package.json'), '{}'); fs.writeFileSync(path.join(fake, 'playwright.config.ts'), 'export default {}');
  fs.writeFileSync(path.join(fake, 'tests', 'ok.spec.ts'), "test('ok case', ()=>{});\n");
  fs.writeFileSync(path.join(fake, 'node_modules', '@playwright', 'test', 'cli.js'), "const fs=require('fs');const o=process.argv[process.argv.indexOf('--output')+1];fs.mkdirSync(o,{recursive:true});fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,JSON.stringify({suites:[{file:'tests/ok.spec.ts',specs:[{title:'ok case',line:1,tests:[{status:'expected',results:[{status:'passed',duration:5}]}]}]}]}));");
  const data = path.join(scratch, 's3-data'); fs.rmSync(data, { recursive: true, force: true });
  let b = startBridge(tree, data);
  if (!await ready(b)) throw new Error('bridge did not start');
  let tok = (await req('/api/session'))[1].token;
  const pid = (await req('/api/projects', 'POST', { path: fake }, tok))[1].project.id;
  const id = (await req(`/api/projects/${pid}/run`, 'POST', { file: 'tests/ok.spec.ts' }, tok))[1].run.id;
  let st;
  for (let i = 0; i < 200; i++) { st = (await req(`/api/runs/${id}`, 'GET', null, tok))[1].run.status; if (st === 'passed' || st === 'failed') break; await sleep(50); }
  await killHard(b);
  // Rewind state.json to what it held before finishRun's saveState: the run is
  // still `running` and the state does not have the run.finished event yet.
  // events.jsonl keeps run.finished, exactly as the append-then-crash leaves it.
  const sf = path.join(data, 'state.json');
  const state = JSON.parse(fs.readFileSync(sf, 'utf8'));
  const run = state.runs.find((r) => r.id === id);
  console.log('   finished normally as', run.status);
  run.status = 'running'; run.finishedAt = null; run.summary = null; run.attempts = [];
  run.events = run.events.filter((e) => e.type !== 'run.finished'); run.eventSeq = run.events.length;
  fs.writeFileSync(sf, JSON.stringify(state, null, 2));
  b = startBridge(tree, data);
  await ready(b); tok = (await req('/api/session'))[1].token;
  const after = (await req(`/api/runs/${id}`, 'GET', null, tok))[1].run;
  const [, rp] = await req(`/api/runs/${id}/replay`, 'GET', null, tok);
  await killHard(b);
  const types = rp.events.map((e) => `${e.seq}:${e.type}${e.data?.status ? '(' + e.data.status + ')' : ''}`);
  console.log('   after restart: run.status', after.status, 'replay', JSON.stringify({ replayedStatus: rp.replayedStatus, agrees: rp.agrees, events: types }));
  const terminalIdx = rp.events.findIndex((e) => e.type === 'run.finished');
  check('S3 no event is appended after a terminal event (the log already says the run finished)', terminalIdx === -1 || terminalIdx === rp.events.length - 1, JSON.stringify(types));
}
console.log(`\nRESULT: ${fails} failed check(s)`);
process.exit(fails ? 1 : 0);
