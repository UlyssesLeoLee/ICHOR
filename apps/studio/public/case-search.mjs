/**
 * ATS-214 -- the CASE SEARCH / TAG / FILTER / SELECTION module.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The acceptance criterion of this task is four sentences:
 *
 *   1. 「能按用例名 / 文件 / 标签检索，检索结果与用例清单一致」
 *      ("search by case name / file / tag; the result agrees with the case list")
 *   2. 「能按标签过滤，标签口径要写清（多标签是「任一」还是「全部」）」
 *      ("filter by tag; the tag semantics must be stated -- is a multi-tag
 *       selection 'any' or 'all'?")
 *   3. 「过滤条件与搜索条件叠加时，结果必须符合集合语义」
 *      ("a filter and a search composed together must obey SET semantics")
 *   4. 「选中多个用例后能发起批量运行；选择集合要能被复现」
 *      ("select several cases, start a batch run; the selection must be
 *       reproducible")
 *
 * Three of the four are requirements about SEMANTICS rather than about code:
 * the reader has to be able to predict what the list will show. So the
 * semantics live in ONE place -- here -- and the two user interfaces import
 * this one module.
 *
 * WHY THE FILE LIVES IN `public/`
 * -------------------------------
 * There are TWO user interfaces in this repository: the Next.js workbench
 * (`apps/studio/app/page.tsx`) and the zero-dependency portable UI
 * (`apps/studio/public/fallback.html`). Both show a case list.
 *
 * The Bridge serves static files from `apps/studio/out` and
 * `apps/studio/public` (`server/index.mjs` -> `staticFile()`), so a module
 * under `public/` is reachable by the portable UI at a stable URL. Putting
 * the ONE implementation here means the two interfaces cannot drift apart:
 * the portable UI imports exactly the code the Next app imports. (This is
 * the same rule `quality.mjs` (ATS-216) and `evidence-workbench.mjs`
 * (ATS-215) follow.)
 *
 * The module is PLAIN ECMASCRIPT MODULE with JSDoc types, so it is
 *   * importable by the Next app (TypeScript reads the JSDoc),
 *   * importable by Node's test runner (`node --test`),
 *   * importable by the portable UI in the browser (ES modules),
 * without a build step of its own.
 *
 * THE SET SEMANTICS (clause 3 -- the one most easily got wrong)
 * ---------------------------------------------------------------
 * The result of the catalogue is the INTERSECTION of the independent
 * criteria:
 *
 *     result = search  AND  tag  AND  file  AND  status
 *
 * Every criterion is a SET of cases, and the result is their intersection.
 * It is NOT a union, and a later criterion does NOT replace an earlier one.
 *
 * The concrete mistake this guards against: a filter that replaces the
 * search (so that clearing the tag filter also clears the text query), or
 * a union (so that a tag filter WIDENS the list instead of narrowing it).
 * Both are wrong, and both are silent -- the list still looks plausible.
 *
 * `filterCases()` therefore computes every criterion as its own set and
 * intersects them. `describeFilter()` reports the criteria SEPARATELY, so
 * a reader can see which one narrowed the list and by how much -- the
 * list alone cannot tell "nothing matched" from "the intersection was
 * empty".
 *
 * THE TAG SEMANTICS (clause 2 -- must be stated, not guessed)
 * ----------------------------------------------------------
 * A tag filter over several tags has two possible readings, and a UI that
 * does not say which one it uses is lying by omission:
 *
 *   * `any`  -- the case carries AT LEAST ONE of the selected tags
 *               (the union of the tag sets);
 *   * `all`  -- the case carries EVERY selected tag
 *               (the intersection of the tag sets).
 *
 * This module implements BOTH and makes the caller name the mode. The
 * DEFAULT is `any`: a tag filter is a "show me the things marked like
 * this" affordance, and the union is what a reader of the tag list
 * expects when they tick two tags. The mode is reported in
 * `describeFilter()` so the UI can LABEL it ("任一" / "全部") rather
 * than leaving the reader to guess.
 *
 * A tag is compared CASE-INSENSITIVELY, because a tag is a label and
 * `Smoke` and `smoke` are the same label to a human. The '@' prefix is
 * NOT part of the tag: Playwright requires the author to write '@smoke'
 * but the engine reports the tag as 'smoke' (measured -- see
 * `docs/32-CASE-SEARCH-SELECTION.md` §3). A user who types '@smoke' must
 * still find the tag, so the leading '@' is stripped from BOTH sides
 * before comparing.
 *
 * THE SELECTION (clause 4 -- reproducible)
 * -----------------------------------------
 * A selection is a SET of case uids. It is stored, not derived: the set is
 * snapshotted at the moment the batch run starts, and the snapshot is
 * what the run record carries. So "what did I select" and "what ran" are
 * two facts that can be compared -- and a selection that is recomputed
 * from the catalogue at read time could drift (the catalogue is re-read
 * on every poll, and a case may have been renamed or removed since).
 *
 * `selectionSnapshot()` therefore produces a SELF-CONTAINED record: the
 * uids, plus the file/title/line of each selected case, so the record is
 * readable on its own even after the catalogue changed. And
 * `reconcileSelection()` compares the selected set against the set that
 * actually ran, and REPORTS the difference -- it does not smooth it away.
 */

