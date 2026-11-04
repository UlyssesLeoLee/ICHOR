import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  projectUidFor, projectUidOf, extractExplicitUid, normalizeTitleKey, bodyKeyOf,
  deriveTestUid, resolveIdentities, compareIdentities, extractCallbackBody,
  runUidFor, attemptUidFor, findTestUid, isProjectUid, isRunUid, isTestUid, isAttemptUid,
  isLegacyProjectUid, UID_SCHEME_VERSION, emptyRegistry
} from '../server/uid.mjs';
import { discoverStatic, attemptsForRun, parseReport } from '../server/core.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-uid-'));
const projectDir = path.join(dir, 'app');
fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');
fs.writeFileSync(path.join(projectDir, 'playwright.config.ts'), 'export default {}');

const project = { id: 'proj_demo', root: projectDir };
const projectUid = projectUidFor(projectDir);

/* ---------------------------------------------------------------- */
/* Project UID                                                       */
/* ---------------------------------------------------------------- */

test('UT-UID-001: project UID is deterministic and format-checked', () => {
  const a = projectUidFor(projectDir);
  assert.equal(a, projectUidFor(projectDir));
  assert.match(a, /^proj_1_[0-9a-f]{24}$/);
  assert.ok(isProjectUid(a));
  assert.ok(!isLegacyProjectUid(a));
});

test('UT-UID-002: project UID ignores path separator and trailing slash', () => {
  const withSlash = projectDir + path.sep;
  assert.equal(projectUidFor(withSlash), projectUidFor(projectDir));
});

test('UT-UID-003: legacy project id is mapped to the recomputed UID', () => {
  assert.equal(projectUidOf({ id: 'proj_11111111-1111-1111-1111-111111111111', root: projectDir }), projectUid);
  assert.equal(projectUidOf({ id: projectUid, root: projectDir }), projectUid);
});

/* ---------------------------------------------------------------- */
/* Explicit annotation                                               */
/* ---------------------------------------------------------------- */

test('UT-UID-004: explicit @TC annotation is extracted and normalised', () => {
  assert.equal(extractExplicitUid('login works @TC-001'), 'tc-001');
  assert.equal(extractExplicitUid('login works @TC-A1_b'), 'tc-a1_b');
  assert.equal(extractExplicitUid('login works'), null);
});

test('UT-UID-005: title key drops the annotation and the case', () => {
  assert.equal(normalizeTitleKey('Login Works @TC-001'), 'login works');
  assert.equal(normalizeTitleKey('  Login   Works  '), 'login works');
});

/* ---------------------------------------------------------------- */
/* Callback body extraction                                           */
/* ---------------------------------------------------------------- */

test('UT-UID-006: callback body is extracted after the title literal', () => {
  const src = "test('a', async ({page}) => { await page.goto('/'); });\ntest('b', ()=>{});\n";
  const m = /(?:^|\n)\s*(?:test|it)\s*\(\s*(')([^']*)\1/.exec(src);
  const body = extractCallbackBody(src, m.index + m[0].length);
  assert.match(body.text, /page\.goto/);
});

test('UT-UID-007: a string containing a comma does not truncate the body', () => {
  const src = "test('t', async () => { await expect(x).toHaveText('a,b,c'); });";
  const m = /(?:^|\n)\s*(?:test|it)\s*\(\s*(')([^']*)\1/.exec(src);
  const body = extractCallbackBody(src, m.index + m[0].length);
  assert.match(body.text, /a,b,c/);
});

test('UT-UID-008: a call without a callback has no body', () => {
  const src = "test('t');";
  const m = /(?:^|\n)\s*(?:test|it)\s*\(\s*(')([^']*)\1/.exec(src);
  const body = extractCallbackBody(src, m.index + m[0].length);
  assert.equal(body.text, null);
});

/* ---------------------------------------------------------------- */
/* TestDefinition identity                                           */
/* ---------------------------------------------------------------- */

test('UT-UID-009: explicit UID wins over every derived key', () => {
  const { items } = resolveIdentities({
    projectUid,
    discovered: [{ file: 'tests/a.spec.ts', title: 'case one @TC-009', line: 1, bodyText: 'body' }],
    registry: emptyRegistry()
  });
  assert.equal(items[0].uid, 'tc-009');
  assert.equal(items[0].uidSource, 'explicit');
  assert.equal(items[0].uidStable, true);
});

