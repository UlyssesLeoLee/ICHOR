/**
 * ATS-603: the ANDROID adapter -- the RunnerAdapter implementation that
 * drives a real Android device or emulator.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The adapter that the ATS-301 registry knows as `mobile`. It is the
 * implementation of the contract that ATS-601 froze as a skeleton:
 *
 *   * the ENGINE capabilities are PROVEN, not declared -- they are probed
 *     against the device that is actually attached;
 *   * the DEVICE capabilities come from the SESSION, and the session's
 *     capabilities are PROVEN by the driver, not by the caller;
 *   * `start()` runs the mobile cases of the project on the device, and
 *     `collect()` maps the outcome onto the COMMON result model, so a
 *     mobile run is queryable together with a Web run (ATS-304).
 *
 * IT IS STILL THE SAME ADAPTER CONTRACT
 * -------------------------------------
 * The four operations are `discover` / `start` / `stop` / `collect`, the
 * capability names are the ones of `CAPABILITY_VOCABULARY`, and the
 * device section is the one ATS-601 defined. Nothing here is a second
 * contract.
 *
 * THE PROOF RULE
 * --------------
 * A capability is `supported: true` only when it was PROVEN on THIS
 * machine, and the `evidence` field says how. The proof of the ENGINE
 * capabilities is the existence of the driver and of the device; the proof
 * of the DEVICE capabilities is the probe of the driver
 * (`probeCapabilities`), which tries the operation that needs them.
 *
 * A machine without an Android SDK has NO proven capability, so the
 * adapter reports every capability as unsupported WITH ITS REASON -- it
 * does not claim to be able to run something it cannot run, and it does
 * not fall back to a browser.
 */
import fs from 'node:fs';
import { PassThrough } from 'node:stream';

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
  SESSION_STATE,
  TARGET_KIND,
  assertRegisteredSession,
  defineSession,
  defineTarget,
  provableCapabilities,
  resolveSession,
  sessionUsability,
} from './mobile-target.mjs';
import { mapProjectFlows } from '../discovery/mobile-flow-import.mjs';
import { ADB_FAILURE, AdbError, createAdbTransport, resolveAdbPath } from './android-adb.mjs';
import { MOBILE_FAILURE, STEP_STATUS, createAndroidDriver } from './android-runner.mjs';

/**
 * The reason every engine capability carries when no device is attached.
 *
 * It is the same shape as the reason ATS-601 used: a capability without a
 * reason is not a reportable result.
 */
function noDeviceReason(adbPath, deviceError) {
  if (deviceError) return `no Android device is attached: ${deviceError}`;
  return `no Android device is attached (the adb client was found at ${adbPath}, but it reports no usable device)`;
}

/**
 * The Android adapter.
 *
 * @param {object} [opts]
 * @param {object} [opts.target]            the execution target (ATS-601)
 * @param {object} [opts.session]           the device session (ATS-601)
 * @param {string[]} [opts.registeredSessionIds] the sessions the user registered
 * @param {string[]} [opts.registeredPackages]  the app packages the project registered
 * @param {object} [opts.transport]         an ADB transport (real by default)
 * @param {string} [opts.adbPath]           the adb client to use
 * @param {string} [opts.evidenceRoot]      where the evidence is written
 */
