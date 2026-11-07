/**
 * ATS-216 unit tests: the QUALITY OVERVIEW module.
 *
 * WHAT IS UNDER TEST
 * ------------------
 * The acceptance criterion of ATS-216 is 「区分失败/重试/取消，指标与原始结果可核对」
 * -- "distinguish failure / retry / cancel; the metrics must be checkable
 * against the raw results". The tests below therefore cover three things:
 *
 *   1. THE THREE ARE DISTINGUISHED. A cancelled run is not a failure, a
 *      retried case is not a plain pass, and an unknown status is neither.
 *   2. THE METRICS MATCH THE RAW RESULTS. Every counter is reconciled
 *      against the case list and against the counters the bridge itself
 *      reported; a mismatch is REPORTED rather than smoothed away.
 *   3. THE CLUSTERING IS DETERMINISTIC. The same defect clusters together
 *      and different defects do not, with no model involved.
 *
 * THE TESTS ARE FALSIFIABLE
 * -------------------------
 * Every assertion below states the value it expects, and the fixtures are
 * built so that a wrong implementation produces a DIFFERENT number -- not
 * merely a missing field. The reconciliation tests in particular feed the
 * module a run whose summary counters deliberately DISAGREE with its case
 * list and assert that the module reports the disagreement.
 *
 * Run: node --test tests/quality-overview.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTEMPT_STATUSES,
  CASE_STATUS,
  CASE_STATUSES,
  RUN_INCONCLUSIVE_STATUSES,
  RUN_IN_FLIGHT_STATUSES,
  buildQualityOverview,
  caseBucket,
  classifyFailureKind,
  normalizeErrorSignature,
  qualityMetricCards,
  runStatusGroup,
  summarizeOverview,
  testKeyOf,
} from '../apps/studio/public/quality.mjs';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** One case with the given status and attempts. */
function kase(status, attempts, extra = {}) {
  const list = attempts ?? [{ status, retry: 0, duration: 10, error: '' }];
  return {
    title: extra.title ?? 'case',
    file: extra.file ?? 'a.spec.ts',
    status,
    duration: list.reduce((n, a) => n + (a.duration || 0), 0),
    error: extra.error ?? list.map((a) => a.error).find(Boolean) ?? '',
    attemptsCount: list.length,
    attempts: list,
    ...extra,
  };
}

/** A run whose summary counters are DERIVED from its cases (so they agree). */
function run(status, cases, extra = {}) {
  const counters = { passed: 0, failed: 0, flaky: 0, skipped: 0, unknown: 0 };
  let executions = 0;
  for (const c of cases) {
    if (c.status in counters) counters[c.status] += 1;
    executions += c.attemptsCount;
  }
  return {
    id: extra.id ?? `run-${status}-${cases.length}`,
    uid: extra.uid ?? `uid-${extra.id ?? status}`,
    seq: extra.seq ?? 1,
    status,
    createdAt: extra.createdAt ?? '2026-01-01T00:00:00Z',
    gitCommit: extra.gitCommit ?? 'abc1234',
    summary: {
      ...counters,
      total: cases.length,
      executions,
      cases,
    },
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* the vocabularies                                                    */
/* ------------------------------------------------------------------ */

test('ATS-216-UT-001 a run status is grouped into verdict / inconclusive / in flight', () => {
  assert.equal(runStatusGroup('passed'), 'verdict');
  assert.equal(runStatusGroup('failed'), 'verdict');
  assert.equal(runStatusGroup('cancelled'), 'inconclusive');
  assert.equal(runStatusGroup('error'), 'inconclusive');
  assert.equal(runStatusGroup('interrupted'), 'inconclusive');
  assert.equal(runStatusGroup('running'), 'inFlight');
  assert.equal(runStatusGroup('queued'), 'inFlight');
  assert.equal(runStatusGroup('cancelling'), 'inFlight');
});

test('ATS-216-UT-002 an UNKNOWN run status claims nothing (it is not a verdict)', () => {
  // A status the module does not know is a fact the module does not have.
  // It must not be counted as a pass and must not be counted as a failure.
  assert.equal(runStatusGroup('weird-new-status'), 'inconclusive');
  assert.equal(runStatusGroup(undefined), 'inconclusive');
  assert.equal(runStatusGroup(null), 'inconclusive');
});

test('ATS-216-UT-003 an UNKNOWN case status becomes unknown, never passed or failed', () => {
  assert.equal(caseBucket('passed'), CASE_STATUS.PASSED);
  assert.equal(caseBucket('failed'), CASE_STATUS.FAILED);
  assert.equal(caseBucket('flaky'), CASE_STATUS.FLAKY);
  assert.equal(caseBucket('skipped'), CASE_STATUS.SKIPPED);
  assert.equal(caseBucket('totally-unknown'), CASE_STATUS.UNKNOWN);
  assert.equal(caseBucket(undefined), CASE_STATUS.UNKNOWN);
});

test('ATS-216-UT-004 the three vocabularies hold the documented members', () => {
  assert.deepEqual([...CASE_STATUSES],
    ['passed', 'failed', 'flaky', 'skipped', 'unknown']);
  assert.deepEqual([...RUN_INCONCLUSIVE_STATUSES],
    ['cancelled', 'error', 'interrupted']);
  assert.deepEqual([...RUN_IN_FLIGHT_STATUSES],
    ['queued', 'running', 'cancelling']);
  assert.deepEqual([...ATTEMPT_STATUSES],
    ['passed', 'failed', 'flaky', 'skipped', 'unknown']);
});

/* ------------------------------------------------------------------ */
/* 1. 区分失败/重试/取消                                                */
/* ------------------------------------------------------------------ */

test('ATS-216-UT-010 a cancelled run is NOT counted as a failure and NOT as a pass', () => {
  const runs = [
    run('cancelled', [kase('unknown')]),
    run('failed', [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'boom' }])]),
  ];
  const o = buildQualityOverview(runs);
  assert.equal(o.runs.cancelled, 1, 'the cancelled run must be counted as cancelled');
  assert.equal(o.runs.failed, 1, 'the failed run must be counted as failed');
  assert.equal(o.runs.passed, 0);
  // The run-level pass rate counts only the runs that carry a verdict.
  assert.equal(o.runs.verdict, 1);
  assert.equal(o.runs.passRate, 0);
  // The case of the cancelled run is reported, but it is not a failure.
  assert.equal(o.cases.failed, 1);
  assert.equal(o.cases.inconclusive, 1);
  assert.equal(o.cases.counted, 1, 'only the case of the finished run is counted');
});

