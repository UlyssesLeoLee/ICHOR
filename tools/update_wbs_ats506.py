"""ATS-506: sync docs/WBS.xlsx with the control-plane API boundary delivery.

Surgical edit of the existing workbook (no openpyxl / no rebuild):
  开发WBS (sheet2), ATS-506 row:
    - 状态 N  -> --status (default 待审核; 进行中 during a rework round)
    - 完成率 O -> 1 when submitted, 0.6 while in progress
    - 剩余人日 P -> cached value K * (1 - O) from the row's own estimate; the
      formula is kept
    - 风险/说明 T -> this script's 【ATS-506】 note; foreign marked notes (the
      ATS-501 updater's downstream constraint) survive
  总览 (sheet1):
    - cached values of B8/B9/B10 derived from the sheet just written
    - narrative cells D6/D7 recomposed from every task's fragment

A row that has already been accepted (已完成 / 已取消) is never downgraded,
and 待审核 is NOT 已完成: the reviewer syncs the accepted state after the
review passes.

    python tools/update_wbs_ats506.py                 # 待审核
    python tools/update_wbs_ats506.py --status 进行中
    python tools/update_wbs_ats506.py --xlsx copy.xlsx  # edit a copy

Every other zip member is rewritten byte-for-byte with its original order and
timestamp. No .bak file is produced: Git is the backup.
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
                        set_narrative_cell, totals)

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'
ATS_ID = 'ATS-506'
MARKER = '【ATS-506】'
STATUSES = ('待审核', '进行中')
TERMINAL_STATUSES = ('已完成', '已取消')
COMPLETION = {'待审核': 1.0, '进行中': 0.6}
NOTE = ('部署式控制面 API（/cp/v1）已与桌面本地 API 分离：独立进程/端点/凭据/REMOTE_ 错误命名空间，'
        '不导入本地模块、不依赖 Tauri；入站拒绝本地绝对路径、以路径或仓库地址代替 UID 与本地会话 Token，'
        '出站再扫描；租户由会话推导、跨租户 404；UT-CP 30 条与进程级 IT-CP 15 条已执行，'
        '证据见 docs/evidence/ATS-506/；用户 OIDC（ATS-507）、持久化与审计查询（ATS-508/509）未实现，'
        '详见 docs/21-CONTROL-PLANE-API.md')


def find_ats_row(xml, ats_id):
    """Return the row number whose A cell is `ats_id`."""
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1))
    raise SystemExit(f'row for {ats_id} not found')


def _number(value):
    """Render a cached numeric value without a trailing '.0'."""
    text = repr(round(value, 6))
    return text[:-2] if text.endswith('.0') else text


def update(xlsx_path, status):
    xlsx_path = Path(xlsx_path)
    with zipfile.ZipFile(xlsx_path) as zin:
        infos = zin.infolist()
        parts = {i.filename: zin.read(i.filename) for i in infos}

    xml2 = parts[SHEET2].decode('utf-8')
    rid = find_ats_row(xml2, ATS_ID)
    if cell_text(xml2, rid, 'N') not in TERMINAL_STATUSES:
        completion = COMPLETION[status]
        xml2 = set_cell_in_row(xml2, rid, 'N', status)
        xml2 = set_cell_in_row(xml2, rid, 'O', _number(completion), numeric=True)
        remaining = cell_number(xml2, rid, 'K') * (1 - completion)
        xml2 = set_cell_in_row(xml2, rid, 'P', _number(remaining), numeric=True)
    xml2 = set_marked_cell(xml2, rid, 'T', MARKER, NOTE)
    parts[SHEET2] = xml2.encode('utf-8')

    xml1 = parts[SHEET1].decode('utf-8')
    derived = totals(parts)
    xml1 = set_cell_in_row(xml1, 8, 'B', str(derived['completed']), numeric=True)
    xml1 = set_cell_in_row(xml1, 9, 'B', format_rate(derived['completion_rate']), numeric=True)
    xml1 = set_cell_in_row(xml1, 10, 'B', repr(int(derived['sum_remaining'])), numeric=True)
    xml1 = set_narrative_cell(xml1, 6, 'D6')
    xml1 = set_narrative_cell(xml1, 7, 'D7')
    parts[SHEET1] = xml1.encode('utf-8')

    tmp = xlsx_path.with_name(xlsx_path.name + '.tmp')
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for info in infos:
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            zout.writestr(zi, parts[info.filename])
    # os.replace() can fail on Windows while the target is held open.
    shutil.copyfile(tmp, xlsx_path)
    tmp.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Sync the ATS-506 row of docs/WBS.xlsx.')
    parser.add_argument('--status', default='待审核', choices=STATUSES,
                        help='状态 of the ATS-506 row (default: 待审核; 进行中 during rework)')
    parser.add_argument('--xlsx', default=str(XLSX), help='workbook to edit (default: docs/WBS.xlsx)')
    args = parser.parse_args(argv)
    update(args.xlsx, args.status)
    print('updated', args.xlsx)
    return 0


if __name__ == '__main__':
    sys.exit(main())
