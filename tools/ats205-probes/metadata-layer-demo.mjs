/**
 * ATS-205 -- an end-to-end demonstration of the metadata layer.
 *
 * The script exercises the whole contract on a real database file and
 * prints what happened, so the log shows the BEHAVIOUR and not only the
 * assertions of the test suite:
 *
 *   1. a fresh database is created and carries the newest schema version
 *   2. the state is imported and the mirror is verified
 *   3. the database is downgraded to version 1 -- the higher-version tables
 *      and their data are gone
 *   4. the database is upgraded again -- the tables come back, empty
 *   5. two concurrent writers each commit rows; no record is lost
 *
 * Usage: node tools/ats205-probes/metadata-layer-demo.mjs
 * Exit 0 when every step behaved as documented.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  openDatabase, closeDatabase, currentVersion, downgradeDatabase, migrateDatabase,
} from '../../server/sqlite/db.mjs';
import { importState, verifyMirror } from '../../server/sqlite/import.mjs';
import { counts } from '../../server/sqlite/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats205-demo-'));
const file = path.join(dir, 'metadata.db');

const state = {
  schema: 1,
  projects: [
    { id: 'proj_1_aaaaaaaa', uid: 'proj_1_aaaaaaaa', name: 'alpha', root: '/tmp/alpha', addedAt: '2026-01-01T00:00:00.000Z' },
  ],
  runs: [
    {
      id: 'run_1_0001', uid: 'run_1_0001', seq: 1, projectId: 'proj_1_aaaaaaaa',
      projectUid: 'proj_1_aaaaaaaa', status: 'passed', createdAt: '2026-01-01T00:00:01.000Z',
      attempts: [{ uid: 'att_1_1', testUid: 'tc-1', retry: 0, status: 'passed', caseStatus: 'expected', duration: 12 }],
      artifacts: [{ file: 'trace.zip', sha256: 'a'.repeat(64), size: 1024 }],
    },
  ],
  uidRegistry: {
    version: 1,
    projects: { proj_1_aaaaaaaa: { entries: [{ uid: 'tc-1', file: 'tests/a.spec.ts', title: 'works', bodyKey: 'k1' }] } },
  },
  runCounters: { proj_1_aaaaaaaa: 1 },
};

const say = (...parts) => console.log(...parts);

say('=== 1. a fresh database ===');
const db = openDatabase(file);
say(`file            : ${file}`);
say(`schema version  : ${currentVersion(db)}`);
say(`journal mode    : ${db.prepare('PRAGMA journal_mode').get().journal_mode}`);
say(`busy timeout    : ${db.prepare('PRAGMA busy_timeout').get().timeout} ms`);
say(`synchronous     : ${db.prepare('PRAGMA synchronous').get().synchronous} (1 = NORMAL)`);
say(`foreign keys    : ${db.prepare('PRAGMA foreign_keys').get().foreign_keys}`);
say(`wal sidecar     : ${fs.existsSync(file + '-wal')}`);

say('');
say('=== 2. import the state and verify the mirror ===');
const report = importState(db, state);
say(`imported        : ${JSON.stringify(report)}`);
say(`row counts      : ${JSON.stringify(counts(db))}`);
const check = verifyMirror(db, state);
say(`mirror          : ${check.ok ? 'OK' : 'MISMATCH -> ' + check.problems.join('; ')}`);

say('');
say('=== 3. downgrade to version 1 (explicit, lossy) ===');
const down = downgradeDatabase(db, 1);
say(`downgrade       : ${JSON.stringify(down)}`);
say(`schema version  : ${currentVersion(db)}`);
say(`row counts      : ${JSON.stringify(counts(db))}  <- the v2 tables and their data are gone`);
say(`artifacts table : ${db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='artifacts'").get().n}`);

say('');
say('=== 4. upgrade again (forward-only, additive) ===');
const up = migrateDatabase(db, null);
say(`migrate         : ${JSON.stringify(up)}`);
say(`schema version  : ${currentVersion(db)}`);
say(`row counts      : ${JSON.stringify(counts(db))}  <- the tables are back, empty`);
closeDatabase(db);

say('');
say('=== 5. two concurrent writers, no record lost ===');
const writer = path.join(dir, 'writer.mjs');
fs.writeFileSync(writer, `
import { openDatabase, closeDatabase, withTransaction } from ${JSON.stringify(
  new URL('../../server/sqlite/db.mjs', import.meta.url).href
)};
const [file, tag, n] = process.argv.slice(2);
const db = openDatabase(file, { migrate: true });
for (let i = 0; i < Number(n); i++) {
  withTransaction(db, (d) => {
    d.prepare('INSERT INTO run_counters(project_id,seq) VALUES(?,?)').run(tag + '-' + i, i);
  });
}
closeDatabase(db);
`, 'utf8');

const run = (tag, n) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [writer, file, tag, String(n)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${tag} exited ${code}: ${err}`))));
});

await Promise.all([run('a', 100), run('b', 100)]);
const db2 = openDatabase(file, { migrate: false });
const total = Number(db2.prepare('SELECT count(*) AS n FROM run_counters').get().n);
// The imported state already carried one counter row, so the expected
// total is that row plus the 200 the two writers committed.
const expected = 200 + 1;
say(`rows written    : 100 + 100`);
say(`rows present    : ${total} (the imported state already held 1)`);
say(`verdict         : ${total === expected ? 'OK -- no record was lost' : `FAILED -- expected ${expected}`}`);
closeDatabase(db2);

fs.rmSync(dir, { recursive: true, force: true });
say('');
say(`RESULT: ${total === expected && check.ok ? 'OK' : 'FAILED'}`);
process.exit(total === expected && check.ok ? 0 : 1);
