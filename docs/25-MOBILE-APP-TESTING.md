# 25-MOBILE-APP-TESTING.md ｜ 移动端（App）测试执行面设计书

- 文书 ID：ATS-D-025｜状态：**PARTIAL**（ATS-601 的**契约层**与 ATS-602 的**用例模型/导入映射层**已实现并经 UT/IT 实测；§5~§8 仍为纯设计，仓库内无任何真实移动端执行）
- 目标版本：v0.5.0｜阶段：S6｜WBS：ATS-601 ~ ATS-606
- 需求：FR-031 ~ FR-035、NFR-013
- 起草：2026-11-06

> **基线声明**：本文描述的是**设计**，不是已实现的能力。仓库内没有真实设备会话、
> 没有真实移动端 Runner、没有移动端证据适配层。**已实现的两层**是：
>
>   * §3 的**契约层**（目标/会话模型、状态机、能力协商、拒绝规则、安全边界）——
>     由 ATS-601 实现，UT-MOB-001..094 共 99 例实测；那是**假目标 + 假会话**上的
>     契约测试，**不是真实设备实测**；
>   * §4 的**用例模型与导入映射层**（Flow 解析、语义映射、不支持步骤的保留、
>     导入报告、UID 规则）——由 ATS-602 实现，UT-MOB-200..318 共 87 例 +
>     IT-ATS602-API-001..015 共 15 例实测；那是**文本夹具**上的映射测试，
>     **不涉及任何设备**。
>
> 契约层已实现 ≠ 移动端能跑；用例模型已实现 ≠ Flow 能在设备上跑。
> 任何一项在 ATS-601 ~ ATS-606 完成并通过复核之前，都不得被称作「已实现」。

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

- **不引入 Maestro 作为依赖**。Maestro 是 Java/JVM 工具链，与本仓库的 Node + Tauri 栈不合；
  而且它是 GPL-3.0，引入会改变本项目的分发边界。本平台只借鉴**管理模式**。
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

> **第 2 轮的教训**：第一版只在一个 3 步的平铺夹具上验证过这条等式，
> 于是「可测」被过度推论了。第 1 轮复核在另外四种形状上发现步骤、场景
> 甚至整个 Flow 文件**无报告地消失**。现在的实现把「不静默丢弃」拆成
> 几条各自的规则，每条都有反例测试。

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

### 5.1 执行路径

```
Flow 解析 → TestCase → 步骤调度 → 设备会话 → 逐步骤下发 → 逐步骤采集证据 → 汇总
```

Runner 必须是 **RunnerAdapter 的一个实现**，不得绕开 ATS-301 的契约另起一套。

### 5.2 冒烟用例的最低要求

ATS-603 的验收必须在**真实 Android 模拟器**上跑通下列四类步骤，且每类都有实测输出：

| 步骤 | 断言 |
|---|---|
| 启动 App | 应用进入前台，包名与预期一致 |
| 点按元素 | 目标元素被点中（后续状态可观察） |
| 断言可见 | 元素确实可见；不可见时给出元素名而非泛化失败 |
| 截图 | 截图文件落盘、尺寸正确、可被证据清单引用 |

### 5.3 失败的可诊断性

失败必须区分并暴露：**会话掉线** / **元素找不到**（附视图层级） / **断言不成立** / **驱动报错**。
笼统的「执行失败」不可接受——这与 ATS-512 对宿主提案的处理原则一致：**失败要说清是哪一类**。

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
> 已逐条填完并给出理由。判定所依据的两类事实——**Maestro 侧的命令清单与其 iOS 驱动实现**，
> 与**本平台侧 ATS-601/ATS-602 的步骤词表与能力词表**——都有**可机读复核的来源**：
>
> * Maestro 侧：本机装有 Maestro CLI **2.12.1**（`D:/AI-Tools/Maestro`，
>   2026-11-02 发布，当日最新 release）。命令清单由**行为**确认（对每条命令跑
>   `maestro check-syntax`，看 Maestro 自己认不认），不是抄文档；
>   iOS 两条路径的实现状态由**字节码**确认（`maestro-ios.jar` / `maestro-ios-driver.jar`
>   的 `LocalIOSDevice` / `XCTestIOSDevice` / `SimctlIOSDevice` / `DeviceControlIOSDevice`）。
> * 本平台侧：`server/adapters/mobile-target.mjs`（ATS-601 冻结的六类步骤与七项能力）、
>   `server/discovery/mobile-import.mjs`（ATS-602 冻结的语义与拼写表）。
>
> 复核脚本：`tools/ats606-probes/`。
>
> **本机没有 iOS 环境**（无 macOS / Xcode / 模拟器 / 真机），
> 因此**没有任何一条 iOS 行为被实测过**。下面写的是
> 「按 Maestro 2.12.1 的实现与本平台的契约应当如何」，**不是**「已经跑通了」。
> 任何「已支持 / 已验证」的说法在这里都不成立。

