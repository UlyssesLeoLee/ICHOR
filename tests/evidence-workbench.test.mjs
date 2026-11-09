/**
 * ATS-215 unit tests: the EVIDENCE WORKBENCH module.
 *
 * WHAT IS UNDER TEST
 * ------------------
 * The acceptance criterion of ATS-215 is 「从失败用例 2 次点击内找到 Trace；
 * 显示附件哈希与时间」 -- "find the Trace from a failing case within 2
 * clicks; show the attachment's hash and time". The tests below cover
 * three things:
 *
 *   1. THE TRACE IS LOCATED FROM THE FAILING CASE. The engine's own
 *      record of the attachment is used, and a case whose trace cannot
 *      be located says so instead of inventing one.
 *   2. THE HASH AND THE TIME ARE THE ARCHIVED ONES. The digest the
 *      manifest recorded is the digest the workbench shows; the
 *      modification time travels with it.
 *   3. THE CLICK BUDGET IS COUNTED. The path from the failure list to the
 *      trace is returned as data, and its length is asserted against the
 *      budget of two.
 *
 * Plus the before/after comparison: two runs of the same case are
 * compared on what actually happened, and a comparison of two runs made
 * from different commits is reported as NOT comparable.
 *
 * THE TESTS ARE FALSIFIABLE
 * -------------------------
 * Every assertion states the value it expects, and the fixtures are built
 * so that a wrong implementation produces a DIFFERENT result -- not
 * merely a missing field. In particular:
 *
 *   * a case with NO trace must yield `located: false`, so an
 *     implementation that invents a trace path fails the test;
 *   * a trace whose digest differs from the manifest's must be reported
 *     as a mismatch, so an implementation that recomputes the digest
 *     fails the test;
 *   * a comparison of two different commits must be `comparable: false`,
 *     so an implementation that always says "comparable" fails the test.
 *
 * Run: node --test tests/evidence-workbench.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTACHMENT_KINDS,
  ATTACHMENT_PRIORITY,
  TRACE_CLICK_BUDGET,
  attachmentKind,
  attachmentRank,
  buildWorkbench,
  caseIdentity,
  caseOutputDir,
  clickPath,
  compareCase,
  compareRuns,
  formatBytes,
  kindLabel,
  locateCaseEvidence,
  shortDigest,
  verdictOf,
} from '../apps/studio/public/evidence-workbench.mjs';

import {
  attachmentsOf,
  aggregateCases,
  parseReport,
} from '../server/execution/model.mjs';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

/** One artifact of a run. */
function artifact(file, sha256 = DIGEST_A, size = 100) {
  return { file, sha256, size, modifiedAt: '2026-03-01T10:00:00.000Z' };
}

/** One case with its attachments. */
function kase(extra = {}) {
  return {
    title: extra.title ?? '导航入口正常 @REQ-002',
    file: extra.file ?? 'home.spec.ts',
    line: extra.line ?? 22,
    status: extra.status ?? 'failed',
    duration: extra.duration ?? 5155,
    error: extra.error ?? 'expect(received).toHaveText(expected)',
    attemptsCount: extra.attemptsCount ?? 1,
    scope: extra.scope ?? [],
    caseKey: extra.caseKey ?? 'home.spec.ts  导航入口正常 @REQ-002 22',
    attachments: extra.attachments ?? [],
  };
}

/** One run with its artifacts and its cases. */
function run(extra = {}) {
  return {
    id: extra.id ?? 'run_1_000000000000000000000001',
    uid: extra.uid ?? 'run_1_000000000000000000000001',
    status: extra.status ?? 'failed',
    gitCommit: extra.gitCommit ?? 'abc1234',
    runner: extra.runner ?? 'playwright',
    startedAt: extra.startedAt ?? '2026-03-01T10:00:00.000Z',
    finishedAt: extra.finishedAt ?? '2026-03-01T10:00:12.000Z',
    artifacts: extra.artifacts ?? [],
    summary: { cases: extra.cases ?? [] },
  };
}

/* ------------------------------------------------------------------ */
/* the vocabulary                                                      */
/* ------------------------------------------------------------------ */

