#!/usr/bin/env node
/**
 * ATS-203: the INTEGRATION tests of the dynamic / parameterised /
 * project-matrix index.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The regression dataset (`tests/ats203-regression-dataset.test.mjs`) drives
 * the index IN-PROCESS. This file drives the AUTHORITATIVE path end to end:
 * a REAL `@playwright/test` 1.64.1 runs `playwright test --list` against a
 * REAL fixture project, and the product's own `discoverTests` turns that
 * listing into the catalogue a user sees.
 *
 * The acceptance criterion of ATS-203 is "重名、describe、参数化、重复
 * project 的结果正确**或**标明不可判定". That criterion is about the
 * RESULT of the index, and the authoritative index is the one that sees the
 * cases that really run. So every scenario below is asserted on BOTH
 * indexes -- the static one and the authoritative one -- because the
 * disagreement between them is itself a fact the dataset has to pin down.
 *
 * THE FIXTURES
 * ------------
 * The fixture uses Playwright's REAL parameterisation form: a `for` /
 * `forEach` loop. There is no `test.each` in Playwright (measured: the CLI
 * answers `TypeError: _test.test.each is not a function`), so a fixture
 * built on it would test nothing but that typo.
 *
 * THE REAL PLAYWRIGHT
 * -------------------
 * The listing runs the PROJECT's own CLI, so the fixture needs a
 * `node_modules`. The real CLI of the repository (the example project's
 * dependency tree) is linked into the fixture as a JUNCTION -- the same
 * trick the ATS-202 probes use. Nothing is installed here: a dataset that
 * installs its own engine would test a different engine than the product
 * runs.
 *
 * When no real CLI is reachable, the cases that need it are SKIPPED with a
 * reason -- never reported as a pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverStatic, discoverTests } from '../server/core.mjs';
import { withTrust, TRUST } from '../server/discovery/trust.mjs';
import { LIST_OUTCOME } from '../server/discovery/playwright-list.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-203-it-'));

test.after(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

/**
 * The REAL `@playwright/test` the fixtures can reach.
 *
 * The candidates are the repository's own example project and the local
 * integration checkout. The fixture links the directory as a JUNCTION, so
 * the fixture has a `node_modules` without installing anything.
 */
function findPlaywrightModules() {
  const candidates = [
    process.env.ATS203_PLAYWRIGHT_MODULES,
    path.join(REPO_ROOT, 'examples', 'sample-playwright', 'node_modules'),
    'D:/ICHOR/examples/sample-playwright/node_modules',
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, '@playwright', 'test', 'cli.js'))) return dir;
  }
  return null;
}

const PLAYWRIGHT_MODULES = findPlaywrightModules();
const SKIP = PLAYWRIGHT_MODULES ? false : 'the real @playwright/test could not be reached';

let seq = 0;

/**
 * Creates a temporary project.
 *
 * The project id is UNIQUE per project: the UID of a case is derived from
 * the project UID, so two projects that share an id would hand two different
 * cases the same UID -- and the assertions would compare apples with
 * oranges.
 */
function createProject(name, { config = "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n" } = {}) {
  const projectDir = path.join(tmpBase, name);
  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"ats203-it","private":true}');
  fs.writeFileSync(path.join(projectDir, 'playwright.config.ts'), config);
  if (PLAYWRIGHT_MODULES) {
    try {
      fs.symlinkSync(PLAYWRIGHT_MODULES, path.join(projectDir, 'node_modules'), 'junction');
    } catch {
      // A junction cannot be created here: the listing reports
      // PLAYWRIGHT_NOT_INSTALLED and the case that needs it says so.
    }
  }
  const id = `proj_1_0123456789abcdef01234${(++seq).toString(16).padStart(6, '0')}`;
  return { id, uid: id, root: projectDir };
}

/** Writes a test file into the project's `tests` directory. */
function writeTestFile(project, filename, content) {
  fs.writeFileSync(path.join(project.root, 'tests', filename), content);
}

/** The static index of a project. */
function staticIndex(project) {
  return discoverStatic(project);
}

