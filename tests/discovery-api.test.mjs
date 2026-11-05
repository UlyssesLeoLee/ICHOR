/**
 * ATS-202: the API surface of the authoritative discovery.
 *
 * The tests drive the REAL Bridge over HTTP, against a REAL fixture project
 * with a REAL `@playwright/test`. They cover the parts a user touches:
 *
 *   * the trust endpoint (grant, read, revoke);
 *   * the discovery mode that the trust selects;
 *   * the `?authoritative=true` request and its refusal for an untrusted
 *     project;
 *   * the failure of the listing and its fallback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ats202-api-'));
const FIXTURE = path.join(WORK, 'project');
const data = path.join(WORK, 'data');
const port = await freePort();

fs.mkdirSync(path.join(FIXTURE, 'tests'), { recursive: true });
fs.writeFileSync(path.join(FIXTURE, 'package.json'), '{"name":"ats202-api","private":true}', 'utf8');
fs.writeFileSync(
  path.join(FIXTURE, 'playwright.config.ts'),
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n",
  'utf8'
);
fs.writeFileSync(path.join(FIXTURE, 'tests', 'plain.spec.ts'), [
  "import { test } from '@playwright/test';",
  "test('plain case', async ({ page }) => {});",
  ''
].join('\n'));
fs.writeFileSync(path.join(FIXTURE, 'tests', 'dynamic.spec.ts'), [
  "import { test } from '@playwright/test';",
  "for (const n of ['alpha', 'beta']) {",
  "  test(`dynamic ${n}`, async ({ page }) => {});",
  "}",
  ''
].join('\n'));

const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const install = spawnSync(process.execPath, [npmCli, 'install', '@playwright/test@1.64.1', '--no-audit', '--no-fund'], {
  cwd: FIXTURE, encoding: 'utf8',
});
const installed = install.status === 0;

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
    body: payload ? JSON.stringify(payload) : undefined
  });
  return [r.status, await r.json()];
}

test('IT-ATS202-API-SETUP: start the bridge', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data }, stdio: 'ignore'
  });
  await ready();
  token = (await api('/api/session'))[1].token;
  assert.ok(token);
  const r = await api('/api/projects', 'POST', { path: FIXTURE });
  assert.equal(r[0], 201);
  projectId = r[1].project.id;
});

test('IT-ATS202-API-001: a project starts untrusted', async () => {
  const r = await api(`/api/projects/${projectId}/trust`);
  assert.equal(r[0], 200);
  assert.equal(r[1].trust.trust, 'untrusted');
  assert.ok(r[1].trust.reason, 'the reason is reported');
});

test('IT-ATS202-API-002: an untrusted project gets the STATIC index', async () => {
  const r = await api(`/api/projects/${projectId}/tests`);
  assert.equal(r[0], 200);
  assert.equal(r[1].discovery, 'static');
  assert.equal(r[1].authoritative.attempted, false);
  assert.equal(r[1].authoritative.outcome, 'SKIPPED_UNTRUSTED');
  // The static index does NOT see the rendered dynamic titles.
  assert.equal(r[1].tests.some((t) => t.title === 'dynamic alpha'), false);
});

test('IT-ATS202-API-003: an invalid trust value is refused', async () => {
  const r = await api(`/api/projects/${projectId}/trust`, 'POST', { trust: 'maybe' });
  assert.equal(r[0], 400);
  assert.equal(r[1].error, 'INVALID_TRUST_VALUE');
});

test('IT-ATS202-API-004: forcing the authoritative index on an untrusted project is refused', async () => {
  const r = await api(`/api/projects/${projectId}/tests?authoritative=true`);
  assert.equal(r[0], 200);
  assert.equal(r[1].discovery, 'static');
  assert.equal(r[1].authoritative.attempted, false);
  assert.match(r[1].warning, /未可信仓库不可调用/);
});

test('IT-ATS202-API-005: the trust can be granted, and the index switches', { skip: installed ? false : 'no real Playwright' }, async () => {
  const grant = await api(`/api/projects/${projectId}/trust`, 'POST', { trust: 'trusted' });
  assert.equal(grant[0], 200);
  assert.equal(grant[1].trust.trust, 'trusted');

  const r = await api(`/api/projects/${projectId}/tests`);
  assert.equal(r[0], 200);
  assert.equal(r[1].discovery, 'authoritative');
  assert.equal(r[1].authoritative.outcome, 'OK');
  assert.equal(r[1].authoritative.version, '1.64.1');
  // The dynamic cases are in the index now.
  const dynamic = r[1].tests.filter((t) => t.title.startsWith('dynamic '));
  assert.equal(dynamic.length, 2);
  assert.deepEqual(dynamic.map((t) => t.title).sort(), ['dynamic alpha', 'dynamic beta']);
  // They carry distinct, stable UIDs.
  assert.equal(new Set(dynamic.map((t) => t.uid)).size, 2);
  assert.equal(dynamic.every((t) => t.uidStable), true);
  // And the describe path is reported.
  assert.ok(Array.isArray(dynamic[0].describePath));
  // The consistency report is present.
  assert.ok(r[1].consistency);
  assert.equal(r[1].consistency.authoritative, r[1].tests.length);
});

test('IT-ATS202-API-006: the trust survives a restart of the bridge', async () => {
  cp.kill();
  await new Promise((r) => setTimeout(r, 300));
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data }, stdio: 'ignore'
  });
  await ready();
  token = (await api('/api/session'))[1].token;
  const r = await api(`/api/projects/${projectId}/trust`);
  assert.equal(r[1].trust.trust, 'trusted');
});

test('IT-ATS202-API-007: the trust can be revoked, and the index falls back', async () => {
  const revoke = await api(`/api/projects/${projectId}/trust`, 'POST', { trust: 'untrusted', reason: 'revoked by the user' });
  assert.equal(revoke[0], 200);
  assert.equal(revoke[1].trust.trust, 'untrusted');
  assert.equal(revoke[1].trust.reason, 'revoked by the user');
  const r = await api(`/api/projects/${projectId}/tests`);
  assert.equal(r[1].discovery, 'static');
  assert.equal(r[1].authoritative.attempted, false);
});

test('IT-ATS202-API-CLEANUP: stop and cleanup', () => {
  cp.kill();
  fs.rmSync(WORK, { recursive: true, force: true });
});
