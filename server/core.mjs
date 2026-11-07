import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { projectUidFor, projectUidOf, resolveIdentities, extractCallbackBody, scanTestCases, UID_SCHEME_VERSION, emptyRegistry, attemptUidFor, findTestUid, normalizeTestPath, bodyKeyOf } from './uid.mjs';
// ATS-209: the evidence collector. The run record's artifact list and the
// evidence manifest use the SAME collector, so the two describe the same
// set of files.
import { collectEvidence } from './evidence/manifest.mjs';
import { buildPlaywrightArgs, probePlaywrightCli } from './adapters/playwright-cli.mjs';
import { openDatabase as openMetadataDatabase } from './sqlite/db.mjs';
import { storeState } from './sqlite/store.mjs';
import { listTests, listTestsAsync, LIST_OUTCOME } from './discovery/playwright-list.mjs';
import { resolveAuthoritativeIdentities } from './discovery/authoritative.mjs';
import { compareDiscoveries, readBodies, staticCasesWithScope, DISCOVERY } from './discovery/index.mjs';
// ATS-602: the mobile Flow import. A Flow file declares cases like a spec
// file declares cases, so the mobile cases join the SAME catalogue.
import { importProjectFlows } from './discovery/mobile-flow-import.mjs';
import { TRUST, trustOf } from './discovery/trust.mjs';
// ATS-208: the unified Run/Test/Attempt/ExecutionEvent model. The report
// parsing, the attempt building and the status vocabulary live THERE, so
// that the bridge, the adapters and the SQLite layer describe a run in ONE
// way. The functions below are re-exported from this module so that the
// existing callers keep working.
import {
  CASE_STATUS,
  EVENT_TYPE,
  OUTCOME,
  RESULT_STATUSES,
  RUN_STATUS,
  aggregateCases,
  aggregateAttempts,
  aggregateOutcomes,
  attemptsForRun,
  caseIdentity,
  isAllowedTransition,
  isTerminalRunStatus,
  mapEngineStatus,
  nextEventSeq,
  outcomeOf,
  parseEventLog,
  parseReport,
  replayEvents,
  reportedBodyKey,
  runView,
  statusOfEvent,
} from './execution/model.mjs';

export {
  CASE_STATUS,
  EVENT_TYPE,
  OUTCOME,
  RESULT_STATUSES,
  RUN_STATUS,
  aggregateCases,
  aggregateAttempts,
  aggregateOutcomes,
  attemptsForRun,
  caseIdentity,
  isAllowedTransition,
  isTerminalRunStatus,
  mapEngineStatus,
  nextEventSeq,
  outcomeOf,
  parseEventLog,
  parseReport,
  replayEvents,
  reportedBodyKey,
  runView,
  statusOfEvent,
};

// ATS-602: `sha` and `isSubpath` live in `server/paths.mjs`, a module that
// depends on nothing but the Node builtins. They used to be defined here,
// and the mobile contract imported them from here -- which made a CYCLE
// once the mobile Flow import entered the chain (core -> discovery ->
// adapters/mobile-target -> core). The definitions moved; the re-export
// keeps every existing caller working.
//
// The helpers are IMPORTED, not only re-exported: a bare
// `export { sha } from './paths.mjs'` does NOT create a binding that this
// module can use, and the module uses both of them below.
import { sha, isSubpath } from './paths.mjs';
export { sha, isSubpath };
export const safeId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
export const dataDir = () => path.resolve(process.env.ATS_DATA_DIR || path.join(os.homedir(), '.ai-test-studio'));
export const now = () => new Date().toISOString();
export function ensureData() { fs.mkdirSync(path.join(dataDir(),'runs'), {recursive:true}); }
/** Synchronous sleep, for the short bounded retries of the persistence and the lock. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/** An error of the state file that names the file and what is wrong with it. */
function stateFileError(code, file, detail) {
  const e = new Error(code);
  e.code = code;
  e.file = file;
  e.detail = detail;
  return e;
}

/**
 * Reads `state.json`.
 *
 * A missing file is a fresh installation and yields the empty state. A file
 * that EXISTS but cannot be read as a state is never replaced by the empty
 * state: that would discard every project and the whole run history on the
 * next save. It is reported instead --
 *
 *   * `STATE_CORRUPT`: the file is not JSON (a zero-length file -- the
 *     typical leftover of a write that was not synced -- included);
 *   * `UNSUPPORTED_DATABASE`: the file is JSON but not a schema-1 state.
 *
 * Both errors carry `code`, `file` and `detail`.
 */
export function loadState() {
  ensureData(); const name=path.join(dataDir(),'state.json');
  if (!fs.existsSync(name)) return {schema:1, projects:[], runs:[], uidRegistry:emptyRegistry()};
  const text=fs.readFileSync(name,'utf8');
  let v;
  try { v=JSON.parse(text); }
  catch (cause) { throw stateFileError('STATE_CORRUPT', name, text.length===0 ? 'the file is empty' : cause.message); }
  if (!v || typeof v!=='object' || v.schema!==1 || !Array.isArray(v.projects) || !Array.isArray(v.runs))
    throw stateFileError('UNSUPPORTED_DATABASE', name, 'the file is not a schema-1 state with projects and runs arrays');
  // The UID registry is additive: a state file written before ATS-201 has no
  // registry and is loaded with an empty one, so old installations keep
  // working until the migration script rewrites their identifiers.
  if (!v.uidRegistry || typeof v.uidRegistry!=='object') v.uidRegistry=emptyRegistry();
  return v;
}

/** How often a rename of the state file is attempted on a transient Windows error. */
export const STATE_RENAME_ATTEMPTS = 5;

/** Rename errors that are transient on Windows (an antivirus or indexer handle). */
const TRANSIENT_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Makes a rename inside `dir` durable.
 *
 * On POSIX the directory entry is only on disk once the directory itself is
 * synced. On Windows a directory cannot be opened for fsync, and NTFS
 * journals the rename metadata, so there is nothing to do.
 *
 * @returns {boolean} true when the directory was synced
 */
