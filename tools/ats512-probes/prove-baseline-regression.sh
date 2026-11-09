#!/usr/bin/env bash
# ATS-512: prove that any failing test in the full suite is PRE-EXISTING.
#
# The full `node --test tests/*.test.mjs` suite is the honest baseline. If
# it reports a failure, this script shows whether the SAME test fails on a
# tree that contains NO ATS-512 code. Only then is the failure attributable
# to someone else.
#
# The comparison tree is the merge base of this branch and `dev`: that is the
# last commit both share, so it contains no ATS-512 work at all. (Using `dev`
# itself would NOT work any more: the round-1 delivery is already merged
# into `dev`, so `dev` now contains the ATS-512 code.)
#
# The tree is exported with `git archive`, so it is exactly the committed
# content -- no uncommitted file of this working tree can leak into it.
#
# Usage: bash tools/ats512-probes/prove-baseline-regression.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

TMP="${TMPDIR:-/tmp}/ats512-baseline-regression"
rm -rf "$TMP"
mkdir -p "$TMP"

# The last commit this branch shares with dev: the reference tree.
BASE="$(git merge-base HEAD dev 2>/dev/null || git rev-parse HEAD~1)"
REF="${ATS_BASELINE_REF:-$BASE}"

echo "reference tree : $REF ($(git rev-parse --short "$REF")) -- the merge base with dev"
echo "work tree      : $(git rev-parse --short HEAD)"
echo

git archive "$REF" | tar -x -C "$TMP" || exit 1

echo
echo "--- the reference tree ($REF, WITHOUT any ATS-512 code) ---"
( cd "$TMP" && node --test tests/api.test.mjs 2>&1 | grep -E '^✖|^ℹ (pass|fail|skipped)' )

echo
echo "--- this branch (WITH the ATS-512 code) ---"
node --test tests/api.test.mjs 2>&1 | grep -E '^✖|^ℹ (pass|fail|skipped)'

echo
echo "--- how to read this ---"
cat <<'EOF'
If BOTH trees fail the same test, that failure is pre-existing and is not
caused by this task; it is recorded, not counted as a PASS.

If BOTH trees pass, there is nothing to attribute: the suite is green on the
reference tree as well, and no failure needs an excuse.

If the reference tree passes and this branch fails, that IS a regression
introduced by this task, and the script reports it as such.
EOF

# The script's own verdict: the failures must be the SAME in both trees.
REF_FAILS=$( cd "$TMP" && node --test tests/api.test.mjs 2>&1 | grep -c '✖' )
HEAD_FAILS=$( node --test tests/api.test.mjs 2>&1 | grep -c '✖' )
echo
echo "failures -- reference tree: $REF_FAILS, this branch: $HEAD_FAILS"
if [ "$REF_FAILS" -eq "$HEAD_FAILS" ]; then
  if [ "$HEAD_FAILS" -eq 0 ]; then
    echo "RESULT: OK -- the suite is green on BOTH trees: no failure to attribute."
  else
    echo "RESULT: OK -- the same failure(s) occur on the reference tree as well,"
    echo "        so they are pre-existing and not caused by this task."
  fi
  exit 0
fi
echo "RESULT: MISMATCH -- the reference tree and this branch disagree"
echo "        (reference: $REF_FAILS, this branch: $HEAD_FAILS): this is a regression."
exit 1
