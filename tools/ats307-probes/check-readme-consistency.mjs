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

// --- 3b. the FULL REGRESSION's figures ---------------------------------
//
// The log table's row for the full regression states the whole suite's
// counts. Those counts were the ones the check above could not see: the
// suite logs cover only the two ATS-307 suites, and the full regression's
// row was never compared against the log it names.
//
// The consequence was a README that stated `1902 tests / 1870 pass` while
// the log sitting in the same directory said `1953 tests / 1921 pass` --
// the exact defect class this check exists to catch, in the one row the
// check did not cover.
{
  const file = '06-node-test-full.log';
  const logPath = path.join(evidenceDir, file);
  if (!fs.existsSync(logPath)) {
    check('the full regression log is committed', false, `missing ${file}`);
  } else {
    const log = fs.readFileSync(logPath, 'utf8');
    const figures = {};
    for (const key of ['tests', 'pass', 'fail', 'skipped']) {
      const m = new RegExp(`^ℹ ${key} (\\d+)$`, 'm').exec(log);
      figures[key] = m ? m[1] : null;
    }
    // The row of the log table that names this log.
    const row = new RegExp(`^\\| \`${file}\` \\|([^|]*)\\|([^|]*)\\|`, 'm').exec(readme);
    const claimed = row ? row[2] : null;
    for (const key of ['tests', 'pass', 'fail', 'skipped']) {
      const needle = `${figures[key]} ${key}`;
      check(`the README full-regression ${key} count is the committed log's`,
        claimed !== null && needle !== 'null null' && claimed.includes(needle),
        `the log says ${needle}, the README claims ${claimed ?? 'no row'}`);
    }
  }
}

// --- 3c. the negative control's mutation COUNT --------------------------
//
// The README states how many mutations the negative control performs, and
// the probe's own output states how many groups it ran. A count that is
// typed in the README goes stale the moment a group is added -- and the
// stale count is the one a reader trusts.
{
  const file = '05-negative-control.log';
  const logPath = path.join(evidenceDir, file);
  if (!fs.existsSync(logPath)) {
    check('the negative control log is committed', false, `missing ${file}`);
  } else {
    const log = fs.readFileSync(logPath, 'utf8');
    // The probe's numbered group headers: `--- 1. the RTM names ... ---`.
    const groups = [...log.matchAll(/^--- \d+\. /gm)].length;
    // The positive control is group 0 and is not a mutation, so the
    // mutations are the groups that follow it.
    const mutations = Math.max(groups - 1, 0);
    const claimed = /(\d+) 種の改変/.exec(readme)?.[1] ?? null;
    check('the README negative-control mutation count is the committed log\'s',
      claimed !== null && Number(claimed) === mutations,
      `the log ran ${mutations} mutation group(s), the README claims ${claimed ?? 'none'}`);
  }
}

// --- 4. the group listing covers every case ---------------------------
// The README lists the suite's cases in groups, and the listing has to
// name EVERY case id. A group that was forgotten leaves its cases
// undescribed, and the reader cannot tell whether the case exists.
//
// The ranges in the README are written `NNN〜MMM` (and the commit group
// names its cases individually), so the listing is read as the set of
// ids it covers.

{
  const utLogPath = path.join(evidenceDir, '01-node-test-traceability-ut.log');
  if (fs.existsSync(utLogPath)) {
    const log = fs.readFileSync(utLogPath, 'utf8');
    const ids = [...log.matchAll(/^[✔✓✖×✗]\s+(UT-ATS307-\d+)\s*:/gm)].map((m) => m[1]);
    // The ranges the README's group listing spells out.
    const ranges = [...readme.matchAll(/（(\d{3})〜(\d{3})）/g)]
      .map((m) => [Number(m[1]), Number(m[2])]);
    // The ids the README names one by one (the commit group).
    const named = new Set([...readme.matchAll(/UT-ATS307-(\d{3})/g)].map((m) => m[1]));
    const covered = new Set();
    for (const [from, to] of ranges) {
      for (let n = from; n <= to; n += 1) covered.add(String(n).padStart(3, '0'));
    }
    for (const n of named) covered.add(n);
    const missing = ids
      .map((id) => id.replace('UT-ATS307-', ''))
      .filter((n) => !covered.has(n));
    check('the README group listing covers every case the suite log shows',
      missing.length === 0,
      `not covered: ${missing.map((n) => `UT-ATS307-${n}`).join(', ')}`);
  }
}

// --- 4b. the graph measurements the README claims ---------------------
// The README states the graph's shape (nodes, edges, chains) and the
// commit coverage. Those numbers come from the probe, so the probe's log
// is the authority -- the same rule as the suite counts.
{
  const probePath = path.join(evidenceDir, '03-probe-traceability.log');
  if (fs.existsSync(probePath)) {
    const probe = fs.readFileSync(probePath, 'utf8');
    const probeNumber = (re) => re.exec(probe)?.[1] ?? null;
    const claims = [
      ['the node count', probeNumber(/^nodes\s+:\s+(\d+)$/m), /\| ノード \| (\d+) \|/],
      ['the edge count', probeNumber(/^edges\s+:\s+(\d+)$/m), /\| 辺 \| (\d+) \|/],
      ['the chain count', probeNumber(/^chains\s+:\s+(\d+)$/m), /\| チェーン（要件） \| (\d+) \|/],
      ['the commit coverage of the nodes',
        probeNumber(/^nodes with a commit : (\d+) of \d+$/m),
        /\| \*\*commit を持つノード\*\* \| \*\*(\d+) \/ \d+\*\* \|/],
      ['the commit coverage of the edges',
        probeNumber(/^edges with a commit : (\d+) of \d+$/m),
        /\| \*\*commit を持つ辺\*\* \| \*\*(\d+) \/ \d+\*\* \|/],
    ];
    for (const [label, actual, pattern] of claims) {
      const claimed = pattern.exec(readme)?.[1] ?? null;
      check(`the README ${label} is the probe log's measurement`,
        actual !== null && claimed !== null && actual === claimed,
        `the probe says ${actual ?? 'none'}, the README claims ${claimed ?? 'none'}`);
    }
  }
}

