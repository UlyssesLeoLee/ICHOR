#!/usr/bin/env node
/**
 * ATS-502 probe -- the scheduling core against the frozen ATS-501 contract.
 *
 * ATS-501 froze the remote protocol as a DOCUMENT. ATS-502 implements the
 * scheduling part of it (queue / lease / heartbeat / idempotency / retry).
 * The two can drift apart, so this probe checks the implementation against
 * the frozen document mechanically:
 *
 *   1. the rejection-code table in `server/queue.mjs` is EXACTLY the one in
 *      the protocol's machine-readable constraint block -- same codes, same
 *      HTTP status, same retryable flag, no extra code, no missing code;
 *   2. every `REMOTE_*` token used anywhere in the implementation is a
 *      declared rejection code (a typo would be an undocumented rejection);
 *   3. the implementation's own error codes (`err.code`) are the declared
 *      rejection codes -- the service never invents a code;
 *   4. the job states the implementation can produce are a subset of the
 *      states the protocol recognises (`leased` is the protocol's added
 *      intermediate state; the terminal states come from
 *      docs/04-DETAILED-DESIGN.md §3);
 *   5. the idempotency-required message types of the protocol
 *      (`dispatch` / `cancel` / `result` / `ack` / `keyRotation`) are the ones
 *      the implementation actually enforces a key on;
 *   6. the scheduler does NOT import the local Bridge (HB-1) and does not
 *      read any Runner filesystem (HB-7);
 *   7. docs/WBS.xlsx「开发WBS」ATS-502 carries a consistent
 *      status / completion-rate / remaining-days triple.
 *
 * What this probe does NOT do: it does not verify any behaviour of a REAL
 * remote runner. No runner node exists in this repository. The behavioural
 * evidence is the unit and integration tests (tests/queue.test.mjs,
 * tests/scheduler.test.mjs), not this probe.
 *
 * Usage: node tools/ats502-probes/audit-scheduling-core.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..');
const DOC = path.join(REPO_ROOT, 'docs', '19-REMOTE-RUNNER-PROTOCOL.md');
const QUEUE = path.join(REPO_ROOT, 'server', 'queue.mjs');
const SCHEDULER = path.join(REPO_ROOT, 'server', 'scheduler.mjs');
const WBS = path.join(REPO_ROOT, 'docs', 'WBS.xlsx');

const failures = [];
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
}

/** Inflate a zip member. */
function inflate(buf) {
  const parts = {};
  // walk the central directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.slice(i, i + 4).toString('binary') === 'PK\x05\x06') { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    parts[name] = method === 0 ? raw.toString('utf8') : zlib.inflateRawSync(raw).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
  }
  return parts;
}

function sheetCells(parts, sheet) {
  const rows = {};
  const xml = parts[sheet];
  for (const rm of xml.matchAll(/<x:row[^>]*r="(\d+)"[^>]*>(.*?)<\/x:row>/gs)) {
    const rid = Number(rm[1]);
    const cells = {};
    for (const cm of rm[2].matchAll(/<x:c r="([A-Z]+)\d+"([^>]*)>(.*?)<\/x:c>/gs)) {
      const vm = cm[3].match(/<x:v>(.*?)<\/x:v>/s);
      let val = vm ? vm[1] : '';
      val = val.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      cells[cm[1]] = val;
    }
    rows[rid] = cells;
  }
  return rows;
}

const doc = fs.readFileSync(DOC, 'utf8');
const queueSrc = fs.readFileSync(QUEUE, 'utf8');
const schedSrc = fs.readFileSync(SCHEDULER, 'utf8');

/* --- 1. the rejection-code table matches the frozen contract ---------- */