### 8.1 交付形态

**ATS-606 以「设计与边界冻结」交付，不以实测交付**。交付物是三张表：

1. **iOS 支持范围表**（§8.4）：每个步骤类型在 iOS 上「可自动化 / 受限 / 不承诺」，逐条给理由。
2. **Maestro Flow 语法兼容性判定表**（§8.5）：Maestro 的每类命令，判定「本平台可映射 / 部分可映射 /
   不映射」，并给出映射说明或不映射的理由。
3. **不承诺清单**（§8.6）：明确写出手工测试仍需人工完成的部分。

### 8.2 判定依据

判定只依据**语义**（这一步在设备上做什么），不依据具体 YAML 字段名——本平台不承诺兼容其语法。

事实来源分两侧，各自有可机读复核的出处：

| 侧 | 依据 | 出处 | 采集方式 |
|---|---|---|---|
| Maestro 命令清单 | **哪条命令真的存在** | Maestro CLI **2.12.1**（本机 `D:/AI-Tools/Maestro`） | **行为确认**：`maestro check-syntax` 对每条候选命令判定认/不认（`tools/ats606-probes/probe-maestro-compat.mjs`）。**不抄文档清单**——文档的索引页只有 48 条，而 Maestro 实际接受 **55** 条（差的 7 条是 `inputRandom*` 家族，官方文档把它们写在 `inputText` 页里而不是索引页） |
| Maestro iOS 实现 | **每条命令在 iOS 上能不能跑** | 同上 jar 的字节码 | `LocalIOSDevice` 把操作分给两个后端：**XCTest 驱动**（20 个操作）与**deviceController**（9 个操作）。deviceController 在模拟器上是 `SimctlIOSDevice`、在真机上是 `DeviceControlIOSDevice`，**后者的实现状态与前者不同** |
| 本平台侧 | 步骤词表、能力词表、语义映射表 | `server/adapters/mobile-target.mjs`（ATS-601）、`server/discovery/mobile-import.mjs`（ATS-602） | 源码直接读出 |

**为什么要看字节码而不只看文档**：官方文档描述的是**命令的意图**，
而「这个命令在 iOS 真机上能不能跑」取决于**该命令在 iOS 驱动里的实现**。
这两者可以不一致——文档说支持，驱动里却是 `NotImplementedError`。
§8.4 与 §8.5 的判定必须落到后者，否则就是拿文档当实现。

### 8.3 术语与判定口径

- **可自动化**：该语义在 iOS 上有**已实现**的支撑，且本平台的步骤词表里有对应种类。
- **受限**：语义在 iOS 上有实现，但**在 iOS 真机路径上不可用**，
  或其语义/参数超出本平台 ATS-601 冻结的六类步骤词表。
- **不承诺**：本平台不提供该语义；或 Maestro 自己也不承诺（如 AI 命令为实验特性）。

判定粒度是**命令**（Maestro 侧）与**步骤种类**（本平台侧）两套词表，
不是 YAML 字段名。§8.5 的表把两者用「本平台对应步骤种类」一列连起来。

### 8.4 iOS 支持范围表

本平台的步骤种类是 ATS-601 冻结的**六类**（`server/adapters/mobile-target.mjs`
的 `MOBILE_STEP_KINDS`），能力词表是**七项**（`MOBILE_CAPABILITY`）。

