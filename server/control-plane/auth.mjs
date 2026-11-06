/**
 * User-side authenticators of the control plane (ATS-506).
 *
 * An authenticator maps a request to `{ok:true, subject, tenantId}` or refuses
 * with `{ok:false, reason}`. The reason is AUDIT-ONLY: the pipeline answers
 * every refusal with the same REMOTE_UNAUTHENTICATED (docs/19 §3.4, ADR-021).
 *
 * The production authenticator (OIDC) belongs to ATS-507 and plugs in here.
 * This module provides the deny-all default and a development authenticator
 * with static bearer tokens, which main.mjs only allows on a loopback host.
 */
import crypto from 'node:crypto';

const TENANT_ID = /^ten_[A-Za-z0-9_-]{1,64}$/;
const MIN_TOKEN_LENGTH = 32;

function bearerOf(req) {
  const header = req && req.headers ? req.headers.authorization : undefined;
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/.exec(header.trim());
  return m ? m[1] : null;
}

const digest = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

/** Refuses every request; the default until ATS-507 provides OIDC. */
export function denyAllAuthenticator() {
  return (req) => ({ ok: false, reason: bearerOf(req) ? 'unknown_user_token' : 'missing_user_token' });
}

function validateTokenMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new TypeError('dev tokens must be a JSON object {token: tenantId}');
  const entries = Object.entries(map);
  if (entries.length === 0) throw new TypeError('dev tokens must contain at least one token');
  for (const [token, tenantId] of entries) {
    // The messages name the problem, never the token value.
    if (token.length < MIN_TOKEN_LENGTH) throw new TypeError(`every dev token must be at least ${MIN_TOKEN_LENGTH} characters`);
    if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) throw new TypeError('every tenant id must match ten_[A-Za-z0-9_-]{1,64}');
  }
  return entries;
}

/** Parse ATS_CP_DEV_TOKENS (JSON) with the same validation as the authenticator. */
export function parseDevTokens(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TypeError('dev tokens are not valid JSON');
  }
  validateTokenMap(parsed);
  return parsed;
}

/**
 * Development authenticator: `Authorization: Bearer <token>` against a static
 * `{token: tenantId}` map. Tokens are compared by SHA-256 digest with
 * timingSafeEqual, so neither length nor prefix short-circuits the check.
 */
export function staticBearerAuthenticator(map) {
  const known = validateTokenMap(map).map(([token, tenantId]) => ({ digest: digest(token), tenantId }));
  return (req) => {
    const presented = bearerOf(req);
    if (!presented) return { ok: false, reason: 'missing_user_token' };
    const d = digest(presented);
    let match = null;
    for (const entry of known) if (crypto.timingSafeEqual(entry.digest, d)) match = entry;
    if (!match) return { ok: false, reason: 'unknown_user_token' };
    return { ok: true, subject: `dev:${match.digest.toString('hex').slice(0, 8)}`, tenantId: match.tenantId };
  };
}
