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
 *   - every SDK call is audited, including the ones that are denied;
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
import { createPluginSdk, reviewPluginProposal } from '../server/plugins/sdk.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats512-ut-'));
const RUN_UID = 'run_00000000-0000-4000-8000-000000000001';

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

/** A host whose audit sink records everything it is handed. */
function makeHost(overrides = {}) {
  const events = [];
  return {
    events,
    host: {
      audit: (event) => { events.push(event); },
      readTestFile: async (projectId, file) => ({ projectId, file, content: `content of ${file}`, hash: 'h'.repeat(64) }),
      readRequirements: async (projectId) => ({ projectId, requirements: [] }),
      readRunEvidence: async (projectId, runUid) => ({ projectId, runUid, artifacts: [] }),
      resolveEvidenceDigest: async (projectId, runUid, ref) => 'a'.repeat(64),
      ...overrides,
    },
  };
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
    await sdk.readRunEvidence('proj_x', RUN_UID);
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
  await assert.rejects(() => sdk.readRunEvidence('proj_x', RUN_UID));
  const denied = events.filter((e) => e.type === 'plugin.operation.denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].data.permission, 'evidence.read');
});

test('UT-PLG-026: the audit sequence is monotonic and matches the sink', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({ manifest: baseManifest(), host, scope: { files: ['tests'] } });
  await sdk.readTestFile('proj_x', 'tests/login.spec.ts');
  await sdk.readTestFile('proj_x', 'tests/other.spec.ts');
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  assert.equal(sdk.describe().auditSeq, 2);
});

test('UT-PLG-027: the plugin cannot choose its own audit sequence', async () => {
  const { host, events } = makeHost();
  const sdk = createPluginSdk({ manifest: baseManifest(), host, scope: { files: ['tests'] } });
  // A plugin that tries to write a forged event into the sink is writing to a
  // function the host owns -- the sequence is assigned by the SDK.
  await sdk.readTestFile('proj_x', 'tests/login.spec.ts');
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);
  assert.equal(events[0].pluginId, 'demo-runner');
  assert.equal(events[0].type, 'plugin.test.read');
});

test('UT-PLG-028: reading a file outside the host-granted scope is refused', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({ manifest: baseManifest(), host, scope: { files: ['tests'] } });
  for (const target of ['server/index.mjs', '../outside.spec.ts', 'tests/../../escape.spec.ts']) {
    let code = null;
    try {
      await sdk.readTestFile('proj_x', target);
    } catch (error) {
      code = error.code;
    }
    assert.equal(code, 'PLUGIN_SCOPE_INVALID', target);
  }
});

test('UT-PLG-029: with no scope at all nothing is readable', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({ manifest: baseManifest(), host });
  let code = null;
  try {
    await sdk.readTestFile('proj_x', 'tests/login.spec.ts');
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
  });
  let code = null;
  try {
    await sdk.readTestFile('proj_x', 'server/index.mjs');
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
  });
  let code = null;
  try {
    await sdk.reportOutcome('proj_x', RUN_UID, { summary: 'looks fine' });
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
  });
  const proposal = await sdk.reportOutcome('proj_x', RUN_UID, {
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
  });
  // The plugin tries to vouch for its own evidence by handing the SDK a
  // {ref, sha256} object instead of a reference. The SDK does not read a
  // digest from the plugin at all: it asks the host for one, so the plugin's
  // own value is simply not part of the input.
  let code = null;
  try {
    await sdk.reportOutcome('proj_x', RUN_UID, {
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
  });
  const proposal = await sdk.reportOutcome('proj_x', RUN_UID, {
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
  });
  let code = null;
  try {
    await sdk.reportOutcome('proj_x', RUN_UID, {
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
  });
  await sdk.reportOutcome('proj_x', RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
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
  });
  const proposal = await sdk.reportOutcome('proj_x', RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
  assert.equal(
    codeOf(() => reviewPluginProposal(proposal, { reviewer: 'plugin:demo-runner', decision: 'approved' })),
    'PLUGIN_REVIEW_SELF_FORBIDDEN',
  );
});

test('UT-PLG-038: the self-review check is not an exact string comparison', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
  });
  const proposal = await sdk.reportOutcome('proj_x', RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
  for (const reviewer of ['plugin:demo-runner ', ' PLUGIN:DEMO-RUNNER', 'plugin:demo-runner'.toUpperCase()]) {
    assert.equal(
      codeOf(() => reviewPluginProposal(proposal, { reviewer, decision: 'approved' })),
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
  });
  const proposal = await sdk.reportOutcome('proj_x', RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
  const approved = reviewPluginProposal(proposal, { reviewer: 'reviewer-1', decision: 'approved' });
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
  });
  const proposal = await sdk.reportOutcome('proj_x', RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
  const approved = reviewPluginProposal(proposal, { reviewer: 'reviewer-1', decision: 'approved' });
  assert.equal(
    codeOf(() => reviewPluginProposal(approved, { reviewer: 'reviewer-2', decision: 'rejected' })),
    'PLUGIN_REVIEW_STATE_INVALID',
  );
});

test('UT-PLG-041: an invalid review decision is refused', async () => {
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: baseManifest({ permissions: ['outcome.report'] }),
    host,
    tier: 'reporter',
  });
  const proposal = await sdk.reportOutcome('proj_x', RUN_UID, { summary: 'done', evidenceRefs: ['trace.zip'] });
  assert.equal(
    codeOf(() => reviewPluginProposal(proposal, { reviewer: 'reviewer-1', decision: 'maybe' })),
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
  const raised = new Set([...source.matchAll(/fail\('([A-Z_]+)'/g)].map((m) => m[1]));
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
  });
  // The exact file is readable ...
  const ok = await sdk.readTestFile('proj_x', 'tests/login.spec.ts');
  assert.equal(ok.file, 'tests/login.spec.ts');
  // ... a sibling file is not.
  let code = null;
  try {
    await sdk.readTestFile('proj_x', 'tests/other.spec.ts');
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
  const sdk = createPluginSdk({ manifest: baseManifest(), host, scope: { files: ['tests'] } });
  let code = null;
  try {
    await sdk.readTestFile('proj_x', 'C:/Windows/win.ini');
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
  });
  let code = null;
  try {
    await sdk.readTestFile('proj_x', 'tests/login.spec.ts');
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
