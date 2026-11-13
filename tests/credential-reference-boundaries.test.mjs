/**
 * ATS-213 ｜ 凭据引用的**收口**与**脱敏**——单元测试
 *
 * 这些用例断言复核第 2 轮登记的三条必改项：
 *
 *   1. **P1**｜状态面**不读明文**。`status()` / `statusAll()` 走 `probe()`，
 *      `read()` 只留给真正要注入环境的那一处。探针用一个**会计数**的替身，
 *      断言 `read()` 的调用次数是 **0**。
 *   2. **P2**｜**fail closed**。未解析的引用到达环境块时**必须被拒**，
 *      绝不 `String()` 成 `"[object Object]"`。
 *   3. **P3**｜注入的密钥在平台落盘前**必须脱敏**，而且脱敏**跨分块**。
 *
 * 每条断言都要有**牙齿**：第 6 节给出了对应的变异体——把修复改回缺陷的
 * 样子，这三条断言必须**变红**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCredentialStore } from '../server/security/credentials.mjs';
import { buildRunnerEnv, runnerVariableValue } from '../server/env/profiles.mjs';
import {
  createRedactor, safePrefixLength, SECRET_MASK,
  readZipMembers, writeZipMembers, redactEmbeddedArchives,
  redactRunFolder, redactRunArchives,
} from '../server/env/secret-redaction.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats213-ref2-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshIndex = () => path.join(tmp, `idx-${n++}`, 'credentials.json');
const freshDir = () => path.join(tmp, `dir-${n++}`);

/** 一个**会计数**的凭据库替身：它数 `read()` 与 `probe()` 被调了几次。 */
function countingVault() {
  const entries = new Map();
  const calls = { read: 0, probe: 0, write: 0 };
  return {
    entries,
    calls,
    name: 'counting-vault',
    available: async () => true,
    async write(id, secret) { calls.write += 1; entries.set(id, secret); },
    async read(id) {
      calls.read += 1;
      if (!entries.has(id)) throw new Error('CREDENTIAL_NOT_FOUND');
      return entries.get(id);
    },
    async probe(id) {
      calls.probe += 1;
      if (!entries.has(id)) throw new Error('CREDENTIAL_NOT_FOUND');
      return 'PRESENT';
    },
    async remove(id) { entries.delete(id); },
  };
}

/* ------------------------------------------------------------------ */
/* P1 ｜ 状态面不读明文                                                */
/* ------------------------------------------------------------------ */

test('ATS213-R3-UT-001: statusAll() never reads a PLAINTEXT out of the store', async () => {
  // The status surface answers "is this entry there?". The PROBE answers
  // that without the secret ever leaving the credential store, so the
  // Bridge's memory never holds a plaintext just because somebody opened
  // the security page.
  //
  // The assertion is a COUNT, not an inspection: a fake backend that
  // counts the calls proves that `read()` is not used at all.
  const vault = countingVault();
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  for (const name of ['a', 'b', 'c']) {
    await store.put({ name: `r3-${name}`, secret: `sk-r3-${name}-0123456789`, purpose: 'other' });
  }
  // The puts used `write()`, not `read()`. The counter is reset so the
  // assertion is about the STATUS walk alone.
  vault.calls.read = 0;
  vault.calls.probe = 0;
  const all = await store.statusAll();
  assert.equal(all.length, 3, 'every reference has a status');
  assert.equal(vault.calls.read, 0, 'statusAll() must NOT read a plaintext out of the store');
  assert.equal(vault.calls.probe, 3, 'statusAll() measures every reference with the probe');
});

test('ATS213-R3-UT-002: status() never reads a PLAINTEXT out of the store', async () => {
  const vault = countingVault();
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const ref = await store.put({ name: 'r3-one', secret: 'sk-r3-one-0123456789', purpose: 'other' });
  vault.calls.read = 0;
  vault.calls.probe = 0;
  const status = await store.status(ref.id);
  assert.equal(status.status, 'configured');
  assert.equal(vault.calls.read, 0, 'status() must NOT read a plaintext out of the store');
  assert.equal(vault.calls.probe, 1);
});

test('ATS213-R3-UT-003: the PLAINTEXT still comes out when it is really needed', async () => {
  // The probe-based status surface must not have broken the ONE place that
  // really needs the secret: resolving a reference for the runner's
  // environment.
  const vault = countingVault();
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const ref = await store.put({ name: 'r3-resolve', secret: 'sk-r3-resolve-0123456789', purpose: 'other' });
  vault.calls.read = 0;
  const secret = await store.resolve(ref.id, 'other');
  assert.equal(secret, 'sk-r3-resolve-0123456789');
  assert.equal(vault.calls.read, 1, 'resolve() reads the secret -- that is its job');
});

