# 25-MOBILE-APP-TESTING.md ｜ 移动端（App）测试执行面设计书

- 文书 ID：ATS-D-025｜状态：**PARTIAL**（ATS-601 的**契约层**、ATS-602 的**用例模型/导入映射层**与 ATS-603 的 **Android Runner**（真实模拟器实测）已实现；ATS-606 的 **iOS/Maestro 边界已冻结**（§8，三张表；§8.5 的导入器行为与参数保真由脚本生成、复核脚本逐格比对）；§6~§7 仍为纯设计，仓库内无移动端**证据归档**、**无 iOS Runner**）
- 目标版本：v0.5.0｜阶段：S6｜WBS：ATS-601 ~ ATS-606
- 需求：FR-031 ~ FR-035、NFR-013
- 起草：2026-11-06

> **基线声明**：本文描述的是**设计**，不是已实现的能力。**已实现的三层**是：
>
>   * §3 的**契约层**（目标/会话模型、状态机、能力协商、拒绝规则、安全边界）——
>     由 ATS-601 实现，UT-MOB-001..094 共 99 例实测；那是**假目标 + 假会话**上的
>     契约测试，**不是真实设备实测**；
>   * §4 的**用例模型与导入映射层**（Flow 解析、语义映射、不支持步骤的保留、
>     导入报告、UID 规则）——由 ATS-602 实现，UT-MOB-200..318 共 87 例 +
>     IT-ATS602-API-001..015 共 15 例实测；那是**文本夹具**上的映射测试，
>     **不涉及任何设备**；
>   * §5 的 **Android Runner**（ADB 传输层、视图层级解析、步骤语义与失败分类、
>     ATS-301 适配器实现）——由 ATS-603 实现，UT 共 43 例 +
>     IT-ATS603-001..022 共 9 例在**真实 Android 模拟器**上实测 +
>     IT-ATS603-030..031 共 2 例经**真实 Bridge**实测；
>     这是**模拟器**上的实测，**真机**（`local-device`）路径未实测。
>
> **仍未实现**：§6 的移动端**证据归档**（ATS-604）、§7 的能力矩阵与环境声明
> （ATS-605）。
>
> **已冻结的一节**是 §8（ATS-606 的 iOS / Maestro 边界）：三张表逐条填完，
> 判定所依据的 Maestro 命令清单、每条命令的参数清单、iOS 驱动实现状态，
> 以及 **ATS-602 导入器对 Maestro 原拼写的实际行为**（逐条实跑得出），
> 都有可机读复核的来源（复核脚本 `tools/ats606-probes/`）。
> **但「边界冻结」仍不是「实测」**——
> 本机无 macOS/Xcode/模拟器/真机，**没有任何一条 iOS 行为被实测过**；
> **本平台也没有 iOS Runner**，§8.4 写的是「以 Maestro 2.12.1 为参照的可行性」。
>
> 契约层已实现 ≠ 移动端能跑；用例模型已实现 ≠ Flow 能在设备上跑；
> **Android Runner 已实现 ≠ 移动端证据已归档 ≠ iOS 能跑**；
> 边界已冻结 ≠ iOS 能跑。任何一项在 ATS-601 ~ ATS-606 完成并通过复核之前，
> 都不得被称作「已实现」。

---

## 1. 背景与对标

用户提出：**Maestro Studio 的管理模式值得借鉴——网页和 App 也能像移动 App 一样被自动测试和管理，
本平台也要能测 App。**

### 1.1 对标结论（2026-11-06 调査）

Maestro 的产品结构分三层，共用同一个 CLI 执行引擎：

| 层 | 作用 | 本平台的对应物 |
|---|---|---|
| Maestro Studio | 可视化 IDE：连设备 → 镜像屏幕到浏览器 → 点选元素 → 生成命令 → 即时执行 | 工作台的**元素检查器**（待建） |
| Maestro CLI | 解释 YAML Flow、在设备上执行 | **RunnerAdapter** 的一个新实现 |
| Maestro Cloud | 托管设备农场，批量并行执行 | 远程执行面（ATS-501 ~ ATS-512） |

值得借鉴的**管理模式**有三条：

1. **Flow 化用例**：YAML 声明式描述用户旅程，测试人员看得懂、CI 跑得动。
2. **元素检查器**：把「当前屏幕有哪些可点的元素」变成可查询的结构，而不是靠人肉读截图。
3. **设备管理**：设备/模拟器是**被管理的资源**，有状态、有生命周期，不是执行时才临时找的。

### 1.2 明确不借鉴的部分

- **不引入 Maestro 作为依赖**。Maestro 是 Java/JVM 工具链，与本仓库的 Node + Tauri 栈不合——
  这条**技术栈不合**本身就是足够的理由，与许可证无关。
  它的许可证是 **Apache-2.0**（上游 `mobile-dev-inc/maestro` 的 LICENSE 实查），
  本身是宽松许可、可以商用；但引入它仍然意味着：分发时要带上它的
  **NOTICE 与许可声明**、并遵守 Apache-2.0 的**专利授权条款**与修改声明义务，
  同时本仓库自己的 **AGPL-3.0** 分发边界会因引入一个 Apache-2.0 组件而多出
  一份需要随包声明的许可清单。综合下来，本平台只借鉴**管理模式**，不引入依赖。
- **不宣称兼容 Maestro Flow 语法**。FR-035 的任务是**逐条判定并给出结论**（兼容 / 不兼容 /
  部分兼容），不是实现一个兼容层。
- **不做云端设备农场**。那属于远程执行面（S5），与移动端执行面是两个正交的方向。

### 1.3 与既有 WBS 的关系

移动端不是从零开始的一条平行线，它挂在既有契约上：

```
ATS-301 RunnerAdapter/ReporterAdapter 契约  ←── ATS-601 目标抽象 + ATS-602 用例模型
        │                                              │
        │                                              ├── ATS-603 Android Runner（真实实现）
        │                                              │        └── ATS-604 证据归档
        │                                              └── ATS-606 iOS / Maestro 边界
        └── ATS-304 双引擎共通结果结构 ←── ATS-604（移动端作为第三个引擎接入同一结构）
```

**ATS-601/602 必须先做**：没有统一的目标抽象和用例模型，ATS-603 就会变成第二个 Playwright 专用实现，
重现本项目已经吃过一次亏的「每加一个引擎就重写一遍执行模型」。

---

## 2. 范围

### 2.1 IN

- 三类执行目标的统一描述：本地模拟器、已连接真机、远端设备农场会话（ATS-601）。
- 移动端 Flow → 统一 TestDefinition 的映射规则与导入报告（ATS-602）。
- Android 模拟器 Runner 原型 + 真实设备冒烟（ATS-603）。
- 移动端证据（截图/录屏/日志/视图层级树）进统一 Evidence（ATS-604）。
- 多目标能力矩阵与环境依赖声明（ATS-605）。
- iOS 支持范围与 Maestro Flow 兼容性逐条判定（ATS-606）。

### 2.2 OUT（本阶段不做）

- iOS 真实执行（本机无 iOS 环境，见 ATS-606 的交付形态约定）。
- 云端设备农场调度（属 ATS-502/504/515）。
- 移动端图形化流程编辑（AST 反写属 ATS-314/315，范围不同）。
- 移动端性能测试与稳定性测试。

---

## 3. 目标抽象（ATS-601）

> **实现状态（ATS-601 交付）**：本节的**契约层**已在 `server/adapters/mobile-target.mjs`
> 与 `server/adapters/mobile.mjs` 实现，并经 UT-MOB-001..094 共 99 例实测
> （契约 + 假目标 + 假会话，**不需要真实设备**）。仓库内**仍无任何真实设备、模拟器、
> ADB 驱动或移动端证据实现**——那些分别属 ATS-603（Android Runner）、ATS-604（证据归档）、
> ATS-606（iOS 边界）。下面标注 **已实现** 的是契约层；标注 **未实现** 的是真实执行面。

### 3.1 目标与会话

**目标（Target）** 是「在哪里执行」的静态描述；**会话（Session）** 是「当前连着的那台设备」。

```
Target   { targetId, kind, platform, osVersion, capabilities[], declaredBy }
Session  { sessionId, targetId, state, capabilities[], lastSeenAt, error? }
```

`kind` 三取值：

| kind | 含义 | 生命周期 | 契约层 |
|---|---|---|---|
| `local-emulator` | 本机 Android 模拟器 / iOS 模拟器 | 由本平台创建与销毁；不创建则拒绝执行 | **已实现** |
| `local-device` | 已通过 ADB / XCUITest 连接的真机 | 平台**不接管**其安装与配对，只借用 | **已实现** |
| `remote-farm` | 远端设备农场分配到的会话 | 租约式；租约过期必须回收（复用 ATS-502 的租约语义） | **已实现** |

三种 kind 的平台权限是**契约里写死的事实**，不是调用方的选择：

| kind | 平台掌管生命周期 | 平台可安装 App | 需要租约 |
|---|---|---|---|
| `local-emulator` | 是 | 是 | 否 |
| `local-device` | 否 | **否**（只借用） | 否 |
| `remote-farm` | 否 | 否 | **是** |

`Target.capabilities` 是**声明**（目标应该能做什么）；`Session.capabilities` 是**证明**
（这台设备**已经证明**能做什么）。能力缺口按**会话**算，不按目标算——目标声明了
`ui.hierarchy` 而会话没有证明时，缺口依然存在。

会话的证明**不得超过**目标的声明：会话声称了目标从未声明的能力时，该声明**未经证明**，
因此会话在解析阶段即被拒绝（`REMOTE_CAPABILITY_MISSING`），那些能力不进入协商。

**这条规则在两条路径上都成立**：解析路径（`resolveSession`）按未声明能力拒绝整个会话；
设备层（`device.capabilities`）只把**会话能力 ∩ 目标声明**报成「已证明」，
目标未声明的能力带理由地报不支持且**不携带证据**。两条路径读的是同一份判定
（`provableCapabilities()`），因此同一个会话不会在解析路径被拒、在设备层却被报成已证明。

### 3.2 状态机

```
        create            acquire            release
idle ──────────▶ created ──────────▶ running ──────────▶ idle
                    │                   │
                    │ error            │ error
                    ▼                   ▼
                  failed ◀───────────── failed
```

**硬规则**：

- 目标不存在、设备未连接、设备被占用、能力不满足 ⇒ **明确拒绝**
  （`REMOTE_TARGET_UNAVAILABLE` / `REMOTE_CAPABILITY_MISSING`），
  **不得静默降级**成别的执行方式。
- 会话必须能回答「我现在连的是哪台设备、它支持哪些步骤」。答不上来 ⇒ 拒绝执行。
- **只有「可被获取」的会话才被交出**：一次运行通过把会话迁入 `running` 来占用设备，
  因此交出的会话必须是状态机允许迁入 `running` 的那一个（`created`）。
  未挂接（`idle`）、被别的运行占用（`running`）、已失败（`failed`）的会话**一律拒绝**——
  交出一个 `running` 会话等于让两次运行同时占用一台设备。
- 租约规则**不可关闭**：过期租约的农场会话在任何调用方式下都被拒绝。
- 真机（`local-device`）**不由平台安装 App、不接管设备配对**；平台只负责下发步骤与回收证据。

**契约层已实现**（`server/adapters/mobile-target.mjs`）：

| 规则 | 行为 | 拒绝码 |
|---|---|---|
| 目标不存在 | 拒绝 | `REMOTE_TARGET_UNAVAILABLE`（reason=target-not-found） |
| 目标没有会话 | 拒绝 | `REMOTE_TARGET_UNAVAILABLE`（reason=session-not-found） |
| 会话属于别的目标 | 拒绝 | `REMOTE_TARGET_UNAVAILABLE`（reason=session-target-mismatch） |
| 设备**未连接**（会话处于 `idle`） | 拒绝 | `REMOTE_TARGET_UNAVAILABLE`（reason=device-not-connected） |
| 设备**被占用**（会话处于 `running`） | 拒绝 | `REMOTE_TARGET_UNAVAILABLE`（reason=device-occupied） |
| 会话处于 `failed` | 拒绝 | `REMOTE_TARGET_UNAVAILABLE`（reason=session-failed） |
| 农场租约过期（含**没有到期时间**的会话） | 拒绝 | `REMOTE_TARGET_UNAVAILABLE`（reason=lease-expired） |
| 会话声称目标未声明的能力 | 拒绝 | `REMOTE_CAPABILITY_MISSING`（reason=session-capability-undeclared） |
| 能力不满足 | 拒绝 | `REMOTE_CAPABILITY_MISSING`（details.gaps 给出缺口清单） |

拒绝的 `reason` 词表是 `SESSION_UNUSABLE_REASON`：`device-not-connected` /
`device-occupied` / `session-failed`。设备层用同一份判定（`sessionUsability()`），
所以**不可用的会话不证明任何能力**——它的每一条设备能力都带理由地报不支持，
不携带「已证明」的证据。

非法状态迁移（如 `idle → running`）是**编程错误**，抛
`MOBILE_SESSION_TRANSITION_INVALID` 并列出允许的下一状态，而不是静默移动。
租约过期的农场会话由 `reclaimExpiredSession()` **回收**为 `idle`——租约语义与 ATS-502 一致：
过期必须回收，不能一直占着设备。

两个拒绝码登记在**唯一的拒绝码表** `server/control-plane/errors.mjs`，并与
`docs/19-REMOTE-RUNNER-PROTOCOL.md` §6.2 的正文表和 §10 机读约束块逐码一致
（由 `tests/control-plane.test.mjs` UT-CP-008 与 `tools/ats501-probes/audit-remote-protocol.mjs` 守护）。
`REMOTE_CAPABILITY_MISSING` 复用 ATS-501 既有码，避免同一件事有两个码。

### 3.3 能力协商

步骤类型与目标能力的匹配在**执行前**完成，产出「本次执行的能力缺口清单」：

