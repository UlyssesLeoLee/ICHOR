#!/usr/bin/env node
/**
 * ATS-501 probe -- negative fixtures for the remote protocol contract audit.
 *
 * A green audit only means something if the checks can go RED. This harness
 * mutates the protocol document and the workbook, then asserts that the
 * audit FAILS for each mutation. A mutation that still passes is a hole in
 * the audit, and the harness reports it as a failure.
 *
 * Every mutation is applied to a TEMPORARY COPY of the tree; the repository
 * working tree is never modified.
 *
 * Usage: node tools/ats501-probes/mutation-tests.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..');
const AUDIT = path.join(PROBE_DIR, 'audit-remote-protocol.mjs');
const DOC_REL = path.join('docs', '19-REMOTE-RUNNER-PROTOCOL.md');

console.log('=== ATS-501 probe: protocol audit mutation tests ===');
console.log(`repo root : ${REPO_ROOT}`);
console.log('');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}

/**
 * Copy the minimal set of files the audit reads into a scratch directory and
 * run the audit there. The audit resolves its paths from its own location, so
 * a copy of the script plus the documents is enough.
 */
function runAuditOn(docText, workbookBytes) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats501-mut-'));
  try {
    const tmpProbe = path.join(tmp, 'tools', 'ats501-probes');
    fs.mkdirSync(tmpProbe, { recursive: true });
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'server'), { recursive: true });

    fs.copyFileSync(AUDIT, path.join(tmpProbe, 'audit-remote-protocol.mjs'));
    for (const f of ['core.mjs', 'index.mjs']) {
      const src = path.join(REPO_ROOT, 'server', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, 'server', f));
    }
    for (const f of ['02-REQUIREMENTS.md', '16-BASELINE-ADR.md']) {
      fs.copyFileSync(path.join(REPO_ROOT, 'docs', f), path.join(tmp, 'docs', f));
    }
    fs.writeFileSync(path.join(tmp, DOC_REL), docText, 'utf8');
    if (workbookBytes) {
      fs.writeFileSync(path.join(tmp, 'docs', 'WBS.xlsx'), workbookBytes);
    } else {
      fs.copyFileSync(path.join(REPO_ROOT, 'docs', 'WBS.xlsx'), path.join(tmp, 'docs', 'WBS.xlsx'));
    }

    const res = spawnSync(process.execPath, [path.join(tmpProbe, 'audit-remote-protocol.mjs')], {
      encoding: 'utf8',
    });
    return {
      exitCode: res.status,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const originalDoc = fs.readFileSync(path.join(REPO_ROOT, DOC_REL), 'utf8');

/**
 * Rewrite the workbook's zip members in memory. The mutation has to happen
 * on the XML, not on the raw bytes: the cell values are shared strings, so a
 * byte-level patch would shift the shared-string index and corrupt every
 * other cell in the sheet -- which would make the mutation test pass for
 * the wrong reason.
 */
function mutateWorkbook(mutate) {
  const wb = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'WBS.xlsx'));
  const parts = new Map();
  const zin = (function () {
    // Node has no built-in zip reader, so the archive is walked by hand.
    const buf = wb;
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip container');
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
      const text = method === 0
        ? raw.toString('utf8')
        : zlib.inflateRawSync(raw).toString('utf8');
      parts.set(name, text);
      off += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  })();
  void zin;

  mutate(parts);

  // Rebuild the archive with the same member order.
  const entries = [...parts.entries()];
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocdBuf = Buffer.alloc(22);
  eocdBuf.writeUInt32LE(0x06054b50, 0);
  eocdBuf.writeUInt16LE(0, 4);
  eocdBuf.writeUInt16LE(0, 6);
  eocdBuf.writeUInt16LE(entries.length, 8);
  eocdBuf.writeUInt16LE(entries.length, 10);
  eocdBuf.writeUInt32LE(centralBuf.length, 12);
  eocdBuf.writeUInt32LE(offset, 16);
  eocdBuf.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocdBuf]);
}

