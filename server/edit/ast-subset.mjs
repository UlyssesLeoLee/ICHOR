/**
 * ATS-314 -- the CONTROLLED STEP SUBSET DETECTOR.
 *
 * WHAT THIS PROBLEM IS
 * ---------------------
 * The platform wants to draw a Playwright test as a FLOW and let the user
 * move the boxes. That is only safe if the platform can take the boxes
 * back and write them into the source file. The acceptance criterion of
 * ATS-314 is the boundary of that ability:
 *
 *     仅支持白名单 API/静态参数；任意复杂 TS 强制只读回退
 *
 *     Only the whitelisted APIs with static arguments are supported; any
 *     complex TypeScript falls back to READ-ONLY.
 *
 * WHY A REAL PARSER IS NOT USED
 * ------------------------------
 * ADR-003 says 「P1 改用 TypeScript AST 支持受控子集」. This module does
 * NOT use a TypeScript AST, and the reason is a FACT about the tree, not
 * a preference:
 *
 *   * the Node Bridge has **no third-party dependency at all** (see
 *     `docs/dependencies/dependency-manifest.md`: 「本项目无第三方依赖」);
 *   * `typescript` is a dependency of the FRONT-END (`apps/studio`), and
 *     `apps/studio/node_modules` is not installed in the Bridge's
 *     environment -- the Bridge cannot import it, and reaching into the
 *     front-end's `node_modules` from the Bridge would couple two
 *     deployables that are shipped separately;
 *   * adding `typescript` to the Bridge would change the dependency
 *     manifest, the licence review (16 licences still need legal review)
 *     and the CI install step for a feature that does not need it.
 *
 * So the detector is a **LEXER**, not a parser. This is a deliberate
 * downgrade of ambition, and the module says so out loud: it recognises
 * the SHAPE of a controlled step, it does not build a type graph.
 *
 * WHY A LEXER IS ENOUGH FOR THIS BOUNDARY
 * ----------------------------------------
 * The question this module answers is not 「what does this program
 * mean?」. It is 「is this CALL in the controlled subset, and is its
 * argument STATIC?」. Both are questions about the TOKEN SEQUENCE, and
 * a token sequence is exactly what a lexer produces.
 *
 * A regex would answer the same question -- and be wrong in the two ways
 * that matter here:
 *
 *   * a regex cannot tell a call inside a STRING (`'page.goto(x)'`) or
 *     inside a COMMENT (`// page.goto(x)`) from a real call. The lexer
 *     knows the difference, because it knows where strings and comments
 *     start and end;
 *   * a regex cannot find the matching BRACKET of a call with nested
 *     parentheses (`page.goto(getUrl('a', 'b'))`), so it cannot decide
 *     whether the argument is a static literal or a nested call. The
 *     lexer tracks the bracket depth and hands back the exact argument
 *     token ranges.
 *
 * WHAT THE DETECTOR DELIVERS
 * ---------------------------
 *   1. THE WHITELIST. A closed set of Playwright APIs, each with the
 *      argument shape it accepts. An API that is not on the list is not
 *      「unsupported so far」 -- it is NOT SUPPORTED, and it is reported
 *      as such with its name.
 *
 *   2. THE STEPS. Every call in the file, classified:
 *        - `controlled` -- a whitelisted API with static arguments. This
 *          is the subset that MAY be written back;
 *        - `read-only` -- everything else. It is NOT a failure and NOT
 *          an error: it is the platform refusing to claim it can rewrite
 *          this code.
 *
 *   3. THE REASON. Every read-only step carries a CLOSED reason code, so
 *      a reader can tell 「the API is not on the whitelist」 from
 *      「the argument is not static」 from 「the call has a shape we do
 *      not recognise」. A vague reason is what makes a refusal useless.
 *
 *   4. THE FILE VERDICT. One verdict per file: `writable` (the whole
 *      file is controlled), `partial` (some steps are controlled) or
 *      `read-only` (nothing is). ATS-315 needs this verdict before it
 *      may write anything back.
 *
 * THE TWO FACTS THAT MUST NOT BE CONFUSED
 * ----------------------------------------
 *   * A READ-ONLY STEP IS NOT A BROKEN FILE. A test that uses a helper
 *     is perfectly good test code. The platform simply may not rewrite
 *     it. Reporting it as an error would make the platform cry wolf on
 *     every real test suite, and a report nobody reads protects nobody.
 *
 *   * A CONTROLLED STEP IS NOT A PROMISE THAT THE REWRITE IS SAFE. This
 *     module recognises the subset; it does NOT write it back. The
 *     write-back (diff, syntax check, approve, atomic write) is
 *     ATS-315's job, and this module refuses to be mistaken for it.
 *
 * WHY THE ARGUMENT RULE IS "STATIC" AND NOT "CONSTANT"
 * ------------------------------------------------------
 * 「静态参数」 does not mean 「a number or a string」. It means the
 * argument's TEXT is known at parse time and does not depend on
 * anything computed at run time. So:
 *
 *   - a string literal, a number, a boolean, `null`, `undefined`: static;
 *   - a template literal with NO interpolation: static;
 *   - a template literal WITH an interpolation: NOT static -- the value
 *     is computed at run time;
 *   - a variable reference: NOT static -- the platform has no way to
 *     prove that a name holds a constant, so it does not assume one;
 *   - an options object is static only when EVERY value in it is
 *     static: `{ timeout: 5000 }` is static, `{ timeout: cfg.timeout }`
 *     is not;
 *   - a call, a member expression, an arithmetic expression: NOT static.
 *
 * The one exception is the ACTUAL side of an assertion: `expect(x)`
 *     carries the value the product produced at run time, which is
 *     computed at run time by definition. That is why the `expect`
 *     matcher entries declare a RUNTIME argument slot: the platform may
 *     not rewrite the actual side, and the detector says so instead of
 *     pretending it is static.
 *
 * THE THINGS THAT MUST NOT BE CONFUSED WITH EACH OTHER
 * ------------------------------------------------------
 *   * THE WHITELIST IS ABOUT THE API, NOT THE PROJECT. `page.goto` is
 *     on the list because it is a Playwright API with a known shape,
 *     not because some project uses it.
 *
 *   * A STEP INSIDE A CALLBACK IS A STEP. `test('x', async ({page}) =>
 *     { await page.goto('/') })` -- the `goto` is a controlled step even
 *     though it is nested inside two callbacks. The detector reports the
 *     NESTING depth it was found at, so ATS-315 can decide whether a
 *     nested step may be moved.
 *
 *   * A HELPER CALL IS NOT A CONTROLLED STEP. `await login(page)` is a
 *     call to a local function; the platform cannot know what it does,
 *     so it is read-only with the reason `not-whitelisted`. The
 *     platform does not guess that `login` is really `page.fill`.
 *
 *   * A CALL THAT IS PART OF ANOTHER CALL IS NOT A STEP OF ITS OWN.
 *     `page.locator('#t')` inside `expect(page.locator('#t'))` is the
 *     actual of the assertion, not a separate step; and
 *     `page.getByRole('button')` inside
 *     `page.getByRole('button').click()` is the locator of the click.
 *     Only the OUTERMOST call of an expression is a step.
 */
import fs from 'node:fs';

/**
 * The detector's version. It is part of every answer, so a consumer can
 * tell whether the shape it expects is the shape it got.
 */
export const AST_SUBSET_VERSION = 1;

/**
 * How a step was classified.
 *
 * The vocabulary is CLOSED: `controlled` is the only value that grants
 * write-back, and every other value is a refusal with a reason.
 */
