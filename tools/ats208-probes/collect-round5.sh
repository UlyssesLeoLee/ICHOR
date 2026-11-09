#!/usr/bin/env bash
# ATS-208 -- the evidence of the FIFTH review round.
#
# The fourth review rejected the delivery with ONE mandatory item (R2):
# the manifest CHECKSUMS.sha256 has to be recomputed AFTER the last ATS-208
# commit and merged into dev. The reviewer checks exactly two things:
#
#   1. `python tools/verify_checksums.py` prints RESULT: OK on the dev tip,
#      and `tracked-not-listed` carries no ATS-208 file;
#   2. server/execution/model.mjs and server/adapters/wdio.mjs have not
#      changed since 4ff5c36 -- or the `wdio-skip` probe is re-run.
#
# This script collects the evidence for both, plus the regression and the
# gates, over the tree that is actually delivered.
#
# The probes of the review are INPUT: they arrive as issue attachments
# (ats208-r1-probes.zip, ats208-r2-probes.zip, ats208-r3-probes.zip) and are
# NOT deliverables, so they are not checked in. Unpack them into a directory
# laid out like this:
#
#   <probe-dir>/r1/probes/*.mjs        <probe-dir>/r1/fixtures/*
#   <probe-dir>/r2/probes-r2/*.mjs
#   <probe-dir>/r3/probes-r3/*.mjs
#
# The fixture dependency trees (examples/sample-playwright/node_modules and
# examples/sample-wdio/node_modules) are NOT part of the repository; install
# them in the measured tree, or the IT cases that need a real engine will
# skip instead of run.
#
# usage: bash tools/ats208-probes/collect-round5.sh <tree> <probe-dir>
set -uo pipefail

TREE="$1"
PROBES="$2"
PROBES_NATIVE="$(cd "$PROBES" && pwd -W 2>/dev/null || echo "$PROBES")"
cd "$TREE" || exit 1

export TMPDIR="${TMPDIR:-/tmp}"
mkdir -p "$TMPDIR"

hdr() {
  echo
  echo "=============================================================="
  echo "$*"
  echo "=============================================================="
}

hdr "the tree under test"
echo "tree    : $(pwd -W 2>/dev/null || pwd)"
echo "commit  : $(git rev-parse HEAD)"
echo "branch  : $(git branch --show-current)"
echo "node    : $(node --version)"
echo "python  : $(python --version 2>&1)"

# --- R2 item 1: the manifest on the delivered tree ------------------------
hdr "R2.1 -- python tools/verify_checksums.py on the delivered tree"
python tools/verify_checksums.py 2>&1
echo "exit code : $?"

# The manifest must list every ATS-208 evidence file, and the ATS-208 files
# must not have changed since the fourth review baseline.
hdr "R2.1b -- the ATS-208 evidence files in the manifest"
echo "tracked ATS-208 evidence files : $(git ls-files 'docs/evidence/ATS-208/' | wc -l)"
echo "listed in CHECKSUMS.sha256      : $(grep -c 'docs/evidence/ATS-208/' CHECKSUMS.sha256)"
git ls-files 'docs/evidence/ATS-208/' | while read -r f; do
  if grep -q -- "  $f" CHECKSUMS.sha256; then
    echo "  listed    : $f"
  else
    echo "  NOT LISTED: $f"
  fi
done

# --- R2 item 2: the two server files have not changed since 4ff5c36 ------
hdr "R2.2 -- the server files since the fourth review baseline 4ff5c36"
git log --oneline 4ff5c36..HEAD -- server/execution/model.mjs server/adapters/wdio.mjs
echo "(no line above means: unchanged since 4ff5c36)"

# --- the probes of the review --------------------------------------------
hdr "the probes of the review on the delivered tree"
SCRATCH="$TMPDIR/ats208-r5-probes"
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
[ -f "$PROBES/r1/fixtures/pw-report.json" ] && cp "$PROBES/r1/fixtures/pw-report.json" "$SCRATCH/pw-report.json"
if [ -d "$PROBES/r1/fixtures/pwproj2" ]; then
  cp -r "$PROBES/r1/fixtures/pwproj2" "$SCRATCH/pwproj2"
  mkdir -p "$SCRATCH/pwproj2/node_modules"
  for m in @playwright playwright playwright-core; do
    [ -d "examples/sample-playwright/node_modules/$m" ] && cp -r "examples/sample-playwright/node_modules/$m" "$SCRATCH/pwproj2/node_modules/"
  done
fi

run_probe() { # run_probe <label> <script> <args...>
  local label="$1"; shift
  echo
  echo "--- $label ---"
  node "$@" 2>&1
  echo "exit code : $?"
}

TREE_NATIVE="$(pwd -W)"
run_probe "pw-semantics: does the model agree with the Playwright verdict?" \
  "$PROBES_NATIVE/r1/probes/pw-semantics.mjs" "$TREE_NATIVE" "$SCRATCH/pw-report.json"
run_probe "startup-robustness: does the Bridge start when the log is damaged?" \
  "$PROBES_NATIVE/r1/probes/startup-robustness.mjs" "$TREE_NATIVE" "$SCRATCH/sr"
run_probe "wdio-check: does the WDIO side merge a re-executed case?" \
  "$PROBES_NATIVE/r1/probes/wdio-check.mjs" "$TREE_NATIVE"
run_probe "bridge-e2e: the Bridge end to end with a real Playwright" \
  "$PROBES_NATIVE/r1/probes/bridge-e2e.mjs" "$TREE_NATIVE" "$SCRATCH/pwproj2" "$SCRATCH/e2e"
run_probe "wdio-dup: does the WDIO merge hide a failure?" \
  "$PROBES_NATIVE/r2/probes-r2/wdio-dup.mjs" "$TREE_NATIVE"
run_probe "verdict-unknown: does an unknown verdict become passed?" \
  "$PROBES_NATIVE/r2/probes-r2/verdict-unknown.mjs" "$TREE_NATIVE"
run_probe "replay-contract: does the replay report lost or reused numbers?" \
  "$PROBES_NATIVE/r2/probes-r2/replay-contract.mjs" "$TREE_NATIVE"
run_probe "wdio-skip: must a skipped attempt turn a failure into a pass?" \
  "$PROBES_NATIVE/r3/probes-r3/wdio-skip.mjs" "$TREE_NATIVE"

# --- the ATS-208 suites ---------------------------------------------------
hdr "the ATS-208 unit and integration suites"
node --test tests/execution-model.test.mjs tests/execution-model-it.test.mjs 2>&1 | tail -12

# --- the full regression --------------------------------------------------
hdr "the full node test suite"
npm test 2>&1 | tail -10

# --- the gates ------------------------------------------------------------
hdr "the ATS-301 gate"
bash tools/ats301-probes/check-ats301-gate.sh 2>&1 | tail -8

hdr "the python gates under tools/"
python -m pytest tools/ -q 2>&1 | tail -4

hdr "done"
