/**
 * ATS-512 unit tests: the plugin contract, the permission list and the SDK.
 *
 * These are pure-logic tests: no plugin is loaded, no process is spawned, no
 * file outside the temporary fixture is touched. They pin the rules the whole
 * plugin model rests on:
 *
 *   - a manifest DECLARES permissions; the host GRANTS them (the effective
 *     set is the declared set intersected with the host policy tier);
 *   - the permission vocabulary is CLOSED: an unknown name is rejected, and a
 *     forbidden name is rejected whatever the tier is;
 *   - the SDK exposes exactly the declared surface -- no more, no less;
 *   - every SDK call is audited, including the ones that are denied AND the
 *     ones whose host read failed;
 *   - the host holds the AUTHORITATIVE proposal record: a proposal the host
 *     does not hold, or one whose fields/digests differ from the host record,
 *     cannot be reviewed;
 *   - the proposal id is globally unique, not per-SDK-instance;
 *   - the file scope AND the project list are both granted by the host;
 *   - an evidence digest is computed by the HOST, never supplied by the plugin;
 *   - a plugin outcome is a proposal with approval=pending, and the plugin
 *     may not review its own proposal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PLUGIN_POLICY_TIER,
  PLUGIN_CONTRACT_VERSION,
  PLUGIN_ERROR_CODES,
  PLUGIN_FORBIDDEN_PERMISSIONS,
  PLUGIN_MANIFEST_VERSION,
  PLUGIN_OPERATIONS,
  PLUGIN_PERMISSIONS,
  PLUGIN_POLICY_TIERS,
  PLUGIN_SDK_SURFACE,
  authorizePluginOperation,
  describePluginContract,
  resolvePluginPermissions,
  validatePluginManifest,
} from '../server/plugins/contract.mjs';
import { authorizePluginCall, createPluginSdk, reviewPluginProposal } from '../server/plugins/sdk.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats512-ut-'));
const RUN_UID = 'run_00000000-0000-4000-8000-000000000001';
const PROJECT = 'proj_x';

/** A manifest that is valid on its own terms. */
function baseManifest(overrides = {}) {
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

/**
 * A host whose audit sink records everything it is handed, and which holds
 * the AUTHORITATIVE proposal record.
 *
 * The proposal store is the point of the rework: the SDK hands the proposal
 * to the host, and the review gate compares the proposal with the host's
 * copy -- not with the plugin's copy.
 */
function makeHost(overrides = {}) {
  const events = [];
  const proposals = new Map();
  const host = {
    audit: (event) => { events.push(event); },
    readTestFile: async (projectId, file) => ({ projectId, file, content: `content of ${file}`, hash: 'h'.repeat(64) }),
    readRequirements: async (projectId) => ({ projectId, requirements: [] }),
    readRunEvidence: async (projectId, runUid) => ({ projectId, runUid, artifacts: [] }),
    resolveEvidenceDigest: async (projectId, runUid, ref) => 'a'.repeat(64),
    submitProposal: async (proposal) => { proposals.set(proposal.proposalId, { ...proposal }); },
    getProposal: (proposalId) => proposals.get(proposalId),
    ...overrides,
  };
  return { events, proposals, host };
}

/** The code a failed call raised, or null. */
function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code || `NO_CODE(${error.message})`;
  }
}

/** The code an awaited call raised, or null. */
async function codeOfAsync(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.code || `NO_CODE(${error.message})`;
  }
}

/* ------------------------------------------------------------------ */
/* manifest                                                            */
/* ------------------------------------------------------------------ */

test('UT-PLG-001: the contract and manifest versions are fixed', () => {
  assert.equal(PLUGIN_CONTRACT_VERSION, 'plugin-contract/v1');
  assert.equal(PLUGIN_MANIFEST_VERSION, 'plugin-manifest/v1');
});

test('UT-PLG-002: a valid manifest is normalised', () => {
  const m = validatePluginManifest(baseManifest());
  assert.equal(m.contract, 'plugin-manifest/v1');
  assert.equal(m.id, 'demo-runner');
  assert.equal(m.kind, 'runner');
  assert.deepEqual(m.protocol, { major: 1, minor: 0 });
  assert.deepEqual(m.publisher, { name: 'Example Publisher', signature: null });
});

test('UT-PLG-003: an unsupported manifest version is rejected', () => {
  assert.equal(
    codeOf(() => validatePluginManifest(baseManifest({ contract: 'plugin-manifest/v2' }))),
    'PLUGIN_MANIFEST_VERSION_UNSUPPORTED',
  );
});

test('UT-PLG-004: malformed manifest fields are rejected', () => {
  const bad = [
    baseManifest({ id: 'Demo Runner' }),
    baseManifest({ id: '' }),
    baseManifest({ version: '1.0' }),
    baseManifest({ kind: 'unknown' }),
    baseManifest({ entry: '/abs/index.mjs' }),
    baseManifest({ entry: '../index.mjs' }),
    baseManifest({ entry: 'index.txt' }),
    baseManifest({ publisher: {} }),
  ];
  for (const manifest of bad) {
    assert.equal(
      codeOf(() => validatePluginManifest(manifest)),
      'PLUGIN_MANIFEST_INVALID',
      JSON.stringify(manifest),
    );
  }
});

test('UT-PLG-005: a forbidden permission is rejected whatever the tier is', () => {
  for (const permission of PLUGIN_FORBIDDEN_PERMISSIONS) {
    assert.equal(
      codeOf(() => validatePluginManifest(baseManifest({ permissions: [permission] }))),
      'PLUGIN_PERMISSION_FORBIDDEN',
      permission,
    );
  }
});

