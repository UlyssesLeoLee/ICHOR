/**
 * ATS-301: adapter registry.
 *
 * One place that knows which runners exist and how to pick one for a project.
 * The Bridge asks this registry; it never imports a concrete adapter itself.
 *
 * Selection is capability-driven, not name-driven: a runner is chosen because
 * it can do what the caller asked for on THIS project, and the choice can be
 * explained ("playwright was selected because it supports discover/start/
 * stop/collect on this project; wdio was not because ...").
 */
import { assertAdapter, negotiate, requireCapability, AdapterError } from './contract.mjs';
import { createPlaywrightAdapter } from './playwright.mjs';
import { createWdioAdapter } from './wdio.mjs';
import { createMobileAdapter } from './mobile.mjs';

/** The runners this build knows about, in preference order. */
export function createRegistry() {
  const registry = new Map();
  for (const factory of [createPlaywrightAdapter, createWdioAdapter, createMobileAdapter]) {
    const adapter = assertAdapter(factory());
    registry.set(adapter.kind, adapter);
  }
  return registry;
}

/** The default registry instance used by the Bridge. */
export const registry = createRegistry();

/** All known runners. */
export function listRunners() {
  return [...registry.values()].map((a) => ({ kind: a.kind, contractVersion: a.contractVersion }));
}

/** Get one runner by kind. Throws when it is unknown. */
export function getAdapter(kind) {
  const adapter = registry.get(kind);
  if (!adapter) throw new AdapterError('UNKNOWN_RUNNER', `unknown runner: ${kind}`, { known: [...registry.keys()] });
  return adapter;
}

/**
 * The capability matrix of every runner for one project.
 * This is the payload the API exposes so a client can show what each runner
 * can do for the selected project.
 */
export function capabilityMatrix(project) {
  return [...registry.values()].map((adapter) => ({
    kind: adapter.kind,
    contractVersion: adapter.contractVersion,
    capabilities: adapter.capabilities(project),
  }));
}

/**
 * Pick a runner for a project that satisfies the requested capabilities.
 *
 * Returns { adapter, negotiation, rejected }. `rejected` explains, per runner,
 * why it was not chosen -- so a caller can tell the user WHY the expected
 * runner is unavailable instead of silently falling back.
 */
export function selectAdapter(project, requested = [], { preferred } = {}) {
  const rejected = [];
  const candidates = preferred
    ? [getAdapter(preferred), ...[...registry.values()].filter((a) => a.kind !== preferred)]
    : [...registry.values()];
  for (const adapter of candidates) {
    const negotiation = negotiate(adapter, project, requested);
    if (negotiation.supported) return { adapter, negotiation, rejected };
    rejected.push({ kind: adapter.kind, missing: negotiation.missing });
  }
  const detail = rejected.map((r) => `${r.kind} (${r.missing.map((m) => `${m.name}: ${m.reason}`).join('; ')})`).join('; ');
  throw new AdapterError('NO_RUNNER_SUPPORTS_REQUEST', `no runner supports the requested capabilities: ${detail}`, { rejected });
}

/**
 * Same as selectAdapter, but raises CAPABILITY_UNSUPPORTED with the reasons
 * when the PREFERRED runner cannot satisfy the request.
 *
 * selectAdapter silently falls back to another runner. That is right for an
 * automatic choice, but wrong when the caller pinned a runner: falling back
 * would run a different engine than the one that was asked for.
 *
 * The return shape matches selectAdapter: { adapter, negotiation, rejected }.
 */
export function selectAdapterOrThrow(project, requested = [], { preferred } = {}) {
  if (!preferred) {
    const chosen = selectAdapter(project, requested);
    return { ...chosen, negotiation: requireCapability(chosen.adapter, project, requested) };
  }
  const adapter = getAdapter(preferred);
  return { adapter, negotiation: requireCapability(adapter, project, requested), rejected: [] };
}

export { negotiate, requireCapability };

/**
 * Turn a negotiation failure into the body of an HTTP 4xx.
 *
 * A 409 that carries only `{"error":"CAPABILITY_UNSUPPORTED"}` throws away the
 * one thing the caller needs: WHICH capability was missing and WHY. The
 * adapter's own reason is the only honest answer, so it is carried through
 * verbatim in `missing[]` (name + kind + reason) and, when the selection
 * tried several runners, in `rejected[]` (per runner).
 *
 * `missing[]` is flattened across the rejected runners so a caller does not
 * have to know whether the failure came from one pinned runner or from the
 * whole fleet. The per-runner view stays available in `rejected[]`.
 *
 * This lives here, next to the code that raises the errors, so the two
 * cannot drift apart.
 */
export function negotiationFailure(e) {
  const details = (e && e.details && typeof e.details === 'object') ? e.details : {};
  const rejected = Array.isArray(details.rejected) ? details.rejected : [];
  const missing = Array.isArray(details.missing) ? details.missing : [];
  const flat = missing.map((m) => ({ name: m.name, kind: m.kind, reason: m.reason }));
  for (const r of rejected) {
    for (const m of (r.missing || [])) {
      if (!flat.some((x) => x.name === m.name)) {
        flat.push({ name: m.name, kind: m.kind, reason: m.reason, runner: r.kind });
      }
    }
  }
  const payload = {};
  if (flat.length) payload.missing = flat;
  if (rejected.length) {
    payload.rejected = rejected.map((r) => ({
      kind: r.kind,
      missing: (r.missing || []).map((m) => ({ name: m.name, kind: m.kind, reason: m.reason })),
    }));
  }
  return payload;
}
