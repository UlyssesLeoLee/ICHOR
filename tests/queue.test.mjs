/**
 * ATS-502 unit tests: the remote scheduling core.
 *
 * The three acceptance criteria of ATS-502 are covered by three groups:
 *   - 断连重投不双跑 (a re-dispatch after a disconnect must not double-run)
 *   - 心跳超时可恢复 (a heartbeat timeout must be recoverable)
 *   - 重放结果幂等 (a replayed result must be idempotent)
 *
 * The clock is injected, so every lease/heartbeat/deadline assertion is
 * deterministic -- no sleeping, no wall-clock flakiness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobQueue, QueueError, requestDigest, REJECTION_CODES, TERMINAL_STATES } from '../server/queue.mjs';

const TENANT = 'ten_demo';
const OTHER_TENANT = 'ten_other';
const SHA = 'a'.repeat(40);

/** A queue with a controllable clock. */
function makeQueue(opts = {}) {
  const state = { t: Date.parse('2026-11-05T00:00:00.000Z') };
  const queue = new JobQueue({
    now: () => state.t,
    leaseMs: 30_000,
    ...opts,
  });
  return { queue, state, advance(ms) { state.t += ms; } };
}

function dispatchRequest(overrides = {}) {
  return {
    tenantId: TENANT,
    idempotencyKey: 'idem-1',
    projectUid: 'proj_abc',
    gitSha: SHA,
    testUids: ['tst_1'],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 拒绝码与契约                                                        */
/* ------------------------------------------------------------------ */

test('UT-QUEUE-001: every rejection code is a REMOTE_ code with a HTTP status', () => {
  for (const [code, spec] of Object.entries(REJECTION_CODES)) {
    assert.match(code, /^REMOTE_[A-Z_]+$/, code);
    assert.ok(Number.isInteger(spec.http), code);
    assert.equal(typeof spec.retryable, 'boolean', code);
  }
});

test('UT-QUEUE-002: the request digest is stable against key order', () => {
  const a = requestDigest({ b: 2, a: 1, c: [1, 2] });
  const b = requestDigest({ c: [1, 2], a: 1, b: 2 });
  assert.equal(a, b);
  assert.notEqual(a, requestDigest({ b: 2, a: 1, c: [1, 3] }));
});

/* ------------------------------------------------------------------ */
/* 幂等键：必填 / 同键同体 / 同键异体                                 */
/* ------------------------------------------------------------------ */

test('UT-QUEUE-010: dispatch without an idempotency key is rejected', () => {
  const { queue } = makeQueue();
  assert.throws(
    () => queue.dispatch(dispatchRequest({ idempotencyKey: undefined })),
    (e) => e instanceof QueueError && e.code === 'REMOTE_POLICY_REJECTED',
  );
});

test('UT-QUEUE-011: the same key with the same body returns the first result', () => {
  const { queue } = makeQueue();
  const first = queue.dispatch(dispatchRequest());
  assert.equal(first.replayed, false);
  const second = queue.dispatch(dispatchRequest());
  assert.equal(second.replayed, true);
  assert.equal(second.job.jobId, first.job.jobId);
  // Exactly ONE job exists -- the replay did not enqueue a second one.
  assert.equal(queue.list().length, 1);
});

test('UT-QUEUE-012: the same key with a different body is a conflict', () => {
  const { queue } = makeQueue();
  queue.dispatch(dispatchRequest());
  assert.throws(
    () => queue.dispatch(dispatchRequest({ gitSha: 'b'.repeat(40) })),
    (e) => e instanceof QueueError && e.code === 'REMOTE_IDEMPOTENCY_CONFLICT',
  );
});

test('UT-QUEUE-013: the idempotency key is scoped to the tenant', () => {
  const { queue } = makeQueue();
  queue.dispatch(dispatchRequest());
  const other = queue.dispatch(dispatchRequest({ tenantId: OTHER_TENANT }));
  assert.equal(other.replayed, false);
  assert.notEqual(other.job.jobId, queue.list()[0].jobId);
});

/* ------------------------------------------------------------------ */
/* 入队校验                                                             */
/* ------------------------------------------------------------------ */

test('UT-QUEUE-020: dispatch rejects a non-40-hex git sha', () => {
  const { queue } = makeQueue();
  assert.throws(
    () => queue.dispatch(dispatchRequest({ gitSha: 'main' })),
    (e) => e.code === 'REMOTE_GIT_SHA_INVALID',
  );
});

test('UT-QUEUE-021: dispatch requires a tenant and a project uid', () => {
  const { queue } = makeQueue();
  assert.throws(() => queue.dispatch(dispatchRequest({ tenantId: '' })), (e) => e.code === 'REMOTE_TENANT_REQUIRED');
  assert.throws(() => queue.dispatch(dispatchRequest({ projectUid: '' })), (e) => e.code === 'REMOTE_POLICY_REJECTED');
});

/* ------------------------------------------------------------------ */
/* 租户隔离                                                             */
/* ------------------------------------------------------------------ */

test('UT-QUEUE-030: a node is bound to exactly one tenant', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  assert.throws(
    () => queue.bindNode('node-1', OTHER_TENANT),
    (e) => e.code === 'REMOTE_TENANT_MISMATCH',
  );
});

test('UT-QUEUE-031: a client-supplied tenant that differs from the binding is rejected', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  assert.throws(
    () => queue.lease(job.jobId, { nodeId: 'node-1', claimedTenantId: OTHER_TENANT }),
    (e) => e.code === 'REMOTE_TENANT_MISMATCH',
  );
});

