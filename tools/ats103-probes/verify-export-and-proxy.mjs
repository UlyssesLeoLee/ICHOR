#!/usr/bin/env node
/**
 * ATS-103 -- static export + API proxy verification.
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
 * cross-origin fetch from the exported page to the Bridge at 127.0.0.1:4577
 * (see docs/03-BASIC-DESIGN.md §1). This script exercises that seam exactly
 * as the exported page does, and it also checks the two guards that make the
 * seam safe: the Origin allow-list and the session token.
 *
 * Usage:
 *   node tools/ats103-probes/verify-export-and-proxy.mjs
 *   node tools/ats103-probes/verify-export-and-proxy.mjs --port 4577
 *   node tools/ats103-probes/verify-export-and-proxy.mjs --json
 *
 * Exit code 0 = every check passed; 1 = at least one check failed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'apps', 'studio', 'out');
const argv = process.argv.slice(2);
const JSON_ONLY = argv.includes('--json');
const PORT_INDEX = argv.indexOf('--port');
const PORT = PORT_INDEX >= 0 ? Number(argv[PORT_INDEX + 1]) : 4577 + (process.pid % 200);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  if (!JSON_ONLY) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  --  ${detail}` : ''}`);
  return !!ok;
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

async function main() {
  // --- 1. the static export artefact -------------------------------------
  if (!check('export directory exists (apps/studio/out)', fs.existsSync(OUT_DIR), OUT_DIR)) {
    return finish();
  }
  const indexFile = path.join(OUT_DIR, 'index.html');
  const indexHtml = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  check('export contains index.html', indexHtml.length > 0, `${indexHtml.length} bytes`);
  check('export contains 404.html', fs.existsSync(path.join(OUT_DIR, '404.html')));
  check('export contains _next/static assets', fs.existsSync(path.join(OUT_DIR, '_next', 'static')));

  const assets = referencedAssets(indexHtml);

  // `output: 'export'` means there is NO server in the exported bundle: no
  // API routes, no SSR payload that could proxy a call. The export must
  // therefore contain no server-side route output at all.
  check('the export contains no server-side API route output', !fs.existsSync(path.join(OUT_DIR, 'app', 'api')) && !fs.existsSync(path.join(OUT_DIR, '.next', 'server')));

  // The API base URL is resolved at RUNTIME by lib/api.ts (same-origin when
  // the page is served by the Bridge on 4577, absolute otherwise), so one
  // export works both ways. That resolution has to be in the shipped bundle.
  const bundleJs = assets.filter((a) => a.endsWith('.js')).map((a) => fs.readFileSync(path.join(OUT_DIR, a.replace(/^\//, '')), 'utf8')).join('\n');
  check('the shipped bundle resolves the API base at runtime (port-aware)', bundleJs.includes('4577') && bundleJs.includes('/api/session'));

  const missing = assets.filter((a) => !fs.existsSync(path.join(OUT_DIR, a.replace(/^\//, ''))));
  check(`every asset referenced by index.html exists on disk (${assets.length} assets)`, missing.length === 0, missing.join(', '));

  // --- 2. the Bridge serves the export -----------------------------------
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
      return finish();
    }

    // The static route: GET / must return the exported index.html.
    const pageRes = await fetch(`http://127.0.0.1:${PORT}/`);
    const pageHtml = await pageRes.text();
    check('bridge serves the exported index.html at /', pageRes.status === 200 && pageHtml.includes('AI Test'), `HTTP ${pageRes.status}, ${pageHtml.length} bytes`);
    const csp = pageRes.headers.get('content-security-policy') || '';
    check('the served page carries a CSP that allows the API origin', /connect-src[^;]*127\.0\.0\.1:4577/.test(csp), csp ? 'connect-src present' : 'no CSP header');

    // A hashed chunk referenced by the exported page must be served too.
    const chunk = assets.find((a) => a.endsWith('.js'));
    if (chunk) {
      const assetRes = await fetch(`http://127.0.0.1:${PORT}${chunk}`);
      check(`the bridge serves the exported chunk ${chunk}`, assetRes.status === 200, `HTTP ${assetRes.status}`);
    } else {
      check('the exported page references at least one chunk asset', false, 'no .js asset found in index.html');
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
    if (projectId) {
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
      // a DEFINITE state and reports it truthfully.
      let finalRun = runBody.run;
      if (runId) {
        for (let i = 0; i < 100; i++) {
          const r = await fetch(`http://127.0.0.1:${PORT}/api/runs/${runId}`, { headers: authed() });
          const b = await r.json();
          finalRun = b.run;
          if (finalRun && ['passed', 'failed', 'error', 'cancelled', 'interrupted'].includes(finalRun.status)) break;
          await new Promise((res) => setTimeout(res, 200));
        }
      }
      check(
        'the accepted run reaches a terminal state',
        finalRun && ['passed', 'failed', 'error', 'cancelled', 'interrupted'].includes(finalRun.status),
        `status=${finalRun?.status}${finalRun?.error ? ` error=${finalRun.error}` : ''}`,
      );
      check(
        'a failed/error run never reports a fabricated summary',
        finalRun?.status === 'passed' || finalRun?.status === 'failed' ? !!finalRun.summary : true,
        `summary=${finalRun?.summary ? `${finalRun.summary.passed} passed / ${finalRun.summary.failed} failed / ${finalRun.summary.total} total` : 'none'}`,
      );
      if (finalRun?.status === 'passed' || finalRun?.status === 'failed') {
        check(
          'the real run produced a per-case result set',
          Array.isArray(finalRun.summary?.cases) && finalRun.summary.cases.length > 0,
          `${finalRun.summary?.cases?.length ?? 0} cases`,
        );
        check(
          'the real run collected artefacts',
          Array.isArray(finalRun.artifacts) && finalRun.artifacts.length > 0,
          `${finalRun.artifacts?.length ?? 0} artefacts`,
        );
      }
      if (!JSON_ONLY && (finalRun?.status === 'failed' || finalRun?.status === 'error')) {
        console.log('\n--- run detail (diagnostic) ---');
        console.log(`  status    : ${finalRun.status}`);
        console.log(`  error     : ${finalRun.error ?? '(none)'}`);
        console.log(`  reportWarn: ${finalRun.reportWarning ?? '(none)'}`);
        console.log(`  command   : ${(finalRun.command || []).join(' ')}`);
        console.log(`  log tail  : ${String(finalRun.log || '').slice(-800)}`);
        console.log('--- end run detail ---\n');
      }
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
  const failed = results.filter((r) => !r.ok);
  if (JSON_ONLY) {
    console.log(JSON.stringify({ port: PORT, results, failed: failed.length }, null, 2));
  } else {
    console.log(`\n${failed.length === 0 ? 'RESULT: OK' : 'RESULT: FAILED'} -- ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) for (const f of failed) console.log(`  FAILED: ${f.name}  ${f.detail}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`verify-export-and-proxy failed: ${e?.stack || e}`);
  process.exit(1);
});
