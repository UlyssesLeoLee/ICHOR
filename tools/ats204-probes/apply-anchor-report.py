"""ATS-204: report the anchor problems instead of dropping them.

The anchor lookup finds the cases whose anchor could not be used -- the
template gained or lost a render, so the ordinals may have shifted, and a
shifted ordinal points at a DIFFERENT render. Those cases must be
REPORTED: a case that cannot be recognised by its anchor falls back to the
title, and the title of a shifted render names a case that may not be it.

The report is attached to the case as an `ambiguity`, so it reaches the
reader through the same channel as every other uncertainty.

    python tools/ats204-probes/apply-anchor-report.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / 'server' / 'discovery' / 'authoritative.mjs'

OLD = """    const byAnchor = anchored.get(it);
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
"""
NEW = """    const byAnchor = anchored.get(it);
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
    /*
     * The anchor could not decide: the template gained or lost a render,
     * so the ordinal may name a DIFFERENT render. The case falls through
     * to the title, and the uncertainty is REPORTED -- a case that might
     * be a different one must not look like a case that was simply
     * re-derived.
     */
    const anchorProblem = anchorProblems.get(it);
"""

OLD_TAIL = """    return { ...it, uid: null, uidSource: 'provisional', uidStable: false, basis: null };
  });
"""
NEW_TAIL = """    return {
      ...it,
      uid: null,
      uidSource: 'provisional',
      uidStable: false,
      basis: null,
      ...(anchorProblem ? { ambiguity: anchorProblem } : {}),
    };
  });
"""

OLD_TITLE_CLAIM = """    if (titleClaimants.has(it)) {
      return { ...it, uid: deriveTestUid(projectUid, it.titleKey), uidSource: 'derived', uidStable: true, basis: 'title-key' };
    }
"""
NEW_TITLE_CLAIM = """    if (titleClaimants.has(it)) {
      return {
        ...it,
        uid: deriveTestUid(projectUid, it.titleKey),
        uidSource: 'derived',
        uidStable: true,
        basis: 'title-key',
        ...(anchorProblem ? { ambiguity: anchorProblem } : {}),
      };
    }
"""


def main():
    raw = TARGET.read_bytes().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n')

    for label, old, new in [
        ('the anchor problem', OLD, NEW),
        ('the title claim', OLD_TITLE_CLAIM, NEW_TITLE_CLAIM),
        ('the provisional tail', OLD_TAIL, NEW_TAIL),
    ]:
        if text.count(old) != 1:
            print('FAIL: %s -- the snippet is not there exactly once' % label)
            return 1
        text = text.replace(old, new)

    out = text.replace('\n', nl)
    TARGET.write_bytes(out.encode('utf-8'))
    print('rewrote %s' % TARGET.relative_to(ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
