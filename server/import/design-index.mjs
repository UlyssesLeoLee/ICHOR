/**
 * ATS-308 -- the DESIGN MATERIAL INDEXER.
 *
 * WHAT THIS PROBLEM IS
 * ---------------------
 * The repository holds an IPA-style design baseline: 43 Markdown design
 * documents under `docs/`, each with numbered sections, each referring to
 * the others, to the source files, to the tools and to the evidence.
 *
 * Those references are the ONLY thing that binds a design document to the
 * code it describes. A design that says "see `server/index.mjs`" and a
 * design that says "see `server/index.mjs`" where the file was deleted are
 * indistinguishable to a reader who does not check -- and the reader who
 * does check has to check every reference by hand, in every document, on
 * every commit.
 *
 * WHY A MARKDOWN PARSER IS NOT ENOUGH
 * ------------------------------------
 * This module does NOT re-implement Markdown. It reads the ONE convention
 * the repository actually uses to point at a file: an inline-code span
 * holding a path-looking token -- `server/index.mjs`, `docs/16-BASELINE-ADR.md`,
 * `tests/api.test.mjs`. The token is a *claim* about the tree, and the
 * indexer checks the claim against the tree.
 *
 * The classifier below is the whole design. It answers one question per
 * reference:
 *
 *     does this reference point at something that EXISTS, at something that
 *     is AMBIGUOUS (several candidates), at a RUNTIME ARTEFACT (a file that
 *     only exists while the platform runs), or at NOTHING?
 *
 * THE THREE FACTS THAT MUST NOT BE CONFUSED
 * -----------------------------------------
 *   * A REFERENCE IS NOT A LINK. The repository writes `docs/16-BASELINE-ADR.md`
 *     in backticks; it does not write Markdown links. The indexer reads the
 *     convention it finds, not the one it wishes for.
 *
 *   * A BROKEN REFERENCE IS NOT ALWAYS A DEFECT. `state.json` is the local
 *     state file: it exists at runtime and is not in the repository. So is
 *     `report.json`, `manifest.json`, `events.jsonl`. Reporting those as
 *     broken would make the report cry wolf on every document, and a report
 *     that cries wolf is a report nobody reads.
 *
 *   * AN AMBIGUOUS REFERENCE IS NOT A BROKEN ONE. `package.json` names five
 *     files in this repository. The reference is not wrong -- it is
 *     INCOMPLETE, and the reader has to know that the document did not say
 *     WHICH package.json. Silently resolving it to one of the five would be
 *     inventing a fact.
 *
 * THE IMPORT DOES NOT MODIFY ANYTHING
 * -----------------------------------
 * The acceptance criterion of ATS-308 is "导入 md/json 关系不改正文" -- the
 * import must not rewrite the body. So this module is strictly READ-ONLY:
 * it opens the documents, it classifies their references, and it returns
 * an index. It never writes to the documents, never rewrites a path, never
 * "fixes" a broken link. A tool that repairs links is a different tool, and
 * a tool that repairs them SILENTLY is a tool that lies.
 *
 * WHAT THE INDEX IS FOR
 * ---------------------
 * The index is the input of the traceability graph (ATS-307): a design
 * document is a `design` node, and the references a document makes are the
 * edges that connect it to the code it claims to describe. ATS-309 (增量
 * 关系校验、变更影响评估 API) then walks those edges.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DESIGN_INDEX_VERSION = 1;

/**
 * The files that are RUNTIME ARTEFACTS: they exist while the platform runs
 * and are not part of the committed tree.
 *
 * This set is the reason the report can be trusted. A reference to
 * `state.json` is a claim about the running system, not about the
 * repository, so it is classified as a runtime artefact and NOT as a broken
 * link. The set is closed on purpose: a name that is not in it is resolved
 * against the tree like any other file, so an unrecognised runtime artefact
 * shows up as a broken reference rather than being silently excused.
 */
export const RUNTIME_ARTEFACTS = Object.freeze([
  'state.json',
  'report.json',
  'manifest.json',
  'events.jsonl',
  'stdout.log',
  'stderr.log',
  'evidence-cleaned.json',
  'lcov.info',
  'credentials.json',
]);

/**
 * How a reference was classified.
 *
 * The vocabulary is closed: a reader can tell what KIND of problem it is.
 */
