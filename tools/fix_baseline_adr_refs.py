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

IDEMPOTENCE (ATS-301 review finding C2)
---------------------------------------
Each citation is identified by the TEXT THAT FOLLOWS IT, not by the line
number it currently carries. That makes the mapping stable: running the
script twice in a row produces the same ADR both times, and running it on
an ADR that is already correct changes nothing.

The previous version keyed the mapping by the line number that happened to
be in the ADR on `dev`, which made it a one-shot migration: running it twice
shifted the citations a second time, because the "old" positions it looked
up were the positions it had just written. It also rewrote EVERY citation
that sat in a matching sentence, which silently re-pointed unrelated
citations.

All reads and writes use an explicit UTF-8 encoding, so a Windows console
code page cannot corrupt the Chinese text in the source files.

Usage: python tools/fix_baseline_adr_refs.py
Exit 0 on success, 1 when an anchor cannot be found in the source.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADR = ROOT / 'docs' / '16-BASELINE-ADR.md'

# ---------------------------------------------------------------------------
# Named anchors: a distinctive snippet whose FIRST occurrence is the cited
# position. The key is the citation's identity, not the line number.
#
# The same anchor table is used by tools/check_adr_citations.py, so the two
# tools cannot drift apart: one says WHERE a citation points, the other says
# whether what it points at is still the right code.
# ---------------------------------------------------------------------------
ANCHORS = {
    'server/index.mjs': {
        'PORT': 'const PORT=Number(process.env.ATS_PORT||',
        'CSP': 'Content-Security-Policy',
        'HOST': "if(!new RegExp(`^(localhost|127",
        'CANCEL': 'function cancelRun(run){',
        'RUN_NOT_ACTIVE': "throw new Error('RUN_NOT_ACTIVE')",
        'RESTORE': "if(['queued','running'].includes(run.status))",
        'CONCURRENCY': "['running','queued','cancelling'].includes(x.status)",
        'ERRMAP': "const isAgentError=/^AGENT_/.test(code);",
        'ERRSTATUS': 'const status=/NOT_FOUND/.test(message)?404:',
        'ERRECHO': 'return err(res,status,message);',
    },
    'server/core.mjs': {
        'NOT_A_DIRECTORY': "throw new Error('NOT_A_DIRECTORY')",
        'SAFE_RUN_ARGS': 'export function safeRunArgs(',
    },
}

# ---------------------------------------------------------------------------
# The citation -> anchor mapping.
#
# A citation is identified by (file, the text that FOLLOWS it). The trailing
# text is unique in the ADR for each citation, so the mapping picks exactly
# one occurrence -- the previous version matched whole sentences and
# re-pointed every citation inside a matching sentence.
#
# `range=True` marks a citation that spans a construct (e.g. the whole of
# `cancelRun()`): its END is derived from the construct's extent in the
# CURRENT source, so it never has to be hardcoded here.
# ---------------------------------------------------------------------------
CITATIONS = [
    # (file, trailing text, anchor, is_range)
    ('server/index.mjs', '` | 默认值 `process.env.ATS_PORT', 'PORT', False),
    ('server/index.mjs', '` | CSP `connect-src`', 'CSP', False),
    ('server/index.mjs', '` 的正则含 `${PORT}`', 'HOST', False),
    ('server/index.mjs', '` 把 `AGENT_*` 前缀的错误统一映射', 'ERRMAP', False),
    ('server/index.mjs', '` 的统一错误状态映射**——该处用正则', 'ERRSTATUS', False),
    ('server/index.mjs', '` 随即把 `e.message` 原样回显', 'ERRECHO', False),
    ('server/index.mjs', '` 的统一错误状态映射，见 §3.2', 'ERRSTATUS', False),
    ('server/index.mjs', '`（启动恢复集合遗漏 `cancelling`）', 'RESTORE', False),
    ('server/index.mjs', '`（启动恢复）、`server/index.mjs:', 'RESTORE', False),
    ('server/index.mjs', '`：`if([\'queued\',\'running\'].includes', 'RESTORE', False),
    ('server/index.mjs', '`（`cancelRun`）、`server/index.mjs:', 'CANCEL', True),
    ('server/index.mjs', '`（并发判定）', 'CONCURRENCY', False),
    ('server/index.mjs', '` 的 `cancelRun()` 抛出', 'RUN_NOT_ACTIVE', False),
    ('server/core.mjs', '` 抛出，`RUN_NOT_ACTIVE` 由', 'NOT_A_DIRECTORY', False),
    ('server/core.mjs', '` `safeRunArgs()`', 'SAFE_RUN_ARGS', False),
]


