"""pytest: tools/update_wbs_ats207.py on a temporary copy of docs/WBS.xlsx.

Run: python -m pytest -q tools/test_update_wbs_ats207.py
The repository workbook is never written: every test edits a copy.
"""
import shutil
import sys
import zipfile
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import update_wbs_ats207 as updater  # noqa: E402
from wbs_common import (SHEET1, SHEET2, cell_number, format_rate,  # noqa: E402
                        read_parts, set_cell_in_row, set_marked_cell,
                        sheet_cells, totals)

REPO_WBS = TOOLS.parent / 'docs' / 'WBS.xlsx'


@pytest.fixture
def copy(tmp_path):
    target = tmp_path / 'WBS.xlsx'
    shutil.copyfile(REPO_WBS, target)
    return target


def row(path, ats_id='ATS-207'):
    rows = sheet_cells(read_parts(path), SHEET2)
    return next(cells for cells in rows.values() if cells.get('A') == ats_id)


def rewrite_sheet2(path, edit):
    """Apply `edit(xml) -> xml` to sheet2 of the workbook at `path`."""
    with zipfile.ZipFile(path) as zin:
        infos = zin.infolist()
        parts = {i.filename: zin.read(i.filename) for i in infos}
    parts[SHEET2] = edit(parts[SHEET2].decode('utf-8')).encode('utf-8')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zout:
        for info in infos:
            zout.writestr(info, parts[info.filename])


def members(path):
    with zipfile.ZipFile(path) as z:
        return {i.filename: z.read(i.filename) for i in z.infolist()}


def test_tc001_default_submits_for_review(copy, capsys):
    assert updater.main(['--xlsx', str(copy)]) == 0
    cells = row(copy)
    assert (cells['N'], cells['O'], cells['P']) == ('待审核', '1', '0')
    assert cells['T'].count('【ATS-207】') == 1
    assert 'docs/06-DATA-DESIGN.md' in cells['T']
    assert 'updated' in capsys.readouterr().out


def test_tc002_in_progress_during_rework(copy):
    updater.main(['--status', '进行中', '--xlsx', str(copy)])
    cells = row(copy)
    estimate = float(cells['K'])
    assert (cells['N'], cells['O']) == ('进行中', '0.6')
    assert float(cells['P']) == pytest.approx(estimate * 0.4)


def test_tc003_second_run_is_byte_identical(copy):
    updater.main(['--xlsx', str(copy)])
    first = members(copy)
    updater.main(['--xlsx', str(copy)])
    second = members(copy)
    assert first[SHEET2] == second[SHEET2]
    assert first[SHEET1] == second[SHEET1]
    assert row(copy)['T'].count('【ATS-207】') == 1


def test_tc004_accepted_row_is_never_downgraded(copy):
    def accept(xml):
        rid = updater.find_ats_row(xml, 'ATS-207')
        xml = set_cell_in_row(xml, rid, 'N', '已完成')
        xml = set_cell_in_row(xml, rid, 'O', '1', numeric=True)
        return set_cell_in_row(xml, rid, 'P', '0', numeric=True)
    rewrite_sheet2(copy, accept)
    updater.main(['--xlsx', str(copy)])
    cells = row(copy)
    assert (cells['N'], cells['O'], cells['P']) == ('已完成', '1', '0')
    assert '【ATS-207】' in cells['T']


def test_tc005_foreign_marked_block_survives(copy):
    def foreign(xml):
        rid = updater.find_ats_row(xml, 'ATS-207')
        return set_marked_cell(xml, rid, 'T', '【ATS-206】', '迁移须先停 Bridge')
    rewrite_sheet2(copy, foreign)
    updater.main(['--xlsx', str(copy)])
    note = row(copy)['T']
    assert '【ATS-206】迁移须先停 Bridge' in note
    assert note.count('【ATS-207】') == 1


def test_tc006_overview_is_derived_from_the_sheet(copy):
    updater.main(['--xlsx', str(copy)])
    parts = read_parts(copy)
    derived = totals(parts)
    overview = sheet_cells(parts, SHEET1)
    assert overview[8]['B'] == str(derived['completed'])
    assert overview[9]['B'] == format_rate(derived['completion_rate'])
    assert overview[10]['B'] == repr(int(derived['sum_remaining']))
    assert '数据目录单实例锁与崩溃恢复已实现' in overview[6]['D']
    assert 'docs/06-DATA-DESIGN.md §5.7' in overview[7]['D']


def test_tc007_openpyxl_loads_the_result(copy):
    openpyxl = pytest.importorskip('openpyxl')
    updater.main(['--xlsx', str(copy)])
    wb = openpyxl.load_workbook(copy, data_only=False)
    ws = wb['开发WBS']
    found = [r for r in range(1, ws.max_row + 1) if ws.cell(row=r, column=1).value == 'ATS-207']
    assert len(found) == 1
    assert ws.cell(row=found[0], column=14).value == '待审核'
    p_cell = ws.cell(row=found[0], column=16).value
    assert isinstance(p_cell, str) and p_cell.startswith('='), 'column P keeps its formula'
    wb.close()
    openpyxl.load_workbook(copy, data_only=True).close()


def test_tc008_missing_row_is_refused():
    with pytest.raises(SystemExit):
        updater.find_ats_row('<x:sheetData></x:sheetData>', 'ATS-207')


def test_tc009_other_members_untouched(copy):
    before = members(copy)
    updater.main(['--xlsx', str(copy)])
    after = members(copy)
    assert list(before) == list(after), 'member order is kept'
    for name in before:
        if name not in (SHEET1, SHEET2):
            assert before[name] == after[name], name


def test_tc010_invalid_status_is_a_usage_error(copy):
    with pytest.raises(SystemExit) as exc:
        updater.main(['--status', '已完成', '--xlsx', str(copy)])
    assert exc.value.code == 2


def test_tc011_estimate_drives_the_remaining_days(copy):
    updater.main(['--status', '进行中', '--xlsx', str(copy)])
    parts = read_parts(copy)
    xml = parts[SHEET2] if isinstance(parts[SHEET2], str) else parts[SHEET2].decode('utf-8')
    rid = updater.find_ats_row(xml, 'ATS-207')
    assert cell_number(xml, rid, 'P') == pytest.approx(cell_number(xml, rid, 'K') * 0.4)
