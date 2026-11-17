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
| 32-CASE-SEARCH-SELECTION.md | 用例检索・标签・过滤・批量运行选择设计书 | ATS-214：按用例名/文件/标签检索；多标签的「任一/全部」口径与可见标注；搜索与过滤按**交集**（集合语义）叠加；标签进入目录（静态索引读源码、权威索引读 CLI，实测逐条一致）；选择集合的自含快照、未知 UID 拒绝、按文件分组的批次链；「选了什么/跑了什么」对账；实测证据与已知边界 |
| 28-QUALITY-OVERVIEW.md | 质量概览设计书 | ATS-216：失败聚类/Flaky 基础指标（非 AI）；失败/重试/取消的分组、指标与原始结果的对账、确定性聚类与跨运行不稳定用例、两个界面共用一份实现、变异测试的可证伪性证据与已知边界 |
| 24-EXECUTION-MODEL.md | 执行模型设计书 | ATS-208：Run/Test/Attempt 与事件序号统一模型；重试不覆盖初次尝试、事件可按 run+sequence 复演；修复前的实测缺陷与修复后的对照、状态机与复演的接口面、实测证据与已知边界 |
| 23-AUTHORITATIVE-DISCOVERY.md | 权威发现设计书 | ATS-202：`playwright test --list` 权威索引、信任闸门（未可信仓库不可调用 `--list`）、身份阶梯、CLI 一致性的度量、实测证据与已知边界 |
| 24-STATE-MIGRATION.md | 状态迁移设计书 | ATS-206：v0.1 状态的安全导入迁移 CLI、计数一致性口径、备份与自动回滚、迁移内核的两条规则与已知边界 |
| 26-IDENTITY-MAPPER.md | 身份映射器设计书 | ATS-204：文件/标题变化时的 UID 重识别与歧义提示；运行侧按信号强度绑定的阶梯、整次运行才算得清的四件事、动态用例的锚点（位置 + 次序；次序 = CLI 的报告次序）、锚点不得覆盖已有身份的四条规则、显式 token 的重复判定在权威目录与静态目录上都传到运行侧、项目矩阵是一个用例（caseKey 带 describe 路径）、实测证据与已知边界 |
| 29-EVIDENCE-WORKBENCH.md | 证据工作台设计书 | ATS-215：Trace/附件定位与执行前后对照；从失败用例到 Trace 的两级定位（引擎记录为准、命名规则兜底）与定位失败的报告、归档时的摘要与文件时间（不重算摘要）、2 次点击预算的数法、执行前后对照的配对与"不同 commit 不可比"、两个界面共用一份实现、真实浏览器里的实测证据与已知边界 |
| 27-EVIDENCE-MANIFEST.md | 证据清单设计书 | ATS-209：Evidence Manifest、SHA-256、内容寻址去重与保留期清理；清单带所属运行与整组摘要、篡改可检出并指名文件、到期只删证据不删 Run 元数据、清理离线执行与审计日志、已知边界 |
| 18-RUNNER-ADAPTER-CONTRACT.md | Runner/Reporter 适配器契约 | ATS-301：适配器契约 v1、能力协商与拒绝规则 |
| 33-TRACEABILITY-GRAPH.md | 语义图谱 Schema 设计书 | ATS-307：Requirement→Design→TestCase→Script→Run→Evidence 追溯链；节点/边的稳定 UID・出所・Git commit、循环与孤児辺の検査、欠けた環の可視化（gap 語彙）、両方向 walk（join は run 経由）、カタログと実装の drift 検出；详见 docs/evidence/ATS-307/ |
| 19-REMOTE-RUNNER-PROTOCOL.md | 远程协议・威胁模型 | S5 远程执行面的信任边界、认证、版本握手、租户隔离、拒绝规则（ADR-015~023，全部 DESIGNED） |
| 20-PARALLEL-ORCHESTRATION.md | 并行编排 | 多任务并行执行的编排约束 |
| 29-REMOTE-SCHEDULING.md | 远程调度内核 | ATS-502：Job 队列/租约/心跳/幂等键/重试的实现与实测证据（ADR-024~034）；含租约 fencing、`running` 态回收与服务端租约上限；节点协议与执行仍未实现 |
| 21-CONTROL-PLANE-API.md | 控制面 API・边界分离 | ATS-506：部署式控制面 API（`/cp/v1`）与桌面本地 API 的进程/端点/凭据/错误码分离、入站与出站边界规则、启动配置、桌面侧调用边界与实测证据 |
| 21-PLUGIN-CONTRACT.md | 插件契約 | ATS-512 插件契约 v1：插件 Manifest、封闭权限清单、宿主策略档位、Runner SDK 操作面、审计与证据边界、**宿主持有的权威提案记录**、文件与项目两层作用域、协议样例（ADR-024~028；契约层已实现，插件宿主与沙箱未实现） |
| 23-AI-DATA-SECURITY.md | AI 数据安全 | ATS-402：AI API Key 存储与数据外传知情授权（系统凭据库 + 引用式落盘、preview→confirm→grant 三步授权、平台侧复算内容摘要、放行与拒绝都进外传审计、错误码与实测证据；模型提供商接入见 ATS-403） |
| 30-MODEL-ADAPTER.md | 模型 API 适配层 | ATS-403：可替换模型 API 适配器与错误回退（两种兼容协议、协议/传输/提供商/回退/编排五层分离、稳定的 AI_* 错误码与表驱动状态映射、可配置的回退顺序、密钥只在发请求时从凭据库取、外传闸门前置、失败不污染工作区；**未用真实模型与真实密钥端到端验证**） |
| 34-TRIAGE-DIAGNOSIS.md | 失败归因设计书 | ATS-410：失败归类（脚本/产品/环境/不确定，封闭集合）、每条推断附**可核对来源**（证据引用带可复算摘要、越界与不存在一律拒绝）、可疑变更（两次 commit 不同 + 同一用例 + 只看测试脚本）、差异建议**不含**修复动作、归因**只读**（不写文件/不改断言/不提交，Git 历史由注入的读取器提供）、**未用真实模型端到端验证** |
| 25-MOBILE-APP-TESTING.md | 移动端测试执行面 | S6 / v0.5.0：移动端目标抽象（设备/模拟器/远端会话）、Flow→TestDefinition 映射、Android Runner 与证据归档、能力矩阵与 iOS/Maestro 边界（ATS-601~606；ATS-601 的目标与会话**契约层**已实现并经 UT 实测，ATS-602 的导入映射层已实现并经 UT/IT 实测，ATS-606 的 iOS/Maestro 边界**已冻结并可机读复核**（§8 三张表；§8.5 整块由脚本生成，复核脚本逐字比对整块，并**把每一行的分组从 Maestro 字节码重新推导**与文档比对，并在**平台表上**核对 §8.3 的两条规则（等待不决定分组、配对命令两边都带配对——反向检查覆盖顶层条目与按变体分键的条目）——把一行挪到别的组必然变红，交付的负控台架有 M1–M10 十条（文档侧）与 T1–T3 三条（平台表侧）逐条必须变红），其余仍为 DESIGNED，仓库内无真实移动端执行，**也没有 iOS Runner**） |
| 26-RUNNER-PREFLIGHT.md | Runner 预检与参数安全基线 | ATS-106：Playwright CLI 运行前环境检测（CLI/版本/Node/依赖/浏览器/配置）的错误码与修复提示、请求体白名单、过滤参数校验与整条参数向量自检、不经 shell |
| 31-REAL-BROWSER-FIXTURE.md | 真实浏览器 PASS/FAIL 测试仓库 | ATS-107：独立工程夹具（依赖由入库 lockfile 精确固定）、真实 Chromium 上 1 PASS 1 FAIL、与独立 CLI 直跑逐条对账（判定/计数器/错误信息三项一致）、对账逻辑的变异负控（见 `docs/evidence/ATS-107/`） |
| 32-CREDENTIAL-STATUS.md | 凭据引用与可用状态 | ATS-213：**密钥仅以引用传递**（环境档案的凭据形状变量只接受**凭据引用**，运行启动时平台把引用解析成密钥注入**封口**的 runner 环境，档案/运行记录/事件日志/SQLite 镜像/证据归档里**只有引用与变量名、没有密钥**；引用解析不了即**拒绝启动**并报 `CREDENTIAL_*` 原因码）+ 系统凭据库集成之上的**可用状态面**（状态是三值闭集且每条引用恰有一个：已配置/未配置/取不到；**状态对系统凭据库实测而不从索引推断**；「未配置」与「取不到」不合并；取失败报封闭原因码而不静默降级；整张清单基于**同一份索引快照**，单条异常不拖垮整张清单；「凭据库已就绪」是**实测**的；状态**测不出来**时如实报读取失败、**清空**旧状态、**引用照样显示且删除按钮还在**；界面显示状态词与原因且不回显明文；并修掉「请求体解析失败回显密钥片段」这一真实泄漏。Windows Credential Manager **已实测**，macOS/Linux 后端未在真机实测，Tauri 壳内未验证——见 `docs/evidence/ATS-213/`） |
| dependencies/ | 依賴清單 | ATS-102 生成的依赖清单（机读 JSON + 人读 MD），由 lockfile 派生，可机读校验 |
| evidence/ | 実行証跡 | ATS-101/ATS-102/ATS-103/ATS-106/ATS-201/ATS-202/ATS-205/ATS-213/ATS-301/ATS-401/ATS-402/ATS-403/ATS-501/ATS-502/ATS-506/ATS-512/ATS-208/ATS-216 各结论的实际命令与输出（UT/IT、Runner 缺陷、构建约束、接口面、权限边界、构建门禁与可重现性、UID 规范、权威发现契约、协议契约校验、前端静态导出与 Bridge API 契约、控制面边界、插件权限边界、执行模型与事件复演、AI 数据安全：凭据存储与外传知情授权、凭据可用状态面与「请求体解析失败回显密钥片段」的泄漏修复、模型 API 适配层：协议翻译/错误分类/回退/密钥来源/工作区不变性、Runner 预检与参数安全基线：确定错误码与修复提示、请求体白名单与过滤参数校验） |
| tools/ats101-probes/ | 再現スクリプト | ATS-101 全部阻断项与约束清单的仓库内可重跑复现脚本（见 `docs/evidence/ATS-101/`） |
| tools/ats201-probes/ | 再現スクリプト | ATS-201 稳定 UID 规范的可重跑验证脚本，含真实 Playwright 报告契约测试（见 `docs/evidence/ATS-201/`） |
| tools/ats202-probes/ | 再現スクリプト | ATS-202 权威发现的真实 Playwright `--list` 契约测量（33 项断言，含「`--list` 会执行项目代码」这条安全事实，见 `docs/evidence/ATS-202/`） |
| tools/ats204-probes/ | 再現スクリプト | ATS-204 身份映射器的可重跑验证脚本：真实 Playwright CLI 的事实测量（每个 project 一行 spec、报告次序 ≠ 排序名次）、改动前的缺口、锚点、矩阵的两种报告形状、复核附的反例探针（review-r1/、review-r2/），以及在第一次交付与被驳回那棵树上的反例回归（见 `docs/evidence/ATS-204/`） |
| tools/ats401-probes/ | 再現スクリプト | ATS-401 权限边界的仓库内可重跑复现脚本（权限边界探针 + 第 1 次复核反例回归探针，含负控，见 `docs/evidence/ATS-401/`） |
| tools/ats501-probes/ | 検証スクリプト | ATS-501 远程协议契约的机读校验、负向夹具与 WBS 更新脚本的共存回归（见 `docs/evidence/ATS-501/`） |
| tools/ats502-probes/ | 検証スクリプト | ATS-502 调度内核的机读契约校验（46 项）、负控变异夹具（20 项）与第 1 轮复核反例回归探针（P1~P8 / H1~H5，同一脚本在被驳回树上 13/13 命中、修复后 0/13）（见 `docs/evidence/ATS-502/`） |
| tools/ats103-probes/ | 検証スクリプト | ATS-103 静态导出 → Bridge → 会话/项目/运行 全链的可重跑验证脚本：25 项 HTTP/运行时检查 + 真实 headless Chromium 的 8 项 UI 驱动检查 + 五变异证据（见 `docs/evidence/ATS-103/`） |
| tools/ats506-probes/ | 検証スクリプト | ATS-506 控制面边界的负向夹具（13 个守护变异必须被对应用例捕获）与证据收集脚本（见 `docs/evidence/ATS-506/`） |
| tools/ats402-probes/ | 検証スクリプト | ATS-402 AI 数据安全边界的仓库内可重跑探针（秘密不进文件/argv/日志的静态检查、真实系统凭据库回读、外传闸门判定、外传审计留痕，每项均带负控，见 `docs/evidence/ATS-402/`） |
| tools/ats213-probes/ | 検証スクリプト | ATS-213 凭据可用状态面的仓库内可重跑探针（凭据边界探针：密钥不进 argv/文件/日志/HTTP 响应，含 2 项负控；真实浏览器的系统测试：状态在界面上可见、删掉系统凭据库条目后状态由「已配置」变「未配置」、页面无明文；证据收集脚本，见 `docs/evidence/ATS-213/`） |
| tools/ats512-probes/ | 検証スクリプト | ATS-512 插件权限边界的仓库内可重跑探针（超权拒绝、审计不可抑制、证据不可伪造，含负控，见 `docs/evidence/ATS-512/`） |
| tools/ats216-probes/ | 検証スクリプト | ATS-216 质量概览的可重跑探针（真实 Bridge + 真实 Playwright 的系统测试、变异检查、证据收集脚本，见 `docs/evidence/ATS-216/`） |
| tools/ats208-probes/ | 検証スクリプト | ATS-208 执行模型的可重跑探针（重试用例的计数与 attempt 保留、事件流按 run+sequence 复演，含 Bridge 崩溃场景，见 `docs/evidence/ATS-208/`） |
| tools/ci_build_gate.mjs | 構建門禁 | ATS-102：本地逐步复现 CI workflow 的全部步骤（一条命令） |

## 依托方法与限制

本组文档的生命周期结构参考 IPA《共通フレーム2013》；非功能质量类别参考《非機能要求グレード》。IPA 并不就本项目颁发认证。质量验收按照项目自行定义的可验证条款执行。本次对标研究的完整材料见上次 Deep Research 结果，文档只提炼可落地的架构决策。

## 设计基线范围

P0：可信本地项目、Node Runner、Git 检测、常见静态测试索引、源码查看/编辑、执行/取消、JSON/HTML/Trace 附件归档、历史检索、最小需求关联。P1：AST 视图编辑、WDIO Tauri、SQLite、Agent 差异审批。P2：多用户/远程执行/沙箱/企业安全。

重要区别：**文档可以比代码超前，但不得将设计中的能力称为已实现。**
