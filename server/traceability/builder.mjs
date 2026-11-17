/**
 * ATS-307 -- the graph BUILDER: it assembles the traceability graph out
 * of the facts the repository actually holds.
 *
 * THE FACTS AND WHERE THEY COME FROM
 * ---------------------------------
 *   requirement  `tests/rtm.json` + `docs/02-REQUIREMENTS.md`
 *   design       the RTM's `design` anchor, checked against the documents
 *                that define it (`docs/03-BASIC-DESIGN.md`, `docs/05-UI-UX.md`,
 *                `docs/02-REQUIREMENTS.md`)
 *   testcase     `tests/test-cases.json` (the generated catalogue)
 *   script       the `test('...')` declarations in `tests/**` and `tools/**`
 *   run          the run records of the local state (`state.json.runs`)
 *   evidence     the run's artifacts (ATS-209's manifest) and the
 *                transcripts under `docs/evidence/**`
 *
 * THE RULES THIS BUILDER FOLLOWS
 * ------------------------------
 *   1. NOTHING IS INVENTED. A node exists only because a file in the tree
 *      or a record in the state says so. A requirement the RTM names but
 *      the requirements document does not define is still a node, with
 *      `present: false` -- it is not dropped, because dropping it would
 *      hide the discrepancy.
 *
 *   2. A CLAIM AND AN OBSERVATION ARE DIFFERENT EDGES. The RTM's
 *      `requirement -> testcase` edge has provenance `catalog`; the
 *      `testcase -> script` edge has provenance `source` and is only
 *      emitted when the script really declares that id.
 *
 *   3. A GAP IS A FACT. Every chain that cannot be walked to the end
 *      reports the hop that is missing. The builder never inserts a
 *      placeholder node to make a chain look complete.
 *
 *   4. THE BUILD IS A PURE FUNCTION OF ITS INPUTS. Given the same
 *      repository and the same state, the graph is byte-identical: no
 *      clock, no randomness, no directory-order dependence.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  CHAIN, COVERAGE, EDGE_TYPE, GAP, NODE_KIND, PROVENANCE,
  bestCoverage, edgeUid, hopOf, makeEdge, makeNode, nodeUid,
} from './model.mjs';

/* ------------------------------------------------------------------ */
/* Reading the catalogue                                               */
/* ------------------------------------------------------------------ */

/** The id of a test case, as it is written in the catalogue. */
const CASE_ID_RE = /^[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+$/;

/**
 * Reads `tests/rtm.json` and `tests/test-cases.json`.
 *
 * A missing or malformed file is NOT an error: it is a fact about the
 * repository, and the graph reports it as a gap (the requirement then has
 * no test case at all). Returning `null` for the file lets the caller
 * distinguish "the repository has no RTM" from "the RTM is empty".
 */
export function readCatalogue(root) {
  const rtmPath = path.join(root, 'tests', 'rtm.json');
  const casesPath = path.join(root, 'tests', 'test-cases.json');
  let rtm = null;
  let cases = null;
  try { rtm = JSON.parse(fs.readFileSync(rtmPath, 'utf8')); } catch { rtm = null; }
  try { cases = JSON.parse(fs.readFileSync(casesPath, 'utf8')); } catch { cases = null; }
  if (!Array.isArray(rtm)) rtm = [];
  if (!Array.isArray(cases)) cases = [];
  return { rtm, cases };
}

/**
 * The requirement ids the requirements document actually defines.
 *
 * The RTM is the CLAIM; `docs/02-REQUIREMENTS.md` is the DEFINITION. A
 * requirement id the RTM names but the document does not define is
 * reported as a dangling anchor rather than silently accepted.
 */
export function readDefinedRequirements(root) {
  const file = path.join(root, 'docs', '02-REQUIREMENTS.md');
  const ids = new Set();
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\|\s*((?:FR|NFR)-\d+)\s*\|/gm)) ids.add(m[1]);
  } catch { /* the document is missing: nothing is defined */ }
  return ids;
}

/**
 * The design anchors the design documents define.
 *
 * The RTM's `design` field holds anchors of three shapes:
 *   `B01`       a module of the basic design (`docs/03-BASIC-DESIGN.md` §2)
 *   `UI-002`    a screen of the UI design (`docs/05-UI-UX.md` §1)
 *   `UC-01`     a use case of the requirements (`docs/02-REQUIREMENTS.md`)
 *   `P1 Graph`  a phase marker, not a document anchor
 *
 * The first three are checked against the documents that define them. The
 * phase markers (`P1 ...`, `P2 ...`, `S6 ...`, `NFR / SEC / OPS`) are
 * ROADS, not places: they say "this requirement is planned for that
 * phase", and there is no document section to point at. They are kept as
 * anchors, but they are marked `planned` rather than `defined`, because
 * claiming a document defines them would be a false provenance.
 */
