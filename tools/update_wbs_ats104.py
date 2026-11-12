"""ATS-104: sync docs/WBS.xlsx 「开发WBS」row for ATS-104.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats214.py: the sheet XML is patched in place and the
zip is rewritten with every other part byte-identical.

ATS-104 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 4 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): append the ATS-104 note

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate:

  B8  COUNTIF(N6:N94,"已完成")       -> counted from the sheet
  B9  1-SUM(P)/SUM(K)                -> computed from the sheet
  B10 SUM(P6:P94)                    -> computed from the sheet

XML ESCAPING (this is load-bearing, not cosmetic)
-----------------------------------------------
The cell values are written into `<x:v>` elements. A note that contains `<`,
`>` or `&` written RAW into `xl/worksheets/sheet2.xml` makes the workbook
UNPARSEABLE. The escaping is done by `wbs_common.set_marked_cell` /
`wbs_common.set_cell_in_row`, which apply the XML spec's own entity set
(&, <, >) to every value before it goes into the cell.

NOTE on 状态: ATS-104 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is submitted, but it has not been accepted yet -- the reviewer
(Opus) syncs 已完成/完成率 after the review passes. Declaring it 已完成
before review would contradict "不得自行置 done".

NOTE on re-runs after acceptance: the review is a one-way door. Once the
reviewer has returned PASS and the row carries 已完成, re-running this script
must NOT walk that row back to 待审核 -- the same guard the other updaters
carry. The guard protects a row that is accepted AND self-consistent
(状态=已完成 with 完成率=1 and 剩余人日=0); a 已完成 row that contradicts its
own numbers is a stale artefact, not an acceptance, and does not get to veto
the status this task owns.

IDEMPOTENCY: running this script twice must leave row ATS-104 byte-identical.
The marker-aware merge in `wbs_common.set_marked_cell` replaces the previous
marked block instead of appending, so the second run is a no-op. `verify()`
asserts that.
"""
import argparse
import re
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wbs_common import (SHEET1, SHEET2, cell_text,  # noqa: E402
                        format_rate, set_cell_in_row, set_marked_cell,
                        set_narrative_cell, totals)

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'

MARKER = '【ATS-104】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script: the review is a one-way door.
TERMINAL_STATUSES = ('已完成', '已取消')

# The status the reviewer (Opus) writes after a PASS. It is one of the six
# values in the N-column data-validation list.
STATUS_DONE = '已完成'

NOTE = (
    '【ATS-104】Tauri 2 Windows dev build 与 WebView2 适配已在 Windows 实机跑通：'
    'cargo tauri dev 起桌面壳，WebView2 加载 Next 开发服务器页面，壳拉起的 Bridge '
    '在回环端口应答 GET /api/health 200，'
    '关窗（向主窗口发 WM_CLOSE，与用户点 X 同一条路径）后进程树里无残留进程、端口可重新绑定。'
    '构建侧修掉两个真实缺陷：'
    '(1) 仓库补齐 src-tauri/icons/icon.ico（tauri-build 对任何 windows target 都需要 PE 资源图标，'
    '缺它全新 clone 必然构建失败）；'
    '(2) src-tauri/Cargo.toml 的 crate-type 去掉 cdylib（gnu 链的 cdylib 把整棵依赖树的符号写进 '
    'PE 导出表，导出序号超过 65535 上限，链接报 export ordinal too large: 91017；'
    '本仓库无人消费该 cdylib 产物，staticlib+rlib 不带 PE 导出表故不受该限制）。'
    '运行侧修掉一个真实缺陷：'
    '壳原先只在 Drop 里杀 Bridge 子进程，而 Windows 的窗口事件循环以 std::process::exit 收尾，'
    '该路径不运行任何析构函数，Drop 永不触发，'
    '实测关窗后 node 子进程存活、端口仍被占（探针报 RESULT: FAIL）；'
    '现改为在 Tauri RunEvent::Exit（窗口事件循环销毁前投递）显式结束 Bridge 并等待其退出。'
    '验收口径：以 cargo build（含最终链接）为准，不以 cargo check 为准；'
    'msvc 链最终链接仍未在本机验证（本机无 MSVC C++ 构建工具工作负载），'
    '本项结论建立在 gnu 链（stable-x86_64-pc-windows-gnu + MSYS2 MinGW GCC）实机结果上。'
    '复现脚本 tools/ats104-probes/collect-evidence.sh，'
    '探针 tools/ats104-probes/st-ats104.mjs（含负控：对不结束 Bridge 的产品副本必须报 FAIL），'
    '证据 docs/evidence/ATS-104/。'
    '未验证项：msvc 链的最终链接、macOS/Linux 的 Tauri 壳、'
    'Bridge 的 node 不可用时 spawn().ok() 静默失败（属 ATS-105）。'
)


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def self_consistent(xml, rid):
    """True when the row's 状态 agrees with its own 完成率 / 剩余人日.

    A row that says 已完成 but carries a completion rate below 1 or a
    non-zero remainder contradicts itself; such a row is a stale artefact,
    not an acceptance, and must not veto the status this task owns.
    """
    try:
        rate = float(cell_text(xml, rid, 'O') or 0)
        remaining = float(cell_text(xml, rid, 'P') or 0)
    except ValueError:
        return False
    return rate >= 1 and remaining <= 0


