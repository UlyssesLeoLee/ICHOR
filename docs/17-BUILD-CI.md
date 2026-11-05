# ATS-BL-002 锁文件、依赖与 Windows CI 构建脚本（ATS-102 交付）

- 交付物：WBS ATS-102（S1 / v0.1.1，工作流「构建」，主责 SecOps），对应需求 NFR-007、NFR-012
- 基线起点：commit `ce68ccc`（`agent/m3/seikoist-147` 分支起点）；上游依据 `docs/16-BASELINE-ADR.md` §5.1/§5.2
- 状态标记沿用仓库约定：`IMPLEMENTED` ＝ 代码能力存在；`DESIGNED` ＝ 仅设计。**本文件不得把设计中的能力称为已实现。**

## 1. 结论摘要

ATS-102 的验收标准是「**Node22 clean install + npm test 成功；锁文件可重现；生成依赖清单**」。三项**均已在 Node 22.23.4 / npm 10.9.9 上实测通过**，证据见 `docs/evidence/ATS-102/`：

| 验收项 | 结论 | 证据 |
|---|---|---|
| Node 22 clean install | **PASS** | 干净克隆内 `npm ci` 根包 0 依赖 / `apps/studio` 57 包；`npm ci` 不改写 lockfile |
| `npm test` | **PASS** | Node 22.23.4 下 `# tests 165 / # pass 158 / # fail 0 / # cancelled 0 / # skipped 7`，退出码 **0**（`15-node22-gate-8-steps-final.log`） |
| 锁文件可重现 | **PASS** | 安装树摘要逐字节一致（口径见 §2.2）；`npm ci` 不改写 lockfile；`autocrlf=true` 与 `false` 两种检出下依赖清单 `--check` 均退出码 0 |
| 生成依赖清单 | **PASS** | `docs/dependencies/dependency-manifest.{json,md}`，88 个依赖许可全部已知，校验**完全离线** |
| Windows CI 构建脚本 | **PASS** | `.github/workflows/ats-102-build.yml`，3 个 job；本地门禁 `tools/ci_build_gate.mjs` 与 workflow 逐步对应 |

**最终验收运行**（全新克隆，门禁 8 步退出码 **0**）：`docs/evidence/ATS-102/15-node22-gate-8-steps-final.log`。

**本次交付关闭了 ATS-101 §5.1 指出的两处「ATS-102 待办」**：仓库此前既无 lockfile 也无 CI 配置。

**未随本次交付完成的事项**（不得计入通过）：

1. **GitHub Actions 未在真实 runner 上跑过**。本仓库的 `origin` 是 `github.com/UlyssesLeoLee/ICHOR.git`，但远端 `main` 只有一个 LICENSE 文件、且本分支从未推送，因此**无法在本机触发一次真实的 CI 运行**。workflow 的正确性由「本地以同一组命令逐步复现并全绿」证明（见 §4），**不是**由 CI 运行结果证明。
2. **Rust/Tauri 侧构建未验证**。见 §6 的镜像前置条件说明。
3. **NFR-012 的「分发审计」结论未出**。本次只提供了 SPDX 依赖清单所需的**数据基础**，审计结论本身仍属未完成项（`docs/16-BASELINE-ADR.md` §7 第 6 条）。
4. **macOS / Linux 上未实测**。全部实测在 Windows 11 上完成；安装树摘要按平台变化（§2.2），`tools/installed-tree-digests.txt` 目前只有 `win32-x64` 一组期望值。
## 2. 锁文件（可重现性）

### 2.1 提交内容

| 文件 | 行数 | 内容 |
|---|---|---|
| `package-lock.json` | 16 | 根包**无第三方依赖**（Node Bridge 只用 Node 内置模块，测试用内置 `node:test`），仅锁定自身元数据 |
| `apps/studio/package-lock.json` | 1338 | 88 个包（直接 10、dev 3、可选 40） |

两个 lockfile 均为 `lockfileVersion 3`，**`resolved` 全部指向 `https://registry.npmjs.org/`**（规范 registry，非本机镜像 `registry.npmmirror.com`），因此换机器、换网络、换 CI runner 都解析到同一份 tarball。

### 2.2 可重现性的实测口径

「锁文件可重现」不是一句断言，而是三条可复跑的检查：

1. **`npm ci` 不得改写 lockfile**——CI 的 `lockcheck` 步骤与门禁脚本的同名步骤都断言 `git diff --exit-code -- package-lock.json apps/studio/package-lock.json` 为空。实测为空。