export const STEP_EDITABILITY = Object.freeze({
  /** The step is on the whitelist and its arguments are static. */
  CONTROLLED: 'controlled',
  /** The step may not be written back. `reason` says why. */
  READ_ONLY: 'read-only',
});

/**
 * WHY a step is read-only.
 *
 * Every reason is a fact about the SOURCE, not a guess about the
 * author's intent. A reason code is what lets the UI say something
 * specific instead of 「this cannot be edited」.
 */
export const READ_ONLY_REASON = Object.freeze({
  /** The API is not on the whitelist. */
  NOT_WHITELISTED: 'not-whitelisted',
  /** The call takes a number of arguments the API does not declare. */
  ARITY_NOT_SUPPORTED: 'arity-not-supported',
  /** An argument that must be static is not. */
  ARGUMENT_NOT_STATIC: 'argument-not-static',
  /** The construct is not a plain call expression we can read. */
  NOT_A_PLAIN_CALL: 'not-a-plain-call',
  /**
   * The step is inside a loop, so it runs a number of times that is
   * decided at run time. The platform may not draw it as one box.
   */
  INSIDE_CONTROL_FLOW: 'inside-control-flow',
  /**
   * The step is inside a function that is declared in this file. The
   * platform may not move it: the function may be called from several
   * places, and moving a step out of it would change it for all of
   * them.
   */
  INSIDE_LOCAL_FUNCTION: 'inside-local-function',
  /** The file could not be lexed at all. */
  UNPARSEABLE: 'unparseable',
});

/**
 * The WHITELIST: the Playwright APIs whose calls the platform may
 * recognise as controlled steps.
 *
 * Each entry declares the ARITY of the CALL (how many arguments the
 * call itself takes) and, per argument, whether the argument must be
 * STATIC.
 *
 * The rule is per argument because the APIs differ: `page.goto(url)`
 * takes a static URL, while `expect(actual).toBe(expected)` takes a
 * runtime value in the actual slot and a static value in the expected
 * slot. The matcher entries therefore count the ACTUAL as argument 0
 * and the MATCHER's own arguments from 1 on.
 *
 * The list is CLOSED on purpose. An API that is not here is NOT
 * SUPPORTED -- it is not 「coming soon」 and it is not silently
 * accepted. Adding an API to this list is a design decision that has
 * to be made in the open, with the argument rule spelled out.
 */
export const WHITELIST = Object.freeze({
  // --- navigation -----------------------------------------------------
  //
  // THE TWO INDEX SPACES
  // ---------------------
  // `arity` is the number of arguments the CALL itself takes.
  // `staticArgs` and `runtimeArgs` are indices into the COMBINED
  // argument list, which is:
  //
  //   * for a plain API: the call's own arguments. The combined index
  //     equals the call index, so `combinedOffset` is 0;
  //   * for a matcher: the ACTUAL of the `expect(...)` call first, then
  //     the matcher's own arguments. The call's own argument 0 is the
  //     combined index 1, so `combinedOffset` is 1.
  //
  // The offset is a FIELD rather than a convention: a whitelist whose
  // rule has to be inferred is a whitelist whose rule gets broken
  // silently, and the breakage shows up as a step that is wrongly
  // reported as controlled.
  'page.goto': Object.freeze({
    api: 'page.goto',
    kind: 'navigate',
    // `page.goto(url, options?)`
    arity: Object.freeze([1, 2]),
    staticArgs: Object.freeze([0, 1]),
    doc: '静态 URL 可编辑',
    combinedOffset: 0,
  }),
  'page.goBack': Object.freeze({
    api: 'page.goBack',
    kind: 'navigate',
    // `page.goBack(options?)`
    arity: Object.freeze([0, 1]),
    staticArgs: Object.freeze([0]),
    doc: '无参数或静态等待选项',
    combinedOffset: 0,
  }),
  'page.goForward': Object.freeze({
    api: 'page.goForward',
    kind: 'navigate',
    // `page.goForward(options?)`
    arity: Object.freeze([0, 1]),
    staticArgs: Object.freeze([0]),
    doc: '无参数或静态等待选项',
    combinedOffset: 0,
  }),
  'page.reload': Object.freeze({
    api: 'page.reload',
    kind: 'navigate',
    // `page.reload(options?)`
    arity: Object.freeze([0, 1]),
    staticArgs: Object.freeze([0]),
    doc: '无参数或静态等待选项',
    combinedOffset: 0,
  }),

  // --- locators -------------------------------------------------------
  // The locator ACTIONS take their own arguments:
  //   `locator.click(options?)`      -- the options object
  //   `locator.fill(value, options?)` -- the value, then the options
  // The LOCATOR itself (`page.getByRole('button')`) is a separate
  // argument space and is always required to be static; the detector
  // checks it on its own.
  'locator.click': Object.freeze({
    api: 'locator.click',
    kind: 'click',
    arity: Object.freeze([0, 1]),
    staticArgs: Object.freeze([0]),
    doc: '简单 locator 可编辑',
    combinedOffset: 0,
  }),
  'locator.dblclick': Object.freeze({
    api: 'locator.dblclick',
    kind: 'click',
    arity: Object.freeze([0, 1]),
    staticArgs: Object.freeze([0]),
    doc: '简单 locator 可编辑',
    combinedOffset: 0,
  }),
  'locator.fill': Object.freeze({
    api: 'locator.fill',
    kind: 'input',
    // `locator.fill(value, options?)`
    arity: Object.freeze([1, 2]),
    // The VALUE is static -- 「常量/引用可编辑」 -- but a REFERENCE is
    // not a constant, so only literals and interpolation-free templates
    // qualify.
    staticArgs: Object.freeze([0, 1]),
    doc: '常量/引用可编辑',
    combinedOffset: 0,
  }),
  'locator.type': Object.freeze({
    api: 'locator.type',
    kind: 'input',
    // `locator.type(text, options?)`
    arity: Object.freeze([1, 2]),
    staticArgs: Object.freeze([0, 1]),
    doc: '常量/引用可编辑',
    combinedOffset: 0,
  }),
  'locator.press': Object.freeze({
    api: 'locator.press',
    kind: 'input',
    // `locator.press(key, options?)`
    arity: Object.freeze([1, 2]),
    staticArgs: Object.freeze([0, 1]),
    doc: '常量/引用可编辑',
    combinedOffset: 0,
  }),
  'locator.selectOption': Object.freeze({
    api: 'locator.selectOption',
    kind: 'input',
    // `locator.selectOption(values, options?)`
    arity: Object.freeze([1, 2]),
    staticArgs: Object.freeze([0, 1]),
    doc: '常量/引用可编辑',
    combinedOffset: 0,
  }),
  'locator.check': Object.freeze({
    api: 'locator.check',
    kind: 'input',
    // `locator.check(options?)`
    arity: Object.freeze([0, 1]),
    staticArgs: Object.freeze([0]),
    doc: '简单 locator 可编辑',
    combinedOffset: 0,
  }),
  'locator.uncheck': Object.freeze({
    api: 'locator.uncheck',
    kind: 'input',
    // `locator.uncheck(options?)`
    arity: Object.freeze([0, 1]),
    staticArgs: Object.freeze([0]),
    doc: '简单 locator 可编辑',
    combinedOffset: 0,
  }),

  // --- assertions -----------------------------------------------------
  // The `actual` is a runtime value BY NATURE: it is what the product
  // produced at run time. The detector does not call it static and does
  // not pretend the platform may rewrite it. The MATCHER side is static.
  //
  // The matcher entries count the ACTUAL as argument 0 (the argument of
  // the `expect(...)` call) and the matcher's own arguments from 1 on.
  // The `arity` of a matcher entry is the arity of the MATCHER CALL
  // alone (`toBe(expected)`), while `staticArgs` / `runtimeArgs` are
  // indices in the COMBINED space (the actual first). The two spaces are
  // different on purpose: the actual belongs to the `expect(...)` call
  // and the expected value belongs to the matcher call.
  'expect.toBe': Object.freeze({
    api: 'expect.toBe',
    kind: 'assertion',
    arity: Object.freeze([1]),
    staticArgs: Object.freeze([1]),
    runtimeArgs: Object.freeze([0]),
    doc: '限支持的 expect pattern',
    combinedOffset: 1,
  }),
  'expect.toEqual': Object.freeze({
    api: 'expect.toEqual',
    kind: 'assertion',
    arity: Object.freeze([1]),
    staticArgs: Object.freeze([1]),
    runtimeArgs: Object.freeze([0]),
    doc: '限支持的 expect pattern',
    combinedOffset: 1,
  }),
  'expect.toBeTruthy': Object.freeze({
    api: 'expect.toBeTruthy',
    kind: 'assertion',
    arity: Object.freeze([0]),
    staticArgs: Object.freeze([]),
    runtimeArgs: Object.freeze([0]),
    doc: '限支持的 expect pattern',
    combinedOffset: 1,
  }),
  'expect.toBeFalsy': Object.freeze({
    api: 'expect.toBeFalsy',
    kind: 'assertion',
    arity: Object.freeze([0]),
    staticArgs: Object.freeze([]),
    runtimeArgs: Object.freeze([0]),
    doc: '限支持的 expect pattern',
    combinedOffset: 1,
  }),
  'expect.toContain': Object.freeze({
    api: 'expect.toContain',
    kind: 'assertion',
    arity: Object.freeze([1]),
    staticArgs: Object.freeze([1]),
    runtimeArgs: Object.freeze([0]),
    doc: '限支持的 expect pattern',
    combinedOffset: 1,
  }),
  'expect.toHaveText': Object.freeze({
    api: 'expect.toHaveText',
    kind: 'assertion',
    // `toHaveText(expected, options?)`
    arity: Object.freeze([1, 2]),
    staticArgs: Object.freeze([1, 2]),
    runtimeArgs: Object.freeze([0]),
    doc: '限支持的 expect pattern',
    combinedOffset: 1,
  }),
  'expect.toHaveCount': Object.freeze({
    api: 'expect.toHaveCount',
    kind: 'assertion',
    // `toHaveCount(count)`
    arity: Object.freeze([1]),
    staticArgs: Object.freeze([1]),
    runtimeArgs: Object.freeze([0]),
    doc: '限支持的 expect pattern',
    combinedOffset: 1,
  }),
  'expect.toBeVisible': Object.freeze({
    api: 'expect.toBeVisible',
    kind: 'assertion',
    // `toBeVisible(options?)`
    arity: Object.freeze([0, 1]),
    staticArgs: Object.freeze([1]),
    runtimeArgs: Object.freeze([0]),
    doc: '限支持的 expect pattern',
    combinedOffset: 1,
  }),
  'expect.toBeHidden': Object.freeze({
    api: 'expect.toBeHidden',
    kind: 'assertion',
    // `toBeHidden(options?)`
    arity: Object.freeze([0, 1]),
    staticArgs: Object.freeze([1]),
    runtimeArgs: Object.freeze([0]),
    doc: '限支持的 expect pattern',
    combinedOffset: 1,
  }),

  // --- grouping -------------------------------------------------------
  'test.step': Object.freeze({
    api: 'test.step',
    kind: 'group',
    // `test.step(title, body)`
    arity: Object.freeze([1, 2]),
    // The TITLE is static -- it is the label on the canvas -- but the
    // BODY is a callback: the platform may not flatten it.
    staticArgs: Object.freeze([0]),
    doc: '折叠/展开',
    combinedOffset: 0,
  }),
});

