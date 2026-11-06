/**
 * ATS-601: the mobile execution TARGET and SESSION contract.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The Bridge talks to a runner through an ADAPTER (ATS-301). That contract
 * answers "which ENGINE drives this project?". It does not answer "WHERE is
 * the code running?" -- for a browser test the answer is "here, in this
 * process". For a mobile test the answer is "on THAT device", and that
 * device is a resource with a lifecycle, a capability set and a lease.
 *
 * This module freezes that resource model so that ATS-603 (the Android
 * runner) does NOT become a second Playwright-specific implementation:
 *
 *   Target   { targetId, kind, platform, osVersion, capabilities[], declaredBy }
 *   Session  { sessionId, targetId, state, capabilities[], lastSeenAt, error? }
 *
 * A TARGET is the static description of "where to execute" (an emulator, a
 * connected phone, a leased farm device). A SESSION is "the device that is
 * connected right now" -- it has a state machine and a capability set that
 * is PROVEN, not declared.
 *
 * THE HARD RULES (docs/25-MOBILE-APP-TESTING.md §3.2)
  * ---------------------------------------------------
  *  1. A missing target, an unconnected device, an occupied device or an
  *     unsatisfied capability is an EXPLICIT REJECTION --
  *     `REMOTE_TARGET_UNAVAILABLE` / `REMOTE_CAPABILITY_MISSING`. There is NO
  *     silent degradation to another execution mode. A caller that asked for
  *     a device never silently gets a browser.
  *  2. A session is only handed out when a run may ACQUIRE it. The state
  *     machine is the only thing that knows what may be acquired: `created`
  *     can move to `running` and nothing else can. A session that is not
  *     attached (`idle`), a session another run holds (`running`) and a
  *     session that broke (`failed`) are all refused.
  *  3. A session may not prove MORE than its target declared. A capability
  *     the target never declared is a claim that was never proven, and it
  *     does not enter the negotiation.
  *  4. Capability negotiation happens BEFORE the run, and produces the gap
  *     list for THIS execution. A step whose capability is missing is not
  *     attempted at all -- it is reported.
  *  5. `tapOn` needs `ui.hierarchy`. Without the view hierarchy the element
  *     cannot be located, and a coordinate-only blind tap is not a
  *     substitute: the step is UNAVAILABLE, not degraded.
 *
 * WHY THE REJECTION CODES ARE `REMOTE_`-NAMESPACED
 * -------------------------------------------------
 * `REMOTE_TARGET_UNAVAILABLE` and `REMOTE_CAPABILITY_MISSING` are the two
 * codes the design document names. `REMOTE_CAPABILITY_MISSING` already
 * exists in the ATS-501 protocol table (docs/19 §6.2) and is owned by the
 * remote execution plane; reusing it here keeps ONE vocabulary for "the
 * target cannot do this" instead of two codes that mean the same thing.
 * `REMOTE_TARGET_UNAVAILABLE` is added to that table in this task, so the
 * two planes cannot drift apart. The table lives in
 * `server/control-plane/errors.mjs` and is guarded by UT-CP-008 against
 * the machine-readable block in docs/19.
 *
 * SCOPE (baseline honesty)
 * -------------------------
 * This module is the CONTRACT. It has no device driver, no ADB call, no
 * emulator lifecycle and no evidence writer. The sessions it accepts are
 * plain data: a caller supplies them, and the module decides whether they
 * may be used. Real devices, real leases and the real Android runner are
 * ATS-603/ATS-604/ATS-505; until then nothing here may be called
 * "implemented" beyond the contract itself.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
// The evidence rules are the platform's, not the mobile contract's own:
// `isSubpath` is the same containment check the artifact resolver uses and
// `sha` is the same digest function, so a mobile screenshot is validated
// and hashed exactly like every other piece of evidence (FR-015).
import { isSubpath, sha } from '../core.mjs';

/* ------------------------------------------------------------------ */
/* The vocabulary                                                      */
/* ------------------------------------------------------------------ */

/**
 * The three kinds of execution target.
 *
 *   local-emulator -- an emulator the platform creates and destroys. If it
 *                     is not there, the platform may create it; if it
 *                     cannot, the execution is REJECTED.
 *   local-device   -- a real device the user has connected through
 *                     ADB / XCUITest. The platform BORROWS it: it does not
 *                     install apps, does not pair, does not own it. The
 *                     user may unplug it at any moment, so the session
 *                     can go stale.
 *   remote-farm    -- a device leased from a remote farm. LEASE-BASED: the
 *                     lease has an expiry, and an expired lease MUST be
 *                     reclaimed (the ATS-502 lease semantics).
 */
