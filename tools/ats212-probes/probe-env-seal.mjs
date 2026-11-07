/**
 * ATS-212 probe: MEASURE the environment behaviour against the acceptance
 * criteria of the task.
 *
 *   1. "只有白名单内的变量可传递" -- a variable that is not on the
 *      whitelist does not reach the runner, and the refusal says WHY.
 *   2. "runner 不继承宿主环境" -- the child process does NOT receive the
 *      host's environment, so an operator's secret cannot reach the code
 *      under test (and from there into an archived report).
 *   3. "凭据形态的变量被拒绝" -- a credential-shaped name is refused even
 *      when the whitelist permits it.
 *   4. "运行记录关联 env_uid" -- the run record carries the profile's
 *      identifier and the NAMES of its variables, never their values.
 *
 * The probe only OBSERVES. It prints what the code does, so the report says
 * what is true rather than what should be.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats212-probe-'));
const project = path.join(dir, 'fake-pw');
const data = path.join(dir, 'data');

fs.mkdirSync(path.join(project, 'node_modules', '@playwright', 'test'), { recursive: true });
fs.mkdirSync(path.join(project, 'tests'));
fs.writeFileSync(path.join(project, 'package.json'), '{}');
fs.writeFileSync(path.join(project, 'playwright.config.ts'), 'export default { testDir: "." }');
fs.writeFileSync(path.join(project, 'tests', 'login.spec.ts'), "test('works', ()=>{});\n");

// The CLI double records the environment it was handed, so the probe can
// report what the CHILD RECEIVED rather than what the code intended.
fs.writeFileSync(
  path.join(project, 'node_modules', '@playwright', 'test', 'cli.js'),
  `
const fs=require('fs'),path=require('path');
const out=process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
const captured={};
for(const [k,v] of Object.entries(process.env)){ if(k!=='ATS_ENV_CAPTURE') captured[k]=v; }
const capture=process.env.ATS_ENV_CAPTURE || (out ? out+'.env.json' : null);
if(capture) fs.writeFileSync(capture, JSON.stringify(captured,null,2));
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out, JSON.stringify({config:{rootDir:process.cwd().split(path.sep).join('/')},
  suites:[{file:'tests/login.spec.ts',specs:[{title:'works',file:'tests/login.spec.ts',line:1,tests:[{status:'expected',results:[{duration:1,retry:0}]}]}]}]}));
console.log('fake-cli: one case');
`
);

const PORT = 4607;
// The bridge's OWN environment holds something that looks like a
// credential. The runner does not inherit it, so the code under test
// cannot print it into a report that is archived as evidence.
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: { ...process.env, ATS_PORT: String(PORT), ATS_DATA_DIR: data, HOST_SECRET_MARKER: 'the-host-secret-value' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(100);
  }
  throw new Error('the bridge did not come up:\n' + serverLog);
}

async function api(method, url, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['X-ATS-Token'] = token;
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { parsed = null; }
  return { status: r.status, body: parsed };
}

function line(title) { console.log('\n=== ' + title + ' ==='); }

try {
  const health = await waitForHealth();
  line('the bridge');
  console.log('health        :', JSON.stringify(health));

  // The session token comes from the session endpoint.
  const session = await api('GET', '/api/session');
  const token = session.body?.token ?? null;
  console.log('session token :', token ? 'obtained' : 'NOT obtained');

  const created = await api('POST', '/api/projects', { path: project, name: 'probe' }, token);
  const projectId = created.body?.project?.id ?? created.body?.id ?? null;
  line('the project');
  console.log('project id    :', projectId);

  // ---------------------------------------------------------------------
  line('1. a variable that is not on the whitelist');
  const refused = await api('POST', `/api/projects/${projectId}/env`, {
    name: 'staging', environment: 'staging',
    variables: { BASE_URL: 'https://staging.example', NOT_ON_THE_LIST: 'x' },
  }, token);
  console.log('status        :', refused.status);
  console.log('error         :', refused.body?.error ?? null);
  console.log('rejected      :', JSON.stringify(refused.body?.rejected ?? null));

  // ---------------------------------------------------------------------
  line('2. a credential-shaped name, even with the whitelist permitting it');
  await api('PUT', `/api/projects/${projectId}/env-whitelist`, {
    names: ['BASE_URL', 'TENANT', 'EXTRA_SETTING'],
  }, token);
  const credential = await api('POST', `/api/projects/${projectId}/env`, {
    name: 'staging', environment: 'staging',
    variables: { BASE_URL: 'https://staging.example', API_TOKEN: 'x' },
  }, token);
  console.log('status        :', credential.status);
  console.log('error         :', credential.body?.error ?? null);
  console.log('rejected      :', JSON.stringify(credential.body?.rejected ?? null));

  // ---------------------------------------------------------------------
  line('3. the accepted profile');
  const accepted = await api('POST', `/api/projects/${projectId}/env`, {
    name: 'staging', environment: 'staging',
    variables: { BASE_URL: 'https://staging.example', TENANT: 'acme' },
  }, token);
  console.log('status        :', accepted.status);
  console.log('profile       :', JSON.stringify(accepted.body?.profile ?? null));
  console.log('carries values:', JSON.stringify(accepted.body ?? {}).includes('staging.example'));

  // ---------------------------------------------------------------------
  line('4. the run and its environment');
  const run = await api('POST', `/api/projects/${projectId}/run`, { env: 'staging' }, token);
  console.log('status        :', run.status);
  const r = run.body?.run ?? null;
  console.log('envUid        :', r?.envUid ?? null);
  console.log('envName       :', r?.envName ?? null);
  console.log('envTier       :', r?.envTier ?? null);
  console.log('envVariables  :', JSON.stringify(r?.envVariables ?? null));
  console.log('carries values:', JSON.stringify(run.body ?? {}).includes('staging.example'));

  // ---------------------------------------------------------------------
  line('5. what the runner CHILD actually received');
  await sleep(3000);
  // The bridge runs the fake CLI without ATS_ENV_CAPTURE, so the capture
  // lands next to the report. The report directory is under the data dir.
  console.log('the data dir   :');
  console.log(listTree(data).split('\n').map((l) => '  ' + l).join('\n'));
  const captured = findCapturedEnv(data);
  if (captured) {
    console.log('BASE_URL          :', captured.BASE_URL ?? '(absent)');
    console.log('TENANT            :', captured.TENANT ?? '(absent)');
    console.log('HOST_SECRET_MARKER:', captured.HOST_SECRET_MARKER ?? '(absent) -- the host secret did NOT reach the child');
    console.log('PATH              :', captured.PATH ? '(present)' : '(absent)');
    console.log('key count         :', Object.keys(captured).length);
    console.log('the keys          :', Object.keys(captured).sort().join(', '));
  } else {
    console.log('(no captured environment found under the data dir)');
  }

  // ---------------------------------------------------------------------
  line('6. the manifest of the run');
  const manifest = findManifest(data);
  if (manifest) {
    console.log('manifest.env     :', JSON.stringify(manifest.env ?? null));
    console.log('carries values   :', JSON.stringify(manifest).includes('staging.example'));
  } else {
    console.log('(no manifest found under the data dir)');
  }

  // ---------------------------------------------------------------------
  line('7. a run that references a profile that does not exist');
  const missing = await api('POST', `/api/projects/${projectId}/run`, { env: 'no-such-profile' }, token);
  console.log('status        :', missing.status);
  console.log('error         :', missing.body?.error ?? null);
} finally {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Find the environment capture the fake CLI wrote, anywhere under the data dir. */
function findCapturedEnv(base) {
  const stack = [base];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.name.endsWith('.env.json')) {
        try { return JSON.parse(fs.readFileSync(full, 'utf8')); } catch {}
      }
    }
  }
  return null;
}

/** Find the manifest of a finished run. */
function findManifest(base) {
  const stack = [base];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.name === 'manifest.json') {
        try { return JSON.parse(fs.readFileSync(full, 'utf8')); } catch {}
      }
    }
  }
  return null;
}


/** A listing of the data dir, so the report shows where the artefacts land. */
function listTree(base, prefix = '', depth = 0) {
  if (depth > 4) return '';
  let out = '';
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    out += `${prefix}${e.name}${e.isDirectory() ? '/' : ''}\n`;
    if (e.isDirectory()) out += listTree(path.join(base, e.name), prefix + '  ', depth + 1);
  }
  return out;
}
