/**
 * ATS-215 -- the evidence workbench's VOCABULARY.
 *
 * This file holds the words and the classification that the evidence
 * workbench uses. It is separate from the locating logic
 * (`evidence-workbench-index.mjs`) and from the public interface
 * (`evidence-workbench.mjs`) for one reason: the vocabulary is needed by
 * BOTH of them, and a shared module that two modules import cannot also
 * be imported by them without a cycle.
 *
 * The dependency order is therefore strictly one-directional:
 *
 *     evidence-workbench-vocabulary.mjs   (this file, no imports)
 *              |
 *              v
 *     evidence-workbench-index.mjs        (the locating logic)
 *              |
 *              v
 *     evidence-workbench.mjs              (the public interface)
 *
 * One definition of "what kind of attachment is this" -- so the Next
 * workbench and the portable UI cannot disagree about it, and so the
 * locating logic and the rendering cannot disagree either.
 */

/**
 * The kinds of attachment a reader may be looking for.
 *
 * `trace` is the Playwright trace archive. `report` is the JSON report.
 * `html` is the HTML report (and its bundled viewer). `context` is the
 * error context markdown the engine writes next to a failure. `video` and
 * `screenshot` are the media the project's own config asked for.
 */
export const ATTACHMENT_KINDS = Object.freeze([
  'trace',
  'report',
  'html',
  'context',
  'video',
  'screenshot',
  'other',
]);

/**
 * The kinds a reader is looking for FIRST.
 *
 * The order is the answer to "which attachment do I open". A trace is
 * what the acceptance criterion is about, so it comes first; the error
 * context is the human-readable snapshot of a failure; the JSON report is
 * what a machine reads.
 */
export const ATTACHMENT_PRIORITY = Object.freeze([
  'trace',
  'context',
  'report',
  'html',
  'screenshot',
  'video',
  'other',
]);

/**
 * The rank of a kind in the priority order. Unknown kinds rank last.
 *
 * @param {string} kind
 * @returns {number}
 */
export function attachmentRank(kind) {
  const index = ATTACHMENT_PRIORITY.indexOf(kind);
  return index === -1 ? ATTACHMENT_PRIORITY.length : index;
}

/**
 * The kind of an attachment, derived from its path.
 *
 * The derivation is by PATH SHAPE, because that is what the engine
 * actually guarantees: the trace archive is written to `trace.zip`, the
 * JSON report to `report.json`, the HTML report to `html/index.html`.
 * The `contentType` the engine recorded is used when it is available, but
 * it is a SECONDARY signal: it does not distinguish a trace from any other
 * zip, and a mis-typed content type must not make a trace invisible.
 *
 * @param {string} file the artifact's relative path (with `/` separators)
 * @param {string} [contentType] the content type the engine recorded
 * @returns {string} one of ATTACHMENT_KINDS
 */
export function attachmentKind(file, contentType) {
  const path = String(file ?? '').replace(/\\/g, '/').toLowerCase();
  const type = String(contentType ?? '').toLowerCase();
  if (path.endsWith('trace.zip')) return 'trace';
  if (path.endsWith('.zip') && type.includes('zip')) return 'trace';
  if (path === 'report.json' || path.endsWith('/report.json')) return 'report';
  if (path === 'error-context.md' || path.endsWith('/error-context.md')) return 'context';
  if (path.endsWith('.webm') || path.endsWith('.mp4')) return 'video';
  if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg')
    || path.endsWith('.webp') || path.endsWith('.gif')) return 'screenshot';
  if (path === 'html/index.html' || path.startsWith('html/')) return 'html';
  if (type.includes('json')) return 'report';
  return 'other';
}

/**
 * The labels of the attachment kinds, in the interface's language.
 *
 * @type {Readonly<Record<string,string>>}
 */
export const KIND_LABEL = Object.freeze({
  trace: 'Trace',
  report: 'JSON 报告',
  html: 'HTML 报告',
  context: '错误上下文',
  video: '录屏',
  screenshot: '截图',
  other: '其他',
});

/**
 * The label of an attachment kind.
 *
 * @param {string} kind
 * @returns {string}
 */
export function kindLabel(kind) {
  return KIND_LABEL[kind] ?? KIND_LABEL.other;
}
