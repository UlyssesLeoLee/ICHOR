/**
 * ATS-603: unit tests of the Android runner.
 *
 * WHAT THESE TESTS PROVE
 * ----------------------
 * They prove the SEMANTICS of the runner without a device, over a FAKE
 * ADB transport:
 *
 *   - the four step kinds do what they say (launch / tap / assert /
 *     screenshot);
 *   - the FAILURE TAXONOMY of docs/25 §5.3 holds: a session loss, a
 *     missing element, a failing assertion and a driver error are four
 *     DIFFERENT failures, each with its own class -- and none of them is
 *     a generic "execution failed";
 *   - the failures carry the EVIDENCE that makes them believable: the
 *     view hierarchy for a missing element, the element's own facts for
 *     a failing assertion;
 *   - the capability negotiation happens BEFORE the first step, and a
 *     step whose capability is missing is never attempted;
 *   - the runner never builds a shell string: a package name that looks
 *     like a command stays one argument.
 *
 * The real device is exercised by the IT (tests/android-runner-it.test.mjs),
 * which SKIPS itself with the reason when there is no device. A skip is
 * not a pass, and it is never reported as one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ADB_FAILURE, AdbError, createFakeAdb, shellQuote } from '../server/adapters/android-adb.mjs';
import {
  centreOf,
  decodeEntities,
  findMatches,
  parseBounds,
  parseHierarchy,
  summariseHierarchy,
  walkHierarchy,
} from '../server/adapters/android-hierarchy.mjs';
import {
  MOBILE_FAILURE,
  STEP_STATUS,
  createAndroidDriver,
  describeTarget,
  pngDimensions,
  sanitiseEvidenceName,
} from '../server/adapters/android-runner.mjs';
import {
  MOBILE_CAPABILITIES,
  SESSION_STATE,
  defineSession,
  defineTarget,
} from '../server/adapters/mobile-target.mjs';

const target = defineTarget({
  targetId: 'tgt_emulator_1',
  kind: 'local-emulator',
  platform: 'android',
  capabilities: MOBILE_CAPABILITIES,
  declaredBy: 'user:tester',
});

const session = defineSession({
  sessionId: 'ses_1',
  targetId: 'tgt_emulator_1',
  state: SESSION_STATE.CREATED,
  capabilities: MOBILE_CAPABILITIES,
});

/** A hierarchy with the elements of the smoke fixture. */
const FIXTURE_HIERARCHY = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.ichor.smoke" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="ICHOR Smoke Home" resource-id="com.ichor.smoke:id/title" class="android.widget.TextView" package="com.ichor.smoke" content-desc="ICHOR Smoke Home" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,200][1080,320]" />
    <node index="1" text="Open Details" resource-id="com.ichor.smoke:id/open" class="android.widget.Button" package="com.ichor.smoke" content-desc="Open Details" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[400,500][680,600]" />
  </node>
</hierarchy>`;

/** A hierarchy WITHOUT the element the failing step looks for. */
const FIXTURE_HIERARCHY_WITHOUT = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.ichor.smoke" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Something Else" resource-id="com.ichor.smoke:id/other" class="android.widget.TextView" package="com.ichor.smoke" content-desc="Something Else" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,200][1080,320]" />
  </node>
</hierarchy>`;

/** The answers the fake device gives for a launch. */
function launchAnswers({ hierarchy = FIXTURE_HIERARCHY } = {}) {
  return [
    // pm list packages
    'package:com.ichor.smoke\npackage:com.android.settings\n',
    // am start -W
    'Starting: Intent { cmp=com.ichor.smoke/.MainActivity }\nStatus: ok\n',
    // dumpsys window
    '  mCurrentFocus=Window{abc123 u0 com.ichor.smoke/com.ichor.smoke.MainActivity}\n',
    // uiautomator dump
    hierarchy,
  ];
}

const noSleep = () => Promise.resolve();

/* ------------------------------------------------------------------ */
/* The ADB transport                                                    */
/* ------------------------------------------------------------------ */

