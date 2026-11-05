# ATS-PLG-001 プラグイン契約 v1（Plugin Manifest / 権限リスト / Runner SDK）

- WBS：ATS-512 ｜ 阶段 / 目标版本：S5 / v1.0.0 ｜ 工作流：扩展 ｜ 主责：Desktop（桌面 / Tauri）
- 契约版本标识：`plugin-contract/v1` ｜ Manifest 版本：`plugin-manifest/v1`
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
| 审计：每次调用（含被拒）都进宿主 sink，序号由 SDK 单调递增 | 审计事件的存储后端与保留期——ATS-508/509 |
| 证据：结论只能引用证据，SHA-256 由**宿主**计算 | 证据后端实现与生命周期策略——ATS-509 |
| 结论走**提案**：`approval` 恒为 `pending`，提案人不得自审 | 提案落地（改 Run 终态）——ATS-502/508 |

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

Manifest **没有** scope 字段。可读范围由宿主在建 SDK 时授予（`createPluginSdk({ scope })`），默认是**空的**——什么都读不到。

理由：如果插件能声明自己的作用域，它就能扩大自己的文件访问面。作用域与档位一样，是**宿主的决定**。

### 2.3 审计与证据由宿主掌握

- **审计 sink 由宿主构造并持有**。SDK 只往里写，插件拿不到 sink 的引用，也无法指定自己的事件序号。SDK 的序号单调递增。被拒的调用（越权、越作用域）**同样**记审计事件——「插件试图越权」是需要留痕的事实。
- **证据的 SHA-256 由宿主的 resolver 计算**。插件只能给出引用；`reportOutcome` 不接受插件自报的摘要。
- **结论是提案**：`approval` 恒为 `pending`，`producedBy` 是 `plugin:<id>`，提案人不得自审（与 ATS-401 同一口径）。

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

SDK 的每个方法按同一顺序做三件事：**授权判定 → 作用域判定 → 留痕**。

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
| `PLUGIN_SCOPE_INVALID` | 路径越出宿主授予的作用域 |
| `PLUGIN_OPERATION_UNSUPPORTED` | 调用了不存在的操作 |
| `PLUGIN_AUDIT_REQUIRED` | 宿主没有审计 sink——SDK 拒绝构造 |
| `PLUGIN_EVIDENCE_REQUIRED` | 结论没有证据引用，或宿主解不出摘要 |
| `PLUGIN_PROPOSAL_INVALID` | 结论本身不合法 |
| `PLUGIN_REVIEW_SELF_FORBIDDEN` | 提案人自审 |
| `PLUGIN_REVIEW_STATE_INVALID` | 评审参数或状态不对 |

## 5. 实测证据

### 5.1 单元测试（UT）

`tests/plugins.test.mjs` —— 52 项，覆盖清单校验、权限解析、档位天花板、SDK 操作面、审计单调性、作用域、证据来源与评审规则。

### 5.2 集成测试（IT）

`tests/plugins-api.test.mjs` —— 15 项，在真实 Bridge（隔离数据目录 + 随机端口）上验证：

- `GET /api/plugins/contract` 暴露权限清单与 SDK 操作面；
- `POST /api/plugins/validate` 校验清单，并回报**该档位下真正生效**的权限；
- 违反契约的清单 → 400 + `PLUGIN_*` 错误码；
- 错误响应**不含本机路径**；
- 校验端点**不加载、不运行、不安装**任何东西（数据目录无变化）；
- `PLUGIN_*` 的错误映射作用域仅限 `PLUGIN_*`，其它错误保持 ATS-512 之前的行为。

### 5.3 边界探针

`tools/ats512-probes/probe-plugin-boundary.mjs` —— 探针扮演**宿主**，用受控的档位与作用域构造 SDK 并交给样例插件，证明：

