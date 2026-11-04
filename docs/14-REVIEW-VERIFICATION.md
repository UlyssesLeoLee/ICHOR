# ATS-RV-001 設計・実装レビュー / 自审与验证记录

日期：2026-11-03；审查对象：v0.1 源码与 IPA 文档基线。

## 1. 对抗式设计审查

| 审查主题 | 风险或歧义 | 调优结果 | 剩余问题 |
|---|---|---|---|
| 误把流程图当权威代码 | 任意 TS 无损反写不可实现 | v0.1 严格只读；P1 限受控 AST 子集 | AST 决策未实现 |
| 误把静态索引当 Playwright --list | 动态测试被遗漏 | UI 明示 heuristic，原脚本仍完整 | P1 authoritative discovery |
| Git 和 DB 双源冲突 | 同一 script 两份内容 | 只直接操作原项目，运行历史分离 | 稳定 UID / data migration |
| 将子进程说成沙箱 | 恶意代码可读宿主文件 | 文档明确可信仓库、不可对公网开放 | P1 Docker/VM |
| 将模拟测试报告当真实 ST | 无 npm/浏览器无法端到端 | 20/20 UT/IT 通过，ST 全列 PENDING | 实机运行未验证；B-01 使真实链路 100% 失败 |
| AI 改断言导致假阳性 | 测试“自修复”掩盖 Bug | P1 AI 仅生成 Diff 候选 | 人工审核 UI 未实现；**Agent 契约 v1 已在能力层禁用 `update_expected`（ATS-401）** |
| Tauri + Next SSR 兼容性 | Tauri 原生不提供 Next SSR | output=export / 静态文件 | Next 构建已实测通过；Tauri 受 B-02 阻断 |
| 多版本发布与许可证 | 误认为 AGPL/GPL 可直接商用 | 只借鉴理念，源码原创 MIT | npm deps SPDX 审核待做 |
| Evidence 永久保存隐私风险 | Trace、视频可能含 PII | 每 Run 隔离 + 下载鉴权 + 风险标注 | 证据清理/脱敏 P1 |
| state.json 丢失/多实例冲突 | 本地历史损坏 | 单进程原子 state rename；服务重启恢复 interrupted | 多实例锁/SQLite P1；**B-03：恢复集合遗漏 `cancelling`，可致不可自愈的锁死** |

## 2. 实际运行验证

执行 `npm test`（Node v24.19.0）：**103 项 UT + IT 全部 PASS**，含 76 项 UT 与 27 项 IT；测试在隔离临时仓库/数据目录中运行，覆盖项目验证、静态扫描、来源限制、SHA-256 保存冲突、缺依赖处理、汇总解析、Origin/Token、安全 API、历史持久化，以及 Agent 契约的作用域、预算、输入出处、能力白名单、提案收敛与评审状态机。`node --check server/index.mjs` 通过。

**这些测试在 mock Playwright CLI 下执行**，只能证明 Bridge 自身逻辑，不足以证明真实浏览器链路可用——实测发现 B-01：Bridge 传给 Playwright Test CLI 的参数向量含两个不存在的选项，真实执行 100% 失败（`summary=null`、`artifacts=[]`）。

**环境实测结论（2026-11-03，ATS-101/SEIKOIST-146）**：

- **Next.js 16.4.4 静态导出构建实测成功**（产物 `apps/studio/out/`，可由 Bridge 伺服），npm registry 本次可达；
- **Cargo/Rust 实测已安装**（cargo 1.99.1、rustc 1.99.1，仅不在 PATH）；Tauri 编译失败已定位四个成因，且**成因清单尚未穷尽**：
  1. msvc 链缺 MSVC「使用 C++ 的桌面开发」工作负载（环境；本机无法验证其最终链接）；
  2. 仓库缺 `src-tauri/icons/icon.ico`（**仓库内容缺陷**，全新 clone 永远无法构建，仅装 MSVC 不能修复）；
  3. gnu 链的编译器与运行时库不匹配；
  4. gnu 链 cdylib 导出序号超限——补齐 `.ico` 并换成带完整运行时的 MinGW GCC 后，`cargo check` 通过，但 `cargo build` 在最终链接时报 `ld.exe: error: export ordinal too large: 90774`。
