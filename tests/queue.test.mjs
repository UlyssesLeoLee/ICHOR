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
import {
  JobQueue,
  QueueError,
  requestDigest,
  REJECTION_CODES,
  TERMINAL_STATES,
  MAX_LEASE_MS,
  MIN_LEASE_MS,
} from '../server/queue.mjs';

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
  assert.equal(queue.list({ tenantId: TENANT }).length, 1);
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
  assert.notEqual(other.job.jobId, queue.list({ tenantId: TENANT })[0].jobId);
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
  const first = queue.lease(job.jobId, { nodeId: 'node-1' });
  // The leaseId is captured as a STRING: the job object is mutated by the
  // re-lease below, so reading `first.job.lease.leaseId` later would read
  // the NEW lease and the assertion would be vacuous.
  const firstLeaseId = first.job.lease.leaseId;
  advance(31_000);
  const second = queue.lease(job.jobId, { nodeId: 'node-2' });
  // The disconnected node comes back and tries to report its result: it no
  // longer holds the lease, so the report must be refused -- otherwise the
  // job would have two runs writing one terminal state. The fencing check is
  // on the leaseId, not only on the nodeId: the SAME node may come back.
  assert.throws(
    () => queue.result(job.jobId, {
      nodeId: 'node-1',
      leaseId: firstLeaseId,
      idempotencyKey: 'r-stale',
      status: 'succeeded',
    }),
    (e) => e.code === 'REMOTE_JOB_NOT_LEASABLE',
  );
  // Even the current holder's report is refused when it presents a leaseId
  // that is not the current one.
  assert.throws(
    () => queue.result(job.jobId, {
      nodeId: 'node-2',
      leaseId: firstLeaseId,
      idempotencyKey: 'r-stale-2',
      status: 'succeeded',
    }),
    (e) => e.code === 'REMOTE_JOB_NOT_LEASABLE',
  );
  // The current holder CAN report.
  const ok = queue.result(job.jobId, {
    nodeId: 'node-2',
    leaseId: second.job.lease.leaseId,
    idempotencyKey: 'r-fresh',
    status: 'succeeded',
  });
  assert.equal(ok.replayed, false);
  assert.equal(ok.job.state, 'succeeded');
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
  const leased = queue.lease(job.jobId, { nodeId: 'node-1' });
  const leaseId = leased.job.lease.leaseId;
  advance(20_000);
  queue.heartbeat(job.jobId, { nodeId: 'node-1', leaseId, seq: 1 });
  // 20s later the lease is still alive thanks to the heartbeat.
  advance(20_000);
  const again = queue.heartbeat(job.jobId, { nodeId: 'node-1', leaseId, seq: 2 });
  assert.equal(again.expired, false);
  assert.equal(again.job.state, 'leased');
});