/**
 * The LOCATOR FACTORIES: the member names that make up a locator.
 *
 * A locator is written `page.getByRole('button').getByText('X')`. The
 * detector must recognise the CHAIN, not just the last member: the
 * chain is what says which element the step acts on.
 */
export const LOCATOR_FACTORIES = Object.freeze([
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
  'getByTestId',
  'locator',
  'nth',
  'first',
  'last',
]);

/**
 * The CONTAINER calls: the declarations that hold a flow rather than
 * being a step of one.
 *
 * `test('title', async ({page}) => { ... })` is the CASE the flow
 * belongs to, not a step inside it. Reporting it as a step would be a
 * category error -- it would say 「this case declaration cannot be
 * rewritten」 when what it means is 「this case declaration is not a
 * step」. The container is reported in its own list, with the title and
 * the line, so a consumer can tell where each flow begins.
 *
 * `test.step(...)` is NOT a container: it is a GROUP, a step that holds
 * other steps, and it IS on the whitelist.
 */
export const CONTAINER_CALLS = Object.freeze([
  'test',
  'describe',
]);

/**
 * The FILE VERDICT: how much of a file the platform may rewrite.
 */
export const FILE_EDITABILITY = Object.freeze({
  /** Every step in the file is controlled. */
  WRITABLE: 'writable',
  /** Some steps are controlled, some are not. */
  PARTIAL: 'partial',
  /** No step is controlled: the file is read-only as a whole. */
  READ_ONLY: 'read-only',
});

/* ------------------------------------------------------------------ */
/* The lexer                                                           */
/* ------------------------------------------------------------------ */

/**
 * The kinds of token the lexer produces.
 *
 * A token carries its TEXT, its position (1-based line, 0-based column
 * -- what an editor expects) and its OFFSETS in the source, so a caller
 * can quote the exact original text of a range.
 */
export const TOKEN = Object.freeze({
  IDENT: 'ident',
  KEYWORD: 'keyword',
  NUMBER: 'number',
  STRING: 'string',
  TEMPLATE: 'template',
  PUNCT: 'punct',
  REGEX: 'regex',
});

const KEYWORDS = new Set([
  'await', 'async', 'const', 'let', 'var', 'function', 'return', 'if', 'else',
  'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'new', 'typeof', 'instanceof', 'in', 'of', 'this', 'super', 'class',
  'extends', 'implements', 'try', 'catch', 'finally', 'throw', 'yield',
  'import', 'export', 'from', 'as', 'void', 'delete', 'true', 'false', 'null',
  'undefined',
]);

/** The punctuators the lexer knows. Longest first. */
const PUNCTUATORS = Object.freeze([
  '===', '!==', '**=', '&&=', '||=', '??=', '>>>',
  '=>', '?.', '??', '**', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=',
  '^=', '==', '!=', '<=', '>=', '&&', '||',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
  '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#',
]);

/**
 * Whether a `/` starts a REGEX or is a division.
 *
 * JavaScript decides this from the previous significant token: a regex
 * may follow an operator, an opening bracket or a comma, and may not
 * follow a value. Getting this wrong turns `a / b / c` into a regex and
 * the whole file's token stream is then garbage.
 */
