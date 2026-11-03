# ATS-DS-001 数据設計書 / 数据字典

## 1. Git 是事实源，平台是运行索引

将定义资产与运行资产严格分离。定义：测试代码、测试数据结构、Req、Design、Test Scenario、expected result、tags、policy；由 Git 管理。运行：Run、Attempt、Event、Evidence、Defect candidate；由本地状态/附件管理。不在 SQLite 中复制一份独立脚本正文。

## 2. 当前物理模型（v0.1）

| 实体 | 主键/索引 | 字段 | 存储位置 |
|---|---|---|---|
| Project | id UUID | id,name,root,addedAt | `state.json.projects` |
| Run | id UUID | projectId,file,gitCommit,status,createdAt,startedAt,finishedAt,log,summary,eventSeq,artifacts | `state.json.runs` |
| TestDefinition | 摘要 ID | `id=sha256(projectId:file:title)[0:16]`, file,title,line,source | 实时扫描（临时） |
| Requirement | uid | uid,title,type,status | 原 Git `.aitest/requirements.json` |
| Link | from,to,type | from,to,type | 原 Git `.aitest/traceability.json` |
| ExecutionEvent | runId+seq | seq,at,type,data | `runs/<run-id>/events.jsonl` |
| Evidence | sha256 + file | file,size,sha256 | `runs/<run-id>/manifest.json` |

`TestDefinition.id` 在文件重命名或测试标题变化时改变；不能把此临时 ID 用于长久的需求关联。生产版必须引入稳定 UID，建议显式 `@TC-xxx` 或测试旁 manifest 管理。

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

- 单个 `Run.id` 全局 UUID，不复用旧 Run；每次重新执行创建新 ID。
- 本地 state 原子 `state.json.tmp → rename`；JSONL append-only。跨进程写入和断电一致性在 P1 SQLite WAL 改造后强化。
- 附件只允许相对 Run 路径；下载时 realpath 校验，禁止软连接越界。
- 归档 Manifest 包含 sha256；当前未签名，攻击者拥有本地文件写权限可同时修改文件和 manifest，因此不应宣称 WORM 或防篡改等级。
- Evidence 可能含 PII/Secret；生产版需要保留期、视觉脱敏、可审计删除和加密。

## 5. 目标 SQLite schema（设计草案）

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

这份 DDL 仅作未来迁移输入，并未在 v0.1 实际部署。
