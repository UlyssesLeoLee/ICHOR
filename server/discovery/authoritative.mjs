/**
 * ATS-202: the identity of an AUTHORITATIVELY discovered case.
 *
 * The v0.1 index derives a TestDefinition UID from the SOURCE of the case:
 * its title key, or -- when the title is not unique -- the fingerprint of its
 * callback body. That works for the literal `test('...')` calls the static
 * scanner can see, and it cannot work for a case the scanner never saw: a
 * dynamically generated case has no source line that says which case it is.
 *
 * The Playwright CLI CAN see those cases. It reports, per case: the file, the
 * `describe` path, the leaf title, the line of the `test(` call and an `id`
 * that the CLI itself computes. This module turns that report into the SAME
 * kind of stable identity the rest of the product uses, so that a dynamic
 * case is a first-class TestDefinition rather than a missing one.
 *
 * THE LADDER (first hit wins)
 * ---------------------------
 *
 * | # | condition                                       | UID source     | basis               |
 * |---|-------------------------------------------------|----------------|---------------------|
 * | 1 | the title carries `@TC-<token>`                  | `explicit`     | `explicit`          |
 * | 2 | the registry holds this case (by body key)      | `registry`     | `body-key`          |
 * | 3 | the case is the only claimant of its title       | `derived`      | `title-key`         |
 * | 4 | the body fingerprint is unique in the project     | `derived-body` | `body-key`          |
 * | 5 | the (describe path, title) is unique            | `derived`      | `scope-title`       |
 * | 6 | the (file, describe path, title) is unique      | `derived`      | `authoritative-key` |
 * | 7 | nothing decides it                              | `provisional`  | --                  |
 *
 * Rules 1, 2, 3 and 4 are the ATS-201 rules, applied to the AUTHORITATIVE
 * case list. That is deliberate: an ordinary case must keep the UID it
 * already has, otherwise switching between the static and the authoritative
 * index would change every UID and break every link built on it.
 *
 * THE TITLE CLAIM (rule 3) AND THE DYNAMIC CASES
 * ----------------------------------------------
 * A title may be claimed by several cases: a literal case AND a dynamic case
 * that renders the same title. The claim is decided by a rule that keeps the
 * index switch harmless:
 *
 *   * a case the STATIC SCANNER can see (it has a readable body at its
 *     position) is a SOURCE case; a case the scanner cannot see is a
 *     DYNAMIC case;
 *   * the SOURCE case wins the title, the dynamic one falls through to the
 *     describe path.
 *
 * Without that rule a dynamic case sharing a title with a literal case would
 * push the literal case off the title key and CHANGE ITS UID -- the literal
 * case would get a different identifier the moment the user vouches for the
 * project, and every requirement link built on the old UID would break.
 *
 * Rule 5 is what the authoritative discovery adds over the static one: the
 * `describe` path tells two same-titled cases apart, so the static index's
 * "identical title" ambiguity is RESOLVED rather than reported. The describe
 * path does not take part in the TITLE key (ATS-201 §3.2 keeps it out on
 * purpose), so it is only used when the title alone does not decide.
 *
 * Rule 6 is the last resort that still decides. Its basis contains the file,
 * so the UID does not survive a rename -- the condition is reported in
 * `uidBasis` instead of being hidden.
 *
 * Step 6 is the honest answer when nothing decides: a provisional identifier
 * and an ambiguity report. An ambiguous case is never merged into another.
 */
import { bodyKeyOf, deriveTestUid, extractExplicitUid, normalizeTitleKey, pruneRegistry, provisionalTestUid } from '../uid.mjs';

/**
 * The registry entry of one authoritative case.
 *
 * It carries the fields the ATS-201 registry carries (so that the existing
 * lookup and the existing run binding keep working) plus the two facts only
 * the authoritative discovery knows: the `describe` path and the CLI's own
 * per-project spec ids.
 */
