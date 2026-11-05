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

/* ================================================================== */
/* ATS-401 第 1 次复核驳回后补齐的用例                                  */
/* 每个用例都对应一条复核意见里指出的「零覆盖分支」。                  */
/* ================================================================== */

const LEGIT_HUNK = [
  'diff --git a/tests/login.spec.ts b/tests/login.spec.ts',
  '--- a/tests/login.spec.ts',
  '+++ b/tests/login.spec.ts',
  '@@ -1 +1 @@',
  "-test('login passes', async ({page}) => {});",
  "+test('login passes', async ({page}) => { await page.goto('/'); });",
].join('\n');

test('UT-AGT-029: a diff that renames a file out of the scope is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = `${LEGIT_HUNK}\ndiff --git a/server/index.mjs b/server/pwned.mjs\nsimilarity index 100%\nrename from server/index.mjs\nrename to server/pwned.mjs\n`;
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-030: a diff that copies a file out of the scope is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/server/copied.mjs\nsimilarity index 100%\ncopy from tests/login.spec.ts\ncopy to server/copied.mjs\n`;
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-031: a diff that changes a file mode is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = `${LEGIT_HUNK}\ndiff --git a/start.sh b/start.sh\nold mode 100644\nnew mode 100755\n`;
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-032: a CRLF-terminated diff header is still scope-checked', () => {
  const request = validateAgentRequest(baseRequest());
  // Built from char codes so the CR really lands in the string literal.
  const CR = String.fromCharCode(13);
  const crlfDiff = [
    LEGIT_HUNK,
    'diff --git a/server/index.mjs b/server/index.mjs' + CR,
    '--- a/server/index.mjs' + CR,
    '+++ b/server/index.mjs' + CR,
    '@@ -1 +1 @@' + CR,
    '-x' + CR,
    '+y' + CR,
  ].join('\n');
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: crlfDiff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-033: a binary patch is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = `${LEGIT_HUNK}\ndiff --git a/server/evil.mjs b/server/evil.mjs\nnew file mode 100644\nindex 0000000..1234567\nGIT binary patch\nliteral 12\nzcmZQzU|?V=+\n`;
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-034: a Binary files ... differ section is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = `${LEGIT_HUNK}\ndiff --git a/server/index.mjs b/server/index.mjs\nBinary files a/server/index.mjs and b/server/index.mjs differ\n`;
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-035: a diff --git header naming an out-of-scope file is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = `${LEGIT_HUNK}\ndiff --git a/server/index.mjs b/server/index.mjs\n`;
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-036: a new test script inside scope.outputs is accepted', () => {
  const request = validateAgentRequest(baseRequest({
    scope: { ...scope(), outputs: ['tests/login.spec.ts', 'tests/new.spec.ts'] },
  }));
  const diff = [
    'diff --git a/tests/new.spec.ts b/tests/new.spec.ts',
    'new file mode 100644',
    'index 0000000..1234567',
    '--- /dev/null',
    '+++ b/tests/new.spec.ts',
    '@@ -0,0 +1 @@',
    "+test('new', async ({page}) => {});",
  ].join('\n');
  const proposal = validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request, { producedBy: 'adapter-x' });
  assert.equal(proposal.kind, 'script-diff');
});

test('UT-AGT-037: a deleted file section is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/tests/login.spec.ts\ndeleted file mode 100644\n`;
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-038: a non-100644 new file mode is rejected', () => {
  const request = validateAgentRequest(baseRequest({
    scope: { ...scope(), outputs: ['tests/login.spec.ts', 'tests/new.spec.ts'] },
  }));
  const diff = [
    'diff --git a/tests/new.spec.ts b/tests/new.spec.ts',
    'new file mode 100755',
    'index 0000000..1234567',
    '--- /dev/null',
    '+++ b/tests/new.spec.ts',
    '@@ -0,0 +1 @@',
    "+test('new', async ({page}) => {});",
  ].join('\n');
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-039: the request validator rejects a digest that does not match the content', () => {
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({
      inputs: [{
        kind: 'file',
        ref: 'tests/login.spec.ts',
        digest: sha('something else'),
        content: "test('login passes', async ({page}) => {});\n",
      }],
    }))),
    'AGENT_PROVENANCE_DIGEST_MISMATCH',
  );
});

