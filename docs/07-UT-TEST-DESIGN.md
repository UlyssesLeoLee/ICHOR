# ATS-UT-001 単体テスト設計書

> 设计总数：25；已执行通过：8；待执行/未实现：17。**PENDING 不是测试通过**。

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

## 进入与退出条件

- 进入：源码基线固定，目标环境、测试数据、执行账号和已知限制记录完整；优先执行异常/边界和安全阻断。
- 退出：P0 阻断级用例通过，失败有缺陷票和可复现证据；PENDING 逐条标注原因，不能简单计入通过。
- 每次复测必须关联修复 Git commit，并做受影响范围回归。