function regexAllowedAfter(prev) {
  if (!prev) return true;
  if (prev.type === TOKEN.NUMBER || prev.type === TOKEN.STRING ||
      prev.type === TOKEN.TEMPLATE || prev.type === TOKEN.REGEX) {
    return false;
  }
  if (prev.type === TOKEN.IDENT) return false;
  if (prev.type === TOKEN.KEYWORD) {
    // `this`, `super` and the literals END an expression; every other
    // keyword (`return`, `typeof`, `case`, `await`...) starts one.
    return !['this', 'super', 'true', 'false', 'null', 'undefined'].includes(prev.value);
  }
  return ![')', ']', '}', '++', '--'].includes(prev.value);
}

/**
 * Lexes `source` into a flat token list.
 *
 * The lexer NEVER throws on ordinary source: a construct it does not
 * understand becomes a punctuation token or is skipped, because a
 * detector that crashes on an unusual file cannot report 「read-only」 for
 * it -- it reports an error, and an error is not the same answer.
 *
 * The one thing it DOES report is an unterminated template literal,
 * because that means the file is not lexable at all and the honest
 * answer is 「I cannot read this file」 rather than 「this file has no
 * controlled steps」.
 *
 * @param {string} source the file's text
 * @returns {{tokens: Array, ok: boolean, error: string|null, source: string}}
 */
export function lex(source) {
  const src = String(source ?? '');
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 0;
  let prev = null;

  const push = (type, value, startLine, startCol, start, end) => {
    const tok = { type, value, line: startLine, column: startCol, start, end };
    tokens.push(tok);
    prev = tok;
  };

  const advance = (n) => {
    for (let k = 0; k < n; k += 1) {
      if (src[i] === '\n') { line += 1; col = 0; } else { col += 1; }
      i += 1;
    }
  };

  while (i < src.length) {
    const c = src[i];

    // --- whitespace ---------------------------------------------------
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(1); continue; }

    // --- comments -----------------------------------------------------
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') advance(1);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) { advance(src.length - i); continue; }
      advance(end + 2 - i);
      continue;
    }

    // --- strings ------------------------------------------------------
    if (c === '"' || c === "'") {
      const startLine = line;
      const startCol = col;
      const quote = c;
      const start = i;
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < src.length) {
        if (src[j] === '\\') { value += src[j] + (src[j + 1] ?? ''); j += 2; continue; }
        if (src[j] === quote) { closed = true; j += 1; break; }
        if (src[j] === '\n') break;        // an unterminated string ends at the newline
        value += src[j];
        j += 1;
      }
      advance(j - i);
      push(TOKEN.STRING, value, startLine, startCol, start, i);
      continue;
    }

    // --- template literals --------------------------------------------
    if (c === '`') {
      const startLine = line;
      const startCol = col;
      const start = i;
      const { text, end, interpolated, closed } = readTemplate(src, i);
      advance(end - i);
      push(TOKEN.TEMPLATE, text, startLine, startCol, start, i);
      // A template with an interpolation is NOT a static value. The
      // token carries the flag so the classifier can refuse it without
      // re-parsing the text.
      if (interpolated) tokens[tokens.length - 1].interpolated = true;
      if (!closed) {
        return { tokens, ok: false, error: 'unterminated template literal', source: src };
      }
      continue;
    }

    // --- regex --------------------------------------------------------
    if (c === '/' && regexAllowedAfter(prev)) {
      const startLine = line;
      const startCol = col;
      const start = i;
      const { text, end, closed } = readRegex(src, i);
      if (closed) {
        advance(end - i);
        push(TOKEN.REGEX, text, startLine, startCol, start, i);
        continue;
      }
      // Not a regex after all: fall through and treat it as punctuation.
    }

    // --- numbers ------------------------------------------------------
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const startLine = line;
      const startCol = col;
      const start = i;
      let j = i;
      while (j < src.length && /[0-9a-fA-FxXoObB._]/.test(src[j])) j += 1;
      // An exponent is part of the number.
      if ((src[j] === 'e' || src[j] === 'E') && /[0-9+-]/.test(src[j + 1] ?? '')) {
        j += 2;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      const text = src.slice(i, j);
      advance(j - i);
      push(TOKEN.NUMBER, text, startLine, startCol, start, i);
      continue;
    }

    // --- identifiers and keywords -------------------------------------
    if (/[A-Za-z_$]/.test(c)) {
      const startLine = line;
      const startCol = col;
      const start = i;
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
      const text = src.slice(i, j);
      advance(j - i);
      push(KEYWORDS.has(text) ? TOKEN.KEYWORD : TOKEN.IDENT, text, startLine, startCol, start, i);
      continue;
    }

    // --- punctuation --------------------------------------------------
    const punct = PUNCTUATORS.find((p) => src.startsWith(p, i));
    if (punct) {
      const startLine = line;
      const startCol = col;
      const start = i;
      advance(punct.length);
      push(TOKEN.PUNCT, punct, startLine, startCol, start, i);
      continue;
    }

    // An unknown character: skip it. The detector must not die on a
    // character it does not know -- a file with an exotic character is
    // still a file whose steps may be recognised.
    advance(1);
  }

  return { tokens, ok: true, error: null, source: src };
}

/**
 * Reads a template literal starting at `start`.
 *
 * Returns the RAW text (between the backticks), the end offset, whether
 * it holds an interpolation, and whether it was closed.
 */
function readTemplate(src, start) {
  let i = start + 1;
  let interpolated = false;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '$' && src[i + 1] === '{') { interpolated = true; depth += 1; i += 2; continue; }
    if (depth > 0) {
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
      continue;
    }
    if (c === '`') return { text: src.slice(start + 1, i), end: i + 1, interpolated, closed: true };
    i += 1;
  }
  return { text: src.slice(start + 1), end: src.length, interpolated, closed: false };
}

/**
 * Reads a regex literal starting at `start`.
 *
 * A regex that is not closed (which happens when the `/` was a division
 * after all) is reported as `closed: false`, and the caller then treats
 * the `/` as punctuation.
 */
function readRegex(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let j = i + 1;
      while (j < src.length && /[a-z]/.test(src[j])) j += 1;
      return { text: src.slice(start, j), end: j, closed: true };
    } else if (c === '\n') {
      return { text: src.slice(start, i), end: i, closed: false };
    }
    i += 1;
  }
  return { text: src.slice(start), end: src.length, closed: false };
}

/* ------------------------------------------------------------------ */
/* The static-value rule                                               */
/* ------------------------------------------------------------------ */

/**
 * Splits a token range into its TOP-LEVEL members, separated by commas
 * that are not inside a bracket.
 *
 * @param {Array} tokens the token list
 * @param {number} from the first token index (inclusive)
 * @param {number} to the last token index (exclusive)
 * @returns {Array<[number, number]>} the member ranges, in order
 */
export function splitTopLevel(tokens, from, to) {
  const out = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const t = tokens[i];
    if (t.type !== TOKEN.PUNCT) continue;
    if (t.value === '(' || t.value === '[' || t.value === '{') { depth += 1; continue; }
    if (t.value === ')' || t.value === ']' || t.value === '}') { depth -= 1; continue; }
    if (t.value === ',' && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  if (start < to) out.push([start, to]);
  return out;
}

/**
 * The ARGUMENTS of a call whose `(` is at `open` and whose `)` is at
 * `close`.
 *
 * The range is the INSIDE of the brackets: the brackets themselves are
 * not arguments, and including them made every call look as if it were
 * nested inside one of its own arguments (which made the detector skip
 * every step it found).
 */
function callArguments(tokens, open, close) {
  return splitTopLevel(tokens, open + 1, close);
}

/**
 * The index of the first top-level `:` in a token range, or -1.
 *
 * It is the separator between an object literal's key and its value.
 */
function findTopLevelColon(tokens, from, to) {
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    const t = tokens[i];
    if (t.type !== TOKEN.PUNCT) continue;
    if (t.value === '(' || t.value === '[' || t.value === '{') { depth += 1; continue; }
    if (t.value === ')' || t.value === ']' || t.value === '}') { depth -= 1; continue; }
    if (t.value === ':' && depth === 0) return i;
  }
  return -1;
}