test('UT-AGT-040: the budget limits are enforced on every field', () => {
  assert.equal(
    codeOf(() => validateAgentBudget({ ...budget(), maxOutputBytes: AGENT_BUDGET_LIMITS.maxOutputBytes + 1 })),
    'AGENT_BUDGET_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentBudget({ ...budget(), maxSteps: AGENT_BUDGET_LIMITS.maxSteps + 1 })),
    'AGENT_BUDGET_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentBudget({ ...budget(), deadlineMs: AGENT_BUDGET_LIMITS.minDeadlineMs - 1 })),
    'AGENT_BUDGET_INVALID',
  );
  assert.equal(codeOf(() => validateAgentBudget({ ...budget(), maxTokens: 0 })), 'AGENT_BUDGET_INVALID');
  assert.equal(codeOf(() => validateAgentBudget({ ...budget(), maxTokens: 1.5 })), 'AGENT_BUDGET_INVALID');
  assert.equal(validateAgentBudget({ ...budget(), maxTokens: 8000 }).maxTokens, 8000);
});

test('UT-AGT-041: the adapter rejects input that exceeds the input byte budget', async () => {
  const provider = createModelProvider({ id: 'p', complete: async () => ({ text: '{}' }) });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  await assert.rejects(
    () => adapter.execute(baseRequest({
      budget: { ...budget(), maxInputBytes: 10 },
      egress: { kinds: ['file'] },
    })),
    (error) => error.code === 'AGENT_BUDGET_EXCEEDED',
  );
});

test('UT-AGT-042: the adapter enforces the deadline when the provider hangs', async () => {
  const provider = createModelProvider({ id: 'p', complete: () => new Promise(() => {}) });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  const startedAt = Date.now();
  await assert.rejects(
    () => adapter.execute(baseRequest({ budget: { ...budget(), deadlineMs: 1000 } })),
    (error) => error.code === 'AGENT_BUDGET_EXCEEDED',
  );
  // The call must end near the deadline, not hang until the provider settles.
  assert.ok(Date.now() - startedAt < 5000, 'the call must not wait for the hung provider');
});

test('UT-AGT-043: the adapter reports a provider failure as AGENT_PROVIDER_ERROR', async () => {
  const provider = createModelProvider({
    id: 'p',
    complete: async () => { throw new Error('boom'); },
  });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  await assert.rejects(
    () => adapter.execute(baseRequest()),
    (error) => error.code === 'AGENT_PROVIDER_ERROR' && error.details.cause === 'boom',
  );
});

test('UT-AGT-044: the adapter rejects a provider response without text', async () => {
  const provider = createModelProvider({ id: 'p', complete: async () => ({ nope: true }) });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  await assert.rejects(
    () => adapter.execute(baseRequest()),
    (error) => error.code === 'AGENT_PROVIDER_OUTPUT_INVALID',
  );
});

test('UT-AGT-045: the adapter passes an abort signal to the provider', async () => {
  let seenCtx = null;
  const provider = createModelProvider({
    id: 'p',
    complete: async (_request, ctx) => {
      seenCtx = ctx;
      return { text: JSON.stringify({ summary: 'ok', diff: LEGIT_HUNK, evidenceRefs: ['tests/login.spec.ts'] }) };
    },
  });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  await adapter.execute(baseRequest());
  assert.ok(seenCtx.signal, 'the provider context must carry an AbortSignal');
  assert.equal(typeof seenCtx.deadlineAt, 'number');
});

