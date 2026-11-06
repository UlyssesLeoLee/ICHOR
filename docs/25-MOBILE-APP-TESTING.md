# 25-MOBILE-APP-TESTING.md ｜ 移动端（App）测试执行面设计书

- 文书 ID：ATS-D-025｜状态：**PARTIAL**（ATS-601 的**契约层**已实现并经 UT 实测；§4~§8 仍为纯设计，仓库内无任何真实移动端执行）
- 目标版本：v0.5.0｜阶段：S6｜WBS：ATS-601 ~ ATS-606
- 需求：FR-031 ~ FR-035、NFR-013
- 起草：2026-11-06

> **基线声明**：本文描述的是**设计**，不是已实现的能力。仓库内没有真实设备会话、
> 没有真实移动端 Runner、没有移动端证据适配层。**唯一例外**是 §3 的**契约层**
> （目标/会话模型、状态机、能力协商、拒绝规则、安全边界），它已由 ATS-601 实现并经
> UT-MOB-001..070（含 5 个字母后缀的补充例）共 75 例实测——但那是**假目标 + 假会话**上的
> 契约测试，**不是真实设备实测**。
> 契约层已实现 ≠ 移动端能跑；任何一项在 ATS-601 ~ ATS-606 完成并通过复核之前，
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

### 4.1 映射规则

移动端 Flow（无论何种语法）映射到统一的 `TestDefinition`：

| Flow 概念 | 统一模型 |
|---|---|
| 一个 Flow 文件 | 一个 `TestDefinition`（suite） |
| Flow 内的一个场景 | 一个 `TestCase` |
| 场景内的一步 | 一个 `TestStep`，带 `kind` 与参数 |
| 步骤的断言 | `TestStep.assertion` |

### 4.2 映射不了的步骤怎么办（关键规则）

**保留原文 + 标记不支持 + 进入导入报告**，绝不静默丢弃，也绝不"猜"一个近似步骤。

导入报告至少给出：Flow 路径、行号、原始步骤文本、判定原因、建议的替代。

这与本仓库既有的「受控子集」原则一致（见 ATS-314 的 AST 受控步骤子集）：
**能反写的才反写，不能反写的原位保留。**

### 4.3 UID

移动端用例进入 ATS-201 的稳定 UID 规范：文件+行号为 basis，标题为 key。
切换导入方式（不同 Flow 语法解析器）不得改变已有 UID——这与 ATS-202 的
「切换索引不改变已有 UID」是同一条约束，验收时复用同一组反例。

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

### 8.1 交付形态

本机没有 iOS 环境，**ATS-606 以「设计与边界冻结」交付，不以实测交付**。
交付物是三张表：

1. **iOS 支持范围表**：每个步骤类型在 iOS 上「可自动化 / 受限 / 不承诺」，逐条给理由。
2. **Maestro Flow 语法兼容性判定表**：Maestro 的每类命令，判定「本平台可映射 / 部分可映射 /
   不映射」，并给出映射说明或不映射的理由。
3. **不承诺清单**：明确写出手工测试仍需人工完成的部分。

### 8.2 判定依据

Maestro 命令以官方文档为准（<https://docs.maestro.dev/maestro-cli>）。
判定只依据**语义**（这一步在设备上做什么），不依据具体 YAML 字段名——本平台不承诺兼容其语法。

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
| ATS-602 | 跨引擎用例模型与移动端 Flow 导入映射 | ATS-601 | UT + IT | 映射器 + 导入报告 |
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
- **未验证（真实移动端执行面）**：§4~§8 的全部内容仍是设计判断，**未在本仓库做过任何
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

---

## 12. 依据文档

- `docs/02-REQUIREMENTS.md` FR-031 ~ FR-035、NFR-013
- `docs/18-RUNNER-ADAPTER-CONTRACT.md`（ATS-301 的适配器契约与能力协商）
- `docs/18-UID-SPEC.md`（ATS-201 的稳定 UID 规范）
- `docs/11-SECURITY-RISK.md`（可信仓库、证据路径校验、凭据外传）
- `docs/19-REMOTE-RUNNER-PROTOCOL.md`（ATS-501 的远程信任边界与租约语义）
- `docs/13-ROADMAP.md` §2 的 P1 双引擎阶段
- `docs/15-REFERENCES-LICENSES.md`（Maestro 官方文档引用）
