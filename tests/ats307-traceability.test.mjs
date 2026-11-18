/**
 * ATS-307 -- the traceability graph: unit tests.
 *
 * WHAT IS UNDER TEST
 * ------------------
 * The acceptance criterion of ATS-307 has three parts, and each has its
 * own group of tests here:
 *
 *   1. THE CHAIN WALKS. From a requirement down to the evidence, and
 *      from an evidence file back up to the requirement.
 *   2. THE GAPS ARE VISIBLE. A broken chain says WHICH hop is missing
 *      and WHY -- it never silently skips a hop and never invents a
 *      placeholder that looks like a real node.
 *   3. THE CONSISTENCY IS CHECKABLE. The ids, the scripts and the
 *      evidence directories the graph names must be the ones the
 *      repository really has.
 *
 * THE FIXTURES
 * ------------
 * The tests build their own miniature repository in a temp directory
 * rather than reading the real one. A test that reads the real tree
 * measures the tree, not the code: it would fail whenever a case is
 * added, and it could not exercise the interesting shapes (a catalogue
 * that names a script that does not exist, a run whose evidence belongs
 * to no case, a cycle).
 *
 * ONE test does read the real repository, and it is marked as such
 * (UT-ATS307-030): it checks that the graph of the REAL tree has no
 * orphan edge and no cycle, because those are properties of the DATA
 * and not of the fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  CHAIN, COVERAGE, COVERAGE_RANK, EDGE_TYPE, GAP, NODE_KIND, PROVENANCE,
  bestCoverage, edgeUid, hopOf, makeEdge, makeNode, nodeUid,
} from '../server/traceability/model.mjs';
import {
  buildGraph, findCycles, readCatalogue, readDefinedRequirements,
  readDesignAnchors, readEvidenceScripts, readRuntimeRuns,
  scanEvidenceTranscripts, scanScriptDeclarations, splitDesignAnchors,
} from '../server/traceability/builder.mjs';
import {
  consistencyChecks, coverageReport, gapForHop, indexGraph,
  traceEvidence, traceRequirement,
} from '../server/traceability/query.mjs';

/* ------------------------------------------------------------------ */
/* The fixture                                                        */
/* ------------------------------------------------------------------ */

/**
 * Writes a miniature repository.
 *
 * @param {object} spec
 * @param {object[]} spec.rtm the RTM rows
 * @param {object[]} spec.cases the catalogue rows
 * @param {object[]} [spec.scripts] the scripts, as `{file, text}`
 * @param {object[]} [spec.transcripts] the transcripts, as `{file, text}`
 * @param {object[]} [spec.runs] the runtime run records
 */
function makeRepo({ rtm = [], cases = [], scripts = [], transcripts = [], runs = [], requirements = [], basic = [], ui = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats307-'));
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'rtm.json'), JSON.stringify(rtm, null, 2));
  fs.writeFileSync(path.join(root, 'tests', 'test-cases.json'), JSON.stringify(cases, null, 2));
  const reqDoc = ['# requirements', '', '| ID | title |', '|---|---|'];
  for (const r of requirements) reqDoc.push(`| ${r.id} | ${r.title} |`);
  fs.writeFileSync(path.join(root, 'docs', '02-REQUIREMENTS.md'), reqDoc.join('\n'));
  const basicDoc = ['# basic', '', '| ID | module |', '|---|---|'];
  for (const b of basic) basicDoc.push(`| ${b.id} | ${b.name} |`);
  fs.writeFileSync(path.join(root, 'docs', '03-BASIC-DESIGN.md'), basicDoc.join('\n'));
  const uiDoc = ['# ui', '', '| ID | screen |', '|---|---|'];
  for (const u of ui) uiDoc.push(`| ${u.id} | ${u.name} |`);
  fs.writeFileSync(path.join(root, 'docs', '05-UI-UX.md'), uiDoc.join('\n'));
  for (const s of scripts) {
    const full = path.join(root, s.file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, s.text);
  }
  for (const t of transcripts) {
    const full = path.join(root, t.file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, t.text);
  }
  return root;
}

/** A catalogue row. */
function caseRow(id, req, extra = {}) {
  return {
    id, req, category: '正常', title: `title of ${id}`, input: 'in', expected: 'out',
    evidence: 'node --test', status: 'PASS', level: 'UT', ...extra,
  };
}

/** An RTM row. */
function rtmRow(requirement, design, tests, status = 'IMPLEMENTED') {
  return { requirement, design, tests, status };
}

/* ------------------------------------------------------------------ */
/* The stable uid                                                     */
/* ------------------------------------------------------------------ */

test('UT-ATS307-001: a node uid is a pure function of its kind and its key', () => {
  const a = nodeUid(NODE_KIND.REQUIREMENT, 'FR-001');
  const b = nodeUid(NODE_KIND.REQUIREMENT, 'FR-001');
  assert.equal(a, b, 'the same inputs must produce the same uid');
  assert.match(a, /^trc_1_[0-9a-f]{24}$/);
});

test('UT-ATS307-002: the node uid of the same key in two kinds differs', () => {
  assert.notEqual(nodeUid(NODE_KIND.REQUIREMENT, 'X'), nodeUid(NODE_KIND.SCRIPT, 'X'));
});

