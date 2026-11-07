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
 *     retention period, and `cleanExpiredEvidence` removes ONLY the
 *     evidence FILES. The run record -- its status, its summary, its
 *     attempts, its events -- stays in the state, because the history of
 *     what happened is not the same thing as the files that prove it.
 *
 * THE THREE THINGS THAT MUST NOT BE CONFUSED
 * ------------------------------------------
 *
 *   * WHAT THE MANIFEST LISTS and WHAT THE RUN FOLDER HOLDS are the same
 *     set of files. The manifest is built from the folder, and the run
 *     record's artifact list is built from the folder too, with the SAME
 *     collector and the SAME limit -- so a file that the run record knows
 *     about is a file the manifest knows about. When the limit IS reached
 *     the manifest says so (`evidence.truncated`) and the verification
 *     FAILS: a silently truncated manifest would be a manifest that does
 *     not cover the evidence it claims to describe.
 *
 *   * A PATH IN A MANIFEST IS A PATH INSIDE THE RUN FOLDER. A manifest
 *     that names `../<another run>/events.jsonl` is not describing this
 *     run's evidence, and a cleaner that believed it would delete another
 *     run's files. Such an entry is REJECTED: it is never followed, and
 *     it is reported.
 *
 *   * EVIDENCE THAT WAS CLEANED BY THE RETENTION POLICY is not evidence
 *     that was TAMPERED WITH. The cleaner leaves a record in the run
 *     folder, so the verification can say "this was removed by the
 *     retention policy" instead of "this no longer matches its manifest".
 *     Without that distinction the verification would report every
 *     cleaned run as a tamper, and the tamper alarm would be worthless.
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
 * The largest number of files that are taken into the evidence set.
 *
 * The manifest and the run record's artifact list use the SAME limit and
 * the SAME collector, so the two describe the same set of files. When the
 * limit is reached the manifest says so (`evidence.truncated`), and the
 * verification FAILS: a manifest that silently dropped files would claim
 * to describe an archive it does not describe, and the files it dropped
 * would be outside the tamper detection.
 */
export const MAX_EVIDENCE_ENTRIES = 400;

/**
 * The record the cleaner leaves in a run folder.
 *
 * It is what tells the verification that a file is MISSING because the
 * retention policy removed it -- and not because somebody tampered with
 * the archive. Without it the two cannot be told apart, and every cleaned
 * run would be reported as a tamper.
 */
export const CLEANED_MARKER_FILENAME = 'evidence-cleaned.json';

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
 * The collector also REPORTS whether the entry limit truncated the walk.
 * A truncated collection is not the same thing as a complete one: the
 * caller has to know that files exist which the manifest does not
 * describe, because those files would be outside the tamper detection.
 *
 * @param {string} folder the run folder
 * @returns {{file:string, size:number, sha256:string}[]}
 */
export function collectEvidence(folder, { maxDepth = 8, maxEntries = MAX_EVIDENCE_ENTRIES } = {}) {
  const root = path.resolve(folder);
  const entries = [];
  let truncated = false;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    if (entries.length >= maxEntries) { truncated = true; return; }
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const item of items) {
      if (entries.length >= maxEntries) { truncated = true; return; }
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
      // The cleaner's own record is not evidence either: it says the
      // evidence was removed, so it must not be listed as evidence.
      if (relative === CLEANED_MARKER_FILENAME) continue;
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
  // The result carries the truncation flag, so a caller that wants it can
  // read it -- `collectEvidence` stays a plain array for the callers that
  // only want the entries.
  Object.defineProperty(entries, 'truncated', { value: truncated, enumerable: false });
  return entries;
}

/**
 * Whether a collected evidence set was truncated by the entry limit.
 *
 * `collectEvidence` returns an array, so the flag is a non-enumerable
 * property on it. This helper reads it in a way that does not throw when
 * the caller passes a plain array it built itself.
 */
export function isTruncated(entries) {
  return Boolean(entries && entries.truncated);
}

/**
 * Whether the file system compares paths by their letters.
 *
 * Windows compares them without regard to case, so two spellings of the
 * same path are the same path there. The containment check compares the
 * resolved paths, and on Windows the resolved spelling of the same
 * directory may differ in case from the spelling the caller used.
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32';

/**
 * A path as it is COMPARED: on a case-insensitive file system the letters
 * are folded, so that two spellings of one path compare equal.
 */
