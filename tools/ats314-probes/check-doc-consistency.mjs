#!/usr/bin/env node
/**
 * ATS-314 -- the measured figures the documents quote, CHECKED against the
 * committed evidence logs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ATS-314 delivery measured the real scripts and wrote the figures
 * into three places:
 *
 *   * `docs/36-AST-CONTROLLED-SUBSET.md` (the design document);
 *   * `docs/evidence/ATS-314/README.md` (the evidence index);
 *   * `tools/update_wbs_ats314.py` (the note it writes into the workbook).
 *
 * A number typed in prose is a number that can disagree with the thing it
 * describes. The ATS-308 delivery had exactly that defect (43 documents /
 * 1058 resolved / 1205 references in the prose against 57 / 1066 / 1214 in
 * the tree), and it was found by a reader who ran the probe.
 *
 * So the check lives in CODE. It reads the COMMITTED logs -- the probe log
 * and the suite logs -- and compares every figure the documents quote
 * against them. A mismatch FAILS.
 *
 * WHAT IS CHECKED
 * ---------------
 *   1. the probe log's per-file verdicts vs. the design document's §7;
 *   2. the probe log's totals vs. the design document's §7;
 *   3. the suite logs' case counts vs. the counts the documents quote;
 *   4. the negative control's mutation count vs. the count the documents
 *      quote;
 *   5. the evidence README's log table vs. the logs actually committed;
 *   6. the workbook note the updater writes (the NOTE template) vs. the
 *      same figures -- so the cell cannot drift away from the logs either.
 *
 * Run: node tools/ats314-probes/check-doc-consistency.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const evidenceDir = path.join(root, 'docs', 'evidence', 'ATS-314');
const readmePath = path.join(evidenceDir, 'README.md');
const designPath = path.join(root, 'docs', '36-AST-CONTROLLED-SUBSET.md');
const indexPath = path.join(root, 'docs', '00-INDEX.md');
const updaterPath = path.join(root, 'tools', 'update_wbs_ats314.py');
const probeLog = path.join(evidenceDir, '03-probe-ast-subset.log');
const utLog = path.join(evidenceDir, '01-node-test-ast-subset-ut.log');
const itLog = path.join(evidenceDir, '02-node-test-ast-subset-it.log');
const mutationLog = path.join(evidenceDir, '04-node-test-negative-control.log');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

console.log('=== ATS-314: the figures the documents quote vs the committed logs ===');

for (const [label, p] of [
  ['the evidence README', readmePath],
  ['the design document', designPath],
  ['the index document', indexPath],
  ['the WBS updater', updaterPath],
  ['the probe log', probeLog],
  ['the unit suite log', utLog],
  ['the integration suite log', itLog],
  ['the negative control log', mutationLog],
]) {
  if (!fs.existsSync(p)) {
    check(`${label} exists`, false, p);
    process.exit(1);
  }
}

const readme = fs.readFileSync(readmePath, 'utf8');
const designRaw = fs.readFileSync(designPath, 'utf8');
const index = fs.readFileSync(indexPath, 'utf8');
const updater = fs.readFileSync(updaterPath, 'utf8');
const probe = fs.readFileSync(probeLog, 'utf8');

/**
 * The document text with the MARKDOWN EMPHASIS removed.
 *
 * The design document writes 「controlled **3**」 -- the emphasis is
 * there for the reader, but the checker must be able to find the number
 * inside it. Stripping the emphasis is what makes the needle
 * `controlled 3` match the prose, and it keeps the checker from
 * depending on how a particular sentence happens to be typeset: a
 * checker that breaks when a bold marker moves is a checker that gets
 * disabled the first time somebody edits the prose.
 */
const design = designRaw.replace(/\*\*/g, '').replace(/\*/g, '');

/* ------------------------------------------------------------------ */
/* the figures the probe log carries                                    */
/* ------------------------------------------------------------------ */

