#!/usr/bin/env node
/**
 * ATS-103 -- static export + API seam verification.
 *
 * Verifies the three claims ATS-103 has to stand on, on a real machine:
 *
 *   1. the Next.js 16 static export produced a usable artefact directory
 *      (apps/studio/out): index.html, the 404 page, and every asset the
 *      exported HTML references actually exist on disk;
 *   2. the Bridge serves that export over HTTP (the static route), including
 *      the hashed chunk assets, with the CSP that allows the API origin;
 *   3. the API seam the UI uses really works: session -> projects -> run,
 *      over real HTTP, from a browser-like Origin, with the same
 *      X-ATS-Token handshake apps/studio/lib/api.ts performs.
 *
 * The proxy is NOT a Next.js rewrite: `output: 'export'` means the exported
 * bundle contains no API routes and no server, so the "API proxy" is the
 * cross-origin fetch from the exported page to the Bridge. This script
 * exercises that seam over real HTTP and also checks the two guards that
 * make the seam safe: the Origin allow-list and the session token.
 *
 * FAIL-CLOSED (ATS-103 review round 1, finding C2)
 * ------------------------------------------------
 * The number of checks is a CONSTANT. A check that cannot be evaluated is
 * recorded as a FAIL, not skipped: the run is only allowed to reach
 * `passed`/`failed`, and it must carry a non-empty per-case result set, a
 * summary that agrees with the report the engine wrote on disk, and a
 * non-empty artefact list. A run that ends in `error`/`cancelled`/
 * `interrupted`, or that never terminates, fails the probe.
 *
 * PORT (ATS-103 review round 1, finding C5)
 * -----------------------------------------
 * The default port is the Bridge's own default. A non-default port is a
 * configuration in which the REAL UI is unusable -- the exported page
 * resolves the API base to the default port and the Bridge's CSP allows
 * only the default port (docs/16-BASELINE-ADR.md §3.1 item 2) -- so the
 * probe never runs on one silently: it refuses unless the port was given
 * explicitly with `--port`, and it then records that the result describes
 * the API seam only, not a working UI.
 *
 * Usage:
 *   node tools/ats103-probes/verify-export-and-proxy.mjs
 *   node tools/ats103-probes/verify-export-and-proxy.mjs --port <n>
 *   node tools/ats103-probes/verify-export-and-proxy.mjs --json
 *
 * Exit code 0 = every check passed; 1 = at least one check failed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPort } from './lib/default-port.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'apps', 'studio', 'out');
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

/**
 * The number of checks the probe runs. It is a CONSTANT, not a counter of
 * what happened: a check that is skipped, unreachable or never reached is
 * still a check, and a run whose executed check count differs from this
 * number has silently dropped one -- which is itself a failure.
 */
const EXPECTED_CHECKS = 25;

/**
 * The names of the checks that must have run. The self-check (the check
 * that compares the executed count against the constant) is NOT in this
 * list: it is the one check that cannot have run yet when the comparison
 * is made.
 */
const EXPECTED_NAMES = [
  'export directory exists (apps/studio/out)',
  'export contains index.html',
  'export contains 404.html',
  'export contains _next/static assets',
  'the export contains no server-side API route output',
  'every asset referenced by index.html exists on disk',
  'the shipped bundle carries a comparison of the page location port',
  'bridge boots and answers /api/health',
  'bridge serves the exported index.html at /',
  'the served page carries a CSP that allows the API origin',
  'the bridge serves the exported chunk',
  'GET /api/session returns a token',
  'a foreign Origin is rejected (403)',
  'an unauthenticated API call is rejected (401)',
  'GET /api/projects succeeds with the session token',
  'POST /api/projects registers the sample Playwright project',
  'GET /api/projects/{id}/tests returns the static index',
  'POST /api/projects/{id}/run is accepted (202)',
  'the accepted run reaches a passed/failed terminal state',
  'the terminal run reports a per-case result set',
  'the terminal run summary matches the on-disk report.json',
  'the terminal run collected artefacts',
  'the collected artefacts include report.json',
  'GET /api/runs lists the run history',
];

