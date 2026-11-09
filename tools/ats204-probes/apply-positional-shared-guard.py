"""ATS-204: a body shared inside the run disables the POSITIONAL signals.

THE PROBLEM
-----------
The positional signals (`file-line`, `file-scope-title`) bind by the
POSITION of the case. A position is not an identity: a case inserted above
shifts every line below it, and two same-titled cases in one file then sit
on each other's old lines.

The ATS-201 boundary (`docs/18-UID-SPEC.md` §7.1) handles this by using
the body to tell the two apart. This task adds the other half: when the
body does NOT tell them apart -- because two cases of the SAME RUN share
it -- the position must not bind them either, or both of them would get
the same uid.

So the rule is: a positional signal binds only when the body either
AGREES with it, or is UNAVAILABLE (there is no body to disagree with).
When the body is shared inside the run, the positional signal does not
bind, and the case falls through to the body signal, which reports the
sharing.

    python tools/ats204-probes/apply-positional-shared-guard.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IDENTITY = ROOT / 'server' / 'identity.mjs'

OLD_SCOPE = """  /* 2. the file, the describe path and the title: the CLI's own identity. */
  if (scopeKey) {
    const sameFileScopeTitle = sameFile.filter((e) => e.title === title && scopeOf(e) === scopeKey);
    const uids = distinctUids(sameFileScopeTitle);
    if (uids.length === 1) return { uid: uids[0], basis: 'file-scope-title', candidates: 1 };"""
NEW_SCOPE = """  /*
   * 2. the file, the describe path and the title: the CLI's own identity.
   *
   * Like the line, the position is not an identity: it binds only when
   * the body agrees with it, or when there is no body to disagree with.
   */
  if (scopeKey && !bodySharedInRun) {
    const sameFileScopeTitle = sameFile.filter((e) => e.title === title && scopeOf(e) === scopeKey);
    const uids = distinctUids(sameFileScopeTitle);
    if (uids.length === 1) return { uid: uids[0], basis: 'file-scope-title', candidates: 1 };"""

OLD_LINE = """    if (Number.isInteger(line) && line > 0) {
      const atLine = sameFile.filter((e) => Number.isInteger(e.line) && e.line === line);
      const sameTitleAtLine = atLine.filter((e) => e.title === title);
      const agrees = bodyKey
        ? sameTitleAtLine.filter((e) => !e.bodyKey || e.bodyKey === bodyKey)
        : sameTitleAtLine;"""
NEW_LINE = """    if (Number.isInteger(line) && line > 0 && !bodySharedInRun) {
      const atLine = sameFile.filter((e) => Number.isInteger(e.line) && e.line === line);
      const sameTitleAtLine = atLine.filter((e) => e.title === title);
      const agrees = bodyKey
        ? sameTitleAtLine.filter((e) => !e.bodyKey || e.bodyKey === bodyKey)
        : sameTitleAtLine;"""


def main():
    raw = IDENTITY.read_bytes().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n')
    for label, old, new in [
        ('the scope signal', OLD_SCOPE, NEW_SCOPE),
        ('the line signal', OLD_LINE, NEW_LINE),
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
