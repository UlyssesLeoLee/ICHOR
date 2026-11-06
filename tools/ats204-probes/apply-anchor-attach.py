"""ATS-204: attach the ANCHOR to the case it belongs to.

The anchors are computed for the items of the discovery, but the resolution
maps them into NEW objects (`{...it, uid, ...}`), so a Map keyed by the
original item is not found afterwards. The anchor is therefore attached to
the item itself, right after the anchors are computed: the resolution then
carries it along, and `entryOf()` picks it up.

    python tools/ats204-probes/apply-anchor-attach.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / 'server' / 'discovery' / 'authoritative.mjs'

OLD_COMPUTE = """  const anchorByCase = new Map();
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
"""
NEW_COMPUTE = """  const anchorByCase = new Map();
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
  // The anchor belongs to the case itself: the resolution below maps the
  // items into NEW objects, so a map keyed by the original item would not
  // be found afterwards. Attaching it here makes the resolution carry it
  // along, and `entryOf()` picks it up.
  for (const it of items) {
    it.anchor = anchorByCase.get(it) ?? null;
  }
"""

OLD_TAIL = """  }).map((it) => ({ ...it, anchor: anchorByCase.get(it) ?? null }));
"""
NEW_TAIL = """  });
"""


def main():
    raw = TARGET.read_bytes().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n')

    for label, old, new in [
        ('the anchor attachment', OLD_COMPUTE, NEW_COMPUTE),
        ('the resolved tail', OLD_TAIL, NEW_TAIL),
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
