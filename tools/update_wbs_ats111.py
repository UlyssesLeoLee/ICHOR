"""ATS-111: sync the ATS-111 row of docs/WBS.xlsx with the delivered work.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats216.py: the sheet XML is patched in place and
the zip is rewritten with every other part byte-identical.

ATS-111 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 4 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-111 note, marked with 【ATS-111】

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

NOTE on 状态: ATS-111 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is submitted, but it has not been accepted yet -- the reviewer
synchronises 已完成/完成率 after the review passes. Declaring it 已完成
before review would contradict "不得自行置 done".

NOTE on re-runs after acceptance: the review is a one-way door. Once the
reviewer has returned PASS and the row carries 已完成, re-running this script
must NOT walk that row back to 待审核 -- the same guard the other updaters
carry (tools/update_wbs_ats101.py, ..._ats103.py, ..._ats502.py). The guard
protects a row that is accepted AND self-consistent (状态=已完成 with
完成率=1 and 剩余人日=0); a 已完成 row that contradicts its own numbers is a
stale artefact, not an acceptance, and does not get to veto the status this
task owns.

IDEMPOTENCY: running this script twice must leave row ATS-111 byte-identical.
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

MARKER = '【ATS-111】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script: the review is a one-way door.
TERMINAL_STATUSES = ('已完成', '已取消')

# The status the reviewer writes after a PASS. It is one of the six
# values in the N-column data-validation list.
STATUS_DONE = '已完成'

NOTE = (
    '已交付工作台可用性、加载错误、键盘与反馈设计（UI/UX 第一次可用性迭代）：'
    '「空列表/失败/取消/加载态均可辨识」——四态由一份模型定义'
    '（apps/studio/lib/workbench-state.mjs），界面只渲染模型说的东西，'
    '四态各有自己的标签、说明、后续可做什么与 ARIA 语义：'
    '空列表=暂无内容（status/polite）、加载失败=加载失败（alert/assertive）、'
    '已取消=已取消（status/polite）、加载中=加载中（status/polite，aria-busy=true）；'
    '状态不只靠颜色区分（docs/05-UI-UX.md §4），四个标签是四个不同的词，'
    '并且四态的 detail 与 hint 各不相同，一一可读；'
    '「可取消」是真的可取消：目录加载走 apps/studio/lib/api.ts 新增的 cancellableApi '
    '（AbortController），切换项目时旧请求被中止，读者按 Esc 取消正在进行的加载，'
    '面板显示「已取消」而不是「加载失败」也不是永远转圈；'
    '未知结果不吞掉：模型不认识的 outcome 一律报成失败，不报成「暂无内容」，'
    '因为把未知说成成功就是撒谎。'
    '「核心操作可键盘完成」——不是「有 tabindex」，而是真能用键盘走完：'
    '首个 Tab 落在「跳到主要内容」跳转链接上，焦点环可见'
    '（基准样式表在项目下拉、搜索框、弹窗输入框三处写了 outline:none，'
    '本项为这三处补回可见焦点环，并在真实 Chromium 里量到 outline-style=solid、'
    'outline-width=2px）；'
    '焦点顺序按 DOM 实测校准（rail→refresh→project-select→add-project→search→sidebar→'
    'select-bar→panel→content，refresh 在顶栏所以先于项目下拉，模型与实测一致而非与假设一致）；'
    'Esc 取消、Enter 提交（添加项目弹窗改为真正的 form，Enter 走浏览器原生提交）、'
    'Ctrl+Enter 运行当前用例、Ctrl+P 跳到脚本搜索框；'
    '文本框里的 Enter 留给浏览器（isTextEntry 守卫），打字时不会被工作台抢走；'
    '键盘操作清单写在页脚「键盘操作」里，不写下来的快捷键等于没有快捷键。'
    '证据：Node UT 55 例全通过（tests/workbench-state.test.mjs）；'
    '系统测试 tools/ats111-probes/st-ats111.mjs 79 项检查全通过'
    '（真实 Bridge + 真实 Playwright + 真实 Chromium：四种状态逐个真的造出来——'
    '空列表用真的没有用例的项目、失败用探针注入的 500、加载中用挂起的请求、'
    '取消用读者真的按 Esc；核心流程全程只按键不点鼠标）；'
    '可证伪性：27 个变异（17 个模型变异 + 10 个视图接线变异），每一个都被'
    '对应的测试捕获，无一漏网；视图侧的变异覆盖历轮复核发现的缺陷类型：'
    '重载空转、Enter 吞按钮、切换不清目录、快捷键绑在容器上、Esc 不停运行、'
    '弹窗内 Ctrl+P 不被消费、轮询失败被吞掉、取消绕过焦点归还。'
    '全量回归数字以 docs/evidence/ATS-111/02-node-test-full.log 为准（仓库级回归随 dev 漂移，'
    '因此不写死在本注记里）；'
    '本任务自身的套件为 55 例 UT + 79 项 ST + 27 项变异检查（27 个变异）。'
    '已知边界：'
    '本项只覆盖 Next 工作台（apps/studio/app/page.tsx），'
    '零依赖便携 UI（apps/studio/public/fallback.html）未同步这四态与键盘模型，'
    '属后续迭代；'
    '人工评测未做，ST 为真实浏览器脚本驱动，'
    '屏幕阅读器（NVDA/JAWS/VoiceOver）未实机验证，'
    '本项断言的是 ARIA 语义与 live region 的正确性，不等于屏幕阅读器实测；'
    '焦点环按 WCAG 2.2 的 :focus-visible 语义实现，未做对比度实测；'
    '键盘导航覆盖的是主流程（选择项目→搜索→打开用例→运行→查看运行），'
    '表格内的逐单元格键盘导航、虚拟滚动的键盘操作未覆盖。'
)


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def self_consistent(xml, rid):
    """True when the row's 状态 agrees with its own 完成率 / 剩余人日.

    A row that says 已完成 but carries a completion rate below 1 or a
    non-zero remainder contradicts itself; such a row is a stale artefact,
    not an acceptance, and must not veto the status this task owns.
    """
    try:
        rate = float(cell_text(xml, rid, 'O') or 0)
        remaining = float(cell_text(xml, rid, 'P') or 0)
    except ValueError:
        return False
    return rate >= 1 and remaining <= 0


def patch_workbook(status='待审核'):
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-111')
    # A re-run must not undo an accepted review: only a row that has not been
    # accepted yet is (re)written. An accepted row keeps its status, and the
    # notes and the cached 总览 values are still refreshed below.
    current = cell_text(xml2, rid, 'N')
    if current not in TERMINAL_STATUSES or not self_consistent(xml2, rid):
        # 待审核 and 已完成 are both in the N-column data-validation list.
        xml2 = set_cell_in_row(xml2, rid, 'N', status)
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 4*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-111 note, replacing a previous copy of it.
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
    """The ATS-111 row's cells, for the idempotency check."""
    zin = zipfile.ZipFile(XLSX)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-111')
    return rm.group(0)


