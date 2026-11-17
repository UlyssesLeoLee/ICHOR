# 外部复核探针的复跑结果（ATS-403）

本目录是**外部复核探针**（issue 附件 `r1.mjs` / `r1-api.mjs` / `r2.mjs` /
`r2-api.mjs`）在本交付上的复跑结果。探针的输出是本交付最直接的证据。

复跑脚本：`tools/ats403-probes/run-reviewer-probes.sh <探针目录> <输出目录>`。
探针**本身不入库**（那是附件，不是交付物），入库的是它们的**原样输出**。

## 结果

| 日志 | 探针 | 结果 |
|---|---|---|
| `r2.mjs.log` | `r2.mjs`（单元层反例 Q1–Q5） | **5 项全部 not-reproduced** |
| `r2-api.mjs.log` | `r2-api.mjs`（真实 HTTP 反例 H1/S4b/H3/S5/S5b） | **5 项中 4 项 not-reproduced**；H3 仍 CONFIRMED（已登记的缺口，见下） |
| `r1.mjs.log` | `r1.mjs`（单元层反例 P1–P7） | **8 项全部 not-reproduced** |
| `r1-api.mjs.log` | `r1-api.mjs`（真实 HTTP 反例 S1–S5） | S1–S4 全部 not-reproduced；**S4b 处探针自身抛错**（见下） |

## 逐条对照

### r2.mjs —— 本轮必须修复的反例

| 探针 | 判据 | 结果 |
|---|---|---|
| Q1 | 指令通道：调用方的 `request.instructions` 到了提供商，而审计没有记它 | **not-reproduced** —— 指令进审计了（记录 `kind`/`digest`/`bytes`，不记正文） |
| Q2 | 密钥跨过第 500 字符时，`error.message` 留下密钥前缀 | **not-reproduced** —— 抹除改为在截断之前 |
| Q3 | `executeSteps` 用真实同意书：第 1 步 429、第 2 步 200 | **not-reproduced** —— `steps=2`、`calls=2` |
| Q4 | `server/index.mjs` 未引用 `executeSteps`/`maxSteps`，而 docs/30 §5.3 写着「修好并接入」 | **not-reproduced** —— 两处说法都已改正 |
| Q5 | 截止时间分配：挂起的 A 之后，B 必须真的收到请求 | **not-reproduced** —— `provider=B`、`tried=A,B` |

### r2-api.mjs —— 真实 HTTP 上的同一批反例

| 探针 | 判据 | 结果 |
|---|---|---|
| H1 | 指令到了提供商，而审计没有它 | **not-reproduced** —— 审计记了指令的摘要 |
| S4b | 审计记的 `items` 是被授权的那个文件 | **not-reproduced** |
| S5 | 401 的 HTTP 状态与发布的状态表一致 | **not-reproduced** —— 502 = 表里的 502 |
| S5b | 契约的 `stepPolicy` 宣称有一个不存在的路由 | **not-reproduced** —— `stepPolicy` 现在写明它是库函数 |
| H3 | 同意书不绑定**目的地**：改指提供商会把被授权内容发到新端点 | **仍 CONFIRMED** —— 见「已知缺口」 |

### r1.mjs / r1-api.mjs —— 上一轮的反例不得回归

`r1.mjs` 的 P1–P7 全部 not-reproduced；`r1-api.mjs` 的 S1–S4 全部
not-reproduced。

## `r1-api.mjs` 在 S4b 处抛错：这是探针的产物，不是缺陷

`r1-api.mjs` 的 S4 步把 `providers` 列表放在请求体里调用
`/api/ai/complete`。适配器**拒绝**这种调用（调用方不得自选目的地），因此
返回 400 且**没有任何外发**；紧接着的 S4b 步去读「最后一条
`egress.granted`」，此时**没有这条记录**（因为什么都没发出去），探针于是对
`undefined` 取 `.includes` 而抛错。

S4b 这个判据本身由 `r2-api.mjs` 的 S4b 覆盖：后者用**已配置的**提供商到达
同一个结论且不抛错。因此 `r1-api.mjs` 在本脚本里按**信息项**运行——它的输出
连同真实退出码一起入库，但它的崩溃**不计入**门禁，也**从不**被记成「通过」。

## 已知缺口（H3）

同意书绑定的是**内容**，不绑定**目的地**：`POST /api/ai/providers` 把同一个
id 改指新端点后，已授权的内容就会发到新目的地。这在
`docs/30-MODEL-ADAPTER.md` §8「未实现与未验证」里登记为未实现，属 ATS-403
范围之外，建议另立跟进项。探针仍然把它报成 CONFIRMED，让这个缺口保持可见。
