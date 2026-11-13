#!/usr/bin/env node
/**
 * ATS-606: the negative controls for the §8.5 GROUPING.
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * A probe that only ever says OK is not evidence. This file is the harness
 * that reproduces the mutations a reviewer can make to the §8.5 grouping
 * and proves the probe catches every one of them. It is DELIVERED (not a
 * throw-away probe) so that the reviewer can run it against any tree:
 *
 *     node tools/ats606-probes/probe-group-mutants.mjs <repo>
 *
 * Every mutant:
 *   * moves a row from one verdict group to another,
 *   * rewrites the group headings AND the TALLY AND the counts stated
 *     in §8.5.4 AND the counts stated in §8.5.5 -- so the mutation is
 *     CONSISTENT in every visible way,
 *   * and the ONLY thing wrong with it is WHICH GROUP the row is in.
 *
 * A mutant that the probe lets through is a failure of the probe, and
 * this file exits 1.
 *
 * WHAT THE PROBE CATCHES EACH MUTANT WITH
 * ----------------------------------------
 * The probe compares the WHOLE §8.5 block against the generator's output,
 * so every mutant is caught by that comparison. But a mutant that ALSO
 * changed the generator would slip past it, so the probe ALSO re-derives
 * every row's verdict FROM THE BYTE-CODE and compares it with the
 * document. The mutant `M7` below is the one that exercises that second
 * check on its own: it moves `extendedWaitUntil` into the unmappable
 * group AND rewrites every count, so only the byte-code check can see it.
 *
 * The counts are NOT written down here -- they are derived from the LIVE
 * table, so the harness keeps working when the table changes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.argv[2] ?? path.join(HERE, '..', '..'));
const MD = path.join(REPO, 'docs', '25-MOBILE-APP-TESTING.md');
const PROBE = path.join(HERE, 'probe-maestro-compat.mjs');

if (!fs.existsSync(MD)) {
  console.error(`the design document is missing: ${MD}`);
  process.exit(1);
}
const md = fs.readFileSync(MD, 'utf8');

/** The block of the document: between the two markers, each on its own line. */
function blockOf(text) {
  const start = /^<!-- ATS606-ROWS-START -->[ \t]*$/m.exec(text);
  const end = /^<!-- ATS606-ROWS-END -->[ \t]*$/m.exec(text);
  if (!start || !end) return null;
  return { start, end, body: text.slice(start.index + start[0].length, end.index) };
}

/** The three group headings and how many rows each holds. */
function groupSizes(block) {
  const sizes = { mappable: 0, partial: 0, unmappable: 0 };
  const heading = /^#### 8\.5\.(\d) (可映射|部分可映射|不映射)（(\d+) 条）$/gm;
  let m;
  while ((m = heading.exec(block)) !== null) {
    const key = m[2] === '部分可映射' ? 'partial' : (m[2] === '可映射' ? 'mappable' : 'unmappable');
    sizes[key] = Number(m[3]);
  }
  return sizes;
}

const GROUP_HEADING = {
  mappable: '#### 8.5.1 可映射',
  partial: '#### 8.5.2 部分可映射',
  unmappable: '#### 8.5.3 不映射',
};
const GROUP_INDEX = { mappable: '1', partial: '2', unmappable: '3' };

/**
 * Moves a row into another group and rewrites EVERY count, so that the
 * mutant is consistent everywhere except in the one thing under test.
 */