test('UT-UID-010: the UID survives a file rename', () => {
  const first = resolveIdentities({
    projectUid,
    discovered: [{ file: 'tests/login.spec.ts', title: 'login works', line: 3, bodyText: 'await page.goto("/")' }],
    registry: emptyRegistry()
  });
  const uid = first.items[0].uid;
  const second = resolveIdentities({
    projectUid,
    discovered: [{ file: 'tests/auth/login.spec.ts', title: 'login works', line: 3, bodyText: 'await page.goto("/")' }],
    registry: first.registry
  });
  assert.equal(second.items[0].uid, uid);
  assert.equal(second.items[0].uidStable, true);
});

test('UT-UID-011: the UID survives a retitle when the body is unchanged', () => {
  const first = resolveIdentities({
    projectUid,
    discovered: [{ file: 'tests/a.spec.ts', title: 'old title', line: 1, bodyText: 'await page.click("#a")' }],
    registry: emptyRegistry()
  });
  const second = resolveIdentities({
    projectUid,
    discovered: [{ file: 'tests/a.spec.ts', title: 'new title', line: 1, bodyText: 'await page.click("#a")' }],
    registry: first.registry
  });
  assert.equal(second.items[0].uid, first.items[0].uid);
  assert.equal(second.items[0].uidSource, 'registry');
});

test('UT-UID-012: two cases with the same title but different bodies get different UIDs', () => {
  const { items } = resolveIdentities({
    projectUid,
    discovered: [
      { file: 'tests/a.spec.ts', title: 'duplicate', line: 1, bodyText: 'body one' },
      { file: 'tests/a.spec.ts', title: 'duplicate', line: 5, bodyText: 'body two' }
    ],
    registry: emptyRegistry()
  });
  assert.notEqual(items[0].uid, items[1].uid);
  assert.ok(items.every((i) => i.uidStable));
  assert.equal(items[0].uidSource, 'derived-body');
});

test('UT-UID-013: identical title and identical body is reported as ambiguous', () => {
  const { items } = resolveIdentities({
    projectUid,
    discovered: [
      { file: 'tests/a.spec.ts', title: 'duplicate', line: 1, bodyText: 'same body' },
      { file: 'tests/b.spec.ts', title: 'duplicate', line: 2, bodyText: 'same body' }
    ],
    registry: emptyRegistry()
  });
  assert.ok(items.every((i) => i.uidStable === false));
  assert.ok(items.every((i) => i.ambiguity));
  assert.match(items[0].uid, /^tcp_1_[0-9a-f]{16}_\d+$/);
});

test('UT-UID-014: compareIdentities separates same title from same case', () => {
  assert.deepEqual(
    compareIdentities({ title: 'x', bodyText: 'b1' }, { title: 'x', bodyText: 'b1' }),
    { same: true, basis: 'body-key' }
  );
  assert.deepEqual(
    compareIdentities({ title: 'x', bodyText: 'b1' }, { title: 'x', bodyText: 'b2' }),
    { same: false, basis: 'same-title-different-body' }
  );
  assert.deepEqual(
    compareIdentities({ title: 'a @TC-1', bodyText: 'b1' }, { title: 'b @TC-1', bodyText: 'b2' }),
    { same: true, basis: 'explicit-uid' }
  );
});

test('UT-UID-015: derived UID is reproducible from the basis key', () => {
  const key = normalizeTitleKey('Some Title');
  assert.equal(deriveTestUid(projectUid, key), deriveTestUid(projectUid, key));
  assert.match(deriveTestUid(projectUid, key), /^tc_1_d_[0-9a-f]{16}$/);
});

/* ---------------------------------------------------------------- */
/* Run and Attempt                                                   */
/* ---------------------------------------------------------------- */

test('UT-UID-016: run UID is deterministic and format-checked', () => {
  const args = { projectUid, gitCommit: 'abc123', file: 'tests/a.spec.ts', seq: 1 };
  const uid = runUidFor(args);
  assert.equal(uid, runUidFor(args));
  assert.match(uid, /^run_1_[0-9a-f]{24}$/);
  assert.ok(isRunUid(uid));
  assert.notEqual(uid, runUidFor({ ...args, seq: 2 }));
});

test('UT-UID-017: attempt UID is derived from run, test and retry', () => {
  const base = { runUid: 'run_1_aaaaaaaaaaaaaaaaaaaaaaaa', testUid: 'tc-001' };
  assert.equal(attemptUidFor({ ...base, retry: 0 }), attemptUidFor({ ...base, retry: 0 }));
  assert.notEqual(attemptUidFor({ ...base, retry: 0 }), attemptUidFor({ ...base, retry: 1 }));
  assert.ok(isAttemptUid(attemptUidFor({ ...base, retry: 0 })));
});