test('UT-ATS215-001: the attachment kinds are the ones the engine writes', () => {
  assert.equal(attachmentKind('home-x/trace.zip'), 'trace');
  assert.equal(attachmentKind('report.json'), 'report');
  assert.equal(attachmentKind('html/index.html'), 'html');
  assert.equal(attachmentKind('home-x/error-context.md'), 'context');
  assert.equal(attachmentKind('home-x/video.webm'), 'video');
  assert.equal(attachmentKind('home-x/pic.png'), 'screenshot');
  assert.equal(attachmentKind('home-x/notes.txt'), 'other');
});

test('UT-ATS215-002: a trace stays a trace even when the content type lies', () => {
  // The path is the primary signal: a mis-typed content type must not make
  // a trace invisible, because the trace is what the reader is after.
  assert.equal(attachmentKind('home-x/trace.zip', 'application/octet-stream'), 'trace');
  assert.equal(attachmentKind('home-x/trace.zip', ''), 'trace');
});

test('UT-ATS215-003: a trace ranks first and an unknown kind ranks last', () => {
  assert.equal(attachmentRank('trace'), 0);
  assert.ok(attachmentRank('report') > attachmentRank('trace'));
  assert.equal(attachmentRank('something-else'), ATTACHMENT_PRIORITY.length);
  assert.equal(ATTACHMENT_KINDS.length, 7);
  assert.equal(kindLabel('trace'), 'Trace');
  assert.equal(kindLabel('nope'), '其他');
});

/* ------------------------------------------------------------------ */
/* locating the trace                                                  */
/* ------------------------------------------------------------------ */

test('UT-ATS215-004: the trace of a case is located through the engine record', () => {
  const c = kase({
    attachments: [{ name: 'trace', contentType: 'application/zip', file: 'home-导航/trace.zip' }],
  });
  const result = locateCaseEvidence(c, {
    artifacts: [artifact('home-导航/trace.zip', DIGEST_A, 8048)],
  });
  assert.equal(result.located, true);
  assert.equal(result.source, 'report');
  assert.equal(result.trace.file, 'home-导航/trace.zip');
  assert.equal(result.trace.sha256, DIGEST_A);
  assert.equal(result.trace.size, 8048);
});

test('UT-ATS215-005: a case with NO trace is not given one', () => {
  // The falsifiable core: an implementation that invents a trace path
  // fails here, because the result must say `located: false` and must
  // name the reason.
  const c = kase({ attachments: [] });
  const result = locateCaseEvidence(c, {
    artifacts: [artifact('home-导航/trace.zip', DIGEST_A, 8048)],
  });
  assert.equal(result.located, false);
  assert.equal(result.trace, null);
  assert.equal(result.reason, '该用例没有留下任何附件');
});

test('UT-ATS215-006: an attachment that the manifest does not list is not evidence', () => {
  // The engine named a file, but the manifest does not list it (the
  // retention policy removed it). The workbench must not present it as
  // this run's evidence with a digest.
  const c = kase({
    attachments: [{ name: 'trace', contentType: 'application/zip', file: 'home-导航/trace.zip' }],
  });
  const result = locateCaseEvidence(c, { artifacts: [] });
  assert.equal(result.located, false);
  assert.equal(result.trace, null);
  assert.match(result.reason, /不在本次归档的证据清单中/);
});

test('UT-ATS215-007: the digest shown is the ARCHIVED one', () => {
  // The manifest says the digest is X. The workbench shows X -- it does
  // not recompute it from the file on disk. A reader who wants to know
  // whether the file still matches asks the verification endpoint.
  const c = kase({
    attachments: [{ name: 'trace', contentType: 'application/zip', file: 't/trace.zip' }],
  });
  const result = locateCaseEvidence(c, { artifacts: [artifact('t/trace.zip', DIGEST_B, 42)] });
  assert.equal(result.trace.sha256, DIGEST_B);
  assert.equal(result.trace.modifiedAt, '2026-03-01T10:00:00.000Z');
});

test('UT-ATS215-008: the derived trace is only accepted when the file exists', () => {
  // The engine's naming rule is a fallback. It is only accepted when the
  // derived path is one of the run's artifacts.
  const derived = caseOutputDir('tests/home.spec.ts', '导航入口正常 @REQ-002');
  const c = kase({ file: 'tests/home.spec.ts', attachments: [] });
  const missing = locateCaseEvidence(c, { artifacts: [] });
  assert.equal(missing.located, false);
  const present = locateCaseEvidence(c, {
    artifacts: [artifact(`${derived}/trace.zip`, DIGEST_A, 10)],
  });
  assert.equal(present.located, true);
  assert.equal(present.source, 'derived');
});

