/**
 * ATS-401 ｜ Agent 契约 v1（Agent contract v1）
 *
 * 本模块是 S4/v0.4.0 的**契约层**：定义 Agent 请求与 Agent 提案的形状，校验
 * 作用域、预算与输入出处，把模型输出收敛成「待审提案」。它**不**包含：
 *   - 模型提供商实现与错误回退（ATS-403）；
 *   - API Key 存储与数据外传知情授权（ATS-402）；
 *   - 把提案写回仓库的路径（评审通过后的应用由平台侧执行，契约层不提供）。
 *
 * 权限边界的实现方式（每条都可机器复核，见 tools/ats401-probes/）：
 *   1. 本模块的**源码**不含任何 I/O 调用：只 import `node:crypto` 与
 *      `node:path`，并且不引用 fetch / process / globalThis / WebSocket /
 *      动态 import / require / process.getBuiltinModule。该性质由**静态检查**
 *      守护（tools/ats401-probes/lib/contract-purity.mjs，带负控）——
 *      注意这不是「物理上无法」：Node 运行时并不阻止上述能力，模块隔离、
 *      只读挂载或子进程沙箱才是真正的隔离手段，留给平台侧（ATS-403）。
 *   2. 能力白名单里没有任何「写/提交」类能力；请求携带这类能力直接被拒绝。
 *   3. 提案只承载 diff 与分析结论，`approval` 恒为 `pending`，且提案人不能自审。
 *   4. 提案的 diff 只接受能被完整解析的 unified diff；diff 头部里出现的
 *      **每一个**路径都必须落在 `scope.outputs` 内且为测试脚本文件，
 *      rename / copy / binary / mode change 一律拒绝。
 *
 * 错误码是稳定契约的一部分（见 AGENT_ERROR_CODES），调用方按 `err.code` 分支，
 * 不解析错误消息文本。
 */
import crypto from 'node:crypto';
import path from 'node:path';

export const AGENT_CONTRACT_VERSION = 'agent-contract/v1';

/** ADR-006：Planner/Generator/Healer 与 Reviewer 分离，角色即能力边界。 */
export const AGENT_ROLES = Object.freeze(['planner', 'generator', 'triage', 'healer']);

/** 角色可申请的能力上限。没有任何角色持有写入或提交能力。 */
export const AGENT_CAPABILITIES = Object.freeze({
  planner: Object.freeze(['read_requirements', 'read_test_index', 'read_run_evidence']),
  generator: Object.freeze(['read_requirements', 'read_test_index', 'read_run_evidence', 'propose_script_diff']),
  triage: Object.freeze(['read_run_evidence']),
  healer: Object.freeze(['read_run_evidence', 'propose_script_diff']),
});

/**
 * 明令禁止的能力。出现在请求里即拒绝，不因角色不同而放宽。
 * 「不能直接保存/提交测试脚本」在能力层面即不成立，不依赖调用方自觉。
 */
export const FORBIDDEN_CAPABILITIES = Object.freeze([
  'write_source',
  'save_source',
  'git_commit',
  'git_push',
  'git_stage',
  'update_expected',
  'close_defect',
  'spawn_process',
  'read_secret',
  'network_fetch',
  'approve_proposal',
]);

/** 角色 → 提案类型。 */
export const OUTPUT_KIND_BY_ROLE = Object.freeze({
  planner: 'test-intent',
  generator: 'script-diff',
  triage: 'failure-classification',
  healer: 'diagnosis',
});

/** 提案类型 → 产出该提案所必需的能力。 */
export const REQUIRED_CAPABILITY_BY_OUTPUT = Object.freeze({
  'test-intent': 'read_requirements',
  'script-diff': 'propose_script_diff',
  'failure-classification': 'read_run_evidence',
  'diagnosis': 'read_run_evidence',
});

/** 提案里允许出现的动作类型；任何写入/提交类动作都不在其中。 */
export const AGENT_ACTION_TYPES = Object.freeze(['assert', 'goto', 'fill', 'click', 'comment', 'noop']);

/** 提案类型 → 允许的输入种类（输入出处必须能对上作用域）。 */
export const INPUT_KINDS = Object.freeze(['requirement', 'file', 'run', 'evidence']);

/** 平台侧预算上限。请求声明的预算不得超过这些值。 */
export const AGENT_BUDGET_LIMITS = Object.freeze({
  maxInputBytes: 4_000_000,
  maxOutputBytes: 1_000_000,
  maxSteps: 10,
  deadlineMs: 600_000,
  minDeadlineMs: 1_000,
});

/** 请求必须声明的预算字段。 */
export const REQUIRED_BUDGET_FIELDS = Object.freeze([
  'maxInputBytes',
  'maxOutputBytes',
  'maxSteps',
  'deadlineMs',
]);