export function syncDirectory(dir, platform = process.platform) {
  if (platform === 'win32') return false;
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Replaces `file` with `text` so that a crash or a power cut at ANY instant
 * leaves either the previous or the new complete file.
 *
 *   1. the text goes to `<file>.<pid>.tmp` -- a temp name per process, so two
 *      writers never write into each other's temp file;
 *   2. the temp file is FSYNCED before the rename. Without it the rename can
 *      reach the disk before the data does, and a power cut leaves a
 *      zero-length or zero-filled `state.json` -- the rename is the commit
 *      point, so the data must be durable first;
 *   3. the rename replaces the file atomically. A transient Windows sharing
 *      violation is retried a few times;
 *   4. the directory is synced so the rename itself is durable (POSIX).
 *
 * On a failure the temp file is removed and `file` keeps its previous content.
 */
export function writeFileDurably(file, text) {
  const temp=`${file}.${process.pid}.tmp`;
  const fd=fs.openSync(temp,'w');
  try {
    fs.writeFileSync(fd,text,'utf8');
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(temp,{force:true});
    throw e;
  }
  fs.closeSync(fd);
  for (let attempt=1;;attempt++) {
    try { fs.renameSync(temp,file); break; }
    catch (e) {
      if (TRANSIENT_RENAME.has(e.code) && attempt<STATE_RENAME_ATTEMPTS) { sleepSync(20*attempt); continue; }
      fs.rmSync(temp,{force:true});
      throw e;
    }
  }
  syncDirectory(path.dirname(file));
}

/** The temp files `saveState` writes (`state.json.tmp` is the name older versions used). */
const STATE_TEMP_FILE = /^state\.json(?:\.\d+)?\.tmp$/;

/**
 * Removes the temp files a crashed writer left next to `state.json`.
 *
 * A temp file is never a committed state: the rename is the commit point, so
 * a temp file that was not renamed belongs to a save that did not happen.
 * Only the holder of the data directory lock calls this, before its first
 * save, so the files cannot belong to a live writer. `state.json` itself and
 * every other file (the migration backup `state.json.bak` included) are left
 * alone.
 *
 * @returns {string[]} the names of the removed files
 */
export function removeStateTempFiles(dir = dataDir()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const name of names) {
    if (!STATE_TEMP_FILE.test(name)) continue;
    fs.rmSync(path.join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * Writes the state to `state.json`.
 *
 * The JSON file stays the SOURCE OF TRUTH. The SQLite metadata layer
 * (ATS-205) is a MIRROR of it: the same state is written into the
 * metadata database as queryable rows, so the history of the projects and
 * the runs can be queried without parsing the JSON.
 *
 * The file is written DURABLY (`writeFileDurably`): a crash or a power cut
 * leaves the previous or the new complete file, never a torn one.
 *
 * The mirror is best-effort on purpose: a bridge that cannot open the
 * metadata database still has to serve the API, so a failure of the mirror
 * is reported on stderr and the JSON file remains authoritative. It is
 * never the other way round -- the mirror can never break the bridge.
 */
export function saveState(v) {
  ensureData();
  writeFileDurably(path.join(dataDir(),'state.json'),JSON.stringify(v,null,2));
  mirrorToSqlite(v);
}

/**
 * The metadata mirror is BEST-EFFORT, and a failure is not permanent.
 *
 * The JSON state file is the source of truth, so a failure of the mirror
 * must never take the bridge down -- but it must also never LOSE records.
 * The earlier revision of this module set a flag on the FIRST failure and
 * never wrote the mirror again for the lifetime of the process: one
 * transient failure (a concurrent writer holding the database lock, a full
 * disk, an antivirus scanner holding the file) silently dropped every
 * later project, run, attempt and artifact from SQLite. The mirror writes
 * the WHOLE state in one transaction, so a retry is self-healing: the next
 * successful write replaces the whole table set and the mirror catches up.
 *
 * The only failure that disables the mirror for good is
 * `SQLITE_NOT_AVAILABLE` -- the running Node build has no `node:sqlite`
 * at all, and no retry can change that.
 */

/** True when the Node build has no SQLite support at all: the mirror is off. */
let metaDbUnavailable = false;

/** The path of the metadata database inside the data directory. */
export const metadataPath = (dir = dataDir()) => path.join(dir, 'metadata.db');

/**
 * The busy timeout of the MIRROR connection, in milliseconds.
 *
 * The mirror runs SYNCHRONOUSLY on the bridge's event loop, so the wait
 * for a write lock has to be BOUNDED, and the bound has to be SHORT: a
 * mirror that waits for the layer's default 5000 ms blocks the event loop
 * for five seconds, and during those five seconds the bridge does not
 * answer a single request -- `GET /api/health` waited 5274 ms in the
 * measurement that motivated this value.
 *
 * The mirror therefore uses a SHORT timeout (1 second). When it expires
 * the mirror write is abandoned and the NEXT save tries again: the mirror
 * replaces the whole table set in one transaction, so a retry is
 * self-healing and the mirror catches up as soon as the obstruction is
 * gone. The state file is the truth and it is written before the mirror
 * runs, so nothing is lost by giving up on a write.
 *
 * §5.3 of the data design states this as the bound on how long a single
 * `saveState` can block the bridge.
 */
export const MIRROR_BUSY_TIMEOUT_MS = 1000;

/**
 * Writes the state into the metadata database.
 *
 * The database is opened for the write and closed again right after it.
 * The handle is deliberately NOT kept open: on Windows an open file
 * cannot be deleted, and a bridge that holds the metadata database open
 * would keep the data directory locked for every tool that tries to
 * clean it up. Opening a SQLite database is cheap, and the state is
 * written a handful of times per run.
 *
 * A failure is retried on the NEXT save: the write replaces the whole
 * table set, so the mirror heals itself as soon as the obstruction is
 * gone.
 *
 * @returns {boolean} true when the state was mirrored
 */
export function mirrorToSqlite(v) {
  if (metaDbUnavailable) return false;
  let db = null;
  try {
    db = openMetadataDatabase(metadataPath(), { busyTimeoutMs: MIRROR_BUSY_TIMEOUT_MS });
    storeState(db, v);
    return true;
  } catch (e) {
    // A mirror failure must not take the bridge down: the JSON state file
    // is the truth and it was written already.
    if (e?.code === 'SQLITE_NOT_AVAILABLE') {
      // The Node build has no SQLite at all. No retry can change that, so
      // the mirror stays off for the lifetime of the process.
      metaDbUnavailable = true;
    }
    console.error(`the SQLite metadata mirror failed: ${e.message}`);
    return false;
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }
}

/** SQLite primary result codes that mean the file is damaged, not busy or newer. */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/**
 * Checks the metadata mirror at start-up and moves a DAMAGED one aside.
 *
 * Opening the database is SQLite's own crash recovery: the committed frames
 * of the WAL are applied and an interrupted transaction is discarded.
 * `PRAGMA quick_check` then tells whether the file is sound.
 *
 * The mirror is derived data -- `state.json` is the truth -- so a damaged
 * mirror is not repaired in place. It is moved aside TOGETHER with its `-wal`
 * and `-shm` files (a stale WAL must never be replayed into a new database),
 * and the next `saveState` rebuilds the mirror from the state file. The
 * damaged copy is kept for inspection.
 *
 * Only damage leads to the move. A mirror that cannot be checked for another
 * reason (a newer schema, a lock held by another process, a path that is not
 * a file) is left alone and reported.
 *
 * @returns {{status:'absent'|'ok'|'quarantined'|'quarantine-failed'|'unchecked'|'unavailable', file:string, reason?:string, moved?:string[]}}
 */
export function recoverMetadataMirror(file = metadataPath()) {
  if (!fs.existsSync(file)) return { status: 'absent', file };
  let db = null;
  let problem = null;
  try {
    db = openMetadataDatabase(file, { busyTimeoutMs: MIRROR_BUSY_TIMEOUT_MS, migrate: false });
    const verdict = db.prepare('PRAGMA quick_check').all().map((row) => String(Object.values(row)[0]));
    if (verdict.length !== 1 || verdict[0] !== 'ok') problem = verdict.slice(0, 5).join('; ');
  } catch (e) {
    if (e?.code === 'SQLITE_NOT_AVAILABLE') return { status: 'unavailable', file };
    const primary = Number(e?.errcode) & 0xff;
    if (primary !== SQLITE_CORRUPT && primary !== SQLITE_NOTADB) return { status: 'unchecked', file, reason: e.message };
    problem = e.message;
  } finally {
    if (db) { try { db.close(); } catch { /* already closed */ } }
  }
  if (problem === null) return { status: 'ok', file };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const moved = [];
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (!fs.existsSync(file + suffix)) continue;
      const target = `${file}.corrupt-${stamp}${suffix}`;
      fs.renameSync(file + suffix, target);
      moved.push(target);
    }
  } catch (e) {
    return { status: 'quarantine-failed', file, reason: `${problem}; the damaged file could not be moved aside (${e.message})`, moved };
  }
  return { status: 'quarantined', file, reason: problem, moved };
}

/* ------------------------------------------------------------------ */
/* Data directory lock                                                */
/* ------------------------------------------------------------------ */

/**
 * The lock file of the data directory.
 *
 * The state file and the run folders are ONE piece of state: the Bridge
 * writes `state.json` and renames the run folders, and the migration script
 * rewrites both. When the two run at the same time, the Bridge overwrites
 * the migrated `state.json` with its own in-memory copy -- which still holds
 * the OLD identifiers -- while the folders on disk are already renamed. The
 * result is a state that points at run folders that no longer exist.
 *
 * The lock is therefore EXCLUSIVE and it is held for the whole lifetime of
 * the Bridge, and for the whole duration of a migration. The migration
 * refuses to run while the Bridge holds it, and the Bridge refuses to start
 * while a migration holds it.
 */
export const lockPath = (dir = dataDir()) => path.join(dir, 'bridge.lock');

/** True when the process is still running. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/**
 * The start time of a process, as the operating system reports it.
 *
 * The start time is what makes a process identifier VERIFIABLE: a pid alone
 * does not identify a process, because the operating system reuses pids. The
 * pair (pid, start time) does -- as long as both are read with the same
 * source, the same process always yields the same value.
 *
 * Returns null when the process does not exist or when the platform cannot
 * report the value.
 */
export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString("o")`
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const out = (r.stdout ?? '').trim();
    return out || null;
  }
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 10000 });
  const out = (r.stdout ?? '').trim();
  return out || null;
}

/**
 * The start time of THIS process, read once.
 *
 * It never changes for the lifetime of the process, and on Windows reading
 * it spawns PowerShell (hundreds of milliseconds). Memoising it keeps the
 * acquisition fast and -- more importantly -- keeps the slow step OUT of the
 * window between "the lock is free" and "the lock is mine".
 */
let ownStartTime;
export function ownProcessStartTime() {
  if (ownStartTime === undefined) ownStartTime = processStartTime(process.pid);
  return ownStartTime;
}

/** The tokens of the locks THIS process published, keyed by resolved path. */
const heldLocks = new Map();

/**
 * How often an acquirer retries a lock that keeps CHANGING under it (it
 * vanished, it was stale and got taken over, a transient filesystem error)
 * before it gives up with `reason: 'contended'`. Waiting for a live holder
 * does not consume this budget; `waitMs` bounds the wait.
 */
export const LOCK_MAX_ATTEMPTS = 50;
/** The default poll interval of an acquirer that waits for a live holder. */
export const LOCK_POLL_MS = 100;
/** The default interval of the Bridge's holder check (`ATS_LOCK_VERIFY_MS`). */
export const LOCK_VERIFY_DEFAULT_MS = 5000;
/** The shortest holder-check interval the Bridge accepts. */
export const LOCK_VERIFY_MIN_MS = 50;

/** Errors of a filesystem that has no hard links: publication falls back to an exclusive create. */
const NO_HARD_LINK = new Set(['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EINVAL']);

/** Filesystem errors that are worth one more attempt (Windows sharing violations). */
const TRANSIENT_FS = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** `ATS_LOCK_WAIT_MS`: a non-negative integer; anything else means "do not wait". */
export function lockWaitFromEnv(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 0;
}

/** `ATS_LOCK_VERIFY_MS`: a non-negative integer with a floor; anything else is the default. */
export function lockVerifyIntervalFromEnv(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return LOCK_VERIFY_DEFAULT_MS;
  return Math.max(LOCK_VERIFY_MIN_MS, Number(value));
}

/** A non-negative integer option, or the fallback for anything else. */
function nonNegativeInt(value, fallback) {
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** The lock record in `text`, or null when it is not one. */
function parseLockRecord(text) {
  try {
    const raw = JSON.parse(text);
    return raw && typeof raw === 'object' && Number.isInteger(raw.pid) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The live holder a record names, or null when the record cannot be
 * attributed to a live holder (dead pid, or a pid reused by another process).
 */
function liveHolder(raw, startTimes = null) {
  if (!raw || !isProcessAlive(raw.pid)) return null;
  // The holder is alive. Is it the process that took the lock?
  if (raw.processStartedAt) {
    // A waiting acquirer re-checks the same holder many times; its start time
    // is read once per acquisition (on Windows each read spawns PowerShell).
    let current;
    if (raw.pid === process.pid) current = ownProcessStartTime();
    else if (startTimes?.has(raw.pid)) current = startTimes.get(raw.pid);
    else {
      current = processStartTime(raw.pid);
      startTimes?.set(raw.pid, current);
    }
    // The pid is alive but its start time is not the recorded one: the pid
    // was reused by another process, so the lock is stale.
    if (current !== null && current !== raw.processStartedAt) return null;
  }
  return raw;
}

/**
 * The holder of the lock, or null when the lock is free.
 *
 * A lock is free when it cannot be attributed to a live holder:
 *
 *   * the file does not exist, or it cannot be parsed;
 *   * the recorded pid is gone -- the process was killed and left the file
 *     behind. That is a STALE lock, and it does not block anybody;
 *   * the recorded pid is alive but it is a DIFFERENT process than the one
 *     that took the lock -- the pid was reused. That is a STALE lock too, and
 *     it does not block anybody.
 *
 * The last case is the reason the lock records the start time of the holder:
 * without it, a reused pid looks exactly like a live holder and a leftover
 * lock file keeps the Bridge from starting.
 *
 * A lock that carries no verifiable identity -- one written by an older
 * version, or by hand -- is reported as HELD: its holder cannot be told from
 * a reused pid, and the state it guards may really be in use. The caller
 * answers such a lock with the recovery steps, not with a guess.
 */
export function readBridgeLock(file = lockPath()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return null; }
  return liveHolder(parseLockRecord(text));
}

/**
 * Publishes the complete record as the lock file -- or reports that the lock
 * exists.
 *
 * The record is written to a private temp file first and then LINKED into
 * place. `link` fails with EEXIST when the name exists, so of two processes
 * that publish at the same instant exactly one succeeds, and the lock file
 * never exists empty or half-written (a reader can never mistake a lock that
 * is being written for a garbage, stale one).
 *
 * A filesystem without hard links (FAT, some network shares) falls back to an
 * exclusive create (`wx`). That is still atomic between two creators; only
 * the "never half-written" property is weaker there.
 *
 * @returns {boolean} true when this call published the lock
 */
function publishLock(file, body) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, body, { encoding: 'utf8', flag: 'wx' });
  try {
    try {
      fs.linkSync(temp, file);
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      if (!NO_HARD_LINK.has(e.code)) throw e;
    }
    try {
      fs.writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Puts a displaced lock back -- without ever overwriting a newer one. */
function restoreLock(aside, file, text) {
  try {
    fs.linkSync(aside, file);
    return;
  } catch (e) {
    // EEXIST: a newer lock was published meanwhile. It is kept; the displaced
    // holder detects the loss with verifyBridgeLock() and stops.
    if (!NO_HARD_LINK.has(e.code) || text === null) return;
  }
  try { fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' }); }
  catch { /* a newer lock was published meanwhile; it is kept */ }
}

/**
 * Removes a lock that was judged STALE -- and only that lock.
 *
 * Deleting the file by name would be a race: between "this lock is stale"
 * and the delete, another process may have taken it over and published a
 * FRESH lock under the same name, and the delete would remove a live
 * holder's lock. So the file is first RENAMED to a name only this process
 * uses, and the bytes that were moved are compared with the bytes that were
 * judged stale:
 *
 *   * identical: the stale lock is out of the way and is deleted;
 *   * different: a live process published a lock in between. It is put back
 *     (`link`, which never overwrites) and the caller sees the lock as held.
 *
 * Exported for the race tests; the Bridge and the tools call
 * acquireBridgeLock().
 *
 * @returns {boolean} true when the stale lock was removed
 */
export function takeOverStaleLock(file, staleText) {
  const aside = `${file}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(file, aside);
  } catch (e) {
    // Somebody else moved it first: nothing of ours to clean up.
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  let moved = null;
  try { moved = fs.readFileSync(aside, 'utf8'); } catch { moved = null; }
  if (moved === staleText) {
    fs.rmSync(aside, { force: true });
    return true;
  }
  restoreLock(aside, file, moved);
  fs.rmSync(aside, { force: true });
  return false;
}

