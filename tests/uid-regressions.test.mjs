/**
 * ATS-201: regression tests for the defects the first review found.
 *
 * Every test here corresponds to a numbered counterexample in the review
 * comment 01a1a5b8-7ffc-73f8-8509-d1a99b51927a. The tests are written so
 * that each one FAILS on the pre-fix code and PASSES on the fixed code --
 * a test that cannot fail is not evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveIdentities, findTestUid, emptyRegistry, projectUidFor } from '../server/uid.mjs';
import { discoverStatic, attemptsForRun } from '../server/core.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-uid-reg-'));
const projectDir = path.join(dir, 'app');
fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');
fs.writeFileSync(path.join(projectDir, 'playwright.config.ts'), 'export default {}');
const project = { id: 'proj_demo', root: projectDir };
const projectUid = projectUidFor(projectDir);

/** Writes one spec file and returns the discovery result. */
function discover(file, source, registry = emptyRegistry()) {
  const full = path.join(projectDir, 'tests', file);
  fs.writeFileSync(full, source);
  const catalog = discoverStatic(project, registry);
  fs.rmSync(full);
  return catalog;
}

/* ------------------------------------------------------------------ */
/* CE1 -- a file-line hit must not bind a DIFFERENT case               */
/* ------------------------------------------------------------------ */

test('UT-UID-REG-001: a reported case is never bound to the uid of another case', () => {
  // alpha is at line 2, beta at line 7. The report says "alpha" is at line 7
  // (the source was edited between the discovery and the run).
  const catalog = discover('a.spec.ts',
    "import {test} from '@playwright/test';\ntest('alpha', async () => { console.log(1); });\n\n\n\n\ntest('beta', async () => { console.log(2); });\n");
  const alpha = catalog.tests.find((t) => t.title === 'alpha');
  const beta = catalog.tests.find((t) => t.title === 'beta');
  assert.ok(alpha && beta);
  const attempts = attemptsForRun(
    { uid: 'run_1_' + '0'.repeat(24), projectUid: catalog.projectUid, projectRoot: projectDir },
    { cases: [{ file: 'tests/a.spec.ts', title: 'alpha', line: 7, status: 'expected', duration: 1, retry: 0 }] },
    catalog.registry
  );
  assert.equal(attempts.length, 1);
  // The binding must NOT be beta's uid: that is the silent mis-binding.
  assert.notEqual(attempts[0].testUid, beta.uid);
  // It is either alpha's uid or unbound -- both are honest answers.
  if (attempts[0].testUid !== null) assert.equal(attempts[0].testUid, alpha.uid);
});

test('UT-UID-REG-002: a file-line hit with a matching title still binds', () => {
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
  const hit = findTestUid(registry, projectUid, { file: 'tests/a.spec.ts', title: 'case', line: 7 });
  assert.equal(hit.uid, 'tc_1_d_aaaaaaaaaaaaaaaa');
  assert.equal(hit.basis, 'file-line');
});

test('UT-UID-REG-003: a file-line hit with a DIFFERENT title falls through to the title lookup', () => {
  const registry = {
    version: 1,
    projects: {
      [projectUid]: {
        version: 1,
        entries: [
          { uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: 'k1', file: 'tests/a.spec.ts', title: 'beta', line: 7 },
          { uid: 'tc_1_d_bbbbbbbbbbbbbbbb', bodyKey: 'k2', file: 'tests/a.spec.ts', title: 'alpha', line: 2 }
        ]
      }
    }
  };
  // "alpha" is reported at line 7 -- the line of beta. It must bind to alpha.
  const hit = findTestUid(registry, projectUid, { file: 'tests/a.spec.ts', title: 'alpha', line: 7 });
  assert.equal(hit.uid, 'tc_1_d_bbbbbbbbbbbbbbbb');
  assert.equal(hit.basis, 'file-title');
});

/* ------------------------------------------------------------------ */
/* CE2 -- the registry must not grow duplicate entries                  */
/* ------------------------------------------------------------------ */

test('UT-UID-REG-004: the registry holds one entry per uid', () => {
  const source = "import {test} from '@playwright/test';\ntest('alpha', async () => { console.log(1); });\n";
  const first = discover('a.spec.ts', source);
  const second = discover('a.spec.ts', source, first.registry);
  const entries = second.registry.projects[second.projectUid].entries;
  const uids = entries.map((e) => e.uid);
  assert.equal(new Set(uids).size, uids.length, 'the registry must not hold the same uid twice');
});

