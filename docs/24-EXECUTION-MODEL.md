# ATS-EXEC-001 执行模型设计书（ATS-208｜S2 / v0.2.0）

> 本文描述 **Run / Test / Attempt / ExecutionEvent 统一模型**的交付内容。
> 数据字典见 `docs/06-DATA-DESIGN.md` §5.4，状态机与事件流的接口面见
> `docs/04-DETAILED-DESIGN.md` §3。

## 1. 这一项交付的是什么

ATS-208 的交付物是「执行状态机 v2」：把执行模型的四个概念——**Run**（一次执行）、
**Test**（用例）、**Attempt**（用例的一次执行）、**ExecutionEvent**（执行事件）——
收敛到**一处**定义，并让两个验收标准成立：

| 验收标准 | 含义 |
|---|---|
| 重试不覆盖初次尝试 | 被重试的用例只算**一个**用例，且**每一次**尝试都被保留 |
| 事件可按 run+sequence 复演 | 一个 run 的事件按序号折叠起来，得到该 run 的状态 |

## 2. 交付前的实测缺陷

交付前的行为由 `tools/ats208-probes/` 下的两个探针**实测**，不是推断。
下面是修复前后的对照（同一份夹具、同一台机器）：

| 场景 | 修复前（实测） | 修复后（实测） |
|---|---|---|
| 「先失败后通过」的用例的 summary | `total: 2, passed: 0, failed: 0, flaky: 2` | `total: 1, passed: 0, failed: 0, flaky: 1, executions: 2` |
| 该用例的初次尝试 | **丢失**（被摊平成独立的 case） | 保留：`retry=0, status=failed, error="first attempt failed"` |
| Bridge 被 SIGKILL 后的 run 状态 | `interrupted` | `interrupted` |
| 该 run 的事件流 | `run.queued`, `run.started`（**推不出任何状态**） | `run.queued`, `run.started`, `run.interrupted`（复演为 `interrupted`） |
| 事件的序号 | 无空洞，但**事件流不描述 run** | 无空洞、严格递增，**且可复演** |
| SQLite 层的 `events` 表 | **不存在** | 存在，主键 `(run_uid, seq)` |

缺陷的根因是**同一个概念有四套说法**：`core.mjs` 解析报告的词汇、`index.mjs`
写事件的词汇、两个适配器各自的「通用模型」、以及 SQLite 层的列名。它们各自
演进，于是互相矛盾。

## 3. 模型

实现在 `server/execution/model.mjs`，是**纯函数**模块：不读文件、不开套接字、
不碰时钟。这让它可以脱离 Bridge、浏览器和数据目录被精确断言，也让 Bridge、
两个适配器和 SQLite 层用**同一套**规则描述一次运行。

### 3.1 三个层级，两个状态词表

| 层级 | 含义 | 状态词表 |
|---|---|---|
| Run | 一次执行的**生命周期** | `queued` / `running` / `cancelling` / `passed` / `failed` / `cancelled` / `error` / `interrupted` |
| Case | 一个**用例整体** | `passed` / `failed` / `skipped` / `flaky` / `unknown` |
| Attempt | 用例的**一次执行** | 同 Case 词表，但描述的是这一次执行 |

`TERMINAL_RUN_STATUS` 是 run 永远不会离开的状态集合；其余状态都表示「还在飞」。

引擎词表到通用词表的映射只有**一张表**（`mapEngineStatus`）：

- Playwright（case 级）：`expected` / `unexpected` / `flaky` / `skipped` / `timedOut`
- Playwright（result 级）：`passed` / `failed` / `timedOut` / `skipped` / `interrupted`
- WebdriverIO：`passed` / `failed` / `pending` / `skipped`

**未知的状态映射为 `unknown`，不做猜测。** 报 `failed` 是凭空造一次失败，
报 `passed` 是凭空造一次成功。映射是**幂等**的：通用词表里的状态映射到自身，
所以对模型输出再映射一次不会把它毁掉。

### 3.1.1 状态与判定：两个不同的词表

**status 说的是「发生了什么」，outcome 说的是「是否符合声明」。**

只看 attempt 的原始状态，会把 `test.fail()` 的**预期失败**算成 `failed`
用例。而 Playwright 自己的判定是 `expected`、引擎退出码是 0——summary 与
退出码自相矛盾。实测症状：一个 Playwright 判定为 `passed` 的 run，summary
报 `failed: 1`。

因此模型有第二个词表：

| 词表 | 含义 | 取值 |
|---|---|---|
| `status` | 发生了什么 | `passed` / `failed` / `skipped` / `flaky` / `unknown` |
| `outcome` | 是否符合声明 | `expected` / `unexpected` / `flaky` / `skipped` / `unknown` |

