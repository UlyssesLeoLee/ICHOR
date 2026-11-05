#!/usr/bin/env node
/**
 * ATS-201: records the migration evidence of a legacy state file.
 *
 * It shows the legacy input, the dry run, the real migration, the
 * idempotency check and the migrated output, and it verifies that a broken
 * input is reported instead of overwritten.
 *
 * Usage: node tools/ats201-probes/migration-evidence.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'tools', 'migrate_uids.mjs');
const WORK = path.join(os.tmpdir(), 'ats201-migration-evidence');

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'runs'), { recursive: true });

const legacyProjectId = 'proj_11111111-1111-1111-1111-111111111111';
const legacyRunId = 'run_22222222-2222-2222-2222-222222222222';
const root = path.join(WORK, 'app');
fs.mkdirSync(root, { recursive: true });

const legacyState = {
  schema: 1,
  projects: [{
    id: legacyProjectId, name: 'app', root,
    addedAt: '2026-01-01T00:00:00.000Z'
  }],
  runs: [{
    id: legacyRunId, projectId: legacyProjectId, projectName: 'app',
    file: 'tests/home.spec.ts', gitCommit: 'abc1234', status: 'passed',
    createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:09.000Z', eventSeq: 3, log: '', summary: null, artifacts: []
  }]
};

const statePath = path.join(WORK, 'state.json');
fs.writeFileSync(statePath, JSON.stringify(legacyState, null, 2));
fs.mkdirSync(path.join(WORK, 'runs', legacyRunId), { recursive: true });
fs.writeFileSync(path.join(WORK, 'runs', legacyRunId, 'manifest.json'), '{"version":1}');

console.log('# ATS-201 migration evidence');
console.log('');
console.log('## legacy state file (input)');
console.log('');
console.log('```json');
console.log(JSON.stringify(legacyState, null, 2));
console.log('```');
console.log('');

const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--state', statePath, ...args], { encoding: 'utf8' });
  console.log(`$ node tools/migrate_uids.mjs --state <state.json>${args.map((a) => ' ' + a).join('')}`);
  console.log(r.stdout.trim());
  if (r.status !== 0) console.log(r.stderr.trim());
  console.log('');
  return r;
};

console.log('## dry run');
console.log('');
const dry = run(['--dry-run']);
console.log('the state file is unchanged after the dry run:',
  fs.readFileSync(statePath, 'utf8') === JSON.stringify(legacyState, null, 2));
console.log('');

console.log('## real migration');
console.log('');
const real = run(['--backup']);
console.log('## idempotency');
console.log('');
const again = run([]);
console.log('the second run reports "already migrated":', /already migrated/.test(again.stdout));
console.log('');

console.log('## migrated state file');
console.log('');
console.log('```json');
console.log(fs.readFileSync(statePath, 'utf8'));
console.log('```');
console.log('');

console.log('## the run keeps pointing at its project');
console.log('');
const migrated = JSON.parse(fs.readFileSync(statePath, 'utf8'));
console.log(`project.id      = ${migrated.projects[0].id}`);
console.log(`run.projectId   = ${migrated.runs[0].projectId}`);
console.log(`run.projectUid  = ${migrated.runs[0].projectUid}`);
console.log(`run.seq         = ${migrated.runs[0].seq}`);
console.log(`runCounters     = ${JSON.stringify(migrated.runCounters)}`);
console.log(`the run is reachable through project.id: ${
  migrated.runs.filter((r) => r.projectId === migrated.projects[0].id).length === migrated.runs.length}`);
console.log('');

console.log('## broken input is reported, not overwritten');
console.log('');
const brokenPath = path.join(WORK, 'broken-state.json');
fs.writeFileSync(brokenPath, '{ not json');
const broken = spawnSync(process.execPath, [SCRIPT, '--state', brokenPath], { encoding: 'utf8' });
console.log(`$ node tools/migrate_uids.mjs --state <broken state.json>`);
console.log(broken.stderr.trim());
console.log(`exit code: ${broken.status}`);
console.log(`file content afterwards: ${fs.readFileSync(brokenPath, 'utf8')}`);
console.log('');

const ok = dry.status === 0 && real.status === 0 && again.status === 0 && broken.status === 1;
console.log(ok ? 'RESULT: ALL CHECKS PASSED' : 'RESULT: FAILED');
process.exit(ok ? 0 : 1);
