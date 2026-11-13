#!/usr/bin/env node
/**
 * ATS-214 (review round 1, items 4 and 5): the INTEGRATION tests of the
 * BATCH's request context and of the batch's terminal states.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The first delivery shipped a batch chain that ran the first file of a
 * selection and then the second, and the reviewer found three defects
 * that the tests of that delivery did not catch:
 *
 *   * the SECOND file of the batch ran WITHOUT the environment profile
 *     the first one ran with -- the very "silent fallback to no profile"
 *     ATS-212 forbids, spread over two runs;
 *   * a file that the ATS-106 filter check refuses was REFUSED when it
 *     was selected alone but ACCEPTED when it was selected together with
 *     another file, so the batch died half-way through;
 *   * a batch could stay `running` for ever -- after a failed preflight,
 *     after a refused file, and after the Bridge was killed mid-batch.
 *
 * A test suite that cannot fail is not evidence, so each of those three
 * gets a test HERE, and each test drives the REAL Bridge over HTTP with
 * the REAL Playwright engine.
 *
 * WHAT IS MEASURED
 * -----------------
 *   1. THE CONTEXT IS INHERITED: run #2 of the batch carries the same
 *      environment profile (and the same runner / capabilities) as run #1,
 *      and the engine really saw the profile's variable.
 *   2. EVERY GROUP IS VALIDATED BEFORE ANYTHING RUNS: a selection that
 *      contains a refused file is refused as a WHOLE, with the same code
 *      the single-file path uses.
 *   3. THE BATCH ALWAYS REACHES A TERMINAL STATUS: after a failed
 *      preflight, after a refused file, and after the Bridge was killed
 *      while the batch was in flight.
 *
 * The REAL PLAYWRIGHT
 * -------------------
 * The runs really execute, so the fixture needs a `node_modules`. The
 * real CLI of the repository (the example project's dependency tree) is
 * linked into the fixture as a JUNCTION -- the same trick the
 * ATS-202/ATS-203/ATS-214 API tests use. Nothing is installed here.
 *
 * When no real CLI is reachable, the cases that need it are SKIPPED with a
 * reason -- never reported as a pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { freePort } from './helpers/free-port.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-214-batch-'));
const DATA = path.join(WORK, 'data');
const port = await freePort();

function findPlaywrightModules() {
  const candidates = [
    process.env.ATS214_PLAYWRIGHT_MODULES,
    path.join(REPO_ROOT, 'examples', 'sample-playwright', 'node_modules'),
    'D:/ICHOR/examples/sample-playwright/node_modules',
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, '@playwright', 'test', 'cli.js'))) return dir;
  }
  return null;
}
const PLAYWRIGHT_MODULES = findPlaywrightModules();
const SKIP = PLAYWRIGHT_MODULES ? false : 'the real @playwright/test could not be reached';

/* ------------------------------------------------------------------ */
/* The fixtures                                                        */
/* ------------------------------------------------------------------ */

/**
 * A project with two files whose cases write down the BASE_URL they saw.
 *
 * The recording is the MEASUREMENT: it is how a test can tell that the
 * second file of a batch really ran under the environment profile and
 * not under a silent default.
 */
function makeProject(name, { link = true, files = null } = {}) {
  const root = path.join(WORK, name);
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: `fx-${name}`, private: true }));
  fs.writeFileSync(
    path.join(root, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0, workers: 1 });\n"
  );
  // The recording file is written BY the tests, so it must be ignored by
  // git -- otherwise the fixture's repository is dirty and the Bridge
  // reports a dirty project.
  fs.writeFileSync(path.join(root, '.gitignore'), 'env-seen.txt\n');
  const seen = path.join(root, 'env-seen.txt').replace(/\\/g, '/');
  const rec = (label) => `test('${label}', async () => { fs.appendFileSync('${seen}', '${label}=' + (process.env.BASE_URL ?? '<unset>') + '\\n'); });`;
  const spec = (labels) => [
    "import { test } from '@playwright/test';",
    "import fs from 'node:fs';",
    ...labels.map(rec),
    '',
  ].join('\n');
  for (const [rel, content] of Object.entries(files ?? {
    'tests/a.spec.ts': spec(['a1', 'a2']),
    'tests/b.spec.ts': spec(['b1']),
  })) {
    fs.writeFileSync(path.join(root, rel), content);
  }
  if (link && PLAYWRIGHT_MODULES) {
    try { fs.symlinkSync(PLAYWRIGHT_MODULES, path.join(root, 'node_modules'), 'junction'); } catch { /* reported by the test */ }
  }
  // The Bridge needs a GIT project: it reads the commit off the repository.
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=r', '-c', 'user.email=r@x', 'add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'fx'], { cwd: root });
  } catch { /* the test that needs the commit says so */ }
  return root;
}

