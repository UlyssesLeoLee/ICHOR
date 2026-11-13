# 复核方探针的复跑结果（ATS-214）

本目录是**复核方自己那套探针**（issue 附件 `ats214-r1-probe.zip` 与
`ats214-r2-probe.zip`）在本交付上的复跑结果。复核方的探针是验收标准，
所以本目录的日志是本轮交付最直接的证据。

复跑脚本：`tools/ats214-probes/run-reviewer-probes.sh <探针目录> <输出目录>`。
探针**本身不入库**（那是复核方的文件，不是交付物），入库的是它们的**原样输出**。

## 这一轮的结果

| 日志 | 探针 | 结果 |
|---|---|---|
| `r1-api.log` | `probes/r1-api.mjs`（真实 Bridge + 真实 Playwright 1.64.1） | **8 OK / 1 DEFECT**，DEFECT 是 B3（信息项，见下） |
| `r2-extra.log` | `probes/r2-extra.mjs`（真实 Bridge + 真实 Playwright） | **2 OK / 0 DEFECT**（E1、E2） |
| `r2-ui.log` | `probes/r2-ui.mjs`（真实 Chromium + 真实 Bridge + 500 用例夹具） | **7 OK / 0 DEFECT** |
| `r1-ui.log` | 第 1 轮的 `r1-ui.mjs`（私有端口与两处探针自身修正的版本） | **7 OK / 0 DEFECT** |

## 逐条对照

### r2-extra —— 上一轮的两个 DEFECT

| 探针 | 上一轮 | 这一轮 | 判据 |
|---|---|---|---|
| E1 `batches-api-serves-no-env-values` | **DEFECT**：`GET /api/batches` 返回了 `context.envVariables: {"BASE_URL":"https://staging.example/?k=s3cr3t-value-1234"}` | **OK**：整个响应里不含该值 | 批次记录只存档案的**引用**（`envUid` / `envName` / `envTier`），不存任何变量的值 |
| E2 `whitelist-tightened-before-run2-applies` | **DEFECT**：run#1 期间收紧了白名单，之后启动的 run#2 仍读到了变量值（`b1=<value>`） | **OK**：`b1=<unset>` | 每个批次 run 在启动时**重新解析**档案引用，按**当前**白名单过滤（与单文件路径同一函数、同一白名单来源） |

`GET /api/batches` 现在的 `context` 长这样：

```json
{"envUid":"env_1_757987f69edfd72a1a598aba","envName":"staging","envTier":"staging","runner":null,"capabilities":null}
```

档案被删除时（复核意见里提到、但没有单独探针的一条路径），批次以
`ENV_PROFILE_NOT_FOUND` 结束，第二个文件**不会**在「无档案」的静默回落下跑过。
这一条由 IT-ATS214-038 覆盖（真实 Bridge + 真实 Playwright）。

### r1-api —— 批次的选择与终态

| 探针 | 规则 | 本次结果 |
|---|---|---|
| r1-api B0 | 必须保持 OK | **OK** — runs=2 |
| r1-api B1 | 必须转 OK | **OK** — run#2 envName=staging；b 文件真的看到了 `BASE_URL=http://staging.example` |
| r1-api B2 | 必须转 OK | **OK** — missing=[] |
| r1-api N1 | 必须转 OK | **OK** — 启动失败的批次 status=failed |
| r1-api R1 | 必须转 OK | **OK** — Bridge 重启后批次不再 running |
| r1-api T1 | 必须转 OK | **OK** — 9 个用例的标签，静态索引与 CLI 0 处不符 |
| r1-api M1 / M2 | 必须保持 OK | **OK / OK** |
| r1-api B3 | 不要求 | **DEFECT（信息项）** — 整文件执行导致「选 2 跑 5」；精确执行要改适配器契约（ATS-301 登记的既有缺口），本任务范围外。界面已如实说明会执行多少条（见 X4 与 ST-ATS214-009）。 |

### r2-ui —— 500 用例的响应预算与选择语义

| 探针 | 规则 | 本次结果 |
|---|---|---|
| r2-ui L1 | 必须转 OK | **OK** — 列表 top=674px、height=104px（900px 视口内可见） |
| r2-ui P1 | 必须保持 OK | **OK** — 最差单次交互 **76ms**、long task **62ms**（预算 100ms） |
| r2-ui P2 | 必须保持 OK | **OK** — 便携 UI 最差 37ms、long task 0ms |
| r2-ui X1 | 必须转 OK | **OK** — 切到 other 后 2/2 行、0 个残留按下芯片 |
| r2-ui X3 | 必须转 OK | **OK** — 警告在页面上；**提交运行数 = 0** |
| r2-ui X4 | 必须转 OK | **OK** — toast 如实说明；引擎执行 3 条 |
| r2-ui K1 | 不要求 | **OK** — 勾选框是 `<BUTTON>`、tabIndex=0、不嵌在别的 button 里 |

## 关于 P1 那一栏：上一轮的 118ms 是怎么变成 76ms 的

复跑这一轮时 P1 一开始是红的（106–118ms）。追下去的原因是**渲染**，不是检索：

