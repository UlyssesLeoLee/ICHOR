/**
 * ATS-601 unit tests: the mobile runner is an EXTENSION of the ATS-301
 * adapter contract, not a parallel contract.
 *
 * The point of these cases is the INTEGRATION, not the mobile semantics
 * (those live in tests/mobile-target.test.mjs):
 *
 *   - the mobile adapter is registered in the SAME registry as Playwright
 *     and WDIO and passes the SAME `assertAdapter` check;
 *   - an adapter WITHOUT a device section is unaffected by the device
 *     contract (the extension is additive and optional);
 *   - `negotiateWithDevice` negotiates both layers and keeps them apart,
 *     so a caller can tell an engine gap from a device gap;
 *   - the mobile adapter refuses to start -- it does not silently hand the
 *     caller a browser run instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADAPTER_CONTRACT_VERSION,
  DEVICE_CONTRACT_VERSION,
  AdapterError,
  assertAdapter,
  deviceCapability,
  negotiateDevice,
  negotiateWithDevice,
} from '../server/adapters/contract.mjs';
import { createMobileAdapter } from '../server/adapters/mobile.mjs';
import { getAdapter, listRunners, selectAdapter } from '../server/adapters/registry.mjs';
import {
  MOBILE_CAPABILITIES,
  MOBILE_REJECTION,
  SESSION_STATE,
  TARGET_KIND,
  defineSession,
  defineTarget,
} from '../server/adapters/mobile-target.mjs';

const project = { id: 'proj_ut', root: process.cwd() };

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

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

test('UT-MOB-054: the mobile runner is registered in the SAME registry', () => {
  const kinds = listRunners().map((r) => r.kind);
  assert.ok(kinds.includes('mobile'), 'the mobile runner is not in the registry');
  assert.equal(getAdapter('mobile').kind, 'mobile');
  // It is a THIRD adapter, not a replacement for the existing ones.
  assert.ok(kinds.includes('playwright'));
  assert.ok(kinds.includes('wdio'));
});

test('UT-MOB-055: the mobile adapter passes the SAME assertAdapter check', () => {
  const adapter = assertAdapter(createMobileAdapter());
  assert.equal(adapter.kind, 'mobile');
  assert.equal(adapter.contractVersion, ADAPTER_CONTRACT_VERSION);
  for (const op of ['discover', 'start', 'stop', 'collect']) {
    assert.equal(typeof adapter[op], 'function', `${op} is missing`);
  }
  assert.equal(typeof adapter.capabilities, 'function');
});

test('UT-MOB-056: the device section is OPTIONAL -- an engine-only adapter is unaffected', () => {
  // The two existing adapters have no device section, and they must keep
  // working exactly as before.
  const pw = getAdapter('playwright');
  assert.equal(pw.device, undefined);
  const negotiation = negotiateWithDevice(pw, project, {}, ['discover']);
  assert.equal(negotiation.deviceContractVersion, null);
  assert.equal(negotiation.device.supported, true, 'no device section means no device gap');
  assert.deepEqual(negotiation.device.missing, []);
});

test('UT-MOB-057: an adapter with a device section declares the device contract version', () => {
  const adapter = createMobileAdapter();
  assert.equal(adapter.device.contractVersion, DEVICE_CONTRACT_VERSION);
  assert.equal(typeof adapter.device.capabilities, 'function');
});

/* ------------------------------------------------------------------ */
/* The device negotiation                                              */
/* ------------------------------------------------------------------ */

test('UT-MOB-058: a device capability needs a reason when unsupported and evidence when supported', () => {
  assert.throws(() => deviceCapability('ui.tap', false, {}), (e) => {
    assert.equal(e.code, 'CAPABILITY_REASON_REQUIRED');
    return true;
  });
  assert.throws(() => deviceCapability('ui.tap', true, {}), (e) => {
    assert.equal(e.code, 'CAPABILITY_EVIDENCE_REQUIRED');
    return true;
  });
  const c = deviceCapability('ui.tap', true, { evidence: 'the session proved it' });
  assert.equal(c.supported, true);
  assert.equal(c.evidence, 'the session proved it');
});

test('UT-MOB-059: an unknown device capability is reported, not thrown', () => {
  const r = negotiateDevice([], ['ui.tap']);
  assert.equal(r.supported, false);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].kind, 'unknown');
  assert.match(r.missing[0].reason, /does not declare/);
});

