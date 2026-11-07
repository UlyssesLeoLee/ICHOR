/**
 * ATS-209 -- the EVIDENCE DEDUPLICATION INDEX.
 *
 * THE PROBLEM
 * -----------
 * Re-running the same test produces a lot of the same evidence. The JSON
 * report of a run that failed the same way twice is byte-identical; the
 * trace archive of the same failing case is byte-identical. Keeping both
 * copies doubles the space the evidence takes for no gain -- and the
 * retention policy exists precisely because the evidence takes too much
 * space.
 *
 * WHAT THE INDEX IS
 * ------------------
 * A content-addressed map: `sha256 -> the one copy that is kept`.
 *
 *   * The KEY is the digest of the content. Two files with the same digest
 *     are the same bytes, so only one of them needs to be stored.
 *   * The VALUE is the copy that is kept: which run folder holds it and
 *     under which relative path.
 *
 * WHERE IT LIVES
 * --------------
 * In the bridge's STATE, next to the projects and the runs -- the same
 * place ATS-212 put the environment profiles, and for the same reasons: the
 * state is the truth, it is written atomically, and it is loaded with the
 * rest of the state when the Bridge starts.
 *
 * It is NOT mirrored into SQLite. The SQLite layer (ATS-205) holds the
 * metadata of the runs and the cases; the evidence index is a derived
 * record of which content is shared, and nothing queries it there. An
 * earlier version of this file claimed a SQLite mirror that does not
 * exist, and the claim was removed rather than the code being written to
 * match it: a document must not describe a table that is not there.
 *
 * The field is ADDITIVE: a state file written before ATS-209 has no
 * `evidenceIndex`, and it loads with an empty index. An installation that
 * predates this task keeps working.
 *
 * THE HONEST LIMIT OF DEDUPLICATION
 * ---------------------------------
 * The index says which files are IDENTICAL. It does NOT make the second
 * copy disappear on its own: the two files live in two run folders, and a
 * run folder that loses a file it is supposed to have is a run whose
 * evidence does not match its manifest.
 *
 * So the index is used the way it can be used honestly:
 *
 *   * it REPORTS the duplicated content -- how many bytes the same
 *     content would take if it were stored once per run -- so the
 *     operator can see the pressure;
 *   * it RECORDS which copy was seen first, so a reader can tell which
 *     of the two files the index points at.
 *
 * It does NOT decide what the cleaner removes. The cleaner removes the
 * EVIDENCE of an expired run -- all of it -- and keeps the run's record.
 * The index does not keep an "authoritative copy" alive: an expired run's
 * evidence is removed whether or not another run happens to hold the
 * same bytes. An earlier version of this file claimed the opposite, and
 * the claim was removed because the code does not do it and the docs must
 * not describe a behaviour that does not exist.
 *
 * A run whose evidence is still within its retention period keeps its own
 * copies: a run must always be able to show its own evidence, and
 * deduplication that made a live run's evidence unreadable would be a
 * corruption, not a saving.
 */
import crypto from 'node:crypto';

/** The version of the index format. */
export const EVIDENCE_INDEX_VERSION = 1;

/**
 * The empty index.
 *
 * The shape is `{version, entries: {<digest>: {...}}}` -- a map, not an
 * array, because the digest is the key and a lookup by digest is what the
 * product does.
 */
export function emptyEvidenceIndex() {
  return { version: EVIDENCE_INDEX_VERSION, entries: {} };
}

/**
 * The index of a state, with the empty index as the fallback.
 *
 * A state that has no index -- an installation that predates ATS-209, or a
 * state whose index was damaged -- gets an EMPTY index rather than an
 * error: the index is an optimisation and a record of what is duplicated,
 * and neither is worth refusing to start the Bridge for.
 */
export function evidenceIndexOf(state) {
  if (!state || typeof state !== 'object') return emptyEvidenceIndex();
  if (!state.evidenceIndex || typeof state.evidenceIndex !== 'object') {
    state.evidenceIndex = emptyEvidenceIndex();
  }
  const index = state.evidenceIndex;
  if (!index.entries || typeof index.entries !== 'object') index.entries = {};
  if (!Number.isInteger(index.version)) index.version = EVIDENCE_INDEX_VERSION;
  return index;
}

/**
 * The identifier of an evidence copy.
 *
 * The key is DERIVED, not random: the same copy always gets the same
 * identifier, so the index can be rebuilt from the run folders and the
 * result is the same index.
 */
export function evidenceKeyOf(runId, file) {
  return `${runId ?? ''}:${file ?? ''}`;
}

/**
 * Records the evidence copies of a run in the index.
 *
 * The rule is FIRST-COME: the copy that is recorded first keeps the entry,
 * and a later copy of the same digest is recorded as a DUPLICATE of it.
 * The duplicate is kept in the index as well -- it is the record of how
 * many copies of the same content exist, which is what the storage
 * pressure report is computed from.
 *
 * The entries of a run are REPLACED, not merged: the run's evidence set
 * is a fact about the run, and a re-scan of a run supersedes what the
 * index said about it before.
 *
 * @param {object} index the index
 * @param {object} run the run record
 * @param {{file:string, size:number, sha256:string}[]} artifacts
 * @returns {{added:number, duplicates:number, removed:number}}
 */