export const AGENT_ERROR_CODES = Object.freeze([
  'AGENT_REQUEST_INVALID',
  'AGENT_CONTRACT_UNSUPPORTED',
  'AGENT_ROLE_UNKNOWN',
  'AGENT_ROLE_MISMATCH',
  'AGENT_SCOPE_REQUIRED',
  'AGENT_SCOPE_INVALID',
  'AGENT_SCOPE_ESCAPE',
  'AGENT_SCOPE_OUTPUT_NOT_TEST_SCRIPT',
  'AGENT_BUDGET_REQUIRED',
  'AGENT_BUDGET_INVALID',
  'AGENT_BUDGET_EXCEEDED',
  'AGENT_PROVENANCE_REQUIRED',
  'AGENT_PROVENANCE_INVALID',
  'AGENT_PROVENANCE_OUT_OF_SCOPE',
  'AGENT_PROVENANCE_DIGEST_MISMATCH',
  'AGENT_CAPABILITY_FORBIDDEN',
  'AGENT_CAPABILITY_NOT_GRANTED',
  'AGENT_PROVIDER_INVALID',
  'AGENT_PROVIDER_ERROR',
  'AGENT_PROVIDER_OUTPUT_INVALID',
  'AGENT_PROPOSAL_INVALID',
  'AGENT_PROPOSAL_OUT_OF_SCOPE',
  'AGENT_REVIEWER_INVALID',
  'AGENT_REVIEW_STATE_INVALID',
  'AGENT_REVIEW_SELF_FORBIDDEN',
]);

const TEST_SCRIPT_PATTERN = /\.(spec|test)\.[cm]?[jt]sx?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RUN_ID = /^run_[0-9a-f-]{36}$/;
const MAX_TEXT = 8000;

/**
 * 超时竞速用的哨兵值。provider 的返回值不可能是这个对象，因此它与
 * 「provider 正常返回」可区分。
 */
const TIMEOUT_SENTINEL = Object.freeze({ __agentTimeout: true });

function fail(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  throw err;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

function assertText(value, code, label, max) {
  if (typeof value !== 'string') fail(code, `${label} must be a string`);
  if (value.length > max) fail(code, `${label} exceeds ${max} characters`);
  if (value.includes('\0')) fail(code, `${label} must not contain NUL`);
  return value;
}

/* ------------------------------------------------------------------ scope */

function normalizeRelative(root, value, code, label) {
  if (typeof value !== 'string' || !value.trim()) fail(code, `${label} must be a non-empty string`);
  if (value.length > 500) fail(code, `${label} exceeds 500 characters`);
  if (value.includes('\0')) fail(code, `${label} must not contain NUL`);
  if (path.isAbsolute(value)) fail(code, `${label} must be relative to scope.root`);
  const absolute = path.resolve(root, value);
  const rel = path.relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('AGENT_SCOPE_ESCAPE', `${label} escapes scope.root`, { value });
  }
  return toPosix(value);
}

function normalizeIdList(value, code, label, pattern) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(code, `${label} must be an array`);
  if (value.length > 200) fail(code, `${label} accepts at most 200 entries`);
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) fail(code, `${label} entries must be non-empty strings`);
    if (entry.length > 200) fail(code, `${label} entries exceed 200 characters`);
    if (pattern && !pattern.test(entry)) fail(code, `${label} entries must match ${pattern.source}`, { entry });
    return entry;
  });
}

export function validateAgentScope(scope) {
  if (!isPlainObject(scope)) fail('AGENT_SCOPE_REQUIRED', 'request.scope is required');
  const projectId = scope.projectId;
  if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 200) {
    fail('AGENT_SCOPE_INVALID', 'scope.projectId must be a non-empty string');
  }
  const root = scope.root;
  if (typeof root !== 'string' || !root.trim()) fail('AGENT_SCOPE_INVALID', 'scope.root must be a non-empty string');
  if (root.length > 1024) fail('AGENT_SCOPE_INVALID', 'scope.root exceeds 1024 characters');
  if (!path.isAbsolute(root)) fail('AGENT_SCOPE_INVALID', 'scope.root must be an absolute path');
  if (root.includes('\0')) fail('AGENT_SCOPE_INVALID', 'scope.root must not contain NUL');

  const files = (scope.files === undefined ? [] : scope.files);
  const outputs = (scope.outputs === undefined ? [] : scope.outputs);
  if (!Array.isArray(files)) fail('AGENT_SCOPE_INVALID', 'scope.files must be an array');
  if (!Array.isArray(outputs)) fail('AGENT_SCOPE_INVALID', 'scope.outputs must be an array');
  if (files.length > 500) fail('AGENT_SCOPE_INVALID', 'scope.files accepts at most 500 entries');
  if (outputs.length > 200) fail('AGENT_SCOPE_INVALID', 'scope.outputs accepts at most 200 entries');

  const normalizedFiles = files.map((f) => normalizeRelative(root, f, 'AGENT_SCOPE_INVALID', 'scope.files[]'));
  const normalizedOutputs = outputs.map((f) => normalizeRelative(root, f, 'AGENT_SCOPE_INVALID', 'scope.outputs[]'));
  for (const output of normalizedOutputs) {
    if (!TEST_SCRIPT_PATTERN.test(output)) {
      fail('AGENT_SCOPE_OUTPUT_NOT_TEST_SCRIPT', 'scope.outputs may only contain test script files', { output });
    }
  }

  const runs = normalizeIdList(scope.runs, 'AGENT_SCOPE_INVALID', 'scope.runs', RUN_ID);
  const requirements = normalizeIdList(scope.requirements, 'AGENT_SCOPE_INVALID', 'scope.requirements');

  if (!normalizedFiles.length && !runs.length && !requirements.length) {
    fail('AGENT_SCOPE_REQUIRED', 'scope must declare at least one of files / runs / requirements');
  }

  return {
    projectId,
    root,
    files: normalizedFiles,
    outputs: normalizedOutputs,
    runs,
    requirements,
  };
}

/* ----------------------------------------------------------------- budget */

