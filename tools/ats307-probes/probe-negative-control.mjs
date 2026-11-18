/**
 * ATS-307 -- the NEGATIVE CONTROL.
 *
 * A check that cannot fail proves nothing. This probe takes the real
 * graph and BREAKS it in four ways, one at a time, and shows that the
 * corresponding check CATCHES the break:
 *
 *   1. a dangling test id   -- the RTM names a case the catalogue lacks
 *   2. a dangling anchor    -- the RTM names a design no document defines
 *   3. a false PASS         -- the catalogue says PASS, no script implements
 *   4. a cycle              -- the data contains a directed loop
 *
 * And it shows the POSITIVE control: the unmodified graph passes.
 *
 * The mutations are made on a COPY of the inputs, in a temp directory.
 * The real tree is never written to.
 *
 * Run: node tools/ats307-probes/probe-negative-control.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildGraph, findCycles } from '../../server/traceability/builder.mjs';
import { consistencyChecks, indexGraph } from '../../server/traceability/query.mjs';

function line(char = '-') { return char.repeat(78); }

/** A miniature repository the mutations are applied to. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats307-neg-'));
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', '02-REQUIREMENTS.md'), '# r\n\n| ID | title |\n|---|---|\n| FR-001 | first |\n');
  fs.writeFileSync(path.join(root, 'docs', '03-BASIC-DESIGN.md'), '# b\n\n| ID | module |\n|---|---|\n| B01 | Catalog |\n');
  fs.writeFileSync(path.join(root, 'docs', '05-UI-UX.md'), '# u\n\n| ID | screen |\n|---|---|\n');
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'a.test.mjs'), "test('UT-A-001: ok', () => {});\n");
  return root;
}

function writeCatalogue(root, rtm, cases) {
  fs.writeFileSync(path.join(root, 'tests', 'rtm.json'), JSON.stringify(rtm, null, 2));
  fs.writeFileSync(path.join(root, 'tests', 'test-cases.json'), JSON.stringify(cases, null, 2));
}

const caseRow = (id, req, status = 'PASS') => ({
  id, req, category: '正常', title: `t ${id}`, input: 'i', expected: 'o',
  evidence: 'node --test', status, level: 'UT',
});

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

console.log(line('='));
console.log('ATS-307 negative control: the checks CAN fail');
console.log(line('='));
console.log(`node : ${process.version}`);
console.log();

/* ------------------------------------------------------------------ */
/* 0. the positive control                                             */
/* ------------------------------------------------------------------ */

