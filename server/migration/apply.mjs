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
 *   * the JOURNAL is written to disk BEFORE the first destructive write, so
 *     that a migration that is killed half way through can be finished or
 *     undone by the NEXT invocation -- an in-memory journal dies with the
 *     process, and a process that dies leaves the data directory broken;
 *   * every destructive write is preceded by a BACKUP, and the backup of a
 *     v0.1 state is NEVER overwritten;
 *   * every step that succeeds is recorded in the JOURNAL, so the rollback
 *     undoes exactly what was done -- and nothing more;
 *   * a failure UNDOES the steps that already happened, automatically.
 *
 * The rollback is therefore not a separate "please run --rollback" step: it
 * is the automatic counterpart of a failed apply.
 *
 * The Bridge lock is held for the WHOLE write. The Bridge keeps its own
 * copy of the state in memory and writes it back on every change, so a
 * migration that runs under it would be overwritten by the next write --
 * and a rollback that runs under it does the same to a state that is
 * already migrated.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  planMigration, renameRunFolders, summarizeState, assertCountsPreserved,
  isMigrated, writeStateAtomic,
} from './state-migration.mjs';
import { openDatabase, closeDatabase, sqliteAvailable } from '../sqlite/db.mjs';
import { importState, verifyMirror } from '../sqlite/import.mjs';
import { acquireBridgeLock, releaseBridgeLock, readBridgeLock, lockPath } from '../core.mjs';

/** The name of the backup of a file. */
export const BACKUP_SUFFIX = '.bak';

/** The name of the journal file of a data directory. */
export const JOURNAL_SUFFIX = '.migration-journal.json';

/** The name of the marker file that records what the migration wrote. */
export const MARKER_SUFFIX = '.migration-marker.json';

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
 * The sha256 of a file, or null when the file does not exist.
 *
 * @param {string} file the path of the file
 * @returns {string|null} the hex digest
 */
