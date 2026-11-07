/**
 * ATS-212 -- the STORE of the environment profiles.
 *
 * WHERE THE PROFILES LIVE
 * -----------------------
 * In the bridge's STATE -- the same `state.json` that holds the projects and
 * the runs -- and NOWHERE ELSE. That is the "配置不进入 Git" half of the
 * acceptance criterion: a profile is run configuration, not source. The
 * repository never learns about it: no file is written into the project,
 * nothing is committed, and the API has no endpoint that writes into the
 * project's own tree.
 *
 * WHY THE STATE AND NOT A FILE OF ITS OWN
 * ----------------------------------------
 * The state is the truth, and the SQLite layer (ATS-205) is its MIRROR.
 * Putting the profiles in the state means they are:
 *
 *   * written atomically (the state's own `tmp` + `rename`),
 *   * mirrored into SQLite as queryable rows, and
 *   * covered by the existing import/export round-trip -- so a profile
 *     cannot be lost by a migration or by a mirror round trip, and a test
 *     can prove it.
 *
 * The field is ADDITIVE: a state file written before ATS-212 has no
 * `envProfiles`, and it loads with an empty profile list and the built-in
 * whitelist. An installation that predates ATS-212 keeps working.
 *
 * THE VALUES LIVE HERE TOO
 * ------------------------
 * That is deliberate for now, and it is the boundary of this delivery: the
 * credential store of FR-027 (a separate secure store for secrets) is NOT
 * part of this task. So the credential rule in `whitelist.mjs` keeps
 * credential-shaped names OUT of the profiles in the first place -- what
 * remains in a profile is non-credential configuration, in the user's own
 * data directory, which is not in Git and not in the evidence archive.
 *
 * What is NOT stored in a RUN record is the VALUES of the variables. A run
 * records the profile it ran under and the NAMES of the variables it
 * carried; the values are re-read from the profile when someone needs them.
 */
import { buildProfile } from './profiles.mjs';
import { DEFAULT_ENV_WHITELIST, validateWhitelist } from './whitelist.mjs';
import { projectUidOf } from '../uid.mjs';

/** The version of the store format. */
export const ENV_STORE_VERSION = 1;

/**
 * THE PROJECT KEY of a project.
 *
 * Every profile and every whitelist is filed under ONE key, and it is the
 * key the RUN path uses as well. For a project record that has not been
 * migrated yet -- one whose `id` is still the old `proj_<uuid>` and which
 * carries no `uid` -- the key is the UID recomputed from its root, which is
 * exactly the UID the migration gives the project as its new `id`. So the
 * four paths (write, list, delete, run) always agree on one key, and a
 * profile the API listed can always be used by a run.
 *
 * The rule is now: the `uid` the project record carries when it has one,
 * and the recomputed UID otherwise. For every project the bridge really
 * stores, the `uid` IS `projectUidOf(project)` -- the registration route
 * and the state migration both write `uid = projectUidFor(root)`, and the
 * migration gives the project exactly that value as its new `id`. So the
 * key is the project's canonical identifier either way, and it does not
 * CHANGE across the migration: a legacy project record is keyed by the UID
 * recomputed from its root, which is exactly the UID the migration gives
 * it. The profiles of an unmigrated installation therefore stay reachable.
 *
 * The migration re-keys the profiles that are filed under the legacy
 * identifier, and leaves the ones that are already under the canonical key
 * where they are.
 */
export function projectKeyOf(project) {
  if (!project) return null;
  return project.uid ?? projectUidOf(project);
}

/**
 * The empty store: no profiles, no configured whitelist.
 */
export function emptyEnvStore() {
  return { version: ENV_STORE_VERSION, profiles: [], whitelists: {} };
}

/**
 * The environment store of a state, with the empty store as the fallback.
 *
 * The state is the truth and the store is a PART of it, so the store is
 * read out of the state and written back into it -- the state stays the
 * single thing that is persisted.
 */
export function envStoreOf(state) {
  if (!state || typeof state !== 'object') return emptyEnvStore();
  if (!state.envProfiles || typeof state.envProfiles !== 'object') {
    state.envProfiles = emptyEnvStore();
  }
  const store = state.envProfiles;
  if (!Array.isArray(store.profiles)) store.profiles = [];
  if (!store.whitelists || typeof store.whitelists !== 'object') store.whitelists = {};
  if (!Number.isInteger(store.version)) store.version = ENV_STORE_VERSION;
  return store;
}

/**
 * The profiles of one project.
 */
export function profilesOfProject(store, projectUid) {
  return (store?.profiles ?? []).filter((p) => p.projectUid === projectUid);
}

/**
 * One profile, by its identifier or by its name.
 */
export function findProfile(store, projectUid, ref) {
  const wanted = String(ref ?? '');
  if (!wanted) return null;
  return (
    profilesOfProject(store, projectUid).find(
      (p) => p.uid === wanted || p.id === wanted || p.name.toLowerCase() === wanted.toLowerCase()
    ) ?? null
  );
}

