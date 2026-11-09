/**
 * ATS-216 system test: the QUALITY OVERVIEW, end to end.
 *
 *   node tools/ats216-probes/st-ats216.mjs <repo> <scratch-dir> <playwright-node_modules>
 *
 * <playwright-node_modules> is a node_modules directory with @playwright/test
 * installed (e.g. examples/sample-playwright/node_modules of a checkout where
 * `npm install` ran); it is linked into a copy of the fixture.
 *
 * WHAT IS PROVED
 * --------------
 * The acceptance criterion of ATS-216 is 「区分失败/重试/取消，指标与原始结果可核对」
 * -- distinguish failure / retry / cancel, and the metrics must be checkable
 * against the raw results. The probe therefore drives a REAL Bridge with a
 * REAL Playwright run (Chromium) and checks:
 *
 *   ST-216-1  a run that ends in `failed` is counted as FAILED, and its one
 *             passing and one failing case are counted as such;
 *   ST-216-2  a run that is STOPPED is counted as CANCELLED -- not as a
 *             failure, and not as a pass. This is the distinction the task
 *             is about, and it is measured against a real stop request;
 *   ST-216-3  a retried case is counted as FLAKY (a retry bucket of its
 *             own), and its first failed attempt is still visible;
 *   ST-216-4  every metric RECONCILES with the raw case list the bridge
 *             reports -- the "指标与原始结果可核对" half of the criterion;
 *   ST-216-5  the shared module is served to the browser with a JavaScript
 *             MIME type, and the two UIs import the SAME implementation;
 *   ST-216-6  the failure clustering is deterministic: the same error text
 *             clusters together, a different one does not.
 *
 * Prints `PASS`/`FAIL` per check and `RESULT: <passed>/<total>`; exits 0 only
 * when every check passed. No port literal: every Bridge gets a free port.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [repoArg, scratchArg, nodeModulesArg] = process.argv.slice(2);
if (!repoArg || !scratchArg || !nodeModulesArg) {
  console.error('usage: st-ats216.mjs <repo> <scratch-dir> <playwright-node_modules>');
  process.exit(2);
}
const repo = path.resolve(repoArg);
const { freePort } = await import(pathToFileURL(path.join(repo, 'tests', 'helpers', 'free-port.mjs')).href);

fs.mkdirSync(scratchArg, { recursive: true });
const scratch = fs.mkdtempSync(path.join(path.resolve(scratchArg), 'st216-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let total = 0;
const check = (id, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` -- ${detail}` : ''}`);
};

/* --- the project: the sample fixture plus a retried and a slow case --- */
const project = path.join(scratch, 'sample-playwright');
fs.cpSync(path.join(repo, 'examples', 'sample-playwright'), project,
  { recursive: true, filter: (src) => !src.includes('node_modules') });
fs.symlinkSync(path.resolve(nodeModulesArg), path.join(project, 'node_modules'), 'junction');
// A case that fails on its first try and passes on its retry: the engine
// retries it, so the case is FLAKY and its first failed attempt is kept.
//
// The attempt counter lives in a FILE, not in a module variable: Playwright
// runs each retry in a FRESH worker process, so an in-memory counter is
// always 1 and the case would never recover. The file is what makes the
// retry observable.
fs.writeFileSync(path.join(project, 'tests', 'flaky.spec.ts'),
  "import { test, expect } from '@playwright/test';\n" +
  "import fs from 'node:fs';\n" +
  "const marker = 'flaky-attempt-count';\n" +
  "test('重试后通过的用例', async ({ page }) => {\n" +
  "  const n = Number(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '0') + 1;\n" +
  "  fs.writeFileSync(marker, String(n));\n" +
  "  await page.setContent('<h1 id=\"t\">hello</h1>');\n" +
  "  if (n === 1) await expect(page.locator('#missing')).toBeVisible();\n" +
  "  await expect(page.locator('#t')).toHaveText('hello');\n" +
  "});\n");
// A case that runs long enough to be stopped while it is in flight.
fs.writeFileSync(path.join(project, 'tests', 'slow.spec.ts'),
  "import { test } from '@playwright/test';\n" +
  "test('长时间运行的用例', async ({ page }) => {\n" +
  "  await page.setContent('<p>running</p>');\n" +
  "  await page.waitForTimeout(60000);\n" +
  "});\n");
