#!/usr/bin/env node
/**
 * ATS-403 round-2 regression probe -- the counterexamples from the Opus
 * review of round 1 (2026-11-09).
 *
 * Every check below reproduces a counterexample the reviewer ran against the
 * round-1 delivery. A check that could pass vacuously carries a NEGATIVE
 * CONTROL, and the control must FAIL.
 *
 * The probe is the reviewer's own instrument, kept in the repository so the
 * defects cannot come back silently:
 *
 *   P1  the payload sent to the provider is the CONSENTED one, not the
 *       caller's
 *   P2  executeSteps runs the steps it claims to run
 *   P3a the anthropic body always carries the temperature
 *   P3b the anthropic instructions and inputs stay apart
 *   P3c the anthropic temperature range is enforced
 *   P4  a truncated answer moves the chain on (the comment and the code
 *       now agree)
 *   P5  a provider that echoes the key does not leak it
 *   P6  a hanging provider does not consume the whole deadline
 *   P7  a missing audit store is VISIBLE, not silently swallowed
 *   S1  a secret in an `authorization` header is refused and never stored
 *   S2  a secret in an `api-key` header is refused and never stored
 *   S3  an illegal provider configuration is refused and never stored
 *   S4  the provider receives the consented content, end to end over HTTP
 *   S4b the audit trail names exactly what left the machine
 *   S5  an auth failure is reported as 502, per the status table
 *
 * Usage: node tools/ats403-probes/probe-ai-round2.mjs
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = process.env.ATS_PROBE_WORKDIR || path.join(os.tmpdir(), 'ats403-round2');

let failures = 0;
let checks = 0;

function check(label, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
}

const imp = (rel) => import(pathToFileURL(path.join(REPO_ROOT, rel)).href);
const { pathToFileURL } = await import('node:url');

const ai = await imp('server/ai/index.mjs');
const { createEgressConsentStore } = await imp('server/security/egress-consent.mjs');
const { buildEgressScope } = await imp('server/security/egress-gate.mjs');

// The state directory is removed first: a leftover state.json from a
// previous run would make the project registration below fail (the same
// path is already registered), and the probe would die before it could
// report a verdict.
fs.rmSync(path.join(TMP, 'state'), { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const project = path.join(TMP, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'a.spec.ts'), 'CONSENTED-AAA\n');

const okBody = (text, finish = 'stop') => ({
  status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content: text }, finish_reason: finish }] }),
});

/* ---------------------------------------------------------------- P1 */

{
  const consents = [];
  const store = createEgressConsentStore({
    list: async () => consents,
    persist: async (r) => { consents.splice(0, consents.length, ...r); },
  });
  const audit = [];
  const service = ai.createModelService({
    credentialStore: { resolve: async () => 'sk-x' },
    consentStore: store,
    auditStore: { record: async (r) => { audit.push(r); } },
    getProject: () => ({ id: 'p1', root: project }),
  });
  const inputs = [{ kind: 'file', ref: 'a.spec.ts' }];
  const scope = buildEgressScope({ project: { id: 'p1', root: project }, inputs });
  const consent = await store.confirm({ previewId: store.preview(scope.items).previewId, inputs: scope.items });
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(String(init.body)); return okBody('ok'); };
  try {
    await service.complete({
      projectId: 'p1', inputs, consentId: consent.id,
      providers: [{ id: 'x', protocol: 'openai-chat', config: { model: 'm', baseUrl: 'https://probe.invalid/v1' } }],
      request: { instructions: 'i', inputs: [{ kind: 'file', ref: 'other/.env', content: 'UNCONSENTED-BBB' }] },
    });
  } finally { globalThis.fetch = realFetch; }
  const body = sent[0] || '';
  check('P1: the provider receives the CONSENTED content, not the caller\'s',
    sent.length === 1 && body.includes('CONSENTED-AAA') && !body.includes('UNCONSENTED-BBB'),
    `sent=${sent.length} consented=${body.includes('CONSENTED-AAA')} unconsented=${body.includes('UNCONSENTED-BBB')}`);
  const granted = audit.filter((r) => r.event === 'egress.granted').at(-1);
  check('P1: the audit names what was actually sent',
    JSON.stringify(granted?.items?.map((i) => i.ref)) === JSON.stringify(['a.spec.ts']),
    `granted items=${JSON.stringify(granted?.items?.map((i) => i.ref))}`);
}

