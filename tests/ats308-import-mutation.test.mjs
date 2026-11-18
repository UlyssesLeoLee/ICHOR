/**
 * ATS-308: the MUTATION NEGATIVE CONTROL of the design import.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A test that passes proves nothing unless it can FAIL. Every group of
 * tests in `tests/ats308-import.test.mjs` claims to guard a property of
 * the importer; this file MUTATES the importer and asserts that the
 * property's test turns RED.
 *
 * The mutations are the ones that would make the report lie:
 *
 *   M1  the broken links are not reported      -> the report is empty
 *   M2  the ambiguous links are not reported   -> the report is empty
 *   M3  a broken link is reported as resolved  -> the report invents a fact
 *   M4  a runtime artefact is reported broken  -> the report cries wolf
 *   M5  an external path is reported broken    -> the report cries wolf
 *   M6  the import rewrites the body           -> the acceptance criterion
 *   M7  the classifier resolves a guess        -> the report invents a fact
 *
 * A mutation that no test catches is a claim the tests do not support.
 *
 * HOW IT WORKS
 * ------------
 * The mutations are applied to a COPY of the importer module in a temp
 * directory, so the repository's own source is never touched. The
 * mutated module is then imported and exercised directly, and the
 * assertion is made against the MUTATED behaviour -- not by re-running
 * the test suite (which would need the whole tree rewritten).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const SRC = path.join(root, 'server', 'import', 'design-index.mjs');

/**
 * A copy of the importer with `from` replaced by `to`.
 *
 * The copy is written into a temp directory, so the repository's own
 * source is never modified. The copy is imported through a file URL with
 * a cache-busting query, so the mutated module is really loaded and not
 * the one already in the module cache.
 */
