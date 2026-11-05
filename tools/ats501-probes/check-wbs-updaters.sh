#!/usr/bin/env bash
# ATS-501 regression: the WBS updaters must not fight over the workbook.
#
# The workbook is shared by EVERY updater under tools/update_wbs_*.py --
# ATS-101, ATS-101 (post-review), ATS-102, ATS-301, ATS-401 and ATS-501 --
# and every one of them writes into the same 总览 narrative cells D6/D7. The
# regression therefore checks:
#
# 1. an accepted row is not downgraded -- with a SEEDED 已完成 row, so the
#    check can never pass by having nothing to protect;
# 2. running the updaters in either order yields the SAME sheet;
# 3. each updater is idempotent: running it twice changes nothing;
# 4. the derived 总览 totals equal the sheet they are derived from;
# 5. every task's marked note survives a run of the other updaters;
# 6. no updater erases another task's text in the shared D6/D7 cells.
#
# The updater list is DISCOVERED from tools/update_wbs_*.py, so a script added
# later (e.g. update_wbs_ats301.py) is covered without touching this file.
# A hardcoded list silently stops guarding the moment a new updater lands.
#
# ENCODING: every Python invocation below prints Chinese text (状态 values,
# 总览 narrative cells, markers). On a default Windows console the Python
# stdout encoding is the ANSI code page (gbk / cp936 / cp1252), so the bytes
# the shell compares against its UTF-8 literals do not match and the whole
# regression fails on a clean machine. UTF-8 is therefore forced at the entry
# of this script; the effective Python version and stdout encoding are
# printed so the evidence log records the environment the PASS was produced
# in. The same forcing lives in collect-evidence.sh.
#
# Usage: bash tools/ats501-probes/check-wbs-updaters.sh
set -u

# --- force UTF-8 for every Python invocation in this script ---------------
# PYTHONUTF8 makes the interpreter use UTF-8 for stdout/stderr and for the
# filesystem encoding; PYTHONIOENCODING pins the standard streams for
# interpreters that predate PYTHONUTF8 (3.7+). Both are set BEFORE the first
# python call, so the script behaves the same on a bare Windows box, in CI
# and inside the Hermes runtime (which happens to set them already).
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

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

# Every updater that may write into the shared workbook, DISCOVERED.
# The list is sorted (LC_ALL=C, so the order does not depend on the
# machine's locale) and it is the ONLY list: a new tools/update_wbs_*.py is
# picked up automatically.
UPDATERS=()
while IFS= read -r u; do
  [ -n "$u" ] && UPDATERS+=("$u")
done < <(LC_ALL=C ls -1 tools/update_wbs_*.py 2>/dev/null | LC_ALL=C sort)

if [ "${#UPDATERS[@]}" -eq 0 ]; then
  printf 'FATAL: no tools/update_wbs_*.py found -- the guard would be vacuous\n'
  exit 1
fi

fail=0
ok()   { printf '  PASS  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }
note() { printf '%s\n' "$*"; }

# --- the Python environment this run actually used ------------------------
PY_VERSION="$(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
PY_STDOUT_ENCODING="$(python -c 'import sys; print(sys.stdout.encoding)' 2>&1)"
# The encoding the SAME interpreter would use without the forcing above.
# It is recorded because it is the reason the forcing exists: on a default
# Windows console it is the ANSI code page, not UTF-8.
PY_DEFAULT_ENCODING="$(env -u PYTHONUTF8 -u PYTHONIOENCODING \
  python -c 'import sys; print(sys.stdout.encoding)' 2>&1)"

# BASE is the COMMITTED state of the branch: it is the reference the
# marked-note check compares against.
git show "HEAD:$XLSX" > "$BASE"

# Every Python fragment below reconfigures its own stdout as well, so the
# script stays correct even when it is called with the environment stripped
# (the export above is the belt, the reconfigure is the braces).
# The dump is the SHEET, value by value. A numeric cell is normalised to
# its float value before it is printed: the updaters do not agree on how to
# SPELL a number (wbs_common.format_rate writes '%.15f', some updaters write
# repr() of the same float), and that spelling difference is not a
# difference of the sheet. Without the normalisation a mere re-ordering of
# the updaters would look like a disagreement -- and the next updater added
# to tools/ would trip the guard over a cosmetic detail.
dump() { python - "$1" <<'PY'
import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, 'tools')
from wbs_common import read_parts, sheet_cells


def normalise(value):
    """Return the float value of a numeric cell, or the text unchanged."""
    if value is None:
        return ''
    text = value.strip()
    if not text:
        return ''
    try:
        return repr(float(text))
    except ValueError:
        return repr(value)


parts = read_parts(sys.argv[1])
for sheet in ('xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'):
    rows = sheet_cells(parts, sheet)
    for rid in sorted(rows):
        cells = rows[rid]
        for col in sorted(cells):
            print(sheet, rid, col, normalise(cells[col]))
PY
}

