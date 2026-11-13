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

from wbs_common import read_parts, set_cell_in_row, set_marked_cell, totals

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
    '【ATS-213】密钥仅以引用传递 + 凭据可用状态面（Windows Credential Manager 真机实测）：'
    '环境档案的凭据形状变量只接受**凭据引用**（{"credentialRef":"cred_…"} 或 cred:…），'
    '明文仍被拒；运行启动时平台把引用解析成密钥注入**封口**的 runner 环境，'
    '档案、运行记录、事件日志、SQLite 镜像与证据归档里只有引用与变量名、没有密钥；'
    '引用解析**只在一个收口点**发生（单次运行与批次里的每一次运行都经过它），'
    '未解析的引用**拒绝启动**（不 String() 成 "[object Object]"）并报 CREDENTIAL_* 原因码，'
    '不在缺少密钥的情况下静默运行；'
    '注入的密钥在**落盘前脱敏**：平台的 stdout/运行记录/事件、report.json、'
    'error-context.md、HTML 报告内嵌的 base64 zip、证据归档、SQLite 镜像与 state.json '
    '里都是固定掩码而不是明文，脱敏**跨分块**（一个密钥不会被切成两块而漏掉）；'
    'trace/截图/视频是平台改不掉的**二进制边界**，写进 docs/32 §6.5 并记在运行记录的 '
    'redaction 字段里；'
    '可用状态是三值闭集且每条引用恰有一个——'
    'configured（已配置）、not-configured（未配置）、unavailable（取不到）；'
    '状态是对系统凭据库实测的而不是从索引推断的，'
    '**走 probe 而不读明文**（status()/statusAll() 不调用 read()，read() 只用于注入环境）；'
    '未配置与取不到不合并；取失败不静默降级，报出封闭原因码；'
    '整张状态清单基于**同一份索引快照**，单条异常（读失败 / 条目 id 不合规）不拖垮整张清单，'
    '遍历中被删除的引用被跳过；'
    '凭据库的「可用」是**实测**的（真的调一次凭据库），不是「helper 脚本在不在」的推断；'
    '状态测不出来时界面报「可用状态读取失败」、**清空**旧状态（不冒充当前状态、不计入可用密钥），'
    '引用照样显示且删除按钮还在；'
    '状态响应只含 id/名称/用途/提供方/指纹/状态/原因/时间，不含密钥也不含密钥片段；'
    '请求体 JSON 解析失败统一报 INVALID_REQUEST_BODY（不含输入内容的码）；'
    '用例：Node UT 17 例（tests/credential-status.test.mjs）+ 收口与脱敏 UT 16 例'
    '（tests/credential-reference-boundaries.test.mjs）+ IT 9 例（tests/credential-status-api.test.mjs）'
    '+ 凭据引用 IT 5 例（tests/credential-reference-api.test.mjs）'
    '+ 落盘脱敏 IT（tests/credential-redaction-api.test.mjs，真实凭据库 + 真实 Playwright 运行，'
    '被测脚本断言失败后数据目录 0 命中）；'
    '真实浏览器系统测试：状态面 11 项（tools/ats213-probes/st-ats213.mjs）、'
    '失败路径 10 项（tools/ats213-probes/st-credential-status-failures.mjs）、'
    '凭据引用端到端 10 项（tools/ats213-probes/st-credential-ref.mjs，真实 Playwright 运行 + '
    '真实 Windows Credential Manager，被测脚本断言密钥的 SHA-256 摘要与长度）；'
    '变异体探针（tools/ats213-probes/probe-credential-status-mutants.mjs、'
    'probe-credential-redaction-mutants.mjs）证明新增的检查在缺陷存在时变红；'
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

    THE ROW RANGE FOLLOWS THE SHEET, not a hardcoded constant. The sheet grew
    when ATS-601 appended the mobile rows (the last data row is now 100), so
    a derivation over the old constant would leave the cached 总览 value
    disagreeing with its own formula -- and two updaters would then report
    DIFFERENT totals for the SAME workbook.

    The shared helper `wbs_common.totals()` already derives the range from
    the sheet, so this function DELEGATES to it instead of computing the
    range a second time: one derivation, one answer.
    """
    parts = read_parts()
    derived = totals(parts)
    return derived['completed'], derived['completion_rate'], derived['sum_remaining']


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
