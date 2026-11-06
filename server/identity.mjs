/**
 * ATS-204: the identity mapper.
 *
 * A test case is the same case when it is still recognisable after the
 * repository moved on: the file was renamed, the title was rewritten, a
 * template was re-parameterised. The UID is what carries the links (a
 * requirement, an old run, an archived piece of evidence) across those
 * changes -- and a UID handed to the WRONG case breaks every link
 * silently, which is worse than losing a link.
 *
 * This module holds the two decisions the product has to make about the
 * identity of a case, and the discipline both of them follow:
 *
 *   * `bindReported()` -- the RUN side. A report names a case by file,
 *     title and line; the mapper decides which TestDefinition that is.
 *   * `reidentifyRendered()` -- the DISCOVERY side. A case the static
 *     scanner cannot see (a loop, a helper, a fixture) has no body of its
 *     own, so it is identified by the POSITION it was generated from and
 *     by the ORDER it was generated in.
 *
 * THE DISCIPLINE
 * --------------
 *
 *   1. A signal that is NOT unique never decides. When several entries
 *      could be the case, the mapper reports the candidates and binds
 *      NOTHING. Binding an arbitrary one of them is a mis-association, and
 *      a mis-association is invisible: the report still looks complete.
 *   2. A signal is used only when it is STRONGER than the ones before it.
 *      The position of a case is weaker than its body: a case inserted
 *      above shifts every line below it. The body is stronger than the
 *      title: the title is rewritten often, the body rarely.
 *   3. Nothing is decided by the title alone when the title is not
 *      unique in the project.
 *
 * THE SIGNALS OF THE RUN SIDE, FROM THE STRONGEST TO THE WEAKEST
 * ---------------------------------------------------------------
 *
 *   | # | signal                             | survives                |
 *   |---|------------------------------------|-------------------------|
 *   | 1 | the explicit annotation `@TC-<x>`  | everything              |
 *   | 2 | the file, the describe path, title | a move inside a file    |
 *   | 3 | the file, the line, the title      | a retitle               |
 *   | 4 | the file, the title                | a move inside a file    |
 *   | 5 | the body fingerprint               | a rename + a retitle    |
 *   | 6 | the alias (the OLD file + title)   | a move back             |
 *   | 7 | the title alone                    | a move to another file  |
 *
 * Signal 5 is what the run binding did not have: the registry remembers
 * the FINGERPRINT of the body, and the fingerprint does not change when
 * the file is renamed or the title is rewritten. It is used only when the
 * fingerprint is unique -- among the registry entries AND among the cases
 * of the run being bound, because a body that two cases of the same run
 * share identifies neither of them.
 *
 * Signal 6 is the alias: the registry records the OLD spelling of a case
 * when the case moves, so that a report written BEFORE the move still
 * resolves to the case it was about. The alias is only consulted when the
 * body is UNAVAILABLE -- when the body could be read and it does not
 * match, the case at that position is a DIFFERENT case, and the alias
 * must not claim it.
 *
 * THE POSITION OF A CASE
 * ----------------------
 * The position is the file, the line of the `test(` call and the describe
 * path. It is the identity of a case that has no body of its own: the
 * body the scanner would read at that position is the body of the
 * TEMPLATE the case was generated from, and that template may generate
 * more cases later. The describe path is part of the position because it
 * is part of the CLI's own identity of the case, and because two
 * templates on the same line are two different templates.
 *
 * THE ANCHOR OF A CASE
 * --------------------
 * The cases the CLI reports at ONE position are the renders of ONE
 * template, in the order the template generated them. The order is the
 * only thing that tells two renders apart -- they share the position and
 * differ only in their title.
 *
 * A render therefore carries an ANCHOR: the position plus its ordinal
 * there plus how many renders shared the position. The anchor is what
 * lets a render keep its UID when its title is rewritten (the template's
 * text changed, so every rendered title changed with it).
 *
 * THE ANCHOR NEVER OVERRIDES AN IDENTITY
 * --------------------------------------
 * The anchor is the WEAKEST of the signals, so it is used only where
 * nothing stronger applies. Three rules keep it from handing a case the
 * UID of another case:
 *
 *   1. It never decides a case the static scanner CAN see. Such a case
 *      has a body of its own, and the body (and the title) are stronger
 *      signals than an ordinal.
 *   2. It never decides a case whose title already claims a case of the
 *      registry. The title IS the identity of a render, and the anchor
 *      may only fill in what the title cannot.
 *   3. It never decides a group in which SOME of the registry's titles
 *      are still there. A partly rewritten group is a group whose
 *      ordinals may have SHIFTED: the render that is new may have taken
 *      the ordinal of one that is gone, and binding by ordinal would hand
 *      it the UID of the render that vanished. The mapper then reports
 *      the shift and binds nothing.
 *
 * The anchor is used only when the group it names has the SAME SIZE as it
 * had when the anchor was written. When the template gained or lost a
 * render, the ordinals may have shifted, and a shifted ordinal points at
 * a DIFFERENT render: the mapper then refuses to decide and reports the
 * shift, because binding a render to the wrong ordinal is exactly the
 * mis-association this module exists to prevent.
 */
