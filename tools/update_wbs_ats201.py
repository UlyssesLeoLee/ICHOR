"""ATS-201: sync the ATS-201 row of docs/WBS.xlsx with the delivered UID scheme.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats301.py and tools/update_wbs_ats401.py: the sheet
XML is patched in place and the zip is rewritten with every other part
byte-identical.

ATS-201 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 4 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-201 note, marked with 【ATS-201】

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate:

  B8  COUNTIF(N6:N94,"已完成")       -> counted from the sheet
  B9  1-SUM(P)/SUM(K)                -> computed from the sheet
  B10 SUM(P6:P94)                    -> computed from the sheet

XML ESCAPING (this is load-bearing, not cosmetic)
-----------------------------------------------
The cell values are written into `<x:v>` elements. A note that contains `<`,
`>` or `&` -- a hex digest in angle brackets, a comparison operator, an
ampersand -- written RAW into `xl/worksheets/sheet2.xml` makes the workbook
UNPARSEABLE: openpyxl raises a ParseError, Excel refuses to open it and
reports that the file has to be repaired. The escaping is done by
`wbs_common.set_marked_cell` / `wbs_common.set_cell_in_row`, which apply the
XML spec's own entity set (&, <, >) to every value before it goes into the
cell.

NOTE on 状态: ATS-201 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is submitted, but it has not been accepted yet -- the reviewer
(Opus) syncs 已完成/完成率 after the review passes. Declaring it 已完成
before review would contradict "不得自行置 done".

IDEMPOTENCY: running this script twice must leave row ATS-201 byte-identical.
The marker-aware merge in `wbs_common.set_marked_cell` replaces the previous
marked block instead of appending, so the second run is a no-op. `verify()`
asserts that.
"""
import re
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wbs_common import cell_number, cell_text, set_cell_in_row, set_marked_cell

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'
SHEET2 = 'xl/worksheets/sheet2.xml'
SHEET1 = 'xl/worksheets/sheet1.xml'

FIRST_ROW, LAST_ROW = 6, 94

MARKER = '【ATS-201】'

NOTE = (
    '已交付 UID 规范 v1（docs/18-UID-SPEC.md）：'
    'Project proj_1_<24hex>、TestDefinition tc-*/tc_1_d_*/tcp_1_*、Run run_1_<24hex>、Attempt att_1_<24hex>；'
    '跨文件改名保持 UID，改标题后靠 UID 注册表找回原 UID（同一 uid 的多条注册表条目按去重后的 uid 计数，'
    '陈旧条目会被裁剪，不再永久挡住注册表规则）；'
    '显式标注 @TC-xxx 优先于注册表，重复的显式 UID 进入歧义报告并出现在 warning 中；'
    'file-line 绑定同时校验标题，绝不把一个用例绑到另一个用例的 UID；'
    '重复标题按执行体指纹区分，无法唯一判定时报告歧义；'
    'Attempt.status 取 result 级状态（重试的 flaky 用例 retry0=failed、retry1=passed）；'
    '项目判重使用与 UID 相同的规范化（大小写变体返回 PROJECT_ALREADY_REGISTERED）；'
    '迁移脚本 tools/migrate_uids.mjs（确定性、幂等、含运行目录改名、迁移后引用与计数器同步）；'
    '迁移要求 Bridge 已停止——数据目录由 bridge.lock 独占，Bridge 在运行时迁移会被拒绝（退出码 2），'
    '回滚用 --rollback 同时还原 state.json 与运行目录改名；'
    '证据 docs/evidence/ATS-201/（Node UT/IT 全通过 + 端到端检查 + 真实 Playwright 报告契约检查 + '
    '迁移序号撞号检查 + 复核反例回归探针 + 行覆盖率）。'
    '已知边界：同名用例改执行体后 UID 会变（describe 路径不参与标题键）；'
    '动态/参数化用例的权威发现归 ATS-202（FR-021），'
    '重识别与歧义提示策略归 ATS-204，SQLite 迁移归 ATS-205，Run/Test/Attempt 统一模型归 ATS-208'
)


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def summarise(xml2):
    """Recompute the overview's cached formula values from the sheet itself.

    Mirrors the three formulas that live in the 总览 sheet:
      B8  = COUNTIF('开发WBS'!N6:N94,"已完成")
      B9  = IFERROR(1-SUM('开发WBS'!P6:P94)/SUM('开发WBS'!K6:K94),0)
      B10 = SUM('开发WBS'!P6:P94)
    """
    done = 0
    sum_p = 0.0
    sum_k = 0.0
    for rid in range(FIRST_ROW, LAST_ROW + 1):
        if cell_text(xml2, rid, 'N') == '已完成':
            done += 1
        sum_p += cell_number(xml2, rid, 'P')
        sum_k += cell_number(xml2, rid, 'K')
    rate = 0.0 if sum_k == 0 else 1 - sum_p / sum_k
    return done, rate, sum_p