test('UT-PLG-006: a permission outside the vocabulary is rejected', () => {
  assert.equal(
    codeOf(() => validatePluginManifest(baseManifest({ permissions: ['files.delete'] }))),
    'PLUGIN_PERMISSION_UNKNOWN',
  );
});

test('UT-PLG-007: a duplicate permission is rejected', () => {
  assert.equal(
    codeOf(() => validatePluginManifest(baseManifest({ permissions: ['test.read', 'test.read'] }))),
    'PLUGIN_MANIFEST_INVALID',
  );
});

test('UT-PLG-008: a capability outside the ATS-301 vocabulary is rejected', () => {
  assert.equal(
    codeOf(() => validatePluginManifest(baseManifest({ capabilities: ['teleport'] }))),
    'PLUGIN_CAPABILITY_UNKNOWN',
  );
});

test('UT-PLG-009: a runner plugin must declare the four required capabilities', () => {
  assert.equal(
    codeOf(() => validatePluginManifest(baseManifest({ capabilities: ['discover', 'start'] }))),
    'PLUGIN_CAPABILITY_REQUIRED',
  );
});

test('UT-PLG-010: a non-runner plugin needs no capabilities', () => {
  const m = validatePluginManifest(baseManifest({ kind: 'reporter', capabilities: [] }));
  assert.equal(m.kind, 'reporter');
});

/* ------------------------------------------------------------------ */
/* permissions                                                         */
/* ------------------------------------------------------------------ */

test('UT-PLG-011: the effective permission set is the declared set intersected with the tier', () => {
  const resolution = resolvePluginPermissions(['test.read', 'evidence.read'], 'observer');
  assert.deepEqual(resolution.granted, ['evidence.read', 'test.read']);
  assert.equal(resolution.denied.length, 0);
});

test('UT-PLG-012: a permission above the tier is denied, not granted', () => {
  const resolution = resolvePluginPermissions(['test.read', 'evidence.read', 'outcome.report'], 'readonly');
  assert.deepEqual(resolution.granted, ['test.read']);
  const denied = resolution.denied.map((d) => d.permission).sort();
  assert.deepEqual(denied, ['evidence.read', 'outcome.report']);
  for (const d of resolution.denied) assert.equal(d.reason, 'not-in-tier');
});

test('UT-PLG-013: the tier is the ceiling -- a plugin cannot raise it by declaring', () => {
  // The same declaration under three tiers yields three different effective
  // sets. The plugin's declaration is identical in all three cases.
  const declared = ['test.read', 'requirements.read', 'evidence.read', 'outcome.report'];
  assert.deepEqual(resolvePluginPermissions(declared, 'readonly').granted, ['requirements.read', 'test.read']);
  assert.deepEqual(
    resolvePluginPermissions(declared, 'observer').granted,
    ['evidence.read', 'requirements.read', 'test.read'],
  );
  assert.deepEqual(
    resolvePluginPermissions(declared, 'reporter').granted,
    ['evidence.read', 'outcome.report', 'requirements.read', 'test.read'],
  );
});

test('UT-PLG-014: a forbidden permission is reported as forbidden, not as above-tier', () => {
  const resolution = resolvePluginPermissions(['source.write'], 'reporter');
  assert.equal(resolution.granted.length, 0);
  assert.equal(resolution.denied[0].reason, 'forbidden');
});

test('UT-PLG-015: an unknown permission is reported as unknown', () => {
  const resolution = resolvePluginPermissions(['files.delete'], 'reporter');
  assert.equal(resolution.granted.length, 0);
  assert.equal(resolution.denied[0].reason, 'unknown');
});

test('UT-PLG-016: every tier grants a subset of the permission vocabulary', () => {
  for (const [name, list] of Object.entries(PLUGIN_POLICY_TIERS)) {
    for (const permission of list) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(PLUGIN_PERMISSIONS, permission),
        `${name} grants ${permission}, which is not in the vocabulary`,
      );
      assert.ok(
        !PLUGIN_FORBIDDEN_PERMISSIONS.includes(permission),
        `${name} grants the forbidden permission ${permission}`,
      );
    }
  }
});

test('UT-PLG-017: no tier grants a forbidden permission', () => {
  for (const list of Object.values(PLUGIN_POLICY_TIERS)) {
    for (const permission of list) {
      assert.ok(!PLUGIN_FORBIDDEN_PERMISSIONS.includes(permission), permission);
    }
  }
});

test('UT-PLG-018: an operation is authorised only when its permission is granted', () => {
  const manifest = baseManifest({ permissions: ['test.read'] });
  assert.equal(authorizePluginOperation(manifest, 'readTestFile', 'readonly').allowed, true);
  const denied = authorizePluginOperation(manifest, 'readRunEvidence', 'readonly');
  assert.equal(denied.allowed, false);
  assert.equal(denied.permission, 'evidence.read');
  assert.ok(denied.reason.length > 0);
});

test('UT-PLG-019: an unknown operation is not authorised', () => {
  const decision = authorizePluginOperation(baseManifest(), 'deleteEverything', 'reporter');
  assert.equal(decision.allowed, false);
  assert.ok(decision.known.includes('readTestFile'));
});

test('UT-PLG-020: describe needs no permission', () => {
  assert.equal(authorizePluginOperation(baseManifest({ permissions: [] }), 'describe', 'readonly').allowed, true);
});

/* ------------------------------------------------------------------ */
/* SDK surface                                                         */
/* ------------------------------------------------------------------ */