const results = [];
/** The expected check names that have been run. */
const done = new Set();

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  // A check name may carry a dynamic suffix (e.g. the chunk's hashed
  // filename), so an expected name counts as run when a recorded name
  // STARTS WITH it.
  for (const expected of EXPECTED_NAMES) {
    if (name.startsWith(expected)) done.add(expected);
  }
  if (!JSON_ONLY) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  --  ${detail}` : ''}`);
  return !!ok;
}

/**
 * Registers a check that could not be evaluated at all (the probe could not
 * get far enough to run it). It is recorded as a FAIL, so the total count
 * stays constant and the run cannot silently shrink.
 */
function failUnreached(name, detail) {
  return check(name, false, detail || 'not reached');
}

/**
 * Registers every check that has NOT run yet as a FAIL.
 *
 * The probe's check list is a constant, so a run that cannot get past a
 * certain point must still report every remaining check -- as a FAIL, with
 * the reason. Otherwise a broken environment would produce a SHORT report
 * that looks like a smaller, successful run. This closes the hole the
 * first review found (C2): the total is always the same, and the missing
 * ones are always visible as failures.
 */
function failRemaining(detail) {
  for (const name of EXPECTED_NAMES) {
    if (!done.has(name)) failUnreached(name, detail);
  }
}

/** Every asset path referenced by the exported HTML, relative to the export root. */
function referencedAssets(html) {
  const out = new Set();
  const re = /(?:src|href)="(\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const p = m[1];
    if (p.startsWith('/_next/') || p.startsWith('/fallback')) out.add(p);
  }
  return [...out].sort();
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

/**
 * Every file and directory under the export directory, relative to the
 * export root. The check for "no server-side route output" is made against
 * this REAL tree, not against two paths Next.js never writes to.
 */
