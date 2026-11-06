# ATS-106 证据索引

设计：`docs/26-RUNNER-PREFLIGHT.md`。日志由 `tools/ats106-probes/collect-evidence.sh` 生成（`ATS106_STEPS` 可只重跑部分步骤），每份日志头部记录命令、提交、Node/Python 版本，正文为原样输出。

| 日志 | 内容 | 结果 |
|---|---|---|
| `01-preflight-ut.log` | `tests/preflight.test.mjs`：UT-PF-001..015、UT-ARG-001..009、UT-CORE-106-001..002，并带覆盖率 | 26/26 通过 |
| `02-preflight-it.log` | `tests/preflight-it.test.mjs`：真实 Bridge 进程 + 会留标记文件的测试替身 CLI（IT-PF-SETUP..007） | 8/8 通过 |
| `03-real-cli-contract.log` | `tests/preflight-real.test.mjs`：真实 `@playwright/test` 1.64.1。CT-PF-001 对真实安装做预检；CT-ARG-001 由真实 CLI 与真实 Chromium 执行 Bridge 构造的参数向量 | 2/2 通过 |
| `04-guard-mutations.log` | `tools/ats106-probes/mutation-tests.mjs`：在临时副本上逐个删除 7 处防护，对应测试必须失败 | 7/7 被捕获 |
| `05-python-tools.log` | `tools/test_wbs_common.py` + pytest，带覆盖率 | 通过；`update_wbs_ats106.py` 98%，`wbs_common.py` 97% |
| `06-wbs-updater-regression.log` | 19 个 WBS 更新脚本共存回归 | RESULT: OK |
| `07-wbs-state.log` | `docs/WBS.xlsx` 中 ATS-106 行与总览 | 状态 `待审核`，完成率 1，剩余 0 |
| `08-baseline-regression.log` | 全量套件 `node --test --test-concurrency=2 tests/*.test.mjs`、`node --check`、端口审计、ADR 行号引用、依赖清单 | 784 条：773 通过、0 失败、11 跳过（均不属于本任务）；其余检查均为 OK |
| `09-uqh-verify.log` | UQH `verify --base dev` 与各变更文件的行覆盖率 | 见下 |

## 生成提交

全部日志都在合并后的树上生成：提交 `445953c`，即本任务分支合入 `dev@4878f5b` 之后。全量套件运行时设置了 `ATS_REAL_PLAYWRIGHT_PROJECT`，因此 CT-PF-001 与 CT-ARG-001 也在套件内针对真实安装执行。

## 覆盖率

| 文件 | 行覆盖率 |
|---|---:|
| `server/adapters/playwright-preflight.mjs` | 99.60% |
| `server/adapters/playwright-cli.mjs` | 94.01% |
| `server/core.mjs` | 97.56% |
| `tools/update_wbs_ats106.py` | 98.46% |
| `tools/wbs_common.py` | 97.42% |
| `server/index.mjs` | 33.97% |

`server/index.mjs` 的大部分代码在 Bridge 子进程中运行，进程内 LCOV 采不到。ATS-106 在该文件中的三处改动（请求体白名单、过滤参数检查、预检门禁）由 IT-PF-001..007 执行，变异 M5–M7 证明删除任一处，IT 都会失败。

## UQH 门禁

UQH `verify --base dev` 的结论是 BLOCKED，共三项：

- 项目整体行覆盖率 14.90%，且 LCOV 未包含 TSX、Rust 与探针脚本。这两项在本任务之前就存在，涉及的文件都不是 ATS-106 的。
- `tools/wbs_common.py` 的「design-commit integrity」。分支基线在开发中途从 `dev@72a77da` 移到 `dev@4878f5b`（ATS-207 合入），本分支以合并而非变基同步基线。检查器取 `dev..HEAD` 中第一个设计提交 `ff7c4d5` 的计划，与基于新基线重新封存的计划（设计提交 `eef3f74`）比较；而保留 `ff7c4d5` 的计划又会因基线指纹不符而失败。在不改写历史的前提下，两条规则无法同时满足。该文件的实际改动只有在 `MARKERS` 中登记 `【ATS-106】` 一行。

各变更文件的覆盖率检查没有报告问题，测试命令也没有失败。

## 未执行项

- ST-008 / ST-011：真实浏览器的 ST，属 ATS-107 / ATS-114。
- 向项目注入 `use.screenshot` / `use.video`：不在本任务范围内，见 `docs/26-RUNNER-PREFLIGHT.md` §4。