| 步骤 | 需要的 capability |
|---|---|
| `launchApp` | `app.install` 或 `app.launch` |
| `tapOn` | `ui.tap` + `ui.hierarchy`（元素定位需要视图层级） |
| `assertVisible` | `ui.hierarchy` |
| `takeScreenshot` | `screen.capture` |
| `recordScreen` | `screen.record` |
| `readLogs` | `log.read` |

缺 `ui.hierarchy` 时，`tapOn` **不可用**——不能用坐标盲点。这与 ATS-104/303 的桌面侧同理：
能力不足要在执行前说清楚，不要在执行中炸出一个无关的错误。

能力词表（7 项）：`app.install` / `app.launch` / `ui.tap` / `ui.hierarchy` /
`screen.capture` / `screen.record` / `log.read`。

### 3.4 与既有契约的关系（ATS-301 的扩展，不是另起一套）

移动端 Runner 是 **ATS-301 适配器契约的扩展**，不是第二套契约：

| 层 | 回答的问题 | 由谁定义 |
|---|---|---|
| 引擎层 | 哪个**引擎**驱动这个项目？ | `server/adapters/contract.mjs`（ATS-301，未改动其能力词表） |
| 设备层 | 在**哪台设备**上跑、它能做什么？ | `server/adapters/mobile-target.mjs`（ATS-601，本次新增） |

- `server/adapters/mobile.mjs` 注册进**同一个**适配器注册表，通过**同一套** `assertAdapter`。
- 设备层是**可选**的 `device` 段：既有 `playwright` / `wdio` 适配器不受影响，
  引擎能力词表一个字都没改（设备能力是**另一套词表**，不混进引擎词表）。
- 两层一起协商：`negotiateWithDevice()` 把**引擎缺口**与**设备缺口**分开报告——
  「这个 runner 不支持 trace」和「这台设备导不出视图层级」是两个问题、两种修法。
- 设备层判定的是**调用方问的那个目标**（`context.target`）：会话能力与目标声明的交集
  才算「已证明」，目标未声明的能力带理由地报不支持且不携带证据，
  属于别的目标的会话对该目标不证明任何能力。

**未实现**：真实的 Android/iOS 驱动、ADB 调用、模拟器生命周期、证据写入。
移动端适配器当前的引擎能力**全部**带理由地报不支持，`start()` 直接以
`REMOTE_TARGET_UNAVAILABLE` 拒绝——调用方要移动端执行时得到的是**明确拒绝**，
而不是被悄悄换成一个浏览器跑。

### 3.5 安全边界（§9 的契约层落点）

| 边界 | 契约层行为 | 拒绝码 |
|---|---|---|
| App 包名 | 只允许项目登记过的包名 | `MOBILE_APP_PACKAGE_NOT_REGISTERED` |
| Flow 文件 | 同一套可信仓库判定，未可信项目不得执行 | `MOBILE_PROJECT_UNTRUSTED` |
| 设备选择 | 只允许用户显式登记的会话 | `MOBILE_SESSION_NOT_REGISTERED` |
| 证据落盘 | 同一套路径校验（越根拒绝）+ 宿主计算的 SHA-256 | `MOBILE_EVIDENCE_PATH_FORBIDDEN` / `MOBILE_EVIDENCE_NOT_FOUND` |

**设备选择的登记列表是白名单，不是通配符**：列表为空、缺省或不是列表，都表示
「用户没有登记任何会话」，因此**任何**会话都不可用。登记规则只有
`assertRegisteredSession()` 一份实现，适配器路径直接调用它，不另写一份。

**可信仓库判定接受 `trustOf()` 的判定记录**（`{trust, reason, at}`）：可信项目通过，
被撤销的和从未登记的被拒。判定记录不是 `"trusted"` 字符串时一律拒绝，不作猜测。

证据摘要**由宿主计算**，不接受调用方自带的摘要——设备产出的截图是**不可信输入**，
不可信输入没有资格给自己的内容命名摘要。

---

## 4. 用例模型（ATS-602）

> **实现状态（ATS-602 交付）**：本节的**用例模型与导入映射层**已在
> `server/discovery/mobile-flow.mjs`（解析）、`server/discovery/mobile-import.mjs`
> （语义映射与 UID）与 `server/discovery/mobile-flow-import.mjs`（文件级入口）
> 实现，并经 UT-MOB-200..318 共 87 例 + IT-ATS602-API-001..015 共 15 例实测。
> 那是**文本夹具**上的映射测试，**不涉及任何设备、SDK 或驱动**。
> 仓库内**仍无真实设备执行**——那属 ATS-603（Android Runner）与 ATS-604（证据归档）。
> 下文标注 **已实现** 的是映射层；标注 **未实现** 的是真实执行面。

### 4.1 映射规则

移动端 Flow（无论何种语法）映射到统一的 `TestDefinition`：

| Flow 概念 | 统一模型 |
|---|---|
| 一个 Flow 文件 | 一个 `TestDefinition`（suite） |
| Flow 内的一个场景 | 一个 `TestCase` |
| 场景内的一步 | 一个 `TestStep`，带 `kind` 与参数 |
| 步骤的断言 | `TestStep.assertion` |

**已实现**：移动端用例进入**同一个**用例目录（`discoverStatic` 的 `mobile` 段），
与 Web 用例同为 `TestDefinition`——同样的 `uid`/`uidSource`/`uidStable`/`file`/
`title`/`line`/`level`，多出 `engine: 'mobile'`、`steps`、`appId`、`tags`。
UID 规则的**形状**与 ATS-201 相同（见 §4.3），**注册表是同一个**——
移动端条目与 Web 条目写进同一个 project cell，任何一侧都不修剪另一侧。

可信项目走**权威目录**时，移动端用例同样在目录里（见 §4.3.3）。

### 4.1.1 映射按语义判定，不按拼写

§8.2 的原则在这里是实现约束：**判定只看「这一步在设备上做什么」**。
所以映射表是**语义表**——每个语义动作（启动 App / 点按元素 / 断言可见 / 截图 /
录屏 / 读日志）列出各语法可能用的**拼写**：

| 语义动作（= ATS-601 的 step kind） | 读得懂的拼写 |
|---|---|
| `launchApp` | `launchApp` / `launch` |
| `tapOn` | `tapOn` / `tap` |
| `assertVisible` | `assertVisible` / `assert` |
| `takeScreenshot` | `takeScreenshot` / `screenshot` |
| `recordScreen` | `recordScreen` / `record` |
| `readLogs` | `readLogs` / `logs` |

拼写的匹配**忽略大小写与分隔符**（`tap_on` = `tapOn`），但**报告里保留原文**。

**步骤词表是封闭的**：映射器在**装载时**校验自己产出的每个 step kind 都在
ATS-601 冻结的词表里。往语义表里加一个 ATS-601 没有的种类会**直接报错**——
因为 ATS-601 之外的种类没有能力要求，§3.3 的能力协商就没有东西可匹配。

### 4.1.2 两种语法

平台自带两种 Flow 语法，按**文件扩展名**选择（`.yaml`/`.yml` 为 YAML 声明，
`.flow` 为线性声明）：

```
app: com.example.app          |    appId: com.example.app
scenario: Login with email    |    ---
  tags: smoke,login           |    - name: Login with email
  launch com.example.app      |      tags:
  tap "Login"                 |        - smoke
  assert visible "Welcome"    |      steps:
  screenshot home             |        - launchApp:
                               |            appId: com.example.app
                               |        - tapOn: "Login"
```

**两种语法映射到同一组步骤**，所以同一个场景在两种语法下是**同一个用例**。
这不是为了兼容某个第三方工具的语法（那属 ATS-606 的逐条判定），
而是为了**让「切换导入方式不改变已有 UID」这条要求可被实测**：
只有一个语法的话，这条性质无人验证。

### 4.2 映射不了的步骤怎么办（关键规则）

**保留原文 + 标记不支持 + 进入导入报告**，绝不静默丢弃，也绝不"猜"一个近似步骤。

**已实现**。一个不支持的步骤带着四样东西进报告：

| 字段 | 含义 |
|---|---|
| `raw` | **原文**（作者写的那一行，含引号与拼写） |
| `line` | 声明所在的行号 |
| `reason` | 判定原因（封闭词表：`unknown-command` / `missing-argument` / `unsupported-qualifier` / `unmapped-section`） |
| `reasonText` | 原因的人话说明 |
| `suggestion` | 建议的替代步骤种类（知道时给出） |

导入报告至少给出：Flow 路径、行号、原始步骤文本、判定原因、建议的替代。

**不静默丢弃**是**可测的**，不是一个说法：UT-MOB-231 直接断言
「声明的步骤数 = 已映射 + 已报告」。UT-MOB-286 把这条等式放到**五种形状**
的 Flow 上（普通步骤列表、模型不映射的列表、命名两个命令的步骤、线性语法
的 `env:` 块、线性语法的多余参数）——每一种形状下等式都成立。
实现把「不静默丢弃」拆成几条各自的规则，每条都有**反例测试**。

同类规则还有四条：

* **模型外的参数**：步骤能映射、但它带的参数不在统一模型里时，参数**保留**
  并产生一条**告警**（报告的 `warnings`），不丢弃。
* **步骤的选项**（`optional` / `when` / `timeout` / …）：它们不是命令，而是
  「这一步在什么条件下跑」。统一模型里没有它们的位置，所以它们**保留在步骤里**
  并**产生一条告警**——一个条件步骤悄悄变成无条件步骤，会在作者没要求的地方跑。
* **同一个参数的两种写法**（`text:` 与 `title:` 同时出现）：保留第一个，
  第二个**不采用**，并**产生一条告警**——悄悄覆盖会让步骤点错元素。
* **缺必需参数的步骤**：`tapOn` 没有目标就无法执行，因此该步骤被判为
  **不支持**（`missing-argument`）并进报告，而不是产出一个运行期才炸的步骤。
  目标可以是**文本**或**资源 id**——两者都是「指向哪个元素」的方式。

这与本仓库既有的「受控子集」原则一致（见 ATS-314 的 AST 受控步骤子集）：
**能反写的才反写，不能反写的原位保留。**

### 4.2.1 模型不映射的段落（`unmapped-section`）

一个 Flow 可能声明平台读不懂的段落：`onFlowStart:`、场景的 `setup:`、
第二个 `commands:` 列表。**它们里的每一步都进报告**（`unmapped-section`），
带原文与行号。

规则是：**平台不跑的步骤，作者必须知道。** 一个 `onFlowStart:` 里的
`launchApp` 被静默跳过，Flow 看起来导入成功、报告干净，而实际上第一步
根本没执行——这正是本任务要防止的失败形态。

### 4.2.2 读取器不得读一半

Flow 是**不可信输入**，读取器是**受限**的。它的三条底线：

* **文档读不到尾就是错误**：读完后还有剩余 token 时报错并指出位置，
  而不是悄悄丢掉后面的整个场景。
* **一个步骤只能有一个命令**：一个步骤里出现第二个命令键时报错并整条上报，
  不是只取第一个。
* **一个文件不能有幻影用例**：头部有 `name`、正文是步骤列表时，产出的是
  **一个**用例（头部给它标题），不是一个 0 步的幻影用例加一个真用例。

### 4.3 UID

移动端用例进入 ATS-201 的稳定 UID 规范：文件+行号为 basis，标题为 key。
切换导入方式（不同 Flow 语法解析器）不得改变已有 UID——这与 ATS-202 的
「切换索引不改变已有 UID」是同一条约束，验收时复用同一组反例。

**已实现**。阶梯的**形状**与 ATS-201 相同（显式标注 → 注册表 → 标题键 →
步骤指纹 → 临时 UID），但**不是同一段实现**：ATS-201 的 `resolveIdentities`
按 `bodyText`（源码正文）算指纹，移动端的指纹是**步骤序列**（种类 + 参数 +
断言），所以移动端有一套自己的解析函数 `resolveMobileUids`。

| # | 条件 | `uidSource` | `uidBasis` |
|---|---|---|---|
| 1 | 标题含 `@TC-<token>`（且没有别的用例也声明它） | `explicit` | `explicit` |
| 2 | 注册表按**步骤指纹**记得这个用例 | `registry` | `body-key` |
| 3 | 标题键在本次导入内唯一 | `derived` | `position-title` |
| 4 | 步骤指纹唯一 | `derived-body` | `body-key` |
| 5 | 都无法判定 | `provisional` | —（报告歧义） |

移动端用例的**执行体**是它的**步骤序列**（种类 + 参数 + 断言的指纹）。
两个用例标题相同、步骤不同 ⇒ 两个不同的用例；标题相同、步骤相同 ⇒ 歧义，
给临时 UID 并报告候选，**不静默合并**。

派生 UID 的 basis 是**位置**（文件 + 行号）加标题键做区分，
**不是标题**、更**不是语法**：这正是「切换导入方式不改变已有 UID」的实现方式。
改标题后由注册表按步骤指纹认回原 UID（`uidSource=registry`，实测于
UT-MOB-242、IT-MOB-281 与 IT-ATS602-API-009）。

#### 4.3.1 身份是项目的属性，不是文件的属性

三件事决定移动端用例的身份，它们的范围都是**整个项目**：

* **步骤指纹的唯一性按全项目判定**。两个 Flow 文件可能声明同样的步骤
  （`flows/android.yaml` 与 `flows/ios.yaml` 常常如此），一个文件里唯一的
  指纹在项目里未必唯一。按文件判定会让两个不同的用例拿到**同一个 UID**。
* **注册表匹配限定在同一个文件内**（只导入单个文件时）。调用方只知道自己
  的那一个文件时，无法知道别的文件里有没有同样的步骤——把注册表的 UID
  交给这样一个用例，就是把同一个 UID 给了两个用例。
