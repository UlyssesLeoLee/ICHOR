#!/usr/bin/env bash
# ATS-101 evidence collector -- B-02 gnu-chain diagnosis + shell-dependent error text.
#
# Two questions this answers with actual output:
#
#   Q1  Why does the gnu toolchain fail?  Hypothesis: PATH resolution picks the
#       WinGet LLVM-MinGW clang-based `x86_64-w64-mingw32-gcc`, which does not
#       ship libgcc/libgcc_eh, while rustup's own gnu toolchain DOES ship them
#       under .../lib/rustlib/x86_64-pc-windows-gnu/lib/self-contained/.
#       Test: put rustup's self-contained dir FIRST on PATH and re-run.
#
#   Q2  Is the linker error text really shell-dependent?  Test: run the msvc
#       chain from PowerShell with Git's /usr/bin removed from PATH, so
#       `link.exe` cannot resolve to GNU coreutils' link.
#
# Usage: bash tools/ats101-probes/collect-b02-diagnosis.sh
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_TAURI="$REPO_ROOT/src-tauri"
CARGO="$HOME/.cargo/bin/cargo.exe"
GNU_SELF="$HOME/.rustup/toolchains/stable-x86_64-pc-windows-gnu/lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained"

echo "=== ATS-101 B-02 diagnosis collector ==="
echo "date : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

echo "--- Q1 setup: which linker does each candidate provide? ---"
echo "\$ command -v x86_64-w64-mingw32-gcc            # PATH resolution"
command -v x86_64-w64-mingw32-gcc 2>&1 || echo "(not found)"
echo
echo "\$ ls \$GNU_SELF                               # rustup's own gnu toolchain"
ls "$GNU_SELF" 2>&1
echo
echo "libgcc / libgcc_eh shipped by rustup gnu toolchain:"
ls "$GNU_SELF"/libgcc*.a 2>&1
echo
LLVM_BIN="$(dirname "$(command -v x86_64-w64-mingw32-gcc 2>/dev/null)")"
echo "libgcc / libgcc_eh shipped by the PATH-provided compiler ($LLVM_BIN):"
ls "$LLVM_BIN"/../lib/gcc 2>/dev/null | head -5
find "$LLVM_BIN/.." -name "libgcc*" 2>/dev/null | head -5
echo "(no output above = the PATH-provided compiler does NOT ship libgcc)"
echo

echo "--- Q1 test: rustup self-contained gcc FIRST on PATH ---"
cd "$SRC_TAURI" || exit 1
PATH="$GNU_SELF:$PATH" "$CARGO" +stable-x86_64-pc-windows-gnu check --message-format short 2>&1 | tail -12
echo "GNU_WITH_RUSTUP_GCC_EXIT=${PIPESTATUS[0]}"
echo

echo "--- Q2 setup: msvc chain from PowerShell WITHOUT Git /usr/bin on PATH ---"
PS_SRC="$(cygpath -w "$SRC_TAURI")"
PS_CARGO="$(cygpath -w "$HOME/.cargo/bin/cargo.exe")"
if command -v powershell.exe >/dev/null 2>&1; then
  # Strip the Git usr/bin entry so `link.exe` cannot resolve to GNU coreutils.
  CLEAN_PATH="$(cygpath -w "$PATH" | tr ';' '\n' | grep -v 'Git[/\\]usr[/\\]bin' | paste -sd';' -)"
  echo "PATH without Git usr/bin:"
  cygpath -w "$PATH" | tr ';' '\n' | grep -n 'Git.*usr.*bin' | head -3
  powershell.exe -NoProfile -NonInteractive -Command \
    "\$env:PATH='$CLEAN_PATH'; cd '$PS_SRC'; & '$PS_CARGO' check --message-format short 2>&1 | Select-String -Pattern 'linking with|^note:|link.exe' | Select-Object -First 8; exit \$LASTEXITCODE" 2>&1
  echo "MSVC_PS_CLEANPATH_EXIT=$?"
else
  echo "powershell.exe not available -- skipped"
fi
echo
echo "--- summary ---"
echo "gnu with rustup self-contained gcc first : see GNU_WITH_RUSTUP_GCC_EXIT above"
echo "msvc from PowerShell without Git usr/bin : see MSVC_PS_CLEANPATH_EXIT above"