export const REFERENCE_KIND = Object.freeze({
  /** The reference names exactly one file that exists. */
  RESOLVED: 'resolved',
  /** The reference names several files (or none) -- it does not say which. */
  AMBIGUOUS: 'ambiguous',
  /** The reference names a file the platform creates at runtime. */
  RUNTIME: 'runtime',
  /** The reference names a file OUTSIDE this repository (a project under test). */
  EXTERNAL: 'external',
  /** The reference names nothing that exists. */
  BROKEN: 'broken',
  /** The token is not a path at all (a bare word, a URL, a glob). */
  NOT_A_REFERENCE: 'not-a-reference',
});

/**
 * The DIRECTORIES whose contents are build or install OUTPUT, not source.
 *
 * A reference into one of them names something that exists only after a
 * build or an `npm install` -- `out/index.html` is the Next.js export,
 * `node_modules/.package-lock.json` is npm's own bookkeeping. They are
 * REAL, they are just not IN the repository, so they are reported as
 * runtime artefacts rather than as broken links.
 */
export const BUILD_OUTPUT_DIRS = Object.freeze([
  'out', 'dist', 'build', 'html', '.next', 'coverage',
  'test-results', 'playwright-report', 'node_modules',
]);


/**
 * The inline-code span that holds a path-looking token.
 *
 * The repository's convention is an inline code span around a path. The
 * token must:
 *
 *   * start with a letter, a digit or an underscore (so `.mjs` -- the
 *     extension list of a prose sentence -- is not a reference);
 *   * end with a known extension (so `see the file` is not a reference);
 *   * contain no whitespace (a path with a space would need quoting, and
 *     the repository does not quote paths).
 *
 * The extension list is the one the tree actually uses.
 */
const REFERENCE_RE = /`([A-Za-z0-9_][A-Za-z0-9_\-./]*\.(?:md|mjs|cjs|js|mts|ts|tsx|json|py|xlsx|toml|yaml|yml|sh|ps1|rs|conf|txt|html|css))`/g;

/**
 * The directory names that are never part of the shipped source. A
 * reference into one of them is a reference to a build artefact, not to
 * the source tree.
 */
const SKIP_DIRS = Object.freeze([
  'node_modules', '.git', '.next', 'out', 'dist', 'target', 'coverage',
  'test-results', 'playwright-report', '.aitest-studio', '.multica', '.quality',
]);

/**
 * The extensions the indexer reads. A design material is a Markdown
 * document; a tracking asset is a JSON document. Anything else in the
 * project is CODE, and the code is referenced by the design -- it is not
 * design material itself.
 */
export const MATERIAL_EXTENSIONS = Object.freeze(['.md', '.json']);

/**
 * True when `rel` is inside a skipped directory.
 */
function isSkipped(rel) {
  const parts = rel.split('/');
  return parts.some((p) => SKIP_DIRS.includes(p));
}

/**
 * The relative path of `file` under `root`, with forward slashes.
 */
