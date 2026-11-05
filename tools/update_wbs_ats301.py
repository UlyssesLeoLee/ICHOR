"""ATS-301: sync docs/WBS.xlsx 「开发WBS」row for ATS-301.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats401.py: the sheet XML is patched in place and the
zip is rewritten with every other part byte-identical.

ATS-301 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): append the ATS-301 note

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate:

  B8  COUNTIF(N6:N94,"已完成")       -> counted from the sheet
  B9  1-SUM(P)/SUM(K)                -> computed from the sheet
  B10 SUM(P6:P94)                    -> computed from the sheet

NOTE on 状态: 待审核 ("pending review"), NOT 已完成. The deliverable is
submitted but not accepted yet -- the reviewer (Opus) syncs the completion
state after the review passes. Declaring it 已完成 before review would
contradict "不得自行置 done".

IDEMPOTENCY: running this script twice must leave row ATS-301 byte-identical.
The marker-aware merge in wbs_common.set_marked_cell replaces the previous
marked block instead of appending, so the second run is a no-op. `verify()`
asserts that.
"""
import re
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wbs_common import set_marked_cell

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'
SHEET2 = 'xl/worksheets/sheet2.xml'
SHEET1 = 'xl/worksheets/sheet1.xml'

FIRST_ROW, LAST_ROW = 6, 94

MARKER = '【ATS-301】'


def xml_escape(text):
    """Escape a text for use inside an XML element body.

    The cell values are written into `<x:v>` elements verbatim. A note that
    contains `<`, `>` or `&` -- a hex digest in angle brackets, a comparison
    operator, an ampersand -- would otherwise be written RAW into
    sheet2.xml, which makes the workbook unparseable (Excel refuses to open
    it and every reader of the sheet fails).

    The escape is applied to the text BEFORE it goes into the cell, and it is
    the same set of entities the XML spec defines, so the round trip through
    the reader is lossless.
    """
    return (str(text)
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;'))

NOTE = (
    'Runner/Reporter アダプタ契約 v1（adapter-contract/v1）已实现并实测：'
    'Playwright 与 WDIO 通过同一发现、启动、停止、采集 API（server/adapters/contract.mjs），'
    '能力协商按 scope 声明并可检测不支持的能力（requireCapability 抛 CAPABILITY_UNSUPPORTED 并给出原因）；'
    '不支持的能力是可检测的返回，不是异常崩溃。'
    '本任务相关测试共 77 项全通过，其中 10 项为真实引擎 IT（examples/sample-playwright 真实 @playwright/test 1.64.1 + '
    'examples/sample-wdio 真实 WebdriverIO 10.1.0），在真实浏览器上验证两个引擎映射到同一结果模型、'
    '各产出 1 PASS + 1 FAIL、stop() 能终止在飞运行（断言可证伪：被停止的运行未跑完全部用例且明显快于自然跑完，'
    'no-op 变异下测试变红）；未安装引擎时该 10 项按设计 skip 而非 fail。'
    'HTTP 层的能力协商有 IT 覆盖（GET /runners、带 capabilities/runner 的 /run），'
    '409 响应体带 missing[]/rejected[] 理由。'
    '实现载体：server/adapters/{contract,registry,playwright,playwright-cli,wdio}.mjs、'
    '探针 tools/ats301-probes/、契约文档 docs/18-RUNNER-ADAPTER-CONTRACT.md、'
    '证据 docs/evidence/ATS-301/。'
    '未实现（不属本项）：远程 Runner（ATS-501 起）、沙箱与资源隔离（ATS-402 起）、'
    'CI 上的引擎矩阵（ATS-102 的 workflow 已就位但未跑本项矩阵）。'
    '范围声明：Bridge 层只有 start/collect 经契约，discover/stop 仍是 v0.1 路径（详见 docs/18 §9.0）。'
)


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


def patch_workbook():
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-301')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: append the ATS-301 note, replacing a previous copy of it.
    # The note text is XML-ESCAPED before it goes into the cell: a `<24hex>`
    # digest or a comparison operator written raw would make sheet2.xml
    # unparseable and the workbook unreadable.
    xml2 = set_marked_cell(xml2, rid, 'T', MARKER, xml_escape(NOTE))

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh the cached values of the existing formulas -----------
    done, rate, sum_p = summarise(xml2)
    xml1 = parts[SHEET1].decode('utf-8')
    xml1 = set_cell_in_row(xml1, 8, 'B', str(done), numeric=True)
    xml1 = set_cell_in_row(xml1, 9, 'B', repr(rate), numeric=True)
    xml1 = set_cell_in_row(xml1, 10, 'B', str(int(sum_p)) if sum_p == int(sum_p) else str(sum_p), numeric=True)
    parts[SHEET1] = xml1.encode('utf-8')
    print(f'overview: 已完成={done} 完成率={rate} 剩余人日={sum_p}')

    # --- rewrite the archive, preserving every other part byte-for-byte -----
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


def row_signature():
    """The ATS-301 row's cells, for the idempotency check."""
    zin = zipfile.ZipFile(XLSX)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-301')
    return rm.group(0)


def verify():
    """Assert the workbook still parses and row ATS-301 is exactly as intended."""
    zin = zipfile.ZipFile(XLSX)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-301')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    assert status == '待审核', f'ATS-301 status is {status!r}, expected 待审核'
    assert rate == '1', f'ATS-301 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-301 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-301 note has {note.count(MARKER)} markers, expected 1'
    assert 'adapter-contract/v1' in note, 'ATS-301 note is missing the contract version'
    print(f'verify: ATS-301 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')


if __name__ == '__main__':
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument('--verify-only', action='store_true')
    args = ap.parse_args()

    if args.verify_only:
        verify()
    else:
        before = row_signature()
        patch_workbook()
        after = row_signature()
        if before == after:
            print('IDEMPOTENT: row ATS-301 unchanged')
        else:
            print('CHANGED (first run applied the update)')
        # A second run must be a no-op.
        second_before = row_signature()
        patch_workbook()
        second_after = row_signature()
        assert second_before == second_after, 'the updater is NOT idempotent'
        print('IDEMPOTENT: a second run leaves row ATS-301 byte-identical')
        verify()
