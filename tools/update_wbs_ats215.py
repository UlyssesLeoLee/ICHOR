"""ATS-215: sync the ATS-215 row of docs/WBS.xlsx with the delivered workbench.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats216.py: the sheet XML is patched in place and
the zip is rewritten with every other part byte-identical.

ATS-215 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 6 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-215 note, marked with 【ATS-215】

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate:

  B8  COUNTIF(N6:N94,"已完成")       -> counted from the sheet
  B9  1-SUM(P)/SUM(K)                -> computed from the sheet
  B10 SUM(P6:P94)                    -> computed from the sheet

XML ESCAPING (this is load-bearing, not cosmetic)
-----------------------------------------------
The cell values are written into `<x:v>` elements. A note that contains `<`,
`>` or `&` -- a comparison operator, an ampersand -- written RAW into
`xl/worksheets/sheet2.xml` makes the workbook UNPARSEABLE: openpyxl raises a
ParseError, Excel refuses to open it and reports that the file has to be
repaired. The escaping is done by `wbs_common.set_marked_cell` /
`wbs_common.set_cell_in_row`, which apply the XML spec's own entity set
(&, <, >) to every value before it goes into the cell.

NOTE on 状态: ATS-215 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is submitted, but it has not been accepted yet -- the reviewer
(Opus) syncs 已完成/完成率 after the review passes. Declaring it 已完成
before review would contradict "不得自行置 done".

IDEMPOTENCY: running this script twice must leave row ATS-215 byte-identical.
The marker-aware merge in `wbs_common.set_marked_cell` replaces the previous
marked block instead of appending, so the second run is a no-op. `verify()`
asserts that.
"""
import argparse
import re
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wbs_common import (SHEET1, SHEET2, cell_text,  # noqa: E402
                        format_rate, set_cell_in_row, set_marked_cell,
                        set_narrative_cell, totals)

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'

FIRST_ROW, LAST_ROW = 6, 94

MARKER = '【ATS-215】'

NOTE = (
    '已交付证据工作台（Trace/附件定位与执行前后对照）：'
    '验收标准「从失败用例 2 次点击内找到 Trace；显示附件哈希与时间」逐条可测；'
    '实现是 apps/studio/public/evidence-workbench.mjs 一份（另有两个被它依赖的模块：'
    'evidence-workbench-vocabulary.mjs 词汇与 evidence-workbench-index.mjs 定位逻辑），'
    'Next 工作台与零依赖便携 UI 导入同一份实现，两个界面的 Trace 定位不会分歧；'
    '依赖方向单向（vocabulary -> index -> 公开接口），无循环导入；'
    '「2 次点击」是数出来的而不是写死的文案：模块导出 clickPath（点击失败用例 → 点击该用例的 Trace），'
    '点击预算 TRACE_CLICK_BUDGET=2 由模块返回，界面显示这个数，探针在真实浏览器里数真实点击；'
    'Trace 定位分两步且每步都可失败：第一步以引擎自己的记录为准——report.json 里每个附件归属哪个用例是引擎写明的，'
    '桥接把绝对路径换成 run 目录下的相对路径（绝对路径换台机器即失效）；'
    '第二步是兜底推导——报告不可用时按引擎的命名规则推导目录名（实测规则：'
    '测试文件相对 testDir 的路径去掉 .spec/.test 后缀、分隔符换 -、接上 sanitize 过的完整标题，'
    '超长标题会被摘要截断、项目 id 与重试序号会被追加，因此推导只在短标题、单项目、未重试时精确），'
    '且只有当推导出的路径确实是本次归档的证据之一时才接受；'
    '定位不到就报告「定位不到」并给出原因（没有附件／附件里没有 Trace／Trace 不在归档清单中可能被保留期清理），'
    '绝不臆造 Trace 路径——臆造出来的路径比没有路径更坏；'
    '「显示附件哈希与时间」：哈希是归档时清单记录的 SHA-256（ATS-209），不是现在重算的摘要；'
    '被改动过的文件仍显示归档时的摘要，同时校验结果报出 changed/missing，二者是不同的断言，不得互相冒充；'
    '时间取文件自身的修改时间（清单不记录时间，凭空在清单里补一个时间等于声称「归档时刻」，不是读者要问的）；'
    '执行前后对照：compareRuns 按用例身份（文件+describe 路径+标题+行号，同 ATS-208/ATS-204）配对两次运行，'
    '逐项给出前后状态、耗时、attempt 数与各自的 Trace，结论分为 fixed/broken/same/changed/unknown；'
    '两次运行来自不同 commit 时 comparable 为假——代码变更导致的状态变化与不稳定用例导致的状态变化不是一回事，'
    '这一事实被报出而不是被抹平；'
    '接口面：GET /api/runs/:id/workbench（只读，交出事实：run / artifacts / cases / ATS-209 校验结果，'
    '视图由共享模块计算，服务端不实现第二份视图）；'
    '附件路径被规整为 run 目录下的相对路径，越出 run 目录的路径被丢弃并计数报告——'
    '下载端点本来就会以 PATH_OUTSIDE_RUN 拒绝它，留着就是一条打不开的链接；'
    '引擎版本随运行记录（Trace Viewer 是独立程序，其版本须与产生该 trace 的引擎一致，'
    '版本取适配器探测到的已安装 CLI 版本，不是猜的）；'
    '用例：Node UT 22 例全通过（tests/evidence-workbench.test.mjs，含「定位不到就不给 Trace」「摘要取归档值」'
    '「不同 commit 不可比」等可证伪断言）；'
    '系统测试 tools/ats215-probes/st-ats215.mjs 40 项检查全通过'
    '（真实 Bridge + 真实 Playwright + 真实 Chromium：真实失败运行、真实 trace.zip、真实下载、'
    '真实篡改后校验报出 changed、两个界面各数两次真实点击）；'
    'Next.js 16.4.5 静态导出构建实测通过，tsc --noEmit 通过（类型由模块的 JSDoc 推导）；'
    '已知边界：本工作台不代为打开 trace——Trace Viewer 是引擎附带的独立程序，'
    '打开与否、版本是否匹配由读者决定，界面只负责定位、校验与说明；'
    'Trace 定位依赖 report.json，报告缺失或无法解析的运行只能走兜底推导，'
    '而兜底推导在超长标题、多项目或重试场景下不精确（此时报「定位不到」而不是猜）；'
    '「执行前后对照」目前是模块能力与接口基础，界面尚未提供跨运行的并排视图（P1）；'
    '完整说明见 docs/29-EVIDENCE-WORKBENCH.md。'
)


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def patch_workbook(status='待审核'):
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-215')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', status)
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 6*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-215 note, replacing a previous copy of it.
    # The marker-aware merge keeps every other task's marked block in the
    # same cell and re-emits the blocks in canonical order, so the result
    # does not depend on which updater ran last. The note text is
    # XML-ESCAPED by `set_marked_cell`.
    xml2 = set_marked_cell(xml2, rid, 'T', MARKER, NOTE)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh the cached values of the existing formulas -----------
    # The figures are DERIVED from the sheet (wbs_common.totals), not
    # hardcoded: another task's row may already carry a non-zero completion
    # rate, and whichever updater ran last must not restore a stale cache.
    derived = totals(parts)
    xml1 = parts[SHEET1].decode('utf-8')
    xml1 = set_cell_in_row(xml1, 8, 'B', str(derived['completed']), numeric=True)
    xml1 = set_cell_in_row(xml1, 9, 'B', format_rate(derived['completion_rate']), numeric=True)
    xml1 = set_cell_in_row(xml1, 10, 'B', repr(int(derived['sum_remaining'])), numeric=True)
    # The narrative cells D6/D7 are shared by every task: each contributes
    # ONE marked fragment, so they are re-composed from all of them.
    xml1 = set_narrative_cell(xml1, 6, 'D6')
    xml1 = set_narrative_cell(xml1, 7, 'D7')
    parts[SHEET1] = xml1.encode('utf-8')
    print(f'overview: 已完成={derived["completed"]} '
          f'完成率={derived["completion_rate"]} 剩余人日={derived["sum_remaining"]}')

    # --- rewrite the archive, preserving every other part byte-for-byte -----
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


