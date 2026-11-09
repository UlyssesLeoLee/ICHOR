#!/usr/bin/env node
/**
 * ATS-502 probe -- negative control for audit-scheduling-core.mjs.
 *
 * A green audit is only evidence if the audit CAN go red. This probe mutates
 * the implementation and the workbook in a scratch copy of the tree and
 * asserts that the audit FAILS for each mutation. A mutation that leaves the
 * audit green is a hole in the audit and is reported as such.
 *
 * The tree is never modified in place: every mutation is applied to a
 * temporary copy, and the audit is run against that copy.
 *
 * Usage: node tools/ats502-probes/mutation-tests.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readMember, readZip, replaceMember } from './lib/xlsx-zip.mjs';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..');
const AUDIT_REL = path.join('tools', 'ats502-probes', 'audit-scheduling-core.mjs');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
}

/**
 * Copy the files the audit reads into a scratch tree and run the audit there.
 *
 * @param {object} [mutate]  { queue, scheduler, wbs } substitutions
 * @returns {{code: number, stdout: string}}
 */
function runAudit(mutate = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ats502-mut-'));
  try {
    for (const d of ['tools/ats502-probes/lib', 'server', 'docs']) {
      fs.mkdirSync(path.join(scratch, d), { recursive: true });
    }
    for (const f of [
      'tools/ats502-probes/audit-scheduling-core.mjs',
      'tools/ats502-probes/lib/xlsx-zip.mjs',
      'server/queue.mjs',
      'server/scheduler.mjs',
    ]) {
      fs.copyFileSync(path.join(REPO_ROOT, f), path.join(scratch, f));
    }
    fs.copyFileSync(path.join(REPO_ROOT, 'docs', '19-REMOTE-RUNNER-PROTOCOL.md'),
      path.join(scratch, 'docs', '19-REMOTE-RUNNER-PROTOCOL.md'));

    const wbsPath = path.join(scratch, 'docs', 'WBS.xlsx');
    const wbsBuf = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'WBS.xlsx'));
    if (mutate.wbs) {
      fs.writeFileSync(wbsPath, replaceMember(
        wbsBuf,
        'xl/worksheets/sheet2.xml',
        mutate.wbs.from,
        mutate.wbs.to,
      ));
    } else {
      fs.writeFileSync(wbsPath, wbsBuf);
    }

    for (const [file, change] of [['queue', mutate.queue], ['scheduler', mutate.scheduler]]) {
      if (!change) continue;
      const p = path.join(scratch, 'server', `${file}.mjs`);
      // The line endings are normalised before the substitution: git's
      // autocrlf filter makes the working tree CRLF on Windows while the
      // committed blob is LF, so a literal that spans a line break would
      // match in one checkout and not in the next. The mutation is about the
      // SOURCE TEXT, not about how the file happens to be terminated.
      const src = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
      const from = change.from.replace(/\r\n/g, '\n');
      const to = change.to.replace(/\r\n/g, '\n');
      if (!src.includes(from)) throw new Error(`mutation target not found in ${file}.mjs: ${change.from}`);
      fs.writeFileSync(p, src.replace(from, to), 'utf8');
    }

    const r = spawnSync(process.execPath, [path.join(scratch, AUDIT_REL)],
      { encoding: 'utf8', cwd: scratch });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Build a WBS mutation that changes the ATS-502 completion rate cell.
 *
 * The cell's current value depends on the row's status, so the substitution
 * is derived from the workbook that is actually on disk. The cell is located
 * by its ROW (the ATS-502 row, found through the ATS-502 id in the same
 * sheet) rather than by a hardcoded row number.
 */
function wbsRateMutation(newRate) {
  const buf = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'WBS.xlsx'));
  const sheet = readZip(buf).find((m) => m.name === 'xl/worksheets/sheet2.xml');
  const xml = readMember(buf, sheet);
  const rowMatch = /<x:row[^>]*r="(\d+)"[^>]*>(?:(?!<x:row).)*?<x:v>ATS-502<\/x:v>/s.exec(xml);
  if (!rowMatch) throw new Error('the ATS-502 row was not found in sheet2.xml');
  const rid = rowMatch[1];
  const cellMatch = new RegExp(`<x:c r="O${rid}"[^>]*>.*?</x:c>`, 's').exec(xml);
  if (!cellMatch) throw new Error(`the O${rid} cell was not found in sheet2.xml`);
  const from = cellMatch[0];
  const to = from.replace(/<x:v>[^<]*<\/x:v>/, `<x:v>${newRate}</x:v>`);
  if (from === to) throw new Error('the completion-rate cell could not be rewritten');
  return { from, to };
}

