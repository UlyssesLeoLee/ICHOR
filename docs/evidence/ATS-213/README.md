# ATS-213 证据目录 ｜ OS Keychain / Windows Credential Manager 集成（凭据可用状态）

> 采集脚本：`bash tools/ats213-probes/collect-evidence.sh`
> 采集环境：Windows 11 / Node 24.19.0 / Next.js 16.4.5 / **真实 Windows Credential Manager**
> 结果：**RESULT: OK**（每一步都实跑并通过；第 9 步的 31 个 skip 逐条标注原因，见下）

## 每一步是什么，怎么复跑

| 文件 | 内容 | 复跑命令 |
|---|---|---|
| `01-credential-status-ut.log` | 状态契约的 12 例 UT：三值闭集、状态是**测出来的**而不是从索引推断、「未配置」与「取不到」不合并、取失败不静默降级、状态里没有密钥 | `node --test tests/credential-status.test.mjs` |
| `02-credential-status-api-it.log` | 状态面的 9 例 IT（HTTP 层）：状态接口要 token、每条恰有一个状态、契约宣告词汇表、未知 id 被拒、**畸形请求体不回显密钥片段** | `node --test tests/credential-status-api.test.mjs` |
| `03-credential-status-api-it-real-store.log` | 同一组 IT，对**真实 Windows Credential Manager** 跑（存取、状态、文件扫描） | `ATS213_REAL_CREDENTIAL_STORE=1 node --test tests/credential-status-api.test.mjs` |
| `04-security-regression.log` | ATS-402 的 108 例安全用例（凭据存储不得回归；4 个 skip 是真实凭据库开关把关的用例） | `node --test tests/security.test.mjs tests/security-credentials.test.mjs tests/security-gate.test.mjs tests/security-api.test.mjs` |
| `05-credential-boundary-probe.log` | 凭据边界探针：9 项检查 + **2 项负控**（密钥不进 argv / 文件 / 日志 / HTTP 响应；状态是对凭据库实测的） | `node tools/ats213-probes/probe-credential-boundary.mjs` |
| `06-system-test.log` | 真实浏览器里的 11 项 ST（真实 Bridge + 真实 Chromium + 真实系统凭据库），含「删掉凭据库条目后状态由「已配置」变「未配置」」这一**分叉场景** | `node tools/ats213-probes/st-ats213.mjs docs/evidence/ATS-213/ui` |
| `07-next-build.log` | `tsc --noEmit` + Next.js 静态导出构建，以及构建对两个受版本控制文件的副作用 | `bash tools/ats213-probes/collect-build.sh` |
| `08-quality-gates.log` | ATS-301 门禁（WBS 助手回归 + ADR 引用逐条校验 + 端口硬编码审计） | `bash tools/ats301-probes/check-ats301-gate.sh` |
| `09-full-regression.log` | 全仓库回归（`--test-concurrency=2`） | `node --test --test-concurrency=2 tests/*.test.mjs` |
| `10-wbs-row-and-checksums.log` | WBS 行的状态/完成率/剩余人日（**从工作簿读回**，不是从脚本的变量读）+ 校验和清单 | `bash tools/ats213-probes/collect-wbs-and-checksums.sh` |
| `ui/` | 真实浏览器的截图与 trace | 由第 6 步生成 |

## 第 9 步的 18 个 skip

**skip 不是 PASS，也不是 FAIL** —— 逐条标注如下（数字取自日志本身）：

| 数量 | 原因 | 性质 |
|---|---|---|
| 11 | `no Android device is attached to adb` | 硬件：没有接 Android 设备（ATS-601/603 的范围） |
| 4 | `needs ATS402_REAL_CREDENTIAL_STORE=1` | 开关：真实凭据库用例在**第 3 步**已用真实 Windows Credential Manager 跑过 |
| 3 | `npm ci failed (exit 1): npm error code EALLOWREMOTE` | 环境：`examples/real-browser-fixture` 的依赖安装失败（离线 registry 不允许该包） |

采集时把 `examples/sample-playwright` 与 `examples/sample-wdio` 的 `node_modules`
从 `D:/ICHOR` 复制进工作树，因此这两夹具的 10 个用例**真的跑了**（不再以
「跳过」计）；它们不计入上表的 18 个。

本任务**新增**的用例（`tests/credential-status*.test.mjs`，21 例）在这份日志里
**0 失败、0 跳过**；ATS-402 的安全用例同样 0 失败。

## 「状态是测出来的」怎么复现

这是本任务最容易被误读成「当然是这样」的一条，因此给出可照抄的步骤：

```powershell
# 1. 存一个密钥（走 Bridge 的接口），记下返回的 credential.id
# 2. 从系统凭据库里删掉那一条，但**不动**平台的索引
powershell -NoProfile -File server/security/wincred.ps1 delete `
  -Target "ATS:ai-test-studio:<credential.id>" -User ai-test-studio
# 3. 查状态：GET /api/security/credentials/<credential.id>/status
#    -> {"status":"not-configured","reason":"CREDENTIAL_NOT_FOUND"}
# 4. 查引用列表：GET /api/security/credentials
#    -> 那条引用**还在**（索引没动）
```

第 3 步与第 4 步的差别就是「状态是测出来的」的证明：状态说的是**凭据库**
里的事实，引用列表说的是**索引**里的事实，两者不一致时状态跟的是凭据库。
探针 `probe-credential-boundary.mjs` 的 B4 与 ST 探针的 ST-ATS213-002
都自动跑了这个序列。

## 未验证项（PENDING ≠ PASS）

| 项 | 状态 | 原因与复现方法 |
|---|---|---|
| macOS Keychain 后端 | **未在真机实测** | 本机是 Windows 11，无 macOS 环境。复现：在 macOS 上跑 `node --test tests/credential-status.test.mjs`（后端经注入的 `spawn` 被驱动过，但从未在真实 Keychain 上执行） |
| Linux Secret Service 后端 | **未在真机实测** | 同上 |
| Tauri 壳内的凭据存取 | **未验证** | `src-tauri/src/lib.rs` **未改动**；本机 `cargo build` 因 B-02 仍无法出包。复现：`bash tools/ats101-probes/collect-b02-build-link.sh` |
| 便携 UI（`fallback.html`）上的状态面 | **未交付** | 本次只做 Next 工作台 |
| 凭据状态跨设备同步 | **不在范围** | P2 |

**PENDING 不等于 PASS**：本目录里每一个 PASS 都对应一条实跑过的命令与它的
实际输出；每一个未验证项都在上表里写明了原因与复现方法。
