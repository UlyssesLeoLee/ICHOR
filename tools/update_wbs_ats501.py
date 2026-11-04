"""ATS-501: sync docs/WBS.xlsx with the frozen remote protocol baseline.

Surgical edit of the existing workbook (no openpyxl / no rebuild):
  开发WBS (sheet2):
    - ATS-501 row: 状态 -> 待审核, 完成率 -> 1, 剩余人日 -> formula-driven 0
    - the ATS-501 风险/说明 cell carries the frozen protocol's scope note
    - the S5 downstream rows (ATS-502/503/504/506/507/508/509/511/512) are
      annotated with the constraint this protocol imposes on them
  总览 (sheet1):
    - refresh the cached values of the existing formulas (B8/B9/B10) so a reader
      that does not recalculate still sees the right numbers
    - extend the narrative cells D6/D7 with the remote protocol's status

Every other row, formula, style and the data validation lists stay byte-identical.

NOTE on 状态: ATS-501 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is frozen and submitted, but it has not been accepted yet -- the
reviewer (Opus) syncs 已完成/完成率 after the review passes. Declaring it
已完成 before review would contradict "不得自行置 done".
"""
import re
import shutil
import zipfile
from pathlib import Path

from wbs_common import (SHEET1, SHEET2, cell_text, format_rate,
                        set_cell_in_row, set_marked_cell, totals)

XLSX = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'

MARKER = '【ATS-501】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script.
TERMINAL_STATUSES = ('已完成', '已取消')


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def annotate_note(xml, rid, note):
    """Append this script's marked note to cell T<rid>, replacing a previous copy."""
    return set_marked_cell(xml, rid, 'T', MARKER, note)


def main():
    shutil.copy2(XLSX, XLSX.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(XLSX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    # --- ATS-501: 状态 / 完成率 / 剩余人日 -----------------------------------
    rid, _rm = find_ats_row(xml2, 'ATS-501')
    # A re-run must not undo an accepted review. Only a row that has not been
    # accepted yet is set to 待审核.
    if cell_text(xml2, rid, 'N') not in TERMINAL_STATUSES:
        # 待审核 is one of the six values in the N-column data-validation list.
        xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # --- annotate the protocol's scope note and the downstream contracts -----
    # The script is idempotent: a marker identifies the note this script owns,
    # so re-running replaces it instead of appending a second copy.
    notes = {
        'ATS-501': '远程协议/ADR 已冻结于 docs/18-REMOTE-RUNNER-PROTOCOL.md：信任边界、认证、版本握手、租户隔离、拒绝规则五项验收要素齐备，机读契约块可由 tools/ats501-probes/audit-remote-protocol.mjs 校验；远程执行面在本任务范围内无任何实现，全部标记 DESIGNED',
        'ATS-502': '须落实 ATS-501 契约：dispatch/cancel/result 必填幂等键（同键同体返回首次结果、同键异体拒绝 REMOTE_IDEMPOTENCY_CONFLICT）、deadline 强制、租约与心跳；拒绝码用 REMOTE_ 命名空间',
        'ATS-503': '须落实 ATS-501 契约：一次性 enrollment token（TTL 900 秒、单次、绑定租户）换 Ed25519 密钥对，请求签名覆盖 method/path/bodySha256/timestamp/nonce，随机数重放窗口 300 秒；协议 major 严格相等、minor 最小值约束、能力按名协商（不兼容即拒绝 REMOTE_PROTOCOL_MISMATCH）',
        'ATS-504': '须落实 ATS-501 契约：跨平面消息禁本地绝对路径与秘密明文（只允许 secretRef），项目只以不透明 UID 引用，代码版本用完整 Git SHA，资源配额随作业下发，作业结束清理工作树；节点与租户一对一绑定',
        'ATS-505': '须落实 ATS-501 契约：CI 回调按幂等键去重，重复 webhook 安全幂等',
        'ATS-506': '须落实 ATS-501 硬边界 HB-1/HB-7：控制平面不得直接调用本地桌面 API、不得直接读 Runner 节点文件系统、不得把本地路径当项目引用；本地凭据不进入远程消息',
        'ATS-507': '须落实 ATS-501 契约：用户侧令牌过期或撤销即拒绝（REMOTE_UNAUTHENTICATED），无 token 不得查看任何团队数据',
        'ATS-508': '须落实 ATS-501 契约：租户上下文由服务端从会话推导（客户端指定即 REMOTE_TENANT_MISMATCH），无租户上下文一律拒绝；跨租户访问统一按 404 处理以免泄漏存在性；每次拒绝产生审计事件',
        'ATS-509': '须落实 ATS-501 契约：存储前缀 tenant/{tenantId}/{projectUid}/{runUid}/ 强制生效，上传校验 SHA-256，类型按探测而非节点声明',
        'ATS-511': '须落实 ATS-501 契约：消息信封与 REMOTE_ 拒绝码表必须进入对外 API 契约',
        'ATS-512': '须落实 ATS-501 契约：插件不得绕过审计与证据链路，不得请求超出 Manifest 声明的权限',
    }
    for ats, note in notes.items():
        rid, _rm = find_ats_row(xml2, ats)
        xml2 = annotate_note(xml2, rid, note)

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: refresh cached formula results + the two narrative cells ------
    # The cached values are DERIVED from the sheet that was just written, not
    # hardcoded: a hardcoded cache is stale as soon as another script changes
    # a row, and the 总览 would then silently disagree with the 开发WBS.
    xml1 = parts[SHEET1].decode('utf-8')
    derived = totals(parts)
    xml1 = set_cell_in_row(xml1, 8, 'B', str(derived['completed']), numeric=True)
    xml1 = set_cell_in_row(
        xml1, 9, 'B', format_rate(derived['completion_rate']), numeric=True)
    xml1 = set_cell_in_row(
        xml1, 10, 'B', repr(int(derived['sum_remaining'])), numeric=True)
    # D7 is shared with the ATS-101 updater, which owns the unmarked text of
    # that cell. This script's note is a marked block, so the ATS-101 text
    # stays untouched and both survive a re-run in either order.
    xml1 = set_marked_cell(
        xml1, 7, 'D', MARKER,
        '远程执行面尚无实现，ATS-501 只冻结协议与威胁模型；'
        '详见 docs/18-REMOTE-RUNNER-PROTOCOL.md。')
    parts[SHEET1] = xml1.encode('utf-8')

    # --- rewrite the archive, preserving every other part byte-for-byte ------
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
