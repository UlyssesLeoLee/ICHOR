# ATS-209 在 dev tip 上的复跑证据

这些日志是在 **dev tip 的独立克隆**上采集的，不是任务 worktree 的自证。

- 克隆方式：`git clone --no-hardlinks D:/ICHOR <dir>`（`--no-hardlinks` 避免克隆与源
  共用 blob，行号/树混淆）
- 采集时的 dev tip：`5135242`（`merge(ATS-103): 第 3 轮返工最终交付（清单对齐 ATS-209 后的 dev`）
- 每一份日志的头部都记着自己描述的 commit（`commit : <sha>`）

采集命令：`bash tools/ats209-probes/collect-evidence.sh .`

结果（逐份日志见本目录）：

| 日志 | 结果 |
|---|---|
| `01-node-test-evidence-ut.log` | 55 例，全过 |
| `02-node-test-evidence-it.log` | 11 例，全过 |
| `02b-node-test-evidence-cli.log` | 21 例，全过 |
| `03-probe-evidence.log` | `RESULT: OK -- 0 failure(s)` |
| `04-port-audit.log` | `RESULT: OK`（端口清单逐位置核对） |
| `05-adr-citations.log` | `RESULT: OK`（ADR 引用行号） |
| `06-python-gates.log` | 全过 |
| `07-node-test-full.log` | 1152 例 / 通过 1141 / 失败 0 / 跳过 11 |
| `08-coverage.log` | manifest 97.33、retention 100、store 97.26、dedup 99.25、CLI 95.91 |
| `09-review-probe.log` | 第 1 轮复核探针 `RESULT: OK -- 0 defect(s)` |
| `10-review-probe-round2.log` | 第 2 轮复核探针 `RESULT: OK -- 0 defect(s)` |
| `11-wbs-row.log` | ATS-209 行：状态 `待审核`、完成率 1、剩余人日 0 |

**11 项 skip 不是 PASS 也不是 FAIL**：干净克隆里 `examples/sample-playwright` 没有
`node_modules`，需要真实安装的既有用例因此跳过；跳过原因逐条记在
`07-node-test-full.log` 里。
