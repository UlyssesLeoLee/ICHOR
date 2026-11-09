#!/usr/bin/env node
/**
 * ATS-402 | UI end-to-end run of the "AI 数据安全" tab in a REAL browser.
 *
 * It boots the real Bridge on an isolated data directory (serving the static
 * export in apps/studio/out), drives Microsoft Edge (headless) through
 *
 *   ST-031  save a key  -> the secret is in the OS credential store and in NO
 *                           file of the platform data directory; delete it
 *   ST-032  preview -> confirm -> consent listed (the scope was shown first)
 *   ST-033  egress without a consent / after revoke is refused AND audited,
 *           and the audit row is visible in the UI
 *           expiry: a consent past its TTL is shown as `expired`, is not
 *           counted as active and has no revoke button
 *
 * and writes screenshots plus a Playwright trace under <out>.
 *
 * Usage:
 *   ATS402_REAL_CREDENTIAL_STORE=1 node tools/ats402-probes/ui-e2e.mjs <outDir>
 * Optional: ATS402_PLAYWRIGHT_CORE=<dir of playwright-core>, ATS402_BROWSER_CHANNEL=msedge
 *
 * The secret used is a fake value. The run deletes every credential it created.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.resolve(process.argv[2] || path.join(repo, 'docs', 'evidence', 'ATS-402', 'ui'));
const coreDir = process.env.ATS402_PLAYWRIGHT_CORE || 'D:/ICHOR/examples/sample-playwright/node_modules/playwright-core';
const channel = process.env.ATS402_BROWSER_CHANNEL || 'msedge';
const SECRET = 'sk-ui-e2e-FAKE-7c1d9e42';
fs.mkdirSync(outDir, { recursive: true });

const { chromium } = await import(pathToFileURL(path.join(coreDir, 'index.mjs')).href);

const results = [];
const check = (id, name, ok, detail = '') => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

// The UI talks to the Bridge on port 4577 (apps/studio/lib/api.ts), so that is
// the port this run needs. It must be free.
const port = 4577;
await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', () => reject(new Error('port 4577 is in use; stop the running Bridge first')));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
});
const scratch = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'ats402-ui-'));
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
  const r = await fetch(base + p, { method, headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return [r.status, await r.json()];
};

let browser;
let exitCode = 0;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 60)); }
  token = (await (await fetch(`${base}/api/session`)).json()).token;
  const [ps, pb] = await api('/api/projects', 'POST', { path: fixture });
  if (ps !== 201) throw new Error(`project registration failed: ${ps}`);
  const projectId = pb.project.id;

  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  globalThis.__page = page;
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(base + '/');
  await page.waitForSelector('button[title="AI 数据安全"]', { timeout: 15000 });
  check('UI-LOAD', 'the studio loads in a real browser', true, `title="${await page.title()}"`);

  await page.click('button[title="AI 数据安全"]');
  await page.waitForSelector('text=AI 数据安全', { timeout: 10000 });
  await page.waitForSelector('text=数据外传授权');
  check('UI-TAB', 'the "AI 数据安全" tab renders its three cards', await page.locator('text=密钥存储').count() > 0 && await page.locator('text=外传审计').count() > 0);
  await page.screenshot({ path: path.join(outDir, '01-security-tab.png') });

  // ---- ST-031: a key goes into the OS credential store, not into any local file
  const real = process.env.ATS402_REAL_CREDENTIAL_STORE === '1';
  if (real) {
    await page.fill('input[placeholder="密钥名称"]', 'ui-e2e-key');
    await page.fill('input[placeholder="密钥内容"]', SECRET);
    await page.click('button:has-text("存入")');
    await page.waitForSelector('text=ui-e2e-key');
    check('ST-031a', 'the saved key is listed by reference (name, fingerprint), and the password field is cleared',
      (await page.inputValue('input[placeholder="密钥内容"]')) === '');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (fs.readFileSync(full).includes(SECRET)) offenders.push(full);
      }
    };
    walk(scratch);
    check('ST-031b', 'the secret is in NO file under the platform data directory or fixture', offenders.length === 0, offenders.join(', '));
    const bodyText = await page.locator('body').innerText();
    check('ST-031c', 'the secret is not rendered anywhere in the page', !bodyText.includes(SECRET));
    await page.screenshot({ path: path.join(outDir, '02-key-saved.png') });
    await page.click('button:has-text("删除")');
    await page.waitForSelector('text=尚未存入任何密钥');
    check('ST-031d', 'deleting the key through the UI clears the reference', true);
  } else {
    check('ST-031', 'key storage (needs ATS402_REAL_CREDENTIAL_STORE=1)', false, 'SKIPPED: real credential store not enabled');
  }

  // ---- ST-033 (before any consent): egress is refused and audited
  const [s0, b0] = await api('/api/security/egress/check', 'POST', { projectId, inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }] });
  check('ST-033a', 'egress with no consent is refused (403 EGRESS_CONSENT_REQUIRED)', s0 === 403 && b0.error === 'EGRESS_CONSENT_REQUIRED', `${s0} ${b0.error}`);

  // ---- ST-032: preview -> confirm -> consent
  await page.click('button:has-text("刷新")');
  await page.click('button:has-text("预览将要外传的范围")');
  await page.waitForSelector('text=待确认的范围');
  const previewText = await page.locator('text=待确认的范围').locator('..').innerText();
  check('ST-032a', 'the preview shows the real scope BEFORE any consent exists (ref, bytes, SHA-256)',
    previewText.includes('tests/home.spec.ts') && /SHA-256/.test(previewText) && /1 项/.test(previewText), previewText.replace(/\s+/g, ' ').slice(0, 160));
  check('ST-032b', 'no consent exists yet when the preview is shown', (await api('/api/security/egress/consents'))[1].consents.length === 0);
  await page.screenshot({ path: path.join(outDir, '03-preview.png') });
  await page.click('button:has-text("确认并授权")');
  await page.waitForSelector('text=granted');
  const [, list1] = await api('/api/security/egress/consents');
  check('ST-032c', 'confirming records one granted consent and shows a revoke button',
    list1.consents.length === 1 && list1.consents[0].state === 'granted' && await page.locator('button:has-text("撤销")').count() === 1);
  await page.screenshot({ path: path.join(outDir, '04-consent-granted.png') });
  const consentId = list1.consents[0].id;
  const [sOk] = await api('/api/security/egress/check', 'POST', { projectId, inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }], consentId });
  check('ST-032d', 'with the consent the same egress is allowed (200)', sOk === 200, String(sOk));

  // ---- revoke
  await page.click('button:has-text("撤销")');
  await page.waitForSelector('text=revoked');
  const [sRev, bRev] = await api('/api/security/egress/check', 'POST', { projectId, inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }], consentId });
  check('ST-033b', 'after revoking in the UI the same egress is refused (403 EGRESS_CONSENT_REVOKED)', sRev === 403 && bRev.error === 'EGRESS_CONSENT_REVOKED', `${sRev} ${bRev.error}`);
  check('ST-033c', 'the revoked consent has no revoke button any more', await page.locator('button:has-text("撤销")').count() === 0);

  // ---- an out-of-scope request with a VALID consent is refused and audited
  const [, preview2] = await api('/api/security/egress/preview', 'POST', { projectId, inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }] });
  const [, consent2] = await api('/api/security/egress/confirm', 'POST', { projectId, inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }], previewId: preview2.preview.previewId });
  const [sEsc, bEsc] = await api('/api/security/egress/check', 'POST', { projectId, inputs: [{ kind: 'file', ref: '../outside/secret.txt' }], consentId: consent2.consent.id });
  check('ST-033d', 'a path outside the project is refused even with a valid consent', sEsc === 400 && bEsc.error === 'EGRESS_GATE_SCOPE_INVALID', `${sEsc} ${bEsc.error}`);
  await page.click('button:has-text("刷新")');
  await page.waitForSelector('text=egress.denied');
  const auditText = await page.locator('text=外传审计').locator('..').innerText();
  check('ST-033e', 'the audit card shows egress.denied rows, including the escaping ref, without any file content',
    auditText.includes('egress.denied') && auditText.includes('../outside/secret.txt') && auditText.includes('未读取内容'));
  await page.screenshot({ path: path.join(outDir, '05-audit-denied.png') });

  // ---- expiry: a consent past its TTL is shown as expired, not as active
  const [, preview3] = await api('/api/security/egress/preview', 'POST', { projectId, inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }] });
  const [, consent3] = await api('/api/security/egress/confirm', 'POST', { projectId, inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }], previewId: preview3.preview.previewId, ttlSeconds: 4 });
  await page.click('button:has-text("刷新")');
  // consent2 (24 h) + consent3 (4 s) are both active right now.
  await page.waitForFunction(() => [...document.querySelectorAll('.metric')].find((m) => m.innerText.includes('有效授权'))?.querySelector('strong')?.innerText === '2');
  const activeBefore = await page.locator('.metric', { hasText: '有效授权' }).locator('strong').innerText();
  await new Promise((r) => setTimeout(r, 4500));
  await page.click('button:has-text("刷新")');
  await page.waitForSelector('text=expired');
  await page.waitForFunction(() => [...document.querySelectorAll('.metric')].find((m) => m.innerText.includes('有效授权'))?.querySelector('strong')?.innerText === '1');
  const activeAfter = await page.locator('.metric', { hasText: '有效授权' }).locator('strong').innerText();
  const expiredRow = page.locator('.result-item', { hasText: 'expired' });
  check('UI-EXPIRED', 'an expired consent is shown as `expired`, with no revoke button, and is not counted as active',
    await expiredRow.count() === 1 && await expiredRow.locator('button:has-text("撤销")').count() === 0 && Number(activeAfter) === Number(activeBefore) - 1,
    `active ${activeBefore} -> ${activeAfter}`);
  const [sExp, bExp] = await api('/api/security/egress/check', 'POST', { projectId, inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }], consentId: consent3.consent.id });
  check('ST-033f', 'the expired consent is refused (403 EGRESS_CONSENT_EXPIRED)', sExp === 403 && bExp.error === 'EGRESS_CONSENT_EXPIRED', `${sExp} ${bExp.error}`);
  await page.screenshot({ path: path.join(outDir, '06-consent-expired.png') });

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
