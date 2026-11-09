/**
 * ATS-603: the ADB transport of the Android runner.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The ONLY place that talks to `adb`. Every other module of the mobile
 * runner works with the DATA this module produces: a hierarchy tree, a
 * screenshot, a package list, a foreground window.
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * Two reasons, and the second one is the important one:
 *
 *   1. The ADB client itself is a DEPENDENCY of the runner, not part of
 *      its logic. Isolating it means the step semantics can be tested
 *      against a FAKE transport, without a device, and the real transport
 *      is exercised by the smoke test on the emulator.
 *
 *   2. ADB is a COMMAND LINE TOOL, and a command line tool is an attack
 *      surface: the arguments the runner builds can carry user data (a
 *      package name, an element text, a screenshot name). The runner NEVER
 *      builds a shell string. It always spawns `adb` with an ARGUMENT
 *      VECTOR, so a package name like `com.foo; rm -rf /` is one argument
 *      and not a command. That rule is enforced in ONE place -- here --
 *      and asserted by the unit tests.
 *
 * THE TRANSPORT CONTRACT
 * ----------------------
 * A transport is:
 *
 *   {
 *     devices(): [ {serial, state, model, sdk} ],
 *     shell(args, {timeout}): {ok, status, stdout, stderr},
 *     execOut(args, {timeout}): {ok, status, stdout: Buffer, stderr},
 *   }
 *
 * `shell` runs `adb -s <serial> shell <args>` and returns TEXT.
 * `execOut` runs `adb -s <serial> exec-out <args>` and returns BINARY --
 * a screenshot is PNG, not text, and it must not be mangled by a shell.
 *
 * The FAKE transport (`createFakeAdb`) implements the same contract over an
 * in-memory device, so the step semantics can be measured without an
 * emulator. The real one is `createAdbTransport`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The reasons an ADB operation can fail.
 *
 * The vocabulary is CLOSED: a caller can branch on the reason instead of
 * matching on message text. The four reasons are the four things that can
 * go wrong on the way to a device, and each of them has a different fix:
 *
 *   * `adb-missing`   -- the client is not installed. The fix is to install
 *                        the Android SDK platform-tools.
 *   * `device-absent` -- the client is there but no device is connected.
 *                        The fix is to start an emulator or plug in a phone.
 *   * `device-offline`-- the device is connected but not answering. The fix
 *                        is to wait for the boot to finish or reconnect.
 *   * `command-failed`-- the device answered and the command failed. The
 *                        fix is in the command itself, and the stderr of
 *                        the device is the diagnostic.
 *
 * `command-failed` is deliberately the LAST and the most specific one: the
 * runner must not report "no device" when the device is there and the
 * command was wrong. That distinction is the whole point of the failure
 * taxonomy of docs/25 §5.3.
 */
export const ADB_FAILURE = Object.freeze({
  ADB_MISSING: 'adb-missing',
  DEVICE_ABSENT: 'device-absent',
  DEVICE_OFFLINE: 'device-offline',
  COMMAND_FAILED: 'command-failed',
});

/** The error the transport raises. */
export class AdbError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AdbError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Find the `adb` executable.
 *
 * The order is deliberate:
 *
 *   1. `ANDROID_HOME` / `ANDROID_SDK_ROOT` -- the SDK the operator declared;
 *   2. the `platform-tools` directory inside it;
 *   3. `adb` on the PATH.
 *
 * The platform is NEVER searched for a copy of the client: a client found
 * in an arbitrary directory is a client of unknown version, and the
 * version of the client decides what the commands mean.
 */