# `restore` puts the workbook back the way it was when the script started.
# The baseline is the COMMITTED state, so an uncommitted edit to the workbook
# would be lost by the final restore -- which once silently discarded the
# ATS-501 row update. The baseline is therefore snapshotted from the
# working tree, not from HEAD, so the script is non-destructive.
SNAPSHOT="$TMP/WBS.snapshot.xlsx"
cp "$XLSX" "$SNAPSHOT"
restore() { cp "$SNAPSHOT" "$XLSX"; }

# Seed a row as 已完成 so the "an accepted row stays accepted" check has
# something real to protect. Without the seed the check would pass by
# comparing 待审核 with 待审核 -- a vacuous pass.
seed_done() {
  python - "$XLSX" <<'PY'
import os
import re
import shutil
import sys
import zipfile

sys.stdout.reconfigure(encoding='utf-8')
target = sys.argv[1]
zin = zipfile.ZipFile(target)
parts = {n: zin.read(n) for n in zin.namelist()}
infos = {i.filename: i for i in zin.infolist()}
zin.close()

xml = parts['xl/worksheets/sheet2.xml'].decode('utf-8')
for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
    if '<x:v>ATS-502</x:v>' in rm.group(2):
        rid = rm.group(1)
        row = rm.group(0)
        m = re.search(r'(<x:c r="N%s"[^>]*>)(.*?)(</x:c>)' % rid, row, re.S)
        cell = '<x:c r="N%s" t="str"><x:v>已完成</x:v></x:c>' % rid
        row = row[:m.start()] + cell + row[m.end():]
        xml = xml[:rm.start()] + row + xml[rm.end():]
        break
else:
    raise SystemExit('ATS-502 row not found')

parts['xl/worksheets/sheet2.xml'] = xml.encode('utf-8')
tmp = target + '.seed.tmp'
with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
    for name, data in parts.items():
        info = infos[name]
        zi = zipfile.ZipInfo(name, date_time=info.date_time)
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = info.external_attr
        zout.writestr(zi, data)
shutil.copy2(tmp, target)
os.unlink(tmp)
PY
}

status_of() { python - "$1" "$2" <<'PY'
import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, 'tools')
from wbs_common import read_parts, sheet_cells
parts = read_parts(sys.argv[1])
s2 = sheet_cells(parts, 'xl/worksheets/sheet2.xml')
for rid, cells in s2.items():
    if cells.get('A') == sys.argv[2]:
        print(cells.get('N', ''))
        break
PY
}

run_all() { for u in "${UPDATERS[@]}"; do python "$u" > /dev/null || return 1; done; }

note '=== ATS-501 regression: WBS updater interaction ==='
note "repo root : $ROOT"
note "updaters  : ${UPDATERS[*]}"
note "updater # : ${#UPDATERS[@]} (discovered from tools/update_wbs_*.py)"
note "python    : $PY_VERSION"
note "stdout enc: $PY_STDOUT_ENCODING (forced: PYTHONUTF8=$PYTHONUTF8 PYTHONIOENCODING=$PYTHONIOENCODING)"
note "default enc: $PY_DEFAULT_ENCODING (what the same interpreter would use without the forcing)"
note ''

# --- 1. an accepted row is not downgraded ----------------------------------
note '--- 1. a seeded 已完成 row stays 已完成 ---'
restore
seed_done
SEEDED=$(status_of "$XLSX" ATS-502)
if [ "$SEEDED" != "已完成" ]; then
  bad "the seed did not take: ATS-502 reads '$SEEDED' instead of 已完成"
else
  ok "the seed took: ATS-502 reads 已完成"
fi
# Every updater that touches a status must leave the seeded row alone.
for u in "${UPDATERS[@]}"; do
  restore
  seed_done
  python "$u" > /dev/null 2>&1
  AFTER=$(status_of "$XLSX" ATS-502)
  if [ "$AFTER" = "已完成" ]; then
    ok "$u leaves the accepted ATS-502 row at 已完成"
  else
    bad "$u walked the accepted ATS-502 row back from 已完成 to '$AFTER'"
  fi
done

# --- 2. either order yields the same sheet ---------------------------------
note ''
note '--- 2. the updaters, in either order ---'
restore
run_all || bad 'an updater exited non-zero in order A'
dump "$XLSX" > "$TMP/orderA.txt"