export function validateAgentBudget(budget) {
  if (!isPlainObject(budget)) fail('AGENT_BUDGET_REQUIRED', 'request.budget is required');
  for (const field of REQUIRED_BUDGET_FIELDS) {
    if (!Number.isInteger(budget[field]) || budget[field] <= 0) {
      fail('AGENT_BUDGET_INVALID', `budget.${field} must be a positive integer`, { field });
    }
  }
  if (budget.maxInputBytes > AGENT_BUDGET_LIMITS.maxInputBytes) {
    fail('AGENT_BUDGET_INVALID', 'budget.maxInputBytes exceeds the platform limit', {
      field: 'maxInputBytes',
      limit: AGENT_BUDGET_LIMITS.maxInputBytes,
    });
  }
  if (budget.maxOutputBytes > AGENT_BUDGET_LIMITS.maxOutputBytes) {
    fail('AGENT_BUDGET_INVALID', 'budget.maxOutputBytes exceeds the platform limit', {
      field: 'maxOutputBytes',
      limit: AGENT_BUDGET_LIMITS.maxOutputBytes,
    });
  }
  if (budget.maxSteps > AGENT_BUDGET_LIMITS.maxSteps) {
    fail('AGENT_BUDGET_INVALID', 'budget.maxSteps exceeds the platform limit', {
      field: 'maxSteps',
      limit: AGENT_BUDGET_LIMITS.maxSteps,
    });
  }
  if (budget.deadlineMs > AGENT_BUDGET_LIMITS.deadlineMs) {
    fail('AGENT_BUDGET_INVALID', 'budget.deadlineMs exceeds the platform limit', {
      field: 'deadlineMs',
      limit: AGENT_BUDGET_LIMITS.deadlineMs,
    });
  }
  if (budget.deadlineMs < AGENT_BUDGET_LIMITS.minDeadlineMs) {
    fail('AGENT_BUDGET_INVALID', 'budget.deadlineMs is below the platform minimum', {
      field: 'deadlineMs',
      minimum: AGENT_BUDGET_LIMITS.minDeadlineMs,
    });
  }
  if (budget.maxTokens !== undefined && (!Number.isInteger(budget.maxTokens) || budget.maxTokens <= 0)) {
    fail('AGENT_BUDGET_INVALID', 'budget.maxTokens must be a positive integer when present', {
      field: 'maxTokens',
    });
  }
  return {
    maxInputBytes: budget.maxInputBytes,
    maxOutputBytes: budget.maxOutputBytes,
    maxSteps: budget.maxSteps,
    deadlineMs: budget.deadlineMs,
    maxTokens: budget.maxTokens,
  };
}

/* ------------------------------------------------------- provenance (出处) */

/**
 * 输入出处（provenance）：每个输入必须说明「来自哪里」「内容是什么」「内容是否
 * 与声明的摘要一致」。
 *
 * 保证的边界（**不要读成比这更强**）：
 *   - `ref` 必须落在已声明的作用域内 —— 请求读不到作用域外的**已声明**材料；
 *   - `digest` 必须是 `content` 的 SHA-256 —— 摘要与内容**自洽**。
 *
 * 摘要与内容都由请求方提供，因此这一层证明的是「两者自洽」，**不能**证明
 * `content` 确实来自 `ref` 所指的那份源文件。「ref 对应真实源内容」由**平台侧**
 * 在构造请求时负责（读取文件后再计算摘要）；该平台侧实现尚未落地，属未验证项。
 */
export function validateAgentInputs(inputs, scope) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    fail('AGENT_PROVENANCE_REQUIRED', 'request.inputs must be a non-empty array');
  }
  if (inputs.length > 64) fail('AGENT_PROVENANCE_INVALID', 'request.inputs accepts at most 64 entries');

  const seen = new Set();
  return inputs.map((input, index) => {
    if (!isPlainObject(input)) fail('AGENT_PROVENANCE_INVALID', `inputs[${index}] must be an object`);
    const kind = input.kind;
    if (!INPUT_KINDS.includes(kind)) {
      fail('AGENT_PROVENANCE_INVALID', `inputs[${index}].kind must be one of ${INPUT_KINDS.join(', ')}`);
    }
    const ref = input.ref;
    if (typeof ref !== 'string' || !ref.trim()) {
      fail('AGENT_PROVENANCE_INVALID', `inputs[${index}].ref must be a non-empty string`);
    }
    if (ref.length > 500) fail('AGENT_PROVENANCE_INVALID', `inputs[${index}].ref exceeds 500 characters`);
    if (ref.includes('\0')) fail('AGENT_PROVENANCE_INVALID', `inputs[${index}].ref must not contain NUL`);
    const digest = input.digest;
    if (typeof digest !== 'string' || !HEX64.test(digest)) {
      fail('AGENT_PROVENANCE_INVALID', `inputs[${index}].digest must be a lowercase sha256 hex digest`);
    }
    const content = input.content;
    if (typeof content !== 'string') {
      fail('AGENT_PROVENANCE_INVALID', `inputs[${index}].content must be a string`);
    }
    if (content.includes('\0')) fail('AGENT_PROVENANCE_INVALID', `inputs[${index}].content must not contain NUL`);
    let retrievedAt = null;
    if (input.retrievedAt !== undefined && input.retrievedAt !== null) {
      if (typeof input.retrievedAt !== 'string' || Number.isNaN(Date.parse(input.retrievedAt))) {
        fail('AGENT_PROVENANCE_INVALID', `inputs[${index}].retrievedAt must be an ISO-8601 timestamp`);
      }
      retrievedAt = input.retrievedAt;
    }

    // 出处必须落在已声明的作用域内：请求不能读作用域外的材料。
    if (kind === 'file' && !scope.files.includes(toPosix(ref))) {
      fail('AGENT_PROVENANCE_OUT_OF_SCOPE', `inputs[${index}] (${ref}) is not listed in scope.files`);
    }
    if (kind === 'run' && !scope.runs.includes(ref)) {
      fail('AGENT_PROVENANCE_OUT_OF_SCOPE', `inputs[${index}] (${ref}) is not listed in scope.runs`);
    }
    if (kind === 'requirement' && !scope.requirements.includes(ref)) {
      fail('AGENT_PROVENANCE_OUT_OF_SCOPE', `inputs[${index}] (${ref}) is not listed in scope.requirements`);
    }
    if (kind === 'evidence') {
      const runId = ref.split('/')[0];
      if (!scope.runs.includes(runId)) {
        fail('AGENT_PROVENANCE_OUT_OF_SCOPE', `inputs[${index}] (${ref}) does not belong to scope.runs`);
      }
    }

    const key = `${kind}:${ref}`;
    if (seen.has(key)) fail('AGENT_PROVENANCE_INVALID', `duplicate provenance entry ${key}`);
    seen.add(key);

    // 摘要必须与内容一致。这项检查放在**请求校验**层而不是只在适配器里，
    // 因此 `POST /api/agent/validate` 与适配器对同一请求给出同一个判定。
    if (sha256(content) !== digest) {
      fail('AGENT_PROVENANCE_DIGEST_MISMATCH', `input ${ref} does not match its declared digest`, {
        ref,
      });
    }

    return { kind, ref, digest, content, retrievedAt };
  });
}