2. **两个独立克隆各装一次，安装树必须逐字节一致**。安装树摘要的**计算口径写在 `tools/tree_digest.mjs` 的文件头**：

   - 对树根下的每个普通文件，算其**原始字节**的 sha256（十六进制）；
   - 拼成一行 `<相对 posix 路径> NUL <sha256>`；
   - 按相对路径排序（字节序，即 ASCII 序），用 LF 连接，末尾补一个 LF；
   - 对结果取 sha256，即为安装树摘要。

   第三方可用同一条命令重算：

   ```
   node tools/tree_digest.mjs <克隆>/apps/studio/node_modules
   node tools/tree_digest.mjs <克隆>/apps/studio/node_modules --package-json-only
   ```

   口径只用**相对路径**，所以摘要与克隆到哪个目录无关——这是该测量有意义的前提。

   实测值（Windows x64，**npm 10.9.9**）：

   | 口径 | 文件数 | sha256 |
   |---|---|---|
   | `all-files` | 17191 | `4542171b605773bea02a2f4058a0bd7f8d057e40013e9ad4c4b72eed8afcdee3` |
   | `package-json` | 317 | `4672eb248660994f9d0ff2b8fb7d496b72c84334a0c63c18e501aa2be3c2f304` |

   **该摘要是随平台变化的**，这是 lockfile 的性质而非口径的缺陷：`apps/studio/package-lock.json` 声明了 **40 个 optional 包**，其中 **33 个带 `os`/`cpu`/`libc` 平台约束**（`@next/swc-<platform>`、`@img/sharp-<platform>`、`@img/sharp-libvips-*`），其余 **7 个不带平台约束**（`@emnapi/runtime`、`@img/colour`、`@img/sharp-wasm32`、`@types/trusted-types`、`detect-libc`、`semver`、`sharp`）。npm 只安装与本机匹配的那一份：Windows x64 实际安装 **9 个** optional 包，其中**只有 2 个是平台相关的**（`@img/sharp-win32-x64`、`@next/swc-win32-x64-msvc`）。因此 Windows 与 Linux 的安装树天然不同，**期望值必须按平台记录**——`tools/installed-tree-digests.txt` 即按 `<口径> <平台> <npm 版本> <sha256>` 逐行记录；某平台尚无记录时该检查**跳过而非失败**（没有可比对的基准，凭空造一个是错的）。这一点也是它**不能**作为跨平台一致性证据的原因，见 §7 第 6 条。

   **该摘要也是随 npm 版本变化的**，因为不同 npm 对同一份 lockfile 装出的 optional 包集合不同。实测（同一份已提交的 `apps/studio/package-lock.json`，见 `14-npm-version-and-install-digest.log`）：

   | npm | 安装的文件数 | `package.json` 数 | `all-files` sha256 |
   |---|---|---|---|
   | **10.9.9**（Node 22.23.4 自带，`packageManager` 指定） | 17191 | 317 | `4542171b605773bea02a2f4058a0bd7f8d057e40013e9ad4c4b72eed8afcdee3` |
   | 12.2.0（Node 24.19.0 自带） | 17167 | 315 | `5e5a977f96aeb873f414967d1bb7ea7068df251ed47e2a68c21764f2c9e4a18f` |

   差异的**全部**来源是 npm 12 不再安装 `@emnapi/runtime` 与 `@img/sharp-wasm32` 两个包（24 个文件），外加 `.bin/` 下 8 个 shim 与 `.package-lock.json` 的内容随 npm 版本变化（15 个文件）。逐文件的比对可用 `python tools/ats102-probes/diff-install-trees.py <树A> <树B>` 复现。

   因此**每一行期望值只对它记录的那一 npm 版本成立**——记录里已经写明了这一点。门禁支持的配置是 `packageManager` 指定的 npm 10.9.9；npm 12.2.0 的摘要也已测量并记录（用于诊断与对照），但 npm 12.2.0 **不是**门禁支持的配置。这一依赖被做成了可诊断的，而不是靠读者自己猜：

   - `tools/ci_build_gate.mjs --check-node` 在断言 Node major 的**同时**断言 npm 版本与根 `package.json` 的 `packageManager` 一致，不一致即退出码 1 并直接报出实际版本与期望版本；
   - `tools/installed-tree-digests.txt` 的每行记录了产出该值的 npm 版本；
   - `tools/tree_digest.mjs --check` 按 `(口径, 平台, npm 版本)` 查期望值，失配时输出**当前 PATH 上的 npm** 与**期望值对应的 npm**，并说明两者装出的 optional 包集合不同。

   于是「摘要失配」不再可能被误读成 lockfile 坏了：先看 `checknode` 步是否通过——通过了就说明 npm 版本是对的，再去查 lockfile。

   **全树口径（`all-files`）不只锁版本，还抓到了 npm 自己没抓到的安装损坏。**
   复核期间有一个全新克隆的 `npm ci` 装出了**被截断且补零**的
   `next/dist/server/image-optimizer.js.map`（25088 字节：前 8704 字节正常，
   其后 16384 字节全为 0），而 **npm ci 退出码为 0**、tarball 的 integrity
   校验也通过——npm 的完整性校验覆盖 tarball，不覆盖解压后的文件是否被完整写出。
   是本门禁把它拦下的（`installdigest` 步 FAILED、退出码 1），而同一轮里
   npm ci / npm test / next build 全部 PASS。
   注意**只算 `package.json` 的窄口径看不出这个问题**（被截断的不是
   `package.json`），这也是全树口径值得保留的理由。

