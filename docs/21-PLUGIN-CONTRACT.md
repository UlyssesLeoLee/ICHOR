# ATS-PLG-001 プラグイン契約 v1（Plugin Manifest / 権限リスト / Runner SDK）

- WBS：ATS-512 ｜ 阶段 / 目标版本：S5 / v1.0.0 ｜ 工作流：扩展 ｜ 主责：Desktop（桌面 / Tauri）
- 契约版本标识：`plugin-contract/v1` ｜ Manifest 版本：`plugin-manifest/v1`（第 2 轮返工后新增：权威提案记录、项目作用域、原型安全查找）
- 实现载体：`server/plugins/contract.mjs`（清单与权限）、`server/plugins/sdk.mjs`（SDK）
- 关联要件：FR-028（CI/CD 与远程执行）；上游契约：`docs/19-REMOTE-RUNNER-PROTOCOL.md`（TR-10、§9 跨平面数据约束）
- 前置依赖：ATS-501（远程 Runner 边界、威胁模型与协议冻结）—— 已达终态
- 机读校验：`tools/ats512-probes/probe-plugin-boundary.mjs`（实际输出见 `docs/evidence/ATS-512/`）
- 状态口径：本文件描述的是**已实现并经实测的契约层**。**插件宿主、加载器与沙箱不存在**——仓库中没有加载插件、运行插件或隔离插件的代码路径，因此不存在「第三方插件已可运行」这一事实。

## 1. 交付范围与边界

| 属于 ATS-512（本次已实现） | 不属于 ATS-512（后续任务） |
|---|---|
| 插件 Manifest 的形状与校验（`plugin-manifest/v1`） | 插件宿主的实现：谁来加载插件、跑在哪个进程（ATS-502/503/506） |
| 权限清单：封闭的权限词汇表与禁止权限清单 | 插件代码的**物理隔离**（模块沙箱 / 只读挂载 / 子进程）——ATS-403 |
| 宿主策略档位（tier）：声明与授予分离 | 插件的安装、签名验证与供应链（SBOM / 漏洞扫描）——ATS-516 |
| 插件 SDK 的操作面（5 个操作）与授权闸门 | 插件的 UI 与配置界面——ATS-513 |
| 审计：每次调用（含被拒、含宿主读取失败）都进宿主 sink，序号由 SDK 单调递增且只在 sink 写入成功后前进 | 审计事件的存储后端与保留期——ATS-508/509 |
| 证据：结论只能引用证据，SHA-256 由**宿主**计算 | 证据后端实现与生命周期策略——ATS-509 |
| 结论走**提案**：`approval` 恒为 `pending`，提案人不得自审 | 提案落地（改 Run 终态）——ATS-502/508 |
| **宿主持有权威提案记录**：提案由 SDK 直接交给宿主，评审比对的是宿主那一份 | 提案的持久化与跨进程共享——ATS-502/508 |
| 作用域有两层：**文件前缀**与**允许的项目**，都由宿主授予 | 租户模型与 RBAC——ATS-508 |

**完成定义（验收标准）的落实**：恶意插件请求超权被拒；插件不绕过审核/证据机制。这两条在**契约层**已成立并有实测证据（§5）。**插件宿主不存在**，因此不得据此声称「第三方插件已可安全接入」。

## 2. 三条设计原则

ATS-501 的 TR-10 把「恶意插件请求超权、绕过审核与证据机制」列为扩展面的权限提升威胁，缓解措施是「插件 Manifest 声明权限；权限超出即拒绝；插件不得跳过审计与证据链路」。本契约把这三句话落成三条**机制**，而不是三条约定。

### 2.1 声明 ≠ 授予

Manifest 里的 `permissions` 是插件的**申请**。真正生效的是：

```
生效集合 = 申请集合 ∩ 宿主档位上限 ∩ 权限词汇表
```

- **档位（tier）由宿主选，插件不能选。** 同一份声明在不同档位下生效集合不同——这是档位存在的全部意义。
- 申请超出档位 → `PLUGIN_PERMISSION_DENIED`，逐条给出原因。
- 申请永远不可授予的权限 → `PLUGIN_PERMISSION_FORBIDDEN`。
- 申请词汇表外的权限 → `PLUGIN_PERMISSION_UNKNOWN`。

**权限词汇表是封闭的**：不在表里的名字一律 `PLUGIN_PERMISSION_UNKNOWN`。因此新增权限必须先改词汇表——插件无法靠声明获得一个「未定义但默认可用」的权限。

