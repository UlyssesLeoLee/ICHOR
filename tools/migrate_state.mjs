#!/usr/bin/env node
/**
 * ATS-206 -- the data migration command line tool.
 *
 * It migrates a v0.1 JSON state (`state.json`) to the current scheme, keeps
 * a backup before every destructive write, and can undo a migration.
 *
 *   node tools/migrate_state.mjs plan   [--data-dir <dir>] [--state <path>]
 *       Prints what the migration WOULD do. Nothing is written.
 *
 *   node tools/migrate_state.mjs apply  [--data-dir <dir>] [--state <path>]
 *                                           [--import-db] [--no-rollback]
 *       Applies the migration. The backup is written first; a failure is
 *       undone automatically unless --no-rollback is given.
 *
 *   node tools/migrate_state.mjs verify [--data-dir <dir>] [--state <path>]
 *       Checks that the state file and the metadata database hold the same
 *       data, and that the counts are the ones the migration promised.
 *
 *   node tools/migrate_state.mjs rollback [--data-dir <dir>] [--state <path>]
 *       Restores the state file and the database from the backup and renames
 *       the run folders back to their old names.
 *
 * Exit codes
 * ----------
 *   0  the command succeeded
 *   1  the command failed (the reason is printed on stderr)
 *   2  the usage is wrong
 *   3  a Bridge is running -- the migration was refused
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planMigration, summarizeState, compareCounts, isMigrated, readStateFile,
} from '../server/migration/state-migration.mjs';
import {
  applyMigration, rollbackMigration, pathsOf, importAndVerify,
} from '../server/migration/apply.mjs';
import {
  openDatabase, closeDatabase, sqliteAvailable,
} from '../server/sqlite/db.mjs';
import { verifyMirror } from '../server/sqlite/import.mjs';
import { readBridgeLock, lockPath } from '../server/core.mjs';

const USAGE = `usage: node tools/migrate_state.mjs <plan|apply|verify|rollback> [options]

  --data-dir <dir>  the data directory (default: $ATS_DATA_DIR or ~/.ai-test-studio)
  --state <path>    the JSON state file (default: <data-dir>/state.json)
  --import-db       also import the migrated state into the metadata database
  --no-rollback     on a failure, do NOT undo the steps that were done
`;

function parseArgs(argv) {
  const out = { command: argv[0], dataDir: null, state: null, importDb: false, rollbackOnFailure: true };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') { out.dataDir = argv[++i]; continue; }
    if (a === '--state') { out.state = argv[++i]; continue; }
    if (a === '--import-db') { out.importDb = true; continue; }
    if (a === '--no-rollback') { out.rollbackOnFailure = false; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    const e = new Error(`unknown argument: ${a}`);
    e.code = 'UNKNOWN_ARGUMENT';
    throw e;
  }
  return out;
}

function defaultDataDir() {
  return process.env.ATS_DATA_DIR
    ? path.resolve(process.env.ATS_DATA_DIR)
    : path.join(os.homedir(), '.ai-test-studio');
}

/**
 * The data directory of the run: the state file decides where the data
 * directory is, unless it is given explicitly.
 */
function resolvePaths(args) {
  const dataDir = args.dataDir ? path.resolve(args.dataDir) : null;
  const statePath = args.state ? path.resolve(args.state) : null;
  if (statePath && !dataDir) {
    return { dataDir: path.dirname(statePath), statePath, runsDir: path.join(path.dirname(statePath), 'runs'), dbPath: path.join(path.dirname(statePath), 'metadata.db') };
  }
  const dir = dataDir ?? defaultDataDir();
  const paths = pathsOf(dir);
  if (statePath) paths.statePath = statePath;
  return paths;
}

function printCounts(label, counts) {
  console.log(
    `${label}: projects=${counts.projects} runs=${counts.runs} attempts=${counts.attempts} ` +
    `artifacts=${counts.artifacts} registryEntries=${counts.registryEntries}`
  );
}

/**
 * The `plan` command: what the migration would do.
 */
