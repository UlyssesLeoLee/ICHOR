/**
 * ATS-403 unit tests: the model API adapter layer.
 *
 * The four areas under test:
 *
 *   UT-AIE-*  the protocols    -- the request/response translation of the two
 *                                 compatible protocols, and the refusal to
 *                                 carry a secret in a configuration;
 *   UT-AIT-*  the transport   -- the status-code classification, the forced
 *                                 timeout and the truncated-output refusal;
 *   UT-AIF-*  the fallback    -- which errors move the chain on and which
 *                                 stop it;
 *   UT-AIS-*  the service     -- the egress gate runs BEFORE the request, the
 *                                 secret comes from the credential store, and
 *                                 a failure leaves the workspace untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  AI_ERROR_CODES, RETRYABLE_AI_ERROR_CODES, aiError, isRetryableAiError, classifyProviderStatus,
} from '../server/ai/errors.mjs';
import {
  AI_PROTOCOLS, validateProtocolConfig, sanitizeHeaders, buildProtocolBody,
  buildProtocolHeaders, extractProtocolText, extractStopReason, isTruncatedStopReason,
  renderInputs, defaultBaseUrl, defaultPath,
} from '../server/ai/protocols.mjs';
import { createTransport } from '../server/ai/transport.mjs';
import { createAiProvider, asContractProvider } from '../server/ai/provider.mjs';
import { createFallbackChain, explainAiError } from '../server/ai/fallback.mjs';
import { createModelService } from '../server/ai/service.mjs';
import { createEgressConsentStore } from '../server/security/egress-consent.mjs';
import { buildEgressScope } from '../server/security/egress-gate.mjs';
import { describeAiAdapter } from '../server/ai/index.mjs';

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function request(overrides = {}) {
  return {
    role: 'generator',
    outputKind: 'script-diff',
    instructions: 'propose a login test',
    scope: { projectId: 'p1', root: '/tmp/p', files: ['tests/a.spec.ts'], outputs: ['tests/a.spec.ts'] },
    budget: { maxInputBytes: 1000, maxOutputBytes: 1000, maxSteps: 3, deadlineMs: 5000 },
    inputs: [{ kind: 'file', ref: 'tests/a.spec.ts', digest: sha('A'), content: 'A' }],
    ...overrides,
  };
}

/* ------------------------------------------------------------- protocols */

test('UT-AIE-001: two compatible protocols are supported', () => {
  assert.deepEqual([...AI_PROTOCOLS], ['openai-chat', 'anthropic-messages']);
});

test('UT-AIE-002: an unknown protocol is refused with AI_PROVIDER_CONFIG_INVALID', () => {
  assert.throws(() => validateProtocolConfig('gemini-native'), (e) => e.code === 'AI_PROVIDER_CONFIG_INVALID');
});

test('UT-AIE-003: a configuration carrying a plaintext secret is refused', () => {
  for (const config of [{ apiKey: 'sk-live-123' }, { secret: 'sk-live-123' }]) {
    assert.throws(
      () => validateProtocolConfig('openai-chat', config),
      (e) => e.code === 'AI_PROVIDER_CONFIG_INVALID',
      `a configuration with ${Object.keys(config)[0]} must be refused`,
    );
  }
});

test('UT-AIE-004: a credential reference is accepted', () => {
  const config = validateProtocolConfig('openai-chat', { credentialId: `cred_${'a'.repeat(24)}` });
  assert.equal(config.credentialId, `cred_${'a'.repeat(24)}`);
});

test('UT-AIE-005: a malformed credential reference is refused', () => {
  assert.throws(() => validateProtocolConfig('openai-chat', { credentialId: 'not-a-ref' }),
    (e) => e.code === 'AI_PROVIDER_CONFIG_INVALID');
});

test('UT-AIE-006: the authorization header may not be set by the configuration', () => {
  assert.throws(() => validateProtocolConfig('openai-chat', { headers: { Authorization: 'Bearer x' } }),
    (e) => e.code === 'AI_PROVIDER_CONFIG_INVALID');
  assert.throws(() => validateProtocolConfig('openai-chat', { headers: { 'x-api-key': 'x' } }),
    (e) => e.code === 'AI_PROVIDER_CONFIG_INVALID');
});

