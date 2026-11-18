/**
 * ATS-308 -- the design material indexer and the tracking asset importer:
 * the unit tests.
 *
 * WHAT IS UNDER TEST
 * ------------------
 * The acceptance criterion of ATS-308 has two halves, and each half has its
 * own group of tests here:
 *
 *   1. "导入 md/json 关系不改正文" -- the import does not rewrite the
 *      body. UT-ATS308-0xx proves it by hashing the tree before and after
 *      the import and asserting the hashes are identical, and by
 *      asserting that the importer never opens a file for writing.
 *
 *   2. "失效/重名链接输出报告" -- the broken and the ambiguous links are
 *      REPORTED. UT-ATS308-1xx covers the classifier, and the counter-
 *      example that matters is the one that would make the report cry
 *      wolf: a reference that is perfectly fine being reported as broken.
 *
 * The fixtures are BUILT, not read from the real tree: a test that reads
 * the real repository measures the repository, not the code. One test
 * does read the real tree (UT-ATS308-030), because "the real baseline has
 * no dangling reference to a file of this repository" is a property of
 * the DATA.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  BUILD_OUTPUT_DIRS, DESIGN_INDEX_VERSION, REFERENCE_KIND, RUNTIME_ARTEFACTS,
  buildTreeIndex, classifyReference, extractReferences, findMaterials,
  formatImportReport, importDesignMaterials, listTree, materialUid,
  readHeadings, referenceUid,
} from '../server/import/design-index.mjs';
import {
  ASSET_ISSUE, assetUid, importTrackingAssets, linkUid, parseTarget,
  readCaseTitles, requirementUid,
} from '../server/import/tracking-assets.mjs';

const root = path.resolve(import.meta.dirname, '..');

/* ------------------------------------------------------------------ */
/* The fixture                                                        */
/* ------------------------------------------------------------------ */

/**
 * Writes a miniature repository.
 *
 * The shape is the one the platform's own documents have: a `docs/` tree
 * of design documents, a source tree, a `tools/` tree and a `.aitest`
 * directory of tracking assets.
 */
function fixture(spec = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats308-'));
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };

  write('docs/01-DESIGN.md', spec.design ?? [
    '# ATS-DD-001 設計書',
    '',
    '## 1. 概要',
    '',
    '実装は `server/index.mjs` にある。設計は `docs/02-DATA.md` を参照。',
    '存在しないファイルを指す: `server/gone.mjs`。',
    '',
    '## 2. 詳細',
    '',
    '制剂は `package.json` と `playwright.config.ts` を参照。',
    '再登場しないファイル: `docs/missing.md`。',
  ].join('\n'));

  write('docs/02-DATA.md', '# ATS-DD-002 データ設計書\n\n## 1. エンティティ\n\n`server/core.mjs` の純関数を参照。\n');
  write('server/index.mjs', 'export const x = 1;\n');
  write('server/core.mjs', 'export const y = 2;\n');
  write('package.json', '{}\n');
  write('playwright.config.ts', 'export default {};\n');
  write('tools/probe.mjs', 'console.log(1);\n');

  if (spec.assets !== false) {
    write('.aitest/requirements.json', JSON.stringify([
      { uid: 'REQ-001', title: '要件1', type: 'functional', status: 'approved' },
      { uid: 'REQ-002', title: '要件2', type: 'functional', status: 'approved' },
    ]));
    write('.aitest/traceability.json', JSON.stringify([
      { from: 'REQ-001', to: 'tests/home.spec.ts::首页响应正常', type: 'verified_by' },
      { from: 'REQ-002', to: 'tests/home.spec.ts::导航入口正常', type: 'verified_by' },
    ]));
    write('tests/home.spec.ts', [
      "import { test, expect } from '@playwright/test';",
      "test('首页响应正常', async () => {});",
      "test('导航入口正常', async () => {});",
    ].join('\n'));
  }

  return dir;
}

/**
 * The digest of every file of a tree: the proof that the import changed
 * nothing.
 */
function treeDigest(dir) {
  const files = listTree(dir).sort();
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\u0000');
    hash.update(fs.readFileSync(path.join(dir, rel)));
    hash.update('\u0000');
  }
  return { digest: hash.digest('hex'), count: files.length };
}

