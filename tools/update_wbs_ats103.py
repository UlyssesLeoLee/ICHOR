"""ATS-103: sync docs/WBS.xlsx with the verified frontend export baseline.

Surgical edit of the existing workbook (no openpyxl / no rebuild), the same
approach as `tools/update_wbs_ats501.py`:

  开发WBS (sheet2):
    - ATS-103 row: 状态 -> 待审核, 完成率 -> 1, 剩余人日 -> formula-driven 0
    - the ATS-103 风险/说明 cell carries the export/proxy verification scope
    - the downstream rows that ATS-103 unblocks are annotated with the
      constraint this delivery actually established

  总览 (sheet1):
    - refresh the cached values of the existing formulas (B8/B9/B10) so a reader
      that does not recalculate still sees the right numbers
    - extend the narrative cells D6/D7 with the frontend export's status

Every other row, formula, style and the data-validation lists stay
byte-identical.

NOTE on 状态: the status is set by the `--status` argument and defaults to
待审核 ("pending review"), NOT 已完成. The deliverable is frozen and
submitted, but it has not been accepted yet -- the reviewer syncs
已完成/完成率 after the review passes. Declaring it 已完成 before review
would contradict "不得自行置 done".

    python tools/update_wbs_ats103.py --status 进行中
    python tools/update_wbs_ats103.py --status 待审核

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

MARKER = '【ATS-103】'

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
        help='the 状态 to write into the ATS-103 row (default: 待审核). '
             'Use 进行中 while a rework round is in flight.')
    args = parser.parse_args()
    status = args.status

    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- ATS-103: 状态 / 完成率 / 剩余人日 -----------------------------------
    rid, _rm = find_ats_row(xml2, 'ATS-103')
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
        # P keeps its formula K*(1-O) = 4*(1-0.6) = 1.6; only the cached value
        # changes.
        xml2 = set_cell_in_row(xml2, rid, 'P', '1.6', numeric=True)
    else:
        xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
        # P keeps its formula K*(1-O) = 4*(1-1) = 0; only the cached value
        # changes.
        xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # --- annotate this task's scope and the downstream constraints ---------
    # The script is idempotent: a marker identifies the note this script owns,
    # so re-running replaces it instead of appending a second copy.
    notes = {
        'ATS-103': '交付物为验证与证据（产品代码零改动）：tools/ats103-probes/verify-export-and-proxy.mjs '
                   '26/26 项通过（静态导出产物自洽、导出目录无服务端路由产物、'
                   'Bridge 在 / 提供该导出并带 connect-src CSP、会话/项目/运行三类操作实测成功、'
                   '真实运行 1 PASS/1 FAIL 共 2 例并采集 27 个产物）；'
                   'tools/ats103-probes/ui-smoke.mjs 在真实 headless Chromium 里驱动导出的那一页 7/7 通过'
                   '（会话→添加项目→运行到终态，console error 为 0）。'
                   '「API 代理」在 output:export 下的真实形态是导出页到 Bridge 的跨源直连'
                   '（基址由 lib/api.ts 运行时按端口解析，构建期不烘焙），静态导出下不存在 Next.js 服务端代理路由；'
                   '三个变异（服务端路由/构建期烘焙基址/引擎缺失）证明探针会变红。'
                   '详见 docs/22-FRONTEND-EXPORT.md §2',
        'ATS-104': '前置 ATS-103 已交付静态导出基线：apps/studio/out 可由 Bridge 直接提供（server/index.mjs '
                   '的 staticFile() 以该目录为静态根），本项的 Tauri 壳可直接加载该导出；'
                   '但静态导出未在真实 Tauri 壳内实测，且 ATS-102 的 B-02 阻断仍未关闭（仓库缺 '
                   'src-tauri/icons/icon.ico、MSVC C++ 构建工具缺失），该 job 属本项交付范围。'
                   '另注：Bridge 的静态路由只覆盖 /，目录索引与 404 未实现（ATS-103 交付时发现）',
        'ATS-111': '前置 ATS-103 已交付可用的静态导出产物与 API 契约（会话/项目/运行三类操作实测通过，'
                   '真实浏览器脚本驱动导出的那一页 7/7 通过），本项的可用性迭代可直接在该产物上进行；'
                   '但 ATS-103 的浏览器验证是脚本驱动的，未做人工评测（无障碍/键盘/加载态属本项 ST 范围）',
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

    # --- rewrite the archive, preserving every other part byte-for-bit ------
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
