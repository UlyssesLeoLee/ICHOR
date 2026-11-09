/**
 * Port management for the ATS-103 probes.
 *
 * Two things the probes need, and neither of them is "hope the port is
 * free":
 *
 *   1. WAIT until the port can actually be bound. A probe that finds the
 *      port busy aborts with "the probe would talk to a DIFFERENT server",
 *      and that is the right thing to do -- but only if the port really is
 *      held by someone else. On Windows a process that is killed with
 *      TerminateProcess (what child.kill() does) does NOT close its
 *      sockets gracefully: the listening socket survives as a ZOMBONE
 *      whose owning PID is 0, and it keeps the port un-bindable for a
 *      moment. A probe that starts right after the previous one therefore
 *      sees a busy port that nobody owns.
 *
 *   2. END THE WHOLE PROCESS TREE, not just the process that was started.
 *      The Bridge spawns the Playwright driver and its browser; ending only
 *      the Bridge leaves those running.
 *
 * The port is NEVER written here: it is read from the product source by
 * default-port.mjs, because a port literal in a probe is a port mention
 * the ATS-101 port audit has to count.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { defaultPort } from './default-port.mjs';

export { defaultPort };

/**
 * Can the port be bound right now?
 *
 * The check is a real bind attempt, not a guess from the socket table: a
 * socket table row can be a TIME_WAIT remnant (which does NOT block a
 * bind) as easily as a live listener (which does).
 */
export function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * Wait until the port can be bound.
 *
 * Returns how long it took, or null when the port was still busy after
 * the timeout. The caller decides what to do about a null -- the probes
 * fail closed, the evidence script aborts.
 */
export async function waitForPortFree(port, timeoutMs = 10000, intervalMs = 100) {
  const t0 = Date.now();
  for (;;) {
    if (await portIsFree(port)) return Date.now() - t0;
    if (Date.now() - t0 >= timeoutMs) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * End a process AND everything it started.
 *
 * On Windows, child.kill() is TerminateProcess: it ends the process but
 * leaves its children running, and it does not close its sockets
 * gracefully. `taskkill /T` ends the whole tree.
 */
export function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { /* best effort */ }
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* not a group leader */ }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

/**
 * Stop a child process AND wait until the port it held can be bound again.
 *
 * The wait is what makes two probes in a row reliable: the port is only
 * usable once the previous listener's socket has been reaped.
 */
export async function stopChildAndReleasePort(child, port, timeoutMs = 10000) {
  killProcessTree(child.pid);
  // The child is gone; give the socket a moment to be reaped even if the
  // port is already bindable, so the next probe starts from a clean state.
  try { child.kill(); } catch { /* already gone */ }
  const waited = await waitForPortFree(port, timeoutMs);
  return waited;
}

// --- the command line form, so the shell scripts can use it ---------------
//
//   node tools/ats103-probes/lib/port-free.mjs --wait [--port <n>]
//
// Exit code 0 = the port is free; 1 = it was still busy after the timeout.

import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const portIndex = argv.indexOf('--port');
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : defaultPort();
  const timeoutIndex = argv.indexOf('--timeout');
  const timeoutMs = timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : 15000;
  const waited = await waitForPortFree(port, timeoutMs);
  if (waited === null) {
    console.error(`port ${port} is still in use after ${timeoutMs}ms`);
    process.exit(1);
  }
  console.log(`port ${port} is free (waited ${waited}ms)`);
  process.exit(0);
}
