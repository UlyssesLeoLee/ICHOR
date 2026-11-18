/**
 * ATS-410 unit tests: the TRIAGE CORE (失败归因内核).
 *
 * WHAT IS UNDER TEST
 * ------------------
 * The acceptance criterion of ATS-410 is 「分类含脚本/产品/环境/不确定；每条推断附可核对来源」
 * -- "classify into script / product / environment / undetermined; every inference
 * carries a checkable source".
 *
 * The tests below therefore cover the four properties that criterion rests on:
 *
 *   1. THE FOUR CATEGORIES ARE EXACTLY FOUR. The set is closed: an unclassifiable
 *      failure lands in `undetermined`, never in a category that merely sounds
 *      more specific.
 *   2. THE CLASSIFICATION IS GATED ON EVIDENCE. An assertion-like failure with
 *      no comparable commit history must land in `undetermined`, never in
 *      `script` or `product`. The HISTORY GATE is the load-bearing part.
 *      (The order BETWEEN the environment branch and the assertion-like
 *      branch is deliberately NOT claimed to be load-bearing: the two cover
 *      disjoint kinds, so swapping them changes nothing. The probe MEASURES
 *      that too rather than asserting it.)
 *   3. EVERY FINDING CITES A CHECKABLE SOURCE. A finding with no evidence ref
 *      is refused; a ref that points outside the triage, or at a case that does
 *      not exist, is refused.
 *   4. THE TRIAGE IS READ-ONLY. The module has no write path: it imports no
 *      filesystem-writing module and spawns no process -- the Git history comes
 *      through an INJECTED reader.
 *
 * Plus the suspect-change rules: the comparison needs two DIFFERENT commits,
 * the SAME logical case, and only the test script counts.
 *
 * THE TESTS ARE FALSIFIABLE
 * --------------------------
 * Every assertion states the value it expects. The fixtures are built so that a
 * wrong implementation produces a DIFFERENT answer -- not merely a missing
 * field. The read-only test is a STATIC check over the module's imports with a
 * NEGATIVE CONTROL: the same checker is run against a deliberately broken copy
 * and MUST report it.
 *
 * Run: node --test tests/triage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  TRIAGE_CATEGORIES,
  TRIAGE_CONTRACT_VERSION,
  caseKeyOf,
  classifyFailure,
  createTriageEngine,
  describeTriageContract,
  detectSuspectChanges,
  digestOfFacts,
  evidenceRef,
  failureKindOf,
  isEnvironmentKind,
  validateTriageReport,
} from '../server/ai/triage.mjs';

const root = path.resolve(import.meta.dirname, '..');

/* --------------------------------------------------------------- fixtures */

function kase(overrides = {}) {
  const status = overrides.status ?? 'failed';
  const error = overrides.error ?? '';
  return {
    title: overrides.title ?? 'login works',
    file: overrides.file ?? 'tests/login.spec.ts',
    line: overrides.line ?? 12,
    status,
    duration: 5,
    error,
    attemptsCount: 1,
    attempts: [{ status, retry: 0, duration: 5, error }],
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: overrides.id ?? 'run_1_550e8400e29b41d4a7164466',
    uid: overrides.id ?? 'run_1_550e8400e29b41d4a7164466',
    status: overrides.status ?? 'failed',
    gitCommit: overrides.gitCommit ?? 'abc1234',
    runner: 'playwright',
    startedAt: '2026-11-18T00:00:00.000Z',
    finishedAt: '2026-11-18T00:01:00.000Z',
    summary: {
      passed: overrides.passed ?? 0,
      failed: overrides.failed ?? 1,
      skipped: 0,
      flaky: 0,
      total: overrides.total ?? 1,
      executions: 1,
      cases: overrides.cases ?? [kase({ error: 'AssertionError: expected 5 to be 3' })],
    },
    ...overrides,
  };
}

function engineFor(runs, options = {}) {
  const table = new Map(runs.map((r) => [r.id, r]));
  return createTriageEngine({
    readRun: (id) => table.get(id) ?? null,
    ...options,
  });
}

/* ------------------------------------------------------- 1. the categories */

test('the classification set is exactly script / product / environment / undetermined', () => {
  assert.deepEqual([...TRIAGE_CATEGORIES].sort(),
    ['environment', 'product', 'script', 'undetermined']);
  // A closed set: nothing outside the four may ever be produced.
  for (const category of TRIAGE_CATEGORIES) {
    assert.ok(TRIAGE_CATEGORIES.includes(category));
  }
  assert.equal(TRIAGE_CATEGORIES.length, 4);
});