test('ATS-216-UT-011 an interrupted run is inconclusive, like a cancelled one', () => {
  const o = buildQualityOverview([
    run('interrupted', [kase('unknown')]),
    run('error', [kase('unknown')]),
  ]);
  assert.equal(o.runs.interrupted, 1);
  assert.equal(o.runs.error, 1);
  assert.equal(o.runs.inconclusive, 2);
  assert.equal(o.runs.verdict, 0);
  assert.equal(o.cases.failed, 0);
  assert.equal(o.cases.inconclusive, 2);
});

test('ATS-216-UT-012 a retried case is FLAKY, not a plain pass and not a failure', () => {
  const o = buildQualityOverview([
    run('passed', [kase('flaky', [
      { status: 'failed', retry: 0, duration: 9, error: 'AssertionError: boom' },
      { status: 'passed', retry: 1, duration: 11, error: '' },
    ])]),
  ]);
  assert.equal(o.cases.flaky, 1, 'the retried case must be counted as flaky');
  assert.equal(o.cases.passed, 0, 'a flaky case is not a plain pass');
  assert.equal(o.cases.failed, 0, 'a flaky case is not a failure');
  assert.equal(o.cases.retried, 1, 'exactly one case needed a retry');
  assert.equal(o.cases.attempts, 2, 'both attempts are counted');
  assert.equal(o.cases.retries, 1);
});

test('ATS-216-UT-013 the first attempt of a retried case is NOT lost', () => {
  const o = buildQualityOverview([
    run('passed', [kase('flaky', [
      { status: 'failed', retry: 0, duration: 9, error: 'AssertionError: first failure' },
      { status: 'passed', retry: 1, duration: 11, error: '' },
    ])]),
  ]);
  const ref = o.cases.buckets.flaky[0];
  assert.equal(ref.attemptsCount, 2);
  assert.deepEqual(ref.attemptStatuses, ['failed', 'passed'],
    'the failed first attempt must still be visible');
  assert.equal(o.attempts.failed, 1, 'the failed attempt is counted as a failed attempt');
  assert.equal(o.attempts.passed, 1);
});

test('ATS-216-UT-014 the attempt buckets add up to the attempts of the cases', () => {
  const o = buildQualityOverview([
    run('failed', [
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'x' }]),
      kase('flaky', [
        { status: 'failed', retry: 0, duration: 1, error: 'x' },
        { status: 'passed', retry: 1, duration: 1, error: '' },
        { status: 'passed', retry: 2, duration: 1, error: '' },
      ]),
    ]),
  ]);
  assert.equal(o.attempts.total, 4);
  assert.equal(o.attempts.failed, 2);
  assert.equal(o.attempts.passed, 2);
  assert.equal(o.attempts.retries, 2);
  assert.equal(o.cases.retried, 1);
});

test('ATS-216-UT-015 an in-flight run is counted apart from the finished ones', () => {
  const o = buildQualityOverview([
    run('running', [kase('passed')]),
    run('passed', [kase('passed')]),
  ]);
  assert.equal(o.runs.inFlight, 1);
  assert.equal(o.runs.passed, 1);
  assert.equal(o.runs.verdict, 1);
  assert.equal(o.runs.passRate, 1);
});

test('ATS-216-UT-016 the cases of a run WITHOUT a verdict do not enter the metrics', () => {
  // A cancelled run really did execute its cases, but a run the operator
  // stopped says NOTHING about the quality of the code under test. Its
  // cases therefore enter neither the attempt buckets, nor the retry
  // metrics, nor the cross-run view: they are reported apart.
  const cancelled = run('cancelled', [kase('failed', [
    { status: 'failed', retry: 0, duration: 1, error: 'Error: boom' },
    { status: 'failed', retry: 1, duration: 1, error: 'Error: boom' },
  ], { title: 'T' })], { id: 'rC' });
  const passed = run('passed', [kase('passed', undefined, { title: 'T' })], { id: 'rP' });
  const o = buildQualityOverview([cancelled, passed]);

  assert.equal(o.runs.cancelled, 1);
  assert.equal(o.cases.failed, 0, 'a cancelled run\'s failure is not a failure of the code');
  assert.equal(o.cases.passed, 1);
  assert.equal(o.cases.inconclusive, 1, 'the case is reported apart');
  assert.equal(o.cases.counted, 1, 'only the case of the finished run is counted');
  // The retry metrics.
  assert.equal(o.cases.retried, 0, 'the retries of a cancelled run are not retries');
  assert.equal(o.cases.retries, 0);
  assert.equal(o.cases.attempts, 1, 'the attempts of a cancelled run are not attempts of the code');
  assert.equal(o.attempts.total, 1);
  assert.equal(o.attempts.failed, 0, 'the failed attempt of a cancelled run is not in the bucket');
  // The attempts of the cancelled run are reported apart.
  assert.equal(o.cases.inconclusiveAttempts, 2);
  assert.equal(o.cases.inconclusiveRetried, 1);
  // The cross-run view.
  assert.equal(o.tests.total, 1, 'the cancelled run does not add a second observation');
  const t = o.tests.list.find((x) => x.title === 'T');
  assert.equal(t.failedRuns, 0, 'the cancelled run contributes no failed run');
  assert.equal(t.passedRuns, 1);
  assert.equal(t.flaky, false, 'the case is not flaky: the cancelled run says nothing');
  assert.equal(o.tests.flaky, 0);
});

