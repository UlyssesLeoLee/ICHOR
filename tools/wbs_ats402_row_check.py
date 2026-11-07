"""ATS-402: check the 开发WBS row of ATS-402 in docs/WBS.xlsx.

A WBS row that LOOKS right but is not is worse than no row at all: the board
would report a task as delivered while the workbook still says otherwise. So
the row is read back OUT of the committed workbook and checked against the
facts this task claims:

  N (状态)    == 待审核   -- submitted, NOT 已完成 (review has not passed)
  O (完成率)  == 1
  P (剩余人日) == 0       -- the cached value of K*(1-O) = 5*(1-1)
  T (风险/说明) carries the ATS-402 marker and names the three contracts

The sheet is read with the same surgical XML approach as the updaters (no
openpyxl, no rebuild): the workbook is opened read-only and the row's cells
are extracted from the sheet XML.

Usage: python tools/wbs_ats402_row_check.py
Exit 0 and prints RESULT: OK when the row is as claimed.
"""
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
XLSX = ROOT / 'docs' / 'WBS.xlsx'
SHEET2 = 'xl/worksheets/sheet2.xml'


def find_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm.group(2)
    raise SystemExit(f'row for {ats_id} not found')


def cell(row_xml, col):
    """The raw <x:v> payload of one cell of the row (the cached value)."""
    m = re.search(r'<x:c r="%s\d+"[^>]*>(.*?)</x:c>' % col, row_xml, re.S)
    if m is None:
        return None
    v = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
    return v.group(1) if v else None


def main():
    if not XLSX.exists():
        print('MISSING', XLSX)
        return 1
    with zipfile.ZipFile(XLSX) as z:
        xml2 = z.read(SHEET2).decode('utf-8')

    rid, row = find_row(xml2, 'ATS-402')
    print(f'ATS-402 row: {rid}')

    state = cell(row, 'N')
    rate = cell(row, 'O')
    remaining = cell(row, 'P')
    note = cell(row, 'T') or ''

    print(f'  N (状态)     = {state!r}')
    print(f'  O (完成率)   = {rate!r}')
    print(f'  P (剩余人日) = {remaining!r}')
    print(f'  T (说明)     = {len(note)} chars')

    bad = []

    # 待审核, NOT 已完成: the review has not passed, and the task must not
    # declare itself done.
    if state != '待审核':
        bad.append(f'N must be 待审核, is {state!r}')
    if rate != '1':
        bad.append(f'O must be 1, is {rate!r}')
    if remaining != '0':
        bad.append(f'P must be 0, is {remaining!r}')

    # The note must be OURS (the marker) and must name what was delivered.
    if '【ATS-402】' not in note:
        bad.append('T does not carry the 【ATS-402】 marker')
    for token in ('credential-store/v1', 'egress-consent/v1', 'egress-audit/v1'):
        if token not in note:
            bad.append(f'T does not name {token}')
    # The note must also state what is NOT done, so the row cannot be read as
    # "the AI can now read your project".
    if 'ATS-403' not in note:
        bad.append('T does not name ATS-403 (the model provider is still not wired)')

    print('')
    if bad:
        print('RESULT: MISMATCH')
        for b in bad:
            print('  ', b)
        return 1
    print('RESULT: OK -- the ATS-402 row says 待审核 / 100% / 0 remaining and carries the ATS-402 note.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
