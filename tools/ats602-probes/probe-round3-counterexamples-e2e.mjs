// ATS-602 round-3 review probe, real Bridge over HTTP (Opus).
// Usage: node r3-e2e.mjs <tree> <playwright-node_modules> <scratch> <trusted|untrusted>
// The @TC- token rules of docs/25 §4.3.1 on BOTH catalogue paths:
//   T1 (N2-cross-rev): a WEB test drops @TC-650 and a mobile scenario claims it
//                      in the same discovery -> no two cases share a uid.
//   T2 (N2-cross):     a mobile scenario drops @TC-600 and a WEB test claims it.
//   T3 (E12):          a web test and a mobile scenario declare the same
//                      @TC-100 -> no duplicate, and (§4.3.1) NEITHER binds it.
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
const HEAD = "import { test, expect } from '@playwright/test';\n";

let held = 0;
const report = (id, holds, detail) => { if (holds) held += 1; console.log(`${id} ${holds ? 'HOLDS (defect present)' : 'OK'} :: ${detail}`); };
const cp = spawn(process.execPath, ['server/index.mjs'], { cwd: tree, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data }, stdio: 'ignore' });
let token;
const api = async (ep, method = 'GET', payload) => {
  const r = await fetch(`http://127.0.0.1:${port}${ep}`, { method, headers: { 'X-ATS-Token': token ?? '', 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  return [r.status, await r.json()];
};
let n = 0;
async function project(files) {
  n += 1;
  const fx = path.join(scratch, `p${n}`);
  const w = (all) => { for (const [rel, body] of Object.entries(all)) { const f = path.join(fx, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body, 'utf8'); } };
  w({ 'package.json': `{"name":"opus494r3p${n}","private":true}`, 'playwright.config.ts': "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n", ...files });
  fs.symlinkSync(nm, path.join(fx, 'node_modules'), 'junction');
  const [st, reg] = await api('/api/projects', 'POST', { path: fx });
  if (st !== 201) throw new Error(`register ${st} ${JSON.stringify(reg)}`);
  const pid = reg.project.id;
  if (mode === 'trusted') await api(`/api/projects/${pid}/trust`, 'POST', { trust: 'trusted', reason: 'opus r3 probe' });
  return { write: w, discover: async () => (await api(`/api/projects/${pid}/tests`))[1] };
}
const dups = (cat) => { const u = cat.tests.map((t) => t.uid); return [...new Set(u.filter((x, i) => u.indexOf(x) !== i))]; };
const show = (cat) => JSON.stringify(cat.tests.map((t) => [t.source, t.title, t.uid, t.uidSource]));

try {
  for (let i = 0; i < 200; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  token = (await api('/api/session'))[1].token;

  { // T1
    const p = await project({
      'tests/a.spec.ts': HEAD + "test('web case @TC-650', async () => { const w = 1; expect(w).toBe(1); });\n",
      'flows/a.yaml': '---\n- name: Login\n  steps:\n    - tapOn: "Login"\n',
    });
    await p.discover();
    p.write({
      'tests/a.spec.ts': HEAD + "test('web case', async () => { const w = 1; expect(w).toBe(1); });\n",
      'flows/a.yaml': '---\n- name: "Login @TC-650"\n  steps:\n    - tapOn: "Login"\n',
    });
    const c = await p.discover();
    report('T1-N2-cross-rev', dups(c).length > 0, `discovery=${c.discovery} ${show(c)} duplicates=${JSON.stringify(dups(c))}`);
  }
  { // T2
    const p = await project({
      'tests/a.spec.ts': HEAD + "test('web case', async () => { const w = 1; expect(w).toBe(1); });\n",
      'flows/a.yaml': '---\n- name: "Login @TC-600"\n  steps:\n    - tapOn: "Login"\n',
    });
    await p.discover();
    p.write({
      'tests/a.spec.ts': HEAD + "test('web case @TC-600', async () => { const w = 1; expect(w).toBe(1); });\n",
      'flows/a.yaml': '---\n- name: Login\n  steps:\n    - tapOn: "Login"\n',
    });
    const c = await p.discover();
    report('T2-N2-cross', dups(c).length > 0, `discovery=${c.discovery} ${show(c)} duplicates=${JSON.stringify(dups(c))}`);
  }
  { // T4 control: the same move between two WEB tests (no mobile case involved).
    const p = await project({
      'tests/a.spec.ts': HEAD + "test('web one @TC-670', async () => { const a = 1; expect(a).toBe(1); });\ntest('web two', async () => { const b = 2; expect(b).toBe(2); });\n",
    });
    await p.discover();
    p.write({
      'tests/a.spec.ts': HEAD + "test('web one', async () => { const a = 1; expect(a).toBe(1); });\ntest('web two @TC-670', async () => { const b = 2; expect(b).toBe(2); });\n",
    });
    const c = await p.discover();
    console.log(`T4-web-only-control ${dups(c).length ? 'duplicate' : 'no duplicate'} :: discovery=${c.discovery} ${show(c)}`);
  }
  { // T3
    const p = await project({
      'tests/a.spec.ts': HEAD + "test('web login @TC-100', async () => { const w = 1; expect(w).toBe(1); });\n",
      'flows/a.yaml': '---\n- name: "mobile login @TC-100"\n  steps:\n    - tapOn: "x"\n',
    });
    const c = await p.discover();
    const bound = c.tests.filter((t) => t.uid === 'tc-100');
    report('T3-E12-both-unbound', dups(c).length > 0 || bound.length > 0,
      `discovery=${c.discovery} ${show(c)} bound-to-tc-100=${JSON.stringify(bound.map((t) => t.source))} duplicates=${JSON.stringify(dups(c))}`);
  }
} finally {
  cp.kill();
  await new Promise((r) => setTimeout(r, 300));
}
console.log(held ? `RESULT: ${held} counterexample(s) hold` : 'RESULT: OK');
process.exitCode = held ? 1 : 0;
