#!/usr/bin/env node
/**
 * ATS-203: the SYSTEM tests of the dynamic / parameterised / project-matrix
 * index -- the ones that go through the BRIDGE's HTTP API.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The dataset (`tests/ats203-regression-dataset.test.mjs`) and the
 * integration tests (`tests/ats203-index-it.test.mjs`) drive the index
 * IN-PROCESS. This file drives it the way a USER does: over HTTP, against a
 * running Bridge, with the project registered through the API and the trust
 * granted through the API.
 *
 * The acceptance criterion of ATS-203 is "重名、describe、参数化、重复
 * project 的结果正确**或**标明不可判定". At this level the criterion has
 * one more half: the answer the user gets must CARRY that verdict. The
 * Bridge is the surface that shows the catalogue to a person, so the
 * verdict has to survive the trip: the case count, the titles, the
 * `uidStable` flag, the `ambiguity.reason` and the warning.
 *
 * THE FIXTURES
 * ------------
 * The fixture uses Playwright's REAL parameterisation form: a `for` /
 * `forEach` loop. There is no `test.each` in Playwright (measured: the CLI
 * answers `TypeError: _test.test.each is not a function`), so a fixture
 * built on it would test nothing but that typo.
 *
 * THE REAL PLAYWRIGHT
 * -------------------
 * The listing runs the PROJECT's own CLI, so the fixture needs a
 * `node_modules`. The real CLI of the repository (the example project's
 * dependency tree) is linked into the fixture as a JUNCTION -- the same
 * trick the ATS-202 API tests use. Nothing is installed here.
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

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-203-st-'));
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
    process.env.ATS203_PLAYWRIGHT_MODULES,
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
fs.writeFileSync(path.join(FIXTURE, 'package.json'), '{"name":"ats203-st","private":true}');
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
 * The default fixture: a parameterised loop with a TEMPLATE title next to
 * two ordinary cases.
 */
function writeDefaultFixture() {
  fs.writeFileSync(path.join(FIXTURE, 'tests', 'mixed.spec.ts'), [
    "import { test } from '@playwright/test';",
    '',
    "test.describe('数据验证', () => {",
    "  test('格式检查', async () => {});",
    '  for (const n of [10, 20]) {',
    '    test(`范围检查 - ${n}`, async () => {});',
    '  }',
    "  test('边界值', async () => {});",
    '});',
    ''
  ].join('\n'));
}

writeDefaultFixture();

let cp;
let token;

/**
 * Waits for the Bridge to come up.
 *
 * The window is 400 attempts x 50 ms = 20 s. `npm test` runs the test files
 * in PARALLEL and several of them each boot a Bridge: measured on this
 * machine the boot takes 1289 / 5637 / 8582 ms (min / median / max), so a
 * short window turns into a flaky "server did not boot" failure on a
 * DIFFERENT subset each run.
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
    body: payload ? JSON.stringify(payload) : undefined
  });
  return [r.status, await r.json()];
}

/** The number of Playwright projects a case ran in. */
const specIdCount = (t) => (Array.isArray(t.specIds) ? t.specIds.length : null);

test('ST-ATS203-SETUP: start the bridge', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: DATA },
    stdio: 'ignore'
  });
  await ready();
  token = (await api('/api/session'))[1].token;
  assert.ok(token);
});

test('ST-ATS203-001: an untrusted project gets the static index, and the dynamic case says it cannot decide', async () => {
  const r = await api('/api/projects', 'POST', { path: FIXTURE });
  assert.equal(r[0], 201);
  const projectId = r[1].project.id;

  const catalogue = await api(`/api/projects/${projectId}/tests`);
  assert.equal(catalogue[0], 200);
  const body = catalogue[1];
  assert.equal(body.discovery, 'static', 'an untrusted project never runs --list');
  assert.equal(body.authoritative.attempted, false);
  assert.equal(body.authoritative.outcome, 'SKIPPED_UNTRUSTED');

  // The template is reported as it is written, and it is UNDECIDABLE.
  const template = body.tests.find((t) => t.title === '范围检查 - ${n}');
  assert.ok(template, 'the template is in the catalogue');
  assert.equal(template.uidStable, false, 'a template title does not identify a case');
  assert.equal(template.uidSource, 'provisional');
  assert.equal(template.ambiguity.reason, 'dynamic-template-title');
  assert.equal(template.ambiguity.template, '范围检查 - ${n}');

  // The ordinary cases are decidable.
  const plain = body.tests.filter((t) => t.title === '格式检查' || t.title === '边界值');
  assert.equal(plain.length, 2);
  assert.equal(plain.every((t) => t.uidStable), true);

  // The verdict survives the trip: the warning counts THIS case.
  assert.match(body.warning, /1 个用例的标题是动态模板/);
  assert.match(body.warning, /用例数量不可判定/);
});

