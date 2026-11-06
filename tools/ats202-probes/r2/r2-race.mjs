// ATS-202 round-2 reviewer probe (Opus): does an AWAITED listing overwrite registry writes made while it was running?
// Usage: node r2-race.mjs <tree-root> <node_modules-with-@playwright/test-1.64.1> <scratch-dir>   (exit 1 on FAIL)
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [tree, nm, scratch] = process.argv.slice(2).map((p) => path.resolve(p));
const tag = `r2race-${process.pid}`;
const data = path.join(scratch, `${tag}-data`);
function project(name, slowMs) {
  const root = path.join(scratch, `${tag}-${name}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.cpSync(nm, path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), `{"name":"${name}","private":true}`);
  fs.writeFileSync(path.join(root, 'playwright.config.ts'), [
    "import { defineConfig } from '@playwright/test';",
    slowMs ? `const end = Date.now() + ${slowMs}; while (Date.now() < end) {}` : '',
    "export default defineConfig({ testDir: './tests' });", ''].join('\n'));
  fs.writeFileSync(path.join(root, 'tests', `${name}.spec.ts`), `import { test } from '@playwright/test';\ntest('${name} one', async () => {});\ntest('${name} two', async () => {});\n`);
  return root;
}
const rootA = project('alpha', 3000); // trusted, slow config -> long awaited listing
const rootB = project('bravo', 0);    // untrusted -> fast static discovery

const port = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const cp = spawn(process.execPath, ['server/index.mjs'], { cwd: tree, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
const token = (await (await fetch(base + '/api/session')).json()).token;
const api = async (ep, method = 'GET', payload) => {
  const r = await fetch(base + ep, { method, headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  return [r.status, await r.json()];
};
const regOf = () => JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).uidRegistry?.projects ?? {};
let exit = 1;
try {
  const A = (await api('/api/projects', 'POST', { path: rootA }))[1].project;
  const B = (await api('/api/projects', 'POST', { path: rootB }))[1].project;
  await api(`/api/projects/${A.id}/trust`, 'POST', { trust: 'trusted' });
  const uidA = A.uid ?? A.id, uidB = B.uid ?? B.id;

  const listingA = api(`/api/projects/${A.id}/tests`);           // awaited listing, ~3.5 s
  await new Promise((r) => setTimeout(r, 400));
  const [sb, catB] = await api(`/api/projects/${B.id}/tests`);    // static, answers at once
  const bAfterB = (regOf()[uidB]?.entries ?? []).length;
  const [sa, catA] = await listingA;
  const bAfterA = (regOf()[uidB]?.entries ?? []).length;
  const aAfterA = (regOf()[uidA]?.entries ?? []).length;
  console.log(`B GET /tests -> ${sb} ${catB.discovery}; A GET /tests -> ${sa} ${catA.discovery}`);
  console.log(`registry entries of B right after B's discovery : ${bAfterB}`);
  console.log(`registry entries of B after A's listing finished: ${bAfterA}   (A has ${aAfterA})`);
  const ok = bAfterB > 0 && bAfterA === bAfterB;
  console.log(`EXPECTED: A's listing must not erase the registry entries B wrote while A was being listed`);
  console.log(`VERDICT: ${ok ? 'OK' : 'FAIL (counterexample): lost update -- A wrote back a registry snapshot taken before its await'}`);
  exit = ok ? 0 : 1;
} finally {
  cp.kill();
  await new Promise((r) => setTimeout(r, 300));
  for (const d of [rootA, rootB, data]) fs.rmSync(d, { recursive: true, force: true });
  process.exitCode = exit;
}
