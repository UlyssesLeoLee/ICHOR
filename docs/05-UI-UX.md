# ATS-UI-001 画面設計書 / UX 规范

## 1. 导航与界面模型

采用低认知负荷的单工作台：左侧固定一级导航，顶部项目切换及 Git 状态，二级左栏为资源列表，右侧为当前上下文详情；执行信息不强制打开另一个应用。视觉主题为深蓝中性色配有限强调色（蓝色交互/绿色通过/红色失败）；避免复杂纹理、无意义动画和多余仪表盘卡片。

| 画面 ID | 画面 | 核心组件与交互 | 状态 |
|---|---|---|---|
| UI-001 | Workspace Header | 项目下拉、Git branch/sha/dirty、添加项目 | IMPLEMENTED |
| UI-002 | Test Catalog | 左侧搜索 + 源文件、测试列表、总览统计 | IMPLEMENTED（ATS-214：搜索按用例名/文件/标签；标签过滤标注「任一/全部」口径；勾选用例可批量运行，执行中心给出「选了什么/跑了什么」对账） |
| UI-003 | Flow Projection | goto/click/fill/expect 路径图、定位行号 | IMPLEMENTED read-only |
| UI-004 | Source Editor | Monaco TS 编辑、保存、源文件 SHA 校验 | Next 源码实现；依赖未在离线环境构建 |
| UI-005 | Run Center | Run 历史、运行状态、stdout/stderr、停止按钮 | IMPLEMENTED |
| UI-006 | Evidence Inspector | attachment 名称/尺寸、token 下载 | IMPLEMENTED |
| UI-007 | Traceability | requirements 与 `verified_by` 脚本关系 | IMPLEMENTED basic read-only |
| UI-008 | System Boundaries | 解释本地模式/项目可信性/未完成项 | IMPLEMENTED |
| UI-011 | Quality Overview | 运行/用例/重试/取消分桶、失败聚类、指标与原始结果对账表 | IMPLEMENTED（ATS-216） |
| UI-012 | Evidence Workbench | 失败用例列表、定位到的 Trace、附件哈希与时间 | IMPLEMENTED（ATS-215） |
| UI-013 | Workbench States & Keyboard | 四态（空/失败/取消/加载）可辨识、焦点可见、Esc/Enter/Ctrl+Enter/Ctrl+P | IMPLEMENTED（ATS-111，Next 工作台） |
| UI-009 | Agent Review | AI diff 审核、验证/拒绝、证据引用 | P1 |
| UI-010 | Distributed Runner | 节点状态、队列、资源占用、任务重试 | P2 |

## 2. 一致性和异常反馈

- 导入：必须填本地绝对路径；失败显示缺失 `package.json` 或 `playwright.config`，不自动生成项目。
- 代码编辑：保存按钮只有草稿变化时可点击；基线 Hash 变化时禁止覆盖并提示重新加载；文件默认仍受 Git 版本管理。
- 运行：每个项目仅允许一个正在运行的 Run；运行时显示日志轮询；停止为可请求，最终状态以进程关闭为准。
- 结果：Passed、Failed、Error、Interrupted、Cancelled 不可混为一谈；报告文件独立下载，不嵌入未清理的测试 HTML。
- 质量概览（ATS-216）：取消（Cancelled）与失败（Failed）分桶，取消既不计入失败也不计入通过率，取消运行的用例也不进判定类指标；重试后通过（Flaky）单列，既不算通过也不算失败，初次尝试的失败与其错误仍可见；每个指标与原始结果逐项对账（对账同时核对界面显示的数与 Bridge 报告的计数器），不一致时列出差异而非抹平；界面提供「原始结果」面板，每个显示出来的数字可展开到它计数所依据的用例或运行。
- 证据工作台（ATS-215）：失败用例与其 Trace 在同一屏，点击预算 2 次是数出来的（模块返回点击路径，界面显示这个数）；定位不到 Trace 时显示原因而不是给一条打不开的链接；附件显示的是**归档时**清单记录的 SHA-256（ATS-209）与文件自身的修改时间，不是现在重算的摘要——归档后被改动的文件仍显示归档值，并由校验结果另行报出 changed/missing，两者不互相冒充；Trace Viewer 是引擎附带的独立程序，界面给出产生该 trace 的引擎版本，但**不代为打开 trace**。
- 需求追踪：未配置 `.aitest` 文件时呈现空状态/示例，不伪造覆盖率。
- 工作台四态（ATS-111）：**空列表 / 加载失败 / 已取消 / 加载中**四种状态在界面上必须互相可辨，不得都落成「什么都没有」或同一个 spinner。四态由一份模型定义（`apps/studio/lib/workbench-state.mjs`），界面只渲染模型说的东西，因此两个界面不会各说各话：
  - 空列表「暂无内容」：请求成功且该项目确实没有用例；与「筛选条件没匹配上」是**两件事**，后者单独提示，不冒充空列表。
  - 加载失败「加载失败」：`role="alert"`、`aria-live="assertive"`，失败会打断读者；文案带上原因，并给出「重试」入口与「检查本地执行服务是否在运行」的下一步。
  - 已取消「已取消」：**取消既不是失败也不是空**。目录加载走 `apps/studio/lib/api.ts` 的 `cancellableApi`（AbortController），切换项目时旧请求被中止；读者按 Esc 可取消正在进行的加载，面板随即显示「已取消」。
  - 加载中「加载中」：`aria-busy="true"`，并提示「按 Esc 可以取消这次加载」。
  - 状态**不只以颜色区分**（§4）：四态各有独立的图标、标签、说明与「接下来可以做什么」提示；四个标签是四个不同的词。
  - 模型不认识的 outcome 一律报成**失败**，不报成「暂无内容」——把未知说成成功就是撒谎。
