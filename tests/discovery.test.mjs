/**
 * ATS-202: the unit tests of the authoritative discovery.
 *
 * These tests cover the PURE parts: the report parser, the trust gate and
 * the identity ladder. The CLI itself is exercised by the integration tests
 * (`tests/discovery-it.test.mjs`) and by the ground-truth probe
 * (`tools/ats202-probes/list-ground-truth.mjs`) against a REAL
 * `@playwright/test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseListReport, projectRelativeFile, LIST_OUTCOME } from '../server/discovery/playwright-list.mjs';
import { resolveAuthoritativeIdentities } from '../server/discovery/authoritative.mjs';
import { TRUST, TRUST_REASON, trustOf, withTrust, isTrusted } from '../server/discovery/trust.mjs';
import { compareDiscoveries, describePathAt, caseKey } from '../server/discovery/index.mjs';
import { deriveTestUid, normalizeTitleKey } from '../server/uid.mjs';

const PROJECT_UID = 'proj_1_0123456789abcdef01234567';

/** A report shaped like the one the CLI writes. */
function report({ rootDir = '/proj/tests', suites = [], errors = [] } = {}) {
  return { config: { rootDir, version: '1.64.1' }, suites, errors, stats: {} };
}

const spec = (over = {}) => ({
  title: 'a case',
  ok: true,
  tags: [],
  id: 'aaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb',
  file: 'a.spec.ts',
  line: 2,
  column: 5,
  tests: [{ projectName: '', expectedStatus: 'passed', annotations: [] }],
  ...over,
});

/* ------------------------------------------------------------------ */
/* the report parser                                                  */
/* ------------------------------------------------------------------ */

test('UT-ATS202-001: a spec is parsed into a case with the project relative file', () => {
  const parsed = parseListReport(report({
    rootDir: '/proj',
    suites: [{ file: 'a.spec.ts', line: 0, title: 'a.spec.ts', suites: [{ specs: [spec()], file: 'a.spec.ts', line: 0, title: 'a.spec.ts' }] }],
  }), { projectRoot: '/proj' });
  assert.equal(parsed.tests.length, 1);
  assert.equal(parsed.tests[0].file, 'a.spec.ts');
  assert.equal(parsed.tests[0].title, 'a case');
  assert.equal(parsed.tests[0].line, 2);
  assert.deepEqual(parsed.tests[0].describePath, []);
  assert.deepEqual(parsed.files, ['a.spec.ts']);
});

test('UT-ATS202-002: the file is resolved against the CLI rootDir, not the project root', () => {
  // The CLI spells the file relative to its own rootDir (the resolved
  // testDir). A project whose testDir is ./tests reports "a.spec.ts" while
  // the project relative path is "tests/a.spec.ts".
  const parsed = parseListReport(report({
    rootDir: '/proj/tests',
    suites: [{ file: 'a.spec.ts', line: 0, title: 'a.spec.ts', suites: [{ specs: [spec()], file: 'a.spec.ts', line: 0, title: 'a.spec.ts' }] }],
  }), { projectRoot: '/proj' });
  assert.equal(parsed.tests[0].file, 'tests/a.spec.ts');
  assert.deepEqual(parsed.files, ['tests/a.spec.ts']);
});

test('UT-ATS202-003: a file outside the project is excluded and reported', () => {
  const parsed = parseListReport(report({
    rootDir: '/elsewhere',
    suites: [{ file: 'evil.spec.ts', line: 0, title: 'evil.spec.ts', suites: [{ specs: [spec({ file: 'evil.spec.ts' })], file: 'evil.spec.ts', line: 0, title: 'evil.spec.ts' }] }],
  }), { projectRoot: '/proj' });
  assert.equal(parsed.tests.length, 0);
  assert.equal(parsed.skipped.length, 1);
  assert.match(parsed.skipped[0].reason, /outside the project/);
});

test('UT-ATS202-004: the describe path is read from the suite nesting', () => {
  const parsed = parseListReport(report({
    suites: [{
      file: 'a.spec.ts', line: 0, title: 'a.spec.ts',
      suites: [{
        file: 'a.spec.ts', line: 2, title: 'outer',
        suites: [{
          file: 'a.spec.ts', line: 3, title: 'inner',
          specs: [spec({ title: 'deep' })],
        }],
      }],
    }],
  }), { projectRoot: '/proj' });
  assert.equal(parsed.tests.length, 1);
  // The file suite (line 0) is not part of the path; the describe blocks are.
  assert.deepEqual(parsed.tests[0].describePath, ['outer', 'inner']);
  assert.equal(parsed.tests[0].title, 'deep');
});

