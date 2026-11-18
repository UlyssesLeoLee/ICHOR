#!/usr/bin/env bash
# ATS-308: collect the reproducible evidence of the design material import.
#
# The evidence is the OUTPUT of the commands, not a description of them.
# Every log under docs/evidence/ATS-308/ is what one of these commands
# actually printed on the machine that produced the delivery.
#
# Every log states the COMMIT it describes, so a reader can tell which tree
# produced it. Without that, a log is a number with no tree attached, and a
# number without its tree goes stale the moment another ticket touches
# docs/ -- which is exactly what happened to the first ATS-308 collection:
# the probe log measured 1058 resolved references on one tree, the tree grew,
# and the design document kept quoting 1058.
#
# The steps:
#   1. the unit tests of the importer
#   2. the integration tests (the REAL Bridge over HTTP)
#   3. the mutation negative control (7 mutations, 7 catches)
#   4. the probe over the REAL design baseline
#   5. the ATS-301 gate (the WBS helper, the ADR citations, the port audit)
#   6. the WBS updater, and the idempotence of it
#   7. what the documents claim, CHECKED against the committed logs
#
# Step 7 is the step that keeps steps 1-6 honest. The design document and
# the evidence README quote the measured figures; those quotes are checked
# against the logs, and a mismatch FAILS the collection. A number typed in
# prose is a number that can disagree with the thing it describes.
#
# Usage: bash tools/ats308-probes/collect-evidence.sh
set -u

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

EVIDENCE="$ROOT/docs/evidence/ATS-308"
mkdir -p "$EVIDENCE"

COMMIT="$(git rev-parse HEAD)"
NODE="$(node --version)"
PLATFORM="$(node -p 'process.platform + " " + process.arch')"

fail=0
step() {
  printf '\n=== %s ===\n' "$1"
}

# The header every log carries: WHICH TREE produced this output.
header() {
  echo "=============================================================================="
  echo "ATS-308 evidence log -- $1"
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

# --- 1. the unit tests -------------------------------------------------------
step '1. the unit tests of the importer'
{
  header "the ATS-308 unit suite" "node --test tests/ats308-import.test.mjs"
  node --test tests/ats308-import.test.mjs 2>&1
} | tee "$EVIDENCE/01-node-test-import-ut.log"
if [ "${PIPESTATUS[0]}" -eq 0 ]; then
  printf 'PASS  the unit tests\n'
else
  printf 'FAIL  the unit tests\n'
  fail=1
fi

# --- 2. the integration tests ------------------------------------------------
step '2. the integration tests (the real Bridge over HTTP)'
{
  header "the ATS-308 integration suite" "node --test tests/ats308-import-it.test.mjs"
  node --test tests/ats308-import-it.test.mjs 2>&1
} | tee "$EVIDENCE/02-node-test-import-it.log"
if [ "${PIPESTATUS[0]}" -eq 0 ]; then
  printf 'PASS  the integration tests\n'
else
  printf 'FAIL  the integration tests\n'
  fail=1
fi

# --- 3. the mutation negative control ----------------------------------------
step '3. the mutation negative control (7 mutations)'
{
  header "the ATS-308 negative control" "node --test tests/ats308-import-mutation.test.mjs"
  node --test tests/ats308-import-mutation.test.mjs 2>&1
} | tee "$EVIDENCE/03-node-test-import-mutation.log"
if [ "${PIPESTATUS[0]}" -eq 0 ]; then
  printf 'PASS  the negative control\n'
else
  printf 'FAIL  the negative control\n'
  fail=1
fi

# --- 4. the probe over the real design baseline ------------------------------
# The probe excludes the ticket's OWN documents by default (the design
# document and this evidence index), so the baseline the figures describe
# does not move when this ticket edits its own text.
step '4. the probe over the real design baseline'
{
  header "the ATS-308 probe over the real baseline" \
    "node tools/ats308-probes/probe-design-import.mjs"
  node tools/ats308-probes/probe-design-import.mjs 2>&1
} | tee "$EVIDENCE/04-probe-design-import.log"
if [ "${PIPESTATUS[0]}" -eq 0 ]; then
  printf 'PASS  the probe\n'
else
  printf 'FAIL  the probe\n'
  fail=1
fi

# --- 5. the ATS-301 gate ------------------------------------------------------
step '5. the ATS-301 gate (the WBS helper, the ADR citations, the port audit)'
{
  header "the ATS-301 gate" "bash tools/ats301-probes/check-ats301-gate.sh"
  bash tools/ats301-probes/check-ats301-gate.sh 2>&1 \
    | grep -vE 'UserWarning|warn\(msg\)'
} | tee "$EVIDENCE/05-ats301-gate.log"
if [ "${PIPESTATUS[0]}" -eq 0 ]; then
  printf 'PASS  the ATS-301 gate\n'
else
  printf 'FAIL  the ATS-301 gate\n'
  fail=1
fi

# --- 6. the WBS updater, and its idempotence ----------------------------------
step '6. the WBS updater and its idempotence'
{
  header "the WBS updater and its idempotence" \
    "python tools/update_wbs_ats308.py && python tools/ats501-probes/show-wbs-row.py ATS-308"
  printf '$ python tools/update_wbs_ats308.py\n'
  python tools/update_wbs_ats308.py
  printf '\n$ python tools/update_wbs_ats308.py   # again -- the row must not change\n'
  python tools/update_wbs_ats308.py
  printf '\n$ python tools/ats501-probes/show-wbs-row.py ATS-308\n'
  python tools/ats501-probes/show-wbs-row.py ATS-308
} 2>&1 | tee "$EVIDENCE/06-wbs-update.log"
# The updater leaves a recovery copy behind; it is a local artefact, not a
# deliverable (the .gitignore says so).
rm -f "$ROOT/docs/WBS.xlsx.bak"

# --- 7. what the documents claim, checked against the logs --------------------
step '7. what the documents claim, checked against the committed logs'
{
  header "the ATS-308 document/log consistency check" \
    "node tools/ats308-probes/check-doc-consistency.mjs"
  node tools/ats308-probes/check-doc-consistency.mjs 2>&1
} | tee "$EVIDENCE/07-doc-consistency.log"
if [ "${PIPESTATUS[0]}" -eq 0 ]; then
  printf 'PASS  the document/log consistency check\n'
else
  printf 'FAIL  the document/log consistency check\n'
  fail=1
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf 'RESULT: OK -- every step of the ATS-308 evidence collection passed.\n'
else
  printf 'RESULT: MISMATCH -- at least one step failed.\n'
fi
exit "$fail"
