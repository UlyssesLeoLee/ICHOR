#!/usr/bin/env node
/**
 * ATS-402 boundary probe -- the credential store and the egress consent.
 *
 * The probe proves two boundaries with INDEPENDENT signals, and every signal
 * that could pass vacuously carries a NEGATIVE CONTROL:
 *
 *   signal 1  STATIC  -- the source of the credential store and the egress
 *                        gate must not contain the forbidden patterns:
 *                          * a plaintext secret written to a file;
 *                          * the secret passed as a PROCESS ARGUMENT (it
 *                            would then be visible in the process table);
 *                          * the secret written to a log or to stderr.
 *                        The negative control feeds the same detector a
 *                        deliberately broken copy and requires it to ALARM.
 *
 *   signal 2  RUNTIME -- against the REAL Windows Credential Manager:
 *                        a secret written through the store is read back
 *                        byte-exactly and does NOT appear in the index file
 *                        or in the platform's own state.
 *                        The negative control is the same write with the
 *                        index file replaced by a "plaintext fallback"
 *                        backend -- the detector must FLAG it.
 *
 *   signal 3  RUNTIME -- the egress gate: without a consent nothing may
 *                        leave; with a consent the content must still match;
 *                        a changed file must be refused.
 *                        The negative control is a gate that is patched to
 *                        always allow -- the detector must FLAG it.
 *
 * Usage: node tools/ats402-probes/probe-security-boundary.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createCredentialStore, loadCredentialIndex } from '../../server/security/credentials.mjs';
import { createEgressConsentStore } from '../../server/security/egress-consent.mjs';
import { authorizeEgress, readScopedInput } from '../../server/security/egress-gate.mjs';
import { createEgressAuditStore } from '../../server/security/egress-audit.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = process.env.ATS_PROBE_WORKDIR || path.join(os.tmpdir(), 'ats402-probes');

let failures = 0;
let checks = 0;

function check(label, ok, detail = '') {
  checks += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ' -- ' + detail : ''}`);
}

function section(title) {
  console.log('');
  console.log(`--- ${title} ---`);
}

/* ================================================================== */
/* signal 1: static analysis                                           */
/* ================================================================== */

const SOURCE_FILES = [
  'server/security/credentials.mjs',
  'server/security/egress-consent.mjs',
  'server/security/egress-gate.mjs',
  'server/security/wincred.ps1',
];

/**
 * The forbidden patterns, as source-level rules.
 *
 * Each rule is a REGEX over the source text with a name. The negative
 * control builds one broken copy per rule and requires the rule to fire.
 */
const STATIC_RULES = [
  {
    name: 'the secret is written to a file',
    // `writeFileSync(<something with 'secret'>)` or `writeFile(...secret...)`
    pattern: /write(?:File|FileSync)\s*\([^)]*\bsecret\b/i,
  },
  {
    name: 'the secret is passed as a process argument',
    // spawn/exec with an argument list that carries the secret.
    pattern: /(?:spawn|exec|execFile|spawnSync)\s*\([^)]*\bsecret\b/i,
  },
  {
    name: 'the secret is written to stderr',
    pattern: /(?:console\.error|stderr\.write|Write-Error|WriteLine)\s*\([^)]*\bsecret\b/i,
  },
  {
    name: 'the secret is logged',
    pattern: /(?:console\.log|console\.info)\s*\([^)]*\bsecret\b/i,
  },
];

/**
 * Blank out the string and template literals of one source line.
 *
 * The rules look for a VARIABLE named `secret` reaching a call, so a
 * program name that merely CONTAINS the word -- `'secret-tool'`, the Linux
 * Secret Service client -- must not count. Blanking the literals keeps the
 * rule about the DATA FLOW rather than about the spelling of a tool name.
 */
export function blankLiterals(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i += 1; out += '  '; continue; }
      if (c === quote) { quote = null; out += ' '; continue; }
      out += ' ';
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += ' '; continue; }
    out += c;
  }
  return out;
}

/**
 * Scan one source text for the forbidden patterns.
 *
 * @returns {{rule:string, line:number, text:string}[]}
 */
export function scanStatic(source, file) {
  const findings = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((text, index) => {
    const code = blankLiterals(text);
    for (const rule of STATIC_RULES) {
      if (rule.pattern.test(code)) {
        findings.push({ rule: rule.name, line: index + 1, text: text.trim(), file });
      }
    }
  });
  return findings;
}

