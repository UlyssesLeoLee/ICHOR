# ADR 与跨领域产品亮点融入设计

## 1. 分析方法

不是直接复制竞品 UI，而是分离其可复用方法、实现约束、许可证条件与自身架构的适配面；采用“事实→设计推导→工程决策”三级记载。关注官方资源：Kestra、Bruno、OpenHands、Dagster、Backstage、Temporal、Allure、YShvydak、Playwright、Qase；Windmill/ComfyUI/n8n/Plane 只吸收交互范式。研究基准日 2026-11-03。

| 参考 | 亮点 | 转化为自研设计 | 当前状态 | 不照搬的部分 |
|---|---|---|---|---|
| Kestra | Code / No-code / Topology 多视图 | 源码/只读流程投影/执行记录统一按脚本定位；P1 AST Patch | 部分实现 | 任意 TS 无损画布编辑不现实 |
| Bruno | Local-first / 文件=事实 | 原仓库直接读取及保存，不建立第二脚本副本；密钥不上 Git | 已实现基本机制 | 不把运行历史塞入 Git |
| Dagster | Assets / lineage / checks | Requirement→Script→Run→Evidence 图谱和覆盖差异 | P0 JSON 展示；P1 完整 | 不做数据编排引擎 |
| OpenHands | Agent session / workspace / Action/Observation | AI 只输出候选 Patch，工具权限受控，单独 sandbox | 已设计 P1 | 不直接引入其完整服务 |
| Temporal | Event history / durable workflow | append-only events.jsonl，状态机阻断非法跳转 | 基础事件实现 | P0 不部署 Temporal 服务 |
| Backstage | Catalog / plugin / extension points | RunnerAdapter、ArtifactAdapter、AIProvider Adapter 接口 | 已设计 P1 | P0 不引入整套服务目录 |
| Allure | Result + attachment 开放模型 | Manifest、JSON report、原生 HTML 与 Trace | 已实现基础 | 不重新开发 Trace Viewer |
| Currents | Run/Test/Attempt、稳定性趋势 | 运行历史、报告解析，后续失败聚类 | 部分实现 | 不依赖闭源云服务 |
| Qase | Requirement traceability | 需求到用例的关联清单与未来 RTM | P0 只读 | 不迁移业务主数据到 SaaS |
| Windmill/ComfyUI | Subflow、node inspector、键盘图操作 | 规划 P1 React Flow 结构化编辑器 | 尚未实现 | 避免复制 GPL/AGPL 源码 |
| Autify / Stagehand | AI 视觉探索 | 未来补充 EXP exploratory run，候选结果需人工确认 | P2 | 不让 Agent 自动成为正式验收证据 |

## 2. 决策登记

- **ADR-001 源码主权**：Git 仓库是 requirements、test design、test script 的唯一 authoritative definition。已有 `.spec.ts` 无需转换；数据库为衍生索引/运行结果。理由：避免源代码与平台内部脚本出现冲突。状态：ACCEPTED。
- **ADR-002 双执行器**：Web 选 Playwright Test；桌面 Tauri 原生 WebView 选 WebdriverIO Tauri Service。v0.1 仅交付 Playwright Runner；WDIO 作为 P1 Adapter。理由：不重写驱动。状态：PARTIAL。
- **ADR-003 代码/图模型**：任意 TypeScript 只保证原始代码可编辑。P0 非破坏性正则语义投影为只读；P1 改用 TypeScript AST 支持受控子集。理由：复杂闭包、循环、fixture 不存在可逆通用 DSL。状态：PARTIAL。
- **ADR-004 事件与证据**：ExecutionEvent 必须追加，Run/Attempt 不覆盖旧结果；每次输出保留源 commit、环境、manifest、哈希。v0.1 有 JSONL + manifest SHA-256。状态：PARTIAL。
- **ADR-005 局部受控操作**：本地 HTTP 仅绑定 loopback，Origin allowlist + token。只允许可信项目，以进程形式运行，不声称容器级安全。状态：IMPLEMENTED with limitations。
- **ADR-006 AI 安全**：Planner/Generator/Healer 与 Reviewer 分离；未经审阅不得落 Git commit、更新 expected result 或关闭 defect。状态：DESIGNED。
- **ADR-007 UI 基线**：Next.js 16 静态导出 + Tauri 2 壳，开发验证另备零依赖 HTML；不要求 SSR。状态：源码已提供，离线未编译 UI/Tauri。
- **ADR-008 许可**：自研代码 MIT；第三方依赖分别审查。Windmill/ComfyUI/n8n/Plane 仅参考交互，避免直接复制受限制代码。状态：ACCEPTED。

## 3. 避免重复造轮子的边界

Playwright 已提供 browser management、Test CLI、JSON/HTML reporter、Trace Viewer；项目只处理调度、证据索引、脚本管理、追踪关联和增量智能能力。MVP 不开发浏览器驱动、DOM Inspector、AI 模型、分布式工作流引擎。所有超出现有能力的设计均在 roadmap 中显式列出。
