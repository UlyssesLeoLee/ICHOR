"""pytest: branch coverage of the shared WBS helpers in tools/wbs_common.py.

Run: python -m pytest -q tools/test_wbs_common_helpers.py
Synthetic XML strings are used wherever possible; the workbook is only read
(or copied into a temporary directory), never written.
"""
import io
import re
import shutil
import sys
import zipfile
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import wbs_common as w  # noqa: E402

ROW = ('<x:row r="5"><x:c r="A5" t="str"><x:v>ATS-001</x:v></x:c>'
       '<x:c r="B5" s="3" t="str"><x:f>K5*2</x:f><x:v>4</x:v></x:c>'
       '<x:c r="C5"></x:c><x:c r="D5" t="str"><x:v>a &amp; b</x:v></x:c>'
       '<x:c r="E5" t="str"><x:v>n/a</x:v></x:c></x:row>')


def test_tc002_ats506_marker_and_narrative():
    # The assertion is MEMBERSHIP, not position. It used to assert that
    # ATS-506 was the LAST marker, which stopped being true as soon as a
    # later task (ATS-512) added its own marker -- a test that fails on a
    # change it does not care about is a gate that gets ignored, and a
    # gate that gets ignored stops catching real breakage.
    assert '【ATS-506】' in w.MARKERS
    assert len(set(w.MARKERS)) == len(w.MARKERS)
    d6 = w.compose_narrative('', 'D6')
    d7 = w.compose_narrative('', 'D7')
    assert w.NARRATIVE_FRAGMENTS['【ATS-506】']['D6'] in d6
    assert w.NARRATIVE_FRAGMENTS['【ATS-506】']['D7'] in d7
    assert w.NARRATIVE_FRAGMENTS['【ATS-501】']['D6'] in d6
    assert d6.endswith('。') and d7.endswith('。')
    # Recomposing an already composed cell is stable.
    assert w.compose_narrative(d6, 'D6') == d6


def test_tc003_cell_text_and_number():
    assert w.cell_text(ROW, 5, 'Z') == ''
    assert w.cell_text(ROW, 5, 'C') == ''
    assert w.cell_text(ROW, 5, 'D') == 'a & b'
    assert w.cell_number(ROW, 5, 'B') == 4.0
    assert w.cell_number(ROW, 5, 'E') == 0.0
    assert w.cell_number(ROW, 5, 'Z') == 0.0
    assert w._text(b'x') == 'x'
    assert w.xml_unescape(None) == ''
    assert w.xml_unescape('&quot;&apos;&lt;&gt;&amp;') == '"\'<>&'
    assert w.xml_escape('<a & b>') == '&lt;a &amp; b&gt;'
    assert w.format_rate(0.5) == '0.500000000000000'


def test_tc004_set_cell_keeps_formula_and_style():
    out = w.set_cell_in_row(ROW, 5, 'B', '9', numeric=True)
    assert '<x:c r="B5" s="3" t="n"><x:f>K5*2</x:f><x:v>9</x:v></x:c>' in out
    out = w.set_cell_in_row(ROW, 5, 'A', '<x&y>')
    assert '<x:v>&lt;x&amp;y&gt;</x:v>' in out
    assert w.cell_text(out, 5, 'A') == '<x&y>'
    with pytest.raises(SystemExit, match='cell Q not found'):
        w.set_cell(ROW, 'Q', '1')
    with pytest.raises(SystemExit, match='row 9 not found'):
        w.set_cell_in_row(ROW, 9, 'A', '1')


