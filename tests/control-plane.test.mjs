// ATS-506 unit tests: the deployable control-plane API (/cp/v1) and its
// boundary against the desktop local Bridge. Catalog: UT-CP-001..030 in
// tools/generate_test_docs.py; design: docs/21-CONTROL-PLANE-API.md.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { detectLocalPath, isLocalSessionTokenShape, classifyField, inspectValue, LOCAL_CREDENTIAL_HEADERS } from '../server/control-plane/boundary.mjs';
import { REMOTE_CODES, ControlPlaneError, errorBody } from '../server/control-plane/errors.mjs';
import { denyAllAuthenticator, staticBearerAuthenticator, parseDevTokens } from '../server/control-plane/auth.mjs';
import { createControlPlane } from '../server/control-plane/app.mjs';
import { resolveConfig, buildAuthenticator, startControlPlane, runMain, isLoopbackHost, ConfigError, DEFAULT_PORT } from '../server/control-plane/main.mjs';

const root = path.resolve(import.meta.dirname, '..');
const TOKEN_A = 'a'.repeat(16) + 'A'.repeat(16) + '-dev-token-tenant-a';
const TOKEN_B = 'b'.repeat(16) + 'B'.repeat(16) + '-dev-token-tenant-b';
const HEX48 = '0123456789abcdef'.repeat(3);
const UID_RE = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Every server a test starts is closed at the end even when an assertion
// fails half-way, so a failing test never keeps the process alive.
const servers = [];
const track = (server) => { servers.push(server); return server; };
after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close(() => {});
  }
});

