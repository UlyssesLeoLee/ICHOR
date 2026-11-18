/**
 * ATS-314 -- the CONTROLLED STEP SUBSET DETECTOR: the unit tests.
 *
 * WHAT IS UNDER TEST
 * ------------------
 * The acceptance criterion of ATS-314 has two halves, and each half has
 * its own group of tests here:
 *
 *   1. 「仅支持白名单 API/静态参数」 -- only the whitelisted APIs with
 *      static arguments are supported. UT-ATS314-0xx covers the
 *      whitelist, the argument rule and the reason codes.
 *
 *   2. 「任意复杂 TS 强制只读回退」 -- any complex TypeScript falls back
 *      to READ-ONLY. UT-ATS314-1xx covers the fallback: the things a
 *      REGEX-based detector gets wrong (a call inside a string, a call
 *      inside a comment, a call nested in another call) and the
 *      things a careless detector gets wrong (a loop drawn as one box).
 *
 * WHY THE FIXTURES ARE BUILT, NOT READ
 * -------------------------------------
 * The fixtures are BUILT here: a test that reads the real repository
 * measures the repository, not the code. One test does read the real
 * fixture (`examples/sample-playwright/tests/home.spec.ts`), because
 * 「the real fixture is classified as PARTIAL, and the two assertions in
 * it are controlled」 is a property of the DATA.
 *
 * THE TEST IDS
 * ------------
 *   UT-ATS314-0xx  the whitelist and the static-argument rule
 *   UT-ATS314-1xx  the read-only fallback and its reason codes
 *   UT-ATS314-2xx  the file verdict and the report
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  AST_SUBSET_VERSION, CONTAINER_CALLS, FILE_EDITABILITY, LOCATOR_FACTORIES,
  READ_ONLY_REASON, STEP_EDITABILITY, WHITELIST,
  analyseSource, buildReport, controlledSteps, formatSubsetReport, isStaticRange,
  lex, readOnlySteps,
} from '../server/edit/ast-subset.mjs';

const root = path.resolve(import.meta.dirname, '..');

/**
 * The steps of a source, by API name.
 *
 * A test that says 「there is a `page.goto` step」 should not have to
 * care in which order the steps came out.
 */
function stepsOf(source) {
  return analyseSource(source).steps;
}

/** The one controlled step of a source (the assertion fails if there is not exactly one). */
function onlyControlled(source) {
  const controlled = analyseSource(source).steps.filter(
    (s) => s.editability === STEP_EDITABILITY.CONTROLLED,
  );
  assert.equal(controlled.length, 1, `expected exactly one controlled step, got ${controlled.length}`);
  return controlled[0];
}

/* ------------------------------------------------------------------ */
/* 0xx -- the whitelist and the static-argument rule                  */
/* ------------------------------------------------------------------ */

test('UT-ATS314-001: the whitelist is closed and every entry declares its rule', () => {
  // An entry without a kind, an arity or a doc is an entry a consumer
  // cannot use: the UI needs the kind to pick an icon, and the arity
  // to check the call.
  for (const [key, entry] of Object.entries(WHITELIST)) {
    assert.ok(entry.kind, `${key} has no kind`);
    assert.ok(Array.isArray(entry.arity) && entry.arity.length, `${key} has no arity`);
    assert.ok(entry.doc, `${key} has no doc`);
    assert.equal(entry.api, key, `${key} does not name itself`);
    // The offset says where the call's own arguments start in the
    // COMBINED index space the whitelist's indices live in.
    assert.ok(entry.combinedOffset === 0 || entry.combinedOffset === 1,
      `${key} has an offset of ${entry.combinedOffset}, expected 0 or 1`);
    // Every static index must be REACHABLE, translated back into the
    // CALL's own index space. The arity holds the COUNTS of arguments
    // the call may have (`[1, 2]` means one or two), so the last
    // reachable index is the largest count minus one.
    const maxArgs = Math.max(...entry.arity);
    for (const i of entry.staticArgs ?? []) {
      const callIndex = i - entry.combinedOffset;
      assert.ok(callIndex >= 0 && callIndex < maxArgs,
        `${key} requires argument ${i} to be static, but the call takes at ` +
        `most ${maxArgs} argument(s) and its offset is ${entry.combinedOffset}`);
    }
    // A runtime argument must NOT also be a static one: an argument
    // cannot be required to be static and expected to be a runtime
    // value at the same time.
    for (const i of entry.runtimeArgs ?? []) {
      assert.ok(!(entry.staticArgs ?? []).includes(i),
        `${key} declares argument ${i} both static and runtime`);
    }
    // A runtime argument must be inside the combined list, and a
    // matcher always has the actual in slot 0.
    if ((entry.runtimeArgs ?? []).length) {
      assert.equal(entry.combinedOffset, 1,
        `${key} has a runtime argument, so it must be a matcher`);
    }
  }
});

