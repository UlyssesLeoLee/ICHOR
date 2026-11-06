/**
 * ATS-209 -- the CONTENT-ADDRESSED EVIDENCE STORE.
 *
 * WHY A BLOB STORE
 * ----------------
 * Deduplication that only REPORTS the duplicates saves nothing. The point of
 * the retention policy is that the evidence takes too much space, and the
 * point of the deduplication is that the same bytes are stored again and
 * again: the report of a run that failed the same way twice, the trace
 * archive of the same failing case, the screenshot of the same screen.
 *
 * So the bytes are stored ONCE, in a content-addressed store, and the run
 * folder holds a LINK to the stored copy.
 *
 * WHY A HARD LINK AND NOT A COPY
 * ------------------------------
 * A copy would still take the space. A hard link does not: the run folder
 * and the store point at the SAME inode, so the bytes are on the disk once
 * and the space is reclaimed as soon as the last link goes away.
 *
 * The properties that make a hard link the right tool here:
 *
 *   * it is ATOMIC to install -- the link is created under a temporary name
 *     and then renamed over the target, so a reader never sees a partial
 *     file;
 *   * removing a run's copy removes only the LINK: the stored copy survives
 *     as long as another link to it exists;
 *   * the CONTENT of a hard link cannot be changed independently of the
 *     other links -- an in-place write through one link is visible through
 *     all of them. That is a property the tamper detection RELIES on: a
 *     run's evidence file cannot drift away from the stored copy without
 *     the digest changing, and the digest is what the manifest records.
 *
 * The last point is the reason a hard link is safe here and a copy is not:
 * with a copy, the run's file and the stored copy could drift apart, and
 * the stored copy would no longer be a backup of anything.
 *
 * THE STORE IS INSIDE THE DATA DIRECTORY
 * ---------------------------------------
 * The blobs live in `<data-dir>/evidence-store/`, next to the runs. They
 * are NOT in the repository and NOT in Git: the evidence is run data, and
 * the same rule that keeps the environment profiles out of Git keeps the
 * evidence out of it.
 *
 * WHEN A FILE IS NOT STORED
 * --------------------------
 * A file that is too large is not stored: the store is a space saver, and
 * a file bigger than the limit is better off where it is. The link is then
 * simply not made, and the manifest records the file with its digest as
 * usual -- the evidence is still verifiable, it is just not deduplicated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256OfFile } from './manifest.mjs';

/** The name of the store directory inside the data directory. */
export const EVIDENCE_STORE_DIR = 'evidence-store';

/**
 * The largest file the store takes.
 *
 * A file above this size is left where it is. The limit exists because the
 * store's benefit is proportional to the number of links a blob gets, and
 * a very large file is rarely duplicated in full.
 */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * The path of the blob of a digest.
 *
 * The digest is SHA-256, so the name is 64 hex characters. The name is
 * SPLIT into two levels: a store with a hundred thousand blobs in one
 * directory is slow to list on Windows, and a two-level fan-out keeps
 * every directory small.
 */
export function blobPath(storeDir, digest) {
  const safe = String(digest ?? '').replace(/[^0-9a-f]/gi, '');
  if (safe.length < 64) return null;
  return path.join(storeDir, safe.slice(0, 2), safe.slice(2, 4), safe);
}

/**
 * The store of a data directory.
 */
export function storeDirOf(dataDir) {
  return path.join(dataDir, EVIDENCE_STORE_DIR);
}

/**
 * Stores a file in the content-addressed store and returns the path of the
 * stored copy.
 *
 * The file is stored under its OWN digest, so storing the same content
 * twice stores it once: the second call finds the blob already there and
 * returns its path without copying anything.
 *
 * @param {string} storeDir the store directory
 * @param {string} file the file to store
 * @param {string} digest the digest of the file
 * @returns {{stored:boolean, path:string|null, reason:string}}
 */
