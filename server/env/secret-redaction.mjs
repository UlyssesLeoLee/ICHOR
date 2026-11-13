/**
 * The length of the longest PREFIX of `text` that may safely be emitted.
 *
 * A secret may be split across two chunks of the child's output, so a
 * redactor that replaced chunk by chunk would miss it: the first chunk ends
 * with the first half of the secret, and neither half looks like a secret
 * on its own. The boundary therefore has to be computed on the COMBINED
 * text, and it has to satisfy two rules at once:
 *
 *   1. **No occurrence may straddle the boundary.** A complete occurrence
 *      that starts before the boundary and ends after it would have its
 *      first half emitted and its second half retained -- the secret would
 *      be split across the emitted text and the tail, and the emitted half
 *      would be a leak. So the boundary moves back to the START of any
 *      straddling occurrence.
 *   2. **No incomplete occurrence may start before the boundary.** An
 *      occurrence that is not complete yet (`SEC` of `SECRET`) may be
 *      completed by the next chunk, so everything from its start is
 *      retained.
 *
 * The boundary is the largest position that satisfies both.
 *
 * @param {string} text the combined text (the retained tail plus the chunk)
 * @param {string[]} needles the secrets to look for
 * @returns {number} the number of characters that may be emitted
 */
export function safePrefixLength(text, needles) {
  const len = text.length;
  if (!len || !needles.length) return len;
  let boundary = len;
  // Rule 2: an incomplete occurrence. Only the last `maxNeedle` characters
  // can start one -- anything earlier would have been completed already.
  const maxNeedle = needles.reduce((n, s) => Math.max(n, s.length), 0);
  for (const needle of needles) {
    const from = Math.max(0, len - needle.length + 1);
    for (let p = from; p < len; p++) {
      if (p >= boundary) break;
      const segment = text.slice(p, p + needle.length);
      if (segment.length < needle.length && needle.startsWith(segment)) {
        boundary = p;
      }
    }
  }
  // Rule 1: a complete occurrence that straddles the boundary. Lowering
  // the boundary can create a new straddle, so this repeats until the
  // boundary stops moving.
  for (let guard = 0; guard < 8; guard++) {
    let moved = false;
    for (const needle of needles) {
      const from = Math.max(0, boundary - needle.length);
      for (let p = from; p < boundary; p++) {
        if (text.startsWith(needle, p) && p + needle.length > boundary) {
          boundary = p;
          moved = true;
          break;
        }
      }
    }
    if (!moved) break;
  }
  return boundary;
}

/**
 * ATS-213 ｜ 密钥脱敏（secret redaction）
 *
 * 运行启动时平台把凭据引用解析成密钥，注入封口的 runner 环境。**解析出来的
 * 密钥只有平台知道**——被测代码不知道，测试作者也不一定知道。
 *
 * 于是问题变成一个**平台自己的**问题：被测脚本的一次**普通断言失败**就会把
 * 注入的密钥原文打印出来，而平台会把这次运行的很多东西写进磁盘：
 *
 *   * 平台捕获的 stdout/stderr（`stdout.log`、`run.log`、事件）；
 *   * 引擎写的文本产物（`report.json`、HTML 报告的 `data/*.md`、
 *     `error-context.md`）；
 *   * HTML 报告**内嵌的 base64 zip**（逐字节扫描看不到，解码后命中）；
 *   * 证据归档（`evidence-store/` 的内容寻址副本）；
 *   * SQLite 镜像（`metadata.db`）与 `state.json`。
 *
 * 这些落盘面都会跟着运行记录走、跟着证据导出走。验收标准说「导出/日志无敏感
 * 串」，而**导出**正是这些文件。因此平台必须在**落盘之前**把密钥替换掉。
 *
 * 三条规则：
 *
 *   1. **掩码是固定的。** 替换成 `***`，而不是「密钥的前 N 个字符」——后者
 *      仍然是密钥的一部分。
 *   2. **脱敏必须跨分块。** stdout 是流：一个密钥完全可能被切成两个 `data`
 *      块，逐块替换会漏掉它。因此脱敏器保留一个**尾巴**，只在确认一段文本
 *      不再可能是密钥的前缀之后才把它放出去（见 `safePrefixLength()`）。
 *   3. **二进制产物是边界。** trace、截图、视频是引擎写的二进制，平台**改写
 *      不了**它们（改写会破坏归档的校验和，破坏 trace 的内部结构）。这些是
 *      **明确写下来的边界**，而不是「没被发现」。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** 固定掩码。脱敏后的文本仍然可读，但不泄露密钥的任何一部分。 */
