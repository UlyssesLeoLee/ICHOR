"""ATS-307: sync the ATS-307 row of docs/WBS.xlsx with the delivered module.

Surgical edit of the existing workbook (no openpyxl / no rebuild), in the same
style as tools/update_wbs_ats216.py: the sheet XML is patched in place and the
zip is rewritten with every other part byte-identical.

ATS-307 row changes:
  N (状态)   : 未开始 -> 待审核
  O (完成率) : 0 -> 1
  P (剩余人日): cached value 5 -> 0 (the formula K*(1-O) is kept)
  T (风险/说明): the ATS-307 note, marked with 【ATS-307】

The overview sheet's cached formula results are recomputed FROM THE SHEET
rather than hardcoded, so the summary stays correct no matter what other rows
already carry a non-zero completion rate:

  B8  COUNTIF(N6:N94,"已完成")       -> counted from the sheet
  B9  1-SUM(P)/SUM(K)                -> computed from the sheet
  B10 SUM(P6:P94)                    -> computed from the sheet

XML ESCAPING (this is load-bearing, not cosmetic)
-----------------------------------------------
The cell values are written into `<x:v>` elements. A note that contains `<`,
`>` or `&` -- a comparison operator, an ampersand -- written RAW into
`xl/worksheets/sheet2.xml` makes the workbook UNPARSEABLE: openpyxl raises a
ParseError, Excel refuses to open it and reports that the file has to be
repaired. The escaping is done by `wbs_common.set_marked_cell` /
`wbs_common.set_cell_in_row`, which apply the XML spec's own entity set
(&, <, >) to every value before it goes into the cell.

NOTE on 状态: ATS-307 is set to 待审核 ("pending review"), NOT 已完成. The
deliverable is submitted, but it has not been accepted yet -- the reviewer
(Opus) syncs 已完成/完成率 after the review passes. Declaring it 已完成
before review would contradict "不得自行置 done".

NOTE on re-runs after acceptance: the review is a one-way door. Once the
reviewer has returned PASS and the row carries 已完成, re-running this script
must NOT walk that row back to 待审核 -- the same guard the other updaters
carry. The guard protects a row that is accepted AND self-consistent (状态=已完成
with 完成率=1 and 剩余人日=0); a 已完成 row that contradicts its own numbers is a
stale artefact, not an acceptance, and does not get to veto the status this
task owns.

IDEMPOTENCY: running this script twice must leave row ATS-307 byte-identical.
The marker-aware merge in `wbs_common.set_marked_cell` replaces the previous
marked block instead of appending, so the second run is a no-op. `verify()`
asserts that.
"""
import argparse
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

FIRST_ROW, LAST_ROW = 6, 94

MARKER = '【ATS-307】'

# The two status values that a later acceptance may have set. They are not
# downgraded by a re-run of this script: the review is a one-way door.
TERMINAL_STATUSES = ('已完成', '已取消')

# The status the reviewer (Opus) writes after a PASS. It is one of the six
# values in the N-column data-validation list.
STATUS_DONE = '已完成'

# The committed evidence log the note's regression figures are DERIVED from.
#
# The figures used to be written down in the note. That is what let them go
# stale: the evidence was re-collected (the pass count went from 1856 to
# 1865) and the note was not regenerated, so the workbook claimed a number
# that no committed log carried. A hardcoded constant is the defect.
EVIDENCE_LOG = Path(__file__).resolve().parents[1] / 'docs' / 'evidence' / 'ATS-307' / '06-node-test-full.log'

# The probe log, the second source of measured figures (the graph's shape).
PROBE_LOG = Path(__file__).resolve().parents[1] / 'docs' / 'evidence' / 'ATS-307' / '03-probe-traceability.log'

# The SUITE logs: the unit suite and the integration suite. Their case
# COUNTS are derived from here for the same reason the regression figures
# are: a typed count goes stale the moment a case is added, and then the
# note names a count that the committed log contradicts.
UT_LOG = Path(__file__).resolve().parents[1] / 'docs' / 'evidence' / 'ATS-307' / '01-node-test-traceability-ut.log'
IT_LOG = Path(__file__).resolve().parents[1] / 'docs' / 'evidence' / 'ATS-307' / '02-node-test-traceability-it.log'