test('UT-QUEUE-032: a node cannot see a job of another tenant', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  queue.bindNode('node-2', OTHER_TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  assert.throws(
    () => queue.lease(job.jobId, { nodeId: 'node-2' }),
    (e) => e.code === 'REMOTE_JOB_NOT_FOUND',
  );
});

/* ------------------------------------------------------------------ */
/* 验收 1: 断连重投不双跑                                               */
/* ------------------------------------------------------------------ */

test('UT-QUEUE-040: a job leased by one node cannot be leased by another', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  queue.bindNode('node-2', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  assert.throws(
    () => queue.lease(job.jobId, { nodeId: 'node-2' }),
    (e) => e.code === 'REMOTE_JOB_NOT_LEASABLE',
  );
});

test('UT-QUEUE-041: re-leasing by the same node is idempotent and keeps one lease', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  const first = queue.lease(job.jobId, { nodeId: 'node-1' });
  const second = queue.lease(job.jobId, { nodeId: 'node-1' });
  assert.equal(second.replayed, true);
  assert.equal(second.job.lease.leaseId, first.job.lease.leaseId);
  // The attempt counter was NOT incremented by the replay.
  assert.equal(second.job.attempt, 1);
});

test('UT-QUEUE-042: after a lease expires the job returns to the queue and can be re-dispatched', () => {
  const { queue, advance } = makeQueue();
  queue.bindNode('node-1', TENANT);
  queue.bindNode('node-2', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  // The node disappears: the lease expires.
  advance(31_000);
  const again = queue.lease(job.jobId, { nodeId: 'node-2' });
  assert.equal(again.replayed, false);
  assert.equal(again.job.state, 'leased');
  assert.equal(again.job.lease.nodeId, 'node-2');
  // The old attempt is recorded as interrupted in the history, and the
  // attempt counter moved on -- the job ran under a NEW attempt, not the old one.
  assert.equal(again.job.attempt, 2);
  assert.ok(again.job.history.some((h) => h.event === 'job.requeued'));
});

test('UT-QUEUE-043: a stale node cannot report the result after the job was re-dispatched', () => {
  const { queue, advance } = makeQueue();
  queue.bindNode('node-1', TENANT);
  queue.bindNode('node-2', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  advance(31_000);
  queue.lease(job.jobId, { nodeId: 'node-2' });
  // The disconnected node comes back and tries to report its result: it no
  // longer holds the lease, so the report must be refused -- otherwise the
  // job would have two runs writing one terminal state.
  assert.throws(
    () => queue.result(job.jobId, { nodeId: 'node-1', idempotencyKey: 'r-stale', status: 'succeeded' }),
    (e) => e.code === 'REMOTE_JOB_NOT_LEASABLE',
  );
});

test('UT-QUEUE-044: releasing a node returns its leased jobs to the queue', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  const released = queue.releaseNode('node-1');
  assert.equal(released.length, 1);
  assert.equal(released[0].state, 'queued');
  assert.equal(released[0].lease, null);
});

test('UT-QUEUE-045: the retry budget is finite', () => {
  const { queue, advance } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest({ maxAttempts: 2 }));
  queue.lease(job.jobId, { nodeId: 'node-1' });
  advance(31_000);
  queue.lease(job.jobId, { nodeId: 'node-1' });
  advance(31_000);
  assert.throws(
    () => queue.lease(job.jobId, { nodeId: 'node-1' }),
    (e) => e.code === 'REMOTE_JOB_NOT_LEASABLE',
  );
  assert.equal(queue.get(job.jobId).state, 'failed');
});