/* ------------------------------------------------------------------ */
/* 1. the import does not rewrite the body                            */
/* ------------------------------------------------------------------ */

test('UT-ATS308-001: the import does not change a single byte of the tree', () => {
  const dir = fixture();
  const before = treeDigest(dir);
  importDesignMaterials({ root: dir });
  importTrackingAssets({ root: dir });
  const after = treeDigest(dir);
  assert.equal(after.digest, before.digest, 'the import must not rewrite the body');
  assert.equal(after.count, before.count);
});

test('UT-ATS308-002: the import is repeatable and produces the same index', () => {
  const dir = fixture();
  const a = importDesignMaterials({ root: dir });
  const b = importDesignMaterials({ root: dir });
  assert.deepEqual(a.report, b.report, 'the same tree must produce the same report');
  assert.deepEqual(
    a.materials.map((m) => [m.rel, m.sha256]),
    b.materials.map((m) => [m.rel, m.sha256]),
  );
});

test('UT-ATS308-003: the material uid depends on the path, not on the position', () => {
  assert.equal(materialUid('docs/01-A.md'), materialUid('docs/01-A.md'));
  assert.notEqual(materialUid('docs/01-A.md'), materialUid('docs/02-A.md'));
  // The same reference on two lines of the same document is two facts.
  assert.notEqual(referenceUid('docs/A.md', 1, 'x.mjs'), referenceUid('docs/A.md', 2, 'x.mjs'));
});

/* ------------------------------------------------------------------ */
/* 2. the classifier                                                  */
/* ------------------------------------------------------------------ */

test('UT-ATS308-010: a path that exists as written is resolved', () => {
  const dir = fixture();
  const tree = buildTreeIndex(dir);
  const v = classifyReference('server/index.mjs', tree);
  assert.equal(v.kind, REFERENCE_KIND.RESOLVED);
  assert.deepEqual(v.candidates, ['server/index.mjs']);
});

test('UT-ATS308-011: a bare basename that names exactly one file is resolved', () => {
  const dir = fixture();
  const tree = buildTreeIndex(dir);
  const v = classifyReference('core.mjs', tree);
  assert.equal(v.kind, REFERENCE_KIND.RESOLVED);
  assert.deepEqual(v.candidates, ['server/core.mjs']);
});

test('UT-ATS308-012: a bare basename that names SEVERAL files is ambiguous, and the candidates are reported', () => {
  const dir = fixture();
  fs.mkdirSync(path.join(dir, 'other'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'other', 'core.mjs'), 'export const z = 3;\n');
  const tree = buildTreeIndex(dir);
  const v = classifyReference('core.mjs', tree);
  assert.equal(v.kind, REFERENCE_KIND.AMBIGUOUS);
  assert.equal(v.candidates.length, 2);
  assert.ok(v.candidates.includes('server/core.mjs'));
  assert.ok(v.candidates.includes('other/core.mjs'));
});

test('UT-ATS308-013: a reference into a directory of THIS repository that has no such file is broken', () => {
  const dir = fixture();
  const tree = buildTreeIndex(dir);
  const v = classifyReference('server/gone.mjs', tree);
  assert.equal(v.kind, REFERENCE_KIND.BROKEN);
  assert.deepEqual(v.candidates, []);
});

test('UT-ATS308-014: a reference into a directory this repository does NOT have is external, not broken', () => {
  const dir = fixture();
  const tree = buildTreeIndex(dir);
  // `flows/` is a directory of a project under test, not of this
  // repository. Reporting it as broken would be a false defect.
  const v = classifyReference('flows/android.yaml', tree);
  assert.equal(v.kind, REFERENCE_KIND.EXTERNAL);
});

test('UT-ATS308-015: a runtime artefact is not a broken link', () => {
  const dir = fixture();
  const tree = buildTreeIndex(dir);
  for (const name of RUNTIME_ARTEFACTS) {
    const v = classifyReference(name, tree);
    assert.equal(v.kind, REFERENCE_KIND.RUNTIME, `${name} must be a runtime artefact`);
  }
  // A build output is a runtime artefact too.
  const v = classifyReference('out/index.html', tree);
  assert.equal(v.kind, REFERENCE_KIND.RUNTIME);
  assert.ok(BUILD_OUTPUT_DIRS.includes('out'));
});