/**
 * Whether a single token is a STATIC value.
 */
function isStaticToken(token) {
  if (token.type === TOKEN.STRING || token.type === TOKEN.NUMBER) return true;
  if (token.type === TOKEN.TEMPLATE) return !token.interpolated;
  if (token.type === TOKEN.KEYWORD) {
    return ['true', 'false', 'null', 'undefined'].includes(token.value);
  }
  return false;
}

/**
 * Whether a token range is a STATIC value.
 *
 * A static value is one whose TEXT is known without running the
 * program: a string, a number, a boolean, `null`, `undefined`, a
 * template literal with no interpolation, or an object/array literal
 * whose EVERY value is itself static.
 *
 * An object literal's member is `key: value` (the value must be
 * static) or a SHORTHAND (`{ timeout }` -- the value is a name, and a
 * name is not a static value) or a SPREAD (`{ ...base }` -- not
 * static).
 *
 * @param {Array} tokens the token list
 * @param {number} from the first token index (inclusive)
 * @param {number} to the last token index (exclusive)
 * @returns {boolean}
 */
export function isStaticRange(tokens, from, to) {
  if (to <= from) return false;
  const slice = tokens.slice(from, to);
  if (slice.length === 1) return isStaticToken(slice[0]);

  const opening = slice[0].value;
  const closing = slice[slice.length - 1].value;

  if (opening === '{' && closing === '}') {
    const members = splitTopLevel(tokens, from + 1, to - 1);
    for (const [a, b] of members) {
      if (b <= a) continue;                       // a trailing comma
      const colon = findTopLevelColon(tokens, a, b);
      if (colon === -1) return false;             // shorthand or spread
      // The key must be a plain name or a string; a computed key is not.
      const key = tokens.slice(a, colon);
      if (key.length !== 1) return false;
      if (key[0].type !== TOKEN.IDENT && key[0].type !== TOKEN.STRING) return false;
      if (!isStaticRange(tokens, colon + 1, b)) return false;
    }
    return true;
  }

  if (opening === '[' && closing === ']') {
    const members = splitTopLevel(tokens, from + 1, to - 1);
    for (const [a, b] of members) {
      if (b <= a) continue;
      if (!isStaticRange(tokens, a, b)) return false;
    }
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* The chain analysis                                                  */
/* ------------------------------------------------------------------ */

/**
 * Finds the index of the `(` that opens the `)` at `close`.
 *
 * Returns -1 when the brackets do not balance.
 */
function matchParenBackward(tokens, close) {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    const t = tokens[i];
    if (t.type !== TOKEN.PUNCT) continue;
    if (t.value === ')' || t.value === ']' || t.value === '}') depth += 1;
    else if (t.value === '(' || t.value === '[' || t.value === '{') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Finds the matching `)` of the `(` at `open`.
 *
 * Returns the index of the closing bracket, or -1 when the brackets do
 * not balance (which means the file is malformed -- the honest answer
 * is that the step cannot be classified).
 */
function matchParen(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type !== TOKEN.PUNCT) continue;
    if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
    else if (t.value === ')' || t.value === ']' || t.value === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Describes the chain in front of the `(` at `open`.
 *
 * A chain is a sequence of SEGMENTS: a NAME (an identifier) or a CALL
 * (a parenthesised expression).
 *
 *   `page.getByRole('button').click` is
 *       NAME(page) NAME(getByRole) CALL('button') NAME(click)
 *
 *   `expect(x).toBe` is
 *       NAME(expect) CALL(x) NAME(toBe)
 *
 * The segment list is what tells the matcher apart from a plain method
 * call: `expect(x).toBe(y)` has a CALL in the middle, and the CALL's
 * callee is `expect`.
 *
 * @param {Array} tokens the token list
 * @param {number} open the index of the call's `(`
 * @returns {object|null} the chain description, or null when it is not
 *   a chain the detector can read
 */
function describeChain(tokens, open) {
  const segments = [];
  let k = open - 1;

  // A FUNCTION DECLARATION's parameter list is not a call. In
  // `async function helper() { ... }` the `(` belongs to the
  // declaration and `helper` is the declared NAME, not a callee.
  // Reporting it as a step would say 「the declaration of `helper` is a
  // step we do not support」 -- which is a category error.
  {
    let j = k - 1;
    while (j >= 0 && tokens[j].type === TOKEN.PUNCT && tokens[j].value === '*') j -= 1;
    if (j >= 0 && tokens[j].type === TOKEN.KEYWORD && tokens[j].value === 'function') return null;
  }

  // Only an IDENT may be the callee. A KEYWORD in that position is
  // control flow (`for (`, `if (`, `while (`) or an arrow function's
  // parameter list (`async (`), and reporting those as steps would say
  // 「async is a step we do not support」 -- which is noise, not a
  // refusal.
  while (k >= 0) {
    const t = tokens[k];

    if (t.type === TOKEN.IDENT) {
      segments.unshift({ kind: 'name', name: t.value, index: k, token: t });
      k -= 1;
      if (k >= 0 && tokens[k].type === TOKEN.PUNCT && tokens[k].value === '.') {
        k -= 1;
        continue;
      }
      break;
    }

    if (t.type === TOKEN.PUNCT && t.value === ')') {
      // A call result: the receiver is a call, not a name.
      const callOpen = matchParenBackward(tokens, k);
      if (callOpen === -1) return null;
      const inner = describeChain(tokens, callOpen);
      if (!inner) return null;
      segments.unshift({
        kind: 'call',
        callee: inner,
        index: inner.firstIndex,
        open: callOpen,
        close: k,
      });
      k = inner.firstIndex - 1;
      if (k >= 0 && tokens[k].type === TOKEN.PUNCT && tokens[k].value === '.') {
        k -= 1;
        continue;
      }
      break;
    }

    return null;
  }

  if (segments.length === 0) return null;
  // `firstIndex` is the TOKEN index of the chain's first segment (used to
  // walk the token list) and `startOffset` is the CHARACTER offset of the
  // same segment (used to quote the original text). They are different
  // numbers and must not be mixed.
  const firstIndex = segments[0].index;
  const startOffset = segments[0].token
    ? segments[0].token.start
    : segments[0].callee.startOffset;
  return { segments, firstIndex, startOffset, open };
}

/**
 * The NAMES of a chain, flattened.
 *
 * A CALL segment stands for `<callee>(...)`, so it contributes the
 * callee's names. So
 *
 *   `page.getByRole('button').click` -> `['page', 'getByRole', 'click']`
 *   `expect(x).toBe(y)`               -> `['expect', 'toBe']`
 *
 * The names must be the names the SOURCE has, in the source's order:
 * the whitelist lookup reads this list, so a list that repeats or
 * reorders names would be a list that does not correspond to the file.
 */
function chainNames(chain) {
  const out = [];
  for (const seg of chain.segments) {
    if (seg.kind === 'name') out.push(seg.name);
    // A CALL segment stands for `<callee>(...)`, so it contributes the
    // callee's names: the call segment of `page.getByRole('button')`
    // contributes `page` and `getByRole`.
    else if (seg.callee) out.push(...chainNames(seg.callee));
  }
  return out;
}

/**
 * The CALL segments of a chain: the locator factories and the `expect`
 * receiver.
 */
function callSegments(chain) {
  const out = [];
  for (const seg of chain.segments) {
    if (seg.kind === 'call') out.push(seg);
    // A NAME segment has no callee of its own; only a CALL segment
    // carries one. Recursing into a name's (absent) callee is what
    // crashed the first version of this function.
    else if (seg.callee) out.push(...callSegments(seg.callee));
  }
  return out;
}
/**
 * Whether a chain is a LOCATOR chain.
 *
 * A locator chain is one that CONTAINS a locator factory:
 * `page.getByRole('button')`, `locator('#id')`, `page.locator('#id')`.
 */
function isLocatorChain(names) {
  const head = names.slice(0, -1);
  if (head.length === 0) return false;
  if (head[0] === 'locator') return true;
  return head.some((n) => LOCATOR_FACTORIES.includes(n));
}

/**
 * The WHITELIST KEY for a chain, or null when the chain is not on the
 * list.
 *
 * The key is built from the chain's shape:
 *   - `expect(actual).toBe(x)` -> `expect.toBe`;
 *   - `page.goto(x)`           -> `page.goto`;
 *   - `test.step(x, cb)`       -> `test.step`;
 *   - `page.getByRole(x).click()` and `locator(x).click()` -> `locator.click`.
 */
function whitelistKey(names) {
  const action = names[names.length - 1];
  const head = names.slice(0, -1);
  if (!action) return null;

  // The assertion matcher: `expect(...)` followed by a matcher method.
  if (head[0] === 'expect' && /^to[A-Z]/.test(action)) {
    const key = `expect.${action}`;
    if (WHITELIST[key]) return key;
    return null;
  }
  // The direct `page.*` and `test.*` APIs.
  if (head[0] === 'page' || head[0] === 'test' || head[0] === 'context') {
    const key = `${head[0]}.${action}`;
    if (WHITELIST[key]) return key;
  }
  // The locator actions. A chain that ENDS in a locator factory is not
  // an action at all -- `page.locator('#t')` alone is a locator, and it
  // is reported as part of the step that uses it.
  if (isLocatorChain(names)) {
    const key = `locator.${action}`;
    if (WHITELIST[key]) return key;
  }
  return null;
}

/**
 * The ACTION member of a chain: the last name that is not a locator
 * factory.
 *
 * `page.getByRole('button').click` -> `click`;
 * `page.locator('#t')`             -> `locator` (the chain ENDS in a
 *   factory, so it has no action -- it is a locator, not a step).
 */
function actionOf(names) {
  const last = names[names.length - 1];
  if (LOCATOR_FACTORIES.includes(last)) return null;
  return last;
}

/* ------------------------------------------------------------------ */
/* The step detector                                                   */
/* ------------------------------------------------------------------ */

/**
 * Whether an argument range is a CALLBACK (an arrow function or a
 * function expression).
 *
 * A call inside a callback is a step of its own; a call inside a plain
 * argument (the locator of an assertion, for instance) is part of that
 * argument and is not a step of its own.
 */
function isCallbackRange(tokens, from, to) {
  for (let i = from; i < to; i += 1) {
    const t = tokens[i];
    if (t.type === TOKEN.PUNCT && t.value === '=>') return true;
    if (t.type === TOKEN.KEYWORD && t.value === 'function') return true;
  }
  return false;
}

/**
 * The CONTROL FLOW statements whose body the platform may not treat as
 * a sequence of steps.
 *
 * A step inside a `for` or a `while` runs a NUMBER OF TIMES that is
 * decided at run time. The platform may not draw it as ONE box on a
 * flow: the box would claim 「one click」 where the code says 「click
 * once per item」. So the step is reported, but it is reported as
 * READ-ONLY with the reason `inside-control-flow`.
 *
 * The list is closed on purpose: a construct that is not here is
 * treated as a plain sequence, and the reason code exists so the
 * refusal is explicit rather than silent.
 */
export const CONTROL_FLOW_KEYWORDS = Object.freeze([
  'for', 'forof', 'forin', 'while', 'dowhile',
]);

/**
 * The BODIES of the functions that are declared in this file.
 *
 * A function DECLARATION (`function helper() { ... }`) and a function
 * EXPRESSION bound to a name (`const helper = async () => { ... }`) are
 * both bodies the platform may not move steps out of: the function may
 * be called from several places, and a step taken out of it would
 * change it for all of them.
 *
 * A CALLBACK is NOT one of them. The callback of a `test(...)` or of a
 * `test.step(...)` holds exactly the steps the flow is made of, and
 * refusing them would refuse the whole product.
 *
 * @param {Array} tokens the token list
 * @returns {Array<[number, number]>} the body ranges, in token indices
 */
export function localFunctionBodies(tokens) {
  const bodies = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];

    // `function name(...) { ... }`
    if (t.type === TOKEN.KEYWORD && t.value === 'function') {
      const name = tokens[i + 1];
      if (!name || name.type !== TOKEN.IDENT) continue;
      const open = tokens[i + 2];
      if (!open || open.type !== TOKEN.PUNCT || open.value !== '(') continue;
      const close = matchParen(tokens, i + 2);
      if (close === -1) continue;
      const brace = tokens[close + 1];
      if (!brace || brace.type !== TOKEN.PUNCT || brace.value !== '{') continue;
      const bodyClose = matchParen(tokens, close + 1);
      if (bodyClose === -1) continue;
      bodies.push([close + 1, bodyClose]);
      continue;
    }

    // `const name = async (...) => { ... }` and `const name = (...) => { ... }`
    if (t.type === TOKEN.KEYWORD && ['const', 'let', 'var'].includes(t.value)) {
      const name = tokens[i + 1];
      if (!name || name.type !== TOKEN.IDENT) continue;
      const eq = tokens[i + 2];
      if (!eq || eq.type !== TOKEN.PUNCT || eq.value !== '=') continue;
      // Find the `=>` of this statement: the statement ends at the
      // first `;` at the same bracket depth.
      let depth = 0;
      let arrow = -1;
      for (let k = i + 3; k < tokens.length; k += 1) {
        const u = tokens[k];
        if (u.type !== TOKEN.PUNCT) continue;
        if (u.value === '(' || u.value === '[' || u.value === '{') { depth += 1; continue; }
        if (u.value === ')' || u.value === ']' || u.value === '}') { depth -= 1; continue; }
        if (u.value === ';' && depth === 0) break;
        if (u.value === '=>' && depth === 0) { arrow = k; break; }
      }
      if (arrow === -1) continue;
      const brace = tokens[arrow + 1];
      if (!brace || brace.type !== TOKEN.PUNCT || brace.value !== '{') continue;
      const bodyClose = matchParen(tokens, arrow + 1);
      if (bodyClose === -1) continue;
      bodies.push([arrow + 1, bodyClose]);
    }
  }
  return bodies;
}

/**
 * The CONTROL FLOW headers of the file.
 *
 * The headers are found by scanning the TOKEN LIST for the keywords,
 * not by looking at the call list: the `for` keyword is not a callee,
 * so the `(` that opens a loop's header is never a call and would never
 * appear in the call list. Looking for it there is what made the first
 * version miss every loop.
 *
 * @param {Array} tokens the token list
 * @returns {Array<number>} the token indices of the headers' `(`
 */
export function controlFlowHeaders(tokens) {
  const out = [];
  // The scan starts at 0: a file may BEGIN with `for (`, and starting
  // at 1 skipped exactly that file.
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type !== TOKEN.KEYWORD) continue;
    if (!['for', 'while'].includes(t.value)) continue;
    const open = tokens[i + 1];
    if (!open || open.type !== TOKEN.PUNCT || open.value !== '(') continue;
    out.push(i + 1);
  }
  return out;
}

