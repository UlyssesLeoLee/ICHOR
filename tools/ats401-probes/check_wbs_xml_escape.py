"""Prove the WBS updater's XML escaping is load-bearing.

The review's instruction: "先修它的 XML 转义，否则会把 `<24hex>` 这类文本
裸写进 sheet2.xml，文件直接损坏".

This writes a note that contains '<', '>' and '&' into the ATS-401 T cell
and checks that
  (a) the stored sheet2.xml has NO raw '<' or '&' inside a text node,
  (b) the workbook is still a readable zip and every member still parses
      as XML,
  (c) reading the cell back yields the original text.
"""
import io
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools'))

from wbs_common import read_parts, sheet_cells  # noqa: E402

scratch = Path(tempfile.mkdtemp(prefix='ats401-wbs-escape-'))
(scratch / 'tools').mkdir()
(scratch / 'docs').mkdir()
for f in ('update_wbs_ats401.py', 'wbs_common.py'):
    shutil.copy2(REPO / 'tools' / f, scratch / 'tools' / f)
shutil.copy2(REPO / 'docs' / 'WBS.xlsx', scratch / 'docs' / 'WBS.xlsx')

# Patch the note so it contains the characters that used to corrupt the file.
updater = scratch / 'tools' / 'update_wbs_ats401.py'
text = io.open(updater, encoding='utf-8', newline='').read()
needle = "'npm test 共"
assert needle in text
probe = "'注入转义探针 <24hex> & 引号；'"
text = text.replace(needle, probe + needle, 1)
io.open(updater, 'w', encoding='utf-8', newline='').write(text)

r = subprocess.run([sys.executable, str(updater)], cwd=scratch, capture_output=True, text=True)
assert r.returncode == 0, r.stderr
print('updater exit 0')

xlsx = scratch / 'docs' / 'WBS.xlsx'
with zipfile.ZipFile(xlsx) as z:
    assert z.testzip() is None, 'the zip is corrupt'
    members = {n: z.read(n) for n in z.namelist()}

failures = []

# (b) every XML member still parses.
for name, data in members.items():
    if name.endswith('.xml') or name.endswith('.rels'):
        try:
            ElementTree.fromstring(data)
        except ElementTree.ParseError as e:
            failures.append(f'{name} does not parse: {e}')

sheet2 = members['xl/worksheets/sheet2.xml'].decode('utf-8')

# (a) no raw '<' or '&' inside a text node.
for m in re.finditer(r'<x:v>(.*?)</x:v>', sheet2, re.S):
    text_value = m.group(1)
    if '<' in text_value:
        failures.append(f'raw < in a text node: {text_value[:80]}')
    # An '&' is only legal when it starts an entity.
    for _amp in re.finditer(
        r'&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)', text_value
    ):
        failures.append(f'raw & in a text node: {text_value[:80]}')

# (c) reading the cell back yields the original text.
parts = {n: d.decode('utf-8') for n, d in members.items()}
rows = sheet_cells(parts, 'xl/worksheets/sheet2.xml')
rid = None
for r_id, cells in rows.items():
    if cells.get('A') == 'ATS-401':
        rid = r_id
        break
assert rid is not None, 'the ATS-401 row is gone'
note = rows[rid].get('T', '')
if '注入转义探针 <24hex> & 引号；' not in note:
    failures.append(f'the note did not round-trip: {note[:160]!r}')

if failures:
    print('FAIL')
    for f in failures:
        print('  -', f)
    raise SystemExit(1)
print('PASS: the workbook survives a note containing <, >, & and round-trips it')
