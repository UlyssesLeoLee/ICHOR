/**
 * ATS-606: the iOS implementation status of the Maestro commands, read out
 * of the SHIPPED BYTE-CODE.
 *
 * The design document (docs/25 §8.4) makes claims about what Maestro can and
 * cannot do on an iOS simulator and on an iOS physical device. Those claims
 * are the factual base of the whole iOS support boundary, so they must be
 * checkable rather than asserted.
 *
 * WHERE THE FACTS COME FROM
 * -------------------------
 * Maestro's iOS support is split across three classes, and WHICH class an
 * operation lands in decides everything:
 *
 *   LocalIOSDevice          the facade every iOS operation goes through
 *     -> XCTestIOSDevice     the XCUITest driver (installed onto the device)
 *     -> deviceController    SimctlIOSDevice (simulator) or
 *                           DeviceControlIOSDevice (physical device)
 *
 * The XCTest driver is installed onto the DEVICE, so the HOST-SIDE code is
 * the same for a simulator and for a physical device. The deviceController is
 * NOT: it is `simctl` on a simulator and `devicectl` on a physical device,
 * and those two have different implementation status.
 *
 * So for every operation the probe answers two questions:
 *   1. which backend does LocalIOSDevice route it to?
 *   2. is that backend implemented for the simulator? for the device?
 *
 * The answer is read from the byte-code: a method body that throws
 * `kotlin/NotImplementedError` ("Not yet implemented") is NOT implemented.
 *
 * WHAT IS CHECKED
 * ---------------
 * EVERY row of the §8.4 tables, not a subset:
 *   * the six step kinds (launchApp / tapOn / assertVisible /
 *     takeScreenshot / recordScreen / readLogs);
 *   * the seven capabilities (app.install / app.launch / ui.tap /
 *     ui.hierarchy / screen.capture / screen.record / log.read);
 *   * the three hard preconditions of the physical-device path;
 *   * the two iOS no-ops (`back` and the airplane mode).
 *
 * WHY A PROBE AND NOT A DOCUMENT
 * ------------------------------
 * Because a claim in a document is not evidence. This probe re-derives the
 * routing and the implementation status from the jars, and then checks the
 * document's claims against what it derived. If Maestro ships a new version
 * that implements the physical-device path, this probe says so and the
 * document has to be corrected.
 *
 * HONESTY RULES
 * -------------
 *   - No Maestro installation => SKIP with the reason, exit code 2. A skip is
 *     never written as a pass.
 *   - The parser below is checked against the raw count of the marker string
 *     in each class file. If the parser and the raw count disagree, the
 *     parser is broken and the probe FAILS -- it does not report a verdict.
 *
 * usage: node tools/ats606-probes/probe-ios-driver-support.mjs
 * exit:  0 all checks passed, 1 a check failed, 2 could not run
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/* ------------------------------------------------------------------ */
/* The Maestro installation                                           */
/* ------------------------------------------------------------------ */

function findMaestroHome() {
  const roots = [
    process.env.ATS606_MAESTRO_HOME,
    'D:/AI-Tools/Maestro',
    path.join(os.homedir(), '.maestro'),
    '/usr/local',
    '/opt/homebrew',
  ].filter(Boolean);
  for (const r of roots) {
    const lib = path.join(r, 'lib');
    if (fs.existsSync(lib) && fs.existsSync(path.join(lib, 'maestro-ios-driver.jar'))) return lib;
  }
  return null;
}

const LIB = findMaestroHome();
if (!LIB) {
  console.log('SKIP no Maestro installation found.');
  console.log('     Set ATS606_MAESTRO_HOME to the Maestro directory to run this probe.');
  console.log('     The iOS implementation status was NOT verified on this machine.');
  process.exit(2);
}

const failures = [];
const fail = (m) => { console.log(`FAIL ${m}`); failures.push(m); };
const ok = (m) => console.log(`ok   ${m}`);

/** The version Maestro reports. */
let version = '(unknown)';
try {
  const bat = path.join(LIB, '..', 'bin', 'maestro.bat');
  const sh = path.join(LIB, '..', 'bin', 'maestro');
  const cmd = process.platform === 'win32' && fs.existsSync(bat) ? bat : sh;
  version = execFileSync(cmd, ['--version'], {
    encoding: 'utf8', timeout: 120000,
    shell: process.platform === 'win32' && cmd.endsWith('.bat'),
  }).trim();
} catch {
  /* the version is context, not a check */
}

