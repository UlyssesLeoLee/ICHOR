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

**动态用例的注册表条目不携带 `bodyKey`。** 这是同一条规则在注册表上的落实：动态用例
的执行体是**模板**的执行体，把它记成这个用例的指纹，就等于把模板和用例混为一谈。

后果是实测过的（见 §9 第 1 轮复核）：静态索引随后会拿模板的指纹去注册表里匹配，
于是

- 模板只渲染一个用例时，模板**继承了那个渲染用例的 UID**（`uidSource=registry`）——
  一个不存在的用例拿到了真实用例的身份；
- 模板渲染多个用例时，同一个指纹匹配到多条注册表记录，静态索引报出一个用户
  无法处理的**假冲突**。

因此动态用例的注册表条目只带 UID、文件、标题、行号与 describe 路径——运行绑定
（`findTestUid` 按 file/title/line 查找）依然能找到它。

### 4.3 describe 路径的取舍

describe 路径**不参与标题键**（ATS-201 §3.2 的既定取舍：同名用例改了执行体后 UID
会变），只在标题无法判定时作为兜底。规则 6 的 UID 含文件名，因此**不跨文件改名存活**
——这个条件写在 `uidBasis` 里，不隐藏。

### 4.4 注册表裁剪

沿用 ATS-201 的规则：只裁剪「文件在本次发现范围内、但用例已消失」的条目。
**文件暂时缺席（切换分支）不丢 UID**。

### 4.5 「切换索引不改变已有 UID」的成立条件

这句话**不是无条件的**。它成立，当且仅当静态扫描器读到的标题与 CLI 报告的标题
**逐字相同**。第一轮复核用真实 CLI 找出三个反例，它们的根因都是**扫描器读错了标题**
或**读错了位置**，而不是身份阶梯本身有问题：

