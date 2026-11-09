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

# The NATIVE root: native Windows programs (node, git, python) do NOT
# understand an MSYS path. Handing them "/c/Users/..." makes them resolve it
# as the literal directory "C:\c\Users\...", which is how the scratch
# directory used to end up outside the tree it was meant to be in. Every
# path that is handed to a native program therefore goes through `pwd -W`.
NATIVE_ROOT="$(cd "$ROOT" && pwd -W)"

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
  case ",${ATS107_STEPS:-1,2,3,4,5,6,7,8,9}," in *",$1,"*) return 0 ;; *) return 1 ;; esac
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
#
# The scratch directory is handed to node as a NATIVE path: node does not
# understand an MSYS path, and would otherwise resolve "/c/Users/..." as the
# literal directory "C:\c\Users\..." -- outside the tree, and never cleaned
# up by the `rm -rf` below.
SCRATCH="${ATS107_SCRATCH:-$ROOT/.ats107-evidence-scratch}"
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
NATIVE_SCRATCH="$(cd "$SCRATCH" && pwd -W)"
header 02-real-browser-probe.log "the acceptance criterion: at least 1 PASS and 1 FAIL on Chromium, results and error messages consistent with the CLI (ST-039..041)" \
  "node tools/ats107-probes/st-ats107.mjs . <native scratch dir>"
run 02-real-browser-probe.log node tools/ats107-probes/st-ats107.mjs . "$NATIVE_SCRATCH"
rm -rf "$SCRATCH"
fi

if want 3; then
# --- 3. the negative control: the reconciliation is not vacuous --------------
header 03-mutation-control.log "13 mutations of the Bridge's own result projection; every one must be caught, and the honest result must be accepted (ST-042)" \
  "node tools/ats107-probes/mutation-check.mjs"
run 03-mutation-control.log node tools/ats107-probes/mutation-check.mjs
fi

if want 8; then
# --- 8. the second-layer negative controls (the REAL chain) -----------------
# Layer 1 (step 3) proves the comparison LOGIC has teeth. These two prove the
# probe rejects a real defect on the real chain:
#   - a fixture that never launches a browser (the "real browser" check);
#   - a product that truncates the error message it reports.
header 08-no-browser-control.log "the real-browser check must reject a fixture that never launches a browser (ST-044)" \
  "node tools/ats107-probes/no-browser-control.mjs"
run 08-no-browser-control.log node tools/ats107-probes/no-browser-control.mjs

header 09-product-mutation-control.log "the probe must reject a product that truncates the error message (ST-045)" \
  "bash tools/ats107-probes/product-mutation-control.sh"
PM_SCRATCH="${ATS107_PM_SCRATCH:-$ROOT/.ats107-product-mutation-evidence}"
rm -rf "$PM_SCRATCH"
mkdir -p "$PM_SCRATCH"
run 09-product-mutation-control.log env ATS107_SCRATCH="$(cd "$PM_SCRATCH" && pwd -W)" bash tools/ats107-probes/product-mutation-control.sh
rm -rf "$PM_SCRATCH"
fi

if want 9; then
# --- 9. the INTEGRATION view of the same criterion --------------------------
# The ST probe reads the engine's report with its own walker; these cases read
# the Bridge's own API answers, so a bug in the product's projection cannot
# hide behind the engine's report.
header 10-real-browser-it.log "the same criterion from the API's side: a real Bridge over HTTP running the real fixture (IT-ATS107-001..003)" \
  "node --test tests/ats107-real-browser-it.test.mjs"
run 10-real-browser-it.log node --test tests/ats107-real-browser-it.test.mjs
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
  echo "--- npm test suite: node --test --test-concurrency=2 tests/*.test.mjs ---"; node --test --test-concurrency=2 tests/*.test.mjs 2>&1 | grep -E '^(not ok|# (tests|suites|pass|fail|cancelled|skipped|todo))|^✖|^ℹ (tests|suites|pass|fail|cancelled|skipped|todo)'; echo "exit code   : ${PIPESTATUS[0]}"; echo "";
  # The ATS-203 failures are attributed by MEASUREMENT, not by assertion: the
  # same three files are run again on the BASELINE tree (the commit this
  # branch started from), with the engine version printed on both sides. If
  # the baseline fails the same way, the failures are pre-existing.
  echo "--- the ATS-203 files on THIS tree and on the BASELINE tree ---";
  ATS203_FILES="tests/ats203-index-api.test.mjs tests/ats203-index-it.test.mjs tests/ats203-regression-dataset.test.mjs"
  BASELINE="${ATS107_BASELINE:-0e34299}"
  echo "baseline commit : $BASELINE"
  echo "engine (this tree)   : $(node -e "const c=['$NATIVE_ROOT/examples/sample-playwright/node_modules','D:/ICHOR/examples/sample-playwright/node_modules'];for(const d of c){try{console.log(require(d+'/@playwright/test/package.json').version+' ('+d+')');break}catch(e){}}")"
  echo "";
  echo "--- this tree ---";
  node --test $ATS203_FILES 2>&1 | grep -E '^(✖|ℹ (tests|pass|fail|skipped))' ; echo "exit code   : ${PIPESTATUS[0]}"; echo "";
  echo "--- the baseline tree ($BASELINE) ---";
  BASE_DIR="$ROOT/.ats107-baseline-tree"
  rm -rf "$BASE_DIR"; mkdir -p "$BASE_DIR"
  git archive "$BASELINE" | tar -x -C "$BASE_DIR"
  ( cd "$BASE_DIR" && node --test $ATS203_FILES 2>&1 | grep -E '^(✖|ℹ (tests|pass|fail|skipped))' ); echo "exit code   : ${PIPESTATUS[0]}"
  echo "engine (baseline tree): $(node -e "const c=['$BASE_DIR/examples/sample-playwright/node_modules','D:/ICHOR/examples/sample-playwright/node_modules'];for(const d of c){try{console.log(require(d+'/@playwright/test/package.json').version+' ('+d+')');break}catch(e){}}")"
  rm -rf "$BASE_DIR"
  echo "";
  echo "NOTE: the two blocks above are the MEASURED comparison -- the same"
  echo "      three files, on this tree and on the baseline tree, with the"
  echo "      engine version on both sides. A failure that appears on BOTH"
  echo "      sides is not caused by this task."
  echo "";
  echo "--- node --check ---"; node --check server/index.mjs && echo "OK"; echo "";
  echo "--- port audit (ATS-101 scenario D) ---"; node tools/ats101-probes/scenario-d-port-audit.mjs 2>&1 | tail -16; echo "exit code   : ${PIPESTATUS[0]}"; echo "";
  echo "--- ADR citations ---"; python tools/check_adr_citations.py 2>&1 | tail -6; echo "exit code   : ${PIPESTATUS[0]}"; echo "";
  echo "--- dependency manifest ---"; node tools/gen_dep_manifest.mjs --check 2>&1 | tail -2; echo "exit code   : ${PIPESTATUS[0]}"; echo "";
} >> "$OUT/07-baseline-regression.log" 2>&1
fi

echo "evidence regenerated in $OUT:"
ls -1 "$OUT"
