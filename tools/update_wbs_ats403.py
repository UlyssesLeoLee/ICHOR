"""ATS-403: sync docs/WBS.xlsx 「开发WBS」row for ATS-403.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats401.py and tools/update_wbs_ats402.py: the sheet
XML is patched in place and the zip is rewritten with every other part
byte-identical.

ATS-403 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): append the ATS-403 note

NOTE on 状态: 待审核 ("pending review"), NOT 已完成. The deliverable is
submitted but not accepted yet -- the reviewer syncs the completion state
after the review passes. Declaring it 已完成 before review would contradict
"不得自行置 done".

The overview's cached formula results are recomputed FROM THE SHEET rather
than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate. The row range follows the sheet
(wbs_common.totals() derives the last data row), because the sheet grew
when ATS-601 appended the mobile rows.
"""
import re
import shutil
import zipfile
from pathlib import Path

from wbs_common import (cell_number, cell_text, set_cell_in_row, set_marked_cell,
                         set_narrative_cell, totals)

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
    '【ATS-403】可替换模型 API 适配层与错误回退已实现并实测（ai-adapter/v1）：'
    '（1）两种兼容协议——openai-chat 与 anthropic-messages，请求体、响应取文位置'
    '与认证头都各自独立翻译（Bearer vs x-api-key + anthropic-version），'
    '协议层不含任何 I/O，可脱离网络单测。'
    '（2）分层——protocols（协议转换）/ transport（唯一的网络 I/O 层，'
    'AbortController 强制超时，HTTP 状态映射为稳定的 AI_* 错误码）/ provider'
    '（端点、模型、凭据引用、期限）/ fallback（回退链）/ service（编排）'
    '五层各自独立；传输层不做重试——重试与供应商切换是两种语义，不可混用。'
    '（3）外传闸门前置——一次调用的顺序是：ATS-402 外传闸门 → 凭据解析 → '
    'ATS-403 回退链 → ATS-401 契约收敛；没有授权就不读文件、不取密钥、'
    '不发请求，且这次拒绝照常写进外传审计。'
    '（4）密钥只来自凭据库——provider 配置只允许 credentialId（引用），'
    '出现 apiKey/secret 明文或自带 Authorization/x-api-key 一律拒收；'
    '密钥在发请求的那一刻由凭据库取出，只进入认证头，不进 URL、不进请求体、'
    '不进状态文件、不进日志、不进错误消息。'
    '（5）回退只对可恢复错误——只有超时、限流、提供商不可用、提供商服务端错误'
    '（AI_PROVIDER_TIMEOUT / AI_PROVIDER_RATE_LIMITED / AI_PROVIDER_UNAVAILABLE / '
    'AI_PROVIDER_SERVER_ERROR）才切下一个提供商；'
    '鉴权失败（AI_PROVIDER_AUTH_FAILED）、配置非法（AI_PROVIDER_CONFIG_INVALID）、'
    '请求非法（AI_PROVIDER_REQUEST_INVALID）、凭据不可用（AI_CREDENTIAL_UNAVAILABLE）'
    '立即失败，不盲目回退；链上每个提供商最多尝试一次；'
    '链上全败报 AI_FALLBACK_EXHAUSTED，并带上每一次尝试的记录。'
    '（6）失败不污染工作区——适配层不写任何文件：超时、限流、链路失败之后，'
    '项目目录的文件清单与逐文件摘要与调用前完全一致（实测）。'
    '（7）API——GET /api/ai/contract（契约：协议、错误码、可重试错误码、策略）、'
    'GET/POST /api/ai/providers（配置与回退顺序）、DELETE /api/ai/providers/{id}、'
    'POST /api/ai/complete（一次真实调用）、POST /api/ai/egress/check（只判闸门不发请求）；'
    'AI_* 错误码经表驱动映射为 HTTP 状态码，响应带稳定的 error 码与解释，'
    '不靠解析错误消息文本；/api/diagnostics 报告适配层能力与回退顺序。'
    '实测：UT 58 项全通过（tests/ai-adapter.test.mjs，协议 20 / 传输 11 / '
    '提供商 7 / 回退 11 / 服务 9）；IT 13 项全通过（tests/ai-api.test.mjs，'
    '真实起 Bridge：契约暴露、鉴权、明文密钥配置被拒且未落库、无授权时请求'
    '在到达提供商之前就被拒并被审计、有授权时调用确实到达提供商）；'
    '边界探针 37 项全通过（含 5 个负控：静态规则的故意写坏副本、'
    '永远放行的闸门、往项目里写文件的坏提供商，'
    'node tools/ats403-probes/probe-ai-boundary.mjs）；'
    'npm test 全量 1546 项 0 失败（新增 71 项 ATS-403 用例）；'
    '依赖清单校验通过；证据 docs/evidence/ATS-403/。'
    '未实现（不属本项）：用真实模型与真实密钥做端到端验证（本次只用注入的 '
    'fetch 做确定性验证，未持任何真实密钥、未向任何真实服务商发过请求）；'
    '模型输出落地（应用 diff、更新 expected、Git 提交）仍属后续任务，'
    '仓库中仍不存在把模型输出写入仓库的代码路径；'
    '运行时的模块沙箱/只读挂载/子进程隔离（ATS-403 的运行时隔离部分，'
    '本次交付的是适配层本身）尚未实现；'
    '不得声称「AI 能读取你的项目」——没有外传授权时文件根本不会离开本机。'
)


def summarise(xml2):
    """Recompute the overview's cached formula values from the sheet itself.

    Mirrors the three formulas that live in the 总览 sheet:
      B8  = COUNTIF('开发WBS'!N6:N94,"已完成")
      B9  = IFERROR(1-SUM('开发WBS'!P6:P94)/SUM('开发WBS'!K6:K94),0)
      B10 = SUM('开发WBS'!P6:P94)

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

    rid, _rm = find_ats_row(xml2, 'ATS-403')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: append the ATS-403 note, replacing a previous copy of it.
    # The marker-aware merge keeps every other task's marked block in the
    # same cell and re-emits the blocks in canonical order, so the result
    # does not depend on which updater ran last.
    xml2 = set_marked_cell(xml2, rid, 'T', '【ATS-403】', NOTE)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: rewrite the narrative cells from the fragments ---------------
    # The narrative cells are the composition of EVERY task's marked fragment,
    # so the ATS-403 fragment is applied here and the other tasks' fragments
    # survive untouched.
    xml1 = parts[SHEET1].decode('utf-8')
    xml1 = set_narrative_cell(xml1, 6, 'D6')
    xml1 = set_narrative_cell(xml1, 7, 'D7')

    # --- 总览: refresh the cached values of the existing formulas -----------
    done, rate, sum_p = summarise(xml2)
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

    # --- the derived totals must agree with the sheet ----------------------
    print('totals:', totals())


if __name__ == '__main__':
    main()
