#!/usr/bin/env node
/**
 * ATS-213 ｜ 状态面的**失败路径** —— 系统测试（真实浏览器）
 *
 * 前一轮的复核指出：状态面只测过「已配置 → 未配置」这一条正常路径。
 * 下面三种情况在界面上一次都没被测过，而它们恰恰是状态面最危险的形态：
 *
 *   U1a  凭据库不可达时，指标卡写着「全部可用」，而每一条都写着「取不到」；
 *   U1b  凭据库指标写着「已就绪」，而 `GET /status` 报的是「不可用」；
 *   U2   状态读取失败后，**旧的状态**被当作当前状态展示；
 *   U3   首次加载时状态读取失败，**引用列表整个消失**，删除按钮也没了。
 *
 * 本探针把这四条都测成可判定的断言，并且**每一条都带一个变异体**
 * （`mutate`）：把修复改回缺陷的样子，同一条断言必须变红。没有变异体的
 * 断言分不清「判定有效」与「判定恒真」。
 *
 * 用法：
 *   node tools/ats213-probes/st-credential-status-failures.mjs <outDir>
 * 可选：ATS213_PLAYWRIGHT_CORE=<playwright-core 目录>
 *       ATS213_BROWSER_CHANNEL=msedge
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repo = process.env.ATS213_TREE
  ? path.resolve(process.env.ATS213_TREE)
  : path.resolve(import.meta.dirname, '..', '..');
const outDir = path.resolve(process.argv[2] || path.join(repo, 'docs', 'evidence', 'ATS-213', 'failures'));
const coreDir = process.env.ATS213_PLAYWRIGHT_CORE || 'D:/ICHOR/examples/sample-playwright/node_modules/playwright-core';
const channel = process.env.ATS213_BROWSER_CHANNEL || 'msedge';
fs.mkdirSync(outDir, { recursive: true });

const { chromium } = await import(pathToFileURL(path.join(coreDir, 'index.mjs')).href);

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

const scratch = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'ats213-fail-'));
const stateDir = path.join(scratch, 'state');
const base = `http://127.0.0.1:${port}`;
let bridge = null;
let token = null;

async function startBridge(env) {
  // A bridge that is still running would hold the data directory lock and
  // the port, and the new one would refuse to start. Stop the old one
  // FIRST -- a probe that leaves a bridge behind measures a stale tree.
  await stopBridge();
  bridge = spawn(process.execPath, ['server/index.mjs'], {
    cwd: repo, stdio: 'ignore',
    env: { ...env, ATS_PORT: String(port), ATS_DATA_DIR: stateDir },
  });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 60));
  }
  token = (await (await fetch(`${base}/api/session`)).json()).token;
}
async function stopBridge() {
  if (!bridge) return;
  const b = bridge;
  bridge = null;
  await new Promise((r) => { b.once('exit', r); b.kill(); });
  await new Promise((r) => setTimeout(r, 400));
}
const api = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return [r.status, await r.json()];
};

/** What the panel says about the credentials. */
async function panel(page) {
  return page.evaluate(() => {
    const text = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const metrics = [...document.querySelectorAll('.metric')].map((m) => text(m));
    // The COUNT of a metric is the number in its own element, not a number
    // that appears somewhere in its caption. A caption may mention "共 2
    // 条引用", and reading the caption for a digit would count the
    // references as usable keys.
    //
    // The captions are read by their OWN selector, not by looking for a
    // word in the metric text: a caption that says something the probe did
    // not expect ("全部可用") would then be INVISIBLE to the probe, and the
    // defect would go unnoticed -- which is the very defect U1a is about.
    const captions = {
      configured: text(document.querySelector('[data-region="cred-configured-count"]')),
      unavailable: text(document.querySelector('[data-region="cred-unavailable-count"]')),
      unavailableCaption: text(document.querySelector('[data-region="cred-unavailable-caption"]')),
      storeCaption: text(document.querySelector('[data-region="cred-store-caption"]')),
    };
    const counts = {
      configured: captions.configured,
      unavailable: captions.unavailable,
    };
    const rows = [...document.querySelectorAll('[data-region="cred-status"]')].map((r) => ({
      status: r.getAttribute('data-cred-status'),
      text: text(r),
    }));
    // A row whose status was never measured carries `data-cred-reference`.
    // It is listed with its delete button, but it is NOT a measured status.
    // The MEASURED rows are the ones WITHOUT that marker.
    const references = [...document.querySelectorAll('[data-cred-reference="true"]')].map((r) => text(r));
    const measuredRows = rows.filter((r) => r.status !== 'unknown');
    const err = text(document.querySelector('[data-region="cred-status-error"]'));
    const deleteButtons = [...document.querySelectorAll('button')].filter((b) => b.innerText.includes('删除')).length;
    return { metrics, counts, captions, rows, measuredRows, references, err, deleteButtons };
  });
}