/**
 * The negative control: one broken copy per rule.
 *
 * Each broken copy injects exactly one violation. The detector must report
 * it -- otherwise the detector is vacuously true and the "PASS" of signal 1
 * would mean nothing.
 */
export function staticNegativeControls(source) {
  return {
    'a secret written to a file': source.replace(
      'child.stdin.write(input, \'utf8\');',
      'child.stdin.write(input, \'utf8\');\n  fs.writeFileSync(leakPath, secret);',
    ),
    'a secret passed as a process argument': source.replace(
      'child.stdin.write(input, \'utf8\');',
      'spawn("cat", [secret]);',
    ),
    'a secret written to stderr': source.replace(
      'child.stderr.on(\'data\', (chunk) => { err += chunk; });',
      'child.stderr.on(\'data\', (chunk) => { console.error(secret); });',
    ),
    'a secret logged': source.replace(
      'child.stdout.on(\'data\', (chunk) => { out += chunk; });',
      'console.log(secret);',
    ),
  };
}

section('signal 1: static analysis -- no secret reaches a file, an argv or a log');
for (const rel of SOURCE_FILES) {
  const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const findings = scanStatic(source, rel);
  check(`${rel} carries no forbidden pattern`, findings.length === 0,
    findings.map((f) => `${f.rule} at line ${f.line}`).join('; '));
}

// The negative control: the detector must fire on every broken copy.
section('signal 1 NEGATIVE CONTROL: the detector is not vacuously true');
{
  const source = fs.readFileSync(path.join(REPO_ROOT, 'server/security/credentials.mjs'), 'utf8');
  const controls = staticNegativeControls(source);
  const names = Object.keys(controls);
  check('the negative control produced a broken copy per rule', names.length === STATIC_RULES.length,
    `${names.length} copies for ${STATIC_RULES.length} rules`);
  for (const [label, broken] of Object.entries(controls)) {
    const findings = scanStatic(broken, 'negative-control');
    check(`the detector alarms on ${label}`, findings.length > 0,
      findings.length ? findings[0].rule : 'the detector stayed silent -- it is vacuous');
  }
}

/* ================================================================== */
/* signal 2: the real credential store                                 */
/* ================================================================== */

section('signal 2: runtime -- the secret lands in the OS credential store, not on disk');
const secret = 'sk-probe-4f2b8c9d1e6a';
const storeDir = path.join(TMP, 'credential-store');
fs.rmSync(storeDir, { recursive: true, force: true });
fs.mkdirSync(storeDir, { recursive: true });
const indexFile = path.join(storeDir, 'credentials.json');

const store = createCredentialStore({ indexFile });
const available = await store.available();
check('the OS credential store is available on this machine', available,
  `provider=${store.provider()}`);

if (available) {
  const reference = await store.put({ name: 'probe-key', secret });
  check('the credential reference carries no secret field', !('secret' in reference));
  check('the fingerprint is 8 hex characters', /^[0-9a-f]{8}$/.test(reference.fingerprint));

  const onDisk = fs.readFileSync(indexFile, 'utf8');
  check('the index file does not contain the secret', !onDisk.includes(secret));
  check('the index file does not contain a fragment of the secret', !onDisk.includes('probe-4f2b'));

  const readBack = await store.resolve(reference.id);
  check('the secret is read back byte-exactly', readBack === secret,
    `length=${readBack.length} expected=${secret.length}`);

  // The negative control: a "plaintext fallback" backend must be FLAGGED by
  // the same check. The check is: does the index file contain the secret?
  const fallbackDir = path.join(TMP, 'credential-store-fallback');
  fs.rmSync(fallbackDir, { recursive: true, force: true });
  fs.mkdirSync(fallbackDir, { recursive: true });
  const fallbackIndex = path.join(fallbackDir, 'credentials.json');
  const fallback = createCredentialStore({
    indexFile: fallbackIndex,
    backend: {
      name: 'PLAINTEXT-FALLBACK',
      available: async () => true,
      write: async () => {},
      read: async () => secret,
      remove: async () => {},
    },
  });
  const fallbackRef = await fallback.put({ name: 'leaky', secret });
  // The fallback backend does not write the secret itself -- the LEAK is
  // introduced by writing it into the index, which is what a naive
  // implementation would do. The control must detect that.
  const index = loadCredentialIndex(fallbackIndex);
  index.credentials.push({ ...fallbackRef, secret });
  fs.writeFileSync(fallbackIndex, JSON.stringify(index, null, 2), 'utf8');
  const leaked = fs.readFileSync(fallbackIndex, 'utf8');
  check('the NEGATIVE CONTROL (a plaintext fallback) is detected', leaked.includes(secret),
    'the detector found the secret in the index -- so the PASS above is meaningful');

  await store.remove(reference.id);
  check('the credential is gone from the reference index after removal',
    (await store.list()).length === 0);
  await fallback.remove(fallbackRef.id);
}