function comparablePath(p) {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

/**
 * True when `candidate` is INSIDE `root`.
 *
 * Both paths are expected to be comparable already (see
 * `comparablePath`). The root itself is NOT inside the root: a path that
 * IS the root names the run folder, not a file of the run.
 */
function isInsideReal(rootReal, candidateReal) {
  const rel = path.relative(rootReal, candidateReal);
  if (rel === '' || rel === '..') return false;
  if (rel.startsWith('..' + path.sep)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * The real path of the deepest EXISTING ancestor of a path.
 *
 * A manifest entry whose file was already cleaned away names a path that
 * does not exist. That is a MISSING file, not an escape: the entry still
 * has to be resolved, or a cleaned run would suddenly look like a run
 * whose manifest points out of its folder.
 *
 * So the resolution walks UP to the deepest ancestor that exists and
 * resolves THAT. The result is the path the entry WOULD have, with the
 * links along the way already followed -- which is exactly what the
 * containment check needs to know.
 *
 * `null` when not even the root of the path exists.
 */
function deepestExistingRealPath(target) {
  let current = target;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The directory a run's evidence has to stay inside.
 *
 * The anchor is the run folder AS THE RUN ID NAMES IT: the run folder's
 * own name, placed under the RESOLVED path of its parent. Two things
 * follow from that:
 *
 *   * the run folder's PARENT may sit under a link (a data directory that
 *     is itself a link is ordinary), and then the resolved parent is the
 *     anchor -- so an ordinary file inside the run folder is still
 *     inside it;
 *   * the run folder ITSELF may be a link, and then the resolved path of
 *     every file in it lies OUTSIDE the anchor -- so nothing in it is
 *     inside the run folder, and every entry of its manifest is refused.
 *
 * Comparing against the resolved run folder instead would let a run
 * folder that is a junction pass everything it names: the junction
 * target would be "the run folder", and every path under it would be
 * "inside".
 *
 * @returns {{root:string, anchor:string}}
 */
export function evidenceAnchor(folder) {
  const root = path.resolve(folder);
  const parent = path.dirname(root);
  let parentReal = null;
  try { parentReal = fs.realpathSync(parent); }
  catch { parentReal = null; }
  const anchor = parentReal ? path.join(parentReal, path.basename(root)) : root;
  return { root, anchor };
}

/**
 * Resolves a manifest entry to a path INSIDE the run folder.
 *
 * A manifest entry names a file RELATIVE to the run folder. A name that
 * climbs out of it -- `../<another run>/events.jsonl`, `../../state.json`
 * -- does not describe this run's evidence, and a cleaner that believed
 * it would delete files that belong to something else entirely. Such an
 * entry is REJECTED here, and the caller reports it.
 *
 * THE LEXICAL CHECK IS NOT ENOUGH (ATS-209 review round 2, J1)
 * --------------------------------------------------------------
 * A name can stay inside the run folder and still leave it: a DIRECTORY
 * LINK inside the folder that points somewhere else. `lnk/state.json` is
 * lexically inside the run folder, but `lnk` resolves to the data
 * directory, so the entry names the data directory's state file. A
 * cleaner that followed it would delete the state file of the data
 * directory it was cleaning, and a run that is not even expired would
 * lose its event log.
 *
 * So the entry is resolved for REAL -- every link along the way is
 * followed -- and the resolved path has to be inside the run folder's
 * anchor (see `evidenceAnchor`). A file that does not exist is resolved
 * through its deepest existing ancestor, so a cleaned or missing file
 * stays a MISSING file and not an escape.
 *
 * The rule is the same one the attachment download uses (FR-015): the
 * resolved path has to stay under the run folder. The check is done on
 * the RESOLVED path, so `a/../b` and `./b` are both fine while `../b` is
 * not.
 *
 * @param {string} folder the run folder
 * @param {string} relative the manifest entry
 * @param {{root:string, anchor:string}} [anchor] the anchor, when the
 *   caller resolves many entries of the same folder
 * @returns {{ok:true, path:string}|{ok:false, reason:string}}
 */
export function evidencePathIn(folder, relative, anchor = null) {
  if (typeof relative !== 'string' || !relative) {
    return { ok: false, reason: 'the entry does not name a file' };
  }
  // An absolute path or a Windows drive letter never names a file inside
  // the run folder.
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) {
    return { ok: false, reason: 'the entry names an absolute path' };
  }
  const root = path.resolve(folder);
  let full;
  try { full = path.resolve(root, relative); }
  catch { return { ok: false, reason: 'the entry does not name a file' }; }
  const rel = path.relative(root, full);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return { ok: false, reason: 'the entry points outside the run folder' };
  }
  // The REAL path of the entry: every link along the way is followed.
  const resolved = deepestExistingRealPath(full);
  if (resolved === null) {
    // Nothing of the path exists, not even the run folder: the entry
    // names a file that is not there, and the caller reports it as
    // missing.
    return { ok: true, path: full };
  }
  const the = anchor ?? evidenceAnchor(folder);
  if (!isInsideReal(comparablePath(the.anchor), comparablePath(resolved))) {
    return {
      ok: false,
      reason: 'the entry resolves outside the run folder through a link or junction',
    };
  }
  return { ok: true, path: full };
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
  const collected = Array.isArray(extra.artifacts) ? extra.artifacts : collectEvidence(folder);
  const artifacts = collected;
  // ATS-209: the manifest says WHICH RUN it belongs to, so the digests in
  // it can be compared against the digests of another run of the same
  // project. A digest without an owner proves nothing.
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
  manifest.evidence = {
    count: artifacts.length,
    totalBytes: artifacts.reduce((n, a) => n + (Number(a.size) || 0), 0),
    // The digest of the ENTRY LIST: the identity of the evidence set as a
    // whole. Two runs whose evidence sets are byte-identical share it --
    // which is what the deduplicator looks at.
    setDigest: evidenceSetDigest(artifacts),
    // ATS-209 review round 1 (E6): a manifest that hit the entry limit
    // does NOT describe the whole folder. The fact is recorded HERE, so
    // the verification can fail the archive instead of reporting it as
    // intact: the files the manifest dropped are outside the tamper
    // detection, and an archive that is not covered is not verifiable.
    truncated: isTruncated(collected),
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
 * The result names EVERY discrepancy, in four kinds:
 *
 *   * `missing`  -- the manifest lists a file the folder does not have;
 *   * `changed`  -- the file is there but its digest is different;
 *   * `extra`    -- the folder holds a file the manifest does not list;
 *   * `rejected` -- the manifest names a file OUTSIDE the run folder, so
 *                   the entry does not describe this run's evidence at
 *                   all and is refused rather than followed.
 *
 * An `extra` file is reported but does NOT make the evidence fail on its
 * own: a file that was ADDED after the run (a log the operator appended, a
 * note) does not invalidate the files that were archived. What it does
 * mean is that the folder is no longer exactly the archive the manifest
 * describes, so the answer says so.
 *
 * THE COMPARISON IS AGAINST THE MANIFEST, NOT AGAINST A REBUILD OF IT:
 * the manifest is the ARCHIVE's own record of what it contained, so the
 * question "does the folder still hold the evidence the manifest lists?"
 * is exactly the question a reader of the archive needs answered.
 *
 * WHAT A CLEANED RUN LOOKS LIKE (ATS-209 review round 1, E7)
 * -----------------------------------------------------------
 * The retention policy removes the evidence of an expired run and leaves
 * a record of what it removed. Without that record the missing files
 * would look exactly like a tamper, and the verification would report
 * every cleaned run as evidence that had been tampered with -- which
 * makes the tamper alarm worthless. So:
 *
 *   * a file that the cleaner removed is reported as `cleaned`, and it
 *     does NOT make the archive fail;
 *   * a file that is missing and was NOT removed by the cleaner is still
 *     reported as `missing`, and it still makes the archive fail;
 *   * a file that is present but changed is always `changed`, and it
 *     always makes the archive fail -- the cleaner never rewrites a file.
 *
 * @param {string} folder the run folder
 * @returns {{ok:boolean, verified:boolean, manifest:object|null, checked:number,
 *            missing:string[], changed:{file:string, expected:string, actual:string}[],
 *            extra:string[], rejected:{file:string, reason:string}[],
 *            cleaned:string[], truncated:boolean, reason:string}}
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
      rejected: [],
      cleaned: [],
      truncated: false,
      reason: read.reason,
    };
  }
  const manifest = read.manifest;
  const listed = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  // The files the cleaner removed: their absence is explained, not a
  // discrepancy.
  const cleaned = readCleanedMarker(folder);
  const cleanedSet = new Set(cleaned.removed ?? []);
  const missing = [];
  const changed = [];
  const rejected = [];
  let checked = 0;
  // The anchor of the run folder is computed ONCE: every entry of this
  // manifest is compared against the same run folder, and resolving the
  // path for every entry would repeat the same file system work.
  const anchor = evidenceAnchor(folder);
  for (const entry of listed) {
    if (!entry || typeof entry.file !== 'string') continue;
    // ATS-209 review round 1 (E3): an entry that points outside the run
    // folder does not describe this run's evidence. It is refused and
    // reported -- never followed, because following it would make the
    // verifier (and the cleaner) reach into another run's files.
    //
    // ATS-209 review round 2 (J1): the refusal also covers an entry that
    // STAYS inside the run folder lexically and leaves it through a link.
    const resolved = evidencePathIn(folder, entry.file, anchor);
    if (!resolved.ok) {
      rejected.push({ file: entry.file, reason: resolved.reason });
      continue;
    }
    let actual;
    try {
      const stat = fs.statSync(resolved.path);
      if (!stat.isFile()) {
        if (!cleanedSet.has(entry.file)) missing.push(entry.file);
        continue;
      }
      actual = sha256OfFile(resolved.path);
    } catch {
      if (!cleanedSet.has(entry.file)) missing.push(entry.file);
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
  // A manifest that hit the entry limit does not cover the whole folder:
  // the files it dropped are outside the tamper detection, so the archive
  // is not verified. The failure is reported as its own kind, because it
  // is neither a changed file nor a missing one.
  //
  // A run whose evidence was CLEANED is the exception: the cleaning
  // removed the evidence that the truncated manifest did not cover as
  // well, so there is nothing left unprotected, and the truncation is
  // explained by the cleaning record rather than a defect (ATS-209
  // review round 1, E7 + E6).
  const truncated = Boolean(manifest?.evidence?.truncated);
  const truncatedUncovered = truncated && cleanedSet.size === 0;
  const verified = missing.length === 0 && changed.length === 0 && rejected.length === 0 && !truncatedUncovered;
  let reason = '';
  if (!verified) {
    if (rejected.length) reason = 'the manifest names files outside the run folder';
    else if (truncatedUncovered) reason = 'the manifest does not cover the whole evidence folder';
    else reason = 'the evidence does not match its manifest';
  }
  return {
    ok: true,
    verified,
    manifest,
    checked,
    missing,
    changed,
    extra,
    rejected,
    cleaned: [...cleanedSet].sort(),
    truncated: truncatedUncovered,
    reason,
  };
}

/**
 * Reads the record the cleaner leaves in a run folder.
 *
 * A run folder that has no such record is a run folder that was never
 * cleaned: nothing is explained by the retention policy, and every
 * missing file is a discrepancy.
 *
 * @returns {{removed:string[], at:string|null, reason:string}}
 */
export function readCleanedMarker(folder) {
  const file = path.join(folder, CLEANED_MARKER_FILENAME);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return { removed: [], at: null, reason: '' }; }
  try {
    const marker = JSON.parse(text);
    if (!marker || typeof marker !== 'object') return { removed: [], at: null, reason: '' };
    const removed = Array.isArray(marker.removed) ? marker.removed.filter((f) => typeof f === 'string') : [];
    return { removed, at: marker.at ?? null, reason: '' };
  } catch {
    // A damaged marker explains nothing: the missing files are reported
    // as missing, which is the honest answer.
    return { removed: [], at: null, reason: 'the cleaning record could not be read' };
  }
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
 * ONLY FILES INSIDE THE RUN FOLDER ARE REMOVED (ATS-209 review round 1,
 * E3). A manifest entry that points outside the run folder -- `../<another
 * run>/events.jsonl`, `../../state.json` -- is REFUSED and reported. A
 * run folder is written by the runner as well as by the bridge, so a
 * manifest that the bridge never wrote can name anything at all, and a
 * cleaner that believed it would delete another run's files.
 *
 * ONLY FILES THAT REALLY ARE INSIDE THE RUN FOLDER ARE REMOVED (ATS-209
 * review round 2, J1). The containment is decided on the RESOLVED path,
 * so an entry that stays inside the run folder lexically and leaves it
 * through a DIRECTORY LINK -- `lnk/state.json`, where `lnk` is a junction
 * to the data directory -- is refused as well. Without that, the cleaning
 * of one run deleted the state file of the data directory and the event
 * log of a run that was not even expired.
 *
 * ONLY FILES THAT WERE THERE ARE REPORTED AS REMOVED (E4). `rm` with
 * `force` does not fail on a file that is already gone, so the removal is
 * checked before it is claimed: the journal must not say a file was
 * removed when nothing was.
 *
 * The function reports what it removed and what it kept, so the caller can
 * tell the difference between "the evidence was removed" and "there was no
 * evidence to remove".
 *
 * @param {string} folder the run folder
 * @returns {{removed:string[], kept:string[], rejected:{file:string, reason:string}[], manifest:object|null}}
 */
export function cleanRunEvidence(folder) {
  const read = readManifest(folder);
  const manifest = read.manifest;
  const removed = [];
  const kept = [];
  const rejected = [];
  if (!fs.existsSync(folder)) {
    return { removed, kept, rejected, manifest: null };
  }
  // The anchor of the run folder is computed ONCE: every entry is
  // compared against the same run folder.
  const anchor = evidenceAnchor(folder);
  // The files the manifest lists are the evidence.
  const listed = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  for (const entry of listed) {
    if (!entry || typeof entry.file !== 'string') continue;
    const resolved = evidencePathIn(folder, entry.file, anchor);
    if (!resolved.ok) {
      rejected.push({ file: entry.file, reason: resolved.reason });
      continue;
    }
    // The file is only claimed as removed when it WAS there and is gone
    // afterwards. `rm` with `force` succeeds on a file that is already
    // gone, so the check has to be made by the caller.
    if (!fs.existsSync(resolved.path)) continue;
    try {
      fs.rmSync(resolved.path, { force: true });
      if (!fs.existsSync(resolved.path)) removed.push(entry.file);
    } catch { /* the file could not be removed */ }
  }
  // The files that were added after the manifest was written are evidence
  // too -- they are the ones a reader would find in the folder and not in
  // the manifest.
  for (const entry of collectEvidence(folder)) {
    const resolved = evidencePathIn(folder, entry.file, anchor);
    if (!resolved.ok) {
      rejected.push({ file: entry.file, reason: resolved.reason });
      continue;
    }
    if (!fs.existsSync(resolved.path)) continue;
    try {
      fs.rmSync(resolved.path, { force: true });
      if (!fs.existsSync(resolved.path)) removed.push(entry.file);
    } catch { /* already gone */ }
  }
  // The engine's own output tree is the evidence container; it goes too.
  //
  // ATS-209 review round 2 (J1): when `results` is a DIRECTORY LINK, the
  // link itself is removed -- the tree it points at is NOT. Removing a
  // link must never remove what the link names: the link may well name
  // another run's folder. The link is therefore unlinked on its own, and
  // the tree it pointed at is left alone.
  const resultsDir = path.join(folder, 'results');
  if (fs.existsSync(resultsDir)) {
    let isLink = false;
    try { isLink = fs.lstatSync(resultsDir).isSymbolicLink(); }
    catch { isLink = false; }
    try {
      if (isLink) fs.unlinkSync(resultsDir);
      else fs.rmSync(resultsDir, { recursive: true, force: true });
      if (!fs.existsSync(resultsDir)) removed.push('results/');
    } catch { /* already gone */ }
  }
  // The record of the run stays.
  for (const name of RECORD_FILENAMES) {
    if (fs.existsSync(path.join(folder, name))) kept.push(name);
  }
  if (manifest) kept.push(MANIFEST_FILENAME);
  // ATS-209 review round 1 (E7): the record of what the retention policy
  // removed. Without it the missing files are indistinguishable from a
  // tamper, and the verification would report every cleaned run as
  // tampered -- which makes the tamper alarm worthless.
  //
  // ATS-209 review round 2 (M1): the record is ONLY EVER EXTENDED. A
  // second cleaning that removes something else would otherwise rewrite
  // the record and erase the explanation of the first cleaning -- and the
  // files the first cleaning removed would be reported as MISSING again,
  // which is the same signal a tamper carries.
  if (removed.length) {
    const markerFile = path.join(folder, CLEANED_MARKER_FILENAME);
    const previous = readCleanedMarker(folder);
    // The union of what the earlier cleanings removed and what this one
    // removed: the record of a removal is never withdrawn.
    const all = [...new Set([...(previous.removed ?? []), ...removed])].sort();
    try {
      fs.writeFileSync(
        markerFile,
        JSON.stringify({ at: new Date().toISOString(), removed: all }, null, 2),
        'utf8'
      );
      kept.push(CLEANED_MARKER_FILENAME);
    } catch { /* the marker could not be written: the files are missing and reported as such */ }
  }
  return { removed, kept, rejected, manifest };
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
 *
 * WHAT THIS NUMBER IS NOT (ATS-209 review round 1)
 * -----------------------------------------------
 * This counts the bytes that WOULD be saved if the duplicate copies were
 * separate files. It is NOT the space the disk is wasting: the duplicates
 * are HARD LINKS to the same inode, so the bytes are on the disk once and
 * the disk is wasting nothing. The number is therefore reported as
 * `sharedBytes` -- the bytes that are shared -- and the report that says
 * how much space the store really holds is `storeBytes`, which measures
 * the store itself.
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
