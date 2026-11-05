#!/usr/bin/env bash
# Re-collect the ATS-301 evidence logs on the current tree.
#
# Usage: bash tools/ats301-probes/collect-evidence.sh
#
# Every log is written to docs/evidence/ATS-301/. The logs are the evidence
# attached to the delivery, so they are collected in ONE place with the same
# command lines the reviewer is asked to re-run.
#
# The 2nd review round added two logs that did not exist before:
#   10-port-audit.log        -- the ATS-101 hardcoded-port audit. It belongs
#                               here because the ATS-301 delivery is what
#                               turned it red, so the delivery has to carry
#                               the evidence that it is green again.
#   11-wbs-ats301-note.log  -- the ATS-301 row of the workbook as it reads
#                               on disk, compared against the note the
#                               updater writes. This is the evidence that
#                               the committed workbook IS the updater's
#                               output and was not hand-edited.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EV="$ROOT/docs/evidence/ATS-301"
mkdir -p "$EV"

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "== 1/11 npm test"
{
  echo "=== ATS-301 evidence: npm test ==="
  echo "node: $(node --version)"
  echo "date: $(stamp)"
  echo "command: npm test"
  echo
  npm test 2>&1
} > "$EV/00-npm-test-full.log"
echo "   exit=$?"

echo "== 2/11 playwright-ground-truth"
{
  echo "=== ATS-301 probe: the real Playwright ground truth ==="
  echo "repo root : $ROOT"
  echo "node      : $(node --version)"
  echo "date      : $(stamp)"
  echo
  node tools/ats301-probes/playwright-ground-truth.mjs 2>&1
} > "$EV/01-playwright-ground-truth.log"
echo "   exit=$?"

echo "== 3/11 wdio-ground-truth"
{
  echo "=== ATS-301 probe: the real WebdriverIO ground truth ==="
  echo "repo root : $ROOT"
  echo "node      : $(node --version)"
  echo "date      : $(stamp)"
  echo
  node tools/ats301-probes/wdio-ground-truth.mjs 2>&1
} > "$EV/02-wdio-ground-truth.log"
echo "   exit=$?"

echo "== 4/11 check_adr_citations"
{
  echo "=== ATS-301 check: every ADR path:line citation resolves ==="
  echo "repo root : $ROOT"
  echo "python    : $(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
  echo "date      : $(stamp)"
  echo "command  : PYTHONUTF8=1 python tools/check_adr_citations.py"
  echo
  python tools/check_adr_citations.py 2>&1
} > "$EV/03-adr-citations.log"
echo "   exit=$?"

echo "== 5/11 stop no-op mutation"
{
  echo "=== ATS-301 mutation: stop() turned into a no-op ==="
  echo "repo root : $ROOT"
  echo "node      : $(node --version)"
  echo "date      : $(stamp)"
  echo "command  : node --test tests/adapters-it.test.mjs"
  echo
  echo "The stop IT asserts two things, both measured in the same test:"
  echo "  1. the stopped run did not execute every case (stopped < natural);"
  echo "  2. the stopped run was clearly faster than the natural one."
  echo "The natural baseline is measured in the same test; no hardcoded"
  echo "threshold is used."
  echo
  node --test tests/adapters-it.test.mjs 2>&1
} > "$EV/04-stop-noop-mutation.log"
echo "   exit=$?"

echo "== 6/11 http 409 reason mutation"
{
  echo "=== ATS-301 mutation: the 409 reason generation ==="
  echo "repo root : $ROOT"
  echo "node      : $(node --version)"
  echo "platform  : $(node -p 'process.platform + " " + process.arch' 2>&1)"
  echo "date      : $(stamp)"
  echo
  node --test tests/api.test.mjs 2>&1
} > "$EV/05-http-409-reason-mutation.log"
echo "   exit=$?"

echo "== 7/11 the WBS updater gate"
{
  echo "=== ATS-501 regression: WBS updater interaction ==="
  echo "repo root : $ROOT"
  echo "date      : $(stamp)"
  echo
  bash tools/ats501-probes/check-wbs-updaters.sh 2>&1
} > "$EV/06-wbs-updaters-gate.log"
echo "   exit=$?"

echo "== 8/11 the ATS-301 gate"
{
  echo "=== ATS-301 gate: WBS helper + ADR citations + port audit ==="
  echo "repo root : $ROOT"
  echo "date      : $(stamp)"
  echo
  bash tools/ats301-probes/check-ats301-gate.sh 2>&1
} > "$EV/07-ats301-gate.log"
echo "   exit=$?"

echo "== 9/11 the WBS XML escaping check"
{
  echo "=== ATS-301 / review item 3 (WBS XML escaping) -- the escaping is real and needed ==="
  echo "repo root : $ROOT"
  echo "date      : $(stamp)"
  echo "command  : python tools/ats401-probes/check_wbs_xml_escape.py"
  echo
  python tools/ats401-probes/check_wbs_xml_escape.py 2>&1
} > "$EV/08-wbs-xml-escaping.log"
echo "   exit=$?"

echo "== 10/11 the C1 filterByFile check"
{
  echo "=== ATS-301 / review item 1 (C1) -- Playwright's positional test filter ==="
  echo "repo root : $ROOT"
  echo "node      : $(node --version)"
  echo "date      : $(stamp)"
  echo
  ATS_PROBE_WORKDIR="${ATS_PROBE_WORKDIR:-$ROOT/.ats-evidence-work/c1}" \
    node tools/ats401-probes/probe-review-regressions.mjs 2>&1
} > "$EV/09-filterbyfile-c1.log"
echo "   exit=$?"

echo "== 11/11 the ATS-101 hardcoded-port audit"
{
  echo "=== ATS-101 scenario D: the hardcoded default-port audit ==="
  echo "repo root : $ROOT"
  echo "node      : $(node --version)"
  echo "date      : $(stamp)"
  echo "NOTE: this is ATS-101's probe, not ATS-401's. It audits the"
  echo "      hardcoded default-port list in 16 §3.1 against the source"
  echo "      tree, by POSITION."
  echo "      It is in this delivery because the ATS-301 delivery added"
  echo "      source files that mention the port, which turned this audit"
  echo "      red. It is now part of the ATS-301 gate (see 07), so this"
  echo "      class of regression cannot pass the gate again."
  echo
  node tools/ats101-probes/scenario-d-port-audit.mjs 2>&1
} > "$EV/10-port-audit.log"
echo "   exit=$?"

echo "== 12/12 the ATS-301 workbook note vs the updater output"
{
  echo "=== ATS-301: the workbook row is the updater's output ==="
  echo "repo root : $ROOT"
  echo "python    : $(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
  echo "date      : $(stamp)"
  echo "command  : PYTHONUTF8=1 python tools/ats301-probes/show-ats301-note.py"
  echo
  python tools/ats301-probes/show-ats301-note.py 2>&1
} > "$EV/11-wbs-ats301-note.log"
echo "   exit=$?"

rm -rf "${ATS_PROBE_WORKDIR:-$ROOT/.ats-evidence-work}"
echo "done."
