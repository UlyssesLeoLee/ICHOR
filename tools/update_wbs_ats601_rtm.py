"""ATS-601..ATS-606: add the S6 rows to the 需求追踪 sheet (sheet 6).

The 开发WBS sheet (sheet 2) gets the six new rows from
tools/update_wbs_ats601.py. This script keeps the REQUIREMENT → WBS →
VERIFICATION sheet in step: without it the RTM would silently lose the six
new tasks, and `docs/10-RTM.md` would disagree with the workbook.

The RTM sheet has no conditional formatting and no data validation, so the
edit is a pure row insertion. Rows are matched by the WBS id inside column C
("ATS-601 …"), so a second run replaces the same rows instead of appending
duplicates -- the script is idempotent.

    python tools/update_wbs_ats601_rtm.py
    python tools/update_wbs_ats601_rtm.py --verify-only
"""
import argparse
import re
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from wbs_common import xml_escape  # noqa: E402

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'
SHEET6 = 'xl/worksheets/sheet6.xml'

FIRST_RTM_ROW = 5
LAST_RTM_ROW = 93
NEW_RTM_LAST_ROW = 99

# (wbs, requirements, version, task, verification, acceptance)
RTM_ROWS = [
    ('ATS-601', 'FR-031', 'v0.5.0', '移动端执行目标抽象与设备/模拟器会话模型', '审查,UT',
     '设备/模拟器/远端会话三类目标统一描述；会话有唯一标识、能力集与生命周期；不具备设备时明确拒绝而非静默降级'),
    ('ATS-602', 'FR-032', 'v0.5.0', '跨引擎用例模型与移动端 Flow 导入映射', 'UT,IT',
     '移动端 Flow 可映射到统一 TestDefinition；映射不了的步骤保留原文并标记不支持，不静默丢弃'),
    ('ATS-603', 'FR-033', 'v0.5.0', 'Android 模拟器 Runner 原型与真实设备冒烟', 'UT,IT',
     '在真实 Android 模拟器上跑通一条 Flow；启动、点按、断言、截图四类步骤实测通过；失败时暴露驱动错误而非笼统失败'),
    ('ATS-604', 'FR-034', 'v0.5.0', '移动端证据归档与统一结果模型', 'UT,IT',
     '移动端截图/录屏/日志/层级树归档进统一 Evidence；与 Web/Tauri 引擎的 Run/Test/Attempt 可一起查询'),
    ('ATS-605', 'NFR-013', 'v0.5.0', '移动端能力矩阵与环境依赖声明', '审查',
     'Android/iOS/真机/远端各自的能力与依赖写明；本机缺环境时记录未验证，不宣称通过'),
    ('ATS-606', 'FR-035', 'v0.5.0', 'iOS 真机路径与 Maestro 兼容性边界', '审查',
     'iOS 路径的支持范围写明（哪些能自动化、哪些不承诺）；Maestro Flow 的语法兼容性逐条判定并给出结论'),
]


def _cell(col, rid, value, style=None):
    s = f' s="{style}"' if style else ''
    return f'<x:c r="{col}{rid}"{s} t="str"><x:v>{xml_escape(value)}</x:v></x:c>'


def find_rtm_row(xml, wbs):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'>{wbs} ' in rm.group(2) or f'<x:v>{wbs}</x:v>' in rm.group(2):
            return int(rm.group(1))
    return None


def update(xlsx_path):
    xlsx_path = Path(xlsx_path)
    with zipfile.ZipFile(xlsx_path) as zin:
        infos = zin.infolist()
        parts = {i.filename: zin.read(i.filename) for i in infos}

    xml = parts[SHEET6].decode('utf-8')

    for spec in RTM_ROWS:
        rid = find_rtm_row(xml, spec[0])
        if rid is not None:
            xml = re.sub(r'<x:row[^>]*r="%d"[^>]*>.*?</x:row>' % rid, '', xml,
                         count=1, flags=re.S)

    last_used = max(int(m.group(1)) for m in
                    re.finditer(r'<x:row[^>]*r="(\d+)"', xml))
    if last_used + len(RTM_ROWS) != NEW_RTM_LAST_ROW:
        raise SystemExit(f'expected the new RTM rows to end at {NEW_RTM_LAST_ROW}, '
                         f'but the sheet ends at {last_used}')

    first_new = NEW_RTM_LAST_ROW - len(RTM_ROWS) + 1
    rows = []
    for i, (wbs, reqs, version, task, verification, acceptance) in enumerate(RTM_ROWS):
        rid = first_new + i
        cells = (_cell('A', rid, reqs) + _cell('B', rid, version)
                 + _cell('C', rid, f'{wbs} {task}') + _cell('D', rid, verification)
                 + _cell('E', rid, acceptance))
        rows.append(f'<x:row r="{rid}">' + cells + '</x:row>')
    xml = xml.replace('</x:sheetData>', ''.join(rows) + '</x:sheetData>')
    parts[SHEET6] = xml.encode('utf-8')

    tmp = xlsx_path.with_name(xlsx_path.name + '.tmp')
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for info in infos:
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            zout.writestr(zi, parts[info.filename])
    shutil.copyfile(tmp, xlsx_path)
    tmp.unlink()
    print(f'rtm: added {len(RTM_ROWS)} rows (rows {first_new}..{NEW_RTM_LAST_ROW})')


def verify(xlsx_path):
    with zipfile.ZipFile(Path(xlsx_path)) as z:
        xml = z.read(SHEET6).decode('utf-8')
    for spec in RTM_ROWS:
        rid = find_rtm_row(xml, spec[0])
        assert rid is not None, f'{spec[0]} is missing from the RTM sheet'
        print(f'verify: {spec[0]} rtm row {rid}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--xlsx', default=str(XLSX))
    ap.add_argument('--verify-only', action='store_true')
    args = ap.parse_args()
    if not args.verify_only:
        update(args.xlsx)
    verify(args.xlsx)


if __name__ == '__main__':
    main()
