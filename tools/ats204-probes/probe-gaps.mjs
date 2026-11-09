#!/usr/bin/env node
/**
 * ATS-204: the gaps this task closes, MEASURED on the current tree.
 *
 * The probe prints what the CURRENT code does. It does not assert the
 * desired behaviour -- that is what the implementation does.
 *
 * Usage: node tools/ats204-probes/probe-gaps.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const { discoverStatic } = await import(pathToFileURL(path.join(ROOT, 'server/core.mjs')).href);
const { emptyRegistry, findTestUid } = await import(pathToFileURL(path.join(ROOT, 'server/uid.mjs')).href);
const { attemptsForRun } = await import(pathToFileURL(path.join(ROOT, 'server/execution/model.mjs')).href);

const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ats204-gaps-'));
const projectRoot = path.join(scratch, 'proj');
fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
const projectUid = 'proj_1_0123456789abcdef01234567';
const project = { id: projectUid, uid: projectUid, root: projectRoot };

const write = (rel, content) => {
  const full = path.join(projectRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
};
const rm = (rel) => fs.rmSync(path.join(projectRoot, rel), { force: true, recursive: true });
const run = (label, summary) => {
  const attempts = attemptsForRun({ uid: 'run_1_eeeeeeeeeeeeeeeeeeeeeeee', projectUid, projectRoot }, summary, cat.registry);
  console.log(`  ${label}: testUid=${attempts[0].testUid} basis=${attempts[0].uidBasis}`);
  return attempts[0];
};

/* ------------------------------------------------------------------ */
/* G1: a run whose report names a file the registry does not know      */
/*    (the case was renamed AFTER the last catalogue was opened)        */
/* ------------------------------------------------------------------ */
console.log('=== G1: the run happens BEFORE the catalogue was re-opened ===');
write('tests/login.spec.ts', "test('login works', async () => { await 1; });\n");
let cat = discoverStatic(project, emptyRegistry());
const uid = cat.tests[0].uid;
console.log(`  the case has uid ${uid} (the registry remembers tests/login.spec.ts)`);

// The file is renamed. The registry still says the OLD name -- the
// catalogue has not been re-opened since.
rm('tests/login.spec.ts');
write('tests/auth/login.spec.ts', "test('login works', async () => { await 1; });\n");
const att = run('the attempt of the renamed file', {
  rootDir: path.join(projectRoot, 'tests').replace(/\\/g, '/'),
  cases: [{ title: 'login works', file: 'auth/login.spec.ts', line: 1, status: 'expected', duration: 1, retry: 0 }],
});
console.log(`  GAP? the attempt is unbound although the registry knows the case under its OLD name: ${att.testUid === null}`);

/* ------------------------------------------------------------------ */
/* G2: the same, but the title changed too                             */
/* ------------------------------------------------------------------ */
console.log('=== G2: the run happens BEFORE the catalogue was re-opened, with a retitle ===');
rm('tests/auth/login.spec.ts');
write('tests/login.spec.ts', "test('login works', async () => { await 1; });\n");
cat = discoverStatic(project, emptyRegistry());
const uid2 = cat.tests[0].uid;
rm('tests/login.spec.ts');
write('tests/auth/login.spec.ts', "test('login flow works', async () => { await 1; });\n");
const att2 = run('the attempt of the renamed+retitled file', {
  rootDir: path.join(projectRoot, 'tests').replace(/\\/g, '/'),
  cases: [{ title: 'login flow works', file: 'auth/login.spec.ts', line: 1, status: 'expected', duration: 1, retry: 0 }],
});
console.log(`  GAP? the attempt is unbound: ${att2.testUid === null}`);

/* ------------------------------------------------------------------ */
/* G3: the case was deleted and its file name was reused              */
/* ------------------------------------------------------------------ */
console.log('=== G3: the old file name is reused by a DIFFERENT case ===');
rm('tests/auth/login.spec.ts');
write('tests/login.spec.ts', "test('login works', async () => { await 1; });\n");
cat = discoverStatic(project, emptyRegistry());
const uid3 = cat.tests[0].uid;
console.log(`  the original case has uid ${uid3}`);
// The original is deleted, and a DIFFERENT case takes its file name. The
// registry still remembers the original under that name.
rm('tests/login.spec.ts');
write('tests/login.spec.ts', "test('a different case', async () => { await 2; });\n");
const att3 = run('the attempt of the new case in the old file', {
  rootDir: path.join(projectRoot, 'tests').replace(/\\/g, '/'),
  cases: [{ title: 'a different case', file: 'login.spec.ts', line: 1, status: 'expected', duration: 1, retry: 0 }],
});
console.log(`  the new case was bound to the OLD case's uid: ${att3.testUid === uid3}`);
console.log(`  GAP? the new case inherited the old case's uid: ${att3.testUid === uid3}`);

/* ------------------------------------------------------------------ */
/* G4: the alias is recorded -- is it ever USED?                       */
/* ------------------------------------------------------------------ */
console.log('=== G4: are the recorded aliases ever used by a lookup? ===');
rm('tests/login.spec.ts');
write('tests/login.spec.ts', "test('login works', async () => { await 1; });\n");
cat = discoverStatic(project, emptyRegistry());
rm('tests/login.spec.ts');
write('tests/auth/login.spec.ts', "test('login works', async () => { await 1; });\n");
cat = discoverStatic(project, cat.registry);
const e4 = cat.registry.projects[projectUid].entries[0];
console.log(`  the entry records aliases=${JSON.stringify(e4.aliases)}`);
const byOld = findTestUid(cat.registry, projectUid, { file: 'tests/login.spec.ts', title: 'login works', line: 1 });
console.log(`  a lookup under the OLD spelling: uid=${byOld.uid} basis=${byOld.basis}`);
console.log(`  GAP? the alias is never consulted by the lookup: ${byOld.basis !== 'alias'}`);

/* ------------------------------------------------------------------ */
/* G5: the static index of a loop-generated case                       */
/* ------------------------------------------------------------------ */
console.log('=== G5: the static index of a loop-generated case ===');
rm('tests/auth/login.spec.ts');
write('tests/dyn.spec.ts', "for (const n of [1, 2]) {\n  test(`adds ${n} items`, async () => { expect(n).toBeGreaterThan(0); });\n}\n");
cat = discoverStatic(project, emptyRegistry());
console.log(`  the static index reports ${cat.tests.length} case(s):`);
for (const t of cat.tests) {
  console.log(`    uid=${t.uid} line=${t.line} title=${JSON.stringify(t.title)} source=${t.uidSource}`);
}
console.log('  (the CLI reports TWO cases here: "adds 1 items" and "adds 2 items")');
console.log(`  GAP? the static index invents a case the CLI does not report: ${cat.tests.length === 1}`);

fs.rmSync(scratch, { recursive: true, force: true });
