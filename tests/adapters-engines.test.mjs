/**
 * ATS-301 unit tests: the two concrete adapters and the registry.
 *
 * These tests do NOT start an engine. They use fixture projects whose local
 * CLI is a small script that prints a chosen --help text, so the adapter's
 * PROBING logic can be tested deterministically.
 *
 * The end-to-end behaviour against the real engines is covered by
 * tests/adapters-it.test.mjs (which needs a real browser).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlaywrightAdapter, FALLBACK_PLAYWRIGHT_OPTIONS } from '../server/adapters/playwright.mjs';
import { createWdioAdapter, mapWdioStatus, mergeWdioReports, parseWdioReport, fileUrlToRelative, buildWdioConfigText } from '../server/adapters/wdio.mjs';
import {
  capabilityMatrix,
  getAdapter,
  listRunners,
  selectAdapter,
  selectAdapterOrThrow,
} from '../server/adapters/registry.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats301-adp-'));

/** Create a project whose local CLI prints `help` for `--help`. */
function makeProject(name, cliRelPath, helpText, extra = {}) {
  const root = path.join(dir, name);
  const cli = path.join(root, cliRelPath);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, `console.log(${JSON.stringify(helpText)});\n`);
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return { id: `proj_${name}`, root, ...extra };
}

const PLAYWRIGHT_HELP = [
  'Usage: npx playwright test [options] [test-filter...]',
  '',
  'Options:',
  '  --output <dir>       Folder for output artifacts',
  '  --reporter <r>      Reporter to use, comma-separated',
  '  --trace <mode>      Force tracing mode',
  '  --workers <w>       Number of concurrent workers',
].join('\n');

const WDIO_HELP = [
  'wdio.js run <configPath>',
  '',
  'Options:',
  '      --spec         run only a certain spec file or wildcard',
  '      --bail         stop test runner after specific amount of tests',
  '  -h, --help         Show help',
].join('\n');

const pwProject = makeProject('pw', 'node_modules/@playwright/test/cli.js', PLAYWRIGHT_HELP);
const wdioProject = makeProject('wdio', 'node_modules/@wdio/cli/bin/wdio.js', WDIO_HELP);
// A WDIO project that also has the reporter packages installed.
fs.mkdirSync(path.join(wdioProject.root, 'node_modules', '@wdio', 'json-reporter'), { recursive: true });
fs.writeFileSync(path.join(wdioProject.root, 'node_modules', '@wdio', 'json-reporter', 'package.json'), JSON.stringify({ version: '10.1.0' }));
fs.mkdirSync(path.join(wdioProject.root, 'node_modules', '@wdio', 'local-runner'), { recursive: true });
fs.writeFileSync(path.join(wdioProject.root, 'node_modules', '@wdio', 'local-runner', 'package.json'), JSON.stringify({ version: '10.1.0' }));

const capOf = (adapter, project, name) => adapter.capabilities(project).find((c) => c.name === name);

test('UT-PWA-001: the Playwright adapter reports the probed options as proven', () => {
  const a = createPlaywrightAdapter();
  const c = capOf(a, pwProject, 'cliContract');
  assert.equal(c.supported, true);
  assert.match(c.evidence, /probed from --help/);
  assert.match(c.detail.options.join(','), /reporter/);
});

test('UT-PWA-002: the Playwright adapter never claims --screenshot / --video', () => {
  const a = createPlaywrightAdapter();
  for (const name of ['screenshot', 'video']) {
    const c = capOf(a, pwProject, name);
    assert.equal(c.supported, false, `${name} must not be claimed`);
    assert.match(c.reason, /Playwright CLI has no --/);
  }
});

test('UT-PWA-003: a project without the CLI reports every capability unsupported with a reason', () => {
  const empty = { id: 'proj_empty', root: path.join(dir, 'empty') };
  fs.mkdirSync(empty.root, { recursive: true });
  const a = createPlaywrightAdapter();
  for (const c of a.capabilities(empty)) {
    assert.equal(c.supported, false, `${c.name} must be unsupported`);
    assert.ok(c.reason.length > 0, `${c.name} must carry a reason`);
    assert.match(c.reason, /no local Playwright CLI/);
  }
});

test('UT-PWA-004: an unreadable --help does NOT produce a proven capability', () => {
  // A CLI whose --help prints nothing: the adapter may still RUN, but it may
  // not claim that the CLI accepts an option it never saw declared.
  const p = makeProject('pw-nohelp', 'node_modules/@playwright/test/cli.js', '');
  const a = createPlaywrightAdapter();
  const c = capOf(a, p, 'structuredReport');
  assert.equal(c.supported, false);
  assert.match(c.reason, /could not be parsed/);
  // ...but the run still gets the conservative fallback vector.
  assert.ok(FALLBACK_PLAYWRIGHT_OPTIONS.includes('reporter'));
  assert.ok(FALLBACK_PLAYWRIGHT_OPTIONS.includes('output'));
});

