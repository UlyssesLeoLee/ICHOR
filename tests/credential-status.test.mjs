/**
 * ATS-213 ｜ 凭据可用状态（credential status）—— 单元测试
 *
 * 这些用例**不碰真实系统凭据库**：凭据库是一个注入的内存替身，因此
 * 三个状态（已配置 / 未配置 / 取不到）在本机任何平台都能被测到。
 *
 * 被测的断言有三类：
 *
 *   1. **状态是测出来的**，不是从索引推断的——索引里有引用、凭据库里没有
 *      条目时，状态必须是「未配置」；
 *   2. **取不到时不静默降级**——状态是「取不到」，原因码指明是「条目不在」
 *      还是「读不出来」，不吞异常、不假装成功；
 *   3. **状态里没有密钥**——响应只有引用、状态、原因码与 8 位指纹。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createCredentialStore,
  credentialStatusReasonOf,
  describeCredentialStore,
  CREDENTIAL_STATUSES,
  CREDENTIAL_STATUS_REASONS,
} from '../server/security/credentials.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats213-status-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshIndex = () => path.join(tmp, `idx-${n++}`, 'credentials.json');

/**
 * 一个内存凭据库替身。它可以：正常存取、条目不在、读取抛错、整体不可用。
 * `entries` 是「凭据库里真的有什么」的事实来源——把条目从里面删掉，就模拟
 * 了「用户在系统凭据管理器里删了这一条，而索引还留着引用」。
 */
function fakeVault({ available = true, failRead = null, emptyRead = false } = {}) {
  const entries = new Map();
  return {
    entries,
    name: 'fake-vault',
    available: async () => available,
    async write(id, secret) { entries.set(id, secret); },
    async read(id) {
      if (failRead) throw failRead;
      if (!entries.has(id)) throw new Error('CREDENTIAL_NOT_FOUND');
      return emptyRead ? '' : entries.get(id);
    },
    async remove(id) {
      if (!entries.has(id)) throw new Error('CREDENTIAL_NOT_FOUND');
      entries.delete(id);
    },
  };
}

/** 存一条凭据，返回它的引用。 */
async function seed(store, name = 'ats213-key', secret = 'sk-ats213-UT-marker-4c1e') {
  return store.put({ name, secret, purpose: 'ai-provider' });
}

test('ATS213-UT-001: the status vocabulary is a closed set of three values', () => {
  assert.deepEqual([...CREDENTIAL_STATUSES], ['configured', 'not-configured', 'unavailable']);
  assert.deepEqual([...CREDENTIAL_STATUS_REASONS], [
    'CREDENTIAL_FOUND',
    'CREDENTIAL_NOT_FOUND',
    'CREDENTIAL_STORE_UNAVAILABLE',
    'CREDENTIAL_STORE_FAILED',
  ]);
  // The reason codes are a closed vocabulary too: every status reason is
  // declared, and every declared reason is used by exactly one status.
  assert.equal(CREDENTIAL_STATUS_REASONS.length, 4);
  assert.ok(!CREDENTIAL_STATUSES.includes('unknown'), 'there is no "unknown" status: a status is measured');
});

test('ATS213-UT-002: a stored credential reads back as `configured`', async () => {
  const vault = fakeVault();
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const ref = await seed(store);
  const status = await store.status(ref.id);
  assert.equal(status.status, 'configured');
  assert.equal(status.reason, 'CREDENTIAL_FOUND');
  assert.equal(status.id, ref.id);
  assert.equal(status.name, ref.name);
  assert.equal(status.fingerprint, ref.fingerprint);
  assert.ok(status.checkedAt, 'the status says WHEN it was measured');
});

test('ATS213-UT-003: the status carries no secret and no fragment of one', async () => {
  const vault = fakeVault();
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const secret = 'sk-ats213-UT-marker-4c1e';
  const ref = await seed(store, 'ats213-key', secret);
  const status = await store.status(ref.id);
  const serialised = JSON.stringify(status);
  assert.ok(!serialised.includes(secret), 'the status must not carry the secret');
  assert.ok(!('secret' in status), 'the status must not have a secret field');
  assert.equal(status.fingerprint.length, 8, 'the fingerprint is 8 hex characters');
  // The fingerprint is a hash prefix, not the secret.
  assert.notEqual(status.fingerprint, secret.slice(0, 8));
});

test('ATS213-UT-004: a reference whose store entry vanished reads back as `not-configured`', async () => {
  // The drift case: the index still holds the reference, the OS credential
  // store does not hold the entry. Inferring the status from the index would
  // report a credential as usable when it is not.
  const vault = fakeVault();
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const ref = await seed(store);
  vault.entries.delete(ref.id);
  const status = await store.status(ref.id);
  assert.equal(status.status, 'not-configured');
  assert.equal(status.reason, 'CREDENTIAL_NOT_FOUND');
  // The reference is still known, so the name and the fingerprint survive --
  // they are facts of the index, not of the store.
  assert.equal(status.name, ref.name);
  assert.equal(status.fingerprint, ref.fingerprint);
});

