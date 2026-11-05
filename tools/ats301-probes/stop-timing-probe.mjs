/**
 * ATS-301 probe: measure a NATURAL run and a STOPPED run for both engines.
 *
 * Purpose: design a FALSIFIABLE stop() assertion. The review found that
 * IT-ADP-011 asserted only "the exit code is not 0", which is constant for
 * these fixtures (they contain a deliberately failing case), so a no-op
 * stop() still passed. This probe prints the numbers that a real assertion
 * has to be built on: how long a natural run takes, how long a stopped run
 * takes, and how many cases each run reported.
 *
 * Usage: node tools/ats301-probes/stop-timing-probe.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlaywrightAdapter } from '../../server/adapters/playwright.mjs';
import { createWdioAdapter } from '../../server/adapters/wdio.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats301-stop-'));

const engines = [
  { name: 'playwright', adapter: createPlaywrightAdapter(), project: { id: 'p', root: path.join(root, 'examples', 'sample-playwright') } },
  { name: 'wdio', adapter: createWdioAdapter(), project: { id: 'w', root: path.join(root, 'examples', 'sample-wdio') } },
];

function waitForExit(child, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve(code); });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

for (const eng of engines) {
  for (const mode of ['natural', 'stopped']) {
    const out = path.join(tmp, `${eng.name}-${mode}`);
    fs.mkdirSync(out, { recursive: true });
    const t0 = Date.now();
    const handle = eng.adapter.start({ project: eng.project, run: {}, file: null, outputDir: out });
    if (mode === 'stopped') {
      // Give the engine a moment to actually get going before stopping it.
      await new Promise((r) => setTimeout(r, 500));
      eng.adapter.stop(handle);
    }
    let code = null;
    let err = '';
    try {
      code = await waitForExit(handle.child);
    } catch (e) {
      err = e.message;
    }
    const elapsed = Date.now() - t0;
    const collected = eng.adapter.collect({ outputDir: out });
    console.log(JSON.stringify({
      engine: eng.name,
      mode,
      elapsedMs: elapsed,
      exitCode: code,
      error: err,
      reportPresent: Boolean(collected),
      total: collected ? collected.summary.total : null,
      passed: collected ? collected.summary.passed : null,
      failed: collected ? collected.summary.failed : null,
    }));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
