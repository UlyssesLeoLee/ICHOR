#!/usr/bin/env node
/**
 * ATS-205 -- the SQLite metadata layer command line tool.
 *
 * The tool operates on the data directory of the bridge:
 *
 *   node tools/sqlite_meta.mjs status
 *       Prints the schema version of the metadata database and the row
 *       counts of every table. Read-only.
 *
 *   node tools/sqlite_meta.mjs import [--state <path>] [--db <path>]
 *       Imports the JSON state into the metadata database. The JSON state
 *       file is NOT modified: the layer is a mirror.
 *
 *   node tools/sqlite_meta.mjs migrate [--db <path>] [--to <version>]
 *       Applies the pending migration steps. Prints what was applied.
 *
 *   node tools/sqlite_meta.mjs downgrade --to <version> [--db <path>]
 *       Reverts the database to the version BEFORE <version>. This DROPS the
 *       objects of the higher versions and their data with them; it is an
 *       explicit, operator-requested action.
 *
 *   node tools/sqlite_meta.mjs verify [--state <path>] [--db <path>]
 *       Checks that the database holds exactly the state of the JSON file.
 *
 * Exit codes
 * ----------
 *   0  the command succeeded
 *   1  the command failed (the reason is printed on stderr)
 *   2  the usage is wrong
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDatabase, closeDatabase, currentVersion, migrateDatabase,
  downgradeDatabase, sqliteAvailable,
} from '../server/sqlite/db.mjs';
import { importState, verifyMirror } from '../server/sqlite/import.mjs';
import { counts } from '../server/sqlite/store.mjs';
import { SCHEMA_VERSION, latestVersion } from '../server/sqlite/schema.mjs';

const USAGE = `usage: node tools/sqlite_meta.mjs <status|import|migrate|downgrade|verify> [options]

  --state <path>  the JSON state file (default: $ATS_DATA_DIR/state.json)
  --db <path>     the metadata database (default: $ATS_DATA_DIR/metadata.db)
  --to <version>  the target schema version
`;

function parseArgs(argv) {
  const out = { command: argv[0], state: null, db: null, to: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') { out.state = argv[++i]; continue; }
    if (a === '--db') { out.db = argv[++i]; continue; }
    if (a === '--to') { out.to = Number(argv[++i]); continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function dataDir() {
  return process.env.ATS_DATA_DIR
    ? path.resolve(process.env.ATS_DATA_DIR)
    : path.join(os.homedir(), '.ai-test-studio');
}

function defaultStatePath() {
  return path.join(dataDir(), 'state.json');
}

function defaultDbPath() {
  return path.join(dataDir(), 'metadata.db');
}

function readState(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const state = JSON.parse(raw);
  if (!Array.isArray(state.projects) || !Array.isArray(state.runs)) {
    throw new Error('UNSUPPORTED_DATABASE');
  }
  return state;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(USAGE);
    return args.command ? 0 : 2;
  }
  if (!sqliteAvailable()) {
    process.stderr.write(
      'node:sqlite is not available in this Node build -- the metadata layer cannot be used.\n'
    );
    return 1;
  }

  const statePath = args.state ? path.resolve(args.state) : defaultStatePath();
  const dbPath = args.db ? path.resolve(args.db) : defaultDbPath();

  if (args.command === 'status') {
    // A status query is READ-ONLY: a database that does not exist yet is
    // reported as an empty database at version 0, and no file is created.
    if (!fs.existsSync(dbPath)) {
      console.log(`database    : ${dbPath} (does not exist yet)`);
      console.log(`schema      : 0 (the code knows up to ${latestVersion()})`);
      console.log(`pending     : the database will be created at version ${latestVersion()}`);
      return 0;
    }
    const db = openDatabase(dbPath, { migrate: false });
    try {
      const version = currentVersion(db);
      console.log(`database    : ${dbPath}`);
      console.log(`schema      : ${version} (the code knows up to ${latestVersion()})`);
      console.log(`journal     : ${db.prepare('PRAGMA journal_mode').get().journal_mode}`);
      console.log('row counts  :');
      for (const [table, n] of Object.entries(counts(db))) {
        console.log(`  ${table.padEnd(12)} ${n}`);
      }
      if (version < latestVersion()) {
        console.log(`pending     : migration to version ${latestVersion()} is available`);
      }
    } finally {
      closeDatabase(db);
    }
    return 0;
  }

  if (args.command === 'import') {
    if (!fs.existsSync(statePath)) {
      process.stderr.write(`the state file does not exist: ${statePath}\n`);
      return 1;
    }
    const state = readState(statePath);
    const db = openDatabase(dbPath, { migrate: true });
    try {
      const report = importState(db, state);
      const check = verifyMirror(db, state);
      console.log(`imported    : ${JSON.stringify(report)}`);
      console.log(`mirror      : ${check.ok ? 'OK' : 'MISMATCH -> ' + check.problems.join('; ')}`);
      if (!check.ok) return 1;
    } finally {
      closeDatabase(db);
    }
    return 0;
  }

  if (args.command === 'migrate') {
    const db = openDatabase(dbPath, { migrate: false });
    try {
      const result = migrateDatabase(db, args.to ?? null);
      console.log(`migrated    : ${JSON.stringify(result)}`);
    } finally {
      closeDatabase(db);
    }
    return 0;
  }

  if (args.command === 'downgrade') {
    if (args.to === null || !Number.isInteger(args.to)) {
      process.stderr.write('--to <version> is required for a downgrade\n');
      return 2;
    }
    const db = openDatabase(dbPath, { migrate: false });
    try {
      const result = downgradeDatabase(db, args.to);
      console.log(`downgraded  : ${JSON.stringify(result)}`);
    } finally {
      closeDatabase(db);
    }
    return 0;
  }

  if (args.command === 'verify') {
    if (!fs.existsSync(statePath)) {
      process.stderr.write(`the state file does not exist: ${statePath}\n`);
      return 1;
    }
    const state = readState(statePath);
    const db = openDatabase(dbPath, { migrate: false });
    try {
      const check = verifyMirror(db, state);
      console.log(`schema      : ${currentVersion(db)}`);
      console.log(`mirror      : ${check.ok ? 'OK' : 'MISMATCH'}`);
      for (const p of check.problems) console.log(`  problem   : ${p}`);
      if (!check.ok) return 1;
    } finally {
      closeDatabase(db);
    }
    return 0;
  }

  process.stderr.write(USAGE);
  return 2;
}

try {
  process.exit(main());
} catch (e) {
  process.stderr.write(`error: ${e?.message ?? e}\n`);
  process.exit(1);
}
