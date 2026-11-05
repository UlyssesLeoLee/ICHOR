/**
 * ATS-206 -- the core of the safe state migration.
 *
 * The v0.1 bridge state lives in `state.json`. Migrating it to the current
 * scheme is a REWRITE of the identifiers, and a rewrite that drops a field
 * is a silent data loss: the file still parses, the bridge still starts, and
 * the data is gone.
 *
 * Two rules shape this module:
 *
 *   1. NOTHING IS DROPPED. The migrated state starts as a COPY of the
 *      original, so a field this module does not know about survives the
 *      migration. The fields that ARE rewritten (the identifiers, the
 *      references, the maps that are keyed by an identifier) are rewritten
 *      EXPLICITLY; every other key is carried over untouched.
 *
 *   2. EVERY MAP THAT IS KEYED BY A PROJECT IDENTIFIER IS RE-KEYED. The
 *      trust map (`state.trust`) and the UID registry (`state.uidRegistry`)
 *      are keyed by the project UID. A migration that renames the project
 *      and leaves the maps alone does not lose them -- it makes them
 *      UNREACHABLE: the bridge looks the trust up under the NEW UID and
 *      finds nothing, so a vouched-for project silently becomes untrusted
 *      and every test case loses its stable UID.
 *
 * The module is PURE: `planMigration` computes the new state without
 * touching the disk. The disk work (the backup, the atomic write, the
 * folder renames, the rollback) lives in `backup.mjs` and `apply.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  UID_SCHEME_VERSION, projectUidFor, runUidFor, isProjectUid, isRunUid,
  isLegacyProjectUid, isLegacyRunUid, emptyRegistry, assignRunSeqs,
} from '../uid.mjs';

/** The version of the migration format this module writes. */
export const MIGRATION_FORMAT_VERSION = 1;

/**
 * Rejects a state that is not a bridge state.
 *
 * The error carries a stable `code`, so a caller can tell "this file is not
 * a state file" (nothing to migrate) from "this file is broken" (the
 * operator has to look at it).
 *
 * @throws {Error} `STATE_NOT_AN_OBJECT` or `UNSUPPORTED_DATABASE`
 */
export function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    const e = new Error('STATE_NOT_AN_OBJECT');
    e.code = 'STATE_NOT_AN_OBJECT';
    throw e;
  }
  if (!Array.isArray(state.projects) || !Array.isArray(state.runs)) {
    const e = new Error('UNSUPPORTED_DATABASE');
    e.code = 'UNSUPPORTED_DATABASE';
    throw e;
  }
  return state;
}

/**
 * Re-keys a map whose keys are project identifiers.
 *
 * `legacyToUid` maps the OLD project identifier to the NEW one. A key that
 * is not in the map is already a current identifier and stays as it is.
 *
 * A key that is ALREADY PRESENT under its new name wins over the legacy
 * one: the current value is the newer one, and overwriting it with the
 * legacy value would undo a later decision.
 *
 * @param {object} map the map to re-key (may be undefined)
 * @param {Map<string,string>} legacyToUid the old -> new project identifier
 * @returns {object} the re-keyed map
 */
export function rekeyProjectMap(map, legacyToUid) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  const out = {};
  // First the keys that are not legacy identifiers: they are already current.
  for (const [key, value] of Object.entries(map)) {
    if (!legacyToUid.has(key)) out[key] = value;
  }
  // Then the legacy ones, into a name that is still free.
  for (const [key, value] of Object.entries(map)) {
    const target = legacyToUid.get(key);
    if (!target) continue;
    if (!(target in out)) out[target] = value;
  }
  return out;
}

/**
 * Computes the migration plan of one state object.
 *
 * Pure: returns the new state and a list of changes, without touching disk.
 *
 * @param {object} state the bridge state
 * @returns {{state:object, changes:object[], renamedFolders:object[], counts:object}}
 */
