# ATS-BL-001 v0.1 缺陷／设计基线冻结与 ADR（v0.1.1 基线）

- 基线对象：AI Test Studio，源码基线 commit `c68bc0c`（branch `agent/m3/seikoist-146-fe4e9eff0e48`）
- 冻结日期：2026-11-03；冻结目标版本：v0.1.1（阶段 S1）
- 上游依据：`docs/02-REQUIREMENTS.md`（FR/NFR）、`docs/03/04`（设计）、`docs/07/08/09`（UT/IT/ST）、`docs/14-REVIEW-VERIFICATION.md`、`docs/13-ROADMAP.md`、`docs/WBS.xlsx`「开发WBS」
- 原始执行证据：`docs/evidence/ATS-101/`（01 单元/集成测试、02 Runner 缺陷复现、03 构建约束、04 接口面与错误码）
- 状态标记沿用仓库约定：`IMPLEMENTED` ＝ 代码能力存在；`DESIGNED` ＝ 仅设计。**本文件不得把设计中的能力称为已实现。**

## 1. 结论摘要

v0.1 的**代码能力基线成立**：Node Bridge 的项目登记、静态索引、受控源码读写、Runner 调度、状态/事件/证据归档链路已实现，20 项 UT/IT 全绿（`docs/evidence/ATS-101/01-node-test.log`）。

但**v0.1.1 不能按当前源码进入实机验收**，原因有 3 项阻断（§4）。其中 B-01 是单点致命缺陷：Bridge 传给 Playwright Test CLI 的参数向量包含两个**不存在的选项**，导致任何真实浏览器执行在参数解析阶段即失败，`summary=null`、`artifacts=[]`。该缺陷同时使 24 项 ST 中依赖真实运行结果的 ST-008/009/010/011/012/017/024 无法开展。

同时更正两处**已过时的环境结论**（原文档写于 npm registry 不可达时）：Next.js 16 静态导出构建**本次实测成功**；Rust 工具链**已安装**。Tauri 编译失败的真实原因不是「Cargo 未安装」，而是 **MSVC C++ 构建工具工作负载缺失**（§5.3）。

## 2. 实现状态基线（已实现／待实测／未实现）

### 2.1 已实现并有已执行证据（12 项要件）

| 要件 | 能力 | 已执行证据 | 证据强度 |
|---|---|---|---|
| FR-001 | 本地项目登记与校验 | UT-CORE-001、UT-CORE-004、IT-API-001 | 真实 HTTP |
| FR-004 | 静态测试索引（heuristic） | UT-CORE-002、IT-API-002 | 真实 HTTP |
| FR-007 | SHA-256 乐观锁保存 | UT-CORE-003 | 真实文件 IO |
| FR-009 | 启动全部测试 | UT-RUN-001、IT-RUN-001、IT-RUN-MOCK-SETUP | **仅 mock CLI**，真实浏览器见 §4 B-01 |
| FR-011 | 停止运行 | IT-RUN-MOCK-002 | **仅 mock CLI** |
| FR-012 | 运行历史不覆盖 | IT-API-003 | 真实 HTTP |
| FR-014 | JSON/HTML/Trace 归档 | IT-RUN-MOCK-001 | **仅 mock CLI**，真实产物见 §4 B-01 对照实验 |
| FR-016 | 报告摘要解析 | UT-RPT-001 | 真实 JSON（且已用真实 Playwright report.json 复核，§4 B-01 场景 B） |
| NFR-002 | Token/Origin/Host 防护 | IT-SEC-001、IT-SEC-002 + raw socket 实测 | 真实 HTTP |
| NFR-003 | 路径穿越/越界阻断 | UT-SEC-001 | 真实文件 IO |
| NFR-005 | 零迁移与夹清理 | UT-CORE-005、IT-API-CLEANUP、IT-RUN-MOCK-CLEANUP | 真实进程 |
| NFR-011 | 错误可定位 | IT-API-SETUP + §4.2 全量错误码实测 | 真实 HTTP |

### 2.2 已实现但待实测（代码路径存在，缺真实机器证据）