test('UT-MOB-060: negotiateWithDevice keeps the engine gap and the device gap apart', () => {
  const adapter = createMobileAdapter({ target, session });
  // The mobile adapter has no driver, so the ENGINE layer fails; and the
  // device layer is asked for a capability the session does not have.
  const partial = defineSession({
    sessionId: 'ses_2',
    targetId: 'tgt_emulator_1',
    capabilities: ['app.launch'],
  });
  const adapter2 = createMobileAdapter({ target, session: partial });
  const r = negotiateWithDevice(adapter2, project, { session: partial }, ['discover']);
  assert.equal(r.supported, false);
  assert.ok(r.engine.missing.length > 0, 'the engine layer reports the missing driver');
  assert.ok(Array.isArray(r.device.missing));
  assert.ok(Array.isArray(r.missing));
  assert.equal(r.missing.length, r.engine.missing.length + r.device.missing.length);
});

test('UT-MOB-061: the device layer of the mobile adapter follows the SESSION', () => {
  const partial = defineSession({
    sessionId: 'ses_3',
    targetId: 'tgt_emulator_1',
    state: SESSION_STATE.CREATED,
    capabilities: ['app.launch', 'ui.tap'],
  });
  const adapter = createMobileAdapter({ target, session: partial });
  const entries = adapter.device.capabilities({ session: partial });
  const byName = new Map(entries.map((e) => [e.name, e]));
  assert.equal(byName.get('app.launch').supported, true);
  assert.equal(byName.get('ui.tap').supported, true);
  assert.equal(byName.get('ui.hierarchy').supported, false);
  assert.match(byName.get('ui.hierarchy').reason, /did not prove/);
  // A supported device capability carries the evidence of its proof.
  assert.match(byName.get('app.launch').evidence, /proved/);
});

/* ------------------------------------------------------------------ */
/* The refusal                                                         */
/* ------------------------------------------------------------------ */

test('UT-MOB-062: the mobile adapter refuses to start instead of running something else', () => {
  const adapter = createMobileAdapter({ target, session });
  for (const op of ['start', 'stop', 'collect', 'discover']) {
    assert.throws(() => adapter[op](), (e) => {
      assert.equal(e.code, MOBILE_REJECTION.TARGET_UNAVAILABLE);
      assert.equal(e.details.reason, 'no-driver');
      return true;
    });
  }
});

test('UT-MOB-063: the mobile adapter reports every engine capability as unsupported WITH a reason', () => {
  const adapter = createMobileAdapter({ target, session });
  const caps = adapter.capabilities(project);
  assert.ok(caps.length > 0);
  for (const c of caps) {
    assert.equal(c.supported, false, `${c.name} claims to be supported`);
    assert.ok(c.reason.length > 0, `${c.name} has no reason`);
  }
});

test('UT-MOB-064: the mobile adapter describes itself as a contract, not as a driver', () => {
  const d = createMobileAdapter({ target, session }).describe();
  assert.equal(d.designStatus, 'CONTRACT_ONLY');
  assert.equal(d.kind, 'mobile');
  assert.match(d.note, /ATS-603/);
});

test('UT-MOB-065: resolveDevice applies the hard rules on the adapter', () => {
  const adapter = createMobileAdapter({ target, session, registeredSessionIds: ['ses_1'] });
  const r = adapter.resolveDevice();
  assert.equal(r.session.sessionId, 'ses_1');
  assert.equal(r.target.targetId, 'tgt_emulator_1');
});

test('UT-MOB-066: resolveDevice refuses a session the user did not register', () => {
  const adapter = createMobileAdapter({ target, session, registeredSessionIds: ['ses_other'] });
  assert.throws(() => adapter.resolveDevice(), (e) => {
    assert.equal(e.code, 'MOBILE_SESSION_NOT_REGISTERED');
    return true;
  });
});

test('UT-MOB-067: resolveDevice refuses a missing target', () => {
  const adapter = createMobileAdapter({ target: null, session });
  assert.throws(() => adapter.resolveDevice(), (e) => {
    assert.equal(e.code, MOBILE_REJECTION.TARGET_UNAVAILABLE);
    return true;
  });
});

/* ------------------------------------------------------------------ */
/* The selection path                                                  */
/* ------------------------------------------------------------------ */

test('UT-MOB-068: the mobile runner is never silently chosen for a web project', () => {
  // The mobile adapter supports nothing, so a selection that asks for a
  // capability MUST reject rather than fall back to it.
  try {
    selectAdapter(project, ['discover', 'start']);
    // A runner that supports the request may legitimately be chosen --
    // but it must not be the mobile one, because it supports nothing.
  } catch (e) {
    assert.equal(e.code, 'NO_RUNNER_SUPPORTS_REQUEST');
  }
  const rejectedKinds = (() => {
    try {
      selectAdapter(project, ['filterByTestUid']);
      return [];
    } catch (e) {
      return e.details.rejected.map((r) => r.kind);
    }
  })();
  assert.ok(rejectedKinds.includes('mobile'), 'the mobile runner is not reported among the rejected ones');
});

