/**
 * ATS-402 unit tests: the credential store and the egress consent.
 *
 * The credential store tests run against a FAKE backend by default (so they
 * are deterministic and never touch the real OS credential store). The tests
 * that must talk to the real Windows Credential Manager are guarded by an
 * environment flag and are reported as SKIPPED when it is not set -- a skip
 * is not a pass, and the summary says so.
 *
 * The egress consent tests need no backend at all: the consent store is pure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  CREDENTIAL_STORE_CONTRACT_VERSION,
  CREDENTIAL_ERROR_CODES,
  createCredentialStore,
  credentialIndexPath,
  describeCredentialStore,
  fingerprintOf,
  loadCredentialIndex,
  saveCredentialIndex,
} from '../server/security/credentials.mjs';

import {
  EGRESS_CONSENT_CONTRACT_VERSION,
  EGRESS_ERROR_CODES,
  createEgressConsentStore,
  describeEgressConsent,
  describeEgressScope,
  scopeDigestOf,
} from '../server/security/egress-consent.mjs';

import {
  EGRESS_AUDIT_CAP,
  EGRESS_AUDIT_CONTRACT_VERSION,
  createEgressAuditStore,
  describeEgressAudit,
} from '../server/security/egress-audit.mjs';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats402-'));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake backend that behaves like the real one: the secret is stored
 * outside the index file and never appears in it.
 */
function fakeBackend({ available = true } = {}) {
  const vault = new Map();
  return {
    name: 'fake-credential-store',
    available: async () => available,
    write: async (id, secret) => { vault.set(id, secret); },
    read: async (id) => {
      if (!vault.has(id)) {
        const error = new Error('CREDENTIAL_NOT_FOUND');
        error.code = 'CREDENTIAL_NOT_FOUND';
        throw error;
      }
      return vault.get(id);
    },
    remove: async (id) => { vault.delete(id); },
    // for the probe: the raw vault
    vault,
  };
}