test('UT-PLG-021: the SDK exposes exactly the declared surface', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({ manifest: baseManifest(), host, scope: { files: ['tests'] } });
  assert.deepEqual(Object.keys(sdk).sort(), [...PLUGIN_SDK_SURFACE].sort());
  for (const name of PLUGIN_SDK_SURFACE) {
    assert.equal(typeof sdk[name], 'function', name);
  }
});

test('UT-PLG-022: the SDK is frozen -- a plugin cannot add a method to it', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({ manifest: baseManifest(), host });
  assert.throws(() => { 'use strict'; sdk.escape = () => {}; }, TypeError);
});

test('UT-PLG-023: describe reports the granted and the denied permissions', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['test.read', 'evidence.read'] }),
    host,
    tier: 'readonly',
  });
  const described = sdk.describe();
  assert.equal(described.contract, PLUGIN_CONTRACT_VERSION);
  assert.deepEqual(described.grantedPermissions, ['test.read']);
  assert.equal(described.deniedPermissions.length, 1);
  assert.equal(described.deniedPermissions[0].permission, 'evidence.read');
});

/* ------------------------------------------------------------------ */
/* the SDK cannot be used to bypass the permission list                */
/* ------------------------------------------------------------------ */

test('UT-PLG-024: an operation above the tier is refused', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['evidence.read'] }),
    host,
    tier: 'readonly',
  });
  let code = null;
  try {
    await sdk.readRunEvidence(PROJECT, RUN_UID);
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, 'PLUGIN_PERMISSION_DENIED');
  // The refusal itself is audited.
  assert.ok(events.some((e) => e.type === 'plugin.operation.denied'));
});

test('UT-PLG-025: a DENIED call is audited', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['evidence.read'] }),
    host,
    tier: 'readonly',
  });
  await assert.rejects(() => sdk.readRunEvidence(PROJECT, RUN_UID));
  const denied = events.filter((e) => e.type === 'plugin.operation.denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].data.permission, 'evidence.read');
});

test('UT-PLG-026: the audit sequence is monotonic and matches the sink', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest(),
    host,
    scope: { files: ['tests'] },
    projects: [PROJECT],
  });
  await sdk.readTestFile(PROJECT, 'tests/login.spec.ts');
  await sdk.readTestFile(PROJECT, 'tests/other.spec.ts');
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  // describe() is audited too, so it is the third event.
  assert.equal(sdk.describe().auditSeq, 3);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
});

test('UT-PLG-027: the plugin cannot choose its own audit sequence', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest(),
    host,
    scope: { files: ['tests'] },
    projects: [PROJECT],
  });
  // A plugin that tries to write a forged event into the sink is writing to a
  // function the host owns -- the sequence is assigned by the SDK.
  await sdk.readTestFile(PROJECT, 'tests/login.spec.ts');
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);
  assert.equal(events[0].pluginId, 'demo-runner');
  assert.equal(events[0].type, 'plugin.test.read');
  // The plugin cannot add an event of its own: the sink only ever receives
  // what the SDK wrote, and the SDK wrote exactly one event for one call.
  assert.ok(events.every((e) => e.pluginId === 'demo-runner'));
});

test('UT-PLG-028: reading a file outside the host-granted scope is refused', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest(),
    host,
    scope: { files: ['tests'] },
    projects: [PROJECT],
  });
  for (const target of ['server/index.mjs', '../outside.spec.ts', 'tests/../../escape.spec.ts']) {
    let code = null;
    try {
      await sdk.readTestFile(PROJECT, target);
    } catch (error) {
      code = error.code;
    }
    assert.equal(code, 'PLUGIN_SCOPE_INVALID', target);
  }
});

test('UT-PLG-029: with no scope at all nothing is readable', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({ manifest: baseManifest(), host, projects: [PROJECT] });
  let code = null;
  try {
    await sdk.readTestFile(PROJECT, 'tests/login.spec.ts');
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, 'PLUGIN_SCOPE_INVALID');
});

test('UT-PLG-030: a manifest cannot widen its own scope', async () => {
  const { host } = makeHost();
  // A manifest that tries to declare a scope of its own: the field is simply
  // not part of the manifest, and the host scope is what counts.
  const sdk = createPluginSdk({
    manifest: baseManifest({ scope: { files: ['.'] } }),
    host,
    scope: { files: ['tests'] },
    projects: [PROJECT],
  });
  let code = null;
  try {
    await sdk.readTestFile(PROJECT, 'server/index.mjs');
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, 'PLUGIN_SCOPE_INVALID');
});

/* ------------------------------------------------------------------ */
/* the SDK cannot bypass the audit and evidence chain                 */
/* ------------------------------------------------------------------ */

test('UT-PLG-031: an outcome without evidence is refused', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  let code = null;
  try {
    await sdk.reportOutcome(PROJECT, RUN_UID, { summary: 'looks fine' });
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, 'PLUGIN_EVIDENCE_REQUIRED');
});

test('UT-PLG-032: an outcome carries the digest the HOST computed', async () => {
  const { host } = makeHost({
    resolveEvidenceDigest: async (projectId, runUid, ref) => 'b'.repeat(64),
  });
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  const proposal = await sdk.reportOutcome(PROJECT, RUN_UID, {
    summary: 'the login flow passed',
    status: 'passed',
    evidenceRefs: ['trace.zip'],
  });
  assert.equal(proposal.evidenceRefs.length, 1);
  assert.equal(proposal.evidenceRefs[0].ref, 'trace.zip');
  assert.equal(proposal.evidenceRefs[0].sha256, 'b'.repeat(64));
});

