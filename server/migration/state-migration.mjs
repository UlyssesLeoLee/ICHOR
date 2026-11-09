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
 * folder renames, the journal, the rollback) lives in `apply.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  UID_SCHEME_VERSION, projectUidFor, runUidFor, isProjectUid, isRunUid,
  isLegacyProjectUid, isLegacyRunUid, emptyRegistry, assignRunSeqs,
} from '../uid.mjs';
// ATS-212: the environment profile identifier is derived from the project
// and the name, so re-keying a profile re-derives its identifier with the
// SAME rule the runtime uses.
import { envUidFor } from '../env/profiles.mjs';

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

  // --- the environment profiles (ATS-212) ---------------------------------
  //
  // The profiles and the whitelists are keyed by the project identifier, so
  // they have to be re-keyed for exactly the same reason the trust map and
  // the registry are: a map that keeps the OLD key is not lost, it is
  // UNREACHABLE. The bridge looks a project's profiles up under its NEW
  // UID, finds an empty bucket, and the project silently falls back to the
  // built-in default whitelist -- the profile it had is simply gone.
  //
  // The profile identifier is DERIVED from the project and the name, so
  // re-keying the owner re-derives the identifier as well. The runs that
  // referred to the old identifier are rewritten in the same pass, so a
  // run still points at the profile it ran under.
  if (state.envProfiles && typeof state.envProfiles === 'object') {
    const store = state.envProfiles;
    const profiles = Array.isArray(store.profiles) ? store.profiles : [];
    const envUidByOld = new Map();
    const nextProfiles = [];
    // The derived identifier is the IDENTITY of a profile: two profiles of
    // one project with the same name derive the SAME uid. A state that
    // carries both of them therefore holds two records for one profile --
    // one filed under the legacy project key by an older build and one
    // filed under the canonical key by the current build.
    //
    // The canonical record wins, and the legacy one is dropped. This is the
    // same rule the re-keyed maps use (`rekeyProjectMap`): the value that
    // is already under the current key is the newer one, and overwriting it
    // with the legacy value would undo a later decision. The drop is
    // REPORTED in `changes`, so the operator can see that a record was
    // discarded instead of silently losing one of the two.
    //
    // The drop is also what keeps the migration importable: two records
    // with the same uid cannot both be written into the `env_profiles`
    // table, so the mirror import would fail with a UNIQUE constraint
    // violation and the whole migration would be refused.
    const seenUid = new Map(); // the derived uid -> {index, wasLegacyKeyed}
    for (const p of profiles) {
      const oldOwner = p?.projectUid;
      const newOwner = legacyToUid.get(oldOwner) ?? oldOwner;
      const oldUid = p?.uid ?? p?.id ?? null;
      // The identifier is re-derived from the NEW owner, so that it stays
      // recomputable: `envUidFor(projectUid, name)` is the only rule.
      const newUid = newOwner && p?.name ? envUidFor(newOwner, p.name) : oldUid;
      // A record that was filed under a legacy project key is the one that
      // the migration moves; a record that was already under the canonical
      // key is left where it is.
      const wasLegacyKeyed = Boolean(oldOwner && newOwner && oldOwner !== newOwner);
      if (wasLegacyKeyed) {
        changes.push({ kind: 'env-profile-owner', from: oldOwner, to: newOwner, profile: p?.name ?? null });
      }
      if (oldUid && newUid && oldUid !== newUid) {
        envUidByOld.set(oldUid, newUid);
        changes.push({ kind: 'env-profile', from: oldUid, to: newUid, projectUid: newOwner });
      }
      const migrated = { ...p, projectUid: newOwner, uid: newUid, id: newUid };
      const seen = seenUid.get(newUid);
      if (!seen) {
        seenUid.set(newUid, { index: nextProfiles.length, wasLegacyKeyed });
        nextProfiles.push(migrated);
        continue;
      }
      // The derived uid is taken already, so the two records describe ONE
      // profile. The record that was already under the canonical project
      // key is the one that stays -- it is the newer one. The other record
      // is dropped and the drop is reported, so nothing disappears without
      // a trace.
      const kept = nextProfiles[seen.index];
      if (seen.wasLegacyKeyed && !wasLegacyKeyed) {
        // The canonical record arrives and replaces the one the migration
        // moved onto the canonical key.
        nextProfiles[seen.index] = migrated;
        changes.push({
          kind: 'env-profile-dropped',
          from: kept.uid ?? kept.id ?? null,
          to: newUid,
          projectUid: newOwner,
          profile: kept.name ?? null,
          reason: 'a profile under the canonical project key already exists',
        });
        continue;
      }
      changes.push({
        kind: 'env-profile-dropped',
        from: oldUid,
        to: newUid,
        projectUid: newOwner,
        profile: p?.name ?? null,
        reason: seen.wasLegacyKeyed
          ? 'another profile with the same derived identifier is already present'
          : 'a profile under the canonical project key already exists',
      });
    }
    const whitelists = rekeyProjectMap(store.whitelists, legacyToUid);
    for (const key of Object.keys(store.whitelists ?? {})) {
      const target = legacyToUid.get(key);
      if (target) changes.push({ kind: 'env-whitelist', from: key, to: target });
    }
    nextState.envProfiles = {
      ...store,
      profiles: nextProfiles,
      whitelists,
    };
    // The runs that named a profile are rewritten together with it.
    if (envUidByOld.size) {
      for (const r of nextState.runs) {
        const mapped = envUidByOld.get(r.envUid);
        if (mapped) r.envUid = mapped;
      }
    }
  }

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
 * True when a string is a run identifier the Bridge accepts.
 *
 * The run folder on disk is named after the run id, so the id is used as a
 * PATH SEGMENT. An id that carries a path separator or a `..` would make
 * the rename leave the runs directory -- or reach outside the data
 * directory. The identifier is therefore validated before it is ever
 * joined into a path.
 *
 * @param {string} id the run identifier
 * @returns {boolean}
 */
export function isValidRunId(id) {
  return typeof id === 'string' && /^run_(?:[0-9a-f-]{36}|1_[0-9a-f]{24})$/.test(id);
}

/**
 * Renames the run folders on disk so that they match the migrated run ids.
 * Returns the list of folders that were actually renamed.
 *
 * The rename is done ONE FOLDER AT A TIME, and the list of the folders that
 * were renamed so far is handed to `onRenamed` after every single rename.
 * A rename that throws half way through therefore leaves the caller with an
 * accurate record of what has already been renamed -- without that, the
 * automatic rollback cannot put the folders back and the restored state
 * points at folders that no longer exist.
 *
 * @param {string} runsDir the runs directory
 * @param {Array<{from:string,to:string}>} renamedFolders the renames to do
 * @param {(done:Array<{from:string,to:string}>)=>void} [onRenamed] called
 *   after every successful rename with the folders renamed so far
 * @returns {Array<{from:string,to:string}>} the folders that were renamed
 */
export function renameRunFolders(runsDir, renamedFolders, onRenamed) {
  const renamed = [];
  if (!fs.existsSync(runsDir)) return renamed;
  for (const f of renamedFolders) {
    // The identifier becomes a path segment, so it has to be one.
    if (!isValidRunId(f.from) || !isValidRunId(f.to)) {
      const e = new Error(`INVALID_RUN_ID: ${JSON.stringify(f.from)} -> ${JSON.stringify(f.to)}`);
      e.code = 'INVALID_RUN_ID';
      throw e;
    }
    const from = path.join(runsDir, f.from);
    const to = path.join(runsDir, f.to);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) continue;
    fs.renameSync(from, to);
    renamed.push(f);
    // The journal is updated IMMEDIATELY: a rename that fails on the next
    // folder must not leave this one renamed but unrecorded.
    if (onRenamed) onRenamed([...renamed]);
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
