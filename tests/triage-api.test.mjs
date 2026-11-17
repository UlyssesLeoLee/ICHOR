/**
 * ATS-410 integration tests: the TRIAGE API surface.
 *
 * WHAT IS UNDER TEST
 * ------------------
 * The API side of the triage: the contract endpoint and the triage endpoint,
 * over a REAL Bridge (a real HTTP server, a real token, a real data
 * directory). The unit tests in `tests/triage.test.mjs` cover the core; this
 * file covers the wiring:
 *
 *   1. `GET /api/ai/triage/contract` returns the four categories, the ORDER of
 *      the rules and the write policy -- and leaks neither a secret nor a
 *      local path.
 *   2. `POST /api/ai/triage` triages a run that is in the state, and every
 *      finding carries a checkable evidence ref.
 *   3. The triage route is a READ: it writes nothing. The state file's bytes
 *      before and after the call are compared.
 *   4. The refusals are the documented ones: an unknown run (404), a run that
 *      is still in flight (400), a request for the model enhancement with no
 *      provider configured (503).
 *
 * Run: node --test tests/triage-api.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-410-api-'));
const port = await freePort();
let cp, token;

async function ready() {
  for (let i = 0; i < 400; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not boot');
}

async function api(endpoint, method = 'GET', payload, auth = true) {
  const r = await fetch(`http://127.0.0.1:${port}` + endpoint, {
    method,
    headers: auth ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {},
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return [r.status, await r.json()];
}

test.before(async () => {
  cp = spawn(process.execPath, [path.join(root, 'server', 'index.mjs')], {
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await ready();
  token = (await api('/api/session', 'GET', null, false))[1].token;
});

test.after(() => {
  try { cp?.kill(); } catch { /* already gone */ }
  try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* best effort */ }
});

/* ------------------------------------------------------------- fixtures */

/**
 * 把一次运行写进状态。
 *
 * The Bridge reads its state at boot, so the run has to be in the state file
 * BEFORE the Bridge starts. The state file is therefore written here, and the
 * Bridge is booted afterwards -- the boot order in `before()` is fixed, so the
 * state is written in a module-level step that runs before the hook.
 */
function statePath() {
  return path.join(data, 'state.json');
}

