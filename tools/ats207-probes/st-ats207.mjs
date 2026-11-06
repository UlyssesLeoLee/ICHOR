/**
 * ATS-207 system test: single instance and crash recovery, end to end, with
 * real Bridge processes and a REAL Playwright run (Chromium).
 *
 *   node tools/ats207-probes/st-ats207.mjs <repo> <scratch-dir> <playwright-node_modules>
 *
 * <playwright-node_modules> is a node_modules directory with @playwright/test
 * installed (e.g. examples/sample-playwright/node_modules of a checkout where
 * `npm ci` ran); it is linked into a copy of examples/sample-playwright.
 *
 * ST-025  a second Bridge on the same data directory is refused while the
 *         first serves; of two Bridges started together exactly one serves.
 * ST-017  the whole Bridge process tree is killed while a real Playwright run
 *         is in flight; the next Bridge takes over the lock, the run is
 *         `interrupted` (not passed), the finished run before it keeps its
 *         results, and the mirror matches the state file.
 * ST-026  damaged files after a crash: a zero-length state file is refused
 *         and left untouched; a damaged mirror is moved aside and rebuilt.
 *
 * Prints `PASS`/`FAIL` per check and `RESULT: <passed>/<total>`; exits 0 only
 * when every check passed. No port literal: every Bridge gets a free port.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [repoArg, scratchArg, nodeModulesArg] = process.argv.slice(2);
if (!repoArg || !scratchArg || !nodeModulesArg) {
  console.error('usage: st-ats207.mjs <repo> <scratch-dir> <playwright-node_modules>');
  process.exit(2);
}
const repo = path.resolve(repoArg);
const { freePort } = await import(pathToFileURL(path.join(repo, 'tests', 'helpers', 'free-port.mjs')).href);
const { openDatabase } = await import(pathToFileURL(path.join(repo, 'server', 'sqlite', 'db.mjs')).href);
const { verifyMirror } = await import(pathToFileURL(path.join(repo, 'server', 'sqlite', 'import.mjs')).href);

fs.mkdirSync(scratchArg, { recursive: true });
const scratch = fs.mkdtempSync(path.join(path.resolve(scratchArg), 'st207-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let total = 0;
const check = (id, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` -- ${detail}` : ''}`);
};

/* --- the project: the sample fixture plus a case that runs for a minute --- */
const project = path.join(scratch, 'sample-playwright');
fs.cpSync(path.join(repo, 'examples', 'sample-playwright'), project, { recursive: true, filter: (src) => !src.includes('node_modules') });
fs.symlinkSync(path.resolve(nodeModulesArg), path.join(project, 'node_modules'), 'junction');
fs.writeFileSync(path.join(project, 'tests', 'slow.spec.ts'),
  "import { test } from '@playwright/test';\n" +
  "test('长时间运行的用例', async ({ page }) => {\n  await page.setContent('<p>running</p>');\n  await page.waitForTimeout(60000);\n});\n");

const bridges = new Set();
async function startBridge(dataDir, env = {}) {
  const port = await freePort();
  const cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: repo, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: dataDir, ...env }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  bridges.add(cp);
  let stderr = '';
  cp.stderr.on('data', (b) => { stderr += b; });
  const exited = new Promise((r) => cp.on('close', (code) => { bridges.delete(cp); r(code); }));
  return { cp, port, exited, stderr: () => stderr };
}
async function killTree(cp) {
  if (cp.exitCode !== null || cp.signalCode !== null) return;
  const closed = new Promise((r) => cp.once('close', r));
  if (process.platform === 'win32') await new Promise((r) => spawn('taskkill', ['/PID', String(cp.pid), '/T', '/F'], { windowsHide: true }).on('close', r));
  else cp.kill('SIGKILL');
  await Promise.race([closed, sleep(10000)]);
}
async function up(b, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (b.cp.exitCode !== null) return false;
    try { if ((await fetch(`http://127.0.0.1:${b.port}/api/health`)).ok) return true; } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}
const exitWithin = (b, ms) => Promise.race([b.exited, sleep(ms).then(() => 'running')]);
async function api(b, endpoint, method = 'GET', body, token) {
  const r = await fetch(`http://127.0.0.1:${b.port}${endpoint}`, {
    method, headers: token ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  return [r.status, await r.json()];
}
const lockPid = (dataDir) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'bridge.lock'), 'utf8')).pid; } catch { return null; } };
function mirrorMatches(dataDir) {
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  const db = openDatabase(path.join(dataDir, 'metadata.db'));
  try {
    const quick = db.prepare('PRAGMA quick_check').get().quick_check;
    return { quick, mirror: verifyMirror(db, state).ok };
  } finally { db.close(); }
}

