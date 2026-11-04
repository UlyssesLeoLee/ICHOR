# ATS-AGT-001 Agent 契约 v1（Agent contract v1）

- WBS：ATS-401 ｜ 阶段 / 目标版本：S4 / v0.4.0 ｜ 工作流：Agent ｜ 主责：BE（后端 / Node Bridge）
- 契约版本标识：`agent-contract/v1` ｜ 实现载体：`server/agent.mjs`
- 关联要件：FR-024（AI 生成）、FR-025（AI 诊断）；NFR-009（隐私保护）
- 前置依赖：无
- 状态口径：本文件描述的是**已实现并经实测的契约层**。**模型调用未实现**——仓库中没有接入任何模型提供商，因此不存在「AI 已能生成脚本」这一事实。

## 1. 交付范围与边界

| 属于 ATS-401（本次已实现） | 不属于 ATS-401（后续任务） |
|---|---|
| Agent 请求的形状与校验（作用域、预算、输入出处） | 模型提供商实现与错误回退（ATS-403） |
| 角色与能力白名单 | API Key 存储与数据外传知情授权（ATS-402） |
| 提案（proposal）的形状、收敛规则与评审状态机 | 提案落地：应用 diff、更新 expected、Git 提交 |
| 提案评审（提案人不得自审） | 自主探索候选用例（ATS-514 / FR-029） |
| 本地 API 暴露：`GET /api/agent/contract`、`POST /api/agent/validate` | 与真实 Provider 的端到端链路 |

**完成定义（验收标准）的落实**：Agent 请求有作用域、预算、输入出处；不能直接保存/提交测试脚本。这两条在**契约层**已成立并有实测证据（§4）。「AI 生成脚本」这一端到端能力**未实现**，不得据此声称 FR-024 已实现。

## 2. 契约形状

### 2.1 请求

```jsonc
{
  "contract": "agent-contract/v1",
  "id": "agreq_<uuid>",
  "role": "planner | generator | triage | healer",
  "scope": {
    "projectId": "proj_...",
    "root": "<绝对路径>",
    "files":     ["tests/login.spec.ts"],   // 可读输入
    "outputs":   ["tests/login.spec.ts"],   // 允许被提案修改的目标（仅测试脚本）
    "runs":      ["run_..."],
    "requirements": ["REQ-001"]
  },
  "budget": {
    "maxInputBytes": 100000,
    "maxOutputBytes": 100000,
    "maxSteps": 4,
    "deadlineMs": 30000,
    "maxTokens": 8000                        // 可选
  },
  "instructions": "自然语言指令（≤8000 字符）",
  "requestedCapabilities": ["propose_script_diff"],
  "inputs": [{
    "kind": "file | requirement | run | evidence",
    "ref": "tests/login.spec.ts",
    "digest": "<sha256 十六进制>",
    "content": "<实际内容>",
    "retrievedAt": "<ISO-8601>"
  }],
  "egress": { "kinds": ["file"] }            // 未声明的输入不外传
}
```

三项硬约束：

- **作用域**：`root` 必须绝对；`files` / `outputs` 必须是 `root` 之下的相对路径，越界即拒；`outputs` 只能包含测试脚本文件（`.spec.*` / `.test.*`）。`files` / `runs` / `requirements` 至少声明一项。
- **预算**：四个字段必填且为正整数，且不得超过平台上限（`maxInputBytes` 4 MB、`maxOutputBytes` 1 MB、`maxSteps` 10、`deadlineMs` 600 s，下限 1 s）。
- **输入出处**：每个输入必须带 `kind` / `ref` / `digest` / `content`；`digest` 是内容的 SHA-256，适配器在调用模型**之前**逐个复算比对，不符即拒（`AGENT_PROVENANCE_DIGEST_MISMATCH`）。`ref` 必须落在已声明的作用域内，不在作用域内的材料请求方读不到。

### 2.2 角色与能力

| 角色 | 产出类型 | 能力上限 |
|---|---|---|
| `planner` | `test-intent` | `read_requirements`、`read_test_index`、`read_run_evidence` |
| `generator` | `script-diff` | 上述三项 + `propose_script_diff` |
| `triage` | `failure-classification` | `read_run_evidence` |
| `healer` | `diagnosis` | `read_run_evidence`、`propose_script_diff` |

**没有任何角色持有写入或提交能力。** 禁用能力清单（`FORBIDDEN_CAPABILITIES`）为：`write_source`、`save_source`、`git_commit`、`git_push`、`git_stage`、`update_expected`、`close_defect`、`spawn_process`、`read_secret`、`network_fetch`、`approve_proposal`。

### 2.3 提案与评审

提案经 `validateAgentProposal()` 收敛后固定为：

```jsonc
{
  "id": "agprop_<uuid>",
  "contract": "agent-contract/v1",
  "requestId": "agreq_...",
  "role": "generator",
  "kind": "script-diff",
  "summary": "...",
  "actions": [{ "type": "assert|goto|fill|click|comment|noop", "target": "...", "value": "..." }],
  "diff": "<unified diff 文本>",
  "evidenceRefs": ["tests/login.spec.ts"],
  "confidence": 0.8,
  "approval": "pending",
  "producedBy": "<平台侧适配器 id>",
  "createdAt": "<ISO-8601>"
}
```

