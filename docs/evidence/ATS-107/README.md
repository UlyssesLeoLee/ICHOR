# ATS-107 证据索引

设计：`docs/31-REAL-BROWSER-FIXTURE.md`（`.quality/docs/examples/real-browser-fixture.md`、`.quality/docs/tools/ats107-probes/st-ats107.mjs.md`、`.quality/docs/tools/update_wbs_ats107.py.md`）。日志由 `tools/ats107-probes/collect-evidence.sh` 生成（`ATS107_STEPS` 可只重跑部分步骤），每份日志头部记录命令、提交、Node/Python 版本，正文为原样输出。

| 日志 | 内容 | 结果 |
|---|---|---|
| `01-fixture-contract.log` | 夹具的交付形态：精确固定的版本、入库的 lockfile、显式的 chromium、`retries: 0`、两条离线用例、夹具自己的 `tests/expected.json` | 7 个文件已入库 |
| `02-real-browser-probe.log` | **验收口径本身**：同一夹具分别经 Playwright CLI 直跑与经真实 Bridge 跑，逐条对账（判定 / 计数器 / 错误信息全文相等），并检查产物（`report.json` + 真实 `trace.zip` + **浏览器上下文**） | **RESULT: 28/28** |
| `03-mutation-control.log` | **负控第 1 层**（对账逻辑）：对 Bridge 自身结果投影施加 13 种变异，每种都必须被对账逻辑抓住；未变异的真实结果必须被接受 | **RESULT: 17/17**（13 种变异 + 4 项对照） |
| `04-python-tools.log` | 全部 Python 工具测试（`pytest tools/`） | 64 passed, 2 warnings in 3.30s |
| `05-wbs-updater-regression.log` | 全部 WBS 更新脚本共存回归（发现 `tools/update_wbs_ats107.py`） | RESULT: OK（31 个更新器） |
| `06-wbs-state.log` | `docs/WBS.xlsx` 中 ATS-107 行（第 12 行）与总览 | 状态 `待审核`，完成率 1，剩余 0 |
| `07-baseline-regression.log` | 全量套件 `node --test --test-concurrency=2 tests/*.test.mjs`、`node --check`、端口审计、ADR 行号引用、依赖清单；并**实测**本树与基线树的 ATS-203 三个文件 | 全量 1649 条：1621 通过、**0 失败**、28 跳过；ATS-203 本树与基线树**均 28/28 通过** |
| `08-no-browser-control.log` | **负控第 2 层**（真实浏览器判定）：把夹具改成不取 `page`（因此不启动浏览器，但仍会写出 `trace.zip`） | **RESULT: 3/3**（真实夹具被接受、变异夹具被拒绝） |
| `09-product-mutation-control.log` | **负控第 2 层**（产品变异）：在产品源码副本上截断 Bridge 报出的错误信息，对副本跑真实探针 | RESULT: OK -- the probe REJECTED the product that truncates the error message (P1 caught)；RESULT: OK -- P1 is caught on the real chain, and the unmutated product still passes |
| `10-real-browser-it.log` | **结合测试**（`tests/ats107-real-browser-it.test.mjs`）：经 HTTP 驱动真实 Bridge 跑真实夹具，从 API 答案侧读同一条口径 | 3 条：3 通过、0 失败 |

## 验收口径是怎么被证明的

`02-real-browser-probe.log` 的关键行：

```
PASS ST-1 the fixture pins an EXACT @playwright/test version -- declared=1.65.0
PASS ST-1 the fixture lockfile is COMMITTED -- examples/real-browser-fixture/package-lock.json ...
PASS ST-1 the fixture installs from its lockfile (npm ci) -- exit=0
PASS ST-1 the installed engine is the pinned one -- installed=1.65.0 pinned=1.65.0
PASS ST-2 the direct CLI run has at least one PASS -- 1 passed
PASS ST-2 the direct CLI run has at least one FAIL -- 1 failed
PASS ST-2 the direct CLI run launched a REAL Chromium (the trace has a browser context) -- 2/2 trace archives record a Chromium context
PASS ST-3 the Bridge reports one passed and one failed -- {"passed":1,"failed":1,"total":2}
PASS ST-4 the per-case verdicts are IDENTICAL to the CLI's
PASS ST-5 the Bridge's error message is the engine's own (the whole text, not a part of it) -- cli=401 chars, bridge=401 chars, identical after stripping ANSI
PASS ST-6 the Bridge matches the fixture's declared expectations
PASS ST-7 the run folder holds the engine's report.json
PASS ST-7 the Bridge run launched a REAL Chromium (the trace has a browser context) -- 2/2 trace archives record a Chromium context
PASS ST-8 the counters agree with the CLI's -- bridge=1/1/2 cli=1/1/2
RESULT: 28/28
```

四点需要评审者注意：