- 引擎声明了 `expectedStatus`（`test.fail()` 之后是 `failed`）时，这一次执行
  的 outcome 是 `expected` 或 `unexpected`；引擎没声明时 outcome 是 `unknown`
  ——**不猜测**。
- Case 的 outcome 由它**各 project** 的 outcome 聚合：某个 project
  `unexpected` → `unexpected`；某个 project `flaky` → `flaky`；全部 `skipped`
  → `skipped`；否则 `expected`。
- Case 的**状态**在 outcome 已知时由 outcome 决定：`expected` 且全部 attempt
  失败 → `passed`（预期失败是成功）；`unexpected` 且全部 attempt 通过 →
  `failed`（意外通过是缺陷）。outcome 为 `flaky` 时不覆盖状态——状态聚合
  本来就知道重试有没有救回来。
- **Attempt 仍然保留自己的原始 `status` 和自己的错误**：预期失败的那一次
  执行确实失败了，这个事实不能因为它「符合预期」而消失。

**为什么需要各 project 的判定**：一个用例跨多个 project 时，「在 project b
里失败」（`failed`）和「第一次失败、重试通过」（`flaky`）的 attempt 分布看起来
一模一样（有的失败有的通过），只有引擎的判定能区分。模型因此在
`parseReport` 里读出每个 project 的判定并用它决定 Case 的状态。

### 3.2 「重试不覆盖初次尝试」

Playwright 报告是三层嵌套的：

```text
report.suites[]      suite
  suite.specs[]      spec   -- 一个用例
    spec.tests[]     test   -- 一个 project（chromium / firefox）
      test.results[] result -- 一次重试
```

旧解析器把这三层**摊平成一个列表**，这正是「重试用例被计两次、初次尝试被丢弃」
的来源。新解析器保留层级：**一个 spec 是一个 case，`results[]` 的每一项是该
case 的一个 attempt。**

Case 的状态是它**全部 attempt 的聚合**，规则是确定的：

1. 全部 skipped → `skipped`；
2. 全部 passed → `passed`；
3. 有 passed 也有 failed → `flaky`（重试救回来了）；
4. 全部 failed → `failed`；
5. 其余（含 `unknown`）→ `unknown`。

「先失败后通过」的用例是 **flaky 而不是 passed**——它需要过一次重试，只看
`passed` 的读者不会知道这一点。

其余规则：

- 计数器按 **case** 统计，执行次数单独记为 `executions`；
- **每一次 attempt 都被保留**，按顺序，各自带自己的状态、耗时和错误；
- case 报告的错误是它**第一次失败**的 attempt 的错误；
- 同一 case 的各 attempt 绑定到**同一个** TestDefinition UID（逐条绑定会让
  一个 flaky 用例的两个 attempt 落到两个 UID 上，历史就没法读了）。

**WDIO 的重试**：实测 @wdio/reporter 10.1.0，`test:start` 每次都推一条**新条目**，
所以一个重试用例在 suite 里表现为**连续同名**的两条条目；json reporter 不带重试
序号，因此重试序号就是条目在分组内的位置。适配器据此把连续同名的条目合并为
**一个 case 的多个 attempt**——与 Playwright 的形状一致。

**分组在第一个通过的条目处结束。** WDIO 的重试用例在**第一次通过时就停**，
所以**跟在一条通过条目之后**的同名条目不可能是它的重试——那是**另一个**恰好
同名的用例（同一 suite 里两个 `it('renders')`，或数据驱动循环里同名的用例）。
把它们合并会**藏掉一次真实的失败**：两个同名用例（第二个失败）会并成一个 flaky
case 且 `failed: 0`，失败的用例从 summary 里消失。因此一条通过的条目就结束它
所在的分组，同名的下一条另起一个分组。

剩下的歧义**写明而不猜测**：报告里 `[failed, passed]` 与「一个用例失败后重试
通过」在报告层面无法区分。适配器按重试读取（这是实测到的 reporter 形状支持的
读法），summary 里因此是一个 flaky case——它说的是「需要过一次重试」，不是
「失败了」。报告本身不带重试序号，因此没有适配器能做得更好。

### 3.3 「事件可按 run+sequence 复演」

事件流的性质：

1. **只追加**——事件永不重写；
2. **序号无空洞且严格递增**——一个 run 的序号是 1..N，中间没有洞，所以读者能
   分辨「run 到了第 7 个事件」和「第 7 个事件丢了」；
3. **可复演**——把事件按序号折叠起来，得到 run 当时的状态。