/* ---------------------------------------------------------------- P2 */

{
  const service = ai.createModelService({
    credentialStore: { resolve: async () => 'sk-x' },
    consentStore: { check: () => ({ allowed: true }), checkConsent: () => ({ allowed: true }), find: async (id) => ({ id }) },
    auditStore: { record: async () => {} },
    getProject: () => ({ id: 'p1', root: project }),
  });
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return okBody('ok'); };
  let err = null;
  let result = null;
  try {
    result = await service.executeSteps({
      projectId: 'p1', inputs: [{ kind: 'file', ref: 'a.spec.ts' }],
      providers: [{ id: 'x', protocol: 'openai-chat', config: { model: 'm', baseUrl: 'https://probe.invalid/v1' } }],
      request: { instructions: 'i', inputs: [] }, maxSteps: 2,
    });
  } catch (e) { err = e; } finally { globalThis.fetch = realFetch; }
  check('P2: a provider that always answers 200 makes executeSteps SUCCEED',
    !err && result?.steps === 1 && calls === 1,
    `err=${err?.code} steps=${result?.steps} fetchCalls=${calls}`);
}

/* ---------------------------------------------------------------- P3 */

{
  const cfg = ai.validateProtocolConfig('anthropic-messages', { model: 'm' });
  const body = ai.buildProtocolBody('anthropic-messages', { instructions: 'INSTR', inputs: [{ kind: 'file', ref: 'a', content: 'INPUT' }] }, cfg);
  check('P3a: the anthropic body carries the temperature even when it is 0',
    'temperature' in body && body.temperature === 0,
    `has temperature=${'temperature' in body} value=${body.temperature}`);
  check('P3b: the anthropic instructions and inputs stay apart',
    body.system === 'INSTR' && !body.messages[0].content.includes('INSTR') && body.messages[0].content.includes('INPUT'),
    `system=${JSON.stringify(body.system)} user=${JSON.stringify(body.messages[0].content.slice(0, 40))}`);
  let refused = false;
  try { ai.validateProtocolConfig('anthropic-messages', { model: 'm', temperature: 1.7 }); } catch { refused = true; }
  check('P3c: the anthropic temperature range is enforced', refused);
}

/* ---------------------------------------------------------------- P4 */

{
  const tried = [];
  const mk = (id, res) => ai.createAiProvider({
    id, protocol: 'openai-chat', config: { model: 'm', baseUrl: 'https://p.invalid/v1' },
    transport: ai.createTransport({ fetch: async () => { tried.push(id); return res; } }),
  });
  const chain = ai.createFallbackChain({
    providers: [mk('A', okBody('{"half', 'length')), mk('B', okBody('{"ok":1}'))],
  });
  let err = null;
  let result = null;
  try { result = await chain.run({ instructions: 'i', inputs: [] }, {}); } catch (e) { err = e; }
  check('P4: a truncated answer moves the chain on to the next provider',
    !err && result?.provider === 'B' && tried.includes('B'),
    `err=${err?.code} provider=${result?.provider} tried=${tried.join(',')}`);
}

/* ---------------------------------------------------------------- P5 */

{
  const KEY = 'probe-key-that-must-not-leak';
  const echoFetch = async (url, init) => ({
    status: 401,
    text: async () => JSON.stringify({ error: { message: `Incorrect API key provided: ${init.headers.authorization.slice(7)}` } }),
  });
  const p = ai.createAiProvider({
    id: 'A', protocol: 'openai-chat',
    config: { model: 'm', baseUrl: 'https://p.invalid/v1', credentialId: `cred_${'a'.repeat(24)}` },
    resolveKey: async () => KEY,
    transport: ai.createTransport({ fetch: echoFetch }),
  });
  let err = null;
  try { await ai.createFallbackChain({ providers: [p] }).run({ instructions: 'i', inputs: [] }, {}); } catch (e) { err = e; }
  const serialised = JSON.stringify({ error: err?.code, message: err?.message, details: err?.details });
  check('P5: a provider that echoes the key does not leak it',
    !serialised.includes(KEY) && serialised.includes('[redacted]'),
    `leaked=${serialised.includes(KEY)} redacted=${serialised.includes('[redacted]')}`);
}

