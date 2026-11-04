#!/usr/bin/env node
/**
 * ATS-401 probe -- Agent 契约 v1 的权限边界
 *
 * 本探针用**静态分析 + 运行期断言**三条独立信号证明三件事：
 *
 *   1. 契约层的**源码**不含任何 I/O 调用
 *      （静态：server/agent.mjs 只 import node:crypto 与 node:path，且不引用
 *       fetch / process / globalThis / WebSocket / 动态 import / require /
 *       process.getBuiltinModule；
 *       运行期：调用契约层之后，夹具仓库的工作区文件内容与 Git 状态都不变）。
 *      注意：这是**静态检查**，不是「物理上无法」——Node 运行时并不阻止上述
 *      能力，真正的隔离（模块沙箱 / 只读挂载 / 子进程）属平台侧，见 ATS-403。
 *   2. 请求无法申请到写入类能力
 *      （运行期：带 write_source / git_commit 的请求一律被 AGENT_CAPABILITY_FORBIDDEN 拒绝）。
 *   3. 提案无法落地
 *      （运行期：diff 里出现的每一个路径都必须在 scope.outputs 内且为测试脚本文件；
 *       rename / copy / binary / mode change 一律被拒；
 *       且提案的 approval 恒为 pending，提案人不能自审）。
 *
 * 用法：node tools/ats401-probes/probe-agent-boundary.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AGENT_CAPABILITIES,
  FORBIDDEN_CAPABILITIES,
  createAgentAdapter,
  createModelProvider,
  reviewAgentProposal,
  validateAgentProposal,
  validateAgentRequest,
} from '../../server/agent.mjs';
import {
  ALLOWED_MODULES,
  FORBIDDEN_GLOBALS,
  analyzeContractPurity,
  negativeControls,
} from './lib/contract-purity.mjs';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..');
const WORK_ROOT = path.resolve(
  process.env.ATS_PROBE_WORKDIR || path.join(process.env.TMPDIR || os.tmpdir(), 'ats401-probes'),
);

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const failures = [];
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

console.log('=== ATS-401 probe: Agent contract v1 permission boundary ===');
console.log(`repo root : ${REPO_ROOT}`);
console.log(`work root : ${WORK_ROOT}`);
console.log('');

console.log('--- signal 1a: static analysis of server/agent.mjs ---');
const agentSource = fs.readFileSync(path.join(REPO_ROOT, 'server', 'agent.mjs'), 'utf8');
const purity = analyzeContractPurity(agentSource);

console.log(`  imports: ${purity.imports.join(', ')}`);
for (const mod of purity.forbiddenModules) {
  check(`agent.mjs does not import ${mod}`, false, 'the contract layer must not import an I/O module');
}
check(
  'agent.mjs imports only node:crypto and node:path',
  purity.imports.every((m) => ALLOWED_MODULES.includes(m)),
  purity.imports.join(', '),
);
for (const name of FORBIDDEN_GLOBALS) {
  check(
    `agent.mjs does not reference the ${name} global`,
    !purity.forbiddenGlobals.includes(name),
    purity.forbiddenGlobals.join(', '),
  );
}
check(
  'the contract layer source contains no I/O capability',
  purity.pure,
  `forbidden modules: ${purity.forbiddenModules.join(', ') || 'none'}; forbidden globals: ${purity.forbiddenGlobals.join(', ') || 'none'}`,
);

/* ------------------------------------------------------------------ */
/* 信号 1c：负控 -- 判定逻辑对故意破坏的源码必须报警                   */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- signal 1c: negative control -- the detector must fire on a broken copy ---');
const controls = negativeControls(agentSource);
for (const [label, broken] of Object.entries(controls)) {
  const analysis = analyzeContractPurity(broken);
  const flagged = [
    ...analysis.forbiddenModules.map((m) => `module:${m}`),
    ...analysis.forbiddenGlobals.map((g) => `global:${g}`),
  ];
  check(
    `the detector flags ${label}`,
    !analysis.pure && flagged.length > 0,
    flagged.length ? `flagged: ${flagged.join(', ')}` : 'NOT FLAGGED -- the detector would be vacuous',
  );
}

