#!/usr/bin/env node
/**
 * ATS-201: migration of a legacy state.json to the stable UID scheme (v1).
 *
 * What it does
 * ------------
 *   * rewrites every Project identifier to `proj_1_<24 hex>` (derived from
 *     the canonical project root);
 *   * rewrites every Run identifier to `run_1_<24 hex>` (derived from the
 *     project UID, the recorded commit, the target file and the per project
 *     execution sequence);
 *   * rewrites the references from the runs to their project, and migrates the
 *     durable per project run counter;
 *   * leaves the legacy identifiers in `legacyId` so that existing links,
 *     bookmarks and archived run folders stay resolvable.
 *
 * PRECONDITION -- the Bridge must NOT be running
 * ----------------------------------------------
 * The state file and the run folders are one piece of state. A Bridge that
 * is running keeps its own copy of the state in memory and writes it back on
 * every change; if a migration rewrites the file while the Bridge runs, the
 * Bridge's next write overwrites the migrated identifiers with the old ones
 * while the run folders on disk are already renamed. The result is a state
 * that points at folders that no longer exist.
 *
 * The script therefore takes an EXCLUSIVE lock on the data directory
 * (`bridge.lock`) and refuses to run while a live process holds it. The
 * Bridge takes the same lock when it starts, so the two can never overlap.
 *
 * The migration is deterministic: running it twice on the same input
 * produces the same output, and running it on an already migrated file
 * changes nothing (the script reports "already migrated").
 *
 * ROLLBACK
 * --------
 * `--backup` writes a copy of the ORIGINAL `state.json` next to it. That copy
 * restores the STATE FILE only. It does NOT undo the rename of the run
 * folders: the folders on disk are named after the NEW identifiers, and a
 * restored state file points at the OLD identifiers, so the archived evidence
 * of the renamed runs is no longer reachable. To roll back completely the
 * run folders have to be renamed back as well -- which is what
 * `--rollback` does: it restores the state file AND renames the folders back.
 *
 * Usage
 * -----
 *   node tools/migrate_uids.mjs --state <path to state.json> [--dry-run] [--backup]
 *   node tools/migrate_uids.mjs --state <path to state.json> --rollback
 *
 *   --state    the state file to migrate. Defaults to $ATS_DATA_DIR/state.json.
 *   --dry-run  print the planned changes without writing anything.
 *   --backup   keep a copy of the original next to the state file.
 *   --rollback undo a previous migration: restore the .bak state file and
 *              rename the run folders back to their legacy identifiers.
 *
 * Exit codes
 * ----------
 *   0  migration completed, or the file was already migrated
 *   1  the file could not be read, parsed or migrated
 *   2  the Bridge is running -- the migration was refused
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  UID_SCHEME_VERSION, projectUidFor, runUidFor, isProjectUid, isRunUid,
  isLegacyProjectUid, isLegacyRunUid, emptyRegistry, assignRunSeqs
} from '../server/uid.mjs';
import { acquireBridgeLock, releaseBridgeLock, readBridgeLock, lockPath } from '../server/core.mjs';
// ATS-206: the shared migration core. The logic of this tool now lives in
// `server/migration/state-migration.mjs`, so that the CLI of this task and
// the ATS-201 tool cannot drift apart: there is ONE implementation of the
// migration, and it is the one that does not lose the trust map or the UID
// registry.
import {
  planMigration as planMigrationCore, renameRunFolders as renameRunFoldersCore,
  isMigrated as isMigratedCore,
} from '../server/migration/state-migration.mjs';

function parseArgs(argv) {
  const out = { state: null, dryRun: false, backup: false, rollback: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') { out.state = argv[++i]; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--backup') { out.backup = true; continue; }
    if (a === '--rollback') { out.rollback = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function defaultStatePath() {
  const dir = process.env.ATS_DATA_DIR
    ? path.resolve(process.env.ATS_DATA_DIR)
    : path.join(os.homedir(), '.ai-test-studio');
  return path.join(dir, 'state.json');
}

/**
 * Computes the migration plan of one state object.
 * Pure: returns the new state and a list of changes, without touching disk.
 *
 * ATS-206: the implementation moved into `server/migration/state-migration.mjs`,
 * so that this tool and the ATS-206 CLI share ONE implementation. The old
 * copy of this function rebuilt the state from a fixed set of keys, which
 * dropped every key it did not know about -- including the `trust` map
 * (ATS-202) -- and it left the UID registry keyed by the OLD project
 * identifier, which made the registry entries unreachable. The shared core
 * carries the unknown keys over and re-keys the maps that are keyed by a
 * project identifier.
 */
