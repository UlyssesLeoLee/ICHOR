/**
 * ATS-307 -- the TRACEABILITY GRAPH: Requirement -> Design -> TestCase ->
 * Script -> Run -> Evidence.
 *
 * WHAT THIS PROBLEM IS
 * ---------------------
 * The repository already had a traceability MATRIX (`tests/rtm.json`, the
 * generated `docs/10-RTM.md`): a row per requirement, naming the design
 * anchor and the test ids. That matrix answers exactly ONE question --
 * "which tests belong to this requirement?" -- and it answers it in the
 * direction the reader already knows the answer to.
 *
 * The acceptance criterion of ATS-307 asks for more: a chain that can be
 * walked in BOTH directions, from a requirement down to the evidence that
 * verified it and from an evidence file back up to the requirement it
 * belongs to, with the GAPS of the chain made visible instead of silently
 * skipped.
 *
 * WHY A MATRIX IS NOT A GRAPH
 * ---------------------------
 * A matrix is a table of `requirement -> tests`. It has no identity for the
 * rows, no provenance, and no place to record that a requirement has NO
 * test at all. `tests/rtm.json` says `FR-022 -> TBD` -- but "TBD" is a
 * STRING in a cell, not a fact a program can query. A graph gives every
 * node and every edge a stable identity, a provenance (where the claim
 * came from) and a place to hang the gaps.
 *
 * WHAT THIS MODULE DELIVERS
 * --------------------------
 *   1. THE NODE TYPES. Six kinds, one per hop of the chain:
 *      `requirement`, `design`, `testcase`, `script`, `run`, `evidence`.
 *
 *   2. THE EDGES. Typed edges between them, each with the SOURCE that
 *      asserts the edge -- so a reader can tell "the RTM says this" from
 *      "the script itself says this".
 *
 *   3. THE STABLE UID. Every node's uid is a pure function of documented
 *      inputs (no clock, no randomness, no filesystem order), so the same
 *      tree always produces the same graph and the graph can be diffed
 *      across commits.
 *
 *   4. THE GAP. A chain that is missing a hop is REPORTED as missing. It
 *      is never filled with a placeholder that looks like a real node: a
 *      graph that quietly invents the missing link is worse than a graph
 *      that admits it does not have one.
 *
 * THE THREE THINGS THAT MUST NOT BE CONFUSED
 * -------------------------------------------
 *   * WHAT THE CATALOG CLAIMS and WHAT THE REPOSITORY CONTAINS are two
 *     different questions. `tests/rtm.json` claims that FR-021 is covered
 *     by UT-DSC-001. Whether `UT-DSC-001` actually exists as a `test(...)`
 *     in the tree is a SEPARATE fact, and the graph records both: the
 *     claim is an edge, the existence is the node's `present` flag.
 *
 *   * WHAT RAN and WHAT WAS DECLARED PASS are two different facts. A test
 *     id in the catalogue with `status: PASS` is a CLAIM made by the
 *     generator; a transcript under `docs/evidence/` that actually prints
 *     the id is a FACT. The graph keeps them apart, and a case that is
 *     declared PASS but was never observed running is reported as such.
 *
 *   * A MISSING HOP IS NOT AN ERROR. It is the state of the project: 10 of
 *     the 49 requirements have no test at all (`TBD`), and most of the ST
 *     cases have never been executed on a real machine. The graph's job is
 *     to SHOW that, accurately, not to hide it and not to panic about it.
 */
import crypto from 'node:crypto';

export const TRACEABILITY_GRAPH_VERSION = 1;

/**
 * The six kinds of node, in the order of the chain. The order is the
 * canonical topological order of the chain, and it is what makes the
 * "which hop is missing" question answerable: a gap between two hops
 * names the hop that is absent.
 */
export const NODE_KIND = Object.freeze({
  REQUIREMENT: 'requirement',
  DESIGN: 'design',
  TESTCASE: 'testcase',
  SCRIPT: 'script',
  RUN: 'run',
  EVIDENCE: 'evidence',
});

/** The chain, in order. `indexOf` on it gives the hop number. */
export const CHAIN = Object.freeze([
  NODE_KIND.REQUIREMENT,
  NODE_KIND.DESIGN,
  NODE_KIND.TESTCASE,
  NODE_KIND.SCRIPT,
  NODE_KIND.RUN,
  NODE_KIND.EVIDENCE,
]);

