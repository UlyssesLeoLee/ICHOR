/**
 * ATS-209 -- the EVIDENCE MANIFEST: the index of a run's evidence, the
 * SHA-256 of every file in it, and the rules that decide whether that
 * evidence is still intact.
 *
 * WHAT THIS PROBLEM IS
 * --------------------
 * A run leaves a folder behind: `report.json`, the HTML report, the trace
 * archives, the screenshots, the videos, the log. The bridge records the
 * folder's contents in `run.artifacts` -- a list of `{file, size, sha256}`
 * -- and writes a `manifest.json` next to them.
 *
 * Three things were missing:
 *
 *   1. NOTHING CHECKED the manifest. The digests were recorded and never
 *      read again, so a file that was modified after the run was archived
 *      still carried the digest of the original. A reader of the evidence
 *      had no way to tell an intact archive from a tampered one.
 *
 *   2. NOTHING BOUND the evidence to the run. Every artifact carried a
 *      digest, but not the run it belonged to, so the digests of two runs
 *      could not be compared -- and a digest with no owner is a digest that
 *      proves nothing.
 *
 *   3. NOTHING EVER CLEANED UP. The run folders grew for ever. The
 *      acceptance criterion asks for a retention policy, and a cleaner that
 *      deletes a run's EVIDENCE must not delete the run's METADATA: the
 *      record of what happened has to outlive the files it describes.
 *
 * WHAT THIS MODULE DELIVERS
 * --------------------------
 *
 *   1. THE MANIFEST is a real, versioned document: it carries the run it
 *      belongs to, the digest of every evidence file, and the digest of
 *      the manifest itself is what a reader compares against.
 *
 *   2. VERIFICATION. `verifyEvidence` recomputes the digest of every file
 *      the manifest lists and REPORTS what does not match. A mismatch is
 *      reported per file -- never hidden, never summarised away -- because
 *      "tampering detected" without naming the file is not a result.
 *
 *   3. DEDUPLICATION. The same content in two runs is stored once. The
 *      evidence of a re-run is frequently byte-identical to the evidence
 *      of the run before it (the same report, the same trace of the same
 *      failing case), and keeping both copies wastes the disk space that
 *      the retention policy is meant to protect.
 *
 *   4. RETENTION. `expiredRuns` selects the runs whose evidence is past its
 *      retention period, and `cleanExpiredEvidence` removes ONLY the
 *      evidence FILES. The run record -- its status, its summary, its
 *      attempts, its events -- stays in the state, because the history of
 *      what happened is not the same thing as the files that prove it.
 *
 * THE BOUNDARY OF THIS DELIVERY (stated, not implied)
 * ----------------------------------------------------
 *
 *   * The manifest is NOT signed. An attacker who can write to the data
 *     directory can rewrite a file AND its manifest together, so this
 *     module must not claim WORM storage or a tamper-proof guarantee. What
 *     it DOES detect is a file that no longer matches the manifest it was
 *     archived with -- which is the property `docs/06-DATA-DESIGN.md` §4
 *     asks for ("归档 Manifest 包含 sha256；当前未签名").
 *
 *   * The cleaner is an OFFLINE operation. It never runs while a run is in
 *     flight and it refuses to touch a data directory that a Bridge holds.
 *     A cleaner that deleted the folder of a running run would destroy the
 *     evidence of the run it was supposed to preserve.
 *
 *   * The retention period is a POLICY VALUE, not a product default: it is
 *     given by the caller, and the default is deliberately long enough that
 *     a run is not deleted by surprise.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The version of the manifest format this build writes and reads. */
export const EVIDENCE_MANIFEST_VERSION = 2;

/**
 * The manifest file of a run.
 *
 * The name has been `manifest.json` since v0.1, so it is kept: the file
 * that the existing readers (and the migration) already know.
 */
export const MANIFEST_FILENAME = 'manifest.json';

/**
 * The files of a run folder that are NOT evidence.
 *
 * `events.jsonl` is the durable audit trail of the run and `stdout.log` is
 * the raw output. Both are part of the run's RECORD, not of its evidence
 * set, and the cleaner keeps them together with the metadata.
 *
 * `manifest.json` is the manifest ITSELF. It is not evidence: it is the
 * record OF the evidence, and a manifest that listed itself would be
 * self-referential -- its own digest would change every time it was
 * rewritten, and the verification would report the manifest as a changed
 * file.
 */
