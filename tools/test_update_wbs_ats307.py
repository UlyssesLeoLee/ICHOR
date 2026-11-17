"""pytest: tools/update_wbs_ats307.py on a temporary copy of docs/WBS.xlsx.

Run: python -m pytest -q tools/test_update_wbs_ats307.py

The repository workbook is never written: every test edits a copy (the
updater's `--xlsx` option), so a test that "passes" cannot have modified the
deliverable.

The figures the note carries are checked against the SAME evidence log the
updater reads (`docs/evidence/ATS-307/06-node-test-full.log`). A fixture
that hard-coded "1865" would pass forever; a fixture that reads the log
fails the moment the two disagree -- which is the defect this round is about.
"""
import re
import shutil
import sys
import zipfile
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

import update_wbs_ats307 as updater  # noqa: E402
from wbs_common import SHEET1, SHEET2, read_parts, sheet_cells, totals  # noqa: E402

REPO_WBS = ROOT / 'docs' / 'WBS.xlsx'
REPO_LOG = ROOT / 'docs' / 'evidence' / 'ATS-307' / '06-node-test-full.log'


@pytest.fixture
def copy(tmp_path):
    target = tmp_path / 'WBS.xlsx'
    shutil.copyfile(REPO_WBS, target)
    return target


def row(path, ats_id='ATS-307'):
    rows = sheet_cells(read_parts(path), SHEET2)
    return next(cells for cells in rows.values() if cells.get('A') == ats_id)


def log_figures():
    """The figures the committed evidence log carries."""
    return updater.regression_figures(REPO_LOG)


def rewrite_sheet2(path, edit):
    """Apply `edit(xml) -> xml` to sheet2 of the workbook at `path`."""
    with zipfile.ZipFile(path) as zin:
        infos = zin.infolist()
        parts = {i.filename: zin.read(i.filename) for i in infos}
    parts[SHEET2] = edit(parts[SHEET2].decode('utf-8')).encode('utf-8')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zout:
        for info in infos:
            zout.writestr(info, parts[info.filename])


def test_tc001_default_submits_for_review(copy, capsys):
    assert updater.main(['--xlsx', str(copy)]) == 0
    cells = row(copy)
    assert (cells['N'], cells['O'], cells['P']) == ('待审核', '1', '0')
    assert cells['T'].count('【ATS-307】') == 1
    assert '追溯链' in cells['T']
    assert 'updated' in capsys.readouterr().out


def test_tc002_the_reviewer_can_write_done(copy):
    assert updater.main(['--xlsx', str(copy), '--status', '已完成']) == 0
    assert row(copy)['N'] == '已完成'


def test_tc003_a_second_run_is_a_no_op(copy):
    assert updater.main(['--xlsx', str(copy)]) == 0
    first = copy.read_bytes()
    assert updater.main(['--xlsx', str(copy)]) == 0
    assert copy.read_bytes() == first


def test_tc004_an_accepted_row_is_not_downgraded(copy):
    """A row that already carries 已完成 keeps it across a re-run."""
    assert updater.main(['--xlsx', str(copy), '--status', '已完成']) == 0
    assert updater.main(['--xlsx', str(copy)]) == 0
    assert row(copy)['N'] == '已完成'


def test_tc005_a_foreign_marked_block_survives(copy):
    """Another task's marked block in the same cell is not swallowed."""
    def seed(xml):
        return xml.replace(
            '<x:v>ATS-307</x:v>',
            '<x:v>ATS-307</x:v>', 1)
    # Seed the T cell with a neighbouring task's marked note.
    def edit(xml):
        m = re.search(r'(<x:c r="T47"[^>]*>)(.*?)(</x:c>)', xml, re.S)
        assert m, 'the T cell of row 47 was not found'
        body = m.group(2)
        body = body.replace('<x:v>', '<x:v>【ATS-501】别人的备注。', 1)
        return xml[:m.start()] + m.group(1) + body + m.group(3) + xml[m.end():]
    rewrite_sheet2(copy, edit)
    assert updater.main(['--xlsx', str(copy)]) == 0
    note = row(copy)['T']
    assert '【ATS-307】' in note
    assert '【ATS-501】' in note
    assert '别人的备注' in note


def test_tc006_the_overview_is_derived_from_the_sheet(copy):
    assert updater.main(['--xlsx', str(copy)]) == 0
    parts = read_parts(copy)
    derived = totals(parts)
    rows = sheet_cells(parts, SHEET1)
    assert rows[8]['B'] == str(derived['completed'])
    assert rows[10]['B'] == repr(int(derived['sum_remaining']))


def test_tc007_every_other_member_is_byte_identical(copy):
    with zipfile.ZipFile(REPO_WBS) as zin:
        before = {i.filename: zin.read(i.filename) for i in zin.infolist()}
    assert updater.main(['--xlsx', str(copy)]) == 0
    with zipfile.ZipFile(copy) as zout:
        after = {i.filename: zout.read(i.filename) for i in zout.infolist()}
    for name, data in before.items():
        if name in (SHEET1, SHEET2):
            continue
        assert after[name] == data, '%s was rewritten' % name
    # The recovery copy of the binary IS produced (it is the pre-rewrite
    # state of a file that is rewritten in place); the repository's
    # .gitignore already accounts for it.
    assert list(copy.parent.glob('*.bak'))


