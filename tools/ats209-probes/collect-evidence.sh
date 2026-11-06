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

TREE="${1:-.}"
TREE="$(cd "$TREE" && pwd -W 2>/dev/null || cd "$TREE" && pwd)"
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
echo "tree    : $TREE"
echo "commit  : $(git rev-parse HEAD)"
echo "branch  : $(git branch --show-current)"
echo "node    : $(node --version)"
echo "python  : $(python --version 2>&1)"

# --- 1. the ATS-209 unit and integration suites ---------------------------
hdr "the ATS-209 unit suite"
node --test tests/evidence.test.mjs 2>&1 | tail -12

hdr "the ATS-209 integration suite"
node --test tests/evidence-it.test.mjs 2>&1 | tail -14

# --- 2. the probe: the two acceptance criteria, measured ------------------
hdr "the ATS-209 probe"
node tools/ats209-probes/probe-evidence.mjs 2>&1
echo "probe exit code : $?"

# --- 3. the gates ----------------------------------------------------------
hdr "the ATS-101 port audit"
node tools/ats101-probes/scenario-d-port-audit.mjs 2>&1 | tail -14

hdr "the ADR citation check"
python tools/check_adr_citations.py 2>&1 | tail -6

hdr "the python gates under tools/"
python -m pytest tools/ -q 2>&1 | tail -4

# --- 4. the full regression ------------------------------------------------
hdr "the full node test suite"
npm test 2>&1 | tail -10

hdr "done"
echo "the evidence of this run is in $OUT/"
