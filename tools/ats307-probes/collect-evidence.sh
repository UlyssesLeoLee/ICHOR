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
{
  header "the full repository regression" "node --test --test-concurrency=2 tests/*.test.mjs"
  node --test --test-concurrency=2 tests/*.test.mjs 2>&1 | tail -120
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

echo
echo "all steps finished; the logs are in $OUT"