export const TARGET_KIND = Object.freeze({
  LOCAL_EMULATOR: 'local-emulator',
  LOCAL_DEVICE: 'local-device',
  REMOTE_FARM: 'remote-farm',
});

export const TARGET_KINDS = Object.freeze([
  TARGET_KIND.LOCAL_EMULATOR,
  TARGET_KIND.LOCAL_DEVICE,
  TARGET_KIND.REMOTE_FARM,
]);

/**
 * What the platform may DO to a target of each kind.
 *
 * `platformOwnsLifecycle` -- the platform creates and destroys it.
 * `platformMayInstall`     -- the platform may install apps on it. This is
 *                             FALSE for `local-device`: the design says the
 *                             platform does not take over installation and
 *                             pairing of a real device, it only borrows it.
 * `leaseRequired`          -- the session needs a lease that expires.
 */
export const TARGET_KIND_POLICY = Object.freeze({
  [TARGET_KIND.LOCAL_EMULATOR]: Object.freeze({
    platformOwnsLifecycle: true,
    platformMayInstall: true,
    leaseRequired: false,
  }),
  [TARGET_KIND.LOCAL_DEVICE]: Object.freeze({
    platformOwnsLifecycle: false,
    platformMayInstall: false,
    leaseRequired: false,
  }),
  [TARGET_KIND.REMOTE_FARM]: Object.freeze({
    platformOwnsLifecycle: false,
    platformMayInstall: false,
    leaseRequired: true,
  }),
});

/**
 * The mobile capability vocabulary.
 *
 * The names are the ones the design document uses (docs/25 §3.3). They are
 * SEPARATE from the ATS-301 adapter capability vocabulary: that one says
 * what an ENGINE can do, this one says what a DEVICE can do. A mobile
 * adapter declares the former; the target it runs on declares the latter.
 * The two are joined by `negotiateMobileCapabilities` below.
 */
export const MOBILE_CAPABILITY = Object.freeze({
  APP_INSTALL: 'app.install',
  APP_LAUNCH: 'app.launch',
  UI_TAP: 'ui.tap',
  UI_HIERARCHY: 'ui.hierarchy',
  SCREEN_CAPTURE: 'screen.capture',
  SCREEN_RECORD: 'screen.record',
  LOG_READ: 'log.read',
});

export const MOBILE_CAPABILITIES = Object.freeze(Object.values(MOBILE_CAPABILITY));

/**
 * The step kinds the mobile case model uses, and the capabilities each of
 * them needs.
 *
 * `launchApp` needs `app.install` OR `app.launch`: an already-installed app
 * only has to be launched, a fresh install needs the install capability.
 * The other steps need their capability outright.
 *
 * `tapOn` needs BOTH `ui.tap` and `ui.hierarchy`. That is the rule that
 * forbids a coordinate-only blind tap: without the hierarchy the element
 * cannot be located, so the step is unavailable rather than degraded.
 */
export const MOBILE_STEP_REQUIREMENTS = Object.freeze({
  launchApp: Object.freeze({ any: ['app.install', 'app.launch'], all: [] }),
  tapOn: Object.freeze({ any: [], all: ['ui.tap', 'ui.hierarchy'] }),
  assertVisible: Object.freeze({ any: [], all: ['ui.hierarchy'] }),
  takeScreenshot: Object.freeze({ any: [], all: ['screen.capture'] }),
  recordScreen: Object.freeze({ any: [], all: ['screen.record'] }),
  readLogs: Object.freeze({ any: [], all: ['log.read'] }),
});

export const MOBILE_STEP_KINDS = Object.freeze(Object.keys(MOBILE_STEP_REQUIREMENTS));

/**
 * The session state machine.
 *
 *   idle    -- the target exists, no session is attached to it.
 *   created -- a session is attached; the device is reachable but nothing
 *              is running on it yet.
 *   running -- the session is in use (a run holds it).
 *   failed  -- the session broke; `error` says why.
 *
 * The legal transitions are `idle -> created -> running -> idle`, plus the
 * error path into `failed` from either `created` or `running`. `failed` is
 * terminal for that session: it must be released and recreated, never
 * silently continued.
 */
