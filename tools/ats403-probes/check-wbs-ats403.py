"""ATS-403: verify the ATS-403 row and the shared narrative cells.

Read-only: it inspects the workbook and prints what it finds, so the
reviewer can check the numbers without opening the file.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))

from wbs_common import SHEET1, SHEET2, cell_number, cell_text, read_parts  # noqa: E402

XLSX = ROOT / 'docs' / 'WBS.xlsx'


def main():
    parts = read_parts(str(XLSX))
    x2 = parts[SHEET2]
    x1 = parts[SHEET1]

    rid = None
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', x2, re.S):
        if '<x:v>ATS-403</x:v>' in rm.group(2):
            rid = int(rm.group(1))
            break
    if rid is None:
        print('FAIL: the ATS-403 row is not in the sheet')
        return 1

    status = cell_text(x2, rid, 'N')
    rate = cell_number(x2, rid, 'O')
    remaining = cell_number(x2, rid, 'P')
    note = cell_text(x2, rid, 'T')
    print('ATS-403 row %d' % rid)
    print('  状态=%s 完成率=%s 剩余人日=%s' % (status, rate, remaining))
    print('  风险/说明 marker counts: ATS-403=%d ATS-402=%d ATS-215=%d'
          % (note.count('【ATS-403】'), note.count('【ATS-402】'), note.count('【ATS-215】')))

    problems = []
    if status != '待审核':
        problems.append('状态 is %s, expected 待审核' % status)
    if rate != 1:
        problems.append('完成率 is %s, expected 1' % rate)
    if remaining != 0:
        problems.append('剩余人日 is %s, expected 0' % remaining)
    if note.count('【ATS-403】') != 1:
        problems.append('the ATS-403 marker is not exactly once in the note cell')

    # The narrative cells carry the plain task ids (not the bracketed marker
    # the note cell uses), so they are matched by a distinctive phrase of the
    # task's own fragment instead.
    for row, phrases in ((6, ('可替换模型 API 适配层已实现', '证据工作台已实现')),
                         (7, ('未用真实模型与真实密钥端到端验证',
                              '工作台不代为打开 trace'))):
        text = cell_text(x1, row, 'D')
        print('总览 D%d: %s' % (row, text[:300]))
        for phrase in phrases:
            if phrase not in text:
                problems.append('总览 D%d lost %r' % (row, phrase))

    print('总览 B8=%s B9=%s B10=%s'
          % (cell_text(x1, 8, 'B'), cell_text(x1, 9, 'B'), cell_text(x1, 10, 'B')))

    if problems:
        for p in problems:
            print('FAIL: %s' % p)
        return 1
    print('OK: the ATS-403 row and the narrative cells are consistent')
    return 0


if __name__ == '__main__':
    sys.exit(main())
