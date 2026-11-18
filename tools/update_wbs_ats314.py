"""ATS-314: sync docs/WBS.xlsx 「开发WBS」row for ATS-314.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats308.py: the sheet XML is patched in place and
the zip is rewritten with every other part byte-identical.

ATS-314 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 7 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-314 note, marked with 【ATS-314】

NOTE on 状态: 待审核 ("pending review"), NOT 已完成. The deliverable is
submitted but not accepted yet -- the reviewer syncs the completion state
after the review passes. Declaring it 已完成 before review would contradict
"不得自行置 done".

THE MEASURED FIGURES ARE DERIVED, NOT RE-TYPED
----------------------------------------------
The note quotes the measured figures (the number of scripts, the number of
controlled steps, the per-reason breakdown). Those figures used to be typed
into this file, and they went stale the moment another ticket added a script
to `examples/`: the note kept saying one thing while the tree measured
another.

So the figures are READ FROM THE COMMITTED PROBE LOG
(`docs/evidence/ATS-314/03-probe-ast-subset.log`) and formatted into the
sentence. The number in the workbook cell is therefore the number the
committed log carries -- by construction, not by a re-typed constant.

If the log is missing, or does not carry a figure, the updater REFUSES to
write: a note it cannot back up must not be written into the workbook.
"""
import re
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from wbs_common import (SHEET1, SHEET2, cell_text, format_rate,  # noqa: E402
                         set_cell_in_row, set_marked_cell,
                         set_narrative_cell, totals)

ROOT = Path(__file__).resolve().parents[1]
XLSX = ROOT / 'docs' / 'WBS.xlsx'
PROBE_LOG = ROOT / 'docs' / 'evidence' / 'ATS-314' / '03-probe-ast-subset.log'

FIRST_ROW = 6

MARKER = '【ATS-314】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script: the review is a one-way door.
TERMINAL_STATUSES = ('已完成', '已取消')


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def self_consistent(xml, rid):
    """True when the row's 状态 agrees with its own 完成率 / 剩余人日."""
    try:
        rate = float(cell_text(xml, rid, 'O') or 0)
        remaining = float(cell_text(xml, rid, 'P') or 0)
    except ValueError:
        return False
    return rate >= 1 and remaining <= 0


def probe_figures(log_path=None):
    """The measured figures, READ FROM THE COMMITTED PROBE LOG.

    The probe log is the authority on what the real scripts hold. The note's
    figures are formatted from here, so they cannot drift away from the log
    they claim to describe.

    Returns a dict with `files`, `writable`, `partial`, `readOnly`,
    `steps`, `controlled` and the per-reason counts.
    """
    path = Path(log_path) if log_path is not None else PROBE_LOG
    if not path.exists():
        raise SystemExit(
            'the probe log %s does not exist -- the note\'s measured figures are '
            'derived from it, so the updater refuses to write a note it cannot '
            'back up' % path)
    text = path.read_text(encoding='utf-8')

    def number(pattern, label):
        m = re.search(pattern, text, re.M)
        if not m:
            raise SystemExit(
                'the probe log %s does not carry the %s figure -- the note\'s '
                'measured figures are derived from it, so the updater refuses to '
                'write' % (path, label))
        return int(m.group(1))

    # The labels are unique in the probe log. An earlier version of the
    # probe printed `read-only` twice -- once for the FILES and once for
    # the STEPS -- and a regex that reads the first match would have
    # taken the file count for the step count. The labels say which is
    # which, and the regexes name them exactly.
    out = {
        'files': number(r'^files\s+:\s+(\d+)\s*$', 'file count'),
        'writable': number(r'^files-writable\s+:\s+(\d+)\s*$', 'writable file count'),
        'partial': number(r'^files-partial\s+:\s+(\d+)\s*$', 'partial file count'),
        'readOnly': number(r'^files-read-only\s+:\s+(\d+)\s*$', 'read-only file count'),
        'steps': number(r'^steps\s+:\s+(\d+)\s*$', 'step count'),
        'controlled': number(r'^steps-controlled\s+:\s+(\d+)\s*$', 'controlled step count'),
        'readOnlySteps': number(r'^steps-read-only\s+:\s+(\d+)\s*$', 'read-only step count'),
    }

    # The per-reason breakdown. The probe prints the reasons as
    # `  <reason> <count>`, so the block between the reason heading and
    # the end of the log is read.
    reasons = {}
    in_reasons = False
    for line in text.splitlines():
        if line.startswith('--- the reasons ---'):
            in_reasons = True
            continue
        if in_reasons:
            if not line.strip():
                if reasons:
                    break
                continue
            m = re.match(r'^\s+([a-z][a-z-]*)\s+(\d+)\s*$', line)
            if not m:
                break
            reasons[m.group(1)] = int(m.group(2))
    if not reasons:
        raise SystemExit(
            'the probe log %s does not carry the per-reason breakdown -- the '
            'note\'s measured figures are derived from it, so the updater '
            'refuses to write' % path)
    out['reasons'] = reasons
    return out


