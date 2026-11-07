// ATS-209 review round 2 probe (Opus).
//
// This is the probe the ROUND 2 REVIEW used against dev db3a80b, kept in
// the repository so that the round-3 acceptance can be reproduced: it
// measures the two properties that round 2 found broken -- a manifest
// entry that leaves the run folder through a directory junction (J1) and
// a cleaning record that a second cleaning overwrites (M1) -- against a
// real CLI, and it is expected to print RESULT: OK.
//
// usage: node r2.mjs <tree> <scratch>      (<scratch> is wiped)
// Each check prints "ok" (the property holds) or "DEFECT". Exit code = number of DEFECT lines.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const tree = path.resolve(process.argv[2]);
const scratch = path.resolve(process.argv[3]);
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
const M = await import(pathToFileURL(path.join(tree, 'server/evidence/manifest.mjs')));
const CLI = path.join(tree, 'tools/evidence_retention.mjs');
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
let defects = 0;
const line = (good, id, msg) => { if (!good) defects += 1; console.log(`${good ? 'ok    ' : 'DEFECT'} ${id}: ${msg}`); };
const OLD = '2020-01-01T00:00:00.000Z';
const NOW = new Date().toISOString();
const idOf = (c) => 'run_1_' + c.repeat(24);

function dataDir(name, runs) {
  const d = path.join(scratch, name);
  fs.mkdirSync(path.join(d, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ schema: 1, projects: [], runs }));
  for (const r of runs) fs.mkdirSync(path.join(d, 'runs', r.id), { recursive: true });
  return d;
}
const entry = (folder, file) => ({ file, size: fs.statSync(path.join(folder, file)).size, sha256: M.sha256OfFile(path.join(folder, file)) });

// ---------------------------------------------------------------- J1
// The E3 fix checks the entry LEXICALLY. A directory junction inside the run
// folder is lexically inside, but rm follows it. The runner writes this
// folder (outputDir), and an interrupted run never gets a Bridge manifest.
console.log('--- J1: manifest entry through a directory junction inside the run folder ---');
{
  const A = idOf('a'); const B = idOf('b');
  const d = dataDir('j1', [
    { id: A, status: 'interrupted', createdAt: OLD, finishedAt: OLD },
    { id: B, status: 'passed', createdAt: NOW, finishedAt: NOW },
  ]);
  fs.writeFileSync(path.join(d, 'runs', B, 'events.jsonl'), '{"seq":1}\n');
  fs.symlinkSync(d, path.join(d, 'runs', A, 'lnk'), 'junction');
  fs.writeFileSync(path.join(d, 'runs', A, 'manifest.json'), JSON.stringify({ version: 2, artifacts: [
    { file: 'lnk/state.json', size: 1, sha256: 'x' },
    { file: `lnk/runs/${B}/events.jsonl`, size: 1, sha256: 'x' },
  ] }));
  const r = cli('clean', '--data-dir', d, '--days', '30', '--yes');
  const stateKept = fs.existsSync(path.join(d, 'state.json'));
  const eventsKept = fs.existsSync(path.join(d, 'runs', B, 'events.jsonl'));
  line(stateKept && eventsKept, 'J1', `exit=${r.status}; state.json kept=${stateKept}; ${B}/events.jsonl (not expired) kept=${eventsKept}; refused lines=${(r.stdout.match(/refused:/g) || []).length}`);
}

// ---------------------------------------------------------------- J2
console.log('--- J2: the run\'s results/ is a junction to another run ---');
{
  const A = idOf('c'); const B = idOf('d');
  const d = dataDir('j2', [
    { id: A, status: 'interrupted', createdAt: OLD, finishedAt: OLD },
    { id: B, status: 'passed', createdAt: NOW, finishedAt: NOW },
  ]);
  fs.writeFileSync(path.join(d, 'runs', B, 'events.jsonl'), '{"seq":1}\n');
  fs.writeFileSync(path.join(d, 'runs', B, 'report.json'), '{}');
  fs.symlinkSync(path.join(d, 'runs', B), path.join(d, 'runs', A, 'results'), 'junction');
  const r = cli('clean', '--data-dir', d, '--days', '30', '--yes');
  const eventsKept = fs.existsSync(path.join(d, 'runs', B, 'events.jsonl'));
  const reportKept = fs.existsSync(path.join(d, 'runs', B, 'report.json'));
  line(eventsKept && reportKept, 'J2', `exit=${r.status}; ${B}/events.jsonl kept=${eventsKept}; ${B}/report.json kept=${reportKept}`);
}

