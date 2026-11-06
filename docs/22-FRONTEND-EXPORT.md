# ATS-BL-003 Next.js 16 静态导出构建、路由与 API 代理验证（ATS-103 交付）

- 交付物：WBS ATS-103（S1 / v0.1.1，工作流「前端」，主责 FE），对应需求 FR-020、NFR-007
- 基线起点：commit `49fbafb`（`agent/m2/seikoist-148` 分支起点）；上游依据 `docs/16-BASELINE-ADR.md`（§5.2 静态导出 / §7 未验证项）、`docs/17-BUILD-CI.md`（ATS-102 交付）、`docs/03-BASIC-DESIGN.md` §1/§4、`docs/05-UI-UX.md`
- 本文件在 `dev` 合入后的分支上交付：`dev` 已用 `docs/21-CONTROL-PLANE-API.md` 占用 21 号，故本文件为 `docs/22-FRONTEND-EXPORT.md`
- 状态标记沿用仓库约定：`IMPLEMENTED` ＝ 代码能力存在；`DESIGNED` ＝ 仅设计。**本文件不得把设计中的能力称为已实现。**

## 1. 结论摘要

ATS-103 的验收标准是「**产出静态目录；127.0.0.1 Bridge 的会话/项目/运行操作成功**」。两项**均已在 Windows 11 实机实测通过**：

- IT（HTTP 层）：`tools/ats103-probes/verify-export-and-proxy.mjs` —— **25/25 项检查通过，退出码 0**
- ST（浏览器层）：`tools/ats103-probes/ui-smoke.mjs` —— **8/8 项检查通过，退出码 0**（真实 headless Chromium 驱动导出的那一页）

证据见 `docs/evidence/ATS-103/`。

| 验收项 | 结论 | 证据 |
|---|---|---|
| Next.js 16 静态导出构建 | **PASS** | `next build`（Next.js **16.4.5**，Turbopack）**构建成功**（编译/类型检查/静态页的用时数字随机器与负载浮动，**以日志为准**，见 `docs/evidence/ATS-103/02-next-static-export-build.log`）；产物 `apps/studio/out/`（`index.html` **12927 字节**、`404.html`、`_next/static/**`）；构建后工作区**不脏** |
| 导出产物的自洽性 | **PASS** | `index.html` 引用的 **8 个**资源全部存在于磁盘；导出目录的**真实文件树**里没有任何服务端路由产物（**声明了 `force-static` 的 handler 会被预渲染进 `out/api/**`，由这条断言拦截**，见 §2） |
| 导出页在运行时解析 API 基址 | **PASS** | **可执行判别**：导出页按主机名 `localhost` 打开，浏览器**实际**把 API 请求发往 `localhost:<port>`（运行时解析得到的是同源相对路径；构建期烘焙的绝对基址会发往数字地址）。静态启发式（bundle 里有对 `location.port` 的比较）是**必要不充分**的辅助信号，见 §2.1 |
| Bridge 提供导出页 | **PASS** | `GET /` → HTTP 200（**12927 字节**），带 CSP（`connect-src` 含 `http://127.0.0.1:4577`）；带哈希的 chunk 亦可取回（HTTP 200） |
| Bridge 会话操作 | **PASS** | `GET /api/session` 返回 token；**异源 Origin → 403**、**无 token → 401** |
| Bridge 项目操作 | **PASS** | `POST /api/projects` → 201；`GET /api/projects` → 200；`GET /api/projects/{id}/tests` → 2 个用例 |
| Bridge 运行操作 | **PASS** | `POST /api/projects/{id}/run` → **202**，随后到达终态 `failed`，**真实结果 1 PASS / 1 FAIL / 共 2 例**，采集 **28 个**证据产物（含 `report.json`、HTML 报告、每例 `trace.zip`）；API 报告的 summary 与磁盘上的 `report.json` **逐项一致** |
| **ST：真实浏览器驱动导出的 UI** | **PASS** | headless Chromium 打开导出的页面，页面自身的 `/api/session` → 200；点「添加项目」→ toast「项目添加成功」、目录列出 2 个用例；点「运行全部」→ 202 → 终态 `failed`（2 例 / 28 产物）；**console error 0 条、无失败请求**；同源与白名单跨源（`127.0.0.1:3000`）**两种来源都跑通** |

**本次交付没有改动产品代码。** `apps/studio/next.config.mjs`、`app/page.tsx`、`lib/api.ts` 与 `server/index.mjs` 全部保持 ATS-102 交付时的状态——实测证明这套配置**已经**满足本任务的完成定义（静态导出可用、路由可用、Bridge 三类操作可用）。本任务交付的是**可复跑的验证脚本 + 证据 + 结论文档**，以及两处**它发现的真实缺陷**（见 §4）。

## 2. 「API 代理」在静态导出下的真实形态

这是本任务最容易被误写的点，因此单列一节。

`next.config.mjs` 声明 `output: 'export'`。该模式下 Next.js **不产出任何服务端**：没有 API Routes、没有 SSR、没有 Node 中间件。因此**不存在「Next.js 代理」**——导出目录里没有可以转发 `/api/*` 的代码。

