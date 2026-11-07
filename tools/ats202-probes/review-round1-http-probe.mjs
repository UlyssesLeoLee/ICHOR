/**
 * ATS-202: the round-1 review finding "the listing blocks the Bridge".
 *
 * The reviewer measured that the synchronous `--list` froze the whole
 * Bridge: with a config whose top level takes four seconds, `GET
 * /api/health` took 4233-4287 ms (2 ms when idle). This probe reproduces
 * the measurement against the CURRENT tree.
 *
 * Usage: node tools/ats202-probes/review-round1-http-probe.mjs [tree-root] <node_modules-with-@playwright/test>
 *
 * Exit 0 when the Bridge keeps answering while a project is listed, 1 when
 * it does not, 2 when the real Playwright is not available (SKIPPED).
 */
// Usage: node http202.mjs <tree-root> <node_modules-with-@playwright/test-1.64.1> <scratch-dir>
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [a, b] = process.argv.slice(2);
const tree = path.resolve(a && !a.includes('@playwright') && !fs.existsSync(path.join(a, '@playwright')) ? a : path.join(import.meta.dirname, '..', '..'));
const nm = path.resolve(a && !a.includes('@playwright') && !fs.existsSync(path.join(a, '@playwright')) ? b : a);
if (!nm || !fs.existsSync(path.join(nm, '@playwright', 'test'))) {
  console.error(`SKIPPED: ${nm ?? '(none)'} does not hold @playwright/test -- the probe needs the REAL Playwright CLI.`);
  console.error('usage: node review-round1-http-probe.mjs [tree-root] <node_modules-with-@playwright/test>');
  process.exit(2);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ats202-http-probe-'));
const SLOW_MS = 4000;
const root = path.join(scratch, `http202-${process.pid}`);
const data = path.join(scratch, `http202-data-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
fs.cpSync(nm, path.join(root, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), '{"name":"http202","private":true}');
// A config whose top level takes SLOW_MS (a slow import, a network probe, a big monorepo...).
fs.writeFileSync(path.join(root, 'playwright.config.ts'), [
  "import { defineConfig } from '@playwright/test';",
  `const end = Date.now() + ${SLOW_MS}; while (Date.now() < end) { /* slow config top level */ }`,
  "export default defineConfig({ testDir: './tests' });", ''].join('\n'));
fs.writeFileSync(path.join(root, 'tests', 'a.spec.ts'), "import { test } from '@playwright/test';\ntest('a', async () => {});\n");

const port = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const cp = spawn(process.execPath, ['server/index.mjs'], { cwd: tree, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
const token = (await (await fetch(base + '/api/session')).json()).token;
const api = async (ep, method = 'GET', payload) => {
  const r = await fetch(base + ep, { method, headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  return [r.status, await r.json()];
};
try {
  const [, reg] = await api('/api/projects', 'POST', { path: root });
  const id = reg.project.id;
  await api(`/api/projects/${id}/trust`, 'POST', { trust: 'trusted' });

  // Baseline health latency.
  let t = Date.now(); await fetch(base + '/api/health'); const idle = Date.now() - t;

  // Open the catalogue, and 300 ms later ask the Bridge for /api/health.
  const t0 = Date.now();
  const catalogue = api(`/api/projects/${id}/tests`).then(([s, b]) => ({ s, b, ms: Date.now() - t0 }));
  await new Promise((r) => setTimeout(r, 300));
  t = Date.now(); const h = await fetch(base + '/api/health'); const during = Date.now() - t;
  const c = await catalogue;
  console.log(`config top-level cost: ${SLOW_MS} ms`);
  console.log(`GET /tests -> ${c.s}, discovery=${c.b.discovery}, took ${c.ms} ms`);
  console.log(`GET /api/health idle latency: ${idle} ms`);
  console.log(`GET /api/health latency while the catalogue is listing: ${during} ms (status ${h.status})`);
  const ok = during < 1000;
  console.log(`EXPECTED: the Bridge keeps answering (< 1000 ms) while one project lists`);
  console.log(`VERDICT: ${ok ? 'OK' : 'FAIL (counterexample): the synchronous --list blocks the whole Bridge event loop'}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  cp.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
}
