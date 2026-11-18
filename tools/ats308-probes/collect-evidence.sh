#!/usr/bin/env bash
# ATS-308: collect the reproducible evidence of the design material import.
#
# The evidence is the OUTPUT of the commands, not a description of them.
# Every log under docs/evidence/ATS-308/ is what one of these commands
# actually printed on the machine that produced the delivery.
#
# The steps:
#   1. the unit tests of the importer
#   2. the integration tests (the REAL Bridge over HTTP)
#   3. the mutation negative control (7 mutations, 7 catches)
#   4. the probe over the REAL design baseline
#   5. the ATS-301 gate (the WBS helper, the ADR citations, the port audit)
#   6. the WBS updater, and the idempotence of it
#
# Usage: bash tools/ats308-probes/collect-evidence.sh
set -u

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

EVIDENCE="$ROOT/docs/evidence/ATS-308"
mkdir -p "$EVIDENCE"

fail=0
step() {
  printf '\n=== %s ===\n' "$1"
}

# --- 1. the unit tests -------------------------------------------------------
step '1. the unit tests of the importer'
if node --test tests/ats308-import.test.mjs 2>&1 | tee "$EVIDENCE/01-node-test-import-ut.log"; then
  printf 'PASS  the unit tests\n'
else
  printf 'FAIL  the unit tests\n'
  fail=1
fi

# --- 2. the integration tests ------------------------------------------------
step '2. the integration tests (the real Bridge over HTTP)'
if node --test tests/ats308-import-it.test.mjs 2>&1 | tee "$EVIDENCE/02-node-test-import-it.log"; then
  printf 'PASS  the integration tests\n'
else
  printf 'FAIL  the integration tests\n'
  fail=1
fi

# --- 3. the mutation negative control ----------------------------------------
step '3. the mutation negative control (7 mutations)'
if node --test tests/ats308-import-mutation.test.mjs 2>&1 | tee "$EVIDENCE/03-node-test-import-mutation.log"; then
  printf 'PASS  the negative control\n'
else
  printf 'FAIL  the negative control\n'
  fail=1
fi

# --- 4. the probe over the real design baseline -------------------------------
step '4. the probe over the real design baseline'
if node tools/ats308-probes/probe-design-import.mjs --exclude docs/35-DESIGN-IMPORT.md 2>&1 \
    | tee "$EVIDENCE/04-probe-design-import.log"; then
  printf 'PASS  the probe\n'
else
  printf 'FAIL  the probe\n'
  fail=1
fi

# --- 5. the ATS-301 gate ------------------------------------------------------
step '5. the ATS-301 gate (the WBS helper, the ADR citations, the port audit)'
if bash tools/ats301-probes/check-ats301-gate.sh 2>&1 \
    | grep -vE 'UserWarning|warn\(msg\)' | tee "$EVIDENCE/05-ats301-gate.log"; then
  printf 'PASS  the ATS-301 gate\n'
else
  printf 'FAIL  the ATS-301 gate\n'
  fail=1
fi

# --- 6. the WBS updater, and its idempotence ----------------------------------
step '6. the WBS updater and its idempotence'
{
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

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf 'RESULT: OK -- every step of the ATS-308 evidence collection passed.\n'
else
  printf 'RESULT: MISMATCH -- at least one step failed.\n'
fi
exit "$fail"
