/**
 * ATS-307 -- the traceability graph: integration test over HTTP.
 *
 * The unit tests exercise the graph as a library. This one exercises the
 * API surface: the Bridge has to answer 「这条要件的链走到哪了」 and
 * 「这条证据验的是哪条要件」 over HTTP, with the session token, on a real
 * Bridge process.
 *
 * WHAT IS ASSERTED
 * -----------------
 *   * the endpoint needs the session token (ATS-306's rule);
 *   * the summary answer carries the graph's shape and its gaps;
 *   * `?requirement=` walks ONE chain down and reports its gaps;
 *   * `?evidence=` walks ONE chain up and names the requirement;
 *   * an unknown requirement is reported, not answered with an empty
 *     chain that reads like "there is nothing here".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats307-it-'));
const port = await freePort();
let cp, token;

async function ready() {
  for (let i = 0; i < 400; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('server did not boot');
}

async function api(endpoint, auth = true) {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    headers: auth ? { 'X-ATS-Token': token } : {},
  });
  return [r.status, await r.json()];
}

test('IT-ATS307-001: start the bridge', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data },
    stdio: 'ignore',
  });
  await ready();
  const r = await api('/api/session', false);
  token = r[1].token;
  assert.ok(token);
});

test('IT-ATS307-002: the traceability endpoint needs the session token', async () => {
  const r = await api('/api/traceability', false);
  assert.equal(r[0], 401);
});

test('IT-ATS307-003: the summary answers with the graph shape and its gaps', async () => {
  const [status, body] = await api('/api/traceability');
  assert.equal(status, 200);
  assert.ok(body.nodes > 0, 'the graph has nodes');
  assert.ok(body.edges > 0, 'the graph has edges');
  assert.ok(body.chains > 0, 'the graph has chains');
  assert.equal(body.checks.orphanEdges.length, 0, 'no orphan edge');
  assert.equal(body.checks.cycles.length, 0, 'no cycle');
  assert.ok(body.coverage, 'the coverage is reported');
  assert.ok(body.gaps, 'the gaps are reported');
  assert.ok(body.consistency, 'the consistency checks are reported');
});

test('IT-ATS307-004: ?requirement= walks one chain down', async () => {
  const [status, body] = await api('/api/traceability?requirement=FR-015');
  assert.equal(status, 200);
  assert.equal(body.found, true);
  assert.equal(body.requirement, 'FR-015');
  assert.equal(body.chain.length, 6, 'the chain has the six hops');
  assert.ok(body.cases.length > 0, 'the requirement has test cases');
  assert.ok(Array.isArray(body.gaps));
});

test('IT-ATS307-005: ?requirement= names the hop that is missing', async () => {
  // FR-022 is DESIGNED with no test case at all.
  const [status, body] = await api('/api/traceability?requirement=FR-022');
  assert.equal(status, 200);
  assert.equal(body.found, true);
  assert.ok(body.gaps.length > 0, 'the broken chain says so');
  const gap = body.gaps.find((g) => g.gap === 'no-testcase');
  assert.ok(gap, 'the missing test case is named');
  assert.equal(gap.hop, 2, 'the gap names the hop');
});

test('IT-ATS307-006: an unknown requirement is reported', async () => {
  const [status, body] = await api('/api/traceability?requirement=FR-999');
  assert.equal(status, 200);
  assert.equal(body.found, false);
  assert.match(body.reason, /FR-999/);
});

test('IT-ATS307-007: ?evidence= walks one chain up', async () => {
  // Take an evidence node out of the graph and walk back from it.
  const [, summary] = await api('/api/traceability?requirement=FR-015');
  const withEvidence = summary.cases.find((c) => c.evidence.length);
  assert.ok(withEvidence, 'FR-015 has a case with evidence');
  const [status, body] = await api(`/api/traceability?evidence=${encodeURIComponent(withEvidence.evidence[0].uid)}`);
  assert.equal(status, 200);
  assert.equal(body.found, true);
  assert.ok(body.requirements.length > 0, 'the evidence reaches a requirement');
  assert.ok(body.requirements.some((r) => r.requirement === 'FR-015'), 'and it is FR-015');
});

test('IT-ATS307-008: an unknown evidence node is reported', async () => {
  const [status, body] = await api('/api/traceability?evidence=trc_1_000000000000000000000000');
  assert.equal(status, 200);
  assert.equal(body.found, false);
  assert.match(body.reason, /no evidence node/);
});

test('IT-ATS307-009: the bridge shuts down', () => {
  if (cp) cp.kill();
  fs.rmSync(data, { recursive: true, force: true });
});
