/**
 * Minimal zip reader/writer for the WBS workbook.
 *
 * The workbook is a zip container whose members are XML written with the
 * `x:` namespace prefix. The audit and the negative control need to read a
 * member and to replace one member's bytes without disturbing the others --
 * `zlib` alone cannot do that, and re-implementing the whole container format
 * is exactly what is needed here.
 *
 * Only what the probes need is implemented: read the central directory,
 * inflate a member, and rebuild the archive with one member replaced. The
 * rebuild preserves every other member's compressed bytes verbatim, so the
 * untouched members cannot drift.
 */
import zlib from 'node:zlib';

/** Parse the central directory and return the members with their offsets. */
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
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    members.push({
      name,
      method,
      compSize,
      uncompSize,
      localOff,
      dataStart,
      raw: buf.slice(dataStart, dataStart + compSize),
      crc32: buf.readUInt32LE(off + 16),
      time: buf.readUInt16LE(off + 12),
      date: buf.readUInt16LE(off + 14),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return members;
}

/** Inflate one member's bytes as text. */
export function readMember(buf, member) {
  return member.method === 0
    ? member.raw.toString('utf8')
    : zlib.inflateRawSync(member.raw).toString('utf8');
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 of a buffer (the zip container's checksum). */
export function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * Rebuild the archive with one member's CONTENT replaced.
 *
 * The replacement is expressed as a byte-level `from` -> `to` substitution
 * inside the member's decompressed text. The member is recompressed; every
 * other member keeps its original compressed bytes.
 */
export function replaceMember(buf, memberName, from, to) {
  const members = readZip(buf);
  const target = members.find((m) => m.name === memberName);
  if (!target) throw new Error(`member not found: ${memberName}`);
  const text = readMember(buf, target);
  const idx = text.indexOf(from);
  if (idx < 0) throw new Error(`mutation target not found in ${memberName}`);
  const newText = text.slice(0, idx) + to + text.slice(idx + from.length);
  const newRaw = Buffer.from(newText, 'utf8');

  const chunks = [];
  let offset = 0;
  const central = [];
  for (const m of members) {
    const isTarget = m.name === memberName;
    const data = isTarget ? zlib.deflateRawSync(newRaw) : m.raw;
    const method = isTarget ? 8 : m.method;
    const nameBuf = Buffer.from(m.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(m.time, 10);
    local.writeUInt16LE(m.date, 12);
    local.writeUInt32LE(isTarget ? crc32(newRaw) : m.crc32, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(isTarget ? newRaw.length : m.uncompSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(m.time, 12);
    cd.writeUInt16LE(m.date, 14);
    cd.writeUInt32LE(isTarget ? crc32(newRaw) : m.crc32, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(isTarget ? newRaw.length : m.uncompSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, eocd]);
}
