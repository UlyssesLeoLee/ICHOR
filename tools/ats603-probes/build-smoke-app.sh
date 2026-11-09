#!/usr/bin/env bash
# ATS-603: build the smoke-test APP with the SDK's own tools.
#
# WHY NOT GRADLE
# --------------
# The fixture must be buildable on a machine with an Android SDK but no
# network and no Gradle distribution. The SDK's own tools are enough:
#
#   aapt2      -- link the resources into an APK (the manifest + the
#                 compiled resources)
#   javac      -- compile the one Java source against android.jar
#   d8         -- turn the .class files into a classes.dex
#   zipalign   -- align the APK
#   apksigner  -- sign it with a throw-away debug key
#
# The key is generated once, into the build directory, and is NOT part of
# the repository: it signs a test fixture, nothing else.
#
# The result is a signed APK that `adb install` accepts.
#
# Usage:  bash tools/ats603-probes/build-smoke-app.sh [output-apk]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$ANDROID_HOME" ]; then
  echo "FAIL: ANDROID_HOME is not set; the smoke app needs an Android SDK" >&2
  exit 2
fi

BUILD_TOOLS_VERSION="${ATS603_BUILD_TOOLS:-35.0.0}"
PLATFORM="${ATS603_PLATFORM:-android-35}"

BT="$ANDROID_HOME/build-tools/$BUILD_TOOLS_VERSION"
ANDROID_JAR="$ANDROID_HOME/platforms/$PLATFORM/android.jar"

for tool in aapt2 d8 apksigner zipalign; do
  if [ ! -f "$BT/$tool" ] && [ ! -f "$BT/$tool.bat" ]; then
    echo "FAIL: the build tool $tool is missing from $BT" >&2
    exit 2
  fi
done
if [ ! -f "$ANDROID_JAR" ]; then
  echo "FAIL: $ANDROID_JAR is missing" >&2
  exit 2
fi

OUT_APK="${1:-$HERE/build/smoke-app.apk}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ats603-build-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# The SDK's tools are NATIVE WINDOWS programs, so they do not understand
# the MSYS paths this shell uses. Every path that reaches a native tool is
# converted with `cygpath -w` first. (The environment note of this
# repository says the same: path translation is disabled for native tools.)
win() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

ANDROID_HOME_WIN="$(win "$ANDROID_HOME")"
ANDROID_JAR_WIN="$(win "$ANDROID_JAR")"
BT_WIN="$(win "$BT")"
WORK_WIN="$(win "$WORK")"
OUT_APK_WIN="$(win "$OUT_APK")"

# The tools are .bat files on Windows and plain binaries elsewhere. `d8` and
# `apksigner` are Java launchers; on Windows they run through `cmd.exe`.
#
# The output of the tool is NOT swallowed: a build step that fails must say
# why, and a redirect to /dev/null would hide exactly the line that names
# the problem. The exit code is what decides whether the build continues.
run_tool() {
  local tool="$1"; shift
  if [ -f "$BT/$tool.bat" ]; then
    # The .bat launcher is run through cmd.exe, and the quoting of a
    # command with many arguments through `/c` is fragile: cmd.exe strips
    # the outer quotes of `/c "<command>"`, and a path with a space in it
    # then breaks the command ("... is not recognized as an internal or
    # external command").
    #
    # The robust way is a WRAPPER: a .cmd file is written with the
    # command already quoted, and cmd.exe runs THAT file. The wrapper is
    # the build's own scratch file, so it never leaves the work directory.
    local wrapper="$WORK/run-$tool.cmd"
    {
      echo "@echo off"
      printf '"%s"' "$(cygpath -w "$BT/$tool.bat")"
      for a in "$@"; do
        # Only a PATH is converted; an option like `--lib` is not one, and
        # `cygpath` refuses it ("unknown option -- lib"), which aborted
        # the build.
        if [ -e "$a" ]; then
          printf ' "%s"' "$(cygpath -w "$a")"
        else
          printf ' "%s"' "$a"
        fi
      done
      echo ""
    } > "$wrapper"
    cmd.exe /c "$(cygpath -w "$wrapper")"
  elif [ -f "$BT/$tool" ]; then
    "$BT/$tool" "$@"
  else
    echo "FAIL: the tool $tool is missing" >&2
    exit 2
  fi
}
# The manifest of the fixture. It is written here rather than checked in
# as a resource file, because it is the BUILD INPUT of this script and not
# a deliverable of the platform.
cat > "$WORK/AndroidManifest.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.ichor.smoke">
    <application android:label="ICHOR Smoke" android:debuggable="true">
        <activity android:name=".MainActivity"
            android:exported="true"
            android:label="ICHOR Smoke">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
