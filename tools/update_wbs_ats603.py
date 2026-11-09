"""ATS-603: sync docs/WBS.xlsx with the Android runner.

Surgical edit of the existing workbook (no openpyxl SAVE / no rebuild), in the
same style as tools/update_wbs_ats602.py / tools/update_wbs_ats601.py: the
sheet XML is patched in place and the zip is rewritten with every other part
byte-identical.

WHAT THIS SCRIPT DOES
----------------------
It syncs the ATS-603 row of the 开发WBS sheet:
    N (状态)   : 未开始 -> 待审核
    O (完成率) : 0 -> 1
    P (剩余人日): cached value 8 -> 0 (the formula K*(1-O) is kept)
    T (风险/说明): the ATS-603 note, marked with 【ATS-603】

The six S6 rows already exist -- tools/update_wbs_ats601.py wrote them when
the mobile stage was introduced -- so this script does NOT create rows. It
owns the ATS-603 row and nothing else: a row that another task's script
wrote is left alone.

WHY THE SCRIPT IS NOT A COPY OF THE ATS-602 ONE
-----------------------------------------------
The ATS-501 regression (tools/ats501-probes/check-wbs-updaters.sh) runs
every tools/update_wbs_*.py in BOTH orders and requires the result to be
the same. Two scripts that both wrote the SAME row would disagree with each
other in one of the two orders. So this script writes the ATS-603 row and
the ATS-602 script writes the ATS-602 row, and each owns exactly one.

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other
rows already carry a non-zero completion rate:

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
marked block instead of appending, and a row that is already 已完成 is not
downgraded, so the second run is a no-op.

    python tools/update_wbs_ats603.py              # write the row
    python tools/update_wbs_ats603.py --verify-only # assert the result
    python tools/update_wbs_ats603.py --status 进行中
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

MARKER = '【ATS-603】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script.
TERMINAL_STATUSES = ('已完成', '已取消')

# The note of the ATS-603 row. It says WHAT was delivered and WHAT was not:
# the Android driver is implemented and MEASURED on a real emulator; the
# evidence archiving into the unified model is NOT (that is ATS-604), and
# iOS is NOT (that is ATS-606).
NOTE = (
    'Android 模拟器 Runner 原型与真实设备冒烟已交付（在真实模拟器上实测）：'
    'Android Runner 适配器与驱动在 server/adapters/ 下新增四个模块——'
    'android-adb.mjs（唯一的 ADB 传输层，只以参数向量调用 adb，绝不拼接 shell 字符串）、'
    'android-hierarchy.mjs（视图层级树解析器，无 XML 依赖，读不到尾即报错而非读一半）、'
    'android-runner.mjs（步骤语义与失败分类）、'
    'android-adapter.mjs（ATS-301 适配器实现，kind=android，'
    '与 ATS-601 的契约骨架 kind=mobile 并列注册，互不覆盖）。'
    '步骤词表沿用 ATS-601 冻结的六类（launchApp / tapOn / assertVisible / '
    'takeScreenshot / recordScreen / readLogs），参数沿用 ATS-602 的映射'
    '（appId / text / id / name / path），能力要求直接读 ATS-601 的表，'
    '因此 Runner 不另立一套语义。'
    '失败分类是本项的核心（docs/25 §5.3）：会话掉线 / 元素找不到 / 断言不成立 / 驱动报错'
    '四类互相区分，不允许笼统的「执行失败」；元素找不到时失败信息带上当屏的视图层级树，'
    '断言不成立时点名元素，驱动报错时带上设备 stderr。'
    '能力协商在第一步之前完成：缺 ui.hierarchy 时 tapOn 不可用，不会退化成盲点坐标。'
    'App 包名只允许项目登记过的，未登记的按「拒绝」处理且不触碰设备。'
    '截图经 exec-out 取二进制 PNG，校验 PNG 签名与像素尺寸后落盘，'
    '并按 ATS-604 的证据模型产出记录（本项只落盘与产出记录，归档属 ATS-604）。'
    '真实设备冒烟：本机 Android SDK（API 35 镜像 Pixel_6_API_35，WHPX 加速可用）上，'
    '夹具 App（com.ichor.smoke，由 tools/ats603-probes/build-smoke-app.sh 用 SDK 自带 '
    'aapt2/javac/d8/zipalign/apksigner 构建，无需 Gradle、无需联网）实测通过：'
    'UT-ATS603-001..047 共 31 例（失败分类、能力协商、层级解析、安全边界、瞬时故障重试）、'
    'UT-ATS603-050..065 共 12 例（注册表、能力矩阵、设备层、运行生命周期与 Bridge 句柄形状），'
    'IT-ATS603-001..022 共 9 例在真实模拟器上实测通过'
    '（设备探针证明 6 项能力、launchApp 进前台、tapOn 点中后屏幕改变、'
    'assertVisible 失败时点名元素、takeScreenshot 得到 1080x2400 的 PNG、'
    '整条 Flow 五步全通过、元素找不到与未登记包名各自归类），'
    'IT-ATS603-030..031 共 2 例走真实 Bridge（HTTP）：'
    '移动端用例与 Web 用例进入同一目录、协商选中 android runner、'
    '运行经完整生命周期落到终态并带回统一结果模型的 summary；'
    '证据 docs/evidence/ATS-603/。'
    '未实现（不属本项）：移动端证据归档进统一 Evidence 模型与跨引擎统一查询（ATS-604）、'
    '多目标能力矩阵与环境依赖声明（ATS-605）、iOS 路径与 Maestro 兼容性判定（ATS-606）、'
    '远端设备农场（ATS-502/504）；'
    '录屏与设备日志已实现为驱动能力，但统一归档仍待 ATS-604。'
    '本机无 iOS 环境、无 Android 真机连接，iOS 与真机路径本项未实测。'
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
        help='the 状态 to write into the ATS-603 row (default: 待审核). '
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
        rid, _rm = find_ats_row(xml2, 'ATS-603')
        if rid is None:
            raise SystemExit('the ATS-603 row is missing from the workbook')
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
        if '未实现' not in note:
            problems.append('T does not say what is NOT implemented')
        if problems:
            for p in problems:
                print(f'FAIL {p}')
            raise SystemExit(1)
        print(f'PASS the ATS-603 row is {status}, 完成率=1, 剩余人日=0, note marker x1')
        return

    shutil.copy2(xlsx, xlsx.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(xlsx)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- the ATS-603 row: 状态 / 完成率 / 剩余人日 -------------------------
    rid, _rm = find_ats_row(xml2, 'ATS-603')
    if rid is None:
        raise SystemExit('the ATS-603 row is missing from the workbook')
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
        # P keeps its formula K*(1-O) = 8*(1-1) = 0; only the cached value
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
