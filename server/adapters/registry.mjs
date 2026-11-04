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

/** The runners this build knows about, in preference order. */
export function createRegistry() {
  const registry = new Map();
  for (const factory of [createPlaywrightAdapter, createWdioAdapter]) {
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
    const negotiation = negotiate(adapter, requested);
    if (negotiation.supported) return { adapter, negotiation, rejected };
    rejected.push({ kind: adapter.kind, missing: negotiation.missing });
  }
  const detail = rejected.map((r) => `${r.kind} (${r.missing.map((m) => `${m.name}: ${m.reason}`).join('; ')})`).join('; ');
  throw new AdapterError('NO_RUNNER_SUPPORTS_REQUEST', `no runner supports the requested capabilities: ${detail}`, { rejected });
}

/** Same as selectAdapter, but raises CAPABILITY_UNSUPPORTED with the reasons. */
export function selectAdapterOrThrow(project, requested = [], options = {}) {
  return requireCapability(selectAdapter(project, requested, options).adapter, requested);
}

export { negotiate, requireCapability };
