/**
 * ATS-212 -- the environment profiles: the boundaries of the whitelist and
 * of the state migration.
 *
 * WHAT IS ASSERTED HERE
 * ---------------------
 * The environment variable whitelist has to hold on both sides: at the
 * write and at the run. Every test below asserts one boundary that the
 * whitelist, the reserved names or the state migration has to hold.
 *
 *   1. ONE PROJECT KEY. The write path, the list path, the delete path and
 *      the RUN path must all key a profile by the same identifier, so a
 *      profile the API lists can always be used by a run -- and the state
 *      migration must not orphan the profiles and the custom whitelists.
 *   2. THE WHITELIST CONSTRAINS THE RUN. A name removed from the whitelist
 *      must not reach the child process.
 *   3. AN EMPTY WHITELIST IS AN EMPTY WHITELIST. `names: []` must not
 *      silently become the default list.
 *   4. THE SMALL FIXES. The case-colliding names are refused (not
 *      collapsed), the structural keys are case-insensitive, and the
 *      reserved names are refused at the run as well as at the write.
 *   5. THE COMMENTS DESCRIBE THE CODE. The reserved-name policy is stated
 *      exactly, and the Windows run-time keys are documented.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import {
  RESERVED_ENV_NAMES,
  normaliseVariables,
  buildRunnerEnv,
  envUidFor,
} from '../server/env/profiles.mjs';
import {
  envStoreOf,
  profilesOfProject,
  findProfile,
  whitelistForProject,
  upsertProfile,
  setWhitelist,
} from '../server/env/store.mjs';
import { projectUidOf } from '../server/uid.mjs';
import { planMigration } from '../server/migration/state-migration.mjs';

/**
 * The project key of the store.
 *
 * The fallback keeps the file loadable on a tree that does not export the
 * helper yet: every test then fails on its ASSERTION -- which is what
 * shows which boundary each test is about -- instead of the whole file
 * dying on an import error.
 */
const storeModule = await import('../server/env/store.mjs');
const projectKeyOf = storeModule.projectKeyOf ?? ((p) => (p ? p.uid ?? p.id : null));

/**
 * The whitelist filter of the run path.
 *
 * The fallback is the unfiltered behaviour -- the profile's variables, as
 * they are -- so the test fails on its ASSERTION ("the removed name still
 * reaches the runner") instead of on a missing import.
 */
const profilesModule = await import('../server/env/profiles.mjs');
const filterProfileVariables = profilesModule.filterProfileVariables
  ?? ((profile) => ({ variables: { ...(profile?.variables ?? {}) }, refused: [] }));

/**
 * The structural keys.
 *
 * The fallback is that list, so the test fails on the ASSERTION ("the
 * structural key is not reserved") rather than on a missing import.
 */
const STRUCTURAL_ENV_KEYS = profilesModule.STRUCTURAL_ENV_KEYS
  ?? ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC'];

/** A legacy project record: the old identifier, no `uid`. */
const legacyProject = (root) => ({
  id: 'proj_11111111-2222-3333-4444-555555555555',
  name: 'legacy',
  root,
  addedAt: '2026-01-01T00:00:00Z',
});

// ---------------------------------------------------------------------------
// 1. ONE PROJECT KEY
// ---------------------------------------------------------------------------

test('UT-ENV-004: the write, the list and the run path use ONE project key', () => {
  const project = legacyProject('D:/legacy-root');
  const store = envStoreOf({ schema: 1, projects: [project], runs: [] });
  setWhitelist(store, project, ['BASE_URL']);
  upsertProfile(store, project, {
    name: 'staging',
    environment: 'staging',
    variables: { BASE_URL: 'http://legacy.example.test' },
  });

  // The key the store files a profile under.
  assert.equal(
    projectKeyOf(project),
    projectUidOf(project),
    'the store key and the run key are different identifiers'
  );

  // The profile is listed under the SAME key the run path looks it up by.
  const listed = profilesOfProject(store, projectUidOf(project));
  assert.equal(listed.length, 1, 'the run path cannot see the profile the API listed');
  assert.ok(findProfile(store, projectUidOf(project), 'staging'), 'the run path finds no profile');
});

