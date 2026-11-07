"""ATS-209: sync the ATS-209 row of docs/WBS.xlsx with the delivered work.

Surgical edit of the existing workbook (no openpyxl for the edit, no
rebuild), in the same style as tools/update_wbs_ats208.py and
tools/update_wbs_ats212.py: the sheet XML is patched in place and the zip
is rewritten with every other part byte-identical.

ATS-209 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-209 note, marked with 【ATS-209】

WHY 待审核 AND NOT 已完成
-------------------------
The deliverable is submitted, but it has not been accepted yet -- the
reviewer (Opus) syncs 已完成 / 完成率 after the review passes. Declaring
it 已完成 before the review would contradict "不得自行置 done".

XML ESCAPING
-------------
The cell values are written into `<x:v>` elements. A note that contains
`<`, `>` or `&` written RAW into `xl/worksheets/sheet2.xml` makes the
workbook UNPARSEABLE: openpyxl raises a ParseError, Excel refuses to
open it and reports that the file has to be repaired. The escaping is
done by `wbs_common.set_marked_cell` / `wbs_common.set_cell_in_row`,
which apply the XML spec's own entity set (&, <, >) to every value
before it goes into the cell.

IDEMPOTENCY: running this script twice must leave row ATS-209
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

MARKER = '【ATS-209】'

NOTE = (
    '已交付证据清单、SHA-256、去重与保留策略：'
    '「篡改可检测」「保留期到期可清理且不误删 Run 元数据」两条验收标准逐条可测；'
    '证据清单（runs/<run>/manifest.json）格式升到 version 2：'
    '除 artifacts[]（每条含 file、size、sha256）外带 evidence 段（count、totalBytes、setDigest、truncated），'
    '并补上 projectUid 与 sourceCommit——'
    'v1 的清单记下了 digest 却没说它属于哪一次运行，没有归属的 digest 证明不了任何事；'
    '清单是运行记录与文件夹内容的函数，同样的运行与同样的文件总是得到同样的清单，因此可被重建比对；'
    '清单不列出自己，也不列出 events.jsonl 与 stdout.log——后者是运行的记录，清理器只动证据、保留记录；'
    '摘要按文件原始字节计算，不做行尾归一化：'
    '忽略行尾差异的摘要检测不到「文件被改写成另一种行尾」，而那正是证据文件必须能发现的改动；'
    '摘要含大小，因此同名同摘要但大小不同的文件不是同一份证据；'
    '清单与 run 记录的 artifacts[] 覆盖同一个文件集合（同一个收集器、同一个上限），'
    '上限触顶时 truncated 为真且校验判失败——没有覆盖全部证据的清单不是可校验的清单；'
    '校验（GET /api/runs/:id/evidence）逐文件重算摘要并分四类报出：'
    'missing（归档后被删除）、changed（被改动，给出应有与实际两个摘要）、extra（归档后被追加）、'
    'rejected（清单里指向 run 目录之外的条目，被拒绝且不跟随）；'
    '被追加的文件不使已归档文件失效，但会被列出，因为文件夹已不是清单描述的那一份；'
    '没有清单的目录报「读不出」而不是当作空证据集——「没有清单」与「清单里什么都没有」是两件事；'
    '去重是真的只存一份：证据字节按自己的 SHA-256 存进 <data-dir>/evidence-store/（内容寻址、两级扇出），'
    'run 目录里的文件是指向该副本的硬链接，字节在磁盘上只有一份；'
    '硬链接提供的是空间与原子性，不是防篡改：检测依赖的是清单里的摘要；'
    '硬链接的实际后果是一次就地改写的影响面被放大——改写一个 run 的证据文件会同时改掉其他共享该 inode 的 run，'
    '那些 run 会被报为 changed（如实报出，不是误报），因此 store 的副本不是独立备份；'
    '复用已有 blob 前先校验其内容，不符就用正确的字节替换，避免一次篡改毁掉之后每一个产出相同内容的 run；'
    '跨卷、文件系统不支持链接或超过体积上限时不链接，证据照常归档照常可校验，原因记在 run 的 dedupRefused 上；'
    '去重的诚实边界：索引只记录哪些内容被存了多份、哪一份最先登记；'
    '索引不替清理器决定删什么——清理器删除到期 run 的全部证据，不保留权威副本；'
    'sharedBytes 是「同一份内容若各存一份会占多少字节」，不是磁盘浪费（重复副本是硬链接），'
    '磁盘实际占用由 storeBytes 给出；'
    '保留策略：只有终态（passed/failed/cancelled/error/interrupted）的 run 才是待清理对象，'
    '在飞的 queued/running/cancelling 永不被清理，年龄从 finishedAt 起算，默认保留期 30 天（默认值刻意宽松：'
    '一次没人看过的失败的证据被意外删掉，代价比多占几天磁盘大得多）；'
    '清理只删 run 目录里的证据文件，events.jsonl、stdout.log 与 manifest.json 保留，'
    'run 记录本身（状态、summary、attempts、events）在 state.json 里因而完全不被触碰；'
    '清单里指向 run 目录之外的条目被拒绝并记入日志（run 目录是 runner 的输出目录，'
    'interrupted 的 run 从不由 Bridge 写清单，那里的 manifest.json 是谁写的就是谁的）；'
    '清理是离线操作：Bridge 运行时会持有数据目录锁并把内存里的状态写回 state.json，'
    '此时清理会删掉正在产出证据的 run 的目录、而 Bridge 下一次保存会把指向已删文件的状态写回去，'
    '因此锁被持有时清理被拒绝（退出码 3，与迁移同一规则）；'
    '清理同时回收 store 里无引用的副本（证据可能含 PII，清理不能只删一半），--dry-run 则什么都不删；'
    '每一次清理写一条仅追加的审计日志（evidence-retention-journal.jsonl），承担证据可能含 PII 时的「可审计删除」，'
    '日志只记实际删掉的文件；'
    '清理器在 run 目录里留下 evidence-cleaned.json，因此校验把被清理的缺失报为「已按保留期清理」而不是「不一致」，'
    'verify 不因此退出 1——否则每次清理都会让篡改告警永久亮红；'
    '清理记录的删除条目只增不减：再次清理删掉别的文件时并入旧记录而不是覆盖，'
    '删除的事实一旦记录就不会被撤回，先前删掉的文件因此仍被报为「已按保留期清理」而不是重新变成 missing；'
    '没有清理记录而丢失的文件仍报 missing 并判失败；'
    '接口面：GET /api/runs/:id/evidence（校验）、GET /api/runs/:id/manifest（读回清单）、'
    'GET /api/evidence/retention（保留期计划）、GET /api/evidence/dedup（去重报告）——四个接口都只读；'
    '清理是离线命令 tools/evidence_retention.mjs（plan/clean/verify/journal），'
    'clean 不带 --yes 会拒绝执行（退出码 2）：清理不会因为一次手滑就发生；'
    '用例：Node UT + IT + CLI 三套全通过（tests/evidence.test.mjs、tests/evidence-it.test.mjs、tests/evidence-cli.test.mjs），'
    '含归档后被改动被检出、归档后被删除报为 missing、被追加的文件报为 extra、'
    '清单越界条目被拒绝、清理后 run 记录逐字段不变、事件日志与清单保留、Bridge 持锁时清理被拒、'
    '相同字节只存一份、被篡改的 blob 不被复用、清理过的证据不再报为篡改、'
    'dry-run 不删任何东西（含 store）、清理日志只记实际删除的文件；'
    '清单条目的越界判定按解析后的真实路径做：字面上在 run 目录里、但经由目录链接或 junction '
    '指向外面的条目同样被拒绝，校验与清理都不跟随链接；'
    'run 目录的上级可以是链接（数据目录本身是链接是常事），但 run 目录自身是链接时其条目全部被拒；'
    '文件已不存在时按最深的存在祖先解析，它仍然是「缺失」而不是「越界」；'
    'results 本身是目录链接时只摘掉链接，不删除链接所指的树；'
    '探针 tools/ats209-probes/probe-evidence.mjs 全部断言通过，'
    '其中篡改检测带负控：把校验逻辑改成恒真的副本后探针必须报出「检测不到」，'
    '证明该断言能区分「检测有效」与「判定恒真」；'
    '已知边界：清单未签名，能写数据目录的攻击者可同时改文件与清单，因此不得宣称 WORM 或防篡改等级，'
    '本项检测的是「文件不再与归档时的清单相符」；'
    '摘要不归一化，因此同一份内容在不同平台（CRLF 与 LF）得到不同摘要、不会被去重，这是刻意的：'
    '归一化会削弱内容敏感性；'
    'store 在数据目录内，跨数据目录不共享，没有远程证据后端（属 ATS-509）；'
    '清理不做可逆恢复，被清理的证据连同 store 里的副本一并回收；'
    '清理器只查锁、不持锁，查完锁到 Bridge 启动之间仍有竞争窗口（与迁移工具的已知差别）；'
    '完整说明见 docs/27-EVIDENCE-MANIFEST.md 与 docs/06-DATA-DESIGN.md §4。'
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

    rid, _rm = find_ats_row(xml2, 'ATS-209')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-209 note, replacing a previous copy of it.
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
    # os.replace() can fail on Windows when the target is held open; copy then unlink.
    shutil.copy2(tmp, XLSX)
    tmp.unlink()
    print('updated', XLSX)


def row_signature():
    """The ATS-209 row's cells, for the idempotency check."""
    zin = zipfile.ZipFile(XLSX)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-209')
    return rm.group(0)


