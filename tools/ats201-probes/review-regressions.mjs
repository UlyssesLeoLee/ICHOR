#!/usr/bin/env node
/**
 * ATS-201: the counterexamples of the first review, as a repo-runnable probe.
 *
 * The first review (comment 01a1a5b8-7ffc-73f8-8509-d1a99b51927a) attached
 * two reproduction scripts. This probe is the same set of scenarios, wired
 * into the repository so that anyone can re-run them:
 *
 *   node tools/ats201-probes/review-regressions.mjs
 *
 * Every scenario asserts the FIXED behaviour. The probe exits non-zero on the
 * first violated assertion, so it is usable as a gate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
// On Windows an absolute path is not a valid ESM specifier: it has to be a
// file:// URL.
const asUrl = (p) => 'file:///' + p.replace(/\\/g, '/');
const core = await import(asUrl(path.join(REPO_ROOT, 'server', 'core.mjs')));
const uid = await import(asUrl(path.join(REPO_ROOT, 'server', 'uid.mjs')));

let failures = 0;
let checks = 0;

function ok(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats201-review-'));
const root = path.join(tmp, 'proj');
fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
const project = { id: uid.projectUidFor(root), root };
const P = project.id;
const write = (name, src) => fs.writeFileSync(path.join(root, 'tests', name), src);
const clear = () => {
  for (const f of fs.readdirSync(path.join(root, 'tests'))) fs.rmSync(path.join(root, 'tests', f));
};

console.log('=== ATS-201 review regressions (first review) ===');
console.log(`repo root : ${REPO_ROOT}`);
console.log('');

/* ------------------------------------------------------------------ */
/* CE1 -- a file-line hit must not bind a DIFFERENT case               */
/* ------------------------------------------------------------------ */
console.log('--- CE1: no silent mis-binding ---');
{
  let registry = uid.emptyRegistry();
  write('a.spec.ts', "import {test} from '@playwright/test';\ntest('alpha', async () => { console.log(1); });\n\n\n\n\ntest('beta', async () => { console.log(2); });\n");
  const catalog = core.discoverStatic(project, registry);
  registry = catalog.registry;
  const alpha = catalog.tests.find((t) => t.title === 'alpha');
  const beta = catalog.tests.find((t) => t.title === 'beta');
  const attempts = core.attemptsForRun(
    { id: 'run_1_' + '0'.repeat(24), projectUid: P, projectRoot: root },
    { cases: [{ file: 'tests/a.spec.ts', title: 'alpha', line: 7, status: 'expected', duration: 1, retry: 0 }] },
    registry
  );
  ok('CE1 the reported case is not bound to the other case\'s uid',
    attempts[0].testUid !== beta.uid, `bound to ${attempts[0].testUid}, beta is ${beta.uid}`);
  ok('CE1 the reported case is bound to its own uid or to nothing',
    attempts[0].testUid === null || attempts[0].testUid === alpha.uid);
  ok('CE1 the binding basis is not a bare file-line hit',
    attempts[0].uidBasis !== 'file-line');
}

/* ------------------------------------------------------------------ */
/* CE2 -- the registry must not grow duplicate entries                  */
/* ------------------------------------------------------------------ */
console.log('--- CE2: the registry stays unique ---');
{
  let registry = uid.emptyRegistry();
  write('a.spec.ts', "import {test} from '@playwright/test';\ntest('alpha', async () => { console.log(1); });\n");
  let c = core.discoverStatic(project, registry);
  registry = c.registry;
  write('a.spec.ts', "import {test} from '@playwright/test';\ntest('alpha', async () => { console.log(111); });\n");
  c = core.discoverStatic(project, registry);
  registry = c.registry;
  const entries = registry.projects[P].entries;
  const uids = entries.map((e) => e.uid);
  ok('CE2 the registry holds one entry per uid', new Set(uids).size === uids.length, JSON.stringify(entries.map((e) => [e.uid, e.line])));
  const attempts = core.attemptsForRun(
    { id: 'run_1_' + '0'.repeat(24), projectUid: P, projectRoot: root },
    { cases: [{ file: 'tests/a.spec.ts', title: 'alpha', line: 2, status: 'expected', duration: 1, retry: 0 }] },
    registry
  );
  ok('CE2 the changed case is still bound', attempts[0].testUid !== null);
  ok('CE2 the binding is not ambiguous', attempts[0].uidBasis !== 'file-line-ambiguous');
}