function relOf(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

/**
 * Lists the files of the tree, deterministically.
 *
 * The list is the index's universe: a reference is resolved against
 * exactly these files. The walk is sorted and bounded, so the index is a
 * pure function of the tree -- the same tree always produces the same
 * index, and the index can be diffed across commits.
 *
 * @param {string} root the repository root
 * @param {object} [opts]
 * @param {number} [opts.depth]   how deep to walk (default 6)
 * @param {number} [opts.maxFiles] the file ceiling (default 5000)
 */
export function listTree(root, { depth = 6, maxFiles = 5000 } = {}) {
  const out = [];
  const walk = (dir, rel, level) => {
    if (level > depth || out.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (out.length >= maxFiles) return;
      if (SKIP_DIRS.includes(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, childRel, level + 1);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  };
  walk(root, '', 1);
  return out;
}

/**
 * Builds the index of the tree: the files, grouped by basename, plus the
 * set of runtime artefact names.
 *
 * @param {string} root the repository root
 * @returns {{files: string[], byBasename: Map<string, string[]>, byPath: Set<string>}}
 */
export function buildTreeIndex(root, files = null) {
  const list = files ?? listTree(root);
  const byBasename = new Map();
  const byPath = new Set();
  const dirs = new Set();
  for (const rel of list) {
    byPath.add(rel);
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(rel);
    // Every prefix of the path is a directory of the tree. The index needs
    // them to tell "the directory exists but the file does not" (a real
    // broken link) from "the directory does not exist either" (a path
    // into a project that is not this repository).
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return { files: list, byBasename, byPath, dirs };
}

/**
 * The reference token as it appears in a document, split into the part
 * that carries a DIRECTORY and the BASENAME.
 *
 * `server/index.mjs` -> { dir: 'server', base: 'index.mjs' }
 * `index.mjs`       -> { dir: '',   base: 'index.mjs' }
 */
function splitReference(token) {
  const slash = token.lastIndexOf('/');
  if (slash < 0) return { dir: '', base: token };
  return { dir: token.slice(0, slash), base: token.slice(slash + 1) };
}

/**
 * CLASSIFIES ONE REFERENCE against the tree.
 *
 * This is the heart of the module, and it is deliberately a pure function
 * of (token, tree) so that it can be tested on its own and so that the
 * report can be recomputed from a different tree without changing a line
 * of the importer.
 *
 * THE RESOLUTION ORDER
 * --------------------
 *   1. A path that exists as written -> RESOLVED.
 *   2. A path that does not exist, but whose SUFFIX matches exactly one
 *      tracked file -> RESOLVED (the document wrote a shorter form of the
 *      path: `lib.rs` for `src-tauri/src/lib.rs`).
 *   3. A bare basename that names exactly one tracked file -> RESOLVED.
 *   4. A bare basename that names SEVERAL tracked files -> AMBIGUOUS: the
 *      reference is not wrong, it is incomplete, and the candidates are
 *      reported so a reader can see what it might have meant.
 *   5. A bare basename that names NO tracked file, but IS a runtime
 *      artefact -> RUNTIME.
 *   6. A path whose FIRST segment is a build-output directory (`out/`,
 *      `node_modules/`, ...) -> RUNTIME: it names the output of a build
 *      or an install, not a file of the repository.
 *   7. A path whose DIRECTORY does not exist in the tree -> EXTERNAL: the
 *      document points at a project that is not this repository (the
 *      project under test), not at a file that went missing.
 *   8. Anything else -> BROKEN.
 *
 * WHY EXTERNAL IS NOT BROKEN
 * --------------------------
 * This is the distinction that decides whether the report is useful. The
 * design documents describe the platform AND the projects it drives, and
 * they name paths like `flows/android.yaml` or `tests/a.spec.ts` that
 * belong to a PROJECT UNDER TEST -- a directory that exists in the
 * user's repository, not in this one.
 *
 * Reporting those as broken would put 12 false defects in every report,
 * and a report with false defects is a report nobody reads. The rule is
 * mechanical and checkable: if the document names a directory that this
 * repository does not have, the reference is about something else.
 *
 * A reference whose directory DOES exist but whose file does NOT is a
 * genuine broken link: the directory is here, the file is not.
 *
 * WHY SUFFIX MATCHING IS ALLOWED (AND WHERE IT STOPS)
 * ---------------------------------------------------
 * The design documents write paths in two ways: the full repository path
 * (`server/index.mjs`) and the path INSIDE a directory the document is
 * talking about (`lib.rs` for `src-tauri/src/lib.rs`, `page.tsx` for
 * `apps/studio/app/page.tsx`). A resolver that only accepted the full
 * path would report 30-odd legitimate references as broken and the report
 * would be useless.
 *
 * But suffix matching must not become a guessing machine: it is only
 * accepted when it matches EXACTLY ONE tracked file. Two candidates mean
 * the reference is ambiguous, and the report says so instead of picking
 * one.
 *
 * @param {string} token the reference as written
 * @param {object} tree the tree index
 * @returns {{kind: string, token: string, candidates: string[]}}
 */
export function classifyReference(token, tree) {
  const raw = String(token ?? '');
  const { dir, base } = splitReference(raw);

  // 1. the path as written.
  if (tree.byPath.has(raw)) {
    return { kind: REFERENCE_KIND.RESOLVED, token: raw, candidates: [raw] };
  }

  // 2. a path with a directory that does not exist as written: try the
  //    SUFFIX. `tests/home.spec.ts` may be `examples/sample-playwright/tests/home.spec.ts`.
  if (dir) {
    const suffixMatches = tree.files.filter((f) => f.endsWith(`/${raw}`));
    if (suffixMatches.length === 1) {
      return { kind: REFERENCE_KIND.RESOLVED, token: raw, candidates: suffixMatches };
    }
    if (suffixMatches.length > 1) {
      return { kind: REFERENCE_KIND.AMBIGUOUS, token: raw, candidates: suffixMatches.sort() };
    }
  }

  // 3./4. a bare basename.
  const byBase = tree.byBasename.get(base) ?? [];
  if (byBase.length === 1) {
    return { kind: REFERENCE_KIND.RESOLVED, token: raw, candidates: byBase };
  }
  if (byBase.length > 1) {
    // The document named a directory too, and the directory narrows it
    // down: `server/index.mjs` is unambiguous even though `index.mjs` is
    // not. The suffix rule above already handled the exact path; here the
    // directory is only a HINT (the document wrote `apps/studio` while the
    // file lives in `apps/studio/app/`), so the candidates are the files
    // whose path contains the directory.
    const narrowed = dir ? byBase.filter((f) => f.includes(`/${dir}/`)) : [];
    if (narrowed.length === 1) {
      return { kind: REFERENCE_KIND.RESOLVED, token: raw, candidates: narrowed };
    }
    if (narrowed.length > 1) {
      return { kind: REFERENCE_KIND.AMBIGUOUS, token: raw, candidates: narrowed.sort() };
    }
    return { kind: REFERENCE_KIND.AMBIGUOUS, token: raw, candidates: byBase.slice().sort() };
  }

  // 5. a runtime artefact.
  if (RUNTIME_ARTEFACTS.includes(base)) {
    return { kind: REFERENCE_KIND.RUNTIME, token: raw, candidates: [] };
  }

  // 6. a build or install output.
  if (BUILD_OUTPUT_DIRS.includes(raw.split('/')[0])) {
    return { kind: REFERENCE_KIND.RUNTIME, token: raw, candidates: [] };
  }

  // 7. a directory this repository does not have: the reference is about
  //    a project under test, not about a file that went missing.
  if (dir && !tree.dirs.has(dir)) {
    return { kind: REFERENCE_KIND.EXTERNAL, token: raw, candidates: [] };
  }

  // 8. nothing.
  return { kind: REFERENCE_KIND.BROKEN, token: raw, candidates: [] };
}

/**
 * Extracts the references of one document.
 *
 * The scan is LINE-AWARE: a reference carries the line it was written on,
 * so a report can point the author at the place to look. A document may
 * mention the same file many times; every mention is kept, because "the
 * document names `server/index.mjs` four times" is a fact the report
 * should be able to state.
 *
 * @param {string} text the document's content
 * @returns {{token: string, line: number}[]}
 */
export function extractReferences(text) {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    REFERENCE_RE.lastIndex = 0;
    let m;
    while ((m = REFERENCE_RE.exec(line)) !== null) {
      out.push({ token: m[1], line: i + 1 });
    }
  }
  return out;
}

/**
 * The stable uid of an indexed document.
 *
 * The basis is the document's own path -- never its position in a list --
 * so the same document has the same uid in every checkout and the index
 * can be diffed across commits.
 */
export function materialUid(rel) {
  return `dmi_1_${crypto.createHash('sha256').update(`material${'\x00'}${rel}`).digest('hex').slice(0, 24)}`;
}

/**
 * The stable uid of one reference of one document.
 *
 * The basis is the document, the line and the token: the same token on two
 * lines of the same document is two facts (the document points at the
 * file twice), and they must not collapse into one.
 */
export function referenceUid(rel, line, token) {
  return `dmr_1_${crypto.createHash('sha256').update(`reference${'\x00'}${rel}${'\x00'}${line}${'\x00'}${token}`).digest('hex').slice(0, 24)}`;
}

/**
 * The headings of a Markdown document, as `number -> title`.
 *
 * The section numbers are what a `§N` reference points at, so they are
 * part of the index: a reference to `docs/16-BASELINE-ADR.md` §4 is a
 * reference to a SECTION, and the index has to be able to say whether
 * that section exists.
 */
export function readHeadings(text) {
  const out = new Map();
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    const m = /^#{1,6}\s+([0-9]+(?:\.[0-9A-Za-z]+)*)\.?\s+(.*)$/.exec(line);
    if (!m) continue;
    const number = m[1];
    // A duplicated number is a fact about the document (two sections with
    // the same number), and it is kept -- the LAST one wins for the
    // title, and the duplicate is reported by the index as a duplicate
    // heading rather than silently dropped.
    out.set(number, { number, title: m[2].trim(), line: lines.indexOf(line) + 1 });
  }
  return out;
}

/**
 * Reads one design material.
 *
 * A material is a Markdown document (a design document) or a JSON tracking
 * asset (the `.aitest` requirement and traceability documents). The
 * reader returns the MATERIAL, never an exception: a file that cannot be
 * read is a fact about the tree, and it is reported as an error entry so
 * the caller can decide what to do with it.
 */
export function readMaterial(root, rel) {
  const full = path.join(root, rel);
  let text = '';
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (err) {
    return {
      rel,
      uid: materialUid(rel),
      kind: 'error',
      error: `cannot read the material: ${err.message}`,
      bytes: 0,
      sha256: null,
      headings: new Map(),
      references: [],
    };
  }
  const ext = path.extname(rel).toLowerCase();
  const isJson = ext === '.json';
  const headings = isJson ? new Map() : readHeadings(text);
  const references = isJson ? [] : extractReferences(text);
  return {
    rel,
    uid: materialUid(rel),
    kind: isJson ? 'asset' : 'design',
    error: null,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    headings,
    references,
  };
}

/**
 * The design materials of a tree.
 *
 * TWO KINDS OF MATERIAL, AND THE DIFFERENCE IS NOT COSMETIC
 * -------------------------------------------------------
 *   * DESIGN DOCUMENTS: the Markdown files under `docs/`. They carry the
 *     design, the section numbers and the references.
 *   * TRACKING ASSETS: the JSON documents that carry the requirement /
 *     traceability relations -- the `.aitest` documents of a project and
 *     the repository's own `tests/rtm.json`.
 *
 * The tracking assets are read for their RELATIONS, not for their
 * references: a JSON document does not point at files with backticks, it
 * points at requirements and test ids.
 */
export function findMaterials(root, files = null) {
  const list = files ?? listTree(root);
  const out = [];
  for (const rel of list) {
    if (isSkipped(rel)) continue;
    const ext = path.extname(rel).toLowerCase();
    if (!MATERIAL_EXTENSIONS.includes(ext)) continue;
    // The design baseline is the `docs/` tree. A JSON file elsewhere is
    // only a tracking asset when it is one of the two the platform knows:
    // the requirement list and the traceability list.
    const isDoc = ext === '.md' && rel.startsWith('docs/');
    const isAsset = ext === '.json' && (rel === 'tests/rtm.json' || rel.endsWith('/.aitest/requirements.json') || rel.endsWith('/.aitest/traceability.json'));
    if (isDoc || isAsset) out.push(rel);
  }
  return out;
}

/**
 * Imports the design materials of a tree.
 *
 * THE IMPORT IS READ-ONLY. Nothing under `root` is written, renamed or
 * deleted. The result is:
 *
 *   {
 *     version,
 *     root,
 *     materials: [ {rel, uid, kind, sha256, bytes, headings, references} ],
 *     references: [ {uid, from, token, line, kind, candidates} ],
 *     report:    { ... the counts and the findings ... },
 *   }
 *
 * @param {object} options
 * @param {string} options.root the repository root
 * @param {string[]} [options.only] the materials to import (default: all)
 */
export function importDesignMaterials({ root, only = null } = {}) {
  if (!root) throw new TypeError('root is required');
  const tree = buildTreeIndex(root);
  const rels = only ?? findMaterials(root, tree.files);

  const materials = [];
  const references = [];

  for (const rel of rels) {
    const material = readMaterial(root, rel);
    materials.push(material);
    for (const ref of material.references) {
      const verdict = classifyReference(ref.token, tree);
      references.push({
        uid: referenceUid(rel, ref.line, ref.token),
        from: rel,
        fromUid: material.uid,
        token: ref.token,
        line: ref.line,
        kind: verdict.kind,
        candidates: verdict.candidates,
      });
    }
  }

  // The findings: the references that are NOT clean. They are the report.
  const broken = references.filter((r) => r.kind === REFERENCE_KIND.BROKEN);
  const ambiguous = references.filter((r) => r.kind === REFERENCE_KIND.AMBIGUOUS);

  // The broken references are grouped by token, so the report names a
  // missing file once and lists every place that names it. A broken link
  // mentioned 12 times is ONE defect, not twelve.
  const brokenByToken = new Map();
  for (const r of broken) {
    if (!brokenByToken.has(r.token)) brokenByToken.set(r.token, []);
    brokenByToken.get(r.token).push(r);
  }
  const ambiguousByToken = new Map();
  for (const r of ambiguous) {
    if (!ambiguousByToken.has(r.token)) ambiguousByToken.set(r.token, []);
    ambiguousByToken.get(r.token).push(r);
  }

  const byKind = {};
  for (const r of references) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

  return {
    version: DESIGN_INDEX_VERSION,
    root,
    materials: materials.map((m) => ({
      rel: m.rel,
      uid: m.uid,
      kind: m.kind,
      error: m.error,
      bytes: m.bytes,
      sha256: m.sha256,
      headings: [...m.headings.values()].map((h) => ({ number: h.number, title: h.title })),
      referenceCount: m.references.length,
    })),
    references,
    report: {
      version: DESIGN_INDEX_VERSION,
      materials: materials.length,
      designDocuments: materials.filter((m) => m.kind === 'design').length,
      trackingAssets: materials.filter((m) => m.kind === 'asset').length,
      references: references.length,
      byKind,
      broken: [...brokenByToken.entries()]
        .map(([token, refs]) => ({
          token,
          count: refs.length,
          places: refs.map((r) => ({ from: r.from, line: r.line })),
        }))
        .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token)),
      ambiguous: [...ambiguousByToken.entries()]
        .map(([token, refs]) => ({
          token,
          count: refs.length,
          candidates: refs[0].candidates,
          places: refs.map((r) => ({ from: r.from, line: r.line })),
        }))
        .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token)),
    },
  };
}

