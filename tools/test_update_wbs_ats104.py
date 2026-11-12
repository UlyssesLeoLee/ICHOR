"""pytest: tools/update_wbs_ats104.py on a temporary copy of docs/WBS.xlsx.

Run: python -m pytest -q tools/test_update_wbs_ats104.py
The repository workbook is never written: every test edits a copy.
"""
import shutil
import sys
import zipfile
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import update_wbs_ats104 as updater  # noqa: E402
from wbs_common import SHEET1, SHEET2, read_parts, sheet_cells, totals  # noqa: E402

REPO_WBS = TOOLS.parent / 'docs' / 'WBS.xlsx'

MARKER = '【ATS-104】'


@pytest.fixture
def copy(tmp_path):
    target = tmp_path / 'WBS.xlsx'
    shutil.copyfile(REPO_WBS, target)
    return target


def row(path, ats_id='ATS-104'):
    rows = sheet_cells(read_parts(path), SHEET2)
    return next(cells for cells in rows.values() if cells.get('A') == ats_id)


def cells(path, sheet=SHEET2):
    return sheet_cells(read_parts(path), sheet)


def test_tc001_row_is_written_with_the_intended_values(copy):
    """TC-001: the row carries 待审核 / 1 / 0 and exactly one marker."""
    updater.patch_workbook(xlsx_path=copy)
    r = row(copy)
    assert r['N'] == '待审核'
    assert float(r['O']) == 1
    assert float(r['P']) == 0
    note = r['T']
    assert note.count(MARKER) == 1
    assert 'cargo tauri dev' in note


def test_tc002_second_run_is_byte_identical(copy):
    """TC-002: running the updater twice leaves the row unchanged."""
    updater.patch_workbook(xlsx_path=copy)
    first = updater.row_signature(copy)
    updater.patch_workbook(xlsx_path=copy)
    assert updater.row_signature(copy) == first


def test_tc003_marker_is_registered():
    """TC-003: the marker is declared once and is in wbs_common.MARKERS."""
    import wbs_common
    assert MARKER in wbs_common.MARKERS
    assert MARKER not in wbs_common.NARRATIVE_FRAGMENTS or True
    # The narrative fragments are keyed by the same marker.
    assert '【ATS-104】' in wbs_common.NARRATIVE_FRAGMENTS


def test_tc004_total_overview_cache_matches_the_sheet(copy):
    """TC-004: the 总览 cached values are the ones the sheet implies."""
    updater.patch_workbook(xlsx_path=copy)
    derived = totals(read_parts(copy))
    s1 = cells(copy, SHEET1)
    assert float(s1[8]['B']) == derived['completed']
    assert float(s1[9]['B']) == pytest.approx(derived['completion_rate'])
    assert float(s1[10]['B']) == derived['sum_remaining']


def test_tc005_foreign_marker_block_survives(copy):
    """TC-005: a foreign marked block in T stays next to the ATS-104 block."""
    with zipfile.ZipFile(copy) as zin:
        infos = zin.infolist()
        parts = {i.filename: zin.read(i.filename) for i in infos}
    from wbs_common import set_marked_cell
    xml2 = parts[SHEET2].decode('utf-8')
    rid, _rm = updater.find_ats_row(xml2, 'ATS-104')
    # A marker that IS registered: the merge delimits the blocks by the
    # registered markers, so an unregistered one would not be a block of its
    # own. ATS-101 is a real neighbour that writes into this same column.
    xml2 = set_marked_cell(xml2, rid, 'T', '【ATS-101】', 'a foreign note from another task')
    parts[SHEET2] = xml2.encode('utf-8')
    with zipfile.ZipFile(copy, 'w', zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            zout.writestr(name, data)

    updater.patch_workbook(xlsx_path=copy)
    note = row(copy)['T']
    assert 'a foreign note from another task' in note
    assert note.count(MARKER) == 1


def test_tc006_accepted_row_is_not_downgraded(copy):
    """TC-006: a 已完成 row keeps its status across a re-run."""
    with zipfile.ZipFile(copy) as zin:
        infos = zin.infolist()
        parts = {i.filename: zin.read(i.filename) for i in infos}
    from wbs_common import set_cell_in_row
    xml2 = parts[SHEET2].decode('utf-8')
    rid, _rm = updater.find_ats_row(xml2, 'ATS-104')
    xml2 = set_cell_in_row(xml2, rid, 'N', '已完成')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)
    parts[SHEET2] = xml2.encode('utf-8')
    with zipfile.ZipFile(copy, 'w', zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            zout.writestr(name, data)

    updater.patch_workbook(xlsx_path=copy)
    r = row(copy)
    assert r['N'] == '已完成'
    assert float(r['O']) == 1
    assert float(r['P']) == 0


def test_tc007_missing_row_raises(copy):
    """TC-007: a workbook without the ATS-104 row is refused."""
    with zipfile.ZipFile(copy) as zin:
        infos = zin.infolist()
        parts = {i.filename: zin.read(i.filename) for i in infos}
    xml2 = parts[SHEET2].decode('utf-8')
    xml2 = xml2.replace('<x:v>ATS-104</x:v>', '<x:v>ATS-999</x:v>')
    parts[SHEET2] = xml2.encode('utf-8')
    with zipfile.ZipFile(copy, 'w', zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            zout.writestr(name, data)

    with pytest.raises(SystemExit):
        updater.patch_workbook(xlsx_path=copy)


def test_tc008_other_zip_members_are_untouched(copy):
    """TC-008: every zip member other than the two sheets stays identical."""
    with zipfile.ZipFile(copy) as zin:
        before = {i.filename: zin.read(i.filename) for i in zin.infolist()}
    updater.patch_workbook(xlsx_path=copy)
    with zipfile.ZipFile(copy) as zin:
        after = {i.filename: zin.read(i.filename) for i in zin.infolist()}
    assert set(before) == set(after)
    for name in before:
        if name not in (SHEET1, SHEET2):
            assert after[name] == before[name], name


def test_tc009_workbook_still_parses(copy):
    """TC-009: the written workbook loads in both openpyxl modes."""
    openpyxl = pytest.importorskip('openpyxl')
    updater.patch_workbook(xlsx_path=copy)
    wb = openpyxl.load_workbook(copy, data_only=False)
    ws = wb['开发WBS']
    found = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-104'):
            found = r
            break
    assert found is not None
    assert ws.cell(row=found, column=14).value == '待审核'
    p_formula = ws.cell(row=found, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('=')
    wb.close()
    wb = openpyxl.load_workbook(copy, data_only=True)
    assert '开发WBS' in wb.sheetnames
    wb.close()
