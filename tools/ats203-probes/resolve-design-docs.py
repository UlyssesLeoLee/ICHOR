#!/usr/bin/env python3
"""Resolve the ATS-203 merge conflicts in the two test design documents.

A merge conflict between two branches that BOTH added rows to the same
table has one right answer: the UNION of the rows. Both sides are sets of
test cases, and a test case that one branch registered and the other did
not is still a test case.

The rows are keyed by their ID (the first column), so a row that appears on
both sides -- in either spelling of the leading pipe -- is one row, not two.
The side that is kept is the one with the tighter formatting (no leading
space before the pipe), and the surviving copy is written in that shape.

The counts in the header line are RECOMPUTED from the merged table, because
both sides changed them and neither side's number is right on its own.
"""
import re
import sys
from pathlib import Path

ROW_RE = re.compile(r'^\|\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*\|')

COUNT_LINE = '> 设计总数：{total}；已执行通过：{passed}；待执行/未实现：{pending}。**PENDING 不是测试通过**。'


def row_id(line):
    m = ROW_RE.match(line)
    return m.group(1) if m else None


def is_pending(line):
    return line.rstrip().endswith('PENDING|')


def merge(path):
    text = path.read_text(encoding='utf-8')
    lines = text.splitlines(keepends=True)
    out = []
    i = 0
    conflicts = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('<<<<<<< '):
            i += 1
            ours = []
            while not lines[i].startswith('======='):
                ours.append(lines[i])
                i += 1
            i += 1
            theirs = []
            while not lines[i].startswith('>>>>>>>'):
                theirs.append(lines[i])
                i += 1
            i += 1
            conflicts += 1
            # The union, keyed by the row id. Ours wins on a tie, because the
            # conflict markers are the side this branch wrote.
            merged = []
            index = {}
            for row in ours + theirs:
                rid = row_id(row)
                if rid is None:
                    # Not a table row (a blank line, a heading): keep both.
                    if row not in merged:
                        merged.append(row)
                    continue
                if rid not in index:
                    index[rid] = len(merged)
                    merged.append(row)
                    continue
                at = index[rid]
                # Prefer the copy without the leading space: the table's own
                # format uses `|ID|` with no space before the pipe.
                if merged[at].startswith('| ') and not row.startswith('| '):
                    merged[at] = row
            out.extend(merged)
            continue
        out.append(line)
        i += 1

    # --- recompute the header counts from the merged table -----------------
    body = ''.join(out)
    rows = [l for l in body.splitlines() if row_id(l) and l.startswith('|')]
    # The table's own separator row (`|---|---|`) is not a case.
    rows = [l for l in rows if not set(l) <= set('|-: ')]
    total = len(rows)
    pending = sum(1 for l in rows if is_pending(l))
    passed = total - pending
    header = COUNT_LINE.format(total=total, passed=passed, pending=pending) + '\n'
    # EVERY count line is replaced by the recomputed one. A conflict can
    # leave two of them (one from each side), and a stale one would
    # contradict the table it sits above.
    seen = 0
    for idx, l in enumerate(out):
        if l.startswith('> 设计总数'):
            out[idx] = header
            seen += 1
    if seen == 0:
        raise SystemExit(f'{path}: the count line was not found')
    # Drop the DUPLICATE count lines that the conflict left behind: only the
    # first one survives.
    kept = False
    deduped = []
    for l in out:
        if l.startswith('> 设计总数'):
            if kept:
                continue
            kept = True
        deduped.append(l)
    path.write_text(''.join(deduped), encoding='utf-8')
    print(f'{path}: {conflicts} conflict(s) resolved, {total} rows '
          f'({passed} passed, {pending} pending)')


def main(argv):
    for arg in argv[1:]:
        merge(Path(arg))


if __name__ == '__main__':
    main(sys.argv)
