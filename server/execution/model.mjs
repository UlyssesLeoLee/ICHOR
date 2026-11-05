/**
 * ATS-208 -- the unified Run / Test / Attempt / ExecutionEvent model.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * Before ATS-208 the four concepts of the execution model lived in four
 * different places, with four different vocabularies:
 *
 *   * `server/core.mjs` parsed a Playwright report into `{passed, failed,
 *     skipped, flaky, total, cases}` where a case carried BOTH a case level
 *     status (`flaky`) and a result level status (`failed`);
 *   * `server/index.mjs` wrote events as `{seq, at, type, data}` into
 *     `events.jsonl` and kept only a counter (`eventSeq`) in the state;
 *   * the adapters (`server/adapters/*.mjs`) mapped the engine statuses onto
 *     a SECOND common model (`passed|failed|skipped|flaky|unknown`);
 *   * the SQLite layer (`server/sqlite/*`) had a `test_attempts` table with
 *     its own column names and no table for the events at all.
 *
 * The consequence was measurable, and the probes under `tools/ats208-probes/`
 * measured it:
 *
 *   * a retried case was counted TWICE in the summary and its first attempt
 *     was LOST (`total: 2, passed: 0, flaky: 2` for a case that failed once
 *     and then passed);
 *   * the events of a run that was interrupted by a crash determined NO
 *     status at all, so they could not be replayed.
 *
 * This module is the ONE place that defines the model:
 *
 *   * the STATUS VOCABULARY of every level (run, case, attempt);
 *   * the CASE / ATTEMPT aggregation, so that a retried case counts ONCE and
 *     keeps EVERY attempt;
 *   * the report parsing that feeds the aggregation;
 *   * the binding of the attempts to the TestDefinitions;
 *   * the EVENT vocabulary, the state machine that decides which event may
 *     follow which, and the REPLAY that folds the events back into a state.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import {
  attemptUidFor, bodyKeyOf, findTestUid, normalizeTestPath, scanTestCases,
} from '../uid.mjs';

/* ------------------------------------------------------------------ */
/* The vocabulary                                                     */
/* ------------------------------------------------------------------ */

/**
 * The status of a RUN (the lifecycle of the execution itself).
 *
 * The names are the ones the design documents already use
 * (docs/04-DETAILED-DESIGN.md §3): the run is queued, then it runs, then it
 * reaches a terminal state.
 *
 *   queued      -- accepted, the engine has not been spawned yet
 *   running     -- the engine is in flight
 *   cancelling  -- a stop was requested, the engine is being terminated
 *   passed      -- the engine exited 0
 *   failed      -- the engine exited non-zero
 *   cancelled   -- the engine was stopped on request
 *   error       -- the run could not be started at all
 *   interrupted -- the bridge died while the run was in flight
 *
 * TERMINAL is the set of statuses a run never leaves. A run in a terminal
 * status is finished; a run in any other status is still in flight.
 */
export const RUN_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  CANCELLING: 'cancelling',
  PASSED: 'passed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  ERROR: 'error',
  INTERRUPTED: 'interrupted',
});

/** The statuses a run never leaves. */
export const TERMINAL_RUN_STATUS = Object.freeze(new Set([
  RUN_STATUS.PASSED,
  RUN_STATUS.FAILED,
  RUN_STATUS.CANCELLED,
  RUN_STATUS.ERROR,
  RUN_STATUS.INTERRUPTED,
]));

/** True when the run has reached a status it never leaves. */
export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUS.has(status);
}

/**
 * The status of a CASE (the test case as a whole) and of an ATTEMPT (one
 * execution of that case).
 *
 * The two levels are kept apart because they answer different questions:
 *
 *   * the CASE status describes the case as a whole -- a case that failed
 *     once and then passed is `flaky`;
 *   * the ATTEMPT status describes ONE execution -- the first attempt of that
 *     case really did `fail`, and that fact must not be lost.
 *
 * The `unknown` value is the honest answer for an execution whose outcome
 * the engine did not report.
 */
export const CASE_STATUS = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  FLAKY: 'flaky',
  UNKNOWN: 'unknown',
});

