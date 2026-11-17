/**
 * ATS-506 round-3 review probe: the counterexamples the 2nd review found,
 * replayed through the REAL HTTP pipeline (createControlPlane + a static
 * Bearer). For every case: POST the value, GET it back, and inject it into
 * the store to see whether the egress guard catches it.
 *
 * Usage: node tools/ats506-probes/round3-review-probe.mjs
 */
import http from 'node:http';
import { createControlPlane } from '../../server/control-plane/app.mjs';
import { staticBearerAuthenticator } from '../../server/control-plane/auth.mjs';

const TOKEN = 'a'.repeat(16) + 'A'.repeat(16) + '-dev-token-tenant-a';

const app = createControlPlane({
  authenticate: staticBearerAuthenticator({ [TOKEN]: 'ten_a' }),
  authMode: 'dev-static',
});
const server = http.createServer((req, res) => { app.handler(req, res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

function call(method, target, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers, authorization: `Bearer ${TOKEN}` };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) h['content-type'] = 'application/json';
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

// The 2nd review's path counterexamples (item 1 and item 2) plus the query
// string form.
const CASES = [
  ['%CD%\\repo', 'env_path'],
  ['%CD%/repo', 'env_path'],
  ['%OS%\\x', 'env_path'],
  ['[/home/alice/repo]', 'posix_absolute_path'],
  ['`/home/alice/repo`', 'posix_absolute_path'],
  ['{/Users/bob/x}', 'posix_absolute_path'],
  ['</etc/passwd>', 'posix_absolute_path'],
  ['|/var/log/x', 'posix_absolute_path'],
  ['dir:[/home/a]', 'posix_absolute_path'],
];

// The values that must NOT be flagged.
const ALLOWED = ['%E4%B8%AD', '%CD%', '100%', 'https://h/home/x', 'TCP/IP', 'a.b/home', 'ns:name', 'a/b'];

console.log('=== ATS-506 round-3 review probe: the 2nd review counterexamples ===');
console.log(`port : ${port}`);
console.log('');

let bad = 0;

console.log('--- the counterexamples must be refused (422 REMOTE_PATH_FORBIDDEN) ---');
for (const [value] of CASES) {
  const post = await call('POST', '/cp/v1/projects', { body: { displayName: value } });
  const ok = post.status === 422 && post.json.error === 'REMOTE_PATH_FORBIDDEN';
  // The store must not have kept it.
  const list = await call('GET', '/cp/v1/projects');
  const stored = JSON.stringify(list.json.projects).includes(value.replace(/\\/g, '\\\\'));
  console.log(`  ${ok && !stored ? 'PASS' : 'FAIL'}  POST ${JSON.stringify(value)} -> ${post.status} ${post.json && post.json.error}${stored ? '  !! STORED' : ''}`);
  if (!ok || stored) bad++;

  // The egress guard: inject the value into the store and read it back.
  // A project has to exist for that, so one is registered first.
  const created = await call('POST', '/cp/v1/projects', { body: { displayName: 'probe' } });
  const uid = created.json && created.json.project && created.json.project.projectUid;
  if (!uid) {
    console.log('  FAIL  EGRESS -- could not register a project to inject into');
    bad++;
  } else {
    app.store.get('ten_a').get(uid).displayName = value;
    const get = await call('GET', `/cp/v1/projects/${uid}`);
    const egressOk = get.status === 500 && get.json.error === 'REMOTE_INTERNAL' && !get.text.includes(value);
    console.log(`  ${egressOk ? 'PASS' : 'FAIL'}  EGRESS ${JSON.stringify(value)} -> ${get.status} ${get.json && get.json.error}`);
    if (!egressOk) bad++;
    app.store.get('ten_a').get(uid).displayName = 'clean';
  }
}

console.log('');
console.log('--- the query string form must be refused too ---');
for (const target of ['/cp/v1/projects?ref=%25CD%25%5Crepo', '/cp/v1/projects?ref=%2Fhome%2Falice']) {
  const r = await call('GET', target);
  const ok = r.status === 422 && r.json.error === 'REMOTE_PATH_FORBIDDEN';
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  GET ${target} -> ${r.status} ${r.json && r.json.error}`);
  if (!ok) bad++;
}

console.log('');
console.log('--- the values that must NOT be flagged must be accepted (201) ---');
for (const value of ALLOWED) {
  const r = await call('POST', '/cp/v1/projects', { body: { displayName: value } });
  const ok = r.status === 201;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  POST ${JSON.stringify(value)} -> ${r.status} ${r.json && r.json.error}`);
  if (!ok) bad++;
}

console.log('');
console.log('--- the 2nd review: the Token matrix must still hold ---');
const HEX48 = '0123456789abcdef'.repeat(3);
const TOKEN_FORMS = [
  `Bearer ${HEX48}`, `x-ats-token=${HEX48}`, `tok ${HEX48}`, `0x${HEX48}`, `k=${HEX48}`,
  `?t=${HEX48}`, `prj_${HEX48}`, `${HEX48}g`, `\n${HEX48}\n`, `"${HEX48}"`,
];
for (const value of TOKEN_FORMS) {
  const r = await call('POST', '/cp/v1/projects', { body: { displayName: value } });
  const ok = r.status === 422 && r.json.error === 'REMOTE_SECRET_INLINE_FORBIDDEN';
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  POST ${JSON.stringify(value)} -> ${r.status} ${r.json && r.json.error}`);
  if (!ok) bad++;
}

server.close();
console.log('');
console.log(bad === 0
  ? 'RESULT: OK -- every round-3 counterexample is refused and every value that must stay allowed is accepted.'
  : `RESULT: FAIL -- ${bad} check(s) did not behave as required.`);
process.exit(bad === 0 ? 0 : 1);
