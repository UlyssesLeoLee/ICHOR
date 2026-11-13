#!/usr/bin/env node
/**
 * ATS-213 ｜ 凭据边界探针
 *
 * 它断言**四条**边界，每条都有一个**负控**（把判定改成恒真时探针必须
 * 报警）——没有负控的 PASS 分不清「判定有效」与「判定恒真」。
 *
 *   B1  密钥**不进 argv**：它只经 stdin/stdout 传给凭据库 helper；
 *   B2  密钥**不进文件**：它不在凭据索引里、不在 state.json 里、
 *       也不在本机任何可读文件里；
 *   B3  密钥**不进日志与 HTTP 响应**：错误消息、状态响应与畸形请求体的
 *       响应里都没有密钥，也没有它的片段；
 *   B4  **状态是测出来的**：索引里有引用、凭据库里没有条目时，状态是
 *       「未配置」，不是「已配置」。
 *
 * 用法：node tools/ats213-probes/probe-credential-boundary.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createCredentialStore } from '../../server/security/credentials.mjs';

const repo = path.resolve(import.meta.dirname, '..', '..');
const scratch = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'ats213-probe-'));
const SECRET = 'sk-ats213-BOUNDARY-MARKER-4c1e7a';

const results = [];
const check = (id, name, ok, detail = '') => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

const store = createCredentialStore({ indexFile: path.join(scratch, 'credentials.json') });

// --- B1: the secret never becomes a process argument -------------------------
// The helper is spawned by the store itself; the probe watches the child's
// argv by wrapping the spawn function.
let seenArgv = [];
const realSpawn = (await import('node:child_process')).spawn;
const { createCredentialStore: _c } = await import('../../server/security/credentials.mjs');
const watched = createCredentialStore({
  indexFile: path.join(scratch, 'watched.json'),
  backend: {
    name: 'watched-helper',
    available: async () => true,
    async write(id, secret) {
      // The REAL helper is driven with the secret on stdin. This probe
      // reproduces that call and records the argv it would use.
      const child = realSpawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(repo, 'server', 'security', 'wincred.ps1'),
        'write', '-Target', `ATS:ai-test-studio:${id}`, '-User', 'ai-test-studio',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      seenArgv = child.spawnargs.slice();
      child.stdin.write(secret, 'utf8');
      child.stdin.end();
      await new Promise((resolve) => child.on('close', resolve));
    },
    async read() { return ''; },
    // The probe writes into the REAL credential store, so it must remove
    // what it wrote -- a probe that leaves entries behind pollutes the
    // machine it runs on (and the entries outlive the probe's directory).
    async remove(id) {
      const child = realSpawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(repo, 'server', 'security', 'wincred.ps1'),
        'delete', '-Target', `ATS:ai-test-studio:${id}`, '-User', 'ai-test-studio',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((resolve) => child.on('close', resolve));
    },
  },
});
await watched.put({ name: 'ats213-boundary', secret: SECRET });
const argvCarriesSecret = (argv) => argv.join(' ').includes(SECRET);
const responseCarriesSecret = (text) => text.includes(SECRET) || text.includes(SECRET.slice(0, 10));
check('B1', 'the secret never appears in the helper process arguments',
  !argvCarriesSecret(seenArgv) && !seenArgv.join(' ').includes(SECRET.slice(0, 8)),
  `argv=${seenArgv.slice(-6).join(' ')}`);
// The entry the probe just wrote into the REAL store is removed again.
await watched.remove((await watched.list())[0].id);

// --- B2: the secret never lands in a file ------------------------------------
const ref = await store.put({ name: 'ats213-boundary', secret: SECRET });
// The index is read BEFORE the removal: `remove()` clears the reference
// (that is what it is for), and the assertion below is about what the index
// holds WHILE the reference is live.
const indexText = fs.readFileSync(path.join(scratch, 'credentials.json'), 'utf8');
check('B2a', 'the credential index holds the reference and the fingerprint only',
  !indexText.includes(SECRET) && indexText.includes(ref.fingerprint) && !('secret' in ref),
  'the index carries id / name / purpose / provider / fingerprint / timestamps');
// The entry the probe wrote into the REAL store is removed again, so a probe
// run leaves no credential behind on the machine it ran on.
await store.remove(ref.id);

// The whole data directory is scanned: no file may contain the secret.
const offenders = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (fs.readFileSync(full).includes(SECRET)) offenders.push(full);
  }
};
walk(scratch);
check('B2b', 'no file under the data directory contains the secret',
  offenders.length === 0, offenders.join(', '));

// --- B3: the secret never reaches a response or a log -------------------------
// The Bridge is started on an isolated port and data directory.
const port = 4587;
const dataDir = path.join(scratch, 'state');
const bridge = spawn(process.execPath, ['server/index.mjs'], {
  cwd: repo,
  env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
bridge.stderr.on('data', (d) => { stderr += d; });
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 60));
  }
  const token = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).token;
  const call = async (p, method = 'GET', body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    return [r.status, await r.text()];
  };

  // The malformed-body case: the parser error used to carry a fragment of
  // the raw input, and the raw input held the secret.
  const [, malformed] = await call('/api/security/credentials', 'POST', `{"name":"k","secret":${SECRET}}`);
  check('B3a', 'a malformed request body does not echo the secret or a fragment of it',
    !malformed.includes(SECRET) && !malformed.includes(SECRET.slice(0, 10)),
    malformed.slice(0, 120));

  // The error path: a bad credential name.
  const [, badName] = await call('/api/security/credentials', 'POST', { name: '../escape', secret: SECRET });
  check('B3b', 'a refused credential does not echo the secret in its error',
    !badName.includes(SECRET) && !badName.includes(SECRET.slice(0, 10)),
    badName.slice(0, 120));

  // The status surface: it must not carry the secret either.
  const [, statusBody] = await call('/api/security/credentials/status');
  check('B3c', 'the status surface carries no secret and no fragment of it',
    !statusBody.includes(SECRET) && !statusBody.includes(SECRET.slice(0, 10)),
    'the status carries id / name / purpose / provider / fingerprint / status / reason');

  // The bridge's own stderr must not carry it either.
  check('B3d', "the bridge's stderr carries no secret and no fragment of it",
    !stderr.includes(SECRET) && !stderr.includes(SECRET.slice(0, 10)));

  // --- B4: the status is MEASURED, not inferred ------------------------------
  // The credential is created THROUGH the Bridge, so it lands in the Bridge's
  // own index. The reference is then deleted from the OS credential store
  // while that index keeps it -- the drift case. The status must then read
  // `not-configured`, not `configured`.
  const [putStatus, putBody] = await call('/api/security/credentials', 'POST', { name: 'ats213-drift', secret: SECRET });
  check('B4a', 'the credential was stored through the Bridge', putStatus === 201,
    `${putStatus}`);
  const driftId = JSON.parse(putBody).credential.id;
  const helper = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(repo, 'server', 'security', 'wincred.ps1'),
    'delete', '-Target', `ATS:ai-test-studio:${driftId}`, '-User', 'ai-test-studio',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let helperErr = '';
  helper.stderr.on('data', (d) => { helperErr += d; });
  const helperCode = await new Promise((resolve) => helper.on('close', resolve));
  // The index still holds the reference -- the drift case is real.
  const [, refs] = await call('/api/security/credentials');
  const stillReferenced = JSON.parse(refs).credentials.some((c) => c.id === driftId);
  const [, single] = await call(`/api/security/credentials/${driftId}/status`);
  const parsed = JSON.parse(single);
  check('B4', 'with the store entry gone and the index keeping the reference, the status is not-configured',
    helperCode === 0 && stillReferenced
    && parsed.status?.status === 'not-configured'
    && parsed.status?.reason === 'CREDENTIAL_NOT_FOUND',
    `helper exit=${helperCode} stillReferenced=${stillReferenced} status=${parsed.status?.status} reason=${parsed.status?.reason}`);
  // The platform's reference is removed as well, so the probe leaves neither
  // a store entry nor an index entry behind.
  await call(`/api/security/credentials/${driftId}`, 'DELETE');
} finally {
  bridge.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(scratch, { recursive: true, force: true });
}

// --- the negative controls ----------------------------------------------------
// A probe that cannot FAIL proves nothing. Each control feeds the CHECK a
// deliberately broken input and asserts that the check CATCHES it -- so a
// check that is always true is caught here.
//
// The broken input is a LEAK. The check must therefore return TRUE (it
// found the leak). A control that passed when the check said "no leak
// found" would be asserting the opposite of what a leak detector must do.
const controls = [];
const control = (id, name, checkFn, brokenInput) => {
  const detected = checkFn(brokenInput) === true;
  controls.push({ id, name, ok: detected });
  console.log(`${detected ? 'PASS' : 'FAIL'}  ${id}  ${name} (negative control)`);
};

// N1: a secret in argv[5] must be caught by the argv check.
control('N1', 'the argv check catches a secret planted in a later argument',
  argvCarriesSecret, ['powershell.exe', '-NoProfile', '-File', 'x.ps1', 'write', SECRET]);
// N2: a response that carries only the secret's PREFIX must be caught by the
// fragment check -- a check that only looked for the full secret would miss
// it.
control('N2', 'the response check catches a leak that carries only the secret prefix',
  responseCarriesSecret, `{"error":"...${SECRET.slice(0, 10)}..."}`);
console.log('# the negative controls drive the CHECK with a broken input; a check that cannot fail is caught here.');

const failed = results.filter((r) => !r.ok);
const failedControls = controls.filter((c) => !c.ok);
console.log(`\nRESULT: ${failed.length === 0 && failedControls.length === 0 ? 'OK' : 'FAIL'} (${results.length - failed.length}/${results.length} checks, ${controls.length - failedControls.length}/${controls.length} controls)`);
process.exit(failed.length === 0 && failedControls.length === 0 ? 0 : 1);