1. 越权调用被拒（`PLUGIN_PERMISSION_DENIED`），且**被拒本身被审计**；
2. 结论是提案（`approval=pending`），插件不能自审；
3. 证据摘要来自宿主 resolver；插件自带的摘要被拒；无证据的结论被拒；
4. 越作用域的读取被拒，且被审计；
5. **负控**：同一个插件、同一个调用，只把档位从 `readonly` 换成 `reporter`，同一个调用就**被允许**——因此信号 1 的拒绝确实来自权限清单，而不是一个坏掉的 SDK；
6. 权限词汇表封闭：表外名字被拒并说明理由；每个档位都只是词汇表的子集。

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

**样例本身不会自己运行**：仓库里没有插件宿主，`export default` 是宿主**会调用**的函数，不是任何东西自行执行的入口。探针扮演宿主来驱动它。

## 8. 未验证项声明（PENDING ≠ PASS）

1. **插件宿主不存在**：仓库里没有加载插件、运行插件、隔离插件的代码路径。本任务交付的是**契约**，不是可运行的插件体系。
2. **没有插件被执行过**：`examples/sample-plugin` 只被探针在**宿主角色**下驱动过，没有真实的第三方插件被安装、加载或运行。
3. **签名未验证**：`manifest.publisher.signature` 是契约上的一个槽位，**没有任何代码校验它**。发布者签名链属 ATS-516。
4. **审计 sink 未接后端**：SDK 的审计事件交给宿主提供的函数，本仓库没有把它落进 ATS-508 的审计事件存储，也没有跨租户隔离。
5. **权限提升路径未审**：`resolvePluginPermissions` 的判定是纯函数，已测；但「宿主在什么条件下抬高档位」是 ATS-508 的 RBAC 决策，本任务不涉及。
6. **插件隔离未实现**：契约层保证了插件**拿不到**文件、进程、网络与秘密的能力（SDK 不 import 任何 I/O 模块，见 UT-PLG-050），但这不是物理隔离——真正的沙箱属 ATS-403。
7. **FR-028 仍为 `DESIGNED`**：`docs/02-REQUIREMENTS.md` 中 FR-028 未被修改，本契约不改变其状态。

## 9. ADR 决策登记

| ADR | 决策 | 状态 | 理由 | 影响 |
|---|---|---|---|---|
| ADR-024 | 插件权限由**声明与授予分离**决定：Manifest 声明，宿主按档位授予，生效集合 = 声明 ∩ 档位 ∩ 词汇表 | ACCEPTED | 插件自己声明多少就拿多少，等于没有权限边界；档位把「宿主信任这个插件到什么程度」变成一个可审计的显式决定 | 宿主需要维护档位策略；插件作者必须理解「申请 ≠ 生效」 |
| ADR-025 | 插件的**作用域由宿主授予**，Manifest 不携带 scope 字段 | ACCEPTED | 可声明的作用域是可扩大自己的攻击面；作用域必须与权限一样是宿主侧的决定 | 宿主建 SDK 时必须显式给 scope；默认空作用域 |
| ADR-026 | 审计 sink 与证据 resolver **由宿主持有**；插件只能写入审计、只能引用证据 | ACCEPTED | 「插件不绕过审计与证据链路」若靠插件自觉就不是边界；把出口握在宿主手里，插件无法伪造也无法抑制 | 宿主必须实现 sink 与 resolver；SDK 在没有 sink 时拒绝构造 |
| ADR-027 | 插件结论是**提案**（`approval` 恒为 `pending`），且提案人不得自审 | ACCEPTED | 与 ATS-401 的评审规则同一口径；插件直接改 Run 终态会绕过状态机与审核 | 结论要经人工/策略评审才生效；插件 SDK 里没有「设置终态」这个操作 |
| ADR-028 | 权限词汇表**封闭**：表外名字一律 `PLUGIN_PERMISSION_UNKNOWN` | ACCEPTED | 开放词汇表意味着新增能力会静默变成默认可用；封闭表让每次新增都必须是一次显式改动 | 新增权限必须同时改词汇表、档位与文档 |
