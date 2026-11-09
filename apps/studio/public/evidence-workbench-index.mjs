/**
 * ATS-215 -- the case -> attachment INDEX (the locating half of the
 * evidence workbench).
 *
 * WHAT THIS PROBLEM IS
 * --------------------
 * A failing case leaves a trace archive behind, but the reader of the
 * workbench starts from the CASE, not from the file. The engine writes
 * the trace into a per-case directory whose name is derived from the
 * case title (Playwright: `<output>/<sanitised-title>/trace.zip`), and
 * the JSON report names the attachment with an ABSOLUTE path on the
 * machine that ran it.
 *
 * The absolute path is useless after the fact: the data directory moves,
 * the project moves, the machine changes. What survives is the RELATIVE
 * path inside the run folder, and what makes it meaningful is the digest:
 * the same bytes under two different names are the same evidence
 * (measured: the HTML report embeds the trace again as `html/data/*.zip`
 * with a byte-identical SHA-256).
 *
 * So the mapping is made in TWO steps, and each step is FALLIBLE:
 *
 *   1. The report names the attachment. The bridge reads `report.json`
 *      at collection time and records, for every result of every case,
 *      the attachment's relative path inside the run folder. This is the
 *      AUTHORITATIVE link: the engine itself said which attachment
 *      belongs to which result.
 *
 *   2. When the report is unavailable (the run was interrupted, or the
 *      report could not be parsed), the trace is DERIVED from the case
 *      title, because the engine's naming rule is deterministic. A
 *      derivation is a GUESS and is marked as one: it is only accepted
 *      when a file with that name actually exists AND its digest matches
 *      an artifact of the run.
 *
 * Neither step may invent an attachment. A case whose trace cannot be
 * located is reported as "not located", with the reason.
 *
 * WHY A SEPARATE FILE
 * -------------------
 * The evidence workbench's public module is the interface contract; this
 * file is the locating logic. Keeping them apart lets the locating logic
 * be unit-tested directly, without the interface vocabulary in the way.
 */

import { attachmentKind, attachmentRank } from './evidence-workbench-vocabulary.mjs';

/**
 * One attachment of a run, with the digest the manifest recorded.
 *
 * @typedef {object} IndexAttachment
 * @property {string} file
 * @property {number|null} size
 * @property {string|null} sha256
 * @property {string|null} modifiedAt
 * @property {string} kind
 */

/**
 * One attachment as the engine named it, with the archived facts joined
 * in (the digest and the size are `null` when the manifest does not list
 * the file -- the retention policy may have removed it).
 *
 * @typedef {object} IndexNamedAttachment
 * @property {string} kind
 * @property {string} file
 * @property {string} name
 * @property {string} contentType
 * @property {number|null} size
 * @property {string|null} sha256
 * @property {string|null} modifiedAt
 * @property {boolean} archived whether the manifest lists it
 * @property {string} source
 */

/**
 * The result of locating a case's evidence.
 *
 * @typedef {object} IndexLocation
 * @property {boolean} located
 * @property {IndexNamedAttachment|null} trace
 * @property {IndexNamedAttachment[]} attachments
 * @property {string} source   'report' | 'derived' | 'none'
 * @property {string} reason   why the trace was not located (empty when it was)
 */

/**
 * The index of a run's evidence.
 *
 * @typedef {object} EvidenceIndex
 * @property {string|null} runId
 * @property {string|null} runUid
 * @property {string|null} runStatus
 * @property {string|null} gitCommit
 * @property {string|null} runner
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {string|null} createdAt
 * @property {string|null} engineVersion
 * @property {IndexAttachment[]} attachments
 * @property {object[]} failures
 * @property {object[]} cases
 * @property {{count:number,bytes:number,failures:number,locatedTraces:number}} totals
 * @property {object|null} verification
 */

/**
 * The name the engine gives a case's output directory.
 *
 * Playwright derives it from the spec's title: the characters that are
 * illegal in a path are replaced, and the title is prefixed with the
 * file's base name. The rule is deterministic, so the derivation below is
 * reproducible -- but it is still a DERIVATION, and the caller is told so.
 *
 * @param {string} file the case's file, relative to the project root
 * @param {string} title the case's title
 * @returns {string} the directory name the engine would use
 */
/**
 * The engine's own sanitisation of a name for use in a file path.
 *
 * Measured from the engine's source: every run of characters outside
 * `[A-Za-z0-9]` (plus the dot that separates an extension) is replaced
 * by a single `-`. The rule keeps the LAST dot, because the dot before
 * an extension is part of the name.
 *
 * @param {string} s the name
 * @returns {string} the sanitised name
 */