test('UT-ATS603-001: the ADB transport never builds a shell string', () => {
  // The source of the transport is checked for the rule that matters: a
  // package name or an element text comes from a Flow, and it must stay
  // ONE argument.
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'server', 'adapters', 'android-adb.mjs'),
    'utf8',
  );
  assert.equal(/shell:\s*true/.test(source), false, 'the transport may run a shell');
  assert.equal(/\bshell:\s*false/.test(source), true, 'the transport must run without a shell');
  // There is no string concatenation into a command line.
  assert.equal(/`adb\s+\$\{/.test(source), false, 'the transport builds a command string');
});

test('UT-ATS603-002: a value that looks like a command stays one argument', () => {
  // The quoting helper is what makes a value with a space, a quote or a
  // shell metacharacter survive the DEVICE shell.
  assert.equal(shellQuote('com.example.app'), 'com.example.app');
  assert.equal(shellQuote('hello world'), "'hello world'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('a;rm -rf /'), "'a;rm -rf /'");
  assert.equal(shellQuote(''), "''");
});

test('UT-ATS603-003: the failure vocabulary of the transport is closed', () => {
  assert.deepEqual(Object.values(ADB_FAILURE).sort(), [
    'adb-missing',
    'command-failed',
    'device-absent',
    'device-offline',
  ]);
});

/* ------------------------------------------------------------------ */
/* The hierarchy parser                                                */
/* ------------------------------------------------------------------ */

test('UT-ATS603-010: the hierarchy is parsed into a tree with the attributes', () => {
  const tree = parseHierarchy(FIXTURE_HIERARCHY);
  assert.equal(tree.root.class, 'android.widget.FrameLayout');
  assert.equal(tree.nodes.length, 3);
  const button = tree.nodes.find((n) => n.text === 'Open Details');
  assert.ok(button, 'the button is not in the tree');
  assert.equal(button.clickable, true);
  assert.equal(button.id, 'com.ichor.smoke:id/open');
  assert.deepEqual(button.bounds, { left: 400, top: 500, right: 680, bottom: 600, width: 280, height: 100 });
  assert.equal(tree.rotation, '0');
});

test('UT-ATS603-011: the bounds are read into a rectangle, and a malformed one is an error', () => {
  assert.deepEqual(parseBounds('[0,0][1080,2400]'), { left: 0, top: 0, right: 1080, bottom: 2400, width: 1080, height: 2400 });
  // A malformed bounds must NOT become {0,0,0,0}: that would make every
  // element unfindable without saying why.
  assert.throws(() => parseBounds('nonsense'), /malformed bounds/);
  assert.throws(() => parseBounds(''), /malformed bounds/);
});

test('UT-ATS603-012: a hierarchy that cannot be read is an ERROR, not a half-read tree', () => {
  assert.throws(() => parseHierarchy(''), /empty/);
  assert.throws(() => parseHierarchy('not xml at all'), /not a hierarchy/);
  // An unclosed node is an error: a tree that is read half way is worse
  // than one that fails.
  assert.throws(
    () => parseHierarchy('<hierarchy rotation="0"><node bounds="[0,0][1,1]"></hierarchy>'),
    /unclosed node/,
  );
  // Two roots are an error too.
  assert.throws(
    () => parseHierarchy('<hierarchy><node bounds="[0,0][1,1]"/><node bounds="[0,0][1,1]"/></hierarchy>'),
    /more than one root/,
  );
});

test('UT-ATS603-013: the XML entities are decoded, and an unknown one is an error', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeEntities('&#65;'), 'A');
  // An entity the platform does not know is an error, not a silently
  // dropped text.
  assert.throws(() => decodeEntities('a&nbsp;b'), /unknown entity/);
});

test('UT-ATS603-014: the walk visits parents before children', () => {
  const tree = parseHierarchy(FIXTURE_HIERARCHY);
  const nodes = walkHierarchy(tree);
  assert.equal(nodes[0].class, 'android.widget.FrameLayout');
  assert.equal(nodes.length, 3);
});

test('UT-ATS603-015: an element is found by text, by id and by content description', () => {
  const tree = parseHierarchy(FIXTURE_HIERARCHY);
  assert.equal(findMatches(tree, { text: 'Open Details' }).length, 1);
  assert.equal(findMatches(tree, { id: 'com.ichor.smoke:id/open' }).length, 1);
  assert.equal(findMatches(tree, { desc: 'ICHOR Smoke Home' }).length, 1);
  // A partial match does NOT match: a wrong tap is worse than no tap.
  assert.equal(findMatches(tree, { text: 'Open' }).length, 0);
  assert.equal(findMatches(tree, { text: 'Nothing' }).length, 0);
});

test('UT-ATS603-016: the summary of a tree names the visible elements', () => {
  const tree = parseHierarchy(FIXTURE_HIERARCHY);
  const summary = summariseHierarchy(tree);
  assert.match(summary, /Open Details/);
  assert.match(summary, /com\.ichor\.smoke:id\/open/);
});

/* ------------------------------------------------------------------ */
/* The steps                                                           */
/* ------------------------------------------------------------------ */

test('UT-ATS603-020: the launch step brings the app to the foreground', async () => {
  const transport = createFakeAdb({ answers: launchAnswers() });
  const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
  const result = await driver.runStep({ kind: 'launchApp', args: { appId: 'com.ichor.smoke' }, raw: 'launchApp' });
  assert.equal(result.status, STEP_STATUS.PASSED);
  assert.equal(result.error, null);
  assert.equal(result.detail.packageName, 'com.ichor.smoke');
  assert.equal(result.detail.foreground.package, 'com.ichor.smoke');
});

test('UT-ATS603-021: the launch step REFUSES an app the project did not register', async () => {
  const transport = createFakeAdb({ answers: [] });
  const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
  const result = await driver.runStep({ kind: 'launchApp', args: { appId: 'com.evil.app' }, raw: 'launchApp' });
  assert.equal(result.status, STEP_STATUS.FAILED);
  // The refusal is its OWN class, not a generic failure.
  assert.equal(result.error.failure, MOBILE_FAILURE.REFUSED);
  assert.match(result.error.message, /not registered/);
  // The device was never touched: the refusal happens BEFORE the launch.
  assert.equal(transport.calls.length, 0);
});

test('UT-ATS603-022: the tap step locates the element and taps its centre', async () => {
  const answers = [
    FIXTURE_HIERARCHY,
    '',
  ];
  const transport = createFakeAdb({ answers });
  const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
  const result = await driver.runStep({ kind: 'tapOn', args: { text: 'Open Details' }, raw: 'tapOn "Open Details"' });
  assert.equal(result.status, STEP_STATUS.PASSED);
  // The centre of [400,500][680,600] is (540, 550).
  assert.deepEqual(result.detail.point, { x: 540, y: 550 });
  assert.equal(result.detail.matched, 1);
  // The tap is an ARGUMENT VECTOR: the coordinates are separate arguments.
  // The recorded command carries the `shell` subcommand, exactly as the
  // real transport issues it.
  assert.ok(
    transport.calls.some((c) => c === 'shell input tap 540 550'),
    `the tap was not issued: ${transport.calls.join(' | ')}`,
  );
  // The hierarchy is carried as the evidence of the search.
  assert.ok(result.evidence.some((e) => e.kind === 'hierarchy'));
});

test('UT-ATS603-023: a MISSING element is its own failure class and carries the hierarchy', async () => {
  const transport = createFakeAdb({ answers: [FIXTURE_HIERARCHY_WITHOUT] });
  const driver = createAndroidDriver({
    transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep,
    wait: { timeoutMs: 0, intervalMs: 1 },
  });
  const result = await driver.runStep({ kind: 'tapOn', args: { text: 'Open Details' }, raw: 'tapOn "Open Details"' });
  assert.equal(result.status, STEP_STATUS.FAILED);
  assert.equal(result.error.failure, MOBILE_FAILURE.ELEMENT_NOT_FOUND);
  // The message NAMES the element.
  assert.match(result.error.message, /Open Details/);
  // And it carries the tree that was searched -- the evidence.
  assert.match(result.error.details.hierarchy, /Something Else/);
  // The visible elements are counted: the root frame and the one text
  // view. The number says how much the screen really offered, so a
  // reader can tell "the screen was empty" from "the screen had other
  // elements and not this one".
  assert.equal(result.error.details.visibleElements, 2);
});

test('UT-ATS603-024: a FAILING assertion is a different class from a missing element', async () => {
  // The element IS there, but the assertion says it must not be visible.
  const transport = createFakeAdb({ answers: [FIXTURE_HIERARCHY] });
  const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
  const result = await driver.runStep({
    kind: 'assertVisible',
    args: { text: 'Open Details' },
    assertion: { notVisible: 'Open Details' },
    raw: 'assert notVisible "Open Details"',
  });
  assert.equal(result.status, STEP_STATUS.FAILED);
  assert.equal(result.error.failure, MOBILE_FAILURE.ASSERTION_FAILED);
  // The element is NAMED in the failure.
  assert.match(result.error.message, /Open Details/);
});

test('UT-ATS603-025: the assertion PASSES when the element is visible', async () => {
  const transport = createFakeAdb({ answers: [FIXTURE_HIERARCHY] });
  const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
  const result = await driver.runStep({
    kind: 'assertVisible',
    args: { text: 'ICHOR Smoke Home' },
    assertion: { visible: 'ICHOR Smoke Home' },
    raw: 'assertVisible "ICHOR Smoke Home"',
  });
  assert.equal(result.status, STEP_STATUS.PASSED);
  assert.equal(result.detail.satisfied, true);
});

test('UT-ATS603-026: a LOST session is its own class', async () => {
  const transport = createFakeAdb({
    answers: [new AdbError(ADB_FAILURE.DEVICE_ABSENT, 'no device is connected to adb')],
  });
  const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
  const result = await driver.runStep({ kind: 'launchApp', args: { appId: 'com.ichor.smoke' }, raw: 'launchApp' });
  assert.equal(result.status, STEP_STATUS.FAILED);
  assert.equal(result.error.failure, MOBILE_FAILURE.SESSION_LOST);
});

test('UT-ATS603-027: a DRIVER error is its own class and carries the stderr', async () => {
  const transport = createFakeAdb({
    answers: [new AdbError(ADB_FAILURE.COMMAND_FAILED, 'the device rejected the command', { stderr: 'Permission denied' })],
  });
  const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
  const result = await driver.runStep({ kind: 'launchApp', args: { appId: 'com.ichor.smoke' }, raw: 'launchApp' });
  assert.equal(result.status, STEP_STATUS.FAILED);
  assert.equal(result.error.failure, MOBILE_FAILURE.DRIVER_ERROR);
  assert.equal(result.error.details.stderr, 'Permission denied');
});

test('UT-ATS603-028: the four failure classes are DISTINCT -- no generic "execution failed"', () => {
  // The vocabulary is closed, and it does NOT contain a generic class.
  const classes = Object.values(MOBILE_FAILURE);
  assert.ok(!classes.includes('failed'));
  assert.ok(!classes.includes('execution-failed'));
  assert.equal(new Set(classes).size, classes.length, 'a failure class is used twice');
  for (const c of ['session-lost', 'element-not-found', 'assertion-failed', 'driver-error']) {
    assert.ok(classes.includes(c), `the class ${c} is missing`);
  }
});

test('UT-ATS603-029: the screenshot step writes a PNG and reports its size', async () => {
  // A real PNG header with the dimensions of a 1080x2400 screen.
  const png = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(1080, 16);
  png.writeUInt32BE(2400, 20);
  const transport = createFakeAdb({
    answers: [png, 'Physical size: 1080x2400\n'],
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats603-ut-'));
  try {
    const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
    const result = await driver.runStep(
      { kind: 'takeScreenshot', args: { name: 'home' }, raw: 'screenshot home' },
      { evidenceRoot: root },
    );
    assert.equal(result.status, STEP_STATUS.PASSED);
    assert.equal(result.detail.file, 'screenshots/home.png');
    assert.deepEqual(result.detail.dimensions, { width: 1080, height: 2400 });
    const written = fs.readFileSync(path.join(root, 'screenshots', 'home.png'));
    assert.equal(written.length, png.length);
    assert.deepEqual(pngDimensions(written), { width: 1080, height: 2400 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-ATS603-030: a screenshot that is not a PNG is a DRIVER error', async () => {
  const transport = createFakeAdb({ answers: [Buffer.from('this is not a png at all'), 'Physical size: 1080x2400\n'] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats603-ut-'));
  try {
    const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
    const result = await driver.runStep(
      { kind: 'takeScreenshot', args: { name: 'broken' }, raw: 'screenshot broken' },
      { evidenceRoot: root },
    );
    assert.equal(result.status, STEP_STATUS.FAILED);
    assert.equal(result.error.failure, MOBILE_FAILURE.DRIVER_ERROR);
    assert.match(result.error.message, /not a PNG/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-ATS603-031: a screenshot of the WRONG size is a DRIVER error', async () => {
  const png = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(320, 16);
  png.writeUInt32BE(240, 20);
  const transport = createFakeAdb({ answers: [png, 'Physical size: 1080x2400\n'] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats603-ut-'));
  try {
    const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
    const result = await driver.runStep(
      { kind: 'takeScreenshot', args: { name: 'small' }, raw: 'screenshot small' },
      { evidenceRoot: root },
    );
    assert.equal(result.status, STEP_STATUS.FAILED);
    assert.equal(result.error.failure, MOBILE_FAILURE.DRIVER_ERROR);
    assert.match(result.error.message, /320x240/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-ATS603-032: the screenshot name cannot escape the evidence root', () => {
  // The name comes from a Flow, so it is untrusted input.
  assert.equal(sanitiseEvidenceName('../../etc/passwd'), 'passwd');
  assert.equal(sanitiseEvidenceName('a/b/c.png'), 'c.png');
  assert.equal(sanitiseEvidenceName('..'), 'unnamed');
  assert.equal(sanitiseEvidenceName(''), 'unnamed');
  assert.equal(sanitiseEvidenceName('good-name_1.png'), 'good-name_1.png');
});

/* ------------------------------------------------------------------ */
/* The case and the negotiation                                        */
/* ------------------------------------------------------------------ */

test('UT-ATS603-040: a step whose capability is missing is NOT attempted', async () => {
  // The session proves nothing but `app.launch`: `ui.hierarchy` is
  // missing, so `tapOn` cannot run.
  const weak = defineSession({
    sessionId: 'ses_weak',
    targetId: 'tgt_emulator_1',
    state: SESSION_STATE.CREATED,
    capabilities: ['app.launch'],
  });
  const transport = createFakeAdb({ answers: [] });
  const driver = createAndroidDriver({ transport, session: weak, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
  const result = await driver.runCase({
    title: 'A case that needs a hierarchy',
    uid: 'tc-1',
    steps: [{ kind: 'tapOn', args: { text: 'Open Details' }, raw: 'tapOn "Open Details"' }],
  });
  assert.equal(result.status, STEP_STATUS.FAILED);
  assert.equal(result.error.failure, MOBILE_FAILURE.CAPABILITY_MISSING);
  // The device was NEVER touched: the gap is reported before the run.
  assert.equal(transport.calls.length, 0);
  assert.ok(result.negotiation.gaps.some((g) => g.kind === 'tapOn'));
});

test('UT-ATS603-041: the run stops at the first failed step', async () => {
  const transport = createFakeAdb({ answers: [FIXTURE_HIERARCHY_WITHOUT, FIXTURE_HIERARCHY] });
  const driver = createAndroidDriver({
    transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep,
    wait: { timeoutMs: 0, intervalMs: 1 },
  });
  const result = await driver.runCase({
    title: 'Two steps',
    uid: 'tc-2',
    steps: [
      { kind: 'tapOn', args: { text: 'Open Details' }, raw: 'tapOn "Open Details"' },
      { kind: 'assertVisible', args: { text: 'ICHOR Detail Screen' }, assertion: { visible: 'ICHOR Detail Screen' }, raw: 'assertVisible' },
    ],
  });
  assert.equal(result.status, STEP_STATUS.FAILED);
  // Only the FIRST step ran: the second would have run against a screen
  // the test did not expect.
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].error.failure, MOBILE_FAILURE.ELEMENT_NOT_FOUND);
});

test('UT-ATS603-042: the whole case passes when every step passes', async () => {
  const transport = createFakeAdb({ answers: [FIXTURE_HIERARCHY, '', FIXTURE_HIERARCHY] });
  const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
  const result = await driver.runCase({
    title: 'A case that passes',
    uid: 'tc-3',
    steps: [
      { kind: 'tapOn', args: { text: 'Open Details' }, raw: 'tapOn "Open Details"' },
      { kind: 'assertVisible', args: { text: 'ICHOR Smoke Home' }, assertion: { visible: 'ICHOR Smoke Home' }, raw: 'assertVisible' },
    ],
  });
  assert.equal(result.status, STEP_STATUS.PASSED);
  assert.equal(result.steps.length, 2);
  assert.equal(result.error, null);
});

test('UT-ATS603-043: the target of a failure is NAMED, never generic', () => {
  assert.match(describeTarget({ text: 'Open Details' }), /Open Details/);
  assert.match(describeTarget({ id: 'com.ichor.smoke:id/open' }), /com\.ichor\.smoke:id\/open/);
  assert.match(describeTarget({}), /no element/);
});

test('UT-ATS603-045: a TRANSIENT hierarchy failure is retried, not fatal', async () => {
  // The device is busy and the first dump fails. The element IS there on
  // the second dump, so the step must PASS -- a busy device is not a
  // failed run.
  const busy = new AdbError(ADB_FAILURE.COMMAND_FAILED, 'the device did not return a view hierarchy');
  const transport = createFakeAdb({ answers: [busy, FIXTURE_HIERARCHY, ''] });
  const driver = createAndroidDriver({
    transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep,
    wait: { timeoutMs: 1000, intervalMs: 10 },
  });
  const result = await driver.runStep({ kind: 'tapOn', args: { text: 'Open Details' }, raw: 'tapOn "Open Details"' });
  assert.equal(result.status, STEP_STATUS.PASSED, result.error ? result.error.message : '');
  assert.equal(result.detail.attempts, 2);
});

test('UT-ATS603-046: a hierarchy that NEVER reads is a DRIVER error, not a missing element', async () => {
  // The opposite case: the tree can never be read. That is NOT "the
  // element is not there" -- it is a driver failure, and the two must not
  // be confused.
  const busy = new AdbError(ADB_FAILURE.COMMAND_FAILED, 'the device did not return a view hierarchy');
  const transport = createFakeAdb({ answers: [busy, busy, busy] });
  const driver = createAndroidDriver({
    transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep,
    wait: { timeoutMs: 50, intervalMs: 10 },
  });
  const result = await driver.runStep({ kind: 'tapOn', args: { text: 'Open Details' }, raw: 'tapOn "Open Details"' });
  assert.equal(result.status, STEP_STATUS.FAILED);
  assert.equal(result.error.failure, MOBILE_FAILURE.DRIVER_ERROR);
  assert.notEqual(result.error.failure, MOBILE_FAILURE.ELEMENT_NOT_FOUND);
});

test('UT-ATS603-047: the FOREGROUND app is read from mFocusedApp, not from mCurrentFocus', async () => {
  // A system dialog (an ANR prompt) takes the INPUT focus while the app
  // underneath is still the focused ACTIVITY. `mCurrentFocus` then names
  // the dialog, and reading it would say "the app is not in the
  // foreground" while it IS.
  const dumpsys = [
    '  mCurrentFocus=Window{4ad2ebe u0 Application Not Responding: com.android.systemui}',
    '  mFocusedApp=ActivityRecord{6869daf u0 com.ichor.smoke/.MainActivity t91}',
    '      mFocusedWindow=Window{4ad2ebe u0 Application Not Responding: com.android.systemui}',
  ].join('\n');
  const transport = createFakeAdb({
    answers: ['package:com.ichor.smoke\n', 'Status: ok\n', dumpsys],
  });
  const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
  const result = await driver.runStep({ kind: 'launchApp', args: { appId: 'com.ichor.smoke' }, raw: 'launchApp' });
  assert.equal(result.status, STEP_STATUS.PASSED, result.error ? result.error.message : '');
  assert.equal(result.detail.foreground.package, 'com.ichor.smoke');
  assert.equal(result.detail.foreground.activity, '.MainActivity');
});

test('UT-ATS603-044: a step of an unknown kind is SKIPPED, not crashed on', async () => {
  const transport = createFakeAdb({ answers: [] });
  const driver = createAndroidDriver({ transport, session, target, registeredPackages: ['com.ichor.smoke'], sleep: noSleep });
  const result = await driver.runStep({ kind: 'swipe', args: {}, raw: 'swipe left' });
  assert.equal(result.status, STEP_STATUS.SKIPPED);
  assert.equal(result.error.failure, MOBILE_FAILURE.DRIVER_ERROR);
});
