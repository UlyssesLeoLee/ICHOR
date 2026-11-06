/**
 * ATS-301: Runner / Reporter adapter contract (v1) and capability negotiation.
 *
 * The point of this module is that the Bridge stops talking to a specific test
 * engine. It talks to an ADAPTER, and every adapter declares -- up front, by
 * probing the machine and the project -- which capabilities it actually has.
 * A caller can therefore ask "can this runner do X?" and get a truthful answer
 * instead of discovering the limitation halfway through a run.
 *
 * Design rules (see docs/18-RUNNER-ADAPTER-CONTRACT.md):
 *
 *  1. The contract is DATA, not behaviour. `capabilities(project)` returns a
 *     plain object that can be serialised, diffed and asserted on. It never
 *     throws for a missing capability -- an unsupported capability is reported
 *     as `supported: false` with a reason.
 *  2. A capability is only `supported: true` when it has been PROVEN on this
 *     machine. "The CLI has an option" is not proof; "the option was accepted
 *     and the run produced the artefact" is. The `evidence` field records how
 *     it was proven, so a reader can tell a probed fact from an assumption.
 *  3. `discover` / `start` / `stop` / `collect` are the only four operations
 *     the Bridge needs. Everything engine-specific lives behind them.
 *  4. Unsupported is a normal, reportable outcome -- not an exception and not
 *     a silent no-op. `requireCapability()` raises `CAPABILITY_UNSUPPORTED`
 *     with the adapter's own reason attached, so the API layer can map it to
 *     a 4xx instead of a 500.
 *
 * IMPORTANT (baseline honesty): this module implements the CONTRACT and the
 * NEGOTIATION. It does not by itself make WebdriverIO work -- see
 * `adapters/wdio.mjs` for what is actually proven and what is not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BASE_ENV_KEYS } from '../env/profiles.mjs';

/** Contract version. Bumped when the capability set or the operation set changes. */
export const ADAPTER_CONTRACT_VERSION = 1;

/**
 * The capability vocabulary. Every adapter reports on exactly these keys, so
 * the Bridge can compare adapters without knowing what engine is behind them.
 *
 * `kind`:
 *   - 'required'  the adapter cannot function at all without it
 *   - 'optional'  the adapter works without it, but a caller may want it
 *   - 'diagnostic' a fact about the engine's own contract, reported so a
 *                 caller can see a known defect instead of hitting it
 */
export const CAPABILITY_VOCABULARY = Object.freeze({
  discover: { kind: 'required', desc: 'Enumerate the test cases of a project' },
  start: { kind: 'required', desc: 'Start a run' },
  stop: { kind: 'required', desc: 'Stop a running run' },
  collect: { kind: 'required', desc: 'Collect results and evidence of a run' },
  filterByFile: { kind: 'optional', desc: 'Run only the cases of one file' },
  filterByTestUid: { kind: 'optional', desc: 'Run only one identified test case' },
  structuredReport: { kind: 'optional', desc: 'Produce a machine-readable result file' },
  htmlReport: { kind: 'optional', desc: 'Produce an HTML result report' },
  trace: { kind: 'optional', desc: 'Produce a trace of the run' },
  screenshot: { kind: 'optional', desc: 'Produce screenshots' },
  video: { kind: 'optional', desc: 'Produce a video recording' },
  cancel: { kind: 'optional', desc: 'Stop a run that is already in flight' },
  nativeBrowser: { kind: 'optional', desc: 'Drive a real browser (not a stub)' },
  cliContract: { kind: 'diagnostic', desc: 'The installed CLI accepts the argument vector the adapter passes' },
});

/** The canonical result shape both engines are mapped onto. */
export const RESULT_STATUS = Object.freeze({
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  flaky: 'flaky',
  unknown: 'unknown',
});

export class AdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Build one capability entry.
 *
 * @param {string} name     key in CAPABILITY_VOCABULARY
 * @param {boolean} supported
 * @param {object} [opts]
 * @param {string} [opts.reason]   why it is unsupported (required when unsupported)
 * @param {string} [opts.evidence] how it was proven (required when supported)
 * @param {object} [opts.detail]   adapter-specific facts (versions, paths, ...)
 */