test('ATS-216-UT-016b an IN-FLIGHT run\'s cases do not enter the metrics either', () => {
  const o = buildQualityOverview([
    run('running', [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }])]),
  ]);
  assert.equal(o.runs.inFlight, 1);
  assert.equal(o.cases.failed, 0);
  assert.equal(o.cases.inconclusive, 1);
  assert.equal(o.cases.attempts, 0);
  assert.equal(o.attempts.total, 0);
  assert.equal(o.tests.total, 0, 'an in-flight run contributes no cross-run observation');
});

test('ATS-216-UT-016c a run whose status the module does not know is reported, not dropped', () => {
  // An unknown status is a fact the module does not have. It goes into the
  // `unknown` bucket -- the bucket that claims nothing -- and the bucket
  // sum still equals the number of runs.
  const o = buildQualityOverview([
    { id: 'rX', uid: 'uX', status: 'timedout', summary: { cases: [] } },
  ]);
  assert.equal(o.runs.total, 1);
  assert.equal(o.runs.unknown, 1, 'the unknown status has its own bucket');
  assert.equal(o.runs.inconclusive, 1, 'and it counts as inconclusive');
  assert.equal(o.runs.inFlight, 0);
  assert.equal(o.runs.verdict, 0);
  assert.equal(o.runs.refs.unknown.length, 1, 'the run is listed in the unknown bucket');
  assert.equal(o.runs.refs.unknown[0].id, 'rX');
  const sum = o.runs.passed + o.runs.failed + o.runs.cancelled + o.runs.error
    + o.runs.interrupted + o.runs.inFlight + o.runs.unknown;
  assert.equal(sum, o.runs.total, 'every run is in exactly one bucket');
  assert.ok(o.reconciliation.checks.some(
    (c) => c.ok && c.name === 'every run is in exactly one run bucket'));
});

/* ------------------------------------------------------------------ */
/* 2. 指标与原始结果可核对                                              */
/* ------------------------------------------------------------------ */

test('ATS-216-UT-020 the overview reconciles with the counters the bridge reported', () => {
  const o = buildQualityOverview([
    run('failed', [
      kase('passed'),
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'boom' }]),
      kase('flaky', [
        { status: 'failed', retry: 0, duration: 1, error: 'boom' },
        { status: 'passed', retry: 1, duration: 1, error: '' },
      ]),
    ]),
  ]);
  assert.equal(o.reconciliation.consistent, true,
    `the checks must pass: ${JSON.stringify(o.reconciliation.checks.filter((c) => !c.ok))}`);
  assert.equal(o.cases.passed, 1);
  assert.equal(o.cases.failed, 1);
  assert.equal(o.cases.flaky, 1);
  assert.equal(o.cases.total, 3);
  assert.equal(o.cases.counted, 3);
});

test('ATS-216-UT-021 a run whose summary DISAGREES with its case list is REPORTED', () => {
  // The summary claims one pass and no failure; the case list holds one
  // failed case. A module that trusts the summary would report a pass.
  const lying = {
    id: 'run-lying', uid: 'uid-lying', status: 'failed',
    summary: {
      passed: 1, failed: 0, flaky: 0, skipped: 0, unknown: 0,
      total: 1, executions: 1,
      cases: [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'boom' }])],
    },
  };
  const o = buildQualityOverview([lying]);
  assert.equal(o.reconciliation.consistent, false,
    'the disagreement must be reported, not smoothed away');
  const failed = o.reconciliation.checks.filter((c) => !c.ok);
  assert.ok(failed.length >= 2, 'both the passed and the failed counter must be reported');
  assert.ok(failed.some((c) => c.name.includes('summary.passed')));
  assert.ok(failed.some((c) => c.name.includes('summary.failed')));
  // The module still counts from the RAW case list.
  assert.equal(o.cases.failed, 1);
  assert.equal(o.cases.passed, 0);
});

test('ATS-216-UT-022 a summary whose total disagrees with the case list is reported', () => {
  const lying = {
    id: 'run-lying2', uid: 'uid-lying2', status: 'passed',
    summary: {
      passed: 1, failed: 0, flaky: 0, skipped: 0, unknown: 0,
      total: 99, executions: 1,
      cases: [kase('passed')],
    },
  };
  const o = buildQualityOverview([lying]);
  assert.equal(o.reconciliation.consistent, false);
  assert.ok(o.reconciliation.checks.some(
    (c) => !c.ok && c.name.includes('summary.total')));
});

test('ATS-216-UT-023 a summary whose executions disagree with the attempts is reported', () => {
  const lying = {
    id: 'run-lying3', uid: 'uid-lying3', status: 'passed',
    summary: {
      passed: 1, failed: 0, flaky: 0, skipped: 0, unknown: 0,
      total: 1, executions: 7,
      cases: [kase('passed', [{ status: 'passed', retry: 0, duration: 1, error: '' }])],
    },
  };
  const o = buildQualityOverview([lying]);
  assert.equal(o.reconciliation.consistent, false);
  assert.ok(o.reconciliation.checks.some(
    (c) => !c.ok && c.name.includes('summary.executions')));
});

