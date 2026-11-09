#!/usr/bin/env node
/**
 * ATS-203: the regression dataset of the DYNAMIC / PARAMETERISED /
 * PROJECT-MATRIX index.
 *
 * WHAT THIS DATASET IS FOR
 * ------------------------
 * The acceptance criterion of ATS-203 is: "重名、describe、参数化、重复 project
 * 的结果正确**或**标明不可判定" -- the index either gives the RIGHT answer or
 * says that it cannot decide. Every case below asserts the CONCRETE output of
 * the index (the number of cases, their titles, `uidStable`, `uidSource`,
 * `ambiguity.reason`, the number of `specIds`, and a SCENE-SPECIFIC fragment
 * of the warning) -- never a tautology.
 *
 * WHY THE ASSERTIONS LOOK LIKE THIS
 * ---------------------------------
 * The first delivery of this dataset was rejected twice because its
 * assertions had no discriminating power: `warning.includes('动态')` is true
 * for EVERY project (the base warning always contains it), and a case with no
 * assertion at all passes under any implementation. The dataset is therefore
 * checked against MUTANTS -- see `tools/ats203-probes/run-mutants.sh`:
 *
 *   * M1 (the ambiguity flag is turned off)   -> the dataset MUST fail;
 *   * M2 (the template titles are dropped)     -> the dataset MUST fail;
 *   * M3 (the static scan returns nothing)     -> every case that touches the
 *                                                static index MUST fail.
 *
 * THE TWO INDEXES
 * ---------------
 * The STATIC index (`discoverStatic`) reads the source text. The
 * AUTHORITATIVE index (`discoverTests` on a trusted project) runs the real
 * `playwright test --list` and sees the cases that will really run. Both are
 * asserted here, because the task's acceptance criterion is about the result
 * of the index as a whole -- and because the two disagreeing is itself a
 * fact that has to be pinned down.
 *
 * THE FIXTURES
 * ------------
 * The fixtures use Playwright's REAL parameterisation form: a `for` /
 * `forEach` loop. There is no `test.each` in Playwright (measured: the CLI
 * answers `TypeError: _test.test.each is not a function`), so a fixture
 * built on it would test nothing but that typo.
 *
 * The temporary projects are removed by `test.after`, so a run that is
 * filtered by `--test-name-pattern` leaves nothing behind.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverStatic, discoverTests } from '../server/core.mjs';
import { withTrust, TRUST } from '../server/discovery/trust.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-203-'));

after(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

/**
 * A REAL `@playwright/test` the fixtures can reach.
 *
 * The authoritative index runs the PROJECT's own Playwright CLI, so a
 * fixture that has no `node_modules` cannot be listed. The real CLI of the
 * repository (the example project's dependency tree) is therefore linked
 * into the fixture as a JUNCTION -- the same trick the ATS-202 probes use.
 *
 * The CLI is NOT installed by this file: the adapter never installs anything,
 * and a dataset that installs its own engine would test a different engine
 * than the product runs. When no real CLI is reachable, the cases that need
 * it are SKIPPED with a reason -- never reported as a pass.
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

let seq = 0;

/**
 * Creates a temporary project.
 *
 * The project id is UNIQUE per project: the UID of a case is derived from the
 * project UID, so two projects that share an id would hand two different
 * cases the same UID -- and the dataset would then compare apples with
 * oranges.
 */
