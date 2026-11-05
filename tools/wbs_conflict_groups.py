"""The TRUE parallel width: semantic DAG + file-conflict GROUPS.

Two tasks that both write `server/core.mjs` cannot run at the same time, but
they also do not have an ORDER between them -- that would be a false
dependency. The right model is a conflict GROUP (union-find over shared
files): every task in a group runs alone, and groups run in parallel.

Plan:
  1. union-find over shared declared files -> conflict groups
  2. the semantic DAG (WBS 「前置依赖 WBS」) between groups
  3. the wave schedule = levels of that group DAG

The max wave width is the real ceiling on parallelism. It does not depend on
how many agent slots or how high the concurrency limit is.
"""
import json
import re
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
XLSX = str(ROOT / 'docs' / 'WBS.xlsx')
# The per-task declared file list is derived from each child issue's
# 「工作位置」 section; it is produced by this tool from the children dump.
TASKFILES = 'taskfiles.json'


def shared_strings(xlsx):
    with zipfile.ZipFile(xlsx) as z:
        xml = z.read('xl/sharedStrings.xml').decode('utf-8')
    return [a or b for a, b in re.findall(r'<x:t[^>]*>(.*?)</x:t>|<t[^>]*>(.*?)</t>', xml, re.S)]


def sheet_rows(xlsx, index):
    strings = shared_strings(xlsx)
    with zipfile.ZipFile(xlsx) as z:
        xml = z.read(f'xl/worksheets/sheet{index}.xml').decode('utf-8')
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        cells = {}
        for cm in re.finditer(r'<x:c r="([A-Z]+)\d+"[^>]*>(.*?)</x:c>', rm.group(2), re.S):
            vm = re.search(r'<x:v>(.*?)</x:v>', cm.group(2), re.S)
            raw = vm.group(1) if vm else ''
            if raw.startswith('s='):
                cells[cm.group(1)] = strings[int(raw[2:])]
            elif raw.startswith('t='):
                m = re.search(r'<x:t[^>]*>(.*?)</x:t>|<t[^>]*>(.*?)</t>', cm.group(2), re.S)
                cells[cm.group(1)] = (m.group(1) or m.group(2)) if m else ''
            else:
                cells[cm.group(1)] = raw
        yield cells


def norm(p):
    p = p.strip().strip('`').replace('\\', '/')
    p = p.split('（')[0].split('(')[0].strip()
    return re.sub(r'^`|`$', '', p)


def hit(a, b):
    for x in a:
        for y in b:
            if (x == y or (x.endswith('/') and y.startswith(x))
                    or (y.endswith('/') and x.startswith(x))
                    or x + '/' == y or y + '/' == x):
                return (x, y)
    return None


class DSU:
    def __init__(self):
        self.p = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def main():
    tf = json.load(open(TASKFILES, encoding='utf-8'))
    for t in tf:
        t['files'] = [norm(f) for f in t['files'] if f]
    byw = {t['wbs']: t for t in tf}

    deps = {}
    for c in sheet_rows(XLSX, 2):
        w = (c.get('A') or '').strip()
        if not re.match(r'^ATS-\d+$', w):
            continue
        raw = (c.get('H') or '').strip()
        deps[w] = sorted(set(re.findall(r'ATS-\d+', raw))) if raw and raw != '-' else []

    dsu = DSU()
    for w in byw:
        dsu.find(w)
    file_pairs = 0
    ws = list(byw)
    for i, a in enumerate(ws):
        for b in ws[i + 1:]:
            if hit(byw[a]['files'], byw[b]['files']):
                dsu.union(a, b)
                file_pairs += 1

    groups = defaultdict(list)
    for w in byw:
        groups[dsu.find(w)].append(w)
    groups = {k: sorted(v) for k, v in groups.items()}
    gid = {w: k for k, v in groups.items() for w in v}

    print(f'tasks={len(byw)}  file-conflict pairs={file_pairs}  conflict groups={len(groups)}')
    sizes = sorted((len(v) for v in groups.values()), reverse=True)
    print(f'group sizes: {sizes[:15]}{" ..." if len(sizes) > 15 else ""}')
    print(f'  groups of size 1 (fully parallel-able alone): {sizes.count(1)}')
    print(f'  biggest group holds {sizes[0]} tasks -> those run strictly one at a time')

    # group DAG from semantic deps
    gedges = defaultdict(set)
    for d, prereqs in deps.items():
        if d not in byw:
            continue
        for p in prereqs:
            if p in byw and gid[p] != gid[d]:
                gedges[gid[d]].add(gid[p])

    # detect cycles
    level = {}
    state = {}

    def lvl(g):
        if g in level:
            return level[g]
        if state.get(g) == 1:
            raise RuntimeError(f'cycle at group {g}')
        state[g] = 1
        pr = gedges.get(g, set())
        level[g] = 0 if not pr else 1 + max(lvl(p) for p in pr)
        state[g] = 2
        return level[g]

    try:
        for g in groups:
            lvl(g)
        print('\ngroup DAG: acyclic')
    except RuntimeError as e:
        print('\ngroup DAG: CYCLE ->', e)
        print('  (a semantic dependency inside a conflict group: the group order')
        print('   must follow the semantic edge, not run in parallel)')
        # fall back: treat the semantic edge as ordering inside the group
        for d, prereqs in deps.items():
            for p in prereqs:
                if d in byw and p in byw and gid[d] == gid[p]:
                    gedges[gid[d]].add(gid[p])
        level.clear()
        state.clear()
        for g in groups:
            lvl(g)

    byl = defaultdict(list)
    for g, members in groups.items():
        byl[level[g]].append(members)

    print('\n=== WAVE SCHEDULE (conflict groups on the semantic DAG) ===')
    for L in sorted(byl):
        members = byl[L]
        ntask = sum(len(m) for m in members)
        print(f'  W{L:<3} groups={len(members):<3} tasks={ntask:<3}  ' +
              ' | '.join(f"{','.join(byw[w]['identifier'] for w in m)}" for m in
                         sorted(members, key=lambda mm: byw[mm[0]]['stage'])))

    widths = {L: len(byl[L]) for L in byl}
    print(f'\n  MAX GROUP-PARALLEL WIDTH = {max(widths.values())} groups')
    print(f'  MAX TASKS IN ONE WAVE     = {max(sum(len(m) for m in byl[L]) for L in byl)}')
    print(f'  NUMBER OF WAVES           = {len(byl)}')
    print(f'  GROUP DAG DEPTH           = {max(level.values()) + 1}')

    json.dump({'groups': groups, 'group_levels': level,
               'group_edges': {k: sorted(v) for k, v in gedges.items()}},
              open('conflict_groups.json', 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