test('UT-MOB-069: the mobile adapter source carries no driver of its own', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'server', 'adapters', 'mobile.mjs'),
    'utf8',
  );
  const imports = source.split('\n').filter((line) => /^\s*import\s/.test(line)).join('\n');
  for (const forbidden of ['node:child_process', 'node:net', 'node:http']) {
    assert.equal(imports.includes(forbidden), false, `the mobile adapter imports ${forbidden}`);
  }
  assert.equal(/\bspawn(Sync)?\s*\(/.test(source), false, 'the mobile adapter spawns a process');
});

test('UT-MOB-070: the device contract is additive -- the existing adapters keep their shape', () => {
  // The engine vocabulary did not change: the mobile capabilities are a
  // SEPARATE vocabulary, so no existing capability name moved.
  const pw = getAdapter('playwright');
  const names = pw.capabilities(project).map((c) => c.name);
  assert.ok(names.includes('discover'));
  assert.ok(names.includes('trace'));
  assert.equal(names.includes('ui.tap'), false, 'a device capability leaked into the engine vocabulary');
});

/* ------------------------------------------------------------------ */
/* The registration rule and the unusable session                      */
/* ------------------------------------------------------------------ */

test('UT-MOB-080: resolveDevice refuses a session when nothing was registered', () => {
  // The registration rule is `assertRegisteredSession`, and an empty list
  // means "the user registered nothing": no session may be used.
  for (const [label, opts] of [
    ['the list is omitted', { target, session }],
    ['the list is empty', { target, session, registeredSessionIds: [] }],
    ['the list is null', { target, session, registeredSessionIds: null }],
    ['the list is a string', { target, session, registeredSessionIds: 'ses_1' }],
  ]) {
    assert.throws(() => createMobileAdapter(opts).resolveDevice(), (e) => {
      assert.equal(e.code, 'MOBILE_SESSION_NOT_REGISTERED', label);
      return true;
    }, label);
  }
});

test('UT-MOB-081: a registered session that is connected and free still resolves', () => {
  // The control for UT-MOB-080: the rule refuses the UNREGISTERED
  // session, not every session.
  const adapter = createMobileAdapter({ target, session, registeredSessionIds: ['ses_1'] });
  const r = adapter.resolveDevice();
  assert.equal(r.session.sessionId, 'ses_1');
  assert.equal(r.target.targetId, 'tgt_emulator_1');
});

test('UT-MOB-082: resolveDevice refuses a session that is not connected or is occupied', () => {
  // The adapter path applies the same hard rules as `resolveSession`.
  for (const [state, reason] of [
    [SESSION_STATE.IDLE, 'device-not-connected'],
    [SESSION_STATE.RUNNING, 'device-occupied'],
  ]) {
    const s = defineSession({
      sessionId: 'ses_1',
      targetId: 'tgt_emulator_1',
      state,
      capabilities: MOBILE_CAPABILITIES,
    });
    assert.throws(
      () => createMobileAdapter({ target, session: s, registeredSessionIds: ['ses_1'] }).resolveDevice(),
      (e) => {
        assert.equal(e.code, MOBILE_REJECTION.TARGET_UNAVAILABLE);
        assert.equal(e.details.reason, reason);
        return true;
      },
      state,
    );
  }
});

test('UT-MOB-083: an unusable session proves nothing in the device layer', () => {
  // A failed session proves NOTHING: reporting a capability as supported
  // would carry the false evidence "the session ses_failed proved
  // ui.hierarchy". Every capability is unsupported, with the reason.
  const failed = defineSession({
    sessionId: 'ses_failed',
    targetId: 'tgt_emulator_1',
    state: SESSION_STATE.FAILED,
    error: 'adb: device offline',
    capabilities: MOBILE_CAPABILITIES,
  });
  const adapter = createMobileAdapter({ target, session: failed });
  const entries = adapter.device.capabilities({ session: failed });
  for (const e of entries) {
    assert.equal(e.supported, false, `${e.name} claims to be proved by a failed session`);
    assert.equal(e.evidence, '', `${e.name} carries evidence it never had`);
    assert.match(e.reason, /not usable/);
    assert.match(e.reason, /failed/);
  }
  // And the same holds for a session that is not connected or occupied.
  for (const state of [SESSION_STATE.IDLE, SESSION_STATE.RUNNING]) {
    const s = defineSession({
      sessionId: 'ses_x',
      targetId: 'tgt_emulator_1',
      state,
      capabilities: MOBILE_CAPABILITIES,
    });
    for (const e of createMobileAdapter({ target, session: s }).device.capabilities({ session: s })) {
      assert.equal(e.supported, false, `${e.name} claims to be proved by a ${state} session`);
      assert.equal(e.evidence, '');
    }
  }
});

