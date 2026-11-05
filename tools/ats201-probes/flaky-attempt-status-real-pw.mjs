#!/usr/bin/env node
/**
 * ATS-201: does a REAL Playwright report give each ATTEMPT its own status?
 *
 * The first review (A1) found that the Attempt recorded the CASE level status
 * instead of the RESULT level status: a flaky case whose first retry failed
 * and whose second retry passed produced TWO attempts, both recorded as
 * `flaky`. The failed retry was invisible.
 *
 * A flaky case is produced here by a REAL Playwright: the case fails on the
 * first attempt and passes on the second. The probe then runs the product code
 * (`parseReport` / `attemptsForRun`) over the real report and asserts:
 *
 *   * the first attempt is `failed` and the second is `passed`;
 *   * the CASE level status is still available, as `caseStatus`.
 *
 * It does NOT modify the product source. The scenario project is a throwaway
 * fixture under the work directory.
 *
 * Usage: node tools/ats201-probes/flaky-attempt-status-real-pw.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseReport, attemptsForRun } from '../../server/core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.ATS201_PW_WORKDIR || path.join(os.tmpdir(), 'ats201-flaky-pw');
const FIXTURE = path.join(WORK, 'project');

const log = (...a) => console.log(...a);
const ok = (label, cond, detail = '') => {
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
};

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(FIXTURE, 'tests'), { recursive: true });

fs.writeFileSync(path.join(FIXTURE, 'package.json'), '{"name":"ats201-flaky-pw"}');
fs.writeFileSync(
  path.join(FIXTURE, 'playwright.config.ts'),
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 1 });\n"
);

// The case fails on the first attempt and passes on the second.
//
// The counter lives in a FILE, not in a module variable: Playwright runs every
// retry in a FRESH worker process, so a module variable would be reset and the
// case would fail on every retry. The counter is part of the fixture, not of
// the product.
fs.writeFileSync(
  path.join(FIXTURE, 'tests', 'flaky.spec.ts'),
  [
    "import { test, expect } from '@playwright/test';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "test('flaky case', async ({ page }) => {",
    "  const counter = path.join(__dirname, '..', 'attempts.count');",
    "  const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;",
    "  fs.writeFileSync(counter, String(seen + 1));",
    "  await page.setContent('<h1 id=\"t\">hello</h1>');",
    "  if (seen === 0) {",
    "    await expect(page.locator('#t')).toHaveText('mismatch');",
    "    return;",
    "  }",
    "  await expect(page.locator('#t')).toHaveText('hello');",
    "});",
    ''
  ].join('\n')
);

log('--- installing the real @playwright/test into the fixture ---');
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const install = spawnSync(process.execPath, [npmCli, 'install', '@playwright/test@1.64.1', '--no-audit', '--no-fund'], {
  cwd: FIXTURE, encoding: 'utf8'
});
if (install.status !== 0) {
  log('npm install failed:');
  log(install.stderr || install.stdout);
  process.exit(1);
}

log('');
log('--- 1. the real Playwright run produces a flaky report ---');
const reportPath = path.join(WORK, 'report.json');
const run = spawnSync(
  process.execPath,
  [path.join(FIXTURE, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--reporter=json'],
  { cwd: FIXTURE, encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath } }
);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
log(`   playwright stats : ${JSON.stringify(report.stats)}`);
ok('the case is flaky in the real report', report.stats.flaky === 1, JSON.stringify(report.stats));

log('');
log('--- 2. the raw report carries BOTH status levels ---');
const summary = parseReport(report);
for (const c of summary.cases) {
  log(`   case="${c.title}"  caseStatus=${c.status}  resultStatus=${c.resultStatus}  retry=${c.retry}`);
}
ok('the report has two executions', summary.cases.length === 2, String(summary.cases.length));
ok('the first execution really failed',
  summary.cases.find((c) => c.retry === 0)?.resultStatus === 'failed',
  String(summary.cases.find((c) => c.retry === 0)?.resultStatus));
ok('the second execution really passed',
  summary.cases.find((c) => c.retry === 1)?.resultStatus === 'passed',
  String(summary.cases.find((c) => c.retry === 1)?.resultStatus));
ok('the CASE level status is still flaky',
  summary.cases.every((c) => c.status === 'flaky'),
  summary.cases.map((c) => c.status).join(','));

log('');
log('--- 3. the ATTEMPTS of the product code ---');
const attempts = attemptsForRun(
  { id: 'run_1_probe', uid: 'run_1_probe', projectUid: 'proj_1_probe', seq: 1, projectRoot: FIXTURE },
  summary,
  { version: 1, projects: {} }
);
for (const a of attempts) {
  log(`   ${a.uid}  status=${a.status}  caseStatus=${a.caseStatus}  retry=${a.retry}`);
}
ok('there is one attempt per execution', attempts.length === 2, String(attempts.length));
ok('the first attempt is failed', attempts[0]?.status === 'failed', String(attempts[0]?.status));
ok('the second attempt is passed', attempts[1]?.status === 'passed', String(attempts[1]?.status));
ok('the case level status is kept next to it', attempts[0]?.caseStatus === 'flaky', String(attempts[0]?.caseStatus));
ok('the two attempts do not record the same status',
  attempts[0]?.status !== attempts[1]?.status);

log('');
log(process.exitCode ? 'RESULT: FAILED' : 'RESULT: ALL CHECKS PASSED');
