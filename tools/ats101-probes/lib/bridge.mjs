/**
 * Shared helpers for the ATS-101 reproducible probes.
 *
 * Every path is derived from this file's own location, so the probes run from
 * any checkout without editing. The fixture projects are materialised under
 * $ATS_PROBE_WORKDIR (default: $TMPDIR/ats101-probes) and are NOT part of the
 * repository -- only the harness that creates them is.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
// PROBE_DIR = <repo>/tools/ats101-probes/lib  ->  three levels up is the repo
export const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..', '..');
export const WORK_ROOT = path.resolve(
  process.env.ATS_PROBE_WORKDIR
    || path.join(process.env.TMPDIR || os.tmpdir(), 'ats101-probes'),
);

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function freshDir(p) {
  fs.rmSync(p, { recursive: true, force: true });
  return ensureDir(p);
}

/** Boot the Node bridge from `root` (a directory that contains server/index.mjs). */
export function startBridge({ root, dataDir, port }) {
  ensureDir(dataDir);
  const cp = spawn(process.execPath, [path.join(root, 'server', 'index.mjs')], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  cp.stdout.on('data', (b) => output.push(b.toString('utf8')));
  cp.stderr.on('data', (b) => output.push(b.toString('utf8')));
  cp.probeOutput = output;
  return cp;
}

export async function waitForHealth(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`bridge did not become healthy on ${base}`);
}

export async function api(base, token, method, pathname, body) {
  const headers = { 'X-ATS-Token': token, 'Content-Type': 'application/json' };
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

export async function session(base) {
  const r = await fetch(`${base}/api/session`);
  return (await r.json()).token;
}

/** Poll one run until it reaches a terminal status. */
export async function waitForTerminal(base, token, runId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api(base, token, 'GET', `/api/runs/${runId}`);
    const s = body?.run?.status;
    if (s && !['queued', 'running', 'cancelling'].includes(s)) return body.run;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`run ${runId} did not reach a terminal status within ${timeoutMs}ms`);
}

/** Hard-kill the bridge the way a crash / taskkill would: no JS handler runs. */
export function hardKill(cp) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(cp.pid), '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(cp.pid, 'SIGKILL'); } catch {}
  }
}

/** Copy the product server/ into a sandbox so a control experiment can patch it. */
export function copyServerToSandbox(sandboxRoot) {
  const src = path.join(REPO_ROOT, 'server');
  const dst = path.join(sandboxRoot, 'server');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, name), path.join(dst, name));
  }
  return dst;
}
