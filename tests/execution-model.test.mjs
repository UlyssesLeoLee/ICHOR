/**
 * ATS-208 -- the unified execution model: the unit tests.
 *
 * The acceptance criteria of the task are two:
 *
 *   1. 「重试不覆盖初次尝试」 -- a retried case keeps EVERY attempt, and the
 *      first attempt survives the retry;
 *   2. 「事件可按 run+sequence 复演」 -- the events of a run can be replayed
 *      into the run's state, and the sequence is gap-free.
 *
 * These tests cover the model in isolation -- no bridge, no browser, no data
 * directory -- because the model is PURE. That is what makes it possible to
 * state the properties exactly, instead of asserting them through a
 * running system.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CASE_STATUS,
  EVENT_TYPE,
  OUTCOME,
  RESULT_STATUSES,
  RUN_STATUS,
  RUN_TRANSITIONS,
  aggregateAttempts,
  aggregateCases,
  aggregateOutcomes,
  aggregateVerdicts,
  attemptsForRun,
  isAllowedTransition,
  isTerminalRunStatus,
  mapEngineStatus,
  nextEventSeq,
  outcomeOf,
  parseEventLog,
  parseReport,
  replayEvents,
  runView,
  statusOfEvent,
} from '../server/execution/model.mjs';
import { mergeWdioReports } from '../server/adapters/wdio.mjs';
import { emptyRegistry } from '../server/uid.mjs';

/* ------------------------------------------------------------------ */
/* The vocabulary                                                     */
/* ------------------------------------------------------------------ */

test('UT-EXE-001: every engine status maps onto the common vocabulary', () => {
  // The statuses the engines really emit, measured against the installed
  // CLIs (docs/18-RUNNER-ADAPTER-CONTRACT.md).
  assert.equal(mapEngineStatus('expected'), CASE_STATUS.PASSED);
  assert.equal(mapEngineStatus('unexpected'), CASE_STATUS.FAILED);
  assert.equal(mapEngineStatus('flaky'), CASE_STATUS.FLAKY);
  assert.equal(mapEngineStatus('skipped'), CASE_STATUS.SKIPPED);
  assert.equal(mapEngineStatus('timedOut'), CASE_STATUS.FAILED);
  assert.equal(mapEngineStatus('passed'), CASE_STATUS.PASSED);
  assert.equal(mapEngineStatus('failed'), CASE_STATUS.FAILED);
  assert.equal(mapEngineStatus('pending'), CASE_STATUS.SKIPPED);
});

test('UT-EXE-002: an unknown status becomes unknown, not a guess', () => {
  // A status the product does not know is a fact the product does not have.
  // Reporting it as `failed` would invent a failure; reporting it as
  // `passed` would invent a success.
  assert.equal(mapEngineStatus('something-new'), CASE_STATUS.UNKNOWN);
  assert.equal(mapEngineStatus(null), CASE_STATUS.UNKNOWN);
  assert.equal(mapEngineStatus(undefined), CASE_STATUS.UNKNOWN);
  // The mapping is idempotent: a status that is already common maps onto
  // itself, so re-mapping the output of the model cannot destroy it.
  for (const status of RESULT_STATUSES) {
    assert.equal(mapEngineStatus(status), status, `${status} is not idempotent`);
  }
});

test('UT-EXE-003: the terminal run statuses are the ones a run never leaves', () => {
  assert.equal(isTerminalRunStatus(RUN_STATUS.PASSED), true);
  assert.equal(isTerminalRunStatus(RUN_STATUS.FAILED), true);
  assert.equal(isTerminalRunStatus(RUN_STATUS.CANCELLED), true);
  assert.equal(isTerminalRunStatus(RUN_STATUS.ERROR), true);
  assert.equal(isTerminalRunStatus(RUN_STATUS.INTERRUPTED), true);
  assert.equal(isTerminalRunStatus(RUN_STATUS.QUEUED), false);
  assert.equal(isTerminalRunStatus(RUN_STATUS.RUNNING), false);
  assert.equal(isTerminalRunStatus(RUN_STATUS.CANCELLING), false);
});

/* ------------------------------------------------------------------ */
/* 「重试不覆盖初次尝试」                                              */
/* ------------------------------------------------------------------ */

test('UT-EXE-004: a retried case is ONE case that keeps EVERY attempt', () => {
  // The acceptance criterion of ATS-208, stated as a test.
  const report = {
    suites: [{
      file: 'tests/flaky.spec.ts',
      specs: [{
        title: 'flaky case',
        line: 3,
        file: 'tests/flaky.spec.ts',
        tests: [{
          status: 'flaky',
          results: [
            { duration: 11, retry: 0, status: 'failed', error: { message: 'first attempt failed' } },
            { duration: 9, retry: 1, status: 'passed' },
          ],
        }],
      }],
    }],
  };
  const summary = parseReport(report);

  // ONE case: the retries belong to the same case.
  assert.equal(summary.cases.length, 1);
  assert.equal(summary.total, 1);
  // TWO executions: every attempt is kept.
  assert.equal(summary.executions, 2);
  assert.equal(summary.cases[0].attempts.length, 2);

  // The FIRST attempt is not overwritten: it keeps its own status, its own
  // duration and its own error.
  const [first, second] = summary.cases[0].attempts;
  assert.equal(first.status, CASE_STATUS.FAILED);
  assert.equal(first.retry, 0);
  assert.equal(first.duration, 11);
  assert.equal(first.error, 'first attempt failed');
  assert.equal(second.status, CASE_STATUS.PASSED);
  assert.equal(second.retry, 1);
  assert.equal(second.error, '');

  // The CASE status is the aggregate of the attempts: the case failed once
  // and then passed, so it is flaky -- NOT passed.
  assert.equal(summary.cases[0].status, CASE_STATUS.FLAKY);
  assert.equal(summary.flaky, 1);
  assert.equal(summary.passed, 0);
  assert.equal(summary.failed, 0);
  // The error the case reports is the error of its FIRST failing attempt.
  assert.equal(summary.cases[0].error, 'first attempt failed');
});

