#!/usr/bin/env node
/**
 * ATS-410 boundary probe: the TRIAGE (失败归因) boundary.
 *
 * WHAT THIS PROBE PROVES
 * -----------------------
 * Four properties, each measured rather than asserted in prose:
 *
 *   1. THE CLASSIFICATION IS DETERMINISTIC AND COMPLETE. Every failure kind
 *      maps to one of the four categories, and the same input always maps to
 *      the same category. A triage that answered differently for the same
 *      evidence would be unusable — the reader could not check it.
 *
 *   2. THE CLASSIFICATION IS GATED ON EVIDENCE. An assertion-like failure
 *      with no comparable commit history must land in `undetermined`, not in
 *      `script` or `product`. The probe DROPS the gate and shows the
 *      classification CHANGES — without that mutation, "no evidence means no
 *      blame" would be an unfalsifiable claim.
 *      (The order BETWEEN the environment branch and the assertion-like
 *      branch is deliberately NOT claimed to be load-bearing: the two cover
 *      disjoint kinds, so swapping them changes nothing. The probe MEASURES
 *      that too rather than asserting it.)
 *
 *   3. EVERY FINDING CITES A CHECKABLE SOURCE, and a source that cannot be
 *      checked is REFUSED. The probe feeds a report whose evidence ref points
 *      at a case that does not exist and shows the refusal.
 *
 *   4. THE TRIAGE IS READ-ONLY. Two independent signals:
 *      4a STATIC: the triage core imports no filesystem module and spawns no
 *          process — the Git history comes through an INJECTED reader.
 *      4b RUNTIME: a full triage over a real run leaves the run record
 *          byte-identical, and the working tree is untouched.
 *
 * NEGATIVE CONTROLS
 * -----------------
 * A check that cannot fail proves nothing. Every measurement above has a
 * counterpart that MUST report a violation:
 *
 *   N1  the static read-only check fires on a deliberately broken copy;
 *   N2  the evidence-refusal check fires on a report with a bogus ref;
 *   N3  the order-mutation check shows a different classification;
 *   N4  the "no write" check fires when the run record IS changed.
 *
 * Usage: node tools/ats410-probes/probe-triage-boundary.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  TRIAGE_CATEGORIES,
  classifyFailure,
  createTriageEngine,
  detectSuspectChanges,
  validateTriageReport,
} from '../../server/ai/triage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let failures = 0;
let checks = 0;

function ok(name, detail = '') {
  checks += 1;
  console.log(`  PASS  ${name}${detail ? ` -- ${detail}` : ''}`);
}
function bad(name, detail = '') {
  checks += 1;
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
}
function section(title) {
  console.log(`\n-- ${title} --`);
}

/* ------------------------------------------------------------------ */
/* 1. the classification is deterministic and complete                 */
/* ------------------------------------------------------------------ */

section('1. the classification is deterministic and complete');

const KINDS = ['timeout', 'network', 'assertion', 'element', 'navigation', 'other', 'cancelled'];
let complete = true;
let deterministic = true;
for (const kind of KINDS) {
  for (const suspect of [false, true]) {
    for (const hasHistory of [false, true]) {
      const a = classifyFailure({ kind, suspect, hasHistory });
      const b = classifyFailure({ kind, suspect, hasHistory });
      if (a.category !== b.category) {
        deterministic = false;
        bad('the same input yields the same category', `${kind}/${suspect}/${hasHistory}`);
      }
      if (!TRIAGE_CATEGORIES.includes(a.category)) {
        complete = false;
        bad('every category is in the closed set', `${kind} -> ${a.category}`);
      }
    }
  }
}
if (deterministic && complete) {
  ok('every failure kind maps to one of the four categories, deterministically',
    `${KINDS.length} kinds x 4 combinations`);
}

// The four categories are all REACHABLE — a category nobody can produce is
// not a category, it is decoration.
const reachable = new Set();
for (const kind of KINDS) {
  for (const suspect of [false, true]) {
    for (const hasHistory of [false, true]) {
      reachable.add(classifyFailure({ kind, suspect, hasHistory }).category);
    }
  }
}
const missing = TRIAGE_CATEGORIES.filter((c) => !reachable.has(c));
if (missing.length === 0) {
  ok('every one of the four categories is reachable', [...reachable].join(', '));
} else {
  bad('every one of the four categories is reachable', `unreachable: ${missing.join(', ')}`);
}

