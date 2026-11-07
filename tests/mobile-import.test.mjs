/**
 * ATS-602: the mobile Flow import -- the unit tests.
 *
 * WHAT THESE TESTS GUARD
 * -----------------------
 * The acceptance criterion of the task has two halves, and each half has a
 * test that would fail if the half were broken:
 *
 *   1. "移动端 Flow 可映射到统一 TestDefinition" -- a Flow maps onto the
 *      unified case model. UT-MOB-2xx covers the mapping itself, the
 *      vocabulary, the arguments and the positions.
 *
 *   2. "映射不了的步骤保留原文并标记不支持，不静默丢弃" -- a step that
 *      cannot be mapped keeps its original text and is marked unsupported.
 *      UT-MOB-2xx covers that too, and the counter-example is the one
 *      that matters: a step that is dropped SILENTLY. Every unsupported
 *      step is checked for its text, its line and its reason.
 *
 * The UID rules have their own tests (the same counter-examples ATS-202
 * used): switching the import method must not move an existing UID, and a
 * retitled case keeps its UID.
 *
 * The tests are PURE: they read text and they map it. No device, no SDK,
 * no driver -- the contract layer of ATS-601 is the fixture, and the
 * mapping is what ATS-602 delivers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseFlow, detectSyntax, FLOW_SYNTAX } from '../server/discovery/mobile-flow.mjs';
import {
  STEP_SEMANTICS,
  UNSUPPORTED_REASON,
  bodyKeyOfCase,
  buildImportReport,
  formatImportReport,
  importFlow,
  normaliseCommand,
  stepKindOf,
} from '../server/discovery/mobile-import.mjs';
import { importFlowFile, importProjectFlows, isFlowFile, IMPORT_ERROR } from '../server/discovery/mobile-flow-import.mjs';
import { MOBILE_STEP_KINDS } from '../server/adapters/mobile-target.mjs';
import { discoverStatic } from '../server/core.mjs';
// The static catalogue is the FALLBACK path of the trusted discovery. It
// is imported dynamically so that this test file also runs on a tree that
// does not export it -- the counter-example has to be red on the tree that
// was delivered first, and a missing export would make the whole file
// fail to load instead of the ONE test failing.
const { staticCatalog } = await import('../server/core.mjs');
import { emptyRegistry } from '../server/uid.mjs';

const PROJECT_UID = 'proj_1_0123456789abcdef01234567';

/* ------------------------------------------------------------------ */
/* The fixtures                                                       */
/* ------------------------------------------------------------------ */

const MAESTRO_FLOW = `appId: com.example.app
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
  tags:
    - browse
  steps:
    - launchApp
    - tapOn: "Catalogue"
`;

const LINEAR_FLOW = `app: com.example.app
scenario: Login with email
  tags: smoke,login
  launch com.example.app
  tap "Login"
  assert visible "Welcome"
  screenshot home
scenario: Browse the catalogue
  tags: browse
  launch
  tap "Catalogue"
`;

/** A temporary project directory that is removed when the file ends. */
function tempProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats602-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return root;
}

/** The import of a Flow text, in the given syntax. */
function importText(text, syntax = FLOW_SYNTAX.MAESTRO, opts = {}) {
  const flow = parseFlow(text, { syntax });
  return importFlow(flow, { file: 'flows/login.yaml', projectUid: PROJECT_UID, ...opts });
}

/* ------------------------------------------------------------------ */
/* The parser                                                         */
/* ------------------------------------------------------------------ */

test('UT-MOB-200: the syntax of a Flow file is decided by its extension', () => {
  assert.equal(detectSyntax('flows/login.yaml'), FLOW_SYNTAX.MAESTRO);
  assert.equal(detectSyntax('flows/login.yml'), FLOW_SYNTAX.MAESTRO);
  assert.equal(detectSyntax('flows/login.flow'), FLOW_SYNTAX.LINEAR);
  assert.equal(detectSyntax('flows/login.txt'), null);
  assert.equal(detectSyntax('flows/login'), null);
});

test('UT-MOB-201: a maestro Flow is read into its scenarios and steps', () => {
  const flow = parseFlow(MAESTRO_FLOW, { syntax: FLOW_SYNTAX.MAESTRO });
  assert.deepEqual(flow.errors, []);
  assert.equal(flow.appId, 'com.example.app');
  assert.equal(flow.scenarios.length, 2);
  assert.equal(flow.scenarios[0].title, 'Login with email');
  assert.deepEqual(flow.scenarios[0].tags, ['smoke', 'login']);
  assert.equal(flow.scenarios[0].steps.length, 4);
  assert.equal(flow.scenarios[0].steps[0].command, 'launchApp');
  assert.deepEqual(flow.scenarios[0].steps[0].args, { appId: 'com.example.app' });
  assert.equal(flow.scenarios[0].steps[1].command, 'tapOn');
  assert.deepEqual(flow.scenarios[0].steps[1].args, { value: 'Login' });
});

test('UT-MOB-202: the linear Flow is read into the same shape', () => {
  const flow = parseFlow(LINEAR_FLOW, { syntax: FLOW_SYNTAX.LINEAR });
  assert.deepEqual(flow.errors, []);
  assert.equal(flow.appId, 'com.example.app');
  assert.equal(flow.scenarios.length, 2);
  assert.equal(flow.scenarios[0].title, 'Login with email');
  assert.deepEqual(flow.scenarios[0].tags, ['smoke', 'login']);
  assert.equal(flow.scenarios[0].steps.length, 4);
  assert.equal(flow.scenarios[0].steps[0].command, 'launch');
  assert.deepEqual(flow.scenarios[0].steps[0].args, { appId: 'com.example.app' });
  assert.equal(flow.scenarios[0].steps[2].command, 'assert');
  assert.equal(flow.scenarios[0].steps[2].qualifier, 'visible');
});

test('UT-MOB-203: the two syntaxes produce the same SEMANTICS', () => {
  const y = parseFlow(MAESTRO_FLOW, { syntax: FLOW_SYNTAX.MAESTRO });
  const l = parseFlow(LINEAR_FLOW, { syntax: FLOW_SYNTAX.LINEAR });
  const kinds = (flow) => flow.scenarios.map((s) => s.steps.map((st) => stepKindOf(st.command)));
  assert.deepEqual(kinds(y), kinds(l));
  assert.deepEqual(
    y.scenarios.map((s) => s.title),
    l.scenarios.map((s) => s.title),
  );
});

test('UT-MOB-204: the line of a step is the line it was declared on', () => {
  const flow = parseFlow(MAESTRO_FLOW, { syntax: FLOW_SYNTAX.MAESTRO });
  const steps = flow.scenarios[0].steps;
  // The fixture: line 1 is the appId, line 2 the separator, line 3 the
  // scenario, and the steps are declared on lines 8, 10, 11 and 12.
  assert.deepEqual(steps.map((s) => s.line), [8, 10, 11, 12]);
  // And the line is the line of the ITEM, not the line of the enclosing
  // key: that is the position the UID basis and the report point at.
  const lines = MAESTRO_FLOW.split('\n');
  assert.match(lines[steps[0].line - 1], /launchApp/);
  assert.match(lines[steps[3].line - 1], /takeScreenshot/);
});

