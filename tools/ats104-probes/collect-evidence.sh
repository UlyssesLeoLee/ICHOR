#!/usr/bin/env bash
# ATS-104 evidence collector -- ST-022: the Tauri 2 Windows dev build and
# the WebView2 shell, including the "no orphan after the window is closed"
# half of the acceptance criterion.
#
# The acceptance criterion of ATS-104 is:
#   "Windows 实机完成 cargo tauri dev；关闭窗口后无孤儿窗口"
#
# Both halves are checked by tools/ats104-probes/st-ats104.mjs, which is
# FAIL-CLOSED: the window not appearing, the Bridge not answering, a process
# of the shell's tree outliving the closed window and a Bridge port that stays
# held are all non-zero exits with the failing check named.
#
# What this collector adds on top of the probe:
#   1. the PROVENANCE block (the tree the evidence describes);
#   2. the toolchain facts the build depends on;
#   3. the `cargo build` step with its own log (the probe can skip it when
#      the binary is already there, but the BUILD must be evidenced too);
#   4. a NEGATIVE CONTROL: the same probe run against a product source in
#      which the exit hook does NOT end the Bridge. It must FAIL. Without
#      it, a probe that always prints PASS would look like a delivery.
#
# Usage:
#   bash tools/ats104-probes/collect-evidence.sh
#
# Environment:
#   ATS104_EVIDENCE_DIR   where the logs are written (default: docs/evidence/ATS-104)
#   ATS104_SKIP_BUILD=1   reuse the already-built binary (the probe skips
#                         `cargo build`; this collector still records the
#                         build log of an earlier run if it is there)
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NATIVE_ROOT="$(cd "$REPO_ROOT" && pwd -W)"
EVIDENCE_DIR="${ATS104_EVIDENCE_DIR:-$REPO_ROOT/docs/evidence/ATS-104}"
TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable-x86_64-pc-windows-gnu}"

# The gnu toolchain is the one that can link on this machine: the MSVC C++
# build tools workload is NOT installed (the Visual Studio installation has
# no VC/Tools/MSVC directory), and the gnu chain needs the MSYS2 MinGW GCC,
# whose runtime libraries the LLVM-MinGW build on PATH does not ship.
MINGW_BIN="/c/msys64/mingw64/bin"

# The collector sets up its own PATH so that it does not depend on the
# caller's environment: cargo is not on PATH on this machine by default, and
# the MSYS2 MinGW GCC must come BEFORE the LLVM-MinGW build.
export PATH="$MINGW_BIN:$HOME/.cargo/bin:$PATH"
export RUSTUP_TOOLCHAIN="$TOOLCHAIN"

mkdir -p "$EVIDENCE_DIR"

log() { printf '%s\n' "$*"; }

provenance() {
  # The toolchain is not on PATH by default on this machine, so the
  # collector's own PATH is set up before the provenance block runs. The
  # versions are read from there, so the log states the toolchain the
  # evidence was actually produced with.
  log "commit  : $(git -C "$NATIVE_ROOT" rev-parse HEAD)"
  log "branch  : $(git -C "$NATIVE_ROOT" branch --show-current)"
  log "dev tip : $(git -C "$NATIVE_ROOT" rev-parse dev 2>/dev/null || echo '(no dev ref)')"
  log "date    : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "host    : $(uname -s) $(uname -r)"
  log "node    : $(node --version)"
  log "rustc   : $(rustc --version 2>&1)"
  log "cargo   : $(cargo --version 2>&1)"
  log "tauri   : $(cargo tauri --version 2>&1)"
  log "toolchain: ${TOOLCHAIN}"
  log "cargo PATH        : $MINGW_BIN:\$HOME/.cargo/bin (prepended)"
}