**判定方法**：对每一类步骤，先找出 Maestro 实现它所必需的**底层操作**，
再按 `LocalIOSDevice` 的**路由**（该操作走 XCTest 驱动还是走 deviceController）
查该后端在**模拟器**（`SimctlIOSDevice`）与**真机**（`DeviceControlIOSDevice`）上的实现状态。

| 本平台步骤种类 | 需要的 capability | Maestro 侧依赖的底层操作 | iOS 模拟器 | iOS 真机 | 判定 | 理由 |
|---|---|---|---|---|---|---|
| `launchApp` | `app.install` 或 `app.launch` | `launch`（走 deviceController） | 可自动化 | **受限** | 模拟器可自动化；真机受限 | `SimctlIOSDevice.launch` 已实现；`DeviceControlIOSDevice.launch`（真机路径）抛 `NotImplementedError`——**iOS 真机上 Maestro 自己也没有实现 App 启动**。本平台的 `launchApp` 需要 `app.launch`/`app.install`，真机路径无法满足 ⇒ 该步骤在真机上不可执行 |
| `tapOn` | `ui.tap` + `ui.hierarchy` | `tap` + `viewHierarchy`（走 XCTest 驱动） | 可自动化 | 可自动化 | 两条路径均可自动化 | `XCTestIOSDevice.tap` / `viewHierarchy` **在两条路径上都是同一段实现**（XCUITest driver 装在设备上，模拟器与真机同一条路径），没有未实现项 ⇒ 元素定位与点按**在真机上可用** |
| `assertVisible` | `ui.hierarchy` | `viewHierarchy`（走 XCTest 驱动） | 可自动化 | 可自动化 | 两条路径均可自动化 | 同上：断言依赖的视图层级树在真机路径上**已实现** |
| `takeScreenshot` | `screen.capture` | `takeScreenshot`（走 XCTest 驱动） | 可自动化 | 可自动化 | 两条路径均可自动化 | `XCTestIOSDevice.takeScreenshot` 已实现，两条路径同源 |
| `recordScreen` | `screen.record` | `startScreenRecording`（走 deviceController） | 可自动化 | **受限** | 模拟器可自动化；真机受限 | 模拟器走 `SimctlIOSDevice.startScreenRecording`（已实现）；真机路径 `DeviceControlIOSDevice.startScreenRecording` 未实现 |
| `readLogs` | `log.read` | 设备日志流（`IOSDriver` 层，走 `xcrun simctl spawn <id> log stream --style syslog`） | 可自动化 | **不承诺** | 模拟器可自动化；真机不承诺 | 日志采集走 `LocalSimulatorUtils.startDeviceLogStream`，即 **`simctl`**，只对模拟器成立；真机路径没有对应的设备日志采集实现 |

**这张表的结论**：**iOS 真机路径不是「全都不行」，而是「按能力分层的」**——
**UI 交互（点按、断言、截图）在真机上是可用的**，因为它们走 XCUITest driver；
但**App 生命周期（启动）与录屏在真机上不可用**，因为它们走 deviceController，而真机那侧尚未实现。
这与「Maestro 的真机路径整体未实现」是不同的结论，后者是错的。

> 这不是本平台的缺陷，也不是说 iOS 真机不能测——是说 **Maestro 2.12.1 的真机路径只实现了一半**。
> 本平台若要做 iOS 真机，**UI 交互可以照抄 XCUITest driver 的做法**，
> 而**App 启动与录屏必须自己写**（`devicectl` / `xcrun devicectl device process launch` 一类），
> 那是 ATS-603 之后的独立工作量，**不在 S6 范围内**。

**七项 capability 在 iOS 上的可满足性**（供 ATS-603/ATS-605 直接引用）：