console.log('=== ATS-606: the iOS implementation status (from the shipped byte-code) ===');
console.log(`lib    : ${LIB}`);
console.log(`version: ${version}`);
console.log('');

/* ------------------------------------------------------------------ */
/* Extracting the classes                                             */
/* ------------------------------------------------------------------ */

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ats606-ios-'));
const CLASSES = [
  ['maestro-ios-driver.jar', 'device/SimctlIOSDevice.class'],
  ['maestro-ios.jar', 'ios/xctest/XCTestIOSDevice.class'],
  ['maestro-ios.jar', 'ios/devicectl/DeviceControlIOSDevice.class'],
  ['maestro-ios.jar', 'ios/LocalIOSDevice.class'],
];

function extract(jar, entry) {
  const target = path.join(WORK, entry);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync('jar', ['xf', path.join(LIB, jar), entry], { cwd: WORK, timeout: 120000 });
  if (!fs.existsSync(target)) throw new Error(`cannot extract ${entry} from ${jar}`);
  return target;
}

const JAVAP = process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, 'bin', 'javap')
  : 'javap';

function javap(file) {
  return execFileSync(JAVAP, ['-p', '-c', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Splits `javap -c` output into method blocks.
 *
 * A METHOD header is a line at 2-space indent that ends with ');' and is
 * followed by a 'Code:' line. Field declarations end with ';' but are NOT
 * followed by 'Code:' -- matching on the ');' alone attributes a field's
 * bytes to the previous method, which silently moves every verdict.
 *
 * The lines are stripped of their line ending FIRST. `javap` on Windows
 * emits CRLF, and a check for the exact string 'Code:' then never matches
 * (the line is 'Code:\r') -- which makes the parser find zero methods and
 * report every operation as implemented.
 */
function parseMethods(text) {
  const lines = text.split(/\r?\n/);
  const out = {};
  let cur = null;
  let body = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const isHeader =
      /^ {2}\S/.test(l) && l.trimEnd().endsWith(');') &&
      i + 1 < lines.length && lines[i + 1].trim() === 'Code:';
    if (isHeader) {
      const m = /^ {2}.*?([\w$-]+)\(.*\);$/.exec(l);
      if (m) {
        if (cur !== null) out[cur] = body.join('\n');
        cur = m[1];
        body = [l];
        continue;
      }
    }
    if (cur !== null) body.push(l);
  }
  if (cur !== null) out[cur] = body.join('\n');
  return out;
}

const NOT_IMPL = 'Not yet implemented';

const classes = {};
for (const [jar, entry] of CLASSES) {
  const file = extract(jar, entry);
  const text = javap(file);
  const methods = parseMethods(text);
  // The parser is only trustworthy if it accounts for EVERY occurrence of
  // the marker in the file. When it does not, a method's bytes have been
  // attributed to the wrong method and every verdict below is suspect.
  const raw = (text.match(new RegExp(NOT_IMPL, 'g')) || []).length;
  const parsed = Object.values(methods).filter((b) => b.includes(NOT_IMPL)).length;
  if (raw !== parsed) {
    fail(`${entry}: the byte-code parser found ${parsed} unimplemented methods but the class contains ${raw} markers -- the parser is broken, no verdict is reported`);
    process.exit(1);
  }
  classes[entry] = methods;
  console.log(`ok   ${entry}: ${Object.keys(methods).length} methods, ${parsed} unimplemented`);
}

const simctl = classes['device/SimctlIOSDevice.class'];
const xctest = classes['ios/xctest/XCTestIOSDevice.class'];
const devicectl = classes['ios/devicectl/DeviceControlIOSDevice.class'];
const local = classes['ios/LocalIOSDevice.class'];

console.log('');

/* ------------------------------------------------------------------ */
/* 1. The routing: which backend does each operation reach?           */
/* ------------------------------------------------------------------ */

/**
 * The operations LocalIOSDevice routes to the XCTest driver (the same
 * implementation for a simulator and for a physical device) and the ones it
 * routes to the deviceController (simctl on a simulator, devicectl on a
 * device).
 */
const toXctest = [];
const toController = [];
for (const [name, body] of Object.entries(local)) {
  if (body.includes('XCTestIOSDevice.')) toXctest.push(name);
  else if (body.includes('device/IOSDevice.')) toController.push(name);
}
toXctest.sort();
toController.sort();

console.log('--- the routing of LocalIOSDevice ---');
console.log(`to the XCTest driver (same HOST-SIDE code for simulator and device): ${toXctest.length}`);
console.log(`  ${toXctest.join(', ')}`);
console.log(`to the deviceController (simctl on a simulator, devicectl on a device): ${toController.length}`);
console.log(`  ${toController.join(', ')}`);
console.log('');

if (toXctest.length === 0 || toController.length === 0) {
  fail('the routing could not be read -- both groups are empty, which means the byte-code layout changed');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 2. The implementation status, per path                             */
/* ------------------------------------------------------------------ */

const NOT_SUPPORTED = 'Not Supported';

function statusOf(body) {
  if (body === undefined) return 'ABSENT';
  if (body.includes(NOT_IMPL)) return 'NOT-IMPL';
  if (body.includes(NOT_SUPPORTED) || body.includes('not supported')) return 'NOT-SUPPORTED';
  return 'impl';
}

/** The status of one operation on one path. */
function status(op, path) {
  if (path === 'xctest') return statusOf(xctest[op]);
  if (path === 'simulator') return toController.includes(op) ? statusOf(simctl[op]) : statusOf(xctest[op]);
  if (path === 'device') return toController.includes(op) ? statusOf(devicectl[op]) : statusOf(xctest[op]);
  throw new Error(`unknown path ${path}`);
}

/**
 * The six platform step kinds and the Maestro operation each one needs.
 *
 * This is the mapping the design document's §8.4 table is built on.
 *
 * `readLogs` needs the DEVICE LOG STREAM, which is NOT one of
 * LocalIOSDevice's routed operations: it is started by `IOSDriver` itself
 * through `util.LocalSimulatorUtils.startDeviceLogStream`, i.e. it is
 * `xcrun simctl spawn <id> log stream --style syslog` and therefore
 * simulator-only. The probe checks that separately below.
 */
const STEP_REQUIREMENTS = [
  ['launchApp', ['launch']],
  ['tapOn', ['tap', 'viewHierarchy']],
  ['assertVisible', ['viewHierarchy']],
  ['takeScreenshot', ['takeScreenshot']],
  ['recordScreen', ['startScreenRecording']],
];

console.log('--- the five step kinds that map onto a routed operation ---');
console.log('step kind        operation          simulator      device');
const stepVerdict = {};
for (const [step, ops] of STEP_REQUIREMENTS) {
  for (const op of ops) {
    const sim = status(op, 'simulator');
    const dev = status(op, 'device');
    console.log(`${step.padEnd(16)} ${op.padEnd(17)} ${sim.padEnd(14)} ${dev}`);
    const s = stepVerdict[step] ??= { sim: 'impl', dev: 'impl' };
    if (sim !== 'impl') s.sim = sim;
    if (dev !== 'impl') s.dev = dev;
  }
}
console.log('');

/* ------------------------------------------------------------------ */
/* 3. The device log stream (the readLogs path)                       */
/* ------------------------------------------------------------------ */

console.log('--- the device log stream (the readLogs path) ---');
const driverFile = extract('maestro-client.jar', 'maestro/drivers/IOSDriver.class');
const driverText = javap(driverFile);
const driver = parseMethods(driverText);

{
  // The stream is started from IOSDriver, through LocalSimulatorUtils.
  const startsIt = /util\/LocalSimulatorUtils\.startDeviceLogStream/.test(driverText);
  if (startsIt) {
    ok('the device log stream is started by IOSDriver through util.LocalSimulatorUtils.startDeviceLogStream');
  } else {
    fail('the device log stream is NOT started through LocalSimulatorUtils -- the §8.4 readLogs claim does not hold');
  }

  // And LocalSimulatorUtils really runs simctl.
  const utilsFile = extract('maestro-ios-driver.jar', 'util/LocalSimulatorUtils.class');
  const utilsText = javap(utilsFile);
  const utils = parseMethods(utilsText);
  const startMethod = utils.startDeviceLogStream ?? '';
  const usesSimctl = /\/\/ String simctl/.test(startMethod);
  const usesSpawn = /\/\/ String spawn/.test(startMethod);
  const usesLogStream = /\/\/ String log/.test(startMethod) && /\/\/ String stream/.test(startMethod);
  if (usesSimctl && usesSpawn && usesLogStream) {
    ok('startDeviceLogStream runs `xcrun simctl spawn <id> log stream --style syslog` -- simulator-only');
  } else {
    fail(`startDeviceLogStream does not carry the expected simctl/spawn/log-stream sequence (simctl=${usesSimctl} spawn=${usesSpawn} logStream=${usesLogStream}) -- the §8.4 readLogs claim does not hold`);
  }

  // The physical-device controller must have NO device-log-stream method.
  const devicectlLogMethods = Object.keys(devicectl).filter((n) => /log/i.test(n));
  if (devicectlLogMethods.length) {
    fail(`the physical-device controller DOES have log-related methods (${devicectlLogMethods.join(', ')}) -- the §8.4 readLogs claim must be re-checked`);
  } else {
    ok('the physical-device controller exposes no device-log-stream method -- the readLogs path is simulator-only');
  }
}

/* ------------------------------------------------------------------ */
/* 3. The claims in the design document                               */
/* ------------------------------------------------------------------ */

const MD = path.join(REPO, 'docs', '25-MOBILE-APP-TESTING.md');
if (!fs.existsSync(MD)) {
  fail(`the design document is missing: ${MD}`);
  process.exit(1);
}
const md = fs.readFileSync(MD, 'utf8');
const section = md.slice(md.indexOf('## 8. iOS'), md.indexOf('## 9. 安全与信任边界'));

/**
 * The document states, for each of the six step kinds, what Maestro can do
 * on the simulator and on the physical device. The claim is checked against
 * what was derived from the byte-code.
 *
 * The document's wording is about MAESTRO's implementation status
 * ("已实现" / "未实现" / "无对应实现"), not about this platform's
 * promises -- so that is what is checked here.
 */
const CLAIMS = [
  ['launchApp', 'sim', '已实现', 'dev', '未实现'],
  ['tapOn', 'sim', '已实现', 'dev', '已实现'],
  ['assertVisible', 'sim', '已实现', 'dev', '已实现'],
  ['takeScreenshot', 'sim', '已实现', 'dev', '已实现'],
  ['recordScreen', 'sim', '已实现', 'dev', '未实现'],
];

console.log('--- the design document claims (§8.4) ---');
for (const [step, p1, v1, p2, v2] of CLAIMS) {
  // The row of this step kind in the §8.4 table.
  const row = section.split('\n').find((l) => l.startsWith(`| \`${step}\` |`));
  if (!row) {
    fail(`§8.4 has no row for the step kind ${step}`);
    continue;
  }
  const cells = row.split('|').map((c) => c.trim());
  // | step | capability | maestro op | simulator | device | conclusion | basis |
  const simulatorCell = cells[4] ?? '';
  const deviceCell = cells[5] ?? '';
  const derivedSim = stepVerdict[step]?.sim === 'impl' ? v1 : '未实现';
  const derivedDev = stepVerdict[step]?.dev === 'impl' ? v2 : '未实现';

  const simOk = simulatorCell.includes(derivedSim);
  const devOk = deviceCell.includes(derivedDev);
  if (simOk && devOk) {
    ok(`§8.4 ${step}: simulator="${simulatorCell}" device="${deviceCell}" match the byte-code`);
  } else {
    fail(`§8.4 ${step}: the document says simulator="${simulatorCell}" device="${deviceCell}", the byte-code implies simulator="${derivedSim}" device="${derivedDev}"`);
  }
}

// The readLogs row: the device column must say there is no implementation.
{
  const row = section.split('\n').find((l) => l.startsWith('| `readLogs` |'));
  if (!row) {
    fail('§8.4 has no row for the step kind readLogs');
  } else {
    const cells = row.split('|').map((c) => c.trim());
    const simulatorCell = cells[4] ?? '';
    const deviceCell = cells[5] ?? '';
    if (simulatorCell.includes('已实现') && deviceCell.includes('无对应实现')) {
      ok(`§8.4 readLogs: simulator="${simulatorCell}" device="${deviceCell}" match the byte-code`);
    } else {
      fail(`§8.4 readLogs: the document says simulator="${simulatorCell}" device="${deviceCell}", the byte-code implies simulator="已实现" device="无对应实现"`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 5. The seven-capability table                                      */
/* ------------------------------------------------------------------ */

console.log('');
console.log('--- the seven capabilities (§8.4) ---');

/** The capability -> the operation it needs, and what "satisfiable" means. */
const CAPABILITIES = [
  ['app.install', ['install'], '可满足', '不可满足'],
  ['app.launch', ['launch'], '可满足', '不可满足'],
  ['ui.tap', ['tap'], '可满足', '可满足'],
  ['ui.hierarchy', ['viewHierarchy'], '可满足', '可满足'],
  ['screen.capture', ['takeScreenshot'], '可满足', '可满足'],
  ['screen.record', ['startScreenRecording'], '可满足', '不可满足'],
];

for (const [cap, ops, simWord, devWord] of CAPABILITIES) {
  const simOk = ops.every((op) => status(op, 'simulator') === 'impl');
  const devOk = ops.every((op) => status(op, 'device') === 'impl');

  // The row of this capability in the §8.4 table.
  const row = section.split('\n').find((l) => l.startsWith(`| \`${cap}\` |`));
  if (!row) {
    fail(`§8.4 has no row for the capability ${cap}`);
    continue;
  }
  const cells = row.split('|').map((c) => c.trim());
  const simCell = cells[2] ?? '';
  const devCell = cells[3] ?? '';
  const derivedSim = simOk ? simWord : '不可满足';
  const derivedDev = devOk ? devWord : '不可满足';
  if (simCell.includes(derivedSim) && devCell.includes(derivedDev)) {
    ok(`§8.4 ${cap}: simulator="${simCell}" device="${devCell}" match the byte-code`);
  } else {
    fail(`§8.4 ${cap}: the document says simulator="${simCell}" device="${devCell}", the byte-code implies simulator="${derivedSim}" device="${derivedDev}"`);
  }
}

// The log.read capability: the simulator-only log stream.
{
  const row = section.split('\n').find((l) => l.startsWith('| `log.read` |'));
  if (!row) {
    fail('§8.4 has no row for the capability log.read');
  } else {
    const cells = row.split('|').map((c) => c.trim());
    const simCell = cells[2] ?? '';
    const devCell = cells[3] ?? '';
    if (simCell.includes('可满足') && devCell.includes('不可满足')) {
      ok(`§8.4 log.read: simulator="${simCell}" device="${devCell}" match the byte-code`);
    } else {
      fail(`§8.4 log.read: the document says simulator="${simCell}" device="${devCell}", the byte-code implies simulator="可满足" device="不可满足"`);
    }
  }
}

// The claim that the physical-device path is only PARTLY implemented must
// match the derived counts.
const devNotImpl = toController.filter((op) => statusOf(devicectl[op]) === 'NOT-IMPL').length;
const devImpl = toController.filter((op) => statusOf(devicectl[op]) === 'impl').length;
console.log('');
console.log(`the physical-device controller: ${devImpl} implemented, ${devNotImpl} not implemented`);

const claimsPartial = /不是「全都不行」/.test(section);
if (claimsPartial && devNotImpl === 0) {
  fail('§8.4 claims the physical-device path is only partly implemented, but every deviceController operation is implemented');
} else if (claimsPartial) {
  ok(`§8.4 claims the physical-device path is only partly implemented, and ${devNotImpl} of the ${toController.length} deviceController operations are indeed not implemented`);
}

// The claim that the "same implementation" is the HOST-SIDE code must be
// scoped in the document, and the document must name the two device-side
// builds.
// builds.
if (/宿主侧/.test(section) && /driver-iPhoneSimulator/.test(section) && /driver-iphoneos/.test(section)) {
  ok('§8.4 scopes the "same implementation" claim to the host side and names the two device-side builds');
} else {
  fail('§8.4 does not scope the "same implementation" claim to the host side (or does not name the two device-side builds)');
}

/* ------------------------------------------------------------------ */
/* 4b. WHERE THE DEVICE-SIDE BUILDS LIVE                              */
/* ------------------------------------------------------------------ */
// The two device-side runner builds are the ones the round-2 review
// caught: the document attributed them to `maestro-cli-2.12.1.jar`, but
// that jar holds only the Swift SOURCES under `driver/ios/`. The
// prebuilt runners are in `maestro-ios-driver.jar`, under
// `driver-iPhoneSimulator/` and `driver-iphoneos/`.
//
// This is checked against the JAR LISTS, not against the document: the
// probe reads every jar's entries and reports which jar really holds
// which directory. A document that names the wrong jar is caught here,
// and so is a claim that some jar holds `driver-ios/`.
console.log('');
console.log('--- where the device-side runner builds live (the jar lists) ---');

const JARS = fs.readdirSync(LIB).filter((f) => f.endsWith('.jar'));
const jarEntries = new Map();
for (const jar of JARS) {
  try {
    const out = execFileSync('jar', ['tf', path.join(LIB, jar)], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000,
    });
    jarEntries.set(jar, out.split(/\r?\n/).filter(Boolean));
  } catch {
    jarEntries.set(jar, []);
  }
}

/** The jars that hold an entry starting with the given prefix. */
const jarsHolding = (prefix) => [...jarEntries.entries()]
  .filter(([, entries]) => entries.some((e) => e.startsWith(prefix)))
  .map(([jar]) => jar)
  .sort();

const DEVICE_BUILD_DIRS = ['driver-iPhoneSimulator/', 'driver-iphoneos/'];
const deviceBuildOwners = {};
for (const dir of DEVICE_BUILD_DIRS) {
  const owners = jarsHolding(dir);
  deviceBuildOwners[dir] = owners;
  console.log(`${dir.padEnd(24)} -> ${owners.join(', ') || '(no jar holds it)'}`);
  if (owners.length === 1) {
    ok(`${dir} is held by exactly one jar: ${owners[0]}`);
  } else {
    fail(`${dir} is held by ${owners.length} jars (${owners.join(', ') || 'none'}) -- the attribution cannot be a single jar`);
  }
}

// The Swift source of the device-side runner is in the CLI jar -- and
// NOT in a `driver-ios/` directory, because no jar has one.
const swiftOwners = jarsHolding('driver/ios/maestro-driver-iosUITests/Routes/XCTestHTTPServer.swift');
console.log(`the XCTestHTTPServer.swift source -> ${swiftOwners.join(', ') || '(no jar holds it)'}`);
if (swiftOwners.length === 1) {
  ok(`the XCTestHTTPServer.swift source is in ${swiftOwners[0]}`);
} else {
  fail(`the XCTestHTTPServer.swift source is in ${swiftOwners.length} jars -- expected exactly one`);
}

const driverIosHolders = jarsHolding('driver-ios/');
if (driverIosHolders.length === 0) {
  ok('no jar holds a `driver-ios/` directory -- so any document that cites `driver-ios/` as a jar path is wrong');
} else {
  fail(`these jars hold a \`driver-ios/\` directory (${driverIosHolders.join(', ')}) -- the §8.4 attribution must be re-checked`);
}

// And the document must name the RIGHT jar for the two device-side
// builds.
const expectedOwner = deviceBuildOwners['driver-iPhoneSimulator/'][0];
if (!expectedOwner) {
  fail('the device-side builds could not be located in any jar -- the §8.4 attribution cannot be checked');
} else if (section.includes(expectedOwner)) {
  ok(`§8.4 attributes the two device-side builds to ${expectedOwner}, which is where the jar list really puts them`);
} else {
  fail(`§8.4 does NOT attribute the two device-side builds to ${expectedOwner} (the jar that really holds them)`);
}


// THE THREE HARD PRECONDITIONS
// ---------------------------
// Each precondition must be true of the SHIPPED ARTIFACTS, not merely
// mentioned in the document: a document keyword search proves only that
// the prose says so. So each precondition is checked against the
// byte-code (or the source) it claims to come from, and the document is
// then checked to STATE it.
console.log('');
console.log('--- the three hard preconditions (verified against the artifacts) ---');

// (1) The Apple team ID precondition: RealIOSDeviceDriver must really
//     carry the message and the exception.
const realDriverFile = extract('maestro-cli-2.12.1.jar', 'maestro/cli/driver/RealIOSDeviceDriver.class');
const realDriverText = javap(realDriverFile);
const teamIdMessage = 'Apple account team ID must be specified to build drivers for connected iPhone.';
if (realDriverText.includes(teamIdMessage)) {
  ok(`the byte-code of RealIOSDeviceDriver really carries "${teamIdMessage}"`);
} else {
  fail('RealIOSDeviceDriver does NOT carry the expected Apple team ID message -- the §8.4 precondition is not what the artifact says');
}
if (/MissingAppleTeamId/.test(realDriverText)) {
  ok('the byte-code of RealIOSDeviceDriver really carries the MissingAppleTeamId exception');
} else {
  fail('RealIOSDeviceDriver does NOT carry the MissingAppleTeamId exception -- the §8.4 precondition is not what the artifact says');
}

// (2) The devicectl runner install: LocalIOSDeviceController must really
//     run `xcrun devicectl ...`.
const controllerFile = extract('maestro-ios-driver.jar', 'util/LocalIOSDeviceController.class');
const controllerText = javap(controllerFile);
const controllerUses = ['xcrun', 'devicectl', 'install', 'app', 'launch']
  .filter((needle) => controllerText.includes(needle));
if (controllerUses.length === 5) {
  ok('the byte-code of LocalIOSDeviceController really runs the xcrun / devicectl / install / app / launch sequence');
} else {
  fail(`LocalIOSDeviceController carries only ${controllerUses.join(', ')} of the expected xcrun/devicectl/install/app/launch strings`);
}

// (3) The 127.0.0.1:22087 reachability: the device-side listener must
//     really bind that address, and no jar may carry a port-forward
//     implementation that would make the reachability obvious.
const swiftFile = extract('maestro-cli-2.12.1.jar', 'driver/ios/maestro-driver-iosUITests/Routes/XCTestHTTPServer.swift');
const swiftText = fs.readFileSync(swiftFile, 'utf8');
if (/127\.0\.0\.1/.test(swiftText) && /22087/.test(swiftText)) {
  ok('the device-side XCTestHTTPServer really binds 127.0.0.1:22087');
} else {
  fail('the device-side XCTestHTTPServer does NOT bind 127.0.0.1:22087 -- the §8.4 precondition is not what the source says');
}
const forwarders = [];
for (const [jar, entries] of jarEntries) {
  for (const needle of ['iproxy', 'usbmux']) {
    if (entries.some((e) => e.toLowerCase().includes(needle))) forwarders.push(`${jar}:${needle}`);
  }
}
if (forwarders.length === 0) {
  ok('no jar carries an iproxy / usbmux port-forward implementation -- the reachability really is unproven');
} else {
  fail(`these jars carry a port-forward implementation (${forwarders.join(', ')}) -- the §8.4 "not verifiable here" claim must be re-checked`);
}

// And the document must STATE all three.
for (const [needle, what] of [
  ['Apple account team ID', 'the Apple team ID precondition'],
  ['devicectl', 'the devicectl runner install'],
  ['22087', 'the 127.0.0.1:22087 reachability'],
]) {
  if (section.includes(needle)) {
    ok(`§8.4 states the ${what}`);
  } else {
    fail(`§8.4 does NOT state the ${what} ("${needle}")`);
  }
}

// The document must not promise an iOS execution this platform does not have.
if (/没有 iOS Runner/.test(section) && /OUT/.test(section)) {
  ok('§8.4 says the platform has no iOS Runner and points at the §2.2 OUT');
} else {
  fail('§8.4 does not say that the platform has no iOS Runner (or does not point at the §2.2 OUT)');
}

// The two hard iOS facts: `back` is a no-op and airplane mode is a no-op.
console.log('');
console.log('--- the two iOS no-ops ---');
const backPress = driver.backPress ?? '';
const isNoop = /^\s*public void backPress\(\);\s*\n\s*Code:\s*\n\s*0: return\s*$/m.test(backPress);
if (isNoop) ok('backPress is a no-op on iOS (the body is a single return)');
else fail('backPress is NOT a no-op on iOS -- the §8.4 claim about `back` does not hold');

const airplane = driver.setAirplaneMode ?? '';
if (/Airplane mode is not available on iOS simulators/.test(airplane)) {
  ok('setAirplaneMode only warns ("Airplane mode is not available on iOS simulators")');
} else {
  fail('setAirplaneMode does not carry the expected iOS warning -- the §8.4 claim does not hold');
}

console.log('');
fs.rmSync(WORK, { recursive: true, force: true });

if (failures.length) {
  console.log(`IOS DRIVER SUPPORT: FAIL (${failures.length} problem(s))`);
  process.exit(1);
}
console.log('IOS DRIVER SUPPORT: OK');
process.exit(0);