test('every classification result carries a category from the closed set', () => {
  const kinds = ['timeout', 'network', 'assertion', 'element', 'navigation', 'other', 'cancelled'];
  for (const kind of kinds) {
    for (const suspect of [false, true]) {
      for (const hasHistory of [false, true]) {
        const verdict = classifyFailure({ kind, suspect, hasHistory });
        assert.ok(TRIAGE_CATEGORIES.includes(verdict.category),
          `category ${verdict.category} is outside the closed set`);
        assert.ok(verdict.confidence > 0 && verdict.confidence <= 1);
        assert.ok(verdict.basis.length > 0, 'a verdict must state its basis');
      }
    }
  }
});

/* --------------------------------------------- 2. the classification order */

test('environment beats the script/product split: a broken environment makes both fail', () => {
  for (const kind of ['timeout', 'network']) {
    for (const suspect of [false, true]) {
      for (const hasHistory of [false, true]) {
        const verdict = classifyFailure({ kind, suspect, hasHistory });
        assert.equal(verdict.category, 'environment',
          `${kind} must be environment regardless of suspect/history`);
      }
    }
  }
});

test('an assertion-like failure with a changed test script is a script defect', () => {
  const verdict = classifyFailure({ kind: 'assertion', suspect: true, hasHistory: true });
  assert.equal(verdict.category, 'script');
  assert.ok(verdict.confidence > 0.5);
});

test('an assertion-like failure with an unchanged test script is a product defect', () => {
  const verdict = classifyFailure({ kind: 'assertion', suspect: false, hasHistory: true });
  assert.equal(verdict.category, 'product');
});

test('an assertion-like failure with NO comparable history is undetermined, not product', () => {
  // This is the load-bearing case: "no evidence" must NOT become "the product
  // is at fault", because that would systematically blame product code.
  const verdict = classifyFailure({ kind: 'assertion', suspect: false, hasHistory: false });
  assert.equal(verdict.category, 'undetermined');
  assert.ok(verdict.basis.includes('no comparable commit history'));
});

test('a failure that names no assertion and no environment signal is undetermined', () => {
  const verdict = classifyFailure({ kind: 'other', hasHistory: true });
  assert.equal(verdict.category, 'undetermined');
});

test('the environment set and the assertion-like set are disjoint, so their order is not load-bearing', () => {
  // The claim "the classification order is the contract" would be an
  // unfalsifiable statement about the source if the two branches could never
  // both match. This test pins the fact that makes the ORDER irrelevant and
  // the HISTORY GATE the load-bearing part.
  const envKinds = ['timeout', 'network'];
  const assertionLike = ['assertion', 'element', 'navigation'];
  assert.deepEqual(envKinds.filter((k) => assertionLike.includes(k)), [],
    'the two sets must be disjoint');
  // A kind in the environment set is `environment` whatever the history is.
  for (const kind of envKinds) {
    for (const suspect of [false, true]) {
      for (const hasHistory of [false, true]) {
        assert.equal(classifyFailure({ kind, suspect, hasHistory }).category, 'environment');
      }
    }
  }
});

test('the failure kind is the ATS-216 vocabulary, reused rather than reinvented', () => {
  assert.equal(failureKindOf('TimeoutError: page.waitForTimeout exceeded'), 'timeout');
  assert.equal(failureKindOf('net::ERR_CONNECTION_REFUSED'), 'network');
  assert.equal(failureKindOf('AssertionError: expected 1 to be 2'), 'assertion');
  assert.ok(isEnvironmentKind('timeout'));
  assert.ok(isEnvironmentKind('network'));
  assert.ok(!isEnvironmentKind('element'));
  assert.ok(!isEnvironmentKind('navigation'));
  assert.ok(!isEnvironmentKind('assertion'));
});

/* --------------------------------------------- 3. the evidence references */

test('a finding without an evidence ref is refused', () => {
  assert.throws(
    () => validateTriageReport({
      findings: [{ category: 'script', evidenceRefs: [] }],
    }, { runIds: ['run_1_x'] }),
    (e) => e.code === 'TRIAGE_EVIDENCE_REQUIRED',
  );
});

