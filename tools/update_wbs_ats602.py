"""ATS-602: sync docs/WBS.xlsx with the mobile Flow import.

Surgical edit of the existing workbook (no openpyxl SAVE / no rebuild), in the
same style as tools/update_wbs_ats601.py / tools/update_wbs_ats401.py: the
sheet XML is patched in place and the zip is rewritten with every other part
byte-identical.

WHAT THIS SCRIPT DOES
----------------------
It syncs the ATS-602 row of the 开发WBS sheet:
    N (状态)   : 未开始 -> 待审核
    O (完成率) : 0 -> 1
    P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
    T (风险/说明): the ATS-602 note, marked with 【ATS-602】

The six S6 rows already exist -- tools/update_wbs_ats601.py wrote them when
the mobile stage was introduced -- so this script does NOT create rows. It
owns the ATS-602 row and nothing else: a row that another task's script
wrote is left alone.

WHY THE SCRIPT IS NOT A COPY OF THE ATS-601 ONE
-----------------------------------------------
The ATS-501 regression (tools/ats501-probes/check-wbs-updaters.sh) runs
every tools/update_wbs_*.py in BOTH orders and requires the result to be
the same. Two scripts that both wrote the SAME row would disagree with each
other in one of the two orders. So this script writes the ATS-602 row and
the ATS-601 script writes the ATS-601 row, and each owns exactly one.

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other
rows already carry a non-zero completion rate:

  B8  COUNTIF(N6:N100,"已完成")       -> counted from the sheet
  B9  1-SUM(P)/SUM(K)                -> computed from the sheet
  B10 SUM(P6:P100)                   -> computed from the sheet

The two narrative cells D6/D7 are shared with every other WBS updater, so
this script contributes ONE marked fragment to each and lets
`wbs_common.set_narrative_cell` compose them.

NOTE on 状态: 待审核 ("pending review"), NOT 已完成. The deliverable is
submitted but not accepted yet -- the reviewer (Opus) syncs the completion
state after the review passes. Declaring it 已完成 before review would
contradict "不得自行置 done".

IDEMPOTENCY: running this script twice leaves the workbook byte-identical.
The marker-aware merge in `wbs_common.set_marked_cell` replaces the previous
marked block instead of appending, and a row that is already 已完成 is not
downgraded, so the second run is a no-op.

    python tools/update_wbs_ats602.py              # write the row
    python tools/update_wbs_ats602.py --verify-only # assert the result
    python tools/update_wbs_ats602.py --status 进行中
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

MARKER = '【ATS-602】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script.
TERMINAL_STATUSES = ('已完成', '已取消')

# The note of the ATS-602 row. It says WHAT was delivered and WHAT was not:
# the mapping and the import report are implemented and measured; the
# EXECUTION of a Flow on a device is not, and that belongs to ATS-603.
NOTE = (
    '跨引擎用例模型与移动端 Flow 导入映射已交付（契约层，无真实设备）：'
    '移动端 Flow 映射到统一 TestDefinition，映射不了的步骤保留原文并标记不支持，不静默丢弃。'
    '导入器在 server/discovery/（mobile-flow.mjs 解析、mobile-import.mjs 映射、'
    'mobile-flow-import.mjs 文件级入口）；'
    '映射按语义而非拼写判定（docs/25 §8.2），步骤词表固定为 ATS-601 冻结的六类'
    '（launchApp / tapOn / assertVisible / takeScreenshot / recordScreen / readLogs），'
    '映射器在装载时校验该词表，新增步骤种类若不在 ATS-601 词表内会直接报错。'
    '导入的移动端用例进入统一用例目录（discoverStatic 的 mobile 段），'
    '与 Web 用例同为 TestDefinition，UID 规则与注册表不变。'
    '不支持的步骤保留原文（raw）、行号（line）、判定原因（reason）与建议替代（suggestion），'
    '并进入导入报告（buildImportReport / formatImportReport）；'
    '模型外的参数保留并告警，不丢弃。'
    'Flow 文件按扩展名选择语法（.yaml/.yml 为 YAML 声明，.flow 为线性声明），'
    '两种语法映射到同一组步骤，因此同一场景在两种语法下是同一个用例。'
    'UID 基线是位置（文件+行号），切换导入方式不改变已有 UID；'
    '改标题后由注册表按步骤指纹认回原 UID（uidSource=registry）。'
    '仓库内无 YAML 运行库依赖：解析器是受限子集读取器，只读文本、不执行任何内容。'
    'UT-MOB-200..262 共 51 例（解析、映射、不支持步骤的保留、UID 稳定性、目录集成）'
    '与 IT-ATS602-API-001..008 共 8 例（真实 HTTP 下的目录、导入报告、UID 跨重启稳定）'
    '全部通过，证据 docs/evidence/ATS-602/。'
    '未实现（不属本项）：真实 Android/iOS 设备与模拟器上的 Flow 执行（ATS-603）、'
    '移动端证据归档（ATS-604）、iOS 与 Maestro 兼容性判定（ATS-606）；'
    'FR-032 的状态是映射层已实现，移动端执行能力本身仍为 DESIGNED。'
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
        help='the 状态 to write into the ATS-602 row (default: 待审核). '
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
        rid, _rm = find_ats_row(xml2, 'ATS-602')
        if rid is None:
            raise SystemExit('the ATS-602 row is missing from the workbook')
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
        if '未实现' not in note:
            problems.append('T does not say what is NOT implemented')
        if problems:
            for p in problems:
                print(f'FAIL {p}')
            raise SystemExit(1)
        print(f'PASS the ATS-602 row is {status}, 完成率=1, 剩余人日=0, note marker x1')
        return

    shutil.copy2(xlsx, xlsx.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(xlsx)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- the ATS-602 row: 状态 / 完成率 / 剩余人日 -------------------------
    rid, _rm = find_ats_row(xml2, 'ATS-602')
    if rid is None:
        raise SystemExit('the ATS-602 row is missing from the workbook')
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
        # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value
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