/** Every status of the common result model. */
export const RESULT_STATUSES = Object.freeze([
  CASE_STATUS.PASSED,
  CASE_STATUS.FAILED,
  CASE_STATUS.SKIPPED,
  CASE_STATUS.FLAKY,
  CASE_STATUS.UNKNOWN,
]);

/**
 * The engine status -> common status mapping.
 *
 * The table is the ONE place an engine vocabulary is translated. It covers
 * the values the engines actually emit, which were MEASURED against the
 * installed CLIs (docs/18-RUNNER-ADAPTER-CONTRACT.md):
 *
 *   Playwright, case level: expected | unexpected | flaky | skipped | timedOut
 *   Playwright, result level: passed | failed | timedOut | skipped | interrupted
 *   WebdriverIO: passed | failed | pending | skipped
 *
 * The mapping is IDEMPOTENT: a status that is already common maps onto
 * itself. That matters because the report parser already speaks the common
 * vocabulary, and an adapter that re-mapped its output would turn every
 * status it did not know into `unknown`.
 */
const ENGINE_STATUS_MAP = Object.freeze({
  // Playwright -- the CASE level status of a spec.
  expected: CASE_STATUS.PASSED,
  unexpected: CASE_STATUS.FAILED,
  flaky: CASE_STATUS.FLAKY,
  skipped: CASE_STATUS.SKIPPED,
  timedOut: CASE_STATUS.FAILED,
  // Playwright -- the RESULT level status of one execution.
  passed: CASE_STATUS.PASSED,
  failed: CASE_STATUS.FAILED,
  interrupted: CASE_STATUS.UNKNOWN,
  // WebdriverIO -- the state of a test.
  pending: CASE_STATUS.SKIPPED,
  // Already common.
  unknown: CASE_STATUS.UNKNOWN,
});

/**
 * Maps an engine status onto the common status model.
 *
 * An unknown status is NOT guessed: it becomes `unknown`, because a status
 * the product does not know is a fact the product does not have. Reporting
 * it as `failed` would invent a failure; reporting it as `passed` would
 * invent a success.
 */
export function mapEngineStatus(status) {
  if (status === null || status === undefined) return CASE_STATUS.UNKNOWN;
  const key = String(status);
  if (ENGINE_STATUS_MAP[key] !== undefined) return ENGINE_STATUS_MAP[key];
  // A case insensitive fallback, so `TIMEDOUT` and `TimedOut` map the same.
  const lower = key.toLowerCase();
  for (const [from, to] of Object.entries(ENGINE_STATUS_MAP)) {
    if (from.toLowerCase() === lower) return to;
  }
  return CASE_STATUS.UNKNOWN;
}

/* ------------------------------------------------------------------ */
/* The aggregation: cases and attempts                                */
/* ------------------------------------------------------------------ */

/**
 * The identity of a case: the three facts a report gives that name it.
 *
 * The identity is deliberately made of the FILE, the TITLE and the LINE --
 * the same three facts `findTestUid` uses to bind a reported case to a
 * registry entry. Two executions with the same identity are two tries of the
 * SAME case; executions with different identities are different cases.
 */
export function caseIdentity(execution) {
  const file = execution?.file ?? '';
  const title = execution?.title ?? '';
  const line = execution?.line ?? null;
  return `${file} ${title} ${line}`;
}

/**
 * Aggregates the EXECUTIONS of a run into CASES.
 *
 * An execution is one entry of the report's `results[]` array: one try of
 * one case. Several executions belong to the same case when they carry the
 * same `caseKey` -- the parser that produced them decides the key, because
 * only the parser knows the structure of its own report.
 *
 * The aggregation is the heart of 「重试不覆盖初次尝试」:
 *
 *   1. the executions of one case are collected into ONE case;
 *   2. the case's status is the AGGREGATE of its executions: a case whose
 *      executions are all `passed` is `passed`; a case that failed at least
 *      once and passed at least once is `flaky`; a case whose executions are
 *      all `failed` is `failed`; a skipped case is `skipped`;
 *   3. EVERY execution is kept, in order, with its own status -- the first
 *      attempt of a retried case is still there with its own `failed`
 *      status and its own error.
 *
 * The counters are computed from the CASES, never from the executions: a
 * retried case is ONE case, so it is counted ONCE. The number of
 * executions is reported separately, as `executions`.
 *
 * @param {object[]} executions the executions of the run, in report order
 * @returns {{cases:object[],passed:number,failed:number,skipped:number,flaky:number,total:number,executions:number}}
 */