console.log(line());
console.log('--- 0. the positive control: an intact graph passes ---');
console.log(line());
{
  const root = makeRepo();
  writeCatalogue(root,
    [{ requirement: 'FR-001', design: 'B01', tests: 'UT-A-001', status: 'IMPLEMENTED' }],
    [caseRow('UT-A-001', 'FR-001')]);
  const graph = buildGraph({ root });
  const view = indexGraph(graph);
  const cc = consistencyChecks(view);
  check('the intact graph has no dangling test id', cc.danglingTest.length === 0);
  check('the intact graph has no dangling anchor', cc.danglingAnchor.length === 0);
  check('the intact graph has no orphan edge', cc.orphanEdge.length === 0);
  check('the intact graph has no false PASS', cc.falsePass.length === 0);
  check('the intact graph has no cycle', graph.checks.cycles.length === 0);
  check('the intact graph is consistent', cc.ok === true);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log();

/* ------------------------------------------------------------------ */
/* 1. the dangling test id                                             */
/* ------------------------------------------------------------------ */

console.log(line());
console.log('--- 1. the RTM names a case the catalogue does not have ---');
console.log(line());
{
  const root = makeRepo();
  writeCatalogue(root,
    [{ requirement: 'FR-001', design: 'B01', tests: 'UT-A-001、UT-GONE-002', status: 'IMPLEMENTED' }],
    [caseRow('UT-A-001', 'FR-001')]);
  const graph = buildGraph({ root });
  const view = indexGraph(graph);
  const cc = consistencyChecks(view);
  check('the dangling test id is CAUGHT', cc.danglingTest.length === 1);
  check('the catch names the id', /UT-GONE-002/.test(cc.danglingTest[0]?.detail ?? ''));
  check('the graph is no longer consistent', cc.ok === false);
  // And the gap is on the chain, not only on the check.
  const chain = graph.chains.find((c) => c.requirementKey === 'FR-001');
  check('the chain reports the gap', chain.gaps.some((g) => g.gap === 'dangling-test'));
  // And the missing case is NOT invented as a present node.
  const ghost = [...view.nodes.values()].find((n) => n.kind === 'testcase' && n.key === 'UT-GONE-002');
  check('the missing case is a node that is NOT present', ghost !== undefined && ghost.present === false);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log();

/* ------------------------------------------------------------------ */
/* 2. the dangling anchor                                              */
/* ------------------------------------------------------------------ */

console.log(line());
console.log('--- 2. the RTM names a design no document defines ---');
console.log(line());
{
  const root = makeRepo();
  writeCatalogue(root,
    [{ requirement: 'FR-001', design: 'B99', tests: 'UT-A-001', status: 'IMPLEMENTED' }],
    [caseRow('UT-A-001', 'FR-001')]);
  const graph = buildGraph({ root });
  const view = indexGraph(graph);
  const cc = consistencyChecks(view);
  check('the dangling anchor is CAUGHT', cc.danglingAnchor.length === 1);
  check('the catch names the anchor', /B99/.test(cc.danglingAnchor[0]?.detail ?? ''));
  check('the graph is no longer consistent', cc.ok === false);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log();

/* ------------------------------------------------------------------ */
/* 3. the false PASS                                                   */
/* ------------------------------------------------------------------ */

console.log(line());
console.log('--- 3. the catalogue says PASS but no script implements the case ---');
console.log(line());
{
  const root = makeRepo();
  // The catalogue has the case; the SCRIPT does not declare it.
  writeCatalogue(root,
    [{ requirement: 'FR-001', design: 'B01', tests: 'UT-A-001、UT-A-002', status: 'IMPLEMENTED' }],
    [caseRow('UT-A-001', 'FR-001'), caseRow('UT-A-002', 'FR-001')]);
  const graph = buildGraph({ root });
  const view = indexGraph(graph);
  const cc = consistencyChecks(view);
  check('the false PASS is CAUGHT', cc.falsePass.length === 1);
  check('the catch names the case', cc.falsePass[0]?.testcase === 'UT-A-002');
  check('the graph is no longer consistent', cc.ok === false);
  // And the PENDING case with no script is NOT a false claim.
  const root2 = makeRepo();
  writeCatalogue(root2,
    [{ requirement: 'FR-001', design: 'B01', tests: 'UT-A-001、UT-A-003', status: 'IMPLEMENTED' }],
    [caseRow('UT-A-001', 'FR-001'), caseRow('UT-A-003', 'FR-001', 'PENDING')]);
  const cc2 = consistencyChecks(indexGraph(buildGraph({ root: root2 })));
  check('a PENDING case with no script is NOT a false claim', cc2.falsePass.length === 0);
  check('but it IS reported as a case without a script', cc2.caseWithoutScript.length === 1);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
}
console.log();

/* ------------------------------------------------------------------ */
/* 4. the cycle                                                        */
/* ------------------------------------------------------------------ */

console.log(line());
console.log('--- 4. the data contains a directed cycle ---');
console.log(line());
{
  const nodes = new Map([
    ['a', { uid: 'a', kind: 'x' }],
    ['b', { uid: 'b', kind: 'x' }],
    ['c', { uid: 'c', kind: 'x' }],
    ['d', { uid: 'd', kind: 'x' }],
  ]);
  const edges = [
    { uid: 'e1', from: 'a', to: 'b', type: 't' },
    { uid: 'e2', from: 'b', to: 'c', type: 't' },
    { uid: 'e3', from: 'c', to: 'a', type: 't' },
    { uid: 'e4', from: 'd', to: 'a', type: 't' },
  ];
  const cycles = findCycles(nodes, edges);
  check('the cycle is CAUGHT', cycles.length === 1);
  check('the cycle names its nodes', cycles.length === 1 && cycles[0].length === 4);
  check('the cycle closes on itself', cycles.length === 1 && cycles[0][0] === cycles[0][3]);
  // A graph without a cycle reports none.
  const acyclic = findCycles(nodes, edges.filter((e) => e.uid !== 'e3'));
  check('the acyclic graph reports no cycle', acyclic.length === 0);
}
console.log();

/* ------------------------------------------------------------------ */
/* 5. the commit propagation                                            */
/* ------------------------------------------------------------------ */

console.log(line());
console.log('--- 5. the commit reaches the node AND the edge ---');
console.log(line());
{
  // AC-3: the nodes and the edges carry a git commit. The POSITIVE case
  // is a runtime run that knows its own commit: the commit must land on
  // the run node AND on the edges that join it.
  //
  // The NEGATIVE case is a tree without history: a fixture has no commit,
  // and the graph must NOT invent one. A check that cannot fail proves
  // nothing, so both directions are exercised here.
  const root = makeRepo();
  writeCatalogue(root,
    [{ requirement: 'FR-001', design: 'B01', tests: 'UT-A-001', status: 'IMPLEMENTED' }],
    [caseRow('UT-A-001', 'FR-001')]);
  const runs = [{
    id: 'run_1_000000000000000000000000',
    status: 'passed',
    gitCommit: 'deadbeef1234567890abcdef1234567890abcdef12',
    attempts: [{ uid: 'att_1_000000000000000000000000', testUid: 'UT-A-001', status: 'passed' }],
    artifacts: [{ file: 'report.json', size: 12, sha256: 'a'.repeat(64) }],
  }];
  const graph = buildGraph({ root, runs });
  const run = graph.nodes.find((n) => n.kind === 'run' && n.key === 'run_1_000000000000000000000000');
  check('the run node carries the commit the run record states',
    run?.gitCommit === 'deadbeef1234567890abcdef1234567890abcdef12');
  const attempted = graph.edges.find((e) => e.type === 'attempted' && e.to === run?.uid);
  check('the ATTEMPTED edge carries the commit',
    attempted?.gitCommit === 'deadbeef1234567890abcdef1234567890abcdef12');
  const archived = graph.edges.find((e) => e.type === 'archived' && e.from === run?.uid);
  check('the ARCHIVED edge carries the commit',
    archived?.gitCommit === 'deadbeef1234567890abcdef1234567890abcdef12');

  // The NEGATIVE control: a tree without a git history invents nothing.
  const root2 = makeRepo();
  writeCatalogue(root2,
    [{ requirement: 'FR-001', design: 'B01', tests: 'UT-A-001', status: 'IMPLEMENTED' }],
    [caseRow('UT-A-001', 'FR-001')]);
  const graph2 = buildGraph({ root: root2 });
  check('a tree WITHOUT history claims no commit on any node',
    graph2.nodes.every((n) => n.gitCommit == null));
  check('a tree WITHOUT history claims no commit on any edge',
    graph2.edges.every((e) => e.gitCommit == null));

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
}
console.log();

console.log(line('='));
if (failures === 0) {
  console.log('NEGATIVE CONTROL: every check failed when it should -- 0 failures');
  console.log(line('='));
} else {
  console.log(`NEGATIVE CONTROL: ${failures} check(s) did NOT fail when they should`);
  console.log(line('='));
  process.exitCode = 1;
}
