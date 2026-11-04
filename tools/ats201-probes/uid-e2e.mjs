#!/usr/bin/env node
/**
 * ATS-201 end-to-end evidence script.
 *
 * It exercises the UID scheme the way a user meets it:
 *
 *   1. a project is registered and its test catalog is listed;
 *   2. a test file is RENAMED and the title is REWRITTEN -- the UID of the
 *      logical test case must not change;
 *   3. a second test with the SAME title but a different body must get a
 *      different UID;
 *   4. a run is executed and its UID / seq / attempts are recorded;
 *   5. a LEGACY state file is migrated with tools/migrate_uids.mjs and the
 *      bridge keeps serving the migrated identifiers.
 *
 * The product source is not modified. The scenario project is a throwaway
 * fixture under the work directory.
 *
 * Usage: node tools/ats201-probes/uid-e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const WORK = process.env.ATS201_WORKDIR || path.join(os.tmpdir(), 'ats201-uid-e2e');
const PORT = Number(process.env.ATS201_PORT || 24517);
const BASE = `http://127.0.0.1:${PORT}`;

const log = (...a) => console.log(...a);
const ok = (label, cond, detail = '') => {
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
};

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

/* ------------------------------------------------------------------ */
/* fixture                                                            */
/* ------------------------------------------------------------------ */

const projectDir = path.join(WORK, 'fixture');
fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"ats201-fixture"}');
// The config declares `testDir: './tests'`, the shape of a normal Playwright
// project: the reported file is then relative to `<project>/tests`, while the
// registry stores it relative to the project root.
fs.writeFileSync(
  path.join(projectDir, 'playwright.config.ts'),
  "export default { testDir: './tests' };\n"
);

const SPEC = "test('login works', async ({ page }) => {\n  await page.goto('/login');\n  await expect(page.getByRole('button')).toBeVisible();\n});\n";
const SPEC2 = "test('login works', async ({ page }) => {\n  await page.goto('/register');\n  await expect(page.getByText('created')).toBeVisible();\n});\n";
fs.writeFileSync(path.join(projectDir, 'tests', 'login.spec.ts'), SPEC + SPEC2);

// A fake Playwright CLI: a test double, NOT Playwright itself. It exercises
// the runner transport, the report parsing and the attempt archive.
//
// The double models the SHAPE of the real JSON report -- the path basis, the
// line number and the per-retry results -- so that the bridge binds the
// attempts the same way it does with a real Playwright. The model is checked
// against the real Playwright by attempt-binding-real-pw.mjs.
fs.mkdirSync(path.join(projectDir, 'node_modules', '@playwright', 'test'), { recursive: true });
fs.copyFileSync(
  path.join(REPO_ROOT, 'tools', 'ats201-probes', 'fake-playwright-cli.cjs'),
  path.join(projectDir, 'node_modules', '@playwright', 'test', 'cli.js')
);

/* ------------------------------------------------------------------ */
/* bridge helpers                                                     */
/* ------------------------------------------------------------------ */

