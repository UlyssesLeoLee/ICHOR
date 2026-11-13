"""ATS-606: sync docs/WBS.xlsx with the iOS / Maestro compatibility boundary.

Surgical edit of the existing workbook (no openpyxl SAVE / no rebuild), in the
same style as tools/update_wbs_ats602.py / tools/update_wbs_ats601.py: the
sheet XML is patched in place and the zip is rewritten with every other part
byte-identical.

WHAT THIS SCRIPT DOES
----------------------
It syncs the ATS-606 row of the 开发WBS sheet:
    N (状态)   : 未开始 -> 待审核
    O (完成率) : 0 -> 1
    P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
    T (风险/说明): the ATS-606 note, marked with 【ATS-606】

The six S6 rows already exist -- tools/update_wbs_ats601.py wrote them when
the mobile stage was introduced -- so this script does NOT create rows. It
owns the ATS-606 row and nothing else: a row that another task's script
wrote is left alone. That is what keeps the ATS-501 regression (every
tools/update_wbs_*.py run in BOTH orders must agree) true.

NOTE on 状态: 待审核 ("pending review"), NOT 已完成. The deliverable is
submitted but not accepted yet -- the reviewer (Opus) syncs the completion
state after the review passes. Declaring it 已完成 before review would
contradict "不得自行置 done".

IDEMPOTENCY: running this script twice leaves the workbook byte-identical.
The marker-aware merge in `wbs_common.set_marked_cell` replaces the previous
marked block instead of appending, and a row that is already 已完成 is not
downgraded, so the second run is a no-op.

    python tools/update_wbs_ats606.py              # write the row
    python tools/update_wbs_ats606.py --verify-only # assert the result
    python tools/update_wbs_ats606.py --status 进行中
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

MARKER = '【ATS-606】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script.
TERMINAL_STATUSES = ('已完成', '已取消')

# The note of the ATS-606 row. It says WHAT was delivered and WHAT was not:
# the boundary tables are frozen and machine-checkable; NO iOS behaviour was
# measured, because this host has no iOS environment at all.
NOTE = (
    'iOS 真机路径与 Maestro 兼容性边界已交付（设计与边界冻结，无 iOS 实测）：'
    '交付 docs/25-MOBILE-APP-TESTING.md §8 的三张表——'
    '§8.4 iOS 支持范围表（逐类步骤在 iOS 模拟器/真机上的**Maestro 实现状态**与依据，'
    '含真机路径的三条硬前提）、'
    '§8.5 Maestro Flow 语法兼容性判定表（逐条命令的可映射/部分可映射/不映射，'
    '并逐条给出 ATS-602 导入器对 Maestro 原拼写的实际处理与参数保真）、'
    '§8.6 不承诺清单（15 项需人工完成或另立任务）。'
    '判定依据两侧都有可机读复核的来源：Maestro 侧用本机 Maestro CLI 2.12.1——'
    '命令清单由行为确认（对每条候选命令跑 maestro check-syntax，看 Maestro 自己认不认；'
    '含两个负控证明该检查能区分真命令与拼写错误），'
    '每条命令的参数清单由字节码读出（maestro-orchestra.jar 的 Yaml* 类），'
    'iOS 两条路径的实现状态由字节码确认（LocalIOSDevice 把操作分给 XCTest 驱动与 '
    'deviceController，后者模拟器上是 simctl、真机上是 devicectl，实现状态不同）；'
    '本平台侧用 ATS-601 冻结的六类步骤与七项能力、ATS-602 冻结的语义拼写表与参数表。'
    '判定结论：Maestro 2.12.1 的 55 条命令中，可映射 6 条、部分可映射 2 条、不映射 47 条；'
    '**导入器对 Maestro 原拼写实跑的结果是映射成功 4 条、进导入报告 51 条**'
    '（语义能表达不等于拼写被接受，差异在 assertNotVisible 与 extendedWaitUntil 两条；'
    'startRecording / stopRecording 的拼写同样不被接受，但它们差在命令形态上——配对 vs 单步，'
    '动作本平台能表达，表达不出来的是「开始/结束」这对边界）。'
    '分组口径只有一套（docs/25 §8.3）：只看语义能不能表达与命令形态对不对；'
    '拼写、参数保真、等待语义各有各的列，不参与分组。'
    '**分组是由 Maestro 字节码推导的**（tools/ats606-probes/maestro-action-model.mjs：'
    '每条命令编译成的 orchestra 命令类与变体由 YamlFluentCommand 的字节码读出，'
    '再经 ACTION_PLATFORM 一张小表推出判定），不是逐条手写的。'
    '§8.5 的表由 tools/ats606-probes/gen-section-rows.mjs 生成，'
    '其中导入器行为、参数保真、计数三列都是测量的结果，'
    '参数保真一列还逐个点名每个参数落在哪一种结果里；'
    '复核脚本 tools/ats606-probes/（probe-maestro-compat.mjs 把 §8.5 整块（三个组标题+55 行+TALLY）'
    '与生成器输出逐字比对，独立检查分组不变量，'
    '并把每一行的分组从字节码重新推导后与文档比对；'
    '负控自检含「把某一行挪到别的组并同步改掉全部计数」，该负控必须变红；'
    'probe-group-mutants.mjs 是交付的负控台架，M1–M8 逐条必须变红'
    '（含把 extendedWaitUntil 挪进「不映射」——只有字节码推导能抓住它）；'
    'probe-ios-driver-support.mjs 从字节码复核 §8.4 的每条 iOS 结论与'
    '七项 capability 表，把三条硬前提逐条核到产物上（字节码里真有那条 '
    'Apple team ID 报错与 MissingAppleTeamId、真有 xcrun/devicectl 序列、'
    '设备侧 XCTestHTTPServer.swift 真绑 127.0.0.1:22087 且没有任何 jar 带 '
    'iproxy/usbmux 端口转发），并逐个 jar 列表核对两个设备侧构建产物的出处），'
    '证据 docs/evidence/ATS-606/。'
    '本平台**不实现** Maestro Flow 语法兼容层，这是设计选择（docs/25 §1.2），不是缺陷。'
    'iOS 侧结论（**以 Maestro 2.12.1 为参照的可行性，不是本平台的承诺**）：'
    '六类步骤在模拟器上 Maestro 均已实现；真机路径按能力分层——'
    'UI 交互（点按/断言/截图）走 XCUITest 驱动、宿主侧代码同源；'
    '而 App 启动、录屏、状态重置走 deviceController，真机侧未实现（9 个操作中 8 个是 '
    'NotImplementedError），故真机上不可行；真机路径另有三条硬前提'
    '（需 Apple team ID 签名构建 driver-iphoneos、runner 经 devicectl 装到设备、'
    '宿主到设备的 127.0.0.1:22087 可达性未验证），'
    '且与 §3.1 的 local-device 契约冲突（平台不接管真机安装与配对）。'
    '另记两条 iOS 硬事实：back 是空操作（iOS 无返回键），飞行模式在 iOS 上不生效（驱动只打一条 warn）。'
    '未验证：本机无 macOS/Xcode/模拟器/真机，'
    '没有任何一条 iOS 行为被实测过；'
    '本节写的是「以 Maestro 2.12.1 为参照应当如何」，不是「已经跑通了」；'
    '**本平台没有 iOS Runner**，iOS 真实执行按 §2.2 属本阶段 OUT。'
    'FR-035 的状态是判定与边界已冻结，iOS 执行能力本身仍为 DESIGNED。'
)


def find_ats_row(xml, ats_id):
    """Return the row number whose A cell is `ats_id`, or None."""
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--status', default='待审核',
        help='the 状态 to write into the ATS-606 row (default: 待审核). '
             'Use 进行中 while a rework round is in flight.')
    parser.add_argument('--verify-only', action='store_true',
                        help='assert the result instead of writing it')
    parser.add_argument('--xlsx', default=str(XLSX))
    args = parser.parse_args()
    status = args.status
    xlsx = Path(args.xlsx)

    if args.verify_only:
        zin = zipfile.ZipFile(xlsx)
        parts = {n: zin.read(n) for n in zin.namelist()}
        zin.close()
        xml2 = parts[SHEET2].decode('utf-8')
        rid, _rm = find_ats_row(xml2, 'ATS-606')
        if rid is None:
            raise SystemExit('the ATS-606 row is missing from the workbook')
        note = cell_text(xml2, rid, 'T')
        problems = []
        if cell_text(xml2, rid, 'N') != status:
            problems.append(f'N is {cell_text(xml2, rid, "N")!r}, expected {status!r}')
        if cell_number(xml2, rid, 'O') != 1:
            problems.append(f'O is {cell_number(xml2, rid, "O")!r}, expected 1')
        if cell_number(xml2, rid, 'P') != 0:
            problems.append(f'P is {cell_number(xml2, rid, "P")!r}, expected 0')
        if note.count(MARKER) != 1:
            problems.append(f'T carries the marker {note.count(MARKER)} times, expected 1')
        if '未验证' not in note:
            problems.append('T does not say what was NOT verified')
        if problems:
            for p in problems:
                print(f'FAIL {p}')
            raise SystemExit(1)
        print(f'PASS the ATS-606 row is {status}, 完成率=1, 剩余人日=0, note marker x1')
        return

    shutil.copy2(xlsx, xlsx.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(xlsx)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- the ATS-606 row: 状态 / 完成率 / 剩余人日 -------------------------
    rid, _rm = find_ats_row(xml2, 'ATS-606')
    if rid is None:
        raise SystemExit('the ATS-606 row is missing from the workbook')
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
