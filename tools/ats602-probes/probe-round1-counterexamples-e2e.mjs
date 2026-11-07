// ATS-602 round-1 review probe, real Bridge over HTTP (Opus).
// Usage: node r1-e2e.mjs <tree> <playwright-node_modules> <scratch>
// Exit 1 while any E* counterexample holds.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tree = path.resolve(process.argv[2]);
const nm = path.resolve(process.argv[3]);
const scratch = path.resolve(process.argv[4]);
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const data = path.join(scratch, 'data');
const fx = path.join(scratch, 'project');
const w = (rel, body) => { const f = path.join(fx, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body, 'utf8'); };
w('package.json', '{"name":"opus494","private":true}');
w('playwright.config.ts', "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n");
w('tests/a.spec.ts', "import { test } from '@playwright/test';\ntest('web login @TC-100', async () => {});\n");
const FLOW = 'appId: com.example.app\n---\n- name: Old title\n  steps:\n    - launchApp\n    - tapOn: "Login"\n- name: "mobile dup @TC-100"\n  steps:\n    - tapOn: "x"\n';
w('flows/login.yaml', FLOW);
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

  const [, c1] = await api(`/api/projects/${pid}/tests`);
  const m1 = c1.tests.find((t) => t.source === 'mobile' && t.title === 'Old title');
  const uids = c1.tests.map((t) => t.uid);
  const dups = [...new Set(uids.filter((u, i) => uids.indexOf(u) !== i))];
  report('E12-http', dups.length > 0, `discovery=${c1.discovery} uids=${JSON.stringify(c1.tests.map((t) => [t.source, t.uid]))} duplicates=${JSON.stringify(dups)}`);

  fs.writeFileSync(path.join(fx, 'flows/login.yaml'), FLOW.replace('Old title', 'New title'), 'utf8');
  const [, c2] = await api(`/api/projects/${pid}/tests`);
  const m2 = c2.tests.find((t) => t.source === 'mobile' && t.title === 'New title');
  report('E11-http', m1.uid !== m2.uid, `retitle over HTTP: ${m1.uid}/${m1.uidSource} -> ${m2.uid}/${m2.uidSource}`);

  const [ts] = await api(`/api/projects/${pid}/trust`, 'POST', { trust: 'trusted', reason: 'opus probe' });
  const [, c3] = await api(`/api/projects/${pid}/tests`);
  const mobile3 = c3.tests.filter((t) => t.source === 'mobile').length;
  report('E14-http', c3.discovery === 'authoritative' && (mobile3 === 0 || !c3.mobile),
    `trust POST=${ts}; discovery=${c3.discovery} outcome=${c3.authoritative?.outcome} mobile cases=${mobile3} mobile section=${c3.mobile ? 'present' : 'absent'} (untrusted catalogue had ${c2.tests.filter((t) => t.source === 'mobile').length})`);
} finally {
  cp.kill();
  await new Promise((r) => setTimeout(r, 300));
}
console.log(held ? `RESULT: ${held} counterexample(s) hold` : 'RESULT: OK');
process.exitCode = held ? 1 : 0;
