"""ATS-208: sync the ATS-208 row of docs/WBS.xlsx with the delivered model.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats205.py: the sheet XML is patched in place and
the zip is rewritten with every other part byte-identical.

ATS-208 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-208 note, marked with 【ATS-208】

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

NOTE on 状态: ATS-208 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is submitted, but it has not been accepted yet -- the reviewer
(Opus) syncs 已完成/完成率 after the review passes. Declaring it 已完成
before review would contradict "不得自行置 done".

IDEMPOTENCY: running this script twice must leave row ATS-208 byte-identical.
The marker-aware merge in `wbs_common.set_marked_cell` replaces the previous
marked block instead of appending, so the second run is a no-op. `verify()`
asserts that.
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

FIRST_ROW, LAST_ROW = 6, 94

MARKER = '【ATS-208】'

NOTE = (
    '已交付执行状态机 v2：Run/Test/Attempt 与事件序号统一模型（server/execution/model.mjs）；'
    '模型是唯一的定义处，Bridge、两个适配器与 SQLite 层都从这里取词表与聚合规则，'
    '不再各说各话；'
    '三个层级两个状态词表：Run 生命周期（queued/running/cancelling/passed/failed/cancelled/error/interrupted）、'
    'Case 整体（passed/failed/skipped/flaky/unknown）、Attempt 单次执行（同 Case 词表）；'
    '（判定语义：状态与判定分成两个词表——status 说「发生了什么」，'
    'outcome 说「是否符合声明」（expected/unexpected/flaky/skipped/unknown）；'
    '引擎声明了 expectedStatus（test.fail() 之后是 failed）时据此判定，'
    '预期失败计为 passed、意外通过计为 failed，attempt 仍保留自己的原始 status 与错误；'
    'Case 跨多个 project 时由引擎各 project 的判定决定状态（在 project b 失败是 failed，'
    '第一次失败重试通过是 flaky）；'
    '引擎词表到通用词表的映射只有一张表（mapEngineStatus），未知状态映射为 unknown 而不猜测'
    '（报 failed 是凭空造失败，报 passed 是凭空造成功）；'
    '「重试不覆盖初次尝试」：一个 spec 是一个 case、results[] 的每项是一个 attempt，'
    '计数器按 case 统计（重试过的用例只算一个），执行次数单独记为 executions，'
    '每次 attempt 都按顺序保留各自的状态/耗时/错误，初次尝试的 failed 与它自己的错误不被重试覆盖，'
    'case 报告的是第一次失败的错误；同一 case 的各 attempt 绑定同一个 TestDefinition UID；'
    'WDIO 侧按「同 suite 内连续同名条目」合并重试（实测 @wdio/reporter 10.1.0 每次尝试推一条同名条目），'
    '合并后为一个 case 的多个 attempt；分组在第一个通过的条目处结束——WDIO 的重试用例在第一次通过时就停，'
    '所以跟在一条通过条目之后的同名条目是另一个用例，合并它们会藏掉一次真实的失败；'
    '剩下的歧义（报告里的 [failed, passed] 无法与「失败后重试通过」区分）是写明的边界；'
    '「事件可按 run+sequence 复演」：事件只追加、序号无空洞且严格递增（1..N）、'
    '按序号折叠即得 run 的状态（GET /api/runs/:id/replay 暴露复演结果、是否与记录一致、序号空洞）；'
    '事件写在状态变更之前（run.queued 除外），于是事件流的最后一个事件决定终态；'
    '状态机拒绝不可能的迁移并把拒绝记到 stderr，而不是默默写下与状态机矛盾的事件；'
    '复演同时按 RUN_TRANSITIONS 校验事件流，答案带 valid/violations，违反状态机的流不报 agrees:true；'
    '复演同时校验序号：丢失的序号进 gaps（序号从 1 起算，开头缺号同样是缺口）、'
    '重复的序号进 duplicates（这样的流 valid 为 false，因为元数据层的主键 (run_uid,seq) 会拒绝它）、'
    '没有序号的事件进 unsequenced；'
    'ATS-208 补上了缺失的 run.interrupted 事件，因此 Bridge 崩溃打断的 run 也能复演为 interrupted'
    '（此前其事件流推不出任何状态）；'
    '（崩溃恢复以持久日志为准：'
    '日志已有终态事件时采用该终态且不再追加任何事件；'
    '日志无终态事件而 run 停在 queued/running/cancelling 时写 run.interrupted 进入终态'
    '（cancelling 也在恢复集合内，否则该 run 永远占住项目运行锁）；'
    '日志缺失、不可读或尾行被撕裂时降级——记录问题、run 仍恢复为终态、Bridge 照常启动，'
    '读取方逐行解析并报告无法解析的行（/events 与 /replay 不再返回 500），'
    '写入方在文件不以换行结尾时先补一个换行；'
    '事件写在三处且由同一事件对象写出：runs/<run>/events.jsonl、state.json 的 run.events、'
    'SQLite events 表（schema version 3，主键 (run_uid,seq) 即事件身份，'
    '同时强制一个 run 不会有两条同序号事件）；旧 run 记录没有 events 数组，'
    'Bridge 启动时从自己的 events.jsonl 读回并对齐 eventSeq 计数器；'
    '（用例与证据：Node UT 32 例 + IT 14 例全通过（tests/execution-model.test.mjs、'
    'tests/execution-model-it.test.mjs），含预期失败计为 passed、'
    'Bridge 被 SIGKILL 后重启复演为 interrupted、崩溃窗口下的序号校准、'
    '终态事件后不追加事件、cancelling 的 run 恢复为 interrupted、'
    'run 目录缺失与日志尾行撕裂时 Bridge 仍能启动、事件在状态文件/JSONL/SQLite 三处一致、'
    '状态图与 RUN_TRANSITIONS 一致；'
    '恢复类用例（IT-EXE-008 ~ IT-EXE-013）在第一版（8c9dd79）上为红（已实测）；'
    '判定语义、WDIO 合并、复演序号三类用例（UT-EXE-028 ~ UT-EXE-031 与 IT-EXE-009/010/011/013）'
    '在第二版（42f5d29）上为红（已实测）；'
    '复核随附的七个探针（pw-semantics / startup-robustness / bridge-e2e / wdio-check / '
    'wdio-dup / verdict-unknown / replay-contract）全部 RESULT: 0 failed；'
    '全量回归 795 例（795 通过 / 0 失败 / 0 跳过；接入 examples/sample-playwright 与 '
    'examples/sample-wdio 的 node_modules 后，依赖真实引擎的 IT 不再跳过）；'
    '本任务改动的每个 server 文件行覆盖率均 >90%（server/execution/model.mjs 99.34、'
    'server/adapters/playwright.mjs 99.47、server/adapters/wdio.mjs 97.62、'
    'server/core.mjs 97.82、server/sqlite/import.mjs 95.92；server/index.mjs 以子进程方式运行，'
    '在进程内测得的覆盖率按惯例不计）；'
    'verifyMirror 的事件比对补了 5 个负向用例（行缺失、data 非 JSON、payload 漂移、'
    '索引列漂移、多余行）；'
    '自查发现并修掉两处本任务自己引入的缺陷：崩溃窗口（事件先写日志后存状态）'
    '会让计数器停在旧值上、下一个事件拿到已用过的序号，改为每次启动用持久日志校准'
    '（回归用例 IT-EXE-007 把修复还原后报出 the sequence has a duplicate: [1,2,2]）；'
    'ADR 引用检查改为从当前源码推导位置，不再手写行号（引错行照样被抓，已验证）；'
    '修复了实测到的两个缺陷：适配器把重试的执行摊平成独立 case 导致初次尝试被丢弃'
    '（旧实测 total=2/passed=0/flaky=2，现为 total=1/flaky=1/executions=2）、'
    '以及崩溃后事件流推不出状态；'
    '已知边界：真实浏览器 ST 未执行（夹具是 CLI 替身，只建模报告的形状）；'
    'attempt 上没有 project 字段，跨 project 的同 case 两个 retry:0 attempt 只能靠 occurrence 区分；'
    'WDIO 的 json reporter 不带重试序号，重试序号由条目位置推出（报告乱序时不可靠）；'
    '事件日志的损坏只被报告不被修复（丢失的事件确实丢了）；'
    '前端类型与结果列表已同步到统一模型（apps/studio/lib/api.ts、app/page.tsx，'
    'tsc --noEmit 与 next build 均通过）；'
    '模型与事件复演的完整说明见 docs/06-DATA-DESIGN.md §5.4 与 docs/04-DETAILED-DESIGN.md §3。'
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

    rid, _rm = find_ats_row(xml2, 'ATS-208')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-208 note, replacing a previous copy of it.
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
    """The ATS-208 row's cells, for the idempotency check."""
    zin = zipfile.ZipFile(XLSX)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-208')
    return rm.group(0)


