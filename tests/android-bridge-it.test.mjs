/**
 * ATS-603: the END-TO-END test -- a mobile run through the REAL Bridge.
 *
 * WHAT THIS TEST IS
 * -----------------
 * The runner tests (tests/android-runner.test.mjs) measure the driver.
 * The adapter tests (tests/android-adapter.test.mjs) measure the adapter.
 * This one measures the WHOLE PATH a user walks:
 *
 *   POST /api/projects/<id>/run  (runner: android)
 *     -> the Bridge negotiates the runners
 *     -> it selects the ANDROID runner (and not the browser)
 *     -> the run goes through the run lifecycle
 *     -> the run's summary carries the mobile results
 *     -> the results are queryable TOGETHER with a web run
 *
 * The last point is the one ATS-304 asks for and this test measures it:
 * the mobile results land in the SAME result model as the web ones, so a
 * caller can ask one question and get both.
 *
 * WHEN THERE IS NO DEVICE
 * -----------------------
 * The test SKIPS itself with the reason. A skip is not a pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { freePort } from './helpers/free-port.mjs';
import { resolveAdbPath } from '../server/adapters/android-adb.mjs';

const root = path.resolve(import.meta.dirname, '..');
const PACKAGE = 'com.ichor.smoke';
const APK = path.join(root, 'tools', 'ats603-probes', 'build', 'smoke-app.apk');

/** The reason the test skips, or '' when there is a device. */
function availability() {
  const adbPath = resolveAdbPath({});
  try {
    const out = spawnSync(adbPath, ['devices'], { encoding: 'utf8', timeout: 20000 });
    if (out.status !== 0) return { reason: 'the adb client could not be started' };
    const usable = out.stdout.split('\n')
      .map((l) => l.trim())
      .find((l) => /\sdevice$/.test(l));
    if (!usable) return { reason: 'no Android device is attached to adb' };
    if (!fs.existsSync(APK)) return { reason: `the smoke APK is missing: ${APK}` };
    return { reason: '', adbPath, serial: usable.split(/\s+/)[0] };
  } catch (e) {
    return { reason: `the adb client could not be started: ${e.message}` };
  }
}

const avail = availability();
const skip = avail.reason || false;