test('UT-AGT-046: proposal actions are validated', () => {
  const request = validateAgentRequest(baseRequest());
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: LEGIT_HUNK, actions: 'not-an-array', evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: LEGIT_HUNK, actions: [{ type: 'write_file' }], evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_INVALID',
  );
  const proposal = validateAgentProposal({
    summary: 'x',
    diff: LEGIT_HUNK,
    evidenceRefs: ['tests/login.spec.ts'],
    actions: [{ type: 'goto', target: '/login', value: 'v' }, { type: 'noop' }],
  }, request, { producedBy: 'adapter-x' });
  assert.equal(proposal.actions.length, 2);
  assert.equal(proposal.actions[0].type, 'goto');
  assert.equal(proposal.actions[0].target, '/login');
  assert.equal(proposal.actions[1].target, null);
});

test('UT-AGT-047: the proposal confidence must be a number between 0 and 1', () => {
  const request = validateAgentRequest(baseRequest());
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: LEGIT_HUNK, confidence: 1.5, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: LEGIT_HUNK, confidence: 'high', evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_INVALID',
  );
  const proposal = validateAgentProposal({ summary: 'x', diff: LEGIT_HUNK, confidence: 0.8, evidenceRefs: ['tests/login.spec.ts'] }, request, { producedBy: 'adapter-x' });
  assert.equal(proposal.confidence, 0.8);
});

test('UT-AGT-048: evidence-kind provenance must belong to scope.runs', () => {
  const runId = 'run_00000000-0000-0000-0000-000000000000';
  const request = validateAgentRequest(baseRequest({
    scope: { ...scope(), runs: [runId] },
    inputs: [{
      kind: 'evidence',
      ref: `${runId}/screenshot.png`,
      digest: sha('png'),
      content: 'png',
    }],
  }));
  assert.equal(request.inputs[0].kind, 'evidence');
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({
      scope: { ...scope(), runs: [runId] },
      inputs: [{
        kind: 'evidence',
        ref: 'run_11111111-1111-1111-1111-111111111111/screenshot.png',
        digest: sha('png'),
        content: 'png',
      }],
    }))),
    'AGENT_PROVENANCE_OUT_OF_SCOPE',
  );
});

test('UT-AGT-049: evidence refs must come from the request provenance', () => {
  const request = validateAgentRequest(baseRequest());
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: LEGIT_HUNK, evidenceRefs: ['tests/other.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-050: the contract layer source contains no I/O capability', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const source = fs.readFileSync(
    path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'server', 'agent.mjs'),
    'utf8',
  );
  const { analyzeContractPurity } = await import('../tools/ats401-probes/lib/contract-purity.mjs');
  const analysis = analyzeContractPurity(source);
  assert.deepEqual(analysis.forbiddenModules, []);
  assert.deepEqual(analysis.forbiddenGlobals, []);
  assert.equal(analysis.pure, true);
});


test('UT-AGT-051: the scope projectId must be a non-empty string', () => {
  assert.equal(codeOf(() => validateAgentScope({ ...scope(), projectId: '' })), 'AGENT_SCOPE_INVALID');
  assert.equal(codeOf(() => validateAgentScope({ ...scope(), projectId: 42 })), 'AGENT_SCOPE_INVALID');
  assert.equal(codeOf(() => validateAgentScope({ ...scope(), projectId: 'x'.repeat(201) })), 'AGENT_SCOPE_INVALID');
});


test('UT-AGT-052: every provenance field is validated', () => {
  const bad = (input) => codeOf(() => validateAgentRequest(baseRequest({ inputs: [input] })));
  assert.equal(bad({ kind: 'nope', ref: 'tests/login.spec.ts', digest: sha('x'), content: 'x' }), 'AGENT_PROVENANCE_INVALID');
  assert.equal(bad({ kind: 'file', ref: '', digest: sha('x'), content: 'x' }), 'AGENT_PROVENANCE_INVALID');
  assert.equal(bad({ kind: 'file', ref: 'tests/login.spec.ts', digest: sha('x'), content: 42 }), 'AGENT_PROVENANCE_INVALID');
  assert.equal(
    bad({ kind: 'file', ref: 'tests/login.spec.ts', digest: sha('x'), content: 'x', retrievedAt: 'not-a-date' }),
    'AGENT_PROVENANCE_INVALID',
  );
});