/* ---------------------------------------------------------------- request */

export function validateAgentRequest(request) {
  if (!isPlainObject(request)) fail('AGENT_REQUEST_INVALID', 'request must be an object');
  const contract = request.contract === undefined ? AGENT_CONTRACT_VERSION : request.contract;
  if (contract !== AGENT_CONTRACT_VERSION) {
    fail('AGENT_CONTRACT_UNSUPPORTED', `unsupported agent contract ${contract}`, {
      supported: AGENT_CONTRACT_VERSION,
    });
  }
  const role = request.role;
  if (!AGENT_ROLES.includes(role)) {
    fail('AGENT_ROLE_UNKNOWN', `role must be one of ${AGENT_ROLES.join(', ')}`);
  }
  const scope = validateAgentScope(request.scope);
  const budget = validateAgentBudget(request.budget);
  const inputs = validateAgentInputs(request.inputs, scope);

  const instructions = request.instructions === undefined
    ? ''
    : assertText(request.instructions, 'AGENT_REQUEST_INVALID', 'request.instructions', MAX_TEXT);

  const requestedCapabilities = request.requestedCapabilities === undefined ? [] : request.requestedCapabilities;
  if (!Array.isArray(requestedCapabilities)) {
    fail('AGENT_REQUEST_INVALID', 'request.requestedCapabilities must be an array');
  }
  if (requestedCapabilities.length > 16) {
    fail('AGENT_REQUEST_INVALID', 'request.requestedCapabilities accepts at most 16 entries');
  }
  for (const capability of requestedCapabilities) {
    if (typeof capability !== 'string' || !capability.trim()) {
      fail('AGENT_REQUEST_INVALID', 'request.requestedCapabilities entries must be non-empty strings');
    }
  }
  for (const capability of requestedCapabilities) {
    if (FORBIDDEN_CAPABILITIES.includes(capability)) {
      fail('AGENT_CAPABILITY_FORBIDDEN', `capability ${capability} is forbidden by the agent contract`, {
        capability,
      });
    }
  }
  // 角色能力上限：请求不能申请角色本身没有的能力。角色分离（ADR-006）
  // 因此在请求层就成立，不依赖适配器是否实现了这道检查。
  for (const capability of requestedCapabilities) {
    if (!AGENT_CAPABILITIES[role].includes(capability)) {
      fail('AGENT_CAPABILITY_NOT_GRANTED', `role ${role} does not grant capability ${capability}`, {
        capability,
        role,
      });
    }
  }

  // 数据外传声明：未声明时默认不外传任何输入内容。ATS-402 把该字段绑定到
  // 真实的知情授权记录；在此之前它只是契约上的一个槽位。
  const egress = request.egress === undefined ? { kinds: [] } : request.egress;
  if (!isPlainObject(egress)) fail('AGENT_REQUEST_INVALID', 'request.egress must be an object');
  const egressKinds = egress.kinds === undefined ? [] : egress.kinds;
  if (!Array.isArray(egressKinds)) fail('AGENT_REQUEST_INVALID', 'request.egress.kinds must be an array');
  for (const kind of egressKinds) {
    if (!INPUT_KINDS.includes(kind)) {
      fail('AGENT_REQUEST_INVALID', `request.egress.kinds entries must be one of ${INPUT_KINDS.join(', ')}`);
    }
  }

  const id = request.id === undefined ? `agreq_${crypto.randomUUID()}` : request.id;
  if (typeof id !== 'string' || !id.trim() || id.length > 200) {
    fail('AGENT_REQUEST_INVALID', 'request.id must be a non-empty string of at most 200 characters');
  }

  return {
    contract,
    id,
    role,
    scope,
    budget,
    inputs,
    instructions,
    requestedCapabilities: [...requestedCapabilities],
    egress: { kinds: [...egressKinds] },
    createdAt: request.createdAt === undefined ? new Date().toISOString() : request.createdAt,
  };
}

/* --------------------------------------------------------------- proposal */

