"""ATS-206: sync the ATS-206 row of docs/WBS.xlsx with the delivered migration CLI.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats202.py and tools/update_wbs_ats506.py: the sheet
XML is patched in place and the zip is rewritten with every other part
byte-identical.

ATS-206 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value K*(1-O) (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-206 note, marked with 【ATS-206】

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate.

XML ESCAPING is load-bearing, not cosmetic: the cell values are written into
`<x:v>` elements, and a note that contains `<`, `>` or `&` written RAW makes
the workbook UNPARSEABLE. `wbs_common.set_marked_cell` applies the XML
spec's own entity set to every value before it goes into the cell.

NOTE on 状态: ATS-206 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is submitted, but it has not been accepted yet -- the reviewer
(Opus) syncs 已完成/完成率 after the review passes. Declaring it 已完成
before review would contradict "不得自行置 done".

IDEMPOTENCY: running this script twice must leave row ATS-206 byte-identical.
The marker-aware merge in `wbs_common.set_marked_cell` replaces the previous
marked block instead of appending, so the second run is a no-op. `verify()`
asserts that.

    python tools/update_wbs_ats206.py                 # 待审核
    python tools/update_wbs_ats206.py --status 进行中
    python tools/update_wbs_ats206.py --xlsx copy.xlsx
    python tools/update_wbs_ats206.py --verify-only
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
                        set_narrative_cell, totals)

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'
ATS_ID = 'ATS-206'
MARKER = '【ATS-206】'
STATUSES = ('待审核', '进行中')
TERMINAL_STATUSES = ('已完成', '已取消')
COMPLETION = {'待审核': 1.0, '进行中': 0.6}

NOTE = (
    '已交付「JSON state 安全导入迁移、备份与回滚」数据迁移 CLI'
    '（docs/24-STATE-MIGRATION.md，工具 tools/migrate_state.mjs）：'
    '内核 server/migration/state-migration.mjs 为纯函数迁移计划，'
    'apply.mjs 为应用引擎（备份→写入→日志→失败自动回滚），'
    'ATS-201 的 tools/migrate_uids.mjs 改为复用同一内核，两处实现不会漂移。'
    '命令：plan（只报告不写）/ apply（迁移，先备份，失败自动回滚）/ '
    'verify（校验 SQLite 镜像与状态一致）/ rollback（显式回滚，含运行目录改回旧名）；'
    '退出码 0 成功、1 失败、2 用法错、3 Bridge 运行中（拒绝迁移）。'
    '数量一致性口径：projects/runs/attempts/artifacts/registryEntries 五项，'
    '迁移前后逐项比对，且在第一次破坏性写入之前判定，不一致即拒绝迁移。'
    '失败可还原：每个被覆盖文件先写 .bak，迁移过程记日志，'
    '失败时按日志（不是重算计划）逐步撤销；SQLite 镜像先写临时库、校验通过才替换，'
    '校验不过的镜像不会被换上。'
    '修复 ATS-201 迁移的两处实测数据丢失：'
    '（A）trust 信任映射被整块丢弃（迁移后已背书项目静默变回未信任）；'
    '（B）uidRegistry 未跟着改键、用例登记条目变得不可达（稳定 UID 丢失）。'
    '根因是迁移结果由固定键重建、不认识的键即丢，且以项目标识符为键的映射未改键；'
    '现改为从原状态副本出发、未知字段原样带过，'
    '并对 trust 与 uidRegistry 按项目 UID 改键（新键下已有值时旧值不覆盖）。'
    '实测：ATS-206 用例 29 项全通过；ATS-201 存量用例 16 项无回归；'
    '全量 541 项（530 通过 / 0 失败 / 11 跳过）。'
    '证据 docs/evidence/ATS-206/（缺陷复现与修复前后对照、UT、CLI 往返、覆盖率）。'
    '已知边界：降级不在本项范围（SQLite down 脚本为显式有损操作，ATS-205 已定义）；'
    '进程级独占与断电恢复归 ATS-207；跨文件系统原子写不成立（备份与状态同目录）；'
    '迁移为离线操作，须先停 Bridge。'
)


def find_ats_row(xml, ats_id):
    """Return the row number whose A cell is `ats_id`."""
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1))
    raise SystemExit(f'row for {ats_id} not found')


def _number(value):
    """Render a cached numeric value without a trailing '.0'."""
    text = repr(round(value, 6))
    return text[:-2] if text.endswith('.0') else text


def update(xlsx_path, status):
    """Write the ATS-206 row and refresh the overview's cached values."""
    xlsx_path = Path(xlsx_path)
    with zipfile.ZipFile(xlsx_path) as zin:
        infos = zin.infolist()
        parts = {i.filename: zin.read(i.filename) for i in infos}

    xml2 = parts[SHEET2].decode('utf-8')
    rid = find_ats_row(xml2, ATS_ID)
    # A row that has already been accepted (已完成 / 已取消) is never
    # downgraded by a later run of this script.
    if cell_text(xml2, rid, 'N') not in TERMINAL_STATUSES:
        completion = COMPLETION[status]
        xml2 = set_cell_in_row(xml2, rid, 'N', status)
        xml2 = set_cell_in_row(xml2, rid, 'O', _number(completion), numeric=True)
        remaining = cell_number(xml2, rid, 'K') * (1 - completion)
        xml2 = set_cell_in_row(xml2, rid, 'P', _number(remaining), numeric=True)
    # 风险/说明: this script's note. The marker-aware merge keeps every other
    # task's marked block in the same cell.
    xml2 = set_marked_cell(xml2, rid, 'T', MARKER, NOTE)
    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh the cached values of the existing formulas ----------
    xml1 = parts[SHEET1].decode('utf-8')
    derived = totals(parts)
    xml1 = set_cell_in_row(xml1, 8, 'B', str(derived['completed']), numeric=True)
    xml1 = set_cell_in_row(xml1, 9, 'B', format_rate(derived['completion_rate']), numeric=True)
    xml1 = set_cell_in_row(xml1, 10, 'B', repr(int(derived['sum_remaining'])), numeric=True)
    xml1 = set_narrative_cell(xml1, 6, 'D6')
    xml1 = set_narrative_cell(xml1, 7, 'D7')
    parts[SHEET1] = xml1.encode('utf-8')

    tmp = xlsx_path.with_name(xlsx_path.name + '.tmp')
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for info in infos:
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            zout.writestr(zi, parts[info.filename])
    # os.replace() can fail on Windows while the target is held open.
    shutil.copyfile(tmp, xlsx_path)
    tmp.unlink()
    print(f'overview: 已完成={derived["completed"]} '
          f'完成率={derived["completion_rate"]} 剩余人日={derived["sum_remaining"]}')


