#!/usr/bin/env bash
# ATS-201: collect the evidence of this delivery into docs/evidence/ATS-201/.
#
# Every command below is run against the CURRENT tree and its output is
# captured verbatim. The script is the reproduction script for the evidence:
# re-running it re-collects the logs.
#
# Usage: bash tools/ats201-probes/collect-evidence.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
# The numpy/OpenBLAS runtime allocates a thread pool per process; on a busy
# machine the allocation fails and every Python invocation dies with
# "OpenBLAS error: Memory allocation still failed". One thread avoids it.
export OPENBLAS_NUM_THREADS=1

OUT="docs/evidence/ATS-201"
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

echo '--- 1. the full Node test suite ---'
run 08-node-test-full.log node --test tests/*.test.mjs

echo '--- 2. the line coverage of the UID modules ---'
run 09-line-coverage.log node --test --experimental-test-coverage tests/*.test.mjs

echo '--- 3. the counterexamples of the first review ---'
run 10-review-regressions.log node tools/ats201-probes/review-regressions.mjs

echo '--- 4. the real Playwright binding contract ---'
run 11-real-playwright-contract.log node tools/ats201-probes/attempt-binding-real-pw.mjs

echo '--- 5. the real Playwright flaky attempt status ---'
run 12-real-playwright-flaky-status.log node tools/ats201-probes/flaky-attempt-status-real-pw.mjs

echo '--- 6. the end-to-end UID flow ---'
run 13-uid-e2e.log node tools/ats201-probes/uid-e2e.mjs

echo '--- 7. the migration sequence collision ---'
run 14-migration-seq-collision.log node tools/ats201-probes/migration-seq-collision.mjs

echo '--- 8. the migration evidence ---'
run 15-migration-evidence.log node tools/ats201-probes/migration-evidence.mjs

echo '--- 9. the API surface ---'
run 16-api-surface.log node tools/ats201-probes/api-surface.mjs

echo '--- 10. the ATS-101 port audit (the baseline line numbers) ---'
run 17-port-audit.log node tools/ats101-probes/scenario-d-port-audit.mjs

echo '--- 11. the WBS updater: the XML escaping and the idempotency ---'
run 18-wbs-updater.log python tools/update_wbs_ats201.py

echo '--- 12. the WBS updaters coexist ---'
run 19-wbs-updaters-coexist.log bash tools/ats501-probes/check-wbs-updaters.sh

echo '--- 13. the marked-cell merge regression ---'
run 20-wbs-common-regression.log python tools/test_wbs_common.py

echo '--- 14. the counterexamples of the second review ---'
# The three counterexamples of the second review (CE7 / CE8 / L1) live in the
# review comment, not in the repository. They are reproduced by the script
# below, which the reviewer attached to comment
# 01a1ac07-70e8-7c89-afd4-2b52d85cd5f3.
run 21-review-round2-regressions.log node tools/ats201-probes/review-round2-regressions.mjs

echo ''
echo 'evidence written to docs/evidence/ATS-201/'
