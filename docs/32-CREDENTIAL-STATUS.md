# ATS-213 ｜ OS Keychain / Windows Credential Manager 集成（凭据引用与可用状态）

> 本文档描述 **ATS-213** 的交付：**密钥仅以引用传递**，以及系统凭据库集成
> 之上的**凭据可用状态面**。
>
> 交付边界：密钥的**存取**由 ATS-402 交付（`server/security/credentials.mjs` +
> `server/security/wincred.ps1`）；ATS-213 在它之上交付两件事——
>
>   1. **凭据引用**：环境档案里可以写**引用**，运行启动时平台把引用解析成
>      密钥注入封口的 runner 环境；解析不了就**拒绝启动**；
>   2. **可用状态面**：界面要能回答「这个密钥现在能不能用」，并且**取不到
>      时不静默降级**。
>
> 设计文档可以超前于代码，但**不得把设计中的能力称为已实现**：本文档里
> 「已实现」的每一项都有 `docs/evidence/ATS-213/` 里的实测输出。

---

## 1. 交付范围与边界

### 1.1 交付了什么

| 项 | 状态 | 证据 |
|---|---|---|
| **密钥仅以引用传递**：档案存引用，运行启动时解析并注入封口环境 | **已实现并实测** | `11-credential-reference-st.log`（REF-ST-001..010，真实 Playwright 运行 + 真实 Windows Credential Manager） |
| 引用**解析只在一个收口点**，每条运行路径都经过它 | **已实现并实测** | `15-credential-boundaries-ut.log`（ATS213-R3-UT-004..007）、变异体 M-P2 |
| 未解析的引用**拒绝启动**，绝不 `String()` 成 `"[object Object]"` | **已实现并实测** | `15-credential-boundaries-ut.log`（ATS213-R3-UT-004/005/006）、变异体 M-P2 |
| 注入的密钥在**落盘前脱敏**（日志/报告/HTML 内嵌 zip/证据归档/镜像） | **已实现并实测** | `16-credential-redaction-it.log`（真实凭据库 + 真实 Playwright 运行，数据目录 0 命中）、变异体 M-P3b |
| 脱敏**跨分块**（一个密钥被切成两块也不漏） | **已实现并实测** | `15-credential-boundaries-ut.log`（ATS213-R3-UT-009/010/011）、变异体 M-P3 |
| 二进制产物（trace/截图/视频）是**写下来的边界**，并记在运行记录上 | **已实现并实测** | `15-credential-boundaries-ut.log`（ATS213-R3-UT-016）、`docs/32` §6.5 |
| 状态面**不读明文**（走 `probe`，`read()` 只用于注入环境） | **已实现并实测** | `15-credential-boundaries-ut.log`（ATS213-R3-UT-001/002/003）、变异体 M-P1 |
| 引用**解析不了即拒绝启动**，报 `CREDENTIAL_*` 原因码 | **已实现并实测** | `04-credential-reference-it.log`（ATS213-REF-IT-002）、`09-credential-reference-st.log`（REF-ST-004） |
| 运行记录、事件日志、SQLite 镜像、证据归档里**没有密钥** | **已实现并实测** | `11-credential-reference-st.log`（REF-ST-008/009/010：数据目录扫描 0 命中） |
| 凭据可用状态（三值闭集） | **已实现并实测** | `01-credential-status-ut.log`、`02/03-credential-status-api-it*.log` |
| 状态对**系统凭据库实测**（不从索引推断） | **已实现并实测** | `05-credential-boundary-probe.log`（B4）、`06-system-test.log`（ST-ATS213-002） |
| 「未配置」与「取不到」不合并 | **已实现并实测** | `01-credential-status-ut.log`（UT-004/005/006/007） |
| 取失败**不静默降级**，报出原因码 | **已实现并实测** | `01-credential-status-ut.log`（UT-012）、`03-credential-status-api-it-real-store.log` |
| 界面显示状态（已配置/未配置/取不到）与原因，**不回显明文** | **已实现并实测** | `06-system-test.log`（ST-ATS213-001/002/003）、`docs/evidence/ATS-213/ui/` |
| 整张状态清单基于**同一份索引快照**，单条异常不拖垮整张清单 | **已实现并实测** | `01-credential-status-ut.log`（UT-013/014）、`12-credential-status-mutants.log`（M-S1） |
| 凭据库的「可用」是**实测**的，不是「文件在不在」推断的 | **已实现并实测** | `01-credential-status-ut.log`（UT-015..017）、`09-status-failures-st.log`（U1b/U1b-api） |
| 状态**测不出来**时界面如实报「读取失败」，旧状态不冒充当前状态 | **已实现并实测** | `09-status-failures-st.log`（U2/U2-count/U2-refs） |
| 状态读取失败时**引用照样显示**，删除按钮还在 | **已实现并实测** | `09-status-failures-st.log`（U3/U3-delete/U3-note） |
| 「不可用密钥」的说明**逐类计数**，不与数字自相矛盾 | **已实现并实测** | `09-status-failures-st.log`（U1a/U1a-count）、`12-credential-status-mutants.log`（M-U1a） |
| 请求体解析失败**不回显密钥片段** | **已实现并实测** | `05-credential-boundary-probe.log`（B3a）、`02-credential-status-api-it.log`（IT-005） |