/** The authoritative index of a project: the real `playwright test --list`. */
function authoritativeIndex(project) {
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  return discoverTests(project, state, { version: 1, projects: {} });
}

/** The number of Playwright projects a case ran in. */
const specIdCount = (t) => (Array.isArray(t.specIds) ? t.specIds.length : null);

/* ======================================================================== */
/* IT-ATS203-001: a parameterised LOOP with a TEMPLATE title               */
/* ======================================================================== */
/*
 * THE COUNTEREXAMPLE THAT MADE THIS TASK NECESSARY, measured against the
 * REAL engine.
 *
 * The static index reads the template `支付 - ${method}` as ONE case. Before
 * ATS-203 it gave that case a STABLE derived UID -- a stable identifier
 * for a title that no case will ever report: at runtime the cases are
 * `支付 - 支付宝`, `支付 - 微信` and `支付 - 银行卡`.
 *
 * The authoritative index sees the three rendered cases. The static index
 * must therefore say that it CANNOT decide how many cases there are -- not
 * claim one stable case.
 */
test('IT-ATS203-001: the authoritative index sees the rendered cases, and the static index says it cannot decide', { skip: SKIP }, () => {
  const project = createProject('ats203-it-param-loop');
  writeTestFile(project, 'payment.spec.ts', [
    "import { test } from '@playwright/test';",
    '',
    "test.describe('支付方式', () => {",
    "  for (const method of ['支付宝', '微信', '银行卡']) {",
    '    test(`支付 - ${method}`, async () => {});',
    '  }',
    '});',
    ''
  ].join('\n'));

  const stat = staticIndex(project);
  const auth = authoritativeIndex(project);

  // --- the static index: ONE entry, and it says it cannot decide --------
  assert.equal(stat.tests.length, 1, 'the static index sees the template only');
  const only = stat.tests[0];
  assert.equal(only.title, '支付 - ${method}', 'the template is reported as it is written');
  assert.equal(only.uidStable, false, 'a template title does not identify a case');
  assert.equal(only.uidSource, 'provisional');
  assert.equal(only.ambiguity.reason, 'dynamic-template-title');
  assert.equal(only.ambiguity.template, '支付 - ${method}');
  assert.match(stat.warning, /1 个用例的标题是动态模板/);
  assert.match(stat.warning, /用例数量不可判定/);

  // --- the authoritative index: THREE rendered cases ---------------------
  assert.equal(auth.discovery, 'authoritative');
  assert.equal(auth.authoritative.outcome, LIST_OUTCOME.OK);
  assert.equal(auth.tests.length, 3, 'the engine renders three cases');
  assert.deepEqual(
    auth.tests.map((t) => t.title).sort(),
    ['支付 - 微信', '支付 - 支付宝', '支付 - 银行卡'].sort()
  );
  // Every rendered case carries its OWN stable UID -- the identity of a
  // rendered case is decided by the describe path.
  assert.equal(auth.tests.every((t) => t.uidStable), true,
    'every rendered case is decidable');
  assert.equal(new Set(auth.tests.map((t) => t.uid)).size, 3,
    'the three rendered cases have three different UIDs');
  for (const t of auth.tests) {
    assert.equal(t.ambiguity, undefined, 'a rendered case carries no ambiguity');
  }

  // --- AND THE TWO INDEXES DISAGREE, WHICH IS THE POINT ------------------
  // The consistency report has to say so. The static index reports the
  // TEMPLATE, and the template matches NONE of the three rendered titles,
  // so all three rendered cases are only visible to the authoritative index.
  assert.ok(auth.consistency, 'the consistency report is present');
  assert.equal(auth.consistency.agrees, false, 'the two indexes do NOT agree here');
  assert.equal(auth.consistency.onlyAuthoritative.length, 3,
    'all three rendered cases are only visible to the authoritative index');
  assert.equal(auth.consistency.onlyStatic.length, 1,
    'the template itself is only visible to the static index');
});