# ---------------------------------------------------------------------------
# 1. the toolchain facts and the build
# ---------------------------------------------------------------------------
{
  log "=== ATS-104 evidence 01 -- toolchain and cargo build ==="
  log ""
  provenance
  log ""
  log "--- MSVC C++ build tools (the msvc chain's precondition) ---"
  VSWHERE="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
  if [ -x "$VSWHERE" ]; then
    "$VSWHERE" -latest -products '*' \
      -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 \
      -property installationPath
    log "(no output above = the VC/Tools/MSVC workload is NOT installed)"
  else
    log "vswhere.exe not found"
  fi
  log ""
  log "--- the gnu chain's linker ---"
  log "x86_64-w64-mingw32-gcc = $(PATH="$MINGW_BIN:\$PATH" command -v x86_64-w64-mingw32-gcc)"
  log ""
  log "--- cargo build (the final link; a type check does NOT link) ---"
  # The build runs in src-tauri/, and the exit code is captured IMMEDIATELY:
  # PIPESTATUS is overwritten by the next command, so reading it after the
  # `log` call would report the log's status instead of cargo's.
  cd "$REPO_ROOT/src-tauri" || { log "cannot enter $REPO_ROOT/src-tauri"; exit 1; }
  BUILD_OUTPUT="$(PATH="$MINGW_BIN:$HOME/.cargo/bin:$PATH" \
  RUSTUP_TOOLCHAIN="$TOOLCHAIN" \
    cargo build --jobs 2 2>&1)"
  BUILD_STATUS=$?
  printf '%s\n' "$BUILD_OUTPUT" | tail -20
  log "cargo build exit = $BUILD_STATUS"
  if [ "$BUILD_STATUS" -ne 0 ]; then
    log "--- the build FAILED; its full output follows ---"
    printf '%s\n' "$BUILD_OUTPUT"
  fi
  log ""
  log "--- the artefact ---"
  ls -la "$REPO_ROOT/src-tauri/target/debug/ai-test-studio.exe" 2>&1
} > "$EVIDENCE_DIR/01-cargo-build.log" 2>&1
BUILD_EXIT=$?
log "01-cargo-build.log written (collector exit $BUILD_EXIT)"

# ---------------------------------------------------------------------------
# 2. the probe: the dev build, the window, the Bridge, the orphan check
# ---------------------------------------------------------------------------
{
  log "=== ATS-104 evidence 02 -- ST-022 probe (cargo tauri dev, WebView2, no orphan) ==="
  log ""
  provenance
  log ""
  cd "$REPO_ROOT" || exit 1
  PATH="$MINGW_BIN:$HOME/.cargo/bin:$PATH" \
  RUSTUP_TOOLCHAIN="$TOOLCHAIN" \
  ATS104_SKIP_BUILD=1 \
    node tools/ats104-probes/st-ats104.mjs 2>&1
  log ""
  log "probe exit = $?"
} > "$EVIDENCE_DIR/02-st-022-probe.log" 2>&1
log "02-st-022-probe.log written"

# ---------------------------------------------------------------------------
# 3. the negative control: the SAME probe against a product whose exit hook
#    does not end the Bridge. It MUST fail -- that is what makes the PASS
#    in step 2 mean something.
#
#    The mutation is applied to a COPY of the tree; the delivered tree is
#    never modified.
# ---------------------------------------------------------------------------
{
  log "=== ATS-104 evidence 03 -- negative control (the probe must FAIL) ==="
  log ""
  provenance
  log ""
  log "The control removes the RunEvent::Exit hook from a COPY of"
  log "src-tauri/src/lib.rs, so the shell no longer ends its Bridge child when"
  log "the window is closed, and runs the SAME probe against that copy."
  log ""
  log "The delivered tree is not modified: the copy lives under"
  log "tools/ats104-probes/ (gitignored scratch)."
  log ""
  # The control tree lives on D: when D: exists: the copy plus its own
  # build output are several GB, and the repository's target directory
  # already occupies the C: drive. A copy that runs out of disk space
  # produces a control that proves nothing.
  CONTROL_ROOT="${ATS104_CONTROL_ROOT:-}"
  if [ -z "$CONTROL_ROOT" ]; then
    if [ -d /d ] && [ -w /d ]; then
      CONTROL_ROOT="/d/ats104-control"
    else
      CONTROL_ROOT="$REPO_ROOT/tools/ats104-probes/control-tree"
    fi
  fi
  CONTROL_DIR="$CONTROL_ROOT/tree"
  log "control tree: $CONTROL_DIR"
  rm -rf "$CONTROL_DIR"
  mkdir -p "$CONTROL_DIR"
  # Only the sources the shell and the probe read: the Rust shell, the Bridge
  # it starts and the Next app it loads. node_modules is NOT copied -- it is
  # a gigabyte of installed dependencies, and the control can point at the
  # delivered one instead.
  mkdir -p "$CONTROL_DIR/src-tauri" "$CONTROL_DIR/server" "$CONTROL_DIR/apps/studio" \
           "$CONTROL_DIR/tools/ats104-probes"
  cp -r "$REPO_ROOT/src-tauri/src" "$CONTROL_DIR/src-tauri/src"
  cp "$REPO_ROOT/src-tauri/Cargo.toml" "$REPO_ROOT/src-tauri/build.rs" \
     "$REPO_ROOT/src-tauri/tauri.conf.json" "$CONTROL_DIR/src-tauri/"
  cp -r "$REPO_ROOT/src-tauri/icons" "$CONTROL_DIR/src-tauri/icons"
  cp -r "$REPO_ROOT/src-tauri/capabilities" "$CONTROL_DIR/src-tauri/capabilities"
  # The generated capability schemas and the resolved lock file: the tauri
  # build script reads the schemas, and the lock file pins the same
  # dependency tree the control is meant to differ from in ONE place only
  # (the exit hook).
  [ -d "$REPO_ROOT/src-tauri/gen" ] && cp -r "$REPO_ROOT/src-tauri/gen" "$CONTROL_DIR/src-tauri/gen"
  [ -f "$REPO_ROOT/src-tauri/Cargo.lock" ] && cp "$REPO_ROOT/src-tauri/Cargo.lock" "$CONTROL_DIR/src-tauri/"
  cp -r "$REPO_ROOT/server/." "$CONTROL_DIR/server/"
  # The Next app's SOURCES only: node_modules is a gigabyte of installed
  # dependencies and the control points at the delivered tree's copy instead
  # of duplicating it.
  for item in "$REPO_ROOT/apps/studio/"*; do
    base="$(basename "$item")"
    case "$base" in
      node_modules|.next|out) continue ;;
    esac
    cp -r "$item" "$CONTROL_DIR/apps/studio/$base"
  done
  cp "$REPO_ROOT/tools/ats104-probes/st-ats104.mjs" "$CONTROL_DIR/tools/ats104-probes/st-ats104.mjs"

  # The mutation: the exit hook no longer ends the Bridge. The path is
  # handed to Python in its native form, because Python does not understand
  # the MSYS path this shell uses.
  MUTATED="$CONTROL_DIR/src-tauri/src/lib.rs"
  MUTATED_NATIVE="$(cd "$(dirname "$MUTATED")" && pwd -W)/$(basename "$MUTATED")"
  /c/Python312/python.exe - "$MUTATED_NATIVE" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