/* ------------------------------------------------------------------ */
/* The vocabulary                                                      */
/* ------------------------------------------------------------------ */

/**
 * The tag modes. The mode is named by the caller and reported back, so a
 * reader is never left guessing which one the list used.
 */
export const TAG_MODE = Object.freeze({
  /** The case carries AT LEAST ONE of the selected tags. */
  ANY: 'any',
  /** The case carries EVERY selected tag. */
  ALL: 'all',
});

/** The mode used when the caller does not name one. */
export const DEFAULT_TAG_MODE = TAG_MODE.ANY;

/**
 * A CASE of the catalogue, as the search module sees it.
 *
 * The type is declared with JSDoc so that the Next app (which reads the
 * JSDoc) gets the same precision the Node tests get: without it the
 * result of `filterCases()` would be an array of `object`, and every
 * field of a case would be `any`.
 *
 * @typedef {object} CaseView
 * @property {string} uid    the stable identifier of the case
 * @property {string} title  the title of the case
 * @property {string} file   the file the case lives in
 * @property {number} line   the line of the case's call
 * @property {string[]} [tags] the tags of the case
 */

/**
 * The criterion kinds. They are reported separately so that a reader can
 * see which criterion narrowed the list.
 */
export const CRITERION = Object.freeze({
  SEARCH: 'search',
  TAG: 'tag',
  FILE: 'file',
  STATUS: 'status',
});

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * The comparable form of a tag.
 *
 * The '@' is stripped and the case is folded: a tag is a LABEL, and
 * `Smoke`, `smoke` and `@smoke` are one label to a human. The engine
 * itself requires the '@' in the source but does not report it (the
 * measured behaviour of `playwright test --list`), so stripping it on
 * BOTH sides is what makes a typed '@smoke' find the reported 'smoke'.
 *
 * The leading '@' is stripped ONCE and only at the start: a tag like
 * '@@weird' keeps one '@', and a tag that is only '@' becomes the empty
 * string -- which is the one value the caller must not treat as a tag.
 */
export function normalizeTag(tag) {
  const raw = String(tag ?? '').trim();
  if (!raw) return '';
  const withoutPrefix = raw.startsWith('@') ? raw.slice(1) : raw;
  return withoutPrefix.trim().toLowerCase();
}

/**
 * The comparable form of a case's tag list: normalised, de-duplicated and
 * in a stable order, so that two catalogues that carry the same tags
 * produce the same list.
 */
