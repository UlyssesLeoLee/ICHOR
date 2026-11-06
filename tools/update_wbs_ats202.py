"""ATS-202: sync the ATS-202 row of docs/WBS.xlsx with the authoritative discovery.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats201.py and tools/update_wbs_ats506.py: the sheet
XML is patched in place and the zip is rewritten with every other part
byte-identical.

ATS-202 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value K*(1-O) (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-202 note, marked with 【ATS-202】

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate.

XML ESCAPING is load-bearing, not cosmetic: the cell values are written into
`<x:v>` elements, and a note that contains `<`, `>` or `&` written RAW makes
the workbook UNPARSEABLE. `wbs_common.set_marked_cell` applies the XML
spec's own entity set to every value before it goes into the cell.

NOTE on 状态: ATS-202 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is submitted, but it has not been accepted yet -- the reviewer
(Opus) syncs 已完成/完成率 after the review passes. Declaring it 已完成
before review would contradict "不得自行置 done".

IDEMPOTENCY: running this script twice must leave row ATS-202 byte-identical.
The marker-aware merge in `wbs_common.set_marked_cell` replaces the previous
marked block instead of appending, so the second run is a no-op. `verify()`
asserts that.

    python tools/update_wbs_ats202.py                 # 待审核
    python tools/update_wbs_ats202.py --status 进行中
    python tools/update_wbs_ats202.py --xlsx copy.xlsx
    python tools/update_wbs_ats202.py --verify-only
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
ATS_ID = 'ATS-202'
MARKER = '【ATS-202】'
STATUSES = ('待审核', '进行中')
TERMINAL_STATUSES = ('已完成', '已取消')
COMPLETION = {'待审核': 1.0, '进行中': 0.6}

NOTE = (
    '已交付「使用 playwright test --list 的权威发现」（docs/23-AUTHORITATIVE-DISCOVERY.md）：'
    '原生索引适配器调用项目自带的 Playwright CLI 的 --list --reporter=json，'
    '把 CLI 报告的用例（含动态生成与参数化用例）变成一等 TestDefinition；'
    'CLI 取自项目本地路径，绝不全局二进制、绝不 npx、不安装任何东西。'
    '实测（真实 @playwright/test 1.64.1，33 项断言全通过）：'
    '报告为 {config,suites,errors,stats}；spec.file 相对 rootDir（已归一为项目根相对路径）；'
    'spec.id 为 <20hex>-<20hex>，确定性，且在改写执行体、插入上方用例后不变，'
    '在文件改名、改写标题、新增 describe 包裹后改变；'
    'describe 路径通过 suite 嵌套报告，spec.title 是叶子标题；'
    '项目矩阵下同一逻辑用例按 project 各报一次，各有不同 spec id。'
    '信任闸门：实测 --list 会加载项目配置并执行测试文件顶层代码，它不是只读操作，'
    '因此未可信仓库不调用 --list，回退静态索引并说明原因（即使显式请求 authoritative=true 也不执行）；'
    '信任按项目 UID 持久化在 state.json.trust，可授予与撤销。'
    '身份阶梯：显式 @TC-xxx > 注册表（执行体指纹）> 标题键 > 执行体指纹（仅源码用例）'
    '> describe 路径 > 文件+describe 路径 > 临时 UID（报告歧义）；'
    '标题被多个用例认领时由源码用例胜出，动态用例不会把字面用例挤下标题键；'
    '两个索引读到同一标题、同一位置时 UID 不变（成立条件见设计书 4.5）。'
    '第 1 轮复核的 8 个反例已全部返工并各有回归用例：闭合 describe 与 describe 修饰符的'
    '一致性假差异、转义引号与超长标题的 UID 漂移、多行 test( 调用的行号、动态用例的注册表'
    '回流、可信项目显式要静态索引的结果码；列举改为异步，Bridge 不再被阻塞。'
    '第 2 轮复核的 4 项已返工：'
    '异步化后的注册表写回改为按项目逐格合并（不再整体覆盖别人的条目）；'
    'Bridge 真正走的异步列举路径补上直接测试（成功/超时杀子进程/CLI 崩溃/坏 JSON/'
    '报告带错误/无 CLI/无 root/两变体一致/事件循环不被占住）；'
    '一致性比较键改为「文件+调用行+标题」（describe 路径只作可读键），'
    '保证收窄为「CLI 枚举到的用例不会出现在 onlyStatic 里」并逐条写明例外；'
    '扫描器修正会让含转义引号标题的用例在升级时一次性换静态 UID，已写明影响范围、'
    '不做迁移的理由与用 @TC-xxx 固定 UID 的办法（设计书 4.5.1）。'
    '第 3 轮复核的 1 项已返工：'
    'N1 的逐格写回改为按目录自己的键（projectUidOf(project)）查找并存档，'
    '旧格式项目记录（无 uid 字段、id 仍是 proj_<uuid>）的注册表不再被静默丢弃'
    '（此前实测 registry slots 从 ["proj_1_…"] 变成 []，未迁移的安装每次打开目录'
    '都不保存注册表）；同时更正了设计书 5.2 第 3 条的归因——表达式体回调里的用例'
    '只出现在权威索引，真正原因是扫描器只识别行首的 test(，而不是读不到 describe 路径。'
    '与 CLI 的一致性是被测量的：响应带 consistency，逐条报告只有一方可见的用例。'
    '证据 docs/evidence/ATS-202/（真实 CLI 契约测量 + UT 30 项 + 回归 28 项 + 异步 15 项 '
    '+ IT 17 项 + API 10 项 + 全量回归 + 第 2 轮复核的 4 个反例探针 '
    '+ 第 3 轮复核的 2 个反例探针）。'
    '已知边界：文件/标题变化时的重识别与歧义提示策略归 ATS-204，'
    '索引回归数据集归 ATS-203，非 Playwright 引擎的权威发现归 ATS-302，'
    '沙箱化执行（--list 仍在宿主执行仓库代码）归 ATS-415，'
    '列举结果缓存归 ATS-203'
)


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
    """Write the ATS-202 row and refresh the overview's cached values."""
    xlsx_path = Path(xlsx_path)
    with zipfile.ZipFile(xlsx_path) as zin:
        infos = zin.infolist()
        parts = {i.filename: zin.read(i.filename) for i in infos}

    xml2 = parts[SHEET2].decode('utf-8')
    rid = find_ats_row(xml2, ATS_ID)
    # A row that has already been accepted (已完成 / 已取消) is never
    # downgraded by a later run of this script.
    if cell_text(xml2, rid, 'N') not in TERMINAL_STATUSES:
        completion = COMPLETION[status]
        xml2 = set_cell_in_row(xml2, rid, 'N', status)
        xml2 = set_cell_in_row(xml2, rid, 'O', _number(completion), numeric=True)
        remaining = cell_number(xml2, rid, 'K') * (1 - completion)
        xml2 = set_cell_in_row(xml2, rid, 'P', _number(remaining), numeric=True)
    # 风险/说明: this script's note. The marker-aware merge keeps every other
    # task's marked block in the same cell.
    xml2 = set_marked_cell(xml2, rid, 'T', MARKER, NOTE)
    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh the cached values of the existing formulas ----------
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
    print(f'overview: 已完成={derived["completed"]} '
          f'完成率={derived["completion_rate"]} 剩余人日={derived["sum_remaining"]}')