test('ATS-216-UT-024 every bucket holds one reference per case, and the reference names its run', () => {
  const o = buildQualityOverview([
    run('failed', [kase('passed', undefined, { title: 'P' })], { id: 'r1' }),
    run('passed', [kase('flaky', [
      { status: 'failed', retry: 0, duration: 1, error: 'e' },
      { status: 'passed', retry: 1, duration: 1, error: '' },
    ], { title: 'F' })], { id: 'r2' }),
  ]);
  assert.equal(o.cases.buckets.passed.length, 1);
  assert.equal(o.cases.buckets.flaky.length, 1);
  assert.equal(o.cases.buckets.passed[0].runId, 'r1');
  assert.equal(o.cases.buckets.flaky[0].runId, 'r2');
  assert.equal(o.cases.buckets.flaky[0].title, 'F');
});

test('ATS-216-UT-025 the run buckets hold one reference per run', () => {
  const o = buildQualityOverview([
    run('passed', [kase('passed')], { id: 'rA' }),
    run('failed', [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }])], { id: 'rB' }),
    run('cancelled', [kase('unknown')], { id: 'rC' }),
  ]);
  assert.equal(o.runs.refs.passed.length, 1);
  assert.equal(o.runs.refs.failed.length, 1);
  assert.equal(o.runs.refs.cancelled.length, 1);
  assert.equal(o.runs.refs.passed[0].id, 'rA');
  assert.equal(o.runs.refs.cancelled[0].id, 'rC');
  assert.equal(o.runs.total, 3);
});

test('ATS-216-UT-026 every failed case is in exactly one cluster', () => {
  const o = buildQualityOverview([
    run('failed', [
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'Error: same' }], { title: 'A' }),
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'Error: same' }], { title: 'B' }),
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'Error: other' }], { title: 'C' }),
    ]),
  ]);
  const clustered = o.clusters.reduce((n, c) => n + c.cases.length, 0);
  assert.equal(clustered, o.cases.failed);
  assert.equal(o.reconciliation.consistent, true);
});

test('ATS-216-UT-027 an empty run list yields an empty, consistent overview', () => {
  const o = buildQualityOverview([]);
  assert.equal(o.runs.total, 0);
  assert.equal(o.cases.total, 0);
  assert.equal(o.clusters.length, 0);
  assert.equal(o.reconciliation.consistent, true);
  assert.equal(o.runs.passRate, 0);
  assert.equal(o.cases.flakyRate, 0);
});

test('ATS-216-UT-028 a run without a summary is counted, but its cases are not invented', () => {
  const o = buildQualityOverview([
    { id: 'rNoSum', uid: 'u', status: 'failed', summary: null },
  ]);
  assert.equal(o.runs.failed, 1);
  assert.equal(o.cases.total, 0);
  assert.equal(o.runs.runsWithoutSummary, 1);
  assert.equal(o.reconciliation.consistent, true);
});

test('ATS-216-UT-029 the overview can be restricted to a single run', () => {
  const runs = [
    run('passed', [kase('passed', undefined, { title: 'A' })], { id: 'r1' }),
    run('failed', [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }], { title: 'B' })], { id: 'r2' }),
  ];
  const o = buildQualityOverview(runs, { runId: 'r2' });
  assert.equal(o.runs.total, 1);
  assert.equal(o.runs.failed, 1);
  assert.equal(o.cases.failed, 1);
  assert.equal(o.cases.buckets.failed[0].runId, 'r2');
});

test('ATS-216-UT-030 the summary line reports the three distinguished buckets', () => {
  const o = buildQualityOverview([
    run('passed', [kase('passed')]),
    run('failed', [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }])]),
    run('cancelled', [kase('unknown')]),
  ]);
  const line = summarizeOverview(o);
  assert.match(line, /1 passed \/ 1 failed \/ 1 cancelled/);
  assert.match(line, /reconciliation OK/);
});

test('ATS-216-UT-032 the reconciliation checks the DISPLAYED metrics, not the buckets alone', () => {
  // The reconciliation must compare the numbers the interface SHOWS with
  // the counters the bridge reported. A module that buckets a case wrongly
  // would be confirmed by the per-run checks alone.
  const o = buildQualityOverview([
    run('failed', [
      kase('passed'),
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'boom' }]),
      kase('flaky', [
        { status: 'failed', retry: 0, duration: 1, error: 'boom' },
        { status: 'passed', retry: 1, duration: 1, error: '' },
      ]),
    ]),
  ]);
  const names = o.reconciliation.checks.map((c) => c.name);
  assert.ok(names.includes('the displayed passed count matches the counters the bridge reported'),
    'the displayed passed count must be checked against the bridge');
  assert.ok(names.includes('the displayed failed count matches the counters the bridge reported'));
  assert.ok(names.includes('the displayed flaky count matches the counters the bridge reported'));
  assert.ok(names.includes('the displayed attempt count matches the executions the bridge reported'));
  assert.equal(o.reconciliation.consistent, true,
    `the checks must pass: ${JSON.stringify(o.reconciliation.checks.filter((c) => !c.ok))}`);
});