import { extractExplicitUid, normalizeTitleKey } from './uid.mjs';

/** The reasons the mapper reports when it cannot decide. */
export const AMBIGUITY = Object.freeze({
  /** Several registry entries carry the body the reported case has. */
  BODY: 'ambiguous-body-match',
  /** The body is shared by several cases of the same run. */
  BODY_SHARED: 'body-shared-in-run',
  /** Several registry entries claim the same alias. */
  ALIAS: 'ambiguous-alias-match',
  /** The renders of a template changed their number, so the order shifted. */
  RENDER_SHIFT: 'render-shift-possible',
  /** Only SOME of the renders of a template were rewritten: the ordinals
   *  may have shifted, so the anchor may not decide. */
  RENDER_PARTIAL: 'render-partially-changed',
  /** Two anchors claim the same ordinal of the same position. */
  RENDER_AMBIGUOUS: 'ambiguous-render-ordinal',
  /** Several entries share the file and the title. */
  SAME_TITLE: 'identical-title',
  /** Several entries share the file, the describe path and the title. */
  SAME_SCOPE_TITLE: 'ambiguous-scope-title-match',
  /** Several entries share the file, the line and the title. */
  SAME_FILE_LINE: 'ambiguous-file-line-match',
});

/** The DISTINCT uids of a list of registry entries. */
const distinctUids = (entries) => [...new Set(entries.map((e) => e.uid).filter(Boolean))];

/** The title key of a case or of a registry entry. */
const titleKeyOf = (x) => x?.titleKey ?? normalizeTitleKey(x?.title ?? '');

/** The key of an alias: the file and the title the case used to have. */
const aliasKey = (file, title) => `${file} ${title}`;

/**
 * The entries of the registry, indexed by the body fingerprint.
 *
 * Only the entries that carry a fingerprint take part: a case without one
 * (a dynamic case, or a case whose body could not be read) cannot be
 * recognised by it.
 */
export function bodyIndex(entries) {
  const byBody = new Map();
  for (const e of entries ?? []) {
    if (!e.bodyKey || !e.uid) continue;
    if (!byBody.has(e.bodyKey)) byBody.set(e.bodyKey, []);
    byBody.get(e.bodyKey).push(e);
  }
  return byBody;
}

/**
 * The entries of the registry, indexed by their ALIASES.
 *
 * The alias is the OLD spelling of a case: the registry keeps it when the
 * case moves, so that a report written before the move still resolves to
 * the case it was about.
 */
export function aliasIndex(entries) {
  const byAlias = new Map();
  for (const e of entries ?? []) {
    if (!e.uid) continue;
    for (const a of e.aliases ?? []) {
      if (!a || typeof a.file !== 'string' || typeof a.title !== 'string') continue;
      const key = aliasKey(a.file, a.title);
      if (!byAlias.has(key)) byAlias.set(key, []);
      byAlias.get(key).push(e);
    }
  }
  return byAlias;
}