test('UT-ATS307-003: the edge uid depends on the endpoints AND the type', () => {
  const a = edgeUid('from', 'to', EDGE_TYPE.COVERS);
  assert.notEqual(a, edgeUid('from', 'to', EDGE_TYPE.DESIGNS));
  assert.notEqual(a, edgeUid('to', 'from', EDGE_TYPE.COVERS));
  assert.equal(a, edgeUid('from', 'to', EDGE_TYPE.COVERS));
});

test('UT-ATS307-004: the data of a node cannot change its kind or its uid', () => {
  const node = makeNode(NODE_KIND.REQUIREMENT, 'FR-001', { kind: 'script', uid: 'trc_1_deadbeef' });
  assert.equal(node.kind, NODE_KIND.REQUIREMENT, 'the kind is what the chain is built from');
  assert.equal(node.uid, nodeUid(NODE_KIND.REQUIREMENT, 'FR-001'));
});

test('UT-ATS307-005: the chain has the six hops in order', () => {
  assert.deepEqual(CHAIN, ['requirement', 'design', 'testcase', 'script', 'run', 'evidence']);
  assert.equal(hopOf(NODE_KIND.REQUIREMENT), 0);
  assert.equal(hopOf(NODE_KIND.EVIDENCE), 5);
  assert.equal(hopOf('nonsense'), -1);
});

test('UT-ATS307-006: the coverage of a requirement is the best state it reaches', () => {
  assert.equal(bestCoverage([]), COVERAGE.UNCOVERED);
  assert.equal(bestCoverage([COVERAGE.UNCOVERED, COVERAGE.IMPLEMENTED]), COVERAGE.IMPLEMENTED);
  assert.equal(bestCoverage([COVERAGE.IMPLEMENTED, COVERAGE.VERIFIED]), COVERAGE.VERIFIED);
  assert.ok(COVERAGE_RANK[COVERAGE.VERIFIED] > COVERAGE_RANK[COVERAGE.EXECUTED]);
});

/* ------------------------------------------------------------------ */
/* The forward walk                                                   */
/* ------------------------------------------------------------------ */

test('UT-ATS307-007: a requirement walks down to its script, its run and its evidence', () => {
  const root = makeRepo({
    rtm: [rtmRow('FR-001', 'B01', 'UT-A-001')],
    cases: [caseRow('UT-A-001', 'FR-001')],
    requirements: [{ id: 'FR-001', title: 'first' }],
    basic: [{ id: 'B01', name: 'Project Catalog' }],
    scripts: [{ file: 'tests/a.test.mjs', text: "test('UT-A-001: does the thing', () => {});\n" }],
    transcripts: [{ file: 'docs/evidence/ATS-001/01-run.log', text: '✔ UT-A-001: does the thing (1ms)\n' }],
  });
  const runs = [{
    id: 'run_1_000000000000000000000000',
    status: 'passed',
    gitCommit: 'abc1234',
    attempts: [{ uid: 'att_1_000000000000000000000000', testUid: 'UT-A-001', status: 'passed' }],
    artifacts: [{ file: 'report.json', size: 12, sha256: 'deadbeef' }],
  }];
  const view = indexGraph(buildGraph({ root, runs }));
  const t = traceRequirement(view, 'FR-001');
  assert.equal(t.found, true);
  assert.equal(t.coverage, COVERAGE.VERIFIED);
  assert.equal(t.complete, true, `the chain should be complete, gaps: ${JSON.stringify(t.gaps)}`);
  assert.deepEqual(t.gaps, []);
  // Every hop is reached.
  const hops = t.chain.map((c) => c.kind);
  assert.deepEqual(hops, CHAIN);
  for (const hop of t.chain) assert.ok(hop.nodes.length > 0, `the ${hop.kind} hop is empty`);
  // The script is the one the tree really has.
  const script = t.cases[0].scripts[0];
  assert.equal(script.file, 'tests/a.test.mjs');
  // The evidence names the transcript and the run's artifact.
  const files = t.cases[0].evidence.map((e) => e.file).sort();
  assert.deepEqual(files, ['docs/evidence/ATS-001/01-run.log', 'report.json']);
});

test('UT-ATS307-008: a requirement with no test case says so instead of showing an empty chain', () => {
  const root = makeRepo({
    rtm: [rtmRow('FR-002', 'B01', 'TBD')],
    requirements: [{ id: 'FR-002', title: 'second' }],
    basic: [{ id: 'B01', name: 'Project Catalog' }],
  });
  const view = indexGraph(buildGraph({ root }));
  const t = traceRequirement(view, 'FR-002');
  assert.equal(t.found, true);
  assert.equal(t.coverage, COVERAGE.DESIGNED);
  assert.equal(t.complete, false);
  assert.ok(t.gaps.some((g) => g.gap === GAP.NO_TESTCASE), 'the missing test case is reported');
  // The gap names the hop that is missing.
  const noCase = t.gaps.find((g) => g.gap === GAP.NO_TESTCASE);
  assert.equal(noCase.hop, hopOf(NODE_KIND.TESTCASE));
});

