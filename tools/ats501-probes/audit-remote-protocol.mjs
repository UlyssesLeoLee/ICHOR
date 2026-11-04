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
 *   3. EVERY `REMOTE_*` token that appears ANYWHERE in the document is a
 *      declared rejection code -- a typo in the prose is a protocol defect,
 *      so the whole document is scanned, not just the rejection table;
 *   4. the `REMOTE_` rejection codes do not collide with the local Bridge
 *      error codes -- a shared code would make cross-plane triage ambiguous;
 *   5. docs/WBS.xlsx「开发WBS」ATS-501 carries the frozen acceptance
 *      criteria and a consistent status / completion-rate / remaining-days
 *      triple;
 *   6. the acceptance elements in the WBS row are all covered by a section
 *      of the protocol document;
 *   7. FR-028 / FR-030 are still DESIGNED in docs/02-REQUIREMENTS.md -- a
 *      protocol document must not make a DESIGNED requirement look
 *      implemented;
 *   8. the ADR numbers registered by this task do not collide with the
 *      ADR numbers already registered in docs/16-BASELINE-ADR.md;
 *   9. the document claims nothing is implemented -- the claim matcher is
 *      CJK-aware (a JavaScript `\b` does not fire between a CJK character
 *      and another word character, so `\b(已实现)\b` never matches).
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
const DOC = path.join(REPO_ROOT, 'docs', '19-REMOTE-RUNNER-PROTOCOL.md');
const WBS = path.join(REPO_ROOT, 'docs', 'WBS.xlsx');
const REQS = path.join(REPO_ROOT, 'docs', '02-REQUIREMENTS.md');
const BASELINE = path.join(REPO_ROOT, 'docs', '16-BASELINE-ADR.md');

const failures = [];
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
}

/**
 * Split the document into sentences on the CJK full stop and the western
 * period, keeping the terminator. Sentence granularity is what makes the
 * negation checks meaningful: "不得称为已实现" negates the claim in that
 * sentence, while a claim three lines later is a different claim.
 *
 * A newline also ends a segment: a markdown table row carries no sentence
 * terminator, so without the line break the whole table would collapse into
 * one enormous "sentence" and every negation test on it would be vacuous.
 */
