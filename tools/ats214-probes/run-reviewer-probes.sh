#!/usr/bin/env bash
# ATS-214: re-run the REVIEWER's own probes against this delivery.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# The acceptance criteria of this task are the reviewer's probes, not the
# executor's own tests: the probe attachment decides whether the delivery
# passes. So the probes are re-run HERE, on the delivered tree, and their
# VERBATIM output is archived next to the executor's evidence.
#
# The probes themselves are NOT in the repository -- they arrive as an
# issue attachment, and a copy of a reviewer's file is not a deliverable.
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
#                 the REAL Chromium (L1/X1/X3/X4/P1/P2/K1).
#
# USAGE
# -----
#   bash tools/ats214-probes/run-reviewer-probes.sh <probe-dir> <out-dir>
#
# The probe dir must contain the probes the reviewer attached:
#   <probe-dir>/r1/probes/{build-fx.mjs,r1-api.mjs}
#   <probe-dir>/r2/probes/{r2-ui.mjs,r2-extra.mjs}
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

echo "=== the reviewer's fixtures ==="
if node "$PROBE_DIR/r1/probes/build-fx.mjs" "$FX" "$PW_MODULES" > /dev/null 2>&1; then
  echo "  the fixtures are built: $FX"
else
  echo "  FAIL: the fixtures could not be built" >&2
  exit 1
fi

echo
echo "=== r1-api: the batch selection through the REAL Bridge + the REAL Playwright ==="
if node "$PROBE_DIR/r1/probes/r1-api.mjs" . "$FX" "$FX_DATA" 8951 > "$OUT_DIR/r1-api.log" 2>&1; then
  echo "  OK: r1-api, 0 DEFECT"
else
  echo "  DEFECT: r1-api -- see $OUT_DIR/r1-api.log" >&2
  FAILED=1
fi
grep -E "^(OK|DEFECT) " "$OUT_DIR/r1-api.log"

echo
echo "=== r2-extra: the batch record must not serve an environment value, and a tightened whitelist must apply ==="
if node "$PROBE_DIR/r2/probes/r2-extra.mjs" . "$TMPDIR" "$PW_MODULES" 8952 > "$OUT_DIR/r2-extra.log" 2>&1; then
  echo "  OK: r2-extra, 0 DEFECT"
else
  echo "  DEFECT: r2-extra -- see $OUT_DIR/r2-extra.log" >&2
  FAILED=1
fi
grep -E "^(OK|DEFECT) " "$OUT_DIR/r2-extra.log"

echo
echo "=== r2-ui: the 500-case responsiveness and the selection semantics in the REAL Chromium ==="
if R2_PORT=8953 node "$PROBE_DIR/r2/probes/r2-ui.mjs" . "$FX" "${FX_DATA}-ui" "$PW_MODULES/playwright-core" > "$OUT_DIR/r2-ui.log" 2>&1; then
  echo "  OK: r2-ui, 0 DEFECT"
else
  echo "  DEFECT: r2-ui -- see $OUT_DIR/r2-ui.log" >&2
  FAILED=1
fi
grep -E "^(OK|DEFECT) " "$OUT_DIR/r2-ui.log"

echo
if [ "$FAILED" = "0" ]; then
  echo "RESULT: OK -- the reviewer's own probes are all green on this delivery."
else
  echo "RESULT: FAILED -- at least one of the reviewer's probes is red."
fi
exit $FAILED
