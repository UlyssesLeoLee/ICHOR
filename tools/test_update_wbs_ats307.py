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
import os
import re
import shutil
import subprocess
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
    real = log_figures()
    assert '%d pass' % real['pass'] in row(copy)['T']

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


def test_tc009d_the_graph_figures_come_from_the_probe_log(copy, tmp_path, monkeypatch):
    """TC-009d: the graph's shape is derived from the probe log too.

    The same defect class as the regression figures: a re-typed constant in
    the note goes stale when the tree changes. The node/edge counts are
    read from the probe log, so they cannot.
    """
    probe_dir = tmp_path / 'fake' / 'docs' / 'evidence' / 'ATS-307'
    probe_dir.mkdir(parents=True)
    fake_probe = probe_dir / '03-probe-traceability.log'
    fake_probe.write_text(
        'nodes            : 999\n'
        'edges            : 888\n'
        'chains           : 49\n'
        'complete chains  : 5\n'
        'broken chains    : 44\n'
        '  designed     21\n'
        '  implemented  2\n'
        '  verified     26\n'
        'nodes with a commit : 999 of 999\n'
        'edges with a commit : 888 of 888\n', encoding='utf-8')
    monkeypatch.setattr(updater, 'PROBE_LOG', fake_probe)
    assert updater.main(['--xlsx', str(copy)]) == 0
    note = row(copy)['T']
    assert 'ノード 999' in note
    assert '辺 888' in note


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


def test_tc015_the_note_carries_the_suite_case_counts(copy):
    """The note's case counts are the suite logs' counts.

    A typed count goes stale the moment a case is added, and then the
    workbook claims a count that the committed log contradicts.
    """
    assert updater.main(['--xlsx', str(copy)]) == 0
    note = row(copy)['T']
    suites = updater.suite_figures()
    for suite in ('ut', 'it'):
        needle = '%d 例' % suites[suite]['tests']
        assert needle in note, (
            'the note does not carry the %s case count %r -- the suite log says %r'
            % (suite, needle, suites[suite]))


def test_tc016_a_suite_log_with_a_wrong_count_makes_the_self_check_fail(copy, tmp_path, monkeypatch):
    """TC-016: a note whose case count disagrees with the suite log is CAUGHT.

    The drift is produced the way it actually happens: the note is written
    against one suite log, and the log is then re-collected with a
    different case count -- and the note is NOT regenerated. The
    self-check catches it, so a drifted count cannot reach the workbook.
    """
    # The note is written against the real, committed suite log.
    assert updater.main(['--xlsx', str(copy)]) == 0
    real = updater.suite_figures()
    assert '%d 例' % real['ut']['tests'] in row(copy)['T']

    # The suite log is re-collected with a different count, and the note is
    # not regenerated.
    log_dir = tmp_path / 'fake' / 'docs' / 'evidence' / 'ATS-307'
    log_dir.mkdir(parents=True)
    fake_ut = log_dir / '01-node-test-traceability-ut.log'
    # The count is REPLACED, not typed: every `ℹ tests` line of the log is
    # rewritten, so the test does not have to know how many cases the
    # suite holds today. The log carries the line more than once (the
    # collector runs the suite twice) and the derivation reads the last
    # one -- so ALL of them are rewritten.
    committed = (ROOT / 'docs' / 'evidence' / 'ATS-307' / '01-node-test-traceability-ut.log').read_text(encoding='utf-8')
    rewritten, count = re.subn(r'^\u2139 tests \d+$', '\u2139 tests 999', committed, flags=re.M)
    assert count >= 1, 'the committed suite log carries a `ℹ tests` line'
    fake_ut.write_text(rewritten, encoding='utf-8')
    monkeypatch.setattr(updater, 'UT_LOG', fake_ut)

    with pytest.raises(AssertionError) as excinfo:
        updater.main(['--xlsx', str(copy), '--verify-only'])
    assert 'case count' in str(excinfo.value)


def test_tc017_a_missing_suite_log_makes_the_updater_refuse(tmp_path, monkeypatch):
    """A missing suite log is a refusal, not a note with a missing number."""
    monkeypatch.setattr(updater, 'UT_LOG', tmp_path / 'nope.log')
    with pytest.raises(SystemExit):
        updater.suite_figures()