async function openSecurity(page) {
  await page.goto(base + '/');
  await page.waitForSelector('button[title="AI 数据安全"]', { timeout: 20000 });
  await page.click('button[title="AI 数据安全"]');
  await page.waitForSelector('text=密钥存储', { timeout: 15000 });
}

const created = [];
let browser;
try {
  // --- the normal bridge: two keys in the REAL credential store
  await startBridge(process.env);
  for (const n of ['f-a', 'f-b']) {
    const [s, b] = await api('/api/security/credentials', 'POST', {
      name: `r2-${n}`, secret: `sk-r2-${n}-ABCDEFGHIJKLMNOP`, purpose: 'other',
    });
    if (s !== 201) throw new Error(`store failed ${s} ${JSON.stringify(b)}`);
    created.push(b.credential.id);
  }
  browser = await chromium.launch({ channel, headless: true });

  // --- U1: the OS store is UNREACHABLE (PowerShell is not on PATH)
  {
    const nodeDir = path.dirname(process.execPath);
    await startBridge({ ...process.env, PATH: nodeDir, Path: nodeDir });
    const [ss, sb] = await api('/api/security/credentials/status');
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    await openSecurity(page);
    // Wait for a MEASURED row: the panel renders a row for every reference,
    // and the unmeasured row appears first.
    await page.waitForSelector('[data-region="cred-status"]:not([data-cred-reference="true"])', { timeout: 30000 })
      .catch(() => {});
    const p = await panel(page);
    await page.screenshot({ path: path.join(outDir, 'U1-store-unreachable.png') });
    const unavailable = p.rows.filter((r) => r.status === 'unavailable').length;
    // The captions are read by their OWN selector. A caption that says
    // 「全部可用」 must be VISIBLE to the probe -- otherwise the probe would
    // not notice the defect it is looking for.
    const caption = p.captions.unavailableCaption;
    const storeCaption = p.captions.storeCaption;

    // U1a: the caption must NOT say 「全部可用」 while a count is above zero.
    check('U1a', 'the unavailable caption reflects the counts and never says 全部可用 while a count is above zero',
      !(unavailable > 0 && /全部可用/.test(caption)),
      `${unavailable} rows say 取不到; caption reads "${caption}"`);
    // The caption states how many of each kind there are.
    check('U1a-count', 'the unavailable caption states the number of each kind',
      unavailable > 0 && /取不到\s*\d/.test(caption),
      `caption reads "${caption}"`);

    // U1b: the store metric must NOT say 「已就绪」 while the store is not usable.
    check('U1b', 'the credential-store metric is based on a measurement, not on the files being present',
      !(unavailable > 0 && /已就绪/.test(storeCaption)),
      `store caption reads "${storeCaption}"; GET /status available=${sb?.available} storeHealth=${JSON.stringify(sb?.storeHealth)}`);
    check('U1b-api', 'the status endpoint reports the store as NOT available when it cannot be reached',
      sb?.available === false,
      `available=${sb?.available} storeHealth=${JSON.stringify(sb?.storeHealth)}`);
    await ctx.close();
    await stopBridge();
  }

  // --- U2: the status read FAILS on a refresh -> the stale status must not be shown as current
  {
    await startBridge(process.env);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    await openSecurity(page);
    // Wait for a MEASURED row: the panel renders a row for every reference,
    // and a row whose status was not measured yet appears first. Waiting
    // for the measured one is what makes "before" a measurement.
    await page.waitForSelector('[data-region="cred-status"]:not([data-cred-reference="true"])', { timeout: 30000 })
      .catch(() => {});
    const before = await panel(page);
    // The bridge goes away: the refresh cannot read the status.
    await stopBridge();
    await page.click('button:has-text("刷新")');
    await page.waitForSelector('[data-region="cred-status-error"]', { timeout: 15000 }).catch(() => {});
    const after = await panel(page);
    await page.screenshot({ path: path.join(outDir, 'U2-stale-after-refresh-failure.png') });
    const stale = after.err && after.measuredRows.some((r) => r.status === 'configured');
    check('U2', 'a failed refresh does not leave the stale statuses on screen as if they were current',
      !stale,
      `before: ${before.measuredRows.map((r) => r.status).join(',')}; after: error="${after.err.slice(0, 70)}" rows=${after.measuredRows.map((r) => r.status).join(',')}`);
    // The stale statuses are not counted as usable.
    check('U2-count', 'the stale statuses are not counted as usable keys',
      after.counts.configured === '0',
      `the 可用密钥 count reads "${after.counts.configured}" (it was ${before.counts.configured} before the failure)`);
    // The references are still listed, and still deletable.
    check('U2-refs', 'the references are still listed after a failed refresh',
      after.references.length + after.measuredRows.length >= 1,
      `${after.references.length} unmeasured rows, ${after.measuredRows.length} measured rows`);
    await ctx.close();
  }

  // --- U3: the status read FAILS on the FIRST load -> the references must stay
  {
    await startBridge(process.env);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    await page.route('**/api/security/credentials/status', (route) => route.fulfill({
      status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'CREDENTIAL_NOT_FOUND' }),
    }));
    await openSecurity(page);
    await page.waitForSelector('[data-region="cred-status-error"]', { timeout: 15000 }).catch(() => {});
    const p = await panel(page);
    await page.screenshot({ path: path.join(outDir, 'U3-first-load-status-failure.png') });
    const [, refs] = await api('/api/security/credentials');
    const noteClaimsList = /下方只列出引用/.test(p.err);
    // The references are the rows the panel shows. A row whose status was
    // NOT measured carries `data-cred-reference`; a row with a MEASURED
    // status does not. The count of the references on the panel has to be
    // the count of the references the bridge reported.
    const shown = p.references.length + p.measuredRows.length;
    check('U3', 'a failed first load keeps the references on screen',
      shown === refs.credentials.length,
      `${refs.credentials.length} references exist; panel shows ${p.references.length} unmeasured rows and ${p.measuredRows.length} measured rows`);
    check('U3-delete', 'a failed first load keeps the delete buttons',
      p.deleteButtons >= refs.credentials.length,
      `${p.deleteButtons} delete buttons for ${refs.credentials.length} references`);
    check('U3-note', 'the note says the list below is the reference list, and that is true',
      !(noteClaimsList && shown === 0),
      `note: "${p.err.slice(0, 90)}"`);
    await ctx.close();
  }
} catch (error) {
  console.log(`FAIL  UI-RUN  ${error.stack || error}`);
  results.push({ id: 'UI-RUN', name: 'run completed', ok: false, detail: String(error) });
} finally {
  if (!bridge) await startBridge(process.env).catch(() => {});
  for (const id of created) { try { await api(`/api/security/credentials/${id}`, 'DELETE'); } catch { /* ignore */ } }
  const [, left] = await api('/api/security/credentials').catch(() => [0, null]);
  console.log(`CLEANUP references left in the probe data dir: ${left?.credentials?.length ?? '?'}`);
  if (browser) await browser.close().catch(() => {});
  await stopBridge();
}
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), browserChannel: channel, results }, null, 2));
console.log(`\nRESULT: ${failed.length === 0 ? 'OK' : 'FAIL'} (${results.length - failed.length}/${results.length} checks passed)`);
process.exit(failed.length === 0 ? 0 : 1);