test('UT-ENV-005: the migration re-keys the profiles AND the whitelists', () => {
  const root = path.join(os.tmpdir(), 'ats212-migrate');
  const project = legacyProject(root);
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
  assert.notEqual(migrated.id, project.id, 'the project was not migrated at all');

  const store2 = envStoreOf(next);
  // The profile is still there, under the NEW project key.
  assert.equal(profilesOfProject(store2, projectUidOf(migrated)).length, 1, 'the profile was orphaned');
  assert.ok(findProfile(store2, projectUidOf(migrated), 'staging'), 'the run path finds no profile');
  // The custom whitelist survived -- it did NOT fall back to the default.
  const wl = whitelistForProject(store2, migrated);
  assert.equal(wl.source, 'custom', 'the custom whitelist was lost');
  assert.deepEqual(wl.names, ['BASE_URL']);
  // The stale key is gone.
  assert.equal(store2.whitelists[project.id], undefined, 'the legacy whitelist key survived');
});

test('UT-ENV-006: the migration re-derives the profile uid and rewrites the runs', () => {
  const root = path.join(os.tmpdir(), 'ats212-migrate-uid');
  const project = legacyProject(root);
  const state = { schema: 1, projects: [project], runs: [], uidRegistry: { version: 1, projects: {} } };
  const store = envStoreOf(state);
  // A profile that an OLDER build filed under the LEGACY project key.
  // That is the case the migration has to move: the owner changes, so the
  // derived uid changes with it.
  const legacyKeyed = {
    id: 'env_1_legacykeyed',
    uid: 'env_1_legacykeyed',
    projectUid: project.id,
    name: 'staging',
    environment: 'staging',
    variables: { BASE_URL: 'http://legacy.example.test' },
  };
  store.profiles = [legacyKeyed];
  const oldUid = legacyKeyed.uid;
  // A run that named the profile under its OLD identifier.
  state.runs = [{ id: 'run_legacy', uid: 'run_legacy', projectId: project.id, file: 'a.spec.ts', envUid: oldUid }];

  const plan = planMigration(state);
  const next = plan.state ?? plan.nextState ?? plan;
  const migrated = next.projects[0];
  const newUid = next.envProfiles.profiles[0].uid;
  assert.notEqual(newUid, oldUid, 'the profile uid was not re-derived');
  // The re-derived uid is RECOMPUTABLE: the same rule the runtime uses.
  assert.equal(newUid, envUidFor(projectUidOf(migrated), 'staging'));
  // The owner was re-keyed too.
  assert.equal(next.envProfiles.profiles[0].projectUid, projectUidOf(migrated));
  // The run that named the profile still names it.
  assert.equal(next.runs[0].envUid, newUid, 'the run points at a profile that no longer exists');
});

test('UT-ENV-007: a profile already under the canonical key keeps its uid', () => {
  const root = path.join(os.tmpdir(), 'ats212-migrate-keep');
  const project = legacyProject(root);
  const state = { schema: 1, projects: [project], runs: [], uidRegistry: { version: 1, projects: {} } };
  const store = envStoreOf(state);
  // The profile was filed under the canonical key -- which is what the
  // current write path does. The migration must leave it alone.
  upsertProfile(store, project, {
    name: 'staging',
    environment: 'staging',
    variables: { BASE_URL: 'http://legacy.example.test' },
  });
  const oldUid = store.profiles[0].uid;

  const plan = planMigration(state);
  const next = plan.state ?? plan.nextState ?? plan;
  const migrated = next.projects[0];
  assert.equal(next.envProfiles.profiles[0].uid, oldUid, 'a canonical profile was renamed');
  assert.equal(
    next.envProfiles.profiles[0].projectUid,
    projectUidOf(migrated),
    'the profile is not filed under the project key any more'
  );
  assert.ok(findProfile(envStoreOf(next), projectUidOf(migrated), 'staging'), 'the profile was orphaned');
});

// ---------------------------------------------------------------------------
// 2. THE WHITELIST CONSTRAINS THE RUN
// ---------------------------------------------------------------------------

