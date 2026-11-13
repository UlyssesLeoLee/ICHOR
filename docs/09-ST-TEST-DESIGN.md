# ATS-ST-001 システムテスト設計書

> 设计总数：62；已执行通过：39；待执行/未实现：23。**PENDING 不是测试通过**。

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
|ST-022|FR-020|兼容性|Tauri Windows 开发构建|Windows+Rust+WebView2|桌面窗口打开，bridge 连接成功|node tools/ats104-probes/st-ats104.mjs 结果（docs/evidence/ATS-104/）|PASS|
|ST-023|NFR-009|隐私|数据不自动离开本地|操作工作台并抓包|未主动请求 AI/SaaS endpoints|网络流量|PENDING|
|ST-024|NFR-011|运行维护|错误信息可用于故障定位|停掉 server、损坏 state、缺 browser|明确错误而非模拟成功|录屏与日志|PENDING|
|ST-031|FR-027|隐私|密钥入库后不出现在本机可读文件|在真实 Windows 上存入密钥后扫描数据目录与凭据索引|秘密只存在于系统凭据库；索引只有引用与指纹|node tools/ats402-probes/ui-e2e.mjs 结果 + 截图 + trace（docs/evidence/ATS-402/ui/）|PASS|
|ST-032|FR-027|隐私|首次外传前必须展示范围并确认|在 UI 上选择项目内容并触发外传|先出现范围清单（文件、字节数、摘要），未确认则不外传|录屏+网络抓包（缺外发路径，见 docs/23 §8；UI 预览→确认段已由 ui-e2e.mjs 的 ST-032a~d 执行）|PENDING|
|ST-033|NFR-009|隐私|无授权的外传请求被拒|清空授权后触发外传|请求被拒并给出 EGRESS_CONSENT_REQUIRED|node tools/ats402-probes/ui-e2e.mjs 结果 + 接口日志（docs/evidence/ATS-402/ui/）|PASS|
|ST-039|FR-009|功能|真实浏览器至少 1 PASS 1 FAIL|examples/real-browser-fixture：一条离线通过用例 + 一条故意失败用例，@playwright/test 1.65.0 精确固定，lockfile 入库|真实 Chromium 上跑出至少 1 条 PASS 与 1 条 FAIL；Bridge 报 1 passed / 1 failed|node tools/ats107-probes/st-ats107.mjs|PASS|
|ST-040|FR-009|功能|结果与 CLI 一致|同一夹具分别经 Playwright CLI 直跑与经 Bridge 跑|两条用例的逐条判定与 CLI 完全相同；计数器一致|node tools/ats107-probes/st-ats107.mjs|PASS|
|ST-041|FR-014|功能|错误信息与 CLI 一致|故意失败的用例|Bridge 报出的失败原因与 CLI 的错误信息逐字相同（去 ANSI 后全文相等），不是它的一部分|node tools/ats107-probes/st-ats107.mjs|PASS|
|ST-042|TOOL|可靠性|对账逻辑非恒真（探针自检）|把 Bridge 应报的结果做 13 种变异（改判定、换序、丢错误、丢用例、改计数器、截断错误信息等）|每种变异都必须被对账逻辑抓住；未变异的真实结果必须被接受|node tools/ats107-probes/mutation-check.mjs|PASS|
|ST-043|TOOL|功能|夹具依赖由 lockfile 固定（夹具自检）|examples/real-browser-fixture/package.json + package-lock.json|版本为精确固定（无 ^/~）；lockfile 已入库；npm ci 装出的版本与固定值一致|node tools/ats107-probes/st-ats107.mjs|PASS|
|ST-044|TOOL|可靠性|「真实浏览器」检查能拦住不启动浏览器的夹具（探针自检）|把夹具的两条用例改成不取 page（因此不启动浏览器）|真实夹具被接受；变异夹具被拒绝（trace 里没有浏览器上下文）|node tools/ats107-probes/no-browser-control.mjs|PASS|
|ST-045|TOOL|可靠性|产品截断错误信息时被探针抓住（产品变异负控）|在产品源码副本上截断 Bridge 报出的错误信息|探针在 ST-5 上失败；未变异的产品仍通过|node tools/ats107-probes/product-mutation-control.sh|PASS|
|ST-025|NFR-010|单实例|同一数据目录只允许一个 Bridge|真实 Bridge：A 服务时启动 B；两个 Bridge 同时启动|B 退出码 1 并报持有者；同时启动恰一个服务|node tools/ats207-probes/st-ats207.mjs|PASS|
|ST-026|NFR-010|恢复|崩溃后损坏文件的处理|零长度 state.json；损坏的 metadata.db|前者拒绝启动且文件不变；后者隔离并由 state.json 重建，历史完整|node tools/ats207-probes/st-ats207.mjs|PASS|
|ST-027|FR-016|功能|质量概览：失败/重试/取消分开计数|真实 Bridge + 真实 Playwright：一次真实失败运行、一次真实重试后通过、一次真实停止|失败计入失败桶、重试用例计入 flaky 桶、停止的运行计入 cancelled 且不计入失败与通过率|node tools/ats216-probes/st-ats216.mjs|PASS|
|ST-028|FR-016|功能|质量概览：指标与原始结果可核对|同一批真实运行的 summary 与用例列表|逐项对账全部一致；对账结论由模块与探针独立复算两次|node tools/ats216-probes/st-ats216.mjs|PASS|
|ST-029|FR-016|功能|两个界面共用同一份质量指标实现|便携 UI 与 Next 工作台|两者都 import 同一模块；Bridge 以 JavaScript MIME 提供该模块|node tools/ats216-probes/st-ats216.mjs|PASS|
|ST-030|FR-016|可靠性|质量指标的实现被破坏时测试变红|对模块做 7 个变异（取消算失败、flaky 算通过、对账恒真、聚类常量、丢重试计数、留 ANSI 码、忽略 attempt 数）|每个变异都被 UT 或 ST 抓住，无一漏网|node tools/ats216-probes/mutation-check.mjs|PASS|
|ST-ATS203-001|FR-021|边界|经 HTTP：未可信项目的动态用例在索引里标明不可判定|真实 Bridge + 真实 Playwright 1.64.1；for 循环 test(`范围检查 - ${n}`)|discovery=static；模板条目 uidStable=false、uidSource=provisional、ambiguity.reason=dynamic-template-title；普通用例 uidStable=true；warning 单独计数该模板并说明用例数量不可判定|node --test tests/ats203-index-api.test.mjs|PASS|
|ST-ATS203-002|FR-021|正常|经 HTTP：可信项目的渲染用例进入目录|授予信任后重读同一项目|discovery=authoritative，outcome=OK，CLI 版本 1.64.1；目录里是 4 条渲染后的用例，渲染用例 uidStable=true 且 UID 互不相同；consistency 报告两索引不一致|node --test tests/ats203-index-api.test.mjs|PASS|
|ST-ATS203-003|FR-021|异常|经 HTTP：参数化同名用例的引擎拒绝理由被带到响应里|for 循环里两次同名字面量标题|discovery=static（回退），outcome=PLAYWRIGHT_LIST_FAILED，attempted=true；warning 与 errors[0].message 都带引擎自己的 duplicate test title|node --test tests/ats203-index-api.test.mjs|PASS|
|ST-ATS203-004|FR-021|正常|经 HTTP：对称项目矩阵的每条用例带两个 spec id|projects 为 chromium 与 firefox|目录里每条用例 specIds=2 且两个 spec id 互不相同，uidStable=true|node --test tests/ats203-index-api.test.mjs|PASS|
|ST-ATS203-005|FR-021|正常|经 HTTP：非对称项目矩阵给出 2 与 1|projects 为 all 与 only-a(testMatch)|case a 的 specIds=2，case b 的 specIds=1，两者 uidStable=true|node --test tests/ats203-index-api.test.mjs|PASS|
|ST-ATS203-006|FR-021|正常|经 HTTP：跨文件同名的判定随索引切换而改变|两个文件各含同名用例但 describe 不同|未可信时 2 条不可判定且 ambiguity.reason=identical-title-and-body，warning 计数 2；可信后 2 条 uidStable=true 且 UID 互不相同|node --test tests/ats203-index-api.test.mjs|PASS|
|ST-034|FR-014|功能|从失败用例 2 次点击内找到 Trace|真实 Bridge + 真实 Playwright + 真实 Chromium：真实失败运行留下真实 trace.zip|点失败用例 → 点 Trace，2 次点击内真的下载到 trace.zip|node tools/ats215-probes/st-ats215.mjs|PASS|
|ST-035|FR-015|功能|附件显示归档哈希与时间|同一次运行的 trace.zip|显示的 SHA-256 = 清单归档值 = 磁盘字节重算值；显示文件修改时间|node tools/ats215-probes/st-ats215.mjs|PASS|
|ST-036|FR-015|异常|归档后被改动的附件|把 trace.zip 改掉后再查|校验报出 changed（应有与实际两个摘要）；工作台仍显示归档时的摘要，还原后重新一致|node tools/ats215-probes/st-ats215.mjs|PASS|
|ST-037|FR-014|功能|两个界面共用同一份 Trace 定位实现|便携 UI 与 Next 工作台|两者显示同一个 Trace 文件、同一份摘要与同一个时间|node tools/ats215-probes/st-ats215.mjs|PASS|
|ST-038|FR-014|异常|定位不到 Trace 的用例|没有 trace 的用例|界面显示「定位不到」与原因，不给一条打不开的链接|tests/evidence-workbench.test.mjs（UT 覆盖；界面形态未单独 ST）|PASS（UT）|
|ST-046|TOOL|可靠性|孤儿检查非恒真（产品变异负控）|在产品源码副本上移除 RunEvent::Exit 里结束 Bridge 的那一段，使关窗后子进程存活|探针在孤儿检查上失败并点名存活进程；未变异的产品仍通过|node tools/ats104-probes/st-ats104.mjs（负控段由 tools/ats104-probes/collect-evidence.sh 驱动）|PASS|
|ST-ATS213-001|FR-027|功能|存入密钥后界面显示「已配置」|真实 Bridge + 真实 Chromium + 真实 Windows Credential Manager|状态行显示「已配置」与「已从系统凭据库取回」|node tools/ats213-probes/st-ats213.mjs|PASS|
|ST-ATS213-002|FR-027|异常|从系统凭据库删掉条目后界面显示「未配置」|平台索引仍留着引用（分叉是真实存在的）|状态行显示「未配置」与「系统凭据库里没有这一条」——状态是测出来的，不从索引推断|node tools/ats213-probes/st-ats213.mjs|PASS|
|ST-ATS213-003|NFR-009|隐私|界面上没有密钥明文|页面正文与状态行|正文既不含完整密钥也不含其前 8 个字符；密钥输入框存入后被清空|node tools/ats213-probes/st-ats213.mjs|PASS|
|ST-ATS213-004|FR-027|异常|状态接口报出原因码而不是假装成功|条目已被删除时的单条状态查询|status=not-configured、reason=CREDENTIAL_NOT_FOUND|node tools/ats213-probes/st-ats213.mjs|PASS|
|ST-ATS214-001|FR-005|正常|500 用例的目录在真实浏览器里加载且无报错|真实 Bridge + 真实 Chromium + 静态导出；500 用例 / 50 文件的夹具|500 行用例渲染出来；没有 console error，也没有 page error|node tools/ats214-probes/st-ats214.mjs|PASS|
|ST-ATS214-002|FR-005|可用性|500 用例时用例列表**可见且可点**|同上，视口 1440x900|列表高度 > 0、顶部在视口内、第一条用例在屏幕上且真的点得动（aria-checked 变 true）|node tools/ats214-probes/st-ats214.mjs|PASS|
|ST-ATS214-003|FR-005|性能|500 用例的过滤在预算内（预算事先写明）|同上；逐键输入、标签口径切换、「全选当前」、取消勾选|每次交互 ≤ 100ms，且没有 > 100ms 的 long task；4 倍 CPU 降速的数字只作参考|node tools/ats214-probes/st-ats214.mjs|PASS|
|ST-ATS214-004|FR-005|功能|按标题搜索用例|输入「case 017」|只留下标题含该串的用例（1 条）|node tools/ats214-probes/st-ats214.mjs|PASS|
|ST-ATS214-005|FR-005|功能|标签过滤，且「任一」与「全部」给出不同的结果|勾 @smoke + @api，切口径|「任一」234 条、「全部」34 条——两个口径不同，口径不是装饰|node tools/ats214-probes/st-ats214.mjs|PASS|
|ST-ATS214-006|FR-005|功能|选择映射到用例的 UID|勾选 a1 与 b1|选择栏显示「已选 2 条」；两条的 UID 就是目录里的 UID|node tools/ats214-probes/st-ats214.mjs|PASS|
|ST-ATS214-007|FR-005|异常|已选但离开目录的用例被报出，且运行被阻止|把 b1 从文件里删掉后重读目录|页面出现 role=alert 的提示并点名该 UID；点批量运行只弹提示，**没有**提交任何运行|node tools/ats214-probes/st-ats214.mjs|PASS|
|ST-ATS214-008|FR-005|可用性|切换项目时过滤条件被重置并告知|在 p500 勾 @smoke，再切到 other（2 条、只有 @billing）|列表回到 2/2 条，没有残留的按下芯片，选择栏「已选 0 条」|node tools/ats214-probes/st-ats214.mjs|PASS|
|ST-ATS214-009|FR-005|正常|界面如实说明实际会执行多少条|只勾 a1（a 文件有 3 条）|选择栏「将执行 3 条」、toast「实际执行 3 条」，引擎真的跑了 3 条——三个数字一致|node tools/ats214-probes/st-ats214.mjs|PASS|
|ST-ATS214-010|FR-005|可用性|勾选框键盘可达|真实 Chromium 的 Tab / Space|勾选框是自己的 <button role=checkbox>（不是嵌在 button 里的 span），能拿到焦点，空格能切换|node tools/ats214-probes/st-ats214.mjs|PASS|
|ST-ATS214-011|FR-021|功能|发出去的请求带着**每一个**被勾选的 UID|勾选两个不同文件里的用例，拦截浏览器发出的请求|请求体里的 selection 带着两个 UID（读的是网络上的请求，不是界面自己的算术——只读界面只能证明界面没算错，证明不了它发对了）|node tools/ats214-probes/st-ats214.mjs|PASS|
|ST-ATS214-012|TOOL|可靠性|交付的代码被变异时测试必须变红（负控）|对 page.tsx 与 server/index.mjs 做 10 个变异（关掉过滤、只发第一个 UID、不渲染警告、不阻止运行、承诺选中条数、不重置过滤、把勾选框放回 button 里、不继承环境档案、不整单校验、预检失败不结束批次）|每个变异都被抓住（界面变异由 ST 抓住，服务端变异由 IT 抓住）；未变异的代码仍然通过|node tools/ats214-probes/mutation-check.mjs|PASS|
|ST-ATS213-005|FR-027|异常|凭据库不可达时「不可用密钥」的说明逐类计数|Bridge 的 PATH 里没有 PowerShell（真实调用失败）|说明写着「取不到 2」，不出现「全部可用」；每条状态是 unavailable|node tools/ats213-probes/st-credential-status-failures.mjs|PASS|
|ST-ATS213-006|FR-027|异常|凭据库不可达时不写「已就绪」|同上|凭据库指标写「本机系统凭据库不可用」；GET /status 的 available=false|node tools/ats213-probes/st-credential-status-failures.mjs|PASS|
|ST-ATS213-007|FR-027|异常|刷新失败后旧状态不冒充当前状态|状态读成功一次，然后 Bridge 停掉再点刷新|旧状态行清空；「可用密钥」为 0；提示条写明上次测得于何时|node tools/ats213-probes/st-credential-status-failures.mjs|PASS|
|ST-ATS213-008|FR-027|异常|状态读失败时引用照样显示、删除按钮还在|首次加载就拦截状态接口（404）|面板上仍有全部引用行与等量的删除按钮；提示条说「下方只列出引用」是事实|node tools/ats213-probes/st-credential-status-failures.mjs|PASS|
|ST-ATS213-009|FR-027|功能|凭据引用真的到达了 runner（真实运行）|真实 Windows Credential Manager + 真实 Playwright 运行；档案写引用|被测脚本读到注入的变量（断言 SHA-256 摘要与长度）；档案里留着的永远是引用|node tools/ats213-probes/st-credential-ref.mjs|PASS|
|ST-ATS213-010|NFR-009|安全|密钥没有落进任何平台文件（真实运行）|同上，扫描数据目录与运行目录|数据目录 0 命中；运行目录里只有摘要没有明文|node tools/ats213-probes/st-credential-ref.mjs|PASS|

## 进入与退出条件

- 进入：源码基线固定，目标环境、测试数据、执行账号和已知限制记录完整；优先执行异常/边界和安全阻断。
- 退出：P0 阻断级用例通过，失败有缺陷票和可复现证据；PENDING 逐条标注原因，不能简单计入通过。
- 每次复测必须关联修复 Git commit，并做受影响范围回归。