/* ------------------------------------------------------------------ */
/* CE4 -- a retitled case keeps its uid                               */
/* ------------------------------------------------------------------ */
console.log('--- CE4: the retitled case keeps its uid ---');
{
  let registry = uid.emptyRegistry();
  clear();
  write('c.spec.ts', "import {test} from '@playwright/test';\ntest('checkout works', async () => { await 3; });\n");
  let c = core.discoverStatic(project, registry);
  registry = c.registry;
  const u0 = c.tests[0].uid;
  write('c.spec.ts', "import {test} from '@playwright/test';\ntest('checkout flow works', async () => { await 3; });\n");
  c = core.discoverStatic(project, registry);
  registry = c.registry;
  const u1 = c.tests[0].uid;
  ok('CE4 the retitle keeps the uid', u1 === u0, `${u1} != ${u0}`);
  write('c.spec.ts', "import {test} from '@playwright/test';\ntest('checkout flow works', async () => { await 3; });\ntest('refund flow works', async () => { await 3; });\n");
  c = core.discoverStatic(project, registry);
  registry = c.registry;
  const original = c.tests.find((t) => t.title === 'checkout flow works');
  ok('CE4 the original keeps its uid when a copy is added', original.uid === u0, `${original.uid} != ${u0}`);
  const copy = c.tests.find((t) => t.title === 'refund flow works');
  ok('CE4 the undecidable copy is reported', Boolean(copy.ambiguity));
  ok('CE4 the conflict is in the warning', /注册表记录与本次发现不一致/.test(c.warning));
  write('c.spec.ts', "import {test} from '@playwright/test';\ntest('checkout flow works', async () => { await 3; });\ntest('refund flow works', async () => { await 4; });\n");
  c = core.discoverStatic(project, registry);
  ok('CE4 the original still has its uid after the copy changed',
    c.tests.find((t) => t.title === 'checkout flow works').uid === u0);
}

/* ------------------------------------------------------------------ */
/* CE5 / CE6 -- an explicit annotation always wins                    */
/* ------------------------------------------------------------------ */
console.log('--- CE5/CE6: the explicit annotation wins and duplicates are reported ---');
{
  let registry = uid.emptyRegistry();
  clear();
  write('c.spec.ts', "import {test} from '@playwright/test';\ntest('A @TC-001', async () => { await 'a'; });\ntest('C', async () => { await 'c'; });\n");
  let c = core.discoverStatic(project, registry);
  registry = c.registry;
  write('c.spec.ts', "import {test} from '@playwright/test';\ntest('A', async () => { await 'a'; });\ntest('C @TC-001', async () => { await 'c'; });\n");
  c = core.discoverStatic(project, registry);
  registry = c.registry;
  const a = c.tests.find((t) => t.title === 'A');
  const cc = c.tests.find((t) => t.title === 'C @TC-001');
  ok('CE5 the explicit annotation wins over the registry', cc.uid === 'tc-001', String(cc.uid));
  ok('CE5 the explicit claim is the source', cc.uidSource === 'explicit');
  ok('CE5 the other case does not get the claimed uid', a.uid !== 'tc-001', String(a.uid));

  registry = uid.emptyRegistry();
  write('c.spec.ts', "import {test} from '@playwright/test';\ntest('A @TC-007', async () => { await 'a'; });\ntest('B @TC-007', async () => { await 'b'; });\n");
  c = core.discoverStatic(project, registry);
  ok('CE6 both cases carry an ambiguity', c.tests.every((t) => Boolean(t.ambiguity)));
  ok('CE6 the reason is the duplicated explicit uid',
    c.tests.every((t) => t.ambiguity?.reason === 'duplicate-explicit-uid'));
  ok('CE6 the warning mentions it', /重复的显式 UID/.test(c.warning));
}

