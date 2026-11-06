#!/usr/bin/env node
/**
 * ATS-201: does a REAL Playwright JSON report bind to the UID registry?
 *
 * The scenario of tools/ats201-probes/uid-e2e.mjs runs the bridge end to end,
 * but it drives a FAKE Playwright CLI that reports the target file the way the
 * bridge passed it on the command line (project root relative).
 *
 * A real Playwright reports `spec.file` relative to its own `rootDir`, which
 * is derived from `testDir`. For a project whose config declares
 * `testDir: './tests'` -- the shape of examples/sample-playwright and of most
 * Playwright projects -- the reported file is `home.spec.ts` while the UID
 * registry stores `tests/home.spec.ts`.
 *
 * This probe answers one question with real evidence:
 *   do the attempts of a real run carry the TestDefinition UID, and through
 *   which lookup basis?
 *
 * It does NOT modify the product source. The scenario project is a throwaway
 * fixture under the work directory.
 *
 * Usage: node tools/ats201-probes/attempt-binding-real-pw.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseReport, attemptsForRun, discoverStatic } from '../../server/core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const WORK = process.env.ATS201_PW_WORKDIR || path.join(os.tmpdir(), 'ats201-real-pw');
const FIXTURE = path.join(WORK, 'project');

const log = (...a) => console.log(...a);
const ok = (label, cond, detail = '') => {
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
};

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(FIXTURE, 'tests'), { recursive: true });

// A project shaped like examples/sample-playwright: the config declares
// `testDir: './tests'`, so Playwright's rootDir is <project>/tests.
fs.writeFileSync(path.join(FIXTURE, 'package.json'), '{"name":"ats201-real-pw"}');
fs.writeFileSync(
  path.join(FIXTURE, 'playwright.config.ts'),
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n"
);

// TWO test cases with the SAME title and DIFFERENT bodies -- the case the UID
// scheme exists for. Their UIDs must differ, and both attempts must be bound.
// They live in two files because a real Playwright refuses two test cases
// with the same title inside one file.
const specFor = (heading) => [
  "import { test, expect } from '@playwright/test';",
  "test('duplicate title', async ({ page }) => {",
  `  await page.setContent('<h1>${heading}</h1>');`,
  `  await expect(page.getByRole('heading')).toHaveText('${heading}');`,
  "});",
  ''
].join('\n');
fs.writeFileSync(path.join(FIXTURE, 'tests', 'dup-a.spec.ts'), specFor('first'));
fs.writeFileSync(path.join(FIXTURE, 'tests', 'dup-b.spec.ts'), specFor('second'));

// The real Playwright is installed into the fixture, the same way a user has
// it installed in their project.
log('--- installing the real @playwright/test into the fixture ---');
// `npm` on the PATH is a POSIX shim that spawnSync cannot drive, so the
// npm CLI script is invoked through the current node executable.
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
log('--- 1. a real Playwright run produces the report ---');
const reportPath = path.join(WORK, 'report.json');
const run = spawnSync(
  process.execPath,
  [path.join(FIXTURE, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--reporter=json'],
  { cwd: FIXTURE, encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath } }
);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
log(`   playwright rootDir : ${report.config.rootDir}`);
const reportedFiles = new Set();
const walkSuites = (s) => {
  for (const spec of s.specs || []) reportedFiles.add(spec.file);
  for (const sub of s.suites || []) walkSuites(sub);
};
for (const s of report.suites || []) walkSuites(s);
log(`   reported spec.file : ${[...reportedFiles].join(', ')}`);
ok('the real Playwright ran', report.stats && report.stats.expected >= 2, JSON.stringify(report.stats));

log('');
log('--- 2. the registry of the product code ---');
const project = { id: 'proj_legacy', uid: null, root: FIXTURE, name: 'fixture' };
const catalog = discoverStatic(project, undefined);
const registry = catalog.registry;
const projectUid = catalog.projectUid;
for (const t of catalog.tests) {
  log(`   ${t.uid}  (${t.uidSource})  ${t.file}:${t.line}  ${t.title}`);
}
ok('the two duplicate-title cases have different UIDs', catalog.tests[0].uid !== catalog.tests[1].uid);
ok(
  'the registry stores the file relative to the project root',
  registry.projects[projectUid].entries.every((e) => e.file.startsWith('tests/')),
  registry.projects[projectUid].entries.map((e) => e.file).join(', ')
);
ok(
  'the real Playwright reports the file relative to testDir',
  [...reportedFiles].every((f) => !f.startsWith('tests/')),
  [...reportedFiles].join(', ')
);

log('');
log('--- 3. the attempts of the real run ---');
const summary = parseReport(report);
const runRecord = { id: 'run_1_probe', uid: 'run_1_probe', projectUid, seq: 1, projectRoot: FIXTURE };
const attempts = attemptsForRun(runRecord, summary, registry);
for (const a of attempts) {
  log(`   ${a.uid}  testUid=${a.testUid}  basis=${a.uidBasis}  ${a.file}:${a.line}  ${a.title}`);
}
const bound = attempts.filter((a) => a.testUid);
ok('every attempt is bound to a TestDefinition UID', bound.length === attempts.length,
  `bound ${bound.length}/${attempts.length}`);
ok('the bound UIDs are the two distinct catalog UIDs',
  new Set(bound.map((a) => a.testUid)).size === 2,
  bound.map((a) => a.testUid).join(','));
ok('the bound UIDs are the catalog UIDs',
  bound.every((a) => catalog.tests.some((t) => t.uid === a.testUid)),
  bound.map((a) => a.testUid).join(','));

log('');
log(process.exitCode ? 'RESULT: FAILED' : 'RESULT: ALL CHECKS PASSED');
