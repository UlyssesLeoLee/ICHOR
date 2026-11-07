/**
 * ATS-204: the identity mapper.
 *
 * The acceptance criterion of this task is "rename 后旧证据关联保留；歧义不误关联"
 * -- the association survives a rename, and an ambiguity never binds the
 * wrong case.
 *
 * Every test here is written so that it FAILS on the code that preceded
 * this task: a test that cannot fail is not evidence. The counterexamples
 * are the ones the probes in `tools/ats204-probes/` measured on the tree
 * before this task.
 *
 * Every test works in its OWN directory: the tests write spec files into a
 * project, and a leftover file would change what the next test sees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { emptyRegistry, findTestUid, projectUidFor } from '../server/uid.mjs';
import { bindReported, anchorOf, groupByPosition, positionKey, reidentifyRendered, AMBIGUITY } from '../server/identity.mjs';
import { discoverStatic, attemptsForRun } from '../server/core.mjs';
import { resolveAuthoritativeIdentities } from '../server/discovery/authoritative.mjs';
import { parseReport } from '../server/execution/model.mjs';

/** A project directory of its own, so the tests cannot see each other's files. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats204-'));
  const projectDir = path.join(dir, 'app');
  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(projectDir, 'playwright.config.ts'), 'export default {}');
  return {
    dir,
    projectDir,
    project: { id: 'proj_demo', root: projectDir },
    projectUid: projectUidFor(projectDir),
    write(rel, content) {
      const full = path.join(projectDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    },
    rm(rel) {
      fs.rmSync(path.join(projectDir, rel), { force: true, recursive: true });
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------------ */
/* The rename: the association survives it                             */
/* ------------------------------------------------------------------ */

test('UT-ATS204-001: the UID survives a rename, and the old spelling is recorded as an alias', () => {
  const p = makeProject();
  try {
    p.write('tests/login.spec.ts', "test('login works', async () => { await 1; });\n");
    const first = discoverStatic(p.project, emptyRegistry());
    const uid = first.tests[0].uid;

    p.rm('tests/login.spec.ts');
    p.write('tests/auth/login.spec.ts', "test('login works', async () => { await 1; });\n");
    const second = discoverStatic(p.project, first.registry);

    assert.equal(second.tests[0].uid, uid, 'the rename keeps the uid');
    assert.equal(second.tests[0].file, 'tests/auth/login.spec.ts');
    const entry = second.registry.projects[p.projectUid].entries.find((e) => e.uid === uid);
    assert.ok(entry, 'the registry keeps the entry');
    assert.deepEqual(entry.aliases, [{ file: 'tests/login.spec.ts', title: 'login works' }],
      'the OLD spelling is recorded as an alias');
  } finally { p.cleanup(); }
});

