#!/usr/bin/env node
/**
 * ATS-401 probe -- the regressions found by the 1st review round.
 *
 * The reviewer submitted three repro scripts as attachments. Each of them
 * demonstrated a way to get past a boundary that the delivery claimed to
 * enforce. This probe encodes those counterexamples as assertions, so the
 * fix is re-checkable in the repository instead of only in a review thread.
 *
 * The counterexamples, and what each one now expects:
 *
 *   A. diff-target scope bypass
 *      - a rename section moving a file out of scope
 *      - a copy section
 *      - a mode change
 *      - a CRLF-terminated header section (the CR made the old scanner skip
 *        the whole line)
 *      - a GIT binary patch
 *      -> all rejected with AGENT_PROPOSAL_OUT_OF_SCOPE
 *
 *   B. the I/O detector only matched `from '...'`
 *      - process.getBuiltinModule('node:fs')
 *      - a bare global fetch()
 *      - a dynamic import('node:child_process')
 *      - a double-quoted `from "node:fs"`
 *      -> all detected by the purity scanner
 *
 *   C. the validate endpoint did not recompute the digest
 *      -> a digest mismatch is now rejected at the request-validation layer,
 *         so the API and the adapter agree
 *
 *   D. the deadline was only checked after the provider returned
 *      -> a hung provider now ends the call at the deadline
 *
 *   E. the error mapping applied to every error with a `code`
 *      -> only AGENT_* errors are remapped; the rest keep the old behaviour
 *
 * Usage: node tools/ats401-probes/probe-review-regressions.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createAgentAdapter,
  createModelProvider,
  reviewAgentProposal,
  validateAgentProposal,
  validateAgentRequest,
} from '../../server/agent.mjs';
import { analyzeContractPurity } from './lib/contract-purity.mjs';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..');
const WORK_ROOT = path.resolve(
  process.env.ATS_PROBE_WORKDIR || path.join(process.env.TMPDIR || os.tmpdir(), 'ats401-review-regressions'),
);
const CR = String.fromCharCode(13);

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const failures = [];
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

/** The code of the error a call throws, or null when it does not throw. */
function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

console.log('=== ATS-401 probe: 1st-review-round regressions ===');
console.log(`repo root : ${REPO_ROOT}`);
console.log(`work root : ${WORK_ROOT}`);
console.log('');

/* ------------------------------------------------------------------ */
console.log('--- A. the diff-target scope cannot be bypassed ---');

const fixture = path.join(WORK_ROOT, 'fixture-repo');
fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
const SPEC = "test('login passes', async ({page}) => {});\n";
fs.writeFileSync(path.join(fixture, 'tests', 'login.spec.ts'), SPEC);

const LEGIT_HUNK = [
  'diff --git a/tests/login.spec.ts b/tests/login.spec.ts',
  '--- a/tests/login.spec.ts',
  '+++ b/tests/login.spec.ts',
  '@@ -1 +1 @@',
  "-test('login passes', async ({page}) => {});",
  "+test('login passes', async ({page}) => { await page.goto('/login'); });",
].join('\n');

const request = validateAgentRequest({
  role: 'generator',
  scope: {
    projectId: 'proj_review',
    root: fixture,
    files: ['tests/login.spec.ts'],
    outputs: ['tests/login.spec.ts'],
    runs: [],
    requirements: [],
  },
  budget: { maxInputBytes: 100000, maxOutputBytes: 100000, maxSteps: 4, deadlineMs: 30000 },
  requestedCapabilities: ['propose_script_diff'],
  inputs: [{
    kind: 'file',
    ref: 'tests/login.spec.ts',
    digest: sha(SPEC),
    content: SPEC,
    retrievedAt: '2026-11-04T00:00:00.000Z',
  }],
});