### 2.2 作用域由宿主授予，不由清单声明

Manifest **没有** scope 字段。作用域有**两层**，都由宿主在建 SDK 时授予，默认都是**空的**：

| 层 | 宿主授予什么 | 越界时 |
|---|---|---|
| 文件前缀 | `createPluginSdk({ scope: { files: ['tests'] } })` —— 可读的相对路径前缀 | `PLUGIN_SCOPE_INVALID` + 审计 |
| 允许的项目 | `createPluginSdk({ projects: ['proj_x'] })` —— 插件可以访问的 projectId | `PLUGIN_SCOPE_INVALID` + 审计 |

四个操作（`readTestFile` / `readRequirements` / `readRunEvidence` / `reportOutcome`）都先过**项目闸门**再过**路径闸门**。插件把别的项目的 id 传给 SDK，SDK 直接拒绝并记审计，**根本不会把那个 id 交给宿主**。

理由：如果插件能声明自己的作用域，它就能扩大自己的文件访问面。作用域与档位一样，是**宿主的决定**。项目这层是同一个道理：文件作用域如果不绑定项目，一个插件就能用自己的文件作用域去读另一个租户的测试。

**本任务范围内没有租户模型，也没有插件宿主**，所以这层闸门证明的是「SDK 本身不会把未授权的项目 id 传出去」，不是「跨租户攻击已被端到端阻断」。

### 2.3 审计与证据由宿主掌握

- **审计 sink 由宿主构造并持有**。SDK 只往里写，插件拿不到 sink 的引用，也无法指定自己的事件序号。SDK 的序号单调递增，**且只在 sink 写入成功之后才前进**——sink 抛错说明这条事件没有落进序列，序号就停在原处，「序号与 sink 已写入的条数一致」才不是一句空话。
- **每一次 SDK 调用都留痕**。成功的调用、被拒的调用、宿主读取失败的那一次，全都各写**恰好一条**审计事件。被拒的调用（越权、越作用域、越项目、试图跳过证据、试图提交非法提案）**同样**记审计事件——「插件试图越权」是需要留痕的事实。
- **证据的 SHA-256 由宿主的 resolver 计算**。插件只能给出引用；`reportOutcome` 不接受插件自报的摘要。
- **结论是提案**：`approval` 恒为 `pending`，`producedBy` 是 `plugin:<id>`，提案人不得自审（与 ATS-401 同一口径）。

### 2.4 提案由**宿主**持有，插件手里那份不是权威记录

这一条是「插件不绕过审核/证据机制」能够真正成立的地方。

- **提案由 SDK 直接交给宿主**。`reportOutcome` 把提案连同它的证据摘要交给 `host.submitProposal(...)`——不经插件转交。宿主因此握有一份**权威记录**（`host.getProposal(proposalId)` 读得回来）。
- **缺了这份记录，SDK 拒绝构造**。和 `audit` 一样，`submitProposal` 与 `getProposal` 是**必需**的宿主接口；缺了就报 `PLUGIN_HOST_REQUIRED`。没有权威记录的提案无法被核对，所以它压根不该被生产出来。
- **评审比对的是宿主记录**。`reviewPluginProposal(proposal, { reviewer, decision, host })` 会：
  - 拒绝**宿主记录里没有**的提案 → `PLUGIN_PROPOSAL_INVALID`；
  - 拒绝**字段或证据摘要与宿主记录不一致**的提案 → `PLUGIN_PROPOSAL_INVALID`（逐字段比对 `contract` / `proposalId` / `pluginId` / `pluginVersion` / `projectId` / `runUid` / `kind` / `status` / `summary` / `producedBy`，并逐条比对证据引用的 `ref` 与 `sha256`）。
  - **只做形状校验不算通过**：被篡改过的提案形状完全合法（把 `sha256` 换成别的值、把 `producedBy` 换成别人），所以比的是**内容**。
- **`proposalId` 全局唯一**。它由 CSPRNG（`crypto.randomUUID()`）生成，不依赖实例内序号——同一个插件的两个 SDK 实例不会撞号。
- **审计事件记下 `proposalId` 与各证据摘要**。事后对账时，即使插件手里那份提案已经没了或被改过，也能从审计里知道它当时指的是哪份证据。

## 3. 权限清单