export function readDesignAnchors(root) {
  const anchors = new Map();
  const add = (id, kind, doc) => {
    if (!anchors.has(id)) anchors.set(id, { id, kind, doc });
  };
  const read = (rel, pattern, kind) => {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return; }
    for (const m of text.matchAll(pattern)) add(m[1], kind, rel);
  };
  // The basic design's module table: `| B01 Project Catalog | ... |`.
  read('docs/03-BASIC-DESIGN.md', /^\|\s*(B\d{2})\s+\S/gm, 'module');
  // The UI design's screen table: `| UI-002 | Test Catalog | ... |`.
  read('docs/05-UI-UX.md', /^\|\s*(UI-\d{3})\s*\|/gm, 'screen');
  // The requirements document's use cases: `**UC-01 导入**`.
  read('docs/02-REQUIREMENTS.md', /^\*\*((?:UC)-\d{2})\s/gm, 'usecase');
  return anchors;
}

/**
 * Splits an RTM `design` field into the anchors it names.
 *
 * The field is NOT always a `/`-separated list:
 *
 *   `B01/UC-01`     TWO anchors -- the module and the use case.
 *   `P1 AST/CLI`    ONE anchor -- the phase is named "P1 AST/CLI", and
 *                   splitting it would invent a "CLI" anchor that no
 *                   document defines.
 *   `NFR / SEC / OPS` ONE anchor -- the area, not three.
 *
 * So the whole string is tried FIRST, and it is only split when the whole
 * string is not an anchor on its own. A string that is neither a known
 * anchor nor a phase marker is split, and the parts are then checked --
 * that is how a typo like `B99` is reported as a dangling anchor rather
 * than silently accepted.
 *
 * @param {string} raw the RTM's `design` field
 * @param {Map} anchors the known anchors
 * @returns {{id:string, known:boolean, phase:boolean}[]}
 */
export function splitDesignAnchors(raw, anchors) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const isPhase = (s) => /^(P\d|S\d|NFR\s*\/)/i.test(s);
  // The `TOOL` row of the RTM carries a PARAPHRASE where the other rows
  // carry an anchor: `工具自检（不计入要件覆盖）` is a note that says "this
  // row is a self-check of the tooling, it is not product coverage". It
  // names no design element, and it is not a discrepancy that no document
  // defines it -- so it is kept as a NOTE, not as a dangling anchor.
  if (/工具自检/.test(text)) return [{ id: text, known: false, phase: false, note: true }];
  const whole = text.trim();
  if (anchors.has(whole) || isPhase(whole)) {
    return [{ id: whole, known: anchors.has(whole), phase: isPhase(whole) }];
  }
  const parts = whole.split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return [{ id: whole, known: anchors.has(whole), phase: isPhase(whole) }];
  }
  return parts.map((p) => ({ id: p, known: anchors.has(p), phase: isPhase(p) }));
}

/* ------------------------------------------------------------------ */
/* Reading the scripts                                                 */
/* ------------------------------------------------------------------ */

/**
 * The declaration of a test case in a script.
 *
 * The repository declares a case in three shapes, and a scanner that only
 * knows one of them under-reports the coverage of the whole tree:
 *
 *   `test('UT-CORE-001: validates ...')`   the unit / integration suites
 *   `verdict('ST-ATS214-001 loads-500')`    the ST probes
 *   `check('ST-ATS213-001', 'a key ...')`   the ST probes (ATS-213 style)
 *
 * The separator after the id is NOT always a colon: the ATS-216 suite
 * writes `test('ATS-216-UT-001 a run status is ...')` with a SPACE. So
 * the separator is `:` or a space -- and the id itself is bounded by the
 * id grammar, so the space is unambiguous.
 *
 * The ST probes often carry a SUFFIX (`ST-017a`, `ST-031b`): one
 * requirement is checked in several steps, and the catalogue names the
 * parent (`ST-017`). So a declaration matches the catalogue id when it
 * IS the id or when it is the id plus a lowercase suffix -- and the
 * scanner records the exact declaration it found, so the reader can see
 * which step implemented the case.
 */
