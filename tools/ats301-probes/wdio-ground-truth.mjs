/**
 * ATS-301 ground-truth probe: run the fixture through the REAL WebdriverIO CLI
 * and capture the exact json-reporter output shape.
 *
 * This is the measurement that decides what the adapter may claim. It runs the
 * engine directly (not through the adapter) so the adapter's expectations can
 * be checked against reality rather than against assumption.
 *
 * It answers three questions the adapter's code depends on:
 *   1. WHERE does the json reporter write its ResultSet?
 *   2. WHAT is the shape of a suite / a test / an error?
 *   3. What EXIT CODE does a run with a failing case produce?
 *
 * Usage: node tools/ats301-probes/wdio-ground-truth.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(REPO, 'examples', 'sample-wdio');
const OUT = process.env.ATS301_OUT || path.join(os.tmpdir(), 'ats301-ground-truth');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const cli = path.join(FIXTURE, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');
if (!fs.existsSync(cli)) {
  console.log('SKIP: the fixture has no local @wdio/cli -- run npm install in examples/sample-wdio first.');
  process.exit(2);
}

// The reporter option is `outputDir` (the directory) -- the runner builds the
// file name as wdio-<cid>-<reporter>-reporter.log and the json reporter
// rewrites the .log suffix to .json.
const conf = path.join(OUT, 'wdio.conf.js');
fs.writeFileSync(conf, `
const base = require(${JSON.stringify(path.join(FIXTURE, 'wdio.conf.js'))});
module.exports.config = {
  ...base.config,
  specs: [
    ${JSON.stringify(path.join(FIXTURE, 'tests', 'pass.spec.js'))},
    ${JSON.stringify(path.join(FIXTURE, 'tests', 'fail.spec.js'))},
  ],
  reporters: [['json', { outputDir: ${JSON.stringify(OUT)} }]],
  logLevel: 'error',
};
`, 'utf8');

console.log('=== ATS-301 WDIO ground truth ===');
console.log(`fixture : ${FIXTURE}`);
console.log(`out dir : ${OUT}`);
console.log('');

const r = spawnSync(process.execPath, [cli, 'run', conf], {
  cwd: FIXTURE,
  encoding: 'utf8',
  timeout: 180000,
  env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
});
console.log(`exit code : ${r.status}   (non-zero is expected: the fixture has one deliberate failure)`);
console.log('');

console.log('--- files written into the output dir ---');
for (const name of fs.readdirSync(OUT)) {
  const st = fs.statSync(path.join(OUT, name));
  console.log(`  ${name} (${st.size} bytes)`);
}
console.log('');

const files = fs.readdirSync(OUT).filter((n) => n.endsWith('.json'));
if (!files.length) {
  console.log('RESULT: no json reporter output was produced.');
  console.log('--- stdout tail ---');
  console.log((r.stdout || '').split('\n').filter(Boolean).slice(-25).join('\n'));
  process.exit(1);
}

for (const file of files) {
  const parsed = JSON.parse(fs.readFileSync(path.join(OUT, file), 'utf8'));
  console.log(`--- json reporter ResultSet: ${file} ---`);
  console.log(`top-level keys : ${Object.keys(parsed).join(', ')}`);
  console.log(`state          : ${JSON.stringify(parsed.state)}`);
  console.log(`framework      : ${parsed.framework}`);
  console.log(`capabilities   : browserName=${parsed.capabilities?.browserName} browserVersion=${parsed.capabilities?.browserVersion}`);
  console.log(`suites n       : ${(parsed.suites || []).length}`);
  for (const s of parsed.suites || []) {
    console.log(`  suite keys : ${Object.keys(s).join(',')}`);
    console.log(`  suite name : ${s.name}`);
    console.log(`  suite.file : ${JSON.stringify(s.file)}  <-- does the suite carry the spec file?`);
    for (const t of s.tests || []) {
      console.log(`    test keys=${Object.keys(t).join(',')}`);
      console.log(`    test name="${t.name}" state=${t.state} duration=${t.duration}`);
      console.log(`    test.error=${t.error ? JSON.stringify(t.error) : 'none'}`);
    }
  }
  console.log(`specs          : ${JSON.stringify(parsed.specs)}`);
  console.log('');
}