3. **lockfile 自身的 sha256 在安装前后不变**。清单与文档中记录的是**规范化为 LF 后的内容**的 sha256，即 git blob 的字节：

   | lockfile | sha256（LF 规范化 ＝ git blob） |
   |---|---|
   | `package-lock.json` | `d0e018ffd53f971f6874bf79264aab1efd019f928cff09c2c0e426e485e01f17` |
   | `apps/studio/package-lock.json` | `c48439f68c3fabef8f3ae11fa17a4a5b0461fe3261494459b2ce753621724306` |

   **口径**：把文件内容的 CRLF 换成 LF 后取 sha256。第三方用下面这条命令即可从 git 重算出同一个值：

   ```
   git cat-file blob HEAD:package-lock.json | sha256sum
   git cat-file blob HEAD:apps/studio/package-lock.json | sha256sum
   ```

   用 **git blob** 而不是工作区原始字节，是因为 `core.autocrlf=true`（Windows 默认）下工作区是 CRLF、blob 是 LF，两者的 sha256 不同；记工作区字节会让同一个锁文件在 Windows 与 Linux 上得到两个不同的值，依赖清单的 `--check` 门禁在 LF 检出（ubuntu/macOS runner、`core.autocrlf=false` 的克隆）上必然失败。实测两种检出下 `--check` 均退出码 0（`09-manifest-check-autocrlf-true-false.log`）。

   这与仓库既有约定一致：`tools/update_checksums.py` 的文件头规定哈希 git blob，正是为了规避 autocrlf。
### 2.3 Node 版本固定

- `.nvmrc` → `22.23.4`（Node 22 LTS「Jod」的末版），CI 用 `actions/setup-node` 的 `node-version-file` 读取。
- 根 `package.json` 的 `engines.node` 仍是 `">=22"`（运行时的下限约束，不改），另加 `packageManager: "npm@10.9.9"` 记录产出 lockfile 的 npm 版本。
- `tools/ci_build_gate.mjs --check-node` 断言 **Node major 必须为 22**（lockfile 由 Node 22 自带的 npm 产出，换 major 可能解析不同），**并断言 npm 版本与 `packageManager` 一致**（安装树摘要依赖 npm 版本，见 §2.2）。两者任一不符即退出码 1，并报出实际版本与期望版本。

## 3. CI workflow

文件：`.github/workflows/ats-102-build.yml`。触发条件为 `push` / `pull_request`（分支 `main`、`dev`）与 `workflow_dispatch`；同一分支的旧运行会被 `concurrency` 取消；`permissions: contents: read`。

| job | runner | 门禁内容 |
|---|---|---|
| `node-tests` | `windows-2022` | Node 22 + npm 10.9.9 版本断言 → 根 `npm ci` → lockfile 未被改写 → `npm test` → `node --check server/index.mjs` |
| `web-build` | `windows-2022` | `apps/studio` 的 `npm ci` → lockfile 未被改写 → **安装树摘要校验** → `next build` → 产物 `out/index.html` 存在且非空 |
| `dependency-manifest` | `ubuntu-latest` | **直接 `--check`** 断言提交的依赖清单与 lockfile 一致 |

三个 job 各自把产物上传为 artifact（测试输出、静态导出目录、依赖清单），保留 7 天。

**安装树摘要校验**（`node tools/tree_digest.mjs --check apps/studio/node_modules`）：
把已安装的 `apps/studio/node_modules` 钉在 lockfile 上——换 tarball、被篡改的
依赖都会让它失配。该检查的期望值按**平台**记录，原因见 §2.2。

**依赖清单 job 的比对语义**：该 job **直接跑 `--check`**，不先重新生成清单。

三种序列在**已提交的**清单被篡改后的实测结果（`13-manifest-drift-committed-tamper.log`）：

| 序列 | 退出码 | 是否检出漂移 |
|---|---|---|
| 直接 `--check`（现行 CI 序列） | **1** | **检出** |
| 先重生成再 `--check` | 0 | 检测不到 |
| 先重生成再 `git diff --exit-code` | **1** | **检出** |

