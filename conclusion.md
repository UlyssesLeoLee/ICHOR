## 结论摘要

**ATS-102（锁文件、依赖与 Windows CI 构建脚本）已按第 1 次复核（REJECT）的 6 条必须修改项逐条整改完毕，并已合入本地集成分支 `dev`（`d9cffc8`）。验收标准「Node22 clean install + npm test 成功；锁文件可重现；生成依赖清单」三项在 **Node 22.23.4 / npm 10.9.9** 上实测通过。**

本轮处理的是复核驳回后的整改，不是首次交付。复核指出的 6 条必须修改项全部落地，每条都附了实际命令输出（不是描述）。

复核中**先独立复现了每一条反例**，确认成立后才动手改：

| 复核的反例 | 本轮复现结果 |
|---|---|
| `npm test` 在交付树上失败 | **成立**：Node 22.23.4 下 `# tests 160 / # pass 126 / # cancelled 27`，退出码 1；注释掉 `server/agent.mjs` 的 `timer.unref()` 后同一棵树 `# pass 153 / # cancelled 0`、退出码 0 |
| CI 先重生成再比对 = 拿文件与自身比较 | **成立**：篡改清单一条 `integrity` 后，先重生成再 `--check` 退出码 **0**（检测不到漂移） |
| `deps:manifest:check` 在 LF 检出上必然失败 | **成立**：旧生成器在 `core.autocrlf=false` 检出上 `--check` 退出码 **1** |
| `lockfileSha256` 哈希的是工作区字节 | **成立**：清单里的 `703557d4…`/`5931d663…` 是 CRLF 渲染值，git blob 实为 `d0e018ff…`/`c48439f6…` |
| 本地门禁与 workflow 不对应 | **成立**：本地缺 `--check-node` 与 `node --check server/index.mjs` 两步 |
| 含空格/非 ASCII 路径下门禁失败 | **成立**：`Cannot find module '...\sp'`；`tree_digest` 找 `...\sp%20ace\...` |

## 关键证据

### 1. 六条必须修改项的落地与实测

**① 依赖清单漂移门禁改为真比对。** `.github/workflows/ats-102-build.yml` 的 `dependency-manifest` job 不再先重生成再比对，改为**直接 `--check`**；同时删掉对生成器无效的两次 `npm ci`（生成器不读 `node_modules`）与不符事实的注释。

回归证据（`docs/evidence/ATS-102/11-manifest-tamper-regression.log`）：篡改清单一条 `integrity` 后——

| 序列 | 退出码 |
|---|---|
| 直接 `--check`（现行 CI 序列） | **1**（报 `MISMATCH`） |
| 先重生成再 `--check`（旧序列） | 0（漂移不可见） |

**② `lockfileSha256` 改用 git blob 口径。** `tools/gen_dep_manifest.mjs` 的 `lockDigest()` 改为哈希**规范化为 LF 后**的内容（＝ git blob 字节），清单中的值可用 `git cat-file blob HEAD:<path> | sha256sum` 重算。

- `package-lock.json` → `d0e018ffd53f971f6874bf79264aab1efd019f928cff09c2c0e426e485e01f17`
- `apps/studio/package-lock.json` → `c48439f68c3fabef8f3ae11fa17a4a5b0461fe3261494459b2ce753621724306`

两种检出下 `--check` **均退出码 0**（`09-manifest-check-autocrlf-true-false.log`）：`core.autocrlf=true` 工作区为 CRLF、`false` 为 LF，两次都 `RESULT: OK`。同一日志附了旧生成器在 LF 检出上退出码 1 的对照。

**③ 本地门禁与 workflow 逐条对应。** `tools/ci_build_gate.mjs` 补上 `checknode`（`--check-node`）与 `syntax`（`node --check server/index.mjs`）两步，step 数 6 → 8。`docs/17-BUILD-CI.md` §3.1 给出**逐步对应表**（workflow 步骤 ↔ 本地 step），并列出两处 workflow 独有的步骤（构建副作用 diff 报告、artifact 上传）。「EXACTLY / 1:1」的笼统表述已删除，改为可逐条核对的表。

**④ `npm test` 在 Node 22 上通过。** 根因是 `server/agent.mjs` 的截止时间计时器调用 `timer.unref()`：进程内无其它活动句柄、provider 又是纯 Promise 时，Node 会在截止时间到达前直接退出，`execute()` 永不 settle（进程以 exit 13「unsettled top-level await」结束），测试被取消 27 项。**该修复归属 ATS-401**（Agent 契约层），已随 ATS-401 合入 `dev`；本任务的 `.nvmrc` 固定 Node 22.23.4，因此在本门禁固定的 Node 版本上验证。

