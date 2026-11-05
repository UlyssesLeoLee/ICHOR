# ATS-DS-001 数据設計書 / 数据字典

## 1. Git 是事实源，平台是运行索引

将定义资产与运行资产严格分离。定义：测试代码、测试数据结构、Req、Design、Test Scenario、expected result、tags、policy；由 Git 管理。运行：Run、Attempt、Event、Evidence、Defect candidate；由本地状态/附件管理。不在 SQLite 中复制一份独立脚本正文。

## 2. 当前物理模型（v0.1）

| 实体 | 主键/索引 | 字段 | 存储位置 |
|---|---|---|---|
| Project | `proj_1_<24 hex>` | id,uid,name,root,addedAt,legacyId | `state.json.projects` |
| Run | `run_1_<24 hex>` | id,uid,seq,projectId,projectUid,file,gitCommit,status,createdAt,startedAt,finishedAt,log,summary,eventSeq,artifacts,attempts | `state.json.runs` |
| Attempt | `att_1_<24 hex>` | uid,runUid,testUid,file,title,line,retry,status,caseStatus,duration,error | `state.json.runs[].attempts`、`runs/<run-uid>/manifest.json` |
| TestDefinition | `tc-*` / `tc_1_d_*` / `tcp_1_*` | uid,uidSource,uidStable,file,title,line,source,ambiguity? | 实时扫描（临时）；身份映射存于 `state.json.uidRegistry` |
| Requirement | uid | uid,title,type,status | 原 Git `.aitest/requirements.json` |
| Link | from,to,type | from,to,type | 原 Git `.aitest/traceability.json` |
| ExecutionEvent | runId+seq | seq,at,type,data | `runs/<run-id>/events.jsonl` |
| Evidence | sha256 + file | file,size,sha256 | `runs/<run-id>/manifest.json` |

`TestDefinition` 的标识符规则、优先级与迁移方式见 `docs/18-UID-SPEC.md`。要点：用例的 UID 在**文件改名后保持不变**，**标题改写后在执行体未变时保持不变**（靠 UID 注册表找回原 UID）；同名用例一旦改了执行体，其 UID 随之改变（`describe` 路径不参与标题键，见 `docs/18-UID-SPEC.md` §7.1）；标题相同但执行体不同的两个用例得到不同 UID；两者都相同（无法唯一判定）时给出 `tcp_1_*` 临时标识并在 `ambiguity` 中报告候选，不做静默合并。显式标注 `@TC-xxx` 优先于注册表，重复的显式 UID 进入歧义报告。运行记录与用例的绑定以**本次执行的源码**为准：同一文件里标题相同的用例靠执行体指纹区分，算不出指纹时保持未绑定；注册表裁剪只针对「文件仍在本次发现范围内、但用例已消失」的条目，文件暂时缺席不会让用例丢掉 UID（见 `docs/18-UID-SPEC.md` §7.1）。

`state.json.uidRegistry` 记录 `{uid, uidSource, titleKey, bodyKey, file, title, aliases}`，是「改标题后仍能找回原 UID」的依据；它是**增量字段**，没有它的旧状态文件照常加载。
注册表按 uid 去重（同一 uid 只保留一条 entry，唯一性按不同的 uid 计数），并裁剪陈旧条目——被删除的用例会永远留下一个 uid，日后把它交给别的用例。裁剪只针对「文件仍在本次发现范围内、但用例已消失」的条目；文件本身不在本次发现中的条目保留，否则切换分支就会让用例丢掉 UID（详见 `docs/18-UID-SPEC.md` §3.2）。

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
- 本地 state 原子 `state.json.tmp → rename`；JSONL append-only。跨进程写入和断电一致性在 P1 SQLite WAL 改造后强化。
- 附件只允许相对 Run 路径；下载时 realpath 校验，禁止软连接越界。
- 归档 Manifest 包含 sha256；当前未签名，攻击者拥有本地文件写权限可同时修改文件和 manifest，因此不应宣称 WORM 或防篡改等级。
- Evidence 可能含 PII/Secret；生产版需要保留期、视觉脱敏、可审计删除和加密。

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

### 5.1 当前已部署的表（schema version 2）

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
```

每一张表都带一个 `doc`（或 `entry`）列，保存原始记录的 JSON 原文：**层没有建模的字段也不会丢失**，因此 JSON 状态文件与 SQLite 层不会对「一条记录包含什么」产生分歧。

### 5.2 版本与迁移策略

- **schema 版本存放在数据库内部**（`meta` 表的 `schema_version` 键），不由外部文件推导，代码与文件无法各说各话。
- **升级只向前且只做增量**：一个步骤可以建表、加列、建索引或回填数据，但不删除后续版本仍在使用的列。
- **降级是显式的且有损**：`down` 可以删表删列，数据随之消失。降级**永不隐式发生**，只能是运维显式调用 `tools/sqlite_meta.mjs downgrade --to <version>` 或 `downgradeDatabase()`。
- **每个步骤在自己的事务里执行**，版本号与该步骤的对象写在同一个事务里；步骤失败则版本不动、对象不残留，重跑迁移即可重试。
- 比代码更新的数据库被**拒绝**（`SCHEMA_TOO_NEW`），而不是被静默降级。

### 5.3 并发与一致性

- `journal_mode=WAL`：读者不阻塞写者，写者不阻塞读者。
- `busy_timeout`（默认 5000ms，可配置）：撞上写锁的写入者**等待**而不是立刻失败，两个并发写入者会串行化而不是丢掉其中一份。
- `synchronous=NORMAL`（WAL 下）：已提交的事务不会因为断电丢失。
- 事务用 `BEGIN IMMEDIATE` / `COMMIT`，抛错时 `ROLLBACK`；Bridge 的整份状态在**一个事务**内写入，读者看不到写了一半的状态。

### 5.4 目标 schema（后续版本的迁移输入）

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
