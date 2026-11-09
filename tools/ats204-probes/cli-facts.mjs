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

for (const n of [2, 1]) {
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
/*
 * THE MEASURED FACTS (against the real @playwright/test 1.64.1)
 * ------------------------------------------------------------
 * The fixture declares TWO Playwright projects (`alpha` and `beta`), and the
 * CLI writes ONE SPEC ROW PER PROJECT: the two renders of the loop appear
 * TWICE, once per project. The assertions below are the MEASURED facts --
 * they were wrong before (they asserted one row per render), which is why
 * this probe used to report 10 differences while the product's own parser
 * was right.
 */
check('the two renders are reported once per project', rendered.length, 4);
check('every render sits on the line of the test call', rendered.map((r) => r.spec.line), [7, 7, 7, 7]);
check('the renders keep the order of the declaration',
  rendered.map((r) => r.spec.title),
  ['adds 2 items', 'adds 1 items', 'adds 2 items', 'adds 1 items']);
check('the renders carry a different spec id per project',
  new Set(rendered.map((r) => r.spec.id)).size, 4);
/*
 * THE ORDER IS THE REPORT ORDER
 * -----------------------------
 * The CLI writes the renders in the order the template GENERATED them in
 * (`2` before `1`), and that order is what the anchor's ordinal counts.
 * The catalogue's own display order is sorted by title -- a different
 * order -- so the two must not be confused.
 */
const alpha = rendered.filter((r) => r.spec.tests?.[0]?.projectName === 'alpha');
check('one project reports the renders in the order of the declaration',
  alpha.map((r) => r.spec.title), ['adds 2 items', 'adds 1 items']);
check('the report order is NOT the title-sorted order',
  alpha.map((r) => r.spec.title).join('|') !== [...alpha.map((r) => r.spec.title)].sort().join('|'),
  true);

/* ------------------------------------------------------------------ */
/* 3. the matrix: one logical case, several projects                   */
/* ------------------------------------------------------------------ */
log('--- 3. the project matrix ---');
const plain = byTitle('plain case');
check('the plain case is one spec row per project', plain.length, 2);
check('each spec row carries ONE test -- the project it belongs to',
  plain.map((r) => r.spec.tests.map((t) => t.projectName)), [['alpha'], ['beta']]);
check('the two rows carry different spec ids',
  new Set(plain.map((r) => r.spec.id)).size, 2);

/* ------------------------------------------------------------------ */
/* 4. the same title under two describes                               */
/* ------------------------------------------------------------------ */
log('--- 4. the same title under two describes ---');
const same = byTitle('same title');
check('the two describes report one spec row per project', same.length, 4);
check('the two describes sit on different lines', new Set(same.map((s) => s.spec.line)).size, 2);
check('the describe path differs',
  [...new Set(same.map((s) => s.suitePath.join(' > ')))], ['facts.spec.ts > outer', 'facts.spec.ts > inner']);
check('the describe path is what tells the two cases apart',
  new Set(same.map((s) => `${s.suitePath.join(' > ')} ${s.spec.line}`)).size, 2);

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
  check('the run report carries one spec row per render and project', rRendered.length, 4);
  check('the run report carries the spec id', rRendered.every((s) => typeof s.id === 'string' && s.id.length > 0), true);
  check('each run-report row carries ONE project',
    rRendered.map((s) => s.tests.map((t) => t.projectName)),
    [['alpha'], ['alpha'], ['beta'], ['beta']]);
  check('the run report groups the rows by project',
    [...new Set(rRendered.map((s) => s.tests[0].projectName))], ['alpha', 'beta']);
  /*
   * THE RUN REPORT HAS NO DESCRIBE PATH ON THE SPEC
   * -----------------------------------------------
   * The `describe` path is a property of the SUITE the spec sits in, not
   * of the spec. The product's parser therefore reads it from the suite
   * nesting (see `parseReport` in `server/execution/model.mjs`), which is
   * what makes two same-titled cases under different describes two cases.
   */
  const runSuites = [];
  (function walkSuites(suite, path_ = []) {
    for (const spec of suite.specs ?? []) runSuites.push({ path_, spec });
    for (const sub of suite.suites ?? []) {
      const isFileSuite = Boolean(sub.file) && sub.line === 0;
      walkSuites(sub, isFileSuite ? path_ : [...path_, String(sub.title ?? '')]);
    }
  })(rr);
  const sameTitle = runSuites.filter((x) => x.spec.title === 'same title');
  check('the run report nests the same title under two describes',
    [...new Set(sameTitle.map((x) => x.path_.join(' > ')))],
    ['outer', 'inner']);
  check('the describe path is what tells the two cases apart in the run report',
    new Set(sameTitle.map((x) => `${x.path_.join(' > ')} ${x.spec.line}`)).size, 2);
}

log(`SUMMARY: ${failures === 0 ? 'all facts confirmed' : `${failures} fact(s) differ from what the mapper assumes`}`);
process.exitCode = failures ? 1 : 0;