* **重复的 `@TC-` token 按统一目录判定**。一个 token 只命名**一个**用例，
  所以一个 Web 用例与一个移动端用例同时声明 `@TC-100` 时，**两方都不绑定**，
  都标 `duplicate-explicit-uid`、`uidStable:false` 并计入告警。这与两个
  Web 用例声明同一个 token 的处理一致——两个引擎是**同一个目录**，
  不是两个恰好放在一起的目录。这条规则在**两条目录路径**上都成立：静态目录
  （`resolveIdentities`）与可信项目的权威目录（`resolveAuthoritativeIdentities`）
  拿到的是同一份跨引擎普查结果，Web 一方在权威路径上同样不绑定（实测于
  UT-MOB-318 与 IT-ATS602-API-015）。
* **显式声明的 token 是保留的，且按统一目录保留**。本次发现中任何用例——
  无论 Web 还是移动端——显式声明的 token，注册表都**不得再发给别的用例**。
  一个移动端场景去掉了 `@TC-600`、同时一个 Web 用例写上了 `@TC-600`：
  Web 用例按显式声明拿到 `tc-600`，移动端场景**不**经注册表拿回 `tc-600`，
  而是改走派生路径并报告 `explicit-uid-claimed-by-another-case`。两个解析器
  拿到的是**同一个**保留集合——两个引擎显式声明的 token 的**并集**，不只是
  被重复声明的那些（实测于 UT-MOB-312、UT-MOB-313、UT-MOB-316 与
  IT-ATS602-API-012）。**保留规则在两条目录路径上都成立**：权威路径的
  `resolveAuthoritativeIdentities` 与静态路径的 `resolveIdentities` 接收同一份
  普查（`claimed` 与 `duplicated`），注册表命中——无论按步骤/正文指纹还是按
  位置锚点——都**不得发出**被声明的 token。反向序列「Web 用例去掉 `@TC-650`、
  同时移动端场景写上 `@TC-650`」在可信项目上同样不产生重复 UID：移动端场景按
  显式声明持有 `tc-650`，Web 用例改走派生路径并报告
  `explicit-uid-claimed-by-another-case`（实测于 UT-MOB-317 与 IT-ATS602-API-015）。
* **同一个 UID 被两个用例要求时，按一条规则判定持有者**：显式声明 > 注册表命中 >
  其余；落选方若步骤指纹在项目内唯一则改为 `derived-body`，否则给临时 UID 并报告。
  这与 Web 的 `resolveIdentities` 是同一条规则，不另立第三种。典型序列是
  「复制场景 `Login` 为 `Login copy`，再修改原场景的步骤」：原场景按位置+标题
  派生出旧 UID，副本经注册表也命中旧 UID——副本持有它（注册表记得的是那组步骤），
  被修改的原场景得到新 UID（`derived-body`）。目录内不出现重复 UID
  （实测于 UT-MOB-314 与 IT-ATS602-API-013）。

#### 4.3.2 注册表是持久化的，且两个引擎共用一个 cell

移动端的注册表条目与 Web 的条目写进**同一个 project cell**。这不只是
「省事」：

* 任何一侧都**不修剪**另一侧的条目（修剪规则是「本次发现覆盖到的文件里
  不再有人认领的条目才删」，而一个移动端条目不在 Web 那次发现的范围内）。
  **权威路径同样执行这条修剪规则**：合并后的 cell 以权威解析器**修剪后**的
  cell 为底，再把移动端条目并进去——按 uid 更新已有条目（最新的位置胜出，
  旧副本不会盖过更新），移动端文件范围内无人认领的条目删除。一个用例被删除后，
  它的 UID 不会在之后的发现里交给同指纹的新用例，可信项目与未可信项目一致
  （实测于 UT-MOB-315 与 IT-ATS602-API-014）。
* 注册表合并**不改写调用方传入的条目**：每次发现产出新的 cell，由 Bridge 写回；
  在同一次发现里先后读同一个注册表的两段代码看到的是同一份内容。
* 一个用例从 Web 挪到移动端（或反过来）**保留身份**——注册表还认得它。
* **改标题后 UID 不变**，实测于 UT-MOB-281（进程内）与 IT-ATS602-API-009
  （经 HTTP）。

#### 4.3.3 可信项目也一样

移动端用例进入**权威目录**（`authoritative`）的成功路径，与静态目录一样。
`playwright test --list` 只知道 Web 用例——没有 Flow 文件是 Playwright 测试
文件——所以移动端用例是在这条路径上**另外导入并并入**的。

不这样做的后果是：项目一旦被标记为可信，它的移动端用例就**整体消失**——
不是被挪到别处，是没了，而且目录里连一个说明都没有。IT-ATS602-API-011
实测这一条。

### 4.4 Flow 的位置与信任

**已实现**。Flow 文件在**约定目录**下被发现（`flows/`、`mobile/`、`tests/flows/`、
`tests/mobile/`）——仓库里可能有几百个 YAML（CI 配置、k8s 清单），它们都不是 Flow。

* 发现是**递归**的：`flows/smoke/login.yaml`、`tests/mobile/android/pay.flow`
  这样的嵌套路径**照样被找到**并导入（UT-MOB-270）。递归时走的是**相对项目根
  的路径**，不是目录名——否则嵌套的 Flow 永远找不到，而项目根下与 Flow
  目录同名的目录会被当成 Flow 目录读（UT-MOB-271）。
* Flow 文件是**不可信输入**：解析器只**读文本**，**不执行任何内容**。
  仓库内**没有引入 YAML 运行库依赖**（`package.json` 无依赖，锁文件为空）——
  解析器是平台自带的**受限 YAML 子集读取器**：块映射、块序列、标量、
  行内集合都读；锚点、别名、标签**不读**，用到它们的 Flow 报**错误**而不是
  读一半。文档读不到尾也是**错误**（§4.2.2）。
* 项目根之外的 Flow 路径被**拒绝**（`flow-outside-project`），报告为错误。
* 读不出的 Flow、读不动的 Flow 都**报告**，不抛异常、不静默返回空。

### 4.5 导入报告

**已实现**。报告是**数据**（`buildImportReport`），文本形式由
`formatImportReport` 渲染，随用例目录一起由 API 提供
（`GET /api/projects/<id>/tests` 的 `mobile.imports`）。报告给出：

| 字段 | 含义 |
|---|---|
| `cases` / `mappedSteps` | 产出的用例数与已映射步骤数 |
| `unsupportedSteps` / `unsupportedByReason` | 不支持步骤数与按原因的分布 |
| `unsupportedSteps_detail` | 每一个不支持步骤的原文、行号、原因、建议 |
| `warnings` / `warnings_detail` | 模型外参数、步骤选项、别名冲突的告警 |
| `errors` / `errors_detail` | 读取错误 |

**静态目录与权威目录都带这份报告**（`mobile.imports`）：可信项目切到
权威索引后，移动端的导入报告照样在（见 §4.3.3）——报告是作者唯一的反馈
渠道，路径不同不该让它消失。

---

## 5. Android Runner（ATS-603）

> **实现状态（ATS-603 交付）**：本节的 **Android Runner 已实现并在真实 Android 模拟器上实测**。
> 实现分布在 `server/adapters/` 的四个新模块：
>
>   * `android-adb.mjs` —— **唯一的 ADB 传输层**。只以**参数向量**调用 `adb`
>     （`shell: false`），绝不拼接 shell 字符串，因此 Flow 带来的包名/元素文本
>     永远只是一个参数，不会成为命令。失败原因分四类：`adb-missing` /
>     `device-absent` / `device-offline` / `command-failed`。
>   * `android-hierarchy.mjs` —— **视图层级树解析器**。仓库无 XML 依赖，
>     解析器是自带的严格读取器：读不到尾即报错，不静默丢弃后半段；
>     未知实体报错；bounds 畸形报错（不会静默变成 0 矩形）。
>   * `android-runner.mjs` —— **步骤语义与失败分类**（§5.3）。
>   * `android-adapter.mjs` —— **ATS-301 适配器实现**，`kind=android`，
>     与 ATS-601 的契约骨架 `kind=mobile` **并列注册、互不覆盖**。
>
> **已实测**：UT-ATS603-001..047 共 31 例 + UT-ATS603-050..065 共 12 例（UT，不需设备），
> IT-ATS603-001..022 共 9 例在**真实模拟器**（Android 15 / API 35，
> `Pixel_6_API_35`，WHPX 加速）上实测，
> IT-ATS603-030..031 共 2 例走**真实 Bridge**（HTTP）走完运行生命周期。
>
> **仍未实现**（§6~§8 仍是设计）：证据归档与统一查询（ATS-604）、
> 能力矩阵与环境声明（ATS-605）、iOS 与 Maestro 边界（ATS-606）。
> 本机**无 iOS 环境、无 Android 真机连接**，两者本项未实测。

### 5.1 执行路径

```
Flow 解析 → TestCase → 步骤调度 → 设备会话 → 逐步骤下发 → 逐步骤采集证据 → 汇总
```

Runner 必须是 **RunnerAdapter 的一个实现**，不得绕开 ATS-301 的契约另起一套。

**已实现**：`server/adapters/android-adapter.mjs` 注册进**同一个**适配器注册表，
通过**同一套** `assertAdapter`，用**同一套** `negotiate` / `negotiateWithDevice`
协商。步骤词表沿用 ATS-601 冻结的六类，参数沿用 ATS-602 的映射，
能力要求**直接读 ATS-601 的表**——Runner 不另立一套语义。

### 5.2 冒烟用例的最低要求

ATS-603 的验收必须在**真实 Android 模拟器**上跑通下列四类步骤，且每类都有实测输出：

| 步骤 | 断言 | 实测结果 |
|---|---|---|
| 启动 App | 应用进入前台，包名与预期一致 | ✅ IT-ATS603-010/020：`foreground.package=com.ichor.smoke` |
| 点按元素 | 目标元素被点中（后续状态可观察） | ✅ IT-ATS603-011/020：点按后第二屏出现 |
| 断言可见 | 元素确实可见；不可见时给出元素名而非泛化失败 | ✅ IT-ATS603-012/020：失败时点名元素并附层级树 |
| 截图 | 截图文件落盘、尺寸正确、可被证据清单引用 | ✅ IT-ATS603-013/020：1080×2400 的 PNG 落盘 |

**夹具**：测试 App `com.ichor.smoke`，由 `tools/ats603-probes/build-smoke-app.sh`
用 SDK 自带的 `aapt2` / `javac` / `d8` / `zipalign` / `apksigner` 构建——
**无需 Gradle、无需联网**。夹具的屏幕是**已知的**（首页带 `ICHOR Smoke Home`
与按钮 `Open Details`，点按后显示 `ICHOR Detail Screen`），
所以断言测的是 **Runner**，不是某台设备的启动器界面。

### 5.3 失败的可诊断性

失败必须区分并暴露：**会话掉线** / **元素找不到**（附视图层级） / **断言不成立** / **驱动报错**。
笼统的「执行失败」不可接受——这与 ATS-512 对宿主提案的处理原则一致：**失败要说清是哪一类**。

**已实现**。失败分类是**封闭词表**（`MOBILE_FAILURE`），四类互相区分：

| 分类 | 何时 | 失败信息带什么 |
|---|---|---|
| `session-lost` | 设备掉线 / adb 不可用 / 设备不在 | ADB 的原始原因 |
| `element-not-found` | 元素不在当屏 | **当屏的视图层级树**（可自证）+ 可见元素计数 + 尝试次数 |
| `assertion-failed` | 元素在，但断言不成立 | **点名元素**及其 bounds |
| `driver-error` | 驱动本身失败 | 设备 stderr 与命令 |
| `capability-missing` | 设备缺该步骤所需能力 | 缺口清单（ATS-601 的表） |
| `refused` | 被平台规则拒绝（如包名未登记） | 拒绝码 |

**能力协商发生在第一步之前**：缺 `ui.hierarchy` 时 `tapOn` **不执行**，
按缺口报告，不会退化成盲点坐标。**包名未登记**的 App 在**触碰设备之前**就被拒绝。

**瞬时故障不算失败**：设备繁忙时 `uiautomator dump` 会偶发失败
（实测第一轮 IT 报过 "the device did not return a view hierarchy"）。
层级读取失败会被**重试**到超时；只有始终读不到才归为 `driver-error`——
且它**不是** `element-not-found`，两者不可混淆。

---

## 6. 证据归档（ATS-604）

移动端证据进**统一 Evidence 模型**（ATS-304 的双引擎结构扩展到第三类）：

| 证据 | 来源 | 备注 |
|---|---|---|
| 截图 | `screen.capture` | 每步或按策略；带 SHA-256 |
| 录屏 | `screen.record` | 长流程；大文件有保留策略（ATS-209） |
| 设备日志 | `log.read` | 按会话与时间窗切片 |
| 视图层级树 | `ui.hierarchy` | **元素定位失败的诊断证据**，不是可选附件 |
| 步骤级结果 | Runner | 与 Run/Test/Attempt 同一套模型 |

视图层级树必须被记为**一等证据**：没有它，「元素找不到」这类失败无法自证。

---

## 7. 环境与能力声明（ATS-605）

沿用 ATS-316（多 OS 能力矩阵）的口径，扩展到移动端：

| 目标 | 本机可测？ | 声明要求 |
|---|---|---|
| Android 模拟器 | 取决于宿主是否有 SDK/AVD | 有则实测；无则写明「未验证：缺 AVD」并给复现步骤 |
| Android 真机 | 取决于是否 ADB 连接 | 同上 |
| iOS 模拟器/真机 | **本机无 iOS 环境** | 一律记未验证，并注明「缺 macOS/Xcode」 |
| 远端设备农场 | 取决于 ATS-502 是否可用 | 未实现前记未验证 |

**未验证项必须写原因和复现方法**，不能只写「未执行」。这是 NFR-013 的落点。

---

## 8. iOS 与 Maestro 兼容性边界（ATS-606）