const BATCH = makeProject('batch');
// A project WITHOUT the engine: the preflight fails before the engine is
// spawned, and the batch must not stay `running`.
const NOPW = makeProject('nopw', { link: false });
// A project whose SECOND file has a name the ATS-106 filter check refuses
// (the parentheses are a regular-expression metacharacter).
const UNSAFE = makeProject('unsafe', {
  files: {
    'tests/a.spec.ts': "import { test } from '@playwright/test';\ntest('u-a1', async () => {});\n",
    'tests/p(1).spec.ts': "import { test } from '@playwright/test';\ntest('u-p1', async () => {});\n",
  },
});

/* ------------------------------------------------------------------ */
/* The Bridge                                                          */
/* ------------------------------------------------------------------ */
let cp;
let token;

async function ready() {
  for (let i = 0; i < 400; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('server did not boot');
}

async function api(endpoint, method = 'GET', payload) {
  const r = await fetch(`http://127.0.0.1:${port}` + endpoint, {
    method,
    headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  return [r.status, await r.json()];
}

function startBridge() {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: DATA },
    stdio: 'ignore'
  });
}

async function stopBridge() {
  if (!cp) return;
  const exited = new Promise((resolve) => cp.once('exit', resolve));
  try { execFileSync('taskkill', ['/PID', String(cp.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  cp = null;
}

async function addProject(root, trusted = true) {
  // The Bridge refuses a path it already knows (409). The tests below
  // register the SAME fixture more than once -- once per behaviour under
  // test -- so an already known project is REUSED rather than refused.
  const known = await api('/api/projects');
  const existing = known[1].projects.find((p) => p.root === root);
  const id = existing ? existing.id : (await api('/api/projects', 'POST', { path: root }))[1]?.project?.id;
  assert.ok(id, `the project ${root} could not be added`);
  if (trusted) {
    const t = await api(`/api/projects/${id}/trust`, 'POST', { trust: 'trusted' });
    assert.equal(t[0], 200);
  }
  return id;
}

const TERMINAL = new Set(['passed', 'failed', 'cancelled', 'error', 'interrupted']);
async function waitRun(id, ms = 120000) {
  const t0 = Date.now();
  for (;;) {
    const [, j] = await api(`/api/runs/${id}`);
    if (j?.run && TERMINAL.has(j.run.status)) return j.run;
    if (Date.now() - t0 > ms) return j?.run;
    await new Promise((r) => setTimeout(r, 400));
  }
}
async function waitBatch(uid, ms = 120000) {
  const t0 = Date.now();
  for (;;) {
    const [, j] = await api('/api/batches');
    const b = j.batches.find((x) => x.uid === uid);
    if (b && b.status !== 'running') return b;
    if (Date.now() - t0 > ms) return b;
    await new Promise((r) => setTimeout(r, 400));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('IT-ATS214-SETUP: start the bridge', async () => {
  startBridge();
  await ready();
  token = (await api('/api/session'))[1].token;
  assert.ok(token);
});

test.after(async () => {
  await stopBridge();
  // The removal is BEST EFFORT: a leftover fixture under the temp
  // directory is harmless, but a teardown that throws turns a green run
  // red -- and the reader then cannot tell which of the two happened.
  try {
    fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.warn(`the fixture ${WORK} could not be removed (${e.code ?? e.message}); it is left under the temp directory`);
  }
});

/* ================================================================== */
/* 1. The request context is inherited by every run of the batch      */
/* ================================================================== */

test('IT-ATS214-030: the SECOND file of a batch inherits the environment profile', { skip: SKIP }, async () => {
  const pid = await addProject(BATCH);
  const env = await api(`/api/projects/${pid}/env`, 'POST', {
    name: 'staging', environment: 'staging', variables: { BASE_URL: 'http://staging.example' }
  });
  // The profile is written with an UPSERT: the first write answers 201,
  // a rewrite of the same name answers 200.
  assert.ok(env[0] === 201 || env[0] === 200, `the profile could not be written: ${JSON.stringify(env[1])}`);
  assert.equal(env[1].profile.name, 'staging');

  const catalog = await api(`/api/projects/${pid}/tests`);
  const byTitle = Object.fromEntries(catalog[1].tests.map((t) => [t.title, t]));
  const sel = [byTitle.a1.uid, byTitle.b1.uid];
  assert.ok(sel.every(Boolean), 'the fixture has a1 and b1');

  const r = await api(`/api/projects/${pid}/run`, 'POST', { selection: sel, env: 'staging' });
  assert.equal(r[0], 202);
  const batch = await waitBatch(r[1].run.batchUid);
  assert.equal(batch.status, 'passed', `the batch did not finish: ${JSON.stringify(batch)}`);

  // The BATCH RECORD carries the context it was started with.
  assert.equal(batch.context.envName, 'staging');
  assert.equal(batch.context.envTier, 'staging');
  assert.ok(batch.context.envUid, 'the profile has an identity');

  // EVERY RUN of the batch carries it -- not only the first one.
  const runs = [];
  for (const entry of batch.runs) runs.push((await api(`/api/runs/${entry.runId}`))[1].run);
  assert.equal(runs.length, 2, 'the batch has two runs');
  for (const run of runs) {
    assert.equal(run.envName, 'staging', `run of ${run.file} lost the profile`);
    assert.equal(run.envUid, batch.context.envUid);
    assert.equal(run.envTier, 'staging');
    // The NAMES of the variables, never their values (ATS-212).
    assert.deepEqual(run.envVariables, ['BASE_URL']);
  }

  // The MEASUREMENT: the engine really saw the profile's variable in the
  // SECOND file too. This is the fact the run record alone cannot give.
  const seenPath = path.join(BATCH, 'env-seen.txt');
  const seen = fs.existsSync(seenPath) ? fs.readFileSync(seenPath, 'utf8').trim().split(/\r?\n/) : [];
  const bSeen = seen.filter((l) => l.startsWith('b'));
  assert.ok(bSeen.length > 0, `the second file never ran: ${JSON.stringify(seen)}`);
  for (const line of bSeen) {
    assert.ok(line.endsWith('=http://staging.example'), `the second file ran without the profile: ${line}`);
  }
});

test('IT-ATS214-031: the second run of a batch records the profile it inherited', { skip: SKIP }, async () => {
  const pid = await addProject(BATCH);
  await api(`/api/projects/${pid}/env`, 'POST', {
    name: 'staging', environment: 'staging', variables: { BASE_URL: 'http://staging.example' }
  });
  const catalog = await api(`/api/projects/${pid}/tests`);
  const byTitle = Object.fromEntries(catalog[1].tests.map((t) => [t.title, t]));
  const r = await api(`/api/projects/${pid}/run`, 'POST', {
    selection: [byTitle.a1.uid, byTitle.b1.uid], env: 'staging'
  });
  assert.equal(r[0], 202);
  const batch = await waitBatch(r[1].run.batchUid);
  const second = batch.runs.find((x) => x.groupIndex === 1);
  assert.ok(second, 'the batch has a second run');
  const run = (await api(`/api/runs/${second.runId}`))[1].run;
  assert.equal(run.envName, 'staging');
  assert.equal(run.batchIndex, 1);
  // The selection of the run is ITS OWN GROUP -- the card of a run can
  // then be reconciled against that run alone.
  assert.equal(run.selection.count, 1);
  assert.deepEqual(run.selection.files, ['tests/b.spec.ts']);
});

/* ================================================================== */
/* 2. Every group is validated BEFORE anything runs                    */
/* ================================================================== */

test('IT-ATS214-032: a refused file in a selection is refused as a WHOLE', async () => {
  const pid = await addProject(UNSAFE);
  const catalog = await api(`/api/projects/${pid}/tests`);
  const byTitle = Object.fromEntries(catalog[1].tests.map((t) => [t.title, t]));

  // The single-file path: the refusal.
  const single = await api(`/api/projects/${pid}/run`, 'POST', { selection: [byTitle['u-p1'].uid] });
  assert.equal(single[0], 400, 'the single-file path refuses the file');
  assert.equal(single[1].error, 'INVALID_TEST_FILTER');

  // The batch path: the SAME refusal, before anything runs.
  const batch = await api(`/api/projects/${pid}/run`, 'POST', {
    selection: [byTitle['u-a1'].uid, byTitle['u-p1'].uid]
  });
  assert.equal(batch[0], 400, 'the batch path refuses the whole selection');
  assert.equal(batch[1].error, 'INVALID_TEST_FILTER');
  assert.equal(batch[1].file, 'tests/p(1).spec.ts');

  // Nothing ran: the batch path refused BEFORE the first run started.
  const [, runs] = await api('/api/runs');
  const ofProject = runs.runs.filter((r) => r.projectId === pid);
  assert.equal(ofProject.length, 0, `the batch started a run anyway: ${JSON.stringify(ofProject.map((r) => r.file))}`);
});

/* ================================================================== */
/* 3. The batch always reaches a terminal status                       */
/* ================================================================== */

test('IT-ATS214-033: a batch whose preflight fails REACHES A TERMINAL STATUS', async () => {
  const pid = await addProject(NOPW, false);
  const catalog = await api(`/api/projects/${pid}/tests`);
  assert.ok(catalog[1].tests.length >= 2, 'the fixture has cases in two files');

  const r = await api(`/api/projects/${pid}/run`, 'POST', { selection: catalog[1].tests.map((t) => t.uid) });
  assert.equal(r[0], 202);
  const batchUid = r[1].run.batchUid;
  assert.ok(batchUid, 'the selection became a batch');

  const batch = await waitBatch(batchUid, 30000);
  assert.ok(batch, 'the batch is on the record');
  assert.notEqual(batch.status, 'running', 'the batch stayed running after the preflight failed');
  assert.ok(batch.finishedAt, 'the batch says when it ended');
  assert.ok(batch.error, 'the batch says why it ended');
  assert.equal(batch.status, 'failed');
});

test('IT-ATS214-034: a batch that is in flight when the Bridge dies is INTERRUPTED', { skip: SKIP }, async () => {
  const pid = await addProject(BATCH);
  const catalog = await api(`/api/projects/${pid}/tests`);
  const r = await api(`/api/projects/${pid}/run`, 'POST', { selection: catalog[1].tests.map((t) => t.uid) });
  assert.equal(r[0], 202);
  const batchUid = r[1].run.batchUid;
  assert.ok(batchUid);

  // Wait until the batch really is in flight.
  for (let i = 0; i < 60; i++) {
    const [, j] = await api('/api/batches');
    const b = j.batches.find((x) => x.uid === batchUid);
    if (b && b.status === 'running') break;
    await sleep(100);
  }

  // Kill the Bridge HARD: no clean shutdown, no chance to finish the chain.
  await stopBridge();

  // Restart it on the SAME data directory: the recovery is what must
  // notice the batch.
  startBridge();
  await ready();
  token = (await api('/api/session'))[1].token;

  await sleep(1500);
  const [, j] = await api('/api/batches');
  const b = j.batches.find((x) => x.uid === batchUid);
  assert.ok(b, 'the batch survived the restart');
  assert.notEqual(b.status, 'running', 'the batch stayed running after the Bridge was killed');
  assert.ok(b.finishedAt, 'the batch says when it ended');
});

/* ================================================================== */
/* 4. The batch-level reconciliation                                   */
/* ================================================================== */

test('IT-ATS214-035: the batch record reconciles what was selected against what ran', { skip: SKIP }, async () => {
  const pid = await addProject(BATCH);
  const catalog = await api(`/api/projects/${pid}/tests`);
  const byTitle = Object.fromEntries(catalog[1].tests.map((t) => [t.title, t]));
  const r = await api(`/api/projects/${pid}/run`, 'POST', { selection: [byTitle.a1.uid, byTitle.b1.uid] });
  assert.equal(r[0], 202);
  const batch = await waitBatch(r[1].run.batchUid);
  assert.equal(batch.status, 'passed');

  // The reconciliation is there, and it is computed from the run records.
  assert.ok(batch.reconciliation, 'the batch carries a reconciliation');
  assert.equal(batch.reconciliation.selected, 2);
  // Both selected cases ran -- across the TWO runs of the batch. This is
  // the fact the per-run card could not show.
  assert.deepEqual(batch.reconciliation.missing, [], 'the reconciliation reports a missing case');
  assert.equal(batch.reconciliation.matches, true);
  // The engine runs the WHOLE file, so it ran cases that were not
  // selected -- and the reconciliation REPORTS them instead of hiding
  // them.
  assert.ok(batch.reconciliation.extra.length > 0, 'the extra cases are reported');
  assert.equal(batch.reconciliation.exact, false);
});

/* ================================================================== */
/* 5. The batch record carries NO environment values                   */
/* ================================================================== */

/**
 * A project whose FIRST file sleeps before it records what it saw.
 *
 * The delay is what makes the whitelist change land BETWEEN the two runs:
 * run #1 holds the project for a while, and the whitelist is tightened
 * (or the profile is deleted) while it is still running. Each scenario
 * gets its OWN fixture, so the two recording files never mix.
 */
function slowProject(name) {
  const root = path.join(WORK, name);
  const seen = path.join(root, 'env-seen.txt').replace(/\\/g, '/');
  return makeProject(name, {
    files: {
      'tests/a.spec.ts': [
        "import { test } from '@playwright/test';",
        "import fs from 'node:fs';",
        `test('s-a1', async () => { await new Promise(r => setTimeout(r, 8000)); fs.appendFileSync('${seen}', 's-a1=' + (process.env.BASE_URL ?? '<unset>') + '\\n'); });`,
        '',
      ].join('\n'),
      'tests/b.spec.ts': [
        "import { test } from '@playwright/test';",
        "import fs from 'node:fs';",
        `test('s-b1', async () => { fs.appendFileSync('${seen}', 's-b1=' + (process.env.BASE_URL ?? '<unset>') + '\\n'); });`,
        '',
      ].join('\n'),
    },
  });
}
const SLOW_WHITELIST = slowProject('slow-wl');
const SLOW_DELETED = slowProject('slow-del');

test('IT-ATS214-036: the batch record carries NO environment variable values', { skip: SKIP }, async () => {
  const pid = await addProject(BATCH);
  const SECRET = 'https://staging.example/?k=s3cr3t-value-1234';
  const env = await api(`/api/projects/${pid}/env`, 'POST', {
    name: 'staging', environment: 'staging', variables: { BASE_URL: SECRET }
  });
  assert.ok(env[0] === 201 || env[0] === 200, `the profile could not be written: ${JSON.stringify(env[1])}`);

  const catalog = await api(`/api/projects/${pid}/tests`);
  const byTitle = Object.fromEntries(catalog[1].tests.map((t) => [t.title, t]));
  const r = await api(`/api/projects/${pid}/run`, 'POST', {
    selection: [byTitle.a1.uid, byTitle.b1.uid], env: 'staging'
  });
  assert.equal(r[0], 202);

  // The batch record is READABLE while the batch runs -- and it must not
  // carry a value. The value is in the profile store (that is where ATS-212
  // puts it), never in the batch.
  const [, batches] = await api(`/api/batches?projectId=${pid}`);
  const batch = batches.batches.find((b) => b.uid === r[1].run.batchUid);
  assert.ok(batch, 'the batch is on the record');
  const serialised = JSON.stringify(batches);
  assert.ok(!serialised.includes(SECRET), `the batch record serves the environment value: ${serialised}`);

  // The context names the profile; it does not carry the variables.
  assert.ok(batch.context.envUid, 'the context names the profile');
  assert.equal(batch.context.envName, 'staging');
  assert.equal(batch.context.envVariables, undefined,
    `the batch context still carries the variables: ${JSON.stringify(batch.context.envVariables)}`);

  // The PUBLIC view of the profile serves names only (ATS-212) -- and so
  // does the run record.
  const [, envList] = await api(`/api/projects/${pid}/env`);
  assert.ok(!JSON.stringify(envList).includes(SECRET), 'the profile list serves the value');
  const [, runs] = await api('/api/runs');
  assert.ok(!JSON.stringify(runs).includes(SECRET), 'a run record serves the value');

  await waitBatch(r[1].run.batchUid);
});

test('IT-ATS214-037: a whitelist tightened while the batch runs constrains the LATER run', { skip: SKIP }, async () => {
  const pid = await addProject(SLOW_WHITELIST);
  const SECRET = 'https://staging.example/?k=s3cr3t-value-1234';
  await api(`/api/projects/${pid}/env`, 'POST', {
    name: 'staging', environment: 'staging', variables: { BASE_URL: SECRET }
  });
  const catalog = await api(`/api/projects/${pid}/tests`);
  const byTitle = Object.fromEntries(catalog[1].tests.map((t) => [t.title, t]));
  const r = await api(`/api/projects/${pid}/run`, 'POST', {
    selection: [byTitle['s-a1'].uid, byTitle['s-b1'].uid], env: 'staging'
  });
  assert.equal(r[0], 202);

  // Wait until the FIRST run is really in flight -- it sleeps for 8s, so
  // the whitelist change lands while it runs.
  let first;
  for (let i = 0; i < 80; i++) {
    const [, j] = await api(`/api/runs/${r[1].run.id}`);
    if (j?.run?.status === 'running') { first = j.run; break; }
    await sleep(200);
  }
  assert.ok(first, 'the first run is running');

  // The whitelist is tightened NOW: BASE_URL leaves it.
  const [, wl] = await api(`/api/projects/${pid}/env-whitelist`);
  const names = (wl?.whitelist?.names ?? []).filter((n) => n !== 'BASE_URL');
  const put = await api(`/api/projects/${pid}/env-whitelist`, 'PUT', { names });
  assert.equal(put[0], 200, `the whitelist could not be tightened: ${JSON.stringify(put[1])}`);

  const batch = await waitBatch(r[1].run.batchUid, 180000);
  assert.ok(batch, 'the batch is on the record');
  assert.notEqual(batch.status, 'running', 'the batch never reached a terminal status');

  // The SECOND run started AFTER the whitelist was tightened: it must NOT
  // carry the variable. This is the whole point of the whitelist -- it
  // constrains the RUN, not only the write.
  const seenPath = path.join(SLOW_WHITELIST, 'env-seen.txt');
  const seen = fs.existsSync(seenPath) ? fs.readFileSync(seenPath, 'utf8').trim().split(/\r?\n/) : [];
  const bSeen = seen.find((l) => l.startsWith('s-b1='));
  assert.ok(bSeen, `the second file never ran: ${JSON.stringify(seen)}`);
  assert.ok(bSeen.endsWith('=<unset>'),
    `the second run still carried the variable the whitelist removed: ${bSeen.replace(SECRET, '<value>')}`);

  // The run record says so too: the variable is not among the names that
  // reached the runner, and the refusal is reported.
  const second = batch.runs.find((x) => x.groupIndex === 1);
  assert.ok(second, 'the batch has a second run');
  const run = (await api(`/api/runs/${second.runId}`))[1].run;
  assert.deepEqual(run.envVariables, [], 'the run record still claims the variable');
  assert.ok(Array.isArray(run.envRefused) && run.envRefused.some((x) => x.name === 'BASE_URL'),
    `the refusal is not reported: ${JSON.stringify(run.envRefused)}`);
});

test('IT-ATS214-038: a profile DELETED while the batch runs ends the batch with a reason', { skip: SKIP }, async () => {
  const pid = await addProject(SLOW_DELETED);
  await api(`/api/projects/${pid}/env`, 'POST', {
    name: 'staging', environment: 'staging', variables: { BASE_URL: 'http://staging.example' }
  });
  const catalog = await api(`/api/projects/${pid}/tests`);
  const byTitle = Object.fromEntries(catalog[1].tests.map((t) => [t.title, t]));
  const r = await api(`/api/projects/${pid}/run`, 'POST', {
    selection: [byTitle['s-a1'].uid, byTitle['s-b1'].uid], env: 'staging'
  });
  assert.equal(r[0], 202);

  for (let i = 0; i < 80; i++) {
    const [, j] = await api(`/api/runs/${r[1].run.id}`);
    if (j?.run?.status === 'running') break;
    await sleep(200);
  }

  // The profile is DELETED while the batch is in flight.
  const del = await api(`/api/projects/${pid}/env?ref=staging`, 'DELETE');
  assert.equal(del[0], 200, `the profile could not be deleted: ${JSON.stringify(del[1])}`);

  const batch = await waitBatch(r[1].run.batchUid, 180000);
  assert.ok(batch, 'the batch is on the record');
  assert.notEqual(batch.status, 'running', 'the batch stayed running after the profile was deleted');
  assert.equal(batch.status, 'failed');
  assert.ok(batch.error, 'the batch says why it ended');
  assert.match(batch.error, /ENV_PROFILE_NOT_FOUND|no longer exists/,
    `the reason does not name the missing profile: ${batch.error}`);

  // The second file never ran under a silent fallback to "no profile".
  const seenPath = path.join(SLOW_DELETED, 'env-seen.txt');
  const seen = fs.existsSync(seenPath) ? fs.readFileSync(seenPath, 'utf8').trim().split(/\r?\n/) : [];
  assert.ok(!seen.some((l) => l.startsWith('s-b1=')),
    `the second file ran without the profile it was started with: ${JSON.stringify(seen)}`);
});
