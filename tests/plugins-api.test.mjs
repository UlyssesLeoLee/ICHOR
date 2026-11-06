/**
 * ATS-512 integration tests: the plugin contract over HTTP.
 *
 * These boot the real Bridge on an isolated data directory and a random port,
 * exactly like tests/agent-api.test.mjs does for the agent contract. They
 * prove the two plugin endpoints and their error mapping:
 *
 *   - GET  /api/plugins/contract   -- the permission list and the SDK surface;
 *   - POST /api/plugins/validate  -- a manifest is checked, and the response
 *     says which permissions the host tier would actually grant;
 *   - a manifest that violates the contract is a 400 with a PLUGIN_* code;
 *   - the endpoint does not load, run or install anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-plg-api-'));
const port = 33000 + Math.floor(Math.random() * 6000);
let cp, token;

// The ready() window below is 400 attempts, not the 70-100 it used to be.
// `npm test` runs the test files in PARALLEL, and 14 of them each boot a
// Bridge. Booting 14 servers at once is slow: measured on this machine the
// boot takes 1289 / 5637 / 8582 ms (min / median / max), while the old
// windows only allowed 4000 ms (80 x 50ms) or 2450 ms (70 x 35ms). So the
// slow ones gave up with "server did not boot" -- non-deterministically, on a
// DIFFERENT subset each run.
//
// It was never a port collision: 14 concurrent servers were measured and
// their ports were all distinct. 400 attempts x 50ms = 20s and x 35ms = 14s,
// which covers the measured worst case with room to spare, and a test that
// genuinely cannot start still fails instead of hanging forever.
async function ready() {
  // The health probe is BOUNDED. An unbounded fetch turns ONE request that
  // never comes back into a stall of the whole boot window, and the boot wait
  // then reports "the bridge did not come up" for a bridge that IS listening
  // and merely busy. Measured: a hung probe made the wait 31 s long (the 20 s
  // window plus an ~11 s request that never came back). The timeout is far
  // below the window, so a slow-but-alive bridge is still found, and a hung
  // request is retried instead of consuming the wait.
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not boot');
}

async function api(endpoint, method = 'GET', payload, auth = true) {
  const r = await fetch(`http://127.0.0.1:${port}` + endpoint, {
    method,
    headers: auth ? { 'X-ATS-Token': token, 'Content-Type': 'application/json' } : {},
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return [r.status, await r.json()];
}

function manifest(overrides = {}) {
  return {
    id: 'demo-runner',
    version: '1.0.0',
    kind: 'runner',
    entry: 'index.mjs',
    protocol: { major: 1, minor: 0 },
    capabilities: ['discover', 'start', 'stop', 'collect'],
    permissions: ['test.read'],
    publisher: { name: 'Example Publisher' },
    ...overrides,
  };
}

test('IT-PLG-SETUP: start server', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data },
    stdio: 'ignore',
  });
  await ready();
  const r = await api('/api/session');
  token = r[1].token;
  assert.ok(token);
});

test('IT-PLG-001: the plugin contract is exposed over HTTP', async () => {
  const r = await api('/api/plugins/contract');
  assert.equal(r[0], 200);
  assert.equal(r[1].contract, 'plugin-contract/v1');
  assert.equal(r[1].manifestVersion, 'plugin-manifest/v1');
  // The permission list and the SDK surface are both there.
  const names = r[1].permissions.map((p) => p.name);
  assert.ok(names.includes('test.read'));
  assert.ok(names.includes('outcome.report'));
  assert.ok(r[1].forbiddenPermissions.includes('source.write'));
  assert.ok(r[1].forbiddenPermissions.includes('audit.suppress'));
  const operations = r[1].operations.map((o) => o.name);
  assert.deepEqual(operations.sort(), ['describe', 'readRequirements', 'readRunEvidence', 'readTestFile', 'reportOutcome']);
});

test('IT-PLG-002: the plugin endpoints need a session token', async () => {
  const r = await api('/api/plugins/contract', 'GET', undefined, false);
  assert.equal(r[0], 401);
  assert.equal(r[1].error, 'INVALID_SESSION');
});

test('IT-PLG-003: a valid manifest is accepted and the granted set is reported', async () => {
  const r = await api('/api/plugins/validate', 'POST', { manifest: manifest() });
  assert.equal(r[0], 200);
  assert.equal(r[1].valid, true);
  assert.equal(r[1].contract, 'plugin-contract/v1');
  assert.deepEqual(r[1].grantedPermissions, ['test.read']);
  assert.deepEqual(r[1].deniedPermissions, []);
  assert.equal(r[1].manifest.id, 'demo-runner');
});

test('IT-PLG-004: the tier is the ceiling -- the same manifest grants more under a higher tier', async () => {
  const declared = ['test.read', 'evidence.read', 'outcome.report'];
  const readOnly = await api('/api/plugins/validate', 'POST', { manifest: manifest({ permissions: declared }), tier: 'readonly' });
  const reporter = await api('/api/plugins/validate', 'POST', { manifest: manifest({ permissions: declared }), tier: 'reporter' });
  assert.equal(readOnly[0], 200);
  assert.equal(reporter[0], 200);
  assert.deepEqual(readOnly[1].grantedPermissions, ['test.read']);
  assert.deepEqual(
    reporter[1].grantedPermissions,
    ['evidence.read', 'outcome.report', 'test.read'],
  );
  // The denied ones carry the reason.
  const denied = reporter[1].deniedPermissions;
  assert.equal(denied.length, 0);
  const deniedReadOnly = readOnly[1].deniedPermissions;
  assert.equal(deniedReadOnly.length, 2);
  for (const d of deniedReadOnly) assert.equal(d.reason, 'not-in-tier');
});

test('IT-PLG-005: a manifest requesting a forbidden permission is a 400 with the code', async () => {
  const r = await api('/api/plugins/validate', 'POST', { manifest: manifest({ permissions: ['source.write'] }) });
  assert.equal(r[0], 400);
  assert.equal(r[1].error, 'PLUGIN_PERMISSION_FORBIDDEN');
  assert.equal(r[1].details.permission, 'source.write');
});

test('IT-PLG-006: a manifest requesting an unknown permission is a 400 with the code', async () => {
  const r = await api('/api/plugins/validate', 'POST', { manifest: manifest({ permissions: ['files.delete'] }) });
  assert.equal(r[0], 400);
  assert.equal(r[1].error, 'PLUGIN_PERMISSION_UNKNOWN');
});

test('IT-PLG-007: an unsupported manifest version is a 400 with the code', async () => {
  const r = await api('/api/plugins/validate', 'POST', { manifest: manifest({ contract: 'plugin-manifest/v2' }) });
  assert.equal(r[0], 400);
  assert.equal(r[1].error, 'PLUGIN_MANIFEST_VERSION_UNSUPPORTED');
});

test('IT-PLG-008: an unknown capability is a 400 with the code', async () => {
  const r = await api('/api/plugins/validate', 'POST', { manifest: manifest({ capabilities: ['teleport'] }) });
  assert.equal(r[0], 400);
  assert.equal(r[1].error, 'PLUGIN_CAPABILITY_UNKNOWN');
});

test('IT-PLG-009: a runner without the four required capabilities is a 400', async () => {
  const r = await api('/api/plugins/validate', 'POST', { manifest: manifest({ capabilities: ['discover'] }) });
  assert.equal(r[0], 400);
  assert.equal(r[1].error, 'PLUGIN_CAPABILITY_REQUIRED');
  assert.deepEqual(r[1].details.missing, ['start', 'stop', 'collect']);
});

test('IT-PLG-010: the error response carries no local filesystem path', async () => {
  const r = await api('/api/plugins/validate', 'POST', { manifest: manifest({ entry: 'C:/Windows/win.ini' }) });
  assert.equal(r[0], 400);
  assert.equal(r[1].error, 'PLUGIN_MANIFEST_INVALID');
  const body = JSON.stringify(r[1]);
  assert.ok(!body.includes(root), 'the response leaks the repository path');
  assert.ok(!/:\/\//.test(body.replace(/https?:\/\//g, '')), 'the response leaks a path');
});

test('IT-PLG-011: the validation endpoint does not load or run anything', async () => {
  const before = fs.readdirSync(data);
  const r = await api('/api/plugins/validate', 'POST', { manifest: manifest() });
  assert.equal(r[0], 200);
  // The data directory gained no plugin directory, no installed copy and no
  // run folder: the endpoint only validates.
  const after = fs.readdirSync(data);
  assert.deepEqual(after.sort(), before.sort());
});

test('IT-PLG-012: the diagnostics endpoint reports the plugin contract status', async () => {
  const r = await api('/api/diagnostics');
  assert.equal(r[0], 200);
  assert.equal(r[1].pluginContract.version, 'plugin-contract/v1');
  assert.equal(r[1].pluginContract.status, 'CONTRACT_ONLY');
});

test('IT-PLG-013: a non-plugin error keeps its pre-ATS-512 behaviour', async () => {
  // The PLUGIN_* mapping is scoped: an unrelated error is still mapped by
  // the pre-existing message pattern, and carries no plugin details.
  const r = await api('/api/projects', 'POST', { path: path.join(data, 'definitely-missing') });
  assert.equal(r[0], 500);
  assert.ok(!('details' in r[1]) || !JSON.stringify(r[1].details).includes('PLUGIN_'));
});

test('IT-PLG-CLEANUP: stop and cleanup', () => {
  cp.kill();
  fs.rmSync(data, { recursive: true, force: true });
});
