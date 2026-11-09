/**
 * ATS-403 integration tests: the model API adapter layer over HTTP.
 *
 * These boot the real Bridge on an isolated data directory and a random
 * port, exactly like tests/agent-api.test.mjs and tests/security-api.test.mjs
 * do for the contract layer and the security surface. They prove:
 *
 *   - the adapter contract and the provider list are exposed;
 *   - a provider configuration may NOT carry a plaintext secret;
 *   - a call WITHOUT a granted egress consent never leaves the machine
 *     (the request is refused before the provider is reached);
 *   - the preview -> confirm -> call flow reaches the provider;
 *   - an AI error is mapped to a status code with its explanation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-ai-api-'));
const port = await freePort();
let cp, token;

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

const SPEC = "test('home passes', async ({page}) => {});\n";
const fixture = path.join(data, 'fixture-repo');
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'package.json'), '{}');
fs.writeFileSync(path.join(fixture, 'playwright.config.ts'), 'export default {}');
fs.writeFileSync(path.join(fixture, 'tests', 'home.spec.ts'), SPEC);

let projectId;

test('IT-AIE-SETUP: start server', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: path.join(data, 'state') },
    stdio: 'ignore',
  });
  await ready();
  token = (await api('/api/session'))[1].token;
  assert.ok(token);
  const [status, body] = await api('/api/projects', 'POST', { path: fixture });
  assert.equal(status, 201);
  projectId = body.project.id;
});

test('IT-AIE-001: the adapter contract is exposed', async () => {
  const [status, body] = await api('/api/ai/contract');
  assert.equal(status, 200);
  assert.equal(body.version, 'ai-adapter/v1');
  assert.deepEqual(body.protocols, ['openai-chat', 'anthropic-messages']);
  assert.ok(body.errorCodes.includes('AI_PROVIDER_RATE_LIMITED'));
  assert.ok(body.retryableErrorCodes.includes('AI_PROVIDER_TIMEOUT'));
  assert.ok(!body.retryableErrorCodes.includes('AI_PROVIDER_AUTH_FAILED'));
});

test('IT-AIE-002: the contract endpoint requires a session token', async () => {
  const [status] = await api('/api/ai/contract', 'GET', undefined, false);
  assert.equal(status, 401);
});

test('IT-AIE-003: a provider is configured and listed in the fallback order', async () => {
  const [status, body] = await api('/api/ai/providers', 'POST', {
    id: 'primary',
    protocol: 'openai-chat',
    config: { model: 'gpt-x', baseUrl: 'https://example.invalid/v1' },
  });
  assert.equal(status, 201);
  assert.equal(body.provider.id, 'primary');
  assert.equal(body.provider.protocol, 'openai-chat');

  const [listStatus, list] = await api('/api/ai/providers');
  assert.equal(listStatus, 200);
  assert.deepEqual(list.fallbackOrder, ['primary']);
});

test('IT-AIE-004: a provider configuration with a plaintext secret is refused', async () => {
  const [status, body] = await api('/api/ai/providers', 'POST', {
    id: 'leaky',
    protocol: 'openai-chat',
    config: { model: 'gpt-x', apiKey: 'sk-live-should-never-be-here' },
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'AI_PROVIDER_CONFIG_INVALID');
  // And it was NOT stored.
  const [, list] = await api('/api/ai/providers');
  assert.ok(!list.providers.some((p) => p.id === 'leaky'));
});

test('IT-AIE-005: the configured providers carry no secret', async () => {
  const [, list] = await api('/api/ai/providers');
  assert.ok(!JSON.stringify(list).includes('sk-live-should-never-be-here'));
});

test('IT-AIE-006: a call without a consent is refused before the provider is reached', async () => {
  const [status, body] = await api('/api/ai/complete', 'POST', {
    projectId,
    inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }],
    request: { instructions: 'hello', inputs: [] },
  });
  assert.equal(status, 403);
  assert.equal(body.error, 'AI_EGRESS_DENIED');
  assert.equal(body.details.cause, 'EGRESS_CONSENT_REQUIRED');
});

test('IT-AIE-007: a call for an unknown project is refused', async () => {
  const [status, body] = await api('/api/ai/complete', 'POST', {
    projectId: 'proj_000000000000000000000000',
    inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }],
    request: { instructions: 'hello', inputs: [] },
  });
  assert.equal(status, 403);
  assert.equal(body.error, 'AI_EGRESS_DENIED');
});

test('IT-AIE-008: the refusal is audited', async () => {
  const [status, body] = await api('/api/security/egress/audit');
  assert.equal(status, 200);
  const denied = body.audit.filter((r) => r.event === 'egress.denied');
  assert.ok(denied.length >= 2, `expected the denials to be audited, got ${denied.length}`);
  // A denial record never carries the content.
  assert.ok(!JSON.stringify(denied).includes('home passes'));
});

test('IT-AIE-009: with a consent the call reaches the provider', async () => {
  const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
  const [, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
  const [confirmStatus, confirmed] = await api('/api/security/egress/confirm', 'POST', {
    projectId, inputs, previewId: preview.preview.previewId,
  });
  assert.equal(confirmStatus, 201);

  // The endpoint is unreachable, so the call fails -- but it fails INSIDE the
  // provider, which proves the gate let it through.
  const [status, body] = await api('/api/ai/complete', 'POST', {
    projectId,
    inputs,
    consentId: confirmed.consent.id,
    request: { instructions: 'hello', inputs: [{ kind: 'file', ref: 'tests/home.spec.ts', content: SPEC }] },
  });
  assert.equal(status, 502);
  assert.ok(['AI_PROVIDER_UNAVAILABLE', 'AI_FALLBACK_EXHAUSTED'].includes(body.error));
  assert.ok(body.explanation.length > 0);
});

test('IT-AIE-010: the diagnostics report the adapter layer', async () => {
  const [status, body] = await api('/api/diagnostics');
  assert.equal(status, 200);
  assert.equal(body.aiAdapter.contract, 'ai-adapter/v1');
  assert.ok(body.aiAdapter.protocols.includes('openai-chat'));
  assert.ok(body.aiAdapter.fallbackOrder.includes('primary'));
});

test('IT-AIE-011: a provider can be removed', async () => {
  const [status] = await api('/api/ai/providers/primary', 'DELETE');
  assert.equal(status, 200);
  const [, list] = await api('/api/ai/providers');
  assert.deepEqual(list.fallbackOrder, []);
});

test('IT-AIE-SHUTDOWN: stop server', async () => {
  cp.kill();
});
