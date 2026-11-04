# ATS-UID-001 稳定 UID 规范（v1）

- 对象：Project / TestDefinition / Run / Attempt 四类领域实体的标识符
- 目标版本：v0.2.0（S2 / WBS ATS-201）
- 实现：`server/uid.mjs`（纯函数，无 IO）、`server/core.mjs`（发现与归档）、`server/index.mjs`（API 面）
- 迁移脚本：`tools/migrate_uids.mjs`
- 状态口径：本文件描述**已实现且有 UT 证据**的能力。依赖 Playwright 权威发现的动态/参数化用例识别（FR-021）由 ATS-202 承接，**本文件不宣称已实现**。

## 1. 为什么需要稳定 UID

v0.1 的测试索引 ID 是 `sha256(projectId:file:title)[0:16]`。这个 ID 在两种最常见的改动下都会变：

| 改动 | 后果 |
|---|---|
| 文件改名（`login.spec.ts` → `auth/login.spec.ts`） | ID 变，需求关联断裂 |
| 标题改写（`登录正常` → `登录流程正常`） | ID 变，需求关联断裂 |

而**重复标题**是另一个方向的问题：同一文件里有两个 `test('should work')` 时，按标题派生的键会撞车，
必须能区分它们。

因此 UID 规范要同时满足三件事：

1. **跨改名不变**——用例搬了文件仍是同一个用例；
2. **跨改标题不变**——用例改了标题仍是同一个用例（前提是执行体没变）；
3. **重复标题可区分**——标题相同但执行体不同的两个用例必须得到不同的 UID，
   且无法区分时（标题与执行体都相同）必须**显式报告歧义**，而不是悄悄合并。

## 2. UID 字符串格式

```
<kind>_<version>_<payload>
```

| 实体 | 格式 | 长度 | 来源 |
|---|---|---|---|
| Project | `proj_1_<24 hex>` | 34 | `sha256(canonicalRoot)[0:24]` |
| TestDefinition（显式） | `tc-<token>` | 3–51 | 作者在标题里标注 `@TC-<token>` |
| TestDefinition（派生） | `tc_1_d_<16 hex>` | 22 | `sha256(projectUid ␀ basisKey)[0:16]` |
| TestDefinition（临时） | `tcp_1_<16 hex>_<n>` | 22–25 | 无法唯一判定时的占位值，**不保证稳定** |
| Run | `run_1_<24 hex>` | 32 | `sha256(projectUid ␀ commit ␀ target ␀ seq)[0:24]` |
| Attempt | `att_1_<24 hex>` | 32 | `sha256(runUid ␀ testUid ␀ retry)[0:24]` |

`␀` 是 U+0000，作为分隔符：它不可能出现在路径、标题或哈希里，因此不同字段的拼接不会产生歧义。

版本号 `1` 写在标识符里。规则变更时递增版本，旧标识符仍然可读、可解析、可比对——
**这正是「规则可迁移」的技术前提**。

### 2.1 旧标识符的共存

v0.1 写下的 `proj_<uuid>` / `run_<uuid>` 仍然被接受：

- `server/index.mjs` 的路由同时匹配 `proj_[0-9a-f-]{36}` 与 `proj_1_[0-9a-f]{24}`；
- `server/core.mjs` 的 `runDir()` 同时接受两种格式；
- `server/uid.mjs` 导出 `isLegacyProjectUid()` / `isLegacyRunUid()` 供迁移脚本判别。

因此升级不需要停机，也不需要用户手工改 `state.json`。

## 3. 各实体的派生规则

### 3.1 Project

派生输入是**规范化后的项目根目录**：

```
seed = realpath(root)
seed = seed.replace(/\\/g, '/')            // 分隔符归一
seed = seed.replace(/\/+$/, '')             // 去掉尾部分隔符
seed = win32|darwin ? seed.toLowerCase() : seed   // 大小写不敏感文件系统上折叠大小写
uid  = "proj_1_" + sha256(seed)[0:24]
```

**刻意不包含**项目名与 Git remote：项目名会改，remote 会换。只有根目录是这条链路上真正稳定的锚点。
派生输入全部记录在 `state.json` 里，因此迁移脚本不需要访问被测仓库就能重算出 Project UID。

### 3.2 TestDefinition

判定按以下优先级逐级降级，**先命中者生效**：

| 优先级 | 条件 | UID 来源 | `uidSource` | 是否稳定 |
|---|---|---|---|---|
| 1 | 标题含 `@TC-<token>` | 显式 token | `explicit` | 是 |
| 2 | 注册表中有**唯一**条目且执行体指纹相同 | 注册表中的 UID | `registry` | 是 |
| 3 | 标题键在项目内唯一 | `deriveTestUid(projectUid, titleKey)` | `derived` | 是 |
| 4 | 执行体指纹在项目内唯一 | `deriveTestUid(projectUid, bodyKey)` | `derived-body` | 是 |
| 5 | 以上都不成立 | `provisionalTestUid()` | `provisional` | **否** |