test('UT-ATS314-002: a whitelisted API with a static argument is a controlled step', () => {
  const step = onlyControlled(`await page.goto('/login');`);
  assert.equal(step.api, 'page.goto');
  assert.equal(step.kind, 'navigate');
  assert.equal(step.reason, null);
  assert.equal(step.editability, STEP_EDITABILITY.CONTROLLED);
  assert.equal(step.arguments[0].text, "'/login'");
});

test('UT-ATS314-003: an argument that is a NAME is not static', () => {
  // 「静态参数」 means the TEXT is known without running the program.
  // A name is not known: the platform has no way to prove that `url`
  // holds a constant, so it does not assume one.
  const step = stepsOf(`await page.goto(url);`)[0];
  assert.equal(step.editability, STEP_EDITABILITY.READ_ONLY);
  assert.equal(step.reason, READ_ONLY_REASON.ARGUMENT_NOT_STATIC);
  assert.equal(step.arguments[0].static, false);
});

test('UT-ATS314-004: a template literal without an interpolation IS static', () => {
  const step = onlyControlled('await page.goto(`/login`);');
  assert.equal(step.editability, STEP_EDITABILITY.CONTROLLED);
});

test('UT-ATS314-005: a template literal WITH an interpolation is NOT static', () => {
  const step = stepsOf('await page.goto(`/login/${id}`);')[0];
  assert.equal(step.editability, STEP_EDITABILITY.READ_ONLY);
  assert.equal(step.reason, READ_ONLY_REASON.ARGUMENT_NOT_STATIC);
});

test('UT-ATS314-006: the literal values are static', () => {
  for (const src of [
    `await page.goto('/x');`,
    `await page.locator('#x').fill(42);`,
    `await page.locator('#x').fill(true);`,
    `await page.locator('#x').fill(null);`,
    `await page.locator('#x').fill(undefined);`,
  ]) {
    const step = stepsOf(src)[0];
    assert.equal(step.editability, STEP_EDITABILITY.CONTROLLED, `${src} should be controlled`);
  }
});

test('UT-ATS314-007: an options object is static only when every value is', () => {
  const good = onlyControlled(`await page.locator('#x').click({ timeout: 5000 });`);
  assert.equal(good.editability, STEP_EDITABILITY.CONTROLLED);

  const bad = stepsOf(`await page.locator('#x').click({ timeout: cfg.timeout });`)[0];
  assert.equal(bad.editability, STEP_EDITABILITY.READ_ONLY);
  assert.equal(bad.reason, READ_ONLY_REASON.ARGUMENT_NOT_STATIC);
});

test('UT-ATS314-008: an options object with a SHORTHAND is not static', () => {
  // `{ timeout }` is a shorthand for `{ timeout: timeout }`, and a name
  // is not a static value.
  const step = stepsOf(`await page.locator('#x').click({ timeout });`)[0];
  assert.equal(step.editability, STEP_EDITABILITY.READ_ONLY);
  assert.equal(step.reason, READ_ONLY_REASON.ARGUMENT_NOT_STATIC);
});