// ---------------------------------------------------------------- M1
// The cleaned-marker is rewritten with only the files removed by the LATEST
// cleaning. A second cleaning that removes anything (a file added later, or
// one that was locked the first time) erases the record of the first.
console.log('--- M1: a second cleaning that removes something ---');
{
  const C = idOf('e');
  const d = dataDir('m1', [{ id: C, status: 'passed', createdAt: OLD, finishedAt: OLD }]);
  const f = path.join(d, 'runs', C);
  fs.writeFileSync(path.join(f, 'report.json'), '{"a":1}');
  fs.mkdirSync(path.join(f, 'html'));
  fs.writeFileSync(path.join(f, 'html', 'index.html'), '<h1>r</h1>');
  fs.writeFileSync(path.join(f, 'events.jsonl'), '{"seq":1}\n');
  fs.writeFileSync(path.join(f, 'manifest.json'), JSON.stringify({ version: 2, runId: C, artifacts: [entry(f, 'html/index.html'), entry(f, 'report.json')], evidence: { truncated: false } }));
  const c1 = cli('clean', '--data-dir', d, '--days', '30', '--yes');
  const v1 = cli('verify', '--data-dir', d);
  console.log(`info   clean #1 exit=${c1.status}; verify exit=${v1.status}; marker=${fs.readFileSync(path.join(f, M.CLEANED_MARKER_FILENAME), 'utf8').replace(/\s+/g, ' ')}`);
  fs.writeFileSync(path.join(f, 'late-note.txt'), 'added after the first cleaning');
  const c2 = cli('clean', '--data-dir', d, '--days', '30', '--yes');
  const v2 = cli('verify', '--data-dir', d);
  const marker = fs.readFileSync(path.join(f, M.CLEANED_MARKER_FILENAME), 'utf8').replace(/\s+/g, ' ');
  line(v2.status === 0, 'M1', `after a second cleaning, the files removed by the first are still explained; clean #2 exit=${c2.status}; verify exit=${v2.status}; marker=${marker}; verify says: ${JSON.stringify(v2.stdout.trim().split('\n').filter((l) => /missing|not matching/.test(l)))}`);
}

// ---------------------------------------------------------------- T1
console.log('--- T1: a run folder above the entry limit fails closed ---');
{
  const f = path.join(scratch, 't1');
  fs.mkdirSync(path.join(f, 'html', 'data'), { recursive: true });
  for (let i = 0; i < 450; i++) fs.writeFileSync(path.join(f, 'html', 'data', `s${String(i).padStart(3, '0')}.png`), `png ${i}`);
  fs.writeFileSync(path.join(f, 'report.json'), '{}');
  const man = M.buildManifest({ id: idOf('f'), status: 'passed' }, f);
  fs.writeFileSync(path.join(f, 'manifest.json'), JSON.stringify(man));
  const covered = man.artifacts.some((a) => a.file === 'report.json');
  fs.writeFileSync(path.join(f, 'report.json'), '{"tampered":true}');
  const v = M.verifyEvidence(f);
  line(covered || (v.verified === false && v.truncated === true), 'T1', `report.json covered=${covered}; manifest truncated=${man.evidence.truncated}; after tampering report.json verified=${v.verified} truncated=${v.truncated} reason=${JSON.stringify(v.reason)}`);
}

console.log(`\nRESULT: ${defects === 0 ? 'OK' : 'DEFECTS'} -- ${defects} defect(s)`);
process.exit(defects);
