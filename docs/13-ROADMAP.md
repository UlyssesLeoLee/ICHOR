# ATS-PLAN-001 開発計画書 / 分期路线图

## 1. 当前版本 v0.1（Next 已构建 / Tauri 构建受阻 B-02）

已实现 Node bridge 的项目登记、静态索引、受控源码读写、Playwright 执行器、状态/日志/JSONL、原生报告/证据归档、需求关联读取；提供便携 HTML 和 Next/Tauri 项目源码。已自动验证 core/API UT/IT；**尚未执行实际带浏览器的 Playwright ST**。

**构建与执行实测（2026-11-03，ATS-101 实测）**：**Next.js 16 静态导出构建已成功**（Next.js 16.4.4，产物 `apps/studio/out/`，可由 Bridge 伺服），npm registry 本次可达。**Tauri Windows 编译未通过**，已定位**四个成因**，且**成因清单尚未穷尽**：

- **成因 1（环境缺陷）**：msvc 链缺 MSVC「使用 C++ 的桌面开发」工作负载（Cargo/Rust 实测已安装，仅不在 PATH）；
- **成因 2（仓库缺陷）**：仓库缺 `src-tauri/icons/icon.ico`（`tauri-build` 对任何 windows target 都会回退到该路径），**全新 clone 永远无法构建**——仅安装 MSVC 不能修复；
- **成因 3（工具链缺陷）**：gnu 链的编译器与运行时库不匹配；
- **成因 4（产物缺陷）**：补齐 `.ico` 并换成带完整运行时的 MinGW GCC 后，`cargo check` 通过，但 `cargo build` 在链接 cdylib 时因导出序号超限失败（`ld.exe: error: export ordinal too large: 90774`）。

msvc 链的最终链接在本机无法验证，因此 **ATS-104 的验收须以 `cargo build`（含最终链接）为准，而非 `cargo check`**。详见 `docs/16-BASELINE-ADR.md` §4 B-02。

**真实浏览器 ST 仍被代码缺陷 B-01 阻断**（`safeRunArgs()` 传入 Playwright CLI 不存在的 `--screenshot`/`--video` 选项，导致真实执行 100% 失败）。

**远程执行面（ATS-501，2026-11-04）**：S5 的远程执行协议、信任边界、威胁模型与拒绝规则已冻结于 `docs/19-REMOTE-RUNNER-PROTOCOL.md`（ADR-015~023）。冻结内容含五项验收要素（信任边界、认证、版本握手、租户隔离、拒绝规则）以及连接方向（节点只出站）与代码获取通道（节点侧预置本地代码源）。这是**协议冻结，不是实现**——仓库内没有控制平面、Runner 节点或远程队列，全部标记 `DESIGNED`，FR-028/FR-030 状态不变。S5 的下游 WBS（ATS-502~ATS-512）在各自完成前不得声称满足该协议。

## 2. 后续最小可行顺序

| Phase | 预计工程量（单人粗估） | 交付 | 非范围 |
|---|---|---|---|
| P0.1 稳定化 | 2–4 周 | 修复本地进程管理、真实 Playwright 正/负/取消运行实测、Next build、Tauri Windows dev build、UI keyboard a11y | AI 与企业权限 |
| P0.2 资产一致性 | 3–5 周 | Playwright --list 原生索引、稳定 UID、Git diff 审核、source 原子保存、SQLite WAL、附件去重与保留 | 完整 AST 图反写 |
| P1 双引擎 | 4–7 周 | WDIO Tauri Service 实测、Run/Test/Attempt、统一 Trace/Evidence 协议 | 远程集群 |
| P1 图谱和测试设计 | 4–7 周 | Requirements/Design/TestCase 实体图、React Flow、UT/IT/ST 导入与覆盖矩阵 | 复杂跨仓库因果模型 |
| P1 AI 安全编排 | 5–9 周 | Agent Planner、Generator、Triage、Diff Review，Docker 沙箱与模型适配 | AI 自动合并到主分支 |
| P2 企业扩展 | 8–16 周 | 多用户、远程 Runner、S3、OIDC/RBAC、签名证据、审计、CI/CD 双向事件 | 取决于商业需求 |

**Agent 契约 v1 已落地（ATS-401，S4/v0.4.0）**：`server/agent.mjs` 实现了 Agent 请求的作用域/预算/输入出处校验、角色能力白名单、提案收敛与评审状态机；写入与提交类能力在能力层被禁，提案人不得自审。**模型提供商接入（ATS-403）与 API Key 存储（ATS-402）尚未实现**，仓库中不存在把模型输出写入仓库的代码路径。详见 `docs/17-AGENT-CONTRACT.md`。

以上时长属于工程估计，不是可交付承诺；实际受团队人数、目标 OS、项目复杂度与联网依赖条件影响。

## 3. 优先级、价值与风险

P0 阶段重视**导入既有脚本→精准执行→保留证据→分析失败**。优先完成稳定性和可审计性，其次提升图形编辑自由度。任何 AI 修复需要以下最小链：`evidence → proposed diff → reviewer → compile/lint → rerun → approval → Git`。项目在证据完整性/沙箱未达标前，不应添加“一键自主修改并执行陌生仓库”的功能。

## 4. 与 Star/GitGit/RAGit 的连接预留

采用独立 Project/TestCase/Run/Evidence UID，将 REST/Webhook/事件转换作为未来接口；平台不直接依赖 Star 或 GitGit 数据表，也不要求迁移 Git。RAGit 只应供参考文档检索，不能未经授权上传项目机密文本。第一版保持独立运行，避免把协作系统强耦合到核心 Runner。
