#!/usr/bin/env node

/**
 * ATS-107: the INTEGRATION test of the real-browser PASS/FAIL repository.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The acceptance criterion of ATS-107 is
 *
 *   「Chromium 上至少 1 PASS 1 FAIL；结果和错误信息与 CLI 一致」
 *
 * The system test (`tools/ats107-probes/st-ats107.mjs`) measures it with a
 * probe of its own. This file is the INTEGRATION view of the same
 * criterion: it drives the product the way a USER does -- over HTTP,
 * against a running Bridge, with the project registered through the API --
 * and asserts the same facts from the API's own answers.
 *
 * The two views are deliberately different in their inputs:
 *
 *   - the probe reads the engine's report with its OWN walker, so a bug in
 *     the product's parser cannot hide itself;
 *   - this file reads the Bridge's ANSWERS (the summary the API returns),
 *     so a bug in the projection cannot hide behind the engine's report.
 *
 * Together they bound the criterion from both sides.
 *
 * THE REAL BROWSER
 * -----------------
 * The fixture is a REAL Playwright project with a REAL Chromium. The engine
 * is the one the committed lockfile pins; the browser is the locally
 * installed one. When either is unreachable, the cases are SKIPPED with the
 * reason -- a skip is not a pass, and the reason is printed so the evidence
 * says which.
 *
 * THE SEALED RUNNER ENVIRONMENT
 * ------------------------------
 * The Bridge runs the engine in a SEALED environment (`server/env/profiles.mjs`):
 * only the whitelisted base keys reach the runner, and the reserved names
 * (among them `PLAYWRIGHT_BROWSERS_PATH`) never do. So the Bridge's run
 * finds the browser in the DEFAULT location, while the direct CLI run in
 * this file inherits the host's environment. The cases below therefore
 * compare the two sides with the host's own browser location -- that is the
 * configuration in which "consistent with the CLI" holds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { freePort } from './helpers/free-port.mjs';
import { stripAnsi, verdictToStatus } from '../tools/ats107-probes/compare.mjs';
import { chromiumInAny } from '../tools/ats107-probes/lib/trace.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_SRC = path.join(REPO_ROOT, 'examples', 'real-browser-fixture');

/* --- the fixture's engine ----------------------------------------------- */
const pinnedVersion = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_SRC, 'package.json'), 'utf8')).devDependencies['@playwright/test'];

/**
 * The engine the fixture installs, and whether a browser is available.
 *
 * The fixture's own `npm ci` is the source of truth: the criterion is about
 * the PINNED engine, so a different one would not answer it.
 */
function prepareFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats107-it-'));
  const project = path.join(dir, 'real-browser-fixture');
  fs.cpSync(FIXTURE_SRC, project, {
    recursive: true,
    filter: (p) => !p.includes('node_modules') && !p.includes('test-results') && !p.includes('playwright-report'),
  });
  const install = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], {
    cwd: project, encoding: 'utf8', shell: process.platform === 'win32', timeout: 600000,
  });
  if (install.status !== 0) {
    return { ok: false, reason: `npm ci failed (exit ${install.status}): ${(install.stderr || '').slice(0, 300)}`, project };
  }
  const pkg = path.join(project, 'node_modules', '@playwright', 'test', 'package.json');
  if (!fs.existsSync(pkg)) {
    return { ok: false, reason: 'the fixture did not install @playwright/test', project };
  }
  const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  if (version !== pinnedVersion) {
    return { ok: false, reason: `the installed engine is ${version}, not the pinned ${pinnedVersion}`, project };
  }
  return { ok: true, project, version, reason: '' };
}

const prepared = prepareFixture();
const skip = prepared.ok ? false : prepared.reason;

/* --- the Bridge ---------------------------------------------------------- */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats107-it-data-'));
let bridge = null;
/** The registered fixture's id -- the Bridge accepts one registration per path. */
let projectId = null;

