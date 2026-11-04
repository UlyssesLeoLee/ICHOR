import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  AGENT_BUDGET_LIMITS,
  AGENT_CAPABILITIES,
  AGENT_CONTRACT_VERSION,
  AGENT_ROLES,
  FORBIDDEN_CAPABILITIES,
  createAgentAdapter,
  createModelProvider,
  describeAgentContract,
  reviewAgentProposal,
  validateAgentBudget,
  validateAgentProposal,
  validateAgentRequest,
  validateAgentScope,
} from '../server/agent.mjs';

const ROOT = 'D:/repos/demo-project';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const budget = () => ({
  maxInputBytes: 100_000,
  maxOutputBytes: 100_000,
  maxSteps: 4,
  deadlineMs: 30_000,
});

const scope = () => ({
  projectId: 'proj_demo',
  root: ROOT,
  files: ['tests/login.spec.ts'],
  outputs: ['tests/login.spec.ts'],
  runs: [],
  requirements: [],
});

function baseRequest(overrides = {}) {
  const content = "test('login passes', async ({page}) => {});\n";
  return {
    role: 'generator',
    scope: scope(),
    budget: budget(),
    instructions: 'propose a login test',
    requestedCapabilities: ['propose_script_diff'],
    inputs: [{
      kind: 'file',
      ref: 'tests/login.spec.ts',
      digest: sha(content),
      content,
      retrievedAt: '2026-11-04T00:00:00.000Z',
    }],
    ...overrides,
  };
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

test('UT-AGT-001: contract version and roles are stable', () => {
  assert.equal(AGENT_CONTRACT_VERSION, 'agent-contract/v1');
  assert.deepEqual([...AGENT_ROLES], ['planner', 'generator', 'triage', 'healer']);
});

test('UT-AGT-002: no role holds a write or commit capability', () => {
  for (const role of AGENT_ROLES) {
    for (const capability of AGENT_CAPABILITIES[role]) {
      assert.equal(
        FORBIDDEN_CAPABILITIES.includes(capability),
        false,
        `${role} must not hold ${capability}`,
      );
    }
  }
  assert.ok(FORBIDDEN_CAPABILITIES.includes('write_source'));
  assert.ok(FORBIDDEN_CAPABILITIES.includes('git_commit'));
});

test('UT-AGT-003: scope requires an absolute root and at least one input target', () => {
  const s = validateAgentScope(scope());
  assert.deepEqual(s.files, ['tests/login.spec.ts']);
  assert.equal(codeOf(() => validateAgentScope({ ...scope(), root: 'relative/path' })), 'AGENT_SCOPE_INVALID');
  assert.equal(
    codeOf(() => validateAgentScope({ ...scope(), files: [], runs: [], requirements: [] })),
    'AGENT_SCOPE_REQUIRED',
  );
});

test('UT-AGT-004: scope rejects paths that escape the project root', () => {
  assert.equal(
    codeOf(() => validateAgentScope({ ...scope(), files: ['../../etc/passwd'] })),
    'AGENT_SCOPE_ESCAPE',
  );
  assert.equal(
    codeOf(() => validateAgentScope({ ...scope(), files: ['/etc/passwd'] })),
    'AGENT_SCOPE_INVALID',
  );
});

test('UT-AGT-005: scope outputs must be test script files', () => {
  assert.equal(
    codeOf(() => validateAgentScope({ ...scope(), outputs: ['playwright.config.ts'] })),
    'AGENT_SCOPE_OUTPUT_NOT_TEST_SCRIPT',
  );
  const s = validateAgentScope({ ...scope(), outputs: ['tests/a.spec.ts', 'tests/b.test.tsx'] });
  assert.deepEqual(s.outputs, ['tests/a.spec.ts', 'tests/b.test.tsx']);
});

test('UT-AGT-006: budget must be present, integral and within platform limits', () => {
  assert.equal(codeOf(() => validateAgentBudget(undefined)), 'AGENT_BUDGET_REQUIRED');
  assert.equal(codeOf(() => validateAgentBudget({ ...budget(), maxSteps: 0 })), 'AGENT_BUDGET_INVALID');
  assert.equal(codeOf(() => validateAgentBudget({ ...budget(), maxSteps: 1.5 })), 'AGENT_BUDGET_INVALID');
  assert.equal(
    codeOf(() => validateAgentBudget({ ...budget(), maxInputBytes: AGENT_BUDGET_LIMITS.maxInputBytes + 1 })),
    'AGENT_BUDGET_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentBudget({ ...budget(), deadlineMs: AGENT_BUDGET_LIMITS.deadlineMs + 1 })),
    'AGENT_BUDGET_INVALID',
  );
  const ok = validateAgentBudget(budget());
  assert.equal(ok.maxSteps, 4);
});

test('UT-AGT-007: provenance must be present and inside the declared scope', () => {
  assert.equal(codeOf(() => validateAgentRequest(baseRequest({ inputs: [] }))), 'AGENT_PROVENANCE_REQUIRED');
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({
      inputs: [{
        kind: 'file',
        ref: 'tests/other.spec.ts',
        digest: sha('x'),
        content: 'x',
      }],
    }))),
    'AGENT_PROVENANCE_OUT_OF_SCOPE',
  );
});