test('UT-EXE-005: the counters count the CASES, never the executions', () => {
  // The defect this model fixes: the old adapter flattened the retries into
  // their own "cases", so a retried case was counted twice and its first
  // attempt was lost. The measured symptom was
  // `total: 2, passed: 0, flaky: 2` for a case with one failure and one
  // success.
  const report = {
    suites: [{
      file: 'tests/a.spec.ts',
      specs: [
        {
          title: 'retried case', line: 1, file: 'tests/a.spec.ts',
          tests: [{
            status: 'flaky',
            results: [
              { duration: 5, retry: 0, status: 'failed', error: { message: 'boom' } },
              { duration: 5, retry: 1, status: 'passed' },
            ],
          }],
        },
        {
          title: 'plain case', line: 5, file: 'tests/a.spec.ts',
          tests: [{ status: 'expected', results: [{ duration: 3 }] }],
        },
      ],
    }],
  };
  const summary = parseReport(report);
  assert.equal(summary.total, 2, 'the two CASES are counted');
  assert.equal(summary.executions, 3, 'the three EXECUTIONS are counted separately');
  assert.equal(summary.flaky, 1);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
});

test('UT-EXE-006: the aggregation of the attempts follows the documented order', () => {
  const p = CASE_STATUS.PASSED, f = CASE_STATUS.FAILED, s = CASE_STATUS.SKIPPED, u = CASE_STATUS.UNKNOWN;
  // every attempt skipped -> skipped
  assert.equal(aggregateAttempts([{ status: s }, { status: s }]).status, s);
  // every attempt passed -> passed
  assert.equal(aggregateAttempts([{ status: p }, { status: p }]).status, p);
  // some passed and some failed -> flaky (the retry recovered)
  assert.equal(aggregateAttempts([{ status: f }, { status: p }]).status, CASE_STATUS.FLAKY);
  assert.equal(aggregateAttempts([{ status: p }, { status: f }]).status, CASE_STATUS.FLAKY);
  // every attempt failed -> failed
  assert.equal(aggregateAttempts([{ status: f }, { status: f }]).status, f);
  // an unknown outcome is not a failure and not a success
  assert.equal(aggregateAttempts([{ status: u }]).status, u);
  assert.equal(aggregateAttempts([]).status, u);
  // the error of the case is the error of its FIRST failing attempt
  const agg = aggregateAttempts([
    { status: f, error: 'first' },
    { status: f, error: 'second' },
    { status: p },
  ]);
  assert.equal(agg.error, 'first');
});

test('UT-EXE-007: two cases with the same title in one file stay two cases', () => {
  // The identity of a case includes its line, so two same-titled cases do
  // not merge into one.
  const report = {
    suites: [{
      file: 'tests/dup.spec.ts',
      specs: [
        { title: 'same title', line: 1, file: 'tests/dup.spec.ts', tests: [{ status: 'expected', results: [{ duration: 3 }] }] },
        { title: 'same title', line: 2, file: 'tests/dup.spec.ts', tests: [{ status: 'unexpected', results: [{ duration: 4 }] }] },
      ],
    }],
  };
  const summary = parseReport(report);
  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
});

test('UT-EXE-008: a case with no execution still exists and is counted once', () => {
  // A skipped case has an empty `results[]`. It must not disappear.
  const report = {
    suites: [{
      file: 'tests/a.spec.ts',
      specs: [{ title: 'skipped case', line: 1, file: 'tests/a.spec.ts', tests: [{ status: 'skipped', results: [] }] }],
    }],
  };
  const summary = parseReport(report);
  assert.equal(summary.total, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.cases[0].status, CASE_STATUS.SKIPPED);
  assert.equal(summary.cases[0].attemptsCount, 1);
});

