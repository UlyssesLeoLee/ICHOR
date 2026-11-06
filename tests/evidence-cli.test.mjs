/**
 * ATS-209 -- the evidence retention COMMAND LINE TOOL: the unit tests.
 *
 * The CLI is the operator's door into the retention policy, so its
 * behaviour is a part of the delivery:
 *
 *   * `clean` without `--yes` refuses (a cleaning never happens by
 *     accident);
 *   * `clean` removes the expired evidence AND the stored copies of it
 *     (the evidence may hold PII -- a cleaning that left the bytes in
 *     the store would not be a deletion at all);
 *   * `clean --dry-run` removes NOTHING, the store included;
 *   * `verify` reports a cleaned run as CLEANED, not as a tamper, and
 *     still reports a real tamper;
 *   * `plan` and `journal` say what happened.
 *
 * The commands are run as REAL processes against a REAL data directory:
 * the exit codes and the output are the contract an operator scripts
 * against, and a test that calls the functions directly would not see
 * them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'tools', 'evidence_retention.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ats-evidence-cli-'));

/**
 * Runs the CLI and returns its exit code, stdout and stderr.
 */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: root });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * A data directory with one expired run that has evidence.
 */
function makeDataDir({ runId = 'run_1_000000000000000000000001', status = 'passed' } = {}) {
  const dir = tmp();
  const folder = path.join(dir, 'runs', runId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'report.json'), '{"ok":true}');
  fs.writeFileSync(path.join(folder, 'events.jsonl'), '{"seq":1}\n');
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
    version: 2,
    runId,
    artifacts: [{ file: 'report.json', size: 11, sha256: 'aa'.repeat(32) }],
  }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    schema: 1,
    projects: [],
    runs: [{ id: runId, status, createdAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-01T00:00:00.000Z' }],
  }));
  return { dir, runId, folder };
}

test('CLI-EVD-001: the usage is printed when no command is given', () => {
  const r = cli();
  assert.equal(r.status, 2, 'a missing command is a usage error');
  assert.match(r.stdout, /usage: node tools\/evidence_retention\.mjs/);
});

test('CLI-EVD-002: --help is printed on request', () => {
  const r = cli('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--prune-store/);
});

test('CLI-EVD-003: an unknown argument is refused', () => {
  const r = cli('plan', '--nonsense');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument/);
});

test('CLI-EVD-004: an unknown command is refused', () => {
  const r = cli('frobnicate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
});

test('CLI-EVD-005: a retention period that is not a number is refused', () => {
  const r = cli('plan', '--days', '-1');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /retention period/);
});

test('CLI-EVD-006: a data directory with no state is not an error', () => {
  const dir = tmp();
  const r = cli('plan', '--data-dir', dir);
  assert.equal(r.status, 0, 'an empty installation has nothing to clean');
  assert.match(r.stdout, /runs     : 0/);
});

test('CLI-EVD-007: a state file that cannot be parsed is reported', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  const r = cli('plan', '--data-dir', dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not be read/);
});

test('CLI-EVD-008: the plan says what is expired and what is kept', () => {
  const { dir, runId } = makeDataDir();
  const r = cli('plan', '--data-dir', dir, '--days', '30');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /expired  : 1/);
  assert.match(r.stdout, new RegExp(runId));
  // The plan removes nothing.
  assert.equal(fs.existsSync(path.join(dir, 'runs', runId, 'report.json')), true);
});

test('CLI-EVD-009: the cleaning refuses to run without --yes', () => {
  const { dir, runId } = makeDataDir();
  const r = cli('clean', '--data-dir', dir, '--days', '30');
  assert.equal(r.status, 2, 'a cleaning never happens by accident');
  assert.match(r.stderr, /without --yes/);
  assert.equal(fs.existsSync(path.join(dir, 'runs', runId, 'report.json')), true);
});

test('CLI-EVD-010: the cleaning removes the evidence and keeps the run record', () => {
  const { dir, runId, folder } = makeDataDir();
  const r = cli('clean', '--data-dir', dir, '--days', '30', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /run records kept: 1/);
  // The evidence is gone, the run's record is not.
  assert.equal(fs.existsSync(path.join(folder, 'report.json')), false);
  assert.equal(fs.existsSync(path.join(folder, 'events.jsonl')), true);
  assert.equal(fs.existsSync(path.join(folder, 'manifest.json')), true);
  // The state file still holds the run.
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].id, runId);
});

