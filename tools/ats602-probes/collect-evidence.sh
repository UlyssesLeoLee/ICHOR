#!/usr/bin/env bash
# ATS-602 -- collect the evidence on the DELIVERED tree.
#
# Every log names the commit it describes in its header, so a reader can
# tell which tree a number belongs to. The tree is the one this script is
# run on: after the merge back to dev, the evidence is collected on the
# MERGED tree, not on the branch tip.
#
# usage: bash tools/ats602-probes/collect-evidence.sh <tree>
set -uo pipefail

TREE="${1:-.}"
cd "$TREE" || exit 1

export TMPDIR="${TMPDIR:-/tmp}"
mkdir -p "$TMPDIR"

EV="docs/evidence/ATS-602"
mkdir -p "$EV"

COMMIT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

hdr() {
  echo
  echo "=============================================================="
  echo "$*"
  echo "=============================================================="
}

# --- 01: the unit tests ---------------------------------------------------
{
  echo "=== ATS-602 evidence: the mobile Flow import (unit tests) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node --test tests/mobile-import.test.mjs 2>&1
} > "$EV/01-node-test-mobile-import-ut.log" 2>&1

# --- 02: the integration tests -------------------------------------------
{
  echo "=== ATS-602 evidence: the mobile Flow import (integration tests) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node --test tests/mobile-import-it.test.mjs 2>&1
} > "$EV/02-node-test-mobile-import-it.log" 2>&1

# --- 03: the contract probe ----------------------------------------------
{
  echo "=== ATS-602 evidence: the contract probe (the mapping rule side by side) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node tools/ats602-probes/probe-mobile-import.mjs 2>&1
} > "$EV/03-probe-mobile-import.log" 2>&1

# --- 03b: the round-1 review probes --------------------------------------
#
# The two probes of the round-1 review, kept VERBATIM (byte-identical to the
# ones the reviewer attached). They are the counter-examples of the review:
# every E* line is a way in which a Flow could lose content without a trace.
#
# The in-process probe needs nothing but Node. The end-to-end one drives the
# REAL Bridge over HTTP and needs a real Playwright install -- it is SKIPPED
# with the reason when there is none, and a skip is never written as a pass.
{
  echo "=== ATS-602 evidence: the round-1 review probes (the 14 counter-examples) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  echo "--- the in-process probe (node r1.mjs) ---"
  node tools/ats602-probes/probe-round1-counterexamples.mjs "$TREE" "$TMPDIR/ats602-r1-probe" 2>&1
  echo
  echo "--- the end-to-end probe (node r1-e2e.mjs, the real Bridge over HTTP) ---"
  PW_NM="${ATS602_PLAYWRIGHT_NODE_MODULES:-}"
  if [ -n "$PW_NM" ] && [ -d "$PW_NM" ]; then
    node tools/ats602-probes/probe-round1-counterexamples-e2e.mjs "$TREE" "$PW_NM" "$TMPDIR/ats602-r1-e2e" 2>&1
  else
    echo "SKIPPED: no real Playwright install (set ATS602_PLAYWRIGHT_NODE_MODULES to the"
    echo "          node_modules directory of a real @playwright/test install to run it)."
    echo "          A skip is NOT a pass: the end-to-end counter-examples are covered by"
    echo "          IT-ATS602-API-009/010/011 in 02-node-test-mobile-import-it.log, which"
    echo "          install their own Playwright."
  fi
} > "$EV/03b-round1-review-probes.log" 2>&1