**为什么选 `--check`**：三种序列里只有它**不写自己正在检查的文件**。

- 「先重生成再 `--check`」把刚写出的文件与它自己比较，任何漂移都被悄悄覆盖，因此检测不到。
- 「先重生成再 `git diff --exit-code`」能检出——重生成改写了已提交的清单，工作区因此与提交不一致。但它**要求工作区是 git 检出**（需要 `.git`、需要 HEAD 中的清单、且 `git diff` 只能看见工作区与索引/HEAD 的差异），在只拿到一份源码归档的场景下不成立。
- 「直接 `--check`」不写文件、不依赖 git、可离线运行，报错信息直接指向「哪一份文件与 lockfile 不一致」。

该 job **不需要 `npm ci`**：生成器从**已提交的 lockfile** 取依赖与许可数据，不读 `node_modules`，因此这个 job 不装任何依赖。

### 3.1 与本地门禁脚本的一致性

workflow 的每一条命令都对应 `tools/ci_build_gate.mjs` 里的一个 step，**逐步一一对应**：

| # | 本地门禁 step | 对应的 workflow 步骤 |
|---|---|---|
| 1 | `checknode` | `node-tests` → "Verify Node and npm versions match the pinned toolchain"（`--check-node`） |
| 2 | `install` | `node-tests` → "Clean install from lockfile (root)"；`web-build` → "Clean install from lockfile (apps/studio)" |
| 3 | `lockcheck` | 两个 job 的 "Verify lockfile is not mutated by npm ci" |
| 4 | `installdigest` | `web-build` → "Verify the installed tree matches the recorded digest" |
| 5 | `test` | `node-tests` → "Run unit / integration tests" |
| 6 | `syntax` | `node-tests` → "Syntax check the bridge entrypoint" |
| 7 | `build` | `web-build` → "Build static export" + "Verify the export artefact exists" |
| 8 | `manifest` | `dependency-manifest` → "Verify the committed manifest matches the lockfiles" |

该脚本可在任意有 Node 22 的机器上以一条命令复现整个门禁：

```bash
node tools/ci_build_gate.mjs            # 全部步骤
node tools/ci_build_gate.mjs --list     # 列出步骤
node tools/ci_build_gate.mjs --step test
```

这使「CI 会不会绿」在推送之前就能本地验证，而不必等 runner。

**两处 workflow 独有的步骤**（本地门禁不重复执行，因为它们在本地不成立）：

- `web-build` 的 "Report build side effects on tracked files"（`git diff --stat`，`continue-on-error: true`）——只报告 `next build` 对受版本控制文件的改写，不阻断；
- 三个 job 的 artifact 上传。
## 4. 本地实测（IT）

运行环境：Windows 11；Node **v22.23.4**（官方 zip，SHA-256 已对 `SHASUMS256.txt` 校验：`cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20`）；npm **10.9.9**；registry `https://registry.npmjs.org/`。

方法：`git clone --no-local` 出**全新克隆**（无 `node_modules`、无 `.next`、无 `out/`），在其中跑门禁脚本。

**最终验收运行**（门禁 8 步，退出码 **0**）：

```
=== ATS-102 build gate ===
node   : v22.23.4
npm    : 10.9.9

--- [checknode] PASSED (390 ms)
--- [install] PASSED (41372 ms)
--- [lockcheck] PASSED (50 ms)
--- [installdigest] PASSED (2803 ms)   # digest ok: all-files win32-x64 = 4542171b...
--- [test] PASSED (1831 ms)            # tests 165 / pass 158 / fail 0 / cancelled 0 / skipped 7
--- [syntax] PASSED (73 ms)
--- [build] PASSED (5940 ms)           # artefact ok: apps/studio/out/index.html (12927 bytes)
--- [manifest] PASSED (104 ms)         # packages=88 licenceKnown=88 reviewRequired=16

RESULT: OK -- every build-gate step passed.
GATE_EXIT_CODE=0
```

完整日志：`docs/evidence/ATS-102/15-node22-gate-8-steps-final.log`。

**门禁退出码 0**；门禁跑完后 `git status --short` 为**空**、`git diff`（两个 lockfile）为空（工作区干净），即构建不留下脏文件。

### 4.1 证据日志清单