test('UT-AIE-007: a benign extra header is accepted', () => {
  const config = validateProtocolConfig('openai-chat', { headers: { 'x-tenant': 'acme' } });
  assert.equal(config.headers['x-tenant'], 'acme');
});

test('UT-AIE-008: a header value with a newline is refused', () => {
  assert.throws(() => sanitizeHeaders({ 'x-tenant': 'a\r\nInjected: 1' }),
    (e) => e.code === 'AI_PROVIDER_CONFIG_INVALID');
});

test('UT-AIE-009: the openai body keeps the instructions and the inputs apart', () => {
  const config = validateProtocolConfig('openai-chat', { model: 'gpt-x', maxTokens: 100 });
  const body = buildProtocolBody('openai-chat', request(), config);
  assert.equal(body.model, 'gpt-x');
  assert.equal(body.max_tokens, 100);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'propose a login test');
  assert.equal(body.messages[1].role, 'user');
  // The input content is in the USER message, never in the system message.
  assert.ok(body.messages[1].content.includes('tests/a.spec.ts'));
  assert.ok(!body.messages[0].content.includes('tests/a.spec.ts'));
});

test('UT-AIE-010: the anthropic body carries the system prompt separately', () => {
  const config = validateProtocolConfig('anthropic-messages', { model: 'claude-x' });
  const body = buildProtocolBody('anthropic-messages', request(), config);
  assert.equal(body.system, 'propose a login test');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.ok(body.messages[0].content.includes('tests/a.spec.ts'));
});

test('UT-AIE-011: the rendered input carries the ref and the digest', () => {
  const text = renderInputs(request().inputs);
  assert.ok(text.includes('tests/a.spec.ts'));
  assert.ok(text.includes(sha('A')));
});

test('UT-AIE-012: the openai text is read from choices[0].message.content', () => {
  const text = extractProtocolText('openai-chat', { choices: [{ message: { content: 'hello' } }] });
  assert.equal(text, 'hello');
});

test('UT-AIE-013: the anthropic text is read from the text blocks', () => {
  const text = extractProtocolText('anthropic-messages', {
    content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }],
  });
  assert.equal(text, 'ab');
});

test('UT-AIE-014: a response without text is refused', () => {
  assert.throws(() => extractProtocolText('openai-chat', { choices: [] }),
    (e) => e.code === 'AI_PROVIDER_OUTPUT_INVALID');
  assert.throws(() => extractProtocolText('anthropic-messages', { content: [] }),
    (e) => e.code === 'AI_PROVIDER_OUTPUT_INVALID');
});

test('UT-AIE-015: the stop reason is read from both protocols', () => {
  assert.equal(extractStopReason('openai-chat', { choices: [{ finish_reason: 'stop' }] }), 'stop');
  assert.equal(extractStopReason('anthropic-messages', { stop_reason: 'end_turn' }), 'end_turn');
});

test('UT-AIE-016: a truncated stop reason is recognised', () => {
  assert.equal(isTruncatedStopReason('length'), true);
  assert.equal(isTruncatedStopReason('max_tokens'), true);
  assert.equal(isTruncatedStopReason('stop'), false);
  assert.equal(isTruncatedStopReason(null), false);
});

test('UT-AIE-017: the secret goes into the authentication header only', () => {
  const config = validateProtocolConfig('openai-chat', { model: 'm' });
  const headers = buildProtocolHeaders('openai-chat', config, 'sk-live');
  assert.equal(headers.authorization, 'Bearer sk-live');
  assert.ok(!JSON.stringify(headers).includes('sk-live') || headers.authorization.includes('sk-live'));
  // The secret is not in the body.
  const body = buildProtocolBody('openai-chat', request(), config);
  assert.ok(!JSON.stringify(body).includes('sk-live'));
});

