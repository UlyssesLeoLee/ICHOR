#!/usr/bin/env node
/**
 * ATS-209 -- the EVIDENCE RETENTION command line tool.
 *
 * It removes the EVIDENCE of the runs whose retention period has expired.
 * It does NOT remove the run records: the status, the summary, the
 * attempts and the events of a run stay in the state file, because the
 * history of what happened is not the same thing as the files that prove
 * it.
 *
 * THAT IS THE WHOLE POINT OF THE TASK
 * ------------------------------------
 * The acceptance criterion is 「保留期到期可清理且不误删 Run 元数据」. So the
 * tool is written so that the two cannot be confused:
 *
 *   * it operates on the RUN FOLDERS, and only on the evidence files in
 *     them;
 *   * it never touches the state file, the SQLite mirror, or any field of
 *     a run record -- it only READS the state to know which runs exist;
 *   * it REFUSES to run against a data directory that a Bridge holds.
 *
 * THE REFUSAL
 * ------------
 * A Bridge that is running keeps its own copy of the state in memory and
 * writes it back on every change. A cleaner that deleted a run's folder
 * under it would leave the state pointing at files that are gone, and the
 * next save would write that state back. So the tool checks the data
 * directory's lock first and refuses when a Bridge holds it -- the same
 * rule the migration tool follows.
 *
 * THE COMMANDS
 * ------------
 *   node tools/evidence_retention.mjs plan   [--data-dir <dir>] [--days N]
 *       Prints what would be cleaned. Nothing is written.
 *
 *   node tools/evidence_retention.mjs clean  [--data-dir <dir>] [--days N]
 *                                                 [--dry-run] [--yes]
 *       Removes the expired evidence. Without --yes it refuses, so a
 *       cleaning never happens by accident.
 *
 *   node tools/evidence_retention.mjs verify [--data-dir <dir>]
 *       Verifies every run's evidence against its manifest and reports
 *       what does not match.
 *
 *   node tools/evidence_retention.mjs journal [--data-dir <dir>]
 *       Prints the cleaning journal -- what was removed, when, and by
 *       which run.
 *
 * Exit codes
 * ----------
 *   0  the command succeeded
 *   1  the command failed (the reason is printed on stderr)
 *   2  the usage is wrong
 *   3  a Bridge is running -- the operation was refused
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBridgeLock, isValidRunId } from '../server/core.mjs';
import {
  DEFAULT_RETENTION_DAYS, verifyEvidence,
} from '../server/evidence/manifest.mjs';
import {
  CLEANER_JOURNAL, cleanExpiredEvidence, cleanerLockState, planRetention, readJournal,
} from '../server/evidence/retention.mjs';
import { pruneStore, storeBytes, storeDirOf } from '../server/evidence/store.mjs';

const USAGE = `usage: node tools/evidence_retention.mjs <plan|clean|verify|journal> [options]

  --data-dir <dir>  the data directory (default: $ATS_DATA_DIR or ~/.ai-test-studio)
  --days <n>        the retention period in days (default: ${DEFAULT_RETENTION_DAYS})
  --dry-run         report what would be removed, remove nothing
  --yes             confirm the cleaning (required for "clean")
  --prune-store     accepted and ignored: a real cleaning always prunes the store
  --help            this text
`;

function parseArgs(argv) {
  const out = {
    command: argv[0], dataDir: null, days: DEFAULT_RETENTION_DAYS,
    dryRun: false, yes: false, pruneStore: false, help: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') { out.dataDir = argv[++i]; continue; }
    if (a === '--days') { out.days = Number(argv[++i]); continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--yes') { out.yes = true; continue; }
    if (a === '--prune-store') { out.pruneStore = true; continue; }
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
 * The state of the data directory.
 *
 * A data directory that has no state file is an empty installation: there
 * is nothing to clean and nothing to report, and that is not an error.
 */
function readState(dataDir) {
  const file = path.join(dataDir, 'state.json');
  if (!fs.existsSync(file)) return { state: { schema: 1, projects: [], runs: [] }, missing: true };
  try {
    return { state: JSON.parse(fs.readFileSync(file, 'utf8')), missing: false };
  } catch (e) {
    const err = new Error(`the state file could not be read (${e.message})`);
    err.code = 'STATE_UNREADABLE';
    throw err;
  }
}