**实现规则**：事件写在**状态变更之前**（`run.queued` 除外，它在 run 仍是
`queued` 时写下），所以每个事件记录的是 run **正在离开**的那个状态；于是事件
流的最后一个事件就是决定终态的那个事件。

**状态机**（`RUN_TRANSITIONS`）会拒绝不可能的迁移，并把拒绝记到 stderr，
而不是默默写下去：一条与状态机矛盾的事件流会让复演失去意义，而静默的矛盾
比响亮的矛盾更糟。

ATS-208 补上了缺失的 **`run.interrupted`** 事件：Bridge 崩溃时写下它，因此
被打断的 run 也能复演为 `interrupted`。这是修复前该场景推不出任何状态的原因。

**复演同时校验状态机**：`replayEvents` 按 `RUN_TRANSITIONS` 逐条检查事件流，
答案带 `valid` 与 `violations`。一条违反状态机的流（例如
`[queued, started, finished(passed), interrupted]`）描述的是一个从未存在过
的 run，因此它**不得**报 `agrees: true`。

**复演同时校验序号**：一个 run 的序号是 1..N，两种破坏都要报出来。

- **丢失的序号**（`gaps`）：流的序号从 1 起算，所以**开头**缺号同样是缺口——
  只丢了开头几个事件的日志不是完好的日志，缺口在 `gaps` 里列出。
- **重复的序号**（`duplicates`）：两个事件带同一个序号。元数据层的主键
  `(run_uid, seq)` 会拒绝这样的一对，因此这样的流**不描述**一个 run：
  `valid` 为 false。
- **没有序号的事件**（`unsequenced`）：序号不是一个正整数的事件无法放进流里。

### 3.3.1 恢复以持久日志为准

恢复的四种场景各有明确的行为：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| run 目录缺失 | Bridge 启动即 ENOENT 退出，**每次重启都崩** | 降级：记录问题、run 恢复为终态、Bridge 照常启动 |
| 日志尾行被撕裂 | `/events` 与 `/replay` **永久 500** | 逐行解析、跳过并报告无法解析的行；写入方先补一个换行 |
| 日志已有终态事件、状态还没存 | 在终态事件之后追加 `run.interrupted`，事件流违反状态机却报 `agrees: true` | 采用日志的终态，**不追加任何事件**；复演报告 `valid: false` 与 `violations` |
| 死于 `cancelling` | 永远停在 `cancelling`（非终态），占住项目运行锁，`/stop` 返回 500 | 写 `run.interrupted` 进入终态；`/stop` 释放它 |

规则的措辞：

- 日志里**已有终态事件**时，采用该终态，**不再追加任何事件**；
- 日志里没有终态事件、而 run 停在 `queued` / `running` / **`cancelling`** 时，
  写下 `run.interrupted` 并进入终态；
- 日志**缺失、不可读或尾行被撕裂**时降级——**一个损坏的 run 不得拖垮整个
  安装**。

### 3.4 事件住在三处

| 位置 | 作用 |
|---|---|
| `runs/<run>/events.jsonl` | 追加写的持久日志（既有） |
| `state.json` 的 `run.events` | 随 run 记录一起走，并被 SQLite 镜像索引（ATS-208 新增） |
| SQLite `events` 表 | 可按 `(run_uid, seq)` 查询（ATS-208 新增，schema version 3） |

三处由**同一个事件对象**写出，所以它们不会互相矛盾。`events` 表的复合主键
`(run_uid, seq)` 就是事件的身份，它同时**强制**了序号不重复。

旧 run 记录没有 `events` 数组：Bridge 启动时从自己的 `events.jsonl` 读回并
对齐 `eventSeq` 计数器，因此升级不需要迁移脚本。

## 4. 接口面

| 端点 | 作用 |
|---|---|
| `GET /api/runs/:id/events` | 事件的原始流（既有），外加日志损坏报告 `unreadable` / `missing` / `truncated` |
| `GET /api/runs/:id/replay` | **新增**：复演结果、与 run 记录是否一致、序号空洞、状态机校验 |

复演的响应：

```json
{
  "runId": "run_1_...",
  "status": "interrupted",
  "replayedStatus": "interrupted",
  "agrees": true,
  "valid": true,
  "violations": [],
  "terminal": true,
  "sequence": [1, 2, 3],
  "gaps": [],
  "duplicates": [],
  "unsequenced": [],
  "events": [ ... ],
  "unreadable": [],
  "missing": false,
  "truncated": false
}
```

`agrees` 为 false 有四种情形：复演出的状态与 run 记录不同；事件流根本
推不出状态（`replayedStatus` 为 null）；事件流**违反状态机**（`valid` 为
false，`violations` 非空）；事件流**复用了序号**（`valid` 为 false，
`duplicates` 非空）。后三者同样是「事件流不描述这个 run」。