async function codeOf(fn) {
  try {
    await fn();
  } catch (error) {
    return error.code || error.message;
  }
  return null;
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/* ------------------------------------------------------------------ */
/* credential store -- unit                                             */
/* ------------------------------------------------------------------ */

test('UT-SEC-001: the credential store contract version is fixed', () => {
  assert.equal(CREDENTIAL_STORE_CONTRACT_VERSION, 'credential-store/v1');
});

test('UT-SEC-002: a credential is stored in the credential store, not on disk', async () => {
  const dir = tmpDir();
  const indexFile = path.join(dir, 'credentials.json');
  const backend = fakeBackend();
  const store = createCredentialStore({ indexFile, backend });

  const reference = await store.put({ name: 'openai-key', secret: 'sk-super-secret-value' });

  // The secret is in the backend ...
  assert.equal(backend.vault.get(reference.id), 'sk-super-secret-value');
  // ... and NOT anywhere in the index file.
  const onDisk = fs.readFileSync(indexFile, 'utf8');
  assert.ok(!onDisk.includes('sk-super-secret-value'), 'the secret must never reach the index file');
  assert.ok(!onDisk.includes('super-secret'), 'no fragment of the secret may reach the index file');
});

test('UT-SEC-003: the reference exposes a fingerprint but never the secret', async () => {
  const dir = tmpDir();
  const store = createCredentialStore({ indexFile: path.join(dir, 'credentials.json'), backend: fakeBackend() });
  const reference = await store.put({ name: 'k', secret: 'sk-1234567890' });
  assert.equal(reference.fingerprint, fingerprintOf('sk-1234567890'));
  assert.equal(reference.fingerprint.length, 8);
  assert.ok(!('secret' in reference), 'the reference must not carry a secret field');
  assert.ok(!JSON.stringify(reference).includes('1234567890'));
});

test('UT-SEC-004: the secret can be read back byte-exactly', async () => {
  const dir = tmpDir();
  const store = createCredentialStore({ indexFile: path.join(dir, 'credentials.json'), backend: fakeBackend() });
  const reference = await store.put({ name: 'k', secret: 'sk-abcdefghij' });
  assert.equal(await store.resolve(reference.id), 'sk-abcdefghij');
});

test('UT-SEC-005: an unknown credential id is CREDENTIAL_NOT_FOUND', async () => {
  const dir = tmpDir();
  const store = createCredentialStore({ indexFile: path.join(dir, 'credentials.json'), backend: fakeBackend() });
  assert.equal(await codeOf(() => store.resolve('cred_000000000000000000000000')), 'CREDENTIAL_NOT_FOUND');
  assert.equal(await codeOf(() => store.resolve('not-an-id')), 'CREDENTIAL_NOT_FOUND');
});

test('UT-SEC-006: an invalid name, secret or purpose is rejected', async () => {
  const dir = tmpDir();
  const store = createCredentialStore({ indexFile: path.join(dir, 'credentials.json'), backend: fakeBackend() });
  assert.equal(await codeOf(() => store.put({ name: '', secret: 'x' })), 'CREDENTIAL_NAME_INVALID');
  assert.equal(await codeOf(() => store.put({ name: 'a/b', secret: 'x' })), 'CREDENTIAL_NAME_INVALID');
  assert.equal(await codeOf(() => store.put({ name: 'ok', secret: '' })), 'CREDENTIAL_INVALID');
  assert.equal(await codeOf(() => store.put({ name: 'ok', secret: 'x', purpose: 'wat' })), 'CREDENTIAL_INVALID');
});

test('UT-SEC-007: a duplicate credential name is refused', async () => {
  const dir = tmpDir();
  const store = createCredentialStore({ indexFile: path.join(dir, 'credentials.json'), backend: fakeBackend() });
  await store.put({ name: 'dup', secret: 'x' });
  assert.equal(await codeOf(() => store.put({ name: 'dup', secret: 'y' })), 'CREDENTIAL_DUPLICATE');
});

test('UT-SEC-008: an unavailable credential store refuses instead of falling back', async () => {
  const dir = tmpDir();
  const indexFile = path.join(dir, 'credentials.json');
  const store = createCredentialStore({ indexFile, backend: fakeBackend({ available: false }) });
  // The refusal is the point: there is NO plaintext-file fallback.
  assert.equal(await codeOf(() => store.put({ name: 'k', secret: 'x' })), 'CREDENTIAL_STORE_UNAVAILABLE');
  assert.ok(!fs.existsSync(indexFile), 'a refused write must not leave an index behind');
});

test('UT-SEC-009: no backend at all means CREDENTIAL_STORE_UNAVAILABLE', async () => {
  const dir = tmpDir();
  const store = createCredentialStore({ indexFile: path.join(dir, 'credentials.json'), backend: null });
  // `backend: null` falls through to the platform selector; on a platform
  // without a credential store the store must refuse.
  const available = await store.available();
  if (available) {
    // This platform HAS a credential store -- the refusal path cannot be
    // exercised here, so the assertion is that it refuses when told to.
    const forced = createCredentialStore({ indexFile: path.join(dir, 'c2.json'), backend: fakeBackend({ available: false }) });
    assert.equal(await codeOf(() => forced.put({ name: 'k', secret: 'x' })), 'CREDENTIAL_STORE_UNAVAILABLE');
  } else {
    assert.equal(await codeOf(() => store.put({ name: 'k', secret: 'x' })), 'CREDENTIAL_STORE_UNAVAILABLE');
  }
});

test('UT-SEC-010: removing a credential clears both the vault and the index', async () => {
  const dir = tmpDir();
  const indexFile = path.join(dir, 'credentials.json');
  const backend = fakeBackend();
  const store = createCredentialStore({ indexFile, backend });
  const reference = await store.put({ name: 'k', secret: 'x' });
  await store.remove(reference.id);
  assert.equal(backend.vault.has(reference.id), false);
  assert.deepEqual(await store.list(), []);
  assert.equal(await codeOf(() => store.resolve(reference.id)), 'CREDENTIAL_NOT_FOUND');
});

test('UT-SEC-011: the index is written atomically and survives a reload', async () => {
  const dir = tmpDir();
  const indexFile = path.join(dir, 'credentials.json');
  const backend = fakeBackend();
  const store = createCredentialStore({ indexFile, backend });
  await store.put({ name: 'k', secret: 'x' });
  assert.ok(!fs.existsSync(`${indexFile}.tmp`), 'the temporary file must be renamed away');
  const reloaded = createCredentialStore({ indexFile, backend });
  assert.equal((await reloaded.list()).length, 1);
  assert.equal(loadCredentialIndex(indexFile).credentials.length, 1);
});

test('UT-SEC-012: a corrupted index is refused, not silently emptied', () => {
  const dir = tmpDir();
  const indexFile = path.join(dir, 'credentials.json');
  fs.writeFileSync(indexFile, '{not json', 'utf8');
  assert.throws(() => loadCredentialIndex(indexFile), (error) => error.code === 'CREDENTIAL_STORE_FAILED');
});

test('UT-SEC-013: the store description names the provider and never a secret', async () => {
  const dir = tmpDir();
  const store = createCredentialStore({ indexFile: path.join(dir, 'credentials.json'), backend: fakeBackend() });
  const described = describeCredentialStore(store);
  assert.equal(described.contract, 'credential-store/v1');
  assert.equal(described.provider, 'fake-credential-store');
  assert.deepEqual(described.errorCodes, [...CREDENTIAL_ERROR_CODES]);
  assert.ok(!JSON.stringify(described).toLowerCase().includes('sk-'));
});

test('UT-SEC-014: the credential index path lives under the data directory', () => {
  assert.equal(credentialIndexPath('/tmp/x'), path.join('/tmp/x', 'credentials.json'));
});

test('UT-SEC-015: saving and loading an index round-trips', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'credentials.json');
  saveCredentialIndex(file, { version: 'credential-store/v1', credentials: [{ id: 'cred_x', name: 'n' }] });
  const loaded = loadCredentialIndex(file);
  assert.equal(loaded.credentials[0].id, 'cred_x');
});