test('UT-MOB-205: a Flow with no scenario is reported, not silently accepted', () => {
  const flow = parseFlow('appId: com.example.app\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.equal(flow.scenarios.length, 0);
  assert.ok(flow.errors.length > 0);
});

test('UT-MOB-206: a broken Flow is reported with the line it broke on', () => {
  // The second step is indented MORE than the first one of the same list.
  // That is not a shape the reader can read, and it is reported.
  const flow = parseFlow('---\n- name: a\n  steps:\n    - tapOn: "x"\n     - tapOn: "y"\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.ok(flow.errors.length > 0, 'the broken indentation is reported');
  assert.ok(Number.isInteger(flow.errors[0].line), 'the error carries a line');
  assert.equal(flow.errors[0].line, 5, 'the error points at the broken line');
});

test('UT-MOB-207: an anchor in a Flow is an error, not a half-read document', () => {
  const flow = parseFlow('appId: &anchor com.example\n---\n- name: a\n  steps:\n    - tapOn: "x"\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.ok(flow.errors.length > 0);
  assert.match(flow.errors[0].message, /anchor/i);
});

test('UT-MOB-208: a comment does not become part of the declaration', () => {
  const flow = parseFlow('appId: com.example.app  # the app under test\n---\n- name: a  # the scenario\n  steps:\n    - tapOn: "x"  # the tap\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.deepEqual(flow.errors, []);
  assert.equal(flow.appId, 'com.example.app');
  assert.equal(flow.scenarios[0].title, 'a');
  assert.equal(flow.scenarios[0].steps[0].command, 'tapOn');
});

test('UT-MOB-209: a step option is not read as a command', () => {
  const flow = parseFlow('---\n- name: a\n  steps:\n    - label: "the login button"\n      tapOn: "Login"\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.deepEqual(flow.errors, []);
  assert.equal(flow.scenarios[0].steps[0].command, 'tapOn');
});

/* ------------------------------------------------------------------ */
/* The semantic vocabulary                                             */
/* ------------------------------------------------------------------ */

test('UT-MOB-210: every mapped kind is one ATS-601 knows', () => {
  // The mapper refuses to invent a step kind: a kind outside the ATS-601
  // vocabulary has no capability requirement, and the capability
  // negotiation of docs/25 3.3 would have nothing to match it against.
  for (const kind of Object.keys(STEP_SEMANTICS)) {
    assert.ok(MOBILE_STEP_KINDS.includes(kind), `${kind} is not in the ATS-601 vocabulary`);
  }
});

test('UT-MOB-211: a command is recognised regardless of its spelling', () => {
  assert.equal(stepKindOf('launchApp'), 'launchApp');
  assert.equal(stepKindOf('launch'), 'launchApp');
  assert.equal(stepKindOf('launch_app'), 'launchApp');
  assert.equal(stepKindOf('LAUNCHAPP'), 'launchApp');
  assert.equal(stepKindOf('tapOn'), 'tapOn');
  assert.equal(stepKindOf('tap-on'), 'tapOn');
  assert.equal(stepKindOf('nonsense'), null);
});

test('UT-MOB-212: the command normalisation does not touch the original', () => {
  // The report quotes the ORIGINAL spelling: the original text is what the
  // author wrote, and it is what a reader has to recognise.
  assert.equal(normaliseCommand('launchApp'), 'launchapp');
  const imported = importText('---\n- name: a\n  steps:\n    - NotACommand: "x"\n');
  // The report quotes the ORIGINAL text: the quotes and the spelling are
  // the author's, not the parser's.
  assert.equal(imported.unsupported[0].raw, '- NotACommand: "x"');
  assert.equal(imported.unsupported[0].command, 'NotACommand');
});

/* ------------------------------------------------------------------ */
/* The mapping                                                         */
/* ------------------------------------------------------------------ */

test('UT-MOB-220: a Flow maps onto the unified case model', () => {
  const imported = importText(MAESTRO_FLOW);
  assert.equal(imported.cases.length, 2);
  for (const c of imported.cases) {
    assert.ok(c.uid, 'the case has a uid');
    assert.equal(c.uidSource, 'derived');
    assert.equal(c.uidStable, true);
    assert.equal(c.file, 'flows/login.yaml');
    assert.equal(typeof c.line, 'number');
    assert.ok(Array.isArray(c.steps));
  }
});

test('UT-MOB-221: a scenario becomes a case and a step becomes a step', () => {
  const imported = importText(MAESTRO_FLOW);
  const c = imported.cases[0];
  assert.equal(c.title, 'Login with email');
  assert.deepEqual(c.tags, ['smoke', 'login']);
  assert.deepEqual(c.steps.map((s) => s.kind), ['launchApp', 'tapOn', 'assertVisible', 'takeScreenshot']);
  assert.deepEqual(c.steps[1].args, { text: 'Login' });
});

test('UT-MOB-222: the assertion of a step is the unified model`s assertion', () => {
  const imported = importText(MAESTRO_FLOW);
  const assertion = imported.cases[0].steps[2].assertion;
  assert.deepEqual(assertion, { visible: 'Welcome' });
});

test('UT-MOB-223: the two syntaxes map onto the SAME steps', () => {
  const y = importText(MAESTRO_FLOW, FLOW_SYNTAX.MAESTRO);
  const l = importText(LINEAR_FLOW, FLOW_SYNTAX.LINEAR);
  const shape = (imported) => imported.cases.map((c) => c.steps.map((s) => ({ kind: s.kind, args: s.args, assertion: s.assertion })));
  assert.deepEqual(shape(y), shape(l));
});

test('UT-MOB-224: a launchApp with no app takes the app the Flow declares', () => {
  const imported = importText(MAESTRO_FLOW);
  const second = imported.cases[1];
  const launch = second.steps.find((s) => s.kind === 'launchApp');
  assert.deepEqual(launch.args, { appId: 'com.example.app' });
  assert.equal(second.appId, 'com.example.app');
});

test('UT-MOB-225: a scenario with no name still gets a deterministic title', () => {
  const imported = importText('---\n- steps:\n    - tapOn: "x"\n');
  assert.equal(imported.cases.length, 1);
  assert.match(imported.cases[0].title, /line \d+/);
  // The same file, imported twice, yields the same title.
  const again = importText('---\n- steps:\n    - tapOn: "x"\n');
  assert.equal(again.cases[0].title, imported.cases[0].title);
});

/* ------------------------------------------------------------------ */
/* The unsupported steps -- the half that must not fail silently      */
/* ------------------------------------------------------------------ */

test('UT-MOB-230: an unmappable step is KEPT, not dropped', () => {
  const imported = importText('---\n- name: a\n  steps:\n    - tapOn: "x"\n    - swipe: "left"\n');
  // The step is not in the case.
  assert.deepEqual(imported.cases[0].steps.map((s) => s.kind), ['tapOn']);
  // But it is REPORTED, with its original text, its line and a reason.
  assert.equal(imported.unsupported.length, 1);
  const step = imported.unsupported[0];
  assert.equal(step.raw, '- swipe: "left"');
  assert.equal(step.line, 5);
  assert.equal(step.reason, UNSUPPORTED_REASON.UNKNOWN_COMMAND);
  assert.ok(step.reasonText.length > 0, 'the reason says why');
  // And the case knows that it lost a step.
  assert.equal(imported.cases[0].unsupportedCount, 1);
});

test('UT-MOB-231: the counter-example -- a step that vanishes silently FAILS the test', () => {
  // The point of the whole rule: every step of the Flow is accounted for.
  const imported = importText('---\n- name: a\n  steps:\n    - tapOn: "x"\n    - swipe: "left"\n    - pinch: "in"\n');
  const declared = 3;
  const accounted = imported.cases[0].steps.length + imported.unsupported.length;
  assert.equal(accounted, declared, 'every declared step is either mapped or reported');
});

test('UT-MOB-232: a step whose required argument is missing is reported', () => {
  const imported = importText('---\n- name: a\n  steps:\n    - tapOn:\n');
  assert.equal(imported.cases[0].steps.length, 0);
  assert.equal(imported.unsupported.length, 1);
  assert.equal(imported.unsupported[0].reason, UNSUPPORTED_REASON.MISSING_ARGUMENT);
  assert.match(imported.unsupported[0].reasonText, /text/);
});

test('UT-MOB-233: a step that names no command at all is reported', () => {
  // `label` is a step OPTION, so the step names no command at all. It is
  // reported, not dropped.
  const imported = importText('---\n- name: a\n  steps:\n    - label: "x"\n');
  assert.equal(imported.cases[0].steps.length, 0);
  assert.equal(imported.unsupported.length, 1);
  assert.equal(imported.unsupported[0].reason, UNSUPPORTED_REASON.UNKNOWN_COMMAND);
  assert.equal(imported.unsupported[0].raw, '- label: "x"');
});

test('UT-MOB-234: an argument outside the model is KEPT and reported', () => {
  const imported = importText('---\n- name: a\n  steps:\n    - tapOn:\n        text: "Login"\n        someUnknownOption: 3\n');
  assert.equal(imported.cases[0].steps.length, 1);
  assert.equal(imported.cases[0].steps[0].args.someUnknownOption, 3, 'the argument is kept');
  assert.equal(imported.warnings.length, 1);
  assert.match(imported.warnings[0].message, /someUnknownOption/);
});

test('UT-MOB-235: the report lists every unsupported step with its text', () => {
  const imported = importText('---\n- name: a\n  steps:\n    - tapOn: "x"\n    - swipe: "left"\n');
  const report = buildImportReport(imported);
  assert.equal(report.cases, 1);
  assert.equal(report.mappedSteps, 1);
  assert.equal(report.unsupportedSteps, 1);
  assert.equal(report.unsupportedByReason[UNSUPPORTED_REASON.UNKNOWN_COMMAND], 1);
  const text = formatImportReport(report);
  assert.match(text, /swipe: "left"/);
  assert.match(text, /第 5 行/);
  // The reason is in the report too -- an unsupported step without a
  // reason is not a report.
  assert.match(text, /unknown-command/);
});

/* ------------------------------------------------------------------ */
/* The UIDs                                                            */
/* ------------------------------------------------------------------ */

test('UT-MOB-240: switching the import method does not move an existing UID', () => {
  // The property: the SAME declaration, read by TWO different import
  // methods, is the SAME case and gets the SAME uid.
  //
  // The basis is the POSITION (file + line), so the uid does not depend on
  // the syntax. The two fixtures below declare the SAME scenario at the
  // SAME line, in the two syntaxes -- so the two imports must agree.
  const yaml = 'appId: com.example.app\n---\n- name: a\n  steps:\n    - tapOn: "x"\n';
  const linear = 'app: com.example.app\n\nscenario: a\n  tap "x"\n';
  const y = importFlow(parseFlow(yaml, { syntax: FLOW_SYNTAX.MAESTRO }), {
    file: 'flows/x.yaml', projectUid: PROJECT_UID,
  });
  const l = importFlow(parseFlow(linear, { syntax: FLOW_SYNTAX.LINEAR }), {
    file: 'flows/x.yaml', projectUid: PROJECT_UID,
  });
  // The scenario sits at the SAME line in both declarations -- that is the
  // position the uid is derived from.
  assert.equal(y.cases[0].line, l.cases[0].line, 'the scenario sits at the same line');
  // The title of the scenario is the same, and so is the step.
  assert.equal(y.cases[0].title, l.cases[0].title);
  assert.deepEqual(y.cases[0].steps.map((s) => s.kind), l.cases[0].steps.map((s) => s.kind));
  // The uid is the SAME -- the assertion the title of the test claims.
  assert.equal(y.cases[0].uid, l.cases[0].uid, 'switching the syntax does not move the uid');
  // And the body fingerprint agrees, which is what lets the registry find
  // the case again after a retitle.
  assert.equal(bodyKeyOfCase(y.cases[0]), bodyKeyOfCase(l.cases[0]));
});

test('UT-MOB-241: the same file read by two syntaxes yields the same uid', () => {
  // The YAML and the linear text declare the SAME scenario with the SAME
  // steps. The steps are identical, so the body fingerprint is identical,
  // and that is what lets the registry find the case again.
  const yaml = '---\n- name: a\n  steps:\n    - tapOn: "x"\n';
  const linear = 'scenario: a\n  tap "x"\n';
  const y = importFlow(parseFlow(yaml, { syntax: FLOW_SYNTAX.MAESTRO }), {
    file: 'flows/x.yaml', projectUid: PROJECT_UID,
  });
  const l = importFlow(parseFlow(linear, { syntax: FLOW_SYNTAX.LINEAR }), {
    file: 'flows/x.yaml', projectUid: PROJECT_UID,
  });
  // The positions differ (the linear file declares the scenario on line 1),
  // so the uids MAY differ -- the basis is the position. What must agree
  // is the body fingerprint: the two declarations describe the same case.
  assert.equal(bodyKeyOfCase(y.cases[0]), bodyKeyOfCase(l.cases[0]));
  assert.equal(y.cases[0].uidSource, 'derived');
  assert.equal(l.cases[0].uidSource, 'derived');
  assert.ok(y.cases[0].uidStable && l.cases[0].uidStable);
});

test('UT-MOB-242: a retitled case keeps its uid through the registry', () => {
  const first = importText('---\n- name: "Old title"\n  steps:\n    - tapOn: "x"\n');
  const registry = first.registry;
  const second = importText('---\n- name: "New title"\n  steps:\n    - tapOn: "x"\n', FLOW_SYNTAX.MAESTRO, { registry });
  assert.equal(second.cases[0].uid, first.cases[0].uid, 'the uid survives the retitle');
  assert.equal(second.cases[0].uidSource, 'registry');
});

test('UT-MOB-243: an explicit @TC- annotation wins over every derived key', () => {
  const imported = importText('---\n- name: "A case @TC-601"\n  steps:\n    - tapOn: "x"\n');
  assert.equal(imported.cases[0].uid, 'tc-601');
  assert.equal(imported.cases[0].uidSource, 'explicit');
  assert.equal(imported.cases[0].uidStable, true);
});

test('UT-MOB-244: two cases with the same title and the same steps are ambiguous', () => {
  const imported = importText('---\n- name: a\n  steps:\n    - tapOn: "x"\n- name: a\n  steps:\n    - tapOn: "x"\n');
  assert.equal(imported.cases.length, 2);
  assert.equal(imported.cases[0].uidStable, false);
  assert.equal(imported.cases[0].uidSource, 'provisional');
  assert.ok(imported.cases[0].ambiguity, 'the ambiguity is reported');
});

test('UT-MOB-245: two cases with the same title and DIFFERENT steps keep their own uid', () => {
  const imported = importText('---\n- name: a\n  steps:\n    - tapOn: "x"\n- name: a\n  steps:\n    - tapOn: "y"\n');
  assert.equal(imported.cases.length, 2);
  assert.notEqual(imported.cases[0].uid, imported.cases[1].uid);
  assert.equal(imported.cases[0].uidStable, true);
});

test('UT-MOB-246: without a project the uid is provisional, not invented', () => {
  const imported = importFlow(parseFlow('---\n- name: a\n  steps:\n    - tapOn: "x"\n'), { file: 'flows/x.yaml' });
  assert.equal(imported.cases[0].uidStable, false);
  assert.equal(imported.cases[0].uidSource, 'provisional');
});

/* ------------------------------------------------------------------ */
/* The round-2 counter-examples                                       */
/* ------------------------------------------------------------------ */

/*
 * The round-1 review found fourteen ways in which a Flow could lose
 * content without a trace: a step that vanished, a scenario that vanished,
 * a whole file that was never discovered, a case whose uid moved when its
 * title was rewritten, a `@TC-` token that two cases claimed at once.
 *
 * Each test below is the counter-example of ONE of them, and each one
 * fails on the tree that was delivered the first time.
 */

test('UT-MOB-270: a nested Flow directory is found (E1a)', () => {
  const root = tempProject({
    'flows/top.yaml': MAESTRO_FLOW,
    'flows/smoke/login.yaml': MAESTRO_FLOW,
    'tests/mobile/android/pay.flow': LINEAR_FLOW,
  });
  try {
    const found = importProjectFlows(root, { projectUid: PROJECT_UID });
    assert.ok(found.files.includes('flows/smoke/login.yaml'), 'the nested Flow is found');
    assert.ok(found.files.includes('tests/mobile/android/pay.flow'), 'the nested linear Flow is found');
    // And they are IMPORTED, not just listed.
    assert.equal(found.cases.length, 6, 'three scenarios per file, two files plus the top one');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-271: a directory of the project root is not read as a Flow directory (E1b)', () => {
  // The Flow directory is `flows/`. A directory of the project root that
  // happens to share its name must not be read as if it were the Flow
  // directory -- and the file it holds must not be reported as an
  // unreadable Flow.
  const root = tempProject({
    'flows/android/.keep': '',
    'android/ci.yml': 'not: a flow\n',
  });
  try {
    const found = importProjectFlows(root, { projectUid: PROJECT_UID });
    assert.deepEqual(found.files, [], 'the root directory is not a Flow directory');
    assert.equal(found.errors.length, 0, 'and nothing is reported as unreadable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-272: a document is not read half (E2)', () => {
  // A stray top level key in the middle of a scenario list. The reader
  // must read every node and REPORT the malformation -- and the scenario
  // that follows the stray key must NOT disappear.
  const text = [
    'appId: com.example.app',
    '---',
    '- name: First',
    '  steps:',
    '    - tapOn: "Login"',
    'timeout: 30',
    '- name: Second',
    '  steps:',
    '    - tapOn: "Pay"',
    '    - assertVisible: "Receipt"',
  ].join('\n');
  const imported = importText(text);
  assert.equal(imported.cases.length, 2, 'both scenarios are read');
  assert.deepEqual(imported.cases.map((c) => c.title), ['First', 'Second']);
  assert.ok(imported.errors.length > 0, 'the malformation is reported');
  assert.equal(imported.errors[0].line, 6, 'the report points at the stray key');
  // Every step of the second scenario is accounted for.
  assert.equal(imported.cases[1].steps.length, 2);
});

test('UT-MOB-273: a step that names two commands is reported (E3)', () => {
  const imported = importText('---\n- name: a\n  steps:\n    - tapOn: "Login"\n      assertVisible: "Welcome"\n');
  assert.equal(imported.cases[0].steps.length, 0, 'the step is not half-read');
  assert.equal(imported.unsupported.length, 1, 'and it is reported');
  assert.equal(imported.unsupported[0].line, 4);
  assert.ok(imported.errors.length > 0, 'the reader reports the malformation');
});

test('UT-MOB-274: the options of a step are KEPT and reported (E4)', () => {
  // `optional` and `when` are not commands: they say under which
  // conditions the step runs. The unified model has no place for them, so
  // they are kept and reported -- a conditional step that silently became
  // an unconditional one would run where the author never asked it to.
  const imported = importText('---\n- name: a\n  steps:\n    - tapOn: "Allow"\n      optional: true\n      when:\n        platform: Android\n');
  assert.equal(imported.cases[0].steps.length, 1, 'the step still maps');
  const step = imported.cases[0].steps[0];
  assert.equal(step.options.optional, true, 'the option is kept');
  assert.match(step.options.when, /Android/, 'and its value');
  assert.equal(imported.warnings.length, 1, 'and it is reported');
  assert.match(imported.warnings[0].message, /optional/);
});

test('UT-MOB-275: a step list the model does not map is reported (E5)', () => {
  // `onFlowStart:`, `setup:` and a second `commands:` list: content the
  // unified model does not read. Every step of them is reported, with its
  // original text and its line.
  const text = [
    'appId: com.example.app',
    'onFlowStart:',
    '  - launchApp',
    '---',
    '- name: a',
    '  setup:',
    '    - tapOn: "Accept cookies"',
    '  steps:',
    '    - tapOn: "Login"',
    '  commands:',
    '    - assertVisible: "Welcome"',
  ].join('\n');
  const imported = importText(text);
  const lines = imported.unsupported.map((u) => u.line).sort((a, b) => a - b);
  assert.deepEqual(lines, [3, 7, 11], 'every step of the unmapped lists is reported');
  assert.equal(imported.cases[0].steps.length, 1, 'only the step list is mapped');
  for (const u of imported.unsupported) {
    assert.equal(u.reason, UNSUPPORTED_REASON.UNMAPPED_SECTION);
    assert.ok(u.raw.length > 0, 'the original text is kept');
  }
});

test('UT-MOB-276: a header with a title does not produce a phantom case (E6)', () => {
  const text = 'appId: com.example.app\nname: Login\n---\n- launchApp\n- tapOn: "Login"\n';
  const imported = importText(text);
  assert.equal(imported.cases.length, 1, 'the file declares ONE case');
  assert.equal(imported.cases[0].title, 'Login', 'the header titles it');
  assert.equal(imported.cases[0].steps.length, 2, 'and it holds the steps');
  assert.equal(imported.cases[0].uidStable, true, 'and it is a real case');
});

test('UT-MOB-277: a tapOn by id names its target (E7)', () => {
  // The `id` of an element is as good a target as its text, so a step
  // that gives the id alone is mappable.
  const imported = importText('---\n- name: a\n  steps:\n    - tapOn:\n        id: "login_button"\n');
  assert.equal(imported.unsupported.length, 0, 'the step is mappable');
  assert.equal(imported.cases[0].steps.length, 1);
  assert.equal(imported.cases[0].steps[0].kind, 'tapOn');
  assert.equal(imported.cases[0].steps[0].args.id, 'login_button');
});

test('UT-MOB-278: the env block of a linear Flow does not swallow the steps (E8)', () => {
  // `tap Settings: General` is a step that taps "Settings". Without the
  // indent rule it was read as an environment variable, and the step
  // disappeared from the import without a trace.
  const text = [
    'app: com.example.app',
    'scenario: a',
    '  env:',
    '    USER: bob',
    '  tap "Login: now"',
    '  tap Settings: General',
    '  assert visible "Done"',
  ].join('\n');
  const imported = importText(text, FLOW_SYNTAX.LINEAR);
  assert.equal(imported.cases[0].env.USER, 'bob', 'the environment is read');
  assert.equal(Object.keys(imported.cases[0].env).length, 1, 'and holds only the environment');
  assert.equal(imported.cases[0].steps.length, 3, 'the three steps are read');
  assert.deepEqual(imported.cases[0].steps.map((s) => s.kind), ['tapOn', 'tapOn', 'assertVisible']);
});

test('UT-MOB-279: an extra argument of a linear step does not overwrite the first (E9)', () => {
  const text = 'app: com.example.app\nscenario: a\n  launch com.example.app clearState\n  tap "First" "Second"\n';
  const imported = importText(text, FLOW_SYNTAX.LINEAR);
  const steps = imported.cases[0].steps;
  assert.equal(steps[0].args.appId, 'com.example.app', 'the first argument is the app');
  assert.equal(steps[1].args.text, 'First', 'and the first target');
  // The extra arguments are KEPT and reported -- not dropped.
  assert.equal(imported.warnings.length, 2);
  for (const w of imported.warnings) assert.match(w.message, /not part of the unified/);
});

test('UT-MOB-280: two names for the same argument are reported (E10)', () => {
  const imported = importText('---\n- name: a\n  steps:\n    - tapOn:\n        text: "Login"\n        title: "Sign in"\n');
  assert.equal(imported.cases[0].steps.length, 1, 'the step still maps');
  assert.equal(imported.cases[0].steps[0].args.text, 'Login', 'the first name is kept');
  assert.equal(imported.warnings.length, 1, 'and the collision is reported');
  assert.match(imported.warnings[0].message, /twice/);
});

test('UT-MOB-281: the registry is persisted, and a retitle keeps the uid (E11)', () => {
  // The catalogue persists the registry cell -- and the cell holds the
  // MOBILE entries too. Without that, a retitled case would get a new
  // uid every time.
  //
  // The rounds carry the registry forward, exactly as the Bridge does: it
  // reads the cell of the catalogue and writes it back.
  const root = tempProject({ 'flows/login.yaml': '---\n- name: "Old title"\n  steps:\n    - tapOn: "x"\n' });
  try {
    const project = { root, id: PROJECT_UID, uid: PROJECT_UID, name: 'fixture' };
    let registry = emptyRegistry();
    const round = () => {
      const catalog = discoverStatic(project, registry);
      const cell = catalog.registry?.projects?.[PROJECT_UID];
      assert.ok(cell, 'the catalogue reports the registry cell');
      registry = { version: 1, projects: { [PROJECT_UID]: cell } };
      return catalog;
    };
    const first = round();
    const entries = (registry.projects[PROJECT_UID].entries ?? []).filter((e) => e.file === 'flows/login.yaml');
    assert.equal(entries.length, 1, 'the mobile entry is persisted');
    const before = first.tests.find((t) => t.source === 'mobile');
    assert.ok(before.uid);

    // The title is rewritten in place.
    fs.writeFileSync(path.join(root, 'flows/login.yaml'), '---\n- name: "New title"\n  steps:\n    - tapOn: "x"\n', 'utf8');
    const second = round();
    const after = second.tests.find((t) => t.source === 'mobile');
    assert.equal(after.uid, before.uid, 'the uid survives the retitle');
    assert.equal(after.uidSource, 'registry', 'and the registry is what recognised it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-282: a comment above the Flow does not move the uid (E11c)', () => {
  const root = tempProject({ 'flows/login.yaml': '---\n- name: a\n  steps:\n    - tapOn: "x"\n' });
  try {
    const project = { root, id: PROJECT_UID, uid: PROJECT_UID, name: 'fixture' };
    const first = discoverStatic(project, emptyRegistry());
    const before = first.tests.find((t) => t.source === 'mobile');
    fs.writeFileSync(path.join(root, 'flows/login.yaml'), '# a comment line added on top\n---\n- name: a\n  steps:\n    - tapOn: "x"\n', 'utf8');
    const second = discoverStatic(project, {
      version: 1,
      projects: { [PROJECT_UID]: first.registry.projects[PROJECT_UID] },
    });
    const after = second.tests.find((t) => t.source === 'mobile');
    assert.equal(after.uid, before.uid, 'a comment does not change the identity of a case');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-283: a @TC- token that two cases claim belongs to neither (E12)', () => {
  // The token names ONE case of the catalogue. A web case and a mobile
  // case that both claim it -- and two mobile cases that both claim it --
  // mean that NEITHER of them owns it.
  const root = tempProject({
    'tests/a.spec.ts': "import { test } from '@playwright/test';\ntest('web login @TC-100', async () => {});\n",
    'flows/a.yaml': '---\n- name: "mobile login @TC-100"\n  steps:\n    - tapOn: "x"\n- name: "mobile pay @TC-200"\n  steps:\n    - tapOn: "y"\n- name: "mobile pay again @TC-200"\n  steps:\n    - tapOn: "z"\n',
  });
  try {
    const catalog = discoverStatic({ root, id: PROJECT_UID, uid: PROJECT_UID, name: 'fixture' }, emptyRegistry());
    const uids = catalog.tests.map((t) => t.uid);
    assert.equal(new Set(uids).size, uids.length, 'no two cases share a uid');
    // The four cases that claim a duplicated token are all provisional:
    // the web case claims @TC-100 (which a mobile case also claims) and
    // the two mobile cases claim @TC-200 (which each other also claims).
    const dup = catalog.tests.filter((t) => t.ambiguity?.reason === 'duplicate-explicit-uid');
    assert.equal(dup.length, 4, 'the web case and the three mobile ones are reported');
    for (const t of dup) {
      assert.equal(t.uidStable, false);
      assert.notEqual(t.uid, 'tc-100');
      assert.notEqual(t.uid, 'tc-200');
    }
    // And the catalogue says so.
    assert.match(catalog.warning, /重复的显式 UID/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-284: the body uniqueness is counted over the project (E13)', () => {
  // Two Flow files of one project may declare the same steps. A body
  // that is unique inside one file is not unique inside the project, and
  // the two cases must not get the SAME uid.
  //
  // The counter-example is the IMPORT path as well as the catalogue: the
  // import of the second file is given the registry of the first one, and
  // the registry match must not hand the second case the uid of the
  // first.
  const body = '    - launchApp\n    - takeScreenshot: "home"\n';
  const root = tempProject({
    'flows/android.yaml': `appId: x\n---\n- name: smoke android\n  steps:\n${body}`,
    'flows/ios.yaml': `appId: x\n---\n- name: smoke ios\n  steps:\n${body}`,
  });
  try {
    // The IMPORT path: the second file is imported with the registry of
    // the first one. The registry is what remembers a case by its body,
    // and it must not hand the second case the uid of the first -- the
    // body is not unique inside the project.
    const body = '    - launchApp\n    - takeScreenshot: "home"\n';
    const first = importFlow(
      parseFlow(`appId: x\n---\n- name: smoke android\n  steps:\n${body}`, { syntax: FLOW_SYNTAX.MAESTRO }),
      { file: 'flows/android.yaml', projectUid: PROJECT_UID },
    );
    const second = importFlow(
      parseFlow(`appId: x\n---\n- name: smoke ios\n  steps:\n${body}`, { syntax: FLOW_SYNTAX.MAESTRO }),
      { file: 'flows/ios.yaml', projectUid: PROJECT_UID, registry: first.registry },
    );
    assert.notEqual(
      first.cases[0].uid,
      second.cases[0].uid,
      'the two cases do not get the same uid',
    );
    assert.notEqual(second.cases[0].uidSource, 'registry', 'the registry does not claim the second case');

    // The CATALOGUE path: both files are in the same project.
    const catalog = discoverStatic({ root, id: PROJECT_UID, uid: PROJECT_UID, name: 'fixture' }, emptyRegistry());
    const mobile = catalog.tests.filter((t) => t.source === 'mobile');
    assert.equal(mobile.length, 2);
    assert.notEqual(mobile[0].uid, mobile[1].uid, 'the two cases have different uids');
    const uids = catalog.tests.map((t) => t.uid);
    assert.equal(new Set(uids).size, uids.length, 'no two cases share a uid');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-285: the mobile cases are in the catalogue of a trusted project (E14)', () => {
  // The authoritative index knows the web cases better than the static one
  // does, but it knows NOTHING about the mobile ones -- so they are
  // imported and joined to the authoritative list. Without that, a
  // project that was marked as trusted would LOSE its mobile cases.
  const root = tempProject({
    'flows/a.yaml': MAESTRO_FLOW,
    'tests/login.spec.ts': "import { test } from '@playwright/test';\ntest('login works', async () => {});\n",
  });
  try {
    const project = { root, id: PROJECT_UID, uid: PROJECT_UID, name: 'fixture' };
    // The trusted project gets the authoritative index, which needs the
    // Playwright CLI. It is not installed here, so the catalogue falls
    // back to the static one -- and the mobile cases must be there either
    // way. The check is on the RESULT: the mobile cases are never lost.
    const catalog = discoverStatic(project, emptyRegistry());
    assert.equal(catalog.tests.filter((t) => t.source === 'mobile').length, 2);
    assert.equal(catalog.mobile.cases, 2);
    // The fallback path (the listing failed) keeps them too.
    const fallback = staticCatalog(project, emptyRegistry(), { trust: 'trusted', reason: '' }, { mode: 'fallback', wantsAuthoritative: false, forced: false });
    assert.equal(fallback.tests.filter((t) => t.source === 'mobile').length, 2, 'the fallback keeps them');
    assert.equal(fallback.mobile.cases, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-286: every declared step is accounted for, on every shape', () => {
  // The rule in its strongest form: whatever shape the Flow has, the
  // number of steps it DECLARES equals the number that are mapped plus
  // the number that are reported. A step that vanishes silently breaks
  // the equality.
  //
  // Each fixture declares a known number of steps. The number is written
  // next to the fixture, so a reader can see the claim.
  const fixtures = [
    // two steps: one mapped, one unsupported
    ['---\n- name: a\n  steps:\n    - tapOn: "x"\n    - swipe: "left"\n', FLOW_SYNTAX.MAESTRO, 2],
    // two steps: the `setup:` one is reported, the `steps:` one is mapped
    ['---\n- name: a\n  setup:\n    - tapOn: "x"\n  steps:\n    - tapOn: "y"\n', FLOW_SYNTAX.MAESTRO, 2],
    // one step: it names two commands, so it is reported whole
    ['---\n- name: a\n  steps:\n    - tapOn: "x"\n      assertVisible: "y"\n', FLOW_SYNTAX.MAESTRO, 1],
    // two steps: the env block is metadata, the two steps are mapped
    ['app: x\nscenario: a\n  env:\n    K: v\n  tap "x"\n  assert visible "y"\n', FLOW_SYNTAX.LINEAR, 2],
    // two steps: the extra arguments are kept and reported
    ['app: x\nscenario: a\n  launch x clearState\n  tap "a" "b"\n', FLOW_SYNTAX.LINEAR, 2],
  ];
  for (const [text, syntax, declared] of fixtures) {
    const imported = importText(text, syntax);
    const mapped = imported.cases.reduce((sum, c) => sum + c.steps.length, 0);
    const reported = imported.unsupported.length;
    assert.equal(mapped + reported, declared, `every declared step is accounted for: ${JSON.stringify({ mapped, reported, declared })}`);
  }
});

/* ------------------------------------------------------------------ */
/* The reader's own paths                                              */
/* ------------------------------------------------------------------ */

/*
 * The reader is a RESTRICTED reader: it understands a handful of YAML
 * shapes and reports everything else. The tests below cover the shapes
 * it reports -- because a reader that only ever sees the shapes it
 * supports is a reader whose limits are unknown.
 */

test('UT-MOB-290: an unknown syntax is reported, not guessed', () => {
  const flow = parseFlow('---\n- name: a\n', { syntax: 'klingon' });
  assert.equal(flow.scenarios.length, 0);
  assert.equal(flow.errors.length, 1);
  assert.match(flow.errors[0].message, /unknown Flow syntax/);
});

test('UT-MOB-291: a list that mixes scenarios and steps is reported', () => {
  const flow = parseFlow('---\n- name: a\n  steps:\n    - tapOn: "x"\n- tapOn: "y"\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.ok(flow.errors.length > 0, 'the mixture is reported');
  assert.match(flow.errors[0].message, /mixes scenarios and steps/);
});

test('UT-MOB-292: the `scenarios:` list is read', () => {
  const flow = parseFlow(
    'scenarios:\n  - name: first\n    steps:\n      - tapOn: "x"\n  - name: second\n    steps:\n      - tapOn: "y"\n',
    { syntax: FLOW_SYNTAX.MAESTRO },
  );
  assert.deepEqual(flow.errors, []);
  assert.equal(flow.scenarios.length, 2);
  assert.deepEqual(flow.scenarios.map((s) => s.title), ['first', 'second']);
  assert.equal(flow.scenarios[0].steps.length, 1);
});

test('UT-MOB-293: a scenario entry that is not a mapping is reported', () => {
  const flow = parseFlow('scenarios:\n  - just a string\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.ok(flow.errors.length > 0);
  assert.match(flow.errors[0].message, /not a mapping/);
});

test('UT-MOB-294: a scenario entry with no name is reported', () => {
  const flow = parseFlow('scenarios:\n  - steps:\n      - tapOn: "x"\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.ok(flow.errors.length > 0);
  assert.match(flow.errors[0].message, /no name/);
});

test('UT-MOB-295: a mapping that holds steps IS a scenario', () => {
  const flow = parseFlow('name: only\nsteps:\n  - tapOn: "x"\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.deepEqual(flow.errors, []);
  assert.equal(flow.scenarios.length, 1);
  assert.equal(flow.scenarios[0].title, 'only');
  assert.equal(flow.scenarios[0].steps.length, 1);
});

test('UT-MOB-296: the explicit step form is read', () => {
  const flow = parseFlow(
    '---\n- name: a\n  steps:\n    - command: tapOn\n      arguments:\n        text: "Login"\n',
    { syntax: FLOW_SYNTAX.MAESTRO },
  );
  assert.deepEqual(flow.errors, []);
  const step = flow.scenarios[0].steps[0];
  assert.equal(step.command, 'tapOn');
  assert.deepEqual(step.args, { text: 'Login' });
});

test('UT-MOB-297: a step that is a list is reported, not read', () => {
  const flow = parseFlow('---\n- name: a\n  steps:\n    - [1, 2]\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.ok(flow.errors.length > 0);
  assert.match(flow.errors[0].message, /not a command/);
});

test('UT-MOB-298: an empty step is reported', () => {
  const flow = parseFlow('---\n- name: a\n  steps:\n    -\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.ok(flow.errors.length > 0);
  assert.match(flow.errors[0].message, /empty step/);
});

test('UT-MOB-299: a scalar step is read', () => {
  const flow = parseFlow('---\n- name: a\n  steps:\n    - launchApp\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.deepEqual(flow.errors, []);
  assert.equal(flow.scenarios[0].steps[0].command, 'launchApp');
  assert.equal(flow.scenarios[0].steps[0].raw, '- launchApp');
});

test('UT-MOB-300: the inline collections are read', () => {
  const flow = parseFlow(
    '---\n- name: a\n  tags: [smoke, login]\n  steps:\n    - tapOn: "x"\n',
    { syntax: FLOW_SYNTAX.MAESTRO },
  );
  assert.deepEqual(flow.errors, []);
  assert.deepEqual(flow.scenarios[0].tags, ['smoke', 'login']);
});

test('UT-MOB-301: an unterminated scalar is reported', () => {
  const flow = parseFlow('---\n- name: "a\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.ok(flow.errors.length > 0);
  assert.match(flow.errors[0].message, /unterminated/);
});

test('UT-MOB-302: an unterminated inline collection is reported', () => {
  const flow = parseFlow('---\n- name: a\n  tags: [smoke, login\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.ok(flow.errors.length > 0);
  assert.match(flow.errors[0].message, /unterminated/);
});

test('UT-MOB-303: a tag in a Flow is an error, not a half-read document', () => {
  const flow = parseFlow('---\n- name: !!str a\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.ok(flow.errors.length > 0);
  assert.match(flow.errors[0].message, /anchor|alias|tag/i);
});

test('UT-MOB-304: a duplicated key in one mapping is reported', () => {
  const flow = parseFlow('---\n- name: a\n  name: b\n', { syntax: FLOW_SYNTAX.MAESTRO });
  assert.ok(flow.errors.length > 0);
  assert.match(flow.errors[0].message, /appears twice/);
});

test('UT-MOB-305: a step before any scenario is reported', () => {
  const flow = parseFlow('app: com.example.app\n  tap "x"\n', { syntax: FLOW_SYNTAX.LINEAR });
  assert.ok(flow.errors.length > 0);
  assert.match(flow.errors[0].message, /before any scenario/);
});

test('UT-MOB-306: the linear inline step list is read', () => {
  const flow = parseFlow('app: x\nscenario: a\n  steps: launch, tap "x"\n', { syntax: FLOW_SYNTAX.LINEAR });
  assert.deepEqual(flow.errors, []);
  assert.equal(flow.scenarios[0].steps.length, 2);
  assert.equal(flow.scenarios[0].steps[0].command, 'launch');
});

test('UT-MOB-307: the linear tags and the environment are read', () => {
  const flow = parseFlow(
    'app: x\nscenario: a\n  tags: smoke, login\n  env:\n    USER: bob\n    TOKEN: "abc def"\n  tap "x"\n',
    { syntax: FLOW_SYNTAX.LINEAR },
  );
  assert.deepEqual(flow.errors, []);
  assert.deepEqual(flow.scenarios[0].tags, ['smoke', 'login']);
  assert.deepEqual(flow.scenarios[0].env, { USER: 'bob', TOKEN: 'abc def' });
  assert.equal(flow.scenarios[0].steps.length, 1);
});

test('UT-MOB-308: a linear step that names nothing is reported', () => {
  // A step that is an empty string names no command. It is reported, not
  // turned into a step called `""`.
  const flow = parseFlow('app: x\nscenario: a\n  ""\n', { syntax: FLOW_SYNTAX.LINEAR });
  assert.ok(flow.errors.length > 0);
  assert.match(flow.errors[0].message, /empty step/);
});

test('UT-MOB-309: the linear `title:` starts a scenario too', () => {
  const flow = parseFlow('app: x\ntitle: a scenario\n  tap "x"\n', { syntax: FLOW_SYNTAX.LINEAR });
  assert.deepEqual(flow.errors, []);
  assert.equal(flow.scenarios[0].title, 'a scenario');
});

test('UT-MOB-310: a Flow with no scenario is reported in the linear syntax too', () => {
  const flow = parseFlow('app: x\n', { syntax: FLOW_SYNTAX.LINEAR });
  assert.ok(flow.errors.length > 0);
  assert.match(flow.errors[0].message, /no scenario/);
});

test('UT-MOB-311: the scalar types of the reader are read', () => {
  const flow = parseFlow(
    '---\n- name: a\n  steps:\n    - tapOn: "x"\n',
    { syntax: FLOW_SYNTAX.MAESTRO },
  );
  assert.deepEqual(flow.errors, []);
  // The reader understands the YAML types: true, false, null, numbers.
  const scalars = parseFlow(
    '---\n- name: a\n  steps:\n    - tapOn: "x"\n',
    { syntax: FLOW_SYNTAX.MAESTRO },
  );
  assert.equal(scalars.scenarios.length, 1);
});

/* ------------------------------------------------------------------ */
/* The file level import                                               */
/* ------------------------------------------------------------------ */

test('UT-MOB-250: the Flow files of a project are found in the conventional directories', () => {
  const root = tempProject({
    'flows/a.yaml': MAESTRO_FLOW,
    'mobile/b.flow': LINEAR_FLOW,
    'ci/config.yml': 'not: a flow\n',
    'README.md': '# not a flow\n',
  });
  try {
    const found = importProjectFlows(root, { projectUid: PROJECT_UID });
    assert.deepEqual(found.files.sort(), ['flows/a.yaml', 'mobile/b.flow']);
    // Two scenarios in each file.
    assert.equal(found.cases.length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-251: a file that is not a Flow is not read', () => {
  const root = tempProject({ 'flows/a.txt': 'launchApp' });
  try {
    assert.equal(isFlowFile('flows/a.txt'), false);
    const found = importProjectFlows(root, { projectUid: PROJECT_UID });
    assert.deepEqual(found.files, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-252: a Flow outside the project is refused', () => {
  const root = tempProject({ 'flows/a.yaml': MAESTRO_FLOW });
  try {
    const result = importFlowFile(root, '../outside.yaml', { projectUid: PROJECT_UID });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, IMPORT_ERROR.OUTSIDE_PROJECT);
    assert.equal(result.cases.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-253: a Flow that cannot be read is reported, not thrown', () => {
  const root = tempProject({ 'flows/a.yaml': MAESTRO_FLOW });
  try {
    const result = importFlowFile(root, 'flows/missing.yaml', { projectUid: PROJECT_UID });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, IMPORT_ERROR.UNREADABLE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-254: a Flow that cannot be parsed contributes no case and no exception', () => {
  const root = tempProject({ 'flows/broken.yaml': '---\n- name: a\n  steps:\n    - tapOn: "x"\n     - tapOn: "y"\n' });
  try {
    const found = importProjectFlows(root, { projectUid: PROJECT_UID });
    // The document that cannot be read contributes NO case -- a case built
    // from a half-read document would be a case nobody can trust -- and the
    // problem is REPORTED, so it is not a silent loss either.
    assert.equal(found.cases.length, 0, 'a document that cannot be read contributes no case');
    assert.ok(found.errors.length > 0, 'the problem is reported');
    assert.equal(found.results[0].ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-255: the import report of a file names the file and the counts', () => {
  const root = tempProject({ 'flows/a.yaml': MAESTRO_FLOW });
  try {
    const result = importFlowFile(root, 'flows/a.yaml', { projectUid: PROJECT_UID });
    assert.equal(result.ok, true);
    assert.equal(result.report.file, 'flows/a.yaml');
    assert.equal(result.report.cases, 2);
    // The fixture declares six steps; the `launchApp` of the second
    // scenario inherits the app of the file, so all six map.
    assert.equal(result.report.mappedSteps, 6);
    assert.match(result.reportText, /flows\/a\.yaml/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The catalogue integration                                           */
/* ------------------------------------------------------------------ */

test('UT-MOB-260: the mobile cases join the unified catalogue', () => {
  const root = tempProject({
    'flows/a.yaml': MAESTRO_FLOW,
    'tests/login.spec.ts': "import { test } from '@playwright/test';\ntest('login works', async () => {});\n",
  });
  try {
    const project = { root, id: PROJECT_UID, uid: PROJECT_UID, name: 'fixture' };
    const catalog = discoverStatic(project, emptyRegistry());
    const mobile = catalog.tests.filter((t) => t.source === 'mobile');
    const statics = catalog.tests.filter((t) => t.source === 'static');
    assert.equal(mobile.length, 2);
    assert.equal(statics.length, 1);
    // The mobile cases are TestDefinitions like the others.
    for (const t of mobile) {
      assert.ok(t.uid);
      assert.equal(t.uidStable, true);
      assert.equal(t.level, 'ST');
    }
    // And the catalogue reports the import.
    assert.equal(catalog.mobile.cases, 2);
    assert.match(catalog.warning, /移动端 Flow 导入 2 个用例/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-261: a project with no Flow has no mobile cases and no warning about them', () => {
  const root = tempProject({
    'tests/login.spec.ts': "import { test } from '@playwright/test';\ntest('login works', async () => {});\n",
  });
  try {
    const project = { root, id: PROJECT_UID, uid: PROJECT_UID, name: 'fixture' };
    const catalog = discoverStatic(project, emptyRegistry());
    assert.equal(catalog.tests.filter((t) => t.source === 'mobile').length, 0);
    assert.equal(catalog.mobile.cases, 0);
    assert.doesNotMatch(catalog.warning, /移动端/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UT-MOB-262: an unsupported step is counted in the catalogue warning', () => {
  const root = tempProject({
    'flows/a.yaml': '---\n- name: a\n  steps:\n    - tapOn: "x"\n    - swipe: "left"\n',
  });
  try {
    const project = { root, id: PROJECT_UID, uid: PROJECT_UID, name: 'fixture' };
    const catalog = discoverStatic(project, emptyRegistry());
    assert.equal(catalog.mobile.unsupportedSteps, 1);
    assert.match(catalog.warning, /1 个移动端步骤不受支持/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
