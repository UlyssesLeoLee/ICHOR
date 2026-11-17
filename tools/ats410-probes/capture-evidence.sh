#!/usr/bin/env bash
# ATS-410 evidence capture: every log under docs/evidence/ATS-410/ is produced
# by this script, so the evidence can be regenerated from scratch.
#
#   bash tools/ats410-probes/capture-evidence.sh
#
# Each step is recorded with its command and its real output. A step that
# cannot run in this environment is recorded as SKIPPED with the reason -- it
# is never reported as PASS.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/docs/evidence/ATS-410"
mkdir -p "$OUT"
cd "$ROOT"

# The provenance header. Every log records WHICH TREE it describes, so a
# reader can tell without guessing whether a log belongs to the tree that was
# delivered -- the same convention the ATS-307 / ATS-403 logs use.
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NODE="$(node --version 2>/dev/null || echo unknown)"
PLATFORM="$(node -p 'process.platform + " " + process.arch' 2>/dev/null || echo unknown)"

run() {
  local name="$1"; shift
  local log="$OUT/$name.log"
  # The exit code is captured from the command itself, not from the pipeline.
  # A brace group on the left of a pipe runs in a SUBSHELL, so `rc=$?` inside
  # it would never reach the caller and every failing step would be reported
  # as "captured" -- the bug this function had in ATS-101.
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
    echo "ATS-410 evidence log -- $name"
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
  if [ "$rc" -eq 0 ]; then
    printf '  PASS  %s\n' "$name"
  else
    printf '  FAIL  %s (exit %s)\n' "$name" "$rc"
    FAILED=1
  fi
}

FAILED=0

printf '=== ATS-410 evidence capture ===\n'
printf 'repo root : %s\n' "$ROOT"
printf 'commit    : %s\n' "$COMMIT"
printf 'node      : %s\n' "$NODE"
printf '\n'

# 1. The triage unit tests (the core: classification, evidence refs, the
#    suspect-change rules and the read-only boundary).
run "01-triage-unit" node --test tests/triage.test.mjs

# 2. The triage API integration tests (the wiring: the two routes, the
#    refusals and the read-only proof over HTTP).
run "02-triage-api" node --test tests/triage-api.test.mjs

# 3. The boundary probe (the four properties plus the four negative
#    controls).
run "03-triage-boundary" node tools/ats410-probes/probe-triage-boundary.mjs

# 4. The WBS updater: the sheet row must be idempotent -- running it twice
#    must leave the workbook byte-identical, or the note would grow on every
#    run.
run "04-wbs-idempotent" python tools/update_wbs_ats410.py

# 5. The ATS-301 gate: the shared WBS helper, the ADR citation check and the
#    port audit must stay green.
run "05-ats301-gate" bash tools/ats301-probes/check-ats301-gate.sh

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf 'RESULT: OK -- every step exited 0.\n'
  exit 0
fi
printf 'RESULT: MISMATCH -- at least one step did not exit 0.\n'
exit 1
