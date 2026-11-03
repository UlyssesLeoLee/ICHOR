# ATS-101 复现脚本（Reproducible probes）

本目录是 ATS-101（SEIKOIST-146）基线冻结所依据的**可重跑复现脚本**。
基线文档 `docs/16-BASELINE-ADR.md` 的每一条阻断项与约束清单，都对应这里的某个脚本；
对应的实际输出记录在 `docs/evidence/ATS-101/`。

## 运行方式

```bash
# Node 探针（Windows / macOS / Linux 通用）
node tools/ats101-probes/scenario-a-b01-cli-args.mjs
node tools/ats101-probes/scenario-b-b01-control.mjs
node tools/ats101-probes/scenario-c-b03-cancelling-lock.mjs
node tools/ats101-probes/scenario-d-port-audit.mjs

# 构建环境探针（bash；Windows 下用 Git Bash 运行）
bash tools/ats101-probes/collect-build-constraints.sh
bash tools/ats101-probes/collect-b02-diagnosis.sh
bash tools/ats101-probes/collect-b02-gnu-diagnosis.sh
bash tools/ats101-probes/collect-b02-icon.sh
bash tools/ats101-probes/collect-b02-build-link.sh
```

## 目录约定

| 变量 | 含义 | 默认 |
|---|---|---|
| `ATS_PROBE_WORKDIR` | 夹具、沙箱与数据目录的根 | `$TMPDIR/ats101-probes` |
| `ATS_PROBE_LOG_DIR` | 构建类探针落盘完整构建输出的目录 | `$TMPDIR/ats101-probes` |

所有中间产物（真实 Playwright 夹具、被打了补丁的 `server/` 沙箱副本、Bridge 数据目录）
都落在 `$ATS_PROBE_WORKDIR` 下，**不进版本控制**。仓库里只有生成它们的脚本。

## 各脚本对应什么结论

| 脚本 | 结论 | 文档位置 |
|---|---|---|
| `scenario-a-b01-cli-args.mjs` | **B-01**：Bridge 传给 `playwright test` 的参数向量含两个不存在的选项，真实浏览器执行 100% 失败 | 16 §4 B-01 |
| `scenario-b-b01-control.mjs` | **B-01 对照实验**：仅在沙箱副本中去掉那两个选项即可工作；并证明 png/webm 来自夹具配置而非 Bridge | 16 §4 B-01 |
| `scenario-c-b03-cancelling-lock.mjs` | **B-03**：重启后 Run 卡在 `cancelling`，永久占锁且无法经 API 解除（C1 自然竞态 / C2 活着的 Playwright 子进程 / C3 预置状态） | 16 §4 B-03 |
| `scenario-d-port-audit.mjs` | **端口硬编码清单**：逐 `file:line` 核对 §3.1 与源码是否一致 | 16 §3.1 |
| `collect-build-constraints.sh` | 工具链、VS C++ 工作负载、两条工具链的 `cargo check` | 16 §4 B-02、§5.3 |
| `collect-b02-diagnosis.sh` | 执行 shell 对链接器错误文本的影响（Git Bash vs PowerShell） | 16 §4 B-02、证据 03 §3.8 |
| `collect-b02-gnu-diagnosis.sh` | gnu 链：编译器与运行时库不匹配的诊断 | 16 §4 B-02、证据 03 §3.7.1 |
| `collect-b02-icon.sh` | 仓库缺 `src-tauri/icons/icon.ico`（**仓库内容缺陷**：全新 clone 永远无法构建） | 16 §4 B-02 成因 2 |
| `collect-b02-build-link.sh` | **`cargo check` 通过但 `cargo build` 在最终链接时失败**（`ld.exe: error: export ordinal too large`）——证明类型检查通过不等于可构建。判定以链接器标记字符串为准，可区分「导出序号超限」「其他链接错误」「链接前失败」「cargo 无法启动」 | 16 §4 B-02 成因 4、ADR-014、证据 03 §3.10 |
| `stub-cargo.sh` | **判定逻辑的桩 cargo**：不执行真实构建。支持的**桩模式**共 7 个（`ordinal` / `other-link` / `compile-error` / `check-fails` / `check-fails-ordinal` / `rustc-crash` / `ok`），用于验证判定段确实能区分它们 | 16 §4 B-02 成因 4、证据 03 §3.10.2 |

