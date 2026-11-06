/**
 * ATS-602: the mobile Flow IMPORT -- the file level entry point.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The two halves of the import:
 *
 *   * `mobile-flow.mjs` reads a Flow into its semantic document;
 *   * `mobile-import.mjs` maps that document onto the unified case model
 *     and produces the import report.
 *
 * This module is the seam between them: it takes a FILE, decides which
 * syntax to read it as, reads it, maps it, and returns the result in the
 * shape the discovery layer consumes.
 *
 * WHY THE FILE IS READ BY THE CALLER
 * ----------------------------------
 * The reader does not touch the filesystem. A Flow file is UNTRUSTED
 * INPUT -- it comes from the user's repository, and the platform's trust
 * model (ATS-202, ATS-113) is explicit about what may be read from a
 * project and what may be EXECUTED from one. Reading a file is a
 * filesystem operation the caller decides on; the parser only turns text
 * into a document. That keeps the trust decision in one place: the
 * caller, which already has one.
 *
 * THE PATH RULE
 * -------------
 * The path of a Flow file is RELATIVE to the project root, and it is
 * checked: a Flow outside the project is refused rather than read. A Flow
 * is a test definition, and a test definition that lives outside the
 * project would produce cases whose `file` is not a project file -- which
 * breaks every lookup by file that the platform does.
 */
import fs from 'node:fs';
import path from 'node:path';

import { detectSyntax, parseFlow, FLOW_SYNTAX } from './mobile-flow.mjs';
import { buildImportReport, formatImportReport, importFlow } from './mobile-import.mjs';

/**
 * The directories a Flow file may live in.
 *
 * A Flow is a TEST DEFINITION, so it lives with the tests. The rule is
 * about where the platform LOOKS for Flows, not about where a user may
 * put one: a Flow outside these directories is not discovered, and a user
 * who wants one found can move it or add its directory.
 */
export const FLOW_DIRECTORIES = Object.freeze(['flows', 'mobile', 'tests/flows', 'tests/mobile']);

/**
 * The extensions a Flow file may have.
 */
const FLOW_EXTENSIONS = Object.freeze(['.yaml', '.yml', '.flow']);

/**
 * The errors the import reports.
 *
 * A closed vocabulary, so a caller can tell what KIND of problem it is:
 * the file is not a Flow, it is outside the project, it cannot be read, or
 * it cannot be parsed.
 */
export const IMPORT_ERROR = Object.freeze({
  NOT_A_FLOW: 'not-a-flow-file',
  OUTSIDE_PROJECT: 'flow-outside-project',
  UNREADABLE: 'flow-unreadable',
  UNPARSED: 'flow-unparsed',
});

/**
 * True when the path is a Flow file, by its extension.
 *
 * The extension decides it, because the extension is what says which
 * syntax the file is written in. A file that is not a Flow is not read at
 * all -- the discovery does not parse every YAML file in a repository.
 */
export function isFlowFile(relativePath) {
  const ext = path.extname(String(relativePath ?? '')).toLowerCase();
  return FLOW_EXTENSIONS.includes(ext);
}

/**
 * The Flow files of a project.
 *
 * The Flow files are looked for in the CONVENTIONAL DIRECTORIES, not
 * anywhere in the repository: a repository may hold hundreds of YAML
 * files (CI configs, k8s manifests) and none of them is a Flow. The
 * directories are the platform's own convention, and they are part of the
 * contract the ATS-605 capability matrix documents.
 *
 * The list is bounded and the walk is shallow, the same way the test walk
 * of `server/core.mjs` is: a repository may be large, and the discovery
 * must not become unbounded.
 *
 * @param {string} root  the project root
 * @param {object} [opts]
 * @param {number} [opts.depth]     how deep to walk (default 4)
 * @param {number} [opts.maxFiles]  the file ceiling (default 500)
 */
export function findFlowFiles(root, { depth = 4, maxFiles = 500 } = {}) {
  const out = [];
  const walk = (dir, rel, level) => {
    if (level > depth || out.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(entry.name, childRel, level + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isFlowFile(entry.name)) out.push(childRel);
    }
  };
  // The conventional directories only. A Flow outside them is not
  // DISCOVERED -- it is not that such a file may not exist, it is that the
  // platform does not go looking for it.
  for (const dir of FLOW_DIRECTORIES) {
    if (out.length >= maxFiles) break;
    walk(dir, dir, 1);
  }
  return out.sort();
}