// --- 4c. the DESIGN DOCUMENT's measurements ---------------------------
//
// The design document states the same measurements in its §10 table and
// in its AC-3 row. Those numbers were TYPED: nothing compared them with
// the probe log, so when the tree moved on, the design document kept
// quoting the graph of an earlier tree while claiming IMPLEMENTED.
//
// The design document is the document a reviewer reads for the acceptance
// criteria, so a stale number in it is worse than one in the README: the
// AC table's status column is read as a verdict.
{
  const designPath = path.join(root, 'docs', '33-TRACEABILITY-GRAPH.md');
  const probePath = path.join(evidenceDir, '03-probe-traceability.log');
  if (!fs.existsSync(designPath)) {
    check('the design document exists', false, 'missing docs/33-TRACEABILITY-GRAPH.md');
  } else if (!fs.existsSync(probePath)) {
    check('the probe log is committed', false, 'missing 03-probe-traceability.log');
  } else {
    const design = fs.readFileSync(designPath, 'utf8');
    const probe = fs.readFileSync(probePath, 'utf8');
    const probeNumber = (re) => re.exec(probe)?.[1] ?? null;
    const claims = [
      ['the node count', probeNumber(/^nodes\s+:\s+(\d+)$/m), /\| ノード \| (\d+) \|/],
      ['the edge count', probeNumber(/^edges\s+:\s+(\d+)$/m), /\| 辺 \| (\d+) \|/],
      ['the chain count', probeNumber(/^chains\s+:\s+(\d+)$/m), /\| チェーン（要件） \| (\d+) \|/],
      ['the complete chain count', probeNumber(/^complete chains\s+:\s+(\d+)$/m), /\| 完全なチェーン \| (\d+) \|/],
      ['the broken chain count', probeNumber(/^broken chains\s+:\s+(\d+)$/m), /\| 欠けたチェーン \| (\d+) \|/],
      ['the commit coverage of the nodes',
        probeNumber(/^nodes with a commit : (\d+) of \d+$/m),
        /\| \*\*commit を持つノード\*\* \| \*\*(\d+) \/ \d+\*\* \|/],
      ['the commit coverage of the edges',
        probeNumber(/^edges with a commit : (\d+) of \d+$/m),
        /\| \*\*commit を持つ辺\*\* \| \*\*(\d+) \/ \d+\*\* \|/],
    ];
    for (const [label, actual, pattern] of claims) {
      const claimed = pattern.exec(design)?.[1] ?? null;
      check(`the design document ${label} is the probe log's measurement`,
        actual !== null && claimed !== null && actual === claimed,
        `the probe says ${actual ?? 'none'}, the design document claims ${claimed ?? 'none'}`);
    }
    // The AC-3 row of the acceptance table repeats the commit coverage.
    // That row's STATUS is read as a verdict, so its numbers must be the
    // measurement too.
    const nodesWithCommit = probeNumber(/^nodes with a commit : (\d+) of \d+$/m);
    const edgesWithCommit = probeNumber(/^edges with a commit : (\d+) of \d+$/m);
    const acRow = /^\| AC-3 \|.*$/m.exec(design)?.[0] ?? '';
    check('the design document AC-3 row carries the probe log\'s commit coverage',
      acRow !== '' && acRow.includes(`ノード ${nodesWithCommit}/${nodesWithCommit}`)
        && acRow.includes(`辺 ${edgesWithCommit}/${edgesWithCommit}`),
      `the probe says ノード ${nodesWithCommit}/${nodesWithCommit}・辺 ${edgesWithCommit}/${edgesWithCommit}, the AC-3 row says ${acRow || 'no row'}`);
  }
}

// --- 5. the number of groups the README claims -------------------------
{
  // The GROUP LIST is the numbered items of the section that describes
  // what the unit suite checks. The count is taken from THAT section
  // only: the negative-control section has its own numbered list, and
  // counting every numbered item in the file would mix the two.
  const section = /## 1\. UT が何を確認しているか([\s\S]*?)\n## /.exec(readme)?.[1] ?? '';
  const claimed = /の (\d+) 例は (\d+) 群/.exec(readme);
  const groups = (section.match(/^\d+\. \*\*/gm) ?? []).length;
  check('the README claims the number of groups it lists',
    claimed !== null && Number(claimed[2]) === groups,
    `the README lists ${groups} groups and claims ${claimed?.[2] ?? 'none'}`);
}

console.log('');
if (failures === 0) {
  console.log('RESULT: OK -- the README step count, log table and suite counts are the committed ones');
} else {
  console.log(`RESULT: FAIL -- ${failures} mismatch(es) between the README and the committed logs`);
  process.exitCode = 1;
}
