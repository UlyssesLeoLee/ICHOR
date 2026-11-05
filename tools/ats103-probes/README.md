# ATS-103 验证脚本（Static export → Bridge → API 全链）

本目录是 ATS-103（SEIKOIST-148）「Next.js 16 静态导出构建、路由与 API 代理验证」
所依据的**可重跑验证脚本**。对应的实际输出记录在 `docs/evidence/ATS-103/`，
结论文档是 `docs/22-FRONTEND-EXPORT.md`。

## 各脚本对应什么结论

| 脚本 | 结论 | 文档位置 |
|---|---|---|
| `verify-export-and-proxy.mjs` | **26 项**检查全部通过：(a) 静态导出产物自洽——`index.html`/`404.html`/`_next/static` 齐备，`index.html` 引用的 8 个资源全部存在；(b) 导出目录**不含任何服务端路由产物**——断言直接扫过导出目录的**真实文件树**，因此新增 `app/api/**` 时它会真的变红（变异证据见 `docs/evidence/ATS-103/06-mutation-evidence.log`）；(c) 导出产物里带着**运行时**的 API 基址解析逻辑（构建期不烘焙基址）——断言 bundle **读取** `location.port` 并据此分支，构建期写死基址时它会真的变红；(d) Bridge 能在 `/` 提供该导出并带上允许 API 源的 CSP，哈希 chunk 亦可取回；(e) 会话/项目/运行三类操作实测成功——异源 Origin 403、无 token 401、`POST /api/projects` 201、`GET .../tests` 返回 2 个用例、`POST .../run` 返回 202 并最终到达终态；(f) 真实运行的 **summary 与磁盘上的 `report.json` 逐项一致**、每例结果集非空、证据产物非空——不是「不伪造」这种恒真断言 | 22 §1/§2/§3.3/§3.4 |
| `ui-smoke.mjs` | **7 项**检查全部通过：在**真实 headless Chromium** 里驱动**导出的那一页**执行它自己的 JS，走完会话 → 添加项目 → 运行到终态，并断言 **console error 为 0**、无失败请求、UI 启动的那次运行就是 Bridge 记录的那次（同样的 ST 路径在 `--page-origin http://127.0.0.1:3000` 的白名单跨源下再跑一遍） | 22 §3.3 |
| `mutation-evidence.sh` | **三个变异**，每个都必须把探针**变红**（退出码 1）：A 服务端 route handler（Next.js 16 在 `output:'export'` 下于**构建期**直接拒绝）；B API 基址被烘焙成构建期常量（`lib/api.ts` 的 `root()` 被改成常量形式，探针的「运行时基址解析」与「非构建期烘焙」两条同时变红）；C 夹具 `node_modules` 被移走（引擎缺失）。变异**临时**改动产品源码，脚本用 `trap` 在退出时**还原源码并重建导出**，备份写在**仓库之外**的临时目录里 | 22 §3.3.2 |
| `collect-evidence.sh` | 把上述命令连同 `npm ci`、`next build`、`npm test`、WBS 共存回归、**端口审计**、**ADR 引用校验**、**8 步构建门禁**的**实际输出**写进 `docs/evidence/ATS-103/` | 22 §3 |

## 运行方式

```bash
# 前置：apps/studio 的依赖已安装、静态导出已构建（见 collect-evidence.sh）
node tools/ats103-probes/verify-export-and-proxy.mjs

# 真实浏览器驱动导出的那一页（需要本机的 Playwright 浏览器缓存）
node tools/ats103-probes/ui-smoke.mjs
node tools/ats103-probes/ui-smoke.mjs --page-origin http://127.0.0.1:3000

# 三个变异（会临时改动产品源码并在结束时还原）
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
2. **不得把 HTTP 202 当成运行完成。** `POST .../run` 返回 202 只表示
   「已受理」。脚本会**轮询** `GET /api/runs/{id}` 直到终态，并且**只接受**
   `passed` / `failed`——`error`、`cancelled`、`interrupted` 与超时**一律判 FAIL**。
   夹具 `node_modules` 被移走时（引擎缺失），探针**必须**退出码 1。
3. **检查项数是常量，缺项即 FAIL。** 探针声明了固定的检查项数与名称清单；
   少跑一项、跳过一个、或名字对不上，探针自己就判 FAIL 并退出码 1。
   跑不到的检查记为 **FAIL**，不是「跳过」。
4. **summary 必须与磁盘上的 `report.json` 一致。** 探针读出 Bridge 落盘的
   `report.json`，重算每状态计数，再与 API 报告的 summary 逐项比对。
   引擎崩溃（无 `report.json`）时这条**判 FAIL**——不再有恒真的
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
7. **不得把 `DESIGNED` 写成已实现。** 本任务交付的是**验证与证据**，
   产品代码零改动；`apps/studio/**` 与 `server/**` 保持原状。

## 依赖

- Node ≥ 22（根 `package.json` `engines`）
- `apps/studio` 的依赖已 `npm ci` 安装，且 `apps/studio/out` 已由
  `npm --prefix apps/studio run build` 构建
- 真实运行路径还需要 `examples/sample-playwright` 的依赖已安装
  （`npm install`），否则那几条 IT 会被跳过
- 仓库根的 `apps/studio/out`（静态导出产物）、`server/`（Bridge 实现）