/** Start the handler in-process; `opts` override createControlPlane options. */
async function startApp(opts = {}) {
  const app = createControlPlane({ authenticate: staticBearerAuthenticator({ [TOKEN_A]: 'ten_a', [TOKEN_B]: 'ten_b' }), authMode: 'dev-static', ...opts });
  const server = track(http.createServer((req, res) => { app.handler(req, res); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { app, server, port: server.address().port };
}

/** Raw HTTP call: the request target is sent exactly as given (no dot-segment normalisation). */
function call(port, method, target, { body, headers = {}, token } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function assertRemoteError(r, status, code) {
  assert.equal(r.status, status, r.text);
  assert.equal(r.json.error, code, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ['error', 'hint', 'retryable']);
}

function nested(depth) {
  let v = 'leaf';
  for (let i = 0; i < depth; i++) v = { n: v };
  return v;
}

// --- boundary.mjs ----------------------------------------------------------
test('UT-CP-001: local path forms are detected with their rule name', () => {
  const cases = [
    ['C:\\repo', 'windows_drive_path'], ['c:/x', 'windows_drive_path'], ['C:', 'windows_drive_path'], ['see D:\\x', 'windows_drive_path'],
    ['\\\\srv\\share', 'unc_path'], ['\\\\?\\C:\\x', 'unc_path'], ['//srv/s', 'unc_path'], ['at \\\\srv\\share\\x', 'unc_path'],
    ['/home/a', 'posix_absolute_path'], ['/', 'posix_absolute_path'], ['at /Users/b/x', 'posix_absolute_path'],
    ['file:///C:/x', 'file_url'], ['~/r', 'home_relative_path'], ['~', 'home_relative_path'],
    ['%USERPROFILE%\\r', 'env_path'], ['$HOME/r', 'env_path'], ['${HOME}/r', 'env_path'],
    ['a/../b', 'path_traversal'], ['..', 'path_traversal'],
    ['git@github.com:o/r.git', 'repository_url'], ['ssh://h/r', 'repository_url'], ['https://h/o/r.git', 'repository_url'],
  ];
  for (const [input, rule] of cases) assert.equal(detectLocalPath(input), rule, input);
});

test('UT-CP-002: values that are not local paths are not flagged', () => {
  for (const input of ['https://example.com/a', 'prj_12345678-1234-1234-1234-123456789abc', 'a'.repeat(40), 'a/b',
    'Login / Logout', 'ns:name', 'TCP/IP', 'ratio 3:/x', 'Fix:/x', 'profile: x', '...', '', 42, null, undefined, {}]) {
    assert.equal(detectLocalPath(input), null, String(input));
  }
});

test('UT-CP-003: percent-encoded paths are refused like the plain form; malformed encoding falls back to the raw text', () => {
  assert.equal(detectLocalPath('C%3A%5Crepo'), 'windows_drive_path');
  assert.equal(detectLocalPath('%2Fhome%2Fa'), 'posix_absolute_path');
  assert.equal(detectLocalPath('%E0%A4%A'), null);
  assert.equal(detectLocalPath('100%'), null);
});

test('UT-CP-004: body inspection covers keys and values, nested objects and arrays, without echoing the value', () => {
  const f1 = inspectValue({ a: [{ b: 'C:\\x' }] });
  assert.deepEqual(f1, { code: 'REMOTE_PATH_FORBIDDEN', kind: 'windows_drive_path', pointer: '/a/0/b' });
  const f2 = inspectValue({ ok: 1, 'C:\\k': 1 });
  assert.equal(f2.code, 'REMOTE_PATH_FORBIDDEN');
  assert.equal(f2.pointer, '/#1');
  assert.ok(!JSON.stringify(f2).includes('C:'));
  assert.equal(inspectValue({ ok: 'x', list: ['y', 2, true, null] }), null);
  assert.equal(inspectValue('plain'), null);
  assert.equal(inspectValue(7), null);
});

test('UT-CP-005: path, repository-address and credential field names are classified', () => {
  assert.deepEqual(classifyField('path'), { code: 'REMOTE_PATH_FORBIDDEN', kind: 'path_field' });
  assert.deepEqual(classifyField('Project_Root'), { code: 'REMOTE_PATH_FORBIDDEN', kind: 'path_field' });
  assert.deepEqual(classifyField('repository-url'), { code: 'REMOTE_PATH_FORBIDDEN', kind: 'repository_url_field' });
  assert.deepEqual(classifyField('cloneUrl'), { code: 'REMOTE_PATH_FORBIDDEN', kind: 'repository_url_field' });
  for (const name of ['token', 'X-ATS-Token', 'apiKey', 'password', 'credentials']) {
    assert.deepEqual(classifyField(name), { code: 'REMOTE_SECRET_INLINE_FORBIDDEN', kind: 'credential_field' }, name);
  }
  assert.equal(classifyField('displayName'), null);
  assert.equal(classifyField(3), null);
  assert.deepEqual(LOCAL_CREDENTIAL_HEADERS, ['x-ats-token']);
  // Egress mode ignores names but still checks the values.
  assert.equal(inspectValue({ credential: 'Bearer' }, { fieldNames: false }), null);
  assert.equal(inspectValue({ credential: '/etc/x' }, { fieldNames: false }).kind, 'posix_absolute_path');
});

test('UT-CP-006: the local session token shape (48 hex) is refused; 40/64 hex are not', () => {
  assert.equal(isLocalSessionTokenShape(HEX48), true);
  assert.equal(isLocalSessionTokenShape(HEX48.toUpperCase()), true);
  for (const v of ['a'.repeat(40), 'a'.repeat(64), 'a'.repeat(47), 'a'.repeat(49), 'g'.repeat(48), 7]) assert.equal(isLocalSessionTokenShape(v), false, String(v));
  assert.deepEqual(inspectValue({ note: HEX48 }), { code: 'REMOTE_SECRET_INLINE_FORBIDDEN', kind: 'local_session_token_shape', pointer: '/note' });
});

test('UT-CP-007: nesting deeper than 32 levels is refused; 32 levels pass', () => {
  assert.equal(inspectValue(nested(32)), null);
  assert.deepEqual(inspectValue(nested(33)).kind, 'depth_exceeded');
  assert.equal(inspectValue(nested(33)).code, 'REMOTE_POLICY_REJECTED');
  assert.equal(inspectValue([[['x']]], { maxDepth: 2 }).kind, 'depth_exceeded');
});

// --- errors.mjs --------------------------------------------------------------
test('UT-CP-008: the code table equals the docs/19 constraint block code by code', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/19-REMOTE-RUNNER-PROTOCOL.md'), 'utf8');
  const at = doc.indexOf('<!-- ats501-constraints -->');
  assert.ok(at > 0);
  const m = /```json\s*([\s\S]*?)```/.exec(doc.slice(at));
  const block = JSON.parse(m[1]);
  const protocol = new Map(block.rejection.codes.map((c) => [c.code, c]));
  assert.deepEqual([...Object.keys(REMOTE_CODES)].sort(), [...protocol.keys()].sort());
  for (const [code, entry] of Object.entries(REMOTE_CODES)) {
    assert.equal(entry.http, protocol.get(code).http, code);
    assert.equal(entry.retryable, protocol.get(code).retryable, code);
    assert.ok(typeof entry.hint === 'string' && entry.hint.length > 0, code);
    assert.ok(code.startsWith('REMOTE_'));
    assert.ok(!['INVALID_SESSION', 'ORIGIN_NOT_ALLOWED', 'INVALID_HOST', 'NOT_FOUND'].includes(code));
  }
  assert.ok(Object.isFrozen(REMOTE_CODES));
});

test('UT-CP-009: unknown codes are programming errors; the audit reason never reaches the body', () => {
  assert.throws(() => new ControlPlaneError('NOT_A_CODE'), TypeError);
  assert.throws(() => errorBody('NOT_A_CODE'), TypeError);
  assert.throws(() => errorBody('toString'), TypeError);
  const e = new ControlPlaneError('REMOTE_PATH_FORBIDDEN', 'path_field');
  assert.equal(e.http, 422);
  assert.equal(e.retryable, false);
  assert.equal(e.reason, 'path_field');
  assert.equal(e.name, 'ControlPlaneError');
  const body = errorBody(e.code);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'hint', 'retryable']);
  assert.ok(!JSON.stringify(body).includes('path_field'));
  assert.equal(new ControlPlaneError('REMOTE_INTERNAL').reason, null);
});

// --- auth.mjs ------------------------------------------------------------------
test('UT-CP-010: authenticators map requests to a tenant or an audit-only reason', () => {
  const deny = denyAllAuthenticator();
  assert.deepEqual(deny({ headers: {} }), { ok: false, reason: 'missing_user_token' });
  assert.deepEqual(deny({ headers: { authorization: 'Bearer x' } }), { ok: false, reason: 'unknown_user_token' });
  assert.deepEqual(deny(undefined), { ok: false, reason: 'missing_user_token' });
  const auth = staticBearerAuthenticator({ [TOKEN_A]: 'ten_a' });
  const ok = auth({ headers: { authorization: `Bearer ${TOKEN_A}` } });
  assert.equal(ok.ok, true);
  assert.equal(ok.tenantId, 'ten_a');
  assert.match(ok.subject, /^dev:[0-9a-f]{8}$/);
  const wrongSameLength = TOKEN_A.slice(0, -1) + 'x';
  assert.deepEqual(auth({ headers: { authorization: `Bearer ${wrongSameLength}` } }), { ok: false, reason: 'unknown_user_token' });
  assert.deepEqual(auth({ headers: { authorization: 'Bearer short' } }), { ok: false, reason: 'unknown_user_token' });
  assert.deepEqual(auth({ headers: { authorization: `Basic ${TOKEN_A}` } }), { ok: false, reason: 'missing_user_token' });
  assert.deepEqual(auth({ headers: {} }), { ok: false, reason: 'missing_user_token' });
});

test('UT-CP-011: dev token configuration is validated without echoing tokens', () => {
  const short = 'x'.repeat(31);
  const cases = [{}, [], null, { [short]: 'ten_a' }, { [TOKEN_A]: 'tenant1' }, { [TOKEN_A]: `ten_${'a'.repeat(65)}` }, { [TOKEN_A]: 7 }];
  for (const map of cases) {
    assert.throws(() => staticBearerAuthenticator(map), (e) => e instanceof TypeError && !e.message.includes(short) && !e.message.includes(TOKEN_A));
  }
  assert.ok(staticBearerAuthenticator({ ['y'.repeat(32)]: `ten_${'a'.repeat(64)}` }));
  assert.throws(() => parseDevTokens('{not json'), TypeError);
  assert.throws(() => parseDevTokens('null'), TypeError);
  assert.deepEqual(parseDevTokens(JSON.stringify({ [TOKEN_A]: 'ten_a' })), { [TOKEN_A]: 'ten_a' });
});

// --- main.mjs ------------------------------------------------------------------
test('UT-CP-012: startup configuration defaults and accepted variants', () => {
  assert.deepEqual(resolveConfig({}), { host: '127.0.0.1', port: DEFAULT_PORT, tls: null, authMode: 'none' });
  assert.equal(DEFAULT_PORT, 4610);
  assert.deepEqual(resolveConfig(), { host: '127.0.0.1', port: DEFAULT_PORT, tls: null, authMode: 'none' });
  assert.equal(resolveConfig({ ATS_CP_HOST: '::1' }).host, '::1');
  assert.equal(resolveConfig({ ATS_CP_HOST: 'localhost', ATS_CP_PORT: '1' }).port, 1);
  assert.equal(resolveConfig({ ATS_CP_PORT: '65535', ATS_PORT: '' }).port, 65535);
  assert.deepEqual(resolveConfig({ ATS_CP_HOST: '0.0.0.0', ATS_CP_TLS_CERT: 'c.pem', ATS_CP_TLS_KEY: 'k.pem' }).tls, { certFile: 'c.pem', keyFile: 'k.pem' });
  assert.equal(resolveConfig({ ATS_CP_AUTH: 'dev-static', ATS_CP_DEV_TOKENS: '{}' }).authMode, 'dev-static');
  for (const h of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['0.0.0.0', '10.0.0.1', '::', 'example.com']) assert.equal(isLoopbackHost(h), false, h);
});

test('UT-CP-013: unsafe startup configurations are refused with exit code 2', () => {
  const bad = [
    [{ ATS_CP_HOST: '0.0.0.0' }, 'ATS_CP_HOST'],
    [{ ATS_CP_PORT: '24999', ATS_PORT: '24999' }, 'ATS_CP_PORT'],
    [{ ATS_CP_PORT: '0' }, 'ATS_CP_PORT'],
    [{ ATS_CP_PORT: '70000' }, 'ATS_CP_PORT'],
    [{ ATS_CP_PORT: '65536' }, 'ATS_CP_PORT'],
    [{ ATS_CP_PORT: 'abc' }, 'ATS_CP_PORT'],
    [{ ATS_CP_TLS_CERT: 'c.pem' }, 'ATS_CP_TLS_KEY'],
    [{ ATS_CP_TLS_KEY: 'k.pem' }, 'ATS_CP_TLS_CERT'],
    [{ ATS_CP_AUTH: 'oidc' }, 'ATS_CP_AUTH'],
    [{ ATS_CP_AUTH: 'dev-static', ATS_CP_HOST: '0.0.0.0', ATS_CP_TLS_CERT: 'c', ATS_CP_TLS_KEY: 'k', ATS_CP_DEV_TOKENS: '{}' }, 'ATS_CP_AUTH'],
    [{ ATS_CP_AUTH: 'dev-static' }, 'ATS_CP_DEV_TOKENS'],
  ];
  for (const [env, variable] of bad) {
    assert.throws(() => resolveConfig(env), (e) => e instanceof ConfigError && e.exitCode === 2 && e.variable === variable && e.message.startsWith(variable), JSON.stringify(env));
  }
  // An invalid token map surfaces as a ConfigError that does not echo the token.
  const config = resolveConfig({ ATS_CP_AUTH: 'dev-static', ATS_CP_DEV_TOKENS: JSON.stringify({ short: 'ten_a' }) });
  assert.throws(() => buildAuthenticator(config, { ATS_CP_DEV_TOKENS: JSON.stringify({ short: 'ten_a' }) }),
    (e) => e instanceof ConfigError && e.variable === 'ATS_CP_DEV_TOKENS' && !e.message.includes('short'));
  assert.equal(buildAuthenticator({ authMode: 'none' })({ headers: {} }).ok, false);
});

test('UT-CP-014: HTTPS uses TLS 1.3 minimum; plain HTTP listens and reports the auth mode without tokens', async () => {
  let httpsOptions = null;
  let httpCalled = false;
  const logs = [];
  const tlsConfig = { host: '127.0.0.1', port: 0, tls: { certFile: 'cert.pem', keyFile: 'key.pem' }, authMode: 'none' };
  const started = await startControlPlane(tlsConfig, {
    env: {},
    readFile: (f) => Buffer.from(`content-of-${f}`),
    createHttpsServer: (opts, listener) => { httpsOptions = opts; return http.createServer(listener); },
    createHttpServer: () => { httpCalled = true; throw new Error('unexpected'); },
    log: (line) => logs.push(line),
  });
  track(started.server);
  assert.equal(httpCalled, false);
  assert.equal(httpsOptions.minVersion, 'TLSv1.3');
  assert.equal(httpsOptions.key.toString(), 'content-of-key.pem');
  assert.equal(httpsOptions.cert.toString(), 'content-of-cert.pem');
  assert.match(logs[0], /^AI Test Studio control plane: https:\/\/127\.0\.0\.1:\d+ \(auth=none\)$/);
  started.server.close();

  const env = { ATS_CP_DEV_TOKENS: JSON.stringify({ [TOKEN_A]: 'ten_a' }) };
  const plain = await startControlPlane({ host: '127.0.0.1', port: 0, tls: null, authMode: 'dev-static' }, { env, log: (line) => logs.push(line) });
  track(plain.server);
  assert.ok(plain.address.port > 0);
  const health = await call(plain.address.port, 'GET', '/cp/v1/health');
  assert.equal(health.json.auth, 'dev-static');
  const listed = await call(plain.address.port, 'GET', '/cp/v1/projects', { token: TOKEN_A });
  assert.equal(listed.status, 200);
  assert.ok(logs.every((l) => !l.includes(TOKEN_A)));
  plain.server.close();

  // A listen failure (port already in use) is reported, not swallowed.
  const blocker = track(http.createServer());
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  await assert.rejects(startControlPlane({ host: '127.0.0.1', port: blocker.address().port, tls: null, authMode: 'none' }, { log: () => {} }), /EADDRINUSE/);
  blocker.close();

  // runMain: a configuration error ends with exit code 2 and names the variable.
  let exitCode = null;
  let errText = '';
  const none = await runMain({ ATS_CP_HOST: '0.0.0.0' }, { exit: (c) => { exitCode = c; }, stderr: { write: (t) => { errText += t; } } });
  assert.equal(none, null);
  assert.equal(exitCode, 2);
  assert.match(errText, /^control-plane config error: ATS_CP_HOST: /);
  // runMain: a valid configuration starts the server.
  const port = 20000 + Math.floor(Math.random() * 9000);
  const ran = await runMain({ ATS_CP_PORT: String(port) }, { log: () => {} });
  track(ran.server);
  assert.equal(ran.address.port, port);
  ran.server.close();
  // runMain: any other failure propagates.
  await assert.rejects(runMain({ ATS_CP_PORT: String(port) }, { createHttpServer: () => { throw new Error('boom'); }, log: () => {} }), /boom/);
});

// --- app.mjs (in-process HTTP) -------------------------------------------------
test('UT-CP-015: health is public and carries no host details', async () => {
  const { server, port } = await startApp();
  const r = await call(port, 'GET', '/cp/v1/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, plane: 'control-plane', api: 'cp/v1', auth: 'dev-static' });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  server.close();
});

test('UT-CP-016: the local Bridge credential is refused on every route, with or without a valid Bearer', async () => {
  const { app, server, port } = await startApp();
  for (const target of ['/cp/v1/health', '/cp/v1/projects']) {
    assertRemoteError(await call(port, 'GET', target, { headers: { 'X-ATS-Token': HEX48 } }), 401, 'REMOTE_UNAUTHENTICATED');
    assertRemoteError(await call(port, 'GET', target, { token: TOKEN_A, headers: { 'X-ATS-Token': HEX48 } }), 401, 'REMOTE_UNAUTHENTICATED');
  }
  assert.ok(app.audit.length >= 4);
  assert.ok(app.audit.every((e) => e.reason === 'local_credential_presented'));
  server.close();
});

test('UT-CP-017: browser Origin requests are refused', async () => {
  const { server, port } = await startApp();
  assertRemoteError(await call(port, 'GET', '/cp/v1/health', { headers: { Origin: 'https://x.example' } }), 403, 'REMOTE_POLICY_REJECTED');
  assertRemoteError(await call(port, 'GET', '/cp/v1/health', { headers: { Origin: 'tauri://localhost' } }), 403, 'REMOTE_POLICY_REJECTED');
  server.close();
});

test('UT-CP-018: unknown routes, wrong methods and the local /api namespace are policy rejections', async () => {
  const { app, server, port } = await startApp();
  for (const [method, target] of [['GET', '/api/session'], ['GET', '/api/projects'], ['GET', '/cp/v1/unknown'], ['DELETE', '/cp/v1/projects'],
    ['GET', '/'], ['PUT', '/cp/v1/projects/prj_x'], ['POST', '/cp/v1/health'], ['GET', '/cp/v2/health'], ['GET', '/cp/v1/projects/a/b']]) {
    assertRemoteError(await call(port, method, target, { token: TOKEN_A }), 403, 'REMOTE_POLICY_REJECTED');
  }
  assert.ok(app.audit.some((e) => e.reason === 'method_not_allowed'));
  assert.ok(app.audit.some((e) => e.reason === 'unknown_route'));
  server.close();
});

test('UT-CP-019: local paths in path segments or the query string are refused before routing', async () => {
  const { app, server, port } = await startApp();
  for (const target of ['/cp/v1/projects/C%3A%5Cx', '/cp/v1/projects/..%2F..%2Fapi', '/cp/v1/../api/session', '/cp/v1/./health',
    '/cp/v1/projects?root=/etc', '/cp/v1/projects?x=%2Fhome%2Fa', '/C:/Windows', '/cp/v1/projects?file=a']) {
    assertRemoteError(await call(port, 'GET', target, { token: TOKEN_A }), 422, 'REMOTE_PATH_FORBIDDEN');
  }
  assertRemoteError(await call(port, 'GET', `/cp/v1/projects/${HEX48}`, { token: TOKEN_A }), 422, 'REMOTE_SECRET_INLINE_FORBIDDEN');
  assertRemoteError(await call(port, 'GET', `/cp/v1/projects?note=${HEX48}`, { token: TOKEN_A }), 422, 'REMOTE_SECRET_INLINE_FORBIDDEN');
  assertRemoteError(await call(port, 'GET', '/cp/v1/projects/%E0%A4%A', { token: TOKEN_A }), 403, 'REMOTE_POLICY_REJECTED');
  assert.ok(app.audit.some((e) => e.reason === 'path_traversal'));
  assert.ok(app.audit.some((e) => e.reason === 'encoded_separator'));
  assert.ok(app.audit.some((e) => e.reason === 'malformed_encoding'));
  // An absolute-form request target (proxy style) is not an origin-form path.
  const { handler } = app;
  const res = fakeResponse();
  await handler({ url: 'http://evil/cp/v1/health', method: 'GET', headers: {} }, res);
  assert.equal(res.status, 403);
  await handler({ url: undefined, method: 'GET', headers: {} }, res);
  assert.equal(res.status, 403);
  server.close();
});

function fakeResponse() {
  return {
    status: 0, body: '',
    writeHead(status) { this.status = status; },
    end(text) { this.body = text; },
  };
}

test('UT-CP-020: authentication failures share one code; the reason only reaches the audit trail', async () => {
  const { app, server, port } = await startApp();
  const missing = await call(port, 'GET', '/cp/v1/projects');
  const unknown = await call(port, 'GET', '/cp/v1/projects', { token: 'z'.repeat(40) });
  assertRemoteError(missing, 401, 'REMOTE_UNAUTHENTICATED');
  assertRemoteError(unknown, 401, 'REMOTE_UNAUTHENTICATED');
  assert.equal(missing.text, unknown.text);
  const reasons = app.audit.map((e) => e.reason);
  assert.ok(reasons.includes('missing_user_token'));
  assert.ok(reasons.includes('unknown_user_token'));
  server.close();
  // An authenticator that returns nothing is treated as unauthenticated.
  const silent = await startApp({ authenticate: () => undefined });
  assertRemoteError(await call(silent.port, 'GET', '/cp/v1/contract'), 401, 'REMOTE_UNAUTHENTICATED');
  assert.equal(silent.app.audit.at(-1).reason, 'unauthenticated');
  silent.server.close();
  assert.throws(() => createControlPlane({}), TypeError);
  assert.throws(() => createControlPlane(), TypeError);
});

test('UT-CP-021: the tenant comes from the session; missing or mismatching tenants are refused', async () => {
  const noTenant = await startApp({ authenticate: () => ({ ok: true, subject: 'x' }) });
  assertRemoteError(await call(noTenant.port, 'GET', '/cp/v1/projects'), 403, 'REMOTE_TENANT_REQUIRED');
  noTenant.server.close();
  const { server, port } = await startApp();
  assertRemoteError(await call(port, 'GET', '/cp/v1/projects', { token: TOKEN_A, headers: { 'X-ATS-Tenant': 'ten_b' } }), 403, 'REMOTE_TENANT_MISMATCH');
  assertRemoteError(await call(port, 'GET', '/cp/v1/projects?tenantId=ten_b', { token: TOKEN_A }), 403, 'REMOTE_TENANT_MISMATCH');
  assertRemoteError(await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: { displayName: 'x', tenantId: 'ten_b' } }), 403, 'REMOTE_TENANT_MISMATCH');
  // The matching tenant is accepted wherever it is given.
  assert.equal((await call(port, 'GET', '/cp/v1/projects?tenantId=ten_a', { token: TOKEN_A, headers: { 'X-ATS-Tenant': 'ten_a' } })).status, 200);
  assert.equal((await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: { displayName: 'x', tenantId: 'ten_a' } })).status, 201);
  server.close();
});