test('UT-EXE-009: the attempts of one case share the TestDefinition UID', () => {
  // The attempts of one case are executions of the SAME logical case, so
  // they carry the SAME uid. Binding them one by one would let two
  // attempts of one case end up on two different uids.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-exe-'));
  try {
    const projectDir = path.join(dir, 'app');
    fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'tests', 'a.spec.ts'),
      "test('a case', async () => { await a(); });\n"
    );
    const report = {
      suites: [{
        file: 'tests/a.spec.ts',
        specs: [{
          title: 'a case', line: 1, file: 'tests/a.spec.ts',
          tests: [{
            status: 'flaky',
            results: [
              { duration: 5, retry: 0, status: 'failed', error: { message: 'boom' } },
              { duration: 5, retry: 1, status: 'passed' },
            ],
          }],
        }],
      }],
    };
    const summary = parseReport(report);
    const attempts = attemptsForRun(
      { uid: 'run_1_' + '0'.repeat(24), projectUid: 'proj_1_' + '0'.repeat(24), projectRoot: projectDir },
      summary,
      emptyRegistry()
    );
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].testUid, attempts[1].testUid);
    // The two attempts have DIFFERENT identifiers -- they are two
    // executions, not one record written twice.
    assert.notEqual(attempts[0].uid, attempts[1].uid);
    // And the first attempt still carries its own failure.
    assert.equal(attempts[0].status, CASE_STATUS.FAILED);
    assert.equal(attempts[0].error, 'boom');
    assert.equal(attempts[1].status, CASE_STATUS.PASSED);
    // Both carry the case level status next to the result level one.
    assert.equal(attempts[0].caseStatus, CASE_STATUS.FLAKY);
    assert.equal(attempts[1].caseStatus, CASE_STATUS.FLAKY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 「事件可按 run+sequence 复演」                                      */
/* ------------------------------------------------------------------ */

test('UT-EXE-010: the events of a run replay into its terminal status', () => {
  const events = [
    { seq: 1, type: EVENT_TYPE.QUEUED, data: {} },
    { seq: 2, type: EVENT_TYPE.STARTED, data: {} },
    { seq: 3, type: EVENT_TYPE.FINISHED, data: { status: RUN_STATUS.PASSED } },
  ];
  const replay = replayEvents(events);
  assert.equal(replay.status, RUN_STATUS.PASSED);
  assert.equal(replay.terminal, true);
  assert.deepEqual(replay.sequence, [1, 2, 3]);
  assert.deepEqual(replay.gaps, []);
});

test('UT-EXE-011: an interrupted run replays into `interrupted`', () => {
  // The case the model did not cover before ATS-208: the bridge died while
  // the run was in flight. Without the `run.interrupted` event the events
  // of such a run determined NO status, so they could not be replayed.
  const events = [
    { seq: 1, type: EVENT_TYPE.QUEUED, data: {} },
    { seq: 2, type: EVENT_TYPE.STARTED, data: {} },
    { seq: 3, type: EVENT_TYPE.INTERRUPTED, data: { reason: 'the bridge died' } },
  ];
  const replay = replayEvents(events);
  assert.equal(replay.status, RUN_STATUS.INTERRUPTED);
  assert.equal(replay.terminal, true);
});

test('UT-EXE-012: the replay follows the SEQUENCE, not the order of the array', () => {
  // The sequence number is the order the model defines, so a stream that is
  // read out of order still replays correctly.
  const events = [
    { seq: 3, type: EVENT_TYPE.FINISHED, data: { status: RUN_STATUS.PASSED } },
    { seq: 1, type: EVENT_TYPE.QUEUED, data: {} },
    { seq: 2, type: EVENT_TYPE.STARTED, data: {} },
  ];
  const replay = replayEvents(events);
  assert.equal(replay.status, RUN_STATUS.PASSED);
  assert.deepEqual(replay.sequence, [1, 2, 3]);
});

test('UT-EXE-013: a hole in the sequence is reported, not hidden', () => {
  // A gap means an event was lost. The replay says so, instead of quietly
  // reading a stream that is missing something.
  const events = [
    { seq: 1, type: EVENT_TYPE.QUEUED, data: {} },
    { seq: 4, type: EVENT_TYPE.FINISHED, data: { status: RUN_STATUS.PASSED } },
  ];
  const replay = replayEvents(events);
  assert.deepEqual(replay.gaps, [2, 3]);
  assert.equal(replay.status, RUN_STATUS.PASSED);
});

test('UT-EXE-014: an empty stream determines no status', () => {
  const replay = replayEvents([]);
  assert.equal(replay.status, null);
  assert.equal(replay.terminal, false);
  assert.deepEqual(replay.gaps, []);
});

test('UT-EXE-015: the sequence of a run is gap-free and starts at 1', () => {
  assert.equal(nextEventSeq({ eventSeq: 0 }), 1);
  assert.equal(nextEventSeq({ eventSeq: 1 }), 2);
  assert.equal(nextEventSeq({ eventSeq: 7 }), 8);
  assert.equal(nextEventSeq({}), 1);
  assert.equal(nextEventSeq({ eventSeq: undefined }), 1);
});

test('UT-EXE-016: the state machine refuses the transitions it can disprove', () => {
  // A finished run never emits another event.
  assert.equal(isAllowedTransition(RUN_STATUS.PASSED, EVENT_TYPE.FINISHED), false);
  assert.equal(isAllowedTransition(RUN_STATUS.FAILED, EVENT_TYPE.STARTED), false);
  assert.equal(isAllowedTransition(RUN_STATUS.INTERRUPTED, EVENT_TYPE.FINISHED), false);
  // A running run may finish, be cancelled, fail or be interrupted.
  assert.equal(isAllowedTransition(RUN_STATUS.RUNNING, EVENT_TYPE.FINISHED), true);
  assert.equal(isAllowedTransition(RUN_STATUS.RUNNING, EVENT_TYPE.CANCELLING), true);
  assert.equal(isAllowedTransition(RUN_STATUS.RUNNING, EVENT_TYPE.INTERRUPTED), true);
  // A run that is still queued may start.
  assert.equal(isAllowedTransition(RUN_STATUS.QUEUED, EVENT_TYPE.STARTED), true);
  // An UNKNOWN status is not blocked: the model refuses what it can prove
  // and stays out of the way of what it cannot judge.
  assert.equal(isAllowedTransition('something-new', EVENT_TYPE.FINISHED), true);
});

test('UT-EXE-017: the event that names the status is the last one of the stream', () => {
  // Every event that implies a status, and the status it implies.
  assert.equal(statusOfEvent({ type: EVENT_TYPE.QUEUED }), RUN_STATUS.QUEUED);
  assert.equal(statusOfEvent({ type: EVENT_TYPE.STARTED }), RUN_STATUS.RUNNING);
  assert.equal(statusOfEvent({ type: EVENT_TYPE.CANCELLING }), RUN_STATUS.CANCELLING);
  assert.equal(statusOfEvent({ type: EVENT_TYPE.INTERRUPTED }), RUN_STATUS.INTERRUPTED);
  assert.equal(statusOfEvent({ type: EVENT_TYPE.ERROR }), RUN_STATUS.ERROR);
  assert.equal(statusOfEvent({ type: EVENT_TYPE.FINISHED, data: { status: 'cancelled' } }), RUN_STATUS.CANCELLED);
  // An event the model does not know implies nothing.
  assert.equal(statusOfEvent({ type: 'run.something-new' }), null);
  assert.equal(statusOfEvent({}), null);
});

/* ------------------------------------------------------------------ */
/* The unified view                                                   */
/* ------------------------------------------------------------------ */

test('UT-EXE-018: the unified view carries the run, the cases and the attempts', () => {
  const report = {
    suites: [{
      file: 'tests/a.spec.ts',
      specs: [{
        title: 'a case', line: 1, file: 'tests/a.spec.ts',
        tests: [{
          status: 'flaky',
          results: [
            { duration: 5, retry: 0, status: 'failed', error: { message: 'boom' } },
            { duration: 6, retry: 1, status: 'passed' },
          ],
        }],
      }],
    }],
  };
  const summary = parseReport(report);
  const view = runView({ uid: 'run_1_' + '0'.repeat(24), seq: 3, status: RUN_STATUS.PASSED }, summary.cases.flatMap((c) => c.attempts.map((a) => ({
    ...a, title: c.title, file: c.file, line: c.line, caseKey: `${c.file} ${c.title} ${c.line}`,
  }))));
  assert.equal(view.uid, 'run_1_' + '0'.repeat(24));
  assert.equal(view.seq, 3);
  assert.equal(view.summary.total, 1);
  assert.equal(view.summary.executions, 2);
  assert.equal(view.attempts.length, 2);
  // The view carries the same shape the bridge hands to a reader.
  assert.equal(view.summary.cases[0].status, CASE_STATUS.FLAKY);
  assert.equal(view.summary.cases[0].attempts.length, 2);
});

test('UT-EXE-019: an empty report does not crash and reports zero', () => {
  const summary = parseReport({});
  assert.equal(summary.total, 0);
  assert.equal(summary.executions, 0);
  assert.equal(summary.passed, 0);
  assert.deepEqual(summary.cases, []);
  // A report with no `suites` at all behaves the same way.
  const broken = parseReport({ suites: null });
  assert.equal(broken.total, 0);
});

/* ------------------------------------------------------------------ */
/* The declared expectation (B1)                                       */
/* ------------------------------------------------------------------ */

/**
 * The defect B1 is about.
 *
 * A case that declares `test.fail()` and then fails is what the engine
 * calls an `expected` outcome. The old model only looked at the RAW
 * result status, so it called that failure a `failed` case -- while
 * Playwright's own `stats` counted it as `expected`, and the engine exited
 * with code 0. The summary therefore contradicted the exit code.
 *
 * The measured symptom: a run that Playwright judged `passed` reported
 * `summary.failed = 1`.
 */
test('UT-EXE-020: an expected failure is a PASSED case, not a failed one', () => {
  const report = {
    suites: [{
      file: 'tests/xfail.spec.ts',
      specs: [{
        title: 'expected failure via test.fail',
        line: 3,
        file: 'tests/xfail.spec.ts',
        tests: [{
          // The engine's verdict: the case behaved as it declared.
          status: 'expected',
          // What the case declared it wanted: a failure.
          expectedStatus: 'failed',
          results: [{ status: 'failed', duration: 5, retry: 0, error: { message: 'boom' } }],
        }],
      }],
    }],
  };
  const summary = parseReport(report);
  assert.equal(summary.total, 1);
  // The case is PASSED: the failure was the declared outcome.
  assert.equal(summary.cases[0].status, CASE_STATUS.PASSED, JSON.stringify(summary.cases[0]));
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
  // The OUTCOME says why: the execution behaved as declared.
  assert.equal(summary.cases[0].outcome, OUTCOME.EXPECTED);
  assert.equal(summary.cases[0].attempts[0].outcome, OUTCOME.EXPECTED);
  // The RAW status of the attempt is still there: the attempt really did
  // fail, and that fact must not be lost.
  assert.equal(summary.cases[0].attempts[0].status, CASE_STATUS.FAILED);
  assert.equal(summary.cases[0].attempts[0].expectedStatus, 'failed');
});

test('UT-EXE-021: an UNEXPECTED pass is a FAILED case, not a passed one', () => {
  // The mirror image of UT-EXE-020: a case that declared `test.fail()` but
  // PASSED is a defect, and the run must say so. Reporting it as `passed`
  // would hide a broken test.
  const report = {
    suites: [{
      file: 'tests/xfail.spec.ts',
      specs: [{
        title: 'unexpected pass of a test.fail case',
        line: 8,
        file: 'tests/xfail.spec.ts',
        tests: [{
          status: 'unexpected',
          expectedStatus: 'failed',
          results: [{ status: 'passed', duration: 3, retry: 0 }],
        }],
      }],
    }],
  };
  const summary = parseReport(report);
  assert.equal(summary.cases[0].status, CASE_STATUS.FAILED, JSON.stringify(summary.cases[0]));
  assert.equal(summary.failed, 1);
  assert.equal(summary.passed, 0);
  assert.equal(summary.cases[0].outcome, OUTCOME.UNEXPECTED);
  // The raw status of the attempt is still `passed`: the execution itself
  // passed -- it just was not supposed to.
  assert.equal(summary.cases[0].attempts[0].status, CASE_STATUS.PASSED);
});

test('UT-EXE-022: the counters of a run agree with the engine\'s own stats', () => {
  // The property that matters: the model's summary and Playwright's `stats`
  // count the same cases the same way. This is the shape of the measured
  // report (2 projects x 5 cases).
  const report = {
    suites: [{
      file: 'tests/semantics.spec.ts',
      specs: [
        {
          title: 'expected failure via test.fail', line: 3, file: 'tests/semantics.spec.ts',
          tests: [{ status: 'expected', expectedStatus: 'failed', results: [{ status: 'failed', duration: 5, retry: 0 }] }],
        },
        {
          title: 'unexpected pass of a test.fail case', line: 8, file: 'tests/semantics.spec.ts',
          tests: [{ status: 'unexpected', expectedStatus: 'failed', results: [{ status: 'passed', duration: 0, retry: 0 }, { status: 'passed', duration: 4, retry: 1 }] }],
        },
        {
          title: 'flaky: fails first try then passes', line: 21, file: 'tests/semantics.spec.ts',
          tests: [{ status: 'flaky', expectedStatus: 'passed', results: [{ status: 'failed', duration: 1, retry: 0 }, { status: 'passed', duration: 3, retry: 1 }] }],
        },
        {
          title: 'skipped case', line: 30, file: 'tests/semantics.spec.ts',
          tests: [{ status: 'skipped', expectedStatus: 'skipped', results: [{ status: 'skipped', duration: 1, retry: 0 }] }],
        },
      ],
    }],
  };
  const summary = parseReport(report);
  assert.equal(summary.total, 4);
  assert.equal(summary.passed, 1, JSON.stringify(summary.cases.map((c) => c.status)));
  assert.equal(summary.failed, 1, JSON.stringify(summary.cases.map((c) => c.status)));
  assert.equal(summary.flaky, 1, JSON.stringify(summary.cases.map((c) => c.status)));
  assert.equal(summary.skipped, 1, JSON.stringify(summary.cases.map((c) => c.status)));
  // SIX EXECUTIONS: 1 + 2 (the unexpected pass was retried) + 2 (the flaky
  // case) + 1.
  assert.equal(summary.executions, 6);
  // The OUTCOME of every case says why it got that status.
  assert.deepEqual(
    summary.cases.map((c) => c.outcome),
    [OUTCOME.EXPECTED, OUTCOME.UNEXPECTED, OUTCOME.FLAKY, OUTCOME.SKIPPED]
  );
});

test('UT-EXE-023: an execution without a declared expectation is not a guess', () => {
  // The outcome of an execution whose engine declares no expectation is
  // `unknown`: it cannot be called expected or unexpected. The status
  // aggregation still decides the case, so an engine that says nothing
  // about expectations keeps working.
  assert.equal(outcomeOf('passed', null), OUTCOME.UNKNOWN);
  assert.equal(outcomeOf('failed', undefined), OUTCOME.UNKNOWN);
  assert.equal(outcomeOf('passed', 'passed'), OUTCOME.EXPECTED);
  assert.equal(outcomeOf('failed', 'failed'), OUTCOME.EXPECTED);
  assert.equal(outcomeOf('passed', 'failed'), OUTCOME.UNEXPECTED);
  assert.equal(outcomeOf('failed', 'passed'), OUTCOME.UNEXPECTED);
  assert.equal(outcomeOf('skipped', 'passed'), OUTCOME.SKIPPED);
  assert.equal(outcomeOf('', 'passed'), OUTCOME.UNKNOWN);

  // A case whose attempts declare no expectation keeps the raw status
  // aggregation: the outcome never decides a case it knows nothing about.
  const agg = aggregateAttempts([{ status: CASE_STATUS.FAILED }, { status: CASE_STATUS.FAILED }]);
  assert.equal(agg.status, CASE_STATUS.FAILED);
  assert.equal(agg.outcome, OUTCOME.UNKNOWN);
});

/**
 * A case that ran in SEVERAL projects.
 *
 * The two situations look the same to the attempt statuses -- "some attempt
 * failed, some attempt passed" -- but they are different verdicts:
 *
 *   * the case failed in project b only -> it FAILED;
 *   * the case failed once and passed on the retry -> it is FLAKY.
 *
 * Only the engine's per-project verdicts tell them apart, so the model
 * uses them. This is the case the review flagged as unverified, and it is
 * now covered.
 */
test('UT-EXE-023B: the per-project verdicts decide the case, not the attempt mix', () => {
  // The case failed in project b only.
  const failedInB = {
    suites: [{
      file: 'tests/multi.spec.ts',
      specs: [{
        title: 'fails in project b only', line: 1, file: 'tests/multi.spec.ts',
        tests: [
          { projectName: 'a', status: 'expected', expectedStatus: 'passed', results: [{ status: 'passed', duration: 4, retry: 0 }] },
          { projectName: 'b', status: 'unexpected', expectedStatus: 'passed', results: [{ status: 'failed', duration: 5, retry: 0 }, { status: 'failed', duration: 7, retry: 1 }] },
        ],
      }],
    }],
  };
  const summary = parseReport(failedInB);
  assert.equal(summary.total, 1);
  // FAILED, not flaky: the retry did not recover it, and the engine says
  // the case was unexpected in project b.
  assert.equal(summary.cases[0].status, CASE_STATUS.FAILED, JSON.stringify(summary.cases[0]));
  assert.equal(summary.failed, 1);
  assert.equal(summary.flaky, 0);

  // The same attempt mix, but the case recovered on the retry: FLAKY.
  const recovered = {
    suites: [{
      file: 'tests/multi.spec.ts',
      specs: [{
        title: 'flaky: fails first try then passes', line: 2, file: 'tests/multi.spec.ts',
        tests: [
          { projectName: 'a', status: 'flaky', expectedStatus: 'passed', results: [{ status: 'failed', duration: 1, retry: 0 }, { status: 'passed', duration: 3, retry: 1 }] },
        ],
      }],
    }],
  };
  const flakySummary = parseReport(recovered);
  assert.equal(flakySummary.cases[0].status, CASE_STATUS.FLAKY, JSON.stringify(flakySummary.cases[0]));
  assert.equal(flakySummary.flaky, 1);
  assert.equal(flakySummary.failed, 0);
});

/* ------------------------------------------------------------------ */
/* The state machine check of the replay (B3)                          */
/* ------------------------------------------------------------------ */

/**
 * The defect B3 is about.
 *
 * The old `/replay` endpoint folded the events and took the status of the
 * LAST event that implies one. It never checked the state machine, so a
 * stream that violates `RUN_TRANSITIONS` -- for example
 * `[queued, started, finished(passed), interrupted]` -- was reported as
 * `agrees: true`. That stream describes a run that never existed: a
 * finished run does not get interrupted afterwards.
 */
test('UT-EXE-024: a stream that violates the state machine is NOT valid', () => {
  const events = [
    { seq: 1, type: EVENT_TYPE.QUEUED, data: {} },
    { seq: 2, type: EVENT_TYPE.STARTED, data: {} },
    { seq: 3, type: EVENT_TYPE.FINISHED, data: { status: RUN_STATUS.PASSED } },
    { seq: 4, type: EVENT_TYPE.INTERRUPTED, data: { reason: 'too late' } },
  ];
  const replay = replayEvents(events);
  assert.equal(replay.valid, false, JSON.stringify(replay.violations));
  assert.equal(replay.violations.length, 1, JSON.stringify(replay.violations));
  // The violation names the event and the status it was not allowed from.
  assert.equal(replay.violations[0].seq, 4);
  assert.equal(replay.violations[0].type, EVENT_TYPE.INTERRUPTED);
  assert.equal(replay.violations[0].from, RUN_STATUS.PASSED);
  // The status is still folded -- the reader gets the facts -- but the
  // stream is marked invalid.
  assert.equal(replay.status, RUN_STATUS.INTERRUPTED);
});

test('UT-EXE-025: a stream that obeys the state machine is valid', () => {
  const events = [
    { seq: 1, type: EVENT_TYPE.QUEUED, data: {} },
    { seq: 2, type: EVENT_TYPE.STARTED, data: {} },
    { seq: 3, type: EVENT_TYPE.INTERRUPTED, data: { reason: 'the bridge died' } },
  ];
  const replay = replayEvents(events);
  assert.equal(replay.valid, true, JSON.stringify(replay.violations));
  assert.deepEqual(replay.violations, []);
  assert.equal(replay.status, RUN_STATUS.INTERRUPTED);

  // A cancelled run is a valid stream too.
  const cancelled = replayEvents([
    { seq: 1, type: EVENT_TYPE.QUEUED, data: {} },
    { seq: 2, type: EVENT_TYPE.STARTED, data: {} },
    { seq: 3, type: EVENT_TYPE.CANCELLING, data: {} },
    { seq: 4, type: EVENT_TYPE.FINISHED, data: { status: RUN_STATUS.CANCELLED } },
  ]);
  assert.equal(cancelled.valid, true, JSON.stringify(cancelled.violations));
  assert.equal(cancelled.status, RUN_STATUS.CANCELLED);
});

/* ------------------------------------------------------------------ */
/* The durable event log (B5)                                          */
/* ------------------------------------------------------------------ */

/**
 * The defect B5 is about.
 *
 * A crash in the middle of an append leaves the last line of
 * `events.jsonl` torn: a fragment of JSON that does not parse. The old
 * reader parsed the WHOLE file with `JSON.parse` per line and let the
 * exception escape, so `/events` and `/replay` answered 500 for the rest of
 * the run's life -- and the writer then appended the next event onto the
 * fragment, making the file unreadable for good.
 */
test('UT-EXE-026: a torn line is skipped and REPORTED, not fatal', () => {
  const good = JSON.stringify({ seq: 1, type: EVENT_TYPE.QUEUED, data: {} });
  const good2 = JSON.stringify({ seq: 2, type: EVENT_TYPE.STARTED, data: {} });
  const text = `${good}\n${good2}\n{"seq":3,"at":"2026-11-06T00:00:00.000Z","ty`;
  const parsed = parseEventLog(text);
  // The two readable events survive.
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0].seq, 1);
  assert.equal(parsed.events[1].seq, 2);
  // The torn line is REPORTED: a reader has to know that something was
  // skipped, otherwise it cannot tell "the run did that" from "the log
  // lost that".
  assert.deepEqual(parsed.unreadable, [3]);
  // The file does not end with a newline: the tail may be torn.
  assert.equal(parsed.truncated, true);
});

