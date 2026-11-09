# ATS-203 证据摘要 ｜ 动态/参数化/项目矩阵索引回归数据集

**WBS ID**：ATS-203 ｜ 阶段 / 目标版本：S2 / v0.2.0 ｜ 关联要件：FR-021
**验收标准**：重名、describe、参数化、重复 project 的结果正确**或**标明不可判定
**执行人**：M3（协调者 M2 派工，第 3 轮返工）

---

## 1. 交付物

| 文件 | 层 | 用例数 | 说明 |
|---|---|---|---|
| `tests/ats203-regression-dataset.test.mjs` | 数据集（进程内） | 11 | 场景化断言：条数、标题、`uidStable`、`uidSource`、`ambiguity.reason`、`specIds` 数、warning 的**场景特有**片段 |
| `tests/ats203-index-it.test.mjs` | IT | 9 | 走真实 Playwright 1.64.1 的 `playwright test --list` 权威路径（`discoverTests`） |
| `tests/ats203-index-api.test.mjs` | ST | 6 | 走 Bridge 的 HTTP 发现 API（`/api/projects/:id/tests`） |
| `tools/ats203-probes/run-mutants.sh` | 探针 | — | 变异测试：把 4 个变异体植入树副本，跑数据集 |
| `tools/ats203-probes/mutants.py` | 探针 | — | 4 个变异体的定义 |
| `tools/ats203-probes/measure.mjs` | 探针 | — | 10 个场景的静态/权威对照实测 |

**代码改动**（本轮新��）：
- `server/uid.mjs` —— 模板标题（含 `${}`）不再派生稳定 UID，改为不可判定。
- `server/core.mjs` —— `warning` 里把「动态模板标题」与「标题重复」分开计数。
- `docs/18-UID-SPEC.md` §3.2、`docs/04-DETAILED-DESIGN.md`、`docs/23-AUTHORITATIVE-DISCOVERY.md` §7 —— 设计先行，同步新的分类。
- `tools/update_wbs_ats203.py`、`tools/wbs_common.py` —— WBS 第 24 行与总览 D6/D7 改为实测的最终状态。

---

## 2. 第 2 轮驳回 9 项的逐条处理

| 项 | 要求 | 处理 | 证据 |
|---|---|---|---|
| 1 | 断言要有判别力；M1、M2 必须失败，M3 上所有静态场景必须失败 | 断言落在具体输出上；新增 M4（把模板当稳定条目，即**原始缺陷**）。三个文件都抓住全部 4 个变异体 | `mutants-output.log`、`mutants-it-output.log`、`mutants-st-output.log` |
| 2 | 去掉 `test.each`，改用真实的 `for` / `forEach` | 全部夹具改用 `for` / `forEach`；`test.each` 只在 WBS 文字里作为「Playwright 里不存在此 API」的实测事实出现 | `tests/ats203-*.mjs` |
| 3 | 补项目矩阵：对称 2/2、非对称 2/1，断言静态与权威 UID 一致；ST-006 改名 | ST-ATS-203-006（对称）、ST-ATS-203-007（非对称）、IT-ATS203-006/007、ST-ATS203-004/005；原 ST-006 改名 ST-ATS-203-008「重复发现的确定性」 | 同上 + `it-test-run.log`、`st-test-run.log` |
| 4 | 补 IT（真实 Playwright 走 `discoverTests`）与 ST（走 Bridge 发现 API） | IT 9 例覆盖参数化循环、三类重名、跨文件同名、不同 describe 下同名、项目矩阵；ST 6 例走 HTTP API | `it-test-run.log`、`st-test-run.log` |
| 5 | 处理循环用例的假稳定条目（二选一），删掉「实现无缺陷」 | **方案 (a)**：静态索引把模板标题标为不可判定（`uidStable=false`、`ambiguity.reason='dynamic-template-title'`），设计文档先行更新 | `dataset-test-run.log`、`docs/18-UID-SPEC.md` §3.2 |
| 6 | 参数化同名用例固化进数据集，静态与权威各断言一次 | ST-ATS-203-002、IT-ATS203-002、ST-ATS203-003 | 同上 |
| 7 | 在 `docs/08-IT-TEST-DESIGN.md` 与 `docs/09-ST-TEST-DESIGN.md` 登记用例 | IT 9 行 + ST 6 行，用例编号与实际层级一致，对应 FR-021 与 `docs/23:397` | 两份设计书 |
| 8 | 改正 WBS 文字（`update_wbs_ats203.py` 的 NOTE、`wbs_common.py` 的 D6/D7） | 改为整改后**实测的最终状态**：删除「test.each」「参数化标记为动态」「同一项目被索引两次 = 项目矩阵」等说法；写明缺陷已关闭 | `docs/WBS.xlsx` 第 24 行、`check-wbs-updaters.log` |
| 9 | 按流程交付：任务分支 → `git merge --no-ff` 合回 `dev`；重采证据；重生成 CHECKSUMS | 见 §6 | 本分支的提交记录 |

---

## 3. 变异测试（断言判别力的证明）

探针把一个变异体植入树的副本，然后跑交付的数据集。**基线必须全绿，每个变异体必须被抓住。**

数据集 `tests/ats203-regression-dataset.test.mjs`（基线 11 例）：

| 变异体 | 植入的缺陷 | 结果 |
|---|---|---|
| 基线 | 无 | pass=11 fail=0 |
| M1 | `ambiguity` 不再挂到用例上（只留 `uidStable=false`） | **pass=6 fail=5** ✅ 抓住 |
| M2 | 静态扫描丢弃模板标题用例 | **pass=9 fail=2** ✅ 抓住 |
| M3 | 静态扫描返回空 | **pass=0 fail=11** ✅ 全部静态场景变红 |
| M4 | 模板标题被当成普通字面量标题（**第 1 轮的原始缺陷**） | **pass=9 fail=2** ✅ 抓住 |