这一点有两层证据，验证脚本两层都断言：

1. **Next.js 在该模式下于构建期拒绝 route handler——但只拒绝未声明 `force-static` 的那一种。** 实测新增 `apps/studio/app/api/session/route.ts`（未声明 `force-static`）后 `next build` 失败：

   ```
   Error: export const dynamic = "force-static"/export const revalidate not configured on route
   "/api/session" with "output: export".
   Error: Failed to collect page data for /api/session
   ```

   报错原文本身就写着 `dynamic = "force-static" … not configured`：**被拒绝的只是未声明 `force-static` 的 handler**。声明了 `export const dynamic = 'force-static';` 的 handler **照常构建成功**，输出为 `○ /api/session`，并被**预渲染成静态文件** `out/api/session` 进入导出目录。

   因此**「服务端路由连构建都过不去」只对未声明 `force-static` 的形状成立**。完整日志见 `docs/evidence/ATS-103/06-mutation-evidence.log`（变异 A 与变异 A′）。

2. **导出目录的真实文件树里没有服务端路由产物。** 这一层才是真正的保证，**它拦得住上面那两种形状**——尤其是声明了 `force-static` 的那一种。验证脚本遍历 `apps/studio/out` 的**每一个文件与目录**，而不是去检查 Next 从不写出的两个路径（`out/app/api`、`out/.next/server`）——后者是永远不会失败的空转断言。断言本身：

   ```
   PASS  the export contains no server-side API route output  --  25 exported entries, none of them a server route
   ```

   变异 A′（声明 `force-static` 的 handler）实测让**这一条**变红：

   ```
   FAIL  the export contains no server-side API route output  --  found: api/session
   RESULT: FAILED -- 24/25 checks passed.
   ```

   而变异 A（未声明 `force-static`）是**构建期就失败**、导出根本没生成——它证明的是「构建被拒绝」，**没有**执行到这段遍历逻辑。两者证明的是**不同的东西**，不能互相顶替。

产品设计的代理形态是**跨源直连**（`docs/03-BASIC-DESIGN.md` §1：Next.js 16 静态导出 → token 鉴权的 localhost HTTP → Node 22 Local Bridge）：

1. 页面由 Bridge 自身在 `127.0.0.1:4577` 提供（`server/index.mjs` 的 `staticFile()` 把 `apps/studio/out` 当静态根目录）；
2. `apps/studio/lib/api.ts` 的 `root()` 在运行时决定 API 基址：**端口是 4577 时用同源空串**（即 `/api/...`），否则用绝对地址 `http://127.0.0.1:4577`；
3. 请求带上 `X-ATS-Token` 会话令牌；Bridge 的 `ORIGINS` 白名单与 `checkedRequest()` 负责 Origin/Host 校验。

### 2.1 基址是运行时解析的——如何被证明，以及静态启发式的边界

这个结论由**两条证据**承担，它们的**能力不同**，必须分开说。

**（1）静态启发式（HTTP 探针，必要不充分）。** 验证脚本断言导出的 bundle **读取并比较** `window.location.port`：

```
PASS  the shipped bundle carries a comparison of the page location port  --  reads location.port: true, compares it: true, references /api/session: true
```

**它证明的只是「bundle 里存在一个对 `location.port` 的比较」，不证明那个比较就是选基址的那一步。** 反例 B2：`root()` 被写死成绝对地址，同时在页脚另留一个**无关的** `location.port` 比较——这个 bundle 与诚实 bundle 在静态检查下**无法区分**，重新构建后这条断言**仍然绿**（25/25，退出码 0，`docs/evidence/ATS-103/06-mutation-evidence.log` 的变异 B2）。

这条断言与「基址没有在构建期烘焙」原本是**同一个谓词的两面**（`readsLocation && comparesPort`），所以现在**只断言一次**：再断言一次就是同一个检查报两遍，读起来像两件独立的证据。

**（2）可执行判别（ST 探针，真正的证明）。** `tools/ats103-probes/ui-smoke.mjs` 把导出页按**主机名** `http://localhost:<port>/` 打开（不是数字地址），并记录浏览器**实际**请求到的 host：

```
PASS  the page's API requests go to the host its own location implies  --  page location host: localhost:4577; API request hosts: localhost:4577
```

产品的 `root()` 在页面位于 Bridge 自身端口时返回**空串**（相对路径），浏览器于是按页面自身 origin 解析，请求去 `localhost:<port>`；而**构建期烘焙**的基址是**绝对地址**，请求去**数字地址**。两者可区分，且这个判别是**执行出来的**，无法被一个只是「提到端口」的 bundle 满足。

两个变异都让它变红：

| 变异 | 静态启发式 | 可执行判别 |
|---|---|---|
| **B**（基址写死，bundle 里没有端口比较） | **红** | **红** |
| **B2**（基址写死**且**留一个无关的端口比较） | **绿**（这就是它的边界） | **红** |

所以准确的表述是：

> **「基址在运行时解析」由可执行判别证明。** 静态启发式只是一个辅助信号——它能抓住「完全不读端口」的那种烘焙，**证明不了** `root()` 本身是在运行时解析的。