### 1.2 没有交付什么（明确声明，不当作通过）

| 项 | 状态 | 原因与复现方法 |
|---|---|---|
| macOS Keychain 后端 | **代码已写，未在真机实测** | 本机是 Windows 11，没有 macOS 环境。复现：在 macOS 上 `node --test tests/credential-status.test.mjs`（后端经注入的 `spawn` 被驱动过，但从未在真实 Keychain 上执行） |
| Linux Secret Service 后端 | **代码已写，未在真机实测** | 同上（本机无 Secret Service） |
| Tauri 壳内的凭据存取 | **未验证** | `src-tauri/src/lib.rs` **未改动**；本机 `cargo build` 因 B-02 仍无法出包（`docs/16-BASELINE-ADR.md` §4）。复现：`bash tools/ats101-probes/collect-b02-build-link.sh` |
| 凭据状态在**便携 UI**（`fallback.html`）上的呈现 | **未交付** | 本次只做 Next 工作台；便携 UI 没有凭据页 |
| 凭据引用在 **Tauri 壳内**的解析 | **未交付** | 壳内没有 Bridge 的运行时，引用解析走的是 Bridge 的运行期路径 |
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

这条约束在**两种**情况下都成立，两种都被测到了：

| 情况 | 处理 | 用例 |
|---|---|---|
| 某一条**读不出来**（helper 失败、读回空串） | 这一条是 `unavailable` + `CREDENTIAL_STORE_FAILED`，其它条照常测 | UT-010 |
| 某一条的 **id 不合规**（索引里的一条旧格式记录） | 这一条**单独**得到一个状态（`unavailable` + `CREDENTIAL_STORE_FAILED`），整张清单不抛错 | UT-014 |

整张清单基于**同一份索引快照**计算。这条约束是承重的：遍历期间被
`DELETE` 掉的引用**直接跳过**，清单不因它返回一个错误（UT-013）。少了这一条，
一个并发的删除会让整张清单变成 404，界面上「全部密钥都坏了」。

换句话说：**一张清单里没有「整张失败」这个状态**。清单要么给出每条的状态，
要么在**索引文件本身**读不出来时失败——那是索引的问题，与「某一条坏了」
不是一回事。

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

三条具体规则，每条都有实测：

| 规则 | 为什么 | 用例 |
|---|---|---|
| **旧状态被清空**，不冒充当前状态 | 一个可能已被吊销的密钥，如果继续显示「已配置」，读的人会以为它还能用 | U2 |
| 旧状态**不计入「可用密钥」** | 同一个数字被两处用，一处说 2 一处说 0，读的人得自己判断信哪个 | U2-count |
| **引用照样显示**，**删除按钮还在** | 状态读不出来不等于凭据没了；读者仍然要能删掉一条引用 | U3 / U3-delete |

失败后的界面上，引用行的状态词是「**状态未测得**」，而不是「未配置」——
「未配置」是一条**断言**（这一条确实不在凭据库里），而「未测得」是**事实**
（没人测过）。

### 5.3 凭据库的「可用」是**实测**的

「系统凭据库已就绪」这句话只有在**真的调用过一次**凭据库之后才能说。

