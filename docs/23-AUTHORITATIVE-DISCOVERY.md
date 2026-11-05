# ATS-DISCOVERY-001 权威发现设计书（`playwright test --list`）

- 对象：测试用例索引的**权威模式**（FR-021）
- 目标版本：v0.2.0（S2 / WBS ATS-202）
- 实现：`server/discovery/playwright-list.mjs`（CLI 适配器）、`server/discovery/authoritative.mjs`（身份阶梯）、`server/discovery/trust.mjs`（信任闸门）、`server/discovery/index.mjs`（两个索引的比较）、`server/core.mjs`（`discoverTests` 入口）、`server/index.mjs`（API 面）
- 实测脚本：`tools/ats202-probes/list-ground-truth.mjs`
- 证据：`docs/evidence/ATS-202/`
- 状态口径：本文件描述**已实现且有实测证据**的能力。尚未实现的部分列在 §7。

## 1. 为什么需要权威发现

v0.1 的索引是**启发式**的：`walkTests` 找到 `*.spec.*` / `*.test.*` 文件，`scanTestCases`
用正则识别字面量 `test('...')` / `it('...')`。它看不到三类用例：

| 用例形态 | 静态索引看到什么 | 权威索引看到什么 |
|---|---|---|
| 动态生成（`for` 循环里 `test(\`x ${n}\`)`） | 一个标题为模板 `x ${n}` 的**假**用例 | 每个渲染出来的真实用例 |
| 参数化（`test.each`） | 看不到 | 每个参数组合 |
| helper / fixture 声明 | 看不到 | 真实用例 |

第三行不是理论上的：`for (const n of ['a','b']) { test(\`dynamic ${n}\`, ...) }` 被静态扫描器
读成**一个**标题为 `dynamic ${n}` 的用例，而 CLI 报告的是**两个**用例 `dynamic a` 与
`dynamic b`。静态索引给出了一个看起来像用例、实际不存在的条目。

## 2. CLI 适配器

### 2.1 命令

```
node <project>/node_modules/@playwright/test/cli.js test --list --reporter=json
```

- CLI 取自**项目本地**路径，绝不使用全局二进制，绝不 `npm exec`/`npx`，**不安装任何东西**；
- 报告写到**临时目录**（`PLAYWRIGHT_JSON_OUTPUT_FILE`），不写进被测项目；
- 子进程 `shell: false`，工作目录是项目根；
- 超时默认 120 秒，超时上报 `PLAYWRIGHT_LIST_TIMEOUT`。

### 2.2 结果码

| 结果码 | 含义 | 后续动作 |
|---|---|---|
| `OK` | 列举成功 | 用权威索引 |
| `PLAYWRIGHT_NOT_INSTALLED` | 项目没有本地 CLI | 回退静态索引并说明 |
| `PLAYWRIGHT_LIST_FAILED` | CLI 失败（见 `errors[]`） | 回退静态索引并说明 |
| `PLAYWRIGHT_LIST_TIMEOUT` | 列举超时 | 回退静态索引并说明 |

失败**不静默**：响应的 `warning` 里带结果码与 CLI 自己的第一条错误信息。

### 2.3 报告形状（实测）

`tools/ats202-probes/list-ground-truth.mjs` 用真实的 `@playwright/test` 1.64.1 实测，
33 项断言全部通过：

| 事实 | 实测结果 |
|---|---|
| 报告结构 | `{config, suites, errors, stats}` |
| `config.rootDir` | 解析后的 `testDir` |
| `spec.file` | **相对 `rootDir`**，不是相对项目根 |
| `spec.id` | `<20 hex>-<20 hex>`：文件半 + 用例半 |
| `spec.title` | **叶子标题**，不含 `describe` 路径 |
| `describe` 路径 | 通过 **suite 嵌套**报告（文件 suite 的 `line` 为 0，不属于路径） |
| `spec.line` | `test(` 调用所在行 |
| 列举的确定性 | 两次列举结果完全一致 |
| `spec.id` 对**编辑执行体** | **不变** |
| `spec.id` 对**插入上方用例** | **不变**（非位置相关） |
| `spec.id` 对**文件改名** | 改变 |
| `spec.id` 对**改写标题** | 改变 |
| `spec.id` 对**新增 describe 包裹** | 改变 |
| 项目矩阵 | 同一逻辑用例每个 Playwright project 报告一次，各有不同 `spec.id` |
| `test.skip()` / `test.fixme()` | `expectedStatus: 'skipped'`，带 `annotations` |
| 不匹配 `testMatch` 的 `.ts` 文件 | 不报告 |
| 坏配置 | 退出码非 0，**不产生报告文件**，错误在 stderr |
| 重名用例 | 退出码非 0，`errors[]` 里有 `duplicate test title` |
| 无测试 | 退出码非 0，`errors[]` 里有 `No tests found` |

