# SEIKOIST-145 并行编排说明（WBS 依赖 → MAGOS 泳道）

本目录下的工具把 `docs/WBS.xlsx`「开发WBS」的「前置依赖 WBS」列与
Multica 看板上的实时状态合成为一张**可执行**的并行计划，并负责校验依赖边
的挂载情况。

## 工具

| 工具 | 作用 |
|---|---|
| `tools/wbs_ready.py` | 从 WBS 依赖 + 看板状态算出「现在可以开工」的集合；`--promote` 把 `backlog` 提升为 `todo` |
| `tools/wbs_graph.py` | 构建依赖图并按边挂唤醒规则（`--until-issue <前置> --until-issue-state ended`） |
| `tools/wbs_audit_edges.py` | 审计「实际已挂的边」与「应有的边集」是否一致，报告 MISSING / EXTRA |
| `tools/wbs_taskfiles.py` | 从子任务 issue 描述的「工作位置」段落解析每个任务声明的文件清单 |
| `tools/wbs_conflict_groups.py` | 把「共用同一批文件」的任务并成冲突组，输出真实并行波次与宽度 |
| `tools/wbs_redistribute_edges.py` | 把已挂的依赖边按轮转重新分配到多个 agent，避免一波任务全压在单个 agent 上 |

## 用法

```bash
# 依赖图 + 挂边
multica issue children <父票 id> --output json > children.json
python tools/wbs_ready.py children.json --list
python tools/wbs_graph.py children.json --arm

# 审计：期望 135 条边，实际挂了几条
python tools/wbs_audit_edges.py docs/WBS.xlsx children.json

# 真实并行宽度（依赖 DAG + 文件冲突组）
python tools/wbs_taskfiles.py children.json --out taskfiles.json
python tools/wbs_conflict_groups.py

# 边重新分配到 M3 / M2 / Opus
python tools/wbs_redistribute_edges.py
```

## 三条关键结论

1. **依赖边必须挂在子任务上，不能挂在父票上。**
   父票的 `--until-children-done --stage N` 语义是「阶段 1..N 全部关闭」，
   于是第 N+1 波要等前面所有波次结束。WBS 依赖列明 5 条链（S1/S2/S3/S4/S5）
   互相独立，却被强行串成一条。改成在**后继任务**上挂
   `--until-issue <前置> --until-issue-state ended` 后，任务只等自己的前置。

2. **单条边触发只是「部分」放行信号。**
   被唤醒的运行必须重新核对前置依赖全集，全部达终态才提升为 `todo`，
   否则只留一条「还差哪些依赖」的记录就结束。

3. **边必须分散到多个 agent。**
   135 条边全指向 M3 时，一波 14 个任务同时解锁也只会挤在 M3 一个
   队列上；把边按轮转分给 M3 / M2 / Opus（各 45 条）后，一波任务才会
   真的同时开工。

## 并行度的真实上限是 1，不是 agent 槽位数

实测（89 个子任务，`tools/wbs_taskfiles.py` + `tools/wbs_conflict_groups.py`）：

- **纯语义 DAG 宽度 18**，关键路径 12 层。这是 WBS「前置依赖 WBS」列给出的
  理论并行度。
- **加上文件冲突后，89 个任务并成 1 个冲突组**（2391 对文件冲突边）。
  原因：`server/index.mjs` 被 56 个任务声明、`server/core.mjs` 被 47 个任务
  声明、`tests/test-cases.json` 被 20 个任务声明。绝大多数任务的「相关文件」
  列表都同时包含前两个文件，union-find 因此把全部任务连成一个连通分量。

**这意味着「尽可能多地并行开工」在当前任务划分下拿不到并行度。** 同一时刻
只能有 1 个任务在真正改动 `server/index.mjs` / `server/core.mjs`。加 agent
槽位、加快唤醒，都不能绕过这一点。

可行的做法是**缩小文件声明的粒度**：把任务的「相关文件」从
`server/index.mjs` 收敛到它真正要改的函数/段落，多个任务就不必互相独占
整个文件。但这需要逐任务核对真实改动面，属于 WBS 任务定义本身的修订，
不是编排层能单独解决的。

> 因此本仓库的编排策略是：依赖边驱动放行（保证**开工顺序**正确），
> 而并行度的上限由文件冲突组决定（保证**同时开工不互相覆盖**）。
> 两者缺一不可：只做前者会并行覆盖，只做后者会顺序错乱。

## 踩过的坑

- `multica issue wakeup update` 会**整体替换**规则配置：只传 `--agent-id`
  会被拒（`instruction must contain 1–12000 bytes`），只传 `--agent-id` 和
  `--instruction-file` 也会被拒（`select at least one supported event`）。
  必须同时带上 `--until-issue` / `--until-issue-state` 和原样的
  `--instruction-file`。
- 在 Windows 上用 `--instruction-file` 回写指令会把原有 CRLF 变成
  CR+CRLF（读回时出现孤立 CR）。回写前先归一化成 LF：读文件用
  `newline=''`，写文件用 `newline='\n'`。归一化后长度应回到原值（790 字节）。
- `multica issue wakeup list` 的输出有时是对象有时是数组，解析时**不能**
  直接 `raw[raw.find('['):]`——对象 JSON 里第一个 `[` 属于
  `"event_types": []`，切出来会解析失败。
- 批量 `wakeup create` 会在 TLS 握手超时时静默漏挂一条，批量之后**必须**
  跑 `wbs_audit_edges.py` 逐条核对。
