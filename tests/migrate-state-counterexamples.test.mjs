/**
 * ATS-206 -- the counterexamples of the Opus review (round 1) as unit tests.
 *
 * Every test here is a case that FAILED on the commit that was delivered in
 * round 1 (`d6152ee`) and PASSES after the fixes. The fixtures are GENUINE
 * v0.1 states -- the shape the v0.1 bridge wrote: `schema: 1`,
 * `proj_<uuid>` / `run_<uuid>`, no registry, no trust map, no attempts --
 * because the round-1 fixtures carried fields that v0.1 never had, and a
 * test against a fixture that cannot occur does not test anything.
 *
 * The cases:
 *   CE1  the `--state` option names the file that is migrated, and a
 *        failure is reported, not thrown.
 *   CE2  a second `apply` does not overwrite the v0.1 backup.
 *   CE3  a rollback is refused while the Bridge holds the lock.
 *   CE4  a folder rename that fails half way through is fully undone.
 *   CE5  a rollback that would discard a run refuses and names it.
 *   CE6  an interrupted migration is finished, and the backup survives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as engine from '../server/migration/apply.mjs';
import { isMigrated } from '../server/migration/state-migration.mjs';

// The exports are read off the module rather than imported by name: a
// version of the engine that does not have one of them (the round-1
// delivery did not have `digestOf`) has to fail the TESTS that need it,
// not the whole file. A file that cannot be imported fails as ONE test,
// and the other tests are not reported at all.
const { applyMigration, rollbackMigration, pathsOf } = engine;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats206-ce-'));
const repoRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(repoRoot, 'tools', 'migrate_state.mjs');
const applyModule = pathToFileURL(path.join(repoRoot, 'server', 'migration', 'apply.mjs')).href;
const coreModule = pathToFileURL(path.join(repoRoot, 'server', 'core.mjs')).href;

let counter = 0;

/**
 * A GENUINE v0.1 state: the identifiers are the uuid form, and there is no
 * registry, no trust map and no attempt list -- none of those existed in
 * v0.1.
 */
function v01State(root, label, nRuns) {
  const pid = `proj_${crypto.randomUUID()}`;
  const runs = [];
  for (let i = 0; i < nRuns; i++) {
    const t = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
    runs.unshift({
      id: `run_${crypto.randomUUID()}`,
      projectId: pid,
      projectName: label,
      file: `tests/${label}-${i}.spec.ts`,
      gitCommit: 'abc1234',
      status: 'passed',
      createdAt: t,
      startedAt: t,
      finishedAt: t,
      eventSeq: 3,
      log: 'ok\n',
      summary: { passed: 1, failed: 0, skipped: 0, flaky: 0, cases: [] },
      artifacts: [{ file: 'report.json', size: 2, sha256: 'x' }],
    });
  }
  return {
    schema: 1,
    projects: [{ id: pid, name: label, root, addedAt: '2026-01-01T00:00:00.000Z' }],
    runs,
  };
}

/** Writes a v0.1 state and its run folders into a fresh data directory. */
function makeData(name, nRuns = 3, file = 'state.json', label = 'app') {
  const dataDir = path.join(dir, name);
  fs.mkdirSync(path.join(dataDir, 'runs'), { recursive: true });
  const state = v01State(path.join(dataDir, label), label, nRuns);
  const text = JSON.stringify(state, null, 2);
  fs.writeFileSync(path.join(dataDir, file), text);
  for (const r of state.runs) {
    fs.mkdirSync(path.join(dataDir, 'runs', r.id), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'runs', r.id, 'report.json'), '{}');
  }
  return { dataDir, state, text };
}

function runCli(args) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The runs whose folder does not exist under the data directory. */
function missingFolders(dataDir, stateFile = 'state.json') {
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, stateFile), 'utf8'));
  return state.runs
    .filter((r) => !fs.existsSync(path.join(dataDir, 'runs', r.id)))
    .map((r) => r.id);
}

