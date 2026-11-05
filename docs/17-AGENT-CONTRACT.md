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
- **输入出处**：每个输入必须带 `kind` / `ref` / `digest` / `content`；`digest` 是内容的 SHA-256，适配器在调用模型**之前**逐个复算比对，不符即拒（`AGENT_PROVENANCE_DIGEST_MISMATCH`）。`ref` 必须落在已声明的作用域内。**注意这条保证的边界**：`digest` 与 `content` 都由请求方提供，因此本层证明的是「二者自洽」加上「`ref` 在作用域内」，**不能**证明 `content` 确实来自 `ref` 所指的那份源文件——「`ref` 对应真实源内容」由平台侧构造请求时负责，该实现尚未落地（见 §6 未验证项）。

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
- `diff` 只允许是 unified diff，且必须符合**白名单语法**（见下）。白名单里出现过的每一个路径都必须同时满足：**在 `scope.root` 之内**、**是测试脚本文件**、**列在 `scope.outputs` 之内**。任一不满足即 `AGENT_PROPOSAL_OUT_OF_SCOPE`。
- diff 头部行按 CRLF 归一化后再匹配，因此 CRLF diff 不能靠行尾 `\r` 跳过检查。
- **白名单语法**（`parseDiffSegments()`）：只接受下面这些头部行，其余一律 `AGENT_PROPOSAL_OUT_OF_SCOPE`：
  - `diff --git a/P b/P` —— **可选**（`git apply` 也接受裸的 unified diff）；出现时两侧的 P 必须相同；
  - `index <hex>..<hex>` —— 可选，可带 ` 100644`；
  - `new file mode 100644` —— 可选；
  - `--- a/P`（或 `--- /dev/null`）与 `+++ b/P`。
- **路径必须带 `a/` 或 `b/` 前缀**（`/dev/null` 除外）。`git apply` 默认按 `-p1` 剥掉路径的第一段：不带前缀的 `+++ tests/login.spec.ts` 在 git 看来是仓库根目录下的 `login.spec.ts`，与校验器看到的 `tests/login.spec.ts` 不是同一个文件。为保证「校验器判定的路径 == git 解析出的路径」，不带前缀的路径一律拒绝。
- **hunk 的消费方式与 `git apply` 的解析器一致**（第 3 次复核整改，见下）：
  - **空行是一行上下文**，旧行数与新行数各加 1；
  - 旧、新两个计数**同时**达到声明值时，这个 hunk 立即结束，状态回到「头部」；
  - 此后出现的 `--- `/`+++ ` 开启**新的一段**，必须完整校验，**不能**被当作上一个 hunk 的体吞掉；
  - hunk 体内计数**超出**声明值即拒绝（git 报 `corrupt patch`）；
  - 两处例外必须保留，否则合法的 diff 会被误拒：**(a)** 输入末尾的换行不算一行（`split('\n')` 得到的最后一个空串既不计为上下文，在头部状态下也不算非法头）；**(b)** hunk 结束之后**紧跟的一行** `\ No newline at end of file` 仍然合法。
- **被拒绝**的构造（旧式的 `rename old/new`、`copy from/to`、`similarity`/`dissimilarity index`、`Index:`、`***` 上下文 diff 头、`GIT binary patch`、`Binary files … differ`、`old/new mode`、任何非 `100644` 的 mode、`deleted file mode`）。**删除一律拒绝**——`+++ /dev/null` 即使没有 `deleted file mode` 行也按删除处理，与 `deleted file mode` 同一口径。新建测试脚本（`--- /dev/null` + `new file mode 100644`，且路径在 `scope.outputs` 内）是允许的。
- **带引号的路径**按 git 的 C 风格转义规则**完整**反转义后再做作用域判定（`unquoteGitPath()`：`\a \b \t \n \v \f 
 \" \\ \NNN` 八进制）。转义不合法时直接拒绝——只实现一半的反转义会让校验结果与 git 实际解析出的路径不一致。**解码结果不是合法 UTF-8（或含 U+FFFD）时同样拒绝**：`toString('utf8')` 会把非法字节静默变成替换字符，得到的路径与 git 写入磁盘的字节不是同一个路径。
