/**
 * ATS-502 integration tests: the scheduling service over HTTP.
 *
 * These exercise the acceptance criteria through the wire, not through the
 * module API:
 *   - 断连重投不双跑: a second lease of the same job is refused over HTTP;
 *   - 心跳超时可恢复: an expired lease is recoverable over HTTP;
 *   - 重放结果幂等: a replayed result returns the first result over HTTP.
 *
 * The clock is injected into the queue, so the tests advance time explicitly
 * instead of sleeping.
 *
 * The read path derives the tenant from the NODE CONTEXT header, and the
 * control-plane write paths require the control-plane credential -- both are
 * asserted here, because they are the difference between "the tenant is
 * derived server-side" being true and being only a claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSchedulerServer } from '../server/scheduler.mjs';
import { JobQueue } from '../server/queue.mjs';

const TENANT = 'ten_it';
const OTHER_TENANT = 'ten_other';
const SHA = 'b'.repeat(40);
const CP_TOKEN = 'test-control-plane-token';

const state = { t: Date.parse('2026-11-05T00:00:00.000Z') };
const queue = new JobQueue({ now: () => state.t, leaseMs: 30_000 });
const { server } = createSchedulerServer({ queue, controlPlaneToken: CP_TOKEN });

let port;
async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/scheduler/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('scheduler did not boot');
}

/**
 * Call the API.
 *
 * @param {object} [opts]
 * @param {string} [opts.node]  node context header (the tenant source)
 * @param {boolean} [opts.cp]   send the control-plane credential
 */
async function api(endpoint, method = 'GET', payload, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.node) headers['X-ATS-Scheduler-Node'] = opts.node;
  if (opts.cp) headers['X-ATS-Scheduler-Token'] = CP_TOKEN;
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return [r.status, await r.json()];
}

/** The control-plane credential is required for dispatch / cancel / sweep. */
async function cp(endpoint, method = 'GET', payload) {
  return api(endpoint, method, payload, { cp: true });
}

/** The leaseIds handed out by the tests, captured as strings. */
const leases = {};

test('IT-SCHED-SETUP: start the scheduler and bind the nodes', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  await ready();
  // The nodes are bound up front: the read path derives the tenant from the
  // node context, so a bound node has to exist before the first read.
  await cp('/api/scheduler/nodes/node-http-1', 'POST', { tenantId: TENANT });
  await cp('/api/scheduler/nodes/node-http-2', 'POST', { tenantId: TENANT });
  await cp('/api/scheduler/nodes/node-http-3', 'POST', { tenantId: OTHER_TENANT });
});

