"""ATS-212: sync the ATS-212 row of docs/WBS.xlsx with the delivered work.

Surgical edit of the existing workbook (no openpyxl for the edit, no
rebuild), in the same style as tools/update_wbs_ats205.py and
tools/update_wbs_ats208.py: the sheet XML is patched in place and the zip
is rewritten with every other part byte-identical.

ATS-212 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 4 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-212 note, marked with 【ATS-212】

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

IDEMPOTENCY: running this script twice must leave row ATS-212
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

MARKER = '【ATS-212】'

NOTE = (
    '已交付项目级环境档案与安全参数绑定：'
    '「档案 API + 白名单 + 封口环境 + 不进 Git」四条验收标准逐条可测；'
    '档案模型：环境档案是项目级的，标识由项目与名称派生（env_1_ + sha256 前 24 位，'
    '名称与项目之间用 NUL 分隔，避免跨边界碰撞），层级恰为 dev/staging/prod，'
    '同一项目内同名档案替换时标识不变，所以已引用它的运行仍指向同一个档案；'
    '档案存放在 Bridge 的状态里（state.envProfiles），因此原子写入、SQLite 镜像与'
    '导入导出往返都能覆盖它，不另起一份会与状态分叉的旁路文件；'
    '「环境变量白名单」是拒绝而不是丢弃：越界的变量名不入档案，'
    '并连同理由一起报回调用方（静默丢弃会让调用方以为变量已生效）；'
    '白名单条目只能是名称或结尾单星号（FEATURE_*），通用 glob 不支持，'
    '裸星号被拒——一个把范围写错的条目不该把白名单撑大；'
    '「凭据不进档案」：名称呈凭据形态（*_TOKEN / *_PASSWORD / *_SECRET / *_API_KEY，'
    '不区分大小写）的变量一律被拒，且理由指向凭据存储而不是白名单——'
    '凭据形态的判定先于白名单判定，因为白名单从来就不是凭据能去的地方，'
    '把调用方指向白名单只会让它去错地方；'
    '白名单本身也不能授权凭据形态的名称，配置这样的白名单会被整体拒绝且不生效；'
    '「只把受控环境变量传给 runner」：runner 子进程的环境是封口的，'
    '由平台基础键 + 白名单筛选后的档案变量构成，宿主 process.env 一律不继承；'
    '改造前适配器是 {...process.env, ...}，操作者在 shell 里的云凭据与 CI token '
    '会一路进到被测代码，再被写进归档为证据的报告；'
    '没有档案时环境同样封口（平台基础键仍在，子进程照样跑得起来）；'
    '保留名（LD_PRELOAD / DYLD_INSERT_LIBRARIES / NODE_OPTIONS / '
    'PLAYWRIGHT_JSON_OUTPUT_FILE 等）即使被白名单放行也拒绝，'
    '且平台关键键在构造环境时无条件最后覆盖，档案改不掉它；'
    '「不写入 Git」：档案只落在 Bridge 的数据目录，项目目录一个文件都不多，'
    '档案的值不出现在项目树里的任何文件中（用例直接扫描项目目录断言这一点）；'
    '「档案值不进普通运行元数据」：API 响应、运行记录与 manifest 只带档案的'
    'UID/名称/层级和变量名，不带值；运行引用不存在的档案时返回 404 '
    'ENV_PROFILE_NOT_FOUND，不静默降级成「没有档案」（本该打 staging 的运行'
    '不能悄悄打了默认环境）；'
    'SQLite：schema version 4，migration 4（environment-profiles）新增 '
    'env_profiles 表、env_whitelists 表与 runs.env_uid 列（additive，旧运行照旧）；'
    '索引列只存变量名不存值，完整档案在 doc 列；'
    '镜像校验覆盖档案与白名单，缺档案、被篡改、索引列与记录矛盾、白名单不一致'
    '都会被报出来，而不是藏起来；'
    '证据：Node UT 29 例（tests/env.test.mjs）+ IT 13 例（tests/env-api.test.mjs）'
    '+ UT 11 例（tests/env-sqlite.test.mjs）+ IT 5 例（tests/env-adapter.test.mjs）全通过；'
    '其中 IT-ENV-ADP-001 是用 fake Playwright CLI 记录子进程真实收到的环境来断言的，'
    '不是断言构造函数的返回值；'
    '列盘子进程的封口另用 A/B 实测（tools/ats212-probes/ab-listing-env.mjs）：'
    '真实 Playwright，封口环境与宿主环境各跑 5 轮，两侧 5/5 成功且分布相同，'
    '说明封口没有破坏列举；'
    '全量回归 866 例（855 通过 / 0 失败 / 11 跳过），'
    '本任务落地前的基线为 564 例（553 通过 / 11 跳过），无回归；'
    '自查发现并修掉三处本任务自己引入的缺陷：'
    '（1）档案层曾把宿主 process.env 传给子进程；（2）构造环境时平台关键键'
    '只在缺失时填充，档案若先写入 PATH 就能改掉它，改为无条件最后覆盖；'
    '（3）被拒绝的档案曾以半成品形式留在存储里，改为档案完整才落库；'
    '本轮复核另修掉两处交付缺陷：（4）证据脚本把 echo 的退出码当成命令的退出码，'
    '每份日志都宣称 exit 0，改为命令后立刻取退出码；'
    '（5）tools/ats212-probes/ab-listing-env.mjs 曾是既不在证据脚本、也没有证据日志的孤儿文件，'
    '现作为 06b 步纳入证据；'
    'ADR 引用检查已按新行号同步（tools/fix_baseline_adr_refs.py + '
    'tools/check_adr_citations.py 通过）；'
    '已知边界：真实浏览器的 ST 未执行（fixture 是 CLI 替身，只建模报告的形状与收到的环境）；'
    '独立的凭据存储本身不在本任务范围内——凭据形态的变量被拒并指向凭据存储，'
    '而不是在这里实现一个凭据存储。'
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

    rid, _rm = find_ats_row(xml2, 'ATS-212')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 4*(1-1) = 0; only the cached value changes.
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-212 note, replacing a previous copy of it. The
    # marker-aware merge keeps every other task's marked block in the same
    # cell and re-emits the blocks in canonical order, so the result does
    # not depend on which updater ran last. The note text is XML-ESCAPED
    # by `set_marked_cell`.
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
    """The ATS-212 row's cells, for the idempotency check."""
    zin = zipfile.ZipFile(XLSX)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-212')
    return rm.group(0)


