## ATS-103 第 3 轮返工完成（Opus 第 2 轮 R1–R4）

**结论**：R1–R4 四项全部改完，证据在**合并后的 dev 树**上重新采集，克隆（CRLF 与 LF 各一份）里复跑一致。分支 `agent/m2/seikoist-148-0d254fa57bf5`，基线 `54e1a1d`，tip 见下。

### R1 以偏概全 → 已按两种形状分述，并新增变异 A′

原文「Next.js 在该模式下于构建期直接拒绝 route handler，服务端路由连构建都过不去」确实以偏概全：报错原文写的就是 `dynamic = "force-static" ... not configured`，被拒绝的只是**未声明 `force-static`** 的 handler。

- `docs/22-FRONTEND-EXPORT.md` §2 第 1 条改为如实区分两种形状；探针源码里对应的注释同步改写。
- `tools/ats103-probes/mutation-evidence.sh` 新增**变异 A′**（`export const dynamic = 'force-static';`）。实测：构建**成功**，handler 被预渲染成 `out/api/session`，文件树断言**变红**——
  ```
  FAIL  the export contains no server-side API route output  --  found: api/session
  RESULT: FAILED -- 24/25 checks passed.
  PROBE_EXIT=1
  ```
  退出码 1，与要求一致。
- 原变异 A 保留，并注明它证明的是「构建被拒绝」，**没有**执行到文件树遍历那段逻辑——两者证明的是不同的东西。

### R2 过度推论 → 选 (b)，改成可执行判别

两条「基址」断言用的是**同一个谓词**（`readsLocation && comparesPort`），是过度推论。

- 两条断言**合并为一条**，如实描述为**静态启发式**：「bundle 里存在一个对 `location.port` 的比较」。
- 真正的证明改由 **`tools/ats103-probes/ui-smoke.mjs` 的可执行判别**承担：页面按**主机名** `localhost` 打开（不是数字地址），记录浏览器**实际**请求到的 host。干净源码下：
  ```
  PASS  the page's API requests go to the host its own location implies  --  page location host: localhost:4577; API request hosts: localhost:4577
  RESULT: OK -- 8/8 checks passed.
  ```
- 新增**变异 B2**（基址写死 **且** 留一个**无关的** `location.port` 比较，接进活代码路径）。实测这条边界正好划出来：

  | 变异 | 静态启发式 | 可执行判别 |
  |---|---|---|
  | B（基址写死，bundle 里没有端口比较） | **红**（24/25，exit 1） | **红**（7/8，exit 1） |
  | B2（基址写死 + 无关端口比较） | **绿**（25/25，exit 0）——这就是它的边界 | **红**（7/8，exit 1） |

  B2 让静态启发式**无法**与诚实 bundle 区分，这一点文档里写明了；「基址在运行时解析」由可执行判别证明。

### R3 易变数字 → 改为不写死、只引用日志

- `docs/22` §3.2 那段构建输出**去掉全部用时数字**（编译 238ms / TypeScript 1609ms / 装包 1m 这类），只保留稳定部分（版本号、产物形态、路由清单），并明写「用时数字以 `02-next-static-export-build.log` 为准」。
- §19 那行的用时数字一并去掉。
- 顺带修掉同一类问题：§3.5 的 `npm test` 数字、§3.6 的「8 个更新器」、§3.7 的「8 步门禁」、每例耗时、产物数 27→28 —— 这些都会随 dev 上的合并漂移，改为引用日志的当次真实输出。

### R4 合并 dev → 已合入并重跑全部指定项

- 已把 dev 合入本分支（本轮 dev 在返工期间又前进了多次，从 `72a77da` 走到 `ceb3940`；WBS.xlsx 以 dev 版本为基础再重放本任务的行更新，不回退 dev 上已复核通过的状态）。
- 在合并后的树上重新生成 `CHECKSUMS.sha256`。
- **在两份克隆里**复跑（门禁与校验面对的是**已提交**的文件，所以不在工作区自证）：
  - CRLF clone（`core.autocrlf=true`）与 LF clone（`git -c core.autocrlf=false clone`），两份都指向**同一个提交**；
  - `verify_checksums.py` → **OK**（484 条，0 处失配）；端口审计 → **OK**；`check_adr_citations.py` → **OK**；`check-wbs-updaters.sh` → **OK**（18 个更新器共存）；`npm test` → **0 失败**；
  - 证据入库：`docs/evidence/ATS-103/10-r4-clone-verification-crlf.log` 与 `10-r4-clone-verification-lf.log`。

**dev 上的合并提交 SHA**：见本分支最后一次 `merge(dev)` 提交的父提交——复核时 `git log --oneline -1 dev` 即可取到当时 dev 的 tip。

### 其余实测项（合并后的树上，Node 22.23.4 / npm 10.9.9）

| 证据 | 结论 |
|---|---|
| 01 导出 + Bridge API 接缝 | **25/25**，exit 0 |
| 03 `npm test` | **0 失败** |
| 05 同源浏览器 | **8/8**，exit 0 |
| 05b 白名单跨源 | **7/8**，exit 1（**这是负控**，预期红） |
| 06 五个变异 A/A′/B/B2/C | 边界与文档所写一致 |
| 07 端口审计 | **OK** |
| 08 ADR 引用 | **OK** |
| 09 构建门禁 | 每一步都通过 |

### 顺带修掉的一个真问题

变异 B2 的注入脚本少了一行 `import re`，运行时报 `NameError`，**中断了整个采集流程**——日志里 B2 段落只有「DID NOT APPLY」，后面的变异 C 根本没跑到，而采集脚本本身仍然以 0 退出，看上去一切正常。已补上，并改成：**变异应用失败时不再中断后续变异**（记录失败 → 重建干净导出 → 继续跑完剩下的 → 整个脚本最后以非 0 退出）。一个没能应用的变异会让日志里的绿灯与「变异真的生效了」无法区分，这种失败不能看起来像成功。

### 未验证项（不变，仍是 PENDING）

见 `docs/22-FRONTEND-EXPORT.md` §6：未在 macOS/Linux 实测、未在真实 Tauri 壳内实测、未做人工可用性评测、Bridge 运行结果依赖宿主机内存、ATS-101 阻断项 B-01 的「不复现」结论只覆盖本组参数、GitHub Actions 未在真实 runner 跑过、WBS 行的 ATS-103 状态是「待审核」而非「已完成」。

Original executor: M2
