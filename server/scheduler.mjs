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
 *   - 认证在本服务内以「租户由服务端绑定推导」的方式体现（ATS-501 §5.1），
 *     请求携带的 tenantId 必须与节点绑定一致；
 *   - 执行不在本服务内发生：本服务只把作业排进队列并发放租约。
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
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
 * Create the scheduler HTTP server.
 *
 * @param {object} [opts]
 * @param {JobQueue} [opts.queue]     an existing queue (tests inject one)
 * @param {string}   [opts.queueFile] persistence path for the default queue
 */
export function createSchedulerServer(opts = {}) {
  const queue = opts.queue || new JobQueue({ file: opts.queueFile || defaultQueueFile() });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      if (p === '/api/scheduler/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, service: 'scheduler', states: JOB_STATES, ...queue.snapshot() });
      }

      // --- control plane: dispatch a job into the queue -------------------
      if (p === '/api/scheduler/jobs' && req.method === 'POST') {
        const b = await readBody(req);
        const { job, replayed } = queue.dispatch(b);
        return json(res, replayed ? 200 : 202, { job, replayed });
      }

      if (p === '/api/scheduler/jobs' && req.method === 'GET') {
        const jobs = queue.list({
          tenantId: url.searchParams.get('tenantId') || undefined,
          state: url.searchParams.get('state') || undefined,
        });
        return json(res, 200, { jobs });
      }

      const m = p.match(/^\/api\/scheduler\/jobs\/(job_[0-9a-f-]{36})(?:\/(\w+))?$/);
      if (m) {
        const jobId = m[1];
        const action = m[2] || '';
        if (action === '' && req.method === 'GET') {
          const job = queue.get(jobId);
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
          const b = await readBody(req);
          const { job, replayed, result } = queue.cancel(jobId, b);
          return json(res, 200, { job, replayed, result });
        }
        if (action === 'sweep' && req.method === 'POST') {
          return json(res, 200, queue.sweep());
        }
      }

      // --- control plane: node binding (ATS-503 落地前的最小可信部分) -----
      const nm = p.match(/^\/api\/scheduler\/nodes\/([^/]+)(?:\/release)?$/);
      if (nm) {
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

  return { server, queue };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.ATS_SCHEDULER_PORT || 4580);
  const { server } = createSchedulerServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`AI Test Studio scheduler: http://127.0.0.1:${port}/api/scheduler/health`);
  });
}