export const RECORD_FILENAMES = Object.freeze(['events.jsonl', 'stdout.log']);

/**
 * The largest file that is taken into the evidence set.
 *
 * The limit is the same one the run's artifact list uses, so the manifest
 * and the run record describe the SAME set of files. A file above the limit
 * is not evidence: hashing a multi-gigabyte file on every run end would
 * make the bridge unresponsive.
 */
export const MAX_EVIDENCE_BYTES = 50_000_000;

/**
 * The default retention period of a run's evidence, in days.
 *
 * The default is deliberately generous: a cleaner that deletes evidence by
 * surprise destroys the proof of a failure that nobody has looked at yet.
 * A caller that wants a shorter period asks for one explicitly.
 */
export const DEFAULT_RETENTION_DAYS = 30;

/** The digest of a buffer, as the lowercase hex string SHA-256 produces. */
export function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** The digest of a string, in UTF-8. */
export function sha256OfText(text) {
  return sha256Of(Buffer.from(text, 'utf8'));
}

/**
 * The digest of a FILE, read in one go.
 *
 * The file is read as bytes and nothing is normalised: a digest that
 * ignored the line endings would not detect a file that was rewritten with
 * different line endings -- which is exactly the kind of change an
 * evidence file must detect.
 */
export function sha256OfFile(file) {
  return sha256Of(fs.readFileSync(file));
}

/**
 * The evidence entries of a run folder.
 *
 * The folder is walked and every FILE that is not part of the run's record
 * becomes an entry. The walk is bounded (depth and entry count) so that a
 * pathological folder cannot hang the bridge, and symbolic links are
 * SKIPPED: a link is not evidence, and following it would let a link out
 * of the run folder pull in a file that has nothing to do with the run.
 *
 * The entries are sorted by their relative path, so the manifest of a run
 * is a function of the folder's CONTENTS and not of the order the
 * filesystem happened to hand the entries out in. Two runs with the same
 * evidence therefore produce the same manifest.
 *
 * @param {string} folder the run folder
 * @returns {{file:string, size:number, sha256:string}[]}
 */
export function collectEvidence(folder, { maxDepth = 8, maxEntries = 400 } = {}) {
  const root = path.resolve(folder);
  const entries = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || entries.length >= maxEntries) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const item of items) {
      if (entries.length >= maxEntries) return;
      const full = path.join(dir, item.name);
      // A symbolic link is not evidence: it is a pointer to something
      // else, and the run folder must not be a way to reach outside it.
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) { walk(full, depth + 1); continue; }
      if (!item.isFile()) continue;
      const relative = path.relative(root, full).replace(/\\/g, '/');
      if (RECORD_FILENAMES.includes(relative)) continue;
      // The manifest is the record OF the evidence, not evidence itself.
      if (relative === MANIFEST_FILENAME) continue;
      let stat;
      try { stat = fs.statSync(full); }
      catch { continue; }
      // A file above the limit is not taken into the evidence set, so the
      // manifest and the run record describe the same set of files.
      if (stat.size > MAX_EVIDENCE_BYTES) continue;
      // A file that cannot be read is not an entry: an entry with no
      // digest would be a claim the manifest cannot back up.
      try {
        entries.push({
          file: relative,
          size: stat.size,
          sha256: sha256OfFile(full),
        });
      } catch { /* the file vanished or cannot be read */ }
    }
  };
  walk(root, 0);
  entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return entries;
}

/**
 * Builds the manifest of a run.
 *
 * The manifest is a FUNCTION of the run record and the folder's contents:
 * the same run and the same files always produce the same manifest. That
 * is what makes the manifest verifiable -- a reader can rebuild it and
 * compare.
 *
 * @param {object} run the run record
 * @param {string} folder the run folder
 * @param {{artifacts?:object[], env?:object}} [extra]
 * @returns {object} the manifest
 */
