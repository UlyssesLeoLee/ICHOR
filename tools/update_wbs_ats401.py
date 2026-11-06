"""ATS-401: sync docs/WBS.xlsx 「开发WBS」row for ATS-401.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats101.py: the sheet XML is patched in place and the
zip is rewritten with every other part byte-identical.

ATS-401 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): append the ATS-401 note

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate:

  B8  COUNTIF(N6:N94,"已完成")       -> counted from the sheet
  B9  1-SUM(P)/SUM(K)                -> computed from the sheet
  B10 SUM(P6:P94)                    -> computed from the sheet

NOTE on 状态: 待审核 ("pending review"), NOT 已完成. The deliverable is
submitted but not accepted yet -- the reviewer (Opus) syncs the completion
state after the review passes. Declaring it 已完成 before review would
contradict "不得自行置 done".
"""
import re
import shutil
import zipfile
from pathlib import Path

from wbs_common import cell_number, cell_text, set_cell_in_row, set_marked_cell

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'
SHEET2 = 'xl/worksheets/sheet2.xml'
SHEET1 = 'xl/worksheets/sheet1.xml'

FIRST_ROW, LAST_ROW = 6, 94



def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')




NOTE = (
    '【ATS-401】Agent 契约 v1 已实现并实测（agent-contract/v1）：'
    '请求须带作用域/预算/输入出处，角色对应能力白名单，产出为待审提案，提案人不得自审；'
    '写入与提交类能力（write_source/git_commit/update_expected 等）在请求层一律被拒，'
    '契约层源码只 import node:crypto 与 node:path 且不含任何 I/O 调用（静态检查守护，'
    '并非「物理上无法」；运行时隔离属 ATS-403），'
    'diff 必须符合白名单语法（diff --git（可选）/index/new file mode 100644/---/+++），'
    '白名单里出现的目标路径必须在 scope.outputs 内；'
    '第 3 次复核整改后，解析方式与 git apply 的解析器逐条对齐：'
    'hunk 体按 @@ -a,b +c,d @@ 声明的行数消费，空行计为一行上下文，'
    '旧/新计数同时达标即结束该 hunk、其后的 ---/+++ 另起一段并完整校验，'
    'hunk 体内计数超限即拒；路径必须带 a/ 或 b/ 前缀（git -p1 会剥掉第一段），'
    '+++ /dev/null 一律按删除拒绝；'
    '旧式 rename old/new、copy from/to、similarity index、Index:、上下文 diff 头一律拒绝；'
    '带引号路径按 git 的 C 风格转义完整反转义后判定，非 UTF-8 或含 U+FFFD 即拒；'
    '第 4 次复核整改后，路径解析与 git 逐字节一致：只去掉行尾的那一个 CR（CRLF 换行），'
    '路径中含控制字符（0x00~0x1f、0x7f）或首尾带空白一律拒绝（不做 trim 后放行），'
    '因为 git 读路径时在 CR 处截断、却保留路径尾部的空白；'
    '传统 diff（无 diff --git 头）删空文件按删除拒绝（git 的 --summary 会报 delete <path>），'
    '带 diff --git 头的同类 diff 与只删部分行的传统 diff 仍被接受；'
    '双向差分语料（复核 3 个反例 + 第 4 轮 6 个路径反例 + 合法 diff 的自动变异 + '
    '真实 git diff 输出）上，'
    '校验器与 git apply --numstat --summary 判定一致（该语料上一致，非与 git 完全等价）；'
    '摘要与内容在请求校验层复算比对（/api/agent/validate 与适配器同一判定），'
    '截止时间由 AbortController + Promise.race 强制施加（不 unref，'
    '无其它句柄时亦以 AGENT_BUDGET_EXCEEDED 结束）。'
    'npm test 共 194 项（两个 fixture 依赖装好后）全通过、0 失败、0 跳过；'
    '复现脚本 tools/ats401-probes/probe-agent-boundary.mjs、probe-review-regressions.mjs、'
    'probe-review-regressions-r2.mjs、probe-git-apply-parity.mjs、'
    'probe-git-apply-bidirectional.mjs（含负控），'
    '证据 docs/evidence/ATS-401/。'
    '未实现（不属本项）：模型提供商接入（ATS-403）、API Key 存储与外传知情授权（ATS-402）、'
    '提案落地（应用 diff / 更新 expected / Git 提交）；'
    'FR-024/FR-025 的能力状态仍为 DESIGNED，契约层不等于能力。'
)




def summarise(xml2):
    """Recompute the overview's cached formula values from the sheet itself.

    Mirrors the three formulas that live in the 总览 sheet:
      B8  = COUNTIF('开发WBS'!N6:N94,"已完成")
      B9  = IFERROR(1-SUM('开发WBS'!P6:P94)/SUM('开发WBS'!K6:K94),0)
      B10 = SUM('开发WBS'!P6:P94)
    """
    done = 0
    sum_p = 0.0
    sum_k = 0.0
    for rid in range(FIRST_ROW, LAST_ROW + 1):
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

    rid, _rm = find_ats_row(xml2, 'ATS-401')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: append the ATS-401 note, replacing a previous copy of it.
    # The marker-aware merge keeps every other task's marked block in the
    # same cell and re-emits the blocks in canonical order, so the result
    # does not depend on which updater ran last.
    xml2 = set_marked_cell(xml2, rid, 'T', '【ATS-401】', NOTE)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh the cached values of the existing formulas -----------
    done, rate, sum_p = summarise(xml2)
    xml1 = parts[SHEET1].decode('utf-8')
    xml1 = set_cell_in_row(xml1, 8, 'B', str(done), numeric=True)
    xml1 = set_cell_in_row(xml1, 9, 'B', repr(rate), numeric=True)
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


if __name__ == '__main__':
    main()
