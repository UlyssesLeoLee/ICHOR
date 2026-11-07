/**
 * ATS-216 -- the QUALITY OVERVIEW module (质量概览模块).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The acceptance criterion of this task is one sentence:
 *
 *   「区分失败/重试/取消，指标与原始结果可核对」
 *
 *   ("distinguish failure / retry / cancel; the metrics must be checkable
 *   against the raw results")
 *
 * That sentence has two halves, and both of them are requirements about
 * HONESTY rather than about arithmetic:
 *
 *   1. THREE DIFFERENT THINGS MUST NOT BE COUNTED AS ONE.
 *      A run that FAILED is not a run that was CANCELLED, and a case that
 *      needed a RETRY is not a case that failed. Before ATS-216 the workbench
 *      showed four numbers (tests / runs / passed / failed) and a cancelled
 *      run simply did not appear anywhere, so a reader could not tell
 *      "nothing was wrong" from "we stopped the run before it finished".
 *      This module keeps the three apart and says which bucket every item
 *      is in.
 *
 *   2. EVERY NUMBER MUST BE TRACEABLE BACK TO THE RAW RESULT.
 *      A metric that cannot be reconciled with the case list is a claim,
 *      not a measurement. So every bucket here carries the RAW ITEMS that
 *      produced it (`refs`), and the module itself RECONCILES the numbers it
 *      computed against (a) the raw case/attempt list it walked and (b) the
 *      per-run counters the bridge itself reported (`run.summary`).
 *      The reconciliation compares the numbers the interface DISPLAYS with
 *      the numbers the bridge reported -- the two come from different
 *      places, so a wrong metric is caught instead of being confirmed.
 *      A mismatch is REPORTED, never smoothed away.
 *
 * WHY THE FILE LIVES IN `public/`
 * ------------------------------
 * There are TWO user interfaces in this repository: the Next.js workbench
 * (`apps/studio/app/page.tsx`) and the zero-dependency portable UI
 * (`apps/studio/public/fallback.html`). Both show quality metrics.
 *
 * The Bridge serves static files from `apps/studio/out` and
 * `apps/studio/public` (`server/index.mjs` -> `staticFile()`), so a module
 * under `public/` is reachable by the portable UI at a stable URL. Putting
 * the ONE implementation here therefore means the two interfaces cannot
 * drift apart: the portable UI imports exactly the code the Next app
 * imports. (The repository already tolerates a duplicated flow projection
 * between the two UIs; this task does not add a second copy of the metrics.)
 *
 * The module is PLAIN ECMASCRIPT MODULE with JSDoc types, so it is
 *   * importable by the Next app (TypeScript reads the JSDoc),
 *   * importable by Node's test runner (`node --test`),
 *   * importable by the portable UI in the browser (ES modules),
 * without a build step of its own.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It is NOT an AI failure classifier. The clustering below is DETERMINISTIC:
 * the signature of a failure is a NORMALIZED form of its own error text
 * (numbers, quoted strings, uuids and hex addresses replaced by
 * placeholders). The same error text always yields the same signature, and
 * two different error texts never share a signature unless their normalized
 * forms are equal. No model is involved, and none could be: the module runs
 * in the browser with no network access.
 */

/* ------------------------------------------------------------------ */
/* The vocabularies                                                    */
/* ------------------------------------------------------------------ */

/**
 * The status of a RUN, grouped by what it means for the metrics.
 *
 * This grouping is the heart of 「区分失败/重试/取消」. A run that was
 * cancelled on request says NOTHING about the quality of the code under
 * test: the operator stopped it. Counting it as a failure would blame the
 * code for a decision a human made, and counting it as a pass would hide a
 * run that never finished. So a cancelled run gets its own bucket.
 *
 *   verdict      -- the run finished and the engine gave a verdict
 *                   (`passed` / `failed`). Its cases are real results.
 *   inconclusive -- the run did NOT finish on its own terms
 *                   (`cancelled` / `error` / `interrupted`). Its cases are
 *                   reported SEPARATELY and are never counted as passes or
 *                   failures.
 *   inFlight     -- the run is still going (`queued` / `running` /
 *                   `cancelling`). Its summary is partial by definition.
 *
 * The three groups are the ONLY classification of a run status: the run
 * bucket and the treatment of the run's cases are both derived from it, so
 * they cannot disagree.
 */

/** The run statuses that carry a verdict; their cases are real results. */
export const RUN_VERDICT_STATUSES = Object.freeze(['passed', 'failed']);

/** The run statuses that mean the run did not finish on its own terms. */
export const RUN_INCONCLUSIVE_STATUSES = Object.freeze([
  'cancelled', 'error', 'interrupted',
]);

/** The run statuses that mean the run is still in flight. */
export const RUN_IN_FLIGHT_STATUSES = Object.freeze([
  'queued', 'running', 'cancelling',
]);

/**
 * The status of a CASE, as ATS-208 defines it
 * (`server/execution/model.mjs` -> `CASE_STATUS`).
 *
 * `flaky` is the RETRY bucket: the case failed at least once, the retry
 * recovered it, and the case as a whole is not a failure. It is NOT a
 * pass either -- a reader who only sees `passed` cannot know that the case
 * needed a second try.
 *
 * `unknown` is the honest answer for a result the engine did not report.
 * It is never folded into `passed` or `failed`: reporting an unknown status
 * as a failure would invent a failure, and reporting it as a pass would
 * invent a success.
 *
 * @type {Readonly<Record<string,string>>}
 */
export const CASE_STATUS = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  FLAKY: 'flaky',
  UNKNOWN: 'unknown',
});

/** The case statuses, in the order the buckets are reported. */
export const CASE_STATUSES = Object.freeze([
  CASE_STATUS.PASSED,
  CASE_STATUS.FAILED,
  CASE_STATUS.FLAKY,
  CASE_STATUS.SKIPPED,
  CASE_STATUS.UNKNOWN,
]);