function lockHeldError(holder, startedMs, reason) {
  const e = new Error('BRIDGE_ALREADY_RUNNING');
  e.code = 'BRIDGE_ALREADY_RUNNING';
  e.holder = holder;
  e.reason = reason;
  e.waitedMs = Date.now() - startedMs;
  return e;
}

/**
 * Acquires the exclusive lock of the data directory.
 *
 * Throws `BRIDGE_ALREADY_RUNNING` (with `holder`, `reason` and `waitedMs`)
 * when a live process holds it -- at once, or after `waitMs` milliseconds of
 * re-checking every `pollMs`. A stale lock (dead holder, reused pid) is taken
 * over. The acquisition is ATOMIC: of any number of processes that try at the
 * same instant, exactly one gets the lock.
 *
 * @param {string} [file]
 * @param {object} [options]
 * @param {number} [options.waitMs=0] how long to wait for a live holder
 * @param {number} [options.pollMs=100] the re-check interval while waiting
 * @param {boolean} [options.createDir=true] false: do not recreate a missing directory
 * @returns {string} the lock file
 */
export function acquireBridgeLock(file = lockPath(), options = {}) {
  const waitMs = nonNegativeInt(options.waitMs, 0);
  const pollMs = Math.max(1, nonNegativeInt(options.pollMs, LOCK_POLL_MS));
  if (options.createDir !== false) fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID();
  // The record is complete BEFORE the first attempt: the start time (slow on
  // Windows) is read here, not between "free" and "mine".
  const body = JSON.stringify({
    pid: process.pid,
    startedAt: now(),
    processStartedAt: ownProcessStartTime(),
    token
  });
  const startedMs = Date.now();
  const deadline = startedMs + waitMs;
  let churn = 0;
  let lastSeen = null;
  const startTimes = new Map();
  for (;;) {
    let published;
    try {
      published = publishLock(file, body);
    } catch (e) {
      if (!TRANSIENT_FS.has(e.code) || ++churn >= LOCK_MAX_ATTEMPTS) throw e;
      sleepSync(10);
      continue;
    }
    if (published) {
      heldLocks.set(path.resolve(file), token);
      return file;
    }
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
    if (text !== null) {
      const raw = parseLockRecord(text);
      lastSeen = raw;
      const holder = liveHolder(raw, startTimes);
      if (holder) {
        const left = deadline - Date.now();
        if (left <= 0) throw lockHeldError(holder, startedMs, 'held');
        sleepSync(Math.min(pollMs, left));
        continue;
      }
      try { takeOverStaleLock(file, text); }
      catch (e) { if (!TRANSIENT_FS.has(e.code)) throw e; }
    }
    // The lock vanished or was stale: publish again -- within a budget, so a
    // lock that keeps changing cannot spin this loop for ever.
    if (++churn >= LOCK_MAX_ATTEMPTS) throw lockHeldError(lastSeen, startedMs, 'contended');
  }
}