def verify():
    """Assert the workbook still parses and row ATS-209 is exactly as intended."""
    zin = zipfile.ZipFile(XLSX)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-209')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    assert status == '待审核', f'ATS-209 status is {status!r}, expected 待审核'
    assert rate == '1', f'ATS-209 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-209 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-209 note has {note.count(MARKER)} markers, expected 1'
    assert '证据清单' in note, 'the ATS-209 note is missing the delivered scope'
    # The note must not carry a REVIEW NARRATIVE: it states the final state.
    narrative = re.findall(r'第 ?[0-9一二三四五] ?轮|复核只剩|驳回', note)
    assert not narrative, f'the ATS-209 note carries a review narrative: {narrative}'
    # The note must not carry a count that goes stale as soon as another file
    # is added.
    stale = re.findall(r'\d+ 条清单|\d+ 个 ATS-209 证据文件', note)
    assert not stale, f'the ATS-209 note carries stale counts: {stale}'
    assert '；；' not in note, 'the ATS-209 note has a doubled separator'
    assert ';' not in note, 'the ATS-209 note has an ASCII semicolon'
    print(f'verify: ATS-209 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')


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
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-209'):
            row = r
            break
    assert row is not None, 'the ATS-209 row is not found by openpyxl'
    assert ws.cell(row=row, column=14).value == '待审核', f'column N is {ws.cell(row=row, column=14).value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    # Column P keeps its formula; the cached value is what the sheet carries.
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-209】') == 1, f'column T carries {note.count("【ATS-209】")} markers'
    assert '证据清单' in note, 'column T is missing the delivered scope'
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
            print('IDEMPOTENT: row ATS-209 unchanged')
        else:
            print('CHANGED (first run applied the update)')
        # A second run must be a no-op.
        second_before = row_signature()
        patch_workbook()
        second_after = row_signature()
        assert second_before == second_after, 'the updater is NOT idempotent'
        print('IDEMPOTENT: a second run leaves row ATS-209 byte-identical')
        verify()
        check_parses()