| 要件 | 状态 | 待实测项 | 关联 ST |
|---|---|---|---|
| FR-002 | IMPLEMENTED | Git branch/commit/dirty 与 Git CLI 一致性 | ST-002 |
| FR-003 | IMPLEMENTED | 零迁移导入真实仓库 | ST-001 |
| FR-005 | IMPLEMENTED | 关键字检索可用性 | ST-003 |
| FR-006 | IMPLEMENTED | 源码浏览/编辑与 1MB 边界 | ST-004 |
| FR-008 | 部分实现 | 流程投影与复杂代码共存 | ST-007 |
| FR-010 | IMPLEMENTED | 指定脚本执行（依赖 B-01 修复） | ST-009 |
| FR-013 | IMPLEMENTED | 日志轮询与错误展示 | ST-024 |
| FR-015 | IMPLEMENTED | 证据下载与哈希一致 | ST-011、ST-016 |
| FR-017 | IMPLEMENTED | 需求关系读取 | ST-018 |
| FR-018 | IMPLEMENTED | 事件审计与 JSONL | ST-012 |
| FR-019 | IMPLEMENTED | 外部编辑冲突 | ST-006 |
| FR-020 | 部分实现 | Next 构建已通过；Tauri 见 §5.3 | ST-021、ST-022 |
| NFR-001 | 基础具备 | 断网可用 | ST-013 |
| NFR-004 | 部分具备 | 证据哈希一致 | ST-016 |
| NFR-007 | 部分 | 三 OS 便携 UI | ST-020 |
| NFR-008 | 部分 | 重启恢复（**已发现卡死缺陷**，§4 B-03） | ST-017 |
| NFR-010 | 部分 | 原子写与半写保护 | UT-DATA-001（ST 无对应项） |

### 2.3 未实现（仅设计，P1/P2）

FR-021（`--list` 权威发现）、FR-022（AST 受控反写）、FR-023（WDIO Tauri）、FR-024/025（AI 生成与诊断）、FR-026（图谱血缘）、FR-027（密钥存储）、FR-028（远程/CI）、FR-029（Agent 自主探索）、FR-030（多用户 RBAC）；NFR-006（性能指标）、NFR-012（依赖 SPDX/SBOM）。

**未实现的 P0 功能项为 0 项**；上述均为 P1/P2 范围，对应 WBS ATS-201 及以后。

### 2.4 覆盖率量化

- 测试设计总数 75（UT 25 / IT 26 / ST 24）；**已执行通过 20，待执行 55**。
- **ST 实机执行 0/24**。UT/IT 通过**不等于** ST 验收（见 `docs/09-ST-TEST-DESIGN.md` 退出条件）。
- 42 条要件中，有 ≥1 条已执行测试覆盖者 12 条；**P0 FR-001~020 中 12 条无任何已执行测试**（FR-002/003/005/006/008/010/013/015/017/018/019/020）。
- RTM 引用的测试 ID **无悬挂**（`tests/rtm.json` 全部 75 个 ID 均在设计表中存在）。

## 3. 接口约束清单（以实测为准）

### 3.1 HTTP 接口面

Bridge 仅监听 `127.0.0.1:<ATS_PORT>`（默认 4577）。状态类 API 需 `X-ATS-Token`；`/api/session` 由 Origin allowlist 保护。实测完整清单与状态码见 `docs/evidence/ATS-101/04-api-surface.log` §4.1。

| 方法 | 路径 | 鉴权 | 实测 | 说明 |
|---|---|---|---|---|
| GET | `/api/health` | 公开 | 200 | 版本/健康 |
| GET | `/api/session` | Origin allowlist | 200 | 进程级随机 token（48 hex），重启即失效 |
| GET | `/api/projects` | token | 200 | 含实时 git branch/commit/dirty |
| POST | `/api/projects` | token | 201 | 需 `package.json` + `playwright.config.*` |
| GET | `/api/projects/:id/tests` | token | 200 | 静态索引 + heuristic 警告 |
| GET | `/api/projects/:id/source?file=` | token | 200 | `{file,content,hash}` |
| PUT | `/api/projects/:id/source` | token | 200 | 需 `baseHash`，SHA-256 不匹配则 409 |
| POST | `/api/projects/:id/run` | token | 202 | `{file}` 缺省＝全部；同项目并发 409 |
| GET | `/api/projects/:id/lineage` | token | 200 | 读 `.aitest/*.json`，只读 |
| GET | `/api/runs` | token | 200 | 历史列表，日志以 `logLength` 返回 |
| GET | `/api/runs/:id` | token | 200 | 运行状态/日志/summary/artifacts |
| POST | `/api/runs/:id/stop` | token | 200 | Windows `taskkill /T /F`，Unix SIGTERM |
| GET | `/api/runs/:id/events` | token | 200 | `events.jsonl` 追加事件 |
| GET | `/api/runs/:id/artifact?file=` | token | 200 | 越界拒绝；`Content-Disposition: attachment` |
| GET | `/api/diagnostics` | token | 200 | runtime/platform/limitations[] |

