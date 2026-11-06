#!/usr/bin/env node
/**
  * ATS-601 evidence probe: the hard rules of the mobile contract, shown
  * as they actually behave.
  *
  * The unit tests (UT-MOB-*) assert the rules one by one. This probe shows
  * the rules that the whole delivery stands on, side by side, on ONE fake
  * target and ONE fake session:
  *
  *   1. NO SILENT DEGRADATION -- a caller that asked for a mobile run gets
  *      an EXPLICIT rejection, and never a browser run instead. The probe
  *      shows what the registry does with the mobile adapter in it.
  *   2. NO BLIND TAP -- `tapOn` without `ui.hierarchy` is UNAVAILABLE; the
  *      negotiation says why instead of letting a coordinate tap happen.
  *   3. NO STALE LEASE -- an expired farm lease is refused AND reclaimed,
  *      because a lease that is not reclaimed keeps a device hostage.
  *   4. NO UNUSABLE DEVICE -- a device that is not connected, a device
  *      another run holds, and a session that claims capabilities its
  *      target never declared are all refused, with the reason named.
  *   5. NO UNREGISTERED DEVICE -- only a session the user registered may
  *      be used; an empty registration list is not a wildcard.
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
import { createMobileAdapter } from '../../server/adapters/mobile.mjs';
import { getAdapter, listRunners, selectAdapter } from '../../server/adapters/registry.mjs';

const NOW = new Date('2026-11-06T00:00:00.000Z');
const PAST = '2026-11-05T23:00:00.000Z';
const FUTURE = '2026-11-06T01:00:00.000Z';

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
// The session is `created`, so the lease is the FIRST rule that bites: an
// expired lease is refused before the session could ever be acquired.
const expired = defineSession({
  sessionId: 'ses_farm_1',
  targetId: 'tgt_farm_1',
  state: SESSION_STATE.CREATED,
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

// --- 3b. an occupied device is refused ---------------------------------------
console.log('--- 3b. a device another run holds is refused ---');
const occupied = defineSession({
  sessionId: 'ses_farm_2',
  targetId: 'tgt_farm_1',
  state: SESSION_STATE.RUNNING,
  capabilities: MOBILE_CAPABILITIES,
  leaseExpiresAt: FUTURE,
});
let occupiedRefusal = null;
try {
  resolveSession(farmTarget, occupied, { now: NOW });
} catch (e) {
  occupiedRefusal = e;
}
check('an occupied device is refused',
  occupiedRefusal !== null && occupiedRefusal.code === MOBILE_REJECTION.TARGET_UNAVAILABLE,
  occupiedRefusal ? `reason=${occupiedRefusal.details.reason}` : 'it was accepted');
check('the refusal names the occupancy as the reason',
  occupiedRefusal && occupiedRefusal.details.reason === 'device-occupied');
console.log('');

// --- 3c. a device that is not connected is refused ---------------------------
console.log('--- 3c. a device that is not connected is refused ---');
const notConnected = defineSession({
  sessionId: 'ses_farm_3',
  targetId: 'tgt_farm_1',
  state: SESSION_STATE.IDLE,
  capabilities: MOBILE_CAPABILITIES,
  leaseExpiresAt: FUTURE,
});
let notConnectedRefusal = null;
try {
  resolveSession(farmTarget, notConnected, { now: NOW });
} catch (e) {
  notConnectedRefusal = e;
}
check('a device that is not connected is refused',
  notConnectedRefusal !== null && notConnectedRefusal.code === MOBILE_REJECTION.TARGET_UNAVAILABLE,
  notConnectedRefusal ? `reason=${notConnectedRefusal.details.reason}` : 'it was accepted');
check('the refusal names the missing connection as the reason',
  notConnectedRefusal && notConnectedRefusal.details.reason === 'device-not-connected');
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

// --- 5. only a registered session may be used --------------------------------
console.log('');
console.log('--- 5. only a session the user registered may be used ---');
for (const [label, ids] of [
  ['no registration list', undefined],
  ['an empty registration list', []],
  ['a registration list that is not a list', 'ses_1'],
]) {
  const adapter = createMobileAdapter(
    ids === undefined
      ? { target, session }
      : { target, session, registeredSessionIds: ids },
  );
  let refusal = null;
  try {
    adapter.resolveDevice({ now: NOW });
  } catch (e) {
    refusal = e;
  }
  check(`an unregistered session is refused (${label})`,
    refusal !== null && refusal.code === 'MOBILE_SESSION_NOT_REGISTERED',
    refusal ? `code=${refusal.code}` : 'it was accepted');
}
const registered = createMobileAdapter({ target, session, registeredSessionIds: ['ses_1'] });
let registeredOk = false;
try {
  registeredOk = registered.resolveDevice({ now: NOW }).session.sessionId === 'ses_1';
} catch {
  registeredOk = false;
}
check('a registered session still resolves', registeredOk);
console.log('');

// --- 6. a session may not prove more than its target declared ----------------
console.log('--- 6. a session may not claim capabilities its target never declared ---');
const narrowTarget = defineTarget({
  targetId: 'tgt_narrow',
  kind: TARGET_KIND.LOCAL_EMULATOR,
  platform: 'android',
  capabilities: ['screen.capture'],
});
const wideSession = defineSession({
  sessionId: 'ses_wide',
  targetId: 'tgt_narrow',
  state: SESSION_STATE.CREATED,
  capabilities: MOBILE_CAPABILITIES,
});
let capabilityRefusal = null;
try {
  resolveSession(narrowTarget, wideSession, { now: NOW });
} catch (e) {
  capabilityRefusal = e;
}
check('a session claiming undeclared capabilities is refused',
  capabilityRefusal !== null && capabilityRefusal.code === MOBILE_REJECTION.CAPABILITY_MISSING,
  capabilityRefusal ? `code=${capabilityRefusal.code}` : 'it was accepted');
check('the refusal names the undeclared capabilities',
  capabilityRefusal && (capabilityRefusal.details.undeclared || []).includes('ui.tap'),
  capabilityRefusal && capabilityRefusal.details.undeclared
    ? `undeclared=${capabilityRefusal.details.undeclared.join(',')}` : '');

// The DEVICE layer must tell the same story about the same session: a
// capability the target never declared was never proved, so it is not
// reported as supported and carries no evidence.
console.log('');
console.log('--- 6b. the device layer does not prove what the target never declared ---');
const wideAdapter = createMobileAdapter({
  target: narrowTarget,
  session: wideSession,
  registeredSessionIds: ['ses_wide'],
});
const deviceEntries = wideAdapter.device.capabilities({ session: wideSession, target: narrowTarget });
const deviceByName = new Map(deviceEntries.map((e) => [e.name, e]));
const hierarchy = deviceByName.get('ui.hierarchy');
check('an undeclared capability is not reported as proved',
  hierarchy && hierarchy.supported === false,
  hierarchy ? `supported=${hierarchy.supported} evidence="${hierarchy.evidence}"` : 'not reported');
check('an undeclared capability carries no evidence',
  hierarchy && hierarchy.evidence === '');
check('the refusal names the target declaration',
  hierarchy && /not declared by target/.test(hierarchy.reason),
  hierarchy ? `reason=${hierarchy.reason}` : '');
check('the declared capability is still proved by the same session',
  deviceByName.get('screen.capture').supported === true);
console.log('');

console.log('');
if (failures === 0) {
  console.log('RESULT: 0 failed -- the mobile contract refuses explicitly, never degrades silently.');
  process.exit(0);
}
console.log(`RESULT: ${failures} FAILED`);
process.exit(1);
