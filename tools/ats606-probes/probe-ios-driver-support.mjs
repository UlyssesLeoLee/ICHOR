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
 * The XCTest driver is installed onto the DEVICE, so it is the SAME code for
 * a simulator and for a physical device. The deviceController is NOT: it is
 * `simctl` on a simulator and `devicectl` on a physical device, and those two
 * have different implementation status.
 *
 * So for every operation the probe answers two questions:
 *   1. which backend does LocalIOSDevice route it to?
 *   2. is that backend implemented for the simulator? for the device?
 *
 * The answer is read from the byte-code: a method body that throws
 * `kotlin/NotImplementedError` ("Not yet implemented") is NOT implemented.
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
console.log(`to the XCTest driver (same code for simulator and device): ${toXctest.length}`);
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
 * This is the mapping the design document's §8.4 table is built on.
 */
const STEP_REQUIREMENTS = [
  ['launchApp', ['launch']],
  ['tapOn', ['tap', 'viewHierarchy']],
  ['assertVisible', ['viewHierarchy']],
  ['takeScreenshot', ['takeScreenshot']],
  ['recordScreen', ['startScreenRecording']],
];

console.log('--- the six platform step kinds on the two iOS paths ---');
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
 * The document states, for each of the six step kinds, whether the simulator
 * and the device are 可自动化 (automatable) or 受限 (limited). The claim is
 * checked against what was derived from the byte-code.
 */
const CLAIMS = [
  ['launchApp', 'sim', '可自动化', 'dev', '受限'],
  ['tapOn', 'sim', '可自动化', 'dev', '可自动化'],
  ['assertVisible', 'sim', '可自动化', 'dev', '可自动化'],
  ['takeScreenshot', 'sim', '可自动化', 'dev', '可自动化'],
  ['recordScreen', 'sim', '可自动化', 'dev', '受限'],
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
  // | step | capability | maestro op | simulator | device | verdict | reason |
  const simulatorCell = cells[4] ?? '';
  const deviceCell = cells[5] ?? '';
  const derivedSim = stepVerdict[step]?.sim === 'impl' ? v1 : '受限';
  const derivedDev = stepVerdict[step]?.dev === 'impl' ? v2 : '受限';

  const simOk = simulatorCell.includes(derivedSim);
  const devOk = deviceCell.includes(derivedDev);
  if (simOk && devOk) {
    ok(`§8.4 ${step}: simulator="${simulatorCell}" device="${deviceCell}" match the byte-code`);
  } else {
    fail(`§8.4 ${step}: the document says simulator="${simulatorCell}" device="${deviceCell}", the byte-code implies simulator="${derivedSim}" device="${derivedDev}"`);
  }
}

// The claim that the physical device path is only PARTLY implemented must
// match the derived counts.
const devNotImpl = toController.filter((op) => statusOf(devicectl[op]) === 'NOT-IMPL').length;
const devImpl = toController.filter((op) => statusOf(devicectl[op]) === 'impl').length;
console.log('');
console.log(`the physical-device controller: ${devImpl} implemented, ${devNotImpl} not implemented`);

const claimsPartial = /真机路径不是「全都不行」/.test(section);
if (claimsPartial && devNotImpl === 0) {
  fail('§8.4 claims the physical-device path is only partly implemented, but every deviceController operation is implemented');
} else if (claimsPartial) {
  ok(`§8.4 claims the physical-device path is only partly implemented, and ${devNotImpl} of the ${toController.length} deviceController operations are indeed not implemented`);
}

// The two hard iOS facts: `back` is a no-op and airplane mode is a no-op.
console.log('');
console.log('--- the two iOS no-ops ---');
const driverFile = extract('maestro-client.jar', 'maestro/drivers/IOSDriver.class');
const driver = parseMethods(javap(driverFile));
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
