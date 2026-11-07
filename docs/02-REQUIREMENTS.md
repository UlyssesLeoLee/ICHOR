# ATS-RD-001 要件定義書（v1.0 设计基线 / v0.1 实现）

## 1. 背景、目的与边界

现有开发已使用 Playwright 编写自动化脚本，但项目分散、管理和可见性不足。目标建立本地优先、Git 原生测试工作台，降低脚本检索、运行、分析、关联设计文档的成本；不是替换 Playwright，也不是重写浏览器自动化。目标用户：开发者、测试设计者、QA Lead，后期包括 AI Agent。主要业务场景：选择 Git 项目→查看脚本→选择运行→分析结果与证据→修复→复测→形成可追踪验证记录。

### 1.1 范围界定

- **IN（v0.1）**：本地单用户、Playwright 测试、源码及 Git 信息、静态用例发现、单项/全部执行、停止/历史、原生报告及附件、基础需求追踪、便携 UI/Next UI 源码。
- **OUT（v0.1）**：WDIO 实际运行、Tauri 安装包、动态/参数化用例精确索引、AI 自动化调用、结构化图编辑、登录/RBAC、Docker 隔离、分布式调度、CI 双向联动。
- **主要约束**：本地 Node 22+；Playwright 需在被测项目的 node_modules 安装；项目只接受可信代码；不自动安装依赖；UI 不自动提交 Git。

> **基线限定（2026-11-03，ATS-101/SEIKOIST-146 实测）**：下表 FR-009/010/011/014/018 的 `IMPLEMENTED` 仅指**代码路径与测试双桩已实现**，不代表真实浏览器链路可用。实测发现 B-01：`server/core.mjs:82` `safeRunArgs()` 向 Playwright Test CLI 传入 `--screenshot`/`--video` 两个**不存在的选项**，导致真实执行在参数解析阶段即失败（`summary=null`、`artifacts=[]`）。真实浏览器链路在 B-01 关闭前应视为**未验证**。详见 `docs/16-BASELINE-ADR.md` §4。
>
> **基线限定（2026-11-03，ATS-101/SEIKOIST-146 实测）— NFR-008**：NFR-008（恢复能力）**不得标为「已实现」**。实测发现 B-03：服务重启时启动恢复只处理 `queued`/`running`，**遗漏 `cancelling`**（`server/index.mjs:16`），而 `cancelRun()` 在找不到活动 job 时抛 `RUN_NOT_ACTIVE`（实测 500）。因此一次「请求停止后进程被强杀」的异常即可使该 Run 永久占用同项目运行锁且无法通过 API 解除，**无自愈路径**。NFR-008 当前状态为**部分实现（存在卡死缺陷）**，修复归 ATS-108/ATS-112。详见 `docs/16-BASELINE-ADR.md` §4 B-03。
> **B-03 的现状**：启动恢复的状态集合已补齐 `cancelling`，`cancelRun()` 对没有活动 job 的在飞 Run 会写下 `run.interrupted` 并让它进入终态，因此那条 Run 不再永久占用同项目运行锁。回归用例 `IT-EXE-011` 与复核探针 `bridge-e2e` 的 E3 守这条修复。**但 NFR-008 仍不标为「已实现」**：恢复的其余缺口（`/stop` 对已终结 Run 的幂等语义、同项目运行锁改为按「活动 job 存在性」判定、以及重启时的 ST 证据）仍归 ATS-108/ATS-112。
## 2. 功能要件（Functional Requirements）