Node 22.23.4 下实测：`# tests 165 / # pass 158 / # fail 0 / # cancelled 0 / # skipped 7`，**退出码 0**。

**⑤ 路径问题修复。** `tools/tree_digest.mjs` 改用 `fileURLToPath(import.meta.url)`（`new URL(...).pathname` 是百分号编码的）；`tools/ci_build_gate.mjs` 只对 `npm` 设 `shell: true`（`node`/`git` 不设——Windows 的 shell 会把参数串按空白重新切分），脚本路径改用相对仓库根的路径。

实测（`10-path-with-space-and-cjk.log`）：

| 检出路径 | 修复前 | 修复后 |
|---|---|---|
| `.../sp ace` | `Cannot find module '...\sp'`，退出码 1 | 8 步门禁全绿，退出码 **0** |
| `.../中文目录` | `recorded digests file not found: ...\%E4%B8%AD%E6%96%87...`，退出码 1 | `digest ok: all-files win32-x64 = 4542171b...`，退出码 **0** |

**⑥ 文档按最终状态重写。** `docs/17-BUILD-CI.md` 删除更正记录、复核轮次补充与合并过程叙述（文档只陈述最终状态）；修正计数——optional 包 **40 个**、其中带 `os`/`cpu`/`libc` 平台约束的 **33 个**、Windows x64 实装 9 个、其中平台相关的 **2 个**（`@img/sharp-win32-x64`、`@next/swc-win32-x64-msvc`）；`lockfile` 与 `tsconfig.json`/`next-env.d.ts` 的 sha256 全部改为**可从 git 重算**的 git blob 值；workflow 头注释不再写死测试数量；`CHECKSUMS.sha256` 按最终提交的树重新生成（158 条，`tools/verify_checksums.py` 独立校验：`digest mismatches: 0 / tracked-not-listed: 0 / listed-not-tracked: 0 / RESULT: OK`）；WBS「开发WBS」第 7 行 = **待审核 / 完成率 1 / 剩余人日 0**（`tools/update_wbs_ats102.py` 重跑后 `git diff` 为空，即幂等）。

### 2. 最终验收（全新克隆，8 步门禁，退出码 0）

在 `git clone --no-local` 出的全新克隆（无 `node_modules`、无 `.next`、无 `out/`）上：

```
node   : v22.23.4
npm    : 10.9.9

--- [checknode] PASSED (75 ms)
--- [install] PASSED (40116 ms)
--- [lockcheck] PASSED (90 ms)
--- [installdigest] PASSED (4921 ms)   # digest ok: all-files win32-x64 = 4542171b...
--- [test] PASSED (4312 ms)            # tests 165 / pass 158 / fail 0 / cancelled 0 / skipped 7
--- [syntax] PASSED (104 ms)
--- [build] PASSED (17578 ms)          # artefact ok: apps/studio/out/index.html (12927 bytes)
--- [manifest] PASSED (255 ms)         # packages=88 licenceKnown=88 reviewRequired=16

RESULT: OK -- every build-gate step passed.
GATE_EXIT_CODE=0
```

门禁跑完后 `git status --short` 为空、两个 lockfile 的 `git diff` 为空。日志：`docs/evidence/ATS-102/08-node22-gate-8-steps.log`。

**依赖清单**：`docs/dependencies/dependency-manifest.{json,md}`，88 个依赖许可全部已知（UNKNOWN 0）、强 copyleft 0、需复核 16（弱 copyleft 15 + 署名 1）。

### 3. 额外收敛：依赖清单校验改为完全离线

复核的非阻断风险项之一是「`--check` 会复用被检文件自身的许可数据」。本轮把许可数据源改为 **lockfile 自身的 `license` 字段**（lockfileVersion 3 为全部 88 个条目都带该字段，已逐条核对与清单现值一致，0 处不符），`--check` 因此**不需要任何网络访问**，也不再依赖 registry 可用性。SPDX 标识（`sbomId`）仍取自 registry——lockfile 不带该字段，故该列仍全为「—」，如实记录该缺失。

### 4. 交付物（均在 `dev`，`d9cffc8`）

| 文件 | 内容 |
|---|---|
| `package-lock.json` / `apps/studio/package-lock.json` | lockfileVersion 3，`resolved` 全部指向 `registry.npmjs.org` |
| `.nvmrc` | `22.23.4`（`engines.node` 仍为 `>=22`） |
| `.github/workflows/ats-102-build.yml` | 3 个 job；依赖清单 job 直接 `--check`，不需 `npm ci` |
| `tools/ci_build_gate.mjs` | 本地 8 步门禁，与 workflow 逐步对应 |
| `tools/gen_dep_manifest.mjs` | 依赖清单生成器；许可取自 lockfile，校验完全离线 |
| `tools/tree_digest.mjs` + `tools/installed-tree-digests.txt` | 安装树摘要与按平台记录的期望值 |
| `docs/dependencies/dependency-manifest.{json,md}` | 88 个依赖的许可/SPDX/integrity 清单 |
| `docs/17-BUILD-CI.md` | ATS-BL-002 交付文档（按最终状态） |
| `docs/evidence/ATS-102/` | 11 份证据日志（新增 08~11） |
| `docs/WBS.xlsx` | ATS-102 行 = 待审核 / 1 / 0 |

