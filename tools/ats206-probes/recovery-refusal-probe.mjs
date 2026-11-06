#!/usr/bin/env node
// ATS-206 recovery / stale-lock counterexample probe.
//
// The four counterexamples of the recovery rework (CE7, CE8, CE9, CE10),
// as executable checks against a given tree. It is the counterpart of the
// reviewer's `ce206r2.mjs`, and it exists because that probe's lock
// predicate ("the lock file names this process") does not survive ATS-207:
// the new lock implementation takes over a STALE lock by RENAMING it away,
// and those two renames are writes of the LOCK MECHANISM, not of the
// migration engine.
//
// So this probe asks the authoritative question instead: "does this process
// still hold the lock" -- which `server/core.mjs` answers with
// `verifyBridgeLock()` when the implementation offers it, and with the pid
// of the lock record otherwise. Writes of the lock mechanism itself are
// excluded, because they happen before the lock is held.
//
// Usage: node tools/ats206-probes/recovery-refusal-probe.mjs <tree-root> <scratch-dir>
// Exit 1 when any counterexample holds. The states are GENUINE v0.1 shapes:
// only `schema` / `projects` / `runs`, with uuid identifiers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TREE = path.resolve(process.argv[2] ?? '.');
const SCR = path.resolve(process.argv[3] ?? './ats206-recovery-scratch');
if (SCR.includes(`${path.sep}docs${path.sep}evidence`)) {
  console.error('the scratch directory must not live inside docs/evidence: it is not evidence.');
  process.exit(2);
}
const CLI = path.join(TREE, 'tools', 'migrate_state.mjs');
const UIDS = path.join(TREE, 'tools', 'migrate_uids.mjs');
const APPLY = pathToFileURL(path.join(TREE, 'server', 'migration', 'apply.mjs')).href;
const CORE = pathToFileURL(path.join(TREE, 'server', 'core.mjs')).href;

fs.rmSync(SCR, { recursive: true, force: true });
fs.mkdirSync(SCR, { recursive: true });

let failures = 0;
const verdict = (name, holds, why) => {
  if (holds) failures++;
  console.log(`VERDICT ${name}: ${holds ? 'COUNTEREXAMPLE HOLDS' : 'ok'} -- ${why}`);
};
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const cli = (tool, args) => {
  const r = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};

/**
 * A genuine v0.1 data directory: two projects, two runs, uuid identifiers,
 * and the run folders named after the legacy identifiers.
 */
