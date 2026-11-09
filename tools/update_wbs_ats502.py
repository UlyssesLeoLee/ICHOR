"""ATS-502: sync docs/WBS.xlsx with the delivered scheduling core.

Surgical edit of the existing workbook (no openpyxl / no rebuild):
  开发WBS (sheet2):
    - ATS-502 row: 状态 -> 待审核, 完成率 -> 1, 剩余人日 -> formula-driven 0
    - the ATS-502 风险/说明 cell carries this task's scope note
  总览 (sheet1):
    - refresh the cached values of the existing formulas (B8/B9/B10) so a reader
      that does not recalculate still sees the right numbers
    - extend the narrative cells D6/D7 with the scheduling core's status

Every other row, formula, style and the data validation lists stay byte-identical.

NOTE on 状态: the status is set by the `--status` argument and defaults to
待审核 ("pending review"), NOT 已完成. The deliverable is submitted, but it has
not been accepted yet -- the reviewer syncs 已完成 / 完成率 after the review
passes. Declaring it 已完成 before review would contradict "不得自行置 done".

    python tools/update_wbs_ats502.py --status 进行中
    python tools/update_wbs_ats502.py --status 待审核

During a rework round the row is set to 进行中, and it returns to 待审核 when
the rework is submitted for review again. A row that has already been
accepted (已完成 / 已取消) is never downgraded by a re-run.
"""
import argparse
import re
import shutil
import zipfile
from pathlib import Path

from wbs_common import (SHEET1, SHEET2, cell_text, format_rate,
                        set_cell_in_row, set_marked_cell, set_narrative_cell,
                        totals)

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'

MARKER = '【ATS-502】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script.
TERMINAL_STATUSES = ('已完成', '已取消')


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def self_consistent(xml, rid):
    """True when the row's 状态 agrees with its own 完成率 / 剩余人日.

    A row that says 已完成 but carries a completion rate below 1 or a
    non-zero remainder contradicts itself; such a row is a stale artefact,
    not an acceptance, and must not veto this task's status.
    """
    try:
        rate = float(cell_text(xml, rid, 'O') or 0)
        remaining = float(cell_text(xml, rid, 'P') or 0)
    except ValueError:
        return False
    return rate >= 1 and remaining <= 0


def annotate_note(xml, rid, note):
    """Append this script's marked note to cell T<rid>, replacing a previous copy."""
    return set_marked_cell(xml, rid, 'T', MARKER, note)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--status', default='待审核',
        help='the 状态 to write into the ATS-502 row (default: 待审核). '
             'Use 进行中 while a rework round is in flight.')
    args = parser.parse_args()
    status = args.status

    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- ATS-502: 状态 / 完成率 / 剩余人日 -----------------------------------
    rid, _rm = find_ats_row(xml2, 'ATS-502')
    # A re-run must not undo an accepted review -- but only a row that is
    # REALLY accepted.
    #
    # The ATS-502 row arrived on `dev` carrying 状态=已完成 with 完成率=0 and
    # 剩余人日=8: a marker left behind by an unrelated task's commit, and
    # internally contradictory (it claims the work is done while its own
    # completion rate says nothing is done). It is the ONLY such row in the
    # whole workbook, so it is a stale artefact, not an acceptance.
    #
    # The guard therefore only protects a row that is accepted AND
    # self-consistent: 状态=已完成 with 完成率=1 and 剩余人日=0. A 已完成 row
    # that contradicts its own numbers does not get to veto the status this
    # task owns.
    current = cell_text(xml2, rid, 'N')
    if current not in TERMINAL_STATUSES or not self_consistent(xml2, rid):
        # 待审核 and 进行中 are both in the N-column data-validation list.
        xml2 = set_cell_in_row(xml2, rid, 'N', status)
    # 完成率 and 剩余人日 follow the status: a row that is still 进行中 has
    # not delivered everything yet, so its 完成率 is below 1 and its 剩余人日
    # is the honest remainder. A submitted row is complete (完成率 = 1).
    if status == '进行中':
        xml2 = set_cell_in_row(xml2, rid, 'O', '0.6', numeric=True)
        # P keeps its formula K*(1-O) = 8*(1-0.6) = 3.2; only the cached value
        # changes.
        xml2 = set_cell_in_row(xml2, rid, 'P', '3.2', numeric=True)
    else:
        xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
        # P keeps its formula K*(1-O) = 8*(1-1) = 0; only the cached value
        # changes.
        xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # --- annotate this task's scope note -------------------------------------
    # The script is idempotent: a marker identifies the note this script owns,
    # so re-running replaces it instead of appending a second copy.
    notes = {
        'ATS-502': '调度内核已实现于 server/queue.mjs（Job 队列/租约/心跳/幂等键/重试）与 '
                   'server/scheduler.mjs（部署式调度服务，与本地 Bridge 分离，端口 4580）：'
                   '断连重投不双跑（作业任一时刻至多一个活跃租约，租约过期退回队列并开启新 attempt；'
                   'ack/heartbeat/result 必须回带 leaseId 作租约 fencing，旧 attempt 不得再回写终态）、'
                   '心跳超时可恢复（leased 与 running 同走一条回收路径：sweep/releaseNode/lease 均回收，'
                   '超时拒 REMOTE_LEASE_EXPIRED 并退回队列或按 deadline 记 interrupted；'
                   '租约时长由服务端定上限 MAX_LEASE_MS=5 分钟，客户端不可自选超长租约）、'
                   '重放结果幂等（dispatch/ack/result/cancel 必填幂等键，同键同体同租约返回首次结果、'
                   '同键异体拒 REMOTE_IDEMPOTENCY_CONFLICT、首次失败重放返回同一个失败、终态只写一次）；'
                   '租户隔离在读路径由节点上下文推导（无节点上下文即 403），控制平面写路径需凭据；'
                   '拒绝码表与 ATS-501 冻结契约逐项一致，'
                   '第 1 轮复核反例 P1~P8/H1~H5 在被驳回树上 13/13 命中、修复后 0/13，'
                   '证据见 docs/evidence/ATS-502/ 与 docs/29-REMOTE-SCHEDULING.md',
    }
    for ats, note in notes.items():
        rid, _rm = find_ats_row(xml2, ats)
        xml2 = annotate_note(xml2, rid, note)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh cached formula results + the two narrative cells ------
    # The cached values are DERIVED from the sheet that was just written, not
    # hardcoded: a hardcoded cache is stale as soon as another script changes
    # a row, and the 总览 would then silently disagree with the 开发WBS.
    xml1 = parts[SHEET1].decode('utf-8')
    derived = totals(parts)
    xml1 = set_cell_in_row(xml1, 8, 'B', str(derived['completed']), numeric=True)
    xml1 = set_cell_in_row(
        xml1, 9, 'B', format_rate(derived['completion_rate']), numeric=True)
    xml1 = set_cell_in_row(
        xml1, 10, 'B', repr(int(derived['sum_remaining'])), numeric=True)
    # The two narrative cells are shared with every other WBS updater. Each
    # task contributes one marked fragment and the cell is the composition of
    # all of them, so this script can no longer erase another task's text.
    xml1 = set_narrative_cell(xml1, 6, 'D6')
    xml1 = set_narrative_cell(xml1, 7, 'D7')
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
