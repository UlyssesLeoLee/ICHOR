#!/usr/bin/env node
/**
 * ATS-308 probe: the design import over the REAL repository, with the
 * per-verdict breakdown.
 *
 * The probe is the reproducible source of the numbers the design document
 * (`docs/35-DESIGN-IMPORT.md`) quotes. It prints:
 *
 *   * the per-verdict counts;
 *   * the broken references, grouped by token, with the places that name
 *     them and the document each belongs to;
 *   * the ambiguous references, with their candidates;
 *   * a SELF-CHECK: every reference that resolved names a file that
 *     really exists.
 *
 * WHAT THE BASELINE EXCLUDES, AND WHY IT IS WRITTEN THIS WAY
 * ----------------------------------------------------------
 * The baseline is the platform's OWN design material. Two kinds of document
 * are NOT part of it:
 *
 *   * the design document this ticket wrote (`docs/35-DESIGN-IMPORT.md`);
 *   * this ticket's evidence index (`docs/evidence/ATS-308/README.md`).
 *
 * Both are documents THIS ticket added, so they are not the baseline it
 * measures -- and that is not only a semantic point. If a ticket's own
 * artifacts were part of the measurement, then EDITING the ticket would
 * move the number the ticket reports: the README names `show-wbs-row.py`,
 * which exists twice in the tree, so the README alone adds one AMBIGUOUS
 * reference and one design document. The figure would then depend on the
 * text of the document that quotes the figure.
 *
 * Excluding both makes the measurement a function of the rest of the tree
 * alone: editing this ticket's documents cannot change the number the
 * ticket reports. (Verified: excluding the design document alone gives
 * 57 design documents / 15 ambiguous; excluding both gives 56 / 14.)
 *
 * The exclusion is therefore a DEFAULT, not a flag the caller must remember
 * to pass. `--exclude <rel>` still exists and ADDS to the default list, for
 * the case where another ticket's document must be left out of a run.
 *
 * The log records the exclusion list, so a reader can see what was left out
 * of the baseline that produced the numbers.
 *
 * Usage: node tools/ats308-probes/probe-design-import.mjs [--exclude rel]...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importDesignMaterials, REFERENCE_KIND } from '../../server/import/design-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

// The documents this ticket added: they are not the baseline they measure.
const DEFAULT_EXCLUDE = [
  'docs/35-DESIGN-IMPORT.md',
  'docs/evidence/ATS-308/README.md',
];

const args = process.argv.slice(2);
const exclude = [...DEFAULT_EXCLUDE];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--exclude') exclude.push(args[i + 1]);
}

console.log('=== ATS-308 probe: the design import over the real repository ===');
console.log(`repo root : ${ROOT}`);
console.log(`excluded  : ${exclude.length ? exclude.join(', ') : '(none)'}`);
console.log('');

const result = importDesignMaterials({ root: ROOT });

// The references of the excluded documents are dropped from the counts.
const kept = result.references.filter((r) => !exclude.includes(r.from));
const byKind = {};
for (const r of kept) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

console.log('--- per-verdict counts ---');
for (const kind of Object.values(REFERENCE_KIND)) {
  console.log(`  ${kind.padEnd(14)}: ${byKind[kind] ?? 0}`);
}
console.log(`  ${'TOTAL'.padEnd(14)}: ${kept.length}`);
console.log('');

const group = (kind) => {
  const map = new Map();
  for (const r of kept) {
    if (r.kind !== kind) continue;
    if (!map.has(r.token)) map.set(r.token, []);
    map.get(r.token).push(r);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
};

console.log(`--- broken references (${byKind[REFERENCE_KIND.BROKEN] ?? 0} occurrences) ---`);
for (const [token, refs] of group(REFERENCE_KIND.BROKEN)) {
  const docs = [...new Set(refs.map((r) => r.from))];
  console.log(`  ${String(refs.length).padStart(3)}x ${token}  <- ${docs.join(', ')}`);
}
console.log('');

console.log(`--- ambiguous references (${byKind[REFERENCE_KIND.AMBIGUOUS] ?? 0} occurrences) ---`);
for (const [token, refs] of group(REFERENCE_KIND.AMBIGUOUS)) {
  console.log(`  ${String(refs.length).padStart(3)}x ${token}  (${refs[0].candidates.length} candidates)`);
  for (const c of refs[0].candidates) console.log(`         ${c}`);
}
console.log('');

console.log(`--- external references (${byKind[REFERENCE_KIND.EXTERNAL] ?? 0} occurrences) ---`);
for (const [token, refs] of group(REFERENCE_KIND.EXTERNAL)) {
  console.log(`  ${String(refs.length).padStart(3)}x ${token}  <- ${[...new Set(refs.map((r) => r.from))].join(', ')}`);
}
console.log('');

console.log(`--- runtime references (${byKind[REFERENCE_KIND.RUNTIME] ?? 0} occurrences) ---`);
for (const [token, refs] of group(REFERENCE_KIND.RUNTIME)) {
  console.log(`  ${String(refs.length).padStart(3)}x ${token}`);
}
console.log('');

// --- the self-check ---------------------------------------------------------
// EVERY resolved reference must name a file that really exists. The
// importer must not resolve a reference it cannot back with a file.
let checked = 0;
const missing = [];
for (const r of kept) {
  if (r.kind !== REFERENCE_KIND.RESOLVED) continue;
  checked++;
  for (const candidate of r.candidates) {
    if (!fs.existsSync(path.join(ROOT, candidate))) missing.push(`${r.from}:${r.line} ${r.token} -> ${candidate}`);
  }
}
console.log('--- self-check: every resolved reference names a file that exists ---');
console.log(`  resolved references checked : ${checked}`);
console.log(`  candidates that do not exist: ${missing.length}`);
for (const m of missing.slice(0, 20)) console.log(`    ${m}`);
console.log('');

// --- the material list ------------------------------------------------------
const byKindMaterial = {};
for (const m of result.materials) {
  if (exclude.includes(m.rel)) continue;
  byKindMaterial[m.kind] = (byKindMaterial[m.kind] ?? 0) + 1;
}
console.log('--- materials ---');
for (const [kind, count] of Object.entries(byKindMaterial)) {
  console.log(`  ${kind.padEnd(14)}: ${count}`);
}
console.log('');

if (missing.length) {
  console.log('RESULT: MISMATCH -- a resolved reference names a file that does not exist.');
  process.exitCode = 1;
} else {
  console.log(`RESULT: OK -- ${checked} resolved references all name files that exist.`);
}
