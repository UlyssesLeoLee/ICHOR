#!/usr/bin/env node
/**
 * ATS-502 probe -- the review round 1 counter-examples, re-runnable.
 *
 * Opus's review of round 1 produced 13 counter-examples (P1~P8 for the
 * scheduling core, H1~H5 for the HTTP surface). The round-1 tree
 * (`8130e35`) hit all 13; this task fixes them. A fix that cannot be shown
 * to turn the counter-examples green is not a fix, so the counter-examples
 * are kept here as a **runnable probe** rather than as prose.
 *
 * This probe runs against ANY tree: it takes the path to a checkout and
 * reports, for every counter-example, whether the DEFECT is present. So the
 * same file produces
 *   - "13/13 defects" on the rejected tree (`8130e35`), and
 *   - "0/13 defects" on the fixed tree.
 *
 * The probe is API-shape agnostic on purpose: it passes the `leaseId` it got
 * from `lease()` into every node-side call. The rejected tree simply ignores
 * the extra field; the fixed tree requires it. That way the SAME file is the
 * red-to-green control -- it is not a second script written to match the new
 * implementation.
 *
 * Usage: node tools/ats502-probes/review-probes.mjs <path-to-checkout>
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) {
  console.error('usage: node tools/ats502-probes/review-probes.mjs <path-to-checkout>');
  process.exit(2);
}

/**
 * The checkout path, resolved to an ABSOLUTE NATIVE path.
 *
 * The path may come from a shell. An MSYS / Git-Bash path like /d/tmp/x is
 * NOT a native Windows path: `path.resolve` treats the leading slash as
 * "the root of the current drive", so it becomes `D:\d\tmp\x` -- a
 * directory that does not exist. The MSYS form is therefore translated
 * first (`/d/...` -> `D:\...`), and only then resolved.
 */
