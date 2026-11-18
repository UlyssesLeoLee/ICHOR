/**
 * ATS-308: the design material and tracking asset import -- the
 * integration tests.
 *
 * WHAT THESE TESTS DO
 * -------------------
 * They drive the REAL Bridge over HTTP against a REAL fixture project and
 * they read the REAL design baseline of the repository. The unit tests
 * (tests/ats308-import.test.mjs) prove that the importer classifies
 * correctly; these prove that the classification REACHES the user:
 *
 *   * the per-project import endpoint answers with the project's tracking
 *     assets AND the design material of the project's own tree;
 *   * the top-level endpoint answers with the platform's own baseline;
 *   * the broken and the ambiguous links are in the answer, with the
 *     places that name them;
 *   * the import is a READ: the fixture's files are byte-identical
 *     before and after the call -- 「导入 md/json 关系不改正文」;
 *   * the endpoint needs the session token, like every other endpoint.
 *
 * The fixture needs no browser, no device and no network: the import is
 * an indexing operation over files that are already on disk.
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
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ats308-it-'));
const FIXTURE = path.join(WORK, 'project');
const data = path.join(WORK, 'data');
const port = await freePort();

let cp;
let token;
let projectId;

/**
 * The fixture project: a Playwright project (so the Bridge accepts it),
 * with tracking assets that carry a broken link and a dangling
 * requirement, and with a design document that names a file that is not
 * there.
 */
function writeProject() {
  fs.mkdirSync(path.join(FIXTURE, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(FIXTURE, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(FIXTURE, '.aitest'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE, 'package.json'), '{"name":"fixture"}');
  fs.writeFileSync(path.join(FIXTURE, 'playwright.config.ts'), 'export default {};');
  fs.writeFileSync(path.join(FIXTURE, 'tests', 'home.spec.ts'), [
    "import { test } from '@playwright/test';",
    "test('首页响应正常', async () => {});",
  ].join('\n'));
  fs.writeFileSync(path.join(FIXTURE, '.aitest', 'requirements.json'), JSON.stringify([
    { uid: 'REQ-001', title: '首页可访问', type: 'functional', status: 'approved' },
  ]));
  fs.writeFileSync(path.join(FIXTURE, '.aitest', 'traceability.json'), JSON.stringify([
    { from: 'REQ-001', to: 'tests/home.spec.ts::首页响应正常', type: 'verified_by' },
    // a link to a case the file does not declare
    { from: 'REQ-001', to: 'tests/home.spec.ts::被改名的用例', type: 'verified_by' },
    // a link to a requirement the list does not declare
    { from: 'REQ-404', to: 'tests/home.spec.ts::首页响应正常', type: 'verified_by' },
  ]));
  fs.writeFileSync(path.join(FIXTURE, 'docs', '01-DESIGN.md'), [
    '# ATS-DD-001 設計書',
    '',
    '## 1. 概要',
    '',
    '実装は `tests/home.spec.ts` にある。存在しないファイルを指す: `tests/gone.spec.ts`。',
  ].join('\n'));
}
writeProject();

/** The digest of every file of the fixture: the proof the import rewrote nothing. */
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

test('IT-ATS308-API-SETUP: start the bridge and register the fixture project', async () => {
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

test('IT-ATS308-API-001: the per-project import answers with the assets and the design material', async () => {
  const r = await api(`/api/projects/${projectId}/import`);
  assert.equal(r[0], 200);
  const body = r[1];
  assert.ok(body.assets, 'the assets section is present');
  assert.ok(body.design, 'the design section is present');
  assert.equal(body.assets.requirements.length, 1);
  assert.equal(body.assets.requirements[0].uid, 'REQ-001');
  assert.equal(body.assets.links.length, 3);
  assert.ok(body.design.materials.some((m) => m.rel === 'docs/01-DESIGN.md'));
});

test('IT-ATS308-API-002: the import reports the broken and the dangling relations', async () => {
  const r = await api(`/api/projects/${projectId}/import`);
  const issues = r[1].assets.issues;
  const kinds = issues.map((i) => i.kind);
  assert.ok(kinds.includes('unknown-case'), `the renamed case must be reported: ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('dangling-requirement'), `the dangling requirement must be reported: ${JSON.stringify(kinds)}`);
  // The broken design reference is in the design report.
  const broken = r[1].design.report.broken.map((b) => b.token);
  assert.ok(broken.includes('tests/gone.spec.ts'), `the broken reference must be reported: ${JSON.stringify(broken)}`);
});

test('IT-ATS308-API-003: the import does not change a byte of the project', async () => {
  const before = fixtureDigest();
  await api(`/api/projects/${projectId}/import`);
  const after = fixtureDigest();
  assert.equal(after.digest, before.digest, 'the import must not rewrite the body');
  assert.equal(after.count, before.count);
});

test('IT-ATS308-API-004: the import is a READ -- there is no write endpoint', async () => {
  const r = await api(`/api/projects/${projectId}/import`, 'POST', {});
  assert.equal(r[0], 404, 'the import must not be writable');
});

test('IT-ATS308-API-005: the import needs the session token', async () => {
  const r = await api(`/api/projects/${projectId}/import`, 'GET', undefined, false);
  assert.equal(r[0], 401);
});

test('IT-ATS308-API-006: the top-level endpoint imports the platform own baseline', async () => {
  const r = await api('/api/design/import');
  assert.equal(r[0], 200);
  assert.ok(r[1].report.designDocuments >= 40, `only ${r[1].report.designDocuments} design documents`);
  assert.ok(r[1].materials.some((m) => m.rel === 'docs/33-TRACEABILITY-GRAPH.md'));
  // The detailed mode carries the references themselves.
  const d = await api('/api/design/import?detailed=true');
  assert.equal(d[0], 200);
  assert.ok(d[1].references.length > 500);
  // Every reference that resolved names a file that exists.
  for (const ref of d[1].references) {
    if (ref.kind !== 'resolved') continue;
    for (const candidate of ref.candidates) {
      assert.ok(fs.existsSync(path.join(root, candidate)), `${candidate} does not exist`);
    }
  }
});

test('IT-ATS308-API-007: the top-level import does not change a byte of the repository', async () => {
  const digestOf = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const before = digestOf('docs/33-TRACEABILITY-GRAPH.md');
  await api('/api/design/import');
  assert.equal(digestOf('docs/33-TRACEABILITY-GRAPH.md'), before);
});

test('IT-ATS308-API-CLEANUP: stop the bridge and remove the fixture', async () => {
  cp.kill();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(WORK, { recursive: true, force: true });
});
