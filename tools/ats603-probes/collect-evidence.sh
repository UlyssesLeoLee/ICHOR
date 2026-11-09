#!/usr/bin/env bash
# ATS-603: collect the EVIDENCE of the Android runner.
#
# Every log this script writes names THE TREE it was measured on, in its
# first lines. A log that does not say which tree it came from cannot be
# checked against the tree, and a log that cannot be checked is not
# evidence.
#
# The logs land in docs/evidence/ATS-603/ and are the deliverable of this
# task. The tree is the one this script runs in -- the delivery tree, not
# a scratch copy -- so the evidence describes the code that is delivered.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$REPO/docs/evidence/ATS-603"
mkdir -p "$OUT"

export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"

# The tree the evidence was measured on.
TREE="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo 'unknown')"
BRANCH="$(git -C "$REPO" branch --show-current 2>/dev/null || echo 'unknown')"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

header() {
  cat <<EOF
=== ATS-603 evidence ===
tree:    $TREE
branch:  $BRANCH
when:    $STAMP
host:    $(uname -s -r 2>/dev/null || echo windows)
node:    $(node --version 2>/dev/null || echo '?')
EOF
  if [ -n "$ANDROID_HOME" ]; then
    echo "sdk:    $ANDROID_HOME"
  fi
  echo "==="
}

run() {
  # Run a command, capture its output, and write it under a header that
  # names the tree. The exit code is recorded too: a log without it cannot
  # say whether the command passed.
  local name="$1"; shift
  local log="$OUT/$name"
  {
    header
    echo "cmd: $*"
    echo "--- output ---"
    "$@" 2>&1
    echo "--- exit: $? ---"
  } > "$log"
  echo "wrote $log"
}

# --- 01: the environment of the device -----------------------------------
{
  header
  echo "== adb client =="
  "${ANDROID_HOME}/platform-tools/adb.exe" version 2>&1 || echo "(no adb client)"
  echo "== devices =="
  "${ANDROID_HOME}/platform-tools/adb.exe" devices -l 2>&1 || true
  echo "== device properties =="
  "${ANDROID_HOME}/platform-tools/adb.exe" shell getprop ro.build.version.release 2>&1 || true
  "${ANDROID_HOME}/platform-tools/adb.exe" shell getprop ro.build.version.sdk 2>&1 || true
  "${ANDROID_HOME}/platform-tools/adb.exe" shell getprop ro.product.model 2>&1 || true
  echo "== screen =="
  "${ANDROID_HOME}/platform-tools/adb.exe" shell wm size 2>&1 || true
} > "$OUT/01-environment.log"
echo "wrote $OUT/01-environment.log"

# --- 02: the unit tests of the runner ------------------------------------
run "02-unit-tests.log" node --test "$REPO/tests/android-runner.test.mjs"

# --- 03: the integration tests against the REAL device -------------------
run "03-device-it.log" node --test "$REPO/tests/android-runner-it.test.mjs"

# --- 04: the adapter registry --------------------------------------------
run "04-adapter-registry.log" node -e "
import('${REPO}/server/adapters/registry.mjs').then((m) => {
  const project = { id: 'probe', root: process.cwd() };
  const matrix = m.capabilityMatrix(project);
  for (const a of matrix) {
    console.log(a.kind + ':');
    for (const c of a.capabilities) {
      console.log('  ' + c.name + ' -> ' + (c.supported ? 'supported' : 'unsupported')
        + (c.supported ? ' [' + c.evidence + ']' : ' [' + c.reason + ']'));
    }
  }
  console.log('runners: ' + JSON.stringify(m.listRunners()));
});
"

# --- 05: the smoke APP build ---------------------------------------------
run "05-smoke-app-build.log" bash "$HERE/build-smoke-app.sh" "$HERE/build/smoke-app.apk"

# --- 06: the whole test suite --------------------------------------------
run "06-full-test-suite.log" npm --prefix "$REPO" test

# --- 07: the WBS row ------------------------------------------------------
run "07-wbs-row.log" python "$REPO/tools/update_wbs_ats603.py" --verify-only

# --- 08: the checksums ---------------------------------------------------
run "08-checksums.log" python "$REPO/tools/verify_checksums.py"

echo "evidence written to $OUT"