| 文件 | 内容 |
|---|---|
| `15-node22-gate-8-steps-final.log` | **最终验收运行**：全新克隆上 8 步门禁全绿、退出码 0；`npm test` 165 项 / 158 通过 / 0 取消 / 7 跳过 |
| `13-manifest-drift-committed-tamper.log` | 清单漂移门禁的**已提交篡改**对照：三种序列的检出能力（`--check` 检出 / 先重生成再 `--check` 不检出 / 先重生成再 `git diff` 检出） |
| `14-npm-version-and-install-digest.log` | 同一份 lockfile 在 npm 10.9.9 与 npm 12.2.0 下装出的两棵树：文件数、摘要、optional 包差异，以及两个 npm 下门禁各自的诊断输出 |
| `08-node22-gate-8-steps.log` | 上一轮的门禁运行（采集于 `ca2216f`），保留作为历史对照 |
| `09-manifest-check-autocrlf-true-false.log` | 依赖清单 `--check` 在 `core.autocrlf=true` 与 `false` 两种检出下均退出码 0；并附修复前生成器在同一 LF 检出上退出码 1 的对照 |
| `10-path-with-space-and-cjk.log` | 检出目录含空格（`sp ace`）与含中日文（`中文目录`）时的门禁：修复前报错、修复后摘要校验通过 |
| `11-manifest-tamper-regression.log` | **门禁有效性回归**：篡改清单一条 `integrity` 后，现行 CI 序列退出码 1、旧序列退出码 0 |
| `08-manifest-drift-and-line-endings.log` | 清单漂移门禁的「先校验后重生成」对照、lockfile 哈希的 git 重算、以及含空格/非 ASCII 检出路径下的门禁运行（`tools/ats102-probes/collect-evidence.sh` 采集） |
| `05-windows-shell-path-pitfall.log` | Windows/Git-Bash 下的 PATH 形态坑（`spawn taskkill ENOENT` 导致 Bridge 崩溃）与修正 |
| `03-lockfile-reproducibility.log` | 两个独立克隆各装一次，安装树 sha256 一致；两个 lockfile 安装前后哈希不变 |

### 4.2 `npm test` 在 Node 22 上的结果



**Node 22.23.4 下 `# tests 165 / # pass 158 / # fail 0 / # cancelled 0 / # skipped 7`，退出码 0**（`15-node22-gate-8-steps-final.log`）。

被跳过的 7 项是 ATS-301 的引擎 IT（`IT-ADP-005` ～ `IT-ADP-011`），原因是 `examples/sample-playwright` 与 `examples/sample-wdio` 两个夹具**没有 `node_modules`**——夹具的依赖不在本仓库的 lockfile 里，装它们需要各自单独安装。这 7 项在 CI 的干净克隆上同样会跳过，因此**不是**本机环境的产物。

该结果依赖于 `server/agent.mjs` 的截止时间计时器**不调用 `timer.unref()`**。若该计时器被 `unref()`，当进程内没有其它活动句柄、provider 又是一个纯 Promise（不持有 socket 之类的句柄）时，Node 会在截止时间到达之前直接退出，`execute()` 永不 settle，调用方拿不到 `AGENT_BUDGET_EXCEEDED`（进程以 exit 13「unsettled top-level await」结束）。实测对照：

| Node 版本 | 计时器被 `unref()` | 结果 |
|---|---|---|
| 22.23.4 | 是 | `# tests 160 / # pass 126 / # cancelled 27`，退出码 **1** |
| 22.23.4 | 否 | `# tests 160 / # pass 153 / # cancelled 0`，退出码 **0** |
| 24.19.0 | 是 | `# tests 160 / # pass 153 / # cancelled 0`，退出码 **0** |

被取消的是 `UT-AGT-042` ～ `UT-AGT-068`。**该修复归属 ATS-401**（`server/agent.mjs` 的 Agent 契约层），已随 ATS-401 合入 `dev`。ATS-102 的 `.nvmrc` 固定 Node 22.23.4，因此本门禁在 Node 22 上验证。

### 4.3 在 Windows/Git-Bash 上准备环境

门禁会启动原生 Windows 子进程（`npm.cmd` → `cmd.exe`），而产品代码在 Windows 上用 `spawn('taskkill', ...)` 强杀子进程树。因此 PATH 必须是 **MSYS 形式**（`/c/Windows/system32`），写成 Windows 形式（`C:/Windows/system32`）会被 MSYS 改写成 `C:\Program Files\Git\Windows\system32`，导致 `taskkill.exe` 找不到、`spawn taskkill ENOENT` 变成未监听的 'error' 事件、**整个 Bridge 崩溃**，表现为 `IT-RUN-MOCK-002` 失败。

```bash
source tools/ats102-env.sh
node tools/ci_build_gate.mjs
```

该坑的完整定位过程见 `docs/evidence/ATS-102/05-windows-shell-path-pitfall.log`。**该失败不是本次交付引入的回归**——在 `dev` 单独克隆上、在 ATS-101 基线 commit `c68bc0c` 上同样复现。

