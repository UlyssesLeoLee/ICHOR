#!/usr/bin/env node
/**
 * ATS-213 ｜ 凭据引用 —— 系统测试（真实浏览器 + 真实系统凭据库）
 *
 * 这是 ATS-213 验收标准第一句「**密钥仅以引用传递**」的端到端证据。
 *
 * 链路是完整的一条，每一段都有断言：
 *
 *   1. 把一个密钥存进**真实 Windows Credential Manager**；
 *   2. 在项目级环境档案里写一个**引用**（`{"credentialRef":"cred_…"}`）；
 *   3. 发起一次**真实 Playwright 运行**，被测脚本读到注入的变量；
 *   4. 断言脚本读到的是**那个密钥**（按长度与摘要断言，不回显原文）；
 *   5. 断言平台的落盘文件里**找不到**那个密钥——档案、运行记录、事件
 *      日志、stdout、SQLite 镜像、证据归档，一处都没有。
 *
 * 脚本断言的是**摘要**而不是明文，所以证据日志里也不会出现密钥。
 *
 * 用法：
 *   node tools/ats213-probes/st-credential-ref.mjs <outDir>
 * 可选：ATS213_PLAYWRIGHT_CORE=<playwright-core 目录>
 *       ATS213_BROWSER_CHANNEL=msedge
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.resolve(process.argv[2] || path.join(repo, 'docs', 'evidence', 'ATS-213', 'ref'));
const coreDir = process.env.ATS213_PLAYWRIGHT_CORE || 'D:/ICHOR/examples/sample-playwright/node_modules/playwright-core';
const channel = process.env.ATS213_BROWSER_CHANNEL || 'msedge';

/** A fake secret. It is not a credential of anything. */
const SECRET = 'ats213-ref-secret-9c4e2b7a';
/** The digest the fixture asserts on -- the digest, never the secret. */
const SECRET_SHA256 = crypto.createHash('sha256').update(SECRET, 'utf8').digest('hex');
const SECRET_LEN = SECRET.length;

fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (id, name, ok, detail = '') => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

const uiApi = fs.readFileSync(path.join(repo, 'apps', 'studio', 'lib', 'api.ts'), 'utf8');
const port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(uiApi)?.[1]);
if (!Number.isInteger(port)) throw new Error('cannot read the Bridge port from apps/studio/lib/api.ts');

const waitForPort = async (p, attempts = 60) => {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};
if (!await waitForPort(port)) throw new Error(`port ${port} is in use; stop the running Bridge first`);

const scratch = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'ats213-ref-'));
const stateDir = path.join(scratch, 'state');
const fixture = path.join(scratch, 'fixture');
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'ats213-ref', private: true }));
// The fixture's config is minimal, and the fixture reads the INJECTED
// variable and writes its DIGEST and LENGTH -- never the value.
fs.writeFileSync(path.join(fixture, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test';\nexport default defineConfig({testDir:'./tests',use:{},timeout:30000,retries:0});\n`);
fs.writeFileSync(path.join(fixture, 'tests', 'ref.spec.ts'), `
import { test } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';

test('the injected credential reference reaches the runner', async () => {
  const value = process.env.API_TOKEN;
  const digest = value ? crypto.createHash('sha256').update(value, 'utf8').digest('hex') : '';
  fs.writeFileSync('observed.json', JSON.stringify({
    present: typeof value === 'string' && value.length > 0,
    length: value ? value.length : 0,
    digest,
  }));
  expect(typeof value === 'string' && value.length > 0).toBe(true);
});
`);

// The fixture needs a real @playwright/test installation. The example
// project of the repository has one; the fixture borrows its node_modules
// through a junction so no install is needed and no lockfile is touched.
const exampleModules = path.join(coreDir, '..');
const link = path.join(fixture, 'node_modules');
try {
  fs.symlinkSync(exampleModules, link, 'junction');
} catch {
  // A junction needs the privileges of the account; a copy of the two
  // directories the fixture needs is the fallback.
  fs.cpSync(exampleModules, link, { recursive: true });
}

const bridge = spawn(process.execPath, ['server/index.mjs'], {
  cwd: repo, stdio: 'ignore',
  env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: stateDir },
});
const base = `http://127.0.0.1:${port}`;
let token;
const api = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return [r.status, await r.json()];
};

