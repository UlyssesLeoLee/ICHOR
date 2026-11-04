"""ATS-102: sync the WBS row for ATS-102 with the delivered build gate.

Surgical edit of the existing workbook (no openpyxl / no rebuild), the same
approach as `tools/update_wbs_ats101.py`:

  开发WBS (sheet2):
    - ATS-102 row: 状态 -> 待审核, 完成率 -> 1, 剩余人日 -> formula-driven 0
    - ATS-103/104/106/107/108 rows: 风险/说明 annotated with the
      prerequisites ATS-102 actually established

  总览 (sheet1):
    - refresh the cached values of the existing formulas (B8/B9/B10) so a
      reader that does not recalculate still sees the right numbers

Every other row, formula, style and the data-validation lists stay
byte-identical.

NOTE on 状态: ATS-102 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is frozen and submitted, but it has not been accepted yet -- the
reviewer (Opus) syncs 已完成/完成率 after the review passes. Declaring it
已完成 before review would contradict "不得自行置 done".

NOTE on the 剩余人日 formula: it stays `K*(1-O)` = 3*(1-1) = 0.
"""
import re
import shutil
import zipfile
from pathlib import Path

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'
SHEET2 = 'xl/worksheets/sheet2.xml'
SHEET1 = 'xl/worksheets/sheet1.xml'

# 待审核 is one of the six values in the N-column data-validation list.
STATUS_PENDING_REVIEW = '待审核'

# The 开发WBS data rows the overview formulas aggregate over.
FIRST_ROW, LAST_ROW = 6, 94


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
    m = re.search(r'<x:row[^>]*r="%d"[^>]*>.*?</x:row>' % rid, xml, re.S)
    if m is None:
        raise SystemExit(f'row {rid} not found')
    row = set_cell(m.group(0), col, value, numeric=numeric)
    return xml[:m.start()] + row + xml[m.end():]


def cell_text(xml, rid, col):
    m = re.search(r'<x:c r="%s%d"[^>]*>(.*?)</x:c>' % (col, rid), xml, re.S)
    if m is None:
        return ''
    v = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
    return v.group(1) if v else ''


def cell_number(xml, rid, col):
    raw = cell_text(xml, rid, col)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def summarise(xml2):
    """Recompute the overview's cached formula values from the sheet itself.

    Mirrors the three formulas that live in the 总览 sheet:
      B8  = COUNTIF('开发WBS'!N6:N94,"已完成")
      B9  = IFERROR(1-SUM('开发WBS'!P6:P94)/SUM('开发WBS'!K6:K94),0)
      B10 = SUM('开发WBS'!P6:P94)

    The values are derived from the sheet rather than hardcoded, so the
    overview stays correct no matter which other rows already carry a
    non-zero completion rate (ATS-101 / ATS-401 are 已完成 / 待审核).
    """
    done = 0
    sum_p = 0.0
    sum_k = 0.0
    for rid in range(FIRST_ROW, LAST_ROW + 1):
        if cell_text(xml2, rid, 'N') == '已完成':
            done += 1
        sum_p += cell_number(xml2, rid, 'P')
        sum_k += cell_number(xml2, rid, 'K')
    rate = 0.0 if sum_k == 0 else 1 - sum_p / sum_k
    return done, rate, sum_p