test('UT-ATS204-002: the UID survives a rename AND a retitle', () => {
  const p = makeProject();
  try {
    p.write('tests/login.spec.ts', "test('login works', async () => { await 1; });\n");
    const first = discoverStatic(p.project, emptyRegistry());
    const uid = first.tests[0].uid;

    p.rm('tests/login.spec.ts');
    p.write('tests/auth/login.spec.ts', "test('login flow works', async () => { await 1; });\n");
    const second = discoverStatic(p.project, first.registry);

    assert.equal(second.tests[0].uid, uid, 'the rename + retitle keeps the uid');
    assert.equal(second.tests[0].uidSource, 'registry');
  } finally { p.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* The run binding: the old evidence stays attached                    */
/* ------------------------------------------------------------------ */

test('UT-ATS204-003: an attempt of a renamed+retitled case is bound to the original UID', () => {
  // The counterexample the probe measured: the attempt was UNBOUND
  // (`uidBasis: unbound`) although the registry knew the case under its
  // OLD name. The body fingerprint is the signal that survives both
  // changes at once.
  const p = makeProject();
  try {
    p.write('tests/login.spec.ts', "test('login works', async () => { await 1; });\n");
    const first = discoverStatic(p.project, emptyRegistry());
    const uid = first.tests[0].uid;

    // The file is renamed and the title rewritten, and the catalogue has NOT
    // been re-opened since -- the registry still knows the OLD spelling.
    p.rm('tests/login.spec.ts');
    p.write('tests/auth/login.spec.ts', "test('login flow works', async () => { await 1; });\n");

    const attempts = attemptsForRun(
      { uid: 'run_1_' + '0'.repeat(24), projectUid: p.projectUid, projectRoot: p.projectDir },
      {
        rootDir: path.join(p.projectDir, 'tests').replace(/\\/g, '/'),
        cases: [{ title: 'login flow works', file: 'auth/login.spec.ts', line: 1, status: 'expected', duration: 1, retry: 0 }],
      },
      first.registry
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].testUid, uid, 'the attempt is bound to the original uid');
    assert.equal(attempts[0].uidBasis, 'body-key');
  } finally { p.cleanup(); }
});

test('UT-ATS204-004: an attempt of a case whose file was renamed is bound to the original UID', () => {
  const p = makeProject();
  try {
    p.write('tests/login.spec.ts', "test('login works', async () => { await 1; });\n");
    const first = discoverStatic(p.project, emptyRegistry());
    const uid = first.tests[0].uid;

    p.rm('tests/login.spec.ts');
    p.write('tests/auth/login.spec.ts', "test('login works', async () => { await 1; });\n");
    const attempts = attemptsForRun(
      { uid: 'run_1_' + '1'.repeat(24), projectUid: p.projectUid, projectRoot: p.projectDir },
      {
        rootDir: path.join(p.projectDir, 'tests').replace(/\\/g, '/'),
        cases: [{ title: 'login works', file: 'auth/login.spec.ts', line: 1, status: 'expected', duration: 1, retry: 0 }],
      },
      first.registry
    );
    assert.equal(attempts[0].testUid, uid, 'the attempt is bound to the original uid');
  } finally { p.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* The ambiguity: it never binds the wrong case                        */
/* ------------------------------------------------------------------ */

test('UT-ATS204-005: a case that took over the old file name does NOT get the old UID', () => {
  // The old case is deleted and a DIFFERENT case takes its file name. The
  // registry still remembers the old case under that name.
  const p = makeProject();
  try {
    p.write('tests/login.spec.ts', "test('login works', async () => { await 1; });\n");
    const first = discoverStatic(p.project, emptyRegistry());
    const oldUid = first.tests[0].uid;

    p.rm('tests/login.spec.ts');
    p.write('tests/login.spec.ts', "test('a different case', async () => { await 2; });\n");
    const attempts = attemptsForRun(
      { uid: 'run_1_' + '2'.repeat(24), projectUid: p.projectUid, projectRoot: p.projectDir },
      {
        rootDir: path.join(p.projectDir, 'tests').replace(/\\/g, '/'),
        cases: [{ title: 'a different case', file: 'login.spec.ts', line: 1, status: 'expected', duration: 1, retry: 0 }],
      },
      first.registry
    );
    assert.notEqual(attempts[0].testUid, oldUid, 'the new case does not inherit the old uid');
    assert.equal(attempts[0].testUid, null, 'the new case stays unbound');
  } finally { p.cleanup(); }
});

test('UT-ATS204-006: a body that two cases of the same run share identifies neither', () => {
  const entries = [{
    uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: 'k1', file: 'tests/a.spec.ts', title: 'case', line: 3, aliases: [],
  }];
  // Two cases of the SAME run share the fingerprint: it identifies neither.
  const hit = bindReported({
    entries,
    file: 'tests/a.spec.ts',
    title: 'case',
    line: 3,
    bodyKey: 'k1',
    bodyCounts: new Map([['k1', 2]]),
  });
  assert.equal(hit.uid, null, 'the shared fingerprint binds nothing');
  assert.equal(hit.basis, 'body-key-shared');
  assert.equal(hit.ambiguity.reason, AMBIGUITY.BODY_SHARED);
});

test('UT-ATS204-007: an ambiguous title in the project binds nothing', () => {
  const entries = [
    { uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: null, file: 'tests/a.spec.ts', title: 'works', line: 3, aliases: [] },
    { uid: 'tc_1_d_bbbbbbbbbbbbbbbb', bodyKey: null, file: 'tests/b.spec.ts', title: 'works', line: 9, aliases: [] },
  ];
  const hit = bindReported({ entries, file: 'tests/c.spec.ts', title: 'works' });
  assert.equal(hit.uid, null, 'the ambiguous title binds nothing');
  assert.equal(hit.basis, 'title-ambiguous');
  assert.deepEqual(hit.ambiguity.candidates, ['tc_1_d_aaaaaaaaaaaaaaaa', 'tc_1_d_bbbbbbbbbbbbbbbb']);
});

test('UT-ATS204-008: a case that shares its title with another in the SAME file is bound by the body', () => {
  const entries = [
    { uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: 'k1', file: 'tests/a.spec.ts', title: 'works', line: 3, aliases: [] },
    { uid: 'tc_1_d_bbbbbbbbbbbbbbbb', bodyKey: 'k2', file: 'tests/a.spec.ts', title: 'works', line: 9, aliases: [] },
  ];
  // The body picks the right one of the two.
  const byBody = bindReported({
    entries, file: 'tests/a.spec.ts', title: 'works', line: 9,
    bodyKey: 'k2', bodyCounts: new Map([['k2', 1]]),
  });
  assert.equal(byBody.uid, 'tc_1_d_bbbbbbbbbbbbbbbb');
  assert.equal(byBody.basis, 'file-title-body');

  // Without the body, the case stays unbound: the line may name a
  // different case than the one that was there when the registry was
  // written.
  const withoutBody = bindReported({ entries, file: 'tests/a.spec.ts', title: 'works', line: 9 });
  assert.equal(withoutBody.uid, null);
  assert.equal(withoutBody.basis, 'file-title-ambiguous');
});

test('UT-ATS204-009: the alias is used only when the body is unavailable', () => {
  const entries = [{
    uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: 'k1', file: 'tests/new.spec.ts', title: 'new title', line: 5,
    aliases: [{ file: 'tests/old.spec.ts', title: 'old title' }],
  }];
  // The body is unavailable (the source could not be read): the alias
  // decides.
  const byAlias = bindReported({ entries, file: 'tests/old.spec.ts', title: 'old title', bodyKey: null });
  assert.equal(byAlias.uid, 'tc_1_d_aaaaaaaaaaaaaaaa');
  assert.equal(byAlias.basis, 'alias');

  // The body IS available and it does not match: the case at that
  // position is a DIFFERENT case, and the alias must not claim it.
  const withBody = bindReported({
    entries, file: 'tests/old.spec.ts', title: 'old title', bodyKey: 'k9',
    bodyCounts: new Map([['k9', 1]]),
  });
  assert.notEqual(withBody.uid, 'tc_1_d_aaaaaaaaaaaaaaaa',
    'the alias does not claim a case whose body says otherwise');
});

test('UT-ATS204-010: an explicit annotation always wins over the position', () => {
  const entries = [{
    uid: 'tc-001', bodyKey: null, file: 'tests/a.spec.ts', title: 'works @TC-001', line: 3, aliases: [],
  }];
  const hit = bindReported({ entries, file: 'tests/a.spec.ts', title: 'works @TC-001', line: 3 });
  assert.equal(hit.uid, 'tc-001');
  assert.equal(hit.basis, 'explicit');
});

test('UT-ATS204-011: a duplicated explicit annotation binds neither case', () => {
  const entries = [{
    uid: 'tc-001', bodyKey: null, file: 'tests/a.spec.ts', title: 'works @TC-001', line: 3, aliases: [],
  }];
  // The registry holds ONE case with the token, but TWO cases of the run
  // carry it: only the author can say which of them owns the token, so
  // NEITHER of them may be bound to it.
  const hit = bindReported({
    entries, file: 'tests/b.spec.ts', title: 'other @TC-001', line: 7,
    explicitCounts: new Map([['tc-001', 2]]),
  });
  assert.equal(hit.uid, null, 'the duplicated token binds nothing');
  assert.equal(hit.basis, 'explicit-ambiguous');
  assert.equal(hit.ambiguity.reason, 'duplicate-explicit-uid');
});

/* ------------------------------------------------------------------ */
/* The dynamic side: the anchor                                        */
/* ------------------------------------------------------------------ */

const renders = (suffix, count = 2) => Array.from({ length: count }, (_, i) => ({
  file: 'tests/dyn.spec.ts',
  title: `adds ${i + 1} items${suffix}`,
  line: 7,
  column: 3,
  describePath: [],
  projects: [],
  tags: [],
}));

test('UT-ATS204-012: a dynamic case keeps its UID when the template is re-worded', () => {
  const p = makeProject();
  try {
    const first = resolveAuthoritativeIdentities({
      projectUid: p.projectUid, cases: renders(''), bodies: new Map(), registry: { version: 1, entries: [] },
    });
    const before = first.items.map((i) => i.uid);
    assert.ok(before.every(Boolean), 'the renders got a uid');
    assert.ok(first.registry.entries.every((e) => e.anchor && e.anchor.kind === 'position'),
      'the registry carries the anchor of every case');

    // The template's text changed, so EVERY rendered title changed with it.
    const second = resolveAuthoritativeIdentities({
      projectUid: p.projectUid, cases: renders(' to the cart'), bodies: new Map(), registry: first.registry,
    });
    assert.deepEqual(second.items.map((i) => i.uid), before, 'the uids survive the re-wording');
    assert.ok(second.items.every((i) => i.basis === 'position-anchor'),
      'the anchor is what recognised them');
  } finally { p.cleanup(); }
});

test('UT-ATS204-013: a template that GAINS a render reports the shift instead of guessing', () => {
  const p = makeProject();
  try {
    const first = resolveAuthoritativeIdentities({
      projectUid: p.projectUid, cases: renders(''), bodies: new Map(), registry: { version: 1, entries: [] },
    });
    // The template gained a render: the ordinals may have shifted, and a
    // shifted ordinal points at a DIFFERENT render.
    const third = resolveAuthoritativeIdentities({
      projectUid: p.projectUid, cases: renders(' to the cart', 3), bodies: new Map(), registry: first.registry,
    });
    const reported = third.items.filter((i) => i.ambiguity);
    assert.ok(reported.length > 0, 'the shift is reported');
    assert.ok(reported.every((i) => i.ambiguity.reason === AMBIGUITY.RENDER_SHIFT),
      'the reason names the shift');
  } finally { p.cleanup(); }
});

test('UT-ATS204-014: the anchor names the position and the ordinal of a case', () => {
  const cases = renders('', 2);
  const groups = groupByPosition(cases);
  const key = positionKey('tests/dyn.spec.ts', 7, []);
  assert.equal(groups.get(key).length, 2, 'the two renders share the position');
  const decisions = reidentifyRendered({
    cases,
    entries: [{ uid: 'tc-1', title: 'old title', anchor: { file: 'tests/dyn.spec.ts', line: 7, scope: [], ordinal: 1, count: 2 } }],
    groups,
  });
  const decision = decisions.get(cases[1]);
  assert.ok(decision, 'the second render is decided by the anchor');
  assert.equal(decision.uid, 'tc-1');
  assert.equal(decision.basis, 'position-anchor');
});

/* ------------------------------------------------------------------ */
/* The matrix: one case, several projects                              */
/* ------------------------------------------------------------------ */

test('UT-ATS204-015: the two rows the CLI writes for one case in two projects are ONE case', () => {
  // The REAL `@playwright/test` 1.64.1 writes ONE SPEC ROW PER PROJECT
  // (measured in `tools/ats204-probes/cli-facts.mjs`).
  const report = {
    suites: [{
      file: 'f.spec.ts',
      specs: [
        {
          title: 'plain case', file: 'f.spec.ts', line: 4, id: 'file-half-aaaa',
          tests: [{ projectName: 'alpha', status: 'expected', expectedStatus: 'passed',
            results: [{ status: 'passed', retry: 0, duration: 10 }] }],
        },
        {
          title: 'plain case', file: 'f.spec.ts', line: 4, id: 'file-half-bbbb',
          tests: [{ projectName: 'beta', status: 'unexpected', expectedStatus: 'passed',
            results: [{ status: 'failed', retry: 0, duration: 12, error: { message: 'boom' } }] }],
        },
      ],
      suites: [],
    }],
  };
  const summary = parseReport(report);
  assert.equal(summary.total, 1, 'the two rows are ONE logical case');
  assert.equal(summary.failed, 1, 'the case failed in project beta');
  assert.equal(summary.executions, 2, 'the two executions are counted separately');
});

test('UT-ATS204-016: the two attempts of a matrix case carry the SAME TestDefinition UID', () => {
  const p = makeProject();
  try {
    const registry = {
      version: 1,
      projects: {
        [p.projectUid]: {
          version: 1,
          entries: [{
            uid: 'tc_1_d_aaaaaaaaaaaaaaaa', uidSource: 'derived', titleKey: 'plain case',
            bodyKey: 'k1', file: 'tests/f.spec.ts', title: 'plain case', line: 4, aliases: [],
            scope: [], specIds: ['file-half-aaaa', 'file-half-bbbb'],
          }],
        },
      },
    };
    const summary = {
      rootDir: path.join(p.projectDir, 'tests').replace(/\\/g, '/'),
      cases: [
        { title: 'plain case', file: 'f.spec.ts', line: 4, status: 'expected', duration: 1, retry: 0 },
        { title: 'plain case', file: 'f.spec.ts', line: 4, status: 'unexpected', duration: 1, retry: 0 },
      ],
    };
    const attempts = attemptsForRun(
      { uid: 'run_1_' + '3'.repeat(24), projectUid: p.projectUid, projectRoot: p.projectDir },
      summary,
      registry
    );
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].testUid, 'tc_1_d_aaaaaaaaaaaaaaaa');
    assert.equal(attempts[1].testUid, 'tc_1_d_aaaaaaaaaaaaaaaa',
      'the two projects share ONE logical case, so they share ONE uid');
  } finally { p.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* The old lookup still works                                          */
/* ------------------------------------------------------------------ */

test('UT-ATS204-018: a renamed case is bound by its body even though the position does not match', () => {
  // The case was renamed: the report names the NEW file, the registry
  // remembers the OLD one. The position does not match at all, so there
  // is no contradiction -- and the body, the signal that survives a
  // rename, binds the case.
  const entries = [{
    uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: 'k1', file: 'tests/old.spec.ts', title: 'old title', line: 3,
    aliases: [],
  }];
  const hit = bindReported({
    entries, file: 'tests/new.spec.ts', title: 'new title', line: 9,
    bodyKey: 'k1', bodyCounts: new Map([['k1', 1]]),
  });
  assert.equal(hit.uid, 'tc_1_d_aaaaaaaaaaaaaaaa', 'the body binds the renamed case');
  assert.equal(hit.basis, 'body-key');
});

test('UT-ATS204-019: a positional hit whose body CONTRADICTS it does not bind, and says so', () => {
  // The stale-line shape of `docs/18-UID-SPEC.md` §7.1: the same file,
  // the same line, the same title -- but the body of the case that is
  // there NOW is not the body the registry remembers. The position is
  // not an identity, so it does not bind, and the reader is told that
  // the two disagree.
  const entries = [{
    uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: 'k1', file: 'tests/a.spec.ts', title: 'works', line: 3,
    aliases: [],
  }];
  const hit = bindReported({
    entries, file: 'tests/a.spec.ts', title: 'works', line: 3,
    bodyKey: 'k9', bodyCounts: new Map([['k9', 1]]),
  });
  assert.equal(hit.uid, null, 'the case stays unbound');
  assert.equal(hit.basis, 'file-line-body-mismatch');
  assert.ok(hit.ambiguity, 'the mismatch is reported');
  assert.equal(hit.ambiguity.reason, AMBIGUITY.BODY);
});

test('UT-ATS204-020: a positional hit whose body AGREES binds, and reports nothing', () => {
  const entries = [{
    uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: 'k1', file: 'tests/a.spec.ts', title: 'works', line: 3,
    aliases: [],
  }];
  const hit = bindReported({
    entries, file: 'tests/a.spec.ts', title: 'works', line: 3,
    bodyKey: 'k1', bodyCounts: new Map([['k1', 1]]),
  });
  assert.equal(hit.uid, 'tc_1_d_aaaaaaaaaaaaaaaa');
  assert.equal(hit.basis, 'file-line');
  assert.equal(hit.ambiguity, undefined, 'nothing is reported when the two agree');
});

test('UT-ATS204-021: a NEW case with an explicit token binds to it, registry or not', () => {
  // The registry is the MEMORY of the past cases; the token is the
  // AUTHOR's own statement about the case that carries it. A case the
  // registry has not seen yet still owns the token it carries.
  const hit = bindReported({
    entries: [],
    file: 'tests/a.spec.ts',
    title: 'works @TC-001',
    line: 3,
    explicitCounts: new Map([['tc-001', 1]]),
  });
  assert.equal(hit.uid, 'tc-001', 'the token binds');
  assert.equal(hit.basis, 'explicit');
});

test('UT-ATS204-017: the old lookup keeps its documented behaviour', () => {
  const p = makeProject();
  try {
    // `findTestUid` is the ATS-201 lookup. It is still exported and still
    // used by the callers that pin their behaviour; the mapper is the
    // stronger one, and it does not replace the old one.
    const registry = {
      version: 1,
      projects: {
        [p.projectUid]: {
          version: 1,
          entries: [
            { uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: 'k1', file: 'tests/a.spec.ts', title: 'case', line: 7 },
          ],
        },
      },
    };
    const hit = findTestUid(registry, p.projectUid, { file: 'tests/a.spec.ts', title: 'case', line: 7 });
    assert.equal(hit.uid, 'tc_1_d_aaaaaaaaaaaaaaaa');
    assert.equal(hit.basis, 'file-line');
  } finally { p.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* The counterexamples of the review round 1                           */
/* ------------------------------------------------------------------ */
/*
 * These five cases are the counterexamples the reviewer MEASURED against the
 * tree of the first delivery (`9a559c6`). Every one of them FAILS there and
 * PASSES here -- that is what makes them evidence and not decoration.
 *
 *   E1  a loop data element replaced: the UNCHANGED render must keep its
 *       uid, and the NEW render must not inherit the removed one's;
 *   E3  a new case inserted ABOVE an existing one: the existing case keeps
 *       its uid (the old evidence stays linked) and the new one does not
 *       take it;
 *   E4  a case replaced IN PLACE by a different one (new title, new body):
 *       the new case is a NEW case (the ATS-201 boundary);
 *   M1  two same-titled cases under DIFFERENT describes are two cases;
 *   X1  an explicit token the catalogue judged DUPLICATE is not bound by a
 *       run that happens to cover only one of the two cases.
 */

/** The cases of a loop, as the authoritative discovery sees them. */
const loopCases = (titles, line = 7) => titles.map((title, i) => ({
  file: 'tests/dyn.spec.ts', title, line, column: 3,
  describePath: [], projects: [], tags: [],
  // ATS-204: the order the CLI REPORTED them in.
  reportOrder: i,
}));

test('UT-ATS204-022 (E1): a replaced loop element does not take the removed render\'s uid', () => {
  const p = makeProject();
  try {
    const first = resolveAuthoritativeIdentities({
      projectUid: p.projectUid,
      cases: loopCases(['user alice', 'user bob', 'user carol']),
      bodies: new Map(),
      registry: { version: 1, entries: [] },
    });
    const uidOf = (res, title) => res.items.find((i) => i.title === title)?.uid ?? null;
    const bob = uidOf(first, 'user bob');

    // One data element is replaced: `bob` is gone, `dave` is new. The
    // renders that were NOT touched must keep their uid, and the new
    // render must not inherit the removed one's.
    const second = resolveAuthoritativeIdentities({
      projectUid: p.projectUid,
      cases: loopCases(['user alice', 'user dave', 'user carol']),
      bodies: new Map(),
      registry: first.registry,
    });
    assert.equal(uidOf(second, 'user alice'), uidOf(first, 'user alice'),
      'the untouched first render keeps its uid');
    assert.equal(uidOf(second, 'user carol'), uidOf(first, 'user carol'),
      'the untouched third render keeps its uid');
    assert.notEqual(uidOf(second, 'user dave'), bob,
      'the NEW render does not inherit the removed render\'s uid');
    assert.notEqual(uidOf(second, 'user dave'), uidOf(first, 'user carol'),
      'the new render does not take the uid of a render that is still there');
    // The uncertainty is REPORTED: the group changed in part, so the
    // ordinals may have shifted.
    const dave = second.items.find((i) => i.title === 'user dave');
    assert.ok(dave.ambiguity, 'the partial change is reported');
    assert.equal(dave.ambiguity.reason, AMBIGUITY.RENDER_PARTIAL);
  } finally { p.cleanup(); }
});

test('UT-ATS204-023 (E3): a case inserted above keeps the existing case\'s uid', () => {
  const p = makeProject();
  try {
    const first = resolveAuthoritativeIdentities({
      projectUid: p.projectUid,
      cases: [{ file: 'tests/a.spec.ts', title: 'login works', line: 3, column: 3, describePath: [], projects: [], tags: [], reportOrder: 0 }],
      bodies: new Map([['tests/a.spec.ts 3', { title: 'login works', bodyText: '{ await page.goto("/login"); }' }]]),
      registry: { version: 1, entries: [] },
    });
    const original = first.items[0].uid;

    // A NEW case is inserted ABOVE the existing one: the existing one
    // shifts down by two lines. Its uid must NOT change -- the old evidence
    // stays linked -- and the new case must not take it.
    const second = resolveAuthoritativeIdentities({
      projectUid: p.projectUid,
      cases: [
        { file: 'tests/a.spec.ts', title: 'search finds item', line: 3, column: 3, describePath: [], projects: [], tags: [], reportOrder: 0 },
        { file: 'tests/a.spec.ts', title: 'login works', line: 5, column: 3, describePath: [], projects: [], tags: [], reportOrder: 1 },
      ],
      bodies: new Map([
        ['tests/a.spec.ts 3', { title: 'search finds item', bodyText: '{ await page.fill("#q", "x"); }' }],
        ['tests/a.spec.ts 5', { title: 'login works', bodyText: '{ await page.goto("/login"); }' }],
      ]),
      registry: first.registry,
    });
    const uidOf = (res, title) => res.items.find((i) => i.title === title)?.uid ?? null;
    assert.equal(uidOf(second, 'login works'), original,
      'the EXISTING case keeps its uid: the old evidence stays linked');
    assert.notEqual(uidOf(second, 'search finds item'), original,
      'the NEW case does not take the existing case\'s uid');
  } finally { p.cleanup(); }
});

test('UT-ATS204-024 (E4): a case replaced in place by a different one is a NEW case', () => {
  const p = makeProject();
  try {
    const first = resolveAuthoritativeIdentities({
      projectUid: p.projectUid,
      cases: [{ file: 'tests/a.spec.ts', title: 'login works', line: 3, column: 3, describePath: [], projects: [], tags: [], reportOrder: 0 }],
      bodies: new Map([['tests/a.spec.ts 3', { title: 'login works', bodyText: '{ await page.goto("/login"); }' }]]),
      registry: { version: 1, entries: [] },
    });
    const original = first.items[0].uid;

    // The case is replaced IN PLACE: a new title AND a new body. The
    // identity changes -- this is the ATS-201 boundary (docs/26 §7).
    const second = resolveAuthoritativeIdentities({
      projectUid: p.projectUid,
      cases: [{ file: 'tests/a.spec.ts', title: 'search finds item', line: 3, column: 3, describePath: [], projects: [], tags: [], reportOrder: 0 }],
      bodies: new Map([['tests/a.spec.ts 3', { title: 'search finds item', bodyText: '{ await page.fill("#q", "x"); }' }]]),
      registry: first.registry,
    });
    assert.notEqual(second.items[0].uid, original,
      'the new case does not inherit the replaced case\'s uid');
  } finally { p.cleanup(); }
});

test('UT-ATS204-025 (M1): two same-titled cases under different describes are TWO cases', () => {
  const p = makeProject();
  try {
    // The report nests the specs under their describe blocks, so the
    // describe path is the only thing that tells the two apart. The case
    // key of the run side has to carry it, or the two are merged into one
    // and a failure in one of them is reported as the other.
    //
    // The shape is the one the real CLI writes (measured against
    // @playwright/test 1.64.1): the FILE suite carries line 0 and is not
    // part of the describe path; each `describe` block is a suite of its
    // own, and the specs sit directly inside it.
    const report = {
      suites: [{
        file: 'tests/d.spec.ts', line: 0, title: 'd.spec.ts',
        suites: [
          {
            file: 'tests/d.spec.ts', line: 4, title: 'a',
            specs: [{
              title: 'works', file: 'tests/d.spec.ts', line: 5,
              tests: [{ status: 'expected', expectedStatus: 'passed', results: [{ status: 'passed', retry: 0, duration: 1 }] }],
            }],
          },
          {
            file: 'tests/d.spec.ts', line: 4, title: 'b',
            specs: [{
              title: 'works', file: 'tests/d.spec.ts', line: 5,
              tests: [{ status: 'unexpected', expectedStatus: 'passed', results: [{ status: 'failed', retry: 0, duration: 1, error: { message: 'boom' } }] }],
            }],
          },
        ],
      }],
    };
    const summary = parseReport(report);
    assert.equal(summary.total, 2, 'the two describes are two cases');
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
    assert.deepEqual(summary.cases.map((c) => c.scope), [['a'], ['b']],
      'each case carries its own describe path');
    assert.notEqual(summary.cases[0].caseKey, summary.cases[1].caseKey,
      'the case key carries the describe path');
  } finally { p.cleanup(); }
});

test('UT-ATS204-026 (M1b): the two describes bind to their OWN TestDefinition', () => {
  const p = makeProject();
  try {
    // The PRODUCTION path: the catalogue resolves the identities (and
    // writes the registry), and the run binds against that registry. A test
    // that built the registry by hand would only prove that the mapper
    // works -- not that the product uses it.
    const catalogue = resolveAuthoritativeIdentities({
      projectUid: p.projectUid,
      cases: [
        { file: 'tests/d.spec.ts', title: 'works', line: 5, column: 3, describePath: ['a'], projects: [], tags: [], reportOrder: 0 },
        { file: 'tests/d.spec.ts', title: 'works', line: 5, column: 3, describePath: ['b'], projects: [], tags: [], reportOrder: 1 },
      ],
      bodies: new Map(),
      registry: { version: 1, entries: [] },
    });
    const uidOf = (title, scope) => catalogue.items
      .find((i) => i.title === title && i.scope.join(' ') === scope)?.uid ?? null;
    const first = uidOf('works', 'a');
    const second = uidOf('works', 'b');
    assert.ok(first && second, 'the catalogue gave both cases a uid');
    assert.notEqual(first, second, 'the two describes are two different cases');

    // The run side: the report carries the describe path, and each case
    // binds to its own TestDefinition.
    //
    // The report names the files relative to the Playwright `rootDir`,
    // while the registry stores them relative to the project root -- the
    // same reconciliation the bridge does.
    const summary = {
      rootDir: path.join(p.projectDir, 'tests').replace(/\\/g, '/'),
      cases: [
        { title: 'works', file: 'd.spec.ts', line: 5, scope: ['a'], status: 'expected', duration: 1, retry: 0 },
        { title: 'works', file: 'd.spec.ts', line: 5, scope: ['b'], status: 'unexpected', duration: 1, retry: 0 },
      ],
    };
    const attempts = attemptsForRun(
      { uid: 'run_1_' + '4'.repeat(24), projectUid: p.projectUid, projectRoot: p.projectDir },
      summary,
      { version: 1, projects: { [p.projectUid]: catalogue.registry } }
    );
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].testUid, first, 'the first describe binds to its own uid');
    assert.equal(attempts[1].testUid, second, 'the second describe binds to its own uid');
    assert.equal(attempts[0].uidBasis, 'file-scope-title');
  } finally { p.cleanup(); }
});

test('UT-ATS204-027 (X1): an explicit token the catalogue judged DUPLICATE is not bound', () => {
  const p = makeProject();
  try {
    // The PRODUCTION path: the catalogue judges the token duplicated, and
    // the run side has to agree with that judgement.
    const catalogue = resolveAuthoritativeIdentities({
      projectUid: p.projectUid,
      cases: [
        { file: 'tests/a.spec.ts', title: 'checkout @TC-001', line: 3, column: 3, describePath: [], projects: [], tags: [], reportOrder: 0 },
        { file: 'tests/b.spec.ts', title: 'refund @TC-001', line: 3, column: 3, describePath: [], projects: [], tags: [], reportOrder: 1 },
      ],
      bodies: new Map(),
      registry: { version: 1, entries: [] },
    });
    // The catalogue says neither of them owns the token.
    assert.ok(catalogue.items.every((i) => i.ambiguity?.reason === 'duplicate-explicit-uid'),
      'the catalogue judged the token duplicated');
    assert.ok(catalogue.registry.entries.every((e) => e.duplicateExplicit === 'tc-001'),
      'the verdict is recorded in the registry');

    // The run covers only ONE of the two files: the token is unique IN THIS
    // RUN, but it is not unique in the project. The run side must not bind
    // it -- the two cases would end up with the same UID.
    const attempts = attemptsForRun(
      { uid: 'run_1_' + '5'.repeat(24), projectUid: p.projectUid, projectRoot: p.projectDir },
      {
        rootDir: path.join(p.projectDir, 'tests').replace(/\\/g, '/'),
        cases: [{ title: 'refund @TC-001', file: 'b.spec.ts', line: 3, status: 'expected', duration: 1, retry: 0 }],
      },
      { version: 1, projects: { [p.projectUid]: catalogue.registry } }
    );
    assert.equal(attempts[0].testUid, null, 'the token binds nothing');
    assert.equal(attempts[0].uidBasis, 'explicit-ambiguous');
    assert.equal(attempts[0].uidAmbiguity.reason, 'duplicate-explicit-uid');
  } finally { p.cleanup(); }
});

test('UT-ATS204-037 (X3): the STATIC catalogue also records the duplicate verdict, so a single-file run does not bind it', () => {
  // The STATIC index is the DEFAULT one: an untrusted project never runs
  // `--list`, so its catalogue is the one the run side has to agree with.
  // The static index judges the token duplicated too -- but the verdict used
  // to live on the CANDIDATE only, and the run side never sees the
  // candidates: it sees the REGISTRY. So the verdict was lost on the way,
  // and a run of one of the two files bound the token to that one case --
  // the very mis-association the catalogue's verdict forbids.
  const p = makeProject();
  try {
    p.write('tests/a.spec.ts', "import { test } from '@playwright/test';\n\ntest('checkout @TC-001', async () => { const a = 1; });\n");
    p.write('tests/b.spec.ts', "import { test } from '@playwright/test';\n\ntest('refund @TC-001', async () => { const b = 2; });\n");

    const catalogue = discoverStatic(p.project, emptyRegistry());
    // The catalogue judges the token duplicated ...
    assert.equal(catalogue.tests.length, 2);
    assert.ok(catalogue.tests.every((t) => t.ambiguity?.reason === 'duplicate-explicit-uid'),
      'the static catalogue judged the token duplicated');
    // ... and the verdict reaches the REGISTRY, which is what the run side
    // reads.
    const entries = catalogue.registry.projects[p.projectUid].entries;
    assert.equal(entries.length, 2, 'both cases are in the registry');
    assert.ok(entries.every((e) => e.duplicateExplicit === 'tc-001'),
      'the verdict is recorded on the registry entries');

    // The run covers only ONE of the two files: the token is unique IN THIS
    // RUN, but it is not unique in the project. The run side must agree
    // with the catalogue and bind NOTHING.
    const attempts = attemptsForRun(
      { uid: 'run_1_' + '6'.repeat(24), projectUid: p.projectUid, projectRoot: p.projectDir },
      {
        rootDir: path.join(p.projectDir, 'tests').replace(/\\/g, '/'),
        cases: [{ title: 'refund @TC-001', file: 'b.spec.ts', line: 3, status: 'expected', duration: 1, retry: 0 }],
      },
      { version: 1, projects: { [p.projectUid]: catalogue.registry.projects[p.projectUid] } }
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].testUid, null, 'the token binds nothing');
    assert.equal(attempts[0].uidBasis, 'explicit-ambiguous');
    assert.equal(attempts[0].uidAmbiguity.reason, 'duplicate-explicit-uid');
  } finally { p.cleanup(); }
});

test('UT-ATS204-038 (X2s): the static catalogue forgets the verdict once the duplicate is gone', () => {
  // The verdict is a statement about the project AS IT IS NOW. When the
  // second `@TC-001` is removed, the token is unique again -- and a run of
  // the file that carries it must bind it. A verdict that outlived the
  // duplicate would lock the token out of the project for good.
  const p = makeProject();
  try {
    p.write('tests/a.spec.ts', "import { test } from '@playwright/test';\n\ntest('checkout @TC-001', async () => { const a = 1; });\n");
    p.write('tests/b.spec.ts', "import { test } from '@playwright/test';\n\ntest('refund @TC-001', async () => { const b = 2; });\n");

    const first = discoverStatic(p.project, emptyRegistry());
    assert.ok(first.registry.projects[p.projectUid].entries.every((e) => e.duplicateExplicit === 'tc-001'),
      'the duplicate is recorded');

    // The duplicate is fixed: b no longer carries the token.
    p.write('tests/b.spec.ts', "import { test } from '@playwright/test';\n\ntest('refund', async () => { const b = 2; });\n");
    const second = discoverStatic(p.project, first.registry);
    const entries = second.registry.projects[p.projectUid].entries;
    assert.ok(!entries.some((e) => e.duplicateExplicit),
      'no entry keeps the stale verdict');
    assert.ok(entries.some((e) => e.uid === 'tc-001'),
      'the token belongs to the case that carries it');

    // A run of that one file binds the token again.
    const attempts = attemptsForRun(
      { uid: 'run_1_' + '7'.repeat(24), projectUid: p.projectUid, projectRoot: p.projectDir },
      {
        rootDir: path.join(p.projectDir, 'tests').replace(/\\/g, '/'),
        cases: [{ title: 'checkout @TC-001', file: 'a.spec.ts', line: 3, status: 'expected', duration: 1, retry: 0 }],
      },
      { version: 1, projects: { [p.projectUid]: second.registry } }
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].testUid, 'tc-001', 'the token binds again');
    assert.equal(attempts[0].uidBasis, 'explicit');
  } finally { p.cleanup(); }
});

test('UT-ATS204-028: the anchor counts the CLI\'s REPORT order, not the title-sorted order', () => {
  // The catalogue's display order is sorted by title; the CLI reports the
  // renders in the order the template GENERATED them. The anchor's ordinal
  // counts the latter -- otherwise a re-worded title would shift every
  // ordinal after it.
  const cases = [
    { file: 'tests/dyn.spec.ts', title: 'adds 2 items', line: 7, scope: [], reportOrder: 0 },
    { file: 'tests/dyn.spec.ts', title: 'adds 1 items', line: 7, scope: [], reportOrder: 1 },
  ];
  const groups = groupByPosition(cases);
  const key = positionKey('tests/dyn.spec.ts', 7, []);
  assert.equal(groups.get(key).length, 2);
  assert.equal(groups.get(key)[0].title, 'adds 2 items',
    'the group keeps the CLI report order, not the title-sorted one');

  const decisions = reidentifyRendered({
    cases,
    entries: [
      { uid: 'tc-1', title: 'adds 2 items', anchor: { file: 'tests/dyn.spec.ts', line: 7, scope: [], ordinal: 0, count: 2 } },
      { uid: 'tc-2', title: 'adds 1 items', anchor: { file: 'tests/dyn.spec.ts', line: 7, scope: [], ordinal: 1, count: 2 } },
    ],
    groups,
  });
  // The title still claims the registry's case: the anchor adds nothing.
  assert.equal(decisions.get(cases[0]), undefined);
  assert.equal(decisions.get(cases[1]), undefined);
});

test('UT-ATS204-029: the anchor does not decide a case the scanner CAN see', () => {
  // A SOURCE case has a body of its own. The body (and the title) are
  // stronger signals than an ordinal, so the anchor does not decide it.
  const cases = [{ file: 'tests/a.spec.ts', title: 'new title', line: 3, scope: [], source: true }];
  const decisions = reidentifyRendered({
    cases,
    entries: [{ uid: 'tc-1', title: 'old title', anchor: { file: 'tests/a.spec.ts', line: 3, scope: [], ordinal: 0, count: 1 } }],
  });
  assert.equal(decisions.get(cases[0]), undefined,
    'the anchor does not decide a case with a body of its own');
});

test('UT-ATS204-030: a partly rewritten group is reported and binds nothing', () => {
  // One render was removed and another was added: the group has the SAME
  // SIZE, but the ordinals may have shifted. Binding by ordinal would hand
  // the new render the uid of the one that vanished.
  const cases = [
    { file: 'tests/dyn.spec.ts', title: 'user alice', line: 7, scope: [] },
    { file: 'tests/dyn.spec.ts', title: 'user dave', line: 7, scope: [] },
  ];
  const decisions = reidentifyRendered({
    cases,
    entries: [
      { uid: 'tc-alice', title: 'user alice', anchor: { file: 'tests/dyn.spec.ts', line: 7, scope: [], ordinal: 0, count: 2 } },
      { uid: 'tc-bob', title: 'user bob', anchor: { file: 'tests/dyn.spec.ts', line: 7, scope: [], ordinal: 1, count: 2 } },
    ],
  });
  const dave = decisions.get(cases[1]);
  assert.ok(dave, 'the new render is decided -- by NOT deciding it');
  assert.equal(dave.uid, null, 'nothing is bound');
  assert.equal(dave.ambiguity.reason, AMBIGUITY.RENDER_PARTIAL);
  assert.deepEqual(dave.ambiguity.candidates.sort(), ['tc-alice', 'tc-bob']);
});

test('UT-ATS204-031: two anchors at the same ordinal are reported, not resolved', () => {
  // Two registry entries claim the SAME ordinal of the same position. The
  // mapper cannot say which of them the render is, so it reports them.
  const cases = [{ file: 'tests/dyn.spec.ts', title: 'user dave', line: 7, scope: [] }];
  const decisions = reidentifyRendered({
    cases,
    entries: [
      { uid: 'tc-one', title: 'user bob', anchor: { file: 'tests/dyn.spec.ts', line: 7, scope: [], ordinal: 0, count: 1 } },
      { uid: 'tc-two', title: 'user carol', anchor: { file: 'tests/dyn.spec.ts', line: 7, scope: [], ordinal: 0, count: 1 } },
    ],
  });
  const decision = decisions.get(cases[0]);
  assert.ok(decision, 'the render is decided -- by NOT deciding it');
  assert.equal(decision.uid, null);
  assert.equal(decision.ambiguity.reason, AMBIGUITY.RENDER_AMBIGUOUS);
  assert.deepEqual(decision.ambiguity.candidates.sort(), ['tc-one', 'tc-two']);
});

test('UT-ATS204-039 (N4): the anchor does not hand a SOURCE case its uid to a different case at the same position', () => {
  // A source case has a body of its own, and the registry remembers it. A
  // case with a DIFFERENT title at that position is a different case -- or
  // the old case with a rewritten body, and a rewritten body means a new
  // identity (the ATS-201 boundary). Either way the anchor does not decide
  // it: the old uid would link the old evidence to a different case.
  const cases = [{ file: 'tests/a.spec.ts', title: 'search x', line: 3, scope: [] }];
  const decisions = reidentifyRendered({
    cases,
    entries: [{
      uid: 'tc-source',
      title: 'login works',
      bodyKey: 'k1',
      anchor: { file: 'tests/a.spec.ts', line: 3, scope: [], ordinal: 0, count: 1 },
    }],
  });
  const decision = decisions.get(cases[0]);
  assert.ok(decision, 'the case is decided -- by NOT deciding it');
  assert.equal(decision.uid, null, 'the source case keeps its uid');
  assert.equal(decision.ambiguity.reason, AMBIGUITY.RENDER_SOURCE_ENTRY);
  assert.deepEqual(decision.ambiguity.candidates, ['tc-source']);
});

test('UT-ATS204-040 (N4): a DYNAMIC entry may still be recognised by the anchor', () => {
  // Rule 4 is about the SOURCE entry: a dynamic case carries no body key
  // (the body at that position belongs to the TEMPLATE), so the anchor may
  // still recognise it. That is what the anchor is FOR.
  const cases = [{ file: 'tests/dyn.spec.ts', title: 'user dave', line: 7, scope: [] }];
  const decisions = reidentifyRendered({
    cases,
    entries: [{
      uid: 'tc-dynamic',
      title: 'user bob',
      bodyKey: null,
      anchor: { file: 'tests/dyn.spec.ts', line: 7, scope: [], ordinal: 0, count: 1 },
    }],
  });
  const decision = decisions.get(cases[0]);
  assert.ok(decision, 'the render is decided');
  assert.equal(decision.uid, 'tc-dynamic');
  assert.equal(decision.basis, 'position-anchor');
});

test('UT-ATS204-032: a group that grew reports the shift', () => {
  // The template gained a render: the group is bigger than it was, so the
  // ordinals may have shifted.
  const cases = [
    { file: 'tests/dyn.spec.ts', title: 'user zoe', line: 7, scope: [] },
    { file: 'tests/dyn.spec.ts', title: 'user alice', line: 7, scope: [] },
  ];
  const decisions = reidentifyRendered({
    cases,
    entries: [
      { uid: 'tc-alice', title: 'user alice', anchor: { file: 'tests/dyn.spec.ts', line: 7, scope: [], ordinal: 0, count: 1 } },
    ],
  });
  const zoe = decisions.get(cases[0]);
  assert.ok(zoe, 'the new render is decided -- by NOT deciding it');
  assert.equal(zoe.uid, null);
  assert.equal(zoe.ambiguity.reason, AMBIGUITY.RENDER_SHIFT);
  assert.equal(zoe.ambiguity.previousCount, 1);
  assert.equal(zoe.ambiguity.currentCount, 2);
});

test('UT-ATS204-033: the anchor of a case names its position and its ordinal', () => {
  const cases = [
    { file: 'tests/dyn.spec.ts', title: 'adds 1 item', line: 7, scope: [], reportOrder: 0 },
    { file: 'tests/dyn.spec.ts', title: 'adds 2 items', line: 7, scope: [], reportOrder: 1 },
  ];
  const groups = groupByPosition(cases);
  const anchor = anchorOf(cases[1], groups);
  assert.equal(anchor.kind, 'position');
  assert.equal(anchor.file, 'tests/dyn.spec.ts');
  assert.equal(anchor.line, 7);
  assert.deepEqual(anchor.scope, []);
  assert.equal(anchor.ordinal, 1, 'the ordinal is the index in the report order');
  assert.equal(anchor.count, 2);
});

test('UT-ATS204-034: two entries that share the file, the line and the title stay unbound', () => {
  // Two entries share the file, the line AND the title: the position does
  // not identify either of them, and without a body nothing can.
  const entries = [
    { uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: null, file: 'tests/a.spec.ts', title: 'works', line: 3, aliases: [] },
    { uid: 'tc_1_d_bbbbbbbbbbbbbbbb', bodyKey: null, file: 'tests/a.spec.ts', title: 'works', line: 3, aliases: [] },
  ];
  const hit = bindReported({ entries, file: 'tests/a.spec.ts', title: 'works', line: 3 });
  assert.equal(hit.uid, null, 'the case stays unbound');
  // The group is ambiguous as a whole, so the file+title signal is the one
  // that reports it (the line cannot pick one of the two either).
  assert.equal(hit.basis, 'file-title-ambiguous');
  assert.equal(hit.ambiguity.reason, AMBIGUITY.SAME_TITLE);
  assert.deepEqual(hit.ambiguity.candidates.sort(), ['tc_1_d_aaaaaaaaaaaaaaaa', 'tc_1_d_bbbbbbbbbbbbbbbb']);
});

test('UT-ATS204-034B: the file-line signal reports when it cannot pick one', () => {
  // The two entries share the file and the title but sit on DIFFERENT
  // lines, and the report names a line that holds neither of them -- so
  // the file-line signal finds two candidates and reports them.
  const entries = [
    { uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: null, file: 'tests/a.spec.ts', title: 'works', line: 3, aliases: [] },
    { uid: 'tc_1_d_bbbbbbbbbbbbbbbb', bodyKey: null, file: 'tests/a.spec.ts', title: 'works', line: 3, aliases: [] },
  ];
  // The same title, but the reported line does not match either entry's
  // line: the positional hit finds the two entries by title only.
  const hit = bindReported({
    entries: entries.map((e) => ({ ...e, title: 'other' })),
    file: 'tests/a.spec.ts', title: 'other', line: 3,
  });
  assert.equal(hit.uid, null);
  assert.equal(hit.basis, 'file-title-ambiguous');
});

test('UT-ATS204-035: two entries under the same describe path and title are ambiguous', () => {
  const entries = [
    { uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: null, file: 'tests/a.spec.ts', title: 'works', line: 3, scope: ['g'], aliases: [] },
    { uid: 'tc_1_d_bbbbbbbbbbbbbbbb', bodyKey: null, file: 'tests/a.spec.ts', title: 'works', line: 9, scope: ['g'], aliases: [] },
  ];
  const hit = bindReported({ entries, file: 'tests/a.spec.ts', title: 'works', scope: ['g'] });
  assert.equal(hit.uid, null);
  assert.equal(hit.basis, 'file-scope-title-ambiguous');
  assert.equal(hit.ambiguity.reason, AMBIGUITY.SAME_SCOPE_TITLE);
});

test('UT-ATS204-036: the scope signal needs the body to AGREE', () => {
  // The describe path is a position, not an identity: a hit whose body
  // disagrees is a stale-position coincidence and does not bind.
  const entries = [{
    uid: 'tc_1_d_aaaaaaaaaaaaaaaa', bodyKey: 'k1', file: 'tests/a.spec.ts', title: 'works', line: 3, scope: ['g'], aliases: [],
  }];
  const disagrees = bindReported({
    entries, file: 'tests/a.spec.ts', title: 'works', line: 3, scope: ['g'],
    bodyKey: 'k9', bodyCounts: new Map([['k9', 1]]),
  });
  assert.equal(disagrees.uid, null, 'the positional hit does not bind');
  assert.equal(disagrees.basis, 'file-line-body-mismatch');
  assert.equal(disagrees.ambiguity.reason, AMBIGUITY.BODY);
});
