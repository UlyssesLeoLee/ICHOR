/**
 * ATS-601 unit tests: the mobile execution target and session contract.
 *
 * These are pure-logic tests: no device, no emulator, no ADB, no network.
 * They pin the rules the whole mobile execution face rests on:
 *
 *   - the three target kinds exist and each has a lifecycle policy;
 *   - the session state machine allows exactly idle->created->running->idle
 *     plus the error path into failed;
 *   - a missing target, an unconnected device or an expired lease is an
 *     EXPLICIT rejection, never a silent degradation;
 *   - the capability negotiation produces the gap list BEFORE the run;
 *   - `tapOn` without `ui.hierarchy` is unavailable, not degraded into a
 *     blind coordinate tap;
 *   - the security boundaries refuse an unregistered app package, an
 *     untrusted project, an unregistered session and an evidence path that
 *     points outside the evidence root.
 *
 * Catalog: UT-MOB-001..0xx in tools/generate_test_docs.py.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MOBILE_CAPABILITIES,
  MOBILE_CAPABILITY,
  MOBILE_REJECTION,
  MOBILE_STEP_KINDS,
  MOBILE_STEP_REQUIREMENTS,
  MobileTargetError,
  SESSION_STATE,
  SESSION_STATES,
  SESSION_TRANSITIONS,
  TARGET_KIND,
  TARGET_KIND_POLICY,
  TARGET_KINDS,
  assertRegisteredAppPackage,
  assertRegisteredSession,
  assertTrustedProject,
  canTransition,
  defineSession,
  defineTarget,
  isLeaseExpired,
  negotiateMobileCapabilities,
  reclaimExpiredSession,
  requireMobileCapabilities,
  resolveMobileEvidence,
  resolveSession,
  stepRequirements,
  transitionSession,
} from '../server/adapters/mobile-target.mjs';
import { REMOTE_CODES } from '../server/control-plane/errors.mjs';

const NOW = new Date('2026-11-06T00:00:00.000Z');
const FUTURE = '2026-11-06T01:00:00.000Z';
const PAST = '2026-11-05T23:00:00.000Z';

/** A target with every capability, so a test can remove one at a time. */
const ALL_CAPS = [...MOBILE_CAPABILITIES];

function target(overrides = {}) {
  return defineTarget({
    targetId: 'tgt_emulator_1',
    kind: TARGET_KIND.LOCAL_EMULATOR,
    platform: 'android',
    osVersion: '14',
    capabilities: ALL_CAPS,
    declaredBy: 'user:tester',
    ...overrides,
  });
}

function session(overrides = {}) {
  return defineSession({
    sessionId: 'ses_1',
    targetId: 'tgt_emulator_1',
    state: SESSION_STATE.CREATED,
    capabilities: ALL_CAPS,
    lastSeenAt: '2026-11-06T00:00:00.000Z',
    ...overrides,
  });
}

/* ------------------------------------------------------------------ */
/* The vocabulary                                                      */
/* ------------------------------------------------------------------ */

test('UT-MOB-001: the target kind vocabulary has exactly the three designed values', () => {
  assert.deepEqual([...TARGET_KINDS], ['local-emulator', 'local-device', 'remote-farm']);
});

test('UT-MOB-002: the session state vocabulary has exactly the four designed states', () => {
  assert.deepEqual([...SESSION_STATES], ['idle', 'created', 'running', 'failed']);
});

test('UT-MOB-003: the capability vocabulary is the seven designed capabilities', () => {
  assert.deepEqual([...MOBILE_CAPABILITIES].sort(), [
    'app.install', 'app.launch', 'log.read', 'screen.capture', 'screen.record',
    'ui.hierarchy', 'ui.tap',
  ]);
});