def test_tc018_the_note_names_every_committed_evidence_log(copy):
    """The evidence LIST is derived from the directory, so a log cannot fall out."""
    assert updater.main(['--xlsx', str(copy)]) == 0
    note = row(copy)['T']
    for name in updater.evidence_figures():
        assert name in note, 'the note does not name the evidence log %r' % name


def test_tc019_the_evidence_list_is_the_directory(copy, tmp_path):
    """The note's list and the directory's logs are the SAME set."""
    directory = tmp_path / 'evidence'
    directory.mkdir()
    (directory / '01-a.log').write_text('x', encoding='utf-8')
    (directory / '02-b.log').write_text('x', encoding='utf-8')
    assert updater.evidence_figures(directory) == ['01-a.log', '02-b.log']
    # And a directory with no log is a refusal.
    empty = tmp_path / 'empty'
    empty.mkdir()
    with pytest.raises(SystemExit):
        updater.evidence_figures(empty)


def test_tc020_the_note_names_the_case_ids_the_suite_log_shows(copy):
    """The note names the cases the suite log shows.

    A case added to the suite is named in the note without a second edit:
    the ids are read from the committed suite log.
    """
    suites = updater.suite_figures()
    assert suites['ut']['ids'], 'the committed suite log names case ids'
    assert all(i.startswith('UT-ATS307-') for i in suites['ut']['ids'])
    # The note carries the count of those ids.
    assert updater.main(['--xlsx', str(copy)]) == 0
    note = row(copy)['T']
    assert '%d 例' % len(suites['ut']['ids']) in note


def test_tc021_the_note_carries_the_commit_coverage(copy):
    """AC-3's measurement is carried by the note, derived from the probe log.

    The commit coverage is a MEASUREMENT (how many nodes and edges carry a
    commit on this tree), so the note must carry the number the probe
    measured -- not a claim about it.
    """
    assert updater.main(['--xlsx', str(copy)]) == 0
    note = row(copy)['T']
    graph = updater.graph_figures()
    assert 'ノード %d/%d' % (graph['nodes_with_commit'], graph['nodes_with_commit_total']) in note
    assert '辺 %d/%d' % (graph['edges_with_commit'], graph['edges_with_commit_total']) in note


def test_tc022_the_note_carries_the_negative_controls_mutation_count(copy):
    """TC-022: the mutation count is DERIVED from the negative control's log.

    The note said "4 mutations" while the probe ran five (the
    commit-propagation mutation was added and the count was not). The count
    a reader trusts must be the one the log holds.
    """
    assert updater.main(['--xlsx', str(copy)]) == 0
    note = row(copy)['T']
    assert '%d 種の改変' % updater.mutation_figures() in note


def test_tc023_a_stale_mutation_count_is_caught(copy, tmp_path, monkeypatch):
    """TC-023: a note whose mutation count disagrees with the log is CAUGHT.

    The drift is produced the way it actually happens: the note is written
    against one log, the probe gains a mutation, the log is re-collected,
    and the note is NOT regenerated.
    """
    assert updater.main(['--xlsx', str(copy)]) == 0
    assert '%d 種の改変' % updater.mutation_figures() in row(copy)['T']

    log_dir = tmp_path / 'fake' / 'docs' / 'evidence' / 'ATS-307'
    log_dir.mkdir(parents=True)
    fake_log = log_dir / '05-negative-control.log'
    # The group headers are APPENDED, not typed: the count is derived from
    # the headers the log carries, so the test does not have to know how
    # many mutations the probe performs today.
    committed = (ROOT / 'docs' / 'evidence' / 'ATS-307' / '05-negative-control.log').read_text(encoding='utf-8')
    fake_log.write_text(committed + '--- 99. an extra mutation ---\n', encoding='utf-8')
    monkeypatch.setattr(updater, 'NEGATIVE_LOG', fake_log)

    with pytest.raises(AssertionError) as excinfo:
        updater.main(['--xlsx', str(copy), '--verify-only'])
    assert 'mutation count' in str(excinfo.value)


def test_tc024_a_missing_negative_control_log_makes_the_updater_refuse(tmp_path, monkeypatch):
    """TC-024: a missing negative control log is a refusal."""
    monkeypatch.setattr(updater, 'NEGATIVE_LOG', tmp_path / 'nope.log')
    with pytest.raises(SystemExit):
        updater.mutation_figures()


