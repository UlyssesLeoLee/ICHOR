#!/usr/bin/env python3
"""ATS-203: the MUTANTS of the indexing regression dataset.

Each mutant breaks ONE behaviour of the index. The regression dataset has to
FAIL on every one of them: a dataset that passes under a broken index proves
nothing. That is the check the first two review rounds of ATS-203 asked for.

THE MUTANTS
-----------
M1  ambiguity-off
    The case keeps its provisional UID but stops saying WHY it is
    undecidable: `ambiguity` is no longer attached to it. A dataset that
    only checks `uidStable === false` would not notice.

M2  template-titles-dropped
    The static scan drops the cases whose title carries an interpolation.
    The dynamic case disappears from the index entirely.

M3  index-returns-nothing
    The static scan returns no case at all.

M4  template-claimed-stable
    THE ORIGINAL DEFECT (ATS-203, review round 1). The template title is
    treated as an ordinary literal title: it gets a DERIVED, STABLE uid
    (`uidStable: true`, `uidSource: 'derived'`) and no ambiguity at all.
    A stable uid that points at a title no case will ever report -- this is
    the counterexample the whole task exists for, so the dataset MUST catch
    it.

USAGE
-----
    python tools/ats203-probes/mutants.py <tree-dir> <mutant-name>

The script patches the tree in place and exits non-zero when its anchor is
not found -- a mutant that did not apply proves nothing, so it must not be
silently ignored.
"""
import sys
from pathlib import Path

UID = 'server/uid.mjs'


def _read(root: Path) -> str:
    return (root / UID).read_text(encoding='utf-8')


def _write(root: Path, text: str) -> None:
    (root / UID).write_text(text, encoding='utf-8')


def _patch(root: Path, old: str, new: str) -> None:
    text = _read(root)
    if old not in text:
        raise SystemExit(f'anchor not found in {UID}: {old!r}')
    if text.count(old) != 1:
        raise SystemExit(f'the anchor is not unique in {UID}: {old!r}')
    _write(root, text.replace(old, new))


def m1_ambiguity_off(root: Path) -> None:
    """The ambiguity is no longer attached to the undecidable case."""
    _patch(
        root,
        '      c.uidStable = false;\n      c.ambiguity = {',
        '      c.uidStable = false;\n      c._ambiguityHidden = {',
    )


def m2_template_titles_dropped(root: Path) -> None:
    """The static scan drops the cases whose title carries an interpolation."""
    _patch(
        root,
        '    cases.push({\n      title: call.title,',
        '    if (!String(call.title).includes("$" + "{")) cases.push({\n      title: call.title,',
    )


def m3_index_returns_nothing(root: Path) -> None:
    """The static scan returns no case at all."""
    _patch(
        root,
        'export function scanTestCases(content) {',
        'export function scanTestCases(content) {\n  return [];',
    )


def m4_template_claimed_stable(root: Path) -> None:
    """The template title is treated as an ordinary literal title again.

    This is the defect the task was created for: the case that really runs
    carries a RENDERED title, so a derived stable uid points at a case that
    does not exist.
    """
    _patch(
        root,
        '    if (it.placeholder) {',
        '    if (false) {',
    )
    _patch(
        root,
        '      : placeholder\n            ? \'dynamic-template-title\'\n',
        '      : false\n            ? \'dynamic-template-title\'\n',
    )


MUTANTS = {
    'M1-ambiguity-off': m1_ambiguity_off,
    'M2-template-titles-dropped': m2_template_titles_dropped,
    'M3-index-returns-nothing': m3_index_returns_nothing,
    'M4-template-claimed-stable': m4_template_claimed_stable,
}


def main(argv):
    if len(argv) != 3:
        raise SystemExit(f'usage: {argv[0]} <tree-dir> <mutant-name>')
    root = Path(argv[1])
    name = argv[2]
    if name not in MUTANTS:
        raise SystemExit(f'unknown mutant: {name} (known: {", ".join(MUTANTS)})')
    MUTANTS[name](root)
    print(f'applied {name}')


if __name__ == '__main__':
    main(sys.argv)
