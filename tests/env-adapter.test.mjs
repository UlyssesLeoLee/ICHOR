/**
 * ATS-212 -- the environment profiles: the adapter integration test.
 *
 * WHAT IS ASSERTED HERE
 * ---------------------
 * The runner's environment is SEALED, measured on the child process
 * itself rather than on the function that builds it.
 *
 * A fake Playwright CLI (tools/ats212-probes/fake-playwright-cli.cjs) is
 * installed into a fixture project, and it writes down the environment it
 * was handed. The assertions are then about THAT file:
 *
 *   1. The child receives the profile's variables.
 *   2. The child does NOT receive the host's environment -- an operator's
 *      secret in the shell does not reach the code under test, so it
 *      cannot end up in a report that is archived as evidence.
 *   3. The child still receives the platform variables it needs to run.
 *   4. The adapter's own output variables win over the profile's.
 *   5. A run with NO profile is still sealed: the child gets the platform
 *      base keys and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPlaywrightAdapter } from '../server/adapters/playwright.mjs';
import { listTests } from '../server/discovery/playwright-list.mjs';
import { buildRunnerEnv } from '../server/env/profiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_CLI = path.join(root, 'tools', 'ats212-probes', 'fake-playwright-cli.cjs');

/**
 * A fixture project with the fake Playwright CLI installed where the
 * adapter resolves it: `node_modules/@playwright/test/cli.js`.
 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats212-proj-'));
  fs.mkdirSync(path.join(dir, 'node_modules', '@playwright', 'test'), { recursive: true });
  fs.copyFileSync(FAKE_CLI, path.join(dir, 'node_modules', '@playwright', 'test', 'cli.js'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }));
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), 'export default { testDir: "." };');
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'login.spec.ts'), "test('works', async () => {});\n");
  return dir;
}

/**
 * Runs the adapter and returns the environment the CHILD PROCESS saw.
 */
async function environmentOfChild(project, outputDir, extra = {}) {
  const capture = path.join(outputDir, 'captured-env.json');
  const adapter = createPlaywrightAdapter();
  const handle = adapter.start({
    project: { root: project },
    run: { uid: 'run_1_1' },
    file: null,
    outputDir,
    env: buildRunnerEnv(
      { variables: { BASE_URL: 'https://staging.example', TENANT: 'acme' } },
      { baseEnv: process.env, extra: { ATS_ENV_CAPTURE: capture, ...extra } }
    ),
  });
  await new Promise((resolve, reject) => {
    handle.child.on('close', resolve);
    handle.child.on('error', reject);
  });
  return JSON.parse(fs.readFileSync(capture, 'utf8'));
}