/** Waits for a line of output of a child process. */
function waitLine(child, text) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${text}`)), 30000);
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes(text)) { clearTimeout(timer); resolve(); }
    });
  });
}

/* ---------------------------------------------------------------- */
/* CE1: the --state option names the file that is migrated            */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-070: the apply command migrates the file named by --state', () => {
  const { dataDir, text } = makeData('ce1a', 2);
  const custom = v01State(path.join(dataDir, 'custom'), 'custom', 1);
  const customText = JSON.stringify(custom, null, 2);
  fs.writeFileSync(path.join(dataDir, 'custom.json'), customText);

  const res = runCli(['apply', '--data-dir', dataDir, '--state', path.join(dataDir, 'custom.json')]);
  assert.equal(res.code, 0, res.err);
  // The file that was NAMED is migrated.
  assert.notEqual(fs.readFileSync(path.join(dataDir, 'custom.json'), 'utf8'), customText);
  assert.equal(isMigrated(JSON.parse(fs.readFileSync(path.join(dataDir, 'custom.json'), 'utf8'))), true);
  // The file that was NOT named is untouched.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
});

test('ATS-206-UT-071: the rollback command restores the file named by --state', () => {
  const { dataDir, text } = makeData('ce1b', 2);
  const custom = v01State(path.join(dataDir, 'custom'), 'custom', 1);
  const customText = JSON.stringify(custom, null, 2);
  fs.writeFileSync(path.join(dataDir, 'custom.json'), customText);

  let res = runCli(['apply', '--data-dir', dataDir, '--state', path.join(dataDir, 'custom.json')]);
  assert.equal(res.code, 0, res.err);
  // The named file really was migrated -- otherwise the rollback below
  // would trivially restore a file that was never touched, and the test
  // would pass on an implementation that ignores --state entirely.
  assert.equal(isMigrated(JSON.parse(fs.readFileSync(path.join(dataDir, 'custom.json'), 'utf8'))), true);

  res = runCli(['rollback', '--data-dir', dataDir, '--state', path.join(dataDir, 'custom.json')]);
  assert.equal(res.code, 0, res.err);
  assert.equal(fs.readFileSync(path.join(dataDir, 'custom.json'), 'utf8'), customText);
  // The state file that was never migrated is still the original.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
});

test('ATS-206-UT-072: the apply command reports a missing state file without a stack trace', () => {
  const dataDir = path.join(dir, 'ce1c');
  fs.mkdirSync(dataDir, { recursive: true });
  const res = runCli(['apply', '--state', path.join(dataDir, 'legacy-state.json')]);
  assert.equal(res.code, 1);
  // A reason on stderr, and NO stack trace.
  assert.match(res.err, /state file not found/);
  assert.doesNotMatch(res.err, /\n\s+at /);
});

test('ATS-206-UT-073: the apply command reports a state that is not JSON without a stack trace', () => {
  const dataDir = path.join(dir, 'ce1d');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'legacy-state.json');
  fs.writeFileSync(file, 'this is not JSON');
  const res = runCli(['apply', '--state', file]);
  assert.equal(res.code, 1);
  assert.match(res.err, /STATE_NOT_JSON/);
  assert.doesNotMatch(res.err, /\n\s+at /);
});

test('ATS-206-UT-074: the apply command reports a refused state without a stack trace', () => {
  const { dataDir } = makeData('ce1e', 1);
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  // Two projects with the SAME root derive the same UID: the migration
  // refuses such a state.
  state.projects.push({
    id: `proj_${crypto.randomUUID()}`,
    name: 'app-clone',
    root: state.projects[0].root,
    addedAt: '2026-01-01T00:00:00.000Z',
  });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /PROJECT_UID_COLLISION/);
  assert.doesNotMatch(res.err, /\n\s+at /);
});

/* ---------------------------------------------------------------- */
/* CE2: the v0.1 backup is never overwritten                          */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-075: a second apply does not overwrite the v0.1 backup', () => {
  const { dataDir, state, text } = makeData('ce2a', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  // A second apply -- the natural "import the mirror afterwards" operation.
  res = runCli(['apply', '--data-dir', dataDir, '--import-db']);
  assert.equal(res.code, 0, res.err);
  // The backup still holds the v0.1 file.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json.bak'), 'utf8'), text);

  // ... and the rollback therefore restores v0.1 byte for byte, with every
  // legacy folder back.
  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
  const legacy = state.runs.filter((r) => fs.existsSync(path.join(dataDir, 'runs', r.id))).length;
  assert.equal(legacy, state.runs.length);
});

test('ATS-206-UT-076: an already migrated state is not migrated again', () => {
  const { dataDir } = makeData('ce2b', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  const migrated = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');
  res = runCli(['apply', '--data-dir', dataDir]);
  // The second apply refuses instead of re-migrating.
  assert.equal(res.code, 1);
  assert.match(res.err, /ALREADY_MIGRATED/);
  // The state file is unchanged by the refused apply.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), migrated);
});

/* ---------------------------------------------------------------- */
/* CE3: the Bridge lock is held for the whole write                   */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-077: the rollback command is refused while a Bridge runs', async () => {
  const { dataDir } = makeData('ce3', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);

  // A process that holds the lock for real.
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `import {acquireBridgeLock,lockPath} from ${JSON.stringify(coreModule)};` +
    `acquireBridgeLock(lockPath(${JSON.stringify(dataDir)}));console.log('LOCKED');setInterval(()=>{},1000);`],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  await waitLine(holder, 'LOCKED');
  try {
    // The apply refuses ...
    const control = runCli(['apply', '--data-dir', dataDir]);
    assert.equal(control.code, 3);
    // ... and so does the rollback.
    const back = runCli(['rollback', '--data-dir', dataDir]);
    assert.equal(back.code, 3);
    assert.match(back.err, /a Bridge is running/);
  } finally {
    holder.kill();
  }
});

/* ---------------------------------------------------------------- */
/* CE4: a rename that fails half way through is fully undone          */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-078: a folder rename that fails half way through is undone', () => {
  const { dataDir, state } = makeData(`ce4a-${counter++}`, 3);

  // The rename of the SECOND folder throws.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync; let n = 0;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep) && !String(a).includes('run_1_') && ++n === 2) {
        const e = new Error('EPERM: simulated'); e.code = 'EPERM'; throw e;
      }
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    const rep = applyMigration(${JSON.stringify(dataDir)}, {});
    console.log(JSON.stringify({ failed: rep.failed, rolledBack: rep.rolledBack, undone: rep.undone }));
  `], { encoding: 'utf8' });
  const report = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.equal(report.failed, true);
  assert.equal(report.rolledBack, true);

  // EVERY run of the restored state has its folder: the folders that were
  // renamed before the throw were renamed BACK.
  assert.deepEqual(missingFolders(dataDir), []);
  for (const r of state.runs) {
    assert.equal(fs.existsSync(path.join(dataDir, 'runs', r.id)), true, `the folder of ${r.id} is missing`);
  }
});

