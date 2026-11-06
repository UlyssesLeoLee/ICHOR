#!/usr/bin/env node
/**
 * ATS-201: the counterexamples of the SECOND review (comment
 * 01a1ac07-70e8-7c89-afd4-2b52d85cd5f3), as an executable probe.
 *
 * The reviewer's own script (ce2.mjs) reproduces the three situations and
 * prints what happens. This script runs the SAME situations against the
 * product code and ASSERTS the required outcome, so it fails on a tree that
 * has the defect back:
 *
 *   CE7 -- two cases with the same title in one file; after a line shift the
 *          reported case must not be bound to the OTHER case's uid.
 *   CE8 -- a case whose file is absent from one discovery keeps its uid when
 *          the file comes back.
 *   L1  -- a lock whose pid was reused must not keep the Bridge from starting,
 *          and a lock of unknown identity must produce recovery steps.
 *
 * The situations are the reviewer's; the assertions are this repository's.
 *
 * Usage: node tools/ats201-probes/review-round2-regressions.mjs [tree-root]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const T = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const imp = (p) => import('file:///' + path.join(T, p).replace(/\\/g, '/'));
const core = await imp('server/core.mjs');
const uid = await imp('server/uid.mjs');

let checks = 0;
let failures = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!cond) failures++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats201-r2-'));
const root = path.join(tmp, 'proj');
fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
const project = { id: uid.projectUidFor(root), root };
const P = project.id;
const write = (name, src) => fs.writeFileSync(path.join(root, 'tests', name), src);
let registry = uid.emptyRegistry();
const discover = () => { const c = core.discoverStatic(project, registry); registry = c.registry; return c.tests; };
const bind = (cases) => core.attemptsForRun(
  { id: 'run_1_' + '0'.repeat(24), projectUid: P, projectRoot: root },
  { cases: cases.map((c) => ({ retry: 0, status: 'expected', ...c })), rootDir: path.join(root, 'tests') },
  registry
).map((a) => [a.title, a.line, a.testUid, a.uidBasis]);

/* ------------------------------------------------------------------ */
/* CE7 -- a same-titled case must not be bound to the other case        */
/* ------------------------------------------------------------------ */
console.log('--- CE7: a line shift does not make a case borrow the other uid ---');
{
  const src = (pad) => "import {test} from '@playwright/test';\n" + '\n'.repeat(pad) +
    "test.describe('login', () => {\n  test('works', async () => { await 1; });\n});\n" +
    "test.describe('logout', () => {\n  test('works', async () => { await 2; });\n});\n";
  write('d.spec.ts', src(0));
  const found = discover();
  const login = found[0];
  const logout = found[1];
  ok('CE7 the two same-titled cases have different uids', login.uid !== logout.uid,
    `${login.uid} vs ${logout.uid}`);

  // Three lines are inserted at the top: login/works moves to line 6, which
  // is where logout/works used to sit.
  write('d.spec.ts', src(3));
  const [attempt] = bind([{ file: 'd.spec.ts', title: 'works', line: 6 }]);
  ok('CE7 the shifted case is not bound to the other case', attempt[2] !== logout.uid,
    `bound ${attempt[2]} (logout is ${logout.uid})`);
  ok('CE7 the shifted case keeps its own uid', attempt[2] === login.uid, `bound ${attempt[2]}`);
  ok('CE7 the basis names the body fingerprint', attempt[3] === 'file-title-body', attempt[3]);
}

