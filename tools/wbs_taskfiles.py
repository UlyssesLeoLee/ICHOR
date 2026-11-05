"""Derive each child task's declared file list from its issue description.

`tools/wbs_conflict_groups.py` needs, for every task, the set of files it is
allowed to touch. That set is not stored anywhere machine-readable: it lives in
the 「工作位置」 section of each child issue's description, as

    - `server/core.mjs（readSource / writeSource 与 SHA-256 乐观锁）`
    - `tests/api.test.mjs`

This tool parses that section out of the `multica issue children` dump and
writes the normalised list that the conflict-group tool consumes.

Usage:

    multica issue children 01a19f87-9fee-7edd-8282-9bc7641321dd --output json > children.json
    python tools/wbs_taskfiles.py children.json --out taskfiles.json

The paths are normalised the same way `wbs_conflict_groups.norm()` does it:
backticks stripped, backslashes turned into slashes, the trailing
「（说明）」 removed.
"""
import argparse
import json
import re
from pathlib import Path


def norm(path):
    p = path.strip().strip('`').replace('\\', '/')
    p = p.split('（')[0].split('(')[0].strip()
    return p


def declared_files(description):
    """The paths named in the 「工作位置」 section of one child issue."""
    if '### 工作位置' not in description:
        return []
    section = description.split('### 工作位置')[1]
    for marker in ('### 依据文档', '### 完成证据', '### 风险提示'):
        if marker in section:
            section = section.split(marker)[0]

    files = []
    for line in section.splitlines():
        line = line.strip()
        if not line.startswith('-'):
            continue
        for raw in re.findall(r'`([^`]+)`', line):
            p = norm(raw)
            if not p:
                continue
            # Skip prose that is not a path: the section also names the
            # repository, the branch and the local integration branch.
            if p in ('D:/ICHOR',) or not p:
                continue
            if p.startswith('agent/') or p.startswith('dev'):
                continue
            # A path is either a repo-root file (`package.json`) or contains a
            # separator (`server/core.mjs`, `src-tauri/Cargo.toml`).
            if '/' not in p and '.' not in p:
                continue
            files.append(p)
    return sorted(set(files))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('children', help="JSON dump of `multica issue children`")
    ap.add_argument('--out', default='taskfiles.json', help='output path')
    args = ap.parse_args()

    data = json.loads(Path(args.children).read_text(encoding='utf-8'))
    out = []
    for stage in data['stages']:
        for issue in stage['issues']:
            desc = issue.get('description') or ''
            m = re.search(r'##\s*WBS\s*(ATS-\d+)', desc)
            if not m:
                continue
            branch = re.search(r'本任务分支 `([^`]+)`', desc)
            out.append({
                'stage': stage['stage'],
                'identifier': issue['identifier'],
                'id': issue['id'],
                'status': issue['status'],
                'wbs': m.group(1),
                'title': issue.get('title', ''),
                'files': declared_files(desc),
                'kind': 'paths',
                'branch': branch.group(1) if branch else None,
            })

    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1),
                              encoding='utf-8')
    print(f'tasks={len(out)} -> {args.out}')
    with_files = sum(1 for t in out if t['files'])
    print(f'  tasks with a declared file list: {with_files}/{len(out)}')
    hot = {}
    for t in out:
        for f in t['files']:
            hot[f] = hot.get(f, 0) + 1
    print('  most contended paths:')
    for f, n in sorted(hot.items(), key=lambda kv: -kv[1])[:6]:
        print(f'    {n:>3} tasks  {f}')


if __name__ == '__main__':
    main()