export function storeBlob(storeDir, file, digest) {
  const target = blobPath(storeDir, digest);
  if (!target) return { stored: false, path: null, reason: 'the digest is not a SHA-256 hex string' };
  // The blob is already there: this content is stored once, which is the
  // whole point of the store.
  if (fs.existsSync(target)) {
    return { stored: true, path: target, reason: '', alreadyStored: true };
  }
  let stat;
  try { stat = fs.statSync(file); }
  catch (e) { return { stored: false, path: null, reason: `the file could not be read (${e.code ?? e.message})` }; }
  if (!stat.isFile()) return { stored: false, path: null, reason: 'the path is not a file' };
  if (stat.size > MAX_BLOB_BYTES) {
    return { stored: false, path: null, reason: `the file is larger than ${MAX_BLOB_BYTES} bytes` };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The copy is written to a temporary name and then renamed, so a reader
  // never sees a half-written blob. The rename is the commit point.
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(file, tmp);
    // The digest of the COPY is checked, not the digest of the source: a
    // copy that was truncated would otherwise be stored under a digest that
    // does not describe it.
    const copied = sha256OfFile(tmp);
    if (copied !== digest) {
      fs.rmSync(tmp, { force: true });
      return { stored: false, path: null, reason: 'the copy does not match the digest' };
    }
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
    return { stored: false, path: null, reason: `the blob could not be written (${e.code ?? e.message})` };
  }
  return { stored: true, path: target, reason: '', alreadyStored: false };
}

/**
 * Replaces a file with a hard link to a stored blob.
 *
 * The link is created under a temporary name and renamed over the target,
 * so the replacement is ATOMIC: a reader sees either the old file or the
 * link, never a half-installed state.
 *
 * A platform that cannot create the link (a different volume, a file
 * system without links) is REPORTED, not silently ignored: the caller has
 * to know that the file was not deduplicated.
 *
 * @returns {{linked:boolean, reason:string}}
 */
export function linkToBlob(file, blob) {
  try {
    const tmp = `${file}.${process.pid}.link`;
    try { fs.rmSync(tmp, { force: true }); } catch { /* it does not exist */ }
    fs.linkSync(blob, tmp);
    fs.renameSync(tmp, file);
    return { linked: true, reason: '' };
  } catch (e) {
    try { fs.rmSync(`${file}.${process.pid}.link`, { force: true }); } catch { /* nothing to clean up */ }
    return { linked: false, reason: `the hard link could not be created (${e.code ?? e.message})` };
  }
}

/**
 * The blobs of a store that no run refers to any more.
 *
 * A blob is a duplicate candidate when it has exactly ONE link left: the
 * link of the store itself. A blob with two or more links is still
 * referred to by at least one run.
 *
 * @param {string} storeDir the store directory
 * @returns {{digest:string, path:string, size:number, links:number}[]}
 */
export function unreferencedBlobs(storeDir) {
  const out = [];
  if (!fs.existsSync(storeDir)) return out;
  const walk = (dir) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!item.isFile()) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      // The link count is what says whether a run still refers to the blob.
      // A file system that does not report links (or a network share) gives
      // 1 for everything, and the blob is then a candidate -- the caller
      // checks the reference before it removes anything.
      if (stat.nlink <= 1) {
        out.push({ digest: item.name, path: full, size: stat.size, links: stat.nlink });
      }
    }
  };
  walk(storeDir);
  return out;
}

/**
 * The number of bytes the store holds.
 */
export function storeBytes(storeDir) {
  let total = 0;
  if (!fs.existsSync(storeDir)) return 0;
  const walk = (dir) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!item.isFile()) continue;
      try { total += fs.statSync(full).size; } catch { /* the file vanished */ }
    }
  };
  walk(storeDir);
  return total;
}

/**
 * Removes the blobs that no run refers to any more.
 *
 * A blob is only removed when it has ONE link -- the store's own -- so a
 * blob that a run still refers to cannot be removed by this function. The
 * check is repeated immediately before the removal, because a run may have
 * taken a link in between.
 *
 * @param {string} storeDir the store directory
 * @param {(digest:string)=>boolean} [isReferenced] an extra reference check
 * @returns {{removed:string[], kept:number, bytesFreed:number}}
 */
export function pruneStore(storeDir, isReferenced = null) {
  const removed = [];
  let kept = 0;
  let bytesFreed = 0;
  for (const blob of unreferencedBlobs(storeDir)) {
    if (isReferenced && isReferenced(blob.digest)) { kept += 1; continue; }
    // The link count is re-read right before the removal: a run that took a
    // link in the meantime must keep its blob.
    try {
      if (fs.statSync(blob.path).nlink > 1) { kept += 1; continue; }
    } catch { /* the blob vanished */ }
    try {
      fs.rmSync(blob.path, { force: true });
      removed.push(blob.digest);
      bytesFreed += blob.size;
    } catch { kept += 1; }
  }
  return { removed, kept, bytesFreed };
}
