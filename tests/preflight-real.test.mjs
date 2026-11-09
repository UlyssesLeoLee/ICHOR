// ATS-106: contract tests against a REAL @playwright/test installation
// (docs/26-RUNNER-PREFLIGHT.md). They answer what the test doubles cannot:
// does the preflight read a real installation correctly, and does the REAL
// CLI accept the exact argument vector the Bridge builds -- with the filter
// selecting exactly the requested file?
//
// The installation comes from ATS_REAL_PLAYWRIGHT_PROJECT, or from
// examples/sample-playwright when its node_modules is installed. Without one
// the tests are SKIPPED with the reason -- a skip is not a pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflightPlaywright } from '../server/adapters/playwright-preflight.mjs';
import { createPlaywrightAdapter } from '../server/adapters/playwright.mjs';
import { buildRunnerEnv } from '../server/env/profiles.mjs';

const root = path.resolve(import.meta.dirname, '..');
const candidate = process.env.ATS_REAL_PLAYWRIGHT_PROJECT || path.join(root, 'examples', 'sample-playwright');
const realModules = path.join(candidate, 'node_modules');
const available = fs.existsSync(path.join(realModules, '@playwright', 'test', 'cli.js'));
const skip = available ? false : `no real @playwright/test installation (set ATS_REAL_PLAYWRIGHT_PROJECT or run npm install in ${path.relative(root, candidate) || candidate})`;

// A throw-away project that borrows the real node_modules through a junction
// and carries two offline specs: one passes, one fails. The filter must pick
// the passing one only.
function contractProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats106-ct-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"ats106-contract","private":true}');
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', retries: 0, timeout: 30000 });\n");
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'ok.spec.ts'), "import { test, expect } from '@playwright/test';\ntest('offline page', async ({ page }) => { await page.setContent('<h1>ATS-106</h1>'); await expect(page.locator('h1')).toHaveText('ATS-106'); });\n");
  fs.writeFileSync(path.join(dir, 'tests', 'other.spec.ts'), "import { test, expect } from '@playwright/test';\ntest('must not run', async () => { expect(1).toBe(2); });\n");
  fs.symlinkSync(realModules, path.join(dir, 'node_modules'), 'junction');
  return dir;
}

test('CT-PF-001: the preflight reads a real installation as runnable', { skip }, () => {
  const version = JSON.parse(fs.readFileSync(path.join(realModules, '@playwright', 'test', 'package.json'), 'utf8')).version;
  const report = preflightPlaywright(candidate, { env: buildRunnerEnv({ variables: {} }) });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.version, version);
  assert.deepEqual(report.checks.find((c) => c.name === 'dependencies'), { name: 'dependencies', status: 'ok' });
  assert.ok(path.isAbsolute(report.registry));
  // Recorded for the evidence: which browsers the child would find.
  console.log(`CT-PF-001 version=${report.version} registry=${report.registry} warnings=${JSON.stringify(report.warnings.map((w) => w.code))}`);
});

test('CT-ARG-001: the real CLI accepts the Bridge vector and the filter selects one file', { skip, timeout: 180000 }, async () => {
  const dir = contractProject();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats106-ct-out-'));
  try {
    const env = buildRunnerEnv({ variables: {} });
    const preflight = preflightPlaywright(dir, { env });
    assert.equal(preflight.ok, true, JSON.stringify(preflight.errors));
    const handle = createPlaywrightAdapter().start({ project: { root: dir }, run: {}, file: 'tests/ok.spec.ts', outputDir, env });
    let log = '';
    handle.child.stdout.on('data', (b) => { log += b; });
    handle.child.stderr.on('data', (b) => { log += b; });
    const code = await new Promise((resolve) => handle.child.on('close', resolve));
    console.log(`CT-ARG-001 argv=${JSON.stringify(handle.args.slice(1))} exit=${code}`);
    assert.equal(code, 0, log.slice(-2000));
    const report = JSON.parse(fs.readFileSync(handle.reportFile, 'utf8'));
    const files = new Set();
    const walk = (suite) => { if (suite.specs?.length) files.add(suite.file); (suite.suites || []).forEach(walk); };
    report.suites.forEach(walk);
    assert.deepEqual([...files].map((f) => f.replace(/\\/g, '/')), ['ok.spec.ts']);
    assert.equal(report.stats.expected, 1);
    assert.equal(report.stats.unexpected, 0);
  } finally {
    // Remove the JUNCTION itself first and never recurse through it: a
    // recursive delete that followed it would wipe the real node_modules.
    const link = path.join(dir, 'node_modules');
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* reported below */ } }
    if (!fs.existsSync(link)) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
