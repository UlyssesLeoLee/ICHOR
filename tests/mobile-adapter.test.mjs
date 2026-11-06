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