/**
 * The BODY RANGE of a control statement: the `{ ... }` block that
 * follows its header.
 *
 * Returns null when the statement has no block body (a `for (;;)` with
 * a single statement after it).
 */
function controlFlowBody(tokens, headerOpen) {
  const close = matchParen(tokens, headerOpen);
  if (close === -1) return null;
  // The body starts at the `{` that follows the header.
  for (let i = close + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type !== TOKEN.PUNCT) continue;
    if (t.value === '{') {
      const bodyClose = matchParen(tokens, i);
      return bodyClose === -1 ? null : [i, bodyClose];
    }
    // A `;` before the `{` means there is no block body.
    if (t.value === ';') return null;
  }
  return null;
}

/**
 * Detects the CONTROLLED STEPS of a source file.
 *
 * The result is the file's verdict, its steps and its counts. A file
 * that cannot be lexed gets the read-only verdict and the reason.
 *
 * @param {string} source the file's text
 * @returns {object} the analysis
 */
export function analyseSource(source) {
  const { tokens, ok, error, source: src } = lex(source);
  if (!ok) {
    return {
      version: AST_SUBSET_VERSION,
      editability: FILE_EDITABILITY.READ_ONLY,
      steps: [],
      containers: [],
      counts: { total: 0, controlled: 0, readOnly: 0 },
      reasons: { [READ_ONLY_REASON.UNPARSEABLE]: 1 },
      error,
    };
  }

  // --- every call in the file -----------------------------------------
  const calls = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== TOKEN.PUNCT || tokens[i].value !== '(') continue;
    const close = matchParen(tokens, i);
    if (close === -1) continue;                   // unbalanced: unreadable
    const chain = describeChain(tokens, i);
    if (!chain) continue;
    calls.push({ open: i, close, chain, names: chainNames(chain) });
  }

  // --- which calls are STEPS ------------------------------------------
  //
  // A call is NOT a step of its own when it is
  //   (a) the RECEIVER of another call (`page.locator('#t')` inside
  //       `page.locator('#t').click()`), or
  //   (b) nested inside a PLAIN argument of another call (`expect`'s
  //       actual is part of the assertion).
  //
  // A call inside a CALLBACK argument IS a step: the body of a
  // `test.step` holds the steps the flow is made of.
  const consumed = new Set();
  const plainArgumentRanges = [];
  const callbackRanges = [];

  for (const call of calls) {
    for (const seg of callSegments(call.chain)) {
      consumed.add(seg.open);
    }
    const args = callArguments(tokens, call.open, call.close);
    for (const [from, to] of args) {
      if (isCallbackRange(tokens, from, to)) callbackRanges.push([from, to]);
      else plainArgumentRanges.push([from, to]);
    }
  }

  // The CONTROL FLOW bodies: a step inside one of them is reported, but
  // as READ-ONLY, because a loop runs a number of times that is decided
  // at run time.
  const controlFlowRanges = [];
  for (const headerOpen of controlFlowHeaders(tokens)) {
    const body = controlFlowBody(tokens, headerOpen);
    if (body) controlFlowRanges.push(body);
  }

  // The LOCALLY DECLARED FUNCTIONS: a step inside one of them may not
  // be moved out of it.
  const localFunctionRanges = localFunctionBodies(tokens);

  const isNestedInPlainArgument = (open) => plainArgumentRanges.some(
    ([from, to]) => open >= from && open < to,
  );
  const isInsideControlFlow = (open) => controlFlowRanges.some(
    ([from, to]) => open >= from && open < to,
  );
  const isInsideLocalFunction = (open) => localFunctionRanges.some(
    ([from, to]) => open >= from && open < to,
  );
  const nestingDepth = (open) => callbackRanges.filter(
    ([from, to]) => open >= from && open < to,
  ).length;

  // --- the CONTAINERS --------------------------------------------------
  //
  // A container call is a call whose callee is exactly one of the
  // container names: `test('x', cb)` has the callee `test`, while
  // `test.step('x', cb)` has the callee `test.step` and is a GROUP.
  const containers = [];
  for (const call of calls) {
    if (call.names.length !== 1) continue;
    if (!CONTAINER_CALLS.includes(call.names[0])) continue;
    const args = callArguments(tokens, call.open, call.close);
    containers.push({
      kind: call.names[0],
      line: tokens[call.chain.firstIndex].line,
      column: tokens[call.chain.firstIndex].column,
      title: args.length ? src.slice(tokens[args[0][0]].start, tokens[args[0][1] - 1].end) : null,
      titleIsStatic: args.length ? isStaticRange(tokens, args[0][0], args[0][1]) : false,
    });
  }

  // --- the steps -------------------------------------------------------
  const steps = [];
  const seen = new Set();

  for (const call of calls) {
    if (seen.has(call.open)) continue;
    seen.add(call.open);
    if (consumed.has(call.open)) continue;
    if (isNestedInPlainArgument(call.open)) continue;
    // A container is not a step. It is reported in `containers`.
    if (call.names.length === 1 && CONTAINER_CALLS.includes(call.names[0])) continue;

    const names = call.names;
    const action = actionOf(names);
    const key = action ? whitelistKey(names) : null;

    const step = {
      api: null,
      chain: names.join('.'),
      kind: null,
      editability: STEP_EDITABILITY.READ_ONLY,
      reason: null,
      line: tokens[call.chain.firstIndex].line,
      column: tokens[call.chain.firstIndex].column,
      nesting: nestingDepth(call.open),
      // The ACTION call's own arguments, indexed in the ACTION's space.
      arguments: [],
      // The LOCATOR chain's arguments, indexed in the LOCATOR's space.
      // They are a different space: `page.getByRole('button').click()`
      // has ONE action argument (none) and TWO locator arguments, and
      // mixing the two spaces made the whitelist's rules unreadable.
      locatorArguments: [],
    };

    if (!key) {
      step.reason = READ_ONLY_REASON.NOT_WHITELISTED;
      steps.push(step);
      continue;
    }

    const entry = WHITELIST[key];
    step.api = entry.api;
    step.kind = entry.kind;

    // The ARITY: the number of arguments the CALL takes. A call with a
    // number of arguments the API does not declare is a call the
    // detector does not recognise -- an optional argument may be
    // present or absent, but nothing else is acceptable.
    const ownArgs = callArguments(tokens, call.open, call.close);
    if (!entry.arity.includes(ownArgs.length)) {
      step.reason = READ_ONLY_REASON.ARITY_NOT_SUPPORTED;
      steps.push(step);
      continue;
    }

    // The ARGUMENT LIST of the step.
    //
    // For a matcher the list is the ACTUAL (the argument of the
    // `expect(...)` call) followed by the matcher's own arguments, so
    // the actual is argument 0 and the expected value is argument 1.
    let args = ownArgs;
    let expectCall = null;
    if (key.startsWith('expect.')) {
      // The receiver of the matcher is the `expect(...)` call.
      const receiver = callSegments(call.chain)[0];
      if (!receiver) {
        step.reason = READ_ONLY_REASON.NOT_A_PLAIN_CALL;
        steps.push(step);
        continue;
      }
      const expectArgs = callArguments(tokens, receiver.open, receiver.close);
      if (expectArgs.length !== 1) {
        step.reason = READ_ONLY_REASON.NOT_A_PLAIN_CALL;
        steps.push(step);
        continue;
      }
      expectCall = receiver;
      args = [...expectArgs, ...ownArgs];
    }

    // The LOCATOR FACTORIES of the chain: their arguments are part of
    // the step, and they must be static too -- a locator computed at
    // run time is not a step the platform may draw.
    const locatorArgs = [];
    if (key.startsWith('locator.')) {
      for (const seg of callSegments(call.chain)) {
        locatorArgs.push(...callArguments(tokens, seg.open, seg.close));
      }
    }

    // The whitelist's indices live in the COMBINED space, and `args` IS
    // the combined list: for a matcher it was built as
    // `[theActual, ...theMatchersOwnArguments]`. So the combined index of
    // `args[a]` is simply `a` -- the offset is already accounted for by
    // the way the list was built, and applying it a second time shifted
    // every matcher argument by one.
    let refused = null;
    for (let a = 0; a < args.length; a += 1) {
      const [from, to] = args[a];
      const combined = a;
      const isRuntime = (entry.runtimeArgs ?? []).includes(combined);
      const mustBeStatic = (entry.staticArgs ?? []).includes(combined);
      const staticValue = isStaticRange(tokens, from, to);
      step.arguments.push({
        index: a,
        static: staticValue,
        runtime: isRuntime,
        text: src.slice(tokens[from].start, tokens[to - 1].end),
      });
      if (isRuntime) continue;          // a runtime value is EXPECTED here
      if (mustBeStatic && !staticValue) {
        refused = READ_ONLY_REASON.ARGUMENT_NOT_STATIC;
        break;
      }
    }

    // The locator's own arguments. They are ALWAYS required to be
    // static: a locator computed at run time is not a step the platform
    // may draw on a canvas.
    if (!refused) {
      for (const [from, to] of locatorArgs) {
        const staticValue = isStaticRange(tokens, from, to);
        step.locatorArguments.push({
          index: step.locatorArguments.length,
          static: staticValue,
          text: src.slice(tokens[from].start, tokens[to - 1].end),
        });
        if (!staticValue) {
          refused = READ_ONLY_REASON.ARGUMENT_NOT_STATIC;
          break;
        }
      }
    }

    if (refused) {
      step.reason = refused;
      steps.push(step);
      continue;
    }

    // A step inside a LOOP is not a step the platform may draw as one
    // box: the loop decides at run time how many times it runs. The
    // refusal comes AFTER the argument checks, so the reader is told
    // the whole truth: the arguments were static AND the step is in a
    // loop.
    if (isInsideControlFlow(call.open)) {
      step.reason = READ_ONLY_REASON.INSIDE_CONTROL_FLOW;
      steps.push(step);
      continue;
    }

    // A step inside a LOCALLY DECLARED FUNCTION may not be moved out of
    // it: the function may be called from several places, and taking a
    // step out of it would change it for all of them. The refusal comes
    // AFTER the argument checks, so the reader is told the whole truth.
    if (isInsideLocalFunction(call.open)) {
      step.reason = READ_ONLY_REASON.INSIDE_LOCAL_FUNCTION;
      steps.push(step);
      continue;
    }

    step.editability = STEP_EDITABILITY.CONTROLLED;
    step.reason = null;
    if (expectCall) step.expectAt = { line: tokens[expectCall.open].line };
    steps.push(step);
  }

  const counts = { total: steps.length, controlled: 0, readOnly: 0 };
  const reasons = {};
  for (const step of steps) {
    if (step.editability === STEP_EDITABILITY.CONTROLLED) {
      counts.controlled += 1;
    } else {
      counts.readOnly += 1;
      const r = step.reason ?? READ_ONLY_REASON.NOT_WHITELISTED;
      reasons[r] = (reasons[r] ?? 0) + 1;
    }
  }

  let editability;
  if (counts.total === 0) editability = FILE_EDITABILITY.READ_ONLY;
  else if (counts.readOnly === 0) editability = FILE_EDITABILITY.WRITABLE;
  else if (counts.controlled === 0) editability = FILE_EDITABILITY.READ_ONLY;
  else editability = FILE_EDITABILITY.PARTIAL;

  return {
    version: AST_SUBSET_VERSION,
    editability,
    steps,
    containers,
    counts,
    reasons,
    error: null,
  };
}

