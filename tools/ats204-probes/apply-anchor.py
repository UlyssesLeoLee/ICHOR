"""ATS-204: add the ANCHOR to the authoritative identity resolution.

The anchor is what a case the static scanner cannot see is remembered BY:
the position it was reported at plus its ordinal there. It is what lets a
dynamic case keep its uid when the template it was generated from is
re-worded -- every rendered title changes with the template, and the title
was the only thing that used to identify the case.

This script rewrites `server/discovery/authoritative.mjs`:
  * `entryOf()` carries the anchor;
  * `mergeRegistry()` keeps it;
  * `resolveAuthoritativeIdentities()` computes the anchors, looks the
    registry up by them, and uses them BEFORE the title claim.

The rewrite is done by a script rather than by hand so that the
indentation of the whole function stays the way the file around it reads.

    python tools/ats204-probes/apply-anchor.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / 'server' / 'discovery' / 'authoritative.mjs'

# ---------------------------------------------------------------- the import
OLD_IMPORT = "import { bodyKeyOf, deriveTestUid, extractExplicitUid, normalizeTitleKey, pruneRegistry, provisionalTestUid } from '../uid.mjs';"
NEW_IMPORT = (
    "import { bodyKeyOf, deriveTestUid, extractExplicitUid, normalizeTitleKey, pruneRegistry, provisionalTestUid } from '../uid.mjs';\n"
    "import { AMBIGUITY, groupByPosition, positionKey } from '../identity.mjs';"
)

# ------------------------------------------------------------- the entry
OLD_ENTRY = """    // ATS-202 additions
    scope: item.scope ?? [],
    specIds: item.specIds ?? [],
  };
}"""
NEW_ENTRY = """    // ATS-202 additions
    scope: item.scope ?? [],
    specIds: item.specIds ?? [],
    // ATS-204: the ANCHOR of a case that has no body of its own. It is the
    // position it was reported at plus its ordinal there, and it is what
    // lets a dynamic case keep its uid when the template it came from is
    // re-worded. It is null for a case the static scanner can see: such a
    // case is recognised by its body, which is a stronger signal.
    anchor: item.anchor ?? null,
  };
}"""

# ------------------------------------------------------------- the merge
OLD_MERGE = """      existing.scope = next.scope;
      existing.specIds = next.specIds;
      continue;"""
NEW_MERGE = """      existing.scope = next.scope;
      existing.specIds = next.specIds;
      existing.anchor = next.anchor;
      continue;"""

# ---------------------------------------------------- the anchors + the lookup
OLD_ANCHOR_POINT = """  const scopeTitleCounts = new Map();
  const fileScopeTitleCounts = new Map();"""
NEW_ANCHOR_POINT = """  /*
   * ATS-204: the ANCHOR of every case.
   *
   * A case the scanner cannot see has no body of its own, so its identity
   * is the POSITION it was reported at plus its ORDINAL there. The anchor
   * is what lets such a case keep its uid when the template it was
   * generated from is re-worded: the template's text changed, so every
   * rendered title changed with it, and the title was the only thing that
   * used to identify the case.
   *
   * The anchor is computed for EVERY case, not only for the dynamic ones:
   * a case that is a source case today may stop being one (the author
   * rewrites the literal into a loop), and the anchor it carries is what
   * lets it be recognised then.
   */
  const groups = groupByPosition(items.map((it) => ({
    file: it.file, line: it.line, scope: it.scope, ref: it,
  })));
  const anchorByCase = new Map();
  for (const [, group] of groups) {
    group.forEach((entry, index) => {
      anchorByCase.set(entry.ref, {
        kind: 'position',
        file: entry.ref.file,
        line: entry.ref.line,
        scope: [...entry.ref.scope],
        ordinal: index,
        count: group.length,
      });
    });
  }

  /*
   * ATS-204: the ANCHOR lookup.
   *
   * The registry remembers, for every case it has seen, the position the
   * case was reported at and its ordinal there. A case whose title was
   * rewritten is recognised by that anchor instead of by its title.
   *
   * The anchor is used only when the group it names still has the SAME
   * SIZE: when the template gained or lost a render, the ordinals may have
   * shifted, and a shifted ordinal points at a DIFFERENT render. That is
   * reported, not guessed.
   */
  const anchorEntries = new Map();
  for (const e of registry?.entries ?? []) {
    if (!e.anchor || !e.uid) continue;
    const key = positionKey(e.anchor.file, e.anchor.line, e.anchor.scope);
    if (!anchorEntries.has(key)) anchorEntries.set(key, []);
    anchorEntries.get(key).push(e);
  }
  /** The cases of this discovery that the anchor recognised. */
  const anchored = new Map();
  /** The cases whose anchor could not be used, with the reason. */
  const anchorProblems = new Map();
  for (const it of items) {
    const key = positionKey(it.file, it.line, it.scope);
    const candidates = anchorEntries.get(key) ?? [];
    if (!candidates.length) continue;
    const group = groups.get(key) ?? [];
    const ordinal = group.findIndex((g) => g.ref === it);
    const atOrdinal = candidates.filter((e) => e.anchor.ordinal === ordinal);
    if (!atOrdinal.length) continue;
    const uids = [...new Set(atOrdinal.map((e) => e.uid).filter(Boolean))];
    if (uids.length > 1) {
      anchorProblems.set(it, { reason: AMBIGUITY.RENDER_AMBIGUOUS, candidates: uids });
      continue;
    }
    const entry = atOrdinal[0];
    if (group.length !== entry.anchor.count) {
      // The template gained or lost a render: the ordinal may have shifted.
      anchorProblems.set(it, {
        reason: AMBIGUITY.RENDER_SHIFT,
        candidates: [entry.uid],
        previousCount: entry.anchor.count,
        currentCount: group.length,
      });
      continue;
    }
    anchored.set(it, { uid: entry.uid, previousTitle: entry.title });
  }

  const scopeTitleCounts = new Map();
  const fileScopeTitleCounts = new Map();"""

# ------------------------------------------------------- the ladder step
OLD_LADDER = """    const remembered = matchRegistry(it, { registryByBody, bodyCounts });
    if (remembered) {
      return { ...it, uid: remembered, uidSource: 'registry', uidStable: true, basis: 'body-key' };
    }
    if (titleClaimants.has(it)) {"""
NEW_LADDER = """    const remembered = matchRegistry(it, { registryByBody, bodyCounts });
    if (remembered) {
      return { ...it, uid: remembered, uidSource: 'registry', uidStable: true, basis: 'body-key' };
    }
    /*
     * ATS-204: the ANCHOR recognises a case whose title was rewritten.
     * It comes before the title claim, because a title that was rewritten
     * no longer claims anything: the title key of the case is a NEW one.
     */
    const byAnchor = anchored.get(it);
    if (byAnchor) {
      return {
        ...it,
        uid: byAnchor.uid,
        uidSource: 'registry',
        uidStable: true,
        basis: 'position-anchor',
        matched: { uid: byAnchor.uid, previousTitle: byAnchor.previousTitle ?? null },
      };
    }
    if (titleClaimants.has(it)) {"""

# ------------------------------------------- the anchor on the resolved case
OLD_RESOLVED_TAIL = """    return { ...it, uid: null, uidSource: 'provisional', uidStable: false, basis: null };
  });

  // A collision: two cases want the same uid."""
