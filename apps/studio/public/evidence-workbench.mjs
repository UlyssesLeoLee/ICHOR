/**
 * ATS-215 -- the EVIDENCE WORKBENCH module (证据工作台模块).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The acceptance criterion of this task is one sentence:
 *
 *   「从失败用例 2 次点击内找到 Trace；显示附件哈希与时间」
 *
 *   ("find the Trace from a failing case within 2 clicks; show the
 *    attachment's hash and time")
 *
 * That sentence has three requirements, and each of them is a requirement
 * about HONESTY rather than about layout:
 *
 *   1. THE TRACE MUST BE REACHABLE FROM THE FAILING CASE.
 *      A reader who is looking at a failure must be able to get to that
 *      case's trace WITHOUT hunting. The engine writes the trace into a
 *      per-case directory whose name is derived from the case title, so
 *      the mapping from a case to its trace is a DERIVATION, not a guess:
 *      the locating module performs that derivation and SAYS so when it
 *      cannot.
 *
 *      The derivation is NEVER allowed to silently invent a trace. A case
 *      whose trace cannot be located is reported as "not located", with the
 *      reason. A workbench that shows a plausible-looking trace path for a
 *      case that has none is worse than one that shows nothing.
 *
 *   2. THE HASH AND THE TIME MUST BE THE ARCHIVED ONES.
 *      The digest of an attachment is the digest the MANIFEST recorded when
 *      the run was archived (ATS-209), and the time is the file's own
 *      modification time as recorded on disk. Both are facts about the
 *      archived bytes. The module NEVER recomputes a digest from a
 *      possibly-changed file and presents it as the archived one: the
 *      manifest's digest is the archived truth, and a mismatch between the
 *      manifest and the file on disk is REPORTED (that is ATS-209's tamper
 *      detection, and this module must not hide it).
 *
 *   3. "执行前后对照" (a before/after comparison of executions) must compare
 *      THINGS THAT ACTUALLY HAPPENED.
 *      Two runs of the same case can be compared side by side, and the
 *      comparison is only meaningful if both sides carry their own status,
 *      their own duration and their own evidence. A run that has no
 *      evidence cannot be compared on evidence, and the module says so
 *      instead of showing an empty cell that reads like "no difference".
 *
 * WHY THE FILE LIVES IN `public/`
 * ------------------------------
 * There are TWO user interfaces in this repository: the Next.js workbench
 * (`apps/studio/app/page.tsx`) and the zero-dependency portable UI
 * (`apps/studio/public/fallback.html`). Both show evidence.
 *
 * The Bridge serves static files from `apps/studio/out` and
 * `apps/studio/public` (`server/index.mjs` -> `staticFile()`), so a module
 * under `public/` is reachable by the portable UI at a stable URL. Putting
 * the ONE implementation here therefore means the two interfaces cannot
 * drift apart. This follows ATS-216's precedent exactly.
 *
 * The module is PLAIN ECMASCRIPT MODULE with JSDoc types, so it is
 *   * importable by the Next app (TypeScript reads the JSDoc),
 *   * importable by Node's test runner (`node --test`),
 *   * importable by the portable UI in the browser (ES modules),
 * without a build step of its own.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It does NOT open a trace. The Playwright Trace Viewer is a separate
 * application (`npx playwright show-trace`), and its VERSION is the
 * engine's version -- this module's job is to make the trace file
 * reachable and to say which engine version produced it, so that a reader
 * who opens it knows whether their viewer matches. The version
 * compatibility itself is a property of the engine, not of this module.
 */

import {
  buildEvidenceIndex,
  locateCaseEvidence,
  caseOutputDir,
} from './evidence-workbench-index.mjs';

import {
  ATTACHMENT_KINDS,
  ATTACHMENT_PRIORITY,
  KIND_LABEL,
  attachmentKind,
  attachmentRank,
  kindLabel,
} from './evidence-workbench-vocabulary.mjs';

export {
  ATTACHMENT_KINDS,
  ATTACHMENT_PRIORITY,
  KIND_LABEL,
  attachmentKind,
  attachmentRank,
  kindLabel,
  buildEvidenceIndex,
  locateCaseEvidence,
  caseOutputDir,
};

/* ------------------------------------------------------------------ */
/* The types                                                           */
/* ------------------------------------------------------------------ */

