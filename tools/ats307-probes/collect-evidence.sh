#!/usr/bin/env bash
# ATS-307: collect the evidence of the traceability graph.
#
# Every step is re-runnable and writes ONE log into docs/evidence/ATS-307/.
# The logs state the commit they describe, so a reader can tell which tree
# produced them.
#
# Usage: bash tools/ats307-probes/collect-evidence.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/docs/evidence/ATS-307"
cd "$ROOT"
mkdir -p "$OUT"

COMMIT="$(git rev-parse HEAD)"
NODE="$(node --version)"
PLATFORM="$(node -p 'process.platform + " " + process.arch')"

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

# --- 1. the unit suite ------------------------------------------------
{
  header "the ATS-307 unit suite" "node --test tests/ats307-traceability.test.mjs"
  node --test tests/ats307-traceability.test.mjs 2>&1
  echo
  echo "--- the summary the reporter printed ---"
  node --test tests/ats307-traceability.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail|skipped)'
} > "$OUT/01-node-test-traceability-ut.log" 2>&1
echo "01 -> $OUT/01-node-test-traceability-ut.log"

# --- 2. the integration suite -----------------------------------------
{
  header "the ATS-307 integration suite" "node --test tests/ats307-traceability-it.test.mjs"
  node --test tests/ats307-traceability-it.test.mjs 2>&1
} > "$OUT/02-node-test-traceability-it.log" 2>&1
echo "02 -> $OUT/02-node-test-traceability-it.log"

# --- 3. the probe: the graph of this repository -----------------------
{
  header "the ATS-307 probe" "node tools/ats307-probes/probe-traceability.mjs"
  node tools/ats307-probes/probe-traceability.mjs 2>&1
} > "$OUT/03-probe-traceability.log" 2>&1
echo "03 -> $OUT/03-probe-traceability.log"

# --- 4. the API surface over HTTP -------------------------------------
{
  header "the ATS-307 API surface" "node tools/ats307-probes/probe-api.mjs"
  node tools/ats307-probes/probe-api.mjs 2>&1
} > "$OUT/04-api-traceability.log" 2>&1
echo "04 -> $OUT/04-api-traceability.log"

# --- 5. the negative control: the checks CAN fail ----------------------
{
  header "the ATS-307 negative control" "node tools/ats307-probes/probe-negative-control.mjs"
  node tools/ats307-probes/probe-negative-control.mjs 2>&1
} > "$OUT/05-negative-control.log" 2>&1
echo "05 -> $OUT/05-negative-control.log"

# --- 6. the full repository regression ---------------------------------
#
# The FULL output is kept. A previous version piped it through `tail -120`,
# which cut off exactly the part a reader needs: the per-test lines that
# say WHICH tests were skipped and WHY. A truncated log cannot answer
# "what did not run?".
{
  header "the full repository regression" "node --test --test-concurrency=2 tests/*.test.mjs"
  node --test --test-concurrency=2 tests/*.test.mjs 2>&1
} > "$OUT/06-node-test-full.log" 2>&1
echo "06 -> $OUT/06-node-test-full.log"

# --- 7. the syntax gate ------------------------------------------------
{
  header "the syntax gate" "node --check on the changed sources"
  for f in server/index.mjs server/traceability/model.mjs server/traceability/builder.mjs server/traceability/query.mjs tests/ats307-traceability.test.mjs tests/ats307-traceability-it.test.mjs tools/ats307-probes/probe-traceability.mjs; do
    if node --check "$f"; then echo "ok    $f"; else echo "FAIL  $f"; fi
  done
} > "$OUT/07-syntax-gate.log" 2>&1
echo "07 -> $OUT/07-syntax-gate.log"

# --- 8. the skipped tests, one by one -----------------------------------
#
# `node --test` reports a COUNT of the skipped tests (`skipped 32`), but
# not WHICH ones or WHY. A count is not an inventory: a reader cannot tell
# what did not run from it. This step re-runs the suite with the TAP
# reporter, which prints the reason on the skipped line, and lists every
# one of them.
#
# The reason is the POINT of the list: a skipped test is not a pass, and
# the reader has to see WHY it did not run (no device, no installed
# fixture, no real credential store).
{
  header "the skipped tests, one by one" "node tools/ats307-probes/collect-skipped.mjs"
  node tools/ats307-probes/collect-skipped.mjs 2>&1
} > "$OUT/08-skipped-reasons.log" 2>&1
echo "08 -> $OUT/08-skipped-reasons.log"

echo
echo "all steps finished; the logs are in $OUT"

# --- 9. the attribution of a host-effect failure ----------------------
#
# The full regression (step 6) runs 1900+ cases in one process tree. Under
# host load a case that holds a socket can lose it, so the same tree can
# report 0 failures on one run and 1 on the next. A reader who re-runs the
# suite on a loaded host must be able to see that the failure is a
# property of the HOST, not of this delivery.
#
# The attribution re-runs the file on its own, on this branch and on the
# PINNED base tree, and shows the diff for that file (empty = this task
# did not touch it).
# The attribution script OWNS its log file, so the collector does not
# redirect into the same path.
bash tools/ats307-probes/collect-flaky-attribution.sh 2>&1
echo "9 -> $OUT/10-suite-flaky-attribution.log"

# --- 10. what the README claims, checked against the logs ---------------
#
# The README says how many steps the collection has and how many cases the
# suites hold. Those numbers used to be TYPED in the README, and they went
# stale: the collector ran eight steps and the README said seven; the suite
# grew and the README kept the old case count.
#
# The check is a STANDALONE script, so running it alone and running it
# inside the whole collection cannot drift apart. The collection calls it.
{
  header "what the README claims, checked against the logs" "node tools/ats307-probes/check-readme-consistency.mjs"
  node tools/ats307-probes/check-readme-consistency.mjs 2>&1
} > "$OUT/09-readme-consistency.log" 2>&1
echo "10 -> $OUT/09-readme-consistency.log"