### 3.1 可申请（授予）的权限

| 权限 | 含义 | 对应 SDK 操作 |
|---|---|---|
| `test.read` | 读取被测项目作用域内的测试脚本 | `readTestFile` |
| `requirements.read` | 读取需求文档 | `readRequirements` |
| `evidence.read` | 读取一次运行已归档的证据 | `readRunEvidence` |
| `outcome.report` | 上报一次运行的结论（经审核后才生效，不能直接改 Run 终态） | `reportOutcome` |

### 3.2 永远不可授予的权限

出现在 Manifest 里即拒绝，不因档位、宿主或插件身份而放宽。

| 权限 | 拒绝的理由 |
|---|---|
| `source.write` | 写被测项目的源码 |
| `git.commit` / `git.push` | 提交或推送 Git |
| `run.status.set` | 直接设置 Run 终态（绕过状态机与审核） |
| `audit.suppress` / `audit.erase` | 抑制或抹除审计事件 |
| `evidence.skip` | 不带证据就上报结论 |
| `review.self.approve` | 自审自批自己的提案 |
| `secret.read` | 读取秘密 |
| `network.egress` | 任意出网 |
| `process.spawn` | 派生进程 |

### 3.3 宿主策略档位

| 档位 | 授予的权限 |
|---|---|
| `readonly`（出厂默认） | `test.read`、`requirements.read` |
| `observer` | 上述 + `evidence.read` |
| `reporter` | 上述 + `outcome.report` |

每个档位都是权限词汇表的子集，且与禁止权限清单无交集（由 UT-PLG-016/017/051 断言）。

## 4. SDK 操作面

SDK 对象的自有属性必须与操作表**完全相等**：多一个键就多一条逃逸路径，少一个键就少一个能力。该相等性在构造时断言（`createPluginSdk` 的末尾检查），且由 UT-PLG-021 复核。

| 操作 | 所需权限 | 说明 |
|---|---|---|
| `describe()` | 无 | 自述：清单摘要、生效权限、被拒权限、审计序号 |
| `readTestFile(projectId, path)` | `test.read` | 读取作用域内的测试脚本 |
| `readRequirements(projectId)` | `requirements.read` | 读取需求文档 |
| `readRunEvidence(projectId, runUid)` | `evidence.read` | 读取一次运行的证据 |
| `reportOutcome(projectId, runUid, outcome)` | `outcome.report` | 上报运行结论（**提案**，待审核） |

SDK 的每个方法按同一顺序做四件事：**授权判定 → 作用域判定（项目 + 路径）→ 留痕 →（结论类）交回宿主**。

### 4.0 宿主必须提供的接口

`createPluginSdk({ host })` 要求宿主注入下列函数。缺任何一个，SDK **拒绝构造**：

| 接口 | 用途 | 缺失时 |
|---|---|---|
| `audit(event)` | 审计 sink。SDK 唯一的出口 | `PLUGIN_AUDIT_REQUIRED` |
| `submitProposal(proposal)` | 写入宿主的**权威提案记录** | `PLUGIN_HOST_REQUIRED` |
| `getProposal(proposalId)` | 读回那份权威记录（**同步**） | `PLUGIN_HOST_REQUIRED` |
| `readTestFile(projectId, path)` | 读测试脚本 | `PLUGIN_MANIFEST_INVALID` |
| `readRequirements(projectId)` | 读需求文档 | `PLUGIN_MANIFEST_INVALID` |
| `readRunEvidence(projectId, runUid)` | 读归档证据 | `PLUGIN_MANIFEST_INVALID` |
| `resolveEvidenceDigest(projectId, runUid, ref)` | 计算证据的 SHA-256 | `PLUGIN_MANIFEST_INVALID` |

`reviewPluginProposal` 也需要宿主：评审要拿宿主记录做比对，所以它同样要求 `host.getProposal`。

### 4.1 错误码

