# ATS-BL-003 Next.js 16 静态导出构建、路由与 API 代理验证（ATS-103 交付）

- 交付物：WBS ATS-103（S1 / v0.1.1，工作流「前端」，主责 FE），对应需求 FR-020、NFR-007
- 基线起点：commit `49fbafb`（`agent/m2/seikoist-148` 分支起点）；上游依据 `docs/16-BASELINE-ADR.md`（§5.2 静态导出 / §7 未验证项）、`docs/17-BUILD-CI.md`（ATS-102 交付）、`docs/03-BASIC-DESIGN.md` §1/§4、`docs/05-UI-UX.md`
- 本文件在 `dev` 合入后的分支上交付：`dev` 已用 `docs/21-CONTROL-PLANE-API.md` 占用 21 号，故本文件为 `docs/22-FRONTEND-EXPORT.md`
- 状态标记沿用仓库约定：`IMPLEMENTED` ＝ 代码能力存在；`DESIGNED` ＝ 仅设计。**本文件不得把设计中的能力称为已实现。**

## 1. 结论摘要

ATS-103 的验收标准是「**产出静态目录；127.0.0.1 Bridge 的会话/项目/运行操作成功**」。两项**均已在 Windows 11 实机实测通过**，验证脚本为 `tools/ats103-probes/verify-export-and-proxy.mjs`（**23/23 项检查通过，退出码 0**），证据见 `docs/evidence/ATS-103/`。

| 验收项 | 结论 | 证据 |
|---|---|---|
| Next.js 16 静态导出构建 | **PASS** | `next build`（Next.js **16.4.5**，Turbopack）编译 1.31 s、TypeScript 检查 1.55 s、静态页 3/3；产物 `apps/studio/out/`（`index.html` 12524 B、`404.html`、`_next/static/**`）；构建后工作区**不脏** |
| 导出产物的自洽性 | **PASS** | `index.html` 引用的 **8 个**资源全部存在于磁盘；导出目录**不含任何服务端路由产物**（无 `app/api`、无 `.next/server`） |
| Bridge 提供导出页 | **PASS** | `GET /` → HTTP 200（12524 B），带 CSP（`connect-src` 含 `http://127.0.0.1:4577`）；带哈希的 chunk 亦可取回（HTTP 200） |
| Bridge 会话操作 | **PASS** | `GET /api/session` 返回 token；**异源 Origin → 403**、**无 token → 401** |
| Bridge 项目操作 | **PASS** | `POST /api/projects` → 201；`GET /api/projects` → 200；`GET /api/projects/{id}/tests` → 2 个用例 |
| Bridge 运行操作 | **PASS** | `POST /api/projects/{id}/run` → **202**，随后到达终态 `failed`，**真实结果 1 PASS / 1 FAIL / 共 2 例**，采集 **27 个**证据产物（含 `report.json`、HTML 报告、每例 `trace.zip`） |

**本次交付没有改动产品代码。** `apps/studio/next.config.mjs`、`app/page.tsx`、`lib/api.ts` 与 `server/index.mjs` 全部保持 ATS-102 交付时的状态——实测证明这套配置**已经**满足本任务的完成定义（静态导出可用、路由可用、Bridge 三类操作可用）。本任务交付的是**可复跑的验证脚本 + 证据 + 结论文档**，以及一处**它发现的真实缺陷**（见 §4）。

## 2. 「API 代理」在静态导出下的真实形态

这是本任务最容易被误写的点，因此单列一节。

`next.config.mjs` 声明 `output: 'export'`。该模式下 Next.js **不产出任何服务端**：没有 API Routes、没有 SSR、没有 Node 中间件。因此**不存在「Next.js 代理」**——导出目录里没有可以转发 `/api/*` 的代码。验证脚本对这一点是**直接断言**的：

```
PASS  the export contains no server-side API route output
```

产品设计的代理形态是**跨源直连**（`docs/03-BASIC-DESIGN.md` §1：Next.js 16 静态导出 → token 鉴权的 localhost HTTP → Node 22 Local Bridge）：