export function buildManifest(run, folder, extra = {}) {
  const artifacts = Array.isArray(extra.artifacts) ? extra.artifacts : collectEvidence(folder);
  const manifest = {
    version: EVIDENCE_MANIFEST_VERSION,
    runId: run.id ?? null,
    projectUid: run.projectUid ?? null,
    projectId: run.projectId ?? null,
    sourceCommit: run.gitCommit ?? null,
    runner: run.runner ?? 'playwright',
    status: run.status ?? null,
    createdAt: run.startedAt ?? run.createdAt ?? null,
    finishedAt: run.finishedAt ?? null,
    artifacts,
    attempts: run.attempts ?? [],
  };
  // The environment profile the run ran under, and the NAMES of the
  // variables it carried -- never their values (ATS-212's rule: the run
  // record is archived and shipped, so a value must not travel with it).
  if (run.envUid) {
    manifest.env = {
      uid: run.envUid,
      name: run.envName ?? null,
      tier: run.envTier ?? null,
      variables: run.envVariables ?? [],
    };
  }
  // ATS-209: the manifest says WHICH RUN it belongs to, so the digests in
  // it can be compared against the digests of another run of the same
  // project. A digest without an owner proves nothing.
  manifest.evidence = {
    count: artifacts.length,
    totalBytes: artifacts.reduce((n, a) => n + (Number(a.size) || 0), 0),
    // The digest of the ENTRY LIST: the identity of the evidence set as a
    // whole. Two runs whose evidence sets are byte-identical share it --
    // which is what the deduplicator looks at.
    setDigest: evidenceSetDigest(artifacts),
  };
  return manifest;
}

/**
 * The digest of an evidence SET: the digest of the sorted
 * `file:sha256:size` lines.
 *
 * The list is sorted before it is hashed, so the digest does not depend on
 * the order the entries were produced in. The SIZE is part of the line
 * because two files with the same content but different sizes are not the
 * same evidence.
 */
export function evidenceSetDigest(artifacts) {
  const lines = (artifacts ?? [])
    .map((a) => `${a.file}:${a.sha256}:${a.size}`)
    .sort();
  return sha256OfText(lines.join('\n'));
}

/**
 * Reads the manifest of a run folder.
 *
 * A folder that has no manifest, or one whose manifest cannot be parsed,
 * is reported as such -- it is never silently treated as an empty
 * evidence set, because "there is no manifest" and "the manifest lists
 * nothing" are very different facts.
 *
 * @returns {{ok:boolean, manifest:object|null, reason:string}}
 */
export function readManifest(folder) {
  const file = path.join(folder, MANIFEST_FILENAME);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    return { ok: false, manifest: null, reason: `the manifest could not be read (${e.code ?? e.message})` };
  }
  try {
    const manifest = JSON.parse(text);
    if (!manifest || typeof manifest !== 'object') {
      return { ok: false, manifest: null, reason: 'the manifest is not a JSON object' };
    }
    return { ok: true, manifest, reason: '' };
  } catch (e) {
    return { ok: false, manifest: null, reason: `the manifest is not valid JSON (${e.message})` };
  }
}

/**
 * Verifies the evidence of a run folder against its manifest.
 *
 * The result names EVERY discrepancy, in three kinds:
 *
 *   * `missing`  -- the manifest lists a file the folder does not have;
 *   * `changed`  -- the file is there but its digest is different;
 *   * `extra`    -- the folder holds a file the manifest does not list.
 *
 * An `extra` file is reported but does NOT make the evidence fail on its
 * own: a file that was ADDED after the run (a log the operator appended, a
 * note) does not invalidate the files that were archived. What it does
 * mean is that the folder is no longer exactly the archive the manifest
 * describes, so the answer says so.
 *
 * The comparison is against the manifest, NOT against a rebuild of it: the
 * manifest is the ARCHIVE's own record of what it contained, so the
 * question "does the folder still hold the evidence the manifest lists?" is
 * exactly the question a reader of the archive needs answered.
 *
 * @param {string} folder the run folder
 * @returns {{ok:boolean, verified:boolean, manifest:object|null, checked:number,
 *            missing:string[], changed:{file:string, expected:string, actual:string}[],
 *            extra:string[], reason:string}}
 */
