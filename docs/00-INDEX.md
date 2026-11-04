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
| 17-AGENT-CONTRACT.md | Agent 契約 | Agent 契约 v1：作用域、预算、输入出处、角色能力、提案与评审状态机、权限边界与实测证据 |
| dependencies/ | 依賴清單 | ATS-102 生成的依赖清单（机读 JSON + 人读 MD），由 lockfile 派生，可机读校验 |
| evidence/ | 実行証跡 | ATS-101/ATS-401/ATS-102 各结论的实际命令与输出（UT/IT、Runner 缺陷、构建约束、接口面、权限边界、构建门禁与可重现性） |
| tools/ats101-probes/ | 再現スクリプト | ATS-101 全部阻断项与约束清单的仓库内可重跑复现脚本（见 `docs/evidence/ATS-101/`） |
| tools/ats401-probes/ | 再現スクリプト | ATS-401 权限边界的仓库内可重跑复现脚本（含负控，见 `docs/evidence/ATS-401/`） |
| tools/ci_build_gate.mjs | 構建門禁 | ATS-102：本地逐步复现 CI workflow 的全部步骤（一条命令） |

## 依托方法与限制

本组文档的生命周期结构参考 IPA《共通フレーム2013》；非功能质量类别参考《非機能要求グレード》。IPA 并不就本项目颁发认证。质量验收按照项目自行定义的可验证条款执行。本次对标研究的完整材料见上次 Deep Research 结果，文档只提炼可落地的架构决策。

## 设计基线范围

P0：可信本地项目、Node Runner、Git 检测、常见静态测试索引、源码查看/编辑、执行/取消、JSON/HTML/Trace 附件归档、历史检索、最小需求关联。P1：AST 视图编辑、WDIO Tauri、SQLite、Agent 差异审批。P2：多用户/远程执行/沙箱/企业安全。

重要区别：**文档可以比代码超前，但不得将设计中的能力称为已实现。**
