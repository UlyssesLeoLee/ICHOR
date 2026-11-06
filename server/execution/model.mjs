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

/**
 * The OUTCOME of one execution: did it behave the way the case was declared
 * to behave?
 *
 * THIS IS NOT THE SAME QUESTION AS THE STATUS.
 *
 * The STATUS says what happened ("the assertion failed"). The OUTCOME says
 * whether that was EXPECTED ("the case declares `test.fail()`, so a failure
 * is the expected outcome").
 *
 * Playwright reports both, and the report is the authority:
 *
 *   * `expectedStatus` -- what the case declared it wanted (`passed` by
 *     default, `failed` after `test.fail()`);
 *   * `status` -- the case level verdict the engine reached:
 *     `expected` (it behaved as declared), `unexpected` (it did not),
 *     `flaky` (it needed a retry), `skipped`.
 *
 * WITHOUT the expected status, the verdict of a `test.fail()` case is
 * INVERTED: the engine says `expected` (the case failed on purpose) and a
 * model that only looks at the raw result status calls that failure a
 * `failed` case. The measured symptom was a run that Playwright judged
 * `passed` (exit code 0) while the summary reported `failed: 1`.
 *
 * The vocabulary mirrors the engine's own:
 *
 *   expected   -- it behaved as the case declared
 *   unexpected -- it did NOT behave as the case declared
 *   skipped    -- it did not run
 *   unknown   -- the engine did not say
 */
export const OUTCOME = Object.freeze({
  EXPECTED: 'expected',
  UNEXPECTED: 'unexpected',
  FLAKY: 'flaky',
  SKIPPED: 'skipped',
  UNKNOWN: 'unknown',
});

/**
 * The OUTCOME of an execution, derived from the report.
 *
 * The rule is the engine's own rule, applied to the two facts the report
 * carries: the result level status (what happened) and the expected status
 * (what was declared).
 *
 *   * the case was SKIPPED          -> `skipped`
 *   * it behaved as declared        -> `expected`
 *   * it did not behave as declared -> `unexpected`
 *
 * A result the engine does not report (no status at all) is `unknown`: the
 * engine did not say, so the model does not guess.
 *
 * @param {string|null} status the RESULT level status (`passed` / `failed` / ...)
 * @param {string|null} expectedStatus what the case declared it wanted
 * @returns {string} one of the OUTCOME values
 */
export function outcomeOf(status, expectedStatus) {
  const result = String(status ?? '').toLowerCase();
  if (result === 'skipped') return OUTCOME.SKIPPED;
  if (!result) return OUTCOME.UNKNOWN;
  // Without a declared expectation the only honest answer is "we do not
  // know": a result without an expectation cannot be called expected or
  // unexpected. Engines that declare no expectation (WDIO) therefore report
  // their raw status instead of an outcome.
  if (!expectedStatus) return OUTCOME.UNKNOWN;
  const expected = String(expectedStatus).toLowerCase();
  // `timedOut` and `interrupted` are failures of the execution itself, and
  // they are never what the case declared.
  const behaved = result === 'passed' ? expected === 'passed'
    : result === 'failed' ? expected === 'failed'
      : false;
  return behaved ? OUTCOME.EXPECTED : OUTCOME.UNEXPECTED;
}

/**
 * The OUTCOME of a case, from the outcomes of its PROJECTS.
 *
 * The rule is the engine's own:
 *
 *   1. every project skipped              -> `skipped`
 *   2. some project unexpected             -> `unexpected`
 *      (the case did NOT behave as declared in at least one project)
 *   3. some project flaky                  -> `flaky`
 *      (it needed a retry in at least one project)
 *   4. every project expected              -> `expected`
 *
 * The outcomes are the outcomes of the PROJECTS of the case, in the order
 * the projects ran. A case that ran in one project only has one outcome.
 *
 * An outcome of `unknown` (no declared expectation) does not decide
 * anything: a case whose projects say nothing keeps the `unknown` outcome,
 * and the STATUS aggregation decides it.
 */
