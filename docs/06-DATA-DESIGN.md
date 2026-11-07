# ATS-DS-001 数据設計書 / 数据字典

## 1. Git 是事实源，平台是运行索引

将定义资产与运行资产严格分离。定义：测试代码、测试数据结构、Req、Design、Test Scenario、expected result、tags、policy；由 Git 管理。运行：Run、Attempt、Event、Evidence、Defect candidate；由本地状态/附件管理。不在 SQLite 中复制一份独立脚本正文。

## 2. 当前物理模型（v0.1）

| 实体 | 主键/索引 | 字段 | 存储位置 |
|---|---|---|---|
| Project | `proj_1_<24 hex>` | id,uid,name,root,addedAt,legacyId | `state.json.projects` |
| Run | `run_1_<24 hex>` | id,uid,seq,projectId,projectUid,file,gitCommit,status,createdAt,startedAt,finishedAt,log,summary,eventSeq,artifacts,attempts | `state.json.runs` |
| Attempt | `att_1_<24 hex>` | uid,runUid,testUid,file,title,line,retry,status,caseStatus,duration,error | `state.json.runs[].attempts`、`runs/<run-uid>/manifest.json` |
| TestDefinition | `tc-*` / `tc_1_d_*` / `tcp_1_*` | uid,uidSource,uidStable,uidBasis,file,title,line,describePath,specIds,source,ambiguity? | 实时扫描（临时）；身份映射存于 `state.json.uidRegistry` |
| ProjectTrust | `proj_1_<24 hex>` | trust,reason,at | `state.json.trust` |
| Requirement | uid | uid,title,type,status | 原 Git `.aitest/requirements.json` |
| Link | from,to,type | from,to,type | 原 Git `.aitest/traceability.json` |
| ExecutionEvent | runId+seq | seq,at,type,data | `runs/<run-id>/events.jsonl` |
| Evidence | sha256 + file | file,size,sha256 | `runs/<run-id>/manifest.json` |

`TestDefinition` 的标识符规则、优先级与迁移方式见 `docs/18-UID-SPEC.md`。要点：用例的 UID 在**文件改名后保持不变**，**标题改写后在执行体未变时保持不变**（靠 UID 注册表找回原 UID）；同名用例一旦改了执行体，其 UID 随之改变（`describe` 路径不参与标题键，见 `docs/18-UID-SPEC.md` §7.1）；标题相同但执行体不同的两个用例得到不同 UID；两者都相同（无法唯一判定）时给出 `tcp_1_*` 临时标识并在 `ambiguity` 中报告候选，不做静默合并。显式标注 `@TC-xxx` 优先于注册表，重复的显式 UID 进入歧义报告。运行记录与用例的绑定以**本次执行的源码**为准：同一文件里标题相同的用例靠执行体指纹区分，算不出指纹时保持未绑定；注册表裁剪只针对「文件仍在本次发现范围内、但用例已消失」的条目，文件暂时缺席不会让用例丢掉 UID（见 `docs/18-UID-SPEC.md` §7.1）。

`state.json.uidRegistry` 记录 `{uid, uidSource, titleKey, bodyKey, file, title, aliases}`，是「改标题后仍能找回原 UID」的依据；它是**增量字段**，没有它的旧状态文件照常加载。
注册表按 uid 去重（同一 uid 只保留一条 entry，唯一性按不同的 uid 计数），并裁剪陈旧条目——被删除的用例会永远留下一个 uid，日后把它交给别的用例。裁剪只针对「文件仍在本次发现范围内、但用例已消失」的条目；文件本身不在本次发现中的条目保留，否则切换分支就会让用例丢掉 UID（详见 `docs/18-UID-SPEC.md` §3.2）。

**权威发现的增量字段（ATS-202）**：注册表条目另带 `scope`（`describe` 路径）与 `specIds`（CLI 报告的每个 Playwright project 的 spec id）。前者是动态用例的身份依据，后者让一次运行可以按 CLI 自己的标识符绑定用例，而不必靠标题猜测。权威发现的完整身份阶梯见 `docs/23-AUTHORITATIVE-DISCOVERY.md`。

**`state.json.trust`** 记录每个项目的信任状态 `{trust: 'trusted'|'untrusted', reason, at}`，按项目 UID 索引。它决定该项目的索引是否允许调用 `playwright test --list`——实测该命令会执行仓库代码（见 `docs/11-SECURITY-RISK.md` SEC-011）。这是**增量字段**，旧状态文件照常加载（旧项目即未可信）。

## 3. 目标逻辑 ER（P1/P2 规划，不属于 v0.1 数据表）

