#!/usr/bin/env bash
# ATS-512 evidence collection: run every check this task claims to have made
# and write its ACTUAL output into docs/evidence/ATS-512/.
#
# The point is reproducibility: a PASS is only meaningful together with the
# environment that produced it, so each log records the commit, the timestamp,
# the Node/Python versions and (for Python) the stdout encoding.
#
# Usage: bash tools/ats512-probes/collect-evidence.sh
set -u

# --- force UTF-8 for every Python invocation in this script ---------------
# These scripts compare Chinese (状态 values, 总览 narrative cells, the
# 【ATS-xxx】 markers). On a default Windows console the Python stdout
# encoding is the ANSI code page (gbk / cp936 / cp1252), so the bytes the
# shell compares against its UTF-8 literals do not match and the regression
# fails on a clean machine.
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

OUT="docs/evidence/ATS-512"
mkdir -p "$OUT"

NODE_VERSION="$(node --version 2>&1)"
PY_VERSION="$(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
PY_STDOUT_ENCODING="$(python -c 'import sys; print(sys.stdout.encoding)' 2>&1)"
PY_DEFAULT_ENCODING="$(env -u PYTHONUTF8 -u PYTHONIOENCODING \
  python -c 'import sys; print(sys.stdout.encoding)' 2>&1)"
COMMIT="$(git rev-parse HEAD 2>&1)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>&1)"

header() {
  cat <<EOF
================================================================================
ATS-512 evidence log -- $1
================================================================================
commit        : $COMMIT
timestamp     : $STAMP (UTC)
repo root     : $ROOT
node          : $NODE_VERSION
python        : $PY_VERSION
stdout enc    : $PY_STDOUT_ENCODING (forced: PYTHONUTF8=$PYTHONUTF8 PYTHONIOENCODING=$PYTHONIOENCODING)
default enc   : $PY_DEFAULT_ENCODING (what the same interpreter would use without the forcing)
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

run 01-plugin-ut.log \
  'plugin contract unit tests (tests/plugins.test.mjs)' \
  node --test tests/plugins.test.mjs || fail=1

run 02-plugin-api-it.log \
  'plugin contract API integration tests (tests/plugins-api.test.mjs)' \
  node --test tests/plugins-api.test.mjs || fail=1

run 03-plugin-boundary-probe.log \
  'plugin permission boundary probe (includes the negative control)' \
  node tools/ats512-probes/probe-plugin-boundary.mjs || fail=1

run 04-full-test-suite.log \
  'the whole node --test suite (tests/*.test.mjs)' \
  npm test || fail=1

run 05-wbs-updater-regression.log \
  'the WBS updaters coexist, are idempotent and keep every task note' \
  bash tools/ats501-probes/check-wbs-updaters.sh || fail=1

run 06-ats501-protocol-audit.log \
  'the ATS-501 remote protocol audit still passes (this task consumes it)' \
  node tools/ats501-probes/audit-remote-protocol.mjs || fail=1

run 07-adr-citation-check.log \
  'every file:line citation in the baseline ADR still resolves' \
  python tools/check_adr_citations.py || fail=1

# The two checks below are KNOWN to be red on `dev` itself, for reasons that
# predate this task and are not caused by it. They are recorded (not skipped)
# so the state is visible, but they do NOT fail this script -- otherwise the
# script would be reporting someone else's defect as this task's.
#
#   * the ATS-101 hardcoded-port audit: ATS-103 added runtime port mentions
#     (tools/ats103-probes/verify-export-and-proxy.mjs,
#     tools/update_wbs_ats103.py) that the baseline ADR's port list does not
#     enumerate. Verified by running the audit on `dev` itself: it is red
#     there too, with the same two files missing.
#   * the full node --test suite: IT-API-013 fails because
#     examples/sample-playwright/ has no node_modules in this checkout. See
#     09-baseline-regression.log, which reproduces the failure on the
#     untouched baseline tree.
known_fail=0

run 08-port-audit.log \
  'the ATS-101 hardcoded-port audit (KNOWN red on dev since ATS-103)' \
  node tools/ats101-probes/scenario-d-port-audit.mjs || known_fail=1

run 09-baseline-regression.log \
  'the one failing suite test is reproduced on the untouched baseline tree' \
  bash tools/ats512-probes/prove-baseline-regression.sh || known_fail=1

echo
if [ "$fail" -eq 0 ]; then
  echo 'RESULT: OK -- every ATS-512 check passed.'
  if [ "$known_fail" -ne 0 ]; then
    echo 'NOTE: the known pre-existing failures (recorded, not caused by this task) are in'
    echo '      08-port-audit.log and 09-baseline-regression.log.'
  fi
  exit 0
fi
echo 'RESULT: MISMATCH -- at least one ATS-512 check failed.'
exit 1