/* ======================================================================== */
/* IT-ATS203-002: the parameterised same title (the engine refuses it)    */
/* ======================================================================== */
/*
 * The engine refuses the whole file with `duplicate test title`. The
 * answer has to SAY that instead of pretending it listed the project.
 *
 * This is the counterexample 2 of the review: it has to be pinned down on
 * BOTH paths -- the static one (one stable entry) and the authoritative one
 * (the refusal).
 */
test('IT-ATS203-002: the parameterised same title is refused by the engine and reported as such', { skip: SKIP }, () => {
  const project = createProject('ats203-it-param-same-title');
  writeTestFile(project, 'dup.spec.ts', [
    "import { test } from '@playwright/test';",
    '',
    'for (const x of [1, 2]) {',
    "  test('同名参数化', async () => {});",
    '}',
    ''
  ].join('\n'));

  const stat = staticIndex(project);
  // The static index reads the literal title once, so it CAN give it a
  // stable UID -- but it cannot know that the loop produces two cases.
  assert.equal(stat.tests.length, 1, 'the static index sees the literal title once');
  assert.equal(stat.tests[0].title, '同名参数化');
  assert.equal(stat.tests[0].uidStable, true, 'the literal title itself is readable');
  assert.equal(stat.tests[0].ambiguity, undefined, 'a literal title is not a template');
  assert.doesNotMatch(stat.warning, /动态模板/);

  const auth = authoritativeIndex(project);
  assert.equal(auth.discovery, 'static', 'the engine refused the project, so the index fell back');
  assert.equal(auth.authoritative.outcome, LIST_OUTCOME.FAILED);
  assert.equal(auth.authoritative.attempted, true, 'the listing WAS attempted');
  assert.match(auth.warning, /权威发现失败/);
  assert.match(auth.warning, /duplicate test title/,
    'the warning carries the engine\'s own reason');
  assert.equal(auth.authoritative.errors.length, 1);
  assert.match(auth.authoritative.errors[0].message, /duplicate test title "同名参数化"/);
});

/* ======================================================================== */
/* IT-ATS203-003: the same describe with the same title, twice            */
/* ======================================================================== */
test('IT-ATS203-003: the same describe with the same title is refused by the engine and reported as ambiguous', { skip: SKIP }, () => {
  const project = createProject('ats203-it-same-describe');
  writeTestFile(project, 'checkout.spec.ts', [
    "import { test } from '@playwright/test';",
    '',
    "test.describe('结算', () => {",
    "  test('提交订单', async () => {});",
    '});',
    '',
    "test.describe('结算', () => {",
    "  test('提交订单', async () => {});",
    '});',
    ''
  ].join('\n'));

  const stat = staticIndex(project);
  assert.equal(stat.tests.length, 2, 'both cases are indexed');
  for (const t of stat.tests) {
    assert.equal(t.uidStable, false);
    assert.equal(t.uidSource, 'provisional');
    assert.equal(t.ambiguity.reason, 'identical-title-and-body');
  }
  assert.notEqual(stat.tests[0].uid, stat.tests[1].uid, 'the two cases keep their own UID');
  assert.match(stat.warning, /2 个用例的 UID 为临时值/);

  const auth = authoritativeIndex(project);
  assert.equal(auth.authoritative.outcome, LIST_OUTCOME.FAILED);
  assert.match(auth.authoritative.errors[0].message, /duplicate test title "结算 › 提交订单"/,
    'the engine names the describe path in its refusal');
});

