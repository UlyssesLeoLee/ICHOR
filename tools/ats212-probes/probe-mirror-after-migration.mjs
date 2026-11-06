/**
 * ATS-212 review round 2: the SQLite mirror must stay EXACT after the state
 * migration re-keys the environment profiles.
 *
 * The review required this explicitly: "after the migration `verifyMirror`
 * must still be OK". The migration rewrites `envProfiles.profiles[].projectUid`
 * and `envProfiles.whitelists`, and the mirror compares the state against the
 * database field by field -- so a profile that was re-keyed but not
 * re-mirrored would be reported as a problem.
 *
 * This is a script, not a test: it needs a real database file and a real
 * migration, and it is collected as the evidence of that requirement.
 *
 * usage: node tools/ats212-probes/probe-mirror-after-migration.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { planMigration } from '../../server/migration/state-migration.mjs';
import { envStoreOf, upsertProfile, setWhitelist } from '../../server/env/store.mjs';
import { projectUidOf } from '../../server/uid.mjs';
import { importStateInto, verifyMirror } from '../../server/sqlite/import.mjs';
import { closeDatabase } from '../../server/sqlite/db.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats212-mirror-'));
const project = {
  id: 'proj_11111111-2222-3333-4444-555555555555',
  name: 'legacy',
  root,
  addedAt: '2026-01-01T00:00:00Z',
};

const state = { schema: 1, projects: [project], runs: [], uidRegistry: { version: 1, projects: {} } };
const store = envStoreOf(state);
setWhitelist(store, project, ['BASE_URL']);
upsertProfile(store, project, {
  name: 'staging',
  environment: 'staging',
  variables: { BASE_URL: 'http://legacy.example.test' },
});

const plan = planMigration(state);
const next = plan.state ?? plan.nextState ?? plan;
const migrated = next.projects[0];

const dbPath = path.join(root, 'state.db');
const { db } = importStateInto(dbPath, next);
const mirror = verifyMirror(db, next);
const problems = mirror.problems ?? [];
closeDatabase(db);

console.log(`project  : ${project.id} -> ${migrated.id}`);
console.log(`profiles : ${JSON.stringify(next.envProfiles.profiles.map((p) => ({ uid: p.uid, projectUid: p.projectUid })))}`);
console.log(`whitelists: ${JSON.stringify(next.envProfiles.whitelists)}`);
console.log(`mirror problems: ${problems.length}`);
for (const p of problems) console.log(`  - ${p}`);

const ok = problems.length === 0
  && next.envProfiles.profiles.length === 1
  && next.envProfiles.profiles[0].projectUid === projectUidOf(migrated);
console.log(`RESULT: ${ok ? 'OK -- the mirror is exact after the migration' : 'FAIL'}`);

fs.rmSync(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
