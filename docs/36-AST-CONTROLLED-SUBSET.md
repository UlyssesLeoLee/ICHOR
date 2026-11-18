# 36-AST-CONTROLLED-SUBSET.md ｜ AST 受控步骤子集识别与不可反写提示

> **WBS**：ATS-314 ｜ 阶段 S3 / v0.3.0 ｜ 工作流 编辑 ｜ 主责 BE（Node Bridge）
> **关联要件**：FR-022 ｜ **前置依赖**：ATS-308（已终态）
> **交付物**：AST/IR 检测器 ｜ **验收标准**：仅支持白名单 API/静态参数；任意复杂 TS 强制只读回退
> **实测证据**：`docs/evidence/ATS-314/`

---

## 1. 这个问题是什么

平台想把一个 Playwright 测试画成流程图，让用户拖动方块。这件事只有在
**平台能把方块拿回来写进源文件**时才成立。ATS-314 的验收标准就是这条
能力的**边界**：

> 仅支持白名单 API/静态参数；任意复杂 TS 强制只读回退

它不是「把流程图画出来」，也不是「把流程图写回去」。它交付的是**判定器**：
它回答「这段代码里，哪些步骤在平台的受控子集内，哪些不在，以及不在的
**原因**」。写回本身（diff → 语法检查 → 人工批准 → 原子写）是 ATS-315 的
职责。

### 1.1 三个不可混淆的事实

| 事实 | 含义 |
|---|---|
| **只读步骤不是坏文件** | 用 helper 的测试是完全正常的测试代码。平台只是**不能**改写它。把它报成错误会让平台对每一个真实测试套件都在叫，而没人看的报告保护不了任何人 |
| **受控步骤不等于「写回是安全的」** | 本模块只**识别**子集，它**不写回**。它拒绝被误认为写回器 |
| **白名单是关于 API 的，不是关于项目的** | `page.goto` 在名单上，是因为它是一个形状已知的 Playwright API，不是因为某个项目在用它 |

---

## 2. 为什么不用真正的 TypeScript AST

ADR-003 写的是「P1 改用 TypeScript AST 支持受控子集」。本模块**没有**用
TypeScript AST，原因是关于这棵树的**事实**，不是偏好：

- Node Bridge **没有任何第三方依赖**（`docs/dependencies/dependency-manifest.md`：
  「本项目无第三方依赖」）；
- `typescript` 是**前端**（`apps/studio`）的依赖，而 Bridge 的运行环境里
  `apps/studio/node_modules` 并不存在——Bridge import 不了它，而从 Bridge
  去伸手拿前端的 `node_modules` 会把两个**分别发布**的部署物耦合在一起；
- 把 `typescript` 加进 Bridge 会改动依赖清单、许可复核（还有 16 项待法务
  复核）和 CI 安装步骤，而这一切对一个**并不需要**它的功能是不划算的。

所以检测器是一个**词法分析器（LEXER）**，不是解析器。这是**有意的野心
下调**，模块开头就把它写明：它识别受控步骤的**形状**，它不建立类型图。

### 2.1 为什么词法分析对这个边界已经足够

本模块回答的不是「这段程序是什么意思」，而是「这个**调用**在受控子集内
吗，它的**参数**是静态的吗」。两者都是关于**记号序列**的问题，而记号序列
正是词法分析器的产物。

正则也能回答同样的问题——并且在两个要紧的地方是错的：

| 正则的错误 | 词法分析器的做法 |
|---|---|
| 分不清**字符串里**的 `page.goto(x)`（`const s = "await page.goto('/x')"`）和真调用 | 词法分析器知道字符串和注释从哪里开始、在哪里结束 |
| 找不到**嵌套括号**的匹配（`page.goto(getUrl('a','b'))`），因此判不出参数是字面量还是嵌套调用 | 词法分析器跟踪括号深度，交回**精确的参数记号区间** |

---

## 3. 白名单

白名单是**封闭**的。不在名单上的 API 不是「将来支持」，而是**不支持**，
并且**带名字**被报出来。往名单里加一个 API 是一次必须在明处做出的设计
决定，参数规则必须同时写清。

### 3.1 名单（`server/edit/ast-subset.mjs` 的 `WHITELIST`）

