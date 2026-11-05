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

# --- 2. the repository regression -----------------------------------------
header 03-npm-test-regression.log "npm test regression" "npm test"
npm test >> "$OUT/03-npm-test-regression.log" 2>&1
echo "TEST_EXIT=$?" >> "$OUT/03-npm-test-regression.log"

# --- 3. the WBS coexistence regression ------------------------------------
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

# --- 4. the WBS row update (LAST: the regression above restores the sheet) --
python tools/update_wbs_ats103.py --status 待审核 > /dev/null

# The WBS updater leaves a .bak behind; it is not part of the delivery.
rm -f docs/WBS.xlsx.bak

echo "evidence regenerated in $OUT:"
ls -1 "$OUT"
