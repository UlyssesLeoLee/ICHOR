#!/usr/bin/env bash
# ATS-102 -- the final 8-step acceptance run, on the final tree.
#
# Usage: bash tools/ats102-probes/collect-final-gate.sh
#
# Writes:
#   docs/evidence/ATS-102/15-node22-gate-8-steps-final.log
#
# The run happens in a FRESH CLONE of the current commit, under Node 22, so
# the log describes the committed tree rather than the working directory it
# happens to sit in. The commit recorded in the log is the commit the clone
# was made from.
#
# The script needs a Node 22 tree on the PATH (the npm that ships with it).
# It is located by ATS_NODE22_DIR.

set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EV="${ATS_PROBE_EVIDENCE_DIR:-$ROOT/docs/evidence/ATS-102}"
NATIVE_ROOT="$(cd "$ROOT" && pwd -W 2>/dev/null || pwd)"
NPM10_DIR="${ATS_NODE22_DIR:-/d/hermes-multica/home/cache/scratch/node22/node-v22.23.4-win-x64}"
FINAL_CLONE="${ATS_PROBE_FINAL_CLONE:-D:/hermes-multica/home/cache/scratch/ats102-final-gate-clone}"

mkdir -p "$EV"
rm -rf "$FINAL_CLONE"

{
  echo "=== ATS-102 final acceptance: the 8-step build gate on a clean clone ==="
  echo "clone    : $FINAL_CLONE"
  echo "commit   : $(git -C "$NATIVE_ROOT" rev-parse --short HEAD)  $(git -C "$NATIVE_ROOT" log --oneline -1 --format=%s)"
  echo "node     : $(node --version)"
  echo "npm      : $(npm --version)"
  echo "registry : https://registry.npmjs.org/"
  echo "date     : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  git clone -q --no-hardlinks "$NATIVE_ROOT" "$FINAL_CLONE" 2>&1 | sed 's/^/    /'
  cd "$FINAL_CLONE" || exit 1
  echo "cloned commit : $(git rev-parse --short HEAD)  $(git log --oneline -1 --format=%s)"
  echo
  PATH="/usr/bin:/bin:/mingw64/bin:$NPM10_DIR:/c/Windows/system32:/c/Windows:/c/Windows/System32/Wbem:/c/Windows/System32/WindowsPowerShell/v1.0:/c/Program Files/nodejs"
  export PATH
  export npm_config_registry="https://registry.npmjs.org/"
  echo "node in the gate : $(node --version)"
  echo "npm  in the gate : $(npm --version)"
  echo
  node tools/ci_build_gate.mjs 2>&1
  echo "GATE_EXIT_CODE=$?"
  echo
  echo "--- the working tree after the gate ---"
  git status --short
  echo "git status exit code = $?  (no output above = the gate left no dirty files)"
  git diff --exit-code -- package-lock.json apps/studio/package-lock.json
  echo "lockfile diff exit code = $?  (0 = npm ci did not mutate either lockfile)"
  echo
  echo "--- the digest recorded for this tree ---"
  node tools/tree_digest.mjs --check apps/studio/node_modules 2>&1
  echo "exit code = $?"
} > "$EV/15-node22-gate-8-steps-final.log" 2>&1

printf 'wrote %s\n' "$EV/15-node22-gate-8-steps-final.log"