def test_tc008_the_note_carries_the_figures_the_evidence_log_holds(copy):
    """TC-008: the note's figures ARE the log's figures.

    The fixture reads the log, so this fails the moment the two disagree --
    which is exactly the drift the round-1 review found.
    """
    assert updater.main(['--xlsx', str(copy)]) == 0
    note = row(copy)['T']
    figures = log_figures()
    assert '%d tests' % figures['tests'] in note
    assert '%d pass' % figures['pass'] in note
    assert '%d fail' % figures['fail'] in note
    assert '%d skipped' % figures['skipped'] in note


def test_tc009_the_note_follows_the_log_not_a_constant(copy, tmp_path, monkeypatch):
    """TC-009: the figures are DERIVED, not a re-typed constant.

    A log whose summary lines say something else must produce a note that
    says something else. If the note kept the old constant, this would fail
    -- which is exactly the round-1 defect (the workbook claimed a pass
    count that no committed log carried).
    """
    log_dir = tmp_path / 'fake' / 'docs' / 'evidence' / 'ATS-307'
    log_dir.mkdir(parents=True)
    fake_log = log_dir / '06-node-test-full.log'
    fake_log.write_text(
        'ℹ tests 42\nℹ pass 1111\nℹ fail 7\nℹ skipped 32\n', encoding='utf-8')
    monkeypatch.setattr(updater, 'EVIDENCE_LOG', fake_log)
    assert updater.main(['--xlsx', str(copy)]) == 0
    note = row(copy)['T']
    assert '1111 pass' in note
    assert '7 fail' in note
    assert '42 tests' in note
    assert '1865 pass' not in note


def test_tc009b_an_incomplete_log_makes_the_updater_refuse_to_write(copy, tmp_path, monkeypatch):
    """TC-009b: a log that does not carry all four lines is refused.

    Writing a note with a partial set of figures would be worse than
    refusing to write, so the updater exits non-zero and names the log.
    """
    log_dir = tmp_path / 'fake' / 'docs' / 'evidence' / 'ATS-307'
    log_dir.mkdir(parents=True)
    fake_log = log_dir / '06-node-test-full.log'
    fake_log.write_text('ℹ tests 42\nℹ pass 1111\n', encoding='utf-8')
    monkeypatch.setattr(updater, 'EVIDENCE_LOG', fake_log)
    before = copy.read_bytes()
    with pytest.raises(SystemExit) as excinfo:
        updater.main(['--xlsx', str(copy)])
    assert 'summary line' in str(excinfo.value)
    assert copy.read_bytes() == before


def test_tc009c_a_stale_note_is_caught_by_verify_only(copy, tmp_path, monkeypatch):
    """TC-009c: a note whose figures disagree with the log is CAUGHT.

    This is the check that would have caught the round-1 defect: the
    workbook's note says one thing and the committed log says another.

    The stale note is produced the way the round-1 defect actually
    happened: the note is written against one log, and the log is then
    re-collected with different numbers. Here the note is written against
    the REAL log and the log is then swapped for one with other numbers.
    """
    # The note is written against the real, committed log.
    assert updater.main(['--xlsx', str(copy)]) == 0
    assert '1865 pass' in row(copy)['T']

    # The log is re-collected with different numbers, and the note is NOT
    # regenerated -- the drift the round-1 review found.
    log_dir = tmp_path / 'fake' / 'docs' / 'evidence' / 'ATS-307'
    log_dir.mkdir(parents=True)
    fake_log = log_dir / '06-node-test-full.log'
    fake_log.write_text(
        'ℹ tests 42\nℹ pass 1111\nℹ fail 0\nℹ skipped 3\n', encoding='utf-8')
    monkeypatch.setattr(updater, 'EVIDENCE_LOG', fake_log)

    with pytest.raises(AssertionError) as excinfo:
        updater.verify(str(copy))
    assert 'evidence log says' in str(excinfo.value)


def test_tc010_a_missing_log_makes_the_updater_refuse_to_write(copy, tmp_path, monkeypatch):
    """TC-010: a missing log makes the updater REFUSE to write.

    The workbook is left byte-identical: a note whose numbers cannot be
    vouched for is worse than no note.
    """
    monkeypatch.setattr(updater, 'EVIDENCE_LOG', tmp_path / 'nope.log')
    before = copy.read_bytes()
    with pytest.raises(SystemExit) as excinfo:
        updater.main(['--xlsx', str(copy)])
    assert 'does not exist' in str(excinfo.value)
    assert copy.read_bytes() == before


def test_tc011_an_unknown_status_is_rejected(copy):
    with pytest.raises(SystemExit):
        updater.main(['--xlsx', str(copy), '--status', 'not-a-status'])


def test_tc012_a_missing_row_raises():
    with pytest.raises(SystemExit):
        updater.find_ats_row('<x:row r="1"><x:c r="A1"><x:v>ATS-999</x:v></x:c></x:row>',
                             'ATS-307')


def test_tc013_verify_only_does_not_write(copy, capsys):
    # Write first: the shipped workbook's note does not carry the figures
    # the log holds, and verify-only is exactly the check that says so.
    assert updater.main(['--xlsx', str(copy)]) == 0
    before = copy.read_bytes()
    assert updater.main(['--xlsx', str(copy), '--verify-only']) == 0
    assert copy.read_bytes() == before
    out = capsys.readouterr().out
    assert 'verify' in out


def test_tc014_the_note_carries_no_review_process_narration(copy):
    """The note describes the delivery, not the review rounds.

    A note that says "round 3" is a log, and a log goes stale as soon as
    the next task reads it.
    """
    assert updater.main(['--xlsx', str(copy)]) == 0
    note = row(copy)['T']
    assert not re.search(r'第\s*[0-9一二三四五]\s*轮', note)
    assert '驳回' not in note
    assert '复核只剩' not in note