### 2.2 可用的来源只有 Origin 白名单内的那些

**「任何静态文件服务器都能提供这份导出」是不成立的**（第一轮复核 C5(a) 的反例已推翻该说法）。实测：用 `python -m http.server 8931` 提供 `out/`，而 Bridge 在 4577，Bridge 对 Origin `http://127.0.0.1:8931` 返回 **403**（预检 OPTIONS 同样 403），浏览器报 `ERR_FAILED`，UI 提示「Failed to fetch」。

**准确的说法是**：这份导出可以被**任意静态服务器**提供，但**只有当页面的 Origin 落在 Bridge 的白名单里**时，它对 Bridge 的 API 调用才会被接受。当前白名单是 `localhost`/`127.0.0.1` 的 **4577**（Bridge 自身）与 **3000**（Next 开发服务器）、以及 `tauri://localhost` / `http://tauri.localhost` / `https://tauri.localhost`（`server/index.mjs:31`）。ST 探针因此在**同源（4577）**与**白名单跨源（3000）**两种来源下各跑了一遍，**两种都通过**；而 8931 那种白名单外的来源，Bridge 侧返回 403，是**设计行为**，不是缺陷。

### 2.3 非默认端口上真实 UI 不可用

**Bridge 在非默认端口时，导出页的 API 调用是不可用的**——导出页的基址解析与 Bridge 的 CSP 都指向默认端口 4577（`docs/16-BASELINE-ADR.md` §3.1 第 2 条已登记该限制）。实测 `ATS_PORT=4600` 时，Bridge 提供它自己的导出页，页面却去请求 `127.0.0.1:4577/api/session`，得到 `ERR_CONNECTION_REFUSED`。

因此**两个探针的默认端口都是 Bridge 自己的默认端口**（由 `tools/ats103-probes/lib/default-port.mjs` 从产品源码 `server/index.mjs` 读出，探针自身不写端口字面量）。在**非默认端口**上运行时，探针会在结论里明写「这只验证了 API 接缝，不等于 UI 可用」，不会把一个真实 UI 不可用的配置报成通过。

## 3. 实测（IT / ST）

### 3.1 环境

| 项 | 值 |
|---|---|
| OS | Windows 11（x64） |
| Node | **v22.23.4**（`D:/hermes-multica/home/cache/scratch/node22/node-v22.23.4-win-x64`） |
| npm | **10.9.9**（随上述 Node 附带） |
| Next.js | 16.4.5（Turbopack） |
| 夹具 | `examples/sample-playwright`（真实 Playwright **1.64.1** + 真实 Chromium） |

> 本轮用的是仓库门禁 `tools/ci_build_gate.mjs` 所要求的 Node 22 / npm 10.9.9，**构建门禁已整条跑通**（见 §3.7），不再是「未验证」。

### 3.2 静态导出构建（ST-021）

```
$ npm --prefix apps/studio ci --no-audit --no-fund
$ npm --prefix apps/studio run build
▲ Next.js 16.4.5 (Turbopack)
✓ Compiled successfully
  Running TypeScript ...
  Finished TypeScript ...
✓ Generating static pages using 4 workers (3/3)

Route (app)
┌ ○ /
└ ○ /_not-found
○  (Static)  prerendered as static content
```

**这一段刻意不写用时数字。** `next build` 的编译耗时、类型检查耗时、装包耗时都**随机器与负载浮动**，写死在文档里的数字在重新采集证据后就会与日志对不上——这正是把文档与日志绑死在具体数值上的代价。所以这里只保留**稳定的部分**（版本号、产物形态、路由清单），**用时数字以 `docs/evidence/ATS-103/02-next-static-export-build.log` 为准**：那份日志是逐字记录的实际输出，且日志头部写着它采集自哪个 commit。

构建后，`git status --short -- apps/studio/next-env.d.ts apps/studio/tsconfig.json` **没有任何输出**——`next build` 对这两个受版本控制的文件的改写是**幂等**的（ATS-102 §6.2 的结论在本分支上依然成立）。日志里同时还记了**整个工作区**的 `git status`；那份输出里可能有别的条目（本次采集时是本文件与该日志本身），所以**上面这条断言说的是那两个具体文件，不是「工作区完全干净」**。

> **本轮的门禁已跑通**：用 Node **22.23.4** / npm **10.9.9** 在最终树上跑了 `node tools/ci_build_gate.mjs`，结果 **每一步都通过**（见 §3.7）。前提是先在 `examples/sample-playwright` 执行 `npm install`。

### 3.3 导出产物 + Bridge + API 全链（IT）

