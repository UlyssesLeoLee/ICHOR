# ATS-410 evidence｜失败归因（Triage）

本目录是 ATS-410 的实测证据。每一份日志都由
`tools/ats410-probes/capture-evidence.sh` 生成，**可重跑**，且日志头部写明
它描述的 commit。

## 复现

```bash
# 全流程（5 步）
bash tools/ats410-probes/capture-evidence.sh

# 单步
node --test tests/triage.test.mjs                    # UT 36 例
node --test tests/triage-api.test.mjs                # IT 11 例
node tools/ats410-probes/probe-triage-boundary.mjs   # 边界探针 17 项
python tools/update_wbs_ats410.py                     # WBS 行同步（幂等）
bash tools/ats301-probes/check-ats301-gate.sh        # 共享门禁
```

探针是**只读**的（除 WBS 同步脚本外，它不往树上写任何东西）。所以同一棵树上
跑两次得到同样的结果。

## 日志

| 文件 | 内容 | 结果 |
|---|---|---|
| `01-triage-unit.log` | UT 36 例（分类、证据引用、可疑变更、只读边界） | **36 pass / 0 fail / 0 skipped** |
| `02-triage-api.log` | IT 11 例（两个路由、拒绝路径、HTTP 上的只读证明） | **11 pass / 0 fail / 0 skipped** |
| `03-triage-boundary.log` | 边界探针 17 项（含 4 条负控） | **RESULT: OK** |
| `04-wbs-idempotent.log` | WBS 行同步；连跑两次工作簿逐字节相同 | **exit 0** |
| `05-ats301-gate.log` | ATS-301 门禁（WBS 合并回归 + ADR 引用检查 + 端口审计） | **RESULT: OK** |

## 这些日志证明了什么，没有证明什么

**证明了**：

- 分类是**封闭集合**四类（脚本/产品/环境/不确定），且对同一份证据**确定**——
  探针第 1 节把 7 种失败种类 × 4 种组合全跑一遍，每次都落到四类之内。
- **历史闸门是承重的**：断言类失败在没有可比的 commit 历史时落在「不确定」，
  不是「产品」。探针第 2 节**去掉闸门**重算这 6 个输入，分类**全部改变**——
  这条性质因此是可证伪的，而不是一句关于源码的说法。
- 每条结论都带**可核对来源**：证据引用带可复算摘要；没有引用、引用越界、
  引用指向不存在的用例，三种情况都被拒绝（探针第 3 节，三条负控）。
- 归因是**只读**的：内核不 import 任何写入接口、不 spawn 进程（静态检查，
  带负控）；一次完整归因后运行记录**逐字节不变**（运行时实测）。

**没有证明**：

- **没有用真实模型端到端验证**。本机没有配置任何模型提供商、也没有真实凭据，
  因此 `modelEnhanced: true` 会以 `TRIAGE_MODEL_UNAVAILABLE` 报错，
  **不会**静默退化成确定性结果。已实测的是**归因内核本身**，不是模型产出的归因。
- 「可疑变更」在**真实仓库**上的检出率没有实测：探针用注入的读取器验证了
  判定规则本身（两次 commit 不同 / 同一用例 / 只看测试脚本），但没有在真实的
  多 commit 仓库上跑过一轮完整的「回归 → 检出」。

## 复现时的注意点

`npm test` 的全量套件在**本机负载高**时会出现与本任务无关的偶发失败
（`ECONNRESET` 与一把锁的竞态，出现在 `tests/ats214-batch-context.test.mjs` 与
`tests/instance-lock.test.mjs`）。实测记录：

| 树 | 结果 |
|---|---|
| 只有 `dev` 的合并（无本任务改动） | tests 1902 / pass 1870 / **fail 0** / skipped 32 |
| 本任务改动 + 全量套件（负载高时） | tests 1949 / pass 1914~1916 / **fail 1~3**（均为上述偶发） |
| 本任务改动 + 全量套件（负载正常时） | tests 1949 / pass 1917 / **fail 0** / skipped 32 |

失败的那些用例**单独跑是全绿**（`node --test tests/ats214-batch-context.test.mjs`
→ 10 pass / 0 fail）。因此它们是**资源争用**造成的偶发，不是本任务引入的回归。