**接口硬约束**（下游改动必须同步，违反即静默失效）：

1. **端口 4577 被硬编码在五处**：`server/index.mjs:11`（默认值）、`server/index.mjs:71`（CSP `connect-src`）、`apps/studio/lib/api.ts:6`（API Base）、`apps/studio/public/fallback.html`（页脚文本）、`src-tauri/src/lib.rs:19`（`ATS_PORT`）。改端口须同步全部，否则 UI 与 CSP 会指向错误端口。
2. **`ATS_PORT` 非默认时 UI 不可用**：实测 bridge 在 19988 端口正常启动，但 CSP 与 `api.ts` 仍指向 4577。
3. **Host 白名单绑定端口**：`server/index.mjs:60` 的正则含 `${PORT}`，改端口后 Host 校验随之变化。
4. **仅可信本地项目**：不自动安装依赖，不接受任意 CLI 字符串（`spawn(..., shell:false)`）。

### 3.2 错误码实测映射

设计文档 `docs/04-DETAILED-DESIGN.md` §7 与实测一致的部分：`INVALID_PROJECT_PATH`(400)、`PROJECT_PACKAGE_JSON_REQUIRED`(400)、`PROJECT_ALREADY_REGISTERED`(409)、`INVALID_SOURCE_FILE`(400)、`PATH_OUTSIDE_PROJECT`(400)、`STALE_EDIT_CONFLICT`(409)、`PAYLOAD_TOO_LARGE`(400)、`INVALID_SESSION`(401)、`ORIGIN_NOT_ALLOWED`(403)、`INVALID_HOST`(403)、`RUN_NOT_FOUND`(404)、`NOT_FOUND`(404)。

**实测与设计不符（缺陷，见 §4 B-04 附带项）**：

| 场景 | 实测 | 设计预期 | 问题 |
|---|---|---|---|
| 目标不是目录（`NOT_A_DIRECTORY`） | **500** | 400 | 归类错误 |
| 停止非活动 Run（`RUN_NOT_ACTIVE`） | **500** | 设计文档 §7 错误码表未收录此码 | 归类错误；且状态语义与幂等性见 B-03 |
| 登记不存在的路径 | **500** + `ENOENT: ... lstat 'D:\definitely'` | 400 | **泄漏宿主绝对路径** |
| 下载不存在的附件 | **500** + 泄漏 `ATS_DATA_DIR` 绝对路径 | 404 | **泄漏宿主绝对路径** |

## 4. 阻断项（3 项）

> 阻断定义：不解决则 S1 阶段门禁（ATS-116）不能放行，或 v0.1.1 不能对外声明能力。

### B-01（严重 / P0）Playwright CLI 参数向量含不存在的选项，真实浏览器执行 100% 失败

- **位置**：`server/core.mjs:82` `safeRunArgs()`
- **现状**：传入 `--screenshot only-on-failure --video retain-on-failure`。但 `playwright test` CLI **没有** `--screenshot` 与 `--video` 选项（截图/视频是 `playwright.config.ts` 的 `use` 选项，不是 CLI 选项）。实测 `npx playwright test --help` 输出中无此二者。
- **实测证据**：`docs/evidence/ATS-101/02-runner-defects.log` 场景 A —— 经 Bridge 启动真实 Playwright 项目：
  ```
  终态 status=failed exitCode=1
  summary=null
  artifacts=[]
  stdout 末尾: "error: unknown option '--screenshot'\n"
  events=["run.queued#1","run.started#2","run.finished#3"]
  ```
  即：CLI 参数解析阶段即退出，**从未启动浏览器**，无 summary、无任何证据归档。
- **对照实验（场景 B）**：仅从参数向量中删除 `--screenshot`/`--video`（不改其他任何代码），同一真实项目：
  ```
  summary: total=2 passed=1 failed=1 skipped=0 flaky=0
  artifacts 数量=31
  产出 report.json / html/index.html / html/trace/** / results/**/trace.zip
        / results/**/test-failed-1.png / results/**/video.webm
  ```
  证明阻塞点唯一，且 `parseReport()` 能正确解析真实 Playwright report.json。
