/**
 * The product's ABSOLUTE API base, derived from the product source.
 *
 * The exported page resolves the API base at runtime: when the page sits on
 * the Bridge's own port the base is the EMPTY STRING (so the browser
 * resolves the request against the page's own origin), otherwise it is an
 * absolute address. The ST probe needs to know that absolute address to
 * tell "the base was resolved at runtime" apart from "the base was baked in
 * at build time" -- and it must learn it from the PRODUCT, not from a copy
 * of its own, because a copy can drift and a copy of the port would also
 * be a port mention the ATS-101 port audit has to count.
 *
 * So the address is READ OUT of apps/studio/lib/api.ts, the one place it is
 * defined. No literal is written here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './default-port.mjs';

const API_TS = path.join(REPO_ROOT, 'apps', 'studio', 'lib', 'api.ts');

/**
 * The absolute API base the product falls back to, e.g. `http://127.0.0.1:<port>`.
 *
 * Throws if the product source no longer has the expected shape: a probe
 * that silently fell back to a guess would test the wrong thing.
 */
export function absoluteApiBase() {
  const src = fs.readFileSync(API_TS, 'utf8');
  const line = src.split('\n').find((l) => l.startsWith('const root='));
  if (!line) {
    throw new Error(
      `could not read the API base from ${API_TS} -- the 'const root=' definition was not found`,
    );
  }
  const m = /'(https?:\/\/[^']+)'/.exec(line);
  if (!m) {
    throw new Error(
      `could not read the absolute API base out of ${API_TS} -- no absolute URL literal on the base definition`,
    );
  }
  return m[1];
}

/** The HOST:PORT of the absolute API base the product falls back to. */
export function absoluteApiBaseHost() {
  return new URL(absoluteApiBase()).host;
}