test('UT-ATS314-009: an options object with a SPREAD is not static', () => {
  const step = stepsOf(`await page.locator('#x').click({ ...base });`)[0];
  assert.equal(step.editability, STEP_EDITABILITY.READ_ONLY);
  assert.equal(step.reason, READ_ONLY_REASON.ARGUMENT_NOT_STATIC);
});

test('UT-ATS314-010: the locator of a step is a separate space and must be static too', () => {
  const good = onlyControlled(`await page.getByRole('button', { name: 'Go' }).click();`);
  assert.equal(good.api, 'locator.click');
  // The locator's two arguments (the role and the options) are reported
  // in the locator's own space, not in the action's.
  assert.equal(good.locatorArguments.length, 2);
  assert.ok(good.locatorArguments.every((a) => a.static));

  const bad = stepsOf(`await page.getByRole(role).click();`)[0];
  assert.equal(bad.editability, STEP_EDITABILITY.READ_ONLY);
  assert.equal(bad.reason, READ_ONLY_REASON.ARGUMENT_NOT_STATIC);
  assert.equal(bad.locatorArguments[0].static, false);
});

test('UT-ATS314-011: an assertion is controlled, and its actual is a runtime value', () => {
  const step = onlyControlled(`await expect(page.locator('#t')).toHaveText('hello');`);
  assert.equal(step.api, 'expect.toHaveText');
  assert.equal(step.kind, 'assertion');
  // The ACTUAL is computed at run time by definition: the platform may
  // not rewrite it, and the detector must not claim it is static.
  assert.equal(step.arguments[0].runtime, true);
  assert.equal(step.arguments[0].static, false);
  // The EXPECTED side is static.
  assert.equal(step.arguments[1].static, true);
});

test('UT-ATS314-012: the assertion matcher is not a separate step from its actual', () => {
  // `expect(page.locator('#t'))` is the ACTUAL of the assertion, not a
  // step of its own. Two steps would mean the platform would try to
  // rewrite the locator AND the assertion.
  const steps = stepsOf(`await expect(page.locator('#t')).toHaveText('hello');`);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].api, 'expect.toHaveText');
});

test('UT-ATS314-013: a step inside a callback is a step of its own', () => {
  // The body of a `test.step` holds the steps the flow is made of.
  const steps = stepsOf(`await test.step('do a thing', async () => { await page.goto('/a'); });`);
  const apis = steps.map((s) => s.api).sort();
  assert.deepEqual(apis, ['page.goto', 'test.step']);
  const goto = steps.find((s) => s.api === 'page.goto');
  assert.equal(goto.nesting, 1, 'the goto is nested in one callback');
});

test('UT-ATS314-014: a call that is not whitelisted is read-only with its name', () => {
  const step = stepsOf(`await page.setContent('<h1>hi</h1>');`)[0];
  assert.equal(step.editability, STEP_EDITABILITY.READ_ONLY);
  assert.equal(step.reason, READ_ONLY_REASON.NOT_WHITELISTED);
  // The reader must be able to see WHICH api was refused.
  assert.equal(step.chain, 'page.setContent');
});

test('UT-ATS314-015: a helper call is not a controlled step, and the platform does not guess', () => {
  // `login(page)` may be `page.fill(...)` inside. The platform cannot
  // know, so it refuses -- and it does not rewrite the name into
  // something it recognises.
  const step = stepsOf(`await login(page);`)[0];
  assert.equal(step.editability, STEP_EDITABILITY.READ_ONLY);
  assert.equal(step.reason, READ_ONLY_REASON.NOT_WHITELISTED);
  assert.equal(step.api, null);
});

test('UT-ATS314-016: a call with an undeclared number of arguments is refused', () => {
  // `page.goto` takes one or two arguments. A third is a call shape the
  // detector does not recognise, and an unrecognised shape must not be
  // claimed as controlled.
  const step = stepsOf(`await page.goto('/a', {}, 'extra');`)[0];
  assert.equal(step.editability, STEP_EDITABILITY.READ_ONLY);
  assert.equal(step.reason, READ_ONLY_REASON.ARITY_NOT_SUPPORTED);
});

