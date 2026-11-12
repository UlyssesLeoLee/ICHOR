# ATS-214 · 复核第 1 轮驳回返工方案

> 本文件是 **返工方案**，不是交付证明。方案里写的每一条，最后都要由
> `docs/evidence/ATS-214/` 下的实测日志与探针结果来证明；写进方案而没有
> 跑过的东西，在交付评论里一律记为「未验证」。

## 0.1 返工后的实测结果（截至本文件最后一次修改）

下面的数字都来自实跑，命令与日志见 `docs/evidence/ATS-214/`。
**「未验证」的项目不得当成已完成。**

| 项 | 怎么测的 | 结果 |
|---|---|---|
| UT（共享检索/标签/过滤/选择模块） | `node --test tests/ats214-case-search.test.mjs` | **44/44 通过** |
| IT（批次上下文继承与终态，真实 Bridge + 真实 Playwright） | `node --test tests/ats214-batch-context.test.mjs` | **7/7 通过** |
| ST（真实 Chromium + 真实 Bridge + 500 用例夹具） | `node tools/ats214-probes/st-ats214.mjs` | **ST-ATS214-001~011 共 11 项，0 DEFECT** |
| 标签一致性（静态索引 vs 真实 CLI `--list`） | `node tools/ats214-probes/tag-parity.mjs` | **12/12 用例逐条一致，0 处不符** |
| 负控（交付代码被变异后测试必须变红） | `node tools/ats214-probes/mutation-check.mjs` | 见 `13-mutation-control.log` |

### ST 的实测数字

| ST | 测了什么 | 实测值 |
|---|---|---|
| 001 | 500 用例加载无报错 | 500 行；console error 0；page error 0 |
| 002 | 用例列表可见可点 | 列表 top=674px、height=104px（1440×900 视口）；第一条可点，`aria-checked` 变 true |
| 003 | 过滤在预算内 | 预算 100ms；最差单次交互 53ms；最差 long task 0ms |
| 004 | 按标题搜索 | 「case 017」命中 1 条 |
| 005 | 标签口径可分辨 | 任一（@smoke+@api）234 条；全部 34 条——两个口径确实不同 |
| 006 | 选择映射到 UID | 「已选 2 条 · 将执行 5 条」；两个 UID 与目录一致 |
| 007 | 已选离开目录被报出且阻止运行 | 警告点名 UID；toast 提示；**提交运行数 = 0** |
| 008 | 切换项目重置过滤 | 切换前 134 行/1 个按下芯片 → 切换后 2 行/0 个芯片/「已选 0 条」 |
| 009 | 文案如实 | 「已选 1 条 · 将执行 3 条」；toast「实际执行 3 条」；引擎真的跑了 3 条 |
| 010 | 勾选框键盘可达 | `<BUTTON>`、tabIndex=0、不嵌在别的 button 里；空格能切换 |
| 011 | 请求带着每一个被勾选的 UID | 请求体 selection = 两个 UID，与勾选的完全一致 |

### 负控探针自身的两个坑（已修，值得记下来）

第一次跑负控时，10 个变异里有 6 个「没抓住」，但**不是测试不行，是探针不行**：

1. **探针把构建产物 `out/` 复制过去**，改 `page.tsx` 的变异根本没进浏览器，
   ST 量的是没变异的构建 → 界面变异全部漏网。改为**就地变异 + 重新构建**。
2. **探针崩了会被读成绿**（磁盘满 / 构建失败时 ST 一个判定都没打印）。
   现在「一个判定都没打印」= 探针坏了，报 `BROKEN`，绝不算「没抓住」。

另外，`node_modules` 每个变异复制一份会把 D: 写满，后面的探针全部
`ENOSPC` 假绿；且 Turbopack **不认 junction**（仓库自己的证据 README 记着），
所以负控只能在真实树上就地做，做完恢复。

## 0. 驳回意见 → 返工项对照

复核方的 10 条需修改项，逐条对应到本文件的返工动作，以及产出的证据。
「探针」列写的是复核方附件 `ats214-r1-probe.zip` 里的检查编号，
第 2 轮复核会重跑同一套探针。

