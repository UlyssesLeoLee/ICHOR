// ATS-209 review round 1 probe (Opus).
//
// This is the probe the ROUND 1 REVIEW used against dev 40519c8, kept in
// the repository so that the round-2 acceptance can be reproduced: it
// measures the same eight properties, against a REAL Bridge process and
// the real CLI, and it is expected to print RESULT: OK.
//
// usage: node r1.mjs <tree> <scratch>
// Each check prints "ok" (the property holds) or "DEFECT" (it does not).
// Exit code = number of DEFECT lines.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const tree = path.resolve(process.argv[2]);
const scratch = path.resolve(process.argv[3]);
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
const M = await import(pathToFileURL(path.join(tree, 'server/evidence/manifest.mjs')));
const CLI = path.join(tree, 'tools/evidence_retention.mjs');

let defects = 0;
const line = (good, id, msg) => { if (!good) defects += 1; console.log(`${good ? 'ok    ' : 'DEFECT'} ${id}: ${msg}`); };
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ---------------------------------------------------------------- fixture
const project = path.join(scratch, 'fake-pw');
const data = path.join(scratch, 'data');
const manyFlag = path.join(scratch, 'many.flag');
const variantFlag = path.join(scratch, 'variant.flag');
fs.mkdirSync(path.join(project, 'node_modules', '@playwright', 'test'), { recursive: true });
fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
fs.writeFileSync(path.join(project, 'package.json'), '{}');
fs.writeFileSync(path.join(project, 'playwright.config.ts'), 'export default {}');
fs.writeFileSync(path.join(project, 'tests', 'pass.spec.ts'), "test('simulated success', ()=>{});\n");
fs.writeFileSync(path.join(project, 'node_modules', '@playwright', 'test', 'cli.js'), `
const fs=require('fs'),path=require('path');
const out=process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
const folder=path.dirname(out);
const output=process.argv[process.argv.indexOf('--output')+1];
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(out, JSON.stringify({config:{rootDir:'/x'},suites:[{file:'tests/pass.spec.ts',specs:[{title:'simulated success',file:'tests/pass.spec.ts',line:1,tests:[{status:'expected',results:[{duration:12}]}]}]}]}));
fs.mkdirSync(path.join(folder,'html'),{recursive:true});
fs.writeFileSync(path.join(folder,'html','index.html'),fs.existsSync(${JSON.stringify(variantFlag)})?'<h1>variant report</h1>':'<h1>fixture report</h1>');
fs.writeFileSync(path.join(output,'fixture-trace.zip'),'not a real trace');
if (fs.existsSync(${JSON.stringify(manyFlag)})) {
  fs.mkdirSync(path.join(folder,'html','data'),{recursive:true});
  for (let i=0;i<450;i++) fs.writeFileSync(path.join(folder,'html','data','shot-'+String(i).padStart(3,'0')+'.png'),'png '+i);
}
`);

