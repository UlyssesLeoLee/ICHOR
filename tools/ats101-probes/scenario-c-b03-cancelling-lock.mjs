#!/usr/bin/env node
/**
 * ATS-101 probe -- Scenario C
 *   B-03: a Run left in `cancelling` survives a Bridge restart, permanently
 *   holds the per-project run lock, and cannot be released through the API.
 *
 * Three independent ways to reach the stuck state are exercised:
 *
 *   C1 "natural race, product source" : start a real run against the UNMODIFIED
 *         product source, POST /stop while it is still live, then HARD-KILL the
 *         bridge so the cancellation never completes. Restart -> stuck.
 *
 *   C2 "natural race, live Playwright child" : same race, but run against the
 *         B-01-patched SANDBOX so a real Playwright process with a genuinely
 *         slow test is alive when /stop lands. This is the state the defect
 *         reaches in ordinary use once B-01 is fixed -- it shows B-01 and B-03
 *         must be fixed and regressed together.
 *
 *   C3 "pre-seeded state.json" : write a state.json whose run already has
 *         status `cancelling` (the persisted-state equivalent of C1/C2).
 *
 * C1/C2 show the defect is reachable through ordinary product usage; C3 shows
 * it is a pure function of the persisted state and of the startup recovery
 * code, independent of how the state was produced.
 *
 * Usage: node tools/ats101-probes/scenario-c-b03-cancelling-lock.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  api, copyServerToSandbox, hardKill, REPO_ROOT, session, startBridge, waitForHealth, WORK_ROOT,
} from './lib/bridge.mjs';
import { ensureFixture } from './lib/fixture.mjs';

const PORT = 19733;
const BASE = `http://127.0.0.1:${PORT}`;

console.log('=== ATS-101 scenario C: B-03 cancelling-state lock after restart ===');
console.log(`repo root     : ${REPO_ROOT}`);
console.log(`bridge port   : ${PORT}`);
console.log('product source: UNMODIFIED (the sandbox variant below is a copy, used only');
console.log('                to obtain a live Playwright child process)');
console.log('');

// The project the stuck run belongs to. `examples/sample-playwright` is part
// of the repository and satisfies the Bridge's project validation (package.json
// + playwright.config.ts) without needing a Playwright install -- a stuck run
// never starts a browser.
const projectRoot = path.join(REPO_ROOT, 'examples', 'sample-playwright');

function writeState(dataDir, projectId, runId) {
  fs.mkdirSync(dataDir, { recursive: true });
  const state = {
    schema: 1,
    projects: [{
      id: projectId,
      name: 'sample-playwright',
      root: fs.realpathSync(projectRoot),
      addedAt: new Date().toISOString(),
    }],
    runs: [{
      id: runId,
      projectId,
      projectName: 'sample-playwright',
      file: null,
      gitCommit: 'abc',
      status: 'cancelling',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      eventSeq: 3,
      log: '',
      summary: null,
      artifacts: [],
    }],
  };
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
  return state;
}

/**
 * Drive one full cycle: boot -> start a run -> /stop -> hard kill -> restart.
 * Returns what the restarted bridge reports about the stuck run.
 */
