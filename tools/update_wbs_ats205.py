"""ATS-205: sync the ATS-205 row of docs/WBS.xlsx with the delivered SQLite layer.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats201.py: the sheet XML is patched in place and the
zip is rewritten with every other part byte-identical.

ATS-205 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 6 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-205 note, marked with 【ATS-205】

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

NOTE on 状态: ATS-205 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is submitted, but it has not been accepted yet -- the reviewer
(Opus) syncs 已完成/完成率 after the review passes. Declaring it 已完成
before review would contradict "不得自行置 done".

IDEMPOTENCY: running this script twice must leave row ATS-205 byte-identical.
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
from wbs_common import (SHEET1, SHEET2, cell_number, cell_text,  # noqa: E402
                        format_rate, set_cell_in_row, set_marked_cell,
                        set_narrative_cell, totals)

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'
SHEET2 = 'xl/worksheets/sheet2.xml'
SHEET1 = 'xl/worksheets/sheet1.xml'

FIRST_ROW, LAST_ROW = 6, 94

MARKER = '【ATS-205】'

NOTE = (
    '已交付 SQLite 元数据层（server/sqlite/）：'
    'schema 版本存放于数据库内部 meta 表的 schema_version 键，不由外部文件推导；'
    '版本化迁移步骤每步都有 up 与 down 脚本，升级只向前且只做增量；'
    '降级显式且有损（down 会删表删列，数据随之消失），永不隐式发生，只能由运维显式调用；'
    '每个迁移步骤在自己的事务里执行，版本号与该步骤的对象写在同一事务，步骤失败则版本不动、对象不残留；'
    '版本在步骤事务内重新读取，两个并发迁移者不会把同一步骤应用两遍；'
    '迁移器不接管外来对象：同名但形状不同的表被拒绝（SCHEMA_OBJECT_CONFLICT）；'
    '比代码更新的数据库被拒绝（SCHEMA_TOO_NEW）而不是被静默降级，'
    '旧程序遇到更新的库会拒绝打开，需按 docs/06 §5.2 的降级流程先停 Bridge 再回滚程序；'
    'journal_mode=WAL，busy_timeout 默认 5000ms 可配置，synchronous=NORMAL；'
    '事务用 BEGIN IMMEDIATE / COMMIT，抛错时 ROLLBACK，Bridge 整份状态在单个事务内写入；'
    '镜像是可恢复的：只有 SQLITE_NOT_AVAILABLE 才永久停用，其余失败在下一次 saveState 重试并整表追平；'
    '镜像的 busy_timeout 收窄到 1000ms，单次 saveState 最多阻塞事件循环 1 秒；'
    '实现落在 server/sqlite/{schema,db,store,import}.mjs 与命令行工具 tools/sqlite_meta.mjs'
    '（status/import/migrate/downgrade/verify，--to 必须是 [0, latestVersion()] 内的整数，'
    'status/verify 不创建数据库文件）；'
    '当前实现是 state.json 的镜像而非第二份事实源，每张表带 doc 列保存原始 JSON 原文，'
    '层未建模的字段也不会丢失；'
    'verifyMirror 比对到查询实际读取的数据（registry 每条内容、索引列与 doc 的一致性、'
    'test_attempts 与 artifacts 的行），不是只比条数；'
    'schema version 2 已部署 meta/projects/runs/uid_registry/run_counters/artifacts/test_attempts；'
    '证据：Node UT 47 例 + IT 7 例全通过（tests/sqlite.test.mjs、tests/sqlite-bridge.test.mjs），'
    '含 WAL 模式实测、事务回滚、迁移幂等、降级丢数据、两个独立进程并发写入全在、'
    '真实阻塞的写者（子进程持有 BEGIN IMMEDIATE，用例断言它等到了锁，busy_timeout=0 时断言它失败）、'
    '注入失败步骤的迁移、并发迁移者不重复执行、'
    '写事务进行中读者读到提交前快照、镜像在持锁超时后恢复并 verify 通过、命令行往返与非法参数拒绝；'
    '覆盖率：core/db/import/schema/store/sqlite_meta 六个文件均 > 90%；'
    '已知边界：当前层只做镜像，不做查询 API；'
    '面向 P1 的目标 schema 见 docs/06-DATA-DESIGN.md §5.4（尚未部署）。'
)


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def patch_workbook():
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-205')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 6*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-205 note, replacing a previous copy of it.
    # The marker-aware merge keeps every other task's marked block in the
    # same cell and re-emits the blocks in canonical order, so the result
    # does not depend on which updater ran last. The note text is
    # XML-ESCAPED by `set_marked_cell`: an operator written raw would make
    # sheet2.xml unparseable.
    xml2 = set_marked_cell(xml2, rid, 'T', MARKER, NOTE)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh the cached values of the existing formulas -----------
    # The figures are DERIVED from the sheet (wbs_common.totals), not
    # hardcoded: another task's row may already carry a non-zero completion
    # rate, and whichever updater ran last must not restore a stale cache.
    xml1 = parts[SHEET1].decode('utf-8')
    derived = totals(parts)
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
    """The ATS-205 row's cells, for the idempotency check."""
    zin = zipfile.ZipFile(XLSX)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-205')
    return rm.group(0)


def verify():
    """Assert the workbook still parses and row ATS-205 is exactly as intended."""
    zin = zipfile.ZipFile(XLSX)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-205')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    assert status == '待审核', f'ATS-205 status is {status!r}, expected 待审核'
    assert rate == '1', f'ATS-205 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-205 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-205 note has {note.count(MARKER)} markers, expected 1'
    assert 'SQLite 元数据层' in note, 'the ATS-205 note is missing the delivered scope'
    print(f'verify: ATS-205 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')


def check_parses():
    """Assert the workbook is loadable -- in both openpyxl modes.

    A note that was written into the sheet XML without XML escaping makes the
    workbook unparseable. The updater still exits 0 in that case, so the
    parse check is the only thing that catches it.

    The `data_only` mode reads the CACHED value of a formula cell. openpyxl
    does not evaluate formulas, so a cell that holds `=K26*(1-O26)` has no
    cached value to read -- the check therefore verifies that the mode LOADS
    the workbook and that the plain mode carries the right values.
    """
    import openpyxl

    wb = openpyxl.load_workbook(XLSX, data_only=False)
    ws = wb['开发WBS']
    row = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-205'):
            row = r
            break
    assert row is not None, 'the ATS-205 row is not found by openpyxl'
    assert ws.cell(row=row, column=14).value == '待审核', f'column N is {ws.cell(row=row, column=14).value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    # Column P keeps its formula; the cached value is what the sheet carries.
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-205】') == 1, f'column T carries {note.count("【ATS-205】")} markers'
    assert 'SQLite 元数据层' in note, 'column T is missing the delivered scope'
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
            print('IDEMPOTENT: row ATS-205 unchanged')
        else:
            print('CHANGED (first run applied the update)')
        # A second run must be a no-op.
        second_before = row_signature()
        patch_workbook()
        second_after = row_signature()
        assert second_before == second_after, 'the updater is NOT idempotent'
        print('IDEMPOTENT: a second run leaves row ATS-205 byte-identical')
        verify()
        check_parses()