export function planMigration(state) {
  return planMigrationCore(state);
}

/**
 * Renames the run folders on disk so that they match the migrated run ids.
 * Returns the list of folders that were actually renamed.
 */
export function renameRunFolders(runsDir, renamedFolders) {
  return renameRunFoldersCore(runsDir, renamedFolders);
}

/** True when every identifier of the state already follows the v1 scheme. */
export function isMigrated(state) {
  return isMigratedCore(state);
}

/**
 * Undoes a previous migration: restores the `.bak` state file and renames the
 * run folders back to their legacy identifiers.
 *
 * This is the COMPLETE rollback. Restoring the `.bak` file alone would leave
 * the folders named after the new identifiers, and the restored state would
 * point at folders that no longer exist.
 */
export function rollbackMigration(statePath, runsDir) {
  const backup = `${statePath}.bak`;
  if (!fs.existsSync(backup)) {
    throw new Error('NO_BACKUP_TO_RESTORE');
  }
  const restored = JSON.parse(fs.readFileSync(backup, 'utf8'));
  // The folders to rename back are the ones the MIGRATION renamed: the plan
  // is recomputed from the backup, which is the state as it was BEFORE the
  // migration. The backup itself carries the legacy identifiers, so the new
  // identifiers have to be derived from it.
  const { renamedFolders } = planMigration(restored);
  // The migration renamed legacy -> new; the rollback renames back.
  const back = renamedFolders.map((f) => ({ from: f.to, to: f.from }));
  const renamed = renameRunFolders(runsDir, back);
  for (const f of renamed) console.log(`run folder renamed back: ${f.from} -> ${f.to}`);
  fs.copyFileSync(backup, statePath);
  console.log(`rolled back: ${statePath}`);
  return { renamed, restoredFrom: backup };
}

export function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: node tools/migrate_uids.mjs --state <state.json> [--dry-run] [--backup] [--rollback]');
    return 0;
  }
  const statePath = args.state ? path.resolve(args.state) : defaultStatePath();
  if (!fs.existsSync(statePath)) {
    console.error(`state file not found: ${statePath}`);
    return 1;
  }

  // The Bridge must not be running: it keeps its own copy of the state in
  // memory and would overwrite the migrated identifiers with the old ones.
  const holder = readBridgeLock(lockPath(path.dirname(statePath)));
  if (holder) {
    console.error(
      `refusing to migrate: a Bridge is running (pid ${holder.pid}). ` +
      'Stop the Bridge first, then run the migration again.'
    );
    return 2;
  }

  let original;
  try {
    original = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    console.error(`cannot parse ${statePath}: ${e.message}`);
    return 1;
  }

  if (args.rollback) {
    try {
      rollbackMigration(statePath, path.join(path.dirname(statePath), 'runs'));
    } catch (e) {
      console.error(`rollback failed: ${e.message}`);
      return 1;
    }
    return 0;
  }

  if (isMigrated(original)) {
    console.log(`already migrated: ${statePath}`);
    console.log(`uidVersion=${original.uidVersion}`);
    return 0;
  }

  const { state: migrated, changes, renamedFolders } = planMigration(original);
  for (const c of changes) {
    console.log(`${c.kind}: ${c.from} -> ${c.to}`);
  }
  for (const f of renamedFolders) {
    console.log(`run folder rename required: ${f.from} -> ${f.to}`);
  }
  console.log(`projects: ${migrated.projects.length}, runs: ${migrated.runs.length}, changes: ${changes.length}`);

  if (args.dryRun) {
    console.log('dry run: nothing written');
    return 0;
  }

  // The lock is taken for the whole write, so the Bridge cannot start in
  // between the folder rename and the state rewrite.
  const lockFile = lockPath(path.dirname(statePath));
  acquireBridgeLock(lockFile);
  try {
    if (args.backup) {
      const backup = `${statePath}.bak`;
      fs.copyFileSync(statePath, backup);
      console.log(`backup written: ${backup}`);
    }

    const renamed = renameRunFolders(path.join(path.dirname(statePath), 'runs'), renamedFolders);
    for (const f of renamed) console.log(`run folder renamed: ${f.from} -> ${f.to}`);

    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(migrated, null, 2), 'utf8');
    fs.renameSync(tmp, statePath);
    console.log(`migrated: ${statePath}`);
    console.log('rollback: node tools/migrate_uids.mjs --state ' + statePath + ' --rollback');
  } finally {
    releaseBridgeLock(lockFile);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
