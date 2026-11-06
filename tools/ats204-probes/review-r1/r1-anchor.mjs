#!/usr/bin/env node
/**
 * ATS-204 review round 1 -- discovery-side anchor counterexamples.
 *
 * Usage: node r1-anchor.mjs <tree-root>
 * Exit 1 when any counterexample still holds (a case is handed ANOTHER
 * case's UID, or an unchanged case loses its UID).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] || '.');
const { resolveAuthoritativeIdentities } = await import(pathToFileURL(path.join(ROOT, 'server/discovery/authoritative.mjs')).href);
let identity = null;
try { identity = await import(pathToFileURL(path.join(ROOT, 'server/identity.mjs')).href); } catch { /* base tree */ }

const projectUid = 'proj_1_0123456789abcdef01234567';
const F = 'tests/x.spec.ts';
const dyn = (title, line = 7, describePath = []) => ({ file: F, title, line, column: 3, describePath, projects: [], tags: [] });
const empty = { version: 1, entries: [] };
const run = (cases, registry, bodies = new Map()) => resolveAuthoritativeIdentities({ projectUid, cases, bodies, registry });
const uidOf = (res, title) => res.items.find((i) => i.title === title)?.uid ?? null;
const show = (res) => res.items.map((i) => `    ${JSON.stringify(i.title)} line=${i.line} uid=${i.uid} basis=${i.basis}${i.ambiguity ? ' ambiguity=' + i.ambiguity.reason : ''}`).join('\n');

let failed = 0;
const verdict = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (detail) console.log(detail);
};

/* P1: loop data reordered -- titles unchanged, order swapped. */
{
  const r1 = run([dyn('adds 1 item'), dyn('adds 2 items')], empty);
  const r2 = run([dyn('adds 2 items'), dyn('adds 1 item')], r1.registry);
  const ok = uidOf(r2, 'adds 1 item') === uidOf(r1, 'adds 1 item') && uidOf(r2, 'adds 2 items') === uidOf(r1, 'adds 2 items');
  verdict('P1  reordered loop data: each render keeps ITS OWN uid', ok,
    `  before:\n${show(r1)}\n  after reorder:\n${show(r2)}`);
}

/* P1b: one data element replaced, the others untouched. */
{
  const r1 = run([dyn('user alice'), dyn('user bob'), dyn('user carol')], empty);
  const r2 = run([dyn('user alice'), dyn('user dave'), dyn('user carol')], r1.registry);
  const bob = uidOf(r1, 'user bob');
  const ok = uidOf(r2, 'user dave') !== bob;
  verdict('P1b replaced data element: the NEW render (dave) must not inherit the removed render (bob) uid silently', ok,
    `  before:\n${show(r1)}\n  after bob->dave:\n${show(r2)}`);
}

/* P2a: source case A deleted, source case B moves up to A's line with a slightly edited body. */
{
  const b1 = new Map([
    [`${F} 5`, { title: 'login works', bodyText: "{ await page.goto('/login'); }" }],
    [`${F} 10`, { title: 'logout works', bodyText: "{ await page.goto('/logout'); }" }],
  ]);
  const r1 = run([dyn('login works', 5), dyn('logout works', 10)], empty, b1);
  const b2 = new Map([[`${F} 5`, { title: 'logout works', bodyText: "{ await page.goto('/logout'); await expect(page).toHaveURL('/'); }" }]]);
  const r2 = run([dyn('logout works', 5)], r1.registry, b2);
  const ok = uidOf(r2, 'logout works') !== uidOf(r1, 'login works');
  verdict("P2a source case B moved onto deleted A's line (body edited): B must NOT get A's uid", ok,
    `  before:\n${show(r1)}\n  after:\n${show(r2)}`);
}

/* P2b: a NEW source case (new title, new body) written where A was (A deleted). */
{
  const b1 = new Map([[`${F} 5`, { title: 'login works', bodyText: "{ await page.goto('/login'); }" }]]);
  const r1 = run([dyn('login works', 5)], empty, b1);
  const b2 = new Map([[`${F} 5`, { title: 'search finds item', bodyText: "{ await page.fill('#q', 'x'); }" }]]);
  const r2 = run([dyn('search finds item', 5)], r1.registry, b2);
  const ok = uidOf(r2, 'search finds item') !== uidOf(r1, 'login works');
  verdict("P2b new case (new title + new body) on deleted A's line: doc 26 §7 says identity changes", ok,
    `  before:\n${show(r1)}\n  after:\n${show(r2)}`);
}

/* P2c: a NEW source case inserted ABOVE an existing one (the existing one shifts down). */
{
  const b1 = new Map([[`${F} 5`, { title: 'login works', bodyText: "{ await page.goto('/login'); }" }]]);
  const r1 = run([dyn('login works', 5)], empty, b1);
  const b2 = new Map([
    [`${F} 5`, { title: 'search finds item', bodyText: "{ await page.fill('#q', 'x'); }" }],
    [`${F} 9`, { title: 'login works', bodyText: "{ await page.goto('/login'); }" }],
  ]);
  const r2 = run([dyn('search finds item', 5), dyn('login works', 9)], r1.registry, b2);
  const keep = uidOf(r2, 'login works') === uidOf(r1, 'login works');
  const noSteal = uidOf(r2, 'search finds item') !== uidOf(r1, 'login works');
  verdict('P2c insert a new case above an existing one: the existing case keeps its uid AND the new one does not take it', keep && noSteal,
    `  before:\n${show(r1)}\n  after insert above:\n${show(r2)}`);
}

/* P1-mapper: the exported reidentifyRendered (the function doc 26 / UT-014 present). */
if (identity?.reidentifyRendered) {
  const entries = [
    { uid: 'u1', title: 'adds 1 item', anchor: { kind: 'position', file: F, line: 7, scope: [], ordinal: 0, count: 2 } },
    { uid: 'u2', title: 'adds 2 items', anchor: { kind: 'position', file: F, line: 7, scope: [], ordinal: 1, count: 2 } },
  ];
  const cases = [{ file: F, line: 7, scope: [], title: 'adds 2 items' }, { file: F, line: 7, scope: [], title: 'adds 1 item' }];
  const d = identity.reidentifyRendered({ cases, entries });
  const got = cases.map((c) => `${c.title}->${d.get(c)?.uid ?? '(title)'}`).join(', ');
  const ok = d.get(cases[0])?.uid !== 'u1' && d.get(cases[1])?.uid !== 'u2';
  verdict('P1m reidentifyRendered on reordered renders does not swap', ok, `  ${got}`);
}

console.log(`SUMMARY: ${failed} counterexample(s) hold`);
process.exitCode = failed ? 1 : 0;