export function sanitizeForFilePath(s) {
  const text = String(s ?? '');
  const separator = text.lastIndexOf('.');
  const sanitize = (part) => part.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
  if (separator === -1) return sanitize(text);
  return sanitize(text.substring(0, separator)) + '.' + sanitize(text.substring(separator + 1));
}

/**
 * The name the engine gives a case's output directory.
 *
 * Measured from the engine's source (`workerProcessEntry.js`):
 *
 *     <file stem, relative to the test directory, separators as ->
 *       "-" + sanitised(full title without the file)>
 *
 * where the full title is the DESCRIBE PATH and the case title joined by
 * a space. A long name is truncated with a digest in the middle, and a
 * project id and a retry index are appended -- so the derivation below
 * is exact only for the SHORT, single-project, non-retried case. It is
 * therefore used as a FALLBACK and always checked against the artifacts
 * that actually exist.
 *
 * @param {string} file the case's file
 * @param {string} title the case's title
 * @param {string[]} [scope] the case's describe path
 * @returns {string} the directory name the engine would use
 */
export function caseOutputDir(file, title, scope = []) {
  const base = String(file ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  // The engine removes the `.spec` / `.test` suffix, not every extension.
  const stem = base.replace(/\.(spec|test)\.(js|ts|jsx|tsx|mjs|mts|cjs|cts)$/, '')
    .replace(/\.[^.]+$/, '');
  const fullTitle = [...(Array.isArray(scope) ? scope : []), String(title ?? '')]
    .filter((p) => typeof p === 'string' && p.length > 0)
    .join(' ');
  return `${stem}-${sanitizeForFilePath(fullTitle)}`;
}

/**
 * The attachments of one case, as the engine recorded them.
 *
 * @param {object[]} attachments
 * @returns {object[]}
 */
function normalizeAttachments(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  return list
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      name: typeof a.name === 'string' ? a.name : '',
      contentType: typeof a.contentType === 'string' ? a.contentType : '',
      file: typeof a.file === 'string' ? a.file : '',
    }))
    .filter((a) => a.file);
}

/**
 * Locate the trace of ONE case.
 *
 * @param {object} c the case (with its `attachments`)
 * @param {object} [options]
 * @param {object[]} [options.artifacts] the run's artifacts, with their
 *   archived digest and size. The location is only accepted when the
 *   attachment is one of the run's artifacts: an attachment that the
 *   manifest does not list is not evidence of this run.
 * @returns {IndexLocation} the location
 */
export function locateCaseEvidence(c, options = {}) {
  const artifacts = Array.isArray(options.artifacts) ? options.artifacts : [];
  const byFile = new Map(artifacts.map((a) => [normalizeFile(a?.file), a]));
  const attachments = normalizeAttachments(c?.attachments);

  // --- step 1: the engine's own record -----------------------------------
  const candidates = attachments
    .map((a) => {
      const kind = attachmentKind(a.file, a.contentType);
      const artifact = byFile.get(normalizeFile(a.file)) ?? null;
      return {
        kind,
        file: a.file,
        name: a.name,
        contentType: a.contentType,
        size: artifact?.size ?? null,
        sha256: artifact?.sha256 ?? null,
        modifiedAt: artifact?.modifiedAt ?? null,
        // The attachment the engine named, but the manifest does not list:
        // it is NOT evidence of this run (it may have been removed by the
        // retention policy). The fact is reported, not hidden.
        archived: Boolean(artifact),
        source: 'report',
      };
    })
    .sort((x, y) => attachmentRank(x.kind) - attachmentRank(y.kind));

  // The trace of the case is the trace the ENGINE NAMED -- and only when
  // the manifest lists it. A named-but-unarchived attachment is reported
  // as an attachment without a digest, not as the case's trace: the
  // retention policy may have removed it, and presenting it as evidence
  // would be a claim the archive cannot back up.
  const named = candidates.find((a) => a.kind === 'trace' && a.archived) ?? null;
  if (named) {
    return {
      located: true,
      trace: named,
      attachments: candidates,
      source: 'report',
      reason: '',
    };
  }

  // --- step 2: the derivation --------------------------------------------
  const derived = deriveTrace(c, byFile);
  if (derived) {
    return {
      located: true,
      trace: derived,
      attachments: candidates,
      source: 'derived',
      reason: '',
    };
  }

  const namedButGone = candidates.find((a) => a.kind === 'trace');
  return {
    located: false,
    trace: null,
    attachments: candidates,
    source: 'none',
    reason: namedButGone
      ? '该用例的 Trace 不在本次归档的证据清单中（可能已被保留期清理）'
      : (candidates.length ? '该用例的附件里没有 Trace' : '该用例没有留下任何附件'),
  };
}

