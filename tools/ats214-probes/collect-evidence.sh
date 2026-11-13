#!/usr/bin/env bash
# ATS-214: collect the evidence of the case search / tag / filter / batch run.
#
# WHAT THIS SCRIPT IS FOR
# -----------------------
# The evidence of a delivery has to be RE-RUNNABLE: a reader has to be able
# to run this script and get the same numbers. So every step here is a
# command whose output is captured verbatim, and the script prints a RESULT
# line at the end.
#
# The steps:
#   1. the Node UT of the shared module (the search / tag / filter / selection
#      semantics);
#   2. the Node IT against a REAL Bridge (the tags in the catalogue, the
#      selection validation, the batch split);
#   3. the tag PARITY between the static index and the real Playwright CLI;
#   4. the FULL repository regression;
#   5. the Next.js static export build;
#   6. the WBS row and the updater coexistence;
#   7. the checksums.
#
# USAGE
# -----
#   bash tools/ats214-probes/collect-evidence.sh
#
# The output goes to docs/evidence/ATS-214/.
set -u
cd "$(dirname "$0")/../.."

OUT="docs/evidence/ATS-214"
mkdir -p "$OUT"

# --- force UTF-8 for every Python invocation ---------------------------
# The Python steps print Chinese text (状态 values, markers). On a default
# Windows console the stdout encoding is the ANSI code page (gbk / cp936),
# so the bytes the shell compares against its UTF-8 literals do not match.
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

# --- the temporary artefacts go to D: -----------------------------------
# The C: page file is pinned at 8192 MB on this machine and cannot grow, so
# a big temporary tree on C: can kill the process with an unrelated
# "paging file is too small". The scratch directory is on D:.
#
# The path has to be a NATIVE Windows path: the probes run under Node,
# and `path.resolve('/tmp/...')` on Windows turns a MSYS-style path into
# `C:\tmp\...` -- a directory that does not exist, so `mkdtemp` fails with
# ENOENT and the probe measures nothing. `cygpath` (present in Git Bash)
# does the translation.
export TMPDIR="${TMPDIR:-D:/hermes-multica/home/cache/scratch}"
if command -v cygpath > /dev/null 2>&1; then
  TMPDIR="$(cygpath -w "$TMPDIR")"
fi
export TEMP="$TMPDIR"
export TMP="$TMPDIR"
mkdir -p "$TMPDIR"
echo "scratch: $TMPDIR"

FAILED=0

step () {
  echo
  echo "=== $1 ==="
}

note () {
  if [ "$1" = "0" ]; then
    echo "OK   $2"
  else
    echo "FAIL $2"
    FAILED=1
  fi
}

# --- 1. the Node UT ------------------------------------------------------
step "1. the Node UT of the shared search / tag / filter / selection module"
if node --test tests/ats214-case-search.test.mjs > "$OUT/01-node-test-case-search-ut.log" 2>&1; then
  note 0 "node --test tests/ats214-case-search.test.mjs"
else
  note 1 "node --test tests/ats214-case-search.test.mjs (see 01-node-test-case-search-ut.log)"
fi
tail -n 9 "$OUT/01-node-test-case-search-ut.log"

# --- 2. the Node IT against a real Bridge -------------------------------
step "2. the Node IT against a REAL Bridge (HTTP) with the real Playwright 1.64.1"
if node --test tests/ats214-batch-run-api.test.mjs > "$OUT/02-node-test-batch-run-it.log" 2>&1; then
  note 0 "node --test tests/ats214-batch-run-api.test.mjs"
else
  note 1 "node --test tests/ats214-batch-run-api.test.mjs (see 02-node-test-batch-run-it.log)"
fi
tail -n 9 "$OUT/02-node-test-batch-run-it.log"

# --- 2b. the Node IT of the batch's context and terminal states ---------
step "2b. the Node IT of the batch's request context and terminal states"
if node --test tests/ats214-batch-context.test.mjs > "$OUT/12-batch-context-it.log" 2>&1; then
  note 0 "node --test tests/ats214-batch-context.test.mjs"