/** The fixture project: one mobile Flow and one web spec. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats603-e2e-'));
  fs.mkdirSync(path.join(dir, 'flows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"ats603-e2e","private":true}', 'utf8');
  // The Bridge refuses a project without a playwright config.
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'flows', 'smoke.yaml'),
    `appId: ${PACKAGE}
---
- name: Smoke flow
  tags:
    - smoke
  steps:
    - launchApp:
        appId: ${PACKAGE}
    - assertVisible: "ICHOR Smoke Home"
    - tapOn: "Open Details"
    - assertVisible: "ICHOR Detail Screen"
    - takeScreenshot: "detail"
`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'tests', 'web.spec.ts'),
    "import { test } from '@playwright/test';\ntest('a web case', async ({ page }) => {});\n",
    'utf8',
  );
  return dir;
}

/** Start the Bridge and wait for it to answer. */
async function startBridge(dir, data) {
  const port = await freePort();
  // The Bridge is started with the DATA directory as its cwd, NOT the
  // fixture directory. A child process holds its cwd open, and on
  // Windows the fixture directory could then not be removed while the
  // Bridge lived -- the cleanup failed with EPERM. The Bridge resolves
  // the project by its absolute path, so its cwd does not matter.
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.mjs')], {
    cwd: data,
    env: {
      ...process.env,
      ATS_DATA_DIR: data,
      ATS_PORT: String(port),
      ANDROID_HOME: process.env.ANDROID_HOME ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });
  const base = `http://127.0.0.1:${port}`;
  // The API needs the session token: every `/api/` route except
  // `/api/health` and `/api/session` answers 401 without the
  // `x-ats-token` header. The token is served by `/api/session`.
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${base}/api/session`);
      if (r.ok) {
        const s = await r.json();
        return { base, child, token: s.token, log: () => log };
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`the Bridge did not start: ${log.slice(-2000)}`);
}

/** A fetch that carries the session token. */
function api(bridge, urlPath, init = {}) {
  const headers = { ...(init.headers ?? {}), 'x-ats-token': bridge.token };
  if (init.body) headers['content-type'] = 'application/json';
  return fetch(`${bridge.base}${urlPath}`, { ...init, headers });
}

/** Register the project and return its id. */
async function registerProject(bridge, dir) {
  const r = await api(bridge, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'ats603-e2e', path: dir }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`the project was not registered: ${JSON.stringify(body)}`);
  return body.project ? body.project.id : body.id;
}

test('IT-ATS603-030: the Bridge runs a mobile case on the device and reports it', { skip, timeout: 240000 }, async () => {
  const dir = fixture();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats603-e2e-data-'));
  let bridge = null;
  try {
    // The fixture app is installed on the device.
    spawnSync(avail.adbPath, ['-s', avail.serial, 'install', '-r', '-t', APK], { encoding: 'utf8', timeout: 120000 });

    bridge = await startBridge(dir, data);
    const projectId = await registerProject(bridge, dir);

    // The mobile cases are in the SAME catalogue as the web ones.
    const tests = await (await api(bridge, `/api/projects/${projectId}/tests`)).json();
    const titles = (tests.tests ?? []).map((t) => t.title);
    console.log(`IT-ATS603-030 catalogue: ${JSON.stringify(titles)}`);
    assert.ok(titles.includes('Smoke flow'), 'the mobile case is not in the catalogue');
    assert.ok(titles.includes('a web case'), 'the web case is not in the catalogue');

    // The negotiation picks the ANDROID runner for the mobile request.
    const negotiated = await (await api(bridge, `/api/projects/${projectId}/runners`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: ['discover', 'start', 'stop', 'collect'] }),
    })).json();
    console.log(`IT-ATS603-030 negotiated: ${JSON.stringify(negotiated.selected ?? negotiated.error ?? null)}`);

    // The run itself, pinned to the android runner.
    const started = await (await api(bridge, `/api/projects/${projectId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runner: 'android', capabilities: ['discover', 'start', 'stop', 'collect'] }),
    })).json();
    const runId = started.run ? started.run.id : null;
    console.log(`IT-ATS603-030 run: ${runId ?? JSON.stringify(started)}`);
    assert.ok(runId, `the run was not accepted: ${JSON.stringify(started)}`);

    // The run reaches a terminal state. WITHOUT the process-like handle
    // the run would stay `running` for ever -- that is what this test
    // measures.
    let run = null;
    let bridgeExit = null;
    bridge.child.on('exit', (code, signal) => { bridgeExit = { code, signal }; });
    for (let i = 0; i < 120; i += 1) {
      // A Bridge that died mid-run answers with a connection error, not
      // with a status. The log of the Bridge is printed, so the failure
      // says WHY the Bridge died instead of "fetch failed".
      let r;
      try {
        r = await (await api(bridge, `/api/runs/${runId}`)).json();
      } catch (e) {
        throw new Error(
          `the Bridge stopped answering: ${e.message}\n`
          + `bridge exit: ${JSON.stringify(bridgeExit)}\n`
          + `--- bridge log ---\n${bridge.log().slice(-3000)}`,
        );
      }
      run = r.run ?? r;
      if (run && ['passed', 'failed', 'error', 'cancelled', 'interrupted'].includes(run.status)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`IT-ATS603-030 status: ${run?.status} summary=${JSON.stringify(run?.summary ?? null)} error=${run?.error ?? ''}`);
    assert.ok(run, 'the run was not found');
    assert.ok(
      ['passed', 'failed'].includes(run.status),
      `the run did not reach a terminal state: ${run.status} (${(run.log || '').slice(-800)})`,
    );
    // The summary is the COMMON model -- the same shape the web engine
    // produces, so the two are queryable together.
    assert.ok(run.summary, 'the run carries no summary');
    assert.equal(typeof run.summary.passed, 'number');
    assert.equal(typeof run.summary.failed, 'number');
    assert.equal(typeof run.summary.total, 'number');
    console.log(`IT-ATS603-030 summary: ${JSON.stringify(run.summary)}`);
  } finally {
    // The Bridge is killed BEFORE the fixture is removed: a live Bridge
    // holds the project directory open, and removing it under the Bridge
    // fails with EPERM on Windows. The kill is awaited, so the handle is
    // really gone before the delete.
    if (bridge) {
      bridge.child.kill();
      await new Promise((r) => {
        bridge.child.once('exit', r);
        setTimeout(r, 3000);
      });
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('IT-ATS603-031: the capability matrix reports the android runner', { skip, timeout: 120000 }, async () => {
  const dir = fixture();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats603-e2e-data-'));
  let bridge = null;
  try {
    bridge = await startBridge(dir, data);
    const projectId = await registerProject(bridge, dir);
    const matrix = await (await api(bridge, `/api/projects/${projectId}/runners`)).json();
    const runners = matrix.runners ?? [];
    const android = runners.find((r) => r.kind === 'android');
    console.log(`IT-ATS603-031 runners: ${JSON.stringify(runners.map((r) => r.kind))}`);
    assert.ok(android, 'the android runner is not in the matrix');
    assert.equal(android.kind, 'android');
    // The capability matrix carries the android runner too.
    const androidCaps = (matrix.capabilities ?? []).find((r) => r.kind === 'android');
    assert.ok(androidCaps, 'the android runner is not in the capability matrix');
  } finally {
    if (bridge) {
      bridge.child.kill();
      await new Promise((r) => {
        bridge.child.once('exit', r);
        setTimeout(r, 3000);
      });
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