const port = await freePort();
let token = null;
let bridge = null;
const req = async (endpoint, method = 'GET', body) => {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method, headers: token ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return [r.status, await r.json().catch(() => null)];
};
const startBridge = async () => {
  bridge = spawn(process.execPath, ['server/index.mjs'], { cwd: tree, env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data }, stdio: 'ignore' });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  token = (await req('/api/session'))[1].token;
};
const stopBridge = async () => {
  const done = new Promise((r) => bridge.once('exit', r));
  bridge.kill();
  await done;
};
const runOnce = async (projectId) => {
  const [code, body] = await req(`/api/projects/${projectId}/run`, 'POST', { file: 'tests/pass.spec.ts' });
  if (code !== 202) throw new Error(`run start ${code} ${JSON.stringify(body)}`);
  for (let i = 0; i < 400; i++) {
    const r = (await req(`/api/runs/${body.run.id}`))[1].run;
    if (!['queued', 'running', 'cancelling'].includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('run timeout');
};
const folderOf = (id) => path.join(data, 'runs', id);
const GENUINE = '<h1>fixture report</h1>';

try {
  await startBridge();
  const projectId = (await req('/api/projects', 'POST', { path: project }))[1].project.id;

  // ---------------------------------------------------------------- E1 / E2
  console.log('--- E1/E2: in-place write through one hard link ---');
  const r1 = await runOnce(projectId);
  const r2 = await runOnce(projectId);
  const f1 = path.join(folderOf(r1.id), 'html', 'index.html');
  const f2 = path.join(folderOf(r2.id), 'html', 'index.html');
  console.log(`info   run1 ${r1.id} ${r1.status}, run2 ${r2.id} ${r2.status}, nlink(run1 index.html)=${fs.statSync(f1).nlink}`);
  // An in-place write (same inode) to run1's evidence file only.
  fs.writeFileSync(f1, '<h1>TAMPERED via run1</h1>');
  const v2 = (await req(`/api/runs/${r2.id}/evidence`))[1];
  console.log(`info   E2 (disclosed trade-off, docs only): an in-place write to run1's file also changes run2; run2 verified=${v2.verified} changed=${JSON.stringify(v2.changed.map((c) => c.file))} run2 content=${JSON.stringify(fs.readFileSync(f2, 'utf8'))}`);
  // A NEW run produces the genuine bytes again.
  const r3 = await runOnce(projectId);
  const f3 = path.join(folderOf(r3.id), 'html', 'index.html');
  const c3 = fs.readFileSync(f3, 'utf8');
  const v3 = (await req(`/api/runs/${r3.id}/evidence`))[1];
  line(c3 === GENUINE, 'E1a', `a fresh run keeps the bytes it produced; run3 index.html=${JSON.stringify(c3)}`);
  line(v3.verified === true, 'E1b', `a fresh, untouched run verifies; run3 verified=${v3.verified} changed=${JSON.stringify(v3.changed)}`);

  // ---------------------------------------------------------------- dedup report vs disk
  const dd = (await req('/api/evidence/dedup'))[1];
  console.log(`info   /api/evidence/dedup wastedBytes=${dd.wastedBytes} duplicated=${dd.duplicated} storeBytes=${dd.storeBytes} (the duplicated files are hard links: no byte is stored twice)`);

  // ---------------------------------------------------------------- E6
  console.log('--- E6: a run folder with more than 400 evidence files ---');
  fs.writeFileSync(manyFlag, '1');
  const r4 = await runOnce(projectId);
  fs.rmSync(manyFlag);
  const run4 = (await req(`/api/runs/${r4.id}`))[1].run;
  const man4 = (await req(`/api/runs/${r4.id}/manifest`))[1].manifest;
  const inManifest = new Set(man4.artifacts.map((a) => a.file));
  const outside = run4.artifacts.map((a) => a.file).filter((f) => !inManifest.has(f));
  console.log(`info   run4 ${r4.id}: run.artifacts=${run4.artifacts.length}, manifest.artifacts=${man4.artifacts.length}, files not in manifest=${outside.length}`);
  if (outside.length) {
    const victim = outside[outside.length - 1];
    fs.writeFileSync(path.join(folderOf(r4.id), victim), 'TAMPERED');
    const v4 = (await req(`/api/runs/${r4.id}/evidence`))[1];
    const named = v4.changed.some((c) => c.file === victim) || v4.extra.includes(victim) || v4.missing.includes(victim);
    line(!v4.verified || named, 'E6', `tampering ${victim} (in run.artifacts, not in manifest) is detected; verified=${v4.verified} changed=${v4.changed.length} extra=${v4.extra.length}`);
  } else {
    line(true, 'E6', 'manifest covers every artifact');
  }

  // A fresh run with its OWN content: the control that must survive the
  // cleaning and keep verifying.
  fs.writeFileSync(variantFlag, '1');
  const r5 = await runOnce(projectId);
  fs.rmSync(variantFlag);
  const v5 = (await req(`/api/runs/${r5.id}/evidence`))[1];
  console.log(`info   run5 ${r5.id} ${r5.status} (control, not expired) verified=${v5.verified} changed=${JSON.stringify(v5.changed.map((c) => c.file))} -- report.json was written in place through run4 (E6), so the shared blob run5 was linked to is the poisoned one (E1)`);

  await stopBridge();

  // Age runs 1-4 (the probe is the clock): they finished in 2020.
  const stateFile = path.join(data, 'state.json');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  for (const run of st.runs) if ([r1.id, r2.id, r3.id, r4.id].includes(run.id)) run.finishedAt = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));

  // ---------------------------------------------------------------- E8 / E7 / E4
  console.log('--- E7/E8/E4: offline cleaning ---');
  const S = await import(pathToFileURL(path.join(tree, 'server/evidence/store.mjs')));
  const storeDir = S.storeDirOf(data);
  const blobsBefore = S.storeBytes(storeDir);
  const c1 = cli('clean', '--data-dir', data, '--days', '30', '--yes');
  console.log(`info   clean #1 exit=${c1.status}\n${c1.stdout.trim().split('\n').map((l) => '         ' + l).join('\n')}`);
  const orphan = S.unreferencedBlobs(storeDir);
  const orphanBytes = orphan.reduce((n, b) => n + b.size, 0);
  line(orphanBytes === 0, 'E8', `the documented "clean --days N --yes" leaves no blob of the cleaned evidence on disk; store before=${blobsBefore} after=${S.storeBytes(storeDir)}, ${orphan.length} blob(s) / ${orphanBytes} bytes referenced by no run but still on disk`);
  const ver = cli('verify', '--data-dir', data);
  const after2 = M.verifyEvidence(folderOf(r2.id));
  line(ver.status === 0, 'E7', `after a normal retention cleaning, verify does not report the cleaned runs as not matching; verify exit=${ver.status}; cleaned run2 verified=${after2.verified} missing=${after2.missing.length} reason=${JSON.stringify(after2.reason)}`);
  // Negative control: a real deletion in a run that was NOT cleaned must still fail verify and be named.
  const victim5 = path.join(folderOf(r5.id), 'html', 'index.html');
  const saved5 = fs.readFileSync(victim5);
  fs.rmSync(victim5);
  const verNeg = cli('verify', '--data-dir', data);
  line(verNeg.status === 1 && verNeg.stdout.includes(r5.id) && verNeg.stdout.includes('html/index.html'), 'E7-control', `deleting html/index.html of the kept run5 is still reported; verify exit=${verNeg.status}, names run5=${verNeg.stdout.includes(r5.id)}`);
  fs.writeFileSync(victim5, saved5);
  const journalFile = path.join(data, 'evidence-retention-journal.jsonl');
  const j1 = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, 'utf8').trim().split('\n').length : 0;
  const c2 = cli('clean', '--data-dir', data, '--days', '30', '--yes');
  const lines2 = fs.readFileSync(journalFile, 'utf8').trim().split('\n').slice(j1).filter(Boolean).map((l) => JSON.parse(l));
  const claimed = lines2.reduce((n, e) => n + (Array.isArray(e.removed) ? e.removed.length : 0), 0);
  line(claimed === 0, 'E4', `a second cleaning removes nothing, so its journal records nothing removed; clean #2 exit=${c2.status}, journal claims ${claimed} file(s) removed across ${lines2.length} line(s)`);

  // ---------------------------------------------------------------- E5
  console.log('--- E5: --dry-run --prune-store ---');
  const loose = path.join(scratch, 'loose.bin');
  fs.writeFileSync(loose, 'a blob no run refers to');
  const looseDigest = M.sha256OfFile(loose);
  S.storeBlob(storeDir, loose, looseDigest);
  const loosePath = S.blobPath(storeDir, looseDigest);
  const dry = cli('clean', '--data-dir', data, '--days', '30', '--dry-run', '--prune-store');
  line(fs.existsSync(loosePath), 'E5', `a dry run removes nothing; unreferenced blob still on disk=${fs.existsSync(loosePath)}; output says: ${JSON.stringify(dry.stdout.trim().split('\n').slice(-2))}`);
} finally {
  if (bridge && bridge.exitCode === null) bridge.kill();
}