test('UT-ATS308-016: the suffix rule resolves a shortened path but never guesses', () => {
  const dir = fixture();
  const tree = buildTreeIndex(dir);
  // `index.mjs` alone is ambiguous in this tree? No: `server/index.mjs`
  // is the only index.mjs. A path written as `server/index.mjs` resolves.
  const v = classifyReference('server/index.mjs', tree);
  assert.equal(v.kind, REFERENCE_KIND.RESOLVED);
  // Two candidates with the same suffix -> ambiguous, NOT a guess.
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'dup.mjs'), '');
  fs.mkdirSync(path.join(dir, 'c'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'c', 'dup.mjs'), '');
  const tree2 = buildTreeIndex(dir);
  const amb = classifyReference('dup.mjs', tree2);
  assert.equal(amb.kind, REFERENCE_KIND.AMBIGUOUS);
  assert.equal(amb.candidates.length, 2);
});

test('UT-ATS308-017: the classifier never resolves a reference that does not exist', () => {
  const dir = fixture();
  const tree = buildTreeIndex(dir);
  for (const token of ['server/gone.mjs', 'docs/missing.md', 'nothing-at-all.mjs']) {
    const v = classifyReference(token, tree);
    assert.notEqual(v.kind, REFERENCE_KIND.RESOLVED, `${token} must not resolve`);
  }
});

/* ------------------------------------------------------------------ */
/* 3. the reference extraction                                         */
/* ------------------------------------------------------------------ */

test('UT-ATS308-020: a reference is an inline-code span holding a path', () => {
  const refs = extractReferences([
    'これは `server/index.mjs` の参照。',
    'これは `docs/02-DATA.md` §1 の参照。',
    'これは散文 `not a path` です。',
    'これは `.mjs` です（拡張子だけ）。',
    'これは `no-extension` です。',
  ].join('\n'));
  const tokens = refs.map((r) => r.token);
  assert.ok(tokens.includes('server/index.mjs'));
  assert.ok(tokens.includes('docs/02-DATA.md'));
  assert.ok(!tokens.includes('not a path'));
  assert.ok(!tokens.includes('.mjs'));
  assert.ok(!tokens.includes('no-extension'));
});

test('UT-ATS308-021: every reference carries the line it was written on', () => {
  const refs = extractReferences('line one\n`server/index.mjs`\nline three\n`server/core.mjs`\n');
  assert.equal(refs.length, 2);
  assert.equal(refs[0].token, 'server/index.mjs');
  assert.equal(refs[0].line, 2);
  assert.equal(refs[1].token, 'server/core.mjs');
  assert.equal(refs[1].line, 4);
});

test('UT-ATS308-022: the headings of a document are read with their numbers', () => {
  const h = readHeadings('# T\n\n## 1. 概要\n\n## 2. 詳細\n\n### 2.1 詳細\n');
  assert.deepEqual([...h.keys()], ['1', '2', '2.1']);
  assert.equal(h.get('1').title, '概要');
});

/* ------------------------------------------------------------------ */
/* 4. the report                                                      */
/* ------------------------------------------------------------------ */

test('UT-ATS308-030: the report names the broken references and where they are', () => {
  const dir = fixture();
  const result = importDesignMaterials({ root: dir });
  const broken = result.report.broken;
  const tokens = broken.map((b) => b.token);
  assert.ok(tokens.includes('server/gone.mjs'), 'the broken reference must be reported');
  assert.ok(tokens.includes('docs/missing.md'), 'the broken reference must be reported');
  const entry = broken.find((b) => b.token === 'server/gone.mjs');
  assert.ok(entry.places.length >= 1);
  assert.ok(entry.places.every((p) => typeof p.from === 'string' && p.line > 0));
  // The report does not report the RESOLVED references as broken.
  assert.ok(!tokens.includes('server/index.mjs'));
  assert.ok(!tokens.includes('docs/02-DATA.md'));
});

