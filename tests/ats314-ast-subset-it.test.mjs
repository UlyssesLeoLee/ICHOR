/**
 * ATS-314: the CONTROLLED STEP SUBSET DETECTOR -- the integration tests.
 *
 * WHAT THESE TESTS DO
 * -------------------
 * They drive the REAL Bridge over HTTP against a REAL fixture project.
 * The unit tests (tests/ats314-ast-subset.test.mjs) prove that the
 * detector classifies correctly; these prove that the classification
 * REACHES the user:
 *
 *   * the endpoint answers with the verdict, the counts and the steps;
 *   * a read-only step carries its reason, so the UI can say WHY;
 *   * the endpoint is a READ: the fixture's files are byte-identical
 *     before and after the call -- the detector recognises, it does not
 *     write;
 *   * the endpoint accepts exactly the files the source endpoint
 *     accepts, and refuses the others with the same codes;
 *   * the endpoint needs the session token, like every other endpoint.
 *
 * The fixture needs no browser, no device and no network: the detector
 * is a read over files that are already on disk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ats314-it-'));
const FIXTURE = path.join(WORK, 'project');
const data = path.join(WORK, 'data');
const port = await freePort();

let cp;
let token;
let projectId;

/**
 * The fixture project: a Playwright project (so the Bridge accepts it)
 * with THREE scripts:
 *
 *   controlled.spec.ts -- every step is on the whitelist with static
 *                        arguments. The verdict must be `writable`.
 *   mixed.spec.ts      -- one controlled step and one refused step.
 *                        The verdict must be `partial`.
 *   helper.spec.ts     -- a helper call and a computed argument. The
 *                        verdict must be `read-only`, and both refusals
 *                        must carry their reason.
 */
function writeProject() {
  fs.mkdirSync(path.join(FIXTURE, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE, 'package.json'), '{"name":"fixture"}');
  fs.writeFileSync(path.join(FIXTURE, 'playwright.config.ts'), 'export default {};');
  fs.writeFileSync(path.join(FIXTURE, 'tests', 'controlled.spec.ts'), [
    "import { test, expect } from '@playwright/test';",
    "test('the controlled case', async ({ page }) => {",
    "  await page.goto('/login');",
    "  await page.locator('#name').fill('Bob');",
    "  await expect(page.locator('#greeting')).toHaveText('hello');",
    "});",
  ].join('\n'));
  fs.writeFileSync(path.join(FIXTURE, 'tests', 'mixed.spec.ts'), [
    "import { test, expect } from '@playwright/test';",
    "test('the mixed case', async ({ page }) => {",
    "  await page.goto('/login');",
    "  await page.setContent('<h1>hi</h1>');",
    "  await expect(page.locator('#greeting')).toHaveText('hello');",
    "});",
  ].join('\n'));
  fs.writeFileSync(path.join(FIXTURE, 'tests', 'helper.spec.ts'), [
    "import { test } from '@playwright/test';",
    "async function login(page) {",
    "  await page.goto('/login');",
    "}",
    "test('the helper case', async ({ page }) => {",
    "  await login(page);",
    "  await page.goto(url);",
    "});",
  ].join('\n'));
}
writeProject();

/** The digest of every file of the fixture: the proof the detector rewrote nothing. */
function fixtureDigest() {
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), child);
      else files.push(child);
    }
  };
  walk(FIXTURE, '');
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\u0000');
    hash.update(fs.readFileSync(path.join(FIXTURE, rel)));
    hash.update('\u0000');
  }
  return { digest: hash.digest('hex'), count: files.length };
}

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

async function api(endpoint, method = 'GET', payload, auth = true) {
  const r = await fetch(`http://127.0.0.1:${port}` + endpoint, {
    method,
    headers: auth ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {},
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return [r.status, await r.json()];
}

test('IT-ATS314-API-SETUP: start the bridge and register the fixture project', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data },
    stdio: 'ignore',
  });
  await ready();
  const r = await api('/api/session');
  token = r[1].token;
  assert.ok(token);
  const add = await api('/api/projects', 'POST', { path: FIXTURE });
  assert.equal(add[0], 201);
  projectId = add[1].project.id;
});

test('IT-ATS314-API-001: the endpoint answers with the verdict, the counts and the steps', async () => {
  const r = await api(`/api/projects/${projectId}/ast-subset?file=tests/controlled.spec.ts`);
  assert.equal(r[0], 200);
  const body = r[1];
  assert.equal(body.editability, 'writable', JSON.stringify(body));
  assert.equal(body.writable, true);
  assert.equal(body.counts.total, 3, JSON.stringify(body.counts));
  assert.equal(body.counts.controlled, 3);
  assert.equal(body.counts.readOnly, 0);
  // The steps name the APIs they recognised.
  const apis = body.steps.map((s) => s.api).sort();
  assert.deepEqual(apis, ['expect.toHaveText', 'locator.fill', 'page.goto']);
  // The case declaration is a container, not a step.
  assert.equal(body.containers.length, 1);
  assert.equal(body.containers[0].kind, 'test');
});