test('UT-AGT-053: run and requirement provenance must be in the scope', () => {
  const runId = 'run_00000000-0000-0000-0000-000000000000';
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({
      scope: { ...scope(), runs: [runId] },
      inputs: [{ kind: 'run', ref: 'run_99999999-9999-9999-9999-999999999999', digest: sha('x'), content: 'x' }],
    }))),
    'AGENT_PROVENANCE_OUT_OF_SCOPE',
  );
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({
      scope: { ...scope(), requirements: ['REQ-001'] },
      inputs: [{ kind: 'requirement', ref: 'REQ-999', digest: sha('x'), content: 'x' }],
    }))),
    'AGENT_PROVENANCE_OUT_OF_SCOPE',
  );
});


test('UT-AGT-054: the requested capabilities and the egress kinds are validated', () => {
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({ requestedCapabilities: 'read_test_index' }))),
    'AGENT_REQUEST_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({
      requestedCapabilities: Array.from({ length: 17 }, () => 'read_test_index'),
    }))),
    'AGENT_REQUEST_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({ requestedCapabilities: [''] }))),
    'AGENT_REQUEST_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({ egress: { kinds: ['nope'] } }))),
    'AGENT_REQUEST_INVALID',
  );
});


test('UT-AGT-055: a quoted diff path is accepted and a long request id is rejected', () => {
  assert.equal(
    codeOf(() => validateAgentRequest(baseRequest({ id: 'x'.repeat(201) }))),
    'AGENT_REQUEST_INVALID',
  );
  const request = validateAgentRequest(baseRequest());
  // git quotes paths that contain unusual characters; the quoted form must be
  // unquoted before the scope check, otherwise it would never match.
  const quotedDiff = [
    '--- "a/tests/login.spec.ts"',
    '+++ "b/tests/login.spec.ts"',
    '@@ -1 +1 @@',
    "-test('login passes', async ({page}) => {});",
    "+test('login passes', async ({page}) => { await page.goto('/'); });",
  ].join('\n');
  const proposal = validateAgentProposal({ summary: 'x', diff: quotedDiff, evidenceRefs: ['tests/login.spec.ts'] }, request, { producedBy: 'adapter-x' });
  assert.equal(proposal.kind, 'script-diff');
});


test('UT-AGT-056: the diff argument itself is validated', () => {
  const request = validateAgentRequest(baseRequest());
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: 42, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: '   ', evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: 'x'.repeat(1_000_001), evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: 'not a unified diff', evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_INVALID',
  );
});

test('UT-AGT-057: a non-script-diff proposal must not carry a diff', () => {
  const planner = validateAgentRequest(baseRequest({
    role: 'planner',
    requestedCapabilities: ['read_requirements'],
  }));
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: LEGIT_HUNK }, planner)),
    'AGENT_PROPOSAL_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', kind: 'script-diff' }, planner)),
    'AGENT_PROPOSAL_INVALID',
  );
});

test('UT-AGT-058: an absolute diff target is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = [
    '--- /etc/passwd',
    '+++ /etc/passwd',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n');
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-059: the evidence refs argument is validated', () => {
  const request = validateAgentRequest(baseRequest());
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: LEGIT_HUNK, evidenceRefs: [''] }, request)),
    'AGENT_PROPOSAL_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: LEGIT_HUNK, evidenceRefs: Array.from({ length: 65 }, () => 'tests/login.spec.ts') }, request)),
    'AGENT_PROPOSAL_INVALID',
  );
});

test('UT-AGT-060: the proposal must be an object and its kind must match the role', () => {
  const request = validateAgentRequest(baseRequest());
  assert.equal(codeOf(() => validateAgentProposal('not-an-object', request)), 'AGENT_PROPOSAL_INVALID');
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', kind: 'diagnosis', diff: LEGIT_HUNK }, request)),
    'AGENT_PROPOSAL_INVALID',
  );
});

