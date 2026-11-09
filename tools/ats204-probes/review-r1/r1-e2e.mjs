#!/usr/bin/env node
/**
 * ATS-204 review round 1 -- end-to-end probe against the REAL Playwright CLI.
 *
 * Drives the product's own discoverTests() (trusted project -> authoritative
 * `--list`), parseReport() and attemptsForRun() exactly as the Bridge does.
 *
 * Usage: node r1-e2e.mjs <tree-root> <node_modules with @playwright/test 1.64.1> <scratch-dir>
 * Exit 1 when any counterexample holds. Controls are reported but never fail.
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
function fixture(name, files, projects = 1) {
  const root = path.join(scratch, `${name}-${n++}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.cpSync(nm, path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"r1e2e","private":true}');
  const proj = projects === 1 ? '' : `, projects: [${Array.from({ length: projects }, (_, i) => `{ name: 'p${i}' }`).join(', ')}]`;
  fs.writeFileSync(path.join(root, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', retries: 0, workers: 1${proj} });\n`);
  write(root, files);
  const uid = 'proj_1_' + (Math.random().toString(16).slice(2) + '0'.repeat(24)).slice(0, 24);
  return { id: uid, uid, root };
}
function write(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}
const trusted = (p) => withTrust({}, p, { trust: TRUST.TRUSTED });
const discover = (p, reg) => {
  const cat = discoverTests(p, trusted(p), reg ?? emptyRegistry());
  if (cat.discovery !== 'authoritative') throw new Error(`not authoritative: ${cat.warning}`);
  return cat;
};
const uidOf = (cat, title) => cat.tests.filter((t) => t.title === title).map((t) => t.uid);
const showCat = (cat) => cat.tests.map((t) => `    ${JSON.stringify(t.title)} line=${t.line} scope=${JSON.stringify(t.describePath)} uid=${t.uid} basis=${t.uidBasis}${t.anchor ? ` anchor=#${t.anchor.ordinal}/${t.anchor.count}` : ''}${t.ambiguity ? ' amb=' + t.ambiguity.reason : ''}`).join('\n');
function runReport(p, file = null) {
  const out = path.join(p.root, 'report.json');
  fs.rmSync(out, { force: true });
  const args = [path.join(p.root, 'node_modules/@playwright/test/cli.js'), 'test', '--reporter=json'];
  if (file) args.push(file);
  spawnSync(process.execPath, args, { cwd: p.root, encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: out } });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

let failed = 0;
function report(id, claim, expected, actual, ok, detail = '', control = false) {
  if (!ok && !control) failed++;
  console.log(`\n[${id}] ${claim}\n  expected: ${expected}\n  actual:   ${actual}${detail ? `\n${detail}` : ''}\n  VERDICT:  ${ok ? 'OK' : control ? 'DIFFERS (control, informational)' : 'FAIL (counterexample)'}`);
}

const loop = (names, tpl = 'user ${u}') => [
  "import { test, expect } from '@playwright/test';",
  '',
  `for (const u of ${JSON.stringify(names)}) {`,
  `  test(\`${tpl}\`, async () => { expect(u.length).toBeGreaterThan(0); });`,
  '}', ''].join('\n');

/* E1: one loop element replaced (bob -> dave); alice and carol untouched. */
{
  const p = fixture('e1', { 'tests/u.spec.ts': loop(['alice', 'bob', 'carol']) });
  const c1 = discover(p);
  write(p.root, { 'tests/u.spec.ts': loop(['alice', 'dave', 'carol']) });
  const c2 = discover(p, c1.registry);
  const carolKept = uidOf(c2, 'user carol')[0] === uidOf(c1, 'user carol')[0];
  const daveNotBob = uidOf(c2, 'user dave')[0] !== uidOf(c1, 'user bob')[0];
  report('E1', 'loop data bob->dave: the UNCHANGED render (carol) keeps its uid; dave does not inherit bob or carol',
    `carol=${uidOf(c1, 'user carol')[0]}, dave!=bob`, `carol=${uidOf(c2, 'user carol')[0]}, dave=${uidOf(c2, 'user dave')[0]}`,
    carolKept && daveNotBob, `  before:\n${showCat(c1)}\n  after:\n${showCat(c2)}`);
}