```
$ node tools/ats103-probes/verify-export-and-proxy.mjs
PASS  export directory exists (apps/studio/out)
PASS  export contains index.html  --  12927 bytes
PASS  export contains 404.html
PASS  export contains _next/static assets
PASS  the export contains no server-side API route output  --  25 exported entries, none of them a server route
PASS  every asset referenced by index.html exists on disk (8 assets)
PASS  the shipped bundle carries a comparison of the page location port  --  reads location.port: true, compares it: true, references /api/session: true
PASS  bridge boots and answers /api/health
PASS  bridge serves the exported index.html at /  --  HTTP 200, 12927 bytes
PASS  the served page carries a CSP that allows the API origin  --  connect-src allows 127.0.0.1:4577
PASS  the bridge serves the exported chunk /_next/static/chunks/07zxw0h7jdqcq.js  --  HTTP 200
PASS  GET /api/session returns a token
PASS  a foreign Origin is rejected (403)  --  HTTP 403
PASS  an unauthenticated API call is rejected (401)  --  HTTP 401
PASS  GET /api/projects succeeds with the session token
PASS  POST /api/projects registers the sample Playwright project  --  HTTP 201
PASS  GET /api/projects/{id}/tests returns the static index  --  2 tests
PASS  POST /api/projects/{id}/run is accepted (202)  --  HTTP 202
PASS  the accepted run reaches a passed/failed terminal state  --  status=failed
PASS  the terminal run reports a per-case result set  --  2 cases
PASS  the terminal run summary matches the on-disk report.json  --  summary and report.json agree (1/1/0/0/2)
PASS  the terminal run collected artefacts  --  27 artefacts
PASS  the collected artefacts include report.json  --  1 report.json entries
PASS  GET /api/runs lists the run history  --  1 runs
PASS  the probe executed every registered check  --  25/25 checks executed

RESULT: OK -- 25/25 checks passed.
```

完整日志：`docs/evidence/ATS-103/01-export-and-proxy-verification.log`。

**「summary 与 report.json 一致」这条不是恒真断言。** 探针读出 Bridge 落盘的 `report.json`，按 Playwright 报告的结构重算每状态计数，再与 API 报告的 summary 逐项比对（`passed`/`failed`/`skipped`/`flaky`/`total` 五项全比）。引擎崩溃时 `report.json` 不存在，这条**判 FAIL**。

### 3.3.1 真实浏览器驱动导出的 UI（ST）

```
$ node tools/ats103-probes/ui-smoke.mjs
PASS  the exported page loads in a real browser  --  HTTP 200, http://localhost:4577/
PASS  the page's own session call succeeds  --  GET /api/session -> 200, GET /api/session -> 200
PASS  the page's API requests go to the host its own location implies  --  page location host: localhost:4577; API request hosts: localhost:4577
PASS  adding a project through the UI registers it and lists the catalog  --  toast=项目添加成功：未修改原仓库, catalog items=2
PASS  running through the UI reaches a terminal state  --  toast=已提交到本地 Playwright Runner, status=failed
PASS  the UI started the run the Bridge reports  --  status=failed, 2 cases, 28 artefacts
PASS  the page produced no console error and no failed request  --  console errors: none; failed requests: none
PASS  the probe executed every registered check  --  8/8 checks executed

RESULT: OK -- 8/8 checks passed.
```

**白名单跨源**（把导出页放在 `127.0.0.1:3000`，Bridge 在 4577）：

```
$ node tools/ats103-probes/ui-smoke.mjs --page-origin http://127.0.0.1:3000
... RESULT: OK -- 8/8 checks passed.
```

完整日志：`docs/evidence/ATS-103/05-ui-smoke-browser.log` 与 `05b-ui-smoke-cross-origin.log`。

### 3.3.2 变异证据（每条保留下来的断言都必须会变红）

```
$ bash tools/ats103-probes/mutation-evidence.sh
```

| 变异 | 被破坏的断言 | 结果 |
|---|---|---|
| **A** 新增 `apps/studio/app/api/session/route.ts`（**未声明** `force-static`） | 「构建拒绝 route handler」 | `next build` **构建期即失败**（`output: export` 不允许未声明 `force-static` 的 handler），**导出根本没生成**。它证明的是**构建被拒绝**，**没有**执行到文件树遍历那段逻辑 |
| **A′** 同一个 handler，**声明** `export const dynamic = 'force-static';` | 「导出不含服务端路由产物」 | 构建**成功**，handler 被**预渲染**成静态文件 `out/api/session`；断言**变红**：`FAIL the export contains no server-side API route output -- found: api/session`，探针退出码 1 |
| **B** `lib/api.ts` 的 `root()` 改成构建期常量 | 静态启发式「bundle 里有对 `location.port` 的比较」+ 可执行判别「页面的 API 请求去页面自身 origin 隐含的 host」 | **两条同时变红**，探针退出码 1 |
| **B2** 基址写死**且** bundle 里留一个**无关的** `location.port` 比较 | 可执行判别（静态启发式**抓不到**它） | 静态启发式**仍然绿**（25/25，退出码 0）——这是它的边界；**可执行判别变红**（`API request hosts: 127.0.0.1:4577`，页面 origin 是 `localhost:4577`），退出码 1 |
| **C** 移走夹具 `node_modules`（引擎缺失） | 「run 到达 passed/failed 终态」「每例结果非空」「summary 与 report.json 一致」「产物非空」 | **四条同时变红**，探针退出码 1 |