/* ------------------------------------------------------------------ */
/* egress consent -- unit                                              */
/* ------------------------------------------------------------------ */

function consentStore(now = () => Date.now()) {
  const records = [];
  return {
    store: createEgressConsentStore({
      list: async () => records.slice(),
      persist: async (next) => { records.length = 0; records.push(...next); },
      now,
    }),
    records,
  };
}

const fileInput = (ref = 'tests/login.spec.ts', content = 'test("x",()=>{})') => ({
  kind: 'file',
  ref,
  digest: sha256(content),
  content,
});

test('UT-EGR-001: the egress consent contract version is fixed', () => {
  assert.equal(EGRESS_CONSENT_CONTRACT_VERSION, 'egress-consent/v1');
});

test('UT-EGR-002: with no consent, egress is refused', () => {
  const { store } = consentStore();
  const verdict = store.check(null, [fileInput()]);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'EGRESS_CONSENT_REQUIRED');
});

test('UT-EGR-003: a preview describes exactly what would leave', () => {
  const { store } = consentStore();
  const preview = store.preview([fileInput()]);
  assert.equal(preview.scope.count, 1);
  assert.deepEqual(preview.scope.kinds, ['file']);
  assert.equal(preview.scope.items[0].ref, 'tests/login.spec.ts');
  assert.ok(preview.scope.totalBytes > 0);
  assert.equal(preview.scope.items[0].bytes, Buffer.byteLength('test("x",()=>{})', 'utf8'));
});

test('UT-EGR-004: a confirmation without a preview is refused', async () => {
  const { store } = consentStore();
  await assert.rejects(
    () => store.confirm({ previewId: 'egp_000000000000000000000000', inputs: [fileInput()] }),
    (error) => error.code === 'EGRESS_PREVIEW_INVALID',
  );
});

test('UT-EGR-005: a preview token is single-use', async () => {
  const { store } = consentStore();
  const preview = store.preview([fileInput()]);
  const consent = await store.confirm({ previewId: preview.previewId, inputs: [fileInput()] });
  assert.equal(consent.state, 'granted');
  await assert.rejects(
    () => store.confirm({ previewId: preview.previewId, inputs: [fileInput()] }),
    (error) => error.code === 'EGRESS_PREVIEW_INVALID',
  );
});

test('UT-EGR-006: confirming a different scope than the preview is refused', async () => {
  const { store } = consentStore();
  const preview = store.preview([fileInput('tests/a.spec.ts', 'aaa')]);
  const other = fileInput('tests/b.spec.ts', 'bbb');
  await assert.rejects(
    () => store.confirm({ previewId: preview.previewId, inputs: [other] }),
    (error) => error.code === 'EGRESS_PREVIEW_STALE',
  );
});

test('UT-EGR-007: a granted consent allows exactly the confirmed scope', async () => {
  const { store } = consentStore();
  const inputs = [fileInput()];
  const preview = store.preview(inputs);
  const consent = await store.confirm({ previewId: preview.previewId, inputs });
  const verdict = store.check(consent, inputs);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.consent.id, consent.id);
});