/* --- the unmutated tree must be green --------------------------------- */

const baseline = runAudit();
record('the unmutated tree passes the audit', baseline.code === 0, `exit ${baseline.code}`);

/* --- each mutation must turn the audit red ---------------------------- */

/**
 * The source fragments the new mutations rewrite.
 *
 * They are spelled out as constants rather than inline literals so that the
 * multi-line fragments are readable and a reader can see exactly which text
 * the mutation replaces. The line endings are normalised by the mutation
 * runner before the substitution (git's autocrlf makes the working tree CRLF
 * on Windows while the committed blob is LF).
 */
const SWEEP_RUNNING_BRANCH = [
  "if ((job.state === 'leased' || job.state === 'running') && this._leaseExpired(job)) {",
  '        const before = job.state;',
].join('\n');
const SWEEP_RUNNING_BRANCH_LEASED_ONLY = [
  "if (job.state === 'leased' && this._leaseExpired(job)) {",
  '        const before = job.state;',
].join('\n');
const DEADLINE_BRANCH = [
  "if (job.deadlineMs !== null && this.now() > job.deadlineMs) {",
  "        this._finish(job, 'interrupted', { reason: `deadline exceeded while ${job.state}` });",
].join('\n');
const DEADLINE_BRANCH_QUEUED_ONLY = [
  "if (job.deadlineMs !== null && this.now() > job.deadlineMs && job.state === 'queued') {",
  "        this._finish(job, 'interrupted', { reason: `deadline exceeded while ${job.state}` });",
].join('\n');
const ACK_FENCE_LINE = [
  '    this._assertLeaseHolder(job, nodeId, leaseId);',
  '    // 租约过期后到达的 ack 必须被拒',
].join('\n');
const ACK_FENCE_REMOVED = '    // 租约过期后到达的 ack 必须被拒';
const RESULT_FENCE_LINE = [
  '    this._assertLeaseHolder(job, nodeId, leaseId);',
  "    if (job.deadlineMs !== null && this.now() > job.deadlineMs) {",
  "      this._finish(job, 'interrupted', { reason: 'result after deadline' });",
].join('\n');
const RESULT_FENCE_REMOVED = [
  "    if (job.deadlineMs !== null && this.now() > job.deadlineMs) {",
  "      this._finish(job, 'interrupted', { reason: 'result after deadline' });",
].join('\n');
const REPLAY_FAILURE_BLOCK = [
  '    if (rec.error) {',
  '      throw new QueueError(rec.error.code, rec.error.message, rec.error.details || {});',
  '    }',
].join('\n');
const REPLAY_FAILURE_SWALLOWED = [
  '    if (rec.error) {',
  '      return rec;',
  '    }',
].join('\n');
const READ_TENANT_LINE = [
  'const tenantId = tenantOfRequest(req, url);',
  '        const jobs = queue.list({',
].join('\n');
const READ_TENANT_UNTRUSTED = [
  "const tenantId = url.searchParams.get('tenantId') || undefined;",
  '        const jobs = queue.list({',
].join('\n');
const DISPATCH_CP_BLOCK = [
  '        checkControlPlaneToken(req, controlPlaneToken);',
  '        const b = await readBody(req);',
  '        const { job, replayed } = queue.dispatch(b);',
].join('\n');
const DISPATCH_CP_REMOVED = [
  '        const b = await readBody(req);',
  '        const { job, replayed } = queue.dispatch(b);',
].join('\n');

