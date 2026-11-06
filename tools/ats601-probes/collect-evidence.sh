#!/usr/bin/env bash
# ATS-601 -- re-collect the eleven evidence logs on the delivered tree.
#
# Every log names the commit it describes in its header, so a reader can
# tell which tree a number belongs to. This script re-runs them on the
# tree it is given and writes them to docs/evidence/ATS-601/.
#
# usage: bash tools/ats601-probes/collect-evidence.sh <tree> <probe-dir>
set -uo pipefail

TREE="$1"
PROBES="$2"
PROBES_NATIVE="$(cd "$PROBES" && pwd -W 2>/dev/null || echo "$PROBES")"
cd "$TREE" || exit 1

export TMPDIR="${TMPDIR:-/tmp}"
mkdir -p "$TMPDIR"

EV="docs/evidence/ATS-601"
mkdir -p "$EV"

COMMIT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

hdr() {
  echo
  echo "=============================================================="
  echo "$*"
  echo "=============================================================="
}

# --- 01: the mobile contract unit tests -----------------------------------
{
  echo "=== ATS-601 evidence: the mobile target/session contract (unit tests) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node --test tests/mobile-adapter.test.mjs tests/mobile-target.test.mjs 2>&1
} > "$EV/01-node-test-mobile-contract.log" 2>&1

# --- 02: the contract probe ------------------------------------------------
{
  echo "=== ATS-601 evidence: the contract probe: the hard rules side by side ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node tools/ats601-probes/probe-mobile-contract.mjs 2>&1
} > "$EV/02-probe-mobile-contract.log" 2>&1

# --- 03: the line and branch coverage --------------------------------------
{
  echo "=== ATS-601 evidence: line and branch coverage of the mobile contract ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node --test --experimental-test-coverage tests/mobile-adapter.test.mjs tests/mobile-target.test.mjs 2>&1 \
    | grep -E "^(ℹ tests|ℹ pass|ℹ fail|ℹ (start|end) of coverage|ℹ +mobile|ℹ +all files|✖)"
} > "$EV/03-coverage-mobile.log" 2>&1

# --- 04: the full regression ------------------------------------------------
{
  echo "=== ATS-601 evidence: the full regression (every test file) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  npm test 2>&1
} > "$EV/04-node-test-full.log" 2>&1

# --- 05: the ATS-301 gate ---------------------------------------------------
{
  echo "=== ATS-601 evidence: the ATS-301 gate (WBS shared-cell regression + ADR citations + port audit) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  bash tools/ats301-probes/check-ats301-gate.sh 2>&1
} > "$EV/05-quality-gates-ats301.log" 2>&1

# --- 06: the WBS updater coexistence regression -----------------------------
{
  echo "=== ATS-601 evidence: the WBS updater coexistence regression ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  bash tools/ats501-probes/check-wbs-updaters.sh 2>&1
} > "$EV/06-wbs-updaters.log" 2>&1

# --- 07: the remote protocol audit ------------------------------------------
{
  echo "=== ATS-601 evidence: the remote protocol audit (rejection code table) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  node tools/ats501-probes/audit-remote-protocol.mjs 2>&1
} > "$EV/07-remote-protocol-audit.log" 2>&1

# --- 08: the python gates ----------------------------------------------------
{
  echo "=== ATS-601 evidence: the python gates (WBS helpers, updaters, test-doc generator) ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  python -m pytest tools/ -q 2>&1
} > "$EV/08-python-gates.log" 2>&1

# --- 09: the WBS row and the derived 总览 ------------------------------------
{
  echo "=== ATS-601 evidence: the WBS row and the derived 总览 on the merged tree ==="
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
    # from anywhere in the row -- matters: the dependency column (H)
    # also carries ATS-xxx values, so a row-wide search would file
    # ATS-602 under the row of ATS-601.
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

rid = rows['ATS-601']
note = cell_text(xml, rid, 'T')
print()
print(f'ATS-601 注记标记数（必须为 1）: {note.count("【ATS-601】")}')
print(f'注记写明 99 例: {"99 例" in note}')
print(f'注记声明了未实现项: {"未实现" in note}')
print(f'注记点名 ATS-603: {"ATS-603" in note}')
narrative = re.findall(r'第 ?[0-9一二三四五六] ?轮|复核只剩|驳回|不再|改为|此前|之前|曾称', note)
print(f'注记里的过程叙述（必须为空）: {narrative}')
print(f'注记里的 ASCII 分号（必须为 0）: {note.count(";")}')

parts = read_parts()
derived = totals(parts)
xml1 = zipfile.ZipFile(ROOT / 'docs' / 'WBS.xlsx').read(SHEET1).decode('utf-8')
print()
print('--- 总览：派生值与缓存值一致 ---')
print(f'derived: 已完成={derived["completed"]}  完成率={derived["completion_rate"]}  剩余人日={derived["sum_remaining"]}')
print(f'cached : 已完成={cell_text(xml1, 8, "B")}  完成率={cell_text(xml1, 9, "B")}  剩余人日={cell_text(xml1, 10, "B")}')
PY
} > "$EV/09-wbs-row.log" 2>&1

# --- 10: the environment declaration ----------------------------------------
{
  echo "=== ATS-601 evidence: the environment declaration ==="
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
  echo "--- 仓库内的移动端实现（应当只有契约层，没有驱动）---"
  echo "契约层:"
  echo "server/adapters/mobile.mjs"
  echo "server/adapters/mobile-target.mjs"
  echo
  echo "驱动/ADB/模拟器调用（server/ 下契约层之外，应当为空）:"
  grep -rlE "adb |emulator|avdmanager|sdkmanager" server/ --include='*.mjs' 2>/dev/null \
    | grep -vE "server/adapters/mobile(-target)?\.mjs" || echo "(以上为空表示仓库内没有任何设备驱动)"
  echo
  echo "结论：ATS-601 的 UT 全部跑在假目标 + 假会话上，不需要也不使用任何真实设备。"
  echo "真实 Android 模拟器冒烟属 ATS-603；本机是否具备该环境由 ATS-605 在执行时给出声明。"
  echo "本项**未**把任何未执行的真实设备测试写成 PASS。"
} > "$EV/10-environment-declaration.log" 2>&1

# --- 11: the review probe ----------------------------------------------------
{
  echo "=== ATS-601 evidence: the review probe (review-r1.mjs) against the delivered tree ==="
  echo "tree : $COMMIT"
  echo "date : $STAMP"
  echo
  if [ -f "$PROBES/r2/review-r1.mjs" ]; then
    node "$PROBES_NATIVE/r2/review-r1.mjs" "$(pwd -W)" 2>&1
  else
    echo "SKIPPED: $PROBES/r2/review-r1.mjs is not there"
  fi
} > "$EV/11-review-probe.log" 2>&1

echo "collected 11 logs into $EV"
ls -la "$EV"