test('UT-ATS307-009: a case that was never executed reports the missing run hop', () => {
  const root = makeRepo({
    rtm: [rtmRow('FR-003', 'B01', 'UT-B-001')],
    cases: [caseRow('UT-B-001', 'FR-003')],
    requirements: [{ id: 'FR-003', title: 'third' }],
    basic: [{ id: 'B01', name: 'Project Catalog' }],
    scripts: [{ file: 'tests/b.test.mjs', text: "test('UT-B-001: never ran', () => {});\n" }],
  });
  const view = indexGraph(buildGraph({ root }));
  const t = traceRequirement(view, 'FR-003');
  assert.equal(t.coverage, COVERAGE.IMPLEMENTED);
  assert.ok(t.gaps.some((g) => g.gap === GAP.NO_RUN), 'the missing run is reported');
  const noRun = t.gaps.find((g) => g.gap === GAP.NO_RUN);
  assert.equal(noRun.hop, hopOf(NODE_KIND.RUN));
  assert.equal(noRun.testcase, 'UT-B-001');
});

test('UT-ATS307-010: a gap is NEVER filled with a placeholder node', () => {
  // A requirement whose test case the catalogue does not have.
  const root = makeRepo({
    rtm: [rtmRow('FR-004', 'B01', 'UT-GONE-001')],
    requirements: [{ id: 'FR-004', title: 'fourth' }],
    basic: [{ id: 'B01', name: 'Project Catalog' }],
  });
  const graph = buildGraph({ root });
  const view = indexGraph(graph);
  // The node exists -- the catalogue talks about it -- but it is not present.
  const ghost = [...view.nodes.values()].find((n) => n.kind === NODE_KIND.TESTCASE);
  assert.ok(ghost, 'the case the RTM names is still a node');
  assert.equal(ghost.present, false, 'but it is not present in the catalogue');
  const t = traceRequirement(view, 'FR-004');
  assert.ok(t.gaps.some((g) => g.gap === GAP.DANGLING_TEST));
  // And no script/run/evidence node was invented for it.
  assert.equal(t.chain.find((c) => c.kind === NODE_KIND.SCRIPT).nodes.length, 0);
  assert.equal(t.chain.find((c) => c.kind === NODE_KIND.RUN).nodes.length, 0);
  assert.equal(t.chain.find((c) => c.kind === NODE_KIND.EVIDENCE).nodes.length, 0);
});

test('UT-ATS307-011: a requirement that does not exist is reported, not answered with nothing', () => {
  const root = makeRepo({ rtm: [], cases: [] });
  const view = indexGraph(buildGraph({ root }));
  const t = traceRequirement(view, 'FR-999');
  assert.equal(t.found, false);
  assert.match(t.reason, /FR-999/);
  assert.deepEqual(t.chain, []);
});

/* ------------------------------------------------------------------ */
/* The backward walk                                                  */
/* ------------------------------------------------------------------ */

test('UT-ATS307-012: an evidence file walks back up to the requirement it verifies', () => {
  const root = makeRepo({
    rtm: [rtmRow('FR-005', 'B02', 'UT-C-001')],
    cases: [caseRow('UT-C-001', 'FR-005')],
    requirements: [{ id: 'FR-005', title: 'fifth' }],
    basic: [{ id: 'B02', name: 'Test Index' }],
    scripts: [{ file: 'tests/c.test.mjs', text: "test('UT-C-001: verified', () => {});\n" }],
    transcripts: [{ file: 'docs/evidence/ATS-005/01-run.log', text: '✔ UT-C-001: verified (1ms)\n' }],
  });
  const view = indexGraph(buildGraph({ root }));
  const evidence = [...view.nodes.values()].find((n) => n.kind === NODE_KIND.EVIDENCE);
  assert.ok(evidence, 'the transcript is an evidence node');
  const back = traceEvidence(view, { uid: evidence.uid });
  assert.equal(back.found, true);
  assert.equal(back.requirements.length, 1);
  assert.equal(back.requirements[0].requirement, 'FR-005');
  assert.equal(back.requirements[0].design, 'B02');
  assert.equal(back.requirements[0].testcase, 'UT-C-001');
  assert.deepEqual(back.unreached, []);
});

test('UT-ATS307-013: an evidence file that reaches no requirement says WHY', () => {
  // A run that archived an artifact but attempted no case.
  const root = makeRepo({
    rtm: [rtmRow('FR-006', 'B03', 'UT-D-001')],
    cases: [caseRow('UT-D-001', 'FR-006')],
    requirements: [{ id: 'FR-006', title: 'sixth' }],
    basic: [{ id: 'B03', name: 'Source Editor' }],
    scripts: [{ file: 'tests/d.test.mjs', text: "test('UT-D-001: orphan', () => {});\n" }],
  });
  const runs = [{
    id: 'run_1_000000000000000000000000',
    status: 'passed',
    attempts: [],
    artifacts: [{ file: 'report.json', size: 12, sha256: 'cafe' }],
  }];
  const view = indexGraph(buildGraph({ root, runs }));
  const artifact = [...view.nodes.values()].find((n) => n.kind === NODE_KIND.EVIDENCE && n.file === 'report.json');
  assert.ok(artifact);
  const back = traceEvidence(view, { uid: artifact.uid });
  assert.equal(back.found, true);
  assert.equal(back.requirements.length, 0);
  assert.equal(back.unreached.length, 1);
  assert.match(back.unreached[0].reason, /attempted no test case/);
});