export function normalizeTags(tags) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(tags) ? tags : []) {
    const n = normalizeTag(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort();
  return out;
}

/**
 * The text a case is searched in: its title, its file and its tags.
 *
 * All three are searched with ONE rule -- a case-insensitive substring
 * match -- because the criterion says "by case name / file / tag". The
 * three fields are searched TOGETHER rather than as three separate
 * criteria: a user who types "smoke" is looking for the cases tagged
 * smoke, whichever file they live in, and a user who types a file name
 * wants the cases in it.
 */
/**
 * @param {CaseView} test
 * @returns {string} the lower-cased text the case is searched in
 */
export function searchHaystack(test) {
  const parts = [test?.title ?? '', test?.file ?? ''];
  const tags = Array.isArray(test?.tags) ? test.tags : [];
  for (const t of tags) parts.push(String(t));
  return parts.join('\n').toLowerCase();
}

/* ------------------------------------------------------------------ */
/* The criteria                                                        */
/* ------------------------------------------------------------------ */

/**
 * The set of cases the SEARCH criterion keeps.
 *
 * An empty query keeps EVERYTHING: a search box that is empty is not a
 * filter, and treating it as one would make the catalogue empty until the
 * user types something.
 *
 * @param {CaseView[]} tests
 * @param {string} query
 * @returns {Set<string>} the uids the criterion keeps
 */
export function searchSet(tests, query) {
  const q = String(query ?? '').trim().toLowerCase();
  const keep = new Set();
  for (const t of tests ?? []) {
    if (!q) { keep.add(t.uid); continue; }
    if (searchHaystack(t).includes(q)) keep.add(t.uid);
  }
  return keep;
}

/**
 * The set of cases the TAG criterion keeps.
 *
 * `any` keeps the cases that carry AT LEAST ONE of the tags (the union);
 * `all` keeps the cases that carry EVERY tag (the intersection). An
 * empty tag list keeps everything -- no tag criterion was stated.
 *
 * @param {CaseView[]} tests
 * @param {string[]} tags
 * @param {'any'|'all'} [mode]
 * @returns {Set<string>}
 */
export function tagSet(tests, tags, mode = DEFAULT_TAG_MODE) {
  const wanted = (Array.isArray(tags) ? tags : []).map(normalizeTag).filter(Boolean);
  const keep = new Set();
  for (const t of tests ?? []) {
    if (!wanted.length) { keep.add(t.uid); continue; }
    const own = new Set(normalizeTags(t.tags));
    const matched = mode === TAG_MODE.ALL
      ? wanted.every((w) => own.has(w))
      : wanted.some((w) => own.has(w));
    if (matched) keep.add(t.uid);
  }
  return keep;
}

/**
 * The set of cases the FILE criterion keeps.
 *
 * The file is compared as a SUBSTRING of the case's file, because the
 * user types a fragment of a path. An empty list keeps everything.
 */
/**
 * @param {CaseView[]} tests
 * @param {string[]} files
 * @returns {Set<string>}
 */
export function fileSet(tests, files) {
  const wanted = (Array.isArray(files) ? files : []).map((f) => String(f ?? '').trim().toLowerCase()).filter(Boolean);
  const keep = new Set();
  for (const t of tests ?? []) {
    if (!wanted.length) { keep.add(t.uid); continue; }
    const file = String(t.file ?? '').toLowerCase();
    if (wanted.some((w) => file.includes(w))) keep.add(t.uid);
  }
  return keep;
}

/**
 * The set of cases the STATUS criterion keeps.
 *
 * The status of a case is not a property of the catalogue -- a case has
 * no status until it has run. So this criterion reads the status from the
 * OPTIONAL `statusOf` callback: a UI that knows the last run's status
 * passes one, and a UI that does not simply does not use this criterion.
 * A case with no known status is KEPT when the criterion is not used and
 * is EXCLUDED when it is used and no status is known -- "show me the
 * failed ones" must not show the ones whose result nobody knows.
 */
/**
 * @param {CaseView[]} tests
 * @param {string[]} statuses
 * @param {(t:CaseView)=>string} [statusOf]
 * @returns {Set<string>}
 */
export function statusSet(tests, statuses, statusOf) {
  const wanted = (Array.isArray(statuses) ? statuses : []).map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean);
  const keep = new Set();
  for (const t of tests ?? []) {
    if (!wanted.length) { keep.add(t.uid); continue; }
    const status = typeof statusOf === 'function' ? String(statusOf(t) ?? '').toLowerCase() : '';
    if (status && wanted.includes(status)) keep.add(t.uid);
  }
  return keep;
}

