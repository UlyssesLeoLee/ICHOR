/**
 * ATS-212 -- the environment profiles: the API integration test.
 *
 * WHAT IS ASSERTED HERE
 * ---------------------
 * The API contract of the environment profiles, over HTTP, against a real
 * Bridge:
 *
 *   1. A profile is created, listed and deleted; the list answers with the
 *      NAMES of the variables, never their values.
 *   2. A variable that is not on the whitelist is REFUSED with the reason.
 *   3. A credential-shaped name is REFUSED even when the whitelist allows
 *      it -- a credential belongs in the credential store, not in a profile.
 *   4. A run names the profile it ran under and the NAMES of the variables
 *      it carried; the VALUES are not in the run record.
 *   5. A run that names a profile that does not exist is REFUSED -- it does
 *      not silently run without one.
 *   6. The profile lives in the BRIDGE's data directory and NOT in the
 *      project: the project's own tree carries no trace of it. This is the
 *      "配置不进入 Git" half of the acceptance criterion, measured.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-env-'));
const port = await freePort();
// The project's own tree: the profile must NOT be written into it.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-env-proj-'));
fs.writeFileSync(path.join(fixture, 'package.json'), '{}');
fs.writeFileSync(path.join(fixture, 'playwright.config.ts'), 'export default {}');
// The HOST environment holds something that looks like a credential. If the
// runner inherited it, the code under test could print it into a report.
const HOST_SECRET = 'the-host-secret-value';

let cp, token, projectId;
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
  for (let i = 0; i < 400; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not boot');
}
async function api(endpoint, method = 'GET', payload) {
  const r = await fetch(`http://127.0.0.1:${port}` + endpoint, {
    method,
    headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return [r.status, await r.json()];
}

test('IT-ENV-SETUP: start the bridge', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data, HOST_SECRET_MARKER: HOST_SECRET },
    stdio: 'ignore',
  });
  await ready();
  const r = await api('/api/session');
  token = r[1].token;
  assert.ok(token);
});

test('IT-ENV-001: a project is registered', async () => {
  const r = await api('/api/projects', 'POST', { path: fixture });
  assert.equal(r[0], 201);
  projectId = r[1].project.id;
});

test('IT-ENV-002: a profile is created and the answer carries the NAMES, not the values', async () => {
  const r = await api(`/api/projects/${projectId}/env`, 'POST', {
    name: 'staging',
    environment: 'staging',
    variables: { BASE_URL: 'https://staging.example.test', TENANT: 'acme' },
  });
  assert.equal(r[0], 200, JSON.stringify(r[1]));
  assert.equal(r[1].profile.name, 'staging');
  assert.equal(r[1].profile.environment, 'staging');
  assert.match(r[1].profile.uid, /^env_1_[0-9a-f]{24}$/);
  // The names are there ...
  assert.deepEqual(r[1].profile.variables, ['BASE_URL', 'TENANT']);
  // ... and the VALUES are not.
  assert.equal(JSON.stringify(r[1]).includes('staging.example.test'), false, JSON.stringify(r[1]));
});

test('IT-ENV-003: GET /env lists the profiles and the whitelist', async () => {
  const r = await api(`/api/projects/${projectId}/env`);
  assert.equal(r[0], 200);
  assert.equal(r[1].profiles.length, 1);
  assert.equal(r[1].profiles[0].name, 'staging');
  assert.deepEqual(r[1].profiles[0].variables, ['BASE_URL', 'TENANT']);
  // The whitelist is reported with its source.
  assert.ok(Array.isArray(r[1].whitelist.names));
  assert.equal(r[1].whitelist.source, 'default');
  // The tiers are the ones the product has.
  assert.deepEqual(r[1].environments, ['dev', 'staging', 'prod']);
});

test('IT-ENV-004: a variable that is not on the whitelist is REFUSED with the reason', async () => {
  const r = await api(`/api/projects/${projectId}/env`, 'POST', {
    name: 'bad',
    environment: 'dev',
    variables: { NOT_ON_THE_LIST: 'x' },
  });
  assert.equal(r[0], 400, JSON.stringify(r[1]));
  assert.equal(r[1].error, 'ENV_VARIABLE_NOT_ALLOWED');
  assert.ok(Array.isArray(r[1].rejected));
  const refusal = r[1].rejected.find((x) => x.name === 'NOT_ON_THE_LIST');
  assert.ok(refusal, JSON.stringify(r[1].rejected));
  assert.ok(refusal.reason.length > 0);
  // The refused profile was NOT stored.
  const list = await api(`/api/projects/${projectId}/env`);
  assert.equal(list[1].profiles.length, 1, 'a refused profile was stored anyway');
});

test('IT-ENV-005: a credential-shaped name is REFUSED even when the whitelist allows it', async () => {
  // The whitelist cannot even NAME a credential-shaped variable: a
  // whitelist is an AUTHORISATION, and authorising a credential into a
  // profile is the thing the credential rule exists to prevent. So the
  // whitelist is widened with an ordinary name ...
  const wl = await api(`/api/projects/${projectId}/env-whitelist`, 'PUT', {
    names: ['BASE_URL', 'TENANT', 'EXTRA_SETTING'],
  });
  assert.equal(wl[0], 200, JSON.stringify(wl[1]));
  assert.ok(wl[1].whitelist.names.includes('EXTRA_SETTING'));
  // ... and the credential is still refused when it is asked for.
  const r = await api(`/api/projects/${projectId}/env`, 'POST', {
    name: 'with-credential',
    environment: 'dev',
    variables: { EXTRA_SETTING: 'ok', API_TOKEN: 'the-secret' },
  });
  assert.equal(r[0], 400, JSON.stringify(r[1]));
  assert.equal(r[1].error, 'ENV_VARIABLE_NOT_ALLOWED');
  const refusal = r[1].rejected.find((x) => x.name === 'API_TOKEN');
  assert.ok(refusal, JSON.stringify(r[1].rejected));
  assert.match(refusal.reason, /credential/i);
});

test('IT-ENV-006: a whitelist that authorises a credential is REFUSED', async () => {
  const r = await api(`/api/projects/${projectId}/env-whitelist`, 'PUT', {
    names: ['BASE_URL', 'DB_PASSWORD'],
  });
  assert.equal(r[0], 400, JSON.stringify(r[1]));
  assert.equal(r[1].error, 'INVALID_ENV_WHITELIST');
  assert.ok(r[1].problems.some((p) => p.name === 'DB_PASSWORD'));
  // The whitelist was NOT changed by the refused request.
  const wl = await api(`/api/projects/${projectId}/env-whitelist`);
  assert.deepEqual(wl[1].whitelist.names, ['BASE_URL', 'TENANT', 'EXTRA_SETTING']);
});

test('IT-ENV-007: a run names the profile it ran under and the NAMES of its variables', async () => {
  const r = await api(`/api/projects/${projectId}/run`, 'POST', { env: 'staging' });
  assert.equal(r[0], 202, JSON.stringify(r[1]));
  const run = r[1].run;
  // The profile is named.
  assert.match(run.envUid, /^env_1_[0-9a-f]{24}$/);
  assert.equal(run.envName, 'staging');
  assert.equal(run.envTier, 'staging');
  // The names of the variables are recorded ...
  assert.deepEqual(run.envVariables, ['BASE_URL', 'TENANT']);
  // ... and their values are NOT.
  assert.equal(JSON.stringify(run).includes('staging.example.test'), false, JSON.stringify(run));
});

test('IT-ENV-008: a run that names a profile that does not exist is REFUSED', async () => {
  const r = await api(`/api/projects/${projectId}/run`, 'POST', { env: 'no-such-profile' });
  assert.equal(r[0], 404, JSON.stringify(r[1]));
  assert.equal(r[1].error, 'ENV_PROFILE_NOT_FOUND');
  // The run was NOT started -- a refused profile must not fall back to
  // "no profile", because a run that was supposed to hit the staging base
  // URL must not quietly hit the default one.
  const runs = await api('/api/runs');
  const withEnv = runs[1].runs.filter((x) => x.envUid);
  assert.equal(withEnv.length, 1, 'a run with a refused profile was started');
});

test('IT-ENV-009: the profile lives in the data directory and NOT in the project', async () => {
  // The state's envProfiles field holds the profile.
  const state = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  assert.ok(state.envProfiles, 'the state carries no envProfiles');
  assert.equal(state.envProfiles.profiles.length, 1);
  assert.equal(state.envProfiles.profiles[0].name, 'staging');
  // The PROJECT's own tree carries no trace of the profile: no file was
  // written into it, so nothing of it can be committed. This is the
  // "配置不进入 Git" half of the acceptance criterion, measured.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const files = walk(fixture);
  assert.equal(files.length, 2, `the project gained files: ${files.join(', ')}`);
  // And nothing in the project mentions the profile.
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    assert.equal(content.includes('staging.example.test'), false, `${f} carries the profile value`);
  }
});

test('IT-ENV-010: the profile survives a restart of the bridge', async () => {
  cp.kill();
  await new Promise((r) => cp.on('close', r));
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data, HOST_SECRET_MARKER: HOST_SECRET },
    stdio: 'ignore',
  });
  await ready();
  // The session token is minted per process, so the new bridge has a new
  // one. Reading it again is part of the restart, not a workaround.
  const session = await api('/api/session');
  token = session[1].token;
  const r = await api(`/api/projects/${projectId}/env`);
  assert.equal(r[0], 200);
  assert.equal(r[1].profiles.length, 1);
  assert.equal(r[1].profiles[0].name, 'staging');
  assert.deepEqual(r[1].profiles[0].variables, ['BASE_URL', 'TENANT']);
});

test('IT-ENV-011: the profile is deleted', async () => {
  // A DELETE without the reference is a 400 -- the API says which
  // reference it needs rather than deleting an arbitrary profile.
  const noRef = await api(`/api/projects/${projectId}/env`, 'DELETE');
  assert.equal(noRef[0], 400, JSON.stringify(noRef[1]));
  assert.equal(noRef[1].error, 'ENV_PROFILE_REF_REQUIRED');
  // With the reference, the profile goes.
  const withRef = await api(`/api/projects/${projectId}/env?ref=staging`, 'DELETE');
  assert.equal(withRef[0], 200, JSON.stringify(withRef[1]));
  const list = await api(`/api/projects/${projectId}/env`);
  assert.equal(list[1].profiles.length, 0);
  // Deleting a profile that is not there is a 404, not a silent success.
  const gone = await api(`/api/projects/${projectId}/env?ref=staging`, 'DELETE');
  assert.equal(gone[0], 404);
  assert.equal(gone[1].error, 'ENV_PROFILE_NOT_FOUND');
});

test('IT-ENV-CLEANUP: stop the bridge', () => {
  cp.kill();
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(fixture, { recursive: true, force: true });
});
