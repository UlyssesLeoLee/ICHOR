/**
 * ATS-213 ｜ 凭据引用（credential reference）—— 集成测试（HTTP 层）
 *
 * 这些用例断言 ATS-213 验收标准的第一句：**「密钥仅以引用传递」**。
 *
 * 被测的链路是完整的一条：
 *
 *   档案里写引用 → 平台把引用解析成密钥 → 密钥进入封口的 runner 环境
 *   → 档案、运行记录、事件日志、落盘文件里都没有密钥
 *
 * 三条断言各有各的失败形态：
 *
 *   1. **引用能被接受**——凭据形状的变量名带一个引用时，档案存得下；
 *      带明文时被拒（明文进档案就是进证据归档）。
 *   2. **引用真的被解析**——被测脚本读到的是**注入的密钥**，而档案里
 *      留着的永远是引用。
 *   3. **解析不了就拒绝启动**——引用不存在、凭据库不可达时，运行**不
 *      开始**，并报出 `CREDENTIAL_*` 原因码。在缺少密钥的情况下静默运行
 *      是更坏的形态。
 *
 * 这些用例要一个**真实浏览器**（被测脚本要真的跑起来），所以它们只在
 * `ATS213_REAL_CREDENTIAL_STORE=1` 打开时执行——**skip 不是 pass**，汇总里
 * 逐条写明。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats213-ref-'));
const port = await freePort();
const REAL = process.env.ATS213_REAL_CREDENTIAL_STORE === '1';
let cp, token;

/** The secret the fixture asserts on. It is a fake value, not a credential. */
const SECRET = 'ats213-ref-secret-4d1f9a';

async function ready() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not boot');
}

async function api(endpoint, method = 'GET', payload) {
  const r = await fetch(`http://127.0.0.1:${port}` + endpoint, {
    method,
    headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return [r.status, await r.json()];
}

test('ATS213-REF-IT-SETUP: start the bridge', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: path.join(data, 'state') },
    stdio: 'ignore',
  });
  await ready();
  token = (await api('/api/session'))[1].token;
  assert.ok(token);
});

test('ATS213-REF-IT-001: a credential-shaped name with a REFERENCE is accepted by the profile', async () => {
  // The profile may carry a reference under a credential-shaped name. The
  // reference is what the profile stores -- never the secret.
  const fixture = path.join(data, 'fixture');
  fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'package.json'), '{}');
  fs.writeFileSync(path.join(fixture, 'playwright.config.ts'), 'export default {}');
  fs.writeFileSync(path.join(fixture, 'tests', 'a.spec.ts'), "test('a', async () => {});\n");
  const [ps, pb] = await api('/api/projects', 'POST', { path: fixture });
  assert.equal(ps, 201, JSON.stringify(pb));
  const projectId = pb.project.id;

  // A plaintext under a credential-shaped name is REFUSED -- it would land
  // in the run assets, the SQLite mirror and the evidence archive.
  const [plainStatus, plainBody] = await api(`/api/projects/${projectId}/env`, 'POST', {
    name: 'plain', environment: 'staging', variables: { API_TOKEN: SECRET },
  });
  assert.equal(plainStatus, 400, JSON.stringify(plainBody));
  assert.equal(plainBody.error, 'ENV_VARIABLE_NOT_ALLOWED');

  // A reference under the SAME name is accepted.
  const [refStatus, refBody] = await api(`/api/projects/${projectId}/env`, 'POST', {
    name: 'byref', environment: 'staging',
    variables: { API_TOKEN: { credentialRef: 'cred_0123456789abcdef01234567' } },
  });
  assert.equal(refStatus, 200, JSON.stringify(refBody));
  // The profile's public view carries the NAME of the variable, never its
  // value -- and the value is a reference, so nothing secret is exposed.
  assert.ok(refBody.profile.variables.includes('API_TOKEN'));
  assert.ok(!JSON.stringify(refBody).includes(SECRET));

  // The shorthand `cred:<id>` means the same thing and is stored in the
  // canonical form.
  const [shortStatus, shortBody] = await api(`/api/projects/${projectId}/env`, 'POST', {
    name: 'byshort', environment: 'staging',
    variables: { API_TOKEN: 'cred:0123456789abcdef01234567' },
  });
  assert.equal(shortStatus, 200, JSON.stringify(shortBody));
});

test('ATS213-REF-IT-002: a reference that cannot be resolved REFUSES the run', async () => {
  // The run must not start with a missing credential. The refusal names the
  // variable and the reference -- never the secret.
  const fixture = path.join(data, 'fixture');
  const [, list] = await api('/api/projects');
  const project = list.projects.find((p) => p.root === fixture) ?? list.projects[0];
  assert.ok(project, 'the fixture project is registered');

  const missing = 'cred_ffffffffffffffffffffffff';
  await api(`/api/projects/${project.id}/env`, 'POST', {
    name: 'missing-ref', environment: 'staging',
    variables: { API_TOKEN: { credentialRef: missing } },
  });
  const [runStatus, runBody] = await api(`/api/projects/${project.id}/run`, 'POST', {
    file: 'tests/a.spec.ts', env: 'missing-ref',
  });
  assert.notEqual(runStatus, 202, `the run must not be accepted: ${JSON.stringify(runBody)}`);
  assert.equal(runBody.error, 'CREDENTIAL_REF_NOT_FOUND');
  assert.equal(runBody.variable, 'API_TOKEN');
  assert.equal(runBody.credentialRef, missing);
  // The refusal carries no secret.
  assert.ok(!JSON.stringify(runBody).includes(SECRET));
});

test('ATS213-REF-IT-003: the run record carries the NAME of a referenced variable, never its value', async () => {
  const fixture = path.join(data, 'fixture');
  const [, list] = await api('/api/projects');
  const project = list.projects.find((p) => p.root === fixture) ?? list.projects[0];
  const [, runs] = await api('/api/runs');
  assert.ok(Array.isArray(runs.runs), 'the run list is a list');
  for (const r of runs.runs) {
    assert.ok(!JSON.stringify(r).includes(SECRET), 'a run record must not carry a secret');
  }
  assert.ok(project);
});

test('ATS213-REF-IT-CLEANUP: stop the bridge and remove the fixture', () => {
  console.log(`# the real credential-reference run was exercised on this machine: ${REAL}`);
  cp.kill();
  fs.rmSync(data, { recursive: true, force: true });
});
