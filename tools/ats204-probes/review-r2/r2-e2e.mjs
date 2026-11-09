#!/usr/bin/env node
/**
 * ATS-204 review round 2 -- new-problem checks on the lines round 2 changed.
 * Real Playwright CLI, the product's own discoverTests()/parseReport()/attemptsForRun().
 *
 * Usage: node r2-e2e.mjs <tree-root> <node_modules with @playwright/test 1.64.1> <scratch-dir>
 * Exit 1 when a blocking check fails. INFO lines never fail the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [tree, nm, scratch] = process.argv.slice(2).map((p) => path.resolve(p));
const imp = (rel) => import(pathToFileURL(path.join(tree, rel)).href);
const { discoverTests, parseReport, attemptsForRun } = await imp('server/core.mjs');
const { withTrust, TRUST } = await imp('server/discovery/trust.mjs');
const { emptyRegistry } = await imp('server/uid.mjs');

let n = 0;
function fixture(name, files) {
  const root = path.join(scratch, `${name}-${n++}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.cpSync(nm, path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"r2e2e","private":true}');
  fs.writeFileSync(path.join(root, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', retries: 0, workers: 1 });\n");
  write(root, files);
  const uid = 'proj_1_' + (Math.random().toString(16).slice(2) + '0'.repeat(24)).slice(0, 24);
  return { id: uid, uid, root };
}
function write(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) { fs.rmSync(path.join(root, rel), { force: true }); continue; }
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}
const trusted = (p) => withTrust({}, p, { trust: TRUST.TRUSTED });
const discover = (p, reg, trust = true) => discoverTests(p, trust ? trusted(p) : {}, reg ?? emptyRegistry());
const showCat = (cat) => cat.tests.map((t) => `    ${JSON.stringify(t.title)} line=${t.line} scope=${JSON.stringify(t.describePath ?? [])} uid=${t.uid} basis=${t.uidBasis}${t.ambiguity ? ' amb=' + t.ambiguity.reason : ''}`).join('\n');
function runAttempts(p, cat, file = null) {
  const out = path.join(p.root, 'report.json');
  fs.rmSync(out, { force: true });
  const args = [path.join(p.root, 'node_modules/@playwright/test/cli.js'), 'test', '--reporter=json'];
  if (file) args.push(file);
  spawnSync(process.execPath, args, { cwd: p.root, encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: out } });
  const s = parseReport(JSON.parse(fs.readFileSync(out, 'utf8')));
  const rid = 'run_1_' + (Math.random().toString(16).slice(2) + '0'.repeat(24)).slice(0, 24);
  return attemptsForRun({ id: rid, uid: rid, projectId: p.id, projectUid: p.uid, projectRoot: p.root }, s, cat.registry);
}

let failed = 0;
function report(id, claim, expected, actual, ok, detail = '', info = false) {
  if (!ok && !info) failed++;
  console.log(`\n[${id}] ${claim}\n  expected: ${expected}\n  actual:   ${actual}${detail ? `\n${detail}` : ''}\n  VERDICT:  ${ok ? 'OK' : info ? 'INFO (not blocking)' : 'FAIL'}`);
}

/* X2: the duplicate is FIXED (token removed from b) -> the token must bind again for a. */
{
  const p = fixture('x2', {
    'tests/a.spec.ts': "import { test } from '@playwright/test';\n\ntest('checkout @TC-001', async () => { const a = 1; });\n",
    'tests/b.spec.ts': "import { test } from '@playwright/test';\n\ntest('refund @TC-001', async () => { const b = 2; });\n",
  });
  const c1 = discover(p);
  write(p.root, { 'tests/b.spec.ts': "import { test } from '@playwright/test';\n\ntest('refund', async () => { const b = 2; });\n" });
  const c2 = discover(p, c1.registry);
  const atts = runAttempts(p, c2, 'tests/a.spec.ts');
  const stale = (c2.registry.projects[p.uid]?.entries ?? []).filter((e) => e.duplicateExplicit).map((e) => `${e.title}:${e.uid}`);
  const got = atts.map((a) => `${a.title}:${a.testUid}(${a.uidBasis})`).join(', ');
  report('X2', 'after the duplicate @TC-001 is removed from b.spec, a single-file run of a.spec binds tc-001 again',
    'checkout @TC-001:tc-001(explicit)', got, atts.every((a) => a.testUid === 'tc-001'),
    `  catalogue after fix:\n${showCat(c2)}\n  registry entries still marked duplicateExplicit: ${JSON.stringify(stale)}`);
}

/* X3: same duplicate, UNTRUSTED project (static catalogue). */
{
  const p = fixture('x3', {
    'tests/a.spec.ts': "import { test } from '@playwright/test';\n\ntest('checkout @TC-001', async () => { const a = 1; });\n",
    'tests/b.spec.ts': "import { test } from '@playwright/test';\n\ntest('refund @TC-001', async () => { const b = 2; });\n",
  });
  const cat = discover(p, null, false);
  const atts = runAttempts(p, cat, 'tests/b.spec.ts');
  const got = atts.map((a) => `${a.title}:${a.testUid}(${a.uidBasis})`).join(', ');
  const catAmb = cat.tests.map((t) => `${t.title}:${t.uid}(${t.ambiguity?.reason ?? t.uidBasis ?? t.uidSource})`).join(', ');
  const flagged = cat.tests.length === 2 && cat.tests.every((t) => t.ambiguity?.reason === 'duplicate-explicit-uid');
  const unbound = atts.length > 0 && atts.every((a) => a.testUid === null && a.uidBasis === 'explicit-ambiguous');
  report('X3', 'static (untrusted, the default) catalogue STILL judges @TC-001 duplicated, and a single-file run agrees: unbound, explicit-ambiguous',
    'catalogue flags both; attempt null(explicit-ambiguous)', `${got}  | catalogue(${cat.discovery}): ${catAmb}`,
    flagged && unbound, '');
}

