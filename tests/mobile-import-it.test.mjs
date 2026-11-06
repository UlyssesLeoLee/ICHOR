/**
 * ATS-602: the mobile Flow import -- the integration tests.
 *
 * WHAT THESE TESTS DO
 * -------------------
 * They drive the REAL Bridge over HTTP against a REAL fixture project that
 * holds REAL Flow files, and they read the REAL catalogue the platform
 * serves. The unit tests (tests/mobile-import.test.mjs) prove that the
 * mapping is right; these prove that the mapping REACHES the user:
 *
 *   * the mobile cases are in the catalogue the API serves;
 *   * they carry the same shape as the web cases, so the UI can show them
 *     without a second kind of case;
 *   * the import report is served with the catalogue, so the author of a
 *     Flow learns which of their steps the platform cannot run;
 *   * the UID of a mobile case survives a restart of the Bridge -- the
 *     registry is persisted, and a case that changes its UID on every
 *     restart would break every link built on it.
 *
 * The fixture needs no device, no SDK and no driver: the import is a
 * contract-level operation. That is stated in the evidence, not hidden.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ats602-it-'));
const FIXTURE = path.join(WORK, 'project');
const data = path.join(WORK, 'data');
const port = await freePort();

/**
 * The fixture: one web case and two Flow files -- one in the YAML syntax,
 * one in the linear syntax -- plus a Flow with a step the platform does
 * not support.
 */
const MAESTRO_FLOW = `appId: com.example.app
---
- name: Login with email
  tags:
    - smoke
  steps:
    - launchApp:
        appId: com.example.app
    - tapOn: "Login"
    - assertVisible: "Welcome"
- name: Browse the catalogue
  steps:
    - launchApp
    - tapOn: "Catalogue"
`;

const LINEAR_FLOW = `app: com.example.app
scenario: Pay with a card
  tags: payment
  launch com.example.app
  tap "Pay"
  assert visible "Receipt"
`;

const UNSUPPORTED_FLOW = `appId: com.example.app
---
- name: A scenario with a step the platform cannot run
  steps:
    - launchApp
    - swipe: "left"
    - pinch: "in"
`;

fs.mkdirSync(path.join(FIXTURE, 'tests'), { recursive: true });
fs.mkdirSync(path.join(FIXTURE, 'flows'), { recursive: true });
fs.writeFileSync(path.join(FIXTURE, 'package.json'), '{"name":"ats602-it","private":true}', 'utf8');
// The project registration requires a package.json AND a playwright config:
// the Bridge refuses a project without them (see `validateProjectPath`).
fs.writeFileSync(
  path.join(FIXTURE, 'playwright.config.ts'),
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n",
  'utf8',
);
fs.writeFileSync(
  path.join(FIXTURE, 'tests', 'login.spec.ts'),
  "import { test } from '@playwright/test';\ntest('login works', async ({ page }) => {});\n",
  'utf8',
);
fs.writeFileSync(path.join(FIXTURE, 'flows', 'login.yaml'), MAESTRO_FLOW, 'utf8');
fs.writeFileSync(path.join(FIXTURE, 'flows', 'pay.flow'), LINEAR_FLOW, 'utf8');
fs.writeFileSync(path.join(FIXTURE, 'flows', 'unsupported.yaml'), UNSUPPORTED_FLOW, 'utf8');

let cp, token, projectId;

async function ready() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('server did not boot');
}

async function api(endpoint, method = 'GET', payload) {
  const r = await fetch(`http://127.0.0.1:${port}` + endpoint, {
    method,
    headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return [r.status, await r.json()];
}

test('IT-ATS602-API-SETUP: start the bridge', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data }, stdio: 'ignore',
  });
  await ready();
  token = (await api('/api/session'))[1].token;
  assert.ok(token);
  const r = await api('/api/projects', 'POST', { path: FIXTURE });
  assert.equal(r[0], 201);
  projectId = r[1].project.id;
});

test('IT-ATS602-API-001: the mobile cases are in the catalogue the API serves', async () => {
  const [status, catalog] = await api(`/api/projects/${projectId}/tests`);
  assert.equal(status, 200);
  const mobile = catalog.tests.filter((t) => t.source === 'mobile');
  const web = catalog.tests.filter((t) => t.source === 'static');
  // The web case is still there, and the mobile cases joined it.
  assert.equal(web.length, 1);
  assert.equal(mobile.length, 4, 'two YAML scenarios, one linear scenario, one unsupported-flow scenario');
  // Every mobile case is a TestDefinition like the web ones.
  for (const t of mobile) {
    assert.ok(t.uid, 'the case has a uid');
    assert.equal(t.uidStable, true);
    assert.equal(t.level, 'ST');
    assert.equal(typeof t.line, 'number');
    assert.ok(t.file.startsWith('flows/'));
  }
});