function commandPlan(args) {
  const paths = resolvePaths(args);
  const state = readStateFile(paths.statePath);
  const before = summarizeState(state);
  const plan = planMigration(state);
  const after = summarizeState(plan.state);

  console.log(`state file : ${paths.statePath}`);
  console.log(`migrated   : ${isMigrated(state) ? 'yes' : 'no'}`);
  printCounts('before', before);
  printCounts('after ', after);

  const problems = compareCounts(before, after);
  if (problems.length) {
    console.error('the migration would change the counts:');
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }

  for (const c of plan.changes) console.log(`change: ${c.kind} ${c.from} -> ${c.to}`);
  for (const f of plan.renamedFolders) console.log(`folder rename: ${f.from} -> ${f.to}`);
  console.log(`the counts are preserved: projects=${after.projects}, runs=${after.runs}`);
  return 0;
}

/**
 * The `apply` command: the migration itself.
 */
function commandApply(args) {
  const paths = resolvePaths(args);

  if (!fs.existsSync(paths.statePath)) {
    console.error(`state file not found: ${paths.statePath}`);
    return 1;
  }

  // The Bridge must not be running: it keeps its own copy of the state in
  // memory and writes it back on every change, so a migration that runs
  // under it would be overwritten by the next write.
  const holder = readBridgeLock(lockPath(paths.dataDir));
  if (holder) {
    console.error(
      `refusing to migrate: a Bridge is running (pid ${holder.pid}). ` +
      'Stop the Bridge first, then run the migration again.'
    );
    return 3;
  }

  const report = applyMigration(paths.dataDir, {
    importDatabase: args.importDb,
    rollbackOnFailure: args.rollbackOnFailure,
  });

  printCounts('before', report.before);
  printCounts('after ', report.after);

  for (const c of report.changes) console.log(`change: ${c.kind} ${c.from} -> ${c.to}`);
  for (const f of report.renamedFolders) console.log(`folder rename: ${f.from} -> ${f.to}`);

  if (report.failed) {
    console.error('the migration FAILED:');
    for (const p of report.problems) console.error(`  ${p}`);
    if (report.rolledBack) {
      console.error('the steps that were done have been undone:');
      for (const u of report.undone) console.error(`  ${u}`);
    } else {
      console.error('the steps that were done have NOT been undone (--no-rollback).');
    }
    return 1;
  }

  console.log(`migrated: ${paths.statePath}`);
  if (report.imported) console.log(`the metadata database was imported: ${paths.dbPath}`);
  console.log(`backup: ${paths.statePath}.bak`);
  console.log(`rollback: node tools/migrate_state.mjs rollback --data-dir ${paths.dataDir}`);
  return 0;
}

/**
 * The `verify` command: does the database hold the same data as the state?
 */
function commandVerify(args) {
  const paths = resolvePaths(args);
  const state = readStateFile(paths.statePath);

  if (!fs.existsSync(paths.dbPath)) {
    console.error(`no metadata database: ${paths.dbPath}`);
    return 1;
  }
  if (!sqliteAvailable()) {
    console.error('SQLITE_NOT_AVAILABLE: this build cannot read the metadata database');
    return 1;
  }

  const db = openDatabase(paths.dbPath, { create: false });
  let result;
  try {
    result = verifyMirror(db, state);
  } finally {
    closeDatabase(db);
  }

  if (!result.ok) {
    console.error('the database does NOT hold the same data as the state file:');
    for (const p of result.problems) console.error(`  ${p}`);
    return 1;
  }
  const counts = summarizeState(state);
  printCounts('state', counts);
  console.log(`the database holds the same data as ${paths.statePath}`);
  return 0;
}

/**
 * The `rollback` command: undo a migration.
 */
function commandRollback(args) {
  const paths = resolvePaths(args);
  const result = rollbackMigration(paths.dataDir);
  if (!result.restored) {
    console.error('the rollback FAILED:');
    for (const p of result.problems) console.error(`  ${p}`);
    return 1;
  }
  for (const u of result.undone) console.log(u);
  console.log(`rolled back: ${paths.dataDir}`);
  return 0;
}

export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    return 2;
  }
  if (args.help || !args.command) {
    console.log(USAGE);
    return args.command ? 0 : 2;
  }

  switch (args.command) {
    case 'plan': return commandPlan(args);
    case 'apply': return commandApply(args);
    case 'verify': return commandVerify(args);
    case 'rollback': return commandRollback(args);
    default:
      console.error(`unknown command: ${args.command}`);
      console.error(USAGE);
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