# --- 03c: the round-2 review probes --------------------------------------
#
# The three probes of the round-2 review, kept VERBATIM (byte-identical to
# the ones the reviewer attached, line endings aside). They are the edit
# SEQUENCES of the review: a token that moves to another case (N2-cross), a
# scenario that is copied and then edited (N3), a case that is deleted and
# then re-created under a new name on the trusted path (N1).
#
# The in-process probe and the reader probe need nothing but Node. The
# end-to-end one drives the REAL Bridge over HTTP in BOTH trust modes and
# needs a real Playwright install for the trusted one -- it is SKIPPED with
# the reason when there is none, and a skip is never written as a pass.
{
  echo "=== ATS-602 evidence: the round-2 review probes (N1 / N2-cross / N3) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  echo "--- the in-process probe (node r2.mjs) ---"
  node tools/ats602-probes/probe-round2-counterexamples.mjs "$TREE" "$TMPDIR/ats602-r2-probe" 2>&1
  echo
  echo "--- the reader probe (node r2-reader.mjs) ---"
  node tools/ats602-probes/probe-round2-reader.mjs "$TREE" 2>&1
  echo
  PW_NM="${ATS602_PLAYWRIGHT_NODE_MODULES:-}"
  for MODE in trusted untrusted; do
    echo "--- the end-to-end probe (node r2-e2e.mjs, the real Bridge over HTTP, mode=$MODE) ---"
    if [ -n "$PW_NM" ] && [ -d "$PW_NM" ]; then
      node tools/ats602-probes/probe-round2-counterexamples-e2e.mjs "$TREE" "$PW_NM" "$TMPDIR/ats602-r2-e2e-$MODE" "$MODE" 2>&1
    else
      echo "SKIPPED: no real Playwright install (set ATS602_PLAYWRIGHT_NODE_MODULES to the"
      echo "          node_modules directory of a real @playwright/test install to run it)."
      echo "          A skip is NOT a pass: the end-to-end counter-examples are covered by"
      echo "          IT-ATS602-API-012/013/014 in 02-node-test-mobile-import-it.log, which"
      echo "          install their own Playwright."
    fi
    echo
  done
} > "$EV/03c-round2-review-probes.log" 2>&1

# --- 04: the coverage -----------------------------------------------------
{
  echo "=== ATS-602 evidence: the line and branch coverage of the import ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node --test --experimental-test-coverage tests/mobile-import.test.mjs 2>&1 \
    | grep -E "^(ℹ tests|ℹ pass|ℹ fail|ℹ (start|end) of coverage|ℹ +mobile|ℹ +all files|✖)"
} > "$EV/04-coverage-mobile-import.log" 2>&1

# --- 05: the full regression ----------------------------------------------
{
  echo "=== ATS-602 evidence: the full regression (every test file) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  npm test 2>&1
} > "$EV/05-node-test-full.log" 2>&1

# --- 06: the quality gates -------------------------------------------------
{
  echo "=== ATS-602 evidence: the quality gates (ATS-301 gate + WBS updaters) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  bash tools/ats301-probes/check-ats301-gate.sh 2>&1
  echo
  bash tools/ats501-probes/check-wbs-updaters.sh 2>&1
} > "$EV/06-quality-gates.log" 2>&1

# --- 07: the python gates --------------------------------------------------
{
  echo "=== ATS-602 evidence: the python gates (WBS helpers, updaters, test-doc generator) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  python -m pytest tools/ -q 2>&1
} > "$EV/07-python-gates.log" 2>&1