test('UT-CP-022: POST bodies must be JSON objects within 64 KiB', async () => {
  const { server, port } = await startApp();
  assertRemoteError(await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: 'displayName=x', headers: { 'content-type': 'text/plain' } }), 403, 'REMOTE_POLICY_REJECTED');
  assertRemoteError(await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A }), 403, 'REMOTE_POLICY_REJECTED');
  const exact = JSON.stringify({ displayName: 'x', pad: '' });
  const fill = 65536 - Buffer.byteLength(exact);
  const atLimit = JSON.stringify({ displayName: 'x', pad: 'p'.repeat(fill) });
  assert.equal(Buffer.byteLength(atLimit), 65536);
  // At the limit the body is read and judged (here: unknown field), not cut off.
  assertRemoteError(await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: atLimit }), 403, 'REMOTE_POLICY_REJECTED');
  const overLimit = JSON.stringify({ displayName: 'x', pad: 'p'.repeat(fill + 1) });
  assertRemoteError(await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: overLimit }), 413, 'REMOTE_PAYLOAD_TOO_LARGE');
  assertRemoteError(await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: 'not json' }), 403, 'REMOTE_POLICY_REJECTED');
  assertRemoteError(await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: '[1]' }), 403, 'REMOTE_POLICY_REJECTED');
  assertRemoteError(await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: 'null' }), 403, 'REMOTE_POLICY_REJECTED');
  assertRemoteError(await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: JSON.stringify(nested(40)) }), 403, 'REMOTE_POLICY_REJECTED');
  server.close();
  // A body far beyond the limit is cut off instead of being drained forever.
  const small = await startApp({ maxBodyBytes: 8 });
  const r = await call(small.port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: JSON.stringify({ displayName: 'x'.repeat(4096) }) }).catch((e) => ({ error: e }));
  assert.ok(r.error || r.status === 413, JSON.stringify(r));
  small.server.close();
});

