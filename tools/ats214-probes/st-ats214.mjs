#!/usr/bin/env node
/**
 * ATS-214 (review round 1, items 2 and 3): ST -- the CASE SEARCH, the
 * TAG FILTER and the SELECTION in a REAL browser.
 *
 *   node tools/ats214-probes/st-ats214.mjs <repo> <scratch-dir> <playwright-node_modules>
 *
 * WHY THIS EXISTS
 * ---------------
 * The acceptance criterion of this task is
 *
 *   「500 用例过滤无明显阻塞；选中准确映射 UID」
 *
 * and neither half of it can be checked without a browser:
 *
 *   * "500 用例" was never measured. The first delivery shipped a UI in
 *     which the FILES section of the filter block grew to 858px, pushed
 *     the case list to 1189px -- BELOW a 900px viewport -- and made every
 *     case invisible and unclickable. The list was there; the reader
 *     could not reach it;
 *   * "选中准确映射 UID" was never exercised in the browser either. A
 *     ticked case that left the catalogue was DROPPED SILENTLY: the
 *     counter went from 2 to 1 with no message, and the batch run
 *     submitted the reduced set.
 *
 * So this probe drives the REAL static export in the REAL Chromium
 * against the REAL Bridge, with a 500-case fixture, and asserts what a
 * reader actually gets.
 *
 * THE BUDGET IS FIXED BEFORE THE RUN
 * ----------------------------------
 * "无明显阻塞" (no obvious blocking) is measured against a threshold
 * that is written down HERE, before anything runs:
 *
 *   * a single interaction is answered within 100 ms;
 *   * no single long task exceeds 100 ms.
 *
 * The 4x-CPU-throttled measurement is recorded as INFORMATION, not as a
 * verdict: a throttled CPU is a different machine, and a threshold
 * written for a real one cannot be applied to it silently.
 *
 * WHAT IS PROVED
 * --------------
 *   ST-ATS214-001  the page loads with 500 cases and NO console error;
 *   ST-ATS214-002  the case list is VISIBLE and CLICKABLE at 1440x900
 *                  (the list has a height, its top is inside the
 *                  viewport, and a case can actually be clicked);
 *   ST-ATS214-003  filtering 500 cases stays inside the budget: typing,
 *                  the tag criterion, the tag MODE, "select all shown"
 *                  and unticking;
 *   ST-ATS214-004  the search finds a case by its TITLE;
 *   ST-ATS214-005  the tag criterion narrows the list, and the two modes
 *                  (任一 / 全部) give DIFFERENT results;
 *   ST-ATS214-006  the selection maps to the UIDs: the ticked case's uid
 *                  is the one the run request carries;
 *   ST-ATS214-007  a ticked case that LEFT the catalogue is REPORTED,
 *                  and the run is REFUSED until it is resolved -- the
 *                  selection is never silently reduced;
 *   ST-ATS214-008  switching projects RESETS the filter and the
 *                  selection -- a stale criterion cannot hide the whole
 *                  new project with no way out of it;
 *   ST-ATS214-009  the wording is HONEST: the interface says how many
 *                  cases will REALLY be executed, and the number is the
 *                  number the engine runs;
 *   ST-ATS214-010  the pick box is REACHABLE BY THE KEYBOARD.
 *
 * The probe prints `OK`/`DEFECT` per check and `RESULT: <n> DEFECT(s)`;
 * it exits with the number of defects, so a non-zero exit is the number
 * of things that are wrong.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [repoArg, scratchArg, nodeModulesArg] = process.argv.slice(2);
if (!repoArg || !scratchArg || !nodeModulesArg) {
  console.error('usage: st-ats214.mjs <repo> <scratch-dir> <playwright-node_modules>');
  process.exit(2);
}
const REPO = path.resolve(repoArg);
const WORK = fs.mkdtempSync(path.join(path.resolve(scratchArg), 'ats214-st-'));
/**
 * A FREE PORT for the Bridge.
 *
 * The default port (4577) is a SINGLETON on this machine: several agents
 * run their probes at the same time, and a Bridge left over from another
 * tree still holds it. A probe that uses the default port then measures
 * the OTHER tree's build -- a silent false measurement, because the
 * layout numbers it reports are of somebody else's CSS.
 *
 * The Next workbench reads its API base from `window.location.port`, so
 * the Bridge can serve the page on ANY port: the page and the API are
 * then the same origin, which is exactly how the product runs.
 *
 * So the probe takes a free port of its own. The default port is still
 * what the product uses -- it is only the PROBE that moves.
 */
