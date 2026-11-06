/**
 * ATS-212 -- the project ENVIRONMENT PROFILES: a controlled, auditable set
 * of environment variables that a run may carry, and the rules that decide
 * which of them may be handed to the runner.
 *
 * WHAT THIS PROBLEM IS
 * --------------------
 * A test run often needs an environment variable -- a base URL, a tenant, a
 * feature flag. The naive way to supply it is to let the caller post a bag
 * of variables into the run request. That has three defects:
 *
 *   1. It leaks the HOST's environment into the run, because the runner is
 *      spawned with `env: {...process.env, ...}`. Anything the operator has
 *      in their shell (their cloud credentials, their CI tokens) reaches the
 *      code under test, and the code under test can print it into a report
 *      that is archived as evidence.
 *   2. It has no audit trail. A run record says WHICH variables were used
 *      only if the caller remembered to say so.
 *   3. It has no boundary. There is no way to say "this variable may be
 *      overridden, that one may not".
 *
 * WHAT THIS MODULE DELIVERS
 * --------------------------
 * An *environment profile* is a named, project-scoped set of variables:
 *
 *   {
 *     id: 'env_1_<24 hex>',      // stable identifier
 *     projectUid: 'proj_1_...',
 *     name: 'staging',
 *     environment: 'staging',    // dev | staging | prod (the selectable tier)
 *     variables: { BASE_URL: '...' },   // the declared variables
 *     createdAt, updatedAt
 *   }
 *
 * Three rules make the whole thing controlled:
 *
 *   1. THE WHITELIST. A profile only carries the variables whose names are
 *      on the project's whitelist. A name that is not on it is refused at
 *      write time, with the reason -- it is not silently dropped, because a
 *      dropped variable turns into "the run behaved differently and nobody
 *      knows why".
 *
 *   2. THE SEALED SET. The runner is NOT spawned with the host environment
 *      plus the profile. It is spawned with an explicit, minimal set: the
 *      variables the profile declares, plus the few the engines need to
 *      behave (PATH, SystemRoot, HOME, ...). The host's secrets therefore
 *      do not reach the code under test.
 *
 *   3. THE AUDITABLE REFERENCE. A run records `envUid` -- the profile it
 *      ran under -- and the NAMES of the variables it carried. The VALUES
 *      are NOT recorded in the run: a value may be a credential, and the run
 *      record is archived, mirrored into SQLite and shipped as evidence. The
 *      names are enough to say "this run ran under the staging profile with
 *      BASE_URL and FEATURE_X"; the values are re-read from the profile when
 *      someone needs them.
 *
 * The value of a variable is stored in the profile, and a profile lives in
 * the bridge's data directory -- NOT in the repository. Nothing this module
 * writes ever goes into Git; the profile is part of the run assets, which is
 * the "配置不进入 Git" half of the acceptance criterion.
 */
import crypto from 'node:crypto';
import { checkEnvName, isCredentialShapedName } from './whitelist.mjs';

/** The separator between the parts of a UID seed; a NUL cannot occur in a name. */
const NUL = '\u0000';

/**
 * The environment tiers a profile may select. A run may only choose one of
 * these; the tier is part of the profile's identity in the API, so a caller
 * cannot invent a tier that the product does not have.
 */
export const ENVIRONMENTS = Object.freeze(['dev', 'staging', 'prod']);

/**
 * The variables that are ALWAYS present in a runner's environment, whatever
 * the profile says.
 *
 * These are the variables a child process needs to exist at all on the
 * supported platforms. They are the MINIMUM, not the host environment: the
 * point of the sealed set is that the host's own variables -- its tokens,
 * its cloud credentials -- do not reach the code under test.
 *
 * `PATH` is needed so the child can find its own tooling; `SystemRoot` and
 * `ComSpec` are needed on Windows for the DLL loader and for `cmd`; `HOME`
 * and `TMPDIR` are the places a test writes its scratch files.
 */
export const BASE_ENV_KEYS = Object.freeze([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'NODE_PATH',
]);

