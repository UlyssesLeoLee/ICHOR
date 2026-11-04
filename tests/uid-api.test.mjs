import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const base = path.resolve(root, 'examples/sample-playwright');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-uid-api-'));
const port = 23000 + Math.floor(Math.random() * 10000);
let cp, token, projectId;

async function ready() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return; } catch {}
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

test('IT-UID-SETUP: start server', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data }, stdio: 'ignore'
  });
  await ready();
  token = (await api('/api/session'))[1].token;
  assert.ok(token);
});

test('IT-UID-001: a registered project carries a stable UID', async () => {
  const r = await api('/api/projects', 'POST', { path: base });
  assert.equal(r[0], 201);
  projectId = r[1].project.id;
  assert.match(r[1].project.uid, /^proj_1_[0-9a-f]{24}$/);
  assert.equal(r[1].project.id, r[1].project.uid);
});

test('IT-UID-002: the test catalog exposes the UID and its source', async () => {
  const r = await api(`/api/projects/${projectId}/tests`);
  assert.equal(r[0], 200);
  assert.equal(r[1].tests.length, 2);
  assert.equal(r[1].uidVersion, 1);
  for (const t of r[1].tests) {
    assert.ok(t.uid, 'every test carries a UID');
    assert.equal(t.id, t.uid);
    assert.ok(['explicit', 'derived', 'derived-body', 'registry', 'provisional'].includes(t.uidSource));
  }
});

test('IT-UID-003: the UID registry is persisted in the state file', async () => {
  const state = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  assert.ok(state.uidRegistry);
  assert.ok(state.uidRegistry.projects);
  const projectUid = state.projects[0].uid;
  const entries = state.uidRegistry.projects[projectUid].entries;
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.uid && e.bodyKey));
});

test('IT-UID-004: the project is reachable through its UID', async () => {
  const projects = (await api('/api/projects'))[1].projects;
  const uid = projects[0].uid;
  const r = await api(`/api/projects/${uid}/tests`);
  assert.equal(r[0], 200);
  assert.equal(r[1].tests.length, 2);
});

test('IT-UID-005: the run carries a UID in the v1 format', async () => {
  const r = await api(`/api/projects/${projectId}/run`, 'POST', {});
  assert.equal(r[0], 202);
  assert.match(r[1].run.uid, /^run_1_[0-9a-f]{24}$/);
  assert.equal(r[1].run.id, r[1].run.uid);
  assert.equal(r[1].run.seq, 1);
});

test('IT-UID-006: the run is reachable through its UID', async () => {
  const runs = (await api('/api/runs'))[1].runs;
  const uid = runs[0].uid;
  const r = await api(`/api/runs/${uid}`);
  assert.equal(r[0], 200);
  assert.equal(r[1].run.id, uid);
});

test('IT-UID-007: a second run of the same project gets a new UID', async () => {
  const r = await api(`/api/projects/${projectId}/run`, 'POST', {});
  assert.equal(r[0], 202);
  assert.equal(r[1].run.seq, 2);
  const runs = (await api('/api/runs'))[1].runs;
  assert.equal(new Set(runs.map((x) => x.id)).size, runs.length);
});

test('IT-UID-CLEANUP: stop and cleanup', () => {
  cp.kill();
  fs.rmSync(data, { recursive: true, force: true });
});
