// ATS-202 round-3 reviewer probe (Opus): does GET /tests persist the registry of a LEGACY project record (id proj_<uuid>, no uid field)?
// Usage: node r3-legacy.mjs <tree-root> <scratch-dir>   (exit 1 on FAIL). Static discovery only -- no Playwright needed.
import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path'; import { spawn } from 'node:child_process';
const [tree, scratch] = process.argv.slice(2).map((p) => path.resolve(p));
const root = path.join(scratch, `r3-legacy-${process.pid}`), data = path.join(scratch, `r3-legacy-data-${process.pid}`);
for (const d of [root, data]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'tests'), { recursive: true }); fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(root, 'tests', 'l.spec.ts'), "import { test } from '@playwright/test';\ntest('legacy one', async () => {});\n");
const legacyId = 'proj_11111111-2222-4333-8444-555555555555';
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ schema: 1, projects: [{ id: legacyId, name: 'legacy', root, createdAt: new Date().toISOString() }], runs: [] }));
const port = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const cp = spawn(process.execPath, ['server/index.mjs'], { cwd: tree, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`; let exit = 1;
try {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  const token = (await (await fetch(base + '/api/session')).json()).token;
  const st = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  console.log(`project record after boot: ${JSON.stringify(st.projects.map((p) => ({ id: p.id, uid: p.uid })))}`);
  const id = st.projects[0].uid || st.projects[0].id;
  const r = await fetch(`${base}/api/projects/${id}/tests`, { headers: { 'X-ATS-Token': token } }); const cat = await r.json();
  const reg = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).uidRegistry?.projects ?? {};
  const n = (reg[cat.projectUid]?.entries ?? []).length;
  console.log(`GET /tests -> ${r.status} discovery=${cat.discovery} projectUid=${cat.projectUid} tests=${cat.tests?.length}; registry slots=${JSON.stringify(Object.keys(reg))}; entries under projectUid=${n}`);
  exit = r.status === 200 && n > 0 ? 0 : 1;
  console.log(`VERDICT: ${exit === 0 ? 'OK' : 'FAIL (counterexample): the registry of this project was not persisted'}`);
} finally { cp.kill(); await new Promise((r) => setTimeout(r, 300)); for (const d of [root, data]) fs.rmSync(d, { recursive: true, force: true }); process.exitCode = exit; }