test('UT-ATS307-014: an evidence selector that matches nothing is reported', () => {
  const root = makeRepo({ rtm: [], cases: [] });
  const view = indexGraph(buildGraph({ root }));
  const back = traceEvidence(view, { uid: 'trc_1_000000000000000000000000' });
  assert.equal(back.found, false);
  assert.match(back.reason, /no evidence node/);
  assert.equal(back.unreached.length, 1);
});

test('UT-ATS307-015: the backward walk joins through the run, not through the project', () => {
  // Two runs, two cases, two requirements, one shared evidence FILE name.
  // The artifact of run #1 must NOT reach the case of run #2.
  const root = makeRepo({
    rtm: [rtmRow('FR-007', 'B04', 'UT-E-001'), rtmRow('FR-008', 'B04', 'UT-E-002')],
    cases: [caseRow('UT-E-001', 'FR-007'), caseRow('UT-E-002', 'FR-008')],
    requirements: [{ id: 'FR-007', title: 'seven' }, { id: 'FR-008', title: 'eight' }],
    basic: [{ id: 'B04', name: 'Execution Supervisor' }],
    scripts: [{ file: 'tests/e.test.mjs', text: "test('UT-E-001: one', () => {});\ntest('UT-E-002: two', () => {});\n" }],
  });
  const runs = [
    {
      id: 'run_1_00000000000000000000000a',
      status: 'passed',
      attempts: [{ uid: 'att_1_00000000000000000000000a', testUid: 'UT-E-001', status: 'passed' }],
      artifacts: [{ file: 'report.json', size: 12, sha256: 'aa' }],
    },
    {
      id: 'run_1_00000000000000000000000b',
      status: 'passed',
      attempts: [{ uid: 'att_1_00000000000000000000000b', testUid: 'UT-E-002', status: 'passed' }],
      artifacts: [{ file: 'report.json', size: 12, sha256: 'bb' }],
    },
  ];
  const view = indexGraph(buildGraph({ root, runs }));
  const artifacts = [...view.nodes.values()].filter((n) => n.kind === NODE_KIND.EVIDENCE && n.file === 'report.json');
  assert.equal(artifacts.length, 2, 'the two runs have two distinct artifacts');
  const first = artifacts.find((a) => a.runId === 'run_1_00000000000000000000000a');
  const back = traceEvidence(view, { uid: first.uid });
  assert.equal(back.requirements.length, 1);
  assert.equal(back.requirements[0].requirement, 'FR-007');
  assert.equal(back.requirements[0].testcase, 'UT-E-001');
});

/* ------------------------------------------------------------------ */
/* The consistency checks                                             */
/* ------------------------------------------------------------------ */

test('UT-ATS307-016: the RTM test ids that the catalogue does not have are reported', () => {
  const root = makeRepo({
    rtm: [rtmRow('FR-009', 'B01', 'UT-HERE-001、UT-GONE-002')],
    cases: [caseRow('UT-HERE-001', 'FR-009')],
    requirements: [{ id: 'FR-009', title: 'nine' }],
    basic: [{ id: 'B01', name: 'Project Catalog' }],
  });
  const view = indexGraph(buildGraph({ root }));
  const cc = consistencyChecks(view);
  assert.equal(cc.ok, false);
  assert.equal(cc.danglingTest.length, 1);
  assert.match(cc.danglingTest[0].detail, /UT-GONE-002/);
});

test('UT-ATS307-017: a design anchor that no document defines is reported', () => {
  const root = makeRepo({
    rtm: [rtmRow('FR-010', 'B99', 'UT-F-001')],
    cases: [caseRow('UT-F-001', 'FR-010')],
    requirements: [{ id: 'FR-010', title: 'ten' }],
  });
  const view = indexGraph(buildGraph({ root }));
  const cc = consistencyChecks(view);
  assert.equal(cc.ok, false);
  assert.equal(cc.danglingAnchor.length, 1);
  assert.match(cc.danglingAnchor[0].detail, /B99/);
});

test('UT-ATS307-018: a case the catalogue marks PASS but no script implements is a FALSE CLAIM', () => {
  const root = makeRepo({
    rtm: [rtmRow('FR-011', 'B01', 'UT-G-001')],
    cases: [caseRow('UT-G-001', 'FR-011', { status: 'PASS' })],
    requirements: [{ id: 'FR-011', title: 'eleven' }],
    basic: [{ id: 'B01', name: 'Project Catalog' }],
  });
  const view = indexGraph(buildGraph({ root }));
  const cc = consistencyChecks(view);
  assert.equal(cc.ok, false);
  assert.equal(cc.falsePass.length, 1);
  assert.equal(cc.falsePass[0].testcase, 'UT-G-001');
});

