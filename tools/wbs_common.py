"""Derive the 开发WBS totals from the sheet itself.

The 总览 (sheet1) cells B8/B9/B10 hold FORMULAS with a cached value. A reader
that does not recalculate the workbook sees the cached value, so the cache has
to match the sheet. Hardcoding the numbers in an updater is wrong as soon as a
second script changes a row: whichever updater ran last would restore its own
stale cache and the 总览 would silently disagree with the 开发WBS.

Both updaters therefore DERIVE the cached values from the sheet they are
about to write. The derivation is:

    B8  = COUNTIF(开发WBS!N6:N94, "已完成")
    B9  = IFERROR(1 - SUM(开发WBS!P6:P94) / SUM(开发WBS!K6:K94), 0)
    B10 = SUM(开发WBS!P6:P94)

The row range (6..94) mirrors the formulas stored in the workbook.
"""
import re
import struct
import zlib
from pathlib import Path

WBS = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'

FIRST_ROW = 6
LAST_ROW = 94

SHARED_STRINGS = 'xl/sharedStrings.xml'
SHEET1 = 'xl/worksheets/sheet1.xml'
SHEET2 = 'xl/worksheets/sheet2.xml'

# Every script that writes a marked note into a shared cell owns exactly one
# marker. A cell may therefore carry notes from more than one script, and the
# merge has to keep the foreign ones.
#
# The tuple order is also the CANONICAL block order: the merge re-emits the
# blocks in this order regardless of the order in which the scripts ran. Two
# updaters that touch the same cell therefore produce the same sheet whatever
# order they run in.
MARKERS = ('【ATS-101】', '【ATS-102】', '【ATS-103】', '【ATS-201】', '【ATS-202】', '【ATS-205】', '【ATS-206】',
           '【ATS-208】', '【ATS-212】', '【ATS-301】', '【ATS-401】', '【ATS-501】', '【ATS-506】', '【ATS-512】')

# The 总览 narrative cells D6/D7 summarise the state of the whole baseline.
# They are shared by every updater, so each task contributes ONE marked
# fragment and the cell is the composition of all of them.
#
# `base` is the unmarked part that belongs to no task and is never removed.
# `stale` lists the legacy unmarked fragments that earlier deliveries wrote
# whole-cell; they are superseded by the marked fragments and must not
# linger next to them.
NARRATIVE = {
    'D6': {
        'base': 'v0.1 已有 Node Bridge/便携 UI/Next/Tauri 源码，已通过 20 项 Node UT/IT',
        'stale': (
            'Next.js 16 静态导出构建已实测通过（ATS-101）',
            'Agent 契约层已实现（ATS-401）',
            '锁文件、依赖清单与 CI 构建门禁已交付（ATS-102）。',
            'Next.js 16 静态导出构建已实测通过（ATS-101）。',
        ),
    },
    'D7': {
        'base': '真实浏览器 Playwright ST 未执行（受 B-01 阻断）；'
                'Tauri Windows 编译未通过（B-02：缺 MSVC C++ 构建工具、'
                '仓库缺 icons/icon.ico，且成因清单尚未穷尽）',
        'stale': (
            'CI workflow 未在真实 runner 上跑过（ATS-102）',
            '详见 docs/16-BASELINE-ADR.md、docs/17-BUILD-CI.md 与 docs/17-AGENT-CONTRACT.md。',
            '详见 docs/16-BASELINE-ADR.md。',
        ),
    },
}