/** The attempt-level statuses (one execution of one case). */
export const ATTEMPT_STATUSES = Object.freeze([
  CASE_STATUS.PASSED,
  CASE_STATUS.FAILED,
  CASE_STATUS.FLAKY,
  CASE_STATUS.SKIPPED,
  CASE_STATUS.UNKNOWN,
]);

/**
 * Maps a run status onto its group.
 *
 * An UNKNOWN status is `inconclusive`, not `passed`: a status this module
 * does not know is a fact the module does not have, and the safe place for
 * an unknown fact is the bucket that claims nothing.
 *
 * @param {string|null|undefined} status
 * @returns {'verdict'|'inconclusive'|'inFlight'}
 */
export function runStatusGroup(status) {
  const s = String(status ?? '').toLowerCase();
  if (RUN_VERDICT_STATUSES.includes(s)) return 'verdict';
  if (RUN_IN_FLIGHT_STATUSES.includes(s)) return 'inFlight';
  return 'inconclusive';
}

/**
 * Maps a case status onto one of the five buckets.
 *
 * An unknown status becomes `unknown` rather than being guessed into
 * `passed` or `failed`.
 *
 * @param {string|null|undefined} status
 * @returns {string}
 */
export function caseBucket(status) {
  const s = String(status ?? '').toLowerCase();
  return CASE_STATUSES.includes(s) ? s : CASE_STATUS.UNKNOWN;
}

/* ------------------------------------------------------------------ */
/* Failure clustering (失败聚类) -- deterministic, non-AI              */
/* ------------------------------------------------------------------ */

/**
 * The normalized signature of a failure.
 *
 * A signature is what makes two failures "the same failure". It is the
 * error text with the VARIABLE parts removed:
 *
 *   * the leading error class (`AssertionError:`, `TimeoutError:` ...) is
 *     KEPT, because the class says which kind of failure it is: a timeout
 *     and an assertion failure are not the same defect. The KIND is also
 *     derived from it (see `classifyFailureKind`), so the class is not
 *     dropped and re-guessed elsewhere;
 *   * uuids, hex addresses and quoted literals become placeholders, so the
 *     same defect behind two different ids clusters together;
 *   * numbers become placeholders, so a timeout at 30000 ms and one at
 *     60000 ms are the same failure;
 *   * only the FIRST non-empty line is kept, so a stack trace does not
 *     split one failure into many signatures;
 *   * the result is length-capped, so a pathological message cannot make
 *     an unbounded key.
 *
 * The normalization is one-way and deterministic: the same input always
 * yields the same signature, and two inputs share a signature only when
 * their normalized forms are equal. That is what makes the clustering
 * CHECKABLE rather than a guess.
 *
 * @param {string|null|undefined} error
 * @returns {string}
 */
export function normalizeErrorSignature(error) {
  const raw = String(error ?? '').trim();
  if (!raw) return '(no error message)';
  // The ANSI escape sequences are stripped FIRST. The engine writes its
  // errors with colour codes, and a signature that carries them would
  // differ for the SAME failure depending on whether the report was
  // captured with or without a TTY -- two clusters for one defect.
  const plain = raw.replace(/\u001b\[[0-9;]*m/g, '');
  const first = plain.split('\n').map((s) => s.trim()).find((s) => s.length) ?? '';
  let s = first;
  // The error class is KEPT: `AssertionError:` and `TimeoutError:` are
  // different kinds of failure, and the KIND is derived from the signature.
  // Dropping the class here and re-deriving it elsewhere would let the two
  // disagree.
  s = s.replace(
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    '<uuid>');
  s = s.replace(/\b0x[0-9a-fA-F]+\b/g, '<hex>');
  s = s.replace(/'[^']*'/g, '<str>');
  s = s.replace(/"[^"]*"/g, '<str>');
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, '<n>');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 160) || '(no error message)';
}

/**
 * The basic KIND of a failure, derived from the normalized signature.
 *
 * The kinds are deliberately few, rule-based and non-AI. They are a first
 * cut for a reader who wants to know WHAT KIND of thing broke, not a
 * diagnosis: the diagnosis is the error text itself, which the cluster
 * keeps.
 *
 * THE ORDER OF THE RULES IS PART OF THE CONTRACT:
 *
 *   1. `timeout`    -- the engine ran out of time.
 *   2. `cancelled`  -- the run was stopped.
 *   3. `network`    -- the connection failed.
 *   4. `assertion`  -- the WEB-FIRST ASSERTION form
 *                      (`expect(locator).toHaveText(x) failed`) and the
 *                      plain assertion forms (`expect` / `assert`).
 *                      The web-first form mentions a locator, but it is an
 *                      ASSERTION ABOUT that locator, not a failure to
 *                      resolve it -- so it is matched before the element
 *                      rule below.
 *   5. `element`    -- the locator itself could not be resolved
 *                      (not found, strict mode violation, ...).
 *   6. `navigation` -- the page could not be reached.
 *   7. `other`      -- nothing above applies.
 *
 * @param {string} signature
 * @returns {string} one of timeout / cancelled / network / assertion /
 *   element / navigation / other
 */
export function classifyFailureKind(signature) {
  const s = String(signature ?? '').toLowerCase();
  if (!s) return 'other';
  if (/timed?\s*out|timeout/.test(s)) return 'timeout';
  if (/cancel|interrupt/.test(s)) return 'cancelled';
  if (/net::|econn|enotfound|eai_again|socket|dns/.test(s)) return 'network';
  // The WEB-FIRST ASSERTION of Playwright: `expect(locator).toHaveText(x)
  // failed`. It names a locator, but the failure is the assertion about
  // that locator -- so it is an assertion, not a missing element.
  if (/expect\([^)]*\)\s*\.\s*\w+\s*\(/.test(s)) return 'assertion';
  if (/locator|element|not found|strict mode violation|resolved to/.test(s)) return 'element';
  if (/expect|assert/.test(s)) return 'assertion';
  if (/goto|navigation|url|redirect/.test(s)) return 'navigation';
  return 'other';
}