def note_text(figures=None):
    """The note, with the measured figures taken from the probe log."""
    if figures is None:
        figures = probe_figures()
    reasons = '、'.join(
        f'{key} {figures["reasons"][key]}' for key in sorted(figures['reasons'])
    )
    return NOTE_TEMPLATE.format(
        files=figures['files'],
        writable=figures['writable'],
        partial=figures['partial'],
        read_only=figures['readOnly'],
        steps=figures['steps'],
        controlled=figures['controlled'],
        read_only_steps=figures['readOnlySteps'],
        reasons=reasons,
    )


# The note. It is a TEMPLATE: the measured figures are placeholders, filled by
# `note_text()` from the committed probe log. A re-typed constant is what let
# the workbook claim a count that no committed log carried.
#
# IT SAYS WHAT WAS MEASURED AND WHAT WAS NOT:
#   * the detector IS implemented and measured;
#   * it is a LEXER, not a TypeScript AST -- and why;
#   * it recognises the subset; it does NOT write anything back;
#   * there is no UI (ATS-315's area);
#   * the whitelist is closed: an API that is not on it is NOT SUPPORTED.
NOTE_TEMPLATE = (
    '【ATS-314】AST 受控步骤子集检测器已实现并实测（server/edit/ast-subset.mjs）：'
    '（1）**受控子集 = 白名单 API + 静态参数**：白名单是**封闭**的'
    '（page.goto / locator.click|fill|press|... / expect.toBe|toHaveText|... / '
    'test.step），不在名单上的 API 是**不支持**而不是「将来支持」，'
    '并且**带名字**报出来。'
    '（2）**「静态」的定义**：参数的文本在解析期已知且不依赖运行期计算——'
    '字面量、无插值的模板字符串、每个值都静态的选项对象是静态的；'
    '变量引用、有插值的模板字符串、简写/展开的选项对象、调用、成员表达式'
    '**不是**。断言的 **actual 侧按定义是运行期值**，平台**不得**改写它，'
    '检测器如实标出而不假装它是静态的。'
    '（3）**不可反写提示 = 封闭的理由码**：not-whitelisted / '
    'argument-not-static / arity-not-supported / not-a-plain-call / '
    'inside-control-flow / inside-local-function / unparseable。'
    '拒绝而不说理由的拒绝是读者无法据以行动的拒绝。'
    '**循环里的步骤**不是「一个方块」（循环在运行期决定跑几次），'
    '**本地函数里的步骤**也不可挪出（函数可能被多处调用）。'
    '（4）**文件三态**：writable（每个步骤都受控）/ partial / read-only，'
    '外加 `writable` 布尔位——ATS-315 需要它才可能写回。'
    '**用例声明不是步骤**（进独立的 containers 列表），'
    '**test.step 是分组**不是容器。'
    '（5）**为什么是词法分析器而不是 TypeScript AST**：Node Bridge '
    '**无第三方依赖**（docs/dependencies/dependency-manifest.md），'
    'typescript 是前端的依赖且 Bridge 环境里未安装，加进 Bridge 会改动'
    '依赖清单、许可复核与 CI 安装步骤。词法分析器已足以回答'
    '「调用在子集内吗、参数静态吗」——正则分不清字符串/注释里的调用，'
    '也找不到嵌套括号的匹配。'
    '（6）**接口面**：`GET /api/projects/<id>/ast-subset?file=` '
    '（**只读**，文件经 readSource 解析故与 source 接口同规则，需要令牌，'
    '**没有**写接口）。'
    '（7）**实**：对本仓库真实脚本实测 {files} 个文件——'
    'writable {writable} / partial {partial} / read-only {read_only}；'
    '共 {steps} 个步骤，controlled {controlled} / read-only {read_only_steps}；'
    '拒绝理由分布 {reasons}。'
    '（8）**只识别，不写回**：写回（diff→语法检查→人工批准→原子写→索引失效）'
    '属 ATS-315，本票**不写任何文件**（IT 实测前后全树摘要相同）。'
    '（9）**已知边界（如实记录）**：不是 TS AST（无类型解析/作用域分析）；'
    '**没有 UI**（ATS-315/ATS-310 的范围）；'
    '白名单不含 page.setContent / page.click 等其余 API（加进名单是设计决定）；'
    '**WDIO 脚本全被拒绝**（WDIO 的 API 不是 Playwright 的 API，'
    '平台不声称能画它们，这是正确行为）；'
    'test.step 的回调体**不被展平**（那是写回的事）。'
    '详见 docs/36-AST-CONTROLLED-SUBSET.md。'
)


