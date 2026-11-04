#!/usr/bin/env node
/**
 * ATS-501 probe -- remote protocol contract audit.
 *
 * The remote protocol is frozen as a DOCUMENT, not as code: the remote
 * execution plane does not exist in this repository. What can be verified
 * mechanically is therefore the protocol's own internal consistency and its
 * consistency with the other baseline documents.
 *
 * This probe checks:
 *   1. the machine-readable constraint block exists, is valid JSON, and
 *      satisfies its own invariants;
 *   2. the constraint block and the prose tables agree in BOTH directions
 *      (every prose row is in the block, every block entry is in the prose);
 *   3. the `REMOTE_` rejection codes do not collide with the local Bridge
 *      error codes -- a shared code would make cross-plane triage ambiguous;
 *   4. docs/WBS.xlsx「开发WBS」ATS-501 carries the frozen acceptance
 *      criteria and a consistent status / completion-rate / remaining-days
 *      triple;
 *   5. the acceptance elements in the WBS row are all covered by a section
 *      of the protocol document;
 *   6. FR-028 / FR-030 are still DESIGNED in docs/02-REQUIREMENTS.md --
 *      a protocol document must not make a DESIGNED requirement look
 *      implemented;
 *   7. the ADR numbers registered by this task do not collide with the
 *      ADR numbers already registered in docs/16-BASELINE-ADR.md.
 *
 * What this probe does NOT do: it does not verify any runtime behaviour of
 * the remote protocol. No remote runtime exists to verify.
 *
 * Usage: node tools/ats501-probes/audit-remote-protocol.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
// PROBE_DIR = <repo>/tools/ats501-probes  ->  two levels up is the repo root
const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..');
const DOC = path.join(REPO_ROOT, 'docs', '18-REMOTE-RUNNER-PROTOCOL.md');
const WBS = path.join(REPO_ROOT, 'docs', 'WBS.xlsx');
const REQS = path.join(REPO_ROOT, 'docs', '02-REQUIREMENTS.md');
const BASELINE = path.join(REPO_ROOT, 'docs', '16-BASELINE-ADR.md');

const failures = [];
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
}

console.log('=== ATS-501 probe: remote protocol contract audit ===');
console.log(`repo root : ${REPO_ROOT}`);
console.log(`document  : ${path.relative(REPO_ROOT, DOC)}`);
console.log('');

const doc = fs.readFileSync(DOC, 'utf8');

// --- 1. the machine-readable constraint block ------------------------------
const MARKER = '<!-- ats501-constraints -->';
const markerAt = doc.indexOf(MARKER);
check('constraint marker present', markerAt >= 0);
if (markerAt < 0) {
  console.log('RESULT: MISMATCH -- the constraint block marker is missing.');
  process.exit(1);
}
const afterMarker = doc.slice(markerAt + MARKER.length);
const fenceStart = afterMarker.indexOf('```json');
check('constraint block fenced as json', fenceStart >= 0);
const fenceBody = afterMarker.slice(fenceStart + '```json'.length);
const fenceEnd = fenceBody.indexOf('```');
const blockText = fenceBody.slice(0, fenceEnd);

let contract = null;
try {
  contract = JSON.parse(blockText);
  check('constraint block parses as JSON', true);
} catch (e) {
  check('constraint block parses as JSON', false, e.message);
}
if (!contract) {
  console.log('RESULT: MISMATCH -- the constraint block is not valid JSON.');
  process.exit(1);
}

// --- 2. invariants of the constraint block ---------------------------------
check(
  'protocol version is major 1 / minMinor 0',
  contract.protocol.version.major === 1 && contract.protocol.version.minMinor === 0,
  `got major=${contract.protocol.version.major} minMinor=${contract.protocol.version.minMinor}`,
);
check(
  'protocol negotiation is capability_by_name',
  contract.protocol.version.negotiation === 'capability_by_name',
);
check(
  'transport requires TLS 1.3 and forbids cleartext',
  contract.protocol.transport.tls === '1.3' && contract.protocol.transport.cleartextAllowed === false,
);
check(
  'enrollment token is single use, tenant bound, 900s TTL',
  contract.authentication.enrollmentToken.singleUse === true
    && contract.authentication.enrollmentToken.boundToTenant === true
    && contract.authentication.enrollmentToken.ttlSeconds === 900,
);
check(
  'request signature covers method/path/body/timestamp/nonce',
  ['method', 'path', 'bodySha256', 'timestamp', 'nonce']
    .every((f) => contract.authentication.requestSignature.covers.includes(f)),
);
check(
  'replay window (300s) exceeds clock skew (60s)',
  contract.authentication.requestSignature.replayWindowSeconds
    > contract.authentication.requestSignature.clockSkewSeconds,
);
check(
  'node is bound to exactly one tenant',
  contract.authentication.nodeTenantBinding === 'one_to_one',
);
check(
  'tenant context is server assigned, never client chosen',
  contract.tenantIsolation.tenantSource === 'server_assigned_from_session'
    && contract.tenantIsolation.clientSuppliedTenant === 'must_match_or_reject',
);
check(
  'cross-tenant access answers 404',
  contract.tenantIsolation.crossTenantResponse === 404,
);
check(
  'storage prefix is tenant scoped',
  /^tenant\/\{tenantId\}\//.test(contract.tenantIsolation.storagePrefixTemplate),
  contract.tenantIsolation.storagePrefixTemplate,
);
check(
  'resources are referenced by opaque uid only',
  contract.tenantIsolation.resourceReference === 'opaque_uid_only',
);
check(
  'rejection default policy is deny',
  contract.rejection.defaultPolicy === 'deny',
);
check(
  'unknown conditions are rejected and audited',
  contract.rejection.unknownCondition === 'reject_and_audit',
);
check(
  'design status is DESIGNED',
  contract.designStatus === 'DESIGNED',
);
check(
  'idempotency is required for dispatch, cancel and result',
  ['dispatch', 'cancel', 'result'].every((m) => contract.job.idempotencyRequiredFor.includes(m)),
);
check(
  'idempotency conflict is rejected (not silently accepted)',
  contract.job.idempotencyConflict === 'reject',
);
check(
  'deadline is enforced and a lease is required',
  contract.job.deadlineEnforced === true && contract.job.leaseRequired === true,
);
check(
  'four planes are declared',
  contract.boundary.planes.length === 4,
);
check(
  'control plane may not touch the local desktop API, the runner filesystem,'
    + ' or accept a local path as a project reference',
  ['call_local_desktop_api', 'read_runner_filesystem_directly', 'accept_local_path_as_project_ref']
    .every((c) => contract.boundary.controlPlaneMustNot.includes(c)),
);

// Every rejection code carries the namespace, and codes are unique.
const codes = contract.rejection.codes;
check('rejection code list is non-empty', codes.length > 0);
check(
  'every rejection code uses the REMOTE_ namespace',
  codes.every((c) => c.code.startsWith(contract.rejection.namespace)),
);
check(
  'rejection codes are unique',
  new Set(codes.map((c) => c.code)).size === codes.length,
);
check(
  'every rejection code declares a valid HTTP status',
  codes.every((c) => Number.isInteger(c.http) && c.http >= 400 && c.http < 600),
);
check(
  'every rejection code declares retryability',
  codes.every((c) => typeof c.retryable === 'boolean'),
);
check(
  'retryable codes are never permanent client errors (400/401/403/404/413/422)',
  codes
    .filter((c) => c.retryable)
    .every((c) => ![400, 401, 403, 404, 413, 422].includes(c.http)),
  codes
    .filter((c) => c.retryable && [400, 401, 403, 404, 413, 422].includes(c.http))
    .map((c) => `${c.code}=${c.http}`)
    .join(', '),
);

// --- 3. the constraint block and the prose tables agree in both directions --
// The prose rejection table is the markdown table under "### 6.2 拒绝码表".
const rejectionSection = doc.split('### 6.2 拒绝码表')[1]?.split('### 6.3')[0] ?? '';
check('rejection table section found in prose', rejectionSection.length > 0);
const proseCodes = [...rejectionSection.matchAll(/^\|\s*`(REMOTE_[A-Z_]+)`\s*\|\s*(\d{3})\s*\|\s*([^|]+)\|\s*(是|否)\s*\|/gm)]
  .map((m) => ({ code: m[1], http: Number(m[2]), retryable: m[4] === '是' }));
check(
  'prose rejection table rows parsed',
  proseCodes.length > 0,
  `parsed ${proseCodes.length} rows`,
);
const proseByCode = new Map(proseCodes.map((c) => [c.code, c]));
const blockByCode = new Map(codes.map((c) => [c.code, c]));
const missingInBlock = proseCodes.filter((c) => !blockByCode.has(c.code)).map((c) => c.code);
const missingInProse = codes.filter((c) => !proseByCode.has(c.code)).map((c) => c.code);
check(
  'every prose rejection code is in the constraint block',
  missingInBlock.length === 0,
  missingInBlock.join(', '),
);
check(
  'every constraint-block rejection code is in the prose table',
  missingInProse.length === 0,
  missingInProse.join(', '),
);
const httpMismatch = proseCodes
  .filter((c) => blockByCode.has(c.code) && blockByCode.get(c.code).http !== c.http)
  .map((c) => `${c.code} prose=${c.http} block=${blockByCode.get(c.code).http}`);
check('prose and block agree on HTTP status', httpMismatch.length === 0, httpMismatch.join(', '));
const retryMismatch = proseCodes
  .filter((c) => blockByCode.has(c.code) && blockByCode.get(c.code).retryable !== c.retryable)
  .map((c) => `${c.code} prose=${c.retryable} block=${blockByCode.get(c.code).retryable}`);
check('prose and block agree on retryability', retryMismatch.length === 0, retryMismatch.join(', '));

// The forbidden-message markers must all appear in the prose (section 9) and
// in the boundary rules (section 2.3), and every marker used in the prose
// must be declared in the block.
const dataSection = doc.split('## 9. 跨平面数据约束')[1]?.split('## 10.')[0] ?? '';
check('data-constraint section found in prose', dataSection.length > 0);
const proseMarkers = new Set(
  [...dataSection.matchAll(/`([a-z][a-z0-9_]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]),
);
const declaredMarkers = new Set(contract.boundary.forbiddenInMessages);
const markerUsedNotDeclared = [...proseMarkers].filter((m) => !declaredMarkers.has(m));
check(
  'every marker used in the data-constraint table is declared in the block',
  markerUsedNotDeclared.length === 0,
  markerUsedNotDeclared.join(', '),
);
const markerDeclaredNotUsed = [...declaredMarkers].filter((m) => !proseMarkers.has(m));
check(
  'every marker declared in the block is used in the data-constraint table',
  markerDeclaredNotUsed.length === 0,
  markerDeclaredNotUsed.join(', '),
);

// The hard-boundary rules cite the markers too; each control-plane
// prohibition must be named in the HB table.
const hbSection = doc.split('### 2.3 硬边界规则（HB）')[1]?.split('## 3.')[0] ?? '';
check('hard-boundary section found in prose', hbSection.length > 0);
const hbMissing = contract.boundary.controlPlaneMustNot.filter((c) => !hbSection.includes(c));
check(
  'every control-plane prohibition is named in the hard-boundary table',
  hbMissing.length === 0,
  hbMissing.join(', '),
);

// Untrusted inputs must be named in the trust-level table.
const trustSection = doc.split('### 2.2 信任级别')[1]?.split('### 2.3')[0] ?? '';
check('trust-level section found in prose', trustSection.length > 0);
const untrustedMissing = contract.boundary.untrustedInputs.filter((u) => !trustSection.includes(u));
check(
  'every declared untrusted input is named in the trust-level table',
  untrustedMissing.length === 0,
  untrustedMissing.join(', '),
);

// --- 4. the rejection namespace must not collide with local Bridge codes ---
const localCodes = new Set();
for (const file of ['server/core.mjs', 'server/index.mjs']) {
  const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  for (const m of src.matchAll(/new Error\('([A-Z][A-Z_]+)'\)/g)) localCodes.add(m[1]);
}
const collisions = codes.map((c) => c.code).filter((c) => localCodes.has(c));
check(
  'no REMOTE_ code collides with a local Bridge error code',
  collisions.length === 0,
  collisions.join(', '),
);
console.log(`local Bridge error codes found : ${localCodes.size}`);
console.log(`REMOTE_ codes in the contract  : ${codes.length}`);

// --- 5. cross-checks against the other baseline documents -----------------
const reqs = fs.readFileSync(REQS, 'utf8');
for (const fr of ['FR-028', 'FR-030']) {
  const row = reqs.split('\n').find((l) => l.startsWith(`| ${fr} `));
  check(`${fr} row found in docs/02-REQUIREMENTS.md`, Boolean(row));
  check(
    `${fr} is still DESIGNED (a protocol document must not imply implementation)`,
    Boolean(row) && row.includes('DESIGNED'),
    row ? row.trim() : 'row missing',
  );
}
const reqsBadges = (reqs.match(/\| FR-028 \|[^|]*\|[^|]*\|[^|]*\| DESIGNED \|/) ?? []).length;
check('FR-028 carries an explicit DESIGNED badge', reqsBadges === 1);

// ADR numbering must not collide with the baseline ADR register. Only the
// ADRs REGISTERED by this task count -- a reference to an upstream ADR in
// the basis list is not a registration.
const baseline = fs.readFileSync(BASELINE, 'utf8');
const baselineAdrs = new Set([...baseline.matchAll(/ADR-(\d{3})/g)].map((m) => `ADR-${m[1]}`));
const adrRegister = doc.split('## 11. ADR 决策登记')[1]?.split('## 12.')[0] ?? '';
check('ADR register section found in prose', adrRegister.length > 0);
const docAdrs = new Set([...adrRegister.matchAll(/ADR-(\d{3})/g)].map((m) => `ADR-${m[1]}`));
const adrCollisions = [...docAdrs].filter((a) => baselineAdrs.has(a));
check(
  'ADR numbers registered here do not collide with docs/16-BASELINE-ADR.md',
  adrCollisions.length === 0,
  adrCollisions.join(', '),
);
check('this task registers at least one ADR', docAdrs.size > 0);
console.log(`baseline ADRs : ${baselineAdrs.size}, ADRs registered here : ${docAdrs.size}`);

// --- 6. WBS cross-check ----------------------------------------------------
function inflateZipEntries(buf) {
  const parts = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return parts;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let text;
    try {
      text = (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
    } catch {
      text = raw.toString('latin1');
    }
    parts.push({ name, text });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return parts;
}

const parts = inflateZipEntries(fs.readFileSync(WBS));
const sharedRaw = parts.find((p) => p.name === 'xl/sharedStrings.xml')?.text ?? '';
const shared = [...sharedRaw.matchAll(/<x:si>(.*?)<\/x:si>/gs)].map((m) => m[1].replace(/<[^>]+>/g, ''));
function sheetRows(name) {
  const xml = parts.find((p) => p.name === `xl/worksheets/${name}.xml`)?.text ?? '';
  const rows = new Map();
  for (const rm of xml.matchAll(/<x:row[^>]*r="(\d+)"[^>]*>(.*?)<\/x:row>/gs)) {
    const rid = Number(rm[1]);
    const cells = new Map();
    for (const cm of rm[2].matchAll(/<x:c r="([A-Z]+)\d+"([^>]*)>(.*?)<\/x:c>/gs)) {
      const col = cm[1];
      const attrs = cm[2];
      const body = cm[3];
      const vm = body.match(/<x:v>(.*?)<\/x:v>/s);
      let val = vm ? vm[1] : '';
      if (attrs.includes('t="s"') && val !== '') val = shared[Number(val)] ?? val;
      cells.set(col, { value: val, formula: (body.match(/<x:f>(.*?)<\/x:f>/s) ?? ['', ''])[1] });
    }
    rows.set(rid, cells);
  }
  return rows;
}
const wbsRows = sheetRows('sheet2');
let ats501 = null;
let ats501Row = null;
for (const [rid, cells] of wbsRows) {
  if ((cells.get('A')?.value ?? '') === 'ATS-501') {
    ats501 = cells;
    ats501Row = rid;
    break;
  }
}
check('ATS-501 row found in docs/WBS.xlsx「开发WBS」', Boolean(ats501));
if (!ats501) {
  console.log('RESULT: MISMATCH -- the ATS-501 row is missing from the workbook.');
  process.exit(1);
}
const g = (col) => ats501.get(col)?.value ?? '';
console.log(`ATS-501 row ${ats501Row}: status=${g('N')} completion=${g('O')} remaining=${g('P')}`);
check(
  'ATS-501 status is one of the workbook\'s allowed values',
  ['未开始', '进行中', '待审核', '已阻塞', '已完成', '已取消'].includes(g('N')),
  g('N'),
);
check(
  'ATS-501 status is 待审核 (frozen and submitted, not yet accepted)',
  g('N') === '待审核',
  g('N'),
);
const completion = Number(g('O'));
const remaining = Number(g('P'));
const estimate = Number(g('K'));
check(
  'ATS-501 completion rate is a number in [0,1]',
  Number.isFinite(completion) && completion >= 0 && completion <= 1,
  g('O'),
);
check(
  'ATS-501 remaining days equal estimate * (1 - completion)',
  Math.abs(remaining - estimate * (1 - completion)) < 1e-9,
  `estimate=${estimate} completion=${completion} remaining=${remaining}`,
);
check(
  'ATS-501 acceptance criteria are the frozen five elements',
  g('G') === '定义服务端信任边界、认证、版本握手、租户隔离及拒绝规则',
  g('G'),
);
const elements = ['信任边界', '认证', '版本握手', '租户隔离', '拒绝规则'];
const elementMissing = elements.filter((e) => !doc.includes(e));
check(
  'every acceptance element named in the WBS row appears in the protocol document',
  elementMissing.length === 0,
  elementMissing.join(', '),
);
// The five acceptance elements must map onto the five contract sections.
for (const [element, anchor] of [
  ['信任边界', '## 2. 信任边界'],
  ['认证', '## 3. 认证'],
  ['版本握手', '## 4. 版本握手'],
  ['租户隔离', '## 5. 租户隔离'],
  ['拒绝规则', '## 6. 拒绝规则'],
]) {
  check(`acceptance element 「${element}」 has a dedicated section`, doc.includes(anchor));
}

// --- 7. the document must not claim the remote plane is implemented -------
const implementedClaims = [];
for (const m of doc.matchAll(/^.*\b(已实现|IMPLEMENTED|已上线|已交付)\b.*$/gm)) {
  const line = m[0];
  // A line may legitimately say the opposite ("不得称为已实现", "仍未实现").
  if (/不得|未|不把|不是|不能/.test(line)) continue;
  implementedClaims.push(line.trim().slice(0, 120));
}
check(
  'the document contains no unqualified claim that the remote plane is implemented',
  implementedClaims.length === 0,
  implementedClaims.join(' | '),
);
check(
  'the document declares its own design status',
  doc.includes('DESIGNED') && doc.includes('本文件冻结的是协议，不是实现'),
);

// --- verdict ---------------------------------------------------------------
console.log('');
console.log('--- checks ---');
let passed = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : `  [${c.detail}]`}`);
  if (c.ok) passed++;
}
console.log('');
console.log(`checks passed : ${passed}/${checks.length}`);
console.log(`remote codes  : ${codes.length}`);
console.log(`threats       : ${[...doc.matchAll(/^\| TR-\d{2} \|/gm)].length}`);

if (failures.length) {
  console.log('');
  console.log('--- failures ---');
  for (const f of failures) console.log(`  ${f}`);
  console.log('');
  console.log('RESULT: MISMATCH -- the remote protocol contract is not self-consistent.');
  process.exitCode = 1;
} else {
  console.log('');
  console.log('RESULT: OK -- the remote protocol contract is self-consistent and agrees'
    + ' with the WBS row, the requirement badges and the baseline ADR register.');
}
