/**
 * ATS-402 egress gate, audit trail and consent listing -- in-process tests.
 *
 * The gate resolves scopes against real temp directories (including a real
 * directory junction/symlink) so path-escape handling is exercised, not mocked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  authorizeEgress,
  buildEgressScope,
  resolveEgressInputs,
  readScopedInput,
  describeRequestedRefs,
  isSubpath,
  EGRESS_GATE_ERROR_CODES,
  REQUIREMENT_DIR,
} from '../server/security/egress-gate.mjs';
import { createEgressConsentStore, describeEgressScope } from '../server/security/egress-consent.mjs';
import {
  createEgressAuditStore,
  EGRESS_AUDIT_CAP,
  EGRESS_AUDIT_CAPS,
} from '../server/security/egress-audit.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-gate-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const root = path.join(base, 'proj');
const outside = path.join(base, 'outside');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(path.join(root, REQUIREMENT_DIR), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'alpha');
fs.writeFileSync(path.join(root, REQUIREMENT_DIR, 'requirements.json'), '{"r":1}');
fs.writeFileSync(path.join(root, REQUIREMENT_DIR, 'other.json'), '{"r":2}');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE');
fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(1_000_001));
fs.mkdirSync(path.join(root, 'adir'));
let junction = true;
try {
  fs.symlinkSync(outside, path.join(root, 'jn'), 'junction');
  fs.symlinkSync(outside, path.join(root, REQUIREMENT_DIR, 'jn'), 'junction');
} catch { junction = false; }

const project = { id: 'proj_x', root };
const runResolver = (ref) => {
  if (ref === 'run_missing') return null;
  if (ref === 'run_throws') throw new Error('RUN_NOT_FOUND');
  const content = JSON.stringify({ runId: ref });
  return { kind: 'run', ref, digest: 'a'.repeat(64), content };
};
const codeOf = (fn) => { try { fn(); } catch (error) { return error.code; } return null; };

function memStore(now = () => Date.now()) {
  let records = [];
  return createEgressConsentStore({ list: async () => records, persist: async (r) => { records = r; }, now });
}
async function grantFor(store, inputs, ttlSeconds) {
  const scope = describeEgressScope(inputs);
  const preview = store.preview(inputs);
  void scope;
  return store.confirm({ previewId: preview.previewId, inputs, ttlSeconds });
}

/* ---------------------------- resolver ----------------------------- */

test('UT-GATE-001: file, requirement and run resolve through ONE resolver', () => {
  const resolved = resolveEgressInputs({
    project,
    inputs: [{ kind: 'file', ref: 'src/a.txt' }, { kind: 'requirement' }, { kind: 'requirement', ref: 'other.json' }, { kind: 'run', ref: 'run_1' }],
    runResolver,
  });
  assert.deepEqual(resolved.map((r) => [r.kind, r.ref]), [['file', 'src/a.txt'], ['requirement', 'requirements.json'], ['requirement', 'other.json'], ['run', 'run_1']]);
  assert.equal(resolved[0].bytes, 5);
  assert.equal(resolved[3].bytes, Buffer.byteLength(JSON.stringify({ runId: 'run_1' })));
  const scope = buildEgressScope({ project, inputs: [{ kind: 'requirement', ref: '' }], runResolver });
  assert.equal(scope.items[0].ref, 'requirements.json');
  assert.equal(scope.count, 1);
});

test('UT-GATE-002: escapes are SCOPE_INVALID: ../, absolute, drive letter, out of .aitest', () => {
  for (const ref of ['../outside/secret.txt', '/etc/passwd', 'C:/Windows/win.ini', 'src/../../outside/secret.txt']) {
    assert.equal(codeOf(() => readScopedInput(root, { kind: 'file', ref })), 'EGRESS_GATE_SCOPE_INVALID', ref);
  }
  assert.equal(codeOf(() => resolveEgressInputs({ project, inputs: [{ kind: 'requirement', ref: '../src/a.txt' }] })), 'EGRESS_GATE_SCOPE_INVALID');
  assert.equal(codeOf(() => resolveEgressInputs({ project, inputs: [{ kind: 'requirement', ref: '/abs.json' }] })), 'EGRESS_GATE_SCOPE_INVALID');
});