test('UT-ATS314-017: the locator factories are a closed list', () => {
  // The locator chain is what says which element the step acts on, so
  // the factories the detector recognises are declared in one place.
  assert.ok(LOCATOR_FACTORIES.includes('getByRole'));
  assert.ok(LOCATOR_FACTORIES.includes('locator'));
  assert.ok(LOCATOR_FACTORIES.includes('getByTestId'));
  // A name that is not on the list is not a locator factory, and the
  // detector does not treat it as one.
  assert.ok(!LOCATOR_FACTORIES.includes('querySelector'));
});

/* ------------------------------------------------------------------ */
/* 1xx -- the read-only fallback                                       */
/* ------------------------------------------------------------------ */

test('UT-ATS314-020: a call inside a STRING is not a call', () => {
  // A regex-based detector would find `page.goto` in here and report a
  // step that does not exist.
  const steps = stepsOf(`const s = "await page.goto('/x')";`);
  assert.equal(steps.length, 0);
});

test('UT-ATS314-021: a call inside a COMMENT is not a call', () => {
  const steps = stepsOf([
    '// await page.goto(\'/x\');',
    '/* await page.locator(\'#y\').click(); */',
    "await page.goto('/real');",
  ].join('\n'));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].api, 'page.goto');
});

test('UT-ATS314-022: a step inside a LOOP is refused, because a loop is not one box', () => {
  // The loop decides at run time how many times the step runs. Drawing
  // it as ONE box would claim 「one click」 where the code says 「click
  // once per item」.
  const step = stepsOf(`for (const t of items) { await page.goto('/a'); }`)[0];
  assert.equal(step.editability, STEP_EDITABILITY.READ_ONLY);
  assert.equal(step.reason, READ_ONLY_REASON.INSIDE_CONTROL_FLOW);
});

test('UT-ATS314-023: a step inside a WHILE loop is refused too', () => {
  // The loop's CONDITION is a call too, and it is reported as an
  // ordinary not-whitelisted step: it is not inside the loop's body, so
  // the loop's reason does not apply to it.
  const steps = stepsOf(`while (hasMore()) { await page.goto('/a'); }`);
  const goto = steps.find((s) => s.api === 'page.goto');
  assert.ok(goto, 'the goto inside the loop was not found');
  assert.equal(goto.reason, READ_ONLY_REASON.INSIDE_CONTROL_FLOW);
});

test('UT-ATS314-024: a nested call with a nested parenthesis is classified by its INNER value', () => {
  // `page.goto(getUrl('a'))` -- the argument is a CALL, so it is not
  // static, whatever the brackets do.
  const step = stepsOf(`await page.goto(getUrl('a', 'b'));`)[0];
  assert.equal(step.editability, STEP_EDITABILITY.READ_ONLY);
  assert.equal(step.reason, READ_ONLY_REASON.ARGUMENT_NOT_STATIC);
});

test('UT-ATS314-025: the reason codes are a closed set', () => {
  // A reason code is what the UI shows the reader. An open set would
  // let the reason drift into prose.
  const known = new Set(Object.values(READ_ONLY_REASON));
  const src = `
    await page.goto(url);
    await page.goto('/a', {}, 'x');
    for (const t of items) { await page.goto('/a'); }
    await login(page);
  `;
  for (const step of stepsOf(src)) {
    // A CONTROLLED step carries NO reason: there is nothing to refuse.
    if (step.editability === STEP_EDITABILITY.CONTROLLED) {
      assert.equal(step.reason, null);
      continue;
    }
    assert.ok(known.has(step.reason), `unknown reason ${step.reason}`);
  }
});