/**
 * The attempts of one case.
 *
 * A case that carries an `attempts` array has them. A case that does NOT is
 * ONE execution of itself -- and that is the rule the authoritative model
 * already uses (`server/execution/model.mjs` -> `attemptsOfCase()`): a
 * hand-built case without an `attempts` array is a single try of that case.
 *
 * The module follows the model rather than inventing its own rule, so the
 * attempt count of a case agrees with the count the bridge reports for the
 * same case. Without this rule the module would report zero attempts for a
 * case the bridge counts as one, and the reconciliation would cry wolf.
 *
 * @param {object} c the raw case
 * @returns {{status:string,retry:number,duration:number,error:string}[]}
 */
function attemptsOfCase(c) {
  if (Array.isArray(c.attempts)) return c.attempts;
  return [{
    status: c.status,
    retry: 0,
    duration: Number.isFinite(c.duration) ? c.duration : 0,
    error: c.error ?? '',
  }];
}

/**
 * The identity of a case, as far as the stored summary carries it.
 *
 * The model computes the identity of a case (`server/execution/model.mjs`
 * -> `parseReport` / `aggregateCases`) and the adapters carry it into the
 * stored summary: the DESCRIBE PATH (`scope`), the LINE and the CASE KEY.
 *
 * The identity is what tells two cases apart that share a file and a title
 * -- `describe('a') { test('works') }` and `describe('b') { test('works') }`
 * are two cases, and merging them turns a case that always fails into a
 * case that "sometimes fails".
 *
 * @param {object} c the raw case
 * @returns {{scope:string[],line:number|null,caseKey:string|null}}
 */
function identityOfCase(c) {
  const scope = Array.isArray(c.scope)
    ? c.scope.filter((s) => typeof s === 'string' && s.length > 0)
    : [];
  const line = Number.isInteger(c.line) ? c.line : null;
  const caseKey = typeof c.caseKey === 'string' && c.caseKey.length ? c.caseKey : null;
  return { scope, line, caseKey };
}

/**
 * The identity of a test, for the cross-run flakiness view.
 *
 * Two runs of the same logical case share the identity; a case with a
 * different identity is a DIFFERENT case, however similar its title is.
 *
 * The identity is built from the facts that are available, in this order:
 *
 *   1. the DESCRIBE PATH, when the stored summary carries one -- two
 *      same-titled cases of one file under different describes are two
 *      cases;
 *   2. the CASE KEY, when the stored summary carries one and the describe
 *      path is not available (the WebdriverIO adapter keys its cases on
 *      the file, the title and the ordinal of the group inside the suite);
 *   3. the file and the title alone, when the stored summary carries
 *      neither -- the identity is then as coarse as the data allows, and a
 *      collision inside one run is REPORTED instead of being merged
 *      silently.
 *
 * WHY THE LINE IS NOT PART OF THE KEY
 * ----------------------------------
 * The line is the position of the case in the test file, and the position
 * of a case changes whenever anything above it changes -- a new import, a
 * new test, a comment. A key that contains the line therefore splits the
 * history of one case into two at every such edit: the case passed before
 * the edit and failed after it, and the overview reports two cases that
 * each look stable instead of one case that is unreliable.
 *
 * The line carries no disambiguation power that the describe path does not
 * already carry, because the engine itself rejects the duplicates that a
 * line would have to separate. Measured with Playwright 1.64.1
 * (`tools/ats216-probes/identity-probe.mjs`):
 *
 *   - two tests with the same title in the SAME describe -> the engine
 *     refuses to run the file ("duplicate test title");
 *   - two describes with the same NAME and the same test title -> the
 *     engine refuses to run the file ("duplicate test title");
 *   - two describes with DIFFERENT names and the same test title -> the
 *     engine runs both, and the describe path tells them apart;
 *   - the same title path in two files -> the engine runs both, and the
 *     file tells them apart.
 *
 * So within one file the pair (describe path, title) is already unique --
 * the engine guarantees it -- and the line is a fact that moves. The key
 * therefore uses the describe path, not the line.
 *
 * The line still says whether the summary carries an engine-level identity
 * at all: a summary that carries a line carries a describe path, even when
 * that path is empty (a case declared outside any describe). Such a
 * summary is keyed on (file, describe path, title); a summary that carries
 * neither a describe path nor a line (the WebdriverIO one) falls back to
 * the case key, and a summary that carries neither falls back to the file
 * and the title.
 *
 * The key is the JSON encoding of the facts, not the values joined by a
 * separator: a separator character could occur inside a title or a path,
 * and a key built that way would collide (`a.spec.ts` + `b` against
 * `a.spec.ts/b` + ``). The JSON encoding cannot collide.
 *
 * @param {string} file
 * @param {string} title
 * @param {{scope?:string[],line?:number|null,caseKey?:string|null}} [identity]
 * @returns {string}
 */
export function testKeyOf(file, title, identity = null) {
  const scope = Array.isArray(identity?.scope)
    ? identity.scope.filter((s) => typeof s === 'string' && s.length > 0)
    : [];
  const line = Number.isInteger(identity?.line) ? identity.line : null;
  const caseKey = typeof identity?.caseKey === 'string' && identity.caseKey.length
    ? identity.caseKey
    : null;
  if (scope.length || line !== null) {
    return JSON.stringify([String(file ?? ''), scope, String(title ?? '')]);
  }
  if (caseKey) return JSON.stringify([caseKey]);
  return JSON.stringify([String(file ?? ''), String(title ?? '')]);
}

/* ------------------------------------------------------------------ */
/* The overview                                                        */
/* ------------------------------------------------------------------ */

