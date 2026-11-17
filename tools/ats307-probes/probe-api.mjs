/**
 * ATS-307 -- the API probe: what `GET /api/traceability` answers.
 *
 * It boots a real Bridge on a free port against an isolated data
 * directory and asks the endpoint the three questions it exists for:
 *
 *   1. the summary   -- what is the shape of the graph and where are the gaps?
 *   2. the forward   -- `?requirement=FR-015`: what does this requirement reach?
 *   3. the backward  -- `?evidence=<uid>`: which requirement does this
 *                        evidence verify?
 *
 * And it asks the two questions a caller must be able to trust:
 *
 *   4. an unknown requirement is REPORTED, not answered with an empty chain
 *   5. the endpoint needs the session token
 *
 * Run: node tools/ats307-probes/probe-api.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { freePort } from '../../tests/helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats307-api-'));

// A free port: the fixed 4577 is taken by other agents' bridges, and a
// collision would make this probe read somebody else's server.
const port = await freePort();

let token;
const cp = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data },
  stdio: 'ignore',
});

async function ready() {
  for (let i = 0; i < 400; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the bridge did not come up');
}

async function api(endpoint, auth = true) {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    headers: auth ? { 'X-ATS-Token': token } : {},
  });
  return [r.status, await r.json()];
}

function line(char = '-') { return char.repeat(78); }

try {
  await ready();
  const [, session] = await api('/api/session', false);
  token = session.token;

  console.log(line('='));
  console.log('ATS-307 probe: the API surface of the traceability graph');
  console.log(line('='));
  console.log(`repo root : ${root}`);
  console.log(`port      : ${port} (a free one; 4577 belongs to other agents)`);
  console.log();

  // --- 1. the token ---------------------------------------------------
  console.log(line());
  console.log('--- 1. the endpoint needs the session token ---');
  console.log(line());
  const [unauthStatus] = await api('/api/traceability', false);
  console.log(`GET /api/traceability without the token : ${unauthStatus}  (expected 401)`);
  console.log();

  // --- 2. the summary -------------------------------------------------
  console.log(line());
  console.log('--- 2. the summary ---');
  console.log(line());
  const [status, summary] = await api('/api/traceability');
  console.log(`GET /api/traceability : ${status}`);
  console.log(`nodes        : ${summary.nodes}`);
  console.log(`edges        : ${summary.edges}`);
  console.log(`chains       : ${summary.chains}`);
  console.log(`coverage     : ${JSON.stringify(summary.coverage)}`);
  console.log(`nodesByKind  : ${JSON.stringify(summary.nodesByKind)}`);
  console.log(`edgesByType  : ${JSON.stringify(summary.edgesByType)}`);
  console.log(`edgesByProv  : ${JSON.stringify(summary.edgesByProvenance)}`);
  console.log(`orphan edges : ${summary.checks.orphanEdges.length}`);
  console.log(`cycles       : ${summary.checks.cycles.length}`);
  console.log(`not present  : ${summary.checks.danglingNodes.length}`);
  console.log('the gaps, by kind:');
  for (const [kind, info] of Object.entries(summary.gaps)) {
    console.log(`  ${kind.padEnd(18)} ${info.count} gap(s) over ${new Set(info.requirements).size} requirement(s)`);
  }
  console.log('the consistency checks:');
  console.log(`  ok                       : ${summary.consistency.ok}`);
  console.log(`  dangling test ids        : ${summary.consistency.danglingTest.length}`);
  console.log(`  dangling design anchors  : ${summary.consistency.danglingAnchor.length}`);
  console.log(`  orphan edges             : ${summary.consistency.orphanEdge.length}`);
  console.log(`  cases with no script     : ${summary.consistency.caseWithoutScript.length}`);
  console.log(`  of which declared PASS   : ${summary.consistency.falsePass.length}`);
  console.log();

  // --- 3. the forward walk --------------------------------------------
  console.log(line());
  console.log('--- 3. the FORWARD walk: GET /api/traceability?requirement=FR-015 ---');
  console.log(line());
  const [fStatus, forward] = await api('/api/traceability?requirement=FR-015');
  console.log(`status : ${fStatus}   found: ${forward.found}   coverage: ${forward.coverage}`);
  for (const hop of forward.chain) {
    console.log(`  hop ${hop.hop} ${hop.kind.padEnd(11)} ${hop.nodes.length} node(s)`);
    for (const n of hop.nodes.slice(0, 3)) console.log(`      ${n.key}`);
    if (hop.nodes.length > 3) console.log(`      ... ${hop.nodes.length - 3} more`);
  }
  console.log(`  gaps: ${forward.gaps.length}`);
  for (const g of forward.gaps.slice(0, 8)) console.log(`      [hop ${g.hop}] ${g.gap}: ${g.detail}`);
  if (forward.gaps.length > 8) console.log(`      ... ${forward.gaps.length - 8} more`);
  console.log();

  // --- 4. the backward walk -------------------------------------------
  console.log(line());
  console.log('--- 4. the BACKWARD walk: GET /api/traceability?evidence=<uid> ---');
  console.log(line());
  const withEvidence = forward.cases.find((c) => c.evidence.length);
  if (withEvidence) {
    const evidence = withEvidence.evidence[0];
    console.log(`the evidence of ${withEvidence.testcase} : ${evidence.file}`);
    const [bStatus, backward] = await api(`/api/traceability?evidence=${encodeURIComponent(evidence.uid)}`);
    console.log(`status : ${bStatus}   found: ${backward.found}`);
    console.log(`requirements reached: ${backward.requirements.length}   unreached: ${backward.unreached.length}`);
    for (const r of backward.requirements.slice(0, 6)) {
      console.log(`  ${r.requirement}  <-  ${r.design}  <-  ${r.testcase}   (via ${r.provenance})`);
    }
    if (backward.requirements.length > 6) console.log(`  ... ${backward.requirements.length - 6} more`);
    for (const u of backward.unreached.slice(0, 4)) console.log(`  UNREACHED: ${u.reason}`);
  }
  console.log();

  // --- 5. a chain with a gap ------------------------------------------
  console.log(line());
  console.log('--- 5. a broken chain says WHICH hop is missing ---');
  console.log(line());
  const [gStatus, broken] = await api('/api/traceability?requirement=FR-022');
  console.log(`GET /api/traceability?requirement=FR-022 : ${gStatus}`);
  console.log(`found: ${broken.found}   coverage: ${broken.coverage}   complete: ${broken.complete}`);
  for (const hop of broken.chain) console.log(`  hop ${hop.hop} ${hop.kind.padEnd(11)} ${hop.nodes.length} node(s)`);
  console.log('the gaps:');
  for (const g of broken.gaps) console.log(`  [hop ${g.hop}] ${g.gap}: ${g.detail}`);
  console.log();

  // --- 6. an unknown requirement ---------------------------------------
  console.log(line());
  console.log('--- 6. an unknown requirement is REPORTED ---');
  console.log(line());
  const [uStatus, unknown] = await api('/api/traceability?requirement=FR-999');
  console.log(`GET /api/traceability?requirement=FR-999 : ${uStatus}`);
  console.log(`found : ${unknown.found}`);
  console.log(`reason: ${unknown.reason}`);
  console.log();

  console.log(line('='));
  console.log('END OF THE ATS-307 API PROBE');
  console.log(line('='));
} finally {
  cp.kill();
  fs.rmSync(data, { recursive: true, force: true });
}
