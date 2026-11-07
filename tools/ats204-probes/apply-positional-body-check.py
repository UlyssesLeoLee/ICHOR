"""ATS-204: the positional signal must AGREE with the body.

THE DANGER
----------
`file-line` -- the same file, the same line, the same title -- is a
positional signal, and the line is not an identity: a case inserted above
shifts every line below it. Two same-titled cases in one file are the
concrete case (the ATS-201 boundary `docs/18-UID-SPEC.md` §7.1): after
the shift, one of them sits on the line the OTHER one used to sit on, and
the positional signal binds it to the other's uid -- silently, because
nothing looks wrong.

THE RULE
--------
When the body of the reported case COULD be computed, the positional
signal must agree with it: the entry it names has to carry the same
fingerprint. A positional hit whose body disagrees is a stale-line
coincidence, and it does not bind -- the case falls through to the body
signal, which is the signal that survives the shift.

When the body could NOT be computed, the positional signal stands on its
own: it is the only evidence there is. The boundary is documented, not
hidden.

    python tools/ats204-probes/apply-positional-body-check.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IDENTITY = ROOT / 'server' / 'identity.mjs'

OLD = """  if (!ambiguousGroup) {
    /* 3. the file, the line and the title. */
    if (Number.isInteger(line) && line > 0) {
      const atLine = sameFile.filter((e) => Number.isInteger(e.line) && e.line === line);
      const sameTitleAtLine = atLine.filter((e) => e.title === title);
      const uids = distinctUids(sameTitleAtLine);
      if (uids.length === 1) return { uid: uids[0], basis: 'file-line', candidates: 1 };
      if (uids.length > 1) {
        return {
          uid: null, basis: 'file-line-ambiguous', candidates: uids.length,
          ambiguity: { reason: AMBIGUITY.SAME_FILE_LINE, candidates: uids },
        };
      }
    }
"""
NEW = """  if (!ambiguousGroup) {
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
    if (Number.isInteger(line) && line > 0) {
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
        // The body decides below -- and the position is not used.
        const contradicted = distinctUids(sameTitleAtLine);
        return {
          uid: null, basis: 'file-line-body-mismatch', candidates: contradicted.length,
          ambiguity: { reason: AMBIGUITY.BODY, candidates: contradicted },
        };
      }
    }
"""


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