- **实测发现 3 项阻断缺陷**：B-01（真实浏览器执行 100% 失败）、B-02（Tauri 编译）、B-03（重启后 Run 卡在 `cancelling` 永久占锁）。

因此不得标记 ST Pass、也不能将 ZIP 描述为即装即用的 EXE。完整证据见 `docs/16-BASELINE-ADR.md` §4 与 `docs/evidence/ATS-101/`。

**Agent 契约 v1 的实测（2026-11-04，ATS-401/SEIKOIST-200）**：`npm test` 现为 **103 项全通过**（原有 20 项无回归，Agent 契约相关 83 项：68 项 `UT-AGT-*` 契约单元测试 + 15 项 `IT-AGT-*` API 集成测试），原始输出见 `docs/evidence/ATS-401/01-node-test.log`。权限边界另由 `tools/ats401-probes/probe-agent-boundary.mjs` 以三类独立信号复现：静态分析（契约层源码只 import `node:crypto`/`node:path` 且不含任何 I/O 调用——**这是静态检查，不是「物理上无法」**）、运行期（真实 git 夹具仓库在完整契约调用后内容、`git status`、`git log` 全部不变）、以及**负控**（11 份被注入 `node:fs`/`node:child_process`/`node:https`/裸 `fetch()`/动态 `import()`/`require()`/`process.getBuiltinModule`/`globalThis`/`WebSocket`/双引号 import 的源码副本，同一段判定逻辑必须报警），输出见 `docs/evidence/ATS-401/02-agent-boundary.log`。

**第 1 次复核（2026-11-04，Opus 驳回）的整改**：复核提交了三个反例脚本，指出 diff 目标作用域可被 rename/binary/mode/CRLF 绕过、I/O 判定器只匹配单引号 `from '...'`、`/api/agent/validate` 不复算摘要、截止时间在 provider 挂起时不生效、以及错误映射超出了 `AGENT_*` 范围。整改后新增 `tools/ats401-probes/probe-review-regressions.mjs`，把这些反例固化成五组断言（全部 PASS），输出见 `docs/evidence/ATS-401/05-review-regressions.log`；覆盖率实测见 `docs/evidence/ATS-401/04-coverage.log`（`server/agent.mjs` 行覆盖 82.17 % → **97.52 %**）。

**这一节不改变 FR-024/025 的能力状态**：仓库未接入模型提供商，也没有把模型输出写入仓库、更新 expected result 或创建 Git commit 的代码路径。已实现的是 FR-024/025 依赖的**契约层**，不是 AI 生成与诊断本身。详见 `docs/17-AGENT-CONTRACT.md`。

## 3. 当前验收结论

- **源码一致性 / Node API UT-IT：通过**（基于对应 103 个断言）。
- **基本工作台功能：具备零依赖便携 UI，可结合已有项目测试**。
- **Playwright Runner 实际浏览器执行：未通过产品源码验证，且已确认必然失败**（B-01：参数向量含两个不存在的 CLI 选项）。待 ATS-106 修复后重测 ST-008/011。
- **Next.js 编译：已实测通过**（16.4.4 静态导出，产物可由 Bridge 伺服）；**Tauri native：未通过**（B-02：msvc 链缺 MSVC C++ 工作负载；**仓库缺 `src-tauri/icons/icon.ico`（仓库内容缺陷，仅装 MSVC 不能修复）**；gnu 链 `cargo build` 最终链接因 cdylib 导出序号超限失败）。**成因清单尚未穷尽**，验收须以 `cargo build`（含最终链接）为准。待 ATS-104 修复后重测 ST-021/022。
- **P1/P2 能力：仅设计，不作实现交付承诺**。

## 4. 最终出厂检查

ZIP 应包含全部源码、docs 文档、测试用例 JSON+XLSX、README、示例项目和许可证；不包含 node_modules 与已安装浏览器。解压后在 Node22 环境 `npm test` 可验证核心逻辑；在可信实际 Playwright repo 上跑 ST 后才可升级 release 状态。