test('UT-ATS307-019: a case the catalogue marks PENDING and no script implements is a GAP, not a false claim', () => {
  const root = makeRepo({
    rtm: [rtmRow('FR-012', 'B01', 'UT-H-001')],
    cases: [caseRow('UT-H-001', 'FR-012', { status: 'PENDING' })],
    requirements: [{ id: 'FR-012', title: 'twelve' }],
    basic: [{ id: 'B01', name: 'Project Catalog' }],
  });
  const view = indexGraph(buildGraph({ root }));
  const cc = consistencyChecks(view);
  assert.equal(cc.falsePass.length, 0, 'a PENDING case is an honest gap');
  assert.equal(cc.caseWithoutScript.length, 1);
  // It IS a gap of the chain.
  const t = traceRequirement(view, 'FR-012');
  assert.ok(t.gaps.some((g) => g.gap === GAP.NO_SCRIPT));
});

test('UT-ATS307-020: the graph has no orphan edge and no cycle', () => {
  const root = makeRepo({
    rtm: [rtmRow('FR-013', 'B01', 'UT-I-001'), rtmRow('FR-014', 'B02/UI-001', 'UT-I-002')],
    cases: [caseRow('UT-I-001', 'FR-013'), caseRow('UT-I-002', 'FR-014')],
    requirements: [{ id: 'FR-013', title: 'thirteen' }, { id: 'FR-014', title: 'fourteen' }],
    basic: [{ id: 'B01', name: 'Catalog' }, { id: 'B02', name: 'Index' }],
    ui: [{ id: 'UI-001', name: 'Catalog Screen' }],
    scripts: [{ file: 'tests/i.test.mjs', text: "test('UT-I-001: one', () => {});\ntest('UT-I-002: two', () => {});\n" }],
    transcripts: [{ file: 'docs/evidence/ATS-013/01.log', text: '✔ UT-I-001: one\n✔ UT-I-002: two\n' }],
  });
  const graph = buildGraph({ root });
  assert.deepEqual(graph.checks.orphanEdges, []);
  assert.deepEqual(graph.checks.cycles, []);
  assert.deepEqual(graph.checks.danglingNodes, []);
});

test('UT-ATS307-021: a cycle in the data is FOUND by the cycle check', () => {
  // The cycle check has to be able to fail: a graph with a cycle must be
  // reported, or the check means nothing.
  const nodes = new Map([
    ['a', { uid: 'a', kind: 'x' }],
    ['b', { uid: 'b', kind: 'x' }],
    ['c', { uid: 'c', kind: 'x' }],
  ]);
  const edges = [
    { uid: 'e1', from: 'a', to: 'b', type: 't' },
    { uid: 'e2', from: 'b', to: 'c', type: 't' },
    { uid: 'e3', from: 'c', to: 'a', type: 't' },
  ];
  const cycles = findCycles(nodes, edges);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].length, 4, 'the cycle names its nodes and closes');
  assert.equal(cycles[0][0], cycles[0][cycles[0].length - 1]);
});

/* ------------------------------------------------------------------ */
/* The scanners                                                       */
/* ------------------------------------------------------------------ */

test('UT-ATS307-022: the script scanner finds the three declaration styles', () => {
  const root = makeRepo({
    scripts: [{
      file: 'tools/p/st.mjs',
      text: [
        "test('UT-J-001: the unit style', () => {});",
        "verdict('ST-J-002 the probe style');",
        "check('ST-J-003', 'the check style');",
        '',
      ].join('\n'),
    }],
  });
  const found = scanScriptDeclarations(root);
  assert.ok(found.has('UT-J-001'));
  assert.ok(found.has('ST-J-002'));
  assert.ok(found.has('ST-J-003'));
  assert.equal(found.get('UT-J-001')[0].file, 'tools/p/st.mjs');
  assert.equal(found.get('UT-J-001')[0].line, 1);
});

test('UT-ATS307-023: a step suffix is only stripped when the catalogue knows the parent', () => {
  const root = makeRepo({
    scripts: [{
      file: 'tools/p/st.mjs',
      text: "check('ST-K-017a', 'a step');\ncheck('UT-K-011b', 'an id of its own');\n",
    }],
  });
  // The catalogue knows `ST-K-017` but NOT `UT-K-011`.
  const known = new Set(['ST-K-017', 'UT-K-011b']);
  const found = scanScriptDeclarations(root, { catalogueIds: known });
  assert.ok(found.has('ST-K-017'), 'the step folds into its parent');
  assert.ok(!found.has('ST-K-017a'), 'the step is not an id of its own');
  assert.ok(found.has('UT-K-011b'), 'an id that ends in b is not truncated');
  assert.ok(!found.has('UT-K-011'), 'no id is invented');
});

test('UT-ATS307-024: the transcript scanner reads the executed ids and their result', () => {
  const root = makeRepo({
    transcripts: [{
      file: 'docs/evidence/ATS-001/01.log',
      text: '✔ UT-L-001: ok\n✖ UT-L-002: broken\n✔ UT-L-003: ok\n',
    }],
  });
  const found = scanEvidenceTranscripts(root);
  assert.ok(found.has('UT-L-001'));
  assert.equal(found.get('UT-L-001')[0].ok, true);
  assert.equal(found.get('UT-L-002')[0].ok, false);
  assert.ok(found.has('UT-L-003'));
});