## 已验证

- **8 步门禁在全新克隆上退出码 0**，门禁后工作区与两个 lockfile 均无差异。
- **`npm test` 在 Node 22.23.4 上 165 项 / 158 通过 / 0 取消 / 退出码 0**（含 `unref()` 修复前后的对照）。
- **依赖清单漂移检测有效**：篡改一条 `integrity` → 现行 CI 序列退出码 1；旧序列退出码 0（对照）。
- **`--check` 在 `core.autocrlf=true` 与 `false` 两种检出下均退出码 0**；清单中的 lockfile sha256 与 `git cat-file blob` 的 sha256 逐条相同。
- **门禁在含空格与含中日文的检出路径下均通过**（8 步全绿 / 摘要校验通过），并附修复前的失败对照。
- **安装树摘要在多个独立克隆上一致**：`all-files win32-x64 = 4542171b605773bea02a2f4058a0bd7f8d057e40013e9ad4c4b72eed8afcdee3`（17191 个文件）、`package-json win32-x64 = 4672eb24…`（317 个文件）。
- **`CHECKSUMS.sha256` 与最终树逐条一致**（158 条，独立脚本校验 0 处不符、0 处漏列、0 处多列）。
- **WBS 更新幂等**：`tools/update_wbs_ats102.py` 重跑后 `git diff -- docs/WBS.xlsx` 为空。

## 未验证 / 受限（PENDING ≠ PASS）

1. **GitHub Actions 未在真实 runner 上跑过。** 远端 `main` 仅有 LICENSE、本分支从未推送，无法触发真实 CI。workflow 的**命令序列**已由本地门禁逐步复现并全绿，但**runner 环境的实际行为**（`actions/setup-node` 缓存、artifact 上传、`windows-2022` 镜像内容）未验证。
2. **Rust/Tauri 侧构建未验证**（B-02），属 ATS-104 验收范围。
3. **NFR-012 的分发审计结论未出**——本次只提供 SPDX 依赖清单的数据基础；16 个需复核依赖的最终法律结论未出。
4. **完整 SPDX SBOM 未生成**（所涉包自身均未声明 `sbomId`，清单如实记录该缺失，未以推测值填充）。
5. **macOS / Linux 上未实测。** 全部实测在 Windows 11 上完成。安装树摘要按平台变化，`tools/installed-tree-digests.txt` 目前只有 `win32-x64` 一组期望值，Linux runner 上该检查会**跳过**（不是失败）。依赖清单的 `--check` 本身不依赖平台（数据源是 lockfile）。
6. **构建步骤的稳定性未量化。** 复核期间有一个全新克隆的 `next build` 在 "Generating static pages" 阶段崩溃（`0xC0000409`，原生栈缓冲区溢出），单独重跑即退出码 0。本机磁盘 C: 94% / D: 88%、内存紧张，判为资源压力下的偶发原生崩溃而非代码缺陷，但**该判定的依据是重跑成功，不是根因定位**。
7. **CI 的并发取消与 artifact 保留行为未实测。**
8. **Actions 按 tag 而非 commit SHA 固定**（主责 SecOps），未改。
9. **`docs/17-AGENT-CONTRACT.md` 与 `docs/17-BUILD-CI.md` 编号冲突**未改——重命名会牵动 ATS-401 的交付物与其在 8 处文档中的引用，超出本任务范围。
10. **产品的 `spawn('taskkill')` 无兜底缺陷未修**（属 ATS-108），本任务只记录与定位。

## 说明

- 本轮**先复现再修**：6 条反例全部独立复现确认成立后，才逐条整改并重测。
- 本任务期间有一个并发分支（`agent/m3/seikoist-147-fix`）独立修了同一批问题并先合入 `dev`；本轮以 `--no-ff` 合并并**保留双方的互补产出**（对方的 `08-manifest-drift-and-line-endings.log` 与 `tools/ats102-probes/collect-evidence.sh` 一并留在仓内），未丢弃任何已验证证据。合并后 `dev` = `d9cffc8`。
- WBS「开发WBS」ATS-102 行维持 **待审核 / 完成率 1 / 剩余人日 0**——等待复核，不计入总览的「已完成项」。

Original executor: M3
