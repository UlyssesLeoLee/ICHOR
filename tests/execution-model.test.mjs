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
  RESULT_STATUSES,
  RUN_STATUS,
  aggregateAttempts,
  aggregateCases,
  attemptsForRun,
  isAllowedTransition,
  isTerminalRunStatus,
  mapEngineStatus,
  nextEventSeq,
  parseReport,
  replayEvents,
  runView,
  statusOfEvent,
} from '../server/execution/model.mjs';
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
