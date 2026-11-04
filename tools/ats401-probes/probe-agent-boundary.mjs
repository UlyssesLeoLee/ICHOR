#!/usr/bin/env node
/**
 * ATS-401 probe -- Agent 契约 v1 的权限边界
 *
 * 本探针用**静态分析 + 运行期断言**两条独立信号证明三件事：
 *
 *   1. 契约层在物理上无法写入仓库、提交 Git 或发起网络请求
 *      （静态：server/agent.mjs 的 import 清单里没有 fs / child_process / net / http；
 *       运行期：调用契约层之后，夹具仓库的工作区文件内容与 Git 状态都不变）。
 *   2. 请求无法申请到写入类能力
 *      （运行期：带 write_source / git_commit 的请求一律被 AGENT_CAPABILITY_FORBIDDEN 拒绝）。
 *   3. 提案无法落地
 *      （运行期：diff 目标不在 scope.outputs 内、或目标是非测试脚本文件，都被拒绝；
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
const FORBIDDEN_MODULES = [
  'node:fs', 'node:fs/promises', 'fs', 'node:child_process', 'child_process',
  'node:net', 'node:http', 'node:https', 'node:dgram', 'node:tls',
];

/**
 * 返回源码里出现的所有 import 说明符。
 * 抽成函数是为了让负控（negative control）能用同一段判定逻辑去检查一份
 * 故意被破坏的源码，从而证明判定不是恒真的。
 */
function importedModulesOf(source) {
  const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  return [...new Set(specifiers)];
}

const importedModules = importedModulesOf(agentSource);
console.log(`  imports: ${importedModules.join(', ')}`);
for (const mod of FORBIDDEN_MODULES) {
  check(`agent.mjs does not import ${mod}`, !importedModules.includes(mod));
}
check(
  'agent.mjs imports only node:crypto and node:path',
  importedModules.every((m) => m === 'node:crypto' || m === 'node:path'),
  importedModules.join(', '),
);

/* ------------------------------------------------------------------ */
/* 信号 1c：负控 -- 判定逻辑对故意破坏的源码必须报警                   */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- signal 1c: negative control -- the detector must fire on a broken copy ---');
const brokenSources = {
  'a copy that imports node:fs': agentSource.replace(
    "import crypto from 'node:crypto';",
    "import crypto from 'node:crypto';\nimport fs from 'node:fs';",
  ),
  'a copy that imports node:child_process': agentSource.replace(
    "import crypto from 'node:crypto';",
    "import crypto from 'node:crypto';\nimport { spawn } from 'node:child_process';",
  ),
  'a copy that imports node:https': agentSource.replace(
    "import crypto from 'node:crypto';",
    "import crypto from 'node:crypto';\nimport https from 'node:https';",
  ),
};
for (const [label, broken] of Object.entries(brokenSources)) {
  const modules = importedModulesOf(broken);
  const flagged = FORBIDDEN_MODULES.filter((m) => modules.includes(m));
  check(
    `the detector flags ${label}`,
    flagged.length > 0,
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
console.log('');
console.log('--- verdict ---');
if (failures.length) {
  console.log(`FAIL: ${failures.length} check(s) failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('PASS: the agent contract cannot write, commit, or apply a proposal');
}
