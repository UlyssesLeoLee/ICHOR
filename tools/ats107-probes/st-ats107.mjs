/**
 * ATS-107 system test: the REAL BROWSER PASS/FAIL REPOSITORY.
 *
 *   node tools/ats107-probes/st-ats107.mjs <repo> <scratch-dir>
 *
 * WHY THIS EXISTS
 * ---------------
 * The acceptance criterion of ATS-107 is
 *
 *   「Chromium 上至少 1 PASS 1 FAIL；结果和错误信息与 CLI 一致」
 *
 * -- "at least 1 PASS and 1 FAIL on Chromium; the results and the error
 * messages are consistent with the CLI".
 *
 * Two things in that sentence need a real run to be true:
 *
 *   1. the PASS and the FAIL have to come from a REAL Chromium, and
 *   2. 「与 CLI 一致」 has to be a comparison against a CLI run -- there has
 *      to be a CLI verdict to be consistent WITH.
 *
 * So this probe runs the ATS-107 fixture (`examples/real-browser-fixture`)
 * TWICE: once directly through the Playwright CLI, and once through the
 * real Bridge (POST /api/projects/{id}/run). It then compares the two, and
 * compares both against the fixture's own declared expectations
 * (`tests/expected.json`).
 *
 * WHY THE EXPECTED VALUE IS NOT THE BRIDGE'S OWN SUMMARY
 * -------------------------------------------------------
 * Comparing the Bridge's summary with itself would be a tautology: a Bridge
 * that reported "2 passed" for a run in which one case failed would still
 * pass such a check. The expected values therefore come from TWO sources
 * that are independent of the Bridge:
 *
 *   - the direct CLI run (the engine's own report, read by THIS probe with
 *     the probe's OWN walker -- not with the product's parser, so a bug in
 *     that parser cannot hide itself), and
 *   - the fixture's committed `tests/expected.json`.
 *
 * The probe prints `PASS`/`FAIL` per check and `RESULT: <passed>/<total>`;
 * it exits 0 only when every check passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import {
  walkReport, cliCounts, verdictToStatus, stripAnsi,
  compareVerdicts, compareError, compareExpectations, compareCounters,
} from './compare.mjs';
import { chromiumInAny } from './lib/trace.mjs';

const [repoArg, scratchArg] = process.argv.slice(2);
if (!repoArg || !scratchArg) {
  console.error('usage: st-ats107.mjs <repo> <scratch-dir>');
  process.exit(2);
}
const repo = path.resolve(repoArg);

fs.mkdirSync(scratchArg, { recursive: true });
const scratch = fs.mkdtempSync(path.join(path.resolve(scratchArg), 'ats107-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let total = 0;
const check = (id, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` -- ${detail}` : ''}`);
};

/* --- a free port for the Bridge ---------------------------------------- */
// The probe must not fight with a developer's own instance of the Bridge,
// so it asks the OS for a free port instead of taking the default one.
function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(0));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/* --- the Bridge --------------------------------------------------------- */
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

/**
 * Every `trace.zip` under a directory tree.
 *
 * @param {string} dir the root
 * @returns {string[]} the absolute paths of the trace archives
 */
function traceFilesUnder(dir) {
  const found = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'trace.zip') found.push(full);
    }
  };
  walk(dir);
  return found;
}