test('UT-PWA-004B: a usage line WITHOUT a positional filter means filterByFile is unsupported', () => {
  // The negative half of the ATS-301 review finding C1: the fix must not
  // turn the capability into an unconditional `true`. A CLI whose usage line
  // declares no positional test filter must report it as unsupported, WITH
  // a reason.
  const p = makeProject('pw-nopositional', 'node_modules/@playwright/test/cli.js', [
    'Usage: npx playwright test [options]',
    '',
    'Options:',
    '  --output <dir>       Folder for output artifacts',
    '  --reporter <r>      Reporter to use',
  ].join('\n'));
  const a = createPlaywrightAdapter();
  const c = capOf(a, p, 'filterByFile');
  assert.equal(c.supported, false, JSON.stringify(c, null, 2));
  assert.match(c.reason, /no positional test-filter/);
  assert.equal(c.evidence, '');
  // The probed usage line is still reported, so the reason is auditable.
  assert.match(c.detail.usage, /npx playwright test \[options\]/);
});

test('UT-PWA-004C: a usage line WITH a positional filter means filterByFile is supported', () => {
  // The positive half, on a FORGED probe -- so it does not depend on the
  // real engine being installed.
  const p = makeProject('pw-positional', 'node_modules/@playwright/test/cli.js', PLAYWRIGHT_HELP);
  const a = createPlaywrightAdapter();
  const c = capOf(a, p, 'filterByFile');
  assert.equal(c.supported, true, JSON.stringify(c, null, 2));
  assert.equal(c.reason, '');
  assert.match(c.evidence, /positional argument/);
  // The evidence quotes the SAME usage line the capability was derived from.
  assert.ok(c.evidence.includes(c.detail.usage), `${c.evidence} does not quote ${c.detail.usage}`);
});

test('UT-PWA-005: the Playwright argument vector contains only probed options', () => {
  const a = createPlaywrightAdapter();
  const handle = a.start({
    project: pwProject,
    run: {},
    file: null,
    outputDir: path.join(dir, 'out-pw'),
  });
  const args = handle.args;
  assert.ok(args.includes('--reporter=line,json,html'));
  assert.ok(args.includes('--output'));
  assert.ok(args.includes('--trace'));
  assert.ok(!args.some((x) => x.includes('--screenshot')));
  assert.ok(!args.some((x) => x.includes('--video')));
  handle.child.kill();
});

test('UT-WDA-001: the WDIO adapter reports the reporter packages it found', () => {
  const a = createWdioAdapter();
  const c = capOf(a, wdioProject, 'structuredReport');
  assert.equal(c.supported, true);
  assert.match(c.evidence, /json-reporter/);
});

test('UT-WDA-002: the WDIO adapter refuses to claim an HTML report', () => {
  // @wdio/html-reporter does not exist as a package, so the capability must
  // be reported as unsupported with the reason.
  const a = createWdioAdapter();
  const c = capOf(a, wdioProject, 'htmlReport');
  assert.equal(c.supported, false);
  assert.match(c.reason, /@wdio\/html-reporter does not exist/);
});

test('UT-WDA-003: the WDIO adapter refuses to claim trace / screenshot / video', () => {
  const a = createWdioAdapter();
  for (const name of ['trace', 'screenshot', 'video']) {
    const c = capOf(a, wdioProject, name);
    assert.equal(c.supported, false, `${name} must not be claimed`);
    assert.ok(c.reason.length > 0);
  }
});

test('UT-WDA-004: a project without the WDIO CLI reports every capability unsupported', () => {
  const empty = { id: 'proj_empty_wdio', root: path.join(dir, 'empty') };
  const a = createWdioAdapter();
  for (const c of a.capabilities(empty)) {
    assert.equal(c.supported, false, `${c.name} must be unsupported`);
    assert.match(c.reason, /no local WebdriverIO CLI/);
  }
});

test('UT-WDA-005: mapWdioStatus normalises every WDIO state', () => {
  assert.equal(mapWdioStatus('passed'), 'passed');
  assert.equal(mapWdioStatus('failed'), 'failed');
  assert.equal(mapWdioStatus('skipped'), 'skipped');
  assert.equal(mapWdioStatus('pending'), 'skipped');
  assert.equal(mapWdioStatus('something-else'), 'unknown');
  assert.equal(mapWdioStatus(undefined), 'unknown');
});

test('UT-WDA-006: mergeWdioReports merges per-worker ResultSets', () => {
  // The real json reporter writes ONE FILE PER WORKER. A summary built from
  // only the last worker would under-report the run.
  const worker = (name, state, error) => ({
    report: {
      capabilities: { browserName: 'chrome', browserVersion: '151.0.7922.109' },
      specs: ['file:///C:/proj/tests/pass.spec.js'],
      suites: [{ name: 'sample-wdio', tests: [{ name, state, duration: 5, ...(error ? { error } : {}) }] }],
    },
  });
  const s = mergeWdioReports([worker('a', 'passed'), worker('b', 'failed', { message: 'boom' })]);
  assert.equal(s.total, 2);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.browser, 'chrome 151.0.7922.109');
  assert.equal(s.cases[1].error, 'boom');
  assert.equal(s.cases[0].file, 'C:/proj/tests/pass.spec.js');
});