test('IT-SCHED-001: the health endpoint reports the queue snapshot', async () => {
  const [status, body] = await api('/api/scheduler/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, 'scheduler');
  assert.ok(body.states.includes('leased'));
  assert.equal(typeof body.total, 'number');
});

test('IT-SCHED-002: dispatch returns 202 and the job is queued', async () => {
  const [status, body] = await cp('/api/scheduler/jobs', 'POST', {
    tenantId: TENANT,
    idempotencyKey: 'idem-http-1',
    projectUid: 'proj_http',
    gitSha: SHA,
    testUids: ['tst_http'],
  });
  assert.equal(status, 202);
  assert.equal(body.replayed, false);
  assert.equal(body.job.state, 'queued');
  assert.equal(body.job.attempt, 0);
});

test('IT-SCHED-003: the same dispatch again is a 200 replay of the first job', async () => {
  const [status, body] = await cp('/api/scheduler/jobs', 'POST', {
    tenantId: TENANT,
    idempotencyKey: 'idem-http-1',
    projectUid: 'proj_http',
    gitSha: SHA,
    testUids: ['tst_http'],
  });
  assert.equal(status, 200);
  assert.equal(body.replayed, true);
  const [, list] = await api(`/api/scheduler/jobs?tenantId=${TENANT}`, 'GET', undefined, { node: 'node-http-1' });
  assert.equal(list.jobs.length, 1);
});

test('IT-SCHED-004: the same key with a different body is 409 REMOTE_IDEMPOTENCY_CONFLICT', async () => {
  const [status, body] = await cp('/api/scheduler/jobs', 'POST', {
    tenantId: TENANT,
    idempotencyKey: 'idem-http-1',
    projectUid: 'proj_http',
    gitSha: 'c'.repeat(40),
  });
  assert.equal(status, 409);
  assert.equal(body.error, 'REMOTE_IDEMPOTENCY_CONFLICT');
});

test('IT-SCHED-005: dispatch without an idempotency key is 403', async () => {
  const [status, body] = await cp('/api/scheduler/jobs', 'POST', {
    tenantId: TENANT,
    projectUid: 'proj_http',
    gitSha: SHA,
  });
  assert.equal(status, 403);
  assert.equal(body.error, 'REMOTE_POLICY_REJECTED');
});

test('IT-SCHED-005b: dispatch without the control-plane credential is 401', async () => {
  const [status, body] = await api('/api/scheduler/jobs', 'POST', {
    tenantId: TENANT,
    idempotencyKey: 'idem-http-noauth',
    projectUid: 'proj_http',
    gitSha: SHA,
  });
  assert.equal(status, 401);
  assert.equal(body.error, 'REMOTE_UNAUTHENTICATED');
});

test('IT-SCHED-006: a node must be bound before it can lease', async () => {
  const [status, body] = await cp('/api/scheduler/nodes/node-http-1', 'POST', { tenantId: TENANT });
  assert.equal(status, 200);
  assert.equal(body.tenantId, TENANT);
  // Binding the same node to another tenant is refused.
  const [mismatchStatus, mismatchBody] = await cp('/api/scheduler/nodes/node-http-1', 'POST', { tenantId: OTHER_TENANT });
  assert.equal(mismatchStatus, 403);
  assert.equal(mismatchBody.error, 'REMOTE_TENANT_MISMATCH');
});

test('IT-SCHED-007: leasing a job of an unbound node is 403 REMOTE_TENANT_REQUIRED', async () => {
  const [, list] = await api(`/api/scheduler/jobs?tenantId=${TENANT}`, 'GET', undefined, { node: 'node-http-1' });
  const jobId = list.jobs[0].jobId;
  const [status, body] = await api(`/api/scheduler/jobs/${jobId}/lease`, 'POST', { nodeId: 'node-unbound' });
  assert.equal(status, 403);
  assert.equal(body.error, 'REMOTE_TENANT_REQUIRED');
});

test('IT-SCHED-008: leasing a job hands out a lease', async () => {
  const [, list] = await api(`/api/scheduler/jobs?tenantId=${TENANT}`, 'GET', undefined, { node: 'node-http-1' });
  const jobId = list.jobs[0].jobId;
  const [status, body] = await api(`/api/scheduler/jobs/${jobId}/lease`, 'POST', { nodeId: 'node-http-1' });
  assert.equal(status, 200);
  assert.equal(body.job.state, 'leased');
  assert.equal(body.job.lease.nodeId, 'node-http-1');
  assert.equal(typeof body.job.lease.leaseId, 'string');
  // The leaseId is the fencing credential: keep it for the next tests.
  leases.first = body.job.lease.leaseId;
});

test('IT-SCHED-009: a second node cannot lease the same job (no double run)', async () => {
  const [, list] = await api(`/api/scheduler/jobs?tenantId=${TENANT}`, 'GET', undefined, { node: 'node-http-1' });
  const jobId = list.jobs[0].jobId;
  const [status, body] = await api(`/api/scheduler/jobs/${jobId}/lease`, 'POST', { nodeId: 'node-http-2' });
  assert.equal(status, 409);
  assert.equal(body.error, 'REMOTE_JOB_NOT_LEASABLE');
});

test('IT-SCHED-010: a heartbeat renews the lease over the wire', async () => {
  const [, list] = await api(`/api/scheduler/jobs?tenantId=${TENANT}`, 'GET', undefined, { node: 'node-http-1' });
  const jobId = list.jobs[0].jobId;
  state.t += 20_000;
  const [status, body] = await api(`/api/scheduler/jobs/${jobId}/heartbeat`, 'POST', {
    nodeId: 'node-http-1',
    leaseId: leases.first,
    seq: 1,
  });
  assert.equal(status, 200);
  assert.equal(body.expired, false);
  assert.equal(body.job.state, 'leased');
});

test('IT-SCHED-011: after the lease expires the job is recoverable (requeued and re-leasable)', async () => {
  const [, list] = await api(`/api/scheduler/jobs?tenantId=${TENANT}`, 'GET', undefined, { node: 'node-http-1' });
  const jobId = list.jobs[0].jobId;
  state.t += 31_000;
  const [status, body] = await api(`/api/scheduler/jobs/${jobId}/heartbeat`, 'POST', {
    nodeId: 'node-http-1',
    leaseId: leases.first,
    seq: 2,
  });
  assert.equal(status, 409);
  assert.equal(body.error, 'REMOTE_LEASE_EXPIRED');
  // Recoverable: another node can pick it up.
  const [leaseStatus, leaseBody] = await api(`/api/scheduler/jobs/${jobId}/lease`, 'POST', { nodeId: 'node-http-2' });
  assert.equal(leaseStatus, 200);
  assert.equal(leaseBody.job.state, 'leased');
  assert.equal(leaseBody.job.attempt, 2);
  leases.second = leaseBody.job.lease.leaseId;
});

test('IT-SCHED-012: the stale node cannot report the result after the re-dispatch', async () => {
  const [, list] = await api(`/api/scheduler/jobs?tenantId=${TENANT}`, 'GET', undefined, { node: 'node-http-1' });
  const jobId = list.jobs[0].jobId;
  const [status, body] = await api(`/api/scheduler/jobs/${jobId}/result`, 'POST', {
    nodeId: 'node-http-1',
    leaseId: leases.first,
    idempotencyKey: 'r-stale-http',
    status: 'succeeded',
  });
  assert.equal(status, 409);
  assert.equal(body.error, 'REMOTE_JOB_NOT_LEASABLE');
});

test('IT-SCHED-013: a replayed result returns the first result and does not change the state', async () => {
  const [, list] = await api(`/api/scheduler/jobs?tenantId=${TENANT}`, 'GET', undefined, { node: 'node-http-1' });
  const jobId = list.jobs[0].jobId;
  const [, first] = await api(`/api/scheduler/jobs/${jobId}/result`, 'POST', {
    nodeId: 'node-http-2',
    leaseId: leases.second,
    idempotencyKey: 'r-http-1',
    status: 'succeeded',
    payload: { passed: 7 },
  });
  assert.equal(first.job.state, 'succeeded');
  const [status, body] = await api(`/api/scheduler/jobs/${jobId}/result`, 'POST', {
    nodeId: 'node-http-2',
    leaseId: leases.second,
    idempotencyKey: 'r-http-1',
    status: 'succeeded',
    payload: { passed: 7 },
  });
  assert.equal(status, 200);
  assert.equal(body.replayed, true);
  assert.deepEqual(body.result.payload, { passed: 7 });
  assert.equal(body.job.state, 'succeeded');
});

test('IT-SCHED-014: a job of another tenant is not found', async () => {
  const [, list] = await api(`/api/scheduler/jobs?tenantId=${TENANT}`, 'GET', undefined, { node: 'node-http-1' });
  const jobId = list.jobs[0].jobId;
  const [status, body] = await api(`/api/scheduler/jobs/${jobId}/lease`, 'POST', { nodeId: 'node-http-3' });
  assert.equal(status, 404);
  assert.equal(body.error, 'REMOTE_JOB_NOT_FOUND');
});

test('IT-SCHED-015: releasing a node returns its jobs to the queue', async () => {
  const [, dispatch] = await cp('/api/scheduler/jobs', 'POST', {
    tenantId: TENANT,
    idempotencyKey: 'idem-http-release',
    projectUid: 'proj_http',
    gitSha: SHA,
  });
  const jobId = dispatch.job.jobId;
  await api(`/api/scheduler/jobs/${jobId}/lease`, 'POST', { nodeId: 'node-http-1' });
  const [status, body] = await cp('/api/scheduler/nodes/node-http-1/release', 'POST', {});
  assert.equal(status, 200);
  assert.ok(body.released.includes(jobId));
  // The release drops the node's tenant binding, so the read path has no
  // tenant source any more -- the job is still there, but the caller cannot
  // name the tenant it belongs to.
  const [unboundStatus, unboundBody] = await api(`/api/scheduler/jobs/${jobId}`, 'GET', undefined, { node: 'node-http-1' });
  assert.equal(unboundStatus, 403);
  assert.equal(unboundBody.error, 'REMOTE_TENANT_REQUIRED');
  // Re-bind the node so the remaining read-path tests have a tenant source.
  await cp('/api/scheduler/nodes/node-http-1', 'POST', { tenantId: TENANT });
  const [, after] = await api(`/api/scheduler/jobs/${jobId}`, 'GET', undefined, { node: 'node-http-1' });
  assert.equal(after.job.state, 'queued');
});

test('IT-SCHED-016: an unknown job is 404 REMOTE_JOB_NOT_FOUND', async () => {
  const [status, body] = await api(
    '/api/scheduler/jobs/job_00000000-0000-4000-8000-000000000000',
    'GET',
    undefined,
    { node: 'node-http-1' },
  );
  assert.equal(status, 404);
  assert.equal(body.error, 'REMOTE_JOB_NOT_FOUND');
});

test('IT-SCHED-017: an unknown route is 404 REMOTE_RESOURCE_NOT_FOUND', async () => {
  const [status, body] = await api('/api/scheduler/nope');
  assert.equal(status, 404);
  assert.equal(body.error, 'REMOTE_RESOURCE_NOT_FOUND');
});

/* ------------------------------------------------------------------ */
/* 租户作用域：读路径必须带节点上下文                                    */
/* ------------------------------------------------------------------ */

test('IT-SCHED-020: listing jobs without a node context is 403', async () => {
  const [status, body] = await api('/api/scheduler/jobs');
  assert.equal(status, 403);
  assert.equal(body.error, 'REMOTE_TENANT_REQUIRED');
});

test('IT-SCHED-021: listing jobs with an unknown node context is 403', async () => {
  const [status, body] = await api('/api/scheduler/jobs', 'GET', undefined, { node: 'node-never-bound' });
  assert.equal(status, 403);
  assert.equal(body.error, 'REMOTE_TENANT_REQUIRED');
});

test('IT-SCHED-022: a node context only sees its own tenant jobs', async () => {
  // node-http-3 is bound to OTHER_TENANT.
  const [status, body] = await api('/api/scheduler/jobs', 'GET', undefined, { node: 'node-http-3' });
  assert.equal(status, 200);
  for (const job of body.jobs) assert.equal(job.tenantId, OTHER_TENANT);
});

test('IT-SCHED-023: a claimed tenant that differs from the node context is 403', async () => {
  const [status, body] = await api(
    '/api/scheduler/jobs?tenantId=ten_other',
    'GET',
    undefined,
    { node: 'node-http-1' },
  );
  assert.equal(status, 403);
  assert.equal(body.error, 'REMOTE_TENANT_MISMATCH');
});

test('IT-SCHED-024: another tenant job is 404 for a node of a different tenant', async () => {
  const [, dispatch] = await cp('/api/scheduler/jobs', 'POST', {
    tenantId: TENANT,
    idempotencyKey: 'idem-http-tenant-isolation',
    projectUid: 'proj_secret',
    gitSha: SHA,
  });
  const jobId = dispatch.job.jobId;
  const [status, body] = await api(`/api/scheduler/jobs/${jobId}`, 'GET', undefined, { node: 'node-http-3' });
  assert.equal(status, 404);
  assert.equal(body.error, 'REMOTE_JOB_NOT_FOUND');
  // The projectUid of the other tenant is NOT leaked.
  assert.equal(body.job, undefined);
  assert.equal(body.projectUid, undefined);
});

test('IT-SCHED-025: releasing a node without the control-plane credential is 401', async () => {
  const [status, body] = await api('/api/scheduler/nodes/node-http-3/release', 'POST', {});
  assert.equal(status, 401);
  assert.equal(body.error, 'REMOTE_UNAUTHENTICATED');
});

test('IT-SCHED-026: binding a node without the control-plane credential is 401', async () => {
  const [status, body] = await api('/api/scheduler/nodes/attacker-node', 'POST', { tenantId: OTHER_TENANT });
  assert.equal(status, 401);
  assert.equal(body.error, 'REMOTE_UNAUTHENTICATED');
});

test('IT-SCHED-027: cancelling a job without the control-plane credential is 401', async () => {
  const [, dispatch] = await cp('/api/scheduler/jobs', 'POST', {
    tenantId: TENANT,
    idempotencyKey: 'idem-http-cancel-auth',
    projectUid: 'proj_http',
    gitSha: SHA,
  });
  const jobId = dispatch.job.jobId;
  const [status, body] = await api(`/api/scheduler/jobs/${jobId}/cancel`, 'POST', {
    idempotencyKey: 'c-http-1',
    tenantId: TENANT,
  });
  assert.equal(status, 401);
  assert.equal(body.error, 'REMOTE_UNAUTHENTICATED');
});

test('IT-SCHED-028: a lease request with an over-long leaseMs is capped by the server', async () => {
  const [, dispatch] = await cp('/api/scheduler/jobs', 'POST', {
    tenantId: TENANT,
    idempotencyKey: 'idem-http-lease-cap',
    projectUid: 'proj_http',
    gitSha: SHA,
  });
  const jobId = dispatch.job.jobId;
  const [status, body] = await api(`/api/scheduler/jobs/${jobId}/lease`, 'POST', {
    nodeId: 'node-http-2',
    leaseMs: 10 * 365 * 24 * 3600 * 1000,
  });
  assert.equal(status, 200);
  assert.ok(body.job.lease.durationMs <= 300_000, `lease was not capped: ${body.job.lease.durationMs}`);
});

test('IT-SCHED-029: a node cannot ack a job without presenting the current leaseId', async () => {
  const [, dispatch] = await cp('/api/scheduler/jobs', 'POST', {
    tenantId: TENANT,
    idempotencyKey: 'idem-http-fencing',
    projectUid: 'proj_http',
    gitSha: SHA,
  });
  const jobId = dispatch.job.jobId;
  const [, leased] = await api(`/api/scheduler/jobs/${jobId}/lease`, 'POST', { nodeId: 'node-http-2' });
  const leaseId = leased.job.lease.leaseId;
  // An ack without the leaseId cannot prove lease ownership.
  const [status, body] = await api(`/api/scheduler/jobs/${jobId}/ack`, 'POST', {
    nodeId: 'node-http-2',
    idempotencyKey: 'a-http-1',
  });
  assert.equal(status, 409);
  assert.equal(body.error, 'REMOTE_JOB_NOT_LEASABLE');
  // With the leaseId it works.
  const [okStatus, okBody] = await api(`/api/scheduler/jobs/${jobId}/ack`, 'POST', {
    nodeId: 'node-http-2',
    leaseId,
    idempotencyKey: 'a-http-2',
  });
  assert.equal(okStatus, 200);
  assert.equal(okBody.job.state, 'running');
});

test('IT-SCHED-030: a RUNNING job of a silent node is requeued by the sweep', async () => {
  const [, dispatch] = await cp('/api/scheduler/jobs', 'POST', {
    tenantId: TENANT,
    idempotencyKey: 'idem-http-sweep-running',
    projectUid: 'proj_http',
    gitSha: SHA,
  });
  const jobId = dispatch.job.jobId;
  const [, leased] = await api(`/api/scheduler/jobs/${jobId}/lease`, 'POST', { nodeId: 'node-http-2' });
  const leaseId = leased.job.lease.leaseId;
  await api(`/api/scheduler/jobs/${jobId}/ack`, 'POST', {
    nodeId: 'node-http-2',
    leaseId,
    idempotencyKey: 'a-http-running',
  });
  // The node goes silent and the lease expires.
  state.t += 31_000;
  const [sweepStatus, sweepBody] = await cp(`/api/scheduler/jobs/${jobId}/sweep`, 'POST', {});
  assert.equal(sweepStatus, 200);
  assert.ok(sweepBody.requeued.includes(jobId), 'the running job was not requeued');
  const [, after] = await api(`/api/scheduler/jobs/${jobId}`, 'GET', undefined, { node: 'node-http-1' });
  assert.equal(after.job.state, 'queued');
});

test('IT-SCHED-CLEANUP: stop the scheduler', () => {
  server.close();
});