def test_tc025_a_negative_control_log_without_groups_makes_the_updater_refuse(tmp_path, monkeypatch):
    """TC-025: a log with no group header cannot back a mutation count."""
    log_dir = tmp_path / 'fake'
    log_dir.mkdir()
    fake_log = log_dir / '05-negative-control.log'
    fake_log.write_text('nothing that names a group\n', encoding='utf-8')
    monkeypatch.setattr(updater, 'NEGATIVE_LOG', fake_log)
    with pytest.raises(SystemExit):
        updater.mutation_figures()


# --- TC-026..TC-028: the STANDALONE consistency gate ---------------------
#
# The gate that compares the evidence README and the design document with
# the committed logs lives in a `.mjs` probe, so it is exercised here by
# INVOKING it -- against the committed tree (it must pass) and against
# mutated copies of it (it must fail, naming what it caught).
#
# Running the gate is not enough: a check that cannot fail proves nothing,
# so each mutation must turn it RED.

GATE = ROOT / 'tools' / 'ats307-probes' / 'check-readme-consistency.mjs'


def _run_gate(tree):
    """Run the consistency gate on `tree` and return (exit code, output)."""
    proc = subprocess.run(
        ['node', str(GATE)],
        cwd=str(tree), capture_output=True, text=True,
        env={**os.environ, 'NO_COLOR': '1'})
    return proc.returncode, proc.stdout + proc.stderr


def _copy_tree(tmp_path):
    """A copy of the repository's committed tree (the gate reads real files)."""
    tree = tmp_path / 'tree'
    subprocess.run(
        ['git', 'clone', '--no-hardlinks', '--quiet', str(ROOT), str(tree)],
        check=True, capture_output=True)
    subprocess.run(['git', '-C', str(tree), 'checkout', '--quiet', '--force', 'HEAD'],
                   check=True, capture_output=True)
    return tree


def test_tc026_the_gate_passes_on_the_committed_tree():
    """TC-026: on the committed tree the gate is green."""
    code, out = _run_gate(ROOT)
    assert code == 0, out
    assert 'RESULT: OK' in out


def test_tc026b_a_stale_full_regression_row_turns_the_gate_red(tmp_path):
    """TC-026b: a README row that contradicts its log turns the gate RED.

    The defect this gate now covers actually happened: the README's
    full-regression row stated `1902 tests / 1870 pass` while the log it
    names said `1953 tests / 1921 pass`. The mutation reproduces it.
    """
    tree = _copy_tree(tmp_path)
    readme = tree / 'docs' / 'evidence' / 'ATS-307' / 'README.md'
    text = readme.read_text(encoding='utf-8')
    mutated = text.replace('2000 tests / 1968 pass', '1902 tests / 1870 pass')
    assert mutated != text, 'the committed README carries the figures to mutate'
    readme.write_text(mutated, encoding='utf-8')
    code, out = _run_gate(tree)
    assert code != 0, 'the gate passed a README that contradicts its log'
    assert 'full-regression tests count' in out


def test_tc027_a_stale_mutation_count_turns_the_gate_red(tmp_path):
    """TC-027: a README claiming the wrong number of mutations turns it RED."""
    tree = _copy_tree(tmp_path)
    readme = tree / 'docs' / 'evidence' / 'ATS-307' / 'README.md'
    text = readme.read_text(encoding='utf-8')
    mutated = text.replace('5 種の改変', '4 種の改変')
    assert mutated != text, 'the committed README carries the count to mutate'
    readme.write_text(mutated, encoding='utf-8')
    code, out = _run_gate(tree)
    assert code != 0, 'the gate passed a README with a stale mutation count'
    assert 'mutation count' in out


def test_tc028_a_stale_design_document_measurement_turns_the_gate_red(tmp_path):
    """TC-028: a design document quoting an earlier tree turns the gate RED.

    The design document's acceptance table is read as a verdict, so a
    stale number there is the most consequential kind of drift.
    """
    tree = _copy_tree(tmp_path)
    design = tree / 'docs' / '33-TRACEABILITY-GRAPH.md'
    text = design.read_text(encoding='utf-8')
    mutated = text.replace('| ノード | 1406 |', '| ノード | 1358 |')
    assert mutated != text, 'the committed design document carries the figure to mutate'
    design.write_text(mutated, encoding='utf-8')
    code, out = _run_gate(tree)
    assert code != 0, 'the gate passed a design document with a stale figure'
    assert 'design document the node count' in out
