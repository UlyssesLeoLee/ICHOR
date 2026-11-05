#!/usr/bin/env bash
# Re-collect the ATS-401 evidence logs on the current tree.
#
# Usage: bash tools/ats401-probes/collect-evidence.sh
#
# Every log is written to docs/evidence/ATS-401/. The logs are the evidence
# attached to the delivery, so they are collected in ONE place with the same
# command lines the reviewer is asked to re-run.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EV="$ROOT/docs/evidence/ATS-401"
WORK="${ATS_PROBE_WORKDIR:-$ROOT/.ats-evidence-work}"
mkdir -p "$EV"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "== 1/9 npm test"
{
  echo "=== ATS-401 evidence: npm test ==="
  echo "node: $(node --version)"
  echo "date: $(stamp)"
  echo "command: npm test"
  echo
  npm test 2>&1
} > "$EV/01-node-test.log"
echo "   exit=$?"

echo "== 2/9 probe-agent-boundary"
{
  echo "=== ATS-401 probe: Agent contract v1 permission boundary ==="
  echo "repo root : $ROOT"
  echo "date      : $(stamp)"
  echo
  ATS_PROBE_WORKDIR="$WORK/boundary" node tools/ats401-probes/probe-agent-boundary.mjs 2>&1
} > "$EV/02-agent-boundary.log"
echo "   exit=$?"

echo "== 3/9 scenario-d-port-audit"
{
  echo "=== ATS-101 scenario D: hardcoded default-port audit ==="
  echo "repo root : $ROOT"
  echo "date      : $(stamp)"
  echo
  node tools/ats101-probes/scenario-d-port-audit.mjs 2>&1
} > "$EV/03-port-audit.log"
echo "   exit=$?"

echo "== 4/9 coverage"
{
  echo "=== ATS-401 coverage measurement ==="
  echo "node: $(node --version)"
  echo "date: $(stamp)"
  echo "command: node --test --experimental-test-coverage tests/*.test.mjs"
  echo
  node --test --experimental-test-coverage tests/*.test.mjs 2>&1
} > "$EV/04-coverage.log"
echo "   exit=$?"

echo "== 5/9 probe-review-regressions (1st round)"
{
  echo "=== ATS-401 probe: 1st-review-round regressions ==="
  echo "repo root : $ROOT"
  echo "date      : $(stamp)"
  echo
  ATS_PROBE_WORKDIR="$WORK/r1" node tools/ats401-probes/probe-review-regressions.mjs 2>&1
} > "$EV/05-review-regressions.log"
echo "   exit=$?"

echo "== 6/9 probe-review-regressions-r2 (2nd round)"
{
  echo "=== ATS-401 probe: 2nd-review-round regressions ==="
  echo "repo root : $ROOT"
  echo "date      : $(stamp)"
  echo
  ATS_PROBE_WORKDIR="$WORK/r2" node tools/ats401-probes/probe-review-regressions-r2.mjs 2>&1
} > "$EV/06-review-regressions-r2.log"
echo "   exit=$?"

echo "== 7/9 probe-git-apply-parity"
{
  echo "=== ATS-401 probe: the diff whitelist agrees with git apply ==="
  echo "repo root : $ROOT"
  echo "date      : $(stamp)"
  echo "git       : $(git --version)"
  echo
  ATS_PROBE_WORKDIR="$WORK/parity" node tools/ats401-probes/probe-git-apply-parity.mjs 2>&1
} > "$EV/07-git-apply-parity.log"
echo "   exit=$?"

echo "== 8/9 probe-git-apply-bidirectional (3rd round)"
{
  echo "=== ATS-401 probe: the diff whitelist agrees with git apply, both ways ==="
  echo "repo root : $ROOT"
  echo "date      : $(stamp)"
  echo "git       : $(git --version)"
  echo
  ATS_PROBE_WORKDIR="$WORK/bidirectional" node tools/ats401-probes/probe-git-apply-bidirectional.mjs 2>&1
} > "$EV/08-git-apply-bidirectional.log"
echo "   exit=$?"

echo "== 9/9 check_wbs_xml_escape"
{
  echo "=== ATS-401 check: the WBS updater escapes the text it writes ==="
  echo "repo root : $ROOT"
  echo "date      : $(stamp)"
  echo "command: python tools/ats401-probes/check_wbs_xml_escape.py"
  echo
  python tools/ats401-probes/check_wbs_xml_escape.py 2>&1
} > "$EV/09-wbs-xml-escape.log"
echo "   exit=$?"

rm -rf "$WORK"
echo "done."