### 2.4 `--list` 会执行项目代码（实测，安全相关）

这一条是整个设计的支点，单独实测并单独断言：

| 事实 | 实测结果 |
|---|---|
| `--list` 加载项目配置 | **会**（配置顶层代码被执行） |
| `--list` 执行测试文件顶层 | **会**（顶层代码被执行） |
| `--list` 运行 `globalSetup` | 不会 |
| `--list` 运行测试体（用例回调） | 不会 |

即：`playwright test --list` **不是只读操作**。它与 `playwright test` 运行的是同一份
项目代码，差别只是不执行用例体。

## 3. 信任闸门（未可信仓库不可调用 `--list`）

### 3.1 规则

| 项目状态 | 索引 | 响应中的 `discovery` |
|---|---|---|
| **可信**（用户背书） | 权威索引 | `authoritative` |
| **未可信** | 静态索引 | `static` |

未可信项目**不会**被要求运行 `--list`，即使调用方显式要求
（`GET /api/projects/:id/tests?authoritative=true`）：强制参数决定**用哪个索引**，
信任决定**是否允许**用它。回退时响应里写明原因（`warning` 与
`authoritative.outcome = 'SKIPPED_UNTRUSTED'`）。

### 3.2 为什么运行路径不需要这个闸门，而索引路径需要

运行路径的信任边界是 ADR-005 的「只允许可信项目」：**用户点了运行**，运行项目代码
是那次点击的直接后果。索引路径不同：**用户只是打开了用例目录**。若索引在背后执行
仓库代码，「浏览目录」就变成了「运行仓库的代码」，用户没有要求过这件事。

因此信任是**显式且持久**的：记录在 `state.json` 的 `trust` 表里，按项目 UID 索引，
可以随时授予与撤销。

### 3.3 API

| 接口 | 行为 |
|---|---|
| `GET /api/projects/:id/trust` | 返回 `{trust: {trust, reason, at}}` |
| `POST /api/projects/:id/trust` | `{trust: 'trusted' \| 'untrusted', reason?}`；非法值返回 400 `INVALID_TRUST_VALUE` |

信任记录随 `state.json` 持久化，**重启后仍在**（IT-ATS202-API-006 实测）。

## 4. 身份阶梯

权威发现的用例也要有稳定 UID，否则动态用例只是「看得见」而不是「可关联」。

| # | 条件 | `uidSource` | `uidBasis` |
|---|---|---|---|
| 1 | 标题含 `@TC-<token>` | `explicit` | `explicit` |
| 2 | 注册表按执行体指纹记得这个用例 | `registry` | `body-key` |
| 3 | 该用例是它的标题键的**唯一认领者** | `derived` | `title-key` |
| 4 | 执行体指纹在项目内唯一（**仅源码用例**） | `derived-body` | `body-key` |
| 5 | （describe 路径, 标题）唯一 | `derived` | `scope-title` |
| 6 | （文件, describe 路径, 标题）唯一 | `derived` | `authoritative-key` |
| 7 | 都无法判定 | `provisional` | --（报告歧义） |

规则 1/2/3/4 是 ATS-201 的规则，只是作用在权威用例表上。这不是巧合：**普通用例必须
保住它已有的 UID**，否则用户在两种索引之间切换时每个 UID 都会变，需求关联全部断裂。

### 4.1 标题认领：源码用例优先

一个标题可能被多个用例认领：一个字面量用例与一个渲染出同样标题的动态用例。
认领规则是「**源码用例胜出**」：

- **源码用例**：静态扫描器在那个位置读到的标题与 CLI 报告的标题**一致**；
- **动态用例**：两者不一致——扫描器读到的是模板 `dynamic ${n}`，CLI 报告的是
  `dynamic alpha`。

若没有这条规则，一个与字面量用例同名的动态用例会把字面量用例挤下标题键，
**字面量用例的 UID 会在用户背书项目的那一刻改变**。规则 3 因此要求「唯一认领者」，
而不是「唯一标题」。

### 4.2 动态用例不用执行体指纹判定

