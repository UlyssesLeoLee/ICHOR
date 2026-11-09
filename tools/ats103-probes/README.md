# ATS-103 验证脚本（Static export → Bridge → API 全链）

本目录是 ATS-103（SEIKOIST-148）「Next.js 16 静态导出构建、路由与 API 代理验证」
所依据的**可重跑验证脚本**。对应的实际输出记录在 `docs/evidence/ATS-103/`，
结论文档是 `docs/22-FRONTEND-EXPORT.md`。

## 各脚本对应什么结论

| 脚本 | 结论 | 文档位置 |
|---|---|---|
| `verify-export-and-proxy.mjs` | **25 项**检查全部通过：(a) 静态导出产物自洽——`index.html`/`404.html`/`_next/static` 齐备，`index.html` 引用的 8 个资源全部存在；(b) 导出目录**不含任何服务端路由产物**——断言直接扫过导出目录的**真实文件树**，因此新增 `app/api/**` 时它会真的变红（变异证据见 `docs/evidence/ATS-103/06-mutation-evidence.log`）；(c) 导出产物里带着**对 `location.port` 的比较**（**静态启发式**：能抓住「完全不读端口」的烘焙，**证明不了** `root()` 本身是在运行时解析的——反例见下 B2）；(d) Bridge 能在 `/` 提供该导出并带上允许 API 源的 CSP，哈希 chunk 亦可取回；(e) 会话/项目/运行三类操作实测成功——异源 Origin 403、无 token 401、`POST /api/projects` 201、`GET .../tests` 返回 2 个用例、`POST .../run` 返回 202 并最终到达终态；(f) 真实运行的 **summary 与磁盘上的 `report.json` 逐项一致**、每例结果集非空、证据产物非空——不是「不伪造」这种恒真断言 | 22 §1/§2/§3.3/§3.4 |
| `ui-smoke.mjs` | **8 项**检查全部通过：在**真实 headless Chromium** 里驱动**导出的那一页**执行它自己的 JS，走完会话 → 添加项目 → 运行到终态，并断言 **console error 为 0**、无失败请求、UI 启动的那次运行就是 Bridge 记录的那次。它同时是「API 基址在运行时解析」的**可执行判别**：页面按**主机名** `localhost` 打开，探针记录每个 API 请求**实际**去的 host——运行时解析得到的是同源相对路径（→ `localhost:<port>`），写死的基址是绝对地址（→ 数字地址），两者可区分（同样的 ST 路径在 `--page-origin http://127.0.0.1:3000` 的白名单跨源下再跑一遍） | 22 §2.1/§3.3 |
| `mutation-evidence.sh` | **五个变异**：A 服务端 route handler **未声明** `force-static`（Next.js 16 在 `output:'export'` 下于**构建期**直接拒绝——它证明的是「构建被拒绝」，**不**证明文件树断言）；A′ 同一个 handler **声明了** `force-static`（构建**成功**、handler 被预渲染成 `out/api/session`，**「导出目录无服务端路由产物」这条断言**因此变红，报 `found: api/session`）；B API 基址被烘焙成构建期常量（静态启发式变红，**可执行判别**也变红）；B2 基址被烘焙**且** bundle 里留着一个**无关的** `location.port` 比较（静态启发式**仍然绿**——这就是它的边界；**可执行判别**变红）；C 夹具 `node_modules` 被移走（引擎缺失）。变异**临时**改动产品源码，脚本用 `trap` 在退出时**还原源码并重建导出**，备份写在**仓库之外**的临时目录里 | 22 §2/§3.3.2 |
| `collect-evidence.sh` | 把上述命令连同 `npm ci`、`next build`、`npm test`、WBS 共存回归、**端口审计**、**ADR 引用校验**、**8 步构建门禁**的**实际输出**写进 `docs/evidence/ATS-103/` | 22 §3 |

## 运行方式

```bash
# 前置：apps/studio 的依赖已安装、静态导出已构建（见 collect-evidence.sh）
node tools/ats103-probes/verify-export-and-proxy.mjs

# 真实浏览器驱动导出的那一页（需要本机的 Playwright 浏览器缓存）
node tools/ats103-probes/ui-smoke.mjs
node tools/ats103-probes/ui-smoke.mjs --page-origin http://127.0.0.1:3000

# 五个变异（会临时改动产品源码并在结束时还原）
bash tools/ats103-probes/mutation-evidence.sh

# 一键重新生成本目录对应的证据日志
bash tools/ats103-probes/collect-evidence.sh
```

