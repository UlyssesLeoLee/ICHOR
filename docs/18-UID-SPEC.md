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
2. **跨改标题不变**——用例改了标题仍是同一个用例，**前提是执行体没变**；
3. **重复标题可区分**——标题相同但执行体不同的两个用例必须得到不同的 UID，
   且无法区分时（标题与执行体都相同）必须**显式报告歧义**，而不是悄悄合并。

第 2 条的前提不是形式主义：同名用例一旦改了执行体，它的 UID 就会随之改变
（`describe` 路径不参与标题键，因此同名用例只能靠执行体指纹区分）。
§7.1 列出这条边界的实测形态。

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
| Attempt | `att_1_<24 hex>` | 32 | `sha256(runUid ␀ testUid ␀ retry ␀ occurrence)[0:24]` |

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

**适用范围**：Project UID 依赖**绝对路径**。同一份仓库在不同的克隆路径下（不同的机器、
不同的目录名、CI 的临时工作区）得到不同的 Project UID，TestDefinition / Run / Attempt 的
UID 随之不同。Project UID 只在**同一台机器、同一路径**下稳定；跨机器的用例标识由
ATS-202 的权威发现与 ATS-204 的重识别策略承接，本规范不宣称跨机器一致。

### 3.2 TestDefinition

判定按以下优先级逐级降级，**先命中者生效**：

| 优先级 | 条件 | UID 来源 | `uidSource` | 是否稳定 |
|---|---|---|---|---|
| 1 | 标题含 `@TC-<token>`，且该 token 在项目内只出现一次 | 显式 token | `explicit` | 是 |
| 2 | 注册表中有**唯一**条目且执行体指纹相同 | 注册表中的 UID | `registry` | 是（前提是执行体未变，见 §7） |
| 3 | 标题键在项目内唯一 | `deriveTestUid(projectUid, titleKey)` | `derived` | 是（前提是标题未变） |
| 4 | 执行体指纹在项目内唯一 | `deriveTestUid(projectUid, bodyKey)` | `derived-body` | 是（前提是执行体未变） |
| 5 | 以上都不成立 | `provisionalTestUid()` | `provisional` | **否** |

**「是否稳定」一列的限定条件不是形式主义**：规则 2/3/4 的稳定性都以「触发该规则的
那个信号没有变」为前提。规则 3（标题键）换标题就变；规则 2/4（执行体指纹）改执行体
就变。§7 列出这些边界。

**显式标注是 CLAIM，不是提示**：规则 1 的 token 属于写下它的那个用例，注册表条目
不得把它交给别的用例；两个用例写了同一个 token 时，两者都不绑定该 token，
并进入歧义报告（§3.2 末尾）。

**注册表条目按 uid 去重**：注册表里同一 uid 只保留一条 entry；唯一性按**不同的
uid** 计数，不是按 entry 条数计数。已被本次发现裁掉的陈旧 entry 不再阻挡规则 2。

**标题键**（`normalizeTitleKey`）：NFKC 归一 → 去掉 `@TC-` 标注 → 折叠空白 → 转小写。
去掉标注是关键：给用例补上 `@TC-001` 不应改变它的派生键。

**执行体指纹**（`bodyKeyOf`）：取 `test()` 第二个参数（回调体）文本，折叠空白后 `sha256`。
提取由 `server/uid.mjs` 的 `extractCallbackBody()` 完成，它是一个**受限的 JS 词法扫描器**：
识别字符串、模板字符串（含 `${}` 嵌套）、正则字面量、行注释与块注释，
因此 `await expect(x).toHaveText('a,b,c')` 里的逗号不会把参数切断。

**注册表**（`state.json` 的 `uidRegistry`）记录 `{uid, uidSource, titleKey, bodyKey, file, title, aliases}`。
它让「改名 + 改标题」之后仍能找回原 UID：规则 2 命中时，旧 UID 被复用，
旧的 (file, title) 组合进入 `aliases`。

注册表是「过去见过的用例」的**记忆**，因此它会积累陈旧条目。三条规则让它保持
有界且唯一：

1. **一个 uid 一条 entry**。同一 uid 的多条 entry 会让任何一次查找都变成歧义——
   而它们描述的其实是同一个用例。