test('UT-EGR-008: changed content does not match the confirmed scope', async () => {
  const { store } = consentStore();
  const inputs = [fileInput('tests/a.spec.ts', 'original')];
  const preview = store.preview(inputs);
  const consent = await store.confirm({ previewId: preview.previewId, inputs });
  const changed = [fileInput('tests/a.spec.ts', 'modified')];
  const verdict = store.check(consent, changed);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'EGRESS_CONSENT_SCOPE_MISMATCH');
});

test('UT-EGR-009: an input kind outside the consent is refused', async () => {
  const { store } = consentStore();
  const inputs = [fileInput()];
  const preview = store.preview(inputs);
  const consent = await store.confirm({ previewId: preview.previewId, inputs });
  const evidence = {
    kind: 'evidence',
    ref: 'run_1_abc',
    digest: sha256('e'),
    content: 'evidence',
  };
  const verdict = store.check(consent, [inputs[0], evidence]);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'EGRESS_KIND_NOT_ALLOWED');
});

test('UT-EGR-010: an expired consent is refused', async () => {
  let clock = 1_000_000;
  const { store } = consentStore(() => clock);
  const inputs = [fileInput()];
  const preview = store.preview(inputs);
  const consent = await store.confirm({ previewId: preview.previewId, inputs, ttlSeconds: 60 });
  clock += 61_000;
  const verdict = store.check(consent, inputs);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'EGRESS_CONSENT_EXPIRED');
});

test('UT-EGR-011: a revoked consent is refused immediately', async () => {
  const { store } = consentStore();
  const inputs = [fileInput()];
  const preview = store.preview(inputs);
  const consent = await store.confirm({ previewId: preview.previewId, inputs });
  await store.revoke(consent.id);
  const record = await store.find(consent.id);
  const verdict = store.check(record, inputs);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'EGRESS_CONSENT_REVOKED');
});

test('UT-EGR-012: a malformed consent record is refused', () => {
  const { store } = consentStore();
  assert.equal(store.check({ id: 'nope' }, [fileInput()]).code, 'EGRESS_CONSENT_INVALID');
  assert.equal(store.check({ id: 'egr_000000000000000000000000', state: 'weird' }, [fileInput()]).code, 'EGRESS_CONSENT_INVALID');
});

test('UT-EGR-013: the consent record is persisted before it is handed back', async () => {
  const { store, records } = consentStore();
  const inputs = [fileInput()];
  const preview = store.preview(inputs);
  const consent = await store.confirm({ previewId: preview.previewId, inputs });
  assert.equal(records.length, 1);
  assert.equal(records[0].id, consent.id);
  assert.equal((await store.all()).length, 1);
});

test('UT-EGR-014: an invalid ttl is refused', async () => {
  const { store } = consentStore();
  const inputs = [fileInput()];
  const preview = store.preview(inputs);
  await assert.rejects(
    () => store.confirm({ previewId: preview.previewId, inputs, ttlSeconds: 0 }),
    (error) => error.code === 'EGRESS_CONSENT_INVALID',
  );
});

test('UT-EGR-015: an unknown input kind is refused', () => {
  assert.throws(
    () => describeEgressScope([{ kind: 'wat', ref: 'x', digest: 'a'.repeat(64), content: '' }]),
    (error) => error.code === 'EGRESS_KIND_NOT_ALLOWED',
  );
});

test('UT-EGR-016: a malformed digest is refused', () => {
  assert.throws(
    () => describeEgressScope([{ kind: 'file', ref: 'x', digest: 'nope', content: '' }]),
    (error) => error.code === 'EGRESS_CONSENT_INVALID',
  );
});

test('UT-EGR-017: the scope digest does not depend on the input order', () => {
  const a = fileInput('a.spec.ts', 'a');
  const b = fileInput('b.spec.ts', 'b');
  assert.equal(scopeDigestOf([a, b]), scopeDigestOf([b, a]));
  assert.notEqual(scopeDigestOf([a]), scopeDigestOf([b]));
});

test('UT-EGR-018: the consent description lists the flow and the error codes', () => {
  const described = describeEgressConsent();
  assert.equal(described.contract, 'egress-consent/v1');
  assert.deepEqual(described.errorCodes, [...EGRESS_ERROR_CODES]);
  assert.ok(described.flow.includes('preview'));
});

/* ------------------------------------------------------------------ */
/* egress audit -- unit                                                */
/* ------------------------------------------------------------------ */

/**
 * An in-memory audit store. The records are kept in an array so the test can
 * assert on what was actually persisted, not only on what was returned.
 */
function auditStore(now = () => Date.now()) {
  const records = [];
  return {
    store: createEgressAuditStore({
      list: async () => records.slice(),
      persist: async (next) => { records.length = 0; records.push(...next); },
      now,
    }),
    records,
  };
}

