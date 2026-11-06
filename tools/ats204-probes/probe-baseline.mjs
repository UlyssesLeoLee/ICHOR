// ATS-204 baseline probe: what does the CURRENT tree do when a case's file
// or title changes, and when a parameterised case renders a different title?
//
// Usage: node tools/ats204-probes/probe-baseline.mjs
//
// The probe MEASURES the current behaviour. It prints what it finds; it does
// not assert a desired behaviour (that is what the implementation will do).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const { discoverStatic } = await import(pathToFileURL(path.join(ROOT, 'server/core.mjs')).href);
const { emptyRegistry } = await import(pathToFileURL(path.join(ROOT, 'server/uid.mjs')).href);

const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ats204-baseline-'));
const projectRoot = path.join(scratch, 'proj');
fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
const project = { id: 'proj_1_0123456789abcdef01234567', uid: 'proj_1_0123456789abcdef01234567', root: projectRoot };

const write = (rel, content) => {
  const full = path.join(projectRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
};
const rm = (rel) => fs.rmSync(path.join(projectRoot, rel), { force: true, recursive: true });

const show = (label, cat) => {
  console.log(`-- ${label}`);
  for (const t of cat.tests) {
    console.log(`   uid=${t.uid} source=${t.uidSource} stable=${t.uidStable} file=${t.file} line=${t.line} title=${JSON.stringify(t.title)} ambiguity=${t.ambiguity ? t.ambiguity.reason : '-'}`);
  }
};

/* ---------------------------------------------------------------- */
/* S1: the file is renamed, the body is unchanged                    */
/* ---------------------------------------------------------------- */
console.log('=== S1: file rename, body unchanged ===');
write('tests/login.spec.ts', "test('login works', async () => { await page.click('#go'); });\n");
let reg = emptyRegistry();
let cat = discoverStatic(project, reg);
show('before rename', cat);
const uidBefore = cat.tests[0].uid;
rm('tests/login.spec.ts');
write('tests/auth/login.spec.ts', "test('login works', async () => { await page.click('#go'); });\n");
cat = discoverStatic(project, cat.registry);
show('after rename', cat);
console.log(`   uid stable across rename: ${cat.tests[0].uid === uidBefore}`);

/* ---------------------------------------------------------------- */
/* S2: the title is rewritten, the body is unchanged                */
/* ---------------------------------------------------------------- */
console.log('=== S2: retitle, body unchanged ===');
rm('tests/auth/login.spec.ts');
write('tests/login.spec.ts', "test('login works', async () => { await page.click('#go'); });\n");
cat = discoverStatic(project, emptyRegistry());
const uid2 = cat.tests[0].uid;
write('tests/login.spec.ts', "test('login flow works', async () => { await page.click('#go'); });\n");
cat = discoverStatic(project, cat.registry);
show('after retitle', cat);
console.log(`   uid stable across retitle: ${cat.tests[0].uid === uid2}`);

/* ---------------------------------------------------------------- */
/* S3: rename + retitle                                             */
/* ---------------------------------------------------------------- */
console.log('=== S3: rename + retitle ===');
rm('tests/login.spec.ts');
write('tests/auth/login.spec.ts', "test('login works', async () => { await page.click('#go'); });\n");
cat = discoverStatic(project, emptyRegistry());
const uid3 = cat.tests[0].uid;
write('tests/auth/login.spec.ts', "test('login flow works', async () => { await page.click('#go'); });\n");
cat = discoverStatic(project, cat.registry);
show('after rename+retitle', cat);
console.log(`   uid stable across rename+retitle: ${cat.tests[0].uid === uid3}`);

/* ---------------------------------------------------------------- */
/* S4: the OLD file name is taken over by a DIFFERENT case          */
/* ---------------------------------------------------------------- */
console.log('=== S4: the old file name is reused by a different case ===');
rm('tests/auth/login.spec.ts');
write('tests/login.spec.ts', "test('login works', async () => { await page.click('#go'); });\n");
cat = discoverStatic(project, emptyRegistry());
const uid4 = cat.tests[0].uid;
rm('tests/login.spec.ts');
write('tests/auth/login.spec.ts', "test('login works', async () => { await page.click('#go'); });\n");
cat = discoverStatic(project, cat.registry);
const uid4b = cat.tests[0].uid;
rm('tests/auth/login.spec.ts');
write('tests/login.spec.ts', "test('a different case entirely', async () => { await page.click('#x'); });\n");
cat = discoverStatic(project, cat.registry);
show('after the old name is reused', cat);
console.log(`   the new case in the old file kept uid ${uid4}? ${cat.tests[0].uid === uid4}`);
console.log(`   (uid4=${uid4} uid4b=${uid4b})`);

/* ---------------------------------------------------------------- */
/* S5: the parameterised title TEMPLATE vs the RENDERED title        */
/* ---------------------------------------------------------------- */
console.log('=== S5: test.each template vs rendered title ===');
rm('tests/login.spec.ts');
write('tests/each.spec.ts', "test.each([1, 2])('adds %i items', async (n) => { expect(n).toBeGreaterThan(0); });\n");
cat = discoverStatic(project, emptyRegistry());
show('static index of a parameterised case', cat);

fs.rmSync(scratch, { recursive: true, force: true });
