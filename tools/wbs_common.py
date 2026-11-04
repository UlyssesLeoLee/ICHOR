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
MARKERS = ('【ATS-101】', '【ATS-401】', '【ATS-501】')


def _text(value):
    """Return `value` as text, decoding bytes when necessary."""
    if isinstance(value, bytes):
        return value.decode('utf-8')
    return value


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
    return v.group(1) if v else ''


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
    new_body = (f.group(0) if f else '') + f'<x:v>%s</x:v>' % value
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

    The blocks are re-emitted in document order, so a cell that carries two
    scripts' notes does not have their order flipped by a re-run.
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
    for owner, text in blocks:
        if owner == marker:
            if own_written:
                continue              # a duplicate of this script's block
            out_blocks.append(marker + new_text)
            own_written = True
            continue
        if owner is None:
            if plain:
                # This script owns the unmarked text of this cell.
                if own_written:
                    continue
                out_blocks.append(new_text)
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
            out_blocks.append(text)

    if not own_written:
        if plain:
            out_blocks.insert(0, new_text)
        else:
            out_blocks.append(marker + new_text)

    out = ''
    for text in out_blocks:
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


def set_marked_cell(xml, rid, col, marker, new_text,
                    stale_prefixes=(), stale_fragments=(), drop_unmarked=False,
                    plain=False):
    """Write a marked block into one cell of one row, keeping foreign blocks."""
    m = re.search(r'<x:c r="%s%d"[^>]*>(.*?)</x:c>' % (col, rid), xml, re.S)
    if m is None:
        raise SystemExit(f'{col}{rid} not found')
    cur = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
    merged = merge_marked(cur.group(1) if cur else '', marker, new_text,
                          stale_prefixes, stale_fragments, drop_unmarked, plain)
    new_cell = '<x:c r="%s%d" t="str"><x:v>%s</x:v></x:c>' % (col, rid, merged)
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
    """Map row number -> {column letter: cell text} for one worksheet."""
    ss_xml = _text(parts.get(SHARED_STRINGS, ''))
    shared = [re.sub(r'<[^>]+>', '', s)
              for s in re.findall(r'<x:si>(.*?)</x:si>', ss_xml, re.S)]
    xml = _text(parts[sheet_name])
    rows = {}
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        rid = int(rm.group(1))
        cells = {}
        for cm in re.finditer(r'<x:c r="([A-Z]+)\d+"([^>]*)>(.*?)</x:c>', rm.group(2), re.S):
            col, attrs, body = cm.group(1), cm.group(2), cm.group(3)
            vm = re.search(r'<x:v>(.*?)</x:v>', body, re.S)
            val = vm.group(1) if vm else ''
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
