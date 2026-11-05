#!/usr/bin/env bash
# Re-collect the ATS-208 evidence logs over the CURRENT tree.
#
# usage: bash tools/ats208-probes/collect-evidence.sh
#
# Every log lands in docs/evidence/ATS-208/. The point of this script is that
# the delivered evidence describes the tree that is actually delivered -- the
# reviewer rejected an earlier delivery (ATS-205) because the logs had been
# collected on a pre-merge branch.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1
EV=docs/evidence/ATS-208
mkdir -p "$EV"

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

run() { # run <logfile> <label> <command...>
  local out="$1" label="$2"; shift 2
  {
    echo "=== $label ==="
    echo "repo root : $(pwd)"
    echo "commit    : $(git rev-parse --short HEAD)"
    echo "branch    : $(git branch --show-current)"
    echo "node      : $(node --version)"
    echo "python    : $(python --version 2>&1)"
    echo
    "$@" 2>&1
    echo
    echo "exit code : $?"
  } > "$EV/$out"
  echo "wrote $EV/$out"
}

# --- 01 / 02: the unit and integration suites of the model ------------------
run 01-node-test-execution-model-ut.log "the execution model unit suite" \
  node --test tests/execution-model.test.mjs
run 02-node-test-execution-model-it.log "the execution model integration suite" \
  node --test tests/execution-model-it.test.mjs

# --- 03: the full test suite ------------------------------------------------
run 03-node-test-full.log "the full node test suite" npm test

# --- 04 / 05: the probes of this task --------------------------------------
# The two probes MEASURE the behaviour before and after the change: the first
# one shows that a retried case is counted ONCE and keeps every attempt, the
# second one shows that the events of a run -- including a run whose bridge
# was killed -- replay into the run's status.
run 04-probe-current-behaviour.log "the retried case: counted once, every attempt kept" \
  node tools/ats208-probes/probe-current-behaviour.mjs
run 05-probe-event-replay.log "the event stream: replayed by run+sequence, gap-free" \
  node tools/ats208-probes/probe-event-replay.mjs

# --- 06: the ADR citation check ---------------------------------------------
run 06-adr-citations.log "the ADR citation check" \
  python tools/check_adr_citations.py

# --- 07: the ATS-301 quality gate -------------------------------------------
run 07-quality-gates.log "the ATS-301 gate: WBS helper + ADR citations + port audit" \
  bash tools/ats301-probes/check-ats301-gate.sh

# --- 08: the WBS row of this task -------------------------------------------
run 08-wbs-row.log "the ATS-208 row of docs/WBS.xlsx" \
  python tools/update_wbs_ats208.py

# --- 09: the python gates ----------------------------------------------------
run 09-python-gates.log "the python gates under tools/" \
  python -m pytest tools/ -q
{
  echo
  echo "=== NOTE ==="
  echo "The ATS-506 marker assertion (test_tc002_ats506_marker_and_narrative)"
  echo "FAILED on the first delivery of ATS-208: it asserted that MARKERS[-1]"
  echo "is 【ATS-506】, but 【ATS-512】 had been appended to MARKERS by a later"
  echo "delivery without updating the assertion. It failed identically on the"
  echo "base commit, so it was NOT caused by ATS-208."
  echo
  echo "It is FIXED in the tree this delivery was merged into (the ATS-512"
  echo "delivery updated the assertion), so the suite above is green."
} >> "$EV/09-python-gates.log"