test('UT-EXE-027: an intact log reports no damage', () => {
  const good = JSON.stringify({ seq: 1, type: EVENT_TYPE.QUEUED, data: {} });
  const parsed = parseEventLog(`${good}\n`);
  assert.equal(parsed.events.length, 1);
  assert.deepEqual(parsed.unreadable, []);
  assert.equal(parsed.truncated, false);
  // An empty log is not an error.
  const empty = parseEventLog('');
  assert.deepEqual(empty.events, []);
  assert.deepEqual(empty.unreadable, []);
  assert.equal(empty.truncated, false);
  // A line that is valid JSON but not an object is unreadable too.
  const notAnObject = parseEventLog('42\n');
  assert.deepEqual(notAnObject.events, []);
  assert.deepEqual(notAnObject.unreadable, [1]);
});

/* ------------------------------------------------------------------ */
/* The state diagram of the design document (B7)                       */
/* ------------------------------------------------------------------ */

/**
 * The state diagram of `docs/04-DETAILED-DESIGN.md` §3 must agree with
 * `RUN_TRANSITIONS`.
 *
 * The review found the two out of sync: the diagram carried an edge the
 * code never takes (`running → error`) and lacked four edges the code
 * allows. A diagram that drifts from the code is worse than no diagram,
 * because a reader takes it for the contract.
 *
 * The rule this test enforces:
 *
 *   1. EVERY edge the diagram draws is allowed by `RUN_TRANSITIONS`
 *      (the diagram may not invent a migration);
 *   2. every migration the code can ACTUALLY take is on the diagram.
 *
 * Rule 2 needs the set of migrations that have a producer in the code.
 * The state machine is deliberately permissive -- it allows
 * `running → error` -- but no code path produces it (a spawn error goes
 * through `finishRun(run, 127)`, whose terminal status is `failed`). So
 * the transitions that are allowed but unreachable are named here, and
 * they are exactly the ones the diagram leaves out.
 */
