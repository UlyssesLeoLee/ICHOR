/**
 * ATS-307 -- the graph QUERIES.
 *
 * The graph is only worth building if a reader can WALK it. This module
 * answers the two questions the acceptance criterion names:
 *
 *   FORWARD  "from a requirement, what are its design, cases, scripts,
 *             runs and evidence?"
 *   BACKWARD "from an evidence file, which requirement does it verify?"
 *
 * AND, just as importantly, it answers the question that a matrix cannot:
 *
 *   "WHERE IS THE CHAIN BROKEN, AND WHICH HOP IS MISSING?"
 *
 * THE RULE ABOUT GAPS
 * -------------------
 * A gap is REPORTED, never filled. The forward walk returns the chain as
 * it is, together with the list of the hops that are missing and the
 * reason for each. The backward walk returns the requirements an
 * evidence file reaches -- and, when it reaches none, says so instead of
 * returning an empty list that reads like "nothing to see here".
 *
 * The backward walk is the one that can be silently wrong. If the join
 * between the catalogue ids and the runtime uids is broken, a backward
 * walk that returns nothing would look exactly like a backward walk over
 * an evidence file that verifies nothing. So the answer always carries
 * the REASON: `unreached` with the reason spelled out.
 *
 * THE BACKWARD WALK IS A REVERSE TRAVERSAL
 * -----------------------------------------
 * The graph stores only FORWARD edges (see `model.mjs`): every edge goes
 * from a lower hop to a higher one, so the graph is a DAG and the cycle
 * check means something. The backward walk therefore starts at the
 * evidence node and walks the edges BACKWARDS:
 *
 *   evidence <- run <- testcase <- design <- requirement
 *
 * The join is the run: the artifact was archived by the run, and the run
 * attempted the case. A reverse traversal that did not join through the
 * run would report an artifact as verifying every case of the project.
 */
import { CHAIN, COVERAGE, EDGE_TYPE, GAP, NODE_KIND, PROVENANCE, hopOf } from './model.mjs';

/**
 * A view of a graph: the nodes and edges indexed for traversal.
 */
export function indexGraph(graph) {
  const nodes = new Map();
  for (const n of graph.nodes) nodes.set(n.uid, n);
  const edges = new Map();
  for (const e of graph.edges) edges.set(e.uid, e);
  const out = new Map();
  const inc = new Map();
  for (const e of graph.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e);
    if (!inc.has(e.to)) inc.set(e.to, []);
    inc.get(e.to).push(e);
  }
  return { graph, nodes, edges, out, inc };
}

/**
 * The forward walk: from a requirement down the chain.
 *
 * The answer has four parts:
 *
 *   `chain`   the hops of the chain, each with the nodes at that hop
 *   `gaps`    the hops that are missing, each with a reason
 *   `coverage` the honest summary of how far the chain reaches
 *   `complete` whether the chain reached the evidence
 *
 * @param {object} view the indexed graph
 * @param {string} requirementKey the requirement id (`FR-001`)
 */
