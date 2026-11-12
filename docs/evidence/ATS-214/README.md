# ATS-214 证据目录 ｜ 用例搜索、标签、过滤及批量运行选择

> 采集脚本：`bash tools/ats214-probes/collect-evidence.sh`
> 采集环境：Windows 11 / Node 24.19.0 / Next.js 16.4.5 / 真实 Playwright 1.64.1
> 结果：**RESULT: OK**（每一步都实跑并通过）

## 每一步是什么，怎么复跑

| 文件 | 内容 | 复跑命令 |
|---|---|---|
| `01-node-test-case-search-ut.log` | 共享模块的 UT（35 例）：搜索口径、标签口径、集合语义、选择集合与对账 | `node --test tests/ats214-case-search.test.mjs` |
| `02-node-test-batch-run-it.log` | 真实 Bridge 的 IT（11 例）：标签进目录、两个索引一致、选择拒绝与记录、批次拆分 | `node --test tests/ats214-batch-run-api.test.mjs` |
| `03-tag-parity.log` | 静态索引与真实 Playwright `--list` 的标签逐条比对（6 条用例，0 处不一致） | `node tools/ats214-probes/tag-parity.mjs` |
| `04-node-test-full.log` | 全仓库回归（`--test-concurrency=2`） | `node --test --test-concurrency=2 tests/*.test.mjs` |
| `05-next-static-export-build.log` | 静态导出构建：本机无 `apps/studio/node_modules`，按仓库约定**跳过并写明原因** | `npm --prefix apps/studio run build` |
| `06-wbs-row-and-updaters.log` | WBS 第 35 行的状态/完成率/剩余人日，以及 33 个更新器共存回归 | `python tools/update_wbs_ats214.py --verify-only` + `bash tools/ats501-probes/check-wbs-updaters.sh` |
| `07-verify-checksums.log` | 发布清单校验（950 条，mismatch 0） | `python tools/verify_checksums.py` |
| `08-next-static-export-build-on-d.log` | 静态导出构建的**实测**（在 D: 盘上带真实依赖的树里跑，含 TypeScript 检查） | 见文件头的说明 |

## 关于第 5 步与第 8 步

第 5 步在本机是 **SKIPPED**，不是 PASS：本仓库的 worktree 里没有 `apps/studio/node_modules`
（依赖装在 `D:/ICHOR`），而 Turbopack 在给定的文件系统根里解析不到跨卷 junction 指向的
`next/package.json`。

因此构建在 **D: 盘上带真实依赖的树**里实测（第 8 步），用的是本任务分支上的同一批源文件
（逐字节相同）。该树的构成与复跑方式写在第 8 步的文件头里。

**PENDING 不等于 PASS**：本目录里每一个 PASS 都对应一条实跑过的命令与它的实际输出。
