/**
 * ATS-202: the round-1 review counterexamples, kept reproducible.
 *
 * The reviewer of the first round drove the product's own `discoverTests()`
 * against the REAL Playwright CLI and printed EXPECTED vs ACTUAL for every
 * counterexample. That probe is kept HERE so that the finding stays
 * reproducible: a change that reintroduces one of them fails this script.
 *
 * Usage: node tools/ats202-probes/review-round1-probe.mjs <tree-root> <node_modules-with-@playwright/test>
 *
 * Exit 0 when every counterexample is fixed, 1 when one of them is back,
 * 2 when the real Playwright is not available (SKIPPED -- never a pass).
 */
// Drives the product's own discoverTests() against the REAL Playwright CLI.
// Each CE prints EXPECTED vs ACTUAL and VERDICT (OK = the claim holds, FAIL = counterexample).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The tree defaults to THIS repository, so the probe can be run from
// anywhere: `node tools/ats202-probes/review-round1-probe.mjs <node_modules>`.
// A tree given as the first argument wins, so the probe can also be run
// against an exported copy of the tree.
const [a, b] = process.argv.slice(2);
const tree = path.resolve(a && !a.includes('@playwright') && !fs.existsSync(path.join(a, '@playwright')) ? a : path.join(import.meta.dirname, '..', '..'));
const nm = path.resolve(a && !a.includes('@playwright') && !fs.existsSync(path.join(a, '@playwright')) ? b : a);
if (!nm || !fs.existsSync(path.join(nm, '@playwright', 'test'))) {
  console.error(`SKIPPED: ${nm ?? '(none)'} does not hold @playwright/test -- the probe needs the REAL Playwright CLI.`);
  console.error('usage: node review-round1-probe.mjs [tree-root] <node_modules-with-@playwright/test>');
  process.exit(2);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ats202-review-probe-'));
const imp = (rel) => import(pathToFileURL(path.join(tree, rel)).href);
const { discoverTests } = await imp('server/core.mjs');
const { withTrust, TRUST } = await imp('server/discovery/trust.mjs');
const { findTestUid, emptyRegistry } = await imp('server/uid.mjs');

let n = 0;
const created = [];
function fixture(name, files) {
  const root = path.join(scratch, `${name}-${process.pid}-${n++}`);
  created.push(root);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.cpSync(nm, path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"ce202","private":true}');
  fs.writeFileSync(path.join(root, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', retries: 0 });\n");
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const uid = 'proj_1_' + (Math.random().toString(16).slice(2) + '0'.repeat(24)).slice(0, 24);
  return { id: uid, uid, root };
}
const trusted = (p) => withTrust({}, p, { trust: TRUST.TRUSTED });
const untrusted = {};
const byTitle = (cat, t) => cat.tests.filter((x) => x.title === t);
const results = [];
function report(id, claim, expected, actual, ok, extra = '') {
  results.push({ id, ok });
  console.log(`\n[${id}] ${claim}\n  expected: ${expected}\n  actual:   ${actual}${extra ? `\n  detail:   ${extra}` : ''}\n  VERDICT:  ${ok ? 'OK' : 'FAIL (counterexample)'}`);
}

// ---------- CE-A: a case after a CLOSED describe block -> consistency must agree
{
  const p = fixture('ce-a', { 'tests/a.spec.ts': [
    "import { test } from '@playwright/test';",
    "test.describe('group', () => {",
    "  test('inside', async () => {});",
    "});",
    "test('after', async () => {});", ''].join('\n') });
  const cat = discoverTests(p, trusted(p), emptyRegistry());
  const c = cat.consistency;
  report('CE-A', 'consistency (与 CLI 发现结果一致的度量) agrees when both indexes see the same two cases',
    'discovery=authoritative, agrees=true, onlyStatic=[], onlyAuthoritative=[]',
    `discovery=${cat.discovery}, agrees=${c?.agrees}, onlyStatic=${JSON.stringify(c?.onlyStatic)}, onlyAuthoritative=${JSON.stringify(c?.onlyAuthoritative)}`,
    cat.discovery === 'authoritative' && c?.agrees === true, `warning: ${cat.warning}`);
}

// ---------- CE-B: describe modifiers (.serial / .skip / .only-free variants)
{
  const p = fixture('ce-b', { 'tests/b.spec.ts': [
    "import { test } from '@playwright/test';",
    "test.describe.serial('serial group', () => {",
    "  test('s1', async () => {});",
    "});",
    "test.describe.skip('skipped group', () => {",
    "  test('k1', async () => {});",
    "});", ''].join('\n') });
  const cat = discoverTests(p, trusted(p), emptyRegistry());
  const c = cat.consistency;
  report('CE-B', 'consistency agrees for test.describe.serial / test.describe.skip blocks',
    'agrees=true', `agrees=${c?.agrees}, onlyStatic=${JSON.stringify(c?.onlyStatic)}, onlyAuthoritative=${JSON.stringify(c?.onlyAuthoritative)}`,
    c?.agrees === true);
}

// ---------- CE-C: an escaped quote in a literal title -> UID must not move when the index switches
{
  const p = fixture('ce-c', { 'tests/c.spec.ts': [
    "import { test, expect } from '@playwright/test';",
    "test('user\\'s profile', async () => { expect(1).toBe(1); });",
    "test('other', async () => { expect(2).toBe(2); });", ''].join('\n') });
  const s = discoverTests(p, untrusted, emptyRegistry());
  const a = discoverTests(p, trusted(p), s.registry);
  const st = s.tests.find((t) => t.line === 2), at = a.tests.find((t) => t.line === 2);
  report('CE-C', '切换索引不改变已有 UID — literal case whose title contains an escaped quote',
    'static uid === authoritative uid',
    `static {title:${JSON.stringify(st?.title)}, uid:${st?.uid}} vs authoritative {title:${JSON.stringify(at?.title)}, uid:${at?.uid}, basis:${at?.uidBasis}}`,
    st && at && st.uid === at.uid);
}

// ---------- CE-D: a literal title longer than 180 characters
{
  const long = 'checkout ' + 'x'.repeat(190);
  const p = fixture('ce-d', { 'tests/d.spec.ts': [
    "import { test, expect } from '@playwright/test';",
    `test('${long}', async () => { expect(3).toBe(3); });`, ''].join('\n') });
  const s = discoverTests(p, untrusted, emptyRegistry());
  const a = discoverTests(p, trusted(p), s.registry);
  report('CE-D', '切换索引不改变已有 UID — literal case with a >180-char title',
    'static uid === authoritative uid',
    `static ${s.tests[0]?.uid} (title len ${s.tests[0]?.title.length}) vs authoritative ${a.tests[0]?.uid} (title len ${a.tests[0]?.title.length}, basis ${a.tests[0]?.uidBasis})`,
    s.tests[0]?.uid === a.tests[0]?.uid);
}

// ---------- CE-E1: one-instance template; authoritative -> static (trust revoked / listing failed)
{
  const p = fixture('ce-e1', { 'tests/e.spec.ts': [
    "import { test, expect } from '@playwright/test';",
    "for (const n of ['alpha']) {",
    "  test(`dynamic ${n}`, async () => { expect(n).toBeTruthy(); });",
    "}", ''].join('\n') });
  const fresh = discoverTests(p, untrusted, emptyRegistry());
  const a = discoverTests(p, trusted(p), emptyRegistry());
  const s = discoverTests(p, untrusted, a.registry);
  const alpha = byTitle(a, 'dynamic alpha')[0];
  const tplFresh = fresh.tests[0], tplAfter = s.tests[0];
  report('CE-E1', 'static index after an authoritative one: the TEMPLATE case must not inherit the UID of a rendered dynamic case',
    `template uid === fresh static uid (${tplFresh?.uid}) and !== 'dynamic alpha' uid (${alpha?.uid})`,
    `template uid after auth = ${tplAfter?.uid} (uidSource=${tplAfter?.uidSource})`,
    tplAfter?.uid === tplFresh?.uid && tplAfter?.uid !== alpha?.uid);
}

// ---------- CE-E2: two-instance template; authoritative -> static must not raise a registry conflict
{
  const p = fixture('ce-e2', { 'tests/e.spec.ts': [
    "import { test, expect } from '@playwright/test';",
    "for (const n of ['alpha', 'beta']) {",
    "  test(`dynamic ${n}`, async () => { expect(n).toBeTruthy(); });",
    "}", ''].join('\n') });
  const fresh = discoverTests(p, untrusted, emptyRegistry());
  const a = discoverTests(p, trusted(p), emptyRegistry());
  const s = discoverTests(p, untrusted, a.registry);
  const hasConflict = /注册表记录与本次发现不一致/.test(s.warning);
  report('CE-E2', 'static index after an authoritative one: no spurious registry conflict for the template case',
    'warning has no 注册表记录与本次发现不一致 (fresh static has none)',
    `fresh conflict=${/注册表记录与本次发现不一致/.test(fresh.warning)}, after-auth conflict=${hasConflict}`,
    !hasConflict, `after-auth warning: ${s.warning}`);
}

// ---------- CE-F: a TRUSTED project that explicitly asks for the static index
{
  const p = fixture('ce-f', { 'tests/f.spec.ts': "import { test } from '@playwright/test';\ntest('f', async () => {});\n" });
  const cat = discoverTests(p, trusted(p), emptyRegistry(), { authoritative: false });
  report('CE-F', 'a trusted project with ?authoritative=false is not reported as untrusted',
    "outcome !== 'SKIPPED_UNTRUSTED' and warning does not say 未可信仓库不可调用",
    `trust=${cat.trust.trust}, outcome=${cat.authoritative.outcome}, reason=${JSON.stringify(cat.authoritative.reason)}`,
    cat.authoritative.outcome !== 'SKIPPED_UNTRUSTED' && !/未可信仓库不可调用/.test(cat.warning), `warning: ${cat.warning}`);
}

// ---------- CE-G (control): run binding of dynamic cases against the authoritative registry
{
  const p = fixture('ce-g', { 'tests/g.spec.ts': [
    "import { test, expect } from '@playwright/test';",
    "for (const n of ['alpha', 'beta']) {",
    "  test(`dynamic ${n}`, async () => { expect(n).toBeTruthy(); });",
    "}", ''].join('\n') });
  const a = discoverTests(p, trusted(p), emptyRegistry());
  const beta = byTitle(a, 'dynamic beta')[0];
  const hit = findTestUid(a.registry, a.projectUid, { file: 'tests/g.spec.ts', title: 'dynamic beta', line: beta.line });
  report('CE-G', '(control) a run result for a dynamic case binds to its own authoritative UID',
    `uid=${beta.uid}`, `uid=${hit.uid} basis=${hit.basis}`, hit.uid === beta.uid);
}

// ---------- CE-H (control): retitle of a source case under the authoritative index keeps its UID
{
  const p = fixture('ce-h', { 'tests/h.spec.ts': "import { test, expect } from '@playwright/test';\ntest('old name', async () => { expect(42).toBe(42); });\n" });
  const a1 = discoverTests(p, trusted(p), emptyRegistry());
  fs.writeFileSync(path.join(p.root, 'tests/h.spec.ts'), "import { test, expect } from '@playwright/test';\ntest('new name', async () => { expect(42).toBe(42); });\n");
  const a2 = discoverTests(p, trusted(p), a1.registry);
  report('CE-H', '(control) a retitled source case keeps its UID under the authoritative index',
    `uid=${a1.tests[0].uid}`, `uid=${a2.tests[0].uid} source=${a2.tests[0].uidSource}`, a1.tests[0].uid === a2.tests[0].uid);
}

// ---------- CE-I: multi-line test( call -> is it still a SOURCE case (rename tracking)?
{
  const body = (t) => ["import { test, expect } from '@playwright/test';", 'test(', `  '${t}',`, '  async () => { expect(7).toBe(7); }', ');', ''].join('\n');
  const p = fixture('ce-i', { 'tests/i.spec.ts': body('multi line old') });
  const a1 = discoverTests(p, trusted(p), emptyRegistry());
  fs.writeFileSync(path.join(p.root, 'tests/i.spec.ts'), body('multi line new'));
  const a2 = discoverTests(p, trusted(p), a1.registry);
  const s0 = discoverTests(p, untrusted, emptyRegistry());
  report('CE-I', 'a retitled source case written as a multi-line test( call keeps its UID under the authoritative index (static does)',
    `uid=${a1.tests[0].uid}`, `uid=${a2.tests[0].uid} source=${a2.tests[0].uidSource}; CLI line=${a2.tests[0].line}, scanner line=${s0.tests[0]?.line}`,
    a1.tests[0].uid === a2.tests[0].uid);
}

const failed = results.filter((r) => !r.ok).map((r) => r.id);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} OK; counterexamples: ${failed.join(', ') || 'none'}`);
// Remove ONLY the fixture directories this probe created; the scratch dir itself is left alone.
for (const d of created) fs.rmSync(d, { recursive: true, force: true });
fs.rmSync(scratch, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