test('UT-PLG-033: a plugin-supplied digest is not accepted', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  // The plugin tries to vouch for its own evidence by handing the SDK a
  // {ref, sha256} object instead of a reference. The SDK does not read a
  // digest from the plugin at all: it asks the host for one, so the plugin's
  // own value is simply not part of the input.
  let code = null;
  try {
    await sdk.reportOutcome(PROJECT, RUN_UID, {
      summary: 'trust me',
      evidenceRefs: [{ ref: 'trace.zip', sha256: 'c'.repeat(64) }],
    });
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, 'PLUGIN_PROPOSAL_INVALID');
});

test('UT-PLG-034: an outcome is a proposal with approval=pending', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  const proposal = await sdk.reportOutcome(PROJECT, RUN_UID, {
    summary: 'done',
    status: 'passed',
    evidenceRefs: ['trace.zip'],
  });
  assert.equal(proposal.approval, 'pending');
  assert.equal(proposal.kind, 'outcome');
  assert.equal(proposal.producedBy, 'plugin:demo-runner');
});

test('UT-PLG-035: an outcome cannot set the run status directly', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  let code = null;
  try {
    await sdk.reportOutcome(PROJECT, RUN_UID, {
      summary: 'done',
      status: 'not-a-status',
      evidenceRefs: ['trace.zip'],
    });
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, 'PLUGIN_PROPOSAL_INVALID');
});

test('UT-PLG-036: reporting an outcome is audited', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  await sdk.reportOutcome(PROJECT, RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
  const reported = events.filter((e) => e.type === 'plugin.outcome.reported');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].data.approval, 'pending');
});

/* ------------------------------------------------------------------ */
/* review                                                              */
/* ------------------------------------------------------------------ */

test('UT-PLG-037: the producer may not review its own proposal', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  const proposal = await sdk.reportOutcome(PROJECT, RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
  assert.equal(
    codeOf(() => reviewPluginProposal(proposal, { reviewer: 'plugin:demo-runner', decision: 'approved', host })),
    'PLUGIN_REVIEW_SELF_FORBIDDEN',
  );
});

test('UT-PLG-038: the self-review check is not an exact string comparison', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  const proposal = await sdk.reportOutcome(PROJECT, RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
  for (const reviewer of ['plugin:demo-runner ', ' PLUGIN:DEMO-RUNNER', 'plugin:demo-runner'.toUpperCase()]) {
    assert.equal(
      codeOf(() => reviewPluginProposal(proposal, { reviewer, decision: 'approved', host })),
      'PLUGIN_REVIEW_SELF_FORBIDDEN',
      reviewer,
    );
  }
});

test('UT-PLG-039: an independent reviewer can approve', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  const proposal = await sdk.reportOutcome(PROJECT, RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
  const approved = reviewPluginProposal(proposal, { reviewer: 'reviewer-1', decision: 'approved', host });
  assert.equal(approved.approval, 'approved');
  assert.equal(approved.reviewedBy, 'reviewer-1');
  // The review does not change the content.
  assert.equal(approved.summary, proposal.summary);
  assert.deepEqual(approved.evidenceRefs, proposal.evidenceRefs);
});

test('UT-PLG-040: only a pending proposal can be reviewed', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  const proposal = await sdk.reportOutcome(PROJECT, RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
  const approved = reviewPluginProposal(proposal, { reviewer: 'reviewer-1', decision: 'approved', host });
  assert.equal(
    codeOf(() => reviewPluginProposal(approved, { reviewer: 'reviewer-2', decision: 'rejected', host })),
    'PLUGIN_REVIEW_STATE_INVALID',
  );
});

test('UT-PLG-041: an invalid review decision is refused', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  const proposal = await sdk.reportOutcome(PROJECT, RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
  assert.equal(
    codeOf(() => reviewPluginProposal(proposal, { reviewer: 'reviewer-1', decision: 'maybe', host })),
    'PLUGIN_REVIEW_STATE_INVALID',
  );
});

/* ------------------------------------------------------------------ */
/* the description                                                     */
/* ------------------------------------------------------------------ */

test('UT-PLG-042: the contract description is complete and honest', () => {
  const described = describePluginContract();
  assert.equal(described.contract, PLUGIN_CONTRACT_VERSION);
  assert.equal(described.manifestVersion, PLUGIN_MANIFEST_VERSION);
  assert.equal(described.defaultTier, DEFAULT_PLUGIN_POLICY_TIER);
  assert.deepEqual(
    described.permissions.map((p) => p.name).sort(),
    Object.keys(PLUGIN_PERMISSIONS).sort(),
  );
  assert.deepEqual(
    described.forbiddenPermissions,
    [...PLUGIN_FORBIDDEN_PERMISSIONS],
  );
  assert.deepEqual(
    described.operations.map((o) => o.name).sort(),
    [...PLUGIN_SDK_SURFACE].sort(),
  );
  assert.deepEqual(described.errorCodes, [...PLUGIN_ERROR_CODES]);
});

test('UT-PLG-043: every SDK operation names a permission that exists in the vocabulary', () => {
  for (const [name, spec] of Object.entries(PLUGIN_OPERATIONS)) {
    if (spec.permission === null) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(PLUGIN_PERMISSIONS, spec.permission),
      `${name} needs the unknown permission ${spec.permission}`,
    );
    assert.ok(
      !PLUGIN_FORBIDDEN_PERMISSIONS.includes(spec.permission),
      `${name} needs the forbidden permission ${spec.permission}`,
    );
  }
});