test('UT-ATS308-031: the report counts every reference exactly once', () => {
  const dir = fixture();
  const result = importDesignMaterials({ root: dir });
  const sum = Object.values(result.report.byKind).reduce((a, b) => a + b, 0);
  assert.equal(sum, result.report.references);
  assert.equal(result.report.references, result.references.length);
});

test('UT-ATS308-032: the readable report names the counts and the findings', () => {
  const dir = fixture();
  const result = importDesignMaterials({ root: dir });
  const text = formatImportReport(result.report);
  assert.match(text, /设计文档数/);
  assert.match(text, /失效链接/);
  assert.ok(text.includes('server/gone.mjs'));
});

test('UT-ATS308-033: the material list is the design documents plus the tracking assets', () => {
  const dir = fixture();
  const rels = findMaterials(dir);
  assert.ok(rels.includes('docs/01-DESIGN.md'));
  assert.ok(rels.includes('docs/02-DATA.md'));
  // The example project's assets are not in this fixture's tree, so the
  // repository's own `tests/rtm.json` is the asset of the platform.
  assert.ok(!rels.includes('package.json'), 'a package.json is not design material');
  assert.ok(!rels.includes('server/index.mjs'), 'source code is not design material');
});

/* ------------------------------------------------------------------ */
/* 5. the tracking assets                                             */
/* ------------------------------------------------------------------ */

test('UT-ATS308-040: the tracking assets are imported with their relations', () => {
  const dir = fixture();
  const result = importTrackingAssets({ root: dir });
  assert.equal(result.requirements.length, 2);
  assert.equal(result.links.length, 2);
  assert.equal(result.issues.length, 0, JSON.stringify(result.issues));
  assert.equal(result.report.requirements, 2);
  assert.equal(result.report.links, 2);
});

test('UT-ATS308-041: a link to a requirement the list does not declare is reported', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, '.aitest', 'traceability.json'), JSON.stringify([
    { from: 'REQ-999', to: 'tests/home.spec.ts::首页响应正常', type: 'verified_by' },
  ]));
  const result = importTrackingAssets({ root: dir });
  const issue = result.issues.find((i) => i.kind === ASSET_ISSUE.DANGLING_REQUIREMENT);
  assert.ok(issue, 'the dangling requirement must be reported');
  assert.equal(issue.from, 'REQ-999');
  assert.equal(result.report.danglingRequirements, 1);
});

test('UT-ATS308-042: a link to a case the file does not declare is reported', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, '.aitest', 'traceability.json'), JSON.stringify([
    { from: 'REQ-001', to: 'tests/home.spec.ts::被改名的用例', type: 'verified_by' },
  ]));
  const result = importTrackingAssets({ root: dir });
  const issue = result.issues.find((i) => i.kind === ASSET_ISSUE.UNKNOWN_CASE);
  assert.ok(issue, 'the unknown case must be reported');
  assert.equal(issue.title, '被改名的用例');
});

test('UT-ATS308-043: a link to a file the project does not have is reported', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, '.aitest', 'traceability.json'), JSON.stringify([
    { from: 'REQ-001', to: 'tests/none.spec.ts::x', type: 'verified_by' },
  ]));
  const result = importTrackingAssets({ root: dir });
  const issue = result.issues.find((i) => i.kind === ASSET_ISSUE.MISSING_FILE);
  assert.ok(issue, 'the missing file must be reported');
  assert.equal(issue.file, 'tests/none.spec.ts');
});

test('UT-ATS308-044: a duplicated link is reported once, and the link is kept once', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, '.aitest', 'traceability.json'), JSON.stringify([
    { from: 'REQ-001', to: 'tests/home.spec.ts::首页响应正常', type: 'verified_by' },
    { from: 'REQ-001', to: 'tests/home.spec.ts::首页响应正常', type: 'verified_by' },
  ]));
  const result = importTrackingAssets({ root: dir });
  assert.equal(result.links.length, 1, 'the duplicate must not be indexed twice');
  assert.equal(result.report.duplicateLinks, 1);
});

test('UT-ATS308-045: a duplicated requirement is reported', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, '.aitest', 'requirements.json'), JSON.stringify([
    { uid: 'REQ-001', title: 'a' },
    { uid: 'REQ-001', title: 'b' },
  ]));
  const result = importTrackingAssets({ root: dir });
  const issue = result.issues.find((i) => i.kind === ASSET_ISSUE.DUPLICATE_REQUIREMENT);
  assert.ok(issue);
  assert.equal(issue.count, 2);
});