function validateActions(actions, outputKind) {
  if (actions === undefined || actions === null) return [];
  if (!Array.isArray(actions)) fail('AGENT_PROPOSAL_INVALID', 'proposal.actions must be an array');
  if (actions.length > 100) fail('AGENT_PROPOSAL_INVALID', 'proposal.actions accepts at most 100 entries');
  return actions.map((action, index) => {
    if (!isPlainObject(action)) fail('AGENT_PROPOSAL_INVALID', `actions[${index}] must be an object`);
    const type = action.type;
    if (!AGENT_ACTION_TYPES.includes(type)) {
      fail('AGENT_PROPOSAL_INVALID', `actions[${index}].type must be one of ${AGENT_ACTION_TYPES.join(', ')}`, {
        type,
      });
    }
    const target = action.target === undefined ? null : assertText(
      action.target, 'AGENT_PROPOSAL_INVALID', `actions[${index}].target`, 500,
    );
    const value = action.value === undefined ? null : assertText(
      action.value, 'AGENT_PROPOSAL_INVALID', `actions[${index}].value`, 2000,
    );
    return { type, target, value };
  });
}

/**
 * 拆开 `diff --git a/X b/Y` 的两侧。
 *
 * git 的这行在路径含空格时是有歧义的（`a/dir b/file b/dir b/file`）。拆分的
 * 规则：先取**两侧路径相同**的那个分隔点（普通改动的常见情形），找不到再退回
 * 第一个合法分隔点。
 */
function splitDiffGitPaths(rest) {
  const candidates = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest.startsWith(' b/', i)) continue;
    const left = rest.slice(0, i);
    const right = rest.slice(i + 1);
    if (left.startsWith('a/')) candidates.push([left, right]);
  }
  if (!candidates.length) return [];
  const same = candidates.find(([left, right]) => left.slice(2) === right.slice(2));
  return same || candidates[0];
}

/**
 * 从 diff 头部里抽出**每一个**出现过的路径。
 *
 * 只看 `---`/`+++` 是不够的：git 的扩展头（rename from/to、copy from/to、
 * Binary files…、old/new mode）根本不产生这两行，而 CRLF 结尾的header行
 * 也会让按行匹配的写法失效。因此这里先把 CR 去掉，再逐类扫描头部关键字。
 */
function diffTargetPaths(diff) {
  const out = [];
  const push = (candidate) => {
    if (!candidate) return;
    let value = candidate.split('\t')[0].trim();
    if (!value || value === '/dev/null') return;
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
      value = value.slice(1, -1);
    }
    if (value.startsWith('a/') || value.startsWith('b/')) value = value.slice(2);
    if (!value) return;
    out.push(toPosix(value));
  };

  for (const raw of diff.split('\n')) {
    // 头部行可能带 CR（CRLF diff）。去掉 CR 后再匹配，避免整行被跳过。
    const line = raw.replace(/\r/g, '');
    let match = /^(?:---|\+\+\+)\s+(.+)$/.exec(line);
    if (match) {
      push(match[1]);
      continue;
    }
    match = /^diff --git\s+(.+)$/.exec(line);
    if (match) {
      // `diff --git a/X b/Y` —— 两侧都是路径，都要检查。
      for (const side of splitDiffGitPaths(match[1].trim())) push(side);
      continue;
    }
    match = /^(?:rename|copy) (?:from|to)\s+(.+)$/.exec(line);
    if (match) {
      push(match[1]);
      continue;
    }
    match = /^Binary files\s+(.+?)\s+and\s+(.+?)\s+differ$/.exec(line);
    if (match) {
      push(match[1]);
      push(match[2]);
      continue;
    }
  }
  return [...new Set(out)];
}

/**
 * 找出 diff 里**不允许**出现的构造，并给出可复核的原因。
 *
 * 逐一拒绝：rename / copy、binary patch、`Binary files … differ`、
 * `old mode`/`new mode`（含 mode change），以及任何非 100644 的 mode。
 * 目的是让「diff 目标都在 scope.outputs 内」这条约束**不能被绕过**：
 * 只要头部里出现一个作用域外的路径，整个提案就被拒。
 */
function diffForbiddenConstructs(diff) {
  const forbidden = [];
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r/g, '');
    if (/^diff --git\s/.test(line)) continue; // 已在 diffTargetPaths 里按路径处理
    if (/^(?:rename|copy) (?:from|to)\s/.test(line)) {
      forbidden.push({ construct: 'rename-or-copy', line });
      continue;
    }
    if (/^GIT binary patch\s*$/.test(line)) {
      forbidden.push({ construct: 'git-binary-patch', line });
      continue;
    }
    if (/^Binary files\s/.test(line)) {
      forbidden.push({ construct: 'binary-files-differ', line });
      continue;
    }
    if (/^(?:old|new) mode\s+/.test(line)) {
      forbidden.push({ construct: 'mode-change', line });
      continue;
    }
    if (/^new file mode\s+/.test(line)) {
      const mode = line.replace(/^new file mode\s+/, '').trim();
      if (mode !== '100644') forbidden.push({ construct: 'non-100644-mode', line });
      continue;
    }
    if (/^deleted file mode\s+/.test(line)) {
      forbidden.push({ construct: 'deleted-file', line });
    }
  }
  return forbidden;
}

