// ATS-602 round-2 review probe, real Bridge over HTTP (Opus).
// Usage: node r2-e2e.mjs <tree> <playwright-node_modules> <scratch> <trusted|untrusted>
// N1: a test deleted in one discovery must not hand its uid to a NEW test
//     with the same body in a later discovery (ATS-201 pruning rule:
//     "keeping it would let a stale uid be handed out later").
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [treeArg, nmArg, scratchArg, mode = 'trusted'] = process.argv.slice(2);
const tree = path.resolve(treeArg);
const nm = path.resolve(nmArg);
const scratch = path.resolve(scratchArg);
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const data = path.join(scratch, 'data');
const fx = path.join(scratch, 'project');
const w = (rel, body) => { const f = path.join(fx, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body, 'utf8'); };
const HEAD = "import { test, expect } from '@playwright/test';\n";
const ALPHA = "test('alpha', async () => { const a = 1; expect(a).toBe(1); });\n";
const BETA_BODY = "async () => { const b = 2; expect(b + 40).toBe(42); }";
w('package.json', '{"name":"opus494r2","private":true}');
w('playwright.config.ts', "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n");
w('tests/a.spec.ts', HEAD + ALPHA + `test('beta', ${BETA_BODY});\n`);
w('flows/login.yaml', 'appId: com.example.app\n---\n- name: Login\n  steps:\n    - launchApp\n    - tapOn: "Login"\n- name: Logout\n  steps:\n    - launchApp\n    - tapOn: "Logout"\n');
fs.symlinkSync(nm, path.join(fx, 'node_modules'), 'junction');

let held = 0;
const report = (id, holds, detail) => { if (holds) held += 1; console.log(`${id} ${holds ? 'HOLDS (defect present)' : 'OK'} :: ${detail}`); };
const cp = spawn(process.execPath, ['server/index.mjs'], { cwd: tree, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data }, stdio: 'ignore' });
let token;
const api = async (ep, method = 'GET', payload) => {
  const r = await fetch(`http://127.0.0.1:${port}${ep}`, { method, headers: { 'X-ATS-Token': token ?? '', 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  return [r.status, await r.json()];
};
try {
  for (let i = 0; i < 200; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  token = (await api('/api/session'))[1].token;
  const [st, reg] = await api('/api/projects', 'POST', { path: fx });
  if (st !== 201) throw new Error(`register ${st} ${JSON.stringify(reg)}`);
  const pid = reg.project.id;
  if (mode === 'trusted') await api(`/api/projects/${pid}/trust`, 'POST', { trust: 'trusted', reason: 'opus r2 probe' });

  const [, c1] = await api(`/api/projects/${pid}/tests`);
  const beta = c1.tests.find((t) => t.title === 'beta');
  const logout = c1.tests.find((t) => t.title === 'Logout');

  // Discovery 2: beta and the Logout scenario are deleted.
  w('tests/a.spec.ts', HEAD + ALPHA);
  w('flows/login.yaml', 'appId: com.example.app\n---\n- name: Login\n  steps:\n    - launchApp\n    - tapOn: "Login"\n');
  const [, c2] = await api(`/api/projects/${pid}/tests`);

  // Discovery 3: a NEW web test and a NEW scenario reuse the deleted bodies.
  w('tests/a.spec.ts', HEAD + ALPHA + `test('gamma is a new test', ${BETA_BODY});\n`);
  w('flows/login.yaml', 'appId: com.example.app\n---\n- name: Login\n  steps:\n    - launchApp\n    - tapOn: "Login"\n- name: A brand new scenario\n  steps:\n    - launchApp\n    - tapOn: "Logout"\n');
  const [, c3] = await api(`/api/projects/${pid}/tests`);
  const gamma = c3.tests.find((t) => t.title === 'gamma is a new test');
  const fresh = c3.tests.find((t) => t.title === 'A brand new scenario');

  console.log(`mode=${mode} discovery=${c1.discovery}/${c2.discovery}/${c3.discovery} tests=${c1.tests.length}/${c2.tests.length}/${c3.tests.length}`);
  report('N1-web', Boolean(beta && gamma && gamma.uid === beta.uid),
    `deleted beta=${beta?.uid}/${beta?.uidSource}; later new gamma=${gamma?.uid}/${gamma?.uidSource}`);
  report('N1-mobile', Boolean(logout && fresh && fresh.uid === logout.uid),
    `deleted Logout=${logout?.uid}/${logout?.uidSource}; later new scenario=${fresh?.uid}/${fresh?.uidSource}`);

  // N3 over HTTP: a scenario is duplicated, then the original's steps are edited.
  w('flows/dup.yaml', '---\n- name: Checkout\n  steps:\n    - launchApp: {appId: x}\n    - tapOn: "Pay"\n');
  await api(`/api/projects/${pid}/tests`);
  w('flows/dup.yaml', '---\n- name: Checkout\n  steps:\n    - launchApp: {appId: x}\n    - tapOn: "Pay"\n    - assertVisible: "Receipt"\n- name: Checkout copy\n  steps:\n    - launchApp: {appId: x}\n    - tapOn: "Pay"\n');
  const [, c5] = await api(`/api/projects/${pid}/tests`);
  const uids5 = c5.tests.map((t) => t.uid);
  const d5 = [...new Set(uids5.filter((u, i) => uids5.indexOf(u) !== i))];
  report('N3-http', d5.length > 0, `${JSON.stringify(c5.tests.filter((t) => t.file === 'flows/dup.yaml').map((t) => [t.title, t.uid, t.uidSource]))} duplicates=${JSON.stringify(d5)}`);
} finally {
  cp.kill();
  await new Promise((r) => setTimeout(r, 300));
}
console.log(held ? `RESULT: ${held} counterexample(s) hold` : 'RESULT: OK');
process.exitCode = held ? 1 : 0;