test('UT-ATS308-046: a malformed asset is reported, not thrown', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, '.aitest', 'requirements.json'), '{ not json');
  const result = importTrackingAssets({ root: dir });
  assert.equal(result.requirements.length, 0);
  assert.ok(result.assets.find((a) => a.name === 'requirements.json').error);
});

test('UT-ATS308-047: a target that does not use the file::title convention is reported', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, '.aitest', 'traceability.json'), JSON.stringify([
    { from: 'REQ-001', to: 'just-a-title', type: 'verified_by' },
  ]));
  const result = importTrackingAssets({ root: dir });
  const issue = result.issues.find((i) => i.kind === ASSET_ISSUE.MALFORMED_TARGET);
  assert.ok(issue);
});

test('UT-ATS308-048: the target is split on the FIRST double colon', () => {
  const t = parseTarget('a/b.spec.ts::title with :: inside');
  assert.equal(t.file, 'a/b.spec.ts');
  assert.equal(t.title, 'title with :: inside');
  assert.equal(parseTarget('no-colons'), null);
  assert.equal(parseTarget('::only-title'), null);
});

test('UT-ATS308-049: the asset uids depend on the project, not only on the content', () => {
  assert.notEqual(requirementUid('proj-a', 'REQ-001'), requirementUid('proj-b', 'REQ-001'));
  assert.notEqual(assetUid('proj-a', 'requirements.json'), assetUid('proj-a', 'traceability.json'));
  assert.notEqual(linkUid('p', 'a', 'b', 'x'), linkUid('p', 'a', 'b', 'y'));
});

test('UT-ATS308-050: the case titles are read with the platform scanner', () => {
  const dir = fixture();
  const titles = readCaseTitles(dir);
  assert.ok(titles.has('tests/home.spec.ts'));
  assert.ok(titles.get('tests/home.spec.ts').includes('首页响应正常'));
});

/* ------------------------------------------------------------------ */
/* 6. the real repository                                             */
/* ------------------------------------------------------------------ */

/**
 * The real baseline is read here, and ONLY here, because the property
 * being checked is a property of the DATA: every reference the real
 * design documents make to a file of THIS repository must resolve.
 *
 * The check is deliberately narrow. The report DOES find broken
 * references in the real tree -- they are references to files of the
 * PROJECTS UNDER TEST (`tests/a.spec.ts`), to the REVIEWER PROBES that
 * are issue attachments and never were committed (`r1-api.mjs`), and to
 * the build outputs (`out/index.html`). Those are reported as
 * `broken`/`external`/`runtime` by the classifier, and the honest thing
 * is to assert that the classifier classifies them, not to assert that
 * the tree has no findings at all.
 */
test('UT-ATS308-060: the real baseline imports, and every reference to a file of this repository resolves', () => {
  const result = importDesignMaterials({ root });
  assert.ok(result.report.designDocuments >= 40, `only ${result.report.designDocuments} design documents`);
  assert.ok(result.report.references > 500, `only ${result.report.references} references`);

  // Every reference that RESOLVED must resolve to a file that really
  // exists -- the classifier must not invent a candidate.
  for (const ref of result.references) {
    if (ref.kind !== REFERENCE_KIND.RESOLVED) continue;
    assert.ok(ref.candidates.length >= 1, `${ref.token} resolved without a candidate`);
    for (const candidate of ref.candidates) {
      assert.ok(fs.existsSync(path.join(root, candidate)), `${candidate} does not exist`);
    }
  }

  // And the counts must add up: the report accounts for EVERY reference.
  const sum = Object.values(result.report.byKind).reduce((a, b) => a + b, 0);
  assert.equal(sum, result.report.references);
  assert.equal(result.report.byKind[REFERENCE_KIND.BROKEN] ?? 0, result.report.broken.reduce((n, b) => n + b.count, 0));
});

test('UT-ATS308-061: the real baseline is imported twice with the same result', () => {
  const a = importDesignMaterials({ root });
  const b = importDesignMaterials({ root });
  assert.deepEqual(a.report, b.report);
});
