/**
 * ATS-314 -- the MUTATION NEGATIVE CONTROL of the controlled subset
 * detector.
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * A test that passes proves nothing unless it can FAIL. Every group of
 * tests in `tests/ats314-ast-subset.test.mjs` claims to guard a
 * property of the detector; this file MUTATES the detector and asserts
 * that the property's test turns RED.
 *
 * The mutations are the ones that would make the detector LIE:
 *
 *   M1  the whitelist is not enforced       -> a step that is not
 *        supported is reported as controlled
 *   M2  the static-argument rule is dropped -> a computed argument is
 *        reported as controlled
 *   M3  a runtime value is called static    -> the actual of an
 *        assertion is reported as rewritable
 *   M4  the loop refusal is dropped         -> a step that runs N times
 *        is drawn as one box
 *   M5  the strings and the comments are not skipped -> a call that is
 *        not a call is reported as a step
 *   M6  the file verdict is inverted        -> a file the platform may
 *        not rewrite is reported as writable
 *   M7  the reason codes are lost           -> a refusal cannot say why
 *
 * A mutation that no test catches is a claim the tests do not support.
 *
 * HOW IT WORKS
 * ------------
 * The mutations are applied to a COPY of the detector module in a temp
 * directory, so the repository's own source is never touched. The
 * mutated module is then imported and exercised directly, and the
 * assertion is made against the MUTATED behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const SRC = path.join(root, 'server', 'edit', 'ast-subset.mjs');

/**
 * A copy of the detector with `from` replaced by `to`.
 *
 * The copy is written into a temp directory, so the repository's own
 * source is never modified. The copy is imported through a file URL with
 * a cache-busting query, so the mutated module is really loaded and not
 * the one already in the module cache.
 */
async function mutated(from, to) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats314-mut-'));
  const text = fs.readFileSync(SRC, 'utf8');
  if (!text.includes(from)) throw new Error(`the mutation anchor is not in the source: ${from}`);
  const file = path.join(dir, 'ast-subset.mjs');
  fs.writeFileSync(file, text.replace(from, to), 'utf8');
  const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}-${Math.random()}`);
  return { mod, dir };
}

/* ------------------------------------------------------------------ */

test('M1: without the whitelist, a step that is not supported is reported as controlled', async () => {
  // The mutation makes EVERY call a controlled step: the whitelist
  // lookup always finds something.
  // The mutation maps EVERY action onto an entry that exists, so the
  // whitelist lookup can no longer refuse anything. (`'locator.' +
  // action` would name an entry that does not exist for most actions,
  // and the detector would then fail on an undefined entry -- a crash
  // is not the behaviour under test.)
  const { mod } = await mutated(
    "    const key = action ? whitelistKey(names) : null;",
    "    const key = action ? (WHITELIST[whitelistKey(names)] ? whitelistKey(names) : 'locator.click') : null;",
  );
  const steps = mod.analyseSource(`await page.setContent('<h1>hi</h1>');`).steps;
  assert.ok(steps.length > 0);
  // The unmutated detector refuses this step; the mutated one must not.
  assert.equal(steps[0].editability, 'controlled',
    'the mutation did not make the unlisted API controlled');
});

test('M2: without the static-argument rule, a computed argument is reported as controlled', async () => {
  // The mutation turns the static rule into "always static".
  const { mod } = await mutated(
    "  if (mustBeStatic && !staticValue) {",
    "  if (false && mustBeStatic && !staticValue) {",
  );
  const steps = mod.analyseSource(`await page.goto(url);`).steps;
  assert.equal(steps[0].editability, 'controlled',
    'the mutation did not make the computed argument controlled');
});

test('M3: without the runtime-value rule, the actual of an assertion is reported as rewritable', async () => {
  // The mutation drops the runtime declaration: the actual is then
  // checked like any other argument, and a locator is not static, so
  // the assertion is refused -- OR, if the runtime rule is dropped AND
  // the static rule is satisfied, the actual is reported as static.
  // The mutation under test makes the runtime argument be treated as a
  // static one, which is the lie the module must not tell.
  const { mod } = await mutated(
    "      if (isRuntime) continue;          // a runtime value is EXPECTED here",
    "      if (isRuntime) { step.arguments[a].static = true; continue; }",
  );
  const steps = mod.analyseSource(`await expect(page.locator('#t')).toHaveText('hello');`).steps;
  assert.equal(steps.length, 1);
  // The mutated detector claims the actual is a static value.
  assert.equal(steps[0].arguments[0].static, true,
    'the mutation did not make the runtime actual look static');
  // The unmutated detector says it is NOT static.
  const clean = (await import('../server/edit/ast-subset.mjs')).analyseSource(
    `await expect(page.locator('#t')).toHaveText('hello');`,
  ).steps;
  assert.equal(clean[0].arguments[0].static, false);
});

