// ATS-602 round-1 review probe (Opus).
// Usage: node r1.mjs <tree> [scratch]
// Every E* line is a counterexample check. "HOLDS" = the defect is present.
// Exit 1 while any E* counterexample holds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tree = path.resolve(process.argv[2] ?? '.');
const scratch = path.resolve(process.argv[3] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'opus494-')));
fs.mkdirSync(scratch, { recursive: true });
const imp = (rel) => import(pathToFileURL(path.join(tree, rel)).href);

const { parseFlow, FLOW_SYNTAX } = await imp('server/discovery/mobile-flow.mjs');
const { importFlow, buildImportReport } = await imp('server/discovery/mobile-import.mjs');
const { importProjectFlows, findFlowFiles } = await imp('server/discovery/mobile-flow-import.mjs');
const { discoverStatic } = await imp('server/core.mjs');
const { projectUidOf } = await imp('server/uid.mjs');

const PUID = 'proj_1_0123456789abcdef01234567';
let held = 0;
const report = (id, holds, detail) => {
  if (holds) held += 1;
  console.log(`${id} ${holds ? 'HOLDS (defect present)' : 'OK'} :: ${detail}`);
};

/** Every source line that declares a step must be mapped, unsupported, warned or errored. */
function accounting(text, syntax, stepLines) {
  const flow = parseFlow(text, { syntax });
  const imported = importFlow(flow, { file: 'flows/p.yaml', projectUid: PUID });
  const seen = new Set();
  for (const c of imported.cases) for (const s of c.steps) seen.add(s.line);
  for (const u of imported.unsupported) seen.add(u.line);
  for (const w of imported.warnings) seen.add(w.line);
  for (const e of imported.errors) seen.add(e.line);
  const missing = stepLines.filter((l) => !seen.has(l));
  return { imported, missing, report: buildImportReport(imported) };
}