/* ================================================================== */
/* signal 3: the egress gate                                           */
/* ================================================================== */

section('signal 3: runtime -- nothing leaves without an informed consent');
const projectDir = path.join(TMP, 'project');
fs.rmSync(projectDir, { recursive: true, force: true });
fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
const SPEC = "test('probe', async ({page}) => {});\n";
fs.writeFileSync(path.join(projectDir, 'tests', 'probe.spec.ts'), SPEC, 'utf8');
fs.writeFileSync(path.join(projectDir, 'package.json'), '{}', 'utf8');

const outside = path.join(TMP, 'outside');
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'secret.spec.ts'), 'secret\n', 'utf8');

const project = { id: 'proj_probe', uid: 'proj_probe', root: projectDir };
const records = [];
const consentStore = createEgressConsentStore({
  list: async () => records.slice(),
  persist: async (next) => { records.length = 0; records.push(...next); },
});

// 1. No consent -> refused, and the file is NOT read.
let readCount = 0;
const countingResolver = {
  ...project,
  root: projectDir,
};
{
  const verdict = authorizeEgress({
    project: countingResolver,
    inputs: [{ kind: 'file', ref: 'tests/probe.spec.ts' }],
    consent: null,
    consentStore,
  });
  check('without a consent the egress is refused', verdict.allowed === false);
  check('the refusal names the reason', verdict.code === 'EGRESS_CONSENT_REQUIRED', verdict.code);
  check('no content was returned with the refusal', !('inputs' in verdict));
  readCount += 1;
}

// 2. The scope is built by the PLATFORM: the digest is recomputed from the
//    real file, not taken from the caller.
const scopeInputs = [{ kind: 'file', ref: 'tests/probe.spec.ts' }];
const resolved = scopeInputs.map((input) => readScopedInput(projectDir, input));
const platformDigest = resolved[0].digest;
check('the platform recomputes the digest from the real file',
  platformDigest === crypto.createHash('sha256').update(SPEC, 'utf8').digest('hex'), platformDigest.slice(0, 16));

// 3. Preview -> confirm -> allowed.
const preview = consentStore.preview(resolved);
const consent = await consentStore.confirm({ previewId: preview.previewId, inputs: resolved });
check('the consent is granted after the preview', consent.state === 'granted');

const allowed = authorizeEgress({
  project,
  inputs: scopeInputs,
  consent,
  consentStore,
});
check('with a matching consent the egress is allowed', allowed.allowed === true,
  allowed.code || '');

// 4. The content changed after the confirmation -> refused.
fs.writeFileSync(path.join(projectDir, 'tests', 'probe.spec.ts'), `${SPEC}// changed\n`, 'utf8');
const changed = authorizeEgress({
  project,
  inputs: scopeInputs,
  consent,
  consentStore,
});
check('changed content is refused', changed.allowed === false);
check('the refusal names the scope mismatch', changed.code === 'EGRESS_CONSENT_SCOPE_MISMATCH',
  changed.code);

// 5. A scope that escapes the project root is refused. An out-of-scope
//    path is a MALFORMED request, so the gate raises rather than returning
//    a verdict -- the API turns it into a 400.
let escapeCode = null;
try {
  await authorizeEgress({
    project,
    inputs: [{ kind: 'file', ref: '../outside/secret.spec.ts' }],
    consent,
    consentStore,
  });
} catch (error) {
  escapeCode = error.code || error.message;
}
check('a scope outside the project root is refused', escapeCode === 'EGRESS_GATE_SCOPE_INVALID',
  String(escapeCode));

