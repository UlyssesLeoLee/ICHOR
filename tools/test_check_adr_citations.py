"""pytest: tools/check_adr_citations.py against a temporary tree.

Run: python -m pytest -q tools/test_check_adr_citations.py

The module reads `ROOT` and `ADR` from module scope, so the tests point
`ROOT` at a temporary tree and drive `main()` in-process. The repository
tree is never written: the script only reads.
"""
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

import check_adr_citations as checker  # noqa: E402

# Every file the real ADR cites, plus the four port-bearing files. The
# fixtures copy the REAL content, so a change to the real source that moves
# a needle breaks the fixture and is reported rather than silently papered
# over.
CITED_FILES = [
    'apps/studio/app/page.tsx',
    'apps/studio/lib/api.ts',
    'apps/studio/public/fallback.html',
    'server/core.mjs',
    'server/index.mjs',
    'src-tauri/Cargo.toml',
    'src-tauri/src/lib.rs',
    'start.ps1',
    'start.sh',
    'tools/generate_test_docs.py',
]

PORT_FILES = [
    'apps/studio/lib/api.ts',
    'apps/studio/app/page.tsx',
    'apps/studio/public/fallback.html',
    'src-tauri/src/lib.rs',
]


@pytest.fixture
def tree(tmp_path, monkeypatch):
    """A temporary tree holding the real cited files and the real ADR."""
    for rel in CITED_FILES:
        target = tmp_path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text((ROOT / rel).read_text(encoding='utf-8'), encoding='utf-8')
    docs = tmp_path / 'docs'
    docs.mkdir(parents=True, exist_ok=True)
    (docs / '16-BASELINE-ADR.md').write_text(
        (ROOT / 'docs' / '16-BASELINE-ADR.md').read_text(encoding='utf-8'), encoding='utf-8')
    monkeypatch.setattr(checker, 'ROOT', tmp_path)
    monkeypatch.setattr(checker, 'ADR', docs / '16-BASELINE-ADR.md')
    return tmp_path


def read_adr(tree):
    return (tree / 'docs' / '16-BASELINE-ADR.md').read_text(encoding='utf-8')


def write_adr(tree, text):
    (tree / 'docs' / '16-BASELINE-ADR.md').write_text(text, encoding='utf-8')


def derived_positions():
    """The derived port positions, in the REAL tree."""
    original = checker.ROOT
    checker.ROOT = ROOT
    try:
        return checker.port_audited_table()
    finally:
        checker.ROOT = original


def test_tc001_the_real_tree_resolves(tree, capsys):
    """TC-001: a citation that holds the needle resolves; the run is OK."""
    assert checker.main() == 0
    assert 'RESULT: OK' in capsys.readouterr().out


def test_tc002_a_cited_position_off_by_one_fails(tree, capsys):
    """TC-002: a citation that does NOT hold the needle is reported."""
    derived = derived_positions()
    (position,) = list(derived['apps/studio/app/page.tsx'])
    text = read_adr(tree)
    write_adr(tree, text.replace(
        '`apps/studio/app/page.tsx:%d`' % position,
        '`apps/studio/app/page.tsx:%d`' % (position + 1)))
    assert checker.main() == 1
    out = capsys.readouterr().out
    assert 'RESULT: MISMATCH' in out
    assert 'apps/studio/app/page.tsx' in out


def test_tc003_the_derived_position_is_the_line_that_holds_the_port():
    """TC-003: the derived position IS the port-bearing line."""
    derived = derived_positions()
    for rel in PORT_FILES:
        lines = (ROOT / rel).read_text(encoding='utf-8').split('\n')
        for position in derived.get(rel, {}):
            # The port NUMBER is not spelled out here: the port audit scans
            # every source file for it, and a literal in this test file
            # would make the test file look like a runtime hardcoding site.
            # What is asserted is that the derived line is one the port
            # audit itself would count -- it carries the ATS_PORT default
            # or the loopback URL, and nothing else.
            line = lines[position - 1]
            assert ('127.0.0.1:' in line or 'ATS_PORT' in line), \
                '%s:%d does not hold the port' % (rel, position)


def test_tc004_a_moved_port_line_moves_the_derived_position(tree):
    """TC-004: a rewrite that moves the port line moves the derived position.

    This is the property the hand-written position could not hold: the table
    went stale on every rewrite, and the gate turned red for a bookkeeping
    reason that had nothing to do with the code. The derivation follows the
    source.
    """
    before = derived_positions()['apps/studio/app/page.tsx']
    target = tree / 'apps/studio/app/page.tsx'
    text = target.read_text(encoding='utf-8')
    text = text.replace('  <footer className="bottom-bar">',
                        '  {/* inserted */}\n  <footer className="bottom-bar">', 1)
    target.write_text(text, encoding='utf-8')
    after = checker.port_audited_table()['apps/studio/app/page.tsx']
    assert after != before
    (moved,) = list(after)
    assert moved == list(before)[0] + 1
    assert ('127.0.0.1:' in text.split('\n')[moved - 1]
            or 'ATS_PORT' in text.split('\n')[moved - 1])


