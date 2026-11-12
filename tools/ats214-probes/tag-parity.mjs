#!/usr/bin/env node
/**
 * ATS-214: the TAG PARITY probe.
 *
 * WHAT THIS PROBE IS FOR
 * ----------------------
 * The tag filter only works if BOTH indexes carry the tags:
 *
 *   * the AUTHORITATIVE index gets them from the real Playwright CLI
 *     (`playwright test --list` reports `spec.tags` for every case);
 *   * the STATIC index reads them out of the SOURCE -- that is the reader
 *     this task added (`server/uid.mjs` -> `scanCaseTags`).
 *
 * If only the authoritative index carried them, a tag filter would work on
 * a trusted project and silently match NOTHING on an untrusted one. That
 * asymmetry reads as "the filter is broken" rather than "the filter saw no
 * tags", so the static index reads them too -- and this probe PROVES the
 * two agree.
 *
 * WHAT IT MEASURES
 * ----------------
 * For every case of one fixture, the tags the static index reads and the
 * tags the real CLI reports. The probe fails when they differ.
 *
 * It also reports the FACTS the design doc relies on, measured rather than
 * assumed:
 *
 *   * the '@' prefix: the source says '@smoke', the CLI reports 'smoke';
 *   * the describe inheritance: a describe's tag reaches the cases below it;
 *   * the accumulation: nested describes stack their tags;
 *   * the '@' requirement: a tag without '@' is refused by the CLI.
 *
 * THE REAL PLAYWRIGHT
 * -------------------
 * The listing runs the PROJECT's own CLI, so the fixture needs a
 * `node_modules`. The real CLI of the repository (the example project's
 * dependency tree) is linked into the fixture as a JUNCTION -- the same
 * trick the ATS-202/ATS-203 tests use. Nothing is installed here.
 *
 * Usage: node tools/ats214-probes/tag-parity.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scanTestCases } from '../../server/uid.mjs';
import { listTests } from '../../server/discovery/playwright-list.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The REAL `@playwright/test` the fixture can reach.
 */
function findPlaywrightModules() {
  const candidates = [
    process.env.ATS214_PLAYWRIGHT_MODULES,
    path.join(REPO_ROOT, 'examples', 'sample-playwright', 'node_modules'),
    'D:/ICHOR/examples/sample-playwright/node_modules',
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, '@playwright', 'test', 'cli.js'))) return dir;
  }
  return null;
}