- `script-diff` 提案必须引用至少一个输入出处（`evidenceRefs`），否则 `AGENT_PROPOSAL_INVALID`。
- 非 `script-diff` 类型的提案**不得携带 diff**。
- 评审：`reviewAgentProposal()` 只改审批状态，不改提案内容；`reviewer` 与 `producedBy` **规范化后**不得相同（去首尾空白、折叠内部空白、转小写），因此 `'gen-1 '` 与 `'GEN-1'` 同样被拒（`AGENT_REVIEW_SELF_FORBIDDEN`）；只有 `pending` 可被评审。
- 提案人由平台侧给出：`context.producedBy` 缺失时**拒绝**（`AGENT_PROPOSAL_INVALID`），不退化为 `'unknown'`——否则「提案人不得自审」在无提案人的提案上会失效。
- 这仍只是**字符串层面的**身份判定，不是身份认证。评审人身份须来自登录态，该实现未落地（见 §6）。

### 2.4 ModelProvider 与 AgentAdapter

- `createModelProvider({ id, complete })`：**只定义形状**。`complete(request, ctx)` 接收构造好的 provider 请求（指令与输入内容分列，`ctx.deadlineAt` 为绝对截止时间戳），返回 `{ text }`。ATS-403 负责实现具体提供商与错误回退。
- `createAgentAdapter({ adapterId, role, capabilities, provider })`：执行一次契约调用，顺序为 **校验请求（含复算输入摘要）→ 校验角色匹配 → 校验能力 → 按 `egress.kinds` 筛选外传输入 → 校验输入字节预算 → 调用 provider（受截止时间约束）→ 校验输出字节预算 → 解析 JSON → 收敛为待审提案**。
- **截止时间是被强制施加的**：`AbortController` 的 `signal` 与 `ctx.deadlineAt` 一起交给 provider，`Promise.race` 保证 provider 挂起时本次调用也在 `deadlineMs` 到达时以 `AGENT_BUDGET_EXCEEDED` 结束（不是事后检查）。
- **`maxSteps` 目前只做上限校验，未被施加**：一次 `execute()` 就是一步（`usage.steps` 恒为 1），多步循环属 ATS-403。

## 3. 权限边界的实现方式

「Agent 不能直接保存/提交测试脚本」在本实现中**不是一条约定，而是四条机制**：

| # | 机制 | 落点 | 失效时的表现 |
|---|---|---|---|
| 1 | 契约层的**源码**不含 I/O 调用：只 import `node:crypto`/`node:path`，且不引用 `fetch`/`process`/`globalThis`/`WebSocket`/动态 `import`/`require`/`process.getBuiltinModule` | `server/agent.mjs` | **静态检查**报出违规（`tools/ats401-probes/lib/contract-purity.mjs`，带 11 项负控） |
| 2 | 能力白名单不含任何写入/提交能力；请求携带即拒 | `validateAgentRequest()` | `AGENT_CAPABILITY_FORBIDDEN` |
| 3 | 提案只承载 diff 文本；`approval` 恒为 `pending`；提案人不得自审 | `validateAgentProposal()` / `reviewAgentProposal()` | `AGENT_REVIEW_SELF_FORBIDDEN` |
| 4 | diff 必须符合**白名单语法**，且白名单里出现的目标路径都必须在 `scope.outputs` 内并为测试脚本 | `validateDiff()` / `parseDiffSegments()` | `AGENT_PROPOSAL_OUT_OF_SCOPE` |

机制 2、3、4 都在**请求/提案层**生效，因此**即使有人日后接入真实模型提供方**，边界依然成立——模型输出绕不过契约层的收敛。

**关于机制 4 的准确表述**：第 1 轮整改用的是**黑名单**（逐一列举已知的危险构造），第 2 次复核证明了黑名单追不上 git 的解析器——`git apply` 仍然接受清单里没有的写法（旧式 `rename old/new` 头就是一个实例），于是「diff 目标都在 `scope.outputs` 内」仍可被绕过。因此第 2 轮整改改为**白名单语法**：只有明确列出的头部形式被接受，其余一律拒绝。

第 3 次复核进一步发现：第 2 轮的白名单**解析方式**本身与 `git apply` 不一致——空行没有被计为上下文行，导致校验器在 hunk 结束后仍停在 hunk 状态，把紧随其后的 `---`/`+++` 当作 hunk 体吞掉（空行脱同步绕过）；不带 `a/`/`b/` 前缀的路径也没有被拒（`git apply` 默认 `-p1` 会剥掉第一段，校验器与 git 对「改的是哪个文件」产生分歧）。本轮整改把解析器**逐条对齐到 `git apply` 的实际行为**（hunk 的消费规则、路径前缀、删除一律拒绝），并把「校验器判定的路径 == git 解析出的路径」作为硬要求。