```mermaid
erDiagram
 PROJECT ||--o{ TEST_SCRIPT : owns
 REQUIREMENT ||--o{ REQUIREMENT_LINK : refers
 DESIGN_ELEMENT ||--o{ REQUIREMENT_LINK : satisfies
 TEST_CASE ||--o{ REQUIREMENT_LINK : verifies
 TEST_SCRIPT ||--o{ TEST_CASE : implements
 PROJECT ||--o{ RUN : has
 RUN ||--o{ TEST_ATTEMPT : contains
 TEST_ATTEMPT ||--o{ EXECUTION_EVENT : emits
 TEST_ATTEMPT ||--o{ EVIDENCE : attaches
 TEST_ATTEMPT ||--o{ DEFECT : detects
 DEFECT ||--o{ CHANGE : fixed_by
 CHANGE ||--o{ RUN : verified_by
 PROJECT { string uid PK string repo_url string git_ref }
 REQUIREMENT { string uid PK string title string revision }
 TEST_CASE { string uid PK string level string expected }
 TEST_SCRIPT { string uid PK string source_path string content_hash }
 RUN { string uid PK string git_sha string status string env_uid }
 TEST_ATTEMPT { string uid PK string test_case_uid string status int retry }
 EXECUTION_EVENT { string uid PK int seq string kind string payload }
 EVIDENCE { string uid PK string media_type string sha256 string local_uri }
}
```

## 4. 一致性规则

- `Run.id` 是稳定 UID `run_1_<24 hex>`，由「项目 UID + commit + 目标文件 + 项目内执行序号」派生，不是随机 UUID：同一组输入总是得到同一个 ID，可从记录字段重算。序号记录在 run 记录上并由持久计数器兜底，因此序号永不复用，每次重新执行得到新的 ID。旧格式 `run_<uuid>` 仍可读，迁移脚本负责改写（`docs/18-UID-SPEC.md` §5）。
- 本地 state 持久写入：`state.json.<pid>.tmp` → fsync → rename（改名是提交点）；JSONL append-only。同一数据目录同一时刻只有一个 Bridge 或迁移进程写入（`bridge.lock`），损坏的状态文件拒绝启动而不是被空状态覆盖，见 §5.7。
- 附件只允许相对 Run 路径；下载时 realpath 校验，禁止软连接越界。
- 归档 Manifest 包含 sha256；当前未签名，攻击者拥有本地文件写权限可同时修改文件和 manifest，因此不应宣称 WORM 或防篡改等级。
- Evidence 可能含 PII/Secret；生产版需要保留期、视觉脱敏、可审计删除和加密。

**证据清单与保留（ATS-209，v0.2.0 已实现）**：`runs/<run-uid>/manifest.json` 的格式为
`version 2`，除运行标识与 `artifacts[]`（每条含 `file`、`size`、`sha256`）外还有 `evidence`
段（`count`、`totalBytes`、`setDigest`、`truncated`）——`setDigest` 是整组证据的摘要，两份证据
集合相同的运行会得到同一个值。清单**不列出自己**，也不列出 `events.jsonl` 与 `stdout.log`：后者
是运行的记录，清理器只动证据、保留记录。清单与 run 记录的 `artifacts[]` 覆盖**同一个文件
集合**（同一个收集器、同一个上限）；上限触顶时 `truncated` 为真且**校验判失败**——没有覆盖
全部证据的清单不是可校验的清单。

摘要按文件**原始字节**计算，不做行尾归一化：忽略行尾差异的摘要检测不到「文件被改写成
另一种行尾」，而那正是证据文件必须能发现的改动。摘要包含大小，因此同名同摘要但大小不同的
文件不是同一份证据。

**去重**：证据字节按自己的 SHA-256 存进 `<data-dir>/evidence-store/`（内容寻址，两级扇出），
run 目录里的文件是指向该副本的**硬链接**——字节在磁盘上只有一份。硬链接提供的是空间与原子性，
**不是**防篡改：检测依赖的是**清单里的摘要**。硬链接带来的是**一次就地改写的影响面被放大**——
改写一个 run 的证据文件会同时改掉其他共享该 inode 的 run，那些 run 会被报为 `changed`（如实
报出，不是误报），因此 store 的副本**不是独立备份**。复用已有 blob 前**先校验其内容**，内容与
摘要不符就用正确的字节替换，避免一次篡改毁掉之后每一个产出相同内容的 run。跨卷、文件系统不
支持链接或超过体积上限时**不链接**，证据照常归档、照常可校验，原因记在 run 的 `dedupRefused`
上。`sharedBytes` 是「同一份内容若各存一份会占多少字节」，**不是**磁盘浪费——重复副本是硬链接，
磁盘实际占用由 `storeBytes` 给出。