收敛规则（**均由平台侧决定，不采信模型输出**）：

- `approval` **恒为 `pending`**。模型即使输出 `approval: "approved"` 也会被覆盖。
- `producedBy` 取平台侧适配器 id，不取模型自述。
- `diff` 只允许是 unified diff；其目标文件必须同时满足：**在 `scope.root` 之内**、**是测试脚本文件**、**列在 `scope.outputs` 之内**。三者任一不满足即 `AGENT_PROPOSAL_OUT_OF_SCOPE`。
- `script-diff` 提案必须引用至少一个输入出处（`evidenceRefs`），否则 `AGENT_PROPOSAL_INVALID`。
- 非 `script-diff` 类型的提案**不得携带 diff**。
- 评审：`reviewAgentProposal()` 只改审批状态，不改提案内容；`reviewer` 不得等于 `producedBy`（`AGENT_REVIEW_SELF_FORBIDDEN`）；只有 `pending` 可被评审。

### 2.4 ModelProvider 与 AgentAdapter

- `createModelProvider({ id, complete })`：**只定义形状**。`complete(request, ctx)` 接收构造好的 provider 请求（指令与输入内容分列，`ctx.deadlineAt` 为绝对截止时间戳），返回 `{ text }`。ATS-403 负责实现具体提供商与错误回退。
- `createAgentAdapter({ adapterId, role, capabilities, provider })`：执行一次契约调用，顺序为 **校验请求 → 校验角色匹配 → 校验能力 → 复算输入摘要 → 按 `egress.kinds` 筛选外传输入 → 校验输入字节预算 → 调用 provider → 校验输出字节预算与截止时间 → 解析 JSON → 收敛为待审提案**。

## 3. 权限边界的实现方式

「Agent 不能直接保存/提交测试脚本」在本实现中**不是一条约定，而是四条机制**：

| # | 机制 | 落点 | 失效时的表现 |
|---|---|---|---|
| 1 | 契约层只 import `node:crypto` 与 `node:path` | `server/agent.mjs` | 物理上无法写文件、起进程、发网络请求 |
| 2 | 能力白名单不含任何写入/提交能力；请求携带即拒 | `validateAgentRequest()` | `AGENT_CAPABILITY_FORBIDDEN` |
| 3 | 提案只承载 diff 文本；`approval` 恒为 `pending`；提案人不得自审 | `validateAgentProposal()` / `reviewAgentProposal()` | `AGENT_REVIEW_SELF_FORBIDDEN` |
| 4 | diff 目标必须在 `scope.outputs` 内且为测试脚本 | `validateDiff()` | `AGENT_PROPOSAL_OUT_OF_SCOPE` |

机制 1 之外的三条都在**请求/提案层**生效，因此**即使有人日后接入真实模型提供方**，边界依然成立——模型输出绕不过契约层的收敛。

**提案落地（应用 diff、更新 expected、Git 提交）在本仓库中不存在对应代码路径**：契约层不提供 apply 能力，`server/index.mjs` 也没有写入提案的端点。落地是评审通过之后的**平台侧人工/受控流程**，不属于本任务。

## 4. 实测证据

### 4.1 单元与集成测试（UT/IT）

`npm test`（Node v24.19.0）：**59 项全通过**，其中新增 39 项（28 项 `UT-AGT-*` 契约单元测试 + 11 项 `IT-AGT-*` API 集成测试），原有 20 项无回归。原始输出见 `docs/evidence/ATS-401/01-node-test.log`。

新增用例覆盖：

- 契约版本与角色集合固定（UT-AGT-001）
- 任何角色都不持有写入/提交能力（UT-AGT-002）
- 作用域：绝对根、至少一个输入目标、越界路径、非测试脚本输出（UT-AGT-003~005、016）
- 预算：必填、整数、上下限（UT-AGT-006）
- 输入出处：必填、在作用域内、摘要格式（UT-AGT-007~008）
- 禁用能力、未知契约版本、未知角色、角色能力上限（UT-AGT-009~012）
- diff 越界/非测试脚本/提案无出处（UT-AGT-013~015、018）
- 审批恒为 pending、提案人不得自审、仅 pending 可评审（UT-AGT-017、019、020）
- 适配器：构造期能力检查、角色不匹配、摘要不符、输出非 JSON、输出超预算（UT-AGT-021~026）
- 未声明外传的输入不外传（UT-AGT-027）
- 契约描述不含可写能力（UT-AGT-028）
- API：契约端点、鉴权、校验端点的各类拒绝、校验无写入副作用（IT-AGT-001~009）

### 4.2 可重跑复现探针

`node tools/ats401-probes/probe-agent-boundary.mjs`（原始输出见 `docs/evidence/ATS-401/02-agent-boundary.log`）。探针用**三类独立信号**证明边界：