def read_text(path):
    """The file's text, read with an explicit UTF-8 encoding.

    The line terminators are preserved as they are on disk, so writing the
    text back does not change the file's line endings.
    """
    return path.read_bytes().decode('utf-8')


def source_lines(rel):
    """The lines of `rel` as they are in the CURRENT source tree.

    Read from the working tree (not from `HEAD`) so that the script fixes
    the citations for the code that is about to be committed.
    """
    path = ROOT / rel
    if not path.exists():
        return None
    return read_text(path).split(chr(10))


def find_anchors(rel, lines):
    """anchor name -> current line number, for every anchor in `rel`."""
    found = {}
    for key, needle in ANCHORS.get(rel, {}).items():
        for i, line in enumerate(lines, 1):
            if needle in line:
                found[key] = i
                break
    return found


def function_extent(lines, start):
    """The 1-based line where the function starting at `start` ends."""
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


def repoint(text, rel, trailing, replacement):
    """Replace the ONE citation of `rel` that is followed by `trailing`.

    Returns (new_text, n_replacements). If more than one citation matches,
    nothing is changed: an ambiguous match would silently re-point the wrong
    citation.
    """
    pattern = re.compile(re.escape(rel) + r':(\d+(?:-\d+)?)')
    matches = []
    for m in pattern.finditer(text):
        if text[m.end():m.end() + len(trailing)] == trailing:
            matches.append(m)
    if len(matches) != 1:
        return text, 0
    m = matches[0]
    return text[:m.start()] + replacement + text[m.end():], 1


def main():
    text = read_text(ADR)
    before = text

    sources = {}
    anchors = {}
    for rel in ANCHORS:
        lines = source_lines(rel)
        sources[rel] = lines or []
        anchors[rel] = find_anchors(rel, sources[rel])

    missing = []
    for rel, table in ANCHORS.items():
        for key in table:
            if key not in anchors[rel]:
                missing.append('%s: anchor %r not found' % (rel, key))
    if missing:
        print('cannot fix: an anchor is missing from the source')
        for m in missing:
            print('  ', m)
        return 1

    replaced = 0
    unresolved = []
    for rel, trailing, anchor, is_range in CITATIONS:
        new = anchors[rel].get(anchor)
        if not new:
            unresolved.append('%s / %s' % (rel, anchor))
            continue
        if is_range:
            end = function_extent(sources[rel], new)
            if end is None:
                unresolved.append('%s / %s (extent)' % (rel, anchor))
                continue
            replacement = '%s:%d-%d' % (rel, new, end)
        else:
            replacement = '%s:%d' % (rel, new)
        text, n = repoint(text, rel, trailing, replacement)
        if n == 0:
            unresolved.append('%s / %s (no unique citation found)' % (rel, anchor))
        else:
            replaced += n

    if unresolved:
        print('cannot fix: some citations could not be located unambiguously')
        for u in unresolved:
            print('  ', u)
        return 1

    if text != before:
        ADR.write_bytes(text.encode('utf-8'))
    print('citations re-pointed:', replaced)
    print('changed:', text != before)
    for rel, found in anchors.items():
        print(rel, found)
    return 0


if __name__ == '__main__':
    sys.exit(main())