const bypasses = [
  ['a rename section moving a file out of scope',
    `${LEGIT_HUNK}\ndiff --git a/server/index.mjs b/server/pwned.mjs\nsimilarity index 100%\nrename from server/index.mjs\nrename to server/pwned.mjs\n`],
  ['a copy section',
    `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/server/copied.mjs\nsimilarity index 100%\ncopy from tests/login.spec.ts\ncopy to server/copied.mjs\n`],
  ['a mode change',
    `${LEGIT_HUNK}\ndiff --git a/start.sh b/start.sh\nold mode 100644\nnew mode 100755\n`],
  ['a CRLF-terminated header section',
    [LEGIT_HUNK,
      'diff --git a/server/index.mjs b/server/index.mjs' + CR,
      '--- a/server/index.mjs' + CR,
      '+++ b/server/index.mjs' + CR,
      '@@ -1 +1 @@' + CR,
      '-x' + CR,
      '+y' + CR].join('\n')],
  ['a GIT binary patch',
    `${LEGIT_HUNK}\ndiff --git a/server/evil.mjs b/server/evil.mjs\nnew file mode 100644\nindex 0000000..1234567\nGIT binary patch\nliteral 12\nzcmZQzU|?V=+\n`],
  ['a Binary files ... differ section',
    `${LEGIT_HUNK}\ndiff --git a/server/index.mjs b/server/index.mjs\nBinary files a/server/index.mjs and b/server/index.mjs differ\n`],
  ['a diff --git header naming an out-of-scope file',
    `${LEGIT_HUNK}\ndiff --git a/server/index.mjs b/server/index.mjs\n`],
];
for (const [label, diff] of bypasses) {
  const code = codeOf(() => validateAgentProposal(
    { summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] },
    request,
  ));
  check(`${label} is rejected`, code === 'AGENT_PROPOSAL_OUT_OF_SCOPE', `code=${code}`);
}

/* ------------------------------------------------------------------ */
console.log('');
console.log('--- B. the I/O detector covers the four spellings the review found ---');
const agentSource = fs.readFileSync(path.join(REPO_ROOT, 'server', 'agent.mjs'), 'utf8');
const detectorCases = [
  ['process.getBuiltinModule("node:fs")',
    `${agentSource}\nexport const w = (p, t) => process.getBuiltinModule('node:fs').writeFileSync(p, t);\n`],
  ['a bare global fetch()',
    `${agentSource}\nexport const f = (u) => fetch(u, { method: 'POST' });\n`],
  ['a dynamic import("node:child_process")',
    `${agentSource}\nexport const s = async () => (await import('node:child_process')).execSync('git commit -am x');\n`],
  ['a double-quoted from "node:fs"',
    agentSource.replace("import path from 'node:path';", "import path from 'node:path';\nimport fs from \"node:fs\";")],
];
for (const [label, broken] of detectorCases) {
  const analysis = analyzeContractPurity(broken);
  check(`the detector flags ${label}`, !analysis.pure,
    `modules: ${analysis.forbiddenModules.join(', ') || 'none'}; globals: ${analysis.forbiddenGlobals.join(', ') || 'none'}`);
}
const realAnalysis = analyzeContractPurity(agentSource);
check('the real contract layer is still pure', realAnalysis.pure,
  `imports: ${realAnalysis.imports.join(', ')}`);

/* ------------------------------------------------------------------ */
console.log('');
console.log('--- C. the digest is recomputed at the request-validation layer ---');
const mismatchCode = codeOf(() => validateAgentRequest({
  ...request,
  inputs: [{
    kind: 'file',
    ref: 'tests/login.spec.ts',
    digest: sha('something else'),
    content: SPEC,
  }],
}));
check('a digest mismatch is rejected by validateAgentRequest', mismatchCode === 'AGENT_PROVENANCE_DIGEST_MISMATCH', `code=${mismatchCode}`);

let seen = null;
const provider = createModelProvider({
  id: 'review-provider',
  complete: async (r) => {
    seen = r;
    return { text: JSON.stringify({ summary: 'ok', diff: LEGIT_HUNK, evidenceRefs: ['tests/login.spec.ts'] }) };
  },
});
const adapter = createAgentAdapter({
  adapterId: 'review-adapter',
  role: 'generator',
  capabilities: ['propose_script_diff'],
  provider,
});
await adapter.execute({
  role: 'generator',
  scope: request.scope,
  budget: request.budget,
  requestedCapabilities: ['propose_script_diff'],
  inputs: [{
    kind: 'file',
    ref: 'tests/login.spec.ts',
    digest: sha('something else'),
    content: SPEC,
  }],
  egress: { kinds: ['file'] },
}).then(
  () => check('the adapter rejects a digest mismatch too', false, 'the adapter accepted it'),
  (error) => check('the adapter rejects a digest mismatch too', error.code === 'AGENT_PROVENANCE_DIGEST_MISMATCH', `code=${error.code}`),
);