/* ======================================================================== */
/* IT-ATS203-004: the same title in two files                             */
/* ======================================================================== */
test('IT-ATS203-004: the same title in two files is two cases in the authoritative index', { skip: SKIP }, () => {
  const project = createProject('ats203-it-cross-file');
  writeTestFile(project, 'admin.spec.ts', [
    "import { test } from '@playwright/test';",
    '',
    "test.describe('管理员功能', () => {",
    "  test('可以登录', async () => {});",
    '});',
    ''
  ].join('\n'));
  writeTestFile(project, 'user.spec.ts', [
    "import { test } from '@playwright/test';",
    '',
    "test.describe('普通用户功能', () => {",
    "  test('可以登录', async () => {});",
    '});',
    ''
  ].join('\n'));

  const stat = staticIndex(project);
  assert.equal(stat.tests.length, 2, 'both same-titled cases are indexed');
  assert.equal(stat.tests.every((t) => t.ambiguity.reason === 'identical-title-and-body'), true);

  // The authoritative index SEES the two describes, so it can tell the two
  // cases apart: the describe path is part of the identity.
  const auth = authoritativeIndex(project);
  assert.equal(auth.discovery, 'authoritative');
  assert.equal(auth.authoritative.outcome, LIST_OUTCOME.OK);
  assert.equal(auth.tests.length, 2, 'the engine reports two cases');
  assert.equal(auth.tests.every((t) => t.uidStable), true,
    'the describe path makes them decidable');
  assert.equal(new Set(auth.tests.map((t) => t.uid)).size, 2,
    'the two cases have two different UIDs');
  // The order is the order of the source, NOT the code-point order: the
  // fixture writes 管理员功能 first.
  assert.deepEqual(
    auth.tests.map((t) => t.describePath.join('>')),
    ['管理员功能', '普通用户功能'],
    'each case keeps its own describe path'
  );
});

/* ======================================================================== */
/* IT-ATS203-005: the same title under two DIFFERENT describes             */
/* ======================================================================== */
test('IT-ATS203-005: the same title under two different describes is two decidable cases', { skip: SKIP }, () => {
  const project = createProject('ats203-it-diff-describe');
  writeTestFile(project, 'both.spec.ts', [
    "import { test } from '@playwright/test';",
    '',
    "test.describe('管理员功能', () => {",
    "  test('可以登录', async () => {});",
    '});',
    '',
    "test.describe('普通用户功能', () => {",
    "  test('可以登录', async () => {});",
    '});',
    ''
  ].join('\n'));

  const stat = staticIndex(project);
  assert.equal(stat.tests.length, 2);
  assert.equal(stat.tests.every((t) => t.ambiguity.reason === 'identical-title-and-body'), true,
    'the static index does not use the describe path');
  assert.notEqual(stat.tests[0].uid, stat.tests[1].uid);

  const auth = authoritativeIndex(project);
  assert.equal(auth.discovery, 'authoritative');
  assert.equal(auth.tests.length, 2);
  assert.equal(auth.tests.every((t) => t.uidStable), true,
    'the authoritative index resolves them by the describe path');
  assert.equal(new Set(auth.tests.map((t) => t.uid)).size, 2);
});

/* ======================================================================== */
/* IT-ATS203-006: the SYMMETRIC project matrix                            */
/* ======================================================================== */
test('IT-ATS203-006: the symmetric project matrix gives every case two spec ids', { skip: SKIP }, () => {
  const project = createProject('ats203-it-matrix', {
    config: "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0, projects: [ { name: 'chromium' }, { name: 'firefox' } ] });\n"
  });
  writeTestFile(project, 'a.spec.ts', "import { test } from '@playwright/test';\ntest('case a', async () => {});\n");
  writeTestFile(project, 'b.spec.ts', "import { test } from '@playwright/test';\ntest('case b', async () => {});\n");

  const stat = staticIndex(project);
  assert.equal(stat.tests.length, 2, 'the static index reports the two cases once each');
  assert.equal(stat.tests.every((t) => t.uidStable), true);
  assert.equal(stat.tests.every((t) => specIdCount(t) === null), true,
    'the static index carries no spec ids');

  const auth = authoritativeIndex(project);
  assert.equal(auth.discovery, 'authoritative');
  assert.equal(auth.authoritative.outcome, LIST_OUTCOME.OK);
  assert.equal(auth.tests.length, 2, 'the matrix is ONE logical case per case, not one per project');
  assert.deepEqual(auth.tests.map((t) => t.title), ['case a', 'case b']);
  for (const t of auth.tests) {
    assert.equal(specIdCount(t), 2, 'every case ran in both projects');
    assert.equal(t.uidStable, true);
  }
  const a = auth.tests.find((t) => t.title === 'case a');
  assert.equal(new Set(a.specIds).size, 2, 'the two projects report two different spec ids');

  // AND THE TWO INDEXES AGREE on the UID of a logical case. This is the
  // property the matrix must not break.
  const staticByTitle = new Map(stat.tests.map((t) => [t.title, t.uid]));
  for (const t of auth.tests) {
    assert.equal(t.uid, staticByTitle.get(t.title),
      `the UID of "${t.title}" is the same in both indexes`);
  }
});