test('UT-EXE-028: the state diagram of the design document agrees with the code', () => {
  const doc = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'docs', '04-DETAILED-DESIGN.md'),
    'utf8'
  );
  const section = doc.split('## 3. 状态机')[1];
  assert.ok(section, 'the section 3 of the detailed design is missing');
  const mermaid = section.split('```mermaid')[1].split('```')[0];
  assert.ok(mermaid, 'the state diagram is missing');

  // The edges the diagram draws. The label of an edge may carry the marker
  // 「状态机允许、当前代码不产生」, which says that the edge is ALLOWED by
  // the state machine but that no code path produces it today.
  const drawn = new Set();
  const markedUnreachable = new Set();
  // The file may carry CRLF line endings, so the lines are split on any
  // carriage return or line feed and not on the line feed alone: a stray
  // carriage return would end the line before the pattern's anchor.
  for (const line of mermaid.split(/[\r\n]+/)) {
    const m = line.match(/^\s*([a-z_]+)\s*-->\s*([a-z_*]+)\s*:(.*)$/);
    if (!m || m[1] === '[*]' || m[2] === '[*]') continue;
    const edge = `${m[1]}->${m[2]}`;
    drawn.add(edge);
    if (m[3].includes('状态机允许、当前代码不产生')) markedUnreachable.add(edge);
  }
  assert.ok(drawn.size >= 8, `the state diagram has only ${drawn.size} edges`);

  // The migrations the code allows. `run.finished` carries the terminal
  // status in its payload, so it can lead to any of the three.
  const EVENT_TO_STATUS = {
    'run.queued': 'queued',
    'run.started': 'running',
    'run.cancelling': 'cancelling',
    'run.error': 'error',
    'run.interrupted': 'interrupted',
  };
  const allowed = new Set();
  for (const [status, events] of Object.entries(RUN_TRANSITIONS)) {
    for (const ev of events) {
      if (ev === 'run.finished') {
        allowed.add(`${status}->passed`);
        allowed.add(`${status}->failed`);
        allowed.add(`${status}->cancelled`);
      } else {
        allowed.add(`${status}->${EVENT_TO_STATUS[ev]}`);
      }
    }
  }

  // The allowed migrations that NO code path produces, split by what the
  // diagram does with them.
  //
  //   * NOT_ON_THE_DIAGRAM -- the diagram leaves them out entirely;
  //   * DRAWN_BUT_UNREACHABLE -- the diagram draws them AND marks them
  //     「状态机允许、当前代码不产生」, so a reader knows they are allowed
  //     but never happen.
  //
  // The state machine is permissive (it only refuses what it can disprove),
  // so it allows a few migrations the code never takes.
  const NOT_ON_THE_DIAGRAM = new Set([
    // `run.queued` is written while the run is still `queued`.
    'queued->queued',
    // A spawn error goes through `finishRun(run, 127)` -> `failed`.
    'running->error',
    'running->cancelled',
    'cancelling->passed',
  ]);
  const DRAWN_BUT_UNREACHABLE = new Set([
    // `cancelRun()` writes `run.interrupted`, not `run.cancelling`, when
    // there is no live job -- so the engine was never stopped.
    'queued->cancelling',
    // `finishRun()` gives a `cancelling` run `cancelled`, never `failed`.
    'cancelling->failed',
    // `run.error` is only written while the run is still `queued`.
    'cancelling->error',
  ]);

  // Rule 1: the diagram may not invent a migration.
  const invented = [...drawn].filter((e) => !allowed.has(e));
  assert.deepEqual(invented, [], `the diagram invents a migration: ${invented.join(', ')}`);

  // Rule 2: every migration the code can take is on the diagram.
  const missing = [...allowed].filter((e) => !drawn.has(e) && !NOT_ON_THE_DIAGRAM.has(e));
  assert.deepEqual(missing, [], `the diagram lacks a migration: ${missing.join(', ')}`);

  // Rule 3: an edge the diagram marks as 「状态机允许、当前代码不产生」 is
  // one no code path produces, and EVERY edge no code path produces is
  // marked. An unmarked unreachable edge reads as a regular path, and a
  // marked reachable edge is a wrong claim.
  assert.deepEqual(
    [...markedUnreachable].sort(),
    [...DRAWN_BUT_UNREACHABLE].sort(),
    `the marking of the unreachable edges does not match: the diagram marks ${[...markedUnreachable].sort().join(', ')} but the edges no code path produces are ${[...DRAWN_BUT_UNREACHABLE].sort().join(', ')}`
  );
  // Every marked edge must be ALLOWED by the state machine: the marker
  // says "the state machine allows it", so it has to be allowed.
  for (const edge of markedUnreachable) {
    assert.ok(allowed.has(edge), `the diagram marks ${edge} as allowed, but the state machine does not allow it`);
  }
});