/* ---------------------------------------------------------------- */
/* Discovery integration                                             */
/* ---------------------------------------------------------------- */

test('UT-UID-018: discoverStatic assigns a stable UID and keeps the legacy id field', () => {
  fs.writeFileSync(path.join(projectDir, 'tests', 'login.spec.ts'), "test('login works', async ({page}) => { await page.goto('/'); });\n");
  const catalog = discoverStatic(project, emptyRegistry());
  assert.equal(catalog.tests.length, 1);
  assert.equal(catalog.uidVersion, UID_SCHEME_VERSION);
  assert.equal(catalog.tests[0].id, catalog.tests[0].uid);
  assert.ok(isTestUid(catalog.tests[0].uid));
  assert.equal(catalog.tests[0].uidSource, 'derived');
  fs.rmSync(path.join(projectDir, 'tests', 'login.spec.ts'));
});

test('UT-UID-019: attempts are bound to the TestDefinition UID', () => {
  fs.writeFileSync(path.join(projectDir, 'tests', 'login.spec.ts'), "test('login works', async ({page}) => { await page.goto('/'); });\n");
  const catalog = discoverStatic(project, emptyRegistry());
  const summary = parseReport({
    suites: [{ file: 'tests/login.spec.ts', specs: [{ title: 'login works', line: 1, tests: [{ status: 'expected', results: [{ duration: 3 }] }] }] }]
  });
  const attempts = attemptsForRun(
    { uid: 'run_1_bbbbbbbbbbbbbbbbbbbbbbbb', projectUid: catalog.projectUid },
    summary,
    catalog.registry
  );
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].testUid, catalog.tests[0].uid);
  assert.equal(attempts[0].runUid, 'run_1_bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.ok(isAttemptUid(attempts[0].uid));
  fs.rmSync(path.join(projectDir, 'tests', 'login.spec.ts'));
});

test('UT-UID-022: two cases with the same file and title get distinct attempt UIDs', () => {
  // A report may list the same file and the same title twice (two cases
  // with the same title). Their attempts must not share an identifier.
  fs.writeFileSync(path.join(projectDir, 'tests', 'dup.spec.ts'),
    "test('same title', async () => { await a(); });\ntest('same title', async () => { await b(); });\n");
  const catalog = discoverStatic(project, emptyRegistry());
  const summary = parseReport({
    suites: [{ file: 'tests/dup.spec.ts', specs: [
      { title: 'same title', line: 1, tests: [{ status: 'expected', results: [{ duration: 3 }] }] },
      { title: 'same title', line: 2, tests: [{ status: 'unexpected', results: [{ duration: 4 }] }] }
    ] }]
  });
  const attempts = attemptsForRun(
    { uid: 'run_1_cccccccccccccccccccccccc', projectUid: catalog.projectUid },
    summary,
    catalog.registry
  );
  assert.equal(attempts.length, 2);
  assert.equal(new Set(attempts.map((a) => a.uid)).size, 2);
  assert.ok(attempts.every((a) => isAttemptUid(a.uid)));
  fs.rmSync(path.join(projectDir, 'tests', 'dup.spec.ts'));
});

test('UT-UID-023: the attempt lookup prefers the file and the line', () => {
  const registry = {
    version: 1,
    projects: {
      [projectUid]: {
        version: 1,
        entries: [
          { uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: 'k1', file: 'tests/a.spec.ts', title: 'case', line: 10 },
          { uid: 'tc_1_d_bbbbbbbbbbbbbbbb', bodyKey: 'k2', file: 'tests/a.spec.ts', title: 'case', line: 20 }
        ]
      }
    }
  };
  assert.equal(findTestUid(registry, projectUid, { file: 'tests/a.spec.ts', title: 'case', line: 20 }).uid, 'tc_1_d_bbbbbbbbbbbbbbbb');
  // An ambiguous title alone is not bound to an arbitrary entry.
  const byTitle = findTestUid(registry, projectUid, { file: 'tests/other.spec.ts', title: 'case' });
  assert.equal(byTitle.uid, null);
  assert.equal(byTitle.basis, 'title-ambiguous');
});

test('UT-UID-024: an attempt without a registry match keeps a null testUid', () => {
  const attempts = attemptsForRun(
    { uid: 'run_1_dddddddddddddddddddddddd', projectUid: projectUid },
    { cases: [{ title: 'unknown case', file: 'tests/x.spec.ts', status: 'expected', duration: 1 }] },
    emptyRegistry()
  );
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].testUid, null);
  assert.equal(attempts[0].uidBasis, 'unbound');
  assert.ok(isAttemptUid(attempts[0].uid));
});

