#!/usr/bin/env node
/**
 * ATS-204: the facts of the CLI that the identity mapper needs.
 *
 * The mapper has to decide the identity of a case whose title is RENDERED
 * (`test.each`) and of a case that runs in SEVERAL Playwright projects. Both
 * need facts about what the CLI actually reports, so this probe MEASURES them
 * against a REAL `@playwright/test` (1.64.1).
 *
 * Usage: node tools/ats204-probes/cli-facts.mjs
 *
 * The environment variables:
 *   ATS204_WORKDIR -- the scratch directory (default: a temp dir)
 *   ATS204_REUSE   -- '1' keeps an existing installation in the scratch dir
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.ATS204_WORKDIR || path.join(os.tmpdir(), 'ats204-cli-facts');
const FIXTURE = path.join(WORK, 'project');
const PLAYWRIGHT_VERSION = '1.64.1';

const log = (...a) => console.log(...a);
let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
};

fs.mkdirSync(path.join(FIXTURE, 'tests'), { recursive: true });
fs.writeFileSync(path.join(FIXTURE, 'package.json'), '{"name":"ats204-cli-facts","private":true}', 'utf8');
fs.writeFileSync(
  path.join(FIXTURE, 'playwright.config.ts'),
  `import { defineConfig, devices } from '@playwright/test';\n`
  + `export default defineConfig({\n`
  + `  testDir: './tests',\n`
  + `  timeout: 20000,\n`
  + `  retries: 0,\n`
  + `  projects: [\n`
  + `    { name: 'alpha', use: { ...devices['Desktop Chrome'] } },\n`
  + `    { name: 'beta', use: { ...devices['Desktop Firefox'] } },\n`
  + `  ],\n`
  + `});\n`,
  'utf8'
);

const SPECS = `
import { test, expect } from '@playwright/test';

test('plain case', async () => { expect(1).toBe(1); });

for (const n of [1, 2]) {
  test(\`adds \${n} items\`, async () => { expect(n).toBeGreaterThan(0); });
}

test.describe('outer', () => {
  test('same title', async () => { expect(2).toBe(2); });
});

test.describe('inner', () => {
  test('same title', async () => { expect(3).toBe(3); });
});
`;
fs.writeFileSync(path.join(FIXTURE, 'tests', 'facts.spec.ts'), SPECS, 'utf8');

const CLI = path.join(FIXTURE, 'node_modules', '@playwright', 'test', 'cli.js');
if (!fs.existsSync(CLI)) {
  log('--- installing the real @playwright/test ---');
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const install = spawnSync(process.execPath, [npmCli, 'install', `@playwright/test@${PLAYWRIGHT_VERSION}`, '--no-audit', '--no-fund'], {
    cwd: FIXTURE, encoding: 'utf8',
  });
  if (install.status !== 0) {
    log('npm install failed:');
    log(install.stderr || install.stdout);
    process.exit(1);
  }
}

const REPORT = path.join(WORK, 'list.json');
function list() {
  fs.rmSync(REPORT, { force: true });
  const r = spawnSync(process.execPath, [CLI, 'test', '--list', '--reporter=json'], {
    cwd: FIXTURE,
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: REPORT },
  });
  const raw = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : null;
  return { status: r.status, raw, stdout: r.stdout, stderr: r.stderr };
}

/* ------------------------------------------------------------------ */
/* 1. the LIST report                                                  */
/* ------------------------------------------------------------------ */
log('--- 1. the list report ---');
const listed = list();
if (!listed.raw) {
  log('the CLI produced no report');
  log(listed.stderr);
  process.exit(1);
}

const flat = [];
(function walk(suite, path_ = []) {
  for (const spec of suite.specs ?? []) flat.push({ suitePath: path_, spec });
  for (const sub of suite.suites ?? []) walk(sub, [...path_, String(sub.title ?? '')]);
})(listed.raw);
log(`  the report lists ${flat.length} spec rows`);

