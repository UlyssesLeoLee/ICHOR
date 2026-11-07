# ATS-ST-001 システムテスト設計書

> 设计总数：30；已执行通过：7；待执行/未实现：23。**PENDING 不是测试通过**。

系统测试需要真实 UI、Node、Playwright、Git、Windows/Tauri 和隐私/异常注入环境，已实机执行的用例在证据列写明执行脚本，其余仍待实机执行。UT/IT 自动化通过**不等同于** ST 验收。

## 测试设计清单

| ID | 关联要件 | 类别 | 测试内容 | 测试数据 / 前提 | 预期结果 | 证据/方法 | 状态 |
|---|---|---|---|---|---|---|---|
|ST-001|FR-001|功能|首次打开并添加项目|Windows 11, Playwright 已安装，选择已有 repo|工作台显示项目与测试，不复制测试文件|浏览器/录屏|PENDING|
|ST-002|FR-002|功能|Git 分支与 dirty 真实显示|develop 分支，修改已跟踪文件|branch/sha/dirty 与 Git CLI 一致|屏幕截图+git status|PENDING|
|ST-003|FR-005|可用性|按标题搜索测试|导入 100 用例，输入关键字|结果过滤准确、点击可打开|界面截图|PENDING|
|ST-004|FR-006|功能|代码查看与编辑|选择包含 fixture 的 TS 脚本|原代码完整展示，不丢语法内容|Git diff|PENDING|
|ST-005|FR-007|功能|修改后保存不自动 commit|改用例注释并点击保存|工作区文件改变，Git commit 未产生|git diff/日志|PENDING|
|ST-006|FR-019|异常|外部编辑冲突|UI 打开后 IDE 改源代码，再 UI 保存|明确冲突提示，不覆盖 IDE 修改|截图和文件哈希|PENDING|
|ST-007|FR-008|可用性|图形和复杂代码并存|goto+fill+expect+helper|可解释步骤显示，helper 不被丢弃|截图与原文件|PENDING|
|ST-008|FR-009|功能|执行全部 passing 项目|本地安装 Playwright 浏览器，正常访问示例站|Run passed、结果和 HTML 报告可下载|report.json/视频/trace|PENDING|
|ST-009|FR-010|功能|只执行指定脚本|同项目两文件，选一文件执行|只执行文件中测试|report.json|PENDING|
|ST-010|FR-011|异常|中断长测试|测试等待 60 秒，运行时点停止|标记 cancelled，不产生 false pass|events.jsonl|PENDING|
|ST-011|FR-014|功能|失败后仍可看证据|故意失败的 expect|可下载 JSON/HTML/trace.zip、截图|evidence manifest|PENDING|
|ST-012|FR-012|可靠性|多次重复执行不覆盖|同一个文件连续运行 3 次|3 个独立 run IDs + 历史报告|state.json|PENDING|
|ST-013|NFR-001|可靠性|离线工作|在断网情况下使用已安装依赖的本地 app|本地扫描与测试运行可用|录屏|PENDING|
|ST-014|NFR-002|安全|远程主机访问拒绝|同 LAN 他机尝试访问 4577|连接拒绝或无法访问 API|网络抓包|PENDING|
|ST-015|NFR-003|安全|路径穿越测试|请求 api Source/Artifact 越界|不能读取外部私密文件|HTTP log|PENDING|
|ST-016|NFR-004|完整性|证据哈希一致|完整 Run 导出证据文件|sha256 与 manifest 对应|本机 sha256sum|PENDING|
|ST-017|NFR-008|恢复|强制终止后重启|运行过程中强行停止 bridge|Run=interrupted，已完成历史不丢|node tools/ats207-probes/st-ats207.mjs（真实 Chromium，强杀整棵进程树）|PASS|
|ST-018|FR-017|功能|需求关系界面|导入附带 .aitest 的示例项目|显示 REQ-001/2 与用例映射|截图|PENDING|
|ST-019|NFR-006|性能|大仓库用例索引性能|500 tests / 100 files / SSD|目标 3 秒内（项目目标，待确认）|计时 log|PENDING|
|ST-020|NFR-007|兼容性|三 OS 便携 UI|Windows/macOS/Linux Node 22+|可启动并导入本地工程|测试记录|PENDING|
|ST-021|FR-020|兼容性|Next.js 静态构建|npm install 后运行 next build|静态 out 目录，浏览器可用|CI build log|PENDING|
|ST-022|FR-020|兼容性|Tauri Windows 开发构建|Windows+Rust+WebView2|桌面窗口打开，bridge 连接成功|编译+运行记录|PENDING|
|ST-023|NFR-009|隐私|数据不自动离开本地|操作工作台并抓包|未主动请求 AI/SaaS endpoints|网络流量|PENDING|
|ST-024|NFR-011|运行维护|错误信息可用于故障定位|停掉 server、损坏 state、缺 browser|明确错误而非模拟成功|录屏与日志|PENDING|
|ST-025|NFR-010|单实例|同一数据目录只允许一个 Bridge|真实 Bridge：A 服务时启动 B；两个 Bridge 同时启动|B 退出码 1 并报持有者；同时启动恰一个服务|node tools/ats207-probes/st-ats207.mjs|PASS|
|ST-026|NFR-010|恢复|崩溃后损坏文件的处理|零长度 state.json；损坏的 metadata.db|前者拒绝启动且文件不变；后者隔离并由 state.json 重建，历史完整|node tools/ats207-probes/st-ats207.mjs|PASS|
|ST-027|FR-016|功能|质量概览：失败/重试/取消分开计数|真实 Bridge + 真实 Playwright：一次真实失败运行、一次真实重试后通过、一次真实停止|失败计入失败桶、重试用例计入 flaky 桶、停止的运行计入 cancelled 且不计入失败与通过率|node tools/ats216-probes/st-ats216.mjs|PASS|
|ST-028|FR-016|功能|质量概览：指标与原始结果可核对|同一批真实运行的 summary 与用例列表|逐项对账全部一致；对账结论由模块与探针独立复算两次|node tools/ats216-probes/st-ats216.mjs|PASS|
|ST-029|FR-016|功能|两个界面共用同一份质量指标实现|便携 UI 与 Next 工作台|两者都 import 同一模块；Bridge 以 JavaScript MIME 提供该模块|node tools/ats216-probes/st-ats216.mjs|PASS|
|ST-030|FR-016|可靠性|质量指标的实现被破坏时测试变红|对模块做 7 个变异（取消算失败、flaky 算通过、对账恒真、聚类常量、丢重试计数、留 ANSI 码、忽略 attempt 数）|每个变异都被 UT 或 ST 抓住，无一漏网|node tools/ats216-probes/mutation-check.mjs|PASS|

## 进入与退出条件

- 进入：源码基线固定，目标环境、测试数据、执行账号和已知限制记录完整；优先执行异常/边界和安全阻断。
- 退出：P0 阻断级用例通过，失败有缺陷票和可复现证据；PENDING 逐条标注原因，不能简单计入通过。
- 每次复测必须关联修复 Git commit，并做受影响范围回归。
