#!/usr/bin/env bash
# ATS-111 evidence collection.
#
# Collects every piece of evidence the delivery claims, into
# docs/evidence/ATS-111/. Each step's output is a log file; the exit code
# of the whole script is the exit code of the LAST step that ran, and every
# step prints its own PASS/FAIL line so a reader can see which step failed.
#
# The steps:
#   1. the unit tests of the workbench state model
#   2. the FULL repository regression (npm test)
#   3. the system test (real Bridge + real Playwright + real Chromium)
#   4. the mutation check (the tests must fail when the model is broken)
#   5. the Next.js static export build
#   6. the WBS row and the shared-workbook regression
#   7. the ATS-301 gate (WBS helper + ADR citations + the port audit)
#
# ENCODING: every Python invocation prints Chinese text (状态 values, the
# 总览 narrative cells, the markers). On a default Windows console the Python
# stdout encoding is the ANSI code page (gbk / cp936 / cp1252), so the bytes
# the shell compares against its UTF-8 literals do not match and the whole
# run fails on a clean machine. UTF-8 is therefore forced at the entry of
# this script; the effective Python version and stdout encoding are printed
# so the evidence log records the environment the PASS was produced in.
#
# THE PAGE FILE IS A HARD CONSTRAINT
# ---------------------------------
# The paging file on this machine is pinned at 8 GB on C: and cannot be
# grown, so a process that outgrows it dies with an error that has nothing
# to do with the product ("heap out of memory", "paging file is too
# small", 0xc0000409). Two things follow, and the script does both:
#
#   - the full regression runs with `--test-concurrency=2`, so the test
#     runner does not start every file at once;
#   - the Node heap is raised explicitly (NODE_OPTIONS), so the V8 heap is
#     large enough for the build's TypeScript pass instead of relying on
#     the default, which is sized against the page file.
#
# The scratch directory (the temporary trees the probes make) is on D: by
# default, because C: has the least free space.
#
# Usage: bash tools/ats111-probes/collect-evidence.sh [scratch-dir]
set -u

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
export NODE_OPTIONS=--max-old-space-size=2048

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

# The scratch is on D: when it exists (the temporary trees the probes
# make are large, and C: is the drive with the small page file), and on
# the default temporary directory otherwise.
if [ -d /d ] || [ -d "D:/" ]; then
  DEFAULT_SCRATCH="D:/ats111-evidence"
else
  DEFAULT_SCRATCH="${TMPDIR:-/tmp}/ats111-evidence"
fi
SCRATCH="${1:-$DEFAULT_SCRATCH}"
mkdir -p "$SCRATCH"
OUT="docs/evidence/ATS-111"
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
  "$(python -c 'import sys; print(sys.stdout.encoding)' 2>&1)" "$PYTHONUTF8" "$PYTHONIOENCODING"
printf 'node      : %s\n' "$(node --version 2>&1)"
printf 'npm       : %s\n' "$(npm --version 2>&1)"
printf 'heap      : %s\n' "$NODE_OPTIONS"

# --- 1. the unit tests of the state model ---------------------------------
step '1. the workbench state model unit tests'
if node --test tests/workbench-state.test.mjs > "$OUT/01-node-test-workbench-state-ut.log" 2>&1; then
  ok 'tests/workbench-state.test.mjs'
else
  bad 'tests/workbench-state.test.mjs (see 01-node-test-workbench-state-ut.log)'
fi
tail -n 8 "$OUT/01-node-test-workbench-state-ut.log"