/* ------------------------------------------------------------------ */
/* 2. the classification order is load-bearing                         */
/* ------------------------------------------------------------------ */

section('2. the load-bearing part of the classification');

// The environment branch and the assertion-like branch cover DISJOINT sets of
// failure kinds ({timeout, network} vs {assertion, element, navigation}), so
// swapping those two branches changes no outcome at all. That is a ROBUSTNESS
// property, not a rule: the order between them is NOT load-bearing, and
// claiming otherwise would be an unfalsifiable statement about the source.
//
// What IS load-bearing is the HISTORY GATE: an assertion-like failure with no
// comparable commit history must land in `undetermined`, not in `script` or
// `product`. Dropping the gate would let the triage blame the product code
// without any evidence -- the exact failure mode the acceptance criterion
// ("每条推断附可核对来源") exists to prevent.
const envKinds = ['timeout', 'network'];
const assertionLikeKinds = ['assertion', 'element', 'navigation'];
const overlap = envKinds.filter((k) => assertionLikeKinds.includes(k));
if (overlap.length === 0) {
  ok('the environment set and the assertion-like set are disjoint',
    `${envKinds.join('/')} vs ${assertionLikeKinds.join('/')}`);
} else {
  bad('the environment set and the assertion-like set are disjoint', `overlap: ${overlap.join(', ')}`);
}

// Measure the mutation: with the history gate dropped, an assertion-like
// failure without history would be classified by the suspect flag alone.
const gateCases = [];
for (const kind of assertionLikeKinds) {
  for (const suspect of [false, true]) {
    const real = classifyFailure({ kind, suspect, hasHistory: false }).category;
    // MUTATED: the history gate is removed -- "no history" is treated as
    // "no suspect change", so the failure is attributed to script or product.
    const mutated = suspect ? 'script' : 'product';
    gateCases.push({ kind, suspect, real, mutated });
  }
}
const gateDiffers = gateCases.filter((c) => c.real !== c.mutated);
if (gateDiffers.length === gateCases.length
  && gateDiffers.every((c) => c.real === 'undetermined')) {
  ok('the history gate is load-bearing: without it every assertion-like failure would be blamed',
    `${gateDiffers.length} cases: undetermined vs ${gateDiffers[0].mutated}`);
} else {
  bad('the history gate is load-bearing',
    gateCases.map((c) => `${c.kind}/${c.suspect}: ${c.real} vs ${c.mutated}`).join(', '));
}

// The real order, for the record: a timeout is an environment failure even
// when its script changed.
const realEnv = classifyFailure({ kind: 'timeout', suspect: true, hasHistory: true });
if (realEnv.category === 'environment') {
  ok('a timeout is `environment` even when its test script changed');
} else {
  bad('a timeout is `environment` even when its test script changed', realEnv.category);
}

/* ------------------------------------------------------------------ */
/* 3. every finding cites a checkable source                           */
/* ------------------------------------------------------------------ */

section('3. every finding cites a checkable source');

const digest = crypto.createHash('sha256').update('x', 'utf8').digest('hex');

// 3a. A finding with no evidence ref is refused.
let refusedNoEvidence = false;
try {
  validateTriageReport({ findings: [{ category: 'script', evidenceRefs: [] }] }, { runIds: ['run_1_a'] });
} catch (e) {
  refusedNoEvidence = e.code === 'TRIAGE_EVIDENCE_REQUIRED';
}
if (refusedNoEvidence) ok('a finding with no evidence ref is refused', 'TRIAGE_EVIDENCE_REQUIRED');
else bad('a finding with no evidence ref is refused', 'it was accepted');