| 复核项 | 复核方探针编号 | 返工动作 | 产出证据 |
|---|---|---|---|
| 1 按真实完成定义重写 | — | `docs/32` §1、`case-search.mjs` 文件头、两份测试文件头改成 issue/WBS 的完成定义「500 用例过滤无明显阻塞；选中准确映射 UID」，并逐条挂到证据 | 文档本身 + `09-acceptance-mapping.log` |
| 2 500 用例：修布局 + 实测 | `ui L1`、`ui P1/P2` | 侧栏筛选区有界（可滚动）+ 列表自身滚动；真实 Chromium 跑 500 用例夹具，阈值事先写明 | `10-st-500-cases.log`、`shots/` |
| 3 执行 ST | `ui L1/X1/X3/X4` + 新增 | `tools/ats214-probes/st-ats214.mjs`：真实 Chromium + 真实 Bridge 跑 ST-ATS214-001~005 及新增 ST | `10-st-500-cases.log` |
| 4 批次后续 run 继承请求上下文 | `api B1` | `startBatchRun` 继承 env 档案（经当前白名单过滤）、pinned runner、capabilities，并写进运行记录 | `12-batch-context-it.log` |
| 5 批次必达终态 | `api N1/U1/R1` | 启动前对所有分组做 `readSource`+`assertSafeTestFilter`；预检失败/`adapter.start` 抛错时结束批次；Bridge 重启后在途批次标为中断 | `13-batch-terminal-it.log` |
| 6 对账正确 | `api B2` | run#1 只记录本组；补批次级「选了什么/跑了什么」视图（`batches` 不再是死状态） | `12-batch-context-it.log`、`14-batch-view-it.log` |
| 7 界面上的选择完整性 | `ui X1/X3` | 已选 UID 离开目录时显式提示并阻止提交；切换项目时重置过滤条件；选择按项目隔离 | `10-st-500-cases.log` |
| 8 文案如实 | `ui X4` | 提交前后说明实际会执行多少条（整文件执行） | `10-st-500-cases.log` |
| 9 标签一致性 | `api T1` | 静态索引按 Playwright 规则读 test/describe 标题里的 `@标签`；探针覆盖标题标签写法 | `15-tag-parity.log` |
| 10 收尾 | — | 修正 WBS T35 日志路径与数字；合并 `dev`；重算 CHECKSUMS；跑 WBS verify + 全量回归 | `06-wbs-row-and-updaters.log`、`07-verify-checksums.log`、`04-node-test-full.log` |

### 不阻断项（明确记录，不假装做了）

- `api B3`（整文件执行导致「选 2 跑 5」）：**信息项**。精确执行需要改适配器
  契约（ATS-301 登记的 `filterByTestUid=false` 既有缺口），超出本任务范围。
  但界面**必须如实说明**会执行多少条（复核项 8）。
- `ui K1`（选择框键盘不可达）：**非阻断**，但既然要改选择语义，一并修掉。

## 1. Playwright 标签规则的实测基线

复核方指出静态索引漏读标题里的标签（`api T1`）。本轮先**实测**引擎的规则，
再按实测结果写代码，不靠猜。

实测环境：Playwright 1.64.1（`examples/sample-playwright/node_modules`），
`playwright test --list --reporter=json`。

| 写法 | CLI 报告的 tags |
|---|---|
| `test('T1 title-tag @smoke', ...)` | `["smoke"]` |
| `test('T2 details', { tag: '@fast' }, ...)` | `["fast"]` |
| `test('T9 both @inline', { tag: '@details' }, ...)` | `["inline","details"]` |
| `test('T8 string mentions tag: @notatag in title? no', ...)` | `["notatag"]` |
| `test.describe('D1 describe title @group', ...)` 内的用例 | `["group"]` |
| `test.describe.serial('D2 serial', { tag: '@serial' }, ...)` 内的用例 | `["serial"]` |
| `test('T10 trailing @tail', ...)` | `["tail"]` |
| `test('T11 @a mid @b end', ...)` | `["a","b"]` |

引擎的规则（`playwright/lib/common/index.js:2765-2775`）：

```js
get tags() {
  const path10 = [];
  this.parent._collectTagTitlePath(path10);   // 各级 describe 的标题 + 标签
  path10.push(this.title);                     // 用例自己的标题
  const titleTags = path10.join(" ").match(/@[\S]+/g) || [];
  return [...titleTags, ...this._tags];        // 再并上 details 对象里的 tag
}
```

即：**标题路径（含各级 describe 标题）与用例标题拼成一段文本，用
`/@[\S]+/g` 匹配**，再并上 details 对象里的 `tag`。报告时去掉 `@`
（`playwright/lib/runner/index.js:4352`：`tags: test.tags.map(t => t.substring(1))`）。

静态索引必须复刻这条规则，静态索引与权威索引才会「逐条一致」。

## 2. 代码改动清单

### 2.1 `server/uid.mjs` — 静态索引读标题标签