**这条保证的强度**：在本仓库的**双向差分语料**上（`tools/ats401-probes/probe-git-apply-bidirectional.mjs`：复核的 3 个反例 + 对合法 diff 的自动变异 + 真实 `git diff` 输出），校验器与 `git apply --numstat --summary` 的判定一致——校验器接受的每一个输入，git 报告的路径都落在 `scope.outputs` 内，且没有 create（outputs 之外）/ delete / rename / mode 变更。**这是「在该语料上一致」的结论，不是「与 git 完全等价」的结论**；语料之外的 diff 形式未被证明。平台侧落地前仍必须再用 `git apply --check --numstat --summary` 校验一次，以 git 自己的解析器为准（见 §2.3）。

**关于机制 1 的准确表述**：它是一条**静态检查**，证明契约层的源码不含 I/O 调用；它**不是**「物理上无法」。Node 运行时并不阻止模块使用 `fetch`、`process`、`globalThis`、`process.getBuiltinModule`、动态 `import()` 或 `require`，因此真正的隔离（模块沙箱、只读挂载、子进程沙箱）**不在本任务范围**，属平台侧（ATS-403）。第 1 次复核指出旧表述「物理上无法」高估了该机制的强度，本节已按实测改为上述口径；`tools/ats401-probes/lib/contract-purity.mjs` 的 11 项负控证明该检查不是恒真。

**提案落地（应用 diff、更新 expected、Git 提交）在本仓库中不存在对应代码路径**：契约层不提供 apply 能力，`server/index.mjs` 也没有写入提案的端点。落地是评审通过之后的**平台侧人工/受控流程**，不属于本任务。

## 4. 实测证据

### 4.1 单元与集成测试（UT/IT）

`npm test`（Node v24.19.0）：**177 项，170 通过、7 跳过、0 失败**，其中 Agent 契约相关 90 项（`UT-AGT-*` 契约单元测试 68 项 + 第 3 次复核整改新增的 UT-AGT-074~085 共 12 项 + `IT-AGT-*` API 集成测试 22 项），原有 20 项无回归。7 项跳过是 ATS-301 的 fixture 集成测试（`examples/sample-playwright` / `examples/sample-wdio` 未安装依赖），不是本任务引入。原始输出见 `docs/evidence/ATS-401/01-node-test.log`。

新增用例覆盖：

- 契约版本与角色集合固定（UT-AGT-001）
- 任何角色都不持有写入/提交能力（UT-AGT-002）
- 作用域：绝对根、至少一个输入目标、越界路径、非测试脚本输出（UT-AGT-003~005、016、051）
- 预算：必填、整数、上下限、`maxTokens`（UT-AGT-006、040）
- 输入出处：必填、在作用域内、摘要格式、逐字段校验（UT-AGT-007~008、052~053）
- 禁用能力、未知契约版本、未知角色、角色能力上限、请求字段校验（UT-AGT-009~012、054）
- diff 越界/非测试脚本/提案无出处（UT-AGT-013~015、018）
- **diff 绕过的七类反例**：rename、copy、mode change、CRLF 头部、binary patch、`Binary files … differ`、越界的 `diff --git` 头；以及允许在 `scope.outputs` 内新建测试脚本（UT-AGT-029~038）
- **摘要复算**：请求校验层拒绝摘要不符的输入（UT-AGT-039、IT-AGT-010）
- 审批恒为 pending、提案人不得自审、仅 pending 可评审、评审参数校验（UT-AGT-017、019、020、065）
- 适配器：构造期能力检查、角色不匹配、输出非 JSON、输出超预算、输入超预算、provider 抛错、provider 无 text、**provider 挂起时截止时间被强制施加**、provider 上下文带 `AbortSignal`（UT-AGT-021~027、041~045、062~064、066）
- 提案的 actions / confidence / evidenceRefs / kind 校验（UT-AGT-046~047、049、056、059~060、064）
- **契约层源码不含 I/O 调用**的静态检查（UT-AGT-050）
- 未声明外传的输入不外传（UT-AGT-027）
- 契约描述不含可写能力（UT-AGT-028）
- API：契约端点、鉴权、校验端点的各类拒绝、校验无写入副作用、**错误附带 `details` 且不含本机路径**、**非 agent 错误保持 ATS-401 之前的行为**（IT-AGT-001~013）
- **第 3 次复核整改**：hunk 的消费方式与 git 对齐（空行计为一行上下文、两个计数同时达标即结束、其后的 `---`/`+++` 另起一段并完整校验、计数超限即拒）、两处例外（末尾换行不算一行、hunk 之后紧跟的 `\ No newline` 标记仍合法）、路径必须带 `a/`/`b/` 前缀、`+++ /dev/null` 按删除拒绝、非 UTF-8 引号路径拒绝、路径越界先于「有无 hunk」判定（UT-AGT-074~084）
- **截止时间在无其它活动句柄的进程里仍然生效**（UT-AGT-085）

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