/* ------------------------------------------------------------------ */
/* 验收 2: 心跳超时可恢复                                               */
/* ------------------------------------------------------------------ */

test('UT-QUEUE-050: a heartbeat renews the lease', () => {
  const { queue, advance } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  advance(20_000);
  queue.heartbeat(job.jobId, { nodeId: 'node-1', seq: 1 });
  // 20s later the lease is still alive thanks to the heartbeat.
  advance(20_000);
  const again = queue.heartbeat(job.jobId, { nodeId: 'node-1', seq: 2 });
  assert.equal(again.expired, false);
  assert.equal(again.job.state, 'leased');
});

test('UT-QUEUE-051: a heartbeat after the lease expired is refused and the job is recoverable', () => {
  const { queue, advance } = makeQueue();
  queue.bindNode('node-1', TENANT);
  queue.bindNode('node-2', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  advance(31_000);
  assert.throws(
    () => queue.heartbeat(job.jobId, { nodeId: 'node-1', seq: 1 }),
    (e) => e.code === 'REMOTE_LEASE_EXPIRED',
  );
  // The job is back in the queue and can be dispatched again -- the timeout
  // is recoverable, not a dead end.
  assert.equal(queue.get(job.jobId).state, 'queued');
  const again = queue.lease(job.jobId, { nodeId: 'node-2' });
  assert.equal(again.job.state, 'leased');
});

test('UT-QUEUE-052: a heartbeat seq must not go backwards', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  queue.heartbeat(job.jobId, { nodeId: 'node-1', seq: 5 });
  assert.throws(
    () => queue.heartbeat(job.jobId, { nodeId: 'node-1', seq: 4 }),
    (e) => e.code === 'REMOTE_POLICY_REJECTED',
  );
});

test('UT-QUEUE-053: a job past its deadline becomes interrupted instead of being re-dispatched', () => {
  const { queue, advance } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest({ deadline: '2026-11-05T00:00:10.000Z' }));
  queue.lease(job.jobId, { nodeId: 'node-1' });
  advance(20_000);
  assert.throws(
    () => queue.heartbeat(job.jobId, { nodeId: 'node-1', seq: 1 }),
    (e) => e.code === 'REMOTE_LEASE_EXPIRED',
  );
  assert.equal(queue.get(job.jobId).state, 'interrupted');
  // A terminal job is never leased again.
  assert.throws(
    () => queue.lease(job.jobId, { nodeId: 'node-1' }),
    (e) => e.code === 'REMOTE_JOB_NOT_LEASABLE',
  );
});

test('UT-QUEUE-054: the sweep requeues expired leases and interrupts overdue jobs', () => {
  const { queue, advance } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  advance(31_000);
  const swept = queue.sweep();
  assert.deepEqual(swept.requeued, [job.jobId]);
  assert.equal(queue.get(job.jobId).state, 'queued');
});

test('UT-QUEUE-055: a result after the deadline is refused', () => {
  const { queue, advance } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest({ deadline: '2026-11-05T00:00:10.000Z' }));
  queue.lease(job.jobId, { nodeId: 'node-1' });
  advance(11_000);
  assert.throws(
    () => queue.result(job.jobId, { nodeId: 'node-1', idempotencyKey: 'r-1', status: 'succeeded' }),
    (e) => e.code === 'REMOTE_LEASE_EXPIRED',
  );
  assert.equal(queue.get(job.jobId).state, 'interrupted');
});

/* ------------------------------------------------------------------ */
/* 验收 3: 重放结果幂等                                                 */
/* ------------------------------------------------------------------ */