export function capability(name, supported, { reason = '', evidence = '', detail = {} } = {}) {
  const spec = CAPABILITY_VOCABULARY[name];
  if (!spec) throw new AdapterError('UNKNOWN_CAPABILITY', `unknown capability: ${name}`);
  if (!supported && !reason) {
    throw new AdapterError('CAPABILITY_REASON_REQUIRED', `capability ${name} is unsupported but has no reason`);
  }
  if (supported && !evidence) {
    throw new AdapterError('CAPABILITY_EVIDENCE_REQUIRED', `capability ${name} is supported but has no evidence`);
  }
  return {
    name,
    kind: spec.kind,
    supported: Boolean(supported),
    reason: supported ? '' : reason,
    evidence: supported ? evidence : '',
    detail,
  };
}

/** The four operations every adapter must implement. */
export const REQUIRED_OPERATIONS = Object.freeze(['discover', 'start', 'stop', 'collect']);

/**
 * Validate that an object is a conforming adapter. Called by the registry so a
 * broken adapter fails at registration time, not at the first run.
 */
export function assertAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new AdapterError('INVALID_ADAPTER', 'adapter must be an object');
  if (typeof adapter.kind !== 'string' || !adapter.kind) throw new AdapterError('INVALID_ADAPTER', 'adapter.kind must be a non-empty string');
  if (typeof adapter.contractVersion !== 'number') throw new AdapterError('INVALID_ADAPTER', 'adapter.contractVersion must be a number');
  if (adapter.contractVersion !== ADAPTER_CONTRACT_VERSION) {
    throw new AdapterError('CONTRACT_VERSION_MISMATCH', `adapter ${adapter.kind} speaks contract v${adapter.contractVersion}, this build speaks v${ADAPTER_CONTRACT_VERSION}`);
  }
  for (const op of REQUIRED_OPERATIONS) {
    if (typeof adapter[op] !== 'function') throw new AdapterError('INVALID_ADAPTER', `adapter ${adapter.kind} is missing ${op}()`);
  }
  if (typeof adapter.capabilities !== 'function') throw new AdapterError('INVALID_ADAPTER', `adapter ${adapter.kind} is missing capabilities()`);
  return adapter;
}

/**
 * Capability negotiation result.
 *
 * `supported` is the AND of every requested capability, so a caller can read
 * one boolean. `missing` lists the ones that are not available, each with the
 * adapter's own reason -- the caller can surface that reason to the user
 * instead of inventing one.
 *
 * NOTE: the project is a REQUIRED argument. A capability is a property of the
 * project (its installed CLI, its reporters, its config), so negotiating
 * without one would answer a question nobody asked.
 */
export function negotiate(adapter, project, requested = []) {
  const caps = adapter.capabilities(project);
  const byName = new Map(caps.map((c) => [c.name, c]));
  const missing = [];
  const resolved = [];
  for (const name of requested) {
    const cap = byName.get(name);
    if (!cap) {
      missing.push({ name, kind: 'unknown', supported: false, reason: `adapter ${adapter.kind} does not declare this capability`, evidence: '', detail: {} });
      continue;
    }
    resolved.push(cap);
    if (!cap.supported) missing.push(cap);
  }
  return {
    adapter: adapter.kind,
    contractVersion: adapter.contractVersion,
    requested: [...requested],
    supported: missing.length === 0,
    missing,
    capabilities: caps,
  };
}

/**
 * Assert that the adapter supports every requested capability.
 * Throws AdapterError('CAPABILITY_UNSUPPORTED') carrying the reasons.
 */
export function requireCapability(adapter, project, requested = []) {
  const result = negotiate(adapter, project, requested);
  if (!result.supported) {
    const detail = result.missing.map((m) => `${m.name}: ${m.reason}`).join('; ');
    throw new AdapterError('CAPABILITY_UNSUPPORTED', `adapter ${adapter.kind} does not support ${detail}`, { missing: result.missing });
  }
  return result;
}

/** True when the adapter declares the capability as supported. */
export function supports(adapter, project, name) {
  const cap = adapter.capabilities(project).find((c) => c.name === name);
  return Boolean(cap && cap.supported);
}

/**
 * The capabilities that are NOT supported -- the "known gaps" of an adapter.
 * Used to warn a caller before a run rather than after it.
 */
export function gaps(adapter, project) {
  return adapter.capabilities(project).filter((c) => !c.supported);
}

