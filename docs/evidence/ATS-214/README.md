# ATS-214 证据目录 ｜ 用例搜索、标签、过滤及批量运行选择

> 采集脚本：`bash tools/ats214-probes/collect-evidence.sh`
> 复核方探针：`bash tools/ats214-probes/run-reviewer-probes.sh <探针目录>`
> 采集环境：Windows 11 / Node 24.19.0 / Next.js 16.4.5 / 真实 Playwright 1.64.1
> 本轮：复核第 2 轮的驳回意见逐条返工（第 1、2 轮交付的证据已被本轮取代）

## 这一轮的结果

| 测什么 | 命令 | 结果 |
|---|---|---|
| 共享模块的 UT | `node --test tests/ats214-case-search.test.mjs` | **44 / 44 通过** |
| 批次上下文与终态的 IT（真实 Bridge + 真实 Playwright） | `node --test tests/ats214-batch-context.test.mjs` | **10 / 10 通过** |
| 真实 Bridge 的 IT（标签进目录、两个索引一致、选择拒绝、批次拆分） | `node --test tests/ats214-batch-run-api.test.mjs` | **11 / 11 通过** |
| 标签一致性（静态索引 vs 真实 CLI `--list`） | `node tools/ats214-probes/tag-parity.mjs` | **12 / 12 用例逐条一致，0 处不符** |
| 全仓库回归 | `node --test --test-concurrency=2 tests/*.test.mjs` | **1794 例，1763 通过，0 失败**（31 例按条件跳过） |
| ST：真实 Chromium + 真实 Bridge + 500 用例夹具 | `node tools/ats214-probes/st-ats214.mjs` | **ST-ATS214-001~011 共 11 项，0 DEFECT** |
| 负控：交付代码被变异后测试必须变红 | `node tools/ats214-probes/mutation-check.mjs` | **12 / 12 个变异全部被抓住** |
| WBS 第 35 行 + 35 个更新器共存 | `python tools/update_wbs_ats214.py --verify-only` + `bash tools/ats501-probes/check-wbs-updaters.sh` | **待审核 / 完成率 1 / 剩余 0；RESULT: OK** |
| **复核方自己那套探针** | `bash tools/ats214-probes/run-reviewer-probes.sh <探针目录>` | **r1-api 8 OK（+B3 信息项）/ r2-extra 2 OK / r2-ui 7 OK，0 DEFECT** |

## 这一轮返工的三件事

### 1. 批次记录不再携带环境变量的值（复核意见 E1）

`batch.context` 现在只存档案的**引用**（`envUid` / `envName` / `envTier`），
不存任何变量的值。`GET /api/batches` 因此不可能返回一个环境变量的值。

旧批次记录里已经带着的值，在 Bridge 启动加载状态时被清除——升级之后也不泄漏。

### 2. 白名单约束的是运行，而不只是写入（复核意见 E2）

每个批次的 run 在**启动时重新解析**那份引用：按**当前**白名单过滤（与单文件
路径是同一个函数、同一个白名单来源），凭据引用在运行时才解析。

于是：run#1 期间收紧白名单，之后启动的 run#2 **不再**带着被移除的变量。
档案在批次进行中被删除时，批次以 `ENV_PROFILE_NOT_FOUND` 结束，
第二个文件不会在「无档案」的静默回落下跑过。

新增三例 IT（`tests/ats214-batch-context.test.mjs`）：IT-ATS214-036（批次记录
不携带变量值）、IT-ATS214-037（白名单收紧后对后续 run 生效）、
IT-ATS214-038（档案被删后批次终止）。**三例在修复前全部变红、修复后全部变绿**
（已实测，过程见提交说明）。

### 3. 500 用例的响应预算（ST-003 / r2-ui P1）

复跑时 P1 是红的（106–118ms）。用 Chrome DevTools Protocol 的
`Performance.getMetrics` 定位到：`LayoutDuration` 108.9ms，而
`ScriptDuration` 只有 18ms——时间花在**排版**上。三处改动：

