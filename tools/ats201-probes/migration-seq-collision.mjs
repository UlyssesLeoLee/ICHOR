#!/usr/bin/env node
/**
 * ATS-201: after the migration, does the bridge compute a run sequence that
 * collides with an already migrated run?
 *
 * `tools/migrate_uids.mjs` rewrites `project.id` to the stable UID and adds
 * `run.projectUid`, but it leaves `run.projectId` at the legacy identifier and
 * does not carry over `runCounters`.
 *
 * The bridge looks the run history up by `run.projectId === project.id` and
 * derives the next sequence from that history plus `runCounters`. After the
 * migration the lookup finds nothing, so the next run gets `seq = 1` again --
 * the sequence a migrated run already uses. Two different runs then share the
 * same `run_1_<24 hex>` identifier.
 *
 * The product source is not modified. The scenario is a throwaway state file
 * under the work directory.
 *
 * Usage: node tools/ats201-probes/migration-seq-collision.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { planMigration } from '../../tools/migrate_uids.mjs';
import { nextRunSeq, runUidFor } from '../../server/uid.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const WORK = process.env.ATS201_MIG_WORKDIR || path.join(os.tmpdir(), 'ats201-mig-seq');
const DATA = path.join(WORK, 'data');
const PORT = Number(process.env.ATS201_MIG_PORT || 24711);

const log = (...a) => console.log(...a);
const ok = (label, cond, detail = '') => {
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
};

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const legacyProjectId = 'proj_11111111-1111-1111-1111-111111111111';
const legacyRunId = 'run_22222222-2222-2222-2222-222222222222';
const root = path.join(WORK, 'project');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), '{}');

const legacyState = {
  schema: 1,
  projects: [{ id: legacyProjectId, name: 'fixture', root, addedAt: '2026-01-01T00:00:00.000Z' }],
  runs: [{
    id: legacyRunId, projectId: legacyProjectId, projectName: 'fixture',
    file: 'tests/home.spec.ts', gitCommit: 'abc1234', status: 'passed',
    createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:09.000Z', eventSeq: 3, log: '', summary: null, artifacts: []
  }]
};
const statePath = path.join(DATA, 'state.json');
fs.writeFileSync(statePath, JSON.stringify(legacyState, null, 2));

log('--- 1. the migration ---');
const mig = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'migrate_uids.mjs'), '--state', statePath], { encoding: 'utf8' });
log(mig.stdout.trim().split('\n').map((l) => '   ' + l).join('\n'));
ok('the migration exits 0', mig.status === 0, mig.stderr.trim());

const migrated = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const project = migrated.projects[0];
const migratedRun = migrated.runs[0];
log(`   project.id     = ${project.id}`);
log(`   run.projectId  = ${migratedRun.projectId}`);
log(`   run.projectUid = ${migratedRun.projectUid}`);
log(`   run.seq        = ${migratedRun.seq}`);
log(`   run.id         = ${migratedRun.id}`);

log('');
log('--- 2. the sequence the bridge computes for the next run ---');
// This is the code path of server/index.mjs: the history is looked up by
// `run.projectId === project.id`, the counter comes from `runCounters`.
const history = migrated.runs.filter((x) => x.projectId === project.id);
const counter = migrated.runCounters?.[project.id] ?? 0;
const seq = nextRunSeq(history, counter);
const nextUid = runUidFor({ projectUid: project.uid, gitCommit: 'abc1234', file: 'tests/home.spec.ts', seq });
log(`   history found by project.id = ${history.length}`);
log(`   runCounters[project.id]     = ${counter}`);
log(`   next seq                    = ${seq}`);
log(`   next run uid                = ${nextUid}`);
log(`   migrated run uid            = ${migratedRun.id}`);

ok('the migrated run is still reachable through project.id', history.length === 1,
  `history=${history.length}`);
ok('the next run does not reuse the sequence of a migrated run', seq !== migratedRun.seq,
  `next seq=${seq}, migrated seq=${migratedRun.seq}`);
ok('the next run does not collide with a migrated run UID', nextUid !== migratedRun.id,
  `${nextUid} vs ${migratedRun.id}`);

log('');
log('--- 3. the bridge serves the migrated state ---');
const cp = spawn(process.execPath, ['server/index.mjs'], {
  cwd: REPO_ROOT, env: { ...process.env, ATS_PORT: String(PORT), ATS_DATA_DIR: DATA }, stdio: 'ignore'
});
const api = async (endpoint, method = 'GET', payload) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${endpoint}`, {
    method,
    headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  return [r.status, await r.json()];
};
let token = '';
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  token = (await api('/api/session'))[1].token;
  const [, runsBody] = await api('/api/runs');
  const listed = runsBody.runs.map((r) => r.id);
  log(`   runs listed by the bridge = ${listed.join(', ')}`);
  ok('the migrated run is listed under its new UID', listed.includes(migratedRun.id));
} finally {
  cp.kill();
}

log('');
log(process.exitCode ? 'RESULT: FAILED' : 'RESULT: ALL CHECKS PASSED');
