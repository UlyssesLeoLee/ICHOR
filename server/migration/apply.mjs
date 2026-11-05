/**
 * ATS-206 -- the apply/rollback engine of the safe state migration.
 *
 * The migration is not a single write. It touches FOUR pieces of state:
 *
 *   1. the state file (`state.json`);
 *   2. the run folders on disk (named after the run identifiers);
 *   3. the metadata database (`metadata.db`), the mirror of the state;
 *   4. the durable counters that keep the sequence numbers monotonic.
 *
 * A migration that fails half way through leaves those pieces inconsistent
 * with each other, and an inconsistent state is WORSE than an unmigrated
 * one: the bridge starts, reads what is there, and behaves as if the
 * migration had succeeded.
 *
 * The engine therefore works like this:
 *
 *   * everything that can fail happens BEFORE the first destructive write
 *     (the plan is computed and the counts are checked first);
 *   * every destructive write is preceded by a BACKUP;
 *   * every step that succeeds is recorded in a JOURNAL, so the rollback
 *     undoes exactly what was done -- and nothing more;
 *   * a failure UNDOES the steps that already happened, automatically.
 *
 * The rollback is therefore not a separate "please run --rollback" step: it
 * is the automatic counterpart of a failed apply.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  planMigration, renameRunFolders, summarizeState, assertCountsPreserved,
  isMigrated, writeStateAtomic,
} from './state-migration.mjs';
import { openDatabase, closeDatabase, sqliteAvailable } from '../sqlite/db.mjs';
import { importState, verifyMirror } from '../sqlite/import.mjs';

/** The name of the backup of a file. */
export const BACKUP_SUFFIX = '.bak';

/**
 * Copies a file to its backup name.
 *
 * @returns {string|null} the path of the backup, or null when there was
 *   nothing to back up
 */
export function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const backup = `${file}${BACKUP_SUFFIX}`;
  fs.copyFileSync(file, backup);
  return backup;
}

/**
 * Restores a file from its backup.
 *
 * @returns {boolean} true when a backup existed and was restored
 */