test('ST-ATS203-002: a trusted project gets the authoritative index, and the rendered cases come through', { skip: SKIP }, async () => {
  const projects = await api('/api/projects', 'GET');
  const projectId = projects[1].projects[0].id;
  const grant = await api(`/api/projects/${projectId}/trust`, 'POST', { trust: 'trusted' });
  assert.equal(grant[0], 200);
  assert.equal(grant[1].trust.trust, 'trusted');

  const catalogue = await api(`/api/projects/${projectId}/tests`);
  assert.equal(catalogue[0], 200);
  const body = catalogue[1];
  assert.equal(body.discovery, 'authoritative');
  assert.equal(body.authoritative.outcome, 'OK');
  assert.equal(body.authoritative.version, '1.64.1', 'the real CLI answered');

  // The four cases are in the catalogue: the ordinary two and the two the
  // loop rendered. The comparison is order-independent on purpose: the
  // code-point order of the Chinese titles is not the order of the source.
  const titles = body.tests.map((t) => t.title);
  assert.equal(titles.length, 4, 'the catalogue carries four cases');
  for (const want of ['格式检查', '边界值', '范围检查 - 10', '范围检查 - 20']) {
    assert.ok(titles.includes(want), `the catalogue carries "${want}"`);
  }
  // The rendered cases carry their own stable UIDs.
  const rendered = body.tests.filter((t) => t.title.startsWith('范围检查'));
  assert.equal(rendered.length, 2);
  assert.equal(rendered.every((t) => t.uidStable), true);
  assert.equal(new Set(rendered.map((t) => t.uid)).size, 2);
  // The consistency report says the two indexes do NOT agree.
  assert.ok(body.consistency);
  assert.equal(body.consistency.agrees, false);
});