# The evidence directory itself. The note lists the logs it is backed by,
# and that list is READ FROM THE DIRECTORY rather than typed: a typed list
# is what let the note claim seven logs while the directory held eight.
EVIDENCE_DIR = Path(__file__).resolve().parents[1] / 'docs' / 'evidence' / 'ATS-307'

# The `node --test` summary lines the figures are read from.
SUMMARY_RE = re.compile(r'^\u2139 (tests|pass|fail|skipped) (\d+)$', re.M)

# A test id as a transcript line names it: `✔ UT-ATS307-001: ...`.
CASE_ID_RE = re.compile(r'^[✔✓✖×✗]\s+((?:UT|IT|ST)-[A-Z0-9]+(?:-[A-Za-z0-9]+)+)\s*:', re.M)


def _summary(path):
    """The four `node --test` summary lines of a committed log.

    A log that is missing, or that does not carry all four lines, is a hard
    error: the updater REFUSES to write figures it cannot vouch for.
    """
    if not path.exists():
        raise SystemExit(
            'the evidence log %s does not exist -- the note\'s figures are derived '
            'from it, so the updater refuses to write a note it cannot back up' % path)
    text = path.read_text(encoding='utf-8')
    found = {k: int(v) for k, v in SUMMARY_RE.findall(text)}
    missing = [k for k in ('tests', 'pass', 'fail', 'skipped') if k not in found]
    if missing:
        raise SystemExit(
            'the evidence log %s does not carry the %s summary line(s) -- the note\'s '
            'figures are derived from it, so the updater refuses to write' % (path, ', '.join(missing)))
    return found


def regression_figures(log_path=None):
    """The full regression's figures, READ FROM THE COMMITTED EVIDENCE LOG.

    Returns a dict with `tests`, `pass`, `fail` and `skipped`.

    A log that is missing, or that does not carry all four lines, is a hard
    error: the updater REFUSES to write a note whose figures it cannot
    vouch for. Writing a note with no numbers in it would be worse than
    refusing to write.
    """
    return _summary(Path(log_path) if log_path is not None else EVIDENCE_LOG)


def suite_figures(ut_log=None, it_log=None):
    """The suites' case counts, READ FROM THE COMMITTED SUITE LOGS.

    The same defect class as the regression figures, one level up: the
    suite grew (three cases were added for the `failed` state), the typed
    count stayed, and the note contradicted the log that sits in the same
    directory.

    Returns a dict with the `ut` and `it` figures, each carrying `tests`,
    `pass`, `fail`, `skipped` and the LIST of the case ids the log names.
    """
    out = {}
    for key, default in (('ut', ut_log or UT_LOG), ('it', it_log or IT_LOG)):
        path = Path(default)
        figures = _summary(path)
        text = path.read_text(encoding='utf-8')
        ids = sorted(set(CASE_ID_RE.findall(text)))
        figures['ids'] = ids
        out[key] = figures
    return out


def evidence_figures(directory=None):
    """The committed evidence logs, READ FROM THE DIRECTORY.

    The note tells the reader which logs back it up. That list used to be
    typed, and it went stale the moment a log was added -- the note named
    seven logs while the directory held eight, and the skip reasons were
    in the one the note did not name.

    Returns the sorted list of the directory's `NN-*.log` file names.
    """
    path = Path(directory) if directory is not None else EVIDENCE_DIR
    if not path.is_dir():
        raise SystemExit(
            'the evidence directory %s does not exist -- the note\'s evidence list is '
            'derived from it, so the updater refuses to write' % path)
    names = sorted(p.name for p in path.glob('*.log'))
    if not names:
        raise SystemExit(
            'the evidence directory %s holds no log -- the note\'s evidence list is '
            'derived from it, so the updater refuses to write' % path)
    return names


