# 复核方探针的复跑结果（ATS-214 · 第 1 轮驳回返工后）

本目录是**复核方自己那套探针**（附件 `ats214-r1-probe.zip`）在本交付上的复跑结果。
复核方的探针是验收标准，所以本目录的日志是本轮返工最直接的证据。

| 日志 | 探针 | 结果 |
|---|---|---|
| `r1-api.log` | `probes/r1-api.mjs`（真实 Bridge + 真实 Playwright 1.64.1） | **8 OK / 1 DEFECT**，DEFECT 是 B3 |
| `r1-ui.log` | `probes/r1-ui.mjs`（真实 Chromium + 真实 Bridge + 500 用例夹具） | **7 OK / 0 DEFECT** |

复核方 README 里的第 2 轮通过规则：

```
must turn OK : r1-api B1 B2 N1 U1 R1 T1 ; r1-ui L1 X1 X3 X4
must stay OK : r1-api B0 M1 M2 ; r1-ui P1 P2
not required : r1-api B3 (info unless precise execution is built) ; r1-ui K1 (non-blocking)
```

对照结果：

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
| r1-ui L1 | 必须转 OK | **OK** — 列表 top=674px、height=104px（900px 视口内可见） |
| r1-ui X1 | 必须转 OK | **OK** — 切到 other 后 2/2 行、0 个残留按下芯片 |
| r1-ui X3 | 必须转 OK | **OK** — 警告在页面上；**提交运行数 = 0** |
| r1-ui X4 | 必须转 OK | **OK** — toast 如实说明；引擎执行 0 条 |
| r1-ui P1 / P2 | 必须保持 OK | **OK / OK** — 最差单次交互 55ms / 37ms，long task 0ms |
| r1-ui K1 | 不要求 | **OK**（顺带也修好了）— 勾选框是 `<BUTTON>`、tabIndex=0、不嵌在别的 button 里 |

## 复跑时对探针做的三处修改（都在**副本**里，复核方的文件没有动）

复跑用的脚本是 `probes/r1-ui-run.mjs`（探针目录下的副本）。改了 3 处，
每一处都是探针**自身的**问题，不是交付的问题——不改就会测不到交付：

### 1. 端口不再写死 4577

原探针写死 `PORT = 4577`。这台机器上同时有好几个 agent 在跑探针，
另一个 agent 的 Bridge 还占着 4577，于是探针量到的是**别人的树**。

**实测证据**：第一次复跑时探针读到 `{"tag":"SPAN","tabIndex":-1,"insideButton":true}`
——那是隔壁 agent 的**变异体**构建，不是本交付。改用环境变量
`ATS214_R1_PORT` 之后，同一个探针读到
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

## 为什么第一轮交付在这些探针上是红的

- **B1**：批次的后续 run 没有继承环境档案 → 本轮改为 `batch.context` 继承。
- **B2**：批次的第一个 run 带整个选择，于是它的卡片把「还没开始跑的另一个文件」
  算成「选中但未执行」→ 本轮改为第一个 run 也只带自己那一组。
- **N1 / R1**：批次在预检失败、Bridge 重启后永远停在 `running` →
  本轮补齐五条失败路径的收尾。
- **T1**：静态索引漏读标题里的 `@标签` → 本轮按引擎实测的
  `/@[\S]+/g` 规则补上。
- **X1 / X3**：切换项目不重置过滤条件；已选用例离开目录被静默丢弃 →
  本轮重置过滤并告知、显式报出失效用例并阻止提交。
- **L1**：500 用例时筛选区把列表挤出视口 → 本轮筛选芯片区有界并自带滚动。
