#!/usr/bin/env bash
# Re-collect the ATS-206 evidence logs over the CURRENT tree.
#
# usage: bash tools/ats206-probes/collect-evidence.sh
#
# Every log lands in docs/evidence/ATS-206/. The point of this script is that
# the delivered evidence describes the tree that is actually delivered.
#
# The FIRST log is a BEFORE/AFTER pair: the same defect probe is run against
# the BASE COMMIT (where the defect is present) and against the delivered
# tree (where it is fixed). The probe is copied unchanged into the base
# tree, so the two runs differ only in the code under test.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1
EV=docs/evidence/ATS-206
mkdir -p "$EV"

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

BASE_SHA=3a9d1e302556bd4bdca34764e575a6a33b3c1d2a

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

# --- 01: the defect BEFORE the fix (the base commit) -----------------------
TMP="${TMPDIR:-/tmp}/ats206-base"
rm -rf "$TMP"
mkdir -p "$TMP"
git archive "$BASE_SHA" | tar -x -C "$TMP"
# The probe is copied UNCHANGED into the base tree: the two runs differ only
# in the code under test, not in the measurement.
mkdir -p "$TMP/tools/ats206-probes"
cp tools/ats206-probes/defect-probe.mjs "$TMP/tools/ats206-probes/defect-probe.mjs"
{
  echo "=== the ATS-206 defect probe -- BEFORE the fix ==="
  echo "repo root : $TMP"
  echo "base commit: $BASE_SHA"
  echo "node      : $(node --version)"
  echo
  echo "This is the ATS-201 migration as it was on the base commit: the state"
  echo "is rebuilt from a fixed set of keys, so a key the migration does not"
  echo "know about is dropped, and a map that is keyed by the project"
  echo "identifier is not re-keyed."
  echo
  (cd "$TMP" && node tools/ats206-probes/defect-probe.mjs) 2>&1
  echo
  echo "exit code : $?"
} > "$EV/01-defect-repro.log"
echo "wrote $EV/01-defect-repro.log"

# --- 02: the defect AFTER the fix ------------------------------------------
run 02-defect-fixed.log "the ATS-206 defect probe -- AFTER the fix" \
  node tools/ats206-probes/defect-probe.mjs

# --- 03: the ATS-206 test suite ---------------------------------------------
run 03-migrate-state-ut.log "the ATS-206 test suite" \
  node --test tests/migrate-state.test.mjs

# --- 04: the ATS-201 regression suite ---------------------------------------
run 04-migrate-regressions.log "the ATS-201 migration regression suite" \
  node --test tests/migrate.test.mjs tests/migrate-regressions.test.mjs

# --- 05: the full test suite ------------------------------------------------
run 05-node-test-full.log "the full node test suite" npm test

# --- 06: the CLI round trip -------------------------------------------------
run 06-cli-roundtrip.log "the CLI round trip: plan / apply / verify / rollback" \
  node tools/ats206-probes/cli-roundtrip.mjs

# --- 07: the coverage of the new modules ------------------------------------
{
  echo "=== the coverage of the ATS-206 modules ==="
  echo "repo root : $(pwd)"
  echo "commit    : $(git rev-parse --short HEAD)"
  echo
  node --test --experimental-test-coverage \
    --test-coverage-include='server/migration/**' \
    --test-coverage-include='tools/migrate_state.mjs' \
    --test-coverage-include='tools/migrate_uids.mjs' \
    tests/*.test.mjs 2>&1
} > "$EV/07-coverage.log"
echo "wrote $EV/07-coverage.log"

# --- 08: the WBS row of this task -------------------------------------------
run 08-wbs-row.log "the ATS-206 row of docs/WBS.xlsx" \
  python tools/update_wbs_ats206.py

# --- 09: the WBS updater interaction regression -----------------------------
run 09-wbs-updaters.log "the WBS updater interaction regression (13 updaters)" \
  bash tools/ats501-probes/check-wbs-updaters.sh

# --- 10: the python gates ----------------------------------------------------
run 10-python-gates.log "the python gates under tools/" \
  python -m pytest tools/ -q
{
  echo
  echo "=== NOTE ==="
  echo "test_tc002_ats506_marker_and_narrative fails on this tree, and it is"
  echo "PRE-EXISTING: it fails identically on the base commit $BASE_SHA"
  echo "(git archive $BASE_SHA -> pytest tools/test_wbs_common_helpers.py -q -> 1 failed, 6 passed)."
  echo "It is an ATS-506/ATS-512 marker-ordering assertion over"
  echo "tools/wbs_common.py MARKERS, unrelated to the ATS-206 migration, and"
  echo "NOT introduced by this branch."
} >> "$EV/10-python-gates.log"

# --- 11: the round-3 review probe ---------------------------------------------
# The four counterexamples of the round-3 rework (CE7, CE8, CE9, CE10),
# against the tree that is delivered.
run 11-review-round3-probe.log "the round-3 review probe (CE7 / CE8 / CE9 / CE10)" \
  node tools/ats206-probes/ce206r3.mjs . "${TMPDIR:-/tmp}/ats206-r3-scratch"

# --- 12: the round-4 review probe ---------------------------------------------
# The two recovery branches that refuse (a rename that throws, a journal that
# claims "state" over an unmigrated state file) and the stale lock that a
# REAL kill leaves behind.
run 12-review-round4-probe.log "the round-4 review probe (the refusal branches + a real SIGKILL)" \
  node tools/ats206-probes/ce206r4.mjs . "${TMPDIR:-/tmp}/ats206-r4-scratch"

# --- 13: the ADR citation check ----------------------------------------------
run 13-adr-citations.log "the ADR citation check" \
  python tools/check_adr_citations.py

echo "done"
