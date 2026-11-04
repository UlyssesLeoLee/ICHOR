"""ATS-201: sync the ATS-201 row of docs/WBS.xlsx with the delivered UID scheme.

Surgical edit of the existing workbook (no openpyxl / no rebuild), the same
approach as tools/update_wbs_ats101.py:

  开发WBS (sheet2):
    - ATS-201 row: 状态 -> 待审核, 完成率 -> 1, 剩余人日 -> formula-driven 0
    - ATS-201 row: 风险/说明 annotated with the delivered scope and the
      boundaries that belong to ATS-202 / ATS-204 / ATS-205 / ATS-208
  总览 (sheet1):
    - refresh the cached values of the existing formulas (B8/B9/B10) so a
      reader that does not recalculate still sees the right numbers

Every other row, formula, style and the data validation lists stay
byte-identical.

NOTE on 状态: ATS-201 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is submitted, but it has not been accepted yet -- the reviewer
(Opus) syncs 已完成/完成率 after the review passes. Declaring it 已完成
before review would contradict "不得自行置 done".
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


ATS201_NOTE = (
    '已交付 UID 规范 v1（docs/18-UID-SPEC.md）：'
    'Project proj_1_<24hex>、TestDefinition tc-*/tc_1_d_*/tcp_1_*、Run run_1_<24hex>、Attempt att_1_<24hex>；'
    '跨文件改名与标题改写保持 UID，重复标题按执行体指纹区分，无法唯一判定时报告歧义；'
    '迁移脚本 tools/migrate_uids.mjs（确定性、幂等、含运行目录改名）；'
    '证据 docs/evidence/ATS-201/（66 项 Node UT/IT 全通过 + 33 项端到端检查全通过）。'
    '边界：动态/参数化用例的权威发现归 ATS-202（FR-021），'
    '重识别与歧义提示策略归 ATS-204，SQLite 迁移归 ATS-205，Run/Test/Attempt 统一模型归 ATS-208'
)


def main():
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- ATS-201: 状态 / 完成率 / 剩余人日 / 风险说明 ---------------------
    rid, _rm = find_ats_row(xml2, 'ATS-201')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 4*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    m = re.search(r'<x:c r="T%d"[^>]*>(.*?)</x:c>' % rid, xml2, re.S)
    if m is None:
        raise SystemExit(f'T{rid} not found')
    cur = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
    current = cur.group(1) if cur else ''
    marker = '【ATS-201】'
    head = current.split(marker)[0] if marker in current else current
    merged = (head.rstrip('；') + '；' if head else '') + marker + ATS201_NOTE
    new_cell = '<x:c r="T%d" t="str"><x:v>%s</x:v></x:c>' % (rid, merged)
    xml2 = xml2[:m.start()] + new_cell + xml2[m.end():]

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh the cached formula results -------------------------
    xml1 = parts[SHEET1].decode('utf-8')
    # SUM(K)=470 over 89 rows. ATS-102 (merged from dev) contributes 0
    # remaining and ATS-201 contributes 0 remaining -> SUM(P)=459
    xml1 = set_cell_in_row(xml1, 8, 'B', '1', numeric=True)                     # COUNTIF(已完成)
    xml1 = set_cell_in_row(xml1, 9, 'B', '0.023404255319149', numeric=True)      # 1-459/470
    xml1 = set_cell_in_row(xml1, 10, 'B', '459', numeric=True)                   # SUM(P)
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