def row_signature(xlsx_path):
    """The ATS-206 row's cells, for the idempotency check."""
    with zipfile.ZipFile(xlsx_path) as zin:
        xml2 = zin.read(SHEET2).decode('utf-8')
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml2, re.S):
        if f'<x:v>{ATS_ID}</x:v>' in rm.group(2):
            return rm.group(0)
    raise SystemExit(f'row for {ATS_ID} not found')


def verify(xlsx_path):
    """Assert the workbook still parses and the ATS-206 row is as intended."""
    with zipfile.ZipFile(xlsx_path) as zin:
        names = zin.namelist()
        assert SHEET2 in names, 'sheet2 missing'
        xml2 = zin.read(SHEET2).decode('utf-8')
    rid = find_ats_row(xml2, ATS_ID)
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    assert status in STATUSES + TERMINAL_STATUSES, f'ATS-206 status is {status!r}'
    assert note.count(MARKER) == 1, f'ATS-206 note has {note.count(MARKER)} markers, expected 1'
    assert '迁移' in note, 'the ATS-206 note is missing the delivered scope'
    print(f'verify: ATS-206 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} '
          f'marker×{note.count(MARKER)}')


def check_parses(xlsx_path):
    """Assert the workbook is loadable -- in both openpyxl modes.

    A note that was written into the sheet XML without XML escaping makes the
    workbook unparseable. The updater still exits 0 in that case, so the
    parse check is the only thing that catches it.
    """
    import openpyxl

    wb = openpyxl.load_workbook(xlsx_path, data_only=False)
    ws = wb['开发WBS']
    row = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(row=r, column=1).value or '').startswith(ATS_ID):
            row = r
            break
    assert row is not None, 'the ATS-206 row is not found by openpyxl'
    assert ws.cell(row=row, column=14).value in STATUSES + TERMINAL_STATUSES, \
        f'column N is {ws.cell(row=row, column=14).value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, \
        f'column O is {ws.cell(row=row, column=15).value!r}'
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), \
        f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count(MARKER) == 1, f'column T carries {note.count(MARKER)} markers'
    assert '迁移' in note, 'column T is missing the delivered scope'
    wb.close()

    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    assert '开发WBS' in wb.sheetnames, 'the 开发WBS sheet is missing in the data_only mode'
    wb.close()
    print('verify: openpyxl loads the workbook in the normal and the data_only mode')


def main(argv=None):
    parser = argparse.ArgumentParser(description='Sync the ATS-206 row of docs/WBS.xlsx.')
    parser.add_argument('--status', default='待审核', choices=STATUSES,
                        help='状态 of the ATS-206 row (default: 待审核; 进行中 during rework)')
    parser.add_argument('--xlsx', default=str(XLSX), help='workbook to edit (default: docs/WBS.xlsx)')
    parser.add_argument('--verify-only', action='store_true',
                        help='only verify the workbook, do not write it')
    args = parser.parse_args(argv)

    target = Path(args.xlsx)
    if args.verify_only:
        verify(target)
        check_parses(target)
        return 0

    before = row_signature(target)
    update(target, args.status)
    after = row_signature(target)
    print('IDEMPOTENT: row ATS-206 unchanged' if before == after
          else 'CHANGED (first run applied the update)')
    # A second run must be a no-op.
    second_before = row_signature(target)
    update(target, args.status)
    second_after = row_signature(target)
    assert second_before == second_after, 'the updater is NOT idempotent'
    print('IDEMPOTENT: a second run leaves row ATS-206 byte-identical')
    verify(target)
    check_parses(target)
    return 0


if __name__ == '__main__':
    sys.exit(main())
