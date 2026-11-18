"""ATS-308: sync docs/WBS.xlsx 「开发WBS」row for ATS-308.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats410.py: the sheet XML is patched in place and
the zip is rewritten with every other part byte-identical.

ATS-308 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): append the ATS-308 note

NOTE on 状态: 待审核 ("pending review"), NOT 已完成. The deliverable is
submitted but not accepted yet -- the reviewer syncs the completion state
after the review passes. Declaring it 已完成 before review would contradict
"不得自行置 done".

The row range follows the SHEET (the sheet grew when ATS-601 appended the
mobile rows), so the summary stays correct no matter what other rows already
carry a non-zero completion rate.

THE NOTE MUST NOT OVERCLAIM
---------------------------
The ATS-308 note says what was MEASURED and what was NOT:

  * the indexer IS implemented and measured (the classifier, the report,
    the two read-only importers);
  * the report is NOT a repair tool -- the broken links are REPORTED and
    left alone, on purpose;
  * the section-reference verification is NOT implemented;
  * the import of a project's OWN design baseline (as opposed to the
    platform's) is NOT implemented.

The note therefore does NOT say "设计资料导入已全部完成". It says what is
implemented and measured.

THE MEASURED FIGURES ARE DERIVED, NOT RE-TYPED
----------------------------------------------
The note quotes the measured figures (the number of references, the
per-verdict breakdown, the number of resolved references that were checked
against the filesystem). Those figures used to be typed into this file, and
they went stale the moment another ticket added a document to `docs/`:
the note kept saying 43 documents / 1205 references / 1058 resolved while
the tree measured something else.

So the figures are READ FROM THE COMMITTED PROBE LOG
(`docs/evidence/ATS-308/04-probe-design-import.log`) and formatted into the
sentence. The number in the workbook cell is therefore the number the
committed log carries -- by construction, not by a re-typed constant.

If the log is missing, or does not carry a figure, the updater REFUSES to
write: a note it cannot back up must not be written into the workbook.
"""
import re
import shutil
import zipfile
from pathlib import Path

from wbs_common import (cell_number, cell_text, format_rate, set_cell_in_row,
                         set_marked_cell, set_narrative_cell, totals)

ROOT = Path(__file__).resolve().parents[1]
XLSX = ROOT / 'docs' / 'WBS.xlsx'
SHEET2 = 'xl/worksheets/sheet2.xml'
SHEET1 = 'xl/worksheets/sheet1.xml'
PROBE_LOG = ROOT / 'docs' / 'evidence' / 'ATS-308' / '04-probe-design-import.log'

FIRST_ROW = 6


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def probe_figures(log_path=None):
    """The measured figures, READ FROM THE COMMITTED PROBE LOG.

    The probe log is the authority on what the design baseline holds. The
    note's figures are formatted from here, so they cannot drift away from
    the log they claim to describe.

    Returns a dict with `design` (the number of design documents), `asset`
    (the number of tracking assets), the per-verdict counts and `total`.
    """
    path = Path(log_path) if log_path is not None else PROBE_LOG
    if not path.exists():
        raise SystemExit(
            'the probe log %s does not exist -- the note\'s measured figures are '
            'derived from it, so the updater refuses to write a note it cannot '
            'back up' % path)
    text = path.read_text(encoding='utf-8')

    def number(pattern, label):
        m = re.search(pattern, text, re.M)
        if not m:
            raise SystemExit(
                'the probe log %s does not carry the %s figure -- the note\'s '
                'measured figures are derived from it, so the updater refuses to '
                'write' % (path, label))
        return int(m.group(1))

    out = {
        'resolved': number(r'^\s*resolved\s*:\s*(\d+)\s*$', 'resolved reference count'),
        'ambiguous': number(r'^\s*ambiguous\s*:\s*(\d+)\s*$', 'ambiguous reference count'),
        'runtime': number(r'^\s*runtime\s*:\s*(\d+)\s*$', 'runtime reference count'),
        'external': number(r'^\s*external\s*:\s*(\d+)\s*$', 'external reference count'),
        'broken': number(r'^\s*broken\s*:\s*(\d+)\s*$', 'broken reference count'),
        'total': number(r'^\s*TOTAL\s*:\s*(\d+)\s*$', 'total reference count'),
        'design': number(r'^\s*design\s*:\s*(\d+)\s*$', 'design document count'),
        'asset': number(r'^\s*asset\s*:\s*(\d+)\s*$', 'tracking asset count'),
    }
    return out