export function traceRequirement(view, requirementKey) {
  const chainRow = view.graph.chains.find((c) => c.requirementKey === requirementKey);
  if (!chainRow) {
    return {
      found: false,
      requirement: requirementKey,
      reason: `the traceability graph has no requirement ${requirementKey}`,
      chain: [],
      gaps: [],
      coverage: null,
      complete: false,
    };
  }
  const reqNode = view.nodes.get(chainRow.requirement);
  const designNodes = chainRow.design.map((u) => view.nodes.get(u)).filter(Boolean);
  const caseNodes = chainRow.testcases.map((u) => view.nodes.get(u)).filter(Boolean);

  const scriptNodes = [];
  const runNodes = [];
  const evidenceNodes = [];
  const caseDetails = [];
  for (const c of caseNodes) {
    const impl = (view.out.get(c.uid) ?? []).filter((e) => e.type === EDGE_TYPE.IMPLEMENTS);
    const att = (view.out.get(c.uid) ?? []).filter((e) => e.type === EDGE_TYPE.ATTEMPTED);
    const scripts = impl.map((e) => view.nodes.get(e.to)).filter(Boolean);
    const runs = att.map((e) => view.nodes.get(e.to)).filter(Boolean);
    // The evidence of a case is the evidence of the runs that executed it.
    const evidence = [];
    for (const r of runs) {
      for (const e of (view.out.get(r.uid) ?? []).filter((x) => x.type === EDGE_TYPE.ARCHIVED)) {
        const node = view.nodes.get(e.to);
        if (node) evidence.push(node);
      }
    }
    for (const s of scripts) if (!scriptNodes.includes(s)) scriptNodes.push(s);
    for (const r of runs) if (!runNodes.includes(r)) runNodes.push(r);
    for (const ev of evidence) if (!evidenceNodes.includes(ev)) evidenceNodes.push(ev);
    caseDetails.push({
      testcase: c.key,
      level: c.level ?? null,
      declaredStatus: c.declaredStatus ?? null,
      present: c.present !== false,
      scripts: scripts.map((s) => ({ uid: s.uid, file: s.key, line: s.line ?? null })),
      runs: runs.map((r) => ({ uid: r.uid, status: r.status ?? null, gitCommit: r.gitCommit ?? null })),
      evidence: evidence.map((ev) => ({ uid: ev.uid, file: ev.file ?? ev.key, sha256: ev.sha256 ?? null, subKind: ev.subKind ?? 'artifact' })),
    });
  }

  const chain = [
    { hop: hopOf(NODE_KIND.REQUIREMENT), kind: NODE_KIND.REQUIREMENT, nodes: reqNode ? [reqNode] : [] },
    { hop: hopOf(NODE_KIND.DESIGN), kind: NODE_KIND.DESIGN, nodes: designNodes },
    { hop: hopOf(NODE_KIND.TESTCASE), kind: NODE_KIND.TESTCASE, nodes: caseNodes },
    { hop: hopOf(NODE_KIND.SCRIPT), kind: NODE_KIND.SCRIPT, nodes: scriptNodes },
    { hop: hopOf(NODE_KIND.RUN), kind: NODE_KIND.RUN, nodes: runNodes },
    { hop: hopOf(NODE_KIND.EVIDENCE), kind: NODE_KIND.EVIDENCE, nodes: evidenceNodes },
  ];

  // The chain's own gaps (the requirement-level ones) plus the per-case
  // gaps. A hop is reported as missing when NOTHING reached it.
  const gaps = [...chainRow.gaps];
  for (const hop of chain) {
    if (hop.nodes.length) continue;
    const already = gaps.some((g) => g.hop === hop.hop);
    if (already) continue;
    gaps.push({
      gap: gapForHop(hop.kind),
      hop: hop.hop,
      detail: `the chain does not reach the ${hop.kind} hop`,
    });
  }
  gaps.sort((a, b) => (a.hop ?? 0) - (b.hop ?? 0));

  return {
    found: true,
    requirement: requirementKey,
    requirementUid: chainRow.requirement,
    chain,
    gaps,
    coverage: chainRow.coverage,
    complete: chainRow.complete,
    cases: caseDetails,
  };
}

/** The gap that describes a missing hop. */
export function gapForHop(kind) {
  switch (kind) {
    case NODE_KIND.DESIGN: return GAP.NO_DESIGN;
    case NODE_KIND.TESTCASE: return GAP.NO_TESTCASE;
    case NODE_KIND.SCRIPT: return GAP.NO_SCRIPT;
    case NODE_KIND.RUN: return GAP.NO_RUN;
    case NODE_KIND.EVIDENCE: return GAP.NO_EVIDENCE;
    default: return 'no-requirement';
  }
}

/**
 * The backward walk: from an evidence file up to the requirements.
 *
 * The evidence is addressed by its node uid OR by the pair
 * (run id, artifact file) that identifies it. The answer says whether the
 * evidence reached ANY requirement, and -- when it did not -- it says WHY,
 * because "no requirement" and "the join is broken" are different facts
 * and only one of them is a finding about the project.
 *
 * @param {object} view the indexed graph
 * @param {object} selector `{uid}` or `{runId, file}` or `{transcript, testId}`
 */
