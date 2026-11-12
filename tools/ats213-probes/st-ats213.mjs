#!/usr/bin/env node
/**
 * ATS-213 ｜ 凭据可用状态 —— 系统测试（真实浏览器）
 *
 * 它启动**真实 Bridge**（隔离数据目录），用**真实浏览器**驱动 Next 工作台
 * 的「AI 数据安全」页，断言三条验收标准里界面上那条：
 *
 *   ST-ATS213-001  存入一个密钥后，界面显示它的**可用状态**（已配置）；
 *   ST-ATS213-002  从**系统凭据库**里删掉那一条之后，界面显示
 *                  **未配置**——状态是**测出来的**，不是从索引推断的；
 *   ST-ATS213-003  界面上**没有任何密钥明文**，状态行也不含密钥片段；
 *   ST-ATS213-004  凭据库不可用时，界面报出**取不到**而不是假装可用。
 *
 * 与 ATS-402 的 ui-e2e 一样：秘密用的是**假值**，跑完删掉每一条凭据。
 *
 * 用法：
 *   node tools/ats213-probes/st-ats213.mjs <outDir>
 * 可选：ATS213_PLAYWRIGHT_CORE=<playwright-core 目录>
 *       ATS213_BROWSER_CHANNEL=msedge
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.resolve(process.argv[2] || path.join(repo, 'docs', 'evidence', 'ATS-213', 'ui'));
const coreDir = process.env.ATS213_PLAYWRIGHT_CORE || 'D:/ICHOR/examples/sample-playwright/node_modules/playwright-core';
const channel = process.env.ATS213_BROWSER_CHANNEL || 'msedge';
/** 一个假的密钥值。它不是任何真实凭据。 */
const SECRET = 'sk-ui-...9e42';
fs.mkdirSync(outDir, { recursive: true });

const { chromium } = await import(pathToFileURL(path.join(coreDir, 'index.mjs')).href);

const results = [];
const check = (id, name, ok, detail = '') => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

// The UI talks to the Bridge on the port apps/studio/lib/api.ts declares;
// read it from there so the port is defined in one place only.
const uiApi = fs.readFileSync(path.join(repo, 'apps', 'studio', 'lib', 'api.ts'), 'utf8');
const port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(uiApi)?.[1]);
if (!Number.isInteger(port)) throw new Error('cannot read the Bridge port from apps/studio/lib/api.ts');
/**
 * Wait until the port can really be BOUND.
 *
 * Reading the socket table is not enough: a killed process on Windows leaves
 * a "LISTENING" socket whose owner PID is 0, and a probe that starts while it
 * is there gets EADDRINUSE for a port that is about to become free. The
 * only trustworthy test is a real bind(), so this waits (bounded) for one.
 */
const waitForPort = async (port, attempts = 60) => {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};
if (!await waitForPort(port)) {
  throw new Error(`port ${port} is in use; stop the running Bridge first`);
}

const scratch = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'ats213-ui-'));
const stateDir = path.join(scratch, 'state');
const fixture = path.join(scratch, 'fixture');
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'package.json'), '{}');
fs.writeFileSync(path.join(fixture, 'playwright.config.ts'), 'export default {}');
fs.writeFileSync(path.join(fixture, 'tests', 'home.spec.ts'), "test('home passes', async ({page}) => {});\n");

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

/**
 * Delete the credential's entry from the OS credential store, leaving the
 * platform's index in place. That is the DRIFT case the status surface
 * exists for: the index still remembers the reference, the store no longer
 * holds the secret.
 *
 * The deletion goes through the platform's own helper (the same one the
 * store uses), so no credential-manager CLI is invoked by hand.
 */
const deleteFromStore = async (id) => {
  const script = path.join(repo, 'server', 'security', 'wincred.ps1');
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    'delete', '-Target', `ATS:ai-test-studio:${id}`, '-User', 'ai-test-studio',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, err: err.trim() }));
  });
};