### 4.4 检出路径含空格或非 ASCII 字符

Windows 上用户目录含空格或中日文名很常见，因此门禁在这样的检出路径下必须能跑通。

**`tools/tree_digest.mjs`** 用 `new URL(import.meta.url).pathname` 取自身目录时，得到的是**百分号编码**的路径，在含空格的检出目录下会去找 `...\sp%20ace\tools\installed-tree-digests.txt`；非 ASCII 目录同理（`...\%E4%B8%AD%E6%96%87...`）。现改用 `fileURLToPath(import.meta.url)`。

**`tools/ci_build_gate.mjs`** 只对 `npm`（Windows 上是 `.cmd` 垫片，只有经 cmd.exe 才能启动）设 `shell: true`；`node` 与 `git` 不设 shell——Windows 的 shell 会按空白重新切分参数串，含空格的脚本路径会被切成两段。脚本路径用**相对于仓库根**的路径，并以其为 `cwd`。

实测对照（检出目录 `sp ace` 与 `中文目录`）：

| 检出路径 | 修复前 | 修复后 |
|---|---|---|
| `.../sp ace` | `Cannot find module '...\sp'`，退出码 1 | 8 步门禁全绿，退出码 **0** |
| `.../中文目录` | `recorded digests file not found: ...\%E4%B8%AD%E6%96%87...`，退出码 1 | 摘要校验通过（`digest ok: all-files win32-x64 = 4542171b...`） |

完整日志：`docs/evidence/ATS-102/10-path-with-space-and-cjk.log`。
## 5. 依赖清单（NFR-012 的数据基础）

生成器：`tools/gen_dep_manifest.mjs`。输出：`docs/dependencies/dependency-manifest.json`（机读）与 `docs/dependencies/dependency-manifest.md`（人读）。

- **数据源是已提交的 lockfile**，不是本机的 `node_modules`。因此在没装过依赖的机器上也能生成，且结果一致。
- **许可取自 lockfile 自身的 `license` 字段**（lockfileVersion 3 为全部 88 个条目都带该字段），不是已安装的 `package.json`，也不是 registry。已安装树只含当前 OS 的平台原生二进制（40 个 optional 包），若从安装树取许可，同一 lockfile 在 Windows 与 Linux 上会生成**不同**的清单，`--check` 门禁将失去意义。取自 lockfile 则使 `--check` **完全离线**，不依赖 registry 可用性。
- **SPDX 标识（`sbomId`）取自 npm registry 元数据**，因为 lockfile 不带该字段。
- 每个依赖记录：版本、许可、SPDX（若发布）、`resolved` URL、**`integrity` 哈希**（npm 安装时实际校验的那个值）、是否直接依赖、是否 dev/optional、复核等级。
- 88 个依赖**许可全部已知**（UNKNOWN 0 个），无 unknown 可供猜测。
- 清单记录每个 lockfile 的 **sha256（LF 规范化 ＝ git blob 字节）**，口径与重算命令见 §2.2 第 3 条。

### 5.1 许可分布

| 许可 | 依赖数 |
|---|---|
| MIT | 41 |
| Apache-2.0 | 17 |
| ISC | 11 |
| LGPL-3.0-or-later | 10 |
| Apache-2.0 AND LGPL-3.0-or-later | 3 |
| BSD-3-Clause | 2 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| 0BSD | 1 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1 |
| CC-BY-4.0 | 1 |

### 5.2 需复核的依赖（16 个）

生成器按三档标记「须由人确认」——**标记只表示需要人判断，不表示该许可禁止本产品的用法**：

| 等级 | 数量 | 含义 |
|---|---|---|
| `strong` | **0** | AGPL/GPL/SSPL/Elastic/Commons-Clause：强 copyleft 或源码可得，可能要求公开合并作品 |
| `weak` | 15 | LGPL/MPL/EPL/CDDL：弱 copyleft，义务范围通常限于库本身，但具体义务（动态/静态链接、是否需可重链接、通知义务）取决于使用方式，须人工判定 |
| `attribution` | 1 | CC-BY-*：署名与通知义务 |

`strong` 为 0 是有意义的结论：**本仓库自身没有引入会强制公开合并作品的依赖**。15 个 `weak` 全部是 `sharp`/`libvips` 的平台原生二进制（LGPL），随 Next.js 的图片优化依赖引入；`attribution` 的 1 个是 `caniuse-lite`（CC-BY-4.0）。**这不等于审计已通过**——正式闭源商业分发前仍须确认这些库是否真的随产物分发、以及 notice 文件如何随包携带（见 §1「未随本次交付完成的事项」第 3 条）。