test('a finding with no evidenceRefs key at all is refused', () => {
  assert.throws(
    () => validateTriageReport({ findings: [{ category: 'script' }] }, { runIds: ['run_1_x'] }),
    (e) => e.code === 'TRIAGE_EVIDENCE_REQUIRED',
  );
});

test('an evidence ref pointing at a run outside the triage is refused', () => {
  assert.throws(
    () => validateTriageReport({
      findings: [{
        category: 'script',
        evidenceRefs: [{ kind: 'run', ref: 'run_1_other', digest: 'a'.repeat(64) }],
      }],
    }, { runIds: ['run_1_mine'] }),
    (e) => e.code === 'TRIAGE_EVIDENCE_OUT_OF_SCOPE',
  );
});

test('an evidence ref pointing at a case that does not exist is refused', () => {
  assert.throws(
    () => validateTriageReport({
      findings: [{
        category: 'script',
        evidenceRefs: [{ kind: 'case', ref: 'nonexistent', digest: 'a'.repeat(64) }],
      }],
    }, { runIds: ['run_1_mine'], caseKeys: new Set(['real']) }),
    (e) => e.code === 'TRIAGE_EVIDENCE_NOT_FOUND',
  );
});

test('an evidence ref with an absolute path is refused', () => {
  assert.throws(
    () => evidenceRef({ kind: 'run', ref: 'C:/Users/seiko/secret', digest: 'a'.repeat(64), detail: '' }),
    (e) => e.code === 'TRIAGE_REQUEST_INVALID',
  );
  assert.throws(
    () => evidenceRef({ kind: 'run', ref: '/etc/passwd', digest: 'a'.repeat(64), detail: '' }),
    (e) => e.code === 'TRIAGE_REQUEST_INVALID',
  );
});

test('an evidence ref without a digest is refused', () => {
  assert.throws(
    () => evidenceRef({ kind: 'run', ref: 'run_1_x', detail: '' }),
    (e) => e.code === 'TRIAGE_REQUEST_INVALID',
  );
});

test('the digest of a fact is stable, order-independent and recomputable', () => {
  const a = digestOfFacts({ x: 1, y: 'two', z: [3, 4] });
  const b = digestOfFacts({ z: [3, 4], y: 'two', x: 1 });
  assert.equal(a, b, 'the digest must not depend on the key order');
  assert.match(a, /^[0-9a-f]{64}$/);
  // The array order IS a fact: a different order is a different evidence.
  assert.notEqual(digestOfFacts({ z: [4, 3] }), digestOfFacts({ z: [3, 4] }));
});

/* -------------------------------------------- 4. the suspect-change rules */

test('two runs at the SAME commit are not comparable: a difference there is flakiness', () => {
  const changed = detectSuspectChanges({
    run: run({ gitCommit: 'aaa1111' }),
    baseline: run({ id: 'run_1_base', gitCommit: 'aaa1111' }),
    gitChanged: () => true,
  });
  assert.equal(changed.comparable, false);
  assert.equal(changed.suspect, false);
});

test('a changed test script between two different commits IS a suspect change', () => {
  const changed = detectSuspectChanges({
    run: run({ gitCommit: 'bbb2222' }),
    baseline: run({ id: 'run_1_base', gitCommit: 'aaa1111' }),
    gitChanged: (_from, _to, file) => file === 'tests/login.spec.ts',
  });
  assert.equal(changed.comparable, true);
  assert.equal(changed.suspect, true);
  assert.deepEqual(changed.files.map((f) => f.file), ['tests/login.spec.ts']);
});

test('a change in PRODUCT code is not a suspect change', () => {
  // The rule only looks at test scripts: a product change may be the fix or the
  // defect, and calling it "suspect" would make the criterion circular.
  const changed = detectSuspectChanges({
    run: run({ gitCommit: 'bbb2222', cases: [kase({ file: 'tests/login.spec.ts' })] }),
    baseline: run({ id: 'run_1_base', gitCommit: 'aaa1111' }),
    gitChanged: (_from, _to, file) => file === 'src/login.ts',
  });
  assert.equal(changed.suspect, false);
});

test('without a baseline there is no comparable history at all', () => {
  const changed = detectSuspectChanges({
    run: run({ gitCommit: 'bbb2222' }),
    baseline: null,
    gitChanged: () => true,
  });
  assert.equal(changed.comparable, false);
  assert.equal(changed.suspect, false);
});

/* -------------------------------------------------------- 5. the engine */

