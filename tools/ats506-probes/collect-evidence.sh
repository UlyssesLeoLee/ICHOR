#!/usr/bin/env bash
# ATS-506: regenerate the evidence logs from a real run.
#
# Every log records the exact command, the commit it was produced from, the
# Node/Python versions and the verbatim output, so a reviewer can reproduce
# it. Nothing here is hand-written.
#
# ENCODING: the Python steps print Chinese text (WBS 状态 values, notes). UTF-8
# is forced for every Python invocation, and the headers record the encoding.
#
# ORDER: the WBS coexistence regression restores the workbook to the
# committed state when it finishes, so the ATS-506 WBS update is applied
# AFTER it; the workbook the logs describe is the one that gets committed.
#
# Usage: bash tools/ats506-probes/collect-evidence.sh
set -u

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

OUT="docs/evidence/ATS-506"
mkdir -p "$OUT"

COMMIT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NODE_V="$(node --version)"
PY_VERSION="$(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
PY_STDOUT_ENCODING="$(python -c 'import sys; print(sys.stdout.encoding)' 2>&1)"

header() {
  local file="$1"; shift
  {
    echo "=== ATS-506 evidence: $1 ==="
    echo "date        : $STAMP (UTC)"
    echo "commit      : $COMMIT"
    echo "node        : $NODE_V"
    echo "python      : $PY_VERSION"
    echo "stdout enc  : $PY_STDOUT_ENCODING (forced: PYTHONUTF8=$PYTHONUTF8 PYTHONIOENCODING=$PYTHONIOENCODING)"
    echo "command     : $2"
    echo ""
  } > "$OUT/$file"
}

run() {
  # run <log> <command...>: append the output and the exit code.
  local file="$1"; shift
  "$@" >> "$OUT/$file" 2>&1
  echo "exit code   : $?" >> "$OUT/$file"
}

# --- 1. unit tests + per-file line coverage of the control plane ------------
header 01-control-plane-ut.log "control-plane unit tests (UT-CP-001..030) with coverage of server/control-plane/*" \
  "node --test --experimental-test-coverage --test-coverage-include=server/control-plane/** tests/control-plane.test.mjs"
run 01-control-plane-ut.log node --test --experimental-test-coverage '--test-coverage-include=server/control-plane/**' tests/control-plane.test.mjs

# --- 2. process-level integration tests --------------------------------------
header 02-control-plane-it.log "local Bridge + control plane as real processes (IT-CP-SETUP..CLEANUP)" \
  "node --test tests/control-plane-it.test.mjs"
run 02-control-plane-it.log node --test tests/control-plane-it.test.mjs

# --- 3. negative controls: the guards are not vacuous -------------------------
header 03-guard-mutations.log "guard mutations on a temporary copy (each must be caught)" \
  "node tools/ats506-probes/mutation-tests.mjs"
run 03-guard-mutations.log node tools/ats506-probes/mutation-tests.mjs

# --- 4. Python tooling: tests + per-file coverage ------------------------------
header 04-python-tools.log "WBS/catalog tooling tests and line coverage" \
  "python tools/test_wbs_common.py && python -m pytest -q -p no:cacheprovider tools/test_wbs_common_helpers.py tools/test_update_wbs_ats506.py tools/test_generate_test_docs.py --cov=tools --cov-report=term"
{
  echo "--- python tools/test_wbs_common.py ---"
  python tools/test_wbs_common.py; echo "exit code   : $?"
  echo ""
  echo "--- pytest + coverage ---"
  python -m pytest -q -p no:cacheprovider tools/test_wbs_common_helpers.py tools/test_update_wbs_ats506.py tools/test_generate_test_docs.py \
    --cov=tools --cov-report=term | grep -E 'passed|failed|error|^Name|^-|wbs_common\.py|update_wbs_ats506\.py|generate_test_docs\.py|^TOTAL'
  echo "exit code   : ${PIPESTATUS[0]}"
} >> "$OUT/04-python-tools.log" 2>&1
rm -f .coverage