test('UT-MOB-084: negotiateWithDevice reports no device capability for a failed session', () => {
  const failed = defineSession({
    sessionId: 'ses_failed',
    targetId: 'tgt_emulator_1',
    state: SESSION_STATE.FAILED,
    error: 'adb: device offline',
    capabilities: MOBILE_CAPABILITIES,
  });
  const adapter = createMobileAdapter({ target, session: failed });
  const negotiation = negotiateWithDevice(
    adapter,
    project,
    { session: failed, requested: ['ui.hierarchy'] },
    [],
  );
  assert.equal(negotiation.device.supported, false);
  const missing = negotiation.device.missing.find((m) => m.name === 'ui.hierarchy');
  assert.ok(missing, 'the missing device capability is not reported');
  assert.equal(missing.evidence, '');
});

test('UT-MOB-085: the device layer of a session with no session at all is unsupported', () => {
  const adapter = createMobileAdapter();
  for (const e of adapter.device.capabilities({})) {
    assert.equal(e.supported, false, `${e.name} claims to be proved without a session`);
    assert.match(e.reason, /not usable/);
  }
});

test('UT-MOB-086: the adapter describes itself with and without a target', () => {
  // `describe()` reports the target kind and the session id when the
  // adapter carries them, and null when it carries neither.
  const withTarget = createMobileAdapter({ target, session }).describe();
  assert.equal(withTarget.targetKind, target.kind);
  assert.equal(withTarget.sessionId, 'ses_1');
  const bare = createMobileAdapter().describe();
  assert.equal(bare.targetKind, null);
  assert.equal(bare.sessionId, null);
});

test('UT-MOB-087: the device layer follows the session it is given', () => {
  // The context session wins over the adapter's own session: the caller
  // asks about a specific device.
  const own = defineSession({
    sessionId: 'ses_own',
    targetId: 'tgt_emulator_1',
    state: SESSION_STATE.CREATED,
    capabilities: ['app.launch'],
  });
  const asked = defineSession({
    sessionId: 'ses_asked',
    targetId: 'tgt_emulator_1',
    state: SESSION_STATE.CREATED,
    capabilities: ['ui.tap'],
  });
  const adapter = createMobileAdapter({ target, session: own });
  const entries = adapter.device.capabilities({ session: asked });
  const byName = new Map(entries.map((e) => [e.name, e]));
  assert.equal(byName.get('ui.tap').supported, true, 'the asked session did not decide');
  assert.equal(byName.get('app.launch').supported, false, 'the own session decided');
  // Without a context session the adapter falls back to its own.
  const fallback = adapter.device.capabilities({});
  assert.equal(new Map(fallback.map((e) => [e.name, e])).get('app.launch').supported, true);
});

/* ------------------------------------------------------------------ */
/* The device layer and the target declaration                        */
/* ------------------------------------------------------------------ */

test('UT-MOB-090: the device layer does not report an undeclared capability as proved', () => {
  // A session that claims a capability its TARGET never declared has
  // proved nothing: the claim was never proven. The device layer must
  // not report it as supported, and it must not attach the "proved"
  // evidence -- otherwise the device layer and the resolve path give
  // opposite answers about ONE session.
  const narrow = defineTarget({
    targetId: 'tgt_narrow',
    kind: TARGET_KIND.LOCAL_EMULATOR,
    platform: 'android',
    capabilities: ['screen.capture'],
  });
  const wide = defineSession({
    sessionId: 'ses_wide',
    targetId: 'tgt_narrow',
    state: SESSION_STATE.CREATED,
    capabilities: MOBILE_CAPABILITIES,
  });
  const adapter = createMobileAdapter({ target: narrow, session: wide });
  const entries = adapter.device.capabilities({ session: wide });
  const byName = new Map(entries.map((e) => [e.name, e]));
  for (const name of ['ui.hierarchy', 'ui.tap', 'app.launch']) {
    const e = byName.get(name);
    assert.equal(e.supported, false, `${name} was never declared by the target, so it was never proved`);
    assert.equal(e.evidence, '', `${name} carries evidence it never had`);
    assert.match(e.reason, /not declared by target/);
  }
  // The declared capability is still proved by the same session.
  assert.equal(byName.get('screen.capture').supported, true);
  assert.match(byName.get('screen.capture').evidence, /proved/);
});

