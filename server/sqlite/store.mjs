/**
 * ATS-205 -- the metadata STORE: the bridge state written into SQLite.
 *
 * The bridge state (projects, runs, the UID registry, the durable run
 * counters) is stored in SQLite as INDEXED COLUMNS plus the original record
 * verbatim in a `doc` column. The columns are what makes the layer
 * queryable; the `doc` column is what makes it lossless -- a field the layer
 * does not model is still there, so the JSON state file and the SQLite
 * layer never disagree about what a record contains.
 *
 * WRITES ARE TRANSACTIONAL. A `saveState` writes every table inside ONE
 * transaction, so a reader never sees a half-written state: either the whole
 * new state is there or the old one is.
 *
 * THE JSON STATE FILE STAYS THE FALLBACK. `storeState` is a pure function
 * of the state object, and `loadState` reads it back, so the two can be
 * compared in a test -- the layer is a MIRROR, not a second truth.
 */
import { withTransaction } from './db.mjs';

const PROJECT_COLUMNS = ['id', 'uid', 'name', 'root', 'added_at', 'legacy_id'];
const RUN_COLUMNS = [
  'id', 'uid', 'seq', 'project_id', 'project_uid', 'status',
  'created_at', 'finished_at', 'git_commit',
];
const REGISTRY_COLUMNS = ['project_uid', 'uid', 'file', 'title', 'body_key'];
const COUNTER_COLUMNS = ['project_id', 'seq'];

/** The `doc` of a project, run, registry entry or counter is its JSON. */
const asDoc = (value) => JSON.stringify(value ?? null);

/**
 * Writes the whole state into the database, in ONE transaction.
 *
 * The tables are REPLACED rather than merged: the database is a mirror of
 * the state, so the rows that are no longer in the state are no longer in
 * the database. Replacing them inside the transaction keeps the mirror
 * exact -- there is no window in which the two disagree.
 *
 * @param {object} db the open database handle
 * @param {object} state the bridge state
 */
export function storeState(db, state) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const runs = Array.isArray(state?.runs) ? state.runs : [];
  const registry = state?.uidRegistry ?? { version: 1, projects: {} };
  const counters = state?.runCounters ?? {};

  withTransaction(db, (d) => {
    // --- projects ----------------------------------------------------------
    d.exec('DELETE FROM projects');
    const insProject = d.prepare(
      `INSERT INTO projects(${PROJECT_COLUMNS.join(',')},doc)
       VALUES(${PROJECT_COLUMNS.map(() => '?').join(',')},?)`
    );
    for (const p of projects) {
      insProject.run(
        String(p.id ?? ''),
        p.uid ? String(p.uid) : null,
        String(p.name ?? ''),
        String(p.root ?? ''),
        p.addedAt ?? null,
        p.legacyId ?? null,
        asDoc(p)
      );
    }

    // --- runs --------------------------------------------------------------
    d.exec('DELETE FROM runs');
    const insRun = d.prepare(
      `INSERT INTO runs(${RUN_COLUMNS.join(',')},doc)
       VALUES(${RUN_COLUMNS.map(() => '?').join(',')},?)`
    );
    for (const r of runs) {
      insRun.run(
        String(r.id ?? ''),
        r.uid ? String(r.uid) : null,
        Number.isInteger(r.seq) ? r.seq : null,
        r.projectId ? String(r.projectId) : null,
        r.projectUid ? String(r.projectUid) : null,
        r.status ? String(r.status) : null,
        r.createdAt ?? null,
        r.finishedAt ?? null,
        r.gitCommit ? String(r.gitCommit) : null,
        asDoc(r)
      );
    }

    // --- the UID registry --------------------------------------------------
    d.exec('DELETE FROM uid_registry');
    const insEntry = d.prepare(
      `INSERT INTO uid_registry(${REGISTRY_COLUMNS.join(',')},entry)
       VALUES(${REGISTRY_COLUMNS.map(() => '?').join(',')},?)`
    );
    for (const [projectUid, project] of Object.entries(registry.projects ?? {})) {
      for (const entry of project?.entries ?? []) {
        insEntry.run(
          String(projectUid),
          String(entry.uid ?? ''),
          entry.file ?? null,
          entry.title ?? null,
          entry.bodyKey ?? null,
          asDoc(entry)
        );
      }
    }

    // --- the durable run counters -----------------------------------------
    d.exec('DELETE FROM run_counters');
    const insCounter = d.prepare(
      `INSERT INTO run_counters(${COUNTER_COLUMNS.join(',')}) VALUES(?,?)`
    );
    for (const [projectId, seq] of Object.entries(counters)) {
      insCounter.run(String(projectId), Number(seq) || 0);
    }

    // --- the attempts and the artifacts of the runs ------------------------
    // These are nested INSIDE the run records, so they are written together
    // with them: the layer never holds an attempt whose run is missing.
    d.exec('DELETE FROM test_attempts');
    d.exec('DELETE FROM artifacts');
    const insAttempt = d.prepare(
      `INSERT INTO test_attempts(uid,run_uid,test_uid,retry,status,case_status,duration,doc)
       VALUES(?,?,?,?,?,?,?,?)`
    );
    const insArtifact = d.prepare(
      `INSERT INTO artifacts(uid,run_uid,attempt_uid,file,sha256,size_bytes,doc)
       VALUES(?,?,?,?,?,?,?)`
    );
    for (const r of runs) {
      for (const a of r.attempts ?? []) {
        insAttempt.run(
          String(a.uid ?? ''),
          String(r.uid ?? r.id ?? ''),
          a.testUid ?? null,
          Number.isInteger(a.retry) ? a.retry : 0,
          String(a.status ?? 'unknown'),
          a.caseStatus ?? null,
          Number.isFinite(a.duration) ? a.duration : null,
          asDoc(a)
        );
      }
      for (const art of r.artifacts ?? []) {
        insArtifact.run(
          // An artifact has no identifier of its own in the v0.1 state, so
          // the row is keyed by the run and the file. The key is derived,
          // not random: the same artifact always gets the same row.
          `${r.uid ?? r.id ?? ''}:${art.file ?? ''}`,
          String(r.uid ?? r.id ?? ''),
          art.attemptUid ?? null,
          String(art.file ?? ''),
          String(art.sha256 ?? ''),
          Number.isFinite(art.size) ? art.size : 0,
          asDoc(art)
        );
      }
    }

    // --- the execution events of the runs ----------------------------------
    // ATS-208: the events become queryable rows, keyed by (run, seq). The
    // key is the IDENTITY of an event, and it also ENFORCES the property
    // the acceptance criterion asks for: a run cannot have two events with
    // the same sequence number, so the sequence is never reused and the
    // stream cannot have a duplicate.
    d.exec('DELETE FROM events');
    const insEvent = d.prepare(
      `INSERT INTO events(run_uid,seq,at,type,data) VALUES(?,?,?,?,?)`
    );
    for (const r of runs) {
      for (const e of r.events ?? []) {
        // The sequence number is required: an event without one cannot be
        // placed in the stream, so it is not written. The event is not lost
        // -- it is still in the state file and in `events.jsonl`.
        if (!Number.isInteger(e.seq)) continue;
        insEvent.run(
          String(r.uid ?? r.id ?? ''),
          e.seq,
          e.at ?? null,
          String(e.type ?? 'unknown'),
          asDoc(e.data ?? {})
        );
      }
    }
  });
}
/**
 * Reads the state back out of the database.
 *
 * The `doc` column is the source of the records, and the columns are the
 * index. A record that a column does not describe is still returned whole,
 * because the `doc` is what is parsed.
 */