function entryOf(item) {
  return {
    uid: item.uid,
    uidSource: item.uidSource,
    titleKey: item.titleKey,
    bodyKey: item.bodyKey,
    file: item.file,
    title: item.title,
    line: item.line,
    aliases: item.aliases ?? [],
    // ATS-202 additions
    scope: item.scope ?? [],
    specIds: item.specIds ?? [],
  };
}

/**
 * Merges the resolved authoritative cases into the UID registry.
 *
 * The rules are the ATS-201 rules (one entry per uid, stale entries pruned
 * only when their file was part of THIS discovery), plus one addition: an
 * entry keeps the spec ids of the CLI, so that a RUN can bind its attempts
 * to the case by the CLI's own identity instead of by a title heuristic.
 */
function mergeRegistry(entries, items, scope) {
  const byUid = new Map();
  for (const e of entries) {
    if (e.uid && !byUid.has(e.uid)) byUid.set(e.uid, e);
  }
  for (const item of items) {
    if (!item.uid) continue;
    const existing = byUid.get(item.uid);
    const next = entryOf(item);
    if (existing) {
      // The uid is the SAME case: remember the old position as an alias, so
      // that a case which moved can still be found under its old spelling.
      if (existing.file !== next.file || existing.title !== next.title) {
        existing.aliases = existing.aliases ?? [];
        if (!existing.aliases.some((a) => a.file === existing.file && a.title === existing.title)) {
          existing.aliases.push({ file: existing.file, title: existing.title });
        }
      }
      existing.titleKey = next.titleKey;
      existing.uidSource = next.uidSource;
      existing.line = next.line;
      existing.bodyKey = next.bodyKey;
      existing.file = next.file;
      existing.title = next.title;
      existing.scope = next.scope;
      existing.specIds = next.specIds;
      continue;
    }
    const created = entryOf(item);
    byUid.set(created.uid, created);
  }
  const merged = [...byUid.values()];
  // The pruning is the ATS-201 one: an entry is dropped only when its file
  // was part of THIS discovery and no resolved case claims its uid. A file
  // that is absent from the discovery (a branch that does not contain it)
  // says nothing about the cases inside it, so its entries are KEPT.
  return pruneRegistry(merged, items, scope);
}

/**
 * Finds the registry entry of a case, by its body fingerprint.
 *
 * The body fingerprint is the signal that survives a rename and a retitle,
 * which is exactly what the registry is for. The lookup only fires when the
 * fingerprint is UNIQUE inside the project: a body shared by several cases
 * does not identify one of them, and guessing would hand a case the UID of a
 * different case.
 *
 * Returns the uid or null.
 */
function matchRegistry(item, { registryByBody, bodyCounts }) {
  if (!item.bodyKey) return null;
  // Only a SOURCE case may be matched by its body. The body of a dynamic
  // case is the body of the TEMPLATE it was generated from, and that
  // template may generate more cases later -- so the body does not identify
  // one dynamic case, and matching it would hand the case a UID that moves
  // as soon as the template grows.
  if (!item.source) return null;
  const hits = registryByBody.get(item.bodyKey);
  if (!hits || !hits.length) return null;
  if (bodyCounts.get(item.bodyKey) !== 1) return null;
  const uids = [...new Set(hits.map((h) => h.uid).filter(Boolean))];
  return uids.length === 1 ? uids[0] : null;
}

/**
 * Resolves the stable UID of every authoritatively discovered case.
 *
 * `cases`   -- the normalised case list of `playwright test --list`:
 *               `{file, title, line, column, describePath, projects, tags}`;
 * `bodies`  -- a lookup from `file line` to the body text of the SOURCE
 *               case at that position (the static scanner's reading of the
 *               file). The body is what tells two same-titled cases apart,
 *               and it is unavailable for a case the scanner never saw.
 * `registry`-- the UID registry of the project.
 * `scope`   -- the set of files this discovery covered.
 */
