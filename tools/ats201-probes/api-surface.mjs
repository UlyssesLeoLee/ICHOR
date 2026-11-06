#!/usr/bin/env node
/**
 * ATS-201: dumps the API surface that exposes the stable UIDs.
 *
 * It starts the bridge on an isolated port and data directory, registers the
 * example project and prints the relevant responses verbatim.
 *
 * Usage: node tools/ats201-probes/api-surface.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PORT = Number(process.env.ATS201_API_PORT || 24777);
const BASE = `http://127.0.0.1:${PORT}`;
const WORK = path.join(os.tmpdir(), 'ats201-api-surface');
const DATA = path.join(WORK, 'data');

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const cp = spawn(process.execPath, ['server/index.mjs'], {
  cwd: REPO_ROOT,
  env: { ...process.env, ATS_PORT: String(PORT), ATS_DATA_DIR: DATA },
  stdio: 'ignore'
});

let token = '';
async function api(pathname, method = 'GET', payload) {
  const r = await fetch(BASE + pathname, {
    method,
    headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  return [r.status, await r.json()];
}
const show = (label, status, body) => {
  console.log(`--- ${label} ---`);
  console.log(`HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  console.log('');
};

try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  token = (await api('/api/session'))[1].token;

  const [, reg] = await api('/api/projects', 'POST', { path: path.join(REPO_ROOT, 'examples', 'sample-playwright') });
  show('POST /api/projects', 201, reg);

  const uid = reg.project.uid;
  const [, cat] = await api(`/api/projects/${uid}/tests`);
  console.log('--- GET /api/projects/:uid/tests (abridged) ---');
  console.log(JSON.stringify({
    uidVersion: cat.uidVersion,
    projectUid: cat.projectUid,
    warning: cat.warning,
    files: cat.files,
    tests: cat.tests
  }, null, 2));
  console.log('');

  const [, run] = await api(`/api/projects/${uid}/run`, 'POST', {});
  console.log('--- POST /api/projects/:uid/run ---');
  console.log(JSON.stringify({
    status: run.run.status,
    id: run.run.id,
    uid: run.run.uid,
    seq: run.run.seq,
    projectId: run.run.projectId,
    projectUid: run.run.projectUid,
    gitCommit: run.run.gitCommit
  }, null, 2));
  console.log('');

  const [, runs] = await api('/api/runs');
  console.log('--- GET /api/runs (abridged) ---');
  console.log(JSON.stringify(runs.runs.map((r) => ({ id: r.id, uid: r.uid, seq: r.seq, status: r.status, projectUid: r.projectUid })), null, 2));
  console.log('');

  const [, state] = await api('/api/diagnostics');
  console.log('--- GET /api/diagnostics ---');
  console.log(JSON.stringify(state, null, 2));
} finally {
  cp.kill();
}
