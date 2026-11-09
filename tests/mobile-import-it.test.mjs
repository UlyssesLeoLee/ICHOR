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
import { spawn, spawnSync } from 'node:child_process';

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

/*
 * The TRUSTED path of the catalogue needs a real Playwright install: the
 * authoritative index is `playwright test --list`, and there is no way to
 * fake it -- the command runs the project's own code.
 *
 * The install is done into a scratch directory of its own, so that the
 * fixture of this file stays a fixture. When the install does not succeed
 * (no network, for instance), the test that needs it is SKIPPED -- and the
 * skip says why. A skip is not a pass: the evidence records the skip.
 */
const PW_DIR = path.join(WORK, 'pw');
fs.mkdirSync(PW_DIR, { recursive: true });
fs.writeFileSync(path.join(PW_DIR, 'package.json'), '{"name":"ats602-pw","private":true}', 'utf8');
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const install = fs.existsSync(npmCli)
  ? spawnSync(process.execPath, [npmCli, 'install', '@playwright/test@1.64.1', '--no-audit', '--no-fund'], {
    cwd: PW_DIR, encoding: 'utf8',
  })
  : spawnSync('npm', ['install', '@playwright/test@1.64.1', '--no-audit', '--no-fund'], {
    cwd: PW_DIR, encoding: 'utf8', shell: true,
  });
const installed = install.status === 0 && fs.existsSync(path.join(PW_DIR, 'node_modules', '@playwright', 'test'));

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

/* ------------------------------------------------------------------ */
/* The round-2 counter-examples                                       */
/* ------------------------------------------------------------------ */

/*
 * The round-1 review found that the mobile cases were LOST on the
 * authoritative path, that the registry was never persisted for them, and
 * that a `@TC-` token could be claimed by a web case and a mobile case
 * at once.
 *
 * These are the same counter-examples, driven over HTTP against the REAL
 * Bridge -- because the review found them there, and the answer has to
 * hold there.
 */

test('IT-ATS602-API-009: a retitled mobile case keeps its uid over HTTP', async () => {
  // The registry is persisted, and it holds the MOBILE entries too. So a
  // case whose title is rewritten in place keeps its uid: the registry
  // recognises it by its steps.
  const dir = path.join(WORK, 'retitle');
  fs.mkdirSync(path.join(dir, 'flows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"retitle","private":true}', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'tests', 'a.spec.ts'),
    "import { test } from '@playwright/test';\ntest('a web case', async ({ page }) => {});\n",
    'utf8',
  );
  const flow = path.join(dir, 'flows', 'login.yaml');
  const write = (title) => fs.writeFileSync(
    flow,
    `appId: com.example.app\n---\n- name: "${title}"\n  steps:\n    - launchApp\n    - tapOn: "Login"\n`,
    'utf8',
  );
  write('Old title');
  const r = await api('/api/projects', 'POST', { path: dir });
  assert.equal(r[0], 201);
  const pid = r[1].project.id;

  const [, before] = await api(`/api/projects/${pid}/tests`);
  const m1 = before.tests.find((t) => t.source === 'mobile');
  assert.ok(m1, 'the mobile case is in the catalogue');
  assert.ok(m1.uid);

  // The title is rewritten in place.
  write('New title');
  const [, after] = await api(`/api/projects/${pid}/tests`);
  const m2 = after.tests.find((t) => t.source === 'mobile');
  assert.ok(m2, 'the mobile case is still in the catalogue');
  assert.equal(m2.uid, m1.uid, 'the uid survives the retitle');
  assert.equal(m2.uidSource, 'registry', 'and the registry is what recognised it');
});

test('IT-ATS602-API-010: a @TC- token that a web case and a mobile case claim binds to neither', async () => {
  const dir = path.join(WORK, 'dup-tc');
  fs.mkdirSync(path.join(dir, 'flows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"dup","private":true}', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'tests', 'a.spec.ts'),
    "import { test } from '@playwright/test';\ntest('web login @TC-100', async ({ page }) => {});\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'flows', 'a.yaml'),
    '---\n- name: "mobile login @TC-100"\n  steps:\n    - tapOn: "x"\n',
    'utf8',
  );
  const r = await api('/api/projects', 'POST', { path: dir });
  assert.equal(r[0], 201);
  const [, catalog] = await api(`/api/projects/${r[1].project.id}/tests`);
  const uids = catalog.tests.map((t) => t.uid);
  assert.equal(new Set(uids).size, uids.length, 'no two cases share a uid');
  const dup = catalog.tests.filter((t) => t.ambiguity?.reason === 'duplicate-explicit-uid');
  assert.equal(dup.length, 2, 'the web case and the mobile one are both reported');
  for (const t of dup) {
    assert.equal(t.uidStable, false, 'neither of them is bound to the token');
    assert.notEqual(t.uid, 'tc-100');
  }
  assert.match(catalog.warning, /重复的显式 UID/);
});

