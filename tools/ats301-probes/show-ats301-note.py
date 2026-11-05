#!/usr/bin/env python3
"""ATS-301: print the state of the ATS-301 row in docs/WBS.xlsx.

A read-only helper so the evidence log shows the row as a reader of the
workbook would see it, rather than as the updater script wrote it.

It also prints the NOTE that `tools/update_wbs_ats301.py` would write, so
the two can be compared directly: the workbook on disk must be the output of
the updater, not a hand-edited copy. The comparison is by exact string
equality, which is what "the workbook is the updater's output" means.

Usage: PYTHONUTF8=1 python tools/ats301-probes/show-ats301-note.py
"""
import sys
from pathlib import Path

# The row state is Chinese text (状态 values, 风险/说明). On a default
# Windows console the Python stdout encoding is the ANSI code page, so the
# output would be mojibake and the evidence log would record unreadable
# bytes. Force UTF-8 on the standard stream before anything is printed.
try:
    sys.stdout.reconfigure(encoding='utf-8')
except (AttributeError, ValueError):   # Python < 3.7 / detached stream
    pass

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))

from wbs_common import read_parts, sheet_cells  # noqa: E402
from update_wbs_ats301 import MARKER, NOTE as ATS301_NOTE  # noqa: E402

parts = read_parts()
s2 = sheet_cells(parts, 'xl/worksheets/sheet2.xml')

target = None
for rid in sorted(s2):
    if s2[rid].get('A') == 'ATS-301':
        target = (rid, s2[rid])
        break

if target is None:
    print('ATS-301 row not found in 开发WBS')
    raise SystemExit(1)

rid, cells = target
actual = cells.get('T', '')

# The cell holds an UNMARKED prefix (a note owned by another script) plus
# one block per marker. The ATS-301 block is the text from this script's
# marker up to the next marker (or the end of the cell). Comparing the
# whole cell against NOTE would be wrong -- the prefix belongs to someone
# else. The block is what this script owns, and it is what the updater
# rewrites on every run.
markers = ('【ATS-102】', '【ATS-301】', '【ATS-401】', '【ATS-501】')
start = actual.find(MARKER)
if start < 0:
    print(f'  the cell carries no {MARKER} marker')
    block = ''
else:
    end = len(actual)
    for m in markers:
        pos = actual.find(m, start + len(MARKER))
        if pos >= 0 and pos < end:
            end = pos
    block = actual[start:end]

print(f'ATS-301 row {rid}:')
print(f'  A{rid} WBS ID       : {cells.get("A", "")}')
print(f'  B{rid} 名称         : {cells.get("B", "")}')
print(f'  G{rid} 完成定义     : {cells.get("G", "")}')
print(f'  N{rid} 状态         : {cells.get("N", "")}')
print(f'  O{rid} 完成率       : {cells.get("O", "")}')
print('')
print(f'  T{rid} 风险/说明 (the whole cell as it reads on disk):')
print(f'    length : {len(actual)}')
print(f'    text   : {actual}')
print('')
print(f'  the ATS-301 block this script owns (from {MARKER} to the next marker):')
print(f'    length : {len(block)}')
print(f'    text   : {block}')
print('')
print(f'  the block tools/update_wbs_ats301.py would write:')
print(f'    length : {len(ATS301_NOTE)}')
print(f'    text   : {ATS301_NOTE}')
print('')
same = block == MARKER + ATS301_NOTE
print(f'  the ATS-301 block IS the updater output ? {same}')
print(f'  (the updater writes MARKER + NOTE = {len(MARKER + ATS301_NOTE)} chars)')

# The indicators the review checks for, spelled out so the log is readable
# without knowing the history.
for indicator in ('10.1.0', '§9.0'):
    print(f'  contains {indicator!r} ? {indicator in actual}')
print(f'  marker count : {actual.count(MARKER)} (expected 1)')

raise SystemExit(0 if same and actual.count(MARKER) == 1 else 1)