/**
 * Analyses the file at `file`.
 *
 * A file that cannot be READ is not a file with no controlled steps:
 * it is a file the platform could not look at, and the answer says so.
 *
 * @param {string} file the path
 * @returns {object} the analysis
 */
export function analyseFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return {
      version: AST_SUBSET_VERSION,
      editability: FILE_EDITABILITY.READ_ONLY,
      steps: [],
      containers: [],
      counts: { total: 0, controlled: 0, readOnly: 0 },
      reasons: { [READ_ONLY_REASON.UNPARSEABLE]: 1 },
      error: `cannot read the file: ${e.code ?? e.message}`,
    };
  }
  return analyseSource(text);
}

/**
 * The REPORT: the analysis of a file, plus the fields a consumer needs
 * to decide whether it may write anything back.
 *
 * The `writable` flag is the answer ATS-315 needs: it is true only when
 * EVERY step in the file is controlled. A file with one uncontrolled
 * step is not writable as a whole -- the platform may not rewrite a
 * file whose steps it does not fully understand.
 */
export function buildReport(file, source) {
  const analysis = source === undefined ? analyseFile(file) : analyseSource(source);
  return {
    version: analysis.version,
    file: file ?? null,
    editability: analysis.editability,
    writable: analysis.editability === FILE_EDITABILITY.WRITABLE,
    counts: analysis.counts,
    reasons: analysis.reasons,
    steps: analysis.steps,
    containers: analysis.containers ?? [],
    error: analysis.error,
  };
}