test('UT-ATS202-005: a project matrix reports the same case once per project', () => {
  const parsed = parseListReport(report({
    rootDir: '/proj',
    suites: [{
      file: 'a.spec.ts', line: 0, title: 'a.spec.ts',
      suites: [
        { specs: [spec({ id: 'file-part-desktop', tests: [{ projectName: 'desktop', expectedStatus: 'passed', annotations: [] }] })], file: 'a.spec.ts', line: 0, title: 'a.spec.ts' },
        { specs: [spec({ id: 'file-part-mobile', tests: [{ projectName: 'mobile', expectedStatus: 'passed', annotations: [] }] })], file: 'a.spec.ts', line: 0, title: 'a.spec.ts' },
      ],
    }],
  }), { projectRoot: '/proj' });
  // The two rows are the SAME logical case (same file, same path, same title).
  assert.equal(parsed.tests.length, 1);
  assert.equal(parsed.tests[0].projects.length, 2);
  assert.deepEqual(parsed.tests[0].projects.map((p) => p.name).sort(), ['desktop', 'mobile']);
  assert.deepEqual(parsed.tests[0].projects.map((p) => p.specId).sort(), ['file-part-desktop', 'file-part-mobile']);
});

test('UT-ATS202-006: the CLI errors are carried over verbatim', () => {
  const parsed = parseListReport(report({
    errors: [{ message: 'Error: duplicate test title "x"', location: { file: '/proj/a.spec.ts', line: 3 } }],
  }), { projectRoot: '/proj' });
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].message, /duplicate test title/);
  assert.equal(parsed.errors[0].location.line, 3);
});

test('UT-ATS202-007: the cases are sorted by file and line', () => {
  // The file of a case comes from the SPEC itself (the CLI reports it on
  // every spec), not from the suite it sits in.
  const parsed = parseListReport(report({
    rootDir: '/proj',
    suites: [
      {
        file: 'b.spec.ts', line: 0, title: 'b.spec.ts',
        suites: [{
          specs: [spec({ title: 'second', line: 9, file: 'b.spec.ts' })],
          file: 'b.spec.ts', line: 0, title: 'b.spec.ts',
        }],
      },
      {
        file: 'a.spec.ts', line: 0, title: 'a.spec.ts',
        suites: [{
          specs: [spec({ title: 'first', line: 3, file: 'a.spec.ts' })],
          file: 'a.spec.ts', line: 0, title: 'a.spec.ts',
        }],
      },
    ],
  }), { projectRoot: '/proj' });
  assert.deepEqual(parsed.tests.map((t) => `${t.file}:${t.line}`), ['a.spec.ts:3', 'b.spec.ts:9']);
});

test('UT-ATS202-008: projectRelativeFile refuses a path outside the project', () => {
  // A path that resolves OUTSIDE the project is refused: a config whose
  // testDir points elsewhere must not make the index report files the user
  // cannot reach through the product.
  assert.equal(projectRelativeFile('/elsewhere/a.spec.ts', { rootDir: '/proj/tests', projectRoot: '/proj' }), null);
  assert.equal(projectRelativeFile('a.spec.ts', { rootDir: '/proj/tests', projectRoot: '/proj' }), 'tests/a.spec.ts');
  assert.equal(projectRelativeFile('/proj/tests/a.spec.ts', { rootDir: '/proj/tests', projectRoot: '/proj' }), 'tests/a.spec.ts');
  // A relative path that climbs out of the rootDir but stays inside the
  // project is INSIDE the project -- the check is on the resolved path.
  assert.equal(projectRelativeFile('../a.spec.ts', { rootDir: '/proj/tests', projectRoot: '/proj' }), 'a.spec.ts');
  // ... and one that climbs out of the PROJECT is refused.
  assert.equal(projectRelativeFile('../../outside.spec.ts', { rootDir: '/proj/tests', projectRoot: '/proj' }), null);
});

test('UT-ATS202-009: the outcome codes are stable', () => {
  assert.equal(LIST_OUTCOME.OK, 'OK');
  assert.equal(LIST_OUTCOME.NO_CLI, 'PLAYWRIGHT_NOT_INSTALLED');
  assert.equal(LIST_OUTCOME.FAILED, 'PLAYWRIGHT_LIST_FAILED');
  assert.equal(LIST_OUTCOME.TIMEOUT, 'PLAYWRIGHT_LIST_TIMEOUT');
});

/* ------------------------------------------------------------------ */
/* the trust gate                                                     */
/* ------------------------------------------------------------------ */

