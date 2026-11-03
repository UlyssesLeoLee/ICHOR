#!/usr/bin/env bash
# ATS-101 evidence collector -- B-02 gnu-chain diagnosis (precise).
#
# Question: why does `cargo +stable-x86_64-pc-windows-gnu check` fail with
#   lld: error: unable to find library -lgcc_eh
#   lld: error: unable to find library -lgcc
#
# Facts established by inspection:
#   * the `x86_64-w64-mingw32-gcc` that PATH resolves to is the WinGet
#     LLVM-MinGW UCRT 20260908 build (clang 23.1.1);
#   * that distribution ships NO libgcc/libgcc_eh;
#   * rustup's own gnu toolchain DOES ship libgcc.a / libgcc_eh.a / libgcc_s.a
#     under .../lib/rustlib/x86_64-pc-windows-gnu/lib/self-contained/.
#
# Test: put rustup's self-contained gcc (bin/self-contained) first on PATH and
# add its lib/self-contained to the linker search path, then re-run.
#
# Usage: bash tools/ats101-probes/collect-b02-gnu-diagnosis.sh
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_TAURI="$REPO_ROOT/src-tauri"
CARGO="$HOME/.cargo/bin/cargo.exe"
GNU_ROOT="$HOME/.rustup/toolchains/stable-x86_64-pc-windows-gnu/lib/rustlib/x86_64-pc-windows-gnu"
GNU_BIN="$GNU_ROOT/bin/self-contained"
GNU_LIB="$GNU_ROOT/lib/self-contained"

echo "=== ATS-101 B-02 gnu-chain diagnosis ==="
echo "date : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

echo "--- 1. the compiler PATH currently resolves to ---"
GCC="$(command -v x86_64-w64-mingw32-gcc 2>/dev/null)"
echo "x86_64-w64-mingw32-gcc = ${GCC:-<not found>}"
"$GCC" --version 2>&1 | head -2
echo "libgcc/libgcc_eh shipped next to it:"
find "$(dirname "$GCC")/.." -name 'libgcc*' 2>/dev/null | head -5
echo "(no output = it ships none)"
echo

echo "--- 2. rustup's own gnu toolchain DOES ship them ---"
ls "$GNU_LIB" 2>&1
echo

echo "--- 3. baseline: gnu check with the current PATH ---"
cd "$SRC_TAURI" || exit 1
"$CARGO" +stable-x86_64-pc-windows-gnu check --message-format short 2>&1 | grep -E 'lld:|clang-[0-9]+: error|^error: linking' | sort -u | head -6
echo "GNU_BASELINE_EXIT=${PIPESTATUS[0]}"
echo

echo "--- 4. test: rustup's gcc first on PATH + its lib dir on the link path ---"
RUSTFLAGS="-L native=$GNU_LIB" \
PATH="$GNU_BIN:$PATH" \
  "$CARGO" +stable-x86_64-pc-windows-gnu check --message-format short 2>&1 | tail -12
echo "GNU_WITH_RUSTUP_GCC_EXIT=${PIPESTATUS[0]}"
echo

echo "--- 5. verdict input ---"
echo "If GNU_WITH_RUSTUP_GCC_EXIT is 0, the gnu failure is a compiler/runtime"
echo "mismatch (PATH picks LLVM-MinGW, which ships no libgcc) and is fixable."
echo "If it is still 101, the gnu failure is NOT diagnosed here and must be"
echo "reported as undiagnosed."