export function aggregateCases(executions) {
  const list = Array.isArray(executions) ? executions : [];
  /** The cases, keyed by their identity, in the order they were seen. */
  const groups = new Map();

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const status = mapEngineStatus(raw.status);
    const key = raw.caseKey ?? caseIdentity(raw);
    if (!groups.has(key)) {
      groups.set(key, {
        title: raw.title ?? '',
        file: raw.file ?? '',
        line: raw.line ?? null,
        column: raw.column ?? null,
        attempts: [],
      });
    }
    const group = groups.get(key);
    group.attempts.push({
      // The result level status of THIS execution.
      status,
      // The retry index of this execution (0 = the first try).
      retry: Number.isInteger(raw.retry) ? raw.retry : group.attempts.length,
      duration: Number.isFinite(raw.duration) ? raw.duration : 0,
      error: raw.error ?? '',
      at: raw.at ?? null,
    });
  }

  const cases = [];
  for (const group of groups.values()) {
    const aggregate = aggregateAttempts(group.attempts);
    cases.push({
      title: group.title,
      file: group.file,
      line: group.line,
      column: group.column,
      // The CASE level status: the aggregate of the attempts.
      status: aggregate.status,
      // The attempts, in order. The first attempt of a retried case is
      // still here -- with its own status and its own error.
      attempts: group.attempts,
      // How many times the case was executed.
      attemptsCount: group.attempts.length,
      // The duration of the case is the sum of its attempts: the wall clock
      // the case consumed.
      duration: group.attempts.reduce((sum, a) => sum + (a.duration || 0), 0),
      // The error of the case is the error of its FIRST failing attempt --
      // the failure a reader wants to see is the one that happened first.
      error: aggregate.error,
    });
  }

  const passed = cases.filter((c) => c.status === CASE_STATUS.PASSED).length;
  const failed = cases.filter((c) => c.status === CASE_STATUS.FAILED).length;
  const skipped = cases.filter((c) => c.status === CASE_STATUS.SKIPPED).length;
  const flaky = cases.filter((c) => c.status === CASE_STATUS.FLAKY).length;
  return {
    cases,
    passed,
    failed,
    skipped,
    flaky,
    // `total` counts the CASES. A retried case is still one case.
    total: cases.length,
    // `executions` counts the attempts.
    executions: cases.reduce((n, c) => n + c.attemptsCount, 0),
  };
}

/**
 * The case level status of a list of attempts, and the error to report.
 *
 * The order of the rules matters and is stated here rather than implied:
 *
 *   1. every attempt skipped            -> `skipped`
 *   2. every attempt passed             -> `passed`
 *   3. some passed and some failed      -> `flaky`  (the retry recovered)
 *   4. every attempt failed             -> `failed`
 *   5. otherwise (unknown, or a mix of
 *      unknown with something else)     -> `unknown`
 *
 * A case that failed once and then passed is FLAKY, not passed: the case
 * needed a retry, and a reader who only sees `passed` cannot know that.
 */
export function aggregateAttempts(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (!list.length) return { status: CASE_STATUS.UNKNOWN, error: '' };

  const statuses = list.map((a) => a.status);
  const has = (s) => statuses.includes(s);

  let status;
  if (statuses.every((s) => s === CASE_STATUS.SKIPPED)) status = CASE_STATUS.SKIPPED;
  else if (statuses.every((s) => s === CASE_STATUS.PASSED)) status = CASE_STATUS.PASSED;
  else if (has(CASE_STATUS.PASSED) && has(CASE_STATUS.FAILED)) status = CASE_STATUS.FLAKY;
  else if (statuses.every((s) => s === CASE_STATUS.FAILED)) status = CASE_STATUS.FAILED;
  else if (has(CASE_STATUS.FAILED)) status = CASE_STATUS.FAILED;
  else status = CASE_STATUS.UNKNOWN;

  // The error of the case is the error of the FIRST failing attempt.
  const firstFailure = list.find((a) => a.status === CASE_STATUS.FAILED && a.error);
  const error = firstFailure ? firstFailure.error : (list.find((a) => a.error)?.error ?? '');

  return { status, error };
}

