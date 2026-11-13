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
 * ---------------------
 *   1. NOT ON THE WHITELIST -- the name is simply not permitted here.
 *   2. A CREDENTIAL-SHAPED NAME WITH A PLAINTEXT VALUE -- the name LOOKS
 *      like it holds a secret (`*_TOKEN`, `*_PASSWORD`, `*_SECRET`,
 *      `*_API_KEY`, ...). Such a name may only carry a **credential
 *      REFERENCE**, never a literal value: the profile stores the
 *      reference, and the platform resolves it against the system
 *      credential store when the run starts. A plaintext value under such
 *      a name would enter the run assets, the SQLite mirror and the
 *      evidence archive -- which is precisely what the requirement
 *      "单独安全凭据存储" forbids.
 *
 *      The refusal says so, and names the way out: put a reference to the
 *      credential store, not the secret itself.
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
 * The shape of a credential REFERENCE.
 *
 * A reference names an entry in the system credential store. It is stored in
 * the profile INSTEAD of the secret, and the platform resolves it when the
 * run starts. Two spellings are accepted and mean the same thing:
 *
 *   {"credentialRef": "cred_<24 hex>"}   -- the explicit form
 *   "cred:<24 hex>"                     -- the shorthand
 *
 * The reference is a **closed shape**: an object with exactly one key
 * `credentialRef`, or a string of the form `cred:<id>`. Anything else is
 * not a reference, so it cannot be mistaken for one.
 */
export const CREDENTIAL_REF_ID = /^cred_[0-9a-f]{24}$/;

/**
 * Parses a value into a credential reference.
 *
 * Two spellings of the shorthand are accepted, because both are natural to
 * type: `cred:<24 hex>` and `cred:cred_<24 hex>` (the full identifier,
 * which is what the interface shows).
 *
 * @returns {{id:string}|null} the reference, or `null` when the value is not
 *   a reference at all. A `null` means "this is an ordinary value", and the
 *   caller applies the ordinary rules to it.
 */
export function parseCredentialRef(value) {
  if (typeof value === 'string') {
    const m = /^cred:(.+)$/.exec(value.trim());
    if (!m) return null;
    const raw = m[1].trim();
    // The shorthand may carry the identifier in full or just its hex part.
    const id = raw.startsWith('cred_') ? raw : `cred_${raw}`;
    return CREDENTIAL_REF_ID.test(id) ? { id } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'credentialRef') return null;
  const raw = value.credentialRef;
  if (typeof raw !== 'string' || !CREDENTIAL_REF_ID.test(raw.trim())) return null;
  return { id: raw.trim() };
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
 * @param {string} name the variable name
 * @param {string[]} whitelist the names that are authorised
 * @param {object|null} [ref] the credential reference the value carries, when
 *   the value is one. A credential-shaped name WITH a reference is allowed
 *   even when the name is not on the whitelist, because the reference names
 *   an entry in the credential store and the profile never holds a secret.
 * @returns {{allowed:boolean, reason:string}}
 *   `reason` is empty when the name is allowed, and names the rule that
 *   refused it otherwise.
 */
export function checkEnvName(name, whitelist, ref = null) {
  const upper = String(name ?? '').toUpperCase();
  // The CREDENTIAL rule is checked FIRST. It is the more specific refusal
  // and the more actionable one: a caller who asked for a password needs
  // to hear "put a reference to the credential store here, not the secret",
  // not "that name is not on the whitelist" -- the whitelist is not where a
  // credential could ever go, so the whitelist answer would send the caller
  // to the wrong place.
  if (isCredentialShapedName(upper)) {
    if (ref) return { allowed: true, reason: '' };
    return {
      allowed: false,
      reason: 'the name is credential-shaped; carry a credential reference to the credential store, not the secret itself',
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
        reason: 'the name is credential-shaped and cannot be authorised into an environment profile; '
          + 'carry a credential reference to the credential store instead',
      });
      continue;
    }
    if (!names.includes(name)) names.push(name);
  }
  return { names, problems };
}
