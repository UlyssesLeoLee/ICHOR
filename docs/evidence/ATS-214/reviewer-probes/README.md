# 外部探针的复跑结果（ATS-214）

本目录是**外部探针**（issue 附件 `ats214-r1-probe.zip` 与 `ats214-r2-probe.zip`）
在本交付上的复跑结果。探针的输出是本交付最直接的证据。

复跑脚本：`tools/ats214-probes/run-reviewer-probes.sh <探针目录> <输出目录>`。
探针**本身不入库**（那是附件，不是交付物），入库的是它们的**原样输出**。

## 结果

| 日志 | 探针 | 结果 |
|---|---|---|
| `r1-api.log` | `probes/r1-api.mjs`（真实 Bridge + 真实 Playwright 1.64.1） | **8 OK / 1 DEFECT**，DEFECT 是 B3（信息项，见下） |
| `r2-extra.log` | `probes/r2-extra.mjs`（真实 Bridge + 真实 Playwright） | **2 OK / 0 DEFECT**（E1、E2） |
| `r2-ui.log` | `probes/r2-ui.mjs`（真实 Chromium + 真实 Bridge + 500 用例夹具） | **7 OK / 0 DEFECT** |
| `r1-ui.log` | `probes/r1-ui.mjs`（真实 Chromium + 真实 Bridge + 500 用例夹具） | **7 OK / 0 DEFECT** |

## 逐条对照

### r2-extra —— 批次记录与环境白名单

| 探针 | 判据 | 结果 |
|---|---|---|
| E1 `batches-api-serves-no-env-values` | `GET /api/batches` 的响应里不得出现任何环境变量的值 | **OK** —— 整个响应里不含该值 |
| E2 `whitelist-tightened-before-run2-applies` | run#1 期间收紧白名单，之后启动的 run#2 不得再拿到被移除的变量 | **OK** —— `b1=<unset>` |

`GET /api/batches` 的 `context` 长这样：

```json
{"envUid":"env_1_757987f69edfd72a1a598aba","envName":"staging","envTier":"staging","runner":null,"capabilities":null}
```

判据的落点：批次记录只存档案的**引用**（`envUid` / `envName` / `envTier`），
不存任何变量的值；每个批次 run 在启动时**重新解析**那份引用，按**当前**白名单过滤
（与单文件路径同一函数、同一白名单来源）。

档案被删除时，批次以 `ENV_PROFILE_NOT_FOUND` 结束，第二个文件**不会**在
「无档案」的静默回落下跑过。这一条由 `IT-ATS214-038` 覆盖
（真实 Bridge + 真实 Playwright）。

### r1-api —— 批次的选择与终态

| 探针 | 判据 | 结果 |
|---|---|---|
| r1-api B0 | 批次链推进 | **OK** —— runs=2 |
| r1-api B1 | 每个 run 都带环境档案 | **OK** —— run#2 envName=staging；b 文件真的看到了 `BASE_URL=http://staging.example` |
| r1-api B2 | run#1 的对账卡不把另一个文件的用例算成缺失 | **OK** —— missing=[] |
| r1-api N1 | 启动失败的批次落到终态 | **OK** —— batch.status=failed |
| r1-api R1 | Bridge 重启后批次不再 running | **OK** |
| r1-api T1 | 静态索引与真实 CLI 的标签一致 | **OK** —— 9 个用例，0 处不符 |
| r1-api M1 / M2 | 别的文件不跑；用例不重复执行 | **OK / OK** |
| r1-api B3 | 信息项 | **DEFECT（信息项）** —— 整文件执行导致「选 2 跑 5」；精确执行要改适配器契约（ATS-301 登记的既有缺口），本任务范围外。界面如实说明会执行多少条（见 X4 与 ST-ATS214-009）。 |

### r2-ui / r1-ui —— 500 用例的响应预算与选择语义