# Each task's own contribution to the narrative cells.
NARRATIVE_FRAGMENTS = {
    '【ATS-101】': {
        'D6': 'Next.js 16 静态导出构建已实测通过',
        'D7': '详见 docs/16-BASELINE-ADR.md',
    },
    '【ATS-102】': {
        'D6': '锁文件、依赖清单与 CI 构建门禁已交付',
        'D7': 'CI workflow 未在真实 runner 上跑过；详见 docs/17-BUILD-CI.md',
    },
    '【ATS-103】': {
        'D6': 'Next.js 16 静态导出与 127.0.0.1 Bridge 的会话/项目/运行操作已实测通过（ATS-103）',
        'D7': '静态导出未在 macOS/Linux 实测、未在真实 Tauri 壳内实测；'
              '引擎进程异常死亡时运行记录无 summary 的证据链缺陷属 ATS-108/ATS-112，'
              '详见 docs/22-FRONTEND-EXPORT.md',
    },
    '【ATS-401】': {
        'D6': 'Agent 契约层已实现',
        'D7': '详见 docs/17-AGENT-CONTRACT.md',
    },
    '【ATS-202】': {
        'D6': '权威发现已实现（ATS-202：playwright test --list；未可信仓库回退静态索引）',
        'D7': '权威发现在可信仓库上执行仓库代码（--list 非只读），沙箱化属 ATS-415；'
              '详见 docs/23-AUTHORITATIVE-DISCOVERY.md',
    },
    '【ATS-205】': {
        'D6': 'SQLite 元数据层已实现（ATS-205：WAL、版本迁移与事务；state.json 的镜像）',
        'D7': '元数据层当前只做 state.json 的镜像，不提供查询 API；'
              '详见 docs/06-DATA-DESIGN.md §5',
    },
    '【ATS-206】': {
        'D6': '状态数据迁移 CLI 已实现（ATS-206：安全导入、备份与回滚；数量一致）',
        'D7': '迁移为离线操作须先停 Bridge；降级不在本项范围，进程级独占归 ATS-207；'
              '详见 docs/24-STATE-MIGRATION.md',
    },
    '【ATS-208】': {
        'D6': '执行状态机 v2 已实现（ATS-208：Run/Test/Attempt 与事件序号统一模型；重试不覆盖初次尝试，'
              '事件可按 run+sequence 复演）',
        'D7': '执行模型的真实浏览器 ST 未执行（夹具为 CLI 替身，只建模报告形状）；'
              '详见 docs/06-DATA-DESIGN.md §5.4',
    },
    '【ATS-212】': {
        'D6': '项目级环境档案与 runner 环境封口已实现（ATS-212：档案按项目命名空间；'
              '只有白名单内的变量可传递；runner 不继承宿主环境）',
        'D7': '凭据形态的变量被拒绝，独立安全凭据存储未实现（属 FR-027 的另一半）；'
              '详见 docs/04-DETAILED-DESIGN.md §5A',
    },
    '【ATS-501】': {
            'D6': '远程执行面协议已冻结（ADR-015~023，全部 DESIGNED，无实现）',
            'D7': '远程执行面无任何实现（ATS-501 只冻结协议与威胁模型）；'
                  '详见 docs/19-REMOTE-RUNNER-PROTOCOL.md',
        },
        '【ATS-506】': {
            'D6': '部署式控制面 API 边界骨架已实现（ATS-506：独立进程/端点/凭据，'
                  '入站拒绝本地路径与本地 Token）',
            'D7': '控制面无持久化、用户认证仅有接口（OIDC 属 ATS-507）；'
                  '详见 docs/21-CONTROL-PLANE-API.md',
        },
        '【ATS-512】': {
            'D6': '插件契约层已实现（权限清单与 Runner SDK，插件宿主未实现）',
            'D7': '插件宿主与沙箱未实现（ATS-512 只交付契约层）；'
                  '详见 docs/21-PLUGIN-CONTRACT.md',
        },
    }


def _text(value):
    """Return `value` as text, decoding bytes when necessary."""
    if isinstance(value, bytes):
        return value.decode('utf-8')
    return value