### 5.3 SPDX 标识的缺失

清单中 SPDX 列多为「—」。实测确认：这些包在自身 `package.json` 与 registry 元数据中**均未声明 `sbomId`**（抽查 `next`、`react`、`typescript`、`lucide-react`、`dompurify`、`caniuse-lite` 均为 `sbomId= (none)`）。清单**如实记录该缺失，不以推测值填充**。要得到完整 SPDX 标识，须引入 CycloneDX/`@cyclonedx-npm` 之类的 SBOM 生成器，属于 NFR-012 的后续工作。
## 6. 对 ATS-101 结论的影响

### 6.1 关闭了 ATS-101 的两处待办

`docs/16-BASELINE-ADR.md` §5.1 原文：

- 「**无 lockfile**（根与 `apps/studio` 均无 `package-lock.json`）→ 依赖不可重现，属 ATS-102 待办。」→ **本次已补齐**。
- 「**无 CI 配置**（无 `.github/workflows`、无 `.gitlab-ci.yml`）→ 无自动门禁，属 ATS-102 待办。」→ **本次已补齐**（`.github/workflows/ats-102-build.yml`）。

### 6.2 §5.2 的构建副作用：现状已变化

ATS-101 记录的已知副作用是：`next build` 会改写 `apps/studio/next-env.d.ts` 与 `apps/studio/tsconfig.json`，导致「构建后工作区必然 dirty」，并建议「CI 需先校验这两文件是否与基线一致，或将其纳入允许变更清单」。

本任务的处理：**把改写后的内容提交进版本控制**，并实测该副作用是**幂等的**（连续两次 `next build` 后两文件的 sha256 不变）。因此构建后工作区不变脏，CI 无需「允许变更清单」，只保留一步**报告**（`git --no-pager diff --stat`，`continue-on-error: true`，不阻断）以便将来升级 Next 时能看见差异。

实测：连续两次 `next build` 后两文件 sha256 不变，且 `git status --short` 为空。两文件的 sha256（LF 规范化 ＝ git blob 字节，第三方可用 `git cat-file blob HEAD:<path> | sha256sum` 重算）：

- `apps/studio/next-env.d.ts` → `1862ac4bbbc5192d4bf562161df66ea547ed3e67173100656ab606ae9797db2b`
- `apps/studio/tsconfig.json` → `6bf102b8ecab1f3d366d415e0ea89bb95b2f90036570e40703a2175cd62f10b7`

### 6.3 新增第二个 lockfile 引入的告警及其消除

加入 `apps/studio/package-lock.json` 后，Next.js 报 workspace root 推断告警（它在两个 lockfile 中推断错了根目录）。已在 `apps/studio/next.config.mjs` 固定 `turbopack.root: import.meta.dirname` 消除。构建日志中该告警已不再出现。

> 注：`turbopack.root` 必须是 ESM 安全的写法——`__dirname` 在 `.mjs` 中不可用（会抛 `ReferenceError: __dirname is not defined in ES module scope`），此处用 `import.meta.dirname`。

### 6.4 对 ATS-104（Tauri Windows 构建）的镜像前置条件

ATS-101 §8 建议：「ATS-102 的 CI 脚本须固定该镜像」。本次的 workflow 用 `runs-on: windows-2022`（自带 VS 2022 生成工具），为后续 `cargo build` 预留了镜像基线。

**但这不构成 B-02 已关闭**：B-02 的成因清单尚未穷尽（`docs/16-BASELINE-ADR.md` §4 B-02），且仓库仍缺 `src-tauri/icons/icon.ico`。本次 workflow **未加入 Rust/Tauri job**——理由是：仓库现状下该 job 必然失败（B-02），加一个必红的 job 只会让门禁失去意义。**该 job 属于 ATS-104 的交付范围**，届时应连同 `.ico` 资源与 MSVC 链一并加入。

### 6.5 对 ATS-108（取消/超时/子进程树回收）的新增发现

§4.3 的定位过程中发现：`server/index.mjs` 的 `cancelRun()` 在 Windows 上用 `spawn('taskkill', ...)` 强杀子进程树，但**该 spawn 的 'error' 事件无人监听**。当 `taskkill` 不可用时，ENOENT 变成 unhandled 'error' 事件，**整个 Bridge 进程崩溃**——本应只影响一次停止请求的失败，波及整个服务。

这与 B-03（`docs/16-BASELINE-ADR.md` §4 B-03）是**两处不同的缺陷**：B-03 是状态恢复集合遗漏 `cancelling`；本条是子进程 spawn 失败无兜底。归属建议：**ATS-108**。

