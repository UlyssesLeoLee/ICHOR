"""ATS-216: sync the ATS-216 row of docs/WBS.xlsx with the delivered module.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats208.py: the sheet XML is patched in place and
the zip is rewritten with every other part byte-identical.

ATS-216 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 4 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-216 note, marked with 【ATS-216】

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate:

  B8  COUNTIF(N6:N94,"已完成")       -> counted from the sheet
  B9  1-SUM(P)/SUM(K)                -> computed from the sheet
  B10 SUM(P6:P94)                    -> computed from the sheet

XML ESCAPING (this is load-bearing, not cosmetic)
-----------------------------------------------
The cell values are written into `<x:v>` elements. A note that contains `<`,
`>` or `&` -- a comparison operator, an ampersand -- written RAW into
`xl/worksheets/sheet2.xml` makes the workbook UNPARSEABLE: openpyxl raises a
ParseError, Excel refuses to open it and reports that the file has to be
repaired. The escaping is done by `wbs_common.set_marked_cell` /
`wbs_common.set_cell_in_row`, which apply the XML spec's own entity set
(&, <, >) to every value before it goes into the cell.

NOTE on 状态: ATS-216 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is submitted, but it has not been accepted yet -- the reviewer
(Opus) syncs 已完成/完成率 after the review passes. Declaring it 已完成
before review would contradict "不得自行置 done".

IDEMPOTENCY: running this script twice must leave row ATS-216 byte-identical.
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

FIRST_ROW, LAST_ROW = 6, 94

MARKER = '【ATS-216】'

NOTE = (
    '已交付质量概览模块（失败聚类/Flaky 基础指标，非 AI）：'
    '实现是 apps/studio/public/quality.mjs 一份，Next 工作台与零依赖便携 UI 导入同一份代码，'
    '两个界面的指标不会各说各话（便携 UI 改为 ES module，Bridge 的 MIME 表新增 .mjs——'
    '浏览器拒绝以非 JavaScript 类型执行 module，缺这一项便携 UI 会静默加载失败）；'
    '「区分失败/重试/取消」：运行状态分三类（verdict=passed/failed、inconclusive=cancelled/error/interrupted、inFlight=queued/running/cancelling），'
    '取消/中断的运行单列，既不计入失败也不计入通过率，其用例归 inconclusive 不算通过也不算失败；'
    '用例状态沿用 ATS-208 的统一模型（passed/failed/flaky/skipped/unknown），'
    '重试后通过的用例单列 flaky，不并入 passed 也不并入 failed，初次尝试的 failed 与它自己的错误仍保留在 attempt 里；'
    '未知状态不猜测，一律归 unknown（报 failed 是凭空造失败，报 passed 是凭空造成功）；'
    '「指标与原始结果可核对」：每个桶都带原始用例引用（runId/runUid/attemptStatuses/retryCount），'
    '并逐项与 Bridge 自己报告的计数器核对（summary.passed/failed/flaky/skipped/total/executions），'
    '不一致时把差异逐行列出而不是抹平；模块自己复算一遍对账结论，探针再独立复算一遍，两者必须一致；'
    '失败聚类是非 AI 的确定性归一化：取错误首行，uuid/十六进制/引号文本/数字归为占位符，'
    '保留错误类（AssertionError 与 TimeoutError 不是同一个缺陷），ANSI 颜色码先剥离'
    '（否则同一个缺陷会因是否带 TTY 而聚成两类）；'
    '聚类键用 JSON 编码的二元组而非分隔符拼接（分隔符会出现在标题里导致碰撞）；'
    '跨运行维度：同一用例（文件+标题，JSON 编码）在一个运行失败、另一个运行通过，或需要过重试，'
    '都判为不稳定并单独列出；'
    '用例与证据：Node UT 39 例全通过（tests/quality-overview.test.mjs），'
    '系统测试 tools/ats216-probes/st-ats216.mjs 25 项检查全通过'
    '（真实 Bridge + 真实 Playwright + 真实 Chromium：真实失败运行、真实重试后通过、真实停止后的 cancelled）；'
    '可证伪性：对模块做 7 个变异（取消的运行算失败、flaky 算通过、对账恒真、聚类常量、'
    '丢弃重试计数、保留 ANSI 码、忽略 attempt 数），每一个都被 UT 或 ST 捕获，无一漏网；'
    '变异过程修掉了模块自身两个缺陷：运行状态原本有两套分组映射（runStatusGroup 与内联查表）'
    '可能各说各话，已合并为一套；错误签名原本保留 ANSI 颜色码，已先剥离；'
    '全量回归 977 例全通过、0 失败、0 跳过（接入 examples/sample-playwright 的 node_modules 后，'
    '依赖真实引擎的 IT 不再跳过）；'
    'Next.js 16.4.5 静态导出构建实测通过（编译 392ms、TypeScript 1613ms、静态页 3/3），'
    'tsc --noEmit 通过（类型由模块的 JSDoc 推导，不另建一份类型定义以免漂移）；'
    '浏览器实测已执行（tools/ats216-probes/browser-check.mjs，真实 Chromium）：两个界面都打开质量概览页、指标与对账表都渲染、两个界面显示同一组数字、无 console 错误；'
    '已知边界：人工可用性（无障碍/键盘/加载态）未评测，属 ATS-111；'
    '（Next 工作台按端口解析 API 基址，apps/studio/lib/api.ts 硬编码 4577 是 ATS-101 已登记的约束，浏览器检查的 Bridge 因此跑在默认端口上；便携 UI 无此约束）；'
    '聚类的分组粒度只到「错误文本归一化后的签名」，不做根因判断，也不做失败传播分析；'
    '指标只覆盖本机 Bridge 的运行历史，不含远程 Runner（属 ATS-502/ATS-503）；'
    '模块与事件复演的完整说明见 docs/27-QUALITY-OVERVIEW.md。'
)


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def patch_workbook(status='待审核'):
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-216')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', status)
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 4*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-216 note, replacing a previous copy of it.
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
    """The ATS-216 row's cells, for the idempotency check."""
    zin = zipfile.ZipFile(XLSX)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-216')
    return rm.group(0)