test('UT-CP-023: projects are registered and read by opaque UID only', async () => {
  const { server, port } = await startApp();
  const created = await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: { displayName: 'Checkout' }, headers: { 'content-type': 'application/json; charset=utf-8' } });
  assert.equal(created.status, 201, created.text);
  const uid = created.json.project.projectUid;
  assert.match(uid, UID_RE);
  assert.deepEqual(Object.keys(created.json.project).sort(), ['createdAt', 'displayName', 'projectUid']);
  const list = await call(port, 'GET', '/cp/v1/projects', { token: TOKEN_A });
  assert.equal(list.json.projects.length, 1);
  const one = await call(port, 'GET', `/cp/v1/projects/${uid}`, { token: TOKEN_A });
  assert.equal(one.status, 200);
  assert.equal(one.json.project.displayName, 'Checkout');
  assertRemoteError(await call(port, 'GET', '/cp/v1/projects/prj_00000000-0000-0000-0000-000000000000', { token: TOKEN_A }), 404, 'REMOTE_RESOURCE_NOT_FOUND');
  assertRemoteError(await call(port, 'GET', '/cp/v1/projects/abc', { token: TOKEN_A }), 404, 'REMOTE_RESOURCE_NOT_FOUND');
  server.close();
});

test('UT-CP-024: another tenant cannot see a project; the answer equals a missing project', async () => {
  const { server, port } = await startApp();
  const uid = (await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: { displayName: 'A only' } })).json.project.projectUid;
  const foreign = await call(port, 'GET', `/cp/v1/projects/${uid}`, { token: TOKEN_B });
  const missing = await call(port, 'GET', '/cp/v1/projects/prj_00000000-0000-0000-0000-000000000000', { token: TOKEN_B });
  assertRemoteError(foreign, 404, 'REMOTE_RESOURCE_NOT_FOUND');
  assert.equal(foreign.text, missing.text);
  assert.deepEqual((await call(port, 'GET', '/cp/v1/projects', { token: TOKEN_B })).json.projects, []);
  server.close();
});

