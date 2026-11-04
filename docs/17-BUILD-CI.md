# ATS-BL-002 锁文件、依赖与 Windows CI 构建脚本（ATS-102 交付）

- 交付物：WBS ATS-102（S1 / v0.1.1，工作流「构建」，主责 SecOps），对应需求 NFR-007、NFR-012
- 基线起点：commit `ce68ccc`（`agent/m3/seikoist-147` 分支起点）；上游依据 `docs/16-BASELINE-ADR.md` §5.1/§5.2
- 状态标记沿用仓库约定：`IMPLEMENTED` ＝ 代码能力存在；`DESIGNED` ＝ 仅设计。**本文件不得把设计中的能力称为已实现。**

## 1. 结论摘要

ATS-102 的验收标准是「**Node22 clean install + npm test 成功；锁文件可重现；生成依赖清单**」。三项**均已实测通过**，证据见 `docs/evidence/ATS-102/`：

| 验收项 | 结论 | 证据 |
|---|---|---|
| Node 22 clean install | **PASS** | 干净克隆内 `npm ci` 根包 0 依赖 / `apps/studio` 57 包，48.4 s |
| `npm test` | **PASS** | 20/20 通过（Node 内置 `node:test`） |
| 锁文件可重现 | **PASS** | 两个独立克隆各跑一次 `npm ci`，安装树 sha256 完全一致 |
| 生成依赖清单 | **PASS** | `docs/dependencies/dependency-manifest.{json,md}`，88 个依赖全部有许可 |
| Windows CI 构建脚本 | **PASS** | `.github/workflows/ats-102-build.yml`，3 个 job；本地以 `tools/ci_build_gate.mjs` 逐步复现并全绿 |

**本次交付同时关闭了 ATS-101 §5.1 指出的两处「ATS-102 待办」**：仓库此前既无 lockfile 也无 CI 配置。

**未随本次交付完成的事项**（不得计入通过）：

1. **GitHub Actions 未在真实 runner 上跑过**。本仓库的 `origin` 是 `github.com/UlyssesLeoLee/ICHOR.git`，但远端 `main` 只有一个 LICENSE 文件、且本分支从未推送，因此**无法在本机触发一次真实的 CI 运行**。workflow 的正确性由「本地以同一组命令逐步复现并全绿」证明（见 §4），**不是**由 CI 运行结果证明。
2. **Rust/Tauri 侧构建未验证**。见 §6 的镜像前置条件说明。
3. **NFR-012 的「分发审计」结论未出**。本次只提供了 SPDX 依赖清单所需的**数据基础**，审计结论本身仍属未完成项（`docs/16-BASELINE-ADR.md` §7 第 6 条）。

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
2. **两个独立克隆各装一次，安装树必须逐字节一致**。实测：两个克隆的 `apps/studio/node_modules` 下全部 317 个 `package.json` 聚合 sha256 同为
   `2ece6ea6f218344269b1132b5195377504423c59df7a01a965ef86f7c11103c6`。
3. **lockfile 自身在安装前后哈希不变**。实测两个 lockfile 的 sha256 在安装前后相同：
   - `package-lock.json` → `703557d47d0bb8b3582dbc9daf0ee1d1a0972d58f0391f77e2b08f8942ec46d9`
   - `apps/studio/package-lock.json` → `5931d663e33da6fc3e56a968e6100a5f275a254473a5d67714bcbd13004fee24`

证据：`docs/evidence/ATS-102/03-lockfile-reproducibility.log`。

### 2.3 Node 版本固定

- `.nvmrc` → `22.23.4`（Node 22 LTS「Jod」的末版），CI 用 `actions/setup-node` 的 `node-version-file` 读取。
- 根 `package.json` 的 `engines.node` 仍是 `">=22"`（运行时的下限约束，不改），另加 `packageManager: "npm@10.9.9"` 记录产出 lockfile 的 npm 版本。
- `tools/ci_build_gate.mjs --check-node` 断言 **major 必须为 22**：lockfile 由 Node 22 自带的 npm 产出，换 major 可能解析不同。

## 3. CI workflow

文件：`.github/workflows/ats-102-build.yml`。触发条件为 `push` / `pull_request`（分支 `main`、`dev`）与 `workflow_dispatch`；同一分支的旧运行会被 `concurrency` 取消；`permissions: contents: read`。