| capability | iOS 模拟器 | iOS 真机 | 说明 |
|---|---|---|---|
| `app.install` | 可满足 | 不可满足 | 真机 `install` 未实现 |
| `app.launch` | 可满足 | 不可满足 | 真机 `launch` 未实现 |
| `ui.tap` | 可满足 | **可满足** | 走 XCTest 驱动，两条路径同源 |
| `ui.hierarchy` | 可满足 | **可满足** | 走 XCTest 驱动，两条路径同源 |
| `screen.capture` | 可满足 | **可满足** | 走 XCTest 驱动，两条路径同源 |
| `screen.record` | 可满足 | 不可满足 | 真机 `startScreenRecording` 未实现 |
| `log.read` | 可满足 | **不承诺** | 日志流走 `simctl`，只对模拟器成立 |

**能力协商的落点**：上表「不可满足」的项在真机上会让 ATS-601 的
`negotiateMobileCapabilities` 产出对应的能力缺口，**执行前就被拒绝**
（`REMOTE_CAPABILITY_MISSING`），而不是在执行中炸出驱动错误。这正是 §3.3 设计的用意。

**另外两条 iOS 侧的硬事实**（与命令无关，但决定了 §8.5 的判定）：

| 事实 | 证据 | 影响 |
|---|---|---|
| `back` 在 iOS 上是**空操作** | `IOSDriver.backPress` 的字节码体只有一条 `return` | iOS 没有返回键；`back` 在 Maestro 官方文档里也写明「只支持 Android 与 Web」 |
| 飞行模式在 iOS 上**不生效** | `IOSDriver.setAirplaneMode` / `isAirplaneModeEnabled` 只打一条 `Airplane mode is not available on iOS simulators` 的 warn 就返回 | `setAirplaneMode` / `toggleAirplaneMode` 即使实现了也不构成 iOS 能力 |

### 8.5 Maestro Flow 语法兼容性判定表

Maestro CLI 2.12.1 实际接受 **55 条命令**（由 `maestro check-syntax` 行为确认，
见 `tools/ats606-probes/probe-maestro-compat.mjs`）。
下表按判定分组，**每条命令都在表里**。

判定口径：

- **可映射**：本平台有对应步骤种类（ATS-601 六类之一），语义一致，
  且该语义在 iOS 模拟器上可自动化。
- **部分可映射**：语义能被本平台表达，但**命令形态不同**（配对命令 vs 单步）、
  **参数超出本平台模型**（参数保留并告警，不丢弃）或**平台差异**（如 Maestro 自己的 7 秒等待语义）。
- **不映射**：本平台的步骤词表里没有该语义（ATS-602 会把它保留原文并标记不支持），
  或 Maestro 自己也不承诺（实验性 AI 命令）。

#### 8.5.1 可映射（7 条）

| Maestro 命令 | 本平台对应步骤种类 | 映射说明 |
|---|---|---|
| `launchApp` | `launchApp` | 语义一致：启动被测 App。本平台的 `launchApp` 支持 `appId` 与别名（`app` / `package` / `packageName` / `bundleId`）。Maestro 的 `permissions` / `arguments` / `clearState` 等参数**不在模型内**⇒保留并告警、执行时不生效 |
| `tapOn` | `tapOn` | 语义一致：点按元素。本平台的目标可以是**文本**或**资源 id**（二者任一即可，缺任一即判为不支持）。Maestro 的 `index` / `point` / `repeat` 等参数不在模型内⇒保留并告警、执行时不生效 |
| `assertVisible` | `assertVisible` | 语义一致：断言元素可见。本平台的断言形如 `{visible: <目标>}` |
| `assertNotVisible` | `assertVisible` | 语义一致：断言元素不可见。本平台的 `assertVisible` 支持 `visible` 与 `notVisible` 两个限定词（ATS-602 的 `isSupportedQualifier`），所以断言语义能表达；但 **Maestro 的 7 秒 fluent 重试语义本平台的模型里没有对应字段**⇒等待行为不等价 |
| `takeScreenshot` | `takeScreenshot` | 语义一致：截屏。本平台的落盘路径走 ATS-209 的证据路径校验与 SHA-256 |
| `startRecording` | `recordScreen` | 语义一致：开始录屏。本平台的 `recordScreen` 是一步（录一段），Maestro 是「开始/停止」两条配对命令⇒**配对语义在单步模型里无处安放**，录屏的开始/结束边界表达不出来 |
| `stopRecording` | `recordScreen` | 语义一致：结束录屏。与 `startRecording` 同一条判定——**配对语义在单步模型里无处安放** |