/* ------------------------------------------------------------------ */
console.log('');
console.log('--- D. the deadline is enforced against a hung provider ---');
const hung = createModelProvider({ id: 'hung', complete: () => new Promise(() => {}) });
const hungAdapter = createAgentAdapter({
  adapterId: 'hung-adapter',
  role: 'generator',
  capabilities: ['propose_script_diff'],
  provider: hung,
});
const startedAt = Date.now();
const deadlineOutcome = await Promise.race([
  hungAdapter.execute({
    ...request,
    budget: { ...request.budget, deadlineMs: 1000 },
  }).then(() => 'settled', (error) => `rejected ${error.code}`),
  new Promise((resolve) => setTimeout(() => resolve('STILL PENDING'), 3000)),
]);
const elapsed = Date.now() - startedAt;
check('a hung provider is cut off at the deadline', deadlineOutcome === 'rejected AGENT_BUDGET_EXCEEDED',
  `${deadlineOutcome} after ${elapsed}ms`);

/* ------------------------------------------------------------------ */
console.log('');
console.log('--- E. only AGENT_* errors are remapped ---');
const port = 26000 + Math.floor(Math.random() * 8000);
const dataDir = path.join(WORK_ROOT, 'state');
fs.mkdirSync(dataDir, { recursive: true });
const server = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'index.mjs')], {
  cwd: REPO_ROOT,
  env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: dataDir },
  stdio: 'ignore',
});
try {
  let token = null;
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  token = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).token;
  const call = async (pathname, payload) => {
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return [r.status, await r.json()];
  };

  const [agentStatus, agentBody] = await call('/api/agent/validate', {
    ...request,
    inputs: [{
      kind: 'file',
      ref: 'tests/login.spec.ts',
      digest: sha('something else'),
      content: SPEC,
    }],
  });
  check('the validate endpoint rejects a digest mismatch',
    agentStatus === 400 && agentBody.error === 'AGENT_PROVENANCE_DIGEST_MISMATCH',
    `${agentStatus} ${JSON.stringify(agentBody)}`);

  const [budgetStatus, budgetBody] = await call('/api/agent/validate', {
    ...request,
    budget: { ...request.budget, maxSteps: 99 },
  });
  check('an AGENT_* error carries machine-readable details',
    budgetStatus === 400 && budgetBody.details && budgetBody.details.field === 'maxSteps',
    `${budgetStatus} ${JSON.stringify(budgetBody)}`);

  const [otherStatus, otherBody] = await call('/api/projects', {
    path: path.join(WORK_ROOT, 'no-such-dir'),
  });
  check('a non-agent error keeps the pre-ATS-401 behaviour',
    otherStatus === 500 && String(otherBody.error).startsWith('ENOENT') && otherBody.details === undefined,
    `${otherStatus} ${JSON.stringify(otherBody)}`);
} finally {
  server.kill();
}

/* ------------------------------------------------------------------ */
console.log('');
console.log('--- F. the self-review check is not an exact string comparison ---');
const selfReviewProposal = validateAgentProposal(
  { summary: 'x', diff: LEGIT_HUNK, evidenceRefs: ['tests/login.spec.ts'] },
  request,
  { producedBy: 'gen-1' },
);
for (const who of ['gen-1', 'gen-1 ', ' GEN-1', 'Gen-1']) {
  const selfCode = codeOf(() => reviewAgentProposal(selfReviewProposal, { reviewer: who, decision: 'approved' }));
  check(`"${who}" cannot review its own proposal`, selfCode === 'AGENT_REVIEW_SELF_FORBIDDEN', `code=${selfCode}`);
}
const noProducer = codeOf(() => validateAgentProposal(
  { summary: 'x', diff: LEGIT_HUNK, evidenceRefs: ['tests/login.spec.ts'] },
  request,
));
check('a proposal without a platform-supplied producer is rejected',
  noProducer === 'AGENT_PROPOSAL_INVALID', `code=${noProducer}`);

/* ------------------------------------------------------------------ */
console.log('');
console.log('--- verdict ---');
if (failures.length) {
  console.log(`FAIL: ${failures.length} check(s) failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('PASS: every 1st-review-round regression is closed');
}