> **交付状态（ATS-606 交付）**：本节是**边界冻结**，不是实测结论。
> 三张表（§8.4 iOS 支持范围表、§8.5 Maestro 命令兼容性判定表、§8.6 不承诺清单）
> 已逐条填完并给出理由。判定所依据的事实都有**可机读复核的来源**：
>
> * Maestro 侧：本机装有 Maestro CLI **2.12.1**（`D:/AI-Tools/Maestro`，
>   2026-11-02 发布，当日最新 release）。命令清单由**行为**确认（对每条命令跑
>   `maestro check-syntax`，看 Maestro 自己认不认），不是抄文档；
>   每条命令的**参数清单**由**字节码**读出（`maestro-orchestra.jar` 的 `Yaml*` 类）；
>   iOS 两条路径的实现状态由**字节码**确认（`maestro-ios.jar` / `maestro-ios-driver.jar`
>   的 `LocalIOSDevice` / `XCTestIOSDevice` / `SimctlIOSDevice` / `DeviceControlIOSDevice`）。
> * 本平台侧：`server/adapters/mobile-target.mjs`（ATS-601 冻结的六类步骤与七项能力）、
>   `server/discovery/mobile-import.mjs`（ATS-602 冻结的语义拼写表与参数表）。
> * **导入器的实际行为**：§8.5 的「导入器实际处理」一列由**逐条实跑**
>   `parseFlow` + `importFlow` + `buildImportReport` 得出，**不是**从语义推出来的。
>
> 复核脚本：`tools/ats606-probes/`。§8.5 的表由
> `tools/ats606-probes/gen-section-rows.mjs` 生成，复核脚本会检查它与实测结果一致。
>
> **本机没有 iOS 环境**（无 macOS / Xcode / 模拟器 / 真机），
> 因此**没有任何一条 iOS 行为被实测过**。§8.4 写的是
> 「**以 Maestro 2.12.1 为参照**，这条路在 iOS 上走不走得通」，
> **不是**「本平台已经支持」——本平台**没有 iOS Runner**，
> §2.2 已把「iOS 真实执行」列为本阶段 OUT。
> 任何「已支持 / 已验证」的说法在这里都不成立。

### 8.1 交付形态

**ATS-606 以「设计与边界冻结」交付，不以实测交付**。交付物是三张表：

1. **iOS 支持范围表**（§8.4）：每个步骤类型在 iOS 上「模拟器可行 / 真机可行 / 真机不可行」，
   逐条给依据，并写明真机路径的**硬前提**。
2. **Maestro Flow 语法兼容性判定表**（§8.5）：Maestro 的每条命令，
   判定「可映射 / 部分可映射 / 不映射」，**并逐条给出 ATS-602 导入器对 Maestro 原拼写的实际处理**
   与**参数保真**。
3. **不承诺清单**（§8.6）：明确写出手工测试仍需人工完成的部分。

### 8.2 判定依据

判定只依据**语义**（这一步在设备上做什么），不依据具体 YAML 字段名——本平台不承诺兼容其语法。
但**语义能否表达**与**导入器认不认这个拼写**是两件事，§8.5 把两者分列，
后者由**实跑导入器**得出。

事实来源分两侧，各自有可机读复核的出处：

| 侧 | 依据 | 出处 | 采集方式 |
|---|---|---|---|
| Maestro 命令清单 | **哪条命令真的存在** | Maestro CLI **2.12.1**（本机 `D:/AI-Tools/Maestro`） | **行为确认**：`maestro check-syntax` 对每条候选命令判定认/不认（`tools/ats606-probes/probe-maestro-compat.mjs`）。**不抄文档清单**——文档的索引页只有 48 条，而 Maestro 实际接受 **55** 条（差的 7 条是 `inputRandom*` 家族，官方文档把它们写在 `inputText` 页里而不是索引页） |
| Maestro 的参数清单 | **每条命令有哪些参数** | `maestro-orchestra.jar` 的 `Yaml*` 类的字段 | `javap -p` 读出（`tools/ats606-probes/gen-section-rows.mjs`） |
| Maestro iOS 实现 | **每条命令在 iOS 上能不能跑** | 同上 jar 的字节码 | `LocalIOSDevice` 把操作分给两个后端：**XCTest 驱动**（20 个操作）与**deviceController**（9 个操作）。deviceController 在模拟器上是 `SimctlIOSDevice`、在真机上是 `DeviceControlIOSDevice`，**后者的实现状态与前者不同** |
| 本平台侧 | 步骤词表、能力词表、语义拼写表、参数表 | `server/adapters/mobile-target.mjs`（ATS-601）、`server/discovery/mobile-import.mjs`（ATS-602） | 源码直接读出 |
| 本平台导入器的实际行为 | **拿到 Maestro 的原拼写会怎样** | ATS-602 的 `parseFlow` + `importFlow` + `buildImportReport` | **逐条实跑** 55 条夹具（`tools/ats606-probes/probe-maestro-compat.mjs`） |

**为什么要看字节码而不只看文档**：官方文档描述的是**命令的意图**，
而「这个命令在 iOS 真机上能不能跑」取决于**该命令在 iOS 驱动里的实现**。
这两者可以不一致——文档说支持，驱动里却是 `NotImplementedError`。
§8.4 的判定必须落到后者，否则就是拿文档当实现。

**为什么要实跑导入器**：语义判断是人的判断，会错；导入器的行为是代码的事实。
把两者并排列出，读者才能看见「语义能表达，但拼写不被接受」这类情况
（`assertNotVisible` 就是一条）。
§8.5 的表由 `tools/ats606-probes/gen-section-rows.mjs` 生成，
其中「导入器实际处理」「参数保真」「计数」三列**全部是测量的结果**；
**分组**也是**推导**出来的——「语义能不能表达」与「命令形态对不对」由
Maestro 的**字节码**回答（`tools/ats606-probes/maestro-action-model.mjs`），
只有「哪个步骤种类表达这个动作」是一张**小表**（`ACTION_PLATFORM`）。
手写的表会漂移，所以表由脚本生成、由脚本复核。

**参数保真一列也是实测的**：生成器把每个**模型外参数**逐个实跑一遍导入器，
分别测两种写法——「模型内目标 + 该参数」与「只给该参数」——
并把结果（保留原文并告警 / 整步判 `missing-argument` / 仍映射）写进单元格，
**并逐个点名**是哪一个参数落在哪一种结果里。
**这一列不是「模型内 vs 模型外」的静态差集**：只给 `below:` / `childOf:`
这类模型外参数时，导入器判的是**整步 `missing-argument`**，
而不是「保留原文并告警」。

### 8.3 术语与判定口径

§8.5 的判定分**两侧**，两者的口径不同，必须分开读。

**语义侧（本平台的用例模型能不能表达这个动作）**——只有三种：

- **可映射**：本平台的步骤词表（ATS-601 的六类）里有对应种类，
  **且命令形态与本平台一致**（一步对一步：Maestro 的一步 ↔ 本平台的一步）。
- **部分可映射**：语义**能**被本平台表达，但**命令形态不同**
  （Maestro 的「开始/停止」配对命令 ↔ 本平台的单步）。
- **不映射**：本平台的步骤词表里**没有**该语义。

**导入侧（ATS-602 的导入器拿到 Maestro 的原拼写会做什么）**——只有两种，
且它是**实测**出来的，不是推出来的：

- **映射成功**：该拼写在 ATS-602 的语义拼写表里，导入后成为一步平台步骤。
- **进导入报告**：该拼写不在语义拼写表里，导入器保留原文、标出原因
  （`unknown-command` / `missing-argument` / `unsupported-qualifier`）、
  并写进导入报告。

**这两侧不是一回事**：语义可表达，不等于拼写被接受。
`assertNotVisible` 就是这样的命令——语义与命令形态都表达得了，
但 Maestro 的拼写不被接受。

> **口径只有这一套**
>
> **分组只看两件事：语义能不能表达、命令形态对不对。**
> 下面这些**一律不参与分组**，它们各有自己的列：
>
> | 因素 | 记在哪一列 | 为什么不该决定分组 |
> |---|---|---|
> | Maestro 的**拼写** | 「导入器实际处理」 | 拼写是导入侧的事实；语义能表达而拼写不被接受，正是要分两侧记的原因 |
> | **参数保真**（哪些参数在模型外） | 「参数保真」 | 参数多少不改变这一步**做什么** |
> | **等待语义**（7 秒 vs 5000 ms） | 「说明」 | 等待长短不改变这一步**是什么** |
>
> **这两条口径是机读的**（`tools/ats606-probes/maestro-action-model.mjs`）：
> 「语义能不能表达」与「命令形态对不对」都由 **Maestro 的字节码**回答——
> 每条 Maestro 命令编译成哪个 orchestra 命令类，是从
> `YamlFluentCommand._toCommands` 的字节码里读出来的；
> 「哪一步骤种类表达这个动作」由一张小表给出
> （`ACTION_PLATFORM`）；两者一合，判定就**推导**出来了，
> 不是逐条手写的。表里的一行**不可能**与这条口径矛盾——
> 复核脚本会从字节码重新推导每一行的判定并与文档比对。

> **本平台不做 Maestro Flow 语法的兼容层**（§1.2 已定）。
> 所以「可映射」的含义是「**语义**能落到本平台的步骤种类」，
> **不是**「Maestro 的 YAML 可以原样导入」。

判定粒度是**命令**（Maestro 侧）与**步骤种类**（本平台侧）两套词表，
不是 YAML 字段名。§8.5 的表把两者用「本平台对应步骤种类」一列连起来。

### 8.4 iOS 支持范围表

本平台的步骤种类是 ATS-601 冻结的**六类**（`server/adapters/mobile-target.mjs`
的 `MOBILE_STEP_KINDS`），能力词表是**七项**（`MOBILE_CAPABILITY`）。

**判定方法**：对每一类步骤，先找出 Maestro 实现它所必需的**底层操作**，
再按 `LocalIOSDevice` 的**路由**（该操作走 XCTest 驱动还是走 deviceController）
查该后端在**模拟器**（`SimctlIOSDevice`）与**真机**（`DeviceControlIOSDevice`）上的实现状态。

> **本表的读法**：这两列写的是 **Maestro 2.12.1 的实现状态**，
> **不是本平台的承诺**。本平台**没有 iOS Runner**（仓库内 `server/` 下没有任何 iOS 实现），
> §2.2 已把「iOS 真实执行」列为本阶段 **OUT**。
> 所以这里的「可行」=「以 Maestro 2.12.1 为参照，这条路的**宿主侧代码已实现**」，
> **不等于**「真机上跑得通」，也**不等于**「本平台已支持」。
> 真机上还差下面那张表的**三条硬前提**（Apple team ID 签名、
> runner 经 devicectl 装到设备、宿主到设备的 `127.0.0.1:22087` 可达），
> 这三条**在本机一条都没有验证过**——本机没有 macOS / Xcode / 模拟器 / 真机。
> 本平台侧对应的能力缺口见 §8.6。

| 本平台步骤种类 | 需要的 capability | Maestro 侧依赖的底层操作 | Maestro：iOS 模拟器 | Maestro：iOS 真机 | 参照结论 | 依据 |
|---|---|---|---|---|---|---|
| `launchApp` | `app.install` 或 `app.launch` | `launch`（走 deviceController） | 已实现 | **未实现** | 模拟器宿主侧已实现；真机侧未实现 | `SimctlIOSDevice.launch` 已实现；`DeviceControlIOSDevice.launch` 抛 `NotImplementedError`——**Maestro 自己也没有在 iOS 真机上实现 App 启动** |
| `tapOn` | `ui.tap` + `ui.hierarchy` | `tap` + `viewHierarchy`（走 XCTest 驱动） | 已实现 | 已实现 | 两条路径的宿主侧均已实现 | `XCTestIOSDevice.tap` / `viewHierarchy` 在两条路径上是**同一段宿主侧实现**，无未实现项 |
| `assertVisible` | `ui.hierarchy` | `viewHierarchy`（走 XCTest 驱动） | 已实现 | 已实现 | 两条路径的宿主侧均已实现 | 同上：断言依赖的视图层级树在真机路径上**宿主侧已实现** |
| `takeScreenshot` | `screen.capture` | `takeScreenshot`（走 XCTest 驱动） | 已实现 | 已实现 | 两条路径的宿主侧均已实现 | `XCTestIOSDevice.takeScreenshot` 已实现，两条路径同源 |
| `recordScreen` | `screen.record` | `startScreenRecording`（走 deviceController） | 已实现 | **未实现** | 模拟器宿主侧已实现；真机侧未实现 | 模拟器走 `SimctlIOSDevice.startScreenRecording`（已实现）；真机路径 `DeviceControlIOSDevice.startScreenRecording` 未实现 |
| `readLogs` | `log.read` | 设备日志流（`IOSDriver` 层，走 `xcrun simctl spawn <id> log stream --style syslog`） | 已实现 | **无对应实现** | 仅模拟器侧有实现 | 日志采集走 `LocalSimulatorUtils.startDeviceLogStream`，即 **`simctl`**；`DeviceControlIOSDevice` 里没有对应的日志流方法 |

**这张表的结论**：**Maestro 2.12.1 的 iOS 真机路径不是「全都不行」，而是「按能力分层的」**——
**UI 交互（点按、断言、截图）的宿主侧实现是齐备的**，因为它们走 XCUITest 驱动
（`XCTestIOSDevice` 的方法体在模拟器与真机上是同一段）；
但**App 生命周期（启动）与录屏在真机侧尚未实现**，因为它们走 deviceController。

> **这句话是条件句，不是「真机上可用」的结论**：
> 字节码能证明的是「**宿主侧已实现**」，**证明不了「真机上跑得通」**——
> 真机上还差下面那张表的**三条硬前提**（Apple team ID 签名、
> runner 经 devicectl 装到设备、宿主到设备的 `127.0.0.1:22087` 可达），
> 这三条**在本机一条都没有验证过**。所以真机上的 UI 交互是
> 「**宿主侧已实现，前提满足时才可能可用**」，不是「已验证可用」。

