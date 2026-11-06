import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-agt-api-'));
const port = await freePort();
let cp, token;
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// The ready() window below is 400 attempts, not the 70-100 it used to be.
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
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* retry */ }
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

const SPEC = "test('login passes', async ({page}) => {});\n";
const fixture = path.join(data, 'fixture-repo');
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'package.json'), '{}');
fs.writeFileSync(path.join(fixture, 'playwright.config.ts'), 'export default {}');
fs.writeFileSync(path.join(fixture, 'tests', 'login.spec.ts'), SPEC);

function validRequest(overrides = {}) {
  return {
    role: 'generator',
    scope: {
      projectId: 'proj_demo',
      root: fixture,
      files: ['tests/login.spec.ts'],
      outputs: ['tests/login.spec.ts'],
      runs: [],
      requirements: [],
    },
    budget: { maxInputBytes: 100000, maxOutputBytes: 100000, maxSteps: 4, deadlineMs: 30000 },
    instructions: 'propose a login test',
    requestedCapabilities: ['propose_script_diff'],
    inputs: [{
      kind: 'file',
      ref: 'tests/login.spec.ts',
      digest: sha(SPEC),
      content: SPEC,
      retrievedAt: '2026-11-04T00:00:00.000Z',
    }],
    ...overrides,
  };
}

test('IT-AGT-SETUP: start server', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: path.join(data, 'state') },
    stdio: 'ignore',
  });
  await ready();
  token = (await api('/api/session'))[1].token;
  assert.ok(token);
});

test('IT-AGT-001: the contract description is exposed', async () => {
  const [status, body] = await api('/api/agent/contract');
  assert.equal(status, 200);
  assert.equal(body.contract, 'agent-contract/v1');
  assert.ok(body.forbiddenCapabilities.includes('write_source'));
  assert.ok(body.forbiddenCapabilities.includes('git_commit'));
  assert.deepEqual(body.proposalStates, ['pending', 'approved', 'rejected']);
});

test('IT-AGT-002: the contract endpoint requires a session token', async () => {
  const [status] = await api('/api/agent/contract', 'GET', undefined, false);
  assert.equal(status, 401);
});

test('IT-AGT-003: a valid request is accepted by the validator', async () => {
  const [status, body] = await api('/api/agent/validate', 'POST', validRequest());
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.role, 'generator');
  assert.equal(body.contract, 'agent-contract/v1');
  assert.equal(body.inputRefs.length, 1);
  assert.equal(body.inputRefs[0].ref, 'tests/login.spec.ts');
});

test('IT-AGT-004: a request asking for a forbidden capability is rejected with 400', async () => {
  const [status, body] = await api('/api/agent/validate', 'POST', validRequest({
    requestedCapabilities: ['write_source'],
  }));
  assert.equal(status, 400);
  assert.equal(body.error, 'AGENT_CAPABILITY_FORBIDDEN');
});

test('IT-AGT-005: a request without a budget is rejected with 400', async () => {
  const request = validRequest();
  delete request.budget;
  const [status, body] = await api('/api/agent/validate', 'POST', request);
  assert.equal(status, 400);
  assert.equal(body.error, 'AGENT_BUDGET_REQUIRED');
});

test('IT-AGT-006: a request without provenance is rejected with 400', async () => {
  const [status, body] = await api('/api/agent/validate', 'POST', validRequest({ inputs: [] }));
  assert.equal(status, 400);
  assert.equal(body.error, 'AGENT_PROVENANCE_REQUIRED');
});

test('IT-AGT-007: a request whose scope escapes the project root is rejected with 400', async () => {
  const [status, body] = await api('/api/agent/validate', 'POST', validRequest({
    scope: {
      projectId: 'proj_demo',
      root: fixture,
      files: ['../../outside.spec.ts'],
      outputs: [],
      runs: [],
      requirements: [],
    },
  }));
  assert.equal(status, 400);
  assert.equal(body.error, 'AGENT_SCOPE_ESCAPE');
});

test('IT-AGT-008: validating a request does not write to the project', async () => {
  const before = fs.readFileSync(path.join(fixture, 'tests', 'login.spec.ts'), 'utf8');
  await api('/api/agent/validate', 'POST', validRequest());
  const after = fs.readFileSync(path.join(fixture, 'tests', 'login.spec.ts'), 'utf8');
  assert.equal(before, after);
});

test('IT-AGT-009: the diagnostics endpoint reports the agent contract status', async () => {
  const [status, body] = await api('/api/diagnostics');
  assert.equal(status, 200);
  assert.equal(body.agentContract.version, 'agent-contract/v1');
  assert.equal(body.agentContract.status, 'CONTRACT_ONLY');
});

test('IT-AGT-010: a request whose digest does not match its content is rejected with 400', async () => {
  const [status, body] = await api('/api/agent/validate', 'POST', validRequest({
    inputs: [{
      kind: 'file',
      ref: 'tests/login.spec.ts',
      digest: sha('something else'),
      content: SPEC,
      retrievedAt: '2026-11-04T00:00:00.000Z',
    }],
  }));
  assert.equal(status, 400);
  assert.equal(body.error, 'AGENT_PROVENANCE_DIGEST_MISMATCH');
});

test('IT-AGT-011: an AGENT_* error carries machine-readable details', async () => {
  const [status, body] = await api('/api/agent/validate', 'POST', validRequest({
    budget: { maxInputBytes: 100000, maxOutputBytes: 100000, maxSteps: 99, deadlineMs: 30000 },
  }));
  assert.equal(status, 400);
  assert.equal(body.error, 'AGENT_BUDGET_INVALID');
  assert.equal(body.details.field, 'maxSteps');
  assert.equal(body.details.limit, 10);
});

test('IT-AGT-012: the error details never contain a local filesystem path', async () => {
  const [status, body] = await api('/api/agent/validate', 'POST', validRequest({
    scope: {
      projectId: 'proj_demo',
      root: fixture,
      files: ['../../outside.spec.ts'],
      outputs: [],
      runs: [],
      requirements: [],
    },
  }));
  assert.equal(status, 400);
  assert.equal(body.error, 'AGENT_SCOPE_ESCAPE');
  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes(fixture), false, 'the response must not echo the local root');
  assert.equal(/[A-Za-z]:\\/.test(serialised), false, 'the response must not contain a Windows path');
});

test('IT-AGT-013: a non-agent error keeps the pre-ATS-401 behaviour', async () => {
  // A missing directory raises ENOENT (an error with a `code` but not an
  // AGENT_* one). The response must keep the original message, and must not
  // be remapped to the agent error shape.
  const [status, body] = await api('/api/projects', 'POST', {
    path: path.join(data, 'no-such-dir'),
  });
  assert.equal(status, 500);
  assert.equal(body.error.startsWith('ENOENT'), true, `unexpected error: ${body.error}`);
  assert.equal(body.details, undefined, 'a non-agent error must not carry agent details');
});

test('IT-AGT-CLEANUP: stop and cleanup', () => {
  cp.kill();
  fs.rmSync(data, { recursive: true, force: true });
});