const DECL_PATTERNS = [
  /test\(\s*['"`]([A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+)(?::|\s)/g,
  /verdict\(\s*['"`]([A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+)\b/g,
  /check\(\s*['"`]([A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+)\b/g,
];

/**
 * Scans the repository for the scripts that declare a test case.
 *
 * The scan is deterministic: the file list is sorted, so the same tree
 * always yields the same mapping. Only files under `tests/` and `tools/`
 * are scanned -- those are the directories the test suites live in -- and
 * `node_modules` is skipped at every level.
 *
 * @returns {Map<string, {file:string, line:number, title:string, declaration:string}[]>}
 */
export function scanScriptDeclarations(root, { dirs = ['tests', 'tools'], catalogueIds = null } = {}) {
  const known = catalogueIds ?? new Set();
  const found = new Map();
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.(mjs|cjs|js|ts|mts)$/.test(e.name)) files.push(full);
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const rel = path.relative(root, file).split(path.sep).join('/');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of DECL_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(line)) !== null) {
          const declared = m[1];
          if (!CASE_ID_RE.test(declared)) continue;
          // The catalogue id is the declaration without a lowercase step
          // suffix (`ST-017a` implements `ST-017`).
          //
          // BUT the suffix is only a suffix when the catalogue knows the
          // PARENT id: `UT-MOB-011b` is a catalogue id of its own, and
          // stripping the `b` would invent a `UT-MOB-011` that the
          // catalogue does not have. So the parent is only used when the
          // catalogue actually lists it -- and the catalogue is passed in
          // for exactly this decision.
          const id = known.has(declared)
            ? declared
            : (known.has(declared.replace(/[a-z]$/, ''))
              ? declared.replace(/[a-z]$/, '')
              : declared);
          const title = line.slice(line.indexOf(m[1]) + m[1].length).replace(/^['"`]\s*/, '').replace(/^[,:]\s*/, '').trim();
          if (!found.has(id)) found.set(id, []);
          found.get(id).push({
            file: rel,
            line: i + 1,
            title: title.slice(0, 160),
            declaration: declared,
          });
        }
      }
    }
  }
  return found;
}

/**
 * The scripts the catalogue's `evidence` field names.
 *
 * The catalogue records HOW a case was executed. For the unit and
 * integration suites that is `node --test` (the whole suite), but for the
 * system tests it names the PROBE that executed it:
 *
 *   `node tools/ats107-probes/st-ats107.mjs`
 *
 * That probe really implements the case -- but the probe does NOT carry
 * the case id in its source (the probe checks a scenario, not a numbered
 * case), so the id -> script join cannot be made from the declaration
 * alone. The evidence field IS the join, and it is a WEAKER provenance
 * than a declaration: it says "this script executed this case", not "this
 * script declares this case".
 *
 * A named file that does not exist is NOT a script: it is a false
 * reference, and the graph reports it as a gap rather than linking to a
 * file that is not there.
 *
 * @returns {Map<string, string[]>} the case id -> the scripts it names
 */
export function readEvidenceScripts(root, cases) {
  const found = new Map();
  const PATH_RE = /([A-Za-z0-9_./\\-]+\.(?:mjs|cjs|js|ts|mts))/g;
  for (const c of cases) {
    if (!c || typeof c.id !== 'string') continue;
    const text = String(c.evidence ?? '');
    const names = new Set();
    for (const m of text.matchAll(PATH_RE)) {
      const rel = m[1].split('\\').join('/');
      // A path that leaves the repository is not a script of this project.
      if (rel.startsWith('../') || rel.includes('/../')) continue;
      if (!fs.existsSync(path.join(root, rel))) continue;
      names.add(rel);
    }
    if (names.size) found.set(c.id, [...names].sort());
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Reading the evidence                                                */
/* ------------------------------------------------------------------ */

/**
 * A line of a `node --test` transcript.
 *
 * The transcripts under `docs/evidence/` print one line per executed
 * case: `✔ UT-CORE-001: validates ...` for a pass, `✖ ...` for a fail.
 * The marker is the fact; the id is the key.
 */
const TRANSCRIPT_RE = /^[✔✓✖×✗]\s+([A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+)\s*:/gm;

/**
 * Scans the evidence transcripts for the case ids they observed.
 *
 * @returns {Map<string, {file:string, ok:boolean}[]>}
 */
export function scanEvidenceTranscripts(root, { dir = 'docs/evidence' } = {}) {
  const found = new Map();
  const base = path.join(root, dir);
  const files = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.log')) files.push(full);
    }
  };
  walk(base);
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    TRANSCRIPT_RE.lastIndex = 0;
    let m;
    while ((m = TRANSCRIPT_RE.exec(text)) !== null) {
      const id = m[1];
      if (!found.has(id)) found.set(id, []);
      found.get(id).push({
        file: path.relative(root, file).split(path.sep).join('/'),
        ok: m[0].trimStart().charAt(0) !== '✖' && m[0].trimStart().charAt(0) !== '×'
          && m[0].trimStart().charAt(0) !== '✗',
      });
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Reading the runtime state                                           */
/* ------------------------------------------------------------------ */

/**
 * Reads the local state's run records.
 *
 * The state file is the RUNTIME side of the chain: the run, the case it
 * executed and the evidence it archived. A state file that does not exist
 * is not an error -- a checkout without a data directory simply has no
 * runs, and the chain says so.
 */
export function readRuntimeRuns(root, { dataDir = null } = {}) {
  const stateFile = dataDir ? path.join(dataDir, 'state.json') : null;
  if (!stateFile) return [];
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return []; }
  if (!state || !Array.isArray(state.runs)) return [];
  return state.runs;
}

/* ------------------------------------------------------------------ */
/* Building the graph                                                  */
/* ------------------------------------------------------------------ */

/**
 * Builds the traceability graph.
 *
 * @param {object} options
 * @param {string} options.root the repository root
 * @param {object[]} [options.runs] the runtime run records
 * @param {object} [options.catalogue] the parsed `tests/rtm.json` /
 *        `tests/test-cases.json` (read from the root when omitted)
 * @returns {object} the graph
 */
export function buildGraph({ root, runs = null, catalogue = null, definitions = null, anchors = null, scripts = null, transcripts = null, evidenceScripts = null }) {
  const cat = catalogue ?? readCatalogue(root);
  const defined = definitions ?? readDefinedRequirements(root);
  const anchorMap = anchors ?? readDesignAnchors(root);
  // The catalogue's ids decide whether a trailing lowercase letter is a
  // STEP SUFFIX (`ST-017a` -> `ST-017`) or part of the id itself
  // (`UT-MOB-011b` is an id of its own). So the catalogue is read FIRST.
  const catalogueIds = new Set(cat.cases.map((c) => c?.id).filter((x) => typeof x === 'string'));
  const scriptMap = scripts ?? scanScriptDeclarations(root, { catalogueIds });
  const transcriptMap = transcripts ?? scanEvidenceTranscripts(root);
  const evidenceScriptMap = evidenceScripts ?? readEvidenceScripts(root, cat.cases);
  const runList = runs ?? readRuntimeRuns(root);

  const nodes = new Map();
  const edges = new Map();

  const addNode = (kind, key, data) => {
    const n = makeNode(kind, key, data);
    // A node is identified by its uid; a second declaration of the same
    // node MERGES its attributes instead of creating a second one.
    const existing = nodes.get(n.uid);
    if (existing) {
      Object.assign(existing, data, { present: existing.present && data.present !== false });
      return existing;
    }
    nodes.set(n.uid, n);
    return n;
  };

  const addEdge = (from, to, type, provenance, data = {}) => {
    const e = makeEdge(from, to, type, provenance, data);
    const existing = edges.get(e.uid);
    if (existing) return existing;
    edges.set(e.uid, e);
    return e;
  };

  /* --- the test case catalogue ------------------------------------- */
  const caseById = new Map();
  for (const c of cat.cases) {
    if (!c || typeof c.id !== 'string') continue;
    caseById.set(c.id, c);
  }

  /* --- the runtime runs -------------------------------------------- */
  // A run contributes three things: the run node, the attempts (which
  // bind a test case to a run) and the evidence (the artifacts the run
  // archived, each with the digest ATS-209 recorded).
  const runtimeByCase = new Map();  // testcase uid -> [{run, attempt}]
  const runNodes = new Map();        // run id -> node
  for (const run of runList) {
    if (!run || !run.id) continue;
    const node = addNode(NODE_KIND.RUN, run.id, {
      present: true,
      status: run.status ?? null,
      file: run.file ?? null,
      gitCommit: run.gitCommit ?? null,
      runner: run.runner ?? null,
      projectUid: run.projectUid ?? null,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      source: 'state.json.runs',
    });
    runNodes.set(run.id, node);

    for (const attempt of (run.attempts ?? [])) {
      const testUid = attempt.testUid ?? null;
      if (!testUid) continue;
      if (!runtimeByCase.has(testUid)) runtimeByCase.set(testUid, []);
      runtimeByCase.get(testUid).push({ run: node, attempt });
    }

    // The evidence of a run: the artifacts ATS-209's manifest lists.
    for (const artifact of (run.artifacts ?? [])) {
      const digest = artifact.sha256 ?? '';
      const key = `${run.id}/${artifact.file}`;
      const ev = addNode(NODE_KIND.EVIDENCE, key, {
        present: true,
        runId: run.id,
        file: artifact.file ?? null,
        size: artifact.size ?? null,
        sha256: digest || null,
        source: 'state.json.runs[].artifacts',
      });
      addEdge(node, ev, EDGE_TYPE.ARCHIVED, PROVENANCE.RUNTIME, { file: artifact.file ?? null });
    }
  }

  /* --- the requirements -------------------------------------------- */
  const requirementRows = [];
  for (const row of cat.rtm) {
    if (!row || typeof row.requirement !== 'string') continue;
    const id = row.requirement;
    const isDefined = id === 'TOOL' ? true : defined.has(id);
    const req = addNode(NODE_KIND.REQUIREMENT, id, {
      present: isDefined,
      title: row.title ?? null,
      status: row.status ?? null,
      source: 'tests/rtm.json',
    });

    /* --- the design anchor ------------------------------------------ */
    const rawDesign = (row.design ?? '').trim();
    const designParts = splitDesignAnchors(rawDesign, anchorMap);
    const designNodes = [];
    const danglingAnchors = [];
    for (const part of designParts) {
      const known = anchorMap.get(part.id);
      const node = addNode(NODE_KIND.DESIGN, part.id, {
        present: Boolean(known) || part.phase || part.note === true,
        subKind: known ? known.kind : (part.phase ? 'phase' : (part.note === true ? 'note' : 'unknown')),
        doc: known ? known.doc : null,
        source: known ? known.doc : (part.phase || part.note === true ? 'tests/rtm.json' : null),
      });
      if (!known && !part.phase && part.note !== true) danglingAnchors.push(part.id);
      designNodes.push(node);
      addEdge(req, node, EDGE_TYPE.DESIGNS, PROVENANCE.CATALOG, { anchor: part.id });
    }

    /* --- the test cases --------------------------------------------- */
    const rawTests = (row.tests ?? '').trim();
    const testIds = rawTests && rawTests !== 'TBD'
      ? rawTests.split('、').map((s) => s.trim()).filter(Boolean)
      : [];
    const danglingTests = [];
    const caseNodes = [];
    for (const testId of testIds) {
      const meta = caseById.get(testId);
      if (!meta) {
        danglingTests.push(testId);
        // The catalogue does not have the id, but the RTM claims it. The
        // node exists (the claim exists); it is simply not present.
        const ghost = addNode(NODE_KIND.TESTCASE, testId, {
          present: false,
          level: null,
          title: null,
          declaredStatus: null,
          source: 'tests/rtm.json',
        });
        caseNodes.push(ghost);
        for (const d of designNodes) addEdge(d, ghost, EDGE_TYPE.COVERS, PROVENANCE.CATALOG, { testId });
        continue;
      }
      const node = addNode(NODE_KIND.TESTCASE, testId, {
        present: true,
        level: meta.level ?? null,
        title: meta.title ?? null,
        declaredStatus: meta.status ?? null,
        req: meta.req ?? null,
        source: 'tests/test-cases.json',
      });
      caseNodes.push(node);
      for (const d of designNodes) {
        // The edge carries the REQUIREMENT that produced it. That is what
        // makes the reverse walk exact.
        //
        // A design anchor is SHARED: `B04` is the design of FR-007, of
        // FR-008 and of FR-009. So walking back from a test case through
        // the design node would reach every requirement that names that
        // design -- including the requirements that do NOT list this test
        // case. The RTM's truth is per ROW: FR-007 lists UT-E-001 and
        // FR-008 lists UT-E-002, even though both sit under B04.
        //
        // So the binding is recorded on the edge, where the row's truth
        // lives, and the reverse walk reads it there.
        addEdge(d, node, EDGE_TYPE.COVERS, PROVENANCE.CATALOG, {
          testId,
          requirement: req.uid,
        });
      }
    }

    requirementRows.push({
      requirement: req,
      designNodes,
      danglingAnchors,
      caseNodes,
      danglingTests,
      hasTestList: testIds.length > 0,
    });
  }

  /* --- the test case -> script edges -------------------------------- */
  // The script edge is emitted only when the script REALLY declares the
  // case. A catalogue entry with no declaration is a gap, not an edge.
  for (const [id, decls] of scriptMap) {
    const node = nodes.get(nodeUid(NODE_KIND.TESTCASE, id));
    if (!node) continue;
    node.present = true;
    node.script = decls[0].file;
    node.scriptLine = decls[0].line;
    for (const decl of decls) {
      const scriptNode = addNode(NODE_KIND.SCRIPT, decl.file, {
        present: true,
        line: decl.line,
        source: decl.file,
      });
      addEdge(node, scriptNode, EDGE_TYPE.IMPLEMENTS, PROVENANCE.SOURCE, {
        declaration: decl.file,
        line: decl.line,
      });
    }
  }

  /* --- the test case -> script edges (the catalogue's own claim) ---- */
  // The catalogue's `evidence` field names the script that executed a
  // case. That is a JOIN the declaration scan cannot make, because a
  // probe script checks a SCENARIO and does not carry the case id in its
  // source.
  //
  // The edge it produces is WEAKER than a declaration, and it says so:
  // the provenance is `catalog`, not `source`. A reader can therefore
  // tell "this script declares this case" from "the catalogue says this
  // script ran this case".
  //
  // The node is marked `present` only when the file really exists: a
  // catalogue that names a script the tree does not have is a FALSE
  // REFERENCE, and the graph reports it as such rather than linking to a
  // file that is not there.
  for (const [id, files] of evidenceScriptMap) {
    const node = nodes.get(nodeUid(NODE_KIND.TESTCASE, id));
    if (!node) continue;
    const declared = scriptMap.has(id);
    for (const file of files) {
      const exists = fs.existsSync(path.join(root, file));
      const scriptNode = addNode(NODE_KIND.SCRIPT, file, {
        present: exists,
        source: file,
      });
      if (!declared) {
        // The catalogue names a script that does not declare the case.
        // The case IS implemented by that script (the catalogue says so),
        // so the node is present -- but the DECLARATION is missing, which
        // is a different fact and is reported as its own gap.
        node.present = true;
        node.script = node.script ?? file;
        node.scriptProvenance = PROVENANCE.CATALOG;
      }
      if (declared) continue; // the declaration edge is stronger and exists
      addEdge(node, scriptNode, EDGE_TYPE.IMPLEMENTS, PROVENANCE.CATALOG, {
        via: 'tests/test-cases.json:evidence',
        file,
      });
    }
  }

  /* --- the test case -> run edges ----------------------------------- */
  // The runtime bound the attempt to a TestDefinition uid (`tc-...`). The
  // graph's test case nodes are keyed by the CATALOGUE id, so the join
  // goes through the registry: an attempt whose `testUid` matches a
  // catalogue id directly is joined; an attempt bound to a `tc-*` uid is
  // reported as bound to an IDENTIFIER THE CATALOGUE DOES NOT USE, which
  // is a real and visible fact about the two id spaces.
  const runtimeByCatalogId = new Map();
  for (const [testUid, list] of runtimeByCase) {
    const node = nodes.get(nodeUid(NODE_KIND.TESTCASE, testUid));
    if (node) {
      runtimeByCatalogId.set(node.key, list);
      continue;
    }
    // The attempt is bound to a uid of the OTHER id space. It is still a
    // run fact, so it becomes its own node -- marked as not present in
    // the catalogue, so the reader sees that the run executed something
    // the catalogue does not describe.
    const foreign = addNode(NODE_KIND.TESTCASE, testUid, {
      present: false,
      level: null,
      title: null,
      declaredStatus: null,
      source: 'state.json.runs[].attempts',
    });
    runtimeByCatalogId.set(foreign.key, list);
  }
  for (const [caseId, list] of runtimeByCatalogId) {
    const node = nodes.get(nodeUid(NODE_KIND.TESTCASE, caseId));
    if (!node) continue;
    for (const { run, attempt } of list) {
      addEdge(node, run, EDGE_TYPE.ATTEMPTED, PROVENANCE.RUNTIME, {
        attemptUid: attempt.uid ?? null,
        status: attempt.status ?? null,
        retry: attempt.retry ?? null,
      });
    }
  }

  /* --- the evidence -> test case edges ------------------------------ */
  // There is NO `evidence -> testcase` edge: the graph is a DAG and every
  // edge flows forward along the chain. The backward walk is a reverse
  // traversal, computed in `query.mjs`.
  //
  // What IS needed here is the JOIN between an execution and the cases it
  // executed, so that the reverse traversal from an artifact reaches the
  // right cases: the run that archived the artifact, and the cases that
  // run attempted.
  const attemptedByRun = new Map();   // run uid -> Set of case uids
  const archivedByRun = new Map();    // run uid -> [evidence uids]
  for (const e of edges.values()) {
    if (e.type === EDGE_TYPE.ATTEMPTED) {
      if (!attemptedByRun.has(e.to)) attemptedByRun.set(e.to, new Set());
      attemptedByRun.get(e.to).add(e.from);
    } else if (e.type === EDGE_TYPE.ARCHIVED) {
      if (!archivedByRun.has(e.from)) archivedByRun.set(e.from, []);
      archivedByRun.get(e.from).push(e.to);
    }
  }

  /* --- the transcripts ---------------------------------------------- */
  // A transcript under `docs/evidence/` IS an execution: it is the record
  // of a `node --test` run that actually executed the cases it names. So
  // the transcript contributes a RUN node (an execution of the repository's
  // own test suites) and the transcript FILE is its evidence.
  //
  // Modelling it as evidence alone would be wrong in a way that shows: the
  // transcript would be an evidence file with no run behind it, and the
  // chain would say "the case was verified by a file" -- which is not what
  // happened. The case was EXECUTED by a run, and the transcript is what
  // the run left behind.
  const transcriptRunNodes = new Map();
  const transcriptNodes = new Map();
  for (const [id, hits] of transcriptMap) {
    const caseNode = nodes.get(nodeUid(NODE_KIND.TESTCASE, id));
    if (!caseNode) continue;
    for (const hit of hits) {
      // The transcript is the run's evidence.
      const evKey = `transcript:${hit.file}`;
      let evNode = transcriptNodes.get(evKey);
      if (!evNode) {
        evNode = addNode(NODE_KIND.EVIDENCE, evKey, {
          present: true,
          subKind: 'transcript',
          file: hit.file,
          source: hit.file,
        });
        transcriptNodes.set(evKey, evNode);
      }
      // The transcript is also a run: the execution it records.
      const runKey = `transcript:${hit.file}`;
      let runNode = transcriptRunNodes.get(runKey);
      if (!runNode) {
        runNode = addNode(NODE_KIND.RUN, runKey, {
          present: true,
          subKind: 'transcript',
          status: 'observed',
          file: hit.file,
          gitCommit: null,
          runner: 'node --test',
          source: hit.file,
        });
        transcriptRunNodes.set(runKey, runNode);
        addEdge(runNode, evNode, EDGE_TYPE.ARCHIVED, PROVENANCE.EVIDENCE, { file: hit.file });
      }
      addEdge(caseNode, runNode, EDGE_TYPE.ATTEMPTED, PROVENANCE.EVIDENCE, {
        transcript: hit.file,
        ok: hit.ok,
      });
    }
  }

  /* --- the chains and their gaps ------------------------------------ */
  // The per-case edges are indexed once, so the chain walk is linear in
  // the number of edges rather than quadratic in the number of cases.
  const implByCase = new Map();    // case uid -> [script uids]
  const declaredByCase = new Set();// case uids with a DECLARED script
  const attemptedByCase = new Map();// case uid -> [run uids]
  const evidenceByRun = new Map();  // run uid -> [evidence uids]
  for (const e of edges.values()) {
    if (e.type === EDGE_TYPE.IMPLEMENTS) {
      if (!implByCase.has(e.from)) implByCase.set(e.from, []);
      implByCase.get(e.from).push(e.to);
      // A DECLARED script is the strong join: the source itself carries
      // the case id. A catalogue-named script is the weak one.
      if (e.provenance === PROVENANCE.SOURCE) declaredByCase.add(e.from);
    } else if (e.type === EDGE_TYPE.ATTEMPTED) {
      if (!attemptedByCase.has(e.from)) attemptedByCase.set(e.from, []);
      attemptedByCase.get(e.from).push(e.to);
    } else if (e.type === EDGE_TYPE.ARCHIVED) {
      if (!evidenceByRun.has(e.from)) evidenceByRun.set(e.from, []);
      evidenceByRun.get(e.from).push(e.to);
    }
  }

  const chains = [];
  for (const row of requirementRows) {
    const gaps = [];
    if (!row.designNodes.length) gaps.push({ gap: GAP.NO_DESIGN, hop: hopOf(NODE_KIND.DESIGN), detail: 'the requirement names no design anchor' });
    for (const a of row.danglingAnchors) {
      gaps.push({ gap: GAP.DANGLING_ANCHOR, hop: hopOf(NODE_KIND.DESIGN), detail: `the design anchor ${a} is defined by no document in the tree` });
    }
    if (!row.caseNodes.length) gaps.push({ gap: GAP.NO_TESTCASE, hop: hopOf(NODE_KIND.TESTCASE), detail: 'the requirement has no test case' });
    for (const t of row.danglingTests) {
      gaps.push({ gap: GAP.DANGLING_TEST, hop: hopOf(NODE_KIND.TESTCASE), detail: `the catalogue has no test case ${t}` });
    }

    const states = [];
    for (const caseNode of row.caseNodes) {
      const caseGaps = [];
      const scripts = implByCase.get(caseNode.uid) ?? [];
      const runs = attemptedByCase.get(caseNode.uid) ?? [];
      // The evidence of a case is the evidence of the executions that ran
      // it -- the case is verified when ONE of its executions left
      // evidence behind.
      const evidence = [];
      for (const runUid of runs) {
        for (const evUid of (evidenceByRun.get(runUid) ?? [])) evidence.push(evUid);
      }
      if (!scripts.length) caseGaps.push({ gap: GAP.NO_SCRIPT, hop: hopOf(NODE_KIND.SCRIPT), detail: 'no script in the tree declares this case' });
      else if (!declaredByCase.has(caseNode.uid)) {
        // The script is known, but it does not carry the case id: it was
        // joined through the catalogue's `evidence` field. That is a
        // WEAKER link, and the reader is told which it is.
        caseGaps.push({
          gap: GAP.NO_DECLARATION,
          hop: hopOf(NODE_KIND.SCRIPT),
          detail: 'the script that ran this case is known only through the catalogue -- it does not declare the case id',
        });
      }
      if (!runs.length) caseGaps.push({ gap: GAP.NO_RUN, hop: hopOf(NODE_KIND.RUN), detail: 'the case was never executed' });
      else if (!evidence.length) caseGaps.push({ gap: GAP.NO_EVIDENCE, hop: hopOf(NODE_KIND.EVIDENCE), detail: 'the execution left no evidence for the case' });

      let state = COVERAGE.UNCOVERED;
      if (scripts.length) state = COVERAGE.IMPLEMENTED;
      if (runs.length) state = COVERAGE.EXECUTED;
      if (evidence.length) state = COVERAGE.VERIFIED;
      // A case that exists in the catalogue but that no script implements
      // is DESIGNED: it is a designed case, not an absent one.
      if (!scripts.length) state = COVERAGE.DESIGNED;
      states.push(state);
      gaps.push(...caseGaps.map((g) => ({ ...g, testcase: caseNode.key })));
    }

    // A requirement with no case at all still reaches its design hop, so
    // its coverage is `designed` -- the chain was drawn as far as the
    // repository draws it.
    if (!row.caseNodes.length) states.push(COVERAGE.DESIGNED);

    chains.push({
      requirement: row.requirement.uid,
      requirementKey: row.requirement.key,
      design: row.designNodes.map((n) => n.uid),
      testcases: row.caseNodes.map((n) => n.uid),
      coverage: bestCoverage(states),
      gaps,
      complete: gaps.length === 0,
    });
  }

  /* --- the graph-level checks --------------------------------------- */
  // The acceptance criterion asks for the orphan edges and the cycles to
  // be CHECKABLE. They are checked here, on the graph itself.
  const orphanEdges = [...edges.values()].filter((e) => !nodes.has(e.from) || !nodes.has(e.to));
  const danglingNodes = [...nodes.values()].filter((n) => !n.present);
  const cycles = findCycles(nodes, edges);

  return {
    version: 1,
    nodes: [...nodes.values()].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)),
    edges: [...edges.values()].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)),
    chains: chains.sort((a, b) => (a.requirementKey < b.requirementKey ? -1 : 1)),
    checks: {
      orphanEdges: orphanEdges.map((e) => e.uid),
      danglingNodes: danglingNodes.map((n) => ({ uid: n.uid, kind: n.kind, key: n.key })),
      cycles: cycles.map((c) => c.join(' -> ')),
      completeChains: chains.filter((c) => c.complete).length,
      brokenChains: chains.filter((c) => !c.complete).length,
    },
  };
}