def summarise(xml2):
    """Recompute the overview's cached formula values from the sheet itself.

    Mirrors the three formulas that live in the 总览 sheet:
      B8  = COUNTIF('开发WBS'!N6:N<last>,"已完成")
      B9  = IFERROR(1-SUM('开发WBS'!P6:P<last>)/SUM('开发WBS'!K6:K<last>),0)
      B10 = SUM(P6:P<last>)
    """
    done = 0
    sum_p = 0.0
    sum_k = 0.0
    last = FIRST_ROW - 1
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml2, re.S):
        rid = int(rm.group(1))
        if rid < FIRST_ROW:
            continue
        if '<x:v>ATS-' in rm.group(2):
            last = max(last, rid)
    for rid in range(FIRST_ROW, last + 1):
        if cell_text(xml2, rid, 'N') == '已完成':
            done += 1
        try:
            sum_p += float(cell_text(xml2, rid, 'P') or 0)
        except ValueError:
            pass
        try:
            sum_k += float(cell_text(xml2, rid, 'K') or 0)
        except ValueError:
            pass
    rate = 0.0 if sum_k == 0 else 1 - sum_p / sum_k
    return done, rate, sum_p


def patch_workbook(status='待审核', xlsx_path=None, note=None):
    """Write the ATS-314 row into the workbook at `xlsx_path`.

    The path is a PARAMETER, so the updater can be exercised on a copy: a
    test that had to edit the repository workbook would modify the deliverable
    while reporting success.
    """
    xlsx = Path(xlsx_path) if xlsx_path is not None else XLSX
    if note is None:
        note = note_text(probe_figures())
    shutil.copy2(xlsx, xlsx.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(xlsx)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-314')
    # A re-run must not undo an accepted review: only a row that has not been
    # accepted yet is (re)written.
    current = cell_text(xml2, rid, 'N')
    if current not in TERMINAL_STATUSES or not self_consistent(xml2, rid):
        xml2 = set_cell_in_row(xml2, rid, 'N', status)
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 7*(1-1) = 0; only the cached value changes.
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-314 note, replacing a previous copy of it.
    xml2 = set_marked_cell(xml2, rid, 'T', MARKER, note)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: rewrite the narrative cells from the fragments --------------
    xml1 = parts[SHEET1].decode('utf-8')
    xml1 = set_narrative_cell(xml1, 6, 'D6')
    xml1 = set_narrative_cell(xml1, 7, 'D7')

    # --- 总览: refresh the cached values of the existing formulas ----------
    done, rate, sum_p = summarise(xml2)
    xml1 = set_cell_in_row(xml1, 8, 'B', str(done), numeric=True)
    xml1 = set_cell_in_row(xml1, 9, 'B', format_rate(rate), numeric=True)
    xml1 = set_cell_in_row(xml1, 10, 'B', str(int(sum_p)) if sum_p == int(sum_p) else str(sum_p), numeric=True)
    parts[SHEET1] = xml1.encode('utf-8')
    print(f'overview: 已完成={done} 完成率={rate} 剩余人日={sum_p}')

    # --- rewrite the archive, preserving every other part byte-for-byte -----
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
    print('updated', xlsx)


def row_signature(xlsx_path=None):
    """The ATS-314 row's cells, for the idempotency check."""
    xlsx = Path(xlsx_path) if xlsx_path is not None else XLSX
    zin = zipfile.ZipFile(xlsx)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-314')
    return rm.group(0)


def verify(xlsx_path=None, figures=None):
    """Assert the workbook still parses and row ATS-314 is exactly as intended.

    The note's measured figures are checked against the evidence log they are
    derived from: a number that drifts can therefore no longer reach the
    workbook.
    """
    if figures is None:
        figures = probe_figures()
    xlsx = Path(xlsx_path) if xlsx_path is not None else XLSX
    zin = zipfile.ZipFile(xlsx)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-314')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    assert status in ('待审核', '已完成'), \
        f'ATS-314 status is {status!r}, expected 待审核 or 已完成'
    assert rate == '1', f'ATS-314 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-314 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-314 note has {note.count(MARKER)} markers, expected 1'
    assert '受控子集' in note, 'the ATS-314 note is missing the delivered scope'
    # The figures the note carries must be the ones the probe log holds.
    for needle in ('%d 个文件' % figures['files'],
                   'controlled %d' % figures['controlled'],
                   'read-only %d' % figures['readOnlySteps'],
                   'writable %d' % figures['writable'],
                   'partial %d' % figures['partial']):
        assert needle in note, \
            'the ATS-314 note does not carry %r -- the probe log says %r' % (needle, figures)
    print(f'verify: ATS-314 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')
    print('verify: the note carries the figures the probe log holds: '
          '%d files / %d steps / %d controlled' % (
              figures['files'], figures['steps'], figures['controlled']))


def check_parses(xlsx_path=None):
    """Assert the workbook is loadable -- in both openpyxl modes."""
    import openpyxl

    xlsx = Path(xlsx_path) if xlsx_path is not None else XLSX
    wb = openpyxl.load_workbook(xlsx, data_only=False)
    ws = wb['开发WBS']
    row = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-314'):
            row = r
            break
    assert row is not None, 'the ATS-314 row is not found by openpyxl'
    n_value = ws.cell(row=row, column=14).value
    assert n_value in ('待审核', '已完成'), f'column N is {n_value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-314】') == 1, f'column T carries {note.count("【ATS-314】")} markers'
    assert '受控子集' in note, 'column T is missing the delivered scope'
    wb.close()

    wb = openpyxl.load_workbook(xlsx, data_only=True)
    assert '开发WBS' in wb.sheetnames, 'the 开发WBS sheet is missing in the data_only mode'
    wb.close()
    print('verify: openpyxl loads the workbook in the normal and the data_only mode')