def patch_workbook():
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-201')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 4*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-201 note, replacing a previous copy of it.
    # The marker-aware merge keeps every other task's marked block in the
    # same cell and re-emits the blocks in canonical order, so the result
    # does not depend on which updater ran last. The note text is XML-ESCAPED
    # by `set_marked_cell`: a `<24hex>` digest or a comparison operator
    # written raw would make sheet2.xml unparseable.
    xml2 = set_marked_cell(xml2, rid, 'T', MARKER, NOTE)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh the cached values of the existing formulas -----------
    done, rate, sum_p = summarise(xml2)
    xml1 = parts[SHEET1].decode('utf-8')
    xml1 = set_cell_in_row(xml1, 8, 'B', str(done), numeric=True)
    xml1 = set_cell_in_row(xml1, 9, 'B', repr(rate), numeric=True)
    xml1 = set_cell_in_row(xml1, 10, 'B', str(int(sum_p)) if sum_p == int(sum_p) else str(sum_p), numeric=True)
    parts[SHEET1] = xml1.encode('utf-8')
    print(f'overview: 已完成={done} 完成率={rate} 剩余人日={sum_p}')

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
    """The ATS-201 row's cells, for the idempotency check."""
    zin = zipfile.ZipFile(XLSX)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-201')
    return rm.group(0)


def verify():
    """Assert the workbook still parses and row ATS-201 is exactly as intended."""
    zin = zipfile.ZipFile(XLSX)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-201')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    assert status == '待审核', f'ATS-201 status is {status!r}, expected 待审核'
    assert rate == '1', f'ATS-201 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-201 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-201 note has {note.count(MARKER)} markers, expected 1'
    assert 'UID 规范 v1' in note, 'ATS-201 note is missing the delivered scope'
    print(f'verify: ATS-201 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')


def check_parses():
    """Assert the workbook is loadable -- in both openpyxl modes.

    A note that was written into the sheet XML without XML escaping makes the
    workbook unparseable. The updater still exits 0 in that case, so the
    parse check is the only thing that catches it.

    The `data_only` mode reads the CACHED value of a formula cell. openpyxl
    does not evaluate formulas, so a cell that holds `=K22*(1-O22)` has no
    cached value to read -- the check therefore verifies that the mode LOADS
    the workbook and that the plain mode carries the right values.
    """
    import openpyxl

    wb = openpyxl.load_workbook(XLSX, data_only=False)
    ws = wb['开发WBS']
    row = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-201'):
            row = r
            break
    assert row is not None, 'the ATS-201 row is not found by openpyxl'
    assert ws.cell(row=row, column=14).value == '待审核', f'column N is {ws.cell(row=row, column=14).value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    # Column P keeps its formula; the cached value is what the sheet carries.
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-201】') == 1, f'column T carries {note.count("【ATS-201】")} markers'
    assert 'UID 规范 v1' in note, 'column T is missing the delivered scope'
    wb.close()

    wb = openpyxl.load_workbook(XLSX, data_only=True)
    assert '开发WBS' in wb.sheetnames, 'the 开发WBS sheet is missing in the data_only mode'
    wb.close()
    print('verify: openpyxl loads the workbook in the normal and the data_only mode')


if __name__ == '__main__':
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument('--verify-only', action='store_true')
    args = ap.parse_args()

    if args.verify_only:
        verify()
        check_parses()
    else:
        before = row_signature()
        patch_workbook()
        after = row_signature()
        if before == after:
            print('IDEMPOTENT: row ATS-201 unchanged')
        else:
            print('CHANGED (first run applied the update)')
        # A second run must be a no-op.
        second_before = row_signature()
        patch_workbook()
        second_after = row_signature()
        assert second_before == second_after, 'the updater is NOT idempotent'
        print('IDEMPOTENT: a second run leaves row ATS-201 byte-identical')
        verify()
        check_parses()