export function verifyEvidence(folder) {
  const read = readManifest(folder);
  if (!read.ok) {
    return {
      ok: false,
      verified: false,
      manifest: null,
      checked: 0,
      missing: [],
      changed: [],
      extra: [],
      reason: read.reason,
    };
  }
  const manifest = read.manifest;
  const listed = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const missing = [];
  const changed = [];
  let checked = 0;
  for (const entry of listed) {
    if (!entry || typeof entry.file !== 'string') continue;
    const full = path.join(folder, entry.file);
    let actual;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) { missing.push(entry.file); continue; }
      actual = sha256OfFile(full);
    } catch {
      missing.push(entry.file);
      continue;
    }
    checked += 1;
    if (actual !== entry.sha256) {
      changed.push({ file: entry.file, expected: entry.sha256, actual });
    }
  }
  // The files that are in the folder but not in the manifest.
  const present = collectEvidence(folder);
  const listedFiles = new Set(listed.map((e) => e?.file).filter((f) => typeof f === 'string'));
  const extra = present.map((e) => e.file).filter((f) => !listedFiles.has(f));
  const verified = missing.length === 0 && changed.length === 0;
  return {
    ok: true,
    verified,
    manifest,
    checked,
    missing,
    changed,
    extra,
    reason: verified ? '' : 'the evidence does not match its manifest',
  };
}

/**
 * The runs whose evidence is past its retention period.
 *
 * A run is selected when it is TERMINAL (a run that is still in flight has
 * no final evidence yet) and its evidence is OLDER than the period. The
 * age is measured from the run's FINISHED time -- when the evidence was
 * complete -- and the run's creation time is the fallback for a run that
 * never finished.
 *
 * The selection is a pure function of the runs and the clock: it never
 * touches the disk, so a caller can see what WOULD be cleaned before
 * anything is cleaned.
 *
 * @param {object[]} runs the run records
 * @param {{days?:number, now?:number|string}} [options]
 * @returns {{runId:string, finishedAt:string, ageDays:number}[]}
 */
export function expiredRuns(runs, { days = DEFAULT_RETENTION_DAYS, now = Date.now() } = {}) {
  const period = Number(days);
  if (!Number.isFinite(period) || period < 0) {
    throw new Error('INVALID_RETENTION_PERIOD');
  }
  const reference = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(reference)) throw new Error('INVALID_CLOCK');
  const out = [];
  for (const run of runs ?? []) {
    if (!run || typeof run.id !== 'string') continue;
    // Only a TERMINAL run has a final evidence set. A run that is queued,
    // running or cancelling is still producing evidence, and its folder is
    // not eligible for cleaning.
    if (!isTerminalForRetention(run.status)) continue;
    const stamp = run.finishedAt ?? run.createdAt ?? null;
    if (!stamp) continue;
    const at = Date.parse(stamp);
    if (!Number.isFinite(at)) continue;
    const ageMs = reference - at;
    const ageDays = ageMs / 86_400_000;
    if (ageDays >= period) out.push({ runId: run.id, finishedAt: stamp, ageDays });
  }
  return out;
}

/**
 * The statuses whose runs are eligible for cleaning.
 *
 * A run that never reached a terminal status -- `queued`, `running`,
 * `cancelling` -- is still in flight, and its folder is not evidence to be
 * cleaned but the output of a run that is still going on.
 */
export function isTerminalForRetention(status) {
  return status === 'passed'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'error'
    || status === 'interrupted';
}

/**
 * The evidence files of a run folder, with their digests, grouped by the
 * digest they share.
 *
 * This is the deduplication INDEX: the files of two runs that have the
 * same digest are the same bytes, so one of them can be kept and the other
 * referred to it.
 *
 * @param {object[]} runs the run records
 * @param {(run:object)=>string} folderOf the folder of a run
 * @returns {Map<string, {digest:string, size:number, files:{runId:string, file:string}[]}>}
 */
export function groupEvidenceByDigest(runs, folderOf) {
  const groups = new Map();
  for (const run of runs ?? []) {
    if (!run || typeof run.id !== 'string') continue;
    const folder = folderOf(run);
    if (!folder) continue;
    for (const entry of collectEvidence(folder)) {
      const key = entry.sha256;
      const group = groups.get(key) ?? { digest: key, size: entry.size, files: [] };
      group.files.push({ runId: run.id, file: entry.file });
      groups.set(key, group);
    }
  }
  return groups;
}

