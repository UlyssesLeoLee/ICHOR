/**
 * A minimal zip reader -- enough to open a Playwright `trace.zip`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The acceptance criterion of ATS-107 says the PASS and the FAIL must come
 * from a REAL Chromium. A trace file alone does not prove that: a fixture
 * that never asks for a `page` still produces a `trace.zip` (with the
 * test-runner's own trace inside it), and that file mentions the browser
 * name in places that have nothing to do with a browser having been
 * launched.
 *
 * What DOES prove it is the BROWSER CONTEXT trace: the engine writes one
 * trace file per browser context (`<n>-trace.trace`), and the first event
 * of that file is a `context-options` event whose `browserName` names the
 * browser that was actually launched. A run that never launched a browser
 * has no such file.
 *
 * So the probe reads the trace archive and looks at that event. Reading a
 * zip container needs the central directory and an inflate, which `zlib`
 * alone cannot do -- hence this small reader.
 *
 * The reader is deliberately minimal: it lists the members and inflates
 * one of them as text. It never writes.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';

/**
 * Parse the central directory of a zip container.
 *
 * @param {Buffer} buf the whole archive
 * @returns {Array<{name: string, method: number, compSize: number, dataStart: number}>}
 */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip container');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const members = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
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
    members.push({ name, method, compSize, dataStart });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return members;
}

/** Inflate one member's bytes as text. */
export function readMember(buf, member) {
  const raw = buf.slice(member.dataStart, member.dataStart + member.compSize);
  return member.method === 0 ? raw.toString('utf8') : zlib.inflateRawSync(raw).toString('utf8');
}

/**
 * The members of a zip archive on disk, as text.
 *
 * @param {string} file the archive
 * @returns {Map<string, string>} the member name -> its text
 */
export function readZipText(file) {
  const buf = fs.readFileSync(file);
  const out = new Map();
  for (const member of readZip(buf)) out.set(member.name, readMember(buf, member));
  return out;
}
