#!/usr/bin/env bash
# ATS-501 regression: the WBS updaters must not fight over the workbook.
#
# 1. Re-running the ATS-101 updater must NOT walk an accepted row back from
#    已完成 to 待审核 -- the review is a one-way door.
# 2. Running the updaters in either order must yield the SAME sheet.
# 3. Each updater must be idempotent: running it twice must not change the
#    result.
# 4. The derived 总览 totals must equal the sheet they are derived from.
# 5. Every task's marked note must survive a run of the other updaters.
#
# Usage: bash tools/ats501-probes/check-wbs-updaters.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

TMP="${TMPDIR:-/tmp}/ats501-wbs-check"
rm -rf "$TMP"
mkdir -p "$TMP"
# The helper is a native Windows Python: an MSYS path like /tmp/... is not
# resolvable by it. cygpath translates the directory into a native path, and
# the translation is what the helper receives.
TMP_NATIVE="$(cygpath -w "$TMP" 2>/dev/null || echo "$TMP")"

XLSX="docs/WBS.xlsx"
BASE="$TMP/WBS.base.xlsx"

fail=0
ok()   { printf '  PASS  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }
note() { printf '%s\n' "$*"; }

# The baseline is the committed state of the branch, so the check runs against
# the tree this branch is built on.
git show "HEAD:$XLSX" > "$BASE"

dump() { python - "$1" <<'PY'
import sys
sys.path.insert(0, 'tools')
from wbs_common import read_parts, sheet_cells
parts = read_parts(sys.argv[1])
for sheet in ('xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'):
    rows = sheet_cells(parts, sheet)
    for rid in sorted(rows):
        cells = rows[rid]
        for col in sorted(cells):
            print(sheet, rid, col, repr(cells[col]))
PY
}

restore() { cp "$BASE" "$XLSX"; }

note '=== ATS-501 regression: WBS updater interaction ==='
note "repo root : $ROOT"
note ''

# --- 1. an accepted row is not downgraded ----------------------------------
# The expectation is derived from the BASELINE workbook: if the ATS-101 row
# already carries a terminal status there, the updater must leave it alone.
# On a branch where the row is still 待审核, there is nothing to protect.
note '--- 1. an accepted row stays accepted ---'
BASE_STATUS=$(python - "$TMP_NATIVE/WBS.base.xlsx" <<'PY'
import sys
sys.path.insert(0, 'tools')
from wbs_common import read_parts, sheet_cells
parts = read_parts(sys.argv[1])
s2 = sheet_cells(parts, 'xl/worksheets/sheet2.xml')
for rid, cells in s2.items():
    if cells.get('A') == 'ATS-101':
        print(cells.get('N', ''))
        break
PY
)
restore
python tools/update_wbs_ats101.py > /dev/null || bad 'ATS-101 updater exited non-zero'
STATUS=$(python - <<'PY'
import sys
sys.path.insert(0, 'tools')
from wbs_common import read_parts, sheet_cells
parts = read_parts()
s2 = sheet_cells(parts, 'xl/worksheets/sheet2.xml')
for rid, cells in s2.items():
    if cells.get('A') == 'ATS-101':
        print(cells.get('N', ''))
        break
PY
)
if [ "$STATUS" = "$BASE_STATUS" ]; then
  ok "the ATS-101 row still reads '$STATUS' after a re-run (baseline: '$BASE_STATUS')"
else
  bad "the ATS-101 row changed from '$BASE_STATUS' to '$STATUS' -- an accepted review must not be undone"
fi

# --- 2. either order yields the same sheet ---------------------------------
note ''
note '--- 2. both updaters, in either order ---'
restore
python tools/update_wbs_ats101.py > /dev/null
python tools/update_wbs_ats501.py > /dev/null
dump "$XLSX" > "$TMP/orderA.txt"

restore
python tools/update_wbs_ats501.py > /dev/null
python tools/update_wbs_ats101.py > /dev/null
dump "$XLSX" > "$TMP/orderB.txt"

if diff -u "$TMP/orderA.txt" "$TMP/orderB.txt" > "$TMP/diffAB.txt"; then
  ok 'ATS-101 -> ATS-501 and ATS-501 -> ATS-101 produce the same sheet'
else
  bad 'the two orders disagree:'
  sed -n '1,40p' "$TMP/diffAB.txt"
fi

# --- 3. each updater is idempotent -----------------------------------------
note ''
note '--- 3. idempotency ---'
restore
python tools/update_wbs_ats101.py > /dev/null
python tools/update_wbs_ats501.py > /dev/null
dump "$XLSX" > "$TMP/once.txt"
python tools/update_wbs_ats101.py > /dev/null
python tools/update_wbs_ats501.py > /dev/null
dump "$XLSX" > "$TMP/twice.txt"
if diff -u "$TMP/once.txt" "$TMP/twice.txt" > "$TMP/diffII.txt"; then
  ok 'running both updaters twice changes nothing'
else
  bad 'the updaters are not idempotent:'
  sed -n '1,40p' "$TMP/diffII.txt"
fi

# --- 4. the derived totals match the sheet ---------------------------------
note ''
note '--- 4. the derived 总览 totals match the sheet ---'
python - <<'PY'
import sys
sys.path.insert(0, 'tools')
from wbs_common import read_parts, sheet_cells, totals

parts = read_parts()
t = totals(parts)
s1 = sheet_cells(parts, 'xl/worksheets/sheet1.xml')
cached_completed = s1[8]['B']
cached_rate = s1[9]['B']
cached_remaining = s1[10]['B']

problems = []
if str(t['completed']) != cached_completed:
    problems.append(f'B8: sheet says {cached_completed}, derived {t["completed"]}')
if '%.15f' % t['completion_rate'] != cached_rate:
    problems.append(f'B9: sheet says {cached_rate}, derived {t["completion_rate"]}')
if str(int(t['sum_remaining'])) != cached_remaining:
    problems.append(f'B10: sheet says {cached_remaining}, derived {t["sum_remaining"]}')

print(f'  derived: completed={t["completed"]} '
      f'rate={t["completion_rate"]:.15f} remaining={t["sum_remaining"]:.0f}')
print(f'  cached : completed={cached_completed} '
      f'rate={cached_rate} remaining={cached_remaining}')
if problems:
    for p in problems:
        print('  FAIL  ' + p)
    sys.exit(1)
print('  PASS  the cached 总览 values equal the values derived from 开发WBS')
PY
if [ $? -ne 0 ]; then fail=1; fi

# --- 5. every task's marked note survives ----------------------------------
note ''
note '--- 5. the marked notes of every task survive ---'
restore
python tools/update_wbs_ats101.py > /dev/null
python tools/update_wbs_ats501.py > /dev/null
python - "$TMP_NATIVE/WBS.base.xlsx" <<'PY'
import sys
sys.path.insert(0, 'tools')
from wbs_common import read_parts, sheet_cells

MARKERS = ('【ATS-101】', '【ATS-401】', '【ATS-501】')


def marker_counts(parts):
    s2 = sheet_cells(parts, 'xl/worksheets/sheet2.xml')
    counts = {}
    for rid, cells in s2.items():
        text = cells.get('T') or ''
        for marker in MARKERS:
            if marker in text:
                counts[marker] = counts.get(marker, 0) + 1
    return counts


now = marker_counts(read_parts())
base = marker_counts(read_parts(sys.argv[1]))
print('  baseline markers: %s' % base)
print('  current markers : %s' % now)
# Every marker the BASELINE workbook carries must still be there. A marker
# that only exists on some other branch is not expected here.
missing = [m for m in MARKERS if base.get(m, 0) and not now.get(m, 0)]
if missing:
    print('  FAIL  these markers were lost: %s' % ', '.join(missing))
    sys.exit(1)
print('  PASS  every marked note of the baseline is still in the sheet')
PY
if [ $? -ne 0 ]; then fail=1; fi

restore
note ''
if [ "$fail" -eq 0 ]; then
  note 'RESULT: OK -- the WBS updaters coexist, are idempotent, do not undo an'
  note '        accepted review, and the 总览 cache always matches 开发WBS.'
  exit 0
fi
note 'RESULT: MISMATCH -- the WBS updaters do not coexist.'
exit 1