const mutations = [
  {
    name: 'a changed HTTP status of a frozen rejection code is caught',
    mutate: { queue: { from: 'REMOTE_JOB_NOT_LEASABLE: { http: 409', to: 'REMOTE_JOB_NOT_LEASABLE: { http: 400' } },
  },
  {
    name: 'an invented rejection code is caught',
    mutate: { queue: { from: '  REMOTE_INTERNAL: { http: 500, retryable: true },', to: '  REMOTE_INTERNAL: { http: 500, retryable: true },\n  REMOTE_MADE_UP: { http: 400, retryable: false },' } },
  },
  {
    name: 'a removed rejection code is caught',
    mutate: { queue: { from: '  REMOTE_RATE_LIMITED: { http: 429, retryable: true },\n', to: '' } },
  },
  {
    name: 'an undeclared REMOTE_ token is caught',
    mutate: { queue: { from: "throw new QueueError('REMOTE_POLICY_REJECTED', 'idempotencyKey is required for dispatch')", to: "throw new QueueError('REMOTE_POLICY_REJECTED_V2', 'idempotencyKey is required for dispatch')" } },
  },
  {
    name: 'a dropped idempotency-key check is caught',
    mutate: { queue: { from: "throw new QueueError('REMOTE_POLICY_REJECTED', 'idempotencyKey is required for ack');", to: "// mutated: the idempotency-key check is removed" } },
  },
  {
    name: 'a lease state that is not in the protocol is caught',
    mutate: { queue: { from: "  'leased',", to: "  'leased',\n  'zzz_state'," } },
  },
  {
    name: 'a scheduler that imports the local Bridge is caught (HB-1)',
    mutate: { scheduler: { from: "import { JobQueue, QueueError, REJECTION_CODES, JOB_STATES } from './queue.mjs';", to: "import { JobQueue, QueueError, REJECTION_CODES, JOB_STATES } from './queue.mjs';\nimport './index.mjs';" } },
  },
  {
    name: 'a scheduler that reads a filesystem is caught (HB-7)',
    mutate: { scheduler: { from: 'export function defaultQueueFile() {', to: 'export function peekPath(p) { return fs.readFileSync(p); }\nexport function defaultQueueFile() {' } },
  },
  {
    // The invariants the review round 1 found missing. Each mutation removes
    // exactly one of them; the audit has to go red.
    name: 'a sweep that ignores the RUNNING state is caught',
    // The target includes the FOLLOWING line: the same condition also occurs
    // in `lease()`, and a mutation that patched the wrong occurrence would
    // leave the audit green for the wrong reason.
    mutate: { queue: { from: SWEEP_RUNNING_BRANCH, to: SWEEP_RUNNING_BRANCH_LEASED_ONLY } },
  },
  {
    name: 'a releaseNode that ignores the RUNNING state is caught',
    mutate: { queue: { from: "if (job.state !== 'leased' && job.state !== 'running') continue;", to: "if (job.state !== 'leased') continue;" } },
  },
  {
    name: 'a sweep that interrupts only QUEUED jobs is caught',
    mutate: { queue: { from: DEADLINE_BRANCH, to: DEADLINE_BRANCH_QUEUED_ONLY } },
  },
  {
    name: 'an ack without a leaseId check is caught',
    mutate: { queue: { from: ACK_FENCE_LINE, to: ACK_FENCE_REMOVED } },
  },
  {
    name: 'a result without a leaseId check is caught',
    mutate: { queue: { from: RESULT_FENCE_LINE, to: RESULT_FENCE_REMOVED } },
  },
  {
    name: 'an unbounded client-chosen lease duration is caught',
    mutate: { queue: { from: "const duration = this._clampLeaseMs(Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : this.leaseMs);", to: "const duration = Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : this.leaseMs;" } },
  },
  {
    name: 'a replay that answers a recorded failure with a success is caught',
    mutate: { queue: { from: REPLAY_FAILURE_BLOCK, to: REPLAY_FAILURE_SWALLOWED } },
  },
  {
    name: 'a read path that takes the tenant from the query string is caught',
    mutate: { scheduler: { from: READ_TENANT_LINE, to: READ_TENANT_UNTRUSTED } },
  },
  {
    name: 'a write path without the control-plane credential check is caught',
    mutate: { scheduler: { from: DISPATCH_CP_BLOCK, to: DISPATCH_CP_REMOVED } },
  },
  {
    name: 'a WBS completion rate that contradicts the remaining days is caught',
    // The target cell is derived from the CURRENT workbook, not hardcoded:
    // the cell's value depends on the row's status, so a literal would break
    // as soon as the row moves on (which is exactly what happened once).
    mutate: { wbs: wbsRateMutation(0.5) },
  },
  {
    name: 'a WBS acceptance criterion that was dropped is caught',
    mutate: { wbs: { from: '断连重投不双跑', to: '（已删除的验收标准）' } },
  },
];

for (const m of mutations) {
  let out;
  try {
    out = runAudit(m.mutate);
  } catch (e) {
    record(m.name, false, `mutation could not be applied: ${e.message}`);
    continue;
  }
  record(m.name, out.code !== 0, `exit ${out.code}${out.code === 0 ? ' :: ' + (out.stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 3).join(' | ') : ''}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} mutation expectations met`);
if (failed.length) {
  console.error('\nFAILED:');
  for (const f of failed) console.error(` - ${f.name} (${f.detail})`);
  process.exit(1);
}
console.log('RESULT: OK');