test('ATS-216-UT-032b a DISPLAYED metric that disagrees with the bridge is REPORTED', () => {
  // The bridge says one case passed; the case list holds a FAILED case.
  // The per-run check catches it -- and so must the check on the DISPLAYED
  // number, because that is the number the reader sees.
  const lying = {
    id: 'run-lying', uid: 'uid-lying', status: 'failed',
    summary: {
      passed: 1, failed: 0, flaky: 0, skipped: 0, unknown: 0,
      total: 1, executions: 1,
      cases: [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'boom' }])],
    },
  };
  const o = buildQualityOverview([lying]);
  assert.equal(o.reconciliation.consistent, false);
  const failed = o.reconciliation.checks.filter((c) => !c.ok);
  assert.ok(failed.some((c) => c.name.includes('the displayed passed count')),
    'the displayed passed count must be reported as wrong');
  assert.ok(failed.some((c) => c.name.includes('the displayed failed count')),
    'the displayed failed count must be reported as wrong');
});

test('ATS-216-UT-032c every run is in exactly one run bucket', () => {
  const o = buildQualityOverview([
    run('passed', [kase('passed')]),
    run('failed', [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }])]),
    run('cancelled', [kase('unknown')]),
    run('error', [kase('unknown')]),
    run('interrupted', [kase('unknown')]),
    run('running', [kase('passed')]),
  ]);
  const sum = o.runs.passed + o.runs.failed + o.runs.cancelled + o.runs.error
    + o.runs.interrupted + o.runs.inFlight + o.runs.unknown;
  assert.equal(sum, o.runs.total);
  assert.equal(o.runs.verdict + o.runs.inconclusive + o.runs.inFlight, o.runs.total);
  assert.ok(o.reconciliation.checks.some(
    (c) => c.ok && c.name === 'every run is in exactly one run bucket'));
});

test('ATS-216-UT-033 the metric cards carry the raw items behind every number', () => {
  const o = buildQualityOverview([
    run('failed', [
      kase('passed', undefined, { title: 'P' }),
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'boom' }], { title: 'F' }),
      kase('flaky', [
        { status: 'failed', retry: 0, duration: 1, error: 'boom' },
        { status: 'passed', retry: 1, duration: 1, error: '' },
      ], { title: 'R' }),
    ], { id: 'r1' }),
    run('cancelled', [kase('unknown', undefined, { title: 'X' })], { id: 'r2' }),
  ]);
  const cards = qualityMetricCards(o);
  assert.equal(cards.length, 4);
  const byKey = Object.fromEntries(cards.map((c) => [c.key, c]));
  assert.equal(byKey.passed.value, o.cases.passed);
  assert.equal(byKey.failed.value, o.cases.failed);
  assert.equal(byKey.flaky.value, o.cases.flaky);
  assert.equal(byKey.inconclusive.value, 1, 'the cancelled run is the inconclusive card');
  // Every card carries the items it was counted from.
  assert.equal(byKey.passed.refs.length, byKey.passed.value);
  assert.equal(byKey.failed.refs.length, byKey.failed.value);
  assert.equal(byKey.flaky.refs.length, byKey.flaky.value);
  assert.equal(byKey.inconclusive.refs.length, byKey.inconclusive.value);
  assert.equal(byKey.failed.refs[0].title, 'F');
  assert.equal(byKey.failed.refs[0].runId, 'r1');
  assert.equal(byKey.inconclusive.refs[0].id, 'r2');
  // The flaky card counts the retries of the retried cases only.
  assert.match(byKey.flaky.subtitle, /1 次重试/);
});

/* ------------------------------------------------------------------ */
/* 3. the deterministic clustering (失败聚类)                           */
/* ------------------------------------------------------------------ */

test('ATS-216-UT-040 the same failure behind different ids clusters together', () => {
  const a = normalizeErrorSignature(
    'AssertionError: expected 5 to be 3 -- id 550e8400-e29b-41d4-a716-446655440000');
  const b = normalizeErrorSignature(
    'AssertionError: expected 9 to be 4 -- id 660e8400-e29b-41d4-a716-446655440000');
  assert.equal(a, b, 'the variable parts must be normalized away');
  assert.match(a, /<uuid>/);
  assert.match(a, /<n>/);
});

test('ATS-216-UT-041 different failures do NOT share a signature', () => {
  const a = normalizeErrorSignature('AssertionError: expected 5 to be 3');
  const b = normalizeErrorSignature('TimeoutError: page.waitForTimeout exceeded');
  assert.notEqual(a, b);
});

test('ATS-216-UT-042 the signature is deterministic and never empty', () => {
  const text = 'Error: something broke';
  assert.equal(normalizeErrorSignature(text), normalizeErrorSignature(text));
  assert.equal(normalizeErrorSignature(''), '(no error message)');
  assert.equal(normalizeErrorSignature(null), '(no error message)');
  assert.equal(normalizeErrorSignature(undefined), '(no error message)');
});

test('ATS-216-UT-042b the ANSI colour codes do not change the signature', () => {
  // The engine writes its errors with colour codes. A signature that
  // carried them would differ for the SAME failure depending on whether
  // the report was captured with or without a TTY -- two clusters for one
  // defect.
  const plain = 'Error: expect(locator).toHaveText failed';
  const coloured = 'Error: \u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m).toHaveText failed';
  assert.equal(normalizeErrorSignature(coloured), normalizeErrorSignature(plain),
    'the colour codes must not change the signature');
  assert.ok(!normalizeErrorSignature(coloured).includes('\u001b'),
    'no escape character may survive in the signature');
});

test('ATS-216-UT-043 only the first line of a multi-line error is the signature', () => {
  const withStack = 'Error: the failure\n    at Object.<anonymous> (/tmp/x.js:1:1)\n    at more';
  assert.equal(normalizeErrorSignature(withStack), normalizeErrorSignature('Error: the failure'));
});