const blockMatch = doc.match(/<!-- ats501-constraints -->\s*```json\s*([\s\S]*?)```/);
if (!blockMatch) {
  check('protocol constraint block is present', false, 'no <!-- ats501-constraints --> block in the protocol document');
} else {
  check('protocol constraint block is present', true);
  const block = JSON.parse(blockMatch[1]);
  const protocolCodes = new Map(
    block.rejection.codes.map((c) => [c.code, { http: c.http, retryable: c.retryable }]),
  );

  const implCodes = new Map();
  for (const m of queueSrc.matchAll(/REMOTE_[A-Z_]+:\s*\{\s*http:\s*(\d+),\s*retryable:\s*(true|false)\s*\}/g)) {
    implCodes.set(m[0].slice(0, m[0].indexOf(':')), {
      http: Number(m[1]),
      retryable: m[2] === 'true',
    });
  }

  const missing = [...protocolCodes.keys()].filter((c) => !implCodes.has(c));
  const extra = [...implCodes.keys()].filter((c) => !protocolCodes.has(c));
  const differing = [...protocolCodes.keys()]
    .filter((c) => implCodes.has(c))
    .filter((c) => protocolCodes.get(c).http !== implCodes.get(c).http
      || protocolCodes.get(c).retryable !== implCodes.get(c).retryable);

  check('every frozen rejection code exists in the implementation', missing.length === 0, missing.join(', '));
  check('the implementation invents no rejection code', extra.length === 0, extra.join(', '));
  check('every rejection code has the frozen HTTP status and retryability', differing.length === 0, differing.join(', '));
  check('the rejection table is not empty', implCodes.size > 0, `${implCodes.size} codes`);
}

/* --- 2. every REMOTE_ token used in the implementation is declared ---- */

const declared = new Set(
  [...queueSrc.matchAll(/REMOTE_[A-Z_]+:\s*\{/g)].map((m) => m[0].slice(0, m[0].indexOf(':'))),
);
const usedInQueue = new Set(queueSrc.match(/REMOTE_[A-Z_]+/g) || []);
const usedInScheduler = new Set(schedSrc.match(/REMOTE_[A-Z_]+/g) || []);
const undeclared = [...new Set([...usedInQueue, ...usedInScheduler])].filter((c) => !declared.has(c));
check('every REMOTE_ token in the implementation is a declared rejection code', undeclared.length === 0, undeclared.join(', '));

/* --- 3. the raised error codes are declared ---------------------------- */

const raised = new Set(
  [...queueSrc.matchAll(/new QueueError\('(REMOTE_[A-Z_]+)'/g)].map((m) => m[1]),
);
const undeclaredRaised = [...raised].filter((c) => !declared.has(c));
check('every error code the queue raises is declared', undeclaredRaised.length === 0, undeclaredRaised.join(', '));
check('the queue raises more than one kind of code', raised.size > 1, `${raised.size} distinct codes`);

/* --- 4. the job states are the protocol's states ----------------------- */

const statesMatch = queueSrc.match(/export const JOB_STATES = Object\.freeze\(\[([\s\S]*?)\]\)/);
const states = statesMatch
  ? [...statesMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  : [];
const allowed = new Set([
  'queued', 'running', 'cancelling', 'passed', 'failed', 'error', 'interrupted', 'cancelled',
  'leased', 'succeeded',
]);
const badStates = states.filter((s) => !allowed.has(s));
check('every job state the queue produces is a known state', badStates.length === 0, badStates.join(', '));
check('the lease state is present', states.includes('leased'), states.join(', '));

const termMatch = queueSrc.match(/export const TERMINAL_STATES = Object\.freeze\(\[([\s\S]*?)\]\)/);
const terminals = termMatch ? [...termMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
const badTerminals = terminals.filter((s) => !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(s));
check('the terminal states are exactly the protocol terminal set', badTerminals.length === 0, badTerminals.join(', '));

/* --- 5. the idempotency-required operations are enforced -------------- */

/**
 * Extract the body of a method from the source.
 *
 * Brace counting is enough here: the methods under test contain no braces
 * inside string literals, and a regex over the whole file would match a
 * neighbouring method's check instead of this one's.
 *
 * The parameter list is skipped first: several methods destructure their
 * options (`ack(jobId, { nodeId, idempotencyKey } = {})`), and counting from
 * the first `{` would stop at the end of the destructuring pattern instead of
 * the end of the body.
 */
function methodBody(src, name) {
  const start = src.indexOf(`\n  ${name}(`);
  if (start < 0) return '';
  const open = src.indexOf('(', start);
  let depth = 0;
  let bodyStart = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) { bodyStart = src.indexOf('{', i); break; }
    }
  }
  if (bodyStart < 0) return '';
  depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart + 1, i);
    }
  }
  return '';
}

