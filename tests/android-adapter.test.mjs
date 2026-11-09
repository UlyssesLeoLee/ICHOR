/**
 * ATS-603: the ADAPTER tests -- the Android driver as the Bridge sees it.
 *
 * WHAT THESE TESTS PROVE
 * ----------------------
 * The driver (tests/android-runner.test.mjs) is the step semantics. These
 * tests are the ADAPTER: the ATS-301 contract, the registry, the device
 * layer and the run lifecycle.
 *
 * The most important of them is the lifecycle one, because the Bridge
 * calls `adapter.start()` SYNCHRONOUSLY and then reads the handle as if a
 * process had been spawned:
 *
 *   * `handle.child.pid`      -- there is NO process, so the pid is 0;
 *   * `handle.child.stdout`   -- the log stream;
 *   * `handle.child.on('close')` -- the completion signal, with the exit
 *     code the bridge turns into the run's status.
 *
 * An adapter that returned a promise, or a handle without a `child`, or
 * a `child` that never emits `close`, would break every run started
 * through the Bridge -- and the failure would show up as a run stuck in
 * `running` for ever. So it is measured here, not assumed.
 *
 * The tests use the FAKE ADB transport: they measure the adapter, not
 * the device. The device is exercised by tests/android-runner-it.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ADAPTER_CONTRACT_VERSION, DEVICE_CONTRACT_VERSION, assertAdapter, negotiateWithDevice } from '../server/adapters/contract.mjs';
import { createAndroidAdapter } from '../server/adapters/android-adapter.mjs';
import { createFakeAdb } from '../server/adapters/android-adb.mjs';
import { getAdapter, listRunners, selectAdapter } from '../server/adapters/registry.mjs';
import {
  MOBILE_CAPABILITIES,
  MOBILE_REJECTION,
  SESSION_STATE,
  TARGET_KIND,
  defineSession,
  defineTarget,
} from '../server/adapters/mobile-target.mjs';

const target = defineTarget({
  targetId: 'tgt_emulator_1',
  kind: TARGET_KIND.LOCAL_EMULATOR,
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

/** A project with one mobile Flow file. */
function mobileProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats603-adapter-'));
  fs.mkdirSync(path.join(dir, 'flows'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"ats603-adapter","private":true}', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'flows', 'smoke.yaml'),
    `appId: com.ichor.smoke
---
- name: Smoke flow
  steps:
    - launchApp:
        appId: com.ichor.smoke
    - assertVisible: "ICHOR Smoke Home"
`,
    'utf8',
  );
  return dir;
}

/** A project with NO mobile case. */
function webProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats603-web-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"ats603-web","private":true}', 'utf8');
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'a.spec.ts'), "test('x', async () => {});\n", 'utf8');
  return dir;
}

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

test('UT-ATS603-050: the android runner is a FOURTH adapter in the SAME registry', () => {
  const kinds = listRunners().map((r) => r.kind);
  assert.ok(kinds.includes('android'), 'the android runner is not in the registry');
  // The ATS-601 contract skeleton is still there under its OWN kind: the
  // driver must not overwrite it.
  assert.ok(kinds.includes('mobile'), 'the mobile contract runner disappeared');
  assert.equal(getAdapter('mobile').kind, 'mobile');
  assert.equal(getAdapter('android').kind, 'android');
});

test('UT-ATS603-051: the android adapter passes the SAME assertAdapter check', () => {
  const adapter = assertAdapter(createAndroidAdapter({ transport: createFakeAdb() }));
  assert.equal(adapter.kind, 'android');
  assert.equal(adapter.contractVersion, ADAPTER_CONTRACT_VERSION);
  for (const op of ['discover', 'start', 'stop', 'collect']) {
    assert.equal(typeof adapter[op], 'function', `${op} is missing`);
  }
  assert.equal(adapter.device.contractVersion, DEVICE_CONTRACT_VERSION);
});