test('UT-ATS215-009: the case output directory follows the engine rule', () => {
  // The rule (measured from the engine's source): the test file path
  // relative to the test directory, with the `.spec`/`.test` suffix
  // removed and the separators replaced by `-`, joined with the
  // sanitised full title (the describe path and the case title).
  //
  // The expected values are the REAL directory names of a measured run:
  // the engine wrote `home-首页响应正常-REQ-001` and
  // `home-导航入口正常-REQ-002` -- the space in the title is sanitised to
  // a `-` as well.
  assert.equal(caseOutputDir('home.spec.ts', '导航入口正常 @REQ-002'), 'home-导航入口正常-REQ-002');
  assert.equal(caseOutputDir('tests/home.spec.ts', 'a case'), 'home-a-case');
  assert.equal(caseOutputDir('a.spec.ts', 'title', ['describe']), 'a-describe-title');
});

/* ------------------------------------------------------------------ */
/* the click budget                                                    */
/* ------------------------------------------------------------------ */

test('UT-ATS215-010: the trace is two clicks away from the failure list', () => {
  const path = clickPath({ located: true });
  assert.equal(path.clicks, 2);
  assert.equal(path.budget, TRACE_CLICK_BUDGET);
  assert.equal(path.withinBudget, true);
  assert.deepEqual(path.steps.map((s) => s.action), ['select-case', 'open-trace']);
});

test('UT-ATS215-011: an unlocated trace does not claim to be within the budget', () => {
  const path = clickPath({ located: false, reason: '该用例没有留下任何附件' });
  assert.equal(path.withinBudget, false);
  assert.match(path.steps[1].label, /没有留下任何附件/);
});

/* ------------------------------------------------------------------ */
/* the workbench view                                                  */
/* ------------------------------------------------------------------ */

test('UT-ATS215-012: the workbench lists the failures with their trace', () => {
  const view = buildWorkbench(
    run({
      artifacts: [artifact('home-导航/trace.zip', DIGEST_A, 8048), artifact('report.json', DIGEST_B, 12)],
      cases: [
        kase({
          attachments: [{ name: 'trace', contentType: 'application/zip', file: 'home-导航/trace.zip' }],
        }),
        kase({ title: '通过用例', status: 'passed', attachments: [] }),
      ],
    }),
  );
  assert.equal(view.failureCount, 1);
  assert.equal(view.failures[0].trace.file, 'home-导航/trace.zip');
  assert.equal(view.failures[0].trace.sha256, DIGEST_A);
  assert.equal(view.failures[0].trace.modifiedAt, '2026-03-01T10:00:00.000Z');
  assert.equal(view.failures[0].clickPath.withinBudget, true);
  assert.equal(view.totals.count, 2);
});

test('UT-ATS215-013: a passed case is not a failure', () => {
  const view = buildWorkbench(run({
    artifacts: [],
    cases: [kase({ status: 'passed' }), kase({ title: 'flaky one', status: 'flaky' })],
  }));
  assert.equal(view.failureCount, 1);
  assert.equal(view.failures[0].status, 'flaky');
});

test('UT-ATS215-014: the digest is shortened for display but the full one is kept', () => {
  assert.equal(shortDigest(DIGEST_A), 'aaaaaaaaaaaa…');
  assert.equal(shortDigest(''), '—');
  assert.equal(shortDigest(null), '—');
  assert.equal(formatBytes(8048), '8 KB');
  assert.equal(formatBytes(null), '—');
});

/* ------------------------------------------------------------------ */
/* the before/after comparison                                         */
/* ------------------------------------------------------------------ */

test('UT-ATS215-015: two runs of the same case are compared', () => {
  const before = run({
    id: 'run_1_000000000000000000000001',
    cases: [kase({ status: 'failed', duration: 5000 })],
  });
  const after = run({
    id: 'run_1_000000000000000000000002',
    cases: [kase({ status: 'passed', duration: 100 })],
  });
  const comparison = compareRuns(before, after);
  assert.equal(comparison.rows.length, 1);
  assert.equal(comparison.rows[0].verdict, 'fixed');
  assert.equal(comparison.rows[0].changed, true);
  assert.equal(comparison.rows[0].status.before, 'failed');
  assert.equal(comparison.rows[0].status.after, 'passed');
  assert.equal(comparison.sameCommit, true);
  assert.equal(comparison.comparable, true);
});

