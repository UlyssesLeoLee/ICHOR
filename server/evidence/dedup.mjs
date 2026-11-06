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
 * state is the truth, it is written atomically, and it is mirrored into
 * SQLite as queryable rows.
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
 *   * it REPORTS the duplicate bytes -- how much space the same content
 *     takes more than once -- so the operator can see the pressure;
 *   * it RECORDS which copy is authoritative, so a reader can tell which
 *     of the two files is the one the index points at;
 *   * and the cleaning (`server/evidence/retention.mjs`) removes the
 *     DUPLICATE copies of an EXPIRED run, keeping the copy the index
 *     points at.
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
 * The digests that appear more than once, with the bytes they waste.
 *
 * The bytes are the SIZE of the content multiplied by the number of copies
 * BEYOND the first: the first copy is the one that has to be kept.
 */
export function duplicatedEvidence(index) {
  const out = [];
  for (const entry of Object.values(index?.entries ?? {})) {
    const copies = Number(entry?.copies) || 1;
    if (copies < 2) continue;
    out.push({
      digest: entry.digest,
      size: Number(entry.size) || 0,
      copies,
      wastedBytes: (Number(entry.size) || 0) * (copies - 1),
      authoritative: { runId: entry.runId, file: entry.file },
      duplicates: Array.isArray(entry.duplicates) ? entry.duplicates : [],
    });
  }
  out.sort((a, b) => b.wastedBytes - a.wastedBytes || (a.digest < b.digest ? -1 : 1));
  return out;
}

/**
 * The deduplication report of an index.
 *
 * @returns {{entries:number, duplicated:number, wastedBytes:number, top:object[]}}
 */
export function deduplicationReport(index) {
  const entries = Object.keys(index?.entries ?? {}).length;
  const duplicated = duplicatedEvidence(index);
  const wastedBytes = duplicated.reduce((n, d) => n + d.wastedBytes, 0);
  return {
    entries,
    duplicated: duplicated.length,
    wastedBytes,
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
