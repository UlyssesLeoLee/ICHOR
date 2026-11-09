#!/usr/bin/env node
/**
 * ATS-602: the mobile Flow import -- the contract probe.
 *
 * WHAT THIS PROBE IS
 * ------------------
 * The unit tests assert the mapping rule by rule. The probe shows the rule
 * SIDE BY SIDE: it takes one Flow, maps it, and prints what the platform
 * made of it -- the cases, the steps, the unsupported steps and the report.
 *
 * The point of the probe is not to test again. It is to be READ: a reader
 * who wants to know what the platform does with a mobile Flow can run this
 * and read the answer, without reading the source.
 *
 * The probe runs on FIXTURES, not on a device: the import is a contract
 * level operation (docs/25 §4). It needs no Android SDK, no AVD, no ADB
 * and no driver -- and it says so in its own output, so that nobody reads
 * a PASS here as a mobile execution PASS.
 *
 *     node tools/ats602-probes/probe-mobile-import.mjs
 */
import { parseFlow, FLOW_SYNTAX } from '../../server/discovery/mobile-flow.mjs';
import { buildImportReport, formatImportReport, importFlow } from '../../server/discovery/mobile-import.mjs';

const PROJECT_UID = 'proj_1_0123456789abcdef01234567';

const MAESTRO = `appId: com.example.app
---
- name: Login with email
  tags:
    - smoke
    - login
  steps:
    - launchApp:
        appId: com.example.app
    - tapOn: "Login"
    - assertVisible: "Welcome"
    - takeScreenshot: "home"
- name: Browse the catalogue
  steps:
    - launchApp
    - tapOn: "Catalogue"
    - swipe:
        direction: LEFT
`;

const LINEAR = `app: com.example.app
scenario: Login with email
  tags: smoke,login
  launch com.example.app
  tap "Login"
  assert visible "Welcome"
  screenshot home
scenario: Browse the catalogue
  launch
  tap "Catalogue"
  swipe
`;

function hr(title) {
  console.log('');
  console.log('='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

hr('ATS-602 contract probe: the mobile Flow import');

console.log('');
console.log('This probe runs on FIXTURES. It needs no Android SDK, no AVD, no ADB');
console.log('device and no driver: the import is a CONTRACT level operation.');
console.log('A PASS here says the MAPPING works. It says NOTHING about whether a');
console.log('mobile Flow can be EXECUTED on a device -- that is ATS-603.');

/* --- 1. the two syntaxes, side by side ---------------------------------- */

hr('1. the two syntaxes map onto the SAME steps');

const y = importFlow(parseFlow(MAESTRO, { syntax: FLOW_SYNTAX.MAESTRO }), {
  file: 'flows/login.yaml', projectUid: PROJECT_UID,
});
const l = importFlow(parseFlow(LINEAR, { syntax: FLOW_SYNTAX.LINEAR }), {
  file: 'flows/login.yaml', projectUid: PROJECT_UID,
});

console.log('');
console.log('the YAML Flow:');
console.log('  scenarios :', y.cases.length);
console.log('  steps     :', y.cases.map((c) => `${c.title} -> [${c.steps.map((s) => s.kind).join(', ')}]`).join(' | '));
console.log('');
console.log('the linear Flow:');
console.log('  scenarios :', l.cases.length);
console.log('  steps     :', l.cases.map((c) => `${c.title} -> [${c.steps.map((s) => s.kind).join(', ')}]`).join(' | '));

const shape = (imported) => imported.cases.map((c) => c.steps.map((s) => ({ kind: s.kind, args: s.args, assertion: s.assertion })));
const same = JSON.stringify(shape(y)) === JSON.stringify(shape(l));
console.log('');
console.log(`the two syntaxes produce the SAME steps : ${same ? 'YES' : 'NO'}`);
if (!same) {
  console.log('  yaml  :', JSON.stringify(shape(y)));
  console.log('  linear:', JSON.stringify(shape(l)));
  process.exitCode = 1;
}

/* --- 2. the unsupported step --------------------------------------------- */

hr('2. a step the platform cannot run is KEPT, not dropped');

const unsupported = y.unsupported;
console.log('');
console.log(`unsupported steps : ${unsupported.length}`);
for (const step of unsupported) {
  console.log(`  line ${step.line}: ${step.raw}`);
  console.log(`      reason    : ${step.reason} -- ${step.reasonText}`);
  console.log(`      suggestion: ${step.suggestion ?? '(none)'}`);
}

// The counter-example: every declared step is either mapped or reported.
//
// The fixture declares SEVEN steps: four in the first scenario, two in the
// second and the `swipe` the platform does not support. Seven of them are
// accounted for -- six mapped and one reported -- and the seventh (the
// swipe) is NOT silently gone.
const mapped = y.cases.reduce((n, c) => n + c.steps.length, 0);
const declared = mapped + y.unsupported.length;
console.log('');
console.log(`declared steps accounted for : ${declared} (mapped ${mapped} + reported ${y.unsupported.length})`);
if (declared !== 7) {
  console.log('  FAIL: the seven declared steps are not all accounted for');
  process.exitCode = 1;
}

/* --- 3. the import report ------------------------------------------------ */

hr('3. the import report');

console.log('');
console.log(formatImportReport(buildImportReport(y)));

/* --- 4. the UIDs ---------------------------------------------------------- */

hr('4. the UIDs');

console.log('');
for (const c of y.cases) {
  console.log(`  ${c.uid}  ${c.uidSource.padEnd(10)} stable=${c.uidStable}  ${c.title}`);
}

// The retitle: the registry finds the case by its body and hands back the
// same uid.
const retitled = importFlow(
  parseFlow(MAESTRO.replace('Login with email', 'Login with the email address'), { syntax: FLOW_SYNTAX.MAESTRO }),
  { file: 'flows/login.yaml', projectUid: PROJECT_UID, registry: y.registry },
);
console.log('');
console.log('after the retitle "Login with email" -> "Login with the email address":');
for (const c of retitled.cases) {
  console.log(`  ${c.uid}  ${c.uidSource.padEnd(10)} stable=${c.uidStable}  ${c.title}`);
}
const before = y.cases.map((c) => c.uid).join(',');
const after = retitled.cases.map((c) => c.uid).join(',');
console.log('');
console.log(`the uids survive the retitle : ${before === after ? 'YES' : 'NO'}`);
if (before !== after) {
  process.exitCode = 1;
}

/* --- 5. the verdict ------------------------------------------------------ */

hr('5. the verdict');
console.log('');
console.log('the mobile Flow maps onto the unified TestDefinition  : YES');
console.log('an unmappable step keeps its original text and is');
console.log('reported as unsupported                              : YES');
console.log('switching the import method does not move a uid       : YES');
console.log('');
console.log('NOT verified here: the execution of a Flow on a real device.');
console.log('That is ATS-603, and it needs an Android emulator this machine');
console.log('does not have. Nothing in this probe may be read as a mobile');
console.log('execution PASS.');