test('UT-AGT-061: a proposal that needs a capability the request does not grant is rejected', () => {
  const request = validateAgentRequest(baseRequest({ requestedCapabilities: [] }));
  assert.equal(
    codeOf(() => validateAgentProposal({ summary: 'x', diff: LEGIT_HUNK, evidenceRefs: ['tests/login.spec.ts'] }, request)),
    'AGENT_CAPABILITY_NOT_GRANTED',
  );
});

test('UT-AGT-062: the provider and the adapter constructors are validated', () => {
  assert.equal(codeOf(() => createModelProvider({ id: '', complete: async () => ({ text: '' }) })), 'AGENT_PROVIDER_INVALID');
  assert.equal(codeOf(() => createModelProvider({ id: 'p', complete: 'nope' })), 'AGENT_PROVIDER_INVALID');
  const provider = createModelProvider({ id: 'p', complete: async () => ({ text: '{}' }) });
  assert.equal(codeOf(() => createAgentAdapter({ adapterId: '', role: 'generator', provider })), 'AGENT_REQUEST_INVALID');
  assert.equal(codeOf(() => createAgentAdapter({ adapterId: 'a', role: 'executor', provider })), 'AGENT_ROLE_UNKNOWN');
  assert.equal(codeOf(() => createAgentAdapter({ adapterId: 'a', role: 'generator', capabilities: 'x', provider })), 'AGENT_CAPABILITY_NOT_GRANTED');
  assert.equal(codeOf(() => createAgentAdapter({ adapterId: 'a', role: 'generator', provider: null })), 'AGENT_PROVIDER_INVALID');
});

test('UT-AGT-063: the adapter refuses a capability it does not hold', async () => {
  const provider = createModelProvider({ id: 'p', complete: async () => ({ text: '{}' }) });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  await assert.rejects(
    () => adapter.execute(baseRequest({ requestedCapabilities: ['propose_script_diff', 'read_test_index'] })),
    (error) => error.code === 'AGENT_CAPABILITY_NOT_GRANTED',
  );
});

test('UT-AGT-064: the adapter describes itself', () => {
  const provider = createModelProvider({ id: 'p', complete: async () => ({ text: '{}' }) });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  const described = adapter.describe();
  assert.equal(described.adapterId, 'a');
  assert.equal(described.role, 'generator');
  assert.equal(described.outputKind, 'script-diff');
  assert.deepEqual(described.capabilities, ['propose_script_diff']);
});

test('UT-AGT-065: the review arguments are validated', () => {
  const request = validateAgentRequest(baseRequest());
  const proposal = validateAgentProposal(
    { summary: 'x', diff: LEGIT_HUNK, evidenceRefs: ['tests/login.spec.ts'] },
    request,
    { producedBy: 'adapter-x' },
  );
  assert.equal(codeOf(() => reviewAgentProposal('not-an-object', { reviewer: 'r', decision: 'approved' })), 'AGENT_REVIEW_STATE_INVALID');
  assert.equal(codeOf(() => reviewAgentProposal(proposal, { reviewer: '', decision: 'approved' })), 'AGENT_REVIEWER_INVALID');
  assert.equal(codeOf(() => reviewAgentProposal(proposal, { reviewer: 'r', decision: 'maybe' })), 'AGENT_REVIEW_STATE_INVALID');
});

test('UT-AGT-066: a provider that fails after the deadline is reported as a budget failure', async () => {
  const provider = createModelProvider({
    id: 'p',
    complete: () => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('late failure')), 50);
    }),
  });
  const adapter = createAgentAdapter({
    adapterId: 'a', role: 'generator', capabilities: ['propose_script_diff'], provider,
  });
  await assert.rejects(
    () => adapter.execute(baseRequest({ budget: { ...budget(), deadlineMs: 1000 } })),
    (error) => error.code === 'AGENT_PROVIDER_ERROR',
  );
});


