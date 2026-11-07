#!/usr/bin/env bash
# ATS-207 evidence collection: runs every check of the delivery and writes
# one log per check into docs/evidence/ATS-207/.
#
#   bash tools/ats207-probes/collect-evidence.sh <scratch-dir> <playwright-node_modules> <base-rev>
#
# <scratch-dir>              writable directory for temp files (TEMP/TMP point there)
# <playwright-node_modules>  node_modules with @playwright/test (for the ST probe)
# <base-rev>                 the revision BEFORE ATS-207 (for the race probe's red run)
#
# Every log starts with the tree it was collected on. The script exits non-zero
# when any check failed; the logs are written either way.
set -u
cd "$(dirname "$0")/../.."
SCRATCH="$1"; PW_MODULES="$2"; BASE="$3"
OUT=docs/evidence/ATS-207
mkdir -p "$OUT" "$SCRATCH/tmp"
export TEMP="$SCRATCH/tmp" TMP="$SCRATCH/tmp" PYTHONUTF8=1
STATUS=0
header() {
  echo "# ATS-207 evidence: $1"
  echo "# collected : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD      : $(git rev-parse HEAD)"
  echo "# tree      : $(git rev-parse 'HEAD^{tree}')"
  echo "# node      : $(node --version)"
  echo "# command   : $2"
  echo
}
run() { # <log> <title> <command...>
  local log="$OUT/$1" title="$2"; shift 2
  { header "$title" "$*"; "$@"; echo; echo "# exit code: $?"; } > "$log" 2>&1
  local code
  code=$(tail -1 "$log" | sed 's/# exit code: //')
  [ "$code" = "0" ] || STATUS=1
  echo "$1 -> exit $code"
}

# 01: the lock contention defect (red on the base revision) and its fix (green).
git show "$BASE:server/core.mjs" > server/core.base-ats207.mjs
{
  header "race probe: 6 processes acquire one lock at the same instant" "node tools/ats207-probes/race-probe.mjs <module> $SCRATCH/race 6 [stale]"
  for variant in fresh stale; do
    for module in server/core.base-ats207.mjs server/core.mjs; do
      label=$([ "$module" = server/core.mjs ] && echo "ATS-207 (HEAD)" || echo "base $BASE")
      for round in 1 2 3; do
        echo "## $label, $variant lock, round $round"
        node tools/ats207-probes/race-probe.mjs "$module" "$SCRATCH/race" 6 "$([ $variant = stale ] && echo stale)"
        echo "# exit code: $?"
      done
    done
  done
} > "$OUT/01-race-red-green.log" 2>&1
rm -f server/core.base-ats207.mjs
grep -c "RESULT: winners=1 " "$OUT/01-race-red-green.log" | sed 's/^/01-race-red-green.log -> rounds with exactly one winner: /'

run 02-ut-instance-lock.log "UT-LOCK / UT-DATA / UT-WAL" node --test tests/instance-lock.test.mjs
run 03-it-instance-lock.log "IT-LOCK / IT-DATA / IT-WAL (real Bridge processes)" node --test tests/instance-lock-it.test.mjs
run 04-st-ats207.log "ST-017 / ST-025 / ST-026 (real Bridge processes, real Chromium)" node tools/ats207-probes/st-ats207.mjs . "$SCRATCH/st" "$PW_MODULES"
run 05-node-test-full.log "full regression with coverage (--test-concurrency=2)" node --test --test-concurrency=2 --experimental-test-coverage --test-reporter=spec --test-reporter=lcov --test-reporter-destination=stdout --test-reporter-destination="$SCRATCH/node.lcov" tests/*.test.mjs
run 06-python-tests.log "python gates (wbs_common, updaters, catalog) with coverage" bash -c "python tools/test_wbs_common.py && python -m pytest -q -p no:cacheprovider tools/test_wbs_common_helpers.py tools/test_update_wbs_ats506.py tools/test_update_wbs_ats207.py tools/test_generate_test_docs.py --cov=tools --cov-report=lcov:$SCRATCH/py.lcov"
run 07-coverage.log "line coverage of the files ATS-207 changed (from 05 and 06)" bash -c "node tools/ats207-probes/coverage-of.mjs $SCRATCH/node.lcov 'server/(core|index)\\.mjs\$' && node tools/ats207-probes/coverage-of.mjs $SCRATCH/py.lcov 'tools/(update_wbs_ats207|wbs_common|generate_test_docs)\\.py\$'"
run 08-audits.log "ADR citations, ATS-101 port audit, ATS-301 gate" bash -c "python -X utf8 tools/check_adr_citations.py && node tools/ats101-probes/scenario-d-port-audit.mjs && bash tools/ats301-probes/check-ats301-gate.sh"
run 09-wbs-row.log "the ATS-207 row of docs/WBS.xlsx" python -X utf8 -c "
import sys, openpyxl
sys.path.insert(0, 'tools')
from wbs_common import read_parts, sheet_cells, SHEET2
r = next(c for c in sheet_cells(read_parts('docs/WBS.xlsx'), SHEET2).values() if c.get('A') == 'ATS-207')
print('状态', r['N'], '| 完成率', r['O'], '| 剩余人日', r['P'], '| 估算', r['K'])
print('风险/说明', r['T'])
wb = openpyxl.load_workbook('docs/WBS.xlsx'); wb.close(); print('openpyxl: the workbook loads')
"
exit $STATUS
