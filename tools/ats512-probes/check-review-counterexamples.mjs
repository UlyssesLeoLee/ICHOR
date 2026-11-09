// ATS-512 round-2 closure check.
//
// For each counterexample from the round-1 review (the reviewer attached
// ce.mjs and http.mjs), this script runs the SAME attack against the
// current tree and reports whether it STILL reproduces.
//
//   HOLDS  -- the counterexample still reproduces: the defect is NOT fixed
//   no     -- the counterexample no longer reproduces: the defect is fixed
//
// Run from the repo root:  node tools/ats512-probes/check-review-counterexamples.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const C = await imp('server/plugins/contract.mjs');
const S = await imp('server/plugins/sdk.mjs');

const RUN = 'run_' + '0123456789abcdef0123456789abcdef0123'.slice(0, 36);
const okDigest = 'a'.repeat(64);
const manifest = (perms) => ({
  id: 'evil', version: '1.0.0', kind: 'runner', entry: 'index.mjs',
  protocol: { major: 1, minor: 0 }, capabilities: ['discover', 'start', 'stop', 'collect'],
  permissions: perms, publisher: { name: 'x' },
});

/**
 * A host that also holds the authoritative proposal record -- the round-2
 * contract requires it, so the counterexamples are run against a host that
 * satisfies the current contract.
 */
function mkHost(extra = {}) {
  const events = []; const calls = []; const proposals = new Map();
  return {
    events, calls, proposals,
    host: {
      audit: (e) => events.push(e),
      readTestFile: async (pid, p) => { calls.push(['readTestFile', pid, p]); return { file: p, content: 'x', hash: 'h' }; },
      readRequirements: async (pid) => { calls.push(['readRequirements', pid]); return { pid }; },
      readRunEvidence: async (pid, r) => { calls.push(['readRunEvidence', pid, r]); return { runUid: r, artifacts: [] }; },
      resolveEvidenceDigest: async (pid, r, ref) => { calls.push(['resolveEvidenceDigest', pid, r, ref]); return okDigest; },
      submitProposal: async (p) => { proposals.set(p.proposalId, structuredClone(p)); },
      getProposal: (id) => proposals.get(id),
      ...extra,
    },
  };
}

/**
 * A host that uses shallow copy storage (testing SDK-level defect detection).
 */
function mkHostShallow(extra = {}) {
  const events = []; const calls = []; const proposals = new Map();
  return {
    events, calls, proposals,
    host: {
      audit: (e) => events.push(e),
      readTestFile: async (pid, p) => { calls.push(['readTestFile', pid, p]); return { file: p, content: 'x', hash: 'h' }; },
      readRequirements: async (pid) => { calls.push(['readRequirements', pid]); return { pid }; },
      readRunEvidence: async (pid, r) => { calls.push(['readRunEvidence', pid, r]); return { runUid: r, artifacts: [] }; },
      resolveEvidenceDigest: async (pid, r, ref) => { calls.push(['resolveEvidenceDigest', pid, r, ref]); return okDigest; },
      submitProposal: async (p) => { proposals.set(p.proposalId, { ...p }); },
      getProposal: (id) => proposals.get(id),
      ...extra,
    },
  };
}

const ALL = ['test.read', 'requirements.read', 'evidence.read', 'outcome.report'];
let holds = 0;
let fixed = 0;

function report(id, stillHolds, observed, claimed) {
  if (stillHolds) holds += 1; else fixed += 1;
  console.log(`${stillHolds ? 'HOLDS ' : 'no    '} ${id}: ${observed}`);
  console.log(`        claimed: ${claimed}`);
}

async function code(fn) {
  try { await fn(); return 'NO_ERROR'; }
  catch (e) { return e.code || `UNCODED(${e.constructor.name}: ${e.message})`; }
}