/**
 * Whether this process still holds the lock it acquired.
 *
 * The answer comes from the token this process published, not from the pid:
 * the file holds our token, or somebody replaced it.
 *
 * @returns {{held:boolean, reason:'held'|'absent'|'taken-over'|'unreadable'|'not-acquired', holder:object|null}}
 */
export function verifyBridgeLock(file = lockPath()) {
  const token = heldLocks.get(path.resolve(file));
  if (!token) return { held: false, reason: 'not-acquired', holder: null };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { held: false, reason: e.code === 'ENOENT' ? 'absent' : 'unreadable', holder: null };
  }
  const raw = parseLockRecord(text);
  if (!raw) return { held: false, reason: 'unreadable', holder: null };
  if (raw.token === token && raw.pid === process.pid) return { held: true, reason: 'held', holder: raw };
  return { held: false, reason: 'taken-over', holder: raw };
}

/**
 * Releases the lock -- but only when this process is the holder.
 *
 * A record with a token is ours when it carries the token this process
 * published; a legacy record without a token is ours when it carries our
 * pid. Another holder's lock is never removed.
 *
 * @returns {boolean} true when the lock file was removed
 */
export function releaseBridgeLock(file = lockPath()) {
  const key = path.resolve(file);
  const token = heldLocks.get(key);
  let raw = null;
  try { raw = parseLockRecord(fs.readFileSync(file, 'utf8')); } catch { raw = null; }
  const ours = raw !== null && raw.pid === process.pid
    && (raw.token === undefined || (token !== undefined && raw.token === token));
  if (!ours) return false;
  fs.rmSync(file, { force: true });
  heldLocks.delete(key);
  return true;
}
export function validateProjectPath(input) {
  if(typeof input!=='string'||input.length>1024) throw new Error('INVALID_PROJECT_PATH');
  const actual=fs.realpathSync(path.resolve(input));
  if(!fs.statSync(actual).isDirectory()) throw new Error('NOT_A_DIRECTORY');
  if(!fs.existsSync(path.join(actual,'package.json'))) throw new Error('PROJECT_PACKAGE_JSON_REQUIRED');
  if(!fs.readdirSync(actual).some(n=>/^playwright\.config\.[cm]?[jt]s$/.test(n))) throw new Error('PLAYWRIGHT_CONFIG_REQUIRED');
  return actual;
}
export function gitInfo(root) {
  function git(...args) {let a=spawnSync('git',['-C',root,...args],{encoding:'utf8',timeout:4000});return a.status===0?a.stdout.trim():'';}
  return {branch:git('branch','--show-current')||'detached / none',commit:git('rev-parse','--short','HEAD')||'untracked',dirty:Boolean(git('status','--porcelain'))};
}

