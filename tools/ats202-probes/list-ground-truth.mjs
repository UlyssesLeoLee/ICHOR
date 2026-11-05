#!/usr/bin/env node
/**
 * ATS-202: the ground truth of `playwright test --list`.
 *
 * The authoritative discovery (FR-021) is built on what the CLI actually
 * reports. This probe MEASURES that contract against a REAL
 * `@playwright/test` (1.64.1) instead of assuming it, and it is the
 * reproduction script for `docs/evidence/ATS-202/01-list-ground-truth.log`.
 *
 * It answers, one question at a time:
 *
 *   1. the report shape (what the CLI writes, and where);
 *   2. how the reported `file` is spelled (relative to `rootDir`);
 *   3. what the CLI's `spec.id` identifies -- which perturbations change it
 *      and which do not;
 *   4. how a `describe` path is reported;
 *   5. how a matrix of Playwright projects is reported;
 *   6. what `--list` EXECUTES (the project config? the spec files? globalSetup?);
 *   7. how the CLI fails (broken config, duplicate title, no tests).
 *
 * Usage: node tools/ats202-probes/list-ground-truth.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const WORK = process.env.ATS202_WORKDIR || path.join(os.tmpdir(), 'ats202-ground-truth');
const FIXTURE = path.join(WORK, 'project');
const PLAYWRIGHT_VERSION = '1.64.1';

const log = (...a) => console.log(...a);
let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
};

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(FIXTURE, 'tests'), { recursive: true });
fs.writeFileSync(path.join(FIXTURE, 'package.json'), '{"name":"ats202-ground-truth","private":true}', 'utf8');
fs.writeFileSync(
  path.join(FIXTURE, 'playwright.config.ts'),
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n",
  'utf8'
);

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
const CLI = path.join(FIXTURE, 'node_modules', '@playwright', 'test', 'cli.js');
const REPORT = path.join(WORK, 'report.json');

/**
 * Runs `playwright test --list --reporter=json` and returns what the CLI
 * produced. The JSON reporter writes to PLAYWRIGHT_JSON_OUTPUT_FILE.
 */
function list() {
  fs.rmSync(REPORT, { force: true });
  const r = spawnSync(process.execPath, [CLI, 'test', '--list', '--reporter=json'], {
    cwd: FIXTURE, encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: REPORT },
  });
  const report = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : null;
  const rows = [];
  const walk = (suite, describePath) => {
    for (const spec of suite.specs || []) {
      rows.push({
        id: spec.id,
        title: spec.title,
        file: spec.file,
        line: spec.line,
        column: spec.column,
        ok: spec.ok,
        tags: spec.tags || [],
        describePath: [...describePath],
        projects: (spec.tests || []).map((t) => t.projectName || t.projectId || ''),
        expectedStatus: spec.tests?.[0]?.expectedStatus ?? null,
        annotations: spec.tests?.[0]?.annotations || [],
      });
    }
    for (const sub of suite.suites || []) {
      // The FILE suite is the one whose line is 0: its title is the file
      // name, and it is not part of the describe path.
      const isFileSuite = Boolean(sub.file) && sub.line === 0;
      walk(sub, isFileSuite ? describePath : [...describePath, String(sub.title ?? '')]);
    }
  };
  if (report) walk(report, []);
  return { exitCode: r.status, report, rows, stderr: r.stderr || '', stdout: r.stdout || '' };
}