/* CE1: describe() is an SDK call that used to be never audited. */
{
  const h = mkHost();
  const sdk = S.createPluginSdk({ manifest: manifest(['test.read']), host: h.host, projects: ['proj_a'] });
  sdk.describe(); sdk.describe();
  report('CE1 describe() unaudited', h.events.length === 0, `2x describe() -> ${h.events.length} audit events`,
    'every SDK call produces an audit event');
}

/* CE2: an evidence-bypass attempt used to leave no audit trail. */
{
  const h = mkHost();
  const sdk = S.createPluginSdk({ manifest: manifest(ALL), host: h.host, tier: 'reporter', projects: ['proj_a'] });
  const c = await code(() => sdk.reportOutcome('proj_a', RUN, { summary: 'pass', evidenceRefs: [] }));
  const c2 = await code(() => sdk.reportOutcome('proj_a', RUN, { summary: 'pass', status: 'passed' }));
  report('CE2 evidence-skip attempt unaudited', h.events.length === 0,
    `${c} / ${c2} -> ${h.events.length} audit events`,
    'refused calls are audited');
}

/* CE3: the other refusals used to leave no audit trail. */
{
  const h = mkHost({ resolveEvidenceDigest: async () => 'not-a-digest' });
  const sdk = S.createPluginSdk({ manifest: manifest(ALL), host: h.host, tier: 'reporter', projects: ['proj_a'] });
  const a = await code(() => sdk.reportOutcome('proj_a', 'run_x', { summary: 's', evidenceRefs: ['e'] }));
  const b = await code(() => sdk.readRunEvidence('proj_a', '../../etc'));
  const c = await code(() => sdk.reportOutcome('proj_a', RUN, { summary: 's', evidenceRefs: ['forged.png'] }));
  const d = await code(() => sdk.reportOutcome('proj_a', RUN, { summary: 's', evidenceRefs: ['e'], status: 'approved' }));
  report('CE3 other refusals unaudited', h.events.length === 0,
    `${a}, ${b}, ${c}, ${d} -> ${h.events.length} audit events`,
    'every refused call is audited');
}

/* CE4: a host read that throws used to leave no audit event. */
{
  const h = mkHost({ readTestFile: async () => { throw new Error('ENOENT'); } });
  const sdk = S.createPluginSdk({
    manifest: manifest(['test.read']), host: h.host,
    scope: { files: ['tests'] }, projects: ['proj_a'],
  });
  const c = await code(() => sdk.readTestFile('proj_a', 'tests/secret-probe.spec.ts'));
  report('CE4 failed host read unaudited', h.events.length === 0,
    `${c} -> ${h.events.length} audit events`,
    'every SDK call audited');
}

/* CE5: the project scope used to be unbound. */
{
  const h = mkHost();
  const sdk = S.createPluginSdk({
    manifest: manifest(ALL), host: h.host, tier: 'reporter',
    scope: { files: ['tests'] }, projects: ['proj_a'],
  });
  await code(() => sdk.readTestFile('proj_OTHER_TENANT', 'tests/a.spec.ts'));
  await code(() => sdk.readRequirements('proj_OTHER_TENANT'));
  await code(() => sdk.readRunEvidence('proj_OTHER_TENANT', RUN));
  const reached = h.calls.filter((c) => c[1] === 'proj_OTHER_TENANT').length;
  report('CE5 cross-project reads', reached === 3, `host received projectId=proj_OTHER_TENANT in ${reached}/3 calls`,
    'the host binds the allowed projects; the SDK refuses the others');
}

/* CE6: a forged, evidence-less proposal used to be approvable. */
{
  const h = mkHost();
  const forged = {
    proposalId: 'plgprop_evil_1', pluginId: 'evil', runUid: RUN, kind: 'outcome', status: 'passed',
    summary: 'all green', evidenceRefs: [], approval: 'pending', producedBy: 'plugin:evil',
  };
  const r = await code(() => S.reviewPluginProposal(forged, { reviewer: 'alice', decision: 'approved', host: h.host }));
  let approved = null;
  try { approved = S.reviewPluginProposal(forged, { reviewer: 'alice', decision: 'approved', host: h.host }); } catch { /* refused */ }
  report('CE6 forged/evidence-less proposal approvable',
    r === 'NO_ERROR' && approved?.approval === 'approved',
    `reviewPluginProposal(forged, evidenceRefs:[]) -> ${r}, approval=${approved?.approval}`,
    'the host holds the authoritative record; a proposal it does not hold is refused');
}