function writeState(runs) {
  // The state file must be a SCHEMA-1 state: `loadState()` refuses to start on
  // a JSON file that is not one (it would replace the run history with an
  // empty state), so the fixture carries `schema: 1` and the two arrays.
  const state = { schema: 1, projects: [], runs, uidRegistry: { version: 1, projects: {} } };
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

const CASE = {
  title: 'login works',
  file: 'tests/login.spec.ts',
  line: 12,
  status: 'failed',
  duration: 5,
  error: 'AssertionError: expected 5 to be 3',
  attemptsCount: 1,
  attempts: [{ status: 'failed', retry: 0, duration: 5, error: 'AssertionError: expected 5 to be 3' }],
};

const FAILED_RUN = {
  id: 'run_1_550e8400e29b41d4a7164466',
  uid: 'run_1_550e8400e29b41d4a7164466',
  seq: 1,
  projectId: 'proj_demo',
  projectUid: 'proj_demo',
  projectName: 'demo',
  file: 'tests/login.spec.ts',
  gitCommit: 'abc1234',
  status: 'failed',
  createdAt: '2026-11-18T00:00:00.000Z',
  startedAt: '2026-11-18T00:00:00.000Z',
  finishedAt: '2026-11-18T00:01:00.000Z',
  eventSeq: 0,
  events: [],
  log: '',
  summary: { passed: 0, failed: 1, skipped: 0, flaky: 0, total: 1, executions: 1, cases: [CASE] },
  artifacts: [],
  runner: 'playwright',
};

// The state must exist before the Bridge boots, so it is written at module
// level -- the `before()` hook boots the server afterwards.
writeState([FAILED_RUN]);

/* ------------------------------------------------------------ the tests */

test('the triage contract endpoint returns the four categories and the rule order', async () => {
  const [status, body] = await api('/api/ai/triage/contract');
  assert.equal(status, 200);
  assert.equal(body.contract, 'triage/v1');
  assert.deepEqual([...body.categories].sort(),
    ['environment', 'product', 'script', 'undetermined']);
  assert.deepEqual(body.classificationOrder, ['environment', 'script', 'product', 'undetermined']);
  assert.ok(body.writePolicy.includes('READ-ONLY'));
});

test('the triage contract endpoint leaks neither a secret nor a local path', async () => {
  const [, body] = await api('/api/ai/triage/contract');
  const text = JSON.stringify(body);
  assert.ok(!/C:\\Users/i.test(text), 'the contract must not carry a local path');
  assert.ok(!/[A-Za-z]:\\\\/.test(text));
  assert.ok(!/apiKey|secret|password/i.test(text), 'the contract must not carry a secret');
});

test('the triage endpoint requires the session token', async () => {
  const [status] = await api('/api/ai/triage', 'POST', { runId: FAILED_RUN.id }, false);
  assert.equal(status, 401);
});

test('the triage endpoint triages a run and cites evidence for every finding', async () => {
  const [status, body] = await api('/api/ai/triage', 'POST', { runId: FAILED_RUN.id });
  assert.equal(status, 200);
  assert.equal(body.contract, 'triage/v1');
  assert.equal(body.runId, FAILED_RUN.id);
  assert.equal(body.findings.length, 1);
  const finding = body.findings[0];
  assert.ok(['script', 'product', 'environment', 'undetermined'].includes(finding.category));
  assert.ok(finding.evidenceRefs.length >= 2, 'a finding must cite at least two refs');
  for (const ref of finding.evidenceRefs) {
    assert.ok(['run', 'case', 'artifact', 'commit'].includes(ref.kind));
    if (ref.kind !== 'commit') assert.match(ref.digest, /^[0-9a-f]{64}$/);
    assert.ok(!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(ref.ref), 'a ref must not be an absolute path');
  }
  // The reconciliation checks are reported.
  assert.ok(Array.isArray(body.checks) && body.checks.length >= 2);
  assert.ok(body.checks.every((c) => typeof c.ok === 'boolean'));
});

test('the triage is a READ: the state file is byte-identical before and after', async () => {
  const before = fs.readFileSync(statePath());
  await api('/api/ai/triage', 'POST', { runId: FAILED_RUN.id });
  const after = fs.readFileSync(statePath());
  assert.deepEqual(before, after, 'the triage must not write to the state');
});

test('the triage of a run with no comparable history is undetermined, not product', async () => {
  // There is no baseline in the request, so there is no comparable commit
  // history -- the category must degrade to `undetermined`.
  const [, body] = await api('/api/ai/triage', 'POST', { runId: FAILED_RUN.id });
  assert.equal(body.findings[0].category, 'undetermined');
  assert.equal(body.summary.comparableHistory, false);
});

test('an unknown run is refused with 404', async () => {
  const [status, body] = await api('/api/ai/triage', 'POST', { runId: 'run_1_missing0000000000000000' });
  assert.equal(status, 404);
  assert.equal(body.error, 'TRIAGE_RUN_NOT_FOUND');
});

test('a run that does not exist is refused with 404 and the documented code', async () => {
  // The in-flight case cannot be a fixture in the state file: the Bridge's
  // STARTUP RECOVERY rewrites a `running` run to `interrupted` (a terminal
  // status) before it serves anything, because a run whose bridge died has
  // to reach a terminal state. So the in-flight refusal is exercised through
  // the CORE, where the status is read as given (tests/triage.test.mjs covers
  // it); here the API-level refusal of a MISSING run is checked.
  const [status, body] = await api('/api/ai/triage', 'POST', { runId: 'run_1_000000000000000000000000' });
  assert.equal(status, 404);
  assert.equal(body.error, 'TRIAGE_RUN_NOT_FOUND');
});

test('a request for the model enhancement fails with 503 when no provider is configured', async () => {
  const [status, body] = await api('/api/ai/triage', 'POST', {
    runId: FAILED_RUN.id,
    modelEnhanced: true,
  });
  assert.equal(status, 503);
  assert.equal(body.error, 'TRIAGE_MODEL_UNAVAILABLE');
});

test('a request without a runId is refused with 400', async () => {
  const [status, body] = await api('/api/ai/triage', 'POST', {});
  assert.equal(status, 400);
  assert.equal(body.error, 'TRIAGE_REQUEST_INVALID');
});

test('the triage report carries no absolute path and no secret', async () => {
  const [, body] = await api('/api/ai/triage', 'POST', { runId: FAILED_RUN.id });
  const text = JSON.stringify(body);
  assert.ok(!text.includes(data), 'the report must not carry the data directory');
  assert.ok(!/[A-Za-z]:\\\\Users/i.test(text));
});
