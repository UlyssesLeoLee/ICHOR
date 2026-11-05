/**
 * ATS-202: the integration tests of the authoritative discovery.
 *
 * These tests drive the REAL `@playwright/test` (1.64.1) against a REAL
 * fixture project, through the product's own discovery code. They are the
 * acceptance criterion of the task: "与 CLI 发现结果一致" -- the index agrees
 * with the CLI, and "未可信仓库不可调用 --list" -- an untrusted repository is
 * never asked to run the listing.
 *
 * The fixture is installed into a temporary directory (the npm install is
 * part of the setup), so the test does not depend on the checkout having the
 * dependencies installed. When the install cannot run (no network), the
 * tests are SKIPPED -- never reported as a pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { listTests, LIST_OUTCOME } from '../server/discovery/playwright-list.mjs';
import { discoverTests } from '../server/core.mjs';
import { withTrust, TRUST } from '../server/discovery/trust.mjs';

const PLAYWRIGHT_VERSION = '1.64.1';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ats202-it-'));
const FIXTURE = path.join(WORK, 'project');
const CLI = path.join(FIXTURE, 'node_modules', '@playwright', 'test', 'cli.js');

fs.mkdirSync(path.join(FIXTURE, 'tests'), { recursive: true });
fs.writeFileSync(path.join(FIXTURE, 'package.json'), '{"name":"ats202-it","private":true}', 'utf8');
fs.writeFileSync(
  path.join(FIXTURE, 'playwright.config.ts'),
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n",
  'utf8'
);

const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const install = spawnSync(process.execPath, [npmCli, 'install', `@playwright/test@${PLAYWRIGHT_VERSION}`, '--no-audit', '--no-fund'], {
  cwd: FIXTURE, encoding: 'utf8',
});
const installed = install.status === 0 && fs.existsSync(CLI);

const write = (rel, body) => {
  const full = path.join(FIXTURE, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
};

/**
 * Empties the fixture's test directory.
 *
 * The fixture is SHARED by the whole file, so a spec file an earlier test
 * wrote is still there for the next one. A test that asserts "the two
 * indexes agree" would then fail because of a case that has nothing to do
 * with it -- the `dynamic.spec.ts` of IT-ATS202-002 is a real difference
 * between the indexes (the static one sees the template, the CLI sees the
 * rendered titles), and it is not what the test is about.
 */
const clearSpecs = () => {
  const dir = path.join(FIXTURE, 'tests');
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
};

const project = { id: 'proj_1_0123456789abcdef01234567', uid: 'proj_1_0123456789abcdef01234567', root: FIXTURE };

test('IT-ATS202-SETUP: the real Playwright is installed', { skip: installed ? false : 'the real @playwright/test could not be installed' }, () => {
  assert.ok(installed);
});

test('IT-ATS202-001: the listing reports the cases of the project', { skip: installed ? false : 'no real Playwright' }, () => {
  write('tests/plain.spec.ts', [
    "import { test } from '@playwright/test';",
    "test('plain case', async ({ page }) => {});",
    ''
  ].join('\n'));
  const listed = listTests(project);
  assert.equal(listed.ok, true, JSON.stringify(listed.errors));
  assert.equal(listed.outcome, LIST_OUTCOME.OK);
  assert.equal(listed.tests.length, 1);
  assert.equal(listed.tests[0].title, 'plain case');
  // The file is spelled relative to the PROJECT root, not to the testDir.
  assert.equal(listed.tests[0].file, 'tests/plain.spec.ts');
  assert.equal(listed.version, PLAYWRIGHT_VERSION);
});