# --- 5. WBS updater coexistence (all tools/update_wbs_*.py) --------------------
header 05-wbs-updater-regression.log "WBS updater coexistence regression (discovers tools/update_wbs_ats506.py)" \
  "bash tools/ats501-probes/check-wbs-updaters.sh"
run 05-wbs-updater-regression.log bash tools/ats501-probes/check-wbs-updaters.sh

# The ATS-506 row update is applied after the regression restored the workbook.
python tools/update_wbs_ats506.py --status 待审核 > /dev/null

# --- 6. the ATS-506 row as a reader of the workbook sees it --------------------
header 06-wbs-state.log "ATS-506 row and 总览 in docs/WBS.xlsx" \
  "python -c <read ATS-506 row with tools/wbs_common.py>"
run 06-wbs-state.log python -c "
import sys
sys.path.insert(0, 'tools')
from wbs_common import read_parts, sheet_cells, totals
parts = read_parts()
s1 = sheet_cells(parts, 'xl/worksheets/sheet1.xml')
s2 = sheet_cells(parts, 'xl/worksheets/sheet2.xml')
rid, cells = next((r, c) for r, c in sorted(s2.items()) if c.get('A') == 'ATS-506')
print(f'ATS-506 row {rid}:')
for col, label in (('A', 'WBS ID'), ('B', '名称'), ('G', '完成定义'), ('K', '估算人日'), ('N', '状态'), ('O', '完成率'), ('P', '剩余人日'), ('T', '风险/说明')):
    print(f'  {col}{rid} {label}: {cells.get(col, \"\")}')
k, o, p = float(cells.get('K') or 0), float(cells.get('O') or 0), float(cells.get('P') or 0)
print(f'  remaining == estimate * (1 - completion) ? {abs(p - k * (1 - o)) < 1e-9}')
t = totals(parts)
print(f'总览 B8={s1[8].get(\"B\")} (derived {t[\"completed\"]})  B9={s1[9].get(\"B\")}  B10={s1[10].get(\"B\")} (derived {t[\"sum_remaining\"]:.0f})')
print(f'D6: {s1[6].get(\"D\", \"\")}')
print(f'D7: {s1[7].get(\"D\", \"\")}')
"

# --- 7. baseline regression ---------------------------------------------------
header 07-baseline-regression.log "baseline regression: npm test / node --check / port audit / ATS-501 protocol audit / ADR citations / dependency manifest" \
  "npm test; node --check server/index.mjs server/control-plane/main.mjs; node tools/ats101-probes/scenario-d-port-audit.mjs; node tools/ats501-probes/audit-remote-protocol.mjs; node tools/ats501-probes/mutation-tests.mjs; python tools/check_adr_citations.py; node tools/gen_dep_manifest.mjs --check"
{
  echo "--- npm test ---"; npm test 2>&1; echo "exit code   : $?"; echo ""
  echo "--- node --check ---"; node --check server/index.mjs && node --check server/control-plane/main.mjs && echo "OK"; echo ""
  echo "--- port audit (ATS-101 scenario D) ---"; node tools/ats101-probes/scenario-d-port-audit.mjs 2>&1 | tail -16; echo "exit code   : ${PIPESTATUS[0]}"; echo ""
  echo "--- ATS-501 protocol audit (docs/19 was edited by ATS-506) ---"; node tools/ats501-probes/audit-remote-protocol.mjs 2>&1 | tail -4; echo "exit code   : ${PIPESTATUS[0]}"; echo ""
  echo "--- ATS-501 protocol mutation tests ---"; node tools/ats501-probes/mutation-tests.mjs 2>&1 | tail -3; echo "exit code   : ${PIPESTATUS[0]}"; echo ""
  echo "--- ADR citations ---"; python tools/check_adr_citations.py 2>&1 | tail -6; echo "exit code   : ${PIPESTATUS[0]}"; echo ""
  echo "--- dependency manifest ---"; node tools/gen_dep_manifest.mjs --check 2>&1 | tail -2; echo "exit code   : ${PIPESTATUS[0]}"
} >> "$OUT/07-baseline-regression.log" 2>&1

echo "evidence regenerated in $OUT:"
ls -1 "$OUT"
