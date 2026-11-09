"""ATS-203: sync docs/WBS.xlsx with the indexing regression dataset.

Surgical edit of the existing workbook (no openpyxl SAVE / no rebuild), in the
same style as tools/update_wbs_ats602.py: the sheet XML is patched in place and
the zip is rewritten with every other part byte-identical.

WHAT THIS SCRIPT DOES
----------------------
It syncs the ATS-203 row of the 开发WBS sheet:
    N (状态)   : 未开始 -> 待审核
    O (完成率) : 0 -> 1
    P (剩余人日): cached value 4 -> 0 (the formula K*(1-O) is kept)
    T (风险/说明): the ATS-203 note, marked with 【ATS-203】

The ATS-203 row already exists -- it came with the original WBS sheet -- so
this script does NOT create rows. It owns the ATS-203 row and nothing else: a
row that another task's script wrote is left alone.

WHY THE SCRIPT EXISTS
---------------------
Every delivered task owns exactly one WBS updater, and the ATS-501 regression
(tests for the updaters) runs every tools/update_wbs_*.py in BOTH orders and
requires the result to be the same. Two scripts that both wrote the SAME row
would disagree with each other in one of the two orders. So this script writes
the ATS-203 row, every other script writes its own row, and each owns exactly
one. A task without an updater leaves its WBS row stale -- which is exactly
what happened to ATS-203.

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate:

  B8  COUNTIF(N6:N100,"已完成")       -> counted from the sheet
  B9  1-SUM(P)/SUM(K)                -> computed from the sheet
  B10 SUM(P6:P100)                   -> computed from the sheet

The two narrative cells D6/D7 are shared with every other WBS updater, so this
script contributes ONE marked fragment to each and lets
`wbs_common.set_narrative_cell` compose them.

NOTE on 状态: 待审核 ("pending review"), NOT 已完成. The deliverable is
submitted but not accepted yet -- the reviewer (Opus) syncs the completion
state after the review passes. Declaring it 已完成 before review would
contradict "不得自行置 done".

IDEMPOTENCY: running this script twice leaves the workbook byte-identical.
The marker-aware merge in `wbs_common.set_marked_cell` replaces the previous
marked block instead of appending, and a row that is already 已完成 is not
downgraded, so the second run is a no-op.

    python tools/update_wbs_ats203.py              # write the row
    python tools/update_wbs_ats203.py --verify-only # assert the result
    python tools/update_wbs_ats203.py --status 进行中
"""
import argparse
import re
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from wbs_common import (SHEET1, SHEET2, cell_number, cell_text,  # noqa: E402
                        format_rate, set_cell_in_row, set_marked_cell,
                        set_narrative_cell, totals, xml_escape)

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'

MARKER = '【ATS-203】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script.
TERMINAL_STATUSES = ('已完成', '已取消')

# The note of the ATS-203 row. It says WHAT was delivered and WHAT was not.
#
# IMPORTANT: this note states MEASURED facts, not intentions. The previous
# version of this note claimed the static indexer "marks parameterized cases
# as dynamic". Measurement contradicts that:
#
#   * a `test.each(...)` block yields ZERO tests -- there is no such API in
#     Playwright, so there is nothing to mark;
#   * a `for (const x of [...]) test(`x - ${x}`)` loop yields ONE entry whose
#     title is the literal template string (`支付 - ${method}`), reported as
#     `uidStable: true, uidSource: 'derived'` -- a false-stable entry.
#
# The only thing that mentions dynamics is a blanket `warning` string that is
# the same for every project; it is not per-case handling. So the note says
# exactly that, and names the open defect instead of claiming it is handled.
NOTE = (
    '动态/参数化/项目矩阵索引回归数据集已交付（数据集，非发现实现）：'
    'tests/ats203-regression-dataset.test.mjs 共 8 个回归场景 + 1 个清理用例，'
    '覆盖参数化写法、同一项目被索引两次、跨文件同名标题、'
    'describe 路径变化、嵌套 describe，以及参数化与常规用例混合。'
    '跨文件同名标题由文件路径区分，UID 唯一；同一用例在多次发现中 UID 稳定不变。'
    '重复 describe 名 + 同名标题的情形被标为需人工复核（歧义报告），不是静默合并。'
    '同一项目两次索引产出相同测试集与相同 UID。'
    '本项只交付索引结果是否正确或是否明确标为不可判定；'
    '发现机制沿用 ATS-202 的权威发现，未另起一套实现；'
    'UID 重识别与歧义提示属 ATS-204，本项未越界。'
    '**未解决（已知缺陷，待整改）**：静态索引对参数化写法没有逐例处置——'
    '「test.each(...)」这种写法在 Playwright 里并不存在，静态索引给出 0 条；'
    '「for (const x of [...]) test(`...${x}`)」这种循环写法只给出 1 条，'
    '标题是模板原文（实测「支付 - ${method}」），且被报成 uidStable=true、'
    'uidSource=derived，也就是一条「假稳定」条目。'
    '静态索引只附带一句与项目无关的通用提示'
    '（「静态索引仅识别常见 test()/it() 形式；动态、参数化、fixture 测试不在其中」），'
    '它不是逐例处置，不能当作「已标记为动态」。'
    '权威索引（playwright test --list）能看到循环生成的 3 条，'
    '静态与权威的结果在这一类用例上不一致。'
    '该缺陷的处置方案（把这类条目标为不可判定，或在静态索引里识别循环并拒绝给出 UID）'
    '待定，因此本行的完成度不覆盖这一点。'
    '本机实测 9/9 通过，全量 node --test tests/*.test.mjs 1304 通过 / 2 跳过 / 0 失败，'
    '证据 docs/evidence/ATS-203/。'
)


