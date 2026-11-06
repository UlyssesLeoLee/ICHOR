// ATS-106: process-level IT of the run preflight and of the run request
// safety checks (docs/26-RUNNER-PREFLIGHT.md). A real Bridge runs on a free
// port with an isolated data directory. The projects use TEST-DOUBLE CLIs
// (not Playwright): each one writes a marker file when it is executed, so
// the test can prove whether the engine was spawned at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats106-it-'));
const data = path.join(tmp, 'data');
const port = await freePort();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const json = (file, value) => write(file, JSON.stringify(value));

// The double answers --help with the four options, and otherwise records that
// it ran and writes a passing report.
const CLI = `
const fs=require('fs'),path=require('path');const args=process.argv.slice(2);
if(args.includes('--help')){console.log(['Usage: playwright test [options] [test-filter...]','Options:','  --reporter <reporter>  r','  --output <dir>  o','  --trace <mode>  t','  -j, --workers <workers>  w'].join('\\n'));process.exit(0);}
fs.writeFileSync(path.join(process.cwd(),'ENGINE_RAN'),JSON.stringify(args));
const report=process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
fs.writeFileSync(report,JSON.stringify({suites:[{file:'tests/ok.spec.ts',specs:[{title:'ok',tests:[{status:'expected',results:[{duration:1,status:'passed'}]}]}]}]}));
`;

function project(name, { version = '1.64.1', playwright = true } = {}) {
  const dir = path.join(tmp, name);
  write(path.join(dir, 'package.json'), '{}');
  write(path.join(dir, 'playwright.config.ts'), 'export default {}');
  write(path.join(dir, 'tests', 'ok.spec.ts'), "test('ok',()=>{})");
  write(path.join(dir, 'tests', 'a+b.spec.ts'), "test('ab',()=>{})");
  write(path.join(dir, '-x.spec.ts'), "test('x',()=>{})");
  const nm = path.join(dir, 'node_modules');
  write(path.join(nm, '@playwright', 'test', 'cli.js'), CLI);
  json(path.join(nm, '@playwright', 'test', 'package.json'), { name: '@playwright/test', version, engines: { node: '>=18' }, dependencies: { playwright: version } });
  if (playwright) {
    json(path.join(nm, 'playwright', 'package.json'), { name: 'playwright', version, dependencies: { 'playwright-core': version } });
    json(path.join(nm, 'playwright-core', 'package.json'), { name: 'playwright-core', version });
    json(path.join(nm, 'playwright-core', 'browsers.json'), { browsers: [] });
  }
  return dir;
}
write(path.join(tmp, 'outside.spec.ts'), "test('outside',()=>{})");
const projects = { old: project('old', { version: '1.40.0' }), nodeps: project('nodeps', { playwright: false }), noconfig: project('noconfig'), good: project('good') };

let bridge;
let token;
const ids = {};
async function call(endpoint, method = 'GET', body) {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method, headers: token ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  return [r.status, await r.json()];
}
async function settled(id) {
  for (let i = 0; i < 200; i += 1) {
    const run = (await call(`/api/runs/${id}`))[1].run;
    if (!['queued', 'running', 'cancelling'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('run did not settle');
}
const ran = (dir) => fs.existsSync(path.join(dir, 'ENGINE_RAN'));
const runCount = async () => (await call('/api/runs'))[1].runs.length;

test('IT-PF-SETUP: a Bridge with four registered projects', async () => {
  bridge = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data }, stdio: 'ignore' });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  token = (await call('/api/session'))[1].token;
  for (const [key, dir] of Object.entries(projects)) {
    const [status, answer] = await call('/api/projects', 'POST', { path: dir });
    assert.equal(status, 201, JSON.stringify(answer));
    ids[key] = answer.project.id;
  }
  fs.rmSync(path.join(projects.noconfig, 'playwright.config.ts'));
});