test('UT-GATE-003: a junction/symlink to outside the project is SCOPE_INVALID for file AND requirement', { skip: !junction && 'junction not creatable' }, () => {
  assert.equal(codeOf(() => readScopedInput(root, { kind: 'file', ref: 'jn/secret.txt' })), 'EGRESS_GATE_SCOPE_INVALID');
  assert.equal(codeOf(() => resolveEgressInputs({ project, inputs: [{ kind: 'requirement', ref: 'jn/secret.txt' }] })), 'EGRESS_GATE_SCOPE_INVALID');
});

test('UT-GATE-004: malformed inputs are INPUT_INVALID / PROJECT_UNKNOWN', () => {
  const run = (inputs, p = project, r = runResolver) => codeOf(() => resolveEgressInputs({ project: p, inputs, runResolver: r }));
  assert.equal(run([]), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run('nope'), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run([null]), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run([{ kind: 'file' }]), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run([{ kind: 'file', ref: 'nope.txt' }]), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run([{ kind: 'file', ref: 'adir' }]), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run([{ kind: 'file', ref: 'big.txt' }]), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run([{ kind: 'requirement', ref: 5 }]), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run([{ kind: 'requirement', ref: 'missing.json' }]), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run([{ kind: 'run', ref: 'run_missing' }]), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run([{ kind: 'run', ref: 'run_throws' }]), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run([{ kind: 'run', ref: '../x' }]), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run([{ kind: 'run', ref: 'run_1' }], project, null), 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(run([{ kind: 'file', ref: 'src/a.txt' }], null), 'EGRESS_GATE_PROJECT_UNKNOWN');
  assert.equal(run([{ kind: 'file', ref: 'src/a.txt' }], { id: 'x', root: '' }), 'EGRESS_GATE_PROJECT_UNKNOWN');
  assert.equal(codeOf(() => readScopedInput(root, { kind: 'file', ref: 'src/a.txt' }, path.join(root, 'no-such-base'))), 'EGRESS_GATE_INPUT_INVALID');
  for (const code of ['EGRESS_GATE_INPUT_INVALID', 'EGRESS_GATE_SCOPE_INVALID', 'EGRESS_GATE_PROJECT_UNKNOWN']) {
    assert.ok(EGRESS_GATE_ERROR_CODES.includes(code));
  }
});

test('UT-GATE-005: isSubpath and describeRequestedRefs', () => {
  assert.equal(isSubpath('/a', '/a/b'), true);
  assert.equal(isSubpath('/a', '/a'), false);
  assert.equal(isSubpath('/a', '/b'), false);
  assert.deepEqual(describeRequestedRefs('x'), []);
  const refs = describeRequestedRefs([{ kind: 'file', ref: '../x' }, null, { kind: 5, ref: 5 }]);
  assert.deepEqual(refs, [
    { kind: 'file', ref: '../x', digest: null, bytes: 0 },
    { kind: 'unknown', ref: '', digest: null, bytes: 0 },
    { kind: 'unknown', ref: '', digest: null, bytes: 0 },
  ]);
  assert.equal(describeRequestedRefs(Array.from({ length: 80 }, () => ({ kind: 'file', ref: 'a' }))).length, 50);
});

/* ---------------------------- authorizeEgress ---------------------------- */

test('UT-GATE-006: no consent -> refused before any file is read', async () => {
  const store = memStore();
  const verdict = authorizeEgress({ project, inputs: [{ kind: 'file', ref: '../outside/secret.txt' }], consent: null, consentStore: store });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'EGRESS_CONSENT_REQUIRED');
  assert.equal(verdict.scope, undefined, 'no scope was built: no file was read');
});