export const SESSION_STATE = Object.freeze({
  IDLE: 'idle',
  CREATED: 'created',
  RUNNING: 'running',
  FAILED: 'failed',
});

export const SESSION_STATES = Object.freeze(Object.values(SESSION_STATE));

/** state -> the states it may move to. */
export const SESSION_TRANSITIONS = Object.freeze({
  [SESSION_STATE.IDLE]: Object.freeze([SESSION_STATE.CREATED]),
  [SESSION_STATE.CREATED]: Object.freeze([SESSION_STATE.RUNNING, SESSION_STATE.IDLE, SESSION_STATE.FAILED]),
  [SESSION_STATE.RUNNING]: Object.freeze([SESSION_STATE.IDLE, SESSION_STATE.FAILED]),
  [SESSION_STATE.FAILED]: Object.freeze([SESSION_STATE.IDLE]),
});

/** The states a session never leaves by itself. */
export const TERMINAL_SESSION_STATES = Object.freeze(new Set([SESSION_STATE.FAILED]));

/**
 * Why a session in a given state may not be used.
 *
 * A session is usable when the state machine lets a run acquire it, and
 * the state machine lets exactly one state be acquired: `created`. Every
 * other state has a reason of its own, and a refusal that does not say
 * WHY is not actionable.
 *
 * A state added to `SESSION_STATES` must be added here as well: a session
 * in a state this table does not know is refused, and the reason must
 * name it.
 */
export const SESSION_UNUSABLE_REASON = Object.freeze({
  [SESSION_STATE.IDLE]: 'device-not-connected',
  [SESSION_STATE.RUNNING]: 'device-occupied',
  [SESSION_STATE.FAILED]: 'session-failed',
});

/* ------------------------------------------------------------------ */
/* The rejection codes                                                  */
/* ------------------------------------------------------------------ */

/**
 * The rejection codes this module raises.
 *
 * Both are `REMOTE_`-namespaced on purpose: `REMOTE_CAPABILITY_MISSING`
 * is already the ATS-501 code for "the target cannot do this", and reusing
 * it keeps one vocabulary across the local and the remote plane. The codes
 * live in `server/control-plane/errors.mjs` (the single table) and are
 * mirrored here so that the mobile contract does not have to import the
 * control plane.
 */
export const MOBILE_REJECTION = Object.freeze({
  TARGET_UNAVAILABLE: 'REMOTE_TARGET_UNAVAILABLE',
  CAPABILITY_MISSING: 'REMOTE_CAPABILITY_MISSING',
});

/** The error the mobile contract throws. */
export class MobileTargetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MobileTargetError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/* Target                                                              */
/* ------------------------------------------------------------------ */

/**
 * Build a TARGET: the static description of where a run would execute.
 *
 * The target is validated, not merely passed through: an unknown kind, an
 * empty capability list or a capability outside the vocabulary is a
 * programming error and is reported as one. A target that cannot describe
 * itself honestly must not reach the negotiation stage.
 *
 * `declaredBy` records WHO declared the target. For `local-device` and
 * `remote-farm` it is the identifier of the user / lease that registered
 * it; the device-selection rule (only explicitly registered sessions may
 * be used) is enforced by `assertRegisteredSession` below, not here.
 */
