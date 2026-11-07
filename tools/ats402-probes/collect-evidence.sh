#!/usr/bin/env bash
# ATS-402 evidence collection: run every check this task claims to have made
# and write its ACTUAL output into docs/evidence/ATS-402/.
#
# The point is reproducibility: a PASS is only meaningful together with the
# environment that produced it, so each log records the commit, the
# timestamp, the Node/Python versions and (for Python) the stdout encoding.
#
# Usage: bash tools/ats402-probes/collect-evidence.sh
set -u

# --- force UTF-8 for every Python invocation in this script ---------------
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

OUT="docs/evidence/ATS-402"
mkdir -p "$OUT"

NODE_VERSION="$(node --version 2>&1)"
PY_VERSION="$(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
PY_STDOUT_ENCODING="$(python -c 'import sys; print(sys.stdout.encoding)' 2>&1)"
COMMIT="$(git rev-parse HEAD 2>&1)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>&1)"

header() {
  cat <<EOF
================================================================================
ATS-402 evidence log -- $1
================================================================================
commit        : $COMMIT
timestamp     : $STAMP (UTC)
repo root     : $ROOT
node          : $NODE_VERSION
python        : $PY_VERSION
stdout enc    : $PY_STDOUT_ENCODING (forced: PYTHONUTF8=$PYTHONUTF8 PYTHONIOENCODING=$PYTHONIOENCODING)
command       : $2
================================================================================

EOF
}

run() {
  # run <logfile> <title> <command...>
  local log="$1" title="$2"; shift 2
  header "$title" "$*" > "$OUT/$log"
  "$@" >> "$OUT/$log" 2>&1
  local rc=$?
  printf '\n--- exit code: %s ---\n' "$rc" >> "$OUT/$log"
  printf 'wrote %s (exit %s)\n' "$OUT/$log" "$rc"
  return $rc
}

fail=0

run 01-security-ut.log \
  'the credential store and egress consent unit tests (tests/security.test.mjs)' \
  node --test tests/security.test.mjs || fail=1

# The integration tests are run TWICE: once without the real credential
# store (the two credential-writing cases are then SKIPPED) and once with it
# (they run against the REAL Windows Credential Manager). Both logs are kept,
# because "skipped" and "passed" are different facts and neither may hide
# the other.
run 02-security-api-it.log \
  'the AI data security API integration tests (tests/security-api.test.mjs)' \
  node --test tests/security-api.test.mjs || fail=1

run 03-security-api-it-real-store.log \
  'the same integration tests with ATS402_REAL_CREDENTIAL_STORE=1 (the real Windows Credential Manager)' \
  env ATS402_REAL_CREDENTIAL_STORE=1 node --test tests/security-api.test.mjs || fail=1

run 04-security-boundary-probe.log \
  'the security boundary probe (static analysis + real credential store + egress gate, with negative controls)' \
  node tools/ats402-probes/probe-security-boundary.mjs || fail=1

run 05-full-test-suite.log \
  'the whole node --test suite (tests/*.test.mjs)' \
  npm test || fail=1

run 06-wbs-updater-regression.log \
  'the WBS updaters coexist, are idempotent and keep every task note' \
  bash tools/ats501-probes/check-wbs-updaters.sh || fail=1

run 07-adr-citation-check.log \
  'every file:line citation in the baseline ADR still resolves' \
  python tools/check_adr_citations.py || fail=1

run 08-port-audit.log \
  'the ATS-101 hardcoded-port audit' \
  node tools/ats101-probes/scenario-d-port-audit.mjs || fail=1

run 09-agent-boundary-probe.log \
  'the ATS-401 agent boundary probe still passes (this task consumes its contract)' \
  node tools/ats401-probes/probe-agent-boundary.mjs || fail=1

run 10-ats501-protocol-audit.log \
  'the ATS-501 remote protocol audit still passes' \
  node tools/ats501-probes/audit-remote-protocol.mjs || fail=1

run 11-next-build.log \
  'the Next.js static export builds with the AI data security tab' \
  npm run build:web || fail=1

run 12-tsc.log \
  'the Next.js workbench type-checks (no type errors)' \
  npx --prefix apps/studio tsc --noEmit -p apps/studio/tsconfig.json || fail=1

run 13-wbs-ats402-row.log \
  'the ATS-402 row of the 开发WBS sheet is 待审核 with the ATS-402 note' \
  python tools/wbs_ats402_row_check.py || fail=1

echo
if [ "$fail" -eq 0 ]; then
  echo 'RESULT: OK -- every ATS-402 check passed.'
  exit 0
fi
echo 'RESULT: MISMATCH -- at least one ATS-402 check failed.'
exit 1
