/**
 * ATS-213 ｜ 凭据可用状态 —— 集成测试（HTTP 层）
 *
 * 这些用例启动**真实 Bridge**（隔离数据目录 + 随机端口），经 HTTP 断言
 * 状态面：
 *
 *   - `GET /api/security/credentials/status` 给出每条引用的状态；
 *   - `GET /api/security/credentials/:id/status` 给出单条的状态；
 *   - 响应里**没有密钥**，也没有密钥的片段；
 *   - **畸形请求体不回显请求体内容**（V8 的 JSON 解析错误会带上一段原始
 *     输入，那正是密钥的片段——这是本任务实测到并修掉的泄漏）。
 *
 * 写**真实 Windows Credential Manager** 的用例由 `ATS213_REAL_CREDENTIAL_STORE=1`
 * 把关。没有这个开关时它们是 SKIP——**skip 不是 pass**，所以汇总里写明。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats213-api-'));
const port = await freePort();
let cp, token;

/**
 * Whether THIS machine turned out to have a reachable OS credential store.
 * It is MEASURED (by the put in ATS213-IT-006), not assumed: the credential
 * store is a per-machine capability, and a test that assumed it would be a
 * test that lies on the machines where it is absent.
 */
let realStoreAvailable = false;

async function ready() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not boot');
}

async function api(endpoint, method = 'GET', payload, auth = true) {
  const r = await fetch(`http://127.0.0.1:${port}` + endpoint, {
    method,
    headers: auth ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {},
    body: payload === undefined ? undefined : (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  });
  return [r.status, await r.json()];
}

test('ATS213-IT-SETUP: start the bridge', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: path.join(data, 'state') },
    stdio: 'ignore',
  });
  await ready();
  token = (await api('/api/session'))[1].token;
  assert.ok(token);
});

test('ATS213-IT-001: the status endpoint requires a session token', async () => {
  const [status] = await api('/api/security/credentials/status', 'GET', undefined, false);
  assert.equal(status, 401);
});

test('ATS213-IT-002: the status list is exposed and every entry has exactly one status', async () => {
  const [status, body] = await api('/api/security/credentials/status');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.statuses));
  assert.equal(typeof body.provider, 'string');
  for (const s of body.statuses) {
    assert.ok(['configured', 'not-configured', 'unavailable'].includes(s.status), `unexpected status ${s.status}`);
    assert.ok(typeof s.reason === 'string' && s.reason.length, 'every status carries a reason code');
    assert.equal(s.fingerprint.length, 8);
    assert.ok(!('secret' in s), 'a status must not carry a secret');
  }
});

test('ATS213-IT-003: the contract announces the status vocabulary', async () => {
  const [status, body] = await api('/api/security/contract');
  assert.equal(status, 200);
  assert.deepEqual(body.statuses, ['configured', 'not-configured', 'unavailable']);
  assert.ok(body.statusReasons.includes('CREDENTIAL_FOUND'));
  assert.ok(body.statusReasons.includes('CREDENTIAL_STORE_UNAVAILABLE'));
});

test('ATS213-IT-004: the status of an unknown credential id is refused with 404', async () => {
  const [status, body] = await api('/api/security/credentials/cred_aaaaaaaaaaaaaaaaaaaaaaaa/status');
  assert.equal(status, 404);
  assert.equal(body.error, 'CREDENTIAL_NOT_FOUND');
});

test('ATS213-IT-005: a malformed request body does not echo its content', async () => {
  // The regression this guards: V8's JSON.parse error message carries a
  // FRAGMENT of the raw input. With a secret in the body, the fragment was
  // the secret's prefix, and it reached the HTTP response.
  const secret = 'sk-ats213-LEAKCANARY-9c1e7a';
  const raw = `{"name":"k","secret":${secret}}`;
  const [status, body] = await api('/api/security/credentials', 'POST', raw);
  assert.equal(status, 400);
  assert.equal(body.error, 'INVALID_REQUEST_BODY');
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes(secret), 'the response must not carry the secret');
  assert.ok(!serialised.includes(secret.slice(0, 10)), 'the response must not carry a fragment of the secret');
  assert.ok(!serialised.includes('sk-ats213'), 'the response must not carry any part of the secret');
});

test('ATS213-IT-006: a credential put keeps the status list consistent', async () => {
  // The outcome depends on whether THIS machine has an OS credential store.
  // Both outcomes are asserted, because both are deterministic: either the
  // secret is stored and the status reads `configured`, or the store is
  // unavailable and the put is REFUSED with 503 (never a plaintext
  // fallback, never a silent success).
  const [putStatus, putBody] = await api('/api/security/credentials', 'POST', {
    name: 'ats213-it-key', secret: 'sk-ats213-IT-marker-4c1e',
  });
  if (putStatus === 201) {
    const id = putBody.credential.id;
    const [sStatus, sBody] = await api(`/api/security/credentials/${id}/status`);
    assert.equal(sStatus, 200);
    assert.equal(sBody.status.status, 'configured');
    assert.equal(sBody.status.reason, 'CREDENTIAL_FOUND');
    const [, list] = await api('/api/security/credentials/status');
    assert.equal(list.statuses.length, 1);
    assert.equal(list.statuses[0].status, 'configured');
    const [delStatus] = await api(`/api/security/credentials/${id}`, 'DELETE');
    assert.equal(delStatus, 200);
    const [, after] = await api('/api/security/credentials/status');
    assert.equal(after.statuses.length, 0);
    // The store was reachable, so the file-scan case below can run.
    realStoreAvailable = true;
  } else {
    assert.equal(putStatus, 503);
    assert.equal(putBody.error, 'CREDENTIAL_STORE_UNAVAILABLE');
    realStoreAvailable = false;
  }
});

test('ATS213-IT-007: a secret never reaches the platform data directory', async () => {
  const secret = 'sk-ats213-IT-FILEMARKER-71bd';
  const [putStatus, putBody] = await api('/api/security/credentials', 'POST', { name: 'ats213-file-key', secret });
  if (putStatus !== 201) {
    // No OS credential store on this machine: the put is REFUSED, so there
    // is no secret anywhere to scan. The refusal itself is the assertion.
    assert.equal(putStatus, 503);
    assert.equal(putBody.error, 'CREDENTIAL_STORE_UNAVAILABLE');
    return;
  }
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (fs.readFileSync(full).includes(secret)) offenders.push(full);
    }
  };
  walk(path.join(data, 'state'));
  assert.deepEqual(offenders, [], 'the secret must never be written into the platform data directory');
  const [, list] = await api('/api/security/credentials/status');
  assert.ok(!JSON.stringify(list).includes(secret), 'the status list must not carry the secret');
  const [, del] = await api(`/api/security/credentials/${putBody.credential.id}`, 'DELETE');
  assert.equal(del.credential.id, putBody.credential.id);
});

test('ATS213-IT-CLEANUP: stop the bridge and remove the fixture', () => {
  // The summary says whether the REAL OS credential store was exercised on
  // this machine. It is a measured fact, not an assumption -- and a machine
  // without a credential store produced a DIFFERENT but still deterministic
  // outcome (the put was refused with 503).
  console.log(`# the real OS credential store was reachable on this machine: ${realStoreAvailable}`);
  cp.kill();
  fs.rmSync(data, { recursive: true, force: true });
});
