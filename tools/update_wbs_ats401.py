"""ATS-401: sync docs/WBS.xlsx 「开发WBS」row for ATS-401.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats101.py: the sheet XML is patched in place and the
zip is rewritten with every other part byte-identical.

ATS-401 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): append the ATS-401 note

The overview sheet's cached formula results are refreshed to match:
  B8  COUNTIF(N6:N94,"已完成")      -> 0        (no row is 已完成)
  B9  1-SUM(P)/SUM(K)               -> 1-465/470
  B10 SUM(P6:P94)                   -> 465

NOTE on 状态: 待审核 ("pending review"), NOT 已完成. The deliverable is
submitted but not accepted yet -- the reviewer (Opus) syncs the completion
state after the review passes. Declaring it 已完成 before review would
contradict "不得自行置 done".
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
    m = re.search(r'<x:row[^>]*r="%d"[^>]*>.*?</x:row>' % rid, xml, re.S)
    if m is None:
        raise SystemExit(f'row {rid} not found')
    row = set_cell(m.group(0), col, value, numeric=numeric)
    return xml[:m.start()] + row + xml[m.end():]


NOTE = (
    '【ATS-401】Agent 契约 v1 已实现并实测（agent-contract/v1）：'
    '请求须带作用域/预算/输入出处，角色对应能力白名单，产出为待审提案，提案人不得自审；'
    '写入与提交类能力（write_source/git_commit/update_expected 等）在请求层一律被拒，'
    '契约层只 import node:crypto 与 node:path 因而物理上无法写文件或发网络请求。'
    'UT/IT 39 项新增、npm test 共 59 项全通过；'
    '复现脚本 tools/ats401-probes/probe-agent-boundary.mjs（含负控），'
    '证据 docs/evidence/ATS-401/。'
    '未实现（不属本项）：模型提供商接入（ATS-403）、API Key 存储与外传知情授权（ATS-402）、'
    '提案落地（应用 diff / 更新 expected / Git 提交）；'
    'FR-024/FR-025 的能力状态仍为 DESIGNED，契约层不等于能力。'
)


def main():
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-401')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: append the ATS-401 note, replacing a previous copy of it.
    m = re.search(r'<x:c r="T%d"[^>]*>(.*?)</x:c>' % rid, xml2, re.S)
    if m is None:
        raise SystemExit(f'T{rid} not found')
    cur = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
    current = cur.group(1) if cur else ''
    head = current.split('【ATS-401】')[0].rstrip('；')
    merged = (head + '；' if head else '') + NOTE
    new_cell = '<x:c r="T%d" t="str"><x:v>%s</x:v></x:c>' % (rid, merged)
    xml2 = xml2[:m.start()] + new_cell + xml2[m.end():]

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh the cached values of the existing formulas -----------
    xml1 = parts[SHEET1].decode('utf-8')
    # SUM(K)=470 over 89 rows; ATS-401 contributes 0 remaining -> SUM(P)=465
    xml1 = set_cell_in_row(xml1, 8, 'B', '0', numeric=True)                   # COUNTIF(已完成)
    xml1 = set_cell_in_row(xml1, 9, 'B', '0.01063829787234', numeric=True)   # 1-465/470
    xml1 = set_cell_in_row(xml1, 10, 'B', '465', numeric=True)                # SUM(P)
    parts[SHEET1] = xml1.encode('utf-8')

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


if __name__ == '__main__':
    main()