/** CRC-32 (IEEE), for the zip entries. */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// --- control: the unmutated document must pass ---------------------------
const control = runAuditOn(originalDoc, null);
record(
  'control: the unmutated document passes the audit',
  control.exitCode === 0 && control.stdout.includes('RESULT: OK'),
  `exit=${control.exitCode}`,
);

// --- M1: the typo that the table-only comparison used to miss -----------
{
  const mutated = originalDoc.replace(
    '`REMOTE_IDEMPOTENCY_CONFLICT` 只在"同键不同体"时出现',
    '`REMOTE_IDEMPOTENCY_CONFILICT` 只在"同键不同体"时出现',
  );
  const res = runAuditOn(mutated, null);
  record(
    'M1: a REMOTE_ typo in the prose fails the audit',
    res.exitCode !== 0 && res.stdout.includes('REMOTE_IDEMPOTENCY_CONFILICT'),
    `exit=${res.exitCode}`,
  );
}

// --- M1b: an undeclared code in a different section fails too -------------
{
  const mutated = originalDoc.replace(
    '### 3.4 认证失败与信息最小化',
    '### 3.4 认证失败与信息最小化\n\n若节点尚未入网，返回 `REMOTE_AUTH_BOGUS`。',
  );
  const res = runAuditOn(mutated, null);
  record(
    'M1b: an undeclared REMOTE_ code outside the code table fails the audit',
    res.exitCode !== 0 && res.stdout.includes('REMOTE_AUTH_BOGUS'),
    `exit=${res.exitCode}`,
  );
}

// --- M2: an unqualified "implemented" claim fails the audit --------------
{
  const mutated = originalDoc.replace(
    '## 9. 跨平面数据约束',
    '远程执行面已实现，控制平面已上线。\n\n## 9. 跨平面数据约束',
  );
  const res = runAuditOn(mutated, null);
  record(
    'M2: an unqualified 「已实现/已上线」 claim fails the audit',
    res.exitCode !== 0 && res.stdout.includes('unqualified claim'),
    `exit=${res.exitCode}`,
  );
}

// --- M3: the control-plane-private-key design fails the audit ------------
{
  const mutated = originalDoc.replace(
    '2. 节点在**本地**生成 Ed25519 密钥对：私钥写入 OS 密钥库（ATS-213），生成 `keyId`；**私钥不出节点**。',
    '2. 控制平面生成节点身份对并返回**私钥**（一次，仅此一次）。',
  );
  const res = runAuditOn(mutated, null);
  record(
    'M3: a control-plane-distributed private key fails the audit',
    res.exitCode !== 0,
    `exit=${res.exitCode}`,
  );
}

// --- M4: the node-existence leak fails the audit -------------------------
{
  const mutated = originalDoc.replace(
    '**禁止按失败原因区分响应码或响应体**，包括"该节点存在但凭据错误"这类存在性提示：未认证的调用方据此可枚举 `nodeId`。',
    '可以按失败原因区分响应码，例如"该节点存在但凭据错误"。',
  );
  const res = runAuditOn(mutated, null);
  record(
    'M4: the node-existence leak fails the audit',
    res.exitCode !== 0 && res.stdout.includes('node existence'),
    `exit=${res.exitCode}`,
  );
}

// --- M5: an unknown condition falling back to REMOTE_INTERNAL fails -------
{
  const mutated = originalDoc.replace(
    '| **未列举条件的策略拒绝** | 请求不满足任何已列举的放行条件 | `REMOTE_POLICY_REJECTED` | 403 | 否 |',
    '| **未列举条件的策略拒绝** | 请求不满足任何已列举的放行条件 | `REMOTE_INTERNAL` | 500 | 是 |',
  );
  const res = runAuditOn(mutated, null);
  record(
    'M5: routing unknown conditions to REMOTE_INTERNAL fails the audit',
    res.exitCode !== 0,
    `exit=${res.exitCode}`,
  );
}