后端自己的 `available()` 回答的是「这个平台支不支持、helper 脚本在不在」——
那是关于**文件系统**的事实，它在 helper **根本起不来**的时候仍然是 `true`。
因此状态接口的 `available` 字段来自 `credentialStore.health()`：它做**一次
真实的 helper 调用**，然后报告回来的东西。

| `storeHealth.state` | 含义 | 界面上的说法 |
|---|---|---|
| `ok` | 凭据库**回答了** | 系统凭据库已就绪（实测） |
| `unavailable` | 本机**没有**可用的凭据库 | 本机系统凭据库不可用 |
| `failed` | 凭据库在，但**没有回答** | 系统凭据库调用失败 |

探针的调用有**时间上限**（`CREDENTIAL_PROBE_TIMEOUT_MS`）：一个卡住的凭据库
不能把安全页卡住。

### 5.4 凭据库**探测**不把密钥拉进 Bridge 的内存

状态面要回答「这一条还在不在」，不需要知道密钥**是什么**。因此 helper 有一个
`probe` 动作：它读凭据 blob 的**长度**，回答 `PRESENT` / `EMPTY`，**从不把密钥
读出来**。

这条约束的价值不在性能，在**边界**：仅仅因为有人打开了安全页，密钥**不应该**
进入 Bridge 的内存。**状态面走的就是 `probe`**——`status()` 与 `statusAll()`
都不调用 `read()`；`read()` 只在**真正要注入环境**时（`resolve()`）被调用。

| 探测的回答 | 状态 | 原因码 |
|---|---|---|
| `PRESENT` | `configured` | `CREDENTIAL_FOUND` |
| `EMPTY`（条目在，但没有字节） | `unavailable` | `CREDENTIAL_STORE_FAILED` |
| 条目不在 | `not-configured` | `CREDENTIAL_NOT_FOUND` |
| 其它失败 | `unavailable` | `CREDENTIAL_STORE_UNAVAILABLE` / `CREDENTIAL_STORE_FAILED` |

一个**没有** `probe` 的后端**测不出来**：状态是 `unavailable` +
`CREDENTIAL_STORE_FAILED`，而不是一个猜出来的答案。

三个后端的 `probe` 各自按**它自己的退出码**判定，不看输出文本：

- **Windows**：`CredReadW` 成功即 `PRESENT`，blob 长度为 0 即 `EMPTY`；
- **macOS**：`security find-generic-password`（不带 `-w`，因此**不索取**密钥）
  的**退出码**——0 是 `PRESENT`，44（`errSecItemNotFound`）是「条目不在」，
  其它是「工具失败」。属性输出里**没有** `password:` 这一行，所以按文本判定
  会把存在的条目误报成 `EMPTY`；
- **Linux**：`secret-tool search --all` 有输出即 `PRESENT`。

实测：`statusAll()` 走 3 条引用时，替身上 `backend.read()` 被调用 **0** 次、
`backend.probe()` 被调用 **3** 次（`tests/credential-reference-boundaries.test.mjs`
的 ATS213-R3-UT-001/002，变异体 M-P1 把它改回 `read()` 后该用例变红）。

### 5.5 界面上没有密钥明文

- 密钥输入框是 `type="password"`，存入后**清空**（`setKeySecret('')`）；
- 状态行只有名称、提供方、指纹、用途、状态、原因、时间；
- 实测（ST-ATS213-003）：页面正文里既没有完整密钥，**也没有它的前 8 个字符**。

---

## 6. 凭据引用（credential reference）

### 6.1 档案里写引用，运行启动时解析

一个环境档案的变量，其值可以是**引用**而不是明文：

```json
{ "API_TOKEN": { "credentialRef": "cred_0123456789abcdef01234567" } }
```

等价写法：`"API_TOKEN": "cred:0123456789abcdef01234567"`（也接受
`cred:cred_<24 hex>` 的完整形式）。

**凭据形状的变量名**（`*_TOKEN`、`*_PASSWORD`、`*_SECRET`、`*_API_KEY`……）
只允许携带**引用**。携带**明文**仍然被拒（`ENV_VARIABLE_NOT_ALLOWED`）——明文
进档案就是进运行资产、SQLite 镜像和证据归档。

### 6.2 解析发生在运行启动时，只发生一次

运行请求带上档案名时，平台：