function nativePath(input) {
  let p = input;
  // An MSYS drive mount: /c/... /d/... -> C:\... D:\...
  const msys = /^\/([A-Za-z])\/(.*)$/.exec(p);
  if (msys) {
    p = msys[1].toUpperCase() + ':' + path.sep + msys[2].split('/').join(path.sep);
  }
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

const checkout = nativePath(root);

const { JobQueue, QueueError } = await import(pathToFileURL(path.join(checkout, 'server/queue.mjs')).href);
const { createSchedulerServer } = await import(pathToFileURL(path.join(checkout, 'server/scheduler.mjs')).href);

const SHA = 'a'.repeat(40);
let t = 1_000_000;
const clock = () => t;
const out = [];
/** @param defect true means the counter-example still reproduces. */
const rec = (id, desc, observed, defect) => out.push({ id, desc, observed, defect });
const tryCode = (fn) => {
  try { const r = fn(); return { ok: true, r }; } catch (e) { return { ok: false, code: e instanceof QueueError ? e.code : String(e) }; }
};

function fresh() {
  t = 1_000_000;
  const q = new JobQueue({ now: clock, leaseMs: 1000 });
  q.bindNode('A', 'T1');
  q.bindNode('B', 'T1');
  return q;
}

/**
 * P1: running job, node dies (no heartbeat) -> sweep after expiry.
 * The job must leave `running` and become re-leasable.
 */
{
  const q = fresh();
  const { job } = q.dispatch({ tenantId: 'T1', idempotencyKey: 'd1', projectUid: 'p', gitSha: SHA });
  const l1 = q.lease(job.jobId, { nodeId: 'A' }).job.lease.leaseId;
  q.ack(job.jobId, { nodeId: 'A', leaseId: l1, idempotencyKey: 'a1' });
  t += 10_000;
  const s = q.sweep();
  const l = tryCode(() => q.lease(job.jobId, { nodeId: 'B' }));
  const state = q.get(job.jobId).state;
  rec('P1', 'running job, node silent, lease expired 10s ago, sweep() then lease by B',
    `sweep=${JSON.stringify(s)} state=${state} leaseB=${l.ok ? 'ok' : l.code}`,
    state === 'running' && !l.ok);
}

/**
 * P2: running job + releaseNode.
 */
{
  const q = fresh();
  const { job } = q.dispatch({ tenantId: 'T1', idempotencyKey: 'd1', projectUid: 'p', gitSha: SHA });
  const l1 = q.lease(job.jobId, { nodeId: 'A' }).job.lease.leaseId;
  q.ack(job.jobId, { nodeId: 'A', leaseId: l1, idempotencyKey: 'a1' });
  const rel = q.releaseNode('A');
  const l = tryCode(() => q.lease(job.jobId, { nodeId: 'B' }));
  rec('P2', 'running job, releaseNode(A), then lease by B',
    `released=${rel.length} state=${q.get(job.jobId).state} leaseB=${l.ok ? 'ok' : l.code}`,
    rel.length === 0 && !l.ok);
}

/**
 * P3: running job past deadline, sweep.
 */
{
  const q = fresh();
  const deadline = new Date(t + 5000).toISOString();
  const { job } = q.dispatch({ tenantId: 'T1', idempotencyKey: 'd1', projectUid: 'p', gitSha: SHA, deadline });
  const l1 = q.lease(job.jobId, { nodeId: 'A' }).job.lease.leaseId;
  q.ack(job.jobId, { nodeId: 'A', leaseId: l1, idempotencyKey: 'a1' });
  t += 60_000;
  const s = q.sweep();
  rec('P3', 'running job, node silent, deadline passed 55s ago, sweep()',
    `sweep=${JSON.stringify(s)} state=${q.get(job.jobId).state}`,
    q.get(job.jobId).state === 'running');
}

/**
 * P4: ack after lease expiry (no sweep in between).
 * The ack must be refused; accepting it would lock the job in `running`.
 */
{
  const q = fresh();
  const { job } = q.dispatch({ tenantId: 'T1', idempotencyKey: 'd1', projectUid: 'p', gitSha: SHA });
  const l1 = q.lease(job.jobId, { nodeId: 'A' }).job.lease.leaseId;
  t += 5_000;
  const a = tryCode(() => q.ack(job.jobId, { nodeId: 'A', leaseId: l1, idempotencyKey: 'a1' }));
  rec('P4', 'ack 5s after a 1s lease expired (no sweep in between)',
    `ack=${a.ok ? 'accepted' : a.code} state=${q.get(job.jobId).state}`,
    a.ok);
}

/**
 * P5: same node re-leases after expiry; attempt-1 result must not be taken
 * for attempt 2 (lease fencing).
 */
{
  const q = fresh();
  const { job } = q.dispatch({ tenantId: 'T1', idempotencyKey: 'd1', projectUid: 'p', gitSha: SHA });
  const l1 = q.lease(job.jobId, { nodeId: 'A' }).job.lease.leaseId;
  t += 5_000; q.sweep();
  const l2 = q.lease(job.jobId, { nodeId: 'A' }).job.lease.leaseId;
  const r = tryCode(() => q.result(job.jobId, { nodeId: 'A', leaseId: l1, idempotencyKey: 'r-from-attempt-1', status: 'succeeded', payload: { leaseId: l1 } }));
  rec('P5', 'A re-leases after expiry (attempt 2); a late result from attempt 1 arrives',
    `result=${r.ok ? 'accepted as attempt ' + r.r.result.attempt : r.code}; (l1!=l2: ${l1 !== l2})`,
    r.ok);
}

/**
 * P6: stale node reports on a terminal job -> must be refused, not answered
 * with `replayed:true`.
 */
{
  const q = fresh();
  const { job } = q.dispatch({ tenantId: 'T1', idempotencyKey: 'd1', projectUid: 'p', gitSha: SHA });
  const l1 = q.lease(job.jobId, { nodeId: 'A' }).job.lease.leaseId;
  t += 5_000; q.sweep();
  const l2 = q.lease(job.jobId, { nodeId: 'B' }).job.lease.leaseId;
  q.result(job.jobId, { nodeId: 'B', leaseId: l2, idempotencyKey: 'rb', status: 'succeeded' });
  const r = tryCode(() => q.result(job.jobId, { nodeId: 'A', leaseId: l1, idempotencyKey: 'ra', status: 'failed' }));
  rec('P6', 'stale node A reports failed after B finished the job',
    r.ok ? `accepted: replayed=${r.r.replayed} result.status=${r.r.result.status}` : r.code,
    r.ok);
}

/**
 * P7: client-controlled lease duration. A node must not be able to buy a
 * lease long enough to outlive the sweep.
 */
{
  const q = fresh();
  const { job } = q.dispatch({ tenantId: 'T1', idempotencyKey: 'd1', projectUid: 'p', gitSha: SHA });
  q.lease(job.jobId, { nodeId: 'A', leaseMs: 10 * 365 * 24 * 3600 * 1000 });
  t += 30 * 24 * 3600 * 1000;
  const s = q.sweep();
  const l = tryCode(() => q.lease(job.jobId, { nodeId: 'B' }));
  rec('P7', 'A leases with leaseMs=10 years, then goes silent for 30 days',
    `sweep=${JSON.stringify(s)} leaseB=${l.ok ? 'ok' : l.code}`, !l.ok);
}

/**
 * P8: result after deadline: the first call is refused, and the identical
 * replay must be refused too -- it must not turn into a success.
 */
{
  const q = fresh();
  const deadline = new Date(t + 500).toISOString();
  const { job } = q.dispatch({ tenantId: 'T1', idempotencyKey: 'd1', projectUid: 'p', gitSha: SHA, deadline });
  const l1 = q.lease(job.jobId, { nodeId: 'A' }).job.lease.leaseId;
  t += 800;
  const r1 = tryCode(() => q.result(job.jobId, { nodeId: 'A', leaseId: l1, idempotencyKey: 'r', status: 'succeeded' }));
  const r2 = tryCode(() => q.result(job.jobId, { nodeId: 'A', leaseId: l1, idempotencyKey: 'r', status: 'succeeded' }));
  rec('P8', 'result after deadline, then the identical request replayed',
    `first=${r1.ok ? 'ok' : r1.code} replay=${r2.ok ? 'ok replayed=' + r2.r.replayed + ' status=' + r2.r.result?.status : r2.code}`,
    !r1.ok && r2.ok);
}

/* --- the HTTP surface (H1~H5) ---------------------------------------- */

const { server, queue } = createSchedulerServer({ queue: new JobQueue({ leaseMs: 60_000 }) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/scheduler`;
const call = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
// The control-plane credential is only sent when the probe asks for it. The
// H1~H5 checks are about UNAUTHENTICATED access, so they do not send it.
await call('POST', '/nodes/victim-node', { tenantId: 'victim' });
const d = await call('POST', '/jobs', { tenantId: 'victim', idempotencyKey: 'v1', projectUid: 'secret-project', gitSha: SHA });
const vid = d.body.job?.jobId;

const list = await call('GET', '/jobs');
rec('H1', 'unauthenticated GET /jobs with no tenantId',
  `status=${list.status} jobs=${list.body.jobs?.length ?? 'n/a'}`,
  list.status === 200 && (list.body.jobs || []).length > 0);
const one = await call('GET', `/jobs/${vid}`);
rec('H2', 'unauthenticated GET /jobs/<victim job>',
  `status=${one.status} tenant=${one.body.job?.tenantId} projectUid=${one.body.job?.projectUid}`,
  one.status === 200);
const bind = await call('POST', '/nodes/attacker-node', { tenantId: 'victim' });
const steal = await call('POST', `/jobs/${vid}/lease`, { nodeId: 'attacker-node' });
rec('H3', 'attacker self-binds a new node to tenant "victim", then leases the victim job',
  `bind=${bind.status} lease=${steal.status} leaseNode=${steal.body.job?.lease?.nodeId}`,
  steal.status === 200);
const rel = await call('POST', '/nodes/attacker-node/release');
const d2 = await call('POST', '/jobs', { tenantId: 'victim', idempotencyKey: 'v2', projectUid: 'p2', gitSha: SHA });
const canc = await call('POST', `/jobs/${d2.body.job?.jobId}/cancel`, { idempotencyKey: 'c', tenantId: 'victim' });
rec('H4', 'unauthenticated cancel with tenantId taken from the request body',
  `status=${canc.status} state=${canc.body.job?.state}`,
  canc.status === 200);
const rebind = await call('POST', '/nodes/victim-node', { tenantId: 'other' });
const relv = await call('POST', '/nodes/victim-node/release');
rec('H5', "unauthenticated release of someone else's node",
  `release=${relv.status}`,
  relv.status === 200);
server.close();

let defects = 0;
for (const o of out) {
  if (o.defect) defects++;
  console.log(`${o.defect ? 'DEFECT' : 'ok    '}  ${o.id}  ${o.desc}\n        -> ${o.observed}`);
}
console.log(`\n${defects}/${out.length} probes show a defect`);
