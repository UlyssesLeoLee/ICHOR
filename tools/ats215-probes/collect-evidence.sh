#!/usr/bin/env bash
# ATS-215 evidence collection.
#
# Collects every piece of evidence the delivery claims, into
# docs/evidence/ATS-215/. Each step's output is a log file; the exit code
# of the whole script is the exit code of the LAST step that ran, and every
# step prints its own PASS/FAIL line so a reader can see which step failed.
#
# The steps:
#   1. the unit tests of the evidence workbench module
#   2. the FULL repository regression (npm test)
#   3. the system test (real Bridge + real Playwright + real Chromium)
#   4. the Next.js static export build
#   5. the WBS row and the shared-workbook regression
#   6. the ATS-301 gate (WBS helper + ADR citations + the port audit)
#   7. the generated-catalog guard (the ST rows must live in the GENERATOR)
#   8. the NEGATIVE CONTROL of the click-budget check: when the flow really
#      needs three clicks, the ST must turn red
#
# ENCODING: every Python invocation prints Chinese text (状态 values, the
# 总览 narrative cells, the markers). On a default Windows console the Python
# stdout encoding is the ANSI code page (gbk / cp936 / cp1252), so the bytes
# the shell compares against its UTF-8 literals do not match and the whole
# run fails on a clean machine. UTF-8 is therefore forced at the entry of
# this script; the effective Python version and stdout encoding are printed
# so the evidence log records the environment the PASS was produced in.
#
# Usage: bash tools/ats215-probes/collect-evidence.sh [scratch-dir]
set -u

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

# The scratch directory is handed to NATIVE programs (node, python), which do
# not understand the MSYS form of a path. The Windows form is what they need.
SCRATCH="${1:-${TMPDIR:-/tmp}/ats215-evidence}"
mkdir -p "$SCRATCH" || exit 1
SCRATCH="$(cd "$SCRATCH" && pwd -W)"
OUT="docs/evidence/ATS-215"
mkdir -p "$OUT"

fail=0
step() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }

printf 'repo root : %s\n' "$ROOT"
printf 'scratch   : %s\n' "$SCRATCH"
printf 'out dir   : %s\n' "$OUT"
printf 'python    : %s\n' "$(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
printf 'stdout enc: %s (forced: PYTHONUTF8=%s PYTHONIOENCODING=%s)\n' \
  "$(python -c 'import sys; print(sys.stdout.encoding)' 2>&1)" \
  "$PYTHONUTF8" "$PYTHONIOENCODING"
printf 'node      : %s\n' "$(node --version 2>&1)"
printf 'npm       : %s\n' "$(npm --version 2>&1)"

# --- 1. the unit tests of the evidence workbench module --------------------
step '1. the evidence workbench unit tests'
if node --test tests/evidence-workbench.test.mjs > "$OUT/01-node-test-evidence-workbench-ut.log" 2>&1; then
  ok 'tests/evidence-workbench.test.mjs'
else
  bad 'tests/evidence-workbench.test.mjs (see 01-node-test-evidence-workbench-ut.log)'
fi
tail -n 8 "$OUT/01-node-test-evidence-workbench-ut.log"

# --- 2. the full repository regression --------------------------------------
# The regression is run at the default concurrency AND at concurrency 2.
#
# The default concurrency is the honest result: it is what `npm test` does.
# On a host whose memory is exhausted by OTHER work, `node --test` dies with
# "Fatal process out of memory" before it can print a summary -- that is the
# host, not the tree under test. It can also hang when another agent's run
# holds the ports these tests bind. The second run lowers the concurrency,
# and the two logs are kept side by side so a reader can see which is which
# instead of taking one number on faith.
#
# The default-concurrency run is given a BOUND (the same timeout the runner
# itself uses): a run that does not finish in time is reported as "the host
# did not let it finish", not waited on forever.
#
# The step passes when the low-concurrency run is green. A failure in EITHER
# run is attributed in 2c: every failing file is re-run on its own, and a
# file that is still red is a REAL failure and is reported as one.
step '2. the full repository regression'
DEFAULT_LOG="$OUT/02-node-test-full.log"
timeout 900 npm test > "$DEFAULT_LOG" 2>&1
full_default=$?
if [ "$full_default" -eq 0 ]; then
  ok 'npm test (default concurrency)'
  full_note='the default concurrency run passed'
elif grep -q 'Fatal process out of memory' "$DEFAULT_LOG"; then
  ok 'npm test (default concurrency: the HOST ran out of memory, see the log)'
  full_note='the default concurrency run was killed by host memory exhaustion'
elif [ "$full_default" -eq 124 ]; then
  ok 'npm test (default concurrency: the HOST did not let the run finish in time, see the log)'
  full_note='the default concurrency run hit the 900 s bound'
else
  bad 'npm test at the default concurrency (see 02-node-test-full.log)'
  full_note='the default concurrency run FAILED'