2. **唯一性按不同的 uid 计数**，不是按 entry 条数计数。
3. **陈旧条目被裁剪**。裁剪只针对「**文件仍在本次发现范围内、但用例已消失**」的
   entry：其 uid 不再被任何已解析出的用例认领，且它所属的文件本次被发现了。
   保留它会让那个 uid 在日后被交给别的用例，也会让状态文件无界增长；
   裁剪正是让陈旧条目不再永久挡住规则 2 的机制。

**缺席不等于删除**：文件本身不在本次发现中的 entry 一律保留。Git 分支切换、
文件改名、项目分片发现都会让某个文件在某一次发现中缺席，而缺席**不说明**
文件里的用例被删除了。裁剪这样的 entry 会让用例在文件回来之后换一个 UID，
身份就此丢失。§7.1 列出这条边界的实测形态。

**注册表条目的查找顺序**：先按「执行体指纹 + 相同文件 + 相同标题键」定位（最精确），
再按「执行体指纹」定位（此时要求该指纹在项目内唯一）。两者都无法唯一定位时，
用例带 `ambiguity.reason='ambiguous-registry-match'`，其 UID 由本次发现派生。

**歧义**：规则 5 触发时，用例得到 `tcp_1_...` 占位 UID，并在 `ambiguity` 字段中报告
`reason` 与全部候选。发现接口的 `warning` 会追加相应的提示。
**歧义不被静默吞掉，也不被静默合并**——合并两个不同用例比报错更糟。

`ambiguity.reason` 的取值：

| reason | 含义 | 用例的 UID |
|---|---|---|
| `identical-title` | 标题重复，执行体不同且执行体指纹不唯一 | 临时值 |
| `identical-title-and-body` | 标题与执行体都重复 | 临时值 |
| `duplicate-explicit-uid` | 两个用例写了同一个 `@TC-xxx` | 两个都是临时值，都不绑定该 token |
| `ambiguous-registry-match` | 注册表里有多个候选条目，无法判定是哪一个 | 由本次发现派生（标题键或执行体指纹） |
| `explicit-uid-claimed-by-another-case` | 注册表条目想给的 uid 已被另一个用例的显式标注占用 | 由本次发现派生 |

后三种情形下用例仍然有一个可用的 UID，但 `uidStable` 与 `ambiguity` 会把它标出来，
发现接口的 `warning` 也会说明「N 个用例的注册表记录与本次发现不一致」。
**边界被显式提示，不被静默处理。**

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

**绑定依据（`uidBasis`）从精确到宽泛**：

| 依据 | 含义 |
|---|---|
| `file-line` | 同一文件、同一行、同一标题，且该位置只有一个候选 |
| `file-title-body` | 同一文件、同一标题的用例有多个，靠**执行体指纹**区分出唯一的一个 |
| `file-title` | 同一文件、同一标题，且该组合只有一个候选 |
| `title` | 标题在项目内唯一 |
| `file-title-ambiguous` | 同一文件、同一标题的用例有多个，而执行体指纹算不出来——**不绑定** |
| `title-ambiguous` | 标题在项目内不唯一——**不绑定** |
| `unbound` | 注册表里没有这个用例 |

**行号不是身份，标题也不是身份**。行号会因文件顶部的插入而整体平移，标题会被
同一个文件里的其它用例共用；两者单独或组合起来都可能把一个用例绑到另一个用例的
UID 上，而且看上去没有任何异常。因此：

- 行号只在「同一文件 + 同一标题 + 该位置唯一」时作为依据；
- 同一文件里标题相同的用例靠**执行体指纹**区分，指纹取自**本次执行的源码**
  （`server/core.mjs` 的 `reportedBodyKey()`），而不是上次发现时的记录；
- 指纹算不出来时，attempt 保持**未绑定**并记下依据。未绑定是诚实的答案，
  绑错不是。

**报告路径与注册表路径的拼写必须先归一**。Playwright 报告里的 `spec.file` 相对于它自己的
`rootDir`（由 `testDir` 推导），而注册表里的 `file` 相对于**项目根目录**：
`examples/sample-playwright` 这类 `testDir: './tests'` 的项目，报告写 `home.spec.ts`，
注册表写 `tests/home.spec.ts`。`server/uid.mjs` 的 `normalizeTestPath()` 用报告里的
`config.rootDir` 与项目根目录把两种写法归一到同一个键，归一后才做查找。