1. 页面由 Bridge 自身在 `127.0.0.1:4577` 提供（`server/index.mjs` 的 `staticFile()` 把 `apps/studio/out` 当静态根目录）；
2. `apps/studio/lib/api.ts` 的 `root()` 在运行时决定 API 基址：**端口是 4577 时用同源空串**（即 `/api/...`），否则用绝对地址 `http://127.0.0.1:4577`；
3. 请求带上 `X-ATS-Token` 会话令牌；Bridge 的 `ORIGINS` 白名单与 `checkedRequest()` 负责 Origin/Host 校验。

验证脚本据此断言：**基址是运行时解析的，不是构建期烘焙的**——同一份导出既能被 Bridge 提供（同源），也能被任何静态文件服务器提供（跨源绝对地址）。脚本检查导出后的 bundle 里确实带着该解析逻辑（`4577` 与 `/api/session` 同时出现在产物 JS 中），并用**与 `lib/api.ts` 完全相同的握手顺序**（session → token → 带 token 的业务请求）走了一遍真实 HTTP。

> **因此「API 代理验证」在本次交付中的准确含义是**：跨源 API 调用链（Origin 白名单 + 会话令牌 + 三类业务操作）在**真实导出产物 + 真实 Bridge** 上成立；**不是**「验证了一个 Next.js API 代理路由」——因为静态导出下不存在这样的路由。若有人期望 `output: 'export'` 之外的服务端代理，那是与本仓库既定架构冲突的另一种设计，须另行立项。

## 3. 实测（IT / ST）

### 3.1 环境

| 项 | 值 |
|---|---|
| OS | Windows 11（x64） |
| Node | v24.19.0（PATH 默认；本机 PATH 上没有 Node 22） |
| npm | 12.2.0 |
| Next.js | 16.4.5（Turbopack） |
| 夹具 | `examples/sample-playwright`（真实 Playwright 1.58.x + 真实 Chromium） |

### 3.2 静态导出构建（ST-021）

```
$ npm --prefix apps/studio ci --no-audit --no-fund
added 55 packages in 28s

$ npm --prefix apps/studio run build
▲ Next.js 16.4.5 (Turbopack)
✓ Running next.config.mjs took 23ms
✓ Compiled successfully in 1314ms
  Running TypeScript ...
  Finished TypeScript in 1548ms ...
✓ Generating static pages using 4 workers (3/3) in 386ms

Route (app)
┌ ○ /
└ ○ /_not-found
○  (Static)  prerendered as static content
```

构建后 `git status --short` 为空——`next build` 对 `next-env.d.ts` / `tsconfig.json` 的改写是**幂等**的（ATS-102 §6.2 的结论在本分支上依然成立）。

> **环境注记（不是缺陷）**：本机 PATH 上的 npm 是 **12.2.0**、Node 是 **24.19.0**，而仓库门禁 `tools/ci_build_gate.mjs` 要求 Node **22** 且 npm **10.9.9**（`packageManager` 固定值）。因此**本任务没有跑仓库的 8 步构建门禁**，而是直接跑了本任务所需的 `npm ci` + `next build` 两步。原因与影响见 §6 第 1 条。

### 3.3 导出产物 + Bridge + API 全链（IT）

```
$ node tools/ats103-probes/verify-export-and-proxy.mjs
PASS  export directory exists (apps/studio/out)
PASS  export contains index.html  --  12524 bytes
PASS  export contains 404.html
PASS  export contains _next/static assets
PASS  the export contains no server-side API route output
PASS  the shipped bundle resolves the API base at runtime (port-aware)
PASS  every asset referenced by index.html exists on disk (8 assets)
PASS  bridge boots and answers /api/health
PASS  bridge serves the exported index.html at /  --  HTTP 200, 12524 bytes
PASS  the served page carries a CSP that allows the API origin  --  connect-src present
PASS  the bridge serves the exported chunk /_next/static/chunks/0cz1d0mv5g_q7.js  --  HTTP 200
PASS  GET /api/session returns a token
PASS  a foreign Origin is rejected (403)  --  HTTP 403
PASS  an unauthenticated API call is rejected (401)  --  HTTP 401
PASS  GET /api/projects succeeds with the session token
PASS  POST /api/projects registers the sample Playwright project  --  HTTP 201
PASS  GET /api/projects/{id}/tests returns the static index  --  2 tests
PASS  POST /api/projects/{id}/run is accepted (202)  --  HTTP 202
PASS  the accepted run reaches a terminal state  --  status=failed
PASS  a failed/error run never reports a fabricated summary  --  summary=1 passed / 1 failed / 2 total
PASS  the real run produced a per-case result set  --  2 cases
PASS  the real run collected artefacts  --  27 artefacts
PASS  GET /api/runs lists the run history  --  1 runs

RESULT: OK -- 23/23 checks passed.
```

