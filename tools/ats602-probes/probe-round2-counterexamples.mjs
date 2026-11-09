// ATS-602 round-2 review probe, in-process (Opus).
// Usage: node r2.mjs <tree> <scratch>
// Simulates server/index.mjs exactly: discover (static catalogue), write the
// catalogue's registry cell back, edit the files, discover again.
// N2/N3: after the registry is persisted, no two cases of the catalogue may
// share a uid.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tree = path.resolve(process.argv[2] ?? '.');
const scratch = path.resolve(process.argv[3] ?? 'r2-scratch');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
const imp = (rel) => import(pathToFileURL(path.join(tree, rel)).href);
const { discoverStatic } = await imp('server/core.mjs');
const { projectUidOf } = await imp('server/uid.mjs');

let held = 0;
const report = (id, holds, detail) => { if (holds) held += 1; console.log(`${id} ${holds ? 'HOLDS (defect present)' : 'OK'} :: ${detail}`); };
let n = 0;
function session(files) {
  n += 1;
  const root = path.join(scratch, `p${n}`);
  const write = (all) => {
    for (const [rel, body] of Object.entries(all)) {
      const f = path.join(root, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body, 'utf8');
    }
  };
  write({ 'package.json': '{}', ...files });
  const project = { id: `p${n}`, root, name: `p${n}` };
  const key = projectUidOf(project);
  let registry = { version: 1, projects: {} };
  return {
    write,
    discover() {
      const cat = discoverStatic(project, registry);
      const cell = cat.registry?.projects?.[key];
      registry = { ...registry, projects: { ...registry.projects, ...(cell ? { [key]: cell } : {}) } };
      return cat;
    },
  };
}
const dups = (cat) => {
  const uids = cat.tests.map((t) => t.uid);
  return [...new Set(uids.filter((u, i) => uids.indexOf(u) !== i))];
};
const show = (cat) => JSON.stringify(cat.tests.map((t) => [t.source, t.title, t.uid, t.uidSource]));
const HEAD = "import { test } from '@playwright/test';\n";

/* N2-mobile: a scenario drops its @TC- token; ANOTHER scenario claims it. */
{
  const s = session({ 'flows/a.yaml': '---\n- name: "Login @TC-500"\n  steps:\n    - tapOn: "Login"\n- name: Other\n  steps:\n    - tapOn: "Other"\n' });
  s.discover();
  s.write({ 'flows/a.yaml': '---\n- name: Login\n  steps:\n    - tapOn: "Login"\n- name: "Other @TC-500"\n  steps:\n    - tapOn: "Other"\n' });
  const c = s.discover();
  report('N2-mobile', dups(c).length > 0, `${show(c)} duplicates=${JSON.stringify(dups(c))}`);
}
/* N2-cross: a mobile scenario drops @TC-600; a WEB test claims it. */
{
  const s = session({
    'tests/a.spec.ts': HEAD + "test('web case', async () => { const w = 1; });\n",
    'flows/a.yaml': '---\n- name: "Login @TC-600"\n  steps:\n    - tapOn: "Login"\n',
  });
  s.discover();
  s.write({
    'tests/a.spec.ts': HEAD + "test('web case @TC-600', async () => { const w = 1; });\n",
    'flows/a.yaml': '---\n- name: Login\n  steps:\n    - tapOn: "Login"\n',
  });
  const c = s.discover();
  report('N2-cross', dups(c).length > 0, `${show(c)} duplicates=${JSON.stringify(dups(c))}`);
}
/* N2-cross-rev: a WEB test drops @TC-650; a mobile scenario claims it. */
{
  const s = session({
    'tests/a.spec.ts': HEAD + "test('web case @TC-650', async () => { const w = 1; });\n",
    'flows/a.yaml': '---\n- name: Login\n  steps:\n    - tapOn: "Login"\n',
  });
  s.discover();
  s.write({
    'tests/a.spec.ts': HEAD + "test('web case', async () => { const w = 1; });\n",
    'flows/a.yaml': '---\n- name: "Login @TC-650"\n  steps:\n    - tapOn: "Login"\n',
  });
  const c = s.discover();
  report('N2-cross-rev', dups(c).length > 0, `${show(c)} duplicates=${JSON.stringify(dups(c))}`);
}
/* N2-web control: the same move between two WEB tests (ATS-201 rule). */
{
  const s = session({ 'tests/a.spec.ts': HEAD + "test('login @TC-700', async () => { const a = 1; });\ntest('other', async () => { const b = 2; });\n" });
  s.discover();
  s.write({ 'tests/a.spec.ts': HEAD + "test('login', async () => { const a = 1; });\ntest('other @TC-700', async () => { const b = 2; });\n" });
  const c = s.discover();
  console.log(`N2-web-control ${dups(c).length ? 'duplicate' : 'no duplicate'} :: ${show(c)}`);
}
/* N3-mobile: a scenario is duplicated, then the original's steps are edited. */
{
  const s = session({ 'flows/a.yaml': '---\n- name: Login\n  steps:\n    - launchApp: {appId: x}\n    - tapOn: "Login"\n' });
  s.discover();
  s.write({ 'flows/a.yaml': '---\n- name: Login\n  steps:\n    - launchApp: {appId: x}\n    - tapOn: "Login"\n    - assertVisible: "Welcome"\n- name: Login copy\n  steps:\n    - launchApp: {appId: x}\n    - tapOn: "Login"\n' });
  const c = s.discover();
  report('N3-mobile', dups(c).length > 0, `${show(c)} duplicates=${JSON.stringify(dups(c))}`);
}
/* N3-web control. */
{
  const s = session({ 'tests/a.spec.ts': HEAD + "test('login', async () => { const a = 1; });\n" });
  s.discover();
  s.write({ 'tests/a.spec.ts': HEAD + "test('login', async () => { const a = 1; const b = 2; });\ntest('login copy', async () => { const a = 1; });\n" });
  const c = s.discover();
  console.log(`N3-web-control ${dups(c).length ? 'duplicate' : 'no duplicate'} :: ${show(c)}`);
}

console.log(held ? `RESULT: ${held} counterexample(s) hold` : 'RESULT: OK');
process.exitCode = held ? 1 : 0;