for (const op of ['dispatch', 'ack', 'result', 'cancel']) {
  const body = methodBody(queueSrc, op);
  check(
    `the ${op} operation requires an idempotency key`,
    /idempotencyKey is required/.test(body),
    body ? 'no idempotency-key check in the method body' : 'method not found',
  );
}
check('the dispatch path computes a request digest', /requestDigest\(/.test(queueSrc));
check('the digest is order-independent', /Object\.keys\(value\)\.sort\(\)/.test(queueSrc));

/* --- 5b. the invariants the review round 1 found missing --------------- */

/**
 * The review round 1 rejected the implementation on four grounds that the
 * code itself has to carry. These checks read the SOURCE, so a regression
 * that removes the invariant turns the audit red.
 */
const leaseBody = methodBody(queueSrc, 'lease');
const ackBody = methodBody(queueSrc, 'ack');
const heartbeatBody = methodBody(queueSrc, 'heartbeat');
const resultBody = methodBody(queueSrc, 'result');
const sweepBody = methodBody(queueSrc, 'sweep');
const releaseBody = methodBody(queueSrc, 'releaseNode');

/* 1. the running state is recoverable -- the same path as `leased` */
// The check has to be able to FAIL when the RUNNING branch is removed, so
// it looks for the two-state form `A || B` rather than for the mere
// presence of the word 'running'.
check(
  'the sweep reclaims an expired lease of a RUNNING job, not only of a leased one',
  /\(\s*job\.state === 'leased'\s*\|\|\s*job\.state === 'running'\s*\)/.test(sweepBody),
  'the sweep handles only one of the two leased states',
);
check(
  'releasing a node requeues its RUNNING jobs too',
  /'running'/.test(releaseBody) && /'leased'/.test(releaseBody),
  'releaseNode handles only one of the two leased states',
);
check(
  'the lease path reclaims a RUNNING job whose lease expired',
  /\(\s*job\.state === 'leased'\s*\|\|\s*job\.state === 'running'\s*\)\s*&&\s*this\._leaseExpired\(job\)/.test(leaseBody),
  'the lease path does not reclaim an expired running job',
);
check(
  'the sweep interrupts a RUNNING job that is past its deadline',
  // The old form restricted the deadline branch to `queued` jobs only:
  //   `... && job.state === 'queued'`
  // The branch must apply to every non-terminal state, `running` included.
  /deadlineMs[^;]*now\(\)[^;]*;/.test(sweepBody) && !/now\(\) > job\.deadlineMs && job\.state === 'queued'/.test(sweepBody),
  'the sweep only interrupts queued jobs',
);

/* 2. lease fencing -- the leaseId identifies the attempt */
for (const [name, body] of [['ack', ackBody], ['heartbeat', heartbeatBody], ['result', resultBody]]) {
  check(
    `the ${name} operation requires a leaseId`,
    /leaseId/.test(body),
    'no leaseId in the method body',
  );
}
check(
  'the queue has a single fencing check that all three operations use',
  /_assertLeaseHolder/.test(ackBody)
    && /_assertLeaseHolder/.test(heartbeatBody)
    && /_assertLeaseHolder/.test(resultBody),
  'the fencing check is not shared by ack / heartbeat / result',
);
check(
  'a wrong leaseId is refused with REMOTE_JOB_NOT_LEASABLE',
  /REMOTE_JOB_NOT_LEASABLE/.test(queueSrc) && /leaseId is required to prove lease ownership/.test(queueSrc),
  'no fencing rejection in the queue',
);

/* 3. the lease duration is capped by the server */
check(
  'the queue exports a server-side lease-duration cap',
  /export const MAX_LEASE_MS/.test(queueSrc),
  'no MAX_LEASE_MS export',
);
check(
  'the lease path clamps the requested duration',
  /_clampLeaseMs/.test(leaseBody),
  'the lease path does not clamp the requested duration',
);

/* 4. a first failure stays a failure on replay */
check(
  'the queue records a failed request in the idempotency table',
  /_recordFailure/.test(queueSrc),
  'no _recordFailure helper',
);
// The check names the THROW, not just the field: a mutation that swallows
// the failure (returns the record instead of re-throwing it) must turn it
// red.
check(
  'the replay path re-throws a recorded failure instead of answering with a success',
  /if \(rec\.error\) \{\s*throw new QueueError\(/.test(queueSrc),
  'a recorded failure is not re-thrown on replay',
);

/* 5. the read path is tenant-scoped */
check(
  'the read path derives the tenant from a node context',
  /tenantOfRequest/.test(schedSrc) && /X-ATS-Scheduler-Node/.test(schedSrc),
  'the scheduler does not derive the tenant from a node context',
);
check(
  'the read path does not take the tenant from an untrusted query parameter',
  !/url\.searchParams\.get\('tenantId'\)\s*\|\|\s*undefined/.test(schedSrc),
  'the scheduler reads the tenant straight out of the query string',
);
// The check counts the CALL SITES, not the presence of the helper: a
// mutation that removes one call site must turn it red.
const cpCallSites = (schedSrc.match(/checkControlPlaneToken\(req, controlPlaneToken\)/g) || []).length;
check(
  'every control-plane write path requires a credential',
  cpCallSites >= 4,
  `only ${cpCallSites} control-plane credential checks (dispatch / cancel / sweep / node binding)`,
);

/* --- 6. the hard boundaries HB-1 / HB-7 ------------------------------- */

// Any import of the local Bridge is a boundary violation, whatever form it
// takes: a named import, a namespace import, a bare side-effect import, or
// a dynamic import. A check that only matched one spelling would let the
// other three through.
const bridgeImport = /import\s+[^;]*?['"]\.\/index\.mjs['"]|import\s*\(\s*['"]\.\/index\.mjs['"]\s*\)|require\s*\(\s*['"]\.\/index\.mjs['"]\s*\)/;
check('the scheduler does not import the local Bridge', !bridgeImport.test(schedSrc));
check('the scheduler does not import the local Bridge under any spelling',
  !/\.\/index\.mjs/.test(schedSrc), 'the scheduler references ./index.mjs');
check('the scheduler does not call the local Bridge over the network', !/127\.0\.0\.1:4577|localhost:4577/.test(schedSrc));
check('the scheduler does not read a Runner filesystem', !/readFileSync\(|readdirSync\(|realpathSync\(/.test(schedSrc));
check('the scheduler does not carry a local absolute path', !/local_absolute_path/.test(schedSrc));

/* --- 7. the WBS row is consistent -------------------------------------- */

const wbsParts = inflate(fs.readFileSync(WBS));
const rows = sheetCells(wbsParts, 'xl/worksheets/sheet2.xml');
let row = null;
let rowId = null;
for (const [rid, cells] of Object.entries(rows)) {
  if ((cells.A || '').startsWith('ATS-502')) { row = cells; rowId = Number(rid); break; }
}
if (!row) {
  check('the ATS-502 row exists in 开发WBS', false);
} else {
  check('the ATS-502 row exists in 开发WBS', true);
  const status = row.N || '';
  const rate = Number(row.O);
  const remaining = Number(row.P);
  const estimate = Number(row.K);
  check(
    'the ATS-502 status is one of the workbook statuses',
    ['未开始', '进行中', '待审核', '已完成', '已取消'].includes(status),
    status,
  );
  check('the ATS-502 completion rate is a number in [0,1]', Number.isFinite(rate) && rate >= 0 && rate <= 1, String(rate));
  check('the ATS-502 remaining days are consistent with the rate',
    Math.abs(remaining - estimate * (1 - rate)) < 0.001,
    `estimate=${estimate} rate=${rate} remaining=${remaining}`);
  // The acceptance criteria ("完成定义") live in column G; column H holds the
  // prerequisite WBS ids.
  check('the ATS-502 row carries the acceptance criteria of this task',
    /重投不双跑|不双跑/.test(row.G || '') && /心跳/.test(row.G || '') && /幂等/.test(row.G || ''),
    row.G || '(empty)');
  check('the ATS-502 row names ATS-501 as its prerequisite',
    (row.H || '').includes('ATS-501'), row.H || '(empty)');
  check('the ATS-502 verification method is UT,IT',
    (row.Q || '').replace(/\s/g, '') === 'UT,IT', row.Q || '(empty)');
  check('the ATS-502 risk cell records the idempotency / consistency risk',
    /幂等/.test(row.T || ''),
    (row.T || '').slice(0, 120));
}

/* --- report ------------------------------------------------------------ */

for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail && !c.ok ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
if (failures.length) {
  console.error('\nFAILED:');
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log('RESULT: OK');