test('UT-ENV-017: a name removed from the whitelist does not reach the runner', () => {
  const profile = { variables: { BASE_URL: 'http://x.test', TENANT: 'acme' } };
  const { variables, refused } = filterProfileVariables(profile, ['TENANT']);
  assert.equal(variables.BASE_URL, undefined, 'the removed name still reaches the runner');
  assert.equal(variables.TENANT, 'acme');
  assert.equal(refused.length, 1, 'the removal was not reported');
  assert.equal(refused[0].name, 'BASE_URL');
  assert.ok(refused[0].reason, 'the removal has no reason');
});

test('UT-ENV-018: the runner environment carries only the filtered variables', () => {
  const profile = { variables: { BASE_URL: 'http://x.test', TENANT: 'acme' } };
  const { variables } = filterProfileVariables(profile, ['TENANT']);
  const env = buildRunnerEnv({ variables });
  assert.equal(env.BASE_URL, undefined);
  assert.equal(env.TENANT, 'acme');
});

test('UT-ENV-019: an empty whitelist filters EVERYTHING out', () => {
  const profile = { variables: { BASE_URL: 'http://x.test' } };
  const { variables, refused } = filterProfileVariables(profile, []);
  assert.deepEqual(variables, {});
  assert.equal(refused.length, 1);
});

// ---------------------------------------------------------------------------
// 3. AN EMPTY WHITELIST IS AN EMPTY WHITELIST
// ---------------------------------------------------------------------------

test('UT-ENV-022: an empty configured whitelist is NOT the default whitelist', () => {
  const project = { id: 'proj_1_aaaa', root: 'D:/p' };
  const store = envStoreOf({ schema: 1, projects: [project], runs: [] });
  // Before the fix: `names: []` was treated as "not configured", so the
  // 14-name default list was in force -- the request WIDENED the boundary.
  setWhitelist(store, project, []);
  const wl = whitelistForProject(store, project);
  assert.equal(wl.source, 'custom', 'the empty list was treated as "not configured"');
  assert.deepEqual(wl.names, [], 'the default list came back');
});

test('UT-ENV-023: a project with no configured whitelist still gets the default', () => {
  const project = { id: 'proj_1_aaaa', root: 'D:/p' };
  const store = envStoreOf({ schema: 1, projects: [project], runs: [] });
  const wl = whitelistForProject(store, project);
  assert.equal(wl.source, 'default');
  assert.ok(wl.names.length > 0);
});

// ---------------------------------------------------------------------------
// 4a. THE CASE-COLLIDING NAMES ARE REFUSED, NOT COLLAPSED
// ---------------------------------------------------------------------------

test('UT-ENV-035: two spellings of one name are refused and both are reported', () => {
  const { variables, rejected } = normaliseVariables(
    { base_url: 'http://first.test', BASE_URL: 'http://second.test' },
    { whitelist: ['BASE_URL'] }
  );
  assert.equal(variables.BASE_URL, undefined, 'one of the two values was silently kept');
  assert.equal(rejected.length, 2, 'not every colliding spelling was reported');
  const names = rejected.map((r) => r.name).sort();
  assert.deepEqual(names, ['BASE_URL', 'base_url']);
  // The reason names BOTH spellings, so the caller sees the whole conflict.
  const reason = rejected.map((r) => r.reason).join(' ');
  assert.match(reason, /base_url/);
  assert.match(reason, /BASE_URL/);
});

test('UT-ENV-036: a single spelling of a lower-case name is normalised, not refused', () => {
  const { variables, rejected } = normaliseVariables(
    { base_url: 'http://only.test' },
    { whitelist: ['BASE_URL'] }
  );
  assert.equal(rejected.length, 0);
  assert.equal(variables.BASE_URL, 'http://only.test');
});

// ---------------------------------------------------------------------------
// 4b. THE STRUCTURAL KEYS ARE CASE-INSENSITIVE
// ---------------------------------------------------------------------------

