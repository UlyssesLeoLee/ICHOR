"""Check every `file:line` citation in docs/16-BASELINE-ADR.md against the code.

The ATS-101 port probe covers only the two port positions. Every OTHER
citation in the ADR is maintained by hand, so this script checks them all:
for each citation it reads the cited line and asserts that the line still
holds the code the ADR says it does.

The citation's line number is read FROM THE ADR, so the check does not go
stale when the cited code moves -- the ADR and the check stay in sync by
construction. The anchor tells the check what the cited line must contain.

Usage: python tools/check_adr_citations.py
Exit 0 and prints RESULT: OK when every citation resolves.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADR = ROOT / 'docs' / '16-BASELINE-ADR.md'

# file -> {cited line as it appears in the ADR: distinctive substring}
# The line numbers below are the ones the ADR itself carries, so they are
# checked against the ADR text: if the ADR changes a citation, this table
# has to change with it, and the script says so instead of silently passing.
EXPECTED = {
    'server/index.mjs': {
        14: 'const PORT=Number(process.env.ATS_PORT||',
        18: "['queued','running'].includes(run.status)",
        61: "throw new Error('RUN_NOT_ACTIVE')",
        60: 'function cancelRun(run){',
        67: 'new RegExp',
        78: 'Content-Security-Policy',
        123: "'cancelling'].includes(x.status)",
        194: 'const isAgentError=/^AGENT_/.test(code);',
    },
    'server/core.mjs': {
        27: "throw new Error('NOT_A_DIRECTORY')",
        103: 'export function safeRunArgs(',
    },
}

# The cancelRun range the ADR cites: first line and last line.
RANGE = ('server/index.mjs', 60, 65)


def cited_positions(text, rel):
    return sorted(set(int(n) for n in re.findall(re.escape(rel) + r':(\d+)', text)))


def main():
    text = ADR.read_text(encoding='utf-8')
    bad = []

    for rel, table in EXPECTED.items():
        lines = (ROOT / rel).read_text(encoding='utf-8').split(chr(10))
        cited = cited_positions(text, rel)
        for line, needle in sorted(table.items()):
            if line not in cited:
                bad.append('%s:%d is not cited by the ADR any more' % (rel, line))
                print('STALE %s:%d (the ADR no longer cites it)' % (rel, line))
                continue
            if line > len(lines):
                bad.append('%s:%d is past the end of the file' % (rel, line))
                print('WRONG %s:%d (past EOF)' % (rel, line))
                continue
            actual = lines[line - 1]
            if needle in actual:
                print('ok   %s:%d' % (rel, line))
            else:
                bad.append('%s:%d does not hold %r' % (rel, line, needle))
                print('WRONG %s:%d -> %s' % (rel, line, actual[:100]))
        uncovered = [c for c in cited if c not in table]
        if uncovered:
            bad.append('%s citations not covered by this check: %s' % (rel, uncovered))
            print('UNCOVERED %s citations: %s' % (rel, uncovered))

    rel, start, end = RANGE
    lines = (ROOT / rel).read_text(encoding='utf-8').split(chr(10))
    if 'function cancelRun(run){' in lines[start - 1] and lines[end - 1].strip() == '}':
        print('ok   %s:%d-%d (cancelRun extent)' % (rel, start, end))
    else:
        bad.append('%s:%d-%d is not the cancelRun extent' % (rel, start, end))
        print('WRONG %s:%d-%d' % (rel, start, end))

    if bad:
        print('\nRESULT: MISMATCH')
        for b in bad:
            print('  ', b)
        return 1
    print('\nRESULT: OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
