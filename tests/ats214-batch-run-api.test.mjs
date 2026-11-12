#!/usr/bin/env node
/**
 * ATS-214: the INTEGRATION tests of the case search, the tags and the
 * batch-run selection -- the ones that go through the BRIDGE's HTTP API.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The unit tests (`tests/ats214-case-search.test.mjs`) drive the SHARED
 * MODULE in-process. This file drives the parts that only exist on the
 * server: the tags that reach the catalogue, the selection that the run
 * request carries, and the batch that the selection becomes.
 *
 * Three things are checked here, and they are the three the unit tests
 * cannot check:
 *
 *   1. THE TAGS REACH THE CATALOGUE. The catalogue has to carry the tags
 *      of the cases, and it has to carry them on BOTH indexes: the
 *      authoritative one (the CLI's own tags) and the static one (the
 *      tags the scanner reads out of the source). A tag filter that only
 *      worked on a trusted project would be a filter that silently
 *      matches nothing on an untrusted one.
 *   2. THE SELECTION IS VALIDATED. A selection that names a case the
 *      catalogue does not know is REFUSED with a code -- not skipped.
 *   3. THE SELECTION IS ON THE RECORD, and the batch splits it by file.
 *
 * THE REAL PLAYWRIGHT
 * -------------------
 * The authoritative listing runs the PROJECT's own CLI, so the fixture
 * needs a `node_modules`. The real CLI of the repository (the example
 * project's dependency tree) is linked into the fixture as a JUNCTION --
 * the same trick the ATS-202/ATS-203 API tests use. Nothing is
 * installed here.
 *
 * When no real CLI is reachable, the cases that need it are SKIPPED with a
 * reason -- never reported as a pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { freePort } from './helpers/free-port.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-214-it-'));
const FIXTURE = path.join(WORK, 'project');
const DATA = path.join(WORK, 'data');
const port = await freePort();

/**
 * The REAL `@playwright/test` the fixture can reach.
 *
 * The candidates are the repository's own example project and the local
 * integration checkout. The fixture links the directory as a JUNCTION, so
 * the fixture has a `node_modules` without installing anything.
 */
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

fs.mkdirSync(path.join(FIXTURE, 'tests'), { recursive: true });
fs.writeFileSync(path.join(FIXTURE, 'package.json'), '{"name":"ats214-it","private":true}');
fs.writeFileSync(
  path.join(FIXTURE, 'playwright.config.ts'),
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n"
);
if (PLAYWRIGHT_MODULES) {
  try {
    fs.symlinkSync(PLAYWRIGHT_MODULES, path.join(FIXTURE, 'node_modules'), 'junction');
  } catch {
    // A junction cannot be created here: the listing reports
    // PLAYWRIGHT_NOT_INSTALLED and the case that needs it says so.
  }
}

/**
 * The fixture: two files, six cases, three tags.
 *
 * The tags are written the way Playwright requires them (with the '@'),
 * and the CLI reports them WITHOUT it -- which is the fact the catalogue
 * has to carry, and the fact the tag filter has to compare against.
 */
function writeFixture() {
  fs.writeFileSync(path.join(FIXTURE, 'tests', 'login.spec.ts'), [
    "import { test } from '@playwright/test';",
    '',
    "test('用户登录', { tag: '@smoke' }, async () => {});",
    '',
    "test('登录失败提示', { tag: ['@smoke', '@slow'] }, async () => {});",
    '',
    "test('登出', async () => {});",
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(FIXTURE, 'tests', 'cart.spec.ts'), [
    "import { test } from '@playwright/test';",
    '',
    "test('加入购物车', { tag: '@slow' }, async () => {});",
    '',
    "test('结算', { tag: '@smoke' }, async () => {});",
    '',
    "test('快速加购', { tag: '@fast' }, async () => {});",
    ''
  ].join('\n'));
}
writeFixture();

let cp;
let token;

/**
 * Waits for the Bridge to come up.
 *
 * The window is 400 attempts x 50 ms = 20 s. `npm test` runs the test
 * files in PARALLEL and several of them each boot a Bridge, so a short
 * window turns into a flaky "server did not boot" failure on a DIFFERENT
 * subset each run.
 */
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

/** Calls the Bridge. */
async function api(endpoint, method = 'GET', payload) {
  const r = await fetch(`http://127.0.0.1:${port}` + endpoint, {
    method,
    headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  return [r.status, await r.json()];
}

let projectId;

test('IT-ATS214-SETUP: start the bridge and register the fixture', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: DATA },
    stdio: 'ignore'
  });
  await ready();
  token = (await api('/api/session'))[1].token;
  assert.ok(token);

  const r = await api('/api/projects', 'POST', { path: FIXTURE });
  assert.equal(r[0], 201);
  projectId = r[1].project.id;
  assert.ok(projectId);
});

