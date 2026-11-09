"""ATS-204: a body that CONTRADICTS the position must still reach the body.

THE BUG
-------
The positional signal (`file-line`) and the body fingerprint can disagree:
the case that sits at the reported line today is a DIFFERENT case than the
one the registry remembers there. That is the stale-line shape of
`docs/18-UID-SPEC.md` §7.1.

The first version of the check REPORTED the mismatch and returned right
away. That is wrong: the body fingerprint is the signal that survives a
rename, so a case that was RENAMED is exactly the case whose position
disagrees with its body. Returning early there leaves the renamed case
unbound -- the very gap this task exists to close.

THE FIX
-------
The mismatch is recorded, not returned. The walk continues to the body
signal, which binds the case when the fingerprint identifies it -- and
reports the mismatch as the ambiguity when it does not.

    python tools/ats204-probes/apply-body-mismatch-fallthrough.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IDENTITY = ROOT / 'server' / 'identity.mjs'

OLD = """      if (sameTitleAtLine.length && !agrees.length) {
        // The positional hit contradicts the body: the case at that line
        // is a DIFFERENT case than the one the registry remembers there.
        // The body decides below -- and the position is not used.
        const contradicted = distinctUids(sameTitleAtLine);
        return {
          uid: null, basis: 'file-line-body-mismatch', candidates: contradicted.length,
          ambiguity: { reason: AMBIGUITY.BODY, candidates: contradicted },
        };
      }
    }
"""
NEW = """      if (sameTitleAtLine.length && !agrees.length) {
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
"""

OLD_DECL = """  const bodySharedInRun = Boolean(bodyKey) && bodyCounts
    ? (bodyCounts.get(bodyKey) ?? 0) > 1
    : false;"""
NEW_DECL = """  const bodySharedInRun = Boolean(bodyKey) && bodyCounts
    ? (bodyCounts.get(bodyKey) ?? 0) > 1
    : false;
  /**
   * The mismatch between the position and the body, when there is one.
   * It is REPORTED, but it does not stop the walk: the body signal below
   * is the one that survives a rename.
   */
  let positionMismatch = null;"""

OLD_BODY = """  /* 5. the body fingerprint: the only signal that survives a rename AND a retitle. */
  if (bodyKey) {
    const byBody = bodyIndex(usable).get(bodyKey) ?? [];
    const uids = distinctUids(byBody);
    const sharedInRun = bodyCounts ? (bodyCounts.get(bodyKey) ?? 0) : 1;
    if (uids.length === 1 && sharedInRun === 1) {
      return { uid: uids[0], basis: 'body-key', candidates: 1 };
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
  }
"""
NEW_BODY = """  /* 5. the body fingerprint: the only signal that survives a rename AND a retitle. */
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
"""


def main():
    raw = IDENTITY.read_bytes().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n')
    for label, old, new in [
        ('the declaration', OLD_DECL, NEW_DECL),
        ('the mismatch', OLD, NEW),
        ('the body signal', OLD_BODY, NEW_BODY),
    ]:
        if text.count(old) != 1:
            print('FAIL: %s -- the snippet is not there exactly once' % label)
            return 1
        text = text.replace(old, new)
    IDENTITY.write_bytes(text.replace('\n', nl).encode('utf-8'))
    print('rewrote %s' % IDENTITY.relative_to(ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