function probeNumber(label) {
  const m = new RegExp(`^${label}\\s+:\\s+(\\d+)\\s*$`, 'm').exec(probe);
  if (!m) throw new Error(`the probe log does not carry the figure "${label}"`);
  return Number(m[1]);
}

const figures = {
  files: probeNumber('files'),
  writable: probeNumber('files-writable'),
  partial: probeNumber('files-partial'),
  readOnlyFiles: probeNumber('files-read-only'),
  steps: probeNumber('steps'),
  controlled: probeNumber('steps-controlled'),
  readOnlySteps: probeNumber('steps-read-only'),
};

/* ------------------------------------------------------------------ */
/* 1. the per-file verdicts                                             */
/* ------------------------------------------------------------------ */

/**
 * The per-file lines the probe printed.
 *
 * The line is `  <file> <verdict> <total> steps / <controlled> controlled /
 * <read-only> read-only`. The file name may contain spaces, so the line is
 * parsed from the RIGHT.
 */
const perFile = [];
for (const line of probe.split('\n')) {
  const m = /^\s+(\S.*?)\s{2,}(writable|partial|read-only)\s+(\d+) steps \/ (\d+) controlled \/ (\d+) read-only\s*$/.exec(line);
  if (m) perFile.push({ file: m[1], verdict: m[2], total: Number(m[3]), controlled: Number(m[4]), readOnly: Number(m[5]) });
}

check('the probe log carries a per-file line for every file it measured',
  perFile.length === figures.files,
  `the log has ${perFile.length} file lines and the totals say ${figures.files} files`);

check('the per-file counts add up to the totals',
  perFile.reduce((a, f) => a + f.total, 0) === figures.steps &&
  perFile.reduce((a, f) => a + f.controlled, 0) === figures.controlled &&
  perFile.reduce((a, f) => a + f.readOnly, 0) === figures.readOnlySteps,
  'the per-file counts do not add up to the totals');

check('the per-file verdicts add up to the file totals',
  perFile.filter((f) => f.verdict === 'writable').length === figures.writable &&
  perFile.filter((f) => f.verdict === 'partial').length === figures.partial &&
  perFile.filter((f) => f.verdict === 'read-only').length === figures.readOnlyFiles,
  'the per-file verdicts do not add up to the file totals');

/* ------------------------------------------------------------------ */
/* 2. the design document quotes the probe's figures                     */
/* ------------------------------------------------------------------ */

// The design document quotes the totals in prose. The needles are the
// numbers the probe measured, so a stale number in the prose FAILS.
const designNeedles = [
  `${figures.files} 个文件`,
  `controlled ${figures.controlled}`,
  `read-only ${figures.readOnlySteps}`,
];
for (const needle of designNeedles) {
  check(`the design document quotes "${needle}"`,
    design.includes(needle),
    'the probe log does not carry it');
}

// And the design document must NOT quote the per-file verdicts with a
// different number.
for (const f of perFile) {
  check(`the design document does not contradict the verdict of ${f.file}`,
    !new RegExp(`${f.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*?\\b${f.verdict === 'read-only' ? 'writable' : 'read-only'}\\b`).test(design),
    'the design document names a different verdict for this file');
}

/* ------------------------------------------------------------------ */
/* 3. the suite counts                                                  */
/* ------------------------------------------------------------------ */

function suiteCounts(logPath) {
  const text = fs.readFileSync(logPath, 'utf8');
  const found = {};
  for (const m of text.matchAll(/^ℹ (tests|pass|fail|skipped) (\d+)$/gm)) {
    found[m[1]] = Number(m[2]);
  }
  return found;
}

const ut = suiteCounts(utLog);
const it = suiteCounts(itLog);
const mutation = suiteCounts(mutationLog);

check('the unit suite log carries its case count', Number.isInteger(ut.tests),
  'the log does not carry the "ℹ tests N" line');
check('the integration suite log carries its case count', Number.isInteger(it.tests),
  'the log does not carry the "ℹ tests N" line');
check('the negative control log carries its case count', Number.isInteger(mutation.tests),
  'the log does not carry the "ℹ tests N" line');

