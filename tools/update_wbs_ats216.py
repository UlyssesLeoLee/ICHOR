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

NOTE on re-runs after acceptance: the review is a one-way door. Once the
reviewer has returned PASS and the row carries 已完成, re-running this script
must NOT walk that row back to 待审核 -- the same guard the other updaters
carry (tools/update_wbs_ats101.py, ..._ats103.py, ..._ats502.py). The guard
protects a row that is accepted AND self-consistent (状态=已完成 with
完成率=1 and 剩余人日=0); a 已完成 row that contradicts its own numbers is a
stale artefact, not an acceptance, and does not get to veto the status this
task owns.

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

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script: the review is a one-way door.
TERMINAL_STATUSES = ('已完成', '已取消')

# The status the reviewer (Opus) writes after a PASS. It is one of the six
# values in the N-column data-validation list.
STATUS_DONE = '已完成'

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
    '跨运行维度：用例身份取存储摘要携带的事实——Playwright 摘要带 describe 路径、'
    'WebdriverIO 摘要带 case key，因此同一文件里同名的两个用例是两个用例，不是同一个「时好时坏」的用例；'
    '摘要两者都不带时退回「文件+标题」，此时同一运行里撞键的两个用例被标为 ambiguous、不贡献判定，不静默合并；'
    '一个每次都失败的用例因此不会被报成不稳定；'
    '身份键里不含行号：行号是用例在文件里的位置，会因用例上方的任何改动而移动，'
    '把行号放进键会在每次这样的改动处把一个用例的历史切成两段，'
    '跨这次改动的「一次通过、一次失败」就不会被判为不稳定；'
    '行号也不带来额外的区分能力——引擎自己就拒绝同一文件内「describe 路径+标题」重复的用例'
    '（实测 tools/ats216-probes/identity-probe.mjs，真实 Playwright 1.64.1：'
    '同一 describe 下两个同名用例、两个同名 describe+同名用例、参数化的同名用例，'
    '引擎一律报 duplicate test title 拒绝运行；不同名 describe+同名用例、'
    '同一标题路径出现在两个文件，引擎正常运行并由 describe 路径/文件区分），'
    '因此在一个文件内「describe 路径+标题」这一对已经是唯一的，键用的是 describe 路径；'
    '升级前存下的运行摘要不带 describe 路径与 case key，按「文件+标题」成键，'
    '与升级后的运行各自成条（同一批用例在升级前后是两个条目，而不是一条历史）；'
    '对账除了逐 run 与 Bridge 计数器比对，还比对「界面显示的数」与 Bridge 报告的计数器'
    '（verdict 组各运行的 Σ summary.<bucket> 对上 cases.<bucket>，Σ summary.executions 对上 attempt 数），'
    '并检查每个运行恰好落在一个运行桶里；显示的数与 Bridge 的数来自两个地方，模块算错时对账会变红；'
    '未出结论的运行（取消/中断/启动失败/未知状态）其用例不进入任何判定桶、attempt 桶、重试计数与跨运行视图，'
    '单列为 inconclusive 并单列 attempt 数；'
    '两个界面都渲染「原始结果」面板：每个显示出来的数字都能展开到它计数所依据的用例或运行；'
    '用例与证据：Node UT 54 例全通过（tests/quality-overview.test.mjs），'
    '系统测试 tools/ats216-probes/st-ats216.mjs 30 项检查全通过'
    '（真实 Bridge + 真实 Playwright + 真实 Chromium：真实失败运行、真实重试后通过、真实停止后的 cancelled）；'
    '浏览器实测 tools/ats216-probes/browser-check.mjs 22 项检查全通过（真实 Chromium，两个项目，'
    '「全部项目」范围与两个界面的数字一致，原始结果面板已渲染）；'
    '可证伪性：对模块做 10 个变异（取消的运行算失败、flaky 算通过、对账恒真、聚类常量、'
    '丢弃重试计数、保留 ANSI 码、忽略 attempt 数、未出结论的运行的用例进入判定指标、'
    '用例身份退回文件+标题、显示的数不再与 Bridge 的计数器对账），每一个都被 UT 或 ST 捕获，无一漏网；'
    '全量回归数字以 docs/evidence/ATS-216/02-node-test-full.log 为准（仓库级回归随 dev 漂移，'
    '因此不写死在本注记里）；'
    '本任务自身的套件为 54 例 UT + 30 项 ST + 22 项浏览器实测 + 11 项变异检查（10 个变异）'
    '+ 7 项身份探针（tools/ats216-probes/identity-probe.mjs，真实 Playwright：'
    '引擎拒绝什么、接受什么）；'
    'Next.js 16.4.5 静态导出构建实测通过（编译 392ms、TypeScript 1613ms、静态页 3/3），'
    'tsc --noEmit 通过（类型由模块的 JSDoc 推导，不另建一份类型定义以免漂移）；'
    '浏览器实测已执行（tools/ats216-probes/browser-check.mjs，真实 Chromium）：两个界面都打开质量概览页、指标与对账表都渲染、两个界面显示同一组数字、无 console 错误；'
    '已知边界：人工可用性（无障碍/键盘/加载态）未评测，属 ATS-111；'
    '（Next 工作台按端口解析 API 基址，apps/studio/lib/api.ts 硬编码 4577 是 ATS-101 已登记的约束，浏览器检查的 Bridge 因此跑在默认端口上；便携 UI 无此约束）；'
    '聚类的分组粒度只到「错误文本归一化后的签名」，不做根因判断，也不做失败传播分析；'
    '指标只覆盖本机 Bridge 的运行历史，不含远程 Runner（属 ATS-502/ATS-503）；'
    '模块与事件复演的完整说明见 docs/28-QUALITY-OVERVIEW.md。'
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

    rid, _rm = find_ats_row(xml2, 'ATS-216')
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
    # The row is 待审核 while the review is in flight and 已完成 once the
    # reviewer has returned PASS; either is a correct state, but a row in
    # some OTHER status is not.
    assert status in ('待审核', STATUS_DONE), \
        f'ATS-216 status is {status!r}, expected 待审核 or {STATUS_DONE}'
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
    n_value = ws.cell(row=row, column=14).value
    assert n_value in ('待审核', STATUS_DONE), f'column N is {n_value!r}'
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
    ap.add_argument(
        '--status', default='待审核',
        help='the 状态 to write into the ATS-216 row (default: 待审核). '
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