1. 按**当前**白名单过滤档案的变量（ATS-212 的规则不变）；
2. 把**引用**逐条解析成密钥（`credentialStore.resolve()`）；
3. 把解析结果注入**封口的 runner 环境**（`buildRunnerEnv()`）；
4. 把**变量名**（不含值）记在运行记录上。

解析出来的密钥**只**出现在子进程的环境块里。档案里留着的永远是引用，
运行记录里只有名字。

**解析只在一个收口点发生。** 每一条运行路径——单次运行、批次里的第 2..N
次运行——都经过同一个函数（`server/index.mjs` 的 `prepareRunnerEnvironment()`），
它按顺序做四件事：**过滤 → 解析 → 校验 → 返回**。

批次的每一次运行**委托**给这个收口点（`batchRunEnv()` 只负责把档案找出来，
过滤、解析与校验都交给它），因此规则只有**一份实现**。全仓库的解析器调用点
**只有一个**——这是可机读校验的（ATS213-R3-UT-017 断言 `server/index.mjs` 里
`resolveCredentialRefs(` 的调用点恰好 1 处，ATS213-R3-UT-018 断言单次运行与
批次两条路径都**调用**该收口点）。

校验这一步是承重的：**进入环境块的每一个值都必须是字符串**。一条没有解析
成功的**引用**是**对象**，而 `String()` 把它变成 `"[object Object]"`——于是
运行**静默地**拿着一个假的 token 跑起来，测试跑完了，结果毫无意义，而且
**没有任何报错**。这比拒绝更坏，所以：

- 未解析的引用**被拒**：它**不**进环境块，变量名被报出来，运行**不启动**
  （`ENV_VALUE_NOT_RESOLVED`）；
- `buildRunnerEnv()` 本身也**拒绝**把引用字符串化——即使有调用方绕过上面的
  收口点（变异体 M-P2 把这一步改回 `String(value)` 后，用例变红）；
- `startRun()` **没有**回退分支：它只接受**已解析**的值，不再读档案自己的
  变量（ATS213-R3-UT-019 断言这条回退不存在，变异体 M-P5 把它加回来后
  用例变红）。

### 6.3 解析不了就**拒绝启动**

| 情况 | 原因码 | HTTP |
|---|---|---|
| 引用不存在 | `CREDENTIAL_REF_NOT_FOUND` | 404 |
| 凭据库不可达 | `CREDENTIAL_REF_STORE_UNAVAILABLE` | 404 |
| 读出来是空的 / 其它失败 | `CREDENTIAL_REF_RESOLVE_FAILED` | 404 |

拒绝响应带**变量名**与**引用 id**——两者都不是秘密。

在**缺少密钥**的情况下静默运行是更坏的形态：被测系统会拿到一个空的 token，
测试结果变得毫无意义，而没有人知道为什么。因此这条是**拒绝**，不是「警告后
继续」。

### 6.4 实测（真实 Playwright 运行 + 真实 Windows Credential Manager）

`11-credential-reference-st.log` 里的 `st-credential-ref.mjs` 走完整的一条：

```
PASS  REF-ST-001  the secret is stored in the OS credential store (only a reference comes back)
PASS  REF-ST-002  the environment profile accepts a credential reference
PASS  REF-ST-003  the profile stores the reference and never the secret
PASS  REF-ST-004  the run is accepted with a resolvable reference
PASS  REF-ST-005  the run reaches a terminal state
PASS  REF-ST-006  the runner received the secret (asserted by digest and length)
PASS  REF-ST-007  the evidence output carries the digest, never the secret
PASS  REF-ST-008  the run record names the variable and carries no value
PASS  REF-ST-009  the platform data directory holds no secret
PASS  REF-ST-010  the run folder holds no secret
```

被测脚本断言的是密钥的 **SHA-256 摘要**与**长度**，不是原文——因此证据日志里
也不会出现密钥。

### 6.5 注入的密钥在**落盘前**就被脱敏

上面那条实测有一个前提：被测脚本**只**断言摘要、**从不**打印密钥。真实的
测试不总是这样——被测脚本一次**普通的断言失败**就会把注入的值打印出来：

```
Received: "sk-live-xxxxxxxx"
```