def verify():
    """Assert the workbook still parses and row ATS-212 is exactly as intended."""
    zin = zipfile.ZipFile(XLSX)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-212')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    assert status == '待审核', f'ATS-212 status is {status!r}, expected 待审核'
    assert rate == '1', f'ATS-212 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-212 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-212 note has {note.count(MARKER)} markers, expected 1'
    assert '环境档案' in note, 'the ATS-212 note is missing the delivered scope'
    print(f'verify: ATS-212 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')


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
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-212'):
            row = r
            break
    assert row is not None, 'the ATS-212 row is not found by openpyxl'
    assert ws.cell(row=row, column=14).value == '待审核', f'column N is {ws.cell(row=row, column=14).value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    # Column P keeps its formula; the cached value is what the sheet carries.
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-212】') == 1, f'column T carries {note.count("【ATS-212】")} markers'
    assert '环境档案' in note, 'column T is missing the delivered scope'
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
            print('IDEMPOTENT: row ATS-212 unchanged')
        else:
            print('CHANGED (first run applied the update)')
        # A second run must be a no-op.
        second_before = row_signature()
        patch_workbook()
        second_after = row_signature()
        assert second_before == second_after, 'the updater is NOT idempotent'
        print('IDEMPOTENT: a second run leaves row ATS-212 byte-identical')
        verify()
        check_parses()