/**
 * One attachment of a run: a file of the run folder with the digest the
 * manifest recorded when the run was archived, and the file's own
 * modification time.
 *
 * @typedef {object} WorkbenchAttachment
 * @property {string} file      the path relative to the run folder
 * @property {number|null} size the size in bytes
 * @property {string|null} sha256 the ARCHIVED digest
 * @property {string|null} modifiedAt the ISO timestamp of the file
 * @property {string} kind      the kind of the attachment
 */

/**
 * One attachment as the engine named it.
 *
 * @typedef {object} WorkbenchNamedAttachment
 * @property {string} name
 * @property {string} contentType
 * @property {string} file      the path relative to the run folder
 */

/**
 * One case of a run, with the attachments the engine recorded for it.
 *
 * @typedef {object} WorkbenchCase
 * @property {string} title
 * @property {string} file
 * @property {number|null} line
 * @property {string} status
 * @property {number|null} duration
 * @property {string} error
 * @property {number|null} attemptsCount
 * @property {string[]} scope
 * @property {string|null} caseKey
 * @property {WorkbenchNamedAttachment[]} attachments
 */

/**
 * The ATS-209 verification of the archive.
 *
 * @typedef {object} WorkbenchVerification
 * @property {boolean} verified
 * @property {boolean} ok
 * @property {number} checked
 * @property {string[]} missing
 * @property {{file:string,expected:string,actual:string}[]} changed
 * @property {string|null} reason
 */

/**
 * One step of the click path.
 *
 * @typedef {object} WorkbenchClickStep
 * @property {string} action
 * @property {string} label
 */

/**
 * The click path from the failure list to a case's trace.
 *
 * @typedef {object} WorkbenchClickPath
 * @property {WorkbenchClickStep[]} steps
 * @property {number} clicks
 * @property {number} budget
 * @property {boolean} withinBudget
 */

/**
 * One failing case of the workbench, with the trace that was located.
 *
 * @typedef {object} WorkbenchFailure
 * @property {string} title
 * @property {string} file
 * @property {number|null} line
 * @property {string} status
 * @property {string} error
 * @property {number|null} duration
 * @property {number|null} attemptsCount
 * @property {WorkbenchAttachment|null} trace
 * @property {boolean} traceLocated
 * @property {string} traceSource
 * @property {string} traceReason
 * @property {WorkbenchAttachment[]} attachments
 * @property {WorkbenchClickPath} clickPath
 */

/**
 * The workbench view of one run.
 *
 * @typedef {object} WorkbenchView
 * @property {string|null} runId
 * @property {string|null} runUid
 * @property {string|null} runStatus
 * @property {string|null} gitCommit
 * @property {string|null} runner
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {string|null} engineVersion
 * @property {number} failureCount
 * @property {WorkbenchFailure[]} failures
 * @property {WorkbenchAttachment[]} attachments
 * @property {{count:number,bytes:number,failures:number,locatedTraces:number}} totals
 * @property {WorkbenchVerification|null} verification
 * @property {number} clickBudget
 */

/* ------------------------------------------------------------------ */
/* The click budget                                                    */
/* ------------------------------------------------------------------ */

/**
 * The clicks the acceptance criterion allows: 「2 次点击内找到 Trace」.
 *
 * The budget is COUNTED, not asserted. `clickPath` is the sequence of
 * user actions that takes the reader from the failure list to the trace
 * of a case, and the module reports how long it is. A reader can then
 * see the budget being met rather than being told it was.
 *
 * The two clicks of the criterion are:
 *
 *   1. click the FAILING CASE in the failure list;
 *   2. click the TRACE of that case.
 *
 * That is the shortest honest path, and it is what the workbench's
 * layout implements: the failure list is on the screen of the evidence
 * workbench, and the trace button of the selected case is on the same
 * screen. Nothing needs to be navigated to first.
 */
export const TRACE_CLICK_BUDGET = 2;

/**
 * The click path from a failure list to a case's trace.
 *
 * The path is returned as DATA (the list of actions), so a test can count
 * it and a UI can render it. The count is `TRACE_CLICK_BUDGET` when the
 * trace was located.
 *
 * @param {object} options
 * @param {boolean} options.located whether the case's trace was located
 * @param {string} [options.reason] why the trace was not located
 * @returns {{steps:{action:string,label:string}[],clicks:number,budget:number,withinBudget:boolean}}
 */