def test_tc005_merge_marked_variants():
    m1, m2 = '【ATS-501】', '【ATS-506】'
    # Plain mode replaces the unmarked prefix and keeps foreign blocks.
    assert w.merge_marked('旧说明；' + m1 + '外部', m2, '新说明', plain=True) == '新说明；' + m1 + '外部'
    assert w.merge_marked(m1 + '外部', m2, '新说明', plain=True) == '新说明；' + m1 + '外部'
    # drop_unmarked discards the prefix.
    assert w.merge_marked('前缀；' + m2 + '旧', m2, '新', drop_unmarked=True) == m2 + '新'
    # Stale fragments and prefixes are removed from the unmarked part only.
    merged = w.merge_marked('保留；旧A；前缀X 内容', m2, '新', stale_prefixes=('前缀X',), stale_fragments=('旧A',))
    assert merged == '保留；' + m2 + '新'
    # A duplicate own block collapses; a marker-prefixed text is not doubled.
    assert w.merge_marked(m2 + '一；' + m2 + '二', m2, m2 + '三') == m2 + '三'
    # Canonical order: 501 before 506 whatever the input order.
    assert w.merge_marked(m2 + '乙；' + m1 + '甲', m2, '乙') == m1 + '甲；' + m2 + '乙'
    # A sentence ending with 。 is not followed by an extra separator.
    assert w.merge_marked('完毕。', m2, '新') == '完毕。' + m2 + '新'
    # Idempotent.
    once = w.merge_marked('说明', m2, '新')
    assert w.merge_marked(once, m2, '新') == once
    assert w.merge_marked(None, m2, '新') == m2 + '新'


def test_tc006_marked_and_narrative_cells():
    sheet = '<x:row r="6"><x:c r="D6" t="str"><x:v>old</x:v></x:c><x:c r="T6"></x:c></x:row>'
    with pytest.raises(SystemExit, match='T7 not found'):
        w.set_marked_cell(sheet, 7, 'T', '【ATS-506】', 'x')
    with pytest.raises(SystemExit, match='D7 not found'):
        w.set_narrative_cell(sheet, 7, 'D7')
    out = w.set_marked_cell(sheet, 6, 'T', '【ATS-506】', 'a<b')
    assert '<x:c r="T6" t="str"><x:v>【ATS-506】a&lt;b</x:v></x:c>' in out
    out = w.set_narrative_cell(sheet, 6, 'D6')
    assert w.NARRATIVE_FRAGMENTS['【ATS-506】']['D6'] in w.cell_text(out, 6, 'D')
    no_value = '<x:row r="6"><x:c r="D6"></x:c></x:row>'
    assert w.NARRATIVE['D6']['base'] in w.cell_text(w.set_narrative_cell(no_value, 6, 'D6'), 6, 'D')


def zip_bytes(members, stored=()):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, text in members.items():
            z.writestr(name, text, compress_type=zipfile.ZIP_STORED if name in stored else zipfile.ZIP_DEFLATED)
    return buf.getvalue()


def test_tc007_zip_reading(tmp_path):
    with pytest.raises(SystemExit, match='not a zip container'):
        w.inflate_zip_entries(b'not a zip at all' * 4)
    parts = w.inflate_zip_entries(zip_bytes({'a.xml': '<a/>', 'b.xml': '<b>文</b>'}, stored=('a.xml',)))
    assert parts == {'a.xml': '<a/>', 'b.xml': '<b>文</b>'}
    copy = tmp_path / 'WBS.xlsx'
    shutil.copyfile(w.WBS, copy)
    assert w.read_parts(copy) == w.read_parts()


def test_tc008_sheet_cells_and_totals():
    shared = '<x:sst><x:si><x:t>已完成</x:t></x:si><x:si><x:t>a&amp;b</x:t></x:si></x:sst>'
    sheet = ('<x:sheetData>'
             '<x:row r="6"><x:c r="A6" t="str"><x:v>ATS-1</x:v></x:c><x:c r="N6" t="s"><x:v>0</x:v></x:c>'
             '<x:c r="K6"><x:v>4</x:v></x:c><x:c r="P6"><x:v>1</x:v></x:c><x:c r="T6" t="s"><x:v>1</x:v></x:c></x:row>'
             '<x:row r="7"><x:c r="A7" t="str"><x:v>ATS-2</x:v></x:c><x:c r="K7"><x:v>x</x:v></x:c><x:c r="P7"><x:v>y</x:v></x:c></x:row>'
             '<x:row r="8"><x:c r="A8" t="str"><x:v>备注</x:v></x:c><x:c r="K8"><x:v>100</x:v></x:c></x:row>'
             '<x:row r="9"></x:row>'
             '</x:sheetData>')
    parts = {w.SHARED_STRINGS: shared, w.SHEET2: sheet}
    rows = w.sheet_cells(parts, w.SHEET2)
    assert rows[6]['N'] == '已完成'
    assert rows[6]['T'] == 'a&b'
    t = w.totals(parts)
    assert t == {'completed': 1, 'sum_estimate': 4.0, 'sum_remaining': 1.0, 'completion_rate': 0.75}
    empty = w.totals({w.SHEET2: '<x:sheetData></x:sheetData>'})
    assert empty['completion_rate'] == 0.0
    repo = w.totals()
    assert repo['sum_estimate'] > 0


