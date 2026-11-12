# ATS-213 ｜ OS Keychain / Windows Credential Manager 集成（凭据可用状态）

> 本文档描述 **ATS-213** 的交付：系统凭据库集成之上新增的**凭据可用状态面**，
> 以及本任务实测到并修掉的**一个真实泄漏**。
>
> 交付边界：密钥的**存取**由 ATS-402 交付（`server/security/credentials.mjs` +
> `server/security/wincred.ps1`）；ATS-213 在它之上交付**状态面**——
> 「这个密钥现在能不能用」——并修掉请求体解析失败时的密钥片段泄漏。
> 设计文档可以超前于代码，但**不得把设计中的能力称为已实现**：本文档里
> 「已实现」的每一项都有 `docs/evidence/ATS-213/` 里的实测输出。

---

## 1. 交付范围与边界

### 1.1 交付了什么

| 项 | 状态 | 证据 |
|---|---|---|
| 凭据可用状态（三值闭集） | **已实现并实测** | `01-credential-status-ut.log`、`02/03-credential-status-api-it*.log` |
| 状态对**系统凭据库实测**（不从索引推断） | **已实现并实测** | `05-credential-boundary-probe.log`（B4）、`06-system-test.log`（ST-ATS213-002） |
| 「未配置」与「取不到」不合并 | **已实现并实测** | `01-credential-status-ut.log`（UT-004/005/006/007） |
| 取失败**不静默降级**，报出原因码 | **已实现并实测** | `01-credential-status-ut.log`（UT-012）、`03-credential-status-api-it-real-store.log` |
| 界面显示状态（已配置/未配置/取不到）与原因，**不回显明文** | **已实现并实测** | `06-system-test.log`（ST-ATS213-001/002/003）、`docs/evidence/ATS-213/ui/` |
| 状态**测不出来**时界面如实报「读取失败」 | **已实现** | `apps/studio/app/page.tsx`（`credStatusError` 分支） |
| 请求体解析失败**不回显密钥片段** | **已实现并实测** | `05-credential-boundary-probe.log`（B3a）、`02-credential-status-api-it.log`（IT-005） |

### 1.2 没有交付什么（明确声明，不当作通过）

| 项 | 状态 | 原因与复现方法 |
|---|---|---|
| macOS Keychain 后端 | **代码已写，未在真机实测** | 本机是 Windows 11，没有 macOS 环境。复现：在 macOS 上 `node --test tests/credential-status.test.mjs`（后端经注入的 `spawn` 被驱动过，但从未在真实 Keychain 上执行） |
| Linux Secret Service 后端 | **代码已写，未在真机实测** | 同上（本机无 Secret Service） |
| Tauri 壳内的凭据存取 | **未验证** | `src-tauri/src/lib.rs` **未改动**；本机 `cargo build` 因 B-02 仍无法出包（`docs/16-BASELINE-ADR.md` §4）。复现：`bash tools/ats101-probes/collect-b02-build-link.sh` |
| 凭据状态在**便携 UI**（`fallback.html`）上的呈现 | **未交付** | 本次只做 Next 工作台（与 ATS-111 同一范围）；便携 UI 没有凭据页 |
| 凭据状态**跨设备同步** | **不在范围** | P2，见 §6 |

---

## 2. 凭据的可用状态（credential status）

### 2.1 三个状态，互斥且穷尽

界面上要回答的问题是「**这个密钥现在能不能用**」，而不是「这个密钥是什么」。
因此状态是一个**封闭的三值**，每一条引用**有且只有一个**：

| 状态 | 含义 | 使用者的处置 |
|---|---|---|
| `configured`（已配置） | 凭据库里能取回这个密钥 | 可以用 |
| `not-configured`（未配置） | 这条引用在凭据库里**没有**对应的条目 | **重新录入**这个密钥 |
| `unavailable`（取不到） | 凭据库**本身**取不到（后端不可用、helper 失败、条目存在但读不出来） | **修环境**（凭据库不可达），不是重录密钥 |