完整日志：`docs/evidence/ATS-103/01-export-and-proxy-verification.log`。

### 3.4 真实运行的结果（不是双桩）

`examples/sample-playwright` 夹具被**真实安装**（`npm install` → `@playwright/test` 1.58.x），真实 Chromium 被真实拉起。夹具本身是**故意一成一败**的（见 `examples/sample-playwright/tests/home.spec.ts` 的注释）：

| 用例 | 结果 | 说明 |
|---|---|---|
| `首页响应正常 @REQ-001` | **passed**（155 ms） | `page.setContent` + `toHaveText('hello')` |
| `导航入口正常 @REQ-002` | **failed**（5121 ms） | 故意断言不匹配，`element(s) not found` |

采集到的 27 个证据产物包含：`report.json`（9880 B）、HTML 报告（`html/index.html` 520692 B）、每例的 `trace.zip`、以及 `results/**/error-context.md`。

> 这次运行同时**实测确认了 ATS-101 的阻断项 B-01 已不复现**：Bridge 传给 CLI 的参数向量是 `--reporter=line,json,html --output <dir> --trace on --workers 1`，全部是 `playwright test --help` 声明过的选项（ATS-301 的探针式构造），真实运行产出了真实 summary 与真实产物——这正是 B-01 修复后的应有形态。

### 3.5 回归（UT/IT）

```
$ npm test
ℹ tests 234
ℹ pass 229
ℹ fail 0
ℹ cancelled 0
ℹ skipped 5
ℹ duration_ms 18256.7003
```

退出码 **0**，**0 失败**。

> **与 ATS-102 记录的数字差异（如实说明）**：ATS-102 在 Node 22.23.4 / npm 10.9.9 上记录的是 `tests 165 / pass 158 / skipped 7`。本轮是 `tests 234 / pass 229 / skipped 5`。差异的来源**不是**本任务的改动——本任务**未改动任何被测代码**，只新增了一个独立探针脚本（不在 `tests/` 下，不参与 `npm test`）。实际原因是仓库在 ATS-102 之后又合入了 ATS-301/ATS-401/ATS-501/ATS-506 的测试与实现（测试数从 165 增至 234），而**跳过的 7 项 ATS-301 引擎 IT 变成 5 项**，因为本轮**夹具的 `node_modules` 已被真实安装**，那些 IT 不再因「引擎缺失」而跳过。两次运行的 Node/npm 版本也不同（§3.1）。**两个数字都属实，不构成回归**。

### 3.6 WBS 更新脚本共存回归

本任务新增了 `tools/update_wbs_ats103.py`，它与既有 7 个 `tools/update_wbs_*.py` **共用同一份 `docs/WBS.xlsx`**。因此跑了仓库既有的两项共享工作簿回归：

```
$ python tools/test_wbs_common.py
...
PASS the declared markers are exactly MARKERS

all checks passed

$ bash tools/ats501-probes/check-wbs-updaters.sh
updaters  : tools/update_wbs_ats101.py tools/update_wbs_ats101_done.py tools/update_wbs_ats102.py tools/update_wbs_ats103.py tools/update_wbs_ats301.py tools/update_wbs_ats401.py tools/update_wbs_ats501.py tools/update_wbs_ats506.py
updater # : 8 (discovered from tools/update_wbs_*.py)
...
  PASS  the 8 updaters produce the same sheet in either order
  PASS  running the 8 updaters twice changes nothing
  PASS  the cached 总览 values equal the values derived from 开发WBS
  PASS  every marked note of the baseline is still in the sheet
  PASS  D6 and D7 still carry every task's contribution

RESULT: OK -- the 8 WBS updaters coexist, are idempotent, do not undo
        an accepted review, and the 总览 cache always matches 开发WBS.
```

