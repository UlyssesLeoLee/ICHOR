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
import { scanTestCases, skipQuoted, skipTemplate, skipRegexLiteral, regexAllowedAt } from '../uid.mjs';

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
 * A lexical reading: the `describe(` calls above the line that have NOT been
 * closed yet. It is a COMPARISON aid, not an identity input -- the
 * authoritative index takes the path from the CLI itself, and the identity
 * rules use it only when the title alone does not decide.
 *
 * THE BLOCK IS POPPED WHEN IT CLOSES
 * ----------------------------------
 * The first version of this reader only ever PUSHED a `describe` title, so a
 * case that sits AFTER a closed `describe` block still carried the block's
 * title. The two indexes then disagreed about a case both of them saw: the
 * static one said `group > after` and the CLI said `after`. The consistency
 * report then claimed that the CLI does not enumerate a case it does
 * enumerate -- a false alarm that hides the real differences.
 *
 * The reader therefore tracks the BRACES: a `describe` is open from its own
 * opening brace to the brace that closes it. The braces are counted with the
 * same restricted lexer the body extraction uses, so a brace inside a string,
 * a template literal, a comment or a regular expression does not count.
 *
 * THE MODIFIERS COUNT
 * --------------------
 * `test.describe.serial(`, `test.describe.skip(`, `test.describe.only(` and
 * `test.describe.fixme(` are all `describe` blocks as far as the CLI is
 * concerned -- the CLI reports the block's title as part of the case's
 * describe path. The first version only recognised a plain `describe(`, so
 * every case under a modified block was reported as "only the authoritative
 * index sees it".
 */
export function describePathAt(content, line) {
  const src = String(content ?? '');
  const limit = lineOfOffset(src, line);
  const scopes = [];
  let depth = 0;
  let pending = null;
  const n = src.length;
  let i = 0;
  while (i < n && i < limit) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = skipComment(src, i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = skipComment(src, i); continue; }
    if (c === '"' || c === "'") { i = skipString(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '/' && regexAllowedAt(src, i)) { i = skipRegexLiteral(src, i); continue; }
    if (c === '{') {
      // The block that just opened belongs to the `describe` whose title was
      // read before it -- but only when that `describe` opened this very
      // block. A `describe` body may contain other blocks (a nested
      // `describe`, an object literal, a function), and those do not close
      // the `describe`.
      if (pending && pending.depth === depth) {
        scopes.push({ title: pending.title, depth: depth + 1 });
        pending = null;
      }
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      // A `describe` scope ends when the depth drops back to the level it
      // was opened at.
      while (scopes.length && scopes[scopes.length - 1].depth > depth) scopes.pop();
      i++;
      continue;
    }
    if (IDENT_START.test(c)) {
      const start = i;
      while (i < n && IDENT_PART.test(src[i])) i++;
      const word = src.slice(start, i);
      if (word === 'describe') {
        const title = readDescribeTitle(src, i);
        if (title) {
          pending = { title: title.value, depth };
          i = title.end;
          continue;
        }
      }
      continue;
    }
    i++;
  }
  return scopes.map((s) => s.title);
}

/** True for the characters an identifier may start with. */
const IDENT_START = /[A-Za-z_$]/;
/** True for the characters an identifier may continue with. */
const IDENT_PART = /[A-Za-z0-9_$]/;

/** The offset the line (1-based) starts at. */
function lineOfOffset(src, line) {
  if (!Number.isFinite(line) || line <= 1) return 0;
  let seen = 1;
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '\n') continue;
    seen++;
    if (seen === line) return i + 1;
  }
  return src.length;
}

/** The title of the `describe` call that starts at `i`. */
function readDescribeTitle(src, i) {
  let j = i;
  while (j < src.length && /\s/.test(src[j])) j++;
  // The modifiers of a describe block: `describe.serial(`, `describe.skip(`,
  // `describe.only(`, `describe.fixme(`, `describe.parallel(`.
  while (j < src.length && src[j] === '.') {
    let k = j + 1;
    while (k < src.length && IDENT_PART.test(src[k])) k++;
    const modifier = src.slice(j + 1, k);
    if (!['serial', 'parallel', 'skip', 'only', 'fixme'].includes(modifier)) return null;
    j = k;
    while (j < src.length && /\s/.test(src[j])) j++;
  }
  if (src[j] !== '(') return null;
  j++;
  while (j < src.length && /\s/.test(src[j])) j++;
  const quote = src[j];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  const end = quote === '`' ? skipTemplate(src, j) : skipQuoted(src, j, quote);
  if (end <= j + 1) return null;
  const raw = src.slice(j + 1, end - 1);
  return { value: quote === '`' ? raw : raw.replace(/\\(.)/g, '$1'), end };
}

/** Skips a line or a block comment. */
function skipComment(src, i) {
  if (src[i + 1] === '/') {
    while (i < src.length && src[i] !== '\n') i++;
    return i;
  }
  i += 2;
  while (i < src.length) {
    if (src[i] === '*' && src[i + 1] === '/') return i + 2;
    i++;
  }
  return i;
}

/** Skips a quoted literal. */
function skipString(src, i, quote) {
  const end = skipQuoted(src, i, quote);
  if (end >= src.length || src.indexOf('\n', i) < end) return i + 1;
  return end;
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