export function resolveAdbPath({ env = process.env, platform = process.platform } = {}) {
  const sdkRoot = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || '';
  if (sdkRoot) {
    const candidates = [
      path.join(sdkRoot, 'platform-tools', 'adb.exe'),
      path.join(sdkRoot, 'platform-tools', 'adb'),
      path.join(sdkRoot, 'adb.exe'),
      path.join(sdkRoot, 'adb'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  if (platform === 'win32') {
    // The default location of the SDK installed by the official installer.
    const local = path.join(env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
    if (local && existsSync(local)) return local;
  }
  // On the PATH: the caller may have added it. `where`/`which` is not used,
  // because spawning a shell to find an executable is exactly what this
  // module refuses to do. The spawn below reports "not found" on its own.
  return 'adb';
}

/**
 * The maximum size of the output of ONE adb call.
 *
 * `spawnSync` buffers the whole output in memory and its default limit is
 * 1 MB. A screenshot of a 1080x2400 screen is well under that, but a
 * logcat buffer is not: the first screenshot attempt failed with
 * "spawnSync ... ENOBUFS", which is this limit. The limit is raised to a
 * size that fits the evidence the runner collects, and the timeout still
 * bounds the call.
 */
export const ADB_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run `adb` ASYNCHRONOUSLY and capture its output.
 *
 * WHY THERE IS AN ASYNC VARIANT
 * -----------------------------
 * The Bridge is a single-threaded Node server. A SYNCHRONOUS adb call
 * blocks its event loop for as long as the device takes to answer -- and
 * an emulator answers `uiautomator dump` in seconds. While the loop is
 * blocked the HTTP server answers NOTHING: a client that asks for the
 * run's status gets a connection reset.
 *
 * That was measured: the end-to-end test started a mobile run through the
 * Bridge, and the very next request ("is the run still going?") failed
 * with ECONNRESET, because the Bridge was inside a synchronous `adb`
 * call.
 *
 * So the transport has an async form, and the runner uses it. The
 * synchronous form is kept for the places that genuinely need it (the
 * probe scripts, and the fake transport's contract), but the RUN path is
 * asynchronous.
 */
export function runAdbAsync(client, args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(client, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new AdbError(ADB_FAILURE.ADB_MISSING, `the adb client could not be started: ${e.message}`, { args }));
      return;
    }
    const out = [];
    const errOut = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(reject, new AdbError(
        ADB_FAILURE.COMMAND_FAILED,
        `the adb command did not finish within ${timeout}ms`,
        { args },
      ));
    }, timeout);
    child.stdout.on('data', (b) => {
      out.push(b);
      if (out.reduce((n, c) => n + c.length, 0) > ADB_MAX_BUFFER) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish(reject, new AdbError(ADB_FAILURE.COMMAND_FAILED, 'the adb output exceeded the buffer limit', { args }));
      }
    });
    child.stderr.on('data', (b) => errOut.push(b));
    child.on('error', (e) => {
      clearTimeout(timer);
      const code = e.code === 'ENOENT' ? ADB_FAILURE.ADB_MISSING : ADB_FAILURE.COMMAND_FAILED;
      finish(reject, new AdbError(code, `the adb client could not be started: ${e.message}`, { args }));
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(errOut).toString('utf8');
      if (status !== 0) {
        finish(reject, new AdbError(
          ADB_FAILURE.COMMAND_FAILED,
          `the device rejected the command (exit ${status}): ${stderr.trim() || stdout.toString('utf8').trim()}`,
          { args, status, stdout: stdout.toString('utf8'), stderr },
        ));
        return;
      }
      finish(resolve, { ok: true, status, stdout, stderr });
    });
  });
}

/**
 * A transport backed by the real `adb` client.
 *
 * `adbPath` may be given explicitly (the tests and the smoke runner pass
 * the client they probed). `timeout` bounds EVERY call: an ADB command
 * against a device that stopped answering must not hang a run forever.
 */