- **影响**：ST-008/009/010/011/012/017/024 及 ATS-107/108/109/114 全部阻断；FR-009/010/011/014/018 的「已实现」仅有 mock CLI 证据，真实链路未成立。
- **修复方向**（不在本任务范围内，属 ATS-106/107）：从 `safeRunArgs()` 移除两个选项，改为向目标项目 `playwright.config.ts` 注入 `use.screenshot`/`use.video`（或依赖项目自身配置）；并以真实 Playwright CLI 做参数契约测试，防止再次漂移。

### B-02（严重 / P0）Tauri Rust 编译失败——缺 MSVC C++ 构建工具，非「Cargo 未安装」

- **位置**：`src-tauri/`（`Cargo.toml` 依赖解析本身正常，406 个包已锁定）
- **更正旧结论**：`docs/14-REVIEW-VERIFICATION.md` §2 称「Cargo 未安装」。**实测 Cargo/Rust 已安装**（cargo 1.99.1、rustc 1.99.1、两个 toolchain：msvc 与 gnu），只是不在 PATH，须用 `~/.cargo/bin/cargo.exe` 全路径调用。
- **实测失败（两条工具链均失败）**：
  ```
  # 默认 msvc
  $ cargo check --message-format short
  error: linking with `link.exe` failed: exit code: 1
  note: in the Visual Studio installer, ensure the "C++ build tools" workload is selected
  （17 处同类 error）CARGO_CHECK_EXIT=101

  # gnu（排除 MSVC 特有因素后仍失败）
  $ cargo +stable-x86_64-pc-windows-gnu check
  error: linking with `x86_64-w64-mingw32-gcc` failed: exit code: 1
  GNU_CHECK_EXIT=101
  ```
- **根因确认**：`vswhere -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64` **无输出** → 该工作负载未安装。VS 18 Community 本体存在，但 `VC/Tools/MSVC` 目录不存在，即无 C/C++ 编译器与链接器。WebView2 Runtime 149.0.4022.98 已安装，但无用例因编译失败而启动。
- **影响**：ATS-104/105、ST-022、FR-020 的桌面侧不能验证。
- **修复方向**（属 ATS-104 / ATS-102）：安装 VS「使用 C++ 的桌面开发」工作负载并固定工具链版本；CI 需显式声明 Windows 构建镜像含 MSVC C++ 工具链。

### B-03（严重 / P0）重启后 Run 卡在 `cancelling`，永久占用同项目运行锁且 API 无法解除

- **位置**：`server/index.mjs:15`（启动恢复）、`server/index.mjs:54-58`（`cancelRun`）、`server/index.mjs:95`（并发判定）
- **根因**：启动恢复只把 `queued`/`running` 标记为 `interrupted`，**遗漏 `cancelling`**（`server/index.mjs:15`：`if(['queued','running'].includes(run.status))`）。而 `cancelRun()` 在找不到活动 job 时抛 `RUN_NOT_ACTIVE`，因此这条 Run 既不会被恢复，也无法通过 `/stop` 解除。
- **实测证据**：`docs/evidence/ATS-101/02-runner-defects.log` 场景 C：
  ```
  重启后该 Run 状态 = cancelling  （期望 interrupted，实测卡死）
  同一项目 POST /run -> 409 {"error":"PROJECT_ALREADY_RUNNING"}
  POST /stop 解除卡死 -> 500 {"error":"RUN_NOT_ACTIVE"}
  ```
- **影响**：一次「请求停止后进程被强杀」的异常即可使该项目的运行功能**永久不可用**（无自愈路径）；ATS-108（取消/超时/子进程树回收与重启 ST）、ATS-112、NFR-008、FR-011、ST-010、ST-017 直接阻断。
- **修复方向**（属 ATS-108/112）：启动恢复的状态集合补齐 `cancelling`；`/stop` 对已终结 Run 应幂等返回终态而非 500；同项目运行锁改为以「活动 job 存在性」而非「历史记录状态」判定。

## 5. 构建约束清单（实测）

### 5.1 Node Bridge