export function traceEvidence(view, selector) {
  let targets = [];
  if (selector?.uid) {
    targets = [...view.nodes.values()].filter((n) => n.uid === selector.uid && n.kind === NODE_KIND.EVIDENCE);
  } else if (selector?.runId && selector?.file) {
    targets = [...view.nodes.values()].filter(
      (n) => n.kind === NODE_KIND.EVIDENCE && n.runId === selector.runId && n.file === selector.file,
    );
  } else if (selector?.transcript) {
    targets = [...view.nodes.values()].filter(
      (n) => n.kind === NODE_KIND.EVIDENCE && n.subKind === 'transcript' && n.file === selector.transcript,
    );
  }
  if (!targets.length) {
    return {
      found: false,
      reason: 'the traceability graph has no evidence node for this selector',
      requirements: [],
      unreached: [{ reason: 'no such evidence node' }],
    };
  }

  const requirements = [];
  const unreached = [];
  for (const target of targets) {
    // Step 1: the run that archived this evidence.
    const archivedBy = (view.inc.get(target.uid) ?? []).filter((e) => e.type === EDGE_TYPE.ARCHIVED);
    if (!archivedBy.length) {
      unreached.push({
        evidence: target.uid,
        reason: 'no run archived this evidence',
      });
      continue;
    }
    for (const arch of archivedBy) {
      const runUid = arch.from;
      // Step 2: the cases that run attempted. This is the JOIN: the
      // artifact was archived by the run, and the run attempted the case.
      const attempted = (view.inc.get(runUid) ?? []).filter((e) => e.type === EDGE_TYPE.ATTEMPTED);
      if (!attempted.length) {
        unreached.push({
          evidence: target.uid,
          run: runUid,
          reason: 'the run that archived this evidence attempted no test case, so the evidence verifies nothing',
        });
        continue;
      }
      for (const att of attempted) {
        const caseUid = att.from;
        const caseNode = view.nodes.get(caseUid);
        // Step 3: the design element that covers the case.
        const covers = (view.inc.get(caseUid) ?? []).filter((x) => x.type === EDGE_TYPE.COVERS);
        if (!covers.length) {
          unreached.push({
            evidence: target.uid,
            testcase: caseNode?.key ?? caseUid,
            reason: 'the test case is covered by no design element, so no requirement reaches it',
          });
          continue;
        }
        for (const c of covers) {
          const designUid = c.from;
          const designNode = view.nodes.get(designUid);
          // The requirement the RTM's ROW bound this case to. The design
          // anchor is SHARED between requirements, so the anchor alone
          // would over-reach: `B04` is the design of FR-007 and of FR-008,
          // but only FR-007 lists UT-E-001. The binding on the edge is
          // where that truth lives.
          const boundRequirement = c.requirement ? view.nodes.get(c.requirement) : null;
          if (boundRequirement) {
            requirements.push({
              requirement: boundRequirement.key,
              requirementUid: boundRequirement.uid,
              design: designNode?.key ?? designUid,
              testcase: caseNode?.key ?? caseUid,
              evidence: target.uid,
              provenance: c.provenance,
            });
            continue;
          }
          // Step 4: the requirement the design element belongs to.
          const designs = (view.inc.get(designUid) ?? []).filter((x) => x.type === EDGE_TYPE.DESIGNS);
          if (!designs.length) {
            unreached.push({
              evidence: target.uid,
              testcase: caseNode?.key ?? caseUid,
              design: designNode?.key ?? designUid,
              reason: 'the design element is linked to no requirement',
            });
            continue;
          }
          for (const d of designs) {
            const reqNode = view.nodes.get(d.from);
            if (!reqNode) continue;
            requirements.push({
              requirement: reqNode.key,
              requirementUid: reqNode.uid,
              design: designNode?.key ?? designUid,
              testcase: caseNode?.key ?? caseUid,
              evidence: target.uid,
              provenance: d.provenance,
            });
          }
        }
      }
    }
  }

  // Deduplicate the requirement paths.
  const seen = new Set();
  const unique = [];
  for (const r of requirements) {
    const key = `${r.requirement}|${r.testcase}|${r.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  return {
    found: true,
    requirements: unique,
    unreached,
  };
}

/**
 * The coverage report: the state of every requirement's chain.
 *
 * The report is the "which gaps does the project have" view: it counts
 * the requirements by coverage state and lists the gaps by kind, so a
 * reader sees the SHAPE of the incompleteness rather than having to
 * enumerate it.
 */
export function coverageReport(view) {
  const byCoverage = {};
  for (const c of view.graph.chains) {
    byCoverage[c.coverage] = (byCoverage[c.coverage] ?? 0) + 1;
  }
  const gapsByKind = {};
  for (const c of view.graph.chains) {
    for (const g of c.gaps) {
      const key = g.gap;
      if (!gapsByKind[key]) gapsByKind[key] = { gap: key, count: 0, requirements: [] };
      gapsByKind[key].count += 1;
      gapsByKind[key].requirements.push(c.requirementKey);
    }
  }
  const kindCounts = {};
  for (const n of view.graph.nodes) kindCounts[n.kind] = (kindCounts[n.kind] ?? 0) + 1;
  const edgeCounts = {};
  for (const e of view.graph.edges) edgeCounts[e.type] = (edgeCounts[e.type] ?? 0) + 1;
  const provenanceCounts = {};
  for (const e of view.graph.edges) provenanceCounts[e.provenance] = (provenanceCounts[e.provenance] ?? 0) + 1;

  return {
    requirements: view.graph.chains.length,
    byCoverage,
    gapsByKind,
    nodesByKind: kindCounts,
    edgesByType: edgeCounts,
    edgesByProvenance: provenanceCounts,
    checks: view.graph.checks,
  };
}

/**
 * The consistency CHECKS of the graph.
 *
 * These are the "is the catalogue telling the truth" checks: they compare
 * what the catalogue CLAIMS against what the tree CONTAINS, and every
 * discrepancy is reported with the ids involved -- never summarised away.
 *
 * WHAT COUNTS AS A DISCREPANCY
 * -----------------------------
 * A case that the catalogue marks `PENDING` and that has no script is NOT
 * a discrepancy -- it is an honest gap, and the graph reports it as a
 * GAP (`no-script`). The catalogue says "this case is designed but not
 * automated", and the tree agrees.
 *
 * A case that the catalogue marks `PASS` and that has NO SCRIPT in the
 * tree IS a discrepancy: the catalogue claims the case was executed, and
 * nothing in the repository could have executed it. That is a false
 * claim, and it is reported as such.
 *
 * The same distinction applies to the design anchors: a phase marker
 * (`P1 Graph`) names a road and no document defines it, which is not a
 * discrepancy. An anchor that LOOKS like a document anchor (`B01`,
 * `UI-007`, `UC-01`) but that no document defines IS one.
 */
export function consistencyChecks(view) {
  const danglingTest = [];
  const danglingAnchor = [];
  const orphanEdge = [];
  const caseWithoutScript = [];
  const falsePass = [];

  for (const c of view.graph.chains) {
    for (const g of c.gaps) {
      if (g.gap === GAP.DANGLING_TEST) danglingTest.push({ requirement: c.requirementKey, detail: g.detail });
      if (g.gap === GAP.DANGLING_ANCHOR) danglingAnchor.push({ requirement: c.requirementKey, detail: g.detail });
    }
    for (const uid of c.testcases) {
      const node = view.nodes.get(uid);
      if (!node) continue;
      const impl = (view.out.get(uid) ?? []).filter((e) => e.type === EDGE_TYPE.IMPLEMENTS);
      if (impl.length) {
        // The case HAS a script. Whether the link is a declaration or a
        // catalogue reference is a WEAKNESS, not a discrepancy.
        continue;
      }
      const entry = {
        requirement: c.requirementKey,
        testcase: node.key,
        declaredStatus: node.declaredStatus ?? null,
      };
      caseWithoutScript.push(entry);
      // The catalogue claims the case was executed, but no script in the
      // tree implements it -- so nothing could have executed it.
      if (entry.declaredStatus === 'PASS') falsePass.push(entry);
    }
  }

  for (const e of view.graph.edges) {
    if (!view.nodes.has(e.from) || !view.nodes.has(e.to)) {
      orphanEdge.push({ edge: e.uid, type: e.type, from: e.from, to: e.to });
    }
  }

  return {
    ok: danglingTest.length === 0
      && danglingAnchor.length === 0
      && orphanEdge.length === 0
      && falsePass.length === 0,
    danglingTest,
    danglingAnchor,
    orphanEdge,
    caseWithoutScript,
    falsePass,
    requirements: view.graph.chains.length,
    requirementNodes: [...view.nodes.values()].filter((n) => n.kind === NODE_KIND.REQUIREMENT).length,
  };
}