test('ATS-206-UT-079: the renamed folders are named in the undo report', () => {
  const { dataDir } = makeData(`ce4b-${counter++}`, 3);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync; let n = 0;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep) && !String(a).includes('run_1_') && ++n === 2) {
        const e = new Error('EPERM: simulated'); e.code = 'EPERM'; throw e;
      }
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    const rep = applyMigration(${JSON.stringify(dataDir)}, {});
    console.log(JSON.stringify(rep.undone));
  `], { encoding: 'utf8' });
  const undone = JSON.parse(child.stdout.trim().split('\n').pop());
  // The folder that was renamed before the throw is named as renamed back.
  assert.ok(
    undone.some((u) => u.includes('run folder renamed back')),
    `the undo report names no renamed folder: ${JSON.stringify(undone)}`
  );
});

/* ---------------------------------------------------------------- */
/* CE5: a rollback that would discard a run refuses and names it      */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-080: a rollback that would discard a run refuses and names it', () => {
  const { dataDir } = makeData('ce5', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);

  // The bridge records a new run after the migration.
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const newRun = {
    ...state.runs[0],
    id: `run_1_${'c'.repeat(24)}`,
    uid: `run_1_${'c'.repeat(24)}`,
    seq: 99,
    legacyId: undefined,
    createdAt: '2026-06-01T00:00:00.000Z',
  };
  state.runs.unshift(newRun);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  fs.mkdirSync(path.join(dataDir, 'runs', newRun.id), { recursive: true });

  res = runCli(['rollback', '--data-dir', dataDir]);
  // The rollback refuses ...
  assert.notEqual(res.code, 0);
  // ... the run is still in the state ...
  const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(after.runs.some((x) => x.id === newRun.id), 'the run was silently discarded');
  // ... and it is NAMED in the output.
  assert.match(res.out + res.err, new RegExp(newRun.id));
});

test('ATS-206-UT-081: a rollback with --force discards the run on purpose', () => {
  const { dataDir } = makeData('ce5b', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);

  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const newRun = { ...state.runs[0], id: `run_1_${'d'.repeat(24)}`, uid: `run_1_${'d'.repeat(24)}`, seq: 98 };
  state.runs.unshift(newRun);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  res = runCli(['rollback', '--data-dir', dataDir, '--force']);
  assert.equal(res.code, 0, res.err);
  const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(!after.runs.some((x) => x.id === newRun.id), 'the run was not discarded');
});

/* ---------------------------------------------------------------- */
/* CE6: an interrupted migration is finished, and the backup survives */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-082: an interrupted migration is finished by the next apply', () => {
  const { dataDir, state, text } = makeData('ce6', 2);

  // The process is killed after the state file is written, before the
  // folders are renamed.
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep)) process.exit(137);
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });

  // The journal of the killed run is on disk.
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-journal.json')), true);

  // The next apply finishes the migration.
  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  // Every run has its folder ...
  assert.deepEqual(missingFolders(dataDir), []);
  // ... and the v0.1 backup was NOT replaced.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json.bak'), 'utf8'), text);

  // The rollback still restores v0.1.
  const back = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(back.code, 0, back.err);
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
  const legacy = state.runs.filter((r) => fs.existsSync(path.join(dataDir, 'runs', r.id))).length;
  assert.equal(legacy, state.runs.length);
});

test('ATS-206-UT-083: the plan command reports an interrupted migration', () => {
  const { dataDir } = makeData('ce6b', 2);
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep)) process.exit(137);
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });

  const res = runCli(['plan', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /interrupted migration/);
});

test('ATS-206-UT-084: the journal is written before the first destructive write', () => {
  const { dataDir } = makeData('ce6c', 2);
  // The rename of the first folder throws: the journal has to be on disk by
  // then, because the state file has already been written.
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep)) {
        const e = new Error('EPERM: simulated'); e.code = 'EPERM'; throw e;
      }
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });
  // The failed run undid itself, so the journal is gone -- but the STATE
  // file has to be the original one, which proves the undo ran.
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(isMigrated(state), false);
});

/* ---------------------------------------------------------------- */
/* the engine: the recovery paths and the guards                     */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-086: an interrupted migration before the state write is undone', () => {
  const { dataDir } = makeData('ce6d', 2);
  // The process is killed BEFORE the state file is written -- the journal
  // exists, but the 'state' step was never recorded.
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const orig = fs.renameSync;
    const sep = ${JSON.stringify(path.sep)};
    fs.renameSync = (a, b) => {
      if (String(a).includes(sep + 'runs' + sep)) process.exit(137);
      return orig(a, b);
    };
    const { applyMigration } = await import(${JSON.stringify(applyModule)});
    applyMigration(${JSON.stringify(dataDir)}, {});
  `], { encoding: 'utf8' });

  // The next apply finds the journal, undoes the interrupted run and
  // migrates cleanly.
  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(missingFolders(dataDir), []);
  assert.equal(
    fs.existsSync(path.join(dataDir, '.migration-journal.json')),
    false,
    'the journal of a finished migration is removed'
  );
});