IT `tests/ats203-index-it.test.mjs`（基线 9 例）：M1 fail=5、M2 fail=2、M3 fail=9、M4 fail=2 —— 全部抓住。
ST `tests/ats203-index-api.test.mjs`（基线 8 例，含 SETUP/CLEANUP）：M1 fail=2、M2 fail=1、M3 fail=2、M4 fail=1 —— 全部抓住。

`RESULT: OK` —— 见三份 `mutants-*-output.log`。

---

## 4. 实测执行输出

| 命令 | 结果 | 日志 |
|---|---|---|
| `node --test tests/ats203-regression-dataset.test.mjs` | **11 pass / 0 fail** | `dataset-test-run.log` |
| `node --test tests/ats203-index-it.test.mjs` | **9 pass / 0 fail** | `it-test-run.log` |
| `node --test tests/ats203-index-api.test.mjs` | **8 pass / 0 fail**（6 个 ST 场景 + SETUP + CLEANUP） | `st-test-run.log` |
| `bash tools/ats203-probes/run-mutants.sh` | **RESULT: OK**（4/4 变异体被抓住） | `mutants-output.log` |
| `bash tools/ats501-probes/check-wbs-updaters.sh` | **RESULT: OK**（25 个更新器共存、幂等、不撤销已验收、总览缓存一致） | `check-wbs-updaters.log` |
| `python -m pytest tools/test_wbs_common*.py` | **13 passed** | 见 §7 |
| `python tools/update_wbs_ats203.py --verify-only` | **PASS**（待审核 / 完成率 1 / 剩余人日 0 / marker×1） | 见 §7 |
| `node --test tests/*.test.mjs`（全量） | 见 `full-test-suite.log` | `full-test-suite.log` |

真实 Playwright 的版本：**1.64.1**（`examples/sample-playwright/node_modules`，通过 junction 接入夹具，未安装任何东西）。

---

## 5. 关键实测事实（本轮纠正的与旧结论相反的说法）

1. **模板标题现在是不可判定的。** 静态索引对 `for (const m of [...]) test(\`支付 - ${m}\`)` 给出 **1 条**、标题是模板原文、`uidStable=false`、`uidSource=provisional`、`ambiguity.reason='dynamic-template-title'`；权威索引对同一夹具给出 **3 条**渲染用例（`支付 - 支付宝` / `支付 - 微信` / `支付 - 银行卡`），各有稳定 UID。`consistency` 报告 `agrees=false`、`onlyAuthoritative=3`、`onlyStatic=1`。
2. **`test.each` 在 Playwright 里不存在。** 真实 CLI 报 `TypeError: _test.test.each is not a function`；静态索引对这种写法给 **0 条**。参数化在 Playwright 里是循环。
3. **重名由引擎裁决，不由索引裁决。** 同 describe 同名、同名 describe、参数化同名这三种情形，真实引擎都用 `duplicate test title` 拒绝整个文件；权威发现回退到静态索引，`outcome=PLAYWRIGHT_LIST_FAILED`，`warning` 与 `errors[0].message` 带着引擎自己的理由。跨文件同名与不同 describe 下的同名则由权威索引按 describe 路径正确区分（`uidStable=true`，UID 互不相同）。
4. **项目矩阵只出现在权威索引里。** 对称矩阵每条用例 `specIds=2`；非对称 `testMatch` 矩阵 `case a` 是 2、`case b` 是 1。静态索引不带 spec id。两种索引对同一逻辑用例给出**相同 UID**。

---

## 6. 交付流程

- 整改在任务分支 `agent/m3/seikoist-165` 上完成（起点 `fd254b1`）。
- 合回 `dev` 用 `git merge --no-ff`（见提交记录）。
- **未合入** `775787f`（`{`、`t.ambiguity`、`.serena/`）与 `38fd216`（`hs_err_pid*.log`）—— 这两个提交仍在 `agent/haiku/seikoist-165` 上，没有进入本分支。
- 证据在 `docs/evidence/ATS-203/`，CHECKSUMS 在交付后用 `tools/update_checksums.py` 重新生成。

---

## 7. 未验证项 / 已知限制

1. **ST 层的 6 个场景是走 HTTP API 的，不是走 UI 的。** 本任务没有跑便携 UI 或 Next 工作台；ST-001~ST-033 这类 UI 验收用例不在 ATS-203 的范围内（见 `docs/09-ST-TEST-DESIGN.md` 里它们仍是 PENDING）。ATS-203 的 ST 覆盖的是**发现 API 的返回**。
2. **没有在真实 macOS / Linux 上跑。** 全部实测在 Windows 11 + Node 上完成。
3. **夹具的 Playwright 是 junction 接进来的，不是 `npm install` 出来的。** 引擎版本是真实的 1.64.1，但依赖树来自 `examples/sample-playwright/node_modules`。若该目录不存在，需要真实 Playwright 的用例会**跳过并写明原因**，不会报成通过。
4. **`server/` 的产品代码改动只有两处**（`server/uid.mjs` 的模板判定、`server/core.mjs` 的 warning 计数），没有触碰 ATS-202 的权威发现实现，也没有触碰 ATS-204 的身份映射器。UID 重识别（改名/改标题后的 UID 找回）仍属 ATS-204。
5. **全量测试的并发环境噪声。** `npm test` 会并行启动多个 Bridge；本轮的全量日志里若有与 ATS-203 无关的偶发失败，以 `full-test-suite.log` 的实际输出为准，本文档不预先声明全绿。
