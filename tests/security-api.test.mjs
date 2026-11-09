/**
 * ATS-402 integration tests: the AI data security surface over HTTP.
 *
 * These boot the real Bridge on an isolated data directory and a random
 * port, exactly like tests/agent-api.test.mjs does for the agent contract.
 * They prove:
 *
 *   - the credential surface exposes REFERENCES, never secrets;
 *   - a stored secret lands in the OS credential store and NOT in the
 *     platform's own state files;
 *   - the egress consent flow is preview -> confirm -> check;
 *   - the gate refuses egress without a consent, with a wrong consent, and
 *     after the content changed;
 *   - a scope that escapes the project root is refused.
 *
 * The tests that write to the REAL Windows Credential Manager are guarded by
 * ATS402_REAL_CREDENTIAL_STORE=1. Without that flag they are SKIPPED -- and
 * a skip is not a pass, so the summary says so explicitly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-sec-api-'));
const port = await freePort();
let cp, token;

/** The real credential store is only exercised when the flag is set. */
const REAL_STORE = process.env.ATS402_REAL_CREDENTIAL_STORE === '1';

async function ready() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* retry */ }
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

const SPEC = "test('home passes', async ({page}) => {});\n";
const fixture = path.join(data, 'fixture-repo');
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'package.json'), '{}');
fs.writeFileSync(path.join(fixture, 'playwright.config.ts'), 'export default {}');
fs.writeFileSync(path.join(fixture, 'tests', 'home.spec.ts'), SPEC);

let projectId;

/**
 * Boot the bridge against the isolated data directory and fetch a session
 * token. It is a function (not inline code) so a test can RESTART the bridge
 * against the same data directory and prove that a record survives the
 * restart.
 */
async function startBridge() {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: path.join(data, 'state') },
    stdio: 'ignore',
  });
  await ready();
  token = (await api('/api/session'))[1].token;
  assert.ok(token);
}

test('IT-SEC-SETUP: start server', async () => {
  await startBridge();
  const [status, body] = await api('/api/projects', 'POST', { path: fixture });
  assert.equal(status, 201);
  projectId = body.project.id;
});

test('IT-SEC-001: the security contract is exposed over HTTP', async () => {
  const [status, body] = await api('/api/security/contract');
  assert.equal(status, 200);
  assert.equal(body.contract, 'credential-store/v1');
  assert.equal(body.egressConsent.contract, 'egress-consent/v1');
  assert.ok(body.errorCodes.includes('CREDENTIAL_NOT_FOUND'));
  assert.ok(body.egressConsent.errorCodes.includes('EGRESS_CONSENT_REQUIRED'));
});

test('IT-SEC-002: the security endpoints require a session token', async () => {
  for (const endpoint of ['/api/security/contract', '/api/security/credentials', '/api/security/egress/consents']) {
    const [status] = await api(endpoint, 'GET', undefined, false);
    assert.equal(status, 401, `${endpoint} must require a session token`);
  }
});

test('IT-SEC-003: the credential list exposes references only', async () => {
  const [status, body] = await api('/api/security/credentials');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.credentials));
  assert.equal(typeof body.provider, 'string');
  for (const credential of body.credentials) {
    assert.ok(!('secret' in credential), 'a credential reference must not carry a secret');
    assert.equal(credential.fingerprint.length, 8);
  }
});

test('IT-SEC-004: a secret never reaches the platform state files', { skip: !REAL_STORE && 'needs ATS402_REAL_CREDENTIAL_STORE=1' }, async () => {
  const secret = 'sk-it-secret-9f3a2b1c';
  const [status, body] = await api('/api/security/credentials', 'POST', {
    name: 'it-key', secret,
  });
  assert.equal(status, 201);
  assert.equal(body.credential.name, 'it-key');
  assert.ok(!JSON.stringify(body).includes('sk-it-secret'));

  // The data directory must not contain the secret anywhere.
  const stateDir = path.join(data, 'state');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (fs.readFileSync(full).includes(secret)) offenders.push(full);
    }
  };
  if (fs.existsSync(stateDir)) walk(stateDir);
  assert.deepEqual(offenders, [], 'the secret must never be written into the platform data directory');

  // ... and the response of every credential endpoint must not carry it.
  const [, list] = await api('/api/security/credentials');
  assert.ok(!JSON.stringify(list).includes('sk-it-secret'));

  const [delStatus] = await api(`/api/security/credentials/${body.credential.id}`, 'DELETE');
  assert.equal(delStatus, 200);
  const [, after] = await api('/api/security/credentials');
  assert.equal(after.credentials.length, 0);
});