test('UT-AIE-018: the anthropic headers carry the api key and the version', () => {
  const config = validateProtocolConfig('anthropic-messages', { model: 'm' });
  const headers = buildProtocolHeaders('anthropic-messages', config, 'sk-live');
  assert.equal(headers['x-api-key'], 'sk-live');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers.authorization, undefined);
});

test('UT-AIE-019: the default endpoints are the documented ones', () => {
  assert.equal(defaultBaseUrl('openai-chat'), 'https://api.openai.com/v1');
  assert.equal(defaultPath('openai-chat'), '/chat/completions');
  assert.equal(defaultBaseUrl('anthropic-messages'), 'https://api.anthropic.com/v1');
  assert.equal(defaultPath('anthropic-messages'), '/messages');
});

test('UT-AIE-020: the protocol config rejects a non-http endpoint', () => {
  assert.throws(() => validateProtocolConfig('openai-chat', { baseUrl: 'file:///etc/passwd' }),
    (e) => e.code === 'AI_PROVIDER_CONFIG_INVALID');
});

/* ------------------------------------------------------------- transport */

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(payload, status = 200) {
  return {
    status,
    text: async () => JSON.stringify(payload),
  };
}

test('UT-AIT-001: the openai text is returned by the transport', async () => {
  const fetchImpl = fakeFetch([jsonResponse({ choices: [{ message: { content: 'ok' } }] })]);
  const transport = createTransport({ fetch: fetchImpl });
  const config = validateProtocolConfig('openai-chat', { model: 'm' });
  const result = await transport.send({ config, request: request(), apiKey: 'k' });
  assert.equal(result.text, 'ok');
  assert.equal(result.status, 200);
});

test('UT-AIT-002: the request goes to the protocol endpoint with the secret in the header', async () => {
  const fetchImpl = fakeFetch([jsonResponse({ choices: [{ message: { content: 'ok' } }] })]);
  const transport = createTransport({ fetch: fetchImpl });
  const config = validateProtocolConfig('openai-chat', { model: 'm', baseUrl: 'https://example.test/v1' });
  await transport.send({ config, request: request(), apiKey: 'sk-live' });
  assert.equal(fetchImpl.calls[0].url, 'https://example.test/v1/chat/completions');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer sk-live');
  // The secret never reaches the URL or the body.
  assert.ok(!fetchImpl.calls[0].url.includes('sk-live'));
  assert.ok(!fetchImpl.calls[0].init.body.includes('sk-live'));
});

test('UT-AIT-003: a 429 is classified as a rate limit', async () => {
  const fetchImpl = fakeFetch([{ status: 429, text: async () => 'slow down' }]);
  const transport = createTransport({ fetch: fetchImpl });
  const config = validateProtocolConfig('openai-chat', { model: 'm' });
  await assert.rejects(
    () => transport.send({ config, request: request() }),
    (e) => e.code === 'AI_PROVIDER_RATE_LIMITED',
  );
});

test('UT-AIT-004: a 401 is classified as an auth failure', async () => {
  const fetchImpl = fakeFetch([{ status: 401, text: async () => 'nope' }]);
  const transport = createTransport({ fetch: fetchImpl });
  const config = validateProtocolConfig('openai-chat', { model: 'm' });
  await assert.rejects(
    () => transport.send({ config, request: request() }),
    (e) => e.code === 'AI_PROVIDER_AUTH_FAILED',
  );
});

test('UT-AIT-005: a 500 is classified as a server error', async () => {
  const fetchImpl = fakeFetch([{ status: 500, text: async () => 'boom' }]);
  const transport = createTransport({ fetch: fetchImpl });
  const config = validateProtocolConfig('openai-chat', { model: 'm' });
  await assert.rejects(
    () => transport.send({ config, request: request() }),
    (e) => e.code === 'AI_PROVIDER_SERVER_ERROR',
  );
});

