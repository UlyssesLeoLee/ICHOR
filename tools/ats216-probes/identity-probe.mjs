#!/usr/bin/env node
/**
 * ATS-216 identity probe: what identity facts does the ENGINE guarantee?
 *
 *   node tools/ats216-probes/identity-probe.mjs <playwright-node_modules> <scratch-dir>
 *
 * WHY THIS EXISTS
 * ---------------
 * The cross-run identity of a case decides whether two runs of one case are
 * "the same case that is unreliable" or "two different cases". The key
 * therefore has to be built from facts the engine GUARANTEES.
 *
 * The stored summary carries three identity facts: the describe path
 * (`scope`), the line and the case key. This probe measures what each of
 * them is worth, by asking the engine itself:
 *
 *   Q1  same describe + same title in ONE file  -> rejected?
 *   Q2  two describes, same NAME + same title   -> rejected?
 *   Q3  two describes, different NAME + same title -> allowed?
 *   Q4  PARAMETERIZED tests (one title, N data) -> allowed?
 *   Q5  nested describes                          -> what is the scope?
 *   Q6  the same title path in TWO files          -> allowed?
 *
 * THE RESULT
 * ----------
 * The engine REJECTS the duplicates that a line would have to separate:
 * a duplicate (describe path, title) inside one file is a "duplicate test
 * title" error and the file does not run at all (Q1, Q2, Q4). The pairs
 * the engine ALLOWS are separated by the describe path (Q3) or by the file
 * (Q6).
 *
 * So within one file the pair (describe path, title) is ALREADY UNIQUE --
 * the engine guarantees it -- and the line is a fact that MOVES: anything
 * inserted above the case shifts it. The identity key therefore uses the
 * describe path and not the line. See `apps/studio/public/quality.mjs`
 * -> `testKeyOf`.
 *
 * Prints the facts. The exit code is 0 (this probe documents behaviour);
 * a crashed probe is a failed probe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [nmArg, scratchArg] = process.argv.slice(2);
if (!nmArg || !scratchArg) {
  console.error('usage: identity-probe.mjs <playwright-node_modules> <scratch-dir>');
  process.exit(2);
}
const nm = path.resolve(nmArg);
const scratch = path.resolve(scratchArg);
fs.mkdirSync(scratch, { recursive: true });

const CONFIG = "import { defineConfig } from '@playwright/test';\n"
  + "export default defineConfig({testDir:'./tests',timeout:20000,retries:0});\n";

const body = (s) => "import { test, expect } from '@playwright/test';\n" + s;

const OK = "await page.setContent('<h1 id=\"t\">ok</h1>');\n"
  + "    await expect(page.locator('#t')).toHaveText('ok');\n";

const CASES = {
  // Q1: the same title twice in ONE describe.
  'q1-same-describe-same-title': body(
    "test.describe('结算', () => {\n"
    + "  test('提交订单', async ({ page }) => {\n    " + OK + "  });\n"
    + "  test('提交订单', async ({ page }) => {\n    " + OK + "  });\n"
    + "});\n"),
  // Q2: two describes with the SAME name and the same test title.
  'q2-dup-describe-name-same-title': body(
    "test.describe('结算', () => {\n"
    + "  test('提交订单', async ({ page }) => {\n    " + OK + "  });\n"
    + "});\n"
    + "test.describe('结算', () => {\n"
    + "  test('提交订单', async ({ page }) => {\n    " + OK + "  });\n"
    + "});\n"),
  // Q3: two describes with DIFFERENT names and the same test title.
  'q3-diff-describe-same-title': body(
    "test.describe('管理员', () => {\n"
    + "  test('可以登录', async ({ page }) => {\n    " + OK + "  });\n"
    + "});\n"
    + "test.describe('访客', () => {\n"
    + "  test('可以登录', async ({ page }) => {\n    " + OK + "  });\n"
    + "});\n"),
  // Q4: PARAMETERIZED tests -- one title, N data sets.
  'q4-parameterized': body(
    "test.describe('结算', () => {\n"
    + "  for (const amount of [1, 2, 3]) {\n"
    + "    test('提交订单', async ({ page }) => {\n"
    + "      await page.setContent(`<h1 id=\"t\">${amount}</h1>`);\n"
    + "      await expect(page.locator('#t')).toHaveText(String(amount));\n"
    + "    });\n"
    + "  }\n"
    + "});\n"),
  // Q5: nested describes.
  'q5-nested-describe': body(
    "test.describe('结算', () => {\n"
    + "  test.describe('信用卡', () => {\n"
    + "    test('提交订单', async ({ page }) => {\n    " + OK + "    });\n"
    + "  });\n"
    + "});\n"),
};

const proj = path.join(scratch, 'proj');
fs.cpSync(path.join(process.cwd(), 'examples', 'sample-playwright'), proj,
  { recursive: true, filter: (s) => !s.includes('node_modules') });
fs.rmSync(path.join(proj, 'node_modules'), { recursive: true, force: true });
fs.symlinkSync(nm, path.join(proj, 'node_modules'), 'junction');
fs.writeFileSync(path.join(proj, 'playwright.config.ts'), CONFIG);
// The fixture's package.json is KEPT: the CLI refuses to run when
// @playwright/test is not a declared dependency of the project.

const cleanSpecs = () => {
  for (const f of fs.readdirSync(path.join(proj, 'tests'))) {
    if (f.endsWith('.spec.ts')) fs.rmSync(path.join(proj, 'tests', f));
  }
};

/**
 * Run the fixture with the given spec files and report what the engine
 * made of them.
 */