async function refusedByPreflight(key, code) {
  const [status, answer] = await call(`/api/projects/${ids[key]}/run`, 'POST', {});
  assert.equal(status, 202);
  const run = await settled(answer.run.id);
  assert.equal(run.status, 'error');
  assert.equal(run.error, code);
  assert.equal(typeof run.errorHint, 'string');
  assert.ok(run.errorHint.length > 0);
  assert.equal(run.preflight.ok, false);
  assert.equal(run.preflight.errors[0].code, code);
  assert.equal(run.pid, undefined);
  assert.equal(run.command, undefined);
  const replay = (await call(`/api/runs/${run.id}/replay`))[1];
  assert.deepEqual(run.events.map((e) => e.type), ['run.queued', 'run.error']);
  assert.equal(run.events[1].data.error, code);
  // The durable log replays to the same terminal status and obeys the state machine.
  assert.equal(replay.replayedStatus, 'error');
  assert.equal(replay.agrees, true);
  assert.equal(replay.valid, true);
  assert.equal(ran(projects[key]), false, 'the engine must not have been spawned');
  return run;
}

test('IT-PF-001: an unsupported version ends the run in error before spawn', async () => {
  const run = await refusedByPreflight('old', 'PLAYWRIGHT_VERSION_UNSUPPORTED');
  assert.equal(run.preflight.errors[0].detail.version, '1.40.0');
});

test('IT-PF-002: a missing Playwright dependency ends the run in error before spawn', async () => {
  const run = await refusedByPreflight('nodeps', 'PLAYWRIGHT_DEPENDENCY_MISSING');
  assert.equal(run.preflight.errors[0].detail.missing[0].package, 'playwright');
});

test('IT-PF-003: a config deleted after registration ends the run in error before spawn', async () => {
  await refusedByPreflight('noconfig', 'PLAYWRIGHT_CONFIG_REQUIRED');
  // The run is terminal, so the project is not locked: a second request is accepted.
  const [status] = await call(`/api/projects/${ids.noconfig}/run`, 'POST', {});
  assert.equal(status, 202);
});

test('IT-PF-004: a complete installation runs, and the preflight is recorded', async () => {
  const [status, answer] = await call(`/api/projects/${ids.good}/run`, 'POST', { file: 'tests/ok.spec.ts' });
  assert.equal(status, 202);
  const run = await settled(answer.run.id);
  assert.equal(run.status, 'passed', run.error);
  assert.equal(run.preflight.ok, true);
  assert.equal(run.preflight.version, '1.64.1');
  assert.equal(run.command.at(-1), 'tests/ok.spec.ts');
  assert.ok(ran(projects.good));
  const argv = JSON.parse(fs.readFileSync(path.join(projects.good, 'ENGINE_RAN'), 'utf8'));
  assert.deepEqual(argv.filter((a) => a.startsWith('-')), ['--reporter=line,json,html', '--output', '--trace', '--workers']);
});

test('IT-PF-005: fields outside the run request whitelist are refused, no run is created', async () => {
  const before = await runCount();
  for (const body of [{ config: 'evil.ts' }, { project: 'x' }, { args: ['--grep', 'x'] }, { file: 'tests/ok.spec.ts', grep: 'x' }]) {
    const [status, answer] = await call(`/api/projects/${ids.good}/run`, 'POST', body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(answer.error, 'RUN_PARAMETER_NOT_ALLOWED');
    assert.deepEqual(answer.rejected, Object.keys(body).filter((k) => k !== 'file'));
  }
  assert.equal(await runCount(), before);
});

test('IT-PF-006: an option-shaped or regex-shaped filter is refused, no run is created', async () => {
  const before = await runCount();
  for (const file of ['-x.spec.ts', 'tests/a+b.spec.ts']) {
    const [status, answer] = await call(`/api/projects/${ids.good}/run`, 'POST', { file });
    assert.equal(status, 400, file);
    assert.equal(answer.error, 'INVALID_TEST_FILTER');
  }
  assert.equal(await runCount(), before);
});

test('IT-PF-007: traversal is still refused by the source path check', async () => {
  const [status, answer] = await call(`/api/projects/${ids.good}/run`, 'POST', { file: '../outside.spec.ts' });
  assert.equal(status, 400);
  assert.equal(answer.error, 'PATH_OUTSIDE_PROJECT');
});

test.after(() => {
  if (bridge) bridge.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the bridge may still hold a file on Windows */ }
});
