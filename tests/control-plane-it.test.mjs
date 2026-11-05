// ATS-506 integration tests: the local Bridge (P1) and the deployable control
// plane (P2) run side by side as real child processes started with plain
// Node -- no Tauri. Catalog: IT-CP-* in tools/generate_test_docs.py; design:
// docs/21-CONTROL-PLANE-API.md §10.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const example = path.resolve(root, 'examples/sample-playwright');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-cp-it-'));
const bridgePort = 30000 + Math.floor(Math.random() * 5000);
const cpPort = bridgePort + 5000;
const CP_TOKEN_A = `it-tenant-a-${'k'.repeat(32)}`;
const CP_TOKEN_B = `it-tenant-b-${'q'.repeat(32)}`;

let bridge;
let cp;
let localToken;
let localProjectRoot;
const cpResponses = [];

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`did not boot: ${url}`);
}

/** Raw HTTP so the request target reaches the server unchanged. */
function raw(port, method, target, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    if (payload !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Every control-plane response is kept for the global leak scan (IT-CP-011). */
async function cpCall(method, target, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const r = await raw(cpPort, method, target, { ...opts, headers });
  cpResponses.push({ method, target, ...r });
  return r;
}

const bridgeCall = (method, target, opts = {}) => raw(bridgePort, method, target, opts);

function exited(child) {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

test('IT-CP-SETUP: the local Bridge and the control plane start as independent plain-Node processes', async () => {
  bridge = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, ATS_PORT: String(bridgePort), ATS_DATA_DIR: data }, stdio: 'ignore' });
  // The control plane gets the local data directory in its environment on
  // purpose: IT-CP-011 proves it never surfaces in any response.
  cp = spawn(process.execPath, ['server/control-plane/main.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_DATA_DIR: data, ATS_PORT: String(bridgePort), ATS_CP_PORT: String(cpPort), ATS_CP_AUTH: 'dev-static', ATS_CP_DEV_TOKENS: JSON.stringify({ [CP_TOKEN_A]: 'ten_it_a', [CP_TOKEN_B]: 'ten_it_b' }) },
    stdio: 'ignore',
  });
  await waitFor(`http://127.0.0.1:${bridgePort}/api/health`);
  await waitFor(`http://127.0.0.1:${cpPort}/cp/v1/health`);
  const session = await bridgeCall('GET', '/api/session');
  localToken = session.json.token;
  assert.match(localToken, /^[0-9a-f]{48}$/);
});

