#!/usr/bin/env bash
# ATS-301 gate: the WBS shared-cell helper and the ADR citation checker must
# stay green.
#
# The review found that `tools/test_wbs_common.py` was not wired into any
# gate, and that its marker test was tautological (it iterated `MARKERS`
# itself, so it could not detect an updater whose marker was missing from
# `MARKERS`). The test is now derived from the updater scripts, but a test
# nobody runs guards nothing -- so this script is the gate entry point.
#
# It runs:
#   1. tools/test_wbs_common.py  -- the shared marked-cell merge regression
#   2. tools/check_adr_citations.py -- every ADR `path:line` citation resolves
#
# Both are read-only with respect to docs/WBS.xlsx: the WBS test only merges
# strings in memory, and the citation checker only reads files.
#
# ENCODING: the WBS test prints Chinese text (markers). On a default Windows
# console the Python stdout encoding is the ANSI code page (gbk / cp936), so
# the bytes do not match and the run fails on a clean machine. UTF-8 is
# therefore forced at the entry of this script; the effective interpreter and
# its stdout encoding are printed so the evidence log records the environment
# the PASS was produced in.
#
# Usage: bash tools/ats301-probes/check-ats301-gate.sh
set -u

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

fail=0
ok()  { printf '  PASS  %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=1; }

printf '=== ATS-301 gate: WBS helper + ADR citations ===\n'
printf 'repo root : %s\n' "$ROOT"
printf 'python    : %s\n' "$(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
printf 'stdout enc: %s (forced: PYTHONUTF8=%s PYTHONIOENCODING=%s)\n' \
  "$(python -c 'import sys; print(sys.stdout.encoding)' 2>&1)" "$PYTHONUTF8" "$PYTHONIOENCODING"
printf '\n'

printf -- '--- 1. the WBS shared-cell merge regression ---\n'
if python tools/test_wbs_common.py; then
  ok 'tools/test_wbs_common.py'
else
  bad 'tools/test_wbs_common.py'
fi

printf '\n'
printf -- '--- 2. every ADR path:line citation resolves ---\n'
if python tools/check_adr_citations.py; then
  ok 'tools/check_adr_citations.py'
else
  bad 'tools/check_adr_citations.py'
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf 'RESULT: OK -- the WBS helper regression and the ADR citation check both pass.\n'
  exit 0
fi
printf 'RESULT: MISMATCH -- the ATS-301 gate does not pass.\n'
exit 1