/* ------------------------------------------------------------------ */
/* The composition                                                     */
/* ------------------------------------------------------------------ */

/**
 * The filter of a case list: the search query, the tag criterion, the
 * file criterion and the status criterion.
 *
 * @typedef {object} CaseFilter
 * @property {string} query      the free-text query
 * @property {string[]} tags     the selected tags
 * @property {'any'|'all'} tagMode
 * @property {string[]} files    the selected files
 * @property {string[]} statuses the selected statuses
 */

/**
 * An EMPTY filter. Every criterion keeps everything, so the result is the
 * whole catalogue.
 */
export const emptyFilter = () => ({ query: '', tags: [], tagMode: DEFAULT_TAG_MODE, files: [], statuses: [] });

/**
 * The criteria of a filter, each as its OWN set.
 *
 * This is the heart of clause 3: the criteria are computed SEPARATELY and
 * then intersected. Computing them separately is also what makes
 * `describeFilter()` possible -- it can report how much each criterion
 * narrowed the list, which the final list alone cannot tell you.
 */
/**
 * @template {CaseView} T
 * @param {T[]} tests
 * @param {CaseFilter} [filter]
 * @param {{statusOf?:(t:T)=>string}} [opts]
 * @returns {{search:Set<string>,tag:Set<string>,file:Set<string>,status:Set<string>}}
 */
export function criterionSets(tests, filter, { statusOf } = {}) {
  const f = filter ?? emptyFilter();
  return {
    search: searchSet(tests, f.query),
    tag: tagSet(tests, f.tags, f.tagMode ?? DEFAULT_TAG_MODE),
    file: fileSet(tests, f.files),
    status: statusSet(tests, f.statuses, statusOf),
  };
}

/**
 * The cases that satisfy EVERY criterion: the INTERSECTION of the
 * criteria's sets.
 *
 * The order of the result is the order of the catalogue: the list is a
 * filtered VIEW of the catalogue, not a re-sorted list, so that the
 * order the user sees does not change when a filter is applied.
 */
/**
 * The result keeps the caller's OWN case type: the module reads the
 * fields the criteria need and returns the same objects it was given, so
 * a caller that has a richer case (the Next app's `TestDef`) gets that
 * richer case back -- not a widened one.
 *
 * @template {CaseView} T
 * @param {T[]} tests
 * @param {CaseFilter} [filter]
 * @param {{statusOf?:(t:T)=>string}} [opts]
 * @returns {T[]}
 */
export function filterCases(tests, filter, { statusOf } = {}) {
  const list = Array.isArray(tests) ? tests : [];
  const sets = criterionSets(list, filter, { statusOf });
  const keep = new Set();
  for (const t of list) {
    if (sets.search.has(t.uid) && sets.tag.has(t.uid) && sets.file.has(t.uid) && sets.status.has(t.uid)) keep.add(t.uid);
  }
  return list.filter((t) => keep.has(t.uid));
}

/**
 * What the filter did, in a form a reader (and a UI) can show.
 *
 * Every criterion is reported with the number of cases it kept ON ITS
 * OWN, so the composition is visible: a search that keeps 3 of 500 and a
 * tag filter that keeps 40 of 500 intersect to at most 3 -- and when the
 * intersection is empty while neither set is, the reader can see that the
 * criteria disagreed rather than that "nothing matched".
 */
/**
 * @template {CaseView} T
 * @param {T[]} tests
 * @param {CaseFilter} [filter]
 * @param {{statusOf?:(t:T)=>string}} [opts]
 */