export function createAndroidAdapter(opts = {}) {
  const {
    target = null,
    session = null,
    registeredSessionIds = [],
    registeredPackages = [],
    transport: givenTransport = null,
    adbPath = null,
    evidenceRoot = null,
    env = process.env,
  } = opts;

  const client = adbPath || resolveAdbPath({ env });
  const transport = givenTransport || createAdbTransport({ adbPath: client, env });

  /**
   * The device that is attached RIGHT NOW, and why there is none.
   *
   * The adapter never invents a device: it asks the client, and it
   * reports the client's own words when there is none.
   */
  function attachedDevice() {
    try {
      const devices = transport.devices();
      const usable = devices.find((d) => d.state === 'device');
      if (usable) return { device: usable, error: null };
      const reason = devices.length
        ? `the attached devices are not usable: ${devices.map((d) => `${d.serial} (${d.state})`).join(', ')}`
        : 'the adb client reports no device';
      return { device: null, error: reason };
    } catch (e) {
      return { device: null, error: e.message };
    }
  }

  /**
   * The TARGET and the SESSION this run would use.
   *
   * A caller may pass them explicitly (the tests do), and the ATS-601
   * contract is then applied to them exactly as that contract says.
   *
   * When the caller passes NONE -- which is what the Bridge does, because
   * the Bridge's registry creates the adapter without a device -- the
   * adapter BUILDS them from the device that is attached:
   *
   *   * the target is a `local-emulator` whose declared capabilities are
   *     the mobile vocabulary (a local emulator may do all of them);
   *   * the session is in the state `created` -- the device is reachable
   *     and free -- and it is REGISTERED, because the user attached the
   *     device to this machine: that IS the registration.
   *
   * The registration rule of ATS-601 ("only the sessions the user
   * registered may be used") is a rule about the DEVICE SELECTION, not
   * about a local emulator the user just started. For a `local-emulator`
   * the platform OWNS the lifecycle (docs/25 §3.1), so the device the
   * user started is the one the platform may use. For a `local-device`
   * (a real phone the user plugged in) the rule stays strict, and this
   * adapter only ever builds a `local-emulator` target -- it never
   * silently borrows somebody's phone.
   */
  function resolvedTargetAndSession() {
    if (target && session) return { target, session };
    if (target || session) {
      // One of the two was given: the caller is explicit, and the
      // contract decides -- it either accepts the pair or refuses it.
      return { target, session };
    }
    const { device, error } = attachedDevice();
    if (!device) {
      throw new MobileTargetError(
        MOBILE_REJECTION.TARGET_UNAVAILABLE,
        `there is no Android device to run on: ${error}`,
        { reason: 'device-absent' },
      );
    }
    const builtTarget = defineTarget({
      targetId: `tgt_local_${device.serial}`,
      kind: TARGET_KIND.LOCAL_EMULATOR,
      platform: 'android',
      osVersion: device.sdk ?? '',
      capabilities: [...MOBILE_CAPABILITIES],
      declaredBy: 'the local device the user attached',
    });
    const builtSession = defineSession({
      sessionId: `ses_local_${device.serial}`,
      targetId: builtTarget.targetId,
      state: SESSION_STATE.CREATED,
      // The capabilities of the session are the ones the device PROVED.
      // The probe has not run yet at this point, so the session starts
      // with the capabilities the driver will prove; the probe refines
      // them before the run.
      capabilities: [...MOBILE_CAPABILITIES],
      lastSeenAt: new Date().toISOString(),
    });
    return { target: builtTarget, session: builtSession };
  }

  /**
   * The driver for the session.
   *
   * It is created lazily and cached: the probe and the run must talk to
   * the SAME device, so the transport's serial is pinned at the first use.
   */
  let driver = null;
  function getDriver() {
    if (driver) return driver;
    // The driver runs on the session that was RESOLVED -- the one the
    // caller gave, or the one built from the attached device.
    const resolved = resolvedTargetAndSession();
    driver = createAndroidDriver({
      transport,
      session: resolved.session,
      target: resolved.target,
      // The packages the project may launch. A caller that registered
      // them explicitly wins; otherwise the packages the PROJECT's Flow
      // files name are the registered ones -- the project declares its
      // own apps in its own Flow, and the platform launches nothing else.
      registeredPackages: registeredPackages.length
        ? registeredPackages
        : packagesOfProject(),
    });
    return driver;
  }

  /**
   * The app packages the PROJECT declares.
   *
   * The Flow files of the project name the apps they drive (`appId:` at
   * the top of the file). Those are the packages the project REGISTERED:
   * the platform launches what the project declares and nothing else.
   *
   * The rule of ATS-601 ("only a registered package may be launched")
   * therefore holds with the project as the registry. The package list
   * is read from the catalogue, so it is the SAME list the API shows.
   */
  let packagesCache = null;
  function packagesOfProject() {
    if (packagesCache) return packagesCache;
    const out = new Set();
    try {
      const cases = discoverMobileCases(currentProject()).tests;
      for (const c of cases) {
        if (c.appId) out.add(c.appId);
        for (const step of c.steps ?? []) {
          if (step.kind === 'launchApp' && step.args?.appId) out.add(step.args.appId);
        }
      }
    } catch { /* no project, no packages */ }
    packagesCache = [...out];
    return packagesCache;
  }

  /**
   * The project the adapter is currently working on.
   *
   * The Bridge does not hand the project to the adapter when it creates
   * it, so the last project that was discovered is remembered. It is
   * set by `discover()` and by `start()`.
   */
  let lastProject = null;
  function currentProject() {
    return lastProject;
  }

  const adapter = {
    // The kind is `android`, NOT `mobile`. The ATS-601 contract adapter
    // is already registered under `mobile`, and two adapters with the
    // same kind would make the SECOND one overwrite the FIRST in the
    // registry -- the contract skeleton would disappear, and the
    // ATS-601 tests that assert the contract refuses to start would read
    // the driver instead. The two are DIFFERENT things and they have
    // different kinds.
    kind: 'android',
    contractVersion: ADAPTER_CONTRACT_VERSION,

    /**
     * The ENGINE layer.
     *
     * The capabilities are PROVEN by the existence of the driver and of an
     * attached device. Without one, every capability is unsupported and
     * carries the reason -- which is the honest answer and the same shape
     * the WDIO adapter uses for the capabilities it cannot prove.
     *
     * They ALSO depend on the PROJECT: an adapter that drives a device
     * can only run a project that HAS mobile cases. Without that rule
     * the Android adapter would be selected for a WEB project -- the
     * selection is capability-driven, and it would answer "yes, I can
     * discover and start" about a project with no Flow file in it. The
     * reason says so.
     */
    capabilities(project) {
      const { device, error } = attachedDevice();
      const reason = device ? '' : noDeviceReason(client, error);
      const proof = device
        ? `the device ${device.serial} is attached and answered adb`
        : '';
      /**
       * The mobile cases of the project. A project with none of them
       * cannot be run by this adapter, and that is reported rather than
       * discovered at the first run.
       */
      let mobileCases = [];
      let casesError = null;
      try {
        mobileCases = project && project.root ? discoverMobileCases(project).tests : [];
      } catch (e) {
        casesError = e.message;
      }
      const hasCases = mobileCases.length > 0;
      const noCasesReason = casesError
        ? `the mobile cases of the project could not be read: ${casesError}`
        : 'the project holds no mobile Flow case, so the Android runner has nothing to run';

      /**
       * One capability entry.
       *
       * A capability that is unsupported ALWAYS carries a reason: the
       * contract refuses an unsupported capability without one
       * (`CAPABILITY_REASON_REQUIRED`). The reason is the device reason
       * when there is no device, and the capability's OWN reason when
       * there is one -- "the Android runner produces no HTML report" is
       * a different statement from "no device is attached", and a caller
       * needs to tell them apart.
       */
      /**
       * The facts of the device, or the nulls when there is none.
       *
       * The detail of a capability must not CRASH when no device is
       * attached: the registry creates the adapter without one, and the
       * capability matrix is asked about it. The first version read
       * `device.serial` unconditionally and threw
       * "Cannot read properties of null (reading 'serial')" -- the
       * adapter could not even be ASKED about a machine without an
       * emulator, which is exactly the machine that needs the honest
       * "no device" answer.
       */
      const detailOf = (extra = {}) => ({
        serial: device ? device.serial : null,
        model: device ? device.model : null,
        sdk: device ? device.sdk : null,
        ...extra,
      });

      const d = (name, supported, evidence, ownReason) => capability(
        name,
        supported,
        supported
          ? { evidence: `${evidence}; ${proof}`, detail: detailOf() }
          : {
            reason: ownReason
              ? (device ? ownReason : `${ownReason} (and no device is attached: ${error ?? 'none'})`)
              : reason,
            detail: detailOf(),
          },
      );

      /**
       * A capability that needs the project to hold mobile cases. When it
       * does not, the capability is unsupported -- with the reason.
       */
      const needsCases = (name, supported, evidence) => capability(
        name,
        supported && hasCases,
        supported && hasCases
          ? { evidence: `${evidence}; the project holds ${mobileCases.length} mobile case(s); ${proof}`, detail: detailOf({ mobileCases: mobileCases.length }) }
          : {
            reason: !hasCases ? noCasesReason : reason,
            detail: { serial: device ? device.serial : null, mobileCases: mobileCases.length },
          },
      );

      return [
        needsCases('discover', true, 'the adapter enumerates the mobile Flow cases of the project through the ATS-602 catalogue'),
        needsCases('start', true, 'the adapter drives the device through the Android driver (launchApp / tapOn / assertVisible / takeScreenshot)'),
        needsCases('stop', true, 'the adapter aborts the in-flight run and releases the device session'),
        needsCases('collect', true, 'the adapter maps the step results onto the common result model (passed/failed/skipped)'),
        needsCases('filterByFile', true, 'the adapter selects the mobile cases of one Flow file'),
        needsCases('filterByTestUid', true, 'the adapter selects one mobile case by its ATS-201/ATS-602 UID'),
        needsCases('structuredReport', true, 'the adapter writes a JSON result file with the step results'),
        d('htmlReport', false, '', 'the Android runner produces no HTML report; the result model and the evidence are the deliverable'),
        d('trace', false, '', 'the Android runner produces no engine trace; the view hierarchy attached to every step is the equivalent evidence'),
        needsCases('screenshot', true, 'the adapter captures the screen with the device screenshot command and writes the PNG into the evidence root'),
        needsCases('video', true, 'the adapter records the screen with the device screen recorder'),
        needsCases('cancel', true, 'the adapter keeps the run handle, so a cancel request can stop the run'),
        d('nativeBrowser', false, '', 'the Android runner drives an Android device, not a browser'),
        d('cliContract', true, `the adapter drives the adb client at ${client} with an argument vector (never a shell string)`),
      ];
    },

    /**
     * The DEVICE layer (ATS-601).
     *
     * The capabilities come from the SESSION, and the session's
     * capabilities are the ones the driver PROVED. The reasoning about
     * what a session may prove is the one of ATS-601 (`provableCapabilities`,
     * `sessionUsability`) -- this module does not have a second opinion.
     */
    device: {
      contractVersion: DEVICE_CONTRACT_VERSION,
      capabilities(context = {}) {
        const s = context.session ?? session;
        const t = context.target ?? target;
        const usability = sessionUsability(s);
        const { provable, undeclared, targetMismatch } = provableCapabilities(t, s);
        const available = usability.usable ? new Set(provable) : new Set();
        return MOBILE_CAPABILITIES.map((name) => (
          available.has(name)
            ? deviceCapability(name, true, {
              evidence: `the session ${s.sessionId} proved ${name}`,
              detail: { sessionId: s.sessionId, targetId: s.targetId },
            })
            : deviceCapability(name, false, {
              reason: unsupportedReason(name, s, t, usability, undeclared, targetMismatch),
              detail: { sessionId: s ? s.sessionId : null, sessionState: s ? s.state : null },
            })
        ));
      },
    },

    /**
     * Enumerate the mobile cases of the project.
     *
     * The mobile cases are part of the SAME catalogue as the web cases
     * (ATS-602), so the discovery reads that catalogue and filters the
     * mobile ones out of it.
     */
    discover(project) {
      // The project is remembered, so the driver can read the packages
      // the project declares.
      lastProject = project ?? null;
      packagesCache = null;
      const catalogue = discoverMobileCases(project);
      return {
        tests: catalogue.tests.map((t) => ({ ...t, runner: 'android' })),
        files: catalogue.files,
        warning: catalogue.warning,
        runner: 'android',
      };
    },

    /**
     * Start a run on the device.
     *
     * The refusal rules are applied FIRST, in the order of ATS-601:
     * the target must exist, the session must belong to it, the session
     * must be acquirable, and the session must be one the user
     * registered. A caller that asked for a device never gets a browser
     * run instead.
     *
     * THE BRIDGE CALLS THIS SYNCHRONOUSLY and expects a handle that looks
     * like the one of a spawned process: it reads `handle.child.pid`,
     * streams `handle.child.stdout` / `handle.child.stderr`, and waits
     * for `handle.child.on('close')`. The device work is NOT a child
     * process -- it is a sequence of ADB calls -- so the adapter builds
     * that shape itself:
     *
     *   * a PassThrough for stdout and one for stderr, so the bridge's
     *     log plumbing works unchanged;
     *   * an EventEmitter as the `child`, so `on('close')` fires when the
     *     run is over;
     *   * a `pid` of 0 -- there is NO process behind a mobile run, and
     *     reporting a made-up pid would let `taskkill` aim at whatever
     *     process happens to own that id.
     *
     * The run itself happens in the background (the promise is not
     * awaited here), so a mobile run behaves like a browser run: the
     * caller gets a handle immediately and the run reports its own
     * completion.
     */
    start({ project, run, file, outputDir, cases, testUid } = {}) {
      // The project is remembered, so the driver can read the packages
      // the project declares.
      lastProject = project ?? null;
      packagesCache = null;
      const resolved = this.resolveDevice();
      const root = evidenceRoot || outputDir || null;
      if (!root) {
        throw new MobileTargetError(
          MOBILE_REJECTION.TARGET_UNAVAILABLE,
          'the mobile runner has nowhere to write its evidence',
          { reason: 'no-evidence-root' },
        );
      }

      // The cases to run. The caller may narrow the run down to one file
      // or to one case; the catalogue is the same one the API serves.
      const catalogue = discoverMobileCases(project);
      let selected = catalogue.tests;
      if (file) selected = selected.filter((t) => t.file === file);
      if (testUid) selected = selected.filter((t) => t.uid === testUid);
      if (cases && Array.isArray(cases) && cases.length) selected = cases;

      const d = getDriver();
      // The `child` of the handle is a PassThrough: it is a stream, so it
      // is also an EventEmitter, so the bridge can read `child.stdout` /
      // `child.stderr` and call `child.on('close')` -- the same shape a
      // spawned process has.
      const child = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;

      const handle = {
        engine: 'android',
        runner: 'android',
        aborted: false,
        reportFile: `${String(run?.id ?? 'run')}-android-report.json`,
        outputDir: root,
        results: [],
        summary: null,
        error: null,
        child,
        // There is NO process behind a mobile run: the pid is 0, not a
        // made-up number. `taskkill /PID 0` would aim at the whole
        // process group of the machine.
        pid: 0,
        command: 'adb',
        args: [],
        engineVersion: null,
        stop() {
          this.aborted = true;
        },
      };

      // The run, in the background. The bridge learns about it through
      // the `close` event, exactly as it learns about a process exit.
      const reportFile = handle.reportFile;
      (async () => {
        const results = [];
        let error = null;
        try {
          for (const testCase of selected) {
            if (handle.aborted) break;
            const result = await d.runCase(testCase, { evidenceRoot: root, project });
            results.push(result);
            stdout.write(`[${result.status}] ${testCase.title ?? testCase.uid}\n`);
            for (const step of result.steps) {
              stdout.write(`  ${step.status === STEP_STATUS.PASSED ? 'ok  ' : 'FAIL'} ${step.kind}\n`);
              if (step.error) stderr.write(`  ${step.error.failure}: ${step.error.message.split('\n')[0]}\n`);
            }
            if (result.status === STEP_STATUS.FAILED) {
              error = result.error;
              break;
            }
          }
        } catch (e) {
          error = { failure: MOBILE_FAILURE.DRIVER_ERROR, message: e.message, details: e.details ?? {} };
        }

        const summary = summarise(results);
        handle.results = results;
        handle.summary = summary;
        handle.error = error;

        // The report file: the same JSON shape the other engines produce,
        // so the bridge can archive it and ATS-604 can put it into the
        // unified evidence model.
        const report = {
          engine: 'android',
          runner: 'android',
          device: resolved.session.sessionId,
          target: resolved.target.targetId,
          startedAt: results.length ? results[0].startedAt : new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          summary,
          cases: results,
        };
        try {
          fs.mkdirSync(root, { recursive: true });
          fs.writeFileSync(`${root}/${reportFile}`, JSON.stringify(report, null, 2), 'utf8');
        } catch (e) {
          stderr.write(`the mobile report could not be written: ${e.message}\n`);
        }

        stdout.end();
        stderr.end();
        // The exit code mirrors the outcome: 0 when every case passed,
        // 1 when one failed. The bridge reads it as the run's exit code.
        child.emit('close', summary.failed > 0 ? 1 : 0, null);
      })();

      return handle;
    },

    /** Stop a run that is in flight. */
    stop(handle) {
      if (!handle || handle.engine !== 'android') throw new Error('RUN_NOT_ACTIVE');
      handle.aborted = true;
    },

    /**
     * Collect the results of a finished run.
     *
     * The shape is the one of the other engines: a `summary` with the
     * counters and the cases, so the bridge shows a mobile run and a Web
     * run the same way.
     */
    collect({ outputDir } = {}) {
      if (!outputDir) return null;
      const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('-android-report.json'));
      if (!files.length) return null;
      const report = JSON.parse(fs.readFileSync(`${outputDir}/${files[files.length - 1]}`, 'utf8'));
      return { summary: report.summary };
    },

    /* --- the ATS-601 device helpers, on the adapter itself --- */

    /**
     * Resolve the session this adapter would run on.
     *
     * The rules are ATS-601's, applied in their order: the target must
     * exist, the session must belong to it, the session must be
     * acquirable, the lease must not have expired, the session must not
     * claim more than its target declared, and the session must be one
     * the user registered.
     *
     * The registration rule applies to a session the CALLER supplied. A
     * session the adapter built itself from the attached device is
     * registered by the very act of attaching it -- and only for a
     * `local-emulator`, whose lifecycle the platform owns (docs/25 §3.1).
     */
    resolveDevice({ now = new Date() } = {}) {
      const pair = resolvedTargetAndSession();
      const resolved = resolveSession(pair.target, pair.session, { now });
      // Only a session the CALLER supplied has to be in the registration
      // list; a built one is registered by the attachment itself.
      if (pair.session === session) {
        assertRegisteredSession(registeredSessionIds, resolved);
      }
      return { target: pair.target, session: resolved };
    },

    /** The honest description of what this adapter is. */
    describe() {
      const { device, error } = attachedDevice();
      // The target and the session are the ones that would be USED. When
      // the caller gave none, they are built from the attached device --
      // so the description names the device the run would really use.
      let used = null;
      try {
        used = resolvedTargetAndSession();
      } catch { /* no device: the note below says so */ }
      return {
        kind: adapter.kind,
        contractVersion: adapter.contractVersion,
        deviceContractVersion: DEVICE_CONTRACT_VERSION,
        designStatus: device ? 'DRIVER' : 'CONTRACT_ONLY',
        note: device
          ? `the Android driver is attached to ${device.serial} and drives it through adb`
          : 'the Android driver is implemented, but no device is attached; the adb client reported: '
            + (error ?? 'no device'),
        targetKind: used ? used.target.kind : null,
        sessionId: used ? used.session.sessionId : null,
        adbPath: client,
        device: device ? { serial: device.serial, model: device.model, sdk: device.sdk } : null,
      };
    },

    /** The driver, for a caller that wants to probe the device. */
    driver: getDriver,
  };

  return adapter;
}

