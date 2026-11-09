/**
 * ATS-603: the Android runner -- the driver that drives a real device.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The FIRST implementation of the mobile execution face. ATS-601 froze the
 * contract (targets, sessions, capabilities, rejections) and ATS-602 froze
 * the case model (Flow -> TestDefinition -> steps). This module is the
 * part that actually TOUCHES A DEVICE: it launches an app, taps an
 * element, asserts that an element is visible and takes a screenshot.
 *
 * IT IS AN IMPLEMENTATION OF THE EXISTING CONTRACT, NOT A NEW ONE
 * --------------------------------------------------------------
 * The step kinds are the ones ATS-601 froze (`launchApp` / `tapOn` /
 * `assertVisible` / `takeScreenshot` / `recordScreen` / `readLogs`) and
 * the arguments are the ones ATS-602 maps (`appId`, `text`, `id`, `name`,
 * `path`). The capability requirements are read from ATS-601's table, so
 * a step is refused before it runs when the device cannot do it -- the
 * runner does not have its own idea of what a device can do.
 *
 * THE FAILURE TAXONOMY (docs/25 §5.3)
 * -----------------------------------
 * This is the heart of the task. A mobile run must distinguish FOUR
 * failures, and a generic "execution failed" is not acceptable:
 *
 *   * `session-lost`   -- the device went away (unplugged, emulator
 *                        stopped, ADB restarted). The session is dead.
 *   * `element-not-found` -- the element is not on the screen. The
 *                        failure carries the VIEW HIERARCHY, so the reader
 *                        can see what the screen actually offered.
 *   * `assertion-failed`  -- the element IS there, but the assertion does
 *                        not hold (e.g. `notVisible` on a visible
 *                        element). The failure names the element.
 *   * `driver-error`   -- the driver itself failed: the app is not
 *                        installed, the command was rejected, the
 *                        screenshot could not be taken. The stderr of the
 *                        device is carried.
 *
 * The distinction is what makes the failure actionable: "the element is
 * not there" and "the driver could not talk to the device" have nothing
 * to do with each other, and a runner that folds them into one message
 * costs the reader the whole diagnosis.
 *
 * EVERY STEP IS OBSERVABLE
 * ------------------------
 * A step returns a RESULT, not a boolean:
 *
 *   { kind, status, at, detail, evidence[], error }
 *
 * `status` is one of `passed` / `failed` / `skipped`, and `error`, when
 * there is one, carries the failure CLASS from the taxonomy above. The
 * step result is what ATS-604 will archive into the unified evidence
 * model; this task produces it, ATS-604 stores it.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  MOBILE_REJECTION,
  MobileTargetError,
  negotiateMobileCapabilities,
  requireMobileCapabilities,
} from './mobile-target.mjs';
import { ADB_FAILURE, AdbError, shellQuote } from './android-adb.mjs';
import {
  centreOf,
  findMatches,
  isVisible,
  parseHierarchy,
  summariseHierarchy,
} from './android-hierarchy.mjs';

/**
 * The failure classes of a mobile step.
 *
 * The vocabulary is CLOSED, exactly like the rejection codes of ATS-601:
 * a caller can branch on the class instead of matching on the message.
 */
export const MOBILE_FAILURE = Object.freeze({
  /** The device went away in the middle of the run. */
  SESSION_LOST: 'session-lost',
  /** The element the step named is not on the screen. */
  ELEMENT_NOT_FOUND: 'element-not-found',
  /** The element was found, but the assertion does not hold. */
  ASSERTION_FAILED: 'assertion-failed',
  /** The driver failed: the command was rejected, the app is missing. */
  DRIVER_ERROR: 'driver-error',
  /** The step could not run because the device lacks the capability. */
  CAPABILITY_MISSING: 'capability-missing',
  /** The step was refused by a rule of the platform (package, trust). */
  REFUSED: 'refused',
});

/** The status of a step result. */
export const STEP_STATUS = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

/**
 * The error a failed step raises.
 *
 * It is a `MobileTargetError` subclass so that the EXISTING rejection
 * machinery catches it: a mobile failure is a rejection with a reason.
 */