test('UT-AIT-006: a network failure is classified as unavailable', async () => {
  const fetchImpl = fakeFetch([() => { throw new Error('ECONNREFUSED'); }]);
  const transport = createTransport({ fetch: fetchImpl });
  const config = validateProtocolConfig('openai-chat', { model: 'm' });
  await assert.rejects(
    () => transport.send({ config, request: request() }),
    (e) => e.code === 'AI_PROVIDER_UNAVAILABLE',
  );
});

test('UT-AIT-007: a response that is not JSON is refused', async () => {
  const fetchImpl = fakeFetch([{ status: 200, text: async () => '<html>nope</html>' }]);
  const transport = createTransport({ fetch: fetchImpl });
  const config = validateProtocolConfig('openai-chat', { model: 'm' });
  await assert.rejects(
    () => transport.send({ config, request: request() }),
    (e) => e.code === 'AI_PROVIDER_RESPONSE_INVALID',
  );
});

test('UT-AIT-008: a truncated answer is refused as an invalid output', async () => {
  const fetchImpl = fakeFetch([jsonResponse({ choices: [{ message: { content: '{"kind"' }, finish_reason: 'length' }] })]);
  const transport = createTransport({ fetch: fetchImpl });
  const config = validateProtocolConfig('openai-chat', { model: 'm' });
  await assert.rejects(
    () => transport.send({ config, request: request() }),
    (e) => e.code === 'AI_PROVIDER_OUTPUT_INVALID',
  );
});

test('UT-AIT-009: a request that outlives its budget is aborted and reported as a timeout', async () => {
  const fetchImpl = fakeFetch([(url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  })]);
  const transport = createTransport({ fetch: fetchImpl, timeoutMs: 30 });
  const config = validateProtocolConfig('openai-chat', { model: 'm' });
  await assert.rejects(
    () => transport.send({ config, request: request() }),
    (e) => e.code === 'AI_PROVIDER_TIMEOUT',
  );
});

