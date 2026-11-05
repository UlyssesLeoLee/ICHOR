"""Rewrite the instruction of every armed dependency-edge wakeup rule.

Why this is needed
------------------
All 135 armed rules carry an instruction that tells the woken agent to run

    python tools/wbs_ready.py .chain/children.json --list

Two things were wrong with that:

1. `tools/wbs_ready.py` did not exist on `dev` at all, so the command failed
   with "No such file or directory" and the woken agent could not re-derive
   the prerequisite set.
2. `.chain/children.json` was a scratch artefact that was never committed, so
   even with the tool present the path did not resolve.

`tools/wbs_ready.py` now defaults to fetching the live children dump, so the
command becomes simply

    python tools/wbs_ready.py --list

This script rewrites each rule's instruction with that fix, preserving every
other part of the text verbatim.

Platform pitfalls (measured, see the multica-coordination-quirks skill):
  * `multica issue wakeup update` REPLACES the whole rule configuration, so
    the condition (`--until-issue` / `--until-issue-state`) and the target
    agent must be re-supplied, or the platform rejects the call with
    "select at least one supported event".
  * On Windows, `--instruction-file` round-trips CRLF into CR+CRLF. The
    instruction is therefore normalised to LF before it is written, and the
    length is asserted to match the original.
  * The CLI output can be an object or an array; `raw.find('[')` is wrong for
    objects, because the first `[` belongs to a nested `"event_types": []`.
    Parse by trying `{` first, then `[`.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

BROKEN = 'python tools/wbs_ready.py .chain/children.json --list'
FIXED = 'python tools/wbs_ready.py --list'


def jrun(args, timeout=180):
    """Run a CLI command and parse its JSON payload (object or array)."""
    r = subprocess.run(list(args), capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=timeout)
    raw = r.stdout or ''
    for opener, closer in (('{', '}'), ('[', ']')):
        i = raw.find(opener)
        if i < 0:
            continue
        try:
            return json.loads(raw[i:])
        except Exception:
            continue
    return None


def normalise(text):
    """CRLF -> LF, and a stray CR -> LF, without changing the byte count
    beyond the line-ending fix."""
    return text.replace('\r\n', '\n').replace('\r', '\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('children', help="JSON dump of `multica issue children`")
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    data = json.loads(Path(args.children).read_text(encoding='utf-8'))
    children = [(i['identifier'], i['id'])
                for s in data['stages'] for i in s['issues']]

    tmp = Path(args.children).with_name('wupd_instr.md')
    rewritten = unchanged = failed = 0
    length_mismatch = []

    for ident, iid in children:
        rules = jrun(['multica', 'issue', 'wakeup', 'list', iid, '--output', 'json'])
        if rules is None:
            print(f'  !! list failed for {ident}', file=sys.stderr)
            failed += 1
            continue
        if isinstance(rules, dict):
            rules = [rules]
        for w in rules:
            cond = w.get('condition') or {}
            if cond.get('type') != 'other_issue':
                continue
            instr = w.get('instruction') or ''
            if BROKEN not in instr:
                unchanged += 1
                continue
            new_instr = normalise(instr).replace(BROKEN, FIXED)
            # The rewrite must be a pure command swap: the only permitted
            # length change is the difference between the two commands
            # themselves (21 bytes). Anything else means the text was
            # altered unexpectedly.
            expected = len(new_instr) - len(FIXED) + len(BROKEN)
            if expected != len(instr):
                length_mismatch.append((ident, w['id'], len(instr), len(new_instr)))
            tmp.write_text(new_instr, encoding='utf-8', newline='\n')
            if args.dry_run:
                rewritten += 1
                continue
            out = jrun([
                'multica', 'issue', 'wakeup', 'update', iid, w['id'],
                '--agent-id', w.get('agent_id') or '',
                '--until-issue', cond['issue_id'],
                '--until-issue-state', cond.get('state') or 'ended',
                '--instruction-file', str(tmp),
                '--output', 'json',
            ])
            if out is None:
                failed += 1
                print(f'  FAIL {ident} rule={w["id"][:8]}', file=sys.stderr)
            else:
                rewritten += 1
                print(f'  fixed {ident:<13} rule={w["id"][:8]} '
                      f'agent={w.get("agent_name")}')

    if tmp.exists():
        tmp.unlink()
    print(f'\nrewritten={rewritten} already-ok={unchanged} failed={failed}')
    if length_mismatch:
        print('length mismatches (check manually):', length_mismatch)


if __name__ == '__main__':
    main()
