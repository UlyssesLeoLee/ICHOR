#!/usr/bin/env bash
# ATS-502: regenerate the evidence logs from a real run.
#
# Every log records the exact command, the commit it was produced from and
# the verbatim output, so a reviewer can reproduce it. Nothing here is
# hand-written.
#
# ENCODING: the probes print Chinese text (状态 values, 总览 narrative cells,
# markers). On a default Windows console the Python stdout encoding is the
# ANSI code page (gbk / cp936 / cp1252), so the log would capture mojibake
# and the checks would compare the wrong bytes. UTF-8 is therefore forced at
# the entry of this script, and every log header records the Python version
# and the stdout encoding the run actually used -- a PASS is only meaningful
# together with the encoding it was produced in.
#
# Usage: bash tools/ats502-probes/collect-evidence.sh
set -u

# --- force UTF-8 for every Python invocation in this script ---------------
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

OUT="docs/evidence/ATS-502"
mkdir -p "$OUT"

COMMIT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NODE_V="$(node --version)"

PY_VERSION="$(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
PY_STDOUT_ENCODING="$(python -c 'import sys; print(sys.stdout.encoding)' 2>&1)"
PY_DEFAULT_ENCODING="$(env -u PYTHONUTF8 -u PYTHONIOENCODING \
  python -c 'import sys; print(sys.stdout.encoding)' 2>&1)"

# The coexistence regression runs FIRST and it RESTORES the workbook to the
# snapshot it took when it started (it has to: it writes the workbook in
# several orders to compare the results). Running it after the ATS-502
# update would therefore silently throw the update away -- which is exactly
# what happened once to ATS-501. The ATS-502 update is applied afterwards, so
# the workbook the logs describe is the one that gets committed.
bash tools/ats501-probes/check-wbs-updaters.sh > /dev/null 2>&1
python tools/update_wbs_ats502.py --status 待审核 > /dev/null

