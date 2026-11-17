"""ATS-410: sync docs/WBS.xlsx 「开发WBS」row for ATS-410.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats403.py: the sheet XML is patched in place and the
zip is rewritten with every other part byte-identical.

ATS-410 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 7 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): append the ATS-410 note

NOTE on 状态: 待审核 ("pending review"), NOT 已完成. The deliverable is
submitted but not accepted yet -- the reviewer syncs the completion state
after the review passes. Declaring it 已完成 before review would contradict
"不得自行置 done".

The row range follows the SHEET (the sheet grew when ATS-601 appended the
mobile rows), so the summary stays correct no matter what other rows already
carry a non-zero completion rate.

THE NOTE MUST NOT OVERCLAIM
---------------------------
The ATS-410 note says what was MEASURED and what was NOT:

  * the triage core IS implemented and measured (classification, evidence
    refs, suspect changes, read-only boundary);
  * the model end-to-end path is NOT verified -- no provider is configured on
    this machine and no real credential exists.

The note therefore does NOT say "AI 诊断已实现". It says what is implemented.
"""
import re
import shutil
import zipfile
from pathlib import Path

from wbs_common import (cell_number, cell_text, format_rate, set_cell_in_row,
                         set_marked_cell, set_narrative_cell, totals)

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'
SHEET2 = 'xl/worksheets/sheet2.xml'
SHEET1 = 'xl/worksheets/sheet1.xml'

FIRST_ROW = 6


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


NOTE = (
    '【ATS-410】失败归因内核与 API 面已实现并实测（triage/v1）：'
    '（1）归因内核是**确定性**的，不是「把报错丢给模型」——同一份证据必然得到'
    '同一个分类，因为验收标准要求「每条推断附可核对来源」，而不可复现的归因'
    '没有来源可核对；模型增强是**可选叠加**层，不参与决定分类。'
    '（2）分类是**封闭集合**四类：脚本/产品/环境/不确定。'
    '环境类（超时、网络）不区分脚本与产品；断言类要区分脚本与产品，'
    '唯一的信息来源是**代码变更历史**——断言文本本身分不出「期望值写错了」'
    '与「实现错了」。'
    '（3）**历史闸门是承重的那一步**：断言类失败在没有可比的 commit 历史时'
    '落在「不确定」，**不**落在产品——把「没有证据」当成「证据指向产品」，'
    '会让归因系统在没有证据时系统性冤枉产品代码。'
    '（4）**每条结论都有可核对的来源**：证据引用带 kind/ref/digest/detail，'
    '摘要取自「可观察事实」的规范 JSON（键排序），读者能自己重算；'
    '引用不在本次归因范围内的运行、或指向不存在的用例，一律拒绝'
    '（TRIAGE_EVIDENCE_OUT_OF_SCOPE / TRIAGE_EVIDENCE_NOT_FOUND）；'
    '没有证据引用的结论直接拒绝（TRIAGE_EVIDENCE_REQUIRED）；'
    '证据引用里不出现本机绝对路径。'
    '（5）**可疑变更**有具体定义：两次运行的 gitCommit 不同、且失败用例所在的'
    '**测试脚本文件**在两次提交之间改过。产品代码的改动**不**算可疑变更'
    '（它可能是修复也可能是缺陷，正是归因要判断的对象）；同一 commit 的两次'
    '运行不可比（同 commit 的结果差异是 flaky，不是变更引起的）。'
    '差异建议只给「哪些文件改了」，**不含**修复动作、**不含**要改的断言。'
    '（6）**只读**：归因不写文件、不改断言、不更新 expected、不提交——'
    '内核不 import 任何写入接口、不 spawn 进程，Git 历史由注入的读取器提供'
    '（静态检查守护，带负控）；一次完整归因后运行记录逐字节不变（实测）。'
    '（7）API 面：GET /api/ai/triage/contract（契约：四类、判据、证据规则、'
    '只读策略）与 POST /api/ai/triage（对一次运行归因）。'
    '**未用真实模型端到端验证**——本机没有配置任何模型提供商、也没有真实凭据，'
    '因此 modelEnhanced=true 会以 TRIAGE_MODEL_UNAVAILABLE 报错，'
    '**不**静默退化成确定性结果；已实测的是归因内核本身（46 项 UT/IT + '
    '17 项边界探针，含 4 条负控）。'
    '（8）**已知缺陷（不属本任务）**：ATS-401 契约层的 scope.runs 只接受旧形态 '
    'run_<uuid>（server/agent.mjs 的 RUN_ID 正则），而当前运行 ID 是 '
    'run_1_<24 hex>；因此归因模块不使用 ATS-401 的 scope.runs 校验，'
    '改按 server/core.mjs 的 isValidRunId() 判定。修这个差异属 ATS-401 的'
    '契约层变更。详见 docs/34-TRIAGE-DIAGNOSIS.md §8。'
)


def summarise(xml2):
    """Recompute the overview's cached formula values from the sheet itself.

    Mirrors the three formulas that live in the 总览 sheet:
      B8  = COUNTIF('开发WBS'!N6:N<last>,"已完成")
      B9  = IFERROR(1-SUM('开发WBS'!P6:P<last>)/SUM('开发WBS'!K6:K<last>),0)
      B10 = SUM('开发WBS'!P6:P<last>)

    The row range follows the SHEET (the sheet grew when ATS-601 appended the
    mobile rows), so the cached value always agrees with the formula that
    produced it.
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
        sum_p += cell_number(xml2, rid, 'P')
        sum_k += cell_number(xml2, rid, 'K')
    rate = 0.0 if sum_k == 0 else 1 - sum_p / sum_k
    return done, rate, sum_p


def main():
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-410')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 7*(1-1) = 0; only the cached value changes.
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: append the ATS-410 note, replacing a previous copy of it.
    # The marker-aware merge keeps every other task's marked block in the
    # same cell and re-emits the blocks in canonical order, so the result
    # does not depend on which updater ran last.
    xml2 = set_marked_cell(xml2, rid, 'T', '【ATS-410】', NOTE)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: rewrite the narrative cells from the fragments ---------------
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

    # --- the derived totals must agree with the sheet ----------------------
    print('totals:', totals())


if __name__ == '__main__':
    main()