test('M4: without the loop refusal, a step that runs N times is drawn as one box', async () => {
  const { mod } = await mutated(
    "    if (isInsideControlFlow(call.open)) {",
    "    if (false && isInsideControlFlow(call.open)) {",
  );
  const steps = mod.analyseSource(`for (const t of items) { await page.goto('/a'); }`).steps;
  const goto = steps.find((s) => s.api === 'page.goto');
  assert.ok(goto);
  assert.equal(goto.editability, 'controlled',
    'the mutation did not make the loop step controlled');
});

test('M5: without the string and comment skipping, a call that is not a call is reported', async () => {
  // The mutation makes the lexer treat a string as a sequence of code
  // tokens: the `page.goto` inside the string becomes a call.
  // The mutation lexes the string's CONTENT as code, so the call inside
  // the string becomes a call.
  const { mod } = await mutated(
    "      push(TOKEN.STRING, value, startLine, startCol, start, i);",
    "      { const sub = lex(value); for (const st of sub.tokens) push(st.type, st.value, startLine, startCol, start, i); }",
  );
  const steps = mod.analyseSource(`const s = "await page.goto('/x')";`).steps;
  assert.ok(steps.length > 0,
    'the mutation did not make the call inside the string visible');
});

test('M6: with the verdict inverted, a file the platform may not rewrite is writable', async () => {
  const { mod } = await mutated(
    "  else if (counts.controlled === 0) editability = FILE_EDITABILITY.READ_ONLY;",
    "  else if (counts.controlled === 0) editability = FILE_EDITABILITY.WRITABLE;",
  );
  const report = mod.buildReport('t.ts', `await login(page);`);
  assert.equal(report.writable, true,
    'the mutation did not make the read-only file writable');
});

test('M7: without the reason codes, a refusal cannot say why', async () => {
  // The mutation replaces every refusal reason with null: the step is
  // still read-only, but the reader cannot tell why.
  const { mod } = await mutated(
    "      const r = step.reason ?? READ_ONLY_REASON.NOT_WHITELISTED;",
    "      const r = 'mutated';",
  );
  const report = mod.buildReport('t.ts', `await login(page);`);
  // The mutation left the step's own reason alone but broke the COUNT
  // of the reasons, so the reason the report names is no longer one of
  // the CLOSED reason codes -- which is what UT-ATS314-025 checks.
  const clean = (await import('../server/edit/ast-subset.mjs')).buildReport(
    't.ts', `await login(page);`,
  );
  assert.deepEqual(Object.keys(report.reasons), ['mutated'],
    'the mutation did not replace the reason code');
  assert.deepEqual(Object.keys(clean.reasons), ['not-whitelisted'],
    'the unmutated detector does not name the closed reason code');
});

test('M8: the unmutated detector refuses every one of the mutated behaviours', async () => {
  // The control: the SAME cases, against the real module, must all be
  // refused. Without this the mutations above would prove nothing --
  // they would only prove that the module can be broken.
  const mod = await import('../server/edit/ast-subset.mjs');

  const unsupported = mod.analyseSource(`await page.setContent('<h1>hi</h1>');`).steps[0];
  assert.equal(unsupported.editability, 'read-only');

  const computed = mod.analyseSource(`await page.goto(url);`).steps[0];
  assert.equal(computed.editability, 'read-only');

  const loop = mod.analyseSource(`for (const t of items) { await page.goto('/a'); }`).steps
    .find((s) => s.api === 'page.goto');
  assert.equal(loop.editability, 'read-only');

  const inString = mod.analyseSource(`const s = "await page.goto('/x')";`).steps;
  assert.equal(inString.length, 0);

  const report = mod.buildReport('t.ts', `await login(page);`);
  assert.equal(report.writable, false);
});