test('ST-ATS203-003: the parameterised same title is refused by the engine and the warning carries the reason', { skip: SKIP }, async () => {
  // A project of its own: the catalogue is per project.
  const other = path.join(WORK, 'dup-project');
  fs.mkdirSync(path.join(other, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(other, 'package.json'), '{"name":"dup","private":true}');
  fs.writeFileSync(
    path.join(other, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n"
  );
  if (PLAYWRIGHT_MODULES) {
    fs.symlinkSync(PLAYWRIGHT_MODULES, path.join(other, 'node_modules'), 'junction');
  }
  fs.writeFileSync(path.join(other, 'tests', 'dup.spec.ts'), [
    "import { test } from '@playwright/test';",
    '',
    'for (const x of [1, 2]) {',
    "  test('同名参数化', async () => {});",
    '}',
    ''
  ].join('\n'));

  const created = await api('/api/projects', 'POST', { path: other });
  assert.equal(created[0], 201);
  const otherId = created[1].project.id;
  await api(`/api/projects/${otherId}/trust`, 'POST', { trust: 'trusted' });

  const catalogue = await api(`/api/projects/${otherId}/tests`);
  assert.equal(catalogue[0], 200);
  const body = catalogue[1];
  assert.equal(body.discovery, 'static', 'the engine refused the project, so the index fell back');
  assert.equal(body.authoritative.outcome, 'PLAYWRIGHT_LIST_FAILED');
  assert.equal(body.authoritative.attempted, true);
  // The reason is the ENGINE's own reason, not a generic sentence.
  assert.match(body.warning, /权威发现失败/);
  assert.match(body.warning, /duplicate test title/);
  assert.equal(body.authoritative.errors.length, 1);
  assert.match(body.authoritative.errors[0].message, /duplicate test title "同名参数化"/);
});

test('ST-ATS203-004: the symmetric project matrix gives every case two spec ids', { skip: SKIP }, async () => {
  const matrix = path.join(WORK, 'matrix-project');
  fs.mkdirSync(path.join(matrix, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(matrix, 'package.json'), '{"name":"matrix","private":true}');
  fs.writeFileSync(
    path.join(matrix, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0, projects: [ { name: 'chromium' }, { name: 'firefox' } ] });\n"
  );
  if (PLAYWRIGHT_MODULES) {
    fs.symlinkSync(PLAYWRIGHT_MODULES, path.join(matrix, 'node_modules'), 'junction');
  }
  fs.writeFileSync(path.join(matrix, 'tests', 'a.spec.ts'),
    "import { test } from '@playwright/test';\ntest('case a', async () => {});\n");
  fs.writeFileSync(path.join(matrix, 'tests', 'b.spec.ts'),
    "import { test } from '@playwright/test';\ntest('case b', async () => {});\n");

  const created = await api('/api/projects', 'POST', { path: matrix });
  assert.equal(created[0], 201);
  const matrixId = created[1].project.id;
  await api(`/api/projects/${matrixId}/trust`, 'POST', { trust: 'trusted' });

  const catalogue = await api(`/api/projects/${matrixId}/tests`);
  assert.equal(catalogue[0], 200);
  const body = catalogue[1];
  assert.equal(body.discovery, 'authoritative');
  assert.equal(body.tests.length, 2, 'the matrix is ONE logical case per case');
  for (const t of body.tests) {
    assert.equal(specIdCount(t), 2, 'every case ran in both projects');
    assert.equal(t.uidStable, true);
  }
  const a = body.tests.find((t) => t.title === 'case a');
  assert.equal(new Set(a.specIds).size, 2, 'the two projects report two different spec ids');
});

test('ST-ATS203-005: the asymmetric project matrix gives the case counts of 2 and 1', { skip: SKIP }, async () => {
  const matrix = path.join(WORK, 'asym-project');
  fs.mkdirSync(path.join(matrix, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(matrix, 'package.json'), '{"name":"asym","private":true}');
  fs.writeFileSync(
    path.join(matrix, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0, projects: [ { name: 'all' }, { name: 'only-a', testMatch: /a\\.spec\\.ts/ } ] });\n"
  );
  if (PLAYWRIGHT_MODULES) {
    fs.symlinkSync(PLAYWRIGHT_MODULES, path.join(matrix, 'node_modules'), 'junction');
  }
  fs.writeFileSync(path.join(matrix, 'tests', 'a.spec.ts'),
    "import { test } from '@playwright/test';\ntest('case a', async () => {});\n");
  fs.writeFileSync(path.join(matrix, 'tests', 'b.spec.ts'),
    "import { test } from '@playwright/test';\ntest('case b', async () => {});\n");

  const created = await api('/api/projects', 'POST', { path: matrix });
  assert.equal(created[0], 201);
  const asymId = created[1].project.id;
  await api(`/api/projects/${asymId}/trust`, 'POST', { trust: 'trusted' });

  const catalogue = await api(`/api/projects/${asymId}/tests`);
  assert.equal(catalogue[0], 200);
  const body = catalogue[1];
  assert.equal(body.discovery, 'authoritative');
  assert.equal(body.tests.length, 2);
  const a = body.tests.find((t) => t.title === 'case a');
  const b = body.tests.find((t) => t.title === 'case b');
  assert.equal(specIdCount(a), 2, 'case a runs in both projects');
  assert.equal(specIdCount(b), 1, 'case b runs only in the project that matches it');
  assert.equal(a.uidStable, true);
  assert.equal(b.uidStable, true);
});

test('ST-ATS203-006: the same title in two files is two cases, and the verdict is carried', { skip: SKIP }, async () => {
  const cross = path.join(WORK, 'cross-project');
  fs.mkdirSync(path.join(cross, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(cross, 'package.json'), '{"name":"cross","private":true}');
  fs.writeFileSync(
    path.join(cross, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n"
  );
  if (PLAYWRIGHT_MODULES) {
    fs.symlinkSync(PLAYWRIGHT_MODULES, path.join(cross, 'node_modules'), 'junction');
  }
  fs.writeFileSync(path.join(cross, 'tests', 'admin.spec.ts'), [
    "import { test } from '@playwright/test';",
    "test.describe('管理员功能', () => {",
    "  test('可以登录', async () => {});",
    '});',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(cross, 'tests', 'user.spec.ts'), [
    "import { test } from '@playwright/test';",
    "test.describe('普通用户功能', () => {",
    "  test('可以登录', async () => {});",
    '});',
    ''
  ].join('\n'));

  const created = await api('/api/projects', 'POST', { path: cross });
  assert.equal(created[0], 201);
  const crossId = created[1].project.id;

  // The STATIC index first (the project is not trusted yet): the two cases
  // share a title, so the static index cannot decide.
  const stat = await api(`/api/projects/${crossId}/tests`);
  assert.equal(stat[0], 200);
  assert.equal(stat[1].discovery, 'static');
  assert.equal(stat[1].tests.length, 2);
  for (const t of stat[1].tests) {
    assert.equal(t.uidStable, false);
    assert.equal(t.ambiguity.reason, 'identical-title-and-body');
  }
  assert.match(stat[1].warning, /2 个用例的 UID 为临时值/);

  // The AUTHORITATIVE index: the describe path makes them decidable.
  await api(`/api/projects/${crossId}/trust`, 'POST', { trust: 'trusted' });
  const auth = await api(`/api/projects/${crossId}/tests`);
  assert.equal(auth[0], 200);
  assert.equal(auth[1].discovery, 'authoritative');
  assert.equal(auth[1].tests.length, 2);
  assert.equal(auth[1].tests.every((t) => t.uidStable), true);
  assert.equal(new Set(auth[1].tests.map((t) => t.uid)).size, 2);
});

test('ST-ATS203-CLEANUP: stop and cleanup', () => {
  if (cp) cp.kill();
  fs.rmSync(WORK, { recursive: true, force: true });
});