export function defineTarget({
  targetId,
  kind,
  platform,
  osVersion = '',
  capabilities = [],
  declaredBy = '',
} = {}) {
  if (typeof targetId !== 'string' || !targetId.trim()) {
    throw new MobileTargetError('MOBILE_TARGET_INVALID', 'a target needs a non-empty targetId');
  }
  if (!TARGET_KINDS.includes(kind)) {
    throw new MobileTargetError(
      'MOBILE_TARGET_INVALID',
      `unknown target kind: ${String(kind)} (expected one of ${TARGET_KINDS.join(', ')})`,
    );
  }
  if (typeof platform !== 'string' || !platform.trim()) {
    throw new MobileTargetError('MOBILE_TARGET_INVALID', `target ${targetId} needs a platform`);
  }
  if (!Array.isArray(capabilities)) {
    throw new MobileTargetError('MOBILE_TARGET_INVALID', `target ${targetId} needs a capability list`);
  }
  const unknown = capabilities.filter((c) => !MOBILE_CAPABILITIES.includes(c));
  if (unknown.length) {
    throw new MobileTargetError(
      'MOBILE_TARGET_INVALID',
      `target ${targetId} declares capabilities outside the vocabulary: ${unknown.join(', ')}`,
    );
  }
  if (capabilities.length === 0) {
    // A target with no capabilities can do nothing. Declaring it is legal
    // (a device that is connected but not yet probed), but a target that
    // can do NOTHING is never usable, and pretending otherwise would make
    // the negotiation report a gap that has no fix.
    throw new MobileTargetError(
      'MOBILE_TARGET_INVALID',
      `target ${targetId} declares no capabilities; a target that can do nothing is not a target`,
    );
  }
  return Object.freeze({
    targetId,
    kind,
    platform,
    osVersion: String(osVersion || ''),
    capabilities: Object.freeze([...new Set(capabilities)].sort()),
    declaredBy: String(declaredBy || ''),
  });
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build a SESSION: the device that is connected right now.
 *
 * The session's capabilities are what the device PROVED it can do, not
 * what the target was declared to be able to do. A session with fewer
 * capabilities than its target is normal (a phone with the screen locked,
 * a farm device whose lease is about to expire); a session with MORE is
 * not -- that would be a claim that was never proven.
 */
export function defineSession({
  sessionId,
  targetId,
  state = SESSION_STATE.IDLE,
  capabilities = [],
  lastSeenAt = null,
  error = null,
  leaseExpiresAt = null,
} = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new MobileTargetError('MOBILE_SESSION_INVALID', 'a session needs a non-empty sessionId');
  }
  if (typeof targetId !== 'string' || !targetId.trim()) {
    throw new MobileTargetError('MOBILE_SESSION_INVALID', `session ${sessionId} needs a targetId`);
  }
  if (!SESSION_STATES.includes(state)) {
    throw new MobileTargetError(
      'MOBILE_SESSION_INVALID',
      `unknown session state: ${String(state)} (expected one of ${SESSION_STATES.join(', ')})`,
    );
  }
  if (!Array.isArray(capabilities)) {
    throw new MobileTargetError('MOBILE_SESSION_INVALID', `session ${sessionId} needs a capability list`);
  }
  const unknown = capabilities.filter((c) => !MOBILE_CAPABILITIES.includes(c));
  if (unknown.length) {
    throw new MobileTargetError(
      'MOBILE_SESSION_INVALID',
      `session ${sessionId} declares capabilities outside the vocabulary: ${unknown.join(', ')}`,
    );
  }
  return Object.freeze({
    sessionId,
    targetId,
    state,
    capabilities: Object.freeze([...new Set(capabilities)].sort()),
    lastSeenAt: lastSeenAt ? String(lastSeenAt) : null,
    error: error ? String(error) : null,
    leaseExpiresAt: leaseExpiresAt ? String(leaseExpiresAt) : null,
  });
}

/**
 * True when the session may move from `from` to `to`.
 *
 * The transition table is the state machine; this function is its only
 * reader, so the rule cannot be re-implemented (and subtly widened) at the
 * call site.
 */