/**
 * Imports one Flow file.
 *
 * @param {string} root   the project root
 * @param {string} relative  the project-relative path of the Flow
 * @param {object} [opts]
 * @param {string} [opts.syntax]       the syntax to read it as
 * @param {string} [opts.projectUid]   the project the file belongs to
 * @param {object} [opts.registry]     the UID registry of the project
 *
 * Returns the import result:
 *   {
 *     ok: boolean,
 *     file, syntax, appId,
 *     cases: [ ... ],
 *     unsupported: [ ... ],
 *     errors: [ ... ],
 *     report: { ... },          -- the machine readable report
 *     reportText: string        -- the readable report
 *   }
 *
 * A file that cannot be read produces `ok: false` and an error in
 * `errors` -- never an exception the caller has to catch, and never a
 * silent empty result.
 */
export function importFlowFile(root, relative, { syntax = null, projectUid = null, registry = null } = {}) {
  const file = String(relative ?? '');
  const errors = [];

  if (!isFlowFile(file)) {
    errors.push({ line: 0, message: `${file} is not a Flow file`, code: IMPORT_ERROR.NOT_A_FLOW });
    return emptyResult(file, errors);
  }

  // The path rule: a Flow outside the project is refused.
  const absolute = path.resolve(root, file);
  const projectRoot = path.resolve(root);
  if (!isInside(projectRoot, absolute)) {
    errors.push({ line: 0, message: `${file} is outside the project`, code: IMPORT_ERROR.OUTSIDE_PROJECT });
    return emptyResult(file, errors);
  }

  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (err) {
    errors.push({ line: 0, message: `${file} cannot be read: ${err.message}`, code: IMPORT_ERROR.UNREADABLE });
    return emptyResult(file, errors);
  }

  const chosen = syntax ?? detectSyntax(file);
  if (!chosen) {
    errors.push({ line: 0, message: `${file} has no Flow syntax`, code: IMPORT_ERROR.NOT_A_FLOW });
    return emptyResult(file, errors);
  }

  const flow = parseFlow(text, { syntax: chosen });
  const imported = importFlow(flow, { file, projectUid, registry });
  const report = buildImportReport(imported);

  return {
    ok: imported.errors.length === 0 && imported.cases.length > 0,
    file,
    syntax: imported.syntax,
    appId: imported.appId,
    cases: imported.cases,
    unsupported: imported.unsupported,
    errors: imported.errors,
    report,
    reportText: formatImportReport(report),
  };
}

/**
 * Imports every Flow file of a project.
 *
 * The result carries the cases of all the files together and the reports
 * of all the files, so that the caller can answer "what does this project
 * contain" in one call.
 */
export function importProjectFlows(root, { projectUid = null, registry = null, syntax = null } = {}) {
  const files = findFlowFiles(root);
  const results = [];
  for (const file of files) {
    results.push(importFlowFile(root, file, { syntax, projectUid, registry }));
  }
  const cases = results.flatMap((r) => r.cases);
  const unsupported = results.flatMap((r) => r.unsupported);
  const errors = results.flatMap((r) => r.errors);
  return { files, cases, unsupported, errors, results };
}

/**
 * The empty result of a failed import.
 */
function emptyResult(file, errors) {
  const report = buildImportReport({
    file,
    syntax: null,
    appId: null,
    cases: [],
    unsupported: [],
    errors,
  });
  return {
    ok: false,
    file,
    syntax: null,
    appId: null,
    cases: [],
    unsupported: [],
    errors,
    report,
    reportText: formatImportReport(report),
  };
}

/**
 * True when `child` is inside `parent`.
 *
 * The same containment rule the evidence resolver uses: a path that IS the
 * root is not inside it, and a path that climbs out is not inside it.
 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export { FLOW_SYNTAX, parseFlow, detectSyntax, importFlow, buildImportReport, formatImportReport };