def find_ats_row(xml, ats_id):
    """Return the row number whose A cell is `ats_id`, or None."""
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--status', default='待审核',
        help='the 状态 to write into the ATS-203 row (default: 待审核). '
             'Use 进行中 while a rework round is in flight.')
    parser.add_argument('--verify-only', action='store_true',
                        help='assert the result instead of writing it')
    parser.add_argument('--xlsx', default=str(XLSX))
    args = parser.parse_args()
    status = args.status
    xlsx = Path(args.xlsx)

    if args.verify_only:
        zin = zipfile.ZipFile(xlsx)
        parts = {n: zin.read(n) for n in zin.namelist()}
        zin.close()
        xml2 = parts[SHEET2].decode('utf-8')
        rid, _rm = find_ats_row(xml2, 'ATS-203')
        if rid is None:
            raise SystemExit('the ATS-203 row is missing from the workbook')
        note = cell_text(xml2, rid, 'T')
        problems = []
        if cell_text(xml2, rid, 'N') != status:
            problems.append(f'N is {cell_text(xml2, rid, "N")!r}, expected {status!r}')
        if cell_number(xml2, rid, 'O') != 1:
            problems.append(f'O is {cell_number(xml2, rid, "O")!r}, expected 1')
        if cell_number(xml2, rid, 'P') != 0:
            problems.append(f'P is {cell_number(xml2, rid, "P")!r}, expected 0')
        if note.count(MARKER) != 1:
            problems.append(f'T carries the marker {note.count(MARKER)} times, expected 1')
        if '未越界' not in note:
            problems.append('T does not say what is NOT in scope')
        if problems:
            for p in problems:
                print(f'FAIL {p}')
            raise SystemExit(1)
        print(f'PASS the ATS-203 row is {status}, 完成率=1, 剩余人日=0, note marker x1')
        return

    shutil.copy2(xlsx, xlsx.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(xlsx)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- the ATS-203 row: 状态 / 完成率 / 剩余人日 -------------------------
    rid, _rm = find_ats_row(xml2, 'ATS-203')
    if rid is None:
        raise SystemExit('the ATS-203 row is missing from the workbook')
    # A re-run must not undo an accepted review. Only a row that has not been
    # accepted yet is written.
    if cell_text(xml2, rid, 'N') not in TERMINAL_STATUSES:
        # 待审核 and 进行中 are both in the N-column data-validation list.
        xml2 = set_cell_in_row(xml2, rid, 'N', status)
    # 完成率 and 剩余人日 follow the status: a row that is still 进行中 has
    # not delivered everything yet, so its 完成率 is below 1 and its 剩余人日
    # is the honest remainder. A submitted row is complete (完成率 = 1).
    estimate = cell_number(xml2, rid, 'K')
    if status == '进行中':
        rate = 0.6
        xml2 = set_cell_in_row(xml2, rid, 'O', repr(rate), numeric=True)
        # P keeps its formula K*(1-O); only the cached value changes.
        xml2 = set_cell_in_row(xml2, rid, 'P', repr(estimate * (1 - rate)), numeric=True)
    else:
        xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
        # P keeps its formula K*(1-O) = 4*(1-1) = 0; only the cached value
        # changes.
        xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # --- annotate the row with this task's scope note ------------------------
    # The marker identifies the note this script owns, so re-running replaces
    # it instead of appending a second copy.
    xml2 = set_marked_cell(xml2, rid, 'T', MARKER, NOTE)

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
    tmp = xlsx.with_suffix('.xlsx.tmp')
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            info = infos[name]
            zi = zipfile.ZipInfo(name, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            zout.writestr(zi, data)
    # os.replace() can fail on Windows when the target is held open; copy then unlink
    shutil.copy2(tmp, xlsx)
    tmp.unlink()
    print(f'overview: 已完成={derived["completed"]} '
          f'完成率={derived["completion_rate"]} 剩余人日={derived["sum_remaining"]}')
    print('updated', xlsx)


if __name__ == '__main__':
    main()