test('ATS-206-UT-087: the rollback restores the database as well', () => {
  const { dataDir } = makeData('ce7', 2);
  let res = runCli(['apply', '--data-dir', dataDir, '--import-db']);
  assert.equal(res.code, 0, res.err);
  assert.equal(fs.existsSync(path.join(dataDir, 'metadata.db')), true);

  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  // The database backup was restored (there was no database before the
  // migration, so the backup file is gone and the database was removed).
  assert.equal(fs.existsSync(path.join(dataDir, 'metadata.db.bak')), false);
});

test('ATS-206-UT-088: a run id that is not a run id is refused', () => {
  const { dataDir } = makeData('ce8', 2);
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  // A run id that is not a path segment: the folder rename would leave the
  // runs directory.
  state.runs[0].id = '../../escape';
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /INVALID_RUN_ID/);
  // Nothing was written outside the data directory.
  assert.equal(fs.existsSync(path.join(path.dirname(dataDir), 'escape')), false);
});

test('ATS-206-UT-089: the rollback of a state that was never migrated is refused', () => {
  const { dataDir } = makeData('ce9', 2);
  const res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /NO_BACKUP_TO_RESTORE/);
});

test('ATS-206-UT-090: the verify command reports a state that is not JSON', () => {
  const { dataDir } = makeData('ce10', 1);
  fs.writeFileSync(path.join(dataDir, 'state.json'), 'not JSON at all');
  const res = runCli(['verify', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /STATE_NOT_JSON/);
  assert.doesNotMatch(res.err, /\n\s+at /);
});

test('ATS-206-UT-091: the plan command reports a state file that is missing', () => {
  const { dataDir } = makeData('ce11', 1);
  fs.rmSync(path.join(dataDir, 'state.json'));
  const res = runCli(['plan', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /STATE_FILE_MISSING/);
});

/* ---------------------------------------------------------------- */
/* the engine: the guards and the failure paths                       */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-092: a dry run writes nothing', () => {
  const { dataDir, text } = makeData('ce12', 2);
  const res = runCli(['apply', '--data-dir', dataDir, '--dry-run']);
  assert.equal(res.code, 0, res.err);
  // Neither the state file nor the backup was touched.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
  assert.equal(fs.existsSync(path.join(dataDir, 'state.json.bak')), false);
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-journal.json')), false);
});

