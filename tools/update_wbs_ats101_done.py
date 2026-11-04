"""ATS-101: mark the WBS row as 已完成 now that the review has passed.

`tools/update_wbs_ats101.py` deliberately wrote 待审核 ("pending review") into
the ATS-101 row: the deliverable was frozen and submitted, but it had not been
accepted yet, and declaring 已完成 before the review would contradict "不得自行
置 done".

The reviewer has now returned PASS (see the SEIKOIST-146 thread, round 8), so
the row can move to 已完成. This script makes exactly that change plus the
matching refresh of the 总览 cached values, and nothing else.

Like update_wbs_ats101.py it edits the workbook surgically -- no openpyxl, no
rebuild -- so every other row, formula, style and data-validation list stays
byte-identical.
"""
import re
import shutil
import zipfile
from pathlib import Path

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'
SHEET2 = 'xl/worksheets/sheet2.xml'
SHEET1 = 'xl/worksheets/sheet1.xml'

# The six values of the 状态 column's data-validation list:
#   未开始, 进行中, 待审核, 已阻塞, 已完成, 已取消
STATUS_DONE = '已完成'


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def set_cell(xml, col, value, *, numeric=False):
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


def main():
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-101')
    xml2 = set_cell_in_row(xml2, rid, 'N', STATUS_DONE)
    # 完成率 stays 1 and 剩余人日 keeps its formula K*(1-O) = 0.
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)
    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: one more row is now 已完成 -----------------------------------
    # B8  = COUNTIF(开发WBS!N6:N94,"已完成")  -> 1
    # B9  = 1 - SUM(P)/SUM(K) = 1 - 468/470   (unchanged: ATS-101 contributes 0)
    # B10 = SUM(P) = 468                     (unchanged)
    xml1 = parts[SHEET1].decode('utf-8')
    xml1 = set_cell_in_row(xml1, 8, 'B', '1', numeric=True)
    xml1 = set_cell_in_row(xml1, 9, 'B', '0.004255319148936', numeric=True)
    xml1 = set_cell_in_row(xml1, 10, 'B', '468', numeric=True)
    parts[SHEET1] = xml1.encode('utf-8')

    tmp = XLSX.with_suffix('.xlsx.tmp')
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            info = infos[name]
            zi = zipfile.ZipInfo(name, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            zout.writestr(zi, data)
    shutil.copy2(tmp, XLSX)
    tmp.unlink()
    print(f'updated {XLSX}: ATS-101 -> {STATUS_DONE}')


if __name__ == '__main__':
    main()