- 运行时：Node ≥ 22（`package.json` `engines`）。实测 Node v24.19.0 / npm 12.2.0 全绿通过。
- **无 lockfile**（根与 `apps/studio` 均无 `package-lock.json`）→ 依赖不可重现，属 ATS-102 待办。
- **无 CI 配置**（无 `.github/workflows`、无 `.gitlab-ci.yml`）→ 无自动门禁，属 ATS-102 待办。
- 根包无第三方运行时依赖，测试全部用 Node 内置 `node:test`。

### 5.2 Next.js 16 静态导出

- **本次实测构建成功**（**更正** `docs/14-REVIEW-VERIFICATION.md` §2 与 `docs/13-ROADMAP.md` §1「npm registry 离线，无法完成 build」的过时结论）：`npm install` 55 包 46s；`next build`（Next.js 16.4.4, Turbopack）编译 1485ms、TypeScript 2.2s、静态页 3/3；产物 `apps/studio/out/{index.html,404.html,_next/**}`。
- 实测该产物可由 Bridge 直接伺服：`GET /` 与 `GET /index.html` 返回 200 且为 Next 导出 HTML；`/fallback.html` 返回便携 UI。
- **构建副作用（须纳入版本控制约定）**：`next build` 会改写两个受版本控制的文件——
  - `apps/studio/next-env.d.ts`：追加 `./.next/types/routes.d.ts` 等 import（+5 行）
  - `apps/studio/tsconfig.json`：由单行 JSON 重排为多行，并追加 `.next/dev/types/**/*.ts`
  → 构建后工作区必然 dirty，CI 需先校验这两文件是否与基线一致，或将其纳入允许变更清单。
- `next.config.mjs` 为 `output:'export'`，无 SSR、无 API Routes；`trailingSlash:true`。

### 5.3 Tauri 2 / Rust

- 依赖解析**可行**：`cargo generate-lockfile` 成功锁定 406 个包（tauri 2.12.5）；crates.io 可达。
- **编译不可行**：见 B-02。cargo 不在 PATH，须用全路径调用。
- `tauri.conf.json`：`beforeDevCommand` = `npm --prefix apps/studio run dev`（3000 端口），`devUrl` = `http://localhost:3000`，`frontendDist` = `../apps/studio/out`，`bundle.active=false`（不产出安装包）。
- `src-tauri/src/lib.rs` 以 `Command::new("node")` 拉起 `../server/index.mjs` 并设 `ATS_PORT=4577`；**要求 PATH 中有 node**，否则 bridge 静默不启动（`spawn().ok()` 丢弃错误）——属 ATS-105 待办。
- `src-tauri/Cargo.lock` 当前**不在版本控制中**。

### 5.4 Playwright / 浏览器

- `@playwright/test` 1.64.1 可从 npm 安装（registry 本次可达）。
- 本地浏览器缓存 revision 与 1.64.1 需求**完全一致**：chromium-1248、chromium_headless_shell-1248、firefox-1555、webkit-2370、ffmpeg-1013。
- 实测真实 Chromium 可启动并产出 trace/截图/视频（见 §4 B-01 场景 B）。
- 结论：**真实浏览器 ST 的环境障碍已解除**，剩余障碍是 B-01 的代码缺陷。

## 6. ADR（基线冻结决策）