/* ------------------------------------------------------------------ */
/* The three defects the second review round found                     */
/* ------------------------------------------------------------------ */

/**
 * The defect N1 is about: the WDIO merge HID a real failure.
 *
 * The adapter merged the CONSECUTIVE entries of a suite that share their
 * name into one case with several attempts. A retried WDIO test stops at
 * its FIRST PASS, so an entry that FOLLOWS a passed entry of the same name
 * cannot be its retry -- it is a DIFFERENT test that happens to share the
 * title.
 *
 * Merging them hid the failure: a suite with two same-titled tests, the
 * second one failing, became ONE flaky case with `failed: 0`, and the
 * failing test disappeared from the summary.
 */
test('UT-EXE-029: the WDIO merge does NOT hide a failure behind a passed entry', () => {
  const wdio = (states) => mergeWdioReports([{
    report: {
      specs: ['file:///p/test/specs/a.e2e.js'],
      suites: [{
        name: 's',
        tests: states.map((s) => ({
          name: 'renders',
          state: s,
          duration: 1,
          error: s === 'failed' ? { message: 'boom' } : undefined,
        })),
      }],
    },
  }]);

  // A retried test: it failed and the retry passed. ONE case, flaky.
  const retried = wdio(['failed', 'passed']);
  assert.equal(retried.total, 1, JSON.stringify(retried.cases));
  assert.equal(retried.failed, 0);
  assert.equal(retried.flaky, 1);
  assert.equal(retried.executions, 2);

  // TWO DISTINCT tests that share the title and both pass. A pass is
  // never retried, so the second entry is a different test: TWO cases.
  const bothPassed = wdio(['passed', 'passed']);
  assert.equal(bothPassed.total, 2, JSON.stringify(bothPassed.cases));
  assert.equal(bothPassed.failed, 0);
  assert.equal(bothPassed.passed, 2);

  // TWO DISTINCT tests that share the title, the SECOND one failing. This
  // is the case that used to be hidden: it must be a failure.
  const passThenFail = wdio(['passed', 'failed']);
  assert.equal(passThenFail.total, 2, JSON.stringify(passThenFail.cases));
  assert.equal(passThenFail.failed, 1, JSON.stringify(passThenFail.cases));
  assert.equal(passThenFail.flaky, 0, JSON.stringify(passThenFail.cases));
  // The failing case keeps its own error.
  assert.equal(passThenFail.cases[1].status, CASE_STATUS.FAILED);
  assert.match(passThenFail.cases[1].error, /boom/);

  // A data-driven loop with the same title: passed, failed, passed. The
  // first entry ends its group, so the second and third are one group.
  const dataDriven = wdio(['passed', 'failed', 'passed']);
  assert.equal(dataDriven.total, 2, JSON.stringify(dataDriven.cases));
  assert.equal(dataDriven.failed, 0, JSON.stringify(dataDriven.cases));
  assert.equal(dataDriven.flaky, 1, JSON.stringify(dataDriven.cases));
});

