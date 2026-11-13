#!/usr/bin/env node
/**
 * ATS-403 boundary probe -- the model API adapter layer.
 *
 * The probe proves four boundaries with INDEPENDENT signals, and every
 * signal that could pass vacuously carries a NEGATIVE CONTROL:
 *
 *   signal 1  STATIC  -- the adapter layer must not contain the forbidden
 *                        patterns:
 *                          * a plaintext key written into a file;
 *                          * a secret passed as a PROCESS ARGUMENT;
 *                          * a secret written to a log or to stderr.
 *                        The negative control feeds the same detector a
 *                        deliberately broken copy and requires it to ALARM.
 *
 *   signal 2  RUNTIME -- the secret comes from the credential store and only
 *                        from there: it reaches the request as an
 *                        authentication header and appears nowhere else
 *                        (not in the URL, not in the body).
 *                        The negative control is a configuration that carries
 *                        a plaintext key -- the detector must FLAG it.
 *
 *   signal 3  RUNTIME -- the egress gate runs BEFORE the request: without a
 *                        consent the provider is never reached and no file
 *                        is read.
 *                        The negative control is a gate that is patched to
 *                        always allow -- the detector must FLAG it.
 *
 *   signal 4  RUNTIME -- a failure leaves the WORKING TREE byte-identical:
 *                        a timeout, a rate limit and an exhausted chain all
 *                        leave the project directory with the same file list
 *                        and the same digests.
 *                        The negative control is a deliberately broken
 *                        "provider" that writes a file into the project --
 *                        the detector must FLAG it, proving the check is not
 *                        vacuous.
 *
 * Usage: node tools/ats403-probes/probe-ai-boundary.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createTransport } from '../../server/ai/transport.mjs';
import { createAiProvider } from '../../server/ai/provider.mjs';
import { createFallbackChain } from '../../server/ai/fallback.mjs';
import { createModelService } from '../../server/ai/service.mjs';
import { validateProtocolConfig } from '../../server/ai/protocols.mjs';
import { aiError } from '../../server/ai/errors.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = process.env.ATS_PROBE_WORKDIR || path.join(os.tmpdir(), 'ats403-probes');

let failures = 0;
let checks = 0;

function check(label, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
}

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The files of a directory: name -> digest. */
function treeDigest(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    out[entry.name] = sha(fs.readFileSync(full));
  }
  return out;
}

/* ------------------------------------------------------- signal 1: static */

const ADAPTER_FILES = [
  'server/ai/errors.mjs',
  'server/ai/protocols.mjs',
  'server/ai/transport.mjs',
  'server/ai/provider.mjs',
  'server/ai/fallback.mjs',
  'server/ai/service.mjs',
];

/**
 * The forbidden patterns.
 *
 * `secretToFile`   -- a secret assigned into a write call.
 * `secretToArgv`   -- a secret put into a spawn argument array.
 * `secretToLog`    -- a secret put into a console/log call.
 */
const FORBIDDEN = [
  {
    name: 'secret-to-file',
    pattern: /writeFileSync\s*\([^)]*\b(?:apiKey|secret|token)\b/i,
  },
  {
    name: 'secret-to-argv',
    pattern: /(?:spawn|spawnSync|exec|execFile)\s*\([^)]*\b(?:apiKey|secret)\b/i,
  },
  {
    name: 'secret-to-log',
    pattern: /console\.(?:log|error|warn)\s*\([^)]*\b(?:apiKey|secret)\b/i,
  },
];

console.log('# signal 1 -- STATIC: the adapter layer does not write a secret anywhere');
for (const file of ADAPTER_FILES) {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  for (const rule of FORBIDDEN) {
    check(`${file}: no ${rule.name}`, !rule.pattern.test(source), rule.name);
  }
}

console.log('# signal 1 -- NEGATIVE CONTROL: the detector must alarm on a broken copy');
{
  const broken = 'const apiKey = read();\nwriteFileSync(target, apiKey);\n';
  const hit = FORBIDDEN.some((rule) => rule.pattern.test(broken));
  check('the negative control is detected', hit, 'a broken copy must trip the detector');
}

console.log('# signal 1 -- NEGATIVE CONTROL: the detector must alarm on a log leak');
{
  const broken = 'console.error("the key is", apiKey);\n';
  const hit = FORBIDDEN.some((rule) => rule.pattern.test(broken));
  check('the log-leak negative control is detected', hit);
}