## 纪律（务必遵守）

1. **不得修改产品源码。** 场景 B 与场景 C 的 C2 需要打补丁时，补丁只作用于
   `$ATS_PROBE_WORKDIR` 下的 `server/` **副本**；脚本会在输出中明确打印
   `product source : NOT MODIFIED`。
2. **对照实验不等于产品能力。** 沙箱副本证明的是「阻塞点在哪里」，
   **不能**据此宣称产品已具备该能力。
3. **每次改动后重跑。** 探针是可执行断言，文档里的数字应当来自探针输出，
   而不是手写。
4. **不得删除非本次生成的产品资产。** 探针在仓库内产生的临时文件（如
   `src-tauri/icons/icon.ico`）**只能删除本次运行自己创建的那一个**。
   若该文件在探针运行前就已存在（例如 ATS-104 已把它补进仓库），探针必须
   **保留**它并在输出中注明。`collect-b02-icon.sh` 与
   `collect-b02-build-link.sh` 都遵守这一条：它们用 `ICO_GENERATED` 标记
   区分「本次生成」与「预先存在」，只删除前者。
5. **判定必须能区分不同失败。** `collect-b02-build-link.sh` 用**两个独立信号**判定：
   **退出码**说明 cargo 是否产出过构建结果，**build 日志**说明那是哪一种失败。
   脚本把 `cargo build` 的完整输出落盘（**不使用
   `--message-format short`**，否则 rustc 的 `= note:` 子诊断——链接器原文所在
   ——会被丢弃），再以标记字符串 `export ordinal too large` 判定成因 4。
   判定段区分**五类判定形态**——数的是**判定形态**，不是桩模式个数：
   - **成因 4**：build 退出码 101、日志含 `export ordinal too large`
     → `CAUSE 4 REPRODUCED`；
   - **其他链接错误**：build 退出码 101、日志含 rustc 的链接失败标头
     `linking with`、但无上述标记 → 报告「链接器已到达，但失败原因不是成因 4」；
   - **链接前失败**：build 退出码 **101**、日志**不含** `linking with` 标头
     （编译错误、rustc 崩溃）→ 报告「构建在链接之前就失败了，本次未评估成因 4」；
   - **cargo 无法启动**：shell 退出码 **126/127**（文件不存在、不可执行，
     或解释器缺失导致启动失败）→ 报告「探针未真正调用 cargo，这是探针配置问题」，
     **不得**报成编译错误或 rustc 崩溃；
   - **cargo/工具链未正常运行**：其他非 0 退出码（如 1、2；工具链未安装、
     日志目录不可写等）→ 报告「cargo/工具链未正常运行（exit N），本次无构建判定」，
     **不得**报成编译错误或 rustc 崩溃。

   **只有退出码 101（cargo 自己的构建失败码）才允许被判成编译错误或 rustc 崩溃。**
   126/127 是 **shell** 的退出码而非 cargo 的，其他非 0 码说明 cargo 根本没有
   跑到构建结果——把它们报成编译失败会让真实原因被误判。
   反过来，编译失败与链接失败的 cargo 退出码都是 101，仅凭退出码无法分辨；
   把编译失败报成「另一种链接失败」会让回归时的真实编译错误被误判——所以
   退出码与日志两个信号缺一不可。
   **成因 4 的判定只来自 build 步骤**：`cargo check` 非 0 退出时，判定段只陈述
   check 失败本身，不对成因 4 下结论，因此 check 失败与 build 的判定不会互相
   矛盾。

   **路径类覆盖变量在 `cd` 之前解析为绝对路径**：`ATS_PROBE_CARGO` 与
   `ATS_PROBE_LOG_DIR` 均按**启动探针时的工作目录**解析，所以相对路径写法
   （如 `ATS_PROBE_CARGO=tools/ats101-probes/stub-cargo.sh`）在探针 `cd` 进
   `src-tauri/` 之后仍然指向同一个文件。

   **桩 cargo 实际能复现什么**：桩只控制 build 日志的内容与 cargo 的退出码，
   因此它能复现的是**前 3 类判定形态**（成因 4 / 其他链接错误 / 链接前失败）
   以及它们与 check 失败的组合——**「cargo 无法启动」这一类无法由桩产生**
   （桩一旦被调用，cargo 就已经启动了）。该类用**不存在或不可执行的
   `ATS_PROBE_CARGO` 路径**复现：`ATS_PROBE_CARGO=tools/ats101-probes/nope.sh`
   （不存在 → 127）与 `ATS_PROBE_CARGO=README.md`（不可执行 → 126）。

   桩模式与判定形态的对应关系（**桩模式 7 个，判定形态 5 类，二者不是一回事**）：

   | 桩模式 | 产出 | 对应的判定形态 |
   |---|---|---|
   | `ordinal` | build 退出码 101 + 标记 | 成因 4 |
   | `other-link` | build 退出码 101 + `linking with` 标头 | 其他链接错误 |
   | `compile-error` | build 退出码 101，无标头 | 链接前失败 |
   | `rustc-crash` | build 退出码 101，无标头 | 链接前失败 |
   | `check-fails` | check 退出码 101，build 退出码 0 | check 失败 + build 成功 |
   | `check-fails-ordinal` | check 退出码 101，build 退出码 101 + 标记 | check 失败 + 成因 4 |
   | `ok` | check 与 build 均退出码 0 | 构建成功 |

   在仓库根目录运行（`ATS_PROBE_CARGO` 用相对路径）：

   ```bash
   # 桩 cargo：ordinal（成因 4）/ other-link（其他链接错误）/ compile-error（链接前失败）
   ATS_PROBE_STUB_MODE=compile-error \
   ATS_PROBE_CARGO=tools/ats101-probes/stub-cargo.sh \
   bash tools/ats101-probes/collect-b02-build-link.sh

   # 「cargo 无法启动」不由桩产生：用不存在 / 不可执行的路径复现
   ATS_PROBE_CARGO=tools/ats101-probes/nope.sh \
   bash tools/ats101-probes/collect-b02-build-link.sh   # => 127，探针配置问题
   ATS_PROBE_CARGO=README.md \
   bash tools/ats101-probes/collect-b02-build-link.sh   # => 126，探针配置问题
   ```

## 端口提及说明

本目录的脚本会写明它们审计的端口号（例如 `scenario-d-port-audit.mjs` 审计
端口 `4577`），因此 `tools/ats101-probes/` 下的端口字面量属于**文档提及**，
不是运行时硬编码——探针按目录归类，不会把它们报成「运行时硬编码点」。

端口审计的 (c) 类（文档提及）判定依据是**文件扩展名**：任何 `.md` 文件都属于
(c) 类，无论它位于 `docs/` 下还是仓库根。因此在仓库根新增一份提到端口的
`.md` 文件会被计入 (c) 类统计，并使探针报 `RESULT: MISMATCH`——它**不会**被
报成运行时硬编码点。


## 依赖

- Node ≥ 22（根 `package.json` `engines`）
- 真实 `@playwright/test` 1.64.1 + 对应版本的浏览器（本机 `ms-playwright` 缓存需命中）
  —— 夹具的 `node_modules` 由脚本用 npm 自动安装
- Rust 工具链（仅 `collect-*` 脚本需要）：`~/.cargo/bin/cargo.exe`