test('CLI-EVD-011: the cleaning removes the stored copies of the cleaned evidence (E8)', () => {
  const { dir, folder } = makeDataDir();
  // A stored copy of the evidence, as the bridge would have written it.
  const storeDir = path.join(dir, 'evidence-store', 'aa', 'aa');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'aa'.repeat(32)), 'the bytes');
  const r = cli('clean', '--data-dir', dir, '--days', '30', '--yes');
  assert.equal(r.status, 0, r.stderr);
  // The evidence may hold PII: the bytes must not survive the cleaning.
  assert.equal(fs.existsSync(path.join(storeDir, 'aa'.repeat(32))), false);
  assert.match(r.stdout, /store: removed \d+ unreferenced blob\(s\)/);
});

test('CLI-EVD-012: a dry run removes nothing, the store included (E5)', () => {
  const { dir, runId } = makeDataDir();
  const storeDir = path.join(dir, 'evidence-store', 'bb', 'bb');
  fs.mkdirSync(storeDir, { recursive: true });
  const blob = path.join(storeDir, 'bb'.repeat(32));
  fs.writeFileSync(blob, 'the bytes');
  const r = cli('clean', '--data-dir', dir, '--days', '30', '--dry-run', '--prune-store');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run: nothing was removed/);
  // Nothing at all was removed.
  assert.equal(fs.existsSync(blob), true, 'a dry run must not prune the store');
  assert.equal(fs.existsSync(path.join(dir, 'runs', runId, 'report.json')), true);
});

test('CLI-EVD-013: the verification reports a cleaned run as CLEANED, not as a tamper (E7)', () => {
  const { dir } = makeDataDir();
  cli('clean', '--data-dir', dir, '--days', '30', '--yes');
  const r = cli('verify', '--data-dir', dir);
  assert.equal(r.status, 0, `a cleaned run must not be reported as a tamper: ${r.stdout}`);
  assert.match(r.stdout, /cleaned by the retention policy/);
  assert.doesNotMatch(r.stdout, /does NOT match its manifest/);
});

test('CLI-EVD-014: the verification still reports a real tamper', () => {
  const { dir, folder } = makeDataDir();
  // The evidence is changed without any cleaning: that IS a tamper.
  fs.writeFileSync(path.join(folder, 'report.json'), '{"ok":false}');
  const r = cli('verify', '--data-dir', dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /does NOT match its manifest/);
  assert.match(r.stdout, /changed: report\.json/);
});

test('CLI-EVD-015: the journal says what the cleaning removed', () => {
  const { dir, runId } = makeDataDir();
  cli('clean', '--data-dir', dir, '--days', '30', '--yes');
  const r = cli('journal', '--data-dir', dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(runId));
  assert.match(r.stdout, /removed 1 file\(s\)/);
});

test('CLI-EVD-016: there is no journal in a data directory that was never cleaned', () => {
  const dir = tmp();
  const r = cli('journal', '--data-dir', dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no cleaning journal/);
});

test('CLI-EVD-017: a damaged journal line is reported', () => {
  const { dir } = makeDataDir();
  fs.writeFileSync(path.join(dir, 'evidence-retention-journal.jsonl'), 'not json\n');
  const r = cli('journal', '--data-dir', dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not be parsed/);
});

test('CLI-EVD-018: a run whose id is not a run id is skipped, not followed (E3)', () => {
  const dir = tmp();
  // A run id that climbs out of the runs directory. The state file is
  // data on the disk: it must not be able to make the cleaner delete
  // something outside its own run folder.
  const outside = path.join(dir, 'victim.json');
  fs.writeFileSync(outside, 'NOT THE CLEANER\'S BUSINESS');
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    schema: 1,
    projects: [],
    runs: [{ id: '../../victim.json', status: 'passed', createdAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-01T00:00:00.000Z' }],
  }));
  const r = cli('clean', '--data-dir', dir, '--days', '30', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(outside), true, 'the cleaning must not follow a run id out of the runs directory');
});

test('CLI-EVD-019: the verification reports a manifest that points outside the run folder', () => {
  const dir = tmp();
  const runId = 'run_1_0000000000000000000000ff';
  const folder = path.join(dir, 'runs', runId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
    version: 2,
    runId,
    artifacts: [{ file: '../../state.json', size: 2, sha256: 'ab'.repeat(32) }],
  }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    schema: 1,
    projects: [],
    runs: [{ id: runId, status: 'passed', createdAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-01T00:00:00.000Z' }],
  }));
  const r = cli('verify', '--data-dir', dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refused: \.\.\/\.\.\/state\.json/);
});
