/**
 * ATS-502 ｜ 远程调度核心（Job queue / lease / heartbeat / idempotency / retry）
 *
 * 本模块是 S5/v1.0.0 的**调度内核**：它实现远程执行面里「作业从排队到终态」
 * 的全部状态转换与不变量。它**不**包含：
 *   - 节点入网、密钥、请求签名（ATS-503）；
 *   - 工作树、精确 SHA、配额与清理（ATS-504）；
 *   - 证据存储与租户隔离的存储层（ATS-509/508）；
 *   - 真实 Runner 的执行（ATS-301/504）。本模块对执行方只保留一个
 *     `executor` 接口，测试与联调用假执行器驱动，**不 spawn 任何进程**。
 *
 * 上游依据：docs/19-REMOTE-RUNNER-PROTOCOL.md（ATS-501 冻结的协议）、
 * docs/04-DETAILED-DESIGN.md §3（状态机）、docs/02-REQUIREMENTS.md FR-028。
 * 下游消费：ATS-503（节点注册/重连）、ATS-504（工作树与配额）、
 * ATS-505（CI 双向）、ATS-506（部署式 API 与本地 API 边界分离）。
 *
 * ── 三条验收不变量（完成定义）──────────────────────────────────────────
 *
 * 1. **断连重投不双跑**：一个作业在任一时刻至多有一个**活跃租约**。
 *    `lease()` 对已持有活跃租约的作业拒绝 `REMOTE_JOB_NOT_LEASABLE`；
 *    租约过期后作业退回队列并开启新的 attempt，**旧 attempt 记为
 *    interrupted**。作业的**终态**只写一次：终态后任何 lease/result/cancel
 *    都返回既有终态结果，不再改变状态（幂等终态操作）。
 * 2. **心跳超时可恢复**：`heartbeat()` 续租；租约过期（`now > expiresAt`）
 *    时心跳被拒 `REMOTE_LEASE_EXPIRED`，同时作业**退回队列**（若未到
 *    deadline）等待重新派发；超过 deadline 的作业记为 `interrupted` 终态。
 *    节点会话失效时 `releaseNode()` 把该节点名下所有作业退回队列。
 *    **`running` 态与 `leased` 态走同一条回收路径**——执行中的节点掉线是
 *    最常见的断连形态，租约过期后作业同样必须可被回收。
 * 3. **重放结果幂等**：带幂等键的 `dispatch` / `ack` / `result` / `cancel`
 *    同键同体返回**首次结果**，同键异体拒绝 `REMOTE_IDEMPOTENCY_CONFLICT`。
 *    **首次失败也必须被记录**：失败的请求重放时返回**同一个失败**，不得
 *    因为重放而变成一次成功。
 *
 * ── 租约 fencing（不变量 1 的执行机制）──────────────────────────────────
 *
 * 租约是一次派发的**身份**。`lease()` 发放 `leaseId`，`ack` / `heartbeat` /
 * `result` 必须回带它：
 *   - 不匹配当前租约 → `REMOTE_JOB_NOT_LEASABLE`；
 *   - 缺失 `leaseId` → 同样 `REMOTE_JOB_NOT_LEASABLE`（无法证明持有租约）；
 *   - 作业已进入终态时，非持有者的 `result` **也**被拒绝——不得返回
 *     `200 replayed:true`，那会让旧节点误以为自己的结果被接受。
 * 幂等表按 (租户, 键) 索引，并**记录该次请求所属的租约**：同键同体且租约
 * 相同才是重放；同键同体但租约不同是另一个 attempt 在冒名，拒绝。
 *
 * ── 与 ATS-501 契约的对应 ────────────────────────────────────────────────
 *   - §6.2 拒绝码：全部使用 `REMOTE_` 命名空间，HTTP 语义见
 *     `REJECTION_CODES`；队列自身不产生 500 兜底码。
 *   - §7.3 幂等：`dispatch` / `cancel` / `result` / `ack` 必填幂等键。
 *   - §4.3 会话失效 → 作业退回队列（本模块 `releaseNode`）。
 *   - §7.3 deadline 强制：作业超过 deadline 不得再回写终态。
 *   - §5.1 租户上下文由服务端推导：租户由**控制平面**从节点绑定推导，
 *     客户端携带的 tenantId 必须与节点绑定一致，否则
 *     `REMOTE_TENANT_MISMATCH`。
 *
 * 本模块**不**含 I/O 之外的网络与进程调用；持久化是可选的（传入
 * `file` 即落盘），时间由 `now` 注入以便测试确定性。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** ATS-501 §6.2 的拒绝码（与 docs/19-REMOTE-RUNNER-PROTOCOL.md 一致）。 */
