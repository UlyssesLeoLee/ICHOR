/**
 * ATS-202: the regression tests of the ROUND-1 review findings.
 *
 * Every test here corresponds to a counterexample that the round-1 reviewer
 * drove against the delivered tree with the REAL Playwright CLI. Each one
 * failed then; each one has to pass now.
 *
 * | test    | the counterexample it pins down                              |
 * |---------|---------------------------------------------------------------|
 * | CE-A    | a case AFTER a closed `describe` was reported as a difference  |
 * | CE-B    | `describe.serial` / `describe.skip` were reported as a difference |
 * | CE-C    | an escaped quote in a title moved the UID when the index switched |
 * | CE-D    | a title longer than 180 characters moved the UID              |
 * | CE-E1   | the template of a dynamic case inherited a rendered case's UID  |
 * | CE-E2   | the same template raised a bogus registry conflict             |
 * | CE-F    | a TRUSTED project that asked for the static index was reported as untrusted |
 * | CE-I    | a multi-line `test(` call lost its UID when it was retitled    |
 *
 * The tests that need the REAL CLI live in `tests/discovery-it.test.mjs`;
 * the ones here are the PURE parts -- the lexical reader, the identity
 * ladder, the trust decision -- and they run without any dependency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanTestCases, deriveTestUid, normalizeTitleKey, bodyKeyOf, resolveIdentities } from '../server/uid.mjs';
import { describePathAt, compareDiscoveries, staticCasesWithScope, caseKey, readBodies } from '../server/discovery/index.mjs';
import { resolveAuthoritativeIdentities } from '../server/discovery/authoritative.mjs';
import { TRUST, withTrust } from '../server/discovery/trust.mjs';
import { discoverTests } from '../server/core.mjs';

const PROJECT_UID = 'proj_1_0123456789abcdef01234567';

/** A temporary project directory with one spec file. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats202-reg-'));
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body, 'utf8');
  }
  return { id: PROJECT_UID, uid: PROJECT_UID, root };
}

/* ------------------------------------------------------------------ */
/* CE-A / CE-B: the describe scope                                     */
/* ------------------------------------------------------------------ */

test('CE-A: a case after a CLOSED describe block is not inside the block', () => {
  // The block is closed on line 4, so the case on line 5 is OUTSIDE it.
  // The old reader only ever pushed a title, so it reported `group > after`
  // while the CLI reports `after` -- and the consistency report then claimed
  // that the CLI does not enumerate a case it does enumerate.
  const content = [
    "import { test } from '@playwright/test';",
    "test.describe('group', () => {",
    "  test('inside', async () => {});",
    "});",
    "test('after', async () => {});",
    ''
  ].join('\n');
  assert.deepEqual(describePathAt(content, 3), ['group'], 'the case inside the block');
  assert.deepEqual(describePathAt(content, 5), [], 'the case after the closed block');
});