| 反例 | 现象 | 根因 | 修法 |
|---|---|---|---|
| CE-C | 标题含转义引号 `test('user\'s profile')` | 扫描器在**第一个引号**处截断（含转义的），读成 `user\` | 按字面量读标题并**解码转义** |
| CE-D | 标题超过 180 字符 | 扫描器把标题**截断到 180 字符**，CLI 报告完整标题 | **不再截断**标题 |
| CE-I | 多行 `test(` 调用 | 扫描器报的是**标题所在行**，CLI 报的是**调用所在行** | 行号取**调用行**；扫描与 CLI 因此落在同一位置 |

第三条同时修好了「源码用例」的判定：两个索引现在在**同一位置**读到**同一个标题**，
所以「源码用例胜出」这条规则才真的成立。

改标题之后 UID 是否保住，取决于**执行体是否改过**——这是 ATS-201 §3.2 的既定取舍，
本设计不改变它。

#### 4.5.1 升级会有一次性的静态 UID 变化（必须知道）

上面的三条修法改的是**扫描器读标题的方式**，所以**已经存在的静态 UID 会变一次**。
这不是回归，是纠正：旧 UID 是从**读错的标题**推出来的。

| 受影响的用例 | 旧 UID 的来源 | 升级后 |
|---|---|---|
| 标题含**转义引号**（`test('user\'s profile')`） | 扫描器把标题截成 `user\`，UID 从这个错误标题派生；因为标题读不到，**该用例也没有执行体** | UID 从正确标题 `user's profile` 派生，**并且从此有执行体**，改标题后能保住 UID |
| 标题**超过 180 字符** | 扫描器截断到 180 字符，但**执行体读得到** | UID **不变**：注册表按执行体指纹认回同一个用例 |
| **多行** `test(` 调用 | 扫描器报的是标题所在行，与 CLI 的调用行不同 | UID **不变**：同上，按执行体认回 |

**影响范围**：只有「标题含转义引号」这一类会真的换 UID。实测（`r2-upgrade` 探针，
第 1 轮的树 `cc68331` → 本轮的树，同一份注册表）：

```
[escaped quote]       FAIL -- 静态 UID tc_1_d_0133d73c628805e2 (title "user\\")
                          -> 升级后 tc_1_d_2d805d451ded5ad8 (derived, title "user's profile")
[title > 180 chars]   OK  -- tc_1_d_03a9ee2a8d37e5d3 == tc_1_d_03a9ee2a8d37e5d3 (registry)
[multi-line call]     OK  -- tc_1_d_44d54cca5562f627 == tc_1_d_44d54cca5562f627 (registry)
```

复现命令（两个参数是**两棵树**）：

```
node tools/ats202-probes/r2/r2-upgrade.mjs <第1轮的树> <本轮的树> <scratch>
```

注：第 1 轮返工之后的树（`d488299`）**已经**带扫描器修正，所以拿它当「旧树」跑
这个探针是 3/3 OK。探针要证明的是**从修正之前**升级上来的那一次变化，所以旧树必须
取 `cc68331`。

**为什么不做迁移**：旧 UID 来自**被读错的标题**，而且那类用例**没有执行体**——
它们在旧扫描器下无法按执行体认回，所以除了「重新派生」没有别的办法得到正确的 UID。
迁移脚本（`tools/migrate_state.py`）不为它们保留条目：保留一个由错误标题推出的 UID，
等于把错误**固化**下来。

**要保住一个用例的身份，就用显式标注**：在标题里写 `@TC-xxx`，UID 由标注决定，
扫描器怎么读标题都不影响它。这是本规范一贯的做法（ATS-201 §3.2）。

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

### 5.1 比较键依赖 describe 路径，describe 路径必须读对

> **本节的结论在第 2 轮复核后已改写。** 下面是**当时**的结论与它被推翻的原因；
> **现行**的比较键见 §5.2。

比较键是 `文件 > describe 路径 > 标题`，而静态侧的 describe 路径是**从源码词法读出来的**。
因此这条路径读错，比较就会出现**假差异**：两个索引明明看到同一组用例，报告却说
「1 个用例仅静态索引可见」。

第一轮复核用真实 CLI 找出两个反例，都已修掉：

| 反例 | 现象 | 根因 | 修法 |
|---|---|---|---|
| CE-A | 已闭合的 `describe` 之后的用例，两边不一致 | 词法读取器**只入栈、从不出栈**，闭合的块仍然挂在路径上 | 按**花括号**跟踪块的生命周期，闭合即出栈 |
| CE-B | `describe.serial` / `describe.skip` 下的用例，两边不一致 | 正则 `\bdescribe\s*\(` **匹配不到** `describe.serial(` | 识别 `serial`/`parallel`/`skip`/`only`/`fixme` 修饰符 |

花括号用与执行体抽取**同一套受限词法**计数，所以字符串、模板字面量、注释、正则里的
花括号都不算。两条修法都有回归用例（`tests/discovery-regressions.test.mjs` 的
CE-A/CE-B，以及针对真实 CLI 的 IT-ATS202-012/013）。

**当时的保证**：CLI 枚举到的用例**永远不会**出现在 `onlyStatic` 里。

#### 5.1.1 这条保证不成立（第 2 轮复核的反证）

第 2 轮复核用真实 CLI 把上面那条保证**证伪**了：S1/S2/S3 三个场景里，CLI 枚举到的用例
**确实**进了 `onlyStatic`：

| 场景 | 源码 | CLI 报的 describe 路径 | 旧比较键的结果 |
|---|---|---|---|
| S1 | `test.describe(suite, () => {...})`（标题在变量里） | `checkout` | `onlyStatic` 装进了 `pays` |
| S2 | ``test.describe(`area ${area}`, () => {...})`` | `area cart` | `onlyStatic` 装进了 `adds` |
| S3 | `test.describe('tagged', { tag: '@smoke' }, () => {...})` | `tagged` | `onlyStatic` 装进了 `inside tagged` |

根因不是词法读取器的某一个 bug，而是**这条保证本身的措辞过于绝对**：词法读取器
**不可能**知道一个在运行时才构成的 `describe` 标题。S1/S2 的标题是**变量**或**模板
字面量**，源码里根本没有那个字面量；S3 的 details 对象在回调体之前就开了一个花括号。

「把 `describePathAt` 修得更聪明」解决不了 S1/S2——那不是读得准不准的问题，是**信息
不在源码里**。所以第 2 轮改的是**比较键**，不是读取器（§5.2）。

### 5.2 现行比较键：位置 + 标题（不含 describe 路径）

比较**实际匹配**用的键是 `matchKey`：

```
matchKey(case) = `${case.file} #${case.line} ${case.title}`
```

即**文件 + `test(` 调用的行号 + 叶子标题**。理由：

| 组成 | 为什么是它 |
|---|---|
| **行号** | CLI 报的是 `test(` **调用**的行；扫描器现在也报**调用**的行（第 1 轮 CE-I 修的）。两边落在**同一位置**。 |
| **标题** | 叶子标题两边都读得到（CLI 报的字面量，扫描器按字面量读并解码转义）。 |
| **不含 describe 路径** | describe 路径是**词法读出来的**，而 CLI 报的是**运行时**的真实路径。两者在 S1/S2/S3 上必然不同，把它放进比较键就必然产生假差异。 |

`caseKey`（`文件 > describe 路径 > 标题`）**保留**，但只作**可读键**——`onlyStatic` /
`onlyAuthoritative` 这两个列表用它来显示，用户看到的是人能读的路径，不是行号。

#### 保证（收窄后的，逐条写明）

1. **CLI 枚举到的用例不会出现在 `onlyStatic` 里。**
   这条保证现在**是结构性的**，不是词法的：CLI 枚举到的用例把自己的 `matchKey` 贡献
   给权威集合，它的键就在这个集合里，因此它不可能落进 `onlyStatic`。
   （第一轮写成「因为 describe 路径读得准所以不会」——那句话太绝对，见 §5.1.1。）
2. **`onlyStatic` 现在只装三类东西**：
   - CLI 根本没枚举到的文件（`testDir` 之外、不匹配 `testMatch`、CLI 加载失败）；
   - 动态用例的**模板**（扫描器读成 `dynamic ${n}`，CLI 报的是渲染后的 `dynamic alpha`）；
   - 同一个位置上**标题读得不一样**的用例（极少；CE-C 修好之后基本不再发生）。
3. **`onlyAuthoritative` 装的是 CLI 才知道的用例**：动态/参数化用例，以及
   **表达式体回调**里的用例（`scanTestCases` 只认**行首**的 `test(`，所以
   `describe('x', () => test(...))` 这种写法整个用例都不会被静态扫描器看到）。

> **归因更正（第 3 轮复核指出）。** 这一条原先把原因写成「读不到 describe 路径」。
> 那不是真正的原因：`matchKey` **不含** describe 路径，所以路径读不读得准与这件事
> 无关。真正的原因是**扫描器的识别规则**——`scanTestCases` 只识别**行首**的
> `test(`（`readTestCall`，`server/uid.mjs`），而表达式体回调里的 `test(` 前面还有
> `() => `，不在行首，于是整个用例都不会被静态索引枚举。实测：
> `scanTestCases("test.describe('expr', () => test('inside expr', ...));")` 返回 `[]`。

#### 回归用例

`tools/ats202-probes/r2/r2-scope.mjs`（真实 CLI，5 个场景）与
`tests/discovery-regressions.test.mjs` 的 CE-A/CE-B。S1/S2/S3 现在都是 OK：

```
[S1 describe title held in a variable]  OK -- agrees=true onlyStatic=[] onlyAuthoritative=[]
[S2 describe title as a template literal] OK -- agrees=true onlyStatic=[] onlyAuthoritative=[]
[S3 describe with a details object (tag)] OK -- agrees=true onlyStatic=[] onlyAuthoritative=[]
[S4 describe with an expression-bodied callback] OK -- agrees=false onlyStatic=[] onlyAuthoritative=["tests/s.spec.ts expr inside expr"]
[S5 describe.configure before plain cases] OK -- agrees=true onlyStatic=[] onlyAuthoritative=[]
```

S4 的 `onlyAuthoritative` 非空是**正确的**：那个用例在表达式体回调里，
`scanTestCases` 只识别**行首**的 `test(`，所以静态索引根本看不到它，
它只出现在权威索引里（原因见上面第 3 条的归因更正）。

## 6. API 面

| 接口 | 变化 |
|---|---|
| `GET /api/projects/:id/tests` | 新增 `discovery`（`static`/`authoritative`）、`trust`、`authoritative`（结果码、CLI、版本、耗时、用例数）、`consistency`；`?authoritative=true` 显式请求权威索引（仍受信任约束） |
| `GET /api/projects/:id/tests` | 用例新增 `uidBasis`、`describePath`、`specIds`（CLI 报告的每个 Playwright project 的 spec id） |
| `GET /api/projects/:id/trust` | 新增：读取项目信任状态 |
| `POST /api/projects/:id/trust` | 新增：授予/撤销信任 |

### 6.1 `authoritative.outcome` 的三个结果码

| 结果码 | 含义 | 用户的下一步 |
|---|---|---|
| `OK` | 列举成功 | 无——用的是权威索引 |
| `SKIPPED_UNTRUSTED` | 项目**未背书**，从未调用 `--list` | 给项目背书（`POST .../trust`） |
| `NOT_REQUESTED` | 项目**已背书**，但调用方用 `?authoritative=false` 明确要静态索引 | 无——请求被照办了 |

第一版把 `NOT_REQUESTED` 也报成 `SKIPPED_UNTRUSTED`，于是**一个用户已经背书过的项目
被告知它没有背书**。这两种情况需要用户做不同的事（一个要背书，一个什么都不用做），
所以它们是不同的结果码。

### 6.2 列举不阻塞 Bridge

列举会**执行项目自己的配置**，所以它可能很慢。第一版用 `spawnSync` **同步**执行，
于是列举期间整个 Bridge 都不响应——健康检查、另一个项目的用例目录、乃至一个正在跑的
测试的**停止按钮**，全都要等列举结束（实测：配置顶层耗时 4 s 时，`/api/health`
要等 4233–4287 ms）。

现在列举是**异步**的（`spawn` + await），事件循环不被占住，Bridge 在列举期间照常应答。
两个变体共用同一套解析与失败判定，所以答案不会分叉。

- 同步入口：`discoverTests()`（`server/core.mjs`）
- 异步入口：`discoverTestsAsync()`（`server/core.mjs`）——**Bridge 用的是这个**

实测：配置顶层耗时 4 s 时，列举期间 `/api/health` 的延迟是 **17 ms**（空闲时 2 ms）。
回归用例：IT-ATS202-API-009。

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
| 列举结果的**缓存**（每次打开目录都会重新列举一次） | ATS-203 |
| `GET /runners` 也会执行仓库代码（ATS-301 的 `--help` 探测）；SEC-011 的「浏览不执行仓库代码」只覆盖**索引**路径 | ATS-301 / ATS-415 |

## 8. 验证

| 类别 | 用例 | 覆盖内容 |
|---|---|---|
| UT | `UT-ATS202-001` … `UT-ATS202-028`（`tests/discovery.test.mjs`） | 报告解析、路径归一、describe 路径、项目矩阵、失败码、信任闸门、身份阶梯、标题认领、注册表裁剪、两个索引的比较 |
| UT | `CE-A` … `CE-F`（`tests/discovery-regressions.test.mjs`） | 第 1 轮复核的每一个反例：闭合的 describe、describe 修饰符、转义引号、超长标题、多行调用、动态用例的注册表回流、可信项目显式要静态索引 |
| UT | `N3` 系列（`tests/discovery-regressions.test.mjs`） | 第 2 轮复核的比较键：details 对象的 describe、带参数列表的回调、函数表达式回调、嵌套 describe、注释、模板字面量标题、变量标题、读不到的文件 |
| IT | `IT-ATS202-001` … `IT-ATS202-011`（`tests/discovery-it.test.mjs`） | 真实 `@playwright/test` 1.64.1：动态用例进权威索引不进静态索引、未可信项目不执行 `--list`、可信项目确实执行、一致性被测量、UID 不因切换索引而移动、坏配置回退、无 CLI 不安装、超时、CLI 报错 |
| IT | `IT-ATS202-012` … `IT-ATS202-017`（`tests/discovery-it.test.mjs`） | 第 1 轮复核的反例对**真实 CLI** 再验一遍 |
| IT | `IT-ATS202-API-001` … `IT-ATS202-API-007`（`tests/discovery-api.test.mjs`） | 真实 HTTP：信任端点、模式切换、非法信任值被拒、强制请求被拒、信任跨重启保留、撤销后回退 |
| IT | `IT-ATS202-API-008` … `IT-ATS202-API-009`（`tests/discovery-api.test.mjs`） | 可信项目显式要静态索引的结果码；**列举期间 Bridge 仍然应答** |
| IT | `IT-ATS202-API-010`（`tests/discovery-api.test.mjs`） | 第 3 轮复核的 R1：**旧格式项目记录**（无 `uid`、`id=proj_<uuid>`）打开目录后，注册表被保存 |
| UT | `ATS202-ASYNC-001` … `ATS202-ASYNC-015`（`tests/discovery-async.test.mjs`） | **Bridge 真正走的异步列举路径**：成功、超时（子进程被杀）、CLI 崩溃、坏 JSON、报告带错误、无 CLI、无 root、两个变体答案一致、事件循环不被占住 |
| 实测 | `tools/ats202-probes/list-ground-truth.mjs` | 真实 CLI 的 33 项契约断言（§2.3 与 §2.4 的每一行） |
| 反例 | `docs/evidence/ATS-202/09-review-round1-probe.log` | 第 1 轮复核的 10 个反例探针，在返工后的树上跑，10/10 OK |
| 反例 | `docs/evidence/ATS-202/12-r2-race.log` | N1：慢项目列举期间，另一个项目的注册表条目**不被抹掉**（2 → 2） |
| 反例 | `docs/evidence/ATS-202/13-r2-scope.log` | N3：S1/S2/S3 三个场景现在都是 `onlyStatic=[]`（5/5 OK） |
| 反例 | `docs/evidence/ATS-202/14-r2-async.log` | 异步超时：子进程确实被杀（配置完成标记不存在） |
| 反例 | `docs/evidence/ATS-202/15-r2-upgrade.log` | N4：升级前后的静态 UID 对照（**这个探针的 exit 1 是预期的**——它记录的正是那次一次性变化，§4.5.1） |

执行：`npm test`（Node ≥ 22）。

**PENDING 不等于 PASS**：上表每一项都有对应的可重跑用例，未执行项在交付说明里写明原因。

## 9. 第 1 轮复核的返工

第 1 轮复核用**真实 CLI** 驱动产品自己的 `discoverTests()`，找出 8 个反例。全部已修，
每个反例都有回归用例。

| 编号 | 反例 | 修法 | 回归用例 |
|---|---|---|---|
| CE-A | 已闭合的 `describe` 之后的用例 → 假的一致性差异 | describe 路径按**花括号**跟踪，出栈 | `CE-A`、IT-ATS202-012 |
| CE-B | `describe.serial`/`.skip` 下的用例 → 假的一致性差异 | 识别 describe 修饰符 | `CE-B`、IT-ATS202-013 |
| CE-C | 转义引号标题 → 切换索引后 UID 改变 | 按字面量读标题并解码转义 | `CE-C`、IT-ATS202-014 |
| CE-D | 超长标题 → 切换索引后 UID 改变 | 不再截断标题 | `CE-D`、IT-ATS202-015 |
| CE-I | 多行 `test(` 调用 → 改标题丢 UID | 行号取**调用行** | `CE-I`、IT-ATS202-016 |
| CE-E1 | 动态用例的注册表条目让**模板**继承了渲染用例的 UID | 动态用例的条目不带 `bodyKey` | `CE-E1`、IT-ATS202-017 |
| CE-E2 | 同一个模板引发假冲突 | 同上 | `CE-E2`、IT-ATS202-017 |
| CE-F | 可信项目显式要静态索引 → 被说成「未可信」 | 独立结果码 `NOT_REQUESTED` | `CE-F`、IT-ATS202-API-008 |

返工期间 `dev` 上先后落地了 ATS-205（SQLite 元数据层）与 ATS-208（执行状态机 v2）。
两次合并的冲突都按同一原则解决：**派生值重新推导，各管各的行**——引用位置由
`tools/fix_baseline_adr_refs.py` 从合并后的源码推导（ATS-208 已把
`tools/check_adr_citations.py` 改成从源码推导位置，不再手写行号），WBS 的行按
「谁相对合并基点改了这一行，这一行就是谁的」归属判定，两边的备注都保留。

另有两项不是反例但同样是复核发现的缺口，一并修了：

- **列举阻塞整个 Bridge**（`http202`）：改为异步列举 + IT-ATS202-API-009；
- **两道仓库门禁回归**（端口审计、ADR 引用）：行号随代码移动，`docs/16-BASELINE-ADR.md`
  与 `tools/check_adr_citations.py` 已重新指向，两道门禁回到 `RESULT: OK`。
  证据：`docs/evidence/ATS-202/10-port-audit.log`、`11-adr-citations.log`。

### 9.1 复核声称过、现在不再声称的话

第一版的交付说明里有两句话被真实 CLI 反证，现已改掉：

- 「切换索引不改变已有 UID」——**无条件**的说法已删除。现在它的成立条件写在
  §4.5：两个索引必须读到**同一个标题**、**同一个位置**。
- 「一致性的度量」——第一版的 `onlyStatic` 会装进两个索引都看到的用例。现在
  `onlyStatic` 只装 CLI 根本没枚举到的用例（§5.1）。

## 10. 第 2 轮复核的返工

第 2 轮复核确认第 1 轮的第 2–7 项已经落地，但指出**第 1 项没有完全达成**，
并在返工改动的行上找出 4 个新问题（N1–N4）。

| 编号 | 问题 | 根因 | 修法 | 回归用例 |
|---|---|---|---|---|
| N1 | 异步化之后**注册表条目丢失**：慢项目 A 列举期间，项目 B 写入的注册表条目被 A 整体写回的快照抹掉（B 的条目 2 → 0） | `server/index.mjs` 把 `store.uidRegistry` **整体**交给 `discoverTestsAsync`，`await` 数秒后再整体写回——写回的是 **await 之前的快照** | 只把**本项目**那一格合并进**当前的** `store.uidRegistry`，其它项目的格子保持原样 | `r2-race` 探针（真实 HTTP） |
| N2 | **生产路径没有测试**：Bridge 真正走的 `listTestsAsync` / `spawnAsync` / `discoverTestsAsync` 一行都没被直接测过，`playwright-list.mjs` 的覆盖率掉到 85.60% | 第 1 轮的 IT 全测的是**同步**变体 | 新增 `tests/discovery-async.test.mjs`：用**假 Playwright CLI** 直接驱动异步路径，覆盖成功、超时（子进程被杀）、CLI 崩溃、坏 JSON、报告带错误、无 CLI、无 root、两个变体答案一致、事件循环不被占住 | `ATS202-ASYNC-001` … `015` |
| N3 | `docs/23` §5.1 的保证「CLI 枚举到的用例永远不会出现在 `onlyStatic` 里」**不成立** | 保证的措辞过于绝对：词法读取器**不可能**知道运行时才构成的 describe 标题（S1 变量、S2 模板字面量），S3 的 details 对象还会提前开一个花括号 | 比较**实际匹配**的键改为 `matchKey`（文件 + **调用行** + 叶子标题），describe 路径只留作**可读键**；保证改写成结构性的（§5.2） | `r2-scope` 探针（真实 CLI，5 场景）、CE-A/CE-B |
| N4 | 扫描器修正会让**含转义引号**的用例在升级时**一次性换静态 UID** | 旧扫描器把标题截成 `user\`，UID 从这个错误标题派生；那类用例**也没有执行体** | **只需写明**：影响范围、为什么不做迁移、要用 `@TC-xxx` 固定 UID（§4.5.1） | `r2-upgrade` 探针 |

N1/N3 的修法都**先于**本轮开工就已经落在 `agent/m3/seikoist-163` 上（合并前的
`282b0d1`）；本轮补上了 N2 的测试、N4 的文档，以及 N1/N3 的**回归用例**。

### 10.1 第 2 轮之后**仍然不声称**的话

- **不声称**「切换索引不改变已有 UID」是无条件的。成立条件见 §4.5，
  **并且**升级时会有一次性的静态 UID 变化，见 §4.5.1。
- **不声称**「CLI 枚举到的用例永远不会出现在 `onlyStatic` 里」是**词法**保证。
  它现在是**结构性的**保证（§5.2 第 1 条），并且 `onlyStatic` 装的**三类**东西
  已逐条写明。
- **不声称**「列举期间 Bridge 一定不响应」。现在的实现是**异步**列举
  （§6.2），实测列举期间 `/api/health` 的延迟是 17 ms；但这依赖
  `spawn` + `await` 的实现，不是接口契约。

## 11. 第 3 轮复核的返工

第 3 轮复核确认第 2 轮的 N1–N4 与第 3 轮的有界条件都已达成，两条验收标准都有
实测支撑，但指出 **N1 的修法本身在旧格式项目记录上引入了回归**。

| 编号 | 问题 | 根因 | 修法 | 回归用例 |
|---|---|---|---|---|
| R1 | **旧格式项目记录的注册表不再被保存**：未迁移的安装每次打开目录都不保存注册表（实测 registry slots 从 `["proj_1_…"]` 变成 `[]`） | `server/index.mjs` 的写回按 `project.uid` / `project.id` 查找目录那一格，但**目录是按 `projectUidOf(project)` 建的**。对**没有 `uid` 字段、`id` 仍是 `proj_<uuid>`** 的旧记录，`projectUidOf` 返回重新推导的 `proj_1_…`，两个键对不上 → `cell` 是 `undefined`，什么也没写回 | 写回按**目录自己的键**（`catalog.projectUid`，即 `projectUidOf(project)`）查找那一格，并以同一个键存档 | `IT-ATS202-API-010`（`tests/discovery-api.test.mjs`）、复核自己的 `r3-legacy` 探针 |

`loadState` 明确支持旧记录（"old installations keep working until the migration
script rewrites their identifiers"，`server/core.mjs`），路由正则也接受 `proj_<uuid>`，
所以「打开目录」这条路径对未迁移的安装是**可达**的——这正是 R1 的严重性所在：
按代码推断，它也无法把 Attempt 绑定到 TestDefinition UID。

第 3 轮复核同时指出**两处非阻断**的更正，本轮一并处理：

| 项 | 原写法 | 更正 |
|---|---|---|
| §5.2 第 3 条的归因 | 「扫描器读不到这个 describe 路径」 | 真正的原因是**扫描器只识别行首的 `test(`**（`readTestCall`），表达式体回调里的 `test(` 前面有 `() => `，不在行首。`matchKey` **不含** describe 路径，路径与此事无关。实测 `scanTestCases("test.describe('expr', () => test('inside expr', ...));")` 返回 `[]` |
| `r2-upgrade` 探针的退出码 | 预期会 exit 1 | 那是**预期结果**（记录一次性 UID 变化）。放进自动门禁时要按「预期 FAIL」处理 |

### 11.1 第 3 轮之后**仍然不声称**的话

- **不声称**「注册表一定会被保存」是无条件的。保存的键是 `projectUidOf(project)`；
  未迁移的旧记录用的是**重新推导**的 UID，与迁移后的 UID 相同（这是
  `docs/18-UID-SPEC` §7 的设计），所以两种安装在同一个项目上落到**同一格**。
