#!/usr/bin/env bash
# ATS-107: regenerate the evidence logs from a real run.
#
# Every log records the exact command, the commit it was produced from, the
# Node/Python versions and the verbatim output, so a reviewer can reproduce
# it. Nothing here is hand-written.
#
# ENCODING: the Python steps print Chinese text (WBS 状态 values, notes). UTF-8
# is forced for every Python invocation, and the headers record the encoding.
#
# ORDER: the WBS coexistence regression restores the workbook to the
# committed state when it finishes, so the ATS-107 WBS update is applied
# AFTER it; the workbook the logs describe is the one that gets committed.
#
# Usage: bash tools/ats107-probes/collect-evidence.sh
#        ATS107_STEPS=1,2 bash tools/ats107-probes/collect-evidence.sh   # regenerate selected logs
set -u

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

OUT="docs/evidence/ATS-107"
mkdir -p "$OUT"

COMMIT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NODE_V="$(node --version)"
PY_VERSION="$(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
PY_STDOUT_ENCODING="$(python -c 'import sys; print(sys.stdout.encoding)' 2>&1)"

header() {
  local file="$1"; shift
  {
    echo "=== ATS-107 evidence: $1 ==="
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
  # want <n>: is step n selected (ATS107_STEPS, default: every step)?
  case ",${ATS107_STEPS:-1,2,3,4,5,6,7}," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

if want 1; then
# --- 1. the fixture's own contract -------------------------------------------
header 01-fixture-contract.log "the ATS-107 fixture: exact pin, committed lockfile, chromium, offline specs" \
  "cat examples/real-browser-fixture/package.json; git ls-files examples/real-browser-fixture/; cat examples/real-browser-fixture/playwright.config.ts; cat examples/real-browser-fixture/tests/expected.json"
{
  echo "--- package.json (the version must be an EXACT pin) ---"
  cat examples/real-browser-fixture/package.json
  echo ""
  echo "--- the files that are COMMITTED (the lockfile is the deliverable) ---"
  git ls-files examples/real-browser-fixture/
  echo ""
  echo "--- playwright.config.ts (chromium is explicit; retries: 0) ---"
  cat examples/real-browser-fixture/playwright.config.ts
  echo ""
  echo "--- tests/expected.json (the fixture's own contract, as data) ---"
  cat examples/real-browser-fixture/tests/expected.json
  echo ""
  echo "--- the two specs (both offline: page.setContent, no network) ---"
  cat examples/real-browser-fixture/tests/passing.spec.ts
  echo ""
  cat examples/real-browser-fixture/tests/failing.spec.ts
} >> "$OUT/01-fixture-contract.log" 2>&1
fi

if want 2; then
# --- 2. THE ACCEPTANCE CRITERION: real Bridge vs. an independent CLI run -----
# The probe starts a real Bridge on a free port, runs the fixture through it,
# runs the SAME fixture directly through the Playwright CLI, and compares the
# two verdicts, the counters and the error messages.
SCRATCH="${ATS107_SCRATCH:-$ROOT/.ats107-evidence-scratch}"
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
header 02-real-browser-probe.log "the acceptance criterion: at least 1 PASS and 1 FAIL on Chromium, results and error messages consistent with the CLI (ST-039..041, ST-043)" \
  "node tools/ats107-probes/st-ats107.mjs . $SCRATCH"
run 02-real-browser-probe.log node tools/ats107-probes/st-ats107.mjs . "$SCRATCH"
rm -rf "$SCRATCH"
fi

if want 3; then
# --- 3. the negative control: the reconciliation is not vacuous --------------
header 03-mutation-control.log "10 mutations of the Bridge's own result projection; every one must be caught, and the honest result must be accepted (ST-042)" \
  "node tools/ats107-probes/mutation-check.mjs"
run 03-mutation-control.log node tools/ats107-probes/mutation-check.mjs
fi

if want 4; then
# --- 4. the Python tooling ---------------------------------------------------
header 04-python-tools.log "the ATS-107 WBS updater's tests and the whole Python tooling suite" \
  "python -m pytest -q -p no:cacheprovider tools/"
{
  python -m pytest -q -p no:cacheprovider tools/ 2>&1 | grep -E 'passed|failed|error'
  echo "exit code   : ${PIPESTATUS[0]}"
} >> "$OUT/04-python-tools.log" 2>&1
fi

if want 5; then
# --- 5. WBS updater coexistence (all tools/update_wbs_*.py) -------------------
header 05-wbs-updater-regression.log "WBS updater coexistence regression (discovers tools/update_wbs_ats107.py)" \
  "bash tools/ats501-probes/check-wbs-updaters.sh"
run 05-wbs-updater-regression.log bash tools/ats501-probes/check-wbs-updaters.sh

# The ATS-107 row update is applied after the regression restored the workbook.
python tools/update_wbs_ats107.py --status "${ATS107_WBS_STATUS:-待审核}" > /dev/null
fi

if want 6; then
# --- 6. the ATS-107 row as a reader of the workbook sees it -------------------
header 06-wbs-state.log "ATS-107 row and 总览 in docs/WBS.xlsx" \
  "python -c <read ATS-107 row with tools/wbs_common.py>"
run 06-wbs-state.log python -c "
import sys
sys.path.insert(0, 'tools')
from wbs_common import read_parts, sheet_cells, totals
parts = read_parts()
s1 = sheet_cells(parts, 'xl/worksheets/sheet1.xml')
s2 = sheet_cells(parts, 'xl/worksheets/sheet2.xml')
rid, cells = next((r, c) for r, c in sorted(s2.items()) if c.get('A') == 'ATS-107')
print(f'ATS-107 row {rid}:')
for col, label in (('A', 'WBS ID'), ('B', '名称'), ('E', '任务'), ('G', '完成定义'), ('H', '前置依赖 WBS'), ('K', '估算人日'), ('N', '状态'), ('O', '完成率'), ('P', '剩余人日'), ('Q', '验证方式'), ('R', '关联要件'), ('T', '风险/说明')):
    print(f'  {col}{rid} {label}: {cells.get(col, \"\")}')
k, o, p = float(cells.get('K') or 0), float(cells.get('O') or 0), float(cells.get('P') or 0)
print(f'  remaining == estimate * (1 - completion) ? {abs(p - k * (1 - o)) < 1e-9}')
t = totals(parts)
print(f'总览 B8={s1[8].get(\"B\")} (derived {t[\"completed\"]})  B9={s1[9].get(\"B\")}  B10={s1[10].get(\"B\")} (derived {t[\"sum_remaining\"]:.0f})')
print(f'D6: {s1[6].get(\"D\", \"\")}')
print(f'D7: {s1[7].get(\"D\", \"\")}')
"
fi

if want 7; then
# --- 7. baseline regression ---------------------------------------------------
header 07-baseline-regression.log "baseline regression: npm test / node --check / port audit / ADR citations / dependency manifest" \
  "node --test --test-concurrency=2 tests/*.test.mjs; node --check server/index.mjs; node tools/ats101-probes/scenario-d-port-audit.mjs; python tools/check_adr_citations.py; node tools/gen_dep_manifest.mjs --check"
{
  # The npm test suite (tests/*.test.mjs) at concurrency 2: unbounded parallelism
  # starts every Bridge-spawning file at once and loaded hosts miss the
  # readiness window (the same setting as .quality/qguard.json).
  echo "--- npm test suite: node --test --test-concurrency=2 tests/*.test.mjs ---"; node --test --test-concurrency=2 tests/*.test.mjs 2>&1 | grep -E '^(not ok|# (tests|suites|pass|fail|cancelled|skipped|todo))|^✖|^ℹ (tests|suites|pass|fail|cancelled|skipped|todo)'; echo "exit code   : ${PIPESTATUS[0]}"; echo ""
  echo "--- node --check ---"; node --check server/index.mjs && echo "OK"; echo ""
  echo "--- port audit (ATS-101 scenario D) ---"; node tools/ats101-probes/scenario-d-port-audit.mjs 2>&1 | tail -16; echo "exit code   : ${PIPESTATUS[0]}"; echo ""
  echo "--- ADR citations ---"; python tools/check_adr_citations.py 2>&1 | tail -6; echo "exit code   : ${PIPESTATUS[0]}"; echo ""
  echo "--- dependency manifest ---"; node tools/gen_dep_manifest.mjs --check 2>&1 | tail -2; echo "exit code   : ${PIPESTATUS[0]}"; echo ""
} >> "$OUT/07-baseline-regression.log" 2>&1
fi

echo "evidence regenerated in $OUT:"
ls -1 "$OUT"