/**
 * A reference to one raw case, so that every metric can be traced back.
 *
 * The reference carries the RUN it came from, because the same case can
 * appear in several runs with different verdicts -- and "this case failed
 * in run 3" is a fact that a bucket count alone cannot express.
 *
 * @typedef {object} QualityCaseRef
 * @property {'case'} kind
 * @property {string} runId
 * @property {string} runUid
 * @property {string} runStatus
 * @property {string} title
 * @property {string} file
 * @property {string[]} scope   the describe path of the case
 * @property {number|null} line
 * @property {string|null} caseKey
 * @property {string} status    the case-level status
 * @property {number} attemptsCount
 * @property {number} duration
 * @property {string} error
 * @property {string[]} attemptStatuses
 * @property {number} retryCount  attempts beyond the first
 */

/**
 * A cluster of failures that share a signature.
 *
 * @typedef {object} QualityCluster
 * @property {string} key
 * @property {string} signature
 * @property {string} kind
 * @property {number} count
 * @property {string[]} files
 * @property {QualityCaseRef[]} cases
 */

/**
 * The per-test cross-run view.
 *
 * @typedef {object} QualityTest
 * @property {string} key
 * @property {string} file
 * @property {string} title
 * @property {number} runs
 * @property {string[]} statuses
 * @property {number} failedRuns
 * @property {number} flakyRuns
 * @property {number} passedRuns
 * @property {boolean} flaky
 */

/**
 * One reconciliation check.
 *
 * @typedef {object} QualityCheck
 * @property {string} name
 * @property {number|string} expected
 * @property {number|string} actual
 * @property {boolean} ok
 * @property {string} detail
 */

/**
 * A reference to one raw run.
 *
 * @typedef {object} QualityRunRef
 * @property {string} id
 * @property {string} uid
 * @property {string} status
 * @property {number|null} seq
 * @property {string|null} createdAt
 * @property {string|null} gitCommit
 */

/**
 * The run-level part of the overview.
 *
 * @typedef {object} QualityRuns
 * @property {number} total
 * @property {number} passed
 * @property {number} failed
 * @property {number} cancelled
 * @property {number} error
 * @property {number} interrupted
 * @property {number} inFlight
 * @property {number} unknown     the runs whose status the module does not know
 * @property {number} verdict      the runs that carry a verdict
 * @property {number} inconclusive the runs that did not finish on their own terms
 * @property {number} passRate
 * @property {Object<string,QualityRunRef[]>} refs
 * @property {number} runsWithoutSummary
 */

/**
 * The case-level part of the overview.
 *
 * @typedef {object} QualityCases
 * @property {number} total
 * @property {number} counted
 * @property {number} passed
 * @property {number} failed
 * @property {number} flaky
 * @property {number} skipped
 * @property {number} unknown
 * @property {number} inconclusive
 * @property {number} retried
 * @property {number} attempts
 * @property {number} retries
 * @property {number} flakyRate
 * @property {Object<string,QualityCaseRef[]>} buckets
 * @property {QualityCaseRef[]} inconclusiveRefs
 * @property {number} inconclusiveAttempts
 * @property {number} inconclusiveRetried
 */

/**
 * The attempt-level part of the overview.
 *
 * @typedef {object} QualityAttempts
 * @property {number} total
 * @property {number} passed
 * @property {number} failed
 * @property {number} flaky
 * @property {number} skipped
 * @property {number} unknown
 * @property {number} retries
 * @property {number} inconclusive the attempts of the runs without a verdict
 */

/**
 * The cross-run flakiness view.
 *
 * @typedef {object} QualityTests
 * @property {number} total
 * @property {number} flaky
 * @property {number} flakyRate
 * @property {QualityTest[]} list
 */

/**
 * The reconciliation between the metrics and the raw results.
 *
 * @typedef {object} QualityReconciliation
 * @property {boolean} consistent
 * @property {QualityCheck[]} checks
 */

/**
 * The whole overview: the quality metrics of a set of runs.
 *
 * @typedef {object} QualityOverview
 * @property {QualityRuns} runs
 * @property {QualityCases} cases
 * @property {QualityAttempts} attempts
 * @property {QualityCluster[]} clusters
 * @property {{file:string,failed:number}[]} files
 * @property {QualityTests} tests
 * @property {QualityReconciliation} reconciliation
 */

/**
 * One metric card of the quality overview, with the raw items behind it.
 *
 * The raw items are split by their kind, so a reader (and a type checker)
 * does not have to narrow a union to render them:
 *
 *   `caseRefs` -- the CASES the number was counted from;
 *   `runRefs`  -- the RUNS the number was counted from (the run-level card).
 *
 * @typedef {object} QualityMetricCard
 * @property {string} key
 * @property {string} label
 * @property {number} value
 * @property {string} subtitle
 * @property {QualityCaseRef[]} caseRefs
 * @property {QualityRunRef[]} runRefs
 * @property {Array<QualityCaseRef|QualityRunRef>} refs every item of the card
 */

/**
 * Builds the quality overview of a set of runs.
 *
 * The input is the RAW list of runs as the bridge reports them
 * (`GET /api/runs` -> `{runs: [...]}`), each carrying its own `summary`
 * (the per-run counters) and `summary.cases` (the raw case list with the
 * per-attempt detail).
 *
 * Nothing here reaches for the network, and nothing here guesses: every
 * number is counted from the raw list, and the result says whether the
 * numbers agree with what the bridge itself reported.
 *
 * @param {object[]} runs
 * @param {{runId?:string}} [options] restrict the overview to one run
 * @returns {QualityOverview} the overview
 */