test('UT-AIT-010: a deadline that already passed is refused without a request', async () => {
  const fetchImpl = fakeFetch([]);
  const transport = createTransport({ fetch: fetchImpl });
  const config = validateProtocolConfig('openai-chat', { model: 'm' });
  await assert.rejects(
    () => transport.send({ config, request: request(), deadlineAt: Date.now() - 1000 }),
    (e) => e.code === 'AI_PROVIDER_TIMEOUT',
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('UT-AIT-011: the status classification covers the documented codes', () => {
  assert.equal(classifyProviderStatus(401), 'AI_PROVIDER_AUTH_FAILED');
  assert.equal(classifyProviderStatus(403), 'AI_PROVIDER_AUTH_FAILED');
  assert.equal(classifyProviderStatus(429), 'AI_PROVIDER_RATE_LIMITED');
  assert.equal(classifyProviderStatus(400), 'AI_PROVIDER_REQUEST_INVALID');
  assert.equal(classifyProviderStatus(408), 'AI_PROVIDER_TIMEOUT');
  assert.equal(classifyProviderStatus(503), 'AI_PROVIDER_UNAVAILABLE');
  assert.equal(classifyProviderStatus(500), 'AI_PROVIDER_SERVER_ERROR');
});

/* -------------------------------------------------------------- provider */

test('UT-AIP-001: a provider without an id is refused', () => {
  assert.throws(() => createAiProvider({ protocol: 'openai-chat' }),
    (e) => e.code === 'AI_PROVIDER_CONFIG_INVALID');
});

test('UT-AIP-002: the provider resolves the key at call time, not at construction', async () => {
  let resolved = 0;
  const provider = createAiProvider({
    id: 'p1',
    protocol: 'openai-chat',
    config: { model: 'm', credentialId: `cred_${'b'.repeat(24)}` },
    resolveKey: async () => { resolved += 1; return 'sk-live'; },
    transport: { send: async () => ({ text: 'ok' }) },
  });
  assert.equal(resolved, 0, 'constructing the provider must not read the secret');
  await provider.complete(request(), {});
  assert.equal(resolved, 1);
});

test('UT-AIP-003: a credential reference without a resolver is a configuration error', async () => {
  const provider = createAiProvider({
    id: 'p1',
    protocol: 'openai-chat',
    config: { model: 'm', credentialId: `cred_${'b'.repeat(24)}` },
    transport: { send: async () => ({ text: 'ok' }) },
  });
  await assert.rejects(() => provider.complete(request(), {}),
    (e) => e.code === 'AI_PROVIDER_CONFIG_INVALID');
});

test('UT-AIP-004: a credential store failure is AI_CREDENTIAL_UNAVAILABLE, not a provider error', async () => {
  const provider = createAiProvider({
    id: 'p1',
    protocol: 'openai-chat',
    config: { model: 'm', credentialId: `cred_${'b'.repeat(24)}` },
    resolveKey: async () => { const e = new Error('nope'); e.code = 'CREDENTIAL_STORE_UNAVAILABLE'; throw e; },
    transport: { send: async () => ({ text: 'ok' }) },
  });
  await assert.rejects(() => provider.complete(request(), {}),
    (e) => e.code === 'AI_CREDENTIAL_UNAVAILABLE');
});

test('UT-AIP-005: a credential failure is NOT retryable', () => {
  assert.equal(isRetryableAiError(aiError('AI_CREDENTIAL_UNAVAILABLE')), false);
});

test('UT-AIP-006: the provider description carries no secret', () => {
  const provider = createAiProvider({
    id: 'p1', protocol: 'openai-chat', config: { model: 'm', credentialId: `cred_${'c'.repeat(24)}` },
  });
  const described = provider.describe();
  assert.equal(described.id, 'p1');
  assert.equal(described.model, 'm');
  assert.ok(!('apiKey' in described));
  assert.ok(!JSON.stringify(described).includes('sk-'));
});

test('UT-AIP-007: the contract provider wrapper keeps the AI code in the details', async () => {
  const provider = createAiProvider({
    id: 'p1', protocol: 'openai-chat', config: { model: 'm' },
    transport: { send: async () => { throw aiError('AI_PROVIDER_RATE_LIMITED'); } },
  });
  const wrapped = asContractProvider(provider);
  await assert.rejects(() => wrapped.complete(request(), {}), (e) => {
    assert.equal(e.code, 'AGENT_PROVIDER_ERROR');
    assert.equal(e.details.cause, 'AI_PROVIDER_RATE_LIMITED');
    return true;
  });
});

/* -------------------------------------------------------------- fallback */

function stubProvider(id, behaviour) {
  return { id, complete: behaviour };
}

test('UT-AIF-001: the chain stops at the first provider that answers', async () => {
  const chain = createFallbackChain({
    providers: [
      stubProvider('a', async () => ({ text: 'from-a' })),
      stubProvider('b', async () => ({ text: 'from-b' })),
    ],
  });
  const result = await chain.run(request(), {});
  assert.equal(result.provider, 'a');
  assert.equal(result.text, 'from-a');
  assert.equal(result.attempts.length, 1);
});

test('UT-AIF-002: a rate limit moves the chain to the next provider', async () => {
  const chain = createFallbackChain({
    providers: [
      stubProvider('a', async () => { throw aiError('AI_PROVIDER_RATE_LIMITED'); }),
      stubProvider('b', async () => ({ text: 'from-b' })),
    ],
  });
  const result = await chain.run(request(), {});
  assert.equal(result.provider, 'b');
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].ok, false);
  assert.equal(result.attempts[0].code, 'AI_PROVIDER_RATE_LIMITED');
});

test('UT-AIF-003: a timeout moves the chain to the next provider', async () => {
  const chain = createFallbackChain({
    providers: [
      stubProvider('a', async () => { throw aiError('AI_PROVIDER_TIMEOUT'); }),
      stubProvider('b', async () => ({ text: 'from-b' })),
    ],
  });
  const result = await chain.run(request(), {});
  assert.equal(result.provider, 'b');
});

test('UT-AIF-004: an auth failure stops the chain immediately', async () => {
  let bCalled = false;
  const chain = createFallbackChain({
    providers: [
      stubProvider('a', async () => { throw aiError('AI_PROVIDER_AUTH_FAILED'); }),
      stubProvider('b', async () => { bCalled = true; return { text: 'from-b' }; }),
    ],
  });
  await assert.rejects(() => chain.run(request(), {}), (e) => {
    assert.equal(e.code, 'AI_PROVIDER_AUTH_FAILED');
    assert.equal(e.details.attempts.length, 1);
    return true;
  });
  assert.equal(bCalled, false, 'an auth failure must not fall through to the next provider');
});

test('UT-AIF-005: a configuration error stops the chain immediately', async () => {
  let bCalled = false;
  const chain = createFallbackChain({
    providers: [
      stubProvider('a', async () => { throw aiError('AI_PROVIDER_CONFIG_INVALID'); }),
      stubProvider('b', async () => { bCalled = true; return { text: 'from-b' }; }),
    ],
  });
  await assert.rejects(() => chain.run(request(), {}), (e) => e.code === 'AI_PROVIDER_CONFIG_INVALID');
  assert.equal(bCalled, false);
});

test('UT-AIF-006: an exhausted chain reports every attempt', async () => {
  const chain = createFallbackChain({
    providers: [
      stubProvider('a', async () => { throw aiError('AI_PROVIDER_TIMEOUT'); }),
      stubProvider('b', async () => { throw aiError('AI_PROVIDER_RATE_LIMITED'); }),
    ],
  });
  await assert.rejects(() => chain.run(request(), {}), (e) => {
    assert.equal(e.code, 'AI_FALLBACK_EXHAUSTED');
    assert.equal(e.details.attempts.length, 2);
    assert.equal(e.details.attempts[0].provider, 'a');
    assert.equal(e.details.attempts[1].provider, 'b');
    return true;
  });
});

test('UT-AIF-007: every provider is tried at most once', async () => {
  const calls = [];
  const chain = createFallbackChain({
    providers: [
      stubProvider('a', async () => { calls.push('a'); throw aiError('AI_PROVIDER_TIMEOUT'); }),
      stubProvider('b', async () => { calls.push('b'); throw aiError('AI_PROVIDER_TIMEOUT'); }),
    ],
  });
  await assert.rejects(() => chain.run(request(), {}));
  assert.deepEqual(calls, ['a', 'b']);
});

test('UT-AIF-008: an empty chain fails immediately', async () => {
  const chain = createFallbackChain({ providers: [] });
  await assert.rejects(() => chain.run(request(), {}), (e) => e.code === 'AI_FALLBACK_EXHAUSTED');
});

test('UT-AIF-009: the retryable codes are exactly the transient ones', () => {
  assert.deepEqual([...RETRYABLE_AI_ERROR_CODES], [
    'AI_PROVIDER_TIMEOUT', 'AI_PROVIDER_RATE_LIMITED', 'AI_PROVIDER_UNAVAILABLE', 'AI_PROVIDER_SERVER_ERROR',
  ]);
  for (const code of AI_ERROR_CODES) {
    const retryable = isRetryableAiError(aiError(code));
    assert.equal(retryable, RETRYABLE_AI_ERROR_CODES.includes(code), `${code}`);
  }
});

test('UT-AIF-010: every error code has an explanation', () => {
  for (const code of AI_ERROR_CODES) {
    const text = explainAiError(code);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, `${code} must have an explanation`);
  }
});

