# ATS-OPS-001 運用設計書 / 安装、部署与维护

## 1. 运行前提

最少 Node.js 22、可访问的本地文件系统。被测项目要有 `package.json`、`playwright.config.*`，如要实际执行须先在其项目中安装 Playwright 和浏览器；不要求工作台自动安装 npm 包。推荐 Windows 11 Pro 开发端，PowerShell 7，Git CLI，VS Code。Tauri 开发另需 Rustup/Cargo、WebView2、C/C++ 编译链。Node/React/Playwright 版本请参考各自官方发行兼容表并以 lockfile 冻结。**本仓库自身的依赖已冻结**（ATS-102 交付）：根与 `apps/studio` 各有 `package-lock.json`，Node 版本见 `.nvmrc`（22.23.4），安装须用 `npm ci`（严格按 lockfile）而非 `npm install`；依赖清单见 `docs/dependencies/`，构建门禁见 `docs/17-BUILD-CI.md`。

## 2. 启动与验证

便携模式（已通过本地 HTTP IT）：`npm start`，访问 `http://127.0.0.1:4577/fallback.html`；首次无任何项目可点击添加。Windows PowerShell 也可运行 `./start.ps1`。正式 Next 源码模式：`npm --prefix apps/studio install` → `npm run build:web` → `npm start` → 访问根路径。Tauri 开发模式：保证 Node 22/Rust/Tauri CLI 环境，`npx tauri dev`。后两种因离线缺依赖，属于**有源码、待目标环境构建验证**。

部署式控制面 API（ATS-506，已通过进程级 IT）：`npm run start:control-plane`（即 `node server/control-plane/main.mjs`），纯 Node 进程，不依赖 Tauri；默认监听 `http://127.0.0.1:4610`，验证 `GET /cp/v1/health` 返回 `plane=control-plane`。绑定非回环地址时必须同时给出 `ATS_CP_TLS_CERT` 与 `ATS_CP_TLS_KEY`（HTTPS，最低 TLS 1.3），否则拒绝启动；配置错误时进程以退出码 2 结束。用户侧认证默认拒绝一切（OIDC 属 ATS-507）；开发与测试可用 `ATS_CP_AUTH=dev-static`，仅限回环地址。控制面目前不持久化（进程内存储），重启即丢失项目元数据与审计事件。

## 3. 数据位置与备份恢复

默认 `~/.ai-test-studio/state.json` 和 `runs/<run-id>`；可配置 `ATS_DATA_DIR`。备份时先停止服务器，整体复制 `ATS_DATA_DIR`；恢复时先备份当前，再复制旧目录，检查 `state.json.schema=1`。禁止直接编辑运行状态并声称通过；证据目录和 manifest 应一起保存。v0.1 没有 UI 清理和保留期，长期使用应定期人工迁移或归档敏感文件。

## 4. 运行维护检查表

| 事项 | 检查方法 | 异常时处理 |
|---|---|---|
| 服务存活 | `GET /api/health` | 检查 4577 端口冲突与 Node 版本 |
| 目标 CLI | `node_modules/@playwright/test/cli.js` | 在**目标仓库**运行 npm install，勿在平台根运行 |
| 浏览器依赖 | `npx playwright install`（目标项目） | 由用户安装浏览器；不使用自动下载兜底 |
| Git 信息 | `git status --porcelain`、`git rev-parse` | 确认 PATH 和仓库状态 |
| 测试用例缺失 | 检查 `.spec.ts/.test.ts` 及动态定义 | 静态索引有限，P1 引入 `--list` |
| 报告缺失 | 检查 `runs/<run-id>/report.json` | 检查 Playwright 版本及 reporter 设置 |
| 不能停止运行 | 任务管理器 / `taskkill` | 清理子孙进程，归档日志后重新测试 |
| 页面空白 | Next 构建缺失 | 使用 `/fallback.html` 或补全 npm 依赖 |
| 运行历史不存在 | 检查 `ATS_DATA_DIR` 与 state.json | 核对操作系统用户和权限 |
| 状态损坏 | 启动报 `STATE_CORRUPT` / `UNSUPPORTED_DATABASE`，Bridge 拒绝启动且不改写该文件 | 先复制损坏文件，再恢复最后一份完好的副本（迁移备份 `state.json.bak`）；见 docs/06 §5.7 |
| 第二个 Bridge 起不来 | 启动报 `holds the data directory lock` 并给出持有者 pid | 同一数据目录只允许一个 Bridge；确认该 pid 不是 Bridge 后才可删除 `bridge.lock` |
| 镜像损坏 | 启动时 stderr 报 `quarantined` | 无需处理：损坏的 `metadata.db` 已改名为 `metadata.db.corrupt-*`，镜像已由 state.json 重建 |

## 5. 环境变量

- `ATS_PORT`：默认 4577（Next UI 的 API BASE 当前写死 4577，变更端口需同步调整 UI 配置；非动态端口发布模式）
- `ATS_DATA_DIR`：本地历史/附件目录，默认用户主目录 `.ai-test-studio`；同一目录同一时刻只允许一个 Bridge
- `ATS_LOCK_WAIT_MS`：数据目录锁被占用时，启动中的 Bridge 最多等待的毫秒数；默认 0（立即拒绝）
- `ATS_LOCK_VERIFY_MS`：Bridge 校验自己仍持有锁的间隔毫秒数；默认 5000，下限 50
- `PLAYWRIGHT_JSON_OUTPUT_FILE` 等由 Runner 注入到测试子进程。
- `ATS_CP_HOST` / `ATS_CP_PORT`：部署式控制面的监听地址与端口，默认 `127.0.0.1` / `4610`；端口与已设置的 `ATS_PORT` 相同即拒绝启动（本地与远程不得共用同一端点）
- `ATS_CP_TLS_CERT` / `ATS_CP_TLS_KEY`：控制面 HTTPS 证书与私钥文件，必须成对给出；非回环地址必填
- `ATS_CP_AUTH`：控制面用户侧认证模式，`none`（默认，拒绝一切需认证的请求）或 `dev-static`（仅回环地址）
- `ATS_CP_DEV_TOKENS`：`dev-static` 的令牌表，JSON `{令牌: 租户ID}`；令牌至少 32 字符，租户 ID 形如 `ten_xxx`；控制面不输出令牌值

## 6. 运维 SLO 建议（尚未证实）

本地 API 健康响应 P95 低于 200ms；索引 500 个静态测试低于 3 秒；失败率计算不得把 cancelled/interrupted 误算为 passed；历史保留由用户设定但 P0 目前无自动清理。真正的 SLA、跨机器可用性和稳定性需从 ST 性能/恢复测试测定。
