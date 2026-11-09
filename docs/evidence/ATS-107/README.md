# ATS-107 证据索引

设计：`docs/31-REAL-BROWSER-FIXTURE.md`（`.quality/docs/examples/real-browser-fixture.md`、`.quality/docs/tools/ats107-probes/st-ats107.mjs.md`、`.quality/docs/tools/update_wbs_ats107.py.md`）。日志由 `tools/ats107-probes/collect-evidence.sh` 生成（`ATS107_STEPS` 可只重跑部分步骤），每份日志头部记录命令、提交、Node/Python 版本，正文为原样输出。

| 日志 | 内容 | 结果 |
|---|---|---|
| `01-fixture-contract.log` | 夹具的交付形态：精确固定的版本、入库的 lockfile、显式的 chromium、`retries: 0`、两条离线用例、夹具自己的 `tests/expected.json` | 7 个文件已入库 |
| `02-real-browser-probe.log` | **验收口径本身**：同一夹具分别经 Playwright CLI 直跑与经真实 Bridge 跑，逐条对账（判定 / 计数器 / 错误信息），并检查产物（`report.json` + 真实 `trace.zip`） | **25/25 通过** |
| `03-mutation-control.log` | `tools/ats107-probes/mutation-check.mjs`：对 Bridge 自身结果投影施加 10 种变异，每种都必须被对账逻辑抓住；未变异的真实结果必须被接受 | **14/14 被捕获**（10 种变异 + 4 项对照） |
| `04-python-tools.log` | 全部 Python 工具测试（`pytest tools/`） | 64 通过 |
| `05-wbs-updater-regression.log` | 全部 WBS 更新脚本共存回归（发现 `tools/update_wbs_ats107.py`） | RESULT: OK（29 个更新器） |
| `06-wbs-state.log` | `docs/WBS.xlsx` 中 ATS-107 行（第 12 行）与总览 | 状态 `待审核`，完成率 1，剩余 0 |
| `07-baseline-regression.log` | 全量套件 `node --test --test-concurrency=2 tests/*.test.mjs`、`node --check`、端口审计、ADR 行号引用、依赖清单 | 1592 条：1579 通过、**4 失败（既有，见下）**、9 跳过；其余检查均为 OK |

## 验收口径是怎么被证明的

`02-real-browser-probe.log` 的关键行：

```
PASS ST-1 the fixture pins an EXACT @playwright/test version -- declared=1.65.0
PASS ST-1 the fixture lockfile is COMMITTED -- examples/real-browser-fixture/package-lock.json ...
PASS ST-1 the fixture installs from its lockfile (npm ci) -- exit=0
PASS ST-1 the installed engine is the pinned one -- installed=1.65.0 pinned=1.65.0
PASS ST-2 the direct CLI run has at least one PASS -- 1 passed
PASS ST-2 the direct CLI run has at least one FAIL -- 1 failed
PASS ST-2 the direct CLI run used a real browser (the engine wrote a trace) -- error-context+trace | trace
PASS ST-3 the Bridge reports one passed and one failed -- {"passed":1,"failed":1,"total":2}
PASS ST-4 the per-case verdicts are IDENTICAL to the CLI's
PASS ST-5 the Bridge's error message is the engine's own -- the assertion text is present
PASS ST-6 the Bridge matches the fixture's declared expectations
PASS ST-7 the run folder holds the engine's report.json
PASS ST-7 the run folder holds a REAL trace.zip -- 2 trace(s)
PASS ST-8 the counters agree with the CLI's -- bridge=1/1/2 cli=1/1/2
RESULT: 25/25
```

三点需要评审者注意：

1. **基准不是产品自己**。期望值来自一次**独立的 Playwright CLI 直跑**（由探针自己的遍历器读出，不用产品的 `parseReport`）与夹具自己的 `tests/expected.json`。拿 Bridge 和自己比是恒等式，证明不了任何事。
2. **「真实浏览器」是被检查的，不是被假定的**。`ST-2` 要求引擎真的写出了 trace；`ST-7` 要求运行目录里真的有 `trace.zip`。没有浏览器时探针报 SKIP 而不是 PASS。
3. **错误信息是引擎自己写的**。`ST-5` 断言 Bridge 那一侧的失败原因里含有引擎写的断言文本（`ATS-107 FAIL — this text is intentionally absent`），即 Bridge 既不丢弃也不改写。

## 为什么还要有变异负控（`03-mutation-control.log`）

只喂一份诚实结果的对账，无法证明它会工作——它对不诚实的结果也会照样放行。因此对账逻辑抽成纯函数模块 `tools/ats107-probes/compare.mjs`，并由 `mutation-check.mjs` 喂进 10 种变异（把失败算成通过、报 2 passed、两条判定互换、丢掉错误信息、改写错误信息、计数对但逐条错、判定与夹具声明不符、少报一条、多报一条、总数报错）。每一种都必须被抓住，且未变异的诚实结果必须被接受。变异只作用于内存副本，不触碰产品源码。

## 全量套件里的 4 个失败（既有缺陷，如实记录）

`07-baseline-regression.log` 显示 1592 条中 **4 失败**：

- `ST-ATS203-002`
- `ST-ATS203-004`
- `IT-ATS203-006`
- `ST-ATS-203-006`

这 4 个**不是 ATS-107 造成的**：把本票的全部改动 `git stash` 之后（即在基线 `0e34299` 的内容上）单独重跑这三个测试文件，结果是 28 条中 24 通过、**同样这 4 条失败**（`the two projects report two different spec ids`，`1 !== 2`）。它们属于 ATS-203（权威发现索引），不在本票范围内，本票不代为修复。

## 未执行项

- **联网用例**：本夹具的两条用例都是离线的（`page.setContent`），因此本票没有覆盖真实站点的联网用例。
- **可中断的长用例（ST-010）** 与 **多次重复执行（ST-012）**：仍未实测。
- **ST-008 / ST-011**（真实浏览器下运行全部 passing 项目、失败后可下载证据）在本票的夹具范围内已覆盖其判定与产物部分，但仍是 `PENDING`，因为它们的原始表述涉及示例站访问与截图。
- **本票只覆盖那两条用例**；覆盖面窄这一点已在 `docs/WBS.xlsx` 的 ATS-107 备注与总览 D7 中如实写明。

## 复现

```
npm ci
npm --prefix examples/real-browser-fixture ci
node tools/ats107-probes/st-ats107.mjs . <scratch-dir>
node tools/ats107-probes/mutation-check.mjs
bash tools/ats107-probes/collect-evidence.sh
```

需要本机已安装 Playwright 的 Chromium（本票在 revision `1254` 上实测）。