def test_tc004b_a_moved_port_line_makes_the_stale_citation_fail(tree, capsys):
    """TC-004b: the moved line makes the stale ADR citation FAIL.

    The check is not just "the position moved" -- it is "the gate turns red
    when the ADR and the source disagree". Without this, a derivation that
    moved the position but still accepted the old citation would pass.
    """
    target = tree / 'apps/studio/app/page.tsx'
    text = target.read_text(encoding='utf-8')
    target.write_text(text.replace('  <footer className="bottom-bar">',
                                    '  {/* inserted */}\n  <footer className="bottom-bar">', 1),
                      encoding='utf-8')
    assert checker.main() == 1
    out = capsys.readouterr().out
    assert 'RESULT: MISMATCH' in out
    assert 'apps/studio/app/page.tsx' in out


def test_tc005_a_cited_file_no_checker_covers_fails(tree, capsys):
    """TC-005: a citation that no checker covers is reported."""
    text = read_adr(tree)
    write_adr(tree, text + '\nSome file: `docs/nowhere.mjs:12`.\n')
    assert checker.main() == 1
    out = capsys.readouterr().out
    assert 'RESULT: MISMATCH' in out
    assert 'no checker covers it' in out


def test_tc006_a_range_that_does_not_start_on_the_anchor_fails(tree, capsys):
    """TC-006: a range whose start is not the range anchor is reported."""
    derived = derived_positions()
    (position,) = list(derived['apps/studio/app/page.tsx'])
    text = read_adr(tree)
    write_adr(tree, text.replace(
        '`apps/studio/app/page.tsx:%d`' % position,
        '`apps/studio/app/page.tsx:%d-%d`' % (position, position + 3)))
    assert checker.main() == 1
    out = capsys.readouterr().out
    assert 'RESULT: MISMATCH' in out
    assert 'apps/studio/app/page.tsx' in out


def test_tc007_a_port_audited_position_the_adr_does_not_cite_fails(tree, capsys):
    """TC-007: a port-audited position the ADR does not mention is reported.

    The exemption is per POSITION, so a position the audit validates but the
    ADR does not mention would make the audit's guarantee vacuous.
    """
    derived = derived_positions()
    (position,) = list(derived['src-tauri/src/lib.rs'])
    text = read_adr(tree)
    write_adr(tree, text.replace('`src-tauri/src/lib.rs:%d`' % position,
                                  '`src-tauri/src/lib.rs`'))
    assert checker.main() == 1
    out = capsys.readouterr().out
    assert 'src-tauri/src/lib.rs' in out
    assert 'port-audited but' in out


def test_tc008_the_real_repository_resolves(monkeypatch, capsys):
    """TC-008: the REAL tree and the REAL ADR resolve."""
    monkeypatch.setattr(checker, 'ROOT', ROOT)
    monkeypatch.setattr(checker, 'ADR', ROOT / 'docs' / '16-BASELINE-ADR.md')
    assert checker.main() == 0
    assert 'RESULT: OK' in capsys.readouterr().out


def test_tc009_every_derived_port_position_is_cited_by_the_real_adr():
    """TC-009: every derived position is cited by the real ADR.

    And the four `api.ts` branches derive to FOUR DIFFERENT lines -- the
    needle set is unambiguous, so the derivation cannot collapse them.
    """
    derived = derived_positions()
    text = (ROOT / 'docs' / '16-BASELINE-ADR.md').read_text(encoding='utf-8')
    for rel, table in derived.items():
        cited = set(checker.cited_positions(text, rel))
        for position in table:
            assert position in cited, '%s:%d is not cited by the ADR' % (rel, position)
    api = derived['apps/studio/lib/api.ts']
    assert len(api) == 4
    assert len(set(api)) == 4


def test_tc010_two_needles_on_one_line_are_a_hard_error(tree, monkeypatch):
    """TC-010: an ambiguous needle set is an error, not a silent collapse.

    Two needles that land on the same line would make the derivation
    ambiguous (one position, two descriptions), so the script refuses it
    rather than reporting one of the two.
    """
    monkeypatch.setitem(checker.PORT_AUDITED_NEEDLES, 'apps/studio/app/page.tsx', {
        'LOCAL RUNNER · 127.0.0.1:': 'the workbench footer text',
        'LOCAL RUNNER': 'the workbench footer text again',
    })
    with pytest.raises(ValueError) as excinfo:
        checker.port_audited_table()
    assert 'both land on line' in str(excinfo.value)
