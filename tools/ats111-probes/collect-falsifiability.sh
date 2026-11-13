#!/usr/bin/env bash
# Run ONLY the falsifiability step (step 6) of the evidence collection.
# The rest of the collection is unchanged; this is a way to re-run the
# one step without repeating the whole suite.
#
# THE PRE-FIX TREE IS PINNED, NOT SEARCHED
# -----------------------------------------
# The pre-fix tree is the merge commit of the FIRST delivery of ATS-111
# -- the tree the round-1 review rejected. It is a CONSTANT, not a
# `git log --grep` search: a search moves forward as soon as another
# commit whose message mentions ATS-111 is merged, and then this step
# would run the new checks against the FIXED tree, they would all pass,
# and the step would report "the new checks do not discriminate" about a
# tree where nothing was broken. The round-2 review hit exactly that.
#
# `ATS111_PREFIX_COMMIT` overrides the pin, but only with a commit that
# really is in this repository.
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

PREFIX_COMMIT="$(ats111_prefix_commit)" || exit 1
if [ -n "$PREFIX_COMMIT" ]; then
  PREFIX_TREE="$SCRATCH-prefix"
  rm -rf "$PREFIX_TREE"; mkdir -p "$PREFIX_TREE"
  git archive "$PREFIX_COMMIT" | tar -x -C "$PREFIX_TREE"
  cp tools/ats111-probes/st-ats111.mjs "$PREFIX_TREE/tools/ats111-probes/st-ats111.mjs"
  cp apps/studio/lib/workbench-state.mjs "$PREFIX_TREE/apps/studio/lib/workbench-state.mjs"
  if [ ! -d "$PREFIX_TREE/apps/studio/node_modules" ]; then
    cp -r apps/studio/node_modules "$PREFIX_TREE/apps/studio/node_modules" 2>/dev/null
  fi
  if [ ! -d "$PREFIX_TREE/examples/sample-playwright/node_modules" ]; then
    mkdir -p "$PREFIX_TREE/examples/sample-playwright"
    cp -r examples/sample-playwright/node_modules "$PREFIX_TREE/examples/sample-playwright/node_modules" 2>/dev/null
  fi
  if [ -d "$PREFIX_TREE/apps/studio/node_modules" ]; then
    ( cd "$PREFIX_TREE/apps/studio" && node node_modules/next/dist/bin/next build ) > "$OUT/04b-prefix-build.log" 2>&1
    if [ $? -eq 0 ]; then
      ( cd "$PREFIX_TREE" && node tools/ats111-probes/st-ats111.mjs . "$SCRATCH-prefix-st" "examples/sample-playwright/node_modules" ) > "$OUT/04b-prefix-system-test.log" 2>&1
      PREFIX_RESULT="$(grep -oE 'RESULT: [0-9]+/[0-9]+' "$OUT/04b-prefix-system-test.log" | tail -1)"
      PREFIX_FAILS="$(grep -c '^FAIL ' "$OUT/04b-prefix-system-test.log")"
      printf '\n--- the pre-fix tree is %s (%s) ---\n' "$PREFIX_COMMIT" "$(ats111_prefix_label)" >> "$OUT/04b-prefix-system-test.log"
      printf 'the pre-fix result : %s\n' "$PREFIX_RESULT" >> "$OUT/04b-prefix-system-test.log"
      printf 'the failing checks : %s\n' "$PREFIX_FAILS" >> "$OUT/04b-prefix-system-test.log"
      # The check that FAILS the step is not "some check failed" -- it is
      # "the checks that this delivery added are among the failures".
      # A step that passes because an UNRELATED check failed would be a
      # false green, so the failing set is compared against the ids of
      # the view-level checks.
      MISSING=""
      for id in ST-111-10b ST-111-10e ST-111-10g ST-111-11c ST-111-11d \
                ST-111-12a ST-111-12d ST-111-13b ST-111-13c ST-111-13d \
                ST-111-14b ST-111-14d ST-111-16d ST-111-17b; do
        if ! grep -q "^FAIL $id " "$OUT/04b-prefix-system-test.log"; then
          MISSING="$MISSING $id"
        fi
      done
      if grep -q '^FAIL ' "$OUT/04b-prefix-system-test.log" && [ "$PREFIX_FAILS" -gt 0 ]; then
        if [ -n "$MISSING" ]; then
          bad "the pre-fix tree does NOT fail these view-level checks: $MISSING"
        else
          ok "the view-level checks FAIL on the pre-fix tree ($PREFIX_RESULT, $PREFIX_FAILS failing)"
        fi
      else
        bad "the new view-level checks did NOT fail on the pre-fix tree -- they do not discriminate"
      fi
      grep -E '^(FAIL |RESULT:)' "$OUT/04b-prefix-system-test.log" | tail -n 24
    else
      bad 'the pre-fix tree does not build (see 04b-prefix-build.log)'
      tail -n 12 "$OUT/04b-prefix-build.log"
    fi
  else
    bad 'the pre-fix tree has no studio dependencies -- the falsifiability check cannot run'
  fi
else
  bad 'the pre-fix commit could not be resolved (set ATS111_PREFIX_COMMIT)'
fi
exit "$fail"
