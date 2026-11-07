#!/usr/bin/env node
/**
 * ATS-206 -- the CLI round trip.
 *
 * The probe runs the migration CLI over a real data directory, through the
 * whole life cycle an operator goes through:
 *
 *   plan      -> reports, writes nothing
 *   apply     -> migrates, keeps a backup, imports the mirror
 *   verify    -> the mirror holds the same data as the state
 *   rollback  -> the original state is back, byte for byte
 *
 * The counts are printed BEFORE and AFTER, because "the counts are the same"
 * is the acceptance criterion, and a number in a log is the evidence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'tools', 'migrate_state.mjs');
const LEGACY = 'proj_11111111-1111-1111-1111-111111111111';
const LEGACY_RUN = 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats206-cli-'));
const statePath = path.join(dataDir, 'state.json');

// The state is a GENUINE v0.1 state: the v0.1 bridge wrote exactly three
// keys -- schema, projects, runs -- and the identifiers are the uuid form.
// There is no registry, no trust map and no attempt list in v0.1: those
// came later (ATS-201 / ATS-202). A fixture that carries them exercises
// code paths that a real v0.1 installation never reaches, and it hides the
// defects that a real one does.
const legacy = {
  schema: 1,
  projects: [{
    id: LEGACY,
    name: 'app',
    root: path.join(dataDir, 'app'),
    addedAt: '2026-01-01T00:00:00.000Z',
  }],
  runs: [
    {
      id: LEGACY_RUN,
      projectId: LEGACY,
      projectName: 'app',
      file: 'tests/a.spec.ts',
      gitCommit: 'abc1234',
      status: 'passed',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'run_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      projectId: LEGACY,
      projectName: 'app',
      file: 'tests/b.spec.ts',
      gitCommit: 'abc1234',
      status: 'failed',
      createdAt: '2026-01-02T00:00:00.000Z',
    },
  ],
};

const original = JSON.stringify(legacy, null, 2);
fs.writeFileSync(statePath, original);

// The run folder of the first run, named after the legacy identifier.
fs.mkdirSync(path.join(dataDir, 'runs', LEGACY_RUN), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'runs', LEGACY_RUN, 'manifest.json'), '{}');

function cli(...args) {
  const res = spawnSync(process.execPath, [CLI, ...args, '--data-dir', dataDir], { encoding: 'utf8' });
  console.log(`$ node tools/migrate_state.mjs ${args.join(' ')} --data-dir <dataDir>`);
  if (res.stdout.trim()) console.log(res.stdout.trimEnd());
  if (res.stderr.trim()) console.log('[stderr] ' + res.stderr.trimEnd());
  console.log(`[exit code] ${res.status}`);
  console.log('');
  return res;
}

function counts(state) {
  const registry = Object.values(state.uidRegistry?.projects ?? {})
    .reduce((n, p) => n + (p.entries?.length ?? 0), 0);
  return {
    projects: state.projects.length,
    runs: state.runs.length,
    attempts: state.runs.reduce((n, r) => n + (r.attempts?.length ?? 0), 0),
    artifacts: state.runs.reduce((n, r) => n + (r.artifacts?.length ?? 0), 0),
    registryEntries: registry,
  };
}

console.log('=== the ATS-206 CLI round trip ===');
console.log('data dir :', dataDir);
console.log('');

const before = counts(legacy);
console.log('the counts BEFORE the migration:');
console.log('  ', JSON.stringify(before));
console.log('');

console.log('--- 1. plan: reports, writes nothing ---');
const plan = cli('plan');
const afterPlan = fs.readFileSync(statePath, 'utf8');
console.log('the state file is byte-identical after plan:', afterPlan === original);
console.log('');

console.log('--- 2. apply: migrates, backs up, imports the mirror ---');
const apply = cli('apply', '--import-db');
const migrated = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const after = counts(migrated);
console.log('the counts AFTER the migration:');
console.log('  ', JSON.stringify(after));
console.log('the counts are equal        :', JSON.stringify(before) === JSON.stringify(after));
console.log('the backup is the original  :', fs.readFileSync(`${statePath}.bak`, 'utf8') === original);
console.log('');

console.log('--- 3. verify: the mirror holds the same data ---');
cli('verify');
console.log('');

console.log('--- 4. rollback: the original state is back ---');
cli('rollback');
const restored = fs.readFileSync(statePath, 'utf8');
console.log('the state file is byte-identical to the original:', restored === original);
console.log('the run folder is back under its old name        :',
  fs.existsSync(path.join(dataDir, 'runs', LEGACY_RUN, 'manifest.json')));
console.log('');

const ok = plan.status === 0 && apply.status === 0 && restored === original;
console.log('VERDICT:', ok ? 'the CLI round trip passed' : 'the CLI round trip FAILED');
fs.rmSync(dataDir, { recursive: true, force: true });