test('ATS-216-UT-044 the failure kind is derived from the signature, without a model', () => {
  assert.equal(classifyFailureKind(normalizeErrorSignature('TimeoutError: exceeded 30000ms')), 'timeout');
  assert.equal(classifyFailureKind(normalizeErrorSignature('AssertionError: expected 1 to be 2')), 'assertion');
  assert.equal(classifyFailureKind(normalizeErrorSignature('net::ERR_CONNECTION_REFUSED')), 'network');
  // A locator that could not be RESOLVED is an element failure.
  assert.equal(classifyFailureKind(normalizeErrorSignature('Error: locator resolved to 2 elements')), 'element');
  assert.equal(classifyFailureKind(normalizeErrorSignature('Error: goto failed')), 'navigation');
  assert.equal(classifyFailureKind(normalizeErrorSignature('Error: the run was cancelled')), 'cancelled');
  assert.equal(classifyFailureKind(normalizeErrorSignature('Error: something else entirely')), 'other');
});

test('ATS-216-UT-044b a WEB-FIRST assertion is an assertion, not a missing element', () => {
  // The web-first form of Playwright names a locator, but the failure is
  // the ASSERTION about that locator -- `expect(locator).toHaveText(x)
  // failed` says the text was not what the test expected. The element
  // kind is reserved for a locator that could not be resolved at all.
  assert.equal(
    classifyFailureKind(normalizeErrorSignature('Error: expect(locator).toHaveText(expected) failed')),
    'assertion',
    'the real Playwright web-first failure must be classified as an assertion');
  assert.equal(
    classifyFailureKind(normalizeErrorSignature('Error: expect(locator).toBeVisible() failed')),
    'assertion');
  // The locator itself was not found: that IS an element failure.
  assert.equal(
    classifyFailureKind(normalizeErrorSignature('Error: locator not found: #missing')),
    'element');
});

test('ATS-216-UT-045 the clusters are ordered by how many failures they hold', () => {
  const o = buildQualityOverview([
    run('failed', [
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'Error: rare' }], { title: 'R' }),
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'Error: common' }], { title: 'C1' }),
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'Error: common' }], { title: 'C2' }),
    ]),
  ]);
  assert.equal(o.clusters[0].count, 2, 'the biggest cluster comes first');
  assert.equal(o.clusters[0].signature, normalizeErrorSignature('Error: common'));
  assert.equal(o.clusters[1].count, 1);
  assert.equal(o.clusters.length, 2);
});

test('ATS-216-UT-046 a cluster names the files the failures came from', () => {
  const o = buildQualityOverview([
    run('failed', [
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'Error: same' }], { file: 'x.spec.ts' }),
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'Error: same' }], { file: 'y.spec.ts' }),
    ]),
  ]);
  assert.equal(o.clusters.length, 1);
  assert.deepEqual(o.clusters[0].files.sort(), ['x.spec.ts', 'y.spec.ts']);
  assert.deepEqual(o.files.map((f) => f.file).sort(), ['x.spec.ts', 'y.spec.ts']);
  assert.equal(o.files.reduce((n, f) => n + f.failed, 0), 2);
});

test('ATS-216-UT-047 a non-failed case is NOT clustered', () => {
  const o = buildQualityOverview([
    run('passed', [
      kase('passed', undefined, { title: 'ok' }),
      kase('flaky', [
        { status: 'failed', retry: 0, duration: 1, error: 'Error: transient' },
        { status: 'passed', retry: 1, duration: 1, error: '' },
      ], { title: 'flaky' }),
    ]),
  ]);
  assert.equal(o.clusters.length, 0,
    'only the FAILED cases are clustered; a flaky case recovered');
});

/* ------------------------------------------------------------------ */
/* 4. the cross-run flakiness                                          */
/* ------------------------------------------------------------------ */

test('ATS-216-UT-050 a test that failed in one run and passed in another is flaky', () => {
  const o = buildQualityOverview([
    run('failed', [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }], { title: 'T' })], { id: 'r1' }),
    run('passed', [kase('passed', undefined, { title: 'T' })], { id: 'r2' }),
  ]);
  const t = o.tests.list.find((x) => x.title === 'T');
  assert.ok(t, 'the test must appear in the cross-run view');
  assert.equal(t.runs, 2);
  assert.equal(t.failedRuns, 1);
  assert.equal(t.passedRuns, 1);
  assert.equal(t.flaky, true);
  assert.equal(o.tests.flaky, 1);
  assert.equal(o.tests.flakyRate, 1);
});

test('ATS-216-UT-051 a test that needed a retry is flaky', () => {
  const o = buildQualityOverview([
    run('passed', [kase('flaky', [
      { status: 'failed', retry: 0, duration: 1, error: 'e' },
      { status: 'passed', retry: 1, duration: 1, error: '' },
    ], { title: 'T' })], { id: 'r1' }),
  ]);
  const t = o.tests.list.find((x) => x.title === 'T');
  assert.equal(t.flakyRuns, 1);
  assert.equal(t.flaky, true);
});

test('ATS-216-UT-052 a test that always passes is NOT flaky', () => {
  const o = buildQualityOverview([
    run('passed', [kase('passed', undefined, { title: 'T' })], { id: 'r1' }),
    run('passed', [kase('passed', undefined, { title: 'T' })], { id: 'r2' }),
  ]);
  const t = o.tests.list.find((x) => x.title === 'T');
  assert.equal(t.flaky, false);
  assert.equal(o.tests.flaky, 0);
  assert.equal(o.tests.flakyRate, 0);
});

