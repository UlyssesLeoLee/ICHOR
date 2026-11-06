# ATS-216 质量概览模块设计书（失败聚类 / Flaky 基础指标，非 AI）

- 交付物：WBS **ATS-216**（S2 / v0.2.0，工作流「前端」，主责 FE），对应需求 FR-016
- 状态标记沿用仓库约定：`IMPLEMENTED` ＝ 代码能力存在；`DESIGNED` ＝ 仅设计。**本文件不得把设计中的能力称为已实现。**
- 基线：分支 `agent/m3/seikoist-175`，起点 commit `b0618e0`（`dev` tip `9125b1c`）

## 1. 验收标准与本文件的对应

WBS 的完成定义是一句话：

> **区分失败/重试/取消，指标与原始结果可核对**

这句话有两半，**两半都是关于诚实的要求，而不是关于算术的要求**：

| 半句 | 要求 | 本文件的落点 |
|---|---|---|
| 区分失败/重试/取消 | 三件不同的事不能被算成一件 | §2 运行分组、§3 用例分组 |
| 指标与原始结果可核对 | 指标不能是「声称」，必须能被原始结果复算 | §5 对账、§6 可证伪性 |

「可核对」在本任务里不是一句口号：模块**自己复算一遍**对账结论，系统测试**再独立复算一遍**，两者必须一致；任何一个数字都能追到具体的 run / 用例 / attempt（§4）。

## 2. 运行分组：失败 / 取消 / 进行中

### 2.1 三组，不是六个数字

运行的状态本身已经在 ATS-208 的统一模型里定好了（`server/execution/model.mjs` → `RUN_STATUS`）。本任务不重新定义状态，只把它们**分组**：

| 组 | 成员状态 | 含义 | 其用例如何计入 |
|---|---|---|---|
| `verdict` | `passed` `failed` | 运行跑完了，引擎给出了判定 | **计入**通过/失败/重试用例桶 |
| `inconclusive` | `cancelled` `error` `interrupted` | 运行**没有以它自己的方式结束** | **不计入**任何判定桶，单列为 inconclusive |
| `inFlight` | `queued` `running` `cancelling` | 还在跑，summary 本来就不完整 | 同上 |

### 2.2 为什么取消不能算失败

一个被用户停掉的运行**没有对被测代码的质量做出任何判断**。把它算成失败，是让代码为人的决定背锅；把它算成通过，是把一次没跑完的运行藏起来。因此它有自己的桶，并且：

- **不进入运行通过率的分母**（分母只有 `verdict` 组）；
- **它的用例不进入任何判定桶**，单列为 inconclusive。

实测（`tools/ats216-probes/st-ats216.mjs`）：真实 Bridge 上真实 `POST /stop` 一个运行，终态是 `cancelled`，它被计为 cancelled 而不是 failed。

### 2.3 只有一套分组映射

实现的第一版有**两套**「运行状态 → 组」的映射：`runStatusGroup()` 和内联的查表表达式。它们可能各说各话——一个状态被前者判为 verdict、被后者判为 inconclusive，于是计数走了后者、用例归类走了前者，一个取消的运行被计为 cancelled 而它的用例却按「已出结论」计。

这两套映射已经合并为一套（`runStatusGroup()`），运行桶与用例归类都由它决定。**这个缺陷是变异测试发现的**：把 `runStatusGroup` 改成「cancelled 也算 verdict」最初**没有**被系统测试抓住，因为当时的期望值是从模块自己算出来的——模块错了，期望值跟着一起错。修复后的系统测试从**运行自己的状态字符串**（原始事实）推导期望值，模块再错就会被抓住。

## 3. 用例分组：失败 / 重试后通过 / 跳过 / 未知

用例状态沿用 ATS-208 的统一模型，本任务不重新定义：

| 状态 | 含义 | 计入 |
|---|---|---|
| `passed` | 一次就通过 | 通过桶 |
| `failed` | 每次尝试都失败 | 失败桶 + 失败聚类 |
| `flaky` | 至少失败过一次，重试恢复 | **重试桶**（单列） |
| `skipped` | 没跑 | 跳过桶 |
| `unknown` | 引擎没报告 | 未知桶 |

### 3.1 重试后通过既不是通过也不是失败

一个「失败一次、重试通过」的用例，如果只显示 `passed`，读者无从知道它需要第二次才过；如果算成 `failed`，又冤枉了一个最终通过的用例。所以它有**自己的桶**，并且：

- 它的**初次尝试**（`failed`）连同**它自己的错误**仍然保留在 attempt 列表里（ATS-208 的「重试不覆盖初次尝试」）；
- 重试次数单独计数：`cases.retried`（需要过重试的用例数）与 `cases.retries`（重试的总次数）。

实测：真实 Playwright + `retries: 1`，用例先失败后通过 → 桶是 `flaky`，`attempts = [failed, passed]`，初次尝试没有被覆盖。

