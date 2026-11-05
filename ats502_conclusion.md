## ATS-502（SEIKOIST-218）远程调度内核——已完成实现，待复核

分支 `agent/m2/seikoist-218`（基线 `34f39f2`，本任务提交在其上）。WBS 行状态已置为「待审核」。

### 交付物

| 文件 | 内容 |
|---|---|
| `server/queue.mjs` | 调度内核：Job 状态机、租约、心跳、幂等键、重试、租户隔离、持久化 |
| `server/scheduler.mjs` | 部署式调度服务的 HTTP 面（独立端口 4580，与本地 Bridge 分离） |
| `tests/queue.test.mjs` | 31 项单元测试（注入时钟，无 sleep、无真实等待） |
| `tests/scheduler.test.mjs` | 19 项 HTTP 集成测试 |
| `tools/ats502-probes/audit-scheduling-core.mjs` | 30 项机读契约/边界/WBS 校验 |
| `tools/ats502-probes/mutation-tests.mjs` | 11 项变异负控（含 ZIP 成员级 WBS 变异） |
| `tools/ats502-probes/lib/xlsx-zip.mjs` | 最小 ZIP 读写：只替换目标成员，其余成员字节不变 |
| `tools/update_wbs_ats502.py` | WBS 行同步（幂等、不回退已验收行） |
| `docs/21-REMOTE-SCHEDULING.md` | ADR-024~028 + 「PENDING ≠ PASS」未实现清单 |

### 三条验收不变量

1. **断连重投不双跑**——一个作业任一时刻至多一个活跃租约；租约过期退回队列并开启新 attempt，旧节点永久失去回写终态的权利（`REMOTE_JOB_NOT_LEASABLE`）；终态作业被租用时拒绝而非伪装成成功。
2. **心跳超时可恢复**——心跳续租且 seq 单调校验；租约过期或超 deadline 时心跳被拒（`REMOTE_LEASE_EXPIRED`），作业退回队列或按 deadline 记 `interrupted`；`releaseNode` / `sweep()` 可回收。
3. **重放结果幂等**——`dispatch`/`ack`/`result`/`cancel` 必填幂等键；同键同体返回首次结果、同键异体拒 `REMOTE_IDEMPOTENCY_CONFLICT`；终态只写一次。

### 边界（ATS-501 HB-1 / HB-7）

调度服务不 import `server/index.mjs`、不发起指向 `127.0.0.1:4577` 的请求、不读 Runner 文件系统、不把本地绝对路径当资源引用；不 spawn 任何 Runner 进程（执行属 ATS-301/504）。租户由服务端从节点绑定推导，跨租户统一 404。

### 实测证据（`docs/evidence/ATS-502/`）

| 项 | 结果 |
|---|---|
| `audit-scheduling-core.mjs` | 30/30 通过 |
| `mutation-tests.mjs`（负控） | 11/11 变异均使审计变红 |
| `node --test tests/queue.test.mjs` | 31/31 |
| `node --test tests/scheduler.test.mjs` | 19/19 |
| WBS 共存回归 | 7 个 updater 顺序无关、幂等、不回退已验收行 |
| 端口审计 | OK |
| CHECKSUMS | 211 条，0 mismatch |

`npm test` 为 228 通过 / 1 失败 / 10 跳过。唯一失败是 `tests/api.test.mjs` 的 IT-API-013，**在本任务开始前的干净树上同样失败**（已用独立 worktree 在 `34f39f2` 上复现），与 ATS-502 无关。

### 顺带修复的两处既有缺陷

- **端口审计在 `34f39f2` 上已是红的**：ATS-301 的 `tools/check_adr_citations.py` 引入了两处端口字面量却未登记到 `16-BASELINE-ADR.md` §3.1。已把它归入「非运行时数据」桶并同步 §3.1；同时把 §3.1 的 (c) 类统计口径校正为探针实际声明的「除本文件与探针目录外的全部 `.md`」，审计恢复为绿。
- **`server/queue.mjs` 内嵌 2 个裸 NUL 字节**（模板字符串里的 `\x00`），导致 git 把该文件当二进制。已改写为等价的 `\x00` 转义，运行时值不变，文件恢复为纯文本，测试仍 50/50 通过。

### 已验证 vs 未验证

**已验证**：调度语义（队列/租约/心跳/幂等/重试/租户隔离）、与 ATS-501 冻结拒绝码表的逐项一致性、HB-1/HB-7 边界、WBS 行状态与文档同步。

**未验证（明确声明，不得外推）**：节点协议/签名/enrollment（ATS-503）；工作树隔离、精确 SHA、配额、清理（ATS-504）；真实 Runner 执行与真实浏览器链路（ATS-301/504）；证据回流与 SHA-256 校验（ATS-509）；审计事件流（ATS-508）；多实例并发写同一队列文件（持久化无跨进程写锁）；长轮询/出站流协议形态；`REMOTE_RATE_LIMITED` / `REMOTE_QUOTA_EXCEEDED` 的产生条件（码在表内但本模块不产生）。

**FR-028 的能力状态仍为 `DESIGNED`**，本任务未改变它——调度内核已实现不等于远程执行已实现。

### 未完成项

- `git push` 到远端两次均因凭据交互挂起超时；远端目前只有 `main`，本任务的交付载体是本 worktree 分支 `agent/m2/seikoist-218`（已确认包含基线 `34f39f2`）。
- 合并回 `dev` 未执行：按 AGENTS.md 的结论复核门禁，须先经 Opus 复核通过。

Original executor: M2
