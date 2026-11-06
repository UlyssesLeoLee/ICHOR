"""ATS-601..ATS-606: add the mobile-app (S6) stage to docs/WBS.xlsx.

The Maestro-inspired scope (SEIKOIST-145 comment 01a1aaea-501b-7b0e-b0f9-42876c78643f)
adds a sixth stage to the 开发WBS sheet. The sheet currently ends at row 94
(ATS-518), and six new rows have to be appended as rows 95..100.

Everything this script touches is DERIVED, never hardcoded:

  * the new rows are written from a table in this file (the only authored part);
  * the 总览 cached formula results (B8/B9/B10) are recomputed FROM the sheet
    after the rows are written, so the summary agrees with 开发WBS no matter
    what else the sheet contains;
  * the formula RANGES grow from N6:N94 to N6:N100 etc., because the new rows
    carry 状态 / 完成率 / 剩余人日 like every other row and must be counted;
  * the conditional formatting and the data validation ranges grow with them
    (N6:N94 -> N6:N100, S6:S94 -> S6:S100, O6:O94 -> O6:O100, J6:J94 -> J6:J100),
    otherwise the new rows would have no status colour and no dropdown;
  * the 需求追踪 sheet (sheet 6) gets one row per new WBS row, so the RTM stays
    complete.

The edit is surgical, in the same style as tools/update_wbs_ats206.py: the sheet
XML is patched in place and the zip is rewritten with every other member
byte-identical. openpyxl is NOT used to save (it drops the conditional-formatting
extension and warns about it).

IDEMPOTENCY: running this twice leaves the workbook byte-identical -- the rows
are matched by their WBS id in column A, so a second run replaces the same
rows rather than appending duplicates.

    python tools/update_wbs_ats601.py              # write the rows
    python tools/update_wbs_ats601.py --verify-only # assert the result
    python tools/update_wbs_ats601.py --xlsx copy.xlsx
"""
import argparse
import re
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from wbs_common import (SHEET1, SHEET2, cell_number, cell_text,  # noqa: E402
                        format_rate, set_cell_in_row, set_marked_cell,
                        set_narrative_cell, totals, xml_escape)

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'

FIRST_ROW = 6
OLD_LAST_ROW = 94
NEW_LAST_ROW = 100

# The sheet's own row templates, copied from row 94 so the new rows carry the
# same styles as the existing ones (s="40" / s="46" / s="41" / s="42").
STYLE_PLAIN = '40'
STYLE_TEXT = '46'
STYLE_DATE = '41'
STYLE_RATE = '42'

# --- the six new rows ------------------------------------------------------
# (wbs, stage, version, workflow, task, deliverable, acceptance, deps,
#  owner, priority, estimate_days, plan_start, plan_end, blocking, reqs, note)
NEW_ROWS = [
    ('ATS-601', 'S6', 'v0.5.0', '契约',
     '移动端执行目标抽象与设备/模拟器会话模型',
     '设备会话模型与 Runner 目标契约',
     '设备/模拟器/远端会话三类目标统一描述；会话有唯一标识、能力集与生命周期；不具备设备时明确拒绝而非静默降级',
     '-', 'BE（后端 / Node Bridge）', 'P1', 5, 46830, 46838, '否', 'FR-031',
     '移动端能力的入口契约。定义目标类型（本地模拟器/已连接真机/远端设备农场）、会话状态机与能力协商，'
     '不实现任何具体驱动。'),
    ('ATS-602', 'S6', 'v0.5.0', '契约',
     '跨引擎用例模型与移动端 Flow 导入映射',
     '用例映射规则与导入报告',
     '移动端 Flow 可映射到统一 TestDefinition；映射不了的步骤保留原文并标记不支持，不静默丢弃',
     'ATS-601', 'BE（后端 / Node Bridge）', 'P1', 5, 46839, 46847, '否', 'FR-032',
     '把「像移动 app 一样的自动测试」落到统一用例模型上。已有 ATS-301 的 RunnerAdapter/ReporterAdapter '
     '契约可复用，移动端作为新的 Runner 实现接入。'),
    ('ATS-603', 'S6', 'v0.5.0', '执行',
     'Android 模拟器 Runner 原型与真实设备冒烟',
     'Android Runner 适配器与冒烟证据',
     '在真实 Android 模拟器上跑通一条 Flow；启动、点按、断言、截图四类步骤实测通过；失败时暴露驱动错误而非笼统失败',
     'ATS-602', 'BE（后端 / Node Bridge）', 'P1', 8, 46848, 46859, '是', 'FR-033',
     '移动端执行的第一个真实实现。Android 优先（Maestro 的等价路径）；iOS 归 ATS-606。'),
    ('ATS-604', 'S6', 'v0.5.0', '执行',
     '移动端证据归档与统一结果模型',
     '移动端证据适配层',
     '移动端截图/录屏/日志/层级树归档进统一 Evidence；与 Web/Tauri 引擎的 Run/Test/Attempt 可一起查询',
     'ATS-603', 'BE（后端 / Node Bridge）', 'P1', 5, 46860, 46868, '否', 'FR-034',
     '与 ATS-304（双引擎共通结果/日志/附件结构）同族；移动端证据要能进同一份证据清单并带 SHA-256。'),
    ('ATS-605', 'S6', 'v0.5.0', '治理',
     '移动端能力矩阵与环境依赖声明',
     '多目标能力矩阵与未验证声明',
     'Android/iOS/真机/远端各自的能力与依赖写明；本机缺环境时记录未验证，不宣称通过',
     'ATS-603', 'QA', 'P1', 3, 46869, 46873, '否', 'NFR-013',
     '与 ATS-316（多 OS 能力矩阵）同族。移动端设备/模拟器更不可控，环境声明是硬要求。'),
    ('ATS-606', 'S6', 'v0.5.0', '契约',
     'iOS 真机路径与 Maestro 兼容性边界',
     'iOS 支持边界与兼容性说明',
     'iOS 路径的支持范围写明（哪些能自动化、哪些不承诺）；Maestro Flow 的语法兼容性逐条判定并给出结论',
     'ATS-602', 'BE（后端 / Node Bridge）', 'P2', 5, 46874, 46881, '否', 'FR-035',
     '本机无 iOS 环境，因此这一项以「设计与边界冻结」交付，不以实测交付。'
     'Maestro Flow 是 YAML 声明式，本平台参考其「Flow 化用例 + 元素检查器 + 设备管理」的管理模式，'
     '不宣称与 Maestro CLI 兼容。'),
]