**每个变异只隔离一件事**：B 结束后脚本先把源码还原并**重建**一份干净的导出，再跑 B2、再跑 C——否则后面的日志里会同时出现前面变异造成的基址解析失败，看不出是哪一条变异破坏了哪个断言。

**A 与 A′ 证明的是不同的东西，不能互相顶替**：A 之所以整篇变红，是因为 Next.js 在**构建期**就拒绝了那个 handler，导出根本没生成——它**没有**执行到「遍历导出目录的每个文件」这段逻辑；A′ 才是让**那段逻辑**变红的形状（构建成功、handler 进入 `out/api/**`）。

变异**临时**改动产品源码（`apps/studio/lib/api.ts`、新增 `apps/studio/app/api/`、移走夹具 `node_modules`）。脚本用 `trap` 在退出时**还原全部改动并重建导出**，备份与暂存目录都写在**仓库之外**的临时目录里，因此不会出现在 `git status` 里。

完整日志：`docs/evidence/ATS-103/06-mutation-evidence.log`。

### 3.4 真实运行的结果（不是双桩）

`examples/sample-playwright` 夹具被**真实安装**（`npm install` → `@playwright/test` 1.64.1），真实 Chromium 被真实拉起。夹具本身是**故意一成一败**的（见 `examples/sample-playwright/tests/home.spec.ts` 的注释）：

| 用例 | 结果 | 说明 |
|---|---|---|
| `首页响应正常 @REQ-001` | **passed** | `page.setContent` + `toHaveText('hello')` |
| `导航入口正常 @REQ-002` | **failed** | 故意断言不匹配，`element(s) not found` |

采集到的 28 个证据产物包含：`report.json`、HTML 报告（`html/index.html`）、每例的 `trace.zip`、以及 `results/**/error-context.md`。

> 这次运行同时**实测确认了 ATS-101 的阻断项 B-01 已不复现**：Bridge 传给 CLI 的参数向量是 `--reporter=line,json,html --output <dir> --trace on --workers 1`，全部是 `playwright test --help` 声明过的选项（ATS-301 的探针式构造），真实运行产出了真实 summary 与真实产物——这正是 B-01 修复后的应有形态。

### 3.5 回归（UT/IT）

```
$ npm test
ℹ fail 0
ℹ cancelled 0
ℹ skipped 5
```

退出码 **0**，**0 失败**。用例总数随 dev 上的合并持续变化，所以这里**不写死总数**；**当次的真实数字以 `docs/evidence/ATS-103/03-npm-test-regression.log` 为准**（那里记的是本次采集的实际输出）。

> **测试数为什么是 774**：本任务**未改动任何被测代码**，只新增了独立探针脚本（不在 `tests/` 下，不参与 `npm test`）。测试总数由仓库里已合入的其他任务决定；这一轮的数字随 dev 上的合并持续变化，**当次的真实数字以 `03-npm-test-regression.log` 为准**——那里记的是本次采集的实际输出。
>
> **关于 skipped**：跳过的用例是 ATS-301 的引擎 IT，它们在夹具的 `node_modules` **缺失**时才跳过；本轮夹具**已被真实安装**，因此它们**跑起来了**并计入 pass。

### 3.6 WBS 更新脚本共存回归

本任务新增了 `tools/update_wbs_ats103.py`，它与既有的其他 `tools/update_wbs_*.py` **共用同一份 `docs/WBS.xlsx`**。因此跑了仓库既有的两项共享工作簿回归（**当次参与回归的更新器共 18 个**，逐个列在 `04-wbs-updater-regression.log` 的头部）：

```
$ python tools/test_wbs_common.py
...
PASS the declared markers are exactly MARKERS

all checks passed

$ bash tools/ats501-probes/check-wbs-updaters.sh
updaters  : tools/update_wbs_ats101.py tools/update_wbs_ats101_done.py tools/update_wbs_ats102.py tools/update_wbs_ats103.py tools/update_wbs_ats201.py tools/update_wbs_ats202.py tools/update_wbs_ats205.py tools/update_wbs_ats206.py tools/update_wbs_ats207.py tools/update_wbs_ats208.py tools/update_wbs_ats212.py tools/update_wbs_ats301.py tools/update_wbs_ats401.py tools/update_wbs_ats501.py tools/update_wbs_ats506.py tools/update_wbs_ats512.py tools/update_wbs_ats601.py tools/update_wbs_ats601_rtm.py
updater # : 18 (discovered from tools/update_wbs_*.py)
...
  PASS  the 18 updaters produce the same sheet in either order
  PASS  running the 18 updaters twice changes nothing
  PASS  the cached 总览 values equal the values derived from 开发WBS
  PASS  every marked note of the baseline is still in the sheet
  PASS  D6 and D7 still carry every task's contribution

RESULT: OK -- the 18 WBS updaters coexist, are idempotent, do not undo
        an accepted review, and the 总览 cache always matches 开发WBS.
```

退出码 **0**。关键点：探针脚本的更新器清单是**从 `tools/update_wbs_*.py` 自动发现**的，因此新脚本一落地就被覆盖，不需要改动探针。**清单本身随 dev 上的合并持续变化**——当次参与回归的是哪几个，以 `04-wbs-updater-regression.log` 头部那行 `updaters` 为准。