/* X2s: static (untrusted) path -- the duplicate is FIXED -> the token must bind again (no stale lock-out). */
{
  const p = fixture('x2s', {
    'tests/a.spec.ts': "import { test } from '@playwright/test';\n\ntest('checkout @TC-001', async () => { const a = 1; });\n",
    'tests/b.spec.ts': "import { test } from '@playwright/test';\n\ntest('refund @TC-001', async () => { const b = 2; });\n",
  });
  const c1 = discover(p, null, false);
  write(p.root, { 'tests/b.spec.ts': "import { test } from '@playwright/test';\n\ntest('refund', async () => { const b = 2; });\n" });
  const c2 = discover(p, c1.registry, false);
  const atts = runAttempts(p, c2, 'tests/a.spec.ts');
  const stale = (c2.registry.projects[p.uid]?.entries ?? []).filter((e) => e.duplicateExplicit).map((e) => `${e.title}:${e.uid}`);
  const got = atts.map((a) => `${a.title}:${a.testUid}(${a.uidBasis})`).join(', ');
  report('X2s', 'static (untrusted) path: after the duplicate is removed from b.spec, a single-file run of a.spec binds tc-001 again',
    'checkout @TC-001:tc-001(explicit)', got, atts.length > 0 && atts.every((a) => a.testUid === 'tc-001'),
    `  catalogue after fix (${c2.discovery}):\n${showCat(c2)}\n  registry entries still marked duplicateExplicit: ${JSON.stringify(stale)}`);
}

/* M3: describe-loop -- each attempt is bound to the catalogue uid of ITS describe. */
{
  const p = fixture('m3', { 'tests/d.spec.ts': ["import { test, expect } from '@playwright/test';", '',
    "for (const n of ['a', 'b']) {", '  test.describe(n, () => {',
    "    test('works', async () => { expect(n).toBe('a'); });", '  });', '}', ''].join('\n') });
  const cat = discover(p);
  const atts = runAttempts(p, cat);
  const want = Object.fromEntries(cat.tests.map((t) => [t.describePath.join('>'), t.uid]));
  // the failing one is describe b
  const failedAtt = atts.find((a) => a.status === 'failed');
  const passedAtt = atts.find((a) => a.status === 'passed');
  const ok = failedAtt?.testUid === want.b && passedAtt?.testUid === want.a;
  report('M3', "describe-loop: the FAILED attempt (b > works) carries b's uid, the passed one a's uid",
    `failed->${want.b}, passed->${want.a}`, `failed->${failedAtt?.testUid}(${failedAtt?.uidBasis}), passed->${passedAtt?.testUid}(${passedAtt?.uidBasis})`, ok);
}

/* N2: replace ALL loop data at the same position and count -> indistinguishable from a re-wording. */
{
  const loop = (names) => ["import { test, expect } from '@playwright/test';", '',
    `for (const u of ${JSON.stringify(names)}) {`, "  test(`user ${u}`, async () => { expect(u.length).toBeGreaterThan(0); });", '}', ''].join('\n');
  const p = fixture('n2', { 'tests/u.spec.ts': loop(['alice', 'bob']) });
  const c1 = discover(p);
  write(p.root, { 'tests/u.spec.ts': loop(['carol', 'dave']) });
  const c2 = discover(p, c1.registry);
  const inherited = c2.tests.filter((t) => t.uidBasis === 'position-anchor').length;
  report('N2', 'all loop data replaced (alice,bob -> carol,dave), same count: anchor treats it as a re-wording',
    'documented in doc 26 §7 if inherited', `${inherited} render(s) inherited by position-anchor`, inherited === 0,
    `  before:\n${showCat(c1)}\n  after:\n${showCat(c2)}`, true);
}

/* N4: a SOURCE test replaced in place by a one-render loop (new title, template body). */
{
  const p = fixture('n4', { 'tests/a.spec.ts': "import { test } from '@playwright/test';\n\ntest('login works', async () => { const x = 1; });\n" });
  const c1 = discover(p);
  write(p.root, { 'tests/a.spec.ts': "import { test } from '@playwright/test';\n\nfor (const q of ['x']) test(`search ${q}`, async () => { const y = q; });\n" });
  const c2 = discover(p, c1.registry);
  const got = c2.tests[0];
  report('N4', 'a source test replaced in place by a one-render loop with a new title: does it inherit the old uid?',
    `uid != ${c1.tests[0].uid}`, `uid=${got?.uid} basis=${got?.uidBasis}`, got?.uid !== c1.tests[0].uid,
    `  before:\n${showCat(c1)}\n  after:\n${showCat(c2)}`, true);
}

console.log(`\nSUMMARY: ${failed} blocking check(s) failed`);
process.exitCode = failed ? 1 : 0;