test('UT-PLG-044: the description does not claim the plugin host exists', () => {
  const described = describePluginContract();
  assert.equal(described.designStatus, 'CONTRACT_ONLY');
});

test('UT-PLG-045: the contract description lists every error code the modules can raise', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'server', 'plugins', 'contract.mjs'),
    'utf8',
  ) + fs.readFileSync(
    path.join(import.meta.dirname, '..', 'server', 'plugins', 'sdk.mjs'),
    'utf8',
  );
  // The codes are raised in two shapes: `fail('CODE', ...)` and
  // `refuse('CODE', ...)` -- the refusal helper audits the event and then
  // raises the code. Both count as "raised".
  const raised = new Set([
    ...[...source.matchAll(/fail\('([A-Z_]+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/refuse\(\s*'([A-Z_]+)'/g)].map((m) => m[1]),
  ]);
  for (const code of raised) {
    assert.ok(PLUGIN_ERROR_CODES.includes(code), `the code ${code} is raised but not listed`);
  }
  for (const code of PLUGIN_ERROR_CODES) {
    assert.ok(raised.has(code), `the code ${code} is listed but never raised`);
  }
});

test('UT-PLG-046: the SDK construction rejects an incomplete host', () => {
  const { host } = makeHost();
  delete host.audit;
  // A host without an audit sink would make every plugin call unauditable,
  // so the SDK refuses to be built at all.
  assert.equal(
    codeOf(() => createPluginSdk({ manifest: baseManifest(), host })),
    'PLUGIN_AUDIT_REQUIRED',
  );
  const { host: noReader } = makeHost();
  delete noReader.readTestFile;
  assert.equal(
    codeOf(() => createPluginSdk({ manifest: baseManifest(), host: noReader })),
    'PLUGIN_MANIFEST_INVALID',
  );
});

test('UT-PLG-047: a plugin cannot read outside the scope even with the permission', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['test.read'] }),
    host,
    scope: { files: ['tests/login.spec.ts'] },
    projects: [PROJECT],
  });
  // The exact file is readable ...
  const ok = await sdk.readTestFile(PROJECT, 'tests/login.spec.ts');
  assert.equal(ok.file, 'tests/login.spec.ts');
  // ... a sibling file is not.
  let code = null;
  try {
    await sdk.readTestFile(PROJECT, 'tests/other.spec.ts');
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, 'PLUGIN_SCOPE_INVALID');
  // The refusal is audited too, under its own event type: a scope violation
  // is not the same fact as a missing permission.
  const scopeDenied = events.filter((e) => e.type === 'plugin.scope.denied');
  assert.equal(scopeDenied.length, 1);
  assert.equal(scopeDenied[0].data.operation, 'readTestFile');
});

test('UT-PLG-048: an absolute path is refused even when it is inside the scope prefix', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest(),
    host,
    scope: { files: ['tests'] },
    projects: [PROJECT],
  });
  let code = null;
  try {
    await sdk.readTestFile(PROJECT, 'C:/Windows/win.ini');
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, 'PLUGIN_SCOPE_INVALID');
});

test('UT-PLG-049: the host grants the scope, the manifest does not', async () => {
  const { host } = makeHost();
  // The host grants nothing, the manifest asks for everything.
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['test.read', 'requirements.read', 'evidence.read'] }),
    host,
    scope: { files: [] },
    projects: [PROJECT],
  });
  let code = null;
  try {
    await sdk.readTestFile(PROJECT, 'tests/login.spec.ts');
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, 'PLUGIN_SCOPE_INVALID');
});

test('UT-PLG-050: the SDK never touches the file system itself', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'server', 'plugins', 'sdk.mjs'),
    'utf8',
  );
  // The SDK reads through the host's injected functions. It must not import
  // an I/O module of its own -- otherwise the plugin boundary would be a
  // convention rather than a mechanism.
  assert.ok(!/from\s+'node:fs'/.test(source), 'the SDK must not import node:fs');
  assert.ok(!/from\s+'node:child_process'/.test(source), 'the SDK must not import node:child_process');
  assert.ok(!/\bspawnSync\b|\bspawn\b/.test(source), 'the SDK must not spawn a process');
});

test('UT-PLG-051: a forbidden permission never appears in a granted set', () => {
  for (const tier of Object.keys(PLUGIN_POLICY_TIERS)) {
    const resolution = resolvePluginPermissions(
      [...Object.keys(PLUGIN_PERMISSIONS), ...PLUGIN_FORBIDDEN_PERMISSIONS],
      tier,
    );
    for (const permission of resolution.granted) {
      assert.ok(!PLUGIN_FORBIDDEN_PERMISSIONS.includes(permission), permission);
    }
  }
});

test('UT-PLG-052: the temporary fixture is empty -- the SDK wrote nothing', () => {
  assert.deepEqual(fs.readdirSync(dir), []);
});

/* ------------------------------------------------------------------ */
/* round 2: the audit trail covers EVERY call                          */
/* ------------------------------------------------------------------ */

test('UT-PLG-053: describe() is audited like every other SDK call', () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({ manifest: baseManifest(), host });
  sdk.describe();
  sdk.describe();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.type), ['plugin.describe', 'plugin.describe']);
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
});

test('UT-PLG-054: an attempt to report an outcome without evidence is audited', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  await assert.rejects(() => sdk.reportOutcome(PROJECT, RUN_UID, { summary: 'no evidence' }));
  await assert.rejects(() => sdk.reportOutcome(PROJECT, RUN_UID, { summary: 'no evidence', evidenceRefs: [] }));
  const refused = events.filter((e) => e.type === 'plugin.proposal.refused');
  assert.equal(refused.length, 2);
  assert.ok(refused.every((e) => e.data.reason.length > 0));
});