/**
 * The variable names that may NEVER be put in a profile, whatever the
 * whitelist says.
 *
 * A whitelist is an ALLOW list, so a name on it is permitted -- but these
 * names are refused even then, because they are the ones that break the
 * platform or the security boundary when they are overridden:
 *
 *   * `PATH` and its relatives, and the other STRUCTURAL keys
 *     (`SystemRoot`, `windir`, `ComSpec`): overriding them makes the child
 *     unable to find its own interpreter or unable to exist at all.
 *   * `NODE_OPTIONS`: it is evaluated by Node BEFORE the program runs, so a
 *     profile could turn into arbitrary code execution.
 *   * `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES`: the classic loader hijack.
 *   * the ADAPTER-OWNED output variables of the engine (the exact names are
 *     listed below): they say where the report goes, so a profile must not
 *     redirect the evidence.
 *   * `PWDEBUG`: it puts the engine into its INTERACTIVE debug mode, which
 *     waits for a human -- a profile must not be able to hang a run.
 *   * the proxy variables (`HTTP_PROXY` and friends) and the TLS trust
 *     variables (`NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`,
 *     `SSL_CERT_FILE`): they decide where the traffic goes and whether it is
 *     verified, so a profile could silently redirect the traffic of a run.
 *
 * THE LIST IS EXACT, NOT A FAMILY RULE. It names the specific variables
 * that are refused. It does NOT refuse every `PLAYWRIGHT_*` or every
 * `*_PROXY` name. The two facts are different things:
 *
 *   * the variables in the list below are REFUSED at write time;
 *   * the OTHER engine variables a profile may name (e.g.
 *     `PLAYWRIGHT_HTML_REPORT`) cannot move the evidence, because the
 *     adapter's own output variables are applied LAST when the runner
 *     environment is built. That is a property of the ORDER, not of the
 *     list, and it is measured by the ATS-212 probe.
 *
 * The refusal is a REFUSAL, not a filter: the caller is told which name was
 * refused and why, so the profile can be fixed.
 *
 * The comparison is CASE-INSENSITIVE: an environment block does not
 * distinguish `PATH` from `Path`, so the names are compared in upper case.
 */
export const RESERVED_ENV_NAMES = Object.freeze([
  // the structural keys: the child cannot exist without them
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  // the loader and the interpreter
  'NODE_OPTIONS', 'NODE_PATH',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  // the adapter-owned output variables of the engine
  'PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_HTML_OUTPUT_DIR', 'PLAYWRIGHT_HTML_OPEN',
  'PLAYWRIGHT_BROWSERS_PATH',
  // the engine's interactive debug mode
  'PWDEBUG',
  // the proxy variables
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  // the TLS trust variables
  'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
]);

/**
 * The STRUCTURAL keys -- the ones the child process needs to exist at all.
 *
 * They are re-applied unconditionally when the runner environment is built,
 * and the comparison is case-insensitive: Windows does not distinguish
 * `WINDIR` from `windir`, and Node itself de-duplicates the keys of an
 * environment block case-insensitively. A profile that named `WINDIR` could
 * therefore win over the platform's own `windir` and point the child at a
 * directory of the profile's choosing.
 */
export const STRUCTURAL_ENV_KEYS = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
]);

/**
 * The shape of a variable NAME.
 *
 * A name has to look like a variable name on every platform the bridge runs
 * on: an upper-case word, optionally with underscores. The rule is not
 * cosmetic -- a name with a newline, an `=` or a NUL cannot be expressed in
 * an environment block at all, and a name with a space would be split by the
 * shell of some CI runner.
 */
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** True when `name` is a syntactically usable environment variable name. */
export function isValidEnvName(name) {
  return typeof name === 'string' && ENV_NAME_RE.test(name);
}

/**
 * The identity of an environment profile.
 *
 * The identifier is DERIVED from the project and the name of the profile,
 * not random: re-registering the same profile name under the same project
 * yields the same identifier, so a run that refers to a profile can be
 * matched against the profile that is actually configured. The derivation
 * mirrors `projectUidFor` in `server/uid.mjs`: the project UID is the
 * recomputable part, and the name is what makes two profiles of one project
 * different.
 */