1. **选择记录每个已选用例一行表格。** 勾选 500 条时，多出 501 个 `<tr>`、
   4000+ 个 DOM 节点，浏览器把这一片排版一遍就把交互推过了预算。实测
   （Chrome DevTools Protocol 的 `Performance.getMetrics`）：
   `LayoutDuration` 108.9ms，而 `ScriptDuration` 只有 18ms——时间花在**排版**
   上，不在 React 上。现在选择记录**按文件分组**，每组只列前几条；选择集合
   本身仍然是完整的快照。
2. **每行问两次「这条勾上了吗」，用 `Array.includes` 线性扫描。** 500 行 ×
   500 个已选 UID × 2 次 = 每次渲染 50 万次字符串比较。改成 `Set`。
3. **用例行内联在列表里**，勾选一条 → 500 行全部重渲染。行拆成记忆化的组件
   （`CaseRow` / `PickBox` / `CaseTitle`），勾选状态与标题分开，标题那一半
   不随勾选重渲染。

改完之后：r2-ui P1 = 76ms（复核方自己那份日志里是 57ms），本任务的 ST-003
= 52ms。

## 复跑时对探针做的修改

**这一轮没有修改复核方的探针。** 上一轮改过三处（私有端口、K1 的严格上层
button、X3 的「没有 run 提交」），那一轮的说明留在提交历史里；这一轮的探针
按原样跑通，因此不需要改。`r1-ui.log` 是上一轮那份副本的复跑结果，探针的三处
修正仍在那份副本里（端口写死 4577 会量到别的 agent 的树；K1 的 `closest('button')`
会匹配它自己；X3 在运行被拒绝时会崩），改法与理由见下面的历史一节。

执行方自己的探针（`tools/ats214-probes/`）修过两处**它自己的**缺陷，
都与交付无关，且都在提交说明里写明：

- ST-003 之前开**第二个**页面，于是浏览器同时跑两个工作台，量的是双开浏览器；
  改为 reload 同一个页面。
- 4x CPU 那次测量输入的 `module4` 没清掉，下一项检查搜 `case 017` 因此搜不到
  ——探针的残留被报成了产品的缺陷。现在测量完就清空。

---

## 历史：第 1 轮驳回返工后那一轮的复跑（存档）

第 1 轮交付之后，复核方在 `r1-ui.mjs` 这份探针上发现了三处**探针自身**的
问题，复跑用的是副本 `probes/r1-ui-run.mjs`（复核方的文件没有动）：

### 1. 端口不再写死 4577

原探针写死 `PORT = 4577`。这台机器上同时有好几个 agent 在跑探针，
另一个 agent 的 Bridge 还占着 4577，于是探针量到的是**别人的树**。

**实测证据**：第一次复跑时探针读到 `{"tag":"SPAN","tabIndex":-1,"insideButton":true}`
——那是隔壁 agent 的**变异体**构建，不是本交付。改用私有端口之后，同一个探针读到
`{"tag":"BUTTON","tabIndex":0,"insideButton":false,"parentTag":"DIV"}`。

Bridge 在自己的端口上服务页面，工作台从页面自身的 origin 取 API 基址，
所以换端口不改变被测的东西。

### 2. K1 的 `closest('button')` 判断

原探针：`insideButton: !!b?.closest('button')`。当勾选框**自己就是** button 时，
`closest` 会匹配它自己——一个正确的 `<button role="checkbox">` 被报成
「嵌在 button 里」。改成看**严格在上层**的 button（`b.parentElement.closest('button')`）。

### 3. X3 步骤在运行被拒绝时会崩

原探针在点击「批量运行」之后无条件读 `run.status`。但 X3 要求的正是
「用例离开目录后，运行要**被阻止**」——被阻止时没有 run 可读，探针自己崩了
（`Cannot read properties of undefined (reading 'status')`）。
副本改成把「没有 run 提交」当成正确结果来断言。

**另外**：原探针的 K1 步骤点了 `@smoke` 想「清掉 X1 留下的条件」，
然后等 500 行。这一步的前提已经不成立——按复核方自己的 X1 要求，
过滤条件在切换项目时**要**被重置，所以没有残留条件可清；而点 `@smoke`
反而把列表收窄到 134 行，等 500 行必然超时。副本改成等「有 pick-box 就行」，
因为这一步要测的对象是勾选框，不是行数。

### 为什么第 1 轮交付在这些探针上是红的

- **B1**：批次的后续 run 没有继承环境档案 → 改为 `batch.context` 继承档案的引用。
- **B2**：批次的第一个 run 带整个选择，于是它的卡片把「还没开始跑的另一个文件」
  算成「选中但未执行」→ 改为第一个 run 也只带自己那一组。
- **N1 / R1**：批次在预检失败、Bridge 重启后永远停在 `running` →
  补齐五条失败路径的收尾。
- **T1**：静态索引漏读标题里的 `@标签` → 按引擎实测的
  `/@[\S]+/g` 规则补上。
- **X1 / X3**：切换项目不重置过滤条件；已选用例离开目录被静默丢弃 →
  重置过滤并告知、显式报出失效用例并阻止提交。
- **L1**：500 用例时筛选区把列表挤出视口 → 筛选芯片区有界并自带滚动。