完整日志：`docs/evidence/ATS-103/04-wbs-updater-regression.log`。

### 3.7 仓库的构建门禁

用仓库门禁要求的 Node **22.23.4** / npm **10.9.9**，在最终树上跑：

```
$ node tools/ci_build_gate.mjs
...
RESULT: OK -- every build-gate step passed.
```

前提：先在 `examples/sample-playwright` 执行 `npm install`（夹具依赖）。门禁的**步数**随 dev 上的改动变化；当次跑了哪几步、每步的结论，逐条记在 `09-ci-build-gate.log` 里，末尾那一行 `RESULT: OK -- every build-gate step passed.` 就是总结论。完整日志：`docs/evidence/ATS-103/09-ci-build-gate.log`。

### 3.8 端口审计与 ADR 引用校验

本任务引入的探针脚本**必须不破坏** ATS-101 的端口审计（C1）。为此：

- 两个探针的默认端口**从产品源码 `server/index.mjs` 读出**（`tools/ats103-probes/lib/default-port.mjs`），探针自身**不写端口字面量**；
- `docs/16-BASELINE-ADR.md` §3.1 的 (c) 类统计口径按实测更新。

```
$ node tools/ats101-probes/scenario-d-port-audit.mjs
...
RESULT: OK -- every hardcoded occurrence is listed in 16 §3.1, by position.

$ python tools/check_adr_citations.py
... OK
```

完整日志：`docs/evidence/ATS-103/07-port-audit.log` 与 `08-adr-citations.log`。

### 3.9 在**克隆出来的**交付分支上复跑

上面的各项都是在工作区跑的。门禁与校验脚本面对的是**已提交**的文件，所以它们在**两份克隆**里各跑一遍：一份按 Windows 默认检出（CRLF），一份用 `git -c core.autocrlf=false clone` 检出（LF）。两份克隆都指向**同一个提交**。

```
$ bash tools/ats103-probes/verify-r4.sh <clone-dir> <label>
```

两份克隆的结论**逐项相同**：

| 项 | CRLF clone | LF clone |
|---|---|---|
| `verify_checksums.py` | **OK**（484 条，0 处失配） | **OK**（484 条，0 处失配） |
| ATS-101 端口审计 | **OK** | **OK** |
| `check_adr_citations.py` | **OK** | **OK** |
| `check-wbs-updaters.sh` | **OK**（18 个更新器） | **OK**（18 个更新器） |
| `npm test` | **0 失败** | **0 失败** |

完整日志：`docs/evidence/ATS-103/10-r4-clone-verification-crlf.log` 与 `10-r4-clone-verification-lf.log`（两份日志的头部记着各自的 commit 与 `core.autocrlf` 取值）。

## 4. 本次交付发现的两个真实缺陷（不属于 ATS-103 的修复范围）

### 4.1 引擎进程异常死亡 → run 标成 `failed` 却没有任何 summary

**现象**：当宿主机内存紧张时，Bridge 的运行记录**只有终态，没有结果**。

**实测**：第一次运行探针时，`POST .../run` 返回 202，随后 `GET /api/runs/{id}` 报 `status=failed` 但 `summary=null`、`artifacts=[]`。抓到的运行日志尾部显示真实原因是**子进程 OOM**：

```
FATAL ERROR: Zone Allocation failed - process out of memory
```

**根因（读代码定位）**：`server/index.mjs` 的 `finishRun()` 在**同一个同步调用**里依次完成「置终态 → `adapter.collect()` → `filesInRun()` → `saveState(store)`」，中间**没有 await**：

```js
run.status = cancelled ? 'cancelled' : code === 0 ? 'passed' : 'failed';
// ... 同一个同步调用内继续 adapter.collect() 与 filesInRun()
```

因此**不存在**「先呈现终态、后补齐结果」的时间窗口——任何读者都观察不到中间状态；内存中的 `store` 与持久化副本也是一致的。本轮之所以读到 `summary=null`，真实原因是**子进程因 OOM 崩溃，`adapter.collect()` 找不到 `report.json`**，于是 summary 真的为空。

**结论与归属**：这**不是** ATS-103 的前端缺陷，也不是 `next build` 的问题——它是一条**已存在的运行期证据链缺陷**：当引擎进程异常死亡时，Bridge 会把 run 标成 `failed` 却没有任何 summary，用户在 UI 上看到的是「失败」而没有任何可诊断的原因（`run.error` 为空，真实原因只存在于被截断的 `run.log` 里）。这与 `docs/16-BASELINE-ADR.md` §7 第 10 条登记的「异常死亡 → `failed` 且无 summary、无 error」是**同一条**。

- **本任务不修它**：修复它会改动 `server/index.mjs` 的运行期语义与状态机，属于 `server/index.mjs` 的所有者（ATS-108「取消/超时/子进程树回收」或 ATS-112「保存的原子替换」）的范围，不是前端静态导出的范围。本任务按设计文档 §5「状态机的终态判定」只**如实记录**。
- **已在本文件 §6 登记为未验证项/已知缺陷**，并**同步写进 `docs/WBS.xlsx` 的 ATS-103 风险/说明列**，让下游 ATS-111（UI 可用性）与 ATS-108 都能看到。