export function envUidFor(projectUid, name) {
  const basis = `${projectUid}${NUL}${String(name).trim().toLowerCase()}`;
  return `env_1_${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
}

/** The stable identifier of a profile. */
export function envUidForProfile(profile) {
  if (!profile) return null;
  return envUidFor(profile.projectUid ?? profile.projectId ?? '', profile.name ?? '');
}

/**
 * Normalises the declared variables of a profile.
 *
 * The result is a plain object whose keys are UPPER-CASE names and whose
 * values are strings. A value that is not a string is coerced, because the
 * environment is a map of strings and a number `80` and the string `80` are
 * the same environment value.
 *
 * TWO SPELLINGS OF ONE NAME ARE REFUSED, NOT COLLAPSED. An environment
 * block does not distinguish `BASE_URL` from `base_url`: on Windows the key
 * is compared case-insensitively, so the two are the SAME variable. A
 * request that carries both spellings therefore states two values for one
 * variable, and there is no honest way to pick one -- the request is
 * refused, and BOTH spellings are named in the refusal, so the caller can
 * see which two collided.
 *
 * @returns {{variables:object, rejected:Array<{name:string,reason:string}>}}
 *   `rejected` names the entries that were refused, with the reason. The
 *   caller must report them; a silently dropped variable is a variable the
 *   user believes is in effect but is not.
 */
export function normaliseVariables(variables, { whitelist = null, reserved = RESERVED_ENV_NAMES } = {}) {
  const out = {};
  const rejected = [];
  if (variables === null || variables === undefined) return { variables: out, rejected };
  if (typeof variables !== 'object' || Array.isArray(variables)) {
    return {
      variables: out,
      rejected: [{ name: '*', reason: 'the variables must be an object of name/value pairs' }],
    };
  }
  const reservedSet = new Set(reserved.map((n) => String(n).toUpperCase()));
  const entries = Object.entries(variables);
  // The spellings of every upper-case name, so that a name written twice in
  // two cases can be refused instead of collapsed.
  const spellings = new Map();
  for (const [rawName] of entries) {
    const spelling = String(rawName).trim();
    const upper = spelling.toUpperCase();
    if (!spellings.has(upper)) spellings.set(upper, []);
    spellings.get(upper).push(spelling);
  }
  for (const [rawName, rawValue] of entries) {
    const spelling = String(rawName).trim();
    const name = spelling.toUpperCase();
    if (!isValidEnvName(name)) {
      rejected.push({ name: String(rawName), reason: 'the name is not an upper-case environment variable name' });
      continue;
    }
    const variants = spellings.get(name) ?? [];
    if (variants.length > 1) {
      // The two spellings are one variable, and the request states two
      // values for it. Both are reported -- the refusal names every
      // spelling that collides, so the caller sees the whole conflict.
      rejected.push({
        name: spelling,
        reason: `the name is written in more than one case (${variants.join(', ')}); ` +
          'an environment block does not distinguish them, so the request would state two values for one variable',
      });
      continue;
    }
    if (reservedSet.has(name)) {
      rejected.push({ name, reason: 'the name is reserved by the platform or the engine and cannot be set by a profile' });
      continue;
    }
    if (whitelist !== null) {
      // The whitelist check carries BOTH rules: the name has to be
      // authorised, and it must not be credential-shaped. A credential
      // belongs in the credential store, not in a profile -- a profile
      // lives in the run assets, which are archived and mirrored.
      const check = checkEnvName(name, whitelist);
      if (!check.allowed) {
        rejected.push({ name, reason: check.reason });
        continue;
      }
    }
    const value = rawValue === null || rawValue === undefined ? '' : String(rawValue);
    if (value.includes('\0')) {
      rejected.push({ name, reason: 'the value contains a NUL character and cannot be put in an environment' });
      continue;
    }
    out[name] = value;
  }
  return { variables: out, rejected };
}

/**
 * The variables of a profile that the CURRENT whitelist still permits.
 *
 * THE WHITELIST CONSTRAINS THE RUN, NOT ONLY THE WRITE. A profile is
 * written against the whitelist that is in force at that moment; the
 * whitelist can be tightened afterwards, and a run that happens later must
 * then NOT carry the variables that were removed. Otherwise the whitelist
 * would only ever be a write-time check: the variable would still reach the
 * code under test, which is exactly the boundary the whitelist exists to
 * draw.
 *
 * THE RESERVED NAMES CONSTRAIN THE RUN AS WELL. The reserved list is
 * enforced when a profile is written, but a profile that was stored by an
 * EARLIER build can carry a name that has since become reserved -- the
 * reserved list grows, and the stored profiles do not. A name that is
 * reserved now is therefore refused here too, so that a name the platform
 * or the engine must own never reaches the runner just because it was
 * written a while ago. The comparison is case-insensitive, like the
 * environment block itself.
 *
 * The refused names are REPORTED, not silently dropped: the caller says
 * which variables of the profile did not reach the runner and why.
 *
 * @param {object} profile the environment profile
 * @param {string[]} whitelist the whitelist that is in force NOW
 * @param {object} [options]
 * @param {string[]} [options.reserved] the reserved names (defaults to the module's list)
 * @returns {{variables:object, refused:Array<{name:string,reason:string}>}}
 */
export function filterProfileVariables(profile, whitelist, { reserved = RESERVED_ENV_NAMES } = {}) {
  const out = {};
  const refused = [];
  const source = profile?.variables ?? {};
  const reservedSet = new Set(reserved.map((n) => String(n).toUpperCase()));
  for (const [name, value] of Object.entries(source)) {
    const upper = String(name).toUpperCase();
    if (reservedSet.has(upper)) {
      refused.push({
        name,
        reason: 'the name is reserved by the platform or the engine and cannot be set by a profile',
      });
      continue;
    }
    if (!Array.isArray(whitelist)) {
      out[name] = value;
      continue;
    }
    const check = checkEnvName(name, whitelist);
    if (!check.allowed) {
      refused.push({ name, reason: check.reason });
      continue;
    }
    out[name] = value;
  }
  return { variables: out, refused };
}

/**
 * The variables of a profile that are handed to the runner.
 *
 * This is the SEALED SET: the profile's own variables, plus the platform
 * variables the child process needs to run at all. The host's environment is
 * NOT passed on -- only the base keys are picked out of it, one by one.
 *
 * THE STRUCTURAL KEYS ARE RE-APPLIED CASE-INSENSITIVELY. Windows does not
 * distinguish `WINDIR` from `windir`, and Node de-duplicates the keys of an
 * environment block case-insensitively -- so a profile that named `WINDIR`
 * would beat the platform's own `windir` (the key that sorts first wins)
 * and point the child at a directory of the profile's choosing. Every
 * spelling of a structural key is therefore removed before the platform's
 * own value is applied, so the platform always wins.
 *
 * @param {object} profile the environment profile
 * @param {object} [options]
 * @param {object} [options.baseEnv] the host environment to pick the base keys out of
 * @param {object} [options.extra] variables the ADAPTER owns (the engine's own output paths)
 * @returns {object} the environment block for the child process
 */
export function buildRunnerEnv(profile, { baseEnv = process.env, extra = {} } = {}) {
  const env = {};
  // The base keys are picked out of the host environment ONE BY ONE, so a
  // variable the host happens to have and that the profile does not declare
  // never reaches the child.
  for (const key of BASE_ENV_KEYS) {
    const value = baseEnv?.[key];
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  // The profile's own variables win over the base keys -- except for the
  // reserved names, which never got this far (normaliseVariables refuses
  // them), and except for the base keys the child needs to run. A profile
  // that somehow carries `PATH` would break the child, so the base keys are
  // re-applied last for the ones that are structural.
  for (const [name, value] of Object.entries(profile?.variables ?? {})) {
    env[name] = String(value);
  }
  // The adapter's own variables (where the report goes) are applied LAST:
  // the engine's contract is that the report is written where the adapter
  // says, not where a profile says.
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (value === undefined || value === null) continue;
    env[name] = String(value);
  }
  // The STRUCTURAL keys are re-applied last and UNCONDITIONALLY: they are
  // the ones the child process needs to exist at all, and a profile must
  // not be able to break it. The normaliser already refuses the reserved
  // names, so this is the second line of defence -- the function that
  // builds the environment does not have to trust its caller.
  //
  // EVERY SPELLING of a structural key is removed first. The environment
  // block is case-insensitive on Windows, so a leftover `WINDIR` would
  // shadow the platform's `windir` depending on how the keys happen to sort
  // -- which is how a profile got to choose the child's `windir`.
  const structural = new Set(STRUCTURAL_ENV_KEYS);
  for (const key of Object.keys(env)) {
    if (structural.has(key.toUpperCase())) delete env[key];
  }
  // The platform's own value is applied ONCE per structural key, under the
  // spelling the host itself uses: `Path` on Windows, `PATH` elsewhere.
  // Applying both spellings would put the same key into the block twice,
  // and the block is case-insensitive.
  const applied = new Set();
  for (const key of BASE_ENV_KEYS) {
    const upper = key.toUpperCase();
    if (!structural.has(upper) || applied.has(upper)) continue;
    const value = baseEnv?.[key];
    if (value === undefined || value === null) continue;
    applied.add(upper);
    env[key] = String(value);
  }
  return env;
}

/**
 * The NAMES of the variables a run carried -- never their values.
 *
 * A run record is archived, mirrored into SQLite and shipped as evidence.
 * A value may be a credential, so only the names are recorded: they say
 * WHICH variables were in effect, which is what a reader of the run needs,
 * and they say nothing about the values.
 */
export function envVarNames(profile) {
  return Object.keys(profile?.variables ?? {}).sort();
}

/**
 * Validates a profile against the project's whitelist.
 *
 * Returns the profile in its normalised form together with the list of
 * refused entries. The caller decides what to do with the refusals: the
 * API layer refuses the whole request (a caller that asked for a variable
 * that is not allowed should be told, not given a partial profile).
 *
 * @param {object} input   the requested profile
 * @param {object} options
 * @param {string[]} options.whitelist the project's whitelist (null = no whitelist)
 * @param {string[]} [options.environments] the selectable tiers
 * @returns {{profile:object, rejected:Array}}
 */
export function validateProfile(input, { whitelist = null, environments = ENVIRONMENTS } = {}) {
  const problems = [];
  const name = String(input?.name ?? '').trim();
  if (!name) problems.push({ name: 'name', reason: 'the profile needs a name' });
  else if (name.length > 64) problems.push({ name: 'name', reason: 'the name is longer than 64 characters' });
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    problems.push({ name: 'name', reason: 'the name may only hold letters, digits, dots, dashes and underscores' });
  }
  const environment = String(input?.environment ?? '').trim().toLowerCase();
  if (!environments.includes(environment)) {
    problems.push({
      name: 'environment',
      reason: `the environment must be one of ${environments.join(', ')}`,
    });
  }
  const { variables, rejected } = normaliseVariables(input?.variables, { whitelist });
  return {
    profile: {
      name,
      environment,
      variables,
    },
    problems,
    rejected,
  };
}

/**
 * Builds the persisted record of a profile.
 *
 * @param {object} input the requested profile
 * @param {object} options
 * @param {string} options.projectUid the owner project
 * @param {string[]} [options.whitelist]
 * @param {string} [options.now] the timestamp (injected so a test can pin it)
 */
export function buildProfile(input, { projectUid, whitelist = null, environments = ENVIRONMENTS, now = null } = {}) {
  const { profile, problems, rejected } = validateProfile(input, { whitelist, environments });
  if (problems.length) {
    const e = new Error('INVALID_ENV_PROFILE');
    e.code = 'INVALID_ENV_PROFILE';
    e.problems = problems;
    throw e;
  }
  const stamp = now ?? new Date().toISOString();
  return {
    id: envUidFor(projectUid, profile.name),
    uid: envUidFor(projectUid, profile.name),
    projectUid,
    name: profile.name,
    environment: profile.environment,
    variables: profile.variables,
    createdAt: stamp,
    updatedAt: stamp,
    ...(rejected.length ? { rejected } : {}),
  };
}