引擎把这句话写进 `report.json`、`error-context.md`、HTML 报告的
`data/*.md` 与 trace；平台把它写进 `stdout.log`、运行记录、事件、清单、
证据归档、SQLite 镜像与 `state.json`。这些文件**都会跟着导出走**——验收
标准说的「导出/日志无敏感串」说的正是它们。

平台在运行启动时**知道**解析出来的值，因此它能在**落盘之前**把它替换掉。

| 落盘面 | 平台怎么处理 |
|---|---|
| `stdout.log`、运行记录、事件 | **流式**脱敏（见下） |
| `report.json`、`error-context.md`、`html/data/*.md` | 运行结束时**改写**文本文件 |
| HTML 报告**内嵌的 base64 zip** | 解码 → 脱敏每个成员 → 重新打包 → 重新编码 |
| `results/**/trace.zip` 的**文本**成员 | 解包 → 脱敏 → 重新打包 |
| `evidence-store/` 的内容寻址副本 | 它们是运行目录里那些**已脱敏**文件的硬链接 |
| `metadata.db`（SQLite 镜像）、`state.json` | 记录里没有明文（明文只在内存里） |

三条规则：

1. **掩码是固定的**（`***`），不是「密钥的前 N 个字符」——后者仍然是密钥
   的一部分。
2. **脱敏跨分块**。stdout 是**流**：一个密钥完全可能被切成两个 `data` 块，
   逐块替换会漏掉它。脱敏器因此保留一个**尾巴**，只在确认一段文本不再
   可能是密钥的前缀之后才把它放出去——**没有任何一个密钥能横跨这个边界**
   （`safePrefixLength()`）。
3. **二进制产物是边界**。trace 的 `test.trace`、截图、视频是引擎写的
   **二进制**，平台**改写不了**它们（改写会破坏归档的校验和与 trace 的
   内部结构）。这是**写在这里的边界**，不是「没被发现」。

**边界怎么被看见**：运行记录带 `envCredentialRefs`（本次运行携带过凭据
引用），脱敏发生过的文件与**改不掉的边界产物**记在 `run.redaction` 里：

```json
{
  "redaction": {
    "redactedFiles": ["file:stdout.log", "file:report.json", "zip:results/.../trace.zip", "file:html/index.html"],
    "boundaries": ["zip:results/.../trace.zip"],
    "secrets": 1
  }
}
```

**明文只在内存里**：解析出来的密钥记在一个**进程内**的映射里（`runSecrets`），
运行结束、脱敏做完之后立刻删除。它**不在**运行记录里——运行记录要写进
`state.json`、镜像进 SQLite、还要经 API 返回，放进去就是三处泄漏。

**实测**：真实 Bridge + 真实 Windows Credential Manager + 真实 Playwright
运行，被测脚本做一次普通的断言失败，结果是**数据目录 0 命中**
（`tests/credential-redaction-api.test.mjs` 的 ATS213-REDACT-IT-001）。
变异体 M-P3b 把落盘前的脱敏整个去掉，同一条用例**变红**。

---