test('UT-ATS307-025: the design anchor splitter keeps a phase marker whole', () => {
  const anchors = new Map([['B01', {}], ['UC-01', {}], ['UI-002', {}]]);
  // Two anchors: the module and the use case.
  assert.deepEqual(splitDesignAnchors('B01/UC-01', anchors).map((p) => p.id), ['B01', 'UC-01']);
  // ONE anchor: the phase is named "P1 AST/CLI" and must not be split.
  assert.deepEqual(splitDesignAnchors('P1 AST/CLI', anchors).map((p) => p.id), ['P1 AST/CLI']);
  // ONE anchor: the area.
  assert.deepEqual(splitDesignAnchors('NFR / SEC / OPS', anchors).map((p) => p.id), ['NFR / SEC / OPS']);
  // An unknown anchor that LOOKS like a document anchor is reported.
  assert.deepEqual(splitDesignAnchors('B99', anchors).map((p) => p.id), ['B99']);
});

test('UT-ATS307-026: the catalogue reader reports a missing file as no data, not as a crash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats307-empty-'));
  const cat = readCatalogue(root);
  assert.deepEqual(cat.rtm, []);
  assert.deepEqual(cat.cases, []);
  assert.deepEqual(readDefinedRequirements(root), new Set());
  assert.deepEqual(readRuntimeRuns(root), []);
});

test('UT-ATS307-027: the evidence reader only accepts a script that really exists', () => {
  const root = makeRepo({
    cases: [
      caseRow('UT-M-001', 'FR-015', { evidence: 'node tools/p/real.mjs' }),
      caseRow('UT-M-002', 'FR-015', { evidence: 'node tools/p/gone.mjs' }),
    ],
    scripts: [{ file: 'tools/p/real.mjs', text: '// real\n' }],
  });
  const cat = readCatalogue(root);
  const found = readEvidenceScripts(root, cat.cases);
  assert.deepEqual(found.get('UT-M-001'), ['tools/p/real.mjs']);
  assert.ok(!found.has('UT-M-002'), 'a script the tree does not have is not a script');
});

/* ------------------------------------------------------------------ */
/* The coverage report                                                */
/* ------------------------------------------------------------------ */

test('UT-ATS307-028: the coverage report counts the gaps by kind', () => {
  const root = makeRepo({
    rtm: [
      rtmRow('FR-016', 'B01', 'UT-N-001'),
      rtmRow('FR-017', 'B01', 'TBD'),
    ],
    cases: [caseRow('UT-N-001', 'FR-016')],
    requirements: [{ id: 'FR-016', title: 'sixteen' }, { id: 'FR-017', title: 'seventeen' }],
    basic: [{ id: 'B01', name: 'Catalog' }],
  });
  const view = indexGraph(buildGraph({ root }));
  const report = coverageReport(view);
  assert.equal(report.requirements, 2);
  // FR-016's case exists in the catalogue but no script implements it:
  // the case is DESIGNED, not absent.
  assert.equal(report.byCoverage[COVERAGE.DESIGNED], 2);
  // FR-017 has no case at all -- it stops at the design hop.
  assert.ok(report.gapsByKind[GAP.NO_SCRIPT], 'the missing script of FR-016 is reported');
  assert.ok(report.gapsByKind[GAP.NO_TESTCASE], 'the missing test case of FR-017 is reported');
  assert.ok(report.nodesByKind[NODE_KIND.REQUIREMENT] >= 2);
  assert.ok(report.edgesByType[EDGE_TYPE.COVERS] >= 1);
  assert.ok(report.edgesByProvenance[PROVENANCE.CATALOG] >= 1);
});

/* ------------------------------------------------------------------ */
/* The real repository                                                */
/* ------------------------------------------------------------------ */

test('UT-ATS307-029: the gap of a hop names that hop', () => {
  assert.equal(gapForHop(NODE_KIND.DESIGN), GAP.NO_DESIGN);
  assert.equal(gapForHop(NODE_KIND.TESTCASE), GAP.NO_TESTCASE);
  assert.equal(gapForHop(NODE_KIND.SCRIPT), GAP.NO_SCRIPT);
  assert.equal(gapForHop(NODE_KIND.RUN), GAP.NO_RUN);
  assert.equal(gapForHop(NODE_KIND.EVIDENCE), GAP.NO_EVIDENCE);
});

test('UT-ATS307-030: the graph of the REAL repository has no orphan edge and no cycle', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const graph = buildGraph({ root });
  assert.ok(graph.nodes.length > 0);
  assert.ok(graph.chains.length > 0);
  assert.deepEqual(graph.checks.orphanEdges, [], 'the real graph has no orphan edge');
  assert.deepEqual(graph.checks.cycles, [], 'the real graph has no cycle');
  assert.deepEqual(graph.checks.danglingNodes, [], 'the real graph has no node that does not exist');
  // Every requirement of the RTM has a chain.
  const rtm = readCatalogue(root);
  assert.equal(graph.chains.length, rtm.rtm.length);
});