#### 8.5.2 部分可映射（3 条）

| Maestro 命令 | 本平台对应步骤种类 | 判定理由 |
|---|---|---|
| `clearState` | `launchApp`（语义近似） | 「把 App 恢复到全新安装状态」在本平台**没有对应步骤**（六类里只有 `launchApp` 一个生命周期步骤，且它没有 `clearState` 参数）。可映射的部分是「启动 App」，不可映射的部分是「清状态」⇒ 语义只覆盖了一半 |
| `killApp` | `launchApp`（语义近似） | 「强杀 App」没有对应步骤。可映射的部分是「启动 App」，不可映射的部分是「结束并强杀进程」⇒ 语义只覆盖了一半；一轮用例的收尾只能靠进程自然退出 |
| `stopApp` | `launchApp`（语义近似） | 「正常停止 App」没有对应步骤。同 `killApp`：可映射的部分是「启动 App」，不可映射的部分是「停止」⇒ 语义只覆盖了一半 |

> 这三条**不是「差一点就能映射」**，而是「语义只覆盖了一半」：本平台的生命周期步骤只有 `launchApp` 一个，**清状态 / 停止 / 强杀**三件事都无处安放。把它们单列而不是并进「不映射」，是因为它们直接决定了 iOS 用例**能不能可重复地跑**。

#### 8.5.3 不映射（45 条）

| Maestro 命令 | 不映射的理由 |
|---|---|
| `inputText` / `inputRandomEmail` / `inputRandomPersonName` / `inputRandomNumber` / `inputRandomText` / `inputRandomCityName` / `inputRandomCountryName` / `inputRandomColorName` / `eraseText` / `copyTextFrom` / `pasteText` / `setClipboard` | 本平台六类步骤里**没有文本输入与剪贴板操作**。这是最大的能力缺口（见 §8.6）——登录、表单填写、搜索这类最常见的用例形态，本平台一步都表达不了 |
| `doubleTapOn` / `longPressOn` / `scroll` / `scrollUntilVisible` / `swipe` | 本平台**没有手势步骤**（双击 / 长按 / 滚动 / 滑动）。长列表、下拉刷新、抽屉导航一类场景因此不承诺 |
| `hideKeyboard` / `back` / `pressKey` | 本平台**没有键盘处理与按键步骤**。`back` 在 iOS 上另有一层问题：它是**空操作**（`IOSDriver.backPress` 的字节码体只有一条 `return`），Maestro 官方文档也写明它只支持 Android 与 Web |
| `clearKeychain` | `clearKeychain` 是 **iOS 专属**命令（清 iOS Keychain）。本平台没有该步骤 ⇒ iOS 用例**无法保证从干净状态起跑**（登录态跨用例泄漏）。它与 Android 上的 `clearState` 分开列，是因为它在 Maestro 里只对 iOS 有效，而本平台恰恰是在 iOS 上缺它 |
| `openLink` / `setPermissions` / `setLocation` / `travel` / `setOrientation` / `setDarkMode` / `toggleDarkMode` / `assertDarkMode` / `assertLightMode` / `setAirplaneMode` / `toggleAirplaneMode` / `addMedia` | 本平台**没有对应的步骤**，也没有对应的 capability。其中飞行模式（`setAirplaneMode` / `toggleAirplaneMode`）另有一层问题：**iOS 上本来就不生效**（Maestro 的 iOS 驱动对这两个命令只打一条 warn 就返回）⇒ 即使实现了也不构成 iOS 能力 |
| `assertTrue` / `assertScreenshot` / `waitForAnimationToEnd` / `extendedWaitUntil` | 本平台的断言只有 `visible` / `notVisible` 两种限定词（ATS-602 的 `isSupportedQualifier`），**没有任意表达式断言、没有等待步骤、没有视觉比对** |
| `evalScript` / `runScript` / `runFlow` / `repeat` / `retry` | 本平台**不执行 Flow 里的任意代码**（ATS-602 的解析器是「只读文本、不执行任何内容」的受限子集读取器），用例也是**扁平的 TestCase 列表**（无子流程、无重复/重试结构） |
| `assertWithAI` / `assertNoDefectsWithAI` / `extractTextWithAI` | **实验性** AI 命令：Maestro 自己也标注为 experimental；本平台不承诺 AI 断言能力（AI 能力属 ATS-401/ATS-403 的契约层，未做端到端实测） |