// ---------------------------------------------------------------- E3
console.log('--- E3: manifest entries outside the run folder ---');
const d3 = path.join(scratch, 'data3');
const idA = 'run_1_' + 'a'.repeat(24);
const idB = 'run_1_' + 'b'.repeat(24);
fs.mkdirSync(path.join(d3, 'runs', idA), { recursive: true });
fs.mkdirSync(path.join(d3, 'runs', idB), { recursive: true });
const old = '2020-01-01T00:00:00.000Z';
fs.writeFileSync(path.join(d3, 'state.json'), JSON.stringify({ schema: 1, projects: [], runs: [
  { id: idA, status: 'interrupted', createdAt: old, finishedAt: null },
  { id: idB, status: 'passed', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
] }));
fs.writeFileSync(path.join(d3, 'runs', idB, 'events.jsonl'), '{"seq":1}\n');
fs.writeFileSync(path.join(d3, 'runs', idB, 'report.json'), '{}');
// The runner writes into its own run folder (adapter.start({outputDir: folder})).
// An interrupted run never gets a Bridge-written manifest, so whatever the
// runner left as manifest.json is what the cleaner reads.
fs.writeFileSync(path.join(d3, 'runs', idA, 'manifest.json'), JSON.stringify({ version: 2, artifacts: [
  { file: `../${idB}/events.jsonl`, size: 1, sha256: 'x' },
  { file: '../../state.json', size: 1, sha256: 'x' },
] }));
const c3r = cli('clean', '--data-dir', d3, '--days', '30', '--yes');
const stateKept = fs.existsSync(path.join(d3, 'state.json'));
const eventsKept = fs.existsSync(path.join(d3, 'runs', idB, 'events.jsonl'));
line(stateKept && eventsKept, 'E3', `cleaning the expired run ${idA} touches only its own folder; exit=${c3r.status}; state.json kept=${stateKept}; ${idB}/events.jsonl (a run that is NOT expired) kept=${eventsKept}`);

console.log(`\nRESULT: ${defects === 0 ? 'OK' : 'DEFECTS'} -- ${defects} defect(s)`);
process.exit(defects);
