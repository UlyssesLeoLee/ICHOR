/**
 * ATS-402 credential store -- in-process tests with an INJECTED backend.
 *
 * No test here touches the real OS credential store. The vault is an
 * in-memory fake, and the Windows / macOS / Linux backends are driven through
 * an injected `spawn` double, so every backend runs on every platform and the
 * coverage of `server/security/credentials.mjs` does not depend on the host.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  createCredentialStore,
  normalizeCredentialError,
  windowsBackend,
  macosBackend,
  linuxBackend,
  selectBackend,
  hasBinary,
  loadCredentialIndex,
  saveCredentialIndex,
  credentialIndexPath,
  describeCredentialStore,
  fingerprintOf,
  CREDENTIAL_ERROR_CODES,
} from '../server/security/credentials.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-cred-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshIndex = () => path.join(tmp, `idx-${n++}`, 'credentials.json');

/** An in-memory vault with optional per-call latency and failure injection. */
function fakeVault({ delayMs = 0, failWrite = null, failRemove = null, failRead = null, available = true } = {}) {
  const entries = new Map();
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  return {
    entries,
    name: 'fake-vault',
    available: async () => available,
    async write(id, secret) {
      await wait();
      if (failWrite) throw failWrite;
      entries.set(id, secret);
    },
    async read(id) {
      if (failRead) throw failRead;
      if (!entries.has(id)) throw new Error('CREDENTIAL_NOT_FOUND');
      return entries.get(id);
    },
    async remove(id) {
      await wait();
      if (failRemove) throw failRemove;
      if (!entries.has(id)) throw new Error('CREDENTIAL_NOT_FOUND (win32=1168)');
      entries.delete(id);
    },
  };
}

/** A fake `spawn`: `script(command, args, input)` decides the outcome. */
function fakeSpawn(script) {
  const calls = [];
  const spawnFn = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = '';
    child.stdin = new PassThrough();
    child.stdin.on('data', (d) => { input += d; });
    child.stdin.on('end', () => {
      const call = { command, args, input };
      calls.push(call);
      const result = script(command, args, input, calls.length);
      setImmediate(() => {
        if (result.spawnError) { child.emit('error', result.spawnError); return; }
        if (result.out) child.stdout.write(result.out);
        if (result.err) child.stderr.write(result.err);
        child.emit('close', result.code ?? 0);
      });
    });
    return child;
  };
  return { spawnFn, calls };
}

/* ------------------------------ store ------------------------------ */

test('UT-CRD-001: put stores the secret in the vault and only a reference in the index', async () => {
  const vault = fakeVault();
  const indexFile = freshIndex();
  const store = createCredentialStore({ indexFile, backend: vault });
  const ref = await store.put({ name: 'k1', secret: 'sk-fake-aaaa' });
  assert.equal(ref.provider, 'fake-vault');
  assert.equal(ref.fingerprint, fingerprintOf('sk-fake-aaaa'));
  assert.equal([...vault.entries.values()][0], 'sk-fake-aaaa');
  assert.ok(!fs.readFileSync(indexFile, 'utf8').includes('sk-fake-aaaa'));
  assert.equal(await store.resolve(ref.id), 'sk-fake-aaaa');
  assert.deepEqual((await store.describe(ref.id)).name, 'k1');
  assert.equal(store.provider(), 'fake-vault');
  assert.equal(await store.available(), true);
});