/* ======================================================================== */
/* IT-ATS203-007: the ASYMMETRIC project matrix                           */
/* ======================================================================== */
test('IT-ATS203-007: the asymmetric project matrix gives the case counts of 2 and 1', { skip: SKIP }, () => {
  const project = createProject('ats203-it-matrix-asym', {
    config: "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0, projects: [ { name: 'all' }, { name: 'only-a', testMatch: /a\\.spec\\.ts/ } ] });\n"
  });
  writeTestFile(project, 'a.spec.ts', "import { test } from '@playwright/test';\ntest('case a', async () => {});\n");
  writeTestFile(project, 'b.spec.ts', "import { test } from '@playwright/test';\ntest('case b', async () => {});\n");

  const stat = staticIndex(project);
  assert.equal(stat.tests.length, 2);
  assert.equal(stat.tests.every((t) => t.uidStable), true);

  const auth = authoritativeIndex(project);
  assert.equal(auth.discovery, 'authoritative');
  assert.equal(auth.tests.length, 2);
  const a = auth.tests.find((t) => t.title === 'case a');
  const b = auth.tests.find((t) => t.title === 'case b');
  assert.equal(specIdCount(a), 2, 'case a runs in both projects');
  assert.equal(specIdCount(b), 1, 'case b runs only in the project that matches it');
  assert.equal(a.uidStable, true);
  assert.equal(b.uidStable, true);

  // The two indexes still agree on the UID.
  const staticByTitle = new Map(stat.tests.map((t) => [t.title, t.uid]));
  assert.equal(a.uid, staticByTitle.get('case a'));
  assert.equal(b.uid, staticByTitle.get('case b'));
});

/* ======================================================================== */
/* IT-ATS203-008: a forEach loop is the same as a for loop                */
/* ======================================================================== */
test('IT-ATS203-008: a forEach loop renders one case per item', { skip: SKIP }, () => {
  const project = createProject('ats203-it-foreach');
  writeTestFile(project, 'foreach.spec.ts', [
    "import { test } from '@playwright/test';",
    '',
    "['alpha', 'beta', 'gamma'].forEach((name) => {",
    '  test(`case ${name}`, async () => {});',
    '});',
    ''
  ].join('\n'));

  const stat = staticIndex(project);
  assert.equal(stat.tests.length, 1, 'the static index sees the template only');
  assert.equal(stat.tests[0].uidStable, false);
  assert.equal(stat.tests[0].ambiguity.reason, 'dynamic-template-title');

  const auth = authoritativeIndex(project);
  assert.equal(auth.discovery, 'authoritative');
  assert.equal(auth.tests.length, 3, 'the engine renders three cases');
  assert.deepEqual(
    auth.tests.map((t) => t.title).sort(),
    ['case alpha', 'case beta', 'case gamma']
  );
  assert.equal(auth.tests.every((t) => t.uidStable), true);
});

/* ======================================================================== */
/* IT-ATS203-009: the UID of a case does not move between the indexes    */
/* ======================================================================== */
test('IT-ATS203-009: the UID of an ordinary case does not move when the index switches', { skip: SKIP }, () => {
  const project = createProject('ats203-it-uid-stable');
  writeTestFile(project, 'plain.spec.ts', [
    "import { test } from '@playwright/test';",
    "test('plain case', async () => {});",
    ''
  ].join('\n'));

  const stat = staticIndex(project);
  const auth = authoritativeIndex(project);
  const staticPlain = stat.tests.find((t) => t.title === 'plain case');
  const authPlain = auth.tests.find((t) => t.title === 'plain case');
  assert.ok(staticPlain && authPlain, 'the ordinary case is in both indexes');
  assert.equal(authPlain.uid, staticPlain.uid, 'the UID did not move');
  assert.equal(authPlain.uidStable, true);
});
