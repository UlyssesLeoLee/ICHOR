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
 * `--exclude <rel>` drops one document from the counts (the ATS-308
 * design document itself is not part of the baseline it measures).
 *
 * Usage: node tools/ats308-probes/probe-design-import.mjs [--exclude rel]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importDesignMaterials, REFERENCE_KIND } from '../../server/import/design-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const args = process.argv.slice(2);
const exclude = [];
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