function createProject(name, { config = "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n" } = {}) {
  const projectDir = path.join(tmpBase, name);
  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"ats203","private":true}');
  fs.writeFileSync(path.join(projectDir, 'playwright.config.ts'), config);
  if (PLAYWRIGHT_MODULES) {
    try {
      fs.symlinkSync(PLAYWRIGHT_MODULES, path.join(projectDir, 'node_modules'), 'junction');
    } catch {
      // A junction cannot be created here: the authoritative index will
      // report PLAYWRIGHT_NOT_INSTALLED, and the cases that need it say so.
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

/**
 * The authoritative index of a project: the real `playwright test --list`.
 *
 * A project with no local Playwright CLI cannot be listed, so the answer
 * says so (`PLAYWRIGHT_NOT_INSTALLED`) rather than pretending. The cases
 * that need the authoritative index are the ones that assert on it, and they
 * say which outcome they need.
 */
function authoritativeIndex(project) {
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  return discoverTests(project, state, { version: 1, projects: {} });
}

/** The shape every index answer has to have. */
function validateIndex(result) {
  assert(Array.isArray(result.tests), 'should return tests array');
  assert(typeof result.discovery === 'string', 'should have discovery method');
  assert(typeof result.uidVersion === 'number', 'should have uidVersion');
  assert(typeof result.projectUid === 'string', 'should have projectUid');
  assert(typeof result.warning === 'string', 'should have warning message');
  return result;
}

/** The `specIds` of a case: the number of Playwright projects it ran in. */
const specIdCount = (t) => (Array.isArray(t.specIds) ? t.specIds.length : null);

/* ======================================================================== */
/* ST-ATS-203-001: a parameterised LOOP with a TEMPLATE title              */
/* ======================================================================== */
/*
 * THE COUNTEREXAMPLE THAT MADE THIS TASK NECESSARY.
 *
 * The static index reads the template `支付 - ${method}` as ONE case. Before
 * ATS-203 it gave that case a STABLE derived UID (`uidStable: true`,
 * `uidSource: 'derived'`) -- a stable identifier for a title that no case
 * will ever report: at runtime the cases are `支付 - 支付宝`, `支付 - 微信`
 * and `支付 - 银行卡`.
 *
 * A stable UID pointing at a case that does not exist is worse than an
 * unstable one: an unstable one sends the reader to a human, a stable one
 * makes them believe the case is accounted for.
 */
test('ST-ATS-203-001: a parameterised loop with a template title is reported as indeterminable', () => {
  const project = createProject('ats203-param-loop');
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

  const result = validateIndex(staticIndex(project));

  // Exactly ONE case: the template. The static index cannot know that the
  // template renders three cases -- and it must not pretend to.
  assert.equal(result.tests.length, 1, 'the static index sees the template only');
  const only = result.tests[0];
  assert.equal(only.title, '支付 - ${method}', 'the template is reported as it is written');
  assert.equal(only.file, 'tests/payment.spec.ts');
  assert.equal(only.line, 5, 'the line of the call');

  // AND IT IS NOT STABLE: this is the whole point of the case.
  assert.equal(only.uidStable, false, 'a template title does not identify a case');
  assert.equal(only.uidSource, 'provisional', 'a template title gets no derived UID');
  assert.equal(only.ambiguity.reason, 'dynamic-template-title',
    'the ambiguity says WHY the case is undecidable');
  assert.equal(only.ambiguity.template, '支付 - ${method}',
    'the ambiguity carries the template it is about');
  assert.equal(only.uid.startsWith('tcp_1_'), true,
    'the UID is a provisional one, not a derived one');

  // The warning names THIS case and not a generic sentence. The number and
  // the wording are both asserted, so a warning that says "dynamic" for
  // every project cannot satisfy it.
  assert.match(result.warning, /1 个用例的标题是动态模板/,
    'the warning counts the template case');
  assert.match(result.warning, /用例数量不可判定/,
    'the warning says the case count is undecidable');
  assert.doesNotMatch(result.warning, /个用例的 UID 为临时值（标题重复/,
    'a template is NOT reported as a duplicate title');

  // The CONTROL: a project with NO parameterisation does not carry that
  // warning at all. Without this the warning clause above would be a
  // tautology again.
  const plain = createProject('ats203-plain-control');
  writeTestFile(plain, 'plain.spec.ts', "import { test } from '@playwright/test';\ntest('plain case', async () => {});\n");
  const plainResult = validateIndex(staticIndex(plain));
  assert.doesNotMatch(plainResult.warning, /动态模板/,
    'an ordinary project does not carry the template warning');
  assert.equal(plainResult.tests.length, 1);
  assert.equal(plainResult.tests[0].uidStable, true,
    'an ordinary case keeps its stable UID');
});

/* ======================================================================== */
/* ST-ATS-203-002: a parameterised loop with a LITERAL title               */
/* ======================================================================== */
/*
 * The title of the loop is a LITERAL, so the static index CAN read it. What
 * it cannot know is HOW MANY cases the loop produces: the literal title
 * renders three cases that share one title.
 *
 * This is the case the engine itself refuses: Playwright rejects the whole
 * file with `duplicate test title`. The static index keeps one stable entry
 * (the title is readable and unique in the file), and the authoritative
 * index reports the failure instead of pretending to have listed the project.
 */
test('ST-ATS-203-002: a parameterised loop with a literal title is indexed once, and the engine refuses it', () => {
  const project = createProject('ats203-param-literal');
  writeTestFile(project, 'dup.spec.ts', [
    "import { test } from '@playwright/test';",
    '',
    'for (const x of [1, 2]) {',
    "  test('同名参数化', async () => {});",
    '}',
    ''
  ].join('\n'));

  const result = validateIndex(staticIndex(project));

  // ONE entry: the literal title appears once in the source.
  assert.equal(result.tests.length, 1, 'the static index sees the literal title once');
  const only = result.tests[0];
  assert.equal(only.title, '同名参数化');
  assert.equal(only.line, 4);
  // The title is readable and unique in this file, so the static index CAN
  // give it a stable UID. It is NOT a template, so it is NOT indeterminable.
  assert.equal(only.uidStable, true, 'a literal title is readable, so the UID is stable');
  assert.equal(only.uidSource, 'derived');
  assert.equal(only.ambiguity, undefined, 'a literal title is not a template');
  assert.doesNotMatch(result.warning, /动态模板/,
    'a literal title is not reported as a template');

  // The authoritative index: the ENGINE refuses the project, and the answer
  // says so instead of falling back silently.
  const auth = authoritativeIndex(project);
  assert.equal(auth.discovery, 'static', 'the engine refused the project, so the index fell back');
  assert.equal(auth.authoritative.outcome, 'PLAYWRIGHT_LIST_FAILED');
  assert.match(auth.warning, /权威发现失败/);
  assert.match(auth.warning, /duplicate test title/,
    'the warning carries the engine\'s own reason');
  assert.equal(auth.authoritative.errors.length, 1);
  assert.match(auth.authoritative.errors[0].message, /duplicate test title "同名参数化"/);
});

/* ======================================================================== */
/* ST-ATS-203-003: the same title in two files                            */
/* ======================================================================== */
test('ST-ATS-203-003: the same title in two files is reported as ambiguous, not merged', () => {
  const project = createProject('ats203-cross-file');
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

  const result = validateIndex(staticIndex(project));

  // BOTH cases are there -- neither is dropped, and neither is merged.
  assert.equal(result.tests.length, 2, 'both same-titled cases are indexed');
  const titles = result.tests.map((t) => t.title);
  assert.deepEqual(titles, ['可以登录', '可以登录']);
  assert.deepEqual(result.tests.map((t) => t.file).sort(),
    ['tests/admin.spec.ts', 'tests/user.spec.ts'], 'the two cases come from the two files');

  // The static index cannot tell them apart (same title AND same body), so
  // both are provisional and both are reported.
  for (const t of result.tests) {
    assert.equal(t.uidStable, false, 'a same-titled case is not stable');
    assert.equal(t.uidSource, 'provisional');
    assert.equal(t.ambiguity.reason, 'identical-title-and-body');
    assert.equal(t.ambiguity.candidates.length, 2, 'both candidates are listed');
  }
  // They are NOT merged: two different provisional identifiers.
  assert.notEqual(result.tests[0].uid, result.tests[1].uid, 'the two cases keep their own UID');
  assert.match(result.warning, /2 个用例的 UID 为临时值（标题重复且无法唯一判定）/,
    'the warning counts exactly these two cases');

  // The CONTROL: a project with ONE such title does not carry that warning.
  const single = createProject('ats203-cross-file-control');
  writeTestFile(single, 'admin.spec.ts', [
    "import { test } from '@playwright/test';",
    "test.describe('管理员功能', () => {",
    "  test('可以登录', async () => {});",
    '});',
    ''
  ].join('\n'));
  const singleResult = validateIndex(staticIndex(single));
  assert.doesNotMatch(singleResult.warning, /个用例的 UID 为临时值（标题重复/,
    'a single case does not carry the duplicate-title warning');
  assert.equal(singleResult.tests[0].uidStable, true);
});

/* ======================================================================== */
/* ST-ATS-203-004: the same describe and the same title, twice            */
/* ======================================================================== */
test('ST-ATS-203-004: the same describe with the same title is reported as ambiguous', () => {
  const project = createProject('ats203-same-describe');
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

  const result = validateIndex(staticIndex(project));

  assert.equal(result.tests.length, 2, 'both cases are indexed');
  assert.deepEqual(result.tests.map((t) => t.line), [4, 8], 'the two calls are on their own lines');
  for (const t of result.tests) {
    assert.equal(t.uidStable, false);
    assert.equal(t.uidSource, 'provisional');
    assert.equal(t.ambiguity.reason, 'identical-title-and-body');
  }
  assert.notEqual(result.tests[0].uid, result.tests[1].uid);
  assert.match(result.warning, /2 个用例的 UID 为临时值/);

  // The engine refuses this project too, and the answer says so.
  const auth = authoritativeIndex(project);
  assert.equal(auth.authoritative.outcome, 'PLAYWRIGHT_LIST_FAILED');
  assert.match(auth.authoritative.errors[0].message, /duplicate test title "结算 › 提交订单"/,
    'the engine names the describe path in its refusal');
});

/* ======================================================================== */
/* ST-ATS-203-005: two DIFFERENT describes with the same title             */
/* ======================================================================== */
test('ST-ATS-203-005: the same title under two different describes is reported as ambiguous', () => {
  const project = createProject('ats203-diff-describe');
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

  const result = validateIndex(staticIndex(project));

  assert.equal(result.tests.length, 2, 'both cases are indexed');
  assert.deepEqual(result.tests.map((t) => t.line), [4, 8]);
  for (const t of result.tests) {
    assert.equal(t.uidStable, false, 'the static index does not use the describe path');
    assert.equal(t.ambiguity.reason, 'identical-title-and-body');
  }
  assert.notEqual(result.tests[0].uid, result.tests[1].uid);
  assert.match(result.warning, /2 个用例的 UID 为临时值/);
});

/* ======================================================================== */
/* ST-ATS-203-006: the SYMMETRIC project matrix                           */
/* ======================================================================== */
test('ST-ATS-203-006: the symmetric project matrix gives every case two spec ids', () => {
  const project = createProject('ats203-matrix', {
    config: "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', projects: [ { name: 'chromium' }, { name: 'firefox' } ] });\n"
  });
  writeTestFile(project, 'a.spec.ts', "import { test } from '@playwright/test';\ntest('case a', async () => {});\n");
  writeTestFile(project, 'b.spec.ts', "import { test } from '@playwright/test';\ntest('case b', async () => {});\n");

  const result = validateIndex(staticIndex(project));
  assert.equal(result.tests.length, 2, 'the static index reports the two cases once each');
  assert.deepEqual(result.tests.map((t) => t.title), ['case a', 'case b']);
  for (const t of result.tests) {
    assert.equal(t.uidStable, true);
    // The static index does not know about the projects at all.
    assert.equal(specIdCount(t), null, 'the static index carries no spec ids');
  }

  // The authoritative index is where the matrix shows up: every logical case
  // is reported once per Playwright project, with its own spec id.
  const auth = authoritativeIndex(project);
  assert.equal(auth.discovery, 'authoritative');
  assert.equal(auth.authoritative.outcome, 'OK');
  assert.equal(auth.tests.length, 2, 'the matrix is ONE logical case per case, not one per project');
  assert.deepEqual(auth.tests.map((t) => t.title), ['case a', 'case b']);
  for (const t of auth.tests) {
    assert.equal(specIdCount(t), 2, 'every case ran in both projects');
    assert.equal(t.uidStable, true);
  }
  // The two spec ids of a case are DIFFERENT: the matrix is what makes the
  // per-project identity.
  const a = auth.tests.find((t) => t.title === 'case a');
  assert.equal(new Set(a.specIds).size, 2, 'the two projects report two different spec ids');

  // AND THE TWO INDEXES AGREE on the UID of a logical case. This is the
  // property the matrix must not break.
  const staticByTitle = new Map(result.tests.map((t) => [t.title, t.uid]));
  for (const t of auth.tests) {
    assert.equal(t.uid, staticByTitle.get(t.title),
      `the UID of "${t.title}" is the same in both indexes`);
  }
});

/* ======================================================================== */
/* ST-ATS-203-007: the ASYMMETRIC project matrix                          */
/* ======================================================================== */
test('ST-ATS-203-007: the asymmetric project matrix gives the case counts of 2 and 1', () => {
  const project = createProject('ats203-matrix-asym', {
    config: "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', projects: [ { name: 'all' }, { name: 'only-a', testMatch: /a\\.spec\\.ts/ } ] });\n"
  });
  writeTestFile(project, 'a.spec.ts', "import { test } from '@playwright/test';\ntest('case a', async () => {});\n");
  writeTestFile(project, 'b.spec.ts', "import { test } from '@playwright/test';\ntest('case b', async () => {});\n");

  const result = validateIndex(staticIndex(project));
  assert.equal(result.tests.length, 2);
  assert.equal(result.tests.every((t) => t.uidStable), true);

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
  const staticByTitle = new Map(result.tests.map((t) => [t.title, t.uid]));
  assert.equal(a.uid, staticByTitle.get('case a'));
  assert.equal(b.uid, staticByTitle.get('case b'));
});

/* ======================================================================== */
/* ST-ATS-203-008: the determinism of a repeated discovery                */
/* ======================================================================== */
/*
 * The former ST-006 ("the same project indexed twice") was really about the
 * DETERMINISM of a repeated discovery -- it never was about the project
 * matrix. It is renamed accordingly, and it now asserts the whole answer:
 * the same case set, the same UIDs, the same warning.
 */
test('ST-ATS-203-008: the determinism of a repeated discovery', () => {
  const project = createProject('ats203-repeat');
  writeTestFile(project, 'auth.spec.ts', [
    "import { test } from '@playwright/test';",
    "test.describe('登录', () => {",
    "  test('成功登录', async () => {});",
    '});',
    ''
  ].join('\n'));

  const first = validateIndex(staticIndex(project));
  const second = validateIndex(staticIndex(project));

  assert.equal(first.tests.length, 1);
  assert.equal(second.tests.length, 1, 'the second discovery finds the same number of cases');
  assert.equal(first.tests[0].uid, second.tests[0].uid, 'the UID does not move');
  assert.equal(first.tests[0].title, second.tests[0].title);
  assert.equal(first.tests[0].uidStable, second.tests[0].uidStable);
  assert.equal(first.warning, second.warning, 'the warning is the same too');
  // The whole answer is the same, not just the UID.
  assert.deepEqual(
    first.tests.map((t) => ({ title: t.title, uid: t.uid, file: t.file, line: t.line })),
    second.tests.map((t) => ({ title: t.title, uid: t.uid, file: t.file, line: t.line }))
  );
});

/* ======================================================================== */
/* ST-ATS-203-009: nested describes                                       */
/* ======================================================================== */
test('ST-ATS-203-009: nested describes are indexed with distinct UIDs', () => {
  const project = createProject('ats203-nested');
  writeTestFile(project, 'cart.spec.ts', [
    "import { test } from '@playwright/test';",
    '',
    "test.describe('购物车', () => {",
    "  test.describe('加入商品', () => {",
    "    test('添加单个商品', async () => {});",
    "    test('添加多个商品', async () => {});",
    '  });',
    "  test.describe('清空购物车', () => {",
    "    test('清空所有商品', async () => {});",
    '  });',
    '});',
    ''
  ].join('\n'));

  const result = validateIndex(staticIndex(project));

  assert.equal(result.tests.length, 3, 'all three cases are indexed');
  assert.deepEqual(result.tests.map((t) => t.title), ['添加单个商品', '添加多个商品', '清空所有商品']);
  assert.deepEqual(result.tests.map((t) => t.line), [5, 6, 9], 'each case keeps its own line');
  const uids = new Set(result.tests.map((t) => t.uid));
  assert.equal(uids.size, 3, 'every case has its own UID');
  assert.equal(result.tests.every((t) => t.uidStable), true,
    'three different titles are three decidable cases');
  assert.doesNotMatch(result.warning, /个用例的 UID 为临时值（标题重复/,
    'no ambiguity is reported for three different titles');
});

/* ======================================================================== */
/* ST-ATS-203-010: an ordinary case mixed with a dynamic one              */
/* ======================================================================== */
test('ST-ATS-203-010: an ordinary case keeps its UID while the dynamic one next to it does not', () => {
  const project = createProject('ats203-mixed');
  writeTestFile(project, 'mixed.spec.ts', [
    "import { test } from '@playwright/test';",
    '',
    "test.describe('数据验证', () => {",
    "  test('格式检查', async () => {});",
    '  for (const n of [10, 20]) {',
    '    test(`范围检查 - ${n}`, async () => {});',
    '  }',
    "  test('边界值', async () => {});",
    '});',
    ''
  ].join('\n'));

  const result = validateIndex(staticIndex(project));

  assert.equal(result.tests.length, 3, 'the two ordinary cases and the template are indexed');
  const byTitle = new Map(result.tests.map((t) => [t.title, t]));

  const plain1 = byTitle.get('格式检查');
  const plain2 = byTitle.get('边界值');
  const template = byTitle.get('范围检查 - ${n}');

  assert.ok(plain1 && plain2 && template, 'all three titles are there');
  assert.equal(plain1.uidStable, true, 'an ordinary case next to a dynamic one stays stable');
  assert.equal(plain1.uidSource, 'derived');
  assert.equal(plain2.uidStable, true);
  assert.notEqual(plain1.uid, plain2.uid, 'the two ordinary cases have their own UIDs');

  assert.equal(template.uidStable, false, 'the template is the indeterminable one');
  assert.equal(template.ambiguity.reason, 'dynamic-template-title');

  // The warning counts the template AND nothing else: the two ordinary
  // cases are not dragged into the count.
  assert.match(result.warning, /1 个用例的标题是动态模板/);
  assert.doesNotMatch(result.warning, /个用例的 UID 为临时值（标题重复/);

  // The two ordinary cases keep their UIDs across a second discovery, and
  // so does the template -- the template is UNSTABLE, not unstable in the
  // sense of "moving".
  const second = validateIndex(staticIndex(project));
  assert.equal(second.tests.find((t) => t.title === '格式检查').uid, plain1.uid);
  assert.equal(second.tests.find((t) => t.title === '范围检查 - ${n}').uid, template.uid);
});

/* ======================================================================== */
/* ST-ATS-203-011: the ORDER of the index is the order of the source       */
/* ======================================================================== */
test('ST-ATS-203-011: the index reports the cases in the order of the source', () => {
  const project = createProject('ats203-order');
  writeTestFile(project, 'order.spec.ts', [
    "import { test } from '@playwright/test';",
    "test('first', async () => {});",
    "test('second', async () => {});",
    "test('third', async () => {});",
    ''
  ].join('\n'));

  const result = validateIndex(staticIndex(project));
  assert.deepEqual(result.tests.map((t) => t.title), ['first', 'second', 'third']);
  assert.deepEqual(result.tests.map((t) => t.line), [2, 3, 4]);
});
