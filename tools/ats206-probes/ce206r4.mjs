#!/usr/bin/env node
// ATS-206 review probe (round 4): the recovery branches that refuse, and the
// lock under a REAL kill.
//
// usage: node ce206r4.mjs <tree-root> <scratch-dir>        exit 1 when any counterexample holds.
//
// Every case prints facts and a verdict line; exit 1 when any counterexample holds.
//
// The states are GENUINE v0.1 shape: schema 1, proj_<uuid>/run_<uuid>, no
// uidRegistry / trust / attempts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TREE = path.resolve(process.argv[2] ?? '.');
const SCR = path.resolve(process.argv[3] ?? './ce206r4-scratch');
const CLI = path.join(TREE, 'tools', 'migrate_state.mjs');
const APPLY = pathToFileURL(path.join(TREE, 'server', 'migration', 'apply.mjs')).href;
fs.rmSync(SCR, { recursive: true, force: true });
fs.mkdirSync(SCR, { recursive: true });

let failures = 0;
const verdict = (name, holds, why) => {
  if (holds) failures++;
  console.log(`VERDICT ${name}: ${holds ? 'COUNTEREXAMPLE HOLDS' : 'ok'} -- ${why}`);
};
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const cli = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

function mkData(name, nRuns = 2) {
  const dir = path.join(SCR, name);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  const pid = `proj_${crypto.randomUUID()}`;
  const st = { schema: 1, projects: [{ id: pid, name: 'app', root: path.join(dir, 'app'), addedAt: '2026-01-01T00:00:00.000Z' }], runs: [] };
  for (let i = 0; i < nRuns; i++) {
    const t = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
    st.runs.unshift({ id: `run_${crypto.randomUUID()}`, projectId: pid, projectName: 'app', file: `tests/a-${i}.spec.ts`, gitCommit: 'abc1234', status: 'passed', createdAt: t, startedAt: t, finishedAt: t, eventSeq: 3, log: '', summary: null, artifacts: [] });
  }
  const text = JSON.stringify(st, null, 2);
  fs.writeFileSync(path.join(dir, 'state.json'), text);
  for (const r of st.runs) { fs.mkdirSync(path.join(dir, 'runs', r.id), { recursive: true }); fs.writeFileSync(path.join(dir, 'runs', r.id, 'report.json'), '{}'); }
  return { dir, st, text };
}

// A migration that is killed at the first run-folder rename: the state file
// is written, the journal records "state" and "folders", the folders are
// still named after the old ones.
function killAtFirstRename(dir) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep)) process.exit(137);
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(APPLY)});
    applyMigration(${JSON.stringify(dir)}, {});
  `], { encoding: 'utf8' });
}

console.log('\n=== R4-1: the recovery whose rename fails (EBUSY) must refuse, keep the journal, and rollback restores v0.1 ===');
{
  const { dir, st, text } = mkData('r4-ebusy', 3);
  killAtFirstRename(dir);
  const journalKeptBefore = fs.existsSync(path.join(dir, '.migration-journal.json'));

  // A preload module that makes the SECOND rename of a run folder throw
  // EBUSY -- the first one goes through, so the directory is left
  // half-renamed.
  const preload = path.join(SCR, 'ebusy-preload.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
const RUNS = ${JSON.stringify(path.join(dir, 'runs') + path.sep)};
let seen = 0;
const orig = fs.renameSync;
fs.renameSync = (a, b, ...rest) => {
  const from = String(a), to = String(b);
  if (from.startsWith(RUNS) || to.startsWith(RUNS)) {
    seen++;
    if (seen === 2) {
      const e = new Error('EBUSY: resource busy or locked');
      e.code = 'EBUSY';
      throw e;
    }
  }
  return orig(a, b, ...rest);
};
`, 'utf8');

  const a = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, CLI, 'apply', '--data-dir', dir], { encoding: 'utf8' });
  const output = a.stdout + a.stderr;
  const journalKept = fs.existsSync(path.join(dir, '.migration-journal.json'));
  const claimsUndone = /UNDONE/.test(output);
  const namesEbusy = /EBUSY/.test(output);
  console.log(`journal on disk before the recovery: ${journalKeptBefore}`);
  console.log(`recovery exit ${a.status}; UNDONE claimed: ${claimsUndone}; names the failure: ${namesEbusy}; journal kept: ${journalKept}`);
  console.log(`  ${output.trim().split('\n').filter((l) => /interrupted|EBUSY|rollback/i.test(l)).join(' | ').slice(0, 400)}`);

  const r = cli(['rollback', '--data-dir', dir]);
  const back = read(path.join(dir, 'state.json')) === text;
  const legacy = st.runs.filter((x) => fs.existsSync(path.join(dir, 'runs', x.id))).length;
  console.log(`then rollback exit ${r.code}; state back to v0.1: ${back}; legacy folders: ${legacy}/${st.runs.length}`);

  const ok = a.status !== 0 && journalKept && !claimsUndone && namesEbusy
    && r.code === 0 && back && legacy === st.runs.length;
  verdict('R4-1', !ok, 'a recovery whose rename fails must refuse, keep the journal, and the rollback must restore v0.1');
}