/**
 * The defect N2 is about: an UNKNOWN verdict became `passed`.
 *
 * The aggregation of the per-project verdicts fell through to `passed` for
 * a list it did not fully understand, so a Playwright entry whose case
 * level status is missing (or is a value the model does not know) turned a
 * FAILED execution into a PASSED case -- the summary then contradicted the
 * exit code of the engine.
 */
test('UT-EXE-030: an unknown verdict never becomes `passed`', () => {
  // The aggregation itself decides nothing when every verdict is unknown.
  assert.equal(aggregateVerdicts(['unknown']), null);
  assert.equal(aggregateVerdicts([CASE_STATUS.UNKNOWN, CASE_STATUS.UNKNOWN]), null);
  // A KNOWN verdict still decides the case.
  assert.equal(aggregateVerdicts([CASE_STATUS.PASSED]), CASE_STATUS.PASSED);
  assert.equal(aggregateVerdicts([CASE_STATUS.FAILED]), CASE_STATUS.FAILED);
  assert.equal(aggregateVerdicts([CASE_STATUS.FLAKY]), CASE_STATUS.FLAKY);
  assert.equal(aggregateVerdicts([CASE_STATUS.SKIPPED]), CASE_STATUS.SKIPPED);
  // A failure beats an unknown.
  assert.equal(aggregateVerdicts([CASE_STATUS.UNKNOWN, CASE_STATUS.FAILED]), CASE_STATUS.FAILED);

  // The whole model: a Playwright entry whose case level status is
  // missing, and one whose case level status is a value the model does not
  // know. BOTH hold a FAILED result.
  const report = {
    suites: [{
      file: 'a.spec.ts',
      specs: [
        { title: 'failed, no case status', line: 1, tests: [{ projectName: 'a', results: [{ status: 'failed', retry: 0, error: { message: 'boom' } }] }] },
        { title: 'failed, unknown case status', line: 5, tests: [{ projectName: 'a', status: 'bogus', results: [{ status: 'failed', retry: 0, error: { message: 'boom' } }] }] },
      ],
    }],
  };
  const summary = parseReport(report);
  // Neither case is a passed case: the fallback is the aggregation of the
  // attempt statuses, which says `failed`.
  for (const c of summary.cases) {
    assert.equal(c.status, CASE_STATUS.FAILED, JSON.stringify(c));
    assert.notEqual(c.status, CASE_STATUS.PASSED, JSON.stringify(c));
  }
  assert.equal(summary.failed, 2, JSON.stringify(summary));
  assert.equal(summary.passed, 0, JSON.stringify(summary));
  assert.equal(summary.total, 2, JSON.stringify(summary));

  // An outcome that is unknown does not decide a case either.
  assert.equal(aggregateOutcomes([OUTCOME.UNKNOWN]), OUTCOME.UNKNOWN);
  assert.equal(aggregateOutcomes([OUTCOME.UNKNOWN, OUTCOME.EXPECTED]), OUTCOME.EXPECTED);
});