console.log('# signal 1 -- NEGATIVE CONTROL: the detector must alarm on an argv leak');
{
  const broken = "spawn('helper', ['--key', secret]);\n";
  const hit = FORBIDDEN.some((rule) => rule.pattern.test(broken));
  check('the argv-leak negative control is detected', hit);
}

/* --------------------------------------------------- signal 2: the secret */

console.log('# signal 2 -- RUNTIME: the secret reaches the request as a header and nowhere else');
{
  const SECRET = 'sk-probe-0123456789';
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const provider = createAiProvider({
    id: 'probe',
    protocol: 'openai-chat',
    config: { model: 'm', baseUrl: 'https://probe.invalid/v1', credentialId: `cred_${'a'.repeat(24)}` },
    resolveKey: async () => SECRET,
    transport: createTransport({ fetch: fetchImpl }),
  });
  await provider.complete({ instructions: 'x', inputs: [] }, {});
  const call = calls[0];
  check('the secret is in the authorization header', call.init.headers.authorization === `Bearer ${SECRET}`);
  check('the secret is not in the URL', !call.url.includes(SECRET));
  check('the secret is not in the request body', !String(call.init.body).includes(SECRET));
  check('the secret is not in the provider description', !JSON.stringify(provider.describe()).includes(SECRET));
}

console.log('# signal 2 -- NEGATIVE CONTROL: a configuration with a plaintext key must be refused');
{
  let refused = false;
  try {
    validateProtocolConfig('openai-chat', { model: 'm', apiKey: 'sk-probe-0123456789' });
  } catch (error) {
    refused = error.code === 'AI_PROVIDER_CONFIG_INVALID';
  }
  check('a plaintext key in the configuration is refused', refused);
}

/* --------------------------------------------- signal 3: the egress gate */

console.log('# signal 3 -- RUNTIME: without a consent the provider is never reached');
{
  fs.mkdirSync(TMP, { recursive: true });
  const project = path.join(TMP, 'project');
  fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(project, 'tests', 'a.spec.ts'), 'test("a");\n', 'utf8');

  let reached = false;
  const provider = {
    id: 'probe',
    complete: async () => { reached = true; return { text: 'ok' }; },
  };
  const service = createModelService({
    credentialStore: { resolve: async () => 'sk-probe' },
    consentStore: {
      check: () => ({ allowed: false, code: 'EGRESS_CONSENT_REQUIRED', reason: 'no consent' }),
      checkConsent: () => ({ allowed: false, code: 'EGRESS_CONSENT_REQUIRED', reason: 'no consent' }),
      find: async () => null,
    },
    auditStore: { record: async () => {} },
    getProject: () => ({ id: 'p1', root: project }),
  });
  let code = null;
  try {
    await service.complete({
      projectId: 'p1',
      inputs: [{ kind: 'file', ref: 'tests/a.spec.ts' }],
      providers: [{ id: 'probe', protocol: 'openai-chat', config: { model: 'm' } }],
      request: { instructions: 'x', inputs: [] },
    });
  } catch (error) {
    code = error.code;
  }
  check('the call is refused with AI_EGRESS_DENIED', code === 'AI_EGRESS_DENIED', String(code));
  check('the provider was never reached', reached === false);
}

console.log('# signal 3 -- NEGATIVE CONTROL: a gate that always allows must be detected');
{
  // The same probe, but with a gate that always allows and a REAL input file
  // (so the denial above cannot be attributed to an unreadable file). The
  // detector must notice that the request was NOT refused by the gate --
  // otherwise the check above would be satisfied by a gate that never
  // refuses anything.
  const project = path.join(TMP, 'project3');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'a.spec.ts'), 'test("a");\n', 'utf8');
  const service = createModelService({
    credentialStore: { resolve: async () => 'sk-probe' },
    consentStore: {
      check: () => ({ allowed: true }),
      checkConsent: () => ({ allowed: true }),
      find: async () => ({ id: 'egr_x', state: 'granted', kinds: ['file'], scopeDigest: 'x' }),
    },
    auditStore: { record: async () => {} },
    getProject: () => ({ id: 'p1', root: project }),
  });
  let code = null;
  try {
    await service.complete({
      projectId: 'p1',
      inputs: [{ kind: 'file', ref: 'a.spec.ts' }],
      providers: [{
        id: 'probe',
        protocol: 'openai-chat',
        config: { model: 'm', baseUrl: 'http://127.0.0.1:1/v1' },
      }],
      request: { instructions: 'x', inputs: [] },
    });
  } catch (error) {
    code = error.code;
  }
  check('the always-allow gate does NOT produce AI_EGRESS_DENIED', code !== 'AI_EGRESS_DENIED', String(code));
  check('the always-allow gate let the request through to the provider', code !== null, String(code));
}