/* ------------------------------------------------------------------ */
/* The report parser                                                  */
/* ------------------------------------------------------------------ */

/**
 * Parses a Playwright JSON report into the unified model.
 *
 * THE HIERARCHY OF THE REPORT
 * ---------------------------
 * A Playwright report is nested:
 *
 *   report.suites[]        the suites
 *     suite.specs[]        the SPECS -- one per test case
 *       spec.tests[]       the TESTS -- one per PROJECT (chromium, firefox)
 *         test.results[]   the RESULTS -- one per RETRY
 *
 * The three levels answer three different questions, and the old parser
 * flattened them into one list, which is how a retried case ended up
 * counted twice and lost its first attempt. This parser keeps the levels:
 *
 *   * a SPEC is a CASE;
 *   * a RESULT is an ATTEMPT -- one execution of that case.
 *
 * The case level status the engine reports (`expected` / `unexpected` /
 * `flaky` / `skipped`) is used for a case that has no execution of its own
 * (a skipped case); otherwise the status of the case is the AGGREGATE of its
 * attempts.
 *
 * The two details that matter for the binding (see `attemptsForRun`):
 *
 *   * `spec.file` is relative to the Playwright `rootDir`, which is derived
 *     from `testDir`. The registry stores the file relative to the project
 *     root, so the report's `rootDir` is reported alongside the cases and
 *     the two spellings are reconciled by the caller.
 *   * the retries of one spec share the identity of that spec, so they are
 *     aggregated into ONE case with SEVERAL attempts.
 *
 * @param {object} report the parsed `report.json`
 * @returns {object} the unified summary: the counters, the cases and the
 *   attempts of every case
 */
export function parseReport(report) {
  const executions = [];
  const rootDir = report?.config?.rootDir || null;
  /** The ordinal of every spec, so that two specs with the same identity
   *  (the same file, the same title and NO line) stay two cases. */
  let specOrdinal = 0;

  function walk(s) {
    for (const x of s.specs || []) {
      const file = x.file || s.file || '';
      const line = x.line ?? null;
      const column = x.column ?? null;
      // The identity of the SPEC: its file, its title and its line. The
      // ordinal keeps two same-titled specs apart when the report carries no
      // line for them.
      const caseKey = `${file} ${x.title ?? ''} ${line} #${specOrdinal++}`;
      for (const t of x.tests || []) {
        const caseStatus = t.status || 'unknown';
        const results = Array.isArray(t.results) && t.results.length ? t.results : [];
        if (!results.length) {
          // A case with no execution: it was skipped or it never ran. It
          // still exists, and it is still counted ONCE.
          executions.push({
            title: x.title, file, line, column, caseKey,
            status: caseStatus, retry: 0, duration: 0, error: '',
          });
          continue;
        }
        results.forEach((r, index) => {
          executions.push({
            title: x.title, file, line, column, caseKey,
            // The RESULT level status of this execution. When the result
            // carries no status, the case level status is the best the
            // report says.
            status: r.status ?? caseStatus,
            retry: Number.isInteger(r.retry) ? r.retry : index,
            duration: Number.isFinite(r.duration) ? r.duration : 0,
            error: r.error?.message || '',
          });
        });
      }
    }
    for (const sub of s.suites || []) walk(sub);
  }

  for (const suite of report?.suites || []) walk(suite);
  return { ...aggregateCases(executions), rootDir };
}

/**
 * The body fingerprint of the case a report names.
 *
 * A report names a case by file, title and line. The source of the file is
 * read and scanned, and the case that sits at the reported line with the
 * reported title is located; its body is fingerprinted. The fingerprint is
 * what tells two cases that share a title apart.
 *
 * Returns null when the file cannot be read, when the case is not in the file
 * any more, or when several cases share the title and the line does not pick
 * one of them. A null fingerprint leaves the case unbound, which is the honest
 * answer: it is better to report no UID than the UID of a different case.
 *
 * `cache` holds the scanned cases per file, so a file is read and scanned at
 * most once per run.
 */