export function resolveAuthoritativeIdentities({ projectUid, cases, bodies, registry, scope = null }) {
  const items = cases.map((c) => {
    const key = `${c.file} ${c.line}`;
    const scanned = bodies.get(key) ?? null;
    return {
      ...c,
      titleKey: normalizeTitleKey(c.title),
      bodyKey: bodyKeyOf(scanned?.bodyText ?? null),
      // A SOURCE case is one the static scanner reads at that position AND
      // whose source title is the SAME as the title the CLI reports.
      //
      // The title comparison is what makes the distinction reliable. The
      // scanner matches the literal text of the call, so a dynamically
      // generated case is read as `dynamic ${n}` while the CLI reports the
      // RENDERED title (`dynamic a`). The two differ, and the case is
      // therefore not a source case -- which is exactly what it is.
      source: Boolean(scanned && scanned.title === c.title),
      explicitUid: extractExplicitUid(c.title),
      scope: [...(c.describePath ?? [])],
      specIds: (c.projects ?? []).map((p) => p.specId).filter(Boolean),
    };
  });

  const bodyCounts = new Map();
  for (const it of items) {
    if (it.bodyKey) bodyCounts.set(it.bodyKey, (bodyCounts.get(it.bodyKey) ?? 0) + 1);
  }

  // The registry lookup, indexed by the body fingerprint.
  const registryByBody = new Map();
  for (const e of registry?.entries ?? []) {
    if (!e.bodyKey || !e.uid) continue;
    if (!registryByBody.has(e.bodyKey)) registryByBody.set(e.bodyKey, []);
    registryByBody.get(e.bodyKey).push(e);
  }

  // The title claim. A title may be claimed by several cases; the SOURCE
  // case wins it, so that adding a dynamic case never moves the UID of a
  // case the user already has links to.
  const titleGroups = new Map();
  for (const it of items) {
    if (!titleGroups.has(it.titleKey)) titleGroups.set(it.titleKey, []);
    titleGroups.get(it.titleKey).push(it);
  }
  /** The set of cases that may claim their title key. */
  const titleClaimants = new Set();
  for (const group of titleGroups.values()) {
    if (group.length === 1) {
      titleClaimants.add(group[0]);
      continue;
    }
    const sources = group.filter((g) => g.source);
    // Exactly one source case: it wins the title. Several source cases: the
    // title does not identify any of them. No source case at all: the title
    // is shared by dynamic cases only, and it identifies none of them.
    if (sources.length === 1) titleClaimants.add(sources[0]);
  }

  // The explicit annotations are CLAIMS: the token belongs to the case that
  // carries it, and two cases carrying the same token means NEITHER of them
  // owns it.
  const explicitOwners = new Map();
  for (const it of items) {
    if (!it.explicitUid) continue;
    if (!explicitOwners.has(it.explicitUid)) explicitOwners.set(it.explicitUid, []);
    explicitOwners.get(it.explicitUid).push(it);
  }

  const scopeTitleCounts = new Map();
  const fileScopeTitleCounts = new Map();
  for (const it of items) {
    const st = `${it.scope.join(' ')} ${it.titleKey}`;
    scopeTitleCounts.set(st, (scopeTitleCounts.get(st) ?? 0) + 1);
    const fst = `${it.file} ${st}`;
    fileScopeTitleCounts.set(fst, (fileScopeTitleCounts.get(fst) ?? 0) + 1);
  }

  const resolved = items.map((it) => {
    if (it.explicitUid) {
      if (explicitOwners.get(it.explicitUid).length > 1) {
        return { ...it, uid: null, uidSource: 'provisional', uidStable: false, basis: null, duplicateExplicit: it.explicitUid };
      }
      return { ...it, uid: it.explicitUid, uidSource: 'explicit', uidStable: true, basis: 'explicit' };
    }
    // The registry remembers the UID of a case that was renamed: the body
    // fingerprint is the signal that survives the rename.
    const remembered = matchRegistry(it, { registryByBody, bodyCounts });
    if (remembered) {
      return { ...it, uid: remembered, uidSource: 'registry', uidStable: true, basis: 'body-key' };
    }
    if (titleClaimants.has(it)) {
      return { ...it, uid: deriveTestUid(projectUid, it.titleKey), uidSource: 'derived', uidStable: true, basis: 'title-key' };
    }
    // The body fingerprint decides only for a SOURCE case. The body of a
    // dynamic case is the body of the TEMPLATE it came from, and that
    // template may generate more cases later -- so the body would give two
    // dynamic cases the same UID, and would move as soon as the template
    // grows. A dynamic case is decided by its describe path instead.
    if (it.source && it.bodyKey && bodyCounts.get(it.bodyKey) === 1) {
      return { ...it, uid: deriveTestUid(projectUid, it.bodyKey), uidSource: 'derived-body', uidStable: true, basis: 'body-key' };
    }
    const scopeTitle = `${it.scope.join(' ')} ${it.titleKey}`;
    if (scopeTitleCounts.get(scopeTitle) === 1) {
      return { ...it, uid: deriveTestUid(projectUid, `scope ${scopeTitle}`), uidSource: 'derived', uidStable: true, basis: 'scope-title' };
    }
    const fileScopeTitle = `${it.file} ${scopeTitle}`;
    if (fileScopeTitleCounts.get(fileScopeTitle) === 1) {
      // The file is part of the basis, so the UID does NOT survive a rename.
      // The basis says so, and the caller can report it.
      return { ...it, uid: deriveTestUid(projectUid, `file ${fileScopeTitle}`), uidSource: 'derived', uidStable: true, basis: 'authoritative-key' };
    }
    return { ...it, uid: null, uidSource: 'provisional', uidStable: false, basis: null };
  });

  // A collision: two cases want the same uid. The EXPLICIT claim wins (the
  // author wrote the token down), every other claim falls back to the next
  // basis and finally to a provisional identifier.
  const claims = new Map();
  for (const r of resolved) {
    if (!r.uid) continue;
    if (!claims.has(r.uid)) claims.set(r.uid, []);
    claims.get(r.uid).push(r);
  }
  for (const [uid, group] of claims) {
    if (group.length < 2) continue;
    const winner = group.find((g) => g.uidSource === 'explicit') ?? null;
    for (const g of group) {
      if (winner && g === winner) continue;
      // The fallback uses the body only for a SOURCE case (see the ladder).
      const fallback = g.source && g.bodyKey && bodyCounts.get(g.bodyKey) === 1
        ? deriveTestUid(projectUid, g.bodyKey)
        : null;
      g.uid = fallback && fallback !== uid ? fallback : null;
      g.uidSource = fallback ? 'derived-body' : 'provisional';
      g.uidStable = Boolean(fallback);
      g.basis = fallback ? 'body-key' : null;
    }
  }

  // The ambiguity report: every case that could not be pinned down is
  // reported, with its candidates. Nothing is merged silently.
  const ambiguousGroups = new Map();
  for (const r of resolved) {
    if (r.uid) continue;
    const key = r.duplicateExplicit ? `explicit:${r.duplicateExplicit}` : r.titleKey;
    if (!ambiguousGroups.has(key)) ambiguousGroups.set(key, []);
    ambiguousGroups.get(key).push(r);
  }
  for (const [key, group] of ambiguousGroups) {
    group.sort((a, b) => (a.file === b.file ? (a.line ?? 0) - (b.line ?? 0) : a.file < b.file ? -1 : 1));
    const duplicateExplicit = group[0]?.duplicateExplicit ?? null;
    group.forEach((r, index) => {
      r.uid = provisionalTestUid(projectUid, r.file, r.title, r.line ?? 0, index + 1);
      r.uidSource = 'provisional';
      r.uidStable = false;
      r.ambiguity = {
        key,
        reason: duplicateExplicit ? 'duplicate-explicit-uid' : (r.bodyKey ? 'identical-title-and-body' : 'identical-title'),
        ...(duplicateExplicit ? { explicitUid: duplicateExplicit } : {}),
        candidates: group.map((g) => ({ file: g.file, title: g.title, line: g.line })),
      };
    });
  }

  const entries = mergeRegistry(registry?.entries ?? [], resolved, scope);
  return {
    items: resolved,
    registry: { version: registry?.version ?? 1, entries },
  };
}