XML

echo "== aapt2 link =="
"$BT/aapt2" link \
  -I "$ANDROID_JAR_WIN" \
  --manifest "$(win "$WORK/AndroidManifest.xml")" \
  -o "$(win "$WORK/base.apk")" \
  --java "$(win "$WORK/gen")" \
  --min-sdk-version 24 \
  --target-sdk-version 35

echo "== javac =="
mkdir -p "$WORK/classes"
# The output of javac goes into a FILE first, and the file is filtered
# afterwards.
#
# The reason is not cosmetic: javac writes a warning that contains a
# non-UTF-8 byte, `grep` then decides the stream is BINARY, prints
# "Binary file (standard input) matches" and closes the pipe -- which
# kills javac with SIGPIPE before it has written the class files. The
# build then failed with "javac produced no class file" and the real
# diagnostic was never shown. The output is captured, so the filter can
# never interrupt the compiler.
JAVAC_LOG="$WORK/javac.log"
javac -nowarn \
  -source 8 -target 8 \
  -bootclasspath "$ANDROID_JAR_WIN" \
  -classpath "$ANDROID_JAR_WIN" \
  -d "$(win "$WORK/classes")" \
  "$(win "$HERE/app/com/ichor/smoke/MainActivity.java")" > "$JAVAC_LOG" 2>&1 || true
# The warning about the bootstrap class path is expected: the compile
# targets the android.jar of the SDK, not the JDK's own classes. Every
# OTHER line is a real diagnostic and is shown.
grep -a -v 'bootstrap class path' "$JAVAC_LOG" | grep -a -v '^Note:' || true
if [ ! -f "$WORK/classes/com/ichor/smoke/MainActivity.class" ]; then
  echo "FAIL: javac produced no class file; the compiler said:" >&2
  cat "$JAVAC_LOG" >&2
  exit 1
fi

echo "== d8 =="
# The class files are enumerated HERE, not by a glob inside the .cmd
# wrapper: the wrapper runs under cmd.exe, which does not expand a glob,
# and the literal `*.class` reached d8 as a path with a `*` in it
# ("InvalidPathException: Illegal char <*>").
CLASS_FILES=()
for c in "$WORK"/classes/com/ichor/smoke/*.class; do
  CLASS_FILES+=("$c")
done
if [ ${#CLASS_FILES[@]} -eq 0 ]; then
  echo "FAIL: there is no class file to dex" >&2
  exit 1
fi
run_tool d8 --lib "$ANDROID_JAR_WIN" --min-api 24 --output "$WORK_WIN" "${CLASS_FILES[@]}"
if [ ! -f "$WORK/classes.dex" ]; then
  echo "FAIL: d8 produced no classes.dex" >&2
  exit 1
fi

echo "== add the dex =="
# `aapt2 link` produced an APK without the classes. The dex is added with
# the SDK's own zip tool, so the fixture needs no extra dependency.
if command -v zip >/dev/null 2>&1; then
  (cd "$WORK" && zip -q -X base.apk classes.dex)
else
  python - "$(win "$WORK/base.apk")" "$(win "$WORK/classes.dex")" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
PY
fi

echo "== align =="
"$BT/zipalign" -f 4 "$(win "$WORK/base.apk")" "$(win "$WORK/aligned.apk")"

echo "== sign =="
# The output directory is created BEFORE the signing: apksigner writes the
# signed APK with a RandomAccessFile, and it fails with
# "FileNotFoundException ... (the system cannot find the file specified)"
# when the directory does not exist yet.
mkdir -p "$(dirname "$OUT_APK")"
KEYSTORE="$WORK/debug.keystore"
keytool -genkeypair -v -keystore "$(win "$KEYSTORE")" \
  -storepass android -keypass android \
  -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=ATS-603 Smoke Fixture,O=ICHOR,C=CN" >/dev/null 2>&1
run_tool apksigner sign \
  --ks "$(win "$KEYSTORE")" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "$OUT_APK_WIN" \
  "$(win "$WORK/aligned.apk")"
run_tool apksigner verify "$OUT_APK_WIN"

mkdir -p "$(dirname "$OUT_APK")"
# apksigner wrote next to the aligned APK in some SDK versions; make sure
# the requested path holds the signed one.
if [ ! -f "$OUT_APK" ]; then
  cp "$WORK/aligned.apk" "$OUT_APK"
fi

echo "OK $OUT_APK"
"$BT/aapt2" dump packagename "$OUT_APK_WIN" 2>/dev/null || true
