set -u
# R4 verification: run the required checks on a clone of the delivery branch.
#
# Usage: bash verify-r4.sh <clone-dir> <label>
#
# The exit code of each step is the exit code of the STEP, not of the `tail`
# at the end of the pipeline. `cmd | tail` reports tail's status; PIPESTATUS
# carries the command's. A step that silently reports 0 because tail succeeded
# is exactly the failure mode this script exists to rule out.
CLONE="$1"
LABEL="$2"
echo "=== $LABEL ==="
echo "clone      : $CLONE"
echo "commit     : $(git -C "$CLONE" rev-parse HEAD)"
echo "branch     : $(git -C "$CLONE" branch --show-current)"
echo "autocrlf   : $(git -C "$CLONE" config --get core.autocrlf)"
echo ""
cd "$CLONE" || exit 1
export PATH="/d/hermes-multica/home/cache/scratch/node22/node-v22.23.4-win-x64:/c/Python312:$PATH"
export TEMP=D:/hermes-multica/home/cache/scratch/tmp
export TMP=$TEMP
FAILED=0

step() {
  # step <description> <command...>
  local desc="$1"; shift
  echo "--- $desc ---"
  "$@" 2>&1 | tail -5
  local rc="${PIPESTATUS[0]}"
  echo "STEP_EXIT=$rc"
  if [ "$rc" -ne 0 ]; then
    FAILED=1
  fi
  echo ""
}

echo "--- node / npm ---"
node --version
npm --version
echo ""

step "1. verify_checksums.py" python tools/verify_checksums.py
step "2. the ATS-101 port audit" node tools/ats101-probes/scenario-d-port-audit.mjs
step "3. the ADR citation check" python tools/check_adr_citations.py
step "4. check-wbs-updaters.sh" bash tools/ats501-probes/check-wbs-updaters.sh

echo "--- 5. npm test ---"
npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)|^not ok" | head -20
TEST_RC="${PIPESTATUS[0]}"
echo "STEP_EXIT=$TEST_RC"
if [ "$TEST_RC" -ne 0 ]; then
  FAILED=1
fi
echo ""

echo "=== end of $LABEL (overall: $([ "$FAILED" -eq 0 ] && echo OK || echo FAILED)) ==="
exit "$FAILED"