test('IT-ATS602-API-002: the mobile case carries its steps and its engine', async () => {
  const [, catalog] = await api(`/api/projects/${projectId}/tests`);
  const login = catalog.tests.find((t) => t.source === 'mobile' && t.title === 'Login with email');
  assert.ok(login, 'the scenario is in the catalogue');
  assert.equal(login.engine, 'mobile');
  assert.equal(login.appId, 'com.example.app');
  assert.deepEqual(login.tags, ['smoke']);
  assert.deepEqual(login.steps.map((s) => s.kind), ['launchApp', 'tapOn', 'assertVisible']);
  // The assertion is the unified model's assertion.
  assert.deepEqual(login.steps[2].assertion, { visible: 'Welcome' });
});

test('IT-ATS602-API-003: the import report is served with the catalogue', async () => {
  const [, catalog] = await api(`/api/projects/${projectId}/tests`);
  assert.ok(catalog.mobile, 'the catalogue carries the mobile section');
  assert.equal(catalog.mobile.cases, 4);
  // The unsupported steps are counted and REPORTED, never dropped.
  assert.equal(catalog.mobile.unsupportedSteps, 2, 'the swipe and the pinch');
  const reports = catalog.mobile.imports;
  assert.equal(reports.length, 3, 'one report per Flow file');
  const unsupported = reports.find((r) => r.file === 'flows/unsupported.yaml');
  assert.ok(unsupported, 'the Flow with the unsupported steps has its own report');
  assert.equal(unsupported.unsupportedSteps, 2);
  // The report keeps the ORIGINAL text and the line of every one of them.
  const details = unsupported.unsupportedSteps_detail;
  assert.equal(details.length, 2);
  for (const step of details) {
    assert.ok(step.raw.length > 0, 'the original text is kept');
    assert.ok(step.line > 0, 'the line is reported');
    assert.ok(step.reason.length > 0, 'the reason is reported');
  }
  assert.match(details[0].raw, /swipe/);
});

test('IT-ATS602-API-004: the warning says that steps were not supported', async () => {
  const [, catalog] = await api(`/api/projects/${projectId}/tests`);
  assert.match(catalog.warning, /移动端 Flow 导入 4 个用例/);
  assert.match(catalog.warning, /2 个移动端步骤不受支持/);
});

test('IT-ATS602-API-005: the two syntaxes produce the SAME kind of case', async () => {
  const [, catalog] = await api(`/api/projects/${projectId}/tests`);
  const mobile = catalog.tests.filter((t) => t.source === 'mobile');
  const pay = mobile.find((t) => t.title === 'Pay with a card');
  const login = mobile.find((t) => t.title === 'Login with email');
  assert.ok(pay);
  assert.ok(login);
  // The linear Flow maps onto the same step kinds as the YAML one.
  assert.deepEqual(pay.steps.map((s) => s.kind), ['launchApp', 'tapOn', 'assertVisible']);
  assert.deepEqual(pay.steps[2].assertion, { visible: 'Receipt' });
  // And both carry the same shape.
  assert.deepEqual(Object.keys(pay).sort(), Object.keys(login).sort());
});

test('IT-ATS602-API-006: the uid of a mobile case survives a restart of the bridge', async () => {
  const [, before] = await api(`/api/projects/${projectId}/tests`);
  const beforeUids = before.tests.filter((t) => t.source === 'mobile').map((t) => t.uid).sort();
  assert.equal(beforeUids.length, 4);

  cp.kill();
  await new Promise((r) => setTimeout(r, 300));
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data }, stdio: 'ignore',
  });
  await ready();
  // The Bridge mints a NEW session token on every start, so the client has
  // to read it again -- the old one is not valid any more.
  token = (await api('/api/session'))[1].token;

  const [, after] = await api(`/api/projects/${projectId}/tests`);
  const afterUids = after.tests.filter((t) => t.source === 'mobile').map((t) => t.uid).sort();
  assert.deepEqual(afterUids, beforeUids, 'the uids survive the restart');
});

test('IT-ATS602-API-007: the uids of the mobile cases are distinct from the web ones', async () => {
  const [, catalog] = await api(`/api/projects/${projectId}/tests`);
  const uids = catalog.tests.map((t) => t.uid);
  assert.equal(new Set(uids).size, uids.length, 'no two cases share a uid');
});

test('IT-ATS602-API-008: a project without a Flow has no mobile cases', async () => {
  const plain = path.join(WORK, 'plain');
  fs.mkdirSync(path.join(plain, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'package.json'), '{"name":"plain","private":true}', 'utf8');
  fs.writeFileSync(
    path.join(plain, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(plain, 'tests', 'a.spec.ts'),
    "import { test } from '@playwright/test';\ntest('only a web case', async ({ page }) => {});\n",
    'utf8',
  );
  const r = await api('/api/projects', 'POST', { path: plain });
  assert.equal(r[0], 201);
  const [, catalog] = await api(`/api/projects/${r[1].project.id}/tests`);
  assert.equal(catalog.tests.filter((t) => t.source === 'mobile').length, 0);
  assert.equal(catalog.mobile.cases, 0);
});

test('IT-ATS602-API-CLEANUP: stop the bridge and remove the fixture', async () => {
  cp.kill();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(WORK, { recursive: true, force: true });
});
