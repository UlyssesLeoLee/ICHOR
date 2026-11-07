"""ATS-204: sync the ATS-204 row of docs/WBS.xlsx with the delivered work.

Surgical edit of the existing workbook (no openpyxl for the edit, no
rebuild), in the same style as tools/update_wbs_ats212.py and
tools/update_wbs_ats205.py: the sheet XML is patched in place and the zip
is rewritten with every other part byte-identical.

ATS-204 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-204 note, marked with 【ATS-204】

WHY 待审核 AND NOT 已完成
-------------------------
The deliverable is submitted, but it has not been accepted yet -- the
reviewer (Opus) syncs 已完成 / 完成率 after the review passes. Declaring
it 已完成 before the review would contradict "不得自行置 done".

XML ESCAPING
-------------
The cell values are written into `<x:v>` elements. A note that contains
`<`, `>` or `&` written RAW makes the workbook UNPARSEABLE. The escaping
is done by `wbs_common.set_marked_cell` / `wbs_common.set_cell_in_row`,
which apply the XML spec's own entity set (&, <, >) to every value.

IDEMPOTENCY: running this script twice must leave row ATS-204
byte-identical. The marker-aware merge in `wbs_common.set_marked_cell`
replaces the previous marked block instead of appending, so the second
run is a no-op. `verify()` asserts that.
"""
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

MARKER = '【ATS-204】'

NOTE = (
    '已交付文件/标题变化时的 UID 重识别与歧义提示（docs/26-IDENTITY-MAPPER.md）：'
    '新增身份映射器 server/identity.mjs，把「报告里的这个用例是不是注册表里那个用例」'
    '这个判断集中到一处，并按信号强度排序：显式标注 > 文件+describe路径+标题 > '
    '文件+行号+标题 > 文件+标题 > 执行体指纹 > 别名 > 标题单独；'
    '三条纪律：不唯一的信号绝不决定（报候选、不绑定，绑错是静默的而丢链接是可见的）、'
    '信号按强度使用（位置弱于执行体：上面插入一个用例会让下面所有行号平移）、'
    '标题在项目内不唯一时标题不决定任何事；'
    '「改名后旧证据关联保留」：注册表早就记着执行体指纹，但运行侧没有用它，'
    '于是改名又改标题的用例，其运行结果原本是 unbound 的（旧证据与用例的关联就断了）；'
    '映射器把指纹接进运行侧绑定后，改名 + 改标题的 attempt 按 body-key 绑回原 UID；'
    '「歧义不误关联」：执行体算得出来时位置命中必须与执行体一致，位置命中但执行体对不上'
    '就不算（file-line-body-mismatch）——行号平移的典型形态；'
    '本次运行里两个用例共享执行体时，指纹认不出其中任何一个，此时任何不使用指纹的信号'
    '（file-title、title）与位置信号都不绑定，否则两个用例会拿到同一个 UID；'
    '本次运行里两个用例写了同一个 @TC-xxx 时谁也不拥有该 token，映射器被告知各 token '
    '的出现次数；'
    '别名（注册表记的旧拼写）只在执行体不可得时使用——执行体算得出来却不匹配，'
    '说明那个位置上是另一个用例，别名不得认领它；'
    '发现侧新增「锚点」：动态用例没有自己的执行体（那个位置上的执行体是模板的，'
    '而模板明天可能多生成一个用例），所以它的身份是位置（文件+行号+describe路径）'
    '加次序（组内序号），注册表为每个用例记下锚点，模板改文案后每个渲染标题都变了，'
    '锚点是唯一认得出它的东西；模板增减渲染导致次序可能位移时报 render-shift-possible '
    '并带上位移前后的渲染数，不猜；'
    '矩阵修正：真实 @playwright/test 1.64.1 的报告对每个 project 各写一行 spec（实测），'
    '而解析器给每个 spec 都加序号，于是「一个用例跑两个 project」被算成两个用例'
    '（total: 2，且在 project b 失败被报成一个 passed 加一个 failed）；'
    '序号现在只给没有行号的 spec——那才是报告真的分不开的用例；'
    '两种报告形状现在给同一个答案（total: 1 / failed: 1）；'
    '接口面：权威索引的用例新增 anchor，warning 报告渲染数变化，'
    'attempt 新增 uidAmbiguity（绑定失败的原因与候选，不是什么都不说的未绑定）；'
    '锚点不得覆盖已有身份（四条规则，只写在一处 server/identity.mjs 的 '
    'reidentifyRendered()，生产路径调用的就是它）：'
    '静态扫描器看得见的用例（有自己的执行体）锚点不决定、标题仍认领着注册表里某个用例的'
    '锚点不决定、组内只有一部分标题变了的（删一个渲染换一个渲染，总数不变但次序可能位移）'
    '报 render-partially-changed 并且不绑定、站在源码用例位置上的另一个用例报 '
    'render-source-entry 并且不绑定（源码条目带执行体指纹，而换了执行体就是换了身份）；'
    '次序 = CLI 的报告次序（模板生成渲染的次序），不是目录按标题排的显示次序——'
    '改文案会改变排序名次，按排序名次计数会让锚点指向另一个渲染；'
    '矩阵的 caseKey 带 describe 路径（文件+describe路径+标题+行号），与发现侧的 '
    'parseListReport 一致，不同 describe 下的同名用例不再被并成一个；'
    '信号 2（file-scope-title）在生产路径上可达：parseReport 把 describe 路径带到 '
    'attemptsForRun 的 scope，第 2 步也做执行体一致性检查；'
    '运行侧的显式 token 与目录判定一致：目录判定 token 重复（duplicate-explicit-uid）时，'
    '只跑其中一个文件的运行也不得绑定它，否则两个用例会拿到同一个 UID；'
    '权威目录与静态目录都把这个判定写进注册表条目的 duplicateExplicit 字段——'
    '运行侧读的是注册表，判定只留在候选上运行侧就看不到，于是默认路径（不可信项目）'
    '上的单文件运行会把重复的 token 绑给其中一个用例，与目录的判定相反；'
    '判定是关于项目当下的陈述，重复修好之后随之消失，token 重新可以绑定；'
    '证据与文档如实：cli-facts.mjs 的断言与实测事实一致，退出码 0；'
    '回归用例：E1/E3/E4/M1/X1 与 X3/X2s/N4 各有一条 UT，在对应的缺陷树上实测失败、'
    '在本树上全部通过；'
    '实测脚本：tools/ats204-probes/cli-facts.mjs（真实 CLI 的事实：每个 project 一行 spec、'
    '渲染标题与行号、describe 路径、spec id、报告次序≠排序名次）、probe-gaps.mjs（改动前的缺口）、'
    'probe-anchor.mjs（锚点）、probe-matrix.mjs（矩阵的两种报告形状）、'
    'review-r1/r1-anchor.mjs、review-r1/r1-e2e.mjs 与 review-r2/r2-e2e.mjs（复核附的反例探针）；'
    'ADR 引用检查已按新行号同步（tools/fix_baseline_adr_refs.py + '
    'tools/check_adr_citations.py 通过），ATS-101 端口审计通过；'
    '已知边界：跨机器的用例身份不在本任务范围（Project UID 依赖绝对路径）；'
    '真实 Playwright 1.64.1 没有 test.each（实测），参数化在 Playwright 里是循环；'
    '改标题且改了执行体时用例换身份——要固定身份就用显式标注 @TC-xxx；'
    '循环数据整体替换与模板改文案不可区分（锚点认的是次序不是身份），'
    '要固定身份就用显式标注 @TC-xxx；'
    '非 Playwright 引擎的权威发现仍归 ATS-302。'
)


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def patch_workbook():
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-204')
    # 待审核 is one of the values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes.
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-204 note, replacing a previous copy of it. The
    # marker-aware merge keeps every other task's marked block in the same
    # cell and re-emits the blocks in canonical order, so the result does
    # not depend on which updater ran last.
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
    # os.replace() can fail on Windows when the target is held open; copy then unlink.
    shutil.copy2(tmp, XLSX)
    tmp.unlink()
    print('updated', XLSX)