| 信号 | 内容 |
|---|---|
| 1a 静态分析 | `server/agent.mjs` 的 import 清单中不含 `node:fs` / `node:child_process` / `node:net` / `node:http` / `node:https` 等 10 个 I/O 模块 |
| 1b 运行期 | 在一个真实 git 夹具仓库上完整跑一次契约调用后，**文件内容、`git status`、`git log` 全部不变** |
| 1c **负控** | 对故意被破坏的源码副本（分别注入 `node:fs` / `node:child_process` / `node:https`）跑同一段判定逻辑，**必须报警**——证明判定不是恒真 |
| 2 运行期 | `write_source` / `git_commit` / `git_push` / `update_expected` / `approve_proposal` 一律被 `AGENT_CAPABILITY_FORBIDDEN` 拒绝；4 个角色的能力集合与禁用清单无交集 |
| 3 运行期 | diff 越界 / 指向非测试脚本 / 越出项目根，一律被 `AGENT_PROPOSAL_OUT_OF_SCOPE` 拒绝；提案人自审被 `AGENT_REVIEW_SELF_FORBIDDEN` 拒绝 |

信号 1c 是**负控**：没有它，1a 的 PASS 只说明「当前源码没有 import」，无法区分「判定有效」与「判定恒真」。

### 4.3 错误码

契约错误码是稳定契约的一部分（`AGENT_ERROR_CODES`，共 25 个），调用方按 `err.code` 分支，不解析消息文本。`server/index.mjs` 将 `AGENT_*` 前缀的错误统一映射为 **HTTP 400**（请求不满足契约属于客户端错误），并把错误码原样返回。

| 类别 | 错误码 |
|---|---|
| 请求形状 | `AGENT_REQUEST_INVALID`、`AGENT_CONTRACT_UNSUPPORTED`、`AGENT_ROLE_UNKNOWN`、`AGENT_ROLE_MISMATCH` |
| 作用域 | `AGENT_SCOPE_REQUIRED`、`AGENT_SCOPE_INVALID`、`AGENT_SCOPE_ESCAPE`、`AGENT_SCOPE_OUTPUT_NOT_TEST_SCRIPT` |
| 预算 | `AGENT_BUDGET_REQUIRED`、`AGENT_BUDGET_INVALID`、`AGENT_BUDGET_EXCEEDED` |
| 输入出处 | `AGENT_PROVENANCE_REQUIRED`、`AGENT_PROVENANCE_INVALID`、`AGENT_PROVENANCE_OUT_OF_SCOPE`、`AGENT_PROVENANCE_DIGEST_MISMATCH` |
| 能力 | `AGENT_CAPABILITY_FORBIDDEN`、`AGENT_CAPABILITY_NOT_GRANTED` |
| 提供方 | `AGENT_PROVIDER_INVALID`、`AGENT_PROVIDER_ERROR`、`AGENT_PROVIDER_OUTPUT_INVALID` |
| 提案 | `AGENT_PROPOSAL_INVALID`、`AGENT_PROPOSAL_OUT_OF_SCOPE` |
| 评审 | `AGENT_REVIEWER_INVALID`、`AGENT_REVIEW_STATE_INVALID`、`AGENT_REVIEW_SELF_FORBIDDEN` |

## 5. API 面

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/agent/contract` | token | 返回契约描述：角色、能力、禁用清单、预算上限、错误码、写入与评审策略 |
| POST | `/api/agent/validate` | token | **只校验**一个请求是否满足契约。不调用模型，不写项目。返回归一化后的作用域、预算与输入出处摘要 |

`GET /api/diagnostics` 增加 `agentContract` 字段：`version=agent-contract/v1`、`status=CONTRACT_ONLY`，并明写「未接入模型提供商，因此没有任何 Agent 请求能到达模型」。

## 6. 未实现与后续

| 项 | 归属 | 说明 |
|---|---|---|
| 模型提供商实现、重试与回退 | ATS-403 | 本次只定义 `ModelProvider` 形状 |
| API Key 存储、数据外传知情授权 | ATS-402 | 本次的 `egress.kinds` 只是一个契约槽位，**未绑定任何真实授权记录**；未声明外传时输入不外传 |
| 提案落地（应用 diff / 更新 expected / 提交 Git） | 平台侧受控流程 | 契约层不提供 apply 能力，仓库中亦无对应代码路径 |
| Reviewer 界面与 diff 审阅 UI | P1 | 契约层提供状态机，界面未实现 |
| 自主探索候选用例（FR-029） | ATS-514 | 不在本次范围 |

**不得声称的能力**：仓库中没有任何代码把模型输出写入仓库、更新 expected result 或创建 Git commit。FR-024 / FR-025 仍为 `DESIGNED`，本次交付的是它们**依赖的契约层**，不是它们本身。

## 7. 复现命令

```bash
# 单元与集成测试（Node 22+）
npm test

# 权限边界复现探针
node tools/ats401-probes/probe-agent-boundary.mjs
```

探针的中间产物（git 夹具仓库）落在 `$TMPDIR/ats401-probes`（可用 `ATS_PROBE_WORKDIR` 覆盖），不进版本控制。