/* ------------------------------------------------------------------ */
/* Shared probing helpers -- used by the concrete adapters.            */
/* ------------------------------------------------------------------ */

/**
 * The platform base keys of the host environment -- and nothing else.
 *
 * This is the environment a child process gets when it must run but must
 * not see the operator's shell.
 */
function baseEnv() {
  const env = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  return env;
}

/**
 * Run a command and capture its outcome; never throws.
 *
 * ATS-212: the probe's environment is SEALED as well. The probe runs the
 * PROJECT'S OWN CLI (`node <project>/node_modules/@playwright/test/cli.js
 * --help`), so it is the same trust boundary as the run -- the code that
 * ships with the project. Inheriting `{...process.env}` would hand an
 * operator's cloud credentials to that code for no reason.
 *
 * `env` may still be passed explicitly (a caller that has a reason to).
 */
export function probeCommand(command, args, { cwd, timeout = 20000, env } = {}) {
  const r = spawnSync(command, args, { cwd, timeout, encoding: 'utf8', env: env || baseEnv(), shell: false });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error ? r.error.message : '',
  };
}

/**
 * Extract the option names a CLI actually accepts from its `--help` output.
 *
 * This is how the adapter learns what the engine supports WITHOUT guessing:
 * the help text of the installed CLI is the contract. A capability that has no
 * corresponding option is reported as unsupported with the reason "the
 * installed CLI does not accept this option".
 *
 * A help line may declare SEVERAL aliases, e.g. Playwright's
 *
 *     -g, --grep <grep>   Only run tests matching this regular expression
 *
 * so every alias on the line is collected. Matching only the first token
 * would silently hide `--grep`, and an adapter that believes the CLI lacks
 * `--grep` would refuse a capability the engine actually provides.
 */
export function parseCliOptions(helpText) {
  const options = new Set();
  for (const line of String(helpText || '').split('\n')) {
    // Only the LEADING option column of a help line, never the description.
    const m = line.match(/^\s+(-{1,2}[a-zA-Z][\w-]*(?:\s*,\s*-{1,2}[a-zA-Z][\w-]*)*)/);
    if (!m) continue;
    for (const token of m[1].split(',')) {
      const name = token.trim().replace(/^-+/, '');
      if (name) options.add(name);
    }
  }
  return [...options].sort();
}

/**
 * The positional filter a CLI accepts, if any.
 *
 * Playwright takes the test file as a POSITIONAL argument
 * (`Usage: npx playwright test [options] [test-filter...]`), not as an option,
 * so it cannot be discovered from the option list. The usage line is the
 * contract for it.
 */
export function parseCliUsage(helpText) {
  for (const line of String(helpText || '').split('\n')) {
    const m = line.match(/^\s*Usage:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * True when the usage line declares a positional test filter.
 *
 * The argument accepts EITHER a full `--help` text or a bare usage line:
 *
 *   - a full help text is searched for its `Usage:` line and the filter is
 *     looked for there;
 *   - a bare usage line (already extracted by the caller) is matched
 *     directly.
 *
 * The second form matters: the adapter extracts the usage line ONCE and
 * then asks about the positional filter. Feeding that extracted line back
 * through the help-text path made the search fail (there is no `Usage:`
 * prefix left in it), so the adapter reported `filterByFile` as
 * unsupported while `start()` happily passed the file as a positional
 * argument -- a negotiation that contradicted the execution.
 */
export function hasPositionalFilter(helpOrUsage) {
  const text = String(helpOrUsage || '');
  const usage = /^\s*Usage:/m.test(text) ? parseCliUsage(text) : text;
  return /\[test-filter/i.test(usage);
}

/**
 * Resolve a package-local executable inside the project under test.
 * Mirrors `resolvePlaywright()` in core.mjs: the adapter NEVER installs
 * anything and never falls back to a global binary.
 */
export function resolveProjectBinary(projectRoot, relativeCandidates) {
  for (const rel of relativeCandidates) {
    const p = path.join(projectRoot, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Read a package version from a project's node_modules without executing it.
 * Returns null when the package is absent.
 */
export function readPackageVersion(projectRoot, packageName) {
  const pkg = path.join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json');
  if (!fs.existsSync(pkg)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || null;
  } catch {
    return null;
  }
}