header() {
  local file="$1"; shift
  {
    echo "=== ATS-502 evidence: $1 ==="
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

# --- 1. the scheduling core contract audit --------------------------------
header 01-scheduling-contract-audit.log "scheduling core contract audit" \
  "node tools/ats502-probes/audit-scheduling-core.mjs"
node tools/ats502-probes/audit-scheduling-core.mjs >> "$OUT/01-scheduling-contract-audit.log" 2>&1
echo "exit code   : $?" >> "$OUT/01-scheduling-contract-audit.log"

# --- 2. the mutation tests (the audit is not vacuous) ----------------------
header 02-mutation-tests.log "scheduling audit mutation tests (negative fixtures)" \
  "node tools/ats502-probes/mutation-tests.mjs"
node tools/ats502-probes/mutation-tests.mjs >> "$OUT/02-mutation-tests.log" 2>&1
echo "exit code   : $?" >> "$OUT/02-mutation-tests.log"

# --- 2b. the review round 1 counter-examples (red -> green control) -------
# The probe is run against BOTH trees: the rejected one (8130e35) and the
# current one. The rejected tree has to show every counter-example, the
# current tree none of them. That pair IS the red-to-green evidence.
header 02b-review-probes.log "review round 1 counter-examples (P1-P8 / H1-H5) on the rejected tree and on this tree" \
  "node tools/ats502-probes/review-probes.mjs <tree>   (run twice: the rejected tree 8130e35 and this tree)"
{
  echo "--- the REJECTED tree (agent/m2/seikoist-218 @ 8130e35) ---"
  echo ""
  # The scratch directory is used by TWO programs that want DIFFERENT forms
  # of the same path: `tar` is an MSYS program and wants the /tmp/... form,
  # while `node` is a native Windows program and wants C:\...\...
  # `mktemp -d` is not used here: it follows $TMPDIR, which on this machine
  # points into a directory tree that `tar` cannot open. The scratch
  # directory is therefore created INSIDE the repo, where both forms are
  # trivially derivable.
  REJECTED_TREE="$ROOT/.ats502-rejected-tree"
  REJECTED_TREE_WIN="$(cygpath -w "$REJECTED_TREE" 2>/dev/null || echo "$REJECTED_TREE")"
  rm -rf "$REJECTED_TREE"
  mkdir -p "$REJECTED_TREE"
  git archive 8130e35 server/queue.mjs server/scheduler.mjs | tar -x -C "$REJECTED_TREE"
  node tools/ats502-probes/review-probes.mjs "$REJECTED_TREE_WIN" 2>&1
  echo ""
  echo "--- THIS tree ($(git rev-parse HEAD)) ---"
  echo ""
  node tools/ats502-probes/review-probes.mjs "$ROOT" 2>&1
  rm -rf "$REJECTED_TREE"
} >> "$OUT/02b-review-probes.log" 2>&1
echo "exit code   : $?" >> "$OUT/02b-review-probes.log"

# --- 3. the queue unit tests ----------------------------------------------
header 03-queue-unit-tests.log "scheduling core unit tests" \
  "node --test tests/queue.test.mjs"
node --test tests/queue.test.mjs >> "$OUT/03-queue-unit-tests.log" 2>&1
echo "exit code   : $?" >> "$OUT/03-queue-unit-tests.log"

# --- 4. the scheduler integration tests -----------------------------------
header 04-scheduler-integration-tests.log "scheduling service integration tests" \
  "node --test tests/scheduler.test.mjs"
node --test tests/scheduler.test.mjs >> "$OUT/04-scheduler-integration-tests.log" 2>&1
echo "exit code   : $?" >> "$OUT/04-scheduler-integration-tests.log"

# --- 5. the WBS coexistence regression -------------------------------------
header 05-wbs-updater-regression.log "WBS updater coexistence regression (all tools/update_wbs_*.py)" \
  "bash tools/ats501-probes/check-wbs-updaters.sh"
bash tools/ats501-probes/check-wbs-updaters.sh >> "$OUT/05-wbs-updater-regression.log" 2>&1
echo "exit code   : $?" >> "$OUT/05-wbs-updater-regression.log"

# --- 6. the WBS row state --------------------------------------------------
header 06-wbs-state.log "ATS-502 row state in docs/WBS.xlsx" \
  "python tools/ats502-probes/show-wbs-row.py"
python tools/ats502-probes/show-wbs-row.py >> "$OUT/06-wbs-state.log" 2>&1
echo "exit code   : $?" >> "$OUT/06-wbs-state.log"

# --- 6b. the ADR citation check ---------------------------------------------
header 06b-adr-citations.log "ADR citation check" \
  "python tools/check_adr_citations.py"
python tools/check_adr_citations.py >> "$OUT/06b-adr-citations.log" 2>&1
echo "exit code   : $?" >> "$OUT/06b-adr-citations.log"

# --- 7. the baseline regression (the repo's own tests) ---------------------
header 07-baseline-regression.log "baseline regression: npm test / node --check / port audit" \
  "npm test && node --check server/queue.mjs && node --check server/scheduler.mjs && node tools/ats101-probes/scenario-d-port-audit.mjs"
{
  echo "--- npm test ---"
  npm test 2>&1
  echo ""
  echo "--- node --check server/queue.mjs ---"
  node --check server/queue.mjs 2>&1 && echo "OK"
  echo ""
  echo "--- node --check server/scheduler.mjs ---"
  node --check server/scheduler.mjs 2>&1 && echo "OK"
  echo ""
  echo "--- port audit ---"
  node tools/ats101-probes/scenario-d-port-audit.mjs 2>&1
} >> "$OUT/07-baseline-regression.log"

# The WBS updater leaves a .bak behind; it is not part of the delivery.
rm -f docs/WBS.xlsx.bak

echo "evidence regenerated in $OUT:"
ls -1 "$OUT"
