/**
 * ATS-209 -- the evidence manifest and the retention cleaner: the
 * integration tests.
 *
 * These are the IT-level cases: the bridge runs as a REAL process against a
 * REAL data directory, and the evidence subsystem is exercised through the
 * HTTP API and through the run folder on disk.
 *
 * What they assert:
 *
 *   1. A run that ends writes a manifest that names the run and carries
 *      the digest of every evidence file -- the acceptance criterion
 *      「篡改可检测」;
 *   2. A file that is tampered with AFTER the run is reported as changed,
 *      with the digest it should have and the digest it has;
 *   3. The retention cleaning removes the expired evidence and leaves the
 *      run record, the event log and the manifest alone -- the acceptance
 *      criterion 「保留期到期可清理且不误删 Run 元数据」;
 *   4. The cleaning is refused while the Bridge holds the data directory.
 *
 * The CLI is a TEST DOUBLE: it models the SHAPE of a Playwright report and
 * writes a few evidence files, and it never runs a browser. The evidence
 * files it writes are REAL files, and the digests are computed from their
 * real bytes -- the properties under test are properties of the
 * filesystem.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';
import { sha256OfFile } from '../server/evidence/manifest.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-evidence-it-'));
const project = path.join(dir, 'fake-pw');
const data = path.join(dir, 'data');

fs.mkdirSync(path.join(project, 'node_modules', '@playwright', 'test'), { recursive: true });
fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
fs.writeFileSync(path.join(project, 'package.json'), '{}');
fs.writeFileSync(path.join(project, 'playwright.config.ts'), 'export default {}');
fs.writeFileSync(path.join(project, 'tests', 'pass.spec.ts'), "test('simulated success', ()=>{});\n");

// A CLI double that writes a report, an HTML report and a trace archive --
// the three kinds of evidence a real run leaves behind.
fs.writeFileSync(
  path.join(project, 'node_modules', '@playwright', 'test', 'cli.js'),
  `
const fs=require('fs'),path=require('path');
const out=process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
const folder=path.dirname(out);
const output=process.argv[process.argv.indexOf('--output')+1];
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(out, JSON.stringify({
  config:{rootDir:process.cwd().split(path.sep).join('/')},
  suites:[{file:'tests/pass.spec.ts',specs:[{title:'simulated success',file:'tests/pass.spec.ts',line:1,tests:[{
    status:'expected',results:[{duration:12}]
  }]}]}]
}));
fs.mkdirSync(path.join(folder,'html'),{recursive:true});
fs.writeFileSync(path.join(folder,'html','index.html'),'<h1>fixture report</h1>');
fs.writeFileSync(path.join(output,'fixture-trace.zip'),'not a real trace');
console.log('test-double: one passing case');
`
);

const port = await freePort();
let cp = null;
let token = null;
let projectId = null;
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
async function waitRun(id, status) {
  for (let i = 0; i < 200; i++) {
    const r = (await req(`/api/runs/${id}`))[1].run;
    if (r.status === status) return r;
    if (['error', 'failed', 'cancelled'].includes(r.status) && r.status !== status) {
      throw new Error(`unexpected ${r.status}: ${r.error}`);
    }
    await new Promise((res) => setTimeout(res, 35));
  }
  throw new Error('run timeout');
}

test('IT-EVD-101: the bridge starts against an isolated data directory', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data },
    stdio: 'ignore',
  });
  await ready();
  token = (await req('/api/session'))[1].token;
  projectId = (await req('/api/projects', 'POST', { path: project }))[1].project.id;
  assert.ok(projectId);
});

test('IT-EVD-102: a finished run writes a manifest that names the run and its digests', async () => {
  const [code, body] = await req(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/pass.spec.ts' });
  assert.equal(code, 202);
  const run = await waitRun(body.run.id, 'passed');
  runId = run.id;

  // The manifest is on disk, in the run's own folder.
  const manifestPath = path.join(data, 'runs', runId, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'the run must leave a manifest behind');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // It names the run it belongs to.
  assert.equal(manifest.runId, runId);
  assert.equal(manifest.projectUid, run.projectUid);
  assert.equal(manifest.sourceCommit, run.gitCommit);
  assert.equal(manifest.status, 'passed');

  // It carries the digest of every evidence file, and every digest is the
  // digest of the file's REAL bytes.
  const files = manifest.artifacts.map((a) => a.file).sort();
  assert.ok(files.includes('report.json'), `the report must be listed: ${files.join(', ')}`);
  assert.ok(files.some((f) => f.includes('fixture-trace.zip')), `the trace must be listed: ${files.join(', ')}`);
  for (const artifact of manifest.artifacts) {
    const full = path.join(data, 'runs', runId, artifact.file);
    assert.ok(fs.existsSync(full), `${artifact.file} must exist`);
    assert.equal(artifact.sha256, sha256OfFile(full), `${artifact.file} must carry its own digest`);
  }

  // The evidence section says what the set is as a whole.
  assert.equal(manifest.evidence.count, manifest.artifacts.length);
  assert.ok(manifest.evidence.totalBytes > 0);
  assert.match(manifest.evidence.setDigest, /^[0-9a-f]{64}$/);

  // The manifest does not list itself, and the run's artifacts do not
  // either: the manifest is the record OF the evidence.
  assert.ok(!manifest.artifacts.some((a) => a.file === 'manifest.json'));
  assert.ok(!run.artifacts.some((a) => a.file === 'manifest.json'));
  assert.ok(!run.artifacts.some((a) => a.file === 'events.jsonl'));
  assert.ok(!run.artifacts.some((a) => a.file === 'stdout.log'));
});

test('IT-EVD-103: the verification reports an intact evidence set as verified', async () => {
  const [code, body] = await req(`/api/runs/${runId}/evidence`);
  assert.equal(code, 200);
  assert.equal(body.verified, true);
  assert.equal(body.missing.length, 0);
  assert.equal(body.changed.length, 0);
  assert.ok(body.checked > 0);
  assert.equal(body.manifestVersion, 2);
});

test('IT-EVD-104: a file that is tampered with after the run is reported as changed', async () => {
  // The tamper: the archived report is rewritten.
  const target = path.join(data, 'runs', runId, 'report.json');
  fs.writeFileSync(target, '{"tampered":true}');

  const [code, body] = await req(`/api/runs/${runId}/evidence`);
  assert.equal(code, 200);
  assert.equal(body.verified, false, 'the tampering must be detected');
  assert.equal(body.changed.length, 1);
  assert.equal(body.changed[0].file, 'report.json');
  assert.notEqual(body.changed[0].expected, body.changed[0].actual);
  assert.equal(body.changed[0].actual, sha256OfFile(target));
});

test('IT-EVD-105: the manifest of a run is readable through the API', async () => {
  const [code, body] = await req(`/api/runs/${runId}/manifest`);
  assert.equal(code, 200);
  assert.equal(body.manifest.runId, runId);
  assert.ok(body.manifest.artifacts.length > 0);
});

test('IT-EVD-106: the retention plan and the deduplication report are available', async () => {
  const [code, body] = await req('/api/evidence/retention');
  assert.equal(code, 200);
  assert.equal(body.days, 30);
  assert.ok(Array.isArray(body.expired));
  assert.ok(body.storeBytes >= 0);

  const [code2, body2] = await req('/api/evidence/dedup');
  assert.equal(code2, 200);
  assert.ok(body2.entries >= 0);
  assert.ok(body2.storeBytes >= 0);
});

test('IT-EVD-107: the cleaner refuses to run while the Bridge holds the directory', () => {
  // The Bridge IS running: it holds the data directory's lock, and the
  // cleaning must be refused.
  const cli = spawn(process.execPath, ['tools/evidence_retention.mjs', 'clean', '--data-dir', data, '--days', '0', '--yes'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  cli.stderr.on('data', (b) => { stderr += b.toString(); });
  const code = new Promise((resolve) => cli.on('close', resolve));
  return code.then((exit) => {
    assert.equal(exit, 3, `the cleaning must be refused while the Bridge runs: ${stderr}`);
    assert.match(stderr, /Bridge is running/);
  });
});

test('IT-EVD-108: the cleaning removes the evidence and keeps the run metadata', async () => {
  // The Bridge has to be stopped first: it holds the data directory's lock,
  // and the cleaning is refused while it runs (that is IT-EVD-006).
  cp.kill();
  await new Promise((r) => cp.on('close', r));

  const statePath = path.join(data, 'state.json');
  const stateBefore = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const runBefore = stateBefore.runs.find((r) => r.id === runId);
  assert.ok(runBefore, 'the run record must exist before the cleaning');
  assert.equal(runBefore.status, 'passed');
  assert.ok(runBefore.summary, 'the run record must carry its summary');
  assert.ok(runBefore.events.length > 0, 'the run record must carry its events');

  const runFolder = path.join(data, 'runs', runId);
  assert.ok(fs.existsSync(path.join(runFolder, 'report.json')), 'the evidence must exist before the cleaning');

  // The cleaning: every run is expired (a period of 0 days).
  const clean = spawn(process.execPath, ['tools/evidence_retention.mjs', 'clean', '--data-dir', data, '--days', '0', '--yes'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  clean.stdout.on('data', (b) => { stdout += b.toString(); });
  clean.stderr.on('data', (b) => { stderr += b.toString(); });
  const code = await new Promise((resolve) => clean.on('close', resolve));
  assert.equal(code, 0, `the cleaning must succeed: ${stderr}`);
  assert.match(stdout, /run records kept: \d+/);

  // THE EVIDENCE IS GONE.
  assert.equal(fs.existsSync(path.join(runFolder, 'report.json')), false, 'the report must be removed');
  assert.equal(fs.existsSync(path.join(runFolder, 'results')), false, 'the evidence folder must be removed');

  // THE RUN METADATA IS NOT. The state file still holds the run, with its
  // status, its summary, its attempts and its events.
  const stateAfter = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const runAfter = stateAfter.runs.find((r) => r.id === runId);
  assert.ok(runAfter, 'the run record must survive the cleaning');
  assert.equal(runAfter.status, 'passed');
  assert.equal(runAfter.summary.total, runBefore.summary.total);
  assert.equal(runAfter.events.length, runBefore.events.length);
  assert.equal(runAfter.attempts.length, runBefore.attempts.length);

  // The run's own record files -- the event log, the raw output and the
  // manifest -- stay in the run folder.
  assert.ok(fs.existsSync(path.join(runFolder, 'events.jsonl')), 'the event log must survive');
  assert.ok(fs.existsSync(path.join(runFolder, 'manifest.json')), 'the manifest must survive');

  // The journal says what was removed.
  const journal = spawn(process.execPath, ['tools/evidence_retention.mjs', 'journal', '--data-dir', data], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let journalOut = '';
  journal.stdout.on('data', (b) => { journalOut += b.toString(); });
  const journalCode = await new Promise((resolve) => journal.on('close', resolve));
  assert.equal(journalCode, 0);
  assert.match(journalOut, new RegExp(runId));
});

test('IT-EVD-109: the verification after the cleaning reports the cleaned evidence, not a tamper', async () => {
  const cli = spawn(process.execPath, ['tools/evidence_retention.mjs', 'verify', '--data-dir', data], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  cli.stdout.on('data', (b) => { stdout += b.toString(); });
  cli.stderr.on('data', (b) => { stderr += b.toString(); });
  const code = await new Promise((resolve) => cli.on('close', resolve));
  // ATS-209 review round 1 (E7): the evidence was cleaned by the
  // RETENTION POLICY, and the cleaning left a record of what it removed.
  // The verification says so -- it does NOT report the archive as
  // tampered with, and it does not exit 1: a cleaner that made the
  // tamper alarm permanently red would make the alarm worthless.
  assert.equal(code, 0, `a cleaned run must not be reported as a tamper: ${stdout}`);
  assert.match(stdout, /cleaned by the retention policy/);
  assert.doesNotMatch(stdout, /does NOT match its manifest/);
});

test('IT-EVD-111: a file removed WITHOUT a cleaning record is still a tamper', async () => {
  // The negative control of IT-EVD-109: a run that the cleaning did not
  // touch. A file that disappears from it is a discrepancy, and the
  // verification must still report it and exit 1 -- otherwise "cleaned"
  // would be a blanket excuse for any missing file.
  const folder = path.join(data, 'runs', 'run_1_0000000000000000000000ff');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
    version: 2,
    runId: 'run_1_0000000000000000000000ff',
    artifacts: [{ file: 'report.json', size: 2, sha256: 'ab'.repeat(32) }],
  }));
  const statePath = path.join(data, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.runs.push({ id: 'run_1_0000000000000000000000ff', status: 'passed', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const cli = spawn(process.execPath, ['tools/evidence_retention.mjs', 'verify', '--data-dir', data], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  cli.stdout.on('data', (b) => { out += b.toString(); });
  await new Promise((resolve) => cli.on('close', resolve));
  assert.match(out, /does NOT match its manifest/);
  assert.match(out, /missing: report\.json/);
});

test('IT-EVD-110: the temporary directory is removed', () => {
  fs.rmSync(dir, { recursive: true, force: true });
});