export function aggregateOutcomes(outcomes) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  const known = list.filter((o) => o !== OUTCOME.UNKNOWN);
  if (!known.length) return OUTCOME.UNKNOWN;
  if (list.every((o) => o === OUTCOME.SKIPPED)) return OUTCOME.SKIPPED;
  if (known.some((o) => o === OUTCOME.UNEXPECTED)) return OUTCOME.UNEXPECTED;
  if (known.some((o) => o === OUTCOME.FLAKY)) return OUTCOME.FLAKY;
  return OUTCOME.EXPECTED;
}

/**
 * The OUTCOME of one PROJECT of a case, from the engine's verdict.
 *
 * The engine's verdict already answers the question: `expected` means the
 * project behaved as the case declared, `unexpected` means it did not,
 * `flaky` means it needed a retry, `skipped` means it did not run.
 */
export function outcomeOfVerdict(verdict) {
  switch (verdict) {
    case CASE_STATUS.PASSED: return OUTCOME.EXPECTED;
    case CASE_STATUS.FAILED: return OUTCOME.UNEXPECTED;
    case CASE_STATUS.FLAKY: return OUTCOME.FLAKY;
    case CASE_STATUS.SKIPPED: return OUTCOME.SKIPPED;
    default: return OUTCOME.UNKNOWN;
  }
}

/**
 * The CASE level status, from the verdicts of its PROJECTS.
 *
 * This is the rule Playwright itself applies to a spec that ran in several
 * projects (measured against @playwright/test 1.64.1):
 *
 *   1. some project `unexpected`  -> `failed`
 *      (the case did not behave as declared in at least one project)
 *   2. some project `flaky`       -> `flaky`
 *      (it needed a retry in at least one project)
 *   3. every project `skipped`    -> `skipped`
 *   4. otherwise                  -> `passed`
 *
 * WITHOUT the per-project verdicts the model cannot tell "the case failed in
 * project b only" (a failure) from "the case failed once and passed on the
 * retry" (a flaky case): both look like "some attempt failed, some attempt
 * passed". The verdicts are what tell them apart, so they are used when the
 * engine provides them.
 *
 * AN UNKNOWN VERDICT NEVER BECOMES `passed`.
 *
 * A verdict the model does not know is `unknown`, and `unknown` is not
 * evidence of a success. The rule above would classify a list of unknown
 * verdicts as `passed` (it falls through to the last case), which would
 * turn a case whose execution FAILED into a passed case -- the summary
 * would then contradict the exit code of the engine, which is exactly the
 * defect the `outcome` vocabulary was introduced to prevent.
 *
 * So an unknown verdict does NOT decide the case: it is dropped from the
 * decision, and the KNOWN verdicts decide it. A list that holds only
 * unknown verdicts decides nothing, and the caller falls back to the
 * aggregation of the attempt statuses -- the honest answer for an engine
 * that says nothing.
 *
 * Dropping the unknown verdict does NOT make the case `passed` on its own:
 * a case that ran in project a (`expected`) and was skipped in project b
 * (`skipped`) is `passed`, because the KNOWN verdicts say so. What must
 * not happen is a case whose only verdict is `unknown` being called
 * `passed`.
 *
 * Returns null when no verdict decides the case -- the caller then falls
 * back to the aggregation of the attempt statuses (which is what an engine
 * that declares no per-project verdict, such as WDIO, needs).
 */
