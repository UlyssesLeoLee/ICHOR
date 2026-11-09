// ATS-402 review round 1 — I1 over real HTTP + real Windows Credential Manager.
// Usage: ATS402_REAL_CREDENTIAL_STORE=1 node r1-race-http.mjs <tree> <scratch>
// Cleans every ATS:ai-test-studio:* target it created (fake secrets only).
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const tree = path.resolve(process.argv[2]);
const scratch = path.resolve(process.argv[3]);
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const targets = () => (spawnSync('cmdkey', ['/list'], { encoding: 'utf8' }).stdout.match(/ATS:ai-test-studio:cred_[0-9a-f]{24}/g) || []);
const before = new Set(targets());
const cp = spawn(process.execPath, ['server/index.mjs'], { cwd: tree, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: path.join(scratch, 'state') }, stdio: 'ignore' });
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 60)); }
  const token = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).token;
  const post = (name) => fetch(`http://127.0.0.1:${port}/api/security/credentials`, { method: 'POST', headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, secret: `sk-r1-fake-${name}` }) }).then((r) => r.status);
  const statuses = await Promise.all([post('race-a'), post('race-b'), post('race-c')]);
  const listed = (await (await fetch(`http://127.0.0.1:${port}/api/security/credentials`, { headers: { 'X-ATS-Token': token } })).json()).credentials;
  const created = targets().filter((t) => !before.has(t));
  const holds = statuses.every((s) => s === 201) && listed.length < created.length;
  console.log(`${holds ? 'HOLDS' : 'OK   '} I1-http three concurrent POST /api/security/credentials -- statuses=${statuses} index=${listed.length} osStoreEntries=${created.length} orphaned=${created.length - listed.length}`);
  for (const t of created) spawnSync('cmdkey', [`/delete:${t}`]);
  console.log(`cleanup: removed ${created.length} OS-store entries; remaining new=${targets().filter((t) => !before.has(t)).length}`);
} finally { cp.kill(); }
