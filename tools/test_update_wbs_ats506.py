"""pytest: tools/update_wbs_ats506.py on a temporary copy of docs/WBS.xlsx.

Run: python -m pytest -q tools/test_update_wbs_ats506.py
The repository workbook is never written: every test edits a copy.
"""
import re
import shutil
import sys
import zipfile
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import update_wbs_ats506 as updater  # noqa: E402
from wbs_common import (SHEET1, SHEET2, format_rate, read_parts,  # noqa: E402
                        set_cell_in_row, set_marked_cell, sheet_cells, totals)

REPO_WBS = TOOLS.parent / 'docs' / 'WBS.xlsx'


@pytest.fixture
def copy(tmp_path):
    target = tmp_path / 'WBS.xlsx'
    shutil.copyfile(REPO_WBS, target)
    return target


def row(path, ats_id='ATS-506'):
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


def ats_rid(path):
    with zipfile.ZipFile(path) as z:
        return updater.find_ats_row(z.read(SHEET2).decode('utf-8'), 'ATS-506')


def test_tc001_default_submits_for_review(copy, capsys):
    assert updater.main(['--xlsx', str(copy)]) == 0
    cells = row(copy)
    assert (cells['N'], cells['O'], cells['P']) == ('待审核', '1', '0')
    assert '【ATS-506】' in cells['T']
    assert 'docs/21-CONTROL-PLANE-API.md' in cells['T']
    assert 'updated' in capsys.readouterr().out


def test_tc002_in_progress_keeps_formula_and_derives_remaining(copy):
    updater.main(['--xlsx', str(copy), '--status', '进行中'])
    cells = row(copy)
    assert (cells['N'], cells['O']) == ('进行中', '0.6')
    assert float(cells['P']) == pytest.approx(float(cells['K']) * 0.4)
    assert cells['P'] == '2.8'
    with zipfile.ZipFile(copy) as z:
        xml = z.read(SHEET2).decode('utf-8')
    rid = updater.find_ats_row(xml, 'ATS-506')
    p_cell = re.search(r'<x:c r="P%d"[^>]*>(.*?)</x:c>' % rid, xml, re.S).group(1)
    assert '<x:f>' in p_cell


def test_tc003_idempotent(copy):
    updater.main(['--xlsx', str(copy)])
    first = copy.read_bytes()
    updater.main(['--xlsx', str(copy)])
    assert copy.read_bytes() == first


@pytest.mark.parametrize('terminal', ['已完成', '已取消'])
def test_tc004_accepted_row_is_not_downgraded(copy, terminal):
    rid = ats_rid(copy)
    rewrite_sheet2(copy, lambda xml: set_cell_in_row(xml, rid, 'N', terminal))
    updater.main(['--xlsx', str(copy)])
    assert row(copy)['N'] == terminal


def test_tc005_foreign_note_survives(copy):
    rid = ats_rid(copy)
    rewrite_sheet2(copy, lambda xml: set_marked_cell(xml, rid, 'T', '【ATS-501】', '外部约束说明'))
    updater.main(['--xlsx', str(copy)])
    note = row(copy)['T']
    assert '【ATS-501】外部约束说明' in note
    assert '【ATS-506】' in note


def test_tc006_overview_is_derived_from_the_sheet(copy):
    updater.main(['--xlsx', str(copy)])
    parts = read_parts(copy)
    derived = totals(parts)
    s1 = sheet_cells(parts, SHEET1)
    assert s1[8]['B'] == str(derived['completed'])
    assert s1[9]['B'] == format_rate(derived['completion_rate'])
    assert s1[10]['B'] == repr(int(derived['sum_remaining']))
    assert '部署式控制面 API 边界骨架已实现' in s1[6]['D']
    assert 'docs/21-CONTROL-PLANE-API.md' in s1[7]['D']
    assert '远程执行面协议已冻结' in s1[6]['D']


def test_tc007_only_the_owned_cells_change(copy):
    # Seed a state the update must change, so the check holds whether or not
    # the input workbook already carries the ATS-506 update.
    rid = ats_rid(copy)
    rewrite_sheet2(copy, lambda xml: set_cell_in_row(xml, rid, 'N', '进行中'))
    before = read_parts(copy)
    with zipfile.ZipFile(copy) as z:
        raw_before = {i.filename: z.read(i.filename) for i in z.infolist()}
        order_before = z.namelist()
    updater.main(['--xlsx', str(copy)])
    with zipfile.ZipFile(copy) as z:
        raw_after = {i.filename: z.read(i.filename) for i in z.infolist()}
        assert z.namelist() == order_before
    for name in raw_before:
        if name not in (SHEET1, SHEET2):
            assert raw_after[name] == raw_before[name], name
    rows_before = sheet_cells(before, SHEET2)
    rows_after = sheet_cells(read_parts(copy), SHEET2)
    changed = [rid for rid in rows_before if rows_before[rid] != rows_after[rid]]
    assert changed == [ats_rid(copy)]
    assert not list(copy.parent.glob('*.bak'))
    assert not list(copy.parent.glob('*.tmp'))


def test_tc008_status_outside_the_allowed_values_is_rejected(copy):
    with pytest.raises(SystemExit) as exc:
        updater.main(['--xlsx', str(copy), '--status', '已完成'])
    assert exc.value.code == 2
    assert row(copy)['N'] != '已完成'


def test_tc009_missing_row_is_reported():
    with pytest.raises(SystemExit, match='ATS-999'):
        updater.find_ats_row('<x:row r="6"><x:c r="A6"><x:v>ATS-506</x:v></x:c></x:row>', 'ATS-999')


def test_number_rendering():
    assert updater._number(1.0) == '1'
    assert updater._number(7 * (1 - 0.6)) == '2.8'
    assert updater._number(0.0) == '0'