test('UT-QUEUE-051: a heartbeat after the lease expired is refused and the job is recoverable', () => {
  const { queue, advance } = makeQueue();
  queue.bindNode('node-1', TENANT);
  queue.bindNode('node-2', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  const leased = queue.lease(job.jobId, { nodeId: 'node-1' });
  const leaseId = leased.job.lease.leaseId;
  advance(31_000);
  assert.throws(
    () => queue.heartbeat(job.jobId, { nodeId: 'node-1', leaseId, seq: 1 }),
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
  const leased = queue.lease(job.jobId, { nodeId: 'node-1' });
  const leaseId = leased.job.lease.leaseId;
  queue.heartbeat(job.jobId, { nodeId: 'node-1', leaseId, seq: 5 });
  assert.throws(
    () => queue.heartbeat(job.jobId, { nodeId: 'node-1', leaseId, seq: 4 }),
    (e) => e.code === 'REMOTE_POLICY_REJECTED',
  );
});

test('UT-QUEUE-053: a job past its deadline becomes interrupted instead of being re-dispatched', () => {
  const { queue, advance } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest({ deadline: '2026-11-05T00:00:10.000Z' }));
  const leased = queue.lease(job.jobId, { nodeId: 'node-1' });
  const leaseId = leased.job.lease.leaseId;
  advance(20_000);
  assert.throws(
    () => queue.heartbeat(job.jobId, { nodeId: 'node-1', leaseId, seq: 1 }),
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
  const leased = queue.lease(job.jobId, { nodeId: 'node-1' });
  const leaseId = leased.job.lease.leaseId;
  advance(11_000);
  assert.throws(
    () => queue.result(job.jobId, { nodeId: 'node-1', leaseId, idempotencyKey: 'r-1', status: 'succeeded' }),
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
  const leased = queue.lease(job.jobId, { nodeId: 'node-1' });
  const leaseId = leased.job.lease.leaseId;
  const first = queue.result(job.jobId, { nodeId: 'node-1', leaseId, idempotencyKey: 'r-1', status: 'succeeded', payload: { passed: 3 } });
  assert.equal(first.replayed, false);
  assert.equal(first.job.state, 'succeeded');
  const second = queue.result(job.jobId, { nodeId: 'node-1', leaseId, idempotencyKey: 'r-1', status: 'succeeded', payload: { passed: 3 } });
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
  const leased = queue.lease(job.jobId, { nodeId: 'node-1' });
  const leaseId = leased.job.lease.leaseId;
  queue.result(job.jobId, { nodeId: 'node-1', leaseId, idempotencyKey: 'r-1', status: 'succeeded', payload: { passed: 3 } });
  assert.throws(
    () => queue.result(job.jobId, { nodeId: 'node-1', leaseId, idempotencyKey: 'r-1', status: 'failed' }),
    (e) => e.code === 'REMOTE_IDEMPOTENCY_CONFLICT',
  );
});

test('UT-QUEUE-062: a terminal job ignores a further terminal report', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  const leased = queue.lease(job.jobId, { nodeId: 'node-1' });
  const leaseId = leased.job.lease.leaseId;
  queue.result(job.jobId, { nodeId: 'node-1', leaseId, idempotencyKey: 'r-1', status: 'failed' });
  // A DIFFERENT key, presented by the (now finished) holder: the job is
  // terminal and the holder has no lease any more, so the report is refused
  // rather than answered with `replayed:true` -- a 200 would tell the node
  // its result was accepted when it was not.
  assert.throws(
    () => queue.result(job.jobId, { nodeId: 'node-1', leaseId, idempotencyKey: 'r-2', status: 'succeeded' }),
    (e) => e.code === 'REMOTE_JOB_NOT_LEASABLE',
  );
  assert.equal(queue.get(job.jobId).state, 'failed');
  assert.equal(queue.get(job.jobId).result.status, 'failed');
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
  const leased = queue.lease(job.jobId, { nodeId: 'node-1' });
  const leaseId = leased.job.lease.leaseId;
  const first = queue.ack(job.jobId, { nodeId: 'node-1', leaseId, idempotencyKey: 'a-1' });
  assert.equal(first.job.state, 'running');
  const second = queue.ack(job.jobId, { nodeId: 'node-1', leaseId, idempotencyKey: 'a-1' });
  assert.equal(second.replayed, true);
  assert.equal(second.job.state, 'running');
});

/* ------------------------------------------------------------------ */
/* 复核第 1 轮的反例回归（P1~P8）                                        */
/*                                                                      */
/* 这八条是 Opus 在第 1 轮复核里给出的反例，每一条都对应一个真实的缺陷。 */
/* 它们在这里被固化成回归用例：在被驳回的那棵树（8130e35）上全部为红，   */
/* 修复后必须全部为绿。反例探针的原始形态见                            */
/* docs/evidence/ATS-502/08-review-probes.log。                         */
/* ------------------------------------------------------------------ */

/** A queue with a 1s lease -- the shape the review probes used. */
function probeQueue() {
  const state = { t: Date.parse('2026-11-05T00:00:00.000Z') };
  const queue = new JobQueue({ now: () => state.t, leaseMs: 1_000 });
  queue.bindNode('A', TENANT);
  queue.bindNode('B', TENANT);
  return { queue, advance(ms) { state.t += ms; }, at() { return state.t; } };
}

test('UT-QUEUE-080 (P1): a RUNNING job whose node goes silent is requeued by the sweep', () => {
  const { queue, advance } = probeQueue();
  const { job } = queue.dispatch(dispatchRequest());
  const leased = queue.lease(job.jobId, { nodeId: 'A' });
  queue.ack(job.jobId, { nodeId: 'A', leaseId: leased.job.lease.leaseId, idempotencyKey: 'a1' });
  assert.equal(queue.get(job.jobId).state, 'running');
  // The node disappears while the job is EXECUTING.
  advance(10_000);
  const swept = queue.sweep();
  assert.ok(swept.requeued.includes(job.jobId), 'the running job was not requeued');
  assert.equal(queue.get(job.jobId).state, 'queued');
  // And it can be picked up by another node: the recovery is real.
  const again = queue.lease(job.jobId, { nodeId: 'B' });
  assert.equal(again.job.state, 'leased');
  assert.equal(again.job.attempt, 2);
});

test('UT-QUEUE-081 (P2): releasing a node requeues its RUNNING jobs too', () => {
  const { queue } = probeQueue();
  const { job } = queue.dispatch(dispatchRequest());
  const leased = queue.lease(job.jobId, { nodeId: 'A' });
  queue.ack(job.jobId, { nodeId: 'A', leaseId: leased.job.lease.leaseId, idempotencyKey: 'a1' });
  const released = queue.releaseNode('A');
  assert.equal(released.length, 1);
  assert.equal(released[0].state, 'queued');
  // Another node may take it -- the session died, the work did not.
  const again = queue.lease(job.jobId, { nodeId: 'B' });
  assert.equal(again.job.state, 'leased');
});

test('UT-QUEUE-082 (P3): a RUNNING job past its deadline becomes interrupted', () => {
  const { queue, advance, at } = probeQueue();
  const deadline = new Date(at() + 5_000).toISOString();
  const { job } = queue.dispatch(dispatchRequest({ deadline }));
  const leased = queue.lease(job.jobId, { nodeId: 'A' });
  queue.ack(job.jobId, { nodeId: 'A', leaseId: leased.job.lease.leaseId, idempotencyKey: 'a1' });
  advance(60_000);
  const swept = queue.sweep();
  assert.ok(swept.interrupted.includes(job.jobId), 'the overdue running job was not interrupted');
  assert.equal(queue.get(job.jobId).state, 'interrupted');
});

test('UT-QUEUE-083 (P4): an ack that arrives after the lease expired is refused', () => {
  const { queue, advance } = probeQueue();
  const { job } = queue.dispatch(dispatchRequest());
  const leased = queue.lease(job.jobId, { nodeId: 'A' });
  const leaseId = leased.job.lease.leaseId;
  advance(5_000);
  assert.throws(
    () => queue.ack(job.jobId, { nodeId: 'A', leaseId, idempotencyKey: 'a1' }),
    (e) => e.code === 'REMOTE_LEASE_EXPIRED',
  );
  // The job must NOT have been pushed into the unrecoverable `running` state.
  assert.equal(queue.get(job.jobId).state, 'queued');
  // Another node may take it: the failure was recoverable.
  const again = queue.lease(job.jobId, { nodeId: 'B' });
  assert.equal(again.job.state, 'leased');
  assert.equal(again.job.attempt, 2);
});

test('UT-QUEUE-084 (P5): a late result from an expired attempt is refused after the same node re-leases', () => {
  const { queue, advance } = probeQueue();
  const { job } = queue.dispatch(dispatchRequest());
  const first = queue.lease(job.jobId, { nodeId: 'A' });
  const firstLeaseId = first.job.lease.leaseId;
  advance(5_000);
  queue.sweep();
  // The SAME node comes back and takes the job again (attempt 2).
  const second = queue.lease(job.jobId, { nodeId: 'A' });
  assert.notEqual(second.job.lease.leaseId, firstLeaseId);
  // The late result of attempt 1 must be refused: nodeId alone does not
  // identify the attempt.
  assert.throws(
    () => queue.result(job.jobId, {
      nodeId: 'A',
      leaseId: firstLeaseId,
      idempotencyKey: 'r-from-attempt-1',
      status: 'succeeded',
    }),
    (e) => e.code === 'REMOTE_JOB_NOT_LEASABLE',
  );
  // The current attempt may report.
  const ok = queue.result(job.jobId, {
    nodeId: 'A',
    leaseId: second.job.lease.leaseId,
    idempotencyKey: 'r-from-attempt-2',
    status: 'succeeded',
  });
  assert.equal(ok.job.state, 'succeeded');
});

test('UT-QUEUE-085 (P6): a stale node reporting on a finished job is refused, not replayed', () => {
  const { queue, advance } = probeQueue();
  const { job } = queue.dispatch(dispatchRequest());
  const first = queue.lease(job.jobId, { nodeId: 'A' });
  const staleLeaseId = first.job.lease.leaseId;
  advance(5_000);
  queue.sweep();
  const second = queue.lease(job.jobId, { nodeId: 'B' });
  queue.result(job.jobId, { nodeId: 'B', leaseId: second.job.lease.leaseId, idempotencyKey: 'rb', status: 'succeeded' });
  // The stale node A reports `failed` with a FRESH idempotency key. It must
  // be refused -- returning `replayed:true` would tell A that its result
  // was accepted.
  assert.throws(
    () => queue.result(job.jobId, { nodeId: 'A', leaseId: staleLeaseId, idempotencyKey: 'ra', status: 'failed' }),
    (e) => e.code === 'REMOTE_JOB_NOT_LEASABLE',
  );
  assert.equal(queue.get(job.jobId).state, 'succeeded');
  assert.equal(queue.get(job.jobId).result.status, 'succeeded');
});

test('UT-QUEUE-086 (P7): the lease duration is capped by the server', () => {
  const { queue, advance } = probeQueue();
  const { job } = queue.dispatch(dispatchRequest());
  const leased = queue.lease(job.jobId, { nodeId: 'A', leaseMs: 10 * 365 * 24 * 3600 * 1000 });
  // The requested 10 years was clamped to the server-side cap.
  assert.equal(leased.job.lease.durationMs, MAX_LEASE_MS);
  assert.ok(leased.job.lease.expiresAtMs - leased.job.lease.acquiredAtMs <= MAX_LEASE_MS);
  // 30 days of silence: the lease is long gone, so the job is reclaimable.
  advance(30 * 24 * 3600 * 1000);
  const swept = queue.sweep();
  assert.ok(swept.requeued.includes(job.jobId), 'the job was not reclaimed after the capped lease expired');
  const again = queue.lease(job.jobId, { nodeId: 'B' });
  assert.equal(again.job.state, 'leased');
});

test('UT-QUEUE-087 (P8): a result refused after the deadline stays refused when it is replayed', () => {
  const { queue, advance, at } = probeQueue();
  const deadline = new Date(at() + 500).toISOString();
  const { job } = queue.dispatch(dispatchRequest({ deadline }));
  const leased = queue.lease(job.jobId, { nodeId: 'A' });
  const leaseId = leased.job.lease.leaseId;
  advance(800);
  // The first attempt is refused.
  assert.throws(
    () => queue.result(job.jobId, { nodeId: 'A', leaseId, idempotencyKey: 'r', status: 'succeeded' }),
    (e) => e.code === 'REMOTE_LEASE_EXPIRED',
  );
  // The replay must NOT turn into a success.
  assert.throws(
    () => queue.result(job.jobId, { nodeId: 'A', leaseId, idempotencyKey: 'r', status: 'succeeded' }),
    (e) => e.code === 'REMOTE_LEASE_EXPIRED',
  );
  assert.equal(queue.get(job.jobId).state, 'interrupted');
});

/* ------------------------------------------------------------------ */
/* 租约 fencing 的直接断言                                              */
/* ------------------------------------------------------------------ */

test('UT-QUEUE-090: ack, heartbeat and result all refuse a missing leaseId', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  queue.lease(job.jobId, { nodeId: 'node-1' });
  for (const call of [
    () => queue.ack(job.jobId, { nodeId: 'node-1', idempotencyKey: 'a-1' }),
    () => queue.heartbeat(job.jobId, { nodeId: 'node-1', seq: 1 }),
    () => queue.result(job.jobId, { nodeId: 'node-1', idempotencyKey: 'r-1', status: 'succeeded' }),
  ]) {
    assert.throws(call, (e) => e.code === 'REMOTE_JOB_NOT_LEASABLE');
  }
});

test('UT-QUEUE-091: a foreign leaseId is refused even for the right node', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  const leased = queue.lease(job.jobId, { nodeId: 'node-1' });
  const foreign = 'lease_not_the_current_one';
  assert.notEqual(foreign, leased.job.lease.leaseId);
  assert.throws(
    () => queue.ack(job.jobId, { nodeId: 'node-1', leaseId: foreign, idempotencyKey: 'a-1' }),
    (e) => e.code === 'REMOTE_JOB_NOT_LEASABLE',
  );
});