| 类别 | API | 静态参数 |
|---|---|---|
| 导航 | `page.goto(url, options?)` | url、options |
| 导航 | `page.goBack(options?)` / `page.goForward(options?)` / `page.reload(options?)` | options |
| 定位器 | `locator.click(options?)` / `locator.dblclick(options?)` | options |
| 定位器 | `locator.fill(value, options?)` / `locator.type(text, options?)` / `locator.press(key, options?)` / `locator.selectOption(values, options?)` | value、options |
| 定位器 | `locator.check(options?)` / `locator.uncheck(options?)` | options |
| 断言 | `expect.toBe(expected)` / `expect.toEqual(expected)` / `expect.toContain(expected)` | expected（**actual 是运行期值**） |
| 断言 | `expect.toHaveText(expected, options?)` / `expect.toHaveCount(count)` | expected、count（**actual 是运行期值**） |
| 断言 | `expect.toBeTruthy()` / `expect.toBeFalsy()` | 无（**actual 是运行期值**） |
| 断言 | `expect.toBeVisible(options?)` / `expect.toBeHidden(options?)` | options（**actual 是运行期值**） |
| 分组 | `test.step(title, body)` | title |

### 3.2 两个下标空间

白名单的 `arity` 是**调用本身**的参数个数；`staticArgs` / `runtimeArgs`
是**合并下标空间**里的下标：

- 普通 API：合并空间 == 调用空间，`combinedOffset = 0`；
- 断言匹配器：合并空间是 `[actual, ...匹配器自己的参数]`，所以
  `combinedOffset = 1`。

这个偏移是**字段**而不是约定：一份规则要靠推断的白名单，其规则会被
**静默**破坏，而破坏的表现是某个步骤被错误地报成受控。

### 3.3 「静态」不等于「常量」

「静态参数」的意思是：**参数的文本在解析期已知，且不依赖任何运行期
计算出来的东西**。

| 形式 | 静态？ | 理由 |
|---|---|---|
| 字符串字面量、数字、`true`/`false`/`null`/`undefined` | 是 | 文本已知 |
| 无插值的模板字符串 `` `/login` `` | 是 | 文本已知 |
| 有插值的模板字符串 `` `/login/${id}` `` | **否** | 值在运行期算出来 |
| 变量引用（`url`） | **否** | 平台**无法证明**一个名字持有常量，所以它不假设 |
| 选项对象 `{ timeout: 5000 }` | 是 | 每个值都是静态的 |
| 选项对象 `{ timeout: cfg.timeout }` | **否** | 内层的值是运行期算出来的 |
| 选项对象 `{ timeout }`（简写） | **否** | 简写等于 `{ timeout: timeout }`，而名字不是静态值 |
| 选项对象 `{ ...base }`（展开） | **否** | 同上 |
| 调用、成员表达式、算术表达式 | **否** | 运行期计算 |

**唯一的例外是断言的 actual 侧**：`expect(x)` 携带的是产品在运行期产出的
值，按定义就是运行期值。所以匹配器条目声明一个**运行期参数槽**：平台
**不得**改写 actual 侧，检测器如实标出它而**不假装**它是静态的。

---

## 4. 判定结果

### 4.1 步骤的两种判定

| 判定 | 含义 |
|---|---|
| `controlled` | 白名单上的 API，参数静态。**这一类才可能被写回** |
| `read-only` | 其余一切。它**不是失败**，也**不是错误**：这是平台拒绝声称自己能改写这段代码 |

### 4.2 只读的理由是一个封闭集合

拒绝而不说理由的拒绝是读者无法据以行动的拒绝。

| 理由码 | 含义 |
|---|---|
| `not-whitelisted` | 这个 API 不在名单上 |
| `argument-not-static` | 一个必须静态的参数不是静态的 |
| `arity-not-supported` | 调用的参数个数不在 API 声明的范围里 |
| `not-a-plain-call` | 这个构造不是可读的普通调用 |
| `inside-control-flow` | 步骤在**循环**里：循环在运行期决定跑几次，平台不能把它画成**一个**方块 |
| `inside-local-function` | 步骤在**本文件声明的函数**里：函数可能被多处调用，把步骤挪出去会改变所有调用点 |
| `unparseable` | 文件无法词法分析（不是「没有受控步骤」） |

### 4.3 文件的三种判定

| 判定 | 条件 |
|---|---|
| `writable` | 文件里**每一个**步骤都是受控的 |
| `partial` | 一部分受控、一部分不是 |
| `read-only` | 一个受控步骤都没有 |

