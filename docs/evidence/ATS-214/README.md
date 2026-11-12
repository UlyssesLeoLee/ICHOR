# ATS-214 证据目录 ｜ 用例搜索、标签、过滤及批量运行选择

> 采集脚本：`bash tools/ats214-probes/collect-evidence.sh`
> 采集环境：Windows 11 / Node 24.19.0 / Next.js 16.4.5 / 真实 Playwright 1.64.1
> 本轮：复核第 1 轮驳回后返工（第 1 轮交付的证据已被本轮取代）

## 这一轮的结果

| 测什么 | 命令 | 结果 |
|---|---|---|
| 共享模块的 UT | `node --test tests/ats214-case-search.test.mjs` | **44 / 44 通过** |
| 批次上下文与终态的 IT（真实 Bridge + 真实 Playwright） | `node --test tests/ats214-batch-context.test.mjs` | **7 / 7 通过** |
| 真实 Bridge 的 IT（标签进目录、两个索引一致、选择拒绝、批次拆分） | `node --test tests/ats214-batch-run-api.test.mjs` | **11 / 11 通过** |
| 标签一致性（静态索引 vs 真实 CLI `--list`） | `node tools/ats214-probes/tag-parity.mjs` | **12 / 12 用例逐条一致，0 处不符** |
| 全仓库回归 | `node --test --test-concurrency=2 tests/*.test.mjs` | **1768 例，1737 通过**（其余为按条件跳过的用例） |
| ST：真实 Chromium + 真实 Bridge + 500 用例夹具 | `node tools/ats214-probes/st-ats214.mjs` | **ST-ATS214-001~011 共 11 项，0 DEFECT** |
| 负控：交付代码被变异后测试必须变红 | `node tools/ats214-probes/mutation-check.mjs` | **10 / 10 个变异全部被抓住** |
| **复核方自己那套探针** | 见 `reviewer-probes/README.md` | **api 8 OK / ui 7 OK** |

## 每一步是什么，怎么复跑

| 文件 | 内容 | 复跑命令 |
|---|---|---|
| `01-node-test-case-search-ut.log` | 共享模块的 UT（44 例）：搜索口径、标签口径、集合语义、选择集合与对账、失效与移位用例 | `node --test tests/ats214-case-search.test.mjs` |
| `02-node-test-batch-run-it.log` | 真实 Bridge 的 IT（11 例）：标签进目录、两个索引一致、选择拒绝与记录、批次拆分 | `node --test tests/ats214-batch-run-api.test.mjs` |
| `03-tag-parity.log` | 静态索引与真实 Playwright `--list` 的标签逐条比对（12 条用例，0 处不一致） | `node tools/ats214-probes/tag-parity.mjs` |
| `04-node-test-full.log` | 全仓库回归（`--test-concurrency=2`） | `node --test --test-concurrency=2 tests/*.test.mjs` |
| `05-next-static-export-build.log` | 静态导出构建（含 TypeScript 检查） | `npm --prefix apps/studio run build` |
| `06-wbs-row-and-updaters.log` | WBS 第 35 行的状态/完成率/剩余人日，以及 35 个更新器共存回归 | `python tools/update_wbs_ats214.py --verify-only` + `bash tools/ats501-probes/check-wbs-updaters.sh` |
| `07-verify-checksums.log` | 发布清单校验（999 条，mismatch 0） | `python tools/verify_checksums.py` |
| `08-next-static-export-build-on-d.log` | 静态导出构建的**另一处实测**（在 D: 盘上带真实依赖的树里跑） | 见文件头的说明 |
| `09-acceptance-mapping.log` | **验收对照表**：完成定义的两句话各自对应哪份实测日志（由脚本读日志判定，不是手写） | 采集脚本第 10 步 |
| `10-st-500-cases.log` | ST：真实 Chromium 里的 500 用例夹具，11 项判定 | `node tools/ats214-probes/st-ats214.mjs` |
| `12-batch-context-it.log` | 批次上下文继承与终态的 IT（7 例） | `node --test tests/ats214-batch-context.test.mjs` |
| `13-mutation-control.log` | 负控：10 个变异逐个被抓住 | `node tools/ats214-probes/mutation-check.mjs` |
| `reviewer-probes/` | **复核方自己那套探针**的复跑结果与说明 | 见该目录的 `README.md` |

## 关于第 8 步

第 8 步是静态导出构建的**另一处**实测：在 D: 盘上带真实依赖的树里跑的
（构建的细节见该文件头）。第 5 步是在本 worktree 里跑的，两处都用本任务
分支上的同一批源文件。

**PENDING 不等于 PASS**：本目录里每一个 PASS 都对应一条实跑过的命令与它的实际输出。
采集脚本里任何一步缺了依赖或跑不起来，都会写成 **SKIPPED 并写明原因**，
不会记成 PASS。