test('UT-QUEUE-092: an idempotency key of another lease attempt is refused', () => {
  const { queue, advance } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  const first = queue.lease(job.jobId, { nodeId: 'node-1' });
  // The leaseIds are captured as STRINGS: the queue returns the live job
  // object, so `first.job.lease` is replaced by the re-lease below.
  const firstLeaseId = first.job.lease.leaseId;
  queue.ack(job.jobId, { nodeId: 'node-1', leaseId: firstLeaseId, idempotencyKey: 'a-1' });
  advance(31_000);
  // The SAME node re-leases the job (attempt 2). The request body is
  // identical -- same node, same key -- but it belongs to a different lease
  // attempt, so it must not be accepted as a replay of attempt 1.
  const second = queue.lease(job.jobId, { nodeId: 'node-1' });
  const secondLeaseId = second.job.lease.leaseId;
  assert.notEqual(secondLeaseId, firstLeaseId);
  assert.throws(
    () => queue.ack(job.jobId, { nodeId: 'node-1', leaseId: secondLeaseId, idempotencyKey: 'a-1' }),
    (e) => e.code === 'REMOTE_JOB_NOT_LEASABLE',
  );
});

test('UT-QUEUE-093: the lease duration is clamped to the server range on both ends', () => {
  const { queue } = makeQueue();
  queue.bindNode('node-1', TENANT);
  const { job } = queue.dispatch(dispatchRequest());
  const tooLong = queue.lease(job.jobId, { nodeId: 'node-1', leaseMs: 10 * 365 * 24 * 3600 * 1000 });
  assert.equal(tooLong.job.lease.durationMs, MAX_LEASE_MS);
  const other = queue.dispatch(dispatchRequest({ idempotencyKey: 'idem-2' }));
  const tooShort = queue.lease(other.job.jobId, { nodeId: 'node-1', leaseMs: 1 });
  assert.equal(tooShort.job.lease.durationMs, MIN_LEASE_MS);
});

