#!/usr/bin/env bash
# ATS-101 -- a STUB cargo, for exercising the verdict logic of
# collect-b02-build-link.sh without a real build.
#
# Why this exists: the probe's verdict has to tell the failure shapes apart
# (README discipline #5):
#
#   1. export ordinal too large   -> cause 4
#   2. some other link error       -> a different cause
#   3. failure before the link step-> cause 4 not evaluated
#   4. a failing cargo check       -> the check step reports it; the build
#                                       step still decides the cause-4 verdict
#
# Shape 1 needs a real build (minutes, and a broken toolchain). Shapes 2 and
# 3 are cheap to fake. This stub makes all of them reproducible on demand.
#
# Usage:
#   ATS_PROBE_STUB_MODE=ordinal|other-link|compile-error|check-fails|check-fails-ordinal \
#   ATS_PROBE_CARGO=tools/ats101-probes/stub-cargo.sh \
#   bash tools/ats101-probes/collect-b02-build-link.sh
#
# The stub emulates cargo's exit codes: 101 for a failed build, 0 for a green
# one. `check` exits 0 unless ATS_PROBE_STUB_MODE starts with `check-fails`.
set -u

MODE="${ATS_PROBE_STUB_MODE:-other-link}"

# cargo's own arguments: the first one may be a toolchain (+name), the last
# one is the subcommand.
SUB=""
for a in "$@"; do
  case "$a" in
    check|build) SUB="$a" ;;
  esac
done

# The toolchain queries (`cargo --version`, `cargo +toolchain --version`) carry
# no subcommand, so they are recognised from the argument list itself.
IS_VERSION=0
for a in "$@"; do
  case "$a" in
    --version|-V) IS_VERSION=1 ;;
  esac
done

if [ "$IS_VERSION" = "1" ] && [ -z "$SUB" ]; then
  echo "cargo 1.99.1 (ATS-101 stub)"
  exit 0
fi

case "$SUB" in
  check)
    case "$MODE" in
      check-fails|check-fails-ordinal)
        echo "error[E0425]: cannot find value \`x\` in this scope" >&2
        echo "error: could not compile \`ai-test-studio\` (lib) due to 1 previous error" >&2
        exit 101
        ;;
    esac
    echo "    Checking ai-test-studio v0.1.0"
    echo "    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 0.42s"
    exit 0
    ;;
  build)
    ;;
  *)
    echo "stub cargo: unsupported subcommand '$SUB'" >&2
    exit 2
    ;;
esac

# --- cargo build: emulate the failure shapes -------------------------------
case "$MODE" in
  ordinal|check-fails-ordinal)
    # rustc invoked the linker, and ld.exe rejected the export ordinal.
    echo "   Compiling ai-test-studio v0.1.0" >&2
    echo "error: linking with \`x86_64-w64-mingw32-gcc\` failed: exit code: 1" >&2
    echo "  = note: \"x86_64-w64-mingw32-gcc\" \"-Wl,--output-def,list.def\" ... \"-o\" \"...\\\\ai_test_studio_lib.dll\" \"-Wl,--gc-sections\" \"-shared\"" >&2
    echo "  = note: C:/msys64/mingw64/bin/../lib/gcc/x86_64-w64-mingw32/16.1.0/../../../../x86_64-w64-mingw32/bin/ld.exe: error: export ordinal too large: 90774" >&2
    echo "          collect2.exe: error: ld returned 1 exit status" >&2
    echo "error: could not compile \`ai-test-studio\` (lib) due to 1 previous error" >&2
    exit 101
    ;;
  other-link)
    # rustc invoked the linker, and it failed for an unrelated reason.
    echo "   Compiling ai-test-studio v0.1.0" >&2
    echo "error: linking with \`x86_64-w64-mingw32-gcc\` failed: exit code: 1" >&2
    echo "  = note: C:/msys64/mingw64/bin/../lib/gcc/x86_64-w64-mingw32/16.1.0/../../../../x86_64-w64-mingw32/bin/ld.exe: error: undefined reference to \`__rust_no_profile_ubsan_ctors\`" >&2
    echo "          collect2.exe: error: ld returned 1 exit status" >&2
    echo "error: could not compile \`ai-test-studio\` (lib) due to 1 previous error" >&2
    exit 101
    ;;
  compile-error)
    # The build died before the linker was ever invoked. No "linking with"
    # header appears -- this is the shape that must NOT be reported as a
    # link failure.
    echo "   Compiling ai-test-studio v0.1.0" >&2
    echo "error[E0425]: cannot find value \`x\` in this scope" >&2
    echo "error: could not compile \`ai-test-studio\` (lib) due to 1 previous error" >&2
    exit 101
    ;;
  check-fails)
    # The check step fails; the build step links cleanly.
    echo "   Compiling ai-test-studio v0.1.0" >&2
    echo "    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 0.42s" >&2
    exit 0
    ;;
  rustc-crash)
    # rustc itself crashed (0xc0000409 -> 101), again before the linker.
    echo "   Compiling ai-test-studio v0.1.0" >&2
    echo "error: the compiler unexpectedly panicked. this is a bug" >&2
    exit 101
    ;;
  ok)
    echo "   Compiling ai-test-studio v0.1.0" >&2
    echo "    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 0.42s" >&2
    exit 0
    ;;
  *)
    echo "stub cargo: unknown ATS_PROBE_STUB_MODE '$MODE'" >&2
    exit 2
    ;;
esac