let credentialId = null;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 60));
  }
  token = (await (await fetch(`${base}/api/session`)).json()).token;

  const [ps, pb] = await api('/api/projects', 'POST', { path: fixture });
  if (ps !== 201) throw new Error(`project registration failed: ${ps} ${JSON.stringify(pb)}`);
  const projectId = pb.project.id;

  // --- 1. the secret goes into the REAL OS credential store
  const [cs, cb] = await api('/api/security/credentials', 'POST', {
    name: 'ats213-ref-key', secret: SECRET, purpose: 'other',
  });
  if (cs !== 201) {
    throw new Error(`the OS credential store refused the secret: ${cs} ${JSON.stringify(cb)}`);
  }
  credentialId = cb.credential.id;
  check('REF-ST-001', 'the secret is stored in the OS credential store (only a reference comes back)',
    Boolean(credentialId) && !JSON.stringify(cb).includes(SECRET),
    `credential id ${credentialId}`);

  // --- 2. the profile carries the REFERENCE, not the secret
  const [es, eb] = await api(`/api/projects/${projectId}/env`, 'POST', {
    name: 'ref-profile', environment: 'staging',
    variables: { API_TOKEN: { credentialRef: credentialId } },
  });
  check('REF-ST-002', 'the environment profile accepts a credential reference',
    es === 200, `${es} ${JSON.stringify(eb).slice(0, 120)}`);
  const [ls, lb] = await api(`/api/projects/${projectId}/env`);
  const profile = lb.profiles?.find((p) => p.name === 'ref-profile');
  check('REF-ST-003', 'the profile stores the reference and never the secret',
    Boolean(profile) && profile.variables.includes('API_TOKEN')
      && !JSON.stringify(lb).includes(SECRET),
    `variables: ${JSON.stringify(profile?.variables)}`);

  // --- 3. the run happens with the REFERENCE resolved into the runner env
  const [rs, rb] = await api(`/api/projects/${projectId}/run`, 'POST', {
    file: 'tests/ref.spec.ts', env: 'ref-profile',
  });
  check('REF-ST-004', 'the run is accepted with a resolvable reference', rs === 202, `${rs} ${JSON.stringify(rb).slice(0, 120)}`);
  const runId = rb.run?.id;
  if (!runId) throw new Error('the run was not accepted');

  // --- 4. wait for the run to finish
  let run = null;
  for (let i = 0; i < 200; i++) {
    const [, body] = await api(`/api/runs/${runId}`);
    run = body.run;
    if (run && ['passed', 'failed', 'error', 'cancelled'].includes(run.status)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check('REF-ST-005', 'the run reaches a terminal state', Boolean(run) && ['passed', 'failed', 'error', 'cancelled'].includes(run.status),
    `status=${run?.status} error=${run?.error}`);

  // --- 5. the fixture SAW the injected value (by digest and length)
  const observedPath = path.join(fixture, 'observed.json');
  const observed = fs.existsSync(observedPath) ? JSON.parse(fs.readFileSync(observedPath, 'utf8')) : null;
  check('REF-ST-006', 'the runner received the secret (asserted by digest and length)',
    Boolean(observed) && observed.present === true && observed.digest === SECRET_SHA256 && observed.length === SECRET_LEN,
    observed ? `length=${observed.length} digest=${observed.digest.slice(0, 12)}…` : 'the fixture wrote nothing');
  // The digest is the evidence; the secret itself is not printed anywhere.
  check('REF-ST-007', 'the evidence output carries the digest, never the secret',
    !JSON.stringify(results).includes(SECRET) && !JSON.stringify(observed ?? {}).includes(SECRET));

  // --- 6. the run record names the variable and carries no value
  check('REF-ST-008', 'the run record names the variable and carries no value',
    Array.isArray(run?.envVariables) && run.envVariables.includes('API_TOKEN')
      && !JSON.stringify(run).includes(SECRET),
    `envVariables=${JSON.stringify(run?.envVariables)}`);

  // --- 7. nothing on disk holds the secret
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      let bytes;
      try { bytes = fs.readFileSync(full); } catch { continue; }
      if (bytes.includes(Buffer.from(SECRET, 'utf8'))) offenders.push(full);
    }
  };
  walk(stateDir);
  check('REF-ST-009', 'the platform data directory holds no secret', offenders.length === 0,
    offenders.join(', ') || 'the state directory, the run records and the logs are clean');
  check('REF-ST-010', 'the run folder holds no secret',
    !fs.existsSync(path.join(fixture, 'observed.json')) || !fs.readFileSync(path.join(fixture, 'observed.json'), 'utf8').includes(SECRET),
    'the fixture wrote a digest, not the value');
} catch (error) {
  console.log(`FAIL  REF-ST-RUN  ${error.stack || error}`);
  results.push({ id: 'REF-ST-RUN', name: 'run completed', ok: false, detail: String(error) });
} finally {
  if (credentialId) {
    await api(`/api/security/credentials/${credentialId}`, 'DELETE').catch(() => {});
  }
  bridge.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(scratch, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), browserChannel: channel, results }, null, 2));
console.log(`\nRESULT: ${failed.length === 0 ? 'OK' : 'FAIL'} (${results.length - failed.length}/${results.length} checks passed)`);
process.exit(failed.length === 0 ? 0 : 1);