### 3.2 未知状态不猜测

引擎没报告的状态是 `unknown`，**不折成 `passed` 也不折成 `failed`**：报 failed 是凭空造一次失败，报 passed 是凭空造一次成功。这与 ATS-208 的 `mapEngineStatus` 同一原则。

运行状态同理：一个模块不认识的运行状态归 `inconclusive`——**未知的事实该去那个什么都不声称的桶**。

## 4. 失败聚类（非 AI，确定性）

### 4.1 签名怎么算

一个聚类的键是**归一化后的错误文本**（签名）：

1. 先**剥离 ANSI 颜色码**；
2. 取**第一行**非空文本（栈信息不参与，否则一个失败会散成很多签名）；
3. **保留错误类**（`AssertionError:` 与 `TimeoutError:` 不是同一个缺陷）；
4. uuid → `<uuid>`、十六进制 → `<hex>`、引号文本 → `<str>`、数字 → `<n>`。

同样的错误文本永远得到同样的签名；两个文本只有归一化后相等才共享签名。**没有模型参与，也不可能有**——模块在浏览器里跑，没有网络。

### 4.2 三个实现缺陷，都是实测发现的

| 缺陷 | 现象 | 修复 |
|---|---|---|
| ANSI 颜色码留在签名里 | 同一个缺陷会因报告是否带 TTY 而聚成两类 | 先剥离颜色码 |
| 聚类键用分隔符拼接 | 分隔符可能出现在标题里，两个不同的用例会碰撞 | 改用 JSON 编码的二元组 |
| 错误类被剥掉后又在别处重新推断 | 两处可能给出不同的 kind | 保留错误类，kind 从签名推导 |

### 4.3 跨运行维度：不稳定用例

同一个逻辑用例（文件 + 标题，JSON 编码）在**一个运行失败、另一个运行通过**，或者**需要过重试**，都判为不稳定，单独列出。它是「它不可靠」的两种不同事实，两种都报。

## 5. 指标与原始结果可核对

### 5.1 每个桶都带原始引用

每个桶的元素是一�� `QualityCaseRef`：带 `runId` / `runUid` / `runStatus` / `title` / `file` / `status` / `attemptsCount` / `attemptStatuses` / `retryCount` / `error`。运行桶同理带 `QualityRunRef`。

「这个用例在第 3 次运行里失败了」是桶计数本身表达不了的事实，所以引用必须带 run。

### 5.2 对账

模块逐项核对**它自己算出来的数**与**Bridge 自己报告的计数器**（`summary.passed/failed/flaky/skipped/total/executions`）：

- 逐个 run 比对 `summary.<bucket>` 与该 run 的用例列表；
- 比对 `summary.total` 与用例数；
- 比对 `summary.executions` 与 attempt 数；
- 比对桶内数量与**独立走一遍**得到的数量（走两遍是故意的：第一遍填桶，第二遍数桶，两遍不一致就是漏了或重了）；
- 比对失败用例数与聚类覆盖数。

**不一致时逐行列出差异，而不是抹平。** 界面上的「指标与原始结果核对」表就是这张差异表。

### 5.3 两层独立复算

- 模块自己算一遍，得出 `reconciliation.consistent`；
- 系统测试**从原始 run 列表独立复算一遍**，并要求两者一致。

一个「永远说一致」的模块因此会被系统测试抓住：系统测试喂给它一个**计数器与用例列表对不上**的 run（真实 run 改一个计数器），要求它**报告**不一致（ST-216-4d，负控）。

## 6. 可证伪性（变异测试）

「测试通过」只有在**错的实现会让它变红**时才有意义。因此对模块做了 7 个变异，每一个都必须被 UT 或 ST 抓住：

| 变异 | 抓住它的 |
|---|---|
| 取消的运行算失败 | UT + ST |
| flaky 算通过 | UT + ST |
| 对账恒为真 | UT + ST |
| 聚类签名恒定 | UT + ST |
| 丢弃重试计数 | UT + ST |
| 保留 ANSI 颜色码 | UT |
| 忽略 attempt 数 | UT + ST |

**没有一个变异同时逃过 UT 和 ST。** 变异过程中发现并修掉了模块自身的两个缺陷（§2.3 的两套分组映射、§4.2 的 ANSI 颜色码）。

> 复跑方法：改 `apps/studio/public/quality.mjs` 的对应行 → 跑 `node --test tests/quality-overview.test.mjs` 与 `node tools/ats216-probes/st-ats216.mjs . <scratch> examples/sample-playwright/node_modules` → 确认变红 → 还原。

## 7. 两个界面，一份实现

本仓库有两个用户界面：Next.js 工作台（`apps/studio/app/page.tsx`）与零依赖便携 UI（`apps/studio/public/fallback.html`）。两者都显示质量指标。