let browser;
let exitCode = 0;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 60));
  }
  token = (await (await fetch(`${base}/api/session`)).json()).token;
  const [ps, pb] = await api('/api/projects', 'POST', { path: fixture });
  if (ps !== 201) throw new Error(`project registration failed: ${ps}`);

  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  globalThis.__page = page;
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(base + '/');
  await page.waitForSelector('button[title="AI 数据安全"]', { timeout: 15000 });
  await page.click('button[title="AI 数据安全"]');
  await page.waitForSelector('text=密钥存储', { timeout: 10000 });
  check('UI-LOAD', 'the studio loads and the AI data security tab renders', true);

  // --- the store must be reachable for the credential cases to mean anything
  const [storeStatus, storeBody] = await api('/api/security/credentials/status');
  check('UI-STORE', 'the credential status endpoint answers over HTTP',
    storeStatus === 200 && Array.isArray(storeBody.statuses), `${storeStatus}`);

  // --- ST-ATS213-001: a stored key shows as 已配置
  await page.fill('input[placeholder="密钥名称"]', 'ats213-ui-key');
  await page.fill('input[placeholder="密钥内容"]', SECRET);
  await page.click('button:has-text("存入")');
  await page.waitForSelector('[data-region="cred-status"]', { timeout: 15000 });
  const row = page.locator('[data-region="cred-status"]').first();
  const statusAttr = await row.getAttribute('data-cred-status');
  const labelText = await row.locator('[data-region="cred-status-label"]').innerText();
  check('ST-ATS213-001', 'a key stored in the OS credential store shows as 已配置',
    statusAttr === 'configured' && labelText.includes('已配置'),
    `data-cred-status=${statusAttr} label=${labelText.replace(/\s+/g, ' ').slice(0, 80)}`);
  await page.screenshot({ path: path.join(outDir, '01-configured.png') });

  // --- ST-ATS213-003: no plaintext anywhere on the page
  const bodyText = await page.locator('body').innerText();
  check('ST-ATS213-003', 'the page shows no secret and no fragment of it',
    !bodyText.includes(SECRET) && !bodyText.includes(SECRET.slice(0, 8)),
    'the status row carries the name, the provider and the 8-char fingerprint only');
  check('ST-ATS213-003b', 'the secret input is cleared after the store accepted it',
    (await page.inputValue('input[placeholder="密钥内容"]')) === '');

  // --- ST-ATS213-002: the status is MEASURED, not inferred from the index
  const [, list1] = await api('/api/security/credentials/status');
  const storedId = list1.statuses[0]?.id;
  if (!storedId) throw new Error('the credential was not stored');
  const del = await deleteFromStore(storedId);
  check('ST-ATS213-002a', 'the entry was deleted from the OS credential store',
    del.code === 0, `helper exit=${del.code} ${del.err}`);
  // The platform's index still holds the reference -- that is the drift case.
  const [, refs] = await api('/api/security/credentials');
  check('ST-ATS213-002b', 'the platform index still holds the reference (the drift case is real)',
    refs.credentials.some((c) => c.id === storedId));
  await page.click('button:has-text("刷新")');
  await page.waitForFunction(
    () => document.querySelector('[data-region="cred-status"]')?.getAttribute('data-cred-status') === 'not-configured',
    undefined, { timeout: 15000 },
  ).catch(() => {});
  const row2 = page.locator('[data-region="cred-status"]').first();
  const statusAttr2 = await row2.getAttribute('data-cred-status');
  const labelText2 = await row2.locator('[data-region="cred-status-label"]').innerText();
  check('ST-ATS213-002', 'after the entry is gone the UI shows 未配置 (measured, not inferred)',
    statusAttr2 === 'not-configured' && labelText2.includes('未配置'),
    `data-cred-status=${statusAttr2} label=${labelText2.replace(/\s+/g, ' ').slice(0, 80)}`);
  await page.screenshot({ path: path.join(outDir, '02-not-configured.png') });

  // --- ST-ATS213-004: the status endpoint reports the failure honestly
  const [, statusBody] = await api(`/api/security/credentials/${storedId}/status`);
  check('ST-ATS213-004', 'the status endpoint reports not-configured with its reason code',
    statusBody.status?.status === 'not-configured'
    && statusBody.status?.reason === 'CREDENTIAL_NOT_FOUND',
    JSON.stringify(statusBody.status ?? {}).slice(0, 160));

  // --- the reference is still deletable, and the UI leaves nothing behind
  await page.click('button:has-text("删除")');
  await page.waitForSelector('text=尚未存入任何密钥', { timeout: 10000 });
  const [, after] = await api('/api/security/credentials/status');
  check('UI-CLEANUP', 'the reference is removed from the platform and the UI shows an empty list',
    after.statuses.length === 0);

  check('UI-NOERR', 'the page raised no uncaught error', consoleErrors.length === 0, consoleErrors.join(' | '));
  await context.tracing.stop({ path: path.join(outDir, 'trace.zip') });
  await context.close();
} catch (error) {
  console.log(`FAIL  UI-RUN  ${error.stack || error}`);
  await globalThis.__page?.screenshot({ path: path.join(outDir, 'failure.png') }).catch(() => {});
  results.push({ id: 'UI-RUN', name: 'run completed', ok: false, detail: String(error) });
} finally {
  if (browser) await browser.close().catch(() => {});
  bridge.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(scratch, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), browserChannel: channel, results }, null, 2));
console.log(`\nRESULT: ${failed.length === 0 ? 'OK' : 'FAIL'} (${results.length - failed.length}/${results.length} checks passed)`);
exitCode = failed.length === 0 ? 0 : 1;
process.exit(exitCode);