test('UT-ENV-044: a reserved structural name is refused whatever its case', () => {
  for (const name of ['WINDIR', 'windir', 'Windir', 'SYSTEMROOT', 'systemroot', 'COMSPEC', 'comspec', 'Path', 'PATH']) {
    const { variables, rejected } = normaliseVariables(
      { [name]: 'C:\\profile-override' },
      { whitelist: ['WINDIR', 'SYSTEMROOT', 'COMSPEC', 'PATH'] }
    );
    assert.equal(
      variables[name.toUpperCase()],
      undefined,
      `the profile set the structural key ${name}`
    );
    assert.equal(rejected.length, 1, `the structural key ${name} was not refused`);
  }
});

test('UT-ENV-045: the platform value of a structural key wins over the profile', () => {
  // The whitelist permits WINDIR; the profile nevertheless names it.
  const { variables } = normaliseVariables(
    { WINDIR: 'C:\\profile-windir' },
    { whitelist: ['WINDIR'] }
  );
  const env = buildRunnerEnv({ variables }, { baseEnv: { windir: 'C:\\WINDOWS', PATH: 'C:\\bin' } });
  // Every spelling of the structural key is gone, and the platform's own
  // value is back under the host's spelling.
  assert.equal(env.WINDIR, undefined, 'the profile spelling survived');
  assert.equal(env.windir, 'C:\\WINDOWS');
  assert.equal(env.PATH, 'C:\\bin');
});

test('UT-ENV-046: the structural key is applied ONCE, under the host spelling', () => {
  const env = buildRunnerEnv(
    { variables: {} },
    { baseEnv: { Path: 'C:\\bin', SystemRoot: 'C:\\WINDOWS', windir: 'C:\\WINDOWS' } }
  );
  const spellings = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
  assert.equal(spellings.length, 1, `the block carries the structural key twice: ${JSON.stringify(spellings)}`);
  assert.equal(env.Path, 'C:\\bin');
});

test('UT-ENV-047: the structural keys are a subset of the reserved names', () => {
  const reserved = new Set(RESERVED_ENV_NAMES.map((n) => n.toUpperCase()));
  for (const key of STRUCTURAL_ENV_KEYS) {
    assert.ok(reserved.has(key.toUpperCase()), `${key} is structural but not reserved`);
  }
});

// ---------------------------------------------------------------------------
// 4c. THE CORS PRE-FLIGHT ALLOWS DELETE
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4d. THE RESERVED NAMES CONSTRAIN THE RUN AS WELL
// ---------------------------------------------------------------------------

test('UT-ENV-060: a name that is reserved now does not reach the runner', () => {
  // A profile stored by an earlier build can carry a name that has since
  // become reserved: the reserved list grows, the stored profiles do not.
  // The name must therefore be refused at the RUN as well, so that a name
  // the platform or the engine owns never reaches the child process.
  const profile = {
    variables: {
      BASE_URL: 'http://x.test',
      SSL_CERT_FILE: 'C:/evil.pem',
      WINDIR: 'C:/evil',
    },
  };
  const { variables, refused } = filterProfileVariables(profile, [
    'BASE_URL',
    'SSL_CERT_FILE',
    'WINDIR',
  ]);
  assert.equal(variables.SSL_CERT_FILE, undefined, 'a reserved name still reaches the runner');
  assert.equal(variables.WINDIR, undefined, 'a reserved name still reaches the runner');
  assert.equal(variables.BASE_URL, 'http://x.test', 'an allowed name was dropped');
  const refusedNames = refused.map((r) => r.name).sort();
  assert.deepEqual(refusedNames, ['SSL_CERT_FILE', 'WINDIR'], 'the refusal was not reported');
  for (const r of refused) {
    assert.match(r.reason, /reserved/i, `the refusal of ${r.name} has no reason`);
  }
  // The runner environment carries neither of them.
  const env = buildRunnerEnv({ variables });
  assert.equal(env.SSL_CERT_FILE, undefined);
  assert.equal(env.WINDIR, undefined);
});

// ---------------------------------------------------------------------------
// 4e. THE MIGRATION DOES NOT PRODUCE TWO PROFILES WITH ONE IDENTIFIER
// ---------------------------------------------------------------------------

