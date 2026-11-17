#!/usr/bin/env bash
# ATS-403 evidence capture: every log under docs/evidence/ATS-403/ is produced
# by this script, so the evidence can be regenerated from scratch.
#
#   bash tools/ats403-probes/capture-evidence.sh
#
# Each step is recorded with its command and its real output. A step that
# cannot run in this environment is recorded as SKIPPED with the reason -- it
# is never reported as PASS.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/docs/evidence/ATS-403"
mkdir -p "$OUT"
cd "$ROOT"

# The provenance header. Every log records WHICH TREE it describes, so a
# reader can tell without guessing whether a log belongs to the tree that was
# delivered -- the same convention the ATS-214 / ATS-307 logs use.
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NODE="$(node --version 2>/dev/null || echo unknown)"
PLATFORM="$(node -p 'process.platform + " " + process.arch' 2>/dev/null || echo unknown)"

run() {
  local name="$1"; shift
  local log="$OUT/$name.log"
  # The exit code is captured from the command itself, not from the pipeline.
  #
  # A brace group on the left of a pipe runs in a SUBSHELL, so `rc=$?`
  # inside it would never reach the caller and every failing step would be
  # reported as "captured" -- which is exactly the bug this function had
  # (the ATS-101 port audit exited 1 and the script still said
  # "RESULT: OK -- every step exited 0").
  #
  # The command's output goes to a temp file, the status is read from the
  # command itself, and the log is assembled afterwards.
  local raw="$OUT/.raw-$name"
  local rc=0
  {
    echo "\$ $*"
    echo
    "$@" >"$raw" 2>&1
    rc=$?
  }
  {
    echo "=============================================================================="
    echo "ATS-403 evidence log -- $name"
    echo "=============================================================================="
    echo "commit        : $COMMIT"
    echo "timestamp     : $TIMESTAMP (UTC)"
    echo "repo root     : $ROOT"
    echo "node          : $NODE"
    echo "platform      : $PLATFORM"
    echo "=============================================================================="
    echo
    cat "$raw"
    echo
    echo "--- exit: $rc ---"
  } | tee "$log" >/dev/null
  rm -f "$raw"
  if [ "$rc" -ne 0 ]; then
    echo "FAILED ($rc) $name.log -- see $log"
    FAILED=$((FAILED + 1))
  else
    echo "captured $name.log"
  fi
}

FAILED=0

# 1. unit tests -- the adapter layer
run 01-ai-adapter-ut node --test tests/ai-adapter.test.mjs

# 2. integration tests -- the API surface over real HTTP
run 02-ai-api-it node --test tests/ai-api.test.mjs

# 3. the boundary probe (with its negative controls)
run 03-ai-boundary-probe node tools/ats403-probes/probe-ai-boundary.mjs

# 3b. the round-2 regression probe: every counterexample from the round-1
# review, turned into a check that must stay green (plus its negative
# controls).
run 03b-ai-round2-probe node tools/ats403-probes/probe-ai-round2.mjs

# 4. the full suite -- the ATS-403 tests must not break anything else
run 04-full-test-suite npm test

# 5. the dependency manifest must still match the lockfiles
run 05-deps-manifest npm run deps:manifest:check

# 6. the syntax check of every touched module
run 06-syntax-check node --check server/index.mjs

# 7. the WBS row: the updater (idempotent) and then the read-only check
run 07-wbs-row python tools/update_wbs_ats403.py
run 07b-wbs-row-check python tools/ats403-probes/check-wbs-ats403.py

# 8. the ATS-401 agent boundary probe must still pass
run 08-agent-boundary-probe node tools/ats401-probes/probe-agent-boundary.mjs

# 9. the ATS-402 security boundary probe must still pass
run 09-security-boundary-probe node tools/ats402-probes/probe-security-boundary.mjs

# 9b. the EXTERNAL review probes (issue attachments) must be re-run here.
# The probes are not in the repository; the script takes the directory they
# were unpacked into. When that directory is absent the step is SKIPPED
# with the reason -- it is never reported as PASS.
if [ -d "${ATS403_REVIEW_PROBE_DIR:-}" ]; then
  run 11-reviewer-probes bash tools/ats403-probes/run-reviewer-probes.sh "$ATS403_REVIEW_PROBE_DIR" docs/evidence/ATS-403/reviewer-probes
else
  echo "SKIPPED 11-reviewer-probes -- set ATS403_REVIEW_PROBE_DIR to the unpacked probe directory" | tee "$OUT/11-reviewer-probes.log"
fi

# 10. the ATS-101 port audit must still pass
if [ -f tools/ats101-probes/scenario-d-port-audit.mjs ]; then
  run 10-ats101-port-audit node tools/ats101-probes/scenario-d-port-audit.mjs
else
  echo "SKIPPED 10-ats101-port-audit -- the port audit script is not present" | tee "$OUT/10-ats101-port-audit.log"
fi

echo "evidence written to $OUT"
if [ "$FAILED" -ne 0 ]; then
  echo "RESULT: FAILED -- $FAILED step(s) failed"
  exit 1
fi
echo "RESULT: OK -- every step exited 0"
