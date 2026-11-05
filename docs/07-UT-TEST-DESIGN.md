# ATS-UT-001 単体テスト設計書

> 设计总数：93；已执行通过：76；待执行/未实现：17。**PENDING 不是测试通过**。

单体测试关注核心函数、API 输入校验、边界条件与报告转换。已通过用例直接对应 `tests/core.test.mjs`；其余为正式项目扩充用例，不能视为已经执行。

## 测试设计清单

| ID | 关联要件 | 类别 | 测试内容 | 测试数据 / 前提 | 预期结果 | 证据/方法 | 状态 |
|---|---|---|---|---|---|---|---|
|UT-CORE-001|FR-001|正常|有效 Playwright 项目路径|目录含 package.json 与 playwright.config.ts|返回规范 realpath|node --test|PASS|
|UT-CORE-002|FR-004|正常|静态发现 test()|tests/login.spec.ts 含一个 test 常量标题|解析出 1 个 title/file/line|node --test|PASS|
|UT-SEC-001|NFR-003|安全|阻断脚本路径越界|../../outside.spec.ts、README.md|拒绝读取，抛 INVALID/PATH 错误|node --test|PASS|
|UT-CORE-003|FR-007|边界|保存冲突处理|保存前旧 hash、再以旧 hash 写入|第二次保存被拒，旧内容不覆盖|node --test|PASS|
|UT-CORE-004|FR-001|异常|缺失 package.json|提供上级临时目录|抛 PROJECT_PACKAGE_JSON_REQUIRED|node --test|PASS|
|UT-RUN-001|FR-009|异常|项目没有 Playwright CLI|node_modules 无 CLI|不自动安装，抛 PLAYWRIGHT_NOT_INSTALLED|node --test|PASS|
|UT-RPT-001|FR-016|正常|报告摘要计数|JSON 含 expected/unexpected/skipped|总数3,通过1,失败1,跳过1|node --test|PASS|
|UT-CORE-005|NFR-005|清理|临时夹清理|准备好独立测试 fixture|测试后的临时夹可删除|node --test|PASS|
|UT-CORE-006|FR-003|边界|忽略 node_modules 中测试|仓库含 node_modules/test.spec.ts|不出现在测试清单|设计用例，待自动化|PENDING|
|UT-CORE-007|FR-004|边界|嵌套深度上限|超过 14 层的测试路径|安全终止扫描，不陷入递归|设计用例，待自动化|PENDING|
|UT-CORE-008|FR-004|边界|最大用例文件上限|大于 2000 个 *.spec.ts|索引数量有界并显示提示|设计用例，待自动化|PENDING|
|UT-CORE-009|FR-006|边界|读取大于 1MB 源文件|构造 1,000,001 bytes 源码|拒绝 SOURCE_TOO_LARGE|设计用例，待自动化|PENDING|
|UT-CORE-010|FR-007|异常|非 UTF-8 文件编辑|以破损字节填充 spec.ts|显示警告或拒绝破坏性保存|设计用例，待实现|PENDING|
|UT-RUN-002|FR-011|异常|重复停止已结束 Run|不存在 active job|返回 RUN_NOT_ACTIVE|设计用例，待自动化|PENDING|
|UT-RPT-002|FR-016|边界|缺少 suites 的空报告|JSON {}|total=0，无崩溃|设计用例，待自动化|PENDING|
|UT-RPT-003|FR-016|异常|报告 JSON 损坏|report.json 内容非法|保持 Run 状态并记录 reportWarning|设计用例，待自动化|PENDING|
|UT-SEC-002|NFR-003|安全|symlink 越界源码|tests/test.spec.ts 指向仓库外|禁止打开与保存|设计用例，待自动化|PENDING|
|UT-SEC-003|FR-015|安全|恶意附件文件路径|file=../../etc/passwd|拒绝下载|设计用例，待自动化|PENDING|
|UT-EVT-001|FR-018|正常|事件序列递增|queued→running→finished|序列号单调 +1，无覆写|设计用例，待自动化|PENDING|
|UT-DATA-001|NFR-010|异常|状态文件格式损坏|state.json 非 JSON|服务拒绝启动，提示备份恢复|设计用例，待自动化|PENDING|
|UT-GIT-001|FR-002|正常|非 Git 仓库|存在 package 和 playwright config，无 .git|branch detached/none,不阻断添加|设计用例，待自动化|PENDING|
|UT-GIT-002|FR-002|正常|dirty 状态变化|修改一份被追踪的 spec.ts|Git status dirty=true|设计用例，待自动化|PENDING|
|UT-UI-001|FR-020|交互|流程视图复杂代码保护|测试脚本存在条件循环/helper|不修改源文件，不显示可反向编辑能力|待前端测试|PENDING|
|UT-UI-002|FR-005|交互|搜索不区分大小写|标题 Login Flow，输入 login|匹配对应测试|待前端测试|PENDING|
|UT-UI-003|FR-013|交互|日志轮询恢复|首次请求失败，后端重启|显示可恢复错误，不清空历史结果|待前端测试|PENDING|
|UT-AGT-001|FR-024|正常|Agent 契约版本与角色集合|查询 describeAgentContract()|contract=agent-contract/v1，4 个角色固定|node --test|PASS|
|UT-AGT-002|FR-024|安全|任何角色都不持有写入/提交能力|遍历 4 个角色的能力集合|与 FORBIDDEN_CAPABILITIES 无交集|node --test|PASS|
|UT-AGT-003|FR-024|正常|作用域必须声明绝对根与输入目标|root 为相对路径 / 三类目标皆空|分别报 AGENT_SCOPE_INVALID / AGENT_SCOPE_REQUIRED|node --test|PASS|
|UT-AGT-004|FR-024|安全|作用域拒绝越出项目根的路径|files 含 ../../etc/passwd 或绝对路径|分别报 AGENT_SCOPE_ESCAPE / AGENT_SCOPE_INVALID|node --test|PASS|
|UT-AGT-005|FR-024|安全|作用域输出只能是测试脚本|outputs 含 playwright.config.ts|报 AGENT_SCOPE_OUTPUT_NOT_TEST_SCRIPT|node --test|PASS|
|UT-AGT-006|FR-024|正常|预算必须齐备且在平台上限内|缺预算 / 非整数 / 超上限|分别报 AGENT_BUDGET_REQUIRED / AGENT_BUDGET_INVALID|node --test|PASS|
|UT-AGT-007|FR-024|正常|输入出处必填且须落在作用域内|inputs 为空 / ref 不在 scope.files|分别报 AGENT_PROVENANCE_REQUIRED / AGENT_PROVENANCE_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-008|FR-024|正常|输入出处摘要须为 sha256 十六进制|digest 非 sha256 格式|报 AGENT_PROVENANCE_INVALID|node --test|PASS|
|UT-AGT-009|FR-024|安全|请求写入类能力一律被拒|requestedCapabilities 含 write_source/git_commit/update_expected/approve_proposal|均报 AGENT_CAPABILITY_FORBIDDEN|node --test|PASS|
|UT-AGT-010|FR-024|异常|不支持的契约版本被拒|contract=agent-contract/v2|报 AGENT_CONTRACT_UNSUPPORTED|node --test|PASS|
|UT-AGT-011|FR-024|异常|未知角色被拒|role=executor|报 AGENT_ROLE_UNKNOWN|node --test|PASS|
|UT-AGT-012|FR-024|安全|请求不能申请角色未授予的能力|role=triage/planner + propose_script_diff|报 AGENT_CAPABILITY_NOT_GRANTED|node --test|PASS|
|UT-AGT-013|FR-024|安全|diff 目标不在 scope.outputs 内被拒|diff 指向 tests/other.spec.ts|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-014|FR-024|安全|diff 指向非测试脚本被拒|diff 指向 playwright.config.ts|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-015|FR-024|安全|diff 越出项目根被拒|diff 指向 ../../../etc/outside.spec.ts|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-016|FR-024|安全|scope.outputs 不得声明越界路径|outputs 含 ../outside.spec.ts|报 AGENT_SCOPE_ESCAPE|node --test|PASS|
|UT-AGT-017|FR-025|安全|提案审批状态恒为 pending|模型输出含 approval=approved|平台侧强制为 pending，producedBy 取平台值|node --test|PASS|
|UT-AGT-018|FR-025|正常|脚本 diff 提案必须引用输入出处|evidenceRefs 为空|报 AGENT_PROPOSAL_INVALID|node --test|PASS|
|UT-AGT-019|FR-025|安全|提案人不得自审|reviewer 等于 producedBy|报 AGENT_REVIEW_SELF_FORBIDDEN|node --test|PASS|
|UT-AGT-020|FR-025|正常|仅 pending 提案可被评审|对已批准提案再次评审|报 AGENT_REVIEW_STATE_INVALID|node --test|PASS|
|UT-AGT-021|FR-024|安全|适配器构造时拒绝禁用能力|capabilities 含 write_source|报 AGENT_CAPABILITY_FORBIDDEN|node --test|PASS|
|UT-AGT-022|FR-024|安全|适配器拒绝角色未授予的能力|role=triage + propose_script_diff|报 AGENT_CAPABILITY_NOT_GRANTED|node --test|PASS|
|UT-AGT-023|FR-024|异常|适配器拒绝角色不匹配的请求|adapter=generator + role=triage|报 AGENT_ROLE_MISMATCH|node --test|PASS|
|UT-AGT-024|FR-024|安全|输入内容与摘要不符被拒|digest 与 content 不一致|报 AGENT_PROVENANCE_DIGEST_MISMATCH|node --test|PASS|
|UT-AGT-025|FR-024|异常|模型输出非 JSON 被拒|provider 返回非 JSON 文本|报 AGENT_PROVIDER_OUTPUT_INVALID|node --test|PASS|
|UT-AGT-026|FR-024|异常|模型输出超出预算被拒|provider 返回 200KB 文本|报 AGENT_BUDGET_EXCEEDED|node --test|PASS|
|UT-AGT-027|NFR-009|安全|未声明外传的输入不外传|egress.kinds 为空|provider 收到的 inputs 为空|node --test|PASS|
|UT-AGT-028|FR-024|正常|契约描述不含可写能力|describeAgentContract() 全量检查|forbiddenCapabilities 含 write_source，无角色持可写能力|node --test|PASS|
|UT-AGT-029|FR-024|安全|diff 里的 rename 被拒|合法 hunk 后追加 rename from/to|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-030|FR-024|安全|diff 里的 copy 被拒|合法 hunk 后追加 copy from/to|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-031|FR-024|安全|diff 里的 mode change 被拒|合法 hunk 后追加 old/new mode|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-032|FR-024|安全|CRLF diff 头部同样受作用域约束|头部行以 CR 结尾且指向作用域外|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-033|FR-024|安全|GIT binary patch 被拒|合法 hunk 后追加 binary patch|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-034|FR-024|安全|Binary files ... differ 被拒|合法 hunk 后追加二进制差异段|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-035|FR-024|安全|diff --git 头部的越界路径被拒|头部指向 scope.outputs 外的文件|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-036|FR-024|正常|允许在 scope.outputs 内新建测试脚本|--- /dev/null + new file mode 100644|提案被接受|node --test|PASS|
|UT-AGT-037|FR-024|安全|deleted file mode 被拒|合法 hunk 后追加 deleted file mode|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-038|FR-024|安全|非 100644 的 new file mode 被拒|new file mode 100755|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-039|FR-024|安全|请求校验层复算摘要|digest 与 content 不符|报 AGENT_PROVENANCE_DIGEST_MISMATCH|node --test|PASS|
|UT-AGT-040|FR-024|边界|预算四项上下限与 maxTokens|逐项越过平台上下限|报 AGENT_BUDGET_INVALID|node --test|PASS|
|UT-AGT-041|FR-024|边界|输入超出字节预算|maxInputBytes=10|报 AGENT_BUDGET_EXCEEDED|node --test|PASS|
|UT-AGT-042|FR-024|异常|provider 挂起时截止时间仍被强制施加|deadlineMs=1000，provider 永不返回|报 AGENT_BUDGET_EXCEEDED 且不等待 provider|node --test|PASS|
|UT-AGT-043|FR-024|异常|provider 抛错|complete() 抛 Error|报 AGENT_PROVIDER_ERROR，details.cause 为原消息|node --test|PASS|
|UT-AGT-044|FR-024|异常|provider 返回体没有 text|complete() 返回 { nope: true }|报 AGENT_PROVIDER_OUTPUT_INVALID|node --test|PASS|
|UT-AGT-045|FR-024|正常|provider 上下文带 AbortSignal|捕获 ctx.signal 与 ctx.deadlineAt|两者齐备|node --test|PASS|
|UT-AGT-046|FR-025|正常|提案 actions 的形状校验|type/target/value 逐一校验|非法 type 被拒，合法 actions 原样保留|node --test|PASS|
|UT-AGT-047|FR-025|边界|提案 confidence 的取值范围|1.5 与字符串被拒，0.8 接受|非法值报 AGENT_PROPOSAL_INVALID|node --test|PASS|
|UT-AGT-048|FR-024|安全|evidence 类出处必须属于 scope.runs|run id 不在 scope.runs 内|报 AGENT_PROVENANCE_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-049|FR-025|安全|evidenceRefs 必须来自请求出处|引用未声明的 ref|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-050|FR-024|安全|契约层源码不含 I/O 调用|静态分析 server/agent.mjs|无禁用模块、无禁用全局|node --test|PASS|
|UT-AGT-051|FR-024|边界|scope.projectId 的形状|空串、非字符串、超长|报 AGENT_SCOPE_INVALID|node --test|PASS|
|UT-AGT-052|FR-024|边界|出处各字段逐一校验|kind/ref/content/retrievedAt 非法|报 AGENT_PROVENANCE_INVALID|node --test|PASS|
|UT-AGT-053|FR-024|安全|run/requirement 类出处必须落在作用域内|ref 不在 scope.runs/requirements|报 AGENT_PROVENANCE_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-054|FR-024|边界|requestedCapabilities 与 egress.kinds 校验|非数组、超 16 项、空串、非法 kind|报 AGENT_REQUEST_INVALID|node --test|PASS|
|UT-AGT-055|FR-024|边界|带引号的 diff 路径与超长请求 id|git 引号包裹的路径被正确解包|引号路径被接受，超长 id 被拒|node --test|PASS|
|UT-AGT-056|FR-024|边界|diff 参数本身的校验|非字符串、空串、超长、非 unified diff|报 AGENT_PROPOSAL_INVALID|node --test|PASS|
|UT-AGT-057|FR-025|安全|非 script-diff 提案不得携带 diff|planner 提案带 diff / kind 不匹配|报 AGENT_PROPOSAL_INVALID|node --test|PASS|
|UT-AGT-058|FR-024|安全|diff 目标为绝对路径时被拒|--- /etc/passwd|报 AGENT_PROPOSAL_OUT_OF_SCOPE|node --test|PASS|
|UT-AGT-059|FR-025|边界|evidenceRefs 参数本身的校验|空串、超过 64 项|报 AGENT_PROPOSAL_INVALID|node --test|PASS|
|UT-AGT-060|FR-025|边界|提案必须是对象且 kind 与角色匹配|非对象、kind 与角色不符|报 AGENT_PROPOSAL_INVALID|node --test|PASS|
|UT-AGT-061|FR-025|安全|提案所需能力未被授予时拒绝|requestedCapabilities 为空|报 AGENT_CAPABILITY_NOT_GRANTED|node --test|PASS|
|UT-AGT-062|FR-024|异常|provider 与 adapter 的构造参数校验|空 id、非函数 complete、非法 role/capabilities|分别报 AGENT_PROVIDER_INVALID / AGENT_REQUEST_INVALID / AGENT_ROLE_UNKNOWN|node --test|PASS|
|UT-AGT-063|FR-024|安全|适配器拒绝自己未持有的能力|请求额外的能力|报 AGENT_CAPABILITY_NOT_GRANTED|node --test|PASS|
|UT-AGT-064|FR-024|正常|适配器的自描述|adapter.describe()|返回 id/role/capabilities/outputKind|node --test|PASS|
|UT-AGT-065|FR-025|边界|评审参数本身的校验|非对象提案、空 reviewer、非法 decision|分别报 AGENT_REVIEW_STATE_INVALID / AGENT_REVIEWER_INVALID|node --test|PASS|
|UT-AGT-066|FR-024|异常|provider 失败与超时的区分|provider 在 50ms 后抛错|报 AGENT_PROVIDER_ERROR|node --test|PASS|
|UT-AGT-067|FR-025|安全|自审检查不是精确字符串比较|producedBy=gen-1，reviewer 取 gen-1 / gen-1(空格) / GEN-1 / Gen-1|四种写法均报 AGENT_REVIEW_SELF_FORBIDDEN|node --test|PASS|
|UT-AGT-068|FR-025|安全|提案人必须由平台侧给出|context.producedBy 缺失或为空白|报 AGENT_PROPOSAL_INVALID|node --test|PASS|

## 进入与退出条件

- 进入：源码基线固定，目标环境、测试数据、执行账号和已知限制记录完整；优先执行异常/边界和安全阻断。
- 退出：P0 阻断级用例通过，失败有缺陷票和可复现证据；PENDING 逐条标注原因，不能简单计入通过。
- 每次复测必须关联修复 Git commit，并做受影响范围回归。