/**
 * The case of a report is bound to a TestDefinition.
 *
 * `entries`    the registry entries of the project;
 * `file`       the file of the report, relative to the project root;
 * `title`      the title of the report;
 * `line`       the line of the `test(` call, when the report carries one;
 * `scope`      the describe path of the case, when the report carries one;
 * `bodyKey`    the fingerprint of the body of THIS run's source, when it
 *               could be computed (null when the source could not be read);
 * `bodyCounts` how many of the cases of THIS RUN share that fingerprint;
 * `bodyScopeCounts` how many of the cases of THIS RUN share that
 *               fingerprint AND sit under the same describe path (the key
 *               is `<bodyKey> <scope joined by spaces>`). A body that is
 *               only shared ACROSS describes does not block the signal
 *               that uses the describe path;
 * `allowAlias` whether the alias may be used. The alias may only be used
 *               when the body is UNAVAILABLE: a body that could be read
 *               and does not match means the case at that position is a
 *               DIFFERENT case.
 *
 * The result is `{uid, basis, candidates, ambiguity}`. `uid` is null when
 * nothing decided; `basis` says what decided it, and a signal that could
 * not decide is reported as `<signal>-ambiguous` rather than resolved.
 */
export function bindReported({
  entries = [], file = null, title = '', line = null, scope = null,
  bodyKey = null, bodyCounts = null, bodyScopeCounts = null, explicitCounts = null, allowAlias = null,
} = {}) {
  const usable = (entries ?? []).filter((e) => e.uid);
  const scopePath = Array.isArray(scope) ? scope : [];
  const scopeKey = scopePath.join(' ');

  /* 1. the explicit annotation: the author wrote the uid down. */
  const explicit = extractExplicitUid(title);
  if (explicit) {
    /*
     * The token belongs to the case that carries it -- and to ONE case.
     *
     * The AUTHOR's statement decides, not the registry: the registry is
     * the memory of the past cases, and a case the registry has not seen
     * yet (a NEW case, the first time it is discovered) still owns the
     * token it carries. So the token binds when ONE case of this run
     * carries it.
     *
     * Two cases of the SAME RUN carrying it means NEITHER of them owns
     * it: only the author can say which case it belongs to.
     *
     * THE CATALOGUE'S VERDICT IS AUTHORITATIVE
     * -----------------------------------------
     * A run may cover only ONE of the two cases that carry the token --
     * a single-file run, or a run of one project. The token is then
     * unique IN THIS RUN, but it is NOT unique in the project: the
     * catalogue has already judged that neither of the two cases owns it
     * (`duplicate-explicit-uid`), and that judgement is recorded in the
     * registry entries. The run side has to agree with it: binding the
     * token here would attach the run to one of the two cases, and the
     * other one -- the case the catalogue says owns it -- would be left
     * with an identical UID.
     */
    const claimants = explicitCounts ? (explicitCounts.get(explicit) ?? 0) : 0;
    const duplicatedInProject = usable.filter((e) => e.duplicateExplicit === explicit);
    if (claimants <= 1 && duplicatedInProject.length === 0) {
      return { uid: explicit, basis: 'explicit', candidates: 1 };
    }
    return {
      uid: null,
      basis: 'explicit-ambiguous',
      candidates: Math.max(claimants, duplicatedInProject.length),
      ambiguity: { reason: 'duplicate-explicit-uid', explicitUid: explicit },
    };
  }

  const sameFile = file === null || file === undefined ? [] : usable.filter((e) => e.file === file);
  const sameFileTitle = sameFile.filter((e) => e.title === title);
  const sameTitle = usable.filter((e) => e.title === title);
  const scopeOf = (e) => (Array.isArray(e.scope) ? e.scope.join(' ') : '');

  /*
   * The file + title group. When several entries of the SAME FILE share the
   * title, the title does not identify the case and neither does the line:
   * the case that sits at the reported line today may be a different case
   * than the one that sat there when the registry was written. Only the
   * body can tell them apart -- and only when it can be computed.
   */
  const fileTitleUids = distinctUids(sameFileTitle);
  const ambiguousGroup = fileTitleUids.length > 1;

  /*
   * Is the body shared by several cases of THIS RUN?
   *
   * When it is, the fingerprint does not tell them apart, and every signal
   * that does NOT use the fingerprint must not bind them to the same uid:
   * two cases of one run carrying one uid is the silent mis-association
   * this mapper exists to prevent. The positional signals are safe -- two
   * cases that report the same file, the same describe path, the same
   * title AND the same line are the same case (a retry).
   *
   * THE DESCRIBE PATH NARROWS IT
   * ----------------------------
   * Two cases that share a body but sit under DIFFERENT describes are two
   * cases the CLI itself tells apart: `describe('a') { test('works') }` and
   * `describe('b') { test('works') }` have the same body (the template
   * they share) and the same title, and the describe path is the only
   * thing that tells them apart. So the body is only shared IN THE SCOPE
   * of the case: `bodyScopeCounts` counts the cases of the run that share
   * the fingerprint AND sit under the same describe path.
   */
  const bodySharedInScope = Boolean(bodyKey) && bodyScopeCounts
    ? (bodyScopeCounts.get(`${bodyKey} ${scopeKey}`) ?? 0) > 1
    : false;
  const bodySharedInRun = Boolean(bodyKey) && bodyCounts
    ? (bodyCounts.get(bodyKey) ?? 0) > 1
    : false;
  /**
   * The mismatch between the position and the body, when there is one.
   * It is REPORTED, but it does not stop the walk: the body signal below
   * is the one that survives a rename.
   */
  let positionMismatch = null;
  /**
   * A position that CONTRADICTS the body disables the WHOLE position
   * family -- `file-line`, `file-scope-title`, `file-title` and the bare
   * `title`. They all name the case by where it is, and the body has just
   * said that the case that is there now is a different one.
   */

  /*
   * 2. the file, the describe path and the title: the CLI's own identity.
   *
   * Like the line, the position is not an identity: it binds only when
   * the body agrees with it, or when there is no body to disagree with.
   * The check is the SAME one the line signal uses (see 3.1): a hit whose
   * body disagrees is a stale-position coincidence, and it does not bind.
   *
   * The mismatch is recorded and the walk CONTINUES: the body is the
   * signal that survives a rename, so a renamed case is exactly the case
   * whose position disagrees with its body.
   *
   * THE SCOPE SIGNAL IS NOT BLOCKED BY A SHARED BODY
   * ------------------------------------------------
   * Two cases under DIFFERENT describes that happen to share a body are
   * still two cases, and the describe path tells them apart. The shared
   * body only blocks the signals that do NOT use the describe path -- the
   * ones that would bind both of them to the same uid.
   */
  if (scopeKey && !bodySharedInScope) {
    const sameFileScopeTitle = sameFile.filter((e) => e.title === title && scopeOf(e) === scopeKey);
    const uids = distinctUids(sameFileScopeTitle);
    if (uids.length === 1) {
      const entry = sameFileScopeTitle.find((e) => e.uid === uids[0]);
      const disagrees = bodyKey && entry?.bodyKey && entry.bodyKey !== bodyKey;
      if (!disagrees) {
        return { uid: uids[0], basis: 'file-scope-title', candidates: 1 };
      }
      // The positional hit contradicts the body: the case at that
      // position is a DIFFERENT case than the one the registry remembers
      // there. The walk continues -- the body may still decide.
      positionMismatch = {
        reason: AMBIGUITY.BODY,
        candidates: uids,
      };
    } else if (uids.length > 1) {
      return {
        uid: null, basis: 'file-scope-title-ambiguous', candidates: uids.length,
        ambiguity: { reason: AMBIGUITY.SAME_SCOPE_TITLE, candidates: uids },
      };
    }
  }

  if (!ambiguousGroup) {
    /*
     * 3. the file, the line and the title.
     *
     * The line is NOT an identity: a case inserted above shifts every
     * line below it, and two same-titled cases in one file then sit on
     * each other's old lines. So when the body of the reported case COULD
     * be computed, the positional hit must AGREE with it -- a hit whose
     * body disagrees is a stale-line coincidence, and it does not bind.
     *
     * When the body could NOT be computed, the positional signal stands
     * on its own: it is the only evidence there is. The boundary is
     * reported by the basis, not hidden.
     */
    if (Number.isInteger(line) && line > 0 && !bodySharedInRun) {
      const atLine = sameFile.filter((e) => Number.isInteger(e.line) && e.line === line);
      const sameTitleAtLine = atLine.filter((e) => e.title === title);
      const agrees = bodyKey
        ? sameTitleAtLine.filter((e) => !e.bodyKey || e.bodyKey === bodyKey)
        : sameTitleAtLine;
      const uids = distinctUids(agrees);
      if (uids.length === 1) return { uid: uids[0], basis: 'file-line', candidates: 1 };
      if (uids.length > 1) {
        return {
          uid: null, basis: 'file-line-ambiguous', candidates: uids.length,
          ambiguity: { reason: AMBIGUITY.SAME_FILE_LINE, candidates: uids },
        };
      }
      if (sameTitleAtLine.length && !agrees.length) {
        // The positional hit contradicts the body: the case at that line
        // is a DIFFERENT case than the one the registry remembers there.
        //
        // The walk CONTINUES: the body is the signal that survives a
        // rename, so a renamed case is exactly the case whose position
        // disagrees with its body. The mismatch is recorded and reported
        // as the ambiguity, but it does not stop the body from deciding.
        positionMismatch = {
          reason: AMBIGUITY.BODY,
          candidates: distinctUids(sameTitleAtLine),
        };
      }
    }

    /*
     * 4. the file and the title.
     *
     * The signal is skipped when the body is shared inside the run: the
     * file and the title would then bind BOTH of the shared cases to the
     * same uid. The body signal below reports the sharing instead.
     */
    if (fileTitleUids.length === 1 && !bodySharedInRun && !positionMismatch) {
      return { uid: fileTitleUids[0], basis: 'file-title', candidates: 1 };
    }
  } else {
    /*
     * The group is ambiguous. The body decides it -- and the body is the
     * fingerprint of the source of THIS run, not the one the registry was
     * written with.
     */
    if (bodyKey) {
      const byBody = sameFileTitle.filter((e) => e.bodyKey === bodyKey);
      const uids = distinctUids(byBody);
      const sharedInRun = bodyCounts ? (bodyCounts.get(bodyKey) ?? 0) : 1;
      // A body that TWO CASES OF THE SAME RUN share identifies neither of
      // them: the two cases are the same case as far as the fingerprint
      // can tell, and binding one of them to the other's uid is a
      // mis-association.
      if (uids.length === 1 && sharedInRun === 1) {
        return { uid: uids[0], basis: 'file-title-body', candidates: 1 };
      }
      if (uids.length > 1) {
        return {
          uid: null, basis: 'file-title-ambiguous', candidates: uids.length,
          ambiguity: { reason: AMBIGUITY.BODY, candidates: uids },
        };
      }
      if (sharedInRun > 1) {
        return {
          uid: null, basis: 'file-title-body-shared', candidates: sharedInRun,
          ambiguity: { reason: AMBIGUITY.BODY_SHARED, candidates: [] },
        };
      }
      // The body could be computed and it does NOT match any entry of the
      // group: the case at that position is a DIFFERENT case than the ones
      // the registry knows there. The group stays ambiguous.
      return {
        uid: null, basis: 'file-title-body-unknown', candidates: fileTitleUids.length,
        ambiguity: { reason: AMBIGUITY.SAME_TITLE, candidates: fileTitleUids },
      };
    }
    return {
      uid: null, basis: 'file-title-ambiguous', candidates: fileTitleUids.length,
      ambiguity: { reason: AMBIGUITY.SAME_TITLE, candidates: fileTitleUids },
    };
  }

  /* 5. the body fingerprint: the only signal that survives a rename AND a retitle. */
  if (bodyKey) {
    const byBody = bodyIndex(usable).get(bodyKey) ?? [];
    const uids = distinctUids(byBody);
    const sharedInRun = bodyCounts ? (bodyCounts.get(bodyKey) ?? 0) : 1;
    if (uids.length === 1 && sharedInRun === 1) {
      return {
        uid: uids[0],
        basis: 'body-key',
        candidates: 1,
        ...(positionMismatch ? { ambiguity: positionMismatch } : {}),
      };
    }
    if (uids.length > 1) {
      return {
        uid: null, basis: 'body-key-ambiguous', candidates: uids.length,
        ambiguity: { reason: AMBIGUITY.BODY, candidates: uids },
      };
    }
    if (sharedInRun > 1) {
      return {
        uid: null, basis: 'body-key-shared', candidates: sharedInRun,
        ambiguity: { reason: AMBIGUITY.BODY_SHARED, candidates: [] },
      };
    }
    // The body identifies nothing on its own. The position that
    // contradicted it is reported here: the case stays unbound, and the
    // reader learns that the position and the body disagree.
    if (positionMismatch) {
      return {
        uid: null, basis: 'file-line-body-mismatch', candidates: positionMismatch.candidates.length,
        ambiguity: positionMismatch,
      };
    }
  }

  /* 6. the alias: the OLD spelling of the case. */
  const mayUseAlias = allowAlias === null ? !bodyKey : allowAlias;
  if (mayUseAlias && file !== null && file !== undefined) {
    const byAlias = aliasIndex(usable).get(aliasKey(file, title)) ?? [];
    const uids = distinctUids(byAlias);
    if (uids.length === 1) return { uid: uids[0], basis: 'alias', candidates: 1 };
    if (uids.length > 1) {
      return {
        uid: null, basis: 'alias-ambiguous', candidates: uids.length,
        ambiguity: { reason: AMBIGUITY.ALIAS, candidates: uids },
      };
    }
  }

  /*
   * 7. the title alone -- only when it identifies one case in the project,
   * and only when the body does not tell several cases of this run apart.
   */
  const titleUids = distinctUids(sameTitle);
  if (titleUids.length === 1 && !bodySharedInRun && !positionMismatch) {
    return { uid: titleUids[0], basis: 'title', candidates: 1 };
  }
  if (titleUids.length > 1) {
    return {
      uid: null, basis: 'title-ambiguous', candidates: titleUids.length,
      ambiguity: { reason: AMBIGUITY.SAME_TITLE, candidates: titleUids },
    };
  }

  return { uid: null, basis: 'unbound', candidates: 0 };
}