| ID | 标题 | 验收标准（合格基准） | 优先级 | v0.1 |
|---|---|---|---|---|
| FR-001 | 添加本地项目 | 有 package.json 与 playwright.config 时登记为唯一项目 | P0 | IMPLEMENTED |
| FR-002 | Git 上下文 | 展示项目 branch、short commit、dirty 标志 | P0 | IMPLEMENTED |
| FR-003 | 现有脚本零迁移 | 扫描原仓库并直接显示 .spec/.test 文件 | P0 | IMPLEMENTED |
| FR-004 | 测试项索引 | 常见静态 test/it 标题、文件、行号可展示；动态情况显式提示不完整 | P0 | IMPLEMENTED (limited) |
| FR-005 | 测试检索 | 支持文件与用例标题关键字筛选 | P0 | IMPLEMENTED UI |
| FR-006 | 源码浏览 | 展示 UTF-8 TypeScript/JavaScript 测试源文件 | P0 | IMPLEMENTED |
| FR-007 | 脚本保存 | SHA-256 版本匹配才允许保存；不自动 commit | P0 | IMPLEMENTED |
| FR-008 | 非破坏性流程投影 | 识别 goto/click/fill/expect 等常见调用；不能覆盖原始代码 | P0 | IMPLEMENTED (heuristic) |
| FR-009 | 启动全部测试 | 调用项目本地 Playwright CLI，不通过 shell，不自动下载安装 | P0 | IMPLEMENTED |
| FR-010 | 启动指定脚本 | 以已存在脚本路径作为过滤参数，避免任意 CLI 注入 | P0 | IMPLEMENTED |
| FR-011 | 停止运行 | Windows taskkill / Unix SIGTERM 请求停止子进程 | P0 | IMPLEMENTED (best effort) |
| FR-012 | 运行历史 | 不覆盖旧记录；记录 ID/commit/timestamp/status | P0 | IMPLEMENTED（ATS-208：执行模型统一，重试用例计一次且保留全部 attempt） |
| FR-013 | 执行日志 | 前端能够轮询本地 stdout/stderr，显示错误 | P0 | IMPLEMENTED |
| FR-014 | JSON/HTML 与 Trace | 尽力启用原生 reporter/trace/screenshot/video 并按 Run 隔离 | P0 | IMPLEMENTED (requires Playwright) |
| FR-015 | 文件证据下载 | 路径验证，保留 SHA-256 和相对位置；拒绝路径跳转 | P0 | IMPLEMENTED（ATS-209：清单带所属运行与整组摘要，篡改可检出并指名文件） |
| FR-016 | 报告摘要 | 解析 status、duration、cases、error 供可视化展示 | P0 | IMPLEMENTED（ATS-216：质量概览模块；失败/重试/取消分开计数，指标与原始结果逐项对账，对账同时核对界面显示的数与 Bridge 报告的计数器；失败聚类为确定性归一化，非 AI） |
| FR-017 | 需求关系读取 | 读取 .aitest/requirements.json 和 traceability.json | P0 | IMPLEMENTED (read-only) |
| FR-018 | 执行事件审计 | 同一次运行生成事件顺序号与 JSONL | P0 | IMPLEMENTED（ATS-208：序号无空洞，事件可按 run+sequence 复演为 run 的状态） |
| FR-019 | Git 一致性与冲突提示 | 源码变化导致 stale hash 时返回 409/错误提示 | P0 | IMPLEMENTED |
| FR-020 | 编辑器多视图 | 代码与图切换不丢原始代码；复杂步骤降级显示 | P0 | IMPLEMENTED (not reversible) |
| FR-021 | 完整 Playwright --list 发现 | 根据权威运行时发现动态测试与参数化用例 | P1 | IMPLEMENTED (v0.2.0, ATS-202；未可信仓库回退静态索引) |
| FR-022 | Graph Editor 受控反写 | 仅可视化子集能写回 AST；复杂代码原位保留 | P1 | DESIGNED |
| FR-023 | WDIO Tauri Runner | 统一 Run/Test/Attempt schema，驱动桌面 E2E | P1 | DESIGNED |
| FR-024 | AI 生成 | 需求→测试意图→脚本候选→审查后写入 | P1 | DESIGNED（契约层已实现，见 17-AGENT-CONTRACT） |
| FR-025 | AI 诊断 | 失败归类、差异建议，不能自动修改断言或提交 | P1 | DESIGNED（契约层已实现，见 17-AGENT-CONTRACT） |
| FR-026 | 图谱血缘与覆盖缺口 | Requirement→Script→Run→Evidence 可查询和影响分析 | P1 | DESIGNED |
| FR-027 | 多环境/密钥存储 | 单独安全凭据存储，配置不进入 Git | P1 | DESIGNED（档案侧已实现：ATS-212 交付了项目级环境档案 API、变量白名单、凭据形态拒绝与封口的 runner 环境，档案不进 Git；**独立的凭据存储仍未实现**，凭据形态的变量被拒并指向凭据存储） |
| FR-028 | CI/CD 与远程执行 | RunnerAdapter/Queue/工作区隔离 | P2 | DESIGNED |
| FR-029 | Agent 自主探索 | 异常流程候选、人工验证后固化 | P2 | DESIGNED |
| FR-030 | 团队多用户 | RBAC、审计、团队项目与云数据同步 | P2 | DESIGNED |
| FR-031 | 移动端执行目标抽象 | 设备/模拟器/远端会话三类目标统一描述；会话有唯一标识、能力集与生命周期 | P1 | PARTIAL（S6 / ATS-601：目标与会话契约层已实现并经 UT 实测；真实设备执行仍 DESIGNED） |
| FR-032 | 移动端用例模型 | 移动端 Flow 可映射到统一 TestDefinition；不支持的步骤保留原文并标记，不静默丢弃 | P1 | PARTIAL（S6 / ATS-602：映射层与导入报告已实现并经 UT/IT 实测；真实设备上的 Flow 执行仍 DESIGNED） |
| FR-033 | Android 设备执行 | 在真实 Android 模拟器上跑通一条 Flow；启动/点按/断言/截图实测通过；失败暴露驱动错误 | P1 | DESIGNED（S6 / ATS-603） |
| FR-034 | 移动端证据归档 | 移动端截图/录屏/日志/层级树进统一 Evidence，与 Web/Tauri 引擎可一起查询 | P1 | DESIGNED（S6 / ATS-604） |
| FR-035 | iOS 与 Maestro 兼容边界 | iOS 支持范围逐条写明；Maestro Flow 语法兼容性逐条判定并给出结论 | P2 | DESIGNED（S6 / ATS-606） |