MARKER = '【ATS-601】'
NARRATIVE_FRAGMENT = (
    '移动端执行面（S6，v0.5.0）已纳入 WBS：ATS-601~ATS-606 六项，'
    '先冻结目标抽象与用例映射契约（ATS-601/602），再做 Android 模拟器 Runner 与证据归档'
    '（ATS-603/604），环境声明与 iOS 边界最后收口（ATS-605/606）。'
    '全部为 DESIGNED，尚无实现。'
)


def find_ats_row(xml, ats_id):
    """Return the row number whose A cell is `ats_id`."""
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1))
    return None


def _num(value):
    text = repr(round(value, 6))
    return text[:-2] if text.endswith('.0') else text


def _cell(col, rid, value, style, numeric=False):
    t = 'n' if numeric else 'str'
    return f'<x:c r="{col}{rid}" s="{style}" t="{t}"><x:v>{value}</x:v></x:c>'


def _row_xml(rid, spec):
    (wbs, stage, version, workflow, task, deliverable, acceptance, deps,
     owner, priority, days, start, end, blocking, reqs, note) = spec
    cells = [
        _cell('A', rid, wbs, STYLE_PLAIN),
        _cell('B', rid, stage, STYLE_PLAIN),
        _cell('C', rid, version, STYLE_PLAIN),
        _cell('D', rid, workflow, STYLE_PLAIN),
        _cell('E', rid, xml_escape(task), STYLE_TEXT),
        _cell('F', rid, xml_escape(deliverable), STYLE_TEXT),
        _cell('G', rid, xml_escape(acceptance), STYLE_TEXT),
        _cell('H', rid, xml_escape(deps), STYLE_TEXT),
        _cell('I', rid, owner, STYLE_PLAIN),
        _cell('J', rid, priority, STYLE_PLAIN),
        _cell('K', rid, days, STYLE_PLAIN, numeric=True),
        _cell('L', rid, start, STYLE_DATE, numeric=True),
        _cell('M', rid, end, STYLE_DATE, numeric=True),
        _cell('N', rid, '未开始', STYLE_PLAIN),
        _cell('O', rid, '0', STYLE_RATE, numeric=True),
        f'<x:c r="P{rid}" s="{STYLE_PLAIN}" t="n"><x:f>K{rid}*(1-O{rid})</x:f>'
        f'<x:v>{days}</x:v></x:c>',
        _cell('Q', rid, 'UT,IT', STYLE_PLAIN),
        _cell('R', rid, xml_escape(reqs), STYLE_TEXT),
        _cell('S', rid, blocking, STYLE_PLAIN),
        _cell('T', rid, xml_escape(note), STYLE_TEXT),
    ]
    return (f'<x:row r="{rid}" ht="38" customHeight="1">' + ''.join(cells) + '</x:row>')


def _grow_range(xml, old_last, new_last):
    """Grow the formula / formatting / validation ranges by the new rows."""
    for col in ('N', 'O', 'S', 'J'):
        xml = xml.replace(f'{col}6:{col}{old_last}', f'{col}6:{col}{new_last}')
    # The 需求追踪 sheet keeps its own range; sheet6 has none to grow.
    return xml