/** The hop number of a node kind, or -1 when the kind is not in the chain. */
export function hopOf(kind) {
  return CHAIN.indexOf(kind);
}

/**
 * The edge types. Each edge names WHAT it asserts, and each edge is
 * attributed to the source that asserts it:
 *
 *   requirement -> design   `designs`      the RTM's design anchor
 *   design      -> testcase `covers`      the RTM's test list
 *   testcase    -> script   `implemented`  the script that declares the case
 *   testcase    -> run      `attempted`    the attempt that executed it
 *   run         -> evidence `archived`     the artifact the run archived
 *
 * THE GRAPH IS A DAG BY CONSTRUCTION, AND EVERY EDGE FLOWS FORWARD
 * --------------------------------------------------------------------
 * Every edge goes from a lower hop to a higher one:
 *
 *   requirement(0) -> design(1) -> testcase(2) -> script(3)
 *                                       |              |
 *                                       +-> run(4) ---+-> evidence(5)
 *
 * There is deliberately NO `evidence -> testcase` edge. The backward walk
 * (「这条证据验的是哪条要件」) is a REVERSE TRAVERSAL of these edges, not a
 * second set of edges:
 *
 *   * a stored reverse edge would make the graph cyclic -- evidence ->
 *     testcase -> run -> evidence -- and the acceptance criterion asks
 *     for the cycles to be CHECKABLE, so a graph whose own model
 *     manufactures cycles would make the check meaningless;
 *   * a stored reverse edge would also DUPLICATE information: the pair
 *     (evidence, testcase) is already implied by the run that archived the
 *     evidence and the attempt the run recorded.
 *
 * So the graph stores the forward DAG and the backward walk is computed
 * from it. `traceEvidence()` in `query.mjs` walks it.
 */
export const EDGE_TYPE = Object.freeze({
  DESIGNS: 'designs',
  COVERS: 'covers',
  IMPLEMENTS: 'implemented',
  ATTEMPTED: 'attempted',
  ARCHIVED: 'archived',
});

/**
 * The source of a fact. The provenance is not decoration: a reader has to
 * be able to tell an asserted relationship from an observed one.
 *
 *   `catalog`  -- the generated RTM / test catalogue asserts it
 *   `source`   -- the script in the tree declares it
 *   `runtime`  -- a run record / manifest in the local state asserts it
 *   `evidence` -- a transcript under docs/evidence/ shows it
 */
export const PROVENANCE = Object.freeze({
  CATALOG: 'catalog',
  SOURCE: 'source',
  RUNTIME: 'runtime',
  EVIDENCE: 'evidence',
});

const NUL = '\x00';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * The stable uid of a graph node.
 *
 * The uid is `trc_1_<24 hex>`: the same scheme family as the Project /
 * Run / Attempt uids of `docs/18-UID-SPEC.md` (`run_1_<24 hex>`), so the
 * traceability graph does not introduce a second identity dialect.
 *
 * The basis is the kind plus the node's OWN key -- never the position in
 * an array and never a counter. Two consequences matter:
 *
 *   * inserting a node does not renumber the others;
 *   * the same node in two checkouts has the same uid, so a graph can be
 *     diffed across commits.
 *
 * @param {string} kind one of NODE_KIND
 * @param {string} key the node's own identity (the requirement id, the
 *        script path, the run uid, the evidence digest ...)
 */
export function nodeUid(kind, key) {
  return `trc_1_${sha256(`${kind}${NUL}${String(key ?? '')}`).slice(0, 24)}`;
}

/**
 * The stable uid of an edge.
 *
 * The basis is the two endpoints plus the edge type: the same pair of
 * nodes may be connected by different edge types (a testcase is both
 * `implemented` by a script and `attempted` by a run), and those are
 * different facts.
 */
export function edgeUid(from, to, type) {
  return `tre_1_${sha256(`${from}${NUL}${to}${NUL}${type}`).slice(0, 24)}`;
}

/**
 * A node of the graph.
 *
 * `present` is the crucial field: it says whether the thing the node
 * DESCRIBES actually exists in the repository (or in the local state).
 * A node that is declared by a catalogue but has no script is a node with
 * `present: false` -- it is still a node, because the catalogue talks
 * about it, and hiding it would make the gap invisible.
 *
 * The `kind` and `uid` of a node are NOT overridable by the data: the
 * kind is what the chain is built from, and a caller that could change
 * it could put a script into the requirement hop. The `subKind` field
 * carries the finer distinction (a `module`, a `screen`, a `phase`).
 *
 * @param {string} kind
 * @param {string} key the node's own key (stable, human readable)
 * @param {object} data the node's attributes
 */
