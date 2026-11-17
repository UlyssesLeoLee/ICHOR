/**
 * ATS-307 -- the evidence probe.
 *
 * It prints what the traceability graph of THIS repository actually says:
 * the shape of the graph, the coverage of every requirement, the gaps by
 * kind, the consistency checks -- and, as the part that matters most, a
 * worked example of the chain in BOTH directions.
 *
 * The probe is READ-ONLY: it reads the tree and prints, it writes
 * nothing. That is what makes its output reproducible: running it twice
 * on the same tree prints the same thing.
 *
 * Run: node tools/ats307-probes/probe-traceability.mjs
 */
import path from 'node:path';
import { buildGraph } from '../../server/traceability/builder.mjs';
import {
  consistencyChecks, coverageReport, indexGraph, traceEvidence, traceRequirement,
} from '../../server/traceability/query.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');

function line(char = '-') { return char.repeat(78); }

console.log(line('='));
console.log('ATS-307 probe: the traceability graph of this repository');
console.log(line('='));
console.log(`repo root : ${root}`);
console.log(`node      : ${process.version}`);
console.log(`platform  : ${process.platform} ${process.arch}`);
console.log();

/* ------------------------------------------------------------------ */
/* 1. the shape of the graph                                           */
/* ------------------------------------------------------------------ */

const graph = buildGraph({ root });
const view = indexGraph(graph);
const report = coverageReport(view);

console.log(line());
console.log('--- 1. the shape of the graph ---');
console.log(line());
console.log(`nodes            : ${graph.nodes.length}`);
console.log(`edges            : ${graph.edges.length}`);
console.log(`chains           : ${graph.chains.length}`);
console.log(`nodes by kind    : ${JSON.stringify(report.nodesByKind)}`);
console.log(`edges by type    : ${JSON.stringify(report.edgesByType)}`);
console.log(`edges by source  : ${JSON.stringify(report.edgesByProvenance)}`);
console.log();

/* ------------------------------------------------------------------ */
/* 2. the checks the acceptance criterion asks for                    */
/* ------------------------------------------------------------------ */

console.log(line());
console.log('--- 2. the checks: stable uid, orphan edges, cycles ---');
console.log(line());
console.log(`orphan edges     : ${graph.checks.orphanEdges.length}`);
console.log(`cycles           : ${graph.checks.cycles.length}`);
console.log(`nodes not present: ${graph.checks.danglingNodes.length}`);
console.log(`complete chains  : ${graph.checks.completeChains}`);
console.log(`broken chains    : ${graph.checks.brokenChains}`);
console.log();
for (const c of graph.checks.cycles) console.log(`  CYCLE: ${c}`);
for (const d of graph.checks.danglingNodes) console.log(`  NOT PRESENT: ${d.kind} ${d.key}`);
console.log();

/* ------------------------------------------------------------------ */
/* 3. the coverage                                                     */
/* ------------------------------------------------------------------ */

console.log(line());
console.log('--- 3. the coverage of the requirements ---');
console.log(line());
for (const [state, count] of Object.entries(report.byCoverage).sort()) {
  console.log(`  ${state.padEnd(12)} ${count}`);
}
console.log();
console.log('gaps by kind:');
for (const [kind, info] of Object.entries(report.gapsByKind).sort()) {
  // The requirement list is deduplicated: the same requirement appears
  // once per case that carries the gap, and the reader wants the SET.
  const unique = [...new Set(info.requirements)].sort();
  console.log(`  ${kind.padEnd(18)} ${String(info.count).padStart(4)} gap(s) over ${unique.length} requirement(s)`);
  console.log(`      ${unique.join(' ')}`);
}
console.log();

/* ------------------------------------------------------------------ */
/* 4. the consistency of the catalogue against the tree                */
/* ------------------------------------------------------------------ */

console.log(line());
console.log('--- 4. the consistency checks ---');
console.log(line());
const cc = consistencyChecks(view);
console.log(`ok                        : ${cc.ok}`);
console.log(`dangling test ids         : ${cc.danglingTest.length}`);
console.log(`dangling design anchors   : ${cc.danglingAnchor.length}`);
console.log(`orphan edges              : ${cc.orphanEdge.length}`);
console.log(`cases with no script      : ${cc.caseWithoutScript.length}`);
console.log(`  of which declared PASS  : ${cc.falsePass.length}   <- a false claim`);
console.log();
if (cc.falsePass.length) {
  console.log('the cases the catalogue declares PASS but that no script implements:');
  const byFamily = new Map();
  for (const f of cc.falsePass) {
    const family = f.testcase.replace(/[0-9]+[a-z]?$/, '');
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(f.testcase);
  }
  for (const [family, ids] of [...byFamily].sort()) {
    console.log(`  ${family.padEnd(14)} ${ids.length}  ${ids.slice(0, 6).join(' ')}${ids.length > 6 ? ' ...' : ''}`);
  }
  console.log();
}