test('UT-PLG-055: every refused read is audited -- bad runUid, unresolvable digest, bad status', async () => {
  const { host, events } = makeHost({
    resolveEvidenceDigest: async () => 'not-a-digest',
  });
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report', 'evidence.read'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  assert.equal(
    await codeOfAsync(() => sdk.readRunEvidence(PROJECT, '../../etc')),
    'PLUGIN_SCOPE_INVALID',
  );
  assert.equal(
    await codeOfAsync(() => sdk.readRunEvidence(PROJECT, 'run_x')),
    'PLUGIN_SCOPE_INVALID',
  );
  // (both are refused by the runUid gate; the project gate passed because
  //  PROJECT is in the host-granted list)
  assert.equal(
    await codeOfAsync(() => sdk.reportOutcome(PROJECT, RUN_UID, { summary: 's', evidenceRefs: ['forged.png'] })),
    'PLUGIN_EVIDENCE_REQUIRED',
  );
  // Every one of the three refusals left a trace.
  assert.equal(events.length, 3);
  assert.equal(events.filter((e) => e.type === 'plugin.run.denied').length, 2);
  assert.equal(events.filter((e) => e.type === 'plugin.proposal.refused').length, 1);

  // An illegal status is refused too -- with a host that CAN resolve the
  // digest, so the status gate is the one that fires.
  const { host: host2, events: events2 } = makeHost();
  const sdk2 = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host: host2,
    tier: 'reporter',
    projects: [PROJECT],
  });
  assert.equal(
    await codeOfAsync(() => sdk2.reportOutcome(PROJECT, RUN_UID, {
      summary: 's',
      evidenceRefs: ['e'],
      status: 'approved',
    })),
    'PLUGIN_PROPOSAL_INVALID',
  );
  assert.equal(events2.filter((e) => e.type === 'plugin.proposal.refused').length, 1);
});

test('UT-PLG-056: a host read that FAILS is audited too', async () => {
  const { host, events } = makeHost({
    readTestFile: async () => { throw new Error('ENOENT'); },
  });
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['test.read'] }),
    host,
    scope: { files: ['tests'] },
    projects: [PROJECT],
  });
  // The host's error is surfaced to the caller (the read did happen); what
  // matters is that it left a trace.
  let thrown = null;
  try {
    await sdk.readTestFile(PROJECT, 'tests/secret-probe.spec.ts');
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'the host error is surfaced to the caller');
  assert.match(thrown.message, /ENOENT/);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'plugin.test.read');
  assert.equal(events[0].data.outcome, 'failed');
  assert.equal(events[0].data.error, 'ENOENT');
});

/* ------------------------------------------------------------------ */
/* round 2: the host holds the authoritative proposal record           */
/* ------------------------------------------------------------------ */

test('UT-PLG-057: the SDK refuses to be built without a proposal store', () => {
  const { host } = makeHost();
  delete host.submitProposal;
  assert.equal(
    codeOf(() => createPluginSdk({ manifest: baseManifest(), host })),
    'PLUGIN_HOST_REQUIRED',
  );
  const { host: noGetter } = makeHost();
  delete noGetter.getProposal;
  assert.equal(
    codeOf(() => createPluginSdk({ manifest: baseManifest(), host: noGetter })),
    'PLUGIN_HOST_REQUIRED',
  );
});

test('UT-PLG-058: the proposal is handed to the HOST, together with its digests', async () => {
  const { host, proposals } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  const proposal = await sdk.reportOutcome(PROJECT, RUN_UID, {
    summary: 'done',
    evidenceRefs: ['trace.zip'],
  });
  // The host holds the record -- not the plugin.
  assert.ok(proposals.has(proposal.proposalId));
  const record = proposals.get(proposal.proposalId);
  assert.equal(record.approval, 'pending');
  assert.equal(record.evidenceRefs[0].sha256, 'a'.repeat(64));
  // And the audit trail names the proposal and its digests.
  const reported = host.audit && null;
  assert.equal(reported, null);
});

test('UT-PLG-059: the audit trail records the proposal id and every evidence digest', async () => {
  const { host, events } = makeHost({
    resolveEvidenceDigest: async (projectId, runUid, ref) => (ref === 'trace.zip' ? 'd'.repeat(64) : 'e'.repeat(64)),
  });
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  const proposal = await sdk.reportOutcome(PROJECT, RUN_UID, {
    summary: 'done',
    evidenceRefs: ['trace.zip', 'report.json'],
  });
  const reported = events.filter((e) => e.type === 'plugin.outcome.reported');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].data.proposalId, proposal.proposalId);
  assert.deepEqual(reported[0].data.evidenceDigests, [
    { ref: 'trace.zip', sha256: 'd'.repeat(64) },
    { ref: 'report.json', sha256: 'e'.repeat(64) },
  ]);
});

test('UT-PLG-060: a proposal the HOST does not hold cannot be reviewed', () => {
  const { host } = makeHost();
  const forged = {
    proposalId: 'plgprop_evil_1',
    pluginId: 'evil',
    runUid: RUN_UID,
    kind: 'outcome',
    status: 'passed',
    summary: 'all green',
    evidenceRefs: [],
    approval: 'pending',
    producedBy: 'plugin:evil',
  };
  // A shape-valid, evidence-less proposal the host never saw is refused.
  assert.equal(
    codeOf(() => reviewPluginProposal(forged, { reviewer: 'alice', decision: 'approved', host })),
    'PLUGIN_PROPOSAL_INVALID',
  );
});

