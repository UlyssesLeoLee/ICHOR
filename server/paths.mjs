/**
 * The path and digest helpers that BOTH the core and the mobile contract
 * need.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `server/core.mjs` owns the project's file handling, and
 * `server/adapters/mobile-target.mjs` needs the SAME two things: the
 * containment check for an evidence path and the SHA-256 of a file. It used
 * to import them from `core.mjs`.
 *
 * That import was the tail of a CYCLE. The mobile Flow import (ATS-602)
 * lives under `server/discovery/` and is used by the core, and the mobile
 * contract is used by the mapper, so the chain became:
 *
 *     core.mjs -> discovery/mobile-flow-import.mjs
 *              -> discovery/mobile-import.mjs
 *              -> adapters/mobile-target.mjs
 *              -> core.mjs          <-- back to the start
 *
 * An ES module cycle is not an error in itself, but the ORDER of the
 * initialisation then decides: `mobile-target.mjs` reads `MOBILE_STEP_KINDS`
 * at load time and got a value that was not initialised yet -- the error
 * was `Cannot access 'MOBILE_STEP_KINDS' before initialization`.
 *
 * The fix is to give the two shared helpers a home of their own: a module
 * that depends on NOTHING but the Node builtins. Both `core.mjs` and
 * `mobile-target.mjs` import from here, and the cycle is gone.
 *
 * The functions are the SAME ones as before, moved verbatim: the core
 * re-exports them so that every existing caller keeps working.
 */
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * The SHA-256 of a string or a buffer, as a hex digest.
 *
 * The evidence digest is computed by the HOST and never accepted from the
 * caller: a screenshot produced by a device is untrusted input, and
 * untrusted input does not get to name its own digest (FR-015).
 */
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * True when `other` is INSIDE `root`.
 *
 * The containment rule of the platform: a path that IS the root is not
 * inside it, a path that climbs out with `..` is not inside it, and an
 * absolute path is not inside it. It is the check that keeps a relative
 * path from reaching outside the tree it is resolved against.
 */
export function isSubpath(root, other) {
  const rel = path.relative(root, other);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