| job | runner | 门禁内容 |
|---|---|---|
| `node-tests` | `windows-2022` | Node 22 版本断言 → 根 `npm ci` → lockfile 未被改写 → `npm test` → `node --check server/index.mjs` |
| `web-build` | `windows-2022` | `apps/studio` 的 `npm ci` → lockfile 未被改写 → `next build` → 产物 `out/index.html` 存在且非空 |
| `dependency-manifest` | `ubuntu-latest` | 安装依赖 → 重新生成依赖清单 → `--check` 断言与提交的清单一致 |

三个 job 各自把产物上传为 artifact（测试输出、静态导出目录、依赖清单），保留 7 天。

### 3.1 与本地门禁脚本的一致性

workflow 的每一条命令都对应 `tools/ci_build_gate.mjs` 里的一个 step（`install` / `lockcheck` / `test` / `build` / `manifest`）。该脚本可在任意有 Node 22 的机器上以一条命令复现整个门禁：

```bash
node tools/ci_build_gate.mjs            # 全部步骤
node tools/ci_build_gate.mjs --list     # 列出步骤
node tools/ci_build_gate.mjs --step test
```

这使「CI 会不会绿」在推送之前就能本地验证，而不必等 runner。

## 4. 本地实测（IT）

运行环境：Windows 11；Node **v22.23.4**（官方 zip，SHA-256 已对 `SHASUMS256.txt` 校验：`cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20`）；npm **10.9.9**；registry `https://registry.npmjs.org/`。

方法：`git clone --no-local` 出**全新克隆**（无 `node_modules`、无 `.next`、无 `out/`），在其中跑门禁脚本。

```
$ node tools/ci_build_gate.mjs
=== ATS-102 build gate ===
node   : v22.23.4
npm    : 10.9.9
repo   : ...\clean-clone

--- [install] Clean install from the committed lockfiles (npm ci)
  $ npm ci --no-audit --no-fund
up to date in 769ms
  ok (1434 ms)
  $ npm ci --no-audit --no-fund
added 57 packages in 46s
  ok (46915 ms)
--- [install] PASSED (48350 ms)

--- [lockcheck] npm ci did not mutate either lockfile
  $ git diff --exit-code -- package-lock.json apps/studio/package-lock.json
  ok (105 ms)
--- [lockcheck] PASSED (105 ms)

--- [test] Unit / integration tests (node --test)
  ...
# tests 20
# pass 20
# fail 0
--- [test] PASSED (2341 ms)

--- [build] Next.js 16 static export
  $ npm run build
▲ Next.js 16.4.5 (Turbopack)
✓ Compiled successfully in 1698ms
  Finished TypeScript in 3.3s
✓ Generating static pages using 4 workers (3/3) in 1038ms
Route (app)  ○ /   ○ /_not-found   (Static) prerendered as static content
  ok (10300 ms)
  $ node ...\tools\ci_build_gate.mjs --check-artefact
artefact ok: apps\studio\out\index.html (12927 bytes)
--- [build] PASSED (10444 ms)

--- [manifest] Dependency manifest is in sync with the lockfiles
  $ node tools/gen_dep_manifest.mjs --check
RESULT: OK -- the committed dependency manifest matches the lockfiles.
  packages=88 licenceKnown=88 reviewRequired=16
--- [manifest] PASSED (174 ms)

RESULT: OK -- every build-gate step passed.
```

**门禁退出码 0**；门禁跑完后 `git status --short` 为**空**（工作区干净），即构建不再留下脏文件。完整日志：`docs/evidence/ATS-102/01-clean-clone-build-gate.log`。

## 5. 依赖清单（NFR-012 的数据基础）

生成器：`tools/gen_dep_manifest.mjs`。输出：`docs/dependencies/dependency-manifest.json`（机读）与 `docs/dependencies/dependency-manifest.md`（人读）。

