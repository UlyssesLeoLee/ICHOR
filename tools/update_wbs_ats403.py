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
    '协议层不含任何 I/O，可脱离网络单测；anthropic 的指令进 system、输入进 user '
    '消息（不分列到同一段），temperature 总是发送（含 0），取值范围限定 0..1。'
    '（2）分层——protocols（协议转换）/ transport（唯一的网络 I/O 层，'
    'AbortController 强制超时，HTTP 状态映射为稳定的 AI_* 错误码）/ provider'
    '（端点、模型、凭据引用、期限）/ fallback（回退链）/ service（编排）'
    '五层各自独立；传输层不做重试——重试与供应商切换是两种语义，不可混用。'
    '（3）外传闸门前置且载荷与授权绑定——一次调用的顺序是：ATS-402 外传闸门 → '
    '凭据解析 → ATS-403 回退链；没有授权就不读文件、不取密钥、不发请求，'
    '且这次拒绝照常写进外传审计；第 2 轮起「发出去的就是被授权的那一份」——'
    '发给提供商的输入取自闸门读出并复算过摘要的 verdict.inputs，'
    '调用方自带的 request.inputs[].content 一律不采用；'
    '/api/ai/complete 只使用已配置的提供商，请求体里带 providers/baseUrl 一律拒绝'
    '（否则调用方可以自选目的地）；因此外传审计记录的 items 与实际发出的内容必然一致。'
    '（4）密钥只来自凭据库——provider 配置只允许 credentialId（引用），'
    '出现 apiKey/secret 明文一律拒收；配置里的额外请求头是一份白名单'
    '（anthropic-version/openai-organization/openai-project/x-request-id/'
    'x-correlation-id/x-tenant），认证类请求头（Authorization/x-api-key/api-key/'
    'x-goog-api-key 等）全部进不来；密钥在发请求的那一刻由凭据库取出，'
    '只进入认证头；提供方错误正文里回显的密钥会在传输层按本次解析出的那把密钥'
    '抹掉（redactSecret），因此密钥不进 URL、不进请求体、不进状态文件、'
    '不进日志、也不进错误消息与 details.attempts[].reason。'
    '（5）提供商的配置在写盘前被完整校验——POST /api/ai/providers 先跑 '
    'validateProtocolConfig，非 http(s) 端点、非法 maxTokens、非法凭据引用、'
    '不在白名单里的请求头一律 400 且绝不落库；落库的是校验后的（归一化后的）配置。'
    '（6）回退只对可恢复错误——超时、限流、提供商不可用、提供商服务端错误、'
    '以及回答不可用（AI_PROVIDER_OUTPUT_INVALID，截断通常是该提供商的输出上限'
    '造成的）才切下一个提供商；鉴权失败、配置非法、请求非法、凭据不可用'
    '立即失败；链上每个提供商最多尝试一次；链上全败且每次原因相同时报那个原因'
    '（例如 429/504/503），原因不一致才报 AI_FALLBACK_EXHAUSTED。'
    '（7）步数预算与截止时间——maxSteps 是硬约束：步数用尽即 AI_STEPS_EXCEEDED，'
    '而不可回退的错误保留自己的错误码（不再一律改标成步数用尽）；'
    '设了截止时间时，回退链把剩余时间分给链上还没试的提供商，'
    '因此一个挂起的提供商不会吃掉整个预算。'
    '（8）外传审计不可用时不外发——审计存储缺失时闸门不做出决定'
    '（allowed 为 null，AI_AUDIT_UNAVAILABLE，HTTP 503），complete 因此不发请求；'
    '「没有审计存储就不外发」是代码里的显式检查。'
    '（9）失败不污染工作区——适配层不写任何文件：超时、限流、链路失败之后，'
    '项目目录的文件清单与逐文件摘要与调用前完全一致（UT 与 IT 都有断言，'
    '且断言了错误码，不吞异常）。'
    '（10）API——GET /api/ai/contract（契约：协议、错误码、可重试错误码、'
    'statusByCode 状态表、策略）、GET/POST /api/ai/providers（配置与回退顺序）、'
    'DELETE /api/ai/providers/{id}、POST /api/ai/complete（一次真实调用）、'
    'POST /api/ai/egress/check（只判闸门不发请求）；'
    'AI_* 错误码经表驱动映射为 HTTP 状态码，响应带稳定的 error 码与解释，'
    '不靠解析错误消息文本；状态表由代码直接发布，文档不再需要人工同步。'
    '实测（第 2 轮）：UT 75 项全通过（tests/ai-adapter.test.mjs）；'
    'IT 20 项全通过（tests/ai-api.test.mjs，真实起 Bridge + 回环假提供商：'
    '被授权内容才被发出、请求体自带提供商被拒、认证类请求头被拒且未落库、'
    '非法配置被拒且未落库、429 与超时后工作区逐字节不变、'
    '回显密钥被脱敏、状态码与发布的状态表一致）；'
    '边界探针 37 项全通过；第 2 轮回归探针 23 项全通过'
    '（tools/ats403-probes/probe-ai-round2.mjs：第 1 轮复核的每一条反例'
    'P1/P2/P3a/P3b/P3c/P4/P5/P6/P7/S1/S2/S3/S4/S4b/S5 都固化成了检查，'
    '外加 4 个负控）；npm test 全量 0 失败；依赖清单校验通过；'
    '证据 docs/evidence/ATS-403/。'
    '未实现（不属本项）：用真实模型与真实密钥做端到端验证（本次只用注入的 '
    'fetch 与回环假端点做确定性验证，未持任何真实密钥、未向任何真实服务商发过请求）；'
    '与 ATS-401 契约层的接线（complete 不经过契约层，asContractProvider 无调用方）；'
    '模型输出落地（应用 diff、更新 expected、Git 提交）仍属后续任务；'
    '运行时的模块沙箱/只读挂载/子进程隔离尚未实现；'
    '外传授权与目的地的绑定（同意书绑定内容，不绑定目的地）建议另立跟进项；'
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