**「同一段实现」的范围要说准**：这里的「同一段」指的是**宿主侧的客户端代码**
（`XCTestIOSDevice` 的方法体）。**设备侧的 runner 是两个不同的构建**：
`driver-iPhoneSimulator/` 与 `driver-iphoneos/`，二者都在
**`maestro-ios-driver.jar`** 内。`maestro-cli-2.12.1.jar` 里只有
`driver/ios/` 下的 **Swift 源码**（含 `XCTestHTTPServer.swift`），
两个**设备侧构建产物**在 `maestro-ios-driver.jar` 的
`driver-iPhoneSimulator/` 与 `driver-iphoneos/` 两个目录下；
本机逐个 jar 列表核对过：**没有任何 jar 含 `driver-ios/` 这个目录**。
宿主侧代码相同，**不代表设备侧产物相同**，也不代表真机上这条路径已被验证。

**真机路径的硬前提**（字节码可证，均**未在本机验证**）：

| 前提 | 依据 | 本平台的状态 |
|---|---|---|
| 必须用 **Apple team ID** 自行构建并签名 `driver-iphoneos` | `maestro.cli.driver.RealIOSDeviceDriver` 的字节码里有 `Apple account team ID must be specified to build drivers for connected iPhone.` 与 `MissingAppleTeamId` 异常 | 本平台**不接管**真机的安装与配对（§3.1：`local-device` 的「平台可安装 App＝否」），⇒ **该 runner 由用户自行预装，平台不安装** |
| runner 装到真机走 `xcrun devicectl device install app` 与 `devicectl device process launch` | `util/LocalIOSDeviceController` 的字节码（`xcrun` / `devicectl` / `device` / `install` / `app` / `process` / `launch` 字符串序列） | 同上：**平台不接管安装** |
| 宿主到设备的 `127.0.0.1:22087` 必须可达 | `driver/ios/maestro-driver-iosUITests/Routes/XCTestHTTPServer.swift` 里 `HTTPServer(address: .inet(ip4: "127.0.0.1", port: port ?? 22087))`——**这是设备侧的监听端**；jar 里**没有** `iproxy` / `usbmux` 一类的端口转发实现 | **未验证**：真机上这条连接如何打通，在本机无从观察。这是真机路径上**最不确定的一环** |

> 这三条前提合起来说明：**「照抄 XCUITest driver 的做法」不是一条现成的路**，
> 它要求用户自备签名、预装 runner，并自行解决宿主到设备的端口可达性。
> §3.1 的 `local-device` 契约（「平台不接管安装与配对」）与「平台自己装一个 runner」
> 是**冲突**的——本平台选前者，因此**真机路径的 App 安装/启动能力由用户侧承担**。

**七项 capability 在 iOS 上的可满足性**（以 Maestro 2.12.1 为参照）：

「可满足」这一列说的是 **Maestro 宿主侧的实现状态**。
真机那一列写「宿主侧可满足」的是**条件句**——它只说明宿主侧的代码在，
**不等于**「真机上满足得了」：真机还差上面那张表的**三条硬前提**
（Apple team ID 签名、runner 经 devicectl 装到设备、宿主到设备的
`127.0.0.1:22087` 可达），这三条**在本机一条都没有验证过**。
写「不可满足」的则是**确定**的：那个操作在真机侧**根本没有实现**。

| capability | Maestro：iOS 模拟器 | Maestro：iOS 真机 | 依据 |
|---|---|---|---|
| `app.install` | 可满足 | 不可满足 | 真机 `install` 未实现 |
| `app.launch` | 可满足 | 不可满足 | 真机 `launch` 未实现 |
| `ui.tap` | 可满足 | **宿主侧可满足（前提未验证）** | 走 XCTest 驱动，宿主侧同源 |
| `ui.hierarchy` | 可满足 | **宿主侧可满足（前提未验证）** | 走 XCTest 驱动，宿主侧同源 |
| `screen.capture` | 可满足 | **宿主侧可满足（前提未验证）** | 走 XCTest 驱动，宿主侧同源 |
| `screen.record` | 可满足 | 不可满足 | 真机 `startScreenRecording` 未实现 |
| `log.read` | 可满足 | **不可满足** | 日志流走 `simctl`，真机侧无对应实现 |

**能力协商的落点（条件句，不是现时事实）**：
若将来定义了某个**不声明上述「不可满足」能力的 iOS 会话画像**，
ATS-601 的 `negotiateMobileCapabilities` 就会产出对应的能力缺口，
执行前被拒绝（`REMOTE_CAPABILITY_MISSING`），而不是在执行中炸出驱动错误。
**仓库内目前没有任何 iOS 会话画像**（`server/` 下搜不到任何 iOS 目标或会话），
所以这条路径**现在还不会被触发**。

**另外两条 iOS 侧的硬事实**（与命令无关，但决定了 §8.5 的判定）：

| 事实 | 证据 | 影响 |
|---|---|---|
| `back` 在 iOS 上是**空操作** | `IOSDriver.backPress` 的字节码体只有一条 `return` | iOS 没有返回键；`back` 在 Maestro 官方文档里也写明只支持 Android 与 Web |
| 飞行模式在 iOS 上**不生效** | `IOSDriver.setAirplaneMode` / `isAirplaneModeEnabled` 只打一条 `Airplane mode is not available on iOS simulators` 的 warn 就返回 | `setAirplaneMode` / `toggleAirplaneMode` 即使实现了也不构成 iOS 能力 |

### 8.5 Maestro Flow 语法兼容性判定表

Maestro CLI 2.12.1 实际接受 **55 条命令**（由 `maestro check-syntax` 行为确认，
见 `tools/ats606-probes/probe-maestro-compat.mjs`）。
下表按判定分组，**每条命令都在表里**，每行都带**导入器对 Maestro 原拼写的实际处理**
——那一列是**实测**的（逐条跑 `parseFlow` + `importFlow` + `buildImportReport`），
不是推的。

判定口径见 §8.3：**语义侧**分可映射 / 部分可映射 / 不映射，
**导入侧**分映射成功 / 进导入报告。两列并排，读者不必自己推断。
**分组只看语义与命令形态**——拼写、参数保真、等待语义各有各的列。

**Maestro 的参数清单**由 `maestro-orchestra.jar` 的 `Yaml*` 类的字段读出
（`javap -p`），**本平台的参数清单**读自 ATS-602 的 `STEP_ARGUMENTS`；
「参数保真」一列是两侧的差集**加上实测的导入器行为**（见 §8.2）。

**下表整块由 `tools/ats606-probes/gen-section-rows.mjs` 生成**，
放在 `<!-- ATS606-ROWS-START -->` / `<!-- ATS606-ROWS-END -->` 之间；
复核脚本把**整块**（三个组标题 + 55 行 + TALLY）与生成器输出**逐字比对**，
所以**把某一行挪到别的组、并同步改掉全部计数**，探针必然变红
（`--self-test` 里就有这条负控）。此外探针还独立检查**分组不变量**：
可映射 / 部分可映射的行必须指向 ATS-601 冻结的步骤种类，不映射的行必须不指向任何种类。

<!-- ATS606-ROWS-START -->
#### 8.5.1 可映射（6 条）

