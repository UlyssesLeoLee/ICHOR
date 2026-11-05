/**
 * ATS-205 -- the bridge writes the metadata mirror at runtime.
 *
 * These are the IT-level cases: the bridge is started as a real process
 * against a real data directory, and the metadata database that appears
 * there has to hold what the bridge wrote.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.mjs';
import { openDatabase, closeDatabase, currentVersion } from '../server/sqlite/db.mjs';
import { counts } from '../server/sqlite/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-sqlite-bridge-'));
const project = path.join(dir, 'app');
const data = path.join(dir, 'data');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'package.json'), '{}');
fs.writeFileSync(path.join(project, 'index.js'), 'module.exports = {};\n');
// The bridge refuses a project without a Playwright configuration, so the
// fixture carries one -- exactly like the fixture of the other IT tests.
fs.writeFileSync(path.join(project, 'playwright.config.ts'), 'export default {}');
fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
fs.writeFileSync(path.join(project, 'tests', 'pass.spec.ts'), "test('simulated success', ()=>{});\n");

const port = await freePort();
let cp = null;
let token = null;

async function ready() {
  for (let i = 0; i < 70; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 35));
  }
  throw new Error('bridge unreachable');
}

async function req(endpoint, method = 'GET', body) {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: token ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return [r.status, await r.json()];
}

test('IT-SQL-001: the bridge starts and creates the metadata database', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data },
    stdio: 'ignore',
  });
  await ready();
  token = (await req('/api/session'))[1].token;
  assert.ok(token, 'the bridge did not hand out a session token');
  assert.ok(fs.existsSync(path.join(data, 'metadata.db')), 'the metadata database was not created');
});

test('IT-SQL-002: the metadata database carries the schema version', () => {
  const db = openDatabase(path.join(data, 'metadata.db'), { migrate: false });
  try {
    assert.ok(currentVersion(db) > 0, 'the metadata database carries no schema version');
  } finally { closeDatabase(db); }
});

test('IT-SQL-003: a registered project appears in the metadata database', async () => {
  const [code, body] = await req('/api/projects', 'POST', { path: project });
  assert.equal(code, 201, JSON.stringify(body));
  const db = openDatabase(path.join(data, 'metadata.db'), { migrate: false });
  try {
    const rows = db.prepare('SELECT id,uid,name FROM projects').all();
    assert.equal(rows.length, 1, `expected one project row, found ${rows.length}`);
    assert.equal(rows[0].id, body.project.id);
    // The UID of the project (ATS-201) is indexed too, so the history can
    // be queried by the stable identifier.
    assert.ok(rows[0].uid, 'the project row carries no UID');
  } finally { closeDatabase(db); }
});

test('IT-SQL-004: the mirror holds exactly what the JSON state holds', async () => {
  const state = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  const db = openDatabase(path.join(data, 'metadata.db'), { migrate: false });
  try {
    const c = counts(db);
    assert.equal(c.projects, state.projects.length);
    assert.equal(c.runs, state.runs.length);
    const stateCounterKeys = Object.keys(state.runCounters ?? {}).length;
    assert.equal(c.runCounters, stateCounterKeys);
  } finally { closeDatabase(db); }
});

test('IT-SQL-005: the bridge still serves the API after the mirror is in place', async () => {
  const [code, body] = await req('/api/projects');
  assert.equal(code, 200);
  assert.ok(Array.isArray(body.projects));
  assert.equal(body.projects.length, 1);
});

test('IT-SQL-CLEANUP: stop and cleanup', () => {
  if (cp) cp.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});