export function restoreBackup(file) {
  const backup = `${file}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(backup)) return false;
  fs.copyFileSync(backup, file);
  return true;
}

/**
 * The journal of a migration: what was done, so that it can be undone.
 */
export class MigrationJournal {
  constructor() {
    /** @type {string[]} the steps that were completed, in order */
    this.steps = [];
    /** @type {Array<{from:string,to:string}>} the run folders that were renamed */
    this.renamedFolders = [];
    /** @type {string[]} the files that were backed up */
    this.backups = [];
  }

  /** Records a completed step. */
  done(step) {
    this.steps.push(step);
    return this;
  }

  /** The steps that have to be undone, in reverse order. */
  undoSteps() {
    return [...this.steps].reverse();
  }
}

/**
 * Undoes the steps of a migration.
 *
 * The undo is driven by the JOURNAL, not by a recomputation of the plan: a
 * recomputation would undo things that this particular run did not do (for
 * example the folders of a migration that was already rolled back), and
 * that is how a rollback turns into a second data loss.
 *
 * @param {MigrationJournal} journal the journal of the migration
 * @param {object} paths the paths of the data directory
 * @returns {string[]} the descriptions of the steps that were undone
 */
export function undoMigration(journal, paths) {
  const undone = [];
  for (const step of journal.undoSteps()) {
    switch (step) {
      case 'folders': {
        // The folders are renamed BACK to the identifiers the restored state
        // file refers to.
        const back = journal.renamedFolders.map((f) => ({ from: f.to, to: f.from }));
        const renamed = renameRunFolders(paths.runsDir, back);
        for (const f of renamed) undone.push(`run folder renamed back: ${f.to} -> ${f.from}`);
        break;
      }
      case 'state': {
        if (restoreBackup(paths.statePath)) undone.push(`state file restored: ${paths.statePath}`);
        break;
      }
      case 'database': {
        if (restoreBackup(paths.dbPath)) undone.push(`database restored: ${paths.dbPath}`);
        break;
      }
      default:
        break;
    }
  }
  return undone;
}

/**
 * The paths of one data directory.
 *
 * @param {string} dataDir the data directory
 * @returns {{dataDir:string,statePath:string,runsDir:string,dbPath:string}}
 */
export function pathsOf(dataDir) {
  return {
    dataDir,
    statePath: path.join(dataDir, 'state.json'),
    runsDir: path.join(dataDir, 'runs'),
    dbPath: path.join(dataDir, 'metadata.db'),
  };
}

/**
 * Imports a state into a metadata database and verifies the mirror.
 *
 * The import goes into a TEMPORARY database that is only put in place after
 * the mirror has been verified. A database that does not mirror the state
 * is never swapped in, so a failed import cannot leave a wrong mirror
 * behind.
 *
 * @returns {{ok:boolean, problems:string[], report:object|null}}
 */
export function importAndVerify(state, dbPath, options = {}) {
  if (!sqliteAvailable()) {
    return { ok: false, problems: ['SQLITE_NOT_AVAILABLE'], report: null };
  }
  const tmp = `${dbPath}.importing`;
  fs.rmSync(tmp, { force: true });
  let db = null;
  try {
    db = openDatabase(tmp, options);
    const report = importState(db, state);
    const { ok, problems } = verifyMirror(db, state);
    closeDatabase(db);
    db = null;
    if (!ok) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, problems, report };
    }
    return { ok: true, problems: [], report, tmp };
  } catch (e) {
    if (db) closeDatabase(db);
    fs.rmSync(tmp, { force: true });
    return { ok: false, problems: [`the import failed: ${e.message}`], report: null };
  }
}

/**
 * Applies a safe migration to a data directory.
 *
 * @param {string} dataDir the data directory
 * @param {object} options
 * @param {boolean} [options.dryRun] compute the plan and write nothing
 * @param {boolean} [options.importDatabase] import into the metadata database
 * @param {boolean} [options.rollbackOnFailure] undo the steps of a failed run
 * @returns {object} the report
 */
export function applyMigration(dataDir, options = {}) {
  const paths = pathsOf(dataDir);
  const journal = new MigrationJournal();

  const raw = fs.readFileSync(paths.statePath, 'utf8');
  const state = JSON.parse(raw);

  const before = summarizeState(state);
  const already = isMigrated(state);
  const plan = planMigration(state);
  const after = summarizeState(plan.state);

  const report = {
    dataDir,
    alreadyMigrated: already,
    dryRun: Boolean(options.dryRun),
    before,
    after,
    changes: plan.changes,
    renamedFolders: plan.renamedFolders,
    imported: false,
    problems: [],
    undone: [],
    rolledBack: false,
  };

  // The counts are checked BEFORE anything is written. A migration that
  // would change the number of projects or runs is refused, not applied.
  // The refusal is a REPORT and not an exception: the caller asked for a
  // migration, and the answer is "not this one".
  try {
    assertCountsPreserved(before, after);
  } catch (e) {
    report.problems.push(e.message);
    report.failed = true;
    report.refused = true;
    return report;
  }

  if (options.dryRun) {
    report.problems.push('dry run: nothing written');
    return report;
  }

  // --- the backups ------------------------------------------------------
  // Every file that is about to be overwritten is copied first. The backup
  // is what the rollback restores.
  if (fs.existsSync(paths.statePath)) {
    backupFile(paths.statePath);
    journal.backups.push(paths.statePath);
  }
  if (options.importDatabase && fs.existsSync(paths.dbPath)) {
    backupFile(paths.dbPath);
    journal.backups.push(paths.dbPath);
  }

  try {
    // --- the state file --------------------------------------------------
    writeStateAtomic(paths.statePath, plan.state);
    journal.done('state');

    // --- the run folders -------------------------------------------------
    const renamed = renameRunFolders(paths.runsDir, plan.renamedFolders);
    journal.renamedFolders = renamed;
    journal.done('folders');

    // --- the metadata database -------------------------------------------
    if (options.importDatabase) {
      const imported = importAndVerify(plan.state, paths.dbPath, options);
      if (!imported.ok) {
        report.problems.push(...imported.problems);
        throw new Error('the mirror does not hold the migrated state');
      }
      // The verified database is put in place. The old one is moved away
      // first, because a rename cannot replace a file on Windows.
      if (fs.existsSync(paths.dbPath)) fs.rmSync(paths.dbPath, { force: true });
      fs.renameSync(imported.tmp, paths.dbPath);
      journal.done('database');
      report.imported = true;
    }
  } catch (e) {
    report.problems.push(e.message);
    // The failure is undone here, not on request: a migration that failed
    // half way through has to leave the data directory as it found it.
    if (options.rollbackOnFailure !== false) {
      report.undone = undoMigration(journal, paths);
      report.rolledBack = true;
    }
    report.failed = true;
    return report;
  }

  report.ok = true;
  return report;
}

/**
 * Rolls a migration back explicitly.
 *
 * @param {string} dataDir the data directory
 * @returns {{restored:boolean, undone:string[], problems:string[]}}
 */
export function rollbackMigration(dataDir) {
  const paths = pathsOf(dataDir);
  const problems = [];

  if (!fs.existsSync(`${paths.statePath}${BACKUP_SUFFIX}`)) {
    return { restored: false, undone: [], problems: ['NO_BACKUP_TO_RESTORE'] };
  }

  // The folders are renamed back first: the restored state file refers to
  // the legacy identifiers, and a state file that points at folders that
  // do not exist is not a restored state.
  const restoredState = JSON.parse(fs.readFileSync(`${paths.statePath}${BACKUP_SUFFIX}`, 'utf8'));
  const { renamedFolders } = planMigration(restoredState);
  const back = renamedFolders.map((f) => ({ from: f.to, to: f.from }));
  const undone = renameRunFolders(paths.runsDir, back).map(
    (f) => `run folder renamed back: ${f.to} -> ${f.from}`
  );

  if (restoreBackup(paths.statePath)) undone.push(`state file restored: ${paths.statePath}`);
  else problems.push('the state file could not be restored');

  if (fs.existsSync(`${paths.dbPath}${BACKUP_SUFFIX}`)) {
    if (restoreBackup(paths.dbPath)) undone.push(`database restored: ${paths.dbPath}`);
    else problems.push('the database could not be restored');
  }

  return { restored: problems.length === 0, undone, problems };
}