- **数据源是已提交的 lockfile**，不是本机的 `node_modules`。因此在没装过依赖的机器上也能生成，且结果一致。
- **许可数据取自 npm registry 元数据**，不是已安装的 `package.json`。原因：已安装树只含当前 OS 的平台原生二进制（`@next/swc-*`、`@img/sharp-*` 等 40 个 optional 包），若从安装树取许可，同一 lockfile 在 Windows 与 Linux 上会生成**不同**的清单，`--check` 门禁将失去意义。
- 每个依赖记录：版本、许可、SPDX（若发布）、`resolved` URL、**`integrity` 哈希**（npm 安装时实际校验的那个值）、是否直接依赖、是否 dev/optional、复核等级。
- 88 个依赖**许可全部已知**（UNKNOWN 0 个），无 unknown 可供猜测。

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
| `strong` | **0** | AGPL/GPL/SSPL/BUSL/Elastic/Commons-Clause：强 copyleft 或源码可得，可能要求公开合并作品 |
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

本次的处理：**把改写后的内容提交进版本控制**，并实测该副作用是**幂等的**（连续两次 `next build` 后两文件的 sha256 不变）。因此构建后工作区不再变脏，CI 无需「允许变更清单」，只保留一步**报告**（`git --no-pager diff --stat`，`continue-on-error: true`，不阻断）以便将来升级 Next 时能看见差异。

实测：构建前后 `next-env.d.ts` sha256 `1b59d4c6…`、`tsconfig.json` sha256 `3314e0e7…`，第二次构建后不变。

### 6.3 新增第二个 lockfile 引入的告警及其消除

加入 `apps/studio/package-lock.json` 后，Next.js 报 workspace root 推断告警（它在两个 lockfile 中推断错了根目录）。已在 `apps/studio/next.config.mjs` 固定 `turbopack.root: import.meta.dirname` 消除。构建日志中该告警已不再出现。

> 注：`turbopack.root` 必须是 ESM 安全的写法——`__dirname` 在 `.mjs` 中不可用（会抛 `ReferenceError: __dirname is not defined in ES module scope`），此处用 `import.meta.dirname`。

### 6.4 对 ATS-104（Tauri Windows 构建）的镜像前置条件

ATS-101 §8 建议：「ATS-102 的 CI 脚本须固定该镜像」。本次的 workflow 用 `runs-on: windows-2022`（自带 VS 2022 生成工具），为后续 `cargo build` 预留了镜像基线。

**但这不构成 B-02 已关闭**：B-02 的成因清单尚未穷尽（`docs/16-BASELINE-ADR.md` §4 B-02），且仓库仍缺 `src-tauri/icons/icon.ico`。本次 workflow **未加入 Rust/Tauri job**——理由是：仓库现状下该 job 必然失败（B-02），加一个必红的 job 只会让门禁失去意义。**该 job 属于 ATS-104 的交付范围**，届时应连同 `.ico` 资源与 MSVC 链一并加入。

## 7. 未验证项声明（PENDING ≠ PASS）

1. **GitHub Actions 未在真实 runner 上执行**。原因见 §1 第 1 条：远端 `main` 仅有 LICENSE、本分支未推送，无法触发真实 CI。workflow 的**命令序列**已由本地门禁脚本逐步复现并全绿，但**runner 环境的实际行为**（`actions/setup-node` 的缓存、artifact 上传、`windows-2022` 镜像内容）未验证。
2. **Rust/Tauri 构建未验证**（B-02），本次不涉及。
3. **NFR-012 的分发审计结论未出**，本次只提供数据基础（§1 第 3 条）。
4. **完整 SPDX SBOM 未生成**（§5.3）。
5. **16 个需复核依赖的最终法律结论未出**（§5.2）。
6. **macOS / Linux 上未实测**。本次全部实测在 Windows 11 上完成；lockfile 的 `resolved` 与 `optional` 条目覆盖其他平台，但安装树的跨平台一致性未验证。
7. **CI 的并发取消（`concurrency`）与 artifact 保留行为未实测**。

## 8. 冻结声明

- 本文件描述的是 ATS-102 交付后的状态：分支 `agent/m3/seikoist-147`。
- **未验证项一律如实标注**，不得计入通过。
- 本文件所列命令与输出均可在 `docs/evidence/ATS-102/` 中找到对应日志，并可用 `node tools/ci_build_gate.mjs` 重跑。
- 本文件的任何修改必须附新的可执行证据（命令 + 实际输出）。
