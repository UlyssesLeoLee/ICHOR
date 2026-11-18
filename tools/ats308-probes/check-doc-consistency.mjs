#!/usr/bin/env node
/**
 * ATS-308 -- the measured figures the documents quote, CHECKED against the
 * committed evidence logs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first ATS-308 delivery measured the design baseline and wrote the
 * figures into three places by hand:
 *
 *   * `docs/35-DESIGN-IMPORT.md` (the design document);
 *   * `docs/evidence/ATS-308/README.md` (the evidence index);
 *   * `tools/update_wbs_ats308.py` (the note it writes into the workbook).
 *
 * A number typed in prose is a number that can disagree with the thing it
 * describes. The baseline grew (other tickets added documents to `docs/`),
 * the committed probe log was re-measured, and the prose kept quoting the
 * OLD numbers: 43 documents / 1058 resolved / 1205 references, while the
 * tree now measures 57 documents / 1066 resolved / 1214 references. A reader
 * could not tell which was true.
 *
 * So the check lives in CODE. It reads the COMMITTED logs -- the probe log
 * and the three suite logs -- and compares every figure the documents quote
 * against them. A mismatch FAILS.
 *
 * The design document's §9.1 breakdown of the 41 broken references is a
 * classification made by a human reading the probe log; the count of the
 * broken references themselves IS checked (it is a number the log carries).
 *
 * WHAT IS CHECKED
 * ---------------
 *   1. the probe log's per-verdict counts vs. the design document's §9 table;
 *   2. the probe log's per-verdict counts vs. the evidence README's table;
 *   3. the probe log's resolved-reference count vs. the number the design
 *      document and the README quote as "every resolved reference names a
 *      file that exists";
 *   4. the probe log's design/asset material counts vs. the counts the
 *      design document and the README quote;
 *   5. the suite logs' case counts vs. the counts the README quotes;
 *   6. the README's log table vs. the logs actually committed;
 *   7. the design document's §9.1 broken-reference breakdown vs. the broken
 *      tokens the probe log lists (the sum of the breakdown must be the
 *      broken count);
 *   8. the workbook note the updater writes (the NOTE template) vs. the
 *      same figures -- so the cell cannot drift away from the logs either;
 *   9. the "Markdown リンクは 0 本" claim: the design document says the
 *      repository writes paths as inline code and uses no Markdown links.
 *      That is a claim about the tree, so it is checked against the tree.
 *
 * Run: node tools/ats308-probes/check-doc-consistency.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const evidenceDir = path.join(root, 'docs', 'evidence', 'ATS-308');
const readmePath = path.join(evidenceDir, 'README.md');
const designPath = path.join(root, 'docs', '35-DESIGN-IMPORT.md');
const indexPath = path.join(root, 'docs', '00-INDEX.md');
const updaterPath = path.join(root, 'tools', 'update_wbs_ats308.py');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

console.log('=== ATS-308: the figures the documents quote vs the committed logs ===');

for (const [label, p] of [
  ['the evidence README', readmePath],
  ['the design document', designPath],
  ['the index document', indexPath],
  ['the WBS updater', updaterPath],
]) {
  if (!fs.existsSync(p)) {
    console.log(`RESULT: FAIL -- ${label} does not exist (${path.relative(root, p)})`);
    process.exit(1);
  }
}

const readme = fs.readFileSync(readmePath, 'utf8');
const design = fs.readFileSync(designPath, 'utf8');
const index = fs.readFileSync(indexPath, 'utf8');
const updater = fs.readFileSync(updaterPath, 'utf8');

// --- the probe log is the authority on the measured figures ----------------
const probePath = path.join(evidenceDir, '04-probe-design-import.log');
if (!fs.existsSync(probePath)) {
  console.log('RESULT: FAIL -- the probe log is not committed');
  process.exit(1);
}
const probe = fs.readFileSync(probePath, 'utf8');

function probeCount(kind) {
  const m = new RegExp(`^\\s*${kind}\\s*:\\s*(\\d+)\\s*$`, 'm').exec(probe);
  return m ? m[1] : null;
}
const resolved = probeCount('resolved');
const ambiguous = probeCount('ambiguous');
const runtime = probeCount('runtime');
const external = probeCount('external');
const broken = probeCount('broken');
const total = probeCount('TOTAL');

check('the probe log carries every per-verdict count',
  resolved && ambiguous && runtime && external && broken && total,
  `resolved=${resolved} ambiguous=${ambiguous} runtime=${runtime} external=${external} broken=${broken} TOTAL=${total}`);

// The design materials: the log prints them as "design : N" / "asset : N".
function materialCount(kind) {
  const m = new RegExp(`^\\s*${kind}\\s*:\\s*(\\d+)\\s*$`, 'm').exec(probe);
  return m ? m[1] : null;
}
const designDocs = materialCount('design');
const assets = materialCount('asset');

check('the probe log carries the material counts',
  designDocs && assets,
  `design=${designDocs} asset=${assets}`);

// The self-check line: "RESULT: OK -- N resolved references all name files
// that exist."
const selfCheck = /RESULT: OK -- (\d+) resolved references all name files that exist\./.exec(probe);
const selfChecked = selfCheck ? selfCheck[1] : null;
check('the probe log carries its self-check count',
  selfChecked !== null && selfChecked === resolved,
  `the log says ${selfChecked ?? 'none'}, the resolved count is ${resolved}`);

// --- 1/2. the per-verdict table in the design document and in the README ----
// The design document's §9 table is a Markdown table of
//   | `resolved` | 1058 |
// The README's table is a fenced block of
//   resolved      : 1058
const figures = [
  ['resolved', resolved],
  ['ambiguous', ambiguous],
  ['runtime', runtime],
  ['external', external],
  ['broken', broken],
];

// The §9 table row looks like:  | `resolved` | 1058 |
// The backtick is a REGEX metacharacter only in the sense that it is not
// special -- but it IS special inside a template literal, so the pattern is
// built from a plain string rather than interpolated into a backtick
// template (where ` would end the literal).
for (const [kind, value] of figures) {
  if (!value) continue;
  const docRow = new RegExp('\\|\\s*`' + kind + '`\\s*\\|[^|]*?' + value + '[^|]*\\|').test(design);
  check(`the design document's \`${kind}\` row is the probe log's ${value}`,
    docRow,
    `the §9 table has no \`${kind}\` row carrying ${value}`);

  const readmeLine = new RegExp('^' + kind + '\\s*:\\s*' + value + '\\s*$', 'm').test(readme);
  check(`the evidence README's \`${kind}\` line is the probe log's ${value}`,
    readmeLine,
    `the README's block has no \`${kind}: ${value}\` line`);
}

if (total) {
  check('the design document states the probe log\'s total',
    new RegExp(`\\*\\*合計（参照総数）\\*\\*\\s*\\|\\s*\\*\\*${total}\\*\\*`).test(design),
    `the §9 table's total is not ${total}`);
  check('the evidence README states the probe log\'s total',
    new RegExp(`^TOTAL\\s*:\\s*${total}\\s*$`, 'm').test(readme),
    `the README's block has no \`TOTAL: ${total}\``);
}

// --- 3. the "every resolved reference names a file that exists" quote -------
if (resolved) {
  check('the design document quotes the probe log\'s self-check count',
    new RegExp(`全\\s*${resolved}\\s*参照`).test(design),
    `the document does not say 「全 ${resolved} 参照」`);
  check('the evidence README quotes the probe log\'s self-check count',
    new RegExp(`全\\s*${resolved}\\s*参照`).test(readme),
    `the README does not say 「全 ${resolved} 参照」`);
  check('the evidence README quotes the probe log\'s RESULT line',
    readme.includes(`RESULT: OK -- ${resolved} resolved references all name files that exist.`),
    `the README does not carry \`RESULT: OK -- ${resolved} resolved references ...\``);
}

// --- 4. the material counts the documents quote -----------------------------
// The documents say how many documents the baseline holds. The number is
// written in prose in three languages, so it is matched as a NUMBER rather
// than as a phrase: the claim is "N documents + M tracking assets".
if (designDocs) {
  check('the design document states the probe log\'s design document count',
    new RegExp(`${designDocs}\\s*(文書|文書\\+|文档|份)`).test(design),
    `the document does not mention ${designDocs} documents`);
  check('the evidence README states the probe log\'s design document count',
    new RegExp(`${designDocs}\\s*(文書|文档|份)`).test(readme),
    `the README does not mention ${designDocs} documents`);
  check('the index document states the probe log\'s design document count',
    new RegExp(`${designDocs}\\s*(文書|文档|份)`).test(index),
    `the index does not mention ${designDocs} documents`);
}
if (assets) {
  check('the design document states the probe log\'s tracking asset count',
    new RegExp(`追跡資産\\s*${assets}`).test(design)
    || new RegExp(`${assets}\\s*個`).test(design),
    `the document does not mention ${assets} tracking assets`);
}

// --- 5. the suite counts the README quotes ----------------------------------
// The README has ONE ROW PER SUITE, and each row names its own log. The
// claim is read from THAT ROW -- not from the first `tests N / pass N /
// fail N` in the file, which would be the UT row for every suite.
const readmeRows = new Map();
for (const line of readme.split('\n')) {
  const m = /^\|\s*`([0-9]{2}-[^`]+\.log)`\s*\|.*$/.exec(line);
  if (m) readmeRows.set(m[1], line);
}

for (const [label, file] of [
  ['UT', '01-node-test-import-ut.log'],
  ['IT', '02-node-test-import-it.log'],
  ['negative control', '03-node-test-import-mutation.log'],
]) {
  const logPath = path.join(evidenceDir, file);
  if (!fs.existsSync(logPath)) {
    check(`the ${label} suite log is committed`, false, `missing ${file}`);
    continue;
  }
  const log = fs.readFileSync(logPath, 'utf8');
  const logCounts = /ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(log);
  const row = readmeRows.get(file);
  const claimed = row ? /tests\s+(\d+)\s*\/\s*pass\s+(\d+)\s*\/\s*fail\s+(\d+)/.exec(row) : null;
  if (!logCounts) {
    check(`the ${label} log carries its summary counts`, false, `no summary in ${file}`);
    continue;
  }
  check(`the README's ${label} counts are the committed log's counts`,
    claimed !== null
    && claimed[1] === logCounts[1]
    && claimed[2] === logCounts[2]
    && claimed[3] === logCounts[3],
    `the log holds ${logCounts[1]}/${logCounts[2]}/${logCounts[3]}, the README claims ${claimed ? claimed.slice(1).join('/') : 'none'}`);
}

// --- 6. the README's log table vs the committed logs ------------------------
const committed = fs.readdirSync(evidenceDir).filter((n) => /^[0-9]{2}-.*\.log$/.test(n)).sort();
const named = [...readme.matchAll(/^\| `([0-9]{2}-[^`]+\.log)`/gm)].map((m) => m[1]);
check('the README log table has one row per committed log',
  named.length === committed.length,
  `the directory holds ${committed.length} logs, the table names ${named.length}`);
check('every committed log is named in the README',
  committed.every((n) => named.includes(n)),
  `not named: ${committed.filter((n) => !named.includes(n)).join(', ')}`);
check('every log the README names is committed',
  named.every((n) => committed.includes(n)),
  `named but absent: ${named.filter((n) => !committed.includes(n)).join(', ')}`);

// --- 7. the broken-reference breakdown vs the broken count ------------------
// The §9.1 table splits the broken references into three kinds and states
// how many places each kind accounts for. The sum must be the broken count
// the probe log carries.
if (broken) {
  // The section is matched as a WHOLE (exec()[0]); the pattern has no
  // capture group, so exec()[1] would be undefined.
  const section = /### 9\.1[\s\S]*?(?=### 9\.2)/.exec(design)?.[0] ?? '';
  const kindCounts = [...section.matchAll(/^\|\s*\*\*[^|]+\*\*\s*\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
  const sum = kindCounts.reduce((a, b) => a + b, 0);
  check('the design document\'s §9.1 breakdown sums to the probe log\'s broken count',
    kindCounts.length > 0 && sum === Number(broken),
    `the breakdown lists ${kindCounts.join(' + ')} = ${sum}, the log says ${broken}`);
}

// --- 8. the workbook note vs the same figures -------------------------------
// The updater writes the note into the workbook cell. The note is a
// TEMPLATE whose measured figures are placeholders, filled at write time
// from the committed probe log -- so the source cannot carry the numbers
// itself. What IS checked here is that the template has a placeholder for
// every figure the log carries: a template with no `{resolved}` slot would
// silently drop the number from the workbook note, and a reader of the
// workbook would see a note that no longer states what was measured.
if (resolved && total) {
  for (const [label, slot] of [
    ['the resolved reference count', 'resolved'],
    ['the ambiguous reference count', 'ambiguous'],
    ['the runtime reference count', 'runtime'],
    ['the external reference count', 'external'],
    ['the broken reference count', 'broken'],
    ['the total reference count', 'total'],
    ['the design document count', 'design'],
    ['the tracking asset count', 'asset'],
  ]) {
    check(`the WBS updater's note template carries a slot for ${label}`,
      updater.includes('{' + slot + '}'),
      `the template has no \`{${slot}}\` placeholder`);
  }

  // The STRONGEST form of the check: the cell the updater writes must carry
  // the log's numbers. The 06-wbs-update.log is the committed output of the
  // updater plus the row reader, so the ATS-308 row it prints IS the
  // workbook's own text -- and that text must state the measured figures.
  const wbsLogPath = path.join(evidenceDir, '06-wbs-update.log');
  if (fs.existsSync(wbsLogPath)) {
    const wbsLog = fs.readFileSync(wbsLogPath, 'utf8');
    check('the workbook note the updater wrote states the log\'s total',
      new RegExp('实测\\s*' + total + '\\s*条引用').test(wbsLog),
      `the 06 log does not state \`实测 ${total} 条引用\``);
    check('the workbook note the updater wrote states the log\'s resolved count',
      new RegExp('resolved\\s*' + resolved + '\\s*/').test(wbsLog),
      `the 06 log does not state \`resolved ${resolved} /\``);
    check('the 06 log shows the ATS-308 row, not another task\'s row',
      /ATS-308 row \d+:/.test(wbsLog),
      'the 06 log does not print an ATS-308 row');
  } else {
    check('the WBS updater log is committed', false, 'missing 06-wbs-update.log');
  }
}

// --- 9. the "no Markdown links" claim, checked against the tree --------------
// The design document claims the repository writes paths as inline code and
// uses no Markdown links. That is a claim about the tree, so it is checked
// against the tree -- otherwise it is just an assertion in prose.
{
  const docDir = path.join(root, 'docs');
  const mdFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) mdFiles.push(full);
    }
  };
  walk(docDir);
  const linkRe = /\[[^\]]*\]\([^)]+\)/;
  const withLinks = mdFiles.filter((f) => linkRe.test(fs.readFileSync(f, 'utf8')));
  check('the design document\'s "no Markdown links" claim holds for the tree',
    withLinks.length === 0,
    `these files carry a Markdown link: ${withLinks.map((f) => path.relative(root, f)).join(', ')}`);
}

console.log('');
if (failures === 0) {
  console.log('RESULT: OK -- every figure the documents quote is the committed log\'s figure.');
} else {
  console.log(`RESULT: FAIL -- ${failures} mismatch(es) between the documents and the committed logs`);
  process.exitCode = 1;
}