| 原来 | 代价 | 改成 |
|---|---|---|
| 选择记录**每个已选用例一行表格** | 勾选 500 条时多出 501 个 `<tr>`、4000+ 个 DOM 节点 | 选择记录**按文件分组**，每组只列前几条（选择集合本身仍是完整快照） |
| 每行问两次「这条勾上了吗」，`Array.includes` 线性扫描 | 500 行 × 500 个已选 UID × 2 次 = 每次渲染 50 万次字符串比较 | 勾选状态存成 `Set`，查询 O(1) |
| 用例行内联在列表里 | 勾选一条 → 500 行全部重渲染 | 行拆成记忆化的组件（`CaseRow` / `PickBox` / `CaseTitle`） |

改完之后：r2-ui **P1 = 76ms**、ST-003 **= 52ms**，都在 100ms 预算内。

## 每一步是什么，怎么复跑

| 文件 | 内容 | 复跑命令 |
|---|---|---|
| `01-node-test-case-search-ut.log` | 共享模块的 UT（44 例）：搜索口径、标签口径、集合语义、选择集合与对账、失效与移位用例 | `node --test tests/ats214-case-search.test.mjs` |
| `02-node-test-batch-run-it.log` | 真实 Bridge 的 IT（11 例）：标签进目录、两个索引一致、选择拒绝与记录、批次拆分 | `node --test tests/ats214-batch-run-api.test.mjs` |
| `03-tag-parity.log` | 静态索引与真实 Playwright `--list` 的标签逐条比对（12 条用例，0 处不一致） | `node tools/ats214-probes/tag-parity.mjs` |
| `04-node-test-full.log` | 全仓库回归（`--test-concurrency=2`） | `node --test --test-concurrency=2 tests/*.test.mjs` |
| `05-next-static-export-build.log` | 静态导出构建（含 TypeScript 检查） | `npm --prefix apps/studio run build` |
| `06-wbs-row-and-updaters.log` | WBS 第 35 行的状态/完成率/剩余人日，以及 35 个更新器共存回归 | `python tools/update_wbs_ats214.py --verify-only` + `bash tools/ats501-probes/check-wbs-updaters.sh` |
| `07-verify-checksums.log` | 发布清单校验（逐条比对 git blob） | `python tools/verify_checksums.py` |
| `08-next-static-export-build-on-d.log` | 静态导出构建的**另一处实测**（在 D: 盘上带真实依赖的树里跑） | 见文件头的说明 |
| `09-acceptance-mapping.log` | **验收对照表**：完成定义的两句话各自对应哪份实测日志（由脚本读日志判定，不是手写） | 采集脚本第 10 步 |
| `10-st-500-cases.log` | ST：真实 Chromium 里的 500 用例夹具，11 项判定 | `node tools/ats214-probes/st-ats214.mjs` |
| `12-batch-context-it.log` | 批次上下文继承与终态的 IT（10 例，含本轮新增的三例） | `node --test tests/ats214-batch-context.test.mjs` |
| `13-mutation-control.log` | 负控：12 个变异逐个被抓住 | `node tools/ats214-probes/mutation-check.mjs` |
| `reviewer-probes/` | **复核方自己那套探针**的复跑结果与说明 | `bash tools/ats214-probes/run-reviewer-probes.sh <探针目录>` |

## 关于第 8 步

第 8 步是静态导出构建的**另一处**实测：在 D: 盘上带真实依赖的树里跑的
（构建的细节见该文件头）。第 5 步用的是同一批源文件。

**PENDING 不等于 PASS**：本目录里每一个 PASS 都对应一条实跑过的命令与它的实际输出。
采集脚本里任何一步缺了依赖或跑不起来，都会写成 **SKIPPED 并写明原因**，
不会记成 PASS。
