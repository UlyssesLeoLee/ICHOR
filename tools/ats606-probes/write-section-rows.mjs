#!/usr/bin/env node
/**
 * ATS-606: writes the generated §8.5 block into docs/25-MOBILE-APP-TESTING.md.
 *
 * The generator (gen-section-rows.mjs) prints the block on stdout; this
 * puts it between the two ATS606-ROWS markers. The line terminators are
 * taken from the document itself, so a CRLF checkout stays CRLF.
 *
 * usage: node tools/ats606-probes/write-section-rows.mjs [repo]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.argv[2] ?? path.join(HERE, '..', '..'));
const MD = path.join(REPO, 'docs', '25-MOBILE-APP-TESTING.md');

const gen = spawnSync(process.execPath, [path.join(HERE, 'gen-section-rows.mjs'), REPO], {
  encoding: 'utf8',
  timeout: 900000,
});
if (gen.status !== 0) {
  console.error(`the generator failed (exit ${gen.status}):`);
  console.error(gen.stderr ?? '');
  process.exit(gen.status === 0 ? 1 : gen.status);
}

const raw = fs.readFileSync(MD, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
// The markers must stand ALONE on their line: the §8.5 introduction
// mentions them in backticks, and a plain indexOf would find THAT first.
const startMark = /^<!-- ATS606-ROWS-START -->[ \t]*$/m.exec(raw);
const endMark = /^<!-- ATS606-ROWS-END -->[ \t]*$/m.exec(raw);
if (!startMark || !endMark || endMark.index < startMark.index) {
  console.error('the document has no ATS606-ROWS markers');
  process.exit(1);
}
const start = startMark.index;
const end = endMark.index;

const block = gen.stdout.replace(/\r\n/g, '\n').replace(/\s+$/, '');
const out = raw.slice(0, start + '<!-- ATS606-ROWS-START -->'.length)
  + eol + block + eol
  + raw.slice(end);

if (out === raw) {
  console.log('the block is already up to date');
} else {
  fs.writeFileSync(MD, out, 'utf8');
  console.log(`the §8.5 block was rewritten (${block.split('\n').length} lines)`);
}