test('UT-UID-REG-005: a changed body does not make the case unbound', () => {
  const first = discover('a.spec.ts', "import {test} from '@playwright/test';\ntest('alpha', async () => { console.log(1); });\n");
  const second = discover('a.spec.ts', "import {test} from '@playwright/test';\ntest('alpha', async () => { console.log(111); });\n", first.registry);
  const alpha = second.tests.find((t) => t.title === 'alpha');
  assert.ok(alpha.uid, 'the case keeps a uid');
  const attempts = attemptsForRun(
    { uid: 'run_1_' + '0'.repeat(24), projectUid: second.projectUid, projectRoot: projectDir },
    { cases: [{ file: 'tests/a.spec.ts', title: 'alpha', line: 2, status: 'expected', duration: 1, retry: 0 }] },
    second.registry
  );
  assert.equal(attempts.length, 1);
  assert.ok(attempts[0].testUid, 'the attempt is bound');
  assert.notEqual(attempts[0].uidBasis, 'file-line-ambiguous');
});

test('UT-UID-REG-006: a stale entry does not block the rule that keeps the uid', () => {
  // A registry that remembers a case that no longer exists.
  const stale = {
    version: 1,
    projects: {
      [projectUid]: {
        version: 1,
        entries: [
          { uid: 'tc_1_d_deadbeefdeadbeef', bodyKey: 'gone', file: 'tests/gone.spec.ts', title: 'gone', line: 1 }
        ]
      }
    }
  };
  const { items } = resolveIdentities({
    projectUid,
    discovered: [{ file: 'tests/a.spec.ts', title: 'alpha', line: 2, bodyText: 'body' }],
    registry: stale
  });
  assert.equal(items[0].uidSource, 'derived');
  assert.ok(items[0].uid);
});

/* ------------------------------------------------------------------ */
/* CE4 -- a retitled case keeps its uid, and the copy does not steal it */
/* ------------------------------------------------------------------ */

test('UT-UID-REG-007: a retitled case keeps its uid when a copy is added', () => {
  const first = discover('c.spec.ts', "import {test} from '@playwright/test';\ntest('checkout works', async () => { await 3; });\n");
  const u0 = first.tests[0].uid;
  const second = discover('c.spec.ts', "import {test} from '@playwright/test';\ntest('checkout flow works', async () => { await 3; });\n", first.registry);
  const u1 = second.tests[0].uid;
  assert.equal(u1, u0, 'the retitle keeps the uid');

  // A copy with the same body is added. The original keeps its uid.
  const third = discover('c.spec.ts',
    "import {test} from '@playwright/test';\ntest('checkout flow works', async () => { await 3; });\ntest('refund flow works', async () => { await 3; });\n",
    second.registry);
  const original = third.tests.find((t) => t.title === 'checkout flow works');
  assert.equal(original.uid, u0, 'the original keeps its uid when a copy is added');
  // The copy has the same body as the original, so the registry cannot say
  // which of the two the old entry belongs to. That boundary is REPORTED.
  const copy = third.tests.find((t) => t.title === 'refund flow works');
  assert.ok(copy.ambiguity, 'the undecidable copy carries an ambiguity report');
  assert.equal(copy.ambiguity.reason, 'ambiguous-registry-match');
  assert.match(third.warning, /注册表记录与本次发现不一致/);

  // The copy's body is edited. The original must STILL be u0.
  const fourth = discover('c.spec.ts',
    "import {test} from '@playwright/test';\ntest('checkout flow works', async () => { await 3; });\ntest('refund flow works', async () => { await 4; });\n",
    third.registry);
  const stillFirst = fourth.tests.find((t) => t.title === 'checkout flow works');
  assert.equal(stillFirst.uid, u0, 'the original still has its uid after the copy changed');
  // The copy is decidable now (its body is unique), so it has its own uid --
  // and it is NOT the uid of the original.
  const copyNow = fourth.tests.find((t) => t.title === 'refund flow works');
  assert.ok(copyNow.uid);
  assert.notEqual(copyNow.uid, u0);
});

/* ------------------------------------------------------------------ */
/* CE5 / CE6 -- an explicit annotation always wins                    */
/* ------------------------------------------------------------------ */