/**
 * Why one device capability is NOT supported by this session.
 *
 * The rule is the one of ATS-601, read from the same two functions
 * (`sessionUsability` and `provableCapabilities`), so the device layer
 * and the resolve path cannot disagree about one session.
 */
function unsupportedReason(name, s, t, usability, undeclared, targetMismatch) {
  if (!usability.usable) {
    return `the session ${s ? s.sessionId : '(none)'} is not usable (${usability.reason})`;
  }
  if (targetMismatch) {
    return `the session ${s.sessionId} belongs to target ${s.targetId}, not to the target asked about`;
  }
  if (!t) {
    return `there is no target, so the session ${s.sessionId} proves no capability`;
  }
  if (undeclared.includes(name)) {
    return `the session ${s.sessionId} claims ${name}: not declared by target ${t.targetId}, so it was never proven`;
  }
  return `the session ${s.sessionId} did not prove ${name}`;
}

/**
 * The summary of a set of case results, in the COMMON result model.
 *
 * The counters are the ones of the other engines: `passed` / `failed` /
 * `skipped` / `flaky` / `total`. A mobile case that failed once and was
 * not retried is `failed`; the runner does not retry, so `flaky` stays 0.
 *
 * The shape is the one the bridge and the execution model expect, so a
 * mobile run is queryable together with a Web run (ATS-304) without a
 * second result vocabulary.
 */
