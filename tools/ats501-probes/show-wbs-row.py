#!/usr/bin/env python3
"""ATS-501: print the state of the ATS-501 row in docs/WBS.xlsx.

A small read-only helper so the evidence log shows the row as a reader of
the workbook would see it, rather than as the updater script wrote it.
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

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))

from wbs_common import read_parts, sheet_cells, totals  # noqa: E402

parts = read_parts()
s1 = sheet_cells(parts, 'xl/worksheets/sheet1.xml')
s2 = sheet_cells(parts, 'xl/worksheets/sheet2.xml')

COLUMNS = {
    'A': 'WBS ID',
    'B': '名称',
    'G': '完成定义',
    'K': '估算人日',
    'N': '状态',
    'O': '完成率',
    'P': '剩余人日',
    'T': '风险/说明',
}

target = None
for rid in sorted(s2):
    if s2[rid].get('A') == 'ATS-501':
        target = (rid, s2[rid])
        break

if target is None:
    print('ATS-501 row not found in 开发WBS')
    raise SystemExit(1)

rid, cells = target
print(f'ATS-501 row {rid}:')
for col, label in COLUMNS.items():
    print(f'  {col}{rid} {label:<8}: {cells.get(col, "")}')

estimate = float(cells.get('K') or 0)
completion = float(cells.get('O') or 0)
remaining = float(cells.get('P') or 0)
print('')
print(f'  remaining == estimate * (1 - completion) ? '
      f'{abs(remaining - estimate * (1 - completion)) < 1e-9} '
      f'({estimate} * (1 - {completion}) = {estimate * (1 - completion)})')

t = totals(parts)
print('')
print('总览 cached values:')
print(f'  B8  已完成项   : {s1[8].get("B")}   (derived {t["completed"]})')
print(f'  B9  完成率     : {s1[9].get("B")}')
print(f'  B10 剩余人日   : {s1[10].get("B")}   (derived {t["sum_remaining"]:.0f})')
print(f'  D6             : {s1[6].get("D", "")}')
print(f'  D7             : {s1[7].get("D", "")}')