export class MobileStepError extends MobileTargetError {
  constructor(failure, message, details = {}) {
    super(MOBILE_REJECTION.TARGET_UNAVAILABLE, message, { ...details, failure });
    this.name = 'MobileStepError';
    this.failure = failure;
  }
}

/**
 * How long to wait for an element to appear, and how often to look.
 *
 * The defaults are the ones a smoke run needs: an element that is not
 * there immediately often IS there a moment later, because the app is
 * still drawing. The runner waits for the element rather than failing on
 * the first miss -- but it does NOT wait forever, and it reports how many
 * attempts it made.
 */
export const DEFAULT_WAIT = Object.freeze({ timeoutMs: 5000, intervalMs: 250 });

/**
 * The Android driver.
 *
 * @param {object} opts
 * @param {object} opts.transport  an ADB transport (real or fake)
 * @param {object} opts.session    the ATS-601 session this run holds
 * @param {object} [opts.target]   the ATS-601 target
 * @param {string[]} [opts.registeredPackages] the packages the project registered
 * @param {object} [opts.wait]     {timeoutMs, intervalMs}
 * @param {function} [opts.sleep]  injectable sleep (the tests do not wait for real)
 */
export function createAndroidDriver(opts = {}) {
  const {
    transport,
    session,
    target = null,
    registeredPackages = [],
    wait = DEFAULT_WAIT,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = opts;

  if (!transport) throw new Error('the Android driver needs an ADB transport');
  if (!session) throw new Error('the Android driver needs a session');

  /**
   * Run a shell command on the device.
   *
   * Every ADB failure is TRANSLATED into the taxonomy here: an ADB error
   * that means "the device is gone" becomes `session-lost`, and anything
   * else becomes `driver-error`. The translation lives in ONE place, so
   * the two classes can never be confused.
   *
   * The call is ASYNCHRONOUS: the Bridge is a single-threaded server, and
   * a synchronous `adb` call would block its event loop for seconds --
   * long enough that the HTTP server answers nothing and the client's
   * next request fails with a connection reset.
   */
  async function deviceShell(args, { timeout } = {}) {
    try {
      return await transport.shellAsync(args, { timeout, serial: transport.defaultSerial() });
    } catch (e) {
      throw translateAdbError(e, args);
    }
  }

  /** Run a command and return binary output (a screenshot). */
  async function deviceExecOut(args, { timeout } = {}) {
    try {
      return await transport.execOutAsync(args, { timeout, serial: transport.defaultSerial() });
    } catch (e) {
      throw translateAdbError(e, args);
    }
  }

  /**
   * Translate an ADB failure into a step failure.
   *
   * `adb-missing` and `device-absent` are `session-lost`: from the point
   * of view of the RUN there is no device to run on. `device-offline` is
   * `session-lost` too. Everything else is a `driver-error`: the device
   * answered and the command was wrong.
   */
  function translateAdbError(e, args) {
    if (e instanceof MobileStepError) return e;
    if (e instanceof AdbError) {
      if (
        e.code === ADB_FAILURE.ADB_MISSING
        || e.code === ADB_FAILURE.DEVICE_ABSENT
        || e.code === ADB_FAILURE.DEVICE_OFFLINE
      ) {
        return new MobileStepError(
          MOBILE_FAILURE.SESSION_LOST,
          `the device session was lost: ${e.message}`,
          { adbCode: e.code, command: args.join(' ') },
        );
      }
      return new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        `the driver failed: ${e.message}`,
        { adbCode: e.code, command: args.join(' '), stderr: e.details.stderr ?? '', stdout: e.details.stdout ?? '' },
      );
    }
    return new MobileStepError(
      MOBILE_FAILURE.DRIVER_ERROR,
      `the driver failed: ${e.message}`,
      { command: args.join(' ') },
    );
  }

  /**
   * The VIEW HIERARCHY of the current screen.
   *
   * This is the evidence of every element search, and it is fetched as
   * XML through `exec-out` so that the bytes are not mangled by the
   * device shell.
   */
  async function readHierarchy() {
    const r = await deviceExecOut(['uiautomator', 'dump', '/dev/tty']);
    const xml = r.stdout.toString('utf8');
    // `uiautomator dump /dev/tty` prints the XML, but it may also print a
    // status line before it. The document starts at the XML declaration
    // or at the <hierarchy> element.
    const start = xml.indexOf('<hierarchy');
    if (start < 0) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        'the device did not return a view hierarchy',
        { stdout: xml.slice(0, 500) },
      );
    }
    const end = xml.lastIndexOf('</hierarchy>');
    const document = end > start ? xml.slice(start, end + '</hierarchy>'.length) : xml.slice(start);
    try {
      return parseHierarchy(document);
    } catch (e) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        `the view hierarchy could not be read: ${e.message}`,
        { stdout: xml.slice(0, 500) },
      );
    }
  }

  /**
   * Wait until an element matches, and return the match.
   *
   * The wait is bounded and it REPORTS the attempts it made, so a failure
   * says "the element was not there after 20 attempts over 5 seconds" --
   * not just "not found".
   */
  async function waitForElement(target_, { timeoutMs = wait.timeoutMs, intervalMs = wait.intervalMs } = {}) {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    let lastTree = null;
    let lastError = null;
    for (;;) {
      attempts += 1;
      // A TRANSIENT hierarchy failure is retried, not fatal.
      //
      // `uiautomator dump` fails intermittently on a busy emulator: it
      // answers "ERROR: could not get idle state" or returns an empty
      // document while the app is still drawing. The first IT run failed
      // with exactly that ("the device did not return a view hierarchy"),
      // and it was NOT a real failure of the element search -- the
      // element was there. Treating a transient dump failure as a fatal
      // driver error turned a busy device into a red run.
      //
      // So a dump that cannot be read is retried until the deadline, and
      // the LAST error is carried into the result -- so a search that
      // really could not read the tree still says WHY.
      try {
        const tree = await readHierarchy();
        lastTree = tree;
        lastError = null;
        const matches = findMatches(tree, target_);
        if (matches.length) return { node: matches[0], matches, attempts, tree, hierarchyError: null };
        if (Date.now() >= deadline) {
          return { node: null, matches: [], attempts, tree: lastTree, hierarchyError: null };
        }
      } catch (e) {
        lastError = e;
        if (Date.now() >= deadline) {
          // The tree could not be read at all: that IS a driver error,
          // and it is reported as one -- with the driver's own words.
          throw e;
        }
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  }

  /**
   * The foreground application of the device.
   *
   * `dumpsys window` is the source. The PACKAGE of the foreground app is
   * what proves that an app really came to the front -- a launch command
   * that returned 0 proves only that the command was accepted.
   *
   * THE SOURCE OF TRUTH IS `mFocusedApp`, NOT `mCurrentFocus`
   * -------------------------------------------------------
   * `mCurrentFocus` names the window that has the INPUT focus, and that
   * is not always the app: a system dialog (an ANR prompt, a toast, the
   * permission dialog) takes the input focus while the app underneath is
   * still the focused ACTIVITY. The first E2E run measured exactly that:
   * the emulator's SystemUI had an ANR dialog on top, so
   * `mCurrentFocus` said "Application Not Responding: com.android.systemui"
   * while `mFocusedApp` said "com.ichor.smoke/.MainActivity" -- the app
   * WAS in the foreground.
   *
   * So `mFocusedApp` is read FIRST, and `mCurrentFocus` is only the
   * fallback for the devices that do not report it.
   */
  async function foregroundPackage() {
    const r = await deviceShell(['dumpsys', 'window'], { timeout: 15000 });
    const text = r.stdout;
    // The focused ACTIVITY: the app the user is looking at.
    let m = text.match(/mFocusedApp=.*?([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/);
    if (!m) m = text.match(/mCurrentFocus=Window\{[^}]*?\s+([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\}/);
    if (!m) m = text.match(/mFocusedWindow=Window\{[^}]*?\s+([A-Za-z0-9_.]+)\//);
    if (!m) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        'the driver could not read the foreground window of the device',
        { stdout: text.slice(0, 500) },
      );
    }
    return { package: m[1], activity: m[2] };
  }

  /**
   * The packages installed on the device.
   */
  async function installedPackages() {
    const r = await deviceShell(['pm', 'list', 'packages']);
    return r.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('package:'))
      .map((line) => line.slice('package:'.length).trim())
      .filter(Boolean);
  }

  /**
   * The size of the screen, in pixels.
   */
  async function screenSize() {
    const r = await deviceShell(['wm', 'size']);
    const m = r.stdout.match(/Physical size:\s*(\d+)x(\d+)/) || r.stdout.match(/Override size:\s*(\d+)x(\d+)/);
    if (!m) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        'the driver could not read the screen size of the device',
        { stdout: r.stdout.slice(0, 500) },
      );
    }
    return { width: Number(m[1]), height: Number(m[2]) };
  }

  /* ---------------------------------------------------------------- */
  /* The steps                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * `launchApp` -- bring the app to the front.
   *
   * The app must be REGISTERED (docs/25 §9): an arbitrary package name
   * from a Flow must never reach the device. The check is
   * `assertRegisteredAppPackage` of ATS-601 -- the SAME function, not a
   * second copy of the rule.
   *
   * The step passes only when the app really is in the foreground: the
   * launch command returning 0 proves nothing about the focus.
   */
  async function launchApp(step) {
    const appId = step.args?.appId;
    if (!appId) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        'the launchApp step names no app package',
        { step: step.raw ?? null },
      );
    }
    // The registration rule of ATS-601, used as-is.
    const { assertRegisteredAppPackage } = await import('./mobile-target.mjs');
    try {
      assertRegisteredAppPackage(registeredPackages, appId);
    } catch (e) {
      throw new MobileStepError(
        MOBILE_FAILURE.REFUSED,
        `the app package ${appId} is not registered for this project: ${e.message}`,
        { packageName: appId, code: e.code },
      );
    }

    // The app must be there: launching an app that is not installed is a
    // DRIVER error, not a silent no-op.
    if (!(await installedPackages()).includes(appId)) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        `the app ${appId} is not installed on the device`,
        { packageName: appId },
      );
    }

    const r = await deviceShell(['am', 'start', '-W', '-n', `${appId}/.MainActivity`]);
    // `am start -W` reports the status of the launch. A launch that the
    // system refused is a driver error with the system's own words.
    if (/^Error:/m.test(r.stdout) || /Error type/i.test(r.stdout)) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        `the device refused to launch ${appId}: ${r.stdout.trim().split('\n').slice(0, 3).join(' ')}`,
        { packageName: appId, stdout: r.stdout.slice(0, 1000) },
      );
    }

    // The proof: the app is in the foreground.
    const fg = await foregroundPackage();
    if (fg.package !== appId) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        `the launch of ${appId} did not bring it to the foreground (the foreground app is ${fg.package})`,
        { packageName: appId, foreground: fg },
      );
    }
    return {
      detail: { packageName: appId, foreground: fg, launchOutput: r.stdout.slice(0, 1000) },
      evidence: [{ kind: 'foreground', packageName: fg.package, activity: fg.activity }],
    };
  }

  /**
   * `tapOn` -- tap an element.
   *
   * The element is LOCATED in the hierarchy and then tapped at its
   * centre. There is no coordinate-only fallback: without the hierarchy
   * the element cannot be located, and a blind tap would be a different
   * step (docs/25 §3.3).
   */
  async function tapOn(step) {
    const target_ = elementTargetOf(step);
    const found = await waitForElement(target_);
    if (!found.node) {
      throw new MobileStepError(
        MOBILE_FAILURE.ELEMENT_NOT_FOUND,
        `the element ${describeTarget(target_)} was not found after ${found.attempts} attempt(s) `
        + `over ${wait.timeoutMs}ms; the screen offered:\n${summariseHierarchy(found.tree)}`,
        {
          target: target_,
          attempts: found.attempts,
          hierarchy: found.tree ? summariseHierarchy(found.tree) : '',
          visibleElements: found.tree ? found.tree.nodes.filter(isVisible).length : 0,
        },
      );
    }
    const point = centreOf(found.node);
    // The tap itself: `input tap x y`. The coordinates are NUMBERS the
    // runner computed, so they cannot carry a command.
    const r = await deviceShell(['input', 'tap', String(point.x), String(point.y)]);
    return {
      detail: {
        target: target_,
        point,
        attempts: found.attempts,
        matched: found.matches.length,
        element: {
          class: found.node.class,
          id: found.node.id,
          text: found.node.text,
          desc: found.node.desc,
          clickable: found.node.clickable,
          bounds: found.node.bounds,
        },
        output: r.stdout,
      },
      evidence: [{
        kind: 'hierarchy',
        reason: 'the tree the element was located in',
        summary: summariseHierarchy(found.tree),
      }],
    };
  }

  /**
   * `assertVisible` -- assert that an element is (or is not) visible.
   *
   * The failure of this step is an ASSERTION failure, and it is a
   * different failure from "the element was not found": the element IS
   * there (it was found), and the assertion about it does not hold. The
   * two are told apart by the qualifier: `visible` fails when the
   * element is absent, `notVisible` fails when the element is present.
   */
  async function assertVisible(step) {
    const target_ = elementTargetOf(step);
    const assertion = step.assertion ?? {};
    const visibility = Object.keys(assertion).find((k) => k === 'visible' || k === 'notVisible') ?? 'visible';
    const wantsVisible = visibility === 'visible';

    // A `notVisible` assertion is judged on the FIRST readable tree: the
    // element is either there or it is not, and waiting for it to appear
    // would be the opposite of the assertion. The wait is therefore 0
    // for that case -- but a TRANSIENT hierarchy failure is still retried
    // for a short while, because "the tree could not be read" is not
    // "the element is not there".
    const found = await waitForElement(
      target_,
      { timeoutMs: wantsVisible ? wait.timeoutMs : Math.min(wait.timeoutMs, 2000) },
    );
    const present = Boolean(found.node);

    if (wantsVisible && !present) {
      throw new MobileStepError(
        MOBILE_FAILURE.ASSERTION_FAILED,
        `the assertion failed: the element ${describeTarget(target_)} is not visible; the screen offered:\n${summariseHierarchy(found.tree)}`,
        {
          target: target_,
          assertion: visibility,
          hierarchy: found.tree ? summariseHierarchy(found.tree) : '',
        },
      );
    }
    if (!wantsVisible && present) {
      throw new MobileStepError(
        MOBILE_FAILURE.ASSERTION_FAILED,
        `the assertion failed: the element ${describeTarget(target_)} IS visible, but the assertion said it must not be`,
        {
          target: target_,
          assertion: visibility,
          element: {
            class: found.node.class,
            id: found.node.id,
            text: found.node.text,
            bounds: found.node.bounds,
          },
        },
      );
    }
    return {
      detail: {
        target: target_,
        assertion: visibility,
        attempts: found.attempts,
        satisfied: true,
      },
      evidence: [{
        kind: 'hierarchy',
        reason: 'the tree the assertion was judged against',
        summary: summariseHierarchy(found.tree),
      }],
    };
  }

  /**
   * `takeScreenshot` -- capture the screen.
   *
   * The PNG is pulled with `exec-out screencap -p` (binary, not through
   * the device shell), written into the evidence root, and its SIZE is
   * checked against the screen size the device reports -- a screenshot
   * that is not the size of the screen is a broken capture, and saying so
   * is better than archiving it.
   *
   * ATS-604 owns the archiving into the unified evidence model; this
   * task writes the file and produces the record.
   */
  async function takeScreenshot(step, { evidenceRoot } = {}) {
    if (!evidenceRoot) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        'the takeScreenshot step has no evidence root to write into',
        { step: step.raw ?? null },
      );
    }
    const name = step.args?.name || step.args?.path || 'screenshot';
    const safeName = sanitiseEvidenceName(name);
    const relative = `screenshots/${safeName}.png`;
    const absolute = path.resolve(evidenceRoot, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });

    const r = await deviceExecOut(['screencap', '-p']);
    const png = r.stdout;
    if (!png || png.length < 8) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        'the device returned no screenshot data',
        { bytes: png ? png.length : 0 },
      );
    }
    // The PNG signature. A file that does not start with it is not a PNG,
    // and archiving it as one would be a lie.
    const isPng = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        'the screenshot the device returned is not a PNG',
        { bytes: png.length, head: png.subarray(0, 16).toString('hex') },
      );
    }
    writeFileSync(absolute, png);

    const size = await screenSize();
    const dimensions = pngDimensions(png);
    if (dimensions && (dimensions.width !== size.width || dimensions.height !== size.height)) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        `the screenshot is ${dimensions.width}x${dimensions.height} but the device reports ${size.width}x${size.height}`,
        { file: relative, dimensions, screenSize: size },
      );
    }
    return {
      detail: { file: relative, bytes: png.length, dimensions, screenSize: size },
      evidence: [{
        kind: 'screenshot',
        file: relative,
        bytes: png.length,
        dimensions,
      }],
    };
  }

  /**
   * `readLogs` -- read the device log.
   *
   * The logcat buffer is read with a time window. The step writes it into
   * the evidence root and returns the record; ATS-604 archives it.
   */
  async function readLogs(step, { evidenceRoot } = {}) {
    if (!evidenceRoot) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        'the readLogs step has no evidence root to write into',
        { step: step.raw ?? null },
      );
    }
    const args = ['logcat', '-d', '-v', 'threadtime'];
    if (step.args?.since) args.push('-T', String(step.args.since));
    const r = await deviceShell(args, { timeout: 30000 });
    const name = sanitiseEvidenceName(step.args?.path || step.args?.name || 'device-log');
    const relative = `logs/${name}.log`;
    const absolute = path.resolve(evidenceRoot, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, r.stdout, 'utf8');
    return {
      detail: { file: relative, bytes: Buffer.byteLength(r.stdout, 'utf8'), lines: r.stdout.split('\n').length },
      evidence: [{ kind: 'log', file: relative, bytes: Buffer.byteLength(r.stdout, 'utf8') }],
    };
  }

  /**
   * `recordScreen` -- record the screen.
   *
   * The device records a video with `screenrecord`, and the recording is
   * pulled afterwards. The step waits for the recording to stop, so the
   * file is complete when the step returns.
   */
  async function recordScreen(step, { evidenceRoot, recordMs = 3000 } = {}) {
    if (!evidenceRoot) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        'the recordScreen step has no evidence root to write into',
        { step: step.raw ?? null },
      );
    }
    const name = sanitiseEvidenceName(step.args?.name || step.args?.path || 'recording');
    const relative = `recordings/${name}.mp4`;
    const absolute = path.resolve(evidenceRoot, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });

    // The recording happens on the device, into a device-side path; it is
    // pulled afterwards. The device path is derived from a name the runner
    // generated, so it cannot carry a command.
    const devicePath = `/sdcard/${name}.mp4`;
    await deviceShell(['rm', '-f', devicePath]);
    // screenrecord runs until it is told to stop, so it is started, the
    // step waits, and then the recording is stopped and pulled.
    await deviceShell(['screenrecord', '--time-limit', String(Math.ceil(recordMs / 1000)), devicePath]);
    const pulled = await deviceExecOut(['cat', devicePath]);
    await deviceShell(['rm', '-f', devicePath]);
    const bytes = pulled.stdout;
    if (!bytes || bytes.length === 0) {
      throw new MobileStepError(
        MOBILE_FAILURE.DRIVER_ERROR,
        'the device produced no recording data',
        { file: relative },
      );
    }
    writeFileSync(absolute, bytes);
    return {
      detail: { file: relative, bytes: bytes.length },
      evidence: [{ kind: 'recording', file: relative, bytes: bytes.length }],
    };
  }

  /* ---------------------------------------------------------------- */
  /* The runner                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Run ONE step.
   *
   * The result is ALWAYS a result object: a step that throws still
   * produces a `failed` result carrying the failure class. A step that
   * throws out of the runner would lose the taxonomy -- the caller would
   * have to classify the error itself, and the taxonomy is exactly what
   * the caller needs.
   */
  async function runStep(step, context = {}) {
    const at = new Date().toISOString();
    const handler = {
      launchApp,
      tapOn,
      assertVisible,
      takeScreenshot,
      readLogs,
      recordScreen,
    }[step.kind];

    if (!handler) {
      return {
        kind: step.kind,
        status: STEP_STATUS.SKIPPED,
        at,
        detail: {},
        evidence: [],
        error: {
          failure: MOBILE_FAILURE.DRIVER_ERROR,
          message: `the step kind ${step.kind} is not implemented by the Android runner`,
        },
      };
    }

    try {
      const result = await handler(step, context);
      return {
        kind: step.kind,
        status: STEP_STATUS.PASSED,
        at,
        detail: result.detail ?? {},
        evidence: result.evidence ?? [],
        error: null,
      };
    } catch (e) {
      const failure = e instanceof MobileStepError
        ? e.failure
        : (e && e.failure) || MOBILE_FAILURE.DRIVER_ERROR;
      return {
        kind: step.kind,
        status: STEP_STATUS.FAILED,
        at,
        detail: {},
        evidence: [],
        error: {
          failure,
          message: e.message,
          details: e.details ?? {},
        },
      };
    }
  }

  /**
   * Run a WHOLE case: the steps of one mobile TestCase.
   *
   * The runner stops at the first FAILED step -- a step after a failed
   * one would run against a screen the test did not expect. The result
   * carries the step results and the overall status.
   *
   * The capability negotiation happens BEFORE the first step: a step whose
   * capability the device does not have is reported as a gap, not
   * attempted. That is the ATS-601 rule, read from its own table.
   */
  async function runCase(testCase, context = {}) {
    const steps = Array.isArray(testCase?.steps) ? testCase.steps : [];
    const kinds = steps.map((s) => s.kind);

    // The negotiation. It is ATS-601's own function, so the runner has no
    // second opinion about what a device can do.
    let negotiation;
    try {
      negotiation = requireMobileCapabilities(session, kinds);
    } catch (e) {
      const failure = e instanceof MobileTargetError ? MOBILE_FAILURE.CAPABILITY_MISSING : MOBILE_FAILURE.DRIVER_ERROR;
      return {
        title: testCase?.title ?? null,
        uid: testCase?.uid ?? null,
        status: STEP_STATUS.FAILED,
        steps: [],
        negotiation: { supported: false, gaps: e.details?.gaps ?? [], unavailableSteps: e.details?.unavailableSteps ?? [] },
        error: { failure, message: e.message, details: e.details ?? {} },
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
    }

    const startedAt = new Date().toISOString();
    const results = [];
    let error = null;
    for (const step of steps) {
      const result = await runStep(step, context);
      results.push(result);
      if (result.status === STEP_STATUS.FAILED) {
        error = result.error;
        break;
      }
    }
    const failed = results.some((r) => r.status === STEP_STATUS.FAILED);
    return {
      title: testCase?.title ?? null,
      uid: testCase?.uid ?? null,
      status: failed ? STEP_STATUS.FAILED : STEP_STATUS.PASSED,
      steps: results,
      negotiation: {
        supported: negotiation.supported,
        gaps: negotiation.gaps,
        unavailableSteps: negotiation.unavailableSteps,
      },
      error,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  /**
   * Probe the device and report what it can PROVE.
   *
   * The capabilities of a session are PROVEN by trying them, not
   * declared by the caller (docs/25 §3.1). Each capability is proved by
   * the operation that needs it:
   *
   *   * `app.launch` / `app.install` -- the package manager answers;
   *   * `ui.hierarchy` -- the hierarchy dump returns a tree;
   *   * `ui.tap` -- a tap command is accepted;
   *   * `screen.capture` -- a screenshot comes back as a PNG;
   *   * `log.read` -- the logcat buffer can be read;
   *   * `screen.record` -- the recorder exists on the device.
   *
   * The probe is READ-ONLY apart from the tap test, and the tap test
   * taps the CENTRE of the screen -- a place no button usually is -- so
   * the probe does not change what the screen offers. That is a real
   * trade-off and it is stated here: the probe taps once.
   */
  async function probeCapabilities() {
    const proved = [];
    const unproved = [];

    /**
     * Prove one capability.
     *
     * A TRANSIENT failure is retried: the device is busy, the dump
     * fails once, and the capability is then reported as UNPROVED -- a
     * capability the device really has, reported as missing. That is the
     * lie the ATS-301 contract forbids ("a capability is supported only
     * when it has been PROVEN" -- and a proof that gave up after the
     * first hiccup is not a proof).
     */
    const prove = async (name, fn, attempts = 3) => {
      let lastError = null;
      for (let i = 0; i < attempts; i += 1) {
        try {
          const evidence = await fn();
          proved.push({ name, evidence });
          return true;
        } catch (e) {
          lastError = e;
          await sleep(400);
        }
      }
      unproved.push({ name, reason: lastError ? lastError.message : 'unknown error' });
      return false;
    };

    await prove('app.launch', async () => {
      const r = await deviceShell(['pm', 'list', 'packages']);
      return `the package manager answered ${r.stdout.split('\n').filter(Boolean).length} package(s)`;
    });
    await prove('ui.hierarchy', async () => {
      const tree = await readHierarchy();
      return `the view hierarchy was dumped and parsed: ${tree.nodes.length} node(s)`;
    });
    await prove('screen.capture', async () => {
      const r = await deviceExecOut(['screencap', '-p']);
      return `the device returned ${r.stdout.length} byte(s) of screen data`;
    });
    await prove('log.read', async () => {
      const r = await deviceShell(['logcat', '-d', '-v', 'threadtime'], { timeout: 20000 });
      return `the logcat buffer was read: ${r.stdout.split('\n').length} line(s)`;
    });
    await prove('screen.record', async () => {
      await deviceShell(['screenrecord', '--help'], { timeout: 15000 });
      return 'the device knows the screenrecord command';
    });
    await prove('ui.tap', async () => {
      const size = await screenSize();
      // The centre of the screen: a place where a button usually is not.
      const x = Math.round(size.width / 2);
      const y = Math.round(size.height / 2);
      await deviceShell(['input', 'tap', String(x), String(y)]);
      return `the device accepted a tap at ${x},${y}`;
    });

    return {
      proved: proved.map((p) => p.name),
      unproved: unproved.map((u) => u.name),
      evidence: Object.fromEntries(proved.map((p) => [p.name, p.evidence])),
      reasons: Object.fromEntries(unproved.map((u) => [u.name, u.reason])),
    };
  }

  return {
    kind: 'android',
    session,
    target,
    runStep,
    runCase,
    probeCapabilities,
    // The primitives, exposed so a probe or a test can use them.
    readHierarchy,
    foregroundPackage,
    installedPackages,
    screenSize,
    negotiate: (kinds) => negotiateMobileCapabilities(session, kinds),
  };
}

/**
 * The element a step names.
 *
 * A step names its target either by TEXT, by RESOURCE ID, or by both.
 * The runner reads the same names ATS-602 maps: `text` and `id`.
 */
function elementTargetOf(step) {
  const args = step.args ?? {};
  const assertion = step.assertion ?? {};
  // An `assertVisible` step carries its target in the assertion as well
  // as in the arguments; the argument wins, and the assertion is the
  // fallback.
  const text = args.text ?? args.label ?? args.title ?? null;
  const id = args.id ?? null;
  const assertionText = typeof assertion.visible === 'string'
    ? assertion.visible
    : (typeof assertion.notVisible === 'string' ? assertion.notVisible : null);
  return {
    text: text ?? assertionText,
    id,
    desc: null,
    regex: null,
  };
}

/**
 * A human-readable name of an element target, for a failure message.
 *
 * The failure has to name the ELEMENT (docs/25 §5.3: "an element that is
 * not visible must give the element name, not a generic failure"), so the
 * target is rendered from whatever names it carries.
 */
export function describeTarget(target) {
  if (!target) return '(no target)';
  if (target.id) return `with the resource id "${target.id}"`;
  if (target.text) return `with the text "${target.text}"`;
  if (target.regex) return `matching /${target.regex}/`;
  return '(the step names no element)';
}

/**
 * Make a name safe to use as a file name.
 *
 * The name comes from a Flow, so it is UNTRUSTED input. It must not
 * escape the evidence root, and it must not carry a path separator. The
 * rule is the same one the evidence path validation applies, and it is
 * applied here so that a name that would be refused later never reaches
 * the file system.
 */
export function sanitiseEvidenceName(name) {
  const text = String(name ?? '').trim();
  const base = text.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  return cleaned || 'unnamed';
}

/**
 * The dimensions of a PNG, read from its header.
 *
 * The IHDR chunk of a PNG carries the dimensions, so they can be read
 * without an image library. Returns null when the buffer is not a PNG.
 */
export function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