test('UT-AUD-001: the egress audit contract version is fixed', () => {
  assert.equal(EGRESS_AUDIT_CONTRACT_VERSION, 'egress-audit/v1');
});

test('UT-AUD-002: a denied egress leaves a record', async () => {
  const { store, records } = auditStore();
  const entry = await store.record({
    event: 'egress.denied',
    outcome: 'denied',
    code: 'EGRESS_CONSENT_REQUIRED',
    reason: 'no egress consent record',
    projectId: 'prj_1',
    kinds: ['file'],
  });
  assert.equal(entry.event, 'egress.denied');
  assert.equal(entry.outcome, 'denied');
  assert.equal(entry.code, 'EGRESS_CONSENT_REQUIRED');
  // The record is ON DISK before it is handed back: a record that only exists
  // in the return value is not an audit trail.
  assert.equal(records.length, 1);
  assert.equal(records[0].id, entry.id);
});

test('UT-AUD-003: a granted egress leaves a record too', async () => {
  const { store, records } = auditStore();
  await store.record({
    event: 'egress.granted',
    outcome: 'allowed',
    consentId: 'egr_000000000000000000000000',
    projectId: 'prj_1',
    kinds: ['file'],
    items: [{ kind: 'file', ref: 'tests/a.spec.ts', digest: sha256('a'), bytes: 1 }],
    scopeDigest: sha256('scope'),
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].event, 'egress.granted');
  assert.equal(records[0].outcome, 'allowed');
});

test('UT-AUD-004: an audit record never carries the content', async () => {
  const { store, records } = auditStore();
  const secretContent = 'test("the secret is here",()=>{})';
  const entry = await store.record({
    event: 'egress.granted',
    outcome: 'allowed',
    kinds: ['file'],
    items: [{
      kind: 'file',
      ref: 'tests/a.spec.ts',
      digest: sha256(secretContent),
      bytes: Buffer.byteLength(secretContent, 'utf8'),
      content: secretContent,
      preview: secretContent,
    }],
  });
  // The content is dropped AT THE BOUNDARY: neither the returned record nor
  // the persisted one may hold it.
  const serialised = JSON.stringify(entry) + JSON.stringify(records);
  assert.ok(!serialised.includes('the secret is here'));
  assert.ok(!('content' in entry.items[0]));
  assert.ok(!('preview' in entry.items[0]));
  // The digest is kept -- it is what lets the trail name the content.
  assert.equal(entry.items[0].digest, sha256(secretContent));
});

test('UT-AUD-005: an unknown audit event is refused', async () => {
  const { store } = auditStore();
  await assert.rejects(
    () => store.record({ event: 'egress.maybe', outcome: 'allowed' }),
    (error) => error.code === 'EGRESS_AUDIT_EVENT_INVALID',
  );
});

test('UT-AUD-006: the trail is append-only -- revoking does not erase the past', async () => {
  const { store, records } = auditStore();
  await store.record({ event: 'egress.granted', outcome: 'allowed', consentId: 'egr_1' });
  await store.record({ event: 'consent.revoked', outcome: 'denied', consentId: 'egr_1' });
  // Both facts survive: the trail records what HAPPENED, not what is true now.
  assert.equal(records.length, 2);
  const events = records.map((r) => r.event);
  assert.ok(events.includes('egress.granted'));
  assert.ok(events.includes('consent.revoked'));
});

test('UT-AUD-007: the trail has a cap and drops the oldest records', async () => {
  const { store, records } = auditStore();
  for (let i = 0; i < EGRESS_AUDIT_CAP + 5; i += 1) {
    await store.record({ event: 'egress.granted', outcome: 'allowed', projectId: `prj_${i}` });
  }
  assert.equal(records.length, EGRESS_AUDIT_CAP);
  // The OLDEST are dropped, so the recent history survives.
  assert.equal(records[0].projectId, 'prj_5');
  assert.equal(records[records.length - 1].projectId, `prj_${EGRESS_AUDIT_CAP + 4}`);
});

test('UT-AUD-008: the audit description lists the events and never a secret', () => {
  const described = describeEgressAudit();
  assert.equal(described.contract, 'egress-audit/v1');
  assert.ok(described.events.includes('egress.denied'));
  assert.ok(described.events.includes('egress.granted'));
  assert.equal(described.cap, EGRESS_AUDIT_CAP);
});