test.before(async () => {
  if (skip) return;
  const port = await freePort();
  const cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  cp.stderr.on('data', (b) => { stderr += b; });
  const end = Date.now() + 60000;
  let up = false;
  while (Date.now() < end && !up) {
    try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) {
    bridge = null;
    throw new Error(`the Bridge did not start: ${stderr.slice(0, 500)}`);
  }
  bridge = { cp, port, stderr: () => stderr };
});

test.after(async () => {
  if (bridge?.cp) {
    const cp = bridge.cp;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(cp.pid), '/T', '/F'], { windowsHide: true });
    } else cp.kill('SIGKILL');
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (prepared.project) fs.rmSync(path.dirname(prepared.project), { recursive: true, force: true });
});

async function api(endpoint, method = 'GET', body, token) {
  const r = await fetch(`http://127.0.0.1:${bridge.port}${endpoint}`, {
    method,
    headers: token ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return [r.status, await r.json()];
}

/** Run the fixture through the Bridge and return the finished run. */
async function runThroughBridge() {
  const [, session] = await api('/api/session');
  const token = session.token;
  // The fixture is registered ONCE: the Bridge refuses a second
  // registration of the same path (PROJECT_ALREADY_REGISTERED), so the
  // cases share the project and each starts its own run.
  if (!projectId) {
    const [, added] = await api('/api/projects', 'POST', { path: prepared.project }, token);
    assert.ok(added?.project?.id, `the Bridge refused the fixture: ${JSON.stringify(added)}`);
    projectId = added.project.id;
  }
  const [, started] = await api(`/api/projects/${projectId}/run`, 'POST', {}, token);
  const runId = started?.run?.id;
  assert.ok(runId, `the Bridge did not start a run: ${JSON.stringify(started)}`);
  for (let i = 0; i < 900; i++) {
    const [, body] = await api(`/api/runs/${runId}`, 'GET', null, token);
    if (['passed', 'failed', 'cancelled', 'error', 'interrupted'].includes(body?.run?.status)) {
      return { run: body.run, summary: body.run.summary, runId, token };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the Bridge run did not finish');
}

/* --- the cases ----------------------------------------------------------- */

test('IT-ATS107-001: the Bridge runs the real fixture and reports one PASS and one FAIL', { skip, timeout: 600000 }, async () => {
  const { summary } = await runThroughBridge();
  assert.equal(summary.passed, 1, JSON.stringify(summary));
  assert.equal(summary.failed, 1, JSON.stringify(summary));
  assert.equal(summary.total, 2, JSON.stringify(summary));
});

test('IT-ATS107-002: the run really launched a Chromium (the trace has a browser context)', { skip, timeout: 600000 }, async () => {
  const { runId } = await runThroughBridge();
  const runFolder = path.join(dataDir, 'runs', runId);
  const traces = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'trace.zip') traces.push(full);
    }
  };
  walk(runFolder);
  assert.ok(traces.length >= 1, 'the run folder holds no trace.zip');
  const verdict = chromiumInAny(traces);
  assert.ok(verdict.ok, verdict.detail);
});

test('IT-ATS107-003: the failing case carries the engine\'s own error message, in full', { skip, timeout: 600000 }, async () => {
  const { summary } = await runThroughBridge();
  const failing = (summary.cases ?? []).find((c) => c.status === 'failed');
  assert.ok(failing, 'the summary has no failed case');
  const text = stripAnsi(failing.error ?? '');
  assert.ok(text.length > 0, 'the failed case carries no error message');
  // The engine's own assertion text is in there ...
  assert.ok(text.includes('ATS-107 FAIL — this text is intentionally absent'),
    `the error message does not carry the engine's assertion text:\n${text}`);
  // ... and so is the engine's own detail: a message that had been truncated
  // would still carry the assertion text but not these.
  assert.ok(text.includes('Received:'), `the error message was truncated:\n${text}`);
  assert.ok(text.includes('Call log:'), `the error message was truncated:\n${text}`);
});