### 4.3 覆盖率（实测）

`node --test --experimental-test-coverage tests/*.test.mjs`（Node v24.19.0，原始输出见 `docs/evidence/ATS-401/04-coverage.log`）：

| 文件 | 行覆盖 | 分支覆盖 | 函数覆盖 |
|---|---|---|---|
| `server/agent.mjs` | **97.52 %** | 85.25 % | 95.56 % |
| `tools/ats401-probes/lib/contract-purity.mjs` | 88.24 % | 95.74 % | 85.71 % |

第 1 次复核时 `server/agent.mjs` 的行覆盖为 82.17 %，复核意见点名的零覆盖分支（输入超预算、截止时间超时、provider 抛错、provider 无 text、预算四项上下限、`maxTokens`、`validateActions`、confidence、evidence 类出处）已全部补上用例（UT-AGT-029~068）。

### 4.4 第 1 次复核的反例回归探针

`node tools/ats401-probes/probe-review-regressions.mjs`（原始输出见 `docs/evidence/ATS-401/05-review-regressions.log`）。该探针把第 1 次复核提交的反例固化成断言，分为五组：

| 组 | 反例 | 期望 |
|---|---|---|
| A | 合法 hunk 后追加 rename / copy / mode change / CRLF 头部 / binary patch / `Binary files … differ` / 越界的 `diff --git` 头 | 一律 `AGENT_PROPOSAL_OUT_OF_SCOPE` |
| B | `process.getBuiltinModule('node:fs')`、裸 `fetch()`、动态 `import('node:child_process')`、双引号 `from "node:fs"` | 静态检查全部报警 |
| C | 摘要与内容不符 | 请求校验层与适配器**同时**拒绝 |
| D | provider 挂起 | 截止时间到达即以 `AGENT_BUDGET_EXCEEDED` 结束（实测 1006 ms） |
| E | `AGENT_*` 错误 vs 其它带 `code` 的错误 | 前者 400 + `details`；后者保持 ATS-401 之前的行为 |

### 4.5 与 git apply 的双向差分探针

`node tools/ats401-probes/probe-git-apply-bidirectional.mjs`（原始输出见 `docs/evidence/ATS-401/08-git-apply-bidirectional.log`）。这是第 3 次复核整改的核心证据，分五节：

| 节 | 内容 | 期望 |
|---|---|---|
| A **正向** | 语料里的每一个输入先过校验器；**校验器接受的每一个**输入再交给 `git apply --numstat --summary` | git 报告的路径全部落在 `scope.outputs` 内，且无越界 create / delete / rename / mode 变更 |
| B | 复核提交的 3 个反例 | 校验器全部拒绝 |
| C **反向** | 真实的 `git diff` 输出 | 校验器全部接受：含空白上下文行、文件末尾没有换行、新建 spec 文件 |
| D | 当场跑 `git diff`，核对语料里的三种形状确实是 git 自己产出的 | 语料不能与 git 脱节 |
| E **负控** | 当场造出真实的 rename / delete / mode change，把 git 自己的 `--summary` 输出喂给 A 节用的那三个判定 | 三个判定都命中——证明 A 节不是恒真 |

语料包含：复核的 3 个反例；对合法 diff 的自动变异（插入空行、去掉 `a/` `b/` 前缀、改成 `/dev/null`、在 hunk 之后追加 `---`/`+++` 段、超出声明的 hunk 计数、重命名、改 mode、去掉 `index` 头）；以及三种真实 `git diff` 输出。

verdict 文案限定为「在该语料上一致」：**PASS: on this corpus (15 inputs, 5 accepted), the contract whitelist and git apply agree in both directions**。这是语料上的一致，不是与 git 完全等价（见 §2.3「关于机制 4 的准确表述」）。

E 节不是形式主义：它发现并修掉了一个**恒真的检查**——原先的 rename 判定写的是 `/\brename (from|to)\b/`，而 git 的 `--summary` 实际输出 `rename old => new (100%)`，从来不打印 `rename from`/`rename to`（那是 `diff --raw` 的格式），所以那个正则在任何输入上都不匹配，判定永远为「没有 rename」。

### 4.6 WBS updater 的 XML 转义

`python tools/ats401-probes/check_wbs_xml_escape.py`（原始输出见 `docs/evidence/ATS-401/09-wbs-xml-escape.log`）。把含 `<`、`>`、`&` 的注记写进 ATS-401 的 T 单元格，然后检查：zip 完整、每个 XML 成员仍能解析、文本节点里没有裸的 `<` 或 `&`、读回来的文本与写进去的一致。