export function sourcePath(project,relative) {
  if(typeof relative!=='string'||relative.length>500 || !/\.(spec|test)\.[cm]?[jt]sx?$/.test(relative)) throw new Error('INVALID_SOURCE_FILE');
  const joined=path.resolve(project.root,relative);
  if(!isSubpath(project.root,joined)) throw new Error('PATH_OUTSIDE_PROJECT');
  const actual=fs.realpathSync(joined);
  if(!isSubpath(project.root,actual)||!fs.statSync(actual).isFile())throw new Error('PATH_OUTSIDE_PROJECT');
  if(fs.statSync(actual).size>1_000_000) throw new Error('SOURCE_TOO_LARGE');
  return actual;
}
export function readSource(project,relative) {const f=sourcePath(project,relative); const content=fs.readFileSync(f,'utf8');return {file:relative, content, hash:sha(content)};}
export function writeSource(project,relative,content,baseHash) {
  if(typeof content!=='string'||Buffer.byteLength(content)>1_000_000||typeof baseHash!=='string')throw new Error('INVALID_SOURCE_UPDATE');
  const p=sourcePath(project,relative),before=fs.readFileSync(p,'utf8');
  if(sha(before)!==baseHash)throw new Error('STALE_EDIT_CONFLICT');
  fs.writeFileSync(p,content,'utf8');return {file:relative,hash:sha(content),changed:before!==content};
}
export function walkTests(root,rel='',depth=0,acc=[]) {
  if(depth>14||acc.length>2000)return acc;
  const dir=path.join(root,rel);
  for(const ent of fs.readdirSync(dir,{withFileTypes:true})) {
    if(['node_modules','.git','.next','out','dist','target','test-results','playwright-report','.aitest-studio','coverage'].includes(ent.name))continue;
    const child=path.join(rel,ent.name);
    if(ent.isDirectory())walkTests(root,child,depth+1,acc);
    else if(ent.isFile()&&/\.(spec|test)\.[cm]?[jt]sx?$/.test(ent.name))acc.push(child.replace(/\\/g,'/'));
  }return acc;
}
/**
 * ATS-602: the mobile cases of a project.
 *
 * A Flow file declares cases like a spec file declares cases, so the
 * mobile cases are part of the SAME catalogue. They are TestDefinitions
 * with a `source` that says where they came from -- the UID rules, the
 * registry and every lookup by file/line work on them unchanged.
 *
 * The import is SEPARATE from the static scan for a reason that is not
 * tidiness: the two read different things and fail differently. A spec
 * file that cannot be parsed is a broken test file; a Flow file that
 * cannot be parsed is a Flow with a step the platform cannot run, and the
 * answer to that is the IMPORT REPORT, not an exception that takes the
 * whole discovery down.
 *
 * So a Flow that fails to import contributes NO cases and reports its
 * problem in `mobile.imports`; the rest of the catalogue is unaffected.
 */
export function discoverMobile(project, registry, projectUid) {
  const imported=importProjectFlows(project.root,{projectUid,registry});
  const cases=imported.cases.map(c=>({
   id:c.uid,uid:c.uid,uidSource:c.uidSource,uidStable:c.uidStable,
   uidBasis:c.uidBasis,
   file:c.file,title:c.title,line:c.line,
   source:'mobile',engine:'mobile',level:'ST',
   appId:c.appId,tags:c.tags,
   steps:c.steps,
   unsupportedCount:c.unsupportedCount,
   ...(c.ambiguity?{ambiguity:c.ambiguity}:{})
  }));
  return {
   cases,
   files:imported.files,
   imports:imported.results.map(r=>r.report),
   unsupported:imported.unsupported,
   errors:imported.errors,
  };
}

