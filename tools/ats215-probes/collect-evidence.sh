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

SCRATCH="${1:-${TMPDIR:-/tmp}/ats215-evidence}"
mkdir -p "$SCRATCH"
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
step '2. the full repository regression'
if npm test > "$OUT/02-node-test-full.log" 2>&1; then
  ok 'npm test'
else
  bad 'npm test (see 02-node-test-full.log)'
fi
tail -n 8 "$OUT/02-node-test-full.log"

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

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf 'RESULT: OK -- every evidence step passed.\n'
else
  printf 'RESULT: MISMATCH -- at least one evidence step failed.\n'
fi
exit "$fail"