function validateDiff(diff, scope, outputKind) {
  if (diff === undefined || diff === null) {
    if (outputKind === 'script-diff') fail('AGENT_PROPOSAL_INVALID', 'a script-diff proposal must carry a diff');
    return '';
  }
  if (typeof diff !== 'string') fail('AGENT_PROPOSAL_INVALID', 'proposal.diff must be a string');
  if (diff.length > AGENT_BUDGET_LIMITS.maxOutputBytes) {
    fail('AGENT_PROPOSAL_INVALID', 'proposal.diff exceeds the platform output limit');
  }
  if (!diff.trim()) {
    if (outputKind === 'script-diff') fail('AGENT_PROPOSAL_INVALID', 'a script-diff proposal must carry a diff');
    return '';
  }
  if (outputKind !== 'script-diff') {
    fail('AGENT_PROPOSAL_INVALID', `a ${outputKind} proposal must not carry a diff`);
  }
  if (!/^@@ .*@@/m.test(diff)) fail('AGENT_PROPOSAL_INVALID', 'proposal.diff is not a unified diff');

  // 不允许的构造先拒：rename / copy / binary / mode change。
  const forbidden = diffForbiddenConstructs(diff);
  if (forbidden.length) {
    fail('AGENT_PROPOSAL_OUT_OF_SCOPE', `proposal.diff uses a forbidden construct: ${forbidden[0].construct}`, {
      construct: forbidden[0].construct,
    });
  }

  // 头部里出现的**每一个**路径都要落在 scope.outputs 内。
  const targets = diffTargetPaths(diff);
  if (!targets.length) fail('AGENT_PROPOSAL_INVALID', 'proposal.diff does not name a target file');
  for (const target of targets) {
    if (path.isAbsolute(target)) {
      fail('AGENT_PROPOSAL_OUT_OF_SCOPE', `diff target ${target} is outside scope.root`, { target });
    }
    const absolute = path.resolve(scope.root, target);
    const rel = path.relative(scope.root, absolute);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      fail('AGENT_PROPOSAL_OUT_OF_SCOPE', `diff target ${target} is outside scope.root`, { target });
    }
    if (!TEST_SCRIPT_PATTERN.test(target)) {
      fail('AGENT_PROPOSAL_OUT_OF_SCOPE', `diff target ${target} is not a test script file`, { target });
    }
    if (!scope.outputs.includes(target)) {
      fail('AGENT_PROPOSAL_OUT_OF_SCOPE', `diff target ${target} is not listed in scope.outputs`, { target });
    }
  }
  return diff;
}

function validateEvidenceRefs(refs, request) {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs)) fail('AGENT_PROPOSAL_INVALID', 'proposal.evidenceRefs must be an array');
  if (refs.length > 64) fail('AGENT_PROPOSAL_INVALID', 'proposal.evidenceRefs accepts at most 64 entries');
  const known = new Set(request.inputs.map((input) => input.ref));
  const out = refs.map((ref) => {
    if (typeof ref !== 'string' || !ref.trim()) {
      fail('AGENT_PROPOSAL_INVALID', 'proposal.evidenceRefs entries must be non-empty strings');
    }
    if (!known.has(ref)) {
      fail('AGENT_PROPOSAL_OUT_OF_SCOPE', `evidence ref ${ref} is not part of the request provenance`, { ref });
    }
    return ref;
  });
  return out;
}

/**
 * 把模型返回的原始内容收敛成待审提案。
 *
 * 模型输出的 `approval`、`producedBy`、`id`、`createdAt` 一律**不采信**：审批状态
 * 与提案人由平台侧决定，模型不能给自己批「已通过」。
 */
export function validateAgentProposal(raw, request, context = {}) {
  if (!isPlainObject(raw)) fail('AGENT_PROPOSAL_INVALID', 'proposal must be an object');
  const outputKind = OUTPUT_KIND_BY_ROLE[request.role];
  if (raw.kind !== undefined && raw.kind !== outputKind) {
    fail('AGENT_PROPOSAL_INVALID', `proposal.kind must be ${outputKind} for role ${request.role}`, {
      kind: raw.kind,
    });
  }
  const summary = raw.summary === undefined ? '' : assertText(
    raw.summary, 'AGENT_PROPOSAL_INVALID', 'proposal.summary', 2000,
  );
  const actions = validateActions(raw.actions, outputKind);
  const diff = validateDiff(raw.diff, request.scope, outputKind);
  const evidenceRefs = validateEvidenceRefs(raw.evidenceRefs, request);

  let confidence;
  if (raw.confidence !== undefined && raw.confidence !== null) {
    if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)
      || raw.confidence < 0 || raw.confidence > 1) {
      fail('AGENT_PROPOSAL_INVALID', 'proposal.confidence must be a number between 0 and 1');
    }
    confidence = raw.confidence;
  }

  const required = REQUIRED_CAPABILITY_BY_OUTPUT[outputKind];
  if (!request.requestedCapabilities.includes(required)
    && !(context.capabilities || []).includes(required)) {
    fail('AGENT_CAPABILITY_NOT_GRANTED', `role ${request.role} needs capability ${required}`, {
      capability: required,
    });
  }
  if (outputKind === 'script-diff' && !evidenceRefs.length) {
    fail('AGENT_PROPOSAL_INVALID', 'a script-diff proposal must cite at least one provenance ref');
  }

  return {
    id: `agprop_${crypto.randomUUID()}`,
    contract: AGENT_CONTRACT_VERSION,
    requestId: request.id,
    role: request.role,
    kind: outputKind,
    summary,
    actions,
    diff,
    evidenceRefs,
    confidence,
    approval: 'pending',
    // 提案人由平台侧决定。未提供 producedBy 时**不允许**落到 'unknown'：
    // 那样任何评审人都不等于它，自审检查就形同虚设。缺提案人即拒绝。
    producedBy: requireProducer(context),
    createdAt: context.now || new Date().toISOString(),
  };
}

