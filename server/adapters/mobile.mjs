/**
 * ATS-601: the MOBILE adapter skeleton -- the extension point the Android
 * runner (ATS-603) will implement.
 *
 * WHAT THIS IS
 * ------------
 * A `RunnerAdapter` (ATS-301) that ALSO carries a `device` section. It is
 * registered in the SAME registry as Playwright and WDIO, passes the SAME
 * `assertAdapter` check, and is negotiated with the SAME `negotiate` /
 * `negotiateWithDevice` machinery. It is NOT a second contract: the
 * mobile execution face is a third engine, not a parallel world.
 *
 * WHY THE ADAPTER IS A SKELETON
 * -----------------------------
 * This task delivers the CONTRACT, not a driver. There is no ADB, no
 * emulator, no device on this machine, and no Android SDK. So:
 *
 *   * the adapter's ENGINE capabilities are all reported UNSUPPORTED, each
 *     with a reason -- that is the honest answer, and it is the same shape
 *     the WDIO adapter uses for the capabilities it cannot prove;
 *   * the adapter's DEVICE capabilities are derived from the SESSION the
 *     caller passes in, because a session carries the capabilities the
 *     device PROVED. The adapter never invents one;
 *   * `start()` refuses with `REMOTE_TARGET_UNAVAILABLE` -- it cannot
 *     drive anything, and it says so instead of pretending.
 *
 * When ATS-603 lands, this file gains a real driver and the capabilities
 * become proven ones. Until then NOTHING here may be described as a working
 * mobile runner: `designStatus` below says `CONTRACT_ONLY`, and the
 * capabilities say it too.
 */
import {
  ADAPTER_CONTRACT_VERSION,
  DEVICE_CONTRACT_VERSION,
  capability,
  deviceCapability,
} from './contract.mjs';
import {
  MOBILE_CAPABILITIES,
  MOBILE_REJECTION,
  MobileTargetError,
  resolveSession,
} from './mobile-target.mjs';

/** The reason every engine capability carries: there is no driver yet. */
const NO_DRIVER = 'the mobile runner has no driver yet; the Android adapter is ATS-603';

/**
 * The mobile adapter.
 *
 * @param {object} [opts]
 * @param {object} [opts.target]   the execution target (ATS-601)
 * @param {object} [opts.session]  the device session (ATS-601)
 * @param {object} [opts.registeredSessionIds] the sessions the user registered
 */
export function createMobileAdapter(opts = {}) {
  const { target = null, session = null, registeredSessionIds = [] } = opts;

  const adapter = {
    kind: 'mobile',
    contractVersion: ADAPTER_CONTRACT_VERSION,

    /**
     * The ENGINE layer. Nothing is supported yet, and every entry says
     * why -- an unsupported capability with a reason is a reportable
     * result, not a silent failure (ATS-301 principle P-4).
     */
    capabilities(project) {
      return [
        capability('discover', false, { reason: NO_DRIVER }),
        capability('start', false, { reason: NO_DRIVER }),
        capability('stop', false, { reason: NO_DRIVER }),
        capability('collect', false, { reason: NO_DRIVER }),
        capability('filterByFile', false, { reason: NO_DRIVER }),
        capability('filterByTestUid', false, { reason: NO_DRIVER }),
        capability('structuredReport', false, { reason: NO_DRIVER }),
        capability('htmlReport', false, { reason: NO_DRIVER }),
        capability('trace', false, { reason: NO_DRIVER }),
        capability('screenshot', false, { reason: NO_DRIVER }),
        capability('video', false, { reason: NO_DRIVER }),
        capability('cancel', false, { reason: NO_DRIVER }),
        capability('nativeBrowser', false, { reason: NO_DRIVER }),
        capability('cliContract', false, { reason: NO_DRIVER }),
      ];
    },

    /**
     * The DEVICE layer (ATS-601). The capabilities come from the SESSION,
     * never from the target's declaration: a declaration is not a proof.
     */
    device: {
      contractVersion: DEVICE_CONTRACT_VERSION,
      capabilities(context = {}) {
        const s = context.session ?? session;
        const available = new Set(s && s.capabilities ? s.capabilities : []);
        return MOBILE_CAPABILITIES.map((name) => (
          available.has(name)
            ? deviceCapability(name, true, {
              evidence: `the session ${s.sessionId} proved ${name}`,
              detail: { sessionId: s.sessionId, targetId: s.targetId },
            })
            : deviceCapability(name, false, {
              reason: `the session ${s ? s.sessionId : '(none)'} did not prove ${name}`,
              detail: { sessionId: s ? s.sessionId : null },
            })
        ));
      },
    },

    discover() {
      throw new MobileTargetError(MOBILE_REJECTION.TARGET_UNAVAILABLE, NO_DRIVER, { reason: 'no-driver' });
    },

    /**
     * Refuse to start.
     *
     * The refusal is the WHOLE POINT: a caller that asked for a mobile run
     * must be told that there is no driver, and must NOT be handed a
     * browser run instead (docs/25 §3.2: no silent degradation).
     */
    start() {
      throw new MobileTargetError(MOBILE_REJECTION.TARGET_UNAVAILABLE, NO_DRIVER, { reason: 'no-driver' });
    },

    stop() {
      throw new MobileTargetError(MOBILE_REJECTION.TARGET_UNAVAILABLE, NO_DRIVER, { reason: 'no-driver' });
    },

    collect() {
      throw new MobileTargetError(MOBILE_REJECTION.TARGET_UNAVAILABLE, NO_DRIVER, { reason: 'no-driver' });
    },

    /* --- the ATS-601 device helpers, on the adapter itself --- */

    /**
     * Resolve the session this adapter would run on.
     *
     * It applies the hard rules in order: the target must exist, the
     * session must belong to it, the session must not be failed, the
     * lease must not have expired, and the session must be one the user
     * registered.
     */
    resolveDevice({ now = new Date() } = {}) {
      const t = target ?? opts.target ?? null;
      const s = session ?? opts.session ?? null;
      const registered = registeredSessionIds ?? opts.registeredSessionIds ?? [];
      const resolved = resolveSession(t, s, { now });
      if (registered.length) {
        // Only the sessions the user registered may be used.
        if (!registered.includes(resolved.sessionId)) {
          throw new MobileTargetError(
            'MOBILE_SESSION_NOT_REGISTERED',
            `session ${resolved.sessionId} is not registered by the user; the platform may not use it`,
            { sessionId: resolved.sessionId, registered: [...registered] },
          );
        }
      }
      return { target: t, session: resolved };
    },

    /** The honest description of what this adapter is today. */
    describe() {
      return {
        kind: adapter.kind,
        contractVersion: adapter.contractVersion,
        deviceContractVersion: DEVICE_CONTRACT_VERSION,
        designStatus: 'CONTRACT_ONLY',
        note: 'The mobile adapter is the ATS-601 CONTRACT. There is no driver, no device and no '
          + 'Android SDK behind it; the real runner is ATS-603.',
        targetKind: target ? target.kind : null,
        sessionId: session ? session.sessionId : null,
      };
    },
  };

  return adapter;
}
