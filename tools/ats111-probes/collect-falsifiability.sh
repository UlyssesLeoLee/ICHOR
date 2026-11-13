#!/usr/bin/env bash
# Run ONLY the falsifiability step (step 6) of the evidence collection.
# The rest of the collection is unchanged; this is a way to re-run the
# one step without repeating the whole suite.
#
# THE BASELINES ARE PINNED, NOT SEARCHED
# ---------------------------------------
# The step runs the CURRENT system test against the two trees the review
# rounds rejected, and asserts that the checks bound to each of them go
# RED there:
#
#   BASELINE A (cb742ca) -- the first delivery. The round-1 defects.
#   BASELINE B (9e305e7) -- the second delivery. The round-2 defects.
#
# They are pinned COMMIT IDS, not `git log --grep` searches: a search
# moves forward as soon as another commit whose message mentions ATS-111
# is merged, and then this step would run the new checks against the
# FIXED tree, they would all pass, and the step would report "the new
# checks do not discriminate" about a tree where nothing was broken.
# The round-2 review hit exactly that.
#
# Each check is bound to the baseline it has to fail on. The bindings
# live in tools/ats111-probes/lib/pre-fix-commit.sh -- the single place
# that says which defect each check is the evidence for.
#
# `ATS111_BASELINE_A` / `ATS111_BASELINE_B` override a baseline, but
# only with a commit that really is in this repository.
set -u
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
export NODE_OPTIONS=--max-old-space-size=2048

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

# shellcheck source=tools/ats111-probes/lib/pre-fix-commit.sh
. "$ROOT/tools/ats111-probes/lib/pre-fix-commit.sh"

SCRATCH="${1:-C:/Users/seiko/ats111-evidence}"
OUT="docs/evidence/ATS-111"
mkdir -p "$OUT"

fail=0
ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }
step() { printf '\n=== %s ===\n' "$1"; }

# Run the system test against one baseline tree and report which of the
# bound checks failed there.
#
# The bound ids are the ones the baseline is SUPPOSED to fail. A bound
# check that PASSES on the baseline is the problem this step exists to
# find: the check does not discriminate.
run_baseline() {
  local which="$1"
  local commit label tree log
  commit="$(ats111_baseline_commit "$which")" || return 1
  label="$(ats111_baseline_label "$which")"
  tree="$SCRATCH-prefix-$which"
  log="$OUT/04b-prefix-system-test-$which.log"

  rm -rf "$tree"; mkdir -p "$tree"
  git archive "$commit" | tar -x -C "$tree"
  # The CURRENT probe and the CURRENT model are used against the OLD
  # code: the checks are new, the code is old. That is the point.
  cp tools/ats111-probes/st-ats111.mjs "$tree/tools/ats111-probes/st-ats111.mjs"
  cp apps/studio/lib/workbench-state.mjs "$tree/apps/studio/lib/workbench-state.mjs"
  # The tree needs the dependency tree inside it (Turbopack refuses to
  # resolve packages outside its workspace root).
  if [ ! -d "$tree/apps/studio/node_modules" ]; then
    cp -r apps/studio/node_modules "$tree/apps/studio/node_modules" 2>/dev/null
  fi
  # The FIXTURE's dependencies are not in the archive -- they are not
  # under version control. The system test copies the fixture into its
  # scratch and runs a REAL engine with it, so the dependencies have to
  # be there.
  if [ ! -d "$tree/examples/sample-playwright/node_modules" ]; then
    mkdir -p "$tree/examples/sample-playwright"
    cp -r examples/sample-playwright/node_modules "$tree/examples/sample-playwright/node_modules" 2>/dev/null
  fi
  if [ ! -d "$tree/apps/studio/node_modules" ]; then
    printf '  FAIL  the baseline %s tree has no studio dependencies -- the falsifiability check cannot run\n' "$label"
    return 1
  fi

  step "the baseline tree $label ($which) is built and probed"
  ( cd "$tree/apps/studio" && node node_modules/next/dist/bin/next build ) > "$OUT/04b-prefix-build-$which.log" 2>&1
  if [ $? -ne 0 ]; then
    printf '  FAIL  the baseline tree %s does not build (see 04b-prefix-build-%s.log)\n' "$label" "$which"
    tail -n 12 "$OUT/04b-prefix-build-$which.log"
    return 1
  fi
  ( cd "$tree" && node tools/ats111-probes/st-ats111.mjs . "$SCRATCH-prefix-st-$which" "examples/sample-playwright/node_modules" ) > "$log" 2>&1

  local result fails missing
  result="$(grep -oE 'RESULT: [0-9]+/[0-9]+' "$log" | tail -1)"
  fails="$(grep -c '^FAIL ' "$log")"
  printf '\n--- the baseline tree is %s (%s) ---\n' "$commit" "$label" >> "$log"
  printf 'the baseline result : %s\n' "$result" >> "$log"
  printf 'the failing checks : %s\n' "$fails" >> "$log"

  # The bound checks are the ones this baseline is SUPPOSED to fail. A
  # bound check that PASSES here does not discriminate, and the step
  # fails -- an unrelated failure is not a substitute.
  missing=""
  for id in $(ats111_required_fail_ids "$which"); do
    if ! grep -q "^FAIL $id " "$log"; then
      missing="$missing $id"
    fi
  done
  if [ -n "$missing" ]; then
    printf '  FAIL  the baseline %s does NOT fail these checks: %s\n' "$label" "$missing"
    return 1
  fi
  printf '  PASS  the checks bound to the baseline %s all FAIL there (%s, %s failing)\n' \
    "$label" "$result" "$fails"
  grep -E '^(FAIL |RESULT:)' "$log" | tail -n 24
  return 0
}

# --- BASELINE A: the first delivery, the round-1 defects ----------------
if ! run_baseline A; then
  fail=1
fi

# --- BASELINE B: the second delivery, the round-2 defects ----------------
if ! run_baseline B; then
  fail=1
fi

exit "$fail"