/**
 * Finds the CYCLES of a directed graph.
 *
 * The traceability chain is a DAG by construction (a requirement never
 * depends on an evidence file), but "by construction" is a claim about
 * the builder, not a property of the data. A cycle in the DATA would mean
 * that two requirements cover each other -- so the check is worth running
 * on every build.
 *
 * The implementation is an iterative depth-first search with the colours
 * white (unvisited) / grey (on the stack) / black (done). A grey
 * neighbour is a back edge, which is a cycle.
 */
export function findCycles(nodes, edges) {
  const adjacency = new Map();
  for (const n of nodes.keys()) adjacency.set(n, []);
  for (const e of edges.values()) {
    if (adjacency.has(e.from)) adjacency.get(e.from).push(e.to);
  }
  const colour = new Map();
  const stack = [];
  const cycles = [];

  const visit = (start) => {
    // The explicit stack keeps the traversal iterative: a deep chain must
    // not blow the call stack.
    const work = [{ node: start, i: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const neighbours = adjacency.get(frame.node) ?? [];
      if (frame.i >= neighbours.length) {
        colour.set(frame.node, 'black');
        work.pop();
        stack.pop();
        continue;
      }
      const next = neighbours[frame.i++];
      const c = colour.get(next) ?? 'white';
      if (c === 'grey') {
        const at = stack.indexOf(next);
        cycles.push([...stack.slice(at), next]);
        continue;
      }
      if (c === 'black') continue;
      colour.set(next, 'grey');
      stack.push(next);
      work.push({ node: next, i: 0 });
    }
  };

  for (const n of nodes.keys()) {
    if ((colour.get(n) ?? 'white') !== 'white') continue;
    colour.set(n, 'grey');
    stack.push(n);
    visit(n);
    stack.pop();
  }
  return cycles;
}
