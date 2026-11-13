/**
 * ATS-214 unit tests: the CASE SEARCH / TAG / FILTER / SELECTION module.
 *
 * WHAT IS UNDER TEST
 * ------------------
 * The ACCEPTANCE CRITERION of ATS-214 is the one the issue and the WBS
 * row state:
 *
 *   「500 用例过滤无明显阻塞；选中准确映射 UID」
 *
 * and the tests below cover the parts of it that a unit test CAN cover:
 *
 *   * 「过滤」 -- the search finds by title, by file and by tag, and the
 *     result is a SUBSET of the catalogue (never a case that is not
 *     there); the two tag modes are DIFFERENT and each is what it says;
 *     the criteria COMPOSE as an intersection, and neither a union nor a
 *     replacement is accepted;
 *   * 「选中准确映射 UID」 -- the selection is a set, the snapshot is
 *     self-contained, the reconciliation reports the difference instead
 *     of hiding it, a ticked uid that has LEFT the catalogue is REPORTED
 *     (`selectionDiffs`), and the number of cases a selection will
 *     REALLY run is the number of the SELECTED FILES (`plannedExecutions`).
 *
 * The 500-case half of the criterion is a LAYOUT and a LATENCY question,
 * so it cannot be checked here: it is measured in a real browser by
 * `tools/ats214-probes/st-ats214.mjs`
 * (`docs/evidence/ATS-214/10-st-500-cases.log`).
 *
 * THE TESTS ARE FALSIFIABLE
 * -------------------------
 * Every assertion states the value it expects, and the fixtures are built
 * so that a wrong implementation produces a DIFFERENT number -- not
 * merely a missing field. The set-semantics tests in particular feed the
 * module a search and a tag filter whose intersection is EMPTY while
 * neither set is, so a union (which would return 3) and a replacement
 * (which would return 1) are both caught.
 *
 * Run: node --test tests/ats214-case-search.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CRITERION,
  DEFAULT_TAG_MODE,
  TAG_MODE,
  criterionSets,
  describeFilter,
  emptyFilter,
  fileVocabulary,
  filterCases,
  normalizeTag,
  normalizeTags,
  plannedExecutions,
  reconcileSelection,
  searchHaystack,
  searchSet,
  selectionByFile,
  selectionDiffs,
  selectionSet,
  selectionSnapshot,
  tagSet,
  tagVocabulary,
} from '../apps/studio/public/case-search.mjs';

/**
 * The fixture catalogue.
 *
 * The tags are the SPELLING THE ENGINE REPORTS: Playwright requires the
 * author to write '@smoke' but reports the tag as 'smoke' (measured -- see
 * `docs/32-CASE-SEARCH-SELECTION.md` §3). The fixture therefore carries
 * 'smoke', not '@smoke'.
 *
 *   u1  smoke            tests/login.spec.ts:3
 *   u2  smoke, slow      tests/login.spec.ts:9
 *   u3  (none)           tests/login.spec.ts:15
 *   u4  slow             tests/cart.spec.ts:4
 *   u5  smoke, slow      tests/cart.spec.ts:8
 *   u6  fast             tests/cart.spec.ts:14
 */
const CATALOGUE = [
  { uid: 'u1', title: '用户登录', file: 'tests/login.spec.ts', line: 3, tags: ['smoke'] },
  { uid: 'u2', title: '登录失败提示', file: 'tests/login.spec.ts', line: 9, tags: ['smoke', 'slow'] },
  { uid: 'u3', title: '登出', file: 'tests/login.spec.ts', line: 15, tags: [] },
  { uid: 'u4', title: '加入购物车', file: 'tests/cart.spec.ts', line: 4, tags: ['slow'] },
  { uid: 'u5', title: '结算', file: 'tests/cart.spec.ts', line: 8, tags: ['smoke', 'slow'] },
  { uid: 'u6', title: '快速加购', file: 'tests/cart.spec.ts', line: 14, tags: ['fast'] },
];

const uids = (list) => list.map((t) => t.uid).sort();