def graph_figures(log_path=None):
    """The graph's shape, READ FROM THE COMMITTED PROBE LOG.

    The same defect class as the regression figures: a re-typed constant in
    the note goes stale when the tree changes. The probe log is the
    authority on the graph's shape, so the note reads it from there.

    Returns a dict with `nodes`, `edges`, `chains`, `complete`, `broken`
    and the coverage counts.
    """
    path = Path(log_path) if log_path is not None else PROBE_LOG
    if not path.exists():
        raise SystemExit(
            'the probe log %s does not exist -- the note\'s graph figures are derived '
            'from it, so the updater refuses to write a note it cannot back up' % path)
    text = path.read_text(encoding='utf-8')

    def number(pattern, label):
        m = re.search(pattern, text, re.M)
        if not m:
            raise SystemExit(
                'the probe log %s does not carry the %s figure -- the note\'s graph '
                'figures are derived from it, so the updater refuses to write' % (path, label))
        return int(m.group(1))

    out = {
        'nodes': number(r'^nodes\s+:\s+(\d+)$', 'node count'),
        'edges': number(r'^edges\s+:\s+(\d+)$', 'edge count'),
        'chains': number(r'^chains\s+:\s+(\d+)$', 'chain count'),
        'complete': number(r'^complete chains\s+:\s+(\d+)$', 'complete chain count'),
        'broken': number(r'^broken chains\s+:\s+(\d+)$', 'broken chain count'),
    }
    for state in ('verified', 'implemented', 'designed'):
        m = re.search(r'^  %s\s+(\d+)$' % state, text, re.M)
        if not m:
            raise SystemExit(
                'the probe log %s does not carry the %s coverage count -- the note\'s '
                'graph figures are derived from it, so the updater refuses to write'
                % (path, state))
        out[state] = int(m.group(1))
    # The commit coverage (AC-3): how many nodes and how many edges carry a
    # git commit. The probe MEASURES it on the tree it runs against, so the
    # note carries the measurement and not a claim about it.
    for label, key in (('node', 'nodes_with_commit'), ('edge', 'edges_with_commit')):
        m = re.search(r'^%s with a commit\s+:\s+(\d+) of (\d+)$'
                      % ('nodes' if key == 'nodes_with_commit' else 'edges'), text, re.M)
        if not m:
            raise SystemExit(
                'the probe log %s does not carry the %s commit coverage -- the note\'s '
                'commit figures are derived from it, so the updater refuses to write'
                % (path, label))
        out[key] = int(m.group(1))
        out[key + '_total'] = int(m.group(2))
    return out


def note_text(figures, graph=None, suites=None, evidence=None):
    """The note, with the measured figures taken from the evidence logs.

    The figures are FORMATTED into the sentence, so the number in the
    workbook is the number the committed log carries -- by construction,
    not by a re-typed constant.
    """
    if graph is None:
        graph = graph_figures()
    if suites is None:
        suites = suite_figures()
    if evidence is None:
        evidence = evidence_figures()
    return NOTE_TEMPLATE.format(
        tests=figures['tests'],
        passed=figures['pass'],
        failed=figures['fail'],
        skipped=figures['skipped'],
        nodes=graph['nodes'],
        edges=graph['edges'],
        chains=graph['chains'],
        complete=graph['complete'],
        broken=graph['broken'],
        verified=graph['verified'],
        implemented=graph['implemented'],
        designed=graph['designed'],
        ut_tests=suites['ut']['tests'],
        ut_pass=suites['ut']['pass'],
        ut_fail=suites['ut']['fail'],
        ut_skipped=suites['ut']['skipped'],
        it_tests=suites['it']['tests'],
        it_pass=suites['it']['pass'],
        it_fail=suites['it']['fail'],
        it_skipped=suites['it']['skipped'],
        evidence_list='、'.join(evidence),
        evidence_count=len(evidence),
        nodes_with_commit=graph['nodes_with_commit'],
        nodes_total=graph['nodes_with_commit_total'],
        edges_with_commit=graph['edges_with_commit'],
        edges_total=graph['edges_with_commit_total'],
    )

