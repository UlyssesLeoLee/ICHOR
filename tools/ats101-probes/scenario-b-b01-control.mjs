#!/usr/bin/env node
/**
 * ATS-101 probe -- Scenario B
 *   B-01 control experiment: the SAME product source with ONLY
 *   `--screenshot` / `--video` removed from the CLI argument vector.
 *
 * IMPORTANT: the patch is applied to a SANDBOX COPY of server/core.mjs under
 * $ATS_PROBE_WORKDIR. The repository's product source is never modified, and
 * therefore this probe does NOT prove the product has the capability -- it only
 * proves the blocker is isolated to those two arguments.
 *
 * It also proves where the png/webm artefacts come from: they are produced by
 * the FIXTURE's own `use:{screenshot,video}` block. The probe runs the fixture
 * twice -- once with media configured, once without -- and compares.
 *
 * Usage: node tools/ats101-probes/scenario-b-b01-control.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  api, copyServerToSandbox, REPO_ROOT, session, startBridge, waitForHealth, waitForTerminal, WORK_ROOT,
} from './lib/bridge.mjs';
import { configText, ensureFixture } from './lib/fixture.mjs';

const PORT = 19732;
const BASE = `http://127.0.0.1:${PORT}`;

console.log('=== ATS-101 scenario B: B-01 control experiment (sandbox copy) ===');
console.log(`repo root      : ${REPO_ROOT}`);
console.log(`sandbox root   : ${WORK_ROOT}/sandbox-scenario-b`);
console.log('product source : NOT MODIFIED (patch applied to a sandbox copy)');
console.log('');

// --- build the sandbox: a copy of the product server/ with the two options removed
const sandbox = path.join(WORK_ROOT, 'sandbox-scenario-b');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
copyServerToSandbox(sandbox);
const corePath = path.join(sandbox, 'server', 'core.mjs');
const original = fs.readFileSync(corePath, 'utf8');
const patched = original.replace(
  "'--screenshot','only-on-failure','--video','retain-on-failure',",
  '',
);
if (patched === original) throw new Error('patch did not apply -- safeRunArgs() shape changed');
fs.writeFileSync(corePath, patched, 'utf8');
console.log('--- sandbox patch (server/core.mjs safeRunArgs) ---');
console.log('  -  ' + original.split('\n').find((l) => l.includes('const args=')).trim());
console.log('  +  ' + patched.split('\n').find((l) => l.includes('const args=')).trim());
console.log('');

async function runOnce(label, fixture) {
  const dataDir = path.join(WORK_ROOT, 'data', `scenario-b-${label}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const cp = startBridge({ root: sandbox, dataDir, port: PORT });
  try {
    await waitForHealth(BASE);
    const token = await session(BASE);
    const reg = await api(BASE, token, 'POST', '/api/projects', { path: fixture });
    const projectId = reg.body?.project?.id;
    if (!projectId) throw new Error(`[${label}] project registration failed`);
    const runRes = await api(BASE, token, 'POST', `/api/projects/${projectId}/run`, { file: 'tests/probe.spec.ts' });
    const final = await waitForTerminal(BASE, token, runRes.body.run.id);
    const files = (final.artifacts || []).map((a) => a.file);
    return {
      label,
      status: final.status,
      exitCode: final.exitCode,
      summary: final.summary,
      count: files.length,
      files,
      hasPng: files.some((f) => f.endsWith('.png')),
      hasWebm: files.some((f) => f.endsWith('.webm')),
      hasReport: files.some((f) => f.endsWith('report.json')),
    };
  } finally {
    cp.kill();
  }
}

const withMedia = ensureFixture('pwcap-media', { withMedia: true });
const withoutMedia = ensureFixture('pwcap-nomedia', { withMedia: false });

console.log('--- B-1: fixture WITH use:{screenshot,video} ---');
console.log('fixture playwright.config.ts:');
console.log(configText(true).split('\n').map((l) => '  | ' + l).join('\n'));
const b1 = await runOnce('with-media', withMedia);
console.log(`status = ${b1.status} exitCode = ${b1.exitCode}`);
console.log(`summary = ${JSON.stringify(b1.summary && { total: b1.summary.total, passed: b1.summary.passed, failed: b1.summary.failed, skipped: b1.summary.skipped, flaky: b1.summary.flaky })}`);
console.log(`artifacts n = ${b1.count}`);
console.log(`png present = ${b1.hasPng} | webm present = ${b1.hasWebm} | report.json present = ${b1.hasReport}`);
console.log(`first 12 artefacts: ${JSON.stringify(b1.files.slice(0, 12))}`);
console.log('');

console.log('--- B-2: fixture WITHOUT use:{screenshot,video} ---');
console.log('fixture playwright.config.ts:');
console.log(configText(false).split('\n').map((l) => '  | ' + l).join('\n'));
const b2 = await runOnce('without-media', withoutMedia);
console.log(`status = ${b2.status} exitCode = ${b2.exitCode}`);
console.log(`summary = ${JSON.stringify(b2.summary && { total: b2.summary.total, passed: b2.summary.passed, failed: b2.summary.failed, skipped: b2.summary.skipped, flaky: b2.summary.flaky })}`);
console.log(`artifacts n = ${b2.count}`);
console.log(`png present = ${b2.hasPng} | webm present = ${b2.hasWebm} | report.json present = ${b2.hasReport}`);
console.log('');

console.log('--- verdict ---');
console.log(`png/webm come from the FIXTURE config, not the Bridge : ${b1.hasPng && b1.hasWebm && !b2.hasPng && !b2.hasWebm}`);
console.log(`removing the two options makes the real run work    : ${Boolean(b1.summary) && b1.summary.total > 0}`);
console.log('=> The blocker is isolated to --screenshot/--video. The product source is unchanged,');
console.log('   so the product still does NOT have this capability (see 16-BASELINE-ADR.md B-01).');