def patch_workbook(status='待审核'):
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-104')
    # A re-run must not undo an accepted review: only a row that has not been
    # accepted yet is (re)written. An accepted row keeps its status, and the
    # notes and the cached 总览 values are still refreshed below.
    current = cell_text(xml2, rid, 'N')
    if current not in TERMINAL_STATUSES or not self_consistent(xml2, rid):
        # 待审核 and 已完成 are both in the N-column data-validation list.
        xml2 = set_cell_in_row(xml2, rid, 'N', status)
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 4*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-104 note, replacing a previous copy of it.
    # The marker-aware merge keeps every other task's marked block in the
    # same cell and re-emits the blocks in canonical order, so the result
    # does not depend on which updater ran last. The note text is
    # XML-ESCAPED by `set_marked_cell`.
    xml2 = set_marked_cell(xml2, rid, 'T', MARKER, NOTE)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh the cached values of the existing formulas -----------
    # The figures are DERIVED from the sheet (wbs_common.totals), not
    # hardcoded: another task's row may already carry a non-zero completion
    # rate, and whichever updater ran last must not restore a stale cache.
    derived = totals(parts)
    xml1 = parts[SHEET1].decode('utf-8')
    xml1 = set_cell_in_row(xml1, 8, 'B', str(derived['completed']), numeric=True)
    xml1 = set_cell_in_row(xml1, 9, 'B', format_rate(derived['completion_rate']), numeric=True)
    xml1 = set_cell_in_row(xml1, 10, 'B', repr(int(derived['sum_remaining'])), numeric=True)
    # The narrative cells D6/D7 are shared by every task: each contributes
    # ONE marked fragment, so they are re-composed from all of them.
    xml1 = set_narrative_cell(xml1, 6, 'D6')
    xml1 = set_narrative_cell(xml1, 7, 'D7')
    parts[SHEET1] = xml1.encode('utf-8')
    print(f'overview: 已完成={derived["completed"]} '
          f'完成率={derived["completion_rate"]} 剩余人日={derived["sum_remaining"]}')

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


def row_signature():
    """The ATS-104 row's cells, for the idempotency check."""
    zin = zipfile.ZipFile(XLSX)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-104')
    return rm.group(0)


def verify():
    """Assert the workbook still parses and row ATS-104 is exactly as intended."""
    zin = zipfile.ZipFile(XLSX)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-104')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    # The row is 待审核 while the review is in flight and 已完成 once the
    # reviewer has returned PASS; either is a correct state, but a row in
    # some OTHER status is not.
    assert status in ('待审核', STATUS_DONE), \
        f'ATS-104 status is {status!r}, expected 待审核 or {STATUS_DONE}'
    assert rate == '1', f'ATS-104 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-104 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-104 note has {note.count(MARKER)} markers, expected 1'
    assert 'cargo tauri dev' in note, 'the ATS-104 note is missing the delivered scope'
    print(f'verify: ATS-104 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')


def check_parses():
    """Assert the workbook is loadable -- in both openpyxl modes.

    A note that was written into the sheet XML without XML escaping makes the
    workbook unparseable. The updater still exits 0 in that case, so the
    parse check is the only thing that catches it.
    """
    import openpyxl

    wb = openpyxl.load_workbook(XLSX, data_only=False)
    ws = wb['开发WBS']
    row = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-104'):
            row = r
            break
    assert row is not None, 'the ATS-104 row is not found by openpyxl'
    n_value = ws.cell(row=row, column=14).value
    assert n_value in ('待审核', STATUS_DONE), f'column N is {n_value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    # Column P keeps its formula; the cached value is what the sheet carries.
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-104】') == 1, f'column T carries {note.count("【ATS-104】")} markers'
    assert 'cargo tauri dev' in note, 'column T is missing the delivered scope'
    wb.close()

    wb = openpyxl.load_workbook(XLSX, data_only=True)
    assert '开发WBS' in wb.sheetnames, 'the 开发WBS sheet is missing in the data_only mode'
    wb.close()
    print('verify: openpyxl loads the workbook in the normal and the data_only mode')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--verify-only', action='store_true')
    ap.add_argument(
        '--status', default='待审核',
        help='the 状态 to write into the ATS-104 row (default: 待审核). '
             'Use 已完成 once the review has returned PASS; the row then keeps '
             'that status across later re-runs of this script.')
    args = ap.parse_args()

    if args.verify_only:
        verify()
        check_parses()
    else:
        before = row_signature()
        patch_workbook(args.status)
        after = row_signature()
        if before == after:
            print('IDEMPOTENT: row ATS-104 unchanged')
        else:
            print('CHANGED (first run applied the update)')
        # A second run must be a no-op.
        second_before = row_signature()
        patch_workbook(args.status)
        second_after = row_signature()
        assert second_before == second_after, 'the updater is NOT idempotent'
        print('IDEMPOTENT: a second run leaves row ATS-104 byte-identical')
        verify()
        check_parses()