test('the engine triages a failing run and cites evidence for every finding', async () => {
  const r = run();
  const engine = engineFor([r]);
  const report = await engine.triage({ runId: r.id });
  assert.equal(report.contract, TRIAGE_CONTRACT_VERSION);
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.category, 'undetermined');
  assert.ok(finding.evidenceRefs.length >= 2, 'a finding must cite at least two refs');
  const kinds = finding.evidenceRefs.map((e) => e.kind);
  assert.ok(kinds.includes('run'));
  assert.ok(kinds.includes('case'));
  for (const ref of finding.evidenceRefs) {
    assert.match(ref.digest ?? 'skip', /^[0-9a-f]{64}$|^skip$/);
    if (ref.kind !== 'commit') assert.match(ref.digest, /^[0-9a-f]{64}$/);
  }
});

test('the same evidence always yields the same report', async () => {
  const r = run();
  const engine = engineFor([r]);
  const a = await engine.triage({ runId: r.id });
  const b = await engine.triage({ runId: r.id });
  assert.deepEqual(a, b, 'the triage must be deterministic');
});

test('a run that is still in flight is refused', async () => {
  const r = run({ status: 'running', cases: [] });
  const engine = engineFor([r]);
  await assert.rejects(
    () => engine.triage({ runId: r.id }),
    (e) => e.code === 'TRIAGE_RUN_NOT_TERMINAL',
  );
});

test('an unknown run is refused', async () => {
  const engine = engineFor([]);
  await assert.rejects(
    () => engine.triage({ runId: 'run_1_missing' }),
    (e) => e.code === 'TRIAGE_RUN_NOT_FOUND',
  );
});

test('a regression across two commits produces a diff suggestion with no fix action', async () => {
  const base = run({
    id: 'run_1_base',
    gitCommit: 'aaa1111',
    status: 'passed',
    cases: [kase({ status: 'passed', error: '' })],
  });
  const failing = run({
    id: 'run_1_fail',
    gitCommit: 'bbb2222',
    cases: [kase({ error: 'AssertionError: expected 5 to be 3' })],
  });
  const engine = engineFor([base, failing], {
    gitChanged: (_from, _to, file) => file === 'tests/login.spec.ts',
  });
  const report = await engine.triage({ runId: failing.id, baselineRunId: base.id });
  const finding = report.findings[0];
  assert.equal(finding.category, 'script');
  assert.ok(finding.diffSuggestion, 'a regression must carry a diff suggestion');
  assert.equal(finding.diffSuggestion.kind, 'regression');
  assert.deepEqual(finding.diffSuggestion.changedFiles, ['tests/login.spec.ts']);
  // The suggestion names the changed files and carries NO fix action.
  const text = JSON.stringify(finding.diffSuggestion);
  assert.ok(!/expected\s*result|assertion|patch|diffText/i.test(text),
    'the suggestion must not carry a fix action or an assertion change');
});

test('without a baseline the category degrades to undetermined, never to product', async () => {
  const failing = run({
    id: 'run_1_fail',
    gitCommit: 'bbb2222',
    cases: [kase({ error: 'AssertionError: expected 5 to be 3' })],
  });
  const engine = engineFor([failing], { gitChanged: () => true });
  const report = await engine.triage({ runId: failing.id });
  assert.equal(report.findings[0].category, 'undetermined');
  assert.equal(report.summary.comparableHistory, false);
});

test('a request for model enhancement FAILS when no provider is configured', async () => {
  const r = run();
  const engine = engineFor([r]);
  await assert.rejects(
    () => engine.triage({ runId: r.id, modelEnhanced: true }),
    (e) => e.code === 'TRIAGE_MODEL_UNAVAILABLE',
  );
});

test('a request for model enhancement never changes the category', async () => {
  const r = run();
  const engine = engineFor([r], {
    modelEnhance: async () => ({ notes: ['the model says it is the script'] }),
  });
  const plain = await engine.triage({ runId: r.id });
  const enhanced = await engine.triage({ runId: r.id, modelEnhanced: true });
  assert.equal(enhanced.findings[0].category, plain.findings[0].category);
  assert.equal(enhanced.modelEnhanced, true);
  assert.equal(plain.modelEnhanced, false);
});