def row_signature():
    """The ATS-204 row's cells, for the idempotency check."""
    zin = zipfile.ZipFile(XLSX)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-204')
    return rm.group(0)


def verify():
    """Assert the workbook still parses and row ATS-204 is exactly as intended."""
    zin = zipfile.ZipFile(XLSX)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-204')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    assert status == '待审核', f'ATS-204 status is {status!r}, expected 待审核'
    assert rate == '1', f'ATS-204 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-204 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-204 note has {note.count(MARKER)} markers, expected 1'
    assert '身份映射器' in note, 'the ATS-204 note is missing the delivered scope'
    # The note must not carry a REVIEW NARRATIVE: it states the final state.
    narrative = re.findall(r'第 ?[0-9一二三四五] ?轮|复核只剩|驳回', note)
    assert not narrative, f'the ATS-204 note carries a review narrative: {narrative}'
    # The note must not carry a count that goes stale as soon as another case
    # or another file is added.
    stale = re.findall(r'全量 \d+ 例|\d+ 项失败|Node UT \d+ 例|行 \d+\.\d+ ?%', note)
    assert not stale, f'the ATS-204 note carries stale counts: {stale}'
    assert '；；' not in note, 'the ATS-204 note has a doubled separator'
    assert ';' not in note, 'the ATS-204 note has an ASCII semicolon'
    print(f'verify: ATS-204 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')


def check_parses():
    """Assert the workbook is loadable -- in both openpyxl modes.

    A note that was written into the sheet XML without XML escaping makes
    the workbook unparseable. The updater still exits 0 in that case, so the
    parse check is the only thing that catches it.
    """
    import openpyxl

    wb = openpyxl.load_workbook(XLSX, data_only=False)
    ws = wb['开发WBS']
    row = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-204'):
            row = r
            break
    assert row is not None, 'the ATS-204 row is not found by openpyxl'
    assert ws.cell(row=row, column=14).value == '待审核', f'column N is {ws.cell(row=row, column=14).value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    # Column P keeps its formula; the cached value is what the sheet carries.
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-204】') == 1, f'column T carries {note.count("【ATS-204】")} markers'
    assert '身份映射器' in note, 'column T is missing the delivered scope'
    wb.close()

    wb = openpyxl.load_workbook(XLSX, data_only=True)
    assert '开发WBS' in wb.sheetnames, 'the 开发WBS sheet is missing in the data_only mode'
    wb.close()
    print('verify: openpyxl loads the workbook in the normal and the data_only mode')


if __name__ == '__main__':
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument('--verify-only', action='store_true')
    args = ap.parse_args()

    if args.verify_only:
        verify()
        check_parses()
    else:
        before = row_signature()
        patch_workbook()
        after = row_signature()
        if before == after:
            print('IDEMPOTENT: row ATS-204 unchanged')
        else:
            print('CHANGED (first run applied the update)')
        # A second run must be a no-op.
        second_before = row_signature()
        patch_workbook()
        second_after = row_signature()
        assert second_before == second_after, 'the updater is NOT idempotent'
        print('IDEMPOTENT: a second run leaves row ATS-204 byte-identical')
        verify()
        check_parses()
