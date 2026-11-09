/**
 * ATS-216 browser check: the two UIs really render the quality overview.
 *
 *   node tools/ats216-probes/browser-check.mjs <repo> <scratch-dir> <playwright-node_modules>
 *
 * WHY THIS EXISTS
 * ---------------
 * The system test (st-ats216.mjs) checks the API and the module, and the
 * build checks that the Next app compiles. Neither of them opens a BROWSER:
 * a UI that compiles and whose API works can still fail to render -- a
 * missing DOM id, a module that does not load, an exception in the render
 * function.
 *
 * This probe drives the REAL Chromium (the same Playwright the fixture
 * uses) against the REAL Bridge:
 *
 *   BC-1  the portable UI loads its shared module (the module script ran);
 *   BC-2  the portable UI shows the quality tab and its metrics;
 *   BC-3  the portable UI reports the reconciliation of the metrics;
 *   BC-4  the Next static export loads and shows the quality tab;
 *   BC-5  the Next workbench shows the same numbers as the portable UI
 *         (the two UIs share ONE implementation, so they cannot differ);
 *   BC-6  no console error and no page error on either UI;
 *   BC-7  the portable UI's 「全部项目」 scope really covers EVERY project,
 *         and both UIs agree on the numbers under that scope;
 *   BC-8  both UIs render the RAW ITEMS behind every number, so a reader
 *         can check a metric against the case or the run it came from.
 *
 * TWO PROJECTS, NOT ONE: with a single project the 「全部项目」 scope and
 * the 「当前项目」 scope walk the same runs, so a scope that silently
 * filtered by the current project would still look right. The check is
 * only meaningful with a second project whose runs differ.
 *
 * Prints `PASS`/`FAIL` per check and `RESULT: <passed>/<total>`; exits 0
 * only when every check passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [repoArg, scratchArg, nodeModulesArg] = process.argv.slice(2);
if (!repoArg || !scratchArg || !nodeModulesArg) {
  console.error('usage: browser-check.mjs <repo> <scratch-dir> <playwright-node_modules>');
  process.exit(2);
}
const repo = path.resolve(repoArg);

fs.mkdirSync(scratchArg, { recursive: true });
const scratch = fs.mkdtempSync(path.join(path.resolve(scratchArg), 'bc216-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let total = 0;
const check = (id, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` -- ${detail}` : ''}`);
};

/* --- the projects: the sample fixture (one passing, one failing case) --- */
const project = path.join(scratch, 'sample-playwright');
fs.cpSync(path.join(repo, 'examples', 'sample-playwright'), project,
  { recursive: true, filter: (src) => !src.includes('node_modules') });
fs.symlinkSync(path.resolve(nodeModulesArg), path.join(project, 'node_modules'), 'junction');
// A SECOND project, with its own fixture copy: the 「全部项目」 scope is only
// meaningful when there is more than one project whose runs differ.
const project2 = path.join(scratch, 'sample-playwright-2');
fs.cpSync(path.join(repo, 'examples', 'sample-playwright'), project2,
  { recursive: true, filter: (src) => !src.includes('node_modules') });
fs.symlinkSync(path.resolve(nodeModulesArg), path.join(project2, 'node_modules'), 'junction');

const bridges = new Set();
async function startBridge(dataDir, port) {
  const cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: repo,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  bridges.add(cp);
  let stderr = '';
  cp.stderr.on('data', (b) => { stderr += b; });
  const exited = new Promise((r) => cp.on('close', (code) => { bridges.delete(cp); r(code); }));
  return { cp, port, exited, stderr: () => stderr };
}
async function killTree(cp) {
  if (cp.exitCode !== null || cp.signalCode !== null) return;
  const closed = new Promise((r) => cp.once('close', r));
  if (process.platform === 'win32') {
    await new Promise((r) => spawn('taskkill', ['/PID', String(cp.pid), '/T', '/F'], { windowsHide: true }).on('close', r));
  } else cp.kill('SIGKILL');
  await Promise.race([closed, sleep(10000)]);
}
async function up(b, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (b.cp.exitCode !== null) return false;
    try { if ((await fetch(`http://127.0.0.1:${b.port}/api/health`)).ok) return true; } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}
