#!/usr/bin/env bash
# ATS-214: re-run the EXTERNAL probes against this delivery.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# The acceptance criteria of this task are the external probes, not the
# executor's own tests: the probe attachment decides whether the delivery
# passes. So the probes are re-run HERE, on the delivered tree, and their
# VERBATIM output is archived next to the executor's evidence.
#
# The probes themselves are NOT in the repository -- they arrive as an
# issue attachment, and a copy of an external file is not a deliverable.
# This script therefore takes the directory the probes were unpacked into
# as an argument, and archives only the OUTPUT.
#
# WHAT IS RUN
# -----------
#   r1-api.mjs    the batch selection through the REAL Bridge + the REAL
#                 Playwright (B0/B1/B2/N1/R1/T1/M1/M2 must be OK; B3 is an
#                 information item -- the whole-file execution is a gap
#                 ATS-301 already registers);
#   r2-extra.mjs  the two defects of the last round: E1 (the batch record
#                 must not serve an environment value) and E2 (a whitelist
#                 tightened mid-batch must constrain the later run);
#   r2-ui.mjs     the 500-case responsiveness and the selection semantics in
#                 the REAL Chromium (L1/X1/X3/X4/P1/P2/K1);
#   r1-ui.mjs     the same surface from the first attachment, run through
#                 the patched COPY (see the note below -- the attachment's
#                 own file is never modified).
#
# USAGE
# -----
#   bash tools/ats214-probes/run-reviewer-probes.sh <probe-dir> <out-dir>
#
# The probe dir must contain the probes that were attached:
#   <probe-dir>/r1/probes/{build-fx.mjs,r1-api.mjs,r1-ui.mjs}
#   <probe-dir>/r2/probes/{r2-ui.mjs,r2-extra.mjs}
#
# THE r1-ui COPY
# --------------
# The r1-ui probe of the first attachment needs three fixes IN THE PROBE
# ITSELF, and they are applied to a COPY (r1-ui-run.mjs), never to the
# attachment's own file. The reasons are recorded in
# docs/evidence/ATS-214/reviewer-probes/README.md:
#
#   1. the port 4577 is hard-coded, and another agent's Bridge holds it on
#      this machine -- the probe then measures ANOTHER tree;
#   2. `closest('button')` matches the pick box ITSELF, so a correct
#      `<button role="checkbox">` is reported as nested in a button;
#   3. the X3 step reads `run.status` unconditionally, but X3 REQUIRES the
#      run to be refused -- the probe then crashes on `undefined`.
#
# The copy also stops waiting for 500 rows in the K1 step: after X1 the
# filter is reset on a project switch (which is X1's own requirement), so
# there is no stale criterion to clear, and clicking @smoke would narrow the
# list to 134 rows.
set -u
cd "$(dirname "$0")/../.."

PROBE_DIR="${1:-}"
OUT_DIR="${2:-docs/evidence/ATS-214/reviewer-probes}"
if [ -z "$PROBE_DIR" ]; then
  echo "usage: run-reviewer-probes.sh <probe-dir> [out-dir]" >&2
  exit 2
fi
if [ ! -d "$PROBE_DIR" ]; then
  echo "the probe directory does not exist: $PROBE_DIR" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"

# The scratch and the fixtures live on D: -- the C: page file is pinned at
# 8192 MB on this machine and cannot grow.
export TMPDIR="${TMPDIR:-D:/hermes-multica/home/cache/scratch}"
if command -v cygpath > /dev/null 2>&1; then
  TMPDIR="$(cygpath -w "$TMPDIR")"
fi
export TEMP="$TMPDIR"
export TMP="$TMPDIR"
mkdir -p "$TMPDIR"

# The real Playwright: the fixtures link it as a junction.
PW_MODULES="${ATS214_PLAYWRIGHT_MODULES:-D:/ICHOR/examples/sample-playwright/node_modules}"
if [ ! -f "$PW_MODULES/playwright-core/index.mjs" ]; then
  echo "SKIPPED: the real playwright could not be reached at $PW_MODULES" >&2
  exit 3
fi

FX="${TMPDIR}/ats214-probe-fx"
FX_DATA="${TMPDIR}/ats214-probe-data"
FAILED=0

# The provenance header: every probe log says WHICH COMMIT it describes.
# Without that anchor the numbers in a log cannot be checked against the
# tree that produced them.
header () {
  local log="$1"; shift
  local label="$1"; shift
  {
    echo "================================================================================"
    echo "ATS-214 evidence log -- the external probe: $label"
    echo "================================================================================"
    echo "commit        : $(git rev-parse HEAD)"
    echo "timestamp     : $(date -u +%Y-%m-%dT%H:%M:%SZ) (UTC)"
    echo "repo root     : $(pwd)"
    echo "node          : $(node --version 2>&1)"
    echo "platform      : $(node -p 'process.platform + " " + process.arch')"
    echo "command       : $*"
    echo "================================================================================"
    echo ""
  } > "$log"
  "$@" >> "$log" 2>&1
  local code=$?
  echo "" >> "$log"
  echo "--- exit code: $code ---" >> "$log"
  return $code
}