export function reportedBodyKey(projectRoot, file, reported, cache = new Map()) {
  if (!projectRoot || !file) return null;
  let cases = cache.get(file);
  if (cases === undefined) {
    let content = null;
    try {
      const full = pathResolve(projectRoot, file);
      if (existsSync(full)) content = readFileSync(full, 'utf8');
    } catch { content = null; }
    cases = content === null ? null : scanTestCases(content);
    cache.set(file, cases);
  }
  if (!cases) return null;
  const titled = cases.filter((x) => x.title === reported.title);
  if (!titled.length) return null;
  if (titled.length === 1) return bodyKeyOf(titled[0].bodyText ?? null);
  // Several cases share the title: the reported line picks one of them.
  const atLine = titled.filter((x) => x.line === reported.line);
  if (atLine.length === 1) return bodyKeyOf(atLine[0].bodyText ?? null);
  return null;
}

/**
 * The executions of one case, in the two shapes a caller may hand over.
 *
 * The unified summary carries the attempts of a case in `case.attempts`.
 * A caller that builds the summary BY HAND -- a test, or a caller that
 * already flattened the report -- may instead pass one case per execution,
 * without an `attempts` array. Such a case is ONE execution of itself, and
 * it is treated as such.
 *
 * The status of a hand-built case is the RAW engine status ('expected'), so
 * it is mapped onto the common vocabulary here -- exactly like every other
 * status the model sees.
 */
function attemptsOfCase(c) {
  if (Array.isArray(c.attempts)) return c.attempts;
  return [{
    status: mapEngineStatus(c.resultStatus ?? c.status),
    retry: Number.isInteger(c.retry) ? c.retry : 0,
    duration: Number.isFinite(c.duration) ? c.duration : 0,
    error: c.error ?? '',
  }];
}

/**
 * Builds the Attempt records of one Run.
 *
 * One Attempt is the execution of one test case inside one Run; a retried
 * case produces one Attempt per retry, and a case that runs in several
 * projects produces one Attempt per project. The Attempt UID is derived from
 * the Run UID, the TestDefinition UID, the retry index and the occurrence
 * index of the attempt inside the run, so the same attempt can be recomputed
 * from the recorded fields (that is what the migration script relies on).
 *
 * `registry` supplies the mapping from a reported case to the stable
 * TestDefinition UID. A case that cannot be bound unambiguously keeps
 * `testUid: null` and records the reason in `uidBasis`.
 *
 * The binding is done PER CASE, not per attempt: the attempts of one case
 * are executions of the SAME logical case, so they carry the SAME
 * TestDefinition UID. Binding them one by one would let two attempts of one
 * case end up on two different UIDs, which would make the history of a flaky
 * case unreadable.
 */
export function attemptsForRun(run, summary, registry) {
  if (!summary || !Array.isArray(summary.cases)) return [];
  const projectUid = run.projectUid ?? '';
  const projectRoot = run.projectRoot ?? null;
  const rootDir = summary.rootDir ?? null;
  const occurrence = new Map();
  const bodyCache = new Map();
  const attempts = [];
  for (const c of summary.cases) {
    // The report names the test files relative to the Playwright rootDir, the
    // registry stores them relative to the project root. The project root is
    // needed to reconcile the two spellings.
    const file = normalizeTestPath(c.file, { rootDir, projectRoot });
    // A title that several cases in the same file share does not identify one
    // of them, and the line cannot make it one: the case at the reported line
    // may be a different case than the one that was there when the registry
    // was written. The BODY FINGERPRINT of the reported case is what tells
    // them apart, so it is computed from the source of THIS run and handed to
    // the lookup. The source is read only when the file is known and only
    // once per file.
    const found = findTestUid(registry, projectUid, {
      file,
      title: c.title,
      line: c.line,
      resolveBodyKey: () => reportedBodyKey(projectRoot, file, c, bodyCache)
    });
    const key = `${file} ${c.title} ${c.line}`;
    for (const attempt of attemptsOfCase(c)) {
      const index = occurrence.get(key) ?? 0;
      occurrence.set(key, index + 1);
      attempts.push({
        uid: attemptUidFor({
          runUid: run.uid || run.id,
          testUid: found.uid,
          retry: attempt.retry,
          fallbackKey: `${file} ${c.title} ${c.line}`,
          occurrence: index
        }),
        runUid: run.uid || run.id,
        testUid: found.uid,
        uidBasis: found.basis,
        file,
        title: c.title,
        line: c.line,
        retry: attempt.retry || 0,
        // An Attempt is one EXECUTION, so it records the result level status.
        // The case level status would describe the case as a whole and
        // would report "flaky" for the failed retry as well.
        status: attempt.status,
        // The case level status next to it: the aggregate of the attempts of
        // the case this attempt belongs to.
        caseStatus: Array.isArray(c.attempts) ? c.status : mapEngineStatus(c.status),
        duration: attempt.duration,
        error: attempt.error || ''
      });
    }
  }
  return attempts;
}

