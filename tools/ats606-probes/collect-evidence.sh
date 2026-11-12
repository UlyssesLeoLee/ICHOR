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
  echo "INVENTORY, the IMPORT BEHAVIOUR and the DRIVER IMPLEMENTATION"
  echo "STATUS, all read off the shipped artifacts -- not about a Flow"
  echo "actually running on iOS."
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
for (const m of sem[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\s*:\s*Object\.freeze\(\[([\s\S]*?)\]\)/gm)) {
  console.log("  " + m[1].padEnd(16) + m[2].replace(/\s+/g, " "));
}
console.log();
console.log("--- ATS-602: the argument model (STEP_ARGUMENTS) ---");
const args = /STEP_ARGUMENTS\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(imp);
for (const m of args[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\s*:\s*Object\.freeze\(\{([\s\S]*?)\n  \}\),/gm)) {
  const body = m[2];
  const primary = /primary: .([A-Za-z]+)./.exec(body);
  const optional = /optional: Object\.freeze\(\[([^\]]*)\]\)/.exec(body);
  const required = /required: Object\.freeze\(\[([^\]]*)\]\)/.exec(body);
  const requiredAny = /requiredAny: Object\.freeze\(\[Object\.freeze\(\[([^\]]*)\]\)\]\)/.exec(body);
  console.log("  " + m[1]);
  console.log("      primary     : " + (primary ? primary[1] : "-"));
  console.log("      required    : " + (required ? required[1] : "-"));
  console.log("      requiredAny : " + (requiredAny ? requiredAny[1] : "-"));
  console.log("      optional    : " + (optional ? optional[1] : "-"));
}
' 2>&1
} > "$EV/04-platform-vocabulary.log" 2>&1

# --- 05: the import report over ALL 55 Maestro commands -------------------
# The §8.5 claim is twofold, and both halves are checked here:
#
#   * "a Flow written in Maestro syntax comes in with its unmappable steps
#     REPORTED rather than silently dropped" -- one real Flow, end to end;
#   * "the importer maps 4 of the 55 Maestro spellings and reports the
#     other 51" -- EVERY command, run through the importer, with its
#     original text and its line number.
#
# The second half is the one the round-1 review was about: the delivered
# table claimed 7 mappable commands while the importer maps 4. So the
# evidence must cover ALL of them, not a hand-picked sample.
{
  echo "=== ATS-606 evidence: the import report over every Maestro command ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node -e '
(async () => {
  const fs = await import("node:fs");
  const { parseFlow } = await import("./server/discovery/mobile-flow.mjs");
  const { importFlow, buildImportReport, formatImportReport } =
    await import("./server/discovery/mobile-import.mjs");

  const fixtures = JSON.parse(fs.readFileSync("tools/ats606-probes/maestro-command-fixtures.json", "utf8"));

  /* --- (a) one real Flow, end to end ---------------------------------- */
  console.log("--- (a) a Flow written in Maestro syntax, imported end to end ---");
  console.log();
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
  const report = buildImportReport(imported);

  const declared = report.mappedSteps + report.unsupportedSteps;
  console.log("cases               : " + report.cases);
  console.log("mapped steps        : " + report.mappedSteps);
  console.log("reported steps      : " + report.unsupportedSteps);
  console.log("mapped + reported   : " + declared);
  console.log("the Flow declares  : 9 steps (4 mapped + 5 reported)");
  console.log("every step accounted for : " + (declared === 9));
  console.log("unsupported by reason : " + JSON.stringify(report.unsupportedByReason));
  console.log("warnings             : " + report.warnings);
  console.log("errors               : " + report.errors);
  console.log();
  console.log("--- the import report ---");
  console.log(formatImportReport(report));

  /* --- (b) EVERY Maestro command, one at a time ------------------------ */
  console.log();
  console.log("--- (b) every one of the 55 Maestro commands, through the importer ---");
  console.log();

  let mapped = 0;
  let reported = 0;
  const byReason = {};
  const rows = [];

  for (const [name, body] of Object.entries(fixtures.commands)) {
    const one = `${"appId: " + fixtures.appId}\n---\n${body}\n`;
    const f = parseFlow(one, { syntax: "maestro" });
    const imp = importFlow(f, { file: `flows/${name}.yaml`, projectUid: "p1" });
    const rep = buildImportReport(imp);
    const kinds = [...new Set((imp.cases ?? []).flatMap((c) => c.steps.map((s) => s.kind)))];
    if (rep.mappedSteps > 0) {
      mapped += 1;
      rows.push(`  ${name.padEnd(24)} MAPPED    -> ${kinds.join(", ")}`);
    } else {
      reported += 1;
      for (const r of Object.keys(rep.unsupportedByReason)) byReason[r] = (byReason[r] ?? 0) + 1;
      const detail = (rep.unsupportedSteps_detail ?? [])
        .map((u) => `line ${u.line}: ${u.reason} -- ${u.raw}`)
        .join(" | ");
      rows.push(`  ${name.padEnd(24)} REPORTED  -> ${detail}`);
    }
  }

  console.log(rows.join("\n"));
  console.log();
  console.log("mapped   : " + mapped);
  console.log("reported : " + reported);
  console.log("total    : " + (mapped + reported));
  console.log("by reason: " + JSON.stringify(byReason));
  console.log();
  console.log("The counts §8.5 states are: 可映射 4 / 部分可映射 3 / 不映射 48,");
  console.log("and 映射成功 4 条 / 进导入报告 51 条.");
  console.log("measured mapped   : " + mapped + " (must be 4)");
  console.log("measured reported : " + reported + " (must be 51)");
})();
' 2>&1
} > "$EV/05-import-report-of-every-maestro-command.log" 2>&1
rm -f "$EV/05-import-report-of-an-unmappable-flow.log"

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