动态用例的执行体指纹属于**模板**，不属于那个用例。模板明天多生成一个用例，那个
指纹就不再唯一。所以规则 2 与规则 4 只对源码用例生效，动态用例由 describe 路径判定。

### 4.3 describe 路径的取舍

describe 路径**不参与标题键**（ATS-201 §3.2 的既定取舍：同名用例改了执行体后 UID
会变），只在标题无法判定时作为兜底。规则 6 的 UID 含文件名，因此**不跨文件改名存活**
——这个条件写在 `uidBasis` 里，不隐藏。

### 4.4 注册表裁剪

沿用 ATS-201 的规则：只裁剪「文件在本次发现范围内、但用例已消失」的条目。
**文件暂时缺席（切换分支）不丢 UID**。

## 5. 与 CLI 发现结果一致

「一致」是**被测量的**，不是被断言的。`discoverTests` 的响应带 `consistency`：

| 字段 | 含义 |
|---|---|
| `authoritative` | 权威索引的用例数 |
| `static` | 静态索引的用例数 |
| `common` | 两者都有的用例数 |
| `onlyAuthoritative` | 只有权威索引可见的用例（键：`文件 > describe 路径 > 标题`） |
| `onlyStatic` | 只有静态索引可见的用例 |
| `agrees` | 两者完全一致 |

`onlyAuthoritative` 非空正是本任务的价值所在：那些是动态/参数化用例。
`onlyStatic` 非空则是 CLI 没有枚举到的用例（`testDir` 之外、不匹配 `testMatch`、
或 CLI 加载失败），同样被报告，不被隐藏。

## 6. API 面

| 接口 | 变化 |
|---|---|
| `GET /api/projects/:id/tests` | 新增 `discovery`（`static`/`authoritative`）、`trust`、`authoritative`（结果码、CLI、版本、耗时、用例数）、`consistency`；`?authoritative=true` 显式请求权威索引（仍受信任约束） |
| `GET /api/projects/:id/tests` | 用例新增 `uidBasis`、`describePath`、`specIds`（CLI 报告的每个 Playwright project 的 spec id） |
| `GET /api/projects/:id/trust` | 新增：读取项目信任状态 |
| `POST /api/projects/:id/trust` | 新增：授予/撤销信任 |

## 7. 已知边界

以下能力**本设计未实现**，不得据本文件宣称已具备：

| 边界 | 归属 |
|---|---|
| 文件/标题变化时的 UID 重识别与歧义提示的完整策略 | ATS-204 |
| 动态/参数化/项目矩阵的索引回归数据集 | ATS-203 |
| `test.each` 参数化用例的**标题模板**与渲染标题的对应关系（当前以渲染标题为准） | ATS-204 |
| 用例的 `describe` 路径参与 UID（当前只作兜底） | ATS-204 |
| 多项目矩阵下「一个逻辑用例」的跨 project 身份（当前一个用例携带每个 project 的 spec id，但 UID 按逻辑用例唯一） | ATS-204 |
| 非 Playwright 引擎的权威发现（WDIO） | ATS-302 |
| 沙箱化执行（当前 `--list` 在宿主上执行仓库代码） | ATS-415 |

## 8. 验证

| 类别 | 用例 | 覆盖内容 |
|---|---|---|
| UT | `UT-ATS202-001` … `UT-ATS202-028`（`tests/discovery.test.mjs`） | 报告解析、路径归一、describe 路径、项目矩阵、失败码、信任闸门、身份阶梯、标题认领、注册表裁剪、两个索引的比较 |
| IT | `IT-ATS202-001` … `IT-ATS202-009`（`tests/discovery-it.test.mjs`） | 真实 `@playwright/test` 1.64.1：动态用例进权威索引不进静态索引、未可信项目不执行 `--list`、可信项目确实执行、一致性被测量、UID 不因切换索引而移动、坏配置回退、无 CLI 不安装 |
| IT | `IT-ATS202-API-001` … `IT-ATS202-API-007`（`tests/discovery-api.test.mjs`） | 真实 HTTP：信任端点、模式切换、非法信任值被拒、强制请求被拒、信任跨重启保留、撤销后回退 |
| 实测 | `tools/ats202-probes/list-ground-truth.mjs` | 真实 CLI 的 33 项契约断言（§2.3 与 §2.4 的每一行） |

执行：`npm test`（Node ≥ 22）。

**PENDING 不等于 PASS**：上表每一项都有对应的可重跑用例，未执行项在交付说明里写明原因。