/**
 * The whitelist of a project, with the source it came from.
 *
 * A project may have configured its own list; the configured list wins over
 * the built-in default. The source is reported so a reader can tell the
 * two apart -- "this project runs with the built-in names" and "this
 * project runs with exactly these six names" are different facts.
 *
 * AN EMPTY CONFIGURED LIST IS AN EMPTY LIST, NOT "NOT CONFIGURED". The
 * stored whitelist is consulted by KEY, not by length: a caller who wrote
 * `names: []` to lock a project down gets an allow list that allows
 * nothing. A whitelist is an allow list, so an empty one allows nothing;
 * that is the honest reading, and it is the one the API reports back.
 */
export function whitelistForProject(store, project) {
  const key = projectKeyOf(project);
  const configured = store?.whitelists?.[key];
  if (Array.isArray(configured)) {
    return { names: configured.map((n) => String(n).toUpperCase()), source: 'custom' };
  }
  const fromProject = project?.envWhitelist;
  if (Array.isArray(fromProject) && fromProject.length) {
    return { names: fromProject.map((n) => String(n).toUpperCase()), source: 'custom' };
  }
  return { names: [...DEFAULT_ENV_WHITELIST], source: 'default' };
}

/**
 * Creates or replaces a profile of a project.
 *
 * The profile is validated against the project's whitelist BEFORE it is
 * stored: a refused variable is a REFUSAL, not a silent drop. The caller
 * receives the refusals and decides what to do with them -- the API layer
 * refuses the whole request, because a caller that asked for a variable
 * that is not allowed should be told, not handed a partial profile.
 *
 * @returns {{profile:object, rejected:Array}}
 */
export function upsertProfile(store, project, input, { now = null } = {}) {
  const whitelist = whitelistForProject(store, project);
  const built = buildProfile(input, {
    projectUid: projectKeyOf(project),
    whitelist: whitelist.names,
    now,
  });
  // A REFUSED variable must not leave a half-written profile behind. The
  // store is only touched when the profile is COMPLETE: a profile that is
  // missing one of the variables the caller asked for behaves differently
  // from what was asked for, and the caller is told about the refusal.
  if ((built.rejected ?? []).length) {
    return { profile: built, rejected: built.rejected, stored: false };
  }
  const profiles = store.profiles ?? (store.profiles = []);
  const existing = profiles.findIndex(
    (p) => p.projectUid === built.projectUid && p.name.toLowerCase() === built.name.toLowerCase()
  );
  if (existing >= 0) {
    // The identifier is DERIVED from the project and the name, so replacing
    // a profile keeps its identifier: a run that referred to it still
    // refers to the same profile. The creation time is kept.
    const previous = profiles[existing];
    const merged = {
      ...built,
      id: previous.id,
      uid: previous.uid,
      createdAt: previous.createdAt ?? built.createdAt,
    };
    profiles[existing] = merged;
    return { profile: merged, rejected: [], stored: true };
  }
  profiles.push(built);
  return { profile: built, rejected: [], stored: true };
}

/**
 * Removes a profile of a project.
 *
 * @returns {boolean} whether a profile was removed
 */
export function removeProfile(store, project, ref) {
  const found = findProfile(store, projectKeyOf(project), ref);
  if (!found) return false;
  store.profiles = (store.profiles ?? []).filter((p) => p.uid !== found.uid && p.id !== found.id);
  return true;
}

/**
 * Configures the whitelist of a project.
 *
 * The list is validated: a credential-shaped name cannot be authorised
 * into a profile, so it cannot be on the whitelist either.
 *
 * AN EMPTY LIST IS STORED AS AN EMPTY LIST. It is not treated as "no
 * whitelist configured": a caller that writes `names: []` is asking for a
 * project that may carry NO environment variable at all, and answering that
 * with the built-in default list would widen the boundary instead of
 * narrowing it.
 */
export function setWhitelist(store, project, input) {
  const { names, problems } = validateWhitelist(input);
  if (problems.length) {
    const e = new Error('INVALID_ENV_WHITELIST');
    e.code = 'INVALID_ENV_WHITELIST';
    e.problems = problems;
    throw e;
  }
  store.whitelists = store.whitelists ?? {};
  store.whitelists[projectKeyOf(project)] = names;
  return names;
}

/**
 * The PUBLIC view of a profile: the identifier, the tier, and the NAMES of
 * the variables -- never their values.
 *
 * The API returns this view, so a caller can see which variables a profile
 * carries without a value ever crossing the wire. The values are read from
 * the store when a run needs them.
 */
export function publicProfile(profile) {
  if (!profile) return null;
  const names = Object.keys(profile.variables ?? {}).sort();
  return {
    id: profile.uid ?? profile.id,
    uid: profile.uid ?? profile.id,
    projectUid: profile.projectUid,
    name: profile.name,
    environment: profile.environment,
    variables: names,
    variableCount: names.length,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}
