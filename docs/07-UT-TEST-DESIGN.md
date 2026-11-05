# ATS-UT-001 単体テスト設計書

> 设计总数：252；已执行通过：235；待执行/未实现：17。**PENDING 不是测试通过**。

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
|UT-PLG-001|FR-028|正常|插件契约与清单版本固定|describePluginContract()|contract=plugin-contract/v1，manifest=plugin-manifest/v1|node --test|PASS|
|UT-PLG-002|FR-028|正常|合法清单被归一化|合法 Manifest|字段归一化，permissions/capabilities 为数组|node --test|PASS|
|UT-PLG-003|FR-028|异常|不支持的清单版本被拒|contract=plugin-manifest/v2|报 PLUGIN_MANIFEST_VERSION_UNSUPPORTED|node --test|PASS|
|UT-PLG-004|FR-028|异常|清单字段形状不对被拒|id/version/kind/entry/publisher 各自非法|报 PLUGIN_MANIFEST_INVALID|node --test|PASS|
|UT-PLG-005|FR-028|安全|禁止权限一律被拒|声明 source.write / audit.suppress / evidence.skip 等|报 PLUGIN_PERMISSION_FORBIDDEN|node --test|PASS|
|UT-PLG-006|FR-028|安全|词汇表外的权限被拒|声明 files.delete|报 PLUGIN_PERMISSION_UNKNOWN|node --test|PASS|
|UT-PLG-007|FR-028|边界|重复权限被拒|permissions 含两个 test.read|报 PLUGIN_MANIFEST_INVALID|node --test|PASS|
|UT-PLG-008|FR-028|安全|能力必须在 ATS-301 词汇表内|capabilities 含 teleport|报 PLUGIN_CAPABILITY_UNKNOWN|node --test|PASS|
|UT-PLG-009|FR-028|异常|runner 插件必须声明四个必需能力|capabilities 只含 discover|报 PLUGIN_CAPABILITY_REQUIRED|node --test|PASS|
|UT-PLG-010|FR-028|正常|非 runner 插件无需能力|kind=reporter，capabilities 为空|校验通过|node --test|PASS|
|UT-PLG-011|FR-028|正常|生效权限是声明与档位的交集|observer 档位申请三项|granted 为交集|node --test|PASS|
|UT-PLG-012|FR-028|安全|超出档位的权限被拒|readonly 档位申请 evidence.read|granted 不含它，denied 记 not-in-tier|node --test|PASS|
|UT-PLG-013|FR-028|安全|插件不能靠声明抬高自己的权限|同一份声明在三个档位下|三个档位给出三个不同的生效集合|node --test|PASS|
|UT-PLG-014|FR-028|安全|禁止权限的拒绝原因是 forbidden|声明 source.write|denied 记 forbidden 而非 not-in-tier|node --test|PASS|
|UT-PLG-015|FR-028|安全|表外权限的拒绝原因是 unknown|声明 files.delete|denied 记 unknown|node --test|PASS|
|UT-PLG-016|FR-028|安全|每个档位都是词汇表的子集|遍历全部档位|无档位授予表外权限|node --test|PASS|
|UT-PLG-017|FR-028|安全|没有档位授予禁止权限|遍历全部档位|与禁止清单无交集|node --test|PASS|
|UT-PLG-018|FR-028|正常|操作按其权限授权|声明 test.read|readTestFile 允许，readRunEvidence 拒绝并给理由|node --test|PASS|
|UT-PLG-019|FR-028|异常|未知操作不被授权|调用 deleteEverything|allowed=false 并列出已知操作|node --test|PASS|
|UT-PLG-020|FR-028|正常|describe 不需要权限|permissions 为空|describe 仍被允许|node --test|PASS|
|UT-PLG-021|FR-028|正常|SDK 的操作面与声明完全相等|比较 SDK 键与操作表|两者集合相等|node --test|PASS|
|UT-PLG-022|FR-028|安全|SDK 是冻结的，插件不能加方法|给 sdk 赋值新方法|抛 TypeError|node --test|PASS|
|UT-PLG-023|FR-028|正常|describe 回报生效与被拒权限|声明两项、档位只给一项|grantedPermissions 与 deniedPermissions 正确|node --test|PASS|
|UT-PLG-024|FR-028|安全|超出档位的操作被拒|readonly 档位调用 readRunEvidence|报 PLUGIN_PERMISSION_DENIED|node --test|PASS|
|UT-PLG-025|FR-028|安全|被拒的调用同样进审计|制造一次被拒调用|审计 sink 收到 plugin.operation.denied|node --test|PASS|
|UT-PLG-026|FR-028|正常|审计序号单调且与 sink 一致|连续两次调用|sink 收到 seq 1、2|node --test|PASS|
|UT-PLG-027|FR-028|安全|插件不能自选审计序号|一次调用后检查事件|seq 由 SDK 分配，pluginId 与 type 正确|node --test|PASS|
|UT-PLG-028|FR-028|安全|作用域外的文件读不到|读 server/index.mjs|报 PLUGIN_SCOPE_INVALID|node --test|PASS|
|UT-PLG-029|FR-028|安全|没有作用域时什么都读不到|不传 scope|报 PLUGIN_SCOPE_INVALID|node --test|PASS|
|UT-PLG-030|FR-028|安全|清单不能扩大自己的作用域|Manifest 里塞 scope 字段|宿主 scope 仍然生效|node --test|PASS|
|UT-PLG-031|FR-028|安全|没有证据就不许上报结论|evidenceRefs 为空|报 PLUGIN_EVIDENCE_REQUIRED|node --test|PASS|
|UT-PLG-032|FR-028|安全|证据摘要由宿主计算|宿主 resolver 返回固定摘要|提案里的 sha256 等于宿主算出的值|node --test|PASS|
|UT-PLG-033|FR-028|安全|插件自带的摘要不被接受|evidenceRefs 传 {ref,sha256}|报 PLUGIN_PROPOSAL_INVALID|node --test|PASS|
|UT-PLG-034|FR-028|安全|结论是提案而不是改状态|reportOutcome 返回值|approval=pending，producedBy=plugin:<id>|node --test|PASS|
|UT-PLG-035|FR-028|异常|非法 status 被拒|status=not-a-status|报 PLUGIN_PROPOSAL_INVALID|node --test|PASS|
|UT-PLG-036|FR-028|安全|上报结论也进审计|调用 reportOutcome|审计 sink 收到 plugin.outcome.reported|node --test|PASS|
|UT-PLG-037|FR-028|安全|提案人不得自审|reviewer 等于 producedBy|报 PLUGIN_REVIEW_SELF_FORBIDDEN|node --test|PASS|
|UT-PLG-038|FR-028|安全|自审检查不是精确字符串比较|reviewer 取带空格/大写写法|四种写法均报 AGENT_REVIEW_SELF_FORBIDDEN 对应码|node --test|PASS|
|UT-PLG-039|FR-028|正常|独立评审人可以批准|reviewer 与提案人不同|approval=approved 且内容不变|node --test|PASS|
|UT-PLG-040|FR-028|异常|仅 pending 提案可被评审|对已批准提案再次评审|报 PLUGIN_REVIEW_STATE_INVALID|node --test|PASS|
|UT-PLG-041|FR-028|异常|非法评审结论被拒|decision=maybe|报 PLUGIN_REVIEW_STATE_INVALID|node --test|PASS|
|UT-PLG-042|FR-028|正常|契约描述完整且不夸大|describePluginContract()|权限/禁止/档位/操作/错误码齐全，designStatus=CONTRACT_ONLY|node --test|PASS|
|UT-PLG-043|FR-028|正常|每个 SDK 操作所需权限都在词汇表内|遍历操作表|无操作需要表外或禁止权限|node --test|PASS|
|UT-PLG-044|FR-028|正常|契约描述不声称宿主存在|describePluginContract().designStatus|等于 CONTRACT_ONLY|node --test|PASS|
|UT-PLG-045|FR-028|正常|错误码清单与实际抛出的码一致|比对两个模块源码与清单|两个方向都完全相等|node --test|PASS|
|UT-PLG-046|FR-028|异常|宿主不完整时拒绝构造 SDK|缺 audit / 缺 readTestFile|分别报 PLUGIN_AUDIT_REQUIRED / PLUGIN_MANIFEST_INVALID|node --test|PASS|
|UT-PLG-047|FR-028|安全|有权限也读不到作用域外的文件|scope 只给一个文件|同目录另一个文件报 PLUGIN_SCOPE_INVALID 且被审计|node --test|PASS|
|UT-PLG-048|FR-028|安全|绝对路径一律被拒|读 C:/Windows/win.ini|报 PLUGIN_SCOPE_INVALID|node --test|PASS|
|UT-PLG-049|FR-028|安全|作用域由宿主给而不是清单给|宿主 scope 为空、清单申请全部权限|仍读不到任何文件|node --test|PASS|
|UT-PLG-050|FR-028|安全|SDK 自己不碰文件系统|检查 sdk.mjs 源码|不 import node:fs / node:child_process，不 spawn|node --test|PASS|
|UT-PLG-051|FR-028|安全|禁止权限永不出现在生效集合里|每个档位下解析全量申请|granted 与禁止清单无交集|node --test|PASS|
|UT-PLG-052|FR-028|正常|SDK 没有写任何文件|检查临时夹目录|目录为空|node --test|PASS|
|UT-SQL-001|NFR-010|正常|元数据层在当前 Node 构建上可用|node:sqlite 无需 flag|sqliteAvailable() 为 true|node --test|PASS|
|UT-SQL-002|NFR-010|正常|数据库以 WAL 模式运行|在临时目录打开 metadata.db|PRAGMA journal_mode = wal|node --test|PASS|
|UT-SQL-003|NFR-010|正常|被锁住的写入者会等待而不是立即失败|另一个进程持有 BEGIN IMMEDIATE 写锁|写入者等到锁释放后才提交成功|node --test|PASS|
|UT-SQL-003b|NFR-010|异常|busy_timeout 为 0 时被锁住的写入者会失败|同样的锁冲突但 busyTimeoutMs=0|写入抛错而不是等待|node --test|PASS|
|UT-SQL-004|NFR-010|正常|忙等待超时可配置|busyTimeoutMs=1234|PRAGMA busy_timeout = 1234|node --test|PASS|
|UT-SQL-005|NFR-010|正常|WAL 模式留下 -wal 伴生文件|写入状态后检查目录|存在 metadata.db-wal|node --test|PASS|
|UT-SQL-010|NFR-010|正常|已提交的事务对读者可见|在事务中插入计数器行|提交后能查到该行|node --test|PASS|
|UT-SQL-011|NFR-010|异常|抛错的事务整体回滚|事务内先写一行再抛错|该行不存在，先前提交的行仍在|node --test|PASS|
|UT-SQL-012|NFR-010|正常|状态在单个事务内写入|连续两次 storeState|第二次后旧行全部消失，无中间态|node --test|PASS|
|UT-SQL-020|NFR-010|正常|新库处于最新 schema 版本|打开空数据库|currentVersion = latestVersion|node --test|PASS|
|UT-SQL-021|NFR-010|正常|schema 版本存放在数据库内部|查 meta 表|存在 schema_version 行|node --test|PASS|
|UT-SQL-022|NFR-010|正常|迁移是幂等的|对已迁移的库再迁移一次|applied 为空，版本不变|node --test|PASS|
|UT-SQL-023|NFR-010|正常|升级只应用缺失的步骤|先建 version 1 的库，再升级|version 2 的表先不存在后存在|node --test|PASS|
|UT-SQL-024|NFR-010|异常|迁移失败不改变版本也不留半成品|注入一个第二步是非法 SQL 的迁移步骤|迁移抛错，版本不变，该步的建表被回滚|node --test|PASS|
|UT-SQL-025|NFR-010|异常|比代码更新的库被拒绝而不是被静默降级|把 schema_version 改成未来版本|抛 SCHEMA_TOO_NEW，版本不变|node --test|PASS|
|UT-SQL-026|NFR-010|异常|降级删除高版本表及其数据|降到 version 1|artifacts/test_attempts 表与其数据消失|node --test|PASS|
|UT-SQL-027|NFR-010|异常|降到 version 0 清除全部表|降到 version 0|除 sqlite_ 外没有任何表|node --test|PASS|
|UT-SQL-028|NFR-010|异常|降级到更高版本被拒绝|降到 version 99|抛 SCHEMA_TOO_NEW，版本不变|node --test|PASS|
|UT-SQL-029|NFR-010|正常|每个迁移步骤都有 up 与 down 脚本|遍历 MIGRATIONS|每步都有非空 up 与 down，版本连续|node --test|PASS|
|UT-SQL-030|NFR-010|异常|步骤失败不留半应用的对象|事务内先建表再执行非法语句|半应用的表不存在，版本不变|node --test|PASS|
|UT-SQL-040|NFR-010|正常|数据库内容与导入的状态完全一致|导入夹具状态后校验|verifyMirror().ok 为 true|node --test|PASS|
|UT-SQL-041|NFR-010|正常|导入是幂等的|同一状态导入两次|两次读回的 JSON 相同|node --test|PASS|
|UT-SQL-042|NFR-010|边界|记录保留层未建模的字段|给项目加一个未来字段|读回时该字段仍在|node --test|PASS|
|UT-SQL-043|NFR-010|异常|镜像差异被报告而不是被掩盖|导入后比对不同状态|ok 为 false 且列出差异|node --test|PASS|
|UT-SQL-044|NFR-010|正常|层能回答它存在的理由|按项目与按运行查询|项目运行按时间倒序，尝试可查|node --test|PASS|
|UT-SQL-050|NFR-010|正常|两个并发写入者不丢记录|两个独立进程同时写 40 行|最终 80 行全在|node --test|PASS|
|UT-SQL-051|NFR-010|正常|写入进行时读者仍能读|写者在子进程里持事务并宣告 IN-TX|读者读到提交前的快照（1 行）|node --test|PASS|
|UT-SQL-060|NFR-010|正常|命令行报告数据库状态|sqlite_meta.mjs status|输出 schema 版本与行数|node --test|PASS|
|UT-SQL-061|NFR-010|正常|命令行导入并校验镜像|sqlite_meta.mjs import/verify|输出 mirror: OK，state.json 未被改动|node --test|PASS|
|UT-SQL-062|NFR-010|正常|命令行按需迁移与降级|sqlite_meta.mjs migrate/downgrade|版本按要求变化|node --test|PASS|
|UT-SQL-063|NFR-010|异常|命令行拒绝未知命令|sqlite_meta.mjs nonsense|退出码 2|node --test|PASS|
|UT-SQL-031|NFR-010|正常|并发迁移者不会把同一步骤应用两遍|6 个进程同时把 v2 库升级到一个 ADD COLUMN 的 v3|全部成功，FAIL: 0|node --test|PASS|
|UT-SQL-032|NFR-010|异常|迁移器不接管形状不同的外来表|库里有同名的外来 projects 表|抛 SCHEMA_OBJECT_CONFLICT|node --test|PASS|
|UT-SQL-033|NFR-010|正常|形状符合预期的表让迁移保持幂等|用本代码建库后重新打开|currentVersion = latestVersion|node --test|PASS|
|UT-SQL-034|NFR-010|异常|迁移抛错时不泄漏数据库句柄|让 openDatabase 因 SCHEMA_TOO_NEW 抛错|数据目录可以删除（无 EPERM）|node --test|PASS|
|UT-SQL-045|NFR-010|异常|校验能发现被篡改的 registry 内容|改 registry 条目的内容但保持条数|ok 为 false 并列出差异|node --test|PASS|
|UT-SQL-046|NFR-010|异常|校验能发现索引列与记录矛盾|把 runs.status 改成与记录不同的值|ok 为 false，差异点名该字段|node --test|PASS|
|UT-SQL-047|NFR-010|异常|校验能发现缺失的 attempt 与 artifact 行|删光 test_attempts 与 artifacts|ok 为 false，两者都被点名|node --test|PASS|
|UT-SQL-048|NFR-010|异常|校验能发现被篡改的 attempt|改 test_attempts 的 status 与 test_uid|ok 为 false|node --test|PASS|
|UT-SQL-049|NFR-010|异常|镜像在瞬时失败后恢复|另一进程持锁超过镜像的 busy_timeout|失败后下一次写入镜像成功并追平|node --test|PASS|
|UT-SQL-049b|NFR-010|异常|镜像失败不影响状态文件落盘|写入一个无法镜像的状态|state.json 仍然被正确写入|node --test|PASS|
|UT-SQL-049c|NFR-010|异常|镜像失败不会拖垮 Bridge|持锁使镜像失败|失败后 Bridge 仍能继续镜像|node --test|PASS|
|UT-SQL-064|NFR-010|异常|命令行拒绝非法的 --to|--to abc / 99 / -1 / 1.5 / 空|退出码 2，且不创建数据库|node --test|PASS|
|UT-SQL-065|NFR-010|异常|命令行拒绝未知参数与未知命令|--nonsense / nonsense / 无参数|退出码非 0 并打印用法|node --test|PASS|
|UT-SQL-066|NFR-010|正常|只读命令不创建数据库文件|status/verify 指向不存在的库|退出码 0/1，文件仍不存在|node --test|PASS|
|UT-SQL-067|NFR-010|异常|命令行报告它无法恢复的错误|状态文件不存在 / 不是状态 / 库不存在|退出码 1 并打印原因|node --test|PASS|
|UT-SQL-068|NFR-010|异常|命令行报告镜像不一致并失败|改状态后 verify|退出码 1，输出 MISMATCH 与问题清单|node --test|PASS|
|UT-DSC-001|FR-021|正常|CLI 报告解析为用例|--list 报告含一个 spec|得到 file/title/line/describePath|node --test|PASS|
|UT-DSC-002|FR-021|正常|文件相对 rootDir 归一|rootDir=项目/tests，报告写 a.spec.ts|用例文件为 项目相对 tests/a.spec.ts|node --test|PASS|
|UT-DSC-003|FR-021|安全|项目外的文件被排除并报告|报告的文件解析后落在项目外|用例列表不含它，skipped 里说明|node --test|PASS|
|UT-DSC-004|FR-021|正常|describe 路径取自 suite 嵌套|outer > inner > 用例|describePath 为 [outer, inner]|node --test|PASS|
|UT-DSC-005|FR-021|正常|项目矩阵合并为一条用例|同一用例两个 project|一条用例带两个 project 的 spec id|node --test|PASS|
|UT-DSC-006|FR-021|正常|CLI 错误原样带出|errors[] 含 duplicate test title|错误信息与 location 原样保留|node --test|PASS|
|UT-DSC-007|FR-021|正常|用例按文件与行排序|b.spec.ts 在前、a.spec.ts 在后|排序后 a 在前|node --test|PASS|
|UT-DSC-008|FR-021|安全|项目外的路径被拒绝|解析后落在项目外的绝对路径|projectRelativeFile 返回 null|node --test|PASS|
|UT-DSC-009|FR-021|正常|列举结果码稳定|四个结果码|OK/PLAYWRIGHT_NOT_INSTALLED/PLAYWRIGHT_LIST_FAILED/PLAYWRIGHT_LIST_TIMEOUT|node --test|PASS|
|UT-DSC-010|FR-021|安全|未背书的项目未可信|state 里没有信任记录|trust=untrusted，reason=未背书|node --test|PASS|
|UT-DSC-011|FR-021|正常|背书后项目可信|withTrust(trusted)|trust=trusted，带时间戳|node --test|PASS|
|UT-DSC-012|FR-021|安全|信任可撤销并保留原因|withTrust(untrusted, reason)|trust=untrusted，reason 保留|node --test|PASS|
|UT-DSC-013|FR-021|安全|信任不串项目|两个不同项目 UID|另一个项目仍为未可信|node --test|PASS|
|UT-DSC-014|FR-021|正常|信任写入不改原状态|withTrust 不改传入的 state|原对象不变，返回新对象|node --test|PASS|
|UT-DSC-015|FR-021|正常|唯一标题沿用 ATS-201 标题键|权威用例表里一个用例|uidSource=derived，basis=title-key|node --test|PASS|
|UT-DSC-016|FR-021|正常|显式标注优先|标题含 @TC-001|uid=tc-001，uidSource=explicit|node --test|PASS|
|UT-DSC-017|FR-021|安全|重复显式标注不绑定|两个用例都写 @TC-001|两者 uidStable=false，报告 duplicate-explicit-uid|node --test|PASS|
|UT-DSC-018|FR-021|正常|describe 路径消解同名歧义|同名用例在不同 describe 下|两者 uidStable=true，basis=scope-title|node --test|PASS|
|UT-DSC-019|FR-021|正常|同 describe 下同名仍歧义|同名同 describe 的两个用例|两者 uidStable=false，报告 identical-title，UID 不合并|node --test|PASS|
|UT-DSC-020|FR-021|正常|执行体指纹可消解同名|同名同 describe、执行体不同|basis=body-key，两者 UID 不同|node --test|PASS|
|UT-DSC-020b|FR-021|正常|动态用例不用模板的执行体判定|一个模板生成两个渲染标题|两个用例 UID 不同，basis=title-key|node --test|PASS|
|UT-DSC-021|FR-021|正常|普通用例的 UID 与静态索引一致|权威表里一个普通用例|UID 等于 deriveTestUid(projectUid, titleKey)|node --test|PASS|
|UT-DSC-021b|FR-021|正常|切换索引不改变已有 UID|普通用例旁有一个同名动态用例|普通用例 UID 不变，动态用例 basis=scope-title|node --test|PASS|
|UT-DSC-022|FR-021|正常|注册表保存 CLI 的 spec id|一个用例两个 project|entry.specIds 含两个 spec id|node --test|PASS|
|UT-DSC-023|FR-021|正常|缺席文件的注册表条目不裁剪|条目文件不在本次发现范围|条目仍在注册表里|node --test|PASS|
|UT-DSC-024|FR-021|正常|已消失用例的条目被裁剪|条目文件在范围内但用例没了|条目被裁掉|node --test|PASS|
|UT-DSC-025|FR-021|正常|两个索引的差异被报告|权威多两个动态用例|consistency.onlyAuthoritative 列出两条，agrees=false|node --test|PASS|
|UT-DSC-026|FR-021|正常|两个索引一致时 agrees 为真|两个索引用例相同|consistency.agrees=true|node --test|PASS|
|UT-DSC-027|FR-021|正常|词法 describe 路径|两个嵌套 describe 下的用例|describePathAt 给出嵌套路径|node --test|PASS|
|UT-DSC-028|FR-021|正常|用例键的拼写|文件+路径+标题|caseKey 为 文件 > 路径 > 标题|node --test|PASS|
|UT-CP-001|FR-028|安全|本地路径形态判定矩阵|盘符、UNC、POSIX、file:、家目录、环境变量、路径穿越、仓库地址各形态|逐一返回对应规则名|node --test|PASS|
|UT-CP-002|FR-028|边界|非路径值不误判|https 地址、prj UID、40 位 SHA、相对片段、ns:name、非字符串|均返回 null|node --test|PASS|
|UT-CP-003|FR-028|安全|百分号编码的路径同等拒绝|C%3A%5Crepo、%2Fhome%2Fa、损坏编码|前两者命中规则；损坏编码按原文判定不抛错|node --test|PASS|
|UT-CP-004|FR-028|安全|请求体扫描覆盖键与值、嵌套与数组|{a:[{b:路径}]}、键为路径、干净对象|返回码与位置指针，不回显原值；干净对象为 null|node --test|PASS|
|UT-CP-005|FR-028|安全|路径/仓库地址/凭据字段名分类|path、Project_Root、repository-url、token、X-ATS-Token|分别 REMOTE_PATH_FORBIDDEN / REMOTE_SECRET_INLINE_FORBIDDEN；出站模式只看值|node --test|PASS|
|UT-CP-006|NFR-002|安全|本地会话 Token 形态拒绝|48/40/64/47/49 位十六进制|仅 48 位命中，请求体报 REMOTE_SECRET_INLINE_FORBIDDEN|node --test|PASS|
|UT-CP-007|FR-028|边界|嵌套深度上限|32 层与 33 层嵌套对象|32 层通过，33 层 REMOTE_POLICY_REJECTED|node --test|PASS|
|UT-CP-008|FR-028|正常|拒绝码表与 docs/19 约束块逐码一致|读取 docs/19 机读约束块|25 个码的 HTTP 与可重试性一致，均在 REMOTE_ 命名空间|node --test|PASS|
|UT-CP-009|FR-028|异常|未知错误码与审计原因不外泄|构造未知码；带 reason 的错误|抛 TypeError；响应体只有 error/hint/retryable|node --test|PASS|
|UT-CP-010|NFR-002|安全|认证器映射租户或审计原因|denyAll、正确/错误/过短令牌、Basic、无头|只有正确令牌得到租户，其余给出审计原因|node --test|PASS|
|UT-CP-011|NFR-002|异常|开发令牌配置校验不回显令牌|空对象、数组、31 字符令牌、非法租户、非法 JSON|抛 TypeError，消息不含令牌|node --test|PASS|
|UT-CP-012|FR-028|正常|启动配置默认值与允许的变体|空环境、::1、localhost、带 TLS 的 0.0.0.0|默认 127.0.0.1:4610、无 TLS、auth=none；变体被接受|node --test|PASS|
|UT-CP-013|NFR-002|安全|不安全的启动配置被拒|非回环无 TLS、端口等于 ATS_PORT、非法端口、TLS 只给一半、未知认证、dev-static 非回环|ConfigError，退出码 2，消息点名变量|node --test|PASS|
|UT-CP-014|FR-028|正常|HTTPS 最低 TLS 1.3 与启动流程|注入 HTTPS 工厂与读文件；真实 HTTP 启动；端口占用；runMain|minVersion=TLSv1.3；日志不含令牌；占用报错；配置错误退出码 2|node --test|PASS|
|UT-CP-015|FR-028|正常|health 公开且不含主机信息|GET /cp/v1/health|200 + plane=control-plane，无 pid/路径，no-store|node --test|PASS|
|UT-CP-016|NFR-002|安全|本地凭据在控制面一律无效|带 X-ATS-Token（有无有效 Bearer）|401 REMOTE_UNAUTHENTICATED，审计原因 local_credential_presented|node --test|PASS|
|UT-CP-017|NFR-002|安全|浏览器跨源请求被拒|Origin=https://x.example、tauri://localhost|403 REMOTE_POLICY_REJECTED|node --test|PASS|
|UT-CP-018|FR-028|安全|未列举路由、方法与本地 /api 命名空间被拒|/api/session、未知路由、DELETE、根路径|403 REMOTE_POLICY_REJECTED|node --test|PASS|
|UT-CP-019|FR-028|安全|路径段与查询串中的本地路径在路由前被拒|编码路径段、原始 .. 段、?root=/etc、48 位十六进制段、损坏编码|422 REMOTE_PATH_FORBIDDEN / REMOTE_SECRET_INLINE_FORBIDDEN；损坏编码 403|node --test|PASS|
|UT-CP-020|NFR-002|安全|认证失败统一码，原因只入审计|无令牌、未知令牌、认证器无返回|401 且响应体相同；审计区分原因|node --test|PASS|
|UT-CP-021|FR-028|安全|租户由会话推导|会话无租户；头/查询/请求体给出他租户|403 REMOTE_TENANT_REQUIRED / REMOTE_TENANT_MISMATCH|node --test|PASS|
|UT-CP-022|FR-028|异常|POST 请求体约束|非 JSON 类型、空体、恰好 64KiB、超 64KiB、非对象、深嵌套|403；恰好 64KiB 被读取；超限 413|node --test|PASS|
|UT-CP-023|FR-028|正常|按不透明 UID 登记与查询项目|POST displayName 后列表、按 UID 查询、未知 UID|201 + prj UID；未知或非 UID 段 404 REMOTE_RESOURCE_NOT_FOUND|node --test|PASS|
|UT-CP-024|FR-028|安全|跨租户不可见且与不存在无法区分|租户 B 读租户 A 的项目|404，与不存在的 UID 响应体相同|node --test|PASS|
|UT-CP-025|FR-028|安全|非法名称、未知字段、路径与凭据被拒|空/超长/控制字符名称、branch 字段、path/root/repositoryUrl、token、48 位十六进制|403 / 422 REMOTE_PATH_FORBIDDEN / 422 REMOTE_SECRET_INLINE_FORBIDDEN|node --test|PASS|
|UT-CP-026|FR-028|安全|出站拦截|存储被注入路径或 Token 形态后读取|500 REMOTE_INTERNAL，响应不含该值，审计 egress_boundary_blocked|node --test|PASS|
|UT-CP-027|FR-028|异常|未预期异常不回显且审计有上限|UID 生成器抛出含路径的异常；1005 次请求|500 REMOTE_INTERNAL 不含消息；审计保留 1000 条|node --test|PASS|
|UT-CP-028|FR-028|安全|控制面源码导入白名单|扫描 server/control-plane/*.mjs|不导入本地 Bridge 模块、Tauri、child_process，不发起外呼|node --test|PASS|
|UT-CP-029|FR-028|安全|桌面侧调用边界|扫描 src-tauri/src/lib.rs 与 apps/studio|Tauri 只注册 local_bridge_status 且只托管本地 Bridge；前端无 Tauri API|node --test|PASS|
|UT-CP-030|FR-028|正常|契约端点描述边界|GET /cp/v1/contract|tauriRequired=false，localBridgeReachable=false，本地凭据不接受|node --test|PASS|

## 进入与退出条件

- 进入：源码基线固定，目标环境、测试数据、执行账号和已知限制记录完整；优先执行异常/边界和安全阻断。
- 退出：P0 阻断级用例通过，失败有缺陷票和可复现证据；PENDING 逐条标注原因，不能简单计入通过。
- 每次复测必须关联修复 Git commit，并做受影响范围回归。