test('IT-SEC-005: a duplicate credential name is refused', { skip: !REAL_STORE && 'needs ATS402_REAL_CREDENTIAL_STORE=1' }, async () => {
  const [, first] = await api('/api/security/credentials', 'POST', { name: 'dup-key', secret: 'a-secret-value' });
  assert.ok(first.credential);
  const [status, body] = await api('/api/security/credentials', 'POST', { name: 'dup-key', secret: 'b-secret-value' });
  assert.equal(status, 400);
  assert.equal(body.error, 'CREDENTIAL_DUPLICATE');
  await api(`/api/security/credentials/${first.credential.id}`, 'DELETE');
});

test('IT-SEC-006: an invalid credential name is refused', async () => {
  const [status, body] = await api('/api/security/credentials', 'POST', { name: '../escape', secret: 'x' });
  assert.equal(status, 400);
  assert.equal(body.error, 'CREDENTIAL_NAME_INVALID');
});

test('IT-SEC-007: the egress preview shows the real scope', async () => {
  const [status, body] = await api('/api/security/egress/preview', 'POST', {
    projectId,
    inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }],
  });
  assert.equal(status, 200);
  assert.equal(body.preview.scope.count, 1);
  assert.equal(body.preview.scope.items[0].ref, 'tests/home.spec.ts');
  assert.equal(body.preview.scope.totalBytes, Buffer.byteLength(SPEC, 'utf8'));
  assert.match(body.preview.scope.items[0].digest, /^[0-9a-f]{64}$/);
});

test('IT-SEC-008: egress without a consent is refused with 403', async () => {
  const [status, body] = await api('/api/security/egress/check', 'POST', {
    projectId,
    inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }],
  });
  assert.equal(status, 403);
  assert.equal(body.error, 'EGRESS_CONSENT_REQUIRED');
});

