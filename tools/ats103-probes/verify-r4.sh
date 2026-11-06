set -u
# R4 verification: run the required checks on a clone of the delivery branch.
# Usage: bash verify-r4.sh <clone-dir> <label>
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
echo "--- node / npm ---"
node --version
npm --version
echo ""
echo "--- 1. verify_checksums.py ---"
python tools/verify_checksums.py 2>&1 | tail -5
echo "EXIT=$?"
echo ""
echo "--- 2. the ATS-101 port audit ---"
node tools/ats101-probes/scenario-d-port-audit.mjs 2>&1 | tail -3
echo "EXIT=$?"
echo ""
echo "--- 3. the ADR citation check ---"
python tools/check_adr_citations.py 2>&1 | tail -3
echo "EXIT=$?"
echo ""
echo "--- 4. check-wbs-updaters.sh ---"
bash tools/ats501-probes/check-wbs-updaters.sh 2>&1 | tail -4
echo "EXIT=$?"
echo ""
echo "--- 5. npm test ---"
npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)|^not ok" | head -20
echo ""
echo "=== end of $LABEL ==="