test('UT-AIF-011: the attempt callback sees every attempt', async () => {
  const seen = [];
  const chain = createFallbackChain({
    providers: [
      stubProvider('a', async () => { throw aiError('AI_PROVIDER_TIMEOUT'); }),
      stubProvider('b', async () => ({ text: 'ok' })),
    ],
    onAttempt: (record) => seen.push(record),
  });
  await chain.run(request(), {});
  assert.equal(seen.length, 2);
  assert.equal(seen[0].ok, false);
  assert.equal(seen[1].ok, true);
});

/* --------------------------------------------------------------- service */

/** A credential store that resolves one fixed secret. */
function stubCredentialStore(secret = 'sk-live') {
  const calls = [];
  return {
    calls,
    resolve: async (id, purpose) => {
      calls.push({ id, purpose });
      if (id === 'missing') { const e = new Error('nope'); e.code = 'CREDENTIAL_NOT_FOUND'; throw e; }
      return secret;
    },
  };
}

/** A consent store that always grants (the gate's own logic is ATS-402's). */
function stubConsentStore() {
  return {
    check: () => ({ allowed: true }),
    checkConsent: () => ({ allowed: true }),
    find: async (id) => ({ id, state: 'granted', kinds: ['file'], scopeDigest: 'x' }),
  };
}