| 错误码 | 触发条件 |
|---|---|
| `PLUGIN_MANIFEST_INVALID` | 清单字段形状不对 |
| `PLUGIN_MANIFEST_VERSION_UNSUPPORTED` | 清单版本不是 `plugin-manifest/v1` |
| `PLUGIN_PERMISSION_UNKNOWN` | 权限不在词汇表内 |
| `PLUGIN_PERMISSION_FORBIDDEN` | 权限永远不可授予 |
| `PLUGIN_PERMISSION_DENIED` | 权限未被授予（调用时） |
| `PLUGIN_CAPABILITY_UNKNOWN` | capability 不在 ATS-301 词汇表内 |
| `PLUGIN_CAPABILITY_REQUIRED` | runner 插件缺四个必需能力 |
| `PLUGIN_SCOPE_INVALID` | 路径越出宿主授予的作用域，或项目不在宿主授予的项目列表内，或 runUid 不是 run id |
| `PLUGIN_OPERATION_UNSUPPORTED` | 调用了不存在的操作 |
| `PLUGIN_AUDIT_REQUIRED` | 宿主没有审计 sink——SDK 拒绝构造 |
| `PLUGIN_HOST_REQUIRED` | 宿主没有权威提案存储（`submitProposal` / `getProposal`）——SDK 拒绝构造 |
| `PLUGIN_EVIDENCE_REQUIRED` | 结论没有证据引用，或宿主解不出摘要 |
| `PLUGIN_PROPOSAL_INVALID` | 结论本身不合法；或评审的提案**宿主记录里没有**、或字段与证据摘要**与宿主记录不一致** |
| `PLUGIN_REVIEW_SELF_FORBIDDEN` | 提案人自审 |
| `PLUGIN_REVIEW_STATE_INVALID` | 评审参数或状态不对 |

## 5. 实测证据

### 5.1 单元测试（UT）

`tests/plugins.test.mjs` —— 87 项，覆盖清单校验、权限解析、档位天花板、SDK 操作面、审计单调性与完整性、文件与项目作用域、证据来源、权威提案记录与评审规则。实测输出：`docs/evidence/ATS-512/01-plugin-ut.log`（87 通过 / 0 失败）。

**覆盖率**（`node --test --experimental-test-coverage --test-coverage-include='server/plugins/**' tests/plugins.test.mjs`）：

| 文件 | 行覆盖率 |
|---|---|
| `server/plugins/contract.mjs` | 95.44% |
| `server/plugins/sdk.mjs` | 91.87% |

实测输出：`docs/evidence/ATS-512/10-plugin-coverage.log`。

### 5.2 集成测试（IT）

`tests/plugins-api.test.mjs` —— 17 项，在真实 Bridge（隔离数据目录 + 随机端口）上验证：

- `GET /api/plugins/contract` 暴露权限清单与 SDK 操作面；
- `POST /api/plugins/validate` 校验清单，并回报**该档位下真正生效**的权限；
- 违反契约的清单 → 400 + `PLUGIN_*` 错误码；
- 错误响应**不含本机路径**；
- 校验端点**不加载、不运行、不安装**任何东西（数据目录无变化）；
- `PLUGIN_*` 的错误映射作用域仅限 `PLUGIN_*`，其它错误保持 ATS-512 之前的行为；
- 档位取 `toString` / `__proto__` / `constructor` / `hasOwnProperty` / `valueOf` 一律 400 `PLUGIN_MANIFEST_INVALID`（原型链上的名字不是档位），错误体不回显 JS 内部错误文本。

实测输出：`docs/evidence/ATS-512/02-plugin-api-it.log`（17 通过 / 0 失败）。

### 5.3 边界探针

`tools/ats512-probes/probe-plugin-boundary.mjs` —— 探针扮演**宿主**，用受控的档位与作用域构造 SDK 并交给样例插件，证明：

1. 越权调用被拒（`PLUGIN_PERMISSION_DENIED`），且**被拒本身被审计**；
2. 结论是提案（`approval=pending`），插件不能自审；
3. 证据摘要来自宿主 resolver；插件自带的摘要被拒；无证据的结论被拒；
4. 越作用域的读取被拒，且被审计；
5. **负控**：同一个插件、同一个调用，只把档位从 `readonly` 换成 `reporter`，同一个调用就**被允许**——因此信号 1 的拒绝确实来自权限清单，而不是一个坏掉的 SDK；
6. 权限词汇表封闭：表外名字被拒并说明理由；每个档位都只是词汇表的子集；
7. **宿主持有权威提案记录**：宿主记录里没有的提案、字段或证据摘要与宿主记录不一致的提案、重新签名的提案，都被拒；`proposalId` 跨实例唯一；审计事件记下 `proposalId` 与各证据摘要；
8. **每一次被拒的调用都留痕**，包括 `describe()`；
9. **原型链上的名字不是表项**：`constructor` / `__proto__` / `toString` / `hasOwnProperty` / `valueOf` 既不是操作也不是档位。