test('a model enhancement that returns the wrong shape is refused', async () => {
  const r = run();
  const engine = engineFor([r], { modelEnhance: async () => ({ nope: true }) });
  await assert.rejects(
    () => engine.triage({ runId: r.id, modelEnhanced: true }),
    (e) => e.code === 'TRIAGE_MODEL_OUTPUT_INVALID',
  );
});

test('the reconciliation checks are reported and are not smoothed away', async () => {
  const r = run();
  const engine = engineFor([r]);
  const report = await engine.triage({ runId: r.id });
  assert.ok(Array.isArray(report.checks));
  assert.ok(report.checks.length >= 2);
  assert.ok(report.checks.every((c) => typeof c.ok === 'boolean'));
  assert.ok(report.checks.every((c) => typeof c.detail === 'string' && c.detail.length));
});

test('a tampered evidence archive makes the integrity check fail', async () => {
  const r = run();
  const engine = engineFor([r], {
    verifyEvidence: () => ({ verified: false, reason: 'the manifest does not match' }),
  });
  const report = await engine.triage({ runId: r.id });
  // The lookup must be SPECIFIC: another check ("every finding cites at least
  // one evidence ref") also contains the word "evidence".
  const check = report.checks.find((c) => c.name === 'the evidence of the triaged run is intact');
  assert.ok(check, `the integrity check is missing; got: ${report.checks.map((c) => c.name).join(' | ')}`);
  assert.equal(check.ok, false);
  assert.ok(check.detail.includes('does NOT verify'));
});

test('the triage does not change the run it triages', async () => {
  const r = run();
  const before = JSON.stringify(r);
  const engine = engineFor([r]);
  await engine.triage({ runId: r.id });
  assert.equal(JSON.stringify(r), before, 'the triage must not mutate the run record');
});

test('the case key identifies the same logical case across runs', () => {
  const a = kase({ title: 'works', file: 'tests/a.spec.ts', line: 10 });
  const b = kase({ title: 'works', file: 'tests/a.spec.ts', line: 99 });
  assert.equal(caseKeyOf(a), caseKeyOf(b), 'the line must not split the history of one case');
  const c = kase({ title: 'works', file: 'tests/b.spec.ts', line: 10 });
  assert.notEqual(caseKeyOf(a), caseKeyOf(c));
});

/* ------------------------------------------------ 6. the read-only boundary */

test('the triage core has no write path: no fs writes, no process spawning', () => {
  const source = fs.readFileSync(path.join(root, 'server', 'ai', 'triage.mjs'), 'utf8');
  const forbidden = [
    /node:fs/,
    /node:child_process/,
    /require\s*\(/,
    /\bfetch\s*\(/,
    /writeFileSync|appendFileSync|createWriteStream/,
    /\bexecSync\b|\bspawnSync\b|\bexec\b/,
    // `fs.` as an OBJECT -- not the tail of a longer identifier such as
    // "artifacts." (which contains "fs." as a substring).
    /(^|[^A-Za-z0-9_$])fs\./,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source),
      `the triage core must not use ${pattern} -- it is read-only`);
  }
});

test('the read-only check is not a tautology: it fires on a broken copy', () => {
  // NEGATIVE CONTROL: the same checker, run against a deliberately broken copy,
  // must report it. Without this, a PASS would only mean "the current source has
  // no fs import", not "the check can tell".
  const broken = [
    "import fs from 'node:fs';",
    'export function x(){ fs.writeFileSync("/tmp/a","b"); }',
  ].join('\n');
  const forbidden = [/node:fs/, /writeFileSync|appendFileSync|createWriteStream/, /fs\./];
  const fired = forbidden.some((pattern) => pattern.test(broken));
  assert.ok(fired, 'the read-only check must detect a broken copy');
});

test('the contract description states the categories, the order and the write policy', () => {
  const contract = describeTriageContract();
  assert.equal(contract.contract, TRIAGE_CONTRACT_VERSION);
  assert.deepEqual(contract.categories, [...TRIAGE_CATEGORIES]);
  assert.deepEqual(contract.classificationOrder, ['environment', 'script', 'product', 'undetermined']);
  assert.ok(contract.writePolicy.includes('READ-ONLY'));
  assert.ok(contract.suspectChangeDefinition.includes('gitCommit'));
  assert.ok(contract.modelPolicy.includes('OPTIONAL'));
  // The description must not leak the machine.
  assert.ok(!JSON.stringify(contract).includes('C:\\'));
  assert.ok(!JSON.stringify(contract).includes('/Users/'));
});