test('IT-ATS202-002: a DYNAMIC case is in the authoritative index and not in the static one', { skip: installed ? false : 'no real Playwright' }, () => {
  write('tests/plain.spec.ts', [
    "import { test } from '@playwright/test';",
    "test('plain case', async ({ page }) => {});",
    ''
  ].join('\n'));
  write('tests/dynamic.spec.ts', [
    "import { test } from '@playwright/test';",
    "for (const n of ['alpha', 'beta']) {",
    "  test(`dynamic ${n}`, async ({ page }) => {});",
    "}",
    ''
  ].join('\n'));
  const listed = listTests(project);
  assert.equal(listed.ok, true, JSON.stringify(listed.errors));
  const titles = listed.tests.map((t) => t.title).sort();
  assert.deepEqual(titles, ['dynamic alpha', 'dynamic beta', 'plain case']);

  // The static heuristic does NOT see the two RENDERED cases. It reads the
  // template literal as ONE case, and its title is the TEMPLATE
  // (`dynamic ${n}`), not the title the CLI reports (`dynamic alpha`).
  // That is exactly what the authoritative discovery is for.
  const staticResult = discoverTests(project, {}, { version: 1, projects: {} }, { authoritative: false });
  assert.equal(staticResult.discovery, 'static');
  const staticDynamic = staticResult.tests.filter((t) => t.title.startsWith('dynamic '));
  assert.equal(staticDynamic.length, 1);
  assert.equal(staticDynamic[0].title, 'dynamic ${n}', 'the static index reports the TEMPLATE, not the rendered titles');
  assert.equal(staticResult.tests.filter((t) => t.title === 'dynamic alpha').length, 0);
  assert.equal(staticResult.tests.filter((t) => t.title === 'plain case').length, 1);
});

test('IT-ATS202-003: the trusted project gets the authoritative index', { skip: installed ? false : 'no real Playwright' }, () => {
  write('tests/dynamic.spec.ts', [
    "import { test } from '@playwright/test';",
    "for (const n of ['alpha', 'beta']) {",
    "  test(`dynamic ${n}`, async ({ page }) => {});",
    "}",
    ''
  ].join('\n'));
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  const result = discoverTests(project, state, { version: 1, projects: {} });
  assert.equal(result.discovery, 'authoritative');
  assert.equal(result.authoritative.outcome, LIST_OUTCOME.OK);
  assert.equal(result.tests.filter((t) => t.title.startsWith('dynamic ')).length, 2);
  // Every case carries a stable UID.
  assert.equal(result.tests.every((t) => t.uid && t.uidStable), true);
  // The two dynamic cases have DIFFERENT uids.
  const dynamic = result.tests.filter((t) => t.title.startsWith('dynamic '));
  assert.equal(new Set(dynamic.map((t) => t.uid)).size, 2);
});

test('IT-ATS202-004: the UNTRUSTED project never runs --list', { skip: installed ? false : 'no real Playwright' }, () => {
  write('tests/dynamic.spec.ts', [
    "import { test } from '@playwright/test';",
    "for (const n of ['alpha', 'beta']) {",
    "  test(`dynamic ${n}`, async ({ page }) => {});",
    "}",
    ''
  ].join('\n'));
  // A marker file the fixture would create if the listing executed the
  // spec files. An untrusted project must not trigger that.
  const marker = path.join(FIXTURE, 'LISTING_RAN.txt');
  write('tests/marker.spec.ts', [
    "import fs from 'node:fs';",
    "fs.writeFileSync('LISTING_RAN.txt', 'yes');",
    "import { test } from '@playwright/test';",
    "test('marker', async ({ page }) => {});",
    ''
  ].join('\n'));
  fs.rmSync(marker, { force: true });

  const result = discoverTests(project, {}, { version: 1, projects: {} });
  assert.equal(result.discovery, 'static');
  assert.equal(result.authoritative.attempted, false);
  assert.equal(result.authoritative.outcome, 'SKIPPED_UNTRUSTED');
  assert.equal(fs.existsSync(marker), false, 'the untrusted project did NOT execute its test files');

  // Even when the caller asks for the authoritative index explicitly, the
  // trust still decides.
  const forced = discoverTests(project, {}, { version: 1, projects: {} }, { authoritative: true });
  assert.equal(forced.discovery, 'static');
  assert.equal(forced.authoritative.attempted, false);
  assert.match(forced.warning, /未可信仓库不可调用/);
  assert.equal(fs.existsSync(marker), false, 'the forced request did NOT execute the test files either');
});