/* ------------------------------------------------------------------ */
/* P2 ｜ 未解析的引用必须被拒                                          */
/* ------------------------------------------------------------------ */

test('ATS213-R3-UT-004: an unresolved reference never becomes "[object Object]"', () => {
  // The fail-open primitive: `String({credentialRef:'cred_…'})` is the
  // literal string "[object Object]", and a run that injects that under a
  // credential-shaped name runs the system under test with a BOGUS token.
  // The failure is silent, which makes it the worse outcome.
  const reference = { credentialRef: 'cred_0123456789abcdef01234567' };
  assert.equal(runnerVariableValue('API_TOKEN', reference), null,
    'a reference is not a value: the function says so instead of inventing one');
  const env = buildRunnerEnv({ variables: { API_TOKEN: reference } });
  assert.equal(env.API_TOKEN, undefined, 'the reference is left OUT of the environment block');
  assert.ok(!String(env.API_TOKEN).includes('object Object'));
});

test('ATS213-R3-UT-005: a refused variable is REPORTED, not swallowed', () => {
  const refused = [];
  buildRunnerEnv(
    { variables: { API_TOKEN: { credentialRef: 'cred_0123456789abcdef01234567' }, BASE_URL: 'u' } },
    { onRefused: (names) => refused.push(...names) },
  );
  assert.deepEqual(refused, ['API_TOKEN'], 'the refused variable is named');
});

test('ATS213-R3-UT-006: the shorthand reference is refused the same way', () => {
  const env = buildRunnerEnv({ variables: { API_TOKEN: 'cred:0123456789abcdef01234567' } });
  assert.equal(env.API_TOKEN, undefined);
  assert.ok(!String(env.API_TOKEN).includes('object Object'));
});

test('ATS213-R3-UT-007: an ordinary value still reaches the runner', () => {
  // The refusal must not break the ordinary path: a plain value is still a
  // string and still goes into the block.
  const env = buildRunnerEnv({ variables: { BASE_URL: 'https://example.test', COUNT: 3 } });
  assert.equal(env.BASE_URL, 'https://example.test');
  assert.equal(env.COUNT, '3');
});

/* ------------------------------------------------------------------ */
/* P3 ｜ 注入的密钥在落盘前脱敏                                        */
/* ------------------------------------------------------------------ */

const SECRET = 'r3-leak-secret-7f3a91c2e5';

test('ATS213-R3-UT-008: the secret is replaced by a FIXED mask', () => {
  const redactor = createRedactor([SECRET]);
  const out = redactor.redactText(`Received: "${SECRET}"`);
  assert.ok(!out.includes(SECRET), 'the secret is gone');
  assert.ok(out.includes(SECRET_MASK), 'the mask is there');
  // A mask that carries part of the secret is not a mask.
  assert.ok(!out.includes(SECRET.slice(0, 4)), 'the mask carries no part of the secret');
});

test('ATS213-R3-UT-009: the redaction works ACROSS two chunks', () => {
  // The child's stdout is a STREAM: a secret can be split across two
  // `data` chunks. A redactor that replaced chunk by chunk would miss it.
  const redactor = createRedactor([SECRET]);
  for (const split of [1, 5, 10, 11, 18, 20, 25, 30]) {
    const stream = redactor.createStreamRedactor();
    const out = stream.push(`Received: "${SECRET.slice(0, split)}`)
      + stream.push(`${SECRET.slice(split)}" done`)
      + stream.flush();
    assert.ok(!out.includes(SECRET), `the secret survives a split at ${split}`);
    assert.ok(out.includes(SECRET_MASK), `the mask is missing at a split at ${split}`);
  }
});

test('ATS213-R3-UT-010: the redaction works across THREE chunks', () => {
  const redactor = createRedactor([SECRET]);
  const stream = redactor.createStreamRedactor();
  const out = stream.push(`a${SECRET.slice(0, 8)}`)
    + stream.push(SECRET.slice(8, 16))
    + stream.push(`${SECRET.slice(16)}z`)
    + stream.flush();
  assert.ok(!out.includes(SECRET), 'the secret survives a three-way split');
  assert.ok(out.includes('a') && out.includes('z'), 'the text around the secret survives');
});

