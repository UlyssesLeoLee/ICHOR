/**
 * ATS-202: the tests of the ASYNCHRONOUS listing path.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The Bridge does NOT use `listTests` (the synchronous variant): it uses
 * `listTestsAsync` and `discoverTestsAsync`, because the listing executes the
 * project's own config and may take seconds. A synchronous listing froze the
 * whole Bridge -- the health check, another project's catalogue, and the STOP
 * BUTTON of a running test all waited for it.
 *
 * The round-2 review found that the async path -- the one the product really
 * runs -- had NO direct test: the coverage of `playwright-list.mjs` fell to
 * 85.60%, and the uncovered lines were exactly `listTestsAsync` and
 * `spawnAsync`. The existing integration tests only exercised the
 * SYNCHRONOUS variant.
 *
 * So this file drives the async path DIRECTLY, with a FAKE Playwright CLI:
 *
 *   * the fake CLI is a plain Node script that writes the JSON report the
 *     adapter reads, so the tests need no network and no real Playwright;
 *   * it can be told to hang (for the timeout), to fail (for the broken
 *     config), to write a broken report (for the invalid JSON), or to
 *     succeed -- one behaviour per test, so each failure mode is pinned;
 *   * the two variants are compared: the sync and the async answer must be
 *     IDENTICAL for the same project, because they share the parsing and the
 *     failure classification.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listTests, listTestsAsync, LIST_OUTCOME, DEFAULT_LIST_TIMEOUT_MS } from '../server/discovery/playwright-list.mjs';
import { discoverTests, discoverTestsAsync } from '../server/core.mjs';
import { withTrust, TRUST } from '../server/discovery/trust.mjs';
import { emptyRegistry } from '../server/uid.mjs';

const PROJECT_UID = 'proj_1_0123456789abcdef01234567';

/**
 * The fake Playwright CLI.
 *
 * It is written into the fixture's `node_modules/@playwright/test/cli.js`,
 * which is where the adapter looks for it (`PLAYWRIGHT_CLI_CANDIDATES`).
 * The behaviour is chosen by the fixture's `fake-cli.json`, so one file
 * covers every failure mode.
 */
const FAKE_CLI = `
'use strict';
const fs = require('fs');
const path = require('path');
const mode = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'fake-cli.json'), 'utf8')).mode; }
  catch { return 'ok'; }
})();
const out = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;

if (mode === 'hang') {
  // A config that never finishes: the parent must kill us on the timeout.
  const end = Date.now() + 60000;
  while (Date.now() < end) { /* spin */ }
  process.exit(0);
}
if (mode === 'crash') {
  // The CLI dies before it can write a report: a broken project config.
  process.stderr.write('fake-cli: the config could not be loaded\\n');
  process.exit(1);
}
if (mode === 'bad-json') {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'this is not JSON');
  process.exit(0);
}
if (mode === 'errors') {
  // The CLI could enumerate NOTHING and says why: a duplicate title.
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    config: { rootDir: path.join(process.cwd(), 'tests').split(path.sep).join('/') },
    suites: [],
    errors: [{ message: 'duplicate test title' }],
  }));
  process.exit(1);
}

// The normal answer: one case per line of the spec file.
const rootDir = path.join(process.cwd(), 'tests').split(path.sep).join('/');
const specPath = path.join(process.cwd(), 'tests', 'a.spec.ts');
const src = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf8') : '';
const specs = [];
const re = /(?:^|\\n)[ \\t]*(?:test|it)[ \\t]*\\(\\s*(['\\"\`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1/g;
let m;
while ((m = re.exec(src)) !== null) {
  const line = src.slice(0, m.index + m[0].length).split('\\n').length;
  specs.push({ title: m[2], line, file: 'a.spec.ts', tests: [{ projectName: 'chromium', status: 'expected' }] });
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({
  config: { rootDir, version: '1.64.1' },
  suites: [{ file: 'a.spec.ts', title: 'a.spec.ts', line: 0, specs }],
}));
process.exit(0);
`;

/**
 * A fixture project with a fake Playwright CLI.
 *
 * `mode` is the behaviour of the fake CLI: ok | hang | crash | bad-json | errors.
 */
function fixture(mode = 'ok', specBody = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats202-async-'));
  const cliDir = path.join(root, 'node_modules', '@playwright', 'test');
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'cli.js'), FAKE_CLI, 'utf8');
  fs.writeFileSync(path.join(root, 'node_modules', '@playwright', 'test', 'package.json'), JSON.stringify({
    name: '@playwright/test', version: '1.64.1', main: 'index.js'
  }), 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"ats202-async","private":true}', 'utf8');
  fs.writeFileSync(path.join(root, 'fake-cli.json'), JSON.stringify({ mode }), 'utf8');
  fs.writeFileSync(
    path.join(root, 'tests', 'a.spec.ts'),
    specBody ?? "import { test } from '@playwright/test';\ntest('async one', async () => {});\ntest('async two', async () => {});\n",
    'utf8'
  );
  return { id: PROJECT_UID, uid: PROJECT_UID, root };
}