### 6.6 与 `dev` 的合并

本任务的产出与 `dev` 的合并采用 `--no-ff`。`docs/WBS.xlsx` 是二进制，合并必冲突，处理方式是**以 `dev` 的版本为基础**，再用 `tools/update_wbs_ats102.py` 施加 ATS-102 的行改动；该脚本的总览缓存值**从表格重算**（沿用 `dev` 的 `summarise` 约定），不硬编码，因此对其它行的完成率状态不敏感。


## 7. 未验证项声明（PENDING ≠ PASS）

1. **GitHub Actions 未在真实 runner 上执行**。原因见 §1 第 1 条：远端 `main` 仅有 LICENSE、本分支未推送，无法触发真实 CI。workflow 的**命令序列**已由本地门禁脚本逐步复现并全绿，但**runner 环境的实际行为**（`actions/setup-node` 的缓存、artifact 上传、`windows-2022` 镜像内容）未验证。
2. **Rust/Tauri 构建未验证**（B-02），本次不涉及。
3. **NFR-012 的分发审计结论未出**，本次只提供数据基础（§1 第 3 条）。
4. **完整 SPDX SBOM 未生成**（§5.3）。
5. **16 个需复核依赖的最终法律结论未出**（§5.2）。
6. **macOS / Linux 上未实测**。本次全部实测在 Windows 11 上完成。补充：安装树摘要**按平台变化**（§2.2：40 个 optional 包、其中 33 个带平台约束），所以 Windows 上算出的值**不能**代表 Linux——`tools/installed-tree-digests.txt` 目前只有 `win32-x64` 一组期望值，Linux runner 上该检查会**跳过**（不是失败），直到有人补录该平台的期望值为止。跨平台一致性仍属未验证。依赖清单的 `--check` 本身**不依赖平台**（数据源是 lockfile），已实测在 `core.autocrlf=true` 与 `false` 两种检出下均退出码 0（§2.2 第 3 条）。
7. **CI 的并发取消（`concurrency`）与 artifact 保留行为未实测**。
8. **产品的 `spawn('taskkill')` 无兜底缺陷未修**（§6.5）——本任务只记录与定位，未改产品代码（属 ATS-108）。
9. **门禁在 GitHub runner 上的 PATH/工具链差异未验证**：本地用 `tools/ats102-env.sh` 准备 MSYS 形式的 PATH（§4.3），而 GitHub 的 Windows runner 由 `actions/setup-node` 直接配置 PATH，二者的差异未实测。**特别是 runner 上的 npm 版本**：`actions/setup-node` 装的是 Node 22.23.4 自带的 npm 10.9.9，与 `packageManager` 一致，但这一路径**未在真实 runner 上验证过**——门禁的 `checknode` 步会在版本不符时直接失败，因此即使不符也是「响亮地失败」而不是「静默地失配」。
10. **构建步骤的稳定性未量化**：复核期间有一个全新克隆的 `next build` 在 "Generating static pages" 阶段崩溃（`Next.js build worker exited with code: 3221226505`，即 0xC0000409，原生栈缓冲区溢出），同一克隆上单独重跑即退出码 0、随后整轮门禁全绿。本机磁盘 C: 94% / D: 88%、内存紧张，判为资源压力下的偶发原生崩溃而非代码缺陷，但**该判定的依据是重跑成功，不是根因定位**——真实 GitHub runner 的资源充裕度不同，未实测其发生率。
11. **依赖清单的 registry 依赖仅限 SPDX 列**：许可数据已改为取自 lockfile，`--check` 完全离线；但 SPDX 标识（`sbomId`）仍取自 registry，因此清单中该列全为「—」（§5.3）。
12. **npm 12.2.0 下的门禁未整轮跑通**：npm 12.2.0 只在 `installdigest` 这一步上单独验证过（`14-npm-version-and-install-digest.log`），且该步在补录了 npm 12.2.0 的摘要后**通过**。整轮 8 步门禁在 npm 12.2.0 下**未跑**——`checknode` 会先因 npm 版本与 `packageManager` 不符而失败，所以 npm 12.2.0 本来就**不是**该门禁支持的配置。npm 12.2.0 的摘要是**已记录的值**，不是「门禁在 npm 12 下通过」的证据。

## 8. 冻结声明

- 本文件描述的是 ATS-102 交付后的状态：分支 `agent/m3/seikoist-147`。
- **未验证项一律如实标注**，不得计入通过。
- 本文件所列命令与输出均可在 `docs/evidence/ATS-102/` 中找到对应日志，并可用 `node tools/ci_build_gate.mjs` 重跑。
- 本文件的任何修改必须附新的可执行证据（命令 + 实际输出）。