test('UT-UID-REG-008: an explicit annotation is never taken over by the registry', () => {
  const first = discover('c.spec.ts',
    "import {test} from '@playwright/test';\ntest('A @TC-001', async () => { await 'a'; });\ntest('C', async () => { await 'c'; });\n");
  assert.equal(first.tests[0].uid, 'tc-001');

  // The annotation moves from A to C.
  const second = discover('c.spec.ts',
    "import {test} from '@playwright/test';\ntest('A', async () => { await 'a'; });\ntest('C @TC-001', async () => { await 'c'; });\n",
    first.registry);
  const a = second.tests.find((t) => t.title === 'A');
  const c = second.tests.find((t) => t.title === 'C @TC-001');
  assert.equal(c.uid, 'tc-001', 'the explicit annotation wins over the registry');
  assert.equal(c.uidSource, 'explicit');
  assert.notEqual(a.uid, 'tc-001', 'the other case does not get the claimed uid');
});

test('UT-UID-REG-009: a duplicated explicit uid is reported as an ambiguity', () => {
  const catalog = discover('c.spec.ts',
    "import {test} from '@playwright/test';\ntest('A @TC-007', async () => { await 'a'; });\ntest('B @TC-007', async () => { await 'b'; });\n");
  for (const t of catalog.tests) {
    assert.ok(t.ambiguity, `${t.title} carries an ambiguity report`);
    assert.equal(t.ambiguity.reason, 'duplicate-explicit-uid');
    assert.ok(t.ambiguity.explicitUid);
  }
  // The warning mentions it -- the ambiguity is not silent.
  assert.match(catalog.warning, /重复的显式 UID/);
});

/* ------------------------------------------------------------------ */
/* A1 -- an attempt records the RESULT level status                    */
/* ------------------------------------------------------------------ */

test('UT-UID-REG-010: an attempt records the result level status, not the case level status', async () => {
  const { parseReport } = await import('../server/core.mjs');
  const report = {
    suites: [{
      file: 'flaky.spec.ts',
      specs: [{
        title: 'flaky case',
        line: 3,
        file: 'flaky.spec.ts',
        tests: [{
          status: 'flaky',
          results: [
            { duration: 10, retry: 0, status: 'failed', error: { message: 'transient' } },
            { duration: 12, retry: 1, status: 'passed' }
          ]
        }]
      }]
    }]
  };
  const summary = parseReport(report);
  assert.equal(summary.cases.length, 2);
  assert.equal(summary.cases[0].status, 'flaky', 'the case level status stays flaky');
  assert.equal(summary.cases[0].resultStatus, 'failed', 'the result level status is failed');
  assert.equal(summary.cases[1].resultStatus, 'passed');

  const attempts = attemptsForRun(
    { uid: 'run_1_' + '0'.repeat(24), projectUid, projectRoot: projectDir },
    summary,
    emptyRegistry()
  );
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, 'failed', 'the first retry failed');
  assert.equal(attempts[1].status, 'passed', 'the second retry passed');
  assert.equal(attempts[0].caseStatus, 'flaky', 'the case level status is kept next to it');
});

/* ------------------------------------------------------------------ */
/* The registry stays bounded                                          */
/* ------------------------------------------------------------------ */

test('UT-UID-REG-011: the registry does not grow without bound', () => {
  let registry = emptyRegistry();
  for (let i = 0; i < 5; i++) {
    const catalog = discover('a.spec.ts', `import {test} from '@playwright/test';\ntest('alpha', async () => { await ${i}; });\n`, registry);
    registry = catalog.registry;
  }
  const entries = registry.projects[projectUid].entries;
  assert.equal(entries.length, 1, 'one case, one entry -- not one entry per discovery');
});

test('UT-UID-REG-012: a deleted case does not keep its registry entry alive', () => {
  const first = discover('a.spec.ts', "import {test} from '@playwright/test';\ntest('alpha', async () => { await 1; });\n");
  const second = discover('b.spec.ts', "import {test} from '@playwright/test';\ntest('beta', async () => { await 2; });\n", first.registry);
  const entries = second.registry.projects[second.projectUid].entries;
  const uids = entries.map((e) => e.uid);
  assert.equal(new Set(uids).size, uids.length);
  assert.ok(!uids.includes(first.tests[0].uid), 'the entry of the deleted case is pruned');
});

test('UT-UID-REG-013: cleanup removes the temporary fixture', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});