console.log('\n=== R4-2: a journal that says "state" over an UNMIGRATED state file must be refused, journal kept ===');
{
  const { dir, text } = mkData('r4-unresolved', 2);
  fs.writeFileSync(path.join(dir, '.migration-journal.json'), JSON.stringify({
    steps: ['state'],
    renamedFolders: [],
    backups: [path.join(dir, 'state.json')],
    appliedDigest: null,
    appliedIdentityDigest: null,
    statePath: path.join(dir, 'state.json'),
  }, null, 2), 'utf8');

  const a = cli(['apply', '--data-dir', dir]);
  const journalKept = fs.existsSync(path.join(dir, '.migration-journal.json'));
  const untouched = read(path.join(dir, 'state.json')) === text;
  const refused = /could not be resolved automatically/.test(a.out);
  console.log(`apply exit ${a.code}; refused: ${refused}; journal kept: ${journalKept}; state untouched: ${untouched}`);
  console.log(`  ${a.out.trim().split('\n').filter((l) => /interrupted|resolved|rollback/i.test(l)).join(' | ').slice(0, 400)}`);

  const ok = a.code !== 0 && refused && journalKept && untouched;
  verdict('R4-2', !ok, 'an interrupted migration whose state file is not migrated must be refused, with the journal kept and nothing written');
}

console.log('\n=== R4-3: a SIGKILL leaves a STALE lock; the next run takes it over and holds the lock for every data write ===');
{
  const { dir, st, text } = mkData('r4-sigkill', 2);
  // SIGKILL == TerminateProcess on Windows: the exit handlers do NOT run.
  const k = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep)) {
        console.log('ABOUT TO BE KILLED');
        process.kill(process.pid, 'SIGKILL');
        console.log('STILL ALIVE');
      }
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(APPLY)});
    applyMigration(${JSON.stringify(dir)}, {});
  `], { encoding: 'utf8' });
  const lockLeft = fs.existsSync(path.join(dir, 'bridge.lock'));
  const reallyKilled = /ABOUT TO BE KILLED/.test(k.stdout) && !/STILL ALIVE/.test(k.stdout);
  console.log(`killed: status=${k.status} really killed: ${reallyKilled}; lock file left behind: ${lockLeft}`);

  // The next run takes the stale lock over. The takeover's own operations on
  // the lock file happen BEFORE the new lock is published, so they are not
  // counted; every DATA write has to be under the new lock.
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import path from 'node:path';
    const lock = path.join(${JSON.stringify(dir)}, 'bridge.lock');
    const held = () => { try { return JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid; } catch { return false; } };
    const seen = [];
    for (const fn of ['renameSync', 'copyFileSync', 'rmSync', 'writeFileSync']) {
      const orig = fs[fn];
      fs[fn] = (a, ...rest) => {
        const A = String(a);
        if (!A.includes('bridge.lock') && !A.includes('migration-')) seen.push([fn, path.basename(A), held()]);
        return orig(a, ...rest);
      };
    }
    const { applyMigration } = await import(${JSON.stringify(APPLY)});
    const rep = applyMigration(${JSON.stringify(dir)}, {});
    console.log(JSON.stringify({ ok: rep.ok, problems: rep.problems, seen }));
  `], { encoding: 'utf8' });
  const res = JSON.parse(probe.stdout.trim().split('\n').pop());
  const allHeld = res.seen.length > 0 && res.seen.every((s) => s[2]);
  const staleLeft = fs.readdirSync(dir).filter((n) => n.includes('.stale-'));
  console.log(`recovery ok: ${res.ok}; data writes during the recovery: ${JSON.stringify(res.seen)}`);
  console.log(`stale lock files left behind: ${JSON.stringify(staleLeft)}`);

  const r = cli(['rollback', '--data-dir', dir]);
  const back = read(path.join(dir, 'state.json')) === text;
  const legacy = st.runs.filter((x) => fs.existsSync(path.join(dir, 'runs', x.id))).length;
  console.log(`then rollback exit ${r.code}; state back to v0.1: ${back}; legacy folders: ${legacy}/${st.runs.length}`);

  const ok = reallyKilled && lockLeft && allHeld && staleLeft.length === 0
    && r.code === 0 && back && legacy === st.runs.length;
  verdict('R4-3', !ok, 'a SIGKILL leaves a stale lock; the next run takes it over and every data write happens under the new lock');
}

console.log(`\n${failures} counterexample(s) hold`);
process.exit(failures ? 1 : 0);
