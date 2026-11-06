# ATS-EVD-001 证据清单与保留策略设计书（ATS-209｜S2 / v0.2.0）

> 本文描述 **Evidence Manifest、SHA-256、去重/保留策略**的交付内容。
> 数据字典见 `docs/06-DATA-DESIGN.md` §4，接口面见本文 §5。

## 1. 这一项交付的是什么

ATS-209 的交付物是「证据索引与清理器」：一次运行留下的证据文件（JSON 报告、HTML 报告、
trace 归档、截图、录屏）有一份**可校验的清单**，清单带着每个文件的 SHA-256；证据的字节
**只存一份**；到期��证据可以被清理，而**运行元数据不会被误删**。

两个验收标准与实现位置的对应：

| 验收标准 | 含义 | 实现 |
|---|---|---|
| 篡改可检测 | 归档后被改动的文件必须被发现，并指名是哪个文件 | `server/evidence/manifest.mjs` 的 `verifyEvidence()` |
| 保留期到期可清理且不误删 Run 元数据 | 到期的证据被移除，run 记录（状态、summary、attempts、events）原样保留 | `server/evidence/retention.mjs` 的 `cleanExpiredEvidence()` |

## 2. 交付前的实测状态

交付前的行为由 `tools/ats209-probes/` 下的探针**实测**，不是推断。下面是交付前后的对照
（同一份夹具、同一台机器）：

| 场景 | 交付前（实测） | 交付后（实测） |
|---|---|---|
| 运行结束后 `manifest.json` 的内容 | `{version:1, runId, artifacts:[{file,size,sha256}], attempts}` | `{version:2, runId, projectUid, sourceCommit, artifacts:[...], attempts, evidence:{count,totalBytes,setDigest}}` |
| 清单是否说明 digest 属于哪个 run | **否**（只有 `runId` 一个字段，digest 不带归属） | **是**（`runId` + `projectUid` + `sourceCommit` + `evidence.setDigest`） |
| 归档后文件被改动 | **无人检查**——digest 记下了，但再也没被读过 | `GET /api/runs/:id/evidence` 报出 `changed[]`，含应有与实际两个 digest |
| 归档后文件被删除 | **无人检查** | 报出 `missing[]`（与 `changed[]` 分开，不是同一件事） |
| 相同内容的证据（重跑同一失败用例） | 存**两份** | 存**一份**：run 文件成为 store 中副本的硬链接 |
| 到期清理 | **不存在**——run 目录无限增长 | `tools/evidence_retention.mjs clean` 移除证据，保留 run 记录与事件日志 |
| 清理与 Bridge 并发 | 不存在此问题 | **拒绝**：Bridge 持有数据目录锁时清理退出码 3 |

**manifest 的版本从 1 升到 2**：v1 的清单没有 `evidence` 段，也没有 `projectUid` /
`sourceCommit`，因此无法回答「这组 digest 属于哪一次运行」。v2 补上这两项，`version` 字段
随之递增，读旧清单的代码能据此判断版本。

## 3. 三者的边界

### 3.1 清单（manifest）：归档对自己的记录

清单是**运行记录与文件夹内容**的函数：同样的运行、同样的文件，总是得到同样的清单。
这正是它可被校验的前提——读者可以重建一份清单再比对。

清单里的每条证据是 `{file, size, sha256}`：

- `file` 是**相对 run 目录**的路径，用 `/` 分隔（跨平台一致）；
- `sha256` 是文件**原始字节**的摘要。**不做任何归一化**：忽略了行尾差异的摘要检测不到
  「文件被改写成了另一种行尾」，而那正是证据文件必须能发现的改动；
- `size` 是字节数。两个同名同摘要但大小不同的文件不是同一份证据，所以 size 参与
  `evidence.setDigest` 的计算。

清单**不列出自己**，也不列出 `events.jsonl` 与 `stdout.log`：后者是运行的**记录**，前者是
证据的**记录**，三者分开，清理器才能只动证据。

`evidence.setDigest` 是整组证据的摘要（对排序后的 `file:sha256:size` 行取 SHA-256），
所以两份证据集合相同的运行会得到同一个 `setDigest`——去重与比对都以此为依据。

### 3.2 去重：字节只存一份

去重不是「报告重复」，而是**真的只存一份**。

`server/evidence/store.mjs` 是一个**内容寻址存储**：证据文件的字节按自己的 SHA-256 存在
`<data-dir>/evidence-store/<前2位>/<第3-4位>/<摘要>` 下，run 目录里的文件则变成指向该副本的
**硬链接**。

用硬链接而不是副本，原因有三：

1. **空间**：副本仍然占空间，硬链接不占——字节在磁盘上只有一份，最后一个链接消失时空间才回收；
2. **原子性**：链接先在临时名下建立，再 `rename` 覆盖目标，读者不会看到装了一半的文件；
3. **内容不会分叉**：硬链接的各副本**无法各自独立改写**——经一个链接就地写入的内容对所有
   链接可见。这正是篡改检测**依赖**的性质：run 的证据文件不可能悄悄偏离 store 里的副本，
   而摘要就是清单记录的东西。

