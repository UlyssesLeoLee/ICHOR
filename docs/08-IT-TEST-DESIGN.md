# ATS-IT-001 結合テスト設計書

> 设计总数：149；已执行通过：135；待执行/未实现：14。**PENDING 不是测试通过**。

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
|IT-AGT-010|FR-024|安全|摘要不符的请求在 API 端被拒|POST /api/agent/validate，digest 与 content 不符|400 + AGENT_PROVENANCE_DIGEST_MISMATCH|node --test|PASS|
|IT-AGT-011|FR-024|正常|AGENT_* 错误附带可机读的 details|maxSteps 超过平台上限|400 + details.field=maxSteps + details.limit=10|node --test|PASS|
|IT-AGT-012|FR-024|安全|错误响应不含本机路径|scope 越界请求|响应体中不含本地 root 或盘符路径|node --test|PASS|
|IT-AGT-013|NFR-011|异常|非 agent 错误保持 ATS-401 之前的行为|POST /api/projects 指向不存在的目录|500 + 原始 ENOENT 消息，无 agent details|node --test|PASS|
|IT-AGT-CLEANUP|NFR-005|清理|Agent API 子进程与夹清理|结束 IT suite|释放进程及临时目录|node --test|PASS|
|IT-PLG-SETUP|NFR-011|正常|插件契约 API 的 bridge 启动|隔离 ATS_DATA_DIR 与随机端口|/api/health=200 并取得 token|node --test|PASS|
|IT-PLG-001|FR-028|正常|插件契约经 API 暴露|GET /api/plugins/contract|200 + contract=plugin-contract/v1 + 权限清单 + SDK 操作面|node --test|PASS|
|IT-PLG-002|NFR-002|安全|插件端点需要会话 token|不带 X-ATS-Token GET /api/plugins/contract|401 INVALID_SESSION|node --test|PASS|
|IT-PLG-003|FR-028|正常|合法清单通过校验|POST /api/plugins/validate 合法清单|200 + valid=true + grantedPermissions 回显|node --test|PASS|
|IT-PLG-004|FR-028|安全|档位是权限上限|同一清单在 readonly 与 reporter 下校验|两个档位给出不同的 grantedPermissions|node --test|PASS|
|IT-PLG-005|FR-028|安全|禁止权限被拒|清单声明 source.write|400 + PLUGIN_PERMISSION_FORBIDDEN|node --test|PASS|
|IT-PLG-006|FR-028|安全|表外权限被拒|清单声明 files.delete|400 + PLUGIN_PERMISSION_UNKNOWN|node --test|PASS|
|IT-PLG-007|FR-028|异常|清单版本不支持被拒|contract=plugin-manifest/v2|400 + PLUGIN_MANIFEST_VERSION_UNSUPPORTED|node --test|PASS|
|IT-PLG-008|FR-028|安全|未知能力被拒|capabilities 含 teleport|400 + PLUGIN_CAPABILITY_UNKNOWN|node --test|PASS|
|IT-PLG-009|FR-028|异常|runner 缺必需能力被拒|capabilities 只含 discover|400 + PLUGIN_CAPABILITY_REQUIRED|node --test|PASS|
|IT-PLG-010|NFR-002|安全|错误响应不含本机路径|entry=C:/Windows/win.ini|400 + 响应体不含仓库路径|node --test|PASS|
|IT-PLG-011|NFR-005|安全|校验端点不加载也不运行任何东西|校验前后对比数据目录|目录内容不变|node --test|PASS|
|IT-PLG-012|FR-028|正常|诊断端点报告插件契约状态|GET /api/diagnostics|pluginContract.version=plugin-contract/v1，status=CONTRACT_ONLY|node --test|PASS|
|IT-PLG-013|NFR-011|异常|非插件错误保持 ATS-512 之前的行为|POST /api/projects 指向不存在的目录|500 + 原始 ENOENT 消息，无插件 details|node --test|PASS|
|IT-PLG-CLEANUP|NFR-005|清理|插件 API 子进程与夹清理|结束 IT suite|释放进程及临时目录|node --test|PASS|
|IT-DSC-SETUP|FR-021|正常|真实 Playwright 装入夹具|临时目录 npm install @playwright/test 1.64.1|node_modules/@playwright/test/cli.js 存在|node --test|PASS|
|IT-DSC-001|FR-021|正常|列举报告项目的用例|真实 CLI --list|得到 file/title/line 与 CLI 版本|node --test|PASS|
|IT-DSC-002|FR-021|正常|动态用例只在权威索引里|一个模板生成两个渲染标题|权威索引有两个，静态索引只有一个模板条目|node --test|PASS|
|IT-DSC-003|FR-021|正常|可信项目得到权威索引|信任状态 trusted|discovery=authoritative，动态用例 UID 互不相同|node --test|PASS|
|IT-DSC-004|FR-021|安全|未可信项目不调用 --list|夹具里放一个会写标记文件的 spec|未可信项目下标记文件不存在，attempted=false|node --test|PASS|
|IT-DSC-005|FR-021|安全|可信项目确实执行了列举|同一夹具，信任状态 trusted|标记文件存在（实测 --list 会执行仓库代码）|node --test|PASS|
|IT-DSC-006|FR-021|正常|与 CLI 的一致性被度量|权威与静态两个索引|consistency 报告只有权威可见的用例|node --test|PASS|
|IT-DSC-007|FR-021|正常|切换索引不改变已有 UID|先静态后权威|普通用例的 UID 相同|node --test|PASS|
|IT-DSC-008|FR-021|异常|坏配置回退并说明|playwright.config.ts 语法错误|discovery=static，outcome=FAILED，warning 含原因|node --test|PASS|
|IT-DSC-009|FR-021|安全|没有本地 CLI 时不安装|项目无 node_modules|outcome=PLAYWRIGHT_NOT_INSTALLED，node_modules 未被创建|node --test|PASS|
|IT-DSC-010|FR-021|边界|列举超时被单独报告|timeoutMs=1|outcome=PLAYWRIGHT_LIST_TIMEOUT，不与失败混淆|node --test|PASS|
|IT-DSC-011|FR-021|异常|CLI 报错时不是空索引|重名用例|outcome=FAILED，errors 含 duplicate test title|node --test|PASS|
|IT-DSC-API-001|FR-021|安全|项目初始为未可信|GET /api/projects/:id/trust|trust=untrusted，带原因|node --test|PASS|
|IT-DSC-API-002|FR-021|安全|未可信项目得到静态索引|GET /api/projects/:id/tests|discovery=static，outcome=SKIPPED_UNTRUSTED|node --test|PASS|
|IT-DSC-API-003|FR-021|异常|非法信任值被拒|POST trust {trust: maybe}|400 INVALID_TRUST_VALUE|node --test|PASS|
|IT-DSC-API-004|FR-021|安全|强制请求权威索引也被拒|GET /tests?authoritative=true（未可信）|仍为 static，warning 说明未可信仓库不可调用|node --test|PASS|
|IT-DSC-API-005|FR-021|正常|授予信任后索引切换|POST trust {trust: trusted}|discovery=authoritative，动态用例在索引里|node --test|PASS|
|IT-DSC-API-006|FR-021|正常|信任跨重启保留|重启 Bridge 后再读|trust 仍为 trusted|node --test|PASS|
|IT-DSC-API-007|FR-021|安全|撤销信任后回退|POST trust {trust: untrusted}|trust=untrusted 且索引回到 static|node --test|PASS|
|IT-DSC-CLEANUP|NFR-005|清理|临时夹与进程清理|结束 IT suite|释放进程及临时目录|node --test|PASS|
|IT-ENV-SETUP|NFR-011|正常|Bridge 启动以承载环境档案接口|隔离 ATS_DATA_DIR 与随机端口启动 server/index.mjs|/api/health=200 且拿到会话令牌|node --test|PASS|
|IT-ENV-001|FR-027|正常|登记一个项目|POST /api/projects 指向临时工程|201 且返回项目 id|node --test|PASS|
|IT-ENV-002|FR-027|安全|建立档案且响应只含变量名|POST 项目 /env 含 BASE_URL 与 TENANT|响应含 uid/name/environment；variables 为名称数组；不含值|node --test|PASS|
|IT-ENV-003|FR-027|正常|GET /env 列出档案与白名单|GET 项目 /env|profiles 含该档案；whitelist 报告来源；environments 为三个层级|node --test|PASS|
|IT-ENV-004|FR-027|安全|越界变量被拒绝且给出理由|POST 项目 /env 含 NOT_ON_THE_LIST|400 ENV_VARIABLE_NOT_ALLOWED 且 rejected 给出理由；档案未入库|node --test|PASS|
|IT-ENV-005|FR-027|安全|凭据形态变量被拒绝|PUT 白名单含 EXTRA_SETTING，POST 档案含 API_TOKEN|400 ENV_VARIABLE_NOT_ALLOWED，理由提到 credential|node --test|PASS|
|IT-ENV-006|FR-027|安全|授权凭据的白名单被拒绝且不生效|PUT 白名单含 DB_PASSWORD|400 INVALID_ENV_WHITELIST；原白名单保持不变|node --test|PASS|
|IT-ENV-007|FR-027|安全|运行记录所用档案与变量名|POST 项目 /run 带 env=staging|202；run 含 envUid/envName/envTier 与变量名数组；不含值|node --test|PASS|
|IT-ENV-008|FR-027|异常|引用不存在的档案的运行被拒绝|POST 项目 /run 带 env=no-such-profile|404 ENV_PROFILE_NOT_FOUND；未产生带档案的运行|node --test|PASS|
|IT-ENV-009|FR-027|安全|档案存于数据目录而不进项目|建立档案后扫描项目工程目录|项目目录文件数不变，且无文件含档案的值|node --test|PASS|
|IT-ENV-010|FR-027|回归|档案在 Bridge 重启后仍在|重启 Bridge 后 GET 项目 /env|档案仍在，变量名列表不变|node --test|PASS|
|IT-ENV-011|FR-027|正常|删除档案|DELETE 项目 /env?ref=staging|200；列表为空；再删为 404 ENV_PROFILE_NOT_FOUND|node --test|PASS|
|IT-ENV-CLEANUP|NFR-005|清理|环境档案 IT 子进程与夹清理|结束 IT suite|子进程退出，临时目录删除|node --test|PASS|
|IT-ENV-ADP-001|FR-027|安全|子进程收到档案变量而收不到宿主环境|fixture 工程装 fake Playwright CLI，宿主含伪装密钥|捕获的环境含 BASE_URL/TENANT，不含宿主密钥，含 PATH|node --test|PASS|
|IT-ENV-ADP-002|FR-027|正常|适配器的输出变量优先于档案|档案声明 PLAYWRIGHT_JSON_OUTPUT_FILE|捕获值为适配器指定的路径而非档案值|node --test|PASS|
|IT-ENV-ADP-003|FR-027|安全|没有档案时子进程环境仍被封口|不传档案，宿主含伪装密钥|捕获的环境不含宿主密钥，含 PATH 与报告路径|node --test|PASS|
|IT-ENV-ADP-004|FR-027|回归|封口不破坏引擎自身的契约|封口环境跑一次 fake CLI|适配器仍能收集到摘要，总数为 1|node --test|PASS|
|IT-ENV-ADP-005|FR-027|安全|列盘子进程不携带宿主环境|fixture 工程用 fake CLI 跑 test --list，宿主含伪装密钥|捕获的环境不含宿主密钥，含报告路径与 CI=1|node --test|PASS|
|IT-ENV-012|FR-027|正常|环境接口的 CORS 预检允许 DELETE|对环境接口发 OPTIONS 并带允许的 Origin|预检返回 204 且 Allow-Methods 含 DELETE|node --test|PASS|
|UT-ENV-057|FR-027|安全|能力探测不把宿主环境交给工程自带 CLI|probeCommand 跑工程目录下的脚本，宿主含伪装密钥|捕获的环境不含宿主密钥，含 PATH|node --test|PASS|
|IT-EVD-101|NFR-011|正常|证据 IT 的 bridge 启动|隔离 ATS_DATA_DIR 与随机端口|/api/health=200 并取得 token|node --test|PASS|
|IT-EVD-102|FR-015|正常|运行结束写出带归属与摘要的清单|跑一次真实（替身 CLI）运行|run 目录下有 manifest.json，带 runId、projectUid、sourceCommit 与每条证据的 sha256|node --test|PASS|
|IT-EVD-103|FR-015|正常|完好的证据集校验通过|刚跑完的运行|GET /api/runs/:id/evidence 返回 verified=true 且 missing 与 changed 为空|node --test|PASS|
|IT-EVD-104|FR-015|完整性|归档后被改动的文件经 API 被检出|改写归档后的 report.json|verified=false；changed 指出该文件与应有/实际两个摘要|node --test|PASS|
|IT-EVD-105|FR-015|正常|清单可经 API 读回|一个已结束的运行|GET /api/runs/:id/manifest 返回该运行的清单原文|node --test|PASS|
|IT-EVD-106|NFR-004|正常|保留期计划与去重报告可查|一个已结束的运行|GET /api/evidence/retention 与 /api/evidence/dedup 均 200 并带空间数字|node --test|PASS|
|IT-EVD-107|NFR-004|安全|Bridge 持锁时清理被拒绝|bridge 运行中执行清理命令|退出码 3，提示 Bridge 正在运行，证据未被删除|node --test|PASS|
|IT-EVD-108|NFR-004|完整性|清理删证据但保留 Run 元数据|停掉 bridge 后按 0 天清理|证据消失；state.json 里的 run 记录逐字段不变；事件日志与清单仍在|node --test|PASS|
|IT-EVD-109|NFR-004|完整性|清理后校验如实报告缺失|清理后再执行 verify|退出码 1 并报出缺失的文件|node --test|PASS|
|IT-EVD-110|NFR-005|清理|证据 IT 临时目录清理|结束 IT suite|临时目录删除|node --test|PASS|
|IT-CP-SETUP|NFR-011|正常|本地 Bridge 与控制面以纯 Node 进程并行启动|随机端口、隔离数据目录、dev-static 令牌|两者 health=200，取得本地会话 token|node --test|PASS|
|IT-CP-001|FR-028|正常|控制面无 Tauri 即可使用|GET /cp/v1/health 与 /cp/v1/contract|200，tauriRequired=false|node --test|PASS|
|IT-CP-002|NFR-002|安全|本地会话 Token 不是控制面凭据|X-ATS-Token、Bearer 本地 Token、二者并带|401 REMOTE_UNAUTHENTICATED|node --test|PASS|
|IT-CP-003|NFR-002|安全|控制面令牌不是本地凭据|以 X-ATS-Token / Bearer 出示控制面令牌调本地 /api/projects|401 INVALID_SESSION|node --test|PASS|
|IT-CP-004|FR-028|安全|控制面不服务本地端点|控制面上 GET /api/session、/api/projects 等|403 REMOTE_POLICY_REJECTED，不含本地 token|node --test|PASS|
|IT-CP-005|FR-028|安全|本地面不服务控制面端点|本地 Bridge 上 GET /cp/v1/health|404 静态响应，非控制面 JSON|node --test|PASS|
|IT-CP-006|FR-028|安全|登记请求携带本地路径被拒|Windows/UNC/POSIX/file:/编码/家目录/示例仓库绝对路径|422 REMOTE_PATH_FORBIDDEN|node --test|PASS|
|IT-CP-007|FR-028|安全|以路径或仓库地址代替 UID 被拒|path/root/repositoryUrl/workspace 字段；路径段与查询串|422 REMOTE_PATH_FORBIDDEN|node --test|PASS|
|IT-CP-008|NFR-002|安全|本地 Token 作为请求体值被拒|displayName/token/数组中放入本地会话 token|422 REMOTE_SECRET_INLINE_FORBIDDEN|node --test|PASS|
|IT-CP-009|FR-028|正常|按不透明 UID 登记与查询项目元数据|POST displayName，再按 UID 与列表读取|201 + prj UID，响应只有 projectUid/displayName/createdAt|node --test|PASS|
|IT-CP-010|FR-028|安全|跨租户 404 与客户端指定租户被拒|租户 B 读租户 A 项目；X-ATS-Tenant 指向他租户|404 REMOTE_RESOURCE_NOT_FOUND；403 REMOTE_TENANT_MISMATCH|node --test|PASS|
|IT-CP-011|NFR-002|安全|控制面响应不含本地路径与本地 Token|逐条扫描本套件收集的全部控制面响应|不含本地数据目录、本地项目路径、示例仓库路径、家目录、本地 token|node --test|PASS|
|IT-CP-012|FR-001|回归|本地 Bridge 仍按路径登记项目且控制面看不到|本地 POST /api/projects 示例仓库后查控制面列表|本地 201；控制面列表不含该项目|node --test|PASS|
|IT-CP-013|NFR-002|安全|控制面拒绝与本地 Bridge 共用端口|ATS_CP_PORT 等于 ATS_PORT 启动控制面|退出码 2，stderr 点名 ATS_CP_PORT|node --test|PASS|
|IT-ATS602-API-001|FR-032|正常|移动端用例出现在 API 提供的目录里|真实 Bridge + 含 Flow 的夹具项目|目录里 web 用例与 4 个移动端用例都在，移动端用例是 TestDefinition|node --test|PASS|
|IT-ATS602-API-002|FR-032|正常|移动端用例带着步骤与引擎|读取目录里的某个移动端用例|带 engine、appId、tags 与步骤，断言是统一模型的断言|node --test|PASS|
|IT-ATS602-API-003|FR-032|安全|导入报告随目录一起提供|读取目录的 mobile 段|每个 Flow 一个报告，不支持步骤带原文与行号与原因|node --test|PASS|
|IT-ATS602-API-004|FR-032|正常|告警写明有步骤不受支持|读取目录的 warning|告警写明导入的用例数与不受支持的步骤数|node --test|PASS|
|IT-ATS602-API-005|FR-032|正常|两种语法产出同一种用例|同一项目里一个 YAML Flow 与一个线性 Flow|两者步骤种类相同且字段形状相同|node --test|PASS|
|IT-ATS602-API-006|FR-032|正常|移动端用例的 UID 跨 Bridge 重启稳定|重启 Bridge 后重新读取目录|移动端用例的 uid 集合与重启前一致|node --test|PASS|
|IT-ATS602-API-007|FR-032|安全|移动端用例的 UID 与 web 用例不冲突|读取整个目录|没有两个用例共用一个 uid|node --test|PASS|
|IT-ATS602-API-008|FR-032|正常|没有 Flow 的项目没有移动端用例|登记一个只有 web 用例的项目|移动端用例数为 0|node --test|PASS|
|IT-ATS602-API-009|FR-032|正常|改标题后移动端用例的 UID 不变|经 HTTP 改写 Flow 的场景标题|UID 不变且 uidSource=registry|node --test|PASS|
|IT-ATS602-API-010|FR-032|安全|重复的 @TC- token 跨引擎由双方都不绑定|web 用例与移动端用例声明同一个 @TC-100|目录里没有重复 UID，双方都标 duplicate-explicit-uid|node --test|PASS|
|IT-ATS602-API-011|FR-032|正常|可信项目保留移动端用例|把项目标记为可信后重新读目录|discovery=authoritative 且移动端用例与 mobile 段都在|node --test|PASS|
|IT-CP-CLEANUP|NFR-005|清理|控制面 IT 子进程与夹清理|结束 IT suite|两个子进程退出，临时目录删除|node --test|PASS|
|IT-SQL-001|NFR-010|正常|Bridge 启动并创建元数据数据库|隔离 ATS_DATA_DIR 启动 server/index.mjs|数据目录出现 metadata.db|node --test|PASS|
|IT-SQL-002|NFR-010|正常|元数据库携带 schema 版本|读 metadata.db 的 meta 表|schema_version 大于 0|node --test|PASS|
|IT-SQL-003|NFR-010|正常|登记的项目出现在元数据库|POST /api/projects|projects 表有一行且 uid 非空|node --test|PASS|
|IT-SQL-004|NFR-010|正常|镜像与 JSON 状态一致|比对行数与 state.json|projects/runs/run_counters 行数相同|node --test|PASS|
|IT-SQL-005|NFR-010|回归|加入镜像后 Bridge 仍正常提供 API|GET /api/projects|200 且项目列表完整|node --test|PASS|
|IT-SQL-006|NFR-010|异常|持锁超时后镜像恢复|另一进程持写锁超过镜像的 busy_timeout|锁释放后 Bridge 继续镜像，verify 退出码 0|node --test|PASS|
|IT-SQL-CLEANUP|NFR-005|清理|元数据层 IT 子进程与夹清理|结束 IT suite|子进程退出，临时目录删除|node --test|PASS|
|IT-LOCK-001|NFR-010|单实例|第二个 Bridge 被拒|A 服务中，B 用同一数据目录、不同端口启动|B 退出码 1 并报锁路径与持有者 pid；A 仍服务；锁文件不变|node --test|PASS|
|IT-LOCK-002|NFR-010|并发|两个 Bridge 同时启动|同一新数据目录，重复 3 轮|每轮恰一个服务，另一个退出码 1|node --test|PASS|
|IT-LOCK-003|NFR-008|恢复|强杀后接管且运行为 interrupted|运行中的 Bridge 被强杀|下一个 Bridge 接管陈旧锁；run=interrupted，复演一致|node --test|PASS|
|IT-LOCK-004|NFR-010|正常|ATS_LOCK_WAIT_MS 等待取锁|A 持锁时启动 B（等待 20 秒），随后强杀 A|B 等待期间不服务，A 退出后 B 启动并持锁|node --test|PASS|
|IT-LOCK-005|NFR-010|安全|锁被他人占用的 Bridge 停止|运行中把锁改写成他人的记录|Bridge 退出码 1，报 lost the data directory lock，不删他人的锁|node --test|PASS|
|IT-LOCK-006|NFR-010|恢复|锁文件被删后重新取锁|运行中删除 bridge.lock|锁文件重现并记本 Bridge 的 pid，Bridge 仍服务|node --test|PASS|
|IT-DATA-001|NFR-010|异常|损坏的状态文件拒绝启动|非 JSON / 零长度的 state.json|退出码 1，报 STATE_CORRUPT 与恢复步骤；文件不变；锁已释放|node --test|PASS|
|IT-DATA-002|NFR-010|可靠性|写入中强杀不留残缺状态|循环保存的进程被强杀 12 次|每次 state.json 都是完整的一代；之后 Bridge 启动清理临时文件且镜像一致|node --test|PASS|
|IT-WAL-001|NFR-010|恢复|事务中强杀后 WAL 只恢复已提交的行|50 行已提交在 WAL，另 50 行未提交时强杀|integrity_check=ok，已提交的 50 行在、未提交的不在|node --test|PASS|
|IT-WAL-002|NFR-010|恢复|Bridge 隔离并重建损坏的镜像|metadata.db 为乱码|报 quarantined，保留损坏副本，重建的镜像与 state.json 一致|node --test|PASS|

## 进入与退出条件

- 进入：源码基线固定，目标环境、测试数据、执行账号和已知限制记录完整；优先执行异常/边界和安全阻断。
- 退出：P0 阻断级用例通过，失败有缺陷票和可复现证据；PENDING 逐条标注原因，不能简单计入通过。
- 每次复测必须关联修复 Git commit，并做受影响范围回归。