**统计**：Maestro 2.12.1 的 55 条命令中，
**可映射 7 条 / 部分可映射 3 条 / 不映射 45 条**。
逐条对照由 `tools/ats606-probes/probe-maestro-compat.mjs` 机读校验：
命令清单（行为确认）、§8.5 的判定与计数、以及判定与 ATS-601 词表的一致性，
三者必须同时成立，不一致即退出码 1。

#### 8.5.4 关于「兼容」的结论（FR-035 的直接答案）

**结论：不兼容，且是设计选择，不是缺陷。**

本平台**不实现 Maestro Flow 语法的兼容层**（docs/25 §1.2 已定）。
ATS-602 的两种自带语法是**平台自己的读法**，不是对任何第三方工具的语法承诺。
所以 FR-035 要的「逐条判定并给出结论」，结论是：

| 判定 | 含义 | 条数 |
|---|---|---|
| 可映射 | 语义落在 ATS-601 的六类步骤里，且在 iOS 上可自动化 | 7 |
| 部分可映射 | 语义只覆盖了一半（如「启动 App」覆盖了 `clearState` 的前半截） | 3 |
| 不映射 | 本平台的步骤词表里没有该语义 | 45 |

**「不映射」的后果是被设计过的**：ATS-602 的映射器**保留原文 + 标记不支持 + 进导入报告**，
绝不静默丢弃。所以一份用 Maestro 全量语法写的 Flow 导入本平台时，
**45 类命令会逐条出现在导入报告里**（带原文、行号、判定原因），
而不是变成一个「导入成功」的假象。**这正是 ATS-602 存在的意义。**

### 8.6 不承诺清单

以下内容**本平台不承诺**，需人工完成或另立任务：

| # | 不承诺的内容 | 原因 | 影响的 iOS 场景 |
|---|---|---|---|
| 1 | **iOS 真机上的 App 启动与录屏** | Maestro 2.12.1 的真机路径（`DeviceControlIOSDevice`）的 `launch` / `install` / `clearAppState` / `startScreenRecording` / `addMedia` / `clearKeychain` / `openLink` / `setLocation` 均未实现（其余 `tap` / `viewHierarchy` / `takeScreenshot` 等走 XCTest 驱动，**真机可用**） | 真机上的「启动 App → 跑场景 → 留证据」这条链**在真机上断在第一步**；iOS 真机用例目前**只能手工执行** |
| 2 | **文本输入** | 六类步骤里没有输入步骤 | 登录、表单填写、搜索——**最常见的用例形态** |
| 3 | **滚动/滑动/双击/长按等手势** | 没有手势步骤 | 长列表、下拉刷新、抽屉导航 |
| 4 | **键盘处理** | 没有 `hideKeyboard` | 软键盘遮挡提交按钮等场景 |
| 5 | **断言「不可见」的等待语义** | 模型里只有 `visible` / `notVisible`，没有 Maestro 的 7 秒 fluent 重试与 `extendedWaitUntil` | 依赖等待的断言在弱网/慢设备上易 flaky |
| 6 | **iOS Keychain 清理与 App 状态重置** | 没有 `clearKeychain` / `clearState` 步骤 | iOS 用例的**干净起跑**无法保证——登录态会跨用例泄漏 |
| 7 | **权限弹窗处理** | 没有 `setPermissions` 步骤，`launchApp` 也没有权限参数 | 首次安装后的位置/相机/通知授权弹窗 |
| 8 | **App 停止/强杀** | 没有 `stopApp` / `killApp` 步骤 | 一轮结束后无法显式收尾，依赖进程自然退出 |
| 9 | **视觉回归判定** | 只有取证（`takeScreenshot`），没有比对 | 视觉走查仍需人工 |
| 10 | **执行 Flow 中的 JavaScript** | 安全红线：平台的 Flow 解析器只读文本、不执行内容 | `evalScript` / `runScript` / `assertTrue` 表达的逻辑需改写为平台步骤或移到用例外 |
| 11 | **深链/URL 打开、系统按键、方向与深浅色、地理位置、相册注入** | 无对应步骤 | 多 App 跳转、深链入口、外设场景 |
| 12 | **子流程与流程复用** | 用例是扁平列表，无 `runFlow` | 登录前置等公共步骤只能复制 |
| 13 | **AI 断言** | Maestro 侧为实验特性；本平台 AI 能力只有契约层，未端到端实测 | 复杂视觉状态的自动判定 |