def verify():
    """Assert the workbook still parses and row ATS-216 is exactly as intended."""
    zin = zipfile.ZipFile(XLSX)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-216')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    assert status == '待审核', f'ATS-216 status is {status!r}, expected 待审核'
    assert rate == '1', f'ATS-216 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-216 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-216 note has {note.count(MARKER)} markers, expected 1'
    assert '质量概览' in note, 'the ATS-216 note is missing the delivered scope'
    print(f'verify: ATS-216 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')


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
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-216'):
            row = r
            break
    assert row is not None, 'the ATS-216 row is not found by openpyxl'
    assert ws.cell(row=row, column=14).value == '待审核', f'column N is {ws.cell(row=row, column=14).value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    # Column P keeps its formula; the cached value is what the sheet carries.
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-216】') == 1, f'column T carries {note.count("【ATS-216】")} markers'
    assert '质量概览' in note, 'column T is missing the delivered scope'
    wb.close()

    wb = openpyxl.load_workbook(XLSX, data_only=True)
    assert '开发WBS' in wb.sheetnames, 'the 开发WBS sheet is missing in the data_only mode'
    wb.close()
    print('verify: openpyxl loads the workbook in the normal and the data_only mode')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--verify-only', action='store_true')
    ap.add_argument('--status', default='待审核')
    args = ap.parse_args()

    if args.verify_only:
        verify()
        check_parses()
    else:
        before = row_signature()
        patch_workbook(args.status)
        after = row_signature()
        if before == after:
            print('IDEMPOTENT: row ATS-216 unchanged')
        else:
            print('CHANGED (first run applied the update)')
        # A second run must be a no-op.
        second_before = row_signature()
        patch_workbook(args.status)
        second_after = row_signature()
        assert second_before == second_after, 'the updater is NOT idempotent'
        print('IDEMPOTENT: a second run leaves row ATS-216 byte-identical')
        verify()
        check_parses()
