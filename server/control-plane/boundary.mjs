/**
 * Boundary rules of the deployable control-plane API (ATS-506).
 *
 * The control plane (P2) must never receive or emit what only exists on the
 * desktop (P1): local absolute paths, a path or repository address used
 * instead of an opaque UID, or the local Bridge session token
 * (docs/19-REMOTE-RUNNER-PROTOCOL.md HB-2/HB-3/HB-4/HB-7, §9).
 *
 * This module is pure: no I/O, no `node:` imports. The request pipeline uses
 * it on the way IN (path, query, body) and on the way OUT (every response),
 * so both directions share one definition. The rules are documented in
 * docs/21-CONTROL-PLANE-API.md §5; their limits in §11.
 */

/** Header names of the local Bridge credential. The control plane refuses them outright. */
export const LOCAL_CREDENTIAL_HEADERS = Object.freeze(['x-ats-token']);

const SYSTEM_ROOTS = 'home|Users|root|tmp|var|etc|opt|usr|mnt|Volumes|private|srv|proc|dev|sys|run|media';

/** Ordered rules: the first match names the finding. */
const PATH_RULES = [
  ['file_url', /\bfile:\//i],
  ['repository_url', /(?:^|[^A-Za-z0-9+.-])(?:git\+ssh|ssh|git):\/\//i],
  ['repository_url', /(?:^|[\s"'(=,;])[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s/\\][^\s]*/],
  ['repository_url', /^https?:\/\/\S+\.git\/?$/i],
  ['unc_path', /^(?:\\\\|\/\/)/],
  ['unc_path', /(?:^|[\s"'(=,;])\\\\[^\\\s]+\\/],
  ['windows_drive_path', /^[A-Za-z]:(?:[\\/]|$)/],
  ['windows_drive_path', /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/],
  ['home_relative_path', /^~(?:[\\/]|$)/],
  ['env_path', /%[A-Za-z_][A-Za-z0-9_]*%[\\/]|\$HOME\b|\$\{HOME\}/],
  ['path_traversal', /(?:^|[\\/])\.\.(?:[\\/]|$)/],
  ['posix_absolute_path', /^\//],
  ['posix_absolute_path', new RegExp(`(?:^|[\\s"'(=,;:])/(?:${SYSTEM_ROOTS})(?:/|$)`)],
];

function matchRules(text) {
  for (const [name, re] of PATH_RULES) if (re.test(text)) return name;
  return null;
}

function decodeOnce(text) {
  if (!text.includes('%')) return null;
  try {
    const decoded = decodeURIComponent(text);
    return decoded === text ? null : decoded;
  } catch {
    // Malformed percent-encoding is judged on the raw text only.
    return null;
  }
}

/**
 * Return the rule name of the first local path form found in `text`, or null.
 * The text is judged as-is and, when it percent-decodes, decoded as well, so
 * `C%3A%5Crepo` is refused exactly like `C:\repo`.
 */
export function detectLocalPath(text) {
  if (typeof text !== 'string' || text === '') return null;
  const raw = matchRules(text);
  if (raw) return raw;
  const decoded = decodeOnce(text);
  return decoded ? matchRules(decoded) : null;
}

/**
 * True for the shape of the local Bridge session token: 24 random bytes in
 * hexadecimal, i.e. exactly 48 hex characters. Git SHAs (40) and SHA-256
 * digests (64) have different lengths and are not affected.
 */
export function isLocalSessionTokenShape(text) {
  return typeof text === 'string' && /^[0-9a-f]{48}$/i.test(text);
}

const PATH_FIELDS = new Set(['path', 'localpath', 'projectpath', 'root', 'projectroot', 'rootdir', 'cwd', 'dir',
  'directory', 'workdir', 'workspace', 'workspacepath', 'file', 'filepath', 'absolutepath']);
const REPOSITORY_FIELDS = new Set(['repository', 'repositoryurl', 'repourl', 'giturl', 'remoteurl', 'cloneurl']);
const CREDENTIAL_FIELDS = new Set(['token', 'sessiontoken', 'atstoken', 'xatstoken', 'secret', 'secretvalue',
  'password', 'passwd', 'apikey', 'privatekey', 'credential', 'credentials']);

/**
 * Classify a field NAME. A path or repository address used where an opaque
 * UID belongs is REMOTE_PATH_FORBIDDEN (HB-4); a credential or secret field is
 * REMOTE_SECRET_INLINE_FORBIDDEN (HB-3). Names are compared without `_`/`-`
 * and case-insensitively, so `project_root` and `X-ATS-Token` are caught.
 */
export function classifyField(name) {
  if (typeof name !== 'string') return null;
  const key = name.replace(/[_-]/g, '').toLowerCase();
  if (PATH_FIELDS.has(key)) return { code: 'REMOTE_PATH_FORBIDDEN', kind: 'path_field' };
  if (REPOSITORY_FIELDS.has(key)) return { code: 'REMOTE_PATH_FORBIDDEN', kind: 'repository_url_field' };
  if (CREDENTIAL_FIELDS.has(key)) return { code: 'REMOTE_SECRET_INLINE_FORBIDDEN', kind: 'credential_field' };
  return null;
}

function inspectString(text) {
  const kind = detectLocalPath(text);
  if (kind) return { code: 'REMOTE_PATH_FORBIDDEN', kind };
  if (isLocalSessionTokenShape(text)) return { code: 'REMOTE_SECRET_INLINE_FORBIDDEN', kind: 'local_session_token_shape' };
  return null;
}

/**
 * Walk a JSON value depth-first and return the first boundary finding as
 * `{code, kind, pointer}`, or null. Keys are checked by form and -- unless
 * `fieldNames` is false -- by name; string values by form. `pointer` locates
 * the finding (`/a/0/b`); an offending KEY is located by its position
 * (`/a/#2`) so the pointer never repeats the offending text.
 *
 * Ingress uses the default (field names count: a `path` field is a path used
 * instead of a UID). Egress passes `fieldNames: false`: a response may name
 * a concept such as `credential` -- what must never leave is a VALUE with a
 * local path form or the local token shape.
 */
export function inspectValue(value, { maxDepth = 32, fieldNames = true } = {}) {
  function walk(node, pointer, depth) {
    if (depth > maxDepth) return { code: 'REMOTE_POLICY_REJECTED', kind: 'depth_exceeded', pointer };
    if (typeof node === 'string') {
      const found = inspectString(node);
      return found ? { ...found, pointer } : null;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const found = walk(node[i], `${pointer}/${i}`, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (node && typeof node === 'object') {
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const byName = (fieldNames && classifyField(key)) || inspectString(key);
        if (byName) return { ...byName, pointer: `${pointer}/#${i}` };
        const found = walk(node[key], `${pointer}/${key}`, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(value, '', 0);
}