export function discoverStatic(project, registry) {
 const files=walkTests(project.root);const discovered=[];
 for(const file of files){
   const content=fs.readFileSync(path.join(project.root,file),'utf8');
   for(const c of scanTestCases(content))discovered.push({file,...c});
 }
 const projectUid=projectUidOf(project);
 // The scope of this discovery is the set of files it covered. The registry
 // only prunes entries whose file is INSIDE the scope: a file that is not part
 // of this discovery says nothing about the cases inside it, and pruning its
 // entries would drop the identity of a case that still exists.
 const resolved=resolveIdentities({projectUid,discovered,registry,scope:new Set(files)});
 const tests=resolved.items.map(t=>({
   id:t.uid,uid:t.uid,uidSource:t.uidSource,uidStable:t.uidStable,
   file:t.file,title:t.title,line:t.line,source:'static',level:'ST',
   ...(t.ambiguity?{ambiguity:t.ambiguity}:{})
 }));
 // ATS-602: the MOBILE cases. A Flow file declares cases like a spec file
 // declares cases, so the mobile cases are part of the SAME catalogue --
 // they are TestDefinitions with a `source` that says where they came
 // from. They are NOT a second kind of case: the UID rules, the registry
 // and every lookup by file/line work on them unchanged.
 const mobile=discoverMobile(project,registry,projectUid);
 // The mobile cases JOIN the catalogue: a Flow file declares cases, and a
 // case is a case. They carry their own `source`, so a reader can tell
 // where a case came from, and the UID rules work on them unchanged.
 const allTests=[...tests,...mobile.cases];
 const ambiguous=allTests.filter(t=>!t.uidStable).length;
 // Every kind of uncertainty is REPORTED. A case that got a uid but whose
 // registry entry disagreed with it is reported as well: the uid is usable,
 // but the memory of the past cases is inconsistent and a reader has to know.
 const conflicts=allTests.filter(t=>t.ambiguity&&t.ambiguity.reason!=='identical-title'&&t.ambiguity.reason!=='identical-title-and-body');
 const duplicatedExplicit=allTests.filter(t=>t.ambiguity?.reason==='duplicate-explicit-uid').length;
 // The static index is the HEURISTIC one: it sees the literal test()/it()
 // calls and nothing else. The authoritative index (`playwright test
 // --list`) sees the dynamic and parameterised cases too, but it EXECUTES
 // the project's code, so it only runs on a project the user has vouched
 // for. The warning therefore points at the way to get it, not at the raw
 // command.
 let warning='静态索引仅识别常见 test()/it() 形式；动态、参数化、fixture 测试不在其中。';
 if(ambiguous)warning+=` ${ambiguous} 个用例的 UID 为临时值（标题重复且无法唯一判定），需要用 @TC-xxx 显式标注或人工复核。`;
 if(duplicatedExplicit)warning+=` ${duplicatedExplicit} 个用例标注了同一个 @TC-xxx（重复的显式 UID），这些用例都没有绑定到该 UID，需要人工消歧。`;
 if(conflicts.length)warning+=` ${conflicts.length} 个用例的注册表记录与本次发现不一致（${[...new Set(conflicts.map(t=>t.ambiguity.reason))].join('、')}），其 UID 由本次发现派生，需要人工复核。`;
 // ATS-602: the mobile import reports itself. A step the platform cannot
 // run is NOT silently dropped -- it is counted here and listed in the
 // import report, so the author of the Flow learns which of their steps
 // the platform does not support yet.
 if(mobile.cases.length)warning+=` 移动端 Flow 导入 ${mobile.cases.length} 个用例（${mobile.files.length} 个文件）。`;
 if(mobile.unsupported.length)warning+=` ${mobile.unsupported.length} 个移动端步骤不受支持，已保留原文并记录在导入报告中。`;
 if(mobile.errors.length)warning+=` ${mobile.errors.length} 个移动端 Flow 读取错误，详见导入报告。`;
 return {
  files,
  tests:allTests,
  discovery:'static',
  uidVersion:UID_SCHEME_VERSION,
  projectUid,
  registry:resolved.registry,
  warning,
  mobile:{
   files:mobile.files,
   cases:mobile.cases.length,
   unsupportedSteps:mobile.unsupported.length,
   errors:mobile.errors.length,
   imports:mobile.imports,
  }
 };
}

/**
 * The decision the TRUST and the REQUEST make together.
 *
 * The trust says whether the authoritative index is ALLOWED; the request
 * (`?authoritative=`) says whether it is WANTED. Three situations:
 *
 * | trust   | request          | index   | outcome              |
 * |---------|------------------|---------|----------------------|
 * | trusted | default / `true` | auth.   | the listing runs     |
 * | trusted | `false`          | static  | `NOT_REQUESTED`      |
 * | untrusted| default / `true`| static  | `SKIPPED_UNTRUSTED`  |
 *
 * The third row is the trust gate: a FORCE never overrides it.
 *
 * The second row used to be reported as `SKIPPED_UNTRUSTED` as well, which
 * told the user that a project they had vouched for was not vouched for.
 * The project IS trusted; the caller simply asked for the static index. The
 * two situations need different codes, because the user's next action is
 * different: one needs a vouch, the other needs no action at all.
 */
function decideDiscovery(trust, force) {
  const trusted = trust.trust === TRUST.TRUSTED;
  if (!trusted) {
    return { wantsAuthoritative: false, mode: 'untrusted', forced: force === true };
  }
  if (force === false) {
    return { wantsAuthoritative: false, mode: 'not-requested', forced: false };
  }
  return { wantsAuthoritative: true, mode: force === true ? 'forced' : 'default', forced: force === true };
}

/**
 * The static answer, with the reason the authoritative index was not used.
 *
 * The warning says what actually happened. A project that is not trusted
 * gets the trust gate; a TRUSTED project that asked for the static index
 * gets a plain note that the request was honoured -- it must not be told
 * that it is not trusted, because it is.
 *
 * The `fallback` mode is the third case: the listing was ALLOWED and it
 * FAILED. The project is trusted, so the trust gate does not apply and the
 * warning must not mention it -- the caller says what actually went wrong.
 */
