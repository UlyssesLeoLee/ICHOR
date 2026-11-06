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

# --- 9-11: the round-1 review findings -----------------------------------------
#
# The reviewer's own probes are kept in the repository so that the finding
# stays reproducible: they drive the product's own discoverTests() against
# the REAL Playwright CLI and print EXPECTED vs ACTUAL per counterexample.
#
# The probes need a node_modules that holds @playwright/test 1.64.1. The
# sample project of this repository has one; when it is absent the probe is
# SKIPPED and says so -- never reported as a pass.
PW_NM="$ROOT/examples/sample-playwright/node_modules"
# The probes resolve the tree themselves, so only the node_modules path is
# passed. It has to be a NATIVE path: on an MSYS shell $ROOT is a /c/...
# path, and Node would read it as "C:\\c\\Users\\...".
case "$PW_NM" in
  /*) PW_NM="$(cd "$PW_NM" 2>/dev/null && pwd -W 2>/dev/null || echo "$PW_NM")" ;;
esac
if [ -d "$PW_NM/@playwright/test" ]; then
  echo '--- 9. the round-1 counterexample probe (the real Playwright CLI) ---'
  run 09-review-round1-probe.log node tools/ats202-probes/review-round1-probe.mjs "$PW_NM"
else
  echo '--- 9. the round-1 counterexample probe: SKIPPED (no @playwright/test) ---'
  {
    echo "=== command ==="
    echo "node tools/ats202-probes/review-round1-probe.mjs <tree> <node_modules>"
    echo "=== output ==="
    echo "SKIPPED: examples/sample-playwright/node_modules/@playwright/test is not installed;"
    echo "the probe needs the real Playwright CLI to enumerate the cases."
    echo "=== exit code: 2 ==="
  } > "$OUT/09-review-round1-probe.log"
  echo "  wrote $OUT/09-review-round1-probe.log (skipped)"
fi

if [ -d "$PW_NM/@playwright/test" ]; then
  echo '--- 9b. the listing must not block the Bridge (the review finding) ---'
  run 09b-review-round1-http-probe.log node tools/ats202-probes/review-round1-http-probe.mjs "$PW_NM"
else
  {
    echo "=== command ==="
    echo "node tools/ats202-probes/review-round1-http-probe.mjs <node_modules>"
    echo "=== output ==="
    echo "SKIPPED: examples/sample-playwright/node_modules/@playwright/test is not installed."
    echo "=== exit code: 2 ==="
  } > "$OUT/09b-review-round1-http-probe.log"
  echo "  wrote $OUT/09b-review-round1-http-probe.log (skipped)"
fi

echo '--- 10. the ATS-101 port audit (the gate the review found broken) ---'
run 10-port-audit.log node tools/ats101-probes/scenario-d-port-audit.mjs

echo '--- 11. the ADR citation check (the gate the review found broken) ---'
run 11-adr-citations.log python tools/check_adr_citations.py

# --- 12-16: the round-2 review findings ---------------------------------------
#
# The round-2 reviewer brought four probes of its own. They are kept in the
# repository so that the findings stay reproducible: they drive the product's
# own discoverTests() (or the real Bridge) against the REAL Playwright CLI and
# print EXPECTED vs ACTUAL per counterexample.
#
# The probes need a node_modules that holds @playwright/test 1.64.1. The
# sample project of this repository has one; when it is absent the probes are
# SKIPPED and say so -- never reported as a pass.
#
# The PROBE FIXTURE is a directory that holds a node_modules with
# @playwright/test. It defaults to the sample project and can be pointed
# elsewhere with ATS202_PW_NODE_MODULES.
PW_NM2="${ATS202_PW_NODE_MODULES:-$ROOT/examples/sample-playwright/node_modules}"
case "$PW_NM2" in
  /*) PW_NM2="$(cd "$PW_NM2" 2>/dev/null && pwd -W 2>/dev/null || echo "$PW_NM2")" ;;
esac
R2="$ROOT/tools/ats202-probes/r2"
SCRATCH="${ATS202_SCRATCH:-$(mktemp -d)}"

if [ -d "$PW_NM2/@playwright/test" ]; then
  echo '--- 12. N1: an awaited listing must not erase another project''s registry entries ---'
  run 12-r2-race.log node "$R2/r2-race.mjs" "$ROOT" "$PW_NM2" "$SCRATCH"

  echo '--- 13. N3: a case the CLI enumerates never lands in onlyStatic ---'
  run 13-r2-scope.log node "$R2/r2-scope.mjs" "$ROOT" "$PW_NM2" "$SCRATCH"

  echo '--- 14. the async listing path: the timeout kills the child ---'
  run 14-r2-async.log node "$R2/r2-async.mjs" "$ROOT" "$PW_NM2" "$SCRATCH"

  echo '--- 15. N4: the scanner fix moves the UID of an escaped-quote title once ---'
  # The OLD tree is the one BEFORE the scanner fix (cc68331). It is exported
  # with `git archive`, so the comparison runs on a clean LF tree.
  OLD_TREE="${ATS202_OLD_TREE:-$SCRATCH/ats202-round0-tree}"
  rm -rf "$OLD_TREE"; mkdir -p "$OLD_TREE"
  if git -C "$ROOT" archive cc68331 2>/dev/null | tar -x -C "$OLD_TREE"; then
    run 15-r2-upgrade.log node "$R2/r2-upgrade.mjs" "$OLD_TREE" "$ROOT" "$SCRATCH"
  else
    {
      echo "=== command ==="
      echo "node $R2/r2-upgrade.mjs <old-tree> <new-tree> <scratch>"
      echo "=== output ==="
      echo "SKIPPED: the commit cc68331 is not in this clone."
      echo "=== exit code: 2 ==="
    } > "$OUT/15-r2-upgrade.log"
    echo "  wrote $OUT/15-r2-upgrade.log (skipped)"
  fi
else
  for name in 12-r2-race 13-r2-scope 14-r2-async 15-r2-upgrade; do
    {
      echo "=== command ==="
      echo "node tools/ats202-probes/r2/<probe>.mjs <tree> <node_modules> <scratch>"
      echo "=== output ==="
      echo "SKIPPED: $PW_NM2/@playwright/test is not installed;"
      echo "the probes need the real Playwright CLI to enumerate the cases."
      echo "=== exit code: 2 ==="
    } > "$OUT/$name.log"
    echo "  wrote $OUT/$name.log (skipped)"
  done
fi

echo '--- 16. the ASYNC listing path has its own tests (N2) ---'
run 16-discovery-async-ut.log node --test tests/discovery-async.test.mjs

echo ''
echo 'evidence written to docs/evidence/ATS-202/'
