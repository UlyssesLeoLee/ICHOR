// ATS-402 review round 1 — HTTP counterexample probe (reviewer-owned, read-only
// against the product tree). Usage:
//   node r1-http.mjs <tree> <scratch>
//   ATS402_REAL_CREDENTIAL_STORE=1 node r1-http.mjs <tree> <scratch>   (adds C-* cases)
// Each line prints HOLDS (the counterexample reproduces = defect) or OK.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const tree = path.resolve(process.argv[2]);
const scratch = path.resolve(process.argv[3]);
const REAL = process.env.ATS402_REAL_CREDENTIAL_STORE === '1';
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const port = await freePort();
const dataDir = path.join(scratch, 'state');
let cp; let token;
const results = [];
// NONBLOCK lines are reported but do not count towards RESULT.
const report = (id, holds, detail, nonblock = false) => { results.push({ id, holds, nonblock }); console.log(`${holds ? (nonblock ? 'NONBLOCK' : 'HOLDS') : 'OK   '} ${id} -- ${detail}`); };

async function api(endpoint, method = 'GET', payload) {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method, headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  let b; try { b = await r.json(); } catch { b = null; }
  return [r.status, b];
}
async function start() {
  cp = spawn(process.execPath, ['server/index.mjs'], { cwd: tree, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: dataDir }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 60)); }
  token = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).token;
}
const auditCount = async () => (await api('/api/security/egress/audit'))[1].audit.length;

function makeRepo(name) {
  const repo = path.join(scratch, name);
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.aitest'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{}');
  fs.writeFileSync(path.join(repo, 'playwright.config.ts'), 'export default {}');
  fs.writeFileSync(path.join(repo, 'tests', 'home.spec.ts'), "test('home', async () => {});\n");
  fs.writeFileSync(path.join(repo, '.aitest', 'requirements.json'), '{"requirements":[{"uid":"REQ-1","title":"t"}]}');
  return repo;
}
async function consentFor(projectId, inputs) {
  const [ps, pb] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
  if (ps !== 200) return { ps, pb };
  const [cs, cb] = await api('/api/security/egress/confirm', 'POST', { projectId, inputs, previewId: pb.preview.previewId, ...(inputs.ttl ? {} : {}) });
  return { ps, pb, cs, cb };
}