let token = '';
async function api(endpoint, method = 'GET', payload) {
  const r = await fetch(BASE + endpoint, {
    method,
    headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  return [r.status, await r.json()];
}
async function waitHealth() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
async function waitRun(id, wanted) {
  for (let i = 0; i < 120; i++) {
    const [, body] = await api(`/api/runs/${id}`);
    if (body.run.status === wanted) return body.run;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

const dataDir = path.join(WORK, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const cp = spawn(process.execPath, ['server/index.mjs'], {
  cwd: REPO_ROOT,
  env: { ...process.env, ATS_PORT: String(PORT), ATS_DATA_DIR: dataDir },
  stdio: 'ignore'
});

try {
  log('=== ATS-201 UID end-to-end ===');
  log(`repo root : ${REPO_ROOT}`);
  log(`work dir  : ${WORK}`);
  log('');

  if (!await waitHealth()) throw new Error('bridge did not boot');
  token = (await api('/api/session'))[1].token;

  /* --- 1. registration and catalog ---------------------------------- */
  log('--- 1. project registration and test catalog ---');
  const [regCode, regBody] = await api('/api/projects', 'POST', { path: projectDir });
  ok('POST /api/projects -> 201', regCode === 201, `status=${regCode}`);
  const projectUid = regBody.project.uid;
  ok('project UID matches proj_1_<24 hex>', /^proj_1_[0-9a-f]{24}$/.test(projectUid), projectUid);
  ok('project.id equals project.uid', regBody.project.id === projectUid);

  const [, cat1] = await api(`/api/projects/${projectUid}/tests`);
  ok('catalog lists 2 test cases', cat1.tests.length === 2, `count=${cat1.tests.length}`);
  ok('catalog reports uidVersion 1', cat1.uidVersion === 1);
  const [t1, t2] = cat1.tests;
  ok('duplicate titles get different UIDs', t1.uid !== t2.uid, `${t1.uid} vs ${t2.uid}`);
  ok('both UIDs are stable (uidStable=true)', t1.uidStable && t2.uidStable);
  log(`   test 1: ${t1.uid}  (${t1.uidSource})  ${t1.title}`);
  log(`   test 2: ${t2.uid}  (${t2.uidSource})  ${t2.title}`);

  /* --- 2. rename + retitle ------------------------------------------ */
  log('');
  log('--- 2. rename the file AND rewrite the title ---');
  fs.renameSync(
    path.join(projectDir, 'tests', 'login.spec.ts'),
    path.join(projectDir, 'tests', 'authentication.spec.ts')
  );
  let body = fs.readFileSync(path.join(projectDir, 'tests', 'authentication.spec.ts'), 'utf8');
  body = body.replaceAll("'login works'", "'sign-in flow succeeds'");
  fs.writeFileSync(path.join(projectDir, 'tests', 'authentication.spec.ts'), body);

  const [, cat2] = await api(`/api/projects/${projectUid}/tests`);
  const renamed = cat2.tests.find((t) => t.file === 'tests/authentication.spec.ts' && t.title === 'sign-in flow succeeds');
  ok('the renamed+retitled case is found', Boolean(renamed));
  ok('its UID did not change', renamed.uid === t1.uid, `${renamed.uid} vs ${t1.uid}`);
  ok('its UID source is the registry', renamed.uidSource === 'registry', renamed.uidSource);
  // Both cases were retitled (the rewrite hit every occurrence), so the
  // second one is looked up by position inside the file, not by title.
  const retitled = cat2.tests.filter((t) => t.file === 'tests/authentication.spec.ts');
  ok('both retitled cases are present', retitled.length === 2, `count=${retitled.length}`);
  ok('the two retitled cases keep distinct UIDs', retitled[0].uid !== retitled[1].uid,
    retitled.map((t) => t.uid).join(' vs '));
  ok('the set of UIDs is preserved across the rename',
    new Set(retitled.map((t) => t.uid)).size === 2 &&
    retitled.some((t) => t.uid === t1.uid) && retitled.some((t) => t.uid === t2.uid),
    `before={${t1.uid},${t2.uid}} after={${retitled.map((t) => t.uid).join(',')}}`);

  /* --- 3. run and attempts ------------------------------------------ */
  log('');
  log('--- 3. run, UID, seq and attempts ---');
  const [runCode, runBody] = await api(`/api/projects/${projectUid}/run`, 'POST', { file: 'tests/authentication.spec.ts' });
  ok('POST /run -> 202', runCode === 202, `status=${runCode}`);
  const runUid = runBody.run.uid;
  ok('run UID matches run_1_<24 hex>', /^run_1_[0-9a-f]{24}$/.test(runUid), runUid);
  ok('run.seq is 1', runBody.run.seq === 1, `seq=${runBody.run.seq}`);
  const finished = await waitRun(runUid, 'passed');
  ok('the run reaches a terminal state', Boolean(finished), finished && finished.status);
  const [, runDetail] = await api(`/api/runs/${runUid}`);
  ok('the run is reachable through its UID', runDetail.run.id === runUid);
  ok('the run carries attempts', Array.isArray(runDetail.run.attempts) && runDetail.run.attempts.length === 2,
    `attempts=${runDetail.run.attempts && runDetail.run.attempts.length}`);
  const attemptUids = (runDetail.run.attempts || []).map((a) => a.uid);
  ok('attempt UIDs match att_1_<24 hex>', attemptUids.every((u) => /^att_1_[0-9a-f]{24}$/.test(u)), attemptUids.join(','));
  ok('attempt UIDs are distinct', new Set(attemptUids).size === attemptUids.length);
  ok('attempts are bound to TestDefinition UIDs',
    (runDetail.run.attempts || []).every((a) => a.testUid && /^tc(_1_d)?_/.test(a.testUid) || /^tc-/.test(a.testUid || '')),
    (runDetail.run.attempts || []).map((a) => a.testUid).join(','));

  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', runUid, 'manifest.json'), 'utf8'));
  ok('the manifest records the attempts', Array.isArray(manifest.attempts) && manifest.attempts.length === 2);
  ok('the manifest records the project UID', manifest.projectUid === projectUid);

  /* --- 4. legacy state migration ------------------------------------ */
  log('');
  log('--- 4. migrate a legacy state file ---');
  const legacyDir = path.join(WORK, 'legacy');
  fs.mkdirSync(path.join(legacyDir, 'runs'), { recursive: true });
  const legacyProjectId = 'proj_11111111-1111-1111-1111-111111111111';
  const legacyRunId = 'run_22222222-2222-2222-2222-222222222222';
  const legacyState = {
    schema: 1,
    projects: [{ id: legacyProjectId, name: 'fixture', root: projectDir, addedAt: '2026-01-01T00:00:00.000Z' }],
    runs: [{
      id: legacyRunId, projectId: legacyProjectId, projectName: 'fixture',
      file: 'tests/login.spec.ts', gitCommit: 'abc1234', status: 'passed',
      createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:01.000Z',
      finishedAt: '2026-01-01T00:00:09.000Z', eventSeq: 3, log: '', summary: null, artifacts: []
    }]
  };
  fs.mkdirSync(path.join(legacyDir, 'runs', legacyRunId), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'runs', legacyRunId, 'manifest.json'), '{"version":1}');
  const legacyStatePath = path.join(legacyDir, 'state.json');
  fs.writeFileSync(legacyStatePath, JSON.stringify(legacyState, null, 2));

  const mig = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'migrate_uids.mjs'), '--state', legacyStatePath], { encoding: 'utf8' });
  log(mig.stdout.trim().split('\n').map((l) => '   ' + l).join('\n'));
  ok('the migration exits 0', mig.status === 0, mig.stderr.trim());
  const migrated = JSON.parse(fs.readFileSync(legacyStatePath, 'utf8'));
  ok('the project UID was rewritten', /^proj_1_[0-9a-f]{24}$/.test(migrated.projects[0].uid), migrated.projects[0].uid);
  ok('the legacy project id is kept as legacyId', migrated.projects[0].legacyId === legacyProjectId);
  ok('the run UID was rewritten', /^run_1_[0-9a-f]{24}$/.test(migrated.runs[0].uid), migrated.runs[0].uid);
  ok('the run folder was renamed on disk',
    fs.existsSync(path.join(legacyDir, 'runs', migrated.runs[0].uid)) &&
    !fs.existsSync(path.join(legacyDir, 'runs', legacyRunId)));
  const mig2 = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'migrate_uids.mjs'), '--state', legacyStatePath], { encoding: 'utf8' });
  ok('the migration is idempotent', /already migrated/.test(mig2.stdout), mig2.stdout.trim());

  /* --- 5. the bridge serves the migrated state ----------------------- */
  log('');
  log('--- 5. the bridge serves a migrated state file ---');
  const migratedBridge = spawn(process.execPath, ['server/index.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ATS_PORT: String(PORT + 1), ATS_DATA_DIR: legacyDir },
    stdio: 'ignore'
  });
  try {
    let up = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT + 1}/api/health`)).ok) { up = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    ok('the bridge boots on the migrated state', up);
    if (up) {
      const r2 = await fetch(`http://127.0.0.1:${PORT + 1}/api/session`);
      const t2token = (await r2.json()).token;
      const r3 = await fetch(`http://127.0.0.1:${PORT + 1}/api/runs`, { headers: { 'X-ATS-Token': t2token } });
      const runsBody = await r3.json();
      ok('the migrated run is listed', runsBody.runs.length === 1 && runsBody.runs[0].uid === migrated.runs[0].uid,
        runsBody.runs.map((x) => x.uid).join(','));
      const r4 = await fetch(`http://127.0.0.1:${PORT + 1}/api/runs/${migrated.runs[0].uid}`, { headers: { 'X-ATS-Token': t2token } });
      ok('the migrated run is reachable through its UID', r4.status === 200, `status=${r4.status}`);
    }
  } finally {
    migratedBridge.kill();
  }

  log('');
  log(process.exitCode ? 'RESULT: FAILED' : 'RESULT: ALL CHECKS PASSED');
} finally {
  cp.kill();
}