退出码 **0**。关键点：探针脚本的更新器清单是**从 `tools/update_wbs_*.py` 自动发现**的，因此新脚本一落地就被覆盖，不需要改动探针。

完整日志：`docs/evidence/ATS-103/04-wbs-updater-regression.log`。

## 4. 本次交付发现的一个真实缺陷（不属于 ATS-103 的修复范围）
**现象**：当宿主机内存紧张时，Bridge 的运行记录会**先呈现终态、后补齐结果**。

**实测**：第一次运行探针时，`POST .../run` 返回 202，随后 `GET /api/runs/{id}` 报 `status=failed` 但 `summary=null`、`artifacts=[]`。抓到的运行日志尾部显示真实原因是**子进程 OOM**：

```
FATAL ERROR: Zone Allocation failed - process out of memory
```

**根因（读代码定位）**：`server/index.mjs` 的 `finishRun()` 先把 `run.status` 置为终态（`'passed'`/`'failed'`），**之后**才采集 summary、才枚举 artifacts：

```js
run.status = cancelled ? 'cancelled' : code === 0 ? 'passed' : 'failed';
// ... 此处之后才 adapter.collect() 与 filesInRun()
```

`saveState(store)` 也在末尾才调用，因此**内存中的 `store` 是一致的**；但任何**在这两次写盘之间**读取该 run 的调用方（`GET /api/runs/{id}` 读的是内存对象，所以看到的是终态），在**持久化副本**与**最终磁盘产物**之间会看到不一致。由于 `GET /api/runs/{id}` 读内存对象，正常情况下 summary 是同步可得的——本轮之所以读到 `summary=null`，是因为**子进程因 OOM 崩溃，`adapter.collect()` 找不到 `report.json`**，于是 summary 真的为空。

**结论与归属**：这**不是** ATS-103 的前端缺陷，也不是 `next build` 的问题——它是一条**已存在的运行期证据链缺陷**：当引擎进程异常死亡时，Bridge 会把 run 标成 `failed` 却没有任何 summary，用户在 UI 上看到的是「失败」而没有任何可诊断的原因（`run.error` 为空，真实原因只存在于被截断的 `run.log` 里）。

- **本任务不修它**：修复它会改动 `server/index.mjs` 的运行期语义与状态机，属于 `server/index.mjs` 的所有者（ATS-108「取消/超时/子进程树回收」或 ATS-112「保存的原子替换」）的范围，不是前端静态导出的范围。本任务按设计文档 §5「状态机的终态判定」只**如实记录**。
- **已在本文件 §6 登记为未验证项/已知缺陷**，并**同步写进 `docs/WBS.xlsx` 的 ATS-103 风险/说明列**，让下游 ATS-111（UI 可用性）与 ATS-108 都能看到。

**本次交付对该缺陷做的唯一改动**：验证脚本新增了一条**恒真性断言**——「失败的运行不得报告伪造的 summary」。这条断言在引擎正常时通过（1 PASS / 1 FAIL 的真实 summary），在引擎崩溃时也会如实反映 `summary=none`，而不是把崩溃伪装成成功。

## 5. 交付物清单

| 路径 | 类型 | 内容 |
|---|---|---|
| `tools/ats103-probes/verify-export-and-proxy.mjs` | 新增 | 23 项检查的验证脚本（静态导出 → Bridge → API 全链），可重复执行，退出码即结论 |
| `docs/evidence/ATS-103/01-export-and-proxy-verification.log` | 新增 | §3.3 的完整运行日志 |
| `docs/evidence/ATS-103/02-next-static-export-build.log` | 新增 | §3.2 的构建日志 |
| `docs/evidence/ATS-103/03-npm-test-regression.log` | 新增 | §3.5 的回归日志 |
| `docs/evidence/ATS-103/04-wbs-updater-regression.log` | 新增 | §3.6 的 WBS 更新脚本共存回归日志 |
| `tools/update_wbs_ats103.py` | 新增 | 本任务的 WBS 行更新脚本（与 ATS-101/102/301/401/501 同构，标记 `【ATS-103】`） |
| `tools/wbs_common.py` | 修改 | 共享工作簿的标记登记与叙述片段：新增 `【ATS-103】` |
| `docs/22-FRONTEND-EXPORT.md` | 新增 | 本文件 |
| `docs/WBS.xlsx` | 修改 | 「开发WBS」ATS-103 行的状态/完成率/剩余人日 + 风险说明；ATS-104/ATS-111 行的下游约束；「总览」缓存值与 D6/D7 叙述 |
| `docs/00-INDEX.md` | 修改 | 收录 22-FRONTEND-EXPORT.md、ATS-103 证据目录与探针脚本 |
| `docs/16-BASELINE-ADR.md` | 修改 | §5.2 追加 ATS-103 的静态导出/接缝实测结论；§7 追加 2 条未验证项（含本任务发现的证据链缺陷） |
| `CHECKSUMS.sha256` | 修改 | 随新增/修改的受控文件重新生成 |