test('UT-ATS307-031: every id the real RTM names exists in the real catalogue', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const { rtm, cases } = readCatalogue(root);
  const ids = new Set(cases.map((c) => c.id));
  const dangling = [];
  for (const row of rtm) {
    if (row.tests.trim() === 'TBD') continue;
    for (const id of row.tests.split('、').map((s) => s.trim()).filter(Boolean)) {
      if (!ids.has(id)) dangling.push({ requirement: row.requirement, id });
    }
  }
  assert.deepEqual(dangling, [], 'the RTM names no test id the catalogue does not have');
});

test('UT-ATS307-032: the build is deterministic -- the same tree gives the same graph', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const a = buildGraph({ root });
  const b = buildGraph({ root });
  assert.deepEqual(a.nodes, b.nodes);
  assert.deepEqual(a.edges, b.edges);
  assert.deepEqual(a.chains, b.chains);
});

test('UT-ATS307-034: a case whose execution FAILED is `failed`, not `verified`', () => {
  // WHAT RAN and WHAT WAS DECLARED PASS ARE TWO DIFFERENT FACTS. A case
  // whose only transcript line is a FAILURE has evidence behind it, but
  // that evidence is the evidence of a failure: the chain did not verify
  // it.
  const root = makeRepo({
    rtm: [rtmRow('FR-020', 'B01', 'UT-F-001')],
    cases: [caseRow('UT-F-001', 'FR-020')],
    requirements: [{ id: 'FR-020', title: 'twenty' }],
    basic: [{ id: 'B01', name: 'Catalog' }],
    scripts: [{ file: 'tests/f.test.mjs', text: "test('UT-F-001: one', () => {});\n" }],
    transcripts: [{ file: 'docs/evidence/ATS-020/01.log', text: '\u2716 UT-F-001: one\n' }],
  });
  const graph = buildGraph({ root });
  const chain = graph.chains.find((c) => c.requirementKey === 'FR-020');
  assert.ok(chain, 'the FR-020 chain was built');
  assert.equal(chain.coverage, COVERAGE.FAILED,
    'a case whose only execution failed must not be `verified`');
  assert.notEqual(chain.coverage, COVERAGE.VERIFIED);
});

test('UT-ATS307-035: a case with BOTH a failing and a passing execution is `verified`', () => {
  // The chain DID reach a passing verification for the case, so it is
  // `verified` -- the earlier failure does not take that away.
  const root = makeRepo({
    rtm: [rtmRow('FR-021', 'B01', 'UT-F-002')],
    cases: [caseRow('UT-F-002', 'FR-021')],
    requirements: [{ id: 'FR-021', title: 'twentyone' }],
    basic: [{ id: 'B01', name: 'Catalog' }],
    scripts: [{ file: 'tests/f2.test.mjs', text: "test('UT-F-002: one', () => {});\n" }],
    transcripts: [
      { file: 'docs/evidence/ATS-021/01.log', text: '\u2716 UT-F-002: one\n' },
      { file: 'docs/evidence/ATS-021/02.log', text: '\u2714 UT-F-002: one\n' },
    ],
  });
  const graph = buildGraph({ root });
  const chain = graph.chains.find((c) => c.requirementKey === 'FR-021');
  assert.ok(chain, 'the FR-021 chain was built');
  assert.equal(chain.coverage, COVERAGE.VERIFIED);
});

test('UT-ATS307-036: the `failed` state is ranked BELOW `verified` and ABOVE `executed`', () => {
  // The rank is "how much was ESTABLISHED": a failed execution got as far
  // as a passing one (it ran, it left evidence), but it did not establish
  // anything, so it must not outrank `verified`.
  assert.ok(COVERAGE_RANK[COVERAGE.VERIFIED] > COVERAGE_RANK[COVERAGE.FAILED]);
  assert.ok(COVERAGE_RANK[COVERAGE.FAILED] > COVERAGE_RANK[COVERAGE.EXECUTED]);
  // And the ranking helper agrees.
  assert.equal(bestCoverage([COVERAGE.FAILED]), COVERAGE.FAILED);
  assert.equal(bestCoverage([COVERAGE.FAILED, COVERAGE.VERIFIED]), COVERAGE.VERIFIED);
  assert.equal(bestCoverage([COVERAGE.EXECUTED, COVERAGE.FAILED]), COVERAGE.FAILED);
});