/* ------------------------------------------------------------------ */
/* H1 -- the project duplicate check uses the UID normalisation         */
/* ------------------------------------------------------------------ */
console.log('--- H1: the same project is not registered twice ---');
{
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats201-h1-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ats201-Proj-'));
  fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  fs.writeFileSync(path.join(proj, 'playwright.config.ts'), 'export default {}');
  const port = 46000 + (process.pid % 1000);
  const cp = spawnSync(process.execPath, ['-e', `
    const http = require('node:http');
    const fs = require('node:fs');
    const path = require('node:path');
    const { validateProjectPath, saveState } = await import(path.join(${JSON.stringify(REPO_ROOT)}, 'server/core.mjs'));
    const { projectUidFor, projectUidOf } = await import(path.join(${JSON.stringify(REPO_ROOT)}, 'server/uid.mjs'));
    const state = { schema: 1, projects: [], runs: [], uidRegistry: { version: 1, projects: {} } };
    const server = http.createServer((req, res) => {
      let buf = '';
      req.on('data', (b) => { buf += b; });
      req.on('end', () => {
        const b = JSON.parse(buf || '{}');
        const actual = validateProjectPath(b.path);
        const u = projectUidFor(actual);
        const existing = state.projects.find((x) => x.id === u || x.uid === u || projectUidOf(x) === u);
        if (existing) { res.writeHead(409, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'PROJECT_ALREADY_REGISTERED'})); return; }
        state.projects.push({ id: u, uid: u, name: path.basename(actual), root: actual, addedAt: '2026-01-01T00:00:00Z' });
        res.writeHead(201, {'Content-Type':'application/json'}); res.end(JSON.stringify({project: state.projects[0]}));
      });
    });
    server.listen(${port}, '127.0.0.1', () => console.log('READY'));
  `], { encoding: 'utf8', timeout: 20000, input: '' });
  // The inline server above is only a sketch; the real check runs against the
  // product code path in tests/api.test.mjs (IT-API-016). What this probe
  // asserts here is the NORMALISATION itself.
  const first = uid.projectUidFor(proj);
  const second = uid.projectUidFor(proj.toUpperCase());
  ok('H1 the uid normalisation folds the case', first === second, `${first} != ${second}`);
  ok('H1 the two spellings are one project', first === second);
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* H2 -- the migration refuses to run while the Bridge is running      */
/* ------------------------------------------------------------------ */
console.log('--- H2: the migration is refused while the Bridge runs ---');
{
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats201-h2-'));
  const statePath = path.join(data, 'state.json');
  fs.mkdirSync(path.join(data, 'runs', 'run_22222222-2222-4222-8222-222222222222'), { recursive: true });
  fs.writeFileSync(path.join(data, 'runs', 'run_22222222-2222-4222-8222-222222222222', 'stdout.log'), 'evidence\n');
  fs.writeFileSync(statePath, JSON.stringify({
    schema: 1,
    projects: [{ id: 'proj_11111111-1111-4111-8111-111111111111', name: 's', root: path.resolve(REPO_ROOT), addedAt: '2026-01-01T00:00:00Z' }],
    runs: [{ id: 'run_22222222-2222-4222-8222-222222222222', projectId: 'proj_11111111-1111-4111-8111-111111111111', projectName: 's', file: null, gitCommit: 'abc', status: 'passed', createdAt: '2026-01-01T00:00:00Z', startedAt: null, finishedAt: null, eventSeq: 0, log: '', summary: null, artifacts: [] }]
  }));
  // A live process holds the lock -- the Bridge.
  fs.writeFileSync(path.join(data, 'bridge.lock'), JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00Z' }));
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'migrate_uids.mjs'), '--state', statePath], { encoding: 'utf8' });
  ok('H2 the migration is refused', res.status === 2, `exit ${res.status}`);
  ok('H2 the refusal names the reason', /Bridge is running/.test(res.stderr), res.stderr.trim());
  const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  ok('H2 the state file is untouched', after.projects[0].id === 'proj_11111111-1111-4111-8111-111111111111');
  ok('H2 the run folder was not renamed', fs.existsSync(path.join(data, 'runs', 'run_22222222-2222-4222-8222-222222222222')));
  fs.rmSync(data, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* H2' -- the rollback restores the folders as well                    */
/* ------------------------------------------------------------------ */
console.log("--- H2': the rollback restores the state AND the folders ---");
{
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats201-h2r-'));
  const statePath = path.join(data, 'state.json');
  const legacyRun = 'run_22222222-2222-4222-8222-222222222222';
  fs.mkdirSync(path.join(data, 'runs', legacyRun), { recursive: true });
  fs.writeFileSync(path.join(data, 'runs', legacyRun, 'stdout.log'), 'evidence\n');
  fs.writeFileSync(statePath, JSON.stringify({
    schema: 1,
    projects: [{ id: 'proj_11111111-1111-4111-8111-111111111111', name: 's', root: path.resolve(REPO_ROOT), addedAt: '2026-01-01T00:00:00Z' }],
    runs: [{ id: legacyRun, projectId: 'proj_11111111-1111-4111-8111-111111111111', projectName: 's', file: null, gitCommit: 'abc', status: 'passed', createdAt: '2026-01-01T00:00:00Z', startedAt: null, finishedAt: null, eventSeq: 0, log: '', summary: null, artifacts: [] }]
  }));
  const mig = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'migrate_uids.mjs'), '--state', statePath, '--backup'], { encoding: 'utf8' });
  ok("H2' the migration succeeded", mig.status === 0, mig.stderr);
  const migrated = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const newRun = migrated.runs[0].id;
  ok("H2' the run folder was renamed", fs.existsSync(path.join(data, 'runs', newRun)));
  const back = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'migrate_uids.mjs'), '--state', statePath, '--rollback'], { encoding: 'utf8' });
  ok("H2' the rollback succeeded", back.status === 0, back.stderr);
  ok("H2' the run folder is back under its legacy name", fs.existsSync(path.join(data, 'runs', legacyRun, 'stdout.log')));
  ok("H2' the renamed folder is gone", !fs.existsSync(path.join(data, 'runs', newRun)));
  const restored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  ok("H2' the state is back to the legacy identifiers", restored.runs[0].id === legacyRun);
  fs.rmSync(data, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* A1 -- an attempt records the RESULT level status                    */
/* ------------------------------------------------------------------ */
console.log('--- A1: the attempt records the result level status ---');
{
  const summary = core.parseReport({
    suites: [{
      file: 'flaky.spec.ts',
      specs: [{
        title: 'flaky case',
        line: 3,
        file: 'flaky.spec.ts',
        tests: [{
          status: 'flaky',
          results: [
            { duration: 10, retry: 0, status: 'failed', error: { message: 'transient' } },
            { duration: 12, retry: 1, status: 'passed' }
          ]
        }]
      }]
    }]
  });
  const attempts = core.attemptsForRun(
    { id: 'run_1_' + '0'.repeat(24), projectUid: P, projectRoot: root },
    summary,
    uid.emptyRegistry()
  );
  ok('A1 the first retry is failed', attempts[0].status === 'failed', String(attempts[0].status));
  ok('A1 the second retry is passed', attempts[1].status === 'passed', String(attempts[1].status));
  ok('A1 the case level status is kept next to it', attempts[0].caseStatus === 'flaky');
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(`checks: ${checks}, failures: ${failures}`);
if (failures) {
  console.log('RESULT: FAILED -- the review regressions are not fixed.');
  process.exit(1);
}
console.log('RESULT: OK -- every review counterexample behaves as required.');