function staticCatalog(project, registry, trust, decision) {
  const base = {
    ...discoverStatic(project, registry),
    trust,
    authoritative: {
      attempted: false,
      outcome: decision.mode === 'untrusted' ? 'SKIPPED_UNTRUSTED' : 'NOT_REQUESTED',
      reason: decision.mode === 'untrusted' ? trust.reason : ''
    }
  };
  if (decision.mode === 'not-requested') {
    return {
      ...base,
      discovery: DISCOVERY.STATIC,
      warning: `${base.warning} 已按请求使用静态索引（该项目已标记为可信，改用权威索引请去掉 authoritative 参数）。`
    };
  }
  if (decision.mode === 'fallback') {
    // The listing was allowed and it failed. The trust gate does not apply
    // here, so the warning must not talk about it.
    return { ...base, discovery: DISCOVERY.STATIC, warning: base.warning };
  }
  // The untrusted project never runs `--list`. The reason is part of the
  // answer -- and so is the way to get the authoritative index, which is
  // to vouch for the project (the decision is per project and revocable).
  //
  // The forced case (`?authoritative=true`) and the default case get the
  // SAME answer: the force says WHICH index to use, the trust says whether
  // it is ALLOWED to, and the trust wins.
  return {
    ...base,
    discovery: DISCOVERY.STATIC,
    warning: `${base.warning} 未可信仓库不可调用 --list（${trust.reason}），已使用静态索引；`
      + `把该仓库标记为可信（POST /api/projects/:id/trust {trust:"trusted"}）后即可使用权威索引。`
  };
}

/**
 * Discovers the test cases of a project: the STATIC index or the
 * AUTHORITATIVE one (`playwright test --list`), whichever the trust allows.
 *
 * WHY THE TRUST DECIDES
 * ---------------------
 * `playwright test --list` is NOT a read-only operation. It LOADS the project
 * config (executing the config's top level) and it EVALUATES the test files
 * (executing their top level) in order to collect the cases. Running it on a
 * repository therefore means RUNNING that repository's code -- the same trust
 * boundary as `playwright test` itself (ADR-005, docs/11-SECURITY-RISK.md).
 *
 * The difference is the TRIGGER. A run happens because the user asked for
 * it; an index is read whenever the catalogue is opened. An index that
 * silently executed code would turn "browse the catalogue" into "run the
 * repository's code", so the index only runs `--list` on a project the user
 * has vouched for.
 *
 * Therefore:
 *   * a TRUSTED project   -> the authoritative index (`discovery:
 *     'authoritative'`), which includes the dynamic and parameterised cases;
 *   * an UNTRUSTED project -> the STATIC index (`discovery: 'static'`), and
 *     the response says WHY the authoritative index was not used.
 *
 * The fallback is a fallback, not a failure: the user still gets an index,
 * and the index says plainly that it is the heuristic one.
 *
 * WHAT "与 CLI 发现结果一致" MEANS HERE
 * ------------------------------------
 * The agreement is MEASURED, not asserted: the two case lists are compared
 * case by case and the difference is reported in `consistency`. A case that
 * only the CLI knows is a dynamic case; a case that only the static scanner
 * knows is a case the CLI does not enumerate.
 *
 * THE TWO VARIANTS
 * -----------------
 * `discoverTests` runs the listing SYNCHRONOUSLY; `discoverTestsAsync` runs
 * it asynchronously. Both build the catalogue with the SAME code, so the
 * two answers differ in nothing but the timing.
 *
 * The Bridge uses the asynchronous one: the listing executes the project's
 * config, and a project whose config takes four seconds would otherwise
 * freeze the whole Bridge for those four seconds -- including the health
 * check and the stop button of a running test.
 */
export function discoverTests(project, state, registry, options = {}) {
  const trust = trustOf(state, project);
  const decision = decideDiscovery(trust, options.authoritative);
  if (!decision.wantsAuthoritative) {
    return staticCatalog(project, registry, trust, decision);
  }
  const listed = listTests(project, { timeoutMs: options.timeoutMs });
  return authoritativeCatalog(project, registry, trust, decision, listed);
}

/**
 * The asynchronous variant of `discoverTests`.
 *
 * The Bridge calls this one: the listing is a CHILD PROCESS that runs the
 * project's own code, and it may take a long time. Awaiting it keeps the
 * event loop free, so the Bridge keeps answering while a project is listed.
 */
export async function discoverTestsAsync(project, state, registry, options = {}) {
  const trust = trustOf(state, project);
  const decision = decideDiscovery(trust, options.authoritative);
  if (!decision.wantsAuthoritative) {
    return staticCatalog(project, registry, trust, decision);
  }
  const listed = await listTestsAsync(project, { timeoutMs: options.timeoutMs });
  return authoritativeCatalog(project, registry, trust, decision, listed);
}

/**
 * The authoritative answer: the catalogue of the CLI's own case list, with
 * the UIDs resolved and the agreement with the static index measured.
 */
