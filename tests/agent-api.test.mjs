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

async function ready() {
  for (let i = 0; i < 80; i++) {
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

test('IT-AGT-CLEANUP: stop and cleanup', () => {
  cp.kill();
  fs.rmSync(data, { recursive: true, force: true });
});
