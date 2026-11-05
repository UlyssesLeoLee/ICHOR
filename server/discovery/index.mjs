/**
 * ATS-202: the helpers of the authoritative discovery.
 *
 * This module holds the parts that are pure: the comparison between the two
 * indexes and the lexical reading of a `describe` path. The entry point
 * itself (`discoverTests`) lives in `server/core.mjs`, which already owns the
 * static discovery -- keeping it there means there is ONE function that
 * decides which index answers, and no import cycle between the two.
 *
 * The two indexes
 * ---------------
 *
 *   * the STATIC index (`discoverStatic` in `server/core.mjs`): a heuristic
 *     that reads the source files and recognises the literal `test('...')`
 *     calls. It cannot see a dynamically generated, parameterised or
 *     helper-declared case;
 *   * the AUTHORITATIVE index (`playwright test --list`): the CLI's own
 *     enumeration of the cases it would really run.
 *
 * The acceptance criterion of the task is "与 CLI 发现结果一致" -- the index
 * agrees with the CLI. The agreement is MEASURED here, not asserted: the two
 * case lists are compared case by case and the difference is reported.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scanTestCases } from '../uid.mjs';

/** The discovery modes the response can report. */
export const DISCOVERY = Object.freeze({
  STATIC: 'static',
  AUTHORITATIVE: 'authoritative',
});

/**
 * The key of a case in the comparison: the file, the `describe` path and the
 * leaf title. Two indexes agree on a case when they agree on this key.
 */
export const caseKey = (c) => `${c.file} ${(c.describePath ?? []).join(' > ')} ${c.title}`;

/**
 * Compares the authoritative case list with the static one.
 *
 * A case that only the CLI knows is a DYNAMIC case -- the whole point of the
 * authoritative discovery. A case that only the static scanner knows is a
 * case the CLI does not enumerate: a file outside `testDir`, a file that
 * does not match `testMatch`, or a case the CLI could not load.
 *
 * The counts are reported, and the DIFFERING cases are reported with their
 * keys, so a reader can see WHICH cases differ and not only how many.
 */
export function compareDiscoveries(authoritative, staticCases) {
  const authKeys = new Map(authoritative.map((c) => [caseKey(c), c]));
  const staticKeys = new Map(staticCases.map((c) => [caseKey(c), c]));
  const onlyAuthoritative = [...authKeys.keys()].filter((k) => !staticKeys.has(k));
  const onlyStatic = [...staticKeys.keys()].filter((k) => !authKeys.has(k));
  return {
    authoritative: authoritative.length,
    static: staticCases.length,
    common: authoritative.length - onlyAuthoritative.length,
    onlyAuthoritative,
    onlyStatic,
    agrees: onlyAuthoritative.length === 0 && onlyStatic.length === 0,
  };
}

/**
 * The `describe` blocks that are open at a line of a source file.
 *
 * A lexical reading: the `describe(` calls above the line. It is a
 * COMPARISON aid, not an identity input -- the authoritative index takes the
 * path from the CLI itself, and the identity rules use it only when the
 * title alone does not decide.
 */
export function describePathAt(content, line) {
  const lines = String(content ?? '').split(/\r?\n/).slice(0, line);
  const stack = [];
  for (const raw of lines) {
    const m = raw.match(/\bdescribe\s*\(\s*(['"`])([^\n]*?)\1/);
    if (m) stack.push(m[2]);
  }
  return stack;
}

/**
 * The static case list of a project, with the `describe` path of each case.
 *
 * The path is read from the source, so it is only as good as the lexical
 * reading: a `describe` built at runtime is not seen. That is exactly why
 * the path is used for the COMPARISON and never as the sole identity input.
 */
export function staticCasesWithScope(root, files) {
  const out = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const c of scanTestCases(content)) {
      out.push({ file, title: c.title, line: c.line, describePath: describePathAt(content, c.line) });
    }
  }
  return out;
}

/**
 * The body text of the source case at a position, for the cases the static
 * scanner can see.
 *
 * The body is what tells two same-titled cases apart. A case the scanner
 * never saw (a dynamic one) has no body, and the authoritative identity
 * falls back to the `describe` path -- which is what the CLI knows and the
 * scanner does not.
 */
export function readBodies(root, files) {
  const bodies = new Map();
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const c of scanTestCases(content)) {
      bodies.set(`${file} ${c.line}`, c);
    }
  }
  return bodies;
}
