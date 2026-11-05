"""ATS-101: sync docs/WBS.xlsx with the frozen v0.1 baseline.

Surgical edit of the existing workbook (no openpyxl / no rebuild):
  开发WBS (sheet2):
    - ATS-101 row: 状态 -> 待审核, 完成率 -> 1, 剩余人日 -> formula-driven 0
    - ATS-104/106/107/108/112: 风险/说明 annotated with the blocker ids found in ATS-101
  总览 (sheet1):
    - refresh the cached values of the existing formulas (B8/B9/B10) so a reader
      that does not recalculate still sees the right numbers
    - refresh the two narrative cells D6/D7 which still claimed the Next build
      was unverified

Every other row, formula, style and the data validation lists stay byte-identical.

NOTE on 状态: ATS-101 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is frozen and submitted, but it has not been accepted yet -- the
reviewer (Opus) syncs 已完成/完成率 after the review passes. Declaring it
已完成 before review would contradict "不得自行置 done".

NOTE on re-runs after acceptance: once the review has passed, the ATS-101 row
carries 已完成. Re-running this script must NOT walk that row back to 待审核 --
the review is a one-way door. The script therefore only writes 待审核 when the
row does not already carry a terminal state (已完成 / 已取消). The already
accepted row keeps its status; the notes and the cached 总览 values are still
refreshed, because they are derived from the sheet.
"""
import re
import shutil
import zipfile
from pathlib import Path

from wbs_common import (SHEET1, SHEET2, cell_text, format_rate,
                        set_cell_in_row, set_marked_cell, set_narrative_cell,
                        totals)

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script.
TERMINAL_STATUSES = ('已完成', '已取消')


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def main():
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- ATS-101: 状态 / 完成率 / 剩余人日 -----------------------------------
    rid, _rm = find_ats_row(xml2, 'ATS-101')
    # A re-run must not undo an accepted review. Only a row that has not been
    # accepted yet is set to 待审核.
    current_status = cell_text(xml2, rid, 'N')
    if current_status not in TERMINAL_STATUSES:
        # 待审核 is one of the six values in the N-column data-validation list.
        xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 2*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # --- annotate the blockers on the affected WBS rows -----------------------
    # The script is idempotent: a marker identifies the note this script owns,
    # so re-running replaces it instead of appending a second copy.
    notes = {
        'ATS-106': 'B-01阻断：safeRunArgs 传入 Playwright CLI 不存在的 --screenshot/--video，须移除并改为向项目 playwright.config.ts 注入 use.screenshot/use.video（仅删除会丢失截图与视频）；本项应升 P0 关键阻断，并须加真实 CLI 参数契约测试',
        'ATS-107': '依赖 ATS-106 修复 B-01 后方可执行真实浏览器 PASS/FAIL',
        'ATS-108': '须覆盖 B-03：重启后 cancelling 状态恢复与终态操作幂等；B-01 与 B-03 须同批修复与回归（当前产品源码下 B-03 已可触发，探针 C1 连跑 3 次 3/3 命中）',
        'ATS-104': 'B-02阻断（四个已定位成因，且成因清单尚未穷尽）：(1) msvc 链缺 MSVC「使用 C++ 的桌面开发」工作负载（Cargo 已安装但链接失败，最终链接本机无法验证）；(2) 仓库缺 src-tauri/icons/icon.ico，tauri-build 对任何 windows target 都需要它，全新 clone 永远构建失败；(3) gnu 链编译器/运行时不匹配；(4) gnu 链 cdylib 导出序号超限（cargo check 通过但 cargo build 链接失败：export ordinal too large）。验收须以 cargo build（含最终链接）为准，不以 cargo check 为准；上述为必要条件而非充分条件',
        'ATS-112': '须覆盖错误归类与路径泄漏（根因在 server/index.mjs:146 的统一错误映射：正则未命中即 500 且原样回显 e.message 泄漏宿主绝对路径）；NOT_A_DIRECTORY 抛自 server/core.mjs:31，RUN_NOT_ACTIVE 抛自 server/index.mjs:58（此码与 B-03 相交，但与恢复集合 index.mjs:17 是两处不同缺陷）；另需终态 /stop 幂等',
    }
    marker = '【ATS-101】'
    # Notes written by the first ATS-101 delivery (pre-review). They are
    # superseded by the marked notes below and must not linger in the sheet.
    stale_prefixes = (
        'B-01阻断：safeRunArgs 传入 Playwright CLI 不存在的 --screenshot/--video，须改为配置注入',
        '依赖 ATS-106 修复 B-01 后方可执行真实浏览器 PASS/FAIL',
        '须覆盖 B-03：重启后 cancelling 状态恢复与终态操作幂等',
        'B-02阻断：缺 MSVC「使用 C++ 的桌面开发」工作负载，Cargo 已安装但链接失败',
        '须覆盖 B-03 附带项：终态 /stop 幂等与错误归类',
    )
    # Fragments left behind when a stale note was split on '；'
    stale_fragments = (
        '本项应升 P0 关键阻断',
    )
    for ats, note in notes.items():
        rid, _rm = find_ats_row(xml2, ats)
        xml2 = set_marked_cell(xml2, rid, 'T', marker, note,
                               stale_prefixes, stale_fragments)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh cached formula results + the two narrative cells ------
    # The cached values are DERIVED from the sheet that was just written, not
    # hardcoded: a hardcoded cache is stale as soon as another script changes
    # a row, and the 总览 would then silently disagree with the 开发WBS.
    xml1 = parts[SHEET1].decode('utf-8')
    derived = totals(parts)
    xml1 = set_cell_in_row(
        xml1, 8, 'B', str(derived['completed']), numeric=True)
    xml1 = set_cell_in_row(
        xml1, 9, 'B', format_rate(derived['completion_rate']), numeric=True)
    xml1 = set_cell_in_row(
        xml1, 10, 'B', repr(int(derived['sum_remaining'])), numeric=True)
    # The two narrative cells are shared with every other WBS updater. Each
    # task contributes one marked fragment and the cell is the composition of
    # all of them, so this script can no longer erase another task's text.
    xml1 = set_narrative_cell(xml1, 6, 'D6')
    xml1 = set_narrative_cell(xml1, 7, 'D7')
    parts[SHEET1] = xml1.encode('utf-8')

    # --- rewrite the archive, preserving every other part byte-for-byte ------
    tmp = XLSX.with_suffix('.xlsx.tmp')
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            info = infos[name]
            zi = zipfile.ZipInfo(name, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            zout.writestr(zi, data)
    # os.replace() can fail on Windows when the target is held open; copy then unlink
    shutil.copy2(tmp, XLSX)
    tmp.unlink()
    print('updated', XLSX)


if __name__ == '__main__':
    main()
