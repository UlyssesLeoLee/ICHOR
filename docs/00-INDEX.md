# AI Test Studio — 文档总目录与版本基线

- 文档集合：ATS-2026-001
- 产品名称：AI Test Studio；实现版本 v0.1.0；长期目标 v1.0
- 基准日期：2026-11-03；文档语言：中文，IPA 工程术语保留日文
- 状态区分：`IMPLEMENTED` 为当前代码已实现；`DESIGNED` 为已设计未实现；`P1/P2` 为远期计划。所有测试记录必须与状态一致。

| 文件 | 文书类别 | 覆盖范围 |
|---|---|---|
| 01-RESEARCH-DECISIONS.md | 技术调査・设计决策 | 跨领域研究模式、取舍、ADR |
| 02-REQUIREMENTS.md | 要件定義書 | 业务要件、功能/非功能、验收 |
| 03-BASIC-DESIGN.md | 基本設計書 | UI、外部接口、组件与运行逻辑 |
| 04-DETAILED-DESIGN.md | 詳細設計書 | 接口、状态机、算法、异常处理 |
| 05-UI-UX.md | 画面設計書 | 信息架构、交互、操作反馈 |
| 06-DATA-DESIGN.md | 数据設計書 | 实体、文件、ER 与一致性 |
| 07-UT-TEST-DESIGN.md | 単体テスト設計書 | 断言、边界、异常与运行条件 |
| 08-IT-TEST-DESIGN.md | 結合テスト設計書 | Node API、文件、Runner 协作 |
| 09-ST-TEST-DESIGN.md | システムテスト設計書 | E2E/UAT、性能、安全、恢复 |
| 10-RTM.md | 追跡マトリクス | 要件-设计-测试-实现状态 |
| 11-SECURITY-RISK.md | セキュリティ・リスク | 威胁、鉴权、信任边界、隐私 |
| 12-DEPLOY-OPERATIONS.md | 運用設計書 | 启动、监控、备份、故障处理 |
| 13-ROADMAP.md | 開発計画書 | MVP/P1/P2、优先级、质量门禁 |
| 14-REVIEW-VERIFICATION.md | 設計・実装レビュー | 自审、已执行测试与未验证项 |
| 15-REFERENCES-LICENSES.md | 调査参考・ライセンス | 官方参考及许可证边界 |
| 16-BASELINE-ADR.md | 基线冻结・ADR | v0.1 已实现/待实测/未实现、3 项阻断、接口与构建约束清单 |
| 17-BUILD-CI.md | 構建・CI 基線 | ATS-102：锁文件、依赖清单、Windows CI 构建脚本与实测证据 |
| 22-FRONTEND-EXPORT.md | 前端交付・検証 | ATS-103：Next.js 16 静态导出构建、Bridge 静态提供与 API 契约实测、实测证据与未验证项 |
| 17-AGENT-CONTRACT.md | Agent 契約 | Agent 契约 v1：作用域、预算、输入出处、角色能力、提案与评审状态机、权限边界与实测证据 |
| 18-UID-SPEC.md | 稳定 UID 规范 | Project/TestDefinition/Run/Attempt 的标识符规则、迁移脚本与已知边界 |
| 18-RUNNER-ADAPTER-CONTRACT.md | Runner/Reporter 适配器契约 | ATS-301：适配器契约 v1、能力协商与拒绝规则 |
| 19-REMOTE-RUNNER-PROTOCOL.md | 远程协议・威胁模型 | S5 远程执行面的信任边界、认证、版本握手、租户隔离、拒绝规则（ADR-015~023，全部 DESIGNED） |
| 20-PARALLEL-ORCHESTRATION.md | 并行编排 | 多任务并行执行的编排约束 |
| 21-CONTROL-PLANE-API.md | 控制面 API・边界分离 | ATS-506：部署式控制面 API（`/cp/v1`）与桌面本地 API 的进程/端点/凭据/错误码分离、入站与出站边界规则、启动配置、桌面侧调用边界与实测证据 |
| 23-AI-DATA-SECURITY.md | AI 数据安全 | ATS-402：AI API Key 存储与数据外传知情授权（系统凭据库 + 引用式落盘、preview→confirm→grant 三步授权、平台侧复算内容摘要、错误码与实测证据；模型提供商未接入） |
| 21-PLUGIN-CONTRACT.md | 插件契約 | ATS-512 插件契约 v1：插件 Manifest、封闭权限清单、宿主策略档位、Runner SDK 操作面、审计与证据边界、协议样例（ADR-024~028；契约层已实现，插件宿主未实现） |
| dependencies/ | 依賴清單 | ATS-102 生成的依赖清单（机读 JSON + 人读 MD），由 lockfile 派生，可机读校验 |
| evidence/ | 実行証跡 | ATS-101/ATS-102/ATS-103/ATS-201/ATS-301/ATS-401/ATS-402/ATS-501/ATS-506/ATS-512 各结论的实际命令与输出（UT/IT、Runner 缺陷、构建约束、接口面、权限边界、构建门禁与可重现性、UID 规范、协议契约校验、前端静态导出与 Bridge API 契约、控制面边界、插件权限边界） |
| tools/ats101-probes/ | 再現スクリプト | ATS-101 全部阻断项与约束清单的仓库内可重跑复现脚本（见 `docs/evidence/ATS-101/`） |
| tools/ats201-probes/ | 再現スクリプト | ATS-201 稳定 UID 规范的可重跑验证脚本，含真实 Playwright 报告契约测试（见 `docs/evidence/ATS-201/`） |
| tools/ats401-probes/ | 再現スクリプト | ATS-401 权限边界的仓库内可重跑复现脚本（权限边界探针 + 第 1 次复核反例回归探针，含负控，见 `docs/evidence/ATS-401/`） |
| tools/ats501-probes/ | 検証スクリプト | ATS-501 远程协议契约的机读校验、负向夹具与 WBS 更新脚本的共存回归（见 `docs/evidence/ATS-501/`） |
| tools/ats103-probes/ | 検証スクリプト | ATS-103 静态导出 → Bridge → 会话/项目/运行 全链的可重跑验证脚本（见 `docs/evidence/ATS-103/`） |
| tools/ats506-probes/ | 検証スクリプト | ATS-506 控制面边界的负向夹具（8 个守护变异必须被对应用例捕获）与证据收集脚本（见 `docs/evidence/ATS-506/`） |
| tools/ats402-probes/ | 検証スクリプト | ATS-402 AI 数据安全边界的仓库内可重跑探针（秘密不进文件/argv/日志的静态检查、真实系统凭据库回读、外传闸门判定，每项均带负控，见 `docs/evidence/ATS-402/`） |
| tools/ats512-probes/ | 検証スクリプト | ATS-512 插件权限边界的仓库内可重跑探针（超权拒绝、审计不可抑制、证据不可伪造，含负控，见 `docs/evidence/ATS-512/`） |
| tools/ci_build_gate.mjs | 構建門禁 | ATS-102：本地逐步复现 CI workflow 的全部步骤（一条命令） |

## 依托方法与限制

本组文档的生命周期结构参考 IPA《共通フレーム2013》；非功能质量类别参考《非機能要求グレード》。IPA 并不就本项目颁发认证。质量验收按照项目自行定义的可验证条款执行。本次对标研究的完整材料见上次 Deep Research 结果，文档只提炼可落地的架构决策。

## 设计基线范围

P0：可信本地项目、Node Runner、Git 检测、常见静态测试索引、源码查看/编辑、执行/取消、JSON/HTML/Trace 附件归档、历史检索、最小需求关联。P1：AST 视图编辑、WDIO Tauri、SQLite、Agent 差异审批。P2：多用户/远程执行/沙箱/企业安全。

重要区别：**文档可以比代码超前，但不得将设计中的能力称为已实现。**