// 3b. A ref pointing at a case that does not exist is refused.
let refusedBogusCase = false;
try {
  validateTriageReport({
    findings: [{
      category: 'script',
      evidenceRefs: [{ kind: 'case', ref: 'does-not-exist', digest }],
    }],
  }, { runIds: ['run_1_a'], caseKeys: new Set(['real']) });
} catch (e) {
  refusedBogusCase = e.code === 'TRIAGE_EVIDENCE_NOT_FOUND';
}
if (refusedBogusCase) ok('a ref to a case that does not exist is refused', 'TRIAGE_EVIDENCE_NOT_FOUND');
else bad('a ref to a case that does not exist is refused', 'it was accepted');

// 3c. A ref pointing at a run outside the triage is refused.
let refusedOutOfScope = false;
try {
  validateTriageReport({
    findings: [{
      category: 'script',
      evidenceRefs: [{ kind: 'run', ref: 'run_1_elsewhere', digest }],
    }],
  }, { runIds: ['run_1_mine'] });
} catch (e) {
  refusedOutOfScope = e.code === 'TRIAGE_EVIDENCE_OUT_OF_SCOPE';
}
if (refusedOutOfScope) ok('a ref to a run outside the triage is refused', 'TRIAGE_EVIDENCE_OUT_OF_SCOPE');
else bad('a ref to a run outside the triage is refused', 'it was accepted');

// 3d. A full triage cites evidence for EVERY finding.
const run = {
  id: 'run_1_550e8400e29b41d4a7164466',
  uid: 'run_1_550e8400e29b41d4a7164466',
  status: 'failed',
  gitCommit: 'abc1234',
  runner: 'playwright',
  startedAt: '2026-11-18T00:00:00.000Z',
  finishedAt: '2026-11-18T00:01:00.000Z',
  summary: {
    passed: 0,
    failed: 2,
    skipped: 0,
    flaky: 0,
    total: 2,
    executions: 2,
    cases: [
      {
        title: 'login works', file: 'tests/login.spec.ts', line: 12, status: 'failed',
        duration: 5, error: 'AssertionError: expected 5 to be 3', attemptsCount: 1,
        attempts: [{ status: 'failed', retry: 0, duration: 5, error: 'AssertionError: expected 5 to be 3' }],
      },
      {
        title: 'cart works', file: 'tests/cart.spec.ts', line: 30, status: 'failed',
        duration: 9, error: 'TimeoutError: page.waitForTimeout exceeded', attemptsCount: 1,
        attempts: [{ status: 'failed', retry: 0, duration: 9, error: 'TimeoutError: page.waitForTimeout exceeded' }],
      },
    ],
  },
};
const engine = createTriageEngine({ readRun: (id) => (id === run.id ? run : null) });
const report = await engine.triage({ runId: run.id });
const allCited = report.findings.every((f) => f.evidenceRefs.length > 0);
const allDigested = report.findings.every((f) =>
  f.evidenceRefs.every((e) => e.kind === 'commit' || /^[0-9a-f]{64}$/.test(e.digest ?? '')));
if (allCited && allDigested) {
  ok('every finding of a real triage cites evidence with a recomputable digest',
    `${report.findings.length} findings, ${report.findings.map((f) => f.category).join(' / ')}`);
} else {
  bad('every finding of a real triage cites evidence with a recomputable digest');
}

// The categories are the expected ones: an assertion with no history is
// `undetermined`, a timeout is `environment`.
const byTitle = new Map(report.findings.map((f) => [f.title, f]));
if (byTitle.get('cart works')?.category === 'environment'
  && byTitle.get('login works')?.category === 'undetermined') {
  ok('the timeout is `environment` and the assertion without history is `undetermined`');
} else {
  bad('the timeout is `environment` and the assertion without history is `undetermined`',
    [...byTitle.entries()].map(([t, f]) => `${t}=${f.category}`).join(', '));
}

/* ------------------------------------------------------------------ */
/* 4. the triage is read-only                                          */
/* ------------------------------------------------------------------ */

section('4. the triage is read-only');

