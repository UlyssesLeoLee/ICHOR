#!/usr/bin/env bash
# ATS-202: collect the evidence of this delivery into docs/evidence/ATS-202/.
#
# Every command below is run against the CURRENT tree and its output is
# captured verbatim. The script is the reproduction script for the evidence:
# re-running it re-collects the logs.
#
# Usage: bash tools/ats202-probes/collect-evidence.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
# The numpy/OpenBLAS runtime allocates a thread pool per process; on a busy
# machine the allocation fails and every Python invocation dies with
# "OpenBLAS error: Memory allocation still failed". One thread avoids it.
export OPENBLAS_NUM_THREADS=1

OUT="docs/evidence/ATS-202"
mkdir -p "$OUT"

run() {
  # run <log-name> <command...>
  local name="$1"; shift
  {
    echo "=== command ==="
    printf '%s\n' "$*"
    echo "=== output ==="
    "$@" 2>&1
    echo "=== exit code: $? ==="
  } > "$OUT/$name" 2>&1
  echo "  wrote $OUT/$name"
}

echo '--- 1. the ground truth of playwright test --list (the real CLI) ---'
run 01-list-ground-truth.log node tools/ats202-probes/list-ground-truth.mjs

echo '--- 2. the unit tests of the discovery ---'
run 02-discovery-ut.log node --test tests/discovery.test.mjs

echo '--- 3. the integration tests against the real Playwright ---'
run 03-discovery-it.log node --test tests/discovery-it.test.mjs

echo '--- 4. the API surface of the authoritative discovery ---'
run 04-discovery-api.log node --test tests/discovery-api.test.mjs

echo '--- 5. the full Node test suite ---'
run 05-node-test-full.log node --test tests/*.test.mjs

echo '--- 6. the line coverage of the discovery modules ---'
run 06-line-coverage.log node --test --experimental-test-coverage tests/discovery.test.mjs tests/discovery-it.test.mjs tests/discovery-api.test.mjs

echo '--- 7. the WBS updater: the XML escaping and the idempotency ---'
run 07-wbs-updater.log python tools/update_wbs_ats202.py

echo '--- 8. the marked-cell merge regression ---'
run 08-wbs-common-regression.log python tools/test_wbs_common.py

echo ''
echo 'evidence written to docs/evidence/ATS-202/'
