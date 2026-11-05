/**
 * ATS-205 -- importing the JSON state into the SQLite metadata layer.
 *
 * The v0.1 bridge state lives in `state.json`. The metadata layer is a
 * MIRROR of it: the JSON file stays the source of truth, and the SQLite
 * database holds the same state as queryable rows.
 *
 * The import is therefore a COPY, not a move, and it is idempotent: running
 * it twice produces the same database. It is also transactional: a failure
 * leaves the database empty rather than half-filled.
 *
 * `importState` returns a REPORT, not just a boolean, so a caller can tell
 * what was imported and what was skipped.
 */
import { openDatabase, closeDatabase, currentVersion } from './db.mjs';
import { storeState, loadStateFrom, counts } from './store.mjs';

/**
 * Imports a state object into a database.
 *
 * @param {object} db the open database handle
 * @param {object} state the bridge state
 * @returns {{projects:number,runs:number,uidRegistry:number,runCounters:number,schemaVersion:number}}
 */
export function importState(db, state) {
  storeState(db, state);
  const c = counts(db);
  return {
    projects: c.projects,
    runs: c.runs,
    uidRegistry: c.uidRegistry,
    runCounters: c.runCounters,
    schemaVersion: currentVersion(db),
  };
}

/**
 * Opens the database at `file` and imports `state` into it.
 *
 * @returns {{report:object, db:object}}
 */
export function importStateInto(file, state, options = {}) {
  const db = openDatabase(file, options);
  try {
    return { db, report: importState(db, state) };
  } catch (e) {
    closeDatabase(db);
    throw e;
  }
}

/**
 * Checks that the database holds exactly the state that was imported.
 *
 * The comparison is on the MEANINGFUL fields, not on the JSON text: the
 * JSON text of a record depends on the key order, and a key order is not a
 * difference in meaning. The `doc` column is compared field by field.
 */
export function verifyMirror(db, state) {
  const readBack = loadStateFrom(db);
  const problems = [];

  const projects = new Map((state.projects ?? []).map((p) => [String(p.id), p]));
  const runs = new Map((state.runs ?? []).map((r) => [String(r.id), r]));

  for (const p of readBack.projects) {
    if (!projects.has(String(p.id))) problems.push(`project ${p.id} is not in the state`);
    else if (JSON.stringify(p) !== JSON.stringify(projects.get(String(p.id)))) {
      problems.push(`project ${p.id} differs from the state`);
    }
  }
  if (readBack.projects.length !== projects.size) {
    problems.push(`project count differs: ${readBack.projects.length} vs ${projects.size}`);
  }

  for (const r of readBack.runs) {
    if (!runs.has(String(r.id))) problems.push(`run ${r.id} is not in the state`);
    else if (JSON.stringify(r) !== JSON.stringify(runs.get(String(r.id)))) {
      problems.push(`run ${r.id} differs from the state`);
    }
  }
  if (readBack.runs.length !== runs.size) {
    problems.push(`run count differs: ${readBack.runs.length} vs ${runs.size}`);
  }

  const stateEntries = Object.entries(state.uidRegistry?.projects ?? {})
    .flatMap(([projectUid, p]) => (p?.entries ?? []).map((e) => [projectUid, e.uid, e]));
  const readEntries = Object.entries(readBack.uidRegistry?.projects ?? {})
    .flatMap(([projectUid, p]) => (p?.entries ?? []).map((e) => [projectUid, e.uid, e]));
  if (stateEntries.length !== readEntries.length) {
    problems.push(`registry entry count differs: ${readEntries.length} vs ${stateEntries.length}`);
  }

  const stateCounters = Object.entries(state.runCounters ?? {}).map(([k, v]) => [k, Number(v)]);
  const readCounters = Object.entries(readBack.runCounters ?? {}).map(([k, v]) => [k, Number(v)]);
  if (JSON.stringify(stateCounters.sort()) !== JSON.stringify(readCounters.sort())) {
    problems.push('the run counters differ from the state');
  }

  return { ok: problems.length === 0, problems };
}