export const SECRET_MASK = '***';

/**
 * 一次脱敏会话。
 *
 * 它持有这次运行的**全部**密钥（可能不止一条：一条档案可以有多个引用），
 * 并且把它们在**流式**与**整体**两种用法下都替换掉。
 */
export function createRedactor(secrets) {
  const values = [...new Set((secrets ?? [])
    .filter((s) => typeof s === 'string' && s.length > 0)
    .map((s) => s))];
  // A secret is redacted in its RAW form and in its JSON-escaped form: a
  // secret that contains a quote or a backslash is written differently into
  // a JSON report than it appears in the environment block, and a redactor
  // that only knows the raw form would miss the escaped one.
  const needles = [];
  for (const value of values) {
    needles.push(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) needles.push(escaped);
  }
  // A secret of one character would match almost anything, so it is NOT
  // redacted: the platform would destroy the whole log. A credential that
  // short is refused by the credential store's own rules anyway.
  const usable = needles.filter((s) => s.length >= 4);

  /**
   * Redacts a WHOLE text. Used for the files the platform rewrites after
   * the run has ended.
   */
  function redactText(text) {
    if (typeof text !== 'string' || !usable.length) return text;
    let out = text;
    for (const needle of usable) {
      if (!out.includes(needle)) continue;
      out = out.split(needle).join(SECRET_MASK);
    }
    return out;
  }

  /**
   * Redacts a BUFFER. Used for the binary-ish files whose bytes the platform
   * rewrites in place (the embedded zip of the HTML report).
   */
  function redactBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || !usable.length) return buffer;
    let out = buffer;
    for (const needle of usable) {
      const bytes = Buffer.from(needle, 'utf8');
      if (!out.includes(bytes)) continue;
      const parts = [];
      let at = 0;
      for (;;) {
        const found = out.indexOf(bytes, at);
        if (found < 0) break;
        parts.push(out.subarray(at, found));
        parts.push(Buffer.from(SECRET_MASK, 'utf8'));
        at = found + bytes.length;
      }
      parts.push(out.subarray(at));
      out = Buffer.concat(parts);
    }
    return out;
  }

  /**
   * A STREAMING redactor.
   *
   * The child's stdout arrives in chunks, and a secret may be split across
   * two of them. The redactor therefore holds back the text that could still
   * become a secret: the boundary is computed on the COMBINED text (the
   * retained tail plus the chunk) by `safePrefixLength()`, and the redacted
   * form of that text is emitted up to the boundary.
   *
   * The order matters: the boundary is computed on the RAW text (where the
   * secret is still intact), and the redaction is applied to the part that
   * is emitted. Applying the redaction first would shorten the text and make
   * the boundary wrong.
   */
  function createStreamRedactor() {
    let tail = '';
    return {
      /**
       * Feeds a chunk and returns the text that is SAFE to write out.
       */
      push(chunk) {
        const raw = tail + chunk;
        if (!usable.length) {
          tail = '';
          return raw;
        }
        const boundary = safePrefixLength(raw, usable);
        const emit = redactText(raw.slice(0, boundary));
        tail = raw.slice(boundary);
        return emit;
      },
      /**
       * Releases the held-back tail. Called when the stream ends.
       */
      flush() {
        const rest = tail;
        tail = '';
        return redactText(rest);
      },
    };
  }

  return {
    /** True when this session has anything to redact at all. */
    active: usable.length > 0,
    /** The secrets this session knows about (for the diagnostics). */
    count: usable.length,
    redactText,
    redactBuffer,
    createStreamRedactor,
  };
}