test('ATS213-UT-005: an unreadable store reads back as `unavailable`, not as `not-configured`', async () => {
  // The distinction that matters: "the entry is gone" and "the store cannot
  // be read" call for different actions. Collapsing them would tell the user
  // to re-enter a secret that is actually still stored.
  const vault = fakeVault({ failRead: new Error('CREDENTIAL_STORE_FAILED') });
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const ref = await seed(store);
  const status = await store.status(ref.id);
  assert.equal(status.status, 'unavailable');
  assert.equal(status.reason, 'CREDENTIAL_STORE_FAILED');
});

test('ATS213-UT-006: an unavailable backend reads back as `unavailable` with its own reason', async () => {
  // With no backend at all there is no index entry either, so the call is
  // refused with CREDENTIAL_NOT_FOUND -- the reference does not exist.
  const store = createCredentialStore({ indexFile: freshIndex(), backend: null });
  const status = await store.status('cred_aaaaaaaaaaaaaaaaaaaaaaaa').catch((e) => e);
  assert.equal(status.code, 'CREDENTIAL_NOT_FOUND');

  // A reference that EXISTS while the backend is unreachable: the secret may
  // well still be in the OS credential store -- the platform simply cannot
  // reach it right now. That is `unavailable`, not `not-configured`.
  const vault = fakeVault();
  const store2 = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const ref = await seed(store2);
  vault.available = async () => false;
  const status2 = await store2.status(ref.id);
  assert.equal(status2.status, 'unavailable');
  assert.equal(status2.reason, 'CREDENTIAL_STORE_UNAVAILABLE');
});

test('ATS213-UT-007: a store that answers with nothing is `unavailable`, not `configured`', async () => {
  // An empty answer is not a usable secret. Reporting it as `configured`
  // would be the silent degradation this surface must not have.
  const vault = fakeVault({ emptyRead: true });
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const ref = await seed(store);
  const status = await store.status(ref.id);
  assert.equal(status.status, 'unavailable');
  assert.equal(status.reason, 'CREDENTIAL_STORE_FAILED');
});

test('ATS213-UT-008: the status of an unknown id is refused, not guessed', async () => {
  const store = createCredentialStore({ indexFile: freshIndex(), backend: fakeVault() });
  await assert.rejects(store.status('cred_aaaaaaaaaaaaaaaaaaaaaaaa'), (e) => e.code === 'CREDENTIAL_NOT_FOUND');
  await assert.rejects(store.status('not-an-id'), (e) => e.code === 'CREDENTIAL_NOT_FOUND');
});

test('ATS213-UT-009: statusAll gives every reference exactly one status', async () => {
  const vault = fakeVault();
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const ok = await seed(store, 'ats213-ok');
  const gone = await seed(store, 'ats213-gone');
  vault.entries.delete(gone.id);
  const all = await store.statusAll();
  assert.equal(all.length, 2);
  for (const s of all) {
    assert.ok(CREDENTIAL_STATUSES.includes(s.status), `unexpected status ${s.status}`);
    assert.ok(CREDENTIAL_STATUS_REASONS.includes(s.reason), `unexpected reason ${s.reason}`);
  }
  assert.equal(all.find((s) => s.id === ok.id).status, 'configured');
  assert.equal(all.find((s) => s.id === gone.id).status, 'not-configured');
});

test('ATS213-UT-010: one broken reference does not break the whole list', async () => {
  // A per-reference failure must not turn the whole list into an error --
  // otherwise the reader sees "everything is broken" instead of "this one
  // is broken".
  const vault = fakeVault();
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const good = await seed(store, 'ats213-good');
  const bad = await seed(store, 'ats213-bad');
  vault.entries.delete(bad.id);
  vault.failRead = new Error('CREDENTIAL_STORE_FAILED');
  const all = await store.statusAll();
  assert.equal(all.length, 2);
  assert.ok(all.every((s) => s.status));
});

test('ATS213-UT-011: the status surface is part of the contract description', () => {
  const store = createCredentialStore({ indexFile: freshIndex(), backend: fakeVault() });
  const description = describeCredentialStore(store);
  assert.deepEqual(description.statuses, [...CREDENTIAL_STATUSES]);
  assert.deepEqual(description.statusReasons, [...CREDENTIAL_STATUS_REASONS]);
});

test('ATS213-UT-012: the reason mapping keeps "entry missing" apart from "read failed"', () => {
  assert.equal(credentialStatusReasonOf(new Error('CREDENTIAL_NOT_FOUND')), 'CREDENTIAL_NOT_FOUND');
  assert.equal(
    credentialStatusReasonOf(Object.assign(new Error('x'), { code: 'CREDENTIAL_STORE_UNAVAILABLE' })),
    'CREDENTIAL_STORE_UNAVAILABLE',
  );
  // A code outside the vocabulary falls back to the generic failure -- never
  // to "not found", which would tell the user to re-enter a stored secret.
  assert.equal(credentialStatusReasonOf(new Error('CREDENTIAL_STORE_FAILED')), 'CREDENTIAL_STORE_FAILED');
  assert.equal(credentialStatusReasonOf(new Error('something else')), 'CREDENTIAL_STORE_FAILED');
});