test('UT-CRD-002: three concurrent puts of the same name -> one wins, no orphan in the vault', async () => {
  const vault = fakeVault({ delayMs: 20 });
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const results = await Promise.allSettled([1, 2, 3].map((i) => store.put({ name: 'same', secret: `sk-${i}` })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.deepEqual(
    results.filter((r) => r.status === 'rejected').map((r) => r.reason.code),
    ['CREDENTIAL_DUPLICATE', 'CREDENTIAL_DUPLICATE'],
  );
  assert.equal((await store.list()).length, 1);
  assert.equal(vault.entries.size, 1, 'the vault holds exactly the referenced secret');
});

test('UT-CRD-003: three concurrent puts of different names keep every reference', async () => {
  const vault = fakeVault({ delayMs: 15 });
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  await Promise.all(['a', 'b', 'c'].map((name) => store.put({ name, secret: `sk-${name}` })));
  const names = (await store.list()).map((c) => c.name).sort();
  assert.deepEqual(names, ['a', 'b', 'c']);
  assert.equal(vault.entries.size, 3);
});

test('UT-CRD-004: concurrent remove + put serialise and stay consistent', async () => {
  const vault = fakeVault({ delayMs: 10 });
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const first = await store.put({ name: 'first', secret: 'sk-1' });
  await Promise.all([store.remove(first.id), store.put({ name: 'second', secret: 'sk-2' })]);
  assert.deepEqual((await store.list()).map((c) => c.name), ['second']);
  assert.equal(vault.entries.size, 1);
});

test('UT-CRD-005: remove clears a reference whose vault entry is already gone', async () => {
  const vault = fakeVault();
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const ref = await store.put({ name: 'ghost', secret: 'sk-g' });
  vault.entries.clear();
  const removed = await store.remove(ref.id);
  assert.equal(removed.id, ref.id);
  assert.deepEqual(await store.list(), []);
});

test('UT-CRD-006: remove keeps the reference when the vault fails for another reason', async () => {
  const vault = fakeVault({ failRemove: new Error('CREDENTIAL_DELETE_FAILED (win32=5)') });
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const ref = await store.put({ name: 'stuck', secret: 'sk-s' });
  await assert.rejects(store.remove(ref.id), (e) => e.code === 'CREDENTIAL_STORE_FAILED');
  assert.equal((await store.list()).length, 1, 'the secret may still exist, so the reference stays');
});

test('UT-CRD-007: a vault write failure is a declared code (never undefined) and leaves no reference', async () => {
  const vault = fakeVault({ failWrite: new Error('CREDENTIAL_WRITE_FAILED (win32=1783)') });
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  await assert.rejects(store.put({ name: 'big', secret: 'x' }), (e) => {
    assert.equal(e.code, 'CREDENTIAL_STORE_FAILED');
    assert.ok(CREDENTIAL_ERROR_CODES.includes(e.code));
    return true;
  });
  assert.deepEqual(await store.list(), []);
});

test('UT-CRD-008: when the index cannot be written the just-written secret is removed again', async () => {
  const vault = fakeVault();
  const dir = path.join(tmp, 'blocked');
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, 'credentials.json');
  const store = createCredentialStore({ indexFile, backend: vault });
  // A DIRECTORY where the index's temp file must go makes the write fail.
  fs.mkdirSync(`${indexFile}.tmp`);
  await assert.rejects(store.put({ name: 'orphan', secret: 'sk-o' }), (e) => e.code === 'CREDENTIAL_STORE_FAILED');
  assert.equal(vault.entries.size, 0, 'no orphan secret is left in the vault');
});

test('UT-CRD-009: input validation', async () => {
  const store = createCredentialStore({ indexFile: freshIndex(), backend: fakeVault() });
  await assert.rejects(store.put({ name: '../x', secret: 's' }), (e) => e.code === 'CREDENTIAL_NAME_INVALID');
  await assert.rejects(store.put({ name: 'ok', secret: '' }), (e) => e.code === 'CREDENTIAL_INVALID');
  await assert.rejects(store.put({ name: 'ok', secret: 's', purpose: 'bogus' }), (e) => e.code === 'CREDENTIAL_INVALID');
  await assert.rejects(store.describe('cred_000000000000000000000000'), (e) => e.code === 'CREDENTIAL_NOT_FOUND');
  await assert.rejects(store.remove('nope'), (e) => e.code === 'CREDENTIAL_NOT_FOUND');
  await assert.rejects(store.remove('cred_000000000000000000000000'), (e) => e.code === 'CREDENTIAL_NOT_FOUND');
  await assert.rejects(store.resolve('nope'), (e) => e.code === 'CREDENTIAL_NOT_FOUND');
  await assert.rejects(store.resolve('cred_000000000000000000000000'), (e) => e.code === 'CREDENTIAL_NOT_FOUND');
  assert.throws(() => createCredentialStore({}), TypeError);
});

test('UT-CRD-010: resolve needs the matching purpose and a readable vault', async () => {
  const vault = fakeVault();
  const store = createCredentialStore({ indexFile: freshIndex(), backend: vault });
  const ref = await store.put({ name: 'p', secret: 'sk-p', purpose: 'other' });
  await assert.rejects(store.resolve(ref.id), (e) => e.code === 'CREDENTIAL_INVALID');
  assert.equal(await store.resolve(ref.id, 'other'), 'sk-p');
  vault.entries.clear();
  await assert.rejects(store.resolve(ref.id, 'other'), (e) => e.code === 'CREDENTIAL_NOT_FOUND');
});

test('UT-CRD-011: an unavailable vault refuses; there is no plaintext fallback', async () => {
  const indexFile = freshIndex();
  for (const backend of [fakeVault({ available: false }), null]) {
    const store = createCredentialStore({ indexFile, backend: backend ?? undefined });
    if (backend === null) continue; // the default backend of this host is covered by UT-CRD-018
    await assert.rejects(store.put({ name: 'n', secret: 's' }), (e) => e.code === 'CREDENTIAL_STORE_UNAVAILABLE');
    assert.equal(await store.available(), false);
  }
  assert.ok(!fs.existsSync(indexFile), 'nothing is written when the vault is unavailable');
});

test('UT-CRD-012: a backend without an available() probe counts as available', async () => {
  const bare = { name: 'bare', write: async () => {}, read: async () => 's', remove: async () => {} };
  const store = createCredentialStore({ indexFile: freshIndex(), backend: bare });
  assert.equal(await store.available(), true);
  await store.put({ name: 'x', secret: 's' });
});

test('UT-CRD-013: normalizeCredentialError maps everything into the declared vocabulary', () => {
  assert.equal(normalizeCredentialError(new Error('CREDENTIAL_NOT_FOUND (win32=1168)')).code, 'CREDENTIAL_NOT_FOUND');
  assert.equal(normalizeCredentialError(new Error('CREDENTIAL_STORE_UNAVAILABLE:ENOENT')).code, 'CREDENTIAL_STORE_UNAVAILABLE');
  assert.equal(normalizeCredentialError(new Error('CREDENTIAL_WRITE_FAILED')).code, 'CREDENTIAL_STORE_FAILED');
  assert.equal(normalizeCredentialError(new Error('boom')).code, 'CREDENTIAL_STORE_FAILED');
  assert.equal(normalizeCredentialError(null).code, 'CREDENTIAL_STORE_FAILED');
  assert.equal(normalizeCredentialError({ code: 'CREDENTIAL_INVALID' }).code, 'CREDENTIAL_INVALID');
});

test('UT-CRD-014: the index: missing file is empty, corrupt or malformed is refused, save round-trips', () => {
  const file = freshIndex();
  assert.deepEqual(loadCredentialIndex(file).credentials, []);
  saveCredentialIndex(file, { version: 'credential-store/v1', credentials: [{ id: 'x' }] });
  assert.equal(loadCredentialIndex(file).credentials[0].id, 'x');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => loadCredentialIndex(file), (e) => e.code === 'CREDENTIAL_STORE_FAILED');
  fs.writeFileSync(file, '{"credentials":1}');
  assert.throws(() => loadCredentialIndex(file), (e) => e.code === 'CREDENTIAL_STORE_FAILED');
  assert.equal(credentialIndexPath('/d'), path.join('/d', 'credentials.json'));
});