- 新增 `titleTagsOf(text)`：对一段标题文本做 `/@[\S]+/g` 匹配并去掉 `@`。
- `scanCaseTags` 改为合并三路来源：
  1. **标题路径标签**：用例标题 + 各级 describe 标题里的 `@标签`；
  2. **details 标签**：details 对象里的字面量 `tag`/`tags`（现有逻辑，保留）；
  3. **describe 的 details 标签**（现有逻辑，保留，且要参与标题路径拼接）。
- 计算式标签（`{ tag: someVar }`）仍然**不读**：静态索引不求值代码。

### 2.2 `server/index.mjs` — 批次的上下文继承与终态

- `startBatchRun(project, batch, group, index, previous)` 改为接受并继承
  **请求上下文**：`envProfile`（已经过白名单过滤的变量）、`pinnedRunner`、
  `requestedCapabilities`。批次记录 `batch.context` 存这些，跑出来的每个 run
  都写进自己的 `envUid/envName/envTier/envVariables/runner/capabilities`。
- **启动前全量校验**：批次建立时，对**每个**分组做
  `readSource(project, file)` + `assertSafeTestFilter(file)`；任一组被拒就整单
  `400 INVALID_TEST_FILTER`，与单文件口径一致。
- **批次必达终态**：
  - `startRun` 的预检失败分支与 `adapter.start` 抛错分支，都要把批次收尾
    （状态 `failed`，带原因），而不是让批次永远 `running`；
  - `advanceBatch` 在启动下一组失败时也要收尾；
  - Bridge 启动时把在途批次（`status==='running'`）标为 `interrupted`。
- **对账**：`run#1` 只记录**本组**的选择（已经是这样，但要确认 `startBatchRun`
  之外的第一条 run 也按组写）；批次级视图：`GET /api/batches` 返回每个批次的
  「选了什么 / 跑了什么」对账结果。

### 2.3 `apps/studio/app/page.tsx` — 界面

- **布局**：筛选区（标签/文件芯片）有界：`.filter-box` 里的芯片列表自己
  滚动（`max-height` + `overflow-y:auto`），用例列表 `.file-list` 保持自己的
  滚动。保证 500 用例 / 50 文件时，用例列表在 1440×900 下**可见可点**。
- **切换项目**：重置过滤条件与选择（按项目隔离），并在切换时把旧条件
  **显示出来**而不是静默丢弃。
- **已选 UID 离开目录**：显式提示（`selection.unknown`），**阻止提交**，直到
  用户确认（清掉失效项）为止。
- **文案如实**：提交前显示「已选 N 条，将执行 M 条（整文件执行）」；提交后的
  toast 也说实际执行的条数。
- **选择框键盘可达**：`.pick-box` 不再嵌在 `<button>` 里，改成真正的
  `<button role="checkbox">`（`tabIndex=0`）。

### 2.4 `apps/studio/public/case-search.mjs` — 共享模块

- 文件头改成**真实的完成定义**（issue/WBS 的原话），并逐条挂到证据。
- 新增 `selectionDiffs(snapshot, catalogue)`：返回「已选但不在目录里」的 UID，
  供界面提示与提交前校验使用。

### 2.5 `apps/studio/public/fallback.html` — 便携 UI

- 同步筛选区的有界布局；补上「已选」的入口（复核方指出便携 UI 显示
  「已选 0 条」却没有任何勾选入口）。

## 3. 测试与证据

| 层 | 交付物 | 命令 |
|---|---|---|
| UT | `tests/ats214-case-search.test.mjs` | `node --test tests/ats214-case-search.test.mjs` |
| IT | `tests/ats214-batch-run-api.test.mjs` | `node --test tests/ats214-batch-run-api.test.mjs` |
| IT（新增） | `tests/ats214-batch-context.test.mjs` | `node --test tests/ats214-batch-context.test.mjs` |
| ST | `tools/ats214-probes/st-ats214.mjs` | 真实 Chromium + 真实 Bridge |
| 探针 | `tools/ats214-probes/tag-parity.mjs`（扩） | 覆盖标题标签写法 |
| 负控 | `tools/ats214-probes/mutation-check.mjs` | 对 `page.tsx` 的变异必须变红 |

**ST 的执行方式**：静态导出 + Bridge + 真实 Chromium（`playwright-core`），
夹具用真实 Playwright 1.64.1。阈值**事先写明**：
单次交互 ≤ 100ms，且无 > 100ms 的 long task。

## 4. 风险

- 静态索引读标题标签后，**权威索引与静态索引的 tags 顺序**可能不同（CLI 是
  「标题标签在前、details 在后」）。统一按字母序排序（现有 `dedupeTags` 已经
  排序），比较时也按排序后比较。
- 批次继承 env 档案会触及 ATS-212 的「白名单过滤」语义：继承的是**已经过滤
  过**的变量，不重新读白名单，也不绕过过滤。
