# ATS-206 — JSON state 安全导入迁移、备份与回滚

> 交付物：**数据迁移 CLI**。验收标准：**v0.1 旧数据迁移后项目/历史数量一致；失败可还原**。
> 关联要件：NFR-008（恢复能力）、NFR-010（可靠性：数据库原子写入；避免操作时半写入）。
> 前置依赖：ATS-205（SQLite 元数据层）。状态：待审核。

---

## 1. 范围

ATS-206 交付**一个数据迁移 CLI**（`tools/migrate_state.mjs`）与它背后的迁移内核
（`server/migration/`），把 v0.1 的 `state.json` 迁移到当前方案，并保证两件事：

1. **迁移后项目/历史数量一致** —— 迁移不得丢项目、不得丢历史、不得丢用例登记、
   不得丢重试与产物；
2. **失败可还原** —— 迁移失败时数据目录回到迁移前的状态，且备份与回滚可用。

交付物同时覆盖两件此前无人负责的事：

* **安全导入**：`state.json` → SQLite 元数据层的导入必须是**可验证的**
  （镜像必须与状态一致才允许落库）；
* **备份与回滚**：迁移前必写备份，失败自动回滚，显式回滚命令可用。

## 2. 背景：一次迁移为什么会丢数据

迁移 v0.1 状态本质上是**重写标识符**：

| 旧 | 新 |
| --- | --- |
| `proj_<uuid>` | `proj_1_<24 hex>`（由项目根路径派生） |
| `run_<uuid>` | `run_1_<24 hex>`（由项目 UID + commit + 目标文件 + 序号派生） |

重写标识符有两种典型的丢数据方式：

* **丢字段**：迁移结果由一组**固定键**重建，迁移器不认识的键就被丢掉了。
* **丢可达性**：某张表以项目标识符为**键**。改了项目标识符却不改键，
  这张表**没有丢**，它只是**够不着了** —— 用新 UID 查会得到空。

第 2 种更隐蔽：文件照样能解析，Bridge 照样起得来，数据只是"不见了"。

### 2.1 实测确认的两处存量缺陷（ATS-201 的 `tools/migrate_uids.mjs`）

在实现前先做了复现探针（`docs/evidence/ATS-206/`），实测确认 ATS-201 的
迁移实现有两处数据丢失：

**缺陷 A：`trust` 映射被整块丢弃。** ATS-201 的 `planMigration` 用固定键重建
`nextState`，`trust` 不在其中（ATS-202 引入的信任闸门）：

```
newProjectUid      : proj_1_f44fd2bf5f0a074f897c0b52
trust in output    : <<ABSENT>>          ← 整个信任映射消失
```

后果：用户显式"背书"过的项目，在迁移后变回**未信任**，
权威发现对它永久回退到静态索引。

**缺陷 B：UID 登记表没有跟着改键，条目变得不可达。**

```
registry keys      : ["proj_11111111-1111-1111-1111-111111111111"]   ← 旧键
registry under new : <<NOT FOUND>>      ← 新 UID 下查不到
registry entries   : 0
```

后果：每个测试用例的稳定 UID 丢失，全部被重新分配 —— 已归档的运行证据与
用例关联断裂。

两处缺陷都不是"迁移失败"，而是"迁移成功但数据没了"。

## 3. 设计

### 3.1 内核分层

```
server/migration/state-migration.mjs   纯函数：算迁移计划、计数、原子写
server/migration/apply.mjs             应用引擎：备份 → 写入 → 日志 → 失败自动回滚
tools/migrate_state.mjs                CLI：plan / apply / verify / rollback
tools/migrate_uids.mjs                 ATS-201 的工具，改为复用同一内核
```

**只有一个迁移实现。** ATS-201 的工具与 ATS-206 的 CLI 共用
`server/migration/state-migration.mjs`，两者不可能各自漂移 —— 这是修复上述
两处缺陷的前提：如果只在新工具里修好，旧的工具仍会丢数据。

### 3.2 迁移内核的两条规则

**规则一：不丢字段。** 迁移结果从**原状态的副本**开始，
内核显式改写的只有标识符、引用和以项目标识符为键的映射，
其余键**原样带过去**。未知的字段（未来的字段、插件加的字段）随迁移存活。

**规则二：以项目标识符为键的映射必须改键。** 目前有两张：

* `state.trust` —— 信任闸门（ATS-202），键是项目 UID；
* `state.uidRegistry.projects` —— 用例登记表（ATS-201），键是项目 UID。

改键规则（`rekeyProjectMap`）：

1. **非旧标识符的键原地保留** —— 它们已经是当前标识符；
2. **旧标识符的键迁到新名字**；
3. **新名字下已有值时，旧值不覆盖它** —— 当前值是较新的决定，
   用旧值覆盖等于撤销一个更晚的决定。

### 3.3 应用引擎：备份 → 写入 → 日志 → 回滚

一次迁移动的是**四份**状态：`state.json`、磁盘上的运行目录、SQLite 镜像库、
持久化的运行计数器。半途失败会留下互相矛盾的状态，
而**矛盾的状态比没迁移的状态更糟** —— Bridge 照常启动，照常读写。