export function makeNode(kind, key, data = {}) {
  const { kind: _ignoredKind, uid: _ignoredUid, ...rest } = data;
  return {
    uid: nodeUid(kind, key),
    kind,
    key: String(key),
    present: rest.present !== false,
    ...rest,
  };
}

/**
 * An edge of the graph.
 */
export function makeEdge(fromNode, toNode, type, provenance, data = {}) {
  return {
    uid: edgeUid(fromNode.uid, toNode.uid, type),
    from: fromNode.uid,
    to: toNode.uid,
    type,
    provenance,
    ...data,
  };
}

/**
 * The kinds of GAP the chain can have. Each one names a hop that is
 * absent, and each one says what is missing:
 *
 *   `no-design`        the requirement names no design anchor
 *   `no-testcase`      the requirement has no test case at all (`TBD`)
 *   `no-script`        the test case is declared but no script implements it
 *   `no-declaration`   the script is known only through the catalogue --
 *                      it implements the case without naming the case id
 *   `no-run`           the test case was never executed
 *   `no-evidence`      the run archived no evidence for the case
 *   `dangling-test`    the RTM names a test id the catalogue does not have
 *   `dangling-anchor`  the RTM names a design anchor no document defines
 *
 * `no-declaration` is a WEAKER gap than `no-script`, and it is kept
 * separate on purpose: the script hop is REACHED (the catalogue says this
 * script ran the case, and the script exists), but the link could not be
 * confirmed from the source itself. Reporting it as `no-script` would
 * say the case has no implementation, which is not what was found.
 */
export const GAP = Object.freeze({
  NO_DESIGN: 'no-design',
  NO_TESTCASE: 'no-testcase',
  NO_SCRIPT: 'no-script',
  NO_DECLARATION: 'no-declaration',
  NO_RUN: 'no-run',
  NO_EVIDENCE: 'no-evidence',
  DANGLING_TEST: 'dangling-test',
  DANGLING_ANCHOR: 'dangling-anchor',
});

/**
 * The relation between a requirement's coverage and the state of the
 * project. This is the honest summary of a chain:
 *
 *   `verified`     the chain reaches an observed execution with evidence
 *   `executed`     the chain reaches an observed execution (no evidence)
 *   `implemented`  the chain reaches a script in the tree, never executed
 *   `designed`     the chain stops at the design anchor
 *   `uncovered`    the chain stops at the requirement
 */
export const COVERAGE = Object.freeze({
  VERIFIED: 'verified',
  EXECUTED: 'executed',
  IMPLEMENTED: 'implemented',
  DESIGNED: 'designed',
  UNCOVERED: 'uncovered',
});

/**
 * The ORDER the coverage states are ranked in. A requirement's coverage is
 * the BEST state any of its test cases reaches -- a requirement with one
 * verified case and two unexecuted ones is `verified`, because the chain
 * did reach the evidence for it.
 */
export const COVERAGE_RANK = Object.freeze({
  [COVERAGE.VERIFIED]: 5,
  [COVERAGE.EXECUTED]: 4,
  [COVERAGE.IMPLEMENTED]: 3,
  [COVERAGE.DESIGNED]: 2,
  [COVERAGE.UNCOVERED]: 1,
});

/**
 * The coverage of a requirement, given the states of its test cases.
 *
 * The state of a CASE is the deepest hop the case itself reaches:
 *
 *   verified     the case was executed and left evidence behind
 *   executed     the case was executed, but no evidence was archived
 *   implemented  a script implements the case, but it was never executed
 *   designed     the case is DECLARED (it exists in the catalogue) but no
 *                script implements it
 *   uncovered    the case does not exist at all
 *
 * A requirement's coverage is the BEST state any of its cases reaches.
 * A requirement with no case at all falls back to its design hop, so a
 * designed-but-untested requirement is `designed` and not `uncovered`.
 */
export function bestCoverage(states) {
  let best = COVERAGE.UNCOVERED;
  for (const s of states) {
    if ((COVERAGE_RANK[s] ?? 0) > (COVERAGE_RANK[best] ?? 0)) best = s;
  }
  return best;
}
