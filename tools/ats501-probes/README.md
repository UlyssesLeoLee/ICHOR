# ATS-501 验证脚本（Remote protocol contract checks）

本目录是 ATS-501（SEIKOIST-217）远程协议冻结所依据的**可重跑校验脚本**。
基线文档 `docs/19-REMOTE-RUNNER-PROTOCOL.md` 的机读契约块，由这里的脚本校验
其不变量与正文的一致性；对应的实际输出记录在 `docs/evidence/ATS-501/`。

## 运行方式

```bash
# 协议契约校验（Node 22+，跨平台）
node tools/ats501-probes/audit-remote-protocol.mjs

# 负向夹具：证明上面那份校验会变红，而不是空转通过
node tools/ats501-probes/mutation-tests.mjs

# WBS 更新脚本的共存回归（bash；Windows 下用 Git Bash 运行）
bash tools/ats501-probes/check-wbs-updaters.sh

# 一键重新生成本目录对应的证据日志
bash tools/ats501-probes/collect-evidence.sh
```

## 各脚本对应什么结论

| 脚本 | 结论 | 文档位置 |
|---|---|---|
| `audit-remote-protocol.mjs` | 协议契约块是合法 JSON 且满足自身不变量；契约块与 §2/§3/§4/§5/§6/§9 正文表格**双向一致**；**全文**所有 `REMOTE_` 令牌都是已登记的拒绝码；`REMOTE_` 拒绝码与本地 Bridge 错误码**不重名**；拒绝策略表（§6.1）与契约块在码、HTTP 状态、可重试性上一致；ATS-501 行在 WBS 中的状态/完成率/剩余人日三元组自洽；五项验收要素各有专章；FR-028/FR-030 仍为 `DESIGNED`；ADR 编号与基线登记不冲突；文档没有「已实现」的无条件表述 | 19 §1/§2/§3/§6/§7/§10/§11/§13 |
| `mutation-tests.mjs` | 上述校验**非空转**：11 组负向夹具（码表外的 `REMOTE_` 令牌、拼写错误、未限定的「已实现」表述、控制平面下发私钥、节点存在性泄漏、策略拒绝落到 500、删除代码获取章节、反转连接方向、工作簿缺行、非法状态值）逐一都会让审计变红 | 19 §13 |
| `check-wbs-updaters.sh` | **五个** WBS 更新脚本（ATS-101 / ATS-101_done / ATS-102 / ATS-401 / ATS-501）**不互相覆盖**：任一顺序结果相同、重复执行不变、总览缓存与开发WBS 一致、已验收（已完成）状态不被回退、共享的 D6/D7 保留每个任务各自的文字 | 19 §13、WBS「开发WBS」ATS-501 行 |
| `collect-evidence.sh` | 把上述命令的**实际输出**连同 commit、时间戳写进 `docs/evidence/ATS-501/` | — |
| `show-wbs-row.py` | 只读地打印 ATS-501 行与总览缓存，作为证据日志的一部分 | — |

## 纪律（务必遵守）

1. **协议校验只覆盖文档自身的一致性，不覆盖任何远程运行时行为。**
   远程执行面在仓库中不存在，因此没有可执行的运行时行为可校验。
   不得把本目录的脚本输出当作远程能力的实机证据。
   `mutation-tests.mjs` 证明的是**校验本身有效**，不是远程行为被验证了。
2. **正文与机读契约块必须同改。** 只改正文表格会让
   `audit-remote-protocol.mjs` 报 `RESULT: MISMATCH`；这是有意的——
   协议冻结要求两侧同时成立。
3. **不得把 `DESIGNED` 写成已实现。** 校验脚本会检查文档里有没有
   「已实现 / 已上线 / 已交付」这类无条件表述（句级否定匹配，中文不适用
   JS 的 `\b`），并检查 FR-028/FR-030 的 `DESIGNED` 标记是否被改动。
   匹配器本身有正/负控制项，所以「这条检查会变红」是可证伪的。
4. **WBS 更新脚本必须可重复执行且不互相破坏。** 备注写入用
   `【ATS-101】` / `【ATS-102】` / `【ATS-401】` / `【ATS-501】` 标记分块，
   各脚本只改自己那块；分块按 `wbs_common.MARKERS` 的**规范顺序**重排，
   因此与运行顺序无关。总览的 D6/D7 由 `tools/wbs_common.py` 组成为
   **各任务片段的合集**，任何脚本都不会覆盖别人的文字；B8/B9/B10 的缓存值
   同样**从工作表推导**，不写死——写死的缓存一旦有第二个脚本改动行就会与
   工作表不一致。
5. **Windows 上原生程序路径**：`python` 是原生程序，不做 MSYS 路径转换；
   脚本内传给它的路径须先用 `cygpath -w` 转换（`check-wbs-updaters.sh`
   已如此处理）。

## 依赖

- Node ≥ 22（根 `package.json` `engines`）
- Python 3（`check-wbs-updaters.sh`、`show-wbs-row.py` 需要；仅用标准库
  `zipfile`/`zlib`/`struct`）
- 仓库根的 `docs/WBS.xlsx`、`docs/02-REQUIREMENTS.md`、`docs/16-BASELINE-ADR.md`