/**
 * The folder of a run.
 *
 * ATS-209 review round 1 (E3): the run id is VALIDATED before it becomes
 * a path. The state file is data on the disk, and a run id that is not a
 * run id must never be turned into a path -- a cleaner that built
 * `<data-dir>/runs/../../state.json` out of one would delete the state
 * file of the data directory it was cleaning.
 */
const folderOf = (dataDir) => (run) => {
  if (!isValidRunId(run?.id)) return null;
  return path.join(dataDir, 'runs', run.id);
};

/**
 * The `plan` command: what the cleaning WOULD do.
 */
function commandPlan(args) {
  const dataDir = args.dataDir ? path.resolve(args.dataDir) : defaultDataDir();
  const { state } = readState(dataDir);
  const plan = planRetention(state.runs ?? [], folderOf(dataDir), { days: args.days });
  console.log(`data dir : ${dataDir}`);
  console.log(`runs     : ${(state.runs ?? []).length}`);
  console.log(`period   : ${plan.days} days`);
  console.log(`expired  : ${plan.expiredCount}`);
  console.log(`evidence : ${plan.expiredBytes} bytes expired, ${plan.keptBytes} bytes kept`);
  console.log(`shared   : ${plan.sharedBytes} bytes are stored more than once`);
  console.log(`store    : ${storeBytes(storeDirOf(dataDir))} bytes`);
  for (const e of plan.expired) {
    console.log(`  expired: ${e.runId} (finished ${e.finishedAt}, ${Math.floor(e.ageDays)} days old)`);
  }
  return 0;
}

/**
 * The `clean` command: the cleaning itself.
 */
function commandClean(args) {
  const dataDir = args.dataDir ? path.resolve(args.dataDir) : defaultDataDir();
  const lockFile = path.join(dataDir, 'bridge.lock');
  // The Bridge must not be running: it keeps its own copy of the state in
  // memory and writes it back on every change.
  const lock = cleanerLockState(lockFile);
  if (lock.held) {
    console.error(
      `refusing to clean: a Bridge is running (pid ${lock.holder?.pid ?? 'unknown'}). ` +
      'Stop the Bridge first, then run the cleaning again.'
    );
    return 3;
  }
  if (!args.yes && !args.dryRun) {
    console.error('refusing to clean without --yes: run the plan first, then confirm');
    return 2;
  }
  const { state } = readState(dataDir);
  const journalFile = path.join(dataDir, CLEANER_JOURNAL);
  const result = cleanExpiredEvidence({
    runs: state.runs ?? [],
    folderOf: folderOf(dataDir),
    days: args.days,
    journalFile,
    dryRun: args.dryRun,
    lockHeld: false,
  });
  if (!result.ok) {
    console.error(`the cleaning was refused: ${result.reason}`);
    return 1;
  }
  console.log(`data dir : ${dataDir}`);
  console.log(`period   : ${result.days} days`);
  console.log(`expired  : ${result.expired.length}`);
  console.log(`cleaned  : ${result.cleaned.length}`);
  for (const c of result.cleaned) {
    console.log(`  ${c.runId}: removed ${c.removed.length} file(s), kept ${c.kept.join(', ') || '(nothing)'}`);
    // ATS-209 review round 1 (E3): the entries that pointed outside the
    // run folder were refused. They are printed, because a refusal the
    // operator cannot see is a refusal that did not happen.
    for (const r of c.rejected ?? []) {
      console.log(`    refused: ${r.file} (${r.reason})`);
    }
  }
  for (const s of result.skipped) {
    console.log(`  ${s.runId}: skipped -- ${s.reason}`);
  }
  // The RUN RECORDS are untouched. The tool prints the count so the
  // operator can see that the runs are still there after the cleaning.
  console.log(`run records kept: ${(state.runs ?? []).length}`);
  // ATS-209 review round 1 (E8): the stored copies of the cleaned
  // evidence are removed TOO, by the same command. The evidence may hold
  // PII, and a cleaning that left the bytes in the store would not be a
  // deletion at all: the data would still be on the disk, just somewhere
  // the reader of the run folder does not look.
  //
  // The prune is SKIPPED on a dry run: a dry run removes nothing, and
  // that includes the store (the review probe measures it).
  if (args.dryRun) {
    console.log('dry run: nothing was removed');
  } else {
    const pruned = pruneStore(storeDirOf(dataDir));
    console.log(`store: removed ${pruned.removed.length} unreferenced blob(s), freed ${pruned.bytesFreed} bytes`);
    console.log(`journal: ${journalFile}`);
  }
  return 0;
}