test('IT-SEC-009: the preview -> confirm -> check flow grants egress', async () => {
  const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
  const [, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
  const [confirmStatus, consent] = await api('/api/security/egress/confirm', 'POST', {
    projectId, inputs, previewId: preview.preview.previewId,
  });
  assert.equal(confirmStatus, 201);
  assert.equal(consent.consent.state, 'granted');
  assert.deepEqual(consent.consent.kinds, ['file']);

  const [checkStatus, check] = await api('/api/security/egress/check', 'POST', {
    projectId, inputs, consentId: consent.consent.id,
  });
  assert.equal(checkStatus, 200);
  assert.equal(check.allowed, true);
  assert.equal(check.scope.items[0].ref, 'tests/home.spec.ts');
});

test('IT-SEC-010: a consent cannot be confirmed twice from one preview', async () => {
  const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
  const [, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
  const [first] = await api('/api/security/egress/confirm', 'POST', {
    projectId, inputs, previewId: preview.preview.previewId,
  });
  assert.equal(first, 201);
  const [second, body] = await api('/api/security/egress/confirm', 'POST', {
    projectId, inputs, previewId: preview.preview.previewId,
  });
  assert.equal(second, 400);
  assert.equal(body.error, 'EGRESS_PREVIEW_INVALID');
});

test('IT-SEC-011: a confirmation without a preview is refused', async () => {
  const [status, body] = await api('/api/security/egress/confirm', 'POST', {
    projectId,
    inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }],
    previewId: 'egp_000000000000000000000000',
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'EGRESS_PREVIEW_INVALID');
});

test('IT-SEC-012: changed content does not match the confirmed consent', async () => {
  const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
  const [, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
  const [, consent] = await api('/api/security/egress/confirm', 'POST', {
    projectId, inputs, previewId: preview.preview.previewId,
  });
  // The file changes AFTER the user confirmed it.
  fs.writeFileSync(path.join(fixture, 'tests', 'home.spec.ts'), `${SPEC}// changed\n`, 'utf8');
  const [status, body] = await api('/api/security/egress/check', 'POST', {
    projectId, inputs, consentId: consent.consent.id,
  });
  assert.equal(status, 403);
  assert.equal(body.error, 'EGRESS_CONSENT_SCOPE_MISMATCH');
  // Restore the fixture so the later tests see the original content.
  fs.writeFileSync(path.join(fixture, 'tests', 'home.spec.ts'), SPEC, 'utf8');
});

test('IT-SEC-013: a revoked consent refuses egress immediately', async () => {
  const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
  const [, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
  const [, consent] = await api('/api/security/egress/confirm', 'POST', {
    projectId, inputs, previewId: preview.preview.previewId,
  });
  const [revokeStatus] = await api(`/api/security/egress/consents/${consent.consent.id}`, 'DELETE');
  assert.equal(revokeStatus, 200);
  const [status, body] = await api('/api/security/egress/check', 'POST', {
    projectId, inputs, consentId: consent.consent.id,
  });
  assert.equal(status, 403);
  assert.equal(body.error, 'EGRESS_CONSENT_REVOKED');
});

test('IT-SEC-014: a scope that escapes the project root is refused', async () => {
  for (const ref of ['../outside.spec.ts', 'C:/Windows/win.ini', '/etc/passwd']) {
    const [status, body] = await api('/api/security/egress/preview', 'POST', {
      projectId,
      inputs: [{ kind: 'file', ref }],
    });
    assert.equal(status, 400, `${ref} must be refused`);
    assert.equal(body.error, 'EGRESS_GATE_SCOPE_INVALID');
  }
});

test('IT-SEC-015: an unknown project is refused', async () => {
  const [status, body] = await api('/api/security/egress/preview', 'POST', {
    projectId: 'proj_000000000000000000000000',
    inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }],
  });
  assert.equal(status, 404);
  assert.equal(body.error, 'PROJECT_NOT_FOUND');
});

test('IT-SEC-016: the consent records are listed and carry no content', async () => {
  const [status, body] = await api('/api/security/egress/consents');
  assert.equal(status, 200);
  assert.ok(body.consents.length > 0);
  for (const consent of body.consents) {
    assert.ok(!('inputs' in consent), 'a consent record must not carry the content');
    assert.ok(!('content' in consent));
    assert.match(consent.scopeDigest, /^[0-9a-f]{64}$/);
  }
});

test('IT-SEC-017: the diagnostics endpoint reports the security surface', async () => {
  const [status, body] = await api('/api/diagnostics');
  assert.equal(status, 200);
  assert.ok(body.credentialStore, 'the diagnostics must report the credential store');
  assert.equal(body.credentialStore.contract, 'credential-store/v1');
  assert.ok(body.egressConsent);
  assert.equal(body.egressConsent.contract, 'egress-consent/v1');
});

test('IT-SEC-018: a non-security error keeps its pre-ATS-402 behaviour', async () => {
  // The same guarantee ATS-401 and ATS-512 established for their own error
  // families: the new mapping must not change the behaviour of the others.
  const [status, body] = await api('/api/projects', 'POST', { path: path.join(data, 'does-not-exist') });
  assert.equal(status, 500);
  assert.ok(!('details' in body));
  assert.ok(!/CREDENTIAL_|EGRESS_/.test(body.error));
});

/* ------------------------------------------------------------------ */
/* the egress audit trail -- IT                                        */
/* ------------------------------------------------------------------ */

test('IT-AUD-001: a refused egress leaves an audit record', async () => {
  const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
  // No consent: the gate refuses.
  const [status, body] = await api('/api/security/egress/check', 'POST', { projectId, inputs });
  assert.equal(status, 403);
  assert.equal(body.error, 'EGRESS_CONSENT_REQUIRED');

  // The refusal is AUDITED: the trail says the egress was refused and why.
  const [auditStatus, audit] = await api('/api/security/egress/audit');
  assert.equal(auditStatus, 200);
  const denied = audit.audit.find((r) => r.event === 'egress.denied');
  assert.ok(denied, 'the refused egress must leave a denied record');
  assert.equal(denied.code, 'EGRESS_CONSENT_REQUIRED');
  assert.equal(denied.outcome, 'denied');
  assert.equal(denied.projectId, projectId);
});

test('IT-AUD-002: a granted egress leaves an audit record too', async () => {
  const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
  const [, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
  const [, consent] = await api('/api/security/egress/confirm', 'POST', {
    projectId, inputs, previewId: preview.preview.previewId,
  });
  const [status] = await api('/api/security/egress/check', 'POST', {
    projectId, inputs, consentId: consent.consent.id,
  });
  assert.equal(status, 200);

  const [, audit] = await api('/api/security/egress/audit');
  const granted = audit.audit.find((r) => r.event === 'egress.granted');
  assert.ok(granted, 'the allowed egress must leave a granted record');
  assert.equal(granted.consentId, consent.consent.id);
  assert.equal(granted.items[0].ref, 'tests/home.spec.ts');
  assert.match(granted.items[0].digest, /^[0-9a-f]{64}$/);
});

test('IT-AUD-003: the audit records never carry the content', async () => {
  const [, audit] = await api('/api/security/egress/audit');
  const serialised = JSON.stringify(audit.audit);
  // The SPEC text is the fixture's content. It must not be anywhere in the
  // trail -- otherwise the audit file would be a second copy of the data.
  assert.ok(!serialised.includes('home passes'));
  for (const record of audit.audit) {
    for (const item of record.items) {
      assert.ok(!('content' in item), 'an audit item must not carry the content');
      assert.ok(!('preview' in item));
    }
  }
});

test('IT-AUD-004: the audit trail survives a bridge restart', async () => {
  const [, before] = await api('/api/security/egress/audit');
  const count = before.audit.length;
  assert.ok(count > 0, 'there must be records before the restart');

  // Restart the bridge against the SAME data directory.
  cp.kill();
  await new Promise((r) => setTimeout(r, 300));
  await startBridge();

  const [, after] = await api('/api/security/egress/audit');
  assert.equal(after.audit.length, count, 'the trail must survive the restart');
  assert.ok(after.audit.some((r) => r.event === 'egress.denied'));
});

// ---------------------------------------------------------------------------
// Round 2: one scope resolver for preview/confirm/check; every refusal is
// audited; expiry is visible in the listing; credential writes are serialised.
// ---------------------------------------------------------------------------

const outside = path.join(data, 'outside');
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
fs.mkdirSync(path.join(fixture, '.aitest'), { recursive: true });
fs.writeFileSync(path.join(fixture, '.aitest', 'requirements.json'), '{"requirements":[]}');
let junctionOk = true;
try {
  fs.symlinkSync(outside, path.join(fixture, 'jn'), 'junction');
  fs.symlinkSync(outside, path.join(fixture, '.aitest', 'jn'), 'junction');
} catch { junctionOk = false; }

const auditCount = async () => (await api('/api/security/egress/audit'))[1].audit.length;

/** preview -> confirm over HTTP; returns the consent. */
async function grant(inputs, ttlSeconds) {
  const [ps, preview] = await api('/api/security/egress/preview', 'POST', { projectId, inputs });
  assert.equal(ps, 200, JSON.stringify(preview));
  const [cs, consent] = await api('/api/security/egress/confirm', 'POST', {
    projectId, inputs, previewId: preview.preview.previewId, ...(ttlSeconds ? { ttlSeconds } : {}),
  });
  assert.equal(cs, 201, JSON.stringify(consent));
  return consent.consent;
}

test('IT-SEC-019: a requirement input goes preview -> confirm -> check to 200', async () => {
  const inputs = [{ kind: 'requirement', ref: 'requirements.json' }];
  const consent = await grant(inputs);
  const [status, body] = await api('/api/security/egress/check', 'POST', { projectId, inputs, consentId: consent.id });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.scope.items[0].ref, 'requirements.json');
  // The default ref resolves to the same document.
  const [s2] = await api('/api/security/egress/check', 'POST', { projectId, inputs: [{ kind: 'requirement' }], consentId: consent.id });
  assert.equal(s2, 200);
});

test('IT-SEC-020: a run input goes preview -> confirm -> check to 200', async () => {
  const [rs, rb] = await api(`/api/projects/${projectId}/run`, 'POST', {});
  assert.ok(rs === 202 || rs === 201, JSON.stringify(rb));
  const runId = rb.run.id;
  for (let i = 0; i < 100; i++) {
    const [, g] = await api(`/api/runs/${runId}`);
    if (g?.run && !['running', 'queued', 'cancelling'].includes(g.run.status)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const inputs = [{ kind: 'run', ref: runId }];
  const consent = await grant(inputs);
  const [status, body] = await api('/api/security/egress/check', 'POST', { projectId, inputs, consentId: consent.id });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.scope.items[0].kind, 'run');
  // An unknown run id is refused (and audited), not a 500.
  const before = await auditCount();
  const [ns, nb] = await api('/api/security/egress/check', 'POST', { projectId, inputs: [{ kind: 'run', ref: 'run_unknown' }], consentId: consent.id });
  assert.equal(ns, 400);
  assert.equal(nb.error, 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(await auditCount(), before + 1);
});

test('IT-SEC-021: with a VALID consent, every out-of-scope /check is refused AND audited', async () => {
  const good = { kind: 'file', ref: 'tests/home.spec.ts' };
  const consent = await grant([good]);
  const cases = [
    ['parent traversal', [{ kind: 'file', ref: '../outside/secret.txt' }]],
    ['absolute path', [{ kind: 'file', ref: 'C:/Windows/win.ini' }]],
    ['mixed good + escaping', [good, { kind: 'file', ref: '../outside/secret.txt' }]],
  ];
  if (junctionOk) cases.push(['junction escape', [{ kind: 'file', ref: 'jn/secret.txt' }]]);
  for (const [label, inputs] of cases) {
    const before = await auditCount();
    const [status, body] = await api('/api/security/egress/check', 'POST', { projectId, inputs, consentId: consent.id });
    assert.equal(status, 400, `${label}: ${JSON.stringify(body)}`);
    assert.equal(body.error, 'EGRESS_GATE_SCOPE_INVALID', label);
    const [, trail] = await api('/api/security/egress/audit');
    assert.equal(trail.audit.length, before + 1, `${label}: the refusal must add exactly one audit record`);
    const newest = trail.audit[0];
    assert.equal(newest.event, 'egress.denied', label);
    assert.equal(newest.code, 'EGRESS_GATE_SCOPE_INVALID', label);
    assert.deepEqual(newest.items.map((i) => i.ref), inputs.map((i) => i.ref), `${label}: the denial names the requested refs`);
    assert.ok(newest.items.every((i) => i.digest === null && i.bytes === 0), `${label}: no file was read`);
    assert.ok(!JSON.stringify(trail).includes('TOP-SECRET-OUTSIDE'), 'the outside content must never reach the audit');
  }
});

test('IT-SEC-022: a requirement path through a junction, or out of .aitest, is refused', async () => {
  if (junctionOk) {
    const [status, body] = await api('/api/security/egress/preview', 'POST', {
      projectId, inputs: [{ kind: 'requirement', ref: 'jn/secret.txt' }],
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'EGRESS_GATE_SCOPE_INVALID');
  }
  const [s2, b2] = await api('/api/security/egress/preview', 'POST', {
    projectId, inputs: [{ kind: 'requirement', ref: '../tests/home.spec.ts' }],
  });
  assert.equal(s2, 400, 'a requirement must stay inside .aitest');
  assert.equal(b2.error, 'EGRESS_GATE_SCOPE_INVALID');
});

test('IT-SEC-023: an expired consent is listed as expired and refused by /check', async () => {
  const inputs = [{ kind: 'file', ref: 'tests/home.spec.ts' }];
  const consent = await grant(inputs, 1);
  await new Promise((r) => setTimeout(r, 1300));
  const [, list] = await api('/api/security/egress/consents');
  assert.equal(list.consents.find((c) => c.id === consent.id).state, 'expired');
  const before = await auditCount();
  const [status, body] = await api('/api/security/egress/check', 'POST', { projectId, inputs, consentId: consent.id });
  assert.equal(status, 403);
  assert.equal(body.error, 'EGRESS_CONSENT_EXPIRED');
  assert.equal(await auditCount(), before + 1);
});

test('IT-SEC-024: /check for an unknown project, or with no inputs, is refused and audited', async () => {
  const before = await auditCount();
  const [status, body] = await api('/api/security/egress/check', 'POST', {
    projectId: 'proj_000000000000000000000000', inputs: [{ kind: 'file', ref: 'tests/home.spec.ts' }],
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'EGRESS_GATE_PROJECT_UNKNOWN');
  assert.equal(await auditCount(), before + 1);
  const [s2, b2] = await api('/api/security/egress/check', 'POST', { projectId, inputs: [] });
  assert.equal(s2, 400);
  assert.equal(b2.error, 'EGRESS_GATE_INPUT_INVALID');
  assert.equal(await auditCount(), before + 2);
});

test('IT-SEC-025: concurrent credential writes keep the index and the vault consistent', { skip: !REAL_STORE && 'needs ATS402_REAL_CREDENTIAL_STORE=1' }, async () => {
  const results = await Promise.all([1, 2, 3].map((i) => api('/api/security/credentials', 'POST', { name: 'race-key', secret: `sk-race-${i}` })));
  assert.equal(results.filter(([s]) => s === 201).length, 1, 'exactly one of three same-name writes may win');
  assert.equal(results.filter(([s, b]) => s === 400 && b.error === 'CREDENTIAL_DUPLICATE').length, 2);
  const [, list] = await api('/api/security/credentials');
  const mine = list.credentials.filter((c) => c.name === 'race-key');
  assert.equal(mine.length, 1);
  const [ds] = await api(`/api/security/credentials/${mine[0].id}`, 'DELETE');
  assert.equal(ds, 200);
});

test('IT-SEC-026: a reference whose vault entry vanished can be deleted; a failed write is 503', { skip: !REAL_STORE && 'needs ATS402_REAL_CREDENTIAL_STORE=1' }, async () => {
  const [s, b] = await api('/api/security/credentials', 'POST', { name: 'vanish-key', secret: 'sk-vanish-1' });
  assert.equal(s, 201);
  const { spawnSync } = await import('node:child_process');
  spawnSync('cmdkey', [`/delete:ATS:ai-test-studio:${b.credential.id}`], { windowsHide: true });
  const [ds, db] = await api(`/api/security/credentials/${b.credential.id}`, 'DELETE');
  assert.equal(ds, 200, JSON.stringify(db));
  const [, list] = await api('/api/security/credentials');
  assert.ok(!list.credentials.some((c) => c.id === b.credential.id));
  // A write the vault refuses (blob over the Credential Manager limit) is a
  // 503 CREDENTIAL_STORE_FAILED, not a 500, and leaves no reference behind.
  const [fs_, fb] = await api('/api/security/credentials', 'POST', { name: 'huge-key', secret: 'x'.repeat(3000) });
  assert.equal(fs_, 503, JSON.stringify(fb));
  assert.equal(fb.error, 'CREDENTIAL_STORE_FAILED');
  const [, after] = await api('/api/security/credentials');
  assert.ok(!after.credentials.some((c) => c.name === 'huge-key'));
});

test('IT-SEC-CLEANUP: the bridge exits and the fixture is removed', async () => {
  cp.kill();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(data, { recursive: true, force: true });
});