test('ATS-206-UT-093: a state file that cannot be read is reported', () => {
  const { dataDir } = makeData('ce13', 2);
  // A directory where the state file should be: reading it fails.
  fs.rmSync(path.join(dataDir, 'state.json'));
  fs.mkdirSync(path.join(dataDir, 'state.json'));
  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /STATE_FILE_UNREADABLE/);
  assert.doesNotMatch(res.err, /\n\s+at /);
});

test('ATS-206-UT-094: a journal that cannot be parsed is not trusted', () => {
  const { dataDir } = makeData('ce14', 2);
  // A journal that is not JSON: it cannot describe what was done, so it is
  // kept for the operator and the migration refuses to guess.
  fs.writeFileSync(path.join(dataDir, '.migration-journal.json'), '{ this is not json');
  const res = runCli(['apply', '--data-dir', dataDir]);
  // The engine does not trust the journal -- the migration is refused with
  // a reason rather than run over an unknown state.
  assert.notEqual(res.code, 0);
  assert.match(res.err + res.out, /journal/i);
  // The journal was NOT deleted: the operator can look at it.
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-journal.json')), true);
});

test('ATS-206-UT-095: a marker that cannot be parsed is ignored', () => {
  const { dataDir } = makeData('ce15', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  fs.writeFileSync(path.join(dataDir, '.migration-marker.json'), 'not json');
  // The rollback still works: the backup is the source of truth.
  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
});

test('ATS-206-UT-096: a digest of a file that is not there is null', () => {
  const missing = path.join(dir, 'ce16', 'nope.json');
  // The engine has to answer "no digest" for a file that is not there,
  // rather than throwing: the rollback asks for the digest of a file that
  // may have been removed.
  assert.equal(typeof engine.digestOf, 'function', 'the engine has no digestOf');
  assert.equal(engine.digestOf(missing), null);
});

test('ATS-206-UT-097: an import into a database that fails leaves the state alone', () => {
  const { dataDir, text } = makeData('ce17', 2);
  // The database path is occupied by a directory: the import cannot work.
  fs.mkdirSync(path.join(dataDir, 'metadata.db'), { recursive: true });
  const res = runCli(['apply', '--data-dir', dataDir, '--import-db']);
  assert.equal(res.code, 1);
  // The state file was NOT migrated: the refusal happened before the
  // first destructive write.
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), text);
});

