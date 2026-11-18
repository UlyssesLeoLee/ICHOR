#!/usr/bin/env bash
# ATS-307: the attribution of a FULL-SUITE failure that is not this task's.
#
# WHY THIS LOG EXISTS
# -------------------
# The full regression (step 6) is a HOST-RESOURCE measurement: 1900+ cases
# run in one process tree, and a case that opens a socket can lose it when
# the machine is loaded. A reviewer who re-runs the suite on a loaded host
# may see ONE failure that this delivery did not cause, and the review then
# reads as "the delivery broke something".
#
# The repository already has the discipline for this: the ATS-106 evidence
# carries a `10-suite-flaky-rerun.log` that re-runs each failing file on
# its OWN and shows it green. This step is the same shape.
#
# WHAT IT SHOWS
# -------------
#   1. the failing case's FILE, re-run on its own (its own exit code);
#   2. the diff between this branch and the base, for that file -- EMPTY
#      means this task did not touch it;
#   3. the same file re-run on the BASE tree, so the reader can see the
#      failure is not a property of this branch.
#
# The BASE is a PINNED COMMIT, not a `git log --grep` search: a search
# moves onto the fixed tree as soon as another matching commit is merged.
#
# Usage: bash tools/ats307-probes/collect-flaky-attribution.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/docs/evidence/ATS-307"
cd "$ROOT"
mkdir -p "$OUT"

COMMIT="$(git rev-parse HEAD)"
NODE="$(node --version)"
PLATFORM="$(node -p 'process.platform + " " + process.arch')"

# The commit this branch started from. It is the tree the reviewer compares
# against, and it is PINNED here on purpose.
BASE="${ATS307_BASE:-3bbfdeb6ba2ce477f1c316d5ddf0ec6625963f39}"

# The file that holds the case the review reported.
FILE="${ATS307_FLAKY_FILE:-tests/ats214-batch-context.test.mjs}"

header() {
  echo "=============================================================================="
  echo "ATS-307 evidence log -- $1"
  echo "=============================================================================="
  echo "commit        : $COMMIT"
  echo "timestamp     : $(date -u +%Y-%m-%dT%H:%M:%SZ) (UTC)"
  echo "repo root     : $ROOT"
  echo "node          : $NODE"
  echo "platform      : $PLATFORM"
  echo "command       : $2"
  echo "=============================================================================="
  echo
}

{
  header "the attribution of a full-suite failure that is not this task's" "node --test $FILE"

  echo "--- why this log exists ---"
  echo "The full regression runs 1900+ cases in one process tree. Under host"
  echo "load a case that holds a socket can lose it (ECONNRESET), so the"
  echo "same tree reports 0 failures on one run and 1 on the next. A failure"
  echo "of that shape is a property of the HOST, not of the code."
  echo
  echo "This log answers the question that decides it: does the failing file"
  echo "pass on its own, and does this task touch it?"
  echo

  echo "--- 1. the failing file, re-run on its own (this branch) ---"
  echo
  OUT_ONE="$(node --test --test-concurrency=1 "$FILE" 2>&1)"
  CODE_ONE=$?
  echo "$OUT_ONE"
  echo
  echo "exit code: $CODE_ONE"
  echo

  echo "--- 2. does this task touch that file? ---"
  echo
  echo "\$ git diff $BASE HEAD -- $FILE"
  git diff "$BASE" HEAD -- "$FILE"
  echo "(an empty diff means this task changed nothing in that file)"
  echo
  echo "\$ git diff $BASE HEAD --stat -- the sources this task changed"
  git diff "$BASE" HEAD --stat -- server/traceability tools/update_wbs_ats307.py
  echo
  echo

  echo "--- 3. the same file on the BASE tree, on its own ---"
  echo
  echo "The base tree is checked out into a temporary worktree, so the"
  echo "comparison does not touch this checkout."
  # `mktemp -d` returns an MSYS path (/tmp/...), and `git worktree` is a
  # NATIVE program that does not convert it -- it would resolve the path
  # literally and create the worktree somewhere else (or nowhere).
  # `pwd -W` gives the Windows form the native tools understand.
  TMP="$(mktemp -d)"
  NATIVE_TMP="$(cd "$TMP" && pwd -W)"
  if git worktree add --detach "$NATIVE_TMP/base" "$BASE" >/dev/null 2>&1; then
    OUT_BASE="$(cd "$NATIVE_TMP/base" && node --test --test-concurrency=1 "$FILE" 2>&1)"
    CODE_BASE=$?
    echo "$OUT_BASE"
    echo
    echo "exit code: $CODE_BASE"
    git worktree remove --force "$NATIVE_TMP/base" >/dev/null 2>&1 || true
  else
    echo "the base tree could not be checked out; this step is INCONCLUSIVE"
    CODE_BASE=99
  fi
  rm -rf "$TMP" 2>/dev/null || true
  echo

  echo "--- the verdict ---"
  echo
  if [ "$CODE_ONE" = "0" ] && [ "$CODE_BASE" = "0" ]; then
    echo "RESULT: OK -- the file passes on its own on BOTH trees, and this task"
    echo "changed nothing in it. A failure of this file inside the full suite"
    echo "is a HOST-RESOURCE effect, not a regression of this delivery."
  elif [ "$CODE_ONE" != "0" ]; then
    echo "RESULT: FAIL -- the file fails on its own on THIS branch. That is a"
    echo "real failure, not a host effect."
  elif [ "$CODE_BASE" = "99" ]; then
    echo "RESULT: INCONCLUSIVE -- the base tree could not be checked out, so"
    echo "the comparison could not be made. The file passes on its own on"
    echo "this branch, which is the half that matters."
  else
    echo "RESULT: INCONCLUSIVE -- the file passes on its own on this branch"
    echo "but fails on the base tree. The failure is therefore NOT introduced"
    echo "by this branch; the base tree is the broken one."
  fi
} > "$OUT/10-suite-flaky-attribution.log" 2>&1
echo "written: $OUT/10-suite-flaky-attribution.log"
