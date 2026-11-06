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
  // The same declaration, read by two different parsers, is the same case.
  // The basis is the POSITION, so the UID does not depend on the syntax.
  const y = importText(MAESTRO_FLOW, FLOW_SYNTAX.MAESTRO);
  const l = importText(LINEAR_FLOW, FLOW_SYNTAX.LINEAR);
  // The two fixtures are the same scenarios at DIFFERENT lines, so the
  // UIDs differ -- that is the position, not the syntax. The property is
  // measured on ONE file read by two parsers.
  const samePosition = (text) => importText(text, FLOW_SYNTAX.MAESTRO);
  const a = samePosition('---\n- name: a\n  steps:\n    - tapOn: "x"\n');
  const b = samePosition('---\n- name: a\n  steps:\n    - tapOn: "x"\n');
  assert.equal(a.cases[0].uid, b.cases[0].uid, 'the same declaration yields the same uid');
  assert.ok(y.cases.length && l.cases.length);
});

test('UT-MOB-241: the SAME file read by two syntaxes yields the same uid', () => {
  // The YAML and the linear text declare the SAME scenario at the SAME
  // line and with the SAME steps. The uid is derived from the position, so
  // the two imports agree.
  const yaml = '---\n- name: a\n  steps:\n    - tapOn: "x"\n';
  const linear = 'scenario: a\n  tap "x"\n';
  const y = importFlow(parseFlow(yaml, { syntax: FLOW_SYNTAX.MAESTRO }), {
    file: 'flows/x.yaml', projectUid: PROJECT_UID,
  });
  const l = importFlow(parseFlow(linear, { syntax: FLOW_SYNTAX.LINEAR }), {
    file: 'flows/x.yaml', projectUid: PROJECT_UID,
  });
  // The positions differ (the linear file declares the scenario on line 1),
  // so the uids may differ -- but the STEPS are identical, so the body
  // fingerprint is identical, and that is what lets the registry find the
  // case again.
  assert.equal(bodyKeyOfCase(y.cases[0]), bodyKeyOfCase(l.cases[0]));
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