# --- 2. the full repository regression --------------------------------------
# The concurrency is capped at 2: the page file on this machine is pinned
# at 8 GB, and the default concurrency starts every test file at once.
step '2. the full repository regression'
if node --test --test-concurrency=2 tests/*.test.mjs > "$OUT/02-node-test-full.log" 2>&1; then
  ok 'the full regression (node --test --test-concurrency=2 tests/*.test.mjs)'
else
  bad 'the full regression (see 02-node-test-full.log)'
fi
tail -n 8 "$OUT/02-node-test-full.log"

# --- 3. the system test ------------------------------------------------------
# The system test needs the fixture's dependencies for a REAL engine run.
# When they are absent the probe cannot run, and that is reported as
# SKIPPED -- never as a pass.
FIXTURE_NM="examples/sample-playwright/node_modules"
if [ -d "$FIXTURE_NM/@playwright/test" ]; then
  if node tools/ats111-probes/st-ats111.mjs . "$SCRATCH" "$FIXTURE_NM" > "$OUT/03-system-test.log" 2>&1; then
    ok 'tools/ats111-probes/st-ats111.mjs'
  else
    bad 'tools/ats111-probes/st-ats111.mjs (see 03-system-test.log)'
  fi
  tail -n 12 "$OUT/03-system-test.log"
else
  printf 'SKIPPED: the fixture dependencies are not installed (%s).\n' "$FIXTURE_NM" > "$OUT/03-system-test.log"
  printf '  SKIP  the system test needs `npm install` in examples/sample-playwright\n'
fi

# --- 4. the mutation check ---------------------------------------------------
step '4. the mutation check (the tests must fail when the model is broken)'
if node tools/ats111-probes/mutation-check.mjs . "$SCRATCH-mut" > "$OUT/04-mutation-evidence.log" 2>&1; then
  ok 'tools/ats111-probes/mutation-check.mjs'
else
  bad 'tools/ats111-probes/mutation-check.mjs (see 04-mutation-evidence.log)'
fi
tail -n 14 "$OUT/04-mutation-evidence.log"

# --- 5. the Next.js static export build -------------------------------------
step '5. the Next.js 16 static export build'
if [ -d apps/studio/node_modules ]; then
  if npm --prefix apps/studio run build > "$OUT/05-next-static-export-build.log" 2>&1; then
    ok 'npm --prefix apps/studio run build'
  else
    bad 'npm --prefix apps/studio run build (see 05-next-static-export-build.log)'
  fi
  tail -n 12 "$OUT/05-next-static-export-build.log"
else
  printf 'SKIPPED: apps/studio/node_modules is not installed.\n' > "$OUT/05-next-static-export-build.log"
  printf '  SKIP  the static export build needs `npm ci` in apps/studio\n'
fi

# --- 6. the WBS row and the shared-workbook regression ----------------------
step '6. the WBS row and the shared-workbook regression'
{
  printf -- '--- the ATS-111 row ---\n'
  python tools/update_wbs_ats111.py --verify-only
  printf -- '\n--- the WBS updaters coexist ---\n'
  bash tools/ats501-probes/check-wbs-updaters.sh
} > "$OUT/06-wbs-row-and-updaters.log" 2>&1
if grep -q 'RESULT: OK' "$OUT/06-wbs-row-and-updaters.log"; then
  ok 'the ATS-111 row and the WBS updater regression'
else
  bad 'the ATS-111 row and the WBS updater regression (see 06-wbs-row-and-updaters.log)'
fi
grep -E '^(RESULT|verify:|  PASS|  FAIL)' "$OUT/06-wbs-row-and-updaters.log" | tail -n 20

# --- 7. the ATS-301 gate -----------------------------------------------------
step '7. the ATS-301 gate (WBS helper + ADR citations + the port audit)'
if bash tools/ats301-probes/check-ats301-gate.sh > "$OUT/07-quality-gates.log" 2>&1; then
  ok 'tools/ats301-probes/check-ats301-gate.sh'
else
  bad 'tools/ats301-probes/check-ats301-gate.sh (see 07-quality-gates.log)'
fi
grep -E '^(RESULT|  PASS|  FAIL)' "$OUT/07-quality-gates.log" | tail -n 10

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf 'RESULT: OK -- every evidence step passed.\n'
else
  printf 'RESULT: MISMATCH -- at least one evidence step failed.\n'
fi
exit "$fail"
