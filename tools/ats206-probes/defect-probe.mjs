#!/usr/bin/env node
/**
 * ATS-206 -- the defect probe.
 *
 * The probe migrates a v0.1 state that carries BOTH maps that are keyed by
 * the project identifier (the trust map of ATS-202 and the UID registry of
 * ATS-201) and reports where they ended up.
 *
 * The same probe is run against the migration BEFORE the fix (via
 * `git stash`/the base commit) and AFTER it, so that the evidence is a
 * before/after pair and not a claim.
 *
 *   node tools/ats206-probes/defect-probe.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The probe goes through the ATS-201 ENTRY POINT on purpose: that is the
// tool an operator actually runs, and it is the tool that had the defect.
// The same script therefore runs against the base commit (defect present)
// and against the fixed tree (defect gone) -- a before/after pair over one
// unchanged probe, not two probes that could disagree.
import { planMigration } from '../../tools/migrate_uids.mjs';

const LEGACY = 'proj_11111111-1111-1111-1111-111111111111';
const LEGACY_RUN = 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const legacy = {
  schema: 1,
  projects: [{
    id: LEGACY,
    name: 'app',
    root: path.join(ROOT, 'examples', 'app'),
    addedAt: '2026-01-01T00:00:00.000Z',
  }],
  runs: [{
    id: LEGACY_RUN,
    projectId: LEGACY,
    projectName: 'app',
    file: 'tests/a.spec.ts',
    gitCommit: 'abc1234',
    status: 'passed',
    createdAt: '2026-01-01T00:00:00.000Z',
  }],
  uidRegistry: {
    version: 1,
    projects: {
      [LEGACY]: {
        entries: [{
          uid: 'tc_1_d_abcdef0123456789',
          file: 'tests/a.spec.ts',
          title: 'works',
          bodyKey: 'k1',
        }],
      },
    },
  },
  trust: {
    [LEGACY]: { trust: 'trusted', reason: '', at: '2026-01-01T00:00:00.000Z' },
  },
  runCounters: { [LEGACY]: 7 },
};

const { state } = planMigration(legacy);
const newUid = state.projects[0].uid;

console.log('=== the ATS-206 defect probe ===');
console.log('the legacy project id :', LEGACY);
console.log('the migrated project  :', newUid);
console.log('');

const trustPresent = 'trust' in state;
console.log('(A) the trust map');
console.log('    present in the migrated state :', trustPresent ? 'YES' : 'NO  <<DROPPED>>');
if (trustPresent) {
  const record = state.trust[newUid];
  console.log('    reachable under the new UID   :', record ? `YES (trust=${record.trust})` : 'NO  <<UNREACHABLE>>');
  console.log('    still under the legacy key     :', LEGACY in state.trust ? 'YES' : 'NO');
}

console.log('');
console.log('(B) the UID registry');
const registryProjects = state.uidRegistry?.projects ?? {};
console.log('    the registry keys              :', JSON.stringify(Object.keys(registryProjects)));
const bucket = registryProjects[newUid];
console.log('    reachable under the new UID    :', bucket ? `YES (${bucket.entries.length} entries)` : 'NO  <<UNREACHABLE>>');
console.log('    still under the legacy key     :', LEGACY in registryProjects ? 'YES' : 'NO');

console.log('');
const verdict = trustPresent && bucket && state.trust[newUid];
console.log('VERDICT:', verdict
  ? 'both maps survive the migration and are reachable under the new UID'
  : 'DATA LOSS: a map is dropped or unreachable');