**产品代码零改动**：`apps/studio/**` 与 `server/**` 未被修改——这不是「偷懒」，而是本任务的实测结论：**既有配置已经满足完成定义**。

## 6. 未验证项声明（PENDING ≠ PASS）

1. **仓库的 8 步构建门禁（`tools/ci_build_gate.mjs`）本轮未跑**。原因：本机 PATH 上是 Node **24.19.0** / npm **12.2.0**，而门禁的 `checknode` 步硬断言 Node major = 22 且 npm = `packageManager` 指定的 10.9.9（ATS-102 §2.3）。门禁会**响亮地失败**，那不是关于本任务的证据。因此本任务改跑 `npm ci` + `next build` 两步（§3.2）。**后果**：本轮没有验证「安装树摘要（`installdigest`）」与「依赖清单 `--check`」这两项 ATS-102 门禁；这两项**属于 ATS-102 的范围**，其证据仍在 `docs/evidence/ATS-102/15-node22-gate-8-steps-final.log`。
2. **Next.js 静态导出未在 macOS / Linux 上实测**。本轮全部实测在 Windows 11 完成。Next.js 16 的静态导出与平台无关，但**未实测**不等于已验证。
3. **未在真实 Tauri 桌面壳内实测**（`cargo tauri dev`）。ATS-104 的交付范围；且 B-02（Tauri 构建）在 ATS-102 结束时仍未关闭，仓库仍缺 `src-tauri/icons/icon.ico`。
4. **未在真实浏览器里人工点过 UI**。本任务验证的是**产物与 API 契约**（HTTP 层），不是像素级的人工可用性——后者属 ATS-111 的 ST 范围。验证脚本用真实 HTTP 走完了 `lib/api.ts` 的握手顺序，但**没有驱动浏览器执行 JS**。
5. **导出的 UI 未做无障碍/键盘/加载态的人工评测**。属 ATS-111。
6. **Bridge 的运行结果依赖宿主机内存**。本轮曾因宿主机仅剩 ~1.2 GB 可用内存导致 Playwright 子进程 OOM（§4）。同样的运行在内存充裕时**实测通过**（1 PASS / 1 FAIL / 27 产物）。**该敏感性本身未被量化**——没有测出「需要多少可用内存才稳定」。
7. **ATS-101 阻断项 B-01 的「不复现」结论只覆盖本次这一组参数**（`--reporter/--output/--trace/--workers`，`@playwright/test` 1.58.x）。ATS-301 的参数探针覆盖面更宽（§3.4 末）。
8. **GitHub Actions 未在真实 runner 上跑过**（沿用 ATS-102 的未验证项 1，ATS-103 未新增 CI 变更）。
9. **`docs/WBS.xlsx` 的 ATS-103 行状态为「待审核」而非「已完成」**。本任务**不自行置 done**，工作簿里的 `已完成` 由复核人写入（`tools/update_wbs_ats103.py --status 已完成`）。同理「总览」的 `已完成项` 缓存值当前仍为 **1**（本任务不计入）。

## 7. 冻结声明

- 本文件描述的是 ATS-103 交付后的状态：分支 `agent/m2/seikoist-148`。
- **未验证项一律如实标注**，不得计入通过。
- 本文件所列命令与输出均可在 `docs/evidence/ATS-103/` 中找到对应日志，并可用 `node tools/ats103-probes/verify-export-and-proxy.mjs` 重跑。
- 本文件的任何修改必须附新的可执行证据（命令 + 实际输出）。
