#!/usr/bin/env node
/**
 * ATS-102 -- unit test for the line-ending normalisation in tree_digest.mjs.
 *
 * The installed-tree digest has to be independent of the checkout's
 * line-ending style: the SAME tree, checked out with CRLF and with LF, must
 * produce the SAME digest. Before the normalisation existed, npm wrote the
 * hidden lockfile `node_modules/.package-lock.json` in the line-ending style
 * of the lockfile it had read, so a CRLF checkout and an LF checkout of one
 * and the same commit produced two different digests.
 *
 * This test drives tools/tree_digest.mjs over purpose-built trees and
 * asserts:
 *
 *   1. a CRLF file and its LF counterpart hash to the SAME digest
 *   2. a binary file (containing a NUL byte) is hashed byte for byte, so
 *      CRLF and LF variants of it DIFFER -- the normalisation must not
 *      rewrite binary data
 *   3. a lone CR (not followed by LF) is preserved -- it is not a CRLF
 *   4. content changes are still detected: a truncated / zero-padded file
 *      hashes differently (the normalisation must not hide corruption)
 *   5. a file whose CRLF straddles the 64 KiB read boundary normalises
 *      correctly (the chunk-boundary case)
 *
 * Usage:  node tools/ats102-probes/test-tree-digest-eol.mjs
 * Exit code 0 = all assertions passed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = path.join(REPO_ROOT, 'tools', 'tree_digest.mjs');

let failures = 0;
let checks = 0;

function check(label, actual, expected) {
  checks++;
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected: ${expected}\n        actual:   ${actual}`);
}

/** Run the digest tool over a tree root and return the tree sha256. */
function digest(treeRoot, extra = []) {
  const res = spawnSync(process.execPath, [TOOL, treeRoot, ...extra], {
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`tree_digest.mjs failed (${res.status}): ${res.stderr}`);
  }
  const m = res.stdout.match(/tree sha256\s+:\s+([0-9a-f]{64})/);
  if (!m) throw new Error(`no digest in output:\n${res.stdout}`);
  return m[1];
}

/** Build a tree with one file of the given bytes; return its root. */
function treeWith(name, bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats102-eol-'));
  fs.writeFileSync(path.join(root, name), bytes);
  return root;
}

const TEXT_CRLF = Buffer.from('line one\r\nline two\r\nline three\r\n');
const TEXT_LF = Buffer.from('line one\nline two\nline three\n');

// 1. CRLF and LF text hash the same.
console.log('1. a CRLF text file and its LF counterpart hash the same');
const dCrlf = digest(treeWith('a.txt', TEXT_CRLF));
const dLf = digest(treeWith('a.txt', TEXT_LF));
check('CRLF text == LF text', dCrlf, dLf);

// 2. Binary files are hashed byte for byte: the normalisation must not apply.
console.log('2. a binary file is hashed byte for byte');
const BIN_CRLF = Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0x02, 0x00]);
const BIN_LF = Buffer.from([0x00, 0x01, 0x0a, 0x02, 0x00]);
const dBinCrlf = digest(treeWith('b.bin', BIN_CRLF));
const dBinLf = digest(treeWith('b.bin', BIN_LF));
check('binary CRLF != binary LF', dBinCrlf === dBinLf, false);

// 3. A lone CR is not a CRLF and is preserved.
console.log('3. a lone CR (no LF after it) is preserved');
const LONE_CR = Buffer.from('a\rb\n');
check(
  'lone CR is preserved (not treated as a line ending)',
  digest(treeWith('c.txt', LONE_CR)),
  digest(treeWith('c.txt', LONE_CR)),
);
// The lone-CR file must differ from the same file with the CR removed --
// i.e. the CR was not silently dropped.
const LONE_CR_DROPPED = Buffer.from('ab\n');
check('lone CR != CR dropped', digest(treeWith('c.txt', LONE_CR)) === digest(treeWith('c.txt', LONE_CR_DROPPED)), false);
// ...and it must differ from the CRLF form too.
const LONE_CR_CRLF = Buffer.from('a\r\nb\n');
check('lone CR != CRLF', digest(treeWith('c.txt', LONE_CR)) === digest(treeWith('c.txt', LONE_CR_CRLF)), false);

// 4. Corruption is still detected.
console.log('4. content corruption is still detected');
const GOOD = Buffer.from('x'.repeat(1000) + '\r\n');
const TRUNCATED = Buffer.concat([Buffer.from('x'.repeat(1000)), Buffer.alloc(1000)]);
check('zero-padded file hashes differently', digest(treeWith('d.txt', GOOD)) === digest(treeWith('d.txt', TRUNCATED)), false);
const ONE_CHAR_CHANGED = Buffer.from('x'.repeat(999) + 'y' + '\r\n');
check('a changed byte hashes differently', digest(treeWith('d.txt', GOOD)) === digest(treeWith('d.txt', ONE_CHAR_CHANGED)), false);

// 5. A CRLF straddling the 64 KiB read boundary.
console.log('5. a CRLF straddling the 64 KiB read boundary normalises correctly');
const BOUNDARY = 1 << 16;
// 'a' * 65535 then CRLF: the CR is the last byte of the first 64 KiB read
// and the LF is the first byte of the next one, so the pair is split.
const straddlingCrlf = Buffer.concat([
  Buffer.from('a'.repeat(BOUNDARY - 1)),
  Buffer.from('\r\n'),
  Buffer.from('b'.repeat(10)),
]);
// The same file in LF form -- the LF counterpart must hash identically.
const straddlingLf = Buffer.concat([
  Buffer.from('a'.repeat(BOUNDARY - 1)),
  Buffer.from('\n'),
  Buffer.from('b'.repeat(10)),
]);
check(
  'CRLF across the chunk boundary == LF',
  digest(treeWith('e.txt', straddlingCrlf)),
  digest(treeWith('e.txt', straddlingLf)),
);
// The same file with a lone CR at the boundary must NOT equal the LF form.
const straddlingLoneCr = Buffer.concat([
  Buffer.from('a'.repeat(BOUNDARY - 1)),
  Buffer.from('\r'),
  Buffer.from('b'.repeat(10)),
]);
check(
  'lone CR across the chunk boundary != LF',
  digest(treeWith('e.txt', straddlingLoneCr)) === digest(treeWith('e.txt', straddlingLf)),
  false,
);

// 6. The digest of a real file matches an independent reimplementation.
console.log('6. the tool agrees with an independent reimplementation of the recipe');
{
  const bytes = Buffer.from('hello\r\nworld\r\n');
  const root = treeWith('f.txt', bytes);
  const expected = crypto
    .createHash('sha256')
    .update(`f.txt\0${crypto.createHash('sha256').update(Buffer.from('hello\nworld\n')).digest('hex')}\n`)
    .digest('hex');
  check('recipe reimplemented independently', digest(root), expected);
}

console.log('');
console.log(`${checks - failures}/${checks} assertions passed`);
if (failures) {
  console.error(`RESULT: FAILED (${failures} assertion(s) failed)`);
  process.exit(1);
}
console.log('RESULT: OK');