这条检查是**承重**的：工作簿的 sheet XML 是手写的，值直接拼进 `<x:v>`，不转义的话 `<24hex>` 这类文本会被裸写进去，`<` 被解析器当成标签起点，文件直接损坏。修复见 `tools/wbs_common.py` 的 `xml_escape()` / `xml_unescape()`——写入时转义、读取时解码，读写对称才能保证 updater 连跑两次字节不变。

### 4.7 错误码

契约错误码是稳定契约的一部分（`AGENT_ERROR_CODES`，共 25 个），调用方按 `err.code` 分支，不解析消息文本。`server/index.mjs` 将 `AGENT_*` 前缀的错误统一映射为 **HTTP 400**（请求不满足契约属于客户端错误），并把错误码原样返回，**同时附带 `details`**（出错的字段、上限、目标路径等契约级信息；不含本机路径）。

**这个映射的作用域仅限 `AGENT_*` 错误**：其它错误保持 ATS-401 之前的行为不变（按消息模式定状态码、原样回显消息）。非 agent 错误消息里回显本机绝对路径是**既有缺陷**，归属 ATS-112（`docs/16-BASELINE-ADR.md` §3.2），不由本任务处理。

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
| POST | `/api/agent/validate` | token | **只校验**一个请求是否满足契约。不调用模型，不写项目。返回归一化后的作用域、预算与输入出处摘要。**与适配器同一套判定**：摘要不符同样返回 `AGENT_PROVENANCE_DIGEST_MISMATCH` |

`GET /api/diagnostics` 增加 `agentContract` 字段：`version=agent-contract/v1`、`status=CONTRACT_ONLY`，并明写「未接入模型提供商，因此没有任何 Agent 请求能到达模型」。

## 6. 未实现与后续

| 项 | 归属 | 说明 |
|---|---|---|
| 模型提供商实现、重试与回退 | ATS-403 | 本次只定义 `ModelProvider` 形状 |
| API Key 存储、数据外传知情授权 | ATS-402 | 本次的 `egress.kinds` 只是一个契约槽位，**未绑定任何真实授权记录**；未声明外传时输入不外传 |
| 提案落地（应用 diff / 更新 expected / 提交 Git） | 平台侧受控流程 | 契约层不提供 apply 能力，仓库中亦无对应代码路径 |
| Reviewer 界面与 diff 审阅 UI | P1 | 契约层提供状态机，界面未实现 |
| 自主探索候选用例（FR-029） | ATS-514 | 不在本次范围 |
| 运行时隔离（模块沙箱 / 只读挂载 / 子进程沙箱） | ATS-403 | 机制 1 是**静态检查**，不是运行时隔离。契约层源码当前不含 I/O 调用，但 Node 运行时并不阻止这些能力 |
| 「`ref` 对应真实源内容」的构造 | ATS-402 / 平台侧 | 本层只保证「摘要与内容自洽」且「`ref` 在作用域内」。平台侧读取真实文件并计算摘要的代码路径尚未实现 |
| `maxSteps` 的实际施加 | ATS-403 | 本次只校验上限；一次 `execute()` 为一步。多步循环未实现 |
| 符号链接的路径校验 | 平台侧 | 路径校验是纯词法的，不解析符号链接。落地时平台侧必须做 realpath |
| `projectId` 与已登记项目的绑定 | 平台侧 | `/api/agent/validate` 不校验 `projectId`/`root` 是否属于已登记项目 |
| 评审人身份的**认证** | 平台侧 | 自审检查是字符串层面的规范化比较，不是身份认证。评审人身份须来自登录态 |

**不得声称的能力**：仓库中没有任何代码把模型输出写入仓库、更新 expected result 或创建 Git commit。FR-024 / FR-025 仍为 `DESIGNED`，本次交付的是它们**依赖的契约层**，不是它们本身。

## 7. 复现命令

```bash
# 单元与集成测试（Node 22+）
npm test

# 权限边界复现探针
node tools/ats401-probes/probe-agent-boundary.mjs

# 第 1 次复核反例的回归探针
node tools/ats401-probes/probe-review-regressions.mjs

# 覆盖率实测
node --test --experimental-test-coverage tests/*.test.mjs
```

探针的中间产物（git 夹具仓库）落在 `$TMPDIR/ats401-probes`（可用 `ATS_PROBE_WORKDIR` 覆盖），不进版本控制。