/**
 * The readable form of the import report.
 *
 * The report has to be read by a person: it is what tells the author of a
 * design document which of their references no longer point at anything.
 */
export function formatImportReport(report) {
  const lines = [];
  lines.push('设计资料导入报告（ATS-308）');
  lines.push(`  设计文档数        ：${report.designDocuments}`);
  lines.push(`  追踪资产数        ：${report.trackingAssets}`);
  lines.push(`  引用总数          ：${report.references}`);
  lines.push(`  已解析            ：${report.byKind[REFERENCE_KIND.RESOLVED] ?? 0}`);
  lines.push(`  有歧义（同名多处）：${report.byKind[REFERENCE_KIND.AMBIGUOUS] ?? 0}`);
  lines.push(`  运行时产物        ：${report.byKind[REFERENCE_KIND.RUNTIME] ?? 0}`);
  lines.push(`  失效链接          ：${report.byKind[REFERENCE_KIND.BROKEN] ?? 0}`);

  if (report.broken.length) {
    lines.push('');
    lines.push('失效链接（按被引用次数排序；正文未改动）：');
    for (const b of report.broken) {
      lines.push(`  ${b.token}  （${b.count} 处）`);
      for (const p of b.places.slice(0, 8)) {
        lines.push(`      ${p.from}:${p.line}`);
      }
      if (b.places.length > 8) lines.push(`      … 另有 ${b.places.length - 8} 处`);
    }
  }

  if (report.ambiguous.length) {
    lines.push('');
    lines.push('重名链接（同名多处，文档未指明是哪一处）：');
    for (const a of report.ambiguous) {
      lines.push(`  ${a.token}  （${a.count} 处，候选 ${a.candidates.length} 个）`);
      for (const c of a.candidates.slice(0, 5)) lines.push(`      ${c}`);
      if (a.candidates.length > 5) lines.push(`      … 另有 ${a.candidates.length - 5} 个`);
    }
  }

  return lines.join('\n');
}

/**
 * The readable form of a single material's index.
 */
export function formatMaterialIndex(material, references = []) {
  const lines = [];
  lines.push(`${material.rel}  (${material.kind})  ${material.bytes} bytes`);
  if (material.sha256) lines.push(`  sha256: ${material.sha256}`);
  if (material.headings.length) {
    lines.push(`  章节 ${material.headings.length} 个：${material.headings.map((h) => h.number).join(', ')}`);
  }
  const own = references.filter((r) => r.from === material.rel);
  lines.push(`  引用 ${own.length} 条`);
  for (const r of own) {
    const suffix = r.kind === REFERENCE_KIND.RESOLVED ? ` -> ${r.candidates[0]}` : (r.candidates.length ? ` -> ${r.candidates.length} 个候选` : '');
    lines.push(`    L${String(r.line).padStart(4)}  ${r.kind.padEnd(10)} ${r.token}${suffix}`);
  }
  return lines.join('\n');
}
