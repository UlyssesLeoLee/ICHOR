# ATS-501 验证脚本（Remote protocol contract checks）

本目录是 ATS-501（SEIKOIST-217）远程协议冻结所依据的**可重跑校验脚本**。
基线文档 `docs/18-REMOTE-RUNNER-PROTOCOL.md` 的机读契约块，由这里的脚本校验
其不变量与正文的一致性；对应的实际输出记录在 `docs/evidence/ATS-501/`。

## 运行方式

```bash
# 协议契约校验（Node 22+，跨平台）
node tools/ats501-probes/audit-remote-protocol.mjs

# WBS 更新脚本的共存回归（bash；Windows 下用 Git Bash 运行）
bash tools/ats501-probes/check-wbs-updaters.sh
```

## 各脚本对应什么结论

| 脚本 | 结论 | 文档位置 |
|---|---|---|
| `audit-remote-protocol.mjs` | 协议契约块是合法 JSON 且满足自身不变量；契约块与 §2/§3/§4/§5/§6/§9 正文表格**双向一致**；`REMOTE_` 拒绝码与本地 Bridge 错误码**不重名**；ATS-501 行在 WBS 中的状态/完成率/剩余人日三元组自洽；五项验收要素各有专章；FR-028/FR-030 仍为 `DESIGNED`；ADR 编号与基线登记不冲突 | 17 §1/§2/§6/§10/§11/§13 |
| `check-wbs-updaters.sh` | 两个 WBS 更新脚本**不互相覆盖**：任一顺序结果相同、重复执行不变、总览缓存与开发WBS 一致；且 ATS-101 更新脚本能**逐字节复现已提交的基线工作簿** | 17 §13、WBS「开发WBS」ATS-501 行 |

## 纪律（务必遵守）

1. **协议校验只覆盖文档自身的一致性，不覆盖任何远程运行时行为。**
   远程执行面在仓库中不存在，因此没有可执行的运行时行为可校验。
   不得把本目录的脚本输出当作远程能力的实机证据。
2. **正文与机读契约块必须同改。** 只改正文表格会让
   `audit-remote-protocol.mjs` 报 `RESULT: MISMATCH`；这是有意的——
   协议冻结要求两侧同时成立。
3. **不得把 `DESIGNED` 写成已实现。** 校验脚本会检查文档里有没有
   「已实现 / IMPLEMENTED」这类无条件表述，并检查 FR-028/FR-030 的
   `DESIGNED` 标记是否被改动。
4. **WBS 更新脚本必须可重复执行且不互相破坏。** 备注写入用
   `【ATS-101】` / `【ATS-501】` 标记分块，各脚本只改自己那块；
   总览的缓存值由 `tools/wbs_common.py` **从工作表推导**，不写死——
   写死的缓存一旦有第二个脚本改动行就会与工作表不一致。
5. **Windows 上原生程序路径**：`python` 是原生程序，不做 MSYS 路径转换；
   脚本内传给它的路径须先用 `cygpath -w` 转换（`check-wbs-updaters.sh`
   已如此处理）。

## 依赖

- Node ≥ 22（根 `package.json` `engines`）
- Python 3（仅 `check-wbs-updaters.sh` 需要；使用标准库 `zipfile`/`zlib`/`struct`）
- 仓库根的 `docs/WBS.xlsx`、`docs/02-REQUIREMENTS.md`、`docs/16-BASELINE-ADR.md`