export function describeFilter(tests, filter, { statusOf } = {}) {
  const list = Array.isArray(tests) ? tests : [];
  const f = filter ?? emptyFilter();
  const sets = criterionSets(list, f, { statusOf });
  const result = filterCases(list, f, { statusOf });
  const criteria = [
    { kind: CRITERION.SEARCH, value: f.query ?? '', kept: sets.search.size, active: Boolean(String(f.query ?? '').trim()) },
    { kind: CRITERION.TAG, value: (f.tags ?? []).join(', '), mode: f.tagMode ?? DEFAULT_TAG_MODE, kept: sets.tag.size, active: (f.tags ?? []).length > 0 },
    { kind: CRITERION.FILE, value: (f.files ?? []).join(', '), kept: sets.file.size, active: (f.files ?? []).length > 0 },
    { kind: CRITERION.STATUS, value: (f.statuses ?? []).join(', '), kept: sets.status.size, active: (f.statuses ?? []).length > 0 },
  ];
  return {
    total: list.length,
    matched: result.length,
    // The criteria are reported in the order they were stated, and each
    // one says whether it was ACTIVE -- a criterion that was not stated
    // keeps everything and must not be read as a filter that narrowed it.
    criteria,
    tagMode: f.tagMode ?? DEFAULT_TAG_MODE,
    // The ids of the cases that survived, so a caller can assert on the
    // SET rather than on the rendering of it.
    uids: result.map((t) => t.uid),
  };
}

/* ------------------------------------------------------------------ */
/* The tag vocabulary of the catalogue                                 */
/* ------------------------------------------------------------------ */

/**
 * Every tag of the catalogue, with the number of cases that carry it.
 *
 * The count matters: a tag that no case carries is a tag the filter
 * would silently drop, and a reader who ticked it would wonder why the
 * list did not change. So the vocabulary only offers tags that carry at
 * least one case.
 *
 * The tags are sorted by their count (descending) and then by name, so
 * the most used tag is the first one a reader sees.
 */
/**
 * @param {CaseView[]} tests
 * @returns {{tag:string,count:number}[]}
 */