test('UT-ATS603-052: the android adapter is NOT chosen for a project without mobile cases', () => {
  const dir = webProject();
  try {
    const project = { id: 'p_web', root: dir };
    const adapter = createAndroidAdapter({ transport: createFakeAdb() });
    const caps = adapter.capabilities(project);
    const start = caps.find((c) => c.name === 'start');
    // The capability is UNSUPPORTED -- with the reason -- because the
    // project holds no mobile case. The selection is capability-driven,
    // so an unsupported `start` keeps the adapter out of the selection.
    assert.equal(start.supported, false);
    assert.match(start.reason, /mobile/i);
    // The runner is NOT selected for a web project. On a web project
    // WITHOUT an installed engine no runner can satisfy the request at
    // all, and the android runner is among the rejected ones -- with the
    // reason that says the project holds no mobile case.
    const rejected = (() => {
      try {
        selectAdapter(project, ['discover', 'start']);
        return [];
      } catch (e) {
        assert.equal(e.code, 'NO_RUNNER_SUPPORTS_REQUEST');
        return e.details.rejected;
      }
    })();
    const android = rejected.find((r) => r.kind === 'android');
    assert.ok(android, 'the android runner is not reported among the rejected ones');
    // The reason says WHY: not "the runner is broken", but "there is
    // nothing mobile to run".
    assert.match(android.missing[0].reason, /no mobile Flow case/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UT-ATS603-053: the android adapter IS chosen for a project with mobile cases', () => {
  const dir = mobileProject();
  try {
    const project = { id: 'p_mob', root: dir };
    const adapter = createAndroidAdapter({ transport: createFakeAdb() });
    const start = adapter.capabilities(project).find((c) => c.name === 'start');
    assert.equal(start.supported, true, start.reason);
    assert.match(start.evidence, /mobile case/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The device layer                                                    */
/* ------------------------------------------------------------------ */

test('UT-ATS603-054: the device layer follows the SESSION, not the target', () => {
  const adapter = createAndroidAdapter({ transport: createFakeAdb(), target, session });
  const entries = adapter.device.capabilities({ target, session });
  assert.equal(entries.length, MOBILE_CAPABILITIES.length);
  for (const e of entries) {
    assert.equal(e.supported, true, `${e.name} is not proved`);
    assert.ok(e.evidence.length > 0);
  }
  // A session that cannot be used proves NOTHING.
  const idle = defineSession({
    sessionId: 'ses_1', targetId: 'tgt_emulator_1', state: SESSION_STATE.IDLE, capabilities: MOBILE_CAPABILITIES,
  });
  const unusable = adapter.device.capabilities({ target, session: idle });
  for (const e of unusable) {
    assert.equal(e.supported, false, `${e.name} claims to be proved by an unusable session`);
    assert.ok(e.reason.length > 0);
  }
});

test('UT-ATS603-055: the adapter refuses to start without a registered session', () => {
  const adapter = createAndroidAdapter({
    transport: createFakeAdb(), target, session, registeredSessionIds: ['ses_other'],
  });
  assert.throws(() => adapter.resolveDevice(), (e) => {
    assert.equal(e.code, 'MOBILE_SESSION_NOT_REGISTERED');
    return true;
  });
});

/* ------------------------------------------------------------------ */
/* The run lifecycle                                                   */
/* ------------------------------------------------------------------ */

test('UT-ATS603-060: start() returns a handle the BRIDGE can use', async () => {
  const dir = mobileProject();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ats603-run-'));
  try {
    const transport = createFakeAdb({
      answers: [
        // pm list packages
        'package:com.ichor.smoke\n',
        // am start -W
        'Status: ok\n',
        // dumpsys window
        '  mCurrentFocus=Window{abc u0 com.ichor.smoke/com.ichor.smoke.MainActivity}\n',
        // uiautomator dump
        '<hierarchy rotation="0"><node bounds="[0,0][1080,2400]" text="ICHOR Smoke Home" class="android.widget.TextView" package="com.ichor.smoke" content-desc="ICHOR Smoke Home" /></hierarchy>',
      ],
    });
    const adapter = createAndroidAdapter({
      transport,
      target,
      session,
      registeredSessionIds: ['ses_1'],
      registeredPackages: ['com.ichor.smoke'],
    });

    // The Bridge calls this SYNCHRONOUSLY. A promise here would break
    // every run started through the Bridge.
    const handle = adapter.start({
      project: { id: 'p_mob', root: dir },
      run: { id: 'run_1' },
      outputDir: out,
    });
    assert.equal(typeof handle.then, 'undefined', 'start() must not return a promise');
    assert.ok(handle.child, 'the handle has no child');
    assert.equal(handle.pid, 0, 'there is no process, so the pid must be 0');
    assert.ok(handle.child.stdout, 'the handle has no stdout');
    assert.ok(handle.child.stderr, 'the handle has no stderr');
    assert.equal(typeof handle.child.on, 'function', 'the child is not an emitter');

    // The bridge waits for the close event, and reads the exit code from
    // it. The run must end, or the run stays `running` for ever.
    const code = await new Promise((resolve) => handle.child.on('close', resolve));
    assert.equal(code, 0, 'the run did not pass');
    assert.equal(handle.summary.passed, 1);
    assert.equal(handle.summary.failed, 0);
    // The report file is written, so the bridge can archive it.
    assert.ok(fs.existsSync(path.join(out, 'run_1-android-report.json')));
    // And collect() reads it back.
    const collected = adapter.collect({ outputDir: out });
    assert.equal(collected.summary.passed, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('UT-ATS603-061: a failing case ends the run with a NON-ZERO exit code', async () => {
  const dir = mobileProject();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ats603-run-'));
  try {
    // The hierarchy does NOT carry the element the case asserts. The
    // answer is a FUNCTION, because the element search reads the tree
    // REPEATEDLY while it waits: a fixed list would run out and the
    // test would measure "the fake ran out of answers" instead of
    // "the assertion failed".
    const treeWithout = '<hierarchy rotation="0"><node bounds="[0,0][1080,2400]" text="Something Else" class="android.widget.TextView" package="com.ichor.smoke" content-desc="Something Else" /></hierarchy>';
    const transport = createFakeAdb({
      answers: [
        'package:com.ichor.smoke\n',
        'Status: ok\n',
        '  mCurrentFocus=Window{abc u0 com.ichor.smoke/com.ichor.smoke.MainActivity}\n',
        () => treeWithout,
      ],
    });
    const adapter = createAndroidAdapter({
      transport,
      target,
      session,
      registeredSessionIds: ['ses_1'],
      registeredPackages: ['com.ichor.smoke'],
    });
    const handle = adapter.start({
      project: { id: 'p_mob', root: dir },
      run: { id: 'run_2' },
      outputDir: out,
    });
    const code = await new Promise((resolve) => handle.child.on('close', resolve));
    assert.equal(code, 1, 'a failed run must exit non-zero');
    assert.equal(handle.summary.failed, 1);
    // The failure names the element and carries the hierarchy.
    const failure = handle.error;
    assert.ok(failure, 'the failure was lost');
    assert.equal(failure.failure, 'assertion-failed');
    assert.match(failure.message, /ICHOR Smoke Home/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('UT-ATS603-062: the adapter discovers the mobile cases of the project', () => {
  const dir = mobileProject();
  try {
    const adapter = createAndroidAdapter({ transport: createFakeAdb() });
    const result = adapter.discover({ id: 'p_mob', root: dir });
    assert.equal(result.runner, 'android');
    assert.equal(result.tests.length, 1);
    assert.equal(result.tests[0].title, 'Smoke flow');
    assert.equal(result.tests[0].engine, 'mobile');
    assert.ok(result.tests[0].steps.length >= 1);
    assert.deepEqual(result.files, ['flows/smoke.yaml']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UT-ATS603-063: the adapter describes itself honestly', () => {
  const adapter = createAndroidAdapter({ transport: createFakeAdb(), target, session });
  const d = adapter.describe();
  assert.equal(d.kind, 'android');
  // The fake device answers, so the adapter reports a driver.
  assert.equal(d.designStatus, 'DRIVER');
  assert.ok(d.note.length > 0);
});

test('UT-ATS603-064: negotiateWithDevice keeps the engine gap and the device gap apart', () => {
  const dir = mobileProject();
  try {
    const adapter = createAndroidAdapter({ transport: createFakeAdb(), target, session });
    // The project MUST hold mobile cases: without them the engine layer
    // reports `discover` as unsupported, and the test would measure the
    // wrong thing.
    //
    // The two layers are negotiated against DIFFERENT vocabularies: the
    // engine layer against the ATS-301 capability names, the device layer
    // against the MOBILE capability names (`ui.tap`, `screen.capture`,
    // ...). Asking the device layer for `discover` -- an engine name --
    // is reported as an unknown device capability, which is the correct
    // behaviour and NOT a gap of the device.
    const negotiation = negotiateWithDevice(
      adapter,
      { id: 'p_mob', root: dir },
      { target, session },
      ['discover'],
    );
    assert.equal(negotiation.adapter, 'android');
    assert.equal(negotiation.engine.supported, true);
    // The two layers are separate results.
    assert.ok(negotiation.engine);
    assert.ok(negotiation.device);
    // The engine name is NOT a device capability, so it is reported as
    // unknown -- the device layer is not the one that is missing it.
    assert.equal(negotiation.device.missing[0].name, 'discover');
    assert.equal(negotiation.device.missing[0].kind, 'unknown');

    // The DEVICE layer, negotiated against the device vocabulary, is
    // satisfied by the session that proved the capabilities.
    const deviceNegotiation = negotiateWithDevice(
      adapter,
      { id: 'p_mob', root: dir },
      { target, session, requested: ['ui.tap', 'screen.capture'] },
      ['start'],
    );
    assert.equal(deviceNegotiation.device.supported, true);
    assert.deepEqual(deviceNegotiation.device.missing, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UT-ATS603-065: the adapter refuses a run without an evidence root', () => {
  const dir = mobileProject();
  try {
    const adapter = createAndroidAdapter({
      transport: createFakeAdb(), target, session, registeredSessionIds: ['ses_1'],
    });
    assert.throws(() => adapter.start({
      project: { id: 'p_mob', root: dir },
      run: { id: 'run_3' },
      outputDir: null,
    }), (e) => {
      assert.equal(e.code, MOBILE_REJECTION.TARGET_UNAVAILABLE);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
