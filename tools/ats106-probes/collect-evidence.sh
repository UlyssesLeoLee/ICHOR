#!/usr/bin/env bash
# ATS-106: regenerate the evidence logs from a real run.
#
# Every log records the exact command, the commit it was produced from, the
# Node/Python versions and the verbatim output, so a reviewer can reproduce
# it. Nothing here is hand-written.
#
# ENCODING: the Python steps print Chinese text (WBS 状态 values, notes). UTF-8
# is forced for every Python invocation, and the headers record the encoding.
#
# ORDER: the WBS coexistence regression restores the workbook to the
# committed state when it finishes, so the ATS-106 WBS update is applied
# AFTER it; the workbook the logs describe is the one that gets committed.
#
# Usage: bash tools/ats106-probes/collect-evidence.sh
#        ATS106_STEPS=6,7,8 bash tools/ats106-probes/collect-evidence.sh   # regenerate selected logs
set -u

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

OUT="docs/evidence/ATS-106"
mkdir -p "$OUT"

COMMIT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NODE_V="$(node --version)"
PY_VERSION="$(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
PY_STDOUT_ENCODING="$(python -c 'import sys; print(sys.stdout.encoding)' 2>&1)"

header() {
  local file="$1"; shift
  {
    echo "=== ATS-106 evidence: $1 ==="
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

want() {
  # want <n>: is step n selected (ATS106_STEPS, default: every step)?
  case ",${ATS106_STEPS:-1,2,3,4,5,6,7,8}," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

if want 1; then
# --- 1. unit tests + per-file line coverage of the changed modules ----------
header 01-preflight-ut.log "preflight + argument baseline unit tests (UT-PF/UT-ARG/UT-CORE-106) with coverage"   "node --test --experimental-test-coverage --test-coverage-include=server/adapters/playwright-preflight.mjs --test-coverage-include=server/adapters/playwright-cli.mjs tests/preflight.test.mjs"
run 01-preflight-ut.log node --test --experimental-test-coverage --test-coverage-include=server/adapters/playwright-preflight.mjs --test-coverage-include=server/adapters/playwright-cli.mjs tests/preflight.test.mjs
fi

if want 2; then
# --- 2. process-level integration tests --------------------------------------
header 02-preflight-it.log "real Bridge + marker CLIs (IT-PF-SETUP..007)"   "node --test --test-reporter=spec tests/preflight-it.test.mjs"
run 02-preflight-it.log node --test --test-reporter=spec tests/preflight-it.test.mjs
fi

if want 3; then
# --- 3. contract with a REAL @playwright/test --------------------------------
REAL="${ATS_REAL_PLAYWRIGHT_PROJECT:-examples/sample-playwright}"
header 03-real-cli-contract.log "real Playwright installation at $REAL (CT-PF-001, CT-ARG-001; skipped with a reason when absent)"   "ATS_REAL_PLAYWRIGHT_PROJECT=$REAL node --test --test-reporter=spec tests/preflight-real.test.mjs"
ATS_REAL_PLAYWRIGHT_PROJECT="$REAL" run 03-real-cli-contract.log node --test --test-reporter=spec tests/preflight-real.test.mjs
fi

if want 4; then
# --- 4. negative controls: the guards are not vacuous -------------------------
header 04-guard-mutations.log "guard mutations on a temporary copy (each must be caught)"   "node tools/ats106-probes/mutation-tests.mjs"
run 04-guard-mutations.log node tools/ats106-probes/mutation-tests.mjs
fi

if want 5; then
# --- 5. Python tooling: tests + per-file coverage ------------------------------
header 05-python-tools.log "WBS tooling tests and line coverage"   "python tools/test_wbs_common.py && python -m pytest -q -p no:cacheprovider tools/test_wbs_common_helpers.py tools/test_update_wbs_ats106.py --cov=tools --cov-report=term"
{
  echo "--- python tools/test_wbs_common.py ---"
  python tools/test_wbs_common.py; echo "exit code   : $?"
  echo ""
  echo "--- pytest + coverage ---"
  python -m pytest -q -p no:cacheprovider tools/test_wbs_common_helpers.py tools/test_update_wbs_ats106.py     --cov=tools --cov-report=term | grep -E 'passed|failed|error|^Name|^-|wbs_common\.py|update_wbs_ats106\.py|^TOTAL'
  echo "exit code   : ${PIPESTATUS[0]}"
} >> "$OUT/05-python-tools.log" 2>&1
rm -f .coverage
fi

if want 6; then
# --- 6. WBS updater coexistence (all tools/update_wbs_*.py) --------------------
header 06-wbs-updater-regression.log "WBS updater coexistence regression (discovers tools/update_wbs_ats106.py)"   "bash tools/ats501-probes/check-wbs-updaters.sh"
run 06-wbs-updater-regression.log bash tools/ats501-probes/check-wbs-updaters.sh

# The ATS-106 row update is applied after the regression restored the workbook.
python tools/update_wbs_ats106.py --status "${ATS106_WBS_STATUS:-待审核}" > /dev/null
fi

if want 7; then
# --- 7. the ATS-106 row as a reader of the workbook sees it --------------------
header 07-wbs-state.log "ATS-106 row and 总览 in docs/WBS.xlsx" \
  "python -c <read ATS-106 row with tools/wbs_common.py>"
run 07-wbs-state.log python -c "
import sys
sys.path.insert(0, 'tools')
from wbs_common import read_parts, sheet_cells, totals
parts = read_parts()
s1 = sheet_cells(parts, 'xl/worksheets/sheet1.xml')
s2 = sheet_cells(parts, 'xl/worksheets/sheet2.xml')
rid, cells = next((r, c) for r, c in sorted(s2.items()) if c.get('A') == 'ATS-106')
print(f'ATS-106 row {rid}:')
for col, label in (('A', 'WBS ID'), ('B', '名称'), ('G', '完成定义'), ('K', '估算人日'), ('N', '状态'), ('O', '完成率'), ('P', '剩余人日'), ('T', '风险/说明')):
    print(f'  {col}{rid} {label}: {cells.get(col, \"\")}')
k, o, p = float(cells.get('K') or 0), float(cells.get('O') or 0), float(cells.get('P') or 0)
print(f'  remaining == estimate * (1 - completion) ? {abs(p - k * (1 - o)) < 1e-9}')
t = totals(parts)
print(f'总览 B8={s1[8].get(\"B\")} (derived {t[\"completed\"]})  B9={s1[9].get(\"B\")}  B10={s1[10].get(\"B\")} (derived {t[\"sum_remaining\"]:.0f})')
print(f'D6: {s1[6].get(\"D\", \"\")}')
print(f'D7: {s1[7].get(\"D\", \"\")}')
"
fi

if want 8; then
# --- 8. baseline regression ---------------------------------------------------
header 08-baseline-regression.log "baseline regression: npm test / node --check / port audit / ADR citations / dependency manifest"   "node --test --test-concurrency=${ATS106_TEST_CONCURRENCY:-2} tests/*.test.mjs; node --check server/index.mjs; node tools/ats101-probes/scenario-d-port-audit.mjs; python tools/check_adr_citations.py; node tools/gen_dep_manifest.mjs --check"
{
  # The npm test suite (tests/*.test.mjs) at concurrency 2: unbounded parallelism
  # starts every Bridge-spawning file at once and loaded hosts miss the
  # readiness window (the same setting as .quality/qguard.json).
  echo "--- npm test suite: node --test --test-concurrency=${ATS106_TEST_CONCURRENCY:-2} tests/*.test.mjs ---"; node --test --test-concurrency=${ATS106_TEST_CONCURRENCY:-2} tests/*.test.mjs 2>&1 | grep -E '^(not ok|# (tests|suites|pass|fail|cancelled|skipped|todo))|^✖|^ℹ (tests|suites|pass|fail|cancelled|skipped|todo)'; echo "exit code   : ${PIPESTATUS[0]}"; echo ""
  echo "--- node --check ---"; node --check server/index.mjs && echo "OK"; echo ""
  echo "--- port audit (ATS-101 scenario D) ---"; node tools/ats101-probes/scenario-d-port-audit.mjs 2>&1 | tail -16; echo "exit code   : ${PIPESTATUS[0]}"; echo ""
  echo "--- ADR citations ---"; python tools/check_adr_citations.py 2>&1 | tail -6; echo "exit code   : ${PIPESTATUS[0]}"; echo ""
  echo "--- dependency manifest ---"; node tools/gen_dep_manifest.mjs --check 2>&1 | tail -2; echo "exit code   : ${PIPESTATUS[0]}"; echo ""
} >> "$OUT/08-baseline-regression.log" 2>&1
fi

echo "evidence regenerated in $OUT:"
ls -1 "$OUT"