| Maestro 命令 | 本平台对应步骤种类 | ATS-602 导入器对 Maestro 原拼写的实际处理 | 参数保真 | 说明 |
|---|---|---|---|---|
| `assertNotVisible` | `assertVisible` + `notVisible` 限定词 | 进导入报告：`unknown-command` | Maestro 的参数共 25 个（其中模型外 22 个）——**实测**：Maestro 的拼写 `assertNotVisible` 不在 ATS-602 的语义拼写表里，导入器在读参数**之前**就判 `unknown-command`（0 条告警），⇒ 本平台的参数保真**对本命令不适用** | 语义：断言元素**不可见**——本平台**能表达**这个语义，命令形态也与 Maestro 一致（都是一步断言）：线性语法 `assert notVisible "X"` 实测映射为 `assertVisible{notVisible}`，YAML 用 `assert:` 块；Runner 按限定词区分两种断言（`visible` 失败于元素缺失，`notVisible` 失败于元素存在，见 `android-runner.mjs` 的 `assertVisible`）。**拼写不被接受属于导入侧**：Maestro 的拼写 `assertNotVisible` 不在 ATS-602 的语义拼写表里，导入时按 `unknown-command` 进导入报告——这不改变分组。**等待语义不完全等价**（`notVisible` 在本平台的等待上限是 `min(5000, 2000)` ms，Maestro 是 7 秒 fluent 重试）。 |
| `assertVisible` | `assertVisible` | 映射成功 → `assertVisible` | 在模型内：`text` / `id` / `index`；模型外 22 个（相对定位 / 状态过滤 / 尺寸容差等）——**实测**（模型外参数逐个实跑导入器）：与模型内目标同时给出时 22/22 条保留原文并告警、整步仍映射；只给模型外参数时 22/22 条整步判 `missing-argument`。**逐个**：只给这些时整步判 `missing-argument`：`width` / `height` / `tolerance` / `retryTapIfNoChange` / `waitUntilVisible` / `point` / `below` / `above` / `leftOf` / `rightOf` / `containsChild` / `containsDescendants` / `traits` / `enabled` / `selected` / `checked` / `focused` / `repeat` / `delay` / `waitToSettleTimeoutMs` / `childOf` / `css`。**模型内但不是目标**的 1 个参数（`index`）：只给 `index` 时整步判 `missing-argument` | 语义：断言元素可见——本平台的断言形如 `{visible: <目标>}`，命令形态与 Maestro 的 `assertVisible` 一致（一步对一步，同一个动作）。**等待语义不完全等价**，但等待不决定分组：Maestro 的 fluent 断言固定重试 7 秒，本平台 Runner 的默认等待是 `DEFAULT_WAIT.timeoutMs = 5000`（ATS-603 的 `server/adapters/android-runner.mjs`，可由 Runner 选项覆盖）。差异记在本列与「参数保真」列。 |
| `extendedWaitUntil` | `assertVisible` | 进导入报告：`unknown-command` | Maestro 的参数共 3 个（其中模型外 3 个）——**实测**：Maestro 的拼写 `extendedWaitUntil` 不在 ATS-602 的语义拼写表里，导入器在读参数**之前**就判 `unknown-command`（0 条告警），⇒ 本平台的参数保真**对本命令不适用** | 语义：等待元素**可见**或**不可见**。Maestro 的这条命令与 `assertVisible` / `assertNotVisible` **编译成同一个命令类**（`AssertConditionCommand`）——字节码里 `YamlFluentCommand.extendedWait` 构造的是 `AssertConditionCommand(Condition(visible | notVisible), timeout, label, optional)`，**只多一个可配的 timeout**。⇒ 本平台用 `assertVisible`（加 `visible` / `notVisible` 限定词）表达同一步，**命令形态一致（一步对一步）**；`timeout` 记在「参数保真」与本列（Maestro 的 7 秒 fluent 重试 vs 本平台 Runner 默认 5000 ms），**等待长短不改变这一步是什么，不参与分组**。Maestro 的拼写不在 ATS-602 的语义拼写表里，导入时按 `unknown-command` 进导入报告——这属于导入侧，不改变分组。 |
| `launchApp` | `launchApp` | 映射成功 → `launchApp` | 在模型内：`appId` / `clearState` / `permissions` / `arguments`；模型外：`clearKeychain` / `stopApp`——**实测**（模型外参数逐个实跑导入器）：与模型内目标同时给出时 2/2 条保留原文并告警、整步仍映射；只给模型外参数时 0/2 条整步判 `missing-argument`，其余 2/2 条仍映射（`launchApp` 的 `appId` 由 Flow 头继承）。**逐个**：只给这些时仍映射：`clearKeychain` / `stopApp`。**模型内但不是目标**的 3 个参数（`clearState` / `permissions` / `arguments`）：只给 `clearState` / `permissions` / `arguments` 时仍映射 | 语义：启动被测 App——命令形态与 Maestro 的 `launchApp` 一致（一步启动一个 App）。本平台的 `launchApp` 以 `appId` 为主参数（别名 `app`/`package`/`packageName`/`bundleId`），Flow 头部声明了 `appId` 时步骤可继承。Maestro 的 `launchApp` 还会按参数附带清 keychain / 清状态 / 设权限（`Orchestra.launchAppCommand` 的字节码里依次调用 `clearKeychain`→`clearAppState`→`setPermissions`→`launchApp`），**这三样本平台都没有对应步骤**——这是保真度差异，记在「参数保真」列与本列，不改变分组。 |
| `takeScreenshot` | `takeScreenshot` | 映射成功 → `takeScreenshot` | 在模型内：`path`；模型外：`cropOn`——**实测**（模型外参数逐个实跑导入器）：与模型内目标同时给出时 1/1 条保留原文并告警、整步仍映射；只给模型外参数时 0/1 条整步判 `missing-argument`，其余 1/1 条仍映射（该步骤种类没有必填目标）。**逐个**：只给这些时仍映射：`cropOn`。**模型内但不是目标**的 1 个参数（`path`）：只给 `path` 时仍映射 | 语义：截屏——命令形态与 Maestro 的 `takeScreenshot` 一致（一步截一张）。本平台的落盘路径走 ATS-209 的证据路径校验与 SHA-256。Maestro 还能 `cropOn` 裁剪，本平台没有这个参数——保真度差异，不改变分组。 |
| `tapOn` | `tapOn` | 映射成功 → `tapOn` | 在模型内：`text` / `id` / `retryTapIfNoChange` / `point` / `index` / `waitToSettleTimeoutMs`；模型外 19 个（相对定位 / 状态过滤 / 尺寸容差等）——**实测**（模型外参数逐个实跑导入器）：与模型内目标同时给出时 19/19 条保留原文并告警、整步仍映射；只给模型外参数时 19/19 条整步判 `missing-argument`。**逐个**：只给这些时整步判 `missing-argument`：`width` / `height` / `tolerance` / `waitUntilVisible` / `below` / `above` / `leftOf` / `rightOf` / `containsChild` / `containsDescendants` / `traits` / `enabled` / `selected` / `checked` / `focused` / `repeat` / `delay` / `childOf` / `css`。**模型内但不是目标**的 4 个参数（`retryTapIfNoChange` / `point` / `index` / `waitToSettleTimeoutMs`）：只给 `retryTapIfNoChange` / `point` / `index` / `waitToSettleTimeoutMs` 时整步判 `missing-argument` | 语义：点按元素——命令形态与 Maestro 的 `tapOn` 一致（一步点一个元素）。本平台的目标是**文本**或**资源 id`，**两者任一即可**（只有**两者皆缺**才判 `missing-argument`——只给 `id` 就能映射）；并按 ATS-601 要求 `ui.tap` + `ui.hierarchy` 同时满足。Maestro 的元素选择器远比这丰富（相对定位、状态过滤、尺寸容差等），本平台只认少数几个参数——保真度差异，记在「参数保真」列，不改变分组。 |

#### 8.5.2 部分可映射（2 条）

| Maestro 命令 | 本平台对应步骤种类 | ATS-602 导入器对 Maestro 原拼写的实际处理 | 参数保真 | 说明 |
|---|---|---|---|---|
| `startRecording` | `recordScreen` | 进导入报告：`unknown-command` | Maestro 的参数共 1 个（其中模型外 0 个）——**实测**：Maestro 的拼写 `startRecording` 不在 ATS-602 的语义拼写表里，导入器在读参数**之前**就判 `unknown-command`（0 条告警），⇒ 本平台的参数保真**对本命令不适用** | 语义：开始录屏。**命令形态不同**：本平台的 `recordScreen` 是**一步**（录一段），Maestro 是「开始/停止」**配对**命令⇒**配对语义在单步模型里无处安放**——**动作（录屏）本平台能表达，表达不出来的是「开始/结束」这对边界**，所以判「部分可映射」。Maestro 的拼写也不在 ATS-602 的拼写表里，导入时按 `unknown-command` 进导入报告（导入侧）。 |
| `stopRecording` | `recordScreen` | 进导入报告：`unknown-command` | Maestro 的参数共 0 个（其中模型外 0 个）——**实测**：Maestro 的拼写 `stopRecording` 不在 ATS-602 的语义拼写表里，导入器在读参数**之前**就判 `unknown-command`（0 条告警），⇒ 本平台的参数保真**对本命令不适用** | 语义：结束录屏。与 `startRecording` 同一条判定——**命令形态不同**（配对 vs 单步）：动作本平台能表达，表达不出来的是「开始/结束」这对边界；拼写也不被导入器接受（导入侧）。 |

#### 8.5.3 不映射（47 条）

| Maestro 命令 | 本平台对应步骤种类 | ATS-602 导入器对 Maestro 原拼写的实际处理 | 参数保真 | 说明 |
|---|---|---|---|---|
| `addMedia` | — | 进导入报告：`unknown-command` | — | 本平台**没有对应的步骤**，也没有对应的 capability |
| `assertDarkMode` | — | 进导入报告：`unknown-command` | — | 本平台**没有对应的步骤**，也没有对应的 capability |
| `assertLightMode` | — | 进导入报告：`unknown-command` | — | 本平台**没有对应的步骤**，也没有对应的 capability |
| `assertNoDefectsWithAI` | — | 进导入报告：`unknown-command` | — | **实验性** AI 命令：Maestro 自己标注 experimental；本平台不承诺 AI 断言能力（AI 能力属 ATS-401/ATS-403 的契约层，未做端到端实测） |
| `assertScreenshot` | — | 进导入报告：`unknown-command` | — | 本平台**没有视觉比对**（只有取证 `takeScreenshot`） |
| `assertTrue` | — | 进导入报告：`unknown-command` | — | 本平台的断言只有 `visible` / `notVisible` 两种限定词，**没有任意表达式断言** |
| `assertWithAI` | — | 进导入报告：`unknown-command` | — | **实验性** AI 命令：Maestro 自己标注 experimental；本平台不承诺 AI 断言能力（AI 能力属 ATS-401/ATS-403 的契约层，未做端到端实测） |
| `back` | — | 进导入报告：`unknown-command` | — | 本平台**没有键盘处理与按键步骤**；另：`back` 在 iOS 上是**空操作**（`IOSDriver.backPress` 的字节码体只有一条 `return`） |
| `clearKeychain` | — | 进导入报告：`unknown-command` | — | 本平台没有该步骤；`clearKeychain` 是 **iOS 专属**命令⇒ iOS 用例**无法保证从干净状态起跑**（登录态跨用例泄漏） |
| `clearState` | — | 进导入报告：`unknown-command` | — | 本平台**没有「重置 App 状态」这一步**。Maestro 的 `clearState` **不启动 App**（`Orchestra.clearStateCommand` 的字节码里只调 `clearAppState` 与 `setPermissions`，没有 `launchApp`）⇒ 它与 `launchApp` 没有「可映射的那一半」。`launchApp` 虽有模型内的 `clearState` 参数，但**当前 Runner 不执行它**（`android-runner.mjs` 的 `launchApp` 只读 `appId`） |
| `copyTextFrom` | — | 进导入报告：`unknown-command` | — | 本平台六类步骤里**没有剪贴板操作** |
| `doubleTapOn` | — | 进导入报告：`unknown-command` | — | 本平台**没有手势步骤** |
| `eraseText` | — | 进导入报告：`unknown-command` | — | 本平台六类步骤里**没有文本输入** |
| `evalScript` | — | 进导入报告：`unknown-command` | — | 本平台**不执行 Flow 里的任意代码**（解析器只读文本），用例也是**扁平列表**（无子流程、无重复/重试结构） |
| `extractTextWithAI` | — | 进导入报告：`unknown-command` | — | **实验性** AI 命令：Maestro 自己标注 experimental；本平台不承诺 AI 断言能力（AI 能力属 ATS-401/ATS-403 的契约层，未做端到端实测） |
| `hideKeyboard` | — | 进导入报告：`unknown-command` | — | 本平台**没有键盘处理与按键步骤** |
| `inputText` | — | 进导入报告：`unknown-command` | — | 本平台六类步骤里**没有文本输入** |
| `inputRandomCityName` | — | 进导入报告：`unknown-command` | — | 本平台六类步骤里**没有文本输入** |
| `inputRandomColorName` | — | 进导入报告：`unknown-command` | — | 本平台六类步骤里**没有文本输入** |
| `inputRandomCountryName` | — | 进导入报告：`unknown-command` | — | 本平台六类步骤里**没有文本输入** |
| `inputRandomEmail` | — | 进导入报告：`unknown-command` | — | 本平台六类步骤里**没有文本输入** |
| `inputRandomNumber` | — | 进导入报告：`unknown-command` | — | 本平台六类步骤里**没有文本输入** |
| `inputRandomPersonName` | — | 进导入报告：`unknown-command` | — | 本平台六类步骤里**没有文本输入** |
| `inputRandomText` | — | 进导入报告：`unknown-command` | — | 本平台六类步骤里**没有文本输入** |
| `killApp` | — | 进导入报告：`unknown-command` | — | 本平台**没有「强杀 App」这一步**。Maestro 的 `killApp` **不启动 App**（`Orchestra.killAppCommand` 只调 `killApp`）⇒ 与 `launchApp` 没有「可映射的那一半」 |
| `longPressOn` | — | 进导入报告：`unknown-command` | — | 本平台**没有手势步骤** |
| `openLink` | — | 进导入报告：`unknown-command` | — | 本平台**没有对应的步骤**，也没有对应的 capability |
| `pasteText` | — | 进导入报告：`unknown-command` | — | 本平台六类步骤里**没有剪贴板操作** |
| `pressKey` | — | 进导入报告：`unknown-command` | — | 本平台**没有键盘处理与按键步骤** |
| `repeat` | — | 进导入报告：`unknown-command` | — | 本平台**不执行 Flow 里的任意代码**（解析器只读文本），用例也是**扁平列表**（无子流程、无重复/重试结构） |
| `retry` | — | 进导入报告：`unknown-command` | — | 本平台**不执行 Flow 里的任意代码**（解析器只读文本），用例也是**扁平列表**（无子流程、无重复/重试结构） |
| `runFlow` | — | 进导入报告：`unknown-command` | — | 本平台**不执行 Flow 里的任意代码**（解析器只读文本），用例也是**扁平列表**（无子流程、无重复/重试结构） |
| `runScript` | — | 进导入报告：`unknown-command` | — | 本平台**不执行 Flow 里的任意代码**（解析器只读文本），用例也是**扁平列表**（无子流程、无重复/重试结构） |
| `scroll` | — | 进导入报告：`unknown-command` | — | 本平台**没有手势步骤** |
| `scrollUntilVisible` | — | 进导入报告：`unknown-command` | — | 本平台**没有手势步骤** |
| `setAirplaneMode` | — | 进导入报告：`unknown-command` | — | 本平台**没有对应的步骤**；且**飞行模式在 iOS 上不生效**（驱动只打一条 warn） |
| `setClipboard` | — | 进导入报告：`unknown-command` | — | 本平台六类步骤里**没有剪贴板操作** |
| `setDarkMode` | — | 进导入报告：`unknown-command` | — | 本平台**没有对应的步骤**，也没有对应的 capability |
| `setLocation` | — | 进导入报告：`unknown-command` | — | 本平台**没有对应的步骤**，也没有对应的 capability |
| `setOrientation` | — | 进导入报告：`unknown-command` | — | 本平台**没有对应的步骤**，也没有对应的 capability |
| `setPermissions` | — | 进导入报告：`unknown-command` | — | 本平台**没有对应的步骤**，也没有对应的 capability |
| `stopApp` | — | 进导入报告：`unknown-command` | — | 本平台**没有「停止 App」这一步**。Maestro 的 `stopApp` **不启动 App**（`Orchestra.stopAppCommand` 只调 `stopApp`）⇒ 与 `launchApp` 没有「可映射的那一半」 |
| `swipe` | — | 进导入报告：`unknown-command` | — | 本平台**没有手势步骤** |
| `toggleAirplaneMode` | — | 进导入报告：`unknown-command` | — | 本平台**没有对应的步骤**；且**飞行模式在 iOS 上不生效**（驱动只打一条 warn） |
| `toggleDarkMode` | — | 进导入报告：`unknown-command` | — | 本平台**没有对应的步骤**，也没有对应的 capability |
| `travel` | — | 进导入报告：`unknown-command` | — | 本平台**没有对应的步骤**，也没有对应的 capability |
| `waitForAnimationToEnd` | — | 进导入报告：`unknown-command` | — | 本平台**没有等待步骤** |

<!-- TALLY mappable=6 partial=2 unmappable=47 total=55 imported=4 reported=51 -->
<!-- ATS606-ROWS-END -->

#### 8.5.4 统计与「两个数字为什么不一样」

**语义侧**（本平台的用例模型能不能表达这个动作）：
**可映射 6 条 / 部分可映射 2 条 / 不映射 47 条**。
**导入侧**（ATS-602 拿到 Maestro 的**原拼写**会做什么）：
**映射成功 4 条 / 进导入报告 51 条**。

两个数字差在**三条**上——它们语义可表达、命令形态也对得上，但拼写不被接受：

| 命令 | 语义侧 | 导入侧 | 差在哪 |
|---|---|---|---|
| `assertNotVisible` | 可映射 | 进导入报告 | 语义与命令形态都与 `assertVisible` 对称（一步断言，本平台用 `notVisible` 限定词表达），但 Maestro 的拼写 `assertNotVisible` 不在 ATS-602 的语义拼写表里 ⇒ 导入时按 `unknown-command` 进导入报告 |
| `extendedWaitUntil` | 可映射 | 进导入报告 | 与 `assertVisible` / `assertNotVisible` **编译成同一个 orchestra 命令类**（`AssertConditionCommand`），只多一个可配的 `timeout`；语义是「断言可见或不可见」，本平台用 `assertVisible` 加限定词表达，命令形态一致（一步对一步）。但 Maestro 的拼写 `extendedWaitUntil` 不在 ATS-602 的语义拼写表里 ⇒ 按 `unknown-command` 进导入报告 |

**另外两条「部分可映射」命令的拼写同样不被接受**（`startRecording` / `stopRecording`
按 `unknown-command` 进导入报告），但它们与上面两条差在**另一侧**：
它们的**命令形态**就与本平台不同（Maestro 是「开始/停止」配对命令，本平台是单步
`recordScreen`）——**动作（录屏）本平台能表达，表达不出来的是「开始/结束」这对
边界**，不是动作本身。
**两类差异不要混为一谈**——分组看的是**语义与命令形态**，
「导入器实际处理」一列看的是**拼写**。

**「不映射」的后果是被设计过的**：ATS-602 的映射器**保留原文 + 标记不支持 + 进导入报告**，
绝不静默丢弃。所以一份用 Maestro 全量语法写的 Flow 导入本平台时，
**51 条命令会逐条出现在导入报告里**（带原文、行号、判定原因），
而不是变成一个「导入成功」的假象。**这正是 ATS-602 存在的意义。**

#### 8.5.5 关于「兼容」的结论（FR-035 的直接答案）

**结论：不兼容，且是设计选择，不是缺陷。**

本平台**不实现 Maestro Flow 语法的兼容层**（docs/25 §1.2 已定）。
ATS-602 的两种自带语法是**平台自己的读法**，不是对任何第三方工具的语法承诺。
所以 FR-035 要的「逐条判定并给出结论」，结论是：

| 判定 | 含义（**只有这一套口径**，见 §8.3） | 条数 |
|---|---|---|
| 可映射 | 语义落在 ATS-601 的六类步骤里，**且命令形态与本平台一致**（一步对一步） | 6 |
| 部分可映射 | 语义能被本平台表达，但**命令形态不同**（Maestro 的配对命令 vs 本平台的单步） | 2 |
| 不映射 | 本平台的步骤词表里没有该语义 | 47 |

**分组不看拼写、不看参数保真、不看等待语义**——那三件事各有自己的列：
拼写在「导入器实际处理」列，参数保真在「参数保真」列，等待语义写在「说明」列。

**一句话**：**55 条 Maestro 命令里，本平台的用例模型能表达 8 条的动作
（可映射 6 + 部分可映射 2），而导入器能直接接受的只有 4 条的原拼写；
其余 51 条会带原文进导入报告。**

### 8.6 不承诺清单

以下内容**本平台不承诺**，需人工完成或另立任务：

| # | 不承诺的内容 | 原因 | 影响的 iOS 场景 |
|---|---|---|---|
| 1 | **iOS 上的任何执行** | §2.2 已把「iOS 真实执行」列为本阶段 OUT；仓库内**没有** iOS Runner（`server/` 下无任何 iOS 实现）。§8.4 写的是**以 Maestro 2.12.1 为参照的可行性**，不是本平台的能力 | iOS 用例目前**只能手工执行** |
| 2 | **iOS 真机上的 App 启动与录屏** | 即使按 Maestro 的参照：真机路径（`DeviceControlIOSDevice`）的 `launch` / `install` / `clearAppState` / `startScreenRecording` / `addMedia` / `clearKeychain` / `openLink` / `setLocation` 均未实现（其余 `tap` / `viewHierarchy` / `takeScreenshot` 等走 XCTest 驱动） | 真机上的「启动 App → 跑场景 → 留证据」这条链**在真机上断在第一步** |
| 3 | **iOS 真机 runner 的安装与签名** | 需 Apple team ID 自行构建 `driver-iphoneos`；且 §3.1 规定平台**不接管**真机安装与配对 | 真机路径的可用性**依赖用户自备** |
| 4 | **文本输入** | 六类步骤里没有输入步骤 | 登录、表单填写、搜索——**最常见的用例形态** |
| 5 | **滚动/滑动/双击/长按等手势** | 没有手势步骤 | 长列表、下拉刷新、抽屉导航 |
| 6 | **键盘处理** | 没有 `hideKeyboard` | 软键盘遮挡提交按钮等场景 |
| 7 | **断言「不可见」的等待语义** | 模型里只有 `visible` / `notVisible`，没有 Maestro 的 7 秒 fluent 重试与 `extendedWaitUntil`；本平台 Runner 的默认等待是 5000 ms | 依赖等待的断言在弱网/慢设备上易 flaky |
| 8 | **iOS Keychain 清理与 App 状态重置** | 没有 `clearKeychain` / `clearState` 步骤 | iOS 用例的**干净起跑**无法保证——登录态会跨用例泄漏 |
| 9 | **权限弹窗处理** | 没有 `setPermissions` 步骤；`launchApp` 虽有模型内的 `permissions` 参数，但**当前 Runner 不执行它** | 首次安装后的位置/相机/通知授权弹窗 |
| 10 | **App 停止/强杀** | 没有 `stopApp` / `killApp` 步骤 | 一轮结束后无法显式收尾，依赖进程自然退出 |
| 11 | **视觉回归判定** | 只有取证（`takeScreenshot`），没有比对 | 视觉走查仍需人工 |
| 12 | **执行 Flow 中的 JavaScript** | 安全红线：平台的 Flow 解析器只读文本、不执行内容 | `evalScript` / `runScript` / `assertTrue` 表达的逻辑需改写为平台步骤或移到用例外 |
| 13 | **深链/URL 打开、系统按键、方向与深浅色、地理位置、相册注入** | 无对应步骤 | 多 App 跳转、深链入口、外设场景 |
| 14 | **子流程与流程复用** | 用例是扁平列表，无 `runFlow` | 登录前置等公共步骤只能复制 |
| 15 | **AI 断言** | Maestro 侧为实验特性；本平台 AI 能力只有契约层，未端到端实测 | 复杂视觉状态的自动判定 |

**总口径**：**本平台在 iOS 上当前不承诺任何执行能力**（§2.2 OUT）。
§8.4 给的是**以 Maestro 2.12.1 为参照的可行性边界**，
供将来定义 iOS 会话画像与 Runner 时取用；
§8.5 给的是**语法兼容性的逐条判定**（结论：不兼容，是设计选择）。
任何「已支持 / 已验证」的说法在这里都不成立。

### 8.7 复核方法（可机读）

| 要复核的结论 | 复核命令 | 期望 |
|---|---|---|
| Maestro 命令清单（55 条）与 §8.5 的判定一一对应 | `node tools/ats606-probes/probe-maestro-compat.mjs` | `MAESTRO COMMAND INVENTORY: OK (55 commands)` |
| §8.5 每条命令都有判定，且计数与文中一致 | 同上 | `COMPATIBILITY TABLE: OK` |
| §8.5 的**整块**（三个组标题 + 55 行 + TALLY）与生成器输出**逐字一致**（没有手改，也没有把某一行挪到别的组） | 同上（探针内部跑 `gen-section-rows.mjs` 并逐字比对 `<!-- ATS606-ROWS-START -->`…`END` 之间的整块） | `the §8.5 block is exactly the generated block (71 lines ...)` |
| §8.5 的「导入器实际处理」一列与导入器的真实行为一致 | 同上（逐条跑 `parseFlow` + `importFlow` + `buildImportReport`） | `every row states the importer behaviour the importer actually has` |
| §8.5 的「参数保真」一列与 `STEP_ARGUMENTS` 一致 | 同上（读 `server/discovery/mobile-import.mjs`） | `every parameter cell matches STEP_ARGUMENTS` |
| §8.5 的**分组不变量**：可映射 / 部分可映射的行必须指向 ATS-601 冻结的步骤种类，不映射的行必须不指向任何种类 | 同上（读 `server/adapters/mobile-target.mjs`） | `the grouping breaks no §8.3 invariant: ...` |
| §8.5 的**每一行的分组与步骤种类，由 Maestro 的字节码重新推导**并与文档一致 | 同上（读 `maestro-orchestra.jar` 的 `YamlFluentCommand`，把每条命令编译成的 orchestra 命令类与变体解出来，再经 `ACTION_PLATFORM` 推出判定） | `every row's group and step kind are re-derived from the byte-code and agree with the document (55 rows)` |
| **动作模型本身**（每条 Maestro 命令编译成什么、变体是什么） | `node tools/ats606-probes/maestro-action-model.mjs` | 每行一条「命令 → orchestra 命令类 [变体]」；缺 Maestro 时**跳过并写明原因**，不写 PASS |
| **反向对照**（负控）：**把某一行挪到别的组、并同步改掉全部计数**（组标题、TALLY、文中计数全部自洽），探针必须变红；改错导入处理也必须变红；未改动的文档必须仍然通过 | 同上（`--self-test`） | `SELF-TEST: OK`（负控被成功捕获，且 control 仍然通过） |
| **分组负控**（交付的负控台架）：把行挪到别的组并改掉全部计数（M1–M8，含把 `extendedWaitUntil` 挪进「不映射」），逐条跑交付的探针，**每一条都必须变红**，control 必须仍然通过 | `node tools/ats606-probes/probe-group-mutants.mjs <tree>` | `GROUP MUTANTS: OK (every group mutation was caught, and the control still passes)` |
| iOS 两条路径的实现状态（§8.4 的事实基础，**含 `readLogs` 行**） | `node tools/ats606-probes/probe-ios-driver-support.mjs` | `IOS DRIVER SUPPORT: OK`（需要本机 `D:/AI-Tools/Maestro`；缺 Maestro 时**跳过并写明原因**，不写 PASS） |
| §8.4 的**七项 capability 表** | 同上 | `§8.4 <capability>: simulator=... device=... match the byte-code`（七项逐条） |
| 真机路径的三条硬前提已在 §8.4 写明 | 同上 | `§8.4 states the ...`（三条逐条） |
| §8.4 对两个**设备侧 runner 构建**的 jar 出处正确 | 同上（逐个 jar 列表核对 `driver-iPhoneSimulator/` 与 `driver-iphoneos/` 属于哪个 jar，并确认没有 jar 含 `driver-ios/`） | `§8.4 attributes the two device-side builds to maestro-ios-driver.jar ...` |
| 证据日志 | `bash tools/ats606-probes/collect-evidence.sh <tree>` | `docs/evidence/ATS-606/` |

