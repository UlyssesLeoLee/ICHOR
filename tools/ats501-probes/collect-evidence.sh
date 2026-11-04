#!/usr/bin/env bash
# ATS-501: regenerate the evidence logs from a real run.
#
# Every log records the exact command, the commit it was produced from and
# the verbatim output, so a reviewer can reproduce it. Nothing here is
# hand-written.
#
# Usage: bash tools/ats501-probes/collect-evidence.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

OUT="docs/evidence/ATS-501"
mkdir -p "$OUT"

COMMIT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NODE_V="$(node --version)"

# The workbook is regenerated before the evidence is captured, so the logs
# describe the tree that is actually committed.
python tools/update_wbs_ats501.py --status 待审核 > /dev/null

header() {
  local file="$1"; shift
  {
    echo "=== ATS-501 evidence: $1 ==="
    echo "date        : $STAMP (UTC)"
    echo "commit      : $COMMIT"
    echo "node        : $NODE_V"
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
header 03-wbs-updater-regression.log "WBS updater coexistence regression (five updaters)" \
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