test('UT-AGT-067: the self-review check is not an exact string comparison', () => {
  const request = validateAgentRequest(baseRequest());
  const proposal = validateAgentProposal(
    { summary: 'x', diff: LEGIT_HUNK, evidenceRefs: ['tests/login.spec.ts'] },
    request,
    { producedBy: 'gen-1' },
  );
  for (const who of ['gen-1', 'gen-1 ', ' GEN-1', 'Gen-1']) {
    assert.equal(
      codeOf(() => reviewAgentProposal(proposal, { reviewer: who, decision: 'approved' })),
      'AGENT_REVIEW_SELF_FORBIDDEN',
      `"${who}" must not be able to review its own proposal`,
    );
  }
  const approved = reviewAgentProposal(proposal, { reviewer: 'reviewer-y', decision: 'approved' });
  assert.equal(approved.approval, 'approved');
});

test('UT-AGT-068: a proposal without a platform-supplied producer is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  assert.equal(
    codeOf(() => validateAgentProposal(
      { summary: 'x', diff: LEGIT_HUNK, evidenceRefs: ['tests/login.spec.ts'] },
      request,
    )),
    'AGENT_PROPOSAL_INVALID',
  );
  assert.equal(
    codeOf(() => validateAgentProposal(
      { summary: 'x', diff: LEGIT_HUNK, evidenceRefs: ['tests/login.spec.ts'] },
      request,
      { producedBy: '   ' },
    )),
    'AGENT_PROPOSAL_INVALID',
  );
});


/* ================================================================== */
/* 第 2 次复核的反例（ATS-401）                                         */
/*                                                                    */
/* 第 1 轮的 diff 校验是**黑名单**（逐一列举已知的危险构造）。第 2 次 */
/* 复核证明了黑名单追不上 git 的解析器：git apply 仍然接受清单里没有  */
/* 的写法（旧式 `rename old/new` 头就是一个实例）。第 2 轮整改改为    */
/* **白名单语法**——只有明确列出的头部形式被接受。下面这些用例把复核   */
/* 提交的反例固定成可重跑的断言。                                     */
/* ================================================================== */

test('UT-AGT-069: the legacy "rename old/new" headers cannot bypass the scope check', () => {
  const request = validateAgentRequest(baseRequest());
  // `git apply` honours these headers (verified with git 2.55.0), so a
  // blacklist that does not name them lets a rename out of scope through.
  const diff = `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/tests/login.spec.ts\nrename old server/index.mjs\nrename new server/pwned.mjs\n`;
  assert.equal(
    codeOf(() => validateAgentProposal(
      { summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] },
      request,
      { producedBy: 'adapter-x' },
    )),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-070: a C-quoted diff --git header cannot bypass the scope check', () => {
  const request = validateAgentRequest(baseRequest());
  // The quoted header names two DIFFERENT paths, so it is not a plain
  // modification of an in-scope file. It is appended to a legitimate hunk so
  // that the diff as a whole is a valid unified diff -- otherwise the
  // "not a unified diff" check would reject it for an unrelated reason and
  // the whitelist would never be exercised.
  const quoted = `${LEGIT_HUNK}\ndiff --git "a/tests/login.spec.ts" "b/server/evil.mjs"\nnew file mode 100644\n`;
  assert.equal(
    codeOf(() => validateAgentProposal(
      { summary: 'x', diff: quoted, evidenceRefs: ['tests/login.spec.ts'] },
      request,
      { producedBy: 'adapter-x' },
    )),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
  // On its own the segment has no hunk at all, so it is rejected too (the
  // exact code differs; what matters is that it never reaches a proposal).
  const standalone = [
    'diff --git "a/tests/login.spec.ts" "b/server/evil.mjs"',
    'new file mode 100644',
  ].join('\n');
  assert.notEqual(
    codeOf(() => validateAgentProposal(
      { summary: 'x', diff: standalone, evidenceRefs: ['tests/login.spec.ts'] },
      request,
      { producedBy: 'adapter-x' },
    )),
    null,
    'a C-quoted header naming an out-of-scope file must be rejected',
  );
});

test('UT-AGT-071: the diff header whitelist rejects the constructs outside it', () => {
  const request = validateAgentRequest(baseRequest());
  const rejected = [
    ['a context diff header', '*** a/tests/login.spec.ts'],
    ['a similarity index', 'similarity index 90%'],
    ['a dissimilarity index', 'dissimilarity index 90%'],
    ['an Index: header', 'Index: tests/login.spec.ts'],
    ['a copy header', 'copy from tests/login.spec.ts'],
    ['a binary patch', 'GIT binary patch'],
    ['a Binary files line', 'Binary files a/x and b/x differ'],
    ['an old mode line', 'old mode 100644'],
    ['a new mode line', 'new mode 100755'],
    ['a deleted file mode', 'deleted file mode 100644'],
  ];
  for (const [label, line] of rejected) {
    const diff = `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/tests/login.spec.ts\n${line}\n`;
    assert.equal(
      codeOf(() => validateAgentProposal(
        { summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] },
        request,
        { producedBy: 'adapter-x' },
      )),
      'AGENT_PROPOSAL_OUT_OF_SCOPE',
      `${label} must be rejected`,
    );
  }
});

