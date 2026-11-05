/**
 * ATS-301 integration tests: Playwright and WebdriverIO through the SAME
 * discover / start / stop / collect API.
 *
 * This is the acceptance criterion of the task: "Playwright and WDIO go
 * through the same discovery, start, stop and collection API; unsupported
 * capabilities can be detected."
 *
 * These tests drive the REAL engines against a REAL browser:
 *   - examples/sample-playwright  (real @playwright/test + real Chromium)
 *   - examples/sample-wdio         (real @wdio/cli v10 + real Chrome)
 *
 * They are skipped (not failed) when the fixture's dependencies are not
 * installed, so a clean checkout still has a green test suite. The SKIP is
 * reported as a skipped test, never as a pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlaywrightAdapter } from '../server/adapters/playwright.mjs';
import { createWdioAdapter } from '../server/adapters/wdio.mjs';
import { negotiate, requireCapability } from '../server/adapters/contract.mjs';

const root = path.resolve(import.meta.dirname, '..');
const PW_FIXTURE = path.join(root, 'examples', 'sample-playwright');
const WDIO_FIXTURE = path.join(root, 'examples', 'sample-wdio');

const pwInstalled = fs.existsSync(path.join(PW_FIXTURE, 'node_modules', '@playwright', 'test', 'cli.js'));
const wdioInstalled = fs.existsSync(path.join(WDIO_FIXTURE, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats301-it-'));
const pwProject = { id: 'proj_pw_it', root: PW_FIXTURE };
const wdioProject = { id: 'proj_wdio_it', root: WDIO_FIXTURE };

/** Wait until the child process closes, then return its exit code. */
function waitForExit(child, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit in time')), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

test('IT-ADP-001: both engines expose the same four operations', () => {
  for (const adapter of [createPlaywrightAdapter(), createWdioAdapter()]) {
    for (const op of ['discover', 'start', 'stop', 'collect', 'capabilities']) {
      assert.equal(typeof adapter[op], 'function', `${adapter.kind}.${op} must exist`);
    }
    assert.equal(adapter.contractVersion, 1);
  }
});

test('IT-ADP-002: both engines return the same discover() shape', () => {
  const pw = createPlaywrightAdapter().discover(pwProject);
  const wdio = createWdioAdapter().discover(wdioProject);
  for (const d of [pw, wdio]) {
    assert.ok(Array.isArray(d.tests));
    assert.ok(Array.isArray(d.files));
    assert.equal(typeof d.warning, 'string');
    assert.equal(typeof d.runner, 'string');
  }
  assert.equal(pw.runner, 'playwright');
  assert.equal(wdio.runner, 'wdio');
  // Every discovered case carries the same field names.
  for (const t of [...pw.tests, ...wdio.tests]) {
    assert.ok(typeof t.id === 'string' && t.id.length > 0);
    assert.ok(typeof t.file === 'string');
    assert.ok(typeof t.title === 'string');
    assert.ok(typeof t.level === 'string');
  }
});

test('IT-ADP-003: the Playwright fixture is discovered', () => {
  const pw = createPlaywrightAdapter().discover(pwProject);
  assert.ok(pw.files.some((f) => f.includes('home.spec.ts')), JSON.stringify(pw.files));
  assert.equal(pw.tests.length, 2);
});

test('IT-ADP-004: the WDIO fixture is discovered', () => {
  const wdio = createWdioAdapter().discover(wdioProject);
  assert.equal(wdio.files.length, 2);
  assert.ok(wdio.files.some((f) => f.includes('pass.spec.js')));
  assert.ok(wdio.files.some((f) => f.includes('fail.spec.js')));
});

test('IT-ADP-005: negotiation over the real Playwright project proves the CLI options', { skip: !pwInstalled && 'examples/sample-playwright has no node_modules' }, () => {
  const a = createPlaywrightAdapter();
  const r = negotiate(a, pwProject, ['discover', 'start', 'stop', 'collect', 'structuredReport']);
  assert.equal(r.supported, true, JSON.stringify(r.missing, null, 2));
  const cli = r.capabilities.find((c) => c.name === 'cliContract');
  assert.equal(cli.supported, true);
  assert.ok(cli.detail.options.includes('reporter'));
  assert.ok(cli.detail.options.includes('output'));
});

test('IT-ADP-005B: the real Playwright CLI declares a positional test filter', { skip: !pwInstalled && 'examples/sample-playwright has no node_modules' }, () => {
  // The negotiation and the execution must AGREE. `start()` passes the test
  // file as a POSITIONAL argument, so `filterByFile` has to be reported as
  // supported -- otherwise the adapter would refuse a capability it uses on
  // every filtered run.
  const a = createPlaywrightAdapter();
  const cap = a.capabilities(pwProject).find((c) => c.name === 'filterByFile');
  assert.equal(cap.supported, true, JSON.stringify(cap, null, 2));
  // The reason must not survive on a supported capability.
  assert.equal(cap.reason, '');
  // The evidence must quote the SAME usage line the capability was derived
  // from -- a claim that is not backed by the probed text is not evidence.
  assert.match(cap.evidence, /positional argument/);
  assert.ok(cap.detail.usage.length > 0);
  assert.match(cap.evidence, new RegExp(cap.detail.usage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // The usage line really does declare the positional filter.
  assert.match(cap.detail.usage, /\[test-filter/i);

  // ...and asking for it as a REQUIREMENT must NOT raise.
  const r = requireCapability(a, pwProject, ['filterByFile']);
  assert.equal(r.supported, true);
  assert.equal(r.missing.length, 0);
});

test('IT-ADP-005C: the real Playwright run passes the filtered file as a positional argument', { skip: !pwInstalled && 'examples/sample-playwright has no node_modules' }, () => {
  // The claim "filterByFile is supported" is only honest if the file really
  // reaches the CLI as the positional argument. This asserts the argument
  // vector, which is what the execution actually uses.
  const a = createPlaywrightAdapter();
  const out = path.join(tmp, 'pw-positional');
  fs.mkdirSync(out, { recursive: true });
  const handle = a.start({ project: pwProject, run: {}, file: 'tests/home.spec.ts', outputDir: out });
  try {
    const last = handle.args[handle.args.length - 1];
    assert.equal(last, 'tests/home.spec.ts', JSON.stringify(handle.args));
    assert.ok(!handle.args.some((a2) => a2.startsWith('--file')), 'the file must not be passed as an option');
  } finally {
    handle.child.kill();
  }
});

test('IT-ADP-006: negotiation over the real WDIO project proves the reporter', { skip: !wdioInstalled && 'examples/sample-wdio has no node_modules' }, () => {
  const a = createWdioAdapter();
  const r = negotiate(a, wdioProject, ['discover', 'start', 'stop', 'collect', 'structuredReport']);
  assert.equal(r.supported, true, JSON.stringify(r.missing, null, 2));
});

test('IT-ADP-007: an unsupported capability is DETECTABLE, not an exception', { skip: !wdioInstalled && 'examples/sample-wdio has no node_modules' }, () => {
  const a = createWdioAdapter();
  // WDIO has no HTML reporter: the caller must be able to ask and get a
  // truthful "no, and here is why".
  const r = negotiate(a, wdioProject, ['htmlReport']);
  assert.equal(r.supported, false);
  assert.equal(r.missing[0].name, 'htmlReport');
  assert.match(r.missing[0].reason, /html-reporter does not exist/);

  // ...and asking for it as a REQUIREMENT raises a typed, mappable error.
  try {
    requireCapability(a, wdioProject, ['discover', 'htmlReport']);
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'CAPABILITY_UNSUPPORTED');
    assert.match(e.message, /htmlReport/);
  }
});

test('IT-ADP-008: Playwright start -> collect produces one PASS and one FAIL', { skip: !pwInstalled && 'examples/sample-playwright has no node_modules' }, async () => {
  const a = createPlaywrightAdapter();
  const out = path.join(tmp, 'pw-run');
  fs.mkdirSync(out, { recursive: true });
  const handle = a.start({ project: pwProject, run: {}, file: null, outputDir: out });
  const code = await waitForExit(handle.child);
  assert.equal(code, 1, 'a run with one failing case must exit non-zero');

  const collected = a.collect({ outputDir: out });
  assert.ok(collected, 'the adapter must collect a summary');
  const s = collected.summary;
  assert.equal(s.total, 2);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 1);
  assert.ok(s.cases.some((c) => c.status === 'passed'));
  assert.ok(s.cases.some((c) => c.status === 'failed'));
  // The artefacts the capabilities promised are really on disk.
  assert.ok(fs.existsSync(path.join(out, 'report.json')), 'report.json must exist');
  assert.ok(fs.existsSync(path.join(out, 'html', 'index.html')), 'the html report must exist');
  assert.ok(fs.existsSync(path.join(out, 'results')), 'the --output directory must exist');
});

test('IT-ADP-009: WDIO start -> collect produces one PASS and one FAIL', { skip: !wdioInstalled && 'examples/sample-wdio has no node_modules' }, async () => {
  const a = createWdioAdapter();
  const out = path.join(tmp, 'wdio-run');
  fs.mkdirSync(out, { recursive: true });
  const handle = a.start({ project: wdioProject, run: {}, file: null, outputDir: out });
  const code = await waitForExit(handle.child);
  assert.equal(code, 1, 'a run with one failing case must exit non-zero');

  const collected = a.collect({ outputDir: out });
  assert.ok(collected, 'the adapter must collect a summary');
  const s = collected.summary;
  assert.equal(s.total, 2, JSON.stringify(s, null, 2));
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 1);
  assert.match(s.browser, /chrome/);
  // The per-worker reporter files were merged into ONE summary.
  assert.ok(collected.reportFiles.length >= 1);
});

test('IT-ADP-010: both engines map their results onto the SAME model', { skip: (!pwInstalled || !wdioInstalled) && 'the fixtures have no node_modules' }, async () => {
  const out = { pw: path.join(tmp, 'cmp-pw'), wdio: path.join(tmp, 'cmp-wdio') };
  fs.mkdirSync(out.pw, { recursive: true });
  fs.mkdirSync(out.wdio, { recursive: true });

  const pw = createPlaywrightAdapter();
  const h1 = pw.start({ project: pwProject, run: {}, file: null, outputDir: out.pw });
  await waitForExit(h1.child);
  const s1 = pw.collect({ outputDir: out.pw }).summary;

  const wdio = createWdioAdapter();
  const h2 = wdio.start({ project: wdioProject, run: {}, file: null, outputDir: out.wdio });
  await waitForExit(h2.child);
  const s2 = wdio.collect({ outputDir: out.wdio }).summary;

  // The same fields, the same counts, from two different engines.
  assert.deepEqual(
    Object.keys(s1).filter((k) => ['passed', 'failed', 'skipped', 'flaky', 'total'].includes(k)).sort(),
    Object.keys(s2).filter((k) => ['passed', 'failed', 'skipped', 'flaky', 'total'].includes(k)).sort(),
  );
  assert.equal(s1.total, s2.total);
  assert.equal(s1.passed, s2.passed);
  assert.equal(s1.failed, s2.failed);
  for (const c of [...s1.cases, ...s2.cases]) {
    assert.ok(['passed', 'failed', 'skipped', 'flaky', 'unknown'].includes(c.status));
    assert.ok(typeof c.title === 'string');
    assert.ok(typeof c.duration === 'number');
    assert.ok(typeof c.error === 'string');
  }
});

/**
 * Assert that stop() really terminated an in-flight run.
 *
 * The assertion has to be FALSIFIABLE: an earlier version of this test only
 * checked "the exit code is not 0", which is constant for these fixtures
 * (each contains a deliberately failing case), so a stop() that did nothing
 * still passed. Two independent, falsifiable facts are asserted here:
 *
 *   1. the stopped run did NOT complete all cases -- the engine was killed
 *      before it could produce a full report;
 *   2. the stopped run finished measurably faster than the same run left
 *      alone.
 *
 * Fact 1 is checked against the case count the fixture has (2). Fact 2 is
 * checked against a natural baseline measured in the SAME test, so the
 * threshold follows the machine instead of a magic number.
 */
async function assertStopTerminates(adapter, project, label, { settleMs = 500 } = {}) {
  // --- baseline: the same run, left alone --------------------------------
  const naturalOut = path.join(tmp, `${label}-natural`);
  fs.mkdirSync(naturalOut, { recursive: true });
  const t0 = Date.now();
  const natural = adapter.start({ project, run: {}, file: null, outputDir: naturalOut });
  const naturalCode = await waitForExit(natural.child);
  const naturalMs = Date.now() - t0;
  const naturalCollected = adapter.collect({ outputDir: naturalOut });
  assert.ok(naturalCollected, `${label}: the natural run must produce a report`);
  const naturalTotal = naturalCollected.summary.total;
  assert.ok(naturalTotal > 0, `${label}: the natural run must report at least one case`);

  // --- the run under test: stopped while in flight ----------------------
  const stoppedOut = path.join(tmp, `${label}-stopped`);
  fs.mkdirSync(stoppedOut, { recursive: true });
  const t1 = Date.now();
  const handle = adapter.start({ project, run: {}, file: null, outputDir: stoppedOut });
  assert.ok(handle.pid > 0, `${label}: the run must have a pid`);
  // Let the engine actually get going, then stop it mid-flight.
  await new Promise((r) => setTimeout(r, settleMs));
  adapter.stop(handle);
  await waitForExit(handle.child, 30000);
  const stoppedMs = Date.now() - t1;

  // FACT 1: the stopped run did not complete all cases.
  const stoppedCollected = adapter.collect({ outputDir: stoppedOut });
  const stoppedTotal = stoppedCollected ? stoppedCollected.summary.total : 0;
  assert.ok(
    stoppedTotal < naturalTotal,
    `${label}: a stopped run must not complete all cases (stopped=${stoppedTotal}, natural=${naturalTotal})`,
  );

  // FACT 2: the stopped run finished measurably faster than the natural one.
  assert.ok(
    stoppedMs < naturalMs,
    `${label}: a stopped run must be faster than a natural run (stopped=${stoppedMs}ms, natural=${naturalMs}ms)`,
  );

  return { naturalMs, stoppedMs, naturalTotal, stoppedTotal, naturalCode };
}

test('IT-ADP-011: stop() terminates a Playwright run that is in flight', { skip: !pwInstalled && 'examples/sample-playwright has no node_modules' }, async () => {
  const a = createPlaywrightAdapter();
  const r = await assertStopTerminates(a, pwProject, 'pw-stop');
  assert.ok(r.stoppedTotal < r.naturalTotal, JSON.stringify(r));
});

test('IT-ADP-011B: stop() terminates a WebdriverIO run that is in flight', { skip: !wdioInstalled && 'examples/sample-wdio has no node_modules' }, async () => {
  const a = createWdioAdapter();
  const r = await assertStopTerminates(a, wdioProject, 'wdio-stop');
  assert.ok(r.stoppedTotal < r.naturalTotal, JSON.stringify(r));
});

test('IT-ADP-CLEANUP: removes the generated fixture', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(fs.existsSync(tmp), false);
});
