/**
 * ATS-202: the TRUST GATE of the authoritative discovery.
 *
 * `playwright test --list` is not a read-only operation. It LOADS the project
 * config (executing the config's top level) and it EVALUATES the test files
 * (executing their top level) in order to collect the cases. Running it on a
 * repository therefore means RUNNING that repository's code -- the same
 * trust boundary as `playwright test` itself.
 *
 * The v0.1 product already has this boundary (ADR-005: "只允许可信项目"),
 * but it is expressed as a PROPOSITION of the user: "a project is registered
 * here, so it is a project the user works on". That proposition is enough for
 * the RUN path -- the user asked for the run. It is NOT enough for the
 * DISCOVERY path: the index is read whenever the user opens the catalogue,
 * so an index that silently executes code would turn "browse the catalogue"
 * into "run the repository's code", without the user asking for it.
 *
 * This module makes the trust decision EXPLICIT and PERSISTED:
 *
 *   * a project is TRUSTED when the user vouched for it, and the vouch is
 *     recorded in the state file next to the project;
 *   * a project is UNTRUSTED until then, and an untrusted project is never
 *     asked to run `--list`;
 *   * the decision can be given per project, and the reason is always
 *     reported.
 *
 * The rule that matters: **the discovery of an untrusted project falls back
 * to the static heuristic and SAYS SO.** It does not fail, and it does not
 * silently pretend to be authoritative. The caller sees `discovery: 'static'`
 * and a warning that says why.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The trust vocabulary. */
export const TRUST = Object.freeze({
  TRUSTED: 'trusted',
  UNTRUSTED: 'untrusted',
});

/**
 * The reasons a project can be untrusted. They are stable codes so that a
 * UI can explain the situation without parsing a sentence.
 */
export const TRUST_REASON = Object.freeze({
  NOT_VOUCHED: 'the project has not been vouched for by the user',
  REVOKED: 'the user revoked the trust for this project',
});

/**
 * Reads the trust record of every project out of the state file.
 *
 * The record lives in `state.json` under `trust`, keyed by the project UID,
 * because the project UID is the stable identifier of the project (the root
 * path can change, the UID cannot).
 */
export function readTrustMap(state) {
  const map = state?.trust;
  if (!map || typeof map !== 'object') return {};
  return map;
}

/** True when the project is vouched for. */
export function isTrusted(state, project) {
  const uid = projectUidOfTrust(project);
  if (!uid) return false;
  const record = readTrustMap(state)[uid];
  return Boolean(record && record.trust === TRUST.TRUSTED);
}

/**
 * The trust state of one project, with the reason it is not trusted.
 *
 * Returns `{trust, reason, at}`:
 *   * `trust`   -- `trusted` or `untrusted`;
 *   * `reason`  -- a stable code when the project is not trusted, '' otherwise;
 *   * `at`      -- when the decision was taken.
 */
export function trustOf(state, project) {
  const uid = projectUidOfTrust(project);
  if (!uid) return { trust: TRUST.UNTRUSTED, reason: TRUST_REASON.NOT_VOUCHED, at: null };
  const record = readTrustMap(state)[uid];
  if (!record) return { trust: TRUST.UNTRUSTED, reason: TRUST_REASON.NOT_VOUCHED, at: null };
  if (record.trust !== TRUST.TRUSTED) {
    return { trust: TRUST.UNTRUSTED, reason: record.reason || TRUST_REASON.REVOKED, at: record.at ?? null };
  }
  return { trust: TRUST.TRUSTED, reason: '', at: record.at ?? null };
}

/**
 * Records the trust decision of a project and returns the new state.
 *
 * The state is not written here: the caller owns the state file and decides
 * when to persist it. That keeps the module free of IO beyond reading.
 */
export function withTrust(state, project, { trust, reason = '', at = null }) {
  const uid = projectUidOfTrust(project);
  if (!uid) throw new Error('PROJECT_UID_REQUIRED');
  const next = { ...(state ?? {}) };
  const map = { ...readTrustMap(next) };
  if (trust === TRUST.TRUSTED) {
    map[uid] = { trust: TRUST.TRUSTED, reason: '', at: at ?? new Date().toISOString() };
  } else {
    map[uid] = { trust: TRUST.UNTRUSTED, reason: reason || TRUST_REASON.REVOKED, at: at ?? new Date().toISOString() };
  }
  next.trust = map;
  return next;
}

/**
 * The stable identifier of a project, taken from the record itself.
 *
 * The trust record is keyed by the project UID. A record that predates the
 * UID scheme carries the legacy `proj_<uuid>` id, which is still the key
 * that identifies it, so the raw id is accepted as a fallback.
 */
function projectUidOfTrust(project) {
  if (!project) return null;
  if (typeof project.uid === 'string' && project.uid) return project.uid;
  if (typeof project.id === 'string' && project.id) return project.id;
  if (typeof project.root === 'string' && project.root) return path.resolve(project.root);
  return null;
}

/**
 * Writes the trust map into the state file, atomically.
 *
 * The write follows the same rule as the rest of the state file: a temporary
 * file and a rename, so a crash cannot leave a half-written state behind.
 */
export function persistTrust(state, file) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