test('IT-ATS202-005: the trusted project DOES execute the listing', { skip: installed ? false : 'no real Playwright' }, () => {
  const marker = path.join(FIXTURE, 'LISTING_RAN.txt');
  fs.rmSync(marker, { force: true });
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  const result = discoverTests(project, state, { version: 1, projects: {} });
  assert.equal(result.discovery, 'authoritative');
  // The measurement that justifies the trust gate: the listing runs the
  // repository's code.
  assert.equal(fs.existsSync(marker), true, 'the listing executed the spec files (measured)');
});

test('IT-ATS202-006: the agreement with the CLI is measured, not asserted', { skip: installed ? false : 'no real Playwright' }, () => {
  write('tests/dynamic.spec.ts', [
    "import { test } from '@playwright/test';",
    "for (const n of ['alpha', 'beta']) {",
    "  test(`dynamic ${n}`, async ({ page }) => {});",
    "}",
    ''
  ].join('\n'));
  write('tests/plain.spec.ts', [
    "import { test } from '@playwright/test';",
    "test('plain case', async ({ page }) => {});",
    ''
  ].join('\n'));
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  const result = discoverTests(project, state, { version: 1, projects: {} });
  assert.ok(result.consistency, 'the consistency report is present');
  // The authoritative index sees the dynamic cases, the static one does not.
  assert.equal(result.consistency.agrees, false);
  assert.equal(result.consistency.onlyAuthoritative.length, 2);
  // Every case the CLI reports is in the authoritative index: the counts
  // agree by construction.
  assert.equal(result.tests.length, result.consistency.authoritative);
});

test('IT-ATS202-007: the UID of a case does not move when the index switches', { skip: installed ? false : 'no real Playwright' }, () => {
  write('tests/dynamic.spec.ts', [
    "import { test } from '@playwright/test';",
    "for (const n of ['alpha', 'beta']) {",
    "  test(`dynamic ${n}`, async ({ page }) => {});",
    "}",
    ''
  ].join('\n'));
  write('tests/plain.spec.ts', [
    "import { test } from '@playwright/test';",
    "test('plain case', async ({ page }) => {});",
    ''
  ].join('\n'));
  // The static index first.
  const staticResult = discoverTests(project, {}, { version: 1, projects: {} }, { authoritative: false });
  const staticPlain = staticResult.tests.find((t) => t.title === 'plain case');
  // Then the authoritative one.
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  const authResult = discoverTests(project, state, staticResult.registry);
  const authPlain = authResult.tests.find((t) => t.title === 'plain case');
  assert.ok(staticPlain && authPlain, 'the ordinary case is in both indexes');
  assert.equal(authPlain.uid, staticPlain.uid, 'the UID of an ordinary case did not move');
});