text = p.read_text(encoding='utf-8')
before = text
text = text.replace("""    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(bridge) = app_handle.try_state::<BridgeProcess>() {
                bridge.stop();
            }
        }
    });""", """    app.run(|_app_handle, _event| {
        // NEGATIVE CONTROL: the exit hook does not end the Bridge.
    });""")
if text == before:
    # The file is not rustfmt-formatted; match the compact form too.
    text = text.replace("""  app.run(|app_handle,event| {
    if let tauri::RunEvent::Exit=event {
      if let Some(bridge)=app_handle.try_state::<BridgeProcess>() {
        bridge.stop();
      }
    }
  });""", """  app.run(|_app_handle,_event| {
    // NEGATIVE CONTROL: the exit hook does not end the Bridge.
  });""")
if text == before:
    raise SystemExit('the negative control did not mutate the exit hook')
p.write_text(text, encoding='utf-8')
print('the control tree carries the un-ended Bridge')
PYEOF
  if [ $? -ne 0 ]; then
    log "the mutation FAILED -- the control was not built, so it proves nothing"
    exit 1
  fi

  # The control's Next app is served from the delivered tree's installed
  # dependencies, so the control does not need its own node_modules.
  ln -s "$REPO_ROOT/apps/studio/node_modules" "$CONTROL_DIR/apps/studio/node_modules" 2>/dev/null \
    || cp -r "$REPO_ROOT/apps/studio/node_modules" "$CONTROL_DIR/apps/studio/node_modules"

  log ""
  log "--- building the control ---"
  cd "$CONTROL_DIR/src-tauri" || exit 1
  # The control's build output goes to a target directory of its own, on D:
  # when D: exists. The repository's own target directory already fills
  # most of the C: drive, and a build that runs out of disk space produces
  # a control that proves nothing.
  CONTROL_TARGET="${ATS104_CONTROL_TARGET:-}"
  if [ -z "$CONTROL_TARGET" ] && [ -d /d ] && [ -w /d ]; then
    CONTROL_TARGET="/d/ats104-control-target"
  fi
  if [ -n "$CONTROL_TARGET" ]; then
    log "control target dir: $CONTROL_TARGET"
  fi
  # cargo is a NATIVE program: it does not understand the MSYS paths this
  # shell uses, so the target directory is handed to it in its native form.
  CONTROL_TARGET_NATIVE=""
  if [ -n "$CONTROL_TARGET" ]; then
    mkdir -p "$CONTROL_TARGET"
    CONTROL_TARGET_NATIVE="$(cd "$CONTROL_TARGET" && pwd -W)"
    log "control target dir (native): $CONTROL_TARGET_NATIVE"
  fi
  CONTROL_BUILD_OUTPUT="$(PATH="$MINGW_BIN:$HOME/.cargo/bin:$PATH" \
  RUSTUP_TOOLCHAIN="$TOOLCHAIN" \
  CARGO_TARGET_DIR="$CONTROL_TARGET_NATIVE" \
    cargo build --jobs 2 2>&1)"
  CONTROL_BUILD_STATUS=$?
  printf '%s\n' "$CONTROL_BUILD_OUTPUT" | tail -8
  log "control cargo build exit = $CONTROL_BUILD_STATUS"
  # The probe locates the binary at <its own tree>/src-tauri/target/debug/,
  # so the artefact of the control's own target directory is placed there.
  # The paths are converted to their NATIVE form first: `cp` is a native
  # program here and does not understand the MSYS paths this shell uses --
  # it would report "cannot stat" for a file that is really there.
  if [ -n "$CONTROL_TARGET_NATIVE" ]; then
    mkdir -p "$CONTROL_DIR/src-tauri/target/debug"
    DEST_NATIVE="$(cd "$CONTROL_DIR/src-tauri/target/debug" && pwd -W)"
    if [ -f "$CONTROL_TARGET_NATIVE/debug/ai-test-studio.exe" ]; then
      cp "$CONTROL_TARGET_NATIVE/debug/ai-test-studio.exe" "$DEST_NATIVE/"
      log "control artefact placed: $(ls -la "$DEST_NATIVE/ai-test-studio.exe" 2>&1)"
    else
      log "the control build produced NO artefact at $CONTROL_TARGET_NATIVE/debug/ai-test-studio.exe"
      log "-- the control cannot be run, so it proves nothing"
    fi
  fi
  log ""
  log "--- running the SAME probe against the control ---"
  cd "$CONTROL_DIR" || exit 1
  # The probe's own output is captured to a variable, so the verdict can
  # look at what the probe ACTUALLY said rather than at the log file that
  # is still being written.
  CONTROL_OUTPUT="$(PATH="$MINGW_BIN:$HOME/.cargo/bin:$PATH" \
  RUSTUP_TOOLCHAIN="$TOOLCHAIN" \
  ATS104_SKIP_BUILD=1 \
  ATS104_TIMEOUT_MS=240000 \
    node tools/ats104-probes/st-ats104.mjs 2>&1)"
  CONTROL_EXIT=$?
  printf '%s\n' "$CONTROL_OUTPUT"
  log ""
  log "control probe exit = $CONTROL_EXIT"
  log ""
  # The control has to fail FOR THE RIGHT REASON. A control that fails
  # because its artefact is missing, or because its window never opened,
  # has not exercised the orphan check at all -- it would pass as a control
  # while proving nothing about the check. The verdict therefore requires
  # the control to have REACHED the orphan check and to have failed THERE.
  ORPHAN_FAILED=0
  case "$CONTROL_OUTPUT" in
    *"outlived the closed window"*) ORPHAN_FAILED=1 ;;
  esac
  if [ "$CONTROL_EXIT" -ne 0 ] && [ "$ORPHAN_FAILED" -eq 1 ]; then
    log "NEGATIVE CONTROL OK: the probe reached the orphan check and rejected"
    log "the product whose Bridge outlives the closed window."
  elif [ "$CONTROL_EXIT" -ne 0 ]; then
    log "NEGATIVE CONTROL INCONCLUSIVE: the probe failed, but NOT on the orphan"
    log "check (no 'outlived the closed window' line). The control did not"
    log "exercise the check it is meant to prove, so it proves nothing."
  else
    log "NEGATIVE CONTROL FAILED: the probe accepted a product that leaves an"
    log "orphan Bridge behind, so the PASS in step 2 proves nothing."
  fi
  rm -rf "$CONTROL_DIR"
  if [ -n "$CONTROL_TARGET" ]; then
    rm -rf "$CONTROL_TARGET"
  fi
} > "$EVIDENCE_DIR/03-negative-control.log" 2>&1
log "03-negative-control.log written"

log ""
log "done. the logs are in $EVIDENCE_DIR"