def test_tc009_totals_follow_the_grown_sheet():
    """The totals cover every task row, even the ones appended later.

    The 开发WBS sheet grew when ATS-601 appended the mobile rows, and the
    总览 formulas in the workbook were grown with it (`N6:N100`). A
    derivation over the OLD constant (6..94) silently dropped the appended
    rows from the totals, so the cached 总览 value disagreed with the
    formula that produced it.
    """
    shared = '<x:sst><x:si><x:t>已完成</x:t></x:si></x:sst>'
    sheet = ('<x:sheetData>'
             '<x:row r="6"><x:c r="A6" t="str"><x:v>ATS-1</x:v></x:c><x:c r="K6"><x:v>4</x:v></x:c>'
             '<x:c r="P6"><x:v>1</x:v></x:c></x:row>'
             # A task row appended far beyond the OLD constant (94).
             '<x:row r="100"><x:c r="A100" t="str"><x:v>ATS-601</x:v></x:c><x:c r="K100"><x:v>5</x:v></x:c>'
             '<x:c r="P100"><x:v>5</x:v></x:c></x:row>'
             '</x:sheetData>')
    parts = {w.SHARED_STRINGS: shared, w.SHEET2: sheet}
    rows = w.sheet_cells(parts, w.SHEET2)
    assert w.last_data_row(rows) == 100
    t = w.totals(parts)
    # The appended row counts: 4 + 5 estimate, 1 + 5 remaining.
    assert t['sum_estimate'] == 9.0, t
    assert t['sum_remaining'] == 6.0, t
    assert t['completion_rate'] == pytest.approx(1 - 6 / 9)

    # THE RANGE ITSELF: `totals` must not be limited to the rows that
    # existed when the helper was written. Restoring the old constant
    # (LAST_ROW = 94) drops the appended row and reports 4 / 1 instead
    # of 9 / 6 -- this assertion is what makes the defect visible.
    assert t['sum_estimate'] > 4.0, (
        'totals() ignored the rows appended after row '
        f'{w.LAST_ROW}: {t}')

    # The REPO's workbook: the cached 总览 value must agree with the range
    # its own formulas cover. Both are read out of the workbook, so a
    # divergence between them is a real defect.
    repo_parts = w.read_parts()
    overview = repo_parts[w.SHEET1]
    formula = re.search(r'<x:c r="B10"[^>]*>(.*?)</x:c>', overview, re.S)
    assert formula is not None, 'the 总览 B10 cell is missing'
    f = re.search(r'<x:f>(.*?)</x:f>', formula.group(1), re.S)
    assert f is not None, 'the 总览 B10 cell carries no formula'
    covered = re.search(r'P6:P(\d+)', f.group(1))
    assert covered is not None, f'the B10 formula has no P range: {f.group(1)}'
    last = int(covered.group(1))
    repo_rows = w.sheet_cells(repo_parts, w.SHEET2)
    assert w.last_data_row(repo_rows) == last, (
        f'the sheet holds a task in row {w.last_data_row(repo_rows)} but the '
        f'总览 formulas only cover row {last}')
    cached = w.cell_text(overview, 10, 'B')
    derived = w.totals(repo_parts)
    assert float(cached) == derived['sum_remaining'], (
        f'the cached 总览 remaining ({cached}) disagrees with the sheet '
        f'({derived["sum_remaining"]})')
