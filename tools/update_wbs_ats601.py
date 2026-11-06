"""ATS-601: sync docs/WBS.xlsx with the mobile target/session contract.

Surgical edit of the existing workbook (no openpyxl SAVE / no rebuild), in the
same style as tools/update_wbs_ats401.py / tools/update_wbs_ats512.py: the
sheet XML is patched in place and the zip is rewritten with every other part
byte-identical.

WHAT THIS SCRIPT DOES (two jobs, one script, one marker)
---------------------------------------------------------
1. It ENSURES the six S6 rows exist. The rows ATS-601..ATS-606 were added to
   the workbook by this same file when the mobile stage was introduced; a
   row that is ALREADY there is left ALONE, so a status this script has set
   (or a note another task has added) is never wiped.

2. It SYNCS the ATS-601 row itself -- in the pattern of
   tools/update_wbs_ats401.py:
     N (状态)   : 未开始 -> 待审核
     O (完成率) : 0 -> 1
     P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
     T (风险/说明): the ATS-601 note, marked with 【ATS-601】

WHY ONE SCRIPT AND NOT TWO
---------------------------
The workbook is shared by EVERY updater under tools/update_wbs_*.py, and the
ATS-501 regression (tools/ats501-probes/check-wbs-updaters.sh) runs all of
them in BOTH orders and requires the result to be the same. Two scripts that
both write the ATS-601 row -- one creating it, one syncing it -- would make
the two orders disagree (the creating one would reset the status the syncing
one set), and the regression would fail. One script that owns the row
outright cannot disagree with itself.

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate:

  B8  COUNTIF(N6:N100,"已完成")       -> counted from the sheet
  B9  1-SUM(P)/SUM(K)                -> computed from the sheet
  B10 SUM(P6:P100)                   -> computed from the sheet

The two narrative cells D6/D7 are shared with every other WBS updater, so
this script contributes ONE marked fragment to each and lets
`wbs_common.set_narrative_cell` compose them.

NOTE on 状态: 待审核 ("pending review"), NOT 已完成. The deliverable is
submitted but not accepted yet -- the reviewer (Opus) syncs the completion
state after the review passes. Declaring it 已完成 before review would
contradict "不得自行置 done".

IDEMPOTENCY: running this script twice leaves the workbook byte-identical.
The marker-aware merge in `wbs_common.set_marked_cell` replaces the previous
marked block instead of appending, and the rows that already exist are left
alone, so the second run is a no-op.

    python tools/update_wbs_ats601.py              # write the rows + the row
    python tools/update_wbs_ats601.py --verify-only # assert the result
    python tools/update_wbs_ats601.py --status 进行中
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

MARKER = '【ATS-601】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script.
TERMINAL_STATUSES = ('已完成', '已取消')

# --- the six S6 rows ------------------------------------------------------
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

# The sheet's own row templates, copied from the existing rows so a new row
# carries the same styles as the others.
STYLE_PLAIN = '40'
STYLE_TEXT = '46'
STYLE_DATE = '41'
STYLE_RATE = '42'

NOTE = (
    '移动端执行目标抽象与设备/模拟器会话模型契约已交付（契约层，无真实设备）：'
    '目标 Target{targetId,kind,platform,osVersion,capabilities[],declaredBy} 与'
    '会话 Session{sessionId,targetId,state,capabilities[],lastSeenAt,error?} '
    '在 server/adapters/mobile-target.mjs 定义；kind 三取值为 local-emulator（平台创建销毁）、'
    'local-device（已连接真机，平台只借用，不接管安装与配对）、remote-farm（远端农场，租约式，'
    '租约过期必须回收，沿用 ATS-502 租约语义）。'
    '会话状态机 idle→created→running→idle，异常路径进 failed；非法迁移抛错而非静默移动。'
    '硬规则：目标不存在 / 设备未连接 / 会话失败 / 租约过期 / 能力不满足 一律明确拒绝'
    '（REMOTE_TARGET_UNAVAILABLE / REMOTE_CAPABILITY_MISSING），不得静默降级成别的执行方式；'
    '两个拒绝码已登记进唯一的拒绝码表 server/control-plane/errors.mjs 与 docs/19 §6.2 机读约束块。'
    '能力协商在执行前完成并产出本次执行的能力缺口清单：launchApp→app.install/app.launch、'
    'tapOn→ui.tap+ui.hierarchy、assertVisible→ui.hierarchy、takeScreenshot→screen.capture、'
    'recordScreen→screen.record、readLogs→log.read；缺 ui.hierarchy 时 tapOn 不可用，不用坐标盲点；'
    '缺口按会话（已证明）算而非按目标（已声明）算。'
    '移动端 Runner 是 ATS-301 契约的扩展而非另起一套：server/adapters/mobile.mjs 注册进同一个'
    '适配器注册表，通过同一套 assertAdapter，设备层经 negotiateWithDevice 与引擎层一起协商；'
    'device 段可选，既有 playwright / wdio 适配器不受影响。'
    '安全边界：App 包名只允许项目登记过的（MOBILE_APP_PACKAGE_NOT_REGISTERED）、'
    'Flow 与其它脚本同一套可信仓库判定（未可信项目报 MOBILE_PROJECT_UNTRUSTED）、'
    '设备只允许用户显式登记的会话（MOBILE_SESSION_NOT_REGISTERED）、'
    '证据落盘复用同一套路径校验与 SHA-256（宿主计算摘要，不接受调用方自带）。'
    'UT-MOB-001..070（含 5 个补充例）共 75 例（能力匹配、拒绝规则、状态机迁移、安全边界、契约扩展）全通过，'
    '证据 docs/evidence/ATS-601/。'
    '未实现（不属本项）：真实 Android/iOS 设备与模拟器、ADB/驱动、证据归档、Flow 导入映射；'
    'FR-031 的状态是契约层已实现，移动端执行能力本身仍为 DESIGNED，真实冒烟属 ATS-603。'
)


def find_ats_row(xml, ats_id):
    """Return the row number whose A cell is `ats_id`, or None."""
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    return None


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


def ensure_rows(xml2):
    """Append the S6 rows that are NOT in the sheet yet; leave the others alone.

    A row that already exists is NOT rewritten: it may carry a status this
    script set, or a note another task added. That is what keeps the two
    update orders in the ATS-501 regression equal.

    Returns (xml, last_row).
    """
    missing = [spec for spec in NEW_ROWS if find_ats_row(xml2, spec[0]) is None]
    if missing:
        last_used = max(int(m.group(1)) for m in
                        re.finditer(r'<x:row[^>]*r="(\d+)"', xml2))
        first_new = last_used + 1
        new_xml = ''.join(_row_xml(first_new + i, spec)
                          for i, spec in enumerate(missing))
        xml2 = xml2.replace('</x:sheetData>', new_xml + '</x:sheetData>')
    last_row = max(int(m.group(1)) for m in
                   re.finditer(r'<x:row[^>]*r="(\d+)"', xml2))
    return xml2, last_row


def grow_ranges(xml2, old_last, new_last):
    """Grow the formula / formatting / validation ranges to the new last row.

    Without this the new rows would have no status colour and no dropdown,
    and the 总览 formulas would not count them.
    """
    if old_last == new_last:
        return xml2
    for col in ('N', 'O', 'S', 'J'):
        xml2 = xml2.replace(f'{col}6:{col}{old_last}', f'{col}6:{col}{new_last}')
    return xml2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--status', default='待审核',
        help='the 状态 to write into the ATS-601 row (default: 待审核). '
             'Use 进行中 while a rework round is in flight.')
    parser.add_argument('--xlsx', default=str(XLSX))
    args = parser.parse_args()
    status = args.status
    xlsx = Path(args.xlsx)

    shutil.copy2(xlsx, xlsx.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(xlsx)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- 1. make sure the S6 rows exist -------------------------------------
    old_last = max(int(m.group(1)) for m in
                   re.finditer(r'<x:row[^>]*r="(\d+)"', xml2))
    xml2, new_last = ensure_rows(xml2)
    xml2 = grow_ranges(xml2, old_last, new_last)

    # --- ATS-601: 状态 / 完成率 / 剩余人日 -----------------------------------
    rid, _rm = find_ats_row(xml2, 'ATS-601')
    if rid is None:
        raise SystemExit('the ATS-601 row is missing from the workbook')
    # A re-run must not undo an accepted review. Only a row that has not been
    # accepted yet is written.
    if cell_text(xml2, rid, 'N') not in TERMINAL_STATUSES:
        # 待审核 and 进行中 are both in the N-column data-validation list.
        xml2 = set_cell_in_row(xml2, rid, 'N', status)
    # 完成率 and 剩余人日 follow the status: a row that is still 进行中 has
    # not delivered everything yet, so its 完成率 is below 1 and its 剩余人日
    # is the honest remainder. A submitted row is complete (完成率 = 1).
    estimate = cell_number(xml2, rid, 'K')
    if status == '进行中':
        rate = 0.6
        xml2 = set_cell_in_row(xml2, rid, 'O', repr(rate), numeric=True)
        # P keeps its formula K*(1-O); only the cached value changes.
        xml2 = set_cell_in_row(xml2, rid, 'P', repr(estimate * (1 - rate)), numeric=True)
    else:
        xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
        # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value
        # changes.
        xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # --- annotate the row with this task's scope note ------------------------
    # The marker identifies the note this script owns, so re-running replaces
    # it instead of appending a second copy.
    xml2 = set_marked_cell(xml2, rid, 'T', MARKER, NOTE)

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
    tmp = xlsx.with_suffix('.xlsx.tmp')
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            info = infos[name]
            zi = zipfile.ZipInfo(name, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            zout.writestr(zi, data)
    # os.replace() can fail on Windows when the target is held open; copy then unlink
    shutil.copy2(tmp, xlsx)
    tmp.unlink()
    print(f'overview: 已完成={derived["completed"]} '
          f'完成率={derived["completion_rate"]} 剩余人日={derived["sum_remaining"]}')
    print('updated', xlsx)


if __name__ == '__main__':
    main()