/* ------------------------------------------------------------------ */
/* ZIP rewriting                                                        */
/* ------------------------------------------------------------------ */

/**
 * Reads the central directory of a ZIP file.
 *
 * The HTML report embeds its data as a base64 ZIP, and the secret inside it
 * is invisible to a byte scan. The archive therefore has to be opened, its
 * members rewritten and the archive rebuilt.
 *
 * @returns {Array<{name:string,method:number,data:Buffer}>} the members
 */
export function readZipMembers(buffer) {
  const out = [];
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    const method = buffer.readUInt16LE(p + 10);
    const csize = buffer.readUInt32LE(p + 20);
    const nlen = buffer.readUInt16LE(p + 28);
    const xlen = buffer.readUInt16LE(p + 30);
    const clen = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buffer.readUInt16LE(local + 26);
    const lxlen = buffer.readUInt16LE(local + 28);
    const raw = buffer.slice(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    let data;
    try {
      data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    } catch {
      data = Buffer.alloc(0);
    }
    out.push({ name, method, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/**
 * Writes a ZIP file from its members.
 *
 * The entries are DEFLATED, and the local header and the central directory
 * are written by hand because Node has no ZIP writer in its standard
 * library. The result is a valid archive: the HTML report's viewer reads it
 * with the same reader it read the original with.
 *
 * @param {Array<{name:string,method:number,data:Buffer}>} members
 * @returns {Buffer}
 */
export function writeZipMembers(members) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const member of members) {
    const nameBytes = Buffer.from(member.name, 'utf8');
    const raw = member.method === 8
      ? zlib.deflateRawSync(member.data, { level: 9 })
      : member.data;
    const crc = zlib.crc32(member.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 names
    local.writeUInt16LE(member.method, 8);
    local.writeUInt16LE(0, 10);           // time
    local.writeUInt16LE(0x21, 12);        // date (a fixed one: the archive must be reproducible)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(member.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, raw);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);          // version made by
    header.writeUInt16LE(20, 6);          // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(member.method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(raw.length, 20);
    header.writeUInt32LE(member.data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + raw.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuffer, eocd]);
}

/**
 * The base64 payload of the HTML report's embedded archive.
 *
 * The HTML report embeds its data as `data:application/zip;base64,<payload>`
 * inside a `<template>` element. A byte scan of the HTML file cannot see
 * inside it -- the payload is base64 -- so the platform has to decode it,
 * redact its members and encode it again.
 */
export const EMBEDDED_ZIP_PATTERN = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/g;

/**
 * Redacts the secrets inside the HTML report's embedded archive.
 *
 * @param {Buffer} html the HTML report
 * @param {object} redactor the redactor
 * @returns {{html:Buffer, redacted:boolean}} the rewritten report
 */
export function redactEmbeddedArchives(html, redactor) {
  if (!Buffer.isBuffer(html) || !redactor?.active) return { html, redacted: false };
  let changed = false;
  const text = html.toString('latin1');
  const out = text.replace(EMBEDDED_ZIP_PATTERN, (match, payload) => {
    let raw;
    try {
      raw = Buffer.from(payload, 'base64');
    } catch {
      return match;
    }
    const members = readZipMembers(raw);
    if (!members.length) return match;
    let touched = false;
    const rewritten = members.map((member) => {
      const data = redactor.redactBuffer(member.data);
      if (data !== member.data) touched = true;
      return { ...member, data };
    });
    if (!touched) return match;
    changed = true;
    return match.replace(payload, writeZipMembers(rewritten).toString('base64'));
  });
  return { html: Buffer.from(out, 'latin1'), redacted: changed };
}

/* ------------------------------------------------------------------ */
/* The redaction of a finished run                                       */
/* ------------------------------------------------------------------ */

/**
 * The files of a run folder that the platform REDACTS.
 *
 * The list is explicit rather than a blanket "every text file", because a
 * blanket rule would rewrite the engine's own binaries (the trace, the
 * screenshots) and break their digests for no gain.
 */
export const REDACTABLE_EXTENSIONS = Object.freeze([
  '.json', '.md', '.log', '.txt', '.html', '.js', '.css', '.csv', '.yaml', '.yml',
]);

/**
 * True when the platform may rewrite this file.
 *
 * The rule is by EXTENSION, plus the ZIP files (whose members are text or
 * JSON that the engine wrote). The trace's `trace.zip` is a ZIP too, so the
 * ZIP case is decided by the member NAMES: the trace's members are binary
 * (`test.trace` is a binary format), and a member that is not valid UTF-8
 * text is left alone.
 */
export function isRedactableFile(file) {
  const ext = path.extname(String(file)).toLowerCase();
  if (ext === '.zip') return true;
  return REDACTABLE_EXTENSIONS.includes(ext);
}

/**
 * True when a buffer holds text (rather than binary).
 *
 * A ZIP member that is not text is not rewritten: rewriting binary bytes
 * would corrupt the archive's payload.
 */
export function looksLikeText(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) return false;
  return true;
}

/**
 * Redacts the text files of a run folder, in place.
 *
 * The manifest's digests are computed AFTER this runs, so the archive
 * describes the redacted bytes -- not the bytes that held the secret.
 *
 * @param {string} folder the run folder
 * @param {object} redactor the redactor
 * @returns {{files:string[], binaries:string[]}} what was rewritten and what
 *   was left alone because it is a binary the platform cannot rewrite
 */
export function redactRunFolder(folder, redactor) {
  const rewritten = [];
  const skipped = [];
  if (!redactor?.active) return { files: rewritten, binaries: skipped };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!isRedactableFile(entry.name)) continue;
      let bytes;
      try {
        bytes = fs.readFileSync(full);
      } catch {
        continue;
      }
      if (!looksLikeText(bytes)) {
        // A binary the platform cannot rewrite. It is REPORTED, so the
        // boundary is visible instead of silent.
        skipped.push(path.relative(folder, full));
        continue;
      }
      const text = bytes.toString('utf8');
      const redacted = redactor.redactText(text);
      if (redacted === text) continue;
      try {
        fs.writeFileSync(full, redacted, 'utf8');
        rewritten.push(path.relative(folder, full));
      } catch {
        skipped.push(path.relative(folder, full));
      }
    }
  };
  try {
    walk(folder);
  } catch {
    // A folder that cannot be walked is a boundary, not a crash.
  }
  return { files: rewritten, binaries: skipped };
}

