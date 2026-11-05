"""Redistribute the armed dependency edges across agents.

All 134 enabled dependency edges point at M3. When a wave of 14 tasks
unlocks at once, they all queue on ONE agent -- no matter how high that
agent's concurrency limit is. The fix is to point each dependent task's
edges at an agent chosen by ROUND-ROBIN over the agents that are actually
healthy, so a wave spreads across them.

The rule text is preserved verbatim: `wakeup update` replaces the whole
configuration, so the existing instruction must be passed back, or the
platform rejects it ("instruction must contain 1-12000 bytes").

An agent is only eligible if its provider is not in a known-quota-failure
state. The eligibility is asserted by the caller, not guessed here.
"""
import json
import subprocess
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

NAMES = {
    "8c6cc4cf-fb99-428f-86fe-d534749e83b1": "M3",
    "3daff3c8-567e-4fa8-95cb-50e0522e6082": "M2",
    "2073eb35-da2e-4600-8706-69c751d2e8a9": "Opus",
    "f6c91b1c-0c13-44cf-a896-58cb4aabe97f": "OpusSeikoist1",
    "eb4ab3d2-174d-4815-a345-771659a234a2": "SonnetSeikoist1",
}
IDS = {v: k for k, v in NAMES.items()}

# Eligible pool: agents whose provider is confirmed working right now.
# (M3/M2 = hermes/MiniMax, quota confirmed reset; Opus = claude, 5h window
#  reset at 15:00 JST. OpusSeikoist1/SonnetSeikoist1 run on an OFFLINE
#  runtime, so they are excluded.)
POOL = ["8c6cc4cf-fb99-428f-86fe-d534749e83b1", "3daff3c8-567e-4fa8-95cb-50e0522e6082",
        "2073eb35-da2e-4600-8706-69c751d2e8a9"]


def jrun(args, timeout=120):
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    raw = r.stdout
    # The payload may be an object or an array. `find('[')` alone is wrong:
    # inside an object JSON the first '[' belongs to a nested field such as
    # "event_types": [], so the slice would start mid-document.
    for opener, closer in (('{', '}'), ('[', ']')):
        i = raw.find(opener)
        if i < 0:
            continue
        try:
            return json.loads(raw[i:]), ''
        except Exception:
            continue
    return None, (r.stderr or raw).strip()[:300]


def main():
    rows = json.load(open('children.json', encoding='utf-8'))
    ids = [(i['identifier'], i['id']) for s in rows['stages'] for i in s['issues']]

    def fetch(item):
        ident, iid = item
        rules, err = jrun(['multica', 'issue', 'wakeup', 'list', iid, '--output', 'json'])
        return ident, iid, (rules or []), err

    with ThreadPoolExecutor(max_workers=3) as ex:
        got = list(ex.map(fetch, ids))

    # group the edges per dependent issue, so one issue's edges stay with
    # ONE agent (an issue's own runs must not race each other)
    per_issue = {}
    for ident, iid, rules, err in got:
        if err:
            print(f'  !! list failed for {ident}: {err}', file=sys.stderr)
            continue
        edges = [w for w in rules if (w.get('condition') or {}).get('type') == 'other_issue']
        if edges:
            per_issue[iid] = edges

    print(f'issues carrying dependency edges: {len(per_issue)}')

    # round-robin the ISSUES across the pool, so the edges of one wave land
    # on different agents
    order = sorted(per_issue.keys())
    assign = {}
    for n, iid in enumerate(order):
        assign[iid] = POOL[n % len(POOL)]

    plan = defaultdict(list)
    for iid, edges in per_issue.items():
        a = assign[iid]
        for w in edges:
            if w.get('agent_id') == a:
                continue
            plan[iid].append((w, a))

    print(f'edges to re-target: {sum(len(v) for v in plan.values())}')
    print('target distribution:',
          {NAMES[a]: sum(1 for v in plan.values() for _, x in v if x == a) for a in POOL})

    applied = failed = 0
    for iid, items in plan.items():
        for w, a in items:
            cond = w.get('condition') or {}
            # `wakeup update` REPLACES the whole configuration, so the
            # condition has to be re-supplied or the platform rejects it
            # with "select at least one supported event".
            cmd = ['multica', 'issue', 'wakeup', 'update', iid, w['id'],
                   '--agent-id', a,
                   '--until-issue', cond['issue_id'],
                   '--until-issue-state', cond.get('state') or 'ended',
                   '--instruction-file', 'instr.txt',
                   '--output', 'json']
            # the instruction must be re-supplied verbatim
            with open('instr.txt', 'w', encoding='utf-8') as fh:
                fh.write(w.get('instruction') or 'x')
            out, err = jrun(cmd)
            if out is None:
                failed += 1
                print(f'  FAIL {iid[:8]} {w["id"]} -> {NAMES[a]}: {err[:160]}', file=sys.stderr)
            else:
                applied += 1
                if out.get('agent_id') != a:
                    failed += 1
                    print(f'  !! agent mismatch {w["id"]}: got {out.get("agent_id")} want {a}',
                          file=sys.stderr)
    print(f'applied={applied} failed={failed}')
    json.dump({k: [[w['id'], a] for w, a in v] for k, v in plan.items()},
              open('retarget_plan.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
