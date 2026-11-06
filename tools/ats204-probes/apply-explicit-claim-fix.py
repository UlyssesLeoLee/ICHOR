"""ATS-204: an explicit token binds when ONE case of the run carries it.

THE BUG
-------
The explicit token belongs to the case that carries it -- and to ONE case.
The first version of the check required the REGISTRY to hold the token as
well:

    if (owners.length === 1 && claimants <= 1) { ... }

So a case whose title carries `@TC-001` and which the registry does not
know yet -- a NEW case, the very first time it is discovered -- did not
bind to `tc-001`. It was reported as `explicit-ambiguous`, which says
"two cases claim this token" when in fact none did.

THE FIX
-------
The registry is the MEMORY of the past cases; the token is the author's
own statement about the case that carries it. So:

  * ONE case of the run carries the token and no OTHER case does -> the
    token binds, whether the registry knows it or not;
  * TWO cases of the run carry it -> neither owns it;
  * the registry holds the token under a DIFFERENT case -> that entry
    cannot be the owner either.

    python tools/ats204-probes/apply-explicit-claim-fix.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IDENTITY = ROOT / 'server' / 'identity.mjs'

OLD = """  /* 1. the explicit annotation: the author wrote the uid down. */
  const explicit = extractExplicitUid(title);
  if (explicit) {
    const owners = usable.filter((e) => e.uid === explicit);
    // The token belongs to the case that carries it -- and to ONE case.
    // Two cases of the SAME RUN carrying it means neither of them owns
    // it: only the author can say which case it belongs to.
    const claimants = explicitCounts ? (explicitCounts.get(explicit) ?? 0) : 0;
    if (owners.length === 1 && claimants <= 1) {
      return { uid: explicit, basis: 'explicit', candidates: 1 };
    }
    return {
      uid: null,
      basis: 'explicit-ambiguous',
      candidates: Math.max(owners.length, claimants),
      ambiguity: { reason: 'duplicate-explicit-uid', explicitUid: explicit },
    };
  }"""
NEW = """  /* 1. the explicit annotation: the author wrote the uid down. */
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
     */
    const claimants = explicitCounts ? (explicitCounts.get(explicit) ?? 0) : 0;
    if (claimants <= 1) {
      return { uid: explicit, basis: 'explicit', candidates: 1 };
    }
    return {
      uid: null,
      basis: 'explicit-ambiguous',
      candidates: claimants,
      ambiguity: { reason: 'duplicate-explicit-uid', explicitUid: explicit },
    };
  }"""


def main():
    raw = IDENTITY.read_bytes().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n')
    if text.count(OLD) != 1:
        print('FAIL: the snippet is not there exactly once')
        return 1
    text = text.replace(OLD, NEW)
    IDENTITY.write_bytes(text.replace('\n', nl).encode('utf-8'))
    print('rewrote %s' % IDENTITY.relative_to(ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