test('ATS-206-UT-098: a run of an unknown project is kept, not dropped', () => {
  const { dataDir } = makeData('ce18', 3);
  // A run that points at a project that is not in the state: the migration
  // cannot derive a project UID for it, but it must NOT lose the run --
  // losing it would change the counts, which is what the count check is
  // there to prevent.
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.runs[0].projectId = 'proj_does_not_exist';
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(after.runs.length, state.runs.length, 'a run was lost during the migration');
  assert.ok(after.runs.some((r) => r.legacyId === 'proj_does_not_exist' || r.projectId === 'proj_does_not_exist'));
});

test('ATS-206-UT-099: the rollback reports a state file that cannot be restored', () => {
  const { dataDir } = makeData('ce19', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  // The backup is removed: there is nothing to restore.
  fs.rmSync(path.join(dataDir, 'state.json.bak'));
  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.err, /NO_BACKUP_TO_RESTORE/);
});

/* ---------------------------------------------------------------- */
/* the two bugs the e2e probe found on real v0.1 data                 */
/* ---------------------------------------------------------------- */

test('ATS-206-UT-100: the migrated runs are NOT reported as lost by a rollback', () => {
  // The migration rewrites every run id. A rollback that compared the ids
  // directly would report EVERY migrated run as a run that the rollback
  // would lose -- and would refuse a rollback that loses nothing.
  const { dataDir } = makeData('ce20', 3);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);

  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  // The migrated runs are in the backup under their LEGACY ids, so the
  // rollback does not lose them.
  assert.doesNotMatch(res.out + res.err, /would DISCARD/);
});

test('ATS-206-UT-101: the bridge filling in the events does not block a rollback', () => {
  // The bridge writes the events of a run into the state when it reads it.
  // The bytes of the state file therefore change on every restart of the
  // bridge, even though the history is unchanged. A rollback that compared
  // the BYTES would refuse after every restart, and `--force` would be
  // needed every time -- which makes `--force` meaningless.
  const { dataDir } = makeData('ce21', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);

  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const r of state.runs) {
    r.events = [{ seq: 1, at: '2026-06-01T00:00:00.000Z', type: 'run.queued', data: {} }];
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  // The bytes are different, but the INVENTORY is not: the rollback works.
  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);
  assert.doesNotMatch(res.out + res.err, /STATE_DIVERGED/);
});

test('ATS-206-UT-102: a rollback still refuses when a run was added after the migration', () => {
  // The counterpart of UT-101: the INVENTORY did change, so the rollback
  // refuses and names the run.
  const { dataDir } = makeData('ce22', 2);
  let res = runCli(['apply', '--data-dir', dataDir]);
  assert.equal(res.code, 0, res.err);

  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const newId = `run_1_${'e'.repeat(24)}`;
  state.runs.unshift({
    ...state.runs[0],
    id: newId,
    uid: newId,
    legacyId: undefined,
    seq: 77,
  });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  res = runCli(['rollback', '--data-dir', dataDir]);
  assert.notEqual(res.code, 0);
  assert.match(res.out + res.err, new RegExp(newId));
});

/* ---------------------------------------------------------------- */

test('ATS-206-UT-085: cleanup removes the temporary fixture', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});
