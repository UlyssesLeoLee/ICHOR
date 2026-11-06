"""ATS-204: the project matrix is ONE case, not one case per project.

THE FACT (measured, `tools/ats204-probes/cli-facts.mjs` against a REAL
`@playwright/test` 1.64.1): the CLI writes ONE SPEC ROW PER PROJECT. A
logical case that runs in two projects is two spec rows, with two spec ids
and one `test` each:

    file=facts.spec.ts line=4 title="plain case" id=...-22a33c5b2ba004a151fd  project=alpha
    file=facts.spec.ts line=4 title="plain case" id=...-13260e8b00170836d823 project=beta

The product's report parser keyed the case by `file + title + line` plus a
running ORDINAL of the spec, so the two rows became TWO cases: the counter
said `total: 2` for one logical case, and a case that failed in project
beta only was reported as one passed and one failed case instead of one
failed case.

THE FIX: the ordinal is what kept two specs apart, and it is needed for
the case the report cannot tell apart -- the one WITHOUT a line. The
ordinal is therefore taken only for the specs that carry no line, and the
specs WITH a line are keyed by their position alone. Two specs with the
same file, the same title and the same line are the same logical case in
two projects.

The spec id is what tells the two apart when they ARE different cases:
the CLI's spec id is `<file half>-<case half>`, and the case half differs
between two renders of one template. So the key is
`file + title + line`, and the spec id distinguishes the specs that share
it -- which is exactly the matrix case.

    python tools/ats204-probes/apply-matrix.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / 'server' / 'execution' / 'model.mjs'

OLD_ORDINAL = """  /** The ordinal of every spec, so that two specs with the same identity
   *  (the same file, the same title and NO line) stay two cases. */
  let specOrdinal = 0;"""
NEW_ORDINAL = """  /*
   * The ordinal of the specs that carry NO line.
   *
   * ATS-204: the ordinal used to be taken for EVERY spec, and that made the
   * two rows the CLI writes for one case in two PROJECTS into two cases.
   * The ordinal is only needed for the specs the report cannot tell apart
   * -- the ones WITHOUT a line. A spec WITH a line is identified by its
   * position, and the two projects of one case share that position.
   */
  let specOrdinal = 0;"""

OLD_KEY = """      // The identity of the SPEC: its file, its title and its line. The
      // ordinal keeps two same-titled specs apart when the report carries no
      // line for them.
      const caseKey = `${file} ${x.title ?? ''} ${line} #${specOrdinal++}`;"""
NEW_KEY = """      // The identity of the SPEC: its file, its title and its line. The
      // ordinal keeps two same-titled specs apart when the report carries no
      // line for them.
      //
      // ATS-204: the ordinal is taken ONLY for the specs without a line.
      // A spec WITH a line is keyed by its position alone, so the two rows
      // the CLI writes for one case in two projects are ONE case -- which
      // is what the counters and the per-project verdicts are about.
      const caseKey = Number.isInteger(line)
        ? `${file} ${x.title ?? ''} ${line}`
        : `${file} ${x.title ?? ''} #${specOrdinal++}`;"""


def main():
    raw = TARGET.read_bytes().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n')

    for label, old, new in [
        ('the ordinal', OLD_ORDINAL, NEW_ORDINAL),
        ('the case key', OLD_KEY, NEW_KEY),
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