def row_signature(xlsx_path):
    """The ATS-202 row's cells, for the idempotency check."""
    with zipfile.ZipFile(xlsx_path) as zin:
        xml2 = zin.read(SHEET2).decode('utf-8')
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml2, re.S):
        if f'<x:v>{ATS_ID}</x:v>' in rm.group(2):
            return rm.group(0)
    raise SystemExit(f'row for {ATS_ID} not found')


def verify(xlsx_path):
    """Assert the workbook still parses and the ATS-202 row is as intended."""
    with zipfile.ZipFile(xlsx_path) as zin:
        names = zin.namelist()
        assert SHEET2 in names, 'sheet2 missing'
        xml2 = zin.read(SHEET2).decode('utf-8')
    rid = find_ats_row(xml2, ATS_ID)
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    assert status in STATUSES + TERMINAL_STATUSES, f'ATS-202 status is {status!r}'
    assert note.count(MARKER) == 1, f'ATS-202 note has {note.count(MARKER)} markers, expected 1'
    assert '权威发现' in note, 'the ATS-202 note is missing the delivered scope'
    print(f'verify: ATS-202 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} '
          f'marker×{note.count(MARKER)}')


def check_parses(xlsx_path):
    """Assert the workbook is loadable -- in both openpyxl modes.

    A note that was written into the sheet XML without XML escaping makes the
    workbook unparseable. The updater still exits 0 in that case, so the
    parse check is the only thing that catches it.
    """
    import openpyxl

    wb = openpyxl.load_workbook(xlsx_path, data_only=False)
    ws = wb['开发WBS']
    row = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(row=r, column=1).value or '').startswith(ATS_ID):
            row = r
            break
    assert row is not None, 'the ATS-202 row is not found by openpyxl'
    assert ws.cell(row=row, column=14).value in STATUSES + TERMINAL_STATUSES, \
        f'column N is {ws.cell(row=row, column=14).value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, \
        f'column O is {ws.cell(row=row, column=15).value!r}'
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), \
        f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count(MARKER) == 1, f'column T carries {note.count(MARKER)} markers'
    assert '权威发现' in note, 'column T is missing the delivered scope'
    wb.close()

    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    assert '开发WBS' in wb.sheetnames, 'the 开发WBS sheet is missing in the data_only mode'
    wb.close()
    print('verify: openpyxl loads the workbook in the normal and the data_only mode')


def main(argv=None):
    parser = argparse.ArgumentParser(description='Sync the ATS-202 row of docs/WBS.xlsx.')
    parser.add_argument('--status', default='待审核', choices=STATUSES,
                        help='状态 of the ATS-202 row (default: 待审核; 进行中 during rework)')
    parser.add_argument('--xlsx', default=str(XLSX), help='workbook to edit (default: docs/WBS.xlsx)')
    parser.add_argument('--verify-only', action='store_true',
                        help='only verify the workbook, do not write it')
    args = parser.parse_args(argv)

    target = Path(args.xlsx)
    if args.verify_only:
        verify(target)
        check_parses(target)
        return 0

    before = row_signature(target)
    update(target, args.status)
    after = row_signature(target)
    print('IDEMPOTENT: row ATS-202 unchanged' if before == after
          else 'CHANGED (first run applied the update)')
    # A second run must be a no-op.
    second_before = row_signature(target)
    update(target, args.status)
    second_after = row_signature(target)
    assert second_before == second_after, 'the updater is NOT idempotent'
    print('IDEMPOTENT: a second run leaves row ATS-202 byte-identical')
    verify(target)
    check_parses(target)
    return 0


if __name__ == '__main__':
    sys.exit(main())
