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
| `GET /api/runs/:id/events` | 事件的原始流（既有） |
| `GET /api/runs/:id/replay` | **新增**：复演结果、与 run 记录是否一致、序号空洞 |

复演的响应：

```json
{
  "runId": "run_1_...",
  "status": "interrupted",
  "replayedStatus": "interrupted",
  "agrees": true,
  "terminal": true,
  "sequence": [1, 2, 3],
  "gaps": [],
  "events": [ ... ]
}
```

`agrees` 为 false 有两种情形：复演出的状态与 run 记录不同，或者事件流根本
推不出状态（`replayedStatus` 为 null）——后者同样是「事件流不描述这个 run」。

## 5. 交付物清单

| 文件 | 职责 |
|---|---|
| `server/execution/model.mjs` | 统一模型：词表、聚合、报告解析、attempt 绑定、事件词表、状态机、复演 |
| `server/core.mjs` | 从模型模块**再导出**既有函数（`parseReport` / `attemptsForRun` 等），既有调用方不受影响 |
| `server/index.mjs` | 事件写入（先写事件后改状态）、启动恢复写 `run.interrupted`、事件回填、`/replay` 端点 |
| `server/adapters/playwright.mjs` | `collect()` 改为按 case 聚合（不再把重试摊平） |
| `server/adapters/wdio.mjs` | `mapWdioStatus` 改用共享映射；`mergeWdioReports` 改用共享聚合 |
| `server/sqlite/schema.mjs` | schema version 3：`events` 表（主键 `(run_uid, seq)`） |
| `server/sqlite/store.mjs` | 把事件写成可查询的行；`eventsOfRun()` 查询 |
| `server/sqlite/import.mjs` | 镜像校验覆盖事件（逐条比对 payload 与索引列） |
| `tests/execution-model.test.mjs` | 19 例 UT：词表、聚合、复演、状态机 |
| `tests/execution-model-it.test.mjs` | 8 例 IT：Bridge 端到端、崩溃恢复、崩溃窗口下的序号校准、三处一致 |
| `tools/ats208-probes/` | 两个可重跑探针 + 证据收集脚本 |
| `tools/update_wbs_ats208.py` | WBS 行同步（幂等，XML 转义安全） |
| `apps/studio/lib/api.ts`、`app/page.tsx` | 前端类型与结果列表同步到统一模型 |

## 6. 验证

按本任务的「UT,IT」给出实际执行输出，证据在 `docs/evidence/ATS-208/`：

| 项 | 证据 | 结果 |
|---|---|---|
| UT | `docs/evidence/ATS-208/01-node-test-execution-model-ut.log` | 19 例全通过 |
| IT | `docs/evidence/ATS-208/02-node-test-execution-model-it.log` | 8 例全通过 |
| 全量回归 | `docs/evidence/ATS-208/03-node-test-full.log` | 539 例 / 528 通过 / 0 失败 / 11 跳过 |
| 重试行为 | `docs/evidence/ATS-208/04-probe-current-behaviour.log` | 用例计一次、两次 attempt 各自保留 |
| 事件复演 | `docs/evidence/ATS-208/05-probe-event-replay.log` | 崩溃场景复演为 `interrupted`，序号无空洞 |
| ADR 引用 | `docs/evidence/ATS-208/06-adr-citations.log` | RESULT: OK |
| 质量门 | `docs/evidence/ATS-208/07-quality-gates.log` | RESULT: OK |
| WBS 行 | `docs/evidence/ATS-208/08-wbs-row.log` | 幂等，openpyxl 两种模式均可加载 |
| python 门 | `docs/evidence/ATS-208/09-python-gates.log` | 28 通过 / 1 失败（**既有**，见下） |
| 覆盖率 | `docs/evidence/ATS-208/10-coverage.log` | 模型的聚合/复演/状态机分支均有对应用例 |

### 6.1 自查发现并修掉的两处缺陷

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

**既有失败**：`test_tc002_ats506_marker_and_narrative` 断言 `MARKERS[-1]` 是
`【ATS-506】`，但 `【ATS-512】` 是后来（ATS-512）追加到 `MARKERS` 的、断言没有
跟着更新。它在基线提交 `acfd7fc` 上**同样失败**（1 failed, 28 passed），与本任务
无关。ATS-208 把自己的 marker 加进 `MARKERS`（否则合并辅助函数找不到自己的
旧块，会写出重复的块——这是 `tools/test_wbs_common.py` 守护的性质），不影响
该断言。

## 7. 已知边界

- **真实浏览器 ST 未执行**。本任务的夹具是 **CLI 替身**，它只建模报告的
  形状（`results[]` 的重试结构），不启动浏览器。真实 Playwright 报告契约的
  核对仍由 ATS-201 的探针负责（`tools/ats201-probes/flaky-attempt-status-real-pw.mjs`，
  已同步到新的模型形状）。
- **多 project 的用例**在报告中是同一 spec 下的多个 `test`，模型把它们算作
  **同一个 case 的多个 attempt**。跨 project 的 UID 绑定复用 ATS-201 的注册表
  逻辑，尚未单独验证。
- **WDIO 的重试**未被实测：WDIO 的 json reporter 不像 Playwright 那样把重试
  放在 `results[]` 里，因此 WDIO 侧每个 case 通常只有一个 attempt。
- **回放（replay 到世界状态）**不在本任务范围内：这里的「复演」指事件流折叠
  出 run 的状态，不是把事件重放成一次新的执行。
- SQLite 层仍是 `state.json` 的**镜像**，不提供查询 API（见 `docs/06-DATA-DESIGN.md` §5）。