const run = (name, specs) => {
  const reportFile = path.join(scratch, `${name}.json`);
  cleanSpecs();
  for (const [file, content] of Object.entries(specs)) {
    fs.writeFileSync(path.join(proj, 'tests', file), content);
  }
  const r = spawnSync(process.execPath,
    [path.join(nm, '@playwright', 'test', 'cli.js'), 'test', '--reporter=json'],
    {
      cwd: proj,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile },
      encoding: 'utf8',
      timeout: 180000,
    });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const dup = out.match(/Error: duplicate[^\n]*/i);
  const report = fs.existsSync(reportFile)
    ? JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    : null;
  const specs_ = [];
  const walk = (s) => {
    for (const x of s.specs || []) {
      specs_.push({ titlePath: x.titlePath, file: x.file, line: x.line });
    }
    for (const x of s.suites || []) walk(x);
  };
  if (report) for (const s of report.suites || []) walk(s);
  console.log(`\n--- ${name} --- exit=${r.status}`);
  console.log(`  duplicate-title error: ${dup ? dup[0] : '(none)'}`);
  console.log(`  specs the engine ran : ${JSON.stringify(specs_)}`);
  return { rejected: Boolean(dup), specs: specs_ };
};

/* --- the six questions ------------------------------------------------ */
const q1 = run('q1-same-describe-same-title', {
  'q1.spec.ts': CASES['q1-same-describe-same-title'] });
const q2 = run('q2-dup-describe-name-same-title', {
  'q2.spec.ts': CASES['q2-dup-describe-name-same-title'] });
const q3 = run('q3-diff-describe-same-title', {
  'q3.spec.ts': CASES['q3-diff-describe-same-title'] });
const q4 = run('q4-parameterized', {
  'q4.spec.ts': CASES['q4-parameterized'] });
const q5 = run('q5-nested-describe', {
  'q5.spec.ts': CASES['q5-nested-describe'] });
const q6 = run('q6-same-title-path-two-files', {
  'a.spec.ts': CASES['q3-diff-describe-same-title'],
  'b.spec.ts': CASES['q3-diff-describe-same-title'] });

/* --- the conclusion the identity key rests on -------------------------- */
let passed = 0;
let total = 0;
const check = (id, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` -- ${detail}` : ''}`);
};

check('Q1 the engine rejects two same-titled cases in one describe',
  q1.rejected, q1.rejected ? 'rejected' : `ran ${q1.specs.length} spec(s)`);
check('Q2 the engine rejects two same-named describes with the same test title',
  q2.rejected, q2.rejected ? 'rejected' : `ran ${q2.specs.length} spec(s)`);
check('Q3 the engine runs two same-titled cases under different describes',
  !q3.rejected && q3.specs.length === 2,
  `${q3.specs.length} spec(s)`);
check('Q4 the engine rejects PARAMETERIZED tests that share one title',
  q4.rejected, q4.rejected ? 'rejected' : `ran ${q4.specs.length} spec(s)`);
check('Q5 the engine runs a case under nested describes',
  !q5.rejected && q5.specs.length === 1, `${q5.specs.length} spec(s)`);
check('Q6 the engine runs the same title path in two files',
  !q6.rejected && q6.specs.length === 4, `${q6.specs.length} spec(s)`);
check('therefore (describe path, title) is unique within one file',
  q1.rejected && q2.rejected && !q3.rejected && q3.specs.length === 2,
  'the engine guarantees it, so the line separates nothing more');

console.log('');
console.log(`RESULT: ${passed}/${total}`);
console.log(`scratch: ${scratch}`);
process.exitCode = passed === total ? 0 : 1;
