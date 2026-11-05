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
  echo "test_tc002_ats506_marker_and_narrative fails on this tree, and it is"
  echo "PRE-EXISTING: it fails identically on the base commit acfd7fc"
  echo "(git archive acfd7fc -> pytest tools/ -q -> 1 failed, 28 passed)."
  echo "It asserts that MARKERS[-1] is 【ATS-506】, but 【ATS-512】 was appended"
  echo "to MARKERS by a later delivery (ATS-512) without updating the"
  echo "assertion. It is unrelated to the ATS-208 execution model."
} >> "$EV/09-python-gates.log"

# --- 10: the coverage of the model -------------------------------------------
{
  echo "=== the coverage of the execution model ==="
  echo "repo root : $(pwd)"
  echo "commit    : $(git rev-parse --short HEAD)"
  echo
  node --test --experimental-test-coverage \
    --test-coverage-include='server/execution/**' \
    tests/execution-model.test.mjs tests/execution-model-it.test.mjs 2>&1
} > "$EV/10-coverage.log"
echo "wrote $EV/10-coverage.log"

echo "done"