/* ================================================================== */
/* Clause 1: the search                                                */
/* ================================================================== */

test('UT-ATS214-001: an empty search keeps the whole catalogue', () => {
  const result = filterCases(CATALOGUE, { ...emptyFilter(), query: '' });
  assert.equal(result.length, 6);
  assert.deepEqual(uids(result), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
});

test('UT-ATS214-002: the search finds by the case title', () => {
  const result = filterCases(CATALOGUE, { ...emptyFilter(), query: '登录' });
  // u1 '用户登录' and u2 '登录失败提示'. u3 '登出' does not contain '登录'.
  assert.deepEqual(uids(result), ['u1', 'u2']);
});

test('UT-ATS214-003: the search finds by the file', () => {
  const result = filterCases(CATALOGUE, { ...emptyFilter(), query: 'cart.spec' });
  assert.deepEqual(uids(result), ['u4', 'u5', 'u6']);
});

test('UT-ATS214-004: the search finds by the tag', () => {
  const result = filterCases(CATALOGUE, { ...emptyFilter(), query: 'smoke' });
  // u1, u2 and u5 carry the tag 'smoke'.
  assert.deepEqual(uids(result), ['u1', 'u2', 'u5']);
});

test('UT-ATS214-005: the search is case-insensitive', () => {
  const lower = filterCases(CATALOGUE, { ...emptyFilter(), query: 'smoke' });
  const upper = filterCases(CATALOGUE, { ...emptyFilter(), query: 'SMOKE' });
  const mixed = filterCases(CATALOGUE, { ...emptyFilter(), query: 'SmOkE' });
  assert.deepEqual(uids(upper), uids(lower));
  assert.deepEqual(uids(mixed), uids(lower));
});

test('UT-ATS214-006: the search result is a SUBSET of the catalogue -- never a case that is not there', () => {
  const result = filterCases(CATALOGUE, { ...emptyFilter(), query: '不存在的用例' });
  assert.deepEqual(result, [], 'a query that matches nothing returns nothing');

  // And for every query the result is a subset.
  for (const q of ['登录', 'cart', 'smoke', '快速', '', 'spec.ts']) {
    const ids = new Set(CATALOGUE.map((t) => t.uid));
    for (const t of filterCases(CATALOGUE, { ...emptyFilter(), query: q })) {
      assert.ok(ids.has(t.uid), `the result of "${q}" holds a case that is not in the catalogue`);
    }
  }
});

test('UT-ATS214-007: the search haystack is the title, the file and the tags -- and nothing else', () => {
  const hay = searchHaystack(CATALOGUE[0]);
  assert.ok(hay.includes('用户登录'));
  assert.ok(hay.includes('tests/login.spec.ts'));
  assert.ok(hay.includes('smoke'));
  // A field that is NOT searched must not be in the haystack.
  assert.ok(!hay.includes('u1'), 'the uid is not searched');
});

/* ================================================================== */
/* Clause 2: the tag semantics                                         */
/* ================================================================== */

test('UT-ATS214-008: the tag criterion with one tag keeps the cases that carry it', () => {
  const result = filterCases(CATALOGUE, { ...emptyFilter(), tags: ['smoke'] });
  assert.deepEqual(uids(result), ['u1', 'u2', 'u5']);
});

test('UT-ATS214-009: the ANY mode is the UNION of the tag sets', () => {
  // 'smoke' -> u1,u2,u5 ; 'fast' -> u6. The union is u1,u2,u5,u6.
  const result = filterCases(CATALOGUE, { ...emptyFilter(), tags: ['smoke', 'fast'], tagMode: TAG_MODE.ANY });
  assert.deepEqual(uids(result), ['u1', 'u2', 'u5', 'u6']);
});

test('UT-ATS214-010: the ALL mode is the INTERSECTION of the tag sets', () => {
  // 'smoke' -> u1,u2,u5 ; 'slow' -> u2,u4,u5. The intersection is u2,u5.
  const result = filterCases(CATALOGUE, { ...emptyFilter(), tags: ['smoke', 'slow'], tagMode: TAG_MODE.ALL });
  assert.deepEqual(uids(result), ['u2', 'u5']);
});

test('UT-ATS214-011: the two tag modes are DIFFERENT -- the mode is not a decoration', () => {
  const any = tagSet(CATALOGUE, ['smoke', 'slow'], TAG_MODE.ANY);
  const all = tagSet(CATALOGUE, ['smoke', 'slow'], TAG_MODE.ALL);
  assert.notDeepEqual([...any].sort(), [...all].sort());
  assert.equal(any.size, 4, 'the union has four cases');
  assert.equal(all.size, 2, 'the intersection has two cases');
  // The intersection is a SUBSET of the union -- the set relation that
  // makes "all" the stricter of the two.
  for (const u of all) assert.ok(any.has(u), `${u} is in the intersection, so it is in the union`);
});

test('UT-ATS214-012: the default tag mode is ANY, and it is the one the module reports', () => {
  assert.equal(DEFAULT_TAG_MODE, TAG_MODE.ANY);
  const described = describeFilter(CATALOGUE, { ...emptyFilter(), tags: ['smoke', 'slow'] });
  assert.equal(described.tagMode, TAG_MODE.ANY);
  const tagCriterion = described.criteria.find((c) => c.kind === CRITERION.TAG);
  assert.equal(tagCriterion.mode, TAG_MODE.ANY, 'the criterion reports its mode');
  assert.equal(tagCriterion.active, true);
});

test('UT-ATS214-013: a tag is compared without its @ and without its case', () => {
  assert.equal(normalizeTag('@smoke'), 'smoke');
  assert.equal(normalizeTag('smoke'), 'smoke');
  assert.equal(normalizeTag('@SMOKE'), 'smoke');
  assert.equal(normalizeTag('  @Smoke  '), 'smoke');
  // A tag that is only the prefix is not a tag.
  assert.equal(normalizeTag('@'), '');
  assert.equal(normalizeTag(''), '');
  // The '@' is stripped ONCE.
  assert.equal(normalizeTag('@@weird'), '@weird');
  // A user who types '@smoke' finds the tag the engine reports as 'smoke'.
  const result = filterCases(CATALOGUE, { ...emptyFilter(), tags: ['@smoke'] });
  assert.deepEqual(uids(result), ['u1', 'u2', 'u5']);
});

test('UT-ATS214-014: the tag list is de-duplicated and ordered', () => {
  assert.deepEqual(normalizeTags(['@b', 'a', 'b', '@a']), ['a', 'b']);
  assert.deepEqual(normalizeTags(null), []);
  assert.deepEqual(normalizeTags(undefined), []);
});

test('UT-ATS214-015: a tag that no case carries keeps nothing -- and the vocabulary does not offer it', () => {
  const result = filterCases(CATALOGUE, { ...emptyFilter(), tags: ['nonexistent'] });
  assert.deepEqual(result, [], 'a tag nobody carries matches nothing');
  const vocabulary = tagVocabulary(CATALOGUE);
  assert.ok(!vocabulary.some((v) => v.tag === 'nonexistent'));
  assert.deepEqual(vocabulary.map((v) => v.tag), ['slow', 'smoke', 'fast'], 'the most used tag comes first');
  assert.deepEqual(vocabulary.map((v) => v.count), [3, 3, 1]);
});

/* ================================================================== */
/* Clause 3: the set semantics                                          */
/* ================================================================== */

test('UT-ATS214-016: the criteria COMPOSE as an INTERSECTION, not a union', () => {
  // The search '登录' keeps u1,u2. The tag 'smoke' keeps u1,u2,u5.
  // The intersection is u1,u2 -- NOT u1,u2,u5 (a union) and NOT u1,u2
  // replaced by u1,u2,u5.
  const filter = { ...emptyFilter(), query: '登录', tags: ['smoke'] };
  const result = filterCases(CATALOGUE, filter);
  assert.deepEqual(uids(result), ['u1', 'u2']);
  // The union would have been three cases; the result is not that.
  assert.notEqual(result.length, 3, 'the result is not the union of the two criteria');
});

test('UT-ATS214-017: the intersection can be EMPTY while neither criterion is empty', () => {
  // The search '登录' keeps u1,u2. The tag 'fast' keeps u6 only.
  // The two sets do NOT intersect, and the result is empty -- which is the
  // fact a reader needs, and which a union would have hidden.
  const filter = { ...emptyFilter(), query: '登录', tags: ['fast'] };
  const result = filterCases(CATALOGUE, filter);
  assert.deepEqual(result, [], 'the intersection of two disjoint sets is empty');

  const sets = criterionSets(CATALOGUE, filter);
  assert.equal(sets.search.size, 2, 'the search alone keeps two cases');
  assert.equal(sets.tag.size, 1, 'the tag alone keeps one case');
  assert.equal(sets.search.size + sets.tag.size, 3, 'the two sets are not empty on their own');
});

test('UT-ATS214-018: clearing one criterion does not clear the other', () => {
  // The filter narrows to u1,u2. Clearing the TAG criterion must leave the
  // SEARCH in place -- a filter that REPLACED the search would return the
  // whole catalogue here.
  const withTag = filterCases(CATALOGUE, { ...emptyFilter(), query: '登录', tags: ['smoke'] });
  const withoutTag = filterCases(CATALOGUE, { ...emptyFilter(), query: '登录', tags: [] });
  assert.deepEqual(uids(withTag), ['u1', 'u2']);
  assert.deepEqual(uids(withoutTag), ['u1', 'u2'], 'the search survives the tag criterion being cleared');

  // And the other way round: clearing the search leaves the tag criterion
  // in place.
  const withoutQuery = filterCases(CATALOGUE, { ...emptyFilter(), query: '', tags: ['smoke'] });
  assert.deepEqual(uids(withoutQuery), ['u1', 'u2', 'u5'], 'the tag criterion survives the search being cleared');
});

test('UT-ATS214-019: the file criterion composes with the others the same way', () => {
  // 'smoke' keeps u1,u2,u5. The file 'cart.spec' keeps u4,u5,u6.
  // The intersection is u5.
  const result = filterCases(CATALOGUE, { ...emptyFilter(), tags: ['smoke'], files: ['cart.spec'] });
  assert.deepEqual(uids(result), ['u5']);
});

test('UT-ATS214-020: three criteria compose as the intersection of three sets', () => {
  // search '结算' -> u5 ; tag 'smoke' -> u1,u2,u5 ; file 'cart' -> u4,u5,u6
  const result = filterCases(CATALOGUE, { ...emptyFilter(), query: '结算', tags: ['smoke'], files: ['cart'] });
  assert.deepEqual(uids(result), ['u5']);
  // A criterion that contradicts the others empties the intersection.
  const none = filterCases(CATALOGUE, { ...emptyFilter(), query: '结算', tags: ['fast'], files: ['cart'] });
  assert.deepEqual(none, []);
});

test('UT-ATS214-021: the status criterion composes with the others, and a case with no known status is excluded', () => {
  const statuses = { u1: 'passed', u2: 'failed', u3: 'passed', u4: 'failed', u5: 'passed', u6: 'failed' };
  const statusOf = (t) => statuses[t.uid];
  const result = filterCases(CATALOGUE, { ...emptyFilter(), statuses: ['failed'] }, { statusOf });
  assert.deepEqual(uids(result), ['u2', 'u4', 'u6']);
  // With a status criterion AND a tag criterion, the intersection rules.
  const both = filterCases(CATALOGUE, { ...emptyFilter(), statuses: ['failed'], tags: ['smoke'] }, { statusOf });
  assert.deepEqual(uids(both), ['u2'], 'the intersection of the status set and the tag set');
  // A case whose status nobody knows is NOT in the "failed" set.
  const partial = filterCases(CATALOGUE, { ...emptyFilter(), statuses: ['failed'] }, { statusOf: (t) => (t.uid === 'u2' ? 'failed' : '') });
  assert.deepEqual(uids(partial), ['u2']);
});

test('UT-ATS214-022: the description reports every criterion SEPARATELY, so the composition is visible', () => {
  const described = describeFilter(CATALOGUE, { ...emptyFilter(), query: '登录', tags: ['smoke'] });
  assert.equal(described.total, 6);
  assert.equal(described.matched, 2);
  const byKind = Object.fromEntries(described.criteria.map((c) => [c.kind, c]));
  assert.equal(byKind[CRITERION.SEARCH].kept, 2, 'the search kept two on its own');
  assert.equal(byKind[CRITERION.TAG].kept, 3, 'the tag kept three on its own');
  assert.equal(byKind[CRITERION.SEARCH].active, true);
  assert.equal(byKind[CRITERION.TAG].active, true);
  // A criterion that was NOT stated is not active, even though it kept
  // everything -- otherwise a reader would read it as a filter.
  assert.equal(byKind[CRITERION.FILE].active, false);
  assert.equal(byKind[CRITERION.FILE].kept, 6);
  assert.deepEqual(described.uids.sort(), ['u1', 'u2']);
});

test('UT-ATS214-023: the order of the result is the order of the catalogue', () => {
  const result = filterCases(CATALOGUE, { ...emptyFilter(), tags: ['smoke'] });
  assert.deepEqual(result.map((t) => t.uid), ['u1', 'u2', 'u5']);
});

test('UT-ATS214-024: the search criterion keeps everything when the query is blank', () => {
  const set = searchSet(CATALOGUE, '   ');
  assert.equal(set.size, 6, 'a whitespace-only query is not a filter');
});

/* ================================================================== */
/* Clause 4: the selection                                             */
/* ================================================================== */

test('UT-ATS214-025: the selection is a SET -- the order of the ticks does not matter', () => {
  const a = selectionSet(['u1', 'u2', 'u3']);
  const b = selectionSet(['u3', 'u1', 'u2']);
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.equal(a.size, 3);
});

test('UT-ATS214-026: the snapshot carries the file, the title and the line of every selected case', () => {
  const snapshot = selectionSnapshot(CATALOGUE, ['u1', 'u5']);
  assert.equal(snapshot.count, 2);
  assert.deepEqual(snapshot.uids, ['u1', 'u5']);
  const u5 = snapshot.cases.find((c) => c.uid === 'u5');
  assert.equal(u5.file, 'tests/cart.spec.ts');
  assert.equal(u5.title, '结算');
  assert.equal(u5.line, 8);
});

test('UT-ATS214-027: the snapshot REPORTS a uid the catalogue does not know, instead of skipping it', () => {
  const snapshot = selectionSnapshot(CATALOGUE, ['u1', 'tc_does_not_exist']);
  assert.deepEqual(snapshot.unknown, ['tc_does_not_exist']);
  assert.equal(snapshot.count, 1, 'the known case is snapshotted');
  assert.deepEqual(snapshot.uids, ['u1']);
  // The snapshot does NOT silently drop it: the caller can refuse.
  assert.equal(snapshot.unknown.length, 1);
});

test('UT-ATS214-028: two identical selections produce IDENTICAL snapshots', () => {
  const a = selectionSnapshot(CATALOGUE, ['u5', 'u1']);
  const b = selectionSnapshot(CATALOGUE, ['u1', 'u5']);
  assert.deepEqual(a, b, 'the snapshot does not depend on the order of the ticks');
});

test('UT-ATS214-029: the selection is grouped by file, because the engine runs one file at a time', () => {
  const snapshot = selectionSnapshot(CATALOGUE, ['u1', 'u2', 'u5', 'u6']);
  const groups = selectionByFile(snapshot);
  assert.equal(groups.length, 2);
  const login = groups.find((g) => g.file === 'tests/login.spec.ts');
  const cart = groups.find((g) => g.file === 'tests/cart.spec.ts');
  assert.deepEqual(login.uids, ['u1', 'u2']);
  assert.deepEqual(cart.uids, ['u5', 'u6']);
  assert.equal(login.count, 2);
});

test('UT-ATS214-030: the reconciliation says the selection MATCHED when every selected case ran', () => {
  const snapshot = selectionSnapshot(CATALOGUE, ['u1', 'u2']);
  const result = reconcileSelection(snapshot, ['u1', 'u2']);
  assert.equal(result.matches, true);
  assert.equal(result.exact, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, []);
  assert.equal(result.selected, 2);
  assert.equal(result.executed, 2);
});

test('UT-ATS214-031: the reconciliation REPORTS a selected case that did not run', () => {
  const snapshot = selectionSnapshot(CATALOGUE, ['u1', 'u2', 'u3']);
  const result = reconcileSelection(snapshot, ['u1', 'u2']);
  assert.equal(result.matches, false, 'the selection is not reproduced');
  assert.deepEqual(result.missing, ['u3']);
  assert.equal(result.selected, 3);
  assert.equal(result.executed, 2);
});

test('UT-ATS214-032: the reconciliation REPORTS an executed case that was not selected', () => {
  // The engine runs a whole FILE, so it may run cases the selection did
  // not name. That is a fact the reader has to see.
  const snapshot = selectionSnapshot(CATALOGUE, ['u1']);
  const result = reconcileSelection(snapshot, ['u1', 'u3']);
  assert.deepEqual(result.extra, ['u3']);
  assert.equal(result.matches, true, 'every selected case ran, so the selection IS reproduced');
  assert.equal(result.exact, false, 'but the run covered more than the selection');
});

test('UT-ATS214-033: the reconciliation of an empty execution says NOTHING ran', () => {
  const snapshot = selectionSnapshot(CATALOGUE, ['u1', 'u2']);
  const result = reconcileSelection(snapshot, []);
  assert.equal(result.matches, false);
  assert.deepEqual(result.missing, ['u1', 'u2']);
  assert.equal(result.executed, 0);
});

/* ================================================================== */
/* The vocabularies                                                    */
/* ================================================================== */

test('UT-ATS214-034: the file vocabulary counts the cases of each file', () => {
  const vocabulary = fileVocabulary(CATALOGUE);
  assert.equal(vocabulary.length, 2);
  const login = vocabulary.find((v) => v.file === 'tests/login.spec.ts');
  const cart = vocabulary.find((v) => v.file === 'tests/cart.spec.ts');
  assert.equal(login.count, 3);
  assert.equal(cart.count, 3);
});

test('UT-ATS214-035: a catalogue with no cases does not break the module', () => {
  assert.deepEqual(filterCases([], { ...emptyFilter(), query: 'x' }), []);
  assert.deepEqual(tagVocabulary([]), []);
  assert.deepEqual(fileVocabulary([]), []);
  const described = describeFilter([], emptyFilter());
  assert.equal(described.total, 0);
  assert.equal(described.matched, 0);
  const snapshot = selectionSnapshot([], []);
  assert.equal(snapshot.count, 0);
});

/* ================================================================== */
/* 「选中准确映射 UID」 -- the selection against the catalogue          */
/* ================================================================== */

test('UT-ATS214-036: a ticked uid that has LEFT the catalogue is REPORTED', () => {
  // 'gone' is a uid the catalogue does not know: the case was renamed,
  // moved or deleted.
  const diffs = selectionDiffs(CATALOGUE, ['u1', 'gone-1']);
  assert.deepEqual(diffs.gone, ['gone-1'], 'the uid that left the catalogue is reported');
  assert.equal(diffs.ok, false, 'the selection does NOT map accurately');
  assert.equal(diffs.count, 1);
  // The ones that are still there are not reported as gone.
  assert.deepEqual(selectionDiffs(CATALOGUE, ['u1', 'u2']).gone, []);
  assert.equal(selectionDiffs(CATALOGUE, ['u1', 'u2']).ok, true);
});

test('UT-ATS214-037: an empty selection has nothing gone', () => {
  const diffs = selectionDiffs(CATALOGUE, []);
  assert.deepEqual(diffs.gone, []);
  assert.deepEqual(diffs.stale, []);
  assert.deepEqual(diffs.moved, []);
  assert.equal(diffs.ok, true);
  assert.equal(diffs.count, 0);
});

test('UT-ATS214-042: a uid that now names a DIFFERENT case is REPORTED', () => {
  // The snapshot says u1 was 「用户登录」 in tests/login.spec.ts. The
  // catalogue now says u1 is 「其他用例」 -- the uid resolved, but to the
  // WRONG case. That is worse than not resolving at all, so it is
  // reported.
  const snapshot = { cases: [{ uid: 'u1', title: '用户登录', file: 'tests/login.spec.ts' }] };
  const moved = CATALOGUE.map((t) => (t.uid === 'u1' ? { ...t, title: '其他用例' } : t));
  const diffs = selectionDiffs(moved, ['u1'], snapshot);
  assert.deepEqual(diffs.gone, [], 'the uid still resolves');
  assert.deepEqual(diffs.moved, ['u1'], 'but it names another case now');
  assert.equal(diffs.ok, false, 'the selection does NOT map accurately');
});

test('UT-ATS214-043: a uid that still names the SAME case is not moved', () => {
  const snapshot = { cases: [{ uid: 'u1', title: '用户登录', file: 'tests/login.spec.ts' }] };
  const diffs = selectionDiffs(CATALOGUE, ['u1'], snapshot);
  assert.deepEqual(diffs.moved, []);
  assert.equal(diffs.ok, true);
});

test('UT-ATS214-044: a case whose identity is not stable is reported as stale', () => {
  // A provisional uid (assigned by ORDINAL) is not stable: deleting the
  // case before it shifts the ones after it.
  const withProvisional = CATALOGUE.map((t) => (t.uid === 'u1' ? { ...t, uidStable: false } : t));
  const diffs = selectionDiffs(withProvisional, ['u1', 'u2']);
  assert.deepEqual(diffs.stale, ['u1']);
  assert.deepEqual(diffs.gone, []);
  assert.equal(diffs.count, 1);
});

test('UT-ATS214-038: a selection of cases in ONE file will run EVERY case of that file', () => {
  // The engine takes one test-file filter, and a file filter runs the
  // whole file. So ticking one case of a three-case file runs three.
  const plan = plannedExecutions(CATALOGUE, ['u1']);
  assert.equal(plan.selected, 1);
  assert.equal(plan.willRun, 3, 'the whole file will run');
  assert.deepEqual(plan.files, ['tests/login.spec.ts']);
  assert.equal(plan.extra.length, 2, 'the other two cases of the file are reported as extra');
  assert.ok(!plan.extra.includes('u1'));
});

test('UT-ATS214-039: a selection of TWO files will run the cases of BOTH', () => {
  // u1 is in the login file (3 cases), u4 in the cart file (3 cases).
  const plan = plannedExecutions(CATALOGUE, ['u1', 'u4']);
  assert.equal(plan.selected, 2);
  assert.equal(plan.willRun, 6, 'three cases of the login file plus three of the cart file');
  assert.deepEqual(plan.files.slice().sort(), ['tests/cart.spec.ts', 'tests/login.spec.ts']);
});

test('UT-ATS214-040: the plan of an empty selection runs nothing', () => {
  const plan = plannedExecutions(CATALOGUE, []);
  assert.equal(plan.selected, 0);
  assert.equal(plan.willRun, 0);
  assert.deepEqual(plan.files, []);
  assert.deepEqual(plan.extra, []);
});

test('UT-ATS214-041: the plan ignores a uid that is not in the catalogue', () => {
  // A uid that has left the catalogue contributes no file, so it cannot
  // make the plan claim a run that will not happen.
  const plan = plannedExecutions(CATALOGUE, ['gone-1']);
  assert.equal(plan.selected, 1);
  assert.equal(plan.willRun, 0);
  assert.deepEqual(plan.files, []);
});