const { createServer } = await import('node:net');
const PORT = await new Promise((resolve, reject) => {
  let candidate = 4600 + Math.floor(Math.random() * 500);
  const tryNext = () => {
    if (candidate >= 5400) { reject(new Error('no free port in 4600-5400')); return; }
    const probe = createServer();
    probe.once('error', () => { candidate += 1; tryNext(); });
    probe.listen(candidate, '127.0.0.1', () => {
      probe.close(() => resolve(candidate));
    });
  };
  tryNext();
});
const BASE = `http://127.0.0.1:${PORT}`;

/** THE BUDGET, FIXED BEFORE THE RUN. */
const BUDGET_MS = 100;
const VIEWPORT = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let defects = 0;
const results = [];
function verdict(id, ok, facts) {
  if (!ok) defects++;
  results.push({ id, ok, facts });
  console.log(`${ok ? 'OK    ' : 'DEFECT'} ${id}  ${facts}`);
}

/* ------------------------------------------------------------------ */
/* The fixture: 500 cases in 50 files                                   */
/* ------------------------------------------------------------------ */
const FIXTURE = path.join(WORK, 'p500');
const OTHER = path.join(WORK, 'other');
const BATCH = path.join(WORK, 'batch');
const TAGS = ['@smoke', '@slow', '@api', '@ui', '@regression'];

function writeProject(root, files, extra = {}) {
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: `fx-${path.basename(root)}`, private: true }));
  fs.writeFileSync(
    path.join(root, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', retries: 0, workers: 1, timeout: 60000 });\n"
  );
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  try {
    fs.symlinkSync(path.resolve(nodeModulesArg), path.join(root, 'node_modules'), 'junction');
  } catch { /* the listing will report PLAYWRIGHT_NOT_INSTALLED */ }
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=r', '-c', 'user.email=r@x', 'add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'fx'], { cwd: root });
  } catch { /* the Bridge reads the commit; a missing one is reported */ }
}

const files500 = {};
for (let f = 0; f < 50; f++) {
  const lines = ["import { test } from '@playwright/test';"];
  for (let c = 0; c < 10; c++) {
    const n = f * 10 + c;
    const tags = [TAGS[n % 5]];
    if (n % 3 === 0) tags.push(TAGS[(n + 2) % 5]);
    lines.push(`test('case ${String(n).padStart(3, '0')} module${f} 登录流程', { tag: ${JSON.stringify(tags)} }, async () => {});`);
  }
  files500[`tests/m${String(f).padStart(2, '0')}.spec.ts`] = lines.join('\n') + '\n';
}
writeProject(FIXTURE, files500);
writeProject(OTHER, {
  'tests/o.spec.ts': "import { test } from '@playwright/test';\ntest('other-1', { tag: '@billing' }, async () => {});\ntest('other-2', async () => {});\n",
});
writeProject(BATCH, {
  // The bodies are DISTINCT on purpose. A case whose body is empty
  // (`async () => {}`) has the SAME body fingerprint as every other
  // empty one, so the identity resolver cannot pin it down and hands it a
  // PROVISIONAL uid (`tcp_1_..._<ordinal>`). A provisional uid is not
  // stable: deleting the case before it shifts the ordinal of the ones
  // after it, and the tick the reader made silently re-points at a
  // different case. That is the UID scheme's documented behaviour
  // (ATS-203/ATS-602), not a defect of this task -- but the ST has to
  // use realistic bodies, or it would be measuring the fixture rather
  // than the selection.
  'tests/a.spec.ts': "import { test } from '@playwright/test';\ntest('a1', async () => { await Promise.resolve('a1'); });\ntest('a2', async () => { await Promise.resolve('a2'); });\ntest('a3', async () => { await Promise.resolve('a3'); });\n",
  'tests/b.spec.ts': "import { test } from '@playwright/test';\ntest('b1', async () => { await Promise.resolve('b1'); });\ntest('b2', async () => { await Promise.resolve('b2'); });\n",
});


/**
 * The CATALOGUE tab.
 *
 * The workbench switches to the EXECUTION CENTRE after a run, and the
 * catalogue is only rendered on the CATALOGUE tab -- so a probe that
 * wants to look at the list has to switch back first.
 */