## 纪律（务必遵守）

1. **静态导出下不存在「Next.js API 代理路由」。** `next.config.mjs` 声明
   `output: 'export'`，Next.js 16 在该模式下不产出任何服务端（无 API Routes、
   无 SSR、无 Node 中间件）。因此「API 代理」在本仓库的准确含义是
   **导出页 → Bridge 的跨源直连**，基址由
   `apps/studio/lib/api.ts` 在**运行时**按端口解析（默认端口时同源空串，
   否则绝对地址），并带上 `X-ATS-Token` 会话令牌。
   验证脚本因此断言的是「**导出目录里没有服务端路由产物**」与「**运行时基址解析**」，
   而不是断言页面里不出现 Bridge 的地址这个字符串——后者会误判：
   页脚把它作为**界面上的地址标签**显示是合理的。
   其中「运行时基址解析」由**两条**证据承担，能力边界必须写清：
   HTTP 探针的静态启发式只证明「bundle 里有对 `location.port` 的比较」，
   **证明不了**那个比较就是选基址的那一步（反例 B2：基址写死**且**留一个无关比较，
   静态启发式仍然绿）；真正的证明是 `ui-smoke.mjs` 的**可执行判别**——
   页面按主机名 `localhost` 打开，运行时解析的请求去 `localhost:<port>`，
   写死的基址去数字地址。B 与 B2 都让它变红。
2. **不得把 HTTP 202 当成运行完成。** `POST .../run` 返回 202 只表示
   「已受理」。脚本会**轮询** `GET /api/runs/{id}` 直到终态，并且**只接受**
   `passed` / `failed`——`error`、`cancelled`、`interrupted` 与超时**一律判 FAIL**。
   夹具 `node_modules` 被移走时（引擎缺失），探针**必须**退出码 1。
3. **检查项数是常量，缺项即 FAIL。** 探针声明了固定的检查项数与名称清单；
   少跑一项、跳过一个、或名字对不上，探针自己就判 FAIL 并退出码 1。
   跑不到的检查记为 **FAIL**，不是「跳过」。
4. **summary 必须与磁盘上的 `report.json` 一致。** 探针读出 Bridge 落盘的
   `report.json`，重算每状态计数，再与 API 报告的 summary 逐项比对。
   引擎崩溃（无 `report.json`）时这条**判 FAIL**——这一条不是恒真的
   「不得报告伪造的 summary」断言。
5. **端口必须是 Bridge 的默认端口，否则「真实 UI 不可用」。** 默认端口由
   `lib/default-port.mjs` **从产品源码 `server/index.mjs` 读出**（探针自身不写
   端口字面量，既免得端口审计多算一处，也让探针不会与产品漂移）。
   探针在**非默认端口**上运行时会在结论里明写「这只验证了 API 接缝，
   不等于 UI 可用」，因为导出页的基址解析与 CSP 都指向默认端口
   （`docs/16-BASELINE-ADR.md` §3.1 第 2 条）。
6. **本目录不修产品缺陷。** 探针只**如实记录**运行期的证据链缺陷
   （引擎进程异常死亡时 Bridge 把 run 标成 `failed` 却无 summary），修复
   归属 ATS-108 / ATS-112，见 `docs/22-FRONTEND-EXPORT.md` §4。
7. **不得把 `DESIGNED` 写成已实现。** 本任务交付的主体是**验证与证据**；
   `apps/studio/**` 保持原状。`server/index.mjs` 有**一处**改动——CORS 段
   补回 `Access-Control-Allow-Origin`，那是探针抓出的**真实产品缺陷**
   （缺这个头时浏览器会拦掉全部跨源响应），修复与回归用例见
   `docs/22-FRONTEND-EXPORT.md` §3.3.1。

## 依赖

- Node ≥ 22（根 `package.json` `engines`）
- `apps/studio` 的依赖已 `npm ci` 安装，且 `apps/studio/out` 已由
  `npm --prefix apps/studio run build` 构建
- 真实运行路径还需要 `examples/sample-playwright` 的依赖已安装
  （`npm install`），否则那几条 IT 会被跳过
- 仓库根的 `apps/studio/out`（静态导出产物）、`server/`（Bridge 实现）