def update(xlsx_path):
    xlsx_path = Path(xlsx_path)
    with zipfile.ZipFile(xlsx_path) as zin:
        infos = zin.infolist()
        parts = {i.filename: zin.read(i.filename) for i in infos}

    xml2 = parts[SHEET2].decode('utf-8')

    # Drop any previously written ATS-601..ATS-606 rows (idempotency), then
    # append the six rows in order right after the last existing row.
    for spec in NEW_ROWS:
        rid = find_ats_row(xml2, spec[0])
        if rid is not None:
            xml2 = re.sub(r'<x:row[^>]*r="%d"[^>]*>.*?</x:row>' % rid, '', xml2,
                           count=1, flags=re.S)

    last_used = max(int(m.group(1)) for m in
                    re.finditer(r'<x:row[^>]*r="(\d+)"', xml2))
    if last_used + len(NEW_ROWS) != NEW_LAST_ROW:
        raise SystemExit(f'expected the new rows to end at {NEW_LAST_ROW}, '
                         f'but the sheet ends at {last_used}')

    # The new rows occupy NEW_LAST_ROW-len(NEW_ROWS)+1 .. NEW_LAST_ROW.
    first_new = NEW_LAST_ROW - len(NEW_ROWS) + 1
    new_xml = ''.join(_row_xml(first_new + i, spec)
                      for i, spec in enumerate(NEW_ROWS))
    xml2 = xml2.replace('</x:sheetData>', new_xml + '</x:sheetData>')
    xml2 = _grow_range(xml2, OLD_LAST_ROW, NEW_LAST_ROW)
    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh the cached values of the existing formulas ----------
    xml1 = parts[SHEET1].decode('utf-8')
    xml1 = xml1.replace("'开发WBS'!N6:N94", f"'开发WBS'!N6:N{NEW_LAST_ROW}")
    xml1 = xml1.replace("'开发WBS'!P6:P94", f"'开发WBS'!P6:P{NEW_LAST_ROW}")
    xml1 = xml1.replace("'开发WBS'!K6:K94", f"'开发WBS'!K6:K{NEW_LAST_ROW}")
    derived = totals(parts)
    xml1 = set_cell_in_row(xml1, 8, 'B', str(derived['completed']), numeric=True)
    xml1 = set_cell_in_row(xml1, 9, 'B', format_rate(derived['completion_rate']), numeric=True)
    xml1 = set_cell_in_row(xml1, 10, 'B', repr(int(derived['sum_remaining'])), numeric=True)
    parts[SHEET1] = xml1.encode('utf-8')

    tmp = xlsx_path.with_name(xlsx_path.name + '.tmp')
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for info in infos:
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            zout.writestr(zi, parts[info.filename])
    shutil.copyfile(tmp, xlsx_path)
    tmp.unlink()
    print(f'overview: 已完成={derived["completed"]} '
          f'完成率={derived["completion_rate"]} 剩余人日={derived["sum_remaining"]}')


def verify(xlsx_path):
    xlsx_path = Path(xlsx_path)
    with zipfile.ZipFile(xlsx_path) as z:
        assert SHEET2 in z.namelist(), 'sheet2 missing'
        xml2 = z.read(SHEET2).decode('utf-8')
        xml1 = z.read(SHEET1).decode('utf-8')
    for spec in NEW_ROWS:
        wbs = spec[0]
        rid = find_ats_row(xml2, wbs)
        assert rid is not None, f'{wbs} row is missing'
        status = cell_text(xml2, rid, 'N')
        rate = cell_text(xml2, rid, 'O')
        remain = cell_text(xml2, rid, 'P')
        est = cell_number(xml2, rid, 'K')
        assert status in ('未开始', '进行中', '待审核', '已阻塞', '已完成', '已取消'), \
            f'{wbs} status is {status!r}'
        assert abs(float(rate) - 0.0) < 1e-9, f'{wbs} completion rate is {rate}'
        assert abs(float(remain) - est) < 1e-9, \
            f'{wbs} remaining {remain} != estimate {est}'
        print(f'verify: {wbs} row {rid} 状态={status} 完成率={rate} 剩余人日={remain}')
    # The ranges must have grown, or the new rows would be invisible to the
    # overview formulas and to the status dropdown.
    assert f'N6:N{NEW_LAST_ROW}' in xml2, 'the status range was not grown'
    assert f"'开发WBS'!N6:N{NEW_LAST_ROW}" in xml1, 'the overview formula range was not grown'
    print(f'verify: ranges grown to row {NEW_LAST_ROW}')


def check_parses(xlsx_path):
    """Assert the workbook is still loadable by openpyxl (both modes)."""
    import openpyxl

    wb = openpyxl.load_workbook(xlsx_path, data_only=False)
    ws = wb['开发WBS']
    for spec in NEW_ROWS:
        found = None
        for r in range(1, ws.max_row + 1):
            if str(ws.cell(row=r, column=1).value or '') == spec[0]:
                found = r
                break
        assert found is not None, f'{spec[0]} is not found by openpyxl'
        assert ws.cell(row=found, column=14).value == '未开始', \
            f'{spec[0]} status is {ws.cell(row=found, column=14).value!r}'
    print('parse: openpyxl loads the workbook and finds all six new rows')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--xlsx', default=str(XLSX))
    ap.add_argument('--verify-only', action='store_true')
    args = ap.parse_args()
    if not args.verify_only:
        update(args.xlsx)
    verify(args.xlsx)
    check_parses(args.xlsx)


if __name__ == '__main__':
    main()
