#!/usr/bin/env bash
# ATS-101 evidence collector -- B-02: `cargo check` vs `cargo build`.
#
# The earlier probe (collect-b02-icon.sh) used `cargo check`, which performs
# type checking and metadata generation but does NOT link the final artifact.
# A type-check pass therefore proves nothing about the link step.
#
# This probe runs BOTH commands with the SAME toolchain and the SAME
# temporary icon, so the two outcomes can be compared directly:
#
#   1. cargo check  -> may succeed while the artifact is never linked
#   2. cargo build  -> performs the final link of the cdylib
#
# The crate is declared as
#   crate-type = ["staticlib", "cdylib", "rlib"]
# so the cdylib link is the step that can still fail after a green check.
#
# Two properties this probe MUST keep (see tools/ats101-probes/README.md):
#
#   A. The full `cargo build` output is captured to a log file, because the
#      linker diagnostic arrives as a rustc "= note:" sub-diagnostic. The
#      `--message-format short` rendering DROPS those notes, so a short-format
#      run can never surface `export ordinal too large`. The verdict below is
#      derived by grepping the captured log for that exact marker, which also
#      lets it tell cause 4 apart from any other link failure.
#
#   B. The probe never deletes a product asset it did not create. If an
#      `src-tauri/icons/icon.ico` already exists (e.g. after ATS-104 adds it
#      to the repository), it is KEPT and the output says so.
#
# Usage: bash tools/ats101-probes/collect-b02-build-link.sh
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_TAURI="$REPO_ROOT/src-tauri"
# ATS_PROBE_CARGO overrides the cargo binary. It exists so the verdict logic
# can be exercised with a stub cargo (see README discipline #5): the three
# failure shapes -- export ordinal, other link error, pre-link failure -- are
# told apart by the build log, so they can be reproduced without a real build.
CARGO="${ATS_PROBE_CARGO:-$HOME/.cargo/bin/cargo.exe}"
MSYS_BIN="/c/msys64/mingw64/bin"
ICO_NATIVE="$(cygpath -w "$SRC_TAURI/icons/icon.ico")"
LOG_DIR="${ATS_PROBE_LOG_DIR:-${TMPDIR:-/tmp}/ats101-probes}"
CHECK_LOG="$LOG_DIR/b02-build-link-cargo-check.log"
BUILD_LOG="$LOG_DIR/b02-build-link-cargo-build.log"

mkdir -p "$LOG_DIR"

echo "=== ATS-101 B-02: cargo check vs cargo build (link step) ==="
echo "date : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "host : $(uname -s) / shell=bash"
echo "logs : $LOG_DIR"
echo

echo "--- 0. toolchain + crate type ---"
"$CARGO" --version
"$CARGO" +stable-x86_64-pc-windows-gnu --version
echo "\$ grep crate-type src-tauri/Cargo.toml"
grep -n 'crate-type' "$SRC_TAURI/Cargo.toml"
echo

# ---------------------------------------------------------------------------
# Step 1: provide a valid .ico, but ONLY if one is not already there.
# ICO_GENERATED records whether THIS run created the file, so that the
# cleanup at the end can never delete a pre-existing product asset.
# ---------------------------------------------------------------------------
echo "--- 1. provide a valid .ico (probe artefact) ---"
ICO_GENERATED=0
if [ ! -f "$ICO_NATIVE" ]; then
python - "$ICO_NATIVE" <<'PY'
import struct, sys
w = h = 16
xor = b''
for y in range(h):
    for x in range(w):
        xor += bytes((0xE0, 0x90, 0x20, 0xFF))   # BGRA
and_mask = b'\x00' * (4 * h)
dib = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(xor) + len(and_mask),
                   0, 0, 0, 0)
image = dib + xor + and_mask
header = struct.pack('<HHH', 0, 1, 1)
entry = struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(image), 6 + 16)
open(sys.argv[1], 'wb').write(header + entry + image)
print('generated', sys.argv[1])
PY
ICO_GENERATED=1
echo "=> this probe generated a temporary .ico"
else
  echo "an .ico already exists -- skipping generation"
  echo "=> the pre-existing .ico is NOT a probe artefact and will be PRESERVED"
fi
echo

cd "$SRC_TAURI" || exit 1

# ---------------------------------------------------------------------------
# Step 2: cargo check. Output goes to a log file so the exit code is cargo's
# own (no PIPESTATUS trick) and so the raw text stays available.
# ---------------------------------------------------------------------------
echo "--- 2. cargo check (type check + metadata, NO final link) ---"
PATH="$MSYS_BIN:$PATH" "$CARGO" +stable-x86_64-pc-windows-gnu check > "$CHECK_LOG" 2>&1
GNU_CHECK_EXIT=$?
echo "\$ tail -8 $CHECK_LOG"
tail -8 "$CHECK_LOG"
echo "GNU_CHECK_EXIT=$GNU_CHECK_EXIT"
echo

