#!/usr/bin/env bash
# ATS-204: the counterexample of the review round 2.
#
# The same tests on the tree the review round 2 rejected (43bb07e). A test
# that cannot fail is not evidence, so this script shows WHICH assertions
# fail when the round-2 fix is absent.
#
# The three assertions this script exists for:
#
#   UT-ATS204-037 (X3)  the static catalogue records the duplicate verdict, so
#                       a single-file run of the DEFAULT (untrusted) path does
#                       not bind a token the catalogue judged duplicated;
#   UT-ATS204-038 (X2s) the verdict is forgotten once the duplicate is gone,
#                       so the token binds again;
#   UT-ATS204-039 (N4)  the anchor does not hand a SOURCE case's uid to a
#                       different case at the same position.
#
# Usage: bash tools/ats204-probes/counterexample-r2.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

# The native `git` does NOT translate MSYS paths, so the repository has to
# be named in the Windows form (`pwd -W`).
NATIVE_ROOT="$(cd "$ROOT" && pwd -W)"

# The tree the review round 2 rejected: the delivery the round-1 review
# accepted (43bb07e).
BASE_COMMIT="43bb07e"
# The scratch directory has to be in the Windows form too: the native `git`
# creates the clone there, and the shell cannot `cd` into an MSYS path that
# does not exist on the Windows side.
WORK="$(mktemp -d 2>/dev/null || mktemp -d -t ats204r2)"
WORK="$(cd "$WORK" && pwd -W)"
rm -rf "$WORK"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

echo "the tree before the round-2 fix: $BASE_COMMIT"
git clone --no-hardlinks --quiet "$NATIVE_ROOT" "$WORK/tree" || {
  echo "the clone of $NATIVE_ROOT failed"
  exit 1
}
cd "$WORK/tree" || exit 1
git checkout --quiet "$BASE_COMMIT" || {
  echo "the checkout of $BASE_COMMIT failed"
  exit 1
}
echo "checked out: $(git log --oneline -1)"
echo

# The test file is copied in so that the NEW assertions run against the OLD
# implementation. The implementation stays as it was at $BASE_COMMIT.
cp "$ROOT/tests/identity.test.mjs" tests/identity.test.mjs

echo "=== node --test tests/identity.test.mjs ==="
node --test tests/identity.test.mjs 2>&1
echo "=== exit code: $? ==="