def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument('--verify-only', action='store_true')
    ap.add_argument(
        '--status', default='待审核', choices=('待审核', '已完成'),
        help='the 状态 to write into the ATS-314 row (default: 待审核).')
    ap.add_argument(
        '--xlsx', default=str(XLSX),
        help='the workbook to edit (default: docs/WBS.xlsx).')
    args = ap.parse_args(argv)

    figures = probe_figures()
    print('evidence: %d files / %d steps / %d controlled (from %s)'
          % (figures['files'], figures['steps'], figures['controlled'], PROBE_LOG))
    note = note_text(figures)

    if args.verify_only:
        verify(args.xlsx, figures)
        check_parses(args.xlsx)
        return 0

    before = row_signature(args.xlsx)
    patch_workbook(args.status, args.xlsx, note)
    after = row_signature(args.xlsx)
    if before == after:
        print('IDEMPOTENT: row ATS-314 unchanged')
    else:
        print('CHANGED (first run applied the update)')
    # A second run must be a no-op.
    second_before = row_signature(args.xlsx)
    patch_workbook(args.status, args.xlsx, note)
    second_after = row_signature(args.xlsx)
    assert second_before == second_after, 'the updater is NOT idempotent'
    print('IDEMPOTENT: a second run leaves row ATS-314 byte-identical')
    verify(args.xlsx, figures)
    check_parses(args.xlsx)
    print('totals:', totals())
    return 0


if __name__ == '__main__':
    sys.exit(main())
