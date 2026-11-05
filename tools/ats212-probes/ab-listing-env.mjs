/**
 * ATS-212: an A/B comparison of the listing environment.
 *
 * The sealed listing environment (BASE_ENV_KEYS only) replaces the baseline
 * `...process.env`. This probe runs the REAL `playwright test --list` twice
 * per round -- once with the sealed environment, once with the baseline
 * environment -- and reports the two outcome distributions side by side.
 *
 * If the sealed environment made the listing fail, the two distributions
 * would differ: `sealed` would show failures where `baseline` does not.
 * A difference in the OTHER direction (baseline failing, sealed working) would
 * mean the sealed environment is not the cause of any observed failure.
 *
 * Usage: node tools/ats212-probes/ab-listing-env.mjs [rounds]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { BASE_ENV_KEYS } from '../../server/env/profiles.mjs';

const rounds = Number(process.argv[2] || 10);
const PLAYWRIGHT_VERSION = '1.64.1';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ats212-ab-'));
const ROOT = path.join(WORK, 'project');
fs.mkdirSync(path.join(ROOT, 'tests'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'package.json'), '{"name":"ats212-ab","private":true}', 'utf8');
fs.writeFileSync(
  path.join(ROOT, 'playwright.config.ts'),
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n",
  'utf8',
);
fs.writeFileSync(
  path.join(ROOT, 'tests', 'plain.spec.ts'),
  "import { test } from '@playwright/test';\ntest('plain case', async ({ page }) => {});\n",
  'utf8',
);

const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const install = spawnSync(process.execPath, [npmCli, 'install', `@playwright/test@${PLAYWRIGHT_VERSION}`, '--no-audit', '--no-fund'], {
  cwd: ROOT, encoding: 'utf8',
});
const CLI = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
if (install.status !== 0 || !fs.existsSync(CLI)) {
  console.log('the real Playwright could not be installed; the A/B comparison needs it');
  console.log(`npm install exit: ${install.status}`);
  process.exit(2);
}

function sealedEnv(reportFile) {
  const env = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  env.PLAYWRIGHT_JSON_OUTPUT_FILE = reportFile;
  env.CI = '1';
  env.FORCE_COLOR = '0';
  return env;
}

function baselineEnv(reportFile) {
  return {
    ...process.env,
    PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
    CI: '1',
    FORCE_COLOR: '0',
  };
}

function one(envFactory, tag, round) {
  const reportFile = path.join(WORK, `list-${tag}-${round}.json`);
  const r = spawnSync(process.execPath, [CLI, 'test', '--list', '--reporter=json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    env: envFactory(reportFile),
  });
  const reportExists = fs.existsSync(reportFile);
  const stderr = String(r.stderr || '').trim();
  if (!reportExists) return { ok: false, reason: 'no report', exitCode: r.status, stderr: stderr.split('\n')[0] };
  if (r.status !== 0) return { ok: false, reason: `exit ${r.status}`, exitCode: r.status, stderr: stderr.split('\n')[0] };
  let count = 0;
  try { count = JSON.parse(fs.readFileSync(reportFile, 'utf8')).suites?.length ?? -1; } catch { /* reported below */ }
  return { ok: true, count };
}

const sealed = { ok: 0, bad: [] };
const baseline = { ok: 0, bad: [] };
for (let i = 0; i < rounds; i += 1) {
  const s = one(sealedEnv, 'sealed', i);
  if (s.ok) sealed.ok += 1; else sealed.bad.push(s);
  const b = one(baselineEnv, 'baseline', i);
  if (b.ok) baseline.ok += 1; else baseline.bad.push(b);
}

fs.rmSync(WORK, { recursive: true, force: true });

console.log(`rounds              : ${rounds}`);
console.log(`sealed env  ok/bad  : ${sealed.ok}/${sealed.bad.length}`);
console.log(`baseline env ok/bad : ${baseline.ok}/${baseline.bad.length}`);
for (const [tag, res] of [['sealed', sealed], ['baseline', baseline]]) {
  for (const f of res.bad.slice(0, 3)) console.log(`  ${tag}: ${f.reason} exit=${f.exitCode} stderr=${f.stderr}`);
}
const same = (sealed.ok === baseline.ok) && (sealed.bad.length === baseline.bad.length);
console.log(`distributions equal : ${same}`);
process.exit(same ? 0 : 1);