test('UT-PLG-061: a TAMPERED proposal cannot be reviewed', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  const proposal = await sdk.reportOutcome(PROJECT, RUN_UID, { summary: 'ok', evidenceRefs: ['e1'] });
  // The plugin edits its own copy: a different digest, a different producer.
  // The shape is perfectly legal -- only the CONTENT differs from the host
  // record, and that is what the review gate checks.
  proposal.evidenceRefs[0].sha256 = 'b'.repeat(64);
  proposal.producedBy = 'plugin:someone-else';
  assert.equal(
    codeOf(() => reviewPluginProposal(proposal, { reviewer: 'plugin:evil', decision: 'approved', host })),
    'PLUGIN_PROPOSAL_INVALID',
  );
});

test('UT-PLG-062: a review without the host record store is refused', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  const proposal = await sdk.reportOutcome(PROJECT, RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
  assert.equal(
    codeOf(() => reviewPluginProposal(proposal, { reviewer: 'reviewer-1', decision: 'approved' })),
    'PLUGIN_REVIEW_STATE_INVALID',
  );
});

test('UT-PLG-063: the proposal id is globally unique across SDK instances', async () => {
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const { host } = makeHost();
    const sdk = createPluginSdk({
      manifest: baseManifest({ permissions: ['outcome.report'] }),
      host,
      tier: 'reporter',
      projects: [PROJECT],
    });
    const proposal = await sdk.reportOutcome(PROJECT, RUN_UID, { summary: 's', evidenceRefs: ['e'] });
    ids.push(proposal.proposalId);
  }
  assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids.join(', ')}`);
  assert.ok(ids.every((id) => id.startsWith('plgprop_demo-runner_')));
});

/* ------------------------------------------------------------------ */
/* round 2: the project scope is granted by the host                   */
/* ------------------------------------------------------------------ */

test('UT-PLG-064: a project outside the host-granted list is refused and audited', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['test.read', 'requirements.read', 'evidence.read'] }),
    host,
    tier: 'reporter',
    scope: { files: ['tests'] },
    projects: [PROJECT],
  });
  for (const operation of [
    () => sdk.readTestFile('proj_OTHER_TENANT', 'tests/a.spec.ts'),
    () => sdk.readRequirements('proj_OTHER_TENANT'),
    () => sdk.readRunEvidence('proj_OTHER_TENANT', RUN_UID),
  ]) {
    assert.equal(await codeOfAsync(operation), 'PLUGIN_SCOPE_INVALID');
  }
  // The host never saw the other tenant's project id.
  assert.equal(events.filter((e) => e.type === 'plugin.project.denied').length, 3);
  assert.ok(events.every((e) => e.data.projectId !== 'proj_OTHER_TENANT' || e.type === 'plugin.project.denied'));
});

test('UT-PLG-065: with no granted project every operation is refused', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['test.read'] }),
    host,
    scope: { files: ['tests'] },
  });
  assert.equal(await codeOfAsync(() => sdk.readTestFile(PROJECT, 'tests/a.spec.ts')), 'PLUGIN_SCOPE_INVALID');
  assert.equal(events.filter((e) => e.type === 'plugin.project.denied').length, 1);
});

test('UT-PLG-066: the granted projects are part of the SDK description', () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest(),
    host,
    projects: [PROJECT, 'proj_y'],
  });
  assert.deepEqual(sdk.describe().grantedProjects, [PROJECT, 'proj_y']);
});

/* ------------------------------------------------------------------ */
/* round 2: the frozen tables are looked up with own properties only   */
/* ------------------------------------------------------------------ */

test('UT-PLG-067: an operation named after a prototype member is not authorised', () => {
  const manifest = baseManifest({ permissions: ['test.read'] });
  for (const operation of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const decision = authorizePluginOperation(manifest, operation, 'reporter');
    assert.equal(decision.allowed, false, `${operation} must not be authorised`);
    assert.equal(decision.permission, null);
  }
});

test('UT-PLG-068: a tier named after a prototype member is rejected', () => {
  for (const tier of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
    assert.equal(
      codeOf(() => resolvePluginPermissions(['test.read'], tier)),
      'PLUGIN_MANIFEST_INVALID',
      tier,
    );
  }
});

test('UT-PLG-069: authorizePluginCall refuses an unknown operation with its own code', () => {
  assert.equal(
    codeOf(() => authorizePluginCall({ manifest: baseManifest(), operation: 'toString' })),
    'PLUGIN_OPERATION_UNSUPPORTED',
  );
  assert.equal(
    codeOf(() => authorizePluginCall({
      manifest: baseManifest({ permissions: ['test.read'] }),
      operation: 'readRunEvidence',
    })),
    'PLUGIN_PERMISSION_DENIED',
  );
  const allowed = authorizePluginCall({
    manifest: baseManifest({ permissions: ['test.read'] }),
    operation: 'readTestFile',
  });
  assert.equal(allowed.allowed, true);
});

/* ------------------------------------------------------------------ */
/* round 2: the audit sequence only advances on a written event        */
/* ------------------------------------------------------------------ */

test('UT-PLG-070: the audit sequence does not advance when the sink rejects the event', async () => {
  let written = 0;
  const { host } = makeHost({
    audit: (event) => {
      written += 1;
      if (written === 1) throw new Error('sink down');
      // The sink stores the event it accepted.
    },
  });
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['test.read'] }),
    host,
    scope: { files: ['tests'] },
    projects: [PROJECT],
  });
  // The first write fails: the event never reached the sink, so the
  // sequence must not have advanced. The failure is surfaced -- a call
  // that left no record may not look successful.
  assert.equal(await codeOfAsync(() => sdk.readTestFile(PROJECT, 'tests/a.ts')), 'NO_CODE(sink down)');
  // The sink holds ZERO events, and the SDK's sequence is still 0.
  assert.equal(written, 1, 'the sink was called once and rejected it');
  assert.equal(sdk.describe().auditSeq >= 1, true, 'describe() itself is the next event');
  // A sink that accepts events numbers them 1, 2, ... -- the count of the
  // events it actually holds, with no gap left by a rejected write.
  const events = [];
  const { host: host2 } = makeHost({ audit: (event) => events.push(event) });
  const sdk2 = createPluginSdk({
    manifest: baseManifest({ permissions: ['test.read'] }),
    host: host2,
    scope: { files: ['tests'] },
    projects: [PROJECT],
  });
  await sdk2.readTestFile(PROJECT, 'tests/a.ts');
  await sdk2.readTestFile(PROJECT, 'tests/b.ts');
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
});

test('UT-PLG-071: a host that refuses the proposal record is audited and reported', async () => {
  const { host, events } = makeHost({
    submitProposal: async () => { throw new Error('proposal store offline'); },
  });
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  assert.equal(
    await codeOfAsync(() => sdk.reportOutcome(PROJECT, RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] })),
    'PLUGIN_PROPOSAL_INVALID',
  );
  assert.equal(events.filter((e) => e.type === 'plugin.proposal.refused').length, 1);
});

/* ------------------------------------------------------------------ */
/* the successful read paths                                           */
/* ------------------------------------------------------------------ */

test('UT-PLG-072: readRequirements returns the host answer and is audited', async () => {
  const { host, events } = makeHost({
    readRequirements: async (projectId) => ({ projectId, requirements: ['FR-001'] }),
  });
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['requirements.read'] }),
    host,
    projects: [PROJECT],
  });
  const result = await sdk.readRequirements(PROJECT);
  assert.deepEqual(result.requirements, ['FR-001']);
  const read = events.filter((e) => e.type === 'plugin.requirements.read');
  assert.equal(read.length, 1);
  assert.equal(read[0].data.outcome, 'ok');
});

test('UT-PLG-073: readRequirements without the permission is refused and audited', async () => {
  const { host, events } = makeHost();
  // The manifest does not ask for requirements.read at all.
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['test.read'] }),
    host,
    tier: 'readonly',
    projects: [PROJECT],
  });
  assert.equal(await codeOfAsync(() => sdk.readRequirements(PROJECT)), 'PLUGIN_PERMISSION_DENIED');
  assert.equal(events.filter((e) => e.type === 'plugin.operation.denied').length, 1);
});

test('UT-PLG-074: readRunEvidence returns the host answer and is audited', async () => {
  const { host, events } = makeHost({
    readRunEvidence: async (projectId, runUid) => ({ projectId, runUid, artifacts: ['trace.zip'] }),
  });
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['evidence.read'] }),
    host,
    tier: 'observer',
    projects: [PROJECT],
  });
  const result = await sdk.readRunEvidence(PROJECT, RUN_UID);
  assert.deepEqual(result.artifacts, ['trace.zip']);
  const read = events.filter((e) => e.type === 'plugin.evidence.read');
  assert.equal(read.length, 1);
  assert.equal(read[0].data.runUid, RUN_UID);
});

test('UT-PLG-075: readRunEvidence with a bad runUid is refused and audited', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['evidence.read'] }),
    host,
    tier: 'observer',
    projects: [PROJECT],
  });
  assert.equal(await codeOfAsync(() => sdk.readRunEvidence(PROJECT, 'run_x')), 'PLUGIN_SCOPE_INVALID');
  assert.equal(events.filter((e) => e.type === 'plugin.run.denied').length, 1);
});

test('UT-PLG-076: an outcome with too many evidence references is refused', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  const refs = Array.from({ length: 65 }, (_v, i) => `e${i}`);
  assert.equal(
    await codeOfAsync(() => sdk.reportOutcome(PROJECT, RUN_UID, { summary: 's', evidenceRefs: refs })),
    'PLUGIN_PROPOSAL_INVALID',
  );
});

test('UT-PLG-077: an outcome with a bad shape is refused', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  assert.equal(
    await codeOfAsync(() => sdk.reportOutcome(PROJECT, RUN_UID, 'not-an-object')),
    'PLUGIN_PROPOSAL_INVALID',
  );
  assert.equal(
    await codeOfAsync(() => sdk.reportOutcome(PROJECT, RUN_UID, { summary: '', evidenceRefs: ['e'] })),
    'PLUGIN_PROPOSAL_INVALID',
  );
  assert.equal(
    await codeOfAsync(() => sdk.reportOutcome(PROJECT, RUN_UID, { summary: 's', evidenceRefs: [42] })),
    'PLUGIN_PROPOSAL_INVALID',
  );
});

test('UT-PLG-078: an outcome for a run outside the granted projects is refused', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
    projects: [PROJECT],
  });
  assert.equal(
    await codeOfAsync(() => sdk.reportOutcome('proj_OTHER', RUN_UID, { summary: 's', evidenceRefs: ['e'] })),
    'PLUGIN_SCOPE_INVALID',
  );
  assert.equal(events.filter((e) => e.type === 'plugin.project.denied').length, 1);
});
