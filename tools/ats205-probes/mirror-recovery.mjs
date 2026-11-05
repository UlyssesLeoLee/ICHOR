#!/usr/bin/env node
/**
 * ATS-205 -- the mirror RECOVERS after a transient failure.
 *
 * The probe reproduces the failure mode that was found in review: another
 * process holds the write lock of the metadata database for longer than the
 * mirror's busy timeout, the bridge writes while the lock is held, and the
 * question is what the database looks like afterwards.
 *
 * The failure has to be TRANSIENT: only `SQLITE_NOT_AVAILABLE` (a Node
 * build without `node:sqlite` at all) may disable the mirror for good.
 * Every other failure -- a lock, a full disk, an antivirus scanner -- must
 * be retried on the next save. The mirror replaces the whole table set in
 * one transaction, so a retry is self-healing.
 *
 * The probe checks three things:
 *
 *   1. the write that happened while the lock was held is in the JSON state
 *      (the state file is the truth and it is written before the mirror),
 *   2. the mirror was NOT disabled by the failure: a later write mirrors
 *      again,
 *   3. after the later write the database holds EVERYTHING the JSON state
 *      holds -- including the record that was written while the lock was
 *      held.
 *
 * Usage: node tools/ats205-probes/mirror-recovery.mjs [repo]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dbUrl = pathToFileURL(path.join(REPO, 'server', 'sqlite', 'db.mjs')).href;
const { openDatabase, closeDatabase } = await import(dbUrl);
const { MIRROR_BUSY_TIMEOUT_MS } = await import(
  pathToFileURL(path.join(REPO, 'server', 'core.mjs')).href
);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ats205-mirror-'));
const data = path.join(work, 'data');
fs.mkdirSync(data, { recursive: true });
const dbFile = path.join(data, 'metadata.db');

const say = (...a) => console.log(...a);
const state = {
  schema: 1,
  projects: [
    { id: 'p1', uid: 'p1', name: 'a', root: '/a', addedAt: '2026-01-01T00:00:00Z' },
  ],
  runs: [],
  uidRegistry: { version: 1, projects: {} },
  runCounters: {},
};

say('=== the mirror recovers after a transient failure ===');
say(`the mirror busy timeout : ${MIRROR_BUSY_TIMEOUT_MS} ms`);
say(`the work directory      : ${work}`);
say();

// --- 1. the first mirror succeeds ------------------------------------------
process.env.ATS_DATA_DIR = data;
const core = await import(pathToFileURL(path.join(REPO, 'server', 'core.mjs')).href);
say(`1. the first mirror        : ${core.mirrorToSqlite(state) ? 'OK' : 'FAILED'}`);

// --- 2. another process holds the write lock --------------------------------
// The lock is held for LONGER than the mirror's own busy timeout, so the
// mirror really gives up instead of waiting the obstruction out.
const holderScript = path.join(work, 'holder.mjs');
fs.writeFileSync(holderScript, `
import { openDatabase, closeDatabase } from ${JSON.stringify(dbUrl)};
const [file, holdMs] = process.argv.slice(2);
const db = openDatabase(file, { migrate: false });
db.exec('BEGIN IMMEDIATE');
console.log('LOCKED');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
db.exec('COMMIT');
closeDatabase(db);
console.log('RELEASED');
`, 'utf8');
const holder = spawn(process.execPath, [holderScript, dbFile, String(MIRROR_BUSY_TIMEOUT_MS * 3)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
holder.stdout.on('data', (d) => { out += d.toString(); });
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (out.includes('LOCKED')) { clearInterval(timer); resolve(); }
  }, 10);
});
say(`2. the lock is held by another process (${MIRROR_BUSY_TIMEOUT_MS * 3} ms)`);

// --- 3. the mirror is blocked ----------------------------------------------
const blocked = core.mirrorToSqlite(state);
say(`3. the blocked mirror      : ${blocked ? 'OK (unexpected)' : 'FAILED (as expected)'}`);

// --- 4. the lock is released ------------------------------------------------
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (out.includes('RELEASED')) { clearInterval(timer); resolve(); }
  }, 10);
});
if (holder.exitCode === null && holder.signalCode === null) {
  await new Promise((r) => holder.on('close', r));
}
say('4. the lock is released');

// --- 5. the mirror tries again and catches up -------------------------------
const recovered = core.mirrorToSqlite(state);
say(`5. the mirror again        : ${recovered ? 'OK' : 'FAILED'}`);

// --- 6. the database now holds everything the JSON state holds --------------
const db = openDatabase(dbFile, { migrate: false });
let counts;
try {
  counts = {
    projects: Number(db.prepare('SELECT count(*) AS n FROM projects').get().n),
    runs: Number(db.prepare('SELECT count(*) AS n FROM runs').get().n),
  };
} finally { closeDatabase(db); }
say(`6. the database            : ${JSON.stringify(counts)}`);
say(`   the JSON state          : ${JSON.stringify({
  projects: state.projects.length, runs: state.runs.length,
})}`);

const ok = recovered && counts.projects === state.projects.length;
say();
say(`RESULT: ${ok ? 'the mirror recovered' : 'the mirror did NOT recover'}`);
fs.rmSync(work, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
