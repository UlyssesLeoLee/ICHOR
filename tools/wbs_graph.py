"""Build the WBS dependency graph for SEIKOIST-145 and arm the chain rules.

The dependency edges come from `docs/WBS.xlsx` (工作表「开发WBS」, column
「前置依赖 WBS」) -- the same source the schedule was built from. The live
status of every task comes from a `multica issue children` JSON dump.

Each edge (dependent D, prerequisite P) gets one wakeup rule armed on D:

    multica issue wakeup create <D> --until-issue <P> --until-issue-state ended \
        --agent-id <agent> --instruction-file <file>

When P reaches a terminal state (done or cancelled) the rule fires, wakes the
agent on D, and the woken run promotes D's other prerequisites / starts D.

Why per-edge rules rather than one `--until-children-done --stage N` rule on
the parent: the parent's stage condition means "stages 1..N are ALL closed",
so wave N+1 opened only after every earlier wave finished. The WBS dependency
column says the five chains (S1/S2/S3/S4/S5) are independent, so that
serialised independent work behind a shared counter. Per-edge rules open a
task as soon as its own prerequisites are done.

Two properties this buys:
  * no issue ever holds more than 6 rules (the widest task, ATS-219, has 6
    prerequisites), so the 32-enabled-wakeup cap is never approached;
  * the rules live on the children, so the chain keeps working after the
    parent issue is closed.
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


def sheet_cells(xlsx, sheet_index, strings):
    """Yield {column_letter: text} for every row of the given worksheet."""
    with zipfile.ZipFile(xlsx) as z:
        xml = z.read(f'xl/worksheets/sheet{sheet_index}.xml').decode('utf-8')
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        cells = {}
        for cm in re.finditer(r'<x:c r="([A-Z]+)\d+"[^>]*>(.*?)</x:c>', rm.group(2), re.S):
            vm = re.search(r'<x:v>(.*?)</x:v>', cm.group(2), re.S)
            raw = vm.group(1) if vm else ''
            if raw.startswith('s='):
                idx = int(raw[2:])
                cells[cm.group(1)] = strings[idx] if 0 <= idx < len(strings) else ''
            elif raw.startswith('t='):
                m = re.search(r'<x:t[^>]*>(.*?)</x:t>|<t[^>]*>(.*?)</t>', cm.group(2), re.S)
                cells[cm.group(1)] = (m.group(1) or m.group(2)) if m else ''
            else:
                cells[cm.group(1)] = raw
        yield cells


def shared_strings(xlsx):
    """The strings of the shared-string table, in index order."""
    with zipfile.ZipFile(xlsx) as z:
        try:
            xml = z.read('xl/sharedStrings.xml').decode('utf-8')
        except KeyError:
            return []
    out = []
    for m in re.finditer(r'<x:si>(.*?)</x:si>', xml, re.S):
        parts = re.findall(r'<x:t[^>]*>(.*?)</x:t>|<t[^>]*>(.*?)</t>', m.group(1), re.S)
        out.append(''.join((a or b) for a, b in parts))
    return out


def dependency_map():
    """WBS ID -> sorted prerequisite WBS IDs, read from 开发WBS (sheet 2)."""
    strings = shared_strings(WBS_XLSX)
    deps = {}
    for cells in sheet_cells(WBS_XLSX, 2, strings):
        wbs = cells.get('A', '').strip()
        if not wbs:
            continue
        raw = cells.get('H', '').strip()
        deps[wbs] = sorted(set(re.findall(r'ATS-\d+', raw))) if raw and raw != '-' else []
    return deps


def load_children(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    out = {}
    for stage in data['stages']:
        for issue in stage['issues']:
            desc = issue.get('description') or ''
            m = re.search(r'WBS (ATS-\d+)', desc)
            if not m:
                continue
            out[m.group(1)] = {
                'wbs': m.group(1),
                'issue_id': issue['id'],
                'identifier': issue['identifier'],
                'title': issue.get('title', ''),
                'status': issue['status'],
                'stage': stage['stage'],
            }
    return out


def existing_rules(issue_id):
    """The rules currently armed on one issue, as {condition_issue_id: rule}."""
    res = subprocess.run(
        ['multica', 'issue', 'wakeup', 'list', issue_id, '--output', 'json'],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        return None, res.stderr.strip()
    raw = res.stdout
    start = raw.find('[')
    if start < 0:
        return {}, ''
    try:
        rules = json.loads(raw[start:])
    except json.JSONDecodeError:
        return {}, 'unparseable wakeup list'
    out = {}
    for rule in rules:
        cond = rule.get('condition') or {}
        if cond.get('type') == 'other_issue' and cond.get('issue_id'):
            out[cond['issue_id']] = rule
    return out, ''


def instruction_text(dependent, prerequisite):
    """The brief handed to the woken agent when a prerequisite ends.

    The woken run must NOT start the task on this single edge alone: the task
    may have other prerequisites that are still open. The brief therefore
    makes the agent re-derive the full prerequisite set and only promote the
    task when EVERY prerequisite has reached a terminal state.
    """
    return f"""SEIKOIST-145 依赖放行检查：前置任务 {prerequisite['identifier']}（{prerequisite['wbs']}）已达终态。

本任务 {dependent['identifier']}（{dependent['wbs']}）的某一个前置依赖
`{prerequisite['wbs']}` 已经结束。这只是**部分**放行信号，不代表本任务可以开工。

1) 重新核对本任务的前置依赖全集。以 `docs/WBS.xlsx` 工作表「开发WBS」的
   「前置依赖 WBS」列为准，或直接运行本仓库的工具：
   `python tools/wbs_ready.py .chain/children.json --list`
   该工具用同一份 WBS 数据算出每个任务还差哪些前置依赖。

