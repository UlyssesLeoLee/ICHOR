#!/usr/bin/env node
/**
 * ATS-314 -- the probe over the REAL repository's test scripts.
 *
 * WHAT IT MEASURES
 * ----------------
 * The controlled subset detector classifies the test scripts of THIS
 * repository: how many steps it finds, how many of them are controlled,
 * and WHY the others are refused.
 *
 * The numbers are the ones the design document and the WBS note quote,
 * so they are MEASURED here and READ FROM THE COMMITTED LOG by the
 * updater. A number typed in prose is a number that can disagree with
 * the thing it describes; a number read from the log cannot.
 *
 * THE PROBE EXCLUDES THIS TICKET'S OWN ARTEFACTS
 * ----------------------------------------------
 * The probe skips the files this ticket writes (its own tests, its own
 * probes, its own evidence), because the baseline it describes must not
 * move when this ticket edits its own text. Without that exclusion the
 * numbers would be a function of the ticket's own footprint rather
 * than of the platform's scripts.
 *
 * Usage: node tools/ats314-probes/probe-ast-subset.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { buildReport, formatSubsetReport } from '../../server/edit/ast-subset.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');

/**
 * The directories the probe walks.
 *
 * ONLY the EXAMPLES are walked, and that is a deliberate choice.
 *
 * The platform's own `tests/*.test.mjs` files are `node:test` suites,
 * NOT Playwright scripts: they call `test(...)` from `node:test` and
 * assert with `node:assert`. Measuring them would say nothing about
 * the controlled subset -- there is no `page` in them to draw, and the
 * 15739 `not-whitelisted` refusals they produce are a measurement of
 * the WRONG POPULATION.
 *
 * The population that matters is the PLAYWRIGHT scripts: the ones a
 * user would draw as a flow. In this repository they are the examples
 * (`examples/sample-playwright`, `examples/real-browser-fixture`) and
 * the WebdriverIO ones (`examples/sample-wdio`) -- the latter are
 * measured too, because a WDIO script is not a Playwright script and
 * the detector must refuse it rather than pretend.
 */
const ROOTS = ['examples'];

/**
 * The paths this ticket writes. They are excluded from the measurement.
 *
 * A file that the ticket itself adds would otherwise change the
 * baseline the note quotes, and the note would then be quoting the
 * ticket rather than the platform.
 */
const EXCLUDED = [
  'tools/ats314-probes/',
  'docs/evidence/ATS-314/',
];

/**
 * The files of a directory, deterministically.
 */
function listScripts(dir, rel = '', out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (['node_modules', '.git', 'out', 'dist', 'coverage', '.next'].includes(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listScripts(full, child, out);
    else if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) out.push(child);
  }
  return out;
}

console.log('=== ATS-314: the controlled subset over the real scripts ===');
console.log(`repo root : ${root}`);

const files = [];
for (const r of ROOTS) {
  const base = path.join(root, r);
  if (!fs.existsSync(base)) continue;
  for (const rel of listScripts(base)) {
    const full = `${r}/${rel}`;
    if (EXCLUDED.some((prefix) => full.startsWith(prefix))) continue;
    files.push(full);
  }
}
files.sort();

let totalSteps = 0;
let controlled = 0;
let readOnly = 0;
const reasons = {};
const verdicts = { writable: 0, partial: 0, 'read-only': 0 };
const perFile = [];

for (const rel of files) {
  const report = buildReport(path.join(root, rel));
  totalSteps += report.counts.total;
  controlled += report.counts.controlled;
  readOnly += report.counts.readOnly;
  verdicts[report.editability] = (verdicts[report.editability] ?? 0) + 1;
  for (const [key, value] of Object.entries(report.reasons)) {
    reasons[key] = (reasons[key] ?? 0) + value;
  }
  perFile.push({
    file: rel,
    editability: report.editability,
    total: report.counts.total,
    controlled: report.counts.controlled,
    readOnly: report.counts.readOnly,
  });
}

console.log('');
console.log('--- the files ---');
for (const f of perFile) {
  console.log(`  ${f.file.padEnd(52)} ${f.editability.padEnd(10)} ` +
    `${f.total} steps / ${f.controlled} controlled / ${f.readOnly} read-only`);
}

console.log('');
console.log('--- the totals ---');
// The labels are UNIQUE on purpose. An earlier version printed
// `read-only` twice -- once for the files and once for the steps -- and
// the updater reads the figures with a regex, so it would have taken the
// FILE count for the STEP count. A label that appears twice is a label
// whose meaning is ambiguous.
console.log(`files           : ${files.length}`);
console.log(`files-writable  : ${verdicts.writable ?? 0}`);
console.log(`files-partial   : ${verdicts.partial ?? 0}`);
console.log(`files-read-only : ${verdicts['read-only'] ?? 0}`);
console.log(`steps           : ${totalSteps}`);
console.log(`steps-controlled : ${controlled}`);
console.log(`steps-read-only : ${readOnly}`);

console.log('');
console.log('--- the reasons ---');
for (const key of Object.keys(reasons).sort()) {
  console.log(`  ${key.padEnd(26)} ${reasons[key]}`);
}

// The probe is a MEASUREMENT, and a measurement that finds nothing is
// not evidence: it says either that the tree has no scripts or that the
// detector found no steps at all, and the second is a broken detector.
if (files.length === 0) {
  console.error('');
  console.error('RESULT: MISMATCH -- the probe found no script to measure.');
  process.exit(1);
}
if (totalSteps === 0) {
  console.error('');
  console.error('RESULT: MISMATCH -- the probe found no step at all.');
  process.exit(1);
}
console.log('');
console.log('RESULT: OK -- the probe measured the real scripts.');