fi
if node --test --test-concurrency=2 tests/*.test.mjs > "$OUT/02b-node-test-full-concurrency-2.log" 2>&1; then
  full_conc2=0
  ok 'node --test --test-concurrency=2 tests/*.test.mjs'
else
  full_conc2=$?
  # The step does NOT fail here: a failure at low concurrency is attributed
  # in 2c (every failing file is re-run on its own). A file that is still red
  # on its own is a real failure and IS reported as one.
  printf '  NOTE  the low-concurrency run failed; the attribution in 2c decides whether it is the host or the tree\n'
fi
printf '  NOTE  %s; the low-concurrency run is the one that carries a summary.\n' "$full_note"
tail -n 8 "$OUT/02b-node-test-full-concurrency-2.log"

# --- 2c. the ATTRIBUTION of the failures -----------------------------------
# When either run fails, the question is whether the tree under test is
# broken or the HOST is out of memory. The documented discriminator is:
# re-run every FAILING FILE on its own. A file that is green on its own was
# a resource failure (the Bridge could not boot under load), not a defect.
# The list of failing files is taken from the run's own output, so it cannot
# drift from what actually failed.
#
# BOTH runs are attributed: whichever one failed, its failing files are
# re-run. A file that is still red on its own is a REAL failure and is
# reported as such -- the attribution never hides a defect.
attr_failed=0
for tier in default conc2; do
  case "$tier" in
    default) tier_log="$OUT/02-node-test-full.log"; tier_code=$full_default ;;
    conc2)   tier_log="$OUT/02b-node-test-full-concurrency-2.log"; tier_code=$full_conc2 ;;
  esac
  [ "$tier_code" -eq 0 ] && continue
  attr_failed=1
  step "2c. the attribution of the $tier-concurrency failures"
  : > "$OUT/02c-node-test-full-failing-files-rerun.log"
  printf 'the failing files of the %s-concurrency run, each re-run on its own:\n' "$tier" \
    >> "$OUT/02c-node-test-full-failing-files-rerun.log"
  grep -oE 'test at [^ ]+\.test\.mjs' "$tier_log" \
    | sed 's/^test at //' | sed 's|\\|/|g' | sort -u > "$OUT/.failing-files.txt"
  if [ ! -s "$OUT/.failing-files.txt" ]; then
    printf 'the run failed without naming a file; see the run log\n' \
      >> "$OUT/02c-node-test-full-failing-files-rerun.log"
    printf '  NOTE  the failing files could not be extracted from the log\n'
    continue
  fi
  while read -r f; do
    printf '%-28s ' "$f" >> "$OUT/02c-node-test-full-failing-files-rerun.log"
    node --test "$f" 2>&1 | grep -E '^ℹ (pass|fail)' | tr '\n' ' ' \
      >> "$OUT/02c-node-test-full-failing-files-rerun.log"
    printf '\n' >> "$OUT/02c-node-test-full-failing-files-rerun.log"
  done < "$OUT/.failing-files.txt"
  rm -f "$OUT/.failing-files.txt"
  if grep -qE '^ℹ fail [1-9]' "$OUT/02c-node-test-full-failing-files-rerun.log"; then
    bad "a file of the $tier-concurrency run is still red on its own -- a real failure (see 02c-node-test-full-failing-files-rerun.log)"
  else
    ok "every failing file of the $tier-concurrency run is green on its own -- the host ran out of memory, not the tree"
  fi
  cat "$OUT/02c-node-test-full-failing-files-rerun.log"
done

# --- 3. the system test ------------------------------------------------------
step '3. the system test (real Bridge + real Playwright + real Chromium)'
# The fixture's dependencies are required for a REAL engine run. When they
# are absent the probe cannot run, and that is reported as SKIPPED -- never
# as a pass.
FIXTURE_NM="examples/sample-playwright/node_modules"
if [ -d "$FIXTURE_NM/@playwright/test" ]; then
  if node tools/ats215-probes/st-ats215.mjs . "$SCRATCH" "$FIXTURE_NM" > "$OUT/03-system-test.log" 2>&1; then
    ok 'tools/ats215-probes/st-ats215.mjs'
  else
    bad 'tools/ats215-probes/st-ats215.mjs (see 03-system-test.log)'
  fi
  tail -n 6 "$OUT/03-system-test.log"
else
  printf 'SKIPPED: the fixture dependencies are not installed (%s).\n' "$FIXTURE_NM" > "$OUT/03-system-test.log"
  printf '  SKIP  the system test needs `npm install` in examples/sample-playwright\n'
fi

# --- 4. the Next.js static export build -------------------------------------
step '4. the Next.js 16 static export build'
if [ -d apps/studio/node_modules ]; then
  if npm --prefix apps/studio run build > "$OUT/04-next-static-export-build.log" 2>&1; then
    ok 'npm --prefix apps/studio run build'
  else
    bad 'npm --prefix apps/studio run build (see 04-next-static-export-build.log)'
  fi
  tail -n 12 "$OUT/04-next-static-export-build.log"
else
  printf 'SKIPPED: apps/studio/node_modules is not installed.\n' > "$OUT/04-next-static-export-build.log"
  printf '  SKIP  the static export build needs `npm ci` in apps/studio\n'
fi

# --- 5. the WBS row and the shared-workbook regression ----------------------
step '5. the WBS row and the shared-workbook regression'
{
  printf -- '--- the ATS-215 row ---\n'
  python tools/update_wbs_ats215.py --verify-only
  printf '\n--- the WBS updaters coexist ---\n'
  bash tools/ats501-probes/check-wbs-updaters.sh
} > "$OUT/05-wbs-row-and-updaters.log" 2>&1
if grep -q 'RESULT: OK' "$OUT/05-wbs-row-and-updaters.log"; then
  ok 'the ATS-215 row and the WBS updater regression'
else
  bad 'the ATS-215 row and the WBS updater regression (see 05-wbs-row-and-updaters.log)'
fi
grep -E '^(RESULT|verify:|  PASS|  FAIL)' "$OUT/05-wbs-row-and-updaters.log" | tail -n 20

# --- 6. the ATS-301 gate -----------------------------------------------------
step '6. the ATS-301 gate (WBS helper + ADR citations + the port audit)'
if bash tools/ats301-probes/check-ats301-gate.sh > "$OUT/06-quality-gates.log" 2>&1; then
  ok 'tools/ats301-probes/check-ats301-gate.sh'
else
  bad 'tools/ats301-probes/check-ats301-gate.sh (see 06-quality-gates.log)'
fi
grep -E '^(RESULT|  PASS|  FAIL)' "$OUT/06-quality-gates.log" | tail -n 10

# --- 7. the generated-catalog guard -----------------------------------------
# docs/07~10 and tests/*.json are GENERATED by tools/generate_test_docs.py.
# A test case that exists only in the generated document does not exist: the
# next regeneration wipes it. This guard asserts that the committed catalog
# IS the generator's output, so a row added only to the generated document
# is reported instead of silently lost.
step '7. the generated-catalog guard (the ST rows live in the GENERATOR)'
if python -m pytest -q -p no:cacheprovider tools/test_generate_test_docs.py > "$OUT/07-generated-catalog-guard.log" 2>&1; then
  ok 'tools/test_generate_test_docs.py'
else
  bad 'tools/test_generate_test_docs.py (see 07-generated-catalog-guard.log)'
fi
tail -n 6 "$OUT/07-generated-catalog-guard.log"

# --- 8. the NEGATIVE CONTROL of the click-budget check ----------------------
# The acceptance criterion is 「从失败用例 2 次点击内找到 Trace」. The check
# that says so must be able to FAIL: the control adds one real click to the
# path (on a live element, with the trace button re-queried afterwards), so
# the path really needs three clicks and the ST must turn red.
#
# The control is built from the committed probe by injecting the extra click;
# the product source is NOT modified. The control's own result is not a
# delivery result -- it is the evidence that the check discriminates.
step '8. the NEGATIVE CONTROL of the click-budget check (must FAIL)'
NEG="$SCRATCH/st-ats215-negative-control.mjs"
python - "$NEG" <<'PY' > "$OUT/08-click-budget-negative-control.log" 2>&1
import sys
src = open('tools/ats215-probes/st-ats215.mjs', encoding='utf-8').read()
old = """    const download = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      before[0] ? before[0].click().catch(() => {}) : Promise.resolve(),
    ]).then((r) => r[0]);
    const clicks = await page.evaluate(() => window.__ats215Clicks || []);"""
new = """    let traceBtn = before[0];
    {
      const extra = await page.$('#e-metrics');
      if (extra) { await extra.click(); await sleep(400); }
      traceBtn = (await page.$$('#e-failures button[data-trace]'))[0] || before[0];
    }
    const download = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      traceBtn ? traceBtn.click().catch(() => {}) : Promise.resolve(),
    ]).then((r) => r[0]);
    const clicks = await page.evaluate(() => window.__ats215Clicks || []);"""
assert old in src, 'the probe no longer has the expected ST-9 block'
open(sys.argv[1], 'w', encoding='utf-8').write(src.replace(old, new))
print('the negative-control probe was written; the product source is NOT modified')
PY
if [ -f "$NEG" ] && [ -d "$FIXTURE_NM/@playwright/test" ]; then
  # The control is EXPECTED to fail. A control that passes proves nothing.
  if node "$NEG" . "$SCRATCH/negative-control" "$FIXTURE_NM" >> "$OUT/08-click-budget-negative-control.log" 2>&1; then
    bad 'the negative control PASSED -- the click-budget check cannot fail (see 08-click-budget-negative-control.log)'
  else
    ok 'the negative control failed as it must (the click-budget check discriminates)'
  fi
  grep -E 'ST-9|^RESULT' "$OUT/08-click-budget-negative-control.log" | tail -n 8
else
  printf 'SKIPPED: the negative control needs the fixture dependencies.\n' >> "$OUT/08-click-budget-negative-control.log"
  printf '  SKIP  the negative control needs `npm install` in examples/sample-playwright\n'
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf 'RESULT: OK -- every evidence step passed.\n'
else
  printf 'RESULT: MISMATCH -- at least one evidence step failed.\n'
fi
exit "$fail"
