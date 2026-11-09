#!/usr/bin/env node
/**
 * ATS-204: the ANCHOR -- a dynamic case keeps its uid when the template
 * it was generated from is re-worded.
 *
 * The template's text changed, so EVERY rendered title changed with it, and
 * the title was the only thing that used to identify the case. The anchor
 * (the position + the ordinal) is what recognises it.
 *
 * Usage: node tools/ats204-probes/probe-anchor.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const { resolveAuthoritativeIdentities } = await import(pathToFileURL(path.join(ROOT, 'server/discovery/authoritative.mjs')).href);

const projectUid = 'proj_1_0123456789abcdef01234567';

/* Two renders of ONE template: the same position, the same describe path,
 * two titles. The static scanner cannot see them (no body), so they are
 * DYNAMIC cases. */
const renders = (suffix) => ([
  { file: 'tests/dyn.spec.ts', title: `adds 1 item${suffix}`, line: 7, column: 3, describePath: [], projects: [], tags: [] },
  { file: 'tests/dyn.spec.ts', title: `adds 2 items${suffix}`, line: 7, column: 3, describePath: [], projects: [], tags: [] },
]);

console.log('=== 1. the first discovery ===');
const first = resolveAuthoritativeIdentities({
  projectUid, cases: renders(''), bodies: new Map(), registry: { version: 1, entries: [] },
});
for (const it of first.items) {
  console.log(`  uid=${it.uid} source=${it.uidSource} basis=${it.basis} title=${JSON.stringify(it.title)}`);
}
console.log(`  the registry carries the anchor: ${first.registry.entries.every((e) => e.anchor && e.anchor.kind === 'position')}`);
console.log(`  the anchors: ${JSON.stringify(first.registry.entries.map((e) => e.anchor))}`);

console.log('=== 2. the template is re-worded: every rendered title changes ===');
const second = resolveAuthoritativeIdentities({
  projectUid, cases: renders(' to the cart'), bodies: new Map(), registry: first.registry,
});
for (const it of second.items) {
  console.log(`  uid=${it.uid} source=${it.uidSource} basis=${it.basis} title=${JSON.stringify(it.title)}`);
}
const before = first.items.map((i) => i.uid);
const after = second.items.map((i) => i.uid);
console.log(`  the uids survived the re-wording: ${JSON.stringify(before) === JSON.stringify(after)}`);

console.log('=== 3. the template GAINS a render: the ordinals may have shifted ===');
const three = [
  { file: 'tests/dyn.spec.ts', title: 'adds 0 items', line: 7, column: 3, describePath: [], projects: [], tags: [] },
  { file: 'tests/dyn.spec.ts', title: 'adds 1 item to the cart', line: 7, column: 3, describePath: [], projects: [], tags: [] },
  { file: 'tests/dyn.spec.ts', title: 'adds 2 items to the cart', line: 7, column: 3, describePath: [], projects: [], tags: [] },
];
const third = resolveAuthoritativeIdentities({
  projectUid, cases: three, bodies: new Map(), registry: first.registry,
});
for (const it of third.items) {
  console.log(`  uid=${it.uid} source=${it.uidSource} basis=${it.basis} title=${JSON.stringify(it.title)} ambiguity=${it.ambiguity ? it.ambiguity.reason : '-'}`);
}
console.log('  (the shift is reported, not guessed: the ordinal of a render may now name a different one)');