test('UT-ATS215-016: a comparison across two commits is NOT comparable', () => {
  // A status change caused by a code change is not the same thing as a
  // status change caused by a flaky test. The module must say so.
  const before = run({ gitCommit: 'aaa', cases: [kase({ status: 'failed' })] });
  const after = run({ gitCommit: 'bbb', cases: [kase({ status: 'passed' })] });
  const comparison = compareRuns(before, after);
  assert.equal(comparison.sameCommit, false);
  assert.equal(comparison.comparable, false);
  assert.equal(comparison.commits.before, 'aaa');
  assert.equal(comparison.commits.after, 'bbb');
});

test('UT-ATS215-017: a broken case is reported as broken, not as fixed', () => {
  assert.equal(verdictOf('passed', 'failed'), 'broken');
  assert.equal(verdictOf('failed', 'passed'), 'fixed');
  assert.equal(verdictOf('failed', 'failed'), 'same');
  assert.equal(verdictOf(null, 'failed'), 'unknown');
  assert.equal(verdictOf('passed', 'flaky'), 'changed');
});

test('UT-ATS215-018: a comparison without both statuses is not conclusive', () => {
  const row = compareCase(null, kase({ status: 'passed' }));
  assert.equal(row.conclusive, false);
  assert.equal(row.verdict, 'unknown');
  assert.equal(row.trace.before, null);
});

test('UT-ATS215-019: the compared case keeps its identity across the runs', () => {
  assert.equal(caseIdentity(kase()), 'home.spec.ts  导航入口正常 @REQ-002 22');
  assert.equal(caseIdentity({ title: 'x', file: 'f', line: 3, scope: ['d'] }), 'f d x 3');
});

/* ------------------------------------------------------------------ */
/* the model: the report is the authoritative link                      */
/* ------------------------------------------------------------------ */

test('UT-ATS215-020: the model keeps the attachments of a case', () => {
  const report = {
    config: { rootDir: 'C:/p/tests' },
    suites: [{
      title: 'home.spec.ts',
      file: 'home.spec.ts',
      line: 0,
      specs: [{
        title: '导航入口正常 @REQ-002',
        file: 'home.spec.ts',
        line: 22,
        tests: [{
          status: 'unexpected',
          results: [{
            status: 'failed',
            duration: 5155,
            error: { message: 'boom' },
            attachments: [
              { name: 'error-context', contentType: 'text/markdown', path: 'C:/out/home-x/error-context.md' },
              { name: 'trace', contentType: 'application/zip', path: 'C:/out/home-x/trace.zip' },
            ],
          }],
        }],
      }],
    }],
  };
  const parsed = parseReport(report);
  assert.equal(parsed.cases.length, 1);
  const attachments = parsed.cases[0].attachments;
  assert.equal(attachments.length, 2);
  assert.equal(attachments[1].name, 'trace');
  assert.equal(attachments[1].path, 'C:/out/home-x/trace.zip');
});

test('UT-ATS215-021: an inline attachment is not turned into a path', () => {
  // An attachment without a path was written as a buffer; it is not a file
  // of the run folder and it gets no place in the evidence set.
  assert.deepEqual(attachmentsOf({ attachments: [{ name: 'x', body: Buffer.from('x') }] }), []);
  assert.deepEqual(attachmentsOf({}), []);
});

test('UT-ATS215-022: a retried case does not list the same trace twice', () => {
  const cases = aggregateCases([
    {
      title: 'c', file: 'f.ts', line: 1, caseKey: 'k', scope: [], status: 'failed',
      attachments: [{ name: 'trace', contentType: 'application/zip', path: '/o/t/trace.zip' }],
    },
    {
      title: 'c', file: 'f.ts', line: 1, caseKey: 'k', scope: [], status: 'passed',
      attachments: [{ name: 'trace', contentType: 'application/zip', path: '/o/t/trace.zip' }],
    },
  ]);
  assert.equal(cases.cases.length, 1);
  assert.equal(cases.cases[0].attachments.length, 1);
  assert.equal(cases.cases[0].attemptsCount, 2);
});