test('UT-AGT-008: provenance digest must be a sha256 hex digest', () => {
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({
      inputs: [{ kind: 'file', ref: 'tests/login.spec.ts', digest: 'not-a-digest', content: 'x' }],
    }))),
    'AGENT_PROVENANCE_INVALID',
  );
});

test('UT-AGT-009: a request asking for a forbidden capability is rejected', () => {
  for (const capability of ['write_source', 'git_commit', 'update_expected', 'approve_proposal']) {
    assert.equal(
      codeOf(() => validateAgentRequest(baseRequest({ requestedCapabilities: [capability] }))),
      'AGENT_CAPABILITY_FORBIDDEN',
      `${capability} must be rejected`,
    );
  }
});

test('UT-AGT-010: an unknown contract version is rejected', () => {
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({ contract: 'agent-contract/v2' }))),
    'AGENT_CONTRACT_UNSUPPORTED',
  );
});

test('UT-AGT-011: an unknown role is rejected', () => {
  assert.equal(codeOf(() => validateAgentRequest(baseRequest({ role: 'executor' }))), 'AGENT_ROLE_UNKNOWN');
});

test('UT-AGT-012: a request cannot claim a capability its role does not grant', () => {
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({
      role: 'triage',
      requestedCapabilities: ['propose_script_diff'],
    }))),
    'AGENT_CAPABILITY_NOT_GRANTED',
  );
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({
      role: 'planner',
      requestedCapabilities: ['propose_script_diff'],
    }))),
    'AGENT_CAPABILITY_NOT_GRANTED',
  );
});

test('UT-AGT-013: a diff targeting a file outside scope.outputs is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = [
    '--- a/tests/other.spec.ts',
    '+++ b/tests/other.spec.ts',
    '@@ -1 +1 @@',
    "-test('other', async ({page}) => {});",
    "+test('other', async ({page}) => { await page.goto('/'); });",
  ].join('\n');
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-014: a diff targeting a non test-script file is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = [
    '--- a/playwright.config.ts',
    '+++ b/playwright.config.ts',
    '@@ -1 +1 @@',
    '-export default {}',
    '+export default { retries: 3 }',
  ].join('\n');
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-015: a diff escaping the project root is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = [
    '--- a/../../../etc/outside.spec.ts',
    '+++ b/../../../etc/outside.spec.ts',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n');
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-016: scope.outputs cannot declare a path outside the project root', () => {
  assert.equal(
    codeOf(() => validateAgentScope({ ...scope(), outputs: ['../outside.spec.ts'] })),
    'AGENT_SCOPE_ESCAPE',
  );
});

test('UT-AGT-017: the approval state of a proposal is always pending', () => {
  const request = validateAgentRequest(baseRequest());
  const proposal = validateAgentProposal({
    summary: 'add a goto',
    approval: 'approved',
    producedBy: 'model-x',
    diff: [
      '--- a/tests/login.spec.ts',
      '+++ b/tests/login.spec.ts',
      '@@ -1 +1 @@',
      "-test('login passes', async ({page}) => {});",
      "+test('login passes', async ({page}) => { await page.goto('/'); });",
    ].join('\n'),
    evidenceRefs: ['tests/login.spec.ts'],
  }, request, { producedBy: 'adapter-x' });
  assert.equal(proposal.approval, 'pending');
  assert.equal(proposal.producedBy, 'adapter-x');
  assert.equal(proposal.kind, 'script-diff');
});

test('UT-AGT-018: a script-diff proposal must cite provenance evidence', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = [
    '--- a/tests/login.spec.ts',
    '+++ b/tests/login.spec.ts',
    '@@ -1 +1 @@',
    "-test('login passes', async ({page}) => {});",
    "+test('login passes', async ({page}) => { await page.goto('/'); });",
  ].join('\n');
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff }, request)),
    'AGENT_PROPOSAL_INVALID',
  );
});

test('UT-AGT-019: the producer may not review its own proposal', () => {
  const request = validateAgentRequest(baseRequest());
  const proposal = validateAgentProposal({
    summary: 'x',
    diff: [
      '--- a/tests/login.spec.ts',
      '+++ b/tests/login.spec.ts',
      '@@ -1 +1 @@',
      "-test('login passes', async ({page}) => {});",
      "+test('login passes', async ({page}) => { await page.goto('/'); });",
    ].join('\n'),
    evidenceRefs: ['tests/login.spec.ts'],
  }, request, { producedBy: 'adapter-x' });
  assert.equal(
    codeOf(() => reviewAgentProposal(proposal, { reviewer: 'adapter-x', decision: 'approved' })),
    'AGENT_REVIEW_SELF_FORBIDDEN',
  );
  const approved = reviewAgentProposal(proposal, { reviewer: 'reviewer-y', decision: 'approved' });
  assert.equal(approved.approval, 'approved');
  assert.equal(approved.reviewedBy, 'reviewer-y');
});