test('IT-ATS602-API-011: a trusted project keeps its mobile cases', { skip: installed ? false : 'no real Playwright' }, async () => {
  // The authoritative index knows the web cases better than the static
  // one does -- it sees the dynamic ones -- but it knows NOTHING about
  // the mobile ones. Without the mobile import on that path, a project
  // that was marked as trusted would LOSE its mobile cases: they would
  // not be moved somewhere else, they would simply be gone.
  const dir = path.join(WORK, 'trusted');
  fs.mkdirSync(path.join(dir, 'flows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"trusted","private":true}', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'tests', 'a.spec.ts'),
    "import { test } from '@playwright/test';\ntest('a web case', async ({ page }) => {});\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'flows', 'a.yaml'),
    'appId: com.example.app\n---\n- name: "a mobile case"\n  steps:\n    - launchApp\n    - tapOn: "Login"\n',
    'utf8',
  );
  // The authoritative index runs `playwright test --list` INSIDE the
  // project, so the project needs the Playwright install. It is a
  // JUNCTION to the scratch install -- the fixture stays a fixture and
  // nothing is copied into the repository.
  fs.symlinkSync(path.join(PW_DIR, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const r = await api('/api/projects', 'POST', { path: dir });
  assert.equal(r[0], 201);
  const pid = r[1].project.id;

  const [, untrusted] = await api(`/api/projects/${pid}/tests`);
  assert.equal(untrusted.discovery, 'static');
  assert.equal(untrusted.tests.filter((t) => t.source === 'mobile').length, 1);

  const grant = await api(`/api/projects/${pid}/trust`, 'POST', { trust: 'trusted', reason: 'the mobile cases have to survive' });
  assert.equal(grant[0], 200);

  const [, trusted] = await api(`/api/projects/${pid}/tests`);
  assert.equal(trusted.discovery, 'authoritative', 'the trusted project gets the authoritative index');
  // The mobile cases are still there.
  const mobile = trusted.tests.filter((t) => t.source === 'mobile');
  assert.equal(mobile.length, 1, 'the mobile case survives the switch to the authoritative index');
  assert.equal(mobile[0].title, 'a mobile case');
  assert.deepEqual(mobile[0].steps.map((s) => s.kind), ['launchApp', 'tapOn']);
  // And the section is reported, so a reader can see them.
  assert.ok(trusted.mobile, 'the catalogue carries the mobile section');
  assert.equal(trusted.mobile.cases, 1);
});

/*
 * The round-2 review counter-examples over HTTP (N1 / N2-cross / N3).
 *
 * Each test registers a project of its own, edits its files between two
 * `GET /tests` calls, and asserts after EVERY call that no two cases of
 * the catalogue share a uid -- the IT-007 rule, applied to an edit
 * sequence instead of a fixture that never changes.
 */
function newProjectDir(name, files) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(path.join(dir, 'flows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `{"name":"${name}","private":true}`, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n",
    'utf8',
  );
  const write = (rel, body) => fs.writeFileSync(path.join(dir, rel), body, 'utf8');
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  return { dir, write };
}

function assertNoDuplicateUids(catalog) {
  const uids = catalog.tests.map((t) => t.uid);
  assert.equal(new Set(uids).size, uids.length, `no two cases share a uid: ${JSON.stringify(catalog.tests.map((t) => [t.title, t.uid]))}`);
}

const WEB_HEAD = "import { test } from '@playwright/test';\n";

test('IT-ATS602-API-012: a token a mobile case drops and a web case declares is not re-issued over HTTP (N2-cross)', async () => {
  const { dir, write } = newProjectDir('n2-cross', {
    'tests/a.spec.ts': WEB_HEAD + "test('web case', async ({ page }) => { const w = 1; });\n",
    'flows/a.yaml': '---\n- name: "Login @TC-600"\n  steps:\n    - tapOn: "Login"\n',
  });
  const r = await api('/api/projects', 'POST', { path: dir });
  assert.equal(r[0], 201);
  const pid = r[1].project.id;

  const [, first] = await api(`/api/projects/${pid}/tests`);
  assertNoDuplicateUids(first);
  assert.equal(first.tests.find((t) => t.source === 'mobile').uid, 'tc-600');

  write('tests/a.spec.ts', WEB_HEAD + "test('web case @TC-600', async ({ page }) => { const w = 1; });\n");
  write('flows/a.yaml', '---\n- name: Login\n  steps:\n    - tapOn: "Login"\n');
  const [, second] = await api(`/api/projects/${pid}/tests`);
  assertNoDuplicateUids(second);
  const web = second.tests.find((t) => t.source === 'static');
  const mobile = second.tests.find((t) => t.source === 'mobile');
  assert.equal(web.uid, 'tc-600');
  assert.equal(web.uidSource, 'explicit');
  assert.notEqual(mobile.uid, 'tc-600', 'the registry does not hand the token back to the scenario');
  assert.equal(mobile.uidSource, 'derived');
  assert.equal(mobile.ambiguity?.reason, 'explicit-uid-claimed-by-another-case', 'the refused hit is reported');
});

test('IT-ATS602-API-013: copying a scenario and editing the original keeps the uids distinct over HTTP (N3)', async () => {
  const { dir, write } = newProjectDir('n3-copy', {
    'tests/a.spec.ts': WEB_HEAD + "test('a web case', async ({ page }) => {});\n",
    'flows/dup.yaml': '---\n- name: Checkout\n  steps:\n    - launchApp: {appId: x}\n    - tapOn: "Pay"\n',
  });
  const r = await api('/api/projects', 'POST', { path: dir });
  assert.equal(r[0], 201);
  const pid = r[1].project.id;

  const [, first] = await api(`/api/projects/${pid}/tests`);
  assertNoDuplicateUids(first);
  const old = first.tests.find((t) => t.title === 'Checkout').uid;

  write('flows/dup.yaml', '---\n- name: Checkout\n  steps:\n    - launchApp: {appId: x}\n    - tapOn: "Pay"\n    - assertVisible: "Receipt"\n- name: Checkout copy\n  steps:\n    - launchApp: {appId: x}\n    - tapOn: "Pay"\n');
  const [, second] = await api(`/api/projects/${pid}/tests`);
  assertNoDuplicateUids(second);
  const original = second.tests.find((t) => t.title === 'Checkout');
  const copy = second.tests.find((t) => t.title === 'Checkout copy');
  assert.equal(copy.uid, old, 'the copy keeps the uid the registry remembers for those steps');
  assert.equal(copy.uidSource, 'registry');
  assert.notEqual(original.uid, old, 'the edited original gets a uid of its own');
  assert.equal(original.uidSource, 'derived-body');
  assert.equal(original.uidStable, true);
});

test('IT-ATS602-API-014: a trusted project does not hand a deleted uid to a new case with the same body (N1)', { skip: installed ? false : 'no real Playwright' }, async () => {
  // The authoritative index runs `playwright test --list` inside the
  // project, so the project needs the scratch Playwright install (a
  // junction, nothing is copied into the repository).
  const ALPHA = "test('alpha', async () => { const a = 1; expect(a).toBe(1); });\n";
  const BETA_BODY = 'async () => { const b = 2; expect(b + 40).toBe(42); }';
  const HEAD = "import { test, expect } from '@playwright/test';\n";
  const { dir, write } = newProjectDir('n1-trusted', {
    'tests/a.spec.ts': HEAD + ALPHA + `test('beta', ${BETA_BODY});\n`,
    'flows/login.yaml': 'appId: com.example.app\n---\n- name: Login\n  steps:\n    - launchApp\n    - tapOn: "Login"\n- name: Logout\n  steps:\n    - launchApp\n    - tapOn: "Logout"\n',
  });
  fs.symlinkSync(path.join(PW_DIR, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const r = await api('/api/projects', 'POST', { path: dir });
  assert.equal(r[0], 201);
  const pid = r[1].project.id;
  const grant = await api(`/api/projects/${pid}/trust`, 'POST', { trust: 'trusted', reason: 'N1 over the authoritative path' });
  assert.equal(grant[0], 200);

  const [, c1] = await api(`/api/projects/${pid}/tests`);
  assert.equal(c1.discovery, 'authoritative');
  assertNoDuplicateUids(c1);
  assert.equal(c1.tests.length, 4);
  const beta = c1.tests.find((t) => t.title === 'beta');
  const logout = c1.tests.find((t) => t.title === 'Logout');

  // Discovery 2: beta and Logout are deleted.
  write('tests/a.spec.ts', HEAD + ALPHA);
  write('flows/login.yaml', 'appId: com.example.app\n---\n- name: Login\n  steps:\n    - launchApp\n    - tapOn: "Login"\n');
  const [, c2] = await api(`/api/projects/${pid}/tests`);
  assert.equal(c2.discovery, 'authoritative');
  assertNoDuplicateUids(c2);
  assert.equal(c2.tests.length, 2);

  // Discovery 3: a NEW web test and a NEW scenario re-use the deleted bodies.
  write('tests/a.spec.ts', HEAD + ALPHA + `test('gamma is a new test', ${BETA_BODY});\n`);
  write('flows/login.yaml', 'appId: com.example.app\n---\n- name: Login\n  steps:\n    - launchApp\n    - tapOn: "Login"\n- name: A brand new scenario\n  steps:\n    - launchApp\n    - tapOn: "Logout"\n');
  const [, c3] = await api(`/api/projects/${pid}/tests`);
  assert.equal(c3.discovery, 'authoritative');
  assertNoDuplicateUids(c3);
  const gamma = c3.tests.find((t) => t.title === 'gamma is a new test');
  const fresh = c3.tests.find((t) => t.title === 'A brand new scenario');
  assert.notEqual(gamma.uid, beta.uid, 'a new web case does not inherit the uid of a deleted one');
  assert.notEqual(gamma.uidSource, 'registry');
  assert.notEqual(fresh.uid, logout.uid, 'a new scenario does not inherit the uid of a deleted one');
  assert.notEqual(fresh.uidSource, 'registry');
});

test('IT-ATS602-API-CLEANUP: stop the bridge and remove the fixture', async () => {
  cp.kill();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(WORK, { recursive: true, force: true });
});
