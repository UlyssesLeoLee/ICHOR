#!/usr/bin/env node
/**
 * ATS-601 evidence probe: the three hard rules of the mobile contract, shown
 * as they actually behave.
 *
 * The unit tests (UT-MOB-*) assert the rules one by one. This probe shows
 * the three rules that the whole delivery stands on, side by side, on ONE
 * fake target and ONE fake session:
 *
 *   1. NO SILENT DEGRADATION -- a caller that asked for a mobile run gets
 *      an EXPLICIT rejection, and never a browser run instead. The probe
 *      shows what the registry does with the mobile adapter in it.
 *   2. NO BLIND TAP -- `tapOn` without `ui.hierarchy` is UNAVAILABLE; the
 *      negotiation says why instead of letting a coordinate tap happen.
 *   3. NO STALE LEASE -- an expired farm lease is refused AND reclaimed,
 *      because a lease that is not reclaimed keeps a device hostage.
 *
 * Everything here runs against fake targets and fake sessions. There is NO
 * device, NO emulator and NO ADB in this probe -- that is the point of
 * ATS-601: the contract is testable without hardware.
 *
 * Usage: node tools/ats601-probes/probe-mobile-contract.mjs
 */
import {
  MOBILE_CAPABILITIES,
  MOBILE_REJECTION,
  SESSION_STATE,
  TARGET_KIND,
  defineSession,
  defineTarget,
  negotiateMobileCapabilities,
  reclaimExpiredSession,
  resolveSession,
} from '../../server/adapters/mobile-target.mjs';
import { getAdapter, listRunners, selectAdapter } from '../../server/adapters/registry.mjs';

const NOW = new Date('2026-11-06T00:00:00.000Z');
const PAST = '2026-11-05T23:00:00.000Z';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

const target = defineTarget({
  targetId: 'tgt_emulator_1',
  kind: TARGET_KIND.LOCAL_EMULATOR,
  platform: 'android',
  osVersion: '14',
  capabilities: MOBILE_CAPABILITIES,
  declaredBy: 'user:tester',
});

const session = defineSession({
  sessionId: 'ses_1',
  targetId: 'tgt_emulator_1',
  state: SESSION_STATE.CREATED,
  capabilities: MOBILE_CAPABILITIES,
});

console.log('=== ATS-601 probe: the mobile target/session contract ===');
console.log('  (fake targets and fake sessions; no device, no emulator, no ADB)');
console.log('');

// --- 1. no silent degradation -------------------------------------------------
console.log('--- 1. a mobile run is refused explicitly, never run as a browser ---');
const mobile = getAdapter('mobile');
check('the mobile runner is registered in the SAME registry',
  listRunners().map((r) => r.kind).join(',') === 'playwright,wdio,mobile');

let refused = null;
try {
  mobile.start({ project: { id: 'p', root: '.' }, run: {} });
} catch (e) {
  refused = e;
}
check('the mobile adapter refuses to start',
  refused !== null && refused.code === MOBILE_REJECTION.TARGET_UNAVAILABLE,
  refused ? `code=${refused.code} reason=${refused.details && refused.details.reason}` : 'it did not refuse');
check('the refusal names the reason (no driver yet)',
  refused && refused.details && refused.details.reason === 'no-driver');

let chosen = null;
let rejected = null;
try {
  chosen = selectAdapter({ id: 'p', root: '.' }, ['discover', 'start']);
} catch (e) {
  rejected = e;
}
check('an unsatisfiable request reports EVERY runner it tried, mobile included',
  rejected && rejected.details.rejected.some((r) => r.kind === 'mobile'),
  rejected ? rejected.details.rejected.map((r) => r.kind).join(',') : 'a runner was chosen');
check('the mobile runner was NOT silently chosen for a web project',
  chosen === null || chosen.adapter.kind !== 'mobile',
  chosen ? `chosen=${chosen.adapter.kind}` : 'nothing could satisfy the request');
console.log('');

// --- 2. no blind tap ---------------------------------------------------------
console.log('--- 2. tapOn without ui.hierarchy is unavailable, not a blind tap ---');
const noHierarchy = defineSession({
  sessionId: 'ses_2',
  targetId: 'tgt_emulator_1',
  state: SESSION_STATE.CREATED,
  capabilities: ['app.launch', 'ui.tap', 'screen.capture'],
});
const negotiation = negotiateMobileCapabilities(noHierarchy, ['launchApp', 'tapOn', 'assertVisible']);
check('the negotiation reports the gap list of THIS execution',
  !negotiation.supported && negotiation.gaps.length === 2,
  `gaps=${negotiation.gaps.map((g) => g.kind).join(',')}`);
check('tapOn is in the unavailable list', negotiation.unavailableSteps.includes('tapOn'));
const tapGap = negotiation.gaps.find((g) => g.kind === 'tapOn');
check('the tapOn gap names ui.hierarchy',
  tapGap && tapGap.missing.includes('ui.hierarchy'),
  tapGap ? `missing=${tapGap.missing.join(',')}` : 'no tapOn gap');
check('the tapOn gap says a blind tap is not a substitute',
  tapGap && /blind tap/.test(tapGap.reason));
console.log('');

// --- 3. no stale lease -------------------------------------------------------
console.log('--- 3. an expired farm lease is refused AND reclaimed ---');
const farmTarget = defineTarget({
  targetId: 'tgt_farm_1',
  kind: TARGET_KIND.REMOTE_FARM,
  platform: 'android',
  capabilities: MOBILE_CAPABILITIES,
  declaredBy: 'lease:lease_1',
});
const expired = defineSession({
  sessionId: 'ses_farm_1',
  targetId: 'tgt_farm_1',
  state: SESSION_STATE.RUNNING,
  capabilities: MOBILE_CAPABILITIES,
  leaseExpiresAt: PAST,
});
let leaseRefusal = null;
try {
  resolveSession(farmTarget, expired, { now: NOW });
} catch (e) {
  leaseRefusal = e;
}
check('an expired lease is refused',
  leaseRefusal !== null && leaseRefusal.code === MOBILE_REJECTION.TARGET_UNAVAILABLE,
  leaseRefusal ? `reason=${leaseRefusal.details.reason}` : 'it was accepted');
check('the refusal names the lease as the reason',
  leaseRefusal && leaseRefusal.details.reason === 'lease-expired');
const reclaimed = reclaimExpiredSession(farmTarget, expired, { now: NOW });
check('the expired lease is reclaimed back to idle',
  reclaimed.state === SESSION_STATE.IDLE,
  `state=${reclaimed.state}`);
console.log('');

// --- the session answers "which device, which steps" -------------------------
console.log('--- 4. the session answers "which device and what can it do" ---');
const resolved = resolveSession(target, session, { now: NOW });
check('a usable session resolves',
  resolved.sessionId === 'ses_1' && resolved.targetId === 'tgt_emulator_1');
check('the session carries the proven capability set',
  resolved.capabilities.length === MOBILE_CAPABILITIES.length);
check('a missing target is refused',
  (() => {
    try { resolveSession(null, session, { now: NOW }); return false; } catch (e) {
      return e.code === MOBILE_REJECTION.TARGET_UNAVAILABLE;
    }
  })());

console.log('');
if (failures === 0) {
  console.log('RESULT: 0 failed -- the mobile contract refuses explicitly, never degrades silently.');
  process.exit(0);
}
console.log(`RESULT: ${failures} FAILED`);
process.exit(1);