test('IT-ENV-ADP-001: the child receives the profile variables and NOT the host environment', async () => {
  const project = fixture();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats212-out-'));
  // The host holds something that looks like a credential. Before ATS-212
  // the adapter spread the host environment in, so this reached the code
  // under test -- and from there into the report that is archived.
  const HOST_SECRET = 'the-host-secret-value';
  process.env.HOST_SECRET_MARKER = HOST_SECRET;
  try {
    const captured = await environmentOfChild(project, outputDir);
    // The profile's variables are there.
    assert.equal(captured.BASE_URL, 'https://staging.example');
    assert.equal(captured.TENANT, 'acme');
    // The host's secret is NOT.
    assert.equal(captured.HOST_SECRET_MARKER, undefined, 'the host secret reached the runner');
    // And neither does the host's own variable that is not a credential.
    assert.equal(captured.__unlikely_host_var__, undefined);
    // The platform keys the child needs are there.
    assert.ok(captured.PATH, 'the child has no PATH');
  } finally {
    delete process.env.HOST_SECRET_MARKER;
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('IT-ENV-ADP-002: the adapter output variables win over the profile', async () => {
  const project = fixture();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats212-out-'));
  try {
    const adapter = createPlaywrightAdapter();
    const capture = path.join(outputDir, 'captured-env.json');
    const handle = adapter.start({
      project: { root: project },
      run: { uid: 'run_1_1' },
      file: null,
      outputDir,
      env: buildRunnerEnv(
        { variables: { PLAYWRIGHT_JSON_OUTPUT_FILE: '/tmp/from-the-profile' } },
        { baseEnv: process.env, extra: { ATS_ENV_CAPTURE: capture } }
      ),
    });
    await new Promise((resolve, reject) => {
      handle.child.on('close', resolve);
      handle.child.on('error', reject);
    });
    const captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
    // The engine's contract is that the report goes where the adapter says.
    assert.notEqual(captured.PLAYWRIGHT_JSON_OUTPUT_FILE, '/tmp/from-the-profile');
    assert.ok(captured.PLAYWRIGHT_JSON_OUTPUT_FILE.includes(outputDir));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('IT-ENV-ADP-003: a run WITHOUT a profile is still sealed', async () => {
  const project = fixture();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats212-out-'));
  process.env.HOST_SECRET_MARKER = 'the-host-secret-value';
  try {
    const adapter = createPlaywrightAdapter();
    const capture = path.join(outputDir, 'captured-env.json');
    const handle = adapter.start({
      project: { root: project },
      run: { uid: 'run_1_1' },
      file: null,
      outputDir,
      // No profile at all: the environment is still sealed.
      env: buildRunnerEnv(null, { baseEnv: process.env, extra: { ATS_ENV_CAPTURE: capture } }),
    });
    await new Promise((resolve, reject) => {
      handle.child.on('close', resolve);
      handle.child.on('error', reject);
    });
    const captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.equal(captured.HOST_SECRET_MARKER, undefined, 'the host secret reached the runner');
    // The platform keys are there -- a sealed environment that cannot run
    // anything would not be a seal, it would be a breakage.
    assert.ok(captured.PATH);
    assert.ok(captured.PLAYWRIGHT_JSON_OUTPUT_FILE);
  } finally {
    delete process.env.HOST_SECRET_MARKER;
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('IT-ENV-ADP-004: the report still lands where the adapter asked for it', async () => {
  const project = fixture();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats212-out-'));
  try {
    const adapter = createPlaywrightAdapter();
    const handle = adapter.start({
      project: { root: project },
      run: { uid: 'run_1_1' },
      file: null,
      outputDir,
      env: buildRunnerEnv(null, { baseEnv: process.env }),
    });
    await new Promise((resolve, reject) => {
      handle.child.on('close', resolve);
      handle.child.on('error', reject);
    });
    // The seal must not have broken the engine's own contract: the report
    // is still where the adapter said it would be.
    const collected = adapter.collect({ outputDir });
    assert.ok(collected, 'the adapter collected no summary');
    assert.equal(collected.summary.total, 1);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});


test('IT-ENV-ADP-005: the LISTING child does not receive the host environment', () => {
  const project = fixture();
  process.env.HOST_SECRET_MARKER = 'the-host-secret-value';
  try {
    const capture = path.join(project, 'captured-env.json');
    const outcome = listTests({ root: project }, { timeoutMs: 60000, captureEnv: capture });
    // The listing must still WORK -- a seal that breaks the listing is a
    // breakage, not a seal.
    assert.equal(outcome.outcome, 'OK', JSON.stringify(outcome).slice(0, 400));
    assert.ok(fs.existsSync(capture), 'the listing did not capture its environment');
    const captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.equal(captured.HOST_SECRET_MARKER, undefined, 'the host secret reached the listing child');
    // The listing still has what it needs to run the project's own CLI.
    assert.ok(captured.PLAYWRIGHT_JSON_OUTPUT_FILE);
    assert.equal(captured.CI, '1');
  } finally {
    delete process.env.HOST_SECRET_MARKER;
    fs.rmSync(project, { recursive: true, force: true });
  }
});