/* E2: loop data reordered (titles unchanged). */
{
  const p = fixture('e2', { 'tests/u.spec.ts': loop(['bob', 'alice']) });
  const c1 = discover(p);
  write(p.root, { 'tests/u.spec.ts': loop(['alice', 'bob']) });
  const c2 = discover(p, c1.registry);
  const ok = uidOf(c2, 'user alice')[0] === uidOf(c1, 'user alice')[0] && uidOf(c2, 'user bob')[0] === uidOf(c1, 'user bob')[0];
  report('E2', 'loop data reordered: every render keeps its own uid', 'unchanged uids', ok ? 'unchanged' : 'swapped', ok,
    `  before:\n${showCat(c1)}\n  after:\n${showCat(c2)}`);
}

/* E3: a new test inserted directly ABOVE an existing one. */
{
  const before = ["import { test, expect } from '@playwright/test';", '',
    "test('login works', async () => { expect('/login').toContain('login'); });", ''].join('\n');
  const after = ["import { test, expect } from '@playwright/test';", '',
    "test('search finds item', async () => { expect('q').toBe('q'); });", '',
    "test('login works', async () => { expect('/login').toContain('login'); });", ''].join('\n');
  const p = fixture('e3', { 'tests/a.spec.ts': before });
  const c1 = discover(p);
  write(p.root, { 'tests/a.spec.ts': after });
  const c2 = discover(p, c1.registry);
  const kept = uidOf(c2, 'login works')[0] === uidOf(c1, 'login works')[0];
  const noSteal = uidOf(c2, 'search finds item')[0] !== uidOf(c1, 'login works')[0];
  report('E3', 'insert a new test above an existing one: the EXISTING test keeps its uid (old evidence stays linked)',
    `login works=${uidOf(c1, 'login works')[0]}`, `login works=${uidOf(c2, 'login works')[0]}, new=${uidOf(c2, 'search finds item')[0]}`,
    kept && noSteal, `  before:\n${showCat(c1)}\n  after:\n${showCat(c2)}`);
}

/* E4: a test replaced in place by a different test (new title, new body). */
{
  const before = ["import { test, expect } from '@playwright/test';", '',
    "test('login works', async () => { expect('/login').toContain('login'); });", ''].join('\n');
  const after = ["import { test, expect } from '@playwright/test';", '',
    "test('search finds item', async () => { expect('q').toBe('q'); });", ''].join('\n');
  const p = fixture('e4', { 'tests/a.spec.ts': before });
  const c1 = discover(p);
  write(p.root, { 'tests/a.spec.ts': after });
  const c2 = discover(p, c1.registry);
  const ok = uidOf(c2, 'search finds item')[0] !== uidOf(c1, 'login works')[0];
  report('E4', 'a test replaced by a different test (new title + new body): new identity (doc 26 §7 / ATS-201 boundary)',
    `uid != ${uidOf(c1, 'login works')[0]}`, `uid = ${uidOf(c2, 'search finds item')[0]}`, ok,
    `  before:\n${showCat(c1)}\n  after:\n${showCat(c2)}`);
}

/* E5 (control): the executor's positive claim -- template re-worded, every title changes. */
{
  const p = fixture('e5', { 'tests/u.spec.ts': loop(['1', '2'], 'adds ${u} item') }, 2);
  const c1 = discover(p);
  write(p.root, { 'tests/u.spec.ts': loop(['1', '2'], 'adds ${u} item to the cart') });
  const c2 = discover(p, c1.registry);
  const ok = uidOf(c2, 'adds 1 item to the cart')[0] === uidOf(c1, 'adds 1 item')[0]
    && uidOf(c2, 'adds 2 item to the cart')[0] === uidOf(c1, 'adds 2 item')[0];
  const counts = c1.tests.map((t) => t.anchor?.count);
  report('E5', 'control: re-worded template keeps uids (2 Playwright projects; anchor count = renders, not rows)',
    'uids kept; anchor counts [2,2]', `${ok ? 'kept' : 'lost'}; anchor counts ${JSON.stringify(counts)}`,
    ok && counts.every((x) => x === 2), `  before:\n${showCat(c1)}\n  after:\n${showCat(c2)}`, true);
}