/** Runs the fixture's own CLI, exactly as a developer would. */
function runCli(projectRoot, cliArgs, env) {
  return new Promise((resolve) => {
    const cli = path.join(projectRoot, 'node_modules', '@playwright', 'test', 'cli.js');
    const child = spawn(process.execPath, [cli, 'test', ...cliArgs], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

try {
  /* ====================================================================== */
  /* ST-1: the fixture itself -- a lockfile-pinned, chromium-pinned project */
  /* ====================================================================== */
  const fixtureSrc = path.join(repo, 'examples', 'real-browser-fixture');
  const fixturePkg = JSON.parse(fs.readFileSync(path.join(fixtureSrc, 'package.json'), 'utf8'));
  const pinnedVersion = fixturePkg?.devDependencies?.['@playwright/test'] ?? '';
  check('ST-1 the fixture pins an EXACT @playwright/test version',
    /^\d+\.\d+\.\d+$/.test(String(pinnedVersion)),
    `declared=${pinnedVersion}`);

  const lockExists = fs.existsSync(path.join(fixtureSrc, 'package-lock.json'));
  check('ST-1 the fixture has a lockfile on disk', lockExists);

  // The lockfile has to be COMMITTED: a lockfile that only exists on one
  // machine does not pin anything for anybody else.
  const tracked = await new Promise((resolve) => {
    const child = spawn('git', ['-C', repo, 'ls-files', 'examples/real-browser-fixture/'], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.on('close', () => resolve(out));
  });
  check('ST-1 the fixture lockfile is COMMITTED',
    tracked.split(/\r?\n/).includes('examples/real-browser-fixture/package-lock.json'),
    tracked.split(/\r?\n/).filter(Boolean).join(' '));

  const configSrc = fs.readFileSync(path.join(fixtureSrc, 'playwright.config.ts'), 'utf8');
  check('ST-1 the fixture names chromium explicitly', /browserName:\s*'chromium'/.test(configSrc));
  check('ST-1 the fixture sets retries: 0', /retries:\s*0/.test(configSrc));

  /* --- the fixture is COPIED, so the run never writes into the tree --- */
  const project = path.join(scratch, 'real-browser-fixture');
  fs.cpSync(fixtureSrc, project, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('test-results')
      && !src.endsWith('report.json') && !src.includes('playwright-report'),
  });

  /* --- install from the COMMITTED lockfile ------------------------------- */
  const install = await new Promise((resolve) => {
    const child = spawn('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: project, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32',
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  check('ST-1 the fixture installs from its lockfile (npm ci)',
    install.code === 0 && fs.existsSync(path.join(project, 'node_modules', '@playwright', 'test', 'cli.js')),
    `exit=${install.code} ${install.err.slice(0, 160)}`);

  const installedVersion = JSON.parse(
    fs.readFileSync(path.join(project, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version;
  check('ST-1 the installed engine is the pinned one', installedVersion === pinnedVersion,
    `installed=${installedVersion} pinned=${pinnedVersion}`);

  /* ====================================================================== */
  /* ST-2: the DIRECT CLI run -- the engine's own verdict                    */
  /* ====================================================================== */
  const cliOutDir = path.join(scratch, 'cli-run');
  fs.mkdirSync(cliOutDir, { recursive: true });
  const cliReportFile = path.join(cliOutDir, 'report.json');
  const cliRun = await runCli(project,
    ['--reporter=line,json', '--output', path.join(cliOutDir, 'results'), '--trace', 'on', '--workers', '1'],
    { PLAYWRIGHT_JSON_OUTPUT_FILE: cliReportFile, CI: '1', FORCE_COLOR: '0' });

  check('ST-2 the direct CLI run produced a report', fs.existsSync(cliReportFile),
    `exit=${cliRun.code}`);

  let cli = { cases: [], stats: null };
  if (fs.existsSync(cliReportFile)) {
    cli = walkReport(JSON.parse(fs.readFileSync(cliReportFile, 'utf8')));
  }
  const cliPassed = cli.cases.filter((c) => verdictToStatus(c.engineStatus) === 'passed');
  const cliFailed = cli.cases.filter((c) => verdictToStatus(c.engineStatus) === 'failed');
  check('ST-2 the direct CLI run has at least one PASS', cliPassed.length >= 1,
    `${cliPassed.length} passed`);
  check('ST-2 the direct CLI run has at least one FAIL', cliFailed.length >= 1,
    `${cliFailed.length} failed`);
  check('ST-2 the direct CLI run used a real browser (the engine wrote a trace)',
    cli.cases.some((c) => c.attachments.includes('trace')),
    cli.cases.map((c) => c.attachments.join('+')).join(' | '));

  /* --- ST-2: the trace records a REAL browser CONTEXT -------------------- */
  // A trace archive alone does NOT prove a browser was launched: a fixture
  // that never asks for a `page` still writes a trace.zip, and the
  // test-runner's own trace inside it mentions the browser name in fields
  // that have nothing to do with a browser. What proves it is the BROWSER
  // CONTEXT trace: the engine writes one trace file per browser context
  // (`<n>-trace.trace`) whose first event is a `context-options` event
  // naming the browser that was actually launched.
  const cliTraces = traceFilesUnder(path.join(cliOutDir, 'results'));
  const cliBrowser = chromiumInAny(cliTraces);
  check('ST-2 the direct CLI run launched a REAL Chromium (the trace has a browser context)',
    cliBrowser.ok, cliBrowser.detail);

  check('ST-2 the failing case carries the engine\'s own error message',
    cliFailed.length >= 1 && stripAnsi(cliFailed[0].error).length > 0,
    cliFailed.length ? `${stripAnsi(cliFailed[0].error).length} chars` : 'no failing case');

  /* ====================================================================== */
  /* ST-3..ST-8: the REAL Bridge run, compared with the CLI run            */
  /* ====================================================================== */
  const data = path.join(scratch, 'data');
  const port = await freePort();
  const b = await startBridge(data, port);
  check('the Bridge starts', await up(b), b.stderr().slice(0, 300));
  const token = (await api(b, '/api/session'))[1].token;
  const [, added] = await api(b, '/api/projects', 'POST', { path: project }, token);
  const projectId = added?.project?.id;
  check('the Bridge accepts the fixture as a project', Boolean(projectId), String(added?.error ?? ''));

  const [, started] = await api(b, `/api/projects/${projectId}/run`, 'POST', {}, token);
  const runId = started?.run?.id;
  let finished = null;
  for (let i = 0; i < 900; i++) {
    const r = (await api(b, `/api/runs/${runId}`, 'GET', null, token))[1].run;
    if (['passed', 'failed', 'cancelled', 'error', 'interrupted'].includes(r?.status)) { finished = r; break; }
    await sleep(250);
  }
  check('ST-3 the Bridge run finished', Boolean(finished), finished?.status ?? 'no run');
  const summary = finished?.summary ?? null;

  check('ST-3 the Bridge reports one passed and one failed',
    summary?.passed === 1 && summary?.failed === 1,
    JSON.stringify(summary && { passed: summary.passed, failed: summary.failed, total: summary.total }));

  /* --- ST-4: the per-case verdicts are IDENTICAL ------------------------- */
  const bridgeCases = Array.isArray(summary?.cases) ? summary.cases : [];
  const byTitle = (list) => {
    const m = new Map();
    for (const c of list) m.set(c.title, c);
    return m;
  };
  const cliMap = byTitle(cli.cases);
  const bridgeMap = byTitle(bridgeCases);
  check('ST-4 the Bridge and the CLI agree on the NUMBER of cases',
    bridgeCases.length === cli.cases.length,
    `bridge=${bridgeCases.length} cli=${cli.cases.length}`);

  const verdictDiffs = compareVerdicts(cli.cases, bridgeCases);
  check('ST-4 the per-case verdicts are IDENTICAL to the CLI\'s',
    verdictDiffs.length === 0, verdictDiffs.join(' | '));

  /* --- ST-5: the error message is the ENGINE's ---------------------------- */
  const expectedText = JSON.parse(
    fs.readFileSync(path.join(project, 'tests', 'expected.json'), 'utf8')).expectedFailureText;
  const cliFailing = cli.cases.find((c) => verdictToStatus(c.engineStatus) === 'failed');
  const bridgeFailing = bridgeCases.find((c) => c.status === 'failed');
  check('ST-5 the failing case exists on both sides', Boolean(cliFailing && bridgeFailing));
  const bridgeError = stripAnsi(bridgeFailing?.error ?? '');
  const cliError = stripAnsi(cliFailing?.error ?? '');
  check('ST-5 the Bridge carries the engine\'s error message (it is not empty)',
    bridgeError.length > 0, `${bridgeError.length} chars`);
  check('ST-5 the Bridge\'s error message carries the engine\'s assertion text',
    Boolean(expectedText) && bridgeError.includes(expectedText),
    expectedText ?? '(the fixture declares no assertion text)');
  // The equality check: both sides are stripped of ANSI and must then be the
  // SAME text. A truncated message (first line + assertion text only) is
  // caught here, which is why the comparison is not a containment check.
  const errorDiffs = compareError(cli.cases, bridgeCases);
  check('ST-5 the Bridge\'s error message is the engine\'s own (the whole text, not a part of it)',
    errorDiffs.length === 0,
    errorDiffs.join(' | ') || `cli=${cliError.length} chars, bridge=${bridgeError.length} chars, identical after stripping ANSI`);
  // Print both texts in full, so a reviewer can read them side by side.
  console.log(`CLI error message (${cliError.length} chars, ANSI stripped):`);
  console.log(cliError);
  console.log(`BRIDGE error message (${bridgeError.length} chars, ANSI stripped):`);
  console.log(bridgeError);

  /* --- ST-6: the fixture's own declared expectations ---------------------- */
  const expected = JSON.parse(
    fs.readFileSync(path.join(project, 'tests', 'expected.json'), 'utf8'));
  const expectationDiffs = compareExpectations(bridgeCases, expected);
  check('ST-6 the Bridge matches the fixture\'s declared expectations',
    expectationDiffs.length === 0, expectationDiffs.join(' | '));

  /* --- ST-7: the artefacts the engine wrote ------------------------------- */
  const runFolder = path.join(data, 'runs', runId);
  const engineReport = path.join(runFolder, 'report.json');
  check('ST-7 the run folder holds the engine\'s report.json', fs.existsSync(engineReport),
    engineReport);
  const traceOnDisk = traceFilesUnder(runFolder);
  check('ST-7 the run folder holds a REAL trace.zip', traceOnDisk.length >= 1,
    `${traceOnDisk.length} trace(s)`);
  // The trace archive existing is not enough: the archive must record a
  // browser CONTEXT that names chromium. A fixture that never launches a
  // browser still writes a trace.zip -- the browser context is the proof.
  const bridgeBrowser = chromiumInAny(traceOnDisk);
  check('ST-7 the Bridge run launched a REAL Chromium (the trace has a browser context)',
    bridgeBrowser.ok, bridgeBrowser.detail);

  /* --- ST-8: the counters agree ------------------------------------------ */
  const counts = cliCounts(cli.cases);
  const counterDiffs = compareCounters(summary, counts);
  check('ST-8 the counters agree with the CLI\'s',
    counterDiffs.length === 0,
    `bridge=${summary?.passed}/${summary?.failed}/${summary?.total} cli=${counts.passed}/${counts.failed}/${counts.total}`);

  /* --- the facts a reviewer needs ---------------------------------------- */
  console.log(`ENGINE: @playwright/test ${installedVersion} (chromium)`);
  console.log(`CLI run exit code: ${cliRun.code}`);
  console.log(`CLI stats: ${JSON.stringify(cli.stats)}`);
  console.log(`CLI cases: ${cli.cases.map((c) => `${c.title} => ${c.engineStatus}`).join(' | ')}`);
  console.log(`BRIDGE cases: ${bridgeCases.map((c) => `${c.title} => ${c.status}`).join(' | ')}`);
} catch (e) {
  console.log(`FAIL the probe itself threw -- ${e?.stack ?? e}`);
  total++;
} finally {
  for (const cp of bridges) await killTree(cp);
}

console.log(`RESULT: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