function splitSentences(text) {
  const out = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    for (const part of line.split(/(?<=[。！？!?])|(?<=\.)(?=\s)/)) {
      const s = part.replace(/\s+/g, ' ').trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * Split a sentence into clauses on the CJK and western clause separators.
 * A clause is the unit the negation tests work on: in
 * "控制平面**不生成、不接收、不存储、不下发私钥**" every clause carries its
 * own negation, while "控制平面生成并下发私钥" carries none.
 */
function splitClauses(sentence) {
  return sentence.split(/[，、；;：:（）()「」【】]/).map((s) => s.trim()).filter(Boolean);
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
  'connection direction is frozen as node-outbound-only',
  contract.protocol.connection.direction === 'node_outbound_only'
    && contract.protocol.connection.controlPlaneInitiatesToNode === false
    && contract.protocol.connection.nodeInboundListener === false,
  JSON.stringify(contract.protocol.connection),
);
check(
  'the node authenticates the control plane by TLS server certificate',
  contract.protocol.connection.nodeAuthenticatesControlPlaneBy === 'tls_server_certificate_validation',
);
check(
  'enrollment token is single use, tenant bound, 900s TTL',
  contract.authentication.enrollmentToken.singleUse === true
    && contract.authentication.enrollmentToken.boundToTenant === true
    && contract.authentication.enrollmentToken.ttlSeconds === 900,
);
check(
  'the private key is generated on the node and never exported',
  contract.authentication.keyGeneration.location === 'node_local'
    && contract.authentication.keyGeneration.privateKeyExport === 'forbidden'
    && contract.authentication.keyGeneration.privateKeyStorage === 'os_keychain',
  JSON.stringify(contract.authentication.keyGeneration),
);
check(
  'the control plane holds only the public key and the key id',
  Array.isArray(contract.authentication.keyGeneration.controlPlaneHolds)
    && contract.authentication.keyGeneration.controlPlaneHolds.length === 2
    && contract.authentication.keyGeneration.controlPlaneHolds.includes('public_key')
    && contract.authentication.keyGeneration.controlPlaneHolds.includes('key_id')
    && !contract.authentication.keyGeneration.controlPlaneHolds.includes('private_key'),
  JSON.stringify(contract.authentication.keyGeneration.controlPlaneHolds),
);
check(
  'enrollment requires a proof of possession',
  contract.authentication.keyGeneration.proofOfPossession
    === 'ed25519_signature_over_enrollment_token_digest',
);
check(
  'credential rotation is node-generated as well',
  contract.authentication.keyGeneration.rotation === 'node_generated_new_keypair',
);
check(
  'request signature covers method/path/query/body/tenant/node/key/timestamp/nonce',
  ['method', 'canonicalPath', 'canonicalQuery', 'bodySha256',
    'tenantId', 'nodeId', 'keyId', 'timestamp', 'nonce']
    .every((f) => contract.authentication.requestSignature.covers.includes(f)),
  JSON.stringify(contract.authentication.requestSignature.covers),
);
check(
  'the signature canonicalisation is named and includes the query string',
  contract.authentication.requestSignature.canonicalization === 'ats-rp-1'
    && contract.authentication.requestSignature.queryIncluded === true,
);
check(
  'replay window (300s) exceeds clock skew (60s)',
  contract.authentication.requestSignature.replayWindowSeconds
    > contract.authentication.requestSignature.clockSkewSeconds,
);
check(
  'the pre-auth failure code is a single code',
  contract.authentication.preAuthFailure.publicCode === 'REMOTE_UNAUTHENTICATED',
);
check(
  'the pre-auth failure reasons are audit-only and never public codes',
  Array.isArray(contract.authentication.preAuthFailure.reasonTaxonomyAuditOnly)
    && contract.authentication.preAuthFailure.reasonTaxonomyAuditOnly.length >= 5
    && contract.authentication.preAuthFailure.reasonTaxonomyAuditOnly
      .every((r) => !r.startsWith('REMOTE_')),
  JSON.stringify(contract.authentication.preAuthFailure.reasonTaxonomyAuditOnly),
);
check(
  'node is bound to exactly one tenant',
  contract.authentication.nodeTenantBinding === 'one_to_one',
);
check(
  'the code acquisition channel is the node-local preseeded source',
  contract.codeAcquisition.channel === 'node_local_preseeded_source',
);
check(
  'the control plane sends only projectUid and gitSha as code references',
  contract.codeAcquisition.controlPlaneSends.length === 2
    && contract.codeAcquisition.controlPlaneSends.includes('projectUid')
    && contract.codeAcquisition.controlPlaneSends.includes('gitSha'),
  JSON.stringify(contract.codeAcquisition.controlPlaneSends),
);
check(
  'the control plane never sends a repository url, a source archive or a private key',
  ['repository_url', 'source_archive', 'node_private_key']
    .every((k) => contract.codeAcquisition.controlPlaneNeverSends.includes(k)),
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
  'cross-tenant access uses the two declared 404 codes',
  Array.isArray(contract.tenantIsolation.crossTenantCodes)
    && contract.tenantIsolation.crossTenantCodes.includes('REMOTE_JOB_NOT_FOUND')
    && contract.tenantIsolation.crossTenantCodes.includes('REMOTE_RESOURCE_NOT_FOUND'),
  JSON.stringify(contract.tenantIsolation.crossTenantCodes),
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
  'an unknown condition is rejected with a policy code',
  contract.rejection.unknownCondition === 'reject_with_policy_code',
);
check(
  'the policy rejection code is declared and is not the internal error code',
  contract.rejection.policyRejectionCode === 'REMOTE_POLICY_REJECTED'
    && contract.rejection.policyRejectionCode !== contract.rejection.internalErrorCode,
);
check(
  'the policy rejection is not retryable and the internal error is',
  contract.rejection.codes.find((c) => c.code === contract.rejection.policyRejectionCode)?.retryable === false
    && contract.rejection.codes.find((c) => c.code === contract.rejection.internalErrorCode)?.retryable === true,
);
check(
  'design status is DESIGNED',
  contract.designStatus === 'DESIGNED',
);
check(
  'idempotency is required for dispatch, cancel, result, ack and keyRotation',
  ['dispatch', 'cancel', 'result', 'ack', 'keyRotation']
    .every((m) => contract.job.idempotencyRequiredFor.includes(m)),
  JSON.stringify(contract.job.idempotencyRequiredFor),
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
    + ' accept a local path as a project reference, generate or distribute the'
    + ' node private key, or distribute source archives',
  ['call_local_desktop_api',
    'read_runner_filesystem_directly',
    'accept_local_path_as_project_ref',
    'generate_or_distribute_node_private_key',
    'distribute_source_archive_or_repository_url']
    .every((c) => contract.boundary.controlPlaneMustNot.includes(c)),
);
check(
  'a private key and a repository url are forbidden message markers',
  contract.boundary.forbiddenInMessages.includes('node_private_key')
    && contract.boundary.forbiddenInMessages.includes('repository_url'),
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
check(
  'the internal error code is a 500 and the policy rejection is a 4xx',
  codes.find((c) => c.code === contract.rejection.internalErrorCode)?.http === 500
    && codes.find((c) => c.code === contract.rejection.policyRejectionCode)?.http < 500,
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

// --- 3b. EVERY REMOTE_ token in the WHOLE document must be a declared code --
// A typo in the prose (e.g. REMOTE_IDEMPOTENCY_CONFILICT) is a protocol
// defect that the table-only comparison above cannot see.
const declaredCodes = new Set(codes.map((c) => c.code));
const allRemoteTokens = [...doc.matchAll(/\bREMOTE_[A-Z_]+\b/g)].map((m) => m[0]);
const undeclaredTokens = [...new Set(allRemoteTokens)].filter((t) => !declaredCodes.has(t));
check(
  'every REMOTE_ token in the whole document is a declared rejection code',
  undeclaredTokens.length === 0,
  undeclaredTokens.join(', '),
);
console.log(`REMOTE_ tokens in the document : ${new Set(allRemoteTokens).size}`);

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

// --- 3b2. the rejection POLICY table agrees with the contract block ------
// §6.1 classifies a rejection into three kinds. The prose table names the
// code for each kind; the contract block names the same codes. If the prose
// routes unknown conditions to REMOTE_INTERNAL while the block says
// REMOTE_POLICY_REJECTED, the protocol says two different things at once.
const policySection = doc.split('### 6.1 默认策略与三类结果')[1]?.split('### 6.2')[0] ?? '';
check('the rejection policy section found in prose', policySection.length > 0);
for (const [label, codeKey] of [
  ['the policy rejection row', 'policyRejectionCode'],
  ['the internal error row', 'internalErrorCode'],
]) {
  const expected = contract.rejection[codeKey];
  const row = policySection.split('\n').find((l) => l.includes(expected));
  check(
    `the prose policy table names ${expected} in ${label}`,
    Boolean(row),
    `expected ${expected} in the §6.1 table`,
  );
  if (row) {
    const http = Number((row.match(/\|\s*(\d{3})\s*\|/) ?? [])[1]);
    const block = codes.find((c) => c.code === expected);
    check(
      `the prose and the block agree on the HTTP status of ${expected}`,
      block && http === block.http,
      `prose=${http} block=${block ? block.http : 'missing'}`,
    );
    // The retryability cell is the LAST column before the client hint: the
    // table is 错误码 | HTTP | 触发条件 | 可重试 | 客户端可见信息 | 归属.
    const cells = row.split('|').map((c) => c.trim());
    const retryCell = cells[5];
    const proseRetryable = retryCell === '是';
    check(
      `the prose and the block agree on the retryability of ${expected}`,
      block && proseRetryable === block.retryable,
      `prose=${proseRetryable} block=${block ? block.retryable : 'missing'}`,
    );
  }
}
// The two codes must be different: a policy rejection that IS the internal
// error would make every unknown condition retryable again.
check(
  'the policy rejection and the internal error are different codes',
  contract.rejection.policyRejectionCode !== contract.rejection.internalErrorCode,
);
const policyCode = codes.find((c) => c.code === contract.rejection.policyRejectionCode);
const internalCode = codes.find((c) => c.code === contract.rejection.internalErrorCode);
check(
  'the policy rejection is a 4xx and not retryable, the internal error is a 500 and retryable',
  policyCode && policyCode.http >= 400 && policyCode.http < 500 && policyCode.retryable === false
    && internalCode && internalCode.http === 500 && internalCode.retryable === true,
);

// --- 3c. the newly frozen topics must have prose, not just a contract key --
// A constraint key with no prose behind it is a contract that no implementer
// can read.
for (const [label, anchor] of [
  ['the connection direction section', '### 2.4 连接方向（冻结）'],
  ['the code acquisition section', '### 7.5 代码获取通道（冻结）'],
  ['the enrollment section', '### 3.2 enrollment（节点入网）'],
  ['the credential rotation section', '### 3.5 凭据轮换'],
  ['the request signature section', '### 3.3 请求签名与防重放'],
  ['the rejection policy section', '### 6.1 默认策略与三类结果'],
]) {
  check(`the prose has ${label}`, doc.includes(anchor), anchor);
}

// The prose must state that the private key is generated on the node.
const enrollmentSection = doc.split('### 3.2 enrollment（节点入网）')[1]?.split('### 3.3')[0] ?? '';
check(
  'the enrollment prose states that the key pair is generated on the node',
  enrollmentSection.includes('在**本地**生成 Ed25519 密钥对')
    || enrollmentSection.includes('在本地生成 Ed25519 密钥对'),
);
check(
  'the enrollment prose states that the control plane never receives the private key',
  enrollmentSection.replace(/\*\*/g, '').includes('控制平面不生成、不接收、不存储、不下发私钥'),
);
check(
  'the rotation prose states that the control plane distributes no private key',
  (doc.split('### 3.5 凭据轮换')[1]?.split('## 4.')[0] ?? '').replace(/\*\*/g, '').includes('不下发任何私钥'),
);

// The prose must not offer a forbidden private-key distribution path. A
// sentence that FORBIDS the distribution is the opposite of offering it, so
// the check works on CLAUSES: the clause that names the actor and the clause
// that names the action must both be free of rejection markers.
//
// A QUOTED span is a MENTION of a term, not an assertion about it: the
// document must be able to name the design it rejects ("这消除了「控制平面
// 生成并下发私钥」这一类设计") without the checker reading that mention as
// an endorsement. Quoted spans are therefore removed before the test.
//
// The check runs over the DESIGN sections only. Section 8 is the threat
// table: a threat row NAMES the attack it mitigates ("控制平面生成并下发
// 节点私钥"), so scanning it would flag the very threats the protocol
// exists to prevent.
const DESIGN_SECTIONS = ['## 3. 认证', '## 5. 租户隔离', '## 7. 作业与消息协议', '## 9. 跨平面数据约束'];
const designText = DESIGN_SECTIONS
  .map((h) => {
    const start = doc.indexOf(h);
    if (start < 0) return '';
    const next = doc.indexOf('\n## ', start + h.length);
    return next < 0 ? doc.slice(start) : doc.slice(start, next);
  })
  .join('\n');

const REJECTION = /不得|禁止|不能|不可|不生成|不接收|不存储|不下发|不|未|非|消除|避免|防止|而不是|而非/;
function stripQuoted(sentence) {
  return sentence.replace(/[「」“”"'][^「」“”"']*[「」“”"']/g, '');
}
function offendingClauses(pattern, { stripQuotedSpans = true } = {}) {
  const out = [];
  for (const rawSentence of splitSentences(designText)) {
    const sentence = stripQuotedSpans ? stripQuoted(rawSentence) : rawSentence;
    for (const clause of splitClauses(sentence)) {
      if (!pattern.test(clause)) continue;
      // The clause must be free of rejection markers, and so must the
      // sentence it lives in: "禁止按失败原因区分响应码或响应体，包括「该
      // 节点存在但凭据错误」这类提示" forbids exactly what the clause names.
      if (REJECTION.test(clause) || REJECTION.test(sentence)) continue;
      out.push(clause);
    }
  }
  return out;
}
const distributing = offendingClauses(/控制平面[^。]{0,20}(返回|下发|分发|派发)[^。]{0,8}私钥|生成节点身份对/);
check(
  'the document never says the control plane returns a node private key',
  distributing.length === 0,
  distributing.join(' | '),
);
const generating = offendingClauses(/控制平面[^。]{0,20}生成[^。]{0,6}节点[^。]{0,4}(身份对|密钥对)/);
check(
  'the document never says the control plane generates the node key pair',
  generating.length === 0,
  generating.join(' | '),
);

// The pre-auth existence-leak sentence must be gone, and the collapsed code
// must be stated. The phrase itself may appear inside the prohibition that
// bans it, so the check is on UNNEGATED clauses.
// The quoted span is NOT stripped here: an existence leak that the
// document describes inside quotes is still a leak the protocol permits.
const leaking = offendingClauses(/该节点存在但凭据错误/, { stripQuotedSpans: false });
check(
  'the document does not leak node existence ("该节点存在但凭据错误")',
  leaking.length === 0,
  leaking.join(' | '),
);
check(
  'the document states that pre-auth failures collapse to one public code',
  doc.includes('REMOTE_UNAUTHENTICATED')
    && /认证尚未确立时[^\n]*全部失败[^\n]*一律返回同一个码/.test(doc),
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
    const commentLen = buf.readUInt32LE(off + 32);
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
// The probe must NOT hardcode the expected status: the row may legitimately
// be 进行中 (rework in progress), 待审核 (submitted) or 已完成 once the
// review has passed. What the probe asserts is that the status is a real
// status for this workflow.
check(
  'ATS-501 status is 待审核 or 进行中 or 已完成',
  ['待审核', '进行中', '已完成'].includes(g('N')),
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

// The WBS note must point at the document under its CURRENT name.
const statusNote = (g('T') || '');
check(
  'the ATS-501 note points at the current protocol document name',
  /docs\/19-REMOTE-RUNNER-PROTOCOL\.md/.test(statusNote),
  statusNote.slice(0, 160),
);
check(
  'the ATS-501 note does not point at the old document name',
  !statusNote.includes('docs/18-REMOTE-RUNNER-PROTOCOL.md'),
);

// --- 7. the document must not claim the remote plane is implemented -------
// The claim matcher must be CJK-aware. In JavaScript `\b` is a word
// boundary between a `\w` character and a non-`\w` character, and CJK
// ideographs ARE `\w`, so `\b(已实现)\b` never matches inside
// "远程执行面已实现。": the boundary only exists at the START of the run
// and AFTER the last character. A lookaround on the non-word side is the
// correct construct here.
const CLAIM_WORDS = ['已实现', '已上线', '已交付', 'IMPLEMENTED', 'SHIPPED', '已可用'];
// A claim is only a claim when the SENTENCE does not negate it. Sentence
// granularity matters: "不得把本协议的能力称为已实现" negates the claim in
// that sentence only.
const NEGATION = /不得|未|尚未|不把|不是|不能|没有|无实现|不存在|不等于|禁[止]/;
function findClaims(text) {
  const found = [];
  for (const sentence of splitSentences(text)) {
    if (NEGATION.test(sentence)) continue;
    for (const word of CLAIM_WORDS) {
      let idx = sentence.indexOf(word);
      while (idx >= 0) {
        found.push(`${word} :: ${sentence.slice(0, 140)}`);
        idx = sentence.indexOf(word, idx + word.length);
      }
    }
  }
  return found;
}
const implementedClaims = findClaims(doc);
check(
  'the document contains no unqualified claim that the remote plane is implemented',
  implementedClaims.length === 0,
  implementedClaims.join(' | '),
);
check(
  'the document declares its own design status',
  doc.includes('DESIGNED') && doc.includes('本文件冻结的是协议，不是实现'),
);

// The matcher itself must be proven to work: a positive control proves the
// matcher is not vacuous.
const controlClaims = findClaims('远程执行面已实现，控制平面已上线。');
check(
  'the implemented-claim matcher is not vacuous (positive control fires)',
  controlClaims.length === 2,
  `control matched: ${controlClaims.join(', ')}`,
);
// A negative control proves the matcher does not fire on the prohibition.
const negatedClaims = findClaims('不得把本协议的能力称为已实现。');
check(
  'the implemented-claim matcher ignores a negated claim (negative control)',
  negatedClaims.length === 0,
  negatedClaims.join(' | '),
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