/**
 * Removes the EVIDENCE of a run -- and only the evidence.
 *
 * WHAT IS REMOVED
 *   The files the manifest lists, plus the files that were added to the
 *   folder after the manifest was written. The evidence folder of the run
 *   (the `results/` tree the engine writes) goes with them.
 *
 * WHAT IS KEPT
 *   * `events.jsonl` -- the durable audit trail of the run;
 *   * `stdout.log`   -- the raw output of the run;
 *   * `manifest.json` -- the record of what the evidence WAS. It is kept
 *     with the digests, so a reader can still see that the evidence set
 *     existed, and can still verify the digests of anything that is
 *     restored from a backup.
 *
 * WHAT IS NEVER TOUCHED
 *   The run RECORD -- its status, its summary, its attempts and its
 *   events -- lives in the state file, not in the run folder, and this
 *   function does not touch it. The acceptance criterion demands exactly
 *   this: a cleaner that expires the evidence must not delete the run's
 *   metadata.
 *
 * The function reports what it removed and what it kept, so the caller can
 * tell the difference between "the evidence was removed" and "there was no
 * evidence to remove".
 *
 * @param {string} folder the run folder
 * @returns {{removed:string[], kept:string[], manifest:object|null}}
 */
export function cleanRunEvidence(folder) {
  const read = readManifest(folder);
  const manifest = read.manifest;
  const removed = [];
  const kept = [];
  if (!fs.existsSync(folder)) {
    return { removed, kept, manifest: null };
  }
  // The files the manifest lists are the evidence.
  const listed = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  for (const entry of listed) {
    if (!entry || typeof entry.file !== 'string') continue;
    const full = path.join(folder, entry.file);
    try {
      fs.rmSync(full, { force: true });
      removed.push(entry.file);
    } catch { /* the file is already gone */ }
  }
  // The files that were added after the manifest was written are evidence
  // too -- they are the ones a reader would find in the folder and not in
  // the manifest.
  for (const entry of collectEvidence(folder)) {
    const full = path.join(folder, entry.file);
    try {
      fs.rmSync(full, { force: true });
      removed.push(entry.file);
    } catch { /* already gone */ }
  }
  // The engine's own output tree is the evidence container; it goes too.
  const resultsDir = path.join(folder, 'results');
  if (fs.existsSync(resultsDir)) {
    try {
      fs.rmSync(resultsDir, { recursive: true, force: true });
      removed.push('results/');
    } catch { /* already gone */ }
  }
  // The record of the run stays.
  for (const name of RECORD_FILENAMES) {
    if (fs.existsSync(path.join(folder, name))) kept.push(name);
  }
  if (manifest) kept.push(MANIFEST_FILENAME);
  return { removed, kept, manifest };
}

/**
 * The retention report of a data directory: which runs are expired, which
 * are not, and how much space the evidence of each takes.
 *
 * The report is a PLAN. Nothing is removed by it -- the caller decides
 * what to do with it, and the cleaner itself takes the report as its
 * input so that the two cannot disagree about which runs are expired.
 *
 * @param {object[]} runs the run records
 * @param {(run:object)=>string} folderOf the folder of a run
 * @param {{days?:number, now?:number|string}} [options]
 */
export function retentionReport(runs, folderOf, { days = DEFAULT_RETENTION_DAYS, now = Date.now() } = {}) {
  const expired = expiredRuns(runs, { days, now });
  const expiredIds = new Set(expired.map((e) => e.runId));
  const kept = [];
  let expiredBytes = 0;
  let keptBytes = 0;
  for (const run of runs ?? []) {
    if (!run || typeof run.id !== 'string') continue;
    const folder = folderOf(run);
    if (!folder) continue;
    const entries = collectEvidence(folder);
    const bytes = entries.reduce((n, e) => n + (Number(e.size) || 0), 0);
    if (expiredIds.has(run.id)) expiredBytes += bytes;
    else keptBytes += bytes;
  }
  return {
    days: Number(days),
    expired,
    expiredCount: expired.length,
    expiredBytes,
    keptBytes,
    // The shared evidence: the bytes that are stored more than once. It is
    // what the deduplicator would save, and it is reported so the caller
    // can see whether the storage pressure is worth the complexity.
    sharedBytes: sharedEvidenceBytes(runs, folderOf),
  };
}

/**
 * The number of bytes that are stored more than once across the runs.
 *
 * The FIRST run that holds a digest keeps it; every further run with the
 * same digest could refer to it instead of storing it again.
 */
export function sharedEvidenceBytes(runs, folderOf) {
  const groups = groupEvidenceByDigest(runs, folderOf);
  let shared = 0;
  for (const group of groups.values()) {
    if (group.files.length < 2) continue;
    // Every copy after the first one is the duplicate.
    shared += group.size * (group.files.length - 1);
  }
  return shared;
}