test('UT-ATS314-026: every read-only step carries a reason', () => {
  // A refusal without a reason is a refusal the reader cannot act on.
  const src = `
    await login(page);
    await page.goto(url);
    for (const t of items) { await page.goto('/a'); }
  `;
  for (const step of readOnlySteps(buildReport('t.ts', src))) {
    assert.ok(step.reason, 'a read-only step has no reason');
    assert.ok(Object.values(READ_ONLY_REASON).includes(step.reason),
      `unknown reason ${step.reason}`);
  }
});

test('UT-ATS314-027: a read-only step is NOT an error', () => {
  // A test that uses a helper is perfectly good test code. The platform
  // may not rewrite it, and it must not cry wolf about it either.
  const report = buildReport('t.ts', `await login(page);`);
  assert.equal(report.error, null);
  assert.equal(report.counts.readOnly, 1);
  assert.equal(report.counts.controlled, 0);
});

test('UT-ATS314-028: a file that cannot be lexed is reported as such, not as "no steps"', () => {
  // An unterminated template literal means the file is not readable.
  // 「this file has no controlled steps」 would be a DIFFERENT and wrong
  // answer.
  const report = buildReport('t.ts', 'const s = `unterminated');
  assert.equal(report.error, 'unterminated template literal');
  assert.equal(report.editability, FILE_EDITABILITY.READ_ONLY);
  assert.equal(report.counts.total, 0);
  assert.equal(report.reasons[READ_ONLY_REASON.UNPARSEABLE], 1);
});

test('UT-ATS314-029: a file that cannot be READ says so', () => {
  const report = buildReport(path.join(root, 'does', 'not', 'exist.ts'));
  assert.ok(report.error, 'a missing file has no error');
  assert.equal(report.editability, FILE_EDITABILITY.READ_ONLY);
});

test('UT-ATS314-030: the control flow refusal does not hide the argument verdict', () => {
  // The refusal must carry the WHOLE truth: a non-static argument
  // inside a loop is reported as a non-static argument (the more
  // specific reason), and the loop is only the reason when the
  // arguments were fine.
  const step = stepsOf(`for (const t of items) { await page.goto(t); }`)[0];
  assert.equal(step.reason, READ_ONLY_REASON.ARGUMENT_NOT_STATIC);
});

test('UT-ATS314-032: a step inside a LOCALLY DECLARED FUNCTION is refused', () => {
  // The function may be called from several places, so the platform may
  // not move a step out of it.
  const step = stepsOf(`async function helper() { await page.goto('/a'); }`)
    .find((s) => s.api === 'page.goto');
  assert.ok(step, 'the goto inside the helper was not found');
  assert.equal(step.editability, STEP_EDITABILITY.READ_ONLY);
  assert.equal(step.reason, READ_ONLY_REASON.INSIDE_LOCAL_FUNCTION);
});

test('UT-ATS314-033: a step inside an ARROW FUNCTION bound to a name is refused too', () => {
  const step = stepsOf(`const helper = async () => { await page.goto('/a'); };`)
    .find((s) => s.api === 'page.goto');
  assert.ok(step, 'the goto inside the arrow function was not found');
  assert.equal(step.reason, READ_ONLY_REASON.INSIDE_LOCAL_FUNCTION);
});

test('UT-ATS314-034: a step inside a CALLBACK is NOT inside a local function', () => {
  // The callback of a `test(...)` holds exactly the steps the flow is
  // made of. Refusing them would refuse the whole product.
  const steps = stepsOf(`test('a case', async ({ page }) => { await page.goto('/a'); });`);
  const goto = steps.find((s) => s.api === 'page.goto');
  assert.ok(goto);
  assert.equal(goto.editability, STEP_EDITABILITY.CONTROLLED);
});

test('UT-ATS314-035: a step inside a loop inside a function is refused for the loop', () => {
  // The more specific reason wins: the loop is what makes the step
  // unmoveable, and the reason the reader sees is the one that tells
  // them what to do about it.
  const step = stepsOf(`function helper(items) { for (const t of items) { await page.goto('/a'); } }`)
    .find((s) => s.api === 'page.goto');
  assert.ok(step);
  assert.equal(step.reason, READ_ONLY_REASON.INSIDE_CONTROL_FLOW);
});