2) **只有当本任务的全部前置依赖都已达到终态（done 或 cancelled）时**，
   才把本任务从 `backlog` 提升为 `todo`：
   `multica issue status {dependent['issue_id']} todo`
   如果还有前置依赖未结束，就**不要**提升本任务，等剩余依赖各自触发的
   唤醒再判断；此时只需在本任务下留一条简短记录说明「还差哪些前置依赖」，
   然后结束本次运行。

3) 若判定为可开工，按本任务 issue 描述里的「工作位置」执行：分支
   `agent/m3/{dependent['identifier'].lower()}`，产出完成后合并回 `dev`。

4) 在本任务 issue 下留言说明进度与证据，末行写 `Original executor: M3`；
   完成后 `multica issue assign <本任务id> --to Opus` 并置 `in_review`，**不得自行置 done**。

不要自行标记 done。
"""


def arm(tasks, deps, agent_id, graph_path):
    """Create one wakeup rule per (dependent, prerequisite) edge."""
    tmp = ROOT / '.chain' / 'instr.md'
    tmp.parent.mkdir(exist_ok=True)
    created, skipped, failed = 0, 0, 0

    for wbs, task in sorted(tasks.items()):
        prereqs = deps.get(wbs, [])
        if not prereqs:
            continue
        for prereq in prereqs:
            ptask = tasks.get(prereq)
            if not ptask:
                print(f'SKIP {wbs}: unknown prerequisite {prereq}')
                skipped += 1
                continue
            tmp.write_text(instruction_text(task, ptask), encoding='utf-8')
            cmd = [
                'multica', 'issue', 'wakeup', 'create', task['issue_id'],
                '--until-issue', ptask['issue_id'],
                '--until-issue-state', 'ended',
                '--agent-id', agent_id,
                '--instruction-file', str(tmp),
                '--output', 'json',
            ]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode != 0:
                print(f'FAIL {task["identifier"]} <- {prereq}: {res.stderr.strip()[:200]}')
                failed += 1
                continue
            try:
                rule = json.loads(res.stdout[res.stdout.find('{'):])
                print(f"armed {task['identifier']:<13} <- {prereq:<8} rule={rule.get('id')[:8]} "
                      f"enabled={rule.get('enabled')} condition={rule.get('condition')}")
            except Exception:
                print(f"armed {task['identifier']:<13} <- {prereq:<8} (rule id not parsed)")
            created += 1

    print(f'\nrules created: {created}  skipped: {skipped}  failed: {failed}')
    return created, skipped, failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('children', help='JSON dump of `multica issue children`')
    ap.add_argument('--emit', help='write the dependency graph to this path')
    ap.add_argument('--arm', action='store_true', help='create the per-edge wakeup rules')
    ap.add_argument('--rearm', action='store_true',
                    help='rewrite the instruction of the rules that already exist')
    ap.add_argument('--agent-id', default='8c6cc4cf-fb99-428f-86fe-d534749e83b1')
    ap.add_argument('--graph', help='graph file to append the armed rule ids to')
    args = ap.parse_args()

    tasks = load_children(args.children)
    deps = dependency_map()

    # integrity: every prerequisite must resolve to a task on the board
    unknown = [(w, p) for w, ps in deps.items() if w in tasks for p in ps if p not in tasks]
    if unknown:
        print(f'ERROR: prerequisites not present as children: {unknown}')
        sys.exit(1)

    edges = [{'dependent': w, 'prereq': p,
              'dependent_issue': tasks[w]['issue_id'],
              'prereq_issue': tasks[p]['issue_id']}
             for w in sorted(tasks) for p in deps.get(w, [])]

    if args.emit:
        Path(args.emit).write_text(
            json.dumps({'tasks': tasks, 'dependencies': deps, 'edges': edges},
                       ensure_ascii=False, indent=1), encoding='utf-8')
        print(f'graph: {len(tasks)} tasks, {len(edges)} edges -> {args.emit}')

    if args.arm:
        created, skipped, failed = arm(tasks, deps, args.agent_id, args.graph)
        if failed:
            sys.exit(1)

    if args.rearm:
        # Rewrite the instruction of the rules that already exist. The
        # condition is re-supplied so `wakeup update` (which replaces the
        # whole configuration) keeps waiting on the same prerequisite.
        print(f'\nrewriting the instruction of {len(tasks)} tasks\' rules...')
        rewritten, failed = 0, 0
        tmp = ROOT / '.chain' / 'instr.md'
        tmp.parent.mkdir(exist_ok=True)
        for wbs, task in sorted(tasks.items()):
            for prereq in deps.get(wbs, []):
                ptask = tasks.get(prereq)
                if not ptask:
                    continue
                rules, err = existing_rules(task['issue_id'])
                if rules is None:
                    print(f'  UNREADABLE {task["identifier"]}: {err}')
                    failed += 1
                    continue
                rule = rules.get(ptask['issue_id'])
                if not rule:
                    continue
                tmp.write_text(instruction_text(task, ptask), encoding='utf-8')
                cmd = [
                    'multica', 'issue', 'wakeup', 'update', task['issue_id'], rule['id'],
                    '--until-issue', ptask['issue_id'],
                    '--until-issue-state', 'ended',
                    '--agent-id', args.agent_id,
                    '--instruction-file', str(tmp),
                    '--output', 'json',
                ]
                res = subprocess.run(cmd, capture_output=True, text=True)
                if res.returncode != 0:
                    print(f'  FAIL {task["identifier"]} <- {prereq}: {res.stderr.strip()[:160]}')
                    failed += 1
                    continue
                rewritten += 1
        print(f'instructions rewritten: {rewritten}  failed: {failed}')
        if failed:
            sys.exit(1)


if __name__ == '__main__':
    main()