**没有第四个「未知」**：状态是**测出来的**，不是猜的。

### 2.2 状态是**测出来的**，不是从索引推断的

这是本任务最核心的一条。

平台的索引（`credentials.json`）只说明「本机记着这个引用」，**凭据库**才说明
「这个密钥现在还在不在」。两者**会分叉**：用户在系统凭据管理器里删了条目，
索引还留着引用。

从索引推断状态会报出一个「已配置」的**假状态**，而使用者真正要用的时候才失败
——「看起来配好了，用的时候才炸」是最坏的形态。

因此 `status()` **真的去凭据库里读一次**。实测（`05-credential-boundary-probe.log`
的 B4，以及 `06-system-test.log` 的 ST-ATS213-002）：

```
# 凭据经 Bridge 存入真实 Windows Credential Manager
201
# 从系统凭据库里删掉那一条（平台索引不动）
helper exit=0 stillReferenced=true status=not-configured reason=CREDENTIAL_NOT_FOUND
```

### 2.3 「未配置」与「取不到」不合并

这两件事对使用者的处置**完全不同**：

- `not-configured` → 要**重新录入**密钥；
- `unavailable` → 密钥**可能还在**，是**环境**不可达，要**修环境**。

把它们并成一个「不可用」，用户会拿着一个其实还在凭据库里的密钥去重录，
或者反过来在凭据库临时不可达时以为密钥丢了。

实现上，这个区分由**错误码**承载（§2.4），不是由消息文本承载。

### 2.4 原因码：封闭词汇表

状态的原因码是**封闭词汇表**，调用方按它分支，**不解析消息文本**：

| 原因码 | 状态 | 含义 |
|---|---|---|
| `CREDENTIAL_FOUND` | `configured` | 条目在凭据库里，且读得出来 |
| `CREDENTIAL_NOT_FOUND` | `not-configured` | 条目**不在**凭据库里 |
| `CREDENTIAL_STORE_UNAVAILABLE` | `unavailable` | 凭据库**本身**不可用（没有后端、helper 起不来） |
| `CREDENTIAL_STORE_FAILED` | `unavailable` | 凭据库可用，但读这一条时失败（含「读回来是空的」） |

这套码进的是**契约**（`GET /api/security/contract` 的 `statusReasons`），
不是某个接口的私有字段。

### 2.5 「读回来是空的」也是取失败

凭据库回答了，但交回空字符串——那不是「可用的密钥」，是**读取失败**。
报成 `configured` 就是静默降级：调用方会拿着一个空密钥去发请求。

实现：`status()` 里 `typeof secret !== 'string' || !secret.length` → `unavailable`
+ `CREDENTIAL_STORE_FAILED`（UT-007）。

### 2.6 一条坏的不影响其它条

每条引用的状态是**各自测出来的**，因此一条读不出来的引用**不会**让整个清单
变成一个错误。否则界面上就看不到「**哪一条**坏了」，只能看到「全坏了」
（UT-010）。

---

## 3. 状态面不含密钥

状态响应里只有：`id` / `name` / `purpose` / `provider` / `fingerprint` /
`status` / `reason` / `checkedAt`。

- **没有** `secret` 字段；
- **没有**密钥的任何**片段**（实测断言的是「完整密钥」与「前 10 个字符」
  两个粒度，见 `05-credential-boundary-probe.log` 的 B3a/B3b/B3c）；
- `fingerprint` 是索引里那 **8 位十六进制**（SHA-256 前缀），用途是让人核对
  「是不是同一个密钥」，不足以还原密钥。

`checkedAt` 说��状态是**什么时候**测的——一个状态不带时间，读的人就不知道
它是刚才的事实还是十分钟前的。

---

## 4. 修掉的一个真实泄漏：解析失败回显密钥片段

### 4.1 现象（实测）

`POST /api/security/credentials` 的请求体里带着 `secret` 字段。当请求体**不是
合法 JSON** 时，V8 的 `JSON.parse` 错误消息会带上**原始输入的一小段**，
而通用的错误映射又把 `e.message` **原样回显**：

