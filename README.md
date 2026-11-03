# AI Test Studio v0.1 — Git-native 可视化 Playwright 测试管理工作台

> 首版**源码交付**与自动化验证基线，不是已签名的商业桌面安装包。研究基准：2026-11-03。

## 立即启动（Windows / Node.js 22+）

1. 解压到短路径，如 `D:\AI-Test-Studio`。
2. PowerShell 执行 `./start.ps1`，或在项目根目录运行 `npm start`。
3. 浏览器打开 <http://127.0.0.1:4577/fallback.html>。这是**已测试的零依赖便携 UI**。
4. 输入现有 Playwright 项目的本地路径，点击「添加项目」；工程必须有 `package.json` 和 `playwright.config.ts` 等配置。
5. 选择脚本：可以查看只读流程图、编辑/保存原始脚本；点击「运行」调用**该工程本地安装**的 Playwright CLI。
6. 用例所在仓库中先安装 `@playwright/test` 及浏览器：`npm install`、`npx playwright install`。本工具绝不自动安装依赖或执行远程代码。

首次体验可导入压缩包里的 `examples/sample-playwright`。这个示例在未安装依赖时只支持导入和索引；其执行按钮会明确提示 `PLAYWRIGHT_NOT_INSTALLED...`。

### Next.js 界面（需要联网完成依赖安装）

```powershell
npm --prefix apps/studio install
npm run build:web
npm start
```

完成构建后，打开 <http://127.0.0.1:4577/>，将使用正式 Next.js 工作台（Monaco 编辑器 + 流程投影）。开发模式：开一个终端运行 `npm start`，另一个运行 `npm run dev:next`，浏览器进入 <http://localhost:3000>。

### Tauri 2 开发模式（需要本地 Rust 工具链、Windows WebView2）

先执行 `npm --prefix apps/studio install`；在本机安装 `rustup` 和 Tauri CLI，然后在项目根目录运行 `npx tauri dev`（或通过 npm 安装 `@tauri-apps/cli@^2` 后运行）。Tauri shell 会尝试通过 PATH 的 `node` 启动 `server/index.mjs`；如果 4577 已有服务器监听，先关闭另一个实例。

**Windows 构建的前置条件**（v0.1.1 基线实测，见 `docs/16-BASELINE-ADR.md` §4 B-02）：

1. VS「使用 C++ 的桌面开发」工作负载（msvc 工具链必需）；
2. 仓库需提供 `src-tauri/icons/icon.ico`——`tauri-build` 对任何 Windows target 都会回退到该路径，当前仓库只含 3 个 PNG，**全新 clone 无法直接完成 Windows 编译**；
3. 本版 `bundle.active=false`，不提供假的 exe。

## 已实现 / 尚未实现

| 已实现 (v0.1) | 下一阶段，不应当认为已交付 |
|---|---|
| 本地 Playwright 项目登记，Git 分支/commit/dirty 查看 | 多用户身份认证、团队 RBAC、远程 Runner |
| 基于 `*.spec.ts/js` 的常见用例静态索引 | 完整 Playwright AST、动态/参数化测试的权威索引 |
| 源码阅读、SHA-256 乐观锁保存 | 任意 TypeScript 与流程图无损双向编辑 |
| Playwright 进程运行/停止/日志轮询 | Docker/VM 沙箱、资源配额与分布式调度 |
| JSON/HTML 报告、trace、截图等附件归档 | 全自动 AI 编写、自动修复和自主探索 |
| 每次运行记录与 JSONL 事件日志 | SQLite/PG、增量同步、WORM 证据存储 |
| 需求/脚本关联 JSON 的只读展示 | 完整 IPA 质量门禁与工作流审批 |
| Node 内置测试运行 20+ UT/IT | 真实跨浏览器和多 OS 端到端验收 |

**安全提示：测试脚本本质上是可执行代码。仅添加可信仓库。** 这是本地开发版本，Node 子进程不等于安全沙箱；CLI/测试代码仍可访问执行用户权限下的文件、网络和环境变量。不要将 4577 端口公开至公网。自动收集的截图/视频/Trace 可能包含敏感信息；自行决定保留期和删除方式（数据默认 `~/.ai-test-studio`）。

## 工程文件

- `server/`：可独立运行的 Node 22 本地控制服务、Playwright 进程管理、持久化。
- `apps/studio/`：Next.js 16 + React 19 + TypeScript 控制台，静态导出。
- `apps/studio/public/fallback.html`：真正可操作且零 npm 依赖的备用 UI。
- `src-tauri/`：Tauri 2 / Rust 桌面包装源码，**未编译发行**。
- `examples/`：示例 Playwright 仓库与 IPA 需求关联数据。
- `tests/`：Node 原生 UT 与 HTTP IT 验证。
- `docs/`：IPA 方法对齐的要件定义、基本/详细设计、UT/IT/ST、RTM、风险、运维、迭代路线图。
- `test-cases.xlsx`：UT/IT/ST 结构化测试设计与需求追踪矩阵。

## 原则

Git 仍是测试脚本及设计的唯一事实来源；本地数据只保存执行历史和索引。来自 Kestra 的多视图、Bruno 的 Git-native、Dagster 的关系/血缘、Temporal 的追加事件、OpenHands 的 Agent 隔离、Allure/Playwright 的不可变原生证据分别以最小可行形态纳入文档和代码。请阅读 `docs/00-INDEX.md`。

## 自检

```bash
npm test
node --check server/index.mjs
```

离线环境内已验证：20/20 UT/IT 通过（全部在测试双桩下执行）。真正的 Playwright E2E 测试必须在配备依赖和浏览器的目标机器上执行；尚不能据此宣称 ST 已通过。

> **v0.1.1 基线限定（2026-11-03 实测）**：Bridge 传给 `playwright test` 的参数向量含两个不存在的选项（`--screenshot`/`--video`），**真实浏览器执行当前必然失败**；另有一项重启后 Run 卡死、永久占用运行锁的缺陷。详见 `docs/16-BASELINE-ADR.md` §4 与 `docs/evidence/ATS-101/`。上表「已实现」列中涉及真实浏览器执行与产物归档的行，请按该基线文档的分类口径理解。

## 外部参考及声明

参阅 `docs/15-REFERENCES-LICENSES.md`。本项目的自研代码使用 MIT 许可；第三方代码采用各自许可证，不得假设所有外部项目都可直接并入闭源软件。IPA-oriented 不代表 IPA 认证。