/* ------------------------------------------------------------------ */
/* 信号 1b：运行期 -- 契约层调用后仓库工作区不变                       */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- signal 1b: runtime check that the fixture repo is untouched ---');

const fixture = path.join(WORK_ROOT, 'fixture-repo');
fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'package.json'), '{"name":"fixture"}');
fs.writeFileSync(path.join(fixture, 'playwright.config.ts'), 'export default {};');
const specPath = path.join(fixture, 'tests', 'login.spec.ts');
const specContent = "test('login passes', async ({page}) => {});\n";
fs.writeFileSync(specPath, specContent);
const git = spawnSync('git', ['-C', fixture, 'init', '-q'], { encoding: 'utf8' });
check('fixture repo is a git repository', git.status === 0, (git.stderr || '').trim());
spawnSync('git', ['-C', fixture, 'add', '-A'], { encoding: 'utf8' });
spawnSync('git', ['-C', fixture, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid',
  'commit', '-q', '-m', 'fixture'], { encoding: 'utf8' });

const beforeContent = fs.readFileSync(specPath, 'utf8');
const beforeStatus = spawnSync('git', ['-C', fixture, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
const beforeLog = spawnSync('git', ['-C', fixture, 'log', '--oneline'], { encoding: 'utf8' }).stdout;

const provider = createModelProvider({
  id: 'probe-provider',
  complete: async () => ({
    text: JSON.stringify({
      summary: 'propose a goto',
      diff: [
        '--- a/tests/login.spec.ts',
        '+++ b/tests/login.spec.ts',
        '@@ -1 +1 @@',
        "-test('login passes', async ({page}) => {});",
        "+test('login passes', async ({page}) => { await page.goto('/login'); });",
      ].join('\n'),
      evidenceRefs: ['tests/login.spec.ts'],
    }),
  }),
});
const adapter = createAgentAdapter({
  adapterId: 'probe-adapter',
  role: 'generator',
  capabilities: ['propose_script_diff'],
  provider,
});

const request = {
  role: 'generator',
  scope: {
    projectId: 'proj_probe',
    root: fixture,
    files: ['tests/login.spec.ts'],
    outputs: ['tests/login.spec.ts'],
    runs: [],
    requirements: [],
  },
  budget: { maxInputBytes: 100_000, maxOutputBytes: 100_000, maxSteps: 4, deadlineMs: 30_000 },
  instructions: 'propose a login test',
  requestedCapabilities: ['propose_script_diff'],
  inputs: [{
    kind: 'file',
    ref: 'tests/login.spec.ts',
    digest: sha(specContent),
    content: specContent,
    retrievedAt: '2026-11-04T00:00:00.000Z',
  }],
  egress: { kinds: ['file'] },
};

const outcome = await adapter.execute(request);
const afterContent = fs.readFileSync(specPath, 'utf8');
const afterStatus = spawnSync('git', ['-C', fixture, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
const afterLog = spawnSync('git', ['-C', fixture, 'log', '--oneline'], { encoding: 'utf8' }).stdout;

check('the spec file content is unchanged', beforeContent === afterContent);
check('git status is unchanged', beforeStatus === afterStatus, JSON.stringify(afterStatus));
check('no new git commit was created', beforeLog === afterLog);
check('the proposal is pending review', outcome.proposal.approval === 'pending');
check(
  'the proposal carries the diff as text only',
  typeof outcome.proposal.diff === 'string' && outcome.proposal.diff.includes('+++ b/tests/login.spec.ts'),
);

/* ------------------------------------------------------------------ */
/* 信号 2：写入类能力一律被拒绝                                       */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- signal 2: forbidden capabilities are rejected ---');
for (const capability of ['write_source', 'git_commit', 'git_push', 'update_expected', 'approve_proposal']) {
  let code = null;
  try {
    validateAgentRequest({ ...request, requestedCapabilities: [capability] });
  } catch (error) {
    code = error.code;
  }
  check(`requesting ${capability} is rejected`, code === 'AGENT_CAPABILITY_FORBIDDEN', `code=${code}`);
}
for (const role of Object.keys(AGENT_CAPABILITIES)) {
  const held = AGENT_CAPABILITIES[role];
  const offending = held.filter((c) => FORBIDDEN_CAPABILITIES.includes(c));
  check(`role ${role} holds no forbidden capability`, offending.length === 0, offending.join(','));
}

/* ------------------------------------------------------------------ */
/* 信号 3：提案无法落地                                               */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- signal 3: proposals cannot be applied outside the scope ---');

const validatedRequest = validateAgentRequest(request);

const outOfScopeDiff = [
  '--- a/tests/secret.spec.ts',
  '+++ b/tests/secret.spec.ts',
  '@@ -1 +1 @@',
  '-x',
  '+y',
].join('\n');
let code = null;
try {
  validateAgentProposal({ summary: 'x', diff: outOfScopeDiff, evidenceRefs: ['tests/login.spec.ts'] }, validatedRequest);
} catch (error) {
  code = error.code;
}
check('a diff outside scope.outputs is rejected', code === 'AGENT_PROPOSAL_OUT_OF_SCOPE', `code=${code}`);

const nonScriptDiff = [
  '--- a/playwright.config.ts',
  '+++ b/playwright.config.ts',
  '@@ -1 +1 @@',
  '-export default {};',
  '+export default { retries: 3 };',
].join('\n');
code = null;
try {
  validateAgentProposal({ summary: 'x', diff: nonScriptDiff, evidenceRefs: ['tests/login.spec.ts'] }, validatedRequest);
} catch (error) {
  code = error.code;
}
check('a diff targeting a non test-script file is rejected', code === 'AGENT_PROPOSAL_OUT_OF_SCOPE', `code=${code}`);

const escapingDiff = [
  '--- a/../../outside.spec.ts',
  '+++ b/../../outside.spec.ts',
  '@@ -1 +1 @@',
  '-x',
  '+y',
].join('\n');
code = null;
try {
  validateAgentProposal({ summary: 'x', diff: escapingDiff, evidenceRefs: ['tests/login.spec.ts'] }, validatedRequest);
} catch (error) {
  code = error.code;
}
check('a diff escaping the project root is rejected', code === 'AGENT_PROPOSAL_OUT_OF_SCOPE', `code=${code}`);

code = null;
try {
  reviewAgentProposal(outcome.proposal, { reviewer: 'probe-adapter', decision: 'approved' });
} catch (error) {
  code = error.code;
}
check('the producer cannot review its own proposal', code === 'AGENT_REVIEW_SELF_FORBIDDEN', `code=${code}`);

const approved = reviewAgentProposal(outcome.proposal, { reviewer: 'probe-reviewer', decision: 'approved' });
check('an independent reviewer can approve', approved.approval === 'approved' && approved.reviewedBy === 'probe-reviewer');

/* ------------------------------------------------------------------ */
/* 信号 3b：diff 头部里的每一条路径都要受作用域约束                   */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- signal 3b: every path in the diff header is scope-checked ---');

const LEGIT_HUNK = [
  'diff --git a/tests/login.spec.ts b/tests/login.spec.ts',
  '--- a/tests/login.spec.ts',
  '+++ b/tests/login.spec.ts',
  '@@ -1 +1 @@',
  "-test('login passes', async ({page}) => {});",
  "+test('login passes', async ({page}) => { await page.goto('/login'); });",
].join('\n');

/**
 * 每一条都是「在合法 hunk 后面追加一个越界构造」的绕过尝试。
 * 只要其中任何一条被接受，作用域约束就被绕过了。
 */
/** CR as a real character, so the CRLF case is a real CRLF. */
const CR = String.fromCharCode(13);

const bypassAttempts = [
  {
    label: 'a rename section that moves server/index.mjs out of the scope',
    diff: `${LEGIT_HUNK}\ndiff --git a/server/index.mjs b/server/pwned.mjs\nsimilarity index 100%\nrename from server/index.mjs\nrename to server/pwned.mjs\n`,
  },
  {
    label: 'a copy section that copies a file outside the scope',
    diff: `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/server/copied.mjs\nsimilarity index 100%\ncopy from tests/login.spec.ts\ncopy to server/copied.mjs\n`,
  },
  {
    label: 'a mode change on a file outside the scope',
    diff: `${LEGIT_HUNK}\ndiff --git a/start.sh b/start.sh\nold mode 100644\nnew mode 100755\n`,
  },
  {
    label: 'a CRLF-terminated diff section targeting a file outside the scope',
    // Built from char codes so the CR really lands in the string literal.
    diff: [
      LEGIT_HUNK,
      'diff --git a/server/index.mjs b/server/index.mjs' + CR,
      '--- a/server/index.mjs' + CR,
      '+++ b/server/index.mjs' + CR,
      '@@ -1 +1 @@' + CR,
      '-x' + CR,
      '+y' + CR,
    ].join('\n'),
  },
  {
    label: 'a binary patch creating a file outside the scope',
    diff: `${LEGIT_HUNK}\ndiff --git a/server/evil.mjs b/server/evil.mjs\nnew file mode 100644\nindex 0000000..1234567\nGIT binary patch\nliteral 12\nzcmZQzU|?V=+\n\nliteral 0\nHcmV?d00001\n\n`,
  },
  {
    label: 'a Binary files ... differ section targeting a file outside the scope',
    diff: `${LEGIT_HUNK}\ndiff --git a/server/index.mjs b/server/index.mjs\nBinary files a/server/index.mjs and b/server/index.mjs differ\n`,
  },
  {
    label: 'a diff --git header naming a file outside the scope',
    diff: `${LEGIT_HUNK}\ndiff --git a/server/index.mjs b/server/index.mjs\n`,
  },
];

for (const attempt of bypassAttempts) {
  code = null;
  try {
    validateAgentProposal({ summary: 'x', diff: attempt.diff, evidenceRefs: ['tests/login.spec.ts'] }, validatedRequest);
  } catch (error) {
    code = error.code;
  }
  check(
    `${attempt.label} is rejected`,
    code === 'AGENT_PROPOSAL_OUT_OF_SCOPE',
    `code=${code}`,
  );
}

/* 允许新建测试脚本：--- /dev/null + new file mode 100644，且路径在 outputs 内。 */
const newSpecDiff = [
  'diff --git a/tests/new.spec.ts b/tests/new.spec.ts',
  'new file mode 100644',
  'index 0000000..1234567',
  '--- /dev/null',
  '+++ b/tests/new.spec.ts',
  '@@ -0,0 +1 @@',
  "+test('new', async ({page}) => {});",
].join('\n');
const requestWithNewOutput = validateAgentRequest({
  ...request,
  scope: { ...request.scope, outputs: [...request.scope.outputs, 'tests/new.spec.ts'] },
});
let newSpecAccepted = false;
try {
  validateAgentProposal({ summary: 'x', diff: newSpecDiff, evidenceRefs: ['tests/login.spec.ts'] }, requestWithNewOutput, { producedBy: 'probe-adapter' });
  newSpecAccepted = true;
} catch (error) {
  newSpecAccepted = false;
}
check('a new test script inside scope.outputs is accepted', newSpecAccepted);

/* ------------------------------------------------------------------ */
console.log('');
console.log('--- verdict ---');
if (failures.length) {
  console.log(`FAIL: ${failures.length} check(s) failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('PASS: the agent contract cannot write, commit, or apply a proposal');
}