export function tagVocabulary(tests) {
  const counts = new Map();
  for (const t of Array.isArray(tests) ? tests : []) {
    for (const tag of normalizeTags(t.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/**
 * The files of the catalogue, with the number of cases in each.
 */
/**
 * @param {CaseView[]} tests
 * @returns {{file:string,count:number}[]}
 */
export function fileVocabulary(tests) {
  const counts = new Map();
  for (const t of Array.isArray(tests) ? tests : []) {
    const file = String(t.file ?? '');
    if (!file) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => (b.count - a.count) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/* ------------------------------------------------------------------ */
/* The selection                                                       */
/* ------------------------------------------------------------------ */

/**
 * The selection: a set of case uids.
 *
 * The selection is a SET, so the order the user ticked the cases in is
 * not part of it -- but the SNAPSHOT below keeps a stable order (the
 * catalogue's) so that two identical selections produce identical
 * records.
 */
export function selectionSet(uids) {
  return new Set((Array.isArray(uids) ? uids : []).map((u) => String(u ?? '')).filter(Boolean));
}

/**
 * The SNAPSHOT of a selection: the cases that were selected, with the
 * facts a reader needs to check the record without the catalogue.
 *
 * The snapshot is SELF-CONTAINED on purpose. The catalogue is re-read on
 * every poll and a case may have been renamed, moved or removed since the
 * selection was made; a record that only carried uids would then be a
 * list of identifiers nobody can read. So the snapshot carries the file,
 * the title and the line of each selected case as well.
 *
 * A uid that is NOT in the catalogue is REFUSED, not skipped: the caller
 * passes the catalogue and the uids, and a uid the catalogue does not
 * know is a fact the caller got wrong (a stale selection, a case that
 * was deleted, a typo). Skipping it silently would produce a run that
 * covers fewer cases than the user asked for -- and the record would say
 * it covered all of them.
 *
 * @param {CaseView[]} tests   the catalogue
 * @param {string[]} uids     the selected uids
 * @param {{now?:string}} [opts]
 * @returns {{uids:string[],cases:{uid:string,file:string,title:string,line:number|null}[],count:number,unknown:string[]}}
 */
/**
 * @param {CaseView[]} tests
 * @param {string[]} uids
 * @param {{now?:string}} [opts]
 * @returns {{uids:string[],cases:{uid:string,file:string,title:string,line:number|null}[],count:number,unknown:string[],at?:string}}
 */
export function selectionSnapshot(tests, uids, { now = null } = {}) {
  const list = Array.isArray(tests) ? tests : [];
  const byUid = new Map(list.map((t) => [t.uid, t]));
  const wanted = selectionSet(uids);
  const unknown = [...wanted].filter((u) => !byUid.has(u));
  const cases = list
    .filter((t) => wanted.has(t.uid))
    .map((t) => ({ uid: t.uid, file: t.file ?? '', title: t.title ?? '', line: Number.isInteger(t.line) ? t.line : null }));
  return {
    uids: cases.map((c) => c.uid),
    cases,
    count: cases.length,
    // The uids the catalogue does not know are REPORTED, so the caller can
    // refuse the selection instead of running fewer cases than asked.
    unknown,
    ...(now ? { at: now } : {}),
  };
}

/**
 * The groups of a selection by FILE.
 *
 * The engine takes ONE test-file filter at a time (ATS-106's argument
 * baseline: at most one positional filter), so a selection that spans
 * several files has to be executed as one run per file. The grouping is
 * therefore part of the selection's meaning, and it is reported here so
 * the caller and the run record agree on it.
 */
/**
 * @param {{cases:{uid:string,file:string}[]}} snapshot
 * @returns {{file:string,uids:string[],count:number}[]}
 */
export function selectionByFile(snapshot) {
  const groups = new Map();
  for (const c of snapshot?.cases ?? []) {
    if (!groups.has(c.file)) groups.set(c.file, []);
    groups.get(c.file).push(c);
  }
  return [...groups.entries()].map(([file, cases]) => ({ file, uids: cases.map((c) => c.uid), count: cases.length }));
}

/**
 * The RECONCILIATION of a selection against what actually ran.
 *
 * 「选了什么、跑了什么，两边对得上」 -- what was selected and what ran must
 * agree. This is the comparison that makes the two facts checkable: the
 * selection says which cases the user asked for, and the executed uids
 * say which cases the engine reported.
 *
 * The DIFFERENCE is reported, never smoothed away:
 *
 *   * `missing`  -- the cases that were selected but that no attempt ran.
 *                   Either the engine did not run them, or the identity
 *                   mapper could not bind an attempt to them (an
 *                   unattributable attempt is a fact about the mapper,
 *                   not about the selection);
 *   * `extra`    -- the attempts that ran a case that was NOT selected.
 *                   The engine may have run more than the selection asks
 *                   for -- a file filter runs every case of the file --
 *                   and the reader has to see that.
 *
 * @param {{uids:string[]}} snapshot the selection snapshot
 * @param {string[]} executedUids the uids the attempts of the run carry
 */
/**
 * @param {{uids:string[]}} snapshot
 * @param {string[]} executedUids
 * @returns {{selected:number,executed:number,missing:string[],extra:string[],matches:boolean,exact:boolean}}
 */
export function reconcileSelection(snapshot, executedUids) {
  const selected = selectionSet(snapshot?.uids ?? []);
  const executed = selectionSet(executedUids);
  const missing = [...selected].filter((u) => !executed.has(u));
  const extra = [...executed].filter((u) => !selected.has(u));
  return {
    selected: selected.size,
    executed: executed.size,
    missing,
    extra,
    // The selection is REPRODUCIBLE when every selected case ran. An
    // attempt that ran an unselected case does not break reproducibility
    // -- the selection is still exactly the set the user chose -- but it
    // is reported, because "I selected 3 and 5 ran" is a fact the reader
    // needs.
    matches: missing.length === 0,
    exact: missing.length === 0 && extra.length === 0,
  };
}
