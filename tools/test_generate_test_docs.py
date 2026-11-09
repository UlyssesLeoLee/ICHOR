"""pytest: tools/generate_test_docs.py produces the committed catalog.

Run: python -m pytest -q tools/test_generate_test_docs.py
The generator runs in-process with Path.write_text replaced by a recorder, so
nothing in the repository is written and coverage is attributed to the real
script.
"""
import json
import re
import runpy
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
SCRIPT = TOOLS / 'generate_test_docs.py'
OUTPUTS = {
    'docs/07-UT-TEST-DESIGN.md', 'docs/08-IT-TEST-DESIGN.md', 'docs/09-ST-TEST-DESIGN.md',
    'docs/10-RTM.md', 'tests/test-cases.json', 'tests/rtm.json',
}


def run_generator(monkeypatch):
    recorded = {}

    def record(self, data, encoding=None, errors=None, newline=None):
        recorded[Path(self).resolve().relative_to(ROOT).as_posix()] = data
        return len(data)

    monkeypatch.setattr(Path, 'write_text', record)
    runpy.run_path(str(SCRIPT), run_name='__main__')
    return recorded


@pytest.fixture
def generated(monkeypatch):
    return run_generator(monkeypatch)


def committed(rel):
    return (ROOT / rel).read_bytes().decode('utf-8').replace('\r\n', '\n')


def test_tc001_exactly_the_six_outputs(generated):
    assert set(generated) == OUTPUTS


def test_tc002_committed_files_are_fresh(generated):
    for rel, text in generated.items():
        assert committed(rel) == text.replace('\r\n', '\n'), f'{rel} is stale: run python tools/generate_test_docs.py'


def test_tc003_ids_unique_and_levels(generated):
    cases = json.loads(generated['tests/test-cases.json'])
    ids = [c['id'] for c in cases]
    assert len(ids) == len(set(ids))
    for c in cases:
        if c['id'].startswith('UT-CP-'):
            assert c['level'] == 'UT'
        if c['id'].startswith('IT-CP-'):
            assert c['level'] == 'IT'
        if c['status'] == 'PASS':
            assert 'node --test' in c['evidence'] or c['evidence'].startswith('node'), c['id']


def test_tc004_catalog_matches_test_titles(generated):
    cases = json.loads(generated['tests/test-cases.json'])
    for prefix, test_file in (('UT-CP-', 'tests/control-plane.test.mjs'), ('IT-CP-', 'tests/control-plane-it.test.mjs')):
        catalog = {c['id'] for c in cases if c['id'].startswith(prefix)}
        source = (ROOT / test_file).read_text(encoding='utf-8')
        titles = set(re.findall(r"test\('(%s[A-Z0-9-]+?):" % re.escape(prefix), source))
        assert catalog == titles, (prefix, sorted(catalog ^ titles))
        assert len(catalog) > 0


def test_tc005_fr028_stays_designed(generated):
    rtm = {r['requirement']: r for r in json.loads(generated['tests/rtm.json'])}
    row = rtm['FR-028']
    assert row['status'] == 'DESIGNED'
    assert 'UT-CP-001' in row['tests'] and 'IT-CP-006' in row['tests']


def test_tc006_two_runs_are_identical(monkeypatch):
    assert run_generator(monkeypatch) == run_generator(monkeypatch)


def test_tc007_ats207_catalog_matches_test_titles(generated):
    """The ATS-207 rows name exactly the tests that exist, and all are executed."""
    cases = json.loads(generated['tests/test-cases.json'])
    groups = ((('UT-LOCK-', 'UT-DATA-', 'UT-WAL-'), 'tests/instance-lock.test.mjs'),
              (('IT-LOCK-', 'IT-DATA-', 'IT-WAL-'), 'tests/instance-lock-it.test.mjs'))
    for prefixes, test_file in groups:
        catalog = {c['id'] for c in cases if c['id'].startswith(prefixes)}
        source = (ROOT / test_file).read_text(encoding='utf-8')
        pattern = r"test\('((?:%s)[0-9]+):" % '|'.join(map(re.escape, prefixes))
        titles = set(re.findall(pattern, source))
        assert catalog == titles, (test_file, sorted(catalog ^ titles))
        assert all(c['status'] == 'PASS' for c in cases if c['id'] in catalog)
    st = [c for c in cases if c['id'] in ('ST-017', 'ST-025', 'ST-026')]
    assert len(st) == 3
    assert all(c['status'] == 'PASS' and 'st-ats207.mjs' in c['evidence'] for c in st)
