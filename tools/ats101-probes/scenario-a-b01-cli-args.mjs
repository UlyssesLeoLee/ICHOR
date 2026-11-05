#!/usr/bin/env node
/**
 * ATS-101 probe -- Scenario A
 *   B-01: the Bridge's Playwright CLI argument vector contains two options that
 *   do not exist, so a REAL browser run fails 100% of the time.
 *
 * What this proves: with the UNMODIFIED product source, a genuine Playwright
 * project (real @playwright/test, real Chromium) driven through the Bridge API
 * never reaches the browser -- the CLI rejects the argument vector.
 *
 * Usage: node tools/ats101-probes/scenario-a-b01-cli-args.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { api, REPO_ROOT, session, startBridge, waitForHealth, waitForTerminal, WORK_ROOT } from './lib/bridge.mjs';
import { configText, ensureFixture } from './lib/fixture.mjs';

const PORT = 19731;
const BASE = `http://127.0.0.1:${PORT}`;

console.log('=== ATS-101 scenario A: B-01 real Playwright CLI argument vector ===');
console.log(`repo root      : ${REPO_ROOT}`);
console.log(`bridge port    : ${PORT}`);
console.log('product source : UNMODIFIED (server/core.mjs as committed)');
console.log('');

const fixture = ensureFixture('pwcap', { withMedia: true });
console.log('--- fixture ---');
console.log(`fixture dir    : ${fixture}`);
console.log('fixture playwright.config.ts:');
console.log(configText(true).split('\n').map((l) => '  | ' + l).join('\n'));
console.log('');

const dataDir = path.join(WORK_ROOT, 'data', 'scenario-a');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const cp = startBridge({ root: REPO_ROOT, dataDir, port: PORT });
try {
  await waitForHealth(BASE);
  const token = await session(BASE);
  const H = { 'X-ATS-Token': token, 'Content-Type': 'application/json' };

  const reg = await api(BASE, token, 'POST', '/api/projects', { path: fixture });
  console.log(`POST /api/projects            -> ${reg.status} ${JSON.stringify(reg.body).slice(0, 160)}`);
  const projectId = reg.body?.project?.id;
  if (!projectId) throw new Error('project registration failed');

  const runRes = await api(BASE, token, 'POST', `/api/projects/${projectId}/run`, { file: 'tests/probe.spec.ts' });
  console.log(`POST /api/projects/:id/run    -> ${runRes.status} initial status=${runRes.body?.run?.status}`);
  const runId = runRes.body?.run?.id;

  const final = await waitForTerminal(BASE, token, runId);
  console.log('');
  console.log('--- terminal state ---');
  console.log(`status      = ${final.status}`);
  console.log(`exitCode    = ${final.exitCode}`);
  console.log(`summary     = ${JSON.stringify(final.summary)}`);
  console.log(`artifacts   = ${JSON.stringify((final.artifacts || []).map((a) => a.file))}`);
  console.log(`artifacts n = ${(final.artifacts || []).length}`);
  const logTail = (final.log || '').split('\n').filter(Boolean).slice(-4).join('\n');
  console.log('stdout tail :');
  console.log(logTail.split('\n').map((l) => '  | ' + l).join('\n'));

  const ev = await api(BASE, token, 'GET', `/api/runs/${runId}/events`);
  console.log(`events      = ${JSON.stringify((ev.body?.events || []).map((e) => e.type + '#' + e.seq))}`);

  console.log('');
  console.log('--- verdict ---');
  const cliRejected = /unknown option/.test(final.log || '');
  console.log(`CLI rejected the argument vector : ${cliRejected}`);
  console.log(`browser ever started             : ${Boolean(final.summary) || (final.artifacts || []).length > 0}`);
  console.log(cliRejected
    ? 'RESULT: B-01 CONFIRMED -- the run died in CLI argument parsing, before any browser launch.'
    : 'RESULT: B-01 NOT reproduced -- investigate before publishing this baseline.');
} finally {
  cp.kill();
}