| 探针 | 判据 | 结果 |
|---|---|---|
| L1 | 500 用例时用例列表在 1440x900 视口内可见 | **OK** —— 列表 top=674px、height=104px |
| P1 | 最差单次交互 ≤ 100ms 且无 > 100ms 的 long task | **OK** |
| P2 | 便携 UI 的同一预算 | **OK** |
| X1 | 切换项目不残留上一个项目的过滤条件 | **OK** —— 切到 other 后 2/2 行、0 个残留按下芯片 |
| X3 | 已选用例离开目录时显式报出并阻止提交 | **OK** —— 警告在页面上；**提交运行数 = 0** |
| X4 | 文案如实说明会执行多少条 | **OK** —— toast 与引擎实跑条数一致 |
| K1 | 勾选框键盘可达 | **OK** —— 勾选框是 `<BUTTON>`、tabIndex=0、不嵌在别的 button 里 |

## P1 的预算为什么曾经被顶破

时间花在**排版**上，不在检索上。用 Chrome DevTools Protocol 的
`Performance.getMetrics` 定位到：`LayoutDuration` 108.9ms，而
`ScriptDuration` 只有 18ms。三处改动：

1. **选择记录每个已选用例一行表格。** 勾选 500 条时，多出 501 个 `<tr>`、
   4000+ 个 DOM 节点，浏览器把这一片排版一遍就把交互推过了预算。现在选择记录
   **按文件分组**，每组只列前几条；选择集合本身仍然是完整的快照。
2. **每行问两次「这条勾上了吗」，用 `Array.includes` 线性扫描。** 500 行 ×
   500 个已选 UID × 2 次 = 每次渲染 50 万次字符串比较。改成 `Set`。
3. **用例行内联在列表里**，勾选一条 → 500 行全部重渲染。行拆成记忆化的组件
   （`CaseRow` / `PickBox` / `CaseTitle`），勾选状态与标题分开，标题那一半
   不随勾选重渲染。

## 探针的修改

**外部探针的源文件没有动。** `r1-ui.log` 跑的是 `r1-ui.mjs` 的**副本**
`probes/r1-ui-run.mjs`，副本里有三处**探针自身**的修正：

1. **端口不再写死 4577。** 原探针写死 `PORT = 4577`。这台机器上同时有好几个
   agent 在跑探针，另一个 agent 的 Bridge 还占着 4577，于是探针量到的是
   **别人的树**。**实测证据**：第一次复跑时探针读到
   `{"tag":"SPAN","tabIndex":-1,"insideButton":true}` —— 那是隔壁 agent 的
   **变异体**构建。改用私有端口之后，同一个探针读到
   `{"tag":"BUTTON","tabIndex":0,"insideButton":false,"parentTag":"DIV"}`。
   Bridge 在自己的端口上服务页面，工作台从页面自身的 origin 取 API 基址，
   所以换端口不改变被测的东西。
2. **K1 的 `closest('button')` 判断。** 原探针：`insideButton: !!b?.closest('button')`。
   当勾选框**自己就是** button 时，`closest` 会匹配它自己——一个正确的
   `<button role="checkbox">` 被报成「嵌在 button 里」。改成看**严格在上层**的
   button（`b.parentElement.closest('button')`）。
3. **X3 步骤在运行被拒绝时会崩。** 原探针在点击「批量运行」之后无条件读
   `run.status`。但 X3 要求的正是「用例离开目录后，运行要**被阻止**」——
   被阻止时没有 run 可读，探针自己崩了
   （`Cannot read properties of undefined (reading 'status')`）。副本改成把
   「没有 run 提交」当成正确结果来断言。

**另外**：原探针的 K1 步骤点了 `@smoke` 想清掉 X1 留下的条件，然后等 500 行。
这一步的前提已经不成立——按 X1 的要求，过滤条件在切换项目时**要**被重置，
所以没有残留条件可清；而点 `@smoke` 反而把列表收窄到 134 行，等 500 行必然超时。
副本改成等「有 pick-box 就行」，因为这一步要测的对象是勾选框，不是行数。

执行方自己的探针（`tools/ats214-probes/`）修过两处**它自己的**缺陷，
都与交付无关：

- ST-003 之前开**第二个**页面，于是浏览器同时跑两个工作台，量的是双开浏览器；
  改为 reload 同一个页面。
- 4x CPU 那次测量输入的 `module4` 没清掉，下一项检查搜 `case 017` 因此搜不到
  ——探针的残留被报成了产品的缺陷。现在测量完就清空。
