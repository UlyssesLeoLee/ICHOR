SEIKOIST-145 依赖放行检查：前置任务 SEIKOIST-215（ATS-415）已达终态。

本任务 SEIKOIST-216（ATS-417）的某一个前置依赖
`ATS-415` 已经结束。这只是**部分**放行信号，不代表本任务可以开工。

1) 重新核对本任务的前置依赖全集。以 `docs/WBS.xlsx` 工作表「开发WBS」的
   「前置依赖 WBS」列为准，或直接运行本仓库的工具：
   `python tools/wbs_ready.py --list`
   该工具用同一份 WBS 数据算出每个任务还差哪些前置依赖。

2) **只有当本任务的全部前置依赖都已达到终态（done 或 cancelled）时**，
   才把本任务从 `backlog` 提升为 `todo`：
   `multica issue status 01a19f97-5ba9-7381-86d3-5d882a6c90b1 todo`
   如果还有前置依赖未结束，就**不要**提升本任务，等剩余依赖各自触发的
   唤醒再判断；此时只需在本任务下留一条简短记录说明「还差哪些前置依赖」，
   然后结束本次运行。

3) 若判定为可开工，按本任务 issue 描述里的「工作位置」执行：分支
   `agent/m3/seikoist-216`，产出完成后合并回 `dev`。

4) 在本任务 issue 下留言说明进度与证据，末行写 `Original executor: M3`；
   完成后 `multica issue assign <本任务id> --to Opus` 并置 `in_review`，**不得自行置 done**。

不要自行标记 done。