#!/usr/bin/env bash
# ATS-606 -- collect the evidence on the DELIVERED tree.
#
# Every log names the commit it describes in its header, so a reader can
# tell which tree a number belongs to. The tree is the one this script is
# run on: after the merge back to dev, the evidence is collected on the
# MERGED tree, not on the branch tip.
#
# usage: bash tools/ats606-probes/collect-evidence.sh <tree>
set -uo pipefail

TREE="${1:-.}"
cd "$TREE" || exit 1

export TMPDIR="${TMPDIR:-/tmp}"
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
mkdir -p "$TMPDIR"

EV="docs/evidence/ATS-606"
mkdir -p "$EV"

COMMIT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

hdr() {
  echo
  echo "=============================================================="
  echo "$*"
  echo "=============================================================="
}

# --- 01: the environment -------------------------------------------------
# The iOS boundary is an environment-DEPENDENT claim: it says what the
# platform can and cannot do on an iOS simulator / device. The environment
# this evidence was collected in decides whether that claim could be
# checked at all, so it is recorded first.
{
  echo "=== ATS-606 evidence: the environment ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  echo "--- the host ---"
  uname -a
  echo
  echo "node : $(node -v 2>&1)"
  echo "java : $(java -version 2>&1 | head -1)"
  echo
  echo "--- the iOS tool chain (expected to be ABSENT on this host) ---"
  for tool in xcrun xcodebuild simctl; do
    if command -v "$tool" >/dev/null 2>&1; then
      echo "$tool : $(command -v "$tool")"
    else
      echo "$tool : NOT FOUND"
    fi
  done
  echo
  echo "--- the Maestro CLI under test ---"
  if [ -x "D:/AI-Tools/Maestro/bin/maestro.bat" ]; then
    echo "maestro : D:/AI-Tools/Maestro/bin/maestro.bat"
    "D:/AI-Tools/Maestro/bin/maestro.bat" --version 2>&1 | head -3
  elif [ -x "D:/AI-Tools/Maestro/bin/maestro" ]; then
    echo "maestro : D:/AI-Tools/Maestro/bin/maestro"
    "D:/AI-Tools/Maestro/bin/maestro" --version 2>&1 | head -3
  else
    echo "maestro : NOT FOUND -- the command inventory was NOT verified on this host"
  fi
  echo
  echo "--- the conclusion this environment forces ---"
  echo "No macOS / Xcode / iOS simulator / iOS device is present, so NO iOS"
  echo "behaviour was measured. The evidence below is about the COMMAND"
  echo "INVENTORY and the DRIVER IMPLEMENTATION STATUS, both read off the"
  echo "shipped artifacts -- not about a Flow actually running on iOS."
} > "$EV/01-environment.log" 2>&1

# --- 02: the command inventory (behavioural) -----------------------------
{
  echo "=== ATS-606 evidence: the Maestro command inventory ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node tools/ats606-probes/probe-maestro-compat.mjs 2>&1
  echo
  echo "exit : $?"
} > "$EV/02-maestro-command-inventory.log" 2>&1

# --- 03: the iOS driver support (byte-code) ------------------------------
{
  echo "=== ATS-606 evidence: the iOS implementation status ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node tools/ats606-probes/probe-ios-driver-support.mjs 2>&1
  echo
  echo "exit : $?"
} > "$EV/03-ios-driver-support.log" 2>&1

# --- 04: the ATS-601 / ATS-602 vocabulary ---------------------------------
# The compatibility table's verdicts are stated against the platform's own
# vocabulary. This log records that vocabulary as it stands on THIS tree,
# read out of the source, so the table cannot drift away from it unnoticed.
{
  echo "=== ATS-606 evidence: the platform vocabulary (ATS-601 / ATS-602) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node -e '
const fs = require("fs");
const target = fs.readFileSync("server/adapters/mobile-target.mjs", "utf8");
const kinds = /MOBILE_STEP_REQUIREMENTS\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(target);
console.log("--- ATS-601: the step kinds and the capabilities each one needs ---");
for (const m of kinds[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\s*:\s*Object\.freeze\(\{([\s\S]*?)\}\)/gm)) {
  const req = m[2].replace(/\s+/g, " ").trim();
  console.log("  " + m[1].padEnd(16) + req);
}
const caps = /MOBILE_CAPABILITY\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(target);
console.log();
console.log("--- ATS-601: the capability vocabulary ---");
for (const m of caps[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\s*:\s*.([^,]+),/gm)) {
  console.log("  " + m[1].padEnd(16) + m[2].trim());
}
const imp = fs.readFileSync("server/discovery/mobile-import.mjs", "utf8");
const sem = /STEP_SEMANTICS\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(imp);
console.log();
console.log("--- ATS-602: the semantic table (kind -> the spellings it accepts) ---");
for (const m of sem[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\s*:\s*Object\.freeze\(\[(.*?)\]\)/gm)) {
  console.log("  " + m[1].padEnd(16) + m[2]);
}
' 2>&1
} > "$EV/04-platform-vocabulary.log" 2>&1

# --- 05: the import report (what ATS-602 does with an unmappable Flow) ---
# The §8.5 claim is that a Flow written in Maestro syntax comes in with its
# unmappable steps REPORTED rather than silently dropped. This log shows
# that on a real Flow.
{
  echo "=== ATS-606 evidence: an unmappable Flow is reported, not dropped ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node -e '
const fs = require("fs");
const os = require("os");
const path = require("path");
(async () => {
  const { parseFlow } = await import("./server/discovery/mobile-flow.mjs");
  const { importFlow, formatImportReport } = await import("./server/discovery/mobile-import.mjs");

  // A Flow that uses Maestro syntax across the three verdict groups.
  const text = [
    "appId: com.example.app",
    "---",
    "- name: Login with email",
    "  steps:",
    "    - launchApp",
    "    - tapOn: \"Login\"",
    "    - inputText: \"a@b.com\"",
    "    - assertVisible: \"Welcome\"",
    "    - scroll",
    "    - swipe:",
    "        direction: DOWN",
    "    - evalScript: ${output.x = 1}",
    "    - takeScreenshot: \"home\"",
    "    - hideKeyboard",
    "",
  ].join("\n");

  const flow = parseFlow(text, { syntax: "maestro" });
  const imported = importFlow(flow, { file: "flows/login.yaml", projectUid: "p1" });

  const declared = imported.cases.reduce((n, c) => n + (c.steps ? c.steps.length : 0), 0);
  const mapped = imported.cases.reduce(
    (n, c) => n + (c.steps ? c.steps.filter((s) => s.kind).length : 0), 0);
  const reported = imported.unsupported.length;

  console.log("declared steps : " + declared);
  console.log("mapped steps   : " + mapped);
  console.log("reported steps : " + reported);
  console.log("mapped + reported == declared : " + (mapped + reported === declared));
  console.log();
  console.log("--- the import report ---");
  console.log(formatImportReport(imported));
})();
' 2>&1
} > "$EV/05-import-report-of-an-unmappable-flow.log" 2>&1

# --- 06: the WBS row ------------------------------------------------------
{
  echo "=== ATS-606 evidence: the WBS row ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  python tools/update_wbs_ats606.py --verify-only 2>&1
  echo
  echo "exit : $?"
} > "$EV/06-wbs-row.log" 2>&1

# --- 07: the checksums ----------------------------------------------------
{
  echo "=== ATS-606 evidence: the checksum manifest ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  python tools/verify_checksums.py 2>&1 | tail -20
  echo
  echo "exit : $?"
} > "$EV/07-checksums.log" 2>&1

hdr "the ATS-606 evidence is in $EV"
ls -la "$EV"