test('IT-CP-001: the control plane is fully usable without Tauri', async () => {
  const health = await cpCall('GET', '/cp/v1/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.plane, 'control-plane');
  const contract = await cpCall('GET', '/cp/v1/contract', { token: CP_TOKEN_A });
  assert.equal(contract.status, 200);
  assert.equal(contract.json.tauriRequired, false);
  assert.equal(contract.json.localBridgeReachable, false);
});

test('IT-CP-002: the local session token is not a control-plane credential', async () => {
  for (const headers of [{ 'X-ATS-Token': localToken }, { authorization: `Bearer ${localToken}` }, { 'X-ATS-Token': localToken, authorization: `Bearer ${CP_TOKEN_A}` }]) {
    const r = await cpCall('GET', '/cp/v1/projects', { headers });
    assert.equal(r.status, 401, r.text);
    assert.equal(r.json.error, 'REMOTE_UNAUTHENTICATED');
  }
});

test('IT-CP-003: the control-plane token is not a local Bridge credential', async () => {
  for (const headers of [{ 'X-ATS-Token': CP_TOKEN_A }, { authorization: `Bearer ${CP_TOKEN_A}` }]) {
    const r = await bridgeCall('GET', '/api/projects', { headers });
    assert.equal(r.status, 401, r.text);
    assert.equal(r.json.error, 'INVALID_SESSION');
  }
});

test('IT-CP-004: the control plane does not serve local Bridge endpoints', async () => {
  for (const target of ['/api/session', '/api/projects', '/api/health', '/api/diagnostics']) {
    const r = await cpCall('GET', target, { token: CP_TOKEN_A });
    assert.equal(r.status, 403, target);
    assert.equal(r.json.error, 'REMOTE_POLICY_REJECTED');
    assert.ok(!r.text.includes(localToken));
  }
});

test('IT-CP-005: the local Bridge does not serve control-plane endpoints', async () => {
  for (const target of ['/cp/v1/health', '/cp/v1/projects']) {
    const r = await bridgeCall('GET', target);
    assert.equal(r.status, 404, target);
    assert.equal(r.json, null, 'the Bridge answers with its static 404, not a control-plane JSON body');
  }
});

test('IT-CP-006: registration requests carrying local paths are refused', async () => {
  for (const displayName of ['C:\\Users\\dev\\repo', 'D:/work/repo', '\\\\fileserver\\share\\repo', '/home/dev/repo', '/Users/dev/repo', 'file:///C:/repo', 'C%3A%5Crepo', '~/repo', example]) {
    const r = await cpCall('POST', '/cp/v1/projects', { token: CP_TOKEN_A, body: { displayName } });
    assert.equal(r.status, 422, displayName);
    assert.equal(r.json.error, 'REMOTE_PATH_FORBIDDEN');
  }
});

test('IT-CP-007: a path or repository address used instead of a UID is refused', async () => {
  for (const body of [{ path: example }, { root: 'repo' }, { repositoryUrl: 'git@example.com:o/r.git' }, { displayName: 'x', workspace: 'w' }]) {
    const r = await cpCall('POST', '/cp/v1/projects', { token: CP_TOKEN_A, body });
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.equal(r.json.error, 'REMOTE_PATH_FORBIDDEN');
  }
  for (const target of [`/cp/v1/projects/${encodeURIComponent(example)}`, '/cp/v1/projects/..%2F..%2Fapi%2Fsession', '/cp/v1/../api/session', `/cp/v1/projects?root=${encodeURIComponent(example)}`]) {
    const r = await cpCall('GET', target, { token: CP_TOKEN_A });
    assert.equal(r.status, 422, target);
    assert.equal(r.json.error, 'REMOTE_PATH_FORBIDDEN');
  }
});

test('IT-CP-008: the local session token in a request body is refused as an inline secret', async () => {
  for (const body of [{ displayName: localToken }, { displayName: 'x', token: localToken }, { displayName: 'x', note: [localToken] }]) {
    const r = await cpCall('POST', '/cp/v1/projects', { token: CP_TOKEN_A, body });
    assert.equal(r.status, 422, JSON.stringify(Object.keys(body)));
    assert.equal(r.json.error, 'REMOTE_SECRET_INLINE_FORBIDDEN');
  }
});

let projectUid;
test('IT-CP-009: project metadata is registered and read by opaque UID; responses carry no path', async () => {
  const created = await cpCall('POST', '/cp/v1/projects', { token: CP_TOKEN_A, body: { displayName: 'Sample checkout suite' } });
  assert.equal(created.status, 201, created.text);
  projectUid = created.json.project.projectUid;
  assert.match(projectUid, /^prj_[0-9a-f-]{36}$/);
  const one = await cpCall('GET', `/cp/v1/projects/${projectUid}`, { token: CP_TOKEN_A });
  assert.equal(one.status, 200);
  assert.deepEqual(Object.keys(one.json.project).sort(), ['createdAt', 'displayName', 'projectUid']);
  const list = await cpCall('GET', '/cp/v1/projects', { token: CP_TOKEN_A });
  assert.deepEqual(list.json.projects.map((p) => p.projectUid), [projectUid]);
});

test('IT-CP-010: another tenant gets 404 for the project; a client-chosen tenant is refused', async () => {
  const foreign = await cpCall('GET', `/cp/v1/projects/${projectUid}`, { token: CP_TOKEN_B });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.error, 'REMOTE_RESOURCE_NOT_FOUND');
  const mismatch = await cpCall('GET', '/cp/v1/projects', { token: CP_TOKEN_B, headers: { 'X-ATS-Tenant': 'ten_it_a' } });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.json.error, 'REMOTE_TENANT_MISMATCH');
});

test('IT-CP-012: the local Bridge still registers projects by path, and the control plane never sees them', async () => {
  const r = await bridgeCall('POST', '/api/projects', { headers: { 'X-ATS-Token': localToken }, body: { path: example } });
  assert.equal(r.status, 201, r.text);
  localProjectRoot = r.json.project.root;
  assert.ok(path.isAbsolute(localProjectRoot));
  for (const token of [CP_TOKEN_A, CP_TOKEN_B]) {
    const list = await cpCall('GET', '/cp/v1/projects', { token });
    assert.ok(!list.text.includes(r.json.project.id));
    assert.ok(!list.text.includes('sample-playwright'));
  }
});

test('IT-CP-011: no control-plane response contains the local data directory, a local project path or the local session token', () => {
  assert.ok(cpResponses.length >= 30, `only ${cpResponses.length} responses collected`);
  const needles = [data, data.replace(/\\/g, '/'), JSON.stringify(data).slice(1, -1), localToken, localProjectRoot, JSON.stringify(localProjectRoot).slice(1, -1), example, os.homedir()];
  for (const r of cpResponses) {
    for (const needle of needles) assert.ok(!r.text.includes(needle), `${r.method} ${r.target} leaks ${needle}`);
    assert.ok(r.json && typeof r.json === 'object', `${r.method} ${r.target} is not JSON`);
    if (r.status >= 400) assert.match(r.json.error, /^REMOTE_/);
  }
});

test('IT-CP-013: the control plane refuses to share the local Bridge port', async () => {
  const child = spawn(process.execPath, ['server/control-plane/main.mjs'], { cwd: root, env: { ...process.env, ATS_PORT: String(bridgePort), ATS_CP_PORT: String(bridgePort) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  const code = await exited(child);
  assert.equal(code, 2);
  assert.match(stderr, /ATS_CP_PORT/);
});

test('IT-CP-CLEANUP: child processes and the temporary data directory are removed', async () => {
  const waits = [exited(bridge), exited(cp)];
  bridge.kill();
  cp.kill();
  await Promise.all(waits);
  fs.rmSync(data, { recursive: true, force: true });
  assert.equal(fs.existsSync(data), false);
});