**保留**：只有终态（passed/failed/cancelled/error/interrupted）的 run 才是待清理对象，年龄从
`finishedAt` 起算，默认保留期 30 天。清理**只删 run 目录里的证据文件**，`events.jsonl`、
`stdout.log` 与 `manifest.json` 保留，run 记录本身在 `state.json` 里因而完全不被触碰。清单里
指向 run 目录**之外**的条目被**拒绝并记录**（run 目录是 runner 的输出目录，`interrupted` 的 run
从不由 Bridge 写清单）。越界的判定按**解析后的真实路径**做：字面上在 run 目录里、但经由目录
链接（junction / 符号链接）指向外面的条目同样被拒绝，**链接与 junction 一律不跟随**；文件已不
存在时按最深的存在祖先解析，它仍然是「缺失」而不是「越界」。清理是**离线**操作：Bridge 持有
数据目录锁时拒绝执行（与迁移同一规则），否则会删掉正在产出证据的 run 的目录、而 Bridge 下一次
保存会把指向已删文件的状态写回。清理**同时回收 store 里无引用的副本**（证据可能含 PII，清理
不能只删一半），`--dry-run` 则什么都不删。清理日志（`evidence-retention-journal.jsonl`，仅追加）
承担「可审计删除」，且**只记实际删掉的文件**。清理器在 run 目录里留下 `evidence-cleaned.json`，
其删除记录**只增不减**，因此校验把被清理的缺失报为**「已按保留期清理」**而不是「不一致」——
否则每一次清理都会让篡改告警永久亮红。

完整设计见 `docs/27-EVIDENCE-MANIFEST.md`。

## 5. SQLite 元数据层（ATS-205，v0.2.0 已实现）

ATS-205 交付了 SQLite 元数据层。**当前实现是 `state.json` 的镜像**，不是第二份事实源：`state.json` 仍然是事实源，SQLite 库里存的是同一份状态的可查询行。

实现在 `server/sqlite/`：

| 文件 | 职责 |
|---|---|
| `server/sqlite/schema.mjs` | schema 定义与版本化迁移步骤（每步带 `up` 与 `down`） |
| `server/sqlite/db.mjs` | 打开数据库（WAL / busy_timeout / synchronous）、事务、迁移与降级 |
| `server/sqlite/store.mjs` | 把 Bridge 状态写成可查询的行，并读回 |
| `server/sqlite/import.mjs` | 从 `state.json` 导入与镜像校验 |
| `tools/sqlite_meta.mjs` | 命令行：`status` / `import` / `migrate` / `downgrade` / `verify` |

### 5.1 当前已部署的表（schema version 4）

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- schema_version 存放在这里
CREATE TABLE projects(id TEXT PRIMARY KEY, uid TEXT, name TEXT NOT NULL, root TEXT NOT NULL,
                      added_at TEXT, legacy_id TEXT, doc TEXT NOT NULL);
CREATE TABLE runs(id TEXT PRIMARY KEY, uid TEXT, seq INTEGER, project_id TEXT, project_uid TEXT,
                  status TEXT, created_at TEXT, finished_at TEXT, git_commit TEXT, doc TEXT NOT NULL);
CREATE TABLE uid_registry(project_uid TEXT NOT NULL, uid TEXT NOT NULL, file TEXT, title TEXT,
                          body_key TEXT, entry TEXT NOT NULL, PRIMARY KEY(project_uid, uid));