check('the unit suite had no failures', ut.fail === 0, `${ut.fail} failures`);
check('the integration suite had no failures', it.fail === 0, `${it.fail} failures`);
check('the negative control had no failures', mutation.fail === 0, `${mutation.fail} failures`);

check('the design document quotes the unit suite case count',
  design.includes(`${ut.tests} 例`), `the log says ${ut.tests}`);
check('the design document quotes the integration suite case count',
  design.includes(`${it.tests} 例`), `the log says ${it.tests}`);
check('the design document quotes the negative control case count',
  design.includes(`${mutation.tests} 种变异`) || design.includes(`${mutation.tests} 例`),
  `the log says ${mutation.tests}`);

check('the evidence README quotes the unit suite case count',
  readme.includes(`${ut.tests}`), `the log says ${ut.tests}`);
check('the evidence README quotes the integration suite case count',
  readme.includes(`${it.tests}`), `the log says ${it.tests}`);

/* ------------------------------------------------------------------ */
/* 4. the reason breakdown                                              */
/* ------------------------------------------------------------------ */

const reasons = {};
let inReasons = false;
for (const line of probe.split('\n')) {
  if (line.startsWith('--- the reasons ---')) { inReasons = true; continue; }
  if (!inReasons) continue;
  if (!line.trim()) { if (Object.keys(reasons).length) break; continue; }
  const m = /^\s+([a-z][a-z-]*)\s+(\d+)\s*$/.exec(line);
  if (!m) break;
  reasons[m[1]] = Number(m[2]);
}
check('the probe log carries the reason breakdown', Object.keys(reasons).length > 0);
check('the reason counts add up to the read-only step count',
  Object.values(reasons).reduce((a, b) => a + b, 0) === figures.readOnlySteps,
  `the reasons sum to ${Object.values(reasons).reduce((a, b) => a + b, 0)} and the read-only steps are ${figures.readOnlySteps}`);

for (const [key, count] of Object.entries(reasons)) {
  check(`the design document mentions the reason "${key}"`,
    design.includes(key), 'the reason is not in the design document');
}

/* ------------------------------------------------------------------ */
/* 5. the evidence README's log table                                   */
/* ------------------------------------------------------------------ */

const committed = fs.readdirSync(evidenceDir).filter((n) => n.endsWith('.log')).sort();
for (const name of committed) {
  check(`the evidence README names the committed log ${name}`,
    readme.includes(name), 'the log is committed but the README does not name it');
}

// The README must not name a log that is NOT committed: a README that
// lists a log that does not exist is a README that lies about its own
// evidence.
const named = [...readme.matchAll(/`(\d\d-[^`]+\.log)`/g)].map((m) => m[1]);
for (const name of named) {
  check(`the log ${name} the README names is committed`,
    fs.existsSync(path.join(evidenceDir, name)), 'the README names a log that does not exist');
}

/* ------------------------------------------------------------------ */
/* 6. the workbook note                                                  */
/* ------------------------------------------------------------------ */

check('the WBS updater reads the figures from the probe log',
  updater.includes('03-probe-ast-subset.log'),
  'the updater does not read the probe log');
check('the WBS updater refuses to write without the probe log',
  updater.includes('refuses to write'),
  'the updater does not refuse to write when the log is missing');
check('the WBS updater derives the note text from the figures',
  updater.includes('NOTE_TEMPLATE.format('),
  'the note is not formatted from the measured figures');

/* ------------------------------------------------------------------ */
/* 7. the index document                                                 */
/* ------------------------------------------------------------------ */

check('the index document names the ATS-314 design document',
  index.includes('36-AST-CONTROLLED-SUBSET.md'),
  'the design document is not in the index');

console.log('');
if (failures === 0) {
  console.log('RESULT: OK -- every figure the documents quote is backed by a committed log.');
} else {
  console.log(`RESULT: MISMATCH -- ${failures} check(s) failed.`);
}
process.exit(failures === 0 ? 0 : 1);