export function loadStateFrom(db) {
  const projectRows = db.prepare('SELECT doc FROM projects').all();
  const runRows = db.prepare('SELECT doc FROM runs').all();
  const counterRows = db.prepare('SELECT project_id,seq FROM run_counters').all();
  const registryRows = db.prepare('SELECT project_uid,entry FROM uid_registry').all();

  const projects = projectRows.map((r) => JSON.parse(r.doc));
  const runs = runRows.map((r) => JSON.parse(r.doc));

  // The registry is rebuilt in the shape the bridge expects:
  // `{version, projects: {<projectUid>: {entries: [...]}}}`.
  const registry = { version: 1, projects: {} };
  for (const row of registryRows) {
    const bucket = registry.projects[row.project_uid] ?? (registry.projects[row.project_uid] = { entries: [] });
    bucket.entries.push(JSON.parse(row.entry));
  }

  const runCounters = {};
  for (const row of counterRows) runCounters[row.project_id] = Number(row.seq) || 0;

  return { schema: 1, projects, runs, uidRegistry: registry, runCounters };
}

/**
 * The runs of one project, newest first -- the query the layer exists for.
 */
export function runsOfProject(db, projectId) {
  return db
    .prepare(
      `SELECT id,uid,seq,status,created_at,finished_at FROM runs
       WHERE project_id = ? ORDER BY created_at DESC, seq DESC`
    )
    .all(String(projectId));
}

/**
 * The attempts of one run.
 */
export function attemptsOfRun(db, runUid) {
  return db
    .prepare(
      `SELECT uid,run_uid,test_uid,retry,status,case_status,duration
       FROM test_attempts WHERE run_uid = ? ORDER BY retry, uid`
    )
    .all(String(runUid));
}

/**
 * The execution events of one run, in their sequence order.
 *
 * ATS-208: the events are queryable rows, so the audit trail of a run can
 * be read out of the metadata layer instead of out of the run folder. The
 * ORDER BY the sequence number is what makes the rows a STREAM again: the
 * order of the rows is the order the events happened in.
 */
export function eventsOfRun(db, runUid) {
  return db
    .prepare(
      `SELECT run_uid,seq,at,type,data FROM events
       WHERE run_uid = ? ORDER BY seq`
    )
    .all(String(runUid))
    .map((row) => ({
      runUid: row.run_uid,
      seq: row.seq,
      at: row.at,
      type: row.type,
      data: JSON.parse(row.data),
    }));
}

/** The projects, keyed by their identifier. */
export function listProjects(db) {
  return db.prepare('SELECT id,uid,name,root,added_at FROM projects ORDER BY added_at, id').all();
}

/**
 * The number of rows per table -- the smoke check of a mirror.
 *
 * A table that the current schema version does not have is reported as 0
 * rather than raising: after a downgrade the higher-version tables are
 * gone, and a count of the surviving tables is still useful.
 */
export function counts(db) {
  const one = (table) => {
    try {
      return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0);
    } catch {
      // The table does not exist in this schema version.
      return 0;
    }
  };
  return {
    projects: one('projects'),
    runs: one('runs'),
    uidRegistry: one('uid_registry'),
    runCounters: one('run_counters'),
    testAttempts: one('test_attempts'),
    artifacts: one('artifacts'),
    events: one('events'),
  };
}