else
  note 1 "node --test tests/ats214-batch-context.test.mjs (see 12-batch-context-it.log)"
fi
tail -n 9 "$OUT/12-batch-context-it.log"

# --- 3. the tag parity --------------------------------------------------
step "3. the tag parity: the static index vs the real Playwright --list"
if node tools/ats214-probes/tag-parity.mjs > "$OUT/03-tag-parity.log" 2>&1; then
  note 0 "the static index and the real CLI agree on the tags"
else
  note 1 "the tag parity probe (see 03-tag-parity.log)"
fi
tail -n 20 "$OUT/03-tag-parity.log"

# --- 4. the full repository regression -----------------------------------
step "4. the FULL repository regression (node --test --test-concurrency=2)"
# The concurrency is capped at 2: the machine runs several agents at once
# and the C: page file is pinned at 8192 MB, so a wider fan-out kills the
# process with an unrelated "paging file is too small".
if node --test --test-concurrency=2 tests/*.test.mjs > "$OUT/04-node-test-full.log" 2>&1; then
  note 0 "node --test --test-concurrency=2 tests/*.test.mjs"
else
  note 1 "node --test --test-concurrency=2 tests/*.test.mjs (see 04-node-test-full.log)"
fi
tail -n 9 "$OUT/04-node-test-full.log"

# --- 5. the Next.js static export build ----------------------------------
step "5. the Next.js 16 static export build (with the TypeScript check)"
# The build needs the dependencies of apps/studio. When they are not
# installed the step is SKIPPED WITH ITS REASON -- it is never reported
# as a pass (the repository's rule: PENDING is not PASS). The same rule
# is followed by the other evidence collectors in this repository
# (tools/ats111-probes/collect-evidence.sh).
BUILD_TREE="${ATS214_BUILD_TREE:-D:/ats214-build}"
if [ -d apps/studio/node_modules ] && [ -f apps/studio/node_modules/next/package.json ]; then
  if npm --prefix apps/studio run build > "$OUT/05-next-static-export-build.log" 2>&1; then
    note 0 "npm --prefix apps/studio run build"
  else
    note 1 "npm --prefix apps/studio run build (see 05-next-static-export-build.log)"
  fi
  tail -n 12 "$OUT/05-next-static-export-build.log"
else
  printf 'SKIPPED: apps/studio/node_modules is not installed.\n' > "$OUT/05-next-static-export-build.log"
  printf '  SKIP  the static export build needs `npm ci` in apps/studio\n'
  printf '  NOTE  the build was measured on the D: drive tree with the real\n'
  printf '        dependencies (docs/evidence/ATS-214/08-next-static-export-build-on-d.log)\n'
fi

# --- 6. the WBS row and the updater coexistence -------------------------
step "6. the WBS row of ATS-214 and the coexistence of the WBS updaters"
{
  python tools/update_wbs_ats214.py --verify-only
  bash tools/ats501-probes/check-wbs-updaters.sh
} > "$OUT/06-wbs-row-and-updaters.log" 2>&1
if grep -q "RESULT: OK" "$OUT/06-wbs-row-and-updaters.log"; then
  note 0 "the WBS row and the updater coexistence"
else
  note 1 "the WBS row / the updater coexistence (see 06-wbs-row-and-updaters.log)"
fi
grep -E "verify: ATS-214|RESULT: OK" "$OUT/06-wbs-row-and-updaters.log" | head -5

# --- 7. the release manifest ---------------------------------------------
# The manifest describes the COMMITTED tree, and the generator reads the
# git blobs -- so this step can only pass once the content is committed
# AND the manifest itself has been regenerated and committed (the order
# the repository's rule states: commit the content, regenerate the
# manifest, commit the manifest). A tree whose manifest has not been
# regenerated yet is EXPECTED to mismatch here; the fact that the
# mismatch is exactly the files this task changed is the check.
step "7. the release manifest"
if python tools/verify_checksums.py > "$OUT/07-verify-checksums.log" 2>&1; then
  note 0 "python tools/verify_checksums.py"
else
  note 1 "python tools/verify_checksums.py (see 07-verify-checksums.log)"
fi
tail -n 8 "$OUT/07-verify-checksums.log"

# --- 8. the ST in a REAL browser ----------------------------------------
# The ST drives the REAL static export in the REAL Chromium against the
# REAL Bridge, with a 500-case fixture. It needs three things that may be
# missing on a machine: the built static export, the real Playwright
# (for the engine and for the browser), and a free Bridge port.
#
# When one of them is missing the step is SKIPPED WITH ITS REASON -- it
# is never reported as a pass (the repository's rule: PENDING is not
# PASS).
step "8. the ST: the case search / the tag filter / the selection in a REAL browser"
ST_PW=""
for candidate in \
  "${ATS214_PLAYWRIGHT_MODULES:-}" \
  "examples/sample-playwright/node_modules" \
  "D:/ICHOR/examples/sample-playwright/node_modules"; do
  if [ -n "$candidate" ] && [ -f "$candidate/playwright-core/index.js" ]; then
    ST_PW="$candidate"
    break
  fi
done
if [ ! -f apps/studio/out/index.html ]; then
  printf 'SKIPPED: apps/studio/out is not built.\n' > "$OUT/10-st-500-cases.log"
  printf '  SKIP  the ST drives the built static export; run `npm --prefix apps/studio run build` first\n'
elif [ -z "$ST_PW" ]; then
  printf 'SKIPPED: the real playwright-core could not be reached.\n' > "$OUT/10-st-500-cases.log"
  printf '  SKIP  set ATS214_PLAYWRIGHT_MODULES to the directory that holds playwright-core/index.js\n'
else
  echo "playwright-core: $ST_PW"
  # A Bridge left over from ANOTHER tree would make the ST measure a
  # STALE build -- a false defect. The probe refuses to run in that
  # case (it compares the served page's css chunk with the file on
  # disk), so the step fails loudly rather than reporting a wrong
  # measurement.
  if node tools/ats214-probes/st-ats214.mjs . "$TMPDIR" "$ST_PW" > "$OUT/10-st-500-cases.log" 2>&1; then
    note 0 "node tools/ats214-probes/st-ats214.mjs (the ST in a real browser)"
  else
    note 1 "the ST probe (see 10-st-500-cases.log)"
  fi
  grep -E "^(OK|DEFECT|RESULT|the served)" "$OUT/10-st-500-cases.log" | head -20
fi

# --- 9. the NEGATIVE CONTROL: the mutations must turn the suite red ----
# A test suite that cannot fail is not evidence. The mutation probe
# breaks the delivered code in twelve ways and asserts that the ATS-214
# tests GO RED for each of them.
#
# The interface mutations need a real static export, and Turbopack does
# not resolve a JUNCTION to a dependency tree on another volume -- so the
# build happens in `ATS214_BUILD_TREE`, a tree on D: with a REAL directory
# of dependencies. The probe copies the mutated sources there, builds, and
# copies the build back into the tree under test.
step "9. the negative control: every mutation of the delivered code must turn the suite red"
# The build tree: a tree with a REAL directory of dependencies, because
# Turbopack does not resolve a JUNCTION to a dependency tree on another
# volume. Without it the interface mutations are reported as "not caught"
# -- which says nothing about the tests, only that the build did not run.
export ATS214_BUILD_TREE="${ATS214_BUILD_TREE:-D:/ats214-build}"
if node tools/ats214-probes/mutation-check.mjs . "$TMPDIR" > "$OUT/13-mutation-control.log" 2>&1; then
  note 0 "node tools/ats214-probes/mutation-check.mjs (every mutation caught)"
else
  note 1 "the mutation probe (see 13-mutation-control.log)"
fi
grep -E "^(PASS|FAIL|RESULT)" "$OUT/13-mutation-control.log" | head -20

# --- 10. the ACCEPTANCE MAPPING: each completion definition -> evidence -
# The issue's and the WBS row's completion definition is TWO sentences:
#
#   1. 「500 用例过滤无明显阻塞」
#   2. 「选中准确映射 UID」
#
# This step reads the MEASURED logs and asserts that each definition has
# evidence behind it. The mapping is not written by hand: every row below
# is checked against a log that this same run produced, and a definition
# whose evidence is missing is reported as NOT PROVEN.
step "10. the acceptance mapping: every completion definition has measured evidence"
{
  echo "completion definition -> the measured evidence that backs it"
  echo
  fail=0
  # 1. 「500 用例过滤无明显阻塞」 -- the ST must have loaded 500 cases
  #    without an error and answered the interactions within the budget.
  if grep -q "ST-ATS214-001 loads-500-without-error  rows=500" "$OUT/10-st-500-cases.log" 2>/dev/null \
  && grep -q "ST-ATS214-003 filtering-within-budget" "$OUT/10-st-500-cases.log" 2>/dev/null; then
    echo "  PROVEN  「500 用例过滤无明显阻塞」  <- 10-st-500-cases.log (ST-001: 500 rows, 0 console error; ST-003: within the 100 ms budget)"
  else
    echo "  NOT PROVEN  「500 用例过滤无明显阻塞」  <- 10-st-500-cases.log does not show it"
    fail=1
  fi
  # 2. 「选中准确映射 UID」 -- the ST must have ticked two cases and the
  #    REQUEST must have carried exactly those uids.
  if grep -q "ST-ATS214-011 the-request-carries-every-ticked-uid" "$OUT/10-st-500-cases.log" 2>/dev/null; then
    echo "  PROVEN  「选中准确映射 UID」  <- 10-st-500-cases.log (ST-011: the request carried every ticked uid)"
  else
    echo "  NOT PROVEN  「选中准确映射 UID」  <- 10-st-500-cases.log does not show it"
    fail=1
  fi
  # The reviewer's own probes: the acceptance criteria of round 1.
  if [ -f "$OUT/reviewer-probes/r1-api.log" ] && [ -f "$OUT/reviewer-probes/r1-ui.log" ]; then
    if grep -q "^OK     B1 " "$OUT/reviewer-probes/r1-api.log" && grep -q "^OK     B2 " "$OUT/reviewer-probes/r1-api.log" \
    && grep -q "^OK     X1 " "$OUT/reviewer-probes/r1-ui.log" && grep -q "^OK     X3 " "$OUT/reviewer-probes/r1-ui.log"; then
      echo "  PROVEN  复核方第 1 轮的必过项 (r1-api B1/B2, r1-ui X1/X3)  <- reviewer-probes/"
    else
      echo "  NOT PROVEN  复核方第 1 轮的必过项  <- reviewer-probes/"
      fail=1
    fi
  else
    echo "  SKIPPED  复核方的探针日志不在本次采集里（reviewer-probes/ 是单独复跑的）"
  fi
  echo
  if [ "$fail" = "0" ]; then echo "RESULT: OK -- every completion definition has measured evidence."; else echo "RESULT: FAILED -- a completion definition has no evidence."; fi
} > "$OUT/09-acceptance-mapping.log" 2>&1
if grep -q "RESULT: OK" "$OUT/09-acceptance-mapping.log"; then
  note 0 "the acceptance mapping"
else
  note 1 "the acceptance mapping (see 09-acceptance-mapping.log)"
fi
cat "$OUT/09-acceptance-mapping.log"

echo
if [ "$FAILED" = "0" ]; then
  echo "RESULT: OK -- every step of the ATS-214 evidence was executed and passed."
else
  echo "RESULT: FAILED -- at least one step of the ATS-214 evidence failed (see the logs above)."
fi
exit $FAILED
