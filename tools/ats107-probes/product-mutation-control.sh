#!/usr/bin/env bash
# The PRODUCT mutation control of ATS-107: does the probe catch a real
# product defect on the REAL chain?
#
#   bash tools/ats107-probes/product-mutation-control.sh
#
# WHAT IT PROVES
# --------------
# `mutation-check.mjs` proves the comparison LOGIC has teeth. That is not
# enough: the probe could still pass against a broken product if the
# comparison never saw the broken output. So this control mutates the
# PRODUCT ITSELF (in a throw-away copy of the tree), runs the real probe
# against it, and requires the probe to FAIL.
#
# The mutation is P1: the Bridge truncates the error message it reports
# (`server/execution/model.mjs`), keeping the first line and the assertion
# text but dropping `Received:`, the timeout and the call log.
#
#   P1 (truncation) is caught by the FULL-TEXT equality of ST-5.
#
# The product source is restored afterwards. Nothing here commits anything.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

SCRATCH="${ATS107_SCRATCH:-$ROOT/.ats107-product-mutation}"
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"

MUTATED="$SCRATCH/tree"
# `git archive` exports the COMMITTED tree, so the mutation is applied to a
# faithful copy and never to the working tree. The probe and its libraries
# are then copied over from the WORKING tree, so the control exercises the
# probe as it is now -- the committed tree would still hold the old one.
mkdir -p "$MUTATED"
git archive HEAD | tar -x -C "$MUTATED"
cp -r "$ROOT/tools/ats107-probes/." "$MUTATED/tools/ats107-probes/"
# The probe checks that the fixture's lockfile is COMMITTED, and the product
# asks git for the project's commit. An exported tree has no repository, so
# the copy gets one of its own.
( cd "$MUTATED" && git init -q && git add -A && git -c user.name=probe -c user.email=probe@example.invalid commit -q -m "exported tree" )

echo "=== ATS-107 product mutation control (P1: the Bridge truncates the error message) ==="
echo "mutated tree : $MUTATED"
echo ""

# --- apply P1 to the PRODUCT SOURCE in the copy ----------------------------
python - "$MUTATED/server/execution/model.mjs" <<'PYEOF'
import sys
target = sys.argv[1]
src = open(target, encoding='utf-8').read()
old = "error: r.error?.message || '',"
new = ("error: String(r.error?.message || '').split('\\n')"
       ".filter((l, i) => i === 0 || l.includes('Expected:')).join('\\n'),")
if old not in src:
    print('MUTATION TARGET NOT FOUND -- the product source changed shape')
    sys.exit(2)
if new in src:
    print('the mutation is already applied')
else:
    open(target, 'w', encoding='utf-8').write(src.replace(old, new, 1))
    print('P1 applied: the Bridge now truncates the error message it reports')
PYEOF
if [ $? -ne 0 ]; then
  echo "RESULT: FAIL -- the mutation could not be applied"
  exit 1
fi
echo ""

# --- run the REAL probe against the MUTATED product ------------------------
echo "--- the probe against the mutated product (it must FAIL) ---"
( cd "$MUTATED" && node tools/ats107-probes/st-ats107.mjs . "$SCRATCH/scratch" 2>&1 ) | tee "$SCRATCH/mutated-probe.log"
PROBE_RC="${PIPESTATUS[0]}"
echo "probe exit code: $PROBE_RC"
echo ""

if [ "$PROBE_RC" -eq 0 ]; then
  echo "RESULT: FAIL -- the probe ACCEPTED the truncated error message"
  rm -rf "$SCRATCH"
  exit 1
fi
if ! grep -q "the error message is not the CLI's own" "$SCRATCH/mutated-probe.log"; then
  echo "RESULT: FAIL -- the probe failed, but not on the truncated error message"
  rm -rf "$SCRATCH"
  exit 1
fi
echo "RESULT: OK -- the probe REJECTED the product that truncates the error message (P1 caught)"

# --- and against the UNMUTATED tree, the probe must still pass ------------
echo ""
echo "--- the probe against the unmutated tree (it must PASS) ---"
( cd "$ROOT" && node tools/ats107-probes/st-ats107.mjs . "$SCRATCH/scratch-clean" 2>&1 ) | tail -5
CLEAN_RC="${PIPESTATUS[0]}"
echo "probe exit code: $CLEAN_RC"
rm -rf "$SCRATCH"

if [ "$CLEAN_RC" -ne 0 ]; then
  echo "RESULT: FAIL -- the probe rejected the unmutated product"
  exit 1
fi
echo ""
echo "RESULT: OK -- P1 is caught on the real chain, and the unmutated product still passes"