/* ------------------------------------------------------------------ */
/* 租户作用域                                                           */
/* ------------------------------------------------------------------ */

test('UT-QUEUE-094: listing jobs without a tenant is refused', () => {
  const { queue } = makeQueue();
  queue.dispatch(dispatchRequest());
  assert.throws(
    () => queue.list({}),
    (e) => e.code === 'REMOTE_TENANT_REQUIRED',
  );
});

test('UT-QUEUE-095: reading a job of another tenant returns null', () => {
  const { queue } = makeQueue();
  const { job } = queue.dispatch(dispatchRequest());
  assert.equal(queue.get(job.jobId, TENANT) !== null, true);
  assert.equal(queue.get(job.jobId, OTHER_TENANT), null);
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
    const leased = first.lease(job.jobId, { nodeId: 'node-1' });
    const leaseId = leased.job.lease.leaseId;
    first.result(job.jobId, { nodeId: 'node-1', leaseId, idempotencyKey: 'r-1', status: 'succeeded' });

    const second = new JobQueue({ now: () => state.t, file });
    assert.equal(second.get(job.jobId).state, 'succeeded');
    // The idempotency record survived too: the replay is still a replay.
    const replay = second.result(job.jobId, { nodeId: 'node-1', leaseId, idempotencyKey: 'r-1', status: 'succeeded' });
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
  const leased = queue.lease(job.jobId, { nodeId: 'node-1' });
  seen.add(queue.get(job.jobId).state);
  queue.ack(job.jobId, { nodeId: 'node-1', leaseId: leased.job.lease.leaseId, idempotencyKey: 'a-1' });
  seen.add(queue.get(job.jobId).state);
  queue.result(job.jobId, {
    nodeId: 'node-1',
    leaseId: leased.job.lease.leaseId,
    idempotencyKey: 'r-1',
    status: 'succeeded',
  });
  seen.add(queue.get(job.jobId).state);
  for (const state of seen) {
    assert.ok(
      TERMINAL_STATES.includes(state) || ['queued', 'leased', 'running'].includes(state),
      `unexpected state ${state}`,
    );
  }
});