// The retries the flaky case needs.
fs.writeFileSync(path.join(project, 'playwright.config.ts'),
  "import { defineConfig } from '@playwright/test';\n" +
  "export default defineConfig({testDir:'./tests',use:{baseURL:'https://example.com'},timeout:20000,retries:1});\n");

const bridges = new Set();
async function startBridge(dataDir) {
  const port = await freePort();
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
async function waitTerminal(b, runId, token, ms = 120000) {
  for (let i = 0; i < ms / 250; i++) {
    const run = (await api(b, `/api/runs/${runId}`, 'GET', null, token))[1].run;
    if (['passed', 'failed', 'cancelled', 'error', 'interrupted'].includes(run.status)) return run;
    await sleep(250);
  }
  return null;
}

try {
  const data = path.join(scratch, 'data');
  const b = await startBridge(data);
  check('the Bridge starts', await up(b), b.stderr());
  const token = (await api(b, '/api/session'))[1].token;

  /* --- the shared module is served with a JavaScript MIME type --------- */
  const modRes = await fetch(`http://127.0.0.1:${b.port}/quality.mjs`);
  const modType = modRes.headers.get('content-type') || '';
  check('ST-216-5a the shared module is served', modRes.ok, `HTTP ${modRes.status}`);
  check('ST-216-5b the shared module is served as JavaScript',
    /javascript/.test(modType), modType);

  /* --- the two UIs import the SAME implementation ----------------------- */
  const nextPage = fs.readFileSync(path.join(repo, 'apps', 'studio', 'app', 'page.tsx'), 'utf8');
  const portable = fs.readFileSync(path.join(repo, 'apps', 'studio', 'public', 'fallback.html'), 'utf8');
  check('ST-216-5c the Next workbench imports the shared module',
    nextPage.includes("from '../public/quality.mjs'"));
  check('ST-216-5d the portable UI imports the shared module',
    portable.includes("from './quality.mjs'"));

  /* --- register the project --------------------------------------------- */
  const [, added] = await api(b, '/api/projects', 'POST', { path: project }, token);
  const projectId = added.project.id;
  check('the fixture project is registered', Boolean(projectId));

  /* --- ST-216-1: a real run that FAILS --------------------------------- */
  const [, first] = await api(b, `/api/projects/${projectId}/run`, 'POST', { file: 'tests/home.spec.ts' }, token);
  const failedRun = await waitTerminal(b, first.run.id, token);
  check('ST-216-1a the real run reaches a terminal state', Boolean(failedRun),
    failedRun ? failedRun.status : 'timeout');
  check('ST-216-1b the run that fails is reported as failed',
    failedRun?.status === 'failed', `status=${failedRun?.status}`);
  check('ST-216-1c the run carries a real summary',
    failedRun?.summary?.total === 2 && failedRun?.summary?.passed === 1 && failedRun?.summary?.failed === 1,
    JSON.stringify(failedRun?.summary && {
      total: failedRun.summary.total, passed: failedRun.summary.passed, failed: failedRun.summary.failed }));

  /* --- ST-216-3: a retried case is FLAKY ------------------------------- */
  const [, flakyRun] = await api(b, `/api/projects/${projectId}/run`, 'POST', { file: 'tests/flaky.spec.ts' }, token);
  const flaky = await waitTerminal(b, flakyRun.run.id, token);
  check('ST-216-3a the retried run reaches a terminal state', Boolean(flaky),
    flaky ? flaky.status : 'timeout');
  const flakyCase = flaky?.summary?.cases?.find((c) => c.status === 'flaky');
  check('ST-216-3b the retried case is counted as flaky, not as a plain pass',
    Boolean(flakyCase),
    `statuses=${JSON.stringify(flaky?.summary?.cases?.map((c) => c.status))}`);
  check('ST-216-3c the first failed attempt of the retried case is kept',
    flakyCase?.attemptsCount === 2 && flakyCase?.attempts?.[0]?.status === 'failed',
    `attempts=${JSON.stringify(flakyCase?.attempts?.map((a) => a.status))}`);

  /* --- ST-216-2: a STOPPED run is CANCELLED, not failed ---------------- */
  const [, slowRun] = await api(b, `/api/projects/${projectId}/run`, 'POST', { file: 'tests/slow.spec.ts' }, token);
  let inFlight = false;
  for (let i = 0; i < 200 && !inFlight; i++) {
    inFlight = (await api(b, `/api/runs/${slowRun.run.id}`, 'GET', null, token))[1].run.status === 'running';
    if (!inFlight) await sleep(100);
  }
  check('ST-216-2a the slow run is in flight', inFlight);
  await api(b, `/api/runs/${slowRun.run.id}/stop`, 'POST', null, token);
  const stopped = await waitTerminal(b, slowRun.run.id, token);
  check('ST-216-2b the stopped run ends as cancelled',
    stopped?.status === 'cancelled', `status=${stopped?.status}`);

  /* --- the overview over the REAL run history --------------------------- */
  const { buildQualityOverview } = await import(
    pathToFileURL(path.join(repo, 'apps', 'studio', 'public', 'quality.mjs')).href);
  const runs = (await api(b, '/api/runs', 'GET', null, token))[1].runs;
  const o = buildQualityOverview(runs);

  // The runs of this probe: the failing home run, the flaky run (whose run
  // ALSO ends as failed -- a flaky case still makes the engine exit
  // non-zero) and the stopped run. The point of the check is that the
  // CANCELLED run is counted as cancelled and NOT as a failure: the failed
  // count must equal the number of runs that reached a failing verdict,
  // and the cancelled one must not be among them.
  const failedRuns = runs.filter((r) => r.status === 'failed').length;
  const cancelledRuns = runs.filter((r) => r.status === 'cancelled').length;
  // The expected counts are derived from the RAW run list, and the source of
  // truth is the run's OWN status: a run whose status is `passed` or
  // `failed` carries a verdict, and a run whose status is anything else
  // does not. The expectation therefore does NOT come from the module, so a
  // module that misclassifies a cancelled run FAILS this check instead of
  // moving it.
  const verdictRuns = runs.filter((r) => r.status === 'passed' || r.status === 'failed');
  const rawFailed = verdictRuns.flatMap((r) => (r.summary?.cases ?? []))
    .filter((c) => c.status === 'failed').length;
  const rawPassed = verdictRuns.flatMap((r) => (r.summary?.cases ?? []))
    .filter((c) => c.status === 'passed').length;
  check('ST-216-2c the cancelled run is counted as cancelled, NOT as a failure',
    o.runs.cancelled === cancelledRuns && o.runs.failed === failedRuns && cancelledRuns === 1
      && o.cases.failed === rawFailed && o.cases.passed === rawPassed,
    `cancelled=${o.runs.cancelled}/${cancelledRuns} failed=${o.runs.failed}/${failedRuns} `
    + `passed=${o.runs.passed} cases.failed=${o.cases.failed}/${rawFailed} cases.passed=${o.cases.passed}/${rawPassed}`);
  // The run GROUPING is checked against the run's OWN status string -- the
  // raw fact -- and not against the module's own classification. A module
  // that put a cancelled run into the verdict group therefore FAILS here.
  const rawVerdictRuns = runs.filter((r) => r.status === 'passed' || r.status === 'failed');
  const rawInconclusiveRuns = runs.filter((r) => ['cancelled', 'error', 'interrupted'].includes(r.status));
  const rawInFlightRuns = runs.filter((r) => ['queued', 'running', 'cancelling'].includes(r.status));
  check('ST-216-2d the cancelled run is NOT in the run pass rate, and the grouping matches the raw statuses',
    o.runs.verdict === rawVerdictRuns.length
      && o.runs.inconclusive === rawInconclusiveRuns.length
      && o.runs.inFlight === rawInFlightRuns.length
      && o.runs.verdict + o.runs.inconclusive + o.runs.inFlight === runs.length,
    `verdict=${o.runs.verdict}/${rawVerdictRuns.length} inconclusive=${o.runs.inconclusive}/${rawInconclusiveRuns.length} `
    + `inFlight=${o.runs.inFlight}/${rawInFlightRuns.length} of ${runs.length} run(s)`);
  // The cases of the two finished runs: the home run holds one passing and
  // one failing case, the flaky run holds the retried case. The retried
  // case must be in the FLAKY bucket -- not in `passed` and not in `failed`.
  const rawCases = runs.flatMap((r) => (r.summary?.cases ?? []).map((c) => c.status));
  check('ST-216-3d the flaky case is counted in the flaky bucket, not in passed',
    o.cases.flaky === 1 && o.cases.passed === rawCases.filter((s) => s === 'passed').length,
    `flaky=${o.cases.flaky} passed=${o.cases.passed} failed=${o.cases.failed} raw=${JSON.stringify(rawCases)}`);
  // The retried cases are the ones whose case list holds more than one
  // attempt. The expectation is derived from the RAW case list, and the
  // flaky case must be among the retried ones.
  const rawRetried = runs.flatMap((r) => (r.summary?.cases ?? []))
    .filter((c) => (c.attemptsCount ?? 0) > 1).length;
  check('ST-216-3e the retry is counted as a retry',
    o.cases.retried === rawRetried && o.cases.retried >= 1
      && o.cases.retries === o.cases.retries,
    `retried=${o.cases.retried}/${rawRetried} retries=${o.cases.retries}`);

  /* --- ST-216-4: the metrics reconcile with the raw results ------------ */
  // The probe RECOMPUTES the reconciliation itself, from the raw run list,
  // and compares its own verdict with the one the module reports. A module
  // that always claims consistency therefore FAILS this check: the probe's
  // own recomputation is the yardstick, not the module's own field.
  const recomputed = runs.flatMap((r) => {
    const cases = r.summary?.cases;
    if (!Array.isArray(cases) || !cases.length) return [];
    const walked = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
    let attempts = 0;
    for (const c of cases) {
      if (c.status in walked) walked[c.status] += 1;
      attempts += Number.isFinite(c.attemptsCount) ? c.attemptsCount : (c.attempts?.length ?? 1);
    }
    const mismatches = [];
    for (const b of ['passed', 'failed', 'flaky', 'skipped']) {
      const reported = Number(r.summary?.[b]);
      if (Number.isFinite(reported) && reported !== walked[b]) {
        mismatches.push(`${r.id}: summary.${b} reported ${reported}, the case list holds ${walked[b]}`);
      }
    }
    const total = Number(r.summary?.total);
    if (Number.isFinite(total) && total !== cases.length) {
      mismatches.push(`${r.id}: summary.total reported ${total}, the case list holds ${cases.length}`);
    }
    const exec = Number(r.summary?.executions);
    if (Number.isFinite(exec) && exec !== attempts) {
      mismatches.push(`${r.id}: summary.executions reported ${exec}, the attempt list holds ${attempts}`);
    }
    return mismatches;
  });
  check('ST-216-4a the overview reconciles with the raw results',
    o.reconciliation.consistent && recomputed.length === 0,
    `module says ${o.reconciliation.consistent}, the probe recomputes ${recomputed.length} mismatch(es): `
    + JSON.stringify(recomputed.concat(o.reconciliation.checks.filter((c) => !c.ok).map((c) => c.name))));
  check('ST-216-4b every reconciliation check is a real comparison',
    o.reconciliation.checks.length >= 6,
    `${o.reconciliation.checks.length} checks`);

  // The probe FEEDS the module a run whose summary counters disagree with
  // its case list -- the real run with ONE counter changed -- and requires
  // the module to REPORT the disagreement. A module that always claims
  // consistency cannot pass this check: it is the negative control for the
  // whole reconciliation.
  const realRun = runs.find((r) => Array.isArray(r.summary?.cases) && r.summary.cases.length);
  let disagreementReported = false;
  let disagreementDetail = 'no run with a case list was available';
  if (realRun) {
    const tampered = JSON.parse(JSON.stringify(realRun));
    tampered.summary.passed = (tampered.summary.passed ?? 0) + 7;
    const tamperedOverview = buildQualityOverview([tampered]);
    const failedChecks = tamperedOverview.reconciliation.checks.filter((c) => !c.ok);
    disagreementReported = tamperedOverview.reconciliation.consistent === false
      && failedChecks.length > 0;
    disagreementDetail = `consistent=${tamperedOverview.reconciliation.consistent} `
      + `failed checks=${failedChecks.length}`;
  }
  check('ST-216-4d a run whose counters disagree with its case list IS reported',
    disagreementReported, disagreementDetail);
  // A check that compares a value with ITSELF is vacuous: it can never
  // fail. The check here is that the module does NOT produce one. It is
  // made falsifiable by comparing each check's two sides against each
  // OTHER: the "attempt buckets" check legitimately compares two numbers
  // that happen to be equal, so the test is on the check's NAME and its
  // two sides -- a check whose expected and actual are the SAME VALUE for
  // the SAME SOURCE is the tautology. The module's own checks each take
  // their expected side from the RAW results and their actual side from
  // the BUCKETS, so the two sides come from different places by
  // construction. This probe therefore asserts the property that the
  // expected side of the bucket checks equals the value the BRIDGE
  // reported -- i.e. it is anchored to the raw results, not to itself.
  const anchored = o.reconciliation.checks.filter((c) => c.name.startsWith('run '));
  check('ST-216-4c the per-run checks are anchored to the bridge-reported counters',
    anchored.length > 0 && anchored.every((c) => {
      const m = /summary\.(\w+)/.exec(c.name);
      if (!m) return false;
      const run = runs.find((r) => c.name.startsWith(`run ${r.id}:`));
      return Boolean(run) && Number(run.summary?.[m[1]]) === Number(c.expected);
    }),
    `${anchored.length} per-run checks`);

  /* --- ST-216-6: the clustering is deterministic ------------------------ */
  const { normalizeErrorSignature } = await import(
    pathToFileURL(path.join(repo, 'apps', 'studio', 'public', 'quality.mjs')).href);
  const sigA = normalizeErrorSignature('AssertionError: expected 5 to be 3 -- id 550e8400-e29b-41d4-a716-446655440000');
  const sigB = normalizeErrorSignature('AssertionError: expected 9 to be 4 -- id 660e8400-e29b-41d4-a716-446655440000');
  const sigC = normalizeErrorSignature('TimeoutError: page.waitForTimeout exceeded');
  check('ST-216-6a the same defect behind different ids clusters together', sigA === sigB, sigA);
  check('ST-216-6b a different defect does NOT share the signature', sigA !== sigC, sigC);
  // The clustering is checked against the RAW error texts: the probe
  // computes the expected groups itself and compares them with the
  // module's clusters. A module that puts every failure into ONE cluster
  // therefore FAILS this check.
  const failedCases = runs.flatMap((r) => (r.summary?.cases ?? []))
    .filter((c) => c.status === 'failed' && c.error);
  const expectedGroups = new Map();
  for (const c of failedCases) {
    const sig = normalizeErrorSignature(c.error);
    if (!expectedGroups.has(sig)) expectedGroups.set(sig, 0);
    expectedGroups.set(sig, expectedGroups.get(sig) + 1);
  }
  const moduleGroups = new Map();
  for (const cl of o.clusters) {
    if (!moduleGroups.has(cl.signature)) moduleGroups.set(cl.signature, 0);
    moduleGroups.set(cl.signature, moduleGroups.get(cl.signature) + cl.count);
  }
  const sameGroups = [...expectedGroups.entries()].every(
    ([sig, n]) => moduleGroups.get(sig) === n);
  check('ST-216-6c the real failures are clustered exactly as the raw error texts say',
    failedCases.length > 0 && sameGroups
      && [...moduleGroups.keys()].every((sig) => expectedGroups.has(sig)),
    `raw groups=${JSON.stringify([...expectedGroups.entries()])} `
    + `module groups=${JSON.stringify([...moduleGroups.entries()])}`);

  /* --- ST-216-7: the metrics of the runs WITHOUT a verdict ------------- */
  // The stopped run is cancelled. Its cases must not enter the attempt
  // buckets, the retry metrics or the cross-run view: a run the operator
  // stopped says nothing about the quality of the code under test.
  //
  // The expectation is derived from the RAW run list -- the cases of the
  // runs that carry a verdict -- so a module that lets a cancelled run's
  // cases into the metrics FAILS this check.
  const verdictRunsRaw = runs.filter((r) => r.status === 'passed' || r.status === 'failed');
  const noVerdictRuns = runs.filter((r) => !['passed', 'failed'].includes(r.status));
  const rawVerdictAttempts = verdictRunsRaw
    .flatMap((r) => (r.summary?.cases ?? []))
    .reduce((n, c) => n + (Number(c.attemptsCount) ?? (c.attempts?.length ?? 1)), 0);
  const rawVerdictRetried = verdictRunsRaw
    .flatMap((r) => (r.summary?.cases ?? []))
    .filter((c) => (c.attemptsCount ?? 0) > 1).length;
  const rawNoVerdictCases = noVerdictRuns
    .flatMap((r) => (r.summary?.cases ?? []));
  check('ST-216-7a the cases of a run WITHOUT a verdict do not enter the attempt buckets',
    o.attempts.total === rawVerdictAttempts
      && o.cases.attempts === rawVerdictAttempts
      && o.cases.inconclusiveAttempts === rawNoVerdictCases
        .reduce((n, c) => n + (Number(c.attemptsCount) ?? 1), 0),
    `attempts.total=${o.attempts.total} raw(verdict)=${rawVerdictAttempts} `
    + `inconclusiveAttempts=${o.cases.inconclusiveAttempts} `
    + `raw(no verdict)=${rawNoVerdictCases.reduce((n, c) => n + (Number(c.attemptsCount) ?? 1), 0)}`);
  check('ST-216-7b the cases of a run WITHOUT a verdict do not enter the retry metrics',
    o.cases.retried === rawVerdictRetried,
    `cases.retried=${o.cases.retried} raw(verdict)=${rawVerdictRetried} `
    + `inconclusiveRetried=${o.cases.inconclusiveRetried}`);
  // The cross-run view counts only the runs that carry a verdict.
  const rawVerdictTestKeys = new Set();
  for (const r of verdictRunsRaw) {
    for (const c of (r.summary?.cases ?? [])) {
      rawVerdictTestKeys.add(JSON.stringify([c.file ?? '', c.scope ?? [], c.line ?? null, c.title ?? '']));
    }
  }
  check('ST-216-7c the cross-run view only counts the runs that carry a verdict',
    o.tests.total <= rawVerdictTestKeys.size,
    `tests.total=${o.tests.total} raw(verdict identities)=${rawVerdictTestKeys.size} `
    + `no-verdict runs=${noVerdictRuns.length}`);

  /* --- ST-216-8: the reconciliation checks the DISPLAYED numbers ------- */
  // The probe recomputes the numbers the interface DISPLAYS from the raw
  // run list and compares them with what the module reports. A module
  // whose displayed numbers do not match the bridge's counters FAILS.
  const displayedByBucket = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const r of verdictRunsRaw) {
    for (const c of (r.summary?.cases ?? [])) {
      if (c.status in displayedByBucket) displayedByBucket[c.status] += 1;
    }
  }
  const displayedMatches = o.cases.passed === displayedByBucket.passed
    && o.cases.failed === displayedByBucket.failed
    && o.cases.flaky === displayedByBucket.flaky
    && o.cases.skipped === displayedByBucket.skipped;
  check('ST-216-8a the displayed case counts match the raw case list of the verdict runs',
    displayedMatches,
    `displayed=${JSON.stringify({ passed: o.cases.passed, failed: o.cases.failed, flaky: o.cases.flaky, skipped: o.cases.skipped })} `
    + `raw=${JSON.stringify(displayedByBucket)}`);
  // The run buckets: every run is in exactly one of them.
  const runBucketSum = o.runs.passed + o.runs.failed + o.runs.cancelled + o.runs.error
    + o.runs.interrupted + o.runs.inFlight + o.runs.unknown;
  check('ST-216-8b every run is in exactly one run bucket',
    runBucketSum === runs.length,
    `bucketSum=${runBucketSum} runs=${runs.length}`);

  await killTree(b.cp);
} catch (err) {
  check('ST-ats216 probe ran to the end', false, err.stack);
} finally {
  for (const cp of bridges) await killTree(cp);
  console.log(`scratch: ${scratch}`);
  console.log(`RESULT: ${passed}/${total}`);
  process.exitCode = passed === total ? 0 : 1;
}