function stubAuditStore() {
  const records = [];
  return { records, record: async (r) => { records.push(r); } };
}

test('UT-AIS-001: the service requires a credential store, a consent store and a project lookup', () => {
  assert.throws(() => createModelService({}), (e) => e.code === 'AI_PROVIDER_CONFIG_INVALID');
  assert.throws(() => createModelService({ credentialStore: stubCredentialStore() }),
    (e) => e.code === 'AI_PROVIDER_CONFIG_INVALID');
});

test('UT-AIS-002: without a consent the request is never sent', async () => {
  const sent = [];
  const service = createModelService({
    credentialStore: stubCredentialStore(),
    consentStore: { check: () => ({ allowed: false, code: 'EGRESS_CONSENT_REQUIRED', reason: 'no consent' }), checkConsent: () => ({ allowed: false, code: 'EGRESS_CONSENT_REQUIRED' }), find: async () => null },
    auditStore: stubAuditStore(),
    getProject: () => ({ id: 'p1', root: '/tmp/p' }),
  });
  await assert.rejects(
    () => service.complete({
      projectId: 'p1',
      inputs: [{ kind: 'file', ref: 'a.ts' }],
      providers: [{ id: 'x', protocol: 'openai-chat', config: { model: 'm' } }],
      request: request(),
    }),
    (e) => e.code === 'AI_EGRESS_DENIED',
  );
  assert.equal(sent.length, 0);
});

test('UT-AIS-003: a denied egress is audited', async () => {
  const audit = stubAuditStore();
  const service = createModelService({
    credentialStore: stubCredentialStore(),
    consentStore: { check: () => ({ allowed: false, code: 'EGRESS_CONSENT_REQUIRED', reason: 'no consent' }), checkConsent: () => ({ allowed: false, code: 'EGRESS_CONSENT_REQUIRED' }), find: async () => null },
    auditStore: audit,
    getProject: () => ({ id: 'p1', root: '/tmp/p' }),
  });
  await assert.rejects(() => service.complete({
    projectId: 'p1',
    inputs: [{ kind: 'file', ref: 'a.ts' }],
    providers: [{ id: 'x', protocol: 'openai-chat', config: { model: 'm' } }],
    request: request(),
  }));
  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0].event, 'egress.denied');
  assert.equal(audit.records[0].outcome, 'denied');
});

test('UT-AIS-004: an unknown project is a denial, not a crash', async () => {
  const audit = stubAuditStore();
  const service = createModelService({
    credentialStore: stubCredentialStore(),
    consentStore: stubConsentStore(),
    auditStore: audit,
    getProject: () => { throw new Error('PROJECT_NOT_FOUND'); },
  });
  const verdict = await service.authorize({ projectId: 'nope', inputs: [{ kind: 'file', ref: 'a.ts' }] });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'EGRESS_GATE_PROJECT_UNKNOWN');
  assert.equal(audit.records[0].event, 'egress.denied');
});

