#!/usr/bin/env bash
# ATS-103: regenerate the evidence logs from a real run.
#
# Every log records the exact command, the commit it was produced from and
# the verbatim output, so a reviewer can reproduce it. Nothing here is
# hand-written.
#
# ORDER MATTERS: the WBS coexistence regression (which is ATS-501's script,
# reused here) RESTORES the workbook to its committed state when it finishes
# -- it has to, because it writes the workbook in several orders to compare
# the results. Running it after the ATS-103 update would therefore silently
# throw the update away. The ATS-103 update is applied LAST, so the workbook
# that gets committed is the one the logs describe.
#
# Usage: bash tools/ats103-probes/collect-evidence.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

OUT="docs/evidence/ATS-103"
mkdir -p "$OUT"

COMMIT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NODE_V="$(node --version)"
NPM_V="$(npm --version)"

header() {
  local file="$1"; shift
  {
    echo "=== ATS-103 evidence: $1 ==="
    echo "date      : $STAMP (UTC)"
    echo "commit    : $COMMIT"
    echo "node      : $NODE_V"
    echo "npm       : $NPM_V"
    echo "command   : $2"
    echo ""
  } > "$OUT/$file"
}

# --- 0. the static export build (the artefact everything else runs on) -----
# `npm ci` is run with a raised heap limit: the Next.js 16 build on this
# machine needs more than the default old-space size on Windows.
header 02-next-static-export-build.log "Next.js 16 static export build" \
  "npm --prefix apps/studio ci --no-audit --no-fund && npm --prefix apps/studio run build"
{
  echo "--- npm ci (apps/studio) ---"
  NODE_OPTIONS=--max-old-space-size=6144 \
    npm --prefix apps/studio ci --no-audit --no-fund --maxsockets=4 2>&1
  echo ""
  echo "--- next build ---"
  NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build 2>&1
  echo "BUILD_EXIT=$?"
  echo ""
  echo "--- artefact ---"
  ls -la apps/studio/out/index.html apps/studio/out/404.html 2>&1
  echo ""
  echo "--- git status after the build ---"
  git status --short
} >> "$OUT/02-next-static-export-build.log" 2>&1

# --- 1. the export + Bridge + API verification ----------------------------
header 01-export-and-proxy-verification.log "static export + Bridge API seam verification" \
  "node tools/ats103-probes/verify-export-and-proxy.mjs"
node tools/ats103-probes/verify-export-and-proxy.mjs >> "$OUT/01-export-and-proxy-verification.log" 2>&1
echo "PROBE_EXIT=$?" >> "$OUT/01-export-and-proxy-verification.log"

# --- 2. the real browser driving the exported UI (ST) ---------------------
header 05-ui-smoke-browser.log "ST: a real browser drives the exported UI" \
  "node tools/ats103-probes/ui-smoke.mjs"
node tools/ats103-probes/ui-smoke.mjs >> "$OUT/05-ui-smoke-browser.log" 2>&1
echo "PROBE_EXIT=$?" >> "$OUT/05-ui-smoke-browser.log"

# --- 3. the same ST path from a whitelisted cross-origin ------------------
header 05b-ui-smoke-cross-origin.log "ST: the exported UI from a whitelisted cross-origin" \
  "node tools/ats103-probes/ui-smoke.mjs --page-origin http://127.0.0.1:3000"
node tools/ats103-probes/ui-smoke.mjs --page-origin http://127.0.0.1:3000 \
  >> "$OUT/05b-ui-smoke-cross-origin.log" 2>&1
echo "PROBE_EXIT=$?" >> "$OUT/05b-ui-smoke-cross-origin.log"

# --- 4. the mutation evidence ---------------------------------------------
# The script mutates the product source temporarily and restores it. It
# writes its own log; the header is prepended here so the log carries the
# same provenance block as the others.
#
# The script is told where to write via ATS103_MUTATION_LOG, and the pieces
# are assembled with `cat` into a third file. Writing the body straight to
# the final path would make the assembly step overwrite the script's own
# log -- the mutation details would be lost.
{
  echo "=== ATS-103 evidence: mutation evidence ==="
  echo "date      : $STAMP (UTC)"
  echo "commit    : $COMMIT"
  echo "node      : $NODE_V"
  echo "npm       : $NPM_V"
  echo "command   : bash tools/ats103-probes/mutation-evidence.sh"
  echo ""
} > "$OUT/06-mutation-evidence.log.head"
ATS103_MUTATION_LOG="$OUT/06-mutation-evidence.log.body" \
  bash tools/ats103-probes/mutation-evidence.sh > /dev/null 2>&1
MUT_EXIT=$?
cat "$OUT/06-mutation-evidence.log.head" "$OUT/06-mutation-evidence.log.body" \
  > "$OUT/06-mutation-evidence.log"
rm -f "$OUT/06-mutation-evidence.log.head" "$OUT/06-mutation-evidence.log.body"
echo "MUTATION_SCRIPT_EXIT=$MUT_EXIT" >> "$OUT/06-mutation-evidence.log"

# --- 5. the ATS-101 port audit (this task must not regress it) ------------
header 07-port-audit.log "ATS-101 hardcoded default-port audit" \
  "node tools/ats101-probes/scenario-d-port-audit.mjs"
node tools/ats101-probes/scenario-d-port-audit.mjs >> "$OUT/07-port-audit.log" 2>&1
echo "PORT_AUDIT_EXIT=$?" >> "$OUT/07-port-audit.log"

# --- 6. the ADR citation check --------------------------------------------
header 08-adr-citations.log "ADR citation check" \
  "python tools/check_adr_citations.py"
python tools/check_adr_citations.py >> "$OUT/08-adr-citations.log" 2>&1
echo "ADR_EXIT=$?" >> "$OUT/08-adr-citations.log"

# --- 7. the repository build gate -----------------------------------------
header 09-ci-build-gate.log "the repository 8-step build gate" \
  "node tools/ci_build_gate.mjs"
node tools/ci_build_gate.mjs >> "$OUT/09-ci-build-gate.log" 2>&1
echo "GATE_EXIT=$?" >> "$OUT/09-ci-build-gate.log"

# --- 8. the repository regression -----------------------------------------
header 03-npm-test-regression.log "npm test regression" "npm test"
npm test >> "$OUT/03-npm-test-regression.log" 2>&1
echo "TEST_EXIT=$?" >> "$OUT/03-npm-test-regression.log"

# --- 9. the WBS coexistence regression ------------------------------------
header 04-wbs-updater-regression.log \
  "WBS updater coexistence regression (all tools/update_wbs_*.py)" \
  "python tools/test_wbs_common.py && bash tools/ats501-probes/check-wbs-updaters.sh"
{
  echo "--- python tools/test_wbs_common.py ---"
  python tools/test_wbs_common.py 2>&1
  echo "EXIT=$?"
  echo ""
  echo "--- bash tools/ats501-probes/check-wbs-updaters.sh ---"
  bash tools/ats501-probes/check-wbs-updaters.sh 2>&1
  echo "EXIT=$?"
} >> "$OUT/04-wbs-updater-regression.log" 2>&1

# --- 10. the WBS row update (LAST: the regression above restores the sheet) --
python tools/update_wbs_ats103.py --status 待审核 > /dev/null

# The WBS updater leaves a .bak behind; it is not part of the delivery.
rm -f docs/WBS.xlsx.bak

echo "evidence regenerated in $OUT:"
ls -1 "$OUT"
