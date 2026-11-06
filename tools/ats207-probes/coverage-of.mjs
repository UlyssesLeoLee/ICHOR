/**
 * ATS-207: per-file line coverage from an LCOV file.
 *
 *   node tools/ats207-probes/coverage-of.mjs <lcov> <path-regex>
 *
 * Prints hit/total/percent for every file whose path matches, and the totals
 * of the whole LCOV file.
 */
import fs from 'node:fs';

const [lcov, pattern] = process.argv.slice(2);
const match = new RegExp(pattern);
const stats = new Map();
let current = null;
for (const raw of fs.readFileSync(lcov, 'utf8').split('\n')) {
  const line = raw.trim();
  if (line.startsWith('SF:')) {
    current = line.slice(3).split(String.fromCharCode(92)).join('/');
    if (!stats.has(current)) stats.set(current, [0, 0]);
  } else if (line.startsWith('LH:')) stats.get(current)[0] += Number(line.slice(3));
  else if (line.startsWith('LF:')) stats.get(current)[1] += Number(line.slice(3));
}
let hit = 0;
let found = 0;
for (const [file, [h, n]] of [...stats].sort()) {
  hit += h;
  found += n;
  if (match.test(file)) console.log(`${file.replace(/^.*?\/(server|tools)\//, '$1/')}  ${h}/${n}  ${n ? ((100 * h) / n).toFixed(2) : 'n/a'}%`);
}
console.log(`all files in this LCOV: ${hit}/${found}  ${((100 * hit) / found).toFixed(2)}%`);