export function planMigration(state) {
  validateState(state);

  const changes = [];
  const legacyToUid = new Map();

  // The migrated state starts as a COPY of the original: a field this
  // module does not know about (a future field, a field added by a plugin)
  // survives the migration instead of being dropped on the floor.
  const nextState = {
    ...state,
    uidVersion: UID_SCHEME_VERSION,
    projects: [],
    runs: [],
  };

  // --- projects -------------------------------------------------------------
  // Two projects with the SAME root would derive the SAME UID, and the
  // second one would overwrite the first: its registry bucket, its trust
  // record and its counter would be lost. That is a state the migration
  // cannot represent, so it is refused here -- with the names of the two
  // projects, so that the operator can see WHICH pair collides.
  const rootToUid = new Map();
  for (const p of state.projects) {
    const uid = p.uid && isProjectUid(p.uid) && !isLegacyProjectUid(p.uid)
      ? p.uid
      : projectUidFor(p.root);
    const seen = rootToUid.get(uid);
    if (seen) {
      const e = new Error(
        `PROJECT_UID_COLLISION: the projects ${JSON.stringify(seen.name)} and ` +
        `${JSON.stringify(p.name)} both map to ${uid} (the same root ${JSON.stringify(p.root)})`
      );
      e.code = 'PROJECT_UID_COLLISION';
      e.uid = uid;
      e.projects = [seen, p];
      throw e;
    }
    rootToUid.set(uid, p);
  }

  for (const p of state.projects) {
    const uid = p.uid && isProjectUid(p.uid) && !isLegacyProjectUid(p.uid)
      ? p.uid
      : projectUidFor(p.root);
    if (p.id !== uid) {
      changes.push({ kind: 'project', from: p.id, to: uid, root: p.root });
    }
    legacyToUid.set(p.id, uid);
    nextState.projects.push({
      ...p,
      id: uid,
      uid,
      // The previous identifier is kept so that existing links and bookmarks
      // stay resolvable after the migration.
      ...(p.id !== uid ? { legacyId: p.id } : {})
    });
  }

  // --- runs -----------------------------------------------------------------
  // The per project sequence is the discriminator that distinguishes two
  // executions of the same target at the same commit. It is recorded on the
  // run record so that the UID can be recomputed from the recorded fields.
  const uidByLegacyRunId = new Map();
  const sequenced = assignRunSeqs(state.runs);
  for (const r of sequenced) {
    const projectUid = legacyToUid.get(r.projectId) ?? (r.projectUid ?? null);
    const uid = r.uid && isRunUid(r.uid) && !isLegacyRunUid(r.uid)
      ? r.uid
      : runUidFor({ projectUid, gitCommit: r.gitCommit, file: r.file, seq: r.seq });
    if (r.id !== uid) changes.push({ kind: 'run', from: r.id, to: uid, projectId: r.projectId });
    uidByLegacyRunId.set(r.id, uid);
    nextState.runs.push({
      ...r,
      id: uid,
      uid,
      seq: r.seq,
      projectUid,
      // The reference to the owning project is rewritten together with the
      // project identifier. Leaving it at the legacy value would detach the
      // run from its project: the bridge looks the run history up by
      // `run.projectId === project.id` and would not find it.
      projectId: projectUid ?? r.projectId,
      ...(r.id !== uid ? { legacyId: r.id } : {}),
      ...(r.attempts ? { attempts: r.attempts.map((a) => ({ ...a, runUid: uid })) } : {})
    });
  }

  // --- the UID registry -----------------------------------------------------
  // The registry is keyed by the project UID. A registry that keeps the OLD
  // key is not lost -- it is unreachable: the bridge looks the entries of a
  // project up under its NEW UID and finds an empty bucket, so every test
  // case loses the UID it had and gets a new one.
  const registry = state.uidRegistry && typeof state.uidRegistry === 'object'
    ? state.uidRegistry
    : emptyRegistry();
  const registryProjects = registry.projects && typeof registry.projects === 'object'
    ? registry.projects
    : {};
  nextState.uidRegistry = {
    ...registry,
    version: registry.version ?? UID_SCHEME_VERSION,
    projects: rekeyProjectMap(registryProjects, legacyToUid),
  };

  // --- the trust map --------------------------------------------------------
  // The trust decision is keyed by the project UID for the same reason. A
  // vouched-for project that loses its trust record silently becomes
  // untrusted -- the authoritative discovery is then refused for a project
  // the user explicitly vouched for.
  if (state.trust && typeof state.trust === 'object') {
    nextState.trust = rekeyProjectMap(state.trust, legacyToUid);
  }
  // --- the durable run counters ---------------------------------------------
  // The per project counter has to survive the migration: it is what keeps
  // the sequence of the next run above every sequence already used, even
  // when the run history was trimmed.
  const counters = { ...(state.runCounters ?? {}) };
  for (const [legacyId, projectUid] of legacyToUid) {
    const highest = nextState.runs
      .filter((r) => r.projectId === projectUid)
      .reduce((max, r) => Math.max(max, Number.isInteger(r.seq) ? r.seq : 0), 0);
    const current = Number.isInteger(counters[projectUid]) ? counters[projectUid] : 0;
    const currentLegacy = Number.isInteger(counters[legacyId]) ? counters[legacyId] : 0;
    const next = Math.max(highest, current, currentLegacy);
    if (next > 0) counters[projectUid] = next;
  }
  if (Object.keys(counters).length) nextState.runCounters = counters;

  // Preserve the original ordering of the run list (newest first).
  const order = new Map(state.runs.map((r, i) => [r.id, i]));
  nextState.runs.sort((a, b) => (order.get(a.legacyId ?? a.id) ?? 0) - (order.get(b.legacyId ?? b.id) ?? 0));

  // --- runs folder names ----------------------------------------------------
  // The run directory on disk is named after the run id. The folder therefore
  // has to be renamed together with the identifier, otherwise the archived
  // evidence of that run would no longer be reachable.
  const renamedFolders = [];
  for (const r of state.runs) {
    const uid = uidByLegacyRunId.get(r.id);
    if (uid && uid !== r.id) renamedFolders.push({ from: r.id, to: uid });
  }

  return {
    state: nextState,
    changes,
    renamedFolders,
    counts: summarizeState(nextState),
  };
}