export function aggregateVerdicts(verdicts) {
  const list = (Array.isArray(verdicts) ? verdicts : []).filter((v) => v);
  // The verdicts that decide the case: the KNOWN ones. An unknown verdict
  // is not evidence either way, so it does not vote.
  const known = list.filter((v) => v !== CASE_STATUS.UNKNOWN);
  if (!known.length) return null;
  if (known.some((v) => v === CASE_STATUS.FAILED)) return CASE_STATUS.FAILED;
  if (known.some((v) => v === CASE_STATUS.FLAKY)) return CASE_STATUS.FLAKY;
  if (known.every((v) => v === CASE_STATUS.SKIPPED)) return CASE_STATUS.SKIPPED;
  return CASE_STATUS.PASSED;
}

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
 * THE COUNTED STATUS IS THE OUTCOME, NOT THE RAW STATUS.
 *
 * The status a reader counts is the one the ENGINE counted: a case that
 * declares `test.fail()` and fails is an `expected` outcome, so it is a
 * `passed` case for the run -- exactly what Playwright's own `stats` says.
 * Counting the raw result status instead would report the expected failure
 * as a failed case while the engine exits 0, and the summary would
 * contradict the exit code.
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
      // The result level status of THIS execution: what happened.
      status,
      // What the case declared it wanted (`passed` by default, `failed`
      // after `test.fail()`), and therefore whether THIS execution behaved
      // as declared. Without the declared expectation the outcome is
      // `unknown`, not a guess.
      expectedStatus: raw.expectedStatus ?? null,
      outcome: raw.outcome ?? outcomeOf(raw.status, raw.expectedStatus),
      // The retry index of this execution (0 = the first try).
      retry: Number.isInteger(raw.retry) ? raw.retry : group.attempts.length,
      duration: Number.isFinite(raw.duration) ? raw.duration : 0,
      error: raw.error ?? '',
      at: raw.at ?? null,
    });
    group.caseKey = key;
  }

  const cases = [];
  for (const group of groups.values()) {
    const aggregate = aggregateAttempts(group.attempts);
    cases.push({
      title: group.title,
      file: group.file,
      line: group.line,
      column: group.column,
      // The key the case is grouped by: the parser of the report decides
      // it, and it is kept so that a caller can attach the engine's own
      // per-project verdicts to the case afterwards.
      caseKey: group.caseKey,
      // The CASE level status: the aggregate of the attempts.
      status: aggregate.status,
      // The aggregate of the OUTCOMES, next to the aggregate of the raw
      // statuses: a reader that wants the engine's own verdict reads it
      // here.
      outcome: aggregate.outcome,
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
 *
 * THE OUTCOME IS AGGREGATED SEPARATELY, and it is the OUTCOME that decides
 * whether a case counts as passed or failed:
 *
 *   1. every attempt skipped             -> `skipped`
 *   2. every attempt expected            -> `expected`
 *   3. some expected and some unexpected -> `unexpected`
 *   4. every attempt unexpected          -> `unexpected`
 *   5. otherwise                         -> `unknown`
 *
 * A case whose attempts all have an unknown outcome (an engine that declares
 * no expectation) keeps the STATUS aggregation, so the two never disagree
 * about a case that has no outcome at all.
 */
export function aggregateAttempts(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (!list.length) return { status: CASE_STATUS.UNKNOWN, outcome: OUTCOME.UNKNOWN, error: '' };

  const statuses = list.map((a) => a.status);
  const has = (s) => statuses.includes(s);

  let status;
  if (statuses.every((s) => s === CASE_STATUS.SKIPPED)) status = CASE_STATUS.SKIPPED;
  else if (statuses.every((s) => s === CASE_STATUS.PASSED)) status = CASE_STATUS.PASSED;
  else if (has(CASE_STATUS.PASSED) && has(CASE_STATUS.FAILED)) status = CASE_STATUS.FLAKY;
  else if (statuses.every((s) => s === CASE_STATUS.FAILED)) status = CASE_STATUS.FAILED;
  else if (has(CASE_STATUS.FAILED)) status = CASE_STATUS.FAILED;
  else status = CASE_STATUS.UNKNOWN;

  // The OUTCOME aggregation. The outcomes are only known when the engine
  // declared an expectation; an attempt without one has the `unknown`
  // outcome, and an unknown outcome never decides the case.
  const outcome = aggregateOutcomes(list.map((a) => a.outcome ?? OUTCOME.UNKNOWN));

  // The status of the case follows the OUTCOME when the outcome is known:
  // the engine's own verdict is the authority, and the raw result statuses
  // are only a fallback for an engine that declares no expectation.
  //
  // THE FLAKY OUTCOME IS NOT A VERDICT, IT IS A FACT ABOUT THE HISTORY: it
  // says the case needed a retry. It therefore never overrides the status
  // the raw statuses produced -- the status aggregation already knows
  // whether the retry RECOVERED the case (some passed and some failed ->
  // `flaky`) or whether it did not (every attempt failed -> `failed`).
  // Only the two outcomes that CHANGE the verdict act on the status:
  if (outcome === OUTCOME.EXPECTED && status === CASE_STATUS.FAILED) {
    // Every attempt failed, but every attempt was SUPPOSED to fail: the
    // case is `passed` for the run, exactly as the engine counts it.
    status = CASE_STATUS.PASSED;
  } else if (outcome === OUTCOME.UNEXPECTED && status === CASE_STATUS.PASSED) {
    // Every attempt passed, but the case declared it wanted to fail: the
    // case is `failed` for the run -- an unexpected pass is a defect.
    status = CASE_STATUS.FAILED;
  } else if (outcome === OUTCOME.SKIPPED && status !== CASE_STATUS.SKIPPED) {
    status = CASE_STATUS.SKIPPED;
  }

  // The error of the case is the error of its FIRST failing attempt.
  const firstFailure = list.find((a) => a.status === CASE_STATUS.FAILED && a.error);
  const error = firstFailure ? firstFailure.error : (list.find((a) => a.error)?.error ?? '');

  return { status, outcome, error };
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
  /** The verdict of every PROJECT of every case, keyed by the case key.
   *  The verdict is what the engine itself concluded about the case in
   *  that project (`expected` / `unexpected` / `flaky` / `skipped`). */
  const verdicts = new Map();

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
        // What the case DECLARED it wanted: `passed` by default, `failed`
        // after `test.fail()`. The report carries it per TEST (i.e. per
        // project), so it is read from there and not from the spec.
        const expectedStatus = t.expectedStatus ?? null;
        // The engine's own verdict for this project of the case.
        const verdict = mapEngineStatus(caseStatus);
        if (!verdicts.has(caseKey)) verdicts.set(caseKey, []);
        verdicts.get(caseKey).push(verdict);
        const results = Array.isArray(t.results) && t.results.length ? t.results : [];
        if (!results.length) {
          // A case with no execution: it was skipped or it never ran. It
          // still exists, and it is still counted ONCE.
          executions.push({
            title: x.title, file, line, column, caseKey,
            status: caseStatus, expectedStatus, retry: 0, duration: 0, error: '',
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
            // The declared expectation travels with the execution, so the
            // OUTCOME of this execution (did it behave as declared?) can be
            // derived without the whole report.
            expectedStatus,
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
  const aggregated = aggregateCases(executions);
  // The engine's per-project verdicts decide the case level status and
  // outcome when the engine provides them. They are what tell "the case
  // failed in project b only" (a failure) from "the case failed once and
  // passed on the retry" (a flaky case) apart.
  for (const c of aggregated.cases) {
    const key = c.caseKey;
    const projectVerdicts = verdicts.get(key);
    if (!projectVerdicts) continue;
    const status = aggregateVerdicts(projectVerdicts);
    if (status !== null) c.status = status;
    c.outcome = aggregateOutcomes(projectVerdicts.map(outcomeOfVerdict));
  }
  // The counters are computed from the FINAL statuses: the verdicts may
  // have changed them, and a counter that does not match the cases it
  // counts is a lie.
  return { ...countCases(aggregated.cases), cases: aggregated.cases, rootDir };
}

/**
 * The counters of a list of cases.
 *
 * The counters count the CASES, never the executions: a retried case is
 * ONE case, so it is counted ONCE. The number of executions is reported
 * separately, as `executions`.
 */
export function countCases(cases) {
  const list = Array.isArray(cases) ? cases : [];
  return {
    passed: list.filter((c) => c.status === CASE_STATUS.PASSED).length,
    failed: list.filter((c) => c.status === CASE_STATUS.FAILED).length,
    skipped: list.filter((c) => c.status === CASE_STATUS.SKIPPED).length,
    flaky: list.filter((c) => c.status === CASE_STATUS.FLAKY).length,
    // `total` counts the CASES. A retried case is still one case.
    total: list.length,
    // `executions` counts the attempts.
    executions: list.reduce((n, c) => n + (c.attemptsCount ?? 0), 0),
  };
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
    expectedStatus: c.expectedStatus ?? null,
    outcome: c.outcome ?? outcomeOf(c.resultStatus ?? c.status, c.expectedStatus),
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
        // What the case DECLARED it wanted (`passed` by default, `failed`
        // after `test.fail()`), and whether THIS execution behaved as
        // declared. Without the declared expectation the outcome is
        // `unknown` -- the model does not guess.
        expectedStatus: attempt.expectedStatus ?? null,
        outcome: attempt.outcome ?? OUTCOME.UNKNOWN,
        // The case level status next to it: the aggregate of the attempts of
        // the case this attempt belongs to.
        caseStatus: Array.isArray(c.attempts) ? c.status : mapEngineStatus(c.status),
        // The OUTCOME of the case next to it: the aggregate of the outcomes
        // of its attempts.
        caseOutcome: Array.isArray(c.attempts) ? (c.outcome ?? OUTCOME.UNKNOWN) : OUTCOME.UNKNOWN,
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
 * THE REPLAY ALSO CHECKS THE STATE MACHINE.
 *
 * Folding the events yields a status, but a status is not enough: a stream
 * that violates `RUN_TRANSITIONS` describes a run that never existed. The
 * replay therefore reports the violations it found, and a stream with
 * violations is NOT a valid description of a run -- so the answer says so
 * instead of agreeing with a contradictory record.
 *
 * THE REPLAY ALSO CHECKS THE SEQUENCE.
 *
 * The sequence of a run is 1..N: gap-free and strictly increasing. Two
 * things can break that, and BOTH are reported:
 *
 *   * a LOST number -- a hole in the sequence. The numbers that are missing
 *     are listed in `gaps`. The holes BETWEEN two events were always
 *     reported; the hole at the BEGINNING of the stream was not, so a log
 *     that lost its first events looked intact. The sequence starts at 1,
 *     so every number below the first one that is present is missing too.
 *   * a REUSED number -- two events carrying the same number. The
 *     metadata layer's primary key `(run_uid, seq)` refuses such a pair,
 *     so a stream that holds one does not describe a run: it is reported
 *     in `duplicates` and the stream is NOT valid.
 *
 * The check follows the same rule as the writer: an event is written
 * BEFORE the status changes, so each event names the status the run is
 * LEAVING. The `run.queued` event is the exception: it is written while
 * the run is still `queued`.
 *
 * @param {object[]} events the events of the run
 * @returns {{status:string|null,terminal:boolean,sequence:number[],gaps:number[],duplicates:number[],unsequenced:number[],events:object[],valid:boolean,violations:object[]}}
 *   `status` is null when the events determine no status (an empty stream,
 *   or a stream that ends before the run reached one). `gaps` lists the
 *   sequence numbers that are missing from the stream. `duplicates` lists
 *   the sequence numbers that are used more than once. `violations` lists
 *   the events that the state machine does not allow.
 */
export function replayEvents(events) {
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e === 'object')
    .slice()
    .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));

  let status = null;
  // The status the run is in, as the events describe it. It starts out
  // unknown: the first event has to tell us where the run was.
  let current = null;
  const violations = [];
  for (const event of list) {
    const implied = statusOfEvent(event);
    if (implied !== null) status = implied;
    // The state machine check. An event is written BEFORE the status
    // changes, so the status the run is in when the event is written is
    // the status the PREVIOUS event left behind.
    if (!isAllowedTransition(current, event.type)) {
      violations.push({
        seq: Number(event.seq) || 0,
        type: event.type,
        from: current,
        to: implied,
        reason: `the event ${event.type} is not allowed from the status ${current}`,
      });
    }
    if (implied !== null) current = implied;
  }

  const sequence = list.map((e) => Number(e.seq) || 0);
  // The events that carry no usable sequence number. The sequence of a run
  // starts at 1, so a number that is not a positive integer is not part of
  // it -- and an event without a number cannot be placed in the stream.
  const unsequenced = sequence.filter((n) => !Number.isInteger(n) || n < 1);
  // The numbers the stream actually holds, and how often each is used.
  const counts = new Map();
  for (const n of sequence) {
    if (!Number.isInteger(n) || n < 1) continue;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  // The numbers that are used MORE THAN ONCE. A reused number is a
  // contradiction: two events claim the same place in the stream.
  const duplicates = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([seq]) => seq)
    .sort((a, b) => a - b);
  // The numbers that are MISSING. The sequence starts at 1, so the hole at
  // the beginning of the stream counts as well: a log that lost its first
  // events is not an intact log.
  const gaps = [];
  const highest = counts.size ? Math.max(...counts.keys()) : 0;
  for (let missing = 1; missing <= highest; missing++) {
    if (!counts.has(missing)) gaps.push(missing);
  }

  return {
    status,
    terminal: status !== null && isTerminalRunStatus(status),
    sequence,
    gaps,
    duplicates,
    unsequenced,
    events: list,
    // A stream that violates the state machine, or that reuses a sequence
    // number, does not describe a run.
    valid: violations.length === 0 && duplicates.length === 0,
    violations,
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
/* The durable event log                                               */
/* ------------------------------------------------------------------ */

/**
 * Reads the durable event log of a run.
 *
 * THE LOG MAY BE DAMAGED, and a damaged log must not take the bridge down.
 *
 * A crash in the middle of an append leaves a TORN last line: a fragment of
 * JSON that does not parse. The reader therefore does not `JSON.parse` the
 * whole file and hope: it parses line by line, SKIPS the lines that do not
 * parse, and REPORTS them. A reader that threw on the first bad line would
 * answer `/events` and `/replay` with a 500 for the rest of the run's life,
 * and the run would become unreadable because of one torn byte.
 *
 * The skipped lines are reported so that the damage is visible: a reader
 * that silently drops an event cannot tell "the run did that" from "the log
 * lost that".
 *
 * @param {string} text the content of `events.jsonl`
 * @returns {{events:object[],unreadable:number[],truncated:boolean}}
 *   `unreadable` lists the 1-based line numbers that could not be parsed.
 *   `truncated` is true when the file does not end with a newline, i.e.
 *   when the last line may be torn.
 */
export function parseEventLog(text) {
  const events = [];
  const unreadable = [];
  const raw = String(text ?? '');
  if (!raw.trim()) return { events, unreadable, truncated: false };
  const lines = raw.split('\n');
  // A file that does not end with a newline has a torn last line: the
  // writer was interrupted in the middle of the append.
  const truncated = !raw.endsWith('\n') && lines.length > 0;
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed);
      else unreadable.push(index + 1);
    } catch {
      unreadable.push(index + 1);
    }
  });
  return { events, unreadable, truncated };
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
        expectedStatus: attempt.expectedStatus ?? null,
        outcome: attempt.outcome ?? OUTCOME.UNKNOWN,
        caseStatus: c.status,
        caseOutcome: c.outcome ?? OUTCOME.UNKNOWN,
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
        outcome: c.outcome ?? OUTCOME.UNKNOWN,
        duration: c.duration,
        error: c.error,
        attemptsCount: c.attemptsCount,
        attempts: c.attempts.map((a) => ({
          status: a.status,
          expectedStatus: a.expectedStatus ?? null,
          outcome: a.outcome ?? OUTCOME.UNKNOWN,
          retry: a.retry,
          duration: a.duration,
          error: a.error,
        })),
      })),
    },
    attempts,
  };
}