/* ------------------------------------------------------------------ */
/* The event vocabulary and the state machine                         */
/* ------------------------------------------------------------------ */

/**
 * The event types of the execution model.
 *
 * The types are the ones the v0.1 bridge already wrote (`run.queued`,
 * `run.started`, `run.finished`, `run.cancelling`, `run.error`); ATS-208
 * adds the one that was MISSING and that the acceptance criterion needs:
 * `run.interrupted` -- the event that says "the bridge died while this run
 * was in flight". Without it the events of an interrupted run determine no
 * status, so they cannot be replayed.
 */
export const EVENT_TYPE = Object.freeze({
  QUEUED: 'run.queued',
  STARTED: 'run.started',
  FINISHED: 'run.finished',
  CANCELLING: 'run.cancelling',
  ERROR: 'run.error',
  INTERRUPTED: 'run.interrupted',
});

/**
 * The state machine of a run.
 *
 * Each entry names the status the run is in and the events that may be
 * written WHILE it is in that status. An event that is not allowed from the
 * current status is REFUSED, and the refusal is reported rather than
 * written: an event stream that contradicts the state machine is a bug in
 * the writer, and writing it anyway would make the stream unreplayable.
 *
 * THE RULE FOR THE WRITER
 * -----------------------
 * An event is written BEFORE the status changes, so the event records the
 * status the run is LEAVING. The one exception is `run.queued`, which is
 * written while the run is still `queued`: it announces the run, and the
 * run has not left that status yet.
 *
 * That is what makes the stream replayable: the last event of the stream
 * is the one that names the status the run ended in.
 */
export const RUN_TRANSITIONS = Object.freeze({
  [RUN_STATUS.QUEUED]: [
    EVENT_TYPE.QUEUED, EVENT_TYPE.STARTED, EVENT_TYPE.CANCELLING,
    EVENT_TYPE.ERROR, EVENT_TYPE.INTERRUPTED,
  ],
  [RUN_STATUS.RUNNING]: [
    EVENT_TYPE.FINISHED, EVENT_TYPE.CANCELLING, EVENT_TYPE.ERROR,
    EVENT_TYPE.INTERRUPTED,
  ],
  [RUN_STATUS.CANCELLING]: [
    EVENT_TYPE.FINISHED, EVENT_TYPE.ERROR, EVENT_TYPE.INTERRUPTED,
  ],
  [RUN_STATUS.PASSED]: [],
  [RUN_STATUS.FAILED]: [],
  [RUN_STATUS.CANCELLED]: [],
  [RUN_STATUS.ERROR]: [],
  [RUN_STATUS.INTERRUPTED]: [],
});

/**
 * True when the event may follow the given run status.
 *
 * An UNKNOWN status is permissive: a run whose status the model does not
 * know is not blocked from writing an event. The model refuses the
 * transitions it can PROVE are wrong, and stays out of the way of the ones
 * it cannot judge.
 */
export function isAllowedTransition(status, eventType) {
  const allowed = RUN_TRANSITIONS[status];
  if (!allowed) return true;
  return allowed.includes(eventType);
}

/**
 * The run status an event implies.
 *
 * This is the REPLAY: given the events of a run, in their sequence order,
 * what status do they describe? The answer is the status of the LAST event
 * that implies one -- an event stream is append-only, so the last one wins.
 *
 * The mapping is the reason the interrupted run can be replayed at all:
 * `run.interrupted` implies `interrupted`, `run.finished` implies the
 * status the run finished with, and `run.error` implies `error`.
 */