/**
 * Renames the run folders on disk so that they match the migrated run ids.
 * Returns the list of folders that were actually renamed.
 */
export function renameRunFolders(runsDir, renamedFolders) {
  const renamed = [];
  if (!fs.existsSync(runsDir)) return renamed;
  for (const f of renamedFolders) {
    const from = path.join(runsDir, f.from);
    const to = path.join(runsDir, f.to);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) continue;
    fs.renameSync(from, to);
    renamed.push(f);
  }
  return renamed;
}

/**
 * True when every identifier of the state already follows the v1 scheme.
 */
export function isMigrated(state) {
  if (!state || !Array.isArray(state.projects) || !Array.isArray(state.runs)) return false;
  if (state.uidVersion !== UID_SCHEME_VERSION) return false;
  if (state.projects.some((p) => p.id !== p.uid || isLegacyProjectUid(p.id))) return false;
  if (state.runs.some((r) => r.id !== r.uid || isLegacyRunUid(r.id))) return false;
  return true;
}

/**
 * The counts of a state -- the numbers the migration has to preserve.
 *
 * The acceptance criterion of ATS-206 is that the migrated state holds the
 * SAME projects and the SAME history as the state it came from. A count is
 * the cheapest way to state that, and it is countable without understanding
 * the shape of a run: the projects, the runs, the attempts, the artifacts
 * and the registry entries.
 *
 * @param {object} state the bridge state
 * @returns {{projects:number,runs:number,attempts:number,artifacts:number,registryEntries:number}}
 */
export function summarizeState(state) {
  const projects = Array.isArray(state?.projects) ? state.projects.length : 0;
  const runs = Array.isArray(state?.runs) ? state.runs : [];
  let attempts = 0;
  let artifacts = 0;
  for (const r of runs) {
    attempts += Array.isArray(r?.attempts) ? r.attempts.length : 0;
    artifacts += Array.isArray(r?.artifacts) ? r.artifacts.length : 0;
  }
  const registryEntries = Object.values(state?.uidRegistry?.projects ?? {})
    .reduce((n, p) => n + (Array.isArray(p?.entries) ? p.entries.length : 0), 0);
  return { projects, runs: runs.length, attempts, artifacts, registryEntries };
}

/**
 * The differences between two count sets, described in words.
 *
 * @returns {string[]} the problems; empty when the counts match
 */
export function compareCounts(before, after) {
  const problems = [];
  for (const key of ['projects', 'runs', 'attempts', 'artifacts', 'registryEntries']) {
    const a = Number(before?.[key] ?? 0);
    const b = Number(after?.[key] ?? 0);
    if (a !== b) problems.push(`${key}: ${a} before, ${b} after`);
  }
  return problems;
}

/**
 * Throws when the migration did not preserve the counts.
 *
 * @throws {Error} `MIGRATION_COUNT_MISMATCH`
 */
export function assertCountsPreserved(before, after) {
  const problems = compareCounts(before, after);
  if (problems.length) {
    const e = new Error(`MIGRATION_COUNT_MISMATCH: ${problems.join('; ')}`);
    e.code = 'MIGRATION_COUNT_MISMATCH';
    e.problems = problems;
    e.before = before;
    e.after = after;
    throw e;
  }
  return true;
}

/**
 * Reads a state file and validates it.
 *
 * @param {string} file the path of the state file
 * @returns {object} the parsed state
 * @throws {Error} `STATE_FILE_MISSING`, `STATE_NOT_JSON` or `UNSUPPORTED_DATABASE`
 */
export function readStateFile(file) {
  if (!fs.existsSync(file)) {
    const e = new Error(`STATE_FILE_MISSING: ${file}`);
    e.code = 'STATE_FILE_MISSING';
    throw e;
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const err = new Error(`STATE_FILE_UNREADABLE: ${e.message}`);
    err.code = 'STATE_FILE_UNREADABLE';
    throw err;
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`STATE_NOT_JSON: ${e.message}`);
    err.code = 'STATE_NOT_JSON';
    throw err;
  }
  return validateState(state);
}

/**
 * Writes a state file ATOMICALLY.
 *
 * The state file and the run folders are one piece of state: a state file
 * that is half written is worse than no state file at all. The bytes are
 * written to a temporary file in the SAME directory and then renamed over
 * the target, which is atomic on every platform the product supports.
 *
 * @param {string} file the state file to write
 * @param {object} state the state to write
 */
export function writeStateAtomic(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(file)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