- 键盘（ATS-111）：核心流程可**纯键盘**走完，不是「有 tabindex」：
  - 首个 Tab 落在「跳到主要内容」跳转链接上；焦点环**可见**（基准样式表在项目下拉、搜索框、弹窗输入框三处写了 `outline:none`，本项为这三处补回可见焦点环）；
  - 焦点顺序与 DOM 一致（rail → refresh → project-select → add-project → search → panel → content）；refresh 在顶栏，故先于项目下拉；
  - `Esc` 取消（弹窗优先，其次取消正在进行的加载）、`Enter` 提交（添加项目弹窗是真正的 form，走浏览器原生提交）、`Ctrl+Enter` 运行当前用例、`Ctrl+P` 跳到脚本搜索框；
  - 文本框里的 `Enter` 留给浏览器（`isTextEntry` 守卫），打字时不会被工作台抢走；
  - 快捷键清单写在页脚「键盘操作」里：**不写下来的快捷键等于没有快捷键**。
- Agent：所有建议必须标识 Evidence source、model、工具权限、风险级别和审核人（P1）。

## 3. 三视图同步约束

脚本是唯一权威文本。Graph 是只读语义投影：可显示不意味着支持反向修改；不能解析的结构显示 CodeBlock/未支持提醒。代码视图进行保存时触发索引刷新，不转换任意闭包。历史执行的证据不随代码变更重算，应保留运行当时的 commit 与文件哈希（后者 P1）。

## 4. 键盘、可用性、响应式

P0：按钮有文字或 title、Tab 可进入输入框、列表按当前项目过滤、文字对比度高、状态不能仅以颜色区分。宽屏 3 栏；窄屏压缩次要元素。P1：快捷键 `Ctrl+P` 脚本搜索、`Ctrl+Enter` 运行当前用例、Graph 画布缩放、可聚焦节点和 aria-label、对屏幕阅读器更友好。

### 4.1 已实现（ATS-111，Next 工作台）

P0 与 P1 中的键盘项已在 Next 工作台实现并实测（真实 Chromium，`tools/ats111-probes/st-ats111.mjs` 36/36）：

- 四态可辨识（见 §2），状态不依赖颜色；
- 焦点可见（补回被基准样式表去掉的 `outline:none`）、焦点顺序与 DOM 一致、跳转链接为首个可聚焦元素；
- `Esc` 取消、`Enter` 提交、`Ctrl+Enter` 运行、`Ctrl+P` 搜索，快捷键清单在页脚可见。

**已知边界**：本项只覆盖 Next 工作台（`apps/studio/app/page.tsx`），零依赖便携 UI（`apps/studio/public/fallback.html`）**未**同步这四态与键盘模型；屏幕阅读器（NVDA/JAWS/VoiceOver）**未**实机验证——本项断言的是 ARIA 语义与 live region 的正确性，不等于屏幕阅读器实测；焦点环按 WCAG 2.2 的 `:focus-visible` 语义实现，未做对比度实测；键盘导航覆盖的是主流程（选择项目→搜索→打开用例→运行→查看运行），表格内逐单元格键盘导航与虚拟滚动的键盘操作未覆盖。

## 5. 版本差异

正式 Next 页面为桌面原型主 UI，使用 Monaco；便携 HTML 为离线验证入口，内嵌 textarea 代码编辑但操作真实 API。二者均不使用演示用假 Run 数据。Next 构建和 Tauri 原生环境尚未实机验证，必须遵循 ST 文档测试。
