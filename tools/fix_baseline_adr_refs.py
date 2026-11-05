"""Re-point the `file:line` references in docs/16-BASELINE-ADR.md.

The ADR cites source positions (server/index.mjs:NN, server/core.mjs:NN).
Adding lines to those files invalidates every citation, and the ATS-101
port-audit probe only covers the two port positions -- the rest have no
probe and have to be re-derived by hand.

This script re-derives each citation from the CURRENT file content instead
of applying a blind offset: every citation is mapped to a named code anchor
(the line that holds a distinctive piece of code), and the anchor's present
line number becomes the new citation. A citation whose anchor cannot be
found is left untouched, so the script cannot invent a position.

Usage: python tools/fix_baseline_adr_refs.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADR = ROOT / 'docs' / '16-BASELINE-ADR.md'


def current_lines(rel):
    out = subprocess.run(['git', 'cat-file', 'blob', 'HEAD:' + rel],
                         capture_output=True, text=True, cwd=str(ROOT))
    if out.returncode != 0:
        return None
    return out.stdout.split('\n')


# Named anchors: a distinctive snippet whose FIRST occurrence is the cited
# position. The key is the citation's identity, not the line number.
ANCHORS = {
    'server/index.mjs': {
        'PORT': 'const PORT=Number(process.env.ATS_PORT||',
        'CSP': "Content-Security-Policy",
        'HOST': "if(!new RegExp(`^(localhost|127",
        'CANCEL': 'function cancelRun(run){',
        'RUN_NOT_ACTIVE': "throw new Error('RUN_NOT_ACTIVE')",
        'RESTORE': "if(['queued','running'].includes(run.status))",
        'CONCURRENCY': "['running','queued','cancelling'].includes(x.status)",
        'ERRMAP': "const isAgentError=/^AGENT_/.test(code);",
    },
    'server/core.mjs': {
        'NOT_A_DIRECTORY': "throw new Error('NOT_A_DIRECTORY')",
        'SAFE_RUN_ARGS': 'export function safeRunArgs(project,testFile,output) {',
    },
}

# The citation positions as they stand on `dev`, mapped to their anchor.
# The probe covers only the two port positions; the rest are re-derived here.
DEV_INDEX = {
    12: 'PORT',
    16: 'RESTORE',
    55: 'CANCEL',
    56: 'RUN_NOT_ACTIVE',
    61: 'HOST',
    72: 'CSP',
    96: 'CONCURRENCY',
    132: 'ERRMAP',
    141: 'ERRMAP',
}
DEV_CORE = {
    26: 'NOT_A_DIRECTORY',
    82: 'SAFE_RUN_ARGS',
}


def find_anchors(rel):
    lines = current_lines(rel)
    if lines is None:
        return {}
    found = {}
    for key, needle in ANCHORS.get(rel, {}).items():
        for i, line in enumerate(lines, 1):
            if needle in line:
                found[key] = i
                break
    return found


def function_extent(rel, start):
    """Return the 1-based line where the function starting at `start` ends."""
    lines = current_lines(rel)
    if lines is None:
        return None
    depth = 0
    started = False
    for i in range(start, len(lines) + 1):
        line = lines[i - 1]
        depth += line.count('{') - line.count('}')
        if '{' in line:
            started = True
        if started and depth <= 0:
            return i
    return None


def main():
    text = ADR.read_text(encoding='utf-8')
    before = text

    anchors = {rel: find_anchors(rel) for rel in ANCHORS}

    def replace_range(m):
        # A range cites the first line of a function and its LAST line. The end
        # has no anchor of its own, so it is derived from the function's extent
        # in the CURRENT file.
        start_key = DEV_INDEX.get(int(m.group(1)))
        if not start_key:
            return m.group(0)
        a = anchors['server/index.mjs'].get(start_key)
        if not a:
            return m.group(0)
        b = function_extent('server/index.mjs', a)
        if b is None:
            return m.group(0)
        return 'server/index.mjs:%d-%d' % (a, b)

    def replace_index(m):
        key = DEV_INDEX.get(int(m.group(1)))
        if not key:
            return m.group(0)
        new = anchors['server/index.mjs'].get(key)
        if not new:
            return m.group(0)
        return 'server/index.mjs:%d' % new

    def replace_core(m):
        key = DEV_CORE.get(int(m.group(1)))
        if not key:
            return m.group(0)
        new = anchors['server/core.mjs'].get(key)
        if not new:
            return m.group(0)
        return 'server/core.mjs:%d' % new

    text = re.sub(r'server/index\.mjs:(\d+)-(\d+)', replace_range, text)
    text = re.sub(r'server/index\.mjs:(\d+)', replace_index, text)
    text = re.sub(r'server/core\.mjs:(\d+)', replace_core, text)

    ADR.write_text(text, encoding='utf-8', newline='\n')
    print('changed:', text != before)
    for rel, found in anchors.items():
        print(rel, found)


if __name__ == '__main__':
    main()