```
STATUS: 500
BODY: {"error":"Unexpected token 's', ...\",\"secret\":sk-live-LE\"... is not valid JSON"}
LEAKS FRAGMENT? true | full? false
```

**密钥的前 10 个字符出现在 HTTP 响应体里。**

### 4.2 为什么这不是「一个小问题」

- 响应体会进**日志**（任何记录响应的地方）；
- 响应体会进**浏览器的 devtools**；
- 片段虽不足以还原密钥，但它**证明**了「密钥能从这条路径流出去」——
  而这条路径正是「把密钥送进来」的那条。

### 4.3 修法

请求体解析失败统一报 **`INVALID_REQUEST_BODY`**——一个**不含输入内容**的码
（`server/index.mjs` 的 `body()`）。调用方知道「请求体不是合法 JSON」，
但拿不到请求体的任何片段。

`PAYLOAD_TOO_LARGE` 保持不变（它本来就不含内容）。

### 4.4 为什么这不是「改了别人的行为」

ATS-401/ATS-512 都立过同一条规矩：**新映射的作用域只限自己的错误族**，
其它错误保持原样。这里也一样：

- 改动**只**在 `body()` 的解析失败分支；
- `body()` 是**所有** API 的公共入口，因此这个改动是**全局**的——但它改的
  是「解析失败时回显什么」，而解析失败时回显原始输入**从来**就是缺陷
  （`docs/16-BASELINE-ADR.md` §3.2 已把「原样回显 `e.message`」记为
  ATS-112 的未修缺陷，本条是它在**密钥路径**上的具体表现）；
- 非解析失败的错误**逐字不变**——`tests/agent-api.test.mjs` 的 IT-AGT-013
  仍断言 `ENOENT` 的消息被原样回显（实测仍通过）。

---

## 5. 界面上的状态

### 5.1 状态是**词**，不只靠颜色

`docs/05-UI-UX.md` §4 的规矩：状态不只靠颜色区分。三个状态各有各的词：

| 状态 | 界面上的词 | 图标 |
|---|---|---|
| `configured` | **已配置** | `CheckCircle2` |
| `not-configured` | **未配置** | `TriangleAlert` |
| `unavailable` | **取不到** | `TriangleAlert` |

原因也写出来（`已从系统凭据库取回` / `系统凭据库里没有这一条` /
`本机系统凭据库不可用` / `读取系统凭据库时失败`），并附**查于**的时间。

### 5.2 状态**测不出来**时，界面说「读取失败」

状态接口读取失败时，界面显示「**可用状态读取失败：<原因>**（下方只列出引用，
不代表密钥可用）」。

把一个**没测到的**状态渲染成「未配置」是**编造事实**——这是状态面最坏的
失败形态。因此状态读取与引用列表是**两次独立的请求**：状态失败时，引用照样
显示，但状态那一栏明说测不出来。

### 5.3 界面不回显明文

- 密钥输入框是 `type="password"`，存入后**清空**（`setKeySecret('')`）；
- 状态行只有名称、提供方、指纹、用途、状态、原因、时间；
- 实测（ST-ATS213-003）：页面正文里既没有完整密钥，**也没有它的前 8 个字符**。

---

