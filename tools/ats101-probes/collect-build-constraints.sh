#!/usr/bin/env bash
# ATS-101 evidence collector -- Tauri / Rust toolchain diagnosis (B-02).
#
# Runs `cargo check` for BOTH toolchains and records the ACTUAL output, plus
# the VS component probe. Each invocation is labelled with the shell it ran
# under, because the linker error text differs between Git Bash and
# PowerShell (see the "shell-dependent error text" note in the evidence log).
#
# Usage: bash tools/ats101-probes/collect-build-constraints.sh
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_TAURI="$REPO_ROOT/src-tauri"
CARGO="$HOME/.cargo/bin/cargo.exe"
VSWHERE="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"

echo "=== ATS-101 build constraints collector ==="
echo "repo root      : $REPO_ROOT"
echo "src-tauri      : $SRC_TAURI"
echo "date           : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "host           : $(uname -a)"
echo

echo "--- 1. toolchain presence ---"
echo "\$ ~/.cargo/bin/cargo.exe --version"
"$CARGO" --version 2>&1
echo "\$ ~/.cargo/bin/rustc.exe -vV"
"$HOME/.cargo/bin/rustc.exe" -vV 2>&1
echo "\$ ~/.cargo/bin/rustup.exe toolchain list"
"$HOME/.cargo/bin/rustup.exe" toolchain list 2>&1
echo "cargo on PATH  : $(command -v cargo || echo '(not on PATH)')"
echo

echo "--- 2. Visual Studio C++ workload probe ---"
echo "\$ vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath"
"$VSWHERE" -latest -products '*' \
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 \
  -property installationPath 2>&1
echo "(exit=$? ; empty output above = the C++ workload is NOT installed)"
echo
echo "\$ vswhere -latest -products '*' -property installationPath   (VS itself)"
"$VSWHERE" -latest -products '*' -property installationPath 2>&1
VS_PATH="$("$VSWHERE" -latest -products '*' -property installationPath 2>&1 | tr -d '\r')"
echo "VS install path: ${VS_PATH:-<none>}"
echo "VC/Tools/MSVC exists: $([ -d "$VS_PATH/VC/Tools/MSVC" ] && echo yes || echo NO)"
echo

echo "--- 3. dependency resolution (lockfile) ---"
cd "$SRC_TAURI" || exit 1
echo "\$ cargo generate-lockfile"
"$CARGO" generate-lockfile 2>&1 | tail -5
echo "lockfile exit=$?"
if [ -f Cargo.lock ]; then
  echo "locked packages: $(grep -c '^\[\[package\]\]' Cargo.lock)"
  echo "tauri version  : $(grep -A1 'name = \"tauri\"' Cargo.lock | grep version | head -1)"
fi
echo

echo "--- 4. cargo check, msvc toolchain (default) ---"
echo "shell: Git Bash (MSYS) -- PATH resolution applies"
"$CARGO" check --message-format short 2>&1 | tail -30
MSVC_EXIT="${PIPESTATUS[0]}"
echo "CARGO_CHECK_EXIT=$MSVC_EXIT"
echo

echo "--- 5. cargo check, gnu toolchain ---"
echo "shell: Git Bash (MSYS) -- PATH resolution applies"
"$CARGO" +stable-x86_64-pc-windows-gnu check --message-format short 2>&1 | tail -30
GNU_EXIT="${PIPESTATUS[0]}"
echo "GNU_CHECK_EXIT=$GNU_EXIT"
echo

echo "--- 6. GNU toolchain: which compiler is actually used ---"
echo "\$ command -v x86_64-w64-mingw32-gcc"
command -v x86_64-w64-mingw32-gcc 2>&1 || echo "(not found on PATH)"
XGCC="$(command -v x86_64-w64-mingw32-gcc 2>/dev/null)"
if [ -n "$XGCC" ]; then
  echo "\$ x86_64-w64-mingw32-gcc --version"
  "$XGCC" --version 2>&1 | head -3
fi
echo

echo "--- 7. GNU toolchain under PowerShell (different PATH resolution) ---"
if command -v powershell.exe >/dev/null 2>&1; then
  # PowerShell is a native Windows program: it needs native paths, not MSYS ones.
  PS_SRC="$(cygpath -w "$SRC_TAURI")"
  PS_CARGO="$(cygpath -w "$HOME/.cargo/bin/cargo.exe")"
  echo "native paths: src-tauri=$PS_SRC"
  powershell.exe -NoProfile -NonInteractive -Command \
    "cd '$PS_SRC'; & '$PS_CARGO' +stable-x86_64-pc-windows-gnu check --message-format short 2>&1 | Select-Object -Last 25; exit \$LASTEXITCODE" 2>&1
  echo "GNU_PS_EXIT=$?"
  echo
  echo "--- 7b. msvc toolchain under PowerShell (same shell, for error-text comparison) ---"
  powershell.exe -NoProfile -NonInteractive -Command \
    "cd '$PS_SRC'; & '$PS_CARGO' check --message-format short 2>&1 | Select-Object -Last 25; exit \$LASTEXITCODE" 2>&1
  echo "MSVC_PS_EXIT=$?"
else
  echo "powershell.exe not available -- skipped"
fi
echo

echo "--- 8. summary ---"
echo "msvc cargo check exit : $MSVC_EXIT"
echo "gnu  cargo check exit : $GNU_EXIT"
echo "VS C++ workload       : $([ -d "$VS_PATH/VC/Tools/MSVC" ] && echo installed || echo 'NOT installed')"