test('UT-CP-025: invalid display names, unknown fields, paths and credentials in the body are refused', async () => {
  const { app, server, port } = await startApp();
  for (const body of [{ displayName: '' }, { displayName: 'x'.repeat(121) }, { displayName: 'bell\u0007' }, { displayName: 42 }, {}, { displayName: 'x', branch: 'main' }]) {
    assertRemoteError(await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body }), 403, 'REMOTE_POLICY_REJECTED');
  }
  assert.equal((await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: { displayName: '项'.repeat(120) } })).status, 201);
  for (const body of [{ path: 'C:\\repo' }, { root: 'x' }, { repositoryUrl: 'https://h/o/r.git' }, { displayName: '/home/a' }, { displayName: 'x', meta: ['file:///C:/x'] }]) {
    assertRemoteError(await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body }), 422, 'REMOTE_PATH_FORBIDDEN');
  }
  for (const body of [{ displayName: 'x', token: 'abc' }, { displayName: HEX48 }]) {
    assertRemoteError(await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body }), 422, 'REMOTE_SECRET_INLINE_FORBIDDEN');
  }
  assert.ok(app.audit.some((e) => e.reason === 'unknown_field'));
  assert.ok(app.audit.some((e) => e.reason === 'invalid_display_name'));
  for (const projects of app.store.values()) for (const p of projects.values()) assert.equal(detectLocalPath(p.displayName), null);
  server.close();
});

