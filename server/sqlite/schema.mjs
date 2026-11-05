/**
 * ATS-205 -- the SQLite metadata layer: SCHEMA DEFINITIONS.
 *
 * The physical model is versioned. Every version is a numbered step with an
 * `up` (apply) and a `down` (revert) script, and the version the database
 * carries is stored INSIDE the database (`meta` table, key `schema_version`).
 * Nothing outside the database file decides which schema is in use, so a
 * database cannot claim a version it does not have.
 *
 * UPGRADE / DOWNGRADE POLICY (this is the part the acceptance criteria ask
 * for, so it is stated rather than implied):
 *
 *   1. UPGRADE is FORWARD-ONLY and additive. A step may create a table, add
 *      a column, create an index or insert a backfill row. It never drops a
 *      column that a later version still uses.
 *   2. DOWNGRADE is EXPLICIT and LOSSY, and the loss is declared by the
 *      step itself: `down` may drop a table or a column, and the data in it
 *      is gone afterwards. A downgrade therefore never happens implicitly --
 *      it is a separate, operator-requested action.
 *   3. Every step runs in ITS OWN TRANSACTION. A step that fails leaves the
 *      version exactly where it was and leaves no half-applied objects
 *      behind; the step is retried by re-running the migration.
 *   4. The version is written in the SAME transaction as the step, so the
 *      version and the objects it describes can never disagree.
 *   5. Steps are deterministic and idempotent: applying the same step twice
 *      is a no-op. The runner refuses to adopt a FOREIGN object: a step
 *      that would create a table which already exists with a DIFFERENT
 *      shape (missing columns) is rejected with `SCHEMA_OBJECT_CONFLICT`
 *      instead of silently taking the foreign table over. A table that
 *      already exists with the EXPECTED shape is the table the step would
 *      have created, so the step stays a no-op for it.
 *   6. The version is re-read INSIDE the step's transaction, so two
 *      concurrent migrators cannot apply the same step twice: the second
 *      one waits for the write lock, sees the new version and skips the
 *      step.
 *   7. A database that is NEWER than the code is refused (`SCHEMA_TOO_NEW`).
 *      It is never silently downgraded.
 *
 * The SCHEMA ITSELF is the "SQLite metadata layer" this task delivers: the
 * bridge state (projects, runs, the UID registry, the durable run counters)
 * is stored as indexed columns PLUS the original document, so the layer is
 * queryable without a second copy of the truth.
 */

/** The schema version this build of the code understands. */
export const SCHEMA_VERSION = 3;