/* CE7: the plugin owned the only copy of the proposal and could rewrite nested fields. */
{
  const h = mkHostShallow();
  const sdk = S.createPluginSdk({ manifest: manifest(ALL), host: h.host, tier: 'reporter', projects: ['proj_a'] });
  const p = await sdk.reportOutcome('proj_a', RUN, { summary: 'ok', evidenceRefs: ['e1'] });
  // Only tamper nested fields (not top-level), to detect aliasing defects
  p.evidenceRefs[0].sha256 = 'b'.repeat(64);
  const r = await code(() => S.reviewPluginProposal(p, { reviewer: 'alice', decision: 'approved', host: h.host }));
  const auditHasDigest = JSON.stringify(h.events).includes(okDigest);
  const auditHasId = JSON.stringify(h.events).includes(p.proposalId);
  report('CE7 tampered proposal nested fields only', r === 'NO_ERROR',
    `after nested-only tamper on shallow host, review by alice -> ${r}; audit records digest=${auditHasDigest}, proposalId=${auditHasId}`,
    'the review compares the proposal with the HOST record; SDK-level deep copy prevents aliasing defects');
}

/* CE8: the gate failed OPEN on Object.prototype names. */
{
  const m = C.validatePluginManifest(manifest([]));
  const res = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nonexistent']
    .map((op) => `${op}=${C.authorizePluginOperation(m, op).allowed}`);
  report('CE8 authorize fail-open', res.some((s) => s.endsWith('=true') && !s.startsWith('nonexistent')),
    res.join(' '), 'unknown operation -> allowed:false');
}

/* CE9: the tier lookup used inherited keys. */
{
  const a = await code(() => C.resolvePluginPermissions(['test.read'], 'toString'));
  const b = await code(() => C.resolvePluginPermissions([], 'constructor'));
  const c = await code(() => C.resolvePluginPermissions(['test.read'], 'nope'));
  report('CE9 tier prototype keys', a.startsWith('UNCODED') || b === 'NO_ERROR',
    `toString -> ${a}; constructor(empty) -> ${b}; nope -> ${c}`,
    'unknown tier -> PLUGIN_MANIFEST_INVALID');
}

/* CE10: the proposal id collided across SDK instances of the same plugin. */
{
  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    const h = mkHost();
    const sdk = S.createPluginSdk({ manifest: manifest(ALL), host: h.host, tier: 'reporter', projects: ['proj_a'] });
    ids.push((await sdk.reportOutcome('proj_a', RUN, { summary: 's', evidenceRefs: ['e'] })).proposalId);
  }
  report('CE10 proposalId collision', ids[0] === ids[1], `two SDK instances -> ${ids.join(', ')}`,
    'the proposal id is globally unique');
}

/* CE11: the audit sequence diverged from the sink count when the sink threw. */
{
  let n = 0; const got = [];
  const h = mkHost({ audit: (e) => { n += 1; if (n === 1) throw new Error('sink down'); got.push(e.seq); } });
  const sdk = S.createPluginSdk({
    manifest: manifest(['test.read']), host: h.host,
    scope: { files: ['tests'] }, projects: ['proj_a'],
  });
  const c1 = await code(() => sdk.readTestFile('p', 'tests/a.ts'));
  await code(() => sdk.readTestFile('p', 'tests/a.ts'));
  report('CE11 seq != sink count', got.length === 1 && got[0] === 2,
    `first call ${c1} (read already performed), sink holds seq=[${got}]`,
    'the sequence advances only after the sink accepted the event');
}

console.log(`\n${holds} counterexample(s) still reproduce, ${fixed} no longer reproduce`);
if (holds) process.exitCode = 1;
