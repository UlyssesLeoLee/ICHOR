/**
 * ATS-214 -- the CASE SEARCH / TAG / FILTER / SELECTION module.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The ACCEPTANCE CRITERION of this task is the one the WBS row (the
 * 「开发WBS」 sheet, row 35) and the issue state:
 *
 *   「500 用例过滤无明显阻塞；选中准确映射 UID」
 *
 *   ("filtering 500 cases has no obvious blocking; the selection maps
 *    to the UIDs accurately")
 *
 * Two clauses, and BOTH of them are about what a reader can observe:
 *
 *   1. 500 CASES, NO OBVIOUS BLOCKING. The catalogue of a real project
 *      has hundreds of cases; filtering them has to stay responsive,
 *      and the list has to remain visible and clickable while it does.
 *      The measurement is in `docs/evidence/ATS-214/10-st-500-cases.log`
 *      (real Chromium, 500 cases in 50 files, 1440x900).
 *
 *   2. THE SELECTION MAPS TO THE UIDs ACCURATELY. What the user ticked
 *      is a SET OF UIDS, and the batch run must carry exactly that set
 *      -- no case silently dropped, no case silently added, and a case
 *      that has LEFT the catalogue reported rather than skipped.
 *
 * The four clauses that the FIRST delivery of this task checked were
 * the search semantics, the tag semantics, the set semantics and the
 * reproducibility of the selection. They are still implemented here and
 * still covered by the unit tests -- but they are NOT the acceptance
 * criterion, and the design doc no longer claims that they are.
 *
 * The semantics live in ONE place -- here -- and the two user
 * interfaces import this one module, so the two interfaces cannot
 * disagree about what the list shows.
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
 * THE SET SEMANTICS (the composition of the criteria)
 * ----------------------------------------------------
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
 * THE TAG SEMANTICS (must be stated, not guessed)
 * -------------------------------------------------
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
 * THE SELECTION (maps to the UIDs accurately)
 * --------------------------------------------
 * A selection is a SET of case uids. It is stored, not derived: the set is
 * snapshotted at the moment the batch run starts, and the snapshot is
 * what the run record carries. So "what did I select" and "what ran"
 * are two facts that can be compared -- and a selection that is recomputed
 * from the catalogue at read time could drift (the catalogue is re-read
 * on every poll, and a case may have been renamed or removed since).
 *
 * `selectionSnapshot()` therefore produces a SELF-CONTAINED record: the
 * uids, plus the file/title/line of each selected case, so the record is
 * readable on its own even after the catalogue changed. And
 * `reconcileSelection()` compares the selected set against the set that
 * actually ran, and REPORTS the difference -- it does not smooth it away.
 *
 * `selectionDiffs()` answers the question the UI must ask BEFORE it
 * submits: which of the ticked uids are no longer in the catalogue? A
 * selection that silently loses a case is a selection that no longer
 * maps to the UIDs the user picked.
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
 * The RECONCILIATION of a selection against what ran.
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

/**
 * The DIFFERENCE between a selection and the catalogue it was made in.
 *
 * The acceptance criterion of this task is 「选中准确映射 UID」 -- the
 * selection maps to the UIDs accurately. A selection stops mapping
 * accurately the moment a ticked case LEAVES the catalogue: the case was
 * renamed, moved or deleted, and the catalogue no longer knows the uid.
 *
 * The UI must not discover that by submitting the run and reading the
 * refusal -- by then the reader has already been told "run submitted"
 * and the batch is a partial execution. So the difference is computed
 * HERE, against the catalogue, and the UI asks before it submits.
 *
 * The two lists are:
 *
 *   * `gone`   -- the ticked uids the catalogue does not know. These are
 *                the cases that would be SILENTLY DROPPED;
 *   * `stale`  -- the ticked uids the catalogue knows, but whose identity
 *                is not stable (`uidStable === false`). A provisional uid
 *                is assigned by ORDINAL, so deleting the case before it
 *                shifts the ones after it: the uid still resolves, but it
 *                now names a DIFFERENT case. That is a selection that no
 *                longer maps to the case the reader ticked, so it is
 *                reported as well.
 *
 * @param {CaseView[]} tests the catalogue
 * @param {string[]} uids the ticked uids
 * @param {{cases?:{uid?:string,title?:string,file?:string}[]}} [snapshot] the
 *        selection's own snapshot, so a re-pointed uid can be detected by
 *        comparing the case the uid names NOW with the case it named THEN
 * @returns {{gone:string[],stale:string[],moved:string[],ok:boolean,count:number}}
 */
export function selectionDiffs(tests, uids, snapshot = null) {
  const list = Array.isArray(tests) ? tests : [];
  const byUid = new Map(list.map((t) => [t.uid, t]));
  const wanted = selectionSet(uids);
  const gone = [];
  const stale = [];
  const moved = [];
  // The facts of the selection at the moment it was made, so a uid that
  // now names a DIFFERENT case can be told from one that still names
  // the same one.
  const was = new Map();
  for (const c of snapshot?.cases ?? []) was.set(c.uid, c);
  for (const uid of wanted) {
    const t = byUid.get(uid);
    if (!t) { gone.push(uid); continue; }
    // A case that is still in the catalogue but carries a warning is one
    // whose identity the index could not resolve -- it is not gone, but
    // it is not a stable uid either.
    if (t.uidStable === false) stale.push(uid);
    // The uid now names a case whose title or file is NOT the one it
    // named when the reader ticked it. The uid resolved, but to the
    // WRONG case -- which is worse than not resolving at all.
    const before = was.get(uid);
    if (before) {
      const sameTitle = !before.title || before.title === t.title;
      const sameFile = !before.file || before.file === t.file;
      if (!sameTitle || !sameFile) moved.push(uid);
    }
  }
  return {
    gone,
    stale,
    moved,
    // The selection maps accurately when nothing is gone and nothing
    // re-pointed.
    ok: gone.length === 0 && moved.length === 0,
    count: gone.length + stale.length + moved.length,
  };
}

/**
 * How many cases a selection will ACTUALLY run.
 *
 * The engine takes ONE test-file filter at a time, so a selection is
 * executed as one run per file -- and a file filter runs EVERY case of
 * that file, not only the ones that were ticked. So the number of cases
 * that will really run is the number of cases in the SELECTED FILES, and
 * it is usually LARGER than the number of ticked cases.
 *
 * The UI must say so BEFORE the run: a toast that says "1 case" while
 * the engine runs 3 is a promise the product does not keep. This
 * function is the number the UI shows.
 *
 * @param {CaseView[]} tests the catalogue
 * @param {string[]} uids the ticked uids
 * @returns {{selected:number,willRun:number,files:string[],extra:string[]}}
 */
export function plannedExecutions(tests, uids) {
  const list = Array.isArray(tests) ? tests : [];
  const byUid = new Map(list.map((t) => [t.uid, t]));
  const wanted = selectionSet(uids);
  const files = new Set();
  const ticked = new Set();
  for (const uid of wanted) {
    const t = byUid.get(uid);
    if (!t) continue;
    ticked.add(uid);
    if (t.file) files.add(t.file);
  }
  // Every case of every selected FILE will run -- that is what a file
  // filter means.
  const willRun = list.filter((t) => files.has(t.file));
  const extra = willRun.filter((t) => !ticked.has(t.uid)).map((t) => t.uid);
  return {
    selected: wanted.size,
    willRun: willRun.length,
    files: [...files],
    extra,
  };
}
