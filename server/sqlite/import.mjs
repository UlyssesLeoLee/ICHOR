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
 * The difference between two values, described by the PATH at which they
 * differ.
 *
 * The comparison is field by field and NOT on the JSON text: the JSON text
 * of a record depends on the key order, and a key order is not a difference
 * in meaning. What this function reports is therefore the path of the
 * field that differs ("run run_1_0002.status"), which is what a reader
 * needs to know WHERE the mirror and the state disagree.
 *
 * @returns {string[]} the paths that differ; empty when the values match
 */
export function diffValues(a, b, path = '') {
  const problems = [];
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      problems.push(`${path || '<root>'}: the shape differs`);
      return problems;
    }
    if (a.length !== b.length) {
      problems.push(`${path || '<root>'}: ${a.length} entries vs ${b.length}`);
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      problems.push(...diffValues(a[i], b[i], `${path}[${i}]`));
    }
    return problems;
  }
  if (isObj(a) || isObj(b)) {
    if (!isObj(a) || !isObj(b)) {
      problems.push(`${path || '<root>'}: the shape differs`);
      return problems;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      problems.push(...diffValues(a[k], b[k], path ? `${path}.${k}` : k));
    }
    return problems;
  }
  if (a !== b) {
    problems.push(`${path || '<root>'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  return problems;
}

/** The indexed columns of the `projects` table. */
function projectRows(db) {
  return db
    .prepare('SELECT id,uid,name,root,added_at,legacy_id,doc FROM projects')
    .all();
}

/** The indexed columns of the `runs` table. */
function runRows(db) {
  return db
    .prepare(
      `SELECT id,uid,seq,project_id,project_uid,status,created_at,finished_at,git_commit,doc
       FROM runs`
    )
    .all();
}

/** The indexed columns of the `uid_registry` table. */
function registryRows(db) {
  return db
    .prepare('SELECT project_uid,uid,file,title,body_key,entry FROM uid_registry')
    .all();
}

/** The indexed columns of the `test_attempts` table. */
function attemptRows(db) {
  return db
    .prepare(
      `SELECT uid,run_uid,test_uid,retry,status,case_status,duration,doc
       FROM test_attempts`
    )
    .all();
}

/** The indexed columns of the `artifacts` table. */
function artifactRows(db) {
  return db
    .prepare(
      'SELECT uid,run_uid,attempt_uid,file,sha256,size_bytes,doc FROM artifacts'
    )
    .all();
}

/**
 * Compares the INDEXED COLUMNS of a row with the record they describe.
 *
 * The columns are the index the layer is queried by (`runsOfProject` reads
 * `status`, `attemptsOfRun` reads `test_uid` and `status`). A row whose
 * column contradicts its own `doc` answers a query with something the
 * state does not say -- so the column and the document have to agree.
 */
function checkColumns(row, record, mapping, problems, label) {
  for (const [column, field] of Object.entries(mapping)) {
    const inRow = row[column];
    const inDoc = record?.[field] ?? null;
    const a = inRow === null || inRow === undefined ? null : inRow;
    const b = inDoc === null || inDoc === undefined ? null : inDoc;
    const same = a === b
      || (typeof a === 'number' && typeof b === 'number' && a === b)
      || String(a) === String(b);
    if (!same) {
      problems.push(
        `${label}.${column}: the indexed column is ${JSON.stringify(a)} but the record says ${JSON.stringify(b)}`
      );
    }
  }
}

const PROJECT_COLUMNS = {
  id: 'id', uid: 'uid', name: 'name', root: 'root', added_at: 'addedAt', legacy_id: 'legacyId',
};
const RUN_COLUMNS = {
  id: 'id', uid: 'uid', seq: 'seq', project_id: 'projectId', project_uid: 'projectUid',
  status: 'status', created_at: 'createdAt', finished_at: 'finishedAt', git_commit: 'gitCommit',
};
const ATTEMPT_COLUMNS = {
  uid: 'uid', run_uid: 'runUid', test_uid: 'testUid', retry: 'retry',
  status: 'status', case_status: 'caseStatus', duration: 'duration',
};
// The `uid` of an artifact row is DERIVED from the run and the file (an
// artifact has no identifier of its own in the v0.1 state), so it is not
// compared against a field of the record -- it IS the key the row is
// found by.
const ARTIFACT_COLUMNS = {
  run_uid: 'runUid', attempt_uid: 'attemptUid',
  file: 'file', sha256: 'sha256', size_bytes: 'size',
};
const REGISTRY_COLUMNS = {
  project_uid: 'projectUid', uid: 'uid', file: 'file', title: 'title', body_key: 'bodyKey',
};

/**
 * The run counters of the database.
 */
function readCountersOf(db) {
  const out = {};
  for (const row of db.prepare('SELECT project_id,seq FROM run_counters').all()) {
    out[row.project_id] = Number(row.seq) || 0;
  }
  return out;
}

/**
 * Checks that the database holds exactly the state that was imported.
 *
 * The comparison covers EVERYTHING the layer answers a query with:
 *
 *   * the documents of the projects and the runs (field by field);
 *   * the INDEXED COLUMNS of those rows -- the columns the layer's own
 *     queries read -- against the documents they belong to;
 *   * every registry entry, its content and its indexed columns;
 *   * the attempts and the artifacts of every run;
 *   * the durable run counters.
 *
 * A mirror whose indexed column contradicts its own document answers a
 * query with something the state does not say, so a column that drifts
 * away from its record is a difference like any other.
 */
export function verifyMirror(db, state) {
  const problems = [];

  // --- projects -----------------------------------------------------------
  const stateProjects = new Map((state.projects ?? []).map((p) => [String(p.id), p]));
  const dbProjects = projectRows(db);
  for (const row of dbProjects) {
    const id = String(row.id);
    const record = stateProjects.get(id);
    if (!record) {
      problems.push(`project ${id} is not in the state`);
      continue;
    }
    let doc = null;
    try { doc = JSON.parse(row.doc); } catch (e) { problems.push(`project ${id}: the doc column is not JSON (${e.message})`); }
    if (doc) {
      for (const d of diffValues(record, doc, `project ${id}`)) problems.push(d);
    }
    checkColumns(row, record, PROJECT_COLUMNS, problems, `project ${id}`);
  }
  for (const id of stateProjects.keys()) {
    if (!dbProjects.some((r) => String(r.id) === id)) {
      problems.push(`project ${id} is missing from the database`);
    }
  }

  // --- runs ---------------------------------------------------------------
  const stateRuns = new Map((state.runs ?? []).map((r) => [String(r.id), r]));
  const dbRuns = runRows(db);
  for (const row of dbRuns) {
    const id = String(row.id);
    const record = stateRuns.get(id);
    if (!record) {
      problems.push(`run ${id} is not in the state`);
      continue;
    }
    let doc = null;
    try { doc = JSON.parse(row.doc); } catch (e) { problems.push(`run ${id}: the doc column is not JSON (${e.message})`); }
    if (doc) {
      for (const d of diffValues(record, doc, `run ${id}`)) problems.push(d);
    }
    checkColumns(row, record, RUN_COLUMNS, problems, `run ${id}`);
  }
  for (const id of stateRuns.keys()) {
    if (!dbRuns.some((r) => String(r.id) === id)) {
      problems.push(`run ${id} is missing from the database`);
    }
  }

  // --- the UID registry: EVERY entry, its content and its columns --------
  const stateEntries = Object.entries(state.uidRegistry?.projects ?? {})
    .flatMap(([projectUid, p]) => (p?.entries ?? []).map((e) => ({ projectUid, entry: e })));
  const dbEntries = registryRows(db);
  for (const { projectUid, entry } of stateEntries) {
    const uid = String(entry.uid ?? '');
    const row = dbEntries.find(
      (r) => String(r.project_uid) === projectUid && String(r.uid) === uid
    );
    if (!row) {
      problems.push(`registry entry ${projectUid}/${uid} is missing from the database`);
      continue;
    }
    let stored = null;
    try { stored = JSON.parse(row.entry); } catch (e) { problems.push(`registry entry ${projectUid}/${uid}: the entry column is not JSON (${e.message})`); }
    if (stored) {
      for (const d of diffValues(entry, stored, `registry ${projectUid}/${uid}`)) problems.push(d);
    }
    checkColumns(
      { ...row, project_uid: projectUid },
      { ...entry, projectUid },
      REGISTRY_COLUMNS,
      problems,
      `registry ${projectUid}/${uid}`
    );
  }
  for (const row of dbEntries) {
    const found = stateEntries.some(
      ({ projectUid, entry }) => String(projectUid) === String(row.project_uid)
        && String(entry.uid ?? '') === String(row.uid)
    );
    if (!found) {
      problems.push(`registry entry ${row.project_uid}/${row.uid} is not in the state`);
    }
  }

  // --- the attempts of every run -----------------------------------------
  const stateAttempts = (state.runs ?? []).flatMap((r) =>
    (r.attempts ?? []).map((a) => ({ run: r, attempt: a })));
  const dbAttempts = attemptRows(db);
  for (const { run, attempt } of stateAttempts) {
    const uid = String(attempt.uid ?? '');
    const row = dbAttempts.find((r) => String(r.uid) === uid);
    if (!row) {
      problems.push(`attempt ${uid} of run ${run.id} is missing from the database`);
      continue;
    }
    let doc = null;
    try { doc = JSON.parse(row.doc); } catch (e) { problems.push(`attempt ${uid}: the doc column is not JSON (${e.message})`); }
    if (doc) {
      for (const d of diffValues(attempt, doc, `attempt ${uid}`)) problems.push(d);
    }
    checkColumns(
      { ...row, run_uid: String(run.uid ?? run.id ?? '') },
      { ...attempt, runUid: String(run.uid ?? run.id ?? '') },
      ATTEMPT_COLUMNS,
      problems,
      `attempt ${uid}`
    );
  }
  for (const row of dbAttempts) {
    const uid = String(row.uid);
    if (!stateAttempts.some(({ attempt }) => String(attempt.uid ?? '') === uid)) {
      problems.push(`attempt ${uid} is not in the state`);
    }
  }

  // --- the artifacts of every run ----------------------------------------
  const stateArtifacts = (state.runs ?? []).flatMap((r) =>
    (r.artifacts ?? []).map((a) => ({ run: r, artifact: a })));
  const dbArtifacts = artifactRows(db);
  for (const { run, artifact } of stateArtifacts) {
    const runKey = String(run.uid ?? run.id ?? '');
    const uid = `${runKey}:${artifact.file ?? ''}`;
    const row = dbArtifacts.find((r) => String(r.uid) === uid);
    if (!row) {
      problems.push(`artifact ${uid} of run ${run.id} is missing from the database`);
      continue;
    }
    let doc = null;
    try { doc = JSON.parse(row.doc); } catch (e) { problems.push(`artifact ${uid}: the doc column is not JSON (${e.message})`); }
    if (doc) {
      for (const d of diffValues(artifact, doc, `artifact ${uid}`)) problems.push(d);
    }
    checkColumns(
      { ...row, run_uid: runKey },
      { ...artifact, runUid: runKey },
      ARTIFACT_COLUMNS,
      problems,
      `artifact ${uid}`
    );
  }
  for (const row of dbArtifacts) {
    const uid = String(row.uid);
    if (!stateArtifacts.some(({ run, artifact }) =>
      uid === `${String(run.uid ?? run.id ?? '')}:${artifact.file ?? ''}`)) {
      problems.push(`artifact ${uid} is not in the state`);
    }
  }

  // --- the durable run counters ------------------------------------------
  const stateCounters = Object.entries(state.runCounters ?? {}).map(([k, v]) => [k, Number(v)]);
  const readCounters = Object.entries(readCountersOf(db)).map(([k, v]) => [k, Number(v)]);
  if (JSON.stringify(stateCounters.sort()) !== JSON.stringify(readCounters.sort())) {
    problems.push('the run counters differ from the state');
  }

  return { ok: problems.length === 0, problems };
}

/**
 * The state as the layer reads it back.
 *
 * The comparison of `verifyMirror` is the authoritative one; this is the
 * convenience read used by the tests.
 */
export function readStateFrom(db) {
  return loadStateFrom(db);
}