test('CE-A: the consistency of the two indexes agrees on a closed describe', () => {
  // The two indexes see the SAME two cases, so they agree.
  const p = fixture({ 'tests/a.spec.ts': [
    "import { test } from '@playwright/test';",
    "test.describe('group', () => {",
    "  test('inside', async () => {});",
    "});",
    "test('after', async () => {});",
    ''
  ].join('\n') });
  try {
    const statics = staticCasesWithScope(p.root, ['tests/a.spec.ts']);
    // The CLI numbers the `test(` CALL, so the authoritative side carries
    // the same line the scanner reports. The comparison matches on the
    // POSITION (see `matchKey`), not on the describe path.
    const authoritative = [
      { file: 'tests/a.spec.ts', describePath: ['group'], title: 'inside', line: 3 },
      { file: 'tests/a.spec.ts', describePath: [], title: 'after', line: 5 }
    ];
    const c = compareDiscoveries(authoritative, statics);
    assert.equal(c.agrees, true, JSON.stringify(c));
    assert.deepEqual(c.onlyStatic, []);
    assert.deepEqual(c.onlyAuthoritative, []);
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test('CE-A: the case after the closed block carries NO describe path', () => {
  // The readable key shows the describe path, so a case that is OUTSIDE the
  // block must not carry the block's title -- otherwise the report says
  // `group > after` while the CLI says `after`.
  const p = fixture({ 'tests/a.spec.ts': [
    "import { test } from '@playwright/test';",
    "test.describe('group', () => {",
    "  test('inside', async () => {});",
    "});",
    "test('after', async () => {});",
    ''
  ].join('\n') });
  try {
    const statics = staticCasesWithScope(p.root, ['tests/a.spec.ts']);
    const after = statics.find((s) => s.title === 'after');
    assert.ok(after, 'the case after the block is found');
    assert.deepEqual(after.describePath, [], 'the closed block is not on its path');
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test('CE-B: the describe MODIFIERS are part of the describe path', () => {
  // `test.describe.serial(...)` and `test.describe.skip(...)` are describe
  // blocks as far as the CLI is concerned: it reports the block's title as
  // part of the case's describe path. The old reader only recognised a
  // plain `describe(`, so every case under a modified block looked like a
  // case only the authoritative index could see.
  const content = [
    "import { test } from '@playwright/test';",
    "test.describe.serial('serial group', () => {",
    "  test('s1', async () => {});",
    "});",
    "test.describe.skip('skipped group', () => {",
    "  test('k1', async () => {});",
    "});",
    "test.describe.parallel('parallel group', () => {",
    "  test('p1', async () => {});",
    "});",
    ''
  ].join('\n');
  assert.deepEqual(describePathAt(content, 3), ['serial group']);
  assert.deepEqual(describePathAt(content, 6), ['skipped group']);
  assert.deepEqual(describePathAt(content, 9), ['parallel group']);
});

test('CE-B: the consistency of the two indexes agrees on modified describes', () => {
  const p = fixture({ 'tests/b.spec.ts': [
    "import { test } from '@playwright/test';",
    "test.describe.serial('serial group', () => {",
    "  test('s1', async () => {});",
    "});",
    "test.describe.skip('skipped group', () => {",
    "  test('k1', async () => {});",
    "});",
    ''
  ].join('\n') });
  try {
    const statics = staticCasesWithScope(p.root, ['tests/b.spec.ts']);
    const authoritative = [
      { file: 'tests/b.spec.ts', describePath: ['serial group'], title: 's1', line: 3 },
      { file: 'tests/b.spec.ts', describePath: ['skipped group'], title: 'k1', line: 6 }
    ];
    const c = compareDiscoveries(authoritative, statics);
    assert.equal(c.agrees, true, JSON.stringify(c));
    assert.deepEqual(c.onlyStatic, []);
    assert.deepEqual(c.onlyAuthoritative, []);
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test('CE-B: the describe MODIFIERS are part of the readable key', () => {
  // The readable key (`caseKey`) shows the describe path, and a modified
  // describe is a describe block as far as the CLI is concerned.
  const p = fixture({ 'tests/b.spec.ts': [
    "import { test } from '@playwright/test';",
    "test.describe.serial('serial group', () => {",
    "  test('s1', async () => {});",
    "});",
    ''
  ].join('\n') });
  try {
    const statics = staticCasesWithScope(p.root, ['tests/b.spec.ts']);
    assert.deepEqual(statics[0].describePath, ['serial group']);
    assert.equal(caseKey(statics[0]), 'tests/b.spec.ts serial group s1');
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test('CE-A: a brace inside a string does not close the describe block', () => {
  // The braces are counted with the restricted lexer, so a brace inside a
  // string is not a brace.
  const content = [
    "import { test } from '@playwright/test';",
    "test.describe('group', () => {",
    "  test('a } brace', async () => {});",
    "});",
    "test('after', async () => {});",
    ''
  ].join('\n');
  assert.deepEqual(describePathAt(content, 3), ['group']);
  assert.deepEqual(describePathAt(content, 5), []);
});

/* ------------------------------------------------------------------ */
/* N3: the describe block whose callback is not a plain arrow           */
/* ------------------------------------------------------------------ */

test('N3: a describe with a DETAILS object opens its scope at the CALLBACK body', () => {
  // `describe('tagged', { tag: '@smoke' }, () => {...})` -- the details
  // object opens a brace of its own, and it closes again right away. If
  // the scope were tied to that brace, the block would be closed
  // immediately and the case inside it would fall out of the path.
  const content = [
    "import { test } from '@playwright/test';",
    "test.describe('tagged', { tag: '@smoke' }, () => {",
    "  test('inside tagged', async () => {});",
    "});",
    "test('after tagged', async () => {});",
    ''
  ].join('\n');
  assert.deepEqual(describePathAt(content, 3), ['tagged'], 'the case inside the block');
  assert.deepEqual(describePathAt(content, 5), [], 'the case after the block');
});

test('N3: a describe whose callback takes an ARGUMENT still opens its scope', () => {
  // `describe('group', (args) => {...})` -- the arrow is followed by a
  // parameter list, so the body brace is not the next character.
  const content = [
    "import { test } from '@playwright/test';",
    "test.describe('group', (fixture) => {",
    "  test('inside', async () => {});",
    "});",
    "test('after', async () => {});",
    ''
  ].join('\n');
  assert.deepEqual(describePathAt(content, 3), ['group']);
  assert.deepEqual(describePathAt(content, 5), []);
});

test('N3: a describe whose callback is a FUNCTION EXPRESSION opens no scope', () => {
  // A lexical reader cannot tell where a function expression's block ends,
  // and a WRONG scope is worse than none: it would be a false difference
  // in the consistency report.
  const content = [
    "import { test } from '@playwright/test';",
    "test.describe('group', function () {",
    "  test('inside', async () => {});",
    "});",
    ''
  ].join('\n');
  assert.deepEqual(describePathAt(content, 3), [], 'no scope is opened');
});

test('N3: a describe with a details object and an argument list opens its scope', () => {
  // Both at once: the details object AND a parameter list.
  const content = [
    "import { test } from '@playwright/test';",
    "test.describe('tagged', { tag: '@smoke' }, (fixture) => {",
    "  test('inside tagged', async () => {});",
    "});",
    ''
  ].join('\n');
  assert.deepEqual(describePathAt(content, 3), ['tagged']);
});

test('N3: the describe scope survives a NESTED describe', () => {
  // The inner block closes first; the outer one must survive it.
  const content = [
    "import { test } from '@playwright/test';",
    "test.describe('outer', () => {",
    "  test.describe('inner', () => {",
    "    test('deep', async () => {});",
    "  });",
    "  test('shallow', async () => {});",
    "});",
    "test('after', async () => {});",
    ''
  ].join('\n');
  assert.deepEqual(describePathAt(content, 4), ['outer', 'inner']);
  assert.deepEqual(describePathAt(content, 6), ['outer']);
  assert.deepEqual(describePathAt(content, 8), []);
});

test('N3: a describe with a COMMENT between the title and the callback opens its scope', () => {
  // The reader skips the comment, so the arrow is still found.
  const content = [
    "import { test } from '@playwright/test';",
    "test.describe('group', /* the callback */ () => {",
    "  test('inside', async () => {});",
    "});",
    ''
  ].join('\n');
  assert.deepEqual(describePathAt(content, 3), ['group']);
});

test('N3: a describe whose title is a TEMPLATE LITERAL opens a scope with the RAW title', () => {
  // The reader can see the template literal, but it cannot RENDER it: the
  // CLI reports `area cart`, the reader reports `area ${area}`. The scope
  // is still opened -- the case IS inside the block -- but the path differs
  // from the CLI's, which is exactly why the comparison matches on the
  // POSITION and not on the describe path (see docs/23 §5.2).
  const content = [
    "import { test } from '@playwright/test';",
    "const area = 'cart';",
    "test.describe(`area ${area}`, () => {",
    "  test('adds', async () => {});",
    "});",
    "test('after', async () => {});",
    ''
  ].join('\n');
  assert.deepEqual(describePathAt(content, 4), ['area ${area}'], 'the raw title, not the rendered one');
  assert.deepEqual(describePathAt(content, 6), [], 'the case after the block');
});

test('N3: a describe whose title is a VARIABLE opens no scope', () => {
  // The title lives in a variable, so there is no literal to read at all.
  // No scope is opened -- a lexical reader cannot invent the title.
  const content = [
    "import { test } from '@playwright/test';",
    "const suite = 'checkout';",
    "test.describe(suite, () => {",
    "  test('pays', async () => {});",
    "});",
    "test('after', async () => {});",
    ''
  ].join('\n');
  assert.deepEqual(describePathAt(content, 4), [], 'no scope is opened');
  assert.deepEqual(describePathAt(content, 6), []);
});

/* ------------------------------------------------------------------ */
/* the files that cannot be read                                       */
/* ------------------------------------------------------------------ */

test('N3: a file that cannot be read is skipped, not fatal', () => {
  // The static index is handed a list of files; one of them may be gone by
  // the time it is read (a branch switch). The index must not fall over.
  const p = fixture({ 'tests/ok.spec.ts': "import { test } from '@playwright/test';\ntest('ok', async () => {});\n" });
  try {
    const statics = staticCasesWithScope(p.root, ['tests/ok.spec.ts', 'tests/gone.spec.ts']);
    assert.equal(statics.length, 1);
    assert.equal(statics[0].title, 'ok');
    const bodies = readBodies(p.root, ['tests/ok.spec.ts', 'tests/gone.spec.ts']);
    assert.equal(bodies.size, 1);
    assert.ok(bodies.has('tests/ok.spec.ts 2'));
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* CE-C / CE-D / CE-I: the title and the line of a source case        */
/* ------------------------------------------------------------------ */

test('CE-C: an escaped quote in a title is read as the title MEANS', () => {
  // `test('user\'s profile')` is the title `user's profile`. The old
  // scanner cut the title at the first quote -- escaped or not -- so it read
  // `user\`, a title the CLI never reports.
  const cases = scanTestCases([
    "import { test } from '@playwright/test';",
    "test('user\\'s profile', async () => { expect(1).toBe(1); });",
    "test('other', async () => {});",
    ''
  ].join('\n'));
  assert.equal(cases.length, 2);
  assert.equal(cases[0].title, "user's profile");
  assert.equal(cases[1].title, 'other');
});

test('CE-C: the title key of an escaped-quote case is the one the CLI reports', () => {
  const cases = scanTestCases([
    "import { test } from '@playwright/test';",
    "test('user\\'s profile', async () => {});",
    ''
  ].join('\n'));
  const cliTitle = "user's profile";
  assert.equal(normalizeTitleKey(cases[0].title), normalizeTitleKey(cliTitle));
  assert.equal(
    deriveTestUid(PROJECT_UID, normalizeTitleKey(cases[0].title)),
    deriveTestUid(PROJECT_UID, normalizeTitleKey(cliTitle))
  );
});

test('CE-D: a title longer than 180 characters is NOT cut', () => {
  // The old scanner cut the title to 180 characters. The CLI reports the
  // WHOLE title, so the two indexes derived different UIDs from the same
  // case.
  const long = 'checkout ' + 'x'.repeat(190);
  const cases = scanTestCases([
    "import { test } from '@playwright/test';",
    `test('${long}', async () => {});`,
    ''
  ].join('\n'));
  assert.equal(cases.length, 1);
  assert.equal(cases[0].title.length, 199);
  assert.equal(cases[0].title, long);
});

test('CE-I: a multi-line `test(` call is found, and its LINE is the line of the CALL', () => {
  // The CLI numbers the CALL, not the whitespace in front of it and not the
  // title that sits on the next line.
  const cases = scanTestCases([
    "import { test } from '@playwright/test';",
    'test(',
    "  'multi line',",
    '  async () => { expect(7).toBe(7); }',
    ');',
    ''
  ].join('\n'));
  assert.equal(cases.length, 1);
  assert.equal(cases[0].title, 'multi line');
  assert.equal(cases[0].line, 2, 'the line of the call, not of the title');
});

test('CE-I: a multi-line `test(` call keeps its UID when it is retitled', () => {
  // The static index finds the case at the position the CLI reports, so the
  // body fingerprint decides and the UID survives the retitle.
  const source = (title) => [
    "import { test } from '@playwright/test';",
    'test(',
    `  '${title}',`,
    '  async () => { expect(7).toBe(7); }',
    ');',
    ''
  ].join('\n');
  const p = fixture({ 'tests/i.spec.ts': source('multi line old') });
  try {
    const before = scanTestCases(fs.readFileSync(path.join(p.root, 'tests/i.spec.ts'), 'utf8'));
    fs.writeFileSync(path.join(p.root, 'tests/i.spec.ts'), source('multi line new'), 'utf8');
    const after = scanTestCases(fs.readFileSync(path.join(p.root, 'tests/i.spec.ts'), 'utf8'));
    assert.equal(before[0].line, after[0].line, 'the call stays on the same line');
    assert.equal(
      bodyKeyOf(before[0].bodyText),
      bodyKeyOf(after[0].bodyText),
      'the body is unchanged, so the fingerprint decides'
    );
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test('the scanner still reads the ordinary forms', () => {
  // The rewrite must not lose what the old scanner found.
  const cases = scanTestCases([
    "import { test } from '@playwright/test';",
    "// test('in a comment', async () => {});",
    "const s = \"test('in a string')\";",
    "test('plain', async () => {});",
    "test.only('only case', async () => {});",
    "test.skip('skip case', async () => {});",
    "test.fixme('fixme case', async () => {});",
    "it('it case', async () => {});",
    "test(`template ${n}`, async () => {});",
    ''
  ].join('\n'));
  assert.deepEqual(cases.map((c) => c.title), [
    'plain', 'only case', 'skip case', 'fixme case', 'it case', 'template ${n}'
  ]);
});

/* ------------------------------------------------------------------ */
/* CE-E1 / CE-E2: the registry does not leak the dynamic cases        */
/* ------------------------------------------------------------------ */

test('CE-E1: a DYNAMIC case carries no body key into the registry', () => {
  // The body of a dynamic case is the body of its TEMPLATE. Storing that
  // fingerprint as the case's body key makes the template look like the
  // case -- the static index then hands the template the UID of a rendered
  // case.
  const resolved = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [{ file: 'tests/e.spec.ts', title: 'dynamic alpha', line: 3, describePath: [], projects: [] }],
    bodies: new Map([['tests/e.spec.ts 3', { title: 'dynamic ${n}', bodyText: 'await go();' }]]),
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/e.spec.ts'])
  });
  const entry = resolved.registry.entries[0];
  assert.equal(entry.bodyKey, null, 'the dynamic case stores no body key');
  // It is still identified: the UID, the file, the title and the line are
  // enough for the run binding to find it.
  assert.ok(entry.uid);
  assert.equal(entry.file, 'tests/e.spec.ts');
  assert.equal(entry.title, 'dynamic alpha');
  assert.equal(entry.line, 3);
});

test('CE-E1: a SOURCE case still carries its body key', () => {
  // The fix must not take the body key away from the cases that HAVE one:
  // the registry match on the body is what lets a case survive a retitle.
  const resolved = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [{ file: 'tests/e.spec.ts', title: 'plain case', line: 2, describePath: [], projects: [] }],
    bodies: new Map([['tests/e.spec.ts 2', { title: 'plain case', bodyText: 'await go();' }]]),
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/e.spec.ts'])
  });
  const entry = resolved.registry.entries[0];
  assert.ok(entry.bodyKey, 'the source case keeps its body key');
  assert.equal(entry.bodyKey, bodyKeyOf('await go();'));
});

test('CE-E2: the template does not inherit the UID of a rendered case', () => {
  // The static index reads the template as ONE case whose title is
  // `dynamic ${n}`. After an authoritative discovery, the static index must
  // still give the template ITS OWN uid -- not the uid of `dynamic alpha`.
  const p = fixture({ 'tests/e.spec.ts': [
    "import { test } from '@playwright/test';",
    "for (const n of ['alpha']) {",
    "  test(`dynamic ${n}`, async () => { expect(n).toBeTruthy(); });",
    "}",
    ''
  ].join('\n') });
  try {
    const registry = { version: 1, projects: {} };
    // The authoritative discovery: one rendered case, the template's body.
    const auth = resolveAuthoritativeIdentities({
      projectUid: PROJECT_UID,
      cases: [{ file: 'tests/e.spec.ts', title: 'dynamic alpha', line: 3, describePath: [], projects: [] }],
      bodies: new Map([['tests/e.spec.ts 3', { title: 'dynamic ${n}', bodyText: 'await go();' }]]),
      registry: { version: 1, entries: [] },
      scope: new Set(['tests/e.spec.ts'])
    });
    const alphaUid = auth.items[0].uid;

    // The static index over the SAME registry.
    const content = fs.readFileSync(path.join(p.root, 'tests/e.spec.ts'), 'utf8');
    const statics = scanTestCases(content);
    const resolvedStatic = resolveIdentities({
      projectUid: PROJECT_UID,
      discovered: statics.map((c) => ({ file: 'tests/e.spec.ts', ...c })),
      registry: { version: 1, projects: { [PROJECT_UID]: auth.registry } },
      scope: new Set(['tests/e.spec.ts'])
    });
    const template = resolvedStatic.items[0];
    assert.ok(template.uid);
    assert.notEqual(template.uid, alphaUid, 'the template did NOT inherit the rendered case UID');
    // And the fresh static UID is the same one -- the template is stable.
    const fresh = resolveIdentities({
      projectUid: PROJECT_UID,
      discovered: statics.map((c) => ({ file: 'tests/e.spec.ts', ...c })),
      registry: { version: 1, projects: {} },
      scope: new Set(['tests/e.spec.ts'])
    });
    assert.equal(template.uid, fresh.items[0].uid);
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test('CE-E2: the template raises NO registry conflict', () => {
  // A template that renders TWO cases used to match several registry
  // entries at once, and the static index reported a conflict that no user
  // could act on.
  const p = fixture({ 'tests/e.spec.ts': [
    "import { test } from '@playwright/test';",
    "for (const n of ['alpha', 'beta']) {",
    "  test(`dynamic ${n}`, async () => { expect(n).toBeTruthy(); });",
    "}",
    ''
  ].join('\n') });
  try {
    const auth = resolveAuthoritativeIdentities({
      projectUid: PROJECT_UID,
      cases: [
        { file: 'tests/e.spec.ts', title: 'dynamic alpha', line: 3, describePath: [], projects: [] },
        { file: 'tests/e.spec.ts', title: 'dynamic beta', line: 3, describePath: [], projects: [] }
      ],
      bodies: new Map([['tests/e.spec.ts 3', { title: 'dynamic ${n}', bodyText: 'await go();' }]]),
      registry: { version: 1, entries: [] },
      scope: new Set(['tests/e.spec.ts'])
    });
    const statics = scanTestCases(fs.readFileSync(path.join(p.root, 'tests/e.spec.ts'), 'utf8'));
    const resolvedStatic = resolveIdentities({
      projectUid: PROJECT_UID,
      discovered: statics.map((c) => ({ file: 'tests/e.spec.ts', ...c })),
      registry: { version: 1, projects: { [PROJECT_UID]: auth.registry } },
      scope: new Set(['tests/e.spec.ts'])
    });
    const template = resolvedStatic.items[0];
    assert.ok(template.uid, 'the template has a UID');
    assert.equal(template.registryConflict, undefined, 'no registry conflict was raised');
    assert.equal(template.ambiguity, undefined, 'no ambiguity was raised');
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* CE-F: the trust and the request are two different things             */
/* ------------------------------------------------------------------ */

test('CE-F: a TRUSTED project that asks for the static index is not reported as untrusted', () => {
  // The old code answered `SKIPPED_UNTRUSTED` with an empty reason and a
  // warning that said the project was not vouched for -- but it WAS.
  const p = fixture({ 'tests/f.spec.ts': "import { test } from '@playwright/test';\ntest('f', async () => {});\n" });
  try {
    const state = withTrust({}, p, { trust: TRUST.TRUSTED });
    const cat = discoverTests(p, state, { version: 1, projects: {} }, { authoritative: false });
    assert.equal(cat.discovery, 'static');
    assert.equal(cat.authoritative.outcome, 'NOT_REQUESTED');
    assert.equal(cat.authoritative.attempted, false);
    assert.equal(cat.authoritative.reason, '');
    assert.doesNotMatch(cat.warning, /未可信仓库不可调用/, 'the project is not told it is untrusted');
    assert.equal(cat.trust.trust, 'trusted');
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test('CE-F: an UNTRUSTED project still gets the trust gate', () => {
  const p = fixture({ 'tests/f.spec.ts': "import { test } from '@playwright/test';\ntest('f', async () => {});\n" });
  try {
    // The default request.
    const plain = discoverTests(p, {}, { version: 1, projects: {} });
    assert.equal(plain.authoritative.outcome, 'SKIPPED_UNTRUSTED');
    assert.match(plain.warning, /未可信仓库不可调用/);
    // The FORCED request: the trust still decides.
    const forced = discoverTests(p, {}, { version: 1, projects: {} }, { authoritative: true });
    assert.equal(forced.authoritative.outcome, 'SKIPPED_UNTRUSTED');
    assert.match(forced.warning, /未可信仓库不可调用/);
    assert.equal(forced.authoritative.attempted, false);
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});