test('ATS213-R3-UT-011: the boundary never lets a secret straddle it', () => {
  // The rule behind the streaming redaction: no occurrence may STRADDLE
  // the boundary, and no incomplete occurrence may start before it.
  //
  // A complete secret that lies wholly BEFORE the boundary is fine -- the
  // emitted part is redacted afterwards. What must never happen is a
  // secret that is SPLIT across the boundary: its first half would be
  // emitted (and written to disk) while its second half is retained.
  const text = `before ${SECRET} after`;
  const boundary = safePrefixLength(text, [SECRET]);
  const emitted = text.slice(0, boundary);
  const tail = text.slice(boundary);
  const emittedHas = emitted.includes(SECRET);
  const tailHas = tail.includes(SECRET);
  // The secret is wholly on one side, or not present at all.
  assert.ok(!(emittedHas && tailHas), 'the secret must not straddle the boundary');
  assert.ok(emitted.includes(SECRET) || !emitted.includes(SECRET.slice(0, 8)),
    'no PART of the secret may be emitted');
  assert.ok(!tail.includes(SECRET.slice(0, 8)),
    'the retained tail must not hold the beginning of a secret');
  // A partial secret at the end is retained whole.
  const partial = `keep ${SECRET.slice(0, 6)}`;
  assert.equal(safePrefixLength(partial, [SECRET]), 'keep '.length,
    'an incomplete occurrence is retained from its start');
});

test('ATS213-R3-UT-012: a JSON-escaped secret is redacted too', () => {
  // A secret that contains a quote is written differently into a JSON
  // report than it appears in the environment block.
  const raw = 'a"b';
  const redactor = createRedactor([raw]);
  const out = redactor.redactText(JSON.stringify({ k: raw }));
  assert.ok(!out.includes('a\\"b'), 'the escaped form is gone');
  assert.ok(out.includes(SECRET_MASK));
});

test('ATS213-R3-UT-013: the text files of a run folder are rewritten', () => {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, 'html'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ error: `Received: "${SECRET}"` }));
  fs.writeFileSync(path.join(dir, 'stdout.log'), `Received: "${SECRET}"`);
  fs.writeFileSync(path.join(dir, 'html', 'data.md'), `Received: "${SECRET}"`);
  const redactor = createRedactor([SECRET]);
  const result = redactRunFolder(dir, redactor);
  assert.ok(result.files.length >= 3, 'the text files were rewritten');
  for (const name of ['report.json', 'stdout.log', 'html/data.md']) {
    const content = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(!content.includes(SECRET), `${name} still holds the secret`);
  }
});

test('ATS213-R3-UT-014: the embedded ZIP of the HTML report is rebuilt', () => {
  // The HTML report embeds its data as a base64 ZIP. A byte scan of the
  // HTML file cannot see inside it -- so the platform has to decode it,
  // redact the members and encode it again.
  const members = [
    { name: 'report.json', method: 8, data: Buffer.from(`{"error":"${SECRET}"}`, 'utf8') },
    { name: 'clean.txt', method: 8, data: Buffer.from('nothing to see here', 'utf8') },
  ];
  const zip = writeZipMembers(members);
  const html = Buffer.from(`<html><template id="playwrightReportBase64">data:application/zip;base64,${zip.toString('base64')}</template></html>`, 'latin1');
  const redactor = createRedactor([SECRET]);
  const { html: out, redacted } = redactEmbeddedArchives(html, redactor);
  assert.ok(redacted, 'the embedded archive was rewritten');
  // The HTML no longer holds the secret in ANY form.
  assert.ok(!out.toString('latin1').includes(SECRET));
  assert.ok(!out.toString('latin1').includes(zip.toString('base64')), 'the old payload is gone');
  // And the archive still opens, with its members intact.
  const payload = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/.exec(out.toString('latin1'))[1];
  const rebuilt = readZipMembers(Buffer.from(payload, 'base64'));
  assert.equal(rebuilt.length, 2, 'the archive still has both members');
  const report = rebuilt.find((m) => m.name === 'report.json');
  assert.ok(!report.data.toString('utf8').includes(SECRET), 'the member is redacted');
  const clean = rebuilt.find((m) => m.name === 'clean.txt');
  assert.equal(clean.data.toString('utf8'), 'nothing to see here', 'the clean member is untouched');
});

test('ATS213-R3-UT-015: the ZIP files of a run folder are rewritten', () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  const zip = writeZipMembers([
    { name: 'attachments/ctx.md', method: 8, data: Buffer.from(`Received: "${SECRET}"`, 'utf8') },
  ]);
  fs.writeFileSync(path.join(dir, 'trace.zip'), zip);
  const redactor = createRedactor([SECRET]);
  const result = redactRunArchives(dir, redactor);
  assert.ok(result.files.includes('trace.zip'), 'the archive was rewritten');
  const members = readZipMembers(fs.readFileSync(path.join(dir, 'trace.zip')));
  assert.ok(!members[0].data.toString('utf8').includes(SECRET), 'the member is redacted');
});