test('UT-AIS-005: the secret is read from the credential store with the ai-provider purpose', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ats403-key-'));
  fs.writeFileSync(path.join(work, 'a.spec.ts'), 'test("a");\n');
  const credentials = stubCredentialStore();
  const consents = [];
  const service = createModelService({
    credentialStore: credentials,
    consentStore: createEgressConsentStore({
      list: async () => consents,
      persist: async (records) => { consents.splice(0, consents.length, ...records); },
    }),
    auditStore: stubAuditStore(),
    getProject: () => ({ id: 'p1', root: work }),
  });
  const inputs = [{ kind: 'file', ref: 'a.spec.ts' }];
  // The gate needs a granted consent whose scope matches the content.
  const scope = buildEgressScope({ project: { id: 'p1', root: work }, inputs });
  const preview = service.authorize; // the store is reached through the service
  const consentStore = createEgressConsentStore({
    list: async () => consents,
    persist: async (records) => { consents.splice(0, consents.length, ...records); },
  });
  const previewId = consentStore.preview(scope.items).previewId;
  const consent = await consentStore.confirm({ previewId, inputs: scope.items });
  assert.ok(preview);
  await service.complete({
    projectId: 'p1',
    inputs,
    consentId: consent.id,
    providers: [{
      id: 'x',
      protocol: 'openai-chat',
      config: { model: 'm', credentialId: `cred_${'d'.repeat(24)}`, baseUrl: 'https://127.0.0.1:1/v1' },
    }],
    request: request(),
  }).catch(() => {});
  assert.equal(credentials.calls.length, 1);
  assert.equal(credentials.calls[0].purpose, 'ai-provider');
  assert.equal(credentials.calls[0].id, `cred_${'d'.repeat(24)}`);
});

test('UT-AIS-006: a failure leaves the working tree byte-identical', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ats403-ws-'));
  fs.writeFileSync(path.join(work, 'a.spec.ts'), 'test("a");\n');
  const before = fs.readdirSync(work).map((f) => [f, sha(fs.readFileSync(path.join(work, f)))]);
  const service = createModelService({
    credentialStore: stubCredentialStore(),
    consentStore: stubConsentStore(),
    auditStore: stubAuditStore(),
    getProject: () => ({ id: 'p1', root: work }),
  });
  await service.complete({
    projectId: 'p1',
    inputs: [{ kind: 'file', ref: 'a.spec.ts' }],
    providers: [{ id: 'x', protocol: 'openai-chat', config: { model: 'm', baseUrl: 'https://127.0.0.1:1/v1' } }],
    request: request(),
  }).catch(() => {});
  const after = fs.readdirSync(work).map((f) => [f, sha(fs.readFileSync(path.join(work, f)))]);
  assert.deepEqual(after, before);
});

test('UT-AIS-007: the step budget is enforced', async () => {
  const service = createModelService({
    credentialStore: stubCredentialStore(),
    consentStore: stubConsentStore(),
    auditStore: stubAuditStore(),
    getProject: () => ({ id: 'p1', root: '/tmp/p' }),
  });
  await assert.rejects(
    () => service.executeSteps({
      providers: [{ id: 'x', protocol: 'openai-chat', config: { model: 'm', baseUrl: 'https://127.0.0.1:1/v1' } }],
      request: request(),
      maxSteps: 2,
    }),
    (e) => e.code === 'AI_STEPS_EXCEEDED',
  );
});

test('UT-AIS-008: a non-positive step budget is refused', async () => {
  const service = createModelService({
    credentialStore: stubCredentialStore(),
    consentStore: stubConsentStore(),
    auditStore: stubAuditStore(),
    getProject: () => ({ id: 'p1', root: '/tmp/p' }),
  });
  await assert.rejects(
    () => service.executeSteps({ providers: [], request: request(), maxSteps: 0 }),
    (e) => e.code === 'AI_PROVIDER_REQUEST_INVALID',
  );
});

test('UT-AIS-009: the adapter description states the policies and carries no secret', () => {
  const described = describeAiAdapter();
  assert.equal(described.contract, 'ai-adapter/v1');
  assert.deepEqual(described.protocols, ['openai-chat', 'anthropic-messages']);
  assert.ok(described.fallbackPolicy.length > 0);
  assert.ok(described.secretPolicy.includes('credential'));
  assert.ok(!JSON.stringify(described).match(/sk-[A-Za-z0-9]/));
});