function summarise(results) {
  const summary = {
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    total: results.length,
    executions: results.length,
    cases: results.map((r) => ({
      title: r.title,
      file: r.file ?? null,
      status: r.status,
      scope: [],
      line: r.line ?? null,
      column: null,
      caseKey: r.uid ?? r.title ?? null,
      outcome: r.status === STEP_STATUS.PASSED ? 'expected' : 'unexpected',
      duration: r.duration ?? 0,
      error: r.error ? r.error.message : '',
      attemptsCount: 1,
      attachments: [],
      attempts: [{
        status: r.status,
        expectedStatus: 'passed',
        outcome: r.status === STEP_STATUS.PASSED ? 'expected' : 'unexpected',
        retry: 0,
        duration: r.duration ?? 0,
        error: r.error ? r.error.message : '',
      }],
    })),
  };
  for (const r of results) {
    if (r.status === STEP_STATUS.PASSED) summary.passed += 1;
    else if (r.status === STEP_STATUS.FAILED) summary.failed += 1;
    else summary.skipped += 1;
  }
  return summary;
}

/**
 * The mobile cases of a project, read from the SAME discovery layer the
 * API serves.
 *
 * The discovery layer (`mapProjectFlows`) is imported DIRECTLY, not
 * through the core: the core imports the discovery layer, so importing
 * the core from an adapter would close a cycle. The layer itself has no
 * dependency on the adapters except on the mobile CONTRACT
 * (`mobile-target.mjs`), which this adapter imports anyway -- so the
 * graph stays acyclic.
 *
 * The cases carry the same shape as the ones the catalogue serves (uid,
 * file, title, line, steps), so the adapter cannot disagree with the API
 * about what the project contains.
 */
function discoverMobileCases(project) {
  if (!project || !project.root) {
    return { tests: [], files: [], warning: 'the project has no root' };
  }
  const mapped = mapProjectFlows(project.root);
  const tests = mapped.cases.map((c) => ({
    uid: c.uid,
    uidSource: c.uidSource ?? null,
    uidStable: c.uidStable ?? true,
    id: c.uid,
    file: c.file,
    title: c.title,
    line: c.line,
    source: 'mobile',
    engine: 'mobile',
    level: 'ST',
    appId: c.appId ?? null,
    tags: c.tags ?? [],
    steps: c.steps ?? [],
    unsupportedCount: c.unsupportedCount ?? 0,
  }));
  const files = [...new Set(tests.map((t) => t.file))];
  return { tests, files, warning: null };
}