// --- M6: removing the code acquisition section fails the audit ------------
{
  const mutated = originalDoc.replace('### 7.5 代码获取通道（冻结）', '### 7.5 其它');
  const res = runAuditOn(mutated, null);
  record(
    'M6: removing the code acquisition section fails the audit',
    res.exitCode !== 0 && res.stdout.includes('code acquisition'),
    `exit=${res.exitCode}`,
  );
}

// --- M7: flipping the connection direction fails the audit ---------------
{
  const mutated = originalDoc.replace(
    '"direction": "node_outbound_only",',
    '"direction": "control_plane_pulls",',
  );
  const res = runAuditOn(mutated, null);
  record(
    'M7: flipping the connection direction fails the audit',
    res.exitCode !== 0 && res.stdout.includes('connection direction'),
    `exit=${res.exitCode}`,
  );
}

// --- M8: a workbook without the ATS-501 row fails the audit ---------------
{
  // The cell values are INLINE strings (t="str"), so the mutation happens in
  // xl/worksheets/sheet2.xml. Patching the raw zip bytes would corrupt the
  // archive and make the test pass for the wrong reason.
  const mutated = mutateWorkbook((parts) => {
    const sheet = parts.get('xl/worksheets/sheet2.xml');
    if (sheet === undefined) throw new Error('sheet2.xml not found');
    const patched = sheet.replace('<x:v>ATS-501</x:v>', '<x:v>ATS-999</x:v>');
    if (patched === sheet) throw new Error('ATS-501 not found in sheet2.xml');
    parts.set('xl/worksheets/sheet2.xml', patched);
  });
  const res = runAuditOn(originalDoc, mutated);
  // The audit exits early when the row is missing, so the early-exit
  // message is what appears in the output.
  record(
    'M8: a workbook without the ATS-501 row fails the audit',
    res.exitCode !== 0
      && (res.stdout.includes('ATS-501 row is missing')
        || res.stdout.includes('ATS-501 row found')),
    `exit=${res.exitCode}`,
  );
}

// --- M9: a WBS status outside the allowed set fails the audit -------------
{
  // The status cell is an inline string too: put a value into the ATS-501
  // row's N cell that is NOT in the workbook's data-validation list.
  const mutated = mutateWorkbook((parts) => {
    const sheet = parts.get('xl/worksheets/sheet2.xml');
    if (sheet === undefined) throw new Error('sheet2.xml not found');
    // Locate the ATS-501 row, then replace the N cell inside it.
    const rowMatch = /<x:row[^>]*r="(\d+)"[^>]*>(?:(?!<x:row).)*?<x:v>ATS-501<\/x:v>(?:(?!<x:row).)*?<\/x:row>/s.exec(sheet);
    if (!rowMatch) throw new Error('ATS-501 row not found in sheet2.xml');
    const row = rowMatch[0];
    const patchedRow = row.replace(
      /(<x:c r="N\d+"[^>]*>)(?:<x:f>.*?<\/x:f>)?(?:<x:v>.*?<\/x:v>)?(.*?<\/x:c>)/s,
      '$1<x:v>乱写的状态</x:v>$2',
    );
    if (patchedRow === row) throw new Error('the N cell of the ATS-501 row not found');
    parts.set('xl/worksheets/sheet2.xml', sheet.replace(row, patchedRow));
  });
  const res = runAuditOn(originalDoc, mutated);
  record(
    'M9: a WBS status outside the allowed set fails the audit',
    res.exitCode !== 0 && res.stdout.includes('allowed values'),
    `exit=${res.exitCode}`,
  );
}

// --- verdict ---------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`mutations passed : ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('');
  console.log('RESULT: MISMATCH -- some mutations did not turn the audit red.');
  process.exitCode = 1;
} else {
  console.log('');
  console.log('RESULT: OK -- every mutation turned the audit red, so the audit is not vacuous.');
}