def xml_escape(value):
    """Escape a string so it can be the text of an XML element.

    The sheet XML is written by hand, so any value that goes into a
    `<x:v>` element has to be escaped. Without this a note containing
    `<24hex>` or `a & b` is written verbatim: the `<` starts what the
    parser reads as a tag and the workbook is damaged (Excel refuses to
    open it).
    """
    return (str(value)
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;'))


def xml_unescape(value):
    """Reverse `xml_escape`.

    The merge helpers work on plain text (a note is compared against plain
    strings such as '已完成'), so the stored value has to be decoded before
    it is merged and re-encoded on the way out. Decoding on read and
    encoding on write is what keeps the round trip stable: running an
    updater twice must not change the file.
    """
    text = _text(value) or ''
    return (text
            .replace('&lt;', '<')
            .replace('&gt;', '>')
            .replace('&quot;', '"')
            .replace('&apos;', "'")
            .replace('&amp;', '&'))


def format_rate(rate):
    """Render a completion rate the way the workbook's cached values do.

    The baseline 总览 cell holds 15 decimal places (``%.15f``), so the cached
    value keeps the same width whether it was written by hand or derived.
    """
    return '%.15f' % rate


def cell_text(xml, rid, col):
    """Return the text of one cell of one row, or '' when it has no value."""
    m = re.search(r'<x:c r="%s%d"[^>]*>(.*?)</x:c>' % (col, rid), xml, re.S)
    if m is None:
        return ''
    v = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
    return xml_unescape(v.group(1)) if v else ''


def cell_number(xml, rid, col):
    """Return the numeric value of one cell, or 0.0 when it is not a number."""
    raw = cell_text(xml, rid, col)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def set_cell(xml, col, value, *, numeric=False):
    """Set the <x:v> of one cell in one row, keeping its style and any formula."""
    pat = re.compile(r'(<x:c r="%s\d+"[^>]*>)(.*?)(</x:c>)' % col, re.S)
    m = pat.search(xml)
    if m is None:
        raise SystemExit(f'cell {col} not found')
    open_tag, body, close = m.groups()
    f = re.search(r'<x:f>(.*?)</x:f>', body, re.S)
    open_tag = re.sub(r'\st="[^"]*"', '', open_tag)
    open_tag = open_tag[:-1] + (' t="n">' if numeric else ' t="str">')
    new_body = (f.group(0) if f else '') + '<x:v>%s</x:v>' % xml_escape(value)
    return xml[:m.start()] + open_tag + new_body + close + xml[m.end():]


def set_cell_in_row(xml, rid, col, value, *, numeric=False):
    """Set one cell of one specific row without touching other rows."""
    m = re.search(r'<x:row[^>]*r="%d"[^>]*>.*?</x:row>' % rid, xml, re.S)
    if m is None:
        raise SystemExit(f'row {rid} not found')
    row = set_cell(m.group(0), col, value, numeric=numeric)
    return xml[:m.start()] + row + xml[m.end():]


def merge_marked(current, marker, new_text, stale_prefixes=(), stale_fragments=(),
                 drop_unmarked=False, plain=False):
    """Replace this script's text in `current` with `new_text`.

    A cell may hold an unmarked prefix plus one block per marker. The blocks
    are delimited by the markers themselves, not by the '；' separator, so a
    block that contains '；' internally survives the merge intact.

    `stale_prefixes` / `stale_fragments` name superseded notes that must not
    linger in the cell. They are removed from the UNMARKED prefix only -- a
    marked block belongs to another script and is never edited here.

    `drop_unmarked` discards the unmarked prefix entirely. It is used for a
    cell this script owns outright, where the pre-marker text is an earlier
    version of the same note.

    `plain` writes this script's text WITHOUT a marker -- it replaces the
    unmarked prefix. It is used for a cell that is owned outright by one
    script, so that the cell keeps the exact bytes the committed baseline
    has. A foreign marked block in the same cell survives untouched.

    The blocks are re-emitted in CANONICAL order (the MARKERS tuple order),
    not in the order they happened to appear in the cell. That is what makes
    two updaters order-independent: whichever script runs last, the cell
    ends up with the same sequence of blocks.
    """
    current = _text(current) or ''
    positions = []
    for m in MARKERS:
        for mm in re.finditer(re.escape(m), current):
            positions.append((mm.start(), m))
    positions.sort()

    blocks = []            # (owner marker or None, text)
    if not positions:
        blocks.append((None, current))
    else:
        if positions[0][0] > 0:
            blocks.append((None, current[:positions[0][0]]))
        for i, (pos, owner) in enumerate(positions):
            end = positions[i + 1][0] if i + 1 < len(positions) else len(current)
            blocks.append((owner, current[pos:end]))

    out_blocks = []
    own_written = False
    # The caller may hand us text that already starts with its own marker.
    # `merge_marked` writes `marker + new_text`, so leaving the marker in
    # would produce a doubled prefix (e.g. 【ATS-401】【ATS-401】...) and the
    # cell would no longer be idempotent. Strip the caller's own leading
    # markers once here so both spellings are accepted and the result is the
    # same block either way.
    own_text = new_text
    while own_text.startswith(marker):
        own_text = own_text[len(marker):]
    for owner, text in blocks:
        if owner == marker:
            if own_written:
                continue              # a duplicate of this script's block
            out_blocks.append((marker, marker + own_text))
            own_written = True
            continue
        if owner is None:
            if plain:
                # This script owns the unmarked text of this cell.
                if own_written:
                    continue
                out_blocks.append((None, new_text))
                own_written = True
                continue
            if drop_unmarked:
                continue
            # The unmarked prefix may hold superseded notes from an earlier
            # delivery. Drop them segment by segment.
            segs = [s for s in text.split('；')
                    if not any(s.startswith(p) for p in stale_prefixes)
                    and s not in stale_fragments]
            text = '；'.join(segs)
        if text.strip():
            out_blocks.append((owner, text))

    if not own_written:
        if plain:
            out_blocks.insert(0, (None, new_text))
        else:
            out_blocks.append((marker, marker + own_text))

    # Re-emit in canonical order: unmarked prefix first, then one block per
    # marker in the MARKERS order. A block whose marker is unknown (a future
    # task) keeps its relative position at the end rather than being lost.
    prefix = ''.join(t for owner, t in out_blocks if owner is None)
    by_marker = {}
    unknown = []
    for owner, t in out_blocks:
        if owner is None:
            continue
        if owner in MARKERS:
            by_marker[owner] = t
        else:
            unknown.append(t)
    ordered = [prefix] if prefix.strip() else []
    ordered.extend(by_marker[m] for m in MARKERS if m in by_marker)
    ordered.extend(unknown)

    out = ''
    for text in ordered:
        text = text.strip().rstrip('；').strip()
        if not text:
            continue
        if out:
            # Two blocks are joined by '；', but a block that already ends in
            # a full stop must not get a second one after the separator.
            out = out.rstrip('；')
            out += '' if out.endswith('。') else '；'
        out += text
    return out


def compose_narrative(cell, cell_name):
    """Build the 总览 narrative cell from every task's marked fragment.

    The cell is owned by NO single task: each task contributes one marked
    fragment, and the cell is the composition of the unmarked base plus all
    the fragments. Any updater can therefore rewrite the cell without
    erasing another task's contribution, and the result does not depend on
    the order in which the updaters ran.

    `cell_name` is the cell's name ('D6' / 'D7'), not its column letter.
    """
    spec = NARRATIVE[cell_name]
    current = _text(cell) or ''
    # Strip the legacy unmarked fragments: they are the whole-cell
    # predecessors of the marked fragments below.
    prefix = spec['base']
    for stale in spec['stale']:
        prefix = prefix.replace(stale, '')
    prefix = prefix.strip().rstrip('；').strip()

    parts = [prefix] if prefix else []
    for marker in MARKERS:
        fragment = NARRATIVE_FRAGMENTS.get(marker, {}).get(cell_name)
        if not fragment:
            continue
        # A fragment that is already in the cell (from an earlier run) must
        # not be added twice.
        if marker in current and fragment in current:
            parts.append(fragment)
            continue
        parts.append(fragment)
    out = '；'.join(p for p in parts if p)
    if out and not out.endswith('。'):
        out += '。'
    return out


def set_narrative_cell(xml, rid, cell_name):
    """Rewrite one 总览 narrative cell as the composition of all fragments.

    `cell_name` is the cell's name ('D6' / 'D7'); the row is `rid` (6 / 7).
    """
    column = cell_name[0]
    m = re.search(r'<x:c r="%s%d"[^>]*>(.*?)</x:c>' % (column, rid), xml, re.S)
    if m is None:
        raise SystemExit(f'{cell_name} not found')
    cur = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
    merged = compose_narrative(xml_unescape(cur.group(1)) if cur else '', cell_name)
    new_cell = '<x:c r="%s%d" t="str"><x:v>%s</x:v></x:c>' % (column, rid, xml_escape(merged))
    return xml[:m.start()] + new_cell + xml[m.end():]


def set_marked_cell(xml, rid, col, marker, new_text,
                    stale_prefixes=(), stale_fragments=(), drop_unmarked=False,
                    plain=False):
    """Write a marked block into one cell of one row, keeping foreign blocks."""
    m = re.search(r'<x:c r="%s%d"[^>]*>(.*?)</x:c>' % (col, rid), xml, re.S)
    if m is None:
        raise SystemExit(f'{col}{rid} not found')
    cur = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
    merged = merge_marked(xml_unescape(cur.group(1)) if cur else '', marker, new_text,
                          stale_prefixes, stale_fragments, drop_unmarked, plain)
    new_cell = '<x:c r="%s%d" t="str"><x:v>%s</x:v></x:c>' % (col, rid, xml_escape(merged))
    return xml[:m.start()] + new_cell + xml[m.end():]


def inflate_zip_entries(buf):
    """Return the zip members of `buf` as text.

    The workbook is written with the `x:` namespace prefix, which is why the
    member names and the XML tags below carry it. A member that is stored
    rather than deflated is read as-is.

    The archive is parsed by hand because the workbook has to be rewritten
    member by member without disturbing the ones that are not touched.
    """
    parts = {}
    eocd = -1
    for i in range(len(buf) - 22, -1, -1):
        if buf[i:i + 4] == b'PK\x05\x06':
            eocd = i
            break
    if eocd < 0:
        raise SystemExit('not a zip container')
    count = struct.unpack_from('<H', buf, eocd + 10)[0]
    off = struct.unpack_from('<I', buf, eocd + 16)[0]
    for _ in range(count):
        if buf[off:off + 4] != b'PK\x01\x02':
            break
        method = struct.unpack_from('<H', buf, off + 10)[0]
        comp_size = struct.unpack_from('<I', buf, off + 20)[0]
        name_len = struct.unpack_from('<H', buf, off + 28)[0]
        extra_len = struct.unpack_from('<H', buf, off + 30)[0]
        comment_len = struct.unpack_from('<H', buf, off + 32)[0]
        local_off = struct.unpack_from('<I', buf, off + 42)[0]
        name = buf[off + 46:off + 46 + name_len].decode('utf-8')
        # The local header repeats the name and the extra field, and both are
        # 16-bit -- reading the extra length as 32-bit lands past the entry.
        l_name_len = struct.unpack_from('<H', buf, local_off + 26)[0]
        l_extra_len = struct.unpack_from('<H', buf, local_off + 28)[0]
        data_start = local_off + 30 + l_name_len + l_extra_len
        raw = buf[data_start:data_start + comp_size]
        if method == 0:
            text = raw.decode('utf-8')
        else:
            text = zlib.decompress(raw, -zlib.MAX_WBITS).decode('utf-8')
        parts[name] = text
        off += 46 + name_len + extra_len + comment_len
    return parts


def read_parts(path=None):
    """Return {member name: text} for the workbook at `path` (default WBS)."""
    target = Path(path) if path else WBS
    with open(target, 'rb') as fh:
        return {k: _text(v) for k, v in inflate_zip_entries(fh.read()).items()}


def sheet_cells(parts, sheet_name):
    """Map row number -> {column letter: cell text} for one worksheet.

    The stored text is XML-escaped (see `xml_escape`), so it is decoded
    here: a reader sees the same plain text that a writer put in.
    """
    ss_xml = _text(parts.get(SHARED_STRINGS, ''))
    shared = [xml_unescape(re.sub(r'<[^>]+>', '', s))
              for s in re.findall(r'<x:si>(.*?)</x:si>', ss_xml, re.S)]
    xml = _text(parts[sheet_name])
    rows = {}
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        rid = int(rm.group(1))
        cells = {}
        for cm in re.finditer(r'<x:c r="([A-Z]+)\d+"([^>]*)>(.*?)</x:c>', rm.group(2), re.S):
            col, attrs, body = cm.group(1), cm.group(2), cm.group(3)
            vm = re.search(r'<x:v>(.*?)</x:v>', body, re.S)
            val = xml_unescape(vm.group(1)) if vm else ''
            if 't="s"' in attrs and val != '':
                val = shared[int(val)]
            cells[col] = val
        rows[rid] = cells
    return rows


def totals(parts=None):
    """Return the 总览 figures derived from the 开发WBS sheet.

    Returns a dict with `completed` (count of 已完成), `sum_estimate`
    (SUM of K), `sum_remaining` (SUM of P) and `completion_rate`
    (1 - SUM(P)/SUM(K), 0 when there is nothing to divide).
    """
    if parts is None:
        parts = read_parts()
    rows = sheet_cells(parts, SHEET2)
    completed = 0
    sum_estimate = 0.0
    sum_remaining = 0.0
    for rid in range(FIRST_ROW, LAST_ROW + 1):
        cells = rows.get(rid)
        if not cells:
            continue
        if not (cells.get('A') or '').startswith('ATS-'):
            continue
        if cells.get('N') == '已完成':
            completed += 1
        try:
            sum_estimate += float(cells.get('K') or 0)
        except ValueError:
            pass
        try:
            sum_remaining += float(cells.get('P') or 0)
        except ValueError:
            pass
    rate = 0.0 if sum_estimate == 0 else 1 - sum_remaining / sum_estimate
    return {
        'completed': completed,
        'sum_estimate': sum_estimate,
        'sum_remaining': sum_remaining,
        'completion_rate': rate,
    }