test('ATS-216-UT-053 two cases with the same title in different files are DIFFERENT tests', () => {
  const o = buildQualityOverview([
    run('failed', [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }], { title: 'T', file: 'a.spec.ts' })], { id: 'r1' }),
    run('passed', [kase('passed', undefined, { title: 'T', file: 'b.spec.ts' })], { id: 'r2' }),
  ]);
  assert.equal(o.tests.total, 2, 'the file is part of the identity');
  assert.equal(o.tests.flaky, 0, 'two different tests are not one flaky test');
});

test('ATS-216-UT-054 the test key is the file plus the title, unambiguously', () => {
  assert.equal(testKeyOf('a.spec.ts', 'T'), JSON.stringify(['a.spec.ts', 'T']));
  assert.notEqual(testKeyOf('a.spec.ts', 'T'), testKeyOf('b.spec.ts', 'T'));
  assert.notEqual(testKeyOf('a.spec.ts', 'T'), testKeyOf('a.spec.ts', 'U'));
  // A separator-based key would collide here; the JSON encoding cannot.
  assert.notEqual(testKeyOf('a.spec.ts/b', ''), testKeyOf('a.spec.ts', 'b'));
});

test('ATS-216-UT-055 two same-titled cases under different describes are TWO tests', () => {
  // The common Playwright pattern: `describe('a') { test('works') }` and
  // `describe('b') { test('works') }`. The stored summary carries the
  // describe path, so the two cases are two tests -- not one test that
  // "sometimes fails".
  const o = buildQualityOverview([
    run('failed', [
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }],
        { title: 'works', file: 'a.spec.ts', scope: ['a'], line: 5 }),
    ], { id: 'r1' }),
    run('failed', [
      kase('passed', undefined, { title: 'works', file: 'a.spec.ts', scope: ['b'], line: 9 }),
    ], { id: 'r2' }),
  ]);
  assert.equal(o.tests.total, 2, 'the two describes are two tests');
  assert.equal(o.tests.flaky, 0, 'two different tests are not one flaky test');
  const first = o.tests.list.find((t) => t.scope.join(' ') === 'a');
  const second = o.tests.list.find((t) => t.scope.join(' ') === 'b');
  assert.ok(first && second, 'both tests are listed');
  assert.equal(first.failedRuns, 1);
  assert.equal(first.passedRuns, 0);
  assert.equal(second.failedRuns, 0);
  assert.equal(second.passedRuns, 1);
});

test('ATS-216-UT-055b a case declared outside any describe is keyed on the file and the title', () => {
  // A case outside a describe carries no scope, but the stored summary
  // carries a line -- so the engine-level identity is there, and the key
  // is (file, describe path, title).
  const o = buildQualityOverview([
    run('failed', [
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }],
        { title: 'works', file: 'a.spec.ts', line: 5 }),
    ], { id: 'r1' }),
    run('passed', [
      kase('passed', undefined, { title: 'works', file: 'a.spec.ts', line: 9 }),
    ], { id: 'r2' }),
  ]);
  assert.equal(o.tests.total, 1, 'the two lines are ONE test -- the line is not part of the key');
  assert.equal(o.tests.flaky, 1, 'one run passed and one failed: the test is unstable');
});

test('ATS-216-UT-055g an edit ABOVE a case does not split its cross-run history', () => {
  // The line is the position of the case in the file, and the position
  // moves whenever anything above the case changes -- a comment, an
  // import, another test. A key that carried the line would split the
  // history of one case into two, and the "unstable" case would be
  // reported as two stable ones.
  //
  // The engine itself rejects the duplicates that a line would have to
  // separate (measured: tools/ats216-probes/identity-probe.mjs), so the
  // describe path alone tells two cases of one file apart.
  const o = buildQualityOverview([
    run('passed', [
      kase('passed', undefined, { title: '提交订单', file: 'a.spec.ts', scope: ['结算'], line: 4 }),
    ], { id: 'r1' }),
    run('failed', [
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }],
        { title: '提交订单', file: 'a.spec.ts', scope: ['结算'], line: 5 }),
    ], { id: 'r2' }),
  ]);
  assert.equal(o.tests.total, 1, 'the comment above the case did not create a second test');
  const t = o.tests.list.find((x) => x.title === '提交订单');
  assert.equal(t.runs, 2, 'both runs belong to the same test');
  assert.equal(t.passedRuns, 1);
  assert.equal(t.failedRuns, 1);
  assert.equal(t.flaky, true, 'one run passed and one failed: the test IS unstable');
  assert.equal(o.tests.flaky, 1, 'the overview reports the unstable case');
});

test('ATS-216-UT-055c the CASE KEY separates two cases when the scope is absent', () => {
  const o = buildQualityOverview([
    run('failed', [
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }],
        { title: 'works', file: 'a.spec.ts', caseKey: 'a.spec.ts works #0' }),
    ], { id: 'r1' }),
    run('passed', [
      kase('passed', undefined,
        { title: 'works', file: 'a.spec.ts', caseKey: 'a.spec.ts works #1' }),
    ], { id: 'r2' }),
  ]);
  assert.equal(o.tests.total, 2, 'the two case keys are two tests');
  assert.equal(o.tests.flaky, 0);
});

test('ATS-216-UT-055d a case that ALWAYS fails is not reported as flaky', () => {
  // The same title, the same file, two runs, both failing. Nothing about
  // this test changed: it is consistently broken, not unreliable.
  const o = buildQualityOverview([
    run('failed', [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }],
      { title: 'T', file: 'a.spec.ts', scope: ['x'] })], { id: 'r1' }),
    run('failed', [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }],
      { title: 'T', file: 'a.spec.ts', scope: ['x'] })], { id: 'r2' }),
  ]);
  const t = o.tests.list.find((x) => x.title === 'T');
  assert.equal(t.failedRuns, 2);
  assert.equal(t.passedRuns, 0);
  assert.equal(t.flaky, false, 'a test that always fails is not flaky');
  assert.equal(o.tests.flaky, 0);
});