# ---------------------------------------------------------------------------
# Step 3: cargo build -- performs the FINAL LINK of the cdylib.
# The full output is captured WITHOUT --message-format short, because the
# linker diagnostic only shows up in rustc's "= note:" sub-diagnostics.
# ---------------------------------------------------------------------------
echo "--- 3. cargo build (performs the FINAL LINK of the cdylib) ---"
PATH="$MSYS_BIN:$PATH" "$CARGO" +stable-x86_64-pc-windows-gnu build > "$BUILD_LOG" 2>&1
GNU_BUILD_EXIT=$?
echo "\$ tail -25 $BUILD_LOG"
tail -25 "$BUILD_LOG"
echo "GNU_BUILD_EXIT=$GNU_BUILD_EXIT"
echo

# ---------------------------------------------------------------------------
# Step 4: verdict -- keyed on the linker marker, not on the exit code alone.
#
# Three failure shapes must stay distinguishable, because they need different
# follow-up actions:
#   (1) the cdylib export ordinal exceeds the PE limit  -> cause 4
#   (2) some OTHER link error                          -> a different cause
#   (3) the build never reached the link step            -> cause 4 was not
#       (compile error, rustc crash)                      evaluated at all
#
# rustc emits the header "linking with ... failed" only when it actually
# invoked the linker, so its presence in the build log is what separates (2)
# from (3). A compile error or a crashed rustc exits with 101 as well, so the
# exit code alone cannot tell them apart.
# ---------------------------------------------------------------------------
ORDINAL_MARKER="export ordinal too large"
LINK_HEADER="linking with"
echo "--- 4. verdict ---"
echo "cargo check exit : $GNU_CHECK_EXIT"
echo "cargo build exit : $GNU_BUILD_EXIT"
echo "build log        : $BUILD_LOG"
echo

if [ "$GNU_CHECK_EXIT" != "0" ]; then
  echo "=> cargo check FAILED (exit $GNU_CHECK_EXIT)."
  echo "   The type-check step did not complete, so this run says NOTHING about"
  echo "   whether the crate links. Cause 4 is NOT evaluated by this run."
fi

if grep -qi "$ORDINAL_MARKER" "$BUILD_LOG"; then
  echo "=> linker marker FOUND in the cargo build output:"
  grep -i -A2 -B2 "$ORDINAL_MARKER" "$BUILD_LOG" | head -12
  echo
  echo "=> CAUSE 4 REPRODUCED: the cdylib export ordinal exceeds the PE"
  echo "   export-ordinal limit (65535). This is specifically the"
  echo "   'export ordinal too large' failure, not some other link error."
else
  if [ "$GNU_BUILD_EXIT" = "0" ]; then
    echo "=> cargo build succeeded on the gnu toolchain."
  elif grep -qi "$LINK_HEADER" "$BUILD_LOG"; then
    echo "=> cargo build FAILED and the marker '$ORDINAL_MARKER' is ABSENT."
    echo "=> The build log DOES contain rustc's link-failure header"
    echo "   ('$LINK_HEADER ... failed'), so the linker WAS reached and failed"
    echo "   for a DIFFERENT reason than cause 4 -- cause 4 is NOT reproduced"
    echo "   by this run. The link error above must be classified on its own;"
    echo "   the exit code alone cannot tell them apart."
  else
    echo "=> cargo build FAILED (exit $GNU_BUILD_EXIT) and the marker"
    echo "   '$ORDINAL_MARKER' is ABSENT."
    echo "=> The build log contains NO '$LINK_HEADER' header, so the build"
    echo "   FAILED BEFORE THE LINK STEP (compile error, or a rustc crash)."
    echo "=> Cause 4 was NOT evaluated by this run: the linker never ran, so"
    echo "   this output says nothing about the export ordinal either way."
    echo "   Classify the compile/rustc failure above on its own."
  fi
fi
echo

if [ "$GNU_CHECK_EXIT" = "0" ] && [ "$GNU_BUILD_EXIT" != "0" ]; then
  echo "=> A green 'cargo check' does NOT prove the crate links."
  echo "=> The B-02 cause list is therefore NOT exhaustive for the gnu toolchain."
fi
echo

# ---------------------------------------------------------------------------
# Cleanup: only remove an .ico that THIS run created.
# ---------------------------------------------------------------------------
if [ "$ICO_GENERATED" = "1" ]; then
  rm -f "$ICO_NATIVE"
  echo "removed the probe-generated .ico: $([ -f "$ICO_NATIVE" ] && echo STILL_THERE || echo ok)"
else
  echo "PRESERVED the pre-existing .ico (this probe did not create it):"
  echo "  $ICO_NATIVE"
  echo "  present after the probe: $([ -f "$ICO_NATIVE" ] && echo yes || echo NO)"
fi