/**
 * 取平台侧给出的提案人标识。
 *
 * 缺提案人时拒绝（`AGENT_PROPOSAL_INVALID`），而不是退化成 'unknown'——
 * 后者会让「提案人不得自审」这条约束在没有任何提案人的提案上失效。
 */
function requireProducer(context) {
  const producedBy = context.producedBy;
  if (typeof producedBy !== 'string' || !producedBy.trim()) {
    fail('AGENT_PROPOSAL_INVALID', 'the platform must supply context.producedBy');
  }
  return producedBy;
}

/* --------------------------------------------------------------- provider */

/**
 * ModelProvider 契约（ATS-401 只定义形状，实现属 ATS-403）。
 *
 * complete(request, ctx) -> Promise<{ text: string }>
 *   request: 见 buildProviderRequest —— 指令与输入内容分列，模型不能把输入当指令。
 *   ctx.deadlineAt: 绝对时间戳（epoch ms），provider 应当尊重它。
 */
export function createModelProvider({ id, complete }) {
  if (typeof id !== 'string' || !id.trim()) {
    fail('AGENT_PROVIDER_INVALID', 'provider id must be a non-empty string');
  }
  if (typeof complete !== 'function') {
    fail('AGENT_PROVIDER_INVALID', 'provider complete must be a function');
  }
  return Object.freeze({ id, complete });
}

export function buildProviderRequest(request, transmitted) {
  return {
    contract: AGENT_CONTRACT_VERSION,
    role: request.role,
    outputKind: OUTPUT_KIND_BY_ROLE[request.role],
    instructions: request.instructions,
    scope: request.scope,
    budget: request.budget,
    inputs: transmitted.map((input) => ({
      kind: input.kind,
      ref: input.ref,
      digest: input.digest,
      content: input.content,
      retrievedAt: input.retrievedAt,
    })),
  };
}

/* ---------------------------------------------------------------- adapter */

export function createAgentAdapter({
  adapterId,
  role,
  capabilities = [],
  provider,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof adapterId !== 'string' || !adapterId.trim()) {
    fail('AGENT_REQUEST_INVALID', 'adapter id must be a non-empty string');
  }
  if (!AGENT_ROLES.includes(role)) {
    fail('AGENT_ROLE_UNKNOWN', `role must be one of ${AGENT_ROLES.join(', ')}`);
  }
  if (!Array.isArray(capabilities)) {
    fail('AGENT_CAPABILITY_NOT_GRANTED', 'capabilities must be an array');
  }
  const allowed = AGENT_CAPABILITIES[role];
  for (const capability of capabilities) {
    if (FORBIDDEN_CAPABILITIES.includes(capability)) {
      fail('AGENT_CAPABILITY_FORBIDDEN', `capability ${capability} is forbidden by the agent contract`, {
        capability,
      });
    }
    if (!allowed.includes(capability)) {
      fail('AGENT_CAPABILITY_NOT_GRANTED', `role ${role} does not grant capability ${capability}`, {
        capability,
      });
    }
  }
  if (!provider || typeof provider.complete !== 'function') {
    fail('AGENT_PROVIDER_INVALID', 'adapter requires a provider with a complete() function');
  }

  return Object.freeze({
    adapterId,
    role,
    capabilities: Object.freeze([...capabilities]),
    describe() {
      return {
        contract: AGENT_CONTRACT_VERSION,
        adapterId: this.adapterId,
        role: this.role,
        capabilities: [...this.capabilities],
        outputKind: OUTPUT_KIND_BY_ROLE[this.role],
      };
    },
    /**
     * 执行一次契约调用：校验请求 → 校验出处摘要 → 施加预算 → 调用 provider →
     * 收敛为待审提案。
     */
    async execute(rawRequest) {
      const request = validateAgentRequest(rawRequest);
      if (request.role !== role) {
        fail('AGENT_ROLE_MISMATCH', `adapter role ${role} cannot serve role ${request.role}`);
      }
      for (const capability of request.requestedCapabilities) {
        if (!capabilities.includes(capability)) {
          fail('AGENT_CAPABILITY_NOT_GRANTED', `adapter ${adapterId} does not grant capability ${capability}`, {
            capability,
          });
        }
      }

      // 摘要一致性已在 validateAgentRequest() 内检查（请求校验层），
      // 因此 API 校验端点与适配器对同一请求给出同一个判定。

      const transmitted = request.inputs.filter((input) => request.egress.kinds.includes(input.kind));
      const inputBytes = Buffer.byteLength(
        transmitted.map((input) => input.content).join('\n'),
        'utf8',
      );
      if (inputBytes > request.budget.maxInputBytes) {
        fail('AGENT_BUDGET_EXCEEDED', 'input payload exceeds budget.maxInputBytes', {
          inputBytes,
          limit: request.budget.maxInputBytes,
        });
      }

      const startedAt = Date.now();
      const deadlineAt = startedAt + request.budget.deadlineMs;
      const providerRequest = buildProviderRequest(request, transmitted);

      // 截止时间是**强制**的，不是事后检查：provider 挂起时也必须返回。
      // AbortController 把 signal 交给 provider（它应当主动中止底层请求），
      // Promise.race 保证即使 provider 忽略 signal，适配器也会在 deadline
      // 到达时以 AGENT_BUDGET_EXCEEDED 结束这次调用。
      const controller = new AbortController();
      let timer = null;
      let timedOut = false;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve(TIMEOUT_SENTINEL);
        }, request.budget.deadlineMs);
        if (typeof timer.unref === 'function') timer.unref();
      });

      let response;
      try {
        response = await Promise.race([
          provider.complete(providerRequest, { deadlineAt, signal: controller.signal }),
          timeout,
        ]);
      } catch (error) {
        if (timedOut) {
          fail('AGENT_BUDGET_EXCEEDED', 'the call exceeded budget.deadlineMs', {
            deadlineMs: request.budget.deadlineMs,
          });
        }
        fail('AGENT_PROVIDER_ERROR', `provider ${provider.id} failed`, {
          provider: provider.id,
          cause: error && error.message ? error.message : String(error),
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (response === TIMEOUT_SENTINEL) {
        fail('AGENT_BUDGET_EXCEEDED', 'the call exceeded budget.deadlineMs', {
          deadlineMs: request.budget.deadlineMs,
        });
      }
      if (!isPlainObject(response) || typeof response.text !== 'string') {
        fail('AGENT_PROVIDER_OUTPUT_INVALID', `provider ${provider.id} returned no text`);
      }
      const outputBytes = Buffer.byteLength(response.text, 'utf8');
      if (outputBytes > request.budget.maxOutputBytes) {
        fail('AGENT_BUDGET_EXCEEDED', 'provider output exceeds budget.maxOutputBytes', {
          outputBytes,
          limit: request.budget.maxOutputBytes,
        });
      }
      if (Date.now() > deadlineAt) {
        fail('AGENT_BUDGET_EXCEEDED', 'the call exceeded budget.deadlineMs', {
          deadlineMs: request.budget.deadlineMs,
        });
      }

      let raw;
      try {
        raw = JSON.parse(response.text);
      } catch (error) {
        fail('AGENT_PROVIDER_OUTPUT_INVALID', 'provider output is not valid JSON', {
          provider: provider.id,
        });
      }

      const proposal = validateAgentProposal(raw, request, {
        producedBy: adapterId,
        capabilities: [...capabilities],
        now: now(),
      });

      return {
        proposal,
        usage: {
          inputBytes,
          outputBytes,
          steps: 1,
          elapsedMs: Date.now() - startedAt,
          transmittedRefs: transmitted.map((input) => input.ref),
        },
      };
    },
  });
}

