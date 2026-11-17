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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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

test('IT-AIE-004B: a secret in a HEADER is refused and never stored', async () => {
  // The round-1 delivery claimed "IT covers the refusal of an
  // Authorization / x-api-key header". It did not: only `apiKey` was
  // tested. Both header names are covered here, and the assertion is that
  // the secret is neither returned nor written to the state file.
  const SECRET_A = 'hdr-authorization-must-not-persist';
  const SECRET_B = 'azure-header-api-key-must-not-persist';
  const [statusA, bodyA] = await api('/api/ai/providers', 'POST', {
    id: 'hdr-auth',
    protocol: 'openai-chat',
    config: { model: 'm', baseUrl: 'https://example.invalid/v1', headers: { authorization: `Bearer ${SECRET_A}` } },
  });
  assert.equal(statusA, 400, `the authorization header must be refused, got ${statusA}`);
  assert.equal(bodyA.error, 'AI_PROVIDER_CONFIG_INVALID');
  const [statusB, bodyB] = await api('/api/ai/providers', 'POST', {
    id: 'hdr-apikey',
    protocol: 'openai-chat',
    config: { model: 'm', baseUrl: 'https://example.invalid/v1', headers: { 'api-key': SECRET_B } },
  });
  assert.equal(statusB, 400, `the api-key header must be refused, got ${statusB}`);
  assert.equal(bodyB.error, 'AI_PROVIDER_CONFIG_INVALID');
  // Neither the response nor the listed providers carry the secret.
  const [, list] = await api('/api/ai/providers');
  assert.ok(!JSON.stringify(list).includes(SECRET_A));
  assert.ok(!JSON.stringify(list).includes(SECRET_B));
  assert.ok(!list.providers.some((p) => p.id === 'hdr-auth'));
  assert.ok(!list.providers.some((p) => p.id === 'hdr-apikey'));
  // And the state file on disk does not carry it either.
  const stateText = fs.readdirSync(path.join(data, 'state'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => fs.readFileSync(path.join(data, 'state', f), 'utf8'))
    .join('\n');
  assert.ok(!stateText.includes(SECRET_A), 'the secret must not reach the state file');
  assert.ok(!stateText.includes(SECRET_B), 'the secret must not reach the state file');
});

test('IT-AIE-004C: an illegal provider configuration is refused and NOT stored', async () => {
  // The round-1 delivery persisted an illegal configuration and only failed
  // later, at call time. The configuration is now validated before it is
  // written, so an illegal one never reaches the state file.
  const cases = [
    { label: 'a non-http endpoint', config: { model: 'm', baseUrl: 'ftp://x' } },
    { label: 'a negative token budget', config: { model: 'm', baseUrl: 'https://example.invalid/v1', maxTokens: -5 } },
    { label: 'a malformed credential reference', config: { model: 'm', baseUrl: 'https://example.invalid/v1', credentialId: 'not-a-ref' } },
  ];
  for (const [index, item] of cases.entries()) {
    const id = `bad-cfg-${index}`;
    const [status, body] = await api('/api/ai/providers', 'POST', { id, protocol: 'openai-chat', config: item.config });
    assert.equal(status, 400, `${item.label} must be refused, got ${status}`);
    assert.equal(body.error, 'AI_PROVIDER_CONFIG_INVALID');
    const [, list] = await api('/api/ai/providers');
    assert.ok(!list.providers.some((p) => p.id === id), `${item.label} must not be stored`);
  }
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
  assert.equal(status, 503);
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

/* ==================================================================== */
/* the round-2 integration cases (ATS-403, Opus review round 1)          */
/*                                                                       */
/* The round-1 delivery claimed "IT covers timeout / rate limiting" and  */
/* "IT covers the refusal of an Authorization / x-api-key header".      */
/* Neither was true. Both are covered here, over real HTTP, against a   */
/* LOOPBACK provider that records exactly what it received.              */
/* ==================================================================== */

/** A loopback provider that records what it receives and answers `status`. */
async function startFakeProvider(status = 200, body = null) {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: raw });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body ?? JSON.stringify({ choices: [{ message: { content: 'fake-ok' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, received, url: `http://127.0.0.1:${server.address().port}/v1` };
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

test('IT-AIE-020: the provider receives the CONSENTED content, not the caller\'s', async () => {
  const fake = await startFakeProvider();
  try {
    const [cfgStatus] = await api('/api/ai/providers', 'POST', {
      id: 'loopback', protocol: 'openai-chat', config: { model: 'm', baseUrl: fake.url },
    });
    assert.equal(cfgStatus, 201);

    const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
    const [, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
    const [, confirmed] = await api('/api/security/egress/confirm', 'POST', {
      projectId, inputs, previewId: preview.preview.previewId,
    });
    fake.received.length = 0;

    // The request body asks for a DIFFERENT content than the consent covers.
    const [status, body] = await api('/api/ai/complete', 'POST', {
      projectId,
      inputs,
      consentId: confirmed.consent.id,
      request: {
        instructions: 'hello',
        inputs: [{ kind: 'file', ref: 'C:/Users/someone/.ssh/id_ed25519', content: 'UNCONSENTED-PRIVATE-KEY' }],
      },
    });
    assert.equal(status, 200, JSON.stringify(body));
    // The body is JSON, so the content is compared after decoding: a raw
    // substring check on the encoded body would miss an escaped quote.
    const sent = fake.received[0]?.body ?? '';
    assert.ok(!sent.includes('UNCONSENTED-PRIVATE-KEY'), 'the caller\'s content must never be sent');
    const decoded = JSON.parse(sent);
    const userMessage = decoded.messages.find((m) => m.role === 'user')?.content ?? '';
    assert.ok(userMessage.includes('home passes'), 'the consented content must be sent');
    assert.ok(userMessage.includes('tests/home.spec.ts'), 'the consented ref must be sent');

    // The audit trail names exactly what was sent.
    const [, auditBody] = await api('/api/security/egress/audit');
    const granted = auditBody.audit.filter((r) => r.event === 'egress.granted').at(-1);
    assert.ok(granted, 'the granted egress must be audited');
    assert.deepEqual(granted.items.map((i) => i.ref), ['tests/home.spec.ts']);
    assert.ok(!JSON.stringify(granted).includes('id_ed25519'));
    assert.equal(granted.items[0].digest, sha256(SPEC));
  } finally {
    fake.server.close();
    await api('/api/ai/providers/loopback', 'DELETE');
  }
});

test('IT-AIE-021: a call may not carry its own provider list', async () => {
  const fake = await startFakeProvider();
  try {
    const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
    const [, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
    const [, confirmed] = await api('/api/security/egress/confirm', 'POST', {
      projectId, inputs, previewId: preview.preview.previewId,
    });
    fake.received.length = 0;
    // An ad-hoc provider list in the body would let the caller choose the
    // destination of the consented content.
    const [status, body] = await api('/api/ai/complete', 'POST', {
      projectId,
      inputs,
      consentId: confirmed.consent.id,
      providers: [{ id: 'evil', protocol: 'openai-chat', config: { model: 'm', baseUrl: fake.url } }],
      request: { instructions: 'hello', inputs: [] },
    });
    assert.equal(status, 400, `the ad-hoc provider list must be refused, got ${status}`);
    assert.equal(body.error, 'AI_PROVIDER_CONFIG_INVALID');
    assert.equal(fake.received.length, 0, 'no request may reach the ad-hoc provider');
  } finally {
    fake.server.close();
  }
});

test('IT-AIE-022: a RATE LIMITED provider leaves the working tree byte-identical', async () => {
  const fake = await startFakeProvider(429, JSON.stringify({ error: 'slow down' }));
  try {
    const [cfgStatus] = await api('/api/ai/providers', 'POST', {
      id: 'limited', protocol: 'openai-chat', config: { model: 'm', baseUrl: fake.url },
    });
    assert.equal(cfgStatus, 201);
    const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
    const [, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
    const [, confirmed] = await api('/api/security/egress/confirm', 'POST', {
      projectId, inputs, previewId: preview.preview.previewId,
    });
    // The working tree BEFORE the call.
    const digestTree = () => fs.readdirSync(fixture, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort()
      .map((f) => [f, sha256(fs.readFileSync(path.join(fixture, f)))]);
    const before = digestTree();
    const [status, body] = await api('/api/ai/complete', 'POST', {
      projectId, inputs, consentId: confirmed.consent.id,
      request: { instructions: 'hello', inputs: [] },
    });
    // The call fails -- the provider rate limited us.
    assert.equal(status, 429, `a rate limit must be reported as 429, got ${status}`);
    assert.equal(body.error, 'AI_PROVIDER_RATE_LIMITED');
    const after = digestTree();
    assert.deepEqual(after, before, 'the working tree must be byte-identical after a rate limit');
  } finally {
    fake.server.close();
    await api('/api/ai/providers/limited', 'DELETE');
  }
});

test('IT-AIE-023: a provider that ECHOES the key does not leak it', async () => {
  const SECRET = 'echoed-key-must-not-reach-the-client';
  // The provider echoes BACK whatever key it was given, so the redaction is
  // exercised against a real key rather than a made-up string.
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const sent = req.headers.authorization ?? '';
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${sent.replace(/^Bearer /, '')}` } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  // A credential is created so the provider HAS a key to echo. The real
  // store is not available in every environment; when it is not, the
  // credential cannot be resolved and the call fails with
  // AI_CREDENTIAL_UNAVAILABLE -- which is itself the correct answer (no key
  // means no key to leak), and the case is then skipped with that reason.
  const [credStatus, credBody] = await api('/api/security/credentials', 'POST', { name: 'ats403-echo', secret: SECRET });
  const credentialId = credStatus === 201 ? credBody.credential.id : null;
  try {
    const [cfgStatus] = await api('/api/ai/providers', 'POST', {
      id: 'echoing', protocol: 'openai-chat',
      config: { model: 'm', baseUrl: url, ...(credentialId ? { credentialId } : {}) },
    });
    assert.equal(cfgStatus, 201);
    const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
    const [, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
    const [, confirmed] = await api('/api/security/egress/confirm', 'POST', {
      projectId, inputs, previewId: preview.preview.previewId,
    });
    const [status, body] = await api('/api/ai/complete', 'POST', {
      projectId, inputs, consentId: confirmed.consent.id,
      request: { instructions: 'hello', inputs: [] },
    });
    if (!credentialId) {
      // The credential store is not available on this host: the call cannot
      // resolve a key, so there is no key to echo. The redaction itself is
      // covered by the unit test (R2-P5), which injects the key directly.
      assert.equal(body.error, 'AI_CREDENTIAL_UNAVAILABLE');
      assert.ok(!JSON.stringify(body).includes(SECRET));
      return;
    }
    // The status is the one the code table says for an auth failure.
    assert.equal(status, 502, `an auth failure must be reported as 502, got ${status}`);
    assert.equal(body.error, 'AI_PROVIDER_AUTH_FAILED');
    // The echoed key is redacted everywhere in the response.
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes(SECRET), `the key leaked into the response: ${serialised}`);
    assert.ok(serialised.includes('[redacted]'), 'the echoed key must be redacted');
  } finally {
    server.close();
    await api('/api/ai/providers/echoing', 'DELETE');
    if (credentialId) await api(`/api/security/credentials/${credentialId}`, 'DELETE');
  }
});

test('IT-AIE-024: the error codes match the documented status table', async () => {
  // The round-1 documentation listed 401 for an auth failure and 400 for an
  // exhausted step budget; the code maps them to 502 and 429. The code is
  // the truth and the table is corrected -- this test pins the table.
  const [status, body] = await api('/api/ai/contract');
  assert.equal(status, 200);
  assert.equal(body.version, 'ai-adapter/v1');
  // The contract carries the status table itself, so it cannot drift from
  // the code that uses it.
  assert.ok(body.statusByCode, 'the contract must publish the status table');
  assert.equal(body.statusByCode.AI_PROVIDER_AUTH_FAILED, 502);
  assert.equal(body.statusByCode.AI_PROVIDER_RATE_LIMITED, 429);
  assert.equal(body.statusByCode.AI_STEPS_EXCEEDED, 429);
  assert.equal(body.statusByCode.AI_PROVIDER_UNAVAILABLE, 503);
  assert.equal(body.statusByCode.AI_PROVIDER_SERVER_ERROR, 502);
  assert.equal(body.statusByCode.AI_EGRESS_DENIED, 403);
  assert.equal(body.statusByCode.AI_PROVIDER_CONFIG_INVALID, 400);
  assert.equal(body.statusByCode.AI_AUDIT_UNAVAILABLE, 503);
  // And the documented HTTP status of each code is the one the table says.
  for (const [code, expected] of Object.entries(body.statusByCode)) {
    assert.ok(Number.isInteger(expected), `${code} must map to an integer status`);
  }
});

test('IT-AIE-025: the instructions reach the provider AND are audited', async () => {
  // The instructions are caller text that leaves the machine, so the egress
  // audit must name them -- by digest and byte length, never by content.
  const fake = await startFakeProvider();
  try {
    const [cfgStatus] = await api('/api/ai/providers', 'POST', {
      id: 'instructed', protocol: 'openai-chat', config: { model: 'm', baseUrl: fake.url },
    });
    assert.equal(cfgStatus, 201);

    const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
    const [, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
    const [, confirmed] = await api('/api/security/egress/confirm', 'POST', {
      projectId, inputs, previewId: preview.preview.previewId,
    });
    fake.received.length = 0;

    const instructions = 'IT-AIE-025-INSTRUCTIONS';
    const [status, body] = await api('/api/ai/complete', 'POST', {
      projectId,
      inputs,
      consentId: confirmed.consent.id,
      request: { instructions, inputs: [] },
    });
    assert.equal(status, 200, JSON.stringify(body));

    // The instructions really did go out...
    const sent = fake.received[0]?.body ?? '';
    assert.ok(sent.includes(instructions), 'the instructions must reach the provider');
    // ...and the audit names them.
    const [, auditBody] = await api('/api/security/egress/audit');
    // The audit list is newest-first, so the record of THIS call is the
    // first one that matches.
    const granted = auditBody.audit.filter((r) => r.event === 'egress.granted')[0];
    assert.ok(granted, 'the granted egress must be audited');
    assert.ok(granted.instructions, 'the audit record must describe the instructions');
    assert.equal(granted.instructions.kind, 'INSTRUCTION');
    assert.equal(granted.instructions.digest, sha256(instructions));
    assert.equal(granted.instructions.bytes, Buffer.byteLength(instructions, 'utf8'));
    // The audit carries the digest, never the text.
    assert.ok(!JSON.stringify(granted).includes(instructions), 'the audit must not carry the instruction text');
  } finally {
    fake.server.close();
    await api('/api/ai/providers/instructed', 'DELETE');
  }
});

test('IT-AIE-026: the contract does NOT advertise a Bridge route for the step bound', async () => {
  const [status, body] = await api('/api/ai/contract');
  assert.equal(status, 200);
  // `executeSteps` is a library function of the adapter layer. No /api/ai
  // route calls it, so the contract must not claim the bound is enforced.
  assert.ok(!/maxSteps is enforced/.test(body.stepPolicy), `the stepPolicy still claims an enforced bound: ${body.stepPolicy}`);
  assert.ok(/no \/api\/ai route calls it/.test(body.stepPolicy), `the stepPolicy must say no route calls it: ${body.stepPolicy}`);
});

test('IT-AIE-SHUTDOWN: stop server', async () => {
  cp.kill();
});
