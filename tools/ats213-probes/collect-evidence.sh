#!/usr/bin/env bash
# ATS-213 evidence collector -- OS Keychain / Windows Credential Manager 集成
#
# It runs every verification step of this delivery and writes ONE log per
# step under docs/evidence/ATS-213/. Every step's exit code is taken
# IMMEDIATELY after the command (an `echo` after a command would report the
# exit code of the echo, not of the command).
#
# Usage: bash tools/ats213-probes/collect-evidence.sh
#
# The steps are:
#   01  the credential status unit tests (the closed status vocabulary)
#   02  the credential status integration tests over HTTP
#   03  the SAME integration tests against the REAL Windows Credential Manager
#   04  the credential-reference integration tests (a run resolves a reference)
#   05  the ATS-402 security tests (the credential store must not regress)
#   06  the boundary probe (no secret in argv / files / logs / responses)
#   07  the Next.js static export build + tsc --noEmit
#   08  the system test in a REAL browser (the status is visible in the UI)
#   09  the credential-reference system test (a REAL Playwright run reads it)
#   10  the failure-path system test (the store unreachable / the read fails)
#   11  the mutants (the new checks go RED when the defect is back)
#   12  the boundary unit tests (the choke point + the redaction)
#   13  the redaction integration test (a real run, a failing assertion)
#   14  the redaction mutants (the new checks go RED when the defect is back)
#   15  the ATS-301 gate (WBS helper + ADR citations + port audit)
#   16  the full repository regression suite
#   17  the WBS row update and the checksum manifest
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

OUT="$ROOT/docs/evidence/ATS-213"
mkdir -p "$OUT"

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
# The temporary artefacts go to D: -- the C: pagefile is capped at 8 GB and
# a full C: makes unrelated processes die with 0xc0000409.
export TEMP="${TEMP_OVERRIDE:-D:/hermes-multica/home/cache/scratch}"
export TMP="$TEMP"

step=0
run_step() {
  # $1 = the log's basename, $2 = the human name, rest = the command
  step=$((step + 1))
  local name="$1"; shift
  local label="$1"; shift
  local log="$OUT/$(printf '%02d' "$step")-$name.log"
  {
    echo "================================================================================"
    echo "ATS-213 evidence log -- $label"
    echo "================================================================================"
    echo "commit        : $(git rev-parse HEAD)"
    echo "timestamp     : $(date -u +%Y-%m-%dT%H:%M:%SZ) (UTC)"
    echo "repo root     : $ROOT"
    echo "node          : $(node --version 2>&1)"
    echo "python        : $(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
    echo "stdout enc    : $(python -c 'import sys; print(sys.stdout.encoding)' 2>&1) (forced: PYTHONUTF8=$PYTHONUTF8 PYTHONIOENCODING=$PYTHONIOENCODING)"
    echo "platform      : $(node -p 'process.platform + " " + process.arch')"
    echo "command       : $*"
    echo "================================================================================"
    echo ""
  } > "$log"
  "$@" >> "$log" 2>&1
  local code=$?
  echo "" >> "$log"
  echo "--- exit code: $code ---" >> "$log"
  echo "[$(printf '%02d' "$step")] $label -> exit $code ($log)"
  return 0
}

run_step "credential-status-ut" "the credential status unit tests" \
  node --test tests/credential-status.test.mjs

run_step "credential-status-api-it" "the credential status integration tests" \
  node --test tests/credential-status-api.test.mjs

run_step "credential-status-api-it-real-store" "the SAME integration tests against the REAL Windows Credential Manager" \
  env ATS213_REAL_CREDENTIAL_STORE=1 node --test tests/credential-status-api.test.mjs

run_step "credential-reference-it" "the credential-reference integration tests (a run resolves a reference, or is refused)" \
  node --test tests/credential-reference-api.test.mjs

run_step "security-regression" "the ATS-402 security tests (the credential store must not regress)" \
  node --test tests/security.test.mjs tests/security-credentials.test.mjs tests/security-gate.test.mjs tests/security-api.test.mjs

run_step "credential-boundary-probe" "the boundary probe: no secret in argv / files / logs / responses" \
  node tools/ats213-probes/probe-credential-boundary.mjs

# The build comes BEFORE the browser steps: the system tests drive the
# static export, and an export that was not built is a missing page, not a
# defect of the delivery.
run_step "next-build" "the Next.js static export build" \
  bash tools/ats213-probes/collect-build.sh

run_step "system-test" "the system test in a REAL browser (the status is visible in the UI)" \
  node tools/ats213-probes/st-ats213.mjs "$OUT/ui"

run_step "credential-reference-st" "the credential-reference system test (a REAL Playwright run reads the injected secret)" \
  node tools/ats213-probes/st-credential-ref.mjs "$OUT/ref"

run_step "status-failures-st" "the failure-path system test (the store unreachable / the status read fails)" \
  node tools/ats213-probes/st-credential-status-failures.mjs "$OUT/failures"

run_step "status-mutants" "the mutants: the new checks go RED when the defect is back" \
  node tools/ats213-probes/probe-credential-status-mutants.mjs

# The boundary unit tests: the choke point (P2) and the redaction (P3).
run_step "credential-boundaries-ut" "the boundary unit tests (the choke point + the redaction)" \
  node --test tests/credential-reference-boundaries.test.mjs

# The redaction integration test: a REAL run whose assertion fails, against
# the REAL Windows Credential Manager. The secret must not reach the disk.
run_step "credential-redaction-it" "the redaction integration test (a real run, a failing assertion)" \
  env ATS213_REAL_CREDENTIAL_STORE=1 node --test tests/credential-redaction-api.test.mjs

# The mutants of the new checks: they must go RED when the defect is back.
run_step "credential-redaction-mutants" "the redaction mutants: the new checks go RED when the defect is back" \
  node tools/ats213-probes/probe-credential-redaction-mutants.mjs

run_step "quality-gates" "the ATS-301 gate (WBS helper + ADR citations + port audit)" \
  bash tools/ats301-probes/check-ats301-gate.sh

run_step "full-regression" "the full repository regression suite" \
  node --test --test-concurrency=2 tests/*.test.mjs

run_step "wbs-row-and-checksums" "the WBS row and the checksum manifest" \
  bash tools/ats213-probes/collect-wbs-and-checksums.sh

echo ""
echo "RESULT: the evidence is in $OUT"
ls -1 "$OUT"/*.log 2>/dev/null | sed 's/^/  /'