const PLAYWRIGHT_MODULES = findPlaywrightModules();
if (!PLAYWRIGHT_MODULES) {
  console.log('SKIP: the real @playwright/test could not be reached.');
  console.log('      Set ATS214_PLAYWRIGHT_MODULES to the directory that holds');
  console.log('      @playwright/test/cli.js and run this probe again.');
  process.exit(0);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ats214-parity-'));
const FIXTURE = path.join(WORK, 'project');

/** The fixture: six cases, three tags, nested describes. */
const SPEC = [
  "import { test } from '@playwright/test';",
  '',
  "test('plain case', async () => {});",
  '',
  "test('tagged case', { tag: '@smoke' }, async () => {});",
  '',
  "test('multi tag', { tag: ['@a', '@b'] }, async () => {});",
  '',
  "test.describe('group', { tag: '@group' }, () => {",
  "  test('inside group', async () => {});",
  "  test('own tag too', { tag: '@own' }, async () => {});",
  "  test.describe('inner', { tag: '@inner' }, () => {",
  "    test('nested', async () => {});",
  "  });",
  "});",
  '',
].join('\n');

fs.mkdirSync(path.join(FIXTURE, 'tests'), { recursive: true });
fs.writeFileSync(path.join(FIXTURE, 'package.json'), '{"name":"ats214-parity","private":true}');
fs.writeFileSync(
  path.join(FIXTURE, 'playwright.config.ts'),
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n"
);
fs.writeFileSync(path.join(FIXTURE, 'tests', 'tagged.spec.ts'), SPEC);
fs.symlinkSync(PLAYWRIGHT_MODULES, path.join(FIXTURE, 'node_modules'), 'junction');

console.log(`fixture: ${FIXTURE}`);
console.log(`playwright: ${PLAYWRIGHT_MODULES}`);

// --- the STATIC index ----------------------------------------------------
const content = fs.readFileSync(path.join(FIXTURE, 'tests', 'tagged.spec.ts'), 'utf8');
const staticTags = new Map();
for (const c of scanTestCases(content)) staticTags.set(c.line, (c.tags ?? []).slice().sort());

// --- the AUTHORITATIVE index (the real CLI) ------------------------------
const listed = listTests({ root: FIXTURE });
console.log(`the CLI answered: ok=${listed.ok} outcome=${listed.outcome ?? 'OK'} version=${listed.version ?? '?'}`);
if (!listed.ok) {
  console.log(`the CLI failed: ${(listed.errors ?? []).map((e) => e.message).join('; ')}`);
  process.exit(1);
}
const cliTags = new Map();
for (const t of listed.tests) cliTags.set(t.line, (t.tags ?? []).slice().sort());

// --- the comparison -------------------------------------------------------
console.log('');
console.log('line | static index            | the real CLI              | same');
console.log('-----+-------------------------+--------------------------+-----');
const lines = [...new Set([...staticTags.keys(), ...cliTags.keys()])].sort((a, b) => a - b);
let mismatches = 0;
for (const line of lines) {
  const s = staticTags.get(line) ?? [];
  const c = cliTags.get(line) ?? [];
  const same = JSON.stringify(s) === JSON.stringify(c);
  if (!same) mismatches += 1;
  console.log(
    `${String(line).padStart(4)} | ${JSON.stringify(s).padEnd(23)} | ${JSON.stringify(c).padEnd(24)} | ${same ? 'yes' : 'NO'}`
  );
}

console.log('');
const cases = listed.tests.length;
console.log(`cases: ${cases} · tags: ${[...cliTags.values()].filter((t) => t.length).length} with tags · mismatches: ${mismatches}`);

// --- the facts the design doc relies on -----------------------------------
console.log('');
console.log('--- the facts the design relies on (measured, not assumed) ---');
const smoke = listed.tests.find((t) => t.title === 'tagged case');
console.log(`the source writes '@smoke', the CLI reports ${JSON.stringify(smoke?.tags ?? [])}  -> the '@' is not part of the tag`);
const inside = listed.tests.find((t) => t.title === 'inside group');
console.log(`a case under describe(...{tag:'@group'}) reports ${JSON.stringify(inside?.tags ?? [])}  -> the describe's tag is inherited`);
const nested = listed.tests.find((t) => t.title === 'nested');
console.log(`a case under two nested describes reports ${JSON.stringify(nested?.tags ?? [])}  -> the tags accumulate`);
const own = listed.tests.find((t) => t.title === 'own tag too');
console.log(`a case with its own tag under a tagged describe reports ${JSON.stringify(own?.tags ?? [])}  -> own + inherited`);

// The '@' requirement: a tag without it is refused by the CLI.
const BAD = path.join(WORK, 'bad');
fs.mkdirSync(path.join(BAD, 'tests'), { recursive: true });
fs.writeFileSync(path.join(BAD, 'package.json'), '{"name":"bad","private":true}');
fs.writeFileSync(
  path.join(BAD, 'playwright.config.ts'),
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', timeout: 20000, retries: 0 });\n"
);
fs.writeFileSync(path.join(BAD, 'tests', 'bad.spec.ts'), "import { test } from '@playwright/test';\ntest('no at sign', { tag: 'smoke' }, async () => {});\n");
fs.symlinkSync(PLAYWRIGHT_MODULES, path.join(BAD, 'node_modules'), 'junction');
const badListed = listTests({ root: BAD });
const badMessage = (badListed.errors ?? []).map((e) => e.message).join('; ');
console.log(`a tag without '@' is refused by the CLI: ok=${badListed.ok} ${JSON.stringify(badMessage)}`);

fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

console.log('');
if (mismatches) {
  console.log(`RESULT: FAILED -- the static index and the real CLI disagree on ${mismatches} case(s).`);
  process.exit(1);
}
console.log(`RESULT: OK -- the static index and the real Playwright CLI carry the SAME tags for all ${cases} cases.`);
