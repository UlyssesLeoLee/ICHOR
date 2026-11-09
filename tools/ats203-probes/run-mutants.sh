#!/usr/bin/env bash
# ATS-203: the MUTATION probe of the regression dataset.
#
# WHAT THIS IS FOR
# ----------------
# The first delivery of this dataset was rejected twice because its
# assertions had no discriminating power: a dataset that passes under a
# broken index proves nothing. This script is the check that the dataset
# really pins the behaviour down.
#
# It applies one mutant at a time to a COPY of the tree and runs the
# delivered dataset against the mutant. A dataset with discriminating power
# MUST FAIL on every mutant:
#
#   * M1 (the ambiguity is not attached)      -> the dataset MUST fail;
#   * M2 (the template titles are dropped)    -> the dataset MUST fail;
#   * M3 (the static scan returns nothing)    -> every case that touches the
#                                               static index MUST fail;
#   * M4 (the template is claimed stable)      -> the dataset MUST fail. This
#                                               is the ORIGINAL defect.
#
# The baseline (no mutation) MUST PASS -- otherwise the mutants prove
# nothing either.
#
# USAGE
# -----
#   cd tools/ats203-probes
#   ./run-mutants.sh                 # the dataset file of the repo
#   ./run-mutants.sh <test-file>     # another dataset
#
# The tree under test is snapshotted into `base/` first:
#   git archive HEAD server package.json <test-file> | tar -x -C base
#
# The script prints a RESULT line at the end:
#   RESULT: OK      -- the baseline passed and every mutant was caught
#   RESULT: FAILED  -- the baseline failed or a mutant slipped through
set -u
cd "$(dirname "$0")"

DATASET="${1:-tests/ats203-regression-dataset.test.mjs}"
REPO_ROOT=$(cd ../.. && pwd)

if [ ! -f "$REPO_ROOT/$DATASET" ]; then
  echo "no such dataset: $DATASET" >&2
  exit 2
fi

# The REAL Playwright the fixtures need. The snapshot has no node_modules of
# its own, so the environment variable of the dataset points at the
# repository's own example project.
if [ -z "${ATS203_PLAYWRIGHT_MODULES:-}" ]; then
  for c in "$REPO_ROOT/examples/sample-playwright/node_modules" "D:/ICHOR/examples/sample-playwright/node_modules"; do
    if [ -f "$c/@playwright/test/cli.js" ]; then
      export ATS203_PLAYWRIGHT_MODULES="$c"
      break
    fi
  done
fi

echo "### dataset   : $DATASET"
echo "### playwright: ${ATS203_PLAYWRIGHT_MODULES:-<none>}"
echo

# --- the snapshot under test ------------------------------------------------
# The tree under test is the WORKING TREE, not a commit: a dataset that is
# not committed yet has to be testable too. `server/` and `package.json` come
# from HEAD (they are the product code), and the dataset file is COPIED
# from the working tree.
rm -rf base
mkdir -p base
# The `cd` is a shell builtin, so it takes the MSYS path; `git` then runs in
# that directory without needing a path argument it cannot translate.
if ! (cd "$REPO_ROOT" && git archive HEAD server package.json tests/helpers) | tar -x -C base; then
  echo "could not build the base snapshot" >&2
  exit 2
fi
mkdir -p "base/$(dirname "$DATASET")"
cp "$REPO_ROOT/$DATASET" "base/$DATASET"

# run_dataset <dir> -> prints "pass=<n> fail=<n>" on the first line, then the
# failing test names.
run_dataset() {
  local r p f
  r=$(cd "$1" && node --test "$DATASET" 2>&1)
  p=$(echo "$r" | grep -E '^. pass ' | head -1 | grep -oE '[0-9]+' | head -1)
  f=$(echo "$r" | grep -E '^. fail ' | head -1 | grep -oE '[0-9]+' | head -1)
  echo "${p:-0} ${f:-0}"
  echo "$r" | grep -E '^✖' | sed 's/^/   /' | grep -v '^   ✖ failing tests' | sort -u | head -20
}

FAILED=0

echo "### baseline (no mutation)"
read -r bp bf <<<"$(run_dataset base | head -1)"
echo "== baseline: pass=$bp fail=$bf"
if [ "$bf" != "0" ]; then
  echo "!! the BASELINE does not pass -- the mutants would prove nothing"
  run_dataset base | tail -n +2
  echo
  echo "RESULT: FAILED"
  exit 1
fi

for M in M1-ambiguity-off M2-template-titles-dropped M3-index-returns-nothing M4-template-claimed-stable; do
  rm -rf "m-$M"
  cp -r base "m-$M"
  # The path is RELATIVE on purpose: the native Python does not understand
  # the MSYS path of the repository root, but it does understand a relative
  # one, and the script has already changed into its own directory.
  if ! python mutants.py "m-$M" "$M"; then
    echo "== mutant $M: THE PATCH DID NOT APPLY"
    FAILED=1
    continue
  fi
  read -r p f <<<"$(run_dataset "m-$M" | head -1)"
  echo "== mutant $M: pass=$p fail=$f"
  if [ "$f" = "0" ]; then
    echo "!! $M WAS NOT CAUGHT"
    FAILED=1
  fi
  run_dataset "m-$M" | tail -n +2
  echo
done

if [ "$FAILED" = "0" ]; then
  echo "RESULT: OK -- the baseline passed and every mutant was caught"
else
  echo "RESULT: FAILED -- a mutant slipped through, or the baseline failed"
fi
exit $FAILED