# The note. It is a TEMPLATE: the four regression figures are placeholders,
# filled by `note_text()` from the committed evidence log. A re-typed
# constant is what let the workbook claim a pass count that no committed
# log carried.
NOTE_TEMPLATE = (
    '已交付 Requirement→Design→TestCase→Script→Run→Evidence 追溯链（语义图谱 Schema）：'
    '模型在 server/traceability/（model.mjs 节点种/边种/UID/gap 语彙、'
    'builder.mjs 从树与 state 构建、query.mjs 双向 walk），接口面 GET /api/traceability'
    '（?requirement= 前向、?evidence= 反向、无参数为汇总），设计书 docs/33-TRACEABILITY-GRAPH.md；'
    '为什么是图而不是矩阵：矩阵（tests/rtm.json，49 行、1069 条测试引用）只答得'
    '「要件にどのテストが紐づくか」，逆引きできず、欠けた環は `TBD` という文字列であり、'
    '出所を持たない；'
    '节点 6 種（requirement/design/testcase/script/run/evidence）、辺 5 種'
    '（designs/covers/implemented/attempted/archived）、'
    'UID は trc_1_<24 hex> / tre_1_<24 hex>（docs/18-UID-SPEC.md と同じ方式族、'
    'sha256(kind\\0key) と sha256(from\\0to\\0type)、時計・乱数・配列順に依存しないため'
    'commit をまたいで差分できる）、ノードの kind と uid は data で上書きできない；'
    '出所（provenance）4 種：catalog（カタログの主張）/ source（スクリプト自身の宣言）/ '
    'runtime（state.json の記録）/ evidence（トランスクリプトの観測）——主張と観測を混ぜない；'
    'グラフは DAG で逆向きの辺を持たない：evidence→testcase を持つと evidence→testcase→run→evidence '
    'の循環が生まれ「循環が検査できる」という完了定義が無意味になる；逆引きは保存された辺の逆走査として計算する；'
    '共有ノード（設計アンカー B04 は複数要件に共有される）の結合は covers 辺に requirement として持たせる：'
    'そうで無いと FR-007 の証拠から FR-008 まで到達してしまう（実装中のプローブで実際に検出した）；'
    '逆引きは run で join する（evidence <- run <- testcase <- design <- requirement）：'
    'run を経由しない逆走査は 1 つの artifact に全ケースを帰属させる；'
    '断链は埋めない：欠けた hop を gap として名前と理由付きで報告する'
    '（no-design / no-testcase / no-script / no-declaration / no-run / no-evidence / '
    'dangling-test / dangling-anchor）；'
    'no-script（実装が無い）と no-declaration（実装は在るがカタログ経由でしか繋がらない、'
    'ST プローブは ID を持たない）は別物で、同視すると実在する実装を「無い」と報告することになる；'
    '設計アンカーの分割規則は whole を先に試し、whole が既知でない時だけ `/` で split する'
    '（`P1 AST/CLI` から `CLI` を切り出さない、`NFR / SEC / OPS` は 1 つの領域）；'
    '整合性検査：danglingTest 0 件、danglingAnchor 0 件、orphanEdge 0 件、'
    '循環 0 件、present でないノード 0 件；'
    '本ツリーのグラフ実測：ノード {nodes}、辺 {edges}、チェーン {chains}、'
    '完全なチェーン {complete}、欠けたチェーン {broken}、'
    'coverage は verified {verified} / implemented {implemented} / designed {designed}；'
    'ノードと辺の Git commit：ノード {nodes_with_commit}/{nodes_total}、'
    '辺 {edges_with_commit}/{edges_total} が commit を保持する'
    '（ノードの commit はその由来ファイルの最終変更 commit、辺の commit は'
    '結ぶ事実の commit。git の履歴を持たないツリーでは全て null になる）；'
    '本票が報告する既存の drift：カタログが PASS と宣言するが実装スクリプトがその ID を宣言しないケースが 88 件'
    '（UT-DSC-* 30、IT-DSC-* 11、IT-DSC-API-* 7、UT-ATS213-* 17、IT-ATS213-* 11、UT-QUAL-* 9、'
    'IT-DSC-SETUP / IT-DSC-CLEANUP / ST-045 各 1）。実装は別 ID 体系（ATS-202-UT-001 / ATS-216-UT-001 等）で'
    '書かれており、カタログとスクリプトの ID 統一を要する別件であり、本票はそれを隠さない；'
    'テストは UT {ut_tests} 例（tests/ats307-traceability.test.mjs、'
    '安定 UID・両方向 walk・gap の可視化・偽 PASS の検出・ scanners の 3 種宣言スタイル・'
    '_steps suffix の折り返し規則・-real tree には孤児辺も循環も無いこと・'
    'coverage gap の統計と gap の hop 命名・RTM の全 ID 存在・構築の決定性・'
    '失敗した実行は verified でないことを含む、{ut_pass} pass / {ut_fail} fail / {ut_skipped} skipped）'
    '+ IT {it_tests} 例（tests/ats307-traceability-it.test.mjs、実 Bridge 上の HTTP 面、token 必須・'
    'requirement パラメータ・evidence パラメータ・未知 ID の報告、{it_pass} pass / {it_fail} fail / {it_skipped} skipped）；'
    '全量回帰（node --test --test-concurrency=2 tests/*.test.mjs）は {passed} pass / {failed} fail / '
    '{skipped} skipped（{tests} tests、入庫ログ docs/evidence/ATS-307/06-node-test-full.log から派生）、'
    '証拠は docs/evidence/ATS-307/（{evidence_list} の {evidence_count} 件、'
    'ディレクトリから派生なので、追加されたログが一覧から漏れない）；'
    '負向対照（tools/ats307-probes/probe-negative-control.mjs）は 4 種の改変'
    '（dangling test id / dangling anchor / 偽 PASS / 循環）で検査が実際に赤くなることを確認している'
    '（検査が赤にならない検査は何も証明しない）；'
    '既知の境界：UI は無い（React Flow の血缘图は ATS-310 の領域、本票はデータ層に限定、'
    'apps/studio の既存 trace タブは未変更）；増分関係校验と変更影響評価 API は無い（ATS-309 の領域、'
    '/api/traceability は毎回グラフを構築する読み取り専用）；'
    '実行時 run（state.json 由来）との結合は本票の証跡ではトランスクリプト経路しか実行していない；'
    'ST 自体が未実行の要件はグラフ上 no-run gap として露出する（欠落の可視化であって ST の PASS ではない）。'
)


