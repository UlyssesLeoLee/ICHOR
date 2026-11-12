"""ATS-214: sync docs/WBS.xlsx 「开发WBS」row for ATS-214.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats216.py: the sheet XML is patched in place and the
zip is rewritten with every other part byte-identical.

ATS-214 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): append the ATS-214 note

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

NOTE on 状态: ATS-214 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is submitted, but it has not been accepted yet -- the reviewer
(Opus) syncs 已完成/完成率 after the review passes. Declaring it 已完成
before review would contradict "不得自行置 done".

NOTE on re-runs after acceptance: the review is a one-way door. Once the
reviewer has returned PASS and the row carries 已完成, re-running this script
must NOT walk that row back to 待审核 -- the same guard the other updaters
carry (tools/update_wbs_ats101.py, ..._ats103.py, ..._ats216.py). The guard
protects a row that is accepted AND self-consistent (状态=已完成 with
完成率=1 and 剩余人日=0); a 已完成 row that contradicts its own numbers is a
stale artefact, not an acceptance, and does not get to veto the status this
task owns.

IDEMPOTENCY: running this script twice must leave row ATS-214 byte-identical.
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

MARKER = '【ATS-214】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script: the review is a one-way door.
TERMINAL_STATUSES = ('已完成', '已取消')

# The status the reviewer (Opus) writes after a PASS. It is one of the six
# values in the N-column data-validation list.
STATUS_DONE = '已完成'

NOTE = (
    '已交付用例搜索、标签、过滤及批量运行选择：'
    '实现是 apps/studio/public/case-search.mjs 一份，Next 工作台与零依赖便携 UI 导入同一份代码，'
    '两个界面的检索/过滤口径不会各说各话；'
    '搜索口径：按用例名 / 文件 / 标签检索，三者用同一条规则（大小写不敏感的子串匹配），'
    '检索结果是用例清单的子集，不会出现清单里没有的用例；'
    '标签口径：多标签有「任一」与「全部」两种语义，界面必须标注当前用的是哪一种，本任务默认「任一」（并集）；'
    '标签比较忽略大小写与前导 @（Playwright 要求源码里写 @smoke，但 CLI 报告的是 smoke，实测 1.64.1）；'
    '「集合语义」：搜索、标签、文件、状态四个条件各自是一个集合，结果是它们的交集（AND），'
    '既不是并集，也不是「后一个条件替换前一个」——清掉标签条件不会清掉搜索条件，反之亦然；'
    '界面把每个条件各自保留了多少条单独报出来，因此「没有匹配」与「交集为空」是可区分的；'
    '标签进入目录：权威索引直接取 CLI 的 spec.tags；'
    '静态索引新增词法读取（server/uid.mjs 的 scanCaseTags，读 details 对象的 tag 属性，'
    '并继承 describe 的标签——实测与真实 Playwright 1.64.1 的 --list 输出逐条一致），'
    '因此标签过滤在未可信项目上同样有效，不会只在可信项目上「看起来能用」；'
    '计算式标签（{tag: someVar}）不读——静态索引不求值代码，猜出来的标签会让过滤结果错配；'
    '批量运行：POST /api/projects/:id/run 新增可选字段 selection（用例 UID 数组），'
    '目录里不认识的 UID 一律拒绝（400 SELECTION_UNKNOWN_CASE），空选择拒绝（400 SELECTION_EMPTY），'
    '非数组拒绝（400 SELECTION_NOT_AN_ARRAY），不静默丢弃；'
    '选择集合以快照形式落在运行记录上（selection / selectionUids），'
    '快照自带每条用例的文件、标题与行号，因此目录随后变化这条记录仍可独立阅读；'
    '引擎每次只接受一个测试文件过滤参数（ATS-106 参数基线拒绝第二个位置参数），'
    '因此跨文件的批量运行按文件分组、逐个文件串行执行，批次记录（batchUid / groups / runs）说明如何拆分；'
    '「选了什么、跑了什么」可复现：运行记录里的选择集合与本次运行的 attempt 是两条独立事实，'
    '界面对账表逐项列出「选中但未执行」与「执行但未选中」，多跑不破坏可复现性但必须被看见；'
    '用例与测试：Node UT 35 例全通过（tests/ats214-case-search.test.mjs），'
    'Node IT 11 例全通过（tests/ats214-batch-run-api.test.mjs，真实 Bridge HTTP，'
    '真实 Playwright 1.64.1 权威索引）；'
    'Next.js 16.4.5 静态导出构建实测通过（编译 181ms、TypeScript 1636ms、静态页 3/3）；'
    '全量回归数字以 docs/evidence/ATS-214/02-node-test-full.log 为准（仓库级回归随 dev 漂移，'
    '因此不写死在本注记里）；'
    '已知边界：'
    '本任务只交付「选择集合」与「按文件分组执行」，没有实现「按 UID 精确执行单个用例」——'
    '适配器的 filterByTestUid 能力仍为 false（ATS-301 登记的既有缺口），'
    '所以跨文件批量运行时引擎会跑该文件内的全部用例，多跑的用例由对账表报出；'
    '标签的词法读取只认 details 对象里的字面量 tag/tags 属性，'
    '经变量、函数或配置计算出来的标签读不到；'
    '人工可用性（无障碍/键盘/加载态）未评测，属 ATS-111；'
    '便携 UI 与 Next 工作台的检索、过滤、标签口径已由同一模块保证一致，'
    '但便携 UI 的批量运行按钮未实现（其零依赖约束下只做检索与过滤）；'
    '模块与口径的完整说明见 docs/32-CASE-SEARCH-SELECTION.md。'
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

    rid, _rm = find_ats_row(xml2, 'ATS-214')
    # A re-run must not undo an accepted review: only a row that has not been
    # accepted yet is (re)written. An accepted row keeps its status, and the
    # notes and the cached 总览 values are still refreshed below.
    current = cell_text(xml2, rid, 'N')
    if current not in TERMINAL_STATUSES or not self_consistent(xml2, rid):
        # 待审核 and 已完成 are both in the N-column data-validation list.
        xml2 = set_cell_in_row(xml2, rid, 'N', status)
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-214 note, replacing a previous copy of it.
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
    """The ATS-214 row's cells, for the idempotency check."""
    zin = zipfile.ZipFile(XLSX)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-214')
    return rm.group(0)