const cleanup = (p) => fs.rmSync(p.root, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
/* the happy path                                                      */
/* ------------------------------------------------------------------ */

test('ATS202-ASYNC-001: the async listing reports the cases of the project', async () => {
  const p = fixture('ok');
  try {
    const listed = await listTestsAsync(p);
    assert.equal(listed.ok, true, JSON.stringify(listed.errors));
    assert.equal(listed.outcome, LIST_OUTCOME.OK);
    assert.equal(listed.tests.length, 2);
    assert.deepEqual(listed.tests.map((t) => t.title).sort(), ['async one', 'async two']);
    assert.equal(listed.version, '1.64.1');
    assert.ok(listed.durationMs >= 0);
  } finally {
    cleanup(p);
  }
});

test('ATS202-ASYNC-002: the async and the sync listing give the SAME answer', async () => {
  // The two variants share the parsing and the failure classification, so
  // they cannot drift apart. A difference here means one of them was
  // changed without the other.
  const p = fixture('ok');
  try {
    const a = await listTestsAsync(p);
    const s = listTests(p);
    assert.equal(a.ok, s.ok);
    assert.equal(a.outcome, s.outcome);
    assert.deepEqual(a.tests, s.tests);
    assert.deepEqual(a.files, s.files);
    assert.equal(a.version, s.version);
  } finally {
    cleanup(p);
  }
});

/* ------------------------------------------------------------------ */
/* the failure modes                                                   */
/* ------------------------------------------------------------------ */

test('ATS202-ASYNC-003: a listing that does not finish in time is a TIMEOUT', async () => {
  // The child is KILLED on the timeout -- the parent's promise resolves with
  // the timeout outcome instead of hanging forever.
  const p = fixture('hang');
  try {
    const listed = await listTestsAsync(p, { timeoutMs: 1200 });
    assert.equal(listed.ok, false);
    assert.equal(listed.outcome, LIST_OUTCOME.TIMEOUT);
    assert.match(listed.reason, /1200ms/);
    assert.equal(listed.tests.length, 0);
  } finally {
    cleanup(p);
  }
});

test('ATS202-ASYNC-004: the CLI that dies before it writes a report is a FAILURE', async () => {
  // A broken project config is the usual cause. The CLI's own message is the
  // only useful diagnosis, so it is carried into `errors[]`.
  const p = fixture('crash');
  try {
    const listed = await listTestsAsync(p);
    assert.equal(listed.ok, false);
    assert.equal(listed.outcome, LIST_OUTCOME.FAILED);
    assert.match(listed.reason, /could not list/);
    assert.equal(listed.errors.length, 1);
    assert.match(listed.errors[0].message, /config could not be loaded/);
  } finally {
    cleanup(p);
  }
});

test('ATS202-ASYNC-005: a report that is not valid JSON is a FAILURE', async () => {
  const p = fixture('bad-json');
  try {
    const listed = await listTestsAsync(p);
    assert.equal(listed.ok, false);
    assert.equal(listed.outcome, LIST_OUTCOME.FAILED);
    assert.match(listed.reason, /not valid JSON/);
    assert.equal(listed.errors.length, 1);
  } finally {
    cleanup(p);
  }
});

test('ATS202-ASYNC-006: a report that carries errors is a FAILURE, not an empty index', async () => {
  // The CLI exits non-zero when it could not enumerate the project. A listing
  // that produced errors is NOT a usable index.
  const p = fixture('errors');
  try {
    const listed = await listTestsAsync(p);
    assert.equal(listed.ok, false);
    assert.equal(listed.outcome, LIST_OUTCOME.FAILED);
    assert.match(listed.reason, /could not enumerate/);
    assert.equal(listed.errors.length, 1);
    assert.match(listed.errors[0].message, /duplicate test title/);
  } finally {
    cleanup(p);
  }
});

test('ATS202-ASYNC-007: a project with NO local Playwright CLI is reported, not installed', async () => {
  // The adapter never installs a CLI. The absence is a result code.
  const p = fixture('ok');
  fs.rmSync(path.join(p.root, 'node_modules'), { recursive: true, force: true });
  try {
    const listed = await listTestsAsync(p);
    assert.equal(listed.ok, false);
    assert.equal(listed.outcome, LIST_OUTCOME.NO_CLI);
    assert.match(listed.reason, /no local Playwright CLI/);
    assert.match(listed.reason, /never installs one/);
  } finally {
    cleanup(p);
  }
});

test('ATS202-ASYNC-008: a project with NO root is reported', async () => {
  const listed = await listTestsAsync({ id: PROJECT_UID, uid: PROJECT_UID, root: null });
  assert.equal(listed.ok, false);
  assert.equal(listed.outcome, LIST_OUTCOME.NO_CLI);
  assert.match(listed.reason, /no root directory/);
});

test('ATS202-ASYNC-009: the default timeout is the documented one', () => {
  // The default is the budget the design book states. It is asserted so a
  // silent change to the value is visible.
  assert.equal(DEFAULT_LIST_TIMEOUT_MS, 120000);
});

/* ------------------------------------------------------------------ */
/* discoverTestsAsync -- the entry point the Bridge really calls        */
/* ------------------------------------------------------------------ */

test('ATS202-ASYNC-010: the async discovery of a TRUSTED project is authoritative', async () => {
  const p = fixture('ok');
  try {
    const state = withTrust({}, p, { trust: TRUST.TRUSTED });
    const cat = await discoverTestsAsync(p, state, emptyRegistry());
    assert.equal(cat.discovery, 'authoritative');
    assert.equal(cat.authoritative.outcome, LIST_OUTCOME.OK);
    assert.equal(cat.authoritative.attempted, true);
    assert.equal(cat.tests.length, 2);
    assert.ok(cat.tests.every((t) => t.uid), 'every case has a UID');
    assert.equal(cat.consistency.agrees, true, JSON.stringify(cat.consistency));
  } finally {
    cleanup(p);
  }
});

test('ATS202-ASYNC-011: the async discovery of an UNTRUSTED project never runs --list', async () => {
  // The trust gate is the acceptance criterion of the task. It must hold on
  // the ASYNC path too -- that is the path the Bridge uses.
  const p = fixture('ok');
  try {
    const cat = await discoverTestsAsync(p, {}, emptyRegistry());
    assert.equal(cat.discovery, 'static');
    assert.equal(cat.authoritative.outcome, 'SKIPPED_UNTRUSTED');
    assert.equal(cat.authoritative.attempted, false);
    assert.match(cat.warning, /未可信仓库不可调用/);
  } finally {
    cleanup(p);
  }
});

test('ATS202-ASYNC-012: a TRUSTED project that asks for the static index is not told it is untrusted', async () => {
  // CE-F on the async path.
  const p = fixture('ok');
  try {
    const state = withTrust({}, p, { trust: TRUST.TRUSTED });
    const cat = await discoverTestsAsync(p, state, emptyRegistry(), { authoritative: false });
    assert.equal(cat.discovery, 'static');
    assert.equal(cat.authoritative.outcome, 'NOT_REQUESTED');
    assert.doesNotMatch(cat.warning, /未可信仓库不可调用/);
  } finally {
    cleanup(p);
  }
});

test('ATS202-ASYNC-013: a listing that FAILS falls back to the static index and says why', async () => {
  // The fallback is the path the round-1 review called out: a trusted
  // project whose listing fails must not be reported as untrusted, and the
  // reason must be in the warning.
  const p = fixture('crash');
  try {
    const state = withTrust({}, p, { trust: TRUST.TRUSTED });
    const cat = await discoverTestsAsync(p, state, emptyRegistry());
    assert.equal(cat.discovery, 'static');
    assert.equal(cat.authoritative.attempted, true);
    assert.equal(cat.authoritative.outcome, LIST_OUTCOME.FAILED);
    assert.match(cat.warning, /权威发现失败/);
    assert.doesNotMatch(cat.warning, /未可信仓库不可调用/, 'the trust gate does not apply here');
  } finally {
    cleanup(p);
  }
});

test('ATS202-ASYNC-014: the async discovery and the sync discovery agree', async () => {
  // The two variants build the catalogue with the SAME code, so the answers
  // differ in nothing but the timing.
  const p = fixture('ok');
  try {
    const state = withTrust({}, p, { trust: TRUST.TRUSTED });
    const a = await discoverTestsAsync(p, state, emptyRegistry());
    const s = discoverTests(p, state, emptyRegistry());
    assert.equal(a.discovery, s.discovery);
    assert.deepEqual(a.tests.map((t) => t.uid), s.tests.map((t) => t.uid));
    assert.deepEqual(a.consistency, s.consistency);
    assert.equal(a.authoritative.outcome, s.authoritative.outcome);
  } finally {
    cleanup(p);
  }
});

test('ATS202-ASYNC-015: the async listing does not block the event loop', async () => {
  // The whole point of the async variant: while the listing runs, the
  // Bridge keeps answering. A timer that fires DURING the listing proves
  // the event loop was free.
  const p = fixture('ok');
  try {
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 10);
    await listTestsAsync(p);
    clearTimeout(timer);
    assert.equal(ticked, true, 'the event loop was free during the listing');
  } finally {
    cleanup(p);
  }
});