**标题键**（`normalizeTitleKey`）：NFKC 归一 → 去掉 `@TC-` 标注 → 折叠空白 → 转小写。
去掉标注是关键：给用例补上 `@TC-001` 不应改变它的派生键。

**执行体指纹**（`bodyKeyOf`）：取 `test()` 第二个参数（回调体）文本，折叠空白后 `sha256`。
提取由 `server/uid.mjs` 的 `extractCallbackBody()` 完成，它是一个**受限的 JS 词法扫描器**：
识别字符串、模板字符串（含 `${}` 嵌套）、正则字面量、行注释与块注释，
因此 `await expect(x).toHaveText('a,b,c')` 里的逗号不会把参数切断。

**注册表**（`state.json` 的 `uidRegistry`）记录 `{uid, uidSource, titleKey, bodyKey, file, title, aliases}`。
它让「改名 + 改标题」之后仍能找回原 UID：规则 2 命中时，旧 UID 被复用，
旧的 (file, title) 组合进入 `aliases`。

**歧义**：规则 5 触发时，用例得到 `tcp_1_...` 占位 UID，并在 `ambiguity` 字段中报告
`reason`（`identical-title` 或 `identical-title-and-body`）与全部候选。
发现接口的 `warning` 会追加「N 个用例的 UID 为临时值」的提示。
**歧义不被静默吞掉，也不被静默合并**——合并两个不同用例比报错更糟。

### 3.3 Run

```
uid = "run_1_" + sha256(projectUid ␀ gitCommit ␀ targetKey ␀ seq)[0:24]
```

`targetKey` 是相对文件路径（分隔符归一），全量运行为 `*`。

`seq` 是**项目内的执行序号**，它是「同一目标、同一 commit、连续执行两次」的区分符。
序号必须**记录在 run 记录上**（`run.seq`），否则历史被裁剪后同一个序号会被复用，UID 随之撞车。
`server/uid.mjs` 的 `assignRunSeqs()` 为**没有**记录序号的旧 run（按时间顺序）补序号，
`nextRunSeq()` 依据历史与 `state.json` 里的 `runCounters` 取下一个可用序号。

### 3.4 Attempt

一个 Attempt 是「一个 Run 中某个用例的一次执行」；重试的用例每个 retry 产生一个 Attempt。

```
uid = "att_1_" + sha256(runUid ␀ testUid ␀ retry ␀ occurrence)[0:24]
```

`occurrence` 是该用例在报告中的出现序号：同一个文件、同一个标题、同一个行号的用例
在报告里可能出现多次（参数化、动态生成），序号让它们各自持有不同的标识符。

`testUid` 取自 UID 注册表；用例不在注册表里时（例如运行的是项目里未被静态发现的用例），
退化为 `file ␀ title` 作为回退键——**Attempt 仍然有稳定标识，但不再绑定到 TestDefinition UID**，
这一情形在 `testUid` 字段上体现为 `null`。

**报告路径与注册表路径的拼写必须先归一**。Playwright 报告里的 `spec.file` 相对于它自己的
`rootDir`（由 `testDir` 推导），而注册表里的 `file` 相对于**项目根目录**：
`examples/sample-playwright` 这类 `testDir: './tests'` 的项目，报告写 `home.spec.ts`，
注册表写 `tests/home.spec.ts`。`server/uid.mjs` 的 `normalizeTestPath()` 用报告里的
`config.rootDir` 与项目根目录把两种写法归一到同一个键，归一后才做查找。

**行号同理**：静态扫描给出的行号是 `test(` 调用所在行，与 Playwright 报告的行号一致；
扫描器必须以 `test(` 的位置计行，而不是以其前导空白的位置计行。

Attempt 记录写入 `state.json` 的 run 记录里，并进入 `runs/<run-uid>/manifest.json` 的 `attempts` 数组。

## 4. 同一逻辑用例的判定

`server/uid.mjs` 的 `compareIdentities(a, b)` 给出显式判定：

| 条件 | `same` | `basis` |
|---|---|---|
| 两侧都有显式 UID 且相同 | `true` | `explicit-uid` |
| 两侧都有显式 UID 但不同 | `false` | `different-explicit-uid` |
| 执行体指纹相同 | `true` | `body-key` |
| 标题键相同但执行体不同 | `false` | `same-title-different-body` |
| 其余 | `false` | `different` |

**标题相同不构成同一用例**，除非执行体也相同。这条规则直接对应验收标准
「跨改名和重复标题可判同一逻辑用例」。

## 5. 迁移

### 5.1 迁移脚本

```bash
node tools/migrate_uids.mjs --state <path to state.json> [--dry-run] [--backup]
```

`--state` 缺省取 `$ATS_DATA_DIR/state.json`，未设置时取 `~/.ai-test-studio/state.json`。

脚本做四件事：

1. **Project**：`id` 重写为 `proj_1_<24 hex>`；
2. **Run**：`id` 重写为 `run_1_<24 hex>`，并补上 `seq`；
3. **引用**：`run.projectId` 改写为新的 Project 标识符。**这一步不可省略**——Bridge 按
   `run.projectId === project.id` 查运行历史，引用若停留在旧标识符上，历史就查不到，
   下一次运行会重新拿到 `seq = 1`，与已迁移的 run 撞出同一个 `run_1_<24 hex>`；