test('UT-MOB-091: the device layer and the resolve path agree about one session', () => {
  // The same over-claiming session, seen through the two paths: the
  // resolve path refuses it, and the device layer reports the
  // undeclared capability as unsupported. The two must not contradict
  // each other.
  const narrow = defineTarget({
    targetId: 'tgt_narrow',
    kind: TARGET_KIND.LOCAL_EMULATOR,
    platform: 'android',
    capabilities: ['screen.capture'],
  });
  const wide = defineSession({
    sessionId: 'ses_wide',
    targetId: 'tgt_narrow',
    state: SESSION_STATE.CREATED,
    capabilities: MOBILE_CAPABILITIES,
  });
  const adapter = createMobileAdapter({ target: narrow, session: wide, registeredSessionIds: ['ses_wide'] });
  assert.throws(() => adapter.resolveDevice(), (e) => {
    assert.equal(e.code, MOBILE_REJECTION.CAPABILITY_MISSING);
    assert.equal(e.details.reason, 'session-capability-undeclared');
    return true;
  });
  const negotiation = negotiateWithDevice(
    adapter,
    project,
    { session: wide, target: narrow, requested: ['ui.hierarchy'] },
    [],
  );
  assert.equal(negotiation.device.supported, false);
  const missing = negotiation.device.missing.find((m) => m.name === 'ui.hierarchy');
  assert.ok(missing, 'the undeclared capability is not reported as missing');
  assert.equal(missing.evidence, '');
});

test('UT-MOB-092: the device layer judges the target the caller asks about', () => {
  // The target in the CALLER's context decides what may be proved. A
  // session of another target proves nothing for it, and a capability
  // that target declared but the session does not claim is not proved
  // either.
  const narrow = defineTarget({
    targetId: 'tgt_narrow',
    kind: TARGET_KIND.LOCAL_EMULATOR,
    platform: 'android',
    capabilities: ['screen.capture'],
  });
  const other = defineSession({
    sessionId: 'ses_other',
    targetId: 'tgt_elsewhere',
    state: SESSION_STATE.CREATED,
    capabilities: MOBILE_CAPABILITIES,
  });
  const adapter = createMobileAdapter({ target, session: other });
  const entries = adapter.device.capabilities({ session: other, target: narrow });
  for (const e of entries) {
    assert.equal(e.supported, false, `${e.name} was proved for a session of another target`);
    assert.equal(e.evidence, '');
  }
});

test('UT-MOB-093: a capability the target declared but the session did not prove stays unsupported', () => {
  // The control for UT-MOB-090: the rule refuses the UNDECLARED claim,
  // not every claim. A session that proves exactly what the target
  // declared is still reported as proved.
  const narrow = defineTarget({
    targetId: 'tgt_narrow',
    kind: TARGET_KIND.LOCAL_EMULATOR,
    platform: 'android',
    capabilities: ['screen.capture', 'ui.tap'],
  });
  const within = defineSession({
    sessionId: 'ses_within',
    targetId: 'tgt_narrow',
    state: SESSION_STATE.CREATED,
    capabilities: ['screen.capture'],
  });
  const adapter = createMobileAdapter({ target: narrow, session: within });
  const byName = new Map(adapter.device.capabilities({ session: within }).map((e) => [e.name, e]));
  assert.equal(byName.get('screen.capture').supported, true);
  assert.equal(byName.get('ui.tap').supported, false);
  assert.match(byName.get('ui.tap').reason, /did not prove/);
});

test('UT-MOB-094: the device layer reports rather than throws when there is no target', () => {
  // The ATS-301 contract: `capabilities()` is DATA and never throws for a
  // missing capability. Without a target nothing is declared, so the
  // session proves nothing -- and the layer says so instead of failing.
  const orphan = defineSession({
    sessionId: 'ses_orphan',
    targetId: 'tgt_emulator_1',
    state: SESSION_STATE.CREATED,
    capabilities: MOBILE_CAPABILITIES,
  });
  for (const e of createMobileAdapter({ target: null, session: orphan }).device.capabilities({ session: orphan })) {
    assert.equal(e.supported, false, `${e.name} was proved without a target`);
    assert.equal(e.evidence, '');
    assert.ok(e.reason.length > 0, `${e.name} has no reason`);
  }
});
