/**
 * The Bridge's default port, derived from the product source.
 *
 * The probes need to know the default port, but they must NOT hardcode it:
 * a literal port number in a probe is a port mention that the ATS-101 port
 * audit (tools/ats101-probes/scenario-d-port-audit.mjs) would have to count,
 * and a probe that carries its own copy of the port can silently drift from
 * the product when the product's default changes.
 *
 * So the default is read from the one place it is actually defined --
 * server/index.mjs's `process.env.ATS_PORT || <default>` -- and every probe
 * uses that value. One source of truth, no duplicated literal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
// PROBE_DIR = <repo>/tools/ats103-probes/lib -> three levels up is the repo
export const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..', '..');

const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'index.mjs');

/**
 * The default port the Bridge listens on, as a number.
 *
 * Throws if the product source no longer declares it in the expected shape:
 * a probe that silently falls back to a guess would test the wrong
 * configuration.
 */
export function defaultPort() {
  const src = fs.readFileSync(SERVER_ENTRY, 'utf8');
  const m = /ATS_PORT\s*\|\|\s*(\d+)/.exec(src);
  if (!m) {
    throw new Error(
      `could not read the default port from ${SERVER_ENTRY} -- the ATS_PORT fallback was not found`,
    );
  }
  return Number(m[1]);
}

/** The default port as a string, for use in URLs and header values. */
export function defaultPortString() {
  return String(defaultPort());
}