function authoritativeCatalog(project, registry, trust, decision, listed) {
  if (!listed.ok) {
    const base = staticCatalog(project, registry, trust, { ...decision, mode: 'fallback', wantsAuthoritative: false });
    const detail = listed.errors && listed.errors.length ? ` — ${listed.errors[0].message}` : '';
    return {
      ...base,
      discovery: DISCOVERY.STATIC,
      authoritative: {
        attempted: true,
        outcome: listed.outcome,
        reason: listed.reason,
        errors: listed.errors || [],
        cli: listed.cli || null,
        version: listed.version || null
      },
      warning: `${base.warning} 权威发现失败（${listed.outcome}）：${listed.reason}${detail}，已回退到静态索引。`
    };
  }

  // The authoritative case list, with the UIDs resolved.
  const files = listed.files;
  const bodies = readBodies(project.root, files);
  const projectUid = projectUidOf(project);
  const projectRegistry = (registry && registry.projects && registry.projects[projectUid]) || { version: UID_SCHEME_VERSION, entries: [] };
  const resolved = resolveAuthoritativeIdentities({
    projectUid,
    cases: listed.tests,
    bodies,
    registry: projectRegistry,
    scope: new Set(files)
  });

  const tests = resolved.items.map(t => ({
    id: t.uid, uid: t.uid, uidSource: t.uidSource, uidStable: t.uidStable,
    uidBasis: t.basis,
    file: t.file, title: t.title, line: t.line,
    describePath: t.scope,
    specIds: t.specIds,
    // ATS-204: the anchor of the case. It is what a case that has no body
    // of its own is remembered BY: the position it was reported at plus
    // its ordinal there.
    anchor: t.anchor ?? null,
    source: 'authoritative', level: 'ST',
    ...(t.ambiguity ? { ambiguity: t.ambiguity } : {})
  }));

  const consistency = compareDiscoveries(listed.tests, staticCasesWithScope(project.root, files));
  const ambiguous = tests.filter(t => !t.uidStable).length;
  const duplicatedExplicit = tests.filter(t => t.ambiguity?.reason === 'duplicate-explicit-uid').length;
  const outside = (listed.skipped && listed.skipped.length) || 0;
  // ATS-204: the cases whose anchor could not decide them -- a template
  // that gained or lost a render, so the ordinals may have moved.
  const shifted = tests.filter(t => t.ambiguity?.reason === 'render-shift-possible').length;

  let warning = `权威索引来自 playwright test --list（CLI ${listed.version || '?'}）：动态与参数化用例已包含在内。`;
  if (ambiguous) warning += ` ${ambiguous} 个用例的 UID 为临时值（标题与 describe 路径都无法唯一判定），需要用 @TC-xxx 显式标注或人工复核。`;
  if (duplicatedExplicit) warning += ` ${duplicatedExplicit} 个用例标注了同一个 @TC-xxx，这些用例都没有绑定到该 UID，需要人工消歧。`;
  if (shifted) warning += ` ${shifted} 个用例的模板渲染数发生了变化（${[...new Set(tests.filter(t => t.ambiguity?.reason === 'render-shift-possible').map(t => t.ambiguity.previousCount + '→' + t.ambiguity.currentCount))].join('、')}），锚点次序可能已经位移，这些用例的 UID 由本次发现派生，需要人工复核。`;
  if (outside) warning += ` ${outside} 个用例位于项目根目录之外，已被排除。`;
  if (!consistency.agrees) warning += ` 与静态索引的差异：${consistency.onlyAuthoritative.length} 个用例仅权威索引可见，${consistency.onlyStatic.length} 个用例仅静态索引可见。`;

  return {
    files,
    tests,
    discovery: DISCOVERY.AUTHORITATIVE,
    uidVersion: resolved.registry.version,
    projectUid,
    registry: { version: resolved.registry.version, projects: { ...((registry && registry.projects) || {}), [projectUid]: resolved.registry } },
    warning,
    trust,
    authoritative: {
      attempted: true,
      outcome: LIST_OUTCOME.OK,
      reason: '',
      cli: listed.cli,
      version: listed.version,
      rootDir: listed.rootDir,
      durationMs: listed.durationMs,
      specCount: listed.tests.length
    },
    consistency
  };
}
export function resolvePlaywright(project) {
 const candidates=['node_modules/@playwright/test/cli.js','node_modules/playwright/cli.js','node_modules/playwright-core/cli.js'];
 for(const c of candidates){const p=path.join(project.root,c);if(fs.existsSync(p))return p;}
 return null;
}
/**
 * The Playwright CLI options the INSTALLED CLI actually accepts.
 *
 * ATS-101 defect B-01 was that the argument vector was written by hand and
 * contained two options (`--screenshot`, `--video`) that `playwright test`
 * does not have -- the CLI rejected the whole vector and the run died during
 * argument parsing. The option set of the installed CLI is now the contract:
 * an option is only passed when the CLI declares it.
 *
 * The implementation lives in adapters/playwright-cli.mjs so that this
 * helper and the ATS-301 adapter cannot drift apart.
 */
export function playwrightCliOptions(project) {
 const probe=probePlaywrightCli(project.root);
 return probe?probe.options:null;
}
/**
 * The options to pass when the installed CLI's --help could not be parsed.
 * Mirrors FALLBACK_PLAYWRIGHT_OPTIONS in the adapter: the run must keep
 * behaving the way it always has (artefacts + report), but the capability
 * report stays honest about what was proven.
 */
const FALLBACK_CLI_OPTIONS=['reporter','output','trace','workers'];
export function safeRunArgs(project,testFile,output) {
 const cli=resolvePlaywright(project);
 if(!cli)throw new Error('PLAYWRIGHT_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT');
 const probed=playwrightCliOptions(project);
 const options=(probed&&probed.length)?probed:FALLBACK_CLI_OPTIONS;
 const args=buildPlaywrightArgs({cli,options,output,testFile});
 if(testFile)sourcePath(project,testFile);
 return args;
}
/**
 * Whether a string is a valid run id.
 *
 * The run id is used to build a path under the data directory, so it is
 * checked before it is used: an id that is not a run id must never be
 * turned into a path. The cleaner uses this check too (ATS-209 review
 * round 1, E3): a state file that names a run whose id climbs out of the
 * runs directory must not make the cleaner delete something else.
 */
export function isValidRunId(id){return typeof id==='string'&&/^run_(?:[0-9a-f-]{36}|1_[0-9a-f]{24})$/.test(id);}
export function runDir(id){if(!isValidRunId(id)) throw new Error('INVALID_RUN_ID');return path.join(dataDir(),'runs',id);}
/**
 * The evidence files of a run folder.
 *
 * ATS-209 review round 1 (E6): this is the SAME collector the manifest
 * uses -- `collectEvidence` from `server/evidence/manifest.mjs` -- so the
 * run record's artifact list and the manifest describe the SAME set of
 * files. Before, the two had separate walks with separate limits, and a
 * run folder with more files than the limit produced a manifest that
 * covered only part of it while the run record knew about all of it: the
 * files outside the manifest were outside the tamper detection.
 *
 * The collector excludes the run's RECORD (`events.jsonl`, `stdout.log`),
 * the manifest itself and the cleaner's own record, so the caller does
 * not have to filter them out.
 */
export function filesInRun(id){const root=runDir(id);return collectEvidence(root);}
export function artifactPath(id,relative){
 const root=runDir(id);if(typeof relative!=='string'||relative.length>500)throw new Error('INVALID_ARTIFACT_PATH');
 const full=path.resolve(root,relative);if(!isSubpath(root,full))throw new Error('PATH_OUTSIDE_RUN');
 const actual=fs.realpathSync(full);if(!isSubpath(root,actual)||!fs.statSync(actual).isFile())throw new Error('PATH_OUTSIDE_RUN');return actual;
}
/**
 * Parses a Playwright JSON report into the run summary.
 *
 * ATS-208: the parsing, the aggregation and the status vocabulary moved to
 * `server/execution/model.mjs`, which is the ONE place the execution model
 * is defined. This function is re-exported from there (see the imports at
 * the top of this file) and kept here so that the existing callers keep
 * working.
 *
 * The two levels of status are kept apart, because they answer different
 * questions:
 *
 *   * `status` -- the CASE level status (`passed` / `failed` / `flaky` /
 *     `skipped`). It describes the case as a whole: a flaky case is `flaky`
 *     even though its first retry failed.
 *   * `resultStatus` -- the RESULT level status of THIS execution
 *     (`passed` / `failed` / `timedOut` / `skipped` / `interrupted`). It
 *     describes the single execution: the first retry of a flaky case failed,
 *     the second passed.
 *
 * An Attempt is one EXECUTION, so it records the result level status. The
 * case level status would report "flaky" for both attempts and hide that the
 * first one actually failed.
 */

/**
 * Builds the Attempt records of one Run.
 *
 * ATS-208: moved to `server/execution/model.mjs` and re-exported here.
 */
export function compactLog(log){return log.length>150000?log.slice(-150000):log;}