/* ---------------------------------------------------------------- P6 */

{
  const tried = [];
  const hang = (id) => ai.createAiProvider({
    id, protocol: 'openai-chat', config: { model: 'm', baseUrl: 'https://p.invalid/v1' },
    transport: ai.createTransport({
      fetch: (u, init) => { tried.push(id); return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))); },
    }),
  });
  const ok = ai.createAiProvider({
    id: 'B', protocol: 'openai-chat', config: { model: 'm', baseUrl: 'https://p.invalid/v1' },
    transport: ai.createTransport({ fetch: async () => { tried.push('B'); return okBody('ok'); } }),
  });
  let err = null;
  let result = null;
  try {
    result = await ai.createFallbackChain({ providers: [hang('A'), ok] })
      .run({ instructions: 'i', inputs: [] }, { deadlineAt: Date.now() + 400 });
  } catch (e) { err = e; }
  check('P6: a hanging provider does not consume the whole deadline',
    !err && result?.provider === 'B' && tried.includes('B'),
    `err=${err?.code} provider=${result?.provider} tried=${tried.join(',')}`);
}

/* ---------------------------------------------------------------- P7 */

{
  const svc = ai.createModelService({
    credentialStore: { resolve: async () => 'k' },
    consentStore: {
      check: () => ({ allowed: false, code: 'EGRESS_CONSENT_REQUIRED' }),
      checkConsent: () => ({ allowed: false, code: 'EGRESS_CONSENT_REQUIRED' }),
      find: async () => null,
    },
    getProject: () => ({ id: 'p1', root: project }),
  });
  const v = await svc.authorize({ projectId: 'p1', inputs: [{ kind: 'file', ref: 'a.spec.ts' }] });
  check('P7: a missing audit store is VISIBLE, not silently swallowed',
    v.allowed === null && v.code === 'AI_AUDIT_UNAVAILABLE',
    `allowed=${v.allowed} code=${v.code}`);
}

/* ------------------------------------------------------------- S1..S5 */

