/**
 * ATS-603: the integration test against a REAL Android device.
 *
 * WHAT THIS TEST IS
 * -----------------
 * The acceptance criterion of the task: on a REAL Android emulator, one
 * Flow runs, and the four step kinds -- launch, tap, assert, screenshot --
 * are measured on the device.
 *
 * The fixture is a REAL APK (`com.ichor.smoke`), built by
 * `tools/ats603-probes/build-smoke-app.sh` with the SDK's own tools. It
 * has a KNOWN screen, so the assertions are about the runner and not
 * about the device image:
 *
 *   * the home screen carries `ICHOR Smoke Home` and the button
 *     `Open Details`;
 *   * tapping the button shows `ICHOR Detail Screen`.
 *
 * WHEN THERE IS NO DEVICE
 * -----------------------
 * The tests SKIP themselves, with the reason. A skip is NOT a pass: the
 * evidence says which cases were measured and which were not, and the
 * reason for a skip is always written down.
 *
 * The device is found through `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) and
 * the adb client of that SDK. The package is installed by the test
 * itself, so the test is self-contained.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { createAdbTransport, resolveAdbPath } from '../server/adapters/android-adb.mjs';
import { MOBILE_FAILURE, STEP_STATUS, createAndroidDriver } from '../server/adapters/android-runner.mjs';
import {
  MOBILE_CAPABILITIES,
  SESSION_STATE,
  defineSession,
  defineTarget,
} from '../server/adapters/mobile-target.mjs';

const root = path.resolve(import.meta.dirname, '..');
const APK = path.join(root, 'tools', 'ats603-probes', 'build', 'smoke-app.apk');
const PACKAGE = 'com.ichor.smoke';

/**
 * The reason the tests skip, or '' when there is a device.
 *
 * A reason is a REASON, not a boolean: the evidence quotes it, so a
 * reader knows exactly what was missing.
 */
function deviceAvailability() {
  const adbPath = resolveAdbPath({});
  if (!fs.existsSync(adbPath) && adbPath === 'adb') {
    return { reason: 'no adb client was found (set ANDROID_HOME or put adb on the PATH)' };
  }
  let transport;
  let devices;
  try {
    transport = createAdbTransport({ adbPath });
    devices = transport.devices();
  } catch (e) {
    return { reason: `the adb client could not be started: ${e.message}` };
  }
  const usable = devices.find((d) => d.state === 'device');
  if (!usable) {
    return {
      reason: devices.length
        ? `no usable Android device: ${devices.map((d) => `${d.serial} (${d.state})`).join(', ')}`
        : 'no Android device is attached to adb',
    };
  }
  if (!fs.existsSync(APK)) {
    return { reason: `the smoke APK is missing: ${APK} (run tools/ats603-probes/build-smoke-app.sh)` };
  }
  return { reason: '', device: usable, adbPath };
}

const availability = deviceAvailability();
const skip = availability.reason || false;

// The session and the target of the run. The session proves every mobile
// capability -- the probe of the driver is what proves them, and the
// probe runs in the test below.
const target = defineTarget({
  targetId: 'tgt_emulator_it',
  kind: 'local-emulator',
  platform: 'android',
  capabilities: MOBILE_CAPABILITIES,
  declaredBy: 'user:tester',
});

function makeSession(capabilities = MOBILE_CAPABILITIES) {
  return defineSession({
    sessionId: 'ses_it_1',
    targetId: 'tgt_emulator_it',
    state: SESSION_STATE.CREATED,
    capabilities,
  });
}

/** The driver for the real device. */
function realDriver(capabilities = MOBILE_CAPABILITIES) {
  const transport = createAdbTransport({ adbPath: availability.adbPath });
  return createAndroidDriver({
    transport,
    session: makeSession(capabilities),
    target,
    registeredPackages: [PACKAGE],
    wait: { timeoutMs: 8000, intervalMs: 300 },
  });
}

/**
 * Install the fixture on the device.
 *
 * The package is UNINSTALLED first: the fixture is signed with a local
 * debug key, and a rebuild with a different key produces a different
 * signature -- `adb install -r` then refuses with
 * "INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package ... signatures do
 * not match". The uninstall makes the install independent of whatever
 * was on the device before.
 */
function installFixture() {
  const uninstall = spawnSync(availability.adbPath, ['-s', availability.device.serial, 'uninstall', PACKAGE], {
    encoding: 'utf8', timeout: 60000,
  });
  const install = spawnSync(availability.adbPath, ['-s', availability.device.serial, 'install', '-r', '-t', APK], {
    encoding: 'utf8', timeout: 120000,
  });
  if (install.status !== 0) {
    throw new Error(`the smoke fixture could not be installed: ${install.stdout} ${install.stderr}`);
  }
  void uninstall;
}

/** Force the app to the front, so the test starts from a known state. */
function resetApp() {
  execFileSync(availability.adbPath, ['-s', availability.device.serial, 'shell', 'am', 'force-stop', PACKAGE], {
    encoding: 'utf8', timeout: 30000,
  });
  execFileSync(availability.adbPath, ['-s', availability.device.serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME'], {
    encoding: 'utf8', timeout: 30000,
  });
}