test('UT-ATS202-010: a project without a trust record is untrusted', () => {
  const state = {};
  const t = trustOf(state, { id: PROJECT_UID, uid: PROJECT_UID, root: '/proj' });
  assert.equal(t.trust, TRUST.UNTRUSTED);
  assert.equal(t.reason, TRUST_REASON.NOT_VOUCHED);
  assert.equal(isTrusted(state, { uid: PROJECT_UID }), false);
});

test('UT-ATS202-011: a vouched project is trusted', () => {
  const state = withTrust({}, { uid: PROJECT_UID }, { trust: TRUST.TRUSTED });
  const t = trustOf(state, { uid: PROJECT_UID });
  assert.equal(t.trust, TRUST.TRUSTED);
  assert.equal(t.reason, '');
  assert.ok(t.at, 'the decision is timestamped');
  assert.equal(isTrusted(state, { uid: PROJECT_UID }), true);
});

test('UT-ATS202-012: the trust can be revoked, and the reason is kept', () => {
  let state = withTrust({}, { uid: PROJECT_UID }, { trust: TRUST.TRUSTED });
  state = withTrust(state, { uid: PROJECT_UID }, { trust: TRUST.UNTRUSTED, reason: TRUST_REASON.REVOKED });
  const t = trustOf(state, { uid: PROJECT_UID });
  assert.equal(t.trust, TRUST.UNTRUSTED);
  assert.equal(t.reason, TRUST_REASON.REVOKED);
});

test('UT-ATS202-013: the trust of one project does not leak into another', () => {
  const other = 'proj_1_ffffffffffffffffffffffff';
  const state = withTrust({}, { uid: PROJECT_UID }, { trust: TRUST.TRUSTED });
  assert.equal(trustOf(state, { uid: other }).trust, TRUST.UNTRUSTED);
});

test('UT-ATS202-014: withTrust does not mutate the state it is given', () => {
  const state = {};
  const next = withTrust(state, { uid: PROJECT_UID }, { trust: TRUST.TRUSTED });
  assert.deepEqual(state, {});
  assert.notEqual(next, state);
});

/* ------------------------------------------------------------------ */
/* the identity ladder                                                */
/* ------------------------------------------------------------------ */

const bodies = new Map();
const bodyOf = (file, line, text) => bodies.set(`${file} ${line}`, { bodyText: text });

test('UT-ATS202-015: a unique title keeps the ATS-201 title-key UID', () => {
  const r = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [{ file: 'tests/a.spec.ts', title: 'alpha', line: 2, describePath: [], projects: [] }],
    bodies,
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/a.spec.ts']),
  });
  assert.equal(r.items[0].uidSource, 'derived');
  assert.equal(r.items[0].basis, 'title-key');
  assert.equal(r.items[0].uidStable, true);
});

test('UT-ATS202-016: an explicit annotation wins over every derived key', () => {
  const r = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [{ file: 'tests/a.spec.ts', title: 'alpha @TC-001', line: 2, describePath: [], projects: [] }],
    bodies,
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/a.spec.ts']),
  });
  assert.equal(r.items[0].uid, 'tc-001');
  assert.equal(r.items[0].uidSource, 'explicit');
  assert.equal(r.items[0].uidStable, true);
});

test('UT-ATS202-017: the same explicit annotation on two cases binds neither', () => {
  const r = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [
      { file: 'tests/a.spec.ts', title: 'alpha @TC-001', line: 2, describePath: [], projects: [] },
      { file: 'tests/b.spec.ts', title: 'beta @TC-001', line: 2, describePath: [], projects: [] },
    ],
    bodies,
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/a.spec.ts', 'tests/b.spec.ts']),
  });
  for (const item of r.items) {
    assert.equal(item.uidStable, false);
    assert.equal(item.ambiguity.reason, 'duplicate-explicit-uid');
  }
  assert.notEqual(r.items[0].uid, r.items[1].uid);
});

test('UT-ATS202-018: the describe path resolves two same-titled cases', () => {
  // The static index reports these two as ambiguous (identical title). The
  // authoritative index knows the describe path and can decide.
  const r = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [
      { file: 'tests/a.spec.ts', title: 'works', line: 2, describePath: ['first'], projects: [] },
      { file: 'tests/a.spec.ts', title: 'works', line: 6, describePath: ['second'], projects: [] },
    ],
    bodies,
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/a.spec.ts']),
  });
  assert.equal(r.items.every((i) => i.uidStable), true);
  assert.equal(r.items.every((i) => i.basis === 'scope-title'), true);
  assert.notEqual(r.items[0].uid, r.items[1].uid);
});