实现放在 `apps/studio/public/quality.mjs`：**一份**，两个界面各自 import。便携 UI 因此改为 ES module（`<script type="module">`）。

实测（`tools/ats216-probes/browser-check.mjs`，真实 Chromium）：便携 UI 与 Next 工作台都打开了质量概览页，四个指标卡都渲染出来，对账表逐行显示「一致」，两个界面显示**同一组数字**，无 console 错误、无 page 错误。

**Bridge 的 MIME 表必须新增 `.mjs`**（`server/index.mjs`）：浏览器**拒绝**以非 JavaScript 类型执行 module，缺这一项便携 UI 的质量概览会**静默加载失败**——界面看起来正常，只是没有数据。实测：`GET /quality.mjs` → `Content-Type: text/javascript; charset=utf-8`（ST-216-5b）。

类型由模块的 JSDoc 推导（`@typedef` + `@returns {QualityOverview}`），**不另建一份 `.d.ts`**：两份类型定义会漂移，而这份仓库的基线文档明确要求「文档可以超前于代码，但不得把设计中的能力称为已实现」，类型漂移就是把设计说成实现。

## 8. 已知边界

1. **人工可用性未评测**。质量概览**已在真实 Chromium 里实测渲染**（`tools/ats216-probes/browser-check.mjs`：两个界面都打开质量概览页、指标与对账表都渲染出来、两个界面显示同一组数字、无 console 错误），但**没有**做人工的无障碍/键盘/加载态评测——那属 **ATS-111** 的 ST 范围。
   > 浏览器实测的一个约束：Next 工作台按**端口**解析 API 基址（`apps/studio/lib/api.ts` 硬编码 4577，这是 ATS-101 已登记的约束），因此浏览器检查的 Bridge 跑在**默认端口**上；便携 UI 没有这个约束（它由 Bridge 自己伺服，API 是同源）。
2. **聚类只到签名，不做根因判断**。分组粒度是「错误文本归一化后的签名」，不做失败传播分析，也不判断「这个失败是不是另一个失败引起的」。AI 诊断属 FR-025（`DESIGNED`）。
3. **只覆盖本机 Bridge 的运行历史**，不含远程 Runner（属 ATS-502/ATS-503）。
4. **模块不做持久化**。它是纯函数：输入 run 列表，输出概览。历史仍在 `state.json` / SQLite（ATS-205）里。
5. **跨运行维度按「文件 + 标题」识别用例**。用例改了标题就认不出是同一个（UID 识别属 ATS-204 的身份映射器，其绑定能力在本任务未接入该视图）。

## 9. 交付物清单

| 路径 | 类型 | 内容 |
|---|---|---|
| `apps/studio/public/quality.mjs` | 新增 | 质量概览模块（唯一实现，JSDoc 类型推导） |
| `tests/quality-overview.test.mjs` | 新增 | Node UT 39 例 |
| `tools/ats216-probes/st-ats216.mjs` | 新增 | 系统测试（真实 Bridge + 真实 Playwright），25 项检查 |
| `tools/ats216-probes/browser-check.mjs` | 新增 | 浏览器实测（真实 Chromium 打开两个界面的质量概览），14 项检查 |
| `tools/ats216-probes/mutation-check.mjs` | 新增 | 变异检查（7 个变异必须被抓住），8 项检查 |
| `tools/ats216-probes/collect-evidence.sh` | 新增 | 证据收集脚本（一次跑完全部证据步骤） |
| `tools/update_wbs_ats216.py` | 新增 | WBS 行更新脚本（标记 `【ATS-216】`） |
| `tools/wbs_common.py` | 修改 | 共享工作簿的标记登记与叙述片段：新增 `【ATS-216】` |
| `apps/studio/app/page.tsx` | 修改 | 「质量概览」页（Next 工作台） |
| `apps/studio/public/fallback.html` | 修改 | 便携 UI 的「质量概览」页（导入同一模块） |
| `server/index.mjs` | 修改 | MIME 表新增 `.mjs` |
| `docs/16-BASELINE-ADR.md` | 修改 | §3.1 端口清单的位置随源码行位移同步 |
| `tools/check_adr_citations.py` | 修改 | 同上（被审计位置表） |
| `docs/WBS.xlsx` | 修改 | 「开发WBS」ATS-216 行的状态/完成率/剩余人日 + 风险说明；「总览」缓存值与 D6/D7 叙述 |
| `docs/00-INDEX.md` | 修改 | 收录本文件与 ATS-216 证据目录 |
| `docs/27-QUALITY-OVERVIEW.md` | 新增 | 本文件 |
| `docs/evidence/ATS-216/` | 新增 | 证据日志 |
| `CHECKSUMS.sha256` | 修改 | 随新增/修改的受控文件重新生成 |