def row_signature():
    """The ATS-215 row's cells, for the idempotency check."""
    zin = zipfile.ZipFile(XLSX)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-215')
    return rm.group(0)


def verify():
    """Assert the workbook still parses and row ATS-215 is exactly as intended."""
    zin = zipfile.ZipFile(XLSX)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read('xl/worksheets/sheet2.xml').decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-215')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    assert status == '待审核', f'ATS-215 status is {status!r}, expected 待审核'
    assert rate == '1', f'ATS-215 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-215 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-215 note has {note.count(MARKER)} markers, expected 1'
    assert '证据工作台' in note, 'the ATS-215 note is missing the delivered scope'
    print(f'verify: ATS-215 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')


def check_parses():
    """Assert the workbook is loadable -- in both openpyxl modes."""
    import openpyxl

    wb = openpyxl.load_workbook(XLSX, data_only=False)
    ws = wb['开发WBS']
    row = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-215'):
            row = r
            break
    assert row is not None, 'the ATS-215 row is not found by openpyxl'
    assert ws.cell(row=row, column=14).value == '待审核', f'column N is {ws.cell(row=row, column=14).value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    # Column P keeps its formula; the cached value is what the sheet carries.
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-215】') == 1, f'column T carries {note.count("【ATS-215】")} markers'
    assert '证据工作台' in note, 'column T is missing the delivered scope'
    wb.close()

    wb = openpyxl.load_workbook(XLSX, data_only=True)
    assert '开发WBS' in wb.sheetnames, 'the 开发WBS sheet is missing in the data_only mode'
    wb.close()
    print('verify: openpyxl loads the workbook in the normal and the data_only mode')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--verify-only', action='store_true')
    ap.add_argument('--status', default='待审核')
    args = ap.parse_args()

    if args.verify_only:
        verify()
        check_parses()
    else:
        before = row_signature()
        patch_workbook(args.status)
        after = row_signature()
        if before == after:
            print('IDEMPOTENT: row ATS-215 unchanged')
        else:
            print('CHANGED (first run applied the update)')
        # A second run must be a no-op.
        second_before = row_signature()
        patch_workbook(args.status)
        second_after = row_signature()
        assert second_before == second_after, 'the updater is NOT idempotent'
        print('IDEMPOTENT: a second run leaves row ATS-215 byte-identical')
        verify()
        check_parses()