test('UT-UID-020: the UID registry survives a restart of the discovery', () => {
  fs.writeFileSync(path.join(projectDir, 'tests', 'login.spec.ts'), "test('login works', async ({page}) => { await page.goto('/'); });\n");
  const first = discoverStatic(project, emptyRegistry());
  fs.renameSync(path.join(projectDir, 'tests', 'login.spec.ts'), path.join(projectDir, 'tests', 'renamed.spec.ts'));
  const second = discoverStatic(project, first.registry);
  assert.equal(second.tests[0].uid, first.tests[0].uid);
  assert.equal(second.tests[0].file, 'tests/renamed.spec.ts');
  fs.rmSync(path.join(projectDir, 'tests', 'renamed.spec.ts'));
});

/* ---------------------------------------------------------------- */
/* Binding against a real Playwright report                         */
/* ---------------------------------------------------------------- */

/**
 * A Playwright report names the test file relative to its own `rootDir`,
 * which is derived from `testDir`. The registry stores the file relative to
 * the project root. Both spellings have to reach the same key, otherwise a
 * reported case never matches its registry entry and the attempt stays
 * unbound.
 */
test('UT-UID-025: a report path relative to the Playwright rootDir is bound to the registry', () => {
  const registry = {
    version: 1,
    projects: {
      [projectUid]: {
        version: 1,
        entries: [
          { uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: 'k1', file: 'tests/a.spec.ts', title: 'case', line: 7 }
        ]
      }
    }
  };
  const summary = {
    rootDir: path.join(projectDir, 'tests').replace(/\\/g, '/'),
    cases: [{ title: 'case', file: 'a.spec.ts', line: 7, status: 'expected', duration: 1, retry: 0 }]
  };
  const attempts = attemptsForRun(
    { uid: 'run_1_eeeeeeeeeeeeeeeeeeeeeeee', projectUid, projectRoot: projectDir },
    summary,
    registry
  );
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].file, 'tests/a.spec.ts');
  assert.equal(attempts[0].testUid, 'tc_1_d_aaaaaaaaaaaaaaaa');
  assert.equal(attempts[0].uidBasis, 'file-line');
});

test('UT-UID-026: the static scanner numbers the line of the test call', () => {
  // The line a Playwright report gives is the line of the `test(` call.
  fs.writeFileSync(
    path.join(projectDir, 'tests', 'lines.spec.ts'),
    "import { test } from '@playwright/test';\n\ntest('first', async () => {});\n"
  );
  const catalog = discoverStatic(project, emptyRegistry());
  assert.equal(catalog.tests[0].line, 3);
  fs.rmSync(path.join(projectDir, 'tests', 'lines.spec.ts'));
});

test('UT-UID-027: a retried case produces one attempt per retry', () => {
  // A retried test case is ONE entry in `spec.tests[]` whose `results[]`
  // holds one element per retry. Each retry is a separate execution.
  const report = {
    config: { rootDir: path.join(projectDir, 'tests').replace(/\\/g, '/') },
    suites: [{
      file: 'flaky.spec.ts',
      specs: [{
        title: 'flaky case',
        line: 3,
        file: 'flaky.spec.ts',
        tests: [{
          status: 'flaky',
          results: [{ duration: 10, retry: 0 }, { duration: 12, retry: 1, error: { message: 'transient' } }]
        }]
      }]
    }]
  };
  const summary = parseReport(report);
  assert.equal(summary.cases.length, 2);
  assert.equal(summary.cases[0].retry, 0);
  assert.equal(summary.cases[1].retry, 1);
  assert.equal(summary.cases[1].error, 'transient');
  assert.equal(summary.rootDir, report.config.rootDir);
  // `total` counts the cases of the run, not the executions: a retried case is
  // still one case, so the counters stay on the same unit.
  assert.equal(summary.total, 1);
  assert.equal(summary.executions, 2);
  const attempts = attemptsForRun(
    { uid: 'run_1_ffffffffffffffffffffffff', projectUid, projectRoot: projectDir },
    summary,
    emptyRegistry()
  );
  assert.equal(attempts.length, 2);
  assert.equal(new Set(attempts.map((a) => a.uid)).size, 2);
  assert.deepEqual(attempts.map((a) => a.retry), [0, 1]);
});

test('UT-UID-021: cleanup removes the temporary fixture', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});