## 5. 交付物清单

| 文件 | 职责 |
|---|---|
| `server/execution/model.mjs` | 统一模型：词表（status + outcome）、聚合、报告解析、attempt 绑定、事件词表、状态机、复演、日志读取 |
| `server/core.mjs` | 从模型模块**再导出**既有函数（`parseReport` / `attemptsForRun` 等），既有调用方不受影响 |
| `server/index.mjs` | 事件写入（先写事件后改状态、修复撕裂的尾行）、启动恢复（以日志为准、`cancelling` 纳入恢复、降级不崩）、`/events` 与 `/replay` 端点 |
| `server/adapters/playwright.mjs` | `collect()` 改为按 case 聚合（不再把重试摊平），并带出 outcome |
| `server/adapters/wdio.mjs` | `mapWdioStatus` 改用共享映射；`mergeWdioReports` 改用共享聚合，并把连续同名的重试合并为一个 case |
| `server/sqlite/schema.mjs` | schema version 3：`events` 表（主键 `(run_uid, seq)`） |
| `server/sqlite/store.mjs` | 把事件写成可查询的行；`eventsOfRun()` 查询 |
| `server/sqlite/import.mjs` | 镜像校验覆盖事件（逐条比对 payload 与索引列），并有负向用例 |
| `tests/execution-model.test.mjs` | 32 例 UT：词表、聚合、判定语义、复演、状态机、日志读取、状态图与代码一致 |
| `tests/execution-model-it.test.mjs` | 14 例 IT：Bridge 端到端、崩溃恢复、崩溃窗口下的序号校准、三处一致、日志损坏、终态后不追加事件、`cancelling` 恢复、序号的丢失与重复 |
| `tools/ats208-probes/` | 两个可重跑探针 + 证据收集脚本 |
| `tools/update_wbs_ats208.py` | WBS 行同步（幂等，XML 转义安全） |
| `apps/studio/lib/api.ts`、`app/page.tsx` | 前端类型与结果列表同步到统一模型 |

## 6. 验证

按本任务的「UT,IT」给出实际执行输出，证据在 `docs/evidence/ATS-208/`：

| 项 | 证据 | 结果 |
|---|---|---|
| UT | `docs/evidence/ATS-208/01-node-test-execution-model-ut.log` | 32 例全通过 |
| IT | `docs/evidence/ATS-208/02-node-test-execution-model-it.log` | 14 例全通过 |
| 全量回归 | `docs/evidence/ATS-208/03-node-test-full.log` | 778 例 / 778 通过 / 0 失败 / 0 跳过（接入 `examples/sample-playwright` 与 `examples/sample-wdio` 的 `node_modules` 后，依赖真实引擎的 IT 不再跳过） |
| 复核随附的探针（第一组：`pw-semantics` / `startup-robustness` / `bridge-e2e` / `wdio-check`） | `docs/evidence/ATS-208/11-reviewer-probes.log` | 四个探针全部 `RESULT: 0 failed` |
| 复核随附的探针（第二组：`wdio-dup` / `verdict-unknown` / `replay-contract`） | `docs/evidence/ATS-208/14-reviewer-probes-round2.log` | 三个探针全部 `RESULT: 0 failed` |
| 重试行为 | `docs/evidence/ATS-208/04-probe-current-behaviour.log` | 用例计一次、两次 attempt 各自保留 |
| 事件复演 | `docs/evidence/ATS-208/05-probe-event-replay.log` | 崩溃场景复演为 `interrupted`，序号无空洞 |
| ADR 引用 | `docs/evidence/ATS-208/06-adr-citations.log` | RESULT: OK |
| 质量门 | `docs/evidence/ATS-208/07-quality-gates.log` | RESULT: OK |
| WBS 行 | `docs/evidence/ATS-208/08-wbs-row.log` | 幂等，openpyxl 两种模式均可加载 |
| python 门 | `docs/evidence/ATS-208/09-python-gates.log` | 42 例全通过 |
| 覆盖率 | `docs/evidence/ATS-208/10-coverage.log` | 本任务改动的每个 server 文件行覆盖率均 >90%：`server/execution/model.mjs` 99.34、`server/adapters/playwright.mjs` 99.47、`server/adapters/wdio.mjs` 97.62、`server/core.mjs` 97.82、`server/sqlite/import.mjs` 95.92。`server/index.mjs` 以子进程方式运行，在进程内测得的覆盖率按惯例不计 |
| 缺陷用例的红（第 1 版基线） | `docs/evidence/ATS-208/12-mutation-evidence.log` | `IT-EXE-008` ~ `IT-EXE-013` 在 `8c9dd79` 上为红 |
| 缺陷用例的红（第 2 版基线） | `docs/evidence/ATS-208/13-mutation-evidence-round2.log` | `UT-EXE-028` ~ `UT-EXE-031` 与 `IT-EXE-009/010/011/013` 在 `42f5d29` 上为红 |