test('UT-MOB-004: every step kind declares what it needs', () => {
  assert.deepEqual([...MOBILE_STEP_KINDS], [
    'launchApp', 'tapOn', 'assertVisible', 'takeScreenshot', 'recordScreen', 'readLogs',
  ]);
  for (const kind of MOBILE_STEP_KINDS) {
    const spec = MOBILE_STEP_REQUIREMENTS[kind];
    assert.ok(spec, `${kind} has no requirement`);
    assert.ok(Array.isArray(spec.all) && Array.isArray(spec.any), `${kind} has a malformed spec`);
    for (const cap of [...spec.all, ...spec.any]) {
      assert.ok(MOBILE_CAPABILITIES.includes(cap), `${kind} requires ${cap}, which is outside the vocabulary`);
    }
  }
});

test('UT-MOB-005: a real device is borrowed, never owned or installed on', () => {
  const policy = TARGET_KIND_POLICY[TARGET_KIND.LOCAL_DEVICE];
  assert.equal(policy.platformOwnsLifecycle, false);
  assert.equal(policy.platformMayInstall, false);
  assert.equal(policy.leaseRequired, false);
});

test('UT-MOB-006: a farm device is lease-based and an emulator is platform-owned', () => {
  assert.equal(TARGET_KIND_POLICY[TARGET_KIND.REMOTE_FARM].leaseRequired, true);
  assert.equal(TARGET_KIND_POLICY[TARGET_KIND.LOCAL_EMULATOR].platformOwnsLifecycle, true);
  assert.equal(TARGET_KIND_POLICY[TARGET_KIND.LOCAL_EMULATOR].leaseRequired, false);
});

/* ------------------------------------------------------------------ */
/* Target and session construction                                      */
/* ------------------------------------------------------------------ */

test('UT-MOB-007: a target keeps its shape and is frozen', () => {
  const t = target({ capabilities: ['ui.tap', 'ui.tap', 'ui.hierarchy'] });
  assert.equal(t.targetId, 'tgt_emulator_1');
  assert.equal(t.kind, 'local-emulator');
  assert.equal(t.platform, 'android');
  assert.equal(t.osVersion, '14');
  assert.deepEqual([...t.capabilities], ['ui.hierarchy', 'ui.tap'], 'the duplicates are collapsed and sorted');
  assert.equal(t.declaredBy, 'user:tester');
  assert.ok(Object.isFrozen(t));
});

test('UT-MOB-008: an unknown target kind is refused', () => {
  assert.throws(() => target({ kind: 'cloud-phone' }), (e) => {
    assert.equal(e.code, 'MOBILE_TARGET_INVALID');
    assert.match(e.message, /unknown target kind/);
    return true;
  });
});

test('UT-MOB-009: a capability outside the vocabulary is refused', () => {
  assert.throws(() => target({ capabilities: ['ui.tap', 'ui.teleport'] }), (e) => {
    assert.equal(e.code, 'MOBILE_TARGET_INVALID');
    assert.match(e.message, /ui\.teleport/);
    return true;
  });
});

test('UT-MOB-010: a target that can do nothing is refused', () => {
  assert.throws(() => target({ capabilities: [] }), (e) => {
    assert.equal(e.code, 'MOBILE_TARGET_INVALID');
    assert.match(e.message, /no capabilities/);
    return true;
  });
});

test('UT-MOB-011: a target without an id or a platform is refused', () => {
  assert.throws(() => target({ targetId: '' }), (e) => e.code === 'MOBILE_TARGET_INVALID');
  assert.throws(() => target({ platform: '' }), (e) => e.code === 'MOBILE_TARGET_INVALID');
});

test('UT-MOB-011b: a target whose capability list is not a list is refused', () => {
  assert.throws(() => target({ capabilities: 'ui.tap' }), (e) => {
    assert.equal(e.code, 'MOBILE_TARGET_INVALID');
    assert.match(e.message, /capability list/);
    return true;
  });
});

test('UT-MOB-012b: a session without an id, a target or a capability list is refused', () => {
  assert.throws(() => session({ sessionId: '' }), (e) => e.code === 'MOBILE_SESSION_INVALID');
  assert.throws(() => session({ targetId: '' }), (e) => e.code === 'MOBILE_SESSION_INVALID');
  assert.throws(() => session({ capabilities: 'ui.tap' }), (e) => {
    assert.equal(e.code, 'MOBILE_SESSION_INVALID');
    assert.match(e.message, /capability list/);
    return true;
  });
});

