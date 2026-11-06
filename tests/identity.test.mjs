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
import { bindReported, groupByPosition, positionKey, reidentifyRendered, AMBIGUITY } from '../server/identity.mjs';
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