/* E6 (fact): is the anchor ordinal the GENERATION order (doc 26 §4.1) or the catalogue's sort order? */
{
  const p = fixture('e6', { 'tests/u.spec.ts': loop(['zed', 'amy']) });
  const c1 = discover(p);
  const zed = c1.tests.find((t) => t.title === 'user zed');
  report('E6', "doc 26 §4.1/identity.mjs: the ordinal is the order the template GENERATED the renders in ('zed' first)",
    'user zed ordinal 0', `user zed ordinal ${zed?.anchor?.ordinal}`, zed?.anchor?.ordinal === 0, `${showCat(c1)}`);
}

/* M1/M2: the matrix caseKey drops the describe path. Same test title, same line, two describes. */
const describeLoop = ["import { test, expect } from '@playwright/test';", '',
  "for (const n of ['a', 'b']) {",
  '  test.describe(n, () => {',
  "    test('works', async () => { expect(n).toBe('a'); });",
  '  });',
  '}', ''].join('\n');
for (const [id, projects] of [['M1', 1], ['M2', 2]]) {
  const p = fixture(id.toLowerCase(), { 'tests/d.spec.ts': describeLoop }, projects);
  const cat = discover(p);
  const raw = runReport(p);
  const s = parseReport(raw);
  const expect = 'total=2 passed=1 failed=1';
  const actual = `total=${s.total} passed=${s.passed} failed=${s.failed}`;
  report(id, `${projects} project(s): 'a > works' passes, 'b > works' fails -> two cases, one failed`,
    expect, actual, actual === expect, `  catalogue: ${cat.tests.length} cases\n${showCat(cat)}`);
  if (id === 'M1') {
    const run = { id: 'run_1_0123456789abcdef01234567', uid: 'run_1_0123456789abcdef01234567', projectId: p.id, projectUid: p.uid, projectRoot: p.root };
    const atts = attemptsForRun(run, s, cat.registry);
    const uids = [...new Set(atts.map((a) => a.testUid))];
    report('M1b', "attemptsForRun: the attempts of 'a > works' and 'b > works' are not merged into one case",
      '2 cases, 1 attempt each', `${s.cases.length} case(s) carrying ${atts.length} attempt(s) [retries ${JSON.stringify(atts.map((a) => a.retry))}], testUids=${JSON.stringify(uids)}, statuses=${JSON.stringify(atts.map((a) => a.status))}`,
      s.cases.length === 2, '');
    const hasScope = s.cases.some((c) => Object.prototype.hasOwnProperty.call(c, 'scope') || Object.prototype.hasOwnProperty.call(c, 'describePath'));
    report('S1', 'doc 26 §3 signal 2 (file-scope-title) is reachable: parseReport carries the describe path to attemptsForRun',
      'cases carry scope', hasScope ? 'cases carry scope' : `no case carries scope/describePath (keys: ${Object.keys(s.cases[0] ?? {}).join(',')})`, hasScope, '');
  }
}

/* X1: the same @TC token in two files (catalogue: neither owns it); a run of ONE file binds it. */
{
  const p = fixture('x1', {
    'tests/a.spec.ts': "import { test } from '@playwright/test';\n\ntest('checkout @TC-001', async () => {});\n",
    'tests/b.spec.ts': "import { test } from '@playwright/test';\n\ntest('refund @TC-001', async () => {});\n",
  });
  const cat = discover(p);
  const raw = runReport(p, 'tests/b.spec.ts');
  const s = parseReport(raw);
  const run = { id: 'run_1_0123456789abcdef01234568', uid: 'run_1_0123456789abcdef01234568', projectId: p.id, projectUid: p.uid, projectRoot: p.root };
  const atts = attemptsForRun(run, s, cat.registry);
  const catUids = cat.tests.map((t) => `${t.title}:${t.uid}(${t.ambiguity?.reason ?? t.uidBasis})`).join(', ');
  const bound = atts.map((a) => `${a.title}:${a.testUid}(${a.uidBasis})`).join(', ');
  report('X1', 'catalogue says @TC-001 is duplicated (owned by neither); a single-file run must not bind it to one of them',
    'attempt unbound / explicit-ambiguous', bound, atts.every((a) => !a.testUid), `  catalogue: ${catUids}`);
}

console.log(`\nSUMMARY: ${failed} counterexample(s) hold`);
process.exitCode = failed ? 1 : 0;
