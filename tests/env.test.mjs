/**
 * ATS-212 -- the environment profiles: the unit tests.
 *
 * WHAT IS ASSERTED HERE
 * ---------------------
 * The four properties the acceptance criteria ask for, each at the level
 * where it can be measured:
 *
 *   1. THE WHITELIST HOLDS. A variable that is not on the project's
 *      whitelist is REFUSED, with the reason -- not silently dropped.
 *   2. A CREDENTIAL IS REFUSED. A credential-shaped name is refused even
 *      when the whitelist permits it, and the refusal says where the
 *      credential belongs instead.
 *   3. THE RUNNER ENVIRONMENT IS SEALED. The child process receives the
 *      profile's variables and the platform base keys -- and NOT the host's
 *      own environment, so an operator's secret cannot reach the code
 *      under test.
 *   4. THE RUN RECORDS THE PROFILE, NOT ITS VALUES. The run carries the
 *      profile's identifier and the NAMES of its variables; the values are
 *      never written into the run record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import {
  ENVIRONMENTS,
  BASE_ENV_KEYS,
  RESERVED_ENV_NAMES,
  isValidEnvName,
  envUidFor,
  normaliseVariables,
  buildRunnerEnv,
  envVarNames,
  validateProfile,
  buildProfile,
} from '../server/env/profiles.mjs';
import {
  DEFAULT_ENV_WHITELIST,
  isCredentialShapedName,
  matchesWhitelistEntry,
  whitelistOf,
  checkEnvName,
  validateWhitelist,
} from '../server/env/whitelist.mjs';
import { probeCommand } from '../server/adapters/contract.mjs';
import {
  envStoreOf,
  emptyEnvStore,
  profilesOfProject,
  findProfile,
  whitelistForProject,
  upsertProfile,
  removeProfile,
  setWhitelist,
  publicProfile,
} from '../server/env/store.mjs';

// ---------------------------------------------------------------------------
// The identity of a profile
// ---------------------------------------------------------------------------

test('UT-ENV-001: the profile id is derived from the project and the name', () => {
  const a = envUidFor('proj_1_aaaa', 'staging');
  const b = envUidFor('proj_1_aaaa', 'staging');
  assert.equal(a, b, 'the same project and name must give the same id');
  assert.match(a, /^env_1_[0-9a-f]{24}$/);
  // A different name is a different profile.
  assert.notEqual(a, envUidFor('proj_1_aaaa', 'production'));
  // A different project is a different profile -- the id is not global.
  assert.notEqual(a, envUidFor('proj_1_bbbb', 'staging'));
});

test('UT-ENV-002: the profile id does not collide across a name boundary', () => {
  // Without a separator, "proj_1_aa" + "bc" and "proj_1_aab" + "c" would
  // hash the same string. The separator is what keeps them apart.
  assert.notEqual(envUidFor('proj_1_aa', 'bc'), envUidFor('proj_1_aab', 'c'));
});

// ---------------------------------------------------------------------------
// The name of a variable
// ---------------------------------------------------------------------------

test('UT-ENV-003: a variable name must be an upper-case word', () => {
  assert.equal(isValidEnvName('BASE_URL'), true);
  assert.equal(isValidEnvName('FEATURE_X1'), true);
  assert.equal(isValidEnvName('A'), true);
  // Lower case is normalised to upper case, but the raw form is not a
  // valid name -- the normaliser is what upper-cases it.
  assert.equal(isValidEnvName('base_url'), false);
  // A name that cannot be expressed in an environment block is refused.
  assert.equal(isValidEnvName('A=B'), false);
  assert.equal(isValidEnvName('A B'), false);
  assert.equal(isValidEnvName('A\nB'), false);
  assert.equal(isValidEnvName(''), false);
  assert.equal(isValidEnvName('1A'), false);
  assert.equal(isValidEnvName(null), false);
});

// ---------------------------------------------------------------------------
// The whitelist
// ---------------------------------------------------------------------------

test('UT-ENV-010: a name that is not on the whitelist is refused with a reason', () => {
  const check = checkEnvName('SOME_UNKNOWN', DEFAULT_ENV_WHITELIST);
  assert.equal(check.allowed, false);
  assert.match(check.reason, /whitelist/);
  // A name that IS on the whitelist passes.
  assert.equal(checkEnvName('BASE_URL', DEFAULT_ENV_WHITELIST).allowed, true);
});

test('UT-ENV-011: the normaliser REFUSES a name that is not whitelisted -- it does not drop it silently', () => {
  const { variables, rejected } = normaliseVariables(
    { BASE_URL: 'https://staging.example', NOT_ON_THE_LIST: 'x' },
    { whitelist: ['BASE_URL'] }
  );
  // The allowed variable is kept.
  assert.equal(variables.BASE_URL, 'https://staging.example');
  // The refused one is NOT in the profile -- and it is REPORTED.
  assert.equal('NOT_ON_THE_LIST' in variables, false);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].name, 'NOT_ON_THE_LIST');
  assert.match(rejected[0].reason, /whitelist/);
});

test('UT-ENV-012: a credential-shaped name is refused even when the whitelist permits it', () => {
  // The whitelist explicitly authorises it -- and the credential rule
  // still refuses it, because a credential belongs in the credential store
  // (FR-027's proper home), not in a profile.
  const whitelist = ['BASE_URL', 'API_TOKEN', 'DB_PASSWORD', 'MY_SECRET'];
  for (const name of ['API_TOKEN', 'DB_PASSWORD', 'MY_SECRET']) {
    const check = checkEnvName(name, whitelist);
    assert.equal(check.allowed, false, `${name} was allowed`);
    assert.match(check.reason, /credential/i, `${name}: ${check.reason}`);
  }
  // A name that is not credential-shaped still passes.
  assert.equal(checkEnvName('BASE_URL', whitelist).allowed, true);
});

test('UT-ENV-013: the credential check is case-insensitive', () => {
  // A lower-case spelling must not be a way around the rule.
  assert.equal(isCredentialShapedName('api_token'), true);
  assert.equal(isCredentialShapedName('Api_Token'), true);
  assert.equal(isCredentialShapedName('API_TOKEN'), true);
  assert.equal(isCredentialShapedName('BASE_URL'), false);
});

test('UT-ENV-014: a whitelist entry may be a name or a single trailing star', () => {
  assert.equal(matchesWhitelistEntry('BASE_URL', 'BASE_URL'), true);
  assert.equal(matchesWhitelistEntry('base_url', 'BASE_URL'), true);
  assert.equal(matchesWhitelistEntry('FEATURE_X', 'FEATURE_*'), true);
  assert.equal(matchesWhitelistEntry('FEATURE_', 'FEATURE_*'), true);
  // A general glob is NOT supported: a mistyped entry must not widen the
  // whitelist further than its author intended.
  assert.equal(matchesWhitelistEntry('BASE_URL', 'BASE_*'), true);
  assert.equal(matchesWhitelistEntry('BASE_URL', '*'), false);
  assert.equal(matchesWhitelistEntry('BASE_URL', 'BASE_?RL'), false);
});

test('UT-ENV-015: a whitelist cannot authorise a credential-shaped name', () => {
  const { names, problems } = validateWhitelist(['BASE_URL', 'API_TOKEN', 'BAD NAME', 'FEATURE_*']);
  assert.deepEqual(names, ['BASE_URL', 'FEATURE_*']);
  // The credential-shaped name is refused ...
  assert.ok(problems.some((p) => p.name === 'API_TOKEN'), JSON.stringify(problems));
  // ... and so is the malformed one.
  assert.ok(problems.some((p) => p.name === 'BAD NAME'), JSON.stringify(problems));
});

test('UT-ENV-016: the whitelist of a project reports where it came from', () => {
  assert.equal(whitelistOf({}).source, 'default');
  assert.deepEqual(whitelistOf({}).names, [...DEFAULT_ENV_WHITELIST]);
  assert.equal(whitelistOf({ envWhitelist: ['ONLY_THIS'] }).source, 'custom');
  assert.deepEqual(whitelistOf({ envWhitelist: ['only_this'] }).names, ['ONLY_THIS']);
});

// ---------------------------------------------------------------------------
// The reserved names
// ---------------------------------------------------------------------------

test('UT-ENV-020: a reserved name is refused even when the whitelist permits it', () => {
  // The reserved check runs BEFORE the whitelist check: `PATH` is on no
  // whitelist, but a project that put it on its own whitelist must still
  // not be able to break the child process.
  const whitelist = [...DEFAULT_ENV_WHITELIST, 'PATH', 'NODE_OPTIONS'];
  for (const name of ['PATH', 'NODE_OPTIONS']) {
    const { variables, rejected } = normaliseVariables({ [name]: 'x' }, { whitelist });
    assert.equal(variables[name], undefined, `${name} was accepted`);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /reserved/);
  }
});

test('UT-ENV-021: the reserved names cover the loader hijack and the engine output', () => {
  // The families that would break the platform or redirect the evidence.
  for (const name of ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS']) {
    assert.ok(RESERVED_ENV_NAMES.includes(name), `${name} is not reserved`);
  }
  for (const name of ['PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_HTML_OUTPUT_DIR']) {
    assert.ok(RESERVED_ENV_NAMES.includes(name), `${name} is not reserved`);
  }
});

// ---------------------------------------------------------------------------
// The sealed runner environment
// ---------------------------------------------------------------------------

test('UT-ENV-030: the runner environment does NOT carry the host environment', () => {
  // The host environment holds something that looks like a credential.
  const host = {
    PATH: '/usr/bin',
    HOME: '/home/op',
    AWS_SECRET_ACCESS_KEY: 'the-host-secret',
    GITHUB_TOKEN: 'another-host-secret',
  };
  const env = buildRunnerEnv(
    { variables: { BASE_URL: 'https://staging.example' } },
    { baseEnv: host }
  );
  // The profile's variable IS there.
  assert.equal(env.BASE_URL, 'https://staging.example');
  // The host's secrets are NOT.
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, 'the host secret reached the runner');
  assert.equal(env.GITHUB_TOKEN, undefined, 'the host token reached the runner');
  // The base keys the child needs ARE there.
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/op');
});

test('UT-ENV-031: the runner environment carries ONLY the base keys and the profile', () => {
  const host = { PATH: '/bin', HOME: '/h', RANDOM_HOST_VAR: 'x', ANOTHER: 'y' };
  const env = buildRunnerEnv({ variables: { BASE_URL: 'u' } }, { baseEnv: host });
  const allowed = new Set([...BASE_ENV_KEYS, 'BASE_URL']);
  for (const key of Object.keys(env)) {
    assert.ok(allowed.has(key), `the runner environment carries ${key}`);
  }
});

test('UT-ENV-032: the runner environment is sealed even without a profile', () => {
  const host = { PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'secret' };
  const env = buildRunnerEnv(null, { baseEnv: host });
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.PATH, '/bin');
  assert.deepEqual(Object.keys(env).filter((k) => !BASE_ENV_KEYS.includes(k)), []);
});

test('UT-ENV-033: the adapter-owned variables are applied LAST', () => {
  // The engine's contract is that the report goes where the adapter says,
  // not where a profile says -- so the adapter's variables win.
  const env = buildRunnerEnv(
    { variables: { PLAYWRIGHT_JSON_OUTPUT_FILE: '/tmp/from-the-profile' } },
    {
      baseEnv: { PATH: '/bin' },
      extra: { PLAYWRIGHT_JSON_OUTPUT_FILE: '/run/report.json' },
    }
  );
  assert.equal(env.PLAYWRIGHT_JSON_OUTPUT_FILE, '/run/report.json');
});

test('UT-ENV-034: the platform keys survive a profile that tries to override them', () => {
  // A profile cannot break the child process by overriding PATH.
  const env = buildRunnerEnv(
    { variables: { PATH: '/evil' } },
    { baseEnv: { PATH: '/usr/bin', SystemRoot: 'C:\\Windows' } }
  );
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.SystemRoot, 'C:\\Windows');
});

// ---------------------------------------------------------------------------
// The profile record
// ---------------------------------------------------------------------------

test('UT-ENV-040: a profile is validated against the whitelist before it is built', () => {
  const { profile, problems, rejected } = validateProfile(
    { name: 'staging', environment: 'staging', variables: { BASE_URL: 'u', NOPE: 'x' } },
    { whitelist: ['BASE_URL'] }
  );
  assert.deepEqual(problems, []);
  assert.equal(profile.name, 'staging');
  assert.equal(profile.environment, 'staging');
  assert.equal(profile.variables.BASE_URL, 'u');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].name, 'NOPE');
});

test('UT-ENV-041: a profile without a name or with an unknown tier is refused', () => {
  const noName = validateProfile({ environment: 'dev', variables: {} }, { whitelist: [] });
  assert.ok(noName.problems.some((p) => p.name === 'name'));
  const badTier = validateProfile({ name: 'x', environment: 'production', variables: {} }, { whitelist: [] });
  assert.ok(badTier.problems.some((p) => p.name === 'environment'));
  // The tiers are exactly the ones the product has.
  assert.deepEqual([...ENVIRONMENTS], ['dev', 'staging', 'prod']);
});

test('UT-ENV-042: building a profile that is invalid throws with the problems attached', () => {
  assert.throws(
    () => buildProfile({ name: '', environment: 'dev', variables: {} }, { projectUid: 'proj_1_a' }),
    (e) => e.code === 'INVALID_ENV_PROFILE' && Array.isArray(e.problems)
  );
});

test('UT-ENV-043: the run records the NAMES of the variables, never the values', () => {
  const names = envVarNames({ variables: { BASE_URL: 'https://x', TENANT: 'acme' } });
  assert.deepEqual(names, ['BASE_URL', 'TENANT']);
  // The names do not carry the values.
  assert.equal(names.some((n) => n.includes('https://x')), false);
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test('UT-ENV-050: the store of a state without the field is empty, and the state stays loadable', () => {
  // A state written before ATS-212 has no `envProfiles`. It must load.
  const state = { schema: 1, projects: [], runs: [] };
  const store = envStoreOf(state);
  assert.deepEqual(store.profiles, []);
  assert.deepEqual(store.whitelists, {});
  // The field is now part of the state -- additively.
  assert.ok(state.envProfiles);
});

test('UT-ENV-051: a profile is created, found and removed', () => {
  const state = {};
  const store = envStoreOf(state);
  const project = { id: 'proj_1_aaaa', uid: 'proj_1_aaaa' };
  const { profile, rejected } = upsertProfile(store, project, {
    name: 'staging',
    environment: 'staging',
    variables: { BASE_URL: 'https://staging.example' },
  });
  assert.deepEqual(rejected, []);
  assert.equal(profile.name, 'staging');
  assert.equal(profile.variables.BASE_URL, 'https://staging.example');
  // The profile belongs to the project.
  assert.equal(profilesOfProject(store, 'proj_1_aaaa').length, 1);
  assert.equal(profilesOfProject(store, 'proj_1_bbbb').length, 0);
  // It is found by its name and by its id.
  assert.equal(findProfile(store, 'proj_1_aaaa', 'staging').uid, profile.uid);
  assert.equal(findProfile(store, 'proj_1_aaaa', profile.uid).uid, profile.uid);
  // It is removed.
  assert.equal(removeProfile(store, project, 'staging'), true);
  assert.equal(removeProfile(store, project, 'staging'), false);
});

test('UT-ENV-052: replacing a profile keeps its identifier', () => {
  const store = emptyEnvStore();
  const project = { id: 'proj_1_aaaa', uid: 'proj_1_aaaa' };
  const first = upsertProfile(store, project, {
    name: 'staging', environment: 'staging', variables: { BASE_URL: 'https://a' },
  }).profile;
  const second = upsertProfile(store, project, {
    name: 'staging', environment: 'staging', variables: { BASE_URL: 'https://b' },
  }).profile;
  // A run that referred to the profile still refers to the same profile.
  assert.equal(second.uid, first.uid);
  assert.equal(second.variables.BASE_URL, 'https://b');
  assert.equal(store.profiles.length, 1);
});

test('UT-ENV-053: a profile of one project is not visible to another', () => {
  const store = emptyEnvStore();
  upsertProfile(store, { id: 'proj_1_aaaa', uid: 'proj_1_aaaa' }, {
    name: 'staging', environment: 'staging', variables: { BASE_URL: 'u' },
  });
  assert.equal(findProfile(store, 'proj_1_bbbb', 'staging'), null);
});

test('UT-ENV-054: the configured whitelist wins over the built-in default', () => {
  const store = emptyEnvStore();
  const project = { id: 'proj_1_aaaa', uid: 'proj_1_aaaa' };
  assert.equal(whitelistForProject(store, project).source, 'default');
  setWhitelist(store, project, ['ONLY_THIS']);
  const wl = whitelistForProject(store, project);
  assert.equal(wl.source, 'custom');
  assert.deepEqual(wl.names, ['ONLY_THIS']);
  // A variable that is on the built-in default but not on the configured
  // whitelist is now refused.
  const { rejected } = upsertProfile(store, project, {
    name: 'p', environment: 'dev', variables: { BASE_URL: 'u' },
  });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].name, 'BASE_URL');
});

test('UT-ENV-055: a whitelist that authorises a credential is refused', () => {
  const store = emptyEnvStore();
  assert.throws(
    () => setWhitelist(store, { id: 'proj_1_aaaa', uid: 'proj_1_aaaa' }, ['API_TOKEN']),
    (e) => e.code === 'INVALID_ENV_WHITELIST'
  );
});

test('UT-ENV-056: the public view of a profile carries the names, never the values', () => {
  const view = publicProfile({
    uid: 'env_1_aaaa', id: 'env_1_aaaa', projectUid: 'proj_1_aaaa',
    name: 'staging', environment: 'staging',
    variables: { BASE_URL: 'https://secret.example', TENANT: 'acme' },
    createdAt: 'x', updatedAt: 'y',
  });
  assert.deepEqual(view.variables, ['BASE_URL', 'TENANT']);
  assert.equal(view.variableCount, 2);
  // The value does not cross the wire.
  assert.equal(JSON.stringify(view).includes('secret.example'), false);
});


test('UT-ENV-057: the capability probe does not hand the host environment to the project CLI', () => {
  // The probe runs the PROJECT'S OWN CLI (`node <project>/.../cli.js
  // --help`), so it is the same trust boundary as the run. It does not
  // inherit `{...process.env}`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats212-probe-'));
  const script = path.join(dir, 'show-env.js');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.env));');
  const HOST = 'the-host-secret-value';
  process.env.HOST_SECRET_MARKER = HOST;
  try {
    const r = probeCommand(process.execPath, [script], { cwd: dir });
    assert.equal(r.ok, true, r.stderr);
    const captured = JSON.parse(r.stdout);
    assert.equal(captured.HOST_SECRET_MARKER, undefined, 'the host secret reached the probe child');
    // The child still has what it needs to run.
    assert.ok(captured.PATH, 'the probe child has no PATH');
  } finally {
    delete process.env.HOST_SECRET_MARKER;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
