"""Audit the armed per-edge wakeup rules against the WBS dependency graph."""
import json
import os
import re
import subprocess
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

WBS = Path(sys.argv[1] if len(sys.argv) > 1 else 'docs/WBS.xlsx')
CHILDREN = sys.argv[2] if len(sys.argv) > 2 else 'children.json'
TERMINAL = {'done', 'cancelled'}


def shared_strings(xlsx):
    with zipfile.ZipFile(xlsx) as z:
        try:
            xml = z.read('xl/sharedStrings.xml').decode('utf-8')
        except KeyError:
            return []
    return [a or b for a, b in re.findall(r'<x:t[^>]*>(.*?)</x:t>|<t[^>]*>(.*?)</t>', xml, re.S)]


def dependency_map(xlsx):
    strings = shared_strings(xlsx)
    with zipfile.ZipFile(xlsx) as z:
        xml = z.read('xl/worksheets/sheet2.xml').decode('utf-8')
    deps = {}
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
        wbs = cells.get('A', '').strip()
        if not wbs:
            continue
        raw = cells.get('H', '').strip()
        deps[wbs] = sorted(set(re.findall(r'ATS-\d+', raw))) if raw and raw != '-' else []
    return deps


def tasks():
    data = json.loads(Path(CHILDREN).read_text(encoding='utf-8'))
    out = {}
    for stage in data['stages']:
        for issue in stage['issues']:
            m = re.search(r'WBS (ATS-\d+)', issue.get('description') or '')
            if not m:
                continue
            out[m.group(1)] = {
                'issue_id': issue['id'], 'identifier': issue['identifier'],
                'status': issue['status'], 'stage': stage['stage'],
            }
    return out


def rules_for(issue_id):
    try:
        r = subprocess.run(['multica', 'issue', 'wakeup', 'list', issue_id, '--output', 'json'],
                           capture_output=True, text=True, timeout=90)
    except Exception:
        return None
    raw = r.stdout
    i = raw.find('[')
    if i < 0:
        return None
    try:
        return json.loads(raw[i:])
    except Exception:
        return None


def main():
    deps = dependency_map(WBS)
    tk = tasks()
    wbs_of_issue = {v['issue_id']: k for k, v in tk.items()}
    items = sorted(tk.items())

    with ThreadPoolExecutor(max_workers=6) as ex:
        got = list(ex.map(lambda kv: (kv[0], rules_for(kv[1]['issue_id'])), items))

    armed = set()      # (dependent, prerequisite) with an enabled rule
    consumed = set()
    rule_count = 0
    for wbs, rules in got:
        if rules is None:
            print(f'  !! wakeup list failed for {wbs} ({tk[wbs]["identifier"]})', file=sys.stderr)
            continue
        for w in rules:
            cond = w.get('condition') or {}
            if cond.get('type') != 'other_issue':
                continue
            pid = cond.get('issue_id')
            p_wbs = wbs_of_issue.get(pid)
            if not p_wbs:
                continue
            rule_count += 1
            if w.get('enabled'):
                armed.add((wbs, p_wbs))
            else:
                consumed.add((wbs, p_wbs))

    expected = set()
    for d, prereqs in deps.items():
        if d not in tk:
            continue
        for p in prereqs:
            if p in tk:
                expected.add((d, p))

    missing = expected - armed - consumed
    print(f'expected edges      : {len(expected)}')
    print(f'rules on other_issue: {rule_count}')
    print(f'armed (enabled)     : {len(armed)}')
    print(f'consumed (fired)    : {len(consumed)}')
    print(f'MISSING             : {len(missing)}')
    for d, p in sorted(missing):
        print(f'   MISSING {tk[d]["identifier"]} ({d}) <- {tk[p]["identifier"]} ({p})')
    extra = (armed | consumed) - expected
    print(f'EXTRA (not in WBS)  : {len(extra)}')
    for d, p in sorted(extra):
        print(f'   EXTRA {tk[d]["identifier"]} ({d}) <- {p}')


if __name__ == '__main__':
    main()