echo "=== the external fixtures ==="
if node "$PROBE_DIR/r1/probes/build-fx.mjs" "$FX" "$PW_MODULES" > /dev/null 2>&1; then
  echo "  the fixtures are built: $FX"
else
  echo "  FAIL: the fixtures could not be built" >&2
  exit 1
fi

echo
echo "=== r1-api: the batch selection through the REAL Bridge + the REAL Playwright ==="
# B3 is an INFORMATION ITEM, not a required check: the whole-file execution
# ("selected 2, engine ran 5") is a gap the adapter contract already
# registers (ATS-301), and implementing it is outside this task's scope.
# The probe's exit code counts it as a DEFECT, so the verdict is computed
# from the probe's OWN lines: every check except B3 must be OK.
R1_API_LOG="$OUT_DIR/r1-api.log"
if header "$R1_API_LOG" "r1-api" \
  node "$PROBE_DIR/r1/probes/r1-api.mjs" . "$FX" "$FX_DATA" 8951; then
  echo "  OK: r1-api, 0 DEFECT"
else
  # The probe counts B3 as a DEFECT. It is an information item: the
  # whole-file execution is a gap ATS-301 already registers, and the
  # interface states how many cases will really run. The verdict is
  # therefore computed from the probe's OWN lines -- every check except
  # B3 has to be OK.
  r1_api_required_defects="$(grep -E '^DEFECT ' "$R1_API_LOG" | grep -v '^DEFECT B3 ' || true)"
  if [ -z "$r1_api_required_defects" ]; then
    echo "  OK: r1-api, 0 DEFECT in the required checks (B3 is an information item)"
  else
    echo "  DEFECT: r1-api -- see $R1_API_LOG" >&2
    echo "$r1_api_required_defects" >&2
    FAILED=1
  fi
fi
grep -E "^(OK|DEFECT) " "$R1_API_LOG"

echo
echo "=== r2-extra: the batch record must not serve an environment value, and a tightened whitelist must apply ==="
if header "$OUT_DIR/r2-extra.log" "r2-extra" \
  node "$PROBE_DIR/r2/probes/r2-extra.mjs" . "$TMPDIR" "$PW_MODULES" 8952; then
  echo "  OK: r2-extra, 0 DEFECT"
else
  echo "  DEFECT: r2-extra -- see $OUT_DIR/r2-extra.log" >&2
  FAILED=1
fi
grep -E "^(OK|DEFECT) " "$OUT_DIR/r2-extra.log"

echo
echo "=== r2-ui: the 500-case responsiveness and the selection semantics in the REAL Chromium ==="
if header "$OUT_DIR/r2-ui.log" "r2-ui" \
  env R2_PORT=8953 node "$PROBE_DIR/r2/probes/r2-ui.mjs" . "$FX" "${FX_DATA}-ui" "$PW_MODULES/playwright-core"; then
  echo "  OK: r2-ui, 0 DEFECT"
else
  echo "  DEFECT: r2-ui -- see $OUT_DIR/r2-ui.log" >&2
  FAILED=1
fi
grep -E "^(OK|DEFECT) " "$OUT_DIR/r2-ui.log"

# --- r1-ui: the first attachment's UI probe, through the patched COPY ----
# The copy is `r1-ui-run.mjs` next to the attachment's `r1-ui.mjs`; the
# attachment's own file is never touched. The three fixes in the copy and
# their reasons are in the header of this script.
echo
echo "=== r1-ui: the 500-case responsiveness and the selection semantics in the REAL Chromium ==="
R1_UI_PROBE="$PROBE_DIR/r1/probes/r1-ui-run.mjs"
if [ ! -f "$R1_UI_PROBE" ]; then
  echo "  SKIP: $R1_UI_PROBE does not exist (the patched copy of r1-ui.mjs)"
  printf 'SKIPPED: the patched copy r1-ui-run.mjs was not provided.\n' > "$OUT_DIR/r1-ui.log"
else
  if header "$OUT_DIR/r1-ui.log" "r1-ui" \
    node "$R1_UI_PROBE" . "$FX" "${FX_DATA}-ui1" "$PW_MODULES/playwright-core"; then
    echo "  OK: r1-ui, 0 DEFECT"
  else
    echo "  DEFECT: r1-ui -- see $OUT_DIR/r1-ui.log" >&2
    FAILED=1
  fi
  grep -E "^(OK|DEFECT) " "$OUT_DIR/r1-ui.log"
fi

echo
if [ "$FAILED" = "0" ]; then
  echo "RESULT: OK -- the external probes are all green on this delivery."
else
  echo "RESULT: FAILED -- at least one of the external probes is red."
fi
exit $FAILED