export function digestOf(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * The journal of a migration: what was done, so that it can be undone.
 *
 * The journal is not only an in-memory object: it is WRITTEN TO DISK before
 * the first destructive write and removed only when the migration is
 * complete. A process that is killed half way through therefore leaves a
 * journal behind, and the next invocation can finish or undo the migration
 * instead of reporting a success over a half-migrated directory.
 */
export class MigrationJournal {
  /**
   * @param {object} [data] the state of a journal read back from disk
   */
  constructor(data = {}) {
    /** @type {string[]} the steps that were completed, in order */
    this.steps = [...(data.steps ?? [])];
    /** @type {Array<{from:string,to:string}>} the run folders that were renamed */
    this.renamedFolders = [...(data.renamedFolders ?? [])];
    /** @type {string[]} the files that were backed up */
    this.backups = [...(data.backups ?? [])];
    /** @type {string|null} the path of the journal file, when it is on disk */
    this.file = data.file ?? null;
    /** @type {string|null} the sha256 of the state the migration wrote */
    this.appliedDigest = data.appliedDigest ?? null;
    /** @type {string|null} the path of the state file that is migrated */
    this.statePath = data.statePath ?? null;
  }

  /** Records a completed step. */
  done(step) {
    this.steps.push(step);
    this.persist();
    return this;
  }

  /** The steps that have to be undone, in reverse order. */
  undoSteps() {
    return [...this.steps].reverse();
  }

  /**
   * Writes the journal to disk, so that a killed process leaves a record.
   *
   * The write is ATOMIC (temporary file + rename), because a journal that
   * is half written is worse than no journal: it would be read back as a
   * corrupt file and the recovery would be skipped.
   */
  persist() {
    if (!this.file) return;
    const data = {
      steps: this.steps,
      renamedFolders: this.renamedFolders,
      backups: this.backups,
      appliedDigest: this.appliedDigest,
      statePath: this.statePath,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** Removes the journal from disk -- the migration is complete. */
  clear() {
    if (this.file) fs.rmSync(this.file, { force: true });
  }
}

/**
 * Writes the marker of a completed migration.
 *
 * The marker records the sha256 of the state the migration WROTE. The
 * journal is removed when the migration completes, so the marker is what
 * survives: the rollback compares the current state file against it and
 * knows whether the state has changed since the migration.
 *
 * @param {string} dataDir the data directory
 * @param {string} statePath the state file that was written
 * @param {string} digest the sha256 of the written state
 */
export function writeMarker(dataDir, statePath, digest) {
  const file = path.join(dataDir, MARKER_SUFFIX);
  const data = { statePath, digest, at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Reads the marker of a completed migration, or null when there is none.
 *
 * @param {string} dataDir the data directory
 * @returns {{statePath:string,digest:string,at:string}|null}
 */
export function readMarker(dataDir) {
  const file = path.join(dataDir, MARKER_SUFFIX);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Reads the journal of a data directory, or null when there is none.
 *
 * @param {string} dataDir the data directory
 * @returns {MigrationJournal|null}
 */
export function readJournal(dataDir) {
  const file = path.join(dataDir, JOURNAL_SUFFIX);
  if (!fs.existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A journal that cannot be parsed is a journal that cannot be trusted.
    // It is kept (not deleted) so that the operator can look at it.
    return null;
  }
  return new MigrationJournal({ ...data, file });
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
 * @param {string} [statePath] the state file, when it is not `<dir>/state.json`
 * @returns {{dataDir:string,statePath:string,runsDir:string,dbPath:string,lockFile:string}}
 */
export function pathsOf(dataDir, statePath) {
  return {
    dataDir,
    statePath: statePath ?? path.join(dataDir, 'state.json'),
    runsDir: path.join(dataDir, 'runs'),
    dbPath: path.join(dataDir, 'metadata.db'),
    lockFile: lockPath(dataDir),
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
 * The runs of a state that the v0.1 backup does NOT have.
 *
 * These are the runs that a rollback would DISCARD: they were created
 * after the migration and their evidence would become unreachable.
 *
 * @param {object} currentState the state file as it is now
 * @param {object} backupState the state the backup holds
 * @returns {string[]} the identifiers of the runs that would be lost
 */
export function runsLostByRollback(currentState, backupState) {
  const backupIds = new Set((backupState?.runs ?? []).map((r) => String(r.id)));
  return (currentState?.runs ?? [])
    .map((r) => String(r.id))
    .filter((id) => !backupIds.has(id));
}

/**
 * Applies a safe migration to a data directory.
 *
 * @param {string} dataDir the data directory
 * @param {object} options
 * @param {boolean} [options.dryRun] compute the plan and write nothing
 * @param {boolean} [options.importDatabase] import into the metadata database
 * @param {boolean} [options.rollbackOnFailure] undo the steps of a failed run
 * @param {string} [options.statePath] the state file to migrate
 * @returns {object} the report
 */
export function applyMigration(dataDir, options = {}) {
  const paths = pathsOf(dataDir, options.statePath);
  const report = {
    dataDir,
    statePath: paths.statePath,
    alreadyMigrated: false,
    dryRun: Boolean(options.dryRun),
    before: null,
    after: null,
    changes: [],
    renamedFolders: [],
    imported: false,
    problems: [],
    undone: [],
    rolledBack: false,
    failed: false,
    refused: false,
  };

  // --- the recovery of an interrupted migration --------------------------
  // A journal on disk means that a previous run was killed half way
  // through. The migration is finished here, or refused with the recovery
  // steps -- but never silently reported as a success over a directory
  // whose evidence is unreachable.
  const pending = readJournal(dataDir);
  if (pending) {
    const recovery = recoverInterrupted(dataDir, paths, pending, options);
    Object.assign(report, recovery.report);
    if (!recovery.ok) return report;
  }

  let raw;
  try {
    raw = fs.readFileSync(paths.statePath, 'utf8');
  } catch (e) {
    report.problems.push(`STATE_FILE_UNREADABLE: ${e.message}`);
    report.failed = true;
    return report;
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    report.problems.push(`STATE_NOT_JSON: ${e.message}`);
    report.failed = true;
    return report;
  }

  const before = summarizeState(state);
  const already = isMigrated(state);
  report.alreadyMigrated = already;

  // --- an already migrated state is never re-migrated --------------------
  // Re-migrating would overwrite the v0.1 backup with the ALREADY MIGRATED
  // state, and the rollback would then restore a state that is not the
  // v0.1 one: the original data would be gone for good.
  //
  // The one thing that is still allowed is importing the mirror of an
  // already migrated state -- that touches neither the state file nor the
  // backup.
  if (already) {
    report.before = before;
    report.after = before;
    if (options.dryRun) {
      report.problems.push('dry run: nothing written');
      return report;
    }
    if (!options.importDatabase) {
      report.problems.push('ALREADY_MIGRATED: the state file is already migrated; nothing was written');
      report.refused = true;
      return report;
    }
    const imported = importAndVerify(state, paths.dbPath, options);
    if (!imported.ok) {
      report.problems.push(...imported.problems);
      report.failed = true;
      return report;
    }
    if (fs.existsSync(paths.dbPath)) fs.rmSync(paths.dbPath, { force: true });
    fs.renameSync(imported.tmp, paths.dbPath);
    report.imported = true;
    report.ok = true;
    return report;
  }

  let plan;
  try {
    plan = planMigration(state);
  } catch (e) {
    report.problems.push(e.message);
    report.failed = true;
    report.refused = true;
    return report;
  }
  const after = summarizeState(plan.state);
  report.before = before;
  report.after = after;
  report.changes = plan.changes;
  report.renamedFolders = plan.renamedFolders;

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

  // --- the lock -----------------------------------------------------------
  // The lock is taken for the whole write, so that the Bridge cannot start
  // in between the folder rename and the state rewrite.
  let locked = false;
  try {
    acquireBridgeLock(paths.lockFile);
    locked = true;
  } catch (e) {
    report.problems.push(`BRIDGE_ALREADY_RUNNING: ${e.message}`);
    report.failed = true;
    report.refused = true;
    return report;
  }

  try {
    // --- the journal ----------------------------------------------------
    // The journal is written BEFORE the first destructive write, so that a
    // process that is killed leaves a record of what it was doing.
    const journal = new MigrationJournal({
      file: path.join(dataDir, JOURNAL_SUFFIX),
      statePath: paths.statePath,
    });
    journal.persist();

    // --- the backups ------------------------------------------------------
    // Every file that is about to be overwritten is copied first. The backup
    // is what the rollback restores.
    //
    // The backup of a v0.1 state is NEVER overwritten: if a backup already
    // exists, it holds the state as it was BEFORE the first migration, and
    // that is the only copy of the original data. A second `apply` (with
    // `--import-db`, say) would otherwise replace it with the already
    // migrated state, and the rollback would no longer restore v0.1.
    if (fs.existsSync(paths.statePath)) {
      if (!fs.existsSync(`${paths.statePath}${BACKUP_SUFFIX}`)) {
        backupFile(paths.statePath);
      }
      journal.backups.push(paths.statePath);
    }
    if (options.importDatabase && fs.existsSync(paths.dbPath)) {
      if (!fs.existsSync(`${paths.dbPath}${BACKUP_SUFFIX}`)) {
        backupFile(paths.dbPath);
      }
      journal.backups.push(paths.dbPath);
    }
    journal.persist();

    try {
      // --- the state file --------------------------------------------------
      writeStateAtomic(paths.statePath, plan.state);
      journal.appliedDigest = digestOf(paths.statePath);
      journal.done('state');

      // --- the run folders -------------------------------------------------
      // The step is recorded BEFORE the renames start, not after: a rename
      // that fails half way through has to be undone, and the undo is
      // driven by the steps that were recorded. A step that is only
      // recorded when it has COMPLETED is a step that is never undone.
      //
      // Every single rename is recorded as it happens, so that the record
      // of the folders that were already renamed is exact.
      journal.done('folders');
      const renamed = renameRunFolders(paths.runsDir, plan.renamedFolders, (done) => {
        journal.renamedFolders = done;
        journal.persist();
      });
      journal.renamedFolders = renamed;

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
      journal.clear();
      return report;
    }

    // The migration is complete: the journal has served its purpose, and
    // the marker records what was written, so that a later rollback can
    // tell whether the state has changed since.
    journal.clear();
    writeMarker(dataDir, paths.statePath, journal.appliedDigest);
    report.ok = true;
    return report;
  } finally {
    if (locked) releaseBridgeLock(paths.lockFile);
  }
}

/**
 * Finishes or undoes a migration that was interrupted.
 *
 * A journal on disk means that a previous run was killed half way through
 * the migration. The directory is in an INCONSISTENT state: the state file
 * may already hold the new identifiers while the run folders are still
 * named after the old ones.
 *
 * The recovery FINISHES the migration when it can (the folders are renamed
 * to what the state file already refers to), and refuses otherwise -- with
 * the recovery steps, so that the operator can decide.
 *
 * @param {string} dataDir the data directory
 * @param {object} paths the paths of the data directory
 * @param {MigrationJournal} journal the journal that was found
 * @param {object} options the options of the call
 * @returns {{ok:boolean, report:object}}
 */
export function recoverInterrupted(dataDir, paths, journal, options = {}) {
  const report = {
    dataDir,
    statePath: paths.statePath,
    recovered: true,
    before: null,
    after: null,
    changes: [],
    renamedFolders: [],
    imported: false,
    problems: [],
    undone: [],
    rolledBack: false,
    failed: false,
    refused: false,
  };

  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
  } catch {
    current = null;
  }

  // The state file holds the NEW identifiers (the write happened) but the
  // folders are still named after the old ones: the migration is finished
  // by renaming the folders.
  if (current && isMigrated(current) && journal.steps.includes('state')) {
    const pending = [];
    for (const r of current.runs ?? []) {
      const legacy = r.legacyId ?? null;
      if (!legacy) continue;
      if (fs.existsSync(path.join(paths.runsDir, r.id))) continue;
      if (!fs.existsSync(path.join(paths.runsDir, legacy))) continue;
      pending.push({ from: legacy, to: String(r.id) });
    }
    try {
      const renamed = renameRunFolders(paths.runsDir, pending);
      report.renamedFolders = renamed;
      report.problems.push(
        `an interrupted migration was FINISHED: ${renamed.length} run folder(s) were renamed`
      );
      journal.clear();
      report.before = summarizeState(current);
      report.after = report.before;
      report.ok = true;
      return { ok: true, report };
    } catch (e) {
      report.problems.push(
        `an interrupted migration was found and could NOT be finished: ${e.message}. ` +
        'The state file holds the migrated identifiers but some run folders are still named ' +
        'after the old ones. Run "rollback" to restore the pre-migration state.'
      );
      report.failed = true;
      report.refused = true;
      return { ok: false, report };
    }
  }

  // The state file was NOT written yet: the migration can simply be undone.
  if (!journal.steps.includes('state')) {
    report.undone = undoMigration(journal, paths);
    report.rolledBack = true;
    report.problems.push('an interrupted migration was found and was UNDONE');
    journal.clear();
    report.ok = true;
    return { ok: true, report };
  }

  report.problems.push(
    'an interrupted migration was found and could not be resolved automatically. ' +
    'The state file and the run folders may disagree. Run "rollback" to restore the ' +
    'pre-migration state, then run "apply" again.'
  );
  report.failed = true;
  report.refused = true;
  return { ok: false, report };
}

/**
 * Rolls a migration back explicitly.
 *
 * @param {string} dataDir the data directory
 * @param {object} [options]
 * @param {boolean} [options.force] roll back even when the state has
 *   diverged from the state the migration wrote
 * @param {string} [options.statePath] the state file to roll back
 * @returns {{restored:boolean, undone:string[], problems:string[], lost:string[]}}
 */
export function rollbackMigration(dataDir, options = {}) {
  const paths = pathsOf(dataDir, options.statePath);
  const problems = [];
  const undone = [];
  const lost = [];

  const backup = `${paths.statePath}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(backup)) {
    return { restored: false, undone, problems: ['NO_BACKUP_TO_RESTORE'], lost };
  }

  // --- the divergence check ----------------------------------------------
  // The rollback restores the state file from the backup. If the state file
  // has CHANGED since the migration wrote it, the rollback would silently
  // discard that change -- for instance the runs the bridge recorded after
  // the migration. The rollback therefore refuses by default and NAMES the
  // runs that would be lost.
  //
  // The digest of the state the migration wrote is recorded in the marker
  // (and in the journal of an interrupted migration). The rollback
  // compares the current state file against it and knows whether the state
  // has changed since the migration.
  const journal = readJournal(dataDir);
  const marker = readMarker(dataDir);
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
  } catch {
    current = null;
  }
  const backupState = JSON.parse(fs.readFileSync(backup, 'utf8'));

  if (current) {
    lost.push(...runsLostByRollback(current, backupState));
  }

  const appliedDigest = journal?.appliedDigest ?? marker?.digest ?? null;
  const currentDigest = digestOf(paths.statePath);
  const diverged = Boolean(
    current && appliedDigest && currentDigest && appliedDigest !== currentDigest
  );

  if (diverged && !options.force) {
    // The rollback would discard what changed since the migration. The runs
    // that would be lost are NAMED, so the operator can see what is at
    // stake -- and the state is left untouched.
    const detail = lost.length
      ? `The rollback would DISCARD ${lost.length} run(s) that were recorded after the ` +
        `migration: ${lost.join(', ')}.`
      : 'The state file has been changed since the migration wrote it.';
    return {
      restored: false,
      undone,
      lost,
      problems: [
        `STATE_DIVERGED: ${detail} ` +
        'Re-run with --force to roll back anyway, or remove the changes yourself first.',
      ],
    };
  }

  // The folders are renamed back first: the restored state file refers to
  // the legacy identifiers, and a state file that points at folders that
  // do not exist is not a restored state.
  const { renamedFolders } = planMigration(backupState);
  const back = renamedFolders.map((f) => ({ from: f.to, to: f.from }));
  const renamed = renameRunFolders(paths.runsDir, back);
  for (const f of renamed) undone.push(`run folder renamed back: ${f.to} -> ${f.from}`);

  if (restoreBackup(paths.statePath)) undone.push(`state file restored: ${paths.statePath}`);
  else problems.push('the state file could not be restored');

  if (fs.existsSync(`${paths.dbPath}${BACKUP_SUFFIX}`)) {
    if (restoreBackup(paths.dbPath)) undone.push(`database restored: ${paths.dbPath}`);
    else problems.push('the database could not be restored');
  }

  // The journal of an interrupted migration is not needed any more.
  const pending = readJournal(dataDir);
  if (pending) pending.clear();

  return { restored: problems.length === 0, undone, problems, lost };
}
