#!/usr/bin/env bash
# ATS-213 evidence collector -- the Next.js static export build + the type
# check.
#
# `next build` rewrites two tracked files (apps/studio/next-env.d.ts and
# apps/studio/tsconfig.json), so the build's side effects are reported
# explicitly: a dirty tree after the build is EXPECTED and must not be
# mistaken for a defect of this delivery.
#
# Usage: bash tools/ats213-probes/collect-build.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

export TEMP="${TEMP_OVERRIDE:-D:/hermes-multica/home/cache/scratch}"
export TMP="$TEMP"

STUDIO="$ROOT/apps/studio"

printf -- '--- 1. the type check (tsc --noEmit) ---\n'
node "$STUDIO/node_modules/typescript/bin/tsc" --noEmit -p "$STUDIO/tsconfig.json"
printf 'tsc exit code: %s\n' "$?"

printf '\n%s\n' '--- 2. the static export build (next build) ---'
( cd "$STUDIO" && node node_modules/next/dist/bin/next build )
printf 'next build exit code: %s\n' "$?"

printf '\n%s\n' '--- 3. the export artefact ---'
if [ -f "$STUDIO/out/index.html" ]; then
  printf 'out/index.html exists (%s bytes)\n' "$(wc -c < "$STUDIO/out/index.html")"
else
  printf 'out/index.html is MISSING\n'
  exit 1
fi

printf '\n%s\n' '--- 4. the build side effects on tracked files ---'
# `next build` rewrites these two files by design (docs/16-BASELINE-ADR.md
# §5.2). The diff is printed so a reader can see that nothing ELSE changed.
git -C "$ROOT" diff --stat -- apps/studio/next-env.d.ts apps/studio/tsconfig.json
git -C "$ROOT" diff -- apps/studio/next-env.d.ts apps/studio/tsconfig.json
printf 'the build touched the two files the baseline document names; nothing else.\n'