/* ------------------------------------------------------------------ */
/* The device                                                          */
/* ------------------------------------------------------------------ */

test('IT-ATS603-001: the device is attached and answers', { skip }, () => {
  const transport = createAdbTransport({ adbPath: availability.adbPath });
  const devices = transport.devices();
  const device = devices.find((d) => d.state === 'device');
  assert.ok(device, 'the device is not usable');
  console.log(`IT-ATS603-001 serial=${device.serial} model=${device.model} sdk=${device.sdk}`);
});

test('IT-ATS603-002: the driver PROVES the device capabilities by trying them', { skip, timeout: 120000 }, async () => {
  const driver = realDriver();
  const probe = await driver.probeCapabilities();
  // The proof is per capability, and every proved one carries HOW it was
  // proven. An unproven capability is named with its reason.
  console.log(`IT-ATS603-002 proved=${JSON.stringify(probe.proved)} unproved=${JSON.stringify(probe.unproved)}`);
  for (const [name, evidence] of Object.entries(probe.evidence)) {
    assert.ok(evidence.length > 0, `${name} is proved without evidence`);
  }
  for (const name of ['app.launch', 'ui.hierarchy', 'screen.capture', 'log.read']) {
    assert.ok(probe.proved.includes(name), `${name} was not proved: ${probe.reasons[name] ?? ''}`);
  }
});

/* ------------------------------------------------------------------ */
/* The four step kinds                                                 */
/* ------------------------------------------------------------------ */

test('IT-ATS603-010: launchApp brings the app to the foreground', { skip, timeout: 120000 }, async () => {
  installFixture();
  resetApp();
  const driver = realDriver();
  const result = await driver.runStep({ kind: 'launchApp', args: { appId: PACKAGE }, raw: 'launchApp' });
  console.log(`IT-ATS603-010 status=${result.status} foreground=${JSON.stringify(result.detail.foreground ?? null)}`);
  assert.equal(result.status, STEP_STATUS.PASSED, result.error ? result.error.message : '');
  assert.equal(result.detail.foreground.package, PACKAGE);
});

test('IT-ATS603-011: tapOn taps the element and the next screen appears', { skip, timeout: 120000 }, async () => {
  installFixture();
  resetApp();
  const driver = realDriver();
  const launched = await driver.runStep({ kind: 'launchApp', args: { appId: PACKAGE }, raw: 'launchApp' });
  assert.equal(launched.status, STEP_STATUS.PASSED, launched.error ? launched.error.message : '');

  const tapped = await driver.runStep({ kind: 'tapOn', args: { text: 'Open Details' }, raw: 'tapOn "Open Details"' });
  console.log(`IT-ATS603-011 status=${tapped.status} point=${JSON.stringify(tapped.detail.point ?? null)} attempts=${tapped.detail.attempts ?? null}`);
  assert.equal(tapped.status, STEP_STATUS.PASSED, tapped.error ? tapped.error.message : '');
  assert.ok(tapped.detail.point, 'the tap has no point');
  // The tap really changed the screen: the detail screen is now visible.
  const after = await driver.runStep({
    kind: 'assertVisible',
    args: { text: 'ICHOR Detail Screen' },
    assertion: { visible: 'ICHOR Detail Screen' },
    raw: 'assertVisible "ICHOR Detail Screen"',
  });
  console.log(`IT-ATS603-011 after-tap status=${after.status}`);
  assert.equal(after.status, STEP_STATUS.PASSED, after.error ? after.error.message : '');
});

test('IT-ATS603-012: assertVisible names the element when the assertion fails', { skip, timeout: 120000 }, async () => {
  installFixture();
  resetApp();
  const driver = realDriver();
  await driver.runStep({ kind: 'launchApp', args: { appId: PACKAGE }, raw: 'launchApp' });

  // The element is NOT on the screen: the assertion must fail, and it
  // must fail with the element's NAME and not with a generic message.
  const failed = await driver.runStep({
    kind: 'assertVisible',
    args: { text: 'A Button That Does Not Exist' },
    assertion: { visible: 'A Button That Does Not Exist' },
    raw: 'assertVisible "A Button That Does Not Exist"',
  });
  console.log(`IT-ATS603-012 status=${failed.status} failure=${failed.error ? failed.error.failure : null}`);
  assert.equal(failed.status, STEP_STATUS.FAILED);
  assert.equal(failed.error.failure, MOBILE_FAILURE.ASSERTION_FAILED);
  assert.match(failed.error.message, /A Button That Does Not Exist/);
  // The hierarchy is the evidence of the search.
  assert.ok(failed.error.details.hierarchy.length > 0, 'the failure carries no view hierarchy');
});

