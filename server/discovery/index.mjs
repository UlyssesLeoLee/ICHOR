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
 *
 * This is the READABLE key: it is what the `onlyStatic` / `onlyAuthoritative`
 * lists show. The key the comparison actually MATCHES on is `matchKey`.
 */
export const caseKey = (c) => `${c.file} ${(c.describePath ?? []).join(' > ')} ${c.title}`;

/**
 * The key the comparison MATCHES on: the POSITION of the case.
 *
 * WHY THE POSITION AND NOT THE DESCRIBE PATH
 * ------------------------------------------
 * The `describe` path is read LEXICALLY by the static index, and a lexical
 * reader cannot know the title of a `describe` that is built at run time:
 *
 *   * `describe(suite, ...)` -- the title lives in a variable;
 *   * `describe(`area ${area}`, ...)` -- the title is a template literal;
 *   * `describe('tagged', { tag: '@smoke' }, ...)` -- the details object opens
 *     a brace BEFORE the callback's body does.
 *
 * The CLI knows the REAL title in all three cases. A key that carries the
 * describe path therefore reports a FALSE difference for a case both indexes
 * see: the static case carries the path the scanner could read (often an
 * empty one), the CLI case carries the real one. The user then gets a false
 * warning -- "1 个用例仅静态索引可见" -- about a case the CLI enumerates.
 *
 * The position is what BOTH indexes agree on: the CLI reports the line of
 * the `test(` call, and the scanner reports the line of the call too (the
 * round-1 finding CE-I moved the scanner onto the call line).
 *
 * The leaf title stays part of the key: it is the title the CLI reports, and
 * the scanner reads the literal, so the two agree on it for every case the
 * scanner can see.
 */
export const matchKey = (c) => `${c.file} ${Number.isInteger(c.line) ? `#${c.line}` : ''} ${c.title}`;

/**
 * Compares the authoritative case list with the static one.
 *
 * A case that only the CLI knows is a DYNAMIC case -- the whole point of the
 * authoritative discovery. A case that only the static scanner knows is a
 * case the CLI does not enumerate: a file outside `testDir`, a file that
 * does not match `testMatch`, or a case the CLI could not load.
 *
 * The counts are reported, and the DIFFERING cases are reported with their
 * readable keys, so a reader can see WHICH cases differ and not only how many.
 *
 * THE MATCHING KEY
 * ----------------
 * The two lists are matched on `matchKey` (the position), NOT on the
 * describe path -- see the note above `matchKey` for the reason. The
 * guarantee that follows is STRUCTURAL rather than lexical: a case the CLI
 * enumerates contributes its own key to the authoritative set, so its key is
 * IN that set, and therefore it can never land in `onlyStatic`.
 *
 * `onlyStatic` holds the cases the CLI does NOT enumerate: the TEMPLATE of a
 * dynamic case (the scanner reads `dynamic ${n}`, the CLI reports the
 * rendered `dynamic alpha`), a case in a file the CLI did not enumerate, and
 * a case whose title the scanner read differently at the same position.
 */
export function compareDiscoveries(authoritative, staticCases) {
  const authKeys = new Map(authoritative.map((c) => [matchKey(c), c]));
  const staticKeys = new Map(staticCases.map((c) => [matchKey(c), c]));
  const onlyAuthoritative = [...authKeys.values()].filter((c) => !staticKeys.has(matchKey(c))).map(caseKey);
  const onlyStatic = [...staticKeys.values()].filter((c) => !authKeys.has(matchKey(c))).map(caseKey);
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
      //
      // The brace that opens the describe is the one that opens the
      // CALLBACK'S BODY, which is not necessarily the next brace: the
      // DETAILS OBJECT of `describe('tagged', { tag: '@smoke' }, ...)` opens
      // a brace of its own, and it closes again immediately. The scope is
      // therefore tied to the brace the callback body starts at, not to the
      // next brace in the file.
      if (pending && pending.brace === i) {
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
          // The scope of the block is the callback's body, so the brace is
          // found by looking at the CALLBACK, not at the next brace.
          const brace = callbackBodyBrace(src, title.end);
          pending = brace >= 0 ? { title: title.value, brace } : null;
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

/**
 * The offset of the brace that opens the BODY of the describe callback.
 *
 * The Playwright signature is `describe(title, details?, callback)`, so the
 * body brace is NOT the next brace after the title:
 *
 *   * `describe('tagged', { tag: '@smoke' }, () => { ... })` -- the details
 *     object opens a brace that closes again right away;
 *   * `describe('group', () => { ... })` -- the body brace follows the
 *     arrow function.
 *
 * So the reader skips the details object, finds the arrow of the callback
 * and returns the brace that follows it.
 *
 * Returns -1 when the callback has no brace body -- an expression-bodied
 * callback (`describe('x', () => test('inside', ...))`) or a callback that
 * is not an arrow function. The caller then opens no scope at all: a
 * lexical reader cannot tell where such a block ends, and a WRONG scope is
 * worse than none (it is a false difference in the consistency report).
 */
function callbackBodyBrace(src, from) {
  let i = from;
  // 1. the optional DETAILS object, between the title and the callback.
  i = skipSpace(src, i);
  if (src[i] === ',') {
    i = skipSpace(src, i + 1);
    if (src[i] === '{') {
      i = skipBalanced(src, i, '{', '}');
      i = skipSpace(src, i);
      if (src[i] === ',') i = skipSpace(src, i + 1);
    }
  }
  // 2. the arrow of the callback, at the top level of the argument list.
  let depth = 0;
  let arrow = -1;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = skipComment(src, i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = skipComment(src, i); continue; }
    if (c === '"' || c === "'") { i = skipString(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '/' && regexAllowedAt(src, i)) { i = skipRegexLiteral(src, i); continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break; // the end of the describe call
      depth--;
      i++;
      continue;
    }
    if (c === '=' && src[i + 1] === '>') {
      if (depth === 0) arrow = i;
      i += 2;
      continue;
    }
    i++;
  }
  if (arrow < 0) return -1;
  // 3. the body of the callback.
  let j = skipSpace(src, arrow + 2);
  if (src[j] === '(') {
    j = skipBalanced(src, j, '(', ')');
    j = skipSpace(src, j);
  }
  return src[j] === '{' ? j : -1;
}

/** The offset of the first character at or after `i` that is not a space. */
function skipSpace(src, i) {
  let j = i;
  while (j < src.length && /\s/.test(src[j])) j++;
  return j;
}

/**
 * The offset just after the group that starts at `i` and is closed by
 * `close`. The content is skipped with the same restricted lexer, so a
 * brace inside a string, a template literal, a comment or a regular
 * expression does not close the group.
 */
function skipBalanced(src, i, open, close) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = skipComment(src, i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = skipComment(src, i); continue; }
    if (c === '"' || c === "'") { i = skipString(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '/' && regexAllowedAt(src, i)) { i = skipRegexLiteral(src, i); continue; }
    if (c === open) { depth++; i++; continue; }
    if (c === close) {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return i;
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