for (const { suitePath, spec } of flat) {
  log(`  file=${spec.file} line=${spec.line} title=${JSON.stringify(spec.title)} id=${spec.id} suites=${JSON.stringify(suitePath)}`);
  for (const t of spec.tests ?? []) log(`      project=${t.projectName} expectedStatus=${t.expectedStatus}`);
}

const byTitle = (title) => flat.filter((x) => x.spec.title === title);

/* ------------------------------------------------------------------ */
/* 2. the rendered titles of a parameterised case                      */
/* ------------------------------------------------------------------ */
log('--- 2. a loop-generated case: the rendered titles, their order and their line ---');
const rendered = flat.filter((x) => /^adds \d+ items$/.test(x.spec.title));
check('two renders are reported', rendered.length, 2);
check('both renders sit on the line of the test call', rendered.map((r) => r.spec.line), [7, 7]);
check('the renders keep the order of the declaration', rendered.map((r) => r.spec.title), ['adds 1 items', 'adds 2 items']);
check('the renders carry different spec ids', new Set(rendered.map((r) => r.spec.id)).size, 2);

/* ------------------------------------------------------------------ */
/* 3. the matrix: one logical case, several projects                   */
/* ------------------------------------------------------------------ */
log('--- 3. the project matrix ---');
const plain = byTitle('plain case');
check('the plain case is one spec row', plain.length, 1);
check('the spec row carries one test per project', plain[0].spec.tests.map((t) => t.projectName), ['alpha', 'beta']);
check('the spec id is the same for both projects of the row', new Set(plain[0].spec.tests.map((t) => t.projectId)).size, 1);

/* ------------------------------------------------------------------ */
/* 4. the same title under two describes                               */
/* ------------------------------------------------------------------ */
log('--- 4. the same title under two describes ---');
const same = byTitle('same title');
check('two spec rows share the title', same.length, 2);
check('they sit on different lines', new Set(same.map((s) => s.spec.line)).size, 2);
check('the describe path differs', same.map((s) => s.suitePath.join(' > ')), ['outer', 'inner']);

/* ------------------------------------------------------------------ */
/* 5. what the RUN report carries                                      */
/* ------------------------------------------------------------------ */
log('--- 5. the run report ---');
const RUN_REPORT = path.join(WORK, 'run.json');
fs.rmSync(RUN_REPORT, { force: true });
const run = spawnSync(process.execPath, [CLI, 'test', '--reporter=json'], {
  cwd: FIXTURE,
  encoding: 'utf8',
  env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: RUN_REPORT },
});
log(`  the run exited with ${run.status}`);
if (!fs.existsSync(RUN_REPORT)) {
  log('  the run produced no report');
  log(run.stderr);
} else {
  const rr = JSON.parse(fs.readFileSync(RUN_REPORT, 'utf8'));
  const rflat = [];
  (function walk(suite) {
    for (const spec of suite.specs ?? []) rflat.push(spec);
    for (const sub of suite.suites ?? []) walk(sub);
  })(rr);
  log(`  the run report lists ${rflat.length} spec rows`);
  for (const spec of rflat) {
    log(`  file=${spec.file} line=${spec.line} title=${JSON.stringify(spec.title)} id=${spec.id}`);
    for (const t of spec.tests ?? []) log(`      project=${t.projectName} status=${t.status} results=${(t.results ?? []).length}`);
  }
  const rRendered = rflat.filter((s) => /^adds \d+ items$/.test(s.title));
  check('the run report carries one spec row per render', rRendered.length, 2);
  check('the run report carries the spec id', rRendered.every((s) => typeof s.id === 'string' && s.id.length > 0), true);
  check('the run report carries the project name per test', rRendered[0].tests.map((t) => t.projectName), ['alpha', 'beta']);
}

log(`SUMMARY: ${failures === 0 ? 'all facts confirmed' : `${failures} fact(s) differ from what the mapper assumes`}`);
process.exitCode = failures ? 1 : 0;
