/**
 * ATS-301 ground-truth probe: run the fixture through the REAL Playwright CLI
 * and capture the exact JSON report shape.
 *
 * The Playwright half of the adapter has to be measured the same way the WDIO
 * half is: run the engine directly, then compare what the adapter expects
 * against what actually arrives.
 *
 * It answers:
 *   1. Does `PLAYWRIGHT_JSON_OUTPUT_FILE` still receive the JSON report?
 *   2. What is the shape of suite/spec/test in the JSON report?
 *   3. Which options does the installed CLI actually accept?
 *   4. What is the exit code of a run with a failing case?
 *
 * Usage: node tools/ats301-probes/playwright-ground-truth.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(REPO, 'examples', 'sample-playwright');
const OUT = process.env.ATS301_OUT || path.join(os.tmpdir(), 'ats301-pw-ground-truth');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const cli = path.join(FIXTURE, 'node_modules', '@playwright', 'test', 'cli.js');
if (!fs.existsSync(cli)) {
  console.log('SKIP: the fixture has no local @playwright/test -- run npm install in examples/sample-playwright first.');
  process.exit(2);
}

console.log('=== ATS-301 Playwright ground truth ===');
console.log(`fixture : ${FIXTURE}`);
console.log(`out dir : ${OUT}`);
console.log('');

// --- 1. which options does the installed CLI accept?
const help = spawnSync(process.execPath, [cli, 'test', '--help'], { encoding: 'utf8' });
const { parseCliOptions } = await import('../../server/adapters/contract.mjs');
const opts = parseCliOptions(help.stdout);
console.log('--- parsed CLI options ---');
console.log(opts.join(', '));
console.log('');
for (const k of ['reporter', 'output', 'trace', 'workers', 'grep', 'project', 'list']) {
  console.log(`  accepts --${k} : ${opts.includes(k)}`);
}
console.log('');

// --- 2. a real run: one passing case + one failing case
const reportFile = path.join(OUT, 'report.json');
const env = {
  ...process.env,
  PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
  PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(OUT, 'html'),
  PLAYWRIGHT_HTML_OPEN: 'never',
  CI: '1',
  FORCE_COLOR: '0',
};
const args = [cli, 'test', '--reporter=line,json,html', '--output', path.join(OUT, 'results'), '--trace', 'on', '--workers', '1'];
const r = spawnSync(process.execPath, args, {
  cwd: FIXTURE,
  encoding: 'utf8',
  timeout: 180000,
  env,
});
console.log(`--- run ---`);
console.log(`exit code : ${r.status}   (non-zero is expected: the fixture has one deliberate failure)`);
console.log(`stderr    : ${(r.stderr || '').split('\n').filter(Boolean).slice(0, 8).join('\n')}`);
console.log('');

console.log('--- files written into the output dir ---');
for (const name of fs.readdirSync(OUT)) {
  const st = fs.statSync(path.join(OUT, name));
  console.log(`  ${name} (${st.size} bytes)`);
}
console.log('');

if (!fs.existsSync(reportFile)) {
  console.log('RESULT: PLAYWRIGHT_JSON_OUTPUT_FILE did not receive a report.');
  console.log('--- stdout tail ---');
  console.log((r.stdout || '').split('\n').filter(Boolean).slice(-25).join('\n'));
  process.exit(1);
}

const parsed = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
console.log('--- JSON report shape ---');
console.log(`top-level keys : ${Object.keys(parsed).join(', ')}`);
function walk(s, depth = 0) {
  const pad = '  '.repeat(depth + 1);
  console.log(`${pad}suite keys : ${Object.keys(s).join(',')}`);
  console.log(`${pad}suite.file : ${JSON.stringify(s.file)}`);
  for (const spec of s.specs || []) {
    console.log(`${pad}spec keys=${Object.keys(spec).join(',')} title=${JSON.stringify(spec.title)} file=${JSON.stringify(spec.file)}`);
    for (const t of spec.tests || []) {
      console.log(`${pad}  test keys=${Object.keys(t).join(',')} status=${t.status} title=${JSON.stringify(spec.title)}`);
      console.log(`${pad}  test.results n=${(t.results || []).length} durations=${JSON.stringify((t.results || []).map((x) => x.duration))}`);
      console.log(`${pad}  test.error=${t.error ? JSON.stringify(t.error).slice(0, 140) : 'none'}`);
    }
  }
  for (const sub of s.suites || []) walk(sub, depth + 1);
}
for (const s of parsed.suites || []) walk(s);
console.log('');
console.log(`stats : ${JSON.stringify(parsed.stats)}`);