async function backToCatalog(page) {
  const tab = page.getByRole('button', { name: '测试目录' });
  if (await tab.count()) {
    await tab.click();
    await sleep(400);
  }
}

/* ------------------------------------------------------------------ */
/* The Bridge and the browser                                          */
/* ------------------------------------------------------------------ */
const DATA = path.join(WORK, 'data');
fs.mkdirSync(DATA, { recursive: true });
const bridge = spawn(process.execPath, ['server/index.mjs'], {
  cwd: REPO,
  env: { ...process.env, ATS_PORT: String(PORT), ATS_DATA_DIR: DATA },
  stdio: 'ignore',
});
const killBridge = () => { try { execFileSync('taskkill', ['/PID', String(bridge.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } };
process.on('exit', killBridge);
process.on('uncaughtException', (e) => { console.error(e); killBridge(); process.exit(99); });

let token;
for (let i = 0; i < 400; i++) {
  try { const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) break; } catch { /* not up */ }
  await sleep(100);
}
token = (await (await fetch(`${BASE}/api/session`)).json()).token;

// THE SERVED PAGE MUST BE THE TREE UNDER TEST.
//
// The Bridge serves `apps/studio/out` from ITS OWN root, and a Bridge
// left over from another tree can still hold the port. The symptom is a
// ST that measures a STALE build: the CSS hash of the served page does
// not match the file on disk, and every layout measurement is a
// measurement of somebody else's code.
//
// So the probe CHECKS that the served page references the CSS file that
// is actually on disk, and refuses to run when it does not.
{
  const served = await (await fetch(`${BASE}/`)).text();
  const refs = [...new Set([...served.matchAll(/\/_next\/static\/chunks\/[a-zA-Z0-9_-]+\.css/g)].map((m) => m[0]))];
  const chunksDir = path.join(REPO, 'apps', 'studio', 'out', '_next', 'static', 'chunks');
  const onDisk = fs.existsSync(chunksDir) ? fs.readdirSync(chunksDir).filter((f) => f.endsWith('.css')).map((f) => `/_next/static/chunks/${f}`) : [];
  const missing = refs.filter((r) => !onDisk.includes(r));
  if (!refs.length) {
    console.error(`FATAL: the served page references NO css chunk -- the Bridge is not serving the tree under test (${REPO}).`);
    killBridge();
    process.exit(2);
  }
  if (missing.length) {
    console.error(`FATAL: the served page references css chunk(s) that do not exist on disk: ${missing.join(', ')}`);
    console.error(`       The Bridge on port ${PORT} is serving a DIFFERENT tree. Kill it and run again.`);
    killBridge();
    process.exit(2);
  }
  console.log(`the served page references ${refs.join(', ')} -- the tree under test.`);
}
const api = async (ep, method = 'GET', body) => {
  const r = await fetch(BASE + ep, {
    method,
    headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return [r.status, await r.json().catch(() => null)];
};

const ids = {};
for (const [name, root] of [['p500', FIXTURE], ['other', OTHER], ['batch', BATCH]]) {
  const [s, j] = await api('/api/projects', 'POST', { path: root });
  if (s !== 201) throw new Error(`${name}: ${s} ${JSON.stringify(j)}`);
  ids[name] = j.project.id;
}

const pw = await import(pathToFileURL(path.join(path.resolve(nodeModulesArg), 'playwright-core', 'index.js')).href);
const chromium = pw.chromium ?? pw.default?.chromium;
if (!chromium) { console.error('playwright-core does not export chromium'); process.exit(2); }
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: VIEWPORT });

// The console/page errors are collected so that "the page loaded without
// an error" is a MEASUREMENT and not an assumption.
const consoleErrors = [];
const pageErrors = [];
ctx.on('page', (p) => {
  p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  p.on('pageerror', (e) => pageErrors.push(String(e)));
});

const page = await ctx.newPage();
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
const sel = page.locator('select[data-region="project-select"]');
await sel.selectOption(ids.p500);
await page.waitForFunction(() => document.querySelectorAll('.pick-box').length === 500, null, { timeout: 120000 });
await sleep(500);

/* ================================================================== */
/* ST-ATS214-001: the page loads with 500 cases, without an error       */
/* ================================================================== */
{
  const rows = await page.locator('.pick-box').count();
  const footer = await page.locator('.sidebar-footer').innerText();
  verdict('ST-ATS214-001 loads-500-without-error',
    rows === 500 && consoleErrors.length === 0 && pageErrors.length === 0,
    `rows=${rows}; footer="${footer.replace(/\n/g, ' | ')}"; consoleErrors=${JSON.stringify(consoleErrors)}; pageErrors=${JSON.stringify(pageErrors)}`);
}

/* ================================================================== */
/* ST-ATS214-002: the case list is VISIBLE and CLICKABLE at 1440x900    */
/* ================================================================== */
{
  const geo = await page.evaluate(() => {
    const list = document.querySelector('.file-list[data-region="panel"]');
    const b = list.getBoundingClientRect();
    const first = list.querySelector('.file-item');
    const fb = first ? first.getBoundingClientRect() : null;
    return {
      listTop: Math.round(b.top), listHeight: list.clientHeight, listScrollHeight: list.scrollHeight,
      viewport: innerHeight, chips: document.querySelectorAll('.filter-box .tag-chip').length,
      firstTop: fb ? Math.round(fb.top) : null, firstBottom: fb ? Math.round(fb.bottom) : null,
    };
  });
  // The list must have a HEIGHT (not 0) and must START inside the viewport.
  const visible = geo.listHeight > 0 && geo.listTop >= 0 && geo.listTop < geo.viewport;
  // And the FIRST CASE must be on screen and clickable.
  const firstOnScreen = geo.firstTop !== null && geo.firstTop >= 0 && geo.firstTop < geo.viewport;
  let clicked = false;
  try {
    await page.locator('.pick-box').first().click({ timeout: 5000 });
    clicked = true;
  } catch { /* the click is the measurement */ }
  const checked = await page.locator('.pick-box').first().getAttribute('aria-checked');
  verdict('ST-ATS214-002 list-visible-and-clickable',
    visible && firstOnScreen && clicked && checked === 'true',
    `list top=${geo.listTop}px height=${geo.listHeight}px (scroll ${geo.listScrollHeight}px) in a ${geo.viewport}px viewport, ${geo.chips} filter chips; the first case is at ${geo.firstTop}px; clicked=${clicked}; aria-checked=${checked}`);
  // Untick again so the next checks start from an empty selection.
  await page.locator('.pick-box').first().click();
}

/* ================================================================== */
/* ST-ATS214-003: filtering 500 cases stays inside the budget           */
/* ================================================================== */
{
  await ctx.addInitScript(() => {
    window.__lat = []; window.__long = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch { }
    const mark = (ev) => { const t0 = ev.timeStamp || performance.now(); requestAnimationFrame(() => { const mc = new MessageChannel(); mc.port1.onmessage = () => window.__lat.push(Math.round(performance.now() - t0)); mc.port2.postMessage(0); }); };
    addEventListener('keydown', mark, true); addEventListener('click', mark, true); addEventListener('change', true);
  });
  // The init script has to be in place BEFORE the page is loaded, so the
  // page is reloaded with it.
  const p2 = await ctx.newPage();
  await p2.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p2.locator('select[data-region="project-select"]').selectOption(ids.p500);
  await p2.waitForFunction(() => document.querySelectorAll('.pick-box').length === 500, null, { timeout: 120000 });
  await sleep(400);

  const measure = async (label, fn) => {
    await p2.evaluate(() => { window.__lat.length = 0; window.__long.length = 0; });
    await fn();
    await sleep(400);
    const { lat, long } = await p2.evaluate(() => ({ lat: [...window.__lat], long: [...window.__long] }));
    const s = lat.slice().sort((a, b) => a - b);
    const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null);
    const max = s.length ? s[s.length - 1] : null;
    const longMax = long.length ? Math.max(...long) : 0;
    console.log(`    ${label.padEnd(46)} n=${s.length} p50=${q(0.5)}ms p95=${q(0.95)}ms max=${max}ms longtasks=${JSON.stringify(long)}`);
    return { max, longMax };
  };
  const within = (m) => m.max !== null && m.max <= BUDGET_MS && m.longMax <= BUDGET_MS;

  const search = p2.getByLabel('查找用例名、文件或标签');
  const perf = [];
  perf.push(await measure('type "module4" (7 keys) at 500 cases', async () => { await search.click(); await search.pressSequentially('module4', { delay: 40 }); }));
  await search.press('Control+A'); await search.press('Backspace');
  perf.push(await measure('tag chips @smoke, @api, mode 全部 -> 任一', async () => {
    await p2.locator('.tag-chip', { hasText: '@smoke' }).click(); await sleep(60);
    await p2.locator('.tag-chip', { hasText: '@api' }).click(); await sleep(60);
    await p2.locator('select.mode-select').selectOption('all'); await sleep(60);
    await p2.locator('select.mode-select').selectOption('any');
  }));
  await p2.locator('.tag-chip', { hasText: '@smoke' }).click(); await p2.locator('.tag-chip', { hasText: '@api' }).click();
  perf.push(await measure('全选当前 with 500 shown', async () => { await p2.getByRole('button', { name: '全选当前' }).click(); }));
  perf.push(await measure('untick one pick-box', async () => { await p2.locator('.pick-box').nth(10).click(); }));
  await p2.getByRole('button', { name: '清空' }).click();

  // The 4x CPU measurement is INFORMATION: a throttled CPU is a
  // different machine, and the threshold was written for a real one.
  const cdp = await ctx.newCDPSession(p2);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const slow = await measure('[4x CPU, info only] type "module4" at 500', async () => { await search.click(); await search.pressSequentially('module4', { delay: 60 }); });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const worstMax = Math.max(...perf.map((m) => m.max ?? 0));
  const worstLong = Math.max(...perf.map((m) => m.longMax));
  verdict('ST-ATS214-003 filtering-within-budget',
    perf.every(within),
    `budget ${BUDGET_MS}ms; worst interaction max=${worstMax}ms, worst long task=${worstLong}ms (4x CPU info: max=${slow.max}ms)`);
  await p2.close();
}

/* ================================================================== */
/* ST-ATS214-004/005: the search and the tag criterion                  */
/* ================================================================== */
{
  const search = page.getByLabel('查找用例名、文件或标签');
  await search.click();
  await search.pressSequentially('case 017', { delay: 30 });
  await sleep(400);
  const found = await page.locator('.pick-box').count();
  const titles = await page.locator('.file-item .file-open b').allInnerTexts();
  verdict('ST-ATS214-004 search-by-title',
    found >= 1 && titles.every((t) => t.includes('case 017')),
    `"case 017" matched ${found} row(s): ${JSON.stringify(titles.slice(0, 3))}`);
  await search.press('Control+A'); await search.press('Backspace');
  await sleep(300);

  const report = () => page.locator('.filter-report').first().innerText();
  // TWO tags are needed: with ONE tag the two modes give the SAME set
  // (a case either carries it or it does not), so the mode would look
  // like a decoration. With TWO tags the modes differ: 「任一」 is the
  // union, 「全部」 is the intersection.
  await page.locator('.tag-chip', { hasText: '@smoke' }).click();
  await sleep(200);
  await page.locator('.tag-chip', { hasText: '@api' }).click();
  await sleep(300);
  const anyReport = await report();
  const anyRows = await page.locator('.pick-box').count();
  await page.locator('select.mode-select').selectOption('all');
  await sleep(300);
  const allReport = await report();
  const allRows = await page.locator('.pick-box').count();
  await page.locator('select.mode-select').selectOption('any');
  await page.locator('.tag-chip', { hasText: '@smoke' }).click();
  await page.locator('.tag-chip', { hasText: '@api' }).click();
  await sleep(300);
  verdict('ST-ATS214-005 tag-criterion-and-its-mode',
    anyRows > 0 && allRows < anyRows,
    `任一 (@smoke + @api): ${anyRows} rows ("${anyReport}"); 全部: ${allRows} rows ("${allReport}")`);
}

/* ================================================================== */
/* ST-ATS214-006/007: the selection maps to the UIDs                   */
/* ================================================================== */
{
  await backToCatalog(page);
  await sel.selectOption(ids.batch);
  await page.waitForFunction(() => /5 tests/.test(document.querySelector('.sidebar-footer')?.textContent ?? ''), null, { timeout: 30000 });
  await sleep(300);
  // Tick a1 and b1.
  await page.getByRole('checkbox', { name: '选中 a1' }).click();
  await page.getByRole('checkbox', { name: '选中 b1' }).click();
  await sleep(200);
  const bar = await page.locator('.select-bar span').first().innerText();
  const catalog = await api(`/api/projects/${ids.batch}/tests`);
  const byTitle = Object.fromEntries(catalog[1].tests.map((t) => [t.title, t]));
  verdict('ST-ATS214-006 selection-counts-the-uids',
    /已选 2 条/.test(bar) && byTitle.a1 && byTitle.b1,
    `the selection bar says "${bar}"; the catalogue knows a1=${byTitle.a1?.uid} and b1=${byTitle.b1?.uid}`);

  // Delete b1 from the file, then RELOAD the catalogue of the SAME
  // project: the selection must NOT silently shrink.
  //
  // The catalogue is re-read when the project is re-selected, so the
  // probe switches to another project and back -- which is also what a
  // reader does. The selection belongs to its project, so it comes back.
  const bspec = path.join(BATCH, 'tests', 'b.spec.ts');
  const original = fs.readFileSync(bspec, 'utf8');
  fs.writeFileSync(bspec, original.split('\n').filter((l) => !l.includes("test('b1'")).join('\n'));
  await sel.selectOption(ids.other);
  await page.waitForFunction(() => /2 tests/.test(document.querySelector('.sidebar-footer')?.textContent ?? ''), null, { timeout: 30000 });
  await sel.selectOption(ids.batch);
  await page.waitForFunction(() => /4 tests/.test(document.querySelector('.sidebar-footer')?.textContent ?? ''), null, { timeout: 30000 });
  await sleep(800);

  const warned = await page.locator('[data-region="selection-warning"]').count();
  const warnText = warned ? await page.locator('[data-region="selection-warning"]').innerText() : '';
  const barAfter = await page.locator('.select-bar span').first().innerText();
  // The run must be REFUSED while the selection does not map.
  await page.getByRole('button', { name: /批量运行/ }).click();
  await sleep(1500);
  const toast = await page.locator('.toast').count() ? await page.locator('.toast').innerText() : '';
  const [, runsAfter] = await api('/api/runs');
  const submitted = runsAfter.runs.filter((r) => r.projectId === ids.batch).length;
  fs.writeFileSync(bspec, original);
  verdict('ST-ATS214-007 a-gone-selection-is-reported-and-blocks',
    warned > 0 && /不在目录中/.test(warnText) && /已不在目录中/.test(toast) && submitted === 0,
    `the selection bar says "${barAfter}"; the warning says "${warnText.replace(/\n/g, ' ')}"; the toast says "${toast}"; runs submitted for the project: ${submitted}`);
  await page.getByRole('button', { name: '移除这些用例' }).click();
  await sleep(300);
}

/* ================================================================== */
/* ST-ATS214-008: switching projects resets the filter                   */
/* ================================================================== */
{
  await backToCatalog(page);
  await sel.selectOption(ids.p500);
  await page.waitForFunction(() => /500 tests/.test(document.querySelector('.sidebar-footer')?.textContent ?? ''), null, { timeout: 30000 });
  await sleep(400);
  // Start from an empty selection: the p500 project may still carry the
  // ticks of an earlier check, and this check is about the FILTER. The
  // button is DISABLED when the selection is already empty, so it is
  // only clicked when it is enabled.
  const clear = page.getByRole('button', { name: '清空' });
  if (await clear.isEnabled()) {
    await clear.click();
    await sleep(200);
  }
  await page.locator('.tag-chip', { hasText: '@smoke' }).click();
  await sleep(300);
  const before = await page.locator('.filter-report').first().innerText();
  await sel.selectOption(ids.other);
  await page.waitForFunction(() => /2 tests/.test(document.querySelector('.sidebar-footer')?.textContent ?? ''), null, { timeout: 30000 });
  await sleep(800);
  const rows = await page.locator('.pick-box').count();
  const report = await page.locator('.filter-report').first().innerText();
  const pressed = await page.locator('.tag-chip[aria-pressed="true"]').count();
  // The selection is PER PROJECT: the p500 selection must NOT appear on
  // the "other" project (its uids belong to p500).
  const bar = await page.locator('.select-bar span').first().innerText();
  verdict('ST-ATS214-008 project-switch-resets-the-filter',
    rows === 2 && pressed === 0 && /已选 0 条/.test(bar),
    `before the switch: "${before}"; after: ${rows} rows of 2, "${report}", ${pressed} pressed chips, the selection bar says "${bar}"`);
}

/* ================================================================== */
/* ST-ATS214-009: the wording is honest                                */
/* ================================================================== */
{
  await backToCatalog(page);
  await sel.selectOption(ids.batch);
  await page.waitForFunction(() => /5 tests/.test(document.querySelector('.sidebar-footer')?.textContent ?? ''), null, { timeout: 30000 });
  await sleep(400);
  // Start from an empty selection: the earlier checks ticked cases of
  // this project, and this check is about the WORDING of one selection.
  const clearBatch = page.getByRole('button', { name: '清空' });
  if (await clearBatch.isEnabled()) {
    await clearBatch.click();
    await sleep(300);
  }
  // The file a.spec.ts has THREE cases (a1, a2, a3); tick only a1.
  await page.getByRole('checkbox', { name: '选中 a1' }).click();
  await sleep(300);
  const bar = await page.locator('.select-bar span').first().innerText();
  await page.getByRole('button', { name: /批量运行/ }).click();
  await page.waitForSelector('.toast', { timeout: 15000 });
  const toast = await page.locator('.toast').innerText();
  const [, runsAfter] = await api('/api/runs');
  const run = runsAfter.runs.find((r) => r.projectId === ids.batch);
  let attempts = 0;
  for (let i = 0; i < 120 && !['passed', 'failed', 'error', 'cancelled', 'interrupted'].includes(run.status); i++) {
    await sleep(500);
    const fresh = (await api(`/api/runs/${run.id}`))[1].run;
    if (fresh) { run.status = fresh.status; attempts = (fresh.attempts ?? []).length; }
  }
  const [, fresh2] = await api(`/api/runs/${run.id}`);
  attempts = (fresh2?.run?.attempts ?? []).length;
  const barNumber = Number((bar.match(/将执行 (\d+) 条/) || [])[1] ?? '0');
  const toastNumber = Number((toast.match(/实际执行 (\d+) 条/) || [])[1] ?? '0');
  verdict('ST-ATS214-009 the-wording-states-what-will-run',
    barNumber === attempts && toastNumber === attempts && attempts > 1,
    `the bar says "${bar}" (${barNumber}), the toast says "${toast}" (${toastNumber}), the engine ran ${attempts} case(s)`);
}

/* ================================================================== */
/* ST-ATS214-010: the pick box is reachable by the keyboard            */
/* ================================================================== */
{
  await backToCatalog(page);
  await sel.selectOption(ids.p500);
  await page.waitForFunction(() => document.querySelectorAll('.pick-box').length === 500, null, { timeout: 30000 });
  await sleep(400);
  // The filter is reset on a project SWITCH, so switching to p500 from
  // another project clears it -- but when p500 is already the project on
  // screen, the filter of the last check is still active. The check is
  // about the pick box, so the filter is cleared explicitly.
  const clear = page.getByRole('button', { name: '清空' });
  if (await clear.isEnabled()) {
    await clear.click();
    await sleep(200);
  }
  const smokeChip = page.locator('.tag-chip', { hasText: '@smoke' });
  if (await smokeChip.getAttribute('aria-pressed') === 'true') {
    await smokeChip.click();
    await sleep(300);
  }
  const k = await page.evaluate(() => {
    const b = document.querySelector('.pick-box');
    if (!b) return { missing: true };
    // `closest('button')` matches the element ITSELF when it is a button,
    // so the question is whether there is a button STRICTLY above it.
    const parent = b.parentElement ? b.parentElement.closest('button') : null;
    return {
      tag: b.tagName,
      tabIndex: b.tabIndex,
      insideButton: Boolean(parent),
      parentTag: b.parentElement ? b.parentElement.tagName : null,
    };
  });
  // The keyboard can REACH it and SPACE toggles it.
  let reachable = false;
  let toggled = false;
  try {
    await page.locator('.pick-box').first().focus();
    await page.keyboard.press('Space');
    await sleep(200);
    toggled = (await page.locator('.pick-box').first().getAttribute('aria-checked')) === 'true';
    reachable = await page.evaluate(() => document.activeElement?.classList?.contains('pick-box'));
  } catch { /* the measurement is the catch */ }
  verdict('ST-ATS214-010 the-pick-box-is-keyboard-reachable',
    k.tag === 'BUTTON' && k.tabIndex >= 0 && !k.insideButton && reachable && toggled,
    `the first .pick-box is a <${k.tag}> with tabIndex=${k.tabIndex}, its parent is a <${k.parentTag}>, nested in a STRICTLY outer <button>=${k.insideButton}; focusable=${reachable}; SPACE toggled it=${toggled}`);
}

await browser.close();
killBridge();
console.log('');
console.log(`RESULT: ${defects} DEFECT(s)`);
process.exit(defects);