/**
 * The defect N3 is about: the replay did not report a LOST or a REUSED
 * sequence number.
 *
 * The holes BETWEEN two events were reported, but the hole at the
 * BEGINNING of the stream was not: a log that lost its first events (the
 * recovery rebuilt the run folder, so only the last event survived) looked
 * intact. And a stream that used the same number twice was reported as
 * valid, even though the metadata layer's primary key `(run_uid, seq)`
 * refuses such a pair.
 */
test('UT-EXE-031: the replay reports the lost and the reused sequence numbers', () => {
  const ev = (seq, type, data) => ({ seq, at: 't', type, data: data ?? {} });

  // The hole at the BEGINNING: only the event 3 survived.
  const leading = replayEvents([ev(3, EVENT_TYPE.INTERRUPTED)]);
  assert.deepEqual(leading.gaps, [1, 2], JSON.stringify(leading));
  assert.deepEqual(leading.duplicates, []);
  assert.equal(leading.status, RUN_STATUS.INTERRUPTED);

  // A hole in the middle is still reported.
  const middle = replayEvents([
    ev(1, EVENT_TYPE.QUEUED),
    ev(4, EVENT_TYPE.FINISHED, { status: RUN_STATUS.PASSED }),
  ]);
  assert.deepEqual(middle.gaps, [2, 3], JSON.stringify(middle));

  // A REUSED number: two events claim the same place in the stream.
  const reused = replayEvents([
    ev(1, EVENT_TYPE.QUEUED),
    ev(2, EVENT_TYPE.STARTED),
    ev(2, EVENT_TYPE.FINISHED, { status: RUN_STATUS.PASSED }),
  ]);
  assert.deepEqual(reused.duplicates, [2], JSON.stringify(reused));
  // Such a stream does not describe a run.
  assert.equal(reused.valid, false, JSON.stringify(reused.violations));

  // An intact stream has neither holes nor reused numbers.
  const intact = replayEvents([
    ev(1, EVENT_TYPE.QUEUED),
    ev(2, EVENT_TYPE.STARTED),
    ev(3, EVENT_TYPE.INTERRUPTED),
  ]);
  assert.deepEqual(intact.gaps, []);
  assert.deepEqual(intact.duplicates, []);
  assert.equal(intact.valid, true);

  // An event without a usable sequence number is reported as such.
  const unsequenced = replayEvents([ev(0, EVENT_TYPE.QUEUED), ev(1, EVENT_TYPE.STARTED)]);
  assert.deepEqual(unsequenced.unsequenced, [0], JSON.stringify(unsequenced));
});