export const REJECTION_CODES = Object.freeze({
  REMOTE_UNAUTHENTICATED: { http: 401, retryable: false },
  REMOTE_ENROLLMENT_TOKEN_INVALID: { http: 401, retryable: false },
  REMOTE_PROTOCOL_MISMATCH: { http: 409, retryable: false },
  REMOTE_CAPABILITY_MISSING: { http: 409, retryable: false },
  // ATS-601 的执行目标码。本调度内核**不产生**它（它属于移动端执行目标，
  // 不属于作业队列），但整张冻结码表在这里保持完整——表与协议一旦漂移
  // 就无法机械校验。
  REMOTE_TARGET_UNAVAILABLE: { http: 409, retryable: false },
  REMOTE_TENANT_MISMATCH: { http: 403, retryable: false },
  REMOTE_TENANT_REQUIRED: { http: 403, retryable: false },
  REMOTE_ROLE_FORBIDDEN: { http: 403, retryable: false },
  REMOTE_POLICY_REJECTED: { http: 403, retryable: false },
  REMOTE_JOB_NOT_FOUND: { http: 404, retryable: false },
  REMOTE_RESOURCE_NOT_FOUND: { http: 404, retryable: false },
  REMOTE_JOB_NOT_LEASABLE: { http: 409, retryable: true },
  REMOTE_LEASE_EXPIRED: { http: 409, retryable: true },
  REMOTE_IDEMPOTENCY_CONFLICT: { http: 409, retryable: false },
  REMOTE_QUOTA_EXCEEDED: { http: 429, retryable: true },
  REMOTE_RATE_LIMITED: { http: 429, retryable: true },
  REMOTE_PAYLOAD_TOO_LARGE: { http: 413, retryable: false },
  REMOTE_PATH_FORBIDDEN: { http: 422, retryable: false },
  REMOTE_SECRET_INLINE_FORBIDDEN: { http: 422, retryable: false },
  REMOTE_GIT_SHA_INVALID: { http: 422, retryable: false },
  REMOTE_CODE_UNAVAILABLE: { http: 422, retryable: false },
  REMOTE_TEST_UID_UNKNOWN: { http: 422, retryable: false },
  REMOTE_WORKSPACE_DIRTY: { http: 409, retryable: false },
  REMOTE_EVIDENCE_CHECKSUM_MISMATCH: { http: 422, retryable: false },
  REMOTE_RUNNER_UNREACHABLE: { http: 503, retryable: true },
  REMOTE_INTERNAL: { http: 500, retryable: true },
});

/** 作业状态。`leased` 是 ATS-501 §6.2 新增的中间态，其余沿用 §3 状态机。 */
export const JOB_STATES = Object.freeze([
  'queued',
  'leased',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

/** 终态：进入后不再改变（幂等终态操作，ATS-501 §6.2）。 */
export const TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'cancelled', 'interrupted']);

/** 终态作业可接受的回报状态。 */
export const RESULT_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled']);

/**
 * 租约时长的**服务端上限**。
 *
 * 租约时长曾经由客户端任意指定，一个节点可以申请 10 年的租约并从此
 * 静默——那样作业既不会被回收，也不会有别的节点能租走它，心跳超时这条
 * 恢复路径被单个节点绕过。租约时长因此是**服务端策略**：客户端可以
 * 申请更短的租约（缩短租期对服务端没有坏处），更长的则被截断到这个上限。
 */
export const MAX_LEASE_MS = 300_000;   // 5 分钟

/**
 * 租约时长的服务端下限。低于 1 秒的租约会让作业在派发与 ack 之间就
 * 过期，把「正常派发」变成「永远超时」，因此下限同样由服务端决定。
 */
export const MIN_LEASE_MS = 1_000;

/** 队列拒绝码错误。`code` 是稳定契约，调用方按码分支而非解析消息。 */
export class QueueError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'QueueError';
    this.code = code;
    this.details = details;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** 稳定的 JSON 序列化：键按字典序，摘要因此与字段书写顺序无关。 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