NEW_RESOLVED_TAIL = """    return { ...it, uid: null, uidSource: 'provisional', uidStable: false, basis: null };
  }).map((it) => ({ ...it, anchor: anchorByCase.get(it) ?? null }));

  // A collision: two cases want the same uid."""


def main():
    raw = TARGET.read_bytes().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n')

    edits = [
        ('the import', OLD_IMPORT, NEW_IMPORT),
        ('entryOf()', OLD_ENTRY, NEW_ENTRY),
        ('mergeRegistry()', OLD_MERGE, NEW_MERGE),
        ('the anchor computation', OLD_ANCHOR_POINT, NEW_ANCHOR_POINT),
        ('the ladder step', OLD_LADDER, NEW_LADDER),
        ('the anchor on the resolved case', OLD_RESOLVED_TAIL, NEW_RESOLVED_TAIL),
    ]
    for label, old, new in edits:
        if old not in text:
            print('FAIL: %s -- the snippet is not where it is expected' % label)
            return 1
        if text.count(old) != 1:
            print('FAIL: %s -- the snippet is not unique' % label)
            return 1
        text = text.replace(old, new)

    out = text.replace('\n', nl)
    TARGET.write_bytes(out.encode('utf-8'))
    print('rewrote %s (%d edits)' % (TARGET.relative_to(ROOT), len(edits)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