`writable` 是 ATS-315 需要的答案：**只有一个文件的所有步骤都被平台理解
时**，平台才可能改写它。一个步骤不懂的文件不是可改写的文件，哪怕里面
有一半步骤是受控的。

### 4.4 用例声明不是步骤

`test('标题', async ({page}) => { ... })` 是**流程所属的用例**，不是流程
里的一个步骤。把它报成步骤是范畴错误。检测器把它放进**独立的
`containers` 列表**（带标题、行号、标题是否静态），而 `test.step(...)`
**不是**容器：它是一个**分组**，是白名单上的一步。

---

## 5. 步骤的划分

一个调用**不是**独立步骤的情形有两种：

1. 它是另一个调用的**接收者**（`page.locator('#t').click()` 里的
   `page.locator('#t')` 是那个 click 的定位器）；
2. 它嵌在另一个调用的**普通参数**里（`expect` 的 actual 是断言的一部分）。

而在**回调参数**里的调用**是**独立步骤：`test.step` 的回调体正是流程由
哪些步骤组成。

**只有表达式最外层的调用是步骤。**

---

## 6. 接口面

### 6.1 `GET /api/projects/<id>/ast-subset?file=<脚本>`

一个**只读**接口。检测器**识别**步骤并拒绝其余，它**从不修改**文件。

- 文件通过 `readSource` 解析，因此本接口接受的文件与 `source` 接口
  **完全相同**（测试脚本、项目内、不超过 1 MB）——调用方无法用本接口
  读到 `source` 接口会拒绝的文件；
- 需要会话令牌；
- **没有**写接口（`POST` 返回 404）。

回答的形状：

```json
{
  "version": 1,
  "file": "tests/home.spec.ts",
  "editability": "partial",
  "writable": false,
  "counts": { "total": 4, "controlled": 2, "readOnly": 2 },
  "reasons": { "not-whitelisted": 2 },
  "steps": [
    { "api": "expect.toHaveText", "kind": "assertion",
      "editability": "controlled", "reason": null,
      "line": 20, "column": 8, "nesting": 1,
      "arguments": [ { "index": 0, "static": false, "runtime": true, "text": "page.locator('#t')" } ],
      "locatorArguments": [] }
  ],
  "containers": [
    { "kind": "test", "line": 18, "column": 0,
      "title": "'首页响应正常 @REQ-001'", "titleIsStatic": true }
  ]
}
```

### 6.2 模块 API（`server/edit/ast-subset.mjs`）

| 导出 | 用途 |
|---|---|
| `analyseSource(source)` | 判定一段源码 |
| `analyseFile(file)` | 判定一个文件 |
| `buildReport(file, source?)` | 报告（含 `writable` 与 `containers`） |
| `controlledSteps(report)` / `readOnlySteps(report)` | 两类步骤 |
| `formatSubsetReport(report)` | 可读摘要（数字取自报告本身） |
| `lex(source)` | 词法分析（导出是为了能被测试直接检查） |
| `isStaticRange(tokens, from, to)` | 静态规则（纯函数） |
| `WHITELIST` / `READ_ONLY_REASON` / `STEP_EDITABILITY` / `FILE_EDITABILITY` / `CONTAINER_CALLS` / `LOCATOR_FACTORIES` | 封闭的词汇表 |

---

## 7. 实测

探针（`tools/ats314-probes/probe-ast-subset.mjs`）在本仓库的**真实**脚本
上实测受控子集。

**测量的总体是 `examples/`，不是 `tests/`。** 平台自己的
`tests/*.test.mjs` 是 `node:test` 套件，不是 Playwright 脚本：它们调用
`node:test` 的 `test(...)`、用 `node:assert` 断言。测它们对受控子集**毫
无意义**——里面没有 `page` 可画，15739 条 `not-whitelisted` 拒绝量的是
**错误的总体**。有意义的总体是 **Playwright 脚本**：用户会画成流程的那
些，在本仓库里就是 `examples/`（`sample-playwright`、
`real-browser-fixture`，以及 `sample-wdio`——后者也被测，因为 WDIO 脚本
不是 Playwright 脚本，检测器必须**拒绝**它而不是假装）。

### 7.1 实测数字