let id = 0;
const tmpProject = (files) => {
  id += 1;
  const root = path.join(scratch, `p${id}`);
  fs.rmSync(root, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return root;
};

/* ---------------- E1: nested Flow directories ---------------- */
{
  const root = tmpProject({
    'package.json': '{}',
    'flows/top.yaml': '---\n- name: top\n  steps:\n    - tapOn: "a"\n',
    'flows/smoke/login.yaml': '---\n- name: nested login\n  steps:\n    - tapOn: "b"\n',
    'tests/mobile/android/pay.flow': 'scenario: nested pay\n  tap "c"\n',
  });
  const files = findFlowFiles(root);
  const missingNested = !files.includes('flows/smoke/login.yaml') || !files.includes('tests/mobile/android/pay.flow');
  report('E1a', missingNested, `findFlowFiles = ${JSON.stringify(files)} (expected to include flows/smoke/login.yaml and tests/mobile/android/pay.flow)`);

  // The walker reads <root>/<basename> instead of <root>/flows/<basename>:
  // a root-level directory with the same name is listed under the Flow dir.
  const root2 = tmpProject({
    'package.json': '{}',
    'flows/android/.keep': '',
    'android/ci.yml': 'not: a flow\n',
  });
  const files2 = findFlowFiles(root2);
  const imp2 = importProjectFlows(root2, { projectUid: PUID });
  report('E1b', files2.includes('flows/android/ci.yml'),
    `root android/ci.yml is reported as ${JSON.stringify(files2)}; import errors = ${JSON.stringify(imp2.errors.map((e) => e.code))}`);
}

/* ---------------- E2: unconsumed top-level tokens vanish ---------------- */
{
  const text = [
    'appId: com.example.app', // 1
    '---', // 2
    '- name: First', // 3
    '  steps:', // 4
    '    - tapOn: "Login"', // 5
    'timeout: 30', // 6
    '- name: Second', // 7
    '  steps:', // 8
    '    - tapOn: "Pay"', // 9
    '    - assertVisible: "Receipt"', // 10
  ].join('\n');
  const a = accounting(text, FLOW_SYNTAX.MAESTRO, [5, 9, 10]);
  report('E2', a.missing.length > 0,
    `cases=${a.imported.cases.map((c) => c.title)} errors=${a.imported.errors.length} unaccounted step lines=${JSON.stringify(a.missing)}`);
}

/* ---------------- E3: a second command key in one step vanishes ---------------- */
{
  const text = '---\n- name: a\n  steps:\n    - tapOn: "Login"\n      assertVisible: "Welcome"\n';
  const a = accounting(text, FLOW_SYNTAX.MAESTRO, [4]);
  const step = a.imported.cases[0]?.steps?.[0];
  const lost = a.imported.unsupported.length === 0 && a.imported.warnings.length === 0 && a.imported.errors.length === 0
    && !(step && 'assertVisible' in (step.args ?? {}));
  report('E3', lost, `steps=${JSON.stringify(a.imported.cases[0]?.steps?.map((s) => s.kind))} unsupported=${a.imported.unsupported.length} warnings=${a.imported.warnings.length} errors=${a.imported.errors.length}`);
}

/* ---------------- E4: step options (when/optional/timeout) vanish without warning ---------------- */
{
  const text = '---\n- name: a\n  steps:\n    - tapOn: "Allow"\n      optional: true\n      when:\n        platform: Android\n';
  const a = accounting(text, FLOW_SYNTAX.MAESTRO, [4]);
  const step = a.imported.cases[0]?.steps?.[0];
  const kept = step && JSON.stringify(step).includes('optional') && JSON.stringify(step).includes('Android');
  const warned = a.imported.warnings.length > 0;
  report('E4', !kept && !warned, `mapped step=${JSON.stringify(step)} warnings=${a.imported.warnings.length}`);
}

/* ---------------- E5: scenario/header step lists other than the first vanish ---------------- */
{
  const text = [
    'appId: com.example.app', // 1
    'onFlowStart:', // 2
    '  - launchApp', // 3
    '---', // 4
    '- name: a', // 5
    '  setup:', // 6
    '    - tapOn: "Accept cookies"', // 7
    '  steps:', // 8
    '    - tapOn: "Login"', // 9
    '  commands:', // 10
    '    - assertVisible: "Welcome"', // 11
  ].join('\n');
  const a = accounting(text, FLOW_SYNTAX.MAESTRO, [3, 7, 9, 11]);
  report('E5', a.missing.length > 0, `unaccounted step lines=${JSON.stringify(a.missing)} (3=onFlowStart, 7=setup, 11=second list)`);
}

/* ---------------- E6: a single-flow file with a header name gets a phantom empty case ---------------- */
{
  const text = 'appId: com.example.app\nname: Login\n---\n- launchApp\n- tapOn: "Login"\n';
  const flow = parseFlow(text, { syntax: FLOW_SYNTAX.MAESTRO });
  const imported = importFlow(flow, { file: 'flows/login.yaml', projectUid: PUID });
  const summary = imported.cases.map((c) => ({ title: c.title, steps: c.steps.length, uidSource: c.uidSource, stable: c.uidStable }));
  report('E6', imported.cases.length !== 1, `cases=${JSON.stringify(summary)}`);
}

/* ---------------- E7: tapOn by id is reported as "needs text" ---------------- */
{
  const text = '---\n- name: a\n  steps:\n    - tapOn:\n        id: "login_button"\n';
  const flow = parseFlow(text, { syntax: FLOW_SYNTAX.MAESTRO });
  const imported = importFlow(flow, { file: 'flows/a.yaml', projectUid: PUID });
  const u = imported.unsupported[0];
  report('E7', Boolean(u && u.reason === 'missing-argument'), `unsupported=${JSON.stringify(u && { reason: u.reason, reasonText: u.reasonText })} (mobile-import.mjs docstring: "in \`- tapOn: {id: \\"x\\"}\` the \`id\` names the same argument")`);
}

/* ---------------- E8: linear env block swallows following step lines ---------------- */
{
  const text = [
    'app: com.example.app', // 1
    'scenario: a', // 2
    '  env:', // 3
    '    USER: bob', // 4
    '  tap "Login: now"', // 5  -- fine (quoted)
    '  tap Settings: General', // 6
    '  assert visible "Done"', // 7
  ].join('\n');
  const a = accounting(text, FLOW_SYNTAX.LINEAR, [5, 6, 7]);
  report('E8', a.missing.length > 0, `env=${JSON.stringify(a.imported.cases[0]?.env ?? null)} unaccounted step lines=${JSON.stringify(a.missing)}`);
}

/* ---------------- E9: linear extra arguments overwrite the primary ---------------- */
{
  const text = 'app: com.example.app\nscenario: a\n  launch com.example.app clearState\n  tap "First" "Second"\n';
  const flow = parseFlow(text, { syntax: FLOW_SYNTAX.LINEAR });
  const imported = importFlow(flow, { file: 'flows/a.flow', projectUid: PUID });
  const steps = imported.cases[0]?.steps ?? [];
  const launch = steps.find((s) => s.kind === 'launchApp');
  const tap = steps.find((s) => s.kind === 'tapOn');
  const holds = (launch && launch.args.appId !== 'com.example.app') || (tap && tap.args.text !== 'First' && imported.warnings.length === 0);
  report('E9', Boolean(holds), `launch.args=${JSON.stringify(launch?.args)} tap.args=${JSON.stringify(tap?.args)} warnings=${imported.warnings.length}`);
}

/* ---------------- E10: alias collision drops one value silently ---------------- */
{
  const text = '---\n- name: a\n  steps:\n    - tapOn:\n        text: "Login"\n        title: "Sign in"\n';
  const flow = parseFlow(text, { syntax: FLOW_SYNTAX.MAESTRO });
  const imported = importFlow(flow, { file: 'flows/a.yaml', projectUid: PUID });
  const s = imported.cases[0]?.steps?.[0];
  report('E10', Boolean(s) && !JSON.stringify(s.args).includes('Login') && imported.warnings.length === 0,
    `args=${JSON.stringify(s?.args)} warnings=${imported.warnings.length}`);
}

/* ---------------- E11: the catalogue (API path) does not keep the registry ---------------- */
// Simulates server/index.mjs:606-640 exactly: discover, write catalog.registry
// cell back, discover again after an edit.
{
  const flowV1 = 'appId: com.example.app\n---\n- name: Old title\n  steps:\n    - launchApp\n    - tapOn: "Login"\n';
  const flowV2 = flowV1.replace('Old title', 'New title');
  const flowV3 = '# a comment line added on top\n' + flowV1;
  const root = tmpProject({ 'package.json': '{}', 'flows/login.yaml': flowV1 });
  const project = { id: 'p', root, name: 'p' };
  const projectKey = projectUidOf(project);
  let registry = { version: 1, projects: {} };
  const round = () => {
    const cat = discoverStatic(project, registry);
    const cell = cat.registry?.projects?.[projectKey];
    registry = { ...registry, projects: { ...registry.projects, ...(cell ? { [projectKey]: cell } : {}) } };
    return cat;
  };
  const c1 = round();
  const m1 = c1.tests.find((t) => t.source === 'mobile');
  const persisted = (registry.projects[projectKey]?.entries ?? []).filter((e) => e.file === 'flows/login.yaml').length;
  fs.writeFileSync(path.join(root, 'flows/login.yaml'), flowV2, 'utf8');
  const m2 = round().tests.find((t) => t.source === 'mobile');
  fs.writeFileSync(path.join(root, 'flows/login.yaml'), flowV3, 'utf8');
  const m3 = round().tests.find((t) => t.source === 'mobile');
  report('E11a', persisted === 0, `mobile registry entries persisted by the catalogue = ${persisted}`);
  report('E11b', m1.uid !== m2.uid, `retitle: ${m1.uid}/${m1.uidSource} -> ${m2.uid}/${m2.uidSource} (docs/25 §4.3 says registry keeps it)`);
  report('E11c', m1.uid !== m3.uid, `comment line added on top: ${m1.uid} -> ${m3.uid}`);
}

/* ---------------- E12: duplicate explicit @TC across web + mobile ---------------- */
{
  const root = tmpProject({
    'package.json': '{}',
    'tests/a.spec.ts': "import { test } from '@playwright/test';\ntest('web login @TC-100', async () => {});\n",
    'flows/a.yaml': '---\n- name: "mobile login @TC-100"\n  steps:\n    - tapOn: "x"\n- name: "mobile pay @TC-200"\n  steps:\n    - tapOn: "y"\n- name: "mobile pay again @TC-200"\n  steps:\n    - tapOn: "z"\n',
  });
  const cat = discoverStatic({ id: 'q', root, name: 'q' }, { version: 1, projects: {} });
  const uids = cat.tests.map((t) => t.uid);
  const dup = uids.filter((u, i) => uids.indexOf(u) !== i);
  report('E12', dup.length > 0, `catalogue uids=${JSON.stringify(cat.tests.map((t) => [t.source, t.uid, t.uidSource, t.uidStable]))} duplicates=${JSON.stringify([...new Set(dup)])}`);
}

/* ---------------- E13: cross-file body collision via registry -> duplicate uid ---------------- */
{
  const body = '    - launchApp\n    - takeScreenshot: "home"\n';
  const a = importFlow(parseFlow(`appId: x\n---\n- name: smoke android\n  steps:\n${body}`), { file: 'flows/android.yaml', projectUid: PUID });
  const b = importFlow(parseFlow(`appId: x\n---\n- name: smoke ios\n  steps:\n${body}`), { file: 'flows/ios.yaml', projectUid: PUID, registry: a.registry });
  report('E13', a.cases[0].uid === b.cases[0].uid, `android=${a.cases[0].uid}/${a.cases[0].uidSource} ios=${b.cases[0].uid}/${b.cases[0].uidSource}`);
}

/* ---------------- E13c: the same collision through the catalogue with a persisted registry ----------------
 * Today this is OK only because the catalogue never persists mobile entries (E11a).
 * It is the guard for round 2: once E11 is fixed, it must stay OK. */
{
  const body = '    - launchApp\n    - takeScreenshot: "home"\n';
  const root = tmpProject({ 'package.json': '{}', 'flows/android.yaml': `appId: x\n---\n- name: smoke android\n  steps:\n${body}` });
  const project = { id: 'r', root, name: 'r' };
  const projectKey = projectUidOf(project);
  let registry = { version: 1, projects: {} };
  const round = () => {
    const cat = discoverStatic(project, registry);
    const cell = cat.registry?.projects?.[projectKey];
    registry = { ...registry, projects: { ...registry.projects, ...(cell ? { [projectKey]: cell } : {}) } };
    return cat;
  };
  round();
  fs.writeFileSync(path.join(root, 'flows/ios.yaml'), `appId: x\n---\n- name: smoke ios\n  steps:\n${body}`, 'utf8');
  const cat = round();
  const m = cat.tests.filter((t) => t.source === 'mobile');
  const uids = m.map((t) => t.uid);
  report('E13c', new Set(uids).size !== uids.length, `catalogue mobile uids=${JSON.stringify(m.map((t) => [t.file, t.uid, t.uidSource]))}`);
}

console.log(held ? `RESULT: ${held} counterexample(s) hold` : 'RESULT: OK');
process.exitCode = held ? 1 : 0;