## 9. 安全与信任边界

移动端执行引入了新的攻击面，**必须在设计里先堵住**：

| 边界 | 规则 |
|---|---|
| App 包名 | 不允许来自用户输入的任意包名直接启动；只允许项目登记过的 |
| Flow 文件 | 与其它脚本同一套可信仓库判定（ATS-113）；未可信项目不得执行 |
| 设备选择 | 只允许用户显式登记的会话；不允许平台自行连任意设备 |
| 证据落盘 | 与其它证据同一套路径校验与 SHA-256（FR-015 / ATS-209） |
| 录屏 | 可能含敏感信息，保留策略与脱敏要求与截图一致（ATS-402 的外传授权适用于录屏） |
| 远端目标 | 租户隔离与租约语义复用 ATS-502；跨租户读取一律 404 |

---

## 10. WBS 与验证方式

| WBS | 任务 | 依赖 | 验证方式 | 交付形态 |
|---|---|---|---|---|
| ATS-601 | 移动端执行目标抽象与设备/模拟器会话模型 | - | 审查 + UT | 契约层设计 + 契约测试 |
| ATS-602 | 跨引擎用例模型与移动端 Flow 导入映射 | ATS-601 | UT + IT | 映射器 + 导入报告（**已交付**） |
| ATS-603 | Android 模拟器 Runner 原型与真实设备冒烟 | ATS-602 | UT + IT | **真实模拟器实测**（**已交付**：UT 30 例 + 真实模拟器 IT 9 例） |
| ATS-604 | 移动端证据归档与统一结果模型 | ATS-603 | UT + IT | 证据适配层 |
| ATS-605 | 移动端能力矩阵与环境依赖声明 | ATS-603 | 审查 | 矩阵 + 未验证声明 |
| ATS-606 | iOS 真机路径与 Maestro 兼容性边界 | ATS-602 | 审查 | **设计与边界冻结**（无实测；三张表 + 可机读复核的复核脚本；§8.5 的表由脚本生成，复核脚本逐格比对并带负控自检） |

**顺序不可跳过**：ATS-603 是关键阻断；ATS-606 不依赖 Android 成功，可与 ATS-603 并行。

---

## 11. 未验证项与已知边界

本设计文档自身的事实状态：

- **已验证（ATS-601 的契约层）**：§3 的目标/会话模型、状态机迁移、能力协商与拒绝规则、
  安全边界，已由 `server/adapters/mobile-target.mjs` 与 `server/adapters/mobile.mjs` 实现，
  并经 UT-MOB-001..094 共 99 例实测通过（证据 `docs/evidence/ATS-601/`）。
  **这是假目标 + 假会话上的契约测试**，验证的是「规则按设计工作」，**不是**真实设备行为。
- **已验证（ATS-602 的用例模型与导入映射层）**：§4 的 Flow 解析、语义映射、
  不支持步骤的保留与标记、导入报告、UID 规则（位置为基线、改标题经注册表认回）
  已由 `server/discovery/mobile-flow.mjs`、`server/discovery/mobile-import.mjs`、
  `server/discovery/mobile-flow-import.mjs` 实现，并经 UT-MOB-200..318 共 87 例 +
  IT-ATS602-API-001..015 共 15 例实测（证据 `docs/evidence/ATS-602/`）。
  **这是文本夹具上的映射测试**，验证的是「映射按设计工作」，**不是**设备行为。
- **已验证（ATS-603 的 Android Runner）**：§5 的执行路径、四类步骤的实测、失败分类
  已由 `server/adapters/android-adb.mjs`、`android-hierarchy.mjs`、`android-runner.mjs`、
  `android-adapter.mjs` 实现，并经 UT 共 43 例 +
  IT-ATS603-001..022 共 9 例在**真实 Android 模拟器**（Android 15 / API 35）上实测 +
  IT-ATS603-030..031 共 2 例经**真实 Bridge**实测
  （证据 `docs/evidence/ATS-603/`）。
  **这是模拟器上的实测**：它证明 Runner 的语义与失败分类按设计工作，
  **不等于**真机上的行为（真机未连接），**也不等于**证据归档已完成（属 ATS-604）。
- **未验证（§6~§7）**：证据归档与跨引擎统一查询（ATS-604）、能力矩阵与环境声明
  （ATS-605）**仍未在本仓库实测**。
  仓库内**没有**移动端证据清单、**没有**录屏归档。
- **已冻结（ATS-606 的 iOS/Maestro 边界）**：§8 的三张表——iOS 支持范围表、
  Maestro 命令逐条兼容性判定表、不承诺清单——已逐条填完并给出理由，
  判定所依据的事实都有可机读复核的来源：
  Maestro CLI 2.12.1 的命令清单（由 `maestro check-syntax` 的**行为**确认，
  含两个负控证明该检查能区分真命令与拼写错误）、每条命令的**参数清单**
  （由 `maestro-orchestra.jar` 的 `Yaml*` 类的字节码读出）、其 iOS 驱动的**字节码**
  （模拟器路径与真机路径的实现状态不同），以及本平台 ATS-601/ATS-602 的词表。
  §8.5 的「导入器实际处理」一列与三个计数由**逐条实跑导入器**得出，
  表由 `tools/ats606-probes/gen-section-rows.mjs` 生成，
  复核脚本 `tools/ats606-probes/probe-maestro-compat.mjs` 会逐格比对
  （并带一个**故意改错表**的负控自检）。
  证据 `docs/evidence/ATS-606/`。
  **但这仍然是「边界冻结」，不是实测**：本机无 macOS/Xcode/模拟器/真机，
  **没有任何一条 iOS 行为被实测过**。§8.4 写的是「**以 Maestro 2.12.1 为参照**，
  这条路在 iOS 上走不走得通」，**不是**「本平台已经支持」——
  本平台**没有 iOS Runner**，§2.2 已把「iOS 真实执行」列为本阶段 OUT。
- **未验证（§8 的 iOS 侧）**：iOS 真机路径的三条硬前提
  （Apple team ID 签名构建 `driver-iphoneos`、runner 经 devicectl 装到设备、
  宿主到设备的 `127.0.0.1:22087` 可达）**在本机无从观察**——
  真机上这条连接如何打通，是真机路径上最不确定的一环。