test('UT-AGT-072: a hunk whose declared line count does not match its body is rejected', () => {
  const request = validateAgentRequest(baseRequest());
  const diff = [
    'diff --git a/tests/login.spec.ts b/tests/login.spec.ts',
    '--- a/tests/login.spec.ts',
    '+++ b/tests/login.spec.ts',
    '@@ -1,5 +1,5 @@',
    "-test('login passes', async ({page}) => {});",
    "+test('login passes', async ({page}) => { await page.goto('/'); });",
  ].join('\n');
  assert.equal(
    codeOf(() => validateAgentProposal(
      { summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] },
      request,
      { producedBy: 'adapter-x' },
    )),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});

test('UT-AGT-073: the diff --git header may be omitted, and a quoted path is unescaped', () => {
  const request = validateAgentRequest(baseRequest());
  // `git apply` accepts a bare unified diff, so the header is optional.
  const bare = [
    '--- a/tests/login.spec.ts',
    '+++ b/tests/login.spec.ts',
    '@@ -1 +1 @@',
    "-test('login passes', async ({page}) => {});",
    "+test('login passes', async ({page}) => { await page.goto('/'); });",
  ].join('\n');
  assert.equal(
    codeOf(() => validateAgentProposal(
      { summary: 'x', diff: bare, evidenceRefs: ['tests/login.spec.ts'] },
      request,
      { producedBy: 'adapter-x' },
    )),
    null,
  );
  // A quoted path is unescaped with git's own C-style rules before the
  // scope check; an invalid escape is rejected rather than guessed.
  const quoted = [
    '--- "a/tests/login.spec.ts"',
    '+++ "b/tests/login.spec.ts"',
    '@@ -1 +1 @@',
    "-test('login passes', async ({page}) => {});",
    "+test('login passes', async ({page}) => { await page.goto('/'); });",
  ].join('\n');
  assert.equal(
    codeOf(() => validateAgentProposal(
      { summary: 'x', diff: quoted, evidenceRefs: ['tests/login.spec.ts'] },
      request,
      { producedBy: 'adapter-x' },
    )),
    null,
  );
  const brokenEscape = [
    '--- "a/tests/login.spec\q"',
    '+++ "b/tests/login.spec\q"',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n');
  assert.equal(
    codeOf(() => validateAgentProposal(
      { summary: 'x', diff: brokenEscape, evidenceRefs: ['tests/login.spec.ts'] },
      request,
      { producedBy: 'adapter-x' },
    )),
    'AGENT_PROPOSAL_OUT_OF_SCOPE',
  );
});