1. **基准不是产品自己**。期望值来自一次**独立的 Playwright CLI 直跑**（由探针自己的遍历器读出，不用产品的 `parseReport`）与夹具自己的 `tests/expected.json`。拿 Bridge 和自己比是恒等式，证明不了任何事。
2. **「真实浏览器」是被检查的，不是被假定的**。证据是 trace 里的**浏览器上下文**：引擎为每个浏览器上下文写一个 `<n>-trace.trace`，其 `context-options` 事件的 `browserName` 写着实际启动的浏览器。`08-no-browser-control.log` 用「不取 `page`」的变异夹具证明这条规则会拒绝它——那个变异夹具**照样写出 `trace.zip`**，只看归档存在是拦不住的。
3. **错误信息是全文相等，不是包含**。两边都先去 ANSI，再逐字相等（401 字符 vs 401 字符）。`09-product-mutation-control.log` 用「产品截断错误信息」的变异证明这条规则会拒绝它——只做包含检查时，截断后的 111 字符照样能通过。
4. **探针的判定与 IT 的判定来自不同的读法**：探针读引擎的报告（用自己的遍历器），`tests/ats107-real-browser-it.test.mjs` 读 Bridge 的 API 答案。解析器的 bug 与投影的 bug 因此不能互相遮蔽。

## 负控分两层

| 层 | 工具 | 变异对象 | 证明什么 |
|---|---|---|---|
| 1 | `mutation-check.mjs` | 内存里的 Bridge 结果投影副本 | **对账逻辑**有牙齿（13 种变异全部被抓住，含截断错误信息、ANSI 后面截断、挂错用例的错误信息） |
| 2 | `no-browser-control.mjs` | 夹具（不取 `page`） | **「真实浏览器」判定**会拒绝不启动浏览器的运行 |
| 2 | `product-mutation-control.sh` | 产品源码的副本（截断错误信息） | 探针在**真实链路**上会拒绝一个坏掉的产品（未变异的产品仍 28/28 通过） |

第 1 层只作用于内存副本，不触碰产品源码；第 2 层的变异对象是夹具与产品源码的**副本**，交付树始终未被改动。

## 全量套件里的跳过项（逐条带原因）

`07-baseline-regression.log` 的全量套件：**1649 条，1621 通过，0 失败，28 跳过**。跳过的用例都带原因，且都不是本票的：

- 13 条 `IT-ADP-*` / `IT-API-013B`：`examples/sample-playwright`（或 `examples/sample-wdio`）在本工作树里没有 `node_modules`；
- 13 条 `IT-ATS603-*`：本机没有接在 adb 上的 Android 设备；
- 2 条 `CT-PF-001` / `CT-ARG-001`：本工作树里没有可用的真实 `@playwright/test` 安装（可用 `ATS_REAL_PLAYWRIGHT_PROJECT` 指定）。

**skip 不算 PASS 也不算 FAIL**，所以上面的通过数里没有把它们算进去。

## ATS-203 的失败：实测归因（不是断言）

`07-baseline-regression.log` 现在**实测**同一组三个文件在**本树**与**基线树**（`0e34299`）上的结果，两侧都打印引擎版本：

```
baseline commit : 0e34299
engine (this tree)   : 1.64.1 (D:/ICHOR/examples/sample-playwright/node_modules)
--- this tree ---      tests 28 / pass 28 / fail 0
--- the baseline tree (0e34299) ---  tests 28 / pass 28 / fail 0
engine (baseline tree): 1.64.1 (D:/ICHOR/examples/sample-playwright/node_modules)
```

两侧都是 28/28 通过：**本次全量套件里没有 ATS-203 的失败**。此前记录的 4 条 ATS-203 失败，其触发条件是引擎版本（`examples/sample-playwright` 写的是 `^1.58.0`，浮动到 1.65.0 时出现）；本机当前解析到的是 1.64.1，因此不出现。那 4 条属于 ATS-203（权威发现索引），不在本票范围内。

## 未执行项

- **联网用例**：本夹具的两条用例都是离线的（`page.setContent`），因此本票没有覆盖真实站点的联网用例。
- **可中断的长用例（ST-010）** 与 **多次重复执行（ST-012）**：仍未实测。
- **ST-008 / ST-011**（真实浏览器下运行全部 passing 项目、失败后可下载证据）在本票的夹具范围内已覆盖其判定与产物部分，但仍是 `PENDING`，因为它们的原始表述涉及示例站访问与截图。
- **CANCEL 语义未验证**：`docs/16-BASELINE-ADR.md` 的 B-03（停止语义卡死）未修，且 B-01/B-03 要求同批修复与回归，本票未触及。FR-011 仍为双桩证据。
- **本票只覆盖那两条用例**；覆盖面窄这一点已在 `docs/WBS.xlsx` 的 ATS-107 备注与总览 D7 中如实写明。

## 复现

```
npm ci
npm --prefix examples/real-browser-fixture ci
node tools/ats107-probes/st-ats107.mjs . <scratch-dir>
node tools/ats107-probes/mutation-check.mjs
node tools/ats107-probes/no-browser-control.mjs
bash tools/ats107-probes/product-mutation-control.sh
node --test tests/ats107-real-browser-it.test.mjs
bash tools/ats107-probes/collect-evidence.sh
```

需要本机已安装 Playwright 的 Chromium（本票在 revision `1254` 上实测）。

**采集脚本的路径约定**：`collect-evidence.sh` 用 `pwd -W` 把**原生路径**交给 node——node 不认 MSYS 路径，`/c/Users/...` 会被它解析成字面目录 `C:\c\Users\...`（那正是此前 scratch 目录泄漏到树外的原因）。
