#!/usr/bin/env bash
# ATS-204: collect the evidence of this delivery into docs/evidence/ATS-204/.
#
# Every command below is run against the CURRENT tree and its output is
# captured verbatim. The script is the reproduction script for the evidence:
# re-running it re-collects the logs.
#
# Usage: bash tools/ats204-probes/collect-evidence.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
# The numpy/OpenBLAS runtime allocates a thread pool per process; on a busy
# machine the allocation fails and every Python invocation dies with
# "OpenBLAS error: Memory allocation still failed". One thread avoids it.
export OPENBLAS_NUM_THREADS=1

OUT="docs/evidence/ATS-204"
mkdir -p "$OUT"

run() {
  # run <log-name> <command...>
  local name="$1"; shift
  {
    echo "=== command ==="
    printf '%s\n' "$*"
    echo "=== output ==="
    "$@"
    echo "=== exit code: $? ==="
  } > "$OUT/$name" 2>&1
  echo "  wrote $OUT/$name"
}

echo '--- 0. the tree this evidence was collected on ---'
run 00-tree.log bash -c "git log --oneline -5; echo; git status --short"

echo '--- 1. the unit tests of the identity mapper ---'
run 01-identity-ut.log node --test tests/identity.test.mjs

echo '--- 2. the UID and discovery suites ---'
run 02-uid-discovery-ut.log node --test tests/uid.test.mjs tests/uid-regressions.test.mjs tests/uid-lexer.test.mjs tests/discovery.test.mjs tests/discovery-regressions.test.mjs

echo '--- 3. the execution model suite (the matrix) ---'
run 03-execution-model-ut.log node --test tests/execution-model.test.mjs tests/execution-model-it.test.mjs

echo '--- 4. the full Node test suite ---'
run 04-node-test-full.log node --test tests/*.test.mjs

echo '--- 5. the gaps the task closed (measured on the tree BEFORE the task) ---'
run 05-probe-gaps.log node tools/ats204-probes/probe-gaps.mjs

echo '--- 6. the anchor: a dynamic case keeps its uid when the template is re-worded ---'
run 06-probe-anchor.log node tools/ats204-probes/probe-anchor.mjs

echo '--- 7. the matrix: the two report shapes give the same answer ---'
run 07-probe-matrix.log node tools/ats204-probes/probe-matrix.mjs

echo '--- 8. the facts of the real Playwright CLI ---'
run 08-cli-facts.log node tools/ats204-probes/cli-facts.mjs

echo '--- 9. the ADR citation gate ---'
run 09-adr-citations.log python tools/check_adr_citations.py

echo '--- 10. the ATS-101 port audit ---'
run 10-port-audit.log node tools/ats101-probes/scenario-d-port-audit.mjs

echo '--- 11. the WBS row of this task ---'
run 11-wbs-row.log python tools/update_wbs_ats204.py --verify-only

echo '--- 12. the counterexample: the same tests on the tree BEFORE the task ---'
# The tree the work started from (83c8bc5). The identity mapper is copied in,
# so that the test file loads -- the point is to show which ASSERTIONS fail
# when the WIRING of the task is absent.
run 12-counterexample.log bash tools/ats204-probes/counterexample.sh

echo
echo "evidence collected into $OUT"