test('UT-GATE-007: a valid consent allows exactly the confirmed scope (file + requirement + run)', async () => {
  const store = memStore();
  const inputs = resolveEgressInputs({ project, inputs: [{ kind: 'file', ref: 'src/a.txt' }, { kind: 'requirement' }, { kind: 'run', ref: 'run_1' }], runResolver });
  const consent = await grantFor(store, inputs);
  const verdict = authorizeEgress({
    project, inputs: [{ kind: 'file', ref: 'src/a.txt' }, { kind: 'requirement' }, { kind: 'run', ref: 'run_1' }], consent, consentStore: store, runResolver,
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.scope.count, 3);
  assert.equal(verdict.inputs.length, 3);
});

test('UT-GATE-008: with a VALID consent, scope failures are refusals (not throws) carrying a code', async () => {
  const store = memStore();
  const good = resolveEgressInputs({ project, inputs: [{ kind: 'file', ref: 'src/a.txt' }] });
  const consent = await grantFor(store, good);
  const verdictOf = (inputs, extra = {}) => authorizeEgress({ project, inputs, consent, consentStore: store, ...extra });
  assert.equal(verdictOf([{ kind: 'file', ref: '../outside/secret.txt' }]).code, 'EGRESS_GATE_SCOPE_INVALID');
  assert.equal(verdictOf([{ kind: 'file', ref: 'src/a.txt' }, { kind: 'file', ref: '../outside/secret.txt' }]).code, 'EGRESS_GATE_SCOPE_INVALID');
  assert.equal(verdictOf([{ kind: 'file', ref: 'nope.txt' }]).code, 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(verdictOf([]).code, 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(verdictOf([{ kind: 'run', ref: 'run_1' }]).code, 'EGRESS_KIND_NOT_ALLOWED');
  assert.equal(authorizeEgress({ project: null, inputs: [{ kind: 'file', ref: 'src/a.txt' }], consent, consentStore: store }).code, 'EGRESS_GATE_PROJECT_UNKNOWN');
  for (const v of [verdictOf([{ kind: 'file', ref: '../outside/secret.txt' }])]) assert.equal(v.allowed, false);
});

test('UT-GATE-009: changed content no longer matches the confirmed scope', async () => {
  const store = memStore();
  fs.writeFileSync(path.join(root, 'src', 'm.txt'), 'v1');
  const inputs = [{ kind: 'file', ref: 'src/m.txt' }];
  const consent = await grantFor(store, resolveEgressInputs({ project, inputs }));
  fs.writeFileSync(path.join(root, 'src', 'm.txt'), 'v2');
  assert.equal(authorizeEgress({ project, inputs, consent, consentStore: store }).code, 'EGRESS_CONSENT_SCOPE_MISMATCH');
});

test('UT-GATE-010: a consent store without check() is a programming error; one without checkConsent() still works', async () => {
  assert.throws(() => authorizeEgress({ project, inputs: [], consentStore: {} }), TypeError);
  assert.throws(() => authorizeEgress({}), TypeError);
  const store = memStore();
  const consent = await grantFor(store, resolveEgressInputs({ project, inputs: [{ kind: 'file', ref: 'src/a.txt' }] }));
  const minimal = { check: store.check };
  const verdict = authorizeEgress({ project, inputs: [{ kind: 'file', ref: 'src/a.txt' }], consent, consentStore: minimal });
  assert.equal(verdict.allowed, true);
});

/* ------------------------- consent listing state ------------------------- */

test('UT-CON-001: the listing reflects expiry as `expired`; find() keeps the raw record', async () => {
  let clock = Date.now();
  const store = memStore(() => clock);
  const consent = await grantFor(store, resolveEgressInputs({ project, inputs: [{ kind: 'file', ref: 'src/a.txt' }] }), 60);
  assert.equal((await store.all())[0].state, 'granted');
  clock += 61_000;
  assert.equal((await store.all())[0].state, 'expired');
  assert.equal((await store.find(consent.id)).state, 'granted', 'the stored record is untouched');
  assert.equal(store.checkConsent(await store.find(consent.id), ['file']).code, 'EGRESS_CONSENT_EXPIRED');
  const revoked = await store.revoke(consent.id);
  assert.equal(revoked.state, 'revoked');
  assert.equal((await store.all())[0].state, 'revoked');
});

test('UT-CON-002: the scope digest separates fields (no kind/ref/digest concatenation ambiguity)', () => {
  const d = (kind, ref, digest) => describeEgressScope([{ kind, ref, digest, content: '' }]).scopeDigest;
  const a = 'a'.repeat(64);
  assert.notEqual(d('file', 'x y', a), d('file', 'x', a));
  assert.equal(describeEgressScope([{ kind: 'file', ref: 'x', digest: a, content: '' }]).scopeDigest.length, 64);
});

/* ------------------------------ audit caps ------------------------------ */

function memAudit() {
  let records = [];
  const store = createEgressAuditStore({ list: async () => records, persist: async (r) => { records = r; }, now: () => 1_700_000_000_000 });
  return { store, raw: () => records };
}

test('UT-AUD-009: a flood of denials never evicts a granted / consent record', async () => {
  const { store, raw } = memAudit();
  const granted = await store.record({ event: 'egress.granted', outcome: 'allowed', items: [{ kind: 'file', ref: 'a', digest: 'b'.repeat(64), bytes: 1 }] });
  const consent = await store.record({ event: 'consent.granted' });
  const revoked = await store.record({ event: 'consent.revoked', outcome: 'denied' });
  for (let i = 0; i < EGRESS_AUDIT_CAPS.denied + 25; i += 1) {
    await store.record({ event: 'egress.denied', code: 'EGRESS_CONSENT_REQUIRED', items: [{ kind: 'file', ref: `r${i}`, digest: null }] });
  }
  const ids = new Set(raw().map((r) => r.id));
  assert.ok(ids.has(granted.id) && ids.has(consent.id) && ids.has(revoked.id), 'decision records survive the flood');
  assert.equal(raw().filter((r) => r.event === 'egress.denied').length, EGRESS_AUDIT_CAPS.denied);
  const refs = raw().filter((r) => r.event === 'egress.denied').map((r) => r.items[0].ref);
  assert.ok(!refs.includes('r0') && refs.includes(`r${EGRESS_AUDIT_CAPS.denied + 24}`), 'the OLDEST denials are the ones dropped');
});

test('UT-AUD-010: the decision class has its own cap and drops its own oldest', async () => {
  const { store, raw } = memAudit();
  for (let i = 0; i < EGRESS_AUDIT_CAPS.decisions + 3; i += 1) await store.record({ event: 'egress.granted', outcome: 'allowed', consentId: `c${i}` });
  const decisions = raw().filter((r) => r.event !== 'egress.denied');
  assert.equal(decisions.length, EGRESS_AUDIT_CAPS.decisions);
  assert.equal(decisions[0].consentId, 'c3');
  assert.equal(EGRESS_AUDIT_CAP, 500);
});

test('UT-AUD-011: a refusal item with no digest is recorded as digest:null and bytes:0', async () => {
  const { store } = memAudit();
  const rec = await store.record({ event: 'egress.denied', items: [{ kind: 'file', ref: '../x' }] });
  assert.deepEqual(rec.items, [{ kind: 'file', ref: '../x', digest: null, bytes: 0 }]);
  const all = await store.all();
  assert.equal(all[0].items[0].digest, null);
  assert.equal((await store.find(rec.id)).id, rec.id);
  assert.equal(await store.find('eag_none'), null);
  assert.equal(await store.count(), 1);
});