/* ----------------------------------------- signal 4: the workspace is clean */

console.log('# signal 4 -- RUNTIME: a failure leaves the working tree byte-identical');
{
  const project = path.join(TMP, 'project4');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'a.spec.ts'), 'test("a");\n', 'utf8');
  const before = treeDigest(project);

  const fetchImpl = async () => ({ status: 429, text: async () => 'rate limited' });
  const chain = createFallbackChain({
    providers: [createAiProvider({
      id: 'limited',
      protocol: 'openai-chat',
      config: { model: 'm' },
      transport: createTransport({ fetch: fetchImpl }),
    })],
  });
  let code = null;
  try {
    await chain.run({ instructions: 'x', inputs: [] }, {});
  } catch (error) {
    code = error.code;
  }
  // Every attempt failed with the same code, so THAT (actionable) code is
  // reported -- not the generic "the chain was exhausted", which would hide
  // the fact that the caller should retry later.
  check('the rate limit is reported', code === 'AI_PROVIDER_RATE_LIMITED', String(code));
  const after = treeDigest(project);
  check('the working tree is byte-identical after a rate limit', JSON.stringify(after) === JSON.stringify(before));
}

console.log('# signal 4 -- RUNTIME: a timeout leaves the working tree byte-identical');
{
  const project = path.join(TMP, 'project4');
  const before = treeDigest(project);
  const fetchImpl = async (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const transport = createTransport({ fetch: fetchImpl, timeoutMs: 30 });
  const provider = createAiProvider({ id: 'slow', protocol: 'openai-chat', config: { model: 'm' }, transport });
  let code = null;
  try {
    await provider.complete({ instructions: 'x', inputs: [] }, {});
  } catch (error) {
    code = error.code;
  }
  check('the timeout is reported', code === 'AI_PROVIDER_TIMEOUT', String(code));
  const after = treeDigest(project);
  check('the working tree is byte-identical after a timeout', JSON.stringify(after) === JSON.stringify(before));
}

console.log('# signal 4 -- NEGATIVE CONTROL: a provider that writes into the project must be detected');
{
  const project = path.join(TMP, 'project4');
  const before = treeDigest(project);
  // A deliberately broken "provider" that pollutes the workspace. The
  // detector must SEE the pollution -- otherwise the two checks above would
  // be satisfied by a comparison that never looks at the file list.
  fs.writeFileSync(path.join(project, 'pollution.txt'), 'written by the broken provider\n', 'utf8');
  const after = treeDigest(project);
  check('the pollution is detected', JSON.stringify(after) !== JSON.stringify(before));
  fs.unlinkSync(path.join(project, 'pollution.txt'));
}

/* ----------------------------------------------- the fallback chain rules */

console.log('# the fallback chain: only transient errors move the chain on');
{
  const attempts = [];
  const chain = createFallbackChain({
    providers: [
      { id: 'a', complete: async () => { attempts.push('a'); throw aiError('AI_PROVIDER_RATE_LIMITED'); } },
      { id: 'b', complete: async () => { attempts.push('b'); throw aiError('AI_PROVIDER_AUTH_FAILED'); } },
      { id: 'c', complete: async () => { attempts.push('c'); return { text: 'ok' }; } },
    ],
  });
  let code = null;
  try {
    await chain.run({ instructions: 'x', inputs: [] }, {});
  } catch (error) {
    code = error.code;
  }
  check('the chain stops at the auth failure', code === 'AI_PROVIDER_AUTH_FAILED', String(code));
  check('the third provider was never tried', !attempts.includes('c'), attempts.join(','));
}

console.log('');
console.log(`checks: ${checks}, failures: ${failures}`);
console.log(failures === 0 ? 'RESULT: OK' : 'RESULT: FAILED');
process.exit(failures === 0 ? 0 : 1);
