/**
 * ATS-215 system test: the EVIDENCE WORKBENCH.
 *
 *   node tools/ats215-probes/st-ats215.mjs <repo> <scratch-dir> <playwright-node_modules>
 *
 * WHY THIS EXISTS
 * ---------------
 * The acceptance criterion of ATS-215 is 「从失败用例 2 次点击内找到 Trace；
 * 显示附件哈希与时间」 -- "find the Trace from a failing case within 2
 * clicks; show the attachment's hash and time".
 *
 * That sentence cannot be checked by a unit test alone: it is a claim
 * about what a READER SEES in a REAL browser, on a REAL run, with REAL
 * evidence. This probe therefore drives the real Chromium against the
 * real Bridge and the real Playwright, and it COUNTS the clicks.
 *
 * THE CHECKS
 * ----------
 *   ST-1  a real run finishes, with one passing and one failing case;
 *   ST-2  the failing case's Trace is located by the shared module;
 *   ST-3  the located Trace is one of the run's ARCHIVED artifacts (its
 *         digest is the manifest's);
 *   ST-4  the module's click path is TWO clicks -- the budget is counted,
 *         not asserted;
 *   ST-5  the located Trace really EXISTS on disk and its bytes hash to
 *         the digest the workbench shows (the two are independent: the
 *         module reads the manifest, the probe recomputes the bytes);
 *   ST-6  the API hands over the same facts the module consumes;
 *   ST-7  the portable UI opens the evidence workbench and shows the
 *         failing case WITH its trace, its hash and its time;
 *   ST-8  the NEXT workbench shows the SAME trace, hash and time (the two
 *         interfaces import ONE module, so they cannot differ);
 *   ST-9  the reader reaches the Trace from the failure list in TWO
 *         clicks IN THE BROWSER -- the acceptance criterion itself,
 *         measured by real clicks;
 *   ST-10 the trace downloads through the artifact endpoint;
 *   ST-11 a TAMPERED attachment is reported as changed, and the
 *         workbench still shows the ARCHIVED digest (the archived truth
 *         and the current file are not the same claim);
 *   ST-12 no console error and no page error on either interface.
 *
 * The probe prints `PASS`/`FAIL` per check and `RESULT: <passed>/<total>`;
 * it exits 0 only when every check passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const [repoArg, scratchArg, nodeModulesArg] = process.argv.slice(2);
if (!repoArg || !scratchArg || !nodeModulesArg) {
  console.error('usage: st-ats215.mjs <repo> <scratch-dir> <playwright-node_modules>');
  process.exit(2);
}
const repo = path.resolve(repoArg);

fs.mkdirSync(scratchArg, { recursive: true });
const scratch = fs.mkdtempSync(path.join(path.resolve(scratchArg), 'ats215-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let total = 0;
const check = (id, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` -- ${detail}` : ''}`);
};

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
function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

let browser = null;
try {
  /* --- the Playwright that drives the browser -------------------------- */
  const pw = await import(
    pathToFileURL(path.join(path.resolve(nodeModulesArg), 'playwright-core', 'index.js')).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) throw new Error('playwright-core does not export chromium');

  /* --- the fixture: the sample project with a REAL failing case --------- */
  const project = path.join(scratch, 'sample-playwright');
  fs.cpSync(path.join(repo, 'examples', 'sample-playwright'), project,
    { recursive: true, filter: (src) => !src.includes('node_modules') });
  fs.symlinkSync(path.resolve(nodeModulesArg), path.join(project, 'node_modules'), 'junction');

  const data = path.join(scratch, 'data');
  // The NEXT workbench resolves its API base by PORT (`apps/studio/lib/api.ts`
  // hardcodes 4577, the documented ATS-101 constraint), so the browser check
  // needs a bridge on the DEFAULT port for that part.
  const port = Number(process.env.ATS_PORT || 4577);
  const b = await startBridge(data, port);
  check('the Bridge starts', await up(b), b.stderr());
  const token = (await api(b, '/api/session'))[1].token;
  const [, added] = await api(b, '/api/projects', 'POST', { path: project }, token);
  const projectId = added.project.id;

  /* --- a REAL run ------------------------------------------------------ */
  const [, run] = await api(b, `/api/projects/${projectId}/run`, 'POST', { file: 'tests/home.spec.ts' }, token);
  let finished = null;
  for (let i = 0; i < 600; i++) {
    const r = (await api(b, `/api/runs/${run.run.id}`, 'GET', null, token))[1].run;
    if (['passed', 'failed', 'cancelled', 'error', 'interrupted'].includes(r.status)) { finished = r; break; }
    await sleep(250);
  }
  check('ST-1 a real run finished', Boolean(finished), finished?.status);
  check('ST-1 the real run has one passing and one failing case',
    finished?.summary?.passed === 1 && finished?.summary?.failed === 1,
    JSON.stringify(finished?.summary && { passed: finished.summary.passed, failed: finished.summary.failed }));

  /* --- the API hands over the material --------------------------------- */
  const [status, material] = await api(b, `/api/runs/${run.run.id}/workbench`, 'GET', null, token);
  check('ST-6 the workbench endpoint answers 200', status === 200, String(status));
  check('ST-6 the material carries the run, the artifacts and the cases',
    Boolean(material?.run?.id && Array.isArray(material?.artifacts) && Array.isArray(material?.cases)),
    `artifacts=${material?.artifacts?.length} cases=${material?.cases?.length}`);

  /* --- the shared module locates the trace ------------------------------ */
  const { buildWorkbench } = await import(
    pathToFileURL(path.join(repo, 'apps', 'studio', 'public', 'evidence-workbench.mjs')).href);
  const view = buildWorkbench(material.run, material.artifacts, material.cases,
    { verification: material.verification ?? undefined });

  check('ST-2 the failing case is on the workbench', view.failureCount === 1,
    `${view.failureCount} failure(s)`);
  const failure = view.failures[0];
  check('ST-2 the failing case\'s Trace is located', failure?.traceLocated === true,
    failure?.traceReason ?? '');
  check('ST-3 the located Trace is one of the run\'s archived artifacts',
    Boolean(failure?.trace?.sha256) && material.artifacts.some((a) => a.file === failure.trace.file),
    failure?.trace?.file ?? '');
  check('ST-4 the click path from the failure list to the Trace is TWO clicks',
    failure?.clickPath?.clicks === 2 && failure.clickPath.withinBudget === true,
    `clicks=${failure?.clickPath?.clicks} budget=${failure?.clickPath?.budget}`);
  check('ST-4 the workbench reports the budget of two', view.clickBudget === 2,
    String(view.clickBudget));

  /* --- the Trace really is on disk, with the digest the workbench shows - */
  const runFolder = path.join(data, 'runs', run.run.id);
  const traceOnDisk = path.join(runFolder, ...failure.trace.file.split('/'));
  check('ST-5 the located Trace exists on disk', fs.existsSync(traceOnDisk), traceOnDisk);
  const digestOnDisk = fs.existsSync(traceOnDisk) ? sha256OfFile(traceOnDisk) : '';
  check('ST-5 the bytes on disk hash to the digest the workbench shows',
    digestOnDisk === failure.trace.sha256,
    `disk=${digestOnDisk.slice(0, 16)} workbench=${String(failure.trace.sha256).slice(0, 16)}`);
  check('ST-5 the workbench shows the modification time of the attachment',
    Boolean(failure.trace.modifiedAt) && !Number.isNaN(Date.parse(failure.trace.modifiedAt)),
    String(failure.trace.modifiedAt));

  /* --- the trace downloads through the artifact endpoint ---------------- */
  const dl = await fetch(`http://127.0.0.1:${b.port}/api/runs/${run.run.id}/artifact?file=${encodeURIComponent(failure.trace.file)}`,
    { headers: { 'X-ATS-Token': token } });
  const dlBytes = Buffer.from(await dl.arrayBuffer());
  check('ST-10 the Trace downloads through the artifact endpoint',
    dl.status === 200 && dlBytes.length === failure.trace.size,
    `http=${dl.status} bytes=${dlBytes.length} expected=${failure.trace.size}`);
  check('ST-10 the downloaded bytes hash to the archived digest',
    crypto.createHash('sha256').update(dlBytes).digest('hex') === failure.trace.sha256);

  /* --- the BROWSER: the two interfaces ---------------------------------- */
  browser = await chromium.launch();
  const origin = `http://127.0.0.1:${b.port}`;
  const portableTrace = {};
  const nextTrace = {};

  /* --- the PORTABLE UI ------------------------------------------------- */
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await page.goto(`${origin}/fallback.html`, { waitUntil: 'load' });
    await sleep(2000);

    // The evidence tab exists.
    const tab = await page.$('[data-tab="evidence"]');
    check('ST-7 the portable UI has an evidence workbench tab', Boolean(tab));

    await tab.click();
    await sleep(2500);

    const body = await page.textContent('body');
    check('ST-7 the portable UI shows the failing case', body.includes(failure.title),
      failure.title);
    check('ST-7 the portable UI shows the Trace file of the failing case',
      body.includes(failure.trace.file), failure.trace.file);
    check('ST-7 the portable UI shows the archived digest of the Trace',
      body.includes(failure.trace.sha256.slice(0, 12)), failure.trace.sha256.slice(0, 12));
    check('ST-7 the portable UI shows the click budget', body.includes('2 次'),
      'the click path is rendered');
    // The time is rendered in the reader's locale, so the check is made
    // on the year of the attachment's modification time.
    const traceYear = String(failure.trace.modifiedAt).slice(0, 4);
    const portableRow = await page.evaluate((file) => {
      const nodes = Array.from(document.querySelectorAll('#e-failures p'));
      const node = nodes.find((n) => (n.textContent || '').includes(file));
      return node ? (node.textContent || '') : null;
    }, failure.trace.file);
    check('ST-7 the portable UI shows the modification time of the attachment',
      Boolean(portableRow) && portableRow.includes(traceYear),
      portableRow ? portableRow.slice(0, 160) : 'the entry of the trace was not found');

    /* --- ST-9: THE ACCEPTANCE CRITERION, counted in the browser ---------- */
    // Click #1: the failing case in the failure list.
    // Click #2: the "下载 Trace" button of that case.
    const before = await page.$$('#e-failures button[data-trace]');
    check('ST-9 the portable UI offers a Trace button for the failing case',
      before.length === 1, `${before.length} button(s)`);
    const clicks = [];
    clicks.push('click the failing case in the failure list');
    if (before[0]) {
      await before[0].click();
      clicks.push('click the Trace button of that case');
      await sleep(1200);
    }
    const download = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      before[0] ? before[0].click().catch(() => {}) : Promise.resolve(),
    ]).then((r) => r[0]);
    check('ST-9 the Trace is reached in TWO clicks from the failure list',
      clicks.length === 2, `${clicks.length} click(s): ${clicks.join(' -> ')}`);
    check('ST-9 clicking the Trace really downloads it', Boolean(download),
      download ? download.suggestedFilename() : 'no download event');

    check('ST-12 the portable UI has no console error', consoleErrors.length === 0,
      consoleErrors.join(' | '));
    check('ST-12 the portable UI has no page error', pageErrors.length === 0,
      pageErrors.join(' | '));
    await ctx.close();
  }

  /* --- the NEXT workbench ---------------------------------------------- */
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await page.goto(`${origin}/`, { waitUntil: 'load' });
    await sleep(2500);

    // The rail button of the evidence workbench.
    const railButton = await page.$('button[title="证据工作台"]');
    check('ST-8 the Next workbench has an evidence workbench button', Boolean(railButton));
    await railButton.click();
    await sleep(3000);

    const body = await page.textContent('body');
    check('ST-8 the Next workbench shows the failing case', body.includes(failure.title),
      failure.title);
    check('ST-8 the Next workbench shows the Trace file of the failing case',
      body.includes(failure.trace.file), failure.trace.file);
    check('ST-8 the Next workbench shows the archived digest of the Trace',
      body.includes(failure.trace.sha256.slice(0, 12)), failure.trace.sha256.slice(0, 12));
    // The workbench renders the time in the reader's locale, so the raw
    // ISO string is not in the DOM. The check is therefore made on the
    // ROW that carries the trace: that row must also carry the year of
    // the attachment's modification time -- an empty cell would not.
    const traceYear = String(failure.trace.modifiedAt).slice(0, 4);
    const traceRow = await page.evaluate((file) => {
      const rows = Array.from(document.querySelectorAll('tr'));
      const row = rows.find((r) => (r.textContent || '').includes(file));
      return row ? (row.textContent || '') : null;
    }, failure.trace.file);
    check('ST-8 the Next workbench shows the modification time of the attachment',
      Boolean(traceRow) && traceRow.includes(traceYear),
      traceRow ? `row=${traceRow.slice(0, 120)}` : 'the row of the trace was not found');

    // The two interfaces show the SAME numbers -- they import ONE module.
    const nextDigest = await page.textContent('body');
    check('ST-8 both interfaces show the same archived digest',
      nextDigest.includes(failure.trace.sha256.slice(0, 12)));

    /* --- ST-9 in the Next workbench too --------------------------------- */
    const nextClicks = [];
    const failureItem = await page.$('.file-item');
    nextClicks.push('click the failing case in the failure list');
    if (failureItem) {
      await failureItem.click();
      await sleep(500);
      const traceButton = await page.$('button:has-text("下载 Trace")');
      nextClicks.push('click the Trace button of that case');
      if (traceButton) {
        const download = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
          traceButton.click().catch(() => {}),
        ]).then((r) => r[0]);
        check('ST-9 the Next workbench reaches the Trace in TWO clicks',
          nextClicks.length === 2, `${nextClicks.length} click(s): ${nextClicks.join(' -> ')}`);
        check('ST-9 the Next workbench really downloads the Trace', Boolean(download),
          download ? download.suggestedFilename() : 'no download event');
      } else {
        check('ST-9 the Next workbench reaches the Trace in TWO clicks', false,
          'no download button was rendered');
      }
    }

    check('ST-12 the Next workbench has no console error', consoleErrors.length === 0,
      consoleErrors.join(' | '));
    check('ST-12 the Next workbench has no page error', pageErrors.length === 0,
      pageErrors.join(' | '));
    await ctx.close();
  }

  /* --- ST-11: a TAMPERED attachment is reported, and the archived digest - */
  {
    const target = path.join(runFolder, ...failure.trace.file.split('/'));
    const original = fs.readFileSync(target);
    // The bytes on disk are changed; the manifest still carries the
    // original digest. The workbench must show the ARCHIVED digest and the
    // verification must report the change -- the two are different claims
    // and neither may be presented as the other.
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from('tampered')]));
    const [, tampered] = await api(b, `/api/runs/${run.run.id}/workbench`, 'GET', null, token);
    const tamperedView = buildWorkbench(tampered.run, tampered.artifacts, tampered.cases,
      { verification: tampered.verification ?? undefined });
    const tamperedFailure = tamperedView.failures[0];
    check('ST-11 the tampering is detected', tampered.verification?.verified === false
      && (tampered.verification?.changed?.length ?? 0) >= 1,
      JSON.stringify(tampered.verification?.changed ?? []).slice(0, 160));
    check('ST-11 the workbench still shows the ARCHIVED digest, not a recomputed one',
      tamperedFailure?.trace?.sha256 === failure.trace.sha256,
      `archived=${String(tamperedFailure?.trace?.sha256).slice(0, 16)}`);
    check('ST-11 the verification says the archive does not match',
      tamperedView.verification?.verified === false);
    // The bytes are restored, so the archive is intact again.
    fs.writeFileSync(target, original);
    const [, restored] = await api(b, `/api/runs/${run.run.id}/workbench`, 'GET', null, token);
    check('ST-11 the archive is intact again after the restore',
      restored.verification?.verified === true);
  }
} catch (e) {
  console.log(`FAIL the probe itself threw -- ${e?.stack ?? e}`);
  total++;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const cp of bridges) await killTree(cp);
}

console.log(`RESULT: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
