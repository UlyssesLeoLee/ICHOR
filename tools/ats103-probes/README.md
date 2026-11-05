# ATS-103 验证脚本（Static export → Bridge → API 全链）

本目录是 ATS-103（SEIKOIST-148）「Next.js 16 静态导出构建、路由与 API 代理验证」
所依据的**可重跑验证脚本**。对应的实际输出记录在 `docs/evidence/ATS-103/`，
结论文档是 `docs/21-FRONTEND-EXPORT.md`。

## 运行方式

```bash
# 前置：apps/studio 的依赖已安装、静态导出已构建（见 collect-evidence.sh）
node tools/ats103-probes/verify-export-and-proxy.mjs

# 一键重新生成本目录对应的证据日志
bash tools/ats103-probes/collect-evidence.sh
```

## 各脚本对应什么结论

| 脚本 | 结论 | 文档位置 |
|---|---|---|
| `verify-export-and-proxy.mjs` | **23 项**检查全部通过：(a) 静态导出产物自洽——`index.html`/`404.html`/`_next/static` 齐备，`index.html` 引用的 8 个资源全部存在，导出目录**不含任何服务端路由产物**；(b) 导出产物里带着**运行时**的 API 基址解析逻辑（构建期不烘焙基址）；(c) Bridge 能在 `/` 提供该导出并带上允许 API 源的 CSP，哈希 chunk 亦可取回；(d) 会话/项目/运行三类操作实测成功——异源 Origin 403、无 token 401、`POST /api/projects` 201、`GET .../tests` 返回 2 个用例、`POST .../run` 返回 202 并最终到达终态；(e) 真实运行产出**每例结果**与**证据产物**，不得以伪造 summary 冒充成功 | 21 §1/§2/§3.3/§3.4 |
| `collect-evidence.sh` | 把上述命令连同 `npm ci`、`next build`、`npm test`、WBS 共存回归的**实际输出**写进 `docs/evidence/ATS-103/` | 21 §3 |

## 纪律（务必遵守）

1. **静态导出下不存在「Next.js API 代理路由」。** `next.config.mjs` 声明
   `output: 'export'`，Next.js 16 在该模式下不产出任何服务端（无 API Routes、
   无 SSR、无 Node 中间件）。因此「API 代理」在本仓库的准确含义是
   **导出页 → `127.0.0.1:4577` 的跨源直连**，基址由
   `apps/studio/lib/api.ts` 在**运行时**按端口解析（4577 时同源空串，
   否则绝对地址），并带上 `X-ATS-Token` 会话令牌。
   验证脚本因此断言的是「**无服务端路由产物**」与「**运行时基址解析**」，
   而不是断言页面里不出现 `127.0.0.1:4577` 这个字符串——后者会误判：
   页脚把它作为**界面上的地址标签**显示是合理的。
2. **不得把 HTTP 202 当成运行完成。** `POST .../run` 返回 202 只表示
   「已受理」。脚本会**轮询** `GET /api/runs/{id}` 直到终态
   （`passed`/`failed`/`error`/`cancelled`/`interrupted`），然后断言
   summary 的用例集非空、产物数组非空。
3. **失败运行不得报告伪造的 summary。** 脚本有一条恒真性断言：失败的运行
   不得声称成功。它在引擎正常时通过（真实的 1 PASS / 1 FAIL），在引擎
   崩溃时如实反映 `summary=none`，而不是把崩溃伪装成成功。
4. **本目录不修产品缺陷。** 探针只**如实记录**运行期的证据链缺陷
   （引擎进程异常死亡时 Bridge 把 run 标成 `failed` 却无 summary），修复
   归属 ATS-108 / ATS-112，见 `docs/21-FRONTEND-EXPORT.md` §4。
5. **不得把 `DESIGNED` 写成已实现。** 本任务交付的是**验证与证据**，
   产品代码零改动；`apps/studio/**` 与 `server/**` 保持原状。

## 依赖

- Node ≥ 22（根 `package.json` `engines`）
- `apps/studio` 的依赖已 `npm ci` 安装，且 `apps/studio/out` 已由
  `npm --prefix apps/studio run build` 构建
- 真实运行路径还需要 `examples/sample-playwright` 的依赖已安装
  （`npm install`），否则那几条 IT 会被跳过
- 仓库根的 `apps/studio/out`（静态导出产物）、`server/`（Bridge 实现）
