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

# Resolve a path-like override to an absolute path, anchored at the directory
# the probe was started from. Windows drive paths keep their drive and get
# forward slashes; POSIX paths are returned unchanged; everything else is
# prefixed with the current directory.
#
# This runs BEFORE the probe changes its working directory into src-tauri/,
# so a relative override keeps pointing at the same file afterwards.
to_abs_path() {
  local p="$1"
  case "$p" in
    [A-Za-z]:*)
      local drive="${p%%:*}" rest="${p#*:}"
      rest="${rest//\\//}"
      rest="${rest#/}"
      printf '%s:/%s\n' "$drive" "$rest"
      ;;
    /*) printf '%s\n' "$p" ;;
    *) printf '%s\n' "$PWD/$p" ;;
  esac
}

# ATS_PROBE_CARGO overrides the cargo binary. It exists so the verdict logic
# can be exercised with a stub cargo (see README discipline #5): the three
# failure shapes -- export ordinal, other link error, pre-link failure -- are
# told apart by the build log, so they can be reproduced without a real build.
# The exit code of the cargo call itself is classified separately (see the
# verdict section): a launch failure (126/127) is the shell's code, not
# cargo's, so it must never be reported as a build failure of the crate.
CARGO="$(to_abs_path "${ATS_PROBE_CARGO:-$HOME/.cargo/bin/cargo.exe}")"
MSYS_BIN="/c/msys64/mingw64/bin"
ICO_NATIVE="$(cygpath -w "$SRC_TAURI/icons/icon.ico")"
LOG_DIR="$(to_abs_path "${ATS_PROBE_LOG_DIR:-${TMPDIR:-/tmp}/ats101-probes}")"
CHECK_LOG="$LOG_DIR/b02-build-link-cargo-check.log"
BUILD_LOG="$LOG_DIR/b02-build-link-cargo-build.log"

mkdir -p "$LOG_DIR" 2>/dev/null

# Whether the cargo binary can be started at all. When it cannot, the exit
# codes below are the shell's (126/127), not cargo's, and the verdict must say
# so instead of attributing the failure to a compile error or a rustc crash.
CARGO_LAUNCH_EXIT=0
CARGO_LAUNCH_REASON=""
if [ ! -e "$CARGO" ]; then
  CARGO_LAUNCH_EXIT=127
  CARGO_LAUNCH_REASON="the file does not exist"
elif [ ! -x "$CARGO" ]; then
  CARGO_LAUNCH_EXIT=126
  CARGO_LAUNCH_REASON="the file is not executable"
fi

echo "=== ATS-101 B-02: cargo check vs cargo build (link step) ==="
echo "date : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "host : $(uname -s) / shell=bash"
echo "logs : $LOG_DIR"
echo

echo "--- 0. toolchain + crate type ---"
if [ "$CARGO_LAUNCH_EXIT" = "0" ]; then
  "$CARGO" --version
  "$CARGO" +stable-x86_64-pc-windows-gnu --version
else
  echo "=> cargo cannot be started ($CARGO_LAUNCH_REASON): $CARGO"
  echo "   skipping the toolchain queries and both cargo steps."
fi
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
if [ "$CARGO_LAUNCH_EXIT" = "0" ]; then
  PATH="$MSYS_BIN:$PATH" "$CARGO" +stable-x86_64-pc-windows-gnu check > "$CHECK_LOG" 2>&1
  GNU_CHECK_EXIT=$?
  echo "\$ tail -8 $CHECK_LOG"
  tail -8 "$CHECK_LOG"
else
  GNU_CHECK_EXIT="n/a"
  echo "=> skipped: cargo cannot be started ($CARGO_LAUNCH_REASON)."
fi
echo "GNU_CHECK_EXIT=$GNU_CHECK_EXIT"
echo

# ---------------------------------------------------------------------------
# Step 3: cargo build -- performs the FINAL LINK of the cdylib.
# The full output is captured WITHOUT --message-format short, because the
# linker diagnostic only shows up in rustc's "= note:" sub-diagnostics.
# ---------------------------------------------------------------------------
echo "--- 3. cargo build (performs the FINAL LINK of the cdylib) ---"
if [ "$CARGO_LAUNCH_EXIT" = "0" ]; then
  PATH="$MSYS_BIN:$PATH" "$CARGO" +stable-x86_64-pc-windows-gnu build > "$BUILD_LOG" 2>&1
  GNU_BUILD_EXIT=$?
  echo "\$ tail -25 $BUILD_LOG"
  tail -25 "$BUILD_LOG"
else
  GNU_BUILD_EXIT="n/a"
  echo "=> skipped: cargo cannot be started ($CARGO_LAUNCH_REASON)."
fi
echo "GNU_BUILD_EXIT=$GNU_BUILD_EXIT"
echo

# ---------------------------------------------------------------------------
# Step 4: verdict -- keyed on the linker marker AND on the exit code.
#
# The build verdict needs TWO independent signals, because neither one alone
# is sufficient:
#
#   * the exit code says WHETHER cargo produced a build outcome at all:
#       0     -> the build succeeded
#       101   -> cargo ran and produced NO build outcome (cargo's GENERAL
#                failure code: compile error, rustc crash, link error,
#                manifest parse error, dependency resolution error)
#       126   -> the shell found the cargo file but could not execute it
#       127   -> the shell could not find the cargo file to execute
#       other -> cargo/toolchain did not run normally (toolchain not
#                installed, log not writable, ...) -- there is NO build
#                outcome to classify
#   * the build log says WHICH failure it was, but only among the failures
#     that actually reached rustc: rustc emits the header
#     "linking with ... failed" only when it invoked the linker, so its
#     presence separates "the linker was reached" from "the build died
#     before the link step".
#
# 126 and 127 are the SHELL's codes, not cargo's, so they must never be
# reported as a build failure of the crate. Any other non-zero code means
# cargo did not run to a build outcome, so it must never be reported as a
# compile failure either. Only exit 101 -- cargo's GENERAL failure code --
# may be classified as a build failure. 101 is not specific to a failed
# build: cargo also returns it for a manifest parse error or a dependency
# resolution error, so the exit code alone cannot name the failure. What
# exit 101 plus a build log WITHOUT the 'linking with' header does tell us
# is that cargo failed BEFORE it invoked the linker -- a compile error or a
# rustc crash are two of the possible causes, but so are cargo's own errors
# (manifest parsing, dependency resolution). The verdict therefore names
# the class and defers the exact cause to the log.
#
# The verdict about cause 4 belongs to the BUILD step alone. The check step
# reports its own outcome and says nothing about cause 4, so that a failing
# check cannot contradict the build verdict.
# ---------------------------------------------------------------------------
ORDINAL_MARKER="export ordinal too large"
LINK_HEADER="linking with"

# Classify one cargo invocation's exit code.
#   completed    -> 0
#   build-failed -> 101 (cargo ran and produced no build outcome)
#   not-started  -> 126/127 (the shell could not execute the cargo file)
#   no-verdict   -> any other non-zero code (cargo did not run normally)
classify_cargo_exit() {
  case "$1" in
    0)       echo "completed" ;;
    101)     echo "build-failed" ;;
    126|127) echo "not-started" ;;
    *)       echo "no-verdict" ;;
  esac
}

CHECK_CLASS="skipped"
BUILD_CLASS="skipped"

echo "--- 4. verdict ---"
echo "cargo check exit : $GNU_CHECK_EXIT"
echo "cargo build exit : $GNU_BUILD_EXIT"
echo "cargo binary     : $CARGO"
echo "build log        : $BUILD_LOG"
echo

if [ "$CARGO_LAUNCH_EXIT" != "0" ]; then
  # Static pre-check: the cargo file is missing or not executable, so the
  # probe never reached a cargo invocation at all.
  CHECK_CLASS="not-started"
  BUILD_CLASS="not-started"
  echo "=> cargo could NOT be started (exit $CARGO_LAUNCH_EXIT): $CARGO_LAUNCH_REASON."
  echo "   The probe never reached a cargo invocation, so neither step produced"
  echo "   a cargo exit code. This is a PROBE SETUP problem, NOT a compile error,"
  echo "   NOT a rustc crash and NOT a link failure -- the cause of this failure"
  echo "   must be located in the cargo path or in the shell's launch error."
  echo "   Cause 4 was NOT evaluated by this run: cargo never ran."
else
  CHECK_CLASS="$(classify_cargo_exit "$GNU_CHECK_EXIT")"
  BUILD_CLASS="$(classify_cargo_exit "$GNU_BUILD_EXIT")"

  if [ "$CHECK_CLASS" != "completed" ]; then
    case "$CHECK_CLASS" in
      build-failed)
        echo "=> cargo check FAILED (exit $GNU_CHECK_EXIT)."
        echo "   The type-check step did not complete, so this run says NOTHING about"
        echo "   whether the crate links."
        echo "   The cause-4 verdict below comes from the cargo BUILD step only."
        ;;
      not-started)
        echo "=> cargo could NOT be started (exit $GNU_CHECK_EXIT): the shell could"
        echo "   not execute the cargo binary. This is a PROBE SETUP problem, NOT a"
        echo "   compilation failure, NOT a rustc crash and NOT a link failure."
        echo "   The cause-4 verdict below comes from the cargo BUILD step only."
        ;;
      *)
        echo "=> cargo check did not run to a verdict (exit $GNU_CHECK_EXIT)."
        echo "   cargo/toolchain did not run normally, so this run says NOTHING"
        echo "   about whether the crate links. This is NOT a compilation failure,"
        echo "   NOT a rustc crash and NOT a link failure."
        echo "   The cause-4 verdict below comes from the cargo BUILD step only."
        ;;
    esac
  fi

  case "$BUILD_CLASS" in
    completed)
      echo "=> cargo build succeeded on the gnu toolchain."
      ;;
    not-started)
      echo "=> cargo could NOT be started (exit $GNU_BUILD_EXIT): the shell could"
      echo "   not execute the cargo binary. This is a PROBE SETUP problem, NOT a"
      echo "   compilation failure, NOT a rustc crash and NOT a link failure -- the"
      echo "   cargo call never produced a build outcome."
      echo "   Cause 4 was NOT evaluated by this run: cargo never ran a build."
      ;;
    no-verdict)
      echo "=> cargo build did not run to a verdict (exit $GNU_BUILD_EXIT)."
      echo "   cargo/toolchain did not run normally, so this run produces NO build"
      echo "   verdict. This is NOT a compilation failure, NOT a rustc crash and"
      echo "   NOT a link failure -- classify the cargo output above on its own."
      echo "   Cause 4 was NOT evaluated by this run: cargo never produced a build"
      echo "   outcome to inspect."
      ;;
    build-failed)
      if grep -qi "$ORDINAL_MARKER" "$BUILD_LOG"; then
        echo "=> linker marker FOUND in the cargo build output:"
        grep -i -A2 -B2 "$ORDINAL_MARKER" "$BUILD_LOG" | head -12
        echo
        echo "=> CAUSE 4 REPRODUCED: the cdylib export ordinal exceeds the PE"
        echo "   export-ordinal limit (65535). This is specifically the"
        echo "   'export ordinal too large' failure, not some other link error."
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
              echo "=> The build log contains NO '$LINK_HEADER' header, so cargo failed"
              echo "   BEFORE THE LINK STEP: the linker was never invoked."
              echo "=> The possible causes are a compile error, a rustc crash, or one of"
              echo "   cargo's OWN errors (manifest parsing, dependency resolution) --"
              echo "   exit $GNU_BUILD_EXIT is cargo's general failure code and does not"
              echo "   name the cause. Read the log above and classify it on its own."
              echo "=> Cause 4 was NOT evaluated by this run: the linker never ran, so"
              echo "   this output says nothing about the export ordinal either way."
            fi
      ;;
  esac
fi
echo

if [ "$BUILD_CLASS" = "build-failed" ] && [ "$CHECK_CLASS" = "completed" ]; then
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
