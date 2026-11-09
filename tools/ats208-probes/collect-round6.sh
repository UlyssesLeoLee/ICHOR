#!/usr/bin/env bash
# ATS-208 -- the evidence of the SIXTH review round.
#
# The fifth review rejected the delivery with ONE mandatory item (R3): the
# WBS row 29 note must state the final state only -- no review-round
# narrative, and no counts that go stale as soon as another file is added.
#
# The sixth review checks exactly three things:
#
#   1. on a clean clone of the delivered tip, the WBS row 29 T cell has no
#      match for `第 ?[0-9一二三四五] ?轮|复核只剩|驳回` and carries no count
#      that disagrees with the delivered tree;
#   2. `python tools/verify_checksums.py` prints RESULT: OK;
#   3. `git log 4ff5c36..HEAD -- server/execution/model.mjs
#      server/adapters/wdio.mjs` is empty -- or the `wdio-skip` probe is
#      re-run.
#
# This script collects the evidence for all three, plus the probes of the
# review and the regression, over the tree that is actually delivered.
#
# The probes of the review are INPUT: they arrive as issue attachments
# (ats208-r1-probes.zip, ats208-r2-probes.zip, ats208-r3-probes.zip) and are
# NOT deliverables, so they are not checked in. Unpack them into a directory
# laid out like this:
#
#   <probe-dir>/r1/probes/*.mjs        <probe-dir>/r1/fixtures/*
#   <probe-dir>/r2/probes-r2/*.mjs
#   <probe-dir>/r3/probes-r3/*.mjs
#
# The fixture dependency trees (examples/sample-playwright/node_modules and
# examples/sample-wdio/node_modules) are NOT part of the repository; install
# them in the measured tree, or the IT cases that need a real engine will
# skip instead of run.
#
# usage: bash tools/ats208-probes/collect-round6.sh <tree> <probe-dir>
set -uo pipefail

TREE="$1"
PROBES="$2"
PROBES_NATIVE="$(cd "$PROBES" && pwd -W 2>/dev/null || echo "$PROBES")"
cd "$TREE" || exit 1

export TMPDIR="${TMPDIR:-/tmp}"
mkdir -p "$TMPDIR"

hdr() {
  echo
  echo "=============================================================="
  echo "$*"
  echo "=============================================================="
}

hdr "the tree under test"
echo "tree    : $(pwd -W 2>/dev/null || pwd)"
echo "commit  : $(git rev-parse HEAD)"
echo "branch  : $(git branch --show-current)"
echo "node    : $(node --version)"
echo "python  : $(python --version 2>&1)"

# --- R3 item 1: the WBS row 29 note carries the final state only ---------
hdr "R3.1 -- the WBS row 29 note: final state only, no review narrative"
python - "$TREE" <<'PY'
import re
import subprocess
import sys
import zipfile

tree = sys.argv[1]
sys.path.insert(0, tree + '/tools')
from wbs_common import SHEET2, cell_text  # noqa: E402

z = zipfile.ZipFile(tree + '/docs/WBS.xlsx')
xml = z.read(SHEET2).decode('utf-8')

row = None
for m in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
    if '<x:v>ATS-208</x:v>' in m.group(2):
        row = int(m.group(1))
        break
assert row is not None, 'the ATS-208 row was not found'

note = cell_text(xml, row, 'T')
pattern = r'第 ?[0-9一二三四五] ?轮|复核只剩|驳回'
hits = re.findall(pattern, note)
print(f'ATS-208 row            : {row}')
print(f'note length            : {len(note)}')
print(f'markers in the note    : {note.count("【ATS-208】")}')
print(f'narrative matches      : {hits}')
print(f'状态 / 完成率 / 剩余   : {cell_text(xml, row, "N")} / '
      f'{cell_text(xml, row, "O")} / {cell_text(xml, row, "P")}')
print(f'ASCII ";" in the note  : {note.count(";")} (must be 0)')
print(f'"；;" in the note      : {note.count("；；")} (must be 0)')

# the counts that go stale as soon as another file is added must not be there
stale = re.findall(r'\d+ 条清单|\d+ 个 ATS-208 证据文件', note)
print(f'stale counts in the note: {stale} (must be empty)')

assert not hits, f'THE NOTE STILL CARRIES THE REVIEW NARRATIVE: {hits}'
assert not stale, f'THE NOTE STILL CARRIES STALE COUNTS: {stale}'
assert note.count('；；') == 0
assert note.count(';') == 0
assert note.count('【ATS-208】') == 1
print('RESULT: OK -- the note states the final state only')
PY

# --- R3 item 2: the manifest on the delivered tree ------------------------
hdr "R3.2 -- python tools/verify_checksums.py on the delivered tree"
python tools/verify_checksums.py 2>&1
echo "exit code : $?"

hdr "R3.2b -- the ATS-208 evidence files in the manifest"
echo "tracked ATS-208 evidence files : $(git ls-files 'docs/evidence/ATS-208/' | wc -l)"
echo "listed in CHECKSUMS.sha256      : $(grep -c 'docs/evidence/ATS-208/' CHECKSUMS.sha256)"
git ls-files 'docs/evidence/ATS-208/' | while read -r f; do
  if grep -q -- "  $f" CHECKSUMS.sha256; then
    echo "  listed    : $f"
  else
    echo "  NOT LISTED: $f"
  fi
done

