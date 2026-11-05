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

test('IT-ADP-011: stop() terminates a run that is in flight', { skip: !pwInstalled && 'examples/sample-playwright has no node_modules' }, async () => {
  // A run that is cancelled must not keep the engine alive.
  const a = createPlaywrightAdapter();
  const out = path.join(tmp, 'pw-cancel');
  fs.mkdirSync(out, { recursive: true });
  const handle = a.start({ project: pwProject, run: {}, file: null, outputDir: out });
  assert.ok(handle.pid > 0);
  a.stop(handle);
  const code = await waitForExit(handle.child, 30000);
  assert.notEqual(code, 0, 'a cancelled run must not report success');
});

test('IT-ADP-CLEANUP: removes the generated fixture', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(fs.existsSync(tmp), false);
});