test('UT-CP-026: a response that would carry a local path is never sent (egress guard)', async () => {
  const { app, server, port } = await startApp();
  const uid = (await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: { displayName: 'clean' } })).json.project.projectUid;
  // Simulate a defect upstream of the response: the stored record holds a path.
  app.store.get('ten_a').get(uid).displayName = 'C:\\leak\\secret';
  const r = await call(port, 'GET', `/cp/v1/projects/${uid}`, { token: TOKEN_A });
  assertRemoteError(r, 500, 'REMOTE_INTERNAL');
  assert.equal(r.json.retryable, true);
  assert.ok(!r.text.includes('leak'));
  const list = await call(port, 'GET', '/cp/v1/projects', { token: TOKEN_A });
  assertRemoteError(list, 500, 'REMOTE_INTERNAL');
  app.store.get('ten_a').get(uid).displayName = HEX48;
  assertRemoteError(await call(port, 'GET', `/cp/v1/projects/${uid}`, { token: TOKEN_A }), 500, 'REMOTE_INTERNAL');
  assert.equal(app.audit.filter((e) => e.reason === 'egress_boundary_blocked').length, 3);
  server.close();
});

test('UT-CP-027: an unexpected exception becomes REMOTE_INTERNAL without echoing its message; the audit trail is capped', async () => {
  let at = 0;
  const { app, server, port } = await startApp({ newProjectUid: () => { throw new Error('boom at C:\\secret'); }, now: () => `t${at++}` });
  const r = await call(port, 'POST', '/cp/v1/projects', { token: TOKEN_A, body: { displayName: 'x' } });
  assertRemoteError(r, 500, 'REMOTE_INTERNAL');
  assert.ok(!r.text.includes('boom') && !r.text.includes('secret'));
  assert.equal(app.audit.at(-1).reason, 'unexpected_exception');
  assert.equal(app.audit.at(-1).tenantId, 'ten_a');
  for (let i = 0; i < 1005; i++) await call(port, 'GET', '/nope');
  assert.equal(app.audit.length, 1000);
  assert.equal(app.audit.at(-1).action, 'unrouted');
  server.close();
});