| ADR | 决策 | 状态 | 理由 |
|---|---|---|---|
| ADR-001 | Git 仓库是 test script 的唯一权威定义，平台只建衍生索引与运行记录 | ACCEPTED（延续） | 避免双份脚本冲突 |
| ADR-002 | v0.1 只交付 Playwright Runner；WDIO 为 P1 Adapter | PARTIAL（延续） | 不重写驱动 |
| ADR-003 | v0.1 代码视图可写、流程视图只读；AST 受控反写为 P1 | PARTIAL（延续） | 任意 TS 无可逆 DSL |
| ADR-004 | 事件追加不覆盖；每次运行保留 commit/manifest/SHA-256 | PARTIAL（延续） | 证据可追溯 |
| ADR-005 | HTTP 仅 loopback + Origin allowlist + token；仅可信仓库；不声称容器级安全 | IMPLEMENTED with limitations | 实测 403/401 全部按预期 |
| ADR-006 | AI 只产出候选 Patch，未经审阅不得落 Git commit 或改期望值 | DESIGNED（P1） | 防假阳性掩盖缺陷 |
| ADR-007 | Next 静态导出 + Tauri 2 壳；便携 HTML 为零依赖回退 | **PARTIAL → 源码与 Next 构建均已验证；Tauri 受 B-02 阻断** | 本次实测 Next 构建成功 |
| ADR-008 | 自研代码 MIT；第三方依赖分别审查 | ACCEPTED（延续） | NFR-012 的 SPDX/SBOM 仍未完成（ATS-115） |
| **ADR-009** | **「实机能力未验证」不等于「环境不可用」：构建与浏览器环境障碍必须与代码缺陷分开记录** | **ACCEPTED（本次新增）** | 本次实测推翻了「npm 离线 / Cargo 未安装」两条旧结论；若不分离，真实代码缺陷（B-01）会被误记为环境问题而长期挂起 |
| **ADR-010** | **Runner 的 CLI 参数向量必须有真实 CLI 契约测试，不得仅用测试双桩验证** | **ACCEPTED（本次新增）** | 20/20 UT/IT 全绿却掩盖 B-01：mock CLI 接受任意参数，因此无法发现参数不存在 |
| **ADR-011** | **持久化状态机的恢复集合必须与运行态集合对齐；终态操作须幂等** | **ACCEPTED（本次新增）** | B-03 表明遗漏 `cancelling` 可造成不可自愈的锁死 |
| **ADR-012** | **v0.1.1 门禁放行前，B-01/B-02/B-03 必须全部关闭且有真实机器证据** | **ACCEPTED（本次新增）** | 三项均为 S1 阶段门禁（ATS-116）的前置条件 |

## 7. 未验证项声明（PENDING ≠ PASS）

以下项目**未执行或未完成**，不得计入通过：

1. **24 项 ST 全部未执行**（ST-001~024），原因：ST-001~024 需要真实 UI/浏览器/Windows/Tauri 环境，其中依赖真实运行结果的部分被 B-01 阻断，Tauri 部分被 B-02 阻断。
2. **真实浏览器 PASS/FAIL/CANCEL 未通过 Bridge 验证**——B-01 修复前不可能通过；对照实验只在沙箱副本中验证了「去掉两个选项即可工作」，**产品源码未修改**，不得据此宣称产品已具备该能力。
3. **Tauri Windows 构建未验证**（B-02）。
4. **macOS/Linux 便携 UI 未验证**（仅 Windows 11 实测）。
5. **性能指标未实测**（NFR-006：500 用例 3 秒目标无基线）。
6. **依赖 SPDX/SBOM 未生成**（NFR-012 未完成）。
7. **多实例并发写 state 未验证**（JSON 原子写已实现，单写锁未实现）。
8. **证据保留期与脱敏未实现**（Trace/视频含 PII 风险未闭环）。

## 8. 对 WBS 的影响与建议

- **ATS-101 本身**：基线冻结与 ADR 已交付（本文 + `docs/evidence/ATS-101/` 4 份执行日志 + WBS 状态同步）。
- **建议调整 WBS 归属**：
  - B-01 → **ATS-106**（Playwright CLI 环境检测与参数安全基线）应升级为 P0 关键阻断，并新增「真实 CLI 参数契约测试」验收项；执行类任务的 ATS-107 须在其后进行。
  - B-02 → **ATS-104** 验收标准须补入「构建镜像含 MSVC C++ 构建工具工作负载」；ATS-102 的 CI 脚本须固定该镜像。
  - B-03 → **ATS-108**（取消/超时/子进程树回收与重启 ST）须明确覆盖「cancelling 状态恢复」；ATS-112 须覆盖「终态操作幂等」。
- **阶段门禁**：在 B-01/B-02/B-03 关闭前，ATS-116（v0.1.1 质量门）不应放行，阶段出厂检查「设计一致性」「UT/IT」「ST/UAT」三项保持「待检查」。
- **文档同步**：本文件与 `docs/14-REVIEW-VERIFICATION.md`、`docs/13-ROADMAP.md` 中关于「npm 离线」「Cargo 未安装」「Next build 不可完成」的表述已过时，应按 §5 更正。

## 9. 冻结声明

- 本基线描述的是 commit `c68bc0c` 及本任务新增文档后的状态。
- **未实现项一律标注 DESIGNED，不得在下游文档、发行说明或对外材料中称为已实现。**
- 任何对本基线的修改必须附新的可执行证据（命令 + 实际输出），并更新 `docs/evidence/ATS-101/` 与 `docs/WBS.xlsx`。
- 下一版基线（v0.1.2 候选）触发条件：B-01/B-02/B-03 关闭 + ST-001~024 有实机结论。