def verify():
    """Assert the workbook still parses and row ATS-208 is exactly as intended."""
    zin = zipfile.ZipFile(XLSX)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-208')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    assert status == '待审核', f'ATS-208 status is {status!r}, expected 待审核'
    assert rate == '1', f'ATS-208 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-208 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-208 note has {note.count(MARKER)} markers, expected 1'
    assert '执行状态机 v2' in note, 'the ATS-208 note is missing the delivered scope'
    print(f'verify: ATS-208 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')


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
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-208'):
            row = r
            break
    assert row is not None, 'the ATS-208 row is not found by openpyxl'
    assert ws.cell(row=row, column=14).value == '待审核', f'column N is {ws.cell(row=row, column=14).value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    # Column P keeps its formula; the cached value is what the sheet carries.
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-208】') == 1, f'column T carries {note.count("【ATS-208】")} markers'
    assert '执行状态机 v2' in note, 'column T is missing the delivered scope'
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
            print('IDEMPOTENT: row ATS-208 unchanged')
        else:
            print('CHANGED (first run applied the update)')
        # A second run must be a no-op.
        second_before = row_signature()
        patch_workbook()
        second_after = row_signature()
        assert second_before == second_after, 'the updater is NOT idempotent'
        print('IDEMPOTENT: a second run leaves row ATS-208 byte-identical')
        verify()
        check_parses()
