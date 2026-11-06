import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const base = path.resolve(root, 'examples/sample-playwright');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-uid-api-'));
const port = await freePort();
let cp, token, projectId;

// The ready() window below is 400 attempts: under parallel load the Bridge needs
// more than 100 attempts to come up, and a short window turns into a flaky failure.
// `npm test` runs the test files in PARALLEL, and 14 of them each boot a
// Bridge. Booting 14 servers at once is slow: measured on this machine the
// boot takes 1289 / 5637 / 8582 ms (min / median / max), while the old
// windows only allowed 4000 ms (80 x 50ms) or 2450 ms (70 x 35ms). So the
// slow ones gave up with "server did not boot" -- non-deterministically, on a
// DIFFERENT subset each run.
//
// It was never a port collision: 14 concurrent servers were measured and
// their ports were all distinct. 400 attempts x 50ms = 20s and x 35ms = 14s,
// which covers the measured worst case with room to spare, and a test that
// genuinely cannot start still fails instead of hanging forever.
async function ready() {
  // The health probe is BOUNDED. An unbounded fetch turns ONE request that
  // never comes back into a stall of the whole boot window, and the boot wait
  // then reports "the bridge did not come up" for a bridge that IS listening
  // and merely busy. Measured: a hung probe made the wait 31 s long (the 20 s
  // window plus an ~11 s request that never came back). The timeout is far
  // below the window, so a slow-but-alive bridge is still found, and a hung
  // request is retried instead of consuming the wait.
  for (let i = 0; i < 400; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch {}
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

/**
 * Waits until a run reaches a terminal state.
 *
 * The Bridge refuses a second run of the same project while the first one is
 * still in flight (PROJECT_ALREADY_RUNNING), so a test that starts two runs
 * has to wait for the first one to finish. The wait is bounded so that a
 * broken run fails the test instead of hanging it.
 */
async function waitForRun(uid, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(`/api/runs/${uid}`);
    const status = r[1]?.run?.status;
    if (status && !['queued', 'running', 'cancelling'].includes(status)) return r[1].run;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw Error(`run ${uid} did not finish within ${timeoutMs}ms`);
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
  // The run has to reach a terminal state before the next one can start:
  // the Bridge refuses a second run of the same project while one is in
  // flight (PROJECT_ALREADY_RUNNING).
  await waitForRun(r[1].run.uid);
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
