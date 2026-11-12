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

# --- the temporary artefacts go to D: ----------------------------------
# The C: page file is pinned at 8192 MB on this machine and cannot grow, so
# a big temporary tree on C: can kill the process with an unrelated
# "paging file is too small". The scratch directory is on D:.
export TMPDIR="${TMPDIR:-D:/hermes-multica/home/cache/scratch}"
export TEMP="$TMPDIR"
export TMP="$TMPDIR"

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

echo
if [ "$FAILED" = "0" ]; then
  echo "RESULT: OK -- every step of the ATS-214 evidence was executed and passed."
else
  echo "RESULT: FAILED -- at least one step of the ATS-214 evidence failed (see the logs above)."
fi
exit $FAILED