test('UT-MOB-012: a session carries its identity, its state and its capability set', () => {
  const s = session();
  assert.equal(s.sessionId, 'ses_1');
  assert.equal(s.targetId, 'tgt_emulator_1');
  assert.equal(s.state, 'created');
  assert.deepEqual([...s.capabilities], [...ALL_CAPS].sort());
  assert.equal(s.lastSeenAt, '2026-11-06T00:00:00.000Z');
  assert.equal(s.error, null);
  assert.ok(Object.isFrozen(s));
});

test('UT-MOB-013: an unknown session state is refused', () => {
  assert.throws(() => session({ state: 'sleeping' }), (e) => {
    assert.equal(e.code, 'MOBILE_SESSION_INVALID');
    return true;
  });
});

test('UT-MOB-014: a session with a capability outside the vocabulary is refused', () => {
  assert.throws(() => session({ capabilities: ['screen.mirror'] }), (e) => {
    assert.equal(e.code, 'MOBILE_SESSION_INVALID');
    return true;
  });
});

/* ------------------------------------------------------------------ */
/* The state machine                                                   */
/* ------------------------------------------------------------------ */

test('UT-MOB-015: the state machine allows idle->created->running->idle', () => {
  assert.ok(canTransition(SESSION_STATE.IDLE, SESSION_STATE.CREATED));
  assert.ok(canTransition(SESSION_STATE.CREATED, SESSION_STATE.RUNNING));
  assert.ok(canTransition(SESSION_STATE.RUNNING, SESSION_STATE.IDLE));
});

test('UT-MOB-016: the error path goes into failed from created and from running', () => {
  assert.ok(canTransition(SESSION_STATE.CREATED, SESSION_STATE.FAILED));
  assert.ok(canTransition(SESSION_STATE.RUNNING, SESSION_STATE.FAILED));
});

test('UT-MOB-017: a session may not skip created, and failed is not left except to idle', () => {
  assert.equal(canTransition(SESSION_STATE.IDLE, SESSION_STATE.RUNNING), false);
  assert.equal(canTransition(SESSION_STATE.IDLE, SESSION_STATE.FAILED), false);
  assert.equal(canTransition(SESSION_STATE.RUNNING, SESSION_STATE.CREATED), false);
  assert.equal(canTransition(SESSION_STATE.FAILED, SESSION_STATE.RUNNING), false);
  assert.ok(canTransition(SESSION_STATE.FAILED, SESSION_STATE.IDLE));
});

test('UT-MOB-018: a legal transition moves the session and keeps its identity', () => {
  const s = session({ state: SESSION_STATE.IDLE });
  const created = transitionSession(s, SESSION_STATE.CREATED);
  assert.equal(created.state, 'created');
  assert.equal(created.sessionId, s.sessionId);
  assert.equal(created.targetId, s.targetId);
  assert.deepEqual([...created.capabilities], [...s.capabilities]);
});

test('UT-MOB-019: an illegal transition throws instead of silently moving', () => {
  const s = session({ state: SESSION_STATE.IDLE });
  assert.throws(() => transitionSession(s, SESSION_STATE.RUNNING), (e) => {
    assert.equal(e.code, 'MOBILE_SESSION_TRANSITION_INVALID');
    assert.deepEqual(e.details.allowed, ['created']);
    return true;
  });
});

test('UT-MOB-020: the failed state records WHY it failed', () => {
  const s = session({ state: SESSION_STATE.RUNNING });
  const failed = transitionSession(s, SESSION_STATE.FAILED, { error: 'adb: device offline' });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'adb: device offline');
});

