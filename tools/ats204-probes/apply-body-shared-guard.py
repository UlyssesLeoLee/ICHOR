"""ATS-204: a body shared by several cases of the run identifies NEITHER.

THE PROBLEM
-----------
The mapper is asked about one reported case at a time, but some signals
can only be judged against the WHOLE RUN:

  * a body that two cases of the same run share does not tell them apart,
    so any signal that does NOT use the body must not bind them to the
    same uid. The `file-title` and the `title` signals are exactly such
    signals: with two same-titled cases in the run, they would hand both
    of them the same uid -- the silent mis-association this task exists
    to prevent;
  * the positional signals (`file-line`, `file-scope-title`) are safe: two
    cases of one run that report the same file, the same describe path,
    the same title AND the same line are the same case (a retry).

THE FIX
-------
The mapper computes whether the body is shared inside the run and, when
it is, does not bind by the signals that are weaker than the body. It
falls through to the body signal, which reports the sharing.

    python tools/ats204-probes/apply-body-shared-guard.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IDENTITY = ROOT / 'server' / 'identity.mjs'

OLD_COMPUTE = """  const fileTitleUids = distinctUids(sameFileTitle);
  const ambiguousGroup = fileTitleUids.length > 1;"""
NEW_COMPUTE = """  const fileTitleUids = distinctUids(sameFileTitle);
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
   */
  const bodySharedInRun = Boolean(bodyKey) && bodyCounts
    ? (bodyCounts.get(bodyKey) ?? 0) > 1
    : false;"""

OLD_FILE_TITLE = """    /* 4. the file and the title. */
    if (fileTitleUids.length === 1) return { uid: fileTitleUids[0], basis: 'file-title', candidates: 1 };"""
NEW_FILE_TITLE = """    /*
     * 4. the file and the title.
     *
     * The signal is skipped when the body is shared inside the run: the
     * file and the title would then bind BOTH of the shared cases to the
     * same uid. The body signal below reports the sharing instead.
     */
    if (fileTitleUids.length === 1 && !bodySharedInRun) {
      return { uid: fileTitleUids[0], basis: 'file-title', candidates: 1 };
    }"""

OLD_TITLE = """  /* 7. the title alone -- only when it identifies one case in the project. */
  const titleUids = distinctUids(sameTitle);
  if (titleUids.length === 1) return { uid: titleUids[0], basis: 'title', candidates: 1 };"""
NEW_TITLE = """  /*
   * 7. the title alone -- only when it identifies one case in the project,
   * and only when the body does not tell several cases of this run apart.
   */
  const titleUids = distinctUids(sameTitle);
  if (titleUids.length === 1 && !bodySharedInRun) {
    return { uid: titleUids[0], basis: 'title', candidates: 1 };
  }"""


def main():
    raw = IDENTITY.read_bytes().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n')
    for label, old, new in [
        ('the shared body', OLD_COMPUTE, NEW_COMPUTE),
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