try {
  const repoA = makeRepo('repoA');
  const repoB = makeRepo('repoB');
  // Outside-the-project material for the escape cases.
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE-ROOT');
  // Directory junctions need no privilege on Windows.
  const mk = (link, target) => spawnSync('powershell.exe', ['-NoProfile', '-Command', `New-Item -ItemType Junction -Path '${link}' -Target '${target}' | Out-Null`]);
  mk(path.join(repoA, '.aitest', 'jn'), outside);
  mk(path.join(repoA, 'jn'), outside);

  await start();
  const A = (await api('/api/projects', 'POST', { path: repoA }))[1].project.id;
  const B = (await api('/api/projects', 'POST', { path: repoB }))[1].project.id;
  const fileIn = [{ kind: 'file', ref: 'tests/home.spec.ts' }];

  // H1 requirement kind: preview/confirm resolve <root>/.aitest/<ref>; the gate resolves <root>/<ref>.
  {
    const inputs = [{ kind: 'requirement', ref: 'requirements.json' }];
    const c = await consentFor(A, inputs);
    const [s, b] = await api('/api/security/egress/check', 'POST', { projectId: A, inputs, consentId: c.cb?.consent?.id });
    report('H1 requirement: preview->confirm->check must end in 200', s !== 200, `preview=${c.ps} confirm=${c.cs} check=${s} ${JSON.stringify(b)}`);
  }
  // H8 requirement path follows a junction out of the project root at preview/confirm time.
  {
    const inputs = [{ kind: 'requirement', ref: 'jn/secret.txt' }];
    const c = await consentFor(A, inputs);
    const it = c.pb?.preview?.scope?.items?.[0];
    report('H8 requirement preview/confirm reads a file outside the root via junction', c.ps === 200 && c.cs === 201, `preview=${c.ps} bytes=${it?.bytes} (outside file is 23 bytes) confirm=${c.cs}`);
  }
  // H2 run kind: preview/confirm resolve the run via getRun; the gate has no runResolver.
  {
    const [rs, rb] = await api(`/api/projects/${A}/run`, 'POST', {});
    const runId = rb?.run?.id;
    for (let i = 0; i < 100; i++) { const [, g] = await api(`/api/runs/${runId}`); if (g?.run && !['running', 'queued', 'cancelling'].includes(g.run.status)) break; await new Promise((r) => setTimeout(r, 200)); }
    const inputs = [{ kind: 'run', ref: runId }];
    const c = await consentFor(A, inputs);
    const before = await auditCount();
    const [s, b] = await api('/api/security/egress/check', 'POST', { projectId: A, inputs, consentId: c.cb?.consent?.id });
    const after = await auditCount();
    report('H2 run: preview->confirm->check must end in 200', s !== 200, `run=${rs} ${runId} preview=${c.ps} confirm=${c.cs} check=${s} ${JSON.stringify(b)} audit ${before}->${after}`);
  }
  // H3 valid consent + out-of-root ref: refused with 400, but NOT audited.
  const good = await consentFor(A, fileIn);
  const gid = good.cb.consent.id;
  for (const [label, inputs] of [
    ['dotdot', [{ kind: 'file', ref: '../outside/secret.txt' }]],
    ['junction', [{ kind: 'file', ref: 'jn/secret.txt' }]],
    ['absolute', [{ kind: 'file', ref: path.join(outside, 'secret.txt') }]],
    ['mixed', [...fileIn, { kind: 'file', ref: '../outside/secret.txt' }]],
  ]) {
    const before = await auditCount();
    const [s, b] = await api('/api/security/egress/check', 'POST', { projectId: A, inputs, consentId: gid });
    const after = await auditCount();
    report(`H3-${label} out-of-root egress with a valid consent is refused but leaves no audit record`, s !== 200 && after === before, `check=${s} ${JSON.stringify(b)} audit ${before}->${after}`);
  }
  // H4 a denial record carries no refs at all.
  {
    const [s] = await api('/api/security/egress/check', 'POST', { projectId: A, inputs: fileIn });
    const rec = (await api('/api/security/egress/audit'))[1].audit[0];
    report('H4 egress.denied record names no ref (code comment says it records the refs it was about to send)', s === 403 && rec.event === 'egress.denied' && rec.items.length === 0, `check=${s} items=${JSON.stringify(rec.items)} itemCount=${rec.itemCount}`);
  }
  // H5 audit eviction through the same API: 500 refused checks push the earlier grant out.
  {
    const [s] = await api('/api/security/egress/check', 'POST', { projectId: A, inputs: fileIn, consentId: gid });
    const grantRec = (await api('/api/security/egress/audit'))[1].audit[0];
    for (let i = 0; i < 500; i++) await api('/api/security/egress/check', 'POST', { projectId: A, inputs: fileIn });
    const trail = (await api('/api/security/egress/audit'))[1].audit;
    const still = trail.some((r) => r.id === grantRec.id);
    report('H5 500 refused checks evict an earlier egress.granted record from the trail', s === 200 && grantRec.event === 'egress.granted' && !still, `grant=${s} ${grantRec.id} present after flood=${still} trail=${trail.length}`);
  }
  // H6 an expired consent is still listed as state=granted.
  {
    const [ps, pb] = await api('/api/security/egress/preview', 'POST', { projectId: A, inputs: fileIn });
    const [cs, cb] = await api('/api/security/egress/confirm', 'POST', { projectId: A, inputs: fileIn, previewId: pb.preview.previewId, ttlSeconds: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    const listed = (await api('/api/security/egress/consents'))[1].consents.find((c) => c.id === cb.consent.id);
    const [s, b] = await api('/api/security/egress/check', 'POST', { projectId: A, inputs: fileIn, consentId: cb.consent.id });
    report('H6 expired consent still listed as state=granted (UI counts it as active and offers revoke)', ps === 200 && cs === 201 && listed.state === 'granted' && b?.error === 'EGRESS_CONSENT_EXPIRED', `list.state=${listed.state} check=${s} ${b?.error}`);
  }
  // H7 consent is not bound to a project.
  {
    const [s, b] = await api('/api/security/egress/check', 'POST', { projectId: B, inputs: fileIn, consentId: gid });
    report('H7 project A consent authorises the same ref+content in project B', s === 200, `check(B, consentOf A)=${s} ${b?.allowed}`, true);
  }
  // C-* need the real Windows Credential Manager.
  if (REAL) {
    // C1 a backend failure is answered 500 with a code outside the declared vocabulary (doc: UNAVAILABLE/FAILED -> 503).
    {
      const [s, b] = await api('/api/security/credentials', 'POST', { name: 'r1-oversize', secret: 'x'.repeat(3000) });
      const vocab = (await api('/api/security/contract'))[1].errorCodes;
      report('C1 credential backend failure -> HTTP 500 and an undeclared error code', s === 500 || !vocab.includes(b?.error), `status=${s} body=${JSON.stringify(b)} declared=${vocab.includes(b?.error)}`);
    }
    // C2 removing a credential whose OS-store entry is already gone leaves a stuck reference.
    {
      const [ps, pb] = await api('/api/security/credentials', 'POST', { name: 'r1-stuck', secret: 'sk-r1-fake-0001' });
      const id = pb?.credential?.id;
      const del = spawnSync('cmdkey', [`/delete:ATS:ai-test-studio:${id}`], { encoding: 'utf8' });
      const [ds, db] = await api(`/api/security/credentials/${id}`, 'DELETE');
      const still = (await api('/api/security/credentials'))[1].credentials.some((c) => c.id === id);
      report('C2 reference cannot be removed once the OS-store entry is gone', ps === 201 && ds !== 200 && still, `put=${ps} cmdkey=${del.status} delete=${ds} ${JSON.stringify(db)} stillListed=${still}`);
    }
  }
} finally {
  try { cp?.kill(); } catch {}
}
const held = results.filter((r) => r.holds && !r.nonblock).length;
console.log(`\nRESULT: ${held === 0 ? 'OK' : `${held} counterexample(s) hold`} (${results.length} checks)`);
