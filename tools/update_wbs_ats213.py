"""ATS-213: sync docs/WBS.xlsx 「开发WBS」row for ATS-213.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats401.py: the sheet XML is patched in place and the
zip is rewritten with every other part byte-identical.

ATS-213 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): append the ATS-213 note

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate.

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
    '【ATS-213】OS Keychain/Windows Credential Manager 集成已实现并实测（Windows Credential Manager 真机实测）：'
    '密钥本体只写系统凭据库，平台索引只留引用与 8 位指纹，凭据库不可用即拒绝（无明文回退）；'
    '新增凭据「可用状态」面：状态是三值闭集且每条引用恰有一个——'
    'configured（已配置，凭据库里取得到）、not-configured（未配置，凭据库里没有这一条）、'
    'unavailable（取不到，凭据库本身不可用或读失败）；'
    '状态是**测出来的**而不是从索引推断的：索引与凭据库会分叉（用户在系统凭据管理器里删了条目，'
    '索引还留着引用），从索引推断会报出「已配置」的假状态，使用者真正要用时才失败；'
    '「未配置」与「取不到」不合并——前者要重新录入密钥，后者是环境问题，处置完全不同；'
    '取失败不静默降级：报出原因码（CREDENTIAL_FOUND / CREDENTIAL_NOT_FOUND / '
    'CREDENTIAL_STORE_UNAVAILABLE / CREDENTIAL_STORE_FAILED），不吞异常、不假装成功；'
    '原因码是封闭词汇表，调用方按它分支，不解析消息文本；'
    '界面上每条密钥都显示状态词（已配置/未配置/取不到）与原因，状态不只靠颜色区分；'
    '状态**测不出来**时（状态接口读取失败）界面报「可用状态读取失败」，'
    '而不是把没测到的状态渲染成「未配置」——那会是一个没人测过的断言；'
    '状态响应只含 id/名称/用途/提供方/指纹/状态/原因/时间，不含密钥也不含密钥片段；'
    '修掉一个真实泄漏：请求体 JSON 解析失败时，V8 的解析错误消息会带上原始输入的一小段，'
    '而 POST /api/security/credentials 的请求体里正是密钥——实测密钥前 10 个字符出现在 HTTP 响应体里，'
    '现在解析失败统一报 INVALID_REQUEST_BODY（不含输入内容的码）；'
    '用例：Node UT 12 例（tests/credential-status.test.mjs）+ IT 9 例（tests/credential-status-api.test.mjs，'
    '含真实 Windows Credential Manager 的存取、状态与文件扫描）全通过；'
    '边界探针 9 项检查 + 2 项负控（tools/ats213-probes/probe-credential-boundary.mjs）全通过：'
    '密钥不进 argv、不进文件、不进日志与 HTTP 响应；'
    '系统测试 11 项检查（tools/ats213-probes/st-ats213.mjs，真实 Bridge + 真实 Chromium）全通过，'
    '其中「状态是测出来的」是在真实系统凭据库里删掉条目后、平台索引仍留着引用时实测的；'
    'Next.js 16.4.5 静态导出构建实测通过，tsc --noEmit 通过；'
    '未实现（不属本项）：macOS Keychain / Linux Secret Service 后端代码已写但**未在真机实测**、'
    'Tauri 壳内存取未验证（src-tauri/src/lib.rs 未改动，本机 cargo build 因 B-02 仍无法出包）；'
    '证据：docs/evidence/ATS-213/。'
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

    rid, _rm = find_ats_row(xml2, 'ATS-213')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: append the ATS-213 note, replacing a previous copy of it.
    # The marker-aware merge keeps every other task's marked block in the
    # same cell and re-emits the blocks in canonical order, so the result
    # does not depend on which updater ran last.
    xml2 = set_marked_cell(xml2, rid, 'T', '【ATS-213】', NOTE)

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
