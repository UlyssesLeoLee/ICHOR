#!/usr/bin/env bash
# ATS-204: the counterexample -- the same tests on the tree BEFORE the task.
#
# A test that cannot fail is not evidence. This script runs the ATS-204
# test file against the tree the work started from (83c8bc5) and shows
# WHICH assertions fail there.
#
# The identity mapper (server/identity.mjs) is copied into the old tree, so
# that the test file loads: the point is to show which assertions fail
# when the WIRING of the task -- the run-side binding, the anchor, the
# matrix -- is absent.
#
# Usage: bash tools/ats204-probes/counterexample.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

BASE_COMMIT="83c8bc50447d8ce2edadf39362be4680c3658429"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "the tree before the task: $BASE_COMMIT"
git clone --no-hardlinks --quiet "$ROOT" "$WORK/tree" 2>/dev/null || {
  echo "the clone failed"
  exit 1
}
cd "$WORK/tree" || exit 1
git checkout --quiet "$BASE_COMMIT" || {
  echo "the checkout of $BASE_COMMIT failed"
  exit 1
}
echo "checked out: $(git log --oneline -1)"
echo

# The mapper is copied in so that the test file can load. The WIRING of the
# task (the run-side binding, the anchor, the matrix) stays absent.
cp "$ROOT/server/identity.mjs" server/identity.mjs
cp "$ROOT/tests/identity.test.mjs" tests/identity.test.mjs

echo "=== node --test tests/identity.test.mjs ==="
node --test tests/identity.test.mjs 2>&1
echo "=== exit code: $? ==="