test('UT-ATS307-037: a runtime run with a commit puts that commit on the node AND on its edges', () => {
  // AC-3: the nodes and the edges carry a git commit. A runtime run is the
  // only source that KNOWS its own commit, so it is the fixture that can
  // prove the propagation reaches the edges too.
  const root = makeRepo({
    rtm: [rtmRow('FR-001', 'B01', 'UT-A-001')],
    cases: [caseRow('UT-A-001', 'FR-001')],
    requirements: [{ id: 'FR-001', title: 'first' }],
    basic: [{ id: 'B01', name: 'Catalog' }],
    scripts: [{ file: 'tests/a.test.mjs', text: "test('UT-A-001: ok', () => {});\n" }],
  });
  const runs = [{
    id: 'run-1',
    gitCommit: 'deadbeef1234567890abcdef1234567890abcdef12',
    status: 'passed',
    file: 'tests/a.test.mjs',
    attempts: [{ uid: 'att-1', testUid: 'UT-A-001', status: 'passed' }],
    artifacts: [{ file: 'report.json', sha256: 'a'.repeat(64), size: 10 }],
  }];
  const graph = buildGraph({ root, runs });
  const run = graph.nodes.find((n) => n.kind === 'run' && n.key === 'run-1');
  assert.ok(run, 'the runtime run is a node of the graph');
  assert.equal(run.gitCommit, 'deadbeef1234567890abcdef1234567890abcdef12',
    'the run node carries the commit the run record states');

  // The edges that join the case to the run, and the run to the evidence.
  const attempted = graph.edges.find((e) => e.type === 'attempted' && e.to === run.uid);
  assert.ok(attempted, 'the attempt edge exists');
  assert.equal(attempted.gitCommit, 'deadbeef1234567890abcdef1234567890abcdef12',
    'the ATTEMPTED edge carries the commit of the run it joins');
  const archived = graph.edges.find((e) => e.type === 'archived' && e.from === run.uid);
  assert.ok(archived, 'the archived edge exists');
  assert.equal(archived.gitCommit, 'deadbeef1234567890abcdef1234567890abcdef12',
    'the ARCHIVED edge carries the commit of the run it joins');
});

test('UT-ATS307-038: every node and every edge of the REAL repository carries a commit', () => {
  // AC-3 measured on the real tree: the completion definition says the
  // nodes and the edges have a git commit, so the coverage is a COUNT, not
  // a claim. A tree that is not a git checkout has none -- that is the
  // fixture case, not this one.
  const root = path.resolve(import.meta.dirname, '..');
  const graph = buildGraph({ root });
  assert.ok(graph.nodes.length > 0, 'the real graph has nodes');
  // The COUNT is the assertion, and the offenders are named only when the
  // count is not zero. Comparing two 26000-element arrays with `deepEqual`
  // makes node build a diff of the whole thing, which exhausts the heap:
  // a failing assertion must stay READABLE.
  const nodesWithout = graph.nodes.filter((n) => n.gitCommit == null);
  assert.equal(nodesWithout.length, 0,
    `every node of the real graph carries a commit; ${nodesWithout.length} do not: `
    + nodesWithout.slice(0, 5).map((n) => `${n.kind} ${n.key}`).join(', '));
  const edgesWithout = graph.edges.filter((e) => e.gitCommit == null);
  assert.equal(edgesWithout.length, 0,
    `every edge of the real graph carries a commit; ${edgesWithout.length} do not: `
    + edgesWithout.slice(0, 5).map((e) => e.uid).join(', '));
});

test('UT-ATS307-039: a tree that is not a git checkout has no commit -- and says so', () => {
  // The other half of AC-3: the commit is not invented. A fixture tree has
  // no history, so every commit is null -- "this fact has no commit", not
  // "this fact has no value".
  const root = makeRepo({
    rtm: [rtmRow('FR-001', 'B01', 'UT-A-001')],
    cases: [caseRow('UT-A-001', 'FR-001')],
    requirements: [{ id: 'FR-001', title: 'first' }],
    basic: [{ id: 'B01', name: 'Catalog' }],
    scripts: [{ file: 'tests/a.test.mjs', text: "test('UT-A-001: ok', () => {});\n" }],
  });
  const graph = buildGraph({ root });
  assert.ok(graph.nodes.length > 0, 'the fixture graph has nodes');
  assert.equal(graph.nodes.every((n) => n.gitCommit == null), true,
    'no node of a tree without history claims a commit');
  assert.equal(graph.edges.every((e) => e.gitCommit == null), true,
    'no edge of a tree without history claims a commit');
});

test('UT-ATS307-040: the commit a node carries is the commit of the file it comes from', () => {
  // The commit is DERIVED, not typed: it must be the commit that last
  // touched the node's own source file. The real tree is the only place
  // where git can answer that, so the check is made there.
  const root = path.resolve(import.meta.dirname, '..');
  const graph = buildGraph({ root });
  const script = graph.nodes.find((n) => n.kind === 'script' && typeof n.source === 'string');
  assert.ok(script, 'the real graph has a script node');
  const direct = execFileSync('git', ['log', '-1', '--format=%H', '--', script.source], {
    cwd: root, encoding: 'utf8',
  }).trim();
  assert.equal(script.gitCommit, direct,
    'the node carries the commit git reports for its own source file');
});

test('UT-ATS307-033: the graph of the real repository is walkable in both directions', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const view = indexGraph(buildGraph({ root }));
  // FORWARD: a requirement that has a test case reaches its script.
  const forward = traceRequirement(view, 'FR-015');
  assert.equal(forward.found, true);
  assert.ok(forward.cases.length > 0, 'FR-015 has test cases');
  const withScript = forward.cases.find((c) => c.scripts.length);
  assert.ok(withScript, 'at least one case of FR-015 has a script');
  // BACKWARD: from that script's evidence back to FR-015.
  const withEvidence = forward.cases.find((c) => c.evidence.length);
  assert.ok(withEvidence, 'at least one case of FR-015 has evidence');
  const back = traceEvidence(view, { uid: withEvidence.evidence[0].uid });
  assert.equal(back.found, true);
  assert.ok(back.requirements.length > 0, 'the evidence reaches a requirement');
});
