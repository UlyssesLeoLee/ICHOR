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
"""
import re
import shutil
import zipfile
from pathlib import Path

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'
SHEET2 = 'xl/worksheets/sheet2.xml'
SHEET1 = 'xl/worksheets/sheet1.xml'


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def set_cell(xml, col, value, *, numeric=False):
    """Set the <x:v> of one cell in one row, keeping its style and any formula."""
    pat = re.compile(r'(<x:c r="%s\d+"[^>]*>)(.*?)(</x:c>)' % col, re.S)
    m = pat.search(xml)
    if m is None:
        raise SystemExit(f'cell {col} not found')
    open_tag, body, close = m.groups()
    f = re.search(r'<x:f>(.*?)</x:f>', body, re.S)
    open_tag = re.sub(r'\st="[^"]*"', '', open_tag)
    open_tag = open_tag[:-1] + (' t="n">' if numeric else ' t="str">')
    new_body = (f.group(0) if f else '') + f'<x:v>{value}</x:v>'
    return xml[:m.start()] + open_tag + new_body + close + xml[m.end():]


def set_cell_in_row(xml, rid, col, value, *, numeric=False):
    """Set one cell of one specific row without touching other rows."""
    m = re.search(r'<x:row[^>]*r="%d"[^>]*>.*?</x:row>' % rid, xml, re.S)
    if m is None:
        raise SystemExit(f'row {rid} not found')
    row = set_cell(m.group(0), col, value, numeric=numeric)
    return xml[:m.start()] + row + xml[m.end():]


def main():
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- ATS-101: 状态 / 完成率 / 剩余人日 -----------------------------------
    rid, _rm = find_ats_row(xml2, 'ATS-101')
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
        'ATS-108': '须覆盖 B-03：重启后 cancelling 状态恢复与终态操作幂等；B-01 与 B-03 须同批修复与回归',
        'ATS-104': 'B-02阻断（两个独立成因）：(1) msvc 链缺 MSVC「使用 C++ 的桌面开发」工作负载（Cargo 已安装但链接失败）；(2) 仓库缺 src-tauri/icons/icon.ico，tauri-build 对任何 windows target 都需要它，全新 clone 永远构建失败；gnu 链另有编译器/运行时不匹配问题',
        'ATS-112': '须覆盖 B-03 附带项：终态 /stop 幂等、错误归类（NOT_A_DIRECTORY / RUN_NOT_ACTIVE 实测 500）与路径泄漏',
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
        m = re.search(r'<x:c r="T%d"[^>]*>(.*?)</x:c>' % rid, xml2, re.S)
        if m is None:
            raise SystemExit(f'T{rid} not found')
        cur = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
        current = cur.group(1) if cur else ''
        # drop a previous copy of this script's note, keep everything else
        head = current.split(marker)[0] if marker in current else current
        # drop the superseded notes from the first delivery
        kept = [seg for seg in head.split('；')
                if not any(seg.startswith(p) for p in stale_prefixes)
                and seg not in stale_fragments]
        head = '；'.join(kept)
        merged = (head.rstrip('；') + '；' if head else '') + marker + note
        new_cell = '<x:c r="T%d" t="str"><x:v>%s</x:v></x:c>' % (rid, merged)
        xml2 = xml2[:m.start()] + new_cell + xml2[m.end():]

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh cached formula results + the two narrative cells ------
    xml1 = parts[SHEET1].decode('utf-8')
    # SUM(K)=470 over 89 rows; ATS-101 contributes 0 remaining -> SUM(P)=468
    xml1 = set_cell_in_row(xml1, 8, 'B', '0', numeric=True)                   # COUNTIF(已完成)
    xml1 = set_cell_in_row(xml1, 9, 'B', '0.004255319148936', numeric=True)  # 1-468/470
    xml1 = set_cell_in_row(xml1, 10, 'B', '468', numeric=True)                # SUM(P)
    xml1 = set_cell_in_row(
        xml1, 6, 'D',
        'v0.1 已有 Node Bridge/便携 UI/Next/Tauri 源码，已通过 20 项 Node UT/IT；'
        'Next.js 16 静态导出构建已实测通过（ATS-101）。')
    xml1 = set_cell_in_row(
        xml1, 7, 'D',
        '真实浏览器 Playwright ST 未执行（受 B-01 阻断）；Tauri Windows 编译未通过'
        '（B-02：msvc 链缺 MSVC C++ 构建工具）；详见 docs/16-BASELINE-ADR.md。')
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
