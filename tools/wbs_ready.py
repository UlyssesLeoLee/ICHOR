"""WBS dependency-driven release: compute which child issues may start now.

The 43-wave staging on SEIKOIST-145 is a valid topological order, but the
platform's `--until-children-done --stage N` barrier means "stages 1..N are
all closed", so wave N+1 only opens after every earlier wave is finished.
That serialises the five independent chains (S1/S2/S3/S4/S5) behind each
other even though their WBS 前置依赖 column says they are independent.

This tool derives the release set from the authoritative source -- the
「前置依赖 WBS」 column of `docs/WBS.xlsx` (工作表「开发WBS」) -- combined with
the live status of each child issue:

    a child may start  <=>  every WBS it depends on has reached a terminal
                            Multica status (done / cancelled)

Two independent facts are combined:

  * `docs/WBS.xlsx`  -> the dependency edges (read with the stdlib only, so
    the tool runs on a bare Python without openpyxl);
  * the `multica issue children` JSON dump -> the live status of each child.

Usage:

    multica issue children 01a19f87-9fee-7edd-8282-9bc7641321dd --output json > children.json
    python tools/wbs_ready.py children.json --list
    python tools/wbs_ready.py children.json --promote     # backlog -> todo

`--promote` only touches children that are still in `backlog`; anything
already `todo` / `in_progress` / `in_review` is left alone, so a task can
never be pushed backwards by a second release pass.
"""
import argparse
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WBS_XLSX = ROOT / 'docs' / 'WBS.xlsx'

# Multica status keys that count as "the prerequisite is satisfied".
TERMINAL = {'done', 'cancelled'}


def sheet_xml(xlsx, sheet_index):
    """Return the raw XML of the nth (1-based) worksheet, stdlib only."""
    with zipfile.ZipFile(xlsx) as z:
        return z.read(f'xl/worksheets/sheet{sheet_index}.xml').decode('utf-8')


def shared_strings(xlsx):
    with zipfile.ZipFile(xlsx) as z:
        try:
            xml = z.read('xl/sharedStrings.xml').decode('utf-8')
        except KeyError:
            return []
    return re.findall(r'<x:t[^>]*>(.*?)</x:t>|<t[^>]*>(.*?)</t>', xml, re.S)


def cell_text(v, strings):
    """Resolve a worksheet cell value to a string."""
    if v is None:
        return ''
    if v.startswith('t='):
        # inline string
        m = re.search(r'<x:t[^>]*>(.*?)</x:t>|<t[^>]*>(.*?)</t>', v, re.S)
        return (m.group(1) or m.group(2)) if m else ''
    if v.startswith('s='):
        idx = int(v[2:])
        return strings[idx] if 0 <= idx < len(strings) else ''
    return v


def dependency_map(xlsx):
    """WBS ID -> sorted list of prerequisite WBS IDs, from 开发WBS (sheet 2)."""
    strings = shared_strings(xlsx)
    xml = sheet_xml(xlsx, 2)
    deps = {}
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        row = rm.group(2)
        cells = {}
        for cm in re.finditer(r'<x:c r="([A-Z]+)\d+"[^>]*>(.*?)</x:c>', row, re.S):
            col = cm.group(1)
            vm = re.search(r'<x:v>(.*?)</x:v>', cm.group(2), re.S)
            cells[col] = cell_text(vm.group(1) if vm else None, strings)
        wbs = cells.get('A', '').strip()
        if not wbs:
            continue
        raw = cells.get('H', '').strip()
        prereqs = sorted(set(re.findall(r'ATS-\d+', raw))) if raw and raw != '-' else []
        deps[wbs] = prereqs
    return deps


PARENT_ISSUE = '01a19f87-9fee-7edd-8282-9bc7641321dd'


def fetch_children(issue_id):
    """Read the live children of an issue straight from the CLI."""
    res = subprocess.run(
        ['multica', 'issue', 'children', issue_id, '--output', 'json'],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        raise SystemExit(f'multica issue children {issue_id} failed: {res.stderr.strip()}')
    return res.stdout


def children(children_json):
    """Parse the `multica issue children` JSON dump into task records."""
    data = json.loads(Path(children_json).read_text(encoding='utf-8'))
    out = []
    for stage in data['stages']:
        for issue in stage['issues']:
            desc = issue.get('description') or ''
            m = re.search(r'WBS (ATS-\d+)', desc)
            if not m:
                continue
            out.append({
                'wbs': m.group(1),
                'issue_id': issue['id'],
                'identifier': issue['identifier'],
                'title': issue.get('title', ''),
                'status': issue['status'],
                'stage': stage['stage'],
                'assignee_id': issue.get('assignee_id'),
            })
    return out


def release_set(tasks, deps):
    """Split tasks into (ready, blocked) by the WBS dependency rule."""
    status = {t['wbs']: t['status'] for t in tasks}
    ready, blocked = [], []
    for t in tasks:
        prereqs = deps.get(t['wbs'], [])
        missing = [p for p in prereqs if status.get(p) not in TERMINAL]
        if missing:
            blocked.append((t, missing))
        else:
            ready.append(t)
    return ready, blocked


def promote(tasks, dry_run=False):
    """Move backlog children that are dependency-ready to `todo`."""
    changed = []
    for t in tasks:
        if t['status'] != 'backlog':
            continue
        if dry_run:
            changed.append(t)
            continue
        cmd = ['multica', 'issue', 'status', t['issue_id'], 'todo']
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            print(f"FAIL {t['identifier']} {t['wbs']}: {res.stderr.strip()}", file=sys.stderr)
            continue
        changed.append(t)
        print(f"promoted {t['identifier']} ({t['wbs']}) -> todo")
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('children', nargs='?', default='-',
                     help="JSON dump of `multica issue children`; the default "
                          "'-' fetches the live children of the parent issue")
    ap.add_argument('--list', action='store_true', help='print the release set')
    ap.add_argument('--promote', action='store_true', help='promote backlog -> todo')
    ap.add_argument('--dry-run', action='store_true', help='do not run multica')
    args = ap.parse_args()

    if args.children == '-':
        import tempfile
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False,
                                         encoding='utf-8') as fh:
            fh.write(fetch_children(PARENT_ISSUE))
            args.children = fh.name

    tasks = children(args.children)
    deps = dependency_map(WBS_XLSX)
    ready, blocked = release_set(tasks, deps)

    if args.list:
        print(f'tasks: {len(tasks)}  ready: {len(ready)}  blocked: {len(blocked)}')
        print('-- ready (all prerequisites terminal) --')
        for t in sorted(ready, key=lambda x: (x['stage'], x['wbs'])):
            print(f"  {t['identifier']:<13} {t['wbs']:<8} stage={t['stage']:<3} {t['status']:<12} {t['title'][:48]}")
        print('-- blocked (waiting on) --')
        for t, missing in sorted(blocked, key=lambda x: (x[0]['stage'], x[0]['wbs'])):
            print(f"  {t['identifier']:<13} {t['wbs']:<8} stage={t['stage']:<3} waits for {','.join(missing)}")

    if args.promote:
        backlog_ready = [t for t in ready if t['status'] == 'backlog']
        print(f'promoting {len(backlog_ready)} dependency-ready children from backlog -> todo')
        promote(backlog_ready, dry_run=args.dry_run)


if __name__ == '__main__':
    main()