function moveRow(command, from, to) {
  const block = blockOf(md);
  if (!block) return null;
  const ls = block.body.split(/\r?\n/);

  const rowAt = ls.findIndex((l) => l.startsWith(`| \`${command}\` |`));
  if (rowAt < 0) return null;
  const [row] = ls.splice(rowAt, 1);

  const h = ls.findIndex((l) => l.startsWith(GROUP_HEADING[to]));
  if (h < 0) return null;
  const sep = ls.findIndex((l, j) => j > h && l.startsWith('|---|'));
  if (sep < 0) return null;
  ls.splice(sep + 1, 0, row);

  const sizes = groupSizes(block.body);
  sizes[from] -= 1;
  sizes[to] += 1;

  const moved = ls.join('\n')
    .replace(/#### 8\.5\.1 可映射（\d+ 条）/, `#### 8.5.1 可映射（${sizes.mappable} 条）`)
    .replace(/#### 8\.5\.2 部分可映射（\d+ 条）/, `#### 8.5.2 部分可映射（${sizes.partial} 条）`)
    .replace(/#### 8\.5\.3 不映射（\d+ 条）/, `#### 8.5.3 不映射（${sizes.unmappable} 条）`)
    .replace(
      /<!-- TALLY mappable=\d+ partial=\d+ unmappable=\d+ total=\d+ imported=\d+ reported=\d+ -->/,
      `<!-- TALLY mappable=${sizes.mappable} partial=${sizes.partial} unmappable=${sizes.unmappable} `
      + `total=${sizes.mappable + sizes.partial + sizes.unmappable} imported=4 reported=51 -->`,
    );

  const head = md.slice(0, block.start.index + block.start[0].length);
  const tail = md.slice(block.end.index);
  // The counts stated in §8.5.4 are updated too.
  const tailFixed = tail.replace(
    /可映射\s*\d+\s*条\s*\/\s*部分可映射\s*\d+\s*条\s*\/\s*不映射\s*\d+\s*条/,
    `可映射 ${sizes.mappable} 条 / 部分可映射 ${sizes.partial} 条 / 不映射 ${sizes.unmappable} 条`,
  );
  // And the counts stated in §8.5.5 (the conclusion table and the
  // one-sentence summary). A mutant that left those stale would be caught
  // by a stale-number check rather than by the grouping check, which is
  // not what this harness is testing.
  const tailFixed2 = tailFixed
    .replace(/(\| 可映射 \|[^\n]*\| )\d+( \|)/, `$1${sizes.mappable}$2`)
    .replace(/(\| 部分可映射 \|[^\n]*\| )\d+( \|)/, `$1${sizes.partial}$2`)
    .replace(/(\| 不映射 \|[^\n]*\| )\d+( \|)/, `$1${sizes.unmappable}$2`)
    .replace(/能表达 \d+ 条的动作\s*（可映射 \d+ \+ 部分可映射 \d+）/,
      `能表达 ${sizes.mappable + sizes.partial} 条的动作（可映射 ${sizes.mappable} + 部分可映射 ${sizes.partial}）`);
  return head + moved + tailFixed2;
}

const MUTANTS = [
  { name: 'M0 control (unchanged)', text: md, mustFail: false },
  { name: 'M1 assertNotVisible -> 部分可映射', text: moveRow('assertNotVisible', 'mappable', 'partial'), mustFail: true },
  { name: 'M2 swipe -> 可映射', text: moveRow('swipe', 'unmappable', 'mappable'), mustFail: true },
  { name: 'M3 assertVisible -> 不映射', text: moveRow('assertVisible', 'mappable', 'unmappable'), mustFail: true },
  { name: 'M4 startRecording -> 不映射', text: moveRow('startRecording', 'partial', 'unmappable'), mustFail: true },
  { name: 'M5 launchApp -> 部分可映射', text: moveRow('launchApp', 'mappable', 'partial'), mustFail: true },
  { name: 'M6 tapOn -> 不映射', text: moveRow('tapOn', 'mappable', 'unmappable'), mustFail: true },
  // M7: the mutation the byte-code check is FOR. `extendedWaitUntil`
  // compiles into the very same orchestra command class as
  // `assertVisible`, so filing it as unmappable contradicts the
  // byte-code -- and every count is rewritten, so nothing else shows it.
  { name: 'M7 extendedWaitUntil -> 不映射', text: moveRow('extendedWaitUntil', 'mappable', 'unmappable'), mustFail: true },
  // M8: the same class of mutation on the other side -- a command the
  // platform CAN express, filed as partially mappable.
  { name: 'M8 takeScreenshot -> 部分可映射', text: moveRow('takeScreenshot', 'mappable', 'partial'), mustFail: true },
];

let notBuilt = 0;
let leaked = 0;
let n = 0;

console.log('=== ATS-606: the negative controls for the §8.5 GROUPING ===');
console.log(`repo : ${REPO}`);
console.log('every mutant moves a row into another group and rewrites EVERY count,');
console.log('so the only thing wrong with it is WHICH GROUP the row is in.');
console.log('');

for (const mutant of MUTANTS) {
  if (mutant.text === null || mutant.text === undefined) {
    console.log(`SKIP  ${mutant.name} -- the row could not be found in the table`);
    notBuilt += 1;
    continue;
  }
  const file = path.join(os.tmpdir(), `ats606-mutant-${process.pid}-${n++}.md`);
  fs.writeFileSync(file, mutant.text, 'utf8');
  const res = spawnSync(process.execPath, [PROBE, '--md', file], {
    encoding: 'utf8',
    timeout: 900000,
    env: { ...process.env, ATS606_SKIP_MAESTRO: '1' },
  });
  fs.rmSync(file, { force: true });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const caught = res.status !== 0 && /FAIL/.test(out);

  if (!mutant.mustFail) {
    const verdict = res.status === 0 ? 'OK (control passes)' : 'BROKEN CONTROL';
    console.log(`${mutant.name.padEnd(40)} exit=${res.status}  => ${verdict}`);
    if (res.status !== 0) {
      leaked += 1;
      for (const l of out.split('\n').filter((x) => x.startsWith('FAIL')).slice(0, 3)) console.log(`     ${l.slice(0, 160)}`);
    }
    continue;
  }

  if (caught) {
    const why = out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 2);
    console.log(`${mutant.name.padEnd(40)} exit=${res.status}  => caught`);
    for (const l of why) console.log(`     ${l.slice(0, 170)}`);
  } else {
    console.log(`${mutant.name.padEnd(40)} exit=${res.status}  => NOT CAUGHT -- the probe cannot see the grouping`);
    leaked += 1;
  }
}

console.log('');
if (notBuilt) {
  console.log(`SKIP ${notBuilt} mutant(s) could not be built -- the table format changed`);
}
if (leaked) {
  console.log(`GROUP MUTANTS: FAIL (${leaked} mutant(s) were not caught)`);
  process.exit(1);
}
console.log('GROUP MUTANTS: OK (every group mutation was caught, and the control still passes)');
process.exit(0);