/**
 * The CONTROLLED STEPS of a file: the ones that may be written back.
 */
export function controlledSteps(report) {
  return (report.steps ?? []).filter((s) => s.editability === STEP_EDITABILITY.CONTROLLED);
}

/**
 * The READ-ONLY STEPS of a file, with the reason each one carries.
 */
export function readOnlySteps(report) {
  return (report.steps ?? []).filter((s) => s.editability === STEP_EDITABILITY.READ_ONLY);
}

/**
 * A READABLE summary of a report.
 *
 * The counts are the ones the report carries, so the text cannot claim
 * a number the report does not have.
 */
export function formatSubsetReport(report) {
  const lines = [];
  lines.push(`file        : ${report.file ?? '(inline)'}`);
  lines.push(`version     : ${report.version}`);
  lines.push(`editability : ${report.editability}`);
  lines.push(`writable    : ${report.writable}`);
  lines.push(`steps       : ${report.counts.total} total / ${report.counts.controlled} controlled / ${report.counts.readOnly} read-only`);
  const reasonKeys = Object.keys(report.reasons ?? {});
  if (reasonKeys.length) {
    lines.push('reasons     :');
    for (const key of reasonKeys.sort()) {
      lines.push(`  ${key.padEnd(26)} ${report.reasons[key]}`);
    }
  }
  for (const step of report.steps ?? []) {
    const mark = step.editability === STEP_EDITABILITY.CONTROLLED ? 'CONTROLLED' : 'READ-ONLY';
    const why = step.reason ? ` (${step.reason})` : '';
    lines.push(`  ${mark.padEnd(11)} ${step.api ?? step.chain}${why}  @${step.line}:${step.column}`);
  }
  if (report.error) lines.push(`error       : ${report.error}`);
  return lines.join('\n');
}