/* ------------------------------------------------------------------ */
/* The position of a case                                              */
/* ------------------------------------------------------------------ */

/**
 * The key of a POSITION: the file, the line and the describe path.
 */
export const positionKey = (file, line, scope = []) => `${file} ${line ?? ''} ${(scope ?? []).join(' ')}`;

/**
 * The cases of a discovery, grouped by the position they were reported at.
 *
 * THE ORDER INSIDE A GROUP
 * -------------------------
 * The order is the order the CLI REPORTED the cases in -- which is the
 * order the template GENERATED its renders in. That order is what the
 * anchor's ordinal counts, and it is the only order that survives a
 * change of the template's TEXT: the catalogue's display order is sorted
 * by title, and a re-worded title changes its rank.
 *
 * The report order travels with the case (`reportOrder`). A caller that
 * does not know it (a test that builds the cases by hand) keeps the order
 * it handed them in.
 */
export function groupByPosition(cases) {
  const groups = new Map();
  const list = cases ?? [];
  for (const c of list) {
    const key = positionKey(c.file, c.line, c.scope ?? []);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const oa = Number.isInteger(a?.reportOrder) ? a.reportOrder : Number.MAX_SAFE_INTEGER;
      const ob = Number.isInteger(b?.reportOrder) ? b.reportOrder : Number.MAX_SAFE_INTEGER;
      return oa - ob;
    });
  }
  return groups;
}