test('UT-ATS314-031: a call inside a function is still FOUND, and it is refused', () => {
  // The detector must not lose a step just because it is inside a
  // named function: it is reported as a step of its own, with the
  // reason that says why it may not be moved.
  const steps = stepsOf(`async function helper() { await page.goto('/a'); }`);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].api, 'page.goto');
  assert.equal(steps[0].editability, STEP_EDITABILITY.READ_ONLY);
});

/* ------------------------------------------------------------------ */
/* 2xx -- the file verdict and the report                              */
/* ------------------------------------------------------------------ */

test('UT-ATS314-040: a file whose every step is controlled is WRITABLE', () => {
  const report = buildReport('t.ts', `
    await page.goto('/a');
    await page.locator('#name').fill('Bob');
    await expect(page.locator('#t')).toHaveText('hello');
  `);
  assert.equal(report.editability, FILE_EDITABILITY.WRITABLE);
  assert.equal(report.writable, true);
  assert.equal(report.counts.controlled, 3);
  assert.equal(report.counts.readOnly, 0);
});

test('UT-ATS314-041: a file with some controlled steps is PARTIAL, and NOT writable', () => {
  // The platform may not rewrite a file whose steps it does not fully
  // understand: `writable` is false even though some steps ARE
  // controlled.
  const report = buildReport('t.ts', `
    await page.goto('/a');
    await page.setContent('<h1>hi</h1>');
  `);
  assert.equal(report.editability, FILE_EDITABILITY.PARTIAL);
  assert.equal(report.writable, false);
  assert.equal(report.counts.controlled, 1);
  assert.equal(report.counts.readOnly, 1);
});

test('UT-ATS314-042: a file whose steps are all read-only is READ-ONLY', () => {
  const report = buildReport('t.ts', `
    await login(page);
    await page.setContent('<h1>hi</h1>');
  `);
  assert.equal(report.editability, FILE_EDITABILITY.READ_ONLY);
  assert.equal(report.writable, false);
  assert.equal(report.counts.controlled, 0);
});

test('UT-ATS314-043: a file with no steps at all is READ-ONLY', () => {
  // An empty file is not a file the platform may rewrite: there is
  // nothing to rewrite and nothing it understands.
  const report = buildReport('t.ts', `const x = 1;`);
  assert.equal(report.editability, FILE_EDITABILITY.READ_ONLY);
  assert.equal(report.counts.total, 0);
});

test('UT-ATS314-044: the counts of the report cover every step EXACTLY once', () => {
  const src = `
    await page.goto('/a');
    await page.locator('#x').fill('v');
    await login(page);
    await expect(page.locator('#t')).toHaveText('hello');
    await page.setContent('<h1>hi</h1>');
  `;
  const report = buildReport('t.ts', src);
  assert.equal(report.counts.total, report.steps.length);
  assert.equal(report.counts.controlled + report.counts.readOnly, report.counts.total);
  assert.equal(report.counts.controlled, controlledSteps(report).length);
  assert.equal(report.counts.readOnly, readOnlySteps(report).length);
  // And the reason counts add up to the read-only count.
  const reasonTotal = Object.values(report.reasons).reduce((a, b) => a + b, 0);
  assert.equal(reasonTotal, report.counts.readOnly);
});

test('UT-ATS314-045: the analysis is a pure function of the source', () => {
  // The same file must always produce the same answer, or the platform
  // cannot diff two analyses.
  const src = `await page.goto('/a'); await page.locator('#x').fill('v');`;
  const a = buildReport('t.ts', src);
  const b = buildReport('t.ts', src);
  assert.deepEqual(a, b);
});

