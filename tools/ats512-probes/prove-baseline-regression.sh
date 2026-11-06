#!/usr/bin/env bash
# ATS-512: prove that the one failing test in the full suite is PRE-EXISTING.
#
# The full `node --test tests/*.test.mjs` suite reports one failure,
# IT-API-013, on this branch. This script shows that the same test fails on a
# tree that contains NO ATS-512 code, therefore the failure is not caused by
# this task.
#
# The comparison tree is `dev` -- the branch this task merges back into. It is
# the honest reference: it contains ATS-103 and ATS-506 (which arrived while
# this task was running) but none of this task's code.
#
# The tree is exported with `git archive`, so it is exactly the committed
# content -- no uncommitted file of this working tree can leak into it.
#
# Usage: bash tools/ats512-probes/prove-baseline-regression.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

REF="${ATS_BASELINE_REF:-dev}"
TMP="${TMPDIR:-/tmp}/ats512-baseline-regression"
rm -rf "$TMP"
mkdir -p "$TMP"

echo "reference tree : $REF ($(git rev-parse --short "$REF"))"
echo "work tree      : $(git rev-parse --short HEAD)"

git archive "$REF" | tar -x -C "$TMP" || exit 1

echo
echo "--- the reference tree ($REF, WITHOUT any ATS-512 code) ---"
( cd "$TMP" && node --test tests/api.test.mjs 2>&1 | grep -E '^✖|^ℹ (pass|fail|skipped)' )

echo
echo "--- this branch (WITH the ATS-512 code) ---"
node --test tests/api.test.mjs 2>&1 | grep -E '^✖|^ℹ (pass|fail|skipped)'

echo
echo "--- why it fails ---"
cat <<'EOF'
examples/sample-playwright/ has no node_modules in this checkout, so the
Playwright adapter reports the required capabilities as unsupported and the
negotiation returns 409 instead of 200. The example project's dependencies
are NOT part of the repository (.gitignore: examples/*/node_modules/), so
this failure depends on whether the example was installed locally -- not on
the product code. It is an ATS-301 environment dependency, not an ATS-512
defect, and it is NOT counted as a PASS.
EOF

# The script's own verdict: the same test must fail in BOTH trees.
echo
REF_FAILS=$( cd "$TMP" && node --test tests/api.test.mjs 2>&1 | grep -c '✖ IT-API-013' )
HEAD_FAILS=$( node --test tests/api.test.mjs 2>&1 | grep -c '✖ IT-API-013' )
if [ "$REF_FAILS" -ge 1 ] && [ "$HEAD_FAILS" -ge 1 ]; then
  echo "RESULT: OK -- IT-API-013 fails on the reference tree as well ($REF_FAILS occurrence(s)),"
  echo '        so it is pre-existing and not caused by this task.'
  exit 0
fi
echo "RESULT: MISMATCH -- the failure is not reproduced on the reference tree"
echo "        (reference: $REF_FAILS, this branch: $HEAD_FAILS)."
exit 1