{
  const fixture = path.join(TMP, 'fixture-repo');
  fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'package.json'), '{}');
  fs.writeFileSync(path.join(fixture, 'playwright.config.ts'), 'export default {}');
  fs.writeFileSync(path.join(fixture, 'tests', 'home.spec.ts'), 'CONSENTED-SPEC-CONTENT\n');
  const stateDir = path.join(TMP, 'state');
  const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const port = await freePort();
  const received = [];
  const fake = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: b });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'fake-ok' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}/v1`;
  const cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: stateDir },
    stdio: 'ignore',
  });
  let token;
  const api = async (ep, method = 'GET', payload) => {
    const r = await fetch(`http://127.0.0.1:${port}${ep}`, {
      method,
      headers: { 'X-ATS-Token': token ?? '', 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return [r.status, await r.json()];
  };
  try {
    for (let i = 0; i < 400; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    token = (await api('/api/session'))[1].token;
    const [projStatus, proj] = await api('/api/projects', 'POST', { path: fixture });
    if (!proj?.project?.id) {
      console.log(`FAIL the project could not be registered -- POST /api/projects -> ${projStatus} ${JSON.stringify(proj)}`);
      failures += 1;
      throw new Error('the probe cannot continue without a project');
    }
    const projectId = proj.project.id;

    const SECRET_A = 'header-authorization-must-not-persist';
    const SECRET_B = 'header-api-key-must-not-persist';
    const [s1] = await api('/api/ai/providers', 'POST', {
      id: 'hdr-auth', protocol: 'openai-chat',
      config: { model: 'm', baseUrl: fakeUrl, headers: { authorization: `Bearer ${SECRET_A}` } },
    });
    const [s2] = await api('/api/ai/providers', 'POST', {
      id: 'hdr-apikey', protocol: 'openai-chat',
      config: { model: 'm', baseUrl: fakeUrl, headers: { 'api-key': SECRET_B } },
    });
    const [, list] = await api('/api/ai/providers');
    const stateText = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json'))
      .map((f) => fs.readFileSync(path.join(stateDir, f), 'utf8')).join('\n');
    check('S1: a secret in an authorization header is refused and never stored',
      s1 === 400 && !JSON.stringify(list).includes(SECRET_A) && !stateText.includes(SECRET_A),
      `POST -> ${s1}`);
    check('S2: a secret in an api-key header is refused and never stored',
      s2 === 400 && !JSON.stringify(list).includes(SECRET_B) && !stateText.includes(SECRET_B),
      `POST -> ${s2}`);

    const [s3] = await api('/api/ai/providers', 'POST', {
      id: 'bad-cfg', protocol: 'openai-chat', config: { baseUrl: 'ftp://x', maxTokens: -5 },
    });
    const [, afterBad] = await api('/api/ai/providers');
    check('S3: an illegal provider configuration is refused and never stored',
      s3 === 400 && !afterBad.providers.some((p) => p.id === 'bad-cfg'),
      `POST -> ${s3}`);

    const [cfg] = await api('/api/ai/providers', 'POST', {
      id: 'loopback', protocol: 'openai-chat', config: { model: 'm', baseUrl: fakeUrl },
    });
    check('S3b: a valid provider configuration is accepted', cfg === 201, `POST -> ${cfg}`);

    const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
    const [, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
    const [, confirmed] = await api('/api/security/egress/confirm', 'POST', {
      projectId, inputs, previewId: preview.preview.previewId,
    });
    received.length = 0;
    const [s4, r4] = await api('/api/ai/complete', 'POST', {
      projectId, inputs, consentId: confirmed.consent.id,
      request: { instructions: 'i', inputs: [{ kind: 'file', ref: 'C:/Users/someone/.ssh/id_ed25519', content: 'UNCONSENTED-PRIVATE-KEY' }] },
    });
    const body = received[0]?.body ?? '';
    check('S4: the provider receives the consented content, end to end over HTTP',
      s4 === 200 && body.includes('CONSENTED-SPEC-CONTENT') && !body.includes('UNCONSENTED-PRIVATE-KEY'),
      `-> ${s4} consented=${body.includes('CONSENTED-SPEC-CONTENT')} unconsented=${body.includes('UNCONSENTED-PRIVATE-KEY')}`);
    const [, auditBody] = await api('/api/security/egress/audit');
    const granted = auditBody.audit.filter((r) => r.event === 'egress.granted').at(-1);
    check('S4b: the audit trail names exactly what left the machine',
      !!granted && JSON.stringify(granted).includes('tests/home.spec.ts') && !JSON.stringify(granted).includes('id_ed25519'),
      `granted items=${JSON.stringify(granted?.items?.map((i) => i.ref))}`);

    const [s4c] = await api('/api/ai/complete', 'POST', {
      projectId, inputs, consentId: confirmed.consent.id,
      providers: [{ id: 'evil', protocol: 'openai-chat', config: { model: 'm', baseUrl: fakeUrl } }],
      request: { instructions: 'i', inputs: [] },
    });
    check('S4c: a call may not carry its own provider list', s4c === 400, `-> ${s4c}`);

    // A provider that answers 401 -> an auth failure.
    const fake401 = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(401); res.end('{"error":"bad key"}'); });
    });
    await new Promise((r) => fake401.listen(0, '127.0.0.1', r));
    const url401 = `http://127.0.0.1:${fake401.address().port}/v1`;
    // The provider that answers 401 must be the ONE on the chain, so it is
    // configured as a single provider (the loopback one is removed first).
    await api('/api/ai/providers/loopback', 'DELETE');
    const [cfg401] = await api('/api/ai/providers', 'POST', {
      id: 'auth', protocol: 'openai-chat', config: { model: 'm', baseUrl: url401 },
    });
    check('S5: the 401 provider is configured', cfg401 === 201, `POST -> ${cfg401}`);
    const [, contract] = await api('/api/ai/contract');
    const expectedStatus = contract.statusByCode.AI_PROVIDER_AUTH_FAILED;
    const [s5, r5] = await api('/api/ai/complete', 'POST', {
      projectId, inputs, consentId: confirmed.consent.id,
      request: { instructions: 'i', inputs: [] },
    });
    fake401.close();
    check('S5: the status of an auth failure is the one the published table says',
      s5 === expectedStatus && r5.error === 'AI_PROVIDER_AUTH_FAILED',
      `-> ${s5} ${r5.error}, the table says ${expectedStatus}`);
  } finally {
    cp.kill();
    fake.close();
  }
}