不能链接的情况（跨卷、文件系统不支持链接、超过体积上限）被**如实报告**而不是静默忽略：
证据照常归档、照常可校验，只是没有去重，原因记在 run 的 `dedupRefused` 上。

**去重的诚实边界**：一个 run 目录若少了文件，它就不再与自己的清单相符。索引因此不替活着的
run 删文件——它**记录**哪些内容被存了多份、哪一份是权威副本，清理器只在**到期**的 run 上
移除重复副本。活着的 run 必须始终能出示自己的证据。

### 3.3 保留：清理证据，不动元数据

这是本项最要紧的一条，代码按它来写：

- 清理器操作的是 **run 目录里的证据文件**，不碰 `state.json`、不碰 SQLite 镜像、
  不碰 run 记录的任何一个字段；
- run 目录里的 `events.jsonl`、`stdout.log` 与 `manifest.json` **保留**：前两者是运行的
  记录，第三者是「证据曾经是什么」的记录；
- run 记录本身（状态、summary、attempts、events）在 `state.json` 里，**根本不在 run 目录里**，
  所以清理器碰不到它。集成测试 `IT-EVD-007` 逐字段比对了清理前后的 run 记录。

**清理是离线操作**。Bridge 运行时会持有数据目录的锁，并把内存里的状态写回 `state.json`；
此时清理会删掉正在产出证据的 run 的目录，而 Bridge 下一次保存就会把指向已删文件的状态写回去。
因此清理器先查锁，锁被持有时**拒绝**（退出码 3），与 `tools/migrate_state.mjs` 的同一规则。

每一次清理写一条**日志**（`<data-dir>/evidence-retention-journal.jsonl`，仅追加）：删了什么、
留下了什么、是哪一次 run。证据可能含 PII，`docs/06-DATA-DESIGN.md` §4 要求的「可审计删除」
由这份日志承担。

## 4. 保留期怎么算

- 只有**终态**的 run 才有资格被清理：`passed` / `failed` / `cancelled` / `error` /
  `interrupted`。`queued` / `running` / `cancelling` 的 run 还在产出证据，不是待清理的对象。
- 年龄从 run 的 `finishedAt` 起算（证据完整的那一刻），没有 `finishedAt` 时退回 `createdAt`。
- 默认保留期 **30 天**。默认值刻意宽松：一次没人看过的失败的证据被意外删掉，代价比多占
  几天磁盘大得多。需要更短的周期由调用方显式给出。

## 5. 接口面

| 接口 | 作用 |
|---|---|
| `GET /api/runs/:id/evidence` | 校验该 run 的证据：`verified` / `missing[]` / `changed[]` / `extra[]` |
| `GET /api/runs/:id/manifest` | 读回该 run 的清单原文 |
| `GET /api/evidence/retention?days=N` | 保留期**计划**：哪些 run 到期、证据占多少空间、多少字节被存了多份 |
| `GET /api/evidence/dedup` | 去重报告：哪些内容存了多份、浪费多少字节 |

`GET` 接口**只读**：不写、不修复、不删除。清理是**离线**命令：

```bash
node tools/evidence_retention.mjs plan    --data-dir <dir> [--days N]   # 看会发生什么
node tools/evidence_retention.mjs clean   --data-dir <dir> --days N --yes # 真的清理
node tools/evidence_retention.mjs verify  --data-dir <dir>              # 逐个 run 校验
node tools/evidence_retention.mjs journal --data-dir <dir>              # 读清理日志
```

`clean` 不带 `--yes` 会拒绝执行（退出码 2）：清理不会因为一次手滑就发生。

## 6. 已知边界（写明，不含糊）

- **清单未签名**：能写数据目录的攻击者可以同时改文件和清单，因此**不得**宣称 WORM 存储或
  防篡改等级。本项检测的是「文件不再与归档时的清单相符」，这正是 `docs/06-DATA-DESIGN.md`
  §4 要求的性质。
- **清理器删掉证据后，清单会与文件夹不一致**：清单保留着被删文件的 digest，于是校验会报
  `missing`。这是**如实的**回答，不是缺陷——证据确实到期了，清单确实还记着它。
- **`extra` 文件不使校验失败**：归档后被**追加**的文件不会让已归档的文件失效，但答案会把它
  列出来，因为文件夹已不是清单描述的那一份了。
- **摘要不归一化**：因此同一份内容在不同平台（CRLF 与 LF）会得到不同摘要，也就不会被去重。
  这是刻意的——归一化会削弱内容敏感性。
- **单机存储**：store 在数据目录内，跨数据目录不共享；没有远程证据后端（属 ATS-509）。
- **清理不做可逆恢复**：被清理的证据只存在于 store 的副本里（若它被别的 run 引用），
  否则不可恢复。

## 7. 实测证据

证据见 `docs/evidence/ATS-209/`。用例：`tests/evidence.test.mjs`（40 例 UT）与
`tests/evidence-it.test.mjs`（10 例 IT）。探针：`tools/ats209-probes/`。