test('UT-WDA-007: a worker with several spec files does not guess the case file', () => {
  const s = mergeWdioReports([{
    report: {
      capabilities: {},
      specs: ['file:///C:/proj/tests/a.spec.js', 'file:///C:/proj/tests/b.spec.js'],
      suites: [{ name: 's', tests: [{ name: 'x', state: 'passed' }] }],
    },
  }]);
  assert.equal(s.cases[0].file, '');
  assert.equal(s.unattributedCases, 1);
});

test('UT-WDA-008: parseWdioReport rejects a payload that is not a ResultSet', () => {
  assert.equal(parseWdioReport(null), null);
  assert.equal(parseWdioReport({ nope: 1 }), null);
  const ok = parseWdioReport({ capabilities: {}, specs: [], suites: [{ name: 's', tests: [] }] });
  assert.equal(ok.total, 0);
});

test('UT-WDA-009: fileUrlToRelative converts a file:// URL to a path', () => {
  assert.equal(fileUrlToRelative('file:///C:/proj/tests/a.spec.js'), 'C:/proj/tests/a.spec.js');
  assert.equal(fileUrlToRelative('/already/a/path.js'), '/already/a/path.js');
  assert.equal(fileUrlToRelative(''), '');
});

test('UT-WDA-010: the generated WDIO config points the reporter at the run output dir', () => {
  const out = path.join(dir, 'run-out');
  const text = buildWdioConfigText({
    projectRoot: wdioProject.root,
    specFiles: ['tests/pass.spec.js'],
    outputDir: out,
    reporterName: 'json',
  });
  assert.match(text, /reporters: \[\['json', \{ outputDir:/);
  assert.ok(text.includes(out.replace(/\\/g, '\\\\')));
  assert.match(text, /specs: \[/);
});

test('UT-REG-001: the registry knows every runner', () => {
  const kinds = listRunners().map((r) => r.kind);
  // ATS-601 added the mobile runner: it is a THIRD adapter in the SAME
  // registry, not a parallel one.
  assert.deepEqual(kinds, ['playwright', 'wdio', 'mobile']);
  assert.equal(getAdapter('playwright').kind, 'playwright');
  assert.equal(getAdapter('mobile').kind, 'mobile');
});

test('UT-REG-002: getAdapter rejects an unknown runner', () => {
  try {
    getAdapter('nope');
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'UNKNOWN_RUNNER');
  }
});

test('UT-REG-003: the capability matrix reports every runner for a project', () => {
  const matrix = capabilityMatrix(pwProject);
  assert.equal(matrix.length, 3);
  for (const entry of matrix) {
    assert.ok(Array.isArray(entry.capabilities));
    assert.ok(entry.capabilities.length > 0);
    for (const c of entry.capabilities) {
      assert.ok(c.supported === true || c.reason.length > 0);
    }
  }
});

test('UT-REG-004: selectAdapter picks a runner that supports the request', () => {
  const { adapter, negotiation, rejected } = selectAdapter(pwProject, ['discover', 'start']);
  assert.ok(['playwright', 'wdio'].includes(adapter.kind));
  assert.equal(negotiation.supported, true);
  assert.ok(Array.isArray(rejected));
});

test('UT-REG-005: selectAdapter explains why every runner was rejected', () => {
  try {
    selectAdapter(pwProject, ['filterByTestUid']);
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'NO_RUNNER_SUPPORTS_REQUEST');
    // Every runner that was tried is reported, including the mobile one:
    // a caller that cannot satisfy the request must be able to see that
    // the mobile runner was considered and why it was not chosen.
    assert.equal(e.details.rejected.length, 3);
    for (const r of e.details.rejected) {
      assert.ok(r.missing.length > 0);
      assert.ok(r.missing[0].reason.length > 0);
    }
  }
});

test('UT-REG-006: a pinned runner does NOT fall back to another engine', () => {
  // The Playwright project has no WDIO CLI, so pinning wdio must fail --
  // silently running Playwright instead would run something the caller did
  // not ask for.
  try {
    selectAdapterOrThrow(pwProject, ['discover', 'start'], { preferred: 'wdio' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'CAPABILITY_UNSUPPORTED');
    assert.match(e.message, /wdio/);
  }
});

test('UT-REG-007: a pinned runner that satisfies the request is returned', () => {
  const r = selectAdapterOrThrow(pwProject, ['discover', 'start'], { preferred: 'playwright' });
  assert.equal(r.adapter.kind, 'playwright');
  assert.equal(r.negotiation.supported, true);
});

test('UT-CLEANUP: removes the generated fixture', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});