test.after(async () => {
  // The Bridge has to be GONE before the tree is removed: on Windows a
  // process that still holds a file makes the removal fail with EPERM,
  // and the removal would then leave the fixture behind. The kill is
  // AWAITED (the exit event) and the removal retries, which is the
  // pattern the repository's other bridge tests use
  // (tests/android-bridge-it.test.mjs).
  if (cp) {
    const exited = new Promise((resolve) => cp.once('exit', resolve));
    cp.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/* ================================================================== */
/* The tags reach the catalogue                                         */
/* ================================================================== */

test('IT-ATS214-001: the STATIC index carries the tags it reads from the source', async () => {
  const r = await api(`/api/projects/${projectId}/tests`);
  assert.equal(r[0], 200);
  const body = r[1];
  assert.equal(body.discovery, 'static', 'the project is untrusted, so the static index answers');

  const byTitle = Object.fromEntries(body.tests.map((t) => [t.title, t]));
  // The tags the scanner read out of the details objects.
  assert.deepEqual(byTitle['用户登录'].tags, ['smoke']);
  assert.deepEqual(byTitle['登录失败提示'].tags, ['slow', 'smoke']);
  assert.deepEqual(byTitle['加入购物车'].tags, ['slow']);
  assert.deepEqual(byTitle['结算'].tags, ['smoke']);
  assert.deepEqual(byTitle['快速加购'].tags, ['fast']);
  // A case with no tag carries none -- the field is absent, not empty,
  // so a reader can tell "no tag" from "tags not read".
  assert.equal(byTitle['登出'].tags, undefined);
});

test('IT-ATS214-002: the AUTHORITATIVE index carries the CLI\'s own tags', { skip: SKIP }, async () => {
  const grant = await api(`/api/projects/${projectId}/trust`, 'POST', { trust: 'trusted' });
  assert.equal(grant[0], 200);

  const r = await api(`/api/projects/${projectId}/tests`);
  assert.equal(r[0], 200);
  const body = r[1];
  assert.equal(body.discovery, 'authoritative');
  assert.equal(body.authoritative.outcome, 'OK');
  assert.equal(body.authoritative.version, '1.64.1', 'the real CLI answered');

  const byTitle = Object.fromEntries(body.tests.map((t) => [t.title, t]));
  assert.deepEqual(byTitle['用户登录'].tags, ['smoke']);
  assert.deepEqual(byTitle['登录失败提示'].tags, ['smoke', 'slow']);
  assert.deepEqual(byTitle['加入购物车'].tags, ['slow']);
  assert.deepEqual(byTitle['结算'].tags, ['smoke']);
  assert.deepEqual(byTitle['快速加购'].tags, ['fast']);
});

test('IT-ATS214-003: the two indexes carry the SAME tags for the same cases', { skip: SKIP }, async () => {
  // The static index reads the tags out of the source and the
  // authoritative index gets them from the CLI. They must AGREE -- a
  // filter that behaves differently on the two indexes is a filter the
  // user cannot predict.
  const auth = await api(`/api/projects/${projectId}/tests`);
  const authoritative = auth[1];
  assert.equal(authoritative.discovery, 'authoritative');

  // The static answer of the SAME project, computed in-process from the
  // same source files the authoritative CLI read.
  const { discoverStatic } = await import('../server/core.mjs');
  const { emptyRegistry } = await import('../server/uid.mjs');
  const project = { id: projectId, uid: projectId, root: FIXTURE };
  const staticCatalog = discoverStatic(project, emptyRegistry());
  const staticByTitle = Object.fromEntries(staticCatalog.tests.map((t) => [t.title, t]));
  const authByTitle = Object.fromEntries(authoritative.tests.map((t) => [t.title, t]));

  for (const title of Object.keys(authByTitle)) {
    assert.deepEqual(
      (staticByTitle[title]?.tags ?? []).slice().sort(),
      (authByTitle[title]?.tags ?? []).slice().sort(),
      `the two indexes disagree about the tags of "${title}"`
    );
  }
});

/* ================================================================== */
/* The selection is validated                                          */
/* ================================================================== */

test('IT-ATS214-010: a selection that names an unknown case is REFUSED, not skipped', async () => {
  const r = await api(`/api/projects/${projectId}/run`, 'POST', {
    selection: ['tc_1_d_0000000000000000']
  });
  assert.equal(r[0], 400);
  assert.equal(r[1].error, 'SELECTION_UNKNOWN_CASE');
  assert.deepEqual(r[1].unknown, ['tc_1_d_0000000000000000']);
});

test('IT-ATS214-011: an empty selection is refused', async () => {
  const r = await api(`/api/projects/${projectId}/run`, 'POST', { selection: [] });
  assert.equal(r[0], 400);
  assert.equal(r[1].error, 'SELECTION_EMPTY');
});

test('IT-ATS214-012: a selection that is not an array is refused', async () => {
  const r = await api(`/api/projects/${projectId}/run`, 'POST', { selection: 'u1' });
  assert.equal(r[0], 400);
  assert.equal(r[1].error, 'SELECTION_NOT_AN_ARRAY');
});

test('IT-ATS214-013: the run request still refuses the fields outside the whitelist', async () => {
  // The `selection` field was added to the whitelist; everything else is
  // still refused, so the ATS-106 baseline is intact.
  const r = await api(`/api/projects/${projectId}/run`, 'POST', { grep: 'x' });
  assert.equal(r[0], 400);
  assert.equal(r[1].error, 'RUN_PARAMETER_NOT_ALLOWED');
  assert.deepEqual(r[1].rejected, ['grep']);
});

/* ================================================================== */
/* The selection is on the record                                      */
/* ================================================================== */

test('IT-ATS214-020: a selection of ONE file becomes a run that carries the selection', async () => {
  const catalog = await api(`/api/projects/${projectId}/tests`);
  const login = catalog[1].tests.filter((t) => t.file === 'tests/login.spec.ts');
  assert.ok(login.length >= 2, 'the fixture has cases in the login file');

  const r = await api(`/api/projects/${projectId}/run`, 'POST', {
    selection: login.map((t) => t.uid)
  });
  assert.equal(r[0], 202);
  const run = r[1].run;

  // The selection is ON the record, with the file, the title and the line
  // of every selected case -- a self-contained snapshot.
  assert.ok(run.selection, 'the run carries its selection');
  assert.equal(run.selection.count, login.length);
  assert.deepEqual(run.selection.files, ['tests/login.spec.ts']);
  assert.deepEqual(run.selectionUids, login.map((t) => t.uid));
  for (const c of run.selection.cases) {
    assert.equal(c.file, 'tests/login.spec.ts');
    assert.ok(typeof c.title === 'string' && c.title.length > 0);
    assert.ok(Number.isInteger(c.line));
  }
  // The file of the run is the file of the selection.
  assert.equal(run.file, 'tests/login.spec.ts');

  // The run is stopped so the test does not wait for the engine.
  await api(`/api/runs/${run.id}/stop`, 'POST');
});

test('IT-ATS214-021: a selection that spans SEVERAL files becomes a BATCH, split by file', async () => {
  const catalog = await api(`/api/projects/${projectId}/tests`);
  const tests = catalog[1].tests;
  // One case from each file.
  const picked = [
    tests.find((t) => t.file === 'tests/login.spec.ts'),
    tests.find((t) => t.file === 'tests/cart.spec.ts'),
  ].filter(Boolean);
  assert.equal(picked.length, 2, 'the fixture has a case in each file');

  const r = await api(`/api/projects/${projectId}/run`, 'POST', {
    selection: picked.map((t) => t.uid)
  });
  assert.equal(r[0], 202);
  const run = r[1].run;

  // The batch is recorded, and it says how the selection was split.
  const batches = await api('/api/batches');
  assert.equal(batches[0], 200);
  const batch = batches[1].batches.find((b) => b.uid === run.batchUid);
  assert.ok(batch, 'the batch of the run is on the record');
  assert.equal(batch.uids.length, 2);
  assert.equal(batch.groups.length, 2, 'the batch is split by file');
  assert.deepEqual(batch.files.slice().sort(), ['tests/cart.spec.ts', 'tests/login.spec.ts']);
  // The batch's cases carry the snapshot -- the file, the title and the
  // line of every selected case.
  assert.equal(batch.cases.length, 2);
  for (const c of batch.cases) {
    assert.ok(c.file.length > 0);
    assert.ok(c.title.length > 0);
    assert.ok(Number.isInteger(c.line));
  }
  // The batch and the run point at each other.
  assert.equal(batch.runs[0].runId, run.id);
  assert.equal(run.batchIndex, 0);

  await api(`/api/runs/${run.id}/stop`, 'POST');
});

test('IT-ATS214-022: the batches endpoint can be narrowed to one project', async () => {
  const r = await api(`/api/batches?projectId=${projectId}`);
  assert.equal(r[0], 200);
  for (const b of r[1].batches) assert.equal(b.projectId, projectId);
});
