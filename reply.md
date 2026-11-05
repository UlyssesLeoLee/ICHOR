## ATS-401（第 4 次复核驳回后的定向返工）—— 结论：已整改，待复核

分支 `agent/m2/seikoist-200-3a39d5f791de`（起点 `3573e04`）。复核范围的三项必须修改项全部落实，全部有实测证据。

### 第 1 项：路径解析与 git 逐字节一致

**复核说的现象是否复现：复现。** 复核附件 `ce4.mjs` 在整改前的实测输出：

- `b/tests/new\r.spec.ts` —— git 的 `--numstat` 报的是 `tests/new`（git 在 CR 处截断路径），而旧校验器全局 `replace(/\r/g,'')` 之后看到的是 scope 内的 `tests/new.spec.ts`，**两边看的不是同一个文件**；
- `b/tests/new.spec.ts ` —— git 保留路径尾部空白（`git apply` 直接报 `error: invalid path 'tests/new.spec.ts '`），旧校验器 `trim()` 之后放行。

**改法**（`server/agent.mjs`）：

- 只去掉**每行行尾的那一个** CR（CRLF 换行），行内 CR 原样保留并交给严格路径校验拒绝；不再有全局 CR 删除。
- 头部路径不再 `trim()`；路径含控制字符（0x00~0x1f、0x7f）或首尾带空白一律拒绝，**不做静默清洗**（清洗会把越界操作伪装成合法目标）。
- 实现完整的 C 风格引号路径反转义；无法可靠解析时拒绝而不是猜一个路径。
- 仓库路径必须带 `a/` 或 `b/` 前缀；`+++ /dev/null` 视为删除目标并拒绝。

### 第 2 项：全量删除内容的传统 diff —— 选 (a) + (b) 兼用

实测（`git apply --numstat --summary`，git 2.x）：

| 输入 | git 的 summary |
|---|---|
| 传统 diff（无 `diff --git` 头），新侧一行不剩 | `delete <path>` |
| 同一 diff 加 `diff --git` 头 | **不报** delete |

据此：**没有 `diff --git` 头、且新侧没有任何 hunk 行**的段一律拒绝（口径与「删除一律拒绝」一致），错误码 `traditional-diff-deletes-file`；带 git 头的同类 diff 仍被接受（git 本身不视其为删除）。doc 17 §3 已写明这条实测口径与平台侧的处理方式。

**方向是保守且已穷举验证的**：构造 16 种传统 diff 形态逐一比对「git 判定为 delete」与「校验器是否放行」，**git 报 delete 的无一条被放行**（holes=0）。

### 第 3 项：收尾顺序

按「代码 → 文档 → 证据 → CHECKSUMS 最后一个提交 → `--no-ff` 合入 dev」执行，提交拆分如下：

| 提交 | 内容 |
|---|---|
| `e55e4e9` | fix(ATS-401)：第 4 次复核整改（代码 + UT + probe） |
| `bf1362c` | docs(ATS-401)：doc 17 补齐路径字节语义与删除规则；WBS 行同步 |
| `a025f31` | chore(ATS-401)：证据日志（10 个步骤） |
| `14b16e4` | chore(ATS-401)：regenerate CHECKSUMS.sha256（199 条） |
| `822f139` | Merge dev `c5f500c` 进本分支（共享文件冲突以 dev 为基准重新生成，ATS-401/506/103 三行语义均保留） |
| `1b4f840` | docs(ATS-401)：合并 dev 后的测试计数与端口审计说明 |
| `890a98a` | chore(ATS-401)：合并 dev 后重新采集证据 |
| `8bc507c` | chore(ATS-401)：regenerate CHECKSUMS.sha256（250 条，最后一个提交） |

### 关键证据

**复核 harness `ce4.mjs`（复核附件，本轮实测）：**

| 用例 | 结果 |
|---|---|
| `r4: CR inside a new-file path` | rejected（`quoted-or-invalid-diff-path`）|
| `r4: CR inside a modified path` | rejected |
| `r4: trailing space after a new-file path` | rejected |
| `r4: form feed after a new-file path` | rejected |
| `r4: two spaces before a new-file path` | rejected |
| `r4: vertical tab inside a new-file path` | rejected（保持现状）|
| `r4: traditional diff that removes every line` | rejected（`traditional-diff-deletes-file`，第 2 项 (a)）|
| `r4: same, with a diff --git header` | accepted |
| `r3:` 三个用例 | 继续 rejected（保持现状）|
| `real git diff:` 四个用例 | 继续 accepted（保持现状）|

**其它实测：**

- `npm test`：**239 项全通过，0 失败、0 跳过**（合并 dev `c5f500c` 之后）。Agent 契约相关 105 项（UT-AGT 90 + IT-AGT 15）。
- ATS-401 六个探针全部 PASS：`probe-agent-boundary` / `probe-git-apply-parity` / `probe-git-apply-bidirectional` / `probe-review-regressions` / `probe-review-regressions-r2` / `probe-review-regressions-r4`（新增，第 4 轮反例 + 删除形态的双向核对）。
- `python tools/verify_checksums.py` → `RESULT: OK`（250 条，0 mismatch / 0 tracked-not-listed / 0 listed-not-tracked）。
- 证据日志 10 个步骤落在 `docs/evidence/ATS-401/`。

### 已验证 / 未验证

**已验证：**

- 上述三項必须修改项的全部行为，均由 `ce4.mjs` + 新增的 `probe-review-regressions-r4.mjs` + `tests/agent.test.mjs`（新增 UT-AGT-086~090）双向核对。
- 「校验器拒绝」与「git 确实解析到另一个路径」是**两侧分别实测**的，不是只测校验器一侧。
- 传统 diff 删除判定的保守性：16 种形态穷举，holes=0。
- 全量测试 239/239；证据 10 步；checksums OK。

**未验证 / 非本任务项：**

- **`scenario-d-port-audit`（证据第 3 步）仍然 exit=1**：这是 **ATS-103 在 dev 上留下的既有缺口**——ATS-103 新增的 `tools/ats103-probes/verify-export-and-proxy.mjs` 与 `tools/update_wbs_ats103.py` 提到端口但未被探针分桶、也未列入 `docs/16-BASELINE-ADR.md` §3.1。同一 mismatch 在 dev（`D:/ICHOR` @ `c5f500c`）上**原样复现**（只差一个已被 dev 修掉的旧残留项），因此**不是 ATS-401 回归**，属 ATS-101/ATS-103 的整改范围。本轮未擅自改动他人语义的 §3.1 清单，只在证据说明里写明真实原因。
- **本轮未做真实 Playwright/WDIO 实机跑测**：与前几轮一致，`npm test` 中的 fixture 集成用例是 mock/契约级；实机跑测属平台侧落地流程（doc 17 已说明），不在本任务范围。
- **「与 git 完全等价」未被证明**：结论只覆盖「在双向差分语料上一致」，语料之外的 diff 形式未证明。doc 17 §3 已按此口径表述。
- 平台侧落地前仍需以 git 自己的解析器再校验一次（doc 17 §2.3）。

### 冲突处理说明

合并 dev `c5f500c` 时 `CHECKSUMS.sha256` 与 `docs/WBS.xlsx` 冲突，按要求**以 dev 版本为基准重新生成**（不是拿分支上的旧版覆盖）：`tools/update_wbs_ats401.py` 在 dev 的工作簿上重新施加 ATS-401 行，AST-401 / ATS-506 / ATS-103 三行的状态、进度与备注经解析核对均完整保留。

Original executor: M2