/** 请求体的稳定摘要，用于「同键同体 / 同键异体」判定。 */
export function requestDigest(request) {
  return sha256(canonical(request));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** RFC3339 毫秒精度（ATS-501 §3.3 对时间戳的精度约定）。 */
export function rfc3339(ms) {
  return new Date(ms).toISOString();
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 队列本体。
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now]   注入时钟（毫秒），默认 `Date.now`
 * @param {string}   [opts.file]      持久化文件；给出即每次变更原子落盘
 * @param {number}   [opts.leaseMs]   默认租约时长（服务端上下限 `MIN_LEASE_MS` / `MAX_LEASE_MS` 仍然生效）
 */
export class JobQueue {
  constructor(opts = {}) {
    this.now = opts.now || (() => Date.now());
    this.file = opts.file || null;
    this.leaseMs = this._clampLeaseMs(opts.leaseMs || DEFAULT_LEASE_MS);
    this.jobs = new Map();          // jobId -> job
    this.idempotency = new Map();   // `${tenantId}\x00${key}` -> {jobId, digest, result, leaseId, error}
    this.nodeTenants = new Map();   // nodeId -> tenantId（服务端绑定）
    if (this.file) this._load();
  }

  /* ---------------------------------------------------------------- */
  /* 持久化                                                             */
  /* ---------------------------------------------------------------- */

  _load() {
    if (!fs.existsSync(this.file)) return;
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const job of raw.jobs || []) this.jobs.set(job.jobId, job);
    for (const [k, v] of Object.entries(raw.idempotency || {})) this.idempotency.set(k, v);
    for (const [k, v] of Object.entries(raw.nodeTenants || {})) this.nodeTenants.set(k, v);
  }

  _save() {
    if (!this.file) return;
    const payload = {
      version: 1,
      jobs: [...this.jobs.values()],
      idempotency: Object.fromEntries(this.idempotency),
      nodeTenants: Object.fromEntries(this.nodeTenants),
    };
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /* ---------------------------------------------------------------- */
  /* 内部helpers                                                        */
  /* ---------------------------------------------------------------- */

  _record(job, event, detail = {}) {
    job.history.push({ at: rfc3339(this.now()), event, ...detail });
    job.updatedAt = rfc3339(this.now());
  }

  _idemKey(tenantId, key) {
    return `${tenantId}\x00${key}`;
  }

  _tenantOfNode(nodeId) {
    const t = this.nodeTenants.get(nodeId);
    if (!t) throw new QueueError('REMOTE_TENANT_REQUIRED', 'node has no tenant binding');
    return t;
  }

  /**
   * 校验客户端携带的租户上下文。
   * 租户由服务端从节点绑定推导；客户端携带的租户必须与之相同。
   */
  _assertTenant(nodeId, claimedTenantId) {
    const bound = this._tenantOfNode(nodeId);
    if (claimedTenantId !== undefined && claimedTenantId !== null && claimedTenantId !== bound) {
      throw new QueueError('REMOTE_TENANT_MISMATCH', 'tenant does not match the node binding');
    }
    return bound;
  }

  _job(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new QueueError('REMOTE_JOB_NOT_FOUND', 'job does not exist');
    return job;
  }

  /** 租约是否仍然有效（`now <= expiresAt`）。 */
  _leaseLive(job) {
    return Boolean(job.lease) && this.now() <= job.lease.expiresAtMs;
  }

  /** 租约是否已经失效（`leased` / `running` 都可能持有失效租约）。 */
  _leaseExpired(job) {
    return Boolean(job.lease) && this.now() > job.lease.expiresAtMs;
  }

  /** 把一个时长夹到服务端的 [MIN_LEASE_MS, MAX_LEASE_MS] 区间。 */
  _clampLeaseMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LEASE_MS;
    return Math.min(Math.max(Math.trunc(n), MIN_LEASE_MS), MAX_LEASE_MS);
  }

  /**
   * 幂等判定：命中同键且同体 → 返回首次记录；同键异体 → 冲突。
   * 返回 `null` 表示这是一个全新的幂等键。
   */
  _idempotent(tenantId, key, digest) {
    const rec = this.idempotency.get(this._idemKey(tenantId, key));
    if (!rec) return null;
    if (rec.digest !== digest) {
      throw new QueueError('REMOTE_IDEMPOTENCY_CONFLICT', 'idempotency key was used with a different request body', {
        idempotencyKey: key,
      });
    }
    return rec;
  }

  /**
   * 重放判定：同键同体**且**同一次租约才是一次重放。
   *
   * - 键不存在 → `null`（新请求）；
   * - 键存在但请求体不同 → `REMOTE_IDEMPOTENCY_CONFLICT`（由 `_idempotent` 抛）；
   * - 键存在、请求体相同、但**租约不同** → `REMOTE_JOB_NOT_LEASABLE`：
   *   这是另一个 attempt 在冒用同一把键，它没有回写权；
   * - 键存在、请求体相同、租约相同、且**首次结果是失败** → 重抛同一个
   *   失败：首次失败不得在重放时变成成功。
   */
  _replay(tenantId, key, digest, leaseId) {
    const rec = this._idempotent(tenantId, key, digest);
    if (!rec) return null;
    if ((rec.leaseId ?? null) !== (leaseId ?? null)) {
      throw new QueueError('REMOTE_JOB_NOT_LEASABLE', 'the idempotency key belongs to another lease attempt', {
        idempotencyKey: key,
      });
    }
    if (rec.error) {
      throw new QueueError(rec.error.code, rec.error.message, rec.error.details || {});
    }
    return rec;
  }

  /** 把一次**失败**记进幂等表，使重放返回同一个失败而不是一次成功。 */
  _recordFailure(tenantId, key, digest, leaseId, jobId, error) {
    this.idempotency.set(this._idemKey(tenantId, key), {
      jobId,
      digest,
      result: null,
      leaseId: leaseId ?? null,
      error: { code: error.code, message: error.message, details: error.details || {} },
    });
  }

  /**
   * 租约持有者校验（fencing）。
   *
   * 没有 `leaseId` 就无法证明自己持有租约，因此与「持有但租约不匹配」
   * 同码拒绝：`REMOTE_JOB_NOT_LEASABLE`。
   */
  _assertLeaseHolder(job, nodeId, leaseId) {
    if (!job.lease) {
      throw new QueueError('REMOTE_JOB_NOT_LEASABLE', 'the job holds no lease', { jobId: job.jobId });
    }
    if (job.lease.nodeId !== nodeId) {
      throw new QueueError('REMOTE_JOB_NOT_LEASABLE', 'node does not hold the lease of this job', { jobId: job.jobId });
    }
    if (typeof leaseId !== 'string' || !leaseId) {
      throw new QueueError('REMOTE_JOB_NOT_LEASABLE', 'leaseId is required to prove lease ownership', {
        jobId: job.jobId,
      });
    }
    if (job.lease.leaseId !== leaseId) {
      throw new QueueError('REMOTE_JOB_NOT_LEASABLE', 'the presented leaseId is not the current lease', {
        jobId: job.jobId,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 节点绑定（ATS-503 的最小可信部分：租户由服务端指派）               */
  /* ---------------------------------------------------------------- */

  /**
   * 绑定节点到租户。**控制平面**调用；客户端不得自行指定租户
   * （ATS-501 §5.1）。同一节点不得改绑到另一个租户（HB-5）。
   */
  bindNode(nodeId, tenantId) {
    if (typeof nodeId !== 'string' || !nodeId) throw new QueueError('REMOTE_POLICY_REJECTED', 'nodeId is required');
    if (typeof tenantId !== 'string' || !tenantId) throw new QueueError('REMOTE_POLICY_REJECTED', 'tenantId is required');
    const existing = this.nodeTenants.get(nodeId);
    if (existing && existing !== tenantId) {
      throw new QueueError('REMOTE_TENANT_MISMATCH', 'node is already bound to another tenant');
    }
    this.nodeTenants.set(nodeId, tenantId);
    this._save();
    return { nodeId, tenantId };
  }

  /**
   * 解除节点绑定（会话失效 / 吊销）。其名下作业退回队列。
   *
   * `leased` 与 `running` **都**要回收：节点在执行中断连是最常见的形态，
   * 只回收 `leased` 会让作业永久卡在 `running`——既不重投也不会因超期
   * 变成 `interrupted`。
   *
   * @param {string} nodeId
   * @param {object} [opts]
   * @param {string} [opts.tenantId] 发起释放的租户；节点属于别的租户时拒绝
   */
  releaseNode(nodeId, { tenantId } = {}) {
    const bound = this.nodeTenants.get(nodeId);
    if (tenantId && bound && bound !== tenantId) {
      throw new QueueError('REMOTE_RESOURCE_NOT_FOUND', 'the node is not known to this tenant', { nodeId });
    }
    const released = [];
    for (const job of this.jobs.values()) {
      if (!job.lease || job.lease.nodeId !== nodeId) continue;
      if (job.state !== 'leased' && job.state !== 'running') continue;
      released.push(this._requeue(job, 'node released'));
    }
    this.nodeTenants.delete(nodeId);
    this._save();
    return released;
  }

  /* ---------------------------------------------------------------- */
  /* dispatch（入队）                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * 派发作业入队。
   *
   * @param {object} request
   * @param {string} request.tenantId          服务端推导的租户
   * @param {string} request.idempotencyKey    必填（ATS-501 §7.3）
   * @param {string} request.projectUid        不透明 UID
   * @param {string} request.gitSha            完整 40 位十六进制 SHA
   * @param {string[]} [request.testUids]
   * @param {string} [request.runnerKind]
   * @param {string} [request.deadline]        RFC3339，超过即不得回写终态
   * @param {number} [request.maxAttempts]
   */
  dispatch(request) {
    if (!isPlainObject(request)) throw new QueueError('REMOTE_POLICY_REJECTED', 'request must be an object');
    const { tenantId, idempotencyKey } = request;
    if (typeof tenantId !== 'string' || !tenantId) throw new QueueError('REMOTE_TENANT_REQUIRED', 'tenantId is required');
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
      throw new QueueError('REMOTE_POLICY_REJECTED', 'idempotencyKey is required for dispatch');
    }
    if (typeof request.projectUid !== 'string' || !request.projectUid) {
      throw new QueueError('REMOTE_POLICY_REJECTED', 'projectUid is required');
    }
    if (typeof request.gitSha !== 'string' || !/^[0-9a-f]{40}$/i.test(request.gitSha)) {
      throw new QueueError('REMOTE_GIT_SHA_INVALID', 'gitSha must be a full 40-hex commit SHA');
    }
    if (request.testUids !== undefined && !Array.isArray(request.testUids)) {
      throw new QueueError('REMOTE_POLICY_REJECTED', 'testUids must be an array');
    }
    if (request.deadline !== undefined && request.deadline !== null) {
      if (typeof request.deadline !== 'string' || Number.isNaN(Date.parse(request.deadline))) {
        throw new QueueError('REMOTE_POLICY_REJECTED', 'deadline must be an RFC3339 timestamp');
      }
    }
    const maxAttempts = request.maxAttempts === undefined ? DEFAULT_MAX_ATTEMPTS : request.maxAttempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new QueueError('REMOTE_POLICY_REJECTED', 'maxAttempts must be an integer between 1 and 10');
    }

    // 摘要覆盖全部语义字段：任何一个语义字段的变化都是「异体」。
    const digest = requestDigest({
      tenantId,
      projectUid: request.projectUid,
      gitSha: request.gitSha,
      testUids: request.testUids || [],
      runnerKind: request.runnerKind || null,
      deadline: request.deadline || null,
      maxAttempts,
    });
    const seen = this._idempotent(tenantId, idempotencyKey, digest);
    if (seen) {
      const job = this.jobs.get(seen.jobId);
      return { job, replayed: true, result: seen.result ?? null };
    }

    const at = rfc3339(this.now());
    const job = {
      jobId: `job_${crypto.randomUUID()}`,
      tenantId,
      idempotencyKey,
      requestDigest: digest,
      projectUid: request.projectUid,
      gitSha: request.gitSha,
      testUids: request.testUids || [],
      runnerKind: request.runnerKind || null,
      state: 'queued',
      attempt: 0,
      maxAttempts,
      lease: null,
      result: null,
      deadline: request.deadline || null,
      deadlineMs: request.deadline ? Date.parse(request.deadline) : null,
      createdAt: at,
      updatedAt: at,
      history: [],
    };
    this._record(job, 'job.queued', { attempt: 0 });
    this.jobs.set(job.jobId, job);
    this.idempotency.set(this._idemKey(tenantId, idempotencyKey), {
      jobId: job.jobId,
      digest,
      result: null,
      leaseId: null,
      error: null,
    });
    this._save();
    return { job, replayed: false, result: null };
  }

  /* ---------------------------------------------------------------- */
  /* lease / heartbeat                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * 租用作业。
   *
   * 一个作业**任一时刻至多一个活跃租约**：已被租出的作业再次被租用时
   * 抛 `REMOTE_JOB_NOT_LEASABLE`。租约已过期的作业（心跳超时）先被
   * 退回队列，再允许重新租用——这就是「断连重投不双跑」的执行路径。
   *
   * 租约时长由**服务端**决定：客户端可以申请更短的租约，更长的被截断到
   * `MAX_LEASE_MS`（见该常量的说明）。
   */
  lease(jobId, { nodeId, leaseMs, claimedTenantId } = {}) {
    if (typeof nodeId !== 'string' || !nodeId) throw new QueueError('REMOTE_POLICY_REJECTED', 'nodeId is required');
    const tenantId = this._assertTenant(nodeId, claimedTenantId);
    const job = this._job(jobId);
    if (job.tenantId !== tenantId) throw new QueueError('REMOTE_JOB_NOT_FOUND', 'job does not exist');

    // 回收：租约已过期的 `leased` 与 `running` 都先退回队列。执行中的节点
    // 掉线是「断连重投不双跑」最常见的形态——不回收它，作业会永久卡住。
    if ((job.state === 'leased' || job.state === 'running') && this._leaseExpired(job)) {
      this._requeue(job, 'lease expired before re-lease');
    }
    if (TERMINAL_STATES.includes(job.state)) {
      // A terminal job is not leasable. Returning it as a "replay" would
      // hide the fact that there is nothing to run: the caller asked for work
      // and there is none.
      throw new QueueError('REMOTE_JOB_NOT_LEASABLE', `job is ${job.state}`, { jobId: job.jobId });
    }
    if (job.state === 'leased' && this._leaseLive(job)) {
      if (job.lease.nodeId === nodeId) {
        // 同一节点重复租用自己的作业 → 幂等，返回同一租约。
        return { job, replayed: true };
      }
      throw new QueueError('REMOTE_JOB_NOT_LEASABLE', 'job is leased by another node', {
        jobId: job.jobId,
        leaseNodeId: job.lease.nodeId,
      });
    }
    if (job.state === 'running') {
      // 租约仍然有效的 `running`：执行方还活着，不得双跑。
      throw new QueueError('REMOTE_JOB_NOT_LEASABLE', 'job is already running', { jobId: job.jobId });
    }
    if (job.state !== 'queued') {
      throw new QueueError('REMOTE_JOB_NOT_LEASABLE', `job is ${job.state}`, { jobId: job.jobId });
    }
    if (job.deadlineMs !== null && this.now() > job.deadlineMs) {
      this._finish(job, 'interrupted', { reason: 'deadline exceeded before dispatch' });
      this._save();
      throw new QueueError('REMOTE_LEASE_EXPIRED', 'job deadline exceeded', { jobId: job.jobId });
    }
    if (job.attempt >= job.maxAttempts) {
      this._finish(job, 'failed', { reason: 'max attempts reached' });
      this._save();
      throw new QueueError('REMOTE_JOB_NOT_LEASABLE', 'job exhausted its retry budget', { jobId: job.jobId });
    }

    const duration = this._clampLeaseMs(Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : this.leaseMs);
    const expiresAtMs = this.now() + duration;
    job.attempt += 1;
    job.state = 'leased';
    job.lease = {
      nodeId,
      leaseId: `lease_${crypto.randomUUID()}`,
      acquiredAtMs: this.now(),
      expiresAtMs,
      durationMs: duration,
      heartbeatSeq: 0,
    };
    this._record(job, 'job.leased', { nodeId, attempt: job.attempt, leaseId: job.lease.leaseId });
    this._save();
    return { job, replayed: false };
  }

  /**
   * 心跳续租。
   *
   * 租约已过期 → 拒绝 `REMOTE_LEASE_EXPIRED`，并把作业退回队列（未到
   * deadline）或记为 `interrupted` 终态（已到 deadline）。这就是「心跳
   * 超时可恢复」的执行路径。
   *
   * `leaseId` 是 fencing 凭据：心跳必须回带当前租约的 id。
   */
  heartbeat(jobId, { nodeId, leaseId, seq, claimedTenantId } = {}) {
    if (typeof nodeId !== 'string' || !nodeId) throw new QueueError('REMOTE_POLICY_REJECTED', 'nodeId is required');
    const tenantId = this._assertTenant(nodeId, claimedTenantId);
    const job = this._job(jobId);
    if (job.tenantId !== tenantId) throw new QueueError('REMOTE_JOB_NOT_FOUND', 'job does not exist');
    if (TERMINAL_STATES.includes(job.state)) {
      return { job, expired: false };
    }
    this._assertLeaseHolder(job, nodeId, leaseId);
    if (this._leaseExpired(job)) {
      this._requeue(job, 'heartbeat after lease expiry');
      this._save();
      throw new QueueError('REMOTE_LEASE_EXPIRED', 'lease has expired', { jobId: job.jobId });
    }
    // The deadline is a hard cut-off (ATS-501 §7.3): a job that is already
    // overdue must not be kept alive by a heartbeat, even when its lease has
    // not expired yet. It becomes `interrupted` and no heartbeat may renew it.
    if (job.deadlineMs !== null && this.now() > job.deadlineMs) {
      this._finish(job, 'interrupted', { reason: 'heartbeat after deadline' });
      this._save();
      throw new QueueError('REMOTE_LEASE_EXPIRED', 'job deadline exceeded', { jobId: job.jobId });
    }
    if (seq !== undefined && seq !== null) {
      if (!Number.isInteger(seq) || seq < job.lease.heartbeatSeq) {
        throw new QueueError('REMOTE_POLICY_REJECTED', 'heartbeat seq must be a monotonically increasing integer');
      }
      job.lease.heartbeatSeq = seq;
    }
    // 续租按**本次租约发放的时长**延长，而不是按队列默认值——否则一个
    // 申请了短租约的节点会在心跳时被悄悄换成默认租期。
    job.lease.expiresAtMs = this.now() + (job.lease.durationMs || this.leaseMs);
    this._record(job, 'job.heartbeat', { nodeId, seq: job.lease.heartbeatSeq, leaseId: job.lease.leaseId });
    this._save();
    return { job, expired: false };
  }

  /** 节点确认接单（`ack`）。带幂等键，同键同体返回首次结果。 */
  ack(jobId, { nodeId, leaseId, idempotencyKey, claimedTenantId } = {}) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
      throw new QueueError('REMOTE_POLICY_REJECTED', 'idempotencyKey is required for ack');
    }
    if (typeof nodeId !== 'string' || !nodeId) throw new QueueError('REMOTE_POLICY_REJECTED', 'nodeId is required');
    const tenantId = this._assertTenant(nodeId, claimedTenantId);
    const job = this._job(jobId);
    if (job.tenantId !== tenantId) throw new QueueError('REMOTE_JOB_NOT_FOUND', 'job does not exist');
    const digest = requestDigest({ type: 'ack', jobId, nodeId });
    const seen = this._replay(tenantId, idempotencyKey, digest, leaseId);
    if (seen) return { job, replayed: true };

    this._assertLeaseHolder(job, nodeId, leaseId);
    // 租约过期后到达的 ack 必须被拒：接受它会把作业从「可回收」推进到
    // `running`——一个已经失效的执行方反而把作业锁死。
    if (this._leaseExpired(job)) {
      this._requeue(job, 'ack after lease expiry');
      this._recordFailure(tenantId, idempotencyKey, digest, leaseId, job.jobId,
        new QueueError('REMOTE_LEASE_EXPIRED', 'lease has expired', { jobId: job.jobId }));
      this._save();
      throw new QueueError('REMOTE_LEASE_EXPIRED', 'lease has expired', { jobId: job.jobId });
    }
    if (job.deadlineMs !== null && this.now() > job.deadlineMs) {
      this._finish(job, 'interrupted', { reason: 'ack after deadline' });
      this._recordFailure(tenantId, idempotencyKey, digest, leaseId, job.jobId,
        new QueueError('REMOTE_LEASE_EXPIRED', 'job deadline exceeded', { jobId: job.jobId }));
      this._save();
      throw new QueueError('REMOTE_LEASE_EXPIRED', 'job deadline exceeded', { jobId: job.jobId });
    }
    if (job.state === 'leased') {
      job.state = 'running';
      this._record(job, 'job.running', { nodeId, leaseId: leaseId ?? null });
    }
    this.idempotency.set(this._idemKey(tenantId, idempotencyKey), {
      jobId: job.jobId,
      digest,
      result: null,
      leaseId: leaseId ?? null,
      error: null,
    });
    this._save();
    return { job, replayed: false };
  }

  /**
   * 终态回报（`result`）。带幂等键。
   *
   * 同键同体**且同一次租约** → 返回首次结果且**不改变状态**（重放结果
   * 幂等）。同键异体 → `REMOTE_IDEMPOTENCY_CONFLICT`。同键同体但租约
   * 不同 → `REMOTE_JOB_NOT_LEASABLE`（另一个 attempt 在冒名）。
   *
   * 非租约持有者对**终态**作业的回报同样被拒：作业已经终结，旧节点
   * 没有回写权，返回 `200 replayed:true` 会让它误以为自己的结果被接受。
   */
  result(jobId, { nodeId, leaseId, idempotencyKey, status, payload, claimedTenantId } = {}) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
      throw new QueueError('REMOTE_POLICY_REJECTED', 'idempotencyKey is required for result');
    }
    if (typeof nodeId !== 'string' || !nodeId) throw new QueueError('REMOTE_POLICY_REJECTED', 'nodeId is required');
    if (!RESULT_STATUSES.includes(status)) {
      throw new QueueError('REMOTE_POLICY_REJECTED', `status must be one of ${RESULT_STATUSES.join(', ')}`);
    }
    const tenantId = this._assertTenant(nodeId, claimedTenantId);
    const job = this._job(jobId);
    if (job.tenantId !== tenantId) throw new QueueError('REMOTE_JOB_NOT_FOUND', 'job does not exist');
    const digest = requestDigest({ type: 'result', jobId, nodeId, status, payload: payload ?? null });
    const seen = this._replay(tenantId, idempotencyKey, digest, leaseId);
    if (seen) {
      // 重放：返回首次结果，状态不变。
      return { job: this.jobs.get(seen.jobId) || job, replayed: true, result: seen.result ?? null };
    }
    this._assertLeaseHolder(job, nodeId, leaseId);
    if (job.deadlineMs !== null && this.now() > job.deadlineMs) {
      this._finish(job, 'interrupted', { reason: 'result after deadline' });
      this._recordFailure(tenantId, idempotencyKey, digest, leaseId, job.jobId,
        new QueueError('REMOTE_LEASE_EXPIRED', 'job deadline exceeded', { jobId: job.jobId }));
      this._save();
      throw new QueueError('REMOTE_LEASE_EXPIRED', 'job deadline exceeded', { jobId: job.jobId });
    }
    const result = { status, payload: payload ?? null, at: rfc3339(this.now()), attempt: job.attempt };
    job.result = result;
    job.state = status;
    job.lease = null;
    this._record(job, 'job.finished', { status, attempt: job.attempt, leaseId: leaseId ?? null });
    this.idempotency.set(this._idemKey(tenantId, idempotencyKey), {
      jobId: job.jobId,
      digest,
      result,
      leaseId: leaseId ?? null,
      error: null,
    });
    this._save();
    return { job, replayed: false, result };
  }

  /** 取消作业。带幂等键；终态作业取消返回既有终态（幂等）。 */
  cancel(jobId, { idempotencyKey, tenantId, claimedTenantId } = {}) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
      throw new QueueError('REMOTE_POLICY_REJECTED', 'idempotencyKey is required for cancel');
    }
    const bound = tenantId || claimedTenantId;
    if (typeof bound !== 'string' || !bound) throw new QueueError('REMOTE_TENANT_REQUIRED', 'tenantId is required');
    const job = this._job(jobId);
    if (job.tenantId !== bound) throw new QueueError('REMOTE_JOB_NOT_FOUND', 'job does not exist');
    const digest = requestDigest({ type: 'cancel', jobId });
    const seen = this._idempotent(bound, idempotencyKey, digest);
    if (seen) return { job, replayed: true, result: seen.result ?? null };
    if (TERMINAL_STATES.includes(job.state)) {
      return { job, replayed: true, result: job.result };
    }
    job.result = { status: 'cancelled', payload: null, at: rfc3339(this.now()), attempt: job.attempt };
    job.state = 'cancelled';
    job.lease = null;
    this._record(job, 'job.cancelled', { attempt: job.attempt });
    this.idempotency.set(this._idemKey(bound, idempotencyKey), {
      jobId: job.jobId,
      digest,
      result: job.result,
      leaseId: null,
      error: null,
    });
    this._save();
    return { job, replayed: false, result: job.result };
  }

  /* ---------------------------------------------------------------- */
  /* 内部状态转换                                                       */
  /* ---------------------------------------------------------------- */

  /** 把作业退回队列（心跳超时 / 节点释放）。旧 attempt 记为 interrupted。 */
  _requeue(job, reason) {
    if (TERMINAL_STATES.includes(job.state)) return job;
    const previousLease = job.lease;
    job.lease = null;
    job.state = 'queued';
    this._record(job, 'job.requeued', {
      reason,
      nodeId: previousLease ? previousLease.nodeId : null,
      leaseId: previousLease ? previousLease.leaseId : null,
      attempt: job.attempt,
    });
    if (job.deadlineMs !== null && this.now() > job.deadlineMs) {
      this._finish(job, 'interrupted', { reason: 'deadline exceeded while requeueing' });
    }
    return job;
  }

  /** 写入终态。终态只写一次。 */
  _finish(job, status, detail = {}) {
    if (TERMINAL_STATES.includes(job.state)) return job;
    job.state = status;
    job.lease = null;
    job.result = { status, payload: detail.payload ?? null, at: rfc3339(this.now()), attempt: job.attempt };
    this._record(job, 'job.finished', { status, ...detail });
    return job;
  }

  /* ---------------------------------------------------------------- */
  /* 查询与维护                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * 读取作业。
   *
   * **租户作用域**：给出 `tenantId` 时，作业不属于该租户一律返回 `null`
   * （调用方据此回 404，不区分「不存在」与「属他租户」）。不给出 `tenantId`
   * 的是**内部**读取口（诊断、sweep、测试），请求路径上必须传租户。
   */
  get(jobId, tenantId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (tenantId !== undefined && job.tenantId !== tenantId) return null;
    return job;
  }

  /**
   * 按租户列出作业。`tenantId` **必填**——不带租户的列表就是跨租户泄漏。
   */
  list(filter = {}) {
    const { tenantId, state } = filter;
    if (typeof tenantId !== 'string' || !tenantId) {
      throw new QueueError('REMOTE_TENANT_REQUIRED', 'tenantId is required to list jobs');
    }
    const out = [];
    for (const job of this.jobs.values()) {
      if (job.tenantId !== tenantId) continue;
      if (state && job.state !== state) continue;
      out.push(job);
    }
    return out;
  }

  /**
   * 扫描租约过期与 deadline 越界的作业，把它们收尾。
   * 控制平面周期调用（ATS-501 §4.3：会话失效后作业退回队列）。
   *
   * `leased` 与 `running` 走同一条回收路径：执行中断连的作业必须能被
   * 重新派发，否则它既不会重投，也不会因超期变成 `interrupted`。
   *
   * @returns {{requeued: string[], interrupted: string[]}}
   */
  sweep() {
    const requeued = [];
    const interrupted = [];
    for (const job of this.jobs.values()) {
      if (TERMINAL_STATES.includes(job.state)) continue;
      if ((job.state === 'leased' || job.state === 'running') && this._leaseExpired(job)) {
        const before = job.state;
        this._requeue(job, `lease expired during sweep (${before})`);
        if (job.state === 'queued') requeued.push(job.jobId);
        if (job.state === 'interrupted') interrupted.push(job.jobId);
        continue;
      }
      if (job.deadlineMs !== null && this.now() > job.deadlineMs) {
        this._finish(job, 'interrupted', { reason: `deadline exceeded while ${job.state}` });
        interrupted.push(job.jobId);
      }
    }
    if (requeued.length || interrupted.length) this._save();
    return { requeued, interrupted };
  }

  /** 队列快照（对外暴露用；不含租户敏感路径）。 */
  snapshot() {
    const counts = {};
    for (const state of JOB_STATES) counts[state] = 0;
    for (const job of this.jobs.values()) counts[job.state] = (counts[job.state] || 0) + 1;
    return { counts, total: this.jobs.size };
  }
}

export { sha256, canonical };