test('IT-ATS603-013: takeScreenshot writes a PNG of the screen', { skip, timeout: 120000 }, async () => {
  installFixture();
  resetApp();
  const driver = realDriver();
  await driver.runStep({ kind: 'launchApp', args: { appId: PACKAGE }, raw: 'launchApp' });
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ats603-it-'));
  try {
    const result = await driver.runStep(
      { kind: 'takeScreenshot', args: { name: 'home' }, raw: 'screenshot home' },
      { evidenceRoot },
    );
    console.log(`IT-ATS603-013 status=${result.status} file=${result.detail.file ?? null} bytes=${result.detail.bytes ?? null} dims=${JSON.stringify(result.detail.dimensions ?? null)}`);
    assert.equal(result.status, STEP_STATUS.PASSED, result.error ? result.error.message : '');
    const file = path.join(evidenceRoot, result.detail.file);
    assert.ok(fs.existsSync(file), 'the screenshot file is missing');
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length > 1000, `the screenshot is suspiciously small: ${bytes.length} bytes`);
    // The PNG signature and the dimensions of the screen.
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    assert.equal(result.detail.dimensions.width, result.detail.screenSize.width);
    assert.equal(result.detail.dimensions.height, result.detail.screenSize.height);
  } finally {
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The whole Flow                                                      */
/* ------------------------------------------------------------------ */

test('IT-ATS603-020: a WHOLE Flow runs on the device and passes', { skip, timeout: 180000 }, async () => {
  installFixture();
  resetApp();
  const driver = realDriver();
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ats603-flow-'));
  try {
    const result = await driver.runCase({
      title: 'ATS-603 smoke flow',
      uid: 'tc-ats603-smoke',
      steps: [
        { kind: 'launchApp', args: { appId: PACKAGE }, raw: 'launchApp' },
        { kind: 'assertVisible', args: { text: 'ICHOR Smoke Home' }, assertion: { visible: 'ICHOR Smoke Home' }, raw: 'assertVisible "ICHOR Smoke Home"' },
        { kind: 'tapOn', args: { text: 'Open Details' }, raw: 'tapOn "Open Details"' },
        { kind: 'assertVisible', args: { text: 'ICHOR Detail Screen' }, assertion: { visible: 'ICHOR Detail Screen' }, raw: 'assertVisible "ICHOR Detail Screen"' },
        { kind: 'takeScreenshot', args: { name: 'detail' }, raw: 'screenshot detail' },
      ],
    }, { evidenceRoot });
    console.log(`IT-ATS603-020 status=${result.status} steps=${result.steps.map((s) => `${s.kind}:${s.status}`).join(',')}`);
    for (const s of result.steps) {
      console.log(`IT-ATS603-020 step ${s.kind} -> ${s.status}${s.error ? ` (${s.error.failure}: ${s.error.message.split('\n')[0]})` : ''}`);
    }
    assert.equal(result.status, STEP_STATUS.PASSED, result.error ? result.error.message : '');
    assert.equal(result.steps.length, 5);
    // The four step kinds of the acceptance criterion are all measured.
    const kinds = new Set(result.steps.map((s) => s.kind));
    for (const kind of ['launchApp', 'tapOn', 'assertVisible', 'takeScreenshot']) {
      assert.ok(kinds.has(kind), `the step kind ${kind} was not measured`);
    }
    // The screenshot of the run is on disk.
    assert.ok(fs.existsSync(path.join(evidenceRoot, 'screenshots', 'detail.png')));
  } finally {
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('IT-ATS603-021: a Flow that names a missing element fails with the ELEMENT, not generically', { skip, timeout: 120000 }, async () => {
  installFixture();
  resetApp();
  const driver = realDriver();
  await driver.runStep({ kind: 'launchApp', args: { appId: PACKAGE }, raw: 'launchApp' });
  const result = await driver.runStep({
    kind: 'tapOn',
    args: { text: 'No Such Button' },
    raw: 'tapOn "No Such Button"',
  });
  console.log(`IT-ATS603-021 status=${result.status} failure=${result.error ? result.error.failure : null}`);
  assert.equal(result.status, STEP_STATUS.FAILED);
  assert.equal(result.error.failure, MOBILE_FAILURE.ELEMENT_NOT_FOUND);
  assert.match(result.error.message, /No Such Button/);
  assert.ok(result.error.details.hierarchy.length > 0, 'the failure carries no view hierarchy');
});

test('IT-ATS603-022: the runner REFUSES an app the project did not register', { skip, timeout: 120000 }, async () => {
  installFixture();
  const transport = createAdbTransport({ adbPath: availability.adbPath });
  const driver = createAndroidDriver({
    transport,
    session: makeSession(),
    target,
    registeredPackages: [PACKAGE],
    wait: { timeoutMs: 2000, intervalMs: 300 },
  });
  const result = await driver.runStep({ kind: 'launchApp', args: { appId: 'com.android.settings' }, raw: 'launchApp' });
  console.log(`IT-ATS603-022 status=${result.status} failure=${result.error ? result.error.failure : null}`);
  assert.equal(result.status, STEP_STATUS.FAILED);
  assert.equal(result.error.failure, MOBILE_FAILURE.REFUSED);
});
