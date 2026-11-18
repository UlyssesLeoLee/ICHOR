/**
 * ATS-307 -- the evidence README's numbers, CHECKED against the committed
 * logs.
 *
 * The README of `docs/evidence/ATS-307/` states three things that can go
 * stale, and every one of them did:
 *
 *   1. how many steps the collection has (the script ran eight steps and
 *      the README said seven);
 *   2. which logs the collection produced (the README's table named seven
 *      logs and the directory held eight -- the skip reasons were in the
 *      one the README did not name);
 *   3. how many cases the suites hold (the suite grew from 33 to 36 and
 *      the README kept 33).
 *
 * A number typed in prose is a number that can disagree with the thing it
 * describes. So the check lives in CODE: it compares the README against
 * the collector's own step markers, against the committed directory and
 * against the committed suite logs, and it FAILS when they disagree.
 *
 * The check is standalone so that running it alone and running it inside
 * the whole collection cannot drift apart.
 *
 * Run: node tools/ats307-probes/check-readme-consistency.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const evidenceDir = path.join(root, 'docs', 'evidence', 'ATS-307');
const readmePath = path.join(evidenceDir, 'README.md');
const collectorPath = path.join(root, 'tools', 'ats307-probes', 'collect-evidence.sh');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

console.log('=== ATS-307: the evidence README vs the committed logs ===');

if (!fs.existsSync(readmePath)) {
  console.log('RESULT: FAIL -- the evidence README does not exist');
  process.exit(1);
}
const readme = fs.readFileSync(readmePath, 'utf8');
const collector = fs.readFileSync(collectorPath, 'utf8');

// --- 1. the step count -------------------------------------------------
const stepMarkers = collector.match(/^# --- \d+\./gm) ?? [];
const steps = stepMarkers.length;
const claimed = /全流程（(\d+) 歩）/.exec(readme)?.[1] ?? null;
check('the README claims the number of steps the collector runs',
  claimed !== null && Number(claimed) === steps,
  `the collector runs ${steps} steps, the README claims ${claimed ?? 'none'}`);

// --- 2. the log table --------------------------------------------------
const committed = fs.readdirSync(evidenceDir)
  .filter((n) => /^[0-9]{2}-.*\.log$/.test(n))
  .sort();
const named = [...readme.matchAll(/^\| `([0-9]{2}-[^`]+\.log)`/gm)].map((m) => m[1]);
check('the README log table has one row per committed log',
  named.length === committed.length,
  `the directory holds ${committed.length} logs, the table names ${named.length}`);
const notNamed = committed.filter((n) => !named.includes(n));
check('every committed log is named in the README',
  notNamed.length === 0,
  `not named: ${notNamed.join(', ')}`);
const notCommitted = named.filter((n) => !committed.includes(n));
check('every log the README names is committed',
  notCommitted.length === 0,
  `named but absent: ${notCommitted.join(', ')}`);

// --- 3. the suite counts -----------------------------------------------
// The README claims how many cases each suite holds. The committed suite
// logs are the authority.
for (const [label, file, pattern] of [
  ['UT', '01-node-test-traceability-ut.log', /UT (\d+) 例/],
  ['IT', '02-node-test-traceability-it.log', /IT (\d+) 例/],
]) {
  const logPath = path.join(evidenceDir, file);
  if (!fs.existsSync(logPath)) {
    check(`the ${label} suite log is committed`, false, `missing ${file}`);
    continue;
  }
  const log = fs.readFileSync(logPath, 'utf8');
  const logCount = /ℹ tests (\d+)/.exec(log)?.[1] ?? null;
  const readmeCount = pattern.exec(readme)?.[1] ?? null;
  check(`the README ${label} case count is the committed suite log count`,
    logCount !== null && readmeCount !== null && logCount === readmeCount,
    `the log holds ${logCount ?? 'none'} cases, the README claims ${readmeCount ?? 'none'}`);
}

console.log('');
if (failures === 0) {
  console.log('RESULT: OK -- the README step count, log table and suite counts are the committed ones');
} else {
  console.log(`RESULT: FAIL -- ${failures} mismatch(es) between the README and the committed logs`);
  process.exitCode = 1;
}