export function canTransition(from, to) {
  const allowed = SESSION_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Move a session to a new state.
 *
 * An illegal transition is a programming error and throws -- a session
 * that skipped `created` and went straight to `running` would mean the
 * device was never proven reachable.
 */
export function transitionSession(session, to, { error = null, lastSeenAt = null } = {}) {
  if (!canTransition(session.state, to)) {
    throw new MobileTargetError(
      'MOBILE_SESSION_TRANSITION_INVALID',
      `session ${session.sessionId} cannot move from ${session.state} to ${to}`,
      { from: session.state, to, allowed: [...(SESSION_TRANSITIONS[session.state] || [])] },
    );
  }
  return defineSession({
    ...session,
    state: to,
    error: to === SESSION_STATE.FAILED ? String(error || 'unknown error') : (error ? String(error) : null),
    lastSeenAt: lastSeenAt || session.lastSeenAt,
  });
}

/**
 * True when the lease of a farm session has expired.
 *
 * A farm session WITHOUT a lease expiry is a lease that has already
 * expired: the lease semantics require an expiry, so a session that
 * carries none cannot be trusted to still hold the device.
 */
export function isLeaseExpired(session, now = new Date()) {
  if (session.leaseExpiresAt === null) return true;
  const expiry = Date.parse(session.leaseExpiresAt);
  if (Number.isNaN(expiry)) return true;
  return expiry <= now.getTime();
}

/**
 * Whether a session may be USED right now, and why not when it may not.
 *
 * This is the answer to "can this device do anything at all?". It is the
 * same rule `resolveSession` applies, exposed as DATA so that the device
 * layer can report an unusable session as unsupported instead of
 * claiming that the session proved a capability it never proved.
 *
 * Returns `{usable, reason}`:
 *   * `usable` -- the session is in a state a run may acquire;
 *   * `reason` -- why it is not, in words ('device-not-connected',
 *     'device-occupied', 'session-failed', 'no-session').
 */
export function sessionUsability(session) {
  if (!session) return { usable: false, reason: 'no-session' };
  if (canTransition(session.state, SESSION_STATE.RUNNING)) return { usable: true, reason: '' };
  return { usable: false, reason: SESSION_UNUSABLE_REASON[session.state] };
}

/**
 * The capabilities a session may PROVE for a target.
 *
 * A session proves a capability when the session claims it AND the target
 * declared it. The INTERSECTION is the only thing that may be reported as
 * proved: a claim the target never made was never proven, so it enters
 * neither the negotiation nor the device-layer evidence.
 *
 * `resolveSession` refuses a session that claims more than its target
 * declared, and the device layer reports exactly this intersection. Both
 * read this function, so the two paths cannot give opposite answers about
 * one session.
 *
 * Returns `{provable, undeclared, targetMismatch}`:
 *   * `provable`       -- the capabilities that may be reported as proved;
 *   * `undeclared`     -- the capabilities the session claims that the
 *                         target never declared;
 *   * `targetMismatch` -- the session belongs to another target, so it
 *                         proves nothing for this one.
 */
export function provableCapabilities(target, session) {
  if (!session) return { provable: [], undeclared: [], targetMismatch: false };
  const claimed = Array.isArray(session.capabilities) ? session.capabilities : [];
  if (!target) return { provable: [], undeclared: [...claimed], targetMismatch: false };
  if (session.targetId !== target.targetId) {
    // A session that belongs to another target proves nothing here.
    return { provable: [], undeclared: [...claimed], targetMismatch: true };
  }
  const declared = new Set(target.capabilities);
  return {
    provable: claimed.filter((c) => declared.has(c)),
    undeclared: claimed.filter((c) => !declared.has(c)),
    targetMismatch: false,
  };
}

/* ------------------------------------------------------------------ */
/* Capability negotiation                                              */
/* ------------------------------------------------------------------ */

/**
 * The capabilities a single step kind needs, and whether it is satisfied.
 *
 * Returns `{kind, satisfied, required, missing, reason}`:
 *   * `required` -- the capabilities the step needs;
 *   * `missing`  -- the ones the target does not have;
 *   * `satisfied`-- true when the step may run.
 */
export function stepRequirements(kind, available = []) {
  const spec = MOBILE_STEP_REQUIREMENTS[kind];
  if (!spec) {
    throw new MobileTargetError(
      'MOBILE_STEP_UNKNOWN',
      `unknown mobile step kind: ${String(kind)} (expected one of ${MOBILE_STEP_KINDS.join(', ')})`,
    );
  }
  const have = new Set(available);
  const missing = [];

  for (const cap of spec.all) {
    if (!have.has(cap)) missing.push(cap);
  }
  if (spec.any.length > 0) {
    const satisfiedByAny = spec.any.some((cap) => have.has(cap));
    if (!satisfiedByAny) missing.push(...spec.any);
  }

  const required = [...spec.all, ...spec.any];
  const satisfied = missing.length === 0;
  return {
    kind,
    satisfied,
    required,
    missing,
    reason: satisfied ? '' : describeStepGap(kind, missing),
  };
}

/**
 * The human-readable reason a step is unavailable.
 *
 * The `ui.hierarchy` case is called out on purpose: a missing hierarchy
 * means the element cannot be located, and the contract says the step is
 * unavailable rather than performed as a blind coordinate tap.
 */
function describeStepGap(kind, missing) {
  if (kind === 'tapOn' && missing.includes('ui.hierarchy')) {
    return 'tapOn needs ui.hierarchy to locate the element; without the view hierarchy '
      + 'the step is unavailable, and a coordinate-only blind tap is not a substitute';
  }
  if (kind === 'launchApp') {
    return `launchApp needs one of ${MOBILE_STEP_REQUIREMENTS.launchApp.any.join(' / ')}; `
      + 'the target can neither install nor launch the app';
  }
  return `the target does not provide ${missing.join(', ')}`;
}

/**
 * Negotiate the capabilities of a WHOLE EXECUTION.
 *
 * This is the "before the run" negotiation the design document asks for:
 * it takes the list of step kinds the execution will perform and produces
 * the CAPABILITY GAP LIST of that execution -- the capabilities that are
 * missing, and which steps they block.
 *
 * The result is DATA, not an exception: a caller can show the gap list to
 * the user before starting anything. `requireMobileCapabilities` is the
 * variant that raises instead.
 *
 * The gap list is computed against the SESSION (what the device proved it
 * can do), not against the target (what it was declared to be able to
 * do). A capability the target claims but the session does not have is a
 * gap -- that is the difference between a declaration and a proof.
 */
export function negotiateMobileCapabilities(session, stepKinds = []) {
  const gaps = [];
  const unavailable = [];
  const available = session.capabilities;

  for (const kind of stepKinds) {
    const r = stepRequirements(kind, available);
    if (r.satisfied) continue;
    unavailable.push(r.kind);
    gaps.push({
      kind: r.kind,
      missing: r.missing,
      reason: r.reason,
    });
  }

  return {
    sessionId: session.sessionId,
    targetId: session.targetId,
    available: [...available],
    supported: gaps.length === 0,
    gaps,
    unavailableSteps: unavailable,
  };
}

/**
 * Negotiate and RAISE when a capability is missing.
 *
 * The rejection is `REMOTE_CAPABILITY_MISSING` -- the code the design
 * document names -- and it carries the gap list, so the caller can tell
 * the user exactly which capabilities are missing and which steps they
 * block. There is no fallback to another execution mode: that decision
 * belongs to the caller, and it must be explicit.
 */
export function requireMobileCapabilities(session, stepKinds = []) {
  const result = negotiateMobileCapabilities(session, stepKinds);
  if (!result.supported) {
    const detail = result.gaps
      .map((g) => `${g.kind} (missing ${g.missing.join(', ')})`)
      .join('; ');
    throw new MobileTargetError(
      MOBILE_REJECTION.CAPABILITY_MISSING,
      `session ${session.sessionId} cannot run this execution: ${detail}`,
      { gaps: result.gaps, unavailableSteps: result.unavailableSteps, available: result.available },
    );
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Session resolution: the hard rejections                             */
/* ------------------------------------------------------------------ */

/**
 * Resolve the session that a run would use, or REJECT.
 *
 * This is where the "no silent degradation" rule is enforced. The rejection
 * reasons are:
 *
 *   * the target does not exist        -> REMOTE_TARGET_UNAVAILABLE
 *   * no session is attached to it     -> REMOTE_TARGET_UNAVAILABLE
 *   * the session belongs to another
 *     target                            -> REMOTE_TARGET_UNAVAILABLE
 *   * the session is `failed`          -> REMOTE_TARGET_UNAVAILABLE
 *   * the device is not connected      -> REMOTE_TARGET_UNAVAILABLE
 *     (the session is `idle`)
 *   * the device is already occupied
 *     (the session is `running`)        -> REMOTE_TARGET_UNAVAILABLE
 *   * the lease has expired            -> REMOTE_TARGET_UNAVAILABLE
 *
 * A caller that wanted a device NEVER gets another execution mode here:
 * the function either returns a usable session or throws.
 *
 * ONLY AN ACQUIRABLE SESSION IS RETURNED. A run acquires a session by
 * moving it into `running`, so the session handed out must be one the
 * state machine allows to move there. `canTransition` is that rule, read
 * from the ONE place that knows it:
 *
 *   * `idle`    -- no session is attached to the target: the device is not
 *                  connected. The caller has to create the session first
 *                  (`idle -> created`); an `idle` session is never
 *                  handed out as if a device were there.
 *   * `created` -- the device is reachable and free: this is the one
 *                  state a run may acquire.
 *   * `running` -- another run holds it: handing it out would let two
 *                  runs occupy one device at the same time.
 *   * `failed`  -- the session broke.
 *
 * The lease rule is NOT switchable: an expired farm lease is refused
 * whatever the caller passes. A caller that may turn the rule off could
 * hold a farm device past its lease, so the option does not exist.
 *
 * `now` is injectable so that the lease expiry is testable without a
 * clock.
 */
export function resolveSession(target, session, { now = new Date() } = {}) {
  if (!target) {
    throw new MobileTargetError(
      MOBILE_REJECTION.TARGET_UNAVAILABLE,
      'the requested execution target does not exist',
      { reason: 'target-not-found' },
    );
  }
  if (!session) {
    throw new MobileTargetError(
      MOBILE_REJECTION.TARGET_UNAVAILABLE,
      `target ${target.targetId} has no session attached`,
      { reason: 'session-not-found', targetId: target.targetId },
    );
  }
  if (session.targetId !== target.targetId) {
    throw new MobileTargetError(
      MOBILE_REJECTION.TARGET_UNAVAILABLE,
      `session ${session.sessionId} does not belong to target ${target.targetId}`,
      { reason: 'session-target-mismatch', targetId: target.targetId, sessionId: session.sessionId },
    );
  }
  if (!canTransition(session.state, SESSION_STATE.RUNNING)) {
    // The state machine is the authority on what may be acquired: a
    // session that cannot move to `running` is never handed out. The
    // reason names the state, so the refusal is actionable:
    // `device-not-connected` (no session is attached to the target),
    // `device-occupied` (another run holds it) or `session-failed`.
    const reason = SESSION_UNUSABLE_REASON[session.state];
    throw new MobileTargetError(
      MOBILE_REJECTION.TARGET_UNAVAILABLE,
      `session ${session.sessionId} is not usable (${reason})`
      + (session.error ? `: ${session.error}` : ''),
      {
        reason,
        sessionId: session.sessionId,
        targetId: target.targetId,
        state: session.state,
        error: session.error,
      },
    );
  }
  if (TARGET_KIND_POLICY[target.kind].leaseRequired && isLeaseExpired(session, now)) {
    throw new MobileTargetError(
      MOBILE_REJECTION.TARGET_UNAVAILABLE,
      `the lease of session ${session.sessionId} has expired; a farm device must be reclaimed`,
      { reason: 'lease-expired', sessionId: session.sessionId, targetId: target.targetId },
    );
  }
  const { provable, undeclared } = provableCapabilities(target, session);
  if (undeclared.length) {
    // The session proves MORE than its target declared. That claim was
    // never proven, so it does not enter the negotiation.
    throw new MobileTargetError(
      MOBILE_REJECTION.CAPABILITY_MISSING,
      `session ${session.sessionId} claims capabilities its target ${target.targetId} `
      + `never declared: ${undeclared.join(', ')}`,
      {
        reason: 'session-capability-undeclared',
        sessionId: session.sessionId,
        targetId: target.targetId,
        undeclared,
        declared: [...target.capabilities],
        provable: [...provable],
      },
    );
  }
  return session;
}

/**
 * Reclaim an expired farm session.
 *
 * The lease semantics of ATS-502 say an expired lease MUST be released.
 * This is the transition that does it: the session goes back to `idle` so
 * the device can be handed to the next lease holder. A session that is not
 * a farm session, or whose lease has not expired, is left alone.
 */
export function reclaimExpiredSession(target, session, { now = new Date() } = {}) {
  if (!target || !session) return session;
  if (!TARGET_KIND_POLICY[target.kind].leaseRequired) return session;
  if (!isLeaseExpired(session, now)) return session;
  // A session that is already `idle` holds no device, so there is nothing
  // to reclaim: the operation is idempotent, not an error.
  if (session.state === SESSION_STATE.IDLE) return session;
  // The move itself goes through the state machine, so an illegal move is
  // reported by the ONE place that knows the rules -- and a reclaimed
  // session carries no error any more.
  return transitionSession(session, SESSION_STATE.IDLE, { error: null });
}

/* ------------------------------------------------------------------ */
/* The security boundaries (docs/25 §9)                                */
/* ------------------------------------------------------------------ */

/**
 * The app packages a project has REGISTERED.
 *
 * Only a registered package may be launched. An arbitrary package name
 * coming from a user input must never reach a device: that is the rule
 * that keeps "start any app on the user's phone" out of reach.
 */
export function assertRegisteredAppPackage(registeredPackages, packageName) {
  const list = Array.isArray(registeredPackages) ? registeredPackages : [];
  if (typeof packageName !== 'string' || !packageName.trim()) {
    throw new MobileTargetError('MOBILE_APP_PACKAGE_INVALID', 'the app package must be a non-empty string');
  }
  if (!list.includes(packageName)) {
    throw new MobileTargetError(
      'MOBILE_APP_PACKAGE_NOT_REGISTERED',
      `the app package ${packageName} is not registered for this project`,
      { packageName, registered: [...list] },
    );
  }
  return packageName;
}

/**
 * Assert that the project is TRUSTED before a mobile flow may run.
 *
 * A mobile Flow is a script, exactly like a Playwright spec: running it
 * runs the repository's code. The trust gate of ATS-202/ATS-113 therefore
 * applies unchanged -- an untrusted project may not execute.
 *
 * The trust verdict comes from the caller (`trustOf` in
 * `server/discovery/trust.mjs`), so this contract does not have to know
 * how trust is stored. `trustOf` returns a RECORD -- `{trust, reason, at}`
 * -- and that record is what this function accepts. A bare `'trusted'`
 * string is accepted as well, so a caller that already knows the verdict
 * does not have to fabricate a record; what is NOT accepted is anything
 * else, and an unknown shape is refused rather than guessed at.
 */
export function assertTrustedProject(trust) {
  const verdict = typeof trust === 'string' ? trust : (trust && typeof trust === 'object' ? trust.trust : null);
  if (verdict !== 'trusted') {
    throw new MobileTargetError(
      'MOBILE_PROJECT_UNTRUSTED',
      'the project has not been vouched for; an untrusted project may not execute a mobile flow',
      {
        trust: verdict ?? null,
        reason: (trust && typeof trust === 'object' && trust.reason) || null,
      },
    );
  }
  return true;
}

/**
 * Assert that the session was EXPLICITLY REGISTERED by the user.
 *
 * The platform does not connect to whatever device it can see: only the
 * sessions the user registered may be used. `registeredSessionIds` is the
 * list of them.
 */
export function assertRegisteredSession(registeredSessionIds, session) {
  const list = Array.isArray(registeredSessionIds) ? registeredSessionIds : [];
  const id = session && session.sessionId;
  if (!list.includes(id)) {
    throw new MobileTargetError(
      'MOBILE_SESSION_NOT_REGISTERED',
      `session ${String(id)} is not registered by the user; the platform may not use it`,
      { sessionId: id ?? null, registered: [...list] },
    );
  }
  return session;
}

/**
 * Resolve an evidence file INSIDE the evidence root and return its record.
 *
 * The evidence rules are the same as everywhere else in the platform
 * (FR-015): the path is validated, the file must be a regular file inside
 * the root, and the SHA-256 is computed by the HOST -- never supplied by
 * the caller. A screenshot produced on a device is untrusted input, and an
 * untrusted input does not get to name its own digest.
 */
export function resolveMobileEvidence(evidenceRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.length > 500) {
    throw new MobileTargetError('MOBILE_EVIDENCE_PATH_INVALID', 'the evidence path must be a non-empty string');
  }
  const root = String(evidenceRoot || '');
  const full = pathResolve(root, relativePath);
  if (!isSubpath(root, full)) {
    throw new MobileTargetError(
      'MOBILE_EVIDENCE_PATH_FORBIDDEN',
      'the evidence path points outside the evidence root',
      { relativePath },
    );
  }
  let actual;
  try {
    actual = realpathSync(full);
  } catch {
    throw new MobileTargetError(
      'MOBILE_EVIDENCE_NOT_FOUND',
      `the evidence file does not exist: ${relativePath}`,
      { relativePath },
    );
  }
  if (!isSubpath(root, actual) || !statSync(actual).isFile()) {
    throw new MobileTargetError(
      'MOBILE_EVIDENCE_PATH_FORBIDDEN',
      'the evidence path does not resolve to a regular file inside the evidence root',
      { relativePath },
    );
  }
  const bytes = readFileSync(actual);
  return {
    file: relativePath.replace(/\\/g, '/'),
    size: bytes.length,
    sha256: sha(bytes),
  };
}