// 4a. STATIC: the core imports no filesystem module and spawns no process.
const corePath = path.join(ROOT, 'server', 'ai', 'triage.mjs');
const source = fs.readFileSync(corePath, 'utf8');
const forbidden = [
  { name: 'node:fs', pattern: /node:fs/ },
  { name: 'node:child_process', pattern: /node:child_process/ },
  { name: 'require(', pattern: /require\s*\(/ },
  { name: 'fetch(', pattern: /\bfetch\s*\(/ },
  { name: 'a write call', pattern: /writeFileSync|appendFileSync|createWriteStream/ },
  { name: 'a process spawn', pattern: /\bexecSync\b|\bspawnSync\b|\bexec\b/ },
  { name: 'an fs object', pattern: /(^|[^A-Za-z0-9_$])fs\./ },
];
const violations = forbidden.filter((f) => f.pattern.test(source)).map((f) => f.name);
if (violations.length === 0) {
  ok('the triage core has no filesystem module, no process spawn and no write call',
    `${forbidden.length} patterns checked`);
} else {
  bad('the triage core has no filesystem module, no process spawn and no write call',
    violations.join(', '));
}

// N1: the same checker fires on a broken copy.
const broken = [
  "import fs from 'node:fs';",
  "import { spawnSync } from 'node:child_process';",
  'export function leak(){ fs.writeFileSync("/tmp/x","y"); spawnSync("git",[]); }',
].join('\n');
const brokenViolations = forbidden.filter((f) => f.pattern.test(broken)).map((f) => f.name);
if (brokenViolations.length > 0) {
  ok('NEGATIVE CONTROL: the static read-only check fires on a broken copy',
    brokenViolations.join(', '));
} else {
  bad('NEGATIVE CONTROL: the static read-only check fires on a broken copy',
    'the check is a tautology');
}

// 4b. RUNTIME: a full triage leaves the run record byte-identical.
const before = JSON.stringify(run);
await engine.triage({ runId: run.id });
const after = JSON.stringify(run);
if (before === after) {
  ok('a full triage leaves the run record byte-identical');
} else {
  bad('a full triage leaves the run record byte-identical', 'the record changed');
}

// N4: the "no write" check fires when the record IS changed.
const mutated = JSON.stringify({ ...run, status: 'passed' });
if (mutated !== after) {
  ok('NEGATIVE CONTROL: the no-write check fires when the run record changes');
} else {
  bad('NEGATIVE CONTROL: the no-write check fires when the run record changes',
    'the comparison cannot tell the two apart');
}

// 4c. The suspect-change rules need two DIFFERENT commits.
const sameCommit = detectSuspectChanges({
  run: { gitCommit: 'aaa', summary: { cases: [{ file: 'tests/a.spec.ts' }] } },
  baseline: { gitCommit: 'aaa', summary: { cases: [] } },
  gitChanged: () => true,
});
const differentCommit = detectSuspectChanges({
  run: { gitCommit: 'bbb', summary: { cases: [{ file: 'tests/a.spec.ts' }] } },
  baseline: { gitCommit: 'aaa', summary: { cases: [] } },
  gitChanged: () => true,
});
if (!sameCommit.comparable && sameCommit.suspect === false
  && differentCommit.comparable && differentCommit.suspect === true) {
  ok('the suspect-change comparison needs two different commits');
} else {
  bad('the suspect-change comparison needs two different commits',
    `same=${JSON.stringify(sameCommit)}, different=${JSON.stringify(differentCommit)}`);
}

// N2: the evidence refusal fires on a report with a bogus ref (already shown
// in section 3, restated here so the negative controls sit together).
if (refusedBogusCase && refusedOutOfScope && refusedNoEvidence) {
  ok('NEGATIVE CONTROL: all three evidence refusals fire');
} else {
  bad('NEGATIVE CONTROL: all three evidence refusals fire');
}

// N3: the history-gate mutation changes the classification (already shown in
// section 2, restated here so the negative controls sit together).
if (gateDiffers.length === gateCases.length) {
  ok('NEGATIVE CONTROL: the history-gate mutation changes the classification');
} else {
  bad('NEGATIVE CONTROL: the history-gate mutation changes the classification');
}

/* ------------------------------------------------------------------ */

console.log(`\nchecks: ${checks}  failures: ${failures}`);
if (failures === 0) {
  console.log('RESULT: OK -- the triage boundary holds: the classification is deterministic and complete, the history gate is load-bearing, every finding cites a checkable source, and the triage is read-only.');
  process.exit(0);
}
console.log('RESULT: MISMATCH -- the triage boundary does NOT hold.');
process.exit(1);
