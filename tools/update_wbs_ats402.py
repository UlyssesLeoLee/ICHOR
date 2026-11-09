"""ATS-402: sync docs/WBS.xlsx 「开发WBS」row for ATS-402.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats401.py: the sheet XML is patched in place and the
zip is rewritten with every other part byte-identical.

ATS-402 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): append the ATS-402 note

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate:

  B8  COUNTIF(N6:N94,"已完成")       -> counted from the sheet
  B9  1-SUM(P)/SUM(K)                -> computed from the sheet
  B10 SUM(P6:P94)                    -> computed from the sheet

NOTE on 状态: 待审核 ("pending review"), NOT 已完成. The deliverable is
submitted but not accepted yet -- the reviewer syncs the completion state
after the review passes. Declaring it 已完成 before review would contradict
"不得自行置 done".
"""
import re
import shutil
import zipfile
from pathlib import Path

from wbs_common import (cell_number, cell_text, set_cell_in_row, set_marked_cell,
                         set_narrative_cell)

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
    '【ATS-402】AI 数据安全三道闸门已实现并实测（credential-store/v1 + egress-consent/v1 + '
    'egress-audit/v1）：'
    '（1）密钥存储——密钥本体只写系统凭据库（Windows Credential Manager 已实测；macOS Keychain / '
    'Linux Secret Service 代码已写、未实测），本机索引文件只存引用与 8 位指纹，秘密经 stdin/stdout 传给 '
    'helper 进程（不进 argv、不进日志），凭据库不可用即报 CREDENTIAL_STORE_UNAVAILABLE，'
    '没有明文文件回退；Windows 后端经 advapi32 CredWriteW/CredReadW 实测，'
    'helper 在 finally 里把整块秘密内存（全部字节）清零；写入与删除经进程内互斥锁串行，'
    '凭据库里已不存在的条目 remove 视为成功并清掉引用，后端错误统一规整为 CREDENTIAL_* 契约码（写失败 503）。'
    '（2）数据外传知情授权——三步 preview（展示范围）→ confirm（携带一次性 previewId）→ '
    'granted 授权记录；范围摘要由平台侧读真实文件并复算，preview/confirm/check 共用同一个范围解析器'
    '（file/requirement/run；realpath + 根内判定，requirement 限于 .aitest，绝对路径与盘符一律拒），内容一变授权即失效（EGRESS_CONSENT_SCOPE_MISMATCH），'
    '可撤销且撤销即刻生效（EGRESS_CONSENT_REVOKED），可过期（EGRESS_CONSENT_EXPIRED），'
    '可拒绝（EGRESS_CONSENT_REQUIRED）；确认时若范围与预览不一致即报 '
    'EGRESS_PREVIEW_STALE，previewId 不可复用。'
    '（3）外传审计——每一次外传判定（放行与拒绝都算）都写入审计记录，'
    '记录只含 ref、字节数与 SHA-256 摘要（拒绝记录只含请求的 kind/ref），不含内容、不含密钥，追加写、'
    '拒绝/放行/授权三类各 500 条互不挤占、跨重启保留；/check 里的每一次拒绝（含范围解析失败）都写 egress.denied，'
    '越权外传因此既被拦截也被留痕。授权列表的状态反映过期（expired）。'
    '实测：UT 76 项全通过（tests/security.test.mjs 41 + security-credentials.test.mjs 20 + '
    'security-gate.test.mjs 15，进程内、注入后端）；server/security 四个文件行覆盖率均大于 90%'
    '（credentials 97.57、egress-audit 98.97、egress-consent 92.16、egress-gate 98.44）；'
    'IT 32 项（ATS402_REAL_CREDENTIAL_STORE=1 时 32 项全通过，'
    '未设该标志时 4 项真实凭据库用例如实标为 SKIPPED，'
    'node --test tests/security-api.test.mjs）；评审第 1 轮的三份反例探针在本树上全部 RESULT: OK；'
    '「AI 数据安全」页签已在真实浏览器（Edge headless）里点过，ui-e2e 18 项通过；'
    '边界探针 39 项全通过（含 4 个负控：明文回退后端、永远放行的闸门、'
    '不落盘的审计存储、静态规则的故意写坏副本，'
    'node tools/ats402-probes/probe-security-boundary.mjs）；'
    'npm test 全量 0 失败；npx tsc --noEmit 无错；next build 产出静态导出；'
    'ATS-101 端口审计、ADR 引用校验、ATS-401 Agent 边界探针、ATS-501 协议审计全部通过；'
    '证据 docs/evidence/ATS-402/。'
    '未实现（不属本项）：模型提供商接入与用密钥调用真实模型（ATS-403）、'
    'Tauri 壳内的凭据存取（ATS-104 的 B-02 链）、macOS/Linux 凭据库后端的真机实测、'
    '外传审计的外部防篡改（本地高权限可改 state.json）、授权未绑定项目、'
    'ST-032（其「触发外传」与「网络抓包」需要真实外发路径，仓库没有，仍为 PENDING；'
    'ST-031 与 ST-033 已在真实浏览器里执行并通过）；'
    '不得声称「AI 能读取你的项目」——本任务交付的是存取与闸门本身。'
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

    rid, _rm = find_ats_row(xml2, 'ATS-402')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: append the ATS-402 note, replacing a previous copy of it.
    # The marker-aware merge keeps every other task's marked block in the
    # same cell and re-emits the blocks in canonical order, so the result
    # does not depend on which updater ran last.
    xml2 = set_marked_cell(xml2, rid, 'T', '【ATS-402】', NOTE)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: rewrite the narrative cells from the fragments ---------------
    # The narrative cells are the composition of EVERY task's marked fragment,
    # so the ATS-402 fragment is applied here and the other tasks' fragments
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


if __name__ == '__main__':
    main()