test('UT-AGT-020: only a pending proposal can be reviewed', () => {
  const request = validateAgentRequest(baseRequest());
  const proposal = validateAgentProposal({
    summary: 'x',
    diff: [
      '--- a/tests/login.spec.ts',
      '+++ b/tests/login.spec.ts',
      '@@ -1 +1 @@',
      "-test('login passes', async ({page}) => {});",
      "+test('login passes', async ({page}) => { await page.goto('/'); });",
    ].join('\n'),
    evidenceRefs: ['tests/login.spec.ts'],
  }, request, { producedBy: 'adapter-x' });
  const approved = reviewAgentProposal(proposal, { reviewer: 'reviewer-y', decision: 'approved' });
  assert.equal(
    codeOf(() => reviewAgentProposal(approved, { reviewer: 'reviewer-z', decision: 'rejected' })),
    'AGENT_REVIEW_STATE_INVALID',
  );
});

test('UT-AGT-021: the adapter rejects a forbidden capability at construction time', () => {
  const provider = createModelProvider({ id: 'p', complete: async () => ({ text: '{}' }) });
  assert.equal(
    codeOf(() => createAgentAdapter({
      adapterId: 'a', role: 'generator', capabilities: ['write_source'], provider,
    })),
    'AGENT_CAPABILITY_FORBIDDEN',
  );
});

test('UT-AGT-022: the adapter rejects a capability the role does not grant', () => {
  const provider = createModelProvider({ id: 'p', complete: async () => ({ text: '{}' }) });
  assert.equal(
    codeOf(() => createAgentAdapter({
      adapterId: 'a', role: 'triage', capabilities: ['propose_script_diff'], provider,
    })),
    'AGENT_CAPABILITY_NOT_GRANTED',
  );
});

test('UT-AGT-023: the adapter rejects a request whose role it does not serve', async () => {
  const provider = createModelProvider({ id: 'p', complete: async () => ({ text: '{}' }) });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  await assert.rejects(
    () => adapter.execute(baseRequest({ role: 'triage', requestedCapabilities: [] })),
    (error) => error.code === 'AGENT_ROLE_MISMATCH',
  );
});

test('UT-AGT-024: the adapter rejects input whose content does not match its digest', async () => {
  const provider = createModelProvider({ id: 'p', complete: async () => ({ text: '{}' }) });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  await assert.rejects(
    () => adapter.execute(baseRequest({
      inputs: [{
        kind: 'file',
        ref: 'tests/login.spec.ts',
        digest: sha('the real content'),
        content: 'something else',
      }],
    })),
    (error) => error.code === 'AGENT_PROVENANCE_DIGEST_MISMATCH',
  );
});

test('UT-AGT-025: the adapter rejects provider output that is not JSON', async () => {
  const provider = createModelProvider({ id: 'p', complete: async () => ({ text: 'not json' }) });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  await assert.rejects(
    () => adapter.execute(baseRequest()),
    (error) => error.code === 'AGENT_PROVIDER_OUTPUT_INVALID',
  );
});

test('UT-AGT-026: the adapter rejects provider output larger than the budget', async () => {
  const provider = createModelProvider({ id: 'p', complete: async () => ({ text: 'x'.repeat(200_000) }) });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  await assert.rejects(
    () => adapter.execute(baseRequest()),
    (error) => error.code === 'AGENT_BUDGET_EXCEEDED',
  );
});

test('UT-AGT-027: inputs outside the declared egress kinds are not transmitted', async () => {
  let seen = null;
  const provider = createModelProvider({
    id: 'p',
    complete: async (request) => {
      seen = request;
      return {
        text: JSON.stringify({
          summary: 'ok',
          diff: [
            '--- a/tests/login.spec.ts',
            '+++ b/tests/login.spec.ts',
            '@@ -1 +1 @@',
            "-test('login passes', async ({page}) => {});",
            "+test('login passes', async ({page}) => { await page.goto('/'); });",
          ].join('\n'),
          evidenceRefs: ['tests/login.spec.ts'],
        }),
      };
    },
  });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  const result = await adapter.execute(baseRequest({ egress: { kinds: [] } }));
  assert.deepEqual(seen.inputs, []);
  assert.deepEqual(result.usage.transmittedRefs, []);
  assert.equal(result.proposal.approval, 'pending');
});

test('UT-AGT-028: the described contract exposes no writable capability', () => {
  const described = describeAgentContract();
  assert.equal(described.contract, AGENT_CONTRACT_VERSION);
  assert.ok(described.forbiddenCapabilities.includes('write_source'));
  assert.deepEqual(described.proposalStates, ['pending', 'approved', 'rejected']);
  for (const role of described.roles) {
    for (const capability of role.capabilities) {
      assert.equal(described.forbiddenCapabilities.includes(capability), false);
    }
  }
});