/**
 * Redacts the secrets inside a run folder's ZIP archives, in place.
 *
 * The archive is rebuilt with redacted members. A member that is binary (the
 * trace) is left alone, and the archive is reported as carrying a boundary
 * artefact.
 */
export function redactRunArchives(folder, redactor) {
  const rewritten = [];
  const boundaries = [];
  if (!redactor?.active) return { files: rewritten, boundaries };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (path.extname(entry.name).toLowerCase() !== '.zip') continue;
      let bytes;
      try {
        bytes = fs.readFileSync(full);
      } catch {
        continue;
      }
      const members = readZipMembers(bytes);
      if (!members.length) continue;
      let touched = false;
      let binary = false;
      const rewrittenMembers = members.map((member) => {
        if (!looksLikeText(member.data)) { binary = true; return member; }
        const data = redactor.redactBuffer(member.data);
        if (data !== member.data) touched = true;
        return { ...member, data };
      });
      if (!touched) {
        if (binary) boundaries.push(path.relative(folder, full));
        continue;
      }
      try {
        fs.writeFileSync(full, writeZipMembers(rewrittenMembers));
        rewritten.push(path.relative(folder, full));
        if (binary) boundaries.push(path.relative(folder, full));
      } catch {
        boundaries.push(path.relative(folder, full));
      }
    }
  };
  try {
    walk(folder);
  } catch {
    // A folder that cannot be walked is a boundary, not a crash.
  }
  return { files: rewritten, boundaries };
}