## 6. API 面

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/security/credentials/status` | 全部凭据的状态（`{statuses, provider, available}`） |
| GET | `/api/security/credentials/:id/status` | 单条凭据的状态（`{status}`） |
| GET | `/api/security/contract` | 契约描述，新增 `statuses` 与 `statusReasons` |

状态面**不需要**新错误码：单条状态查询不存在时返回 **404 `CREDENTIAL_NOT_FOUND`**
（沿用 ATS-402 的映射）；状态**读不出来**时**不是**一个错误响应，而是
**200 + `status: 'unavailable'` + 原因码**——「取不到」是一个**事实**，不是
请求失败。

---

## 7. 平台差异

| 平台 | 后端 | 状态 |
|---|---|---|
| Windows | Credential Manager（`server/security/wincred.ps1`，advapi32 `CredWriteW`/`CredReadW`） | **已实测**（本机 Windows 11） |
| macOS | Keychain（`security` 命令行工具，密钥走 stdin） | 代码已写，**未在真机实测** |
| Linux | Secret Service（`secret-tool`，密钥走 stdin） | 代码已写，**未在真机实测** |

三个后端走**同一个受控的子进程接口**，秘密只经 **stdin/stdout** 传递，
**不进 argv、不进日志**。因此状态面的语义在三个平台上是**同一套**——
但**只有 Windows 这一条有实测证据**，另两条的证据是「经注入的 `spawn`
被单元测试驱动过」，不是真机。

---

## 8. 证据

全部证据在 `docs/evidence/ATS-213/`，每份日志的**头部**写明 commit、
时间戳、命令与**退出码**。

| 日志 | 内容 |
|---|---|
| `01-credential-status-ut.log` | 状态契约的 12 例 UT |
| `02-credential-status-api-it.log` | 状态面的 9 例 IT（HTTP） |
| `03-credential-status-api-it-real-store.log` | 同一组 IT，对**真实 Windows Credential Manager** |
| `04-security-regression.log` | ATS-402 的 108 例安全用例（凭据存储不得回归） |
| `05-credential-boundary-probe.log` | 边界探针 9 项检查 + 2 项负控 |
| `06-system-test.log` | 真实浏览器里的 11 项 ST + 截图 + trace |
| `07-next-build.log` | `tsc --noEmit` + Next.js 静态导出构建 |
| `08-quality-gates.log` | ATS-301 门禁（WBS 助手 + ADR 引用 + 端口审计） |
| `09-full-regression.log` | 全量回归 |
| `10-wbs-row-and-checksums.log` | WBS 行与校验和清单 |
| `ui/` | 真实浏览器的截图与 trace |

复现命令：

```bash
# 全部证据一次收集
bash tools/ats213-probes/collect-evidence.sh

# 单项
node --test tests/credential-status.test.mjs
node --test tests/credential-status-api.test.mjs
node tools/ats213-probes/probe-credential-boundary.mjs
node tools/ats213-probes/st-ats213.mjs docs/evidence/ATS-213/ui
python tools/update_wbs_ats213.py
```

探针的中间产物落在 `$TMPDIR`（默认 `D:/hermes-multica/home/cache/scratch`），
不进版本控制。

---

## 9. 复现「状态是测出来的」

这是本任务最容易被误读成「当然是这样」的一条，因此给出可照抄的步骤：

```powershell
# 1. 存一个密钥（走 Bridge 的接口）
#    记下返回的 credential.id
# 2. 从系统凭据库里删掉那一条，但**不动**平台的索引
powershell -NoProfile -File server/security/wincred.ps1 delete `
  -Target "ATS:ai-test-studio:<credential.id>" -User ai-test-studio
# 3. 查状态
#    GET /api/security/credentials/<credential.id>/status
#    -> {"status":"not-configured","reason":"CREDENTIAL_NOT_FOUND"}
# 4. 查引用列表
#    GET /api/security/credentials
#    -> 那条引用**还在**（索引没动）
```

第 3 步与第 4 步的差别就是「状态是测出来的」的证明：状态说的是**凭据库**
里的事实，引用列表说的是**索引**里的事实，两者不一致时状态跟的是凭据库。

---

## 10. 关联文档

- `docs/23-AI-DATA-SECURITY.md` —— ATS-402 的 AI 数据安全（凭据存储与外传授权）
- `docs/11-SECURITY-RISK.md` SEC-015 / SEC-016 —— 安全风险表
- `docs/02-REQUIREMENTS.md` FR-027 / NFR-009 —— 需求
- `docs/05-UI-UX.md` §4 —— 状态不只靠颜色区分
- `docs/16-BASELINE-ADR.md` §3.2 —— 错误映射与路径泄漏（ATS-112 未修项）