### 4.2 Bridge 不解析 trailing-slash 目录，且「未构建」的提示语会误导

**现象**：`next.config.mjs` 的 `trailingSlash: true` 会导出 `out/_not-found/index.html` 与 `out/404/index.html`，但 Bridge 的 `staticFile()` **不把 `/x/` 解析成 `/x/index.html`**，未知路径也**不返回导出的 `404.html`**，而是返回一段 `text/plain`：

```
GET /nope/         -> 404  UI not built. Run npm --prefix apps/studio install && npm run build:web. A standalone fallback is available at /fallback.html
GET /_not-found/   -> 404  同上
```

**问题**：这条提示语**误导**——在 UI **已构建**的情况下，未知路径返回的却是「UI not built」。当前只有 `/` 一个路由，用户还感知不到；但**任何新增路由在 Bridge 下都会 404**。

**结论与归属**：这是 **Bridge 的静态路由能力缺口**，不在 ATS-103 的前端导出范围内。

- **本任务不修它**：修 `staticFile()` 属于产品代码改动，按 UQH 流程须**设计先行**，不在本任务范围。
- **本任务把「路由可用」的范围收窄为「仅 `/`」**，并把该缺陷**登记到 `docs/16-BASELINE-ADR.md` §7**（未验证项/缺陷表）与 `docs/WBS.xlsx` 的 ATS-103 风险列，指明归属为 Bridge 侧。

### 4.3 本次交付对这两条缺陷做的唯一改动：断言改为非恒真

旧版探针有一条名为「a failed/error run never reports a fabricated summary」的断言，其实现是 `passed||failed ? !!summary : true`——`error` 一律放行，且**永远检测不到伪造的 summary**；在 §4.1 描述的崩溃场景（`failed` 且无 summary）下它反而会 FAIL，与旧文档「如实反映 `summary=none`」的说法自相矛盾。

本轮把它换成一条**真正可判**的断言：**summary 必须与磁盘上的 `report.json` 逐项一致**（§3.3）。引擎崩溃（无 `report.json`）时该断言**判 FAIL**，探针退出码 1；变异 C 的实测证明（§3.3.2）它确实会红。

## 5. 交付物清单

| 路径 | 类型 | 内容 |
|---|---|---|
| `tools/ats103-probes/verify-export-and-proxy.mjs` | 新增 | **25 项**检查的 IT 验证脚本（静态导出 → Bridge → API 全链），可重复执行，退出码即结论；检查项数是常量，缺项即 FAIL |
| `tools/ats103-probes/ui-smoke.mjs` | 新增 | **8 项**检查的 ST 验证脚本：在真实 headless Chromium 里驱动导出的那一页（会话 → 添加项目 → 运行到终态），断言 console error 为 0；同时是「基址在运行时解析」的**可执行判别**（页面按主机名 `localhost` 打开，记录 API 请求实际去的 host） |
| `tools/ats103-probes/lib/default-port.mjs` | 新增 | 从产品源码 `server/index.mjs` 读出 Bridge 的默认端口（探针自身不写端口字面量） |
| `tools/ats103-probes/mutation-evidence.sh` | 新增 | 五个变异（A 未声明 `force-static` 的路由 / A′ 声明了 `force-static` 的路由 / B 构建期烘焙基址 / B2 烘焙基址+无关端口比较 / C 引擎缺失）的证据脚本 |
| `tools/ats103-probes/collect-evidence.sh` | 修改 | 证据收集：构建、IT、ST、跨源 ST、变异、`npm test`、WBS 共存回归、**端口审计**、**ADR 引用校验**、**构建门禁** |
| `docs/evidence/ATS-103/01-export-and-proxy-verification.log` | 新增 | §3.3 的完整运行日志 |
| `docs/evidence/ATS-103/02-next-static-export-build.log` | 新增 | §3.2 的构建日志 |
| `docs/evidence/ATS-103/03-npm-test-regression.log` | 新增 | §3.5 的回归日志 |
| `docs/evidence/ATS-103/04-wbs-updater-regression.log` | 新增 | §3.6 的 WBS 更新脚本共存回归日志 |
| `docs/evidence/ATS-103/05-ui-smoke-browser.log` | 新增 | §3.3.1 的 ST 日志（同源） |
| `docs/evidence/ATS-103/05b-ui-smoke-cross-origin.log` | 新增 | §3.3.1 的 ST 日志（白名单跨源 `127.0.0.1:3000`） |
| `docs/evidence/ATS-103/06-mutation-evidence.log` | 新增 | §3.3.2 的五个变异证据 |
| `docs/evidence/ATS-103/07-port-audit.log` | 新增 | ATS-101 端口审计的输出（`RESULT: OK`） |
| `docs/evidence/ATS-103/08-adr-citations.log` | 新增 | ADR 引用校验的输出 |
| `docs/evidence/ATS-103/09-ci-build-gate.log` | 新增 | 构建门禁的输出（末尾 `RESULT: OK -- every build-gate step passed.`） |
| `docs/evidence/ATS-103/10-r4-clone-verification-crlf.log` | 新增 | 在**CRLF 克隆**里复跑 R4 要求的各项（校验和、端口审计、ADR 引用、WBS 更新器、`npm test`）的输出 |
| `docs/evidence/ATS-103/10-r4-clone-verification-lf.log` | 新增 | 同一组检查在 **LF 克隆**（`core.autocrlf=false`）里的输出 |
| `tools/ats103-probes/verify-r4.sh` | 新增 | 在克隆出来的交付分支上复跑上述各项的脚本 |
| `tools/update_wbs_ats103.py` | 修改 | 本任务的 WBS 行更新脚本（与 ATS-101/102/301/401/501 同构，标记 `【ATS-103】`）：备注同步为本轮的真实结论 |
| `tools/wbs_common.py` | 修改 | 共享工作簿的标记登记与叙述片段：新增 `【ATS-103】` |
| `docs/22-FRONTEND-EXPORT.md` | 新增 | 本文件 |
| `docs/WBS.xlsx` | 修改 | 「开发WBS」ATS-103 行的状态/完成率/剩余人日 + 风险说明；ATS-104/ATS-111 行的下游约束；「总览」缓存值与 D6/D7 叙述 |
| `docs/00-INDEX.md` | 修改 | 收录 22-FRONTEND-EXPORT.md、ATS-103 证据目录与探针脚本 |
| `docs/16-BASELINE-ADR.md` | 修改 | §3.1 的 (c) 类统计口径按实测更新；§5.2 追加 ATS-103 的静态导出/接缝实测结论；§7 追加未验证项与 Bridge 静态路由缺陷 |
| `CHECKSUMS.sha256` | 修改 | 随新增/修改的受控文件重新生成 |

