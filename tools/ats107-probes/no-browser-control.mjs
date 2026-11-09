/**
 * The negative control for the "REAL browser" check of ATS-107.
 *
 *   node tools/ats107-probes/no-browser-control.mjs <results-dir>
 *
 * WHAT IT PROVES
 * --------------
 * The acceptance criterion says 「Chromium 上至少 1 PASS 1 FAIL」. A
 * `trace.zip` on disk does NOT prove a browser ran: a fixture whose specs
 * never ask for a `page` still writes a trace archive, and the
 * test-runner's own trace inside it mentions the browser name in fields
 * that have nothing to do with a browser.
 *
 * So the probe's real-browser check reads the BROWSER CONTEXT trace: the
 * engine writes one trace file per browser context (`<n>-trace.trace`),
 * and its first event is a `context-options` event naming the browser that
 * was actually launched.
 *
 * This control runs the fixture in BOTH shapes:
 *
 *   1. the REAL fixture (the specs take a `page`) -- the check must ACCEPT;
 *   2. the MUTATED fixture (the specs never take a `page`, so no browser is
 *      launched) -- the check must REJECT.
 *
 * A check that accepts both is not checking anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromiumInAny } from './lib/trace.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ats107-nobrowser-'));

let passed = 0;
let total = 0;
const check = (id, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` -- ${detail}` : ''}`);
};

/** Copy the fixture and rewrite its two specs. */
function makeFixture(name, specs) {
  const src = path.join(repo, 'examples', 'real-browser-fixture');
  const dst = path.join(scratch, name);
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => !p.includes('node_modules') && !p.includes('test-results') && !p.includes('playwright-report'),
  });
  for (const [file, body] of Object.entries(specs)) {
    fs.writeFileSync(path.join(dst, 'tests', file), body, 'utf8');
  }
  return dst;
}

/** npm ci, then run the engine's own CLI with tracing on. */
async function runFixture(project, outDir) {
  await new Promise((resolve) => {
    const c = spawn('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: project, stdio: 'ignore', shell: process.platform === 'win32',
    });
    c.on('close', resolve);
  });
  const cli = path.join(project, 'node_modules', '@playwright', 'test', 'cli.js');
  await new Promise((resolve) => {
    const c = spawn(process.execPath, [cli, 'test', '--reporter=line', '--output', outDir, '--trace', 'on', '--workers', '1'], {
      cwd: project, stdio: 'ignore', env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
    c.on('close', resolve);
  });
  const traces = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'trace.zip') traces.push(full);
    }
  };
  walk(outDir);
  return traces;
}

/* --- 1. the REAL fixture: a browser IS launched -------------------------- */
const realProject = makeFixture('real', {});
const realTraces = await runFixture(realProject, path.join(scratch, 'real-results'));
const realVerdict = chromiumInAny(realTraces);
check('the real fixture (the specs take a page) is ACCEPTED as a real-browser run',
  realVerdict.ok, realVerdict.detail);

/* --- 2. the MUTATED fixture: NO browser is launched ---------------------- */
const noBrowserProject = makeFixture('no-browser', {
  'passing.spec.ts': `import { test, expect } from '@playwright/test';
import { PASSING_TITLE } from './constants';
test(PASSING_TITLE, async () => { expect('ATS-107 PASS').toBe('ATS-107 PASS'); });
`,
  'failing.spec.ts': `import { test, expect } from '@playwright/test';
import { EXPECTED_FAILURE_TEXT, FAILING_TITLE } from './constants';
test(FAILING_TITLE, async () => { expect('ATS-107 PASS').toBe(EXPECTED_FAILURE_TEXT); });
`,
});
const noBrowserTraces = await runFixture(noBrowserProject, path.join(scratch, 'no-browser-results'));
const noBrowserVerdict = chromiumInAny(noBrowserTraces);
check('the mutated fixture (the specs never take a page) is REJECTED: no browser context',
  !noBrowserVerdict.ok, noBrowserVerdict.detail);

/* --- 3. the mutated fixture STILL writes a trace archive ------------------ */
check('the mutated fixture still writes a trace.zip (so the archive alone proves nothing)',
  noBrowserTraces.length >= 1, `${noBrowserTraces.length} trace(s) written without a browser`);

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`RESULT: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