## 7. API 面

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/security/credentials/status` | 全部凭据的状态（`{statuses, provider, available, storeHealth}`） |
| GET | `/api/security/credentials/:id/status` | 单条凭据的状态（`{status}`） |
| GET | `/api/security/contract` | 契约描述，含 `statuses` 与 `statusReasons` |
| POST | `/api/projects/:id/env` | 项目级环境档案；变量值可以是**凭据引用** |
| POST | `/api/projects/:id/run` | 运行；档案里的**引用**在此时解析，解析不了**拒绝启动** |

`available` 是**实测**的凭据库健康（`storeHealth.state === 'ok'`），不是「helper
脚本在不在」的推断（§5.3）。

状态面**不需要**新错误码：单条状态查询不存在时返回 **404 `CREDENTIAL_NOT_FOUND`**
（沿用 ATS-402 的映射）；状态**读不出来**时**不是**一个错误响应，而是
**200 + `status: 'unavailable'` + 原因码**——「取不到」是一个**事实**，不是
请求失败。

凭据**引用**的解析失败是**另一个**口径：那是一次请求的失败，因此是错误响应
（§6.3）。

---

## 8. 平台差异

| 平台 | 后端 | 状态 |
|---|---|---|
| Windows | Credential Manager（`server/security/wincred.ps1`，advapi32 `CredWriteW`/`CredReadW`） | **已实测**（本机 Windows 11） |
| macOS | Keychain（`security` 命令行工具，密钥走 stdin） | 代码已写，**未在真机实测** |
| Linux | Secret Service（`secret-tool`，密钥走 stdin） | 代码已写，**未在真机实测** |

三个后端走**同一个受控的子进程接口**，秘密只经 **stdin/stdout** 传递，
**不进 argv、不进日志**。因此状态面的语义在三个平台上是**同一套**——
但**只有 Windows 这一条有实测证据**，另两条的证据是「经注入的 `spawn`
被单元测试驱动过」，不是真机。

三个后端都实现了 `probe`（只回答「在不在」，不回答「是什么」），因此
「凭据库已就绪」这句话在三个平台上都是**实测**的。三个后端的 `probe` 各自
按**自己**的退出码判定（§5.4）：Windows 看 blob 长度、macOS 看
`security` 的退出码、Linux 看 `search` 的输出。

---

## 9. 证据

全部证据在 `docs/evidence/ATS-213/`，每份日志的**头部**写明 commit、
时间戳、命令与**退出码**。

| 日志 | 内容 |
|---|---|
| `01-credential-status-ut.log` | 状态契约的 17 例 UT |
| `02-credential-status-api-it.log` | 状态面的 9 例 IT（HTTP） |
| `03-credential-status-api-it-real-store.log` | 同一组 IT，对**真实 Windows Credential Manager** |
| `04-credential-reference-it.log` | 凭据引用的 5 例 IT（引用被接受 / 明文被拒 / 解析不了拒绝启动 / 记录无密钥） |
| `05-security-regression.log` | ATS-402 的安全用例（凭据存储不得回归） |
| `06-credential-boundary-probe.log` | 边界探针 9 项检查 + 2 项负控 |
| `07-next-build.log` | `tsc --noEmit` + Next.js 静态导出构建 |
| `08-system-test.log` | 真实浏览器里的 11 项 ST + 截图 + trace |
| `09-credential-reference-st.log` | 凭据引用的端到端 10 项（**真实 Playwright 运行** + 真实 Windows Credential Manager） |
| `10-status-failures-st.log` | 状态面的**失败路径** 10 项（真实浏览器） |
| `11-status-mutants.log` | **变异体**：修复改回缺陷后，同一支 ST 必须变红 |
| `12-credential-boundaries-ut.log` | 收口与脱敏的 19 例 UT（状态面不读明文 / 未解析的引用被拒 / 脱敏跨分块 / 内嵌 zip 被重建 / 收口点只有一个调用点） |
| `13-credential-redaction-it.log` | 落盘脱敏的 IT（真实凭据库 + 真实 Playwright 运行，断言失败后数据目录 0 命中） |
| `14-credential-redaction-mutants.log` | **变异体** 8 支：每一支都让对应的检查变红 |
| `15-quality-gates.log` | ATS-301 门禁（WBS 助手 + ADR 引用 + 端口审计） |
| `16-full-regression.log` | 全量回归（0 失败；跳过项逐条标注） |
| `17-wbs-row-and-checksums.log` | WBS 行与校验和清单 |
| `ui/` `ref/` `failures/` | 真实浏览器的截图与 trace |

证据目录另有一份 `README.md`，逐份写明每一步的**内容与复跑命令**，以及全量回归
里跳过项的**逐条原因**（skip 不是 PASS，也不是 FAIL）。

复现命令：

```bash
# 全部证据一次收集
bash tools/ats213-probes/collect-evidence.sh

# 单项
node --test tests/credential-status.test.mjs
node --test tests/credential-status-api.test.mjs
node --test tests/credential-reference-api.test.mjs
node tools/ats213-probes/probe-credential-boundary.mjs
node tools/ats213-probes/st-ats213.mjs docs/evidence/ATS-213/ui
node tools/ats213-probes/st-credential-ref.mjs docs/evidence/ATS-213/ref
node tools/ats213-probes/st-credential-status-failures.mjs docs/evidence/ATS-213/failures
node tools/ats213-probes/probe-credential-status-mutants.mjs
node --test tests/credential-reference-boundaries.test.mjs
ATS213_REAL_CREDENTIAL_STORE=1 node --test tests/credential-redaction-api.test.mjs
node tools/ats213-probes/probe-credential-redaction-mutants.mjs
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