/* ------------------------------------------------------------------ */
/* 5. the forward walk                                                 */
/* ------------------------------------------------------------------ */

console.log(line());
console.log('--- 5. the FORWARD walk: from a requirement down the chain ---');
console.log(line());

// A requirement that reaches the evidence end to end.
const verified = graph.chains.find((c) => c.coverage === 'verified');
// A requirement that is broken, and where.
const broken = graph.chains.find((c) => !c.complete && c.coverage === 'designed');

if (verified) {
  const t = traceRequirement(view, verified.requirementKey);
  console.log(`requirement ${verified.requirementKey}  (coverage: ${t.coverage})`);
  for (const hop of t.chain) {
    const names = hop.nodes.map((n) => n.key);
    console.log(`  hop ${hop.hop} ${hop.kind.padEnd(11)} ${names.length} node(s)`);
    for (const n of names.slice(0, 4)) console.log(`      ${n}`);
    if (names.length > 4) console.log(`      ... ${names.length - 4} more`);
  }
  console.log(`  gaps: ${t.gaps.length}`);
  for (const g of t.gaps.slice(0, 6)) console.log(`      [hop ${g.hop}] ${g.gap}: ${g.detail}`);
  if (t.gaps.length > 6) console.log(`      ... ${t.gaps.length - 6} more`);
  console.log();
}

if (broken) {
  const t = traceRequirement(view, broken.requirementKey);
  console.log(`requirement ${broken.requirementKey}  (coverage: ${t.coverage}) -- a chain with a gap:`);
  for (const hop of t.chain) {
    console.log(`  hop ${hop.hop} ${hop.kind.padEnd(11)} ${hop.nodes.length} node(s)`);
  }
  console.log('  the gaps:');
  for (const g of t.gaps) console.log(`      [hop ${g.hop}] ${g.gap}: ${g.detail}`);
  console.log();
}

/* ------------------------------------------------------------------ */
/* 6. the backward walk                                                */
/* ------------------------------------------------------------------ */

console.log(line());
console.log('--- 6. the BACKWARD walk: from an evidence file up to the requirement ---');
console.log(line());

if (verified) {
  const t = traceRequirement(view, verified.requirementKey);
  const withEvidence = t.cases.find((c) => c.evidence.length);
  if (withEvidence) {
    const evidence = withEvidence.evidence[0];
    console.log(`evidence     : ${evidence.file}`);
    console.log(`  kind       : ${evidence.subKind}`);
    console.log(`  sha256     : ${evidence.sha256 ?? '(a transcript: no digest of its own)'}`);
    const back = traceEvidence(view, { uid: evidence.uid });
    console.log(`backward walk: ${back.requirements.length} requirement(s) reached, ${back.unreached.length} unreached`);
    for (const r of back.requirements.slice(0, 6)) {
      console.log(`  ${r.requirement}  <-  ${r.design}  <-  ${r.testcase}   (via ${r.provenance})`);
    }
    if (back.requirements.length > 6) console.log(`  ... ${back.requirements.length - 6} more`);
    for (const u of back.unreached.slice(0, 4)) console.log(`  UNREACHED: ${u.reason}`);
    console.log();
  }
}

/* ------------------------------------------------------------------ */
/* 7. an evidence file that reaches nothing, and WHY                   */
/* ------------------------------------------------------------------ */

console.log(line());
console.log('--- 7. an evidence that reaches no requirement says WHY ---');
console.log(line());
const orphanEvidence = [...view.nodes.values()].filter((n) => {
  if (n.kind !== 'evidence') return false;
  const back = traceEvidence(view, { uid: n.uid });
  return back.requirements.length === 0 && back.unreached.length > 0;
});
console.log(`evidence nodes that reach no requirement: ${orphanEvidence.length}`);
const reasons = new Map();
for (const e of orphanEvidence.slice(0, 200)) {
  const back = traceEvidence(view, { uid: e.uid });
  for (const u of back.unreached) {
    const key = u.reason;
    if (!reasons.has(key)) reasons.set(key, []);
    reasons.get(key).push(e.file);
  }
}
for (const [reason, files] of reasons) {
  console.log(`  ${files.length} x  ${reason}`);
  console.log(`      e.g. ${files[0]}`);
}
console.log();
console.log(line('='));
console.log('END OF THE ATS-307 PROBE');
console.log(line('='));