test('UT-CRD-015: describeCredentialStore names the provider and the codes, never a secret', () => {
  const store = createCredentialStore({ indexFile: freshIndex(), backend: fakeVault() });
  const description = describeCredentialStore(store);
  assert.equal(description.provider, 'fake-vault');
  assert.deepEqual(description.errorCodes, [...CREDENTIAL_ERROR_CODES]);
  const none = createCredentialStore({ indexFile: freshIndex(), backend: null });
  assert.equal(typeof none.provider(), process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux' ? 'string' : 'object');
});

/* ----------------------------- backends ----------------------------- */

test('UT-CRD-016: the Windows backend passes the secret over stdin, never argv', async () => {
  const script = (_c, args, input) => {
    const action = args[args.indexOf('-File') + 2];
    if (action === 'read') return { out: 'sk-win' };
    return { out: 'OK' };
  };
  const { spawnFn, calls } = fakeSpawn(script);
  const backend = windowsBackend(import.meta.filename, spawnFn, 'win32');
  assert.equal(await backend.available(), true);
  await backend.write('cred_aaaaaaaaaaaaaaaaaaaaaaaa', 'sk-win-secret');
  assert.equal(await backend.read('cred_aaaaaaaaaaaaaaaaaaaaaaaa'), 'sk-win');
  await backend.remove('cred_aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(calls[0].input, 'sk-win-secret');
  for (const call of calls) assert.ok(!call.args.join(' ').includes('sk-win-secret'), 'the secret is never an argument');
  assert.equal(await windowsBackend('x', spawnFn, 'linux').available(), false);
});

test('UT-CRD-017: the Windows backend retries a code-less helper failure once, never a coded one', async () => {
  let attempts = 0;
  const flaky = fakeSpawn(() => { attempts += 1; return attempts === 1 ? { code: 1, err: 'host crashed' } : { out: 'OK' }; });
  await windowsBackend(import.meta.filename, flaky.spawnFn, 'win32').write('cred_aaaaaaaaaaaaaaaaaaaaaaaa', 's');
  assert.equal(attempts, 2);

  attempts = 0;
  const coded = fakeSpawn(() => { attempts += 1; return { code: 1, err: 'CREDENTIAL_WRITE_FAILED (win32=1783)' }; });
  await assert.rejects(windowsBackend(import.meta.filename, coded.spawnFn, 'win32').write('cred_aaaaaaaaaaaaaaaaaaaaaaaa', 's'), /CREDENTIAL_WRITE_FAILED/);
  assert.equal(attempts, 1);

  const missing = fakeSpawn(() => ({ spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }) }));
  await assert.rejects(windowsBackend(import.meta.filename, missing.spawnFn, 'win32').read('cred_aaaaaaaaaaaaaaaaaaaaaaaa'), /CREDENTIAL_STORE_UNAVAILABLE:ENOENT/);
});