try {
  const data = path.join(scratch, 'data');

  /* ---------------- ST-025: single instance ---------------- */
  const a = await startBridge(data);
  check('ST-025a first Bridge serves', await up(a), a.stderr());
  const b = await startBridge(data);
  const bCode = await exitWithin(b, 30000);
  check('ST-025b second Bridge on the same data directory exits 1', bCode === 1, `exit=${bCode}`);
  check('ST-025c the refusal names the lock and the holder', /holds the data directory lock/.test(b.stderr()) && b.stderr().includes(`pid ${a.cp.pid}`), b.stderr().split('\n')[1] ?? '');
  check('ST-025d the first Bridge still serves', await up(a, 2000));
  const data2 = path.join(scratch, 'data-simultaneous');
  const [s1, s2] = await Promise.all([startBridge(data2), startBridge(data2)]);
  const loser = await Promise.race([s1.exited.then(() => s1), s2.exited.then(() => s2), sleep(40000).then(() => null)]);
  const winner = loser === s1 ? s2 : s1;
  check('ST-025e of two Bridges started together exactly one serves', loser !== null && loser.cp.exitCode === 1 && await up(winner) && lockPid(data2) === winner.cp.pid,
    loser ? `refused pid ${loser.cp.pid}, serving pid ${winner.cp.pid}` : 'both kept running');
  await killTree(s1.cp); await killTree(s2.cp);

  /* ---------------- ST-017: kill the whole tree mid-run ---------------- */
  const token = (await api(a, '/api/session'))[1].token;
  const [, added] = await api(a, '/api/projects', 'POST', { path: project }, token);
  const projectId = added.project.id;
  const [, first] = await api(a, `/api/projects/${projectId}/run`, 'POST', { file: 'tests/home.spec.ts' }, token);
  let finished = null;
  for (let i = 0; i < 600; i++) {
    const run = (await api(a, `/api/runs/${first.run.id}`, 'GET', null, token))[1].run;
    if (['passed', 'failed', 'error', 'cancelled', 'interrupted'].includes(run.status)) { finished = run; break; }
    await sleep(250);
  }
  check('ST-017a a real Playwright run finishes before the crash', finished?.status === 'failed' && finished?.summary?.passed === 1 && finished?.summary?.failed === 1,
    `status=${finished?.status} summary=${JSON.stringify(finished?.summary)}`);
  const [, slow] = await api(a, `/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, token);
  let inFlight = false;
  for (let i = 0; i < 200 && !inFlight; i++) {
    inFlight = (await api(a, `/api/runs/${slow.run.id}`, 'GET', null, token))[1].run.status === 'running';
    if (!inFlight) await sleep(100);
  }
  await sleep(4000); // Chromium is up and the case is waiting
  check('ST-017b the second run is in flight', inFlight);
  await killTree(a.cp);
  check('ST-017c the crash left the lock behind', lockPid(data) === a.cp.pid);
  const c = await startBridge(data);
  check('ST-017d the next Bridge takes over the stale lock and serves', await up(c) && lockPid(data) === c.cp.pid, c.stderr());
  const token2 = (await api(c, '/api/session'))[1].token;
  const slowAfter = (await api(c, `/api/runs/${slow.run.id}`, 'GET', null, token2))[1].run;
  check('ST-017e the run in flight is interrupted, not finished', slowAfter.status === 'interrupted', `status=${slowAfter.status}`);
  const firstAfter = (await api(c, `/api/runs/${first.run.id}`, 'GET', null, token2))[1].run;
  check('ST-017f the finished run keeps its results', firstAfter.status === 'failed' && JSON.stringify(firstAfter.summary) === JSON.stringify(finished.summary));
  const replay = (await api(c, `/api/runs/${slow.run.id}/replay`, 'GET', null, token2))[1];
  check('ST-017g the event log replays to interrupted', replay.replayedStatus === 'interrupted' && replay.agrees === true);
  const m1 = mirrorMatches(data);
  check('ST-017h the mirror is sound and matches the state file', m1.quick === 'ok' && m1.mirror === true, JSON.stringify(m1));
  await killTree(c.cp);

  /* ---------------- ST-026: damaged files after a crash ---------------- */
  const damaged = path.join(scratch, 'data-empty-state');
  fs.cpSync(data, damaged, { recursive: true });
  fs.rmSync(path.join(damaged, 'bridge.lock'), { force: true });
  fs.writeFileSync(path.join(damaged, 'state.json'), '');
  const d = await startBridge(damaged);
  const dCode = await exitWithin(d, 30000);
  check('ST-026a a zero-length state file is refused', dCode === 1 && /STATE_CORRUPT/.test(d.stderr()), `exit=${dCode}`);
  check('ST-026b the refused state file is left untouched', fs.statSync(path.join(damaged, 'state.json')).size === 0);
  fs.writeFileSync(path.join(data, 'metadata.db'), 'damaged by the crash '.repeat(300));
  const e = await startBridge(data);
  check('ST-026c a Bridge starts over a damaged mirror and quarantines it', await up(e) && /quarantined/.test(e.stderr()), e.stderr().split('\n').find((l) => /mirror/.test(l)) ?? '');
  const m2 = mirrorMatches(data);
  check('ST-026d the rebuilt mirror matches the state file', m2.quick === 'ok' && m2.mirror === true, JSON.stringify(m2));
  const token3 = (await api(e, '/api/session'))[1].token;
  const runs = (await api(e, `/api/runs/${first.run.id}`, 'GET', null, token3))[1].run;
  check('ST-026e the history is intact after the rebuild', runs.status === 'failed');
  await killTree(e.cp);
} catch (err) {
  check('ST-ats207 probe ran to the end', false, err.stack);
} finally {
  for (const cp of bridges) await killTree(cp);
  console.log(`scratch: ${scratch}`);
  console.log(`RESULT: ${passed}/${total}`);
  process.exitCode = passed === total ? 0 : 1;
}
