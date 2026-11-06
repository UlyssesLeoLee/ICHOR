"""ATS-207: sync docs/WBS.xlsx with the single-instance lock and crash recovery.

Surgical edit of the existing workbook (no openpyxl save / no rebuild), in the
pattern of tools/update_wbs_ats401.py and tools/update_wbs_ats506.py:
  开发WBS (sheet2), ATS-207 row:
    - 状态 N  -> --status (default 待审核; 进行中 during a rework round)
    - 完成率 O -> 1 when submitted, 0.6 while in progress
    - 剩余人日 P -> cached value K * (1 - O) from the row's own estimate; the
      formula is kept
    - 风险/说明 T -> this script's 【ATS-207】 note; foreign marked notes survive
  总览 (sheet1):
    - cached values of B8/B9/B10 derived from the sheet just written
    - narrative cells D6/D7 recomposed from every task's fragment

A row that has already been accepted (已完成 / 已取消) is never downgraded,
and 待审核 is NOT 已完成: the reviewer syncs the accepted state after the
review passes.

    python tools/update_wbs_ats207.py                   # 待审核
    python tools/update_wbs_ats207.py --status 进行中
    python tools/update_wbs_ats207.py --xlsx copy.xlsx  # edit a copy

The note is XML-escaped by wbs_common, so the workbook stays parseable. Every
other zip member is rewritten byte-for-byte with its original order and
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
ATS_ID = 'ATS-207'
MARKER = '【ATS-207】'
STATUSES = ('待审核', '进行中')
TERMINAL_STATUSES = ('已完成', '已取消')
COMPLETION = {'待审核': 1.0, '进行中': 0.6}
NOTE = ('数据目录单实例锁与崩溃恢复已实现：bridge.lock 以「完整记录写私有临时文件后硬链接发布」原子抢占，'
        '同一时刻多个进程恰一个成功（改动前的实现 6 个并发进程 6 个都「抢到」，竞态探针实测），'
        '陈旧锁先改名再比对字节后接管、绝不删除活持有者的锁；锁记录带 token，Bridge 周期校验仍持有锁，'
        '锁被删则重取、被他人占用则退出；第二个 Bridge 以退出码 1 拒绝并报持有者 pid，'
        'ATS_LOCK_WAIT_MS 可等待锁空出；state.json 每进程临时文件、fsync 后改名，'
        '损坏的状态文件报 STATE_CORRUPT 并拒绝启动且不改写；SQLite 镜像启动时 quick_check，'
        '损坏则连同 -wal/-shm 隔离并由 state.json 重建；崩溃中的 run 恢复为 interrupted（ATS-208 的日志驱动恢复）；'
        'UT 24 条（tests/instance-lock.test.mjs）、真实 Bridge 进程 IT 10 条（tests/instance-lock-it.test.mjs）、'
        '真实 Chromium 的 ST-017/025/026（tools/ats207-probes/st-ats207.mjs，18/18）已执行，'
        '证据见 docs/evidence/ATS-207/；断电以强杀进程模拟，未做真实掉电；'
        '桌面壳不显示「已占用」提示且未实测（本机无 Rust/Tauri 工具链）；详见 docs/06-DATA-DESIGN.md §5.7')


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
    parser = argparse.ArgumentParser(description='Sync the ATS-207 row of docs/WBS.xlsx.')
    parser.add_argument('--status', default='待审核', choices=STATUSES,
                        help='状态 of the ATS-207 row (default: 待审核; 进行中 during rework)')
    parser.add_argument('--xlsx', default=str(XLSX), help='workbook to edit (default: docs/WBS.xlsx)')
    args = parser.parse_args(argv)
    update(args.xlsx, args.status)
    print('updated', args.xlsx)
    return 0


if __name__ == '__main__':
    sys.exit(main())
