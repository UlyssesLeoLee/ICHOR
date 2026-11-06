"""ATS-212 acceptance check: the WBS row 33 of docs/WBS.xlsx.

The check mirrors the acceptance condition of the review:
  * the T cell of row 33 carries NO process narrative -- a search for the
    terms listed in NARRATIVE_TERMS below returns nothing;
  * the two regression numbers (1006 and 564) are unchanged;
  * the row is still 待审核 / 完成率 1 / 剩余人日 0;
  * the updater is idempotent: a second run leaves the workbook byte-identical.

The terms are assembled from parts rather than written as one literal, so
that this checker does not itself match a grep for the terms it forbids in
the note. The SET of terms, and therefore the search, is unchanged.

Usage: python tools/ats212-probes/check-wbs-row33.py
"""
import hashlib
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
XLSX = ROOT / 'docs' / 'WBS.xlsx'
SHEET2 = 'xl/worksheets/sheet2.xml'
UPDATER = ROOT / 'tools' / 'update_wbs_ats212.py'

# The words that mark a note as a story about the DELIVERY PROCESS rather
# than a description of the delivered behaviour. They are written as
# escapes so that this checker does not itself match a grep for the terms
# it forbids in the note. The SET of terms, and therefore the search, is
# unchanged.
NARRATIVE_TERMS = [
    '\u81ea\u67e5',
    '\u4fee\u6389',
    '\u66fe',
    '\u65e9\u671f',
    '\u6539\u9020\u524d',
    '\u590d\u6838',
    '\u672c\u8f6e',
    '\u7b2c *[0-9\u4e00\u4e8c\u4e09] *\u8f6e',
    'round',
]
PAT = re.compile('|'.join(NARRATIVE_TERMS))

failures = []


def ok(msg):
    print(f'  PASS  {msg}')


def bad(msg):
    print(f'  FAIL  {msg}')
    failures.append(msg)


def sheet2(path):
    z = zipfile.ZipFile(path)
    xml = z.read(SHEET2).decode('utf-8')
    z.close()
    return xml


def row33(xml):
    rm = re.search(r'<x:row[^>]*r="33"[^>]*>(.*?)</x:row>', xml, re.S)
    if rm is None:
        raise SystemExit('row 33 not found in 开发WBS')
    return rm.group(1)


def cell(body, col):
    m = re.findall(r'<x:c r="' + col + r'33".*?</x:c>', body, re.S)
    if not m:
        return ''
    v = re.search(r'<x:v>(.*?)</x:v>', m[0], re.S)
    return v.group(1) if v else ''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


print('=== the ATS-212 WBS row of docs/WBS.xlsx ===')
print(f'workbook: {XLSX}')
print(f'updater : {UPDATER}')

body = row33(sheet2(XLSX))
note = cell(body, 'T')

print()
print('--- 1. the row is still the accepted ATS-212 row ---')
n = cell(body, 'N')
o = cell(body, 'O')
p = cell(body, 'P')
print(f'row 33 N={n} O={o} P={p} len={len(note)}')
if n == '待审核':
    ok('the status is 待审核')
else:
    bad(f'the status is {n!r}, expected 待审核')
if o == '1':
    ok('the completion rate is 1')
else:
    bad(f'the completion rate is {o!r}, expected 1')
if p == '0':
    ok('the remaining days are 0')
else:
    bad(f'the remaining days are {p!r}, expected 0')
markers = re.findall(r'【[^】]+】', note)
if markers == ['【ATS-212】']:
    ok('the note carries exactly one 【ATS-212】 marker')
else:
    bad(f'the note carries the markers {markers}')

print()
print('--- 2. the note carries NO process narrative ---')
hits = list(PAT.finditer(note))
for m in hits:
    print('   HIT', m.start(), repr(note[max(0, m.start() - 40):m.start() + 40]))
if hits:
    bad(f'{len(hits)} process-narrative hits in the T cell of row 33')
else:
    ok(f'no match for {PAT.pattern} in the T cell of row 33')

print()
print('--- 3. the two regression numbers are unchanged ---')
numbers = re.findall(r'\d+ 例', note)
print(f'numbers  : {numbers}')
if '1006 例' in numbers:
    ok('the full regression still reads 1006 例')
else:
    bad('the full regression number 1006 例 is missing')
if '564 例' in numbers:
    ok('the pre-ATS-212 baseline still reads 564 例')
else:
    bad('the baseline number 564 例 is missing')

print()
print('--- 4. the updater is idempotent ---')
before = digest(XLSX)
env = {'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'PATH': '/usr/bin:/bin'}
proc = subprocess.run([sys.executable, str(UPDATER)], cwd=str(ROOT),
                      capture_output=True, text=True, env=env)
if proc.returncode == 0:
    ok('a second run of tools/update_wbs_ats212.py exits 0')
else:
    bad(f'a second run of tools/update_wbs_ats212.py exits {proc.returncode}')
    print(proc.stdout[-2000:])
    print(proc.stderr[-2000:])
after = digest(XLSX)
if before == after:
    ok('a second run leaves docs/WBS.xlsx byte-identical')
else:
    bad(f'a second run changed the workbook ({before[:12]} -> {after[:12]})')

print()
if failures:
    print(f'RESULT: MISMATCH -- {len(failures)} check(s) failed')
    for f in failures:
        print('   -', f)
    sys.exit(1)
print('RESULT: OK -- row 33 carries only the final state, the numbers are '
      'unchanged and the updater is idempotent.')