**产品代码零改动**：`apps/studio/**` 与 `server/**` 未被修改——这不是「偷懒」，而是本任务的实测结论：**既有配置已经满足完成定义**。（变异脚本会临时改动 `apps/studio/lib/api.ts` 并新增 `apps/studio/app/api/`，但**每次都在结束时还原**，日志末尾记录了还原后的 `git status`；那份输出里**没有 `apps/studio/**` 或 `server/**` 的条目**。）

## 6. 未验证项声明（PENDING ≠ PASS）

1. **Next.js 静态导出未在 macOS / Linux 上实测**。本轮全部实测在 Windows 11 完成。Next.js 16 的静态导出与平台无关，但**未实测**不等于已验证。
2. **未在真实 Tauri 桌面壳内实测**（`cargo tauri dev`）。ATS-104 的交付范围；且 B-02（Tauri 构建）在 ATS-102 结束时仍未关闭，仓库仍缺 `src-tauri/icons/icon.ico`。
3. **未做人工可用性评测**。本轮的 ST 探针是**脚本驱动**的真实浏览器（会话 → 添加项目 → 运行到终态、console error 为 0），但**无障碍/键盘/加载态的人工评测**仍属 ATS-111。
4. **Bridge 的运行结果依赖宿主机内存**。本轮曾因宿主机仅剩 ~1.2 GB 可用内存导致 Playwright 子进程 OOM（§4.1）。同样的运行在内存充裕时**实测通过**（1 PASS / 1 FAIL / 27 产物）。**该敏感性本身未被量化**——没有测出「需要多少可用内存才稳定」。
5. **ATS-101 阻断项 B-01 的「不复现」结论只覆盖本次这一组参数**（`--reporter/--output/--trace/--workers`，`@playwright/test` 1.64.1）。ATS-301 的参数探针覆盖面更宽（§3.4 末）。
6. **GitHub Actions 未在真实 runner 上跑过**（沿用 ATS-102 的未验证项 1，ATS-103 未新增 CI 变更）。
7. **`docs/WBS.xlsx` 的 ATS-103 行状态为「待审核」而非「已完成」**。本任务**不自行置 done**，工作簿里的 `已完成` 由复核人写入（`tools/update_wbs_ats103.py --status 已完成`）。同理「总览」的 `已完成项` 缓存值当前仍为 **1**（本任务不计入）。
8. **Bridge 的静态路由只覆盖 `/`**：trailing-slash 目录与未知路径不解析、不返回导出的 `404.html`，且提示语误导。属 Bridge 侧缺陷，见 §4.2 与 `docs/16-BASELINE-ADR.md` §7。

## 7. 冻结声明

- 本文件描述的是 ATS-103 交付后的状态：分支 `agent/m2/seikoist-148`。
- **未验证项一律如实标注**，不得计入通过。
- 本文件所列命令与输出均可在 `docs/evidence/ATS-103/` 中找到对应日志，并可用 `node tools/ats103-probes/verify-export-and-proxy.mjs`、`node tools/ats103-probes/ui-smoke.mjs`、`bash tools/ats103-probes/mutation-evidence.sh` 重跑。
- 本文件的任何修改必须附新的可执行证据（命令 + 实际输出）。