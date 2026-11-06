/**
 * ATS-209 -- the EVIDENCE RETENTION CLEANER.
 *
 * WHAT IT DOES
 * ------------
 * It removes the EVIDENCE of the runs whose retention period has expired.
 * It does NOT remove the run records: the status, the summary, the attempts
 * and the events of a run stay in the state, because the history of what
 * happened is not the same thing as the files that prove it.
 *
 * THAT IS THE WHOLE POINT OF THE TASK
 * ------------------------------------
 * The acceptance criterion is 「保留期到期可清理且不误删 Run 元数据」. So the
 * cleaner is written so that the two cannot be confused:
 *
 *   * it operates on the RUN FOLDERS, and only on the evidence files in
 *     them;
 *   * it never touches the state file, the SQLite mirror, or any field of
 *     a run record;
 *   * it REFUSES to run against a data directory that a Bridge holds, so
 *     it cannot race a run that is in flight.
 *
 * The refusal is not a nicety. A Bridge that is running writes the state
 * file from its own in-memory copy on every save: a cleaner that deleted a
 * run's folder while the Bridge held it would leave the state pointing at
 * files that are gone, and the next save would write that state back.
 *
 * THE AUDIT TRAIL
 * ---------------
 * Every cleaning writes a JOURNAL: what was removed, what was kept, and
 * which runs were selected. The journal is what makes the cleaning
 * auditable -- 「可审计删除」 is one of the requirements of
 * `docs/06-DATA-DESIGN.md` §4 for evidence that may hold PII.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readBridgeLock } from '../core.mjs';
import {
  DEFAULT_RETENTION_DAYS,
  MANIFEST_FILENAME,
  cleanRunEvidence,
  collectEvidence,
  expiredRuns,
  retentionReport,
} from './manifest.mjs';

/** The name of the journal the cleaner writes. */
export const CLEANER_JOURNAL = 'evidence-retention-journal.jsonl';

/**
 * The state of the data directory's lock, as the cleaner needs it.
 *
 * `readBridgeLock` returns the lock RECORD when a live process holds the
 * directory, and null when nobody holds it (or when the record names a
 * dead process). So the presence of a record IS the answer: there is no
 * `held` flag in the record, and inventing one would be a second source
 * of truth about the lock.
 *
 * @returns {{held:boolean, holder:object|null}}
 */
export function cleanerLockState(lockFile) {
  const holder = readBridgeLock(lockFile);
  return { held: holder !== null, holder: holder ?? null };
}

/**
 * Picks the runs to clean and cleans their evidence.
 *
 * @param {object} options
 * @param {object[]} options.runs the run records
 * @param {(run:object)=>string} options.folderOf the folder of a run
 * @param {number} [options.days] the retention period in days
 * @param {number|string} [options.now] the clock
 * @param {string} [options.journalFile] where the journal is written
 * @param {boolean} [options.dryRun] report the plan without removing anything
 * @param {boolean} [options.lockHeld] whether a Bridge holds the data directory
 * @returns {{ok:boolean, dryRun:boolean, days:number, cleaned:object[],
 *            skipped:object[], reason:string, expired:object[]}}
 */
export function cleanExpiredEvidence({
  runs,
  folderOf,
  days = DEFAULT_RETENTION_DAYS,
  now = Date.now(),
  journalFile = null,
  dryRun = false,
  lockHeld = false,
} = {}) {
  // A cleaner that runs against a live data directory would delete the
  // folder of a run that is still producing evidence, and the Bridge that
  // owns the directory would write the state that points at it back.
  if (lockHeld) {
    return {
      ok: false,
      dryRun: Boolean(dryRun),
      days: Number(days),
      cleaned: [],
      skipped: [],
      expired: [],
      reason: 'the data directory is held by a running Bridge; the cleaning was refused',
    };
  }
  const expired = expiredRuns(runs ?? [], { days, now });
  const expiredIds = new Set(expired.map((e) => e.runId));
  const cleaned = [];
  const skipped = [];
  for (const run of runs ?? []) {
    if (!run || typeof run.id !== 'string') continue;
    if (!expiredIds.has(run.id)) continue;
    const folder = folderOf(run);
    if (!folder) {
      skipped.push({ runId: run.id, reason: 'the run has no folder in the data directory' });
      continue;
    }
    if (dryRun) {
      const entries = collectEvidence(folder);
      cleaned.push({
        runId: run.id,
        folder,
        removed: entries.map((e) => e.file),
        kept: [MANIFEST_FILENAME],
        bytes: entries.reduce((n, e) => n + (Number(e.size) || 0), 0),
        dryRun: true,
      });
      continue;
    }
    const result = cleanRunEvidence(folder);
        cleaned.push({
          runId: run.id,
          folder,
          removed: result.removed,
          kept: result.kept,
          // ATS-209 review round 1 (E3): the manifest entries that pointed
          // outside the run folder were REFUSED. They are reported so the
          // refusal is visible in the journal and on the console, and not
          // silently swallowed.
          rejected: result.rejected ?? [],
          bytes: 0,
          dryRun: false,
        });
      }
      // The journal is written even when nothing was cleaned: a cleaning that
      // found nothing is still an event an auditor has to be able to see.
      if (!dryRun && journalFile) {
        const entries = cleaned.map((c) => ({
          at: new Date(typeof now === 'number' ? now : Date.parse(now)).toISOString(),
          runId: c.runId,
          removed: c.removed,
          kept: c.kept,
          rejected: c.rejected ?? [],
        }));
        writeJournal(journalFile, entries);
      }
  return {
    ok: true,
    dryRun: Boolean(dryRun),
    days: Number(days),
    cleaned,
    skipped,
    expired,
    reason: '',
  };
}

/**
 * Appends the journal entries to the journal file.
 *
 * The journal is APPEND-ONLY: a cleaning must never rewrite the record of
 * an earlier one. Each line is one JSON object.
 */
export function writeJournal(journalFile, entries) {
  if (!journalFile) return;
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  const lines = (entries ?? []).map((e) => JSON.stringify(e)).join('\n');
  if (!lines) return;
  fs.appendFileSync(journalFile, lines + '\n', 'utf8');
}

/**
 * Reads the journal back.
 *
 * A journal line that cannot be parsed is REPORTED rather than dropped:
 * a damaged journal is a fact the auditor has to know about.
 */
export function readJournal(journalFile) {
  if (!journalFile || !fs.existsSync(journalFile)) {
    return { entries: [], unreadable: [], missing: true };
  }
  const text = fs.readFileSync(journalFile, 'utf8');
  const entries = [];
  const unreadable = [];
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo += 1;
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); }
    catch (e) { unreadable.push({ line: lineNo, reason: e.message }); }
  }
  return { entries, unreadable, missing: false };
}

/**
 * The full plan of a cleaning: what is expired, what is kept, and how much
 * space the evidence takes.
 *
 * The plan is what a caller SHOWS before it cleans. It touches nothing.
 */
export function planRetention(runs, folderOf, { days = DEFAULT_RETENTION_DAYS, now = Date.now() } = {}) {
  return retentionReport(runs ?? [], folderOf, { days, now });
}