export function createAdbTransport({ adbPath, env = process.env, timeout = 30000 } = {}) {
  const client = adbPath || resolveAdbPath({ env });

  /**
   * Run `adb` with an ARGUMENT VECTOR. Never a shell string.
   *
   * `shell: false` is what makes that true, and it is asserted by the unit
   * tests: a package name or an element text can never become a command.
   */
  function run(args, { timeout: callTimeout = timeout } = {}) {
    let result;
    try {
      result = spawnSync(client, args, {
        timeout: callTimeout,
        encoding: 'buffer',
        windowsHide: true,
        shell: false,
        maxBuffer: ADB_MAX_BUFFER,
      });
    } catch (e) {
      throw new AdbError(ADB_FAILURE.ADB_MISSING, `the adb client could not be started: ${e.message}`, { args });
    }
    if (result.error) {
      const code = result.error.code === 'ENOENT' ? ADB_FAILURE.ADB_MISSING : ADB_FAILURE.COMMAND_FAILED;
      throw new AdbError(code, `the adb client could not be started: ${result.error.message}`, { args });
    }
    return {
      status: result.status,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: (result.stderr ?? Buffer.alloc(0)).toString('utf8'),
    };
  }

  return {
    kind: 'adb',
    adbPath: client,

    /** The connected devices, with their state. */
    devices() {
      const r = run(['devices', '-l']);
      return parseDevices(r.stdout.toString('utf8'));
    },

    /**
     * Run a shell command on the device and return TEXT.
     *
     * The `shell` SUBCOMMAND is part of the argument vector: `adb shell
     * pm list packages` is the command, and `adb pm list packages` is
     * not a command at all -- adb answers "unknown command pm" and exits
     * 1. The first IT run measured exactly that.
     *
     * The arguments are passed to `adb shell` as separate arguments. ADB
     * itself joins them with spaces on the device, which is how the device
     * shell works -- so a value that contains a space stays one argument
     * here but is still one word on the device. Callers that pass
     * user-controlled data must quote it for the DEVICE shell themselves
     * (`shellQuote` below); the runner never does that implicitly.
     */
    shell(args, { timeout: callTimeout = timeout, serial } = {}) {
      const r = run(['-s', serial ?? this.defaultSerial(), 'shell', ...args], { timeout: callTimeout });
      const stdout = r.stdout.toString('utf8');
      if (r.status !== 0) {
        throw new AdbError(
          ADB_FAILURE.COMMAND_FAILED,
          `the device rejected the command (exit ${r.status}): ${r.stderr.trim() || stdout.trim()}`,
          { args, status: r.status, stdout, stderr: r.stderr },
        );
      }
      return { ok: true, status: r.status, stdout, stderr: r.stderr };
    },

    /**
     * Run a command and return its BINARY output.
     *
     * `exec-out` is used instead of `shell` because a screenshot is binary:
     * the device shell would translate line endings and mangle the bytes.
     */
    execOut(args, { timeout: callTimeout = timeout, serial } = {}) {
      const r = run(['-s', serial ?? this.defaultSerial(), 'exec-out', ...args], { timeout: callTimeout });
      if (r.status !== 0) {
        throw new AdbError(
          ADB_FAILURE.COMMAND_FAILED,
          `the device rejected the command (exit ${r.status}): ${r.stderr.trim()}`,
          { args, status: r.status, stderr: r.stderr },
        );
      }
      return { ok: true, status: r.status, stdout: r.stdout, stderr: r.stderr };
    },

    /** The serial the transport talks to. */
    defaultSerial() {
      if (!this._serial) {
        const devices = this.devices();
        const usable = devices.find((d) => d.state === 'device');
        if (!usable) {
          throw new AdbError(
            ADB_FAILURE.DEVICE_ABSENT,
            devices.length
              ? `the connected devices are not usable: ${devices.map((d) => `${d.serial} (${d.state})`).join(', ')}`
              : 'no device is connected to adb',
            { devices },
          );
        }
        this._serial = usable.serial;
      }
      return this._serial;
    },

    /* ---------------------------------------------------------------- */
    /* The ASYNC forms                                                 */
    /* ---------------------------------------------------------------- */

    /**
     * The ASYNC twin of `shell`.
     *
     * The Bridge's event loop must stay free while the device works, so
     * the RUN path uses this one. The two forms have the same contract:
     * the same arguments, the same result shape and the same failures.
     */
    async shellAsync(args, { timeout: callTimeout = timeout, serial } = {}) {
      const r = await runAdbAsync(
        client,
        ['-s', serial ?? this.defaultSerial(), 'shell', ...args],
        { timeout: callTimeout },
      );
      return { ok: true, status: r.status, stdout: r.stdout.toString('utf8'), stderr: r.stderr };
    },

    /** The ASYNC twin of `execOut`. */
    async execOutAsync(args, { timeout: callTimeout = timeout, serial } = {}) {
      const r = await runAdbAsync(
        client,
        ['-s', serial ?? this.defaultSerial(), 'exec-out', ...args],
        { timeout: callTimeout },
      );
      return { ok: true, status: r.status, stdout: r.stdout, stderr: r.stderr };
    },

    /** The ASYNC twin of `devices`. */
    async devicesAsync() {
      const r = await runAdbAsync(client, ['devices', '-l'], { timeout: timeout });
      return parseDevices(r.stdout.toString('utf8'));
    },

    /** Forget the cached serial (the device list may have changed). */
    reset() {
      this._serial = undefined;
    },
  };
}

/**
 * Read the device list out of `adb devices -l`.
 *
 * The parser is shared by the synchronous and the asynchronous form, so
 * the two cannot disagree about which devices are usable.
 */