4. **计数器**：`runCounters` 按新标识符迁移，并取「已迁移 run 的最大 seq」与旧计数器的较大值，
   保证下一次运行的序号高于所有已用序号。

磁盘上的运行目录 `runs/<旧 id>/` 改名为 `runs/<新 id>/`——不改名则归档证据会与状态文件脱钩。

旧标识符写入 `legacyId` 字段，旧的外部链接与书签仍然可解析。

### 5.2 迁移的性质

- **确定性**：同一输入两次迁移得到同一输出（`UT-MIG-005`）。
- **幂等**：已迁移的文件再跑一次报告 `already migrated` 且不写盘（`UT-MIG-009`）。
- **可回滚**：写盘是 `state.json.tmp → rename`；`--backup` 另外留一份 `.bak`。
- **失败不毁数据**：文件损坏时退出码 1 且原文件保持不变（`UT-MIG-011`）。

### 5.3 规则演进

规则变更时递增版本号：

1. `server/uid.mjs` 里的 `UID_SCHEME_VERSION` 与各正则随之更新；
2. 旧标识符**继续可读**（正则同时匹配旧形态）；
3. 迁移脚本增加一档「v1 → v2」的转换；
4. `state.json` 的 `uidVersion` 字段记录当前规则版本。

因为每个 UID 都是**纯函数**（无时钟、无随机数、无 IO），任意历史记录都能从它记录的字段重算出 UID，
这是迁移可以逐版本推进的技术前提。

## 6. API 面

| 接口 | 变化 |
|---|---|
| `POST /api/projects` | 响应的 `project.id` 现在就是稳定 UID；`project.uid` 同样返回该值 |
| `GET /api/projects` | 每个项目带 `uid` |
| `GET /api/projects/:id/tests` | 每个用例带 `id`（= UID）、`uid`、`uidSource`、`uidStable`，歧义用例另带 `ambiguity`；响应另带 `uidVersion`、`projectUid` |
| `POST /api/projects/:id/run` | 响应的 `run.id` 现在就是稳定 UID；`run.uid` 同样返回该值；另带 `run.seq`、`run.projectUid` |
| `GET /api/runs/:id` | 完成的 run 带 `attempts` 数组 |
| `runs/<run>/manifest.json` | 另带 `projectUid` 与 `attempts` 数组 |

`:id` 位置参数同时接受旧形态（`proj_<uuid>` / `run_<uuid>`）与新形态（`proj_1_...` / `run_1_...`）。

## 7. 已知边界

以下能力**本规范未实现**，不得据本文件宣称已具备：

| 边界 | 归属 |
|---|---|
| 动态/参数化用例（`test.each`、fixture、代码生成）的权威发现 | ATS-202（FR-021） |
| 文件/标题变化时的 UID 重识别与歧义提示的完整策略 | ATS-204 |
| SQLite WAL 持久化与版本迁移 | ATS-205 |
| Run/Test/Attempt 与事件序号统一模型 | ATS-208 |

本规范实现的是**静态发现范围内**的稳定 UID。`uidStable=false` 的用例在静态发现阶段就已被标记，
其真实身份要等 ATS-202 的权威发现接入后才能确定。

## 8. 验证

| 类别 | 用例 | 覆盖内容 |
|---|---|---|
| UT | `UT-UID-001` … `UT-UID-021`、`UT-UID-025` … `UT-UID-027`（`tests/uid.test.mjs`） | 派生规则、跨改名/跨改标题、重复标题、歧义、注册表、Run/Attempt UID、报告路径归一、行号对齐、重试展开 |
| UT | `UT-MIG-001` … `UT-MIG-013`、`UT-MIG-014` … `UT-MIG-016`（`tests/migrate.test.mjs`） | 迁移计划、幂等、目录改名、失败不毁数据、备份、迁移后引用与计数器 |
| IT | `IT-UID-001` … `IT-UID-007`（`tests/uid-api.test.mjs`） | 真实 HTTP 下的 UID 暴露、注册表持久化、按 UID 寻址、序号单调 |

执行：`npm test`（Node ≥ 22）。

### 8.1 真实 Playwright 契约验证

`tools/ats201-probes/attempt-binding-real-pw.mjs` 用**真实的 `@playwright/test` 1.64.1**（真实
Chromium）在一次性夹具项目上跑一次真实运行，再用产品代码（`parseReport` / `attemptsForRun` /
`discoverStatic`）处理真实报告，逐条断言：

- 真实报告的 `spec.file` 相对 `rootDir`、注册表相对项目根目录；
- 两个同名不同执行体的用例拿到不同 UID；
- 每个 attempt 都绑定到对应的 TestDefinition UID，绑定依据为 `file-line`。

`tools/ats201-probes/migration-seq-collision.mjs` 复现并断言「迁移后下一次运行的序号不得与
已迁移 run 撞号」。

这两支探针是**契约测试**：报告格式一旦变化（路径基准、行号、重试展开），它们会立刻失败，
而基于假 CLI 的端到端脚本不会。