def find_ats_row(xml, ats_id):
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        if f'<x:v>{ats_id}</x:v>' in rm.group(2):
            return int(rm.group(1)), rm
    raise SystemExit(f'row for {ats_id} not found')


def self_consistent(xml, rid):
    """True when the row's 状态 agrees with its own 完成率 / 剩余人日.

    A row that says 已完成 but carries a completion rate below 1 or a
    non-zero remainder contradicts itself; such a row is a stale artefact,
    not an acceptance, and must not veto the status this task owns.
    """
    try:
        rate = float(cell_text(xml, rid, 'O') or 0)
        remaining = float(cell_text(xml, rid, 'P') or 0)
    except ValueError:
        return False
    return rate >= 1 and remaining <= 0


def patch_workbook(status='待审核', xlsx_path=None, note=None):
    """Write the ATS-307 row into the workbook at `xlsx_path`.

    The path is a PARAMETER, so the updater can be exercised on a copy: a
    test that had to edit the repository workbook would modify the
    deliverable while reporting success.
    """
    xlsx = Path(xlsx_path) if xlsx_path is not None else XLSX
    if note is None:
        note = note_text(regression_figures())
    shutil.copy2(xlsx, xlsx.with_suffix('.xlsx.bak'))
    zin = zipfile.ZipFile(xlsx)
    parts = {n: zin.read(n) for n in zin.namelist()}
    infos = {i.filename: i for i in zin.infolist()}
    zin.close()

    xml2 = parts[SHEET2].decode('utf-8')

    rid, _rm = find_ats_row(xml2, 'ATS-307')
    # A re-run must not undo an accepted review: only a row that has not been
    # accepted yet is (re)written. An accepted row keeps its status, and the
    # notes and the cached 总览 values are still refreshed below.
    current = cell_text(xml2, rid, 'N')
    if current not in TERMINAL_STATUSES or not self_consistent(xml2, rid):
        # 待审核 and 已完成 are both in the N-column data-validation list.
        xml2 = set_cell_in_row(xml2, rid, 'N', status)
    xml2 = set_cell_in_row(xml2, rid, 'O', '1', numeric=True)
    # P keeps its formula K*(1-O) = 5*(1-1) = 0; only the cached value changes
    xml2 = set_cell_in_row(xml2, rid, 'P', '0', numeric=True)

    # 风险/说明: the ATS-307 note, replacing a previous copy of it.
    # The marker-aware merge keeps every other task's marked block in the
    # same cell and re-emits the blocks in canonical order, so the result
    # does not depend on which updater ran last. The note text is
    # XML-ESCAPED by `set_marked_cell`.
    xml2 = set_marked_cell(xml2, rid, 'T', MARKER, note)

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
    tmp = xlsx.with_suffix('.xlsx.tmp')
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            info = infos[name]
            zi = zipfile.ZipInfo(name, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            zout.writestr(zi, data)
    # os.replace() can fail on Windows when the target is held open; copy then unlink
    shutil.copy2(tmp, xlsx)
    tmp.unlink()
    print('updated', xlsx)


def row_signature(xlsx_path=None):
    """The ATS-307 row's cells, for the idempotency check."""
    xlsx = Path(xlsx_path) if xlsx_path is not None else XLSX
    zin = zipfile.ZipFile(xlsx)
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, rm = find_ats_row(xml2, 'ATS-307')
    return rm.group(0)


def verify(xlsx_path=None, figures=None, suites=None, evidence=None):
    """Assert the workbook still parses and row ATS-307 is exactly as intended.

    The note's regression figures are checked against the evidence log they
    are derived from: a number that drifts can therefore no longer reach
    the workbook. The SUITE counts and the evidence LIST are checked the
    same way -- against the suite logs and the evidence directory they are
    derived from.
    """
    xlsx = Path(xlsx_path) if xlsx_path is not None else XLSX
    if figures is None:
        figures = regression_figures()
    if suites is None:
        suites = suite_figures()
    if evidence is None:
        evidence = evidence_figures()
    zin = zipfile.ZipFile(xlsx)
    names = zin.namelist()
    assert 'xl/worksheets/sheet2.xml' in names, 'sheet2 missing'
    xml2 = zin.read(SHEET2).decode('utf-8')
    zin.close()
    rid, _rm = find_ats_row(xml2, 'ATS-307')
    status = cell_text(xml2, rid, 'N')
    rate = cell_text(xml2, rid, 'O')
    remain = cell_text(xml2, rid, 'P')
    note = cell_text(xml2, rid, 'T')
    # The row is 待审核 while the review is in flight and 已完成 once the
    # reviewer has returned PASS; either is a correct state, but a row in
    # some OTHER status is not.
    assert status in ('待审核', STATUS_DONE), \
        f'ATS-307 status is {status!r}, expected 待审核 or {STATUS_DONE}'
    assert rate == '1', f'ATS-307 completion rate is {rate!r}, expected 1'
    assert remain == '0', f'ATS-307 remaining days is {remain!r}, expected 0'
    assert note.count(MARKER) == 1, f'ATS-307 note has {note.count(MARKER)} markers, expected 1'
    assert '追溯链' in note, 'the ATS-307 note is missing the delivered scope'
    # The figures the note carries must be the ones the evidence log holds.
    for key, label in (('pass', 'pass'), ('fail', 'fail'), ('skipped', 'skipped'), ('tests', 'tests')):
        needle = '%d %s' % (figures[key], label)
        assert needle in note, \
            'the ATS-307 note does not carry %r -- the evidence log says %r' % (needle, figures)
    # And the graph's shape must be the one the probe log holds.
    graph = graph_figures()
    for needle in ('ノード %d' % graph['nodes'], '辺 %d' % graph['edges'],
                   'チェーン %d' % graph['chains'],
                   'verified %d' % graph['verified']):
        assert needle in note, \
            'the ATS-307 note does not carry %r -- the probe log says %r' % (needle, graph)
    # The SUITE counts: the note must name the case counts the suite logs
    # hold. A typed count would drift the moment a case is added.
    for suite in ('ut', 'it'):
        needle = '%d 例' % suites[suite]['tests']
        assert needle in note, \
            'the ATS-307 note does not carry the %s case count %r -- the suite log says %r' \
            % (suite, needle, suites[suite])
    # The EVIDENCE LIST: every committed log must be named, so a log that
    # is added cannot fall out of the note.
    for name in evidence:
        assert name in note, \
            'the ATS-307 note does not name the evidence log %r -- the directory holds it' % name
    # The COMMIT COVERAGE (AC-3): the note must carry the measurement the
    # probe made, not a claim about it.
    for needle in ('ノード %d/%d' % (graph['nodes_with_commit'], graph['nodes_with_commit_total']),
                   '辺 %d/%d' % (graph['edges_with_commit'], graph['edges_with_commit_total'])):
        assert needle in note, \
            'the ATS-307 note does not carry the commit coverage %r -- the probe log says %r' \
            % (needle, graph)
    print(f'verify: ATS-307 row {rid} 状态={status} 完成率={rate} 剩余人日={remain} marker×{note.count(MARKER)}')
    print('verify: the note carries the figures the evidence log holds: '
          '%d tests / %d pass / %d fail / %d skipped'
          % (figures['tests'], figures['pass'], figures['fail'], figures['skipped']))
    print('verify: the note carries the suite counts the suite logs hold: '
          'UT %d / IT %d, and names all %d committed evidence logs'
          % (suites['ut']['tests'], suites['it']['tests'], len(evidence)))


def check_parses(xlsx_path=None):
    """Assert the workbook is loadable -- in both openpyxl modes.

    A note that was written into the sheet XML without XML escaping makes the
    workbook unparseable. The updater still exits 0 in that case, so the
    parse check is the only thing that catches it.
    """
    import openpyxl

    xlsx = Path(xlsx_path) if xlsx_path is not None else XLSX
    wb = openpyxl.load_workbook(xlsx, data_only=False)
    ws = wb['开发WBS']
    row = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(row=r, column=1).value or '').startswith('ATS-307'):
            row = r
            break
    assert row is not None, 'the ATS-307 row is not found by openpyxl'
    n_value = ws.cell(row=row, column=14).value
    assert n_value in ('待审核', STATUS_DONE), f'column N is {n_value!r}'
    assert float(ws.cell(row=row, column=15).value) == 1, f'column O is {ws.cell(row=row, column=15).value!r}'
    # Column P keeps its formula; the cached value is what the sheet carries.
    p_formula = ws.cell(row=row, column=16).value
    assert isinstance(p_formula, str) and p_formula.startswith('='), f'column P is {p_formula!r}'
    note = ws.cell(row=row, column=20).value or ''
    assert note.count('【ATS-307】') == 1, f'column T carries {note.count("【ATS-307】")} markers'
    assert '追溯链' in note, 'column T is missing the delivered scope'
    wb.close()

    wb = openpyxl.load_workbook(xlsx, data_only=True)
    assert '开发WBS' in wb.sheetnames, 'the 开发WBS sheet is missing in the data_only mode'
    wb.close()
    print('verify: openpyxl loads the workbook in the normal and the data_only mode')


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--verify-only', action='store_true')
    ap.add_argument(
        '--status', default='待审核', choices=('待审核', STATUS_DONE),
        help='the 状态 to write into the ATS-307 row (default: 待审核). '
             'Use 已完成 once the review has returned PASS; the row then keeps '
             'that status across later re-runs of this script. Any other value '
             'is rejected by argparse (exit 2) -- the N column carries a data '
             'validation list, and a status outside it would be a broken cell.')
    ap.add_argument(
        '--xlsx', default=str(XLSX),
        help='the workbook to edit (default: docs/WBS.xlsx). A copy can be '
             'given so the updater can be exercised without touching the '
             'repository workbook.')
    args = ap.parse_args(argv)

    # The figures come from the committed evidence logs. A log that is missing
    # or incomplete makes the updater REFUSE to write -- a note whose numbers
    # cannot be vouched for is worse than no note.
    figures = regression_figures()
    print('evidence: %d tests / %d pass / %d fail / %d skipped (from %s)'
          % (figures['tests'], figures['pass'], figures['fail'], figures['skipped'], EVIDENCE_LOG))
    suites = suite_figures()
    print('suites: UT %d cases / IT %d cases (from the committed suite logs)'
          % (suites['ut']['tests'], suites['it']['tests']))
    evidence = evidence_figures()
    print('evidence list: %d committed logs (from the directory itself)' % len(evidence))
    note = note_text(figures, suites=suites, evidence=evidence)

    if args.verify_only:
        verify(args.xlsx, figures, suites, evidence)
        check_parses(args.xlsx)
        return 0

    before = row_signature(args.xlsx)
    patch_workbook(args.status, args.xlsx, note)
    after = row_signature(args.xlsx)
    if before == after:
        print('IDEMPOTENT: row ATS-307 unchanged')
    else:
        print('CHANGED (first run applied the update)')
    # A second run must be a no-op.
    second_before = row_signature(args.xlsx)
    patch_workbook(args.status, args.xlsx, note)
    second_after = row_signature(args.xlsx)
    assert second_before == second_after, 'the updater is NOT idempotent'
    print('IDEMPOTENT: a second run leaves row ATS-307 byte-identical')
    verify(args.xlsx, figures, suites, evidence)
    check_parses(args.xlsx)
    return 0


if __name__ == '__main__':
    sys.exit(main())