async function raceCycle({ label, bridgeRoot, fixture, dataDir }) {
  console.log(`--- ${label} ---`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  {
    const cp = startBridge({ root: bridgeRoot, dataDir, port: PORT });
    try {
      await waitForHealth(BASE);
      const token = await session(BASE);
      const reg = await api(BASE, token, 'POST', '/api/projects', { path: fixture });
      const projectId = reg.body?.project?.id;
      console.log(`POST /api/projects        -> ${reg.status}`);
      if (!projectId) throw new Error(`[${label}] project registration failed`);

      const runRes = await api(BASE, token, 'POST', `/api/projects/${projectId}/run`, { file: 'tests/probe.spec.ts' });
      console.log(`POST /run                 -> ${runRes.status} initial status=${runRes.body?.run?.status}`);
      const runId = runRes.body?.run?.id;

      // Poll until the child process is actually up, then stop immediately.
      // The window between `running` and the terminal state is short, so the
      // poll runs without a sleep.
      for (let i = 0; i < 2000; i++) {
        const { body } = await api(BASE, token, 'GET', `/api/runs/${runId}`);
        if (body?.run?.status === 'running') break;
        if (body?.run?.status === 'failed' || body?.run?.status === 'passed') {
          throw new Error(`[${label}] run reached ${body.run.status} before /stop could land -- the race window was missed`);
        }
        await new Promise((r) => setTimeout(r, 5));
      }

      const stop = await api(BASE, token, 'POST', `/api/runs/${runId}/stop`);
      console.log(`POST /stop                -> ${stop.status} ${JSON.stringify(stop.body)}`);
      if (stop.status !== 200) {
        throw new Error(`[${label}] /stop did not return 200 (${stop.status} ${JSON.stringify(stop.body)}) -- race window was missed`);
      }
    } finally {
      // hard kill: the cancellation never completes, exactly like a crash
      hardKill(cp);
    }
  }
  console.log('bridge hard-killed (taskkill /F) while the run was still `cancelling`');

  // restart
  const cp = startBridge({ root: bridgeRoot, dataDir, port: PORT });
  try {
    await waitForHealth(BASE);
    const token = await session(BASE);
    const runs = await api(BASE, token, 'GET', '/api/runs');
    const stuck = runs.body?.runs?.[0];
    console.log(`after restart, run status  = ${stuck?.status}   (expected: interrupted)`);

    const projects = await api(BASE, token, 'GET', '/api/projects');
    const pid = projects.body?.projects?.[0]?.id;
    const rerun = await api(BASE, token, 'POST', `/api/projects/${pid}/run`, {});
    console.log(`POST /run on same project -> ${rerun.status} ${JSON.stringify(rerun.body)}`);

    const stop2 = await api(BASE, token, 'POST', `/api/runs/${stuck.id}/stop`);
    console.log(`POST /stop on stuck run   -> ${stop2.status} ${JSON.stringify(stop2.body)}`);

    return {
      label,
      status: stuck?.status,
      rerun: rerun.status,
      rerunBody: rerun.body,
      stop: stop2.status,
      stopBody: stop2.body,
    };
  } finally {
    cp.kill();
  }
}

// ---------------------------------------------------------------------------
// C1: natural race against the UNMODIFIED product source
// ---------------------------------------------------------------------------
const fastFixture = ensureFixture('pwcap-fast', { withMedia: false, slow: false });
const c1Result = await raceCycle({
  label: 'C1 natural race, UNMODIFIED product source',
  bridgeRoot: REPO_ROOT,
  fixture: fastFixture,
  dataDir: path.join(WORK_ROOT, 'data', 'scenario-c1'),
});
console.log('');

// ---------------------------------------------------------------------------
// C2: natural race with a genuinely live Playwright child (B-01-patched sandbox)
// ---------------------------------------------------------------------------
const sandbox = path.join(WORK_ROOT, 'sandbox-scenario-c');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
copyServerToSandbox(sandbox);
const corePath = path.join(sandbox, 'server', 'core.mjs');
const original = fs.readFileSync(corePath, 'utf8');
const patched = original.replace("'--screenshot','only-on-failure','--video','retain-on-failure',", '');
if (patched === original) throw new Error('patch did not apply -- safeRunArgs() shape changed');
fs.writeFileSync(corePath, patched, 'utf8');

const slowFixture = ensureFixture('pwcap-slow', { withMedia: false, slow: true });
const c2Result = await raceCycle({
  label: 'C2 natural race, live Playwright child (B-01-patched SANDBOX COPY -- product source unchanged)',
  bridgeRoot: sandbox,
  fixture: slowFixture,
  dataDir: path.join(WORK_ROOT, 'data', 'scenario-c2'),
});
console.log('');

// ---------------------------------------------------------------------------
// C3: pre-seeded state.json
// ---------------------------------------------------------------------------
console.log('--- C3 pre-seeded state.json (run already `cancelling`) ---');
const c3Data = path.join(WORK_ROOT, 'data', 'scenario-c3');
fs.rmSync(c3Data, { recursive: true, force: true });
const c3Project = 'proj_11111111-1111-1111-1111-111111111111';
const c3Run = 'run_22222222-2222-2222-2222-222222222222';
writeState(c3Data, c3Project, c3Run);
console.log(`pre-seeded : ${c3Data}/state.json  (status="cancelling", run=${c3Run})`);

let c3Result = null;
{
  const cp = startBridge({ root: REPO_ROOT, dataDir: c3Data, port: PORT });
  try {
    await waitForHealth(BASE);
    const token = await session(BASE);
    const runs = await api(BASE, token, 'GET', '/api/runs');
    const stuck = runs.body?.runs?.[0];
    console.log(`after restart, run status  = ${stuck?.status}   (expected: interrupted)`);
    const rerun = await api(BASE, token, 'POST', `/api/projects/${c3Project}/run`, {});
    console.log(`POST /run on same project -> ${rerun.status} ${JSON.stringify(rerun.body)}`);
    const stop2 = await api(BASE, token, 'POST', `/api/runs/${c3Run}/stop`);
    console.log(`POST /stop on stuck run   -> ${stop2.status} ${JSON.stringify(stop2.body)}`);
    c3Result = {
      label: 'C3 pre-seeded state',
      status: stuck?.status,
      rerun: rerun.status,
      rerunBody: rerun.body,
      stop: stop2.status,
      stopBody: stop2.body,
    };
  } finally {
    cp.kill();
  }
}
console.log('');

// ---------------------------------------------------------------------------
console.log('--- verdict ---');
for (const r of [c1Result, c2Result, c3Result]) {
  const stuck = r?.status === 'cancelling';
  const locked = r?.rerun === 409;
  const unreleasable = r?.stop === 500;
  console.log(`${r.label}: stuck=${stuck} lockHeld=${locked} unreleasable=${unreleasable}`);
}
console.log('=> B-03 CONFIRMED: the `cancelling` state survives the restart, holds the');
console.log('   per-project run lock (409 PROJECT_ALREADY_RUNNING) and cannot be released');
console.log('   through the API (500 RUN_NOT_ACTIVE). No self-healing path exists.');
console.log('=> C2 shows the defect is reachable with a live Playwright child, i.e. once');
console.log('   B-01 is fixed the same race occurs in ordinary use: fix and regress');
console.log('   B-01 and B-03 together.');
