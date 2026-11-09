/**
 * ATS-502 ｜ 远程调度服务（control-plane scheduling API）
 *
 * 这是**部署式控制面**的调度面：它把 `server/queue.mjs` 的调度内核暴露成
 * 一组 HTTP 端点，供 Runner 节点与 CI 调用。
 *
 * ── 与本地 Bridge 的边界（ATS-501 HB-1 / HB-7）────────────────────────
 *
 * 本文件**不是** `server/index.mjs` 的扩展，也不复用它的端口、token 或
 * 路由表。理由：
 *   - HB-1：控制平面**不得**直接调用 P1 的本地 API。调度服务不 import
 *     `server/index.mjs`，也不发起任何指向本地 Bridge 的请求。
 *   - HB-7：控制平面**不得**直接读取 Runner 节点文件系统。调度服务只处理
 *     不透明 UID 与消息，不触碰任何节点或本地路径。
 *   - 凭据不复用：本地 Bridge 用进程级 token + Origin allowlist；调度服务
 *     用**节点签名**（ATS-503 落地）与**租户上下文**。两套凭据不共享。
 *
 * 端口与本地 Bridge 不同（默认 4580），绑定 127.0.0.1 是为了让本地开发
 * 可用；部署形态由 ATS-506 决定。
 *
 * ── 本文件的边界声明 ─────────────────────────────────────────────────
 *
 * ATS-502 的交付物是**调度服务**，不是节点协议：
 *   - 节点签名、enrollment、握手属于 ATS-503，本服务只做**租户上下文与
 *     幂等/租约/心跳/重试**这些调度语义；
 *   - 执行不在本服务内发生：本服务只把作业排进队列并发放租约。
 *
 * ── 租户上下文的来源（ATS-501 §5.1）────────────────────────────────────
 *
 * 「租户由服务端推导」在 HTTP 面上必须有**具体的推导规则**，否则这句话
 * 在读路径上是假的。本服务的规则是：
 *
 *   - **读路径**（`GET /jobs`、`GET /jobs/{id}`）：租户来自**请求方的
 *     节点上下文**——`X-ATS-Scheduler-Node` 头里的 nodeId，服务端用它查
 *     自己维护的节点→租户绑定。**没有节点上下文就没有租户**，请求一律
 *     `403 REMOTE_TENANT_REQUIRED`；查询参数里的 `tenantId` **不被信任**，
 *     只作为「服务端已推导出的租户」的一致性断言（不匹配 → 403
 *     `REMOTE_TENANT_MISMATCH`）。他租户的作业与不存在同样回 **404**。
 *   - **写路径**（dispatch / cancel / sweep / 节点绑定与释放）：这些是
 *     **控制平面侧**操作，必须带**调度服务的凭据**
 *     (`X-ATS-Scheduler-Token`)。凭据缺失或不匹配 → `401
 *     REMOTE_UNAUTHENTICATED`。
 *   - **节点侧操作**（lease / heartbeat / ack / result）：租户来自请求体里
 *     的 `nodeId`，服务端查自己的绑定推导租户；请求体里的 `tenantId`
 *     若给出则必须与绑定一致。
 *
 * **当前的可利用面（必须写进文档，不得外推）**：节点凭据（签名、
 * enrollment、轮换）属于 ATS-503，**尚未实现**。因此本服务的
 * `X-ATS-Scheduler-Token` 是一个**共享的进程级凭据**：任何持有它的人
 * 都能派发作业、取消作业、绑定**任意**节点到**任意**租户、释放**任意**
 * 节点。这不是可以对外部署的形态——见 `docs/29-REMOTE-SCHEDULING.md` §5.2。
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JobQueue, QueueError, REJECTION_CODES, JOB_STATES } from './queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 队列的持久化位置。默认在数据目录下的 scheduler/queue.json。 */
export function defaultQueueFile() {
  const dir = process.env.ATS_DATA_DIR || path.join(os.homedir(), '.ai-test-studio');
  return path.join(dir, 'scheduler', 'queue.json');
}

const json = (res, status, obj) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(obj));
};

/** 把 QueueError 映射成 ATS-501 §6.2 的拒绝码与 HTTP 状态。 */
function fail(res, e) {
  if (e instanceof QueueError) {
    const spec = REJECTION_CODES[e.code];
    if (!spec) {
      // A code that is not in the frozen table is a defect in this service,
      // not a policy rejection: it must not be reported as a 403 to hide it.
      json(res, 500, { error: 'REMOTE_INTERNAL' });
      return;
    }
    json(res, spec.http, { error: e.code, ...(e.details && Object.keys(e.details).length ? { details: e.details } : {}) });
    return;
  }
  json(res, 500, { error: 'REMOTE_INTERNAL' });
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 256_000) throw new QueueError('REMOTE_PAYLOAD_TOO_LARGE', 'request body too large');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new QueueError('REMOTE_POLICY_REJECTED', 'request body is not valid JSON');
  }
}

/**
 * 控制平面凭据的校验（常数时间比较）。
 *
 * 凭据缺失或不匹配一律 `REMOTE_UNAUTHENTICATED`（401）。凭据值不写进
 * 日志、不回显给调用方。
 */
function checkControlPlaneToken(req, expected) {
  const presented = req.headers['x-ats-scheduler-token'];
  if (typeof presented !== 'string' || !presented) {
    throw new QueueError('REMOTE_UNAUTHENTICATED', 'the control-plane credential is required');
  }
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new QueueError('REMOTE_UNAUTHENTICATED', 'the control-plane credential is not valid');
  }
}

