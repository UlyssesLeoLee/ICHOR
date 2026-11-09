# ATS-106 证据索引

设计：`docs/26-RUNNER-PREFLIGHT.md`。日志由 `tools/ats106-probes/collect-evidence.sh` 生成（`ATS106_STEPS` 可只重跑部分步骤），每份日志头部记录命令、提交、Node/Python 版本，正文为原样输出。

| 日志 | 内容 | 结果 |
|---|---|---|
| `01-preflight-ut.log` | `tests/preflight.test.mjs`：UT-PF-001..015、UT-ARG-001..009、UT-CORE-106-001..002，并带覆盖率 | 26/26 通过 |
| `02-preflight-it.log` | `tests/preflight-it.test.mjs`：真实 Bridge 进程 + 会留标记文件的测试替身 CLI（IT-PF-SETUP..007） | 8/8 通过 |
| `03-real-cli-contract.log` | `tests/preflight-real.test.mjs`：真实 `@playwright/test` 1.64.1。CT-PF-001 对真实安装做预检；CT-ARG-001 由真实 CLI 与真实 Chromium 执行 Bridge 构造的参数向量 | 2/2 通过 |
| `04-guard-mutations.log` | `tools/ats106-probes/mutation-tests.mjs`：在临时副本上逐个删除 7 处防护，对应测试必须失败 | 7/7 被捕获 |
| `05-python-tools.log` | `tools/test_wbs_common.py` + pytest（19 例），带覆盖率 | 通过 |
| `06-wbs-updater-regression.log` | 26 个 WBS 更新脚本共存回归 | RESULT: OK |
| `07-wbs-state.log` | `docs/WBS.xlsx` 中 ATS-106 行（第 11 行）与总览 | 状态 `待审核`，完成率 1，剩余 0 |
| `08-baseline-regression.log` | 全量套件 `node --test --test-concurrency=1 tests/*.test.mjs`、`node --check`、端口审计、ADR 行号引用、依赖清单 | 1469 条：1452 通过、2 失败、15 跳过；其余检查均为 OK。2 项失败见下 |
| `09-uqh-verify.log` | UQH `verify --base dev` 与各变更文件的行覆盖率 | 见下 |

## 生成提交

实现最初在分支 `agent/opus/seikoist-149-0413f9e2f0ae` 上完成，并以三方合并合入 `dev@b93d2da`（合并提交 `ce9526f`，分支 `agent/fable/seikoist-149`）。全部日志都在合并后的树上重新生成：

- 日志 01–08 生成于 `889950a`（合并提交之后只有 ADR 行号引用与 `.quality` Source-SHA256 元数据的更新）；
- 日志 09 生成于同一棵源码树（提交号见日志头部）。

全量套件串行执行（`ATS106_TEST_CONCURRENCY=1`），并设置了 `ATS_REAL_PLAYWRIGHT_PROJECT`，因此 CT-PF-001 与 CT-ARG-001 在套件内也针对真实安装执行。

### 08 中的 2 项失败

- `tests/migrate-state.test.mjs` ATS-206-UT-082：被测的 `migrate_state.mjs apply` 子进程以 `2147483651`（`0x80000003`）退出。该用例在同一棵树上单独重跑两次均通过（92/92），在未合并的 `dev@b93d2da` 上也通过。ATS-106 未改动 `tools/migrate_state.mjs` 及其测试。
- `tests/sqlite-bridge.test.mjs`：套件内失败，单独重跑 7/7 通过，`dev@b93d2da` 上也通过。ATS-106 未改动 SQLite 层。

两项都是本机在长套件后段的负载/内存压力下的子进程偶发失败，不是 ATS-106 的回归；如实保留日志，不重跑套件以掩盖它。

## 覆盖率

来自 09（UQH 同一次运行的 `.quality/coverage/{node,py}.lcov`）：

| 文件 | 行覆盖率 |
|---|---:|
| `server/adapters/playwright-preflight.mjs` | 99.60% |
| `server/adapters/playwright-cli.mjs` | 94.01% |
| `server/core.mjs` | 99.02% |
| `server/index.mjs` | 30.47% |
| `tools/update_wbs_ats106.py` | 98.46% |
| `tools/wbs_common.py` | 97.10% |

`server/index.mjs` 的大部分代码在 Bridge 子进程中运行，进程内 LCOV 采不到。ATS-106 在该文件中的三处改动（请求体白名单、过滤参数检查、预检门禁）由 IT-PF-001..007 执行，变异 M5–M7 证明删除任一处，IT 都会失败。

## UQH 门禁

UQH `verify --base dev` 的结论是 BLOCKED，共 5 项，测试命令本身没有失败：

- `tools/update_wbs_ats106.py`、`tools/wbs_common.py` 的 design-first 计划登记在原实现分支 `agent/opus/seikoist-149-0413f9e2f0ae` 上，而合并分支名为 `agent/fable/seikoist-149`，检查器要求在当前分支重新 `prepare`。实现已经完成并随合并进入本分支，在不改写历史的前提下无法再在实现之前插入一次设计提交，因此未重新封存。
- `tools/wbs_common.py` 的「design-commit integrity」：原分支的基线在开发中途两次移动（`dev@72a77da` → `dev@4878f5b` → `dev@cea120c`），以合并而非变基同步，第一个设计提交 `ff7c4d5` 的计划与后来重新封存的计划（`eef3f74`）不一致。该文件的实际改动只有在 `MARKERS` 中登记 `【ATS-106】` 一行。
- 项目整体行覆盖率 12.40%，且 LCOV 未包含 TSX、Rust 与探针脚本。这两项在本任务之前就存在，涉及的文件都不是 ATS-106 的。

## 未执行项

- ST-008 / ST-011：真实浏览器的 ST，属 ATS-107 / ATS-114。
- 向项目注入 `use.screenshot` / `use.video`：不在本任务范围内，见 `docs/26-RUNNER-PREFLIGHT.md` §4。