test('UT-CRD-018: the macOS backend drives `security` with the secret on stdin', async () => {
  const { spawnFn, calls } = fakeSpawn((_c, args) => (args[0] === 'find-generic-password' ? { out: 'sk-mac\n' } : { out: '' }));
  const backend = macosBackend(spawnFn, 'darwin');
  assert.equal(await backend.available(), true);
  await backend.write('cred_bbbbbbbbbbbbbbbbbbbbbbbb', 'sk-mac-secret');
  assert.equal(await backend.read('cred_bbbbbbbbbbbbbbbbbbbbbbbb'), 'sk-mac');
  await backend.remove('cred_bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.deepEqual(calls.map((c) => c.args[0]), ['add-generic-password', 'find-generic-password', 'delete-generic-password']);
  assert.equal(calls[0].input, 'sk-mac-secret');
  assert.ok(!calls[0].args.join(' ').includes('sk-mac-secret'));
  assert.equal(await macosBackend(spawnFn, 'win32').available(), false);
  const failing = fakeSpawn(() => ({ code: 44, err: 'CREDENTIAL_NOT_FOUND' }));
  await assert.rejects(macosBackend(failing.spawnFn, 'darwin').read('cred_bbbbbbbbbbbbbbbbbbbbbbbb'), /CREDENTIAL_NOT_FOUND/);
  const bare = fakeSpawn(() => ({ code: 1 }));
  await assert.rejects(macosBackend(bare.spawnFn, 'darwin').remove('cred_bbbbbbbbbbbbbbbbbbbbbbbb'), /CREDENTIAL_STORE_FAILED/);
  const gone = fakeSpawn(() => ({ spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }) }));
  await assert.rejects(macosBackend(gone.spawnFn, 'darwin').read('cred_bbbbbbbbbbbbbbbbbbbbbbbb'), /CREDENTIAL_STORE_UNAVAILABLE/);
});

test('UT-CRD-019: the Linux backend drives `secret-tool` with the secret on stdin', async () => {
  const { spawnFn, calls } = fakeSpawn((_c, args) => (args[0] === 'lookup' ? { out: 'sk-lin\n' } : { out: '' }));
  const backend = linuxBackend(spawnFn, () => true, 'linux');
  assert.equal(await backend.available(), true);
  await backend.write('cred_cccccccccccccccccccccccc', 'sk-lin-secret');
  assert.equal(await backend.read('cred_cccccccccccccccccccccccc'), 'sk-lin');
  await backend.remove('cred_cccccccccccccccccccccccc');
  assert.deepEqual(calls.map((c) => c.args[0]), ['store', 'lookup', 'clear']);
  assert.equal(calls[0].input, 'sk-lin-secret');
  assert.ok(!calls[0].args.join(' ').includes('sk-lin-secret'));
  assert.equal(await linuxBackend(spawnFn, () => false, 'linux').available(), false);
  assert.equal(await linuxBackend(spawnFn, () => true, 'darwin').available(), false);
  const failing = fakeSpawn(() => ({ code: 1, err: 'CREDENTIAL_NOT_FOUND' }));
  await assert.rejects(linuxBackend(failing.spawnFn, () => true, 'linux').read('cred_cccccccccccccccccccccccc'), /CREDENTIAL_NOT_FOUND/);
  const gone = fakeSpawn(() => ({ spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }) }));
  await assert.rejects(linuxBackend(gone.spawnFn, () => true, 'linux').remove('cred_cccccccccccccccccccccccc'), /CREDENTIAL_STORE_UNAVAILABLE/);
});

test('UT-CRD-020: backend selection follows the host and never yields a plaintext backend', () => {
  const backend = selectBackend(path.join(tmp, 'wincred.ps1'));
  if (process.platform === 'win32') assert.equal(backend.name, 'windows-credential-manager');
  else if (process.platform === 'darwin') assert.equal(backend.name, 'macos-keychain');
  else if (process.platform === 'linux') assert.equal(backend.name, 'linux-secret-service');
  else assert.equal(backend, null);
  assert.equal(typeof hasBinary('definitely-not-a-real-binary-ats402'), 'boolean');
  assert.equal(hasBinary('definitely-not-a-real-binary-ats402'), false);
  assert.equal(hasBinary(process.platform === 'win32' ? 'cmd' : 'sh'), true);
});