/**
 * Create the scheduler HTTP server.
 *
 * @param {object} [opts]
 * @param {JobQueue} [opts.queue]     an existing queue (tests inject one)
 * @param {string}   [opts.queueFile] persistence path for the default queue
 * @param {string}   [opts.controlPlaneToken] credential for the control-plane
 *        write paths. Defaults to `process.env.ATS_SCHEDULER_TOKEN`.
 */
export function createSchedulerServer(opts = {}) {
  const queue = opts.queue || new JobQueue({ file: opts.queueFile || defaultQueueFile() });
  const controlPlaneToken = opts.controlPlaneToken
    || process.env.ATS_SCHEDULER_TOKEN
    // A development default. It is NOT a secret: anyone who can reach the
    // port can read it out of this file. The docs state that the service must
    // not be deployed in this shape.
    || 'dev-insecure-scheduler-token';

  /** The tenant a request acts in, derived from the node context header. */
  function tenantOfRequest(req, url) {
    const nodeId = req.headers['x-ats-scheduler-node'];
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new QueueError('REMOTE_TENANT_REQUIRED', 'a node context header is required to derive the tenant');
    }
    const bound = queue.nodeTenants.get(nodeId);
    if (!bound) {
      throw new QueueError('REMOTE_TENANT_REQUIRED', 'the node context is not bound to a tenant');
    }
    // A tenantId in the query string is an ASSERTION about the derived
    // tenant, never an input to it.
    const claimed = url.searchParams.get('tenantId');
    if (claimed && claimed !== bound) {
      throw new QueueError('REMOTE_TENANT_MISMATCH', 'the claimed tenant does not match the node context');
    }
    return bound;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      if (p === '/api/scheduler/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, service: 'scheduler', states: JOB_STATES, ...queue.snapshot() });
      }

      // --- control plane: dispatch a job into the queue -------------------
      if (p === '/api/scheduler/jobs' && req.method === 'POST') {
        checkControlPlaneToken(req, controlPlaneToken);
        const b = await readBody(req);
        const { job, replayed } = queue.dispatch(b);
        return json(res, replayed ? 200 : 202, { job, replayed });
      }

      // --- read path: the tenant comes from the node context --------------
      if (p === '/api/scheduler/jobs' && req.method === 'GET') {
        const tenantId = tenantOfRequest(req, url);
        const jobs = queue.list({
          tenantId,
          state: url.searchParams.get('state') || undefined,
        });
        return json(res, 200, { jobs });
      }

      const m = p.match(/^\/api\/scheduler\/jobs\/(job_[0-9a-f-]{36})(?:\/(\w+))?$/);
      if (m) {
        const jobId = m[1];
        const action = m[2] || '';
        if (action === '' && req.method === 'GET') {
          const tenantId = tenantOfRequest(req, url);
          const job = queue.get(jobId, tenantId);
          if (!job) return fail(res, new QueueError('REMOTE_JOB_NOT_FOUND', 'job does not exist'));
          return json(res, 200, { job });
        }
        if (action === 'lease' && req.method === 'POST') {
          const b = await readBody(req);
          const { job, replayed } = queue.lease(jobId, b);
          return json(res, 200, { job, replayed });
        }
        if (action === 'heartbeat' && req.method === 'POST') {
          const b = await readBody(req);
          const { job, expired } = queue.heartbeat(jobId, b);
          return json(res, 200, { job, expired });
        }
        if (action === 'ack' && req.method === 'POST') {
          const b = await readBody(req);
          const { job, replayed } = queue.ack(jobId, b);
          return json(res, 200, { job, replayed });
        }
        if (action === 'result' && req.method === 'POST') {
          const b = await readBody(req);
          const { job, replayed, result } = queue.result(jobId, b);
          return json(res, 200, { job, replayed, result });
        }
        if (action === 'cancel' && req.method === 'POST') {
          checkControlPlaneToken(req, controlPlaneToken);
          const b = await readBody(req);
          const { job, replayed, result } = queue.cancel(jobId, b);
          return json(res, 200, { job, replayed, result });
        }
        if (action === 'sweep' && req.method === 'POST') {
          checkControlPlaneToken(req, controlPlaneToken);
          return json(res, 200, queue.sweep());
        }
      }

      // --- control plane: node binding (ATS-503 落地前的最小可信部分) -----
      const nm = p.match(/^\/api\/scheduler\/nodes\/([^/]+)(?:\/release)?$/);
      if (nm) {
        checkControlPlaneToken(req, controlPlaneToken);
        const nodeId = decodeURIComponent(nm[1]);
        if (p.endsWith('/release') && req.method === 'POST') {
          const released = queue.releaseNode(nodeId);
          return json(res, 200, { nodeId, released: released.map((j) => j.jobId) });
        }
        if (req.method === 'POST') {
          const b = await readBody(req);
          return json(res, 200, queue.bindNode(nodeId, b.tenantId));
        }
      }

      return json(res, 404, { error: 'REMOTE_RESOURCE_NOT_FOUND' });
    } catch (e) {
      return fail(res, e);
    }
  });

  return { server, queue, controlPlaneToken };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.ATS_SCHEDULER_PORT || 4580);
  const { server } = createSchedulerServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`AI Test Studio scheduler: http://127.0.0.1:${port}/api/scheduler/health`);
  });
}