def verify():
    """Assert the workbook still parses and row ATS-111 is exactly as intended."""
    zin = zipfile.ZipFile(XLSX)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-111')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    # The row is 待审核 while the review is in flight and 已完成 once the
    # reviewer has returned PASS; either is a correct state, but a row in
    # some OTHER status is not.
    assert status in ('待审核', STATUS_DONE), \
        f'ATS-111 status is {status!r}, expected 待审核 or {STATUS_DONE}'
    assert rate == '1', f'ATS-111 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-111 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-111 note has {note.count(MARKER)} markers, expected 1'
    assert '工作台可用性' in note, 'the ATS-111 note is missing the delivered scope'
    print(f'verify: ATS-111 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')


def check_parses():
    """Assert the workbook is loadable -- in both openpyxl modes.

    A note that was written into the sheet XML without XML escaping makes
    the workbook unparseable. The updater still exits 0 in that case, so the
    parse check is the only thing that catches it.
    """
    import openpyxl

    wb = openpyxl.load_workbook(XLSX, data_only=False)
    ws = wb['开发WBS']
    row = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-111'):
            row = r
            break
    assert row is not None, 'the ATS-111 row is not found by openpyxl'
    n_value = ws.cell(row=row, column=14).value
    assert n_value in ('待审核', STATUS_DONE), f'column N is {n_value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    # Column P keeps its formula; the cached value is what the sheet carries.
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-111】') == 1, f'column T carries {note.count("【ATS-111】")} markers'
    assert '工作台可用性' in note, 'column T is missing the delivered scope'
    wb.close()

    wb = openpyxl.load_workbook(XLSX, data_only=True)
    assert '开发WBS' in wb.sheetnames, 'the 开发WBS sheet is missing in the data_only mode'
    wb.close()
    print('verify: openpyxl loads the workbook in the normal and the data_only mode')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--verify-only', action='store_true')
    ap.add_argument(
        '--status', default='待审核',
        help='the 状态 to write into the ATS-111 row (default: 待审核). '
             'Use 已完成 once the review has returned PASS; the row then keeps '
             'that status across later re-runs of this script.')
    args = ap.parse_args()

    if args.verify_only:
        verify()
        check_parses()
    else:
        before = row_signature()
        patch_workbook(args.status)
        after = row_signature()
        if before == after:
            print('IDEMPOTENT: row ATS-111 unchanged')
        else:
            print('CHANGED (first run applied the update)')
        # A second run must be a no-op.
        second_before = row_signature()
        patch_workbook(args.status)
        second_after = row_signature()
        assert second_before == second_after, 'the updater is NOT idempotent'
        print('IDEMPOTENT: a second run leaves row ATS-111 byte-identical')
        verify()
        check_parses()