test('IT-ATS314-API-002: a file with a refused step is PARTIAL, and it is not writable', async () => {
  const r = await api(`/api/projects/${projectId}/ast-subset?file=tests/mixed.spec.ts`);
  assert.equal(r[0], 200);
  const body = r[1];
  assert.equal(body.editability, 'partial');
  assert.equal(body.writable, false, 'a file the platform does not fully understand is not writable');
  assert.equal(body.counts.controlled, 2);
  assert.equal(body.counts.readOnly, 1);
  // The refusal names the API and the reason.
  const refused = body.steps.find((s) => s.editability === 'read-only');
  assert.equal(refused.chain, 'page.setContent');
  assert.equal(refused.reason, 'not-whitelisted');
  assert.equal(body.reasons['not-whitelisted'], 1);
});

test('IT-ATS314-API-003: every refusal carries a reason, so the UI can say WHY', async () => {
  const r = await api(`/api/projects/${projectId}/ast-subset?file=tests/helper.spec.ts`);
  assert.equal(r[0], 200);
  const body = r[1];
  assert.equal(body.editability, 'read-only');
  assert.equal(body.writable, false);
  // The helper call is refused as not whitelisted, and the computed
  // argument is refused as not static -- TWO different reasons.
  const reasons = body.steps.map((s) => s.reason);
  assert.ok(reasons.includes('not-whitelisted'), JSON.stringify(reasons));
  assert.ok(reasons.includes('argument-not-static'), JSON.stringify(reasons));
  // And the step inside the helper function is refused as such: the
  // platform may not move a step out of a function that may be called
  // from several places.
  assert.ok(reasons.includes('inside-local-function'), JSON.stringify(reasons));
  // And the reason counts add up to the read-only count.
  const total = Object.values(body.reasons).reduce((a, b) => a + b, 0);
  assert.equal(total, body.counts.readOnly);
});

test('IT-ATS314-API-004: the detector does not change a byte of the project', async () => {
  const before = fixtureDigest();
  await api(`/api/projects/${projectId}/ast-subset?file=tests/controlled.spec.ts`);
  await api(`/api/projects/${projectId}/ast-subset?file=tests/mixed.spec.ts`);
  await api(`/api/projects/${projectId}/ast-subset?file=tests/helper.spec.ts`);
  const after = fixtureDigest();
  assert.equal(after.digest, before.digest, 'the detector must not rewrite the file');
  assert.equal(after.count, before.count);
});

test('IT-ATS314-API-005: the detector is a READ -- there is no write endpoint', async () => {
  const r = await api(`/api/projects/${projectId}/ast-subset?file=tests/controlled.spec.ts`, 'POST', {});
  assert.equal(r[0], 404, 'the detector must not be writable');
});

test('IT-ATS314-API-006: the endpoint accepts exactly the files the source endpoint accepts', async () => {
  // A file that is not a test script is refused -- with the same code
  // the source endpoint uses.
  const r = await api(`/api/projects/${projectId}/ast-subset?file=package.json`);
  assert.equal(r[0], 400);
  assert.equal(r[1].error, 'INVALID_SOURCE_FILE');

  // A path outside the project is refused as well.
  const outside = await api(`/api/projects/${projectId}/ast-subset?file=../escape.spec.ts`);
  assert.equal(outside[0], 400);

  // And the source endpoint refuses the same file with the same code.
  const src = await api(`/api/projects/${projectId}/source?file=package.json`);
  assert.equal(src[0], 400);
  assert.equal(src[1].error, r[1].error, 'the two endpoints must refuse the same files');
});

test('IT-ATS314-API-007: the endpoint needs the session token', async () => {
  const r = await api(`/api/projects/${projectId}/ast-subset?file=tests/controlled.spec.ts`, 'GET', undefined, false);
  assert.equal(r[0], 401);
});

test('IT-ATS314-API-008: the answer names the detector version it came from', async () => {
  const r = await api(`/api/projects/${projectId}/ast-subset?file=tests/controlled.spec.ts`);
  assert.equal(r[1].version, 1);
});

test('IT-ATS314-API-CLEANUP: stop the bridge and remove the fixture', async () => {
  cp.kill();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(WORK, { recursive: true, force: true });
});
