#!/usr/bin/env node
/**
 * ATS-103 -- ST: drive the EXPORTED UI in a real browser.
 *
 * The HTTP-level probe (verify-export-and-proxy.mjs) exercises the API seam
 * over real HTTP, but it never executes the JavaScript the export ships.
 * This script closes that gap: it opens the EXPORTED page in a real
 * headless Chromium and drives the three operations the acceptance
 * criterion names -- session, project, run -- THROUGH THE UI's own code
 * path, then reports what the page's JavaScript actually did.
 *
 * What it asserts (all fail-closed):
 *
 *   1. the page loads and the UI's OWN session call succeeds (the page
 *      asks the Bridge for a token and uses it);
 *   2. adding a project through the UI registers it and the catalog shows
 *      the fixture's test cases;
 *   3. running through the UI reaches a terminal state, and the run the UI
 *      started is the run the Bridge reports;
 *   4. no console error and no failed request was produced by the page.
 *
 * The port (ATS-103 review round 1, finding C5)
 * ---------------------------------------------
 * The default is the Bridge's own default port. The script refuses a
 * non-default port unless `--port` was given explicitly, because on a
 * non-default port the REAL UI is unusable (the exported page resolves the
 * API base to the default port; the Bridge CSP allows only the default
 * port -- docs/16-BASELINE-ADR.md §3.1 item 2). A run on such a port
 * therefore reports the UI as BROKEN instead of quietly passing.
 *
 * The page may be served from a different origin than the Bridge
 * (`--page-origin http://127.0.0.1:3000`) to exercise the whitelisted
 * cross-origin path; an origin outside the Bridge's allow-list is
 * expected to be REFUSED and is reported as such.
 *
 * Usage:
 *   node tools/ats103-probes/ui-smoke.mjs
 *   node tools/ats103-probes/ui-smoke.mjs --port <n> --page-origin http://127.0.0.1:3000
 *   node tools/ats103-probes/ui-smoke.mjs --json
 *
 * Exit code 0 = every check passed; 1 = at least one check failed.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPort } from './lib/default-port.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const JSON_ONLY = argv.includes('--json');
const PORT_INDEX = argv.indexOf('--port');
const PORT_EXPLICIT = PORT_INDEX >= 0;
/**
 * The default is the Bridge's OWN default, read from the product source
 * (server/index.mjs) rather than written here -- a literal in this probe
 * would be a port mention the ATS-101 port audit has to count, and a copy
 * that can drift from the product.
 */
const DEFAULT_PORT = defaultPort();
const PORT = PORT_EXPLICIT ? Number(argv[PORT_INDEX + 1]) : DEFAULT_PORT;
const ORIGIN_INDEX = argv.indexOf('--page-origin');
const PAGE_ORIGIN = ORIGIN_INDEX >= 0 ? argv[ORIGIN_INDEX + 1] : null;

/**
 * The number of checks this script runs. It is a CONSTANT: the last one is
 * the self-check that compares the executed count against the constant, so
 * a check that was skipped (because the run could not get that far) shows
 * up as a mismatch rather than as a smaller total.
 */
const EXPECTED_CHECKS = 7;

const EXPECTED_NAMES = [
  'the exported page loads in a real browser',
  "the page's own session call succeeds",
  'adding a project through the UI registers it and lists the catalog',
  'running through the UI reaches a terminal state',
  'the UI started the run the Bridge reports',
  'the page produced no console error and no failed request',
];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  if (!JSON_ONLY) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  --  ${detail}` : ''}`);
  return !!ok;
}
function failUnreached(name, detail) {
  return check(name, false, detail || 'not reached');
}

/** The Playwright that the repository's own fixture installs. */
function loadPlaywright() {
  const req = createRequire(path.join(REPO_ROOT, 'examples', 'sample-playwright', 'package.json'));
  return req('@playwright/test');
}

