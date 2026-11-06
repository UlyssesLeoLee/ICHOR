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
 *       Reverts the database TO <version>. The steps above <version> are
 *       reverted in descending order. This DROPS the objects of the higher
 *       versions and their data with them; it is an explicit,
 *       operator-requested action. The bridge has to be STOPPED first: a
 *       running bridge re-applies the migration on its next write.
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
import { fileURLToPath } from 'node:url';
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
  --to <version>  the target schema version: an integer in [0, ${latestVersion()}]
                  (0 = empty the database). Anything else is a usage error.
`;

function parseArgs(argv) {
  const out = { command: argv[0], state: null, db: null, to: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') { out.state = argv[++i]; continue; }
    if (a === '--db') { out.db = argv[++i]; continue; }
    if (a === '--to') {
      // The RAW value is kept: `Number('abc')` is NaN and `Number('-1')` is a
      // number, so the validation has to see what the operator actually
      // typed. `--to` without a value is a usage error too.
      out.toRaw = argv[++i];
      out.to = out.toRaw === undefined ? undefined : Number(out.toRaw);
      continue;
    }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    // An unknown argument is a USAGE error (exit code 2), not a crash.
    const e = new Error(`unknown argument: ${a}`);
    e.code = 'UNKNOWN_ARGUMENT';
    throw e;
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

/**
 * Validates a `--to` argument.
 *
 * The target version must be an INTEGER in [0, latestVersion()]. Anything
 * else -- a word, a fraction, a negative number, a version the code does
 * not know -- is a usage error (exit code 2), not a silent no-op.
 *
 * @returns {{ok:true,value:number}|{ok:false,message:string}}
 */
function validateTarget(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, message: '--to <version> is required' };
  }
  if (!/^-?\d+$/.test(String(raw).trim())) {
    return { ok: false, message: `--to must be an integer, got ${JSON.stringify(raw)}` };
  }
  const value = Number(raw);
  const max = latestVersion();
  if (!Number.isInteger(value) || value < 0 || value > max) {
    return { ok: false, message: `--to must be an integer in [0, ${max}], got ${JSON.stringify(raw)}` };
  }
  return { ok: true, value };
}

/**
 * Opens the metadata database WITHOUT creating it.
 *
 * `status` and `verify` are read-only commands: they must not leave a file
 * behind that nobody asked for. `openDatabase` creates the file (and its
 * -wal/-shm sidecars) when it is opened, so the read-only commands check
 * for the file first and refuse to open a database that is not there.
 */
function openExistingDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) {
    const e = new Error(`the metadata database does not exist: ${dbPath}`);
    e.code = 'METADATA_DB_MISSING';
    throw e;
  }
  return openDatabase(dbPath, { migrate: false });
}

/**
 * Runs the tool.
 *
 * The arguments are a parameter (and not `process.argv`) so that the
 * function can be called IN-PROCESS by the test suite: a test that
 * spawns the tool as a child process cannot cover the branches of this
 * file, and a coverage number that only counts the child process is not a
 * measurement of anything.
 *
 * @param {string[]} [argv] the command line, without the node executable
 * @returns {number} the exit code
 */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
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
    // The target version is validated BEFORE anything is opened or created:
    // an invalid target is a usage error and must not touch the database.
    let target = null;
    if (args.toRaw !== undefined) {
      const check = validateTarget(args.toRaw);
      if (!check.ok) {
        process.stderr.write(`${check.message}\n`);
        return 2;
      }
      target = check.value;
    }
    const db = openDatabase(dbPath, { migrate: false });
    try {
      const result = migrateDatabase(db, target);
      console.log(`migrated    : ${JSON.stringify(result)}`);
    } finally {
      closeDatabase(db);
    }
    return 0;
  }

  if (args.command === 'downgrade') {
    const check = validateTarget(args.toRaw);
    if (!check.ok) {
      process.stderr.write(`${check.message}\n`);
      return 2;
    }
    let db = null;
    try {
      db = openExistingDatabase(dbPath);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    try {
      const result = downgradeDatabase(db, check.value);
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
    // `verify` is read-only: it must not CREATE the database it is asked
    // to check. A missing database is reported, not created.
    let db = null;
    try {
      db = openExistingDatabase(dbPath);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
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

/**
 * Runs the tool as a command line program.
 *
 * The check on the entry module matters: when the test suite imports this
 * file to exercise `main()` in-process, the import must NOT run the tool
 * and must NOT call `process.exit()` -- that would kill the test run.
 *
 * @returns {number} the exit code
 */
export function runCli(argv = process.argv.slice(2)) {
  try {
    return main(argv);
  } catch (e) {
    process.stderr.write(`error: ${e?.message ?? e}\n`);
    return 1;
  }
}

// The entry module is the file the node executable was started with. On
// Windows `import.meta.url` is a `file://` URL, so it is decoded with
// `fileURLToPath` instead of being patched by hand.
const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  process.exit(runCli());
}