/**
 * The anchor of a case: the position it was reported at, its ordinal
 * inside that position and how many cases shared the position.
 *
 * The anchor is what a dynamic case is remembered BY. The count matters:
 * when the number of renders changes, the ordinals may have shifted, and a
 * shifted ordinal is a case that is NOT the one the anchor names.
 */
export function anchorOf(theCase, groups) {
  const key = positionKey(theCase.file, theCase.line, theCase.scope ?? []);
  const group = groups.get(key) ?? [];
  const ordinal = group.findIndex((c) => c === theCase);
  return {
    kind: 'position',
    file: theCase.file,
    line: theCase.line,
    scope: [...(theCase.scope ?? [])],
    ordinal: ordinal < 0 ? 0 : ordinal,
    count: group.length,
  };
}

/**
 * Re-identifies the cases that have no body of their own.
 *
 * A dynamic case (one the static scanner could not see) is remembered by
 * its ANCHOR: the position it was reported at and its ordinal there. That
 * is what lets a dynamic case keep its UID when its title is rewritten --
 * the template's text changed, so every rendered title changed with it,
 * and the title is the only thing that used to identify the case.
 *
 * THE ANCHOR IS THE WEAKEST SIGNAL, AND IT SAYS SO
 * -----------------------------------------------
 * The anchor is an ORDINAL: it says "the third render of that position".
 * That is a fact about the position, not about the case, so the anchor may
 * only FILL IN what the stronger signals cannot say. Three rules:
 *
 *   1. A case the static scanner CAN see has a body of its own. Its body
 *      (and its title) are stronger signals than an ordinal, so the anchor
 *      does not decide it at all.
 *
 *   2. A case whose title still CLAIMS a case of the registry is already
 *      identified by that title. The anchor does not decide it either: the
 *      title IS the identity of a render, and the ordinal is only its
 *      fallback.
 *
 *   3. A group in which SOME of the registry's titles are still there is a
 *      group whose ordinals may have SHIFTED. A render that was removed
 *      and a render that was added leave the same NUMBER of renders, but
 *      the new one may sit at the ordinal of the old one. Binding by
 *      ordinal would then hand the new render the UID of the one that
 *      vanished -- exactly the mis-association this module exists to
 *      prevent. The mapper reports the change and binds NOTHING.
 *
 * The anchor is used only when the group it names has the SAME SIZE as it
 * had when the anchor was written. When the template gained or lost a
 * render, the ordinals may have shifted, and a shifted ordinal points at
 * a DIFFERENT render: the mapper then refuses to decide and reports the
 * shift, because binding a render to the wrong ordinal is exactly the
 * mis-association this module exists to prevent.
 *
 * `cases`   the cases of the discovery, in the order the CLI reported them;
 * `entries` the registry entries of the project;
 * `groups`  the groups of the cases, by position.
 *
 * Returns a map from the case to its decision:
 * `{uid, basis, ambiguity}` -- `uid` is null when nothing decided.
 */