- Maestro 的产品结构与能力来自 2026-11-06 的官方文档调査（`docs/15-REFERENCES-LICENSES.md`
  登记引用）与 2026-11-09 对 Maestro CLI 2.12.1 的实查；调査与实查结论本身
  不是对本平台的实测。
- 本机**有** Android SDK（API 35 镜像）与 AVD（`Pixel_6_API_35`，WHPX 加速可用），
  ATS-603 的真实冒烟已在本机完成；**没有** iOS 环境，**没有** ADB 连接的 Android 真机。
- 已知边界（ATS-603 的 Android Runner 自身）：
  - **模拟器 ≠ 真机**：本项在模拟器上实测，真机（`local-device`）路径未实测，
    平台对真机不接管安装与配对（§3.1 的策略），该路径属 ATS-605 的声明范围。
  - **录屏与设备日志**已实现为驱动能力（`screen.record` / `log.read`），
    但**统一归档**属 ATS-604，本项只落盘与产出记录。
  - **会话与目标仍是内存中的数据**：本项**不引入持久化**，会话的存储与恢复未落地。
  - **探针会点一次屏幕中央**：证明 `ui.tap` 能力的探针在屏幕正中点一次，
    这是一个已声明的取舍（通常那里没有按钮）。
  - **探针与步骤都把层级读取失败当作可重试**：设备繁忙时的偶发 dump 失败会被重试到超时，
    只有始终读不到才归为 `driver-error`（且**不是** `element-not-found`）。
- 已知边界（ATS-601 契约层自身）：
  - 会话的**能力集由调用方提供**——契约校验会话能力**不超过目标声明**，
    并据此计算缺口；但**证明**设备能力的动作（探测层级树、试抓截图）属真实驱动（ATS-603）。
    契约层**不**验证调用方给出的能力集本身是否真实。
  - 目标与会话是**内存中的数据**，本任务**不引入持久化**；会话的存储与恢复随 ATS-603 一并落地。
  - 移动端适配器（`kind=mobile`）当前**没有任何可用能力**，它存在的意义是把「移动端执行」这件事的
    **入口与拒绝路径**定下来，让 ATS-603 有地方可长，而不是一个平行的 Playwright 专用实现。
    ATS-603 的驱动是**另一个 kind**（`kind=android`），两者并列注册、互不覆盖。
- 已知边界（ATS-602 用例模型与导入映射层自身）：
  - **Flow 的解析器是受限子集**：块映射、块序列、标量、行内集合都读；
    **锚点、别名、标签、复杂键不读**，用到它们的 Flow 报错误而不是读一半。
  - **两种自带语法的拼写表是平台自己的读法**，不是对任何第三方工具的兼容性承诺；
    第三方语法的逐条判定属 ATS-606（§8）。
  - **Flow 文件只从约定目录被发现**（`flows/`、`mobile/`、`tests/flows/`、
    `tests/mobile/`）；不在这些目录里的 Flow 不会被发现（可以被显式导入）。
  - **步骤的语义表是封闭的**：映射器在装载时校验自己产出的每个 step kind 都在
    ATS-601 的词表里；越界的编辑会直接报错，而不是产出没有能力要求的步骤。
  - **导入是契约层操作**：它不需要设备、SDK 或驱动，因此 ATS-602 的实测
    **不能**被读成移动端执行的实测。

---

## 12. 依据文档

- `docs/02-REQUIREMENTS.md` FR-031 ~ FR-035、NFR-013
- `docs/18-RUNNER-ADAPTER-CONTRACT.md`（ATS-301 的适配器契约与能力协商）
- `docs/18-UID-SPEC.md`（ATS-201 的稳定 UID 规范）
- `docs/11-SECURITY-RISK.md`（可信仓库、证据路径校验、凭据外传）
- `docs/19-REMOTE-RUNNER-PROTOCOL.md`（ATS-501 的远程信任边界与租约语义）
- `docs/13-ROADMAP.md` §2 的 P1 双引擎阶段
- `docs/15-REFERENCES-LICENSES.md`（Maestro 官方文档引用）

## 13. ATS-602 的交付物

| 文件 | 作用 |
|---|---|
| `server/discovery/mobile-flow.mjs` | Flow 解析器：两种语法的读取器，产出语义文档（场景、步骤、参数、断言、行号、原文） |
| `server/discovery/mobile-import.mjs` | 语义映射器：语义表、参数规范化、不支持步骤的保留与标记、UID 阶梯、导入报告 |
| `server/discovery/mobile-flow-import.mjs` | 文件级入口：约定目录的发现、路径校验、单文件与全项目导入 |
| `server/paths.mjs` | `sha` 与 `isSubpath` 的新家（拆出以断开 ATS-602 引入的循环依赖） |
| `tests/mobile-import.test.mjs` | UT-MOB-200..318（87 例）：解析、映射、不支持步骤的保留、UID 稳定性、目录集成、复核的 14 个反例与 5 个编辑序列（跨引擎保留 token——静态与权威两条路径、复制后编辑、删除后同指纹新用例、两引擎同时声明同一 token） |
| `tests/mobile-import-it.test.mjs` | IT-ATS602-API-001..015（15 例）：真实 HTTP 下的目录、导入报告、UID 跨重启稳定、改标题经注册表认回、重复 `@TC-` 跨引擎、可信项目保留移动端用例、丢掉的 token 不经注册表发回、复制后编辑不重复、可信项目删除后不复用 UID、可信项目上的 token 规则（真实 Playwright） |
| `tools/ats602-probes/probe-round1-counterexamples.mjs`、`probe-round1-counterexamples-e2e.mjs` | 复核探针（逐字节保留）：14 个反例，进程内与真实 Bridge 两种 |
| `tools/ats602-probes/probe-round2-counterexamples.mjs`、`probe-round2-counterexamples-e2e.mjs`、`probe-round2-reader.mjs` | 复核探针（逐字节保留）：N1/N2-cross/N3 三个编辑序列，进程内、真实 Bridge（trusted 与 untrusted 两种模式）与读取器边界 |
| `tools/ats602-probes/probe-round3-counterexamples-e2e.mjs` | 复核探针（逐字节保留）：可信项目上的 token 规则 T1（Web 丢 token、移动端声明）/ T2 / T3（两引擎同时声明），真实 Bridge（trusted 与 untrusted 两种模式） |
| `tools/ats602-probes/collect-evidence.sh` | 证据采集脚本：11 份日志写入 `docs/evidence/ATS-602/`，每份头部写明所描述的树 |
| `tools/ats602-probes/probe-mobile-import.mjs` | 契约探针：把映射规则并排展示给人读 |
| `tools/update_wbs_ats602.py` | WBS 行的同步脚本（只写 ATS-602 行） |

## 14. ATS-603 的交付物
| 文件 | 作用 |
|---|---|
| `server/adapters/android-adb.mjs` | ADB 传输层：**唯一的** adb 调用点，只以参数向量调用（`shell: false`）；失败原因四分类（`adb-missing` / `device-absent` / `device-offline` / `command-failed`）；`shellQuote` 是设备 shell 引号的唯一实现；`createFakeAdb` 提供可编程的假设备 |
| `server/adapters/android-hierarchy.mjs` | 视图层级树解析器：自带严格 XML 读取器（无依赖），读不到尾 / 未知实体 / 畸形 bounds 都报错；元素按文本、resource-id、content-desc、正则匹配；`summariseHierarchy` 给失败信息用 |
| `server/adapters/android-runner.mjs` | 步骤语义与**失败分类**：六类步骤（launchApp / tapOn / assertVisible / takeScreenshot / recordScreen / readLogs）、封闭的 `MOBILE_FAILURE` 词表、能力协商在第一步之前、层级读取失败可重试、截图校验 PNG 签名与像素尺寸 |
| `server/adapters/android-adapter.mjs` | ATS-301 适配器实现（`kind=android`）：注册进同一注册表、通过同一 `assertAdapter`；能力经设备探针**证明**；项目没有移动端用例时不被选中；结果映射到**统一结果模型** |
| `server/adapters/registry.mjs` | 追加 `android` 适配器（`kind=android` 与 ATS-601 的 `kind=mobile` 并列，互不覆盖） |
| `tests/android-runner.test.mjs` | UT-ATS603-001..047（31 例）：失败分类、能力协商、层级解析、安全边界（无 shell 字符串、证据名不可越根）、瞬时故障重试、前台应用读 `mFocusedApp` |
| `tests/android-adapter.test.mjs` | UT-ATS603-050..065（12 例）：注册表（`kind=android` 与 `kind=mobile` 并列）、能力矩阵（无移动端用例的项目不被选中）、设备层跟随会话、**Bridge 句柄形状**（同步 `start()`、可流式日志、`close` 事件与退出码） |
| `tests/android-runner-it.test.mjs` | IT-ATS603-001..022（9 例）：**真实 Android 模拟器**上的设备探针、四类步骤、整条 Flow、元素找不到与未登记包名的归类；无设备时**跳过并写明原因** |
| `tests/android-bridge-it.test.mjs` | IT-ATS603-030..031（2 例）：**真实 Bridge**（HTTP）——移动端用例与 Web 用例进同一目录、协商选中 `android`、运行走完生命周期落到终态并带回统一结果模型的 summary |
| `tools/ats603-probes/app/com/ichor/smoke/MainActivity.java` | 冒烟夹具 App：屏幕内容**已知**（首页 `ICHOR Smoke Home` + 按钮 `Open Details`；点按后 `ICHOR Detail Screen`），所以断言测的是 Runner 而非设备镜像 |
| `tools/ats603-probes/build-smoke-app.sh` | 夹具构建脚本：SDK 自带的 `aapt2` / `javac` / `d8` / `zipalign` / `apksigner`，**无需 Gradle、无需联网** |
| `tools/ats603-probes/collect-evidence.sh` | 证据采集脚本：日志写入 `docs/evidence/ATS-603/`，每份头部写明所描述的树 |
| `tools/update_wbs_ats603.py` | WBS 行的同步脚本（只写 ATS-603 行） |

## 15. ATS-606 的交付物

| 文件 | 作用 |
|---|---|
| `docs/25-MOBILE-APP-TESTING.md` §8 | 三张表：§8.4 iOS 支持范围表、§8.5 Maestro 命令逐条兼容性判定表、§8.6 不承诺清单 |
| `tools/ats606-probes/probe-maestro-compat.mjs` | 命令清单的**行为**确认（`maestro check-syntax`，含两个负控）+ **逐条实跑导入器**比对 §8.5 的「导入器实际处理」一列 + 参数列与 `STEP_ARGUMENTS` 的一致性 + 计数校验 + **§8.5 整块（三个组标题 + 55 行 + TALLY）与生成器输出逐字比对** + **分组不变量**检查 + **把每一行的分组从字节码重新推导**并与文档比对 + `--self-test` 的**反向负控**（把一行挪到别的组并同步改掉全部计数 / 改错导入处理，探针必须变红；未改动的文档必须仍然通过） |
| `tools/ats606-probes/maestro-action-model.mjs` | **动作模型**：从 Maestro 的**字节码**读出每条命令编译成哪个 orchestra 命令类（`YamlFluentCommand._toCommands` 的分支边界由字节码恢复），以及区分同类的**变体**（单击 / 双击 / 长按；可见 / 不可见 / 等待断言；`action:` 导航命令由枚举的 `yamlValue` 与 switch 表解出）；并给出**哪一步骤种类表达这个动作**（`ACTION_PLATFORM`）与由两者推出的**判定**（`verdictOf`）。§8.5 的**分组由它推导**，不是逐条手写的 |
| `tools/ats606-probes/gen-section-rows.mjs` | **生成** §8.5 的表：导入器行为、参数保真、计数三列是测量的结果；**分组是由字节码推导的**（`maestro-action-model.mjs`），§8.3 的**唯一一套口径**（只看语义能不能表达与命令形态对不对）落在 `ACTION_PLATFORM` 一张表里。「参数保真」一列把每个模型外参数**逐个实跑导入器**测两种写法（与模型内目标同时给出 / 只给该参数），并**逐个点名**每个参数落在哪一种结果里 |
| `tools/ats606-probes/maestro-command-fixtures.json` | 每条 Maestro 命令的最小 Flow 夹具（命令清单与导入器比对的输入） |
| `tools/ats606-probes/write-section-rows.mjs` | 把生成器产出的 §8.5 整块写回设计文档的 `<!-- ATS606-ROWS-START -->` … `END` 之间（行终止符随文档本身，CRLF / LF 都不漂移） |
| `tools/ats606-probes/probe-group-mutants.mjs` | **分组负控**：把行挪到别的组并改掉全部计数（M1–M8，含把 `extendedWaitUntil` 挪进「不映射」这一条），逐条跑交付的探针，**每一条都必须变红**，未改动的 control 必须仍然通过 |
| `tools/ats606-probes/probe-ios-driver-support.mjs` | 从 Maestro 的**字节码**复核 §8.4 的每条 iOS 结论（模拟器路径 vs 真机路径的路由与实现状态、七项 capability 表、两条 iOS 空操作），并**把三条硬前提逐条核到产物上**（`RealIOSDeviceDriver` 的字节码里真有那条 Apple team ID 报错与 `MissingAppleTeamId`；`LocalIOSDeviceController` 的字节码里真有 xcrun/devicectl/install/app/launch 序列；设备侧 `XCTestHTTPServer.swift` 真绑 `127.0.0.1:22087`，且**没有任何 jar 带 iproxy / usbmux 端口转发**），并**逐个 jar 列表核对**两个设备侧 runner 构建（`driver-iPhoneSimulator/` / `driver-iphoneos/`）的出处，以及「没有任何 jar 含 `driver-ios/`」 |
| `tools/ats606-probes/collect-evidence.sh` | 证据采集脚本：8 份日志写入 `docs/evidence/ATS-606/`，每份头部写明所描述的树 |
| `tools/update_wbs_ats606.py` | WBS 行的同步脚本（只写 ATS-606 行） |