def verify():
    """Assert the workbook still parses and row ATS-214 is exactly as intended."""
    zin = zipfile.ZipFile(XLSX)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-214')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    # The row is 待审核 while the review is in flight and 已完成 once the
    # reviewer has returned PASS; either is a correct state, but a row in
    # some OTHER status is not.
    assert status in ('待审核', STATUS_DONE), \
        f'ATS-214 status is {status!r}, expected 待审核 or {STATUS_DONE}'
    assert rate == '1', f'ATS-214 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-214 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-214 note has {note.count(MARKER)} markers, expected 1'
    assert '用例搜索' in note, 'the ATS-214 note is missing the delivered scope'
    print(f'verify: ATS-214 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')


def check_parses():
    """Assert the workbook is loadable -- in both openpyxl modes.

    A note that was written into the sheet XML without XML escaping makes the
    workbook unparseable. The updater still exits 0 in that case, so the
    parse check is the only thing that catches it.
    """
    import openpyxl

    wb = openpyxl.load_workbook(XLSX, data_only=False)
    ws = wb['开发WBS']
    row = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-214'):
            row = r
            break
    assert row is not None, 'the ATS-214 row is not found by openpyxl'
    n_value = ws.cell(row=row, column=14).value
    assert n_value in ('待审核', STATUS_DONE), f'column N is {n_value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    # Column P keeps its formula; the cached value is what the sheet carries.
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-214】') == 1, f'column T carries {note.count("【ATS-214】")} markers'
    assert '用例搜索' in note, 'column T is missing the delivered scope'
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
        help='the 状态 to write into the ATS-214 row (default: 待审核). '
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
            print('IDEMPOTENT: row ATS-214 unchanged')
        else:
            print('CHANGED (first run applied the update)')
        # A second run must be a no-op.
        second_before = row_signature()
        patch_workbook(args.status)
        second_after = row_signature()
        assert second_before == second_after, 'the updater is NOT idempotent'
        print('IDEMPOTENT: a second run leaves row ATS-214 byte-identical')
        verify()
        check_parses()