/**
 * The `verify` command: does every run's evidence still match its manifest?
 *
 * A run whose evidence was removed BY THE RETENTION POLICY is not a
 * tamper: the cleaner left a record of what it removed, and the
 * verification reports those files as `cleaned` instead of `missing`. The
 * run does not fail, and the command does not exit 1 -- otherwise every
 * cleaned run would keep the verification red for ever, and the tamper
 * alarm would be worthless (ATS-209 review round 1, E7).
 *
 * A run whose evidence was changed, or whose files vanished WITHOUT a
 * cleaning record, is still reported and still fails.
 */
function commandVerify(args) {
  const dataDir = args.dataDir ? path.resolve(args.dataDir) : defaultDataDir();
  const { state } = readState(dataDir);
  let checked = 0;
  let failed = 0;
  let cleanedRuns = 0;
  for (const run of state.runs ?? []) {
    const result = verifyEvidence(folderOf(dataDir)(run));
    if (!result.ok) {
      console.log(`  ${run.id}: the manifest could not be read -- ${result.reason}`);
      failed += 1;
      continue;
    }
    checked += 1;
    if (!result.verified) {
      failed += 1;
      console.log(`  ${run.id}: the evidence does NOT match its manifest`);
      for (const f of result.missing) console.log(`    missing: ${f}`);
      for (const c of result.changed) {
        console.log(`    changed: ${c.file} (expected ${c.expected}, actual ${c.actual})`);
      }
      for (const r of result.rejected ?? []) {
        console.log(`    refused: ${r.file} (${r.reason})`);
      }
      if (result.truncated) {
        console.log('    the manifest does not cover the whole evidence folder');
      }
    } else if ((result.cleaned ?? []).length) {
      // The evidence was cleaned by the retention policy. That is not a
      // tamper, and the run does not fail.
      cleanedRuns += 1;
      console.log(`  ${run.id}: the evidence was cleaned by the retention policy (${result.cleaned.length} file(s))`);
    }
    for (const f of result.extra) console.log(`    extra: ${f} (not in the manifest)`);
  }
  console.log(`runs checked: ${checked}, not matching: ${failed}, cleaned by the retention policy: ${cleanedRuns}`);
  if (failed) {
    console.error('the evidence of at least one run does not match its manifest');
    return 1;
  }
  return 0;
}

/**
 * The `journal` command: the audit trail of the cleanings.
 */
function commandJournal(args) {
  const dataDir = args.dataDir ? path.resolve(args.dataDir) : defaultDataDir();
  const journal = readJournal(path.join(dataDir, CLEANER_JOURNAL));
  if (journal.missing) {
    console.log(`no cleaning journal in ${dataDir}`);
    return 0;
  }
  for (const e of journal.entries) {
    console.log(`${e.at} ${e.runId}: removed ${(e.removed ?? []).length} file(s), kept ${(e.kept ?? []).join(', ') || '(nothing)'}`);
  }
  for (const u of journal.unreadable) {
    console.error(`journal line ${u.line} could not be parsed: ${u.reason}`);
  }
  console.log(`entries: ${journal.entries.length}, unreadable: ${journal.unreadable.length}`);
  return journal.unreadable.length ? 1 : 0;
}

function main(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    return argv.length ? 0 : 2;
  }
  let args;
  try { args = parseArgs(argv); }
  catch (e) {
    console.error(e.message);
    console.error(USAGE);
    return 2;
  }
  if (args.help) { console.log(USAGE); return 0; }
  if (!Number.isFinite(args.days) || args.days < 0) {
    console.error('the retention period must be a number of days that is not negative');
    return 2;
  }
  try {
    switch (args.command) {
      case 'plan': return commandPlan(args);
      case 'clean': return commandClean(args);
      case 'verify': return commandVerify(args);
      case 'journal': return commandJournal(args);
      default:
        console.error(`unknown command: ${args.command}`);
        console.error(USAGE);
        return 2;
    }
  } catch (e) {
    console.error(`the command FAILED: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { main, parseArgs };