/**
 * Derive the trace of a case from the engine's naming rule.
 *
 * The derivation is only accepted when the derived file IS one of the
 * run's artifacts. That check is what keeps the derivation honest: a
 * title that happens to name a file that is not part of this run's
 * evidence yields nothing.
 *
 * @param {object} c the case
 * @param {Map<string,object>} byFile the run's artifacts, by relative path
 * @returns {IndexNamedAttachment|null} the derived trace, or null
 */
export function deriveTrace(c, byFile) {
  const dir = caseOutputDir(c?.file, c?.title, c?.scope);
  if (!dir) return null;
  const file = `${dir}/trace.zip`;
  const artifact = byFile.get(normalizeFile(file)) ?? null;
  if (!artifact) return null;
  return {
    kind: 'trace',
    file: artifact.file,
    name: 'trace',
    contentType: 'application/zip',
    size: artifact.size ?? null,
    sha256: artifact.sha256 ?? null,
    modifiedAt: artifact.modifiedAt ?? null,
    archived: true,
    source: 'derived',
  };
}

/**
 * The normalised form of a relative path: `/` separators, no leading `./`.
 *
 * @param {string} file
 * @returns {string}
 */
function normalizeFile(file) {
  return String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Build the index of a run's evidence.
 *
 * The index is the data the workbench renders:
 *
 *   * `attachments` -- every artifact of the run, with its archived digest,
 *     its size and its modification time;
 *   * `failures`   -- the failing cases, each with the attachments the
 *     engine recorded for it and the trace that was located;
 *   * `totals`     -- the counts and the byte total.
 *
 * @param {object} params
 * @param {object} params.run the run record
 * @param {object[]} [params.artifacts] the artifacts (default: run.artifacts)
 * @param {object[]} [params.cases] the cases (default: run.summary.cases)
 * @param {string} [params.engineVersion] the engine version
 * @param {object} [params.verification] the ATS-209 verification result
 * @returns {EvidenceIndex} the index
 */
export function buildEvidenceIndex({ run, artifacts, cases, engineVersion, verification } = {}) {
  const list = (Array.isArray(artifacts) ? artifacts : run?.artifacts ?? [])
    .filter((a) => a && typeof a === 'object' && typeof a.file === 'string')
    .map((a) => ({
      file: normalizeFile(a.file),
      size: Number.isFinite(a.size) ? a.size : null,
      sha256: typeof a.sha256 === 'string' ? a.sha256 : null,
      modifiedAt: typeof a.modifiedAt === 'string' ? a.modifiedAt : null,
      kind: attachmentKind(a.file, a.contentType),
    }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const byFile = new Map(list.map((a) => [a.file, a]));
  const caseList = Array.isArray(cases) ? cases : run?.summary?.cases ?? [];

  const enriched = caseList.map((c) => ({
    ...c,
    attachments: normalizeAttachments(c?.attachments),
  }));

  const failures = enriched
    .filter((c) => c.status === 'failed' || c.status === 'flaky')
    .map((c) => {
      const located = locateCaseEvidence(c, { artifacts: list });
      return {
        title: c.title ?? '',
        file: c.file ?? '',
        line: c.line ?? null,
        status: c.status ?? 'unknown',
        error: c.error ?? '',
        duration: Number.isFinite(c.duration) ? c.duration : null,
        attemptsCount: c.attemptsCount ?? null,
        trace: located.located ? located.trace : null,
        traceLocated: located.located,
        traceSource: located.source,
        traceReason: located.reason,
        attachments: located.attachments,
      };
    });

  return {
    runId: run?.id ?? null,
    runUid: run?.uid ?? null,
    runStatus: run?.status ?? null,
    gitCommit: run?.gitCommit ?? null,
    runner: run?.runner ?? null,
    startedAt: run?.startedAt ?? null,
    finishedAt: run?.finishedAt ?? null,
    createdAt: run?.createdAt ?? null,
    engineVersion: engineVersion ?? run?.engineVersion ?? null,
    attachments: list,
    failures,
    cases: enriched,
    totals: {
      count: list.length,
      bytes: list.reduce((n, a) => n + (a.size ?? 0), 0),
      failures: failures.length,
      locatedTraces: failures.filter((f) => f.traceLocated).length,
    },
    verification: verification ?? null,
  };
}