function parseDevices(text) {
  const devices = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of devices')) continue;
    if (trimmed.startsWith('*')) continue; // adb's own chatter
    const m = trimmed.match(/^(\S+)\s+(device|offline|unauthorized|bootloader|recovery|sideload|host|no permissions)(.*)$/);
    if (!m) continue;
    const [, serial, state, rest] = m;
    const model = (rest.match(/\bmodel:(\S+)/) || [])[1] || null;
    const sdk = (rest.match(/\bsdk:(\S+)/) || [])[1] || null;
    devices.push({ serial, state, model, sdk });
  }
  return devices;
}

/**
 * Quote a value for the DEVICE shell.
 *
 * The device shell is POSIX-ish, so a single-quoted string is literal: a
 * package name or an element text with a space, a quote or a `$` survives
 * it unchanged. This is the ONLY place that knows how to quote, and the
 * runner uses it for every value that comes from a Flow.
 */
export function shellQuote(value) {
  const text = String(value ?? '');
  if (text === '') return "''";
  if (/^[A-Za-z0-9_./:@+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * A transport over a FAKE device.
 *
 * It exists so that the step semantics -- the part that decides what a
 * `tapOn` does and what a failure says -- can be measured without an
 * emulator. The fake is driven by a SCRIPT: a list of answers, one per
 * call, and a call that finds no answer FAILS the way a device does.
 *
 * That last property is the point: a fake that always succeeds would
 * prove nothing about the failure paths.
 *
 * AN ANSWER MAY BE A FUNCTION
 * ---------------------------
 * An answer may be a function `(label, index) => answer`. The element
 * search reads the hierarchy REPEATEDLY (it waits for the element), so a
 * script that has to answer the same question several times needs a way
 * to say "the same thing every time". Without it, a script ran out of
 * answers halfway through a wait and the test measured the wrong thing.
 */
export function createFakeAdb({ serial = 'fake-device', answers = [], device = {} } = {}) {
  const calls = [];
  const queue = [...answers];
  const state = {
    serial,
    device: { serial, state: 'device', model: 'Fake', sdk: '35', ...device },
  };

  /**
   * The next answer.
   *
   * A FUNCTION answer REPEATS: it is called for every call, so a script
   * can answer the same question as often as the runner asks it. That is
   * what the element search needs -- it reads the tree again and again
   * while it waits for an element, and a list with one entry for it
   * would run out halfway through the wait.
   */
  function next(label) {
    calls.push(label);
    // A function answer is not consumed: it answers every call.
    if (queue.length && typeof queue[0] === 'function') {
      return queue[0](label, calls.length - 1);
    }
    if (!queue.length) {
      throw new AdbError(ADB_FAILURE.COMMAND_FAILED, `the fake device has no answer for ${label}`, { label });
    }
    const answer = queue.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  }

  return {
    kind: 'fake-adb',
    adbPath: '(fake)',
    calls,

    devices() {
      return [state.device];
    },

    shell(args) {
      // The fake records the command the way the REAL transport issues
      // it: `shell <args...>`. The unit tests assert on the recorded
      // command, and a fake that recorded it differently would make the
      // tests pass while the real runner was wrong. The `shell`
      // subcommand is part of it, exactly as in the real transport.
      const answer = next(['shell', ...args].join(' '));
      if (typeof answer === 'string') return { ok: true, status: 0, stdout: answer, stderr: '' };
      return { ok: true, status: 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    },

    /**
     * The ASYNC twin of `shell`.
     *
     * The runner uses the async form (the Bridge must not block its
     * event loop), so the fake has to answer it the same way -- otherwise
     * the unit tests would measure a different path from the real one.
     */
    async shellAsync(args) {
      return this.shell(args);
    },

    execOut(args) {
      const answer = next(args.join(' '));
      if (Buffer.isBuffer(answer)) return { ok: true, status: 0, stdout: answer, stderr: '' };
      if (typeof answer === 'string') return { ok: true, status: 0, stdout: Buffer.from(answer, 'utf8'), stderr: '' };
      return { ok: true, status: 0, stdout: Buffer.from(answer.stdout ?? '', 'utf8'), stderr: '' };
    },

    /** The ASYNC twin of `execOut`. */
    async execOutAsync(args) {
      return this.execOut(args);
    },

    defaultSerial() {
      return serial;
    },

    reset() {},
  };
}