export function indexRunEvidence(index, run, artifacts) {
  if (!index || typeof index !== 'object') return { added: 0, duplicates: 0, removed: 0 };
  if (!index.entries || typeof index.entries !== 'object') index.entries = {};
  const runId = run?.id ?? null;
  if (typeof runId !== 'string') return { added: 0, duplicates: 0, removed: 0 };
  // The entries that belonged to this run are dropped first: a re-scan
  // supersedes them.
  let removed = 0;
  for (const [digest, entry] of Object.entries(index.entries)) {
    if (entry?.runId === runId) { delete index.entries[digest]; removed += 1; }
  }
  let added = 0;
  let duplicates = 0;
  for (const artifact of artifacts ?? []) {
    if (!artifact || typeof artifact.sha256 !== 'string' || !artifact.sha256) continue;
    const digest = artifact.sha256;
    const existing = index.entries[digest];
    if (!existing) {
      index.entries[digest] = {
        digest,
        runId,
        file: artifact.file ?? null,
        size: Number(artifact.size) || 0,
        copies: 1,
        duplicates: [],
      };
      added += 1;
      continue;
    }
    // The same content is already in the index. The copy that is already
    // there stays the authoritative one; this copy is recorded as a
    // duplicate of it.
    existing.copies = (Number(existing.copies) || 1) + 1;
    if (!Array.isArray(existing.duplicates)) existing.duplicates = [];
    existing.duplicates.push({
      runId,
      file: artifact.file ?? null,
      size: Number(artifact.size) || 0,
      key: evidenceKeyOf(runId, artifact.file),
    });
    duplicates += 1;
  }
  return { added, duplicates, removed };
}

/**
 * The copies of a digest: the authoritative one and the duplicates.
 */
export function copiesOf(index, digest) {
  const entry = index?.entries?.[digest];
  if (!entry) return null;
  return {
    digest: entry.digest,
    size: Number(entry.size) || 0,
    authoritative: { runId: entry.runId, file: entry.file },
    duplicates: Array.isArray(entry.duplicates) ? entry.duplicates : [],
    copies: Number(entry.copies) || 1,
  };
}

/**
 * The digests that appear more than once, with the bytes they share.
 *
 * The bytes are the SIZE of the content multiplied by the number of copies
 * BEYOND the first: the first copy is the one that has to be kept.
 *
 * WHAT THESE BYTES ARE NOT (ATS-209 review round 1)
 * --------------------------------------------------
 * The name used to be `wastedBytes`, and it was wrong: the duplicate
 * copies are HARD LINKS to one inode, so the bytes are on the disk ONCE
 * and the disk wastes nothing. The number is the size of the content that
 * is SHARED -- what the copies would cost if they were separate files.
 * It is therefore called `sharedBytes` now, and the field is kept under
 * its old name as well so that a reader of the older API does not see it
 * disappear silently.
 */
export function duplicatedEvidence(index) {
  const out = [];
  for (const entry of Object.values(index?.entries ?? {})) {
    const copies = Number(entry?.copies) || 1;
    if (copies < 2) continue;
    const size = Number(entry.size) || 0;
    out.push({
      digest: entry.digest,
      size,
      copies,
      sharedBytes: size * (copies - 1),
      // The old name, kept for the readers that still ask for it. It
      // means the same thing as `sharedBytes`, and the two are equal --
      // what changed is that the number is no longer called "wasted",
      // because nothing is wasted.
      wastedBytes: size * (copies - 1),
      authoritative: { runId: entry.runId, file: entry.file },
      duplicates: Array.isArray(entry.duplicates) ? entry.duplicates : [],
    });
  }
  out.sort((a, b) => b.sharedBytes - a.sharedBytes || (a.digest < b.digest ? -1 : 1));
  return out;
}

/**
 * The deduplication report of an index.
 *
 * `sharedBytes` is the number of bytes the duplicated content would take
 * if it were stored once per run. The store holds the bytes ONCE, so
 * this is NOT a measurement of the disk: `storeBytes` is.
 *
 * @returns {{entries:number, duplicated:number, sharedBytes:number, wastedBytes:number, top:object[]}}
 */
export function deduplicationReport(index) {
  const entries = Object.keys(index?.entries ?? {}).length;
  const duplicated = duplicatedEvidence(index);
  const sharedBytes = duplicated.reduce((n, d) => n + d.sharedBytes, 0);
  return {
    entries,
    duplicated: duplicated.length,
    sharedBytes,
    // The old name, kept for the readers that still ask for it.
    wastedBytes: sharedBytes,
    // The ten worst offenders: a report that lists every digest would be
    // unreadable, and the biggest ones are the ones that matter.
    top: duplicated.slice(0, 10),
  };
}

/**
 * The digest of a string, in UTF-8.
 *
 * The index does not compute digests itself -- the HOST does, which is the
 * same rule the plugin contract follows (ATS-512: 「证据 SHA-256 由宿主算」).
 * This helper exists so that a caller that has to key something else by
 * its content uses the same function.
 */
export function digestOf(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}