def note_text(figures=None):
    """The note, with the measured figures taken from the probe log."""
    if figures is None:
        figures = probe_figures()
    return NOTE_TEMPLATE.format(**figures)


# The note. It is a TEMPLATE: the measured figures are placeholders, filled
# by `note_text()` from the committed probe log. A re-typed constant is what
# let the workbook claim a reference count that no committed log carried.
NOTE_TEMPLATE = (
    '【ATS-308】设计资料索引器已实现并实测（design-import/v1）：'
    '（1）**导入只读不写**：验收标准「导入 md/json 关系不改正文」不是'
    '禁止事项而是**主张**——索引器打开 {design} 份设计文档与 {asset} 份追踪资产、'
    '读出关系、返回报告，**1 字节也不写回**；API 只有 GET，**没有 POST**。'
    '破坏「正文不变」的负控（M6：让导入器往正文追加一行）实测**必然改变**'
    '正文，未变异的导入器逐字节相同（UT/IT 各一组）。'
    '（2）**失效与重名都出报告**：引用按 5 个 verdict 分类——resolved / '
    'ambiguous（同名多处，列出全部候选，**不替读者选**）/ runtime（运行期或'
    '构建产物）/ external（指向被测项目，本仓库无此目录）/ broken。'
    '报告按 token 归并，一个坏链被 12 处提到仍算**一个**缺陷。'
    '（3）**不 cry wolf**：state.json / report.json 这类运行期产物不算失效'
    '（否则每次报告都在叫），重名不算失效（引用没错，只是不完整）。'
    '（4）**实**：对真实设计基线实测 {total} 条引用——resolved {resolved} / '
    'runtime {runtime} / ambiguous {ambiguous} / external {external} / '
    'broken {broken}（{broken} 处均为 issue 附件的复核探针、'
    '他树旧文件名或运行期生成物，**不是真缺的文件**）；'
    '**{resolved} 条 resolved 的候选逐条核对，全部实存**。'
    '（5）**负控 7 条**：把导入器的「报告失效」「报告重名」「把坏链说成已解析」'
    '「把运行期产物说成失效」「把外部路径说成失效」「改正文」「在多个候选中'
    '乱猜」逐个变异，**7 变异逐条被抓住**，未变异的代码仍然通过。'
    '（6）**已知局限（如实记录）**：broken 的词汇**不区分**「真缺的文件」与'
    '「另一种不在」（issue 附件、他树旧名、运行期生成物都落在同一个词里），'
    '所以坏链报告**偏强**；§ 编号的**照合未实现**（索引只读出章号，'
    '不核对 § 引用）；被测项目**自有**设计基线的索引**未实现**'
    '（当前索引的是项目自身的 docs/）；UI 未做（属 ATS-310）。'
    '详见 docs/35-DESIGN-IMPORT.md。'
)


def summarise(xml2):
    """Recompute the overview's cached formula values from the sheet itself.

    Mirrors the three formulas that live in the 总览 sheet:
      B8  = COUNTIF('开发WBS'!N6:N<last>,"已完成")
      B9  = IFERROR(1-SUM('开发WBS'!P6:P<last>)/SUM('开发WBS'!K6:K<last>),0)
      B10 = SUM('开发WBS'!P6:P<last>)

    The row range follows the SHEET (the sheet grew when ATS-601 appended
    the mobile rows), so the cached value always agrees with the formula
    that produced it.
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

    rid, _rm = find_ats_row(xml2, 'ATS-308')
    # 待审核 is one of the six values in the N-column data-validation list.
    xml2 = set_cell_in_row(xml2, rid, 'N', '待审核')
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes.
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: append the ATS-308 note, replacing a previous copy of it.
    # The marker-aware merge keeps every other task's marked block in the
    # same cell and re-emits the blocks in canonical order, so the result
    # does not depend on which updater ran last.
    #
    # The note's measured figures are formatted from the committed probe log,
    # so the cell cannot claim a count that no committed log carries.
    xml2 = set_marked_cell(xml2, rid, 'T', '【ATS-308】', note_text())

    parts[SHEET2] = xml2.encode('utf-8')

    # --- 总览: rewrite the narrative cells from the fragments ---------------
    xml1 = parts[SHEET1].decode('utf-8')
    xml1 = set_narrative_cell(xml1, 6, 'D6')
    xml1 = set_narrative_cell(xml1, 7, 'D7')

    # --- 总览: refresh the cached values of the existing formulas -----------
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