# --- 08: the WBS row and the derived 总览 ----------------------------------
{
  echo "=== ATS-602 evidence: the WBS row and the derived 总览 on the merged tree ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  python - <<'PY'
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path('.').resolve()
sys.path.insert(0, str(ROOT / 'tools'))
from wbs_common import SHEET1, SHEET2, cell_text, read_parts, totals  # noqa: E402

z = zipfile.ZipFile(ROOT / 'docs' / 'WBS.xlsx')
xml = z.read(SHEET2).decode('utf-8')

rows = {}
for m in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
    body = m.group(2)
    # The WBS ID lives in the A cell. Reading it from there -- and not
    # from anywhere in the row -- matters: the dependency column (H) also
    # carries ATS-xxx values, so a row-wide search would file ATS-602
    # under the row of ATS-601.
    a = re.search(r'<x:c r="A\d+"[^>]*>.*?<x:v>(ATS-\d+)</x:v>', body, re.S)
    if a:
        rows[a.group(1)] = int(m.group(1))

for wbs in ('ATS-601', 'ATS-602', 'ATS-603', 'ATS-604', 'ATS-605', 'ATS-606'):
    rid = rows.get(wbs)
    if rid is None:
        print(f'{wbs}: NOT IN THE SHEET')
        continue
    print(f'row {rid}: {wbs}  状态={cell_text(xml, rid, "N")} '
          f'完成率={cell_text(xml, rid, "O")} 剩余人日={cell_text(xml, rid, "P")} '
          f'估算={cell_text(xml, rid, "K")}')

rid = rows['ATS-602']
note = cell_text(xml, rid, 'T')
print()
print(f'ATS-602 注记标记数（必须为 1）: {note.count("【ATS-602】")}')
print(f'注记写明不支持的步骤保留原文: {"不静默丢弃" in note}')
print(f'注记声明了未实现项: {"未实现" in note}')
print(f'注记点名 ATS-603: {"ATS-603" in note}')
print(f'注记点名 ATS-606: {"ATS-606" in note}')
narrative = re.findall(r'第 ?[0-9一二三四五六] ?轮|复核只剩|驳回|不再|改为|此前|之前|曾称', note)
print(f'注记里的过程叙述（必须为空）: {narrative}')
print(f'注记里的 ASCII 分号（必须为 0）: {note.count(";")}')

parts = read_parts()
derived = totals(parts)
xml1 = zipfile.ZipFile(ROOT / 'docs' / 'WBS.xlsx').read(SHEET1).decode('utf-8')
print()
print('--- 总览：派生值与缓存值一致 ---')
print(f'derived: 已完成={derived["completed"]}  '
      f'完成率={derived["completion_rate"]}  剩余人日={derived["sum_remaining"]}')
print(f'cached : 已完成={cell_text(xml1, 8, "B")}  '
      f'完成率={cell_text(xml1, 9, "B")}  剩余人日={cell_text(xml1, 10, "B")}')
PY
} > "$EV/08-wbs-row.log" 2>&1

# --- 09: the environment declaration ---------------------------------------
{
  echo "=== ATS-602 evidence: the environment declaration ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  echo "--- 本机的移动端环境（记录事实，不作通过/未通过声明）---"
  for tool in adb emulator sdkmanager avdmanager xcrun idevice_id; do
    found="$(where "$tool" 2>/dev/null | head -1)"
    printf '%-12s %s\n' "$tool" "${found:-INFO: Could not find files for the given pattern(s).}"
  done
  echo
  echo "ANDROID_HOME : ${ANDROID_HOME:-<not set>}"
  echo
  echo "--- 仓库内的移动端实现（应当只有契约层与映射层，没有驱动）---"
  echo "契约层（ATS-601）:"
  echo "server/adapters/mobile.mjs"
  echo "server/adapters/mobile-target.mjs"
  echo
  echo "用例模型与导入映射层（ATS-602，本次新增）:"
  echo "server/discovery/mobile-flow.mjs"
  echo "server/discovery/mobile-import.mjs"
  echo "server/discovery/mobile-flow-import.mjs"
  echo
  echo "驱动/ADB/模拟器调用（server/ 下契约层与映射层之外，应当为空）:"
  grep -rlE "adb |emulator|avdmanager|sdkmanager" server/ --include='*.mjs' 2>/dev/null \
    | grep -vE "server/adapters/mobile(-target)?\.mjs|server/discovery/mobile-" \
    || echo "(以上为空表示仓库内没有任何设备驱动)"
  echo
  echo "结论：ATS-602 的 UT 与 IT 全部跑在文本夹具上，不需要也不使用任何真实设备。"
  echo "真实 Android 模拟器冒烟属 ATS-603；本机是否具备该环境由 ATS-605 在执行时给出声明。"
  echo "本项**未**把任何未执行的真实设备测试写成 PASS。"
} > "$EV/09-environment-declaration.log" 2>&1

# --- 10: the checksums -----------------------------------------------------
{
  echo "=== ATS-602 evidence: the release manifest ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  python tools/verify_checksums.py 2>&1
} > "$EV/10-checksums.log" 2>&1

echo "collected 11 logs into $EV"
ls -la "$EV"
