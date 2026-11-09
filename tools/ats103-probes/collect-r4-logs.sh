#!/usr/bin/env bash
# Assemble the four R4 clone-verification logs into docs/evidence/ATS-103/.
#
# Each log is produced by tools/ats103-probes/verify-r4.sh run against a
# CLONE (never the working tree): the checks face COMMITTED files, so only a
# clone reproduces the situation a reviewer sees. Two clones per tree, one
# with the Windows default checkout (CRLF) and one with core.autocrlf=false
# (LF), because the checkout style changes the bytes the checks hash.
#
# Usage: bash tools/ats103-probes/collect-r4-logs.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

OUT="docs/evidence/ATS-103"
SCRATCH="${ATS103_R4_SCRATCH:-D:/hermes-multica/home/cache/scratch/tmp}"
mkdir -p "$OUT"

# The four verifications, in the order the document lists them.
#   <source-repo>  <clone-dir>  <log-label>  <branch>
RUNS=(
  "$ROOT|branch-crlf|10-r4-branch-clone-verification-crlf.log|agent/m3/seikoist-148"
  "$ROOT|branch-lf|10-r4-branch-clone-verification-lf.log|agent/m3/seikoist-148"
  "D:/ICHOR|dev-crlf|11-r4-dev-clone-verification-crlf.log|dev"
  "D:/ICHOR|dev-lf|11-r4-dev-clone-verification-lf.log|dev"
)

FAILED=0
for spec in "${RUNS[@]}"; do
  IFS='|' read -r src label logfile branch <<< "$spec"
  clone="$SCRATCH/r4v-$label"

  # `git clone` is a NATIVE program on Windows and does not understand the
  # MSYS path form, so the source is converted to its Windows form first.
  # (The clone destination is already a Windows path.)
  src_native="$(cd "$src" && pwd -W)"

  echo "=== $label : cloning $branch from $src_native ==="
  rm -rf "$clone"
  if [ "$label" = "branch-lf" ] || [ "$label" = "dev-lf" ]; then
    git -c core.autocrlf=false clone --no-hardlinks --branch "$branch" "$src_native" "$clone"
  else
    git clone --no-hardlinks --branch "$branch" "$src_native" "$clone"
  fi
  if [ $? -ne 0 ]; then
    echo "the clone of $branch from $src_native FAILED" >&2
    FAILED=1
    continue
  fi

  echo "=== $label : running verify-r4.sh ==="
  if bash tools/ats103-probes/verify-r4.sh "$clone" "$label" > "$OUT/$logfile" 2>&1; then
    echo "    $logfile : all steps green"
  else
    echo "    $logfile : FAILED (see the log)" >&2
    FAILED=1
  fi
  rm -rf "$clone"
done

if [ "$FAILED" -ne 0 ]; then
  echo "at least one R4 verification did not pass -- the evidence is NOT trustworthy" >&2
  exit 1
fi

echo "the four R4 clone-verification logs are in $OUT"