restore
for ((i=${#UPDATERS[@]}-1; i>=0; i--)); do
  python "${UPDATERS[$i]}" > /dev/null || bad "an updater exited non-zero in order B"
done
dump "$XLSX" > "$TMP/orderB.txt"

if diff -u "$TMP/orderA.txt" "$TMP/orderB.txt" > "$TMP/diffAB.txt"; then
  ok "the ${#UPDATERS[@]} updaters produce the same sheet in either order"
else
  bad 'the two orders disagree:'
  sed -n '1,40p' "$TMP/diffAB.txt"
fi

# --- 3. each updater is idempotent -----------------------------------------
note ''
note '--- 3. idempotency ---'
restore
run_all || bad 'an updater exited non-zero on the first pass'
dump "$XLSX" > "$TMP/once.txt"
run_all || bad 'an updater exited non-zero on the second pass'
dump "$XLSX" > "$TMP/twice.txt"
if diff -u "$TMP/once.txt" "$TMP/twice.txt" > "$TMP/diffII.txt"; then
  ok "running the ${#UPDATERS[@]} updaters twice changes nothing"
else
  bad 'the updaters are not idempotent:'
  sed -n '1,40p' "$TMP/diffII.txt"
fi

# --- 4. the derived totals match the sheet ---------------------------------
note ''
note '--- 4. the derived 总览 totals match the sheet ---'
python - <<'PY'
import sys
sys.stdout.reconfigure(encoding='utf-8')
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

# The cached B9 is a NUMBER; the workbook renders it with 15 decimal places
# ('%.15f'), while some updaters write the repr() of the same float. Both
# spellings describe the same value, so the comparison is numeric with a
# tolerance of half a unit in the 15th decimal place -- a STALE cache (a
# different sheet) differs by far more than that. The raw text is printed
# as well, so a change of spelling stays visible.
TOL = 0.5 * 10 ** -15
try:
    rate_delta = abs(float(cached_rate) - t['completion_rate'])
except ValueError:
    rate_delta = float('inf')
if rate_delta > TOL:
    problems.append(f'B9: sheet says {cached_rate}, derived {t["completion_rate"]}')

if str(int(t['sum_remaining'])) != cached_remaining:
    problems.append(f'B10: sheet says {cached_remaining}, derived {t["sum_remaining"]}')

print(f'  derived: completed={t["completed"]} '
      f'rate={t["completion_rate"]:.15f} remaining={t["sum_remaining"]:.0f}')
print(f'  cached : completed={cached_completed} '
      f'rate={cached_rate} (delta {rate_delta:.3e}, tolerance {TOL:.1e}) '
      f'remaining={cached_remaining}')
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
run_all || bad 'an updater exited non-zero'
python - "$TMP_NATIVE/WBS.base.xlsx" <<'PY'
import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, 'tools')
from wbs_common import MARKERS, read_parts, sheet_cells


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

# --- 6. no updater erases another task's narrative -------------------------
note ''
note "--- 6. the shared D6/D7 cells keep every task's text ---"

restore
run_all || bad 'an updater exited non-zero'
python - "$TMP_NATIVE/WBS.base.xlsx" <<'PY'
import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, 'tools')
from wbs_common import NARRATIVE_FRAGMENTS, read_parts, sheet_cells

# Each task's own contribution to the shared narrative cells. The fragments
# are taken from the SHARED source of truth (wbs_common.NARRATIVE_FRAGMENTS)
# instead of being listed here, so a task that contributes a fragment is
# covered as soon as it registers one -- no edit to this probe needed.
FRAGMENTS = {'D6': [], 'D7': []}
for marker, cells in NARRATIVE_FRAGMENTS.items():
    for cell_name in ('D6', 'D7'):
        fragment = cells.get(cell_name)
        if fragment:
            FRAGMENTS[cell_name].append(fragment)

s1 = sheet_cells(read_parts(), 'xl/worksheets/sheet1.xml')
problems = []
for column, fragments in FRAGMENTS.items():
    row = 6 if column == 'D6' else 7
    text = s1[row]['D']
    for fragment in fragments:
        if fragment not in text:
            problems.append(f'{column} lost: {fragment}')
    print(f'  {column}: {text}')
if problems:
    for p in problems:
        print('  FAIL  ' + p)
    sys.exit(1)
print('  PASS  D6 and D7 still carry every task\'s contribution')
PY
if [ $? -ne 0 ]; then fail=1; fi

restore
note ''
if [ "$fail" -eq 0 ]; then
  note "RESULT: OK -- the ${#UPDATERS[@]} WBS updaters coexist, are idempotent, do not undo"
  note '        an accepted review, and the 总览 cache always matches 开发WBS.'
  exit 0
fi
note 'RESULT: MISMATCH -- the WBS updaters do not coexist.'
exit 1