/* ------------------------------------------------------------------ */
/* CE8 -- a file that is absent does not delete its cases              */
/* ------------------------------------------------------------------ */
console.log('--- CE8: a case keeps its uid while its file is absent ---');
{
  registry = uid.emptyRegistry();
  fs.rmSync(path.join(root, 'tests', 'd.spec.ts'));
  write('c.spec.ts', "import {test} from '@playwright/test';\ntest('checkout works', async () => { await 3; });\n");
  const u0 = discover()[0].uid;
  write('c.spec.ts', "import {test} from '@playwright/test';\ntest('checkout flow works', async () => { await 3; });\n");
  const u1 = discover()[0].uid;
  ok('CE8 the retitled case keeps its uid', u0 === u1, `${u0} vs ${u1}`);

  // The file is gone for one discovery -- a branch that does not contain it.
  fs.renameSync(path.join(root, 'tests', 'c.spec.ts'), path.join(tmp, 'c.spec.ts.away'));
  write('other.spec.ts', "import {test} from '@playwright/test';\ntest('other', async () => { await 9; });\n");
  discover();
  const kept = registry.projects[P].entries.map((e) => e.uid);
  ok('CE8 the entry of the absent file is kept', kept.includes(u0), kept.join(', '));

  // The file comes back.
  fs.renameSync(path.join(tmp, 'c.spec.ts.away'), path.join(root, 'tests', 'c.spec.ts'));
  const back = discover().find((t) => t.file.endsWith('c.spec.ts'));
  ok('CE8 the case comes back with the same uid', back.uid === u0, `${back.uid} vs ${u0}`);
  ok('CE8 the case comes back through the registry', back.uidSource === 'registry', back.uidSource);
}

/* ------------------------------------------------------------------ */
/* L1 -- the holder of the lock is verifiable                           */
/* ------------------------------------------------------------------ */
console.log('--- L1: a lock whose pid was reused does not block the Bridge ---');
{
  const data = path.join(tmp, 'data');
  fs.mkdirSync(data, { recursive: true });
  // The pid is alive -- it is this very process -- but the recorded start time
  // belongs to another process: the operating system reused the pid.
  const foreign = core.processStartTime(process.pid);
  fs.writeFileSync(path.join(data, 'bridge.lock'), JSON.stringify({
    pid: process.pid,
    startedAt: '2026-01-01T00:00:00Z',
    processStartedAt: foreign === null ? 'not-a-real-start-time' : '2001-01-01T00:00:00.0000000Z'
  }));

  const cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: T,
    env: { ...process.env, ATS_PORT: '0', ATS_DATA_DIR: data },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let err = '';
  cp.stderr.on('data', (b) => { err += b.toString(); });
  const code = await new Promise((r) => {
    cp.on('exit', r);
    setTimeout(() => { cp.kill(); r('still running'); }, 20000);
  });
  ok('L1 the Bridge starts despite the reused pid', code === 'still running', `exit ${code}: ${err.slice(0, 120)}`);
  cp.kill();
  await new Promise((r) => setTimeout(r, 500));
}

console.log('--- L1: a lock of unknown identity produces recovery steps ---');
{
  const data = path.join(tmp, 'data2');
  fs.mkdirSync(data, { recursive: true });
  // The pid is alive, but the lock says nothing about WHICH process it is.
  fs.writeFileSync(path.join(data, 'bridge.lock'), JSON.stringify({
    pid: process.pid,
    startedAt: '2026-01-01T00:00:00Z'
  }));
  const cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: T,
    env: { ...process.env, ATS_PORT: '0', ATS_DATA_DIR: data },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let err = '';
  cp.stderr.on('data', (b) => { err += b.toString(); });
  const code = await new Promise((r) => { cp.on('exit', r); setTimeout(() => { cp.kill(); r('still running'); }, 20000); });
  ok('L1 the Bridge refuses to start', code !== 'still running', `exit ${code}`);
  ok('L1 the refusal names the lock', /holds the data directory lock/.test(err), err.slice(0, 160));
  ok('L1 the refusal states the recovery step', /delete the lock file/i.test(err), err.slice(0, 300));
  ok('L1 the refusal states the check first', /no Bridge is running/i.test(err), err.slice(0, 300));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(`checks: ${checks}, failures: ${failures}`);
if (failures) {
  console.log('RESULT: FAILED -- the second round of review counterexamples is not fixed.');
  process.exit(1);
}
console.log('RESULT: OK -- every second-round review counterexample behaves as required.');