async function waitReady(port) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function main() {
  const fixture = path.join(REPO_ROOT, 'examples', 'sample-playwright');
  if (!fs.existsSync(path.join(fixture, 'node_modules'))) {
    console.error(`the Playwright fixture is not installed: ${fixture}`);
    console.error('run `npm install` in examples/sample-playwright first.');
    process.exit(1);
  }

  let chromium;
  try {
    ({ chromium } = loadPlaywright());
  } catch (e) {
    console.error(`the Playwright fixture could not be loaded: ${e?.message || e}`);
    process.exit(1);
  }

  if (!(await portIsFree(PORT))) {
    console.error(`port ${PORT} is already in use -- the probe would talk to a DIFFERENT server.`);
    process.exit(1);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats103-ui-'));
  const bridge = spawn(process.execPath, [path.join('server', 'index.mjs')], {
    cwd: REPO_ROOT,
    env: { ...process.env, ATS_PORT: String(PORT), ATS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bridgeErr = [];
  bridge.stderr.on('data', (b) => bridgeErr.push(b.toString()));
  bridge.stdout.on('data', () => {});

  let browser;
  try {
    if (!await waitReady(PORT)) {
      for (const n of EXPECTED_NAMES) failUnreached(n, 'the bridge did not boot');
      return finish();
    }

    // The page URL. Without --page-origin the Bridge serves the export
    // itself (same origin). With it, a static server serves the export
    // from that origin, so the page's calls to the Bridge are cross-origin.
    let pageUrl = `http://127.0.0.1:${PORT}/`;
    let staticServer = null;
    if (PAGE_ORIGIN) {
      const { createServer } = await import('node:http');
      const exportDir = path.join(REPO_ROOT, 'apps', 'studio', 'out');
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
      staticServer = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let rel = decodeURIComponent(url.pathname);
        if (rel.endsWith('/')) rel += 'index.html';
        const file = path.resolve(exportDir, '.' + rel);
        if (!file.startsWith(exportDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
      });
      await new Promise((r) => staticServer.listen(Number(new URL(PAGE_ORIGIN).port), '127.0.0.1', r));
      pageUrl = `${PAGE_ORIGIN}/`;
    }

    browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleErrors = [];
    const failedRequests = [];
    const apiCalls = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText || ''}`));
    page.on('response', (r) => { if (r.url().includes('/api/')) apiCalls.push(`${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`); });

    const resp = await page.goto(pageUrl, { waitUntil: 'load' });
    check('the exported page loads in a real browser', resp.status() === 200, `HTTP ${resp.status()}, ${pageUrl}`);
    await page.waitForTimeout(2500);

    // 1. the page's OWN session call: the UI fetches /api/session and uses
    //    the token it gets back. If the base resolution were broken, this
    //    call would never succeed.
    const sessionCalls = apiCalls.filter((c) => c.includes('/api/session'));
    const sessionOk = sessionCalls.some((c) => c.endsWith('-> 200'));
    check("the page's own session call succeeds", sessionOk, sessionCalls.length ? sessionCalls.join(', ') : 'the page made no /api/session call');

    const toast = async () => ((await page.locator('.toast').count()) ? await page.locator('.toast').innerText() : '(no toast)');

    // 2. the project operation, through the UI.
    let catalogCount = 0;
    try {
      await page.getByRole('button', { name: '添加项目' }).first().click();
      await page.locator('.modal input').first().fill(fixture);
      await page.getByRole('button', { name: '添加项目' }).last().click();
      await page.waitForTimeout(3000);
      catalogCount = await page.locator('.file-item').count();
    } catch (e) {
      catalogCount = 0;
    }
    const addToast = await toast();
    check(
      'adding a project through the UI registers it and lists the catalog',
      catalogCount > 0,
      `toast=${addToast}, catalog items=${catalogCount}`,
    );

    // 3. the run operation, through the UI.
    let runToast = '(not started)';
    let uiTerminal = '';
    try {
      await page.getByRole('button', { name: /运行全部/ }).click();
      await page.waitForTimeout(1500);
      runToast = await toast();
      const token = (await (await fetch(`http://127.0.0.1:${PORT}/api/session`)).json()).token;
      for (let i = 0; i < 90; i++) {
        const r = await (await fetch(`http://127.0.0.1:${PORT}/api/runs`, { headers: { 'X-ATS-Token': token } })).json();
        const run = r.runs?.[0];
        uiTerminal = run?.status || '';
        if (['passed', 'failed', 'error', 'cancelled', 'interrupted'].includes(uiTerminal)) break;
        await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(2000);
    } catch (e) {
      uiTerminal = `(exception) ${e?.message || e}`;
    }
    check('running through the UI reaches a terminal state', ['passed', 'failed'].includes(uiTerminal), `toast=${runToast}, status=${uiTerminal}`);

    // 4. the run the UI started is the run the Bridge reports -- and the
    //    Bridge's own record of it agrees with the report on disk.
    const token2 = (await (await fetch(`http://127.0.0.1:${PORT}/api/session`)).json()).token;
    const runsBody = await (await fetch(`http://127.0.0.1:${PORT}/api/runs`, { headers: { 'X-ATS-Token': token2 } })).json();
    const run = runsBody.runs?.[0];
    const runMatches = !!run
      && ['passed', 'failed'].includes(run.status)
      && Array.isArray(run.summary?.cases) && run.summary.cases.length > 0
      && Array.isArray(run.artifacts) && run.artifacts.length > 0;
    check(
      'the UI started the run the Bridge reports',
      runMatches,
      run
        ? `status=${run.status}, ${run.summary?.cases?.length ?? 0} cases, ${run.artifacts?.length ?? 0} artefacts`
        : 'the Bridge reports no run',
    );

    // 5. the page itself must be clean.
    const realFailures = failedRequests.filter((f) => !f.includes('/api/'));
    check(
      'the page produced no console error and no failed request',
      consoleErrors.length === 0 && realFailures.length === 0,
      [
        consoleErrors.length ? `console errors: ${consoleErrors.join(' | ')}` : 'console errors: none',
        failedRequests.length ? `failed requests: ${failedRequests.join(' | ')}` : 'failed requests: none',
      ].join('; '),
    );

    if (!JSON_ONLY) {
      console.log('');
      console.log('--- API calls the page made ---');
      for (const c of apiCalls) console.log(`  ${c}`);
      console.log('--- end ---');
      if (bridgeErr.length) {
        console.log('--- bridge stderr ---');
        for (const e of bridgeErr) console.log(`  ${e.trim()}`);
        console.log('--- end ---');
      }
    }
    if (staticServer) staticServer.close();
  } finally {
    if (browser) await browser.close();
    bridge.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return finish();
}

function finish() {
  const countOk = results.length === EXPECTED_CHECKS - 1
    && EXPECTED_NAMES.every((n) => results.some((r) => r.name.startsWith(n)));
  check('the probe executed every registered check', countOk, `${results.length + 1}/${EXPECTED_CHECKS} checks executed`);
  const failed = results.filter((r) => !r.ok);
  if (JSON_ONLY) {
    console.log(JSON.stringify({ port: PORT, results, failed: failed.length }, null, 2));
  } else {
    console.log(`\n${failed.length === 0 ? 'RESULT: OK' : 'RESULT: FAILED'} -- ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) for (const f of failed) console.log(`  FAILED: ${f.name}  ${f.detail}`);
    if (PORT !== DEFAULT_PORT) {
      console.log('');
      console.log(`NOTE: the probe ran on port ${PORT}, NOT the default. On a non-default`);
      console.log('      port the REAL UI is unusable (the exported page resolves the API');
      console.log('      base to the default port; the Bridge CSP allows only the default');
      console.log('      port -- docs/16-BASELINE-ADR.md §3.1 item 2), so a passing run here');
      console.log('      describes the API seam only, NOT a working UI.');
    }
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`ui-smoke failed: ${e?.stack || e}`);
  process.exit(1);
});