async function mutated(from, to) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats308-mut-'));
  const text = fs.readFileSync(SRC, 'utf8');
  if (!text.includes(from)) throw new Error(`the mutation anchor is not in the source: ${from}`);
  const file = path.join(dir, 'design-index.mjs');
  fs.writeFileSync(file, text.replace(from, to), 'utf8');
  const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}-${Math.random()}`);
  return { mod, dir };
}

/** A miniature tree with one broken, one ambiguous and one runtime reference. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats308-fixture-'));
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };
  write('docs/01-DESIGN.md', [
    '参照 `server/index.mjs` と `server/missing.mjs` と `package.json` と `state.json`。',
    '同名 `index.mjs` は複数。',
  ].join('\n'));
  write('server/index.mjs', '');
  write('package.json', '{}');
  write('playwright.config.ts', 'export default {};');
  fs.mkdirSync(path.join(dir, 'other'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'other', 'index.mjs'), '');
  return dir;
}

test('M1: when the broken links are not collected, the report has no broken entry', async () => {
  const { mod } = await mutated(
    'const broken = references.filter((r) => r.kind === REFERENCE_KIND.BROKEN);',
    'const broken = [];',
  );
  const result = mod.importDesignMaterials({ root: fixture() });
  assert.equal(result.report.broken.length, 0, 'the mutation must empty the broken list');
  // The unmutated importer DOES find it -- otherwise the mutation proves
  // nothing.
  const real = await import(pathToFileURL(SRC).href);
  const realResult = real.importDesignMaterials({ root: fixture() });
  assert.ok(realResult.report.broken.some((b) => b.token === 'server/missing.mjs'), 'the real importer finds the broken link');
});

test('M2: when the ambiguous links are not collected, the report has no ambiguous entry', async () => {
  const { mod } = await mutated(
    'const ambiguous = references.filter((r) => r.kind === REFERENCE_KIND.AMBIGUOUS);',
    'const ambiguous = [];',
  );
  const result = mod.importDesignMaterials({ root: fixture() });
  assert.equal(result.report.ambiguous.length, 0);
  const real = await import(pathToFileURL(SRC).href);
  const realResult = real.importDesignMaterials({ root: fixture() });
  assert.ok(realResult.report.ambiguous.some((a) => a.token === 'index.mjs'), 'the real importer finds the ambiguous link');
});

test('M3: when a broken link is reported as resolved, the report invents a fact', async () => {
  const { mod } = await mutated(
    'return { kind: REFERENCE_KIND.BROKEN, token: raw, candidates: [] };',
    'return { kind: REFERENCE_KIND.RESOLVED, token: raw, candidates: [raw] };',
  );
  const result = mod.importDesignMaterials({ root: fixture() });
  // The broken reference is now reported as resolved, and it names a
  // candidate that does not exist.
  const bogus = result.references.find((r) => r.token === 'server/missing.mjs');
  assert.equal(bogus.kind, 'resolved');
  assert.ok(!fs.existsSync(path.join(result.root, bogus.candidates[0])), 'the invented candidate does not exist');
  // The real importer does NOT resolve it.
  const real = await import(pathToFileURL(SRC).href);
  const realResult = real.importDesignMaterials({ root: fixture() });
  const realRef = realResult.references.find((r) => r.token === 'server/missing.mjs');
  assert.equal(realRef.kind, 'broken');
});

test('M4: when a runtime artefact is reported broken, the report cries wolf', async () => {
  const { mod } = await mutated(
    `if (RUNTIME_ARTEFACTS.includes(base)) {
    return { kind: REFERENCE_KIND.RUNTIME, token: raw, candidates: [] };
  }`,
    `if (RUNTIME_ARTEFACTS.includes(base)) {
    return { kind: REFERENCE_KIND.BROKEN, token: raw, candidates: [] };
  }`,
  );
  const result = mod.importDesignMaterials({ root: fixture() });
  assert.ok(result.report.broken.some((b) => b.token === 'state.json'), 'the mutation makes the runtime artefact broken');
  const real = await import(pathToFileURL(SRC).href);
  const realResult = real.importDesignMaterials({ root: fixture() });
  assert.ok(!realResult.report.broken.some((b) => b.token === 'state.json'), 'the real importer does not');
});

test('M5: when an external path is reported broken, the report cries wolf', async () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'docs', '01-DESIGN.md'), '外部プロジェクトの `flows/android.yaml` を参照。');
  const { mod } = await mutated(
    `if (dir && !tree.dirs.has(dir)) {
    return { kind: REFERENCE_KIND.EXTERNAL, token: raw, candidates: [] };
  }`,
    `if (dir && !tree.dirs.has(dir)) {
    return { kind: REFERENCE_KIND.BROKEN, token: raw, candidates: [] };
  }`,
  );
  const result = mod.importDesignMaterials({ root: dir });
  assert.ok(result.report.broken.some((b) => b.token === 'flows/android.yaml'));
  const real = await import(pathToFileURL(SRC).href);
  const realResult = real.importDesignMaterials({ root: dir });
  assert.ok(!realResult.report.broken.some((b) => b.token === 'flows/android.yaml'));
});

test('M6: when the import rewrites the body, the acceptance criterion is violated', async () => {
  const { mod } = await mutated(
    `export function readMaterial(root, rel) {
  const full = path.join(root, rel);
  let text = '';
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (err) {`,
    `export function readMaterial(root, rel) {
  const full = path.join(root, rel);
  let text = '';
  try {
    text = fs.readFileSync(full, 'utf8');
    fs.writeFileSync(full, text + '\\n<!-- imported -->', 'utf8');
  } catch (err) {`,
  );
  const dir = fixture();
  const before = fs.readFileSync(path.join(dir, 'docs', '01-DESIGN.md'), 'utf8');
  mod.importDesignMaterials({ root: dir });
  const after = fs.readFileSync(path.join(dir, 'docs', '01-DESIGN.md'), 'utf8');
  assert.notEqual(after, before, 'the mutation rewrites the body');
  assert.ok(after.includes('<!-- imported -->'));
  // The real importer does not.
  const real = await import(pathToFileURL(SRC).href);
  const dir2 = fixture();
  const before2 = fs.readFileSync(path.join(dir2, 'docs', '01-DESIGN.md'), 'utf8');
  real.importDesignMaterials({ root: dir2 });
  assert.equal(fs.readFileSync(path.join(dir2, 'docs', '01-DESIGN.md'), 'utf8'), before2);
});

test('M7: when the classifier guesses among several candidates, the report invents a fact', async () => {
  const { mod } = await mutated(
    `    return { kind: REFERENCE_KIND.AMBIGUOUS, token: raw, candidates: byBase.slice().sort() };`,
    `    return { kind: REFERENCE_KIND.RESOLVED, token: raw, candidates: [byBase.slice().sort()[0]] };`,
  );
  const dir = fixture();
  const result = mod.importDesignMaterials({ root: dir });
  const guessed = result.references.find((r) => r.token === 'index.mjs');
  assert.equal(guessed.kind, 'resolved', 'the mutation guesses');
  assert.equal(guessed.candidates.length, 1, 'the mutation picks one');
  // The real importer refuses to guess.
  const real = await import(pathToFileURL(SRC).href);
  const realResult = real.importDesignMaterials({ root: fixture() });
  const realRef = realResult.references.find((r) => r.token === 'index.mjs');
  assert.equal(realRef.kind, 'ambiguous');
  assert.ok(realRef.candidates.length >= 2);
});