test('UT-QUEUE-060: replaying a result returns the first result and does not change the state', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  const first = queue.result(job.jobId, { nodeId: 'node-1', idempotencyKey: 'r-1', status: 'succeeded', payload: { passed: 3 } });
  assert.equal(first.replayed, false);
  assert.equal(first.job.state, 'succeeded');
  const second = queue.result(job.jobId, { nodeId: 'node-1', idempotencyKey: 'r-1', status: 'succeeded', payload: { passed: 3 } });
  assert.equal(second.replayed, true);
  assert.equal(second.result.status, 'succeeded');
  assert.deepEqual(second.result.payload, { passed: 3 });
  assert.equal(second.job.state, 'succeeded');
  // The terminal state was written exactly once.
  assert.equal(second.job.history.filter((h) => h.event === 'job.finished').length, 1);
});

test('UT-QUEUE-061: the same result key with a different body is a conflict', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  queue.result(job.jobId, { nodeId: 'node-1', idempotencyKey: 'r-1', status: 'succeeded', payload: { passed: 3 } });
  assert.throws(
    () => queue.result(job.jobId, { nodeId: 'node-1', idempotencyKey: 'r-1', status: 'failed' }),
    (e) => e.code === 'REMOTE_IDEMPOTENCY_CONFLICT',
  );
});

test('UT-QUEUE-062: a terminal job ignores a further terminal report', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  queue.result(job.jobId, { nodeId: 'node-1', idempotencyKey: 'r-1', status: 'failed' });
  const again = queue.result(job.jobId, { nodeId: 'node-1', idempotencyKey: 'r-2', status: 'succeeded' });
  assert.equal(again.job.state, 'failed');
  assert.equal(again.result.status, 'failed');
});

test('UT-QUEUE-063: cancel is idempotent and terminal jobs stay terminal', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  const first = queue.cancel(job.jobId, { idempotencyKey: 'c-1', tenantId: TENANT });
  assert.equal(first.job.state, 'cancelled');
  const second = queue.cancel(job.jobId, { idempotencyKey: 'c-1', tenantId: TENANT });
  assert.equal(second.replayed, true);
  assert.equal(second.job.state, 'cancelled');
  assert.equal(second.job.history.filter((h) => h.event === 'job.cancelled').length, 1);
});

test('UT-QUEUE-064: ack moves a leased job to running, and a replayed ack is a no-op', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  const first = queue.ack(job.jobId, { nodeId: 'node-1', idempotencyKey: 'a-1' });
  assert.equal(first.job.state, 'running');
  const second = queue.ack(job.jobId, { nodeId: 'node-1', idempotencyKey: 'a-1' });
  assert.equal(second.replayed, true);
  assert.equal(second.job.state, 'running');
});

/* ------------------------------------------------------------------ */
/* 持久化                                                               */
/* ------------------------------------------------------------------ */

test('UT-QUEUE-070: the queue survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-queue-'));
  const file = path.join(dir, 'queue.json');
  try {
    const state = { t: Date.parse('2026-11-05T00:00:00.000Z') };
    const first = new JobQueue({ now: () => state.t, file });
    first.bindNode('node-1', TENANT);
    const { job } = first.dispatch(dispatchRequest());
    first.lease(job.jobId, { nodeId: 'node-1' });
    first.result(job.jobId, { nodeId: 'node-1', idempotencyKey: 'r-1', status: 'succeeded' });

    const second = new JobQueue({ now: () => state.t, file });
    assert.equal(second.get(job.jobId).state, 'succeeded');
    // The idempotency record survived too: the replay is still a replay.
    const replay = second.result(job.jobId, { nodeId: 'node-1', idempotencyKey: 'r-1', status: 'succeeded' });
    assert.equal(replay.replayed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UT-QUEUE-071: the snapshot counts every job state', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  const snap = queue.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.counts.leased, 1);
  assert.equal(snap.counts.queued, 0);
});

test('UT-QUEUE-072: every state the queue can produce is a terminal state or a known one', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  const seen = new Set([queue.get(job.jobId).state]);
  queue.lease(job.jobId, { nodeId: 'node-1' });
  seen.add(queue.get(job.jobId).state);
  queue.result(job.jobId, { nodeId: 'node-1', idempotencyKey: 'r-1', status: 'succeeded' });
  seen.add(queue.get(job.jobId).state);
  for (const state of seen) {
    assert.ok(
      TERMINAL_STATES.includes(state) || ['queued', 'leased', 'running'].includes(state),
      `unexpected state ${state}`,
    );
  }
});
