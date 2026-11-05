#!/usr/bin/env bash
# ATS-501: regenerate the evidence logs from a real run.
#
# Every log records the exact command, the commit it was produced from and
# the verbatim output, so a reviewer can reproduce it. Nothing here is
# hand-written.
#
# ENCODING: the probes print Chinese text (状态 values, 总览 narrative cells,
# markers). On a default Windows console the Python stdout encoding is the
# ANSI code page, so the log would capture mojibake and the checks would
# compare the wrong bytes. UTF-8 is therefore forced at the entry of this
# script, and every log header records the Python version and the stdout
# encoding the run actually used -- a PASS is only meaningful together with
# the encoding it was produced in.
#
# Usage: bash tools/ats501-probes/collect-evidence.sh
set -u

# --- force UTF-8 for every Python invocation in this script ---------------
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

OUT="docs/evidence/ATS-501"
mkdir -p "$OUT"

COMMIT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NODE_V="$(node --version)"

# The Python environment the logs are produced in. Recorded in EVERY header:
# the coexistence regression compares Chinese literals, so its result is only
# reproducible when the encoding is known.
PY_VERSION="$(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
PY_STDOUT_ENCODING="$(python -c 'import sys; print(sys.stdout.encoding)' 2>&1)"
PY_DEFAULT_ENCODING="$(env -u PYTHONUTF8 -u PYTHONIOENCODING \
  python -c 'import sys; print(sys.stdout.encoding)' 2>&1)"

# The coexistence regression runs FIRST and it RESTORES the workbook to the
# committed state when it finishes (it has to: it writes the workbook in
# several orders to compare the results). Running it after the ATS-501
# update would therefore silently throw the update away -- which is exactly
# what happened once. The ATS-501 update is applied afterwards, so the
# workbook the logs describe is the one that gets committed.
bash tools/ats501-probes/check-wbs-updaters.sh > /dev/null 2>&1
python tools/update_wbs_ats501.py --status 待审核 > /dev/null

header() {
  local file="$1"; shift
  {
    echo "=== ATS-501 evidence: $1 ==="
    echo "date        : $STAMP (UTC)"
    echo "commit      : $COMMIT"
    echo "node        : $NODE_V"
    echo "python      : $PY_VERSION"
    echo "stdout enc  : $PY_STDOUT_ENCODING (forced: PYTHONUTF8=$PYTHONUTF8 PYTHONIOENCODING=$PYTHONIOENCODING)"
    echo "default enc : $PY_DEFAULT_ENCODING (what the same interpreter would use without the forcing)"
    echo "command     : $2"
    echo ""
  } > "$OUT/$file"
}

# --- 1. the protocol contract audit ----------------------------------------
header 01-protocol-contract-audit.log "remote protocol contract audit" \
  "node tools/ats501-probes/audit-remote-protocol.mjs"
node tools/ats501-probes/audit-remote-protocol.mjs >> "$OUT/01-protocol-contract-audit.log" 2>&1
echo "exit code   : $?" >> "$OUT/01-protocol-contract-audit.log"

# --- 2. the mutation tests (the audit is not vacuous) ------------------------
header 02-mutation-tests.log "protocol audit mutation tests (negative fixtures)" \
  "node tools/ats501-probes/mutation-tests.mjs"
node tools/ats501-probes/mutation-tests.mjs >> "$OUT/02-mutation-tests.log" 2>&1
echo "exit code   : $?" >> "$OUT/02-mutation-tests.log"

# --- 3. the WBS coexistence regression --------------------------------------
header 03-wbs-updater-regression.log "WBS updater coexistence regression (all tools/update_wbs_*.py)" \
  "bash tools/ats501-probes/check-wbs-updaters.sh"
bash tools/ats501-probes/check-wbs-updaters.sh >> "$OUT/03-wbs-updater-regression.log" 2>&1
echo "exit code   : $?" >> "$OUT/03-wbs-updater-regression.log"

# --- 4. the WBS row state ---------------------------------------------------
header 04-wbs-state.log "ATS-501 row state in docs/WBS.xlsx" \
  "python tools/ats501-probes/show-wbs-row.py"
python tools/ats501-probes/show-wbs-row.py >> "$OUT/04-wbs-state.log" 2>&1
echo "exit code   : $?" >> "$OUT/04-wbs-state.log"

# --- 5. the baseline regression (the repo's own tests) ----------------------
header 05-baseline-regression.log "baseline regression: npm test / node --check / port audit" \
  "npm test && node --check server/index.mjs && node tools/ats101-probes/scenario-d-port-audit.mjs"
{
  echo "--- npm test ---"
  npm test 2>&1
  echo ""
  echo "--- node --check server/index.mjs ---"
  node --check server/index.mjs 2>&1 && echo "OK"
  echo ""
  echo "--- port audit ---"
  node tools/ats101-probes/scenario-d-port-audit.mjs 2>&1
} >> "$OUT/05-baseline-regression.log"

# The WBS updater leaves a .bak behind; it is not part of the delivery.
rm -f docs/WBS.xlsx.bak

echo "evidence regenerated in $OUT:"
ls -1 "$OUT"