def main():
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- ATS-102: 状态 / 完成率 / 剩余人日 -----------------------------------
    rid, _rm = find_ats_row(xml2, 'ATS-102')
    xml2 = set_cell_in_row(xml2, rid, 'N', STATUS_PENDING_REVIEW)
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 3*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # --- annotate the rows that ATS-102 unblocked ---------------------------
    # The script is idempotent: a marker identifies the note this script owns,
    # so re-running replaces it instead of appending a second copy.
    notes = {
        'ATS-103': '前置 ATS-102 已交付：apps/studio 已有 lockfile（88 包），CI 门禁含 next build 与产物校验；'
                   '实测 Next.js 16.4.5 静态导出通过（编译 1.7s，静态页 3/3，产物 apps/studio/out/index.html）',
        'ATS-104': '前置 ATS-102 已交付 CI 镜像基线（runs-on: windows-2022 自带 VS 2022 生成工具），但'
                   'workflow 未含 Rust/Tauri job——仓库现状下该 job 必然失败（B-02）；该 job 属本项交付范围，'
                   '须连同 src-tauri/icons/icon.ico 与 MSVC 链一并加入。验收仍以 cargo build（含最终链接）为准',
        'ATS-106': '前置 ATS-102 已交付 CI 门禁（npm ci + npm test）；本项须新增「真实 Playwright CLI 参数契约测试」'
                   '并接入该门禁，否则 B-01 仍会被测试双桩掩盖',
        'ATS-107': '前置 ATS-102 已交付 CI 门禁；本项的真实浏览器夹具须在 apps/studio 或独立工程内以 lockfile 固定依赖',
        'ATS-108': '前置 ATS-102 已交付 CI 门禁；本项的重启恢复与幂等回归须接入该门禁',
    }
    marker = '【ATS-102】'
    for ats, note in notes.items():
        rid, _rm = find_ats_row(xml2, ats)
        m = re.search(r'<x:c r="T%d"[^>]*>(.*?)</x:c>' % rid, xml2, re.S)
        if m is None:
            raise SystemExit(f'T{rid} not found')
        cur = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
        current = cur.group(1) if cur else ''
        # drop a previous copy of this script's note, keep everything else
        head = current.split(marker)[0] if marker in current else current
        merged = (head.rstrip('；') + '；' if head else '') + marker + note
        new_cell = '<x:c r="T%d" t="str"><x:v>%s</x:v></x:c>' % (rid, merged)
        xml2 = xml2[:m.start()] + new_cell + xml2[m.end():]

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh the cached values of the existing formulas -----------
    # The values are recomputed FROM THE SHEET, not hardcoded, so the overview
    # stays correct no matter which other rows (ATS-101 已完成, ATS-401 待审核)
    # already carry a non-zero completion rate.
    done, rate, sum_p = summarise(xml2)
    xml1 = parts[SHEET1].decode('utf-8')
    xml1 = set_cell_in_row(xml1, 8, 'B', str(done), numeric=True)                    # COUNTIF(已完成)
    xml1 = set_cell_in_row(xml1, 9, 'B', repr(rate), numeric=True)                    # 1-SUM(P)/SUM(K)
    xml1 = set_cell_in_row(xml1, 10, 'B', str(int(sum_p)) if sum_p == int(sum_p) else str(sum_p), numeric=True)
    xml1 = set_cell_in_row(
        xml1, 6, 'D',
        'v0.1 已有 Node Bridge/便携 UI/Next/Tauri 源码，已通过 20 项 Node UT/IT；'
        'Next.js 16 静态导出构建已实测通过（ATS-101）；'
        'Agent 契约层已实现（ATS-401）；'
        '锁文件、依赖清单与 CI 构建门禁已交付（ATS-102）。')
    xml1 = set_cell_in_row(
        xml1, 7, 'D',
        '真实浏览器 Playwright ST 未执行（受 B-01 阻断）；Tauri Windows 编译未通过'
        '（B-02：缺 MSVC C++ 构建工具、仓库缺 icons/icon.ico，且成因清单尚未穷尽）；'
        'CI workflow 未在真实 runner 上跑过（ATS-102）；'
        '详见 docs/16-BASELINE-ADR.md、docs/17-BUILD-CI.md 与 docs/17-AGENT-CONTRACT.md。')
    parts[SHEET1] = xml1.encode('utf-8')
    print(f'overview: 已完成={done} 完成率={rate} 剩余人日={sum_p}')

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
    print(f'updated {XLSX}: ATS-102 -> {STATUS_PENDING_REVIEW}')


if __name__ == '__main__':
    main()
