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
 *   BC-6  no console error and no page error on either UI.
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

/* --- the project: the sample fixture (one passing, one failing case) --- */
const project = path.join(scratch, 'sample-playwright');
fs.cpSync(path.join(repo, 'examples', 'sample-playwright'), project,
  { recursive: true, filter: (src) => !src.includes('node_modules') });
fs.symlinkSync(path.resolve(nodeModulesArg), path.join(project, 'node_modules'), 'junction');

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

  /* --- a REAL run, so the UIs have something to show ------------------- */
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

  const browser = await chromium.launch();
  const origin = `http://127.0.0.1:${b.port}`;

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
  for (const cp of bridges) await killTree(cp);
  console.log(`scratch: ${scratch}`);
  console.log(`RESULT: ${passed}/${total}`);
  process.exitCode = passed === total ? 0 : 1;
}