function walkExport(dir, prefix = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkExport(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** Whether the port is free. A busy port would make the probe talk to a DIFFERENT server. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * The per-case status counts of a Playwright JSON report.
 *
 * Two counting bases exist and the summary may come from either one: the
 * adapter counts one entry per RESULT (a retried case is several entries),
 * the raw parser counts one entry per TEST. Both are returned so the
 * comparison below can accept either, and both are compared on the SAME
 * basis, so a summary that agrees with neither is rejected.
 */
function reportCounts(report) {
  const exec = { passed: 0, failed: 0, skipped: 0, flaky: 0, unknown: 0, total: 0 };
  const test = { passed: 0, failed: 0, skipped: 0, flaky: 0, unknown: 0, total: 0 };
  const map = (s) => {
    if (s === 'expected') return 'passed';
    if (s === 'flaky') return 'flaky';
    if (s === 'skipped') return 'skipped';
    if (s === 'unexpected') return 'failed';
    return 'unknown';
  };
  const walk = (s) => {
    for (const spec of s.specs || []) {
      for (const t of spec.tests || []) {
        const status = t.status || 'unknown';
        test[map(status)]++;
        test.total++;
        const results = Array.isArray(t.results) && t.results.length ? t.results : [{}];
        for (const r of results) {
          exec[map(status)]++;
          exec.total++;
        }
      }
    }
    for (const sub of s.suites || []) walk(sub);
  };
  for (const suite of report.suites || []) walk(suite);
  return { exec, test };
}

function countsMatch(summary, counts) {
  if (!summary || !counts) return false;
  return summary.passed === counts.passed
    && summary.failed === counts.failed
    && summary.skipped === counts.skipped
    && summary.flaky === counts.flaky
    && summary.total === counts.total;
}

async function main() {
  // --- 1. the static export artefact -------------------------------------
  if (!check('export directory exists (apps/studio/out)', fs.existsSync(OUT_DIR), OUT_DIR)) {
    // The remaining export checks cannot be evaluated. They are registered
    // as FAILs so that the check count stays constant.
    failRemaining('the export directory does not exist');
    return finish();
  }
  const indexFile = path.join(OUT_DIR, 'index.html');
  const indexHtml = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  // The size is reported in BYTES (the file's real size on disk), not in
  // JavaScript string length: the latter is the UTF-16 code-unit count and
  // differs from the byte count for any non-ASCII content.
  const indexBytes = fs.existsSync(indexFile) ? fs.statSync(indexFile).size : 0;
  check('export contains index.html', indexBytes > 0, `${indexBytes} bytes`);
  check('export contains 404.html', fs.existsSync(path.join(OUT_DIR, '404.html')));
  check('export contains _next/static assets', fs.existsSync(path.join(OUT_DIR, '_next', 'static')));

  const assets = referencedAssets(indexHtml);

  // `output: 'export'` means there is NO server in the exported bundle: no
  // API routes, no SSR payload that could proxy a call. The assertion is
  // made against the REAL tree of the export: a server-side route output
  // would appear as an `api/...` entry (a FILE or a DIRECTORY) at the top
  // of the export directory. Checking two paths that Next.js never writes
  // to (`out/app/api`, `out/.next/server`) cannot fail, so the check is
  // made over every exported entry instead.
  //
  // Two shapes of `app/api/**/route.ts` exist, and only ONE of them is
  // caught by this check:
  //
  //   - a handler that does NOT declare `export const dynamic =
  //     'force-static'` is REFUSED by the build ("export const dynamic =
  //     'force-static'/export const revalidate not configured on route
  //     ... with output: export"), so no export is produced at all. The
  //     build rejecting it proves the build rejects it; it does not
  //     exercise this assertion, because there is no export tree to walk.
  //
  //   - a handler that DOES declare `export const dynamic =
  //     'force-static'` is ACCEPTED by the build and PRERENDERED into the
  //     export as the static file `out/api/session`. That is the shape
  //     this assertion exists to catch, and the shape the mutation
  //     evidence (docs/evidence/ATS-103/06-mutation-evidence.log, mutation
  //     A') exercises: the probe reports "FAIL the export contains no
  //     server-side API route output -- found: api/session" and exits 1.
  const exportedEntries = walkExport(OUT_DIR);
  const serverRouteOutputs = exportedEntries.filter(
    (rel) => rel === 'api' || rel.startsWith('api/') || rel.startsWith('.next/server'),
  );
  check(
    'the export contains no server-side API route output',
    serverRouteOutputs.length === 0,
    serverRouteOutputs.length
      ? `found: ${serverRouteOutputs.join(', ')}`
      : `${exportedEntries.length} exported entries, none of them a server route`,
  );

  const missing = assets.filter((a) => !fs.existsSync(path.join(OUT_DIR, a.replace(/^\//, ''))));
  check(`every asset referenced by index.html exists on disk (${assets.length} assets)`, missing.length === 0, missing.join(', '));

  // The API base is supposed to be resolved at RUNTIME from the page's own
  // location. What can be established from the SHIPPED BUNDLE alone is a
  // STATIC HEURISTIC, and the heuristic is stated exactly here:
  //
  //   the bundle must READ `location.port` and COMPARE it against a literal,
  //   and it must reference the session path.
  //
  // What that heuristic does NOT establish: that the comparison is what
  // SELECTS the API base. A bundle that bakes the base in AND carries an
  // unrelated `location.port` comparison satisfies this check. That
  // counter-example (mutation B2 in
  // docs/evidence/ATS-103/06-mutation-evidence.log) leaves this check GREEN
  // -- which is exactly why the check is described as a heuristic and not as
  // a proof.
  //
  // The PROOF that the base is resolved at runtime is EXECUTED, not
  // inferred: tools/ats103-probes/ui-smoke.mjs opens the exported page by
  // NAME (`localhost`) and records the host every API request actually went
  // to. A runtime-resolved base is relative on the Bridge's own port and
  // therefore goes to `localhost:<port>`; a baked base is absolute and goes
  // to the numeric address. That discriminator is what turns red under both
  // mutation B and mutation B2.
  const bundleJs = assets
    .filter((a) => a.endsWith('.js'))
    .map((a) => fs.readFileSync(path.join(OUT_DIR, a.replace(/^\//, '')), 'utf8'))
    .join('\n');
  const readsLocation = /location\s*\.\s*port/.test(bundleJs);
  const hasSessionPath = bundleJs.includes('/api/session');
  // The bundle must COMPARE the port, not merely mention it: the compiled
  // form of the runtime base check is a comparison between the location's
  // port and the default port. Without the comparison the bundle could be
  // reading the port for some unrelated purpose.
  //
  // Both orders are accepted, because the minifier may emit either the
  // literal-first or the property-first form of the comparison.
  const comparesPort = new RegExp(
    `(?:location\\s*\\.\\s*port|window\\s*\\.\\s*location\\s*\\.\\s*port)\\s*(?:===|==|!==|!=)`,
  ).test(bundleJs) || new RegExp(
    `(?:===|==|!==|!=)\\s*(?:window\\s*\\.\\s*location\\s*\\.\\s*port|location\\s*\\.\\s*port)`,
  ).test(bundleJs);
  // ONE check, ONE predicate. The two claims ("the base is resolved from
  // the location" and "the base is not baked in") are the SAME predicate
  // read from two sides, so they are asserted once: a second check computed
  // from the same predicate would be the same check twice, and a reader
  // would read it as two independent pieces of evidence.
  check(
    'the shipped bundle carries a comparison of the page location port',
    readsLocation && comparesPort && hasSessionPath,
    `reads location.port: ${readsLocation}, compares it: ${comparesPort}, references /api/session: ${hasSessionPath}`,
  );

  // --- 2. the Bridge serves the export -----------------------------------
  if (!(await portIsFree(PORT))) {
    failRemaining(`port ${PORT} is already in use -- the probe would talk to a DIFFERENT server`);
    return finish();
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats103-'));
  const child = spawn(process.execPath, [path.join('server', 'index.mjs')], {
    cwd: REPO_ROOT,
    env: { ...process.env, ATS_PORT: String(PORT), ATS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (b) => stderr.push(b.toString()));
  child.stdout.on('data', () => {});

  try {
    if (!check('bridge boots and answers /api/health', await waitReady(PORT))) {
      failRemaining('the bridge did not boot');
      return finish();
    }

    // The static route: GET / must return the exported index.html.
    const pageRes = await fetch(`http://127.0.0.1:${PORT}/`);
    const pageHtml = await pageRes.text();
    check('bridge serves the exported index.html at /', pageRes.status === 200 && pageHtml.includes('AI Test'), `HTTP ${pageRes.status}, ${Buffer.byteLength(pageHtml)} bytes`);
    const csp = pageRes.headers.get('content-security-policy') || '';
    const cspAllowsDefault = new RegExp(`connect-src[^;]*127\\.0\\.0\\.1:${DEFAULT_PORT}`).test(csp);
    check('the served page carries a CSP that allows the API origin', cspAllowsDefault, csp ? `connect-src allows 127.0.0.1:${DEFAULT_PORT}` : 'no CSP header');

    // A hashed chunk referenced by the exported page must be served too.
    const chunk = assets.find((a) => a.endsWith('.js'));
    if (chunk) {
      const assetRes = await fetch(`http://127.0.0.1:${PORT}${chunk}`);
      check(`the bridge serves the exported chunk ${chunk}`, assetRes.status === 200, `HTTP ${assetRes.status}`);
    } else {
      check('the bridge serves the exported chunk', false, 'no .js asset found in index.html');
    }

    // --- 3. the API seam, exactly as apps/studio/lib/api.ts uses it ------
    const origin = `http://127.0.0.1:${PORT}`;
    const sessionRes = await fetch(`http://127.0.0.1:${PORT}/api/session`, { headers: { Origin: origin } });
    const session = await sessionRes.json();
    check('GET /api/session returns a token', sessionRes.status === 200 && !!session.token);

    const badOrigin = await fetch(`http://127.0.0.1:${PORT}/api/session`, { headers: { Origin: 'https://evil.example' } });
    check('a foreign Origin is rejected (403)', badOrigin.status === 403, `HTTP ${badOrigin.status}`);

    const noToken = await fetch(`http://127.0.0.1:${PORT}/api/projects`);
    check('an unauthenticated API call is rejected (401)', noToken.status === 401, `HTTP ${noToken.status}`);

    const authed = (extra = {}) => ({
      Origin: origin,
      'X-ATS-Token': session.token,
      'Content-Type': 'application/json',
      ...extra,
    });

    const projectsRes = await fetch(`http://127.0.0.1:${PORT}/api/projects`, { headers: authed() });
    const projects = await projectsRes.json();
    check('GET /api/projects succeeds with the session token', projectsRes.status === 200 && Array.isArray(projects.projects));

    // Register the repository's own Playwright fixture: a real project, added
    // through the real endpoint, so the run below is a real run request.
    const fixture = path.join(REPO_ROOT, 'examples', 'sample-playwright');
    const addRes = await fetch(`http://127.0.0.1:${PORT}/api/projects`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ path: fixture }),
    });
    const added = await addRes.json();
    check('POST /api/projects registers the sample Playwright project', addRes.status === 201 && !!added.project?.id, `HTTP ${addRes.status}`);

    const projectId = added.project?.id;
    if (!projectId) {
      failRemaining('the project was not registered');
      return finish();
    }

    const testsRes = await fetch(`http://127.0.0.1:${PORT}/api/projects/${projectId}/tests`, { headers: authed() });
    const tests = await testsRes.json();
    check('GET /api/projects/{id}/tests returns the static index', testsRes.status === 200 && Array.isArray(tests.tests) && tests.tests.length > 0, `${tests.tests?.length ?? 0} tests`);

    const runRes = await fetch(`http://127.0.0.1:${PORT}/api/projects/${projectId}/run`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ file: null }),
    });
    const runBody = await runRes.json();
    const runId = runBody.run?.id;
    check('POST /api/projects/{id}/run is accepted (202)', runRes.status === 202, `HTTP ${runRes.status}`);

    // Poll the run to a terminal state. The accepted run is not the
    // deliverable by itself: the deliverable is that the operation reaches
    // a DEFINITE state and reports it truthfully. Only `passed` and
    // `failed` count -- `error`, `cancelled` and `interrupted` are failures
    // of the run itself, and a run that never terminates is a timeout.
    // The fixture is deliberately one-pass / one-fail, so `failed` is the
    // EXPECTED terminal state of a healthy run.
    let finalRun = runBody.run;
    if (runId) {
      for (let i = 0; i < 300; i++) {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/runs/${runId}`, { headers: authed() });
        const b = await r.json();
        finalRun = b.run;
        if (finalRun && ['passed', 'failed', 'error', 'cancelled', 'interrupted'].includes(finalRun.status)) break;
        await new Promise((res) => setTimeout(res, 200));
      }
    }
    const terminalOk = !!finalRun && ['passed', 'failed'].includes(finalRun.status);
    check(
      'the accepted run reaches a passed/failed terminal state',
      terminalOk,
      `status=${finalRun?.status}${finalRun?.error ? ` error=${finalRun.error}` : ''}`,
    );
    check(
      'the terminal run reports a per-case result set',
      terminalOk && Array.isArray(finalRun?.summary?.cases) && finalRun.summary.cases.length > 0,
      `${finalRun?.summary?.cases?.length ?? 0} cases`,
    );

    // The summary must agree with the report the engine actually wrote.
    // This replaces the previous, vacuous "no fabricated summary" assertion:
    // the summary is compared against the on-disk report.json, so an empty
    // or fabricated summary cannot pass.
    const reportFile = path.join(dataDir, 'runs', String(runId || ''), 'report.json');
    let counts = null;
    if (fs.existsSync(reportFile)) {
      try {
        counts = reportCounts(JSON.parse(fs.readFileSync(reportFile, 'utf8')));
      } catch {
        counts = null;
      }
    }
    const summary = finalRun?.summary;
    const summaryMatches = terminalOk && !!counts && (countsMatch(summary, counts.exec) || countsMatch(summary, counts.test));
    const summaryText = summary ? `${summary.passed}/${summary.failed}/${summary.skipped}/${summary.flaky}/${summary.total}` : 'none';
    const reportText = counts ? `${counts.exec.passed}/${counts.exec.failed}/${counts.exec.skipped}/${counts.exec.flaky}/${counts.exec.total}` : 'missing';
    check(
      'the terminal run summary matches the on-disk report.json',
      summaryMatches,
      summaryMatches
        ? `summary and report.json agree (${summaryText})`
        : `summary=${summaryText}, report.json=${reportText}`,
    );

    const artifacts = finalRun?.artifacts;
    check(
      'the terminal run collected artefacts',
      terminalOk && Array.isArray(artifacts) && artifacts.length > 0,
      `${artifacts?.length ?? 0} artefacts`,
    );
    check(
      'the collected artefacts include report.json',
      terminalOk && Array.isArray(artifacts) && artifacts.some((a) => a.file === 'report.json'),
      Array.isArray(artifacts) ? artifacts.filter((a) => a.file === 'report.json').length + ' report.json entries' : 'no artefacts',
    );

    if (!JSON_ONLY && (finalRun?.status === 'failed' || finalRun?.status === 'error')) {
      console.log('\n--- run detail (diagnostic) ---');
      console.log(`  status    : ${finalRun.status}`);
      console.log(`  error     : ${finalRun.error ?? '(none)'}`);
      console.log(`  reportWarn: ${finalRun.reportWarning ?? '(none)'}`);
      console.log(`  command   : ${(finalRun.command || []).join(' ')}`);
      console.log(`  log tail  : ${String(finalRun.log || '').slice(-800)}`);
      console.log('--- end run detail ---\n');
    }

    const runsRes = await fetch(`http://127.0.0.1:${PORT}/api/runs`, { headers: authed() });
    const runs = await runsRes.json();
    check('GET /api/runs lists the run history', runsRes.status === 200 && Array.isArray(runs.runs) && runs.runs.length >= 1, `${runs.runs?.length ?? 0} runs`);
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return finish();
}

function finish() {
  // The check list is a constant. A run that executed fewer (or more)
  // checks than the constant has dropped or duplicated one, which is a
  // failure of the probe itself -- not a detail to be glossed over.
  // The self-check is the LAST check, so the count of the checks before it
  // must be EXPECTED_CHECKS - 1.
  const missing = EXPECTED_NAMES.filter((n) => !done.has(n));
  const countOk = results.length === EXPECTED_CHECKS - 1 && missing.length === 0;
  check(
    'the probe executed every registered check',
    countOk,
    countOk
      ? `${results.length + 1}/${EXPECTED_CHECKS} checks executed`
      : `${results.length + 1}/${EXPECTED_CHECKS} checks executed; never ran: ${missing.join(', ')}`,
  );

  const failed = results.filter((r) => !r.ok);
  if (JSON_ONLY) {
    console.log(JSON.stringify({ port: PORT, results, failed: failed.length }, null, 2));
  } else {
    console.log(`\n${failed.length === 0 ? 'RESULT: OK' : 'RESULT: FAILED'} -- ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) for (const f of failed) console.log(`  FAILED: ${f.name}  ${f.detail}`);
    if (PORT !== DEFAULT_PORT) {
      console.log('');
      console.log(`NOTE: the probe ran on port ${PORT}, NOT the default.`);
      console.log('      On a non-default port the REAL UI is unusable: the exported page');
      console.log('      resolves the API base to the default port and the Bridge CSP allows');
      console.log('      only the default port (docs/16-BASELINE-ADR.md §3.1 item 2).');
      console.log('      This run therefore verifies the API SEAM only, not a working UI.');
    }
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`verify-export-and-proxy failed: ${e?.stack || e}`);
  process.exit(1);
});