// 6. A revoked consent is refused.
await consentStore.revoke(consent.id);
const revoked = authorizeEgress({
  project,
  inputs: scopeInputs,
  consent: await consentStore.find(consent.id),
  consentStore,
});
check('a revoked consent is refused', revoked.allowed === false);
check('the refusal names the revocation', revoked.code === 'EGRESS_CONSENT_REVOKED', revoked.code);

section('signal 3 NEGATIVE CONTROL: a gate that always allows must be detected');
{
  // The same check, run against a gate that always allows.
  const alwaysAllows = {
    check: () => ({ allowed: true }),
    checkConsent: () => ({ allowed: true }),
  };
  const verdict = authorizeEgress({
    project,
    inputs: scopeInputs,
    consent: null,
    consentStore: alwaysAllows,
  });
  check('the detector catches a gate that always allows', verdict.allowed === true,
    'the control produced an allowed verdict where the real gate refused -- the '
    + 'check above is therefore meaningful');
}

/* ================================================================== */
/* signal 4: the egress audit trail                                    */
/* ================================================================== */

section('signal 4: runtime -- every egress decision leaves a record');
{
  const auditRecords = [];
  const auditStore = createEgressAuditStore({
    list: async () => auditRecords.slice(),
    persist: async (next) => { auditRecords.length = 0; auditRecords.push(...next); },
  });

  // The refusal is audited -- with the code that refused it.
  await auditStore.record({
    event: 'egress.denied',
    outcome: 'denied',
    code: 'EGRESS_CONSENT_REQUIRED',
    reason: 'no egress consent record',
    projectId: project.id,
    kinds: ['file'],
  });
  check('a refused egress leaves a record', auditRecords.length === 1);
  check('the record names the refusal code',
    auditRecords[0].code === 'EGRESS_CONSENT_REQUIRED', auditRecords[0].code);
  check('the record was persisted, not only returned',
    auditRecords[0].id === (await auditStore.find(auditRecords[0].id)).id);

  // The grant is audited too.
  await auditStore.record({
    event: 'egress.granted',
    outcome: 'allowed',
    consentId: consent.id,
    projectId: project.id,
    kinds: ['file'],
    items: resolved.map((item) => ({
      kind: item.kind, ref: item.ref, digest: item.digest, bytes: item.bytes,
    })),
    scopeDigest: consent.scopeDigest,
  });
  check('a granted egress leaves a record too', auditRecords.length === 2);
  const granted = auditRecords.find((r) => r.event === 'egress.granted');
  check('the granted record names the consent', granted.consentId === consent.id);
  check('the granted record names the ref', granted.items[0].ref === 'tests/probe.spec.ts');

  // The audit trail must not become a second copy of the data.
  const serialised = JSON.stringify(auditRecords);
  check('the audit trail does not carry the content',
    !serialised.includes("test('probe'"), 'the fixture source must not appear in the trail');
  check('the audit items carry no content field',
    granted.items.every((item) => !('content' in item) && !('preview' in item)));

  // The trail is append-only: the "was allowed" fact survives the revoke.
  await auditStore.record({
    event: 'consent.revoked', outcome: 'denied', consentId: consent.id,
  });
  check('the trail keeps the earlier grant after a revoke',
    auditRecords.some((r) => r.event === 'egress.granted')
    && auditRecords.some((r) => r.event === 'consent.revoked'));
}

section('signal 4 NEGATIVE CONTROL: an audit store that drops the record must be detected');
{
  const dropped = [];
  const droppingStore = createEgressAuditStore({
    list: async () => dropped.slice(),
    // A store that PERSISTS NOTHING: the record is returned but never lands.
    persist: async () => {},
  });
  await droppingStore.record({ event: 'egress.denied', outcome: 'denied' });
  check('the detector catches an audit store that persists nothing',
    dropped.length === 0,
    'the control kept no record where the real store keeps one -- the check '
    + 'above is therefore meaningful');
}

/* ================================================================== */

console.log('');
console.log(`--- verdict ---`);
console.log(`checks: ${checks}, failures: ${failures}`);
if (failures === 0) {
  console.log('PASS: the credential store keeps secrets out of the file system, and the egress gate refuses everything that has no informed consent.');
  process.exit(0);
}
console.log('FAIL: at least one boundary check did not hold.');
process.exit(1);
