/**
 * Collect every SKIPPED test of the full suite, with its reason.
 *
 * The suite's skipped tests are the ones whose fixture the machine does not
 * have: an example project without `node_modules`, an Android device, a
 * credential store. `node --test` reports a COUNT (`skipped 32`) but not
 * WHICH tests, so a reader of the evidence cannot tell what did not run.
 *
 * This script asks the runner for the per-test detail:
 *
 *     node --test --test-concurrency=2 --test-reporter=tap tests/*.test.mjs
 *
 * The TAP reporter prints one line per test, and a skipped test carries its
 * reason (`# SKIP <reason>`). This script parses those lines and prints the
 * name, the reason and the file the test lives in -- so the evidence carries
 * the LIST, not just the count.
 *
 * Usage: node tools/ats307-probes/collect-skipped.mjs [--out FILE]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readdir } from 'node:fs/promises';

const root = path.resolve(import.meta.dirname, '..', '..');
const outIndex = process.argv.indexOf('--out');
const outPath = outIndex > -1 ? process.argv[outIndex + 1] : null;

function run(args) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('close', (code) => resolve({ code, out, err }));
    cp.on('error', reject);
  });
}

/** The TAP line of a test: `ok 1 - <name> # SKIP <reason>`. */
const TAP_RE = /^(ok|not ok)\s+\d+\s+-\s+(.*?)(?:\s+#\s*SKIP\s*(.*))?$/;

const files = (await readdir(path.join(root, 'tests')))
  .filter((n) => n.endsWith('.test.mjs'))
  .sort()
  .map((n) => path.posix.join('tests', n));
const result = await run(['--test', '--test-concurrency=2', '--test-reporter=tap', ...files]);

const lines = result.out.split('\n');
const skipped = [];

for (const line of lines) {
  const m = TAP_RE.exec(line);
  if (!m) continue;
  const [, status, name, reason] = m;
  if (status !== 'ok') continue;
  if (reason === undefined) continue;
  skipped.push({ name: name.trim(), reason: reason.trim() });
}

// The TAP reporter does not say which FILE a test came from, so the
// attribution is made from the sources: a test is declared in exactly one
// file, and the declaration carries its name. The index is built from the
// real files, so a test that cannot be attributed is REPORTED rather than
// attributed to the wrong file.
const owner = new Map();
for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const s of skipped) {
    if (owner.has(s.name)) continue;
    if (text.includes(s.name)) owner.set(s.name, file);
  }
}
for (const s of skipped) {
  s.file = owner.get(s.name) ?? '(not attributed)';
}

console.log('=== ATS-307: the skipped tests of the full suite, with their reasons ===');
console.log(`command     : node --test --test-concurrency=2 --test-reporter=tap tests/*.test.mjs`);
console.log(`exit code   : ${result.code}`);
console.log(`skipped     : ${skipped.length}`);
console.log('');

const byReason = new Map();
for (const s of skipped) {
  const key = s.reason || '(no reason given)';
  if (!byReason.has(key)) byReason.set(key, []);
  byReason.get(key).push(s);
}

for (const [reason, items] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`--- ${items.length} skipped: ${reason}`);
  for (const s of items) console.log(`      ${s.file}  ${s.name}`);
  console.log('');
}

const lines2 = [];
lines2.push('=== ATS-307: the skipped tests of the full suite, with their reasons ===');
lines2.push(`exit code   : ${result.code}`);
lines2.push(`skipped     : ${skipped.length}`);
lines2.push('');
for (const [reason, items] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
  lines2.push(`--- ${items.length} skipped: ${reason}`);
  for (const s of items) lines2.push(`      ${s.file}  ${s.name}`);
  lines2.push('');
}

if (outPath) {
  fs.writeFileSync(path.resolve(root, outPath), lines2.join('\n'), 'utf8');
  console.log(`written: ${outPath}`);
}