# --- R3 item 3: the two server files since the fourth review baseline -----
hdr "R3.3 -- the server files since the fourth review baseline 4ff5c36"
git log --oneline 4ff5c36..HEAD -- server/execution/model.mjs server/adapters/wdio.mjs
echo "(no line above means: unchanged since 4ff5c36)"
echo
echo "--- what changed, and who changed it ---"
git log --oneline 4ff5c36..HEAD -- server/execution/model.mjs server/adapters/wdio.mjs \
  | while read -r sha rest; do
    echo "  $sha $rest"
    git show --stat --format='' "$sha" -- server/execution/model.mjs server/adapters/wdio.mjs \
      | sed 's/^/      /'
  done
echo
echo "--- the ATS-208 verdict/aggregation functions, byte for byte ---"
python - <<'PY'
import re
import subprocess

FUNCTIONS = ['aggregateAttempts', 'aggregateOutcomes', 'aggregateVerdicts',
             'mapEngineStatus']

def grab(rev):
    src = subprocess.run(['git', 'show', f'{rev}:server/execution/model.mjs'],
                         capture_output=True, text=True, encoding='utf-8').stdout
    out = {}
    for fn in FUNCTIONS:
        m = re.search(r'export function %s\(.*?\n}\n' % fn, src, re.S)
        out[fn] = m.group(0) if m else 'NOT FOUND'
    m = re.search(r'export const RUN_TRANSITIONS = .*?\n};\n', src, re.S)
    out['RUN_TRANSITIONS'] = m.group(0) if m else 'NOT FOUND'
    return out

base = grab('4ff5c36')
tip = grab('HEAD')
for key in FUNCTIONS + ['RUN_TRANSITIONS']:
    same = base[key] == tip[key]
    print(f'  {key:22s} identical to 4ff5c36: {same}')
    assert same, f'{key} changed since 4ff5c36'
print('RESULT: OK -- the ATS-208 verdict functions are byte-identical to 4ff5c36')
PY

# --- the probes of the review --------------------------------------------
hdr "the probes of the review on the delivered tree"
SCRATCH="$TMPDIR/ats208-r6-probes"
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
[ -f "$PROBES/r1/fixtures/pw-report.json" ] && cp "$PROBES/r1/fixtures/pw-report.json" "$SCRATCH/pw-report.json"
if [ -d "$PROBES/r1/fixtures/pwproj2" ]; then
  cp -r "$PROBES/r1/fixtures/pwproj2" "$SCRATCH/pwproj2"
  mkdir -p "$SCRATCH/pwproj2/node_modules"
  # The fixture project needs @playwright/test -- that is the package the
  # repo's own example project installs. Copying @playwright alone (without
  # the `test` scope) leaves the fixture unable to run, and the probe then
  # reports a run failure that has nothing to do with the model.
  for m in @playwright playwright playwright-core; do
    [ -d "examples/sample-playwright/node_modules/$m" ] && cp -r "examples/sample-playwright/node_modules/$m" "$SCRATCH/pwproj2/node_modules/"
  done
fi

run_probe() { # run_probe <label> <script> <args...>
  local label="$1"; shift
  echo
  echo "--- $label ---"
  node "$@" 2>&1
  echo "exit code : $?"
}

TREE_NATIVE="$(pwd -W)"
run_probe "pw-semantics: does the model agree with the Playwright verdict?" \
  "$PROBES_NATIVE/r1/probes/pw-semantics.mjs" "$TREE_NATIVE" "$SCRATCH/pw-report.json"
run_probe "startup-robustness: does the Bridge start when the log is damaged?" \
  "$PROBES_NATIVE/r1/probes/startup-robustness.mjs" "$TREE_NATIVE" "$SCRATCH/sr"
run_probe "wdio-check: does the WDIO side merge a re-executed case?" \
  "$PROBES_NATIVE/r1/probes/wdio-check.mjs" "$TREE_NATIVE"
run_probe "bridge-e2e: the Bridge end to end with a real Playwright" \
  "$PROBES_NATIVE/r1/probes/bridge-e2e.mjs" "$TREE_NATIVE" "$SCRATCH/pwproj2" "$SCRATCH/e2e"
run_probe "wdio-dup: does the WDIO merge hide a failure?" \
  "$PROBES_NATIVE/r2/probes-r2/wdio-dup.mjs" "$TREE_NATIVE"
run_probe "verdict-unknown: does an unknown verdict become passed?" \
  "$PROBES_NATIVE/r2/probes-r2/verdict-unknown.mjs" "$TREE_NATIVE"
run_probe "replay-contract: does the replay report lost or reused numbers?" \
  "$PROBES_NATIVE/r2/probes-r2/replay-contract.mjs" "$TREE_NATIVE"
run_probe "wdio-skip: must a skipped attempt turn a failure into a pass?" \
  "$PROBES_NATIVE/r3/probes-r3/wdio-skip.mjs" "$TREE_NATIVE"

# --- the ATS-208 suites ---------------------------------------------------
hdr "the ATS-208 unit and integration suites"
node --test tests/execution-model.test.mjs tests/execution-model-it.test.mjs 2>&1 | tail -12

# --- the full regression --------------------------------------------------
hdr "the full node test suite"
npm test 2>&1 | tail -10

# --- the gates ------------------------------------------------------------
hdr "the ATS-301 gate"
bash tools/ats301-probes/check-ats301-gate.sh 2>&1 | tail -8

hdr "the python gates under tools/"
python -m pytest tools/ -q 2>&1 | tail -4

hdr "done"
