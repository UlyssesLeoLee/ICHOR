/**
 * ATS-212 -- the environment WHITELIST: the names a project's environment
 * profile may carry, and the rules that decide which of them are refused.
 *
 * WHY A WHITELIST AND NOT A BLACKLIST
 * -----------------------------------
 * A blacklist says "these names are forbidden". It has to be complete, and
 * it can never be: the next tool, the next platform, the next engine
 * introduces a variable whose name nobody has thought about. A whitelist
 * says "these names, and nothing else", so an unknown variable is refused
 * by default. The cost of the whitelist is that a new name has to be
 * added on purpose -- which is exactly the property the acceptance
 * criterion asks for.
 *
 * TWO KINDS OF REFUSAL
 * --------------------
 *   1. NOT ON THE WHITELIST -- the name is simply not permitted here.
 *   2. A CREDENTIAL-SHAPED NAME -- the name LOOKS like it holds a secret
 *      (`*_TOKEN`, `*_PASSWORD`, `*_SECRET`, `*_API_KEY`, ...). Those are
 *      refused EVEN when the whitelist permits them, because the credential
 *      store (FR-027's proper home) does not exist yet. Putting a password
 *      into a profile would put it into the run assets, the SQLite mirror
 *      and the evidence archive -- which is precisely what the requirement
 *      "单独安全凭据存储" forbids.
 *
 *      The refusal says so, and names the way out: the variable belongs in
 *      the credential store, not in a profile.
 *
 * THE WHITELIST ITSELF IS NOT IN GIT
 * ----------------------------------
 * A project may tighten its whitelist at runtime (the API exposes it), but
 * the whitelist is stored in the bridge's data directory together with the
 * profiles -- it is run configuration, not source. The DEFAULT whitelist
 * below is a conservative built-in that ships with the product; a project
 * that overrides it overrides it in its own data directory.
 */

/**
 * The default whitelist of a project that has not configured one.
 *
 * These are the names a test run commonly needs and that hold no secret:
 * the address of the system under test, a tenant, a locale, a feature flag.
 * Everything else has to be configured on purpose.
 */
export const DEFAULT_ENV_WHITELIST = Object.freeze([
  'BASE_URL',
  'API_URL',
  'APP_URL',
  'WEB_URL',
  'HOST',
  'PORT',
  'TENANT',
  'TENANT_ID',
  'LOCALE',
  'LANG',
  'TIMEOUT_MS',
  'BROWSER',
  'HEADLESS',
  'FEATURE_FLAGS',
]);

/**
 * The name fragments that mark a variable as CREDENTIAL-SHAPED.
 *
 * A name that carries one of them is refused even when it is on the
 * whitelist. The check is on the NAME, not on the value: the value is not
 * examined here, because a value that looks harmless can still be a
 * credential and a value that looks like a credential may be a fixture.
 */
export const CREDENTIAL_NAME_FRAGMENTS = Object.freeze([
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'APIKEY',
  'API_KEY',
  'PRIVATE_KEY',
  'CREDENTIAL',
  'SESSION',
  'COOKIE',
  'AUTH',
  'SIGNATURE',
  'SIGNING',
]);

/**
 * True when the name is credential-shaped.
 *
 * The comparison is case-insensitive, so `api_key` and `API_KEY` are the
 * same name -- an environment variable name is upper-case by convention but
 * the platforms are not strict about it, and a lowercase spelling must not
 * be a way around the check.
 */
export function isCredentialShapedName(name) {
  const upper = String(name ?? '').toUpperCase();
  return CREDENTIAL_NAME_FRAGMENTS.some((fragment) => upper.includes(fragment));
}

/**
 * Matches a whitelist entry against a name.
 *
 * An entry may be an exact name (`BASE_URL`) or a pattern with a single
 * trailing `*` (`FEATURE_*`). The pattern is the only wildcard: a general
 * glob would let a mistyped entry widen the whitelist far more than the
 * author intended.
 */
export function matchesWhitelistEntry(name, entry) {
  const pattern = String(entry ?? '');
  if (!pattern) return false;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    // A bare `*` would authorise EVERY name, which is the opposite of a
    // whitelist. An empty prefix is refused: the entry has to name at
    // least one character before the star.
    if (!prefix) return false;
    return String(name).toUpperCase().startsWith(prefix.toUpperCase());
  }
  return String(name).toUpperCase() === pattern.toUpperCase();
}

/**
 * The whitelist of a project, with its source.
 *
 * `source` says where the list came from -- 'default' for the built-in
 * list, 'custom' for one the user configured. A reader can therefore tell
 * "this project runs with the built-in names" from "this project runs with
 * exactly these six names", and the API reports it.
 */
export function whitelistOf(project) {
  const custom = project?.envWhitelist;
  if (Array.isArray(custom) && custom.length) {
    return { names: custom.map((n) => String(n).toUpperCase()), source: 'custom' };
  }
  return { names: [...DEFAULT_ENV_WHITELIST], source: 'default' };
}

/**
 * Checks a name against the whitelist AND the credential rule.
 *
 * @returns {{allowed:boolean, reason:string}}
 *   `reason` is empty when the name is allowed, and names the rule that
 *   refused it otherwise.
 */
export function checkEnvName(name, whitelist) {
  const upper = String(name ?? '').toUpperCase();
  // The CREDENTIAL rule is checked FIRST. It is the more specific refusal
  // and the more actionable one: a caller who asked for a password needs
  // to hear "a credential belongs in the credential store", not "that name
  // is not on the whitelist" -- the whitelist is not where a credential
  // could ever go, so the whitelist answer would send the caller to the
  // wrong place.
  if (isCredentialShapedName(upper)) {
    return {
      allowed: false,
      reason: 'the name is credential-shaped; a credential belongs in the credential store, not in an environment profile',
    };
  }
  const entries = Array.isArray(whitelist) ? whitelist : [];
  if (!entries.some((entry) => matchesWhitelistEntry(upper, entry))) {
    return {
      allowed: false,
      reason: 'the name is not on the environment whitelist of this project',
    };
  }
  return { allowed: true, reason: '' };
}

/**
 * Validates a whitelist a user wants to configure.
 *
 * The list itself is checked for the same shape as a profile's variables:
 * the names must be usable environment names (or a prefix pattern), and a
 * credential-shaped name is refused -- a whitelist is an AUTHORISATION, and
 * authorising a credential into the profile is the thing the credential
 * rule exists to prevent.
 *
 * @returns {{names:string[], problems:Array<{name:string,reason:string}>}}
 */
export function validateWhitelist(input) {
  const problems = [];
  const names = [];
  if (!Array.isArray(input)) {
    return { names, problems: [{ name: '*', reason: 'the whitelist must be an array of names' }] };
  }
  for (const raw of input) {
    const name = String(raw ?? '').trim().toUpperCase();
    if (!name) continue;
    if (name.endsWith('*')) {
      const prefix = name.slice(0, -1);
      if (!/^[A-Z][A-Z0-9_]*$/.test(prefix)) {
        problems.push({ name, reason: 'the pattern must be an upper-case name followed by a single "*"' });
        continue;
      }
    } else if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      problems.push({ name, reason: 'the name is not an upper-case environment variable name' });
      continue;
    }
    if (isCredentialShapedName(name)) {
      problems.push({
        name,
        reason: 'the name is credential-shaped and cannot be authorised into an environment profile',
      });
      continue;
    }
    if (!names.includes(name)) names.push(name);
  }
  return { names, problems };
}