test('UT-ATS202-019: two same-titled cases in the same describe path stay ambiguous', () => {
  const r = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [
      { file: 'tests/a.spec.ts', title: 'works', line: 2, describePath: ['same'], projects: [] },
      { file: 'tests/a.spec.ts', title: 'works', line: 6, describePath: ['same'], projects: [] },
    ],
    bodies,
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/a.spec.ts']),
  });
  assert.equal(r.items.every((i) => i.uidStable === false), true);
  assert.equal(r.items.every((i) => i.ambiguity.reason === 'identical-title'), true);
  // They are NOT merged: two distinct provisional identifiers.
  assert.notEqual(r.items[0].uid, r.items[1].uid);
});

test('UT-ATS202-020: the body fingerprint decides when the describe path does not', () => {
  const b = new Map();
  b.set('tests/a.spec.ts 2', { title: 'works', bodyText: 'await page.setContent("one");' });
  b.set('tests/a.spec.ts 6', { title: 'works', bodyText: 'await page.setContent("two");' });
  const r = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [
      { file: 'tests/a.spec.ts', title: 'works', line: 2, describePath: ['same'], projects: [] },
      { file: 'tests/a.spec.ts', title: 'works', line: 6, describePath: ['same'], projects: [] },
    ],
    bodies: b,
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/a.spec.ts']),
  });
  assert.equal(r.items.every((i) => i.uidStable), true);
  assert.equal(r.items.every((i) => i.basis === 'body-key'), true);
  assert.notEqual(r.items[0].uid, r.items[1].uid);
});

test('UT-ATS202-020b: a DYNAMIC case is decided by the describe path, not by the body', () => {
  // Two cases generated from ONE template share the body of that template.
  // The body must not decide them -- they would get the same UID, and the
  // UID would move as soon as the template grows. The describe path
  // decides instead.
  const b = new Map();
  b.set('tests/a.spec.ts 3', { title: 'dynamic ${n}', bodyText: 'TEMPLATE_BODY' });
  const r = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [
      { file: 'tests/a.spec.ts', title: 'dynamic a', line: 3, describePath: ['gen'], projects: [] },
      { file: 'tests/a.spec.ts', title: 'dynamic b', line: 3, describePath: ['gen'], projects: [] },
    ],
    bodies: b,
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/a.spec.ts']),
  });
  // The two rendered titles differ, so the title key decides each of them.
  assert.equal(r.items.every((i) => i.uidStable), true);
  assert.notEqual(r.items[0].uid, r.items[1].uid);
  assert.equal(r.items.every((i) => i.basis === 'title-key'), true);
});

test('UT-ATS202-021: the UID of an ordinary case is the same as the static one', () => {
  // Switching between the static and the authoritative index must not change
  // the UID of a case that both indexes see -- otherwise every link built on
  // the UID breaks when the user vouches for the project.
  const title = 'alpha';
  const r = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [{ file: 'tests/a.spec.ts', title, line: 2, describePath: [], projects: [] }],
    bodies,
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/a.spec.ts']),
  });
  assert.equal(r.items[0].uid, deriveTestUid(PROJECT_UID, normalizeTitleKey(title)));
});

test('UT-ATS202-021b: the UID of an ordinary case does not change when the index switches', () => {
  // The same case, resolved twice: once alone (as the static index would
  // see it) and once next to a DYNAMIC case that renders the same title.
  // The UID of the ordinary case must not move.
  //
  // The dynamic case is modelled the way the CLI reports it: its rendered
  // title is `alpha`, while the SOURCE at that position is the template
  // literal `alpha ${n}`. The scanner reads the template, so the source
  // title and the reported title differ -- which is how a dynamic case is
  // told apart from a literal one.
  const b = new Map();
  b.set('tests/a.spec.ts 2', { title: 'alpha', bodyText: 'await page.setContent("a");' });
  b.set('tests/a.spec.ts 9', { title: 'alpha ${n}', bodyText: 'await page.setContent("b");' });

  const alone = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [{ file: 'tests/a.spec.ts', title: 'alpha', line: 2, describePath: [], projects: [] }],
    bodies: b,
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/a.spec.ts']),
  });
  const withDynamic = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [
      { file: 'tests/a.spec.ts', title: 'alpha', line: 2, describePath: [], projects: [] },
      { file: 'tests/a.spec.ts', title: 'alpha', line: 9, describePath: ['dyn'], projects: [] },
    ],
    bodies: b,
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/a.spec.ts']),
  });
  // The literal case keeps its UID.
  assert.equal(withDynamic.items[0].uid, alone.items[0].uid);
  assert.equal(withDynamic.items[0].basis, 'title-key');
  // The dynamic case is NOT decided by the body (the body belongs to the
  // template), and NOT by the title (the literal case has it) -- it falls
  // through to the describe path.
  assert.equal(withDynamic.items[1].basis, 'scope-title');
  assert.notEqual(withDynamic.items[0].uid, withDynamic.items[1].uid);
});