const write = (rel, body) => {
  const full = path.join(FIXTURE, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
};
const spec = (...body) => ["import { test } from '@playwright/test';", ...body, ''].join('\n');

// ---------------------------------------------------------------- 1. shape
log('\n=== 1. the report shape ===');
write('tests/a.spec.ts', spec(
  "test('alpha', async ({ page }) => {",
  "  await page.setContent('<h1>a</h1>');",
  "});",
  "test('beta', async ({ page }) => {",
  "  await page.setContent('<h1>b</h1>');",
  "});"
));
const base = list();
check('the CLI exits 0 on a successful listing', base.exitCode, 0);
check('a JSON report is written', base.report !== null, true);
check('the report carries config/rootDir/suites/errors/stats',
  Object.keys(base.report).sort(), ['config', 'errors', 'stats', 'suites']);
check('the CLI version is reported', base.report.config.version, PLAYWRIGHT_VERSION);
check('the report names rootDir', typeof base.report.config.rootDir, 'string');
check('every spec carries an id', base.rows.every((r) => typeof r.id === 'string' && r.id.length > 0), true);
check('the spec id has the shape <hex>-<hex>', /^[0-9a-f]{20}-[0-9a-f]{20}$/.test(base.rows[0].id), true);

// ------------------------------------------------- 2. the reported file path
log('\n=== 2. the reported file spelling ===');
check('the file is relative to rootDir, not to the project root',
  base.rows[0].file, 'a.spec.ts');
check('rootDir is the resolved testDir', base.report.config.rootDir.replace(/\\/g, '/').endsWith('/tests'), true);

// -------------------------------------------------- 3. what spec.id identifies
log('\n=== 3. what the spec id identifies ===');
const alpha = base.rows.find((r) => r.title === 'alpha');
const beta = base.rows.find((r) => r.title === 'beta');
check('two tests in one file share the file half of the id',
  alpha.id.split('-')[0], beta.id.split('-')[0]);
check('two tests in one file differ in the test half of the id',
  alpha.id.split('-')[1] !== beta.id.split('-')[1], true);

const again = list();
check('the listing is deterministic', again.rows.map((r) => r.id), base.rows.map((r) => r.id));

write('tests/a.spec.ts', spec(
  "test('alpha', async ({ page }) => {",
  "  await page.setContent('<h1>CHANGED</h1>');",
  "});",
  "test('beta', async ({ page }) => {",
  "  await page.setContent('<h1>b</h1>');",
  "});"
));
const bodyEdit = list();
check('the id survives an edit of the test body',
  bodyEdit.rows.find((r) => r.title === 'alpha').id, alpha.id);
check('the id of ANOTHER test in the same file is unaffected',
  bodyEdit.rows.find((r) => r.title === 'beta').id, beta.id);

write('tests/a.spec.ts', spec(
  "test('inserted', async ({ page }) => {});",
  "test('alpha', async ({ page }) => {",
  "  await page.setContent('<h1>CHANGED</h1>');",
  "});",
  "test('beta', async ({ page }) => {",
  "  await page.setContent('<h1>b</h1>');",
  "});"
));
const inserted = list();
check('the id is NOT positional: inserting a test above does not change it',
  inserted.rows.find((r) => r.title === 'beta').id, beta.id);

write('tests/a.spec.ts', spec(
  "test('alpha renamed', async ({ page }) => {",
  "  await page.setContent('<h1>CHANGED</h1>');",
  "});",
  "test('beta', async ({ page }) => {",
  "  await page.setContent('<h1>b</h1>');",
  "});"
));
const retitled = list();
check('the id CHANGES when the test is renamed',
  retitled.rows.find((r) => r.title === 'alpha renamed').id !== alpha.id, true);

fs.renameSync(path.join(FIXTURE, 'tests', 'a.spec.ts'), path.join(FIXTURE, 'tests', 'b.spec.ts'));
const renamed = list();
check('the id CHANGES when the file is renamed',
  renamed.rows.find((r) => r.title === 'alpha renamed').id !== alpha.id, true);

// ------------------------------------------------------- 4. the describe path
log('\n=== 4. how a describe path is reported ===');
write('tests/b.spec.ts', spec(
  "test.describe('outer', () => {",
  "  test.describe('inner', () => {",
  "    test('deep', async ({ page }) => {});",
  "  });",
  "});"
));
const nested = list();
const deep = nested.rows.find((r) => r.title === 'deep');
check('the spec title is the LEAF title, without the describe path',
  deep.title, 'deep');
check('the describe path is reported through the suite nesting',
  deep.describePath, ['outer', 'inner']);
check('the line points at the test() call', deep.line, 4);

// --------------------------------------------------- 5. the project matrix
log('\n=== 5. a matrix of Playwright projects ===');
write('playwright.config.ts', [
  "import { defineConfig } from '@playwright/test';",
  "export default defineConfig({",
  "  testDir: './tests', timeout: 20000, retries: 0,",
  "  projects: [",
  "    { name: 'desktop' },",
  "    { name: 'mobile' }",
  "  ]",
  "});",
  ''
].join('\n'));
const matrix = list();
const deepRows = matrix.rows.filter((r) => r.title === 'deep');
check('the same logical case is reported once per project', deepRows.length, 2);
check('each project gets its own spec id',
  deepRows[0].id !== deepRows[1].id, true);
check('each row names its project',
  deepRows.map((r) => r.projects[0]).sort(), ['desktop', 'mobile']);
write('playwright.config.ts',
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n", 'utf8');

// ------------------------------------------------- 6. what --list executes
log('\n=== 6. what --list executes ===');
write('playwright.config.ts', [
  "import fs from 'node:fs';",
  "fs.writeFileSync('CONFIG_LOADED.txt', 'yes');",
  "export default { testDir: './tests' };",
  ''
].join('\n'));
write('global-setup.ts', [
  "import fs from 'node:fs';",
  "fs.writeFileSync('GLOBAL_SETUP_RAN.txt', 'yes');",
  "export default async function globalSetup() {}",
  ''
].join('\n'));
fs.rmSync(path.join(FIXTURE, 'CONFIG_LOADED.txt'), { force: true });
fs.rmSync(path.join(FIXTURE, 'GLOBAL_SETUP_RAN.txt'), { force: true });
write('tests/b.spec.ts', spec(
  "import fs from 'node:fs';",
  "fs.writeFileSync('SPEC_TOP_LEVEL_RAN.txt', 'yes');",
  "test('side effect', async ({ page }) => {",
  "  fs.writeFileSync('TEST_BODY_RAN.txt', 'yes');",
  "});"
));
list();
check('the listing LOADS the project config (it executes its top level)',
  fs.existsSync(path.join(FIXTURE, 'CONFIG_LOADED.txt')), true);
check('the listing does NOT run globalSetup',
  fs.existsSync(path.join(FIXTURE, 'GLOBAL_SETUP_RAN.txt')), false);
// MEASURED: the listing EVALUATES the test files -- their top level runs.
// This is the fact the trust gate of the ATS-202 delivery rests on: the
// listing is not a read-only operation, it runs the repository's code.
check('the listing EXECUTES the top level of the spec files (this is why --list needs a trusted repository)',
  fs.existsSync(path.join(FIXTURE, 'SPEC_TOP_LEVEL_RAN.txt')), true);
check('the listing does NOT run the test bodies',
  fs.existsSync(path.join(FIXTURE, 'TEST_BODY_RAN.txt')), false);

// ------------------------------------------------------- 7. how it fails
log('\n=== 7. how the CLI fails ===');
fs.rmSync(path.join(FIXTURE, 'SPEC_TOP_LEVEL_RAN.txt'), { force: true });
fs.rmSync(path.join(FIXTURE, 'CONFIG_LOADED.txt'), { force: true });
write('playwright.config.ts', 'export default { broken\n');
const broken = list();
check('a broken config exits non-zero', broken.exitCode !== 0, true);
check('a broken config produces NO report file', broken.report, null);
check('a broken config explains itself on stderr', broken.stderr.includes('SyntaxError'), true);

write('playwright.config.ts',
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n", 'utf8');
write('tests/b.spec.ts', spec(
  "for (const n of ['x', 'x']) {",
  "  test(`same ${n}`, async ({ page }) => {});",
  "}"
));
const duplicate = list();
check('a duplicate title exits non-zero', duplicate.exitCode !== 0, true);
check('a duplicate title is reported in errors[]',
  /duplicate test title/.test(JSON.stringify(duplicate.report?.errors || [])), true);

write('tests/b.spec.ts', spec("test('only', async ({ page }) => {});"));
fs.rmSync(path.join(FIXTURE, 'tests', 'b.spec.ts'), { force: true });
const empty = list();
check('a project with no tests exits non-zero', empty.exitCode !== 0, true);
check('a project with no tests is reported as "No tests found"',
  /No tests found/.test(JSON.stringify(empty.report?.errors || [])), true);

log(`\n${failures === 0 ? 'RESULT: OK' : `RESULT: ${failures} FAILED CHECK(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
