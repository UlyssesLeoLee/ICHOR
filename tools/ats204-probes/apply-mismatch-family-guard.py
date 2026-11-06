"""ATS-204: a position that CONTRADICTS the body disables the whole
position family.

THE BUG
-------
The stale-line shape of `docs/18-UID-SPEC.md` §7.1: the report names the
same file, the same line and the same title as the registry entry, but
the body of the case that is there NOW is not the body the registry
remembers.

The `file-line` signal correctly refuses to bind that hit. But the walk
then continued to `file-title` -- the same position family, one signal
weaker -- and `file-title` bound it, because the file and the title
happen to be unique in the registry. So the contradiction was reported
and the case was bound anyway.

THE FIX
-------
A position that contradicts the body disables every signal of that
family: `file-line`, `file-scope-title`, `file-title` and the bare
`title`. Only the body may decide -- and the body is the signal that
survives a rename, so the renamed case is still bound (by the body).

    python tools/ats204-probes/apply-mismatch-family-guard.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IDENTITY = ROOT / 'server' / 'identity.mjs'

OLD_SCOPE = """  if (scopeKey && !bodySharedInRun) {"""
NEW_SCOPE = """  if (scopeKey && !bodySharedInRun && !positionMismatch) {"""

OLD_FILE_TITLE = """    if (fileTitleUids.length === 1 && !bodySharedInRun) {
      return { uid: fileTitleUids[0], basis: 'file-title', candidates: 1 };
    }"""
NEW_FILE_TITLE = """    if (fileTitleUids.length === 1 && !bodySharedInRun && !positionMismatch) {
      return { uid: fileTitleUids[0], basis: 'file-title', candidates: 1 };
    }"""

OLD_TITLE = """  const titleUids = distinctUids(sameTitle);
  if (titleUids.length === 1 && !bodySharedInRun) {
    return { uid: titleUids[0], basis: 'title', candidates: 1 };
  }"""
NEW_TITLE = """  const titleUids = distinctUids(sameTitle);
  if (titleUids.length === 1 && !bodySharedInRun && !positionMismatch) {
    return { uid: titleUids[0], basis: 'title', candidates: 1 };
  }"""

OLD_DECL = """  let positionMismatch = null;"""
NEW_DECL = """  let positionMismatch = null;
  /**
   * A position that CONTRADICTS the body disables the WHOLE position
   * family -- `file-line`, `file-scope-title`, `file-title` and the bare
   * `title`. They all name the case by where it is, and the body has just
   * said that the case that is there now is a different one.
   */"""


def main():
    raw = IDENTITY.read_bytes().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n')
    for label, old, new in [
        ('the declaration', OLD_DECL, NEW_DECL),
        ('the scope signal', OLD_SCOPE, NEW_SCOPE),
        ('the file-title signal', OLD_FILE_TITLE, NEW_FILE_TITLE),
        ('the title signal', OLD_TITLE, NEW_TITLE),
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
