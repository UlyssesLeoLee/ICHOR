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
# Usage: bash tools/ats101-probes/collect-b02-build-link.sh
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_TAURI="$REPO_ROOT/src-tauri"
CARGO="$HOME/.cargo/bin/cargo.exe"
MSYS_BIN="/c/msys64/mingw64/bin"
ICO_NATIVE="$(cygpath -w "$SRC_TAURI/icons/icon.ico")"

echo "=== ATS-101 B-02: cargo check vs cargo build (link step) ==="
echo "date : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "host : $(uname -s) / shell=bash"
echo

echo "--- 0. toolchain + crate type ---"
"$CARGO" --version
"$CARGO" +stable-x86_64-pc-windows-gnu --version
echo "\$ grep crate-type src-tauri/Cargo.toml"
grep -n 'crate-type' "$SRC_TAURI/Cargo.toml"
echo

echo "--- 1. provide a valid .ico (probe artefact, removed at the end) ---"
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
else
  echo "an .ico already exists -- skipping generation"
fi
echo

cd "$SRC_TAURI" || exit 1

echo "--- 2. cargo check (type check + metadata, NO final link) ---"
PATH="$MSYS_BIN:$PATH" "$CARGO" +stable-x86_64-pc-windows-gnu check --message-format short 2>&1 | tail -8
GNU_CHECK_EXIT="${PIPESTATUS[0]}"
echo "GNU_CHECK_EXIT=$GNU_CHECK_EXIT"
echo

echo "--- 3. cargo build (performs the FINAL LINK of the cdylib) ---"
PATH="$MSYS_BIN:$PATH" "$CARGO" +stable-x86_64-pc-windows-gnu build --message-format short 2>&1 | tail -25
GNU_BUILD_EXIT="${PIPESTATUS[0]}"
echo "GNU_BUILD_EXIT=$GNU_BUILD_EXIT"
echo

echo "--- 4. verdict ---"
echo "cargo check exit : $GNU_CHECK_EXIT"
echo "cargo build exit : $GNU_BUILD_EXIT"
if [ "$GNU_CHECK_EXIT" = "0" ] && [ "$GNU_BUILD_EXIT" != "0" ]; then
  echo "=> A green 'cargo check' does NOT prove the crate links."
  echo "=> The B-02 cause list is therefore NOT exhaustive for the gnu toolchain."
elif [ "$GNU_BUILD_EXIT" = "0" ]; then
  echo "=> cargo build succeeded on the gnu toolchain."
else
  echo "=> cargo check itself failed; see the output above."
fi
echo

echo "NOTE: the generated .ico is a probe artefact only and is NOT part of the"
echo "deliverable. Removing it again: $(rm -f "$ICO_NATIVE" && echo ok)"