CREATE TABLE run_counters(project_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE artifacts(uid TEXT PRIMARY KEY, run_uid TEXT NOT NULL, attempt_uid TEXT,
                       file TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE TABLE test_attempts(uid TEXT PRIMARY KEY, run_uid TEXT NOT NULL, test_uid TEXT, retry INTEGER NOT NULL,
                           status TEXT NOT NULL, case_status TEXT, duration INTEGER, doc TEXT NOT NULL);
CREATE TABLE events(run_uid TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT, type TEXT NOT NULL,
                    data TEXT NOT NULL, PRIMARY KEY(run_uid, seq));   -- ATS-208
CREATE TABLE env_profiles(uid TEXT PRIMARY KEY, project_uid TEXT NOT NULL, name TEXT NOT NULL,
                          environment TEXT NOT NULL, variables TEXT NOT NULL, created_at TEXT,
                          updated_at TEXT, doc TEXT NOT NULL);          -- ATS-212
CREATE TABLE env_whitelists(project_uid TEXT PRIMARY KEY, names TEXT NOT NULL,
                            updated_at TEXT, doc TEXT NOT NULL);        -- ATS-212
```

`runs` 表在 migration 4 中**增列** `env_uid TEXT`（additive）：运行所处环境档案的标识。一个没有档案的旧运行该列是 NULL，运行记录照旧。

`env_profiles.variables` 列存的是变量**名**的 JSON 数组，**不是值**：索引列是查询要用的部分，也是从共享/导出数据库里读出来时安全的那部分。完整档案（含值）在 `doc` 列——那是档案自身的记录。

`env_whitelists` 只存**项目显式配置过**的白名单：没有行就表示「内置默认生效」，所以表里不复制一份可能与默认值脱节的默认清单。

每一张表都带一个 `doc`（或 `entry`）列，保存原始记录的 JSON 原文：**层没有建模的字段也不会丢失**，因此 JSON 状态文件与 SQLite 层不会对「一条记录包含什么」产生分歧。

`events` 的复合主键 `(run_uid, seq)` 就是事件的身份：序号是**按 run** 的，单独用 `seq` 会在同一项目的两次运行之间撞号。该主键同时**强制**了验收标准要求的性质——一个 run 不会有两条同序号的事件，所以序号永不复用、事件流不会有重复。

### 5.2 版本与迁移策略

- **schema 版本存放在数据库内部**（`meta` 表的 `schema_version` 键），不由外部文件推导，代码与文件无法各说各话。
- **升级只向前且只做增量**：一个步骤可以建表、加列、建索引或回填数据，但不删除后续版本仍在使用的列。
- **降级是显式的且有损**：`down` 可以删表删列，数据随之消失。降级**永不隐式发生**，只能是运维显式调用 `tools/sqlite_meta.mjs downgrade --to <version>` 或 `downgradeDatabase()`。
- **每个步骤在自己的事务里执行**，版本号与该步骤的对象写在同一个事务里；步骤失败则版本不动、对象不残留，重跑迁移即可重试。
- **版本在步骤的事务内重新读取**（不是事务外读一次）。两个并发迁移者因此不会把同一个步骤应用两遍：第二个等到写锁后重读到新版本，于是跳过该步骤。事务外读版本会让两个迁移者都去执行同一个非幂等步骤（如 `ADD COLUMN`），其中一个报 `duplicate column name`。
- **迁移器不接管外来对象**：若步骤要建的表已经存在但**形状不同**（缺列），该步骤被**拒绝**（`SCHEMA_OBJECT_CONFLICT`），而不是照单收下再在写数据时炸掉；若表已存在且**形状符合预期**，那就是这一步本来会建的表，步骤对它保持幂等。
- 比代码更新的数据库被**拒绝**（`SCHEMA_TOO_NEW`），而不是被静默降级。

#### 降级与回滚的运维流程

降级会丢数据，因此它是一个**需要停机的操作**，顺序是固定的：

1. **先停 Bridge**。运行中的 Bridge 每次 `saveState` 都会以 `migrate:true` 打开数据库，会把刚降下去的版本**立刻升回来**，降级等于没做。
2. **用较新版本的 CLI 执行降级**：`node tools/sqlite_meta.mjs downgrade --to <version>`。`--to` 必须是 `[0, latestVersion()]` 内的整数，否则退出码 2 且不碰数据库。
3. **再回滚程序**到与目标版本匹配的那一版。

**旧程序遇到更新的数据库会怎样**：它会以 `SCHEMA_TOO_NEW` 拒绝打开该库，而不是静默降级——这是刻意的，避免旧代码把新 schema 的数据写坏。在这一状态下 Bridge 的镜像会持续报错（但不影响 JSON 事实源），必须先把数据库降回旧程序认识的版本，或把程序升回去。

### 5.3 并发与一致性

- `journal_mode=WAL`：读者不阻塞写者，写者不阻塞读者。
- `busy_timeout`（默认 5000ms，可配置）：撞上写锁的写入者**等待**而不是立刻失败，两个并发写入者会串行化而不是丢掉其中一份。
- `synchronous=NORMAL`（WAL 下）：断电不会损坏数据库；WAL 不在每次提交时 fsync，断电可能让最后几次已提交的写入回滚，镜像在下一次启动保存时由 `state.json` 补齐（§5.7）。
- 事务用 `BEGIN IMMEDIATE` / `COMMIT`，抛错时 `ROLLBACK`；Bridge 的整份状态在**一个事务**内写入，读者看不到写了一半的状态。
- **镜像是可恢复的**：只有 `SQLITE_NOT_AVAILABLE`（本 Node 构建根本没有 `node:sqlite`）才让镜像在进程内永久停用；其余任何失败（锁冲突、磁盘满、杀软占用）都只是让**这一次**写入失败，**下一次 `saveState` 会重试**。因为镜像是整表替换，一次成功就等于全量追平，镜像会自愈。
- **镜像的阻塞上限是 1 秒**：镜像是同步跑在 Bridge 事件循环上的，它用**更短**的 `busy_timeout`（`MIRROR_BUSY_TIMEOUT_MS = 1000`，而不是层的默认 5000ms），否则一次锁冲突会把事件循环堵住 5 秒——实测 `GET /api/health` 等待 5274ms。超时后本次写入放弃，下次保存重试。**因此单次 `saveState` 最多阻塞事件循环 1 秒**。

### 5.4 执行模型：Run / Test / Attempt / ExecutionEvent（ATS-208，v0.2.0 已实现）

ATS-208 把执行模型的四个概念收敛到**一处**定义：`server/execution/model.mjs`。此前它们分散在四个地方、各说各话：`core.mjs` 解析报告的词汇、`index.mjs` 写事件的词汇、两个适配器各自的「通用模型」、以及 SQLite 层的列名。可测量的后果有两个：

- **重试的用例被计了两次，初次尝试被丢弃**。旧适配器把每次执行摊平成独立的「case」，于是「先失败后通过」的用例得到 `total: 2, passed: 0, flaky: 2`——初次尝试的 `failed` 状态和它自己的错误都消失了。
- **被崩溃打断的 run 的事件无法复演**。Bridge 死后把 run 标记为 `interrupted`，但事件流里只有 `run.queued` / `run.started`，复演得不到任何状态。

#### 5.4.1 三个层级，两个状态词表

| 层级 | 含义 | 状态词表 |
|---|---|---|
| Run | 一次执行的**生命周期** | `queued` / `running` / `cancelling` / `passed` / `failed` / `cancelled` / `error` / `interrupted` |
| Case | 一个**用例整体** | `passed` / `failed` / `skipped` / `flaky` / `unknown` |
| Attempt | 用例的**一次执行** | 同上（但描述的是这一次执行） |

Case 的状态是它**所有 attempt 的聚合**，规则是确定的（不是实现细节）：

1. 全部 skipped → `skipped`；
2. 全部 passed → `passed`；
3. 有 passed 也有 failed → `flaky`（重试救回来了）；
4. 全部 failed → `failed`；
5. 其余（含 `unknown`）→ `unknown`。

「先失败后通过」的用例是 **flaky 而不是 passed**：它需要过一次重试，只看 `passed` 的读者不会知道这一点。

**但计数用的是引擎的判定（OUTCOME），不是 attempt 的原始状态。**
只看原始状态会把 `test.fail()` 的**预期失败**算成 `failed` 用例，而
Playwright 自己的判定是 `expected`、引擎退出码是 0——summary 与退出码
自相矛盾。实测症状：一个 Playwright 判定为 `passed` 的 run，summary 报
`failed: 1`。

因此模型多了一个词表：

| 词表 | 含义 | 取值 |
|---|---|---|
| `status` | **发生了什么** | `passed` / `failed` / `skipped` / `flaky` / `unknown` |
| `outcome` | **是否符合声明** | `expected` / `unexpected` / `flaky` / `skipped` / `unknown` |

规则：

- 引擎声明了 `expectedStatus`（`test.fail()` 之后是 `failed`）时，这一次执行
  的 outcome 是 `expected`（行为符合声明）或 `unexpected`（不符合）；引擎没
  声明时 outcome 是 `unknown`——**不猜测**。
- Case 的 outcome 由它各 project 的 outcome 聚合：某个 project `unexpected`
  → `unexpected`；某个 project `flaky` → `flaky`；全部 `skipped` → `skipped`；
  否则 `expected`。
- **`expected` 是对列表里每一个 outcome 的断言**：列表里只要有一个 `unknown`，
  聚合结果就是 `unknown` 而不是 `expected`——那个「什么都没说」的 outcome 不能
  算作「符合声明」的证据。
- Case 的**状态**在 outcome 已知时由 outcome 决定：`expected` 且全部 attempt
  失败 → `passed`（预期失败是成功）；`unexpected` 且全部 attempt 通过 →
  `failed`（意外通过是缺陷）。outcome 为 `flaky` 时不覆盖状态——状态聚合
  本来就知道重试有没有救回来；outcome 为 `unknown` 时同样不覆盖状态。
- **Attempt 仍然保留自己的原始 `status` 和自己的错误**：预期失败的那一次
  执行确实失败了，这个事实不能因为它「符合预期」而消失。

引擎词表到通用词表的映射在模型里只有**一张表**（`mapEngineStatus`），Playwright 的 `expected`/`unexpected`/`flaky`/`skipped`/`timedOut` 与 WebdriverIO 的 `passed`/`failed`/`pending` 都从这里过。**未知的状态映射为 `unknown`，不做猜测**：报 `failed` 是凭空造一次失败，报 `passed` 是凭空造一次成功。

#### 5.4.2 「重试不覆盖初次尝试」

- 一个 spec 是**一个 case**；`results[]` 里的每一项是该 case 的**一个 attempt**。
- 计数器按 **case** 统计，执行次数单独记为 `executions`——重试过的用例仍然只算**一个**用例。
- **每一次 attempt 都被保留**，按顺序，各自带自己的状态、耗时和错误；初次尝试的 `failed` 和它自己的错误不会被重试覆盖。
- Case 报告的错误是它**第一次失败**的 attempt 的错误——读者要看的失败是最先发生的那次。
- 同一 case 的各 attempt 绑定到**同一个** TestDefinition UID（逐条绑定会让一个 flaky 用例的两个 attempt 落到两个 UID 上，历史就没法读了）。
- Case 跨多个 project 时，**引擎各 project 的判定**决定 Case 的状态：「在 project b 里失败」是 `failed`，「第一次失败、重试通过」是 `flaky`——两者的 attempt 分布看起来一样（有的失败有的通过），只有判定能区分。
- WDIO 的重试：实测 @wdio/reporter 10.1.0 每次尝试推一条**同名条目**，所以同一 suite 里**连续同名**的条目是同一个用例的多次 attempt，合并为一个 case；非同名的同标题用例仍是两个 case。**分组在第一个通过的条目处结束**：WDIO 的重试用例在第一次通过时就停，所以跟在一条通过条目之后的同名条目是**另一个**用例——把它们合并会藏掉一次真实的失败。**被跳过的条目同样结束分组**：被跳过的用例也不会被重试，跟在一条跳过条目之后的同名条目也是**另一个**用例。剩下的歧义（报告里的 `[failed, passed]` 无法与「失败后重试通过」区分）是**写明的边界**。

#### 5.4.3 「事件可按 run+sequence 复演」

事件流的性质：

1. **只追加**——事件永不重写；
2. **序号无空洞且严格递增**——一个 run 的序号是 1..N，中间没有洞，所以读者能分辨「run 到了第 7 个事件」和「第 7 个事件丢了」；
3. **可复演**——把事件按序号折叠起来，得到 run 当时的状态。

实现上：事件写在**状态变更之前**（`run.queued` 除外，它在 run 仍是 `queued` 时写下），所以每个事件记录的是 run **正在离开**的那个状态；于是事件流的最后一个事件就是决定终态的那个事件。状态机（`RUN_TRANSITIONS`）会**拒绝**不可能的迁移并把拒绝记到 stderr，而不是默默写下去——一条与状态机矛盾的事件流会让复演失去意义。

ATS-208 补上了缺失的 `run.interrupted` 事件：Bridge 崩溃时它写下这个事件，run 因此可复演为 `interrupted`。

**复演同时校验状态机**：`replayEvents` 按 `RUN_TRANSITIONS` 逐条检查事件流，
答案带 `valid` 与 `violations`。一条违反状态机的流（例如终态事件之后又追加了
`run.interrupted`）描述的是一个从未存在过的 run，因此**不得**报 `agrees: true`。

**复演同时校验序号**：一个 run 的序号是 1..N，序号从 1 起算。

- **丢失的序号**（`gaps`）：开头缺号同样是缺口——只丢了开头几个事件的日志不是
  完好的日志。
- **重复的序号**（`duplicates`）：两个事件带同一个序号。元数据层的主键
  `(run_uid, seq)` 会拒绝这样的一对，因此这样的流**不描述**一个 run：
  `valid` 为 false。
- **没有序号的事件**（`unsequenced`）：序号不是一个正整数的事件无法放进流里。

**恢复以持久日志为准**：

- 日志里已有终态事件时，采用该终态，**不追加任何事件**（终态事件之后追加
  事件会让事件流违反状态机）；
- 日志里没有终态事件、而 run 停在 `queued` / `running` / **`cancelling`** 时，
  写下 `run.interrupted` 并进入终态（`cancelling` 也在恢复集合里：Bridge 在
  停止过程中死亡，那个 run 永远到不了终态，会一直占住项目的运行锁）；
- 日志**缺失、不可读或尾行被撕裂**时降级：记录问题、run 仍恢复为终态、
  Bridge 照常启动。读取方逐行解析、跳过并**报告**无法解析的行，`/events` 与
  `/replay` 不再返回 500；写入方在文件不以换行结尾时先补一个换行。

事件写在三处，且由**同一个事件对象**写出，所以三者不会互相矛盾：

| 位置 | 作用 |
|---|---|
| `runs/<run>/events.jsonl` | 追加写的持久日志（既有） |
| `state.json` 的 `run.events` | 随 run 记录一起走，并被 SQLite 镜像索引（ATS-208 新增） |
| SQLite `events` 表 | 可按 `(run_uid, seq)` 查询（ATS-208 新增） |

旧 run 记录没有 `events` 数组，Bridge 启动时从自己的 `events.jsonl` 读回并对齐 `eventSeq` 计数器。

复演由 `GET /api/runs/:id/replay` 暴露：它返回复演出的状态、与 run 记录是否一致、序号中的空洞，以及 `valid` / `violations`（状态机校验结果）与日志的损坏报告（`unreadable` / `missing` / `truncated`）。

### 5.5 环境档案（ATS-212，v0.2.0 已实现）

环境档案是**项目级**的实体，住在状态里的 `state.envProfiles`：

```json
{
  "version": 1,
  "profiles": [
    {
      "uid": "env_1_3f2a...", "projectUid": "proj_1_aaaa", "name": "staging",
      "environment": "staging",
      "variables": {"BASE_URL": "https://staging.example", "TENANT": "acme"},
      "createdAt": "...", "updatedAt": "..."
    }
  ],
  "whitelists": { "proj_1_aaaa": ["BASE_URL", "TENANT"] }
}
```

| 事实 | 约束 |
|---|---|
| 归属 | `projectUid` 决定；档案在项目之间不可见 |
| 标识 | `uid` 由「项目 UID + NUL + 名称」派生，不是自增 |
| 唯一性 | 同一项目内名称唯一（不区分大小写）；替换时 `uid` 不变 |
| 层级 | `environment` ∈ {dev, staging, prod} |
| 值 | 只在 `variables` 里；**不进**运行元数据、manifest、API 响应、SQLite 索引列 |
| 白名单 | 按项目配置；未配置用内置默认；配置的是**替换**默认不是叠加 |

`whitelists` 映射只列**显式配置过**的项目：没有键就表示「内置默认生效」。这样状态里不会有一份可能与默认清单脱节的副本。

运行记录侧：`RUN` 表的 `env_uid` 指向档案；`run.envVariables` 只存变量**名**。运行引用不存在的档案会被拒绝（404），不会退化成「无档案」。

### 5.6 目标 schema（后续版本的迁移输入）

下面这份 DDL 是**后续版本**（P1）的迁移输入，**尚未部署**，不能当作已实现：

```sql
CREATE TABLE projects(uid TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL, added_at TEXT NOT NULL);
CREATE TABLE test_index(uid TEXT PRIMARY KEY, project_uid TEXT NOT NULL, source_path TEXT NOT NULL, title TEXT NOT NULL, content_sha TEXT NOT NULL, discovered_at TEXT NOT NULL);
CREATE TABLE runs(uid TEXT PRIMARY KEY, project_uid TEXT NOT NULL, git_sha TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE test_attempts(uid TEXT PRIMARY KEY, run_uid TEXT NOT NULL, test_uid TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, duration_ms INTEGER);
CREATE TABLE events(run_uid TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT, PRIMARY KEY(run_uid,seq));
CREATE TABLE artifacts(uid TEXT PRIMARY KEY, attempt_uid TEXT, run_uid TEXT NOT NULL, file TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL);
CREATE TABLE graph_links(from_uid TEXT NOT NULL, to_uid TEXT NOT NULL, kind TEXT NOT NULL, revision TEXT, PRIMARY KEY(from_uid,to_uid,kind));
CREATE INDEX idx_runs_project_created ON runs(project_uid,created_at DESC);
CREATE INDEX idx_attempt_run_status ON test_attempts(run_uid,status);
```

向这份目标 schema 迁移时，遵循上面 §5.2 的策略：**只向前、只做增量、降级显式**。

注意：目标 DDL 把 `projects` 的主键从 `id` 换成 `uid`，并给 `root` 加了 `UNIQUE` 约束。SQLite 无法用 `ALTER TABLE` 改主键或加唯一约束，这两处只能**重建表**（建新表 → 拷数据 → 删旧表 → 改名）。重建表会丢掉旧表上的索引，因此这类步骤**不是纯增量**的：它必须在一个步骤里完成重建与数据搬迁，并声明为显式的、可能需要停机的迁移步骤，而不是伪装成"只做增量"。

### 5.7 单实例与崩溃恢复（ATS-207，v0.2.0 已实现）

**数据目录单实例。** 同一个 `ATS_DATA_DIR` 同一时刻只有一个进程持有 `bridge.lock`：Bridge 持有它的整个生命周期，`tools/migrate_state.mjs` 与 `tools/migrate_uids.mjs` 持有整个迁移过程。

- **抢锁是原子的。**
  - 完整的锁记录 `{pid, startedAt, processStartedAt, token}` 先写入本进程私有的临时文件，再用硬链接发布为 `bridge.lock`。
  - 名字已存在时链接失败（`EEXIST`），所以同一时刻抢锁的多个进程恰有一个成功，锁文件也不会处于空的或半写的状态。
  - 没有硬链接的文件系统退化为独占创建（`wx`）。
- **陈旧锁可被接管。** 陈旧锁指持有者已死，或 pid 已被复用。
  - 接管时先把锁文件改名到只有本进程使用的名字，再比对字节。
  - 字节与判定为陈旧时的内容一致才删除。
  - 不一致说明期间有活进程发布了新锁：用不覆盖的方式放回，后来者视为锁已被占用。
  - 因此接管从不删除活持有者的锁。
- **占用时明确拒绝。**
  - 持锁者活着时，后来者得到 `BRIDGE_ALREADY_RUNNING`，附持有者的 pid 与启动时间，以及 `reason`：`held` 表示被占用；`contended` 表示锁在反复变化，重试 50 次后放弃。
  - Bridge 以退出码 1 拒绝启动，stderr 先给出检查步骤，再给出恢复步骤。
  - `ATS_LOCK_WAIT_MS` 让启动中的 Bridge 等待锁空出。默认 0，即立即拒绝。
  - 迁移 CLI 在 Bridge 运行时以退出码 3 拒绝（ATS-206）。
- **持有者可校验。**
  - 锁记录带每次取锁时随机生成的 `token`。
  - Bridge 每隔 `ATS_LOCK_VERIFY_MS`（默认 5000 ms，下限 50 ms）确认锁文件里仍是自己的 token：锁文件被删就重新取锁；被别的进程占用就停止（退出码 1），两个 Bridge 绝不共用一个数据目录。
  - 释放时只删除带自己 token 的锁。不带 token 的旧格式记录，按 pid 判定。

**state.json 持久写入。**

- 写入顺序：`state.json.<pid>.tmp` → `fsync` → 改名覆盖 `state.json` → 同步目录（仅 POSIX）。
- 改名是提交点，提交前数据已经落盘。写入方无论在哪一刻崩溃或断电，`state.json` 都是上一份或新一份完整内容。
- 临时文件按进程命名，两个写入方不会写进同一个临时文件。
- Windows 上改名遇到瞬时共享冲突（杀毒软件、索引服务）时，至多尝试 5 次。失败时删除临时文件，旧文件保持不变。
- 没有被改名的临时文件不是已提交的状态。持锁的 Bridge 启动时删除这类文件（`state.json.tmp`、`state.json.<pid>.tmp`），其它文件（如迁移备份 `state.json.bak`）不动。

**状态文件损坏时拒绝启动。**

- `state.json` 存在但不是 JSON（包括零长度文件）时，报 `STATE_CORRUPT`。
- 是 JSON 但不是 schema 1 状态时，报 `UNSUPPORTED_DATABASE`。
- 两种情况下 Bridge 都以退出码 1 拒绝启动，并给出恢复步骤：保留损坏文件副本，恢复最后一份完好的副本（存在时即迁移备份 `state.json.bak`）。
- 拒绝时不改写该文件，也不动临时文件和镜像。以空状态启动会在第一次保存时抹掉全部项目与运行历史。

**SQLite 镜像的 WAL 恢复。**

- Bridge 启动时先打开镜像。打开本身就是 SQLite 的崩溃恢复：WAL 中已提交的帧被应用，未提交的事务被丢弃。随后执行 `PRAGMA quick_check`。
- 镜像损坏（`quick_check` 报错，或打开时报 `SQLITE_CORRUPT` / `SQLITE_NOTADB`）时，`metadata.db` 连同仍然存在的 `-wal`、`-shm` 一起改名为 `metadata.db.corrupt-<时间戳>`。旧 WAL 因此不会被回放进新库。启动时的第一次保存从 `state.json` 重建镜像，损坏的副本保留以便检查。
- 其它无法检查的情况（schema 更新、被其它进程占用、路径不是文件）不移动文件，只在 stderr 报告。
- 镜像是派生数据，状态文件从不由镜像自动重建。

**运行中的 run 不会被判为已完成。** 崩溃后的 run 恢复由 §5.4（ATS-208）以事件日志驱动：日志中没有终态事件、仍停在 queued/running/cancelling 的 run，写入 `run.interrupted` 并进入 `interrupted`。ATS-207 的系统测试在真实 Chromium 运行进行中强杀整棵进程树并重启，验证了这一行为，同时验证了此前已完成的 run 结果完整保留。

**验证与边界。**

- 测试：
  - UT：`tests/instance-lock.test.mjs`（UT-LOCK-001..015、UT-DATA-001..005、UT-WAL-001..004）。
  - IT：`tests/instance-lock-it.test.mjs`（IT-LOCK-001..006、IT-DATA-001..002、IT-WAL-001..002）。
  - ST：`tools/ats207-probes/st-ats207.mjs`（ST-017、ST-025、ST-026）。
  - 竞态探针：`tools/ats207-probes/race-probe.mjs`。
- 断电用强杀进程模拟。强杀不会丢弃操作系统的页缓存，所以「改名前已 fsync」由 UT-DATA-002 直接断言调用顺序，而不是从强杀测试推出。真实掉电没有做过。
- `synchronous=NORMAL` 下 WAL 不在每次提交时 fsync。断电可能让镜像丢失最后几次已提交的写入，但不会损坏数据库；下一次启动时的保存会从 `state.json` 补齐。
- 桌面壳（`src-tauri/src/lib.rs`）丢弃 Bridge 的 stderr，也没有接入单实例插件。第二个桌面窗口启动的 Bridge 会被本机制拒绝，但桌面界面不显示「已占用」提示。这条桌面路径未实测（本机没有 Rust/Tauri 工具链）。
- 以上保证只在锁文件位于本地文件系统时成立。网络文件系统上的硬链接语义与进程存活判定不在验证范围内。