test('IT-ATS202-008: a broken project config falls back and says why', { skip: installed ? false : 'no real Playwright' }, () => {
  write('playwright.config.ts', 'export default { broken\n');
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  const result = discoverTests(project, state, { version: 1, projects: {} });
  assert.equal(result.discovery, 'static');
  assert.equal(result.authoritative.attempted, true);
  assert.equal(result.authoritative.outcome, LIST_OUTCOME.FAILED);
  assert.match(result.warning, /权威发现失败/);
  // The static index still answers.
  assert.ok(Array.isArray(result.tests));
  write('playwright.config.ts',
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n", 'utf8');
});

test('IT-ATS202-009: a project without a local Playwright CLI is reported, not installed', { skip: installed ? false : 'no real Playwright' }, () => {
  const bare = path.join(WORK, 'bare');
  fs.mkdirSync(path.join(bare, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(bare, 'package.json'), '{"name":"bare","private":true}', 'utf8');
  fs.writeFileSync(path.join(bare, 'playwright.config.ts'), 'export default { testDir: "./tests" };\n', 'utf8');
  const listed = listTests({ root: bare });
  assert.equal(listed.ok, false);
  assert.equal(listed.outcome, LIST_OUTCOME.NO_CLI);
  assert.match(listed.reason, /never installs one/);
  // The adapter did NOT install anything.
  assert.equal(fs.existsSync(path.join(bare, 'node_modules')), false);
});

test('IT-ATS202-010: a listing that does not finish in time is reported as a timeout', { skip: installed ? false : 'no real Playwright' }, () => {
  // A timeout of 1 ms cannot be met by a real listing. The outcome is
  // PLAYWRIGHT_LIST_TIMEOUT, not a generic failure: the caller has to be
  // able to tell "the project is broken" from "the project is slow".
  const listed = listTests(project, { timeoutMs: 1 });
  assert.equal(listed.ok, false);
  assert.equal(listed.outcome, LIST_OUTCOME.TIMEOUT);
  assert.match(listed.reason, /did not finish within/);
  assert.equal(listed.tests.length, 0);
});

test('IT-ATS202-011: a CLI that reports an error is a failure, not an empty index', { skip: installed ? false : 'no real Playwright' }, () => {
  // A duplicate title makes the CLI write a report whose `errors[]` is not
  // empty and exit non-zero. The listing is NOT a usable index.
  write('tests/plain.spec.ts', [
    "import { test } from '@playwright/test';",
    "test('plain case', async ({ page }) => {});",
    ''
  ].join('\n'));
  write('tests/dup.spec.ts', [
    "import { test } from '@playwright/test';",
    "for (const n of ['x', 'x']) {",
    "  test(`same ${n}`, async ({ page }) => {});",
    "}",
    ''
  ].join('\n'));
  const listed = listTests(project);
  assert.equal(listed.ok, false);
  assert.equal(listed.outcome, LIST_OUTCOME.FAILED);
  assert.ok(listed.errors.length > 0, 'the CLI error is carried over');
  assert.match(JSON.stringify(listed.errors), /duplicate test title/);
  fs.rmSync(path.join(FIXTURE, 'tests', 'dup.spec.ts'), { force: true });
});

/* ------------------------------------------------------------------ */
/* the round-1 review findings, against the REAL CLI                  */
/* ------------------------------------------------------------------ */

/**
 * The consistency must not report a difference for a case BOTH indexes see.
 *
 * The round-1 reviewer drove this against the real CLI: the lexical
 * describe reader only ever pushed a title, so a case after a CLOSED
 * `describe` block still carried the block's title. The two indexes then
 * disagreed about a case both of them saw, and the user got a false
 * warning: "1 个用例仅静态索引可见".
 */
test('IT-ATS202-012: the consistency agrees for a case after a CLOSED describe', { skip: installed ? false : 'no real Playwright' }, () => {
  clearSpecs();
  write('tests/plain.spec.ts', [
    "import { test } from '@playwright/test';",
    "test.describe('group', () => {",
    "  test('inside', async () => {});",
    "});",
    "test('after', async () => {});",
    ''
  ].join('\n'));
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  const result = discoverTests(project, state, { version: 1, projects: {} });
  assert.equal(result.discovery, 'authoritative');
  assert.equal(result.consistency.agrees, true, JSON.stringify(result.consistency));
  assert.deepEqual(result.consistency.onlyStatic, []);
  assert.deepEqual(result.consistency.onlyAuthoritative, []);
});

test('IT-ATS202-013: the consistency agrees for the describe MODIFIERS', { skip: installed ? false : 'no real Playwright' }, () => {
  clearSpecs();
  write('tests/plain.spec.ts', [
    "import { test } from '@playwright/test';",
    "test.describe.serial('serial group', () => {",
    "  test('s1', async () => {});",
    "});",
    "test.describe.skip('skipped group', () => {",
    "  test('k1', async () => {});",
    "});",
    ''
  ].join('\n'));
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  const result = discoverTests(project, state, { version: 1, projects: {} });
  assert.equal(result.consistency.agrees, true, JSON.stringify(result.consistency));
});

test('IT-ATS202-014: the UID of a case with an ESCAPED QUOTE does not move', { skip: installed ? false : 'no real Playwright' }, () => {
  clearSpecs();
  write('tests/plain.spec.ts', [
    "import { test, expect } from '@playwright/test';",
    "test('user\\'s profile', async () => { expect(1).toBe(1); });",
    "test('other', async () => { expect(2).toBe(2); });",
    ''
  ].join('\n'));
  const staticResult = discoverTests(project, {}, { version: 1, projects: {} }, { authoritative: false });
  const staticCase = staticResult.tests.find((t) => t.title === "user's profile");
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  const authResult = discoverTests(project, state, staticResult.registry);
  const authCase = authResult.tests.find((t) => t.title === "user's profile");
  assert.ok(staticCase && authCase, 'the case is in both indexes');
  assert.equal(authCase.uid, staticCase.uid, 'the UID did not move when the index switched');
});

test('IT-ATS202-015: the UID of a case with a LONG title does not move', { skip: installed ? false : 'no real Playwright' }, () => {
  const long = 'checkout ' + 'x'.repeat(190);
  clearSpecs();
  write('tests/plain.spec.ts', [
    "import { test, expect } from '@playwright/test';",
    `test('${long}', async () => { expect(3).toBe(3); });`,
    ''
  ].join('\n'));
  const staticResult = discoverTests(project, {}, { version: 1, projects: {} }, { authoritative: false });
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  const authResult = discoverTests(project, state, staticResult.registry);
  assert.equal(staticResult.tests[0].title.length, 199, 'the static index reports the WHOLE title');
  assert.equal(authResult.tests[0].uid, staticResult.tests[0].uid, 'the UID did not move');
});

test('IT-ATS202-016: the UID of a MULTI-LINE test( call survives a retitle', { skip: installed ? false : 'no real Playwright' }, () => {
  const source = (title) => [
    "import { test, expect } from '@playwright/test';",
    'test(',
    `  '${title}',`,
    '  async () => { expect(7).toBe(7); }',
    ');',
    ''
  ].join('\n');
  write('tests/plain.spec.ts', source('multi line old'));
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  const before = discoverTests(project, state, { version: 1, projects: {} });
  write('tests/plain.spec.ts', source('multi line new'));
  const after = discoverTests(project, state, before.registry);
  assert.equal(after.tests[0].uid, before.tests[0].uid, 'the UID survived the retitle');
});

test('IT-ATS202-017: the TEMPLATE of a dynamic case does not inherit a rendered UID', { skip: installed ? false : 'no real Playwright' }, () => {
  clearSpecs();
  write('tests/plain.spec.ts', [
    "import { test, expect } from '@playwright/test';",
    "for (const n of ['alpha', 'beta']) {",
    "  test(`dynamic ${n}`, async () => { expect(n).toBeTruthy(); });",
    "}",
    ''
  ].join('\n'));
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  const auth = discoverTests(project, state, { version: 1, projects: {} });
  const alpha = auth.tests.find((t) => t.title === 'dynamic alpha');
  assert.ok(alpha);
  // The static index over the SAME registry.
  const statics = discoverTests(project, {}, auth.registry, { authoritative: false });
  const template = statics.tests.find((t) => t.title === 'dynamic ${n}');
  assert.ok(template, 'the static index reports the template');
  assert.notEqual(template.uid, alpha.uid, 'the template did NOT inherit the rendered case UID');
  assert.doesNotMatch(statics.warning, /注册表记录与本次发现不一致/, 'no bogus registry conflict');
});

test('IT-ATS202-CLEANUP: remove the temporary fixture', () => {
  fs.rmSync(WORK, { recursive: true, force: true });
});