因此引擎的顺序是：

1. **先算后写**：迁移计划与计数校验都在**第一次破坏性写入之前**完成；
2. **先备份后写**：每个将被覆盖的文件先复制成 `.bak`；
3. **写日志**：每一步成功后记进 `MigrationJournal`；
4. **失败自动回滚**：按**日志**（不是重算计划）逐步撤销已完成的步骤。

> 回滚由**日志**驱动而不是重算计划，是刻意的：重算会把本次运行**没做**的
> 事情也撤销掉（例如已经回滚过一次的那批目录），回滚于是变成第二次数据丢失。

写库这一步额外严格：镜像先写进临时库 `metadata.db.importing`，
**校验通过后**才替换正式库。校验不过的镜像**永远不会**被换上，
所以一次失败的导入不可能留下一个错误的镜像。

### 3.4 计数一致性怎么判定

验收标准是"项目/历史数量一致"。计数口径（`summarizeState`）：

| 计数 | 含义 |
| --- | --- |
| `projects` | 项目数 |
| `runs` | 运行记录数（历史） |
| `attempts` | 用例重试记录数 |
| `artifacts` | 产物记录数 |
| `registryEntries` | 用例登记条目数 |

迁移前后各算一次，逐项比对（`compareCounts`），不一致即**拒绝迁移**。
计数在**写入之前**算，因此拒绝不会留下任何痕迹。

### 3.4.1 项目 UID 撞车：迁移表示不了的状态必须直接拒绝

两个项目共用同一个 `root` 时，会导出**同一个项目 UID**。第二个会覆盖第一个：
它的用例登记条目、信任记录和计数器全部消失。计数比对能发现"条目数少了"，
但那已经是损失发生**之后**；而且丢的是哪一个项目的条目，从计数上看不出来。

所以撞车在**改键之前**就被拒绝，错误码 `PROJECT_UID_COLLISION`，并且
**点名两个项目**（`name`）与撞车的 UID：

```
the migration is refused: PROJECT_UID_COLLISION: the projects "app" and
"app-clone" both map to proj_1_c77e43e0a9c125f3ba9daf1e (the same root ...)
```

拒绝时状态文件逐字节未变。

### 3.5 CLI

```
node tools/migrate_state.mjs plan     [--data-dir <dir>] [--state <path>]
node tools/migrate_state.mjs apply    [--data-dir <dir>] [--state <path>] [--import-db] [--no-rollback]
node tools/migrate_state.mjs verify   [--data-dir <dir>] [--state <path>]
node tools/migrate_state.mjs rollback [--data-dir <dir>] [--state <path>]
```

* `plan` —— 只报告，不写；
* `apply` —— 迁移；先写备份；失败自动回滚（`--no-rollback` 可关闭）；
* `verify` —— 校验 SQLite 镜像与状态文件是否一致；
* `rollback` —— 显式回滚：从备份恢复状态文件与数据库，并把运行目录改回旧名。

退出码：`0` 成功 / `1` 失败 / `2` 用法错误 / `3` Bridge 正在运行（拒绝迁移）。

**Bridge 运行中必须拒绝迁移。** Bridge 在内存里持有状态并在每次变更时写回，
迁移会被它的下一次写覆盖，而磁盘上的运行目录已经是新名字 ——
结果是状态指向不存在的目录。

### 3.6 与 SQLite 元数据层的关系

`state.json` 仍是**唯一事实源**，SQLite 是它的**镜像**（ATS-205 的定位不变）。
`--import-db` 让迁移同时刷新镜像；不传该参数时迁移只动 JSON 与运行目录。

## 4. 已知边界

* **降级**不在本项范围：SQLite 的 down 脚本是显式有损操作（ATS-205 已定义），
  ATS-206 不为它提供自动回滚。
* **ATS-207**（单实例锁与 WAL 恢复）负责进程级的独占与断电恢复；
  ATS-206 只做**迁移过程**本身的原子性与可还原性。
* 跨**文件系统**的原子写不成立：备份与状态文件在同一个数据目录内，
  替换用 `rename`（同目录，原子）。跨卷不是本项支持的场景。
* 迁移是**离线**操作：必须先停 Bridge（CLI 会检查 `bridge.lock` 并拒绝）。

## 5. 证据

`docs/evidence/ATS-206/`（采集脚本 `tools/ats206-probes/collect-evidence.sh`）：

| 证据 | 内容 |
| --- | --- |
| `01-defect-repro.log` | 两处存量缺陷的复现（迁移前） |
| `02-defect-fixed.log` | 修复后同一探针的输出 |
| `03-migrate-state-ut.log` | ATS-206 用例集 |
| `04-migrate-regressions.log` | ATS-201 存量用例回归 |
| `05-node-test-full.log` | 全量回归 |
| `06-cli-roundtrip.log` | CLI 的 plan/apply/verify/rollback 实跑 |
| `07-coverage.log` | 新增模块的行覆盖率 |
| `08-wbs-row.log` | WBS 行同步 |