探针的结论行**只写它实际验证过的内容**，并明确写出它**没有**验证的部分（见 §8 第 6 条）。

实测输出：`docs/evidence/ATS-512/03-plugin-boundary-probe.log`。

### 5.3b 第 1 轮复核反例的闭合检查

第 1 轮复核附了 11 条反例（契约/SDK 侧 `ce.mjs` 与 HTTP 侧 `http.mjs`）。`tools/ats512-probes/check-review-counterexamples.mjs` 把**同样的攻击**打在当前树上，逐条报告它是否**仍然复现**：

```
0 counterexample(s) still reproduce, 11 no longer reproduce
```

实测输出：`docs/evidence/ATS-512/11-review-counterexamples.log`。

### 5.4 全量套件与既有失败

`npm test` 在**合并后的 dev 树**上：**1345 通过 / 0 失败 / 4 跳过**（`docs/evidence/ATS-512/04-full-test-suite.log`）。跳过数随环境里示例工程是否装了 `node_modules` 变化，**以日志为准**，不引用别处的数字。

第 1 轮交付时，全量套件里有一个失败 **IT-API-013**，属 ATS-301：示例工程 `examples/sample-playwright/` 在那个检出里没有 `node_modules`，适配器因此把必需能力报为不支持，协商返回 409 而不是 200。当时用 `tools/ats512-probes/prove-baseline-regression.sh` 在不含本任务任何代码的参考树上复跑，确认它是既有失败。

**本轮该失败已不复现**：合并后的 dev 树与本分支的全量套件都通过。`prove-baseline-regression.sh` 的判定因此改为「两棵树的失败数必须一致」——参考树取本分支与 dev 的 **merge-base**（第 1 轮的交付已在 dev 上，所以不能再拿 dev 当参考树），两棵树都全绿时报告「没有需要归因的失败」，而不是硬凑一个「既有失败」的借口（`docs/evidence/ATS-512/09-baseline-regression.log`）。

### 5.5 回归检查

| 检查 | 结果 | 输出 |
|---|---|---|
| WBS 更新器共存回归（10 个更新器） | OK | `docs/evidence/ATS-512/05-wbs-updater-regression.log` |
| ATS-501 远程协议契约审计（本任务消费它） | 108/108 OK | `docs/evidence/ATS-512/06-ats501-protocol-audit.log` |
| 基线 ADR 的 `file:line` 引用全部解析 | OK | `docs/evidence/ATS-512/07-adr-citation-check.log` |
| ATS-101 硬编码端口审计 | OK | `docs/evidence/ATS-512/08-port-audit.log` |
| 两个插件模块的行覆盖率（contract.mjs 95.44%、sdk.mjs 91.87%） | OK | `docs/evidence/ATS-512/10-plugin-coverage.log` |
| 第 1 轮复核的 11 条反例全部不再复现 | OK | `docs/evidence/ATS-512/11-review-counterexamples.log` |