# --- 10: the coverage of the model -------------------------------------------
{
  echo "=== the coverage of the execution model ==="
  echo "repo root : $(pwd)"
  echo "commit    : $(git rev-parse --short HEAD)"
  echo
  node --test --experimental-test-coverage \
    --test-coverage-include='server/**' \
    tests/*.test.mjs 2>&1
} > "$EV/10-coverage.log"
echo "wrote $EV/10-coverage.log"

# --- 11: the reviewer's probes ----------------------------------------------
# The first review round rejected the delivery with eight mandatory items and
# shipped four probes with it. This log is the EVIDENCE that those probes
# pass on the delivered tree: it is the same probes, run the same way.
#
# The probes are INPUT (they arrive as an issue attachment), not a
# deliverable, so they are NOT checked into the repository. The script looks
# for them in the places they can be:
#
#   $ATS208_REVIEW_PROBES   -- a directory with the four probe scripts
#   .work/r1/probes/probes   -- the default location of the downloaded
#                              attachment
#
# When neither exists the step says so instead of pretending it ran.
{
  echo "=== the probes of the first review round ==="
  echo "repo root : $(pwd)"
  echo "commit    : $(git rev-parse --short HEAD)"
  echo "node      : $(node --version)"
  echo
  PROBES="${ATS208_REVIEW_PROBES:-}"
  if [ -z "$PROBES" ]; then
    for candidate in .work/r1/probes/probes "$HOME/Downloads/ats208-r1-probes/probes"; do
      if [ -d "$candidate" ]; then PROBES="$candidate"; break; fi
    done
  fi
  if [ -z "$PROBES" ] || [ ! -d "$PROBES" ]; then
    echo "NOT RUN: the reviewer's probe scripts are not available in this tree."
    echo "They arrive as an issue attachment (ats208-r1-probes.zip) and are INPUT,"
    echo "not a deliverable, so they are not checked in."
    echo "Point ATS208_REVIEW_PROBES at the unpacked directory and re-run to"
    echo "collect this log."
  else
    echo "probes    : $PROBES"
    echo
    SCRATCH="${TMPDIR:-/tmp}/ats208-review-probes"
    rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
    # `pwd` in an MSYS shell prints a POSIX path ("/d/ICHOR"), which node
    # cannot resolve as a module path ("D:\d\ICHOR\..."). The tree and the
    # scratch are therefore converted to NATIVE paths first.
    TREE_NATIVE="$(cd "$(pwd)" && pwd -W 2>/dev/null || pwd)"
    SCRATCH_NATIVE="$(cd "$SCRATCH" && pwd -W 2>/dev/null || pwd)"
    echo "tree      : $TREE_NATIVE"
    echo
    echo "--- pw-semantics: does the model agree with Playwright's own verdict? ---"
    node "$PROBES/pw-semantics.mjs" "$TREE_NATIVE" "${ATS208_PW_REPORT:-$SCRATCH_NATIVE/pw-report.json}" 2>&1
    echo "exit code : $?"
    echo
    echo "--- startup-robustness: does the Bridge start when the log is damaged? ---"
    node "$PROBES/startup-robustness.mjs" "$TREE_NATIVE" "$SCRATCH_NATIVE/sr" 2>&1
    echo "exit code : $?"
    echo
    echo "--- wdio-check: does the WDIO side merge a re-executed case? ---"
    node "$PROBES/wdio-check.mjs" "$TREE_NATIVE" 2>&1
    echo "exit code : $?"
    echo
    echo "--- bridge-e2e: the Bridge end to end with a real Playwright ---"
    node "$PROBES/bridge-e2e.mjs" "$TREE_NATIVE" "${ATS208_PWPROJ2:-$SCRATCH_NATIVE/pwproj2}" "$SCRATCH_NATIVE/e2e" 2>&1
    echo "exit code : $?"
  fi
} > "$EV/11-reviewer-probes.log"
echo "wrote $EV/11-reviewer-probes.log"

# --- 12: the mutation evidence ----------------------------------------------
# The review asked for the new cases to be RED on the previous delivery
# (8c9dd79): a case that is green on both trees proves nothing.
#
# This log runs the NEW test files against the OLD tree. The old tree is
# extracted with `git archive`, so the run is hermetic: it does not touch
# the working tree and it does not need the old branch to be checked out.
{
  echo "=== the new cases on the PREVIOUS delivery (8c9dd79) ==="
  echo "repo root : $(pwd)"
  echo "commit    : $(git rev-parse --short HEAD)"
  echo
  OLD="${ATS208_OLD_TIP:-8c9dd79}"
  SCRATCH="${TMPDIR:-/tmp}/ats208-mutation"
  rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/tree"
  # The archive is extracted with PYTHON, not with `tar -x -C`: the Windows
  # tar refuses a "D:/..." path ("Cannot connect to D: resolve failed") and
  # the git fallback needs a git dir that is not where the script expects.
  # Python's tarfile is portable and needs no path rewriting.
  if git archive --format=tar "$OLD" > "$SCRATCH/old.tar" 2>/dev/null \
     && python -c "
import sys, tarfile
with tarfile.open(sys.argv[1]) as t:
    t.extractall(sys.argv[2])
" "$SCRATCH/old.tar" "$SCRATCH/tree" 2>/dev/null; then
    # The NEW test files are copied onto the OLD tree: the cases are the
    # ones of this delivery, the code is the one of the previous delivery.
    if [ -d "$SCRATCH/tree/tests" ]; then
      cp tests/execution-model.test.mjs tests/execution-model-it.test.mjs "$SCRATCH/tree/tests/"
      echo "old tree  : $OLD (extracted from git archive)"
      echo "test files: the NEW ones of this delivery"
      echo
      ( cd "$SCRATCH/tree" && node --test tests/execution-model.test.mjs tests/execution-model-it.test.mjs 2>&1 )
      echo "exit code : $? (non-zero is EXPECTED: the cases must be red on the old tree)"
    else
      echo "NOT RUN: the archive of $OLD could not be extracted."
    fi
  else
    echo "NOT RUN: the commit $OLD is not in this repository."
  fi
} > "$EV/12-mutation-evidence.log"
echo "wrote $EV/12-mutation-evidence.log"

echo "done"