test('UT-CP-028: the control-plane sources import no local Bridge module, Tauri API or child_process', () => {
  const dir = path.join(root, 'server/control-plane');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.deepEqual(files.sort(), ['app.mjs', 'auth.mjs', 'boundary.mjs', 'errors.mjs', 'main.mjs']);
  const allowed = new Set(['node:http', 'node:https', 'node:crypto', 'node:net', 'node:url', 'node:path', './app.mjs', './auth.mjs', './boundary.mjs', './errors.mjs']);
  for (const file of files) {
    // Judge the CODE: comments may explain what is absent (e.g. "no child_process").
    const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const specifiers = [...text.matchAll(/^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm), ...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(specifiers.length > 0 || file === 'errors.mjs' || file === 'boundary.mjs', file);
    for (const s of specifiers) {
      const ok = allowed.has(s) || (s === 'node:fs' && file === 'main.mjs');
      assert.ok(ok, `${file} imports ${s}`);
    }
    for (const forbidden of [/child_process/, /@tauri-apps/, /from\s+['"]\.\.\//, /ATS_DATA_DIR/, /\.ai-test-studio/, /state\.json/, /['"`]\/api\//, /\bfetch\s*\(/, /\.request\s*\(/, /\brequire\s*\(/]) {
      assert.ok(!forbidden.test(text), `${file} matches ${forbidden}`);
    }
  }
});

test('UT-CP-029: the Tauri shell hosts only the local Bridge; the UI uses no Tauri API', () => {
  const lib = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
  const handlers = /generate_handler!\[([^\]]*)\]/.exec(lib)[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(handlers, ['local_bridge_status']);
  assert.ok(lib.includes('"../server/index.mjs"'));
  for (const s of ['control-plane', 'cp/v1', 'ATS_CP_']) assert.ok(!lib.includes(s), s);
  const studio = path.join(root, 'apps/studio');
  const skip = new Set(['node_modules', '.next', 'out']);
  const offenders = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?|mjs|html)$/.test(e.name) && /@tauri-apps|__TAURI__/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
    }
  })(studio);
  assert.deepEqual(offenders, []);
});

test('UT-CP-030: the contract endpoint describes the boundary', async () => {
  const { server, port } = await startApp();
  const r = await call(port, 'GET', '/cp/v1/contract', { token: TOKEN_A });
  assert.equal(r.status, 200);
  assert.equal(r.json.tauriRequired, false);
  assert.equal(r.json.localBridgeReachable, false);
  assert.equal(r.json.errorNamespace, 'REMOTE_');
  assert.equal(r.json.credential.localCredentialAccepted, false);
  assert.equal(r.json.resourceReference, 'opaque_uid_only');
  assertRemoteError(await call(port, 'GET', '/cp/v1/contract'), 401, 'REMOTE_UNAUTHENTICATED');
  server.close();
});