**行号同理**：静态扫描给出的行号是 `test(` 调用所在行，与 Playwright 报告的行号一致；
扫描器必须以 `test(` 的位置计行，而不是以其前导空白的位置计行。

**Attempt 的 status 是结果级（result level）的**。Playwright 的报告里有两级状态：
`test.status` 是**用例级**（`expected` / `unexpected` / `flaky` / `skipped`），
`results[].status` 是**结果级**（`passed` / `failed` / `timedOut` / `skipped` /
`interrupted`）。一个 flaky 用例的用例级状态是 `flaky`，但它的第一次重试实为
`failed`、第二次才是 `passed`。

一个 Attempt 是一次**执行**，因此它记录结果级状态：`attempt.status` 是
`passed` / `failed` / …，用例级状态另存为 `attempt.caseStatus`。
把用例级状态写进 Attempt 会让两次执行都显示 `flaky`，掩盖掉第一次确实失败过。

Attempt 记录写入 `state.json` 的 run 记录里，并进入 `runs/<run-uid>/manifest.json` 的 `attempts` 数组。

运行摘要里有两个计数，**单位不同，不要混用**：`total`/`passed`/`failed`/`skipped`/`flaky`
计的是**用例数**（重试用例仍是一个用例），`executions` 计的是**执行次数**（重试各算一次）。
`summary.cases` 数组与 `executions` 一一对应。

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
node tools/migrate_uids.mjs --state <path to state.json> --rollback
```

`--state` 缺省取 `$ATS_DATA_DIR/state.json`，未设置时取 `~/.ai-test-studio/state.json`。

**前置条件：Bridge 必须处于停止状态。**

状态文件与磁盘上的运行目录是**同一份状态**：Bridge 把状态放在内存里，每次变更都
写回 `state.json`。若在 Bridge 运行期间执行迁移，Bridge 的下一次写回会用内存里的
**旧标识符**覆盖已经迁移的 `state.json`，而磁盘上的运行目录已经被改名——状态因此
指向了不存在的目录。

数据目录由 `bridge.lock` 独占：

- Bridge 启动时取锁，进程退出时释放；
- 迁移脚本检测到活进程持锁即**拒绝执行**（退出码 2），并说明须先停止 Bridge；
- 迁移写盘期间同样持锁，Bridge 无法在「改名目录」与「改写状态」之间启动。

**锁的持有者是可校验的，不是「一个还活着的 pid」**。pid 会被操作系统回收，
因此锁文件记录持有者的 **pid + 进程启动时间**：

| 锁文件的状态 | 判定 | 后果 |
|---|---|---|
| pid 不存在 | 陈旧锁 | 不阻挡任何人，被下一个持有者覆盖 |
| pid 存在，但进程启动时间与记录不符（pid 被复用） | 陈旧锁 | 不阻挡任何人，被下一个持有者覆盖 |
| pid 存在，启动时间与记录一致 | 活锁 | 拒绝启动 / 拒绝迁移 |
| 锁文件没有可校验的身份（旧版本或手写） | 身份不明 | 拒绝启动 / 拒绝迁移，并给出恢复步骤 |

**身份不明的锁按活锁处理**：它无法与「pid 被复用」区分，而它守护的状态可能确实
在被使用。此时 Bridge 拒绝启动，并在 stderr 上给出**恢复步骤**：

1. 用 `tasklist /FI "PID eq <pid>"` 确认那个进程不是 Bridge；
2. 确认没有 Bridge 在运行之后，删除 `bridge.lock` 再启动 Bridge。

删除锁文件只有在第 1 步确认没有 Bridge 在运行之后才是安全的。

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
- **失败不毁数据**：文件损坏时退出码 1 且原文件保持不变（`UT-MIG-011`）。
- **可回滚**：写盘是 `state.json.tmp → rename`；`--backup` 另外留一份 `.bak`。

**「可回滚」的准确含义**：`--backup` 留下的 `.bak` **只还原状态文件**。它不还原
运行目录的改名——磁盘上的目录仍然用新标识符命名，而还原后的状态指向旧标识符，
于是归档证据同样与目录脱钩。

`--rollback` 才是**完整**的回滚：它还原 `state.json`，并把运行目录改回旧标识符，
使状态与磁盘上的目录重新连在一起。没有 `.bak` 时 `--rollback` 拒绝执行
（退出码 1）。

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
| `POST /api/projects` | 响应的 `project.id` 现在就是稳定 UID；`project.uid` 同样返回该值；同一仓库的大小写变体返回 `PROJECT_ALREADY_REGISTERED`（判重使用与 UID 相同的规范化） |
| `GET /api/projects` | 每个项目带 `uid` |
| `GET /api/projects/:id/tests` | 每个用例带 `id`（= UID）、`uid`、`uidSource`、`uidStable`，歧义用例另带 `ambiguity`；响应另带 `uidVersion`、`projectUid` |
| `POST /api/projects/:id/run` | 响应的 `run.id` 现在就是稳定 UID；`run.uid` 同样返回该值；另带 `run.seq`、`run.projectUid` |
| `GET /api/runs/:id` | 完成的 run 带 `attempts` 数组；每个 attempt 的 `status` 是**结果级**状态，`caseStatus` 是用例级状态 |
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

### 7.1 实测确认的边界

以下边界是**实测确认**的，不是推测。每一条都对应一个可重跑的复现用例。

| 边界 | 现象 | 处理方式 |
|---|---|---|
| **同名用例改执行体后 UID 会变** | 同一文件里不同 `describe` 下的两个 `test('works')`（真实 Playwright 允许）在改掉其中一个的执行体后，两个 UID 都改为按执行体指纹派生——原 UID 不会保留 | `describe` 路径**不参与标题键**，因此同名用例只能靠执行体指纹区分；改执行体即改身份。要保留身份必须用显式标注 `@TC-xxx` |
| **跨机器的 Project UID 不同** | Project UID 由绝对路径派生，同一仓库在不同克隆路径下得到不同的 UID | 见 §3.1「适用范围」 |
| **注册表冲突时 UID 由本次发现派生** | 注册表里同一个执行体指纹对应多个条目时，无法判定是哪一个 | 用例带 `ambiguity.reason='ambiguous-registry-match'`，并在 `warning` 中提示 |
| **重复的显式 UID 不被绑定** | 两个用例都标 `@TC-007` 时，谁也不拥有该 token | 两个用例都带 `ambiguity.reason='duplicate-explicit-uid'`，并在 `warning` 中提示 |
| **同名用例在行号平移后靠执行体指纹区分** | 同一文件里两个 `test('works')`（分属不同 `describe`），在文件顶部插入几行后，其中一个用例落到了另一个用例原来的行号上。按行号 + 标题的组合会把它绑到**别人的 UID** | 绑定时以**本次执行的源码**重新定位该用例并取其执行体指纹，同名用例靠指纹区分；指纹算不出来时该 attempt 保持**未绑定**并记下依据（`file-title-ambiguous`），不猜 |
| **文件暂时缺席不会丢 UID** | 切换到不含某个文件的分支时，那个文件的注册表条目若被当作「已删除的用例」裁掉，切回原分支后用例就会换一个 UID | 裁剪只针对「文件仍在本次发现范围内、但用例已消失」的 entry；文件本身不在本次发现中的 entry 保留 |

第 1 条（同名用例改执行体后 UID 会变）是 §3.2「是否稳定」一列的限定条件的直接后果：
规则 4 以执行体指纹为依据，而同名用例的指纹一旦被改动，身份也就随之改变。

第 5 条与第 6 条是**绑定与裁剪**两侧的边界：前者保证「不绑错」，后者保证「不丢身份」。
两者都不依赖用例的标题或行号单独成立。

## 8. 验证

| 类别 | 用例 | 覆盖内容 |
|---|---|---|
| UT | `UT-UID-001` … `UT-UID-021`、`UT-UID-025` … `UT-UID-027`（`tests/uid.test.mjs`） | 派生规则、跨改名/跨改标题、重复标题、歧义、注册表、Run/Attempt UID、报告路径归一、行号对齐、重试展开 |
| UT | `UT-UID-REG-001` … `UT-UID-REG-012`、`UT-UID-REG-014` … `UT-UID-REG-017`（`tests/uid-regressions.test.mjs`） | 第 1 次复核的反例回归：错绑、注册表去重与裁剪、显式标注优先、重复显式 UID 的歧义报告、Attempt 的结果级状态；第 2 次复核的反例回归：同名用例在行号平移后靠执行体指纹区分（不绑错）、文件暂时缺席时不丢 UID |
| UT | `UT-UID-LEX-001` … `UT-UID-LEX-009`、`UT-UID-COL-001` … `UT-UID-COL-005`（`tests/uid-lexer.test.mjs`） | 受限词法扫描器（正则字面量、除法、模板嵌套、行/块注释、转义引号、超长 body）与冲突裁决分支 |
| UT | `UT-MIG-001` … `UT-MIG-013`、`UT-MIG-014` … `UT-MIG-016`（`tests/migrate.test.mjs`） | 迁移计划、幂等、目录改名、失败不毁数据、备份、迁移后引用与计数器 |
| UT | `UT-MIG-REG-001` … `UT-MIG-REG-009`、`UT-MIG-REG-011` … `UT-MIG-REG-015`（`tests/migrate-regressions.test.mjs`） | 数据目录锁、迁移在 Bridge 运行时被拒绝、完整回滚（含目录改名）；锁的持有者身份可校验（pid + 进程启动时间）、pid 被复用时锁为陈旧锁、身份不明的锁给出恢复步骤 |
| IT | `IT-UID-001` … `IT-UID-007`（`tests/uid-api.test.mjs`） | 真实 HTTP 下的 UID 暴露、注册表持久化、按 UID 寻址、序号单调 |
| IT | `IT-API-016`（`tests/api.test.mjs`） | 大小写变体注册返回 `PROJECT_ALREADY_REGISTERED`，不产生两条记录同一个 id |

执行：`npm test`（Node ≥ 22）。

**行覆盖率**：`server/uid.mjs` 与 `server/core.mjs` 的行覆盖率均**严格大于 90%**
（`node --test --experimental-test-coverage tests/*.test.mjs`）。词法扫描器与冲突裁决
分支由 `tests/uid-lexer.test.mjs` 覆盖，不是靠其它用例的副带执行。

**反例回归的可证伪性**：`tests/uid-regressions.test.mjs` 与 `tests/migrate-regressions.test.mjs`
在修复前的树（`9eb168c`）上实测有 9 项失败——断言确实能抓住缺陷，不是恒真断言。

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

### 8.2 测试端口分配

四个 IT 测试文件都通过 `tests/helpers/free-port.mjs` 向操作系统申请一个空闲端口。
端口由操作系统分配，两个测试文件拿到同一个端口的可能因此不存在。

复现脚本：`tools/ats201-probes/it-port-collision-repro.mjs`
（强制两个 Bridge 抢同一端口，展示 `EADDRINUSE`）。

### 8.3 证据索引

`docs/evidence/ATS-201/` 下的每一份日志都由
`tools/ats201-probes/collect-evidence.sh` 在当前的树上实际执行并原样捕获，
因此该脚本就是证据的复现脚本。

| 日志 | 内容 |
|---|---|
| `08-node-test-full.log` | 完整的 Node UT/IT 输出 |
| `09-line-coverage.log` | `server/uid.mjs` 与 `server/core.mjs` 的行覆盖率 |
| `10-review-regressions.log` | 第 1 次复核的全部反例（32 项断言） |
| `11-real-playwright-contract.log` | 真实 `@playwright/test` 的报告→UID 绑定契约 |
| `12-real-playwright-flaky-status.log` | 真实 Playwright 的 flaky 用例：retry0=failed、retry1=passed |
| `13-uid-e2e.log` | 发现→注册表→运行→attempt 的端到端流程 |
| `14-migration-seq-collision.log` | 迁移后下一次运行的序号不撞号 |
| `15-migration-evidence.log` | 迁移的幂等、失败不毁数据、备份 |
| `16-api-surface.log` | HTTP 接口面 |
| `17-port-audit.log` | ATS-101 端口审计（16 §3.1 的行号与清单） |
| `18-wbs-updater.log` | WBS 更新脚本的 XML 转义与幂等性 |
| `19-wbs-updaters-coexist.log` | 7 个 WBS 更新脚本共存 |
| `20-wbs-common-regression.log` | 标记合并的回归 |