export function clickPath({ located, reason } = {}) {
  const steps = located
    ? [
      { action: 'select-case', label: '点击失败用例' },
      { action: 'open-trace', label: '点击该用例的 Trace' },
    ]
    : [
      { action: 'select-case', label: '点击失败用例' },
      { action: 'open-trace', label: `无法打开 Trace：${reason ?? '未定位到 Trace'}` },
    ];
  return {
    steps,
    clicks: steps.length,
    budget: TRACE_CLICK_BUDGET,
    withinBudget: located && steps.length <= TRACE_CLICK_BUDGET,
  };
}

/* ------------------------------------------------------------------ */
/* The workbench view                                                  */
/* ------------------------------------------------------------------ */

/**
 * Build the workbench view of one run: the failure list, the located
 * traces and the attachments, with their hashes and times.
 *
 * @param {object} run the run record (as the bridge returns it)
 * @param {object[]} [artifacts] the artifacts, with their archived digest
 *   and size. When omitted, `run.artifacts` is used.
 * @param {object[]} [cases] the cases of the run, with their attempts
 * @param {object} [options]
 * @param {string} [options.engineVersion] the engine version that produced
 *   the run. It travels with the trace because the Trace Viewer is a
 *   separate program whose version must match the one that wrote the file.
 * @param {WorkbenchVerification} [options.verification] the ATS-209
 *   verification result
 * @returns {WorkbenchView} the view
 */
export function buildWorkbench(run, artifacts, cases, options = {}) {
  const index = buildEvidenceIndex({ run, artifacts, cases, ...options });
  const failures = index.failures ?? [];
  return {
    runId: index.runId,
    runUid: index.runUid,
    runStatus: index.runStatus,
    gitCommit: index.gitCommit,
    runner: index.runner,
    startedAt: index.startedAt,
    finishedAt: index.finishedAt,
    engineVersion: index.engineVersion ?? null,
    failureCount: failures.length,
    // Every failure carries the CLICK PATH that reaches its trace, so the
    // budget is a number the interface can show, not a claim in a
    // document.
    failures: failures.map((f) => ({
      ...f,
      clickPath: clickPath({ located: f.traceLocated, reason: f.traceReason }),
    })),
    attachments: index.attachments ?? [],
    totals: index.totals ?? { count: 0, bytes: 0, failures: 0, locatedTraces: 0 },
    verification: index.verification ?? null,
    clickBudget: TRACE_CLICK_BUDGET,
  };
}

/* ------------------------------------------------------------------ */
/* The before/after comparison                                         */
/* ------------------------------------------------------------------ */

/**
 * Compare two runs of the SAME case.
 *
 * The comparison is about what ACTUALLY HAPPENED, so each side carries:
 * the status, the duration, the commit the run was made from and the
 * trace that was located. A side that has no evidence carries
 * `trace: null` and the comparison says so -- an empty cell must not read
 * like "no difference".
 *
 * @param {object} before the earlier run
 * @param {object} after the later run
 * @param {object} [options]
 * @param {object[]} [options.artifactsBefore] the artifacts of the earlier run
 * @param {object[]} [options.artifactsAfter] the artifacts of the later run
 * @returns {object} the comparison
 */
export function compareRuns(before, after, options = {}) {
  const rows = [];
  const beforeCases = casesOf(before);
  const afterCases = casesOf(after);
  const keys = new Set([
    ...beforeCases.map((c) => caseIdentity(c)),
    ...afterCases.map((c) => caseIdentity(c)),
  ]);
  for (const key of keys) {
    const a = beforeCases.find((c) => caseIdentity(c) === key) ?? null;
    const b = afterCases.find((c) => caseIdentity(c) === key) ?? null;
    rows.push(compareCase(a, b, {
      ...options,
      artifacts: options.artifactsBefore,
      artifactsAfter: options.artifactsAfter,
    }));
  }
  return {
    runIds: { before: before?.id ?? null, after: after?.id ?? null },
    commits: { before: before?.gitCommit ?? null, after: after?.gitCommit ?? null },
    rows,
    // The comparison is only meaningful when the two runs were made from
    // the SAME commit: a status change caused by a code change is not the
    // same thing as a status change caused by a flaky test. The fact is
    // reported, and it is NOT smoothed away.
    sameCommit: Boolean(before?.gitCommit && after?.gitCommit
      && before.gitCommit === after.gitCommit),
    comparable: Boolean(before?.gitCommit && after?.gitCommit
      && before.gitCommit === after.gitCommit),
  };
}