export function reidentifyRendered({ cases = [], entries = [], groups = null } = {}) {
  const byAnchor = new Map();
  for (const e of entries ?? []) {
    const a = e.anchor;
    if (!a || !e.uid) continue;
    const key = positionKey(a.file, a.line, a.scope ?? []);
    if (!byAnchor.has(key)) byAnchor.set(key, []);
    byAnchor.get(key).push(e);
  }

  const theGroups = groups ?? groupByPosition(cases);
  const decisions = new Map();

  /*
   * The titles the registry remembers at a position.
   *
   * They are what rule 2 and rule 3 are about: a title that is still there
   * identifies its case, and a title that is still there SOMEWHERE in the
   * group means the group's ordinals may have shifted.
   */
  const titlesAt = (key) => new Set((byAnchor.get(key) ?? []).map((e) => titleKeyOf(e)));

  for (const c of cases ?? []) {
    const key = positionKey(c.file, c.line, c.scope ?? []);

    /* Rule 1: the anchor does not decide a case with a body of its own. */
    if (c.source) continue;

    const candidates = byAnchor.get(key) ?? [];
    if (!candidates.length) continue;
    const group = theGroups.get(key) ?? [];
    const ordinal = group.indexOf(c);
    if (ordinal < 0) continue;

    /* Rule 2: the title still claims a case of the registry. */
    const claimed = candidates.find((e) => titleKeyOf(e) === titleKeyOf(c));
    if (claimed) continue;

    /*
     * Rule 3: some of the registry's titles are still in this group, so the
     * ordinals may have shifted.
     */
    const known = titlesAt(key);
    const present = new Set(group.map((g) => titleKeyOf(g)));
    const survivors = [...known].filter((t) => present.has(t));
    if (survivors.length && survivors.length < known.size) {
      decisions.set(c, {
        uid: null,
        basis: null,
        ambiguity: {
          reason: AMBIGUITY.RENDER_PARTIAL,
          candidates: distinctUids(candidates),
          survivingTitles: survivors.length,
          previousCount: known.size,
        },
      });
      continue;
    }

    // The anchors that point at THIS ordinal of this group.
    const atOrdinal = candidates.filter((e) => e.anchor.ordinal === ordinal);
    if (!atOrdinal.length) continue;
    const uids = distinctUids(atOrdinal);
    if (uids.length > 1) {
      decisions.set(c, {
        uid: null,
        basis: null,
        ambiguity: { reason: AMBIGUITY.RENDER_AMBIGUOUS, candidates: uids },
      });
      continue;
    }
    const entry = atOrdinal[0];
    // The group changed its size: the ordinal may have shifted.
    if (group.length !== entry.anchor.count) {
      decisions.set(c, {
        uid: null,
        basis: null,
        ambiguity: {
          reason: AMBIGUITY.RENDER_SHIFT,
          candidates: [entry.uid],
          previousCount: entry.anchor.count,
          currentCount: group.length,
        },
      });
      continue;
    }
    // The title is unchanged: the case is the one the anchor names, and the
    // anchor adds nothing the title did not already say.
    if (entry.title === c.title) continue;
    decisions.set(c, {
      uid: entry.uid,
      basis: 'position-anchor',
      candidates: 1,
      previousTitle: entry.title,
    });
  }
  return decisions;
}