/* ----------------------------------------------------------------- review */

/**
 * 判断两个身份标识是否指同一个人。
 *
 * 提案人不得自审这条规则不能靠**精确字符串比较**来守：`'gen-1 '`（多一个
 * 空格）与 `'GEN-1'`（大小写不同）都能绕过。因此这里按「规范化后比较」
 * 处理：去首尾空白 + 折叠内部空白 + 转小写。
 *
 * 这仍然只是**字符串层面的**身份判定，不是身份认证。真正的认证由平台侧
 * 负责（谁在评审必须来自登录态，而不是请求体里的一个字符串）——该实现
 * 尚未落地，属未验证项。
 */
function isSameActor(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const normalize = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return false;
  return left === right;
}

/**
 * 评审提案。评审人不得是提案人（ADR-006 的角色分离）；只有 `pending` 提案可评审。
 * 评审只改变审批状态，不改变提案内容。
 */
export function reviewAgentProposal(proposal, { reviewer, decision, note, now } = {}) {
  if (!isPlainObject(proposal)) fail('AGENT_REVIEW_STATE_INVALID', 'proposal must be an object');
  if (typeof reviewer !== 'string' || !reviewer.trim()) {
    fail('AGENT_REVIEWER_INVALID', 'reviewer must be a non-empty string');
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    fail('AGENT_REVIEW_STATE_INVALID', "decision must be 'approved' or 'rejected'");
  }
  if (proposal.approval !== 'pending') {
    fail('AGENT_REVIEW_STATE_INVALID', 'only a pending proposal can be reviewed', {
      approval: proposal.approval,
    });
  }
  if (isSameActor(proposal.producedBy, reviewer)) {
    fail('AGENT_REVIEW_SELF_FORBIDDEN', 'the producer of a proposal may not review it');
  }
  const reviewNote = note === undefined || note === null
    ? ''
    : assertText(note, 'AGENT_REVIEW_STATE_INVALID', 'review note', 2000);
  return {
    ...proposal,
    approval: decision,
    reviewedBy: reviewer,
    reviewedAt: now || new Date().toISOString(),
    reviewNote,
  };
}

/* -------------------------------------------------------------- describe */

/** 只读的契约描述。供 API 与文档引用，不含任何可写能力。 */
export function describeAgentContract() {
  return {
    contract: AGENT_CONTRACT_VERSION,
    roles: AGENT_ROLES.map((role) => ({
      role,
      capabilities: [...AGENT_CAPABILITIES[role]],
      outputKind: OUTPUT_KIND_BY_ROLE[role],
    })),
    forbiddenCapabilities: [...FORBIDDEN_CAPABILITIES],
    budgetLimits: { ...AGENT_BUDGET_LIMITS },
    requiredBudgetFields: [...REQUIRED_BUDGET_FIELDS],
    actionTypes: [...AGENT_ACTION_TYPES],
    inputKinds: [...INPUT_KINDS],
    errorCodes: [...AGENT_ERROR_CODES],
    proposalStates: ['pending', 'approved', 'rejected'],
    writePolicy: 'agents produce diffs only; applying a diff, updating expected results and committing are platform-side operations performed after review',
    reviewPolicy: 'the producer of a proposal may not review it',
  };
}
