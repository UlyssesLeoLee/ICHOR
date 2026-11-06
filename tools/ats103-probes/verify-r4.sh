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

# R4 asks for the HTTP probe and the browser probe on the merged tree too.
# They need the static export, so it is built here first.
echo "--- 5. the static export (for the two probes below) ---"
npm --prefix apps/studio ci --no-audit --no-fund > /dev/null 2>&1
CI_RC=$?
echo "STEP_EXIT=$CI_RC"
if [ "$CI_RC" -ne 0 ]; then
  FAILED=1
fi
# The probes drive a real Playwright run, which needs the example project's
# own dependencies. Without them the run ends in
# PLAYWRIGHT_NOT_INSTALLED and the probe reports a failure that says nothing
# about the export.
if [ -d examples/sample-playwright ]; then
  npm --prefix examples/sample-playwright ci --no-audit --no-fund > /dev/null 2>&1
  EX_RC=$?
  if [ "$EX_RC" -ne 0 ]; then
    npm --prefix examples/sample-playwright install --no-audit --no-fund > /dev/null 2>&1
    EX_RC=$?
  fi
  echo "STEP_EXIT=$EX_RC"
  if [ "$EX_RC" -ne 0 ]; then
    FAILED=1
  fi
fi
rm -rf apps/studio/out apps/studio/.next
npm --prefix apps/studio run build > /dev/null 2>&1
BUILD_RC=$?
echo "STEP_EXIT=$BUILD_RC"
if [ "$BUILD_RC" -ne 0 ]; then
  FAILED=1
fi
if [ ! -f apps/studio/out/index.html ]; then
  echo "the export did not produce index.html"
  FAILED=1
fi
echo ""

step "6. the HTTP export/proxy probe" node tools/ats103-probes/verify-export-and-proxy.mjs
step "7. the browser probe (ui-smoke)" node tools/ats103-probes/ui-smoke.mjs

echo "--- 8. npm test ---"
npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)|^not ok" | head -20
TEST_RC="${PIPESTATUS[0]}"
echo "STEP_EXIT=$TEST_RC"
if [ "$TEST_RC" -ne 0 ]; then
  FAILED=1
fi
echo ""

echo "=== end of $LABEL (overall: $([ "$FAILED" -eq 0 ] && echo OK || echo FAILED)) ==="
exit "$FAILED"