**总口径**：**iOS 上目前只承诺「模拟器上的六类步骤」+「真机上的 UI 交互三类」这一小块**。
其余部分**明确不承诺**，且**不得被写成已支持**。

### 8.7 复核方法（可机读）

| 要复核的结论 | 复核命令 | 期望 |
|---|---|---|
| Maestro 命令清单（55 条）与 §8.5 的判定一一对应 | `node tools/ats606-probes/probe-maestro-compat.mjs` | `MAESTRO COMMAND INVENTORY: OK (55 commands)` |
| §8.5 每条命令都有判定，且计数与文中一致 | 同上 | `COMPATIBILITY TABLE: OK` |
| §8.5 的「可映射」都指向 ATS-601 冻结的步骤种类 | 同上（读 `server/adapters/mobile-target.mjs`） | `every mappable row names a step kind that ATS-601 freezes` |
| iOS 两条路径的实现状态（§8.4 的事实基础） | `node tools/ats606-probes/probe-ios-driver-support.mjs` | `IOS DRIVER SUPPORT: OK`（需要本机 `D:/AI-Tools/Maestro`；缺 Maestro 时**跳过并写明原因**，不写 PASS） |
| 证据日志 | `bash tools/ats606-probes/collect-evidence.sh <tree>` | `docs/evidence/ATS-606/` |

---
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
| ATS-603 | Android 模拟器 Runner 原型与真实设备冒烟 | ATS-602 | UT + IT | **真实模拟器实测** |
| ATS-604 | 移动端证据归档与统一结果模型 | ATS-603 | UT + IT | 证据适配层 |
| ATS-605 | 移动端能力矩阵与环境依赖声明 | ATS-603 | 审查 | 矩阵 + 未验证声明 |
| ATS-606 | iOS 真机路径与 Maestro 兼容性边界 | ATS-602 | 审查 | **设计与边界冻结**（无实测） |

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
- **未验证（真实移动端执行面）**：§5~§8 的全部内容仍是设计判断，**未在本仓库做过任何
  移动端实测**。没有真实设备、没有真实模拟器、没有 ADB 调用、没有移动端证据。
- Maestro 的产品结构与能力来自 2026-11-06 的官方文档调査（`docs/15-REFERENCES-LICENSES.md`
  登记引用）；调査结论本身不是对本平台的实测。
- 本机无 Android SDK/AVD、无 iOS 环境、无 ADB 连接设备——ATS-603 的真实冒烟是否能在本机完成，
  **未验证**，由 ATS-605 负责在执行时给出明确声明。
- 若本机确实不具备 Android 环境，ATS-603 面临的是「无法实测」而非「实现困难」；
  此时应把该项的验证方式降级并在 WBS 备注里写明，而不是把 PENDING 写成 PASS。
- 已知边界（ATS-601 契约层自身）：
  - 会话的**能力集由调用方提供**——契约校验会话能力**不超过目标声明**，
    并据此计算缺口；但**证明**设备能力的动作（探测层级树、试抓截图）属真实驱动（ATS-603）。
    契约层**不**验证调用方给出的能力集本身是否真实。
  - 目标与会话是**内存中的数据**，本任务**不引入持久化**；会话的存储与恢复随 ATS-603 一并落地。
  - 移动端适配器当前**没有任何可用能力**，它存在的意义是把「移动端执行」这件事的
    **入口与拒绝路径**定下来，让 ATS-603 有地方可长，而不是一个平行的 Playwright 专用实现。
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
