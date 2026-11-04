# ATS-IT-001 結合テスト設計書

> 设计总数：37；已执行通过：23；待执行/未实现：14。**PENDING 不是测试通过**。

结合测试关注 HTTP 会话→Git/文件→Runner→事件与存储的连接。已通过用例对应 `tests/api.test.mjs`；实际 Playwright Runner 的跨组件验证依赖安装目标仓库依赖和浏览器。

## 测试设计清单

| ID | 关联要件 | 类别 | 测试内容 | 测试数据 / 前提 | 预期结果 | 证据/方法 | 状态 |
|---|---|---|---|---|---|---|---|
|IT-API-SETUP|NFR-011|正常|Node bridge 成功监听|使用隔离 ATS_DATA_DIR 和随机端口|/api/health=200|node --test|PASS|
|IT-SEC-001|NFR-002|安全|未鉴权访问项目 API|不带 X-ATS-Token GET /api/projects|401 INVALID_SESSION|node --test|PASS|
|IT-API-001|FR-001|正常|项目登记整合|POST 有效示例仓库路径|201 + project UUID|node --test|PASS|
|IT-API-002|FR-004|正常|跨模块脚本发现|GET 示例仓库 /tests|2 个示例用例|node --test|PASS|
|IT-SEC-002|NFR-002|安全|跨站 Origin 防护|Origin=https://evil.example 调 /session|403 ORIGIN_NOT_ALLOWED|node --test|PASS|
|IT-RUN-001|FR-009|异常|缺依赖时运行反馈|POST /run，示例仓库没 node_modules|Run status=error，未执行 npm install|node --test|PASS|
|IT-API-003|FR-012|正常|持久 Run 历史|GET /api/runs|可查到刚生成的 Run|node --test|PASS|
|IT-API-CLEANUP|NFR-005|清理|子进程和夹清理|结束 API test suite|释放进程及测试临时目录|node --test|PASS|
|IT-RUN-002|FR-009|正常|真实 Playwright 成功运行|已安装浏览器、本地项目 1 条 passing|Run passed，report.json + trace|需真实 Playwright|PENDING|
|IT-RUN-003|FR-009|异常|真实 Playwright 失败运行|目标 test 内断言故意失败|Run failed，错误与截图归档|需真实 Playwright|PENDING|
|IT-RUN-004|FR-011|异常|运行中停止|慢速执行场景，POST /stop|cancelling→cancelled，不误报 passed|需真实 Playwright|PENDING|
|IT-RUN-005|FR-012|异常|服务重启恢复|执行时 kill Node bridge|重启标记 interrupted 且保留事件|需异常注入|PENDING|
|IT-EVT-001|FR-018|正常|事件与 Run 对应|任意完整 Run|事件 seq 与 runId 一致|需集成事件校验|PENDING|
|IT-EVD-001|FR-015|正常|下载 evidence|完整 Run 产生 trace.zip|下载字节哈希与 Manifest 一致|需真实 Playwright|PENDING|
|IT-EVD-002|FR-015|安全|Run 附件 symlink 越界|将附件软链接指向外部|403/400 拒绝下载|需构造夹|PENDING|
|IT-SRC-001|FR-007|正常|UI/API 文件保存|读取→编辑→PUT 携带 baseHash|原仓库保存成功并产生 Git dirty|需真实 repo|PENDING|
|IT-SRC-002|FR-019|异常|并发保存冲突|A/B 同时读，同一文件先后写|第二次保存拒绝、代码不覆盖|需并发控制|PENDING|
|IT-SRC-003|FR-006|安全|不可编辑配置文件|请求 playwright.config.ts|被拒绝|可自动化|PENDING|
|IT-LIN-001|FR-017|正常|需求关联读取|加载 .aitest/requirements.json 与 links|原样返回两类结构|可自动化|PENDING|
|IT-UI-001|FR-020|正常|Next UI 与 Bridge CORS|localhost:3000 + 4577|页面 API 可正常请求|需 npm 依赖|PENDING|
|IT-TAU-001|FR-020|环境|Tauri shell 启动 bridge|本地 Rust Node PATH 均安装|Next 静态 UI 能连接 bridge|需 Rust/Tauri|PENDING|
|IT-RUN-MOCK-SETUP|FR-009|测试双桩|启动模拟 Runner CLI|隔离项目 + 假 CLI，不是 Playwright|Runner bridge 能启动本地模拟进程|node --test (mock)|PASS|
|IT-RUN-MOCK-001|FR-014|测试双桩|模拟成功报告归档链|假 CLI 生成 JSON/HTML/fixture trace|Run passed，Event 递增，Manifest/附件可查询|node --test (mock)|PASS|
|IT-RUN-MOCK-002|FR-011|测试双桩|模拟取消运行|假 CLI 延迟退出，POST /stop|终态 cancelled，不误报 passed|node --test (mock)|PASS|
|IT-RUN-MOCK-CLEANUP|NFR-005|测试双桩|模拟服务清理|关闭模拟服务与临时目录|临时数据清除，主仓库未受影响|node --test (mock)|PASS|
|IT-API-004|NFR-002|安全|错误 Host 拒绝|Host=evil.example:4577|403 INVALID_HOST|可自动化|PENDING|
|IT-AGT-SETUP|NFR-011|正常|Agent 契约 API 的 bridge 启动|隔离 ATS_DATA_DIR 与随机端口|/api/health=200 并取得 token|node --test|PASS|
|IT-AGT-001|FR-024|正常|契约描述经 API 暴露|GET /api/agent/contract|200 + contract=agent-contract/v1 + 禁用能力清单|node --test|PASS|
|IT-AGT-002|NFR-002|安全|契约端点需要会话 token|不带 X-ATS-Token GET /api/agent/contract|401 INVALID_SESSION|node --test|PASS|
|IT-AGT-003|FR-024|正常|合法请求通过契约校验|POST /api/agent/validate 合法请求|200 + valid=true + 输入出处摘要回显|node --test|PASS|
|IT-AGT-004|FR-024|安全|写入类能力请求被拒|requestedCapabilities 含 write_source|400 + AGENT_CAPABILITY_FORBIDDEN|node --test|PASS|
|IT-AGT-005|FR-024|安全|缺预算的请求被拒|请求体无 budget|400 + AGENT_BUDGET_REQUIRED|node --test|PASS|
|IT-AGT-006|FR-024|安全|缺输入出处的请求被拒|请求体 inputs 为空|400 + AGENT_PROVENANCE_REQUIRED|node --test|PASS|
|IT-AGT-007|FR-024|安全|越界作用域被拒|scope.files 含 ../../outside.spec.ts|400 + AGENT_SCOPE_ESCAPE|node --test|PASS|
|IT-AGT-008|FR-024|安全|校验请求不写入项目|校验前后对比夹具文件内容|内容不变，工作区无副作用|node --test|PASS|
|IT-AGT-009|FR-024|正常|诊断端点报告契约状态|GET /api/diagnostics|agentContract.version=agent-contract/v1，status=CONTRACT_ONLY|node --test|PASS|
|IT-AGT-CLEANUP|NFR-005|清理|Agent API 子进程与夹清理|结束 IT suite|释放进程及临时目录|node --test|PASS|

## 进入与退出条件

- 进入：源码基线固定，目标环境、测试数据、执行账号和已知限制记录完整；优先执行异常/边界和安全阻断。
- 退出：P0 阻断级用例通过，失败有缺陷票和可复现证据；PENDING 逐条标注原因，不能简单计入通过。
- 每次复测必须关联修复 Git commit，并做受影响范围回归。