test('UT-MOB-021: the transition table covers every state', () => {
  for (const state of SESSION_STATES) {
    assert.ok(Array.isArray(SESSION_TRANSITIONS[state]), `${state} has no transition list`);
    for (const to of SESSION_TRANSITIONS[state]) {
      assert.ok(SESSION_STATES.includes(to), `${state} -> ${to} leaves the vocabulary`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* The hard rejections                                                 */
/* ------------------------------------------------------------------ */

test('UT-MOB-022: a target that does not exist is rejected, not degraded', () => {
  assert.throws(() => resolveSession(null, session()), (e) => {
    assert.equal(e.code, MOBILE_REJECTION.TARGET_UNAVAILABLE);
    assert.equal(e.details.reason, 'target-not-found');
    return true;
  });
});

test('UT-MOB-023: a target without a session is rejected', () => {
  assert.throws(() => resolveSession(target(), null), (e) => {
    assert.equal(e.code, MOBILE_REJECTION.TARGET_UNAVAILABLE);
    assert.equal(e.details.reason, 'session-not-found');
    return true;
  });
});

test('UT-MOB-024: a session that belongs to another target is rejected', () => {
  assert.throws(() => resolveSession(target(), session({ targetId: 'tgt_other' })), (e) => {
    assert.equal(e.code, MOBILE_REJECTION.TARGET_UNAVAILABLE);
    assert.equal(e.details.reason, 'session-target-mismatch');
    return true;
  });
});

test('UT-MOB-025: a failed session is rejected', () => {
  const broken = session({ state: SESSION_STATE.FAILED, error: 'adb: device offline' });
  assert.throws(() => resolveSession(target(), broken), (e) => {
    assert.equal(e.code, MOBILE_REJECTION.TARGET_UNAVAILABLE);
    assert.equal(e.details.reason, 'session-failed');
    assert.equal(e.details.error, 'adb: device offline');
    return true;
  });
});

test('UT-MOB-026: an expired farm lease is rejected', () => {
  const t = target({ targetId: 'tgt_farm_1', kind: TARGET_KIND.REMOTE_FARM });
  const leased = session({ targetId: 'tgt_farm_1', leaseExpiresAt: PAST });
  assert.throws(() => resolveSession(t, leased, { now: NOW }), (e) => {
    assert.equal(e.code, MOBILE_REJECTION.TARGET_UNAVAILABLE);
    assert.equal(e.details.reason, 'lease-expired');
    return true;
  });
});

test('UT-MOB-027: a valid farm lease is accepted', () => {
  const t = target({ targetId: 'tgt_farm_1', kind: TARGET_KIND.REMOTE_FARM });
  const leased = session({ targetId: 'tgt_farm_1', leaseExpiresAt: FUTURE });
  assert.equal(resolveSession(t, leased, { now: NOW }).sessionId, 'ses_1');
});

test('UT-MOB-028: a farm session WITHOUT a lease expiry counts as expired', () => {
  const t = target({ targetId: 'tgt_farm_1', kind: TARGET_KIND.REMOTE_FARM });
  const unleased = session({ targetId: 'tgt_farm_1', leaseExpiresAt: null });
  assert.equal(isLeaseExpired(unleased, NOW), true);
  assert.throws(() => resolveSession(t, unleased, { now: NOW }),
    (e) => e.code === MOBILE_REJECTION.TARGET_UNAVAILABLE);
});

test('UT-MOB-029: an expired farm session is reclaimed back to idle', () => {
  const t = target({ targetId: 'tgt_farm_1', kind: TARGET_KIND.REMOTE_FARM });
  const leased = session({ targetId: 'tgt_farm_1', state: SESSION_STATE.RUNNING, leaseExpiresAt: PAST });
  const reclaimed = reclaimExpiredSession(t, leased, { now: NOW });
  assert.equal(reclaimed.state, 'idle');
  assert.equal(reclaimed.error, null);
});

test('UT-MOB-030: a live farm session is NOT reclaimed', () => {
  const t = target({ targetId: 'tgt_farm_1', kind: TARGET_KIND.REMOTE_FARM });
  const leased = session({ targetId: 'tgt_farm_1', state: SESSION_STATE.RUNNING, leaseExpiresAt: FUTURE });
  const reclaimed = reclaimExpiredSession(t, leased, { now: NOW });
  assert.equal(reclaimed.state, 'running', 'a live lease keeps its session');
});

test('UT-MOB-031: a local device is not reclaimed -- it has no lease', () => {
  const t = target({ targetId: 'tgt_phone_1', kind: TARGET_KIND.LOCAL_DEVICE });
  const s = session({ targetId: 'tgt_phone_1', leaseExpiresAt: PAST });
  assert.equal(reclaimExpiredSession(t, s, { now: NOW }).state, 'created');
});

test('UT-MOB-031b: a failed farm session IS reclaimed -- failed may only leave for idle', () => {
  // `failed` may only leave for `idle`, so the lease path CAN reclaim a
  // failed farm session: the device goes back to the pool instead of
  // staying stuck in `failed` forever.
  const t = target({ targetId: 'tgt_farm_1', kind: TARGET_KIND.REMOTE_FARM });
  const broken = session({
    targetId: 'tgt_farm_1',
    state: SESSION_STATE.FAILED,
    error: 'adb: device offline',
    leaseExpiresAt: PAST,
  });
  const reclaimed = reclaimExpiredSession(t, broken, { now: NOW });
  assert.equal(reclaimed.state, 'idle');
  assert.equal(reclaimed.error, null, 'a reclaimed session carries no error any more');
});

test('UT-MOB-032: both rejection codes are declared in the ONE rejection table', () => {
  for (const code of Object.values(MOBILE_REJECTION)) {
    assert.ok(REMOTE_CODES[code], `${code} is not in the control-plane rejection table`);
    assert.ok(code.startsWith('REMOTE_'), `${code} is outside the REMOTE_ namespace`);
  }
});

/* ------------------------------------------------------------------ */
/* Capability negotiation                                              */
/* ------------------------------------------------------------------ */

test('UT-MOB-033: launchApp needs one of app.install / app.launch', () => {
  assert.equal(stepRequirements('launchApp', ['app.install']).satisfied, true);
  assert.equal(stepRequirements('launchApp', ['app.launch']).satisfied, true);
  const neither = stepRequirements('launchApp', ['ui.tap']);
  assert.equal(neither.satisfied, false);
  assert.deepEqual(neither.missing.sort(), ['app.install', 'app.launch']);
});

test('UT-MOB-034: tapOn needs ui.tap AND ui.hierarchy', () => {
  assert.equal(stepRequirements('tapOn', ['ui.tap', 'ui.hierarchy']).satisfied, true);
  const noHierarchy = stepRequirements('tapOn', ['ui.tap']);
  assert.equal(noHierarchy.satisfied, false);
  assert.deepEqual(noHierarchy.missing, ['ui.hierarchy']);
});

test('UT-MOB-035: a tapOn without ui.hierarchy is refused with the blind-tap reason', () => {
  const r = stepRequirements('tapOn', ['ui.tap']);
  assert.match(r.reason, /ui\.hierarchy/);
  assert.match(r.reason, /blind tap/);
});

test('UT-MOB-036: the remaining step kinds map onto their capability', () => {
  assert.equal(stepRequirements('assertVisible', ['ui.hierarchy']).satisfied, true);
  assert.equal(stepRequirements('assertVisible', ['ui.tap']).satisfied, false);
  assert.equal(stepRequirements('takeScreenshot', ['screen.capture']).satisfied, true);
  assert.equal(stepRequirements('recordScreen', ['screen.record']).satisfied, true);
  assert.equal(stepRequirements('readLogs', ['log.read']).satisfied, true);
  assert.equal(stepRequirements('readLogs', ['ui.tap']).satisfied, false);
});

test('UT-MOB-037: an unknown step kind is a programming error, not a gap', () => {
  assert.throws(() => stepRequirements('swipe', ['ui.tap']), (e) => {
    assert.equal(e.code, 'MOBILE_STEP_UNKNOWN');
    return true;
  });
});

test('UT-MOB-038: the negotiation produces the gap list of THIS execution', () => {
  const s = session({ capabilities: ['app.launch', 'ui.tap', 'screen.capture'] });
  const r = negotiateMobileCapabilities(s, ['launchApp', 'tapOn', 'assertVisible', 'takeScreenshot']);
  assert.equal(r.supported, false);
  assert.deepEqual(r.unavailableSteps.sort(), ['assertVisible', 'tapOn']);
  const tapGap = r.gaps.find((g) => g.kind === 'tapOn');
  assert.deepEqual(tapGap.missing, ['ui.hierarchy']);
  assert.match(tapGap.reason, /ui\.hierarchy/);
});

test('UT-MOB-039: an execution whose steps are all supported negotiates cleanly', () => {
  const r = negotiateMobileCapabilities(session(), MOBILE_STEP_KINDS);
  assert.equal(r.supported, true);
  assert.deepEqual(r.gaps, []);
  assert.deepEqual(r.unavailableSteps, []);
});

test('UT-MOB-040: the gap list is computed against the SESSION, not against the target', () => {
  // The target claims everything; the session proves less. The gap must be
  // reported, because a declaration is not a proof.
  const t = target();
  const s = session({ capabilities: ['app.launch'] });
  assert.ok(t.capabilities.includes('ui.hierarchy'));
  const r = negotiateMobileCapabilities(s, ['tapOn']);
  assert.equal(r.supported, false);
  assert.deepEqual(r.gaps[0].missing.sort(), ['ui.hierarchy', 'ui.tap']);
});

test('UT-MOB-041: requireMobileCapabilities raises REMOTE_CAPABILITY_MISSING with the gaps', () => {
  const s = session({ capabilities: ['app.launch', 'ui.tap'] });
  assert.throws(() => requireMobileCapabilities(s, ['tapOn', 'takeScreenshot']), (e) => {
    assert.equal(e.code, MOBILE_REJECTION.CAPABILITY_MISSING);
    assert.equal(e.details.gaps.length, 2);
    assert.ok(e.details.gaps.some((g) => g.kind === 'tapOn'));
    assert.ok(e.details.gaps.some((g) => g.kind === 'takeScreenshot'));
    assert.match(e.message, /ui\.hierarchy/);
    return true;
  });
});

test('UT-MOB-042: requireMobileCapabilities returns the negotiation when nothing is missing', () => {
  const r = requireMobileCapabilities(session(), MOBILE_STEP_KINDS);
  assert.equal(r.supported, true);
});

/* ------------------------------------------------------------------ */
/* The security boundaries                                             */
/* ------------------------------------------------------------------ */

test('UT-MOB-043: only a registered app package may be launched', () => {
  assert.equal(assertRegisteredAppPackage(['com.example.app'], 'com.example.app'), 'com.example.app');
  assert.throws(() => assertRegisteredAppPackage(['com.example.app'], 'com.other.app'), (e) => {
    assert.equal(e.code, 'MOBILE_APP_PACKAGE_NOT_REGISTERED');
    return true;
  });
});

test('UT-MOB-044: an empty package name is refused', () => {
  assert.throws(() => assertRegisteredAppPackage(['com.example.app'], ''),
    (e) => e.code === 'MOBILE_APP_PACKAGE_INVALID');
});

test('UT-MOB-045: an untrusted project may not execute a mobile flow', () => {
  assert.equal(assertTrustedProject('trusted'), true);
  assert.throws(() => assertTrustedProject('untrusted'), (e) => {
    assert.equal(e.code, 'MOBILE_PROJECT_UNTRUSTED');
    return true;
  });
});

test('UT-MOB-046: only an explicitly registered session may be used', () => {
  const s = session();
  assert.equal(assertRegisteredSession(['ses_1'], s).sessionId, 'ses_1');
  assert.throws(() => assertRegisteredSession(['ses_other'], s), (e) => {
    assert.equal(e.code, 'MOBILE_SESSION_NOT_REGISTERED');
    return true;
  });
});

test('UT-MOB-047: an unregistered session is refused even when it is the right target', () => {
  assert.throws(() => assertRegisteredSession([], session()),
    (e) => e.code === 'MOBILE_SESSION_NOT_REGISTERED');
});

test('UT-MOB-048: evidence is resolved inside the root and hashed by the host', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats601-evidence-'));
  const file = path.join(root, 'shot.png');
  fs.writeFileSync(file, 'not-really-a-png');
  const record = resolveMobileEvidence(root, 'shot.png');
  assert.equal(record.file, 'shot.png');
  assert.equal(record.size, 16);
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  // The digest is the one of the file's CONTENT, and it is computed here --
  // a caller cannot hand in its own digest.
  const expected = createHash('sha256').update('not-really-a-png').digest('hex');
  assert.equal(record.sha256, expected);
  fs.rmSync(root, { recursive: true, force: true });
});

test('UT-MOB-049: an evidence path that escapes the root is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats601-evidence-'));
  fs.writeFileSync(path.join(root, 'ok.png'), 'x');
  assert.throws(() => resolveMobileEvidence(root, '../escape.png'), (e) => {
    assert.equal(e.code, 'MOBILE_EVIDENCE_PATH_FORBIDDEN');
    return true;
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('UT-MOB-050: a missing evidence file is reported, not hashed as empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats601-evidence-'));
  assert.throws(() => resolveMobileEvidence(root, 'absent.png'), (e) => {
    assert.equal(e.code, 'MOBILE_EVIDENCE_NOT_FOUND');
    return true;
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('UT-MOB-051: an empty evidence path is refused', () => {
  assert.throws(() => resolveMobileEvidence('/tmp', ''),
    (e) => e.code === 'MOBILE_EVIDENCE_PATH_INVALID');
});

test('UT-MOB-051b: an evidence path that is a directory is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats601-evidence-'));
  fs.mkdirSync(path.join(root, 'subdir'));
  assert.throws(() => resolveMobileEvidence(root, 'subdir'), (e) => {
    assert.equal(e.code, 'MOBILE_EVIDENCE_PATH_FORBIDDEN');
    return true;
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('UT-MOB-051c: an evidence symlink that points outside the root is refused', () => {
  // A screenshot that a device wrote may be a symlink; if it points out of
  // the evidence root, the containment check must refuse it too.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats601-evidence-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ats601-outside-'));
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, 'not yours');
  let linked = false;
  try {
    fs.symlinkSync(secret, path.join(root, 'link.txt'));
    linked = true;
  } catch {
    // A platform without symlink permission cannot run this case; the
    // containment rule is covered by UT-MOB-049 either way.
  }
  if (linked) {
    assert.throws(() => resolveMobileEvidence(root, 'link.txt'), (e) => {
      assert.equal(e.code, 'MOBILE_EVIDENCE_PATH_FORBIDDEN');
      return true;
    });
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* The honest boundary of the contract                                 */
/* ------------------------------------------------------------------ */

test('UT-MOB-052: the contract has no device driver -- it only decides', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'server', 'adapters', 'mobile-target.mjs'),
    'utf8',
  );
  // No ADB, no emulator, no child process, no network: the contract must
  // not be able to reach a device on its own. The real driver is ATS-603.
  // Only the IMPORT lines are inspected -- the prose legitimately talks
  // about emulators and ADB, because it describes what it refuses to do.
  const imports = source
    .split('\n')
    .filter((line) => /^\s*import\s/.test(line))
    .join('\n');
  for (const forbidden of ['node:child_process', 'node:net', 'node:http', 'node:tls']) {
    assert.equal(imports.includes(forbidden), false, `the contract imports ${forbidden}`);
  }
  // And it must not spawn anything by any other route either.
  assert.equal(/\bspawn(Sync)?\s*\(/.test(source), false, 'the contract spawns a process');
  assert.equal(/execSync|execFile|fork\(/.test(source), false, 'the contract executes a process');
});

test('UT-MOB-053: the rejection codes are the ones the design document names', () => {
  assert.equal(MOBILE_REJECTION.TARGET_UNAVAILABLE, 'REMOTE_TARGET_UNAVAILABLE');
  assert.equal(MOBILE_REJECTION.CAPABILITY_MISSING, 'REMOTE_CAPABILITY_MISSING');
});