### 6.1 三处由用例守住的行为

下面三条是**用例守住的**行为，不是「文档这么写」：

| 行为 | 用例 | 可证伪的方式 |
|---|---|---|
| `test.fail()` 的**预期失败**计为 `passed`，**意外通过**计为 `failed` | `UT-EXE-020` / `UT-EXE-021` / `IT-EXE-012` | 把判定词表还原成只看 attempt 原始状态，用例变红 |
| 恢复**以持久日志为准**：日志已有终态就不追加事件，日志损坏时**降级而不崩** | `IT-EXE-008` ~ `IT-EXE-011` | 把恢复路径还原成旧实现，用例变红 |
| 复演**同时校验状态机与序号** | `UT-EXE-024` / `UT-EXE-031` / `IT-EXE-013` | 把校验还原成只折叠状态，用例变红 |

### 6.2 自查发现并修掉的两处缺陷

交付前的自查（`fix(ATS-208)` 两次提交）发现并修掉了两处**本任务自己引入的**
缺陷。两处都有可证伪的回归用例。

**崩溃窗口里的重号**。事件先写进 `events.jsonl`、之后才保存状态，所以死在两者
之间的 Bridge 会留下一份比状态文件**多一个事件**的日志。第一版实现只在状态里
没有 `events` 数组时才读回日志，于是这类 run 的 `eventSeq` 停在旧值上，下一个
事件拿到日志里已经用掉的序号——出现两个同序号的事件，而元数据层的主键
`(run_uid, seq)` 会拒绝这个重复。改为**每次启动**都用持久日志校准（日志是记录，
状态里的副本向它对齐）。回归用例 `IT-EXE-007` 守这个窗口；把修复还原后它失败
并报出 `the sequence has a duplicate: [1,2,2]`。

**ADR 引用检查的手写行号**。ADR 的 `file:line` 引用是一张手写的行号表，而本任务
两次改动 `server/index.mjs` 之后那张表就过时了两次，每次都把门禁弄红——而红的
原因跟代码本身无关。改为表里只写**针**，位置由脚本从**当前**源码推导；检查的
语义没有变弱（引错行照样被抓，已验证）。

## 7. 已知边界

- **真实浏览器 ST 未执行**。本任务的夹具是 **CLI 替身**，它只建模报告的
  形状（`results[]` 的重试结构、`expectedStatus`），不启动浏览器。真实
  Playwright 报告契约的核对由**复核随附的探针**完成（`pw-semantics`：
  真实 @playwright/test 1.64.1 生成的报告，10 个用例与引擎判定 0 分歧），
  ATS-201 的探针继续负责其余部分。
- **多 project 的用例**：模型按引擎**各 project 的判定**决定 Case 的状态，
  这一条已有用例覆盖（`UT-EXE-023B`）。但 **attempt 上没有 project 字段**：
  同一 case 在两个 project 下的两个 `retry:0` attempt 只能靠 occurrence
  区分。这是**已知边界**，不是已验证的结论。
- **WDIO 的重试**已实测：@wdio/reporter 10.1.0 每次尝试推一条同名条目，
  适配器把连续同名的条目合并为一个 case 的多个 attempt（探针 `wdio-check`：
  合并前 `total: 2`，合并后 `total: 1, flaky: 1, executions: 2`）。但
  **WDIO 的 json reporter 不带重试序号**，重试序号由条目在分组内的位置推出
  ——若报告乱序，这个位置就不可靠。
- **WDIO 的 `[failed, passed]` 无法与「失败后重试通过」区分**：报告层面没有
  重试序号，适配器按重试读取，summary 里是一个 flaky case。这是**写明的
  边界**，不是已验证的结论。
- **回放（replay 到世界状态）**不在本任务范围内：这里的「复演」指事件流折叠
  出 run 的状态，不是把事件重放成一次新的执行。
- **事件日志的损坏只被报告，不被修复**：`/events` 与 `/replay` 会跳过无法
  解析的行并报告行号，但那些事件**没有**被恢复——它们确实丢了。写入方只
  修复「下一行不要粘在碎片上」这一点。
- SQLite 层仍是 `state.json` 的**镜像**，不提供查询 API（见 `docs/06-DATA-DESIGN.md` §5）。