test('UT-ATS314-046: the case declarations are containers, not steps', () => {
  // `test('x', cb)` is the CASE the flow belongs to. Reporting it as a
  // step would be a category error.
  const report = buildReport('t.ts', `
    test('the first case', async ({ page }) => { await page.goto('/a'); });
    test('the second case', async ({ page }) => { await page.goto('/b'); });
  `);
  assert.equal(report.steps.length, 2);
  assert.ok(report.steps.every((s) => s.api === 'page.goto'));
  assert.equal(report.containers.length, 2);
  assert.equal(report.containers[0].kind, 'test');
  assert.equal(report.containers[0].title, "'the first case'");
  assert.equal(report.containers[0].titleIsStatic, true);
  assert.ok(CONTAINER_CALLS.includes('test'));
});

test('UT-ATS314-047: a `test.step` is a GROUP, not a container', () => {
  // The group IS a step on the whitelist, and it holds other steps.
  const report = buildReport('t.ts', `
    test('a case', async ({ page }) => {
      await test.step('the first thing', async () => { await page.goto('/a'); });
    });
  `);
  const apis = report.steps.map((s) => s.api).sort();
  assert.deepEqual(apis, ['page.goto', 'test.step']);
  assert.equal(report.containers.length, 1);
});

test('UT-ATS314-048: the report names the version it was produced by', () => {
  const report = buildReport('t.ts', `await page.goto('/a');`);
  assert.equal(report.version, AST_SUBSET_VERSION);
});

test('UT-ATS314-049: the readable summary quotes the counts the report holds', () => {
  const report = buildReport('t.ts', `
    await page.goto('/a');
    await login(page);
  `);
  const text = formatSubsetReport(report);
  assert.ok(text.includes('writable    : false'), text);
  assert.ok(text.includes('2 total / 1 controlled / 1 read-only'), text);
  // And it names the reason of the refusal.
  assert.ok(text.includes(READ_ONLY_REASON.NOT_WHITELISTED), text);
});

test('UT-ATS314-050: the readable summary of an unreadable file says so', () => {
  const report = buildReport(path.join(root, 'does', 'not', 'exist.ts'));
  const text = formatSubsetReport(report);
  assert.ok(text.includes('error       :'), text);
});

test('UT-ATS314-051: the lexer tells a string from a code token', () => {
  const { tokens } = lex(`const a = 'x'; // comment`);
  const kinds = tokens.map((t) => t.type);
  assert.ok(!kinds.includes('punct') || tokens.every((t) => t.value !== '//'));
  // The comment is not a token at all.
  assert.equal(tokens.filter((t) => t.value === 'comment').length, 0);
  assert.equal(tokens.filter((t) => t.type === 'string').length, 1);
});

test('UT-ATS314-052: the lexer records the position of every token', () => {
  const { tokens } = lex('const a = 1;\nconst b = 2;');
  const b = tokens.find((t) => t.value === 'b');
  assert.equal(b.line, 2, 'the second line is line 2');
});

test('UT-ATS314-053: the static rule is a pure function of the tokens', () => {
  const literal = lex(`'a'`);
  assert.equal(isStaticRange(literal.tokens, 0, 1), true);
  const name = lex(`name`);
  assert.equal(isStaticRange(name.tokens, 0, 1), false);
});

test('UT-ATS314-054: the REAL fixture is classified, and its assertions are controlled', () => {
  // The real fixture is a property of the DATA, so this test reads it.
  const fixture = path.join(root, 'examples', 'sample-playwright', 'tests', 'home.spec.ts');
  assert.ok(fs.existsSync(fixture), 'the fixture is gone');
  const report = buildReport(fixture);
  assert.equal(report.editability, FILE_EDITABILITY.PARTIAL);
  assert.equal(report.writable, false);
  // The two assertions are controlled.
  assert.equal(report.counts.controlled, 2);
  assert.ok(report.steps.filter((s) => s.api === 'expect.toHaveText').length === 2);
  // `page.setContent` is not on the whitelist, and it is reported as
  // such rather than silently accepted.
  assert.equal(report.reasons[READ_ONLY_REASON.NOT_WHITELISTED], 2);
  // The two cases are containers.
  assert.equal(report.containers.length, 2);
});