test('ATS-216-UT-055e two cases of ONE run that share an identity are REPORTED, not merged', () => {
  // The stored summary cannot tell the two cases apart. The module says so
  // instead of merging them silently -- and such a test contributes no
  // verdict, so it can never be reported as flaky.
  const o = buildQualityOverview([
    run('failed', [
      kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'e' }], { title: 'T' }),
      kase('passed', undefined, { title: 'T' }),
    ], { id: 'r1' }),
    run('passed', [kase('passed', undefined, { title: 'T' })], { id: 'r2' }),
  ]);
  const t = o.tests.list.find((x) => x.title === 'T');
  assert.ok(t, 'the test is listed');
  assert.equal(t.ambiguous, true, 'the collision is reported on the entry');
  assert.equal(t.flaky, false, 'an ambiguous test is never flaky');
  assert.equal(o.tests.flaky, 0);
  assert.equal(o.tests.ambiguous, 1, 'the overview counts the ambiguous identities');
});

test('ATS-216-UT-055f the test key of an identity that carries a scope differs', () => {
  assert.notEqual(
    testKeyOf('a.spec.ts', 'T', { scope: ['a'], line: 5 }),
    testKeyOf('a.spec.ts', 'T', { scope: ['b'], line: 5 }));
  assert.notEqual(
    testKeyOf('a.spec.ts', 'T', { caseKey: 'k0' }),
    testKeyOf('a.spec.ts', 'T', { caseKey: 'k1' }));
  // The line is NOT part of the key: it moves whenever anything above the
  // case changes, and it separates nothing the describe path does not.
  assert.equal(
    testKeyOf('a.spec.ts', 'T', { scope: ['a'], line: 5 }),
    testKeyOf('a.spec.ts', 'T', { scope: ['a'], line: 9 }));
  assert.equal(
    testKeyOf('a.spec.ts', 'T', { scope: [], line: 5 }),
    testKeyOf('a.spec.ts', 'T', { scope: [], line: 9 }));
  // Without an identity the key falls back to the file and the title.
  assert.equal(testKeyOf('a.spec.ts', 'T'), JSON.stringify(['a.spec.ts', 'T']));
  // A summary that carries a line but no describe path (a case declared
  // outside any describe) is keyed on the file and the title.
  assert.equal(
    testKeyOf('a.spec.ts', 'T', { scope: [], line: 5 }),
    JSON.stringify(['a.spec.ts', [], 'T']));
});

/* ------------------------------------------------------------------ */
/* 5. robustness                                                       */
/* ------------------------------------------------------------------ */

test('ATS-216-UT-060 a malformed run list does not throw', () => {
  const o = buildQualityOverview([null, undefined, 'nonsense', 42, { id: 'x' }]);
  assert.equal(o.runs.total, 1, 'only the object is a run');
  assert.equal(o.reconciliation.consistent, true);
});

test('ATS-216-UT-061 a case without an attempts array counts as ONE attempt, like the model does', () => {
  // The authoritative model (`server/execution/model.mjs` -> `attemptsOfCase()`)
  // treats a case without an `attempts` array as one execution of itself.
  // The module follows that rule, so its attempt count agrees with the
  // bridge's `executions` counter.
  const o = buildQualityOverview([{
    id: 'r', uid: 'u', status: 'failed',
    summary: {
      passed: 0, failed: 1, flaky: 0, skipped: 0, unknown: 0, total: 1, executions: 1,
      cases: [{ title: 'T', file: 'a.spec.ts', status: 'failed', duration: 3, error: 'e' }],
    },
  }]);
  assert.equal(o.cases.failed, 1);
  assert.equal(o.cases.buckets.failed[0].attemptsCount, 1,
    'the case is one execution of itself');
  assert.equal(o.cases.attempts, 1);
  assert.equal(o.attempts.total, 1);
  assert.equal(o.reconciliation.consistent, true,
    `the executions counter must reconcile: ${JSON.stringify(o.reconciliation.checks.filter((c) => !c.ok))}`);
});

test('ATS-216-UT-062 a case whose status is unknown is bucketed as unknown, not as a failure', () => {
  const o = buildQualityOverview([{
    id: 'r', uid: 'u', status: 'passed',
    summary: {
      passed: 0, failed: 0, flaky: 0, skipped: 0, unknown: 1, total: 1, executions: 1,
      cases: [{ title: 'T', file: 'a.spec.ts', status: 'brand-new-status', duration: 1, error: '' }],
    },
  }]);
  assert.equal(o.cases.unknown, 1);
  assert.equal(o.cases.failed, 0);
  assert.equal(o.cases.passed, 0);
});

test('ATS-216-UT-063 the module is side-effect free: the same input gives the same output', () => {
  const runs = [
    run('failed', [kase('failed', [{ status: 'failed', retry: 0, duration: 1, error: 'Error: x' }])]),
    run('passed', [kase('flaky', [
      { status: 'failed', retry: 0, duration: 1, error: 'Error: y' },
      { status: 'passed', retry: 1, duration: 1, error: '' },
    ])]),
  ];
  const a = JSON.stringify(buildQualityOverview(runs));
  const b = JSON.stringify(buildQualityOverview(runs));
  assert.equal(a, b);
});