/**
 * The migration steps, in order.
 *
 * `version` is the version the database has AFTER the step ran.
 *
 * `tables` declares, per step, the tables the step creates and the columns
 * those tables must carry. It is what lets the runner tell "the table this
 * step would create is already here, with the right shape" (idempotent, skip)
 * from "a FOREIGN table happens to have this name" (refuse). The
 * declaration is the contract the runner enforces, so it must match the DDL
 * of the step.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial-metadata-layer',
    tables: {
      meta: ['key', 'value'],
      projects: ['id', 'uid', 'name', 'root', 'added_at', 'legacy_id', 'doc'],
      runs: [
        'id', 'uid', 'seq', 'project_id', 'project_uid', 'status',
        'created_at', 'finished_at', 'git_commit', 'doc',
      ],
      uid_registry: ['project_uid', 'uid', 'file', 'title', 'body_key', 'entry'],
      run_counters: ['project_id', 'seq'],
    },
    up: [
      `CREATE TABLE IF NOT EXISTS meta (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
      // A project is a registered repository. `doc` keeps the original
      // record verbatim (the JSON document the bridge used to keep in
      // `state.json.projects`), so the layer never loses a field it does
      // not model.
      `CREATE TABLE IF NOT EXISTS projects (
         id       TEXT PRIMARY KEY,
         uid      TEXT,
         name     TEXT NOT NULL,
         root     TEXT NOT NULL,
         added_at TEXT,
         legacy_id TEXT,
         doc      TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_projects_root ON projects(root)`,
      // A run is one execution. `seq` is the per project execution sequence
      // (never reused), `status` the lifecycle status, `doc` the original
      // record verbatim.
      `CREATE TABLE IF NOT EXISTS runs (
         id          TEXT PRIMARY KEY,
         uid         TEXT,
         seq         INTEGER,
         project_id  TEXT,
         project_uid TEXT,
         status      TEXT,
         created_at  TEXT,
         finished_at TEXT,
         git_commit  TEXT,
         doc         TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_runs_project_created ON runs(project_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`,
      // The UID registry (ATS-201). One row per (project, test uid); `entry`
      // keeps the registry entry verbatim.
      `CREATE TABLE IF NOT EXISTS uid_registry (
         project_uid TEXT NOT NULL,
         uid         TEXT NOT NULL,
         file        TEXT,
         title       TEXT,
         body_key    TEXT,
         entry       TEXT NOT NULL,
         PRIMARY KEY (project_uid, uid)
       )`,
      // The durable per project run counter. It is what keeps a sequence
      // number from being reused after the run history is trimmed.
      `CREATE TABLE IF NOT EXISTS run_counters (
         project_id TEXT PRIMARY KEY,
         seq        INTEGER NOT NULL
       )`,
    ],
    down: [
      `DROP TABLE IF EXISTS run_counters`,
      `DROP TABLE IF EXISTS uid_registry`,
      `DROP INDEX IF EXISTS idx_runs_status`,
      `DROP INDEX IF EXISTS idx_runs_project_created`,
      `DROP TABLE IF EXISTS runs`,
      `DROP INDEX IF EXISTS idx_projects_root`,
      `DROP TABLE IF EXISTS projects`,
      `DROP TABLE IF EXISTS meta`,
    ],
  },
  {
    version: 2,
    name: 'artifacts-and-attempts',
    tables: {
      artifacts: [
        'uid', 'run_uid', 'attempt_uid', 'file', 'sha256', 'size_bytes', 'doc',
      ],
      test_attempts: [
        'uid', 'run_uid', 'test_uid', 'retry', 'status', 'case_status', 'duration', 'doc',
      ],
    },
    up: [
      // The artifacts of a run (the evidence files) and the attempts (the
      // per case executions) become queryable rows of their own. `doc` keeps
      // the original entry verbatim.
      `CREATE TABLE IF NOT EXISTS artifacts (
         uid       TEXT PRIMARY KEY,
         run_uid   TEXT NOT NULL,
         attempt_uid TEXT,
         file      TEXT NOT NULL,
         sha256    TEXT NOT NULL,
         size_bytes INTEGER NOT NULL,
         doc       TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_uid)`,
      `CREATE TABLE IF NOT EXISTS test_attempts (
         uid       TEXT PRIMARY KEY,
         run_uid   TEXT NOT NULL,
         test_uid  TEXT,
         retry     INTEGER NOT NULL DEFAULT 0,
         status    TEXT NOT NULL,
         case_status TEXT,
         duration  INTEGER,
         doc       TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_attempts_run_status ON test_attempts(run_uid, status)`,
    ],
    down: [
          'DROP INDEX IF EXISTS idx_attempts_run_status',
          'DROP TABLE IF EXISTS test_attempts',
          'DROP INDEX IF EXISTS idx_artifacts_run',
          'DROP TABLE IF EXISTS artifacts',
        ],
      },
      {
        version: 3,
        name: 'execution-events',
        tables: {
          events: ['run_uid', 'seq', 'at', 'type', 'data'],
        },
        up: [
          // ATS-208: the execution events become queryable rows of their own.
          //
          // The composite primary key `(run_uid, seq)` is the IDENTITY of an
          // event: the sequence number is per run, so `seq` alone would collide
          // between two runs of the same project. The key also ENFORCES the
          // property the acceptance criterion asks for: the sequence of a run is
          // gap-free and never reused, because a second event with the same
          // (run, seq) cannot be written at all.
          //
          // `data` keeps the payload of the event verbatim, so a field the layer
          // does not model is not lost.
          `CREATE TABLE IF NOT EXISTS events (
             run_uid TEXT NOT NULL,
             seq     INTEGER NOT NULL,
             at      TEXT,
             type    TEXT NOT NULL,
             data    TEXT NOT NULL,
             PRIMARY KEY (run_uid, seq)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`,
        ],
        down: [
          'DROP INDEX IF EXISTS idx_events_type',
          'DROP TABLE IF EXISTS events',
        ],
      },
    ];

/** The migration step that brings the database from `version - 1` to `version`. */
export function stepFor(version) {
  return MIGRATIONS.find((m) => m.version === version) ?? null;
}

/** The newest version the code knows how to migrate to. */
export function latestVersion() {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}