function mkData(name, nRuns = 2) {
  const dir = path.join(SCR, name);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  const root = path.join(dir, 'app');
  const legacyProject = `proj_${crypto.randomUUID()}`;
  const state = {
    schema: 1,
    projects: [{
      id: legacyProject,
      name: 'app',
      root,
      addedAt: '2026-01-01T00:00:00.000Z',
    }],
    runs: Array.from({ length: nRuns }, (_, i) => ({
      id: `run_${crypto.randomUUID()}`,
      projectId: legacyProject,
      projectName: 'app',
      file: `tests/app-${i}.spec.ts`,
      gitCommit: 'abc1234',
      status: 'passed',
      createdAt: '2026-01-02T00:00:00.000Z',
      eventSeq: 1,
      log: 'ok\n',
      summary: { passed: 1, failed: 0, skipped: 0, flaky: 0, cases: [] },
      artifacts: [],
    })),
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  for (const r of state.runs) {
    fs.mkdirSync(path.join(dir, 'runs', r.id), { recursive: true });
  }
  return { dir, state };
}

/**
 * Runs a call in a child process and reports, for every destructive write
 * it does, whether the Bridge lock was HELD at that moment.
 */
function probe(lockDir, call) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const core = await import(${JSON.stringify(CORE)});
    const lock = core.lockPath(${JSON.stringify(lockDir)});
    const seen = [];
    // The authoritative question: does THIS process still hold the lock?
    const held = () => {
      if (typeof core.verifyBridgeLock === 'function') {
        return core.verifyBridgeLock(lock).held === true;
      }
      try { return JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid; }
      catch { return false; }
    };
    // EVERY rename, copy and delete is counted -- including the lock's
    // own. The lock is published before it is held, so an engine that
    // leaves a stale lock behind (a killed migration does) makes the next
    // run take it over, and the takeover writes the lock file before the
    // new lock is published.
    for (const fn of ['renameSync', 'copyFileSync', 'rmSync']) {
      const orig = fs[fn];
      fs[fn] = (a, ...rest) => {
        if (!String(a).endsWith('.tmp')
            && !String(a).includes('migration-')) seen.push(held());
        return orig(a, ...rest);
      };
    }
    const m = await import(${JSON.stringify(APPLY)});
    ${call};
    console.log(JSON.stringify(seen));
  `], { encoding: 'utf8' });
  const line = (r.stdout ?? '').trim().split('\n').pop() ?? '[]';
  return JSON.parse(line);
}

const held = (x) => x.length > 0 && x.every(Boolean);

// ---------------------------------------------------------------------------
console.log('\n=== CE7: migrate -> rollback -> v0.1 keeps working -> migrate again -> rollback ===');
{
  const { dir, state } = mkData('ce7', 2);
  const v01 = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');

  let r = cli(CLI, ['apply', '--data-dir', dir]);
  console.log(`apply exit ${r.code}`);
  r = cli(CLI, ['rollback', '--data-dir', dir]);
  console.log(`rollback exit ${r.code}`);

  // The v0.1 Bridge records a run after the first rollback.
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  const extra = { ...after.runs[0], id: `run_${crypto.randomUUID()}` };
  delete extra.legacyId;
  after.runs.unshift(extra);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(after, null, 2));
  fs.mkdirSync(path.join(dir, 'runs', extra.id), { recursive: true });
  const v01Again = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');

  // The second apply migrates THAT state.
  r = cli(CLI, ['apply', '--data-dir', dir]);
  console.log(`apply (2nd) exit ${r.code}`);
  const backup = read(path.join(dir, 'state.json.bak'));
  console.log(`.bak == the state migrated the 2nd time: ${backup === v01Again}`);

  // The second rollback restores it byte for byte, and the run recorded in
  // between is still there.
  r = cli(CLI, ['rollback', '--data-dir', dir]);
  console.log(`rollback (2nd, no --force) exit ${r.code}`);
  const restored = read(path.join(dir, 'state.json'));
  const same = restored === v01Again;
  const kept = (restored ?? '').includes(extra.id);
  console.log(`state == the v0.1 state before the 2nd apply: ${same}`);
  console.log(`run recorded in between still in the state: ${kept}`);
  const referenced = new Set(JSON.parse(restored ?? '{}').runs.map((x) => x.id));
  const orphans = fs.readdirSync(path.join(dir, 'runs')).filter((f) => !referenced.has(f));
  console.log(`run folders not referenced by the restored state: ${JSON.stringify(orphans)}`);
  console.log(`the v0.1 state was different from the restored one: ${v01 !== v01Again}`);
  verdict('CE7', !(same && kept && orphans.length === 0),
    'the 2nd rollback must restore, byte for byte, the v0.1 state that the 2nd apply migrated (a stale .bak drops the run v0.1 recorded in between)');
}

// ---------------------------------------------------------------------------
console.log('\n=== CE8: rollback when there is no marker (state migrated by migrate_uids --backup), a run recorded after ===');
{
  const { dir } = mkData('ce8', 2);
  let r = cli(UIDS, ['--state', path.join(dir, 'state.json'), '--backup']);
  console.log(`migrate_uids --backup exit ${r.code}`);
  const marker = fs.existsSync(path.join(dir, '.migration-marker.json'));
  console.log(`marker present: ${marker}`);

  const statePath = path.join(dir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const extra = { ...state.runs[0], id: `run_1_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}` };
  delete extra.legacyId;
  state.runs.unshift(extra);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  fs.mkdirSync(path.join(dir, 'runs', extra.id), { recursive: true });

  r = cli(CLI, ['rollback', '--data-dir', dir]);
  console.log(`rollback (no --force) exit ${r.code}`);
  const kept = JSON.parse(fs.readFileSync(statePath, 'utf8')).runs.some((x) => x.id === extra.id);
  const named = (r.out + r.err).includes(extra.id);
  console.log(`post-migration run still in state: ${kept}`);
  console.log(`named in the output: ${named}`);
  verdict('CE8', !(r.code !== 0 && kept && named),
    'rollback without --force must refuse (exit != 0), keep the run and name it -- marker or not');
}

// ---------------------------------------------------------------------------
console.log('\n=== CE9: apply killed right after the state file is renamed into place (before the journal records "state") ===');
{
  const { dir } = mkData('ce9', 2);
  const killer = `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    fs.renameSync = (a, b) => {
      if (String(a).endsWith('state.json.tmp')) { orig(a, b); process.exit(137); }
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(APPLY)});
    applyMigration(${JSON.stringify(dir)}, {});
  `;
  const k = spawnSync(process.execPath, ['--input-type=module', '-e', killer], { encoding: 'utf8' });
  console.log(`killed: exit ${k.status}`);
  const journal = read(path.join(dir, '.migration-journal.json'));
  const steps = journal ? (JSON.parse(journal).steps ?? []) : [];
  const stateNow = JSON.parse(read(path.join(dir, 'state.json')) ?? '{}');
  const migrated = /^proj_1_/.test(stateNow.projects?.[0]?.id ?? '');
  console.log(`journal steps on disk: ${JSON.stringify(steps)}`);
  console.log(`state migrated: ${migrated}`);

  const r = cli(CLI, ['apply', '--data-dir', dir]);
  console.log(`re-run apply exit ${r.code}`);
  console.log(`messages: ${(r.out + r.err).split('\n').filter((l) => l.includes('interrupted')).join(' | ')}`);
  const after = JSON.parse(read(path.join(dir, 'state.json')) ?? '{}');
  const missing = (after.runs ?? []).filter((x) => !fs.existsSync(path.join(dir, 'runs', x.id)));
  console.log(`after the re-run: state migrated: ${/^proj_1_/.test(after.projects?.[0]?.id ?? '')}`);
  console.log(`runs whose folder is missing: ${missing.length}/${(after.runs ?? []).length}`);
  const claimsUndone = /UNDONE/.test(r.out + r.err);
  const journalLeft = fs.existsSync(path.join(dir, '.migration-journal.json'));
  console.log(`claims UNDONE: ${claimsUndone}`);
  console.log(`journal still on disk: ${journalLeft}`);
  const plan = cli(CLI, ['plan', '--data-dir', dir]);
  console.log(`plan reports the interrupted migration: ${/interrupted migration: found/.test(plan.out + plan.err)}`);

  const back = cli(CLI, ['rollback', '--data-dir', dir]);
  console.log(`then rollback exit ${back.code}`);
  const legacy = (after.runs ?? []).filter((x) => fs.existsSync(path.join(dir, 'runs', x.legacyId))).length;
  console.log(`legacy folders back: ${legacy}/${(after.runs ?? []).length}`);
  verdict('CE9', claimsUndone || (r.code !== 0 && !journalLeft),
    'an interrupted migration whose state file is already written must be finished, or refused with the journal kept -- never reported as UNDONE');
}

// ---------------------------------------------------------------------------
console.log('\n=== CE10: is the Bridge lock HELD while rollback / import-only apply / recovery write? ===');
{
  const { dir } = mkData('ce10', 2);
  cli(CLI, ['apply', '--data-dir', dir]);

  // The control: the main apply path, on a FRESH v0.1 directory. It has to
  // hold the lock for its writes too -- otherwise the other three would be
  // measured against a standard the engine does not meet.
  const ctl = mkData('ce10-control', 2);
  const control = probe(ctl.dir, `m.applyMigration(${JSON.stringify(ctl.dir)}, {})`);
  const imp = probe(dir, `m.applyMigration(${JSON.stringify(dir)}, { importDatabase: true })`);
  const rb = probe(dir, `m.rollbackMigration(${JSON.stringify(dir)}, {})`);
  console.log(`main apply path (control): ${control.length} destructive writes, lock held during all: ${held(control)}`);
  console.log(`apply --import-db on a migrated state: ${imp.length} destructive writes, lock held during all: ${held(imp)}`);
  console.log(`rollback: ${rb.length} destructive writes, lock held during all: ${held(rb)}`);

  // The recovery path: a kill after the state write, at the first run
  // folder rename; the next apply finishes it.
  const c = mkData('ce10-recovery', 2);
  const killer = `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    fs.renameSync = (a, b) => { if (String(a).includes(${JSON.stringify(path.join(c.dir, 'runs') + path.sep)})) process.exit(137); return orig(a, b); };
    const { applyMigration } = await import(${JSON.stringify(APPLY)});
    applyMigration(${JSON.stringify(c.dir)}, {});
  `;
  spawnSync(process.execPath, ['--input-type=module', '-e', killer], { encoding: 'utf8' });
  const journalSteps = JSON.parse(read(path.join(c.dir, '.migration-journal.json')) ?? '{}').steps;
  const rec = probe(c.dir, `m.applyMigration(${JSON.stringify(c.dir)}, {})`);
  console.log(`recovery after a kill (journal steps ${JSON.stringify(journalSteps)}): ${rec.length} destructive writes, lock held during all: ${held(rec)}`);
  verdict('CE10', !(held(rb) && held(imp) && held(rec)),
    'the engine functions (rollbackMigration, import-only applyMigration, recovery) hold the Bridge lock for every destructive write, as the main apply path does');
}

console.log(`\n${failures} counterexample(s) hold`);
process.exit(failures ? 1 : 0);