## 3. 非功能要件（非機能要件）

采用 IPA《非機能要求グレード》的质量维度进行项目级定级，并不是照搬官方表格。

| ID | 类别 | 可检验指标 / 方针 | 级别 | 实现状态 |
|---|---|---|---|---|
| NFR-001 | 可用性 | 用户项目操作不要求平台云账号；断网仍可检索已登记项目 | P0 | 基础具备 |
| NFR-002 | 安全 | API 仅 bind 127.0.0.1；token+Origin 拒绝跨站 API 请求 | P0 | 部分具备；无 OS 级身份 |
| NFR-003 | 安全 | 拒绝 `../`、symlink 越界、非测试文件编辑及任意附件路径 | P0 | 已实现 |
| NFR-004 | 数据完整性 | 已生成 Evidence 附件记录 SHA-256；每次运行独立目录 | P0 | 已实现（ATS-209：证据清单可校验、内容寻址去重、到期清理只删证据不删 Run 元数据） |
| NFR-005 | 维护性 | npm 项目零迁移；Node bridge 与 Next/Tauri UI 解耦 | P0 | 已实现 |
| NFR-006 | 性能 | 普通仓库 500 用例索引目标 3 秒内（非环境实测） | P1 | 待 ST 测量 |
| NFR-007 | 可移植性 | Windows/macOS/Linux Web 便携版；Tauri 各 OS 构建另验 | P1 | 部分 |
| NFR-008 | 恢复能力 | 服务异常重启后未完成运行标记 interrupted、保留历史 | P0 | 部分实现（B-03 的卡死缺陷已修复：`cancelling` 纳入启动恢复、无活动 job 的在飞 Run 可经 `/stop` 释放；`/stop` 对已终结 Run 的幂等语义与运行锁判定仍归 ATS-108/ATS-112）；ATS-207：数据目录单实例锁（原子抢锁、崩溃后锁可回收、持有者可校验），真实 Playwright 运行中强杀整棵进程树后重启 run=interrupted 且已完成历史保留（ST-017 已实测） |
| NFR-009 | 隐私保护 | 不自动上传代码、截图、Trace、密钥到外部 AI 服务 | P0 | 已实现，未来 AI 需再评估 |
| NFR-010 | 可靠性 | 数据库原子写入；避免操作时半写入 | P0 | state.json 先 fsync 再改名（ATS-207：写入中强杀不留残缺文件，损坏的状态文件拒绝启动，损坏的 SQLite 镜像隔离后由 state.json 重建），源文件写入仍需改进；ATS-206 已交付状态迁移的数量一致校验与失败可还原（备份 + 按日志自动回滚 + SQLite 镜像先校验后替换） |
| NFR-011 | 可运维性 | 日志/错误码/版本信息可查询，API 返回可定位信息 | P0 | 已实现基础 |
| NFR-012 | 合规许可 | 进入正式发行前完成依赖 SPDX 清单及分发审计 | P1 | 未完成 |
| NFR-013 | 环境声明诚实性 | 移动端/多 OS 目标缺环境时记录未验证并给出原因，不以「未执行」宣称通过 | P1 | 未完成（S6 / ATS-605） |

## 4. 用例与基本业务流

**UC-01 导入**：输入路径→验证目录→验证项目配置→重复判定→登记→扫描测试→展示。异常：路径不存在、缺 package、缺 config、路径重复。

**UC-02 源码修改**：选择测试→获取内容和基线哈希→编辑→保存→确认 hash 未变化→写入→Git dirty 标志改变。异常：他人/外部程序先修改→拒绝覆盖，要求重新加载。

**UC-03 测试执行**：选择测试或全部→检查本地 CLI→记录 queued→spawn→running→收集报告/事件→passed/failed/cancelled/error→归档。异常：缺依赖、退出非零、失联重启。

**UC-04 质量追踪**：读取 `.aitest` 需求清单→展示 Req→Script 关系→关联最近 Run→查 Evidence（后两条 P1）。

## 5. 开始/结束条件与验收门槛

v0.1 的功能验收必须在实际 Windows 机器进行：导入一套真实 Playwright 仓库，成功运行至少一条 passing、一条 failing 和一次 cancel；能下载 HTML/JSON/Trace；修改任一 `.spec.ts` 后 Git dirty 正确，外部修改后不能覆盖；项目断网可继续操作。Node 自动化 UT/IT 全过只能算结构验证，不能代替实机 ST。