## 6. API 面

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/plugins/contract` | token | 插件契约 v1 描述（权限清单 / 禁止清单 / 档位 / 操作面 / 错误码） |
| POST | `/api/plugins/validate` | token | **只校验**插件清单；不加载、不运行、不安装；违反契约返回 400 + `PLUGIN_*` 错误码 |

`GET /api/diagnostics` 的 `pluginContract` 字段报告契约版本与状态（`CONTRACT_ONLY`）。

## 7. 协议样例

`examples/sample-plugin/` 是插件作者要面对的完整形状：

- `manifest.json` —— 清单：声明 `test.read` 与 `requirements.read`；
- `index.mjs` —— 插件本体：只经由 SDK 访问宿主能力，不直接碰文件系统。

**这是协议样例，不是可运行的插件**：仓库里没有插件宿主，`export default` 是宿主**会调用**的函数，不是任何东西自行执行的入口。它**不会自己运行**——由探针扮演宿主来驱动它，除此之外没有任何东西会执行它。

## 8. 未验证项声明（PENDING ≠ PASS）

1. **插件宿主不存在**：仓库里没有加载插件、运行插件、隔离插件的代码路径。本任务交付的是**契约**，不是可运行的插件体系。
2. **没有插件被执行过**：`examples/sample-plugin` 只被探针在**宿主角色**下驱动过，没有真实的第三方插件被安装、加载或运行。
3. **签名未验证**：`manifest.publisher.signature` 是契约上的一个槽位，**没有任何代码校验它**。发布者签名链属 ATS-516。
4. **审计 sink 未接后端**：SDK 的审计事件交给宿主提供的函数，本仓库没有把它落进 ATS-508 的审计事件存储，也没有跨租户隔离。
5. **权限提升路径未审**：`resolvePluginPermissions` 的判定是纯函数，已测；但「宿主在什么条件下抬高档位」是 ATS-508 的 RBAC 决策，本任务不涉及。
6. **插件隔离未实现，SDK 不提供这些能力**：SDK **不提供**文件、进程、网络与秘密的能力（SDK 不 import 任何 I/O 模块，见 UT-PLG-050）——但这只说明**这个 SDK 的操作面里没有**这些能力。**同进程里的插件仍可自行 `import 'node:fs'`**（同进程插件的实际隔离手段属 ATS-403；ATS-403 之前无任何保证）。本仓库没有插件宿主与沙箱，所以没有任何机制阻止这件事。
7. **FR-028 仍为 `DESIGNED`**：`docs/02-REQUIREMENTS.md` 中 FR-028 未被修改，本契约不改变其状态。
8. **插件宿主不存在**：因此「宿主持有权威提案记录」这一条，本任务交付的是**契约与参考宿主接口**（`host.submitProposal` / `host.getProposal`），没有真实的插件宿主实现它。探针与 UT 扮演宿主来驱动它。
9. **没有租户模型**：项目作用域闸门证明的是「SDK 不会把未授权的项目 id 交给宿主」，不是端到端的跨租户隔离（属 ATS-508）。
10. **审计事件未接后端**：SDK 的事件交给宿主提供的函数，本仓库没有把它落进 ATS-508 的审计事件存储。

## 9. ADR 决策登记

| ADR | 决策 | 状态 | 理由 | 影响 |
|---|---|---|---|---|
| ADR-024 | 插件权限由**声明与授予分离**决定：Manifest 声明，宿主按档位授予，生效集合 = 声明 ∩ 档位 ∩ 词汇表 | ACCEPTED | 插件自己声明多少就拿多少，等于没有权限边界；档位把「宿主信任这个插件到什么程度」变成一个可审计的显式决定 | 宿主需要维护档位策略；插件作者必须理解「申请 ≠ 生效」 |
| ADR-025 | 插件的**作用域由宿主授予**，Manifest 不携带 scope 字段；作用域有**文件前缀**与**允许的项目**两层，两层都由宿主给，默认都为空 | ACCEPTED | 可声明的作用域是可扩大自己的攻击面；作用域必须与权限一样是宿主侧的决定。文件作用域不绑定项目时，一个插件就能用自己的文件作用域去读另一个租户的测试 | 宿主建 SDK 时必须显式给 `scope` 与 `projects`；默认都为空 |
| ADR-026 | 审计 sink、证据 resolver 与**权威提案记录**都由宿主持有；插件只能写入审计、只能引用证据，提案由 SDK 直接交给宿主 | ACCEPTED | 「插件不绕过审计与证据链路」若靠插件自觉就不是边界；把出口握在宿主手里，插件无法伪造也无法抑制。提案若只存在于插件手里，它离开 SDK 之后就能被改掉——只有宿主那一份能作为评审的比对基准 | 宿主必须实现 sink、resolver 与提案存储（`submitProposal` / `getProposal`）；SDK 在缺任何一个时拒绝构造 |
| ADR-027 | 插件结论是**提案**（`approval` 恒为 `pending`），提案人不得自审；评审必须拿**宿主的权威记录**比对，宿主记录里没有或对不上的提案一律 `PLUGIN_PROPOSAL_INVALID` | ACCEPTED | 与 ATS-401 的评审规则同一口径；插件直接改 Run 终态会绕过状态机与审核。只查形状不查内容挡不住篡改后的提案——它的形状完全合法 | 结论要经人工/策略评审才生效；插件 SDK 里没有「设置终态」这个操作；`proposalId` 全局唯一 |
| ADR-028 | 权限词汇表**封闭**：表外名字一律 `PLUGIN_PERMISSION_UNKNOWN` | ACCEPTED | 开放词汇表意味着新增能力会静默变成默认可用；封闭表让每次新增都必须是一次显式改动 | 新增权限必须同时改词汇表、档位与文档 |