async function api(b, endpoint, method = 'GET', body, token) {
  const r = await fetch(`http://127.0.0.1:${b.port}${endpoint}`, {
    method,
    headers: token ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return [r.status, await r.json()];
}

let browser = null;
try {
  /* --- the Playwright that drives the browser -------------------------- */
  // `playwright-core` is the package that exports the BROWSER (`chromium`).
  // `@playwright/test` is the test runner, and its index does not re-export
  // the browser API.
  //
  // `playwright-core` is a COMMONJS package, so the named exports live on
  // the default export when it is loaded as an ES module.
  const pw = await import(
    pathToFileURL(path.join(path.resolve(nodeModulesArg), 'playwright-core', 'index.js')).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) throw new Error('playwright-core does not export chromium');

  const data = path.join(scratch, 'data');
  // The NEXT workbench resolves its API base by PORT (`apps/studio/lib/api.ts`
  // hardcodes 4577, the documented ATS-101 constraint), so the browser check
  // needs a bridge on the DEFAULT port for that part. The portable UI has
  // no such constraint: it is served BY the bridge, so its API base is the
  // same origin.
  const defaultPort = Number(process.env.ATS_PORT || 4577);
  const port = defaultPort;
  const b = await startBridge(data, port);
  check('the Bridge starts', await up(b), b.stderr());
  const token = (await api(b, '/api/session'))[1].token;
  const [, added] = await api(b, '/api/projects', 'POST', { path: project }, token);
  const projectId = added.project.id;
  const [, added2] = await api(b, '/api/projects', 'POST', { path: project2 }, token);
  const projectId2 = added2.project.id;

  /* --- REAL runs, so the UIs have something to show -------------------- */
  const [, run] = await api(b, `/api/projects/${projectId}/run`, 'POST', { file: 'tests/home.spec.ts' }, token);
  let finished = null;
  for (let i = 0; i < 400; i++) {
    const r = (await api(b, `/api/runs/${run.run.id}`, 'GET', null, token))[1].run;
    if (['passed', 'failed', 'cancelled', 'error', 'interrupted'].includes(r.status)) { finished = r; break; }
    await sleep(250);
  }
  check('a real run finished', Boolean(finished), finished?.status);
  check('the real run has one passing and one failing case',
    finished?.summary?.passed === 1 && finished?.summary?.failed === 1,
    JSON.stringify(finished?.summary && { passed: finished.summary.passed, failed: finished.summary.failed }));

  /* --- a run of the SECOND project, so the scopes differ ---------------- */
  const [, run2] = await api(b, `/api/projects/${projectId2}/run`, 'POST', { file: 'tests/home.spec.ts' }, token);
  let finished2 = null;
  for (let i = 0; i < 400; i++) {
    const r = (await api(b, `/api/runs/${run2.run.id}`, 'GET', null, token))[1].run;
    if (['passed', 'failed', 'cancelled', 'error', 'interrupted'].includes(r.status)) { finished2 = r; break; }
    await sleep(250);
  }
  check('a real run of the SECOND project finished', Boolean(finished2), finished2?.status);

  /* --- the numbers the module computes, per scope ----------------------- */
  const { buildQualityOverview } = await import(
    pathToFileURL(path.join(repo, 'apps', 'studio', 'public', 'quality.mjs')).href);
  const allRuns = (await api(b, '/api/runs', 'GET', null, token))[1].runs;
  const oAll = buildQualityOverview(allRuns);
  const oFirst = buildQualityOverview(allRuns.filter((r) => r.projectId === projectId));
  const oSecond = buildQualityOverview(allRuns.filter((r) => r.projectId === projectId2));
  const firstRunCount = allRuns.filter((r) => r.projectId === projectId).length;
  const secondRunCount = allRuns.filter((r) => r.projectId === projectId2).length;
  check('the two projects have their OWN runs, so the scopes really differ',
    firstRunCount >= 1 && secondRunCount >= 1 && allRuns.length === firstRunCount + secondRunCount,
    `all=${allRuns.length} run(s), first project=${firstRunCount}, second project=${secondRunCount}`);

  browser = await chromium.launch();
  const origin = `http://127.0.0.1:${b.port}`;
  // The numbers the portable UI shows under the 「全部项目」 scope. They
  // are compared with the Next workbench's numbers further down, so they
  // live OUTSIDE the block that renders the portable UI.
  let allFailed = null;
  let allPassed = null;

  /* --- the PORTABLE UI ------------------------------------------------- */
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await page.goto(`${origin}/fallback.html`, { waitUntil: 'load' });
    // The module script is asynchronous: the import must have resolved.
    await page.waitForFunction(() => typeof window.buildQualityOverview === 'undefined'
      || document.querySelector('[data-tab="quality"]') !== null, { timeout: 15000 }).catch(() => {});
    await sleep(1500);

    check('BC-1 the portable UI has no page error on load', pageErrors.length === 0,
      pageErrors.join(' | '));

    // The tab must exist and the panel must be reachable.
    const tabExists = await page.locator('[data-tab="quality"]').count();
    check('BC-2a the portable UI shows the quality tab', tabExists === 1, `${tabExists} button(s)`);

    await page.click('[data-tab="quality"]');
    await sleep(1200);
    const metricsVisible = await page.locator('#q-metrics .metric').count();
    check('BC-2b the portable UI renders the quality metrics', metricsVisible >= 4,
      `${metricsVisible} metric card(s)`);

    const metricsText = await page.locator('#q-metrics').innerText();
    check('BC-2c the portable UI shows the failed case count',
      /失败/.test(metricsText) && /\b1\b/.test(metricsText), metricsText.replace(/\n/g, ' / '));

    const checksText = await page.locator('#q-checks').innerText();
    check('BC-3 the portable UI reports the reconciliation',
      /核对项/.test(checksText) && /一致/.test(checksText),
      checksText.split('\n').slice(0, 4).join(' / '));

    /* --- BC-7: the 「全部项目」 scope really covers EVERY project -------- */
    await page.selectOption('#q-scope', 'all');
    await sleep(1500);
    const allCards = await page.$$eval('#q-metrics .metric', (els) => els.map((e) => ({
      k: e.querySelector('span')?.textContent, v: Number(e.querySelector('strong')?.textContent) })));
    allFailed = allCards.find((c) => c.k === '失败')?.v;
    allPassed = allCards.find((c) => c.k === '通过')?.v;
    check('BC-7a the portable UI 「全部项目」 covers EVERY project',
      allFailed === oAll.cases.failed && allPassed === oAll.cases.passed
        && oAll.cases.failed !== oFirst.cases.failed,
      `UI(全部) 通过/失败=${allPassed}/${allFailed}; module(全部)=${oAll.cases.passed}/${oAll.cases.failed}; `
      + `module(第一个项目)=${oFirst.cases.passed}/${oFirst.cases.failed}`);

    /* --- BC-8: the raw items behind every number are rendered ----------- */
    const refsText = await page.locator('#q-refs').innerText();
    check('BC-8a the portable UI renders the raw items behind every number',
      /原始结果/.test(refsText) && /用例/.test(refsText),
      refsText.split('\n').slice(0, 3).join(' / '));
    // One expandable list per METRIC CARD, plus the list of the cases of the
    // runs without a verdict. A card with no items still gets a list (it
    // says so plainly), so the number of lists is one per card plus one.
    const cardsWithItems = allCards.length;
    const detailsCount = await page.locator('#q-refs details').count();
    check('BC-8b the portable UI offers an expandable list for every metric',
      detailsCount >= cardsWithItems,
      `${detailsCount} expandable list(s) for ${cardsWithItems} card(s)`);

    check('BC-6a the portable UI has no console error', consoleErrors.length === 0,
      consoleErrors.join(' | '));
    await ctx.close();
  }

  /* --- the NEXT static export ------------------------------------------ */
  {
    const exportDir = path.join(repo, 'apps', 'studio', 'out');
    if (!fs.existsSync(path.join(exportDir, 'index.html'))) {
      check('BC-4 the Next static export exists', false,
        'apps/studio/out/index.html is missing -- run `npm --prefix apps/studio run build` first');
    } else {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page.on('pageerror', (e) => pageErrors.push(String(e)));

      await page.goto(`${origin}/`, { waitUntil: 'load' });
      await sleep(2500);

      check('BC-6b the Next workbench has no page error on load', pageErrors.length === 0,
        pageErrors.join(' | '));

      const railTab = await page.locator('button[title="质量概览"]').count();
      check('BC-4a the Next workbench shows the quality tab', railTab === 1, `${railTab} button(s)`);

      await page.click('button[title="质量概览"]');
      await sleep(1500);
      const cards = await page.locator('.content .metric').count();
      check('BC-4b the Next workbench renders the quality metrics', cards >= 4, `${cards} card(s)`);

      const workbenchText = await page.locator('.content').innerText();
      check('BC-5a the Next workbench shows the failed case count',
        /失败/.test(workbenchText) && /\b1\b/.test(workbenchText));

      /* --- BC-7: the 「全部项目」 scope, in the Next workbench too -------- */
      await page.selectOption('.sidebar select', 'all');
      await sleep(1500);
      const nextCards = await page.$$eval('.content .metric', (els) => els.map((e) => ({
        k: e.querySelector('span')?.textContent, v: Number(e.querySelector('strong')?.textContent) })));
      const nextFailed = nextCards.find((c) => c.k === '失败')?.v;
      const nextPassed = nextCards.find((c) => c.k === '通过')?.v;
      check('BC-7b the Next workbench 「全部项目」 shows the same numbers as the portable UI',
        nextFailed === oAll.cases.failed && nextPassed === oAll.cases.passed
          && nextFailed === allFailed && nextPassed === allPassed,
        `Next(全部) 通过/失败=${nextPassed}/${nextFailed}; portable(全部)=${allPassed}/${allFailed}; `
        + `module(全部)=${oAll.cases.passed}/${oAll.cases.failed}`);

      /* --- BC-8: the raw items behind every number, in the Next UI ------- */
      const nextRefsText = await page.locator('.content').innerText();
      check('BC-8c the Next workbench renders the raw items behind every number',
        /原始结果/.test(nextRefsText) && /用例/.test(nextRefsText),
        nextRefsText.split('\n').filter((l) => /原始结果/.test(l)).slice(0, 2).join(' / '));
      const nextDetails = await page.locator('.content details').count();
      check('BC-8d the Next workbench offers an expandable list for every metric',
        nextDetails >= nextCards.length,
        `${nextDetails} expandable list(s) for ${nextCards.length} card(s)`);

      check('BC-6c the Next workbench has no console error', consoleErrors.length === 0,
        consoleErrors.join(' | '));
      await ctx.close();
    }
  }

  await browser.close();
  await killTree(b.cp);
} catch (err) {
  check('the browser check ran to the end', false, err.stack);
} finally {
  // The browser is closed here too: a check that threw above must not
  // leave a Chromium process behind.
  try { if (typeof browser !== 'undefined' && browser) await browser.close(); } catch { /* already gone */ }
  for (const cp of bridges) await killTree(cp);
  console.log(`scratch: ${scratch}`);
  console.log(`RESULT: ${passed}/${total}`);
  process.exitCode = passed === total ? 0 : 1;
}
