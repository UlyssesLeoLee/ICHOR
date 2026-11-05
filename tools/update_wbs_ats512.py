"""ATS-512: sync docs/WBS.xlsx with the plugin contract baseline.

Surgical edit of the existing workbook (no openpyxl / no rebuild):
  开发WBS (sheet2):
    - ATS-512 row: 状态 -> 待审核, 完成率 -> 1, 剩余人日 -> formula-driven 0
    - the ATS-512 风险/说明 cell carries the plugin contract's scope note
  总览 (sheet1):
    - refresh the cached values of the existing formulas (B8/B9/B10) so a reader
      that does not recalculate still sees the right numbers
    - extend the narrative cells D6/D7 with the plugin contract's status

Every other row, formula, style and the data validation lists stay byte-identical.

NOTE on 状态: the status is set by the `--status` argument and defaults to
待审核 ("pending review"), NOT 已完成. The deliverable is submitted, but it
has not been accepted yet -- the reviewer syncs 已完成 / 完成率 after the
review passes. Declaring it 已完成 before review would contradict
"不得自行置 done".

    python tools/update_wbs_ats512.py --status 进行中
    python tools/update_wbs_ats512.py --status 待审核

During a rework round the row is set to 进行中, and it returns to 待审核 when
the rework is submitted for review again. A row that has already been
accepted (已完成 / 已取消) is never downgraded by a re-run.
"""
import argparse
import re
import shutil
import zipfile
from pathlib import Path

from wbs_common import (SHEET1, SHEET2, cell_text, format_rate,
                        set_cell_in_row, set_marked_cell, set_narrative_cell,
                        totals)

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'

MARKER = '【ATS-512】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script.
TERMINAL_STATUSES = ('已完成', '已取消')


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def annotate_note(xml, rid, note):
    """Append this script's marked note to cell T<rid>, replacing a previous copy."""
    return set_marked_cell(xml, rid, 'T', MARKER, note)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--status', default='待审核',
        help='the 状态 to write into the ATS-512 row (default: 待审核). '
             'Use 进行中 while a rework round is in flight.')
    args = parser.parse_args()
    status = args.status

    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- ATS-512: 状态 / 完成率 / 剩余人日 -----------------------------------
    rid, _rm = find_ats_row(xml2, 'ATS-512')
    # A re-run must not undo an accepted review. Only a row that has not been
    # accepted yet is set to 待审核.
    if cell_text(xml2, rid, 'N') not in TERMINAL_STATUSES:
        # 待审核 and 进行中 are both in the N-column data-validation list.
        xml2 = set_cell_in_row(xml2, rid, 'N', status)
    # 完成率 and 剩余人日 follow the status: a row that is still 进行中 has
    # not delivered everything yet, so its 完成率 is below 1 and its 剩余人日
    # is the honest remainder. A submitted row is complete (完成率 = 1).
    if status == '进行中':
        xml2 = set_cell_in_row(xml2, rid, 'O', '0.6', numeric=True)
        # P keeps its formula K*(1-O) = 6*(1-0.6) = 2.4; only the cached
        # value changes.
        xml2 = set_cell_in_row(xml2, rid, 'P', '2.4', numeric=True)
    else:
        xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
        # P keeps its formula K*(1-O) = 6*(1-1) = 0; only the cached value
        # changes.
        xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # --- annotate the plugin contract's scope note ---------------------------
    # The script is idempotent: a marker identifies the note this script owns,
    # so re-running replaces it instead of appending a second copy.
    notes = {
        'ATS-512': '插件契约已冻结于 docs/21-PLUGIN-CONTRACT.md：插件 Manifest 声明权限、宿主按策略档位授予（生效集合=声明∩档位∩封闭词汇表）、越权调用被拒且被拒本身进审计、插件作用域由宿主授予、证据 SHA-256 由宿主计算、插件结论为提案（approval 恒为 pending）且提案人不得自审；契约层已实现并经 UT/IT/探针实测，插件宿主、加载器与沙箱在本任务范围内无任何实现',
    }
    for ats, note in notes.items():
        rid, _rm = find_ats_row(xml2, ats)
        xml2 = annotate_note(xml2, rid, note)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh cached formula results + the two narrative cells ------
    # The cached values are DERIVED from the sheet that was just written, not
    # hardcoded: a hardcoded cache is stale as soon as another script changes
    # a row, and the 总览 would then silently disagree with the 开发WBS.
    xml1 = parts[SHEET1].decode('utf-8')
    derived = totals(parts)
    xml1 = set_cell_in_row(xml1, 8, 'B', str(derived['completed']), numeric=True)
    xml1 = set_cell_in_row(
        xml1, 9, 'B', format_rate(derived['completion_rate']), numeric=True)
    xml1 = set_cell_in_row(
        xml1, 10, 'B', repr(int(derived['sum_remaining'])), numeric=True)
    # The two narrative cells are shared with every other WBS updater. Each
    # task contributes one marked fragment and the cell is the composition of
    # all of them, so this script can no longer erase another task's text.
    xml1 = set_narrative_cell(xml1, 6, 'D6')
    xml1 = set_narrative_cell(xml1, 7, 'D7')
    parts[SHEET1] = xml1.encode('utf-8')

    # --- rewrite the archive, preserving every other part byte-for-byte ------
    tmp = XLSX.with_suffix('.xlsx.tmp')
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            info = infos[name]
            zi = zipfile.ZipInfo(name, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            zout.writestr(zi, data)
    # os.replace() can fail on Windows when the target is held open; copy then unlink
    shutil.copy2(tmp, XLSX)
    tmp.unlink()
    print('updated', XLSX)


if __name__ == '__main__':
    main()
