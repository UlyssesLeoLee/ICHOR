#!/usr/bin/env bash
# ATS-101 evidence collector -- B-02 cause 2: missing Windows .ico resource.
#
# tauri-build's `WindowsResource` step runs for ANY windows target triple and
# resolves the window icon as:
#
#     config.bundle.icon.first(|i| i.ends_with(".ico"))  or  "icons/icon.ico"
#
# The repository ships only PNG icons (32x32 / 128x128 / 256x256) and
# `bundle.icon` lists no .ico, so the build asks for `src-tauri/icons/icon.ico`,
# which is not tracked in git. The build therefore fails on a missing file that
# a fresh clone can never satisfy.
#
# This script proves:
#   1. the .ico is absent from the working tree AND from git;
#   2. the build fails naming exactly that path;
#   3. providing a valid .ico lets the build proceed past that step.
#
# Usage: bash tools/ats101-probes/collect-b02-icon.sh
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_TAURI="$REPO_ROOT/src-tauri"
CARGO="$HOME/.cargo/bin/cargo.exe"
MSYS_BIN="/c/msys64/mingw64/bin"

echo "=== ATS-101 B-02 cause 2 diagnosis: Windows .ico resource ==="
echo "date : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

echo "--- 1. what the repository ships ---"
echo "\$ ls src-tauri/icons/"
ls "$SRC_TAURI/icons" 2>&1
echo
echo "\$ git ls-files src-tauri/icons/"
( cd "$REPO_ROOT" && git ls-files src-tauri/icons/ )
echo
echo "any .ico anywhere in the repo?"
( cd "$REPO_ROOT" && find . -name '*.ico' -not -path '*/node_modules/*' 2>/dev/null | head )
echo "(empty = the repo contains no .ico at all)"
echo
echo "\$ python -c 'import json;print(json.load(open(\"src-tauri/tauri.conf.json\"))[\"bundle\"])'"
python -c "import json;print(json.load(open(r'$(cygpath -w "$SRC_TAURI/tauri.conf.json")'))['bundle'])" 2>&1
echo "=> bundle.icon lists NO .ico entry, so tauri-build falls back to 'icons/icon.ico'."
echo

echo "--- 2. the build fails naming exactly that path ---"
cd "$SRC_TAURI" || exit 1
PATH="$MSYS_BIN:$PATH" "$CARGO" +stable-x86_64-pc-windows-gnu check --message-format short 2>&1 \
  | grep -iE "icon\.ico|not found; required" | head -5
echo
echo "(the MSYS2 MinGW toolchain is used here because the default LLVM-MinGW"
echo " compiler fails earlier, at the link stage, for an unrelated reason --"
echo " see 03-build-constraints.log. This probe is about the ICON, not the linker.)"
echo

echo "--- 3. with a valid .ico present the build proceeds past the icon step ---"
ICO_NATIVE="$(cygpath -w "$SRC_TAURI/icons/icon.ico")"
if [ -f "$ICO_NATIVE" ]; then
  echo "an .ico already exists -- skipping generation"
else
  python - "$ICO_NATIVE" <<'PY'
import struct, sys
# Minimal but valid 16x16 32-bit ICO containing one solid-blue image.
w = h = 16
xor = b''
for y in range(h):
    for x in range(w):
        xor += bytes((0xE0, 0x90, 0x20, 0xFF))   # BGRA
and_mask = b'\x00' * (4 * h)                   # 1bpp AND mask, padded
dib = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(xor) + len(and_mask),
                   0, 0, 0, 0)
image = dib + xor + and_mask
header = struct.pack('<HHH', 0, 1, 1)
entry = struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(image), 6 + 16)
open(sys.argv[1], 'wb').write(header + entry + image)
print('generated', sys.argv[1])
PY
fi
PATH="$MSYS_BIN:$PATH" "$CARGO" +stable-x86_64-pc-windows-gnu check --message-format short 2>&1 | tail -8
echo "GNU_WITH_ICO_EXIT=${PIPESTATUS[0]}"
echo
echo "NOTE: the generated .ico is a build artefact for this probe only."
echo "It is written into src-tauri/icons/ and is NOT part of the deliverable;"
echo "delete it (and src-tauri/target) before committing."
rm -f "$ICO_NATIVE"
echo "removed the probe .ico again: $([ -f "$ICO_NATIVE" ] && echo STILL_THERE || echo ok)"