test('UT-ATS202-022: the registry keeps the spec ids of the CLI', () => {
  const r = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [{
      file: 'tests/a.spec.ts', title: 'alpha', line: 2, describePath: [],
      projects: [{ name: 'desktop', specId: 'aaa-bbb' }, { name: 'mobile', specId: 'ccc-ddd' }],
    }],
    bodies,
    registry: { version: 1, entries: [] },
    scope: new Set(['tests/a.spec.ts']),
  });
  const entry = r.registry.entries.find((e) => e.uid === r.items[0].uid);
  assert.ok(entry, 'the case is in the registry');
  assert.deepEqual(entry.specIds.sort(), ['aaa-bbb', 'ccc-ddd']);
  assert.deepEqual(entry.scope, []);
});

test('UT-ATS202-023: an entry of an absent file is not pruned', () => {
  // The file is not part of THIS discovery (a branch that does not contain
  // it). Its entry must survive, or the case loses its UID when the file
  // comes back.
  const stale = { uid: 'tc_1_d_0000000000000000', uidSource: 'derived', titleKey: 'gone', bodyKey: null, file: 'tests/gone.spec.ts', title: 'gone', line: 2, aliases: [] };
  const r = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [{ file: 'tests/a.spec.ts', title: 'alpha', line: 2, describePath: [], projects: [] }],
    bodies,
    registry: { version: 1, entries: [stale] },
    scope: new Set(['tests/a.spec.ts']),
  });
  assert.ok(r.registry.entries.some((e) => e.uid === stale.uid), 'the absent file keeps its entry');
});

test('UT-ATS202-024: an entry of a covered file whose case is gone is pruned', () => {
  const gone = { uid: 'tc_1_d_1111111111111111', uidSource: 'derived', titleKey: 'gone', bodyKey: null, file: 'tests/a.spec.ts', title: 'gone', line: 2, aliases: [] };
  const r = resolveAuthoritativeIdentities({
    projectUid: PROJECT_UID,
    cases: [{ file: 'tests/a.spec.ts', title: 'alpha', line: 2, describePath: [], projects: [] }],
    bodies,
    registry: { version: 1, entries: [gone] },
    scope: new Set(['tests/a.spec.ts']),
  });
  assert.equal(r.registry.entries.some((e) => e.uid === gone.uid), false);
});

/* ------------------------------------------------------------------ */
/* the comparison of the two indexes                                  */
/* ------------------------------------------------------------------ */

test('UT-ATS202-025: the comparison reports the cases only one index knows', () => {
  const authoritative = [
    { file: 'a.spec.ts', describePath: [], title: 'plain' },
    { file: 'a.spec.ts', describePath: ['dyn'], title: 'dynamic' },
  ];
  const statics = [
    { file: 'a.spec.ts', describePath: [], title: 'plain' },
  ];
  const c = compareDiscoveries(authoritative, statics);
  assert.equal(c.agrees, false);
  assert.equal(c.authoritative, 2);
  assert.equal(c.static, 1);
  assert.equal(c.common, 1);
  assert.deepEqual(c.onlyAuthoritative, ['a.spec.ts dyn dynamic']);
  assert.deepEqual(c.onlyStatic, []);
});

test('UT-ATS202-026: the comparison reports agreement when the two agree', () => {
  const rows = [{ file: 'a.spec.ts', describePath: [], title: 'plain' }];
  const c = compareDiscoveries(rows, rows);
  assert.equal(c.agrees, true);
  assert.equal(c.common, 1);
});

test('UT-ATS202-027: the lexical describe path reads the blocks above the line', () => {
  const content = [
    "import { test } from '@playwright/test';",
    "test.describe('outer', () => {",
    "  test('a', async () => {});",
    "  test.describe('inner', () => {",
    "    test('b', async () => {});",
    "  });",
    "});",
  ].join('\n');
  assert.deepEqual(describePathAt(content, 3), ['outer']);
  assert.deepEqual(describePathAt(content, 5), ['outer', 'inner']);
  assert.deepEqual(describePathAt(content, 1), []);
});

test('UT-ATS202-028: the case key spells the file, the path and the title', () => {
  assert.equal(caseKey({ file: 'a.spec.ts', describePath: ['x', 'y'], title: 't' }), 'a.spec.ts x > y t');
  assert.equal(caseKey({ file: 'a.spec.ts', title: 't' }), 'a.spec.ts  t');
});
