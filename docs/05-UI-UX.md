# ATS-UI-001 画面設計書 / UX 规范

## 1. 导航与界面模型

采用低认知负荷的单工作台：左侧固定一级导航，顶部项目切换及 Git 状态，二级左栏为资源列表，右侧为当前上下文详情；执行信息不强制打开另一个应用。视觉主题为深蓝中性色配有限强调色（蓝色交互/绿色通过/红色失败）；避免复杂纹理、无意义动画和多余仪表盘卡片。

| 画面 ID | 画面 | 核心组件与交互 | 状态 |
|---|---|---|---|
| UI-001 | Workspace Header | 项目下拉、Git branch/sha/dirty、添加项目 | IMPLEMENTED |
| UI-002 | Test Catalog | 左侧搜索 + 源文件、测试列表、总览统计 | IMPLEMENTED |
| UI-003 | Flow Projection | goto/click/fill/expect 路径图、定位行号 | IMPLEMENTED read-only |
| UI-004 | Source Editor | Monaco TS 编辑、保存、源文件 SHA 校验 | Next 源码实现；依赖未在离线环境构建 |
| UI-005 | Run Center | Run 历史、运行状态、stdout/stderr、停止按钮 | IMPLEMENTED |
| UI-006 | Evidence Inspector | attachment 名称/尺寸、token 下载 | IMPLEMENTED |
| UI-007 | Traceability | requirements 与 `verified_by` 脚本关系 | IMPLEMENTED basic read-only |
| UI-008 | System Boundaries | 解释本地模式/项目可信性/未完成项 | IMPLEMENTED |
| UI-011 | Quality Overview | 运行/用例/重试/取消分桶、失败聚类、指标与原始结果对账表 | IMPLEMENTED（ATS-216） |
| UI-009 | Agent Review | AI diff 审核、验证/拒绝、证据引用 | P1 |
| UI-010 | Distributed Runner | 节点状态、队列、资源占用、任务重试 | P2 |

## 2. 一致性和异常反馈

- 导入：必须填本地绝对路径；失败显示缺失 `package.json` 或 `playwright.config`，不自动生成项目。
- 代码编辑：保存按钮只有草稿变化时可点击；基线 Hash 变化时禁止覆盖并提示重新加载；文件默认仍受 Git 版本管理。
- 运行：每个项目仅允许一个正在运行的 Run；运行时显示日志轮询；停止为可请求，最终状态以进程关闭为准。
- 结果：Passed、Failed、Error、Interrupted、Cancelled 不可混为一谈；报告文件独立下载，不嵌入未清理的测试 HTML。
- 质量概览（ATS-216）：取消（Cancelled）与失败（Failed）分桶，取消既不计入失败也不计入通过率，取消运行的用例也不进判定类指标；重试后通过（Flaky）单列，既不算通过也不算失败，初次尝试的失败与其错误仍可见；每个指标与原始结果逐项对账（对账同时核对界面显示的数与 Bridge 报告的计数器），不一致时列出差异而非抹平；界面提供「原始结果」面板，每个显示出来的数字可展开到它计数所依据的用例或运行。
- 需求追踪：未配置 `.aitest` 文件时呈现空状态/示例，不伪造覆盖率。
- Agent：所有建议必须标识 Evidence source、model、工具权限、风险级别和审核人（P1）。

## 3. 三视图同步约束

脚本是唯一权威文本。Graph 是只读语义投影：可显示不意味着支持反向修改；不能解析的结构显示 CodeBlock/未支持提醒。代码视图进行保存时触发索引刷新，不转换任意闭包。历史执行的证据不随代码变更重算，应保留运行当时的 commit 与文件哈希（后者 P1）。

## 4. 键盘、可用性、响应式

P0：按钮有文字或 title、Tab 可进入输入框、列表按当前项目过滤、文字对比度高、状态不能仅以颜色区分。宽屏 3 栏；窄屏压缩次要元素。P1：快捷键 `Ctrl+P` 脚本搜索、`Ctrl+Enter` 运行当前用例、Graph 画布缩放、可聚焦节点和 aria-label、对屏幕阅读器更友好。

## 5. 版本差异

正式 Next 页面为桌面原型主 UI，使用 Monaco；便携 HTML 为离线验证入口，内嵌 textarea 代码编辑但操作真实 API。二者均不使用演示用假 Run 数据。Next 构建和 Tauri 原生环境尚未实机验证，必须遵循 ST 文档测试。
