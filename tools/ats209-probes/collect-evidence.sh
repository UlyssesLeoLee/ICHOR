#!/usr/bin/env bash
# ATS-209 -- collect the evidence of the evidence subsystem.
#
# The evidence of this task is the set of facts the acceptance criteria
# name, each measured against the tree that is actually delivered:
#
#   1. "篡改可检测" -- a file that is changed after the run was archived is
#      DETECTED, and the answer names the file and the two digests.
#   2. "保留期到期可清理且不误删 Run 元数据" -- the cleaning removes the
#      expired evidence and the RUN RECORD (status, summary, attempts,
#      events) survives it, field for field.
#   3. The deduplication stores the SAME bytes ONCE.
#
# The script runs the ATS-209 suites, the probes and the gates, and writes
# the output under docs/evidence/ATS-209/.
#
# usage: bash tools/ats209-probes/collect-evidence.sh [tree]
set -uo pipefail

# The tree to measure. The path is resolved to an ABSOLUTE one first: the
# script `cd`s around, and a relative path would then resolve against the
# wrong directory.
#
# `pwd -W` gives the Windows form of the current directory (the native
# programs on this platform need it); the plain `pwd` is the fallback for a
# shell that does not have it.
TREE="${1:-.}"
if [ -d "$TREE" ]; then
  TREE="$(cd "$TREE" && pwd)"
fi
case "$TREE" in
  [A-Za-z]:*) NATIVE_TREE="$TREE" ;;
  *) NATIVE_TREE="$(cd "$TREE" && pwd -W 2>/dev/null || echo "$TREE")" ;;
esac
cd "$TREE" || exit 1

OUT="docs/evidence/ATS-209"
mkdir -p "$OUT"

hdr() {
  echo
  echo "=============================================================="
  echo "$*"
  echo "=============================================================="
}

hdr "the tree under test"
echo "tree    : $NATIVE_TREE"
echo "commit  : $(git rev-parse HEAD)"
echo "branch  : $(git branch --show-current)"
echo "node    : $(node --version)"
echo "python  : $(python --version 2>&1)"

# Every step writes its own log into $OUT, so the evidence of the delivery
# is IN the repository and can be read without re-running anything.
run_step() { # run_step <log name> <label> <command...>
  local name="$1"; shift
  local label="$1"; shift
  hdr "$label"
  {
    echo "=== $label ==="
    echo "tree   : $NATIVE_TREE"
    echo "commit : $(git rev-parse HEAD)"
    echo
    "$@" 2>&1
    echo
    echo "exit code : $?"
  } | tee "$OUT/$name"
  return 0
}

run_step 01-node-test-evidence-ut.log "the ATS-209 unit suite" \
  node --test tests/evidence.test.mjs

run_step 02-node-test-evidence-it.log "the ATS-209 integration suite" \
  node --test tests/evidence-it.test.mjs

run_step 02b-node-test-evidence-cli.log "the ATS-209 CLI suite" \
  node --test tests/evidence-cli.test.mjs

run_step 03-probe-evidence.log "the ATS-209 probe" \
  node tools/ats209-probes/probe-evidence.mjs

run_step 04-port-audit.log "the ATS-101 port audit" \
  node tools/ats101-probes/scenario-d-port-audit.mjs

run_step 05-adr-citations.log "the ADR citation check" \
  python tools/check_adr_citations.py

run_step 06-python-gates.log "the python gates under tools/" \
  python -m pytest tools/ -q

run_step 07-node-test-full.log "the full node test suite" \
  npm test

run_step 08-coverage.log "the line coverage of the ATS-209 modules" \
  node --test --experimental-test-coverage tests/evidence.test.mjs tests/evidence-it.test.mjs tests/evidence-cli.test.mjs

run_step 09-review-probe.log "the round 1 review probe against this tree" \
  node "$TREE/tools/ats209-probes/ats209-r1-probe.mjs" "$TREE" "$TMPDIR/ats209-r1-probe"

hdr "done"
echo "the evidence of this run is in $OUT/"
ls -la "$OUT"