test('ATS213-R3-UT-016: a BINARY member is left alone and reported', () => {
  // The trace is binary: the platform cannot rewrite it without corrupting
  // it. That is a BOUNDARY, and it has to be visible rather than silent.
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  const binary = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]);
  const zip = writeZipMembers([{ name: 'test.trace', method: 8, data: binary }]);
  fs.writeFileSync(path.join(dir, 'trace.zip'), zip);
  const redactor = createRedactor([SECRET]);
  const result = redactRunArchives(dir, redactor);
  assert.ok(result.boundaries.includes('trace.zip'), 'the binary archive is reported as a boundary');
  assert.equal(result.files.length, 0, 'nothing was rewritten');
});

/* ------------------------------------------------------------------ */
/* P2 ｜ 收口点：引用只在一处解析                                        */
/* ------------------------------------------------------------------ */

/**
 * The source of a file, with the line numbers, so a test can point at the
 * exact place a rule is written.
 */
function sourceLines(relative) {
  const file = path.resolve(import.meta.dirname, '..', relative);
  return fs.readFileSync(file, 'utf8').split('\n').map((line) => line.replace(/\r$/, ''));
}

/**
 * Every line of `relative` that CALLS `callee`.
 *
 * The comment lines are excluded, and that matters: a check that only
 * looks for the NAME finds it in the prose of a comment, so a mutation
 * that removes the call still leaves the name behind and the check stays
 * green. A check that cannot see that difference proves nothing.
 */
function callSites(relative, callee) {
  return sourceLines(relative)
    .map((text, index) => ({ text: text.trim(), line: index + 1 }))
    .filter((row) => !row.text.startsWith('*')
      && !row.text.startsWith('//')
      && !row.text.startsWith('/*')
      && row.text.includes(`${callee}(`));
}

test('ATS213-R3-UT-017: a credential reference is resolved at ONE place only', () => {
  // The fail-closed rule needs a SINGLE choke point. Two implementations of
  // "resolve the references of a profile" are two places where the rules
  // can drift, and the batch is exactly the path where the second one let
  // an unresolved reference reach the environment block.
  //
  // The assertion is on the SOURCE, because the property is structural:
  // there is one call site of the resolver in the whole bridge.
  const calls = callSites('server/index.mjs', 'resolveCredentialRefs');
  assert.equal(calls.length, 1,
    `the resolver is called from ${calls.length} places: ${calls.map((c) => `server/index.mjs:${c.line}`).join(', ')}`);
  // And that one place is the choke point every run path goes through.
  const choke = sourceLines('server/index.mjs').findIndex((text) => text.includes('async function prepareRunnerEnvironment('));
  assert.ok(choke >= 0, 'the choke point exists');
  assert.ok(calls[0].line > choke,
    'the single call site is inside the choke point');
});

test('ATS213-R3-UT-018: EVERY run path goes through the choke point', () => {
  // Two run paths start a run: the single-run route and the batch chain.
  // Both of them must prepare their environment with
  // `prepareRunnerEnvironment()` -- the batch included.
  //
  // The batch is checked by NAME because the batch's own helper
  // (`batchRunEnv`) delegates to the choke point rather than implementing
  // the rules a second time.
  const source = sourceLines('server/index.mjs');
  const calls = callSites('server/index.mjs', 'prepareRunnerEnvironment');

  const batchHelper = source.findIndex((text) => text.includes('async function batchRunEnv('));
  assert.ok(batchHelper >= 0, 'the batch helper exists');
  assert.ok(calls.some((row) => row.line > batchHelper && row.line < batchHelper + 40),
    'the batch helper CALLS the choke point');

  // The single-run route calls the choke point directly.
  const route = source.findIndex((text) => text.includes('let envResolved;'));
  assert.ok(route >= 0, 'the single-run route exists');
  assert.ok(calls.some((row) => row.line > route && row.line < route + 12),
    'the single-run route CALLS the choke point');
});

test('ATS213-R3-UT-019: the run NEVER falls back to the profile\'s own variables', () => {
  // The fail-open branch was `envVariables ?? envProfile?.variables`: a
  // caller that had no resolved values got the profile's RAW variables --
  // references and all -- and a reference is an object, so `String()` of it
  // is `"[object Object]"`.
  //
  // The property is that the fallback is GONE: the environment block is
  // built from the resolved values and nothing else.
  const startRun = sourceLines('server/index.mjs')
    .findIndex((text) => text.includes('function startRun('));
  assert.ok(startRun >= 0, 'startRun exists');
  const body = sourceLines('server/index.mjs').slice(startRun, startRun + 60).join('\n');
  assert.ok(!/envVariables\s*\?\?\s*envProfile/.test(body),
    'startRun() must not fall back to the profile\'s own variables');
  assert.ok(!/envProfile\?\.variables/.test(body),
    'startRun() must not read the profile\'s variables at all');
});