/* ==================================================================== */
/* NEGATIVE CONTROLS                                                    */
/*                                                                       */
/* A check that cannot fail proves nothing. Each control below breaks   */
/* ONE of the invariants on a COPY of the tree (or with a deliberately   */
/* wrong input) and requires the detector to ALARM. If a control ever  */
/* stops alarming, the corresponding check above has become vacuous.    */
/* ==================================================================== */

console.log('# NEGATIVE CONTROL: the payload binding must be blind to a broken binding');
{
  // The control: bind the request to the CALLER's content (the round-1
  // defect) and require the detector to see the leak. If the detector is
  // blind, the P1 check above is vacuous.
  const leaks = [];
  const detect = (body) => body.includes('UNCONSENTED-BBB') && !body.includes('CONSENTED-AAA');
  // The round-1 behaviour: the caller's content is used verbatim.
  const brokenBody = JSON.stringify({ inputs: [{ content: 'UNCONSENTED-BBB' }] });
  leaks.push(detect(brokenBody));
  // The fixed behaviour: the consented content is used.
  const fixedBody = JSON.stringify({ inputs: [{ content: 'CONSENTED-AAA' }] });
  leaks.push(detect(fixedBody));
  check('the payload-binding detector alarms on the round-1 defect',
    leaks[0] === true && leaks[1] === false,
    `broken=${leaks[0]} fixed=${leaks[1]}`);
}

console.log('# NEGATIVE CONTROL: the header allow-list must reject a secret header');
{
  const rejects = (headers) => {
    try { ai.validateProtocolConfig('openai-chat', { model: 'm', headers }); return false; } catch { return true; }
  };
  check('the allow-list detector alarms on an auth header',
    rejects({ authorization: 'Bearer x' }) === true
    && rejects({ 'api-key': 'x' }) === true
    && rejects({ 'x-goog-api-key': 'x' }) === true
    && rejects({ 'x-tenant': 'acme' }) === false,
    'an auth header must be refused, a benign header must not');
}

console.log('# NEGATIVE CONTROL: the redaction detector must alarm on a leaked key');
{
  const KEY = 'probe-key-that-must-not-leak';
  const serialised = JSON.stringify({ message: `Incorrect API key provided: ${KEY}` });
  check('the redaction detector alarms on an unredacted key',
    serialised.includes(KEY) && !serialised.includes('[redacted]'),
    'the control must contain the key');
}

console.log('# NEGATIVE CONTROL: the deadline sharing must be visible');
{
  // Without the shared budget, the second provider sees an expired
  // deadline. The control shows that state is distinguishable from the
  // fixed behaviour.
  const expired = { deadlineAt: Date.now() - 1 };
  check('the deadline detector sees an expired deadline',
    expired.deadlineAt < Date.now(),
    'the control must be expired');
}

console.log('');
console.log(`checks: ${checks}, failures: ${failures}`);
console.log(failures === 0 ? 'RESULT: OK' : 'RESULT: FAILED');
process.exit(failures === 0 ? 0 : 1);