test('UT-ENV-061: the migration keeps ONE profile per identifier and reports the drop', () => {
  // The same project can hold a profile under the legacy project key and
  // under the canonical project key -- one written by an older build, one
  // by the current one. Both derive the SAME identifier, so the migration
  // must keep one of them and REPORT the other; two records with one
  // identifier cannot both be written into the `env_profiles` table, so the
  // mirror import would fail with a UNIQUE constraint violation.
  const root = path.join(os.tmpdir(), 'ats212-migrate-collision');
  const project = legacyProject(root);
  const legacyUid = project.id;
  const state = {
    schema: 1,
    projects: [project],
    runs: [],
    uidRegistry: { version: 1, projects: {} },
  };
  const canonicalUid = projectUidOf(project);
  const profile = (owner, url) => ({
    id: envUidFor(owner, 'staging'),
    uid: envUidFor(owner, 'staging'),
    projectUid: owner,
    name: 'staging',
    environment: 'staging',
    variables: { BASE_URL: url },
  });
  state.envProfiles = {
    version: 1,
    profiles: [
      profile(legacyUid, 'http://from-the-legacy-key'),
      profile(canonicalUid, 'http://from-the-canonical-key'),
    ],
    whitelists: { [legacyUid]: ['BASE_URL'], [canonicalUid]: ['TENANT'] },
  };

  const plan = planMigration(state);
  const next = plan.state ?? plan.nextState ?? plan;
  const migrated = next.projects[0];

  // ONE profile for the project, and its identifiers are all distinct.
  const store = envStoreOf(next);
  const mine = profilesOfProject(store, projectUidOf(migrated));
  assert.equal(mine.length, 1, `the project holds ${mine.length} profiles after the migration`);
  const uids = mine.map((p) => p.uid);
  assert.equal(new Set(uids).size, uids.length, 'two profiles share one identifier');

  // The record under the CANONICAL key wins: it is the newer one.
  assert.equal(mine[0].variables.BASE_URL, 'http://from-the-canonical-key');

  // The drop is REPORTED, so nothing disappears without a trace.
  const changes = plan.changes ?? plan.nextChanges ?? [];
  const dropped = changes.filter((c) => c.kind === 'env-profile-dropped');
  assert.ok(dropped.length >= 1, 'the dropped profile was not reported');
  assert.ok(
    dropped.some((c) => c.profile === 'staging'),
    'the report does not name the dropped profile'
  );
});

// ---------------------------------------------------------------------------
// 5. THE COMMENTS DESCRIBE THE CODE
// ---------------------------------------------------------------------------

test('UT-ENV-058: the reserved-name policy is stated exactly, not as a family rule', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'server', 'env', 'profiles.mjs'),
    'utf8'
  );
  // The module must not claim that a whole family is reserved when only
  // individual names are: the `PLAYWRIGHT_*` and `SSL_*` families are not
  // reserved, the individual names in the list are.
  assert.doesNotMatch(
    source,
    /the `PLAYWRIGHT_\*` family/i,
    'the comment still claims the PLAYWRIGHT_* family is reserved'
  );
  // Every name the list names is really refused.
  for (const name of RESERVED_ENV_NAMES) {
    const { variables } = normaliseVariables(
      { [name.toLowerCase()]: 'x' },
      { whitelist: [name.toLowerCase()] }
    );
    assert.equal(
      Object.keys(variables).length,
      0,
      `${name} is in the reserved list but a profile could set it`
    );
  }
});

test('UT-ENV-059: the Windows run-time keys are documented', () => {
  // The Windows run-time (libuv) adds these keys to a child that was
  // spawned with a minimal environment. They are not secrets, but the
  // documentation has to say so -- "the sealed set is the base keys" is
  // not literally true on Windows.
  const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8');
  const design = read('docs/04-DETAILED-DESIGN.md');
  const security = read('docs/11-SECURITY-RISK.md');
  const text = design + security;
  for (const key of ['HOMEDRIVE', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN']) {
    assert.match(text, new RegExp(key), `the auto-added key ${key} is not documented`);
  }
});