本仓库 `examples/` 下的真实脚本共 **5 个文件**：writable 0 / partial 2 /
read-only 3。共 **12 个步骤**，其中 controlled **3** / read-only **9**。
拒绝理由分布：`not-whitelisted 8` / `argument-not-static 1`。

逐文件：

| 文件 | 判定 | 步骤 | 受控 | 只读 |
|---|---|---|---|---|
| `examples/real-browser-fixture/tests/failing.spec.ts` | read-only | 2 | 0 | 2 |
| `examples/real-browser-fixture/tests/passing.spec.ts` | partial | 2 | 1 | 1 |
| `examples/sample-playwright/tests/home.spec.ts` | partial | 4 | 2 | 2 |
| `examples/sample-wdio/tests/fail.spec.js` | read-only | 2 | 0 | 2 |
| `examples/sample-wdio/tests/pass.spec.js` | read-only | 2 | 0 | 2 |

实测数字见 `docs/evidence/ATS-314/03-probe-ast-subset.log`。设计书与 WBS
备注里的数字**从那份日志派生**，不是手抄的——手抄的数字会过期。`tools/
ats314-probes/check-doc-consistency.mjs` 把本文引用的每个数字与那份**已
提交**的日志逐条照合，对不上就失败。

**这组数字本身说明了一件事**：本仓库里**没有一个** Playwright 脚本是
`writable` 的。两个 `partial` 的脚本之所以是 `partial`，是因为它们用了
`page.setContent`（不在白名单上）。`sample-wdio` 的两个脚本全被拒绝，
因为 WDIO 的 API 不是 Playwright 的 API——平台不声称能画它们，这是
**正确**行为。

---

## 8. 已知边界（如实记录）

1. **不是 TypeScript AST**。检测器是词法分析器：它识别调用的**形状**，
   不做类型解析，也不做作用域分析。第 2 节说明了原因。
2. **不写回**。本模块只识别。写回（diff、语法检查、人工批准、原子写、
   索引失效）是 ATS-315 的职责。
3. **没有 UI**。ATS-315 的图形编辑与 ATS-310 的前端都不在本票范围内；
   本票交付数据层与接口面。
4. **白名单不含 Playwright 的其余 API**。`page.setContent`、`page.click`、
   `page.textContent` 等**不在**名单上，因此是 `not-whitelisted`。加进
   名单是一次设计决定，不是一次实现细节。
5. **WDIO 脚本全被拒绝**。这是**正确**的行为：WDIO 的 API 不是
   Playwright 的 API，平台不声称能画它们。
6. **只读回退不区分「复杂」的程度**。所有拒绝的理由都是**关于源码的
   事实**（不在名单 / 参数不静态 / 在循环里 / 在本地函数里），没有
   「这个函数太长了」这类主观判断。
7. **`test.step` 的回调体不被展平**。分组里的步骤被识别为独立步骤，但
   平台**不会**把回调体改写成扁平的步骤序列——那是写回的事。

---

## 9. 证据

| 文件 | 内容 |
|---|---|
| `docs/evidence/ATS-314/01-node-test-ast-subset-ut.log` | 单元测试（48 例） |
| `docs/evidence/ATS-314/02-node-test-ast-subset-it.log` | 集成测试（10 例，实 Bridge 上的 HTTP 面） |
| `docs/evidence/ATS-314/03-probe-ast-subset.log` | 真实脚本上的实测 |
| `docs/evidence/ATS-314/04-node-test-negative-control.log` | **负向对照**：8 种变异逐条被抓住 |
| `docs/evidence/ATS-314/05-ats301-gate.log` | ATS-301 门禁（WBS helper / ADR 引用 / 端口审计） |
| `docs/evidence/ATS-314/06-wbs-update.log` | WBS 更新与幂等 |
| `docs/evidence/ATS-314/07-doc-consistency.log` | 文档所引数字与已提交日志的照合 |

采集入口：`bash tools/ats314-probes/collect-evidence.sh`

---

## 10. 依据

- `docs/02-REQUIREMENTS.md` FR-022
- `docs/03-BASIC-DESIGN.md` §5「P1 AST 子集」
- `docs/04-DETAILED-DESIGN.md` §5「P1 AST 子集」
- `docs/01-RESEARCH-DECISIONS.md` ADR-003
- `docs/14-REVIEW-VERIFICATION.md`「任意 TS 无损反写不可实现」
- `docs/16-BASELINE-ADR.md`（受控源码读写基线）