export function statusOfEvent(event) {
  const type = event?.type;
  switch (type) {
    case EVENT_TYPE.FINISHED:
      return event?.data?.status ?? RUN_STATUS.FAILED;
    case EVENT_TYPE.ERROR:
      return RUN_STATUS.ERROR;
    case EVENT_TYPE.INTERRUPTED:
      return RUN_STATUS.INTERRUPTED;
    case EVENT_TYPE.CANCELLING:
      return RUN_STATUS.CANCELLING;
    case EVENT_TYPE.STARTED:
      return RUN_STATUS.RUNNING;
    case EVENT_TYPE.QUEUED:
      return RUN_STATUS.QUEUED;
    default:
      return null;
  }
}

/**
 * Replays the events of a run into its status.
 *
 * The events are taken in their SEQUENCE order, not in the order they
 * arrive: the sequence number is the order the model defines, so a stream
 * that is read out of order still replays correctly.
 *
 * @param {object[]} events the events of the run
 * @returns {{status:string|null,terminal:boolean,sequence:number[],gaps:number[],events:object[]}}
 *   `status` is null when the events determine no status (an empty stream,
 *   or a stream that ends before the run reached one). `gaps` lists the
 *   sequence numbers that are missing from the stream.
 */
export function replayEvents(events) {
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e === 'object')
    .slice()
    .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));

  let status = null;
  for (const event of list) {
    const implied = statusOfEvent(event);
    if (implied !== null) status = implied;
  }

  const sequence = list.map((e) => Number(e.seq) || 0);
  const gaps = [];
  for (let i = 1; i < sequence.length; i++) {
    for (let missing = sequence[i - 1] + 1; missing < sequence[i]; missing++) gaps.push(missing);
  }

  return {
    status,
    terminal: status !== null && isTerminalRunStatus(status),
    sequence,
    gaps,
    events: list,
  };
}

/**
 * The next event sequence number of a run.
 *
 * The sequence is PER RUN and starts at 1. It is gap-free: every event a
 * run writes takes the next number, so the numbers of the stream are
 * 1..N with no hole. A hole means an event was lost, and the replay says so
 * instead of quietly reading a stream that is missing something.
 */
export function nextEventSeq(run) {
  const current = Number(run?.eventSeq);
  return Number.isInteger(current) && current > 0 ? current + 1 : 1;
}

/* ------------------------------------------------------------------ */
/* The unified run view                                               */
/* ------------------------------------------------------------------ */

/**
 * Builds the unified view of a run: the run itself, its cases, its
 * attempts and the summary the consumers read.
 *
 * This is the function the bridge and the adapters call, so that ONE run
 * has ONE description everywhere.
 *
 * @param {object} run the run record
 * @param {object[]} [executions] the executions of the run, in report order
 * @returns {object} the unified view
 */
export function runView(run, executions = []) {
  const aggregated = aggregateCases(executions);
  const cases = aggregated.cases;
  // The ATTEMPTS of the run: one per execution, flattened out of the cases
  // in the order they happened.
  const attempts = [];
  for (const c of cases) {
    for (const attempt of c.attempts) {
      attempts.push({
        uid: attempt.uid ?? null,
        runUid: run?.uid ?? run?.id ?? null,
        testUid: c.testUid ?? null,
        uidBasis: c.uidBasis ?? null,
        file: c.file,
        title: c.title,
        line: c.line,
        retry: attempt.retry,
        status: attempt.status,
        caseStatus: c.status,
        duration: attempt.duration,
        error: attempt.error,
      });
    }
  }
  return {
    uid: run?.uid ?? run?.id ?? null,
    seq: run?.seq ?? null,
    status: run?.status ?? null,
    summary: {
      passed: aggregated.passed,
      failed: aggregated.failed,
      skipped: aggregated.skipped,
      flaky: aggregated.flaky,
      total: aggregated.total,
      executions: aggregated.executions,
      cases: cases.map((c) => ({
        title: c.title,
        file: c.file,
        status: c.status,
        duration: c.duration,
        error: c.error,
        attemptsCount: c.attemptsCount,
        attempts: c.attempts.map((a) => ({
          status: a.status,
          retry: a.retry,
          duration: a.duration,
          error: a.error,
        })),
      })),
    },
    attempts,
  };
}