/**
 * The cases of a run.
 *
 * The bridge stores them under `summary.cases`; a caller may hand over
 * the list directly. Both are accepted, because the comparison is made
 * from the run record the API returns.
 *
 * @param {object} r a run record
 * @returns {object[]}
 */
function casesOf(r) {
  if (Array.isArray(r?.cases)) return r.cases;
  if (Array.isArray(r?.summary?.cases)) return r.summary.cases;
  return [];
}

/**
 * The identity of a case: its file, its describe path, its title and its
 * line -- the same four facts the execution model uses (ATS-208/ATS-204).
 *
 * @param {object} c a case
 * @returns {string}
 */
export function caseIdentity(c) {
  if (!c) return '';
  if (typeof c.caseKey === 'string' && c.caseKey) return c.caseKey;
  const scope = Array.isArray(c.scope) ? c.scope.join(' ') : '';
  return `${c.file ?? ''} ${scope} ${c.title ?? ''} ${c.line ?? ''}`.trim();
}

/**
 * Compare ONE case across two runs.
 *
 * @param {object} before the case of the earlier run (or null)
 * @param {object} after the case of the later run (or null)
 * @param {object} [options]
 * @param {object[]} [options.artifacts] the artifacts of the earlier run
 * @param {object[]} [options.artifactsAfter] the artifacts of the later run
 * @returns {object} the row
 */
export function compareCase(before, after, options = {}) {
  const beforeTrace = before
    ? locateCaseEvidence(before, { artifacts: options.artifacts ?? [] })
    : { located: false, reason: '该运行没有这个用例', trace: null };
  const afterTrace = after
    ? locateCaseEvidence(after, { artifacts: options.artifactsAfter ?? options.artifacts ?? [] })
    : { located: false, reason: '该运行没有这个用例', trace: null };
  const statusBefore = before?.status ?? null;
  const statusAfter = after?.status ?? null;
  return {
    key: caseIdentity(after ?? before),
    title: after?.title ?? before?.title ?? '',
    file: after?.file ?? before?.file ?? '',
    status: { before: statusBefore, after: statusAfter },
    changed: statusBefore !== statusAfter,
    duration: { before: before?.duration ?? null, after: after?.duration ?? null },
    attempts: {
      before: before?.attemptsCount ?? null,
      after: after?.attemptsCount ?? null,
    },
    trace: {
      before: beforeTrace.located ? beforeTrace.trace : null,
      after: afterTrace.located ? afterTrace.trace : null,
    },
    // The verdict of the comparison, stated plainly:
    //   'fixed'     -- it failed before and passes now
    //   'broken'    -- it passed before and fails now
    //   'same'      -- the status did not change
    //   'changed'   -- the status changed in another way
    //   'unknown'   -- a status was not reported by the engine
    verdict: verdictOf(statusBefore, statusAfter),
    // The comparison is only conclusive when both sides carry a status.
    // A side without a status is NOT folded into "same".
    conclusive: statusBefore !== null && statusAfter !== null,
  };
}

/**
 * The verdict of a status change.
 *
 * @param {string|null} before
 * @param {string|null} after
 * @returns {string}
 */
export function verdictOf(before, after) {
  if (before === null || after === null) return 'unknown';
  if (before === 'failed' && after !== 'failed') return 'fixed';
  if (before !== 'failed' && after === 'failed') return 'broken';
  if (before === after) return 'same';
  return 'changed';
}

/* ------------------------------------------------------------------ */
/* The formatting helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * The short form of a digest, for a table cell.
 *
 * The FULL digest is always available next to it: a shortened digest that
 * is shown alone cannot be checked against the manifest, so the short form
 * is a display convenience, never the value itself.
 *
 * @param {string|null} sha256
 * @returns {string}
 */
export function shortDigest(sha256) {
  const digest = String(sha256 ?? '');
  if (!digest) return '—';
  return digest.length <= 12 ? digest : `${digest.slice(0, 12)}…`;
}

/**
 * The human-readable size of an attachment.
 *
 * @param {number|null} size the size in bytes
 * @returns {string}
 */
export function formatBytes(size) {
  if (size === null || size === undefined) return '—';
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The human-readable time of an attachment.
 *
 * @param {string|null} iso the ISO timestamp
 * @returns {string}
 */
export function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}
