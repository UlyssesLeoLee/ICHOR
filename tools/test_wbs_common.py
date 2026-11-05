"""Regression test for the WBS marked-cell merge helper.

Covers the two defects that made the shared cell writer non-idempotent:

  1. The caller passes text that ALREADY starts with its own marker. The
     merge wrote `marker + new_text`, so the cell ended up with a doubled
     prefix (【ATS-401】【ATS-401】...) and a second run changed it again.
  2. A marker that is not listed in `MARKERS` is invisible to the merge:
     the writer cannot find its own previous block, so it appends a second
     one instead of replacing it.

Run: python tools/test_wbs_common.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from wbs_common import MARKERS, merge_marked

FAILURES = []


def check(name, actual, expected):
    if actual == expected:
        print(f'PASS {name}')
    else:
        print(f'FAIL {name}')
        print(f'  expected: {expected!r}')
        print(f'  actual:   {actual!r}')
        FAILURES.append(name)


def test_marker_in_note_is_not_doubled():
    """The note text may or may not carry its own marker; both must yield one."""
    marker = '【ATS-401】'
    with_marker = merge_marked('', marker, marker + 'Agent 契约 v1')
    without_marker = merge_marked('', marker, 'Agent 契约 v1')
    check('ATS-401 note carrying its own marker is not doubled',
          with_marker, marker + 'Agent 契约 v1')
    check('ATS-401 note without the marker yields the same cell',
          without_marker, marker + 'Agent 契约 v1')


def test_second_run_is_a_no_op():
    """Writing the same block twice must leave the cell unchanged."""
    marker = '【ATS-301】'
    once = merge_marked('阶段内按验收门槛控制', marker, '契约 v1')
    twice = merge_marked(once, marker, '契约 v1')
    check('a second merge of the same block is a no-op', twice, once)
    check('the merged cell carries the marker exactly once',
          twice.count(marker), 1)


def test_foreign_blocks_survive():
    """A cell shared with another task keeps that task's block."""
    marker = '【ATS-301】'
    other = '【ATS-401】'
    merged = merge_marked(f'{other}Agent 契约 v1', marker, '契约 v1')
    check('the foreign marker survives', merged.count(other), 1)
    check('the own marker is present', merged.count(marker), 1)


def test_known_markers_are_detected():
    """Every marker the shared helper owns must be recognised by the merge."""
    for marker in MARKERS:
        once = merge_marked('基线', marker, 'x')
        twice = merge_marked(once, marker, 'x')
        if twice != once:
            check(f'{marker} is idempotent', twice, once)
        else:
            print(f'PASS {marker} is idempotent')


if __name__ == '__main__':
    test_marker_in_note_is_not_doubled()
    test_second_run_is_a_no_op()
    test_foreign_blocks_survive()
    test_known_markers_are_detected()
    if FAILURES:
        print(f'\n{len(FAILURES)} FAILED: {FAILURES}')
        sys.exit(1)
    print('\nall checks passed')