export function buildQualityOverview(runs, options = {}) {
  const all = Array.isArray(runs) ? runs.filter((r) => r && typeof r === 'object') : [];
  const selected = options && options.runId
    ? all.filter((r) => String(r.id) === String(options.runId))
    : all;

  /* --- the run level ------------------------------------------------- */
  /*
   * The RUN BUCKETS. Every run is in exactly ONE of them, and the sum of
   * them is the number of runs.
   *
   * `unknown` holds the runs whose status this module does not know: a
   * status it does not know is a fact it does not have, and the bucket
   * that claims nothing is the safe place for it. It is NOT part of the
   * `inconclusive` figure the interface shows -- that figure is the DERIVED
   * count of every run that did not reach a verdict (the cancelled, the
   * errored, the interrupted ones AND the unknown ones).
   */
  const runBuckets = {
    passed: 0, failed: 0, cancelled: 0, error: 0, interrupted: 0,
    inFlight: 0, unknown: 0,
  };
  const runRefs = {
    passed: [], failed: [], cancelled: [], error: [], interrupted: [],
    inFlight: [], unknown: [],
  };

  /* --- the case level ------------------------------------------------ */
  /** @type {Record<string, QualityCaseRef[]>} */
  const caseBuckets = {};
  for (const s of CASE_STATUSES) caseBuckets[s] = [];
  /** @type {QualityCaseRef[]} */
  const inconclusiveCases = [];
  /**
   * The case statuses as they were WALKED. The reconciliation compares
   * them with the buckets, so a bucket that lost or duplicated a case is
   * caught. It counts only the cases of runs that carry a verdict -- the
   * same population the buckets hold.
   *
   * The count is filled in the SAME walk, in the SAME branch, from the
   * SAME `caseStatus` that fills the bucket. It therefore catches a bucket
   * that lost or duplicated a case -- a push that did not happen, or one
   * that happened twice. It does NOT catch a case that was put in the
   * WRONG bucket: the classification is the shared premise of both
   * numbers, not an independent derivation of one of them. What catches a
   * wrong classification is the check that compares the number the
   * interface DISPLAYS with the counter the bridge reported -- those two
   * come from different places.
   */
  const walkedByStatus = {};
  for (const s of CASE_STATUSES) walkedByStatus[s] = 0;

  const attemptBuckets = {};
  for (const s of ATTEMPT_STATUSES) attemptBuckets[s] = 0;

  /** @type {Map<string, QualityCluster>} */
  const clusters = new Map();
  /** @type {Map<string, QualityTest>} */
  const tests = new Map();

  /** @type {QualityCheck[]} */
  const checks = [];
  let retriedCases = 0;
  let totalAttempts = 0;
  let retriedAttempts = 0;
  let casesSeen = 0;
  let casesWithoutSummary = 0;

  /*
   * The attempts and the retried cases of the runs that did NOT reach a
   * verdict. They are counted SEPARATELY: the attempts of a cancelled run
   * really happened, but they are not evidence about the quality of the
   * code under test, so they stay out of the retry metrics.
   */
  let inconclusiveAttempts = 0;
  let inconclusiveRetriedCases = 0;

  /*
   * The counters the BRIDGE reported, summed over the runs that reached a
   * verdict. They are the yardstick of the global reconciliation: the
   * module's own buckets and the bridge's own numbers come from different
   * places, so a metric that is wrong is caught instead of confirmed.
   */
  const reportedByBucket = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  const reportedBucketSeen = { passed: false, failed: false, flaky: false, skipped: false };
  let reportedExecutions = 0;
  let reportedExecutionsSeen = false;

  const addCheck = (name, expected, actual, detail) => {
    checks.push({
      name,
      expected,
      actual,
      ok: expected === actual,
      detail: expected === actual ? '' : detail,
    });
  };

  for (const run of selected) {
    const status = String(run.status ?? '').toLowerCase();
    const group = runStatusGroup(status);
    /*
     * THE BUCKET IS DERIVED FROM THE GROUP, and there is only ONE mapping
     * from a run status to a group (`runStatusGroup`). One mapping, one
     * answer: the group decides both the run bucket and whether the cases
     * of the run are counted.
     */
    const key = group === 'inFlight' ? 'inFlight'
      : group === 'verdict'
        ? (status === 'passed' ? 'passed' : 'failed')
        // Everything that did not reach a verdict is INCONCLUSIVE: a
        // cancelled run, a run that could not start, a run the bridge died
        // in the middle of, and a status this module does not know. None
        // of them is a failure and none of them is a pass.
        : (status === 'cancelled' ? 'cancelled'
          : status === 'error' ? 'error'
            : status === 'interrupted' ? 'interrupted' : 'unknown');
    const bucket = key in runBuckets ? key : 'unknown';
    runBuckets[bucket] += 1;
    runRefs[bucket].push({
      kind: 'run',
      id: String(run.id ?? ''),
      uid: String(run.uid ?? ''),
      status,
      seq: Number.isFinite(run.seq) ? run.seq : null,
      createdAt: run.createdAt ?? null,
      gitCommit: run.gitCommit ?? null,
    });

    const summary = run.summary && typeof run.summary === 'object' ? run.summary : null;
    const cases = summary && Array.isArray(summary.cases) ? summary.cases : [];
    if (!summary || !cases.length) casesWithoutSummary += 1;

    /*
     * The cross-run view of THIS run: the identity of every case and the
     * statuses it was seen with. A key that two cases of the SAME run share
     * is AMBIGUOUS -- the stored identity is not enough to tell them apart
     * -- and such a key contributes no verdict, so a case that always fails
     * is never reported as "sometimes fails".
     */
    /** @type {Map<string, {file:string,title:string,statuses:Set<string>,scope:string[],line:number|null}>} */
    const runTestKeys = new Map();
    const ambiguousKeys = new Set();

    /* --- the cases of this run ---------------------------------------- */
    for (const c of cases) {
      if (!c || typeof c !== 'object') continue;
      casesSeen += 1;
      const caseStatus = caseBucket(c.status);
      const attempts = attemptsOfCase(c);
      const attemptStatuses = attempts.map((a) => caseBucket(a && a.status));
      const attemptsCount = Number.isFinite(c.attemptsCount)
        ? c.attemptsCount
        : attempts.length;
      const retryCount = Math.max(0, attemptsCount - 1);
      const identity = identityOfCase(c);

      /** @type {QualityCaseRef} */
      const ref = {
        kind: 'case',
        runId: String(run.id ?? ''),
        runUid: String(run.uid ?? ''),
        runStatus: status,
        title: String(c.title ?? ''),
        file: String(c.file ?? ''),
        scope: identity.scope,
        line: identity.line,
        caseKey: identity.caseKey,
        status: caseStatus,
        attemptsCount,
        duration: Number.isFinite(c.duration) ? c.duration : 0,
        error: String(c.error ?? ''),
        attemptStatuses,
        retryCount,
      };

      /* --- the bucket the case belongs to ------------------------------ */
      if (group !== 'verdict') {
        // A case of a run that did not finish on its own terms is reported,
        // but it is NOT a pass and NOT a failure -- and it does not enter
        // the attempt buckets, the retry metrics or the cross-run view.
        // Those metrics are statements about the quality of the code under
        // test, and a run the operator stopped says nothing about it.
        inconclusiveCases.push(ref);
        inconclusiveAttempts += attemptsCount;
        if (retryCount > 0) inconclusiveRetriedCases += 1;
        continue;
      }

      totalAttempts += attemptsCount;
      retriedAttempts += retryCount;
      if (retryCount > 0) retriedCases += 1;
      for (const s of attemptStatuses) {
        if (s in attemptBuckets) attemptBuckets[s] += 1;
      }

      /* --- the test-level view (across runs) --------------------------- */
      // The identity of the case is recorded for THIS run; the verdicts are
      // counted once per run, after the run's cases have all been seen, so
      // that a key two cases of the same run share can be marked ambiguous
      // instead of being counted twice.
      const tkey = testKeyOf(ref.file, ref.title, identity);
      const seen = runTestKeys.get(tkey);
      if (seen) {
        seen.statuses.add(caseStatus);
        ambiguousKeys.add(tkey);
      } else {
        runTestKeys.set(tkey, {
          file: ref.file,
          title: ref.title,
          scope: identity.scope,
          line: identity.line,
          statuses: new Set([caseStatus]),
        });
      }

      caseBuckets[caseStatus].push(ref);
      if (caseStatus in walkedByStatus) walkedByStatus[caseStatus] += 1;

      /* --- the failure cluster ----------------------------------------- */
      if (caseStatus !== CASE_STATUS.FAILED) continue;
      const signature = normalizeErrorSignature(c.error);
      const ckey = JSON.stringify([classifyFailureKind(signature), signature]);
      let cluster = clusters.get(ckey);
      if (!cluster) {
        cluster = {
          key: ckey,
          signature,
          kind: classifyFailureKind(signature),
          count: 0,
          files: [],
          cases: [],
        };
        clusters.set(ckey, cluster);
      }
      cluster.count += 1;
      cluster.cases.push(ref);
      if (ref.file && !cluster.files.includes(ref.file)) cluster.files.push(ref.file);
    }

    /* --- the cross-run view of THIS run -------------------------------- */
    for (const [tkey, entry] of runTestKeys) {
      let test = tests.get(tkey);
      if (!test) {
        test = {
          key: tkey,
          file: entry.file,
          title: entry.title,
          scope: entry.scope,
          line: entry.line,
          runs: 0,
          statuses: [],
          failedRuns: 0,
          flakyRuns: 0,
          passedRuns: 0,
          flaky: false,
          ambiguous: false,
        };
        tests.set(tkey, test);
      }
      test.runs += 1;
      for (const s of entry.statuses) {
        if (!test.statuses.includes(s)) test.statuses.push(s);
      }
      if (ambiguousKeys.has(tkey)) {
        // Two cases of this run share the identity: the run cannot say
        // which of them it was, so it contributes no verdict.
        test.ambiguous = true;
        continue;
      }
      if (entry.statuses.has(CASE_STATUS.FAILED)) test.failedRuns += 1;
      if (entry.statuses.has(CASE_STATUS.FLAKY)) test.flakyRuns += 1;
      if (entry.statuses.has(CASE_STATUS.PASSED)) test.passedRuns += 1;
    }

    /* --- the bridge's own counters vs. the cases we walked ------------ */
    if (group === 'verdict' && summary) {
      // The counters the bridge reported for this run. They are summed over
      // the runs that reached a verdict, and the sum is compared with the
      // numbers the overview DISPLAYS.
      for (const b of ['passed', 'failed', 'flaky', 'skipped']) {
        const reported = Number(summary[b]);
        if (!Number.isFinite(reported)) continue;
        reportedByBucket[b] += reported;
        reportedBucketSeen[b] = true;
      }
      const reportedExec = Number(summary.executions);
      if (Number.isFinite(reportedExec)) {
        reportedExecutions += reportedExec;
        reportedExecutionsSeen = true;
      }
    }
    if (summary && Array.isArray(summary.cases) && summary.cases.length) {
      const walked = { passed: 0, failed: 0, flaky: 0, skipped: 0, unknown: 0 };
      let walkedAttempts = 0;
      for (const c of summary.cases) {
        if (!c || typeof c !== 'object') continue;
        const b = caseBucket(c.status);
        if (b in walked) walked[b] += 1;
        const attempts = attemptsOfCase(c);
        walkedAttempts += Number.isFinite(c.attemptsCount) ? c.attemptsCount : attempts.length;
      }
      for (const b of ['passed', 'failed', 'flaky', 'skipped']) {
        const reported = Number(summary[b]);
        if (!Number.isFinite(reported)) continue;
        addCheck(
          `run ${run.id}: summary.${b} matches the case list`,
          reported, walked[b],
          `the bridge reported ${reported} ${b} case(s), the case list holds ${walked[b]}`);
      }
      const reportedTotal = Number(summary.total);
      if (Number.isFinite(reportedTotal)) {
        addCheck(
          `run ${run.id}: summary.total matches the case list`,
          reportedTotal, summary.cases.length,
          `the bridge reported total=${reportedTotal}, the case list holds ${summary.cases.length} case(s)`);
      }
      const reportedExec = Number(summary.executions);
      if (Number.isFinite(reportedExec)) {
        addCheck(
          `run ${run.id}: summary.executions matches the attempt list`,
          reportedExec, walkedAttempts,
          `the bridge reported executions=${reportedExec}, the attempt list holds ${walkedAttempts}`);
      }
    }
  }

  /* --- the buckets must add up ---------------------------------------- */
  const bucketSum = CASE_STATUSES.reduce((n, s) => n + caseBuckets[s].length, 0);
  addCheck(
    'every case of a finished run is in exactly one bucket',
    casesSeen - inconclusiveCases.length, bucketSum,
    `${casesSeen - inconclusiveCases.length} case(s) of finished runs, ${bucketSum} bucketed`);

  const attemptSum = Object.values(attemptBuckets).reduce((a, b) => a + b, 0);
  addCheck(
    'the attempt buckets add up to the attempts of the cases',
    totalAttempts, attemptSum,
    `${totalAttempts} attempt(s) counted on the cases, ${attemptSum} in the attempt buckets`);

  const clusteredCases = [...clusters.values()].reduce((n, c) => n + c.cases.length, 0);
  addCheck(
    'every failed case is in exactly one cluster',
    caseBuckets[CASE_STATUS.FAILED].length, clusteredCases,
    `${caseBuckets[CASE_STATUS.FAILED].length} failed case(s), ${clusteredCases} clustered`);

  for (const s of CASE_STATUSES) {
    // The bucket must hold exactly the cases of that status that were
    // walked. Both numbers come from the same walk of the raw case list of
    // the run, so this catches a bucket that lost or duplicated a case.
    const walkedInBucket = walkedByStatus[s] ?? 0;
    addCheck(
      `the ${s} bucket count matches the cases of that status`,
      walkedInBucket, caseBuckets[s].length,
      `the raw case list holds ${walkedInBucket} ${s} case(s), the bucket holds ${caseBuckets[s].length}`);
  }

  const runBucketSum = Object.values(runBuckets).reduce((a, b) => a + b, 0);
  addCheck(
    'every run is in exactly one run bucket',
    selected.length, runBucketSum,
    `${selected.length} run(s), ${runBucketSum} bucketed`);

  /*
   * THE DISPLAYED METRICS AGAINST THE COUNTERS THE BRIDGE REPORTED.
   *
   * The checks above compare the bridge's counters with the bridge's own
   * case list, and the buckets with the walk of that same list. None of
   * them compares the number the interface SHOWS with the number the
   * bridge reported -- so a module that buckets a case wrongly would be
   * confirmed by all of them. These checks close that gap: the expected
   * side is what the bridge reported, the actual side is what the
   * overview displays.
   */
  for (const b of ['passed', 'failed', 'flaky', 'skipped']) {
    if (!reportedBucketSeen[b]) continue;
    addCheck(
      `the displayed ${b} count matches the counters the bridge reported`,
      reportedByBucket[b], caseBuckets[b].length,
      `the bridge reported ${reportedByBucket[b]} ${b} case(s) over the finished runs, `
      + `the overview displays ${caseBuckets[b].length}`);
  }
  if (reportedExecutionsSeen) {
    addCheck(
      'the displayed attempt count matches the executions the bridge reported',
      reportedExecutions, totalAttempts,
      `the bridge reported ${reportedExecutions} execution(s) over the finished runs, `
      + `the overview displays ${totalAttempts} attempt(s)`);
  }

  /* --- the cross-run flakiness ----------------------------------------- */
  const testList = [...tests.values()];
  for (const t of testList) {
    // A test is flaky when it needed a retry in some run, or when it
    // failed in one run and passed in another: both are "it is not
    // reliable", and they are different facts, so both are reported.
    //
    // An AMBIGUOUS test is never flaky: two cases of one run share its
    // identity, so the run cannot say which of them it was, and calling it
    // unreliable would be a claim the data does not support.
    t.flaky = !t.ambiguous
      && (t.flakyRuns > 0 || (t.failedRuns > 0 && t.passedRuns > 0));
  }
  const flakyTests = testList.filter((t) => t.flaky);
  const ambiguousTests = testList.filter((t) => t.ambiguous);

  /* --- the verdict counts ---------------------------------------------- */
  const verdictCases = bucketSum;
  const flakyRate = verdictCases ? caseBuckets[CASE_STATUS.FLAKY].length / verdictCases : 0;
  const flakyTestRate = testList.length ? flakyTests.length / testList.length : 0;

  const sortedClusters = [...clusters.values()].sort(
    (a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const failedFiles = new Map();
  for (const c of caseBuckets[CASE_STATUS.FAILED]) {
    const f = c.file || '(unknown file)';
    failedFiles.set(f, (failedFiles.get(f) ?? 0) + 1);
  }

  return {
    /* --- the run level -------------------------------------------- */
    runs: {
      total: selected.length,
      ...runBuckets,
      // The runs that carry a verdict: the denominator of the run-level
      // pass rate. A cancelled run is NOT in it.
      verdict: runBuckets.passed + runBuckets.failed,
      // The runs that did not finish on their own terms -- the cancelled,
      // the errored, the interrupted ones and the ones whose status this
      // module does not know.
      inconclusive: runBuckets.cancelled + runBuckets.error
        + runBuckets.interrupted + runBuckets.unknown,
      passRate: (runBuckets.passed + runBuckets.failed)
        ? runBuckets.passed / (runBuckets.passed + runBuckets.failed)
        : 0,
      refs: runRefs,
      runsWithoutSummary: casesWithoutSummary,
    },

    /* --- the case level -------------------------------------------- */
    cases: {
      total: casesSeen,
      // The cases of runs that finished: the ones the metrics count.
      counted: verdictCases,
      passed: caseBuckets[CASE_STATUS.PASSED].length,
      failed: caseBuckets[CASE_STATUS.FAILED].length,
      flaky: caseBuckets[CASE_STATUS.FLAKY].length,
      skipped: caseBuckets[CASE_STATUS.SKIPPED].length,
      unknown: caseBuckets[CASE_STATUS.UNKNOWN].length,
      // The cases of runs that were cancelled / errored / interrupted.
      inconclusive: inconclusiveCases.length,
      // The RETRY metrics: how many cases needed more than one attempt.
      // Only the cases of the runs that reached a verdict are counted: a
      // cancelled run's retries are not evidence about the code.
      retried: retriedCases,
      attempts: totalAttempts,
      retries: retriedAttempts,
      flakyRate,
      buckets: caseBuckets,
      inconclusiveRefs: inconclusiveCases,
      // The attempts of the runs without a verdict, reported apart.
      inconclusiveAttempts,
      inconclusiveRetried: inconclusiveRetriedCases,
    },

    /* --- the attempt level ------------------------------------------ */
    attempts: {
      total: totalAttempts,
      ...attemptBuckets,
      retries: retriedAttempts,
      inconclusive: inconclusiveAttempts,
    },

    /* --- the failure clusters (失败聚类) ---------------------------- */
    clusters: sortedClusters,
    files: [...failedFiles.entries()]
      .map(([file, failed]) => ({ file, failed }))
      .sort((a, b) => b.failed - a.failed || a.file.localeCompare(b.file)),

    /* --- the cross-run flakiness ------------------------------------ */
    tests: {
      total: testList.length,
      flaky: flakyTests.length,
      ambiguous: ambiguousTests.length,
      flakyRate: flakyTestRate,
      list: testList.sort((a, b) => (Number(b.flaky) - Number(a.flaky))
        || Number(b.ambiguous) - Number(a.ambiguous)
        || b.failedRuns - a.failedRuns
        || a.title.localeCompare(b.title)),
    },

    /* --- the reconciliation ----------------------------------------- */
    reconciliation: {
      consistent: checks.every((c) => c.ok),
      checks,
    },
  };
}

/**
 * The metric cards of the quality overview, with the raw items behind
 * every number.
 *
 * BOTH interfaces render THESE cards, so the two of them cannot show
 * different numbers, and every card carries the references a reader needs
 * to check the number against the raw result: the cases of the bucket (or
 * the runs of the bucket, for the run-level card).
 *
 * @param {QualityOverview} overview
 * @returns {QualityMetricCard[]}
 */
export function qualityMetricCards(overview) {
  const o = overview || {};
  const c = o.cases || {};
  const r = o.runs || {};
  const buckets = c.buckets || {};
  const refs = r.refs || {};
  const flakyRefs = buckets.flaky || [];
  // The retries of the retried CASES: the count the card shows is the
  // number of retries those cases needed, not the number of retries of
  // every case of the run -- a case that finally failed is not a "retry
  // that passed".
  const flakyRetries = flakyRefs.reduce((n, x) => n + (Number(x.retryCount) || 0), 0);
  const inconclusiveRuns = [
    ...(refs.cancelled || []),
    ...(refs.error || []),
    ...(refs.interrupted || []),
    ...(refs.unknown || []),
  ];
  return [
    {
      key: 'passed',
      label: '通过',
      value: c.passed ?? 0,
      subtitle: '用例级 · 不含重试',
      caseRefs: buckets.passed || [],
      runRefs: [],
      refs: buckets.passed || [],
    },
    {
      key: 'failed',
      label: '失败',
      value: c.failed ?? 0,
      subtitle: '用例级 · 可核对原始结果',
      caseRefs: buckets.failed || [],
      runRefs: [],
      refs: buckets.failed || [],
    },
    {
      key: 'flaky',
      label: '重试后通过',
      value: c.flaky ?? 0,
      subtitle: `用例级 · ${flakyRetries} 次重试`,
      caseRefs: flakyRefs,
      runRefs: [],
      refs: flakyRefs,
    },
    {
      key: 'inconclusive',
      label: '未出结论',
      value: inconclusiveRuns.length,
      subtitle: '运行级 · 已取消/中断/启动失败 · 不计入失败',
      caseRefs: [],
      runRefs: inconclusiveRuns,
      refs: inconclusiveRuns,
    },
  ];
}

/**
 * A one-line, human-readable summary of the overview.
 *
 * It is used by the portable UI and by the console output of the probes.
 *
 * @param {QualityOverview} overview
 * @returns {string}
 */
export function summarizeOverview(overview) {
  if (!overview) return '(no overview)';
  const r = overview.runs || {};
  const c = overview.cases || {};
  const t = overview.tests || {};
  return [
    `runs ${r.passed ?? 0} passed / ${r.failed ?? 0} failed / ${r.cancelled ?? 0} cancelled`
    + ` / ${r.error ?? 0} error / ${r.interrupted ?? 0} interrupted / ${r.inFlight ?? 0} in flight`,
    `cases ${c.passed ?? 0} passed / ${c.failed ?? 0} failed / ${c.flaky ?? 0} flaky`
    + ` / ${c.skipped ?? 0} skipped / ${c.unknown ?? 0} unknown`
    + ` / ${c.inconclusive ?? 0} inconclusive`,
    `attempts ${c.attempts ?? 0} (${c.retries ?? 0} retries over ${c.retried ?? 0} retried case(s))`,
    `tests ${t.flaky ?? 0} flaky of ${t.total ?? 0}`,
    `clusters ${(overview.clusters || []).length}`,
    `reconciliation ${overview.reconciliation?.consistent ? 'OK' : 'MISMATCH'}`,
  ].join(' | ');
